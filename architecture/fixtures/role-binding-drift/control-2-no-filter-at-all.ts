/**
 * CONTROL — an authorization read with NO effectiveness filter at all.
 *
 * Caught before H1 and must stay caught. The bluntest form of the defect: every
 * binding the row holds is reported as a held role, revoked and expired ones
 * included.
 */
interface FixtureExecutor {
  query(sql: string, params: readonly unknown[]): Promise<{ rows: Array<{ role: string }> }>;
}

export async function unfilteredRoles(
  executor: FixtureExecutor,
  userLinkId: string,
): Promise<number> {
  const result = await executor.query(
    `SELECT DISTINCT rb.role FROM role_bindings rb
      WHERE rb.user_link_id = $1
      ORDER BY rb.role`,
    [userLinkId],
  );
  return result.rows.length;
}
