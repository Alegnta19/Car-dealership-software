import { createHash } from 'crypto';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { closePool, getPool, withTransaction } from '@dealer/database';
import { logger } from '@dealer/platform';

/**
 * Works from both layouts this file runs in: scripts/migrate.ts under tsx (dev — the
 * repo root is one level up) and dist/scripts/migrate.js in the container image (the
 * root is two levels up; the image ships migrations/ beside dist/, not inside it).
 * Resolved from __dirname, not process.cwd(), so the runner is not sensitive to where
 * it is invoked from.
 */
const MIGRATIONS_DIR =
  process.env.MIGRATIONS_DIR ??
  [join(__dirname, '..', 'migrations'), join(__dirname, '..', '..', 'migrations')].find((dir) =>
    existsSync(dir),
  ) ??
  join(__dirname, '..', 'migrations');

/**
 * FBL-020-R4 §0 — THE LEDGER RECORDS WHAT WAS APPLIED, NOT MERELY THAT SOMETHING WAS.
 *
 * Until this correction `schema_migrations` held a filename and a timestamp, and the
 * runner skipped any filename already present. A migration whose BODY changed after it
 * had been applied was therefore silently skipped forever: the environment reported
 * "057 applied" while carrying a different schema, and nothing anywhere could tell the
 * two apart. That is the decisive ledger defect this file closes.
 *
 * THE CHECKSUM IS CANONICAL-LF, AND THAT IS NOT A DETAIL. This repository is developed
 * on Windows with `core.autocrlf=true`, so EVERY migration file on a developer's disk
 * has CRLF line endings while the same file in CI has LF. A hash of the working bytes
 * would differ between the two for every migration ever written, so the ledger would
 * flag drift on every CI run and be switched off within a day — a control nobody can
 * keep is not a control. The bytes are normalized to LF first, which is the exact
 * inverse of the checkout transformation, and the NORMALIZED TEXT IS ALSO WHAT IS
 * EXECUTED: the recorded digest therefore covers precisely the statements that ran, on
 * every platform, and equals the digest of the file as committed.
 */
const LEDGER_CHECKSUM_ALGORITHM = 'sha256-canonical-lf';

/** The canonical LF text of a migration: what gets hashed AND what gets executed. */
function canonicalSql(raw: Buffer): string {
  return raw.toString('utf8').replace(/\r\n/g, '\n');
}

function canonicalChecksum(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex');
}

interface LedgerRow {
  filename: string;
  checksum_sha256: string | null;
  checksum_algorithm: string | null;
}

/**
 * Applies every unapplied migration in filename order, each inside its own
 * transaction, recording it in `schema_migrations`. Re-running is a no-op.
 */
