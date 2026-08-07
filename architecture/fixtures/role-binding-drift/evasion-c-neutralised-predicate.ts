/**
 * NEGATIVE FIXTURE — EVASION (c): the shared predicate is interpolated and then
 * NEUTRALISED.
 *
 * `AND (${EFFECTIVE_ROLE_BINDING_SQL} OR TRUE)` satisfied the pre-H1 guard
 * completely: one read, one interpolation of the shared constant, and no restated
 * column anywhere, so the run exited 0 — while the SQL returns every binding the
 * row happens to hold, revoked and expired ones included. `reads === guarded` was
 * never a statement about what the SQL means.
 *
 * The hardened guard requires the resolved predicate to be CONJOINED: an OR on
 * either side of it, or a NOT in front of it, is a violation that no opt-out code
 * can excuse.
 */
import { EFFECTIVE_ROLE_BINDING_SQL } from '@dealer/identity-access';

interface FixtureExecutor {
  query(sql: string, params: readonly unknown[]): Promise<{ rows: Array<{ role: string }> }>;
}

/** Disjoined with a tautology: the predicate decides nothing. */
export async function neutralisedByTautology(
  executor: FixtureExecutor,
  userLinkId: string,
): Promise<number> {
  const result = await executor.query(
    `SELECT rb.role FROM role_bindings rb
      WHERE rb.user_link_id = $1
        AND (${EFFECTIVE_ROLE_BINDING_SQL} OR TRUE)
      ORDER BY rb.role`,
    [userLinkId],
  );
  return result.rows.length;
}

/** Disjoined with a column: the predicate is optional. */
export async function neutralisedByAlternative(
  executor: FixtureExecutor,
  userLinkId: string,
): Promise<number> {
  const result = await executor.query(
    `SELECT rb.role FROM role_bindings rb
      WHERE rb.user_link_id = $1
        AND (${EFFECTIVE_ROLE_BINDING_SQL} OR rb.granted_at IS NOT NULL)`,
    [userLinkId],
  );
  return result.rows.length;
}

/** Negated outright: the predicate selects exactly what it exists to exclude. */
export async function neutralisedByNegation(
  executor: FixtureExecutor,
  userLinkId: string,
): Promise<number> {
  const result = await executor.query(
    `SELECT rb.role FROM role_bindings rb
      WHERE rb.user_link_id = $1
        AND NOT (${EFFECTIVE_ROLE_BINDING_SQL})`,
    [userLinkId],
  );
  return result.rows.length;
}
