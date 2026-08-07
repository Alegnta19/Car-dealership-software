/**
 * NEGATIVE FIXTURE — EVASION (h): ONE statement issued once per table in a list.
 *
 * The interpolated name is a `for … of` element binding, so the SAME literal is
 * sent to the database with a different table each time round the loop. A guard
 * that resolved the binding to the FIRST element would judge `audit_events` and
 * stop; the `role_bindings` iteration — `status` filtered, effective window
 * dropped, shared predicate absent — is the one that matters and is the one it
 * would never see.
 *
 * The guard resolves an element binding to EVERY element of the array and judges
 * the statement once per element, so the loop hides nothing. Sibling of (g): that
 * one takes its many possibilities from an object literal, this one from an array.
 */
interface FixtureExecutor {
  query(sql: string, params: readonly unknown[]): Promise<{ rows: Array<{ n: string }> }>;
}

/** Every table the nightly tenant census counts. */
const CENSUS_TABLES = ['audit_events', 'role_bindings'];

export async function driftingTenantCensus(
  executor: FixtureExecutor,
  tenantId: string,
): Promise<number> {
  let total = 0;
  for (const table of CENSUS_TABLES) {
    const result = await executor.query(
      `SELECT COUNT(*)::text AS n FROM ${table} rb
        WHERE rb.tenant_id = $1 AND rb.status = 'active'`,
      [tenantId],
    );
    total += Number(result.rows[0]?.n ?? '0');
  }
  return total;
}
