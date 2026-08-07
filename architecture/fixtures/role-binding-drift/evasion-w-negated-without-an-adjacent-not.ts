/**
 * NEGATIVE FIXTURE — NEGATION THAT IS NOT SPELLED NEXT TO THE PREDICATE.
 *
 * Rule 3 caught `NOT (${…})` by looking at the character immediately before the
 * resolved mark. Two everyday spellings of the same inversion put something else
 * there:
 *
 *   - DE MORGAN. `NOT (rb.scope_level = 'platform' AND ${…})` is
 *     `NOT rb.scope_level = 'platform' OR NOT ${…}`. Nothing adjacent to the mark
 *     is an `OR` or a `NOT`; the negation is applied to the group that encloses
 *     it. Every enclosing group is now examined, which is one backward pass.
 *   - A COMPARISON. `(${…}) IS NOT TRUE` selects exactly the bindings the
 *     predicate exists to withhold, and reads as a conjunct while doing it.
 *     `IS FALSE`, `IS NULL`, `IS DISTINCT FROM` and `= FALSE` are the same move;
 *     `IS TRUE` is not, and is not reported.
 *
 * What is still NOT caught, and is recorded in
 * `docs/identity/KNOWN-LIMITATIONS.md` rather than implied away: a rewrite that
 * keeps the predicate conjoined-LOOKING while discarding its result, such as
 * `CASE WHEN ${…} THEN TRUE ELSE TRUE END`. Rule 3 reads text; it does not
 * evaluate SQL.
 */
import { EFFECTIVE_ROLE_BINDING_SQL } from '@dealer/identity-access';

interface FixtureExecutor {
  query(sql: string, params: readonly unknown[]): Promise<{ rows: Array<{ role: string }> }>;
}

/** De Morgan: the NOT is over the group, not over the predicate. */
export async function negatedThroughAnEnclosingGroup(
  executor: FixtureExecutor,
  userLinkId: string,
): Promise<number> {
  const result = await executor.query(
    `SELECT rb.role FROM role_bindings rb
      WHERE rb.user_link_id = $1
        AND NOT (rb.scope_level = 'platform' AND ${EFFECTIVE_ROLE_BINDING_SQL})`,
    [userLinkId],
  );
  return result.rows.length;
}

/** Compared rather than conjoined: the predicate decides, then is inverted. */
export async function comparedRatherThanConjoined(
  executor: FixtureExecutor,
  userLinkId: string,
): Promise<number> {
  const result = await executor.query(
    `SELECT rb.role FROM role_bindings rb
      WHERE rb.user_link_id = $1
        AND (${EFFECTIVE_ROLE_BINDING_SQL}) IS NOT TRUE`,
    [userLinkId],
  );
  return result.rows.length;
}
