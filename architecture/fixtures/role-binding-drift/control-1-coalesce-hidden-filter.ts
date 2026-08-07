/**
 * CONTROL — a filter hidden inside COALESCE.
 *
 * Caught before H1 and must stay caught. Nothing here textually restates a guarded
 * column against an operator, so rule 2 does not fire; the read is rejected purely
 * because it does not resolve the shared predicate. That is the point of rule 1
 * being "the shared constant" rather than "filters somehow": a filter that LOOKS
 * careful is still a second opinion about effectiveness.
 */
interface FixtureExecutor {
  query(sql: string, params: readonly unknown[]): Promise<{ rows: Array<{ role: string }> }>;
}

export async function coalesceHiddenFilter(
  executor: FixtureExecutor,
  userLinkId: string,
): Promise<number> {
  const result = await executor.query(
    `SELECT rb.role FROM role_bindings rb
      WHERE rb.user_link_id = $1
        AND COALESCE(rb.status, 'active') = 'active'
        AND COALESCE(rb.effective_to, NOW()) >= NOW()
      ORDER BY rb.role`,
    [userLinkId],
  );
  return result.rows.length;
}
