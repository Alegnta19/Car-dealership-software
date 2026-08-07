/**
 * POSITIVE FIXTURE — FALSE POSITIVE (1): the predicate reached through a NAMESPACE
 * import.
 *
 * `${policy.EFFECTIVE_ROLE_BINDING_SQL}` is the shared predicate. The pre-H1 guard
 * counted the substring `${EFFECTIVE_ROLE_BINDING_SQL}`, which this is not, so it
 * reported `role-binding-read-must-use-shared-predicate` on correct code and exited
 * 1 — pushing the author towards the one spelling the guard recognised, or away
 * from the guard entirely.
 */
import * as policy from '@dealer/identity-access';

interface FixtureExecutor {
  query(sql: string, params: readonly unknown[]): Promise<{ rows: Array<{ role: string }> }>;
}

export async function rolesForUserLink(
  executor: FixtureExecutor,
  userLinkId: string,
): Promise<string[]> {
  const result = await executor.query(
    `SELECT DISTINCT rb.role FROM role_bindings rb
      WHERE rb.user_link_id = $1
        AND ${policy.EFFECTIVE_ROLE_BINDING_SQL}
      ORDER BY rb.role`,
    [userLinkId],
  );
  return result.rows.map((r) => r.role);
}
