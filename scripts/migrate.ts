import { createHash } from 'crypto';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { closePool, getPool, withTransaction } from '@dealer/database';
import { logger } from '@dealer/platform';
import { FIXTURE_CHAIN_ENV, decideMode } from './migration-fixture-chains';

/**
 * Works from both layouts this file runs in: scripts/migrate.ts under tsx (dev — the
 * repo root is one level up) and dist/scripts/migrate.js in the container image (the
 * root is two levels up; the image ships migrations/ beside dist/, not inside it).
 * Resolved from __dirname, not process.cwd(), so the runner is not sensitive to where
 * it is invoked from.
 */
const CANONICAL_MIGRATIONS_DIR =
  [join(__dirname, '..', 'migrations'), join(__dirname, '..', '..', 'migrations')].find((dir) =>
    existsSync(dir),
  ) ?? join(__dirname, '..', 'migrations');

const MIGRATIONS_DIR = process.env.MIGRATIONS_DIR ?? CANONICAL_MIGRATIONS_DIR;

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
 * FBL-020-R5 §0.3 — THE LEDGER REFUSES. IT DOES NOT WARN.
 *
 * R4 introduced the checksum and then handled two of the three ways the ledger can be
 * untrustworthy by LOGGING A WARNING AND CARRYING ON:
 *
 *   * an applied row with a NULL checksum — written by the pre-checksum runner, so the
 *     body that ran is unverifiable;
 *   * an applied row naming a file this run cannot find, so there is nothing to compare.
 *
 * A warning in a migration runner is read by nobody. The run went green, further
 * migrations were applied ON TOP of a schema nobody could describe, and the condition
 * became permanent furniture. Only the third case — a body whose digest had changed —
 * actually stopped the run.
 *
 * All three now refuse: non-zero exit, and NOTHING applied. The remedy for each is an
 * operator decision, and the runner's job is to force that decision rather than to make
 * it silently:
 *
 *   * an unverifiable row is resolved by recreating the database from the current chain,
 *     or by an operator who establishes what actually ran and records the digest;
 *   * a missing body is resolved by running from a tree that contains it;
 *   * a changed body is resolved by restoring it, or by accepting the drift deliberately.
 *
 * NO AUTO-REPAIR ON ANY PATH. Writing today's digest into an unverifiable row would
 * convert "we do not know what ran" into "this is what ran" — a fabrication, and the exact
 * mechanism by which a changed body would be laundered into a verified one.
 */
export type LedgerRefusalKind =
  'unverifiable-checksum' | 'unsupported-algorithm' | 'missing-body' | 'checksum-drift';

export interface LedgerRefusal {
  kind: LedgerRefusalKind;
  filename: string;
  detail: string;
}

/**
 * Judges the ledger against the bodies available. Pure, and exported, so the suite proves
 * each refusal directly as well as through a real run.
 *
 * `resolveBody` returns the canonical-LF text of a migration, or `undefined` when no tree
 * in scope holds it. In fixture mode the restricted directory is tried first and
 * `migrations/` second: restricting WHICH migrations get applied must not reduce which
 * ones get VERIFIED, so a body the fixture withholds is still checked against the
 * repository's copy.
 */
export function ledgerRefusals(
  ledger: LedgerRow[],
  resolveBody: (filename: string) => string | undefined,
  algorithm: string = LEDGER_CHECKSUM_ALGORITHM,
): LedgerRefusal[] {
  const refusals: LedgerRefusal[] = [];
  for (const row of ledger) {
    const body = resolveBody(row.filename);
    if (body === undefined) {
      refusals.push({
        kind: 'missing-body',
        filename: row.filename,
        detail:
          'the ledger says this migration was applied, but no migration body of that name is ' +
          'available to this run, so what it did cannot be verified',
      });
      continue;
    }
    if (row.checksum_sha256 === null) {
      refusals.push({
        kind: 'unverifiable-checksum',
        filename: row.filename,
        detail:
          'applied with NO recorded checksum — by a runner that did not record one — so the ' +
          'body that ran is unverifiable. No checksum is invented for it.',
      });
      continue;
    }
    if (row.checksum_algorithm !== algorithm) {
      refusals.push({
        kind: 'unsupported-algorithm',
        filename: row.filename,
        detail:
          `recorded under algorithm ${String(row.checksum_algorithm)}; this runner computes ` +
          `${algorithm} and the two cannot be compared`,
      });
      continue;
    }
    const computed = canonicalChecksum(body);
    if (computed !== row.checksum_sha256)
      refusals.push({
        kind: 'checksum-drift',
        filename: row.filename,
        detail: `recorded ${row.checksum_sha256}, computed ${computed}`,
      });
  }
  return refusals;
}

/**
 * Applies every unapplied migration in filename order, each inside its own
 * transaction, recording it in `schema_migrations`. Re-running is a no-op.
 */
