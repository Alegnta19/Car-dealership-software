/**
 * CONTROL — the spellings a careful author would try: SHOUTED SQL, and a schema
 * qualifier in front of the table.
 *
 * Both caught before H1 and both must stay caught. `ROLE_BINDINGS` is the same
 * table as `role_bindings`, and so is `public.role_bindings`; a guard that matched
 * only the lower-case bare name would let either spelling carry a hand-written
 * predicate straight through.
 */
interface FixtureExecutor {
  query(sql: string, params: readonly unknown[]): Promise<{ rows: Array<{ role: string }> }>;
}

export async function shoutedDrift(executor: FixtureExecutor, userLinkId: string): Promise<number> {
  const result = await executor.query(
    `SELECT RB.ROLE FROM ROLE_BINDINGS RB
      WHERE RB.USER_LINK_ID = $1 AND RB.STATUS = 'active'`,
    [userLinkId],
  );
  return result.rows.length;
}

export async function schemaQualifiedDrift(
  executor: FixtureExecutor,
  userLinkId: string,
): Promise<number> {
  const result = await executor.query(
    `SELECT rb.role FROM public.role_bindings rb
      WHERE rb.user_link_id = $1
        AND rb.effective_to IS NULL`,
    [userLinkId],
  );
  return result.rows.length;
}
