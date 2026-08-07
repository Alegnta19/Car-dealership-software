/**
 * NEGATIVE FIXTURE — THE PREDICATE MOVED INTO THE SELECT LIST.
 *
 * A predicate in a projection is a returned COLUMN: it is computed for every row
 * and filters none of them. This one statement therefore defeated two rules at
 * once. Rule 1 counted a resolved use and saw one read guarded; rule 3 found no
 * `OR` and no `NOT` beside the mark, because there is neither. The statement
 * returns every binding the row holds — revoked, expired and not yet started —
 * with a column helpfully saying which is which, and the caller that reads the
 * column is not the gate.
 *
 * A use inside a SELECT list is now counted as no use at all (so rule 1 reports
 * the read it was pretending to guard) AND named under rule 3, which is why this
 * file raises both.
 */
import { EFFECTIVE_ROLE_BINDING_SQL } from '@dealer/identity-access';

interface FixtureExecutor {
  query(
    sql: string,
    params: readonly unknown[],
  ): Promise<{ rows: Array<{ role: string; is_effective: boolean }> }>;
}

export async function effectivenessAsAColumn(
  executor: FixtureExecutor,
  userLinkId: string,
): Promise<readonly { role: string; is_effective: boolean }[]> {
  const result = await executor.query(
    `SELECT rb.role, ${EFFECTIVE_ROLE_BINDING_SQL} AS is_effective
       FROM role_bindings rb
      WHERE rb.user_link_id = $1
      ORDER BY rb.role`,
    [userLinkId],
  );
  return result.rows;
}
