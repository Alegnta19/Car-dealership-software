/**
 * NEGATIVE FIXTURE — EVASION (b): the SQL is assembled out of fragments, and no
 * single literal both names the table and looks like SQL.
 *
 * `'role_bindings rb'` names the table but carries no SQL keyword; the WHERE
 * fragment carries the dropped-window filter but names no table; the statement
 * that joins them looks like SQL but does not spell the table. Each piece
 * therefore failed one half of the pre-H1 guard's two-part text test, so nothing
 * was inspected and the run exited 0.
 *
 * Both assembly styles are here — template interpolation and `+` concatenation —
 * because the hardened guard renders each of them by resolving the references and
 * judging the statement that actually reaches the database.
 */
interface FixtureExecutor {
  query(sql: string, params: readonly unknown[]): Promise<{ rows: Array<{ role: string }> }>;
}

/** Names the table, contains no SQL keyword. */
const SOURCE = 'role_bindings rb';
/** Is the drift, names no table. */
const LIFECYCLE_ONLY = `rb.status = 'active'`;

export async function driftingViaTemplateFragments(
  executor: FixtureExecutor,
  userLinkId: string,
): Promise<number> {
  const result = await executor.query(
    `SELECT rb.role FROM ${SOURCE}
      WHERE rb.user_link_id = $1 AND ${LIFECYCLE_ONLY}
      ORDER BY rb.role`,
    [userLinkId],
  );
  return result.rows.length;
}

/** Looks like SQL, names no table. */
const HEAD = 'SELECT rb.role FROM ';
/** Names the table, contains no SQL keyword. */
const BARE_TABLE = 'role_bindings';
/** Carries the drift, contains no SQL keyword and names no table. */
const TAIL = ' rb WHERE rb.user_link_id = $1 AND rb.effective_to IS NULL';

export async function driftingViaConcatenation(
  executor: FixtureExecutor,
  userLinkId: string,
): Promise<number> {
  const result = await executor.query(HEAD + BARE_TABLE + TAIL, [userLinkId]);
  return result.rows.length;
}