async function migrate(): Promise<void> {
  const pool = getPool();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  /*
   * The ledger's own shape is evolved HERE rather than by a migration, because a
   * migration cannot describe the table that records migrations — and because 000 and
   * 049–056 are byte-immutable. `IF NOT EXISTS` keeps this idempotent, so an existing
   * ledger gains the columns without its rows being touched.
   *
   * `checksum_sha256` is NULLABLE ON PURPOSE. A row written by the pre-checksum runner
   * records a filename and nothing about the body that ran, and no honest value can be
   * invented for it: hashing the file as it sits on disk today would assert "this is
   * what was applied", which is exactly the claim that cannot be proven — and would
   * launder a changed body into a verified one. NULL therefore means, and is documented
   * to mean, "this migration was applied by a runner that did not record a checksum;
   * its body is UNVERIFIABLE". Every run reports those rows by name so the condition
   * stays visible instead of decaying into an assumed pass.
   */
  await pool.query(`ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum_sha256 TEXT`);
  await pool.query(
    `ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum_algorithm TEXT`,
  );
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'schema_migrations_checksum_shape')
      THEN
        ALTER TABLE schema_migrations ADD CONSTRAINT schema_migrations_checksum_shape
          CHECK (checksum_sha256 IS NULL OR checksum_sha256 ~ '^[0-9a-f]{64}$');
      END IF;
      -- A digest and the algorithm that produced it are ONE fact: a digest whose
      -- algorithm is unknown cannot be recomputed, and an algorithm with no digest
      -- records nothing. Neither half can exist alone.
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'schema_migrations_checksum_paired')
      THEN
        ALTER TABLE schema_migrations ADD CONSTRAINT schema_migrations_checksum_paired
          CHECK ((checksum_sha256 IS NULL) = (checksum_algorithm IS NULL));
      END IF;
    END $$
  `);

  const ledger = (
    await pool.query<LedgerRow>(
      `SELECT filename, checksum_sha256, checksum_algorithm
         FROM schema_migrations ORDER BY filename`,
    )
  ).rows;

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  /*
   * VERIFICATION HAPPENS BEFORE ANYTHING IS APPLIED. A drifted body means the database
   * and the repository disagree about the schema that is in force; applying further
   * migrations on top of that disagreement would build on a foundation nobody can
   * describe. The runner refuses, names the file, prints both digests, and changes
   * nothing — no auto-repair, no silent skip, no "record the new value and carry on".
   */
  const drifted: Array<{ filename: string; recorded: string; computed: string; note?: string }> =
    [];
  const unverifiable: string[] = [];
  const absent: string[] = [];
  for (const row of ledger) {
    const path = join(MIGRATIONS_DIR, row.filename);
    if (!existsSync(path)) {
      // Not evidence of a changed body: MIGRATIONS_DIR is legitimately restricted (the
      // CI upgrade job applies a retained two-file fixture directory, and an operator
      // may pin a partial chain). Reported, never fatal — there is no body to compare.
      absent.push(row.filename);
      continue;
    }
    if (row.checksum_sha256 === null) {
      unverifiable.push(row.filename);
      continue;
    }
    const computed = canonicalChecksum(canonicalSql(readFileSync(path)));
    if (row.checksum_algorithm !== LEDGER_CHECKSUM_ALGORITHM) {
      drifted.push({
        filename: row.filename,
        recorded: row.checksum_sha256,
        computed,
        note:
          `recorded under algorithm ${String(row.checksum_algorithm)}; this runner ` +
          `computes ${LEDGER_CHECKSUM_ALGORITHM} and the two cannot be compared`,
      });
      continue;
    }
    if (computed !== row.checksum_sha256) {
      drifted.push({ filename: row.filename, recorded: row.checksum_sha256, computed });
    }
  }

  if (unverifiable.length > 0) {
    logger.warn(
      { filenames: unverifiable, algorithm: LEDGER_CHECKSUM_ALGORITHM },
      'Migration ledger holds rows with NO recorded checksum: these were applied by a ' +
        'runner that did not record one, so the body that ran cannot be verified. No ' +
        'checksum is invented for them.',
    );
  }
  if (absent.length > 0) {
    logger.warn(
      { filenames: absent, migrationsDir: MIGRATIONS_DIR },
      'Migration ledger names files that are not in this migrations directory: nothing ' +
        'to compare them against.',
    );
  }
  if (drifted.length > 0) {
    // The facts go out as STRUCTURED FIELDS, not inside the Error. `logger` never
    // emits an error's `message` (FBL-010-R1 redaction: arbitrary messages carry
    // connection strings and driver payloads), so a filename and two digests carried
    // only by a thrown message would be invisible in exactly the run that needs them.
    logger.error(
      { drift: drifted, algorithm: LEDGER_CHECKSUM_ALGORITHM, migrationsDir: MIGRATIONS_DIR },
      'Migration ledger integrity check FAILED: a previously applied migration no longer ' +
        'matches its recorded checksum. This database and this repository disagree about ' +
        'the schema in force. NOTHING was applied, nothing was repaired, nothing was skipped.',
    );
    throw new Error(
      'Migration ledger integrity check FAILED — a previously applied migration no ' +
        'longer matches its recorded checksum, so this database and this repository ' +
        'disagree about the schema in force. Nothing was applied:\n  ' +
        drifted
          .map(
            (d) =>
              `${d.filename}: recorded ${d.recorded}, computed ${d.computed}` +
              (d.note === undefined ? '' : ` (${d.note})`),
          )
          .join('\n  '),
    );
  }

  const applied = new Set(ledger.map((r) => r.filename));

  let count = 0;
  for (const filename of files) {
    if (applied.has(filename)) continue;

    const raw = readFileSync(join(MIGRATIONS_DIR, filename));
    // ONE canonical text: hashed, executed, recorded. There is no path on which the
    // digest describes something other than the statements that ran.
    const sql = canonicalSql(raw);
    const checksum = canonicalChecksum(sql);
    try {
      // FBL-020-R3 correction G1: this goes through the shared `withTransaction`
      // rather than checking a client out here. A client checked out directly has no
      // `'error'` listener — pg-pool removes its own for the duration of a checkout —
      // so an asynchronous FATAL (a killed backend, an operator shutdown mid-DDL)
      // would arrive as an unhandled `'error'` event and kill the runner outright
      // instead of failing this migration with a message and a non-zero exit. There
      // must be exactly one hardened checkout path in the codebase, and this is it.
      await withTransaction(async (tx) => {
        // FBL-020-R3 correction D1: the pool gives every connection a bounded
        // `statement_timeout` and `idle_in_transaction_session_timeout` so a request
        // path can never pin one indefinitely. DDL is the one legitimate exception —
        // an index build or a large backfill may take minutes and interrupting it
        // half-way is strictly worse than waiting. `SET LOCAL` scopes the exemption
        // to THIS migration's transaction: it reverts at COMMIT, so the connection
        // returns to the pool bounded again.
        await tx.query('SET LOCAL statement_timeout = 0');
        await tx.query('SET LOCAL idle_in_transaction_session_timeout = 0');
        await tx.query(sql);
        // The ledger row is written in the SAME transaction as the DDL it describes,
        // so a migration that commits without its checksum — or a checksum without
        // its migration — is not a reachable state.
        await tx.query(
          `INSERT INTO schema_migrations (filename, checksum_sha256, checksum_algorithm)
           VALUES ($1, $2, $3)`,
          [filename, checksum, LEDGER_CHECKSUM_ALGORITHM],
        );
      });
      logger.info(
        { filename, checksum, algorithm: LEDGER_CHECKSUM_ALGORITHM },
        'Migration applied',
      );
      count += 1;
    } catch (err) {
      throw new Error(`Migration ${filename} failed: ${(err as Error).message}`);
    }
  }

  logger.info(
    {
      applied: count,
      total: files.length,
      verified: ledger.length - unverifiable.length - absent.length,
    },
    'Migrations up to date',
  );
}

migrate()
  .catch((err) => {
    logger.error({ err }, 'Migration run failed');
    process.exitCode = 1;
  })
  .finally(() => closePool());
