import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { closePool, getPool } from '@dealer/database';
import { logger } from '@dealer/platform';

/**
 * Works from both layouts this file runs in: scripts/migrate.ts under tsx (dev — the
 * repo root is one level up) and dist/scripts/migrate.js in the container image (the
 * root is two levels up; the image ships migrations/ beside dist/, not inside it).
 * Resolved from __dirname, not process.cwd(), so the runner is not sensitive to where
 * it is invoked from.
 */
const MIGRATIONS_DIR = process.env.MIGRATIONS_DIR
  ?? ([join(__dirname, '..', 'migrations'), join(__dirname, '..', '..', 'migrations')]
    .find((dir) => existsSync(dir)) ?? join(__dirname, '..', 'migrations'));

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
    (await pool.query<{ filename: string }>('SELECT filename FROM schema_migrations')).rows.map((r) => r.filename),
  );

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  let count = 0;
  for (const filename of files) {
    if (applied.has(filename)) continue;

    const sql = readFileSync(join(MIGRATIONS_DIR, filename), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [filename]);
      await client.query('COMMIT');
      logger.info({ filename }, 'Migration applied');
      count += 1;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw new Error(`Migration ${filename} failed: ${(err as Error).message}`);
    } finally {
      client.release();
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
