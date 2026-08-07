/**
 * NEGATIVE FIXTURE — EVASION (l): `String.raw` as a one-token off switch.
 *
 * The H1 guard SKIPPED every `String.raw` template outright, on the reasoning
 * that raw templates in this repository build regular expressions. That made
 * `String.raw` an undeclared, unvalidated exception needing no reason code and no
 * justification — one word in front of a backtick and the SQL was invisible. The
 * whole point of the structured opt-out is that an exception is written down and
 * read by a reviewer; this one was neither.
 *
 * The SQL below is not disguised in any other way. It names the table literally,
 * it says SELECT and FROM, and it is the original drift shape: `status` filtered,
 * the effective window dropped. Written with a plain backtick it is caught by two
 * rules; tagged `String.raw` it was reported as `0 statement(s) inspected, OK`.
 *
 * A raw template's value differs from a cooked one only in how backslashes are
 * handled, so there is nothing here a static reader cannot resolve — which is why
 * the guard now resolves it and judges it like any other literal. Raw templates
 * that really do build regular expressions are proved unaffected by
 * `role-binding-correct/raw-regex-is-not-sql.ts`.
 */
interface FixtureExecutor {
  query(sql: string, params: readonly unknown[]): Promise<{ rows: Array<{ role: string }> }>;
}

export async function driftingViaRawTemplate(
  executor: FixtureExecutor,
  userLinkId: string,
): Promise<number> {
  const result = await executor.query(
    String.raw`SELECT rb.role FROM role_bindings rb
      WHERE rb.user_link_id = $1 AND rb.status = 'active'
      ORDER BY rb.role`,
    [userLinkId],
  );
  return result.rows.length;
}

const RAW_TABLE = String.raw`role_bindings`;

export async function driftingViaRawFragment(
  executor: FixtureExecutor,
  userLinkId: string,
): Promise<number> {
  const result = await executor.query(
    `SELECT rb.role FROM ${RAW_TABLE} rb
      WHERE rb.user_link_id = $1 AND rb.effective_from <= NOW()`,
    [userLinkId],
  );
  return result.rows.length;
}