async function migrate(): Promise<void> {
  /*
   * §0.4 — THE MODE IS DECIDED BEFORE A CONNECTION IS OPENED. A refused fixture must not
   * have created the ledger table, evolved its shape or touched a row: the point of the
   * refusal is that this directory never reaches this database.
   */
  const mode = decideMode(MIGRATIONS_DIR, CANONICAL_MIGRATIONS_DIR, process.env[FIXTURE_CHAIN_ENV]);
  if (mode.problems.length > 0) {
    logger.error(
      {
        migrationsDir: MIGRATIONS_DIR,
        canonicalMigrationsDir: CANONICAL_MIGRATIONS_DIR,
        chain: mode.chain ?? null,
        problems: mode.problems,
      },
      'Migration fixture-chain check FAILED: this migrations directory is not admitted. ' +
        'No connection was opened and nothing was applied.',
    );
    throw new Error(
      'Migration fixture-chain check FAILED — this migrations directory is not admitted:\n  ' +
        mode.problems.join('\n  '),
    );
  }
  logger.info(
    {
      mode: mode.mode,
      chain: mode.chain ?? null,
      migrationsDir: MIGRATIONS_DIR,
    },
    'Migration runner mode',
  );

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
   * `checksum_sha256` STAYS NULLABLE, and that is not a loophole. A row written by the
   * pre-checksum runner records a filename and nothing about the body that ran, and no
   * honest value can be invented for it: hashing the file as it sits on disk today would
   * assert "this is what was applied", which is exactly the claim that cannot be proven —
   * and would launder a changed body into a verified one. NULL therefore means, and is
   * documented to mean, "applied by a runner that did not record a checksum; its body is
   * UNVERIFIABLE".
   *
   * FBL-020-R5 §0.3: such a row now REFUSES the run rather than producing a warning. The
   * column remains nullable because the state has to be REPRESENTABLE to be reported —
   * a NOT NULL column would make the runner's first act against a legacy database an
   * error from the ALTER itself, naming nothing, and an operator would learn less. The
   * state is representable and it is fatal.
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
   * VERIFICATION HAPPENS BEFORE ANYTHING IS APPLIED, AND EVERY FAILURE IS A REFUSAL.
   *
   * An untrustworthy ledger means the database and the repository disagree about the
   * schema in force — or cannot even be compared. Applying further migrations on top of
   * that disagreement builds on a foundation nobody can describe, so the runner names
   * every offending file, states which of the four conditions it hit, and changes
   * nothing: no auto-repair, no silent skip, no "record the new value and carry on".
   *
   * THE BODY IS RESOLVED FROM THE RESTRICTED DIRECTORY FIRST, THEN FROM `migrations/`.
   * A fixture chain restricts which migrations are APPLIED; it must not restrict which
   * are VERIFIED. Before this correction a row whose body the restricted directory did
   * not carry was skipped with a warning, which is precisely how an unverifiable
   * environment stayed unverifiable across every run.
   */
  const resolveBody = (filename: string): string | undefined => {
    for (const dir of [MIGRATIONS_DIR, CANONICAL_MIGRATIONS_DIR]) {
      const path = join(dir, filename);
      if (existsSync(path)) return canonicalSql(readFileSync(path));
    }
    return undefined;
  };

  const refusals = ledgerRefusals(ledger, resolveBody);
  if (refusals.length > 0) {
    // The facts go out as STRUCTURED FIELDS, not inside the Error. `logger` never
    // emits an error's `message` (FBL-010-R1 redaction: arbitrary messages carry
    // connection strings and driver payloads), so a filename and two digests carried
    // only by a thrown message would be invisible in exactly the run that needs them.
    logger.error(
      {
        refusals,
        algorithm: LEDGER_CHECKSUM_ALGORITHM,
        migrationsDir: MIGRATIONS_DIR,
        canonicalMigrationsDir: CANONICAL_MIGRATIONS_DIR,
        mode: mode.mode,
        chain: mode.chain ?? null,
      },
      'Migration ledger integrity check FAILED: the ledger cannot be trusted to describe ' +
        'the schema in force. NOTHING was applied, nothing was repaired, nothing was skipped.',
    );
    throw new Error(
      'Migration ledger integrity check FAILED — the ledger cannot be trusted to describe ' +
        'the schema in force, so nothing was applied:\n  ' +
        refusals.map((r) => `${r.filename} [${r.kind}]: ${r.detail}`).join('\n  '),
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
      // The refusal text IS the operator's instruction (FBL-020-R7 §4: every
      // migration refusal carries an actionable, truthful explanation), so it is
      // printed in full here: the terminal handler's structured log deliberately
      // redacts error messages to a stack fingerprint — right for credential
      // safety, wrong for a message written to be read and acted on.
      console.error(`Migration ${filename} FAILED:
${(err as Error).message}`);
      throw new Error(`Migration ${filename} failed: ${(err as Error).message}`);
    }
  }

  // `verified` is now simply the ledger's size: reaching this line means every row was
  // verified, because any row that was not would have refused the run above. The R4 form
  // subtracted the rows it had merely warned about, which is the arithmetic of a control
  // that lets things through.
  logger.info(
    { applied: count, total: files.length, verified: ledger.length, mode: mode.mode },
    'Migrations up to date',
  );
}

/*
 * IMPORTING THIS FILE MUST NOT MIGRATE ANYTHING. `ledgerRefusals` above is imported by
 * `tests/migration-ledger.test.ts` so each refusal can be driven directly as well as
 * through a real run — and without this guard that import RAN the migration and then closed
 * the shared pool underneath the rest of the battery. A module whose side effect is
 * "migrate the database" cannot be imported by anything, which would have left the pure
 * refusal logic testable only through a subprocess.
 */
if (require.main === module) {
  migrate()
    .catch((err) => {
      logger.error({ err }, 'Migration run failed');
      process.exitCode = 1;
    })
    .finally(() => closePool());
}
