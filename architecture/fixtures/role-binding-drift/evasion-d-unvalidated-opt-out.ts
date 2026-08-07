/**
 * NEGATIVE FIXTURE — EVASION (d): the opt-out was any twenty characters of prose.
 *
 * The pre-H1 guard accepted ANY `role-binding-effectiveness-opt-out:` comment whose
 * text reached twenty characters. It validated nothing about the reason, so the
 * sentence below retired the rule for a plain window-dropping read: the run reported
 * `1 declared opt-out(s), OK` and exited 0. An exception mechanism that accepts any
 * prose is not an exception mechanism; it is an off switch with a comment on it.
 *
 * The hardened guard requires a reason CODE from a closed set. There is no code for
 * "it is fine", so this does not excuse anything.
 */
interface FixtureExecutor {
  query(sql: string, params: readonly unknown[]): Promise<{ rows: Array<{ role: string }> }>;
}

export async function optedOutWithProseAlone(
  executor: FixtureExecutor,
  userLinkId: string,
): Promise<number> {
  // role-binding-effectiveness-opt-out: we need this here for now, it is fine and
  // has been like this for a while, so please leave it alone.
  const result = await executor.query(
    `SELECT rb.role FROM role_bindings rb
      WHERE rb.user_link_id = $1 AND rb.status = 'active'`,
    [userLinkId],
  );
  return result.rows.length;
}
