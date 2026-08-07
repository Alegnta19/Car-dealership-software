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

  const applied = new Set(
    (await pool.query<{ filename: string }>('SELECT filename FROM schema_migrations')).rows.map(
      (r) => r.filename,
    ),
  );

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  let count = 0;
  for (const filename of files) {
    if (applied.has(filename)) continue;

    const sql = readFileSync(join(MIGRATIONS_DIR, filename), 'utf8');
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
        await tx.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [filename]);
      });
      logger.info({ filename }, 'Migration applied');
      count += 1;
    } catch (err) {
      throw new Error(`Migration ${filename} failed: ${(err as Error).message}`);
    }
  }

  logger.info({ applied: count, total: files.length }, 'Migrations up to date');
}

migrate()
  .catch((err) => {
    logger.error({ err }, 'Migration run failed');
    process.exitCode = 1;
  })
  .finally(() => closePool());
