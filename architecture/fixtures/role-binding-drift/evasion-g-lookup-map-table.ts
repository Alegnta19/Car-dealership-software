/**
 * NEGATIVE FIXTURE — EVASION (g): ONE statement, MANY possible tables, chosen by
 * a key the guard cannot resolve.
 *
 * The table name comes out of a lookup map under a caller-supplied key. Nothing
 * static can say which entry is taken, so a guard that resolved the expression to
 * ONE value would have to pick one — and picking the first (`audit_events`) makes
 * this statement look as though it never touches the role-bindings table at all.
 * The read is the original defect shape underneath: `status` filtered, the
 * effective window dropped, the shared predicate absent.
 *
 * The guard therefore OVER-APPROXIMATES an unresolvable key to EVERY property of
 * the map, renders the statement once per possibility and judges each one. The
 * `role_bindings` possibility is a violation, so the statement is a violation.
 *
 * This is the fixture that fails if that over-approximation is ever narrowed to a
 * sample: with only the first possibility judged, this file passes the guard.
 */
interface FixtureExecutor {
  query(sql: string, params: readonly unknown[]): Promise<{ rows: Array<{ n: string }> }>;
}

/** Which physical table each audited subject lives in. */
const SUBJECT_TABLES: Record<string, string> = {
  audit: 'audit_events',
  bindings: 'role_bindings',
};

export async function driftingCountForSubject(
  executor: FixtureExecutor,
  subject: string,
  tenantId: string,
): Promise<string> {
  const table = SUBJECT_TABLES[subject];
  const result = await executor.query(
    `SELECT COUNT(*)::text AS n FROM ${table} rb
      WHERE rb.tenant_id = $1 AND rb.status = 'active'`,
    [tenantId],
  );
  return result.rows[0]?.n ?? '0';
}
