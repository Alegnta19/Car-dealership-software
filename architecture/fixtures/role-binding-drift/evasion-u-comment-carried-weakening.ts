/**
 * NEGATIVE FIXTURE — THE WEAKENING CARRIED PAST RULE 3 BY A SQL COMMENT.
 *
 * Rule 3 reads what is ADJACENT to the resolved predicate: an `OR` that starts
 * the text after it, or ends the text before it. A SQL comment is text, so
 * anything written between the predicate and the `OR` moved the `OR` out of
 * adjacency and the disjunction went unreported — `-- …` to the end of the line
 * for one spelling, `/* … *\/` for the other.
 *
 * Comments are now stripped before any rule judges the statement, which is the
 * only defensible reading anyway: nothing inside a comment executes, so nothing
 * inside one is a conjunction, a restatement or a read.
 *
 * Both statements are `evasion-c`'s disjunctions with a comment inserted at the
 * one position that used to hide them.
 */
import { EFFECTIVE_ROLE_BINDING_SQL } from '@dealer/identity-access';

interface FixtureExecutor {
  query(sql: string, params: readonly unknown[]): Promise<{ rows: Array<{ role: string }> }>;
}

/** A line comment between the predicate and the OR. */
export async function orBehindALineComment(
  executor: FixtureExecutor,
  userLinkId: string,
): Promise<number> {
  const result = await executor.query(
    `SELECT rb.role FROM role_bindings rb
      WHERE rb.user_link_id = $1
        AND (${EFFECTIVE_ROLE_BINDING_SQL} -- historical rows stay visible here
             OR TRUE)`,
    [userLinkId],
  );
  return result.rows.length;
}

/** A block comment doing the same job on one line. */
export async function orBehindABlockComment(
  executor: FixtureExecutor,
  userLinkId: string,
): Promise<number> {
  const result = await executor.query(
    `SELECT rb.role FROM role_bindings rb
      WHERE rb.user_link_id = $1
        AND (${EFFECTIVE_ROLE_BINDING_SQL} /* widened for the migration */ OR rb.granted_at IS NOT NULL)`,
    [userLinkId],
  );
  return result.rows.length;
}
