import { withTransaction, type Executor } from './pool';

/**
 * RELEASE TRAIN 1 — THE SERVER-CONTROLLED TENANT CONTEXT.
 *
 * Migration 061 puts the administration domain under deny-by-default row
 * security keyed on `app_tenant_ctx()`, a reader over the transaction-scoped
 * GUC `app.tenant_id`. This module is the ONE place server code sets it:
 *
 *   * TRANSACTION-scoped (`set_config(..., true)`), so the context can never
 *     leak across pooled connections — it dies with the transaction;
 *   * set from AUTHENTICATED, server-derived state only: callers pass the
 *     tenant the request was authenticated (and, where applicable, authorized)
 *     for. No client-supplied value reaches this function — routes derive the
 *     tenant from `req.identity`/the policy decision, never from a header a
 *     caller could choose;
 *   * deny by default: a transaction that never called this sees NO rows in
 *     any row-secured table under the runtime login, and can write none.
 *
 * The migration owner and the test harness bypass row security by identity
 * (no FORCE), so fixtures stay owner work; the RUNTIME login — what production
 * connects as — is what the policies bind.
 */
export async function setTenantContext(executor: Executor, tenantId: string): Promise<void> {
  await executor.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
}

/**
 * One transaction with the tenant context set before any work runs — the shape
 * every administration read and write uses, and the shape the organization
 * resolver and the evidence writer use so the row-secured organization tables
 * stay readable exactly one tenant at a time.
 */
export async function withTenantTransaction<T>(
  tenantId: string,
  fn: (tx: Executor) => Promise<T>,
): Promise<T> {
  return withTransaction(async (tx) => {
    await setTenantContext(tx, tenantId);
    return fn(tx);
  });
}
