/**
 * NEGATIVE FIXTURE — EVASION (k): the statement is assembled by
 * `String.prototype.concat`.
 *
 * The same mechanism as (j) with a different spelling: `A.concat(B, C)` is `A + B
 * + C`, but written as a call. The H1 guard read `+` and template interpolation
 * only, so this was one opaque fragment, no variant looked like SQL, and the run
 * reported `0 statement(s) inspected, OK`.
 *
 * Two shapes: the three-argument call, and a chain of one-argument calls, because
 * a resolver that handled only a flat argument list would leave the chain open.
 * The dropped condition here is the effective window's upper bound — `rb.status`
 * is never mentioned, so a guard looking for a restated `status` would find
 * nothing either.
 */
interface FixtureExecutor {
  query(sql: string, params: readonly unknown[]): Promise<{ rows: Array<{ role: string }> }>;
}

/** Looks like SQL, names no table. */
const A = 'SELECT rb.role FROM ';
/** Names the table, contains no SQL keyword. */
const B = 'role_bindings rb';
/** Carries the drift, contains no SQL keyword and names no table. */
const C = ' WHERE rb.user_link_id = $1 AND rb.effective_to IS NULL';

export async function driftingViaConcatCall(
  executor: FixtureExecutor,
  userLinkId: string,
): Promise<number> {
  const result = await executor.query(A.concat(B, C), [userLinkId]);
  return result.rows.length;
}

export async function driftingViaConcatChain(
  executor: FixtureExecutor,
  userLinkId: string,
): Promise<number> {
  const result = await executor.query(A.concat(B).concat(C), [userLinkId]);
  return result.rows.length;
}
