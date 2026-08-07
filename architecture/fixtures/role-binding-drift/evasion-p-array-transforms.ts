/**
 * NEGATIVE FIXTURE — EVASION (p): the fragment list is TRANSFORMED before it is
 * joined.
 *
 * Once `.join` is resolved, the next move is to hand it an array that is not
 * written down as an array: a slice of one, a map over one, a flattened one, the
 * values of an object. Each of those is one more call between the fragments and
 * the statement, and each of them defeated a resolver that only understood array
 * literals.
 *
 * The guard resolves the ELEMENTS through all four, because they are the same
 * elements in the same order. Two of the four — `.slice` with literal bounds, and
 * `Object.values` of an object literal — are exact, and are reported for what the
 * statement says. The other two rearrange or rewrite the elements in a callback
 * the guard does not execute, so they are reported for what the statement says
 * AND marked unresolvable on top of it: "these fragments, combined somehow" is
 * not a claim that the combination is safe.
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

const PARTS = [HEAD, BARE_TABLE, TAIL, ' LIMIT 50'];
const NAMED_PARTS = { head: HEAD, table: BARE_TABLE, tail: TAIL };

export async function driftingViaSlicedArray(
  executor: FixtureExecutor,
  userLinkId: string,
): Promise<number> {
  const result = await executor.query(PARTS.slice(0, 3).join(''), [userLinkId]);
  return result.rows.length;
}

export async function driftingViaMappedArray(
  executor: FixtureExecutor,
  userLinkId: string,
): Promise<number> {
  const result = await executor.query(PARTS.map((part) => part).join(''), [userLinkId]);
  return result.rows.length;
}

export async function driftingViaFlattenedArray(
  executor: FixtureExecutor,
  userLinkId: string,
): Promise<number> {
  const result = await executor.query(PARTS.flat().join(''), [userLinkId]);
  return result.rows.length;
}

export async function driftingViaObjectValues(
  executor: FixtureExecutor,
  userLinkId: string,
): Promise<number> {
  const result = await executor.query(Object.values(NAMED_PARTS).join(''), [userLinkId]);
  return result.rows.length;
}

export async function driftingViaConcatenatedArrays(
  executor: FixtureExecutor,
  userLinkId: string,
): Promise<number> {
  const result = await executor.query([HEAD].concat([BARE_TABLE, TAIL]).join(''), [userLinkId]);
  return result.rows.length;
}
