/**
 * NEGATIVE FIXTURE — the structured opt-out is VALIDATED, not just parsed.
 *
 * This fixture has no pre-H1 counterpart: the `opt-out(<code>)` form did not exist
 * before H1, and its whole point is that naming a code is not the same as having
 * one. Three ways a declaration can be well-formed and still not be an exception:
 *
 *   - a code that is not one of the recognised categories;
 *   - a recognised code with no justification worth reading;
 *   - a recognised code used in a file where that category cannot apply.
 *
 * Each read underneath is the same genuine drift, so a declaration that failed to
 * excuse it leaves a reported violation rather than a silent pass.
 */
interface FixtureExecutor {
  query(sql: string, params: readonly unknown[]): Promise<{ rows: Array<{ role: string }> }>;
}

/** A code invented on the spot — and "effectiveness is handled elsewhere" is
 * precisely the claim the shared predicate exists to stop anyone making. */
export async function unknownCode(executor: FixtureExecutor, userLinkId: string): Promise<number> {
  // role-binding-effectiveness-opt-out(effectiveness-handled-elsewhere): the caller
  // already checked that this binding is effective, so checking the window twice
  // here would be redundant work on a path we care about the latency of.
  const result = await executor.query(
    `SELECT rb.role FROM role_bindings rb
      WHERE rb.user_link_id = $1 AND rb.effective_to IS NULL`,
    [userLinkId],
  );
  return result.rows.length;
}

/** A real category, asserted rather than justified. */
export async function unjustified(executor: FixtureExecutor, userLinkId: string): Promise<number> {
  // role-binding-effectiveness-opt-out(all-bindings-including-ineffective): needed.
  const result = await executor.query(
    `SELECT rb.role FROM role_bindings rb
      WHERE rb.user_link_id = $1 AND rb.status = 'active'
      ORDER BY rb.granted_at`,
    [userLinkId],
  );
  return result.rows.length;
}

/** A real category that belongs to exactly one file, which this is not. */
export async function inapplicableCode(
  executor: FixtureExecutor,
  userLinkId: string,
): Promise<number> {
  // role-binding-effectiveness-opt-out(predicate-definition): this is where the
  // effectiveness rule is written down for this module, so a rule about not
  // restating it plainly cannot apply to the place that states it.
  const result = await executor.query(
    `SELECT rb.role FROM role_bindings rb
      WHERE rb.user_link_id = $1 AND rb.effective_from <= NOW()`,
    [userLinkId],
  );
  return result.rows.length;
}
