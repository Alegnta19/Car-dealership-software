/**
 * POSITIVE FIXTURE — FALSE POSITIVE (2): the predicate ALIASED at the import.
 *
 * `${EFFECTIVE}` is the shared predicate, renamed once at the import. The pre-H1
 * guard counted the substring `${EFFECTIVE_ROLE_BINDING_SQL}` and found none, so
 * correct code was reported as an unguarded read and the run exited 1 — teaching
 * the author that the way to satisfy the guard is to spell things its way rather
 * than to use the one predicate.
 */
import { EFFECTIVE_ROLE_BINDING_SQL as EFFECTIVE } from '@dealer/identity-access';

interface FixtureExecutor {
  query(sql: string, params: readonly unknown[]): Promise<{ rows: Array<{ role: string }> }>;
}

export async function rolesWithinTenant(
  executor: FixtureExecutor,
  userLinkId: string,
  tenantId: string,
): Promise<number> {
  const result = await executor.query(
    `SELECT rb.role
       FROM role_bindings rb
       JOIN user_links ul ON ul.user_link_id = rb.user_link_id
      WHERE rb.user_link_id = $1
        AND rb.tenant_id = $2
        AND ${EFFECTIVE}
        AND ul.status = 'activated'
      ORDER BY rb.role`,
    [userLinkId, tenantId],
  );
  return result.rows.length;
}
