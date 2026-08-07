/**
 * NEGATIVE FIXTURE — "I COULD NOT TELL" IS NOW A FAILURE.
 *
 * The table and the filter arrive as function parameters, so no static reading of
 * this file can say whether this statement touches `role_bindings` or what it
 * filters on there. The pre-H1 guard's answer to that was silence: nothing matched
 * its text patterns, nothing was inspected, and the run exited 0 — which is
 * indistinguishable, in the output, from a tree with no such SQL in it.
 *
 * The hardened guard reports the statement as unresolvable. The only way past it is
 * a declared, reviewed opt-out naming the one code that can excuse this rule, which
 * makes "a role-bindings read might be hiding here" a fact a reviewer sees.
 */
interface FixtureExecutor {
  query(sql: string, params: readonly unknown[]): Promise<{ rows: Array<{ n: number }> }>;
}

export async function countWhateverTheCallerNames(
  executor: FixtureExecutor,
  table: string,
  filter: string,
  userLinkId: string,
): Promise<number> {
  const result = await executor.query(
    `SELECT COUNT(*)::int AS n FROM ${table} WHERE user_link_id = $1 AND ${filter}`,
    [userLinkId],
  );
  return result.rows[0]?.n ?? 0;
}
