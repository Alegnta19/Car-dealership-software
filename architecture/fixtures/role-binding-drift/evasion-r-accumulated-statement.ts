/**
 * NEGATIVE FIXTURE — EVASION (r): the statement is ACCUMULATED across several
 * assignments.
 *
 * `let sql = HEAD; sql += TABLE; sql += TAIL;` is the oldest way there is to
 * build a query, and it has no assembly expression in it at all — by the time
 * `sql` reaches `query()` it is a bare identifier, and a guard that judged
 * expressions saw only its declaration, which is one innocent fragment.
 *
 * The guard now reads an accumulator as its declared value followed by everything
 * appended to it, and judges the statement at the point it is COMPLETE — the last
 * append — so it is reported once, whole, rather than three times in prefixes.
 * `n = n + x` is the same statement in different punctuation and is read the same
 * way.
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

export async function driftingViaPlusEquals(
  executor: FixtureExecutor,
  userLinkId: string,
): Promise<number> {
  let accumulated = HEAD;
  accumulated += BARE_TABLE;
  accumulated += TAIL;
  const result = await executor.query(accumulated, [userLinkId]);
  return result.rows.length;
}

export async function driftingViaSelfAssignment(
  executor: FixtureExecutor,
  userLinkId: string,
): Promise<number> {
  let restated = HEAD;
  restated = restated + BARE_TABLE + TAIL;
  const result = await executor.query(restated, [userLinkId]);
  return result.rows.length;
}
