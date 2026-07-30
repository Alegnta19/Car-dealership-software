import { Pool, PoolClient, QueryResult } from 'pg';
import { logger } from '@dealer/platform';

/**
 * Anything that can run a statement: the shared pool, or a client bound to an open
 * transaction. Service functions accept an `Executor` so the same helper works both
 * inside and outside a transaction.
 */
export interface Executor {
  query(sql: string, params?: unknown[]): Promise<QueryResult<any>>;
}

let pool: Pool | null = null;

export function getPool(): Pool {
  if (pool) return pool;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set');

  pool = new Pool({
    connectionString,
    max: Number(process.env.PGPOOL_MAX ?? 10),
    idleTimeoutMillis: Number(process.env.PGPOOL_IDLE_MS ?? 30_000),
    connectionTimeoutMillis: Number(process.env.PGPOOL_CONNECT_MS ?? 5_000),
    ...(process.env.PGSSL === 'require' ? { ssl: { rejectUnauthorized: false } } : {}),
  });

  pool.on('error', (err) => logger.error({ err }, 'Idle Postgres client error'));
  return pool;
}

/** Runs a single statement on the shared pool (implicit one-statement transaction). */
export async function query(sql: string, params?: unknown[]): Promise<QueryResult<any>> {
  return getPool().query(sql, params);
}

/**
 * Runs `fn` inside a single BEGIN/COMMIT on one dedicated client, rolling back on any
 * throw. Every multi-statement business operation goes through this — without it a
 * mid-sequence failure leaves half-written aggregates behind (e.g. a repair order with
 * no queue entry, or approved line items with no authorization row).
 *
 * Note: a statement that errors aborts the whole Postgres transaction, so nothing
 * inside `fn` may swallow a query error and continue. Best-effort work that is allowed
 * to fail independently (platform audit rows, metrics) is done after the commit.
 */
export async function withTransaction<T>(fn: (tx: Executor) => Promise<T>): Promise<T> {
  const client: PoolClient = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      logger.error({ err: rollbackErr }, 'ROLLBACK failed');
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  if (!pool) return;
  await pool.end();
  pool = null;
}
