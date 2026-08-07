/**
 * NEGATIVE FIXTURE — EVASION (a): the table name is interpolated.
 *
 * `role_bindings` never appears in the SQL literal, so the pre-H1 guard's table
 * pattern never matched it and the statement was never inspected at all: the run
 * reported `0 statement(s) inspected, OK` and exited 0. The read itself is the
 * original defect shape — `status` filtered, the effective window dropped — so a
 * binding left `active` with an `effective_to` a day in the past is reported as a
 * held role while the policy engine refuses every action it names.
 *
 * The hardened guard RESOLVES the interpolation to the constant it refers to,
 * renders the statement with the table name in place, and reports both halves of
 * the rule.
 */
interface FixtureExecutor {
  query(sql: string, params: readonly unknown[]): Promise<{ rows: Array<{ role: string }> }>;
}

/** The table name, one indirection away from the SQL. */
const BINDINGS_TABLE = 'role_bindings';

export async function driftingRolesForUserLink(
  executor: FixtureExecutor,
  userLinkId: string,
): Promise<string[]> {
  const result = await executor.query(
    `SELECT DISTINCT rb.role FROM ${BINDINGS_TABLE} rb
      WHERE rb.user_link_id = $1 AND rb.status = 'active'
      ORDER BY rb.role`,
    [userLinkId],
  );
  return result.rows.map((r) => r.role);
}
