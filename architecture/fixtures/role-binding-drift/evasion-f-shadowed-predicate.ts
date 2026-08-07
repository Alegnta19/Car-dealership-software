/**
 * NEGATIVE FIXTURE — a LOCAL constant of the same name posing as the shared one.
 *
 * The pre-H1 guard counted the literal text `${EFFECTIVE_ROLE_BINDING_SQL}`, so a
 * local declaration of that name was accepted as compliance: this file exited 0
 * while carrying a second, hand-written copy of the rule — the exact defect class
 * the shared constant exists to end — and the copy here has already drifted, with
 * `effective_from` missing.
 *
 * The hardened guard asks what the reference RESOLVES to. A local declaration is
 * not the shared predicate, so the read is unguarded and the copy's text is
 * substituted and reported as a restatement; the declaration itself is reported
 * too, because the predicate may be declared in exactly one file.
 */
interface FixtureExecutor {
  query(sql: string, params: readonly unknown[]): Promise<{ rows: Array<{ role: string }> }>;
}

/** A second copy of the rule, wearing the shared constant's name. */
const EFFECTIVE_ROLE_BINDING_SQL = `rb.status = 'active'
        AND (rb.effective_to IS NULL OR rb.effective_to > NOW())`;

export async function readsTheShadowedCopy(
  executor: FixtureExecutor,
  userLinkId: string,
): Promise<number> {
  const result = await executor.query(
    `SELECT rb.role FROM role_bindings rb
      WHERE rb.user_link_id = $1
        AND ${EFFECTIVE_ROLE_BINDING_SQL}`,
    [userLinkId],
  );
  return result.rows.length;
}
