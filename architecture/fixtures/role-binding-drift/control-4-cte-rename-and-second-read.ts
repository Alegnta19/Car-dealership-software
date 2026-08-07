/**
 * CONTROL — the drift renamed by a CTE, and the drift left in a SECOND read.
 *
 * Both caught before H1 and both must stay caught.
 *
 * The CTE shape hides the table behind a new name and drops the alias, so the
 * restated column is bare `status`; the guard must still see it as the
 * role-bindings table's own column.
 *
 * The partial shape resolves the shared predicate for ONE of two reads. "The
 * predicate appears in this statement" is not compliance — the subquery is an
 * unguarded read of the same table, which is why the uses are COUNTED against the
 * reads.
 */
import { EFFECTIVE_ROLE_BINDING_SQL } from '@dealer/identity-access';

interface FixtureExecutor {
  query(sql: string, params: readonly unknown[]): Promise<{ rows: Array<{ role: string }> }>;
}

export async function driftInsideCte(
  executor: FixtureExecutor,
  userLinkId: string,
): Promise<number> {
  const result = await executor.query(
    `WITH bindings AS (
       SELECT DISTINCT role, scope_level FROM role_bindings
        WHERE user_link_id = $1 AND status = 'active'
     )
     SELECT role FROM bindings`,
    [userLinkId],
  );
  return result.rows.length;
}

export async function guardedOnceReadTwice(
  executor: FixtureExecutor,
  userLinkId: string,
): Promise<number> {
  const result = await executor.query(
    `SELECT rb.role
       FROM role_bindings rb
      WHERE rb.user_link_id = $1
        AND ${EFFECTIVE_ROLE_BINDING_SQL}
        AND rb.scope_id IN (SELECT other.scope_id FROM role_bindings other
                             WHERE other.user_link_id = $1)`,
    [userLinkId],
  );
  return result.rows.length;
}
