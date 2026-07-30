/**
 * @dealer/database — PostgreSQL connection and transaction infrastructure.
 * No dealership business rules live here; schema and migrations stay at the
 * repository root and are owned by their originating orders.
 */
export { Executor, closePool, getPool, query, withTransaction } from './pool';
