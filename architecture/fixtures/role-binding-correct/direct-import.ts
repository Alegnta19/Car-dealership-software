/**
 * POSITIVE FIXTURE — the plain shape: a named import of the shared predicate,
 * interpolated once per read and conjoined.
 *
 * Accepted before H1 and after it. This is the baseline the other two spellings are
 * compared against.
 */
import { EFFECTIVE_ROLE_BINDING_SQL } from '@dealer/identity-access';

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
        AND ${EFFECTIVE_ROLE_BINDING_SQL}
      ORDER BY rb.role`,
    [userLinkId],
  );
  return result.rows.map((r) => r.role);
}
