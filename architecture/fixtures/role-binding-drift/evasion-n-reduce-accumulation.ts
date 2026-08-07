/**
 * NEGATIVE FIXTURE — EVASION (n): the statement is FOLDED out of its fragments.
 *
 * `.reduce` is the assembly of (j) with the concatenation moved into a callback,
 * and a callback is not something this guard executes. It could return anything.
 *
 * The answer is not to give up on the statement: the ELEMENTS are resolvable and
 * ordered, so the guard renders them in sequence — which is what the reducer
 * plainly does with them — and then marks the fold itself unresolvable. The read
 * underneath is the original drift shape and is reported as such; the fold is
 * reported separately, because "these fragments, combined somehow" is not a claim
 * that the combination is safe.
 */
interface FixtureExecutor {
  query(sql: string, params: readonly unknown[]): Promise<{ rows: Array<{ role: string }> }>;
}

/** Looks like SQL, names no table. */
const HEAD = 'SELECT rb.role FROM ';
/** Names the table, contains no SQL keyword. */
const BARE_TABLE = 'role_bindings';
/** Carries the drift, contains no SQL keyword and names no table. */
const TAIL = " rb WHERE rb.user_link_id = $1 AND rb.status = 'active'";

const FRAGMENTS = [HEAD, BARE_TABLE, TAIL];

export async function driftingViaReduce(
  executor: FixtureExecutor,
  userLinkId: string,
): Promise<number> {
  const assembled = FRAGMENTS.reduce((accumulated, fragment) => accumulated + fragment, '');
  const result = await executor.query(assembled, [userLinkId]);
  return result.rows.length;
}
