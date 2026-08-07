/**
 * NEGATIVE FIXTURE — EVASION (j): the statement is assembled by
 * `Array.prototype.join`.
 *
 * This is evasion (b) with one substitution: the pieces are joined by a METHOD
 * CALL rather than by `+`. The H1 guard resolved `+` and template interpolation
 * and nothing else, so `parts.join('')` was a call expression it could not read —
 * one opaque fragment carrying no SELECT, no FROM and no table name. The
 * statement therefore never looked like SQL, `role_bindings` never appeared in
 * anything the guard judged, and the run reported `0 statement(s) inspected, OK`.
 *
 * Three spellings of the same assembly are here, because the array can be built
 * three ways and a resolver that understood only the first would leave the other
 * two open:
 *
 *   - an array literal joined in place;
 *   - a spread of a shared fragment list into a fresh array;
 *   - an empty array filled by `push` and joined afterwards.
 *
 * The read underneath every one of them is the original drift shape: `status`
 * filtered, the effective window dropped, the shared predicate absent.
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

export async function driftingViaArrayJoin(
  executor: FixtureExecutor,
  userLinkId: string,
): Promise<number> {
  const literalParts = [HEAD, BARE_TABLE, TAIL];
  const result = await executor.query(literalParts.join(''), [userLinkId]);
  return result.rows.length;
}

const OPENING = [HEAD, BARE_TABLE];

export async function driftingViaSpreadJoin(
  executor: FixtureExecutor,
  userLinkId: string,
): Promise<number> {
  const spreadParts = [...OPENING, TAIL];
  const result = await executor.query(spreadParts.join(''), [userLinkId]);
  return result.rows.length;
}

export async function driftingViaPushedJoin(
  executor: FixtureExecutor,
  userLinkId: string,
): Promise<number> {
  const pushedParts: string[] = [];
  pushedParts.push(HEAD);
  pushedParts.push(BARE_TABLE, TAIL);
  const result = await executor.query(pushedParts.join(''), [userLinkId]);
  return result.rows.length;
}
