/**
 * NEGATIVE FIXTURE — EVASION (q): the fragments are taken OUT of the array one at
 * a time.
 *
 * No `.join` here at all: the pieces are read back by index and concatenated with
 * `+`, which the guard has understood since H1. What it did not understand was
 * the index — `sites` answered `PARTS[0]` through the object-literal path, an
 * array is not an object literal, and so every fragment resolved to nothing. The
 * statement rendered as three opaque pieces, looked like no SQL at all, and the
 * run reported `0 statement(s) inspected, OK`.
 *
 * An array index is now resolved to that element, and an index the guard cannot
 * resolve is over-approximated to EVERY element — the same answer an unresolvable
 * object key already got, so a fragment chosen at run time is judged in each of
 * the shapes it could take.
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

const PARTS = [HEAD, BARE_TABLE, TAIL];

export async function driftingViaIndexedFragments(
  executor: FixtureExecutor,
  userLinkId: string,
): Promise<number> {
  const result = await executor.query(PARTS[0] + PARTS[1] + PARTS[2], [userLinkId]);
  return result.rows.length;
}

export async function driftingViaIndexMethod(
  executor: FixtureExecutor,
  userLinkId: string,
): Promise<number> {
  const result = await executor.query(PARTS.at(0) + PARTS.at(1) + PARTS.at(-1), [userLinkId]);
  return result.rows.length;
}
