/**
 * NEGATIVE FIXTURE — EVASION (m): the statement is CORRECT, and then rewritten.
 *
 * Every read below starts from `GUARDED`, which resolves the shared predicate and
 * conjoins it — the guard judges that declaration and finds nothing wrong with
 * it. What reaches the database is a rewrite of it: `.replace` deletes the
 * predicate, `.slice` cuts the statement off before it, `.toLowerCase` folds the
 * case out from under every rule. None of these can be modelled by a static
 * reader, and treating them as identities would let any of the three hand back
 * exactly the authority the predicate exists to withhold.
 *
 * So the guard keeps the RECEIVER — which is how it still sees that this is a
 * role-bindings read — and marks the operation unresolvable. The statement is
 * reported under `role-binding-sql-not-statically-resolvable` and needs the one
 * declared, reviewed exception that can excuse it. Silence would be the failure:
 * a compliant literal and a hostile rewrite of it look identical in a run that
 * only ever judged the literal.
 */
import { EFFECTIVE_ROLE_BINDING_SQL } from '@dealer/identity-access';

interface FixtureExecutor {
  query(sql: string, params: readonly unknown[]): Promise<{ rows: Array<{ role: string }> }>;
}

/** Compliant as written: one read, the shared predicate resolved and conjoined. */
const GUARDED = `SELECT rb.role FROM role_bindings rb
  WHERE rb.user_link_id = $1 AND ${EFFECTIVE_ROLE_BINDING_SQL}`;

export async function neutralisedByReplace(
  executor: FixtureExecutor,
  userLinkId: string,
): Promise<number> {
  const result = await executor.query(GUARDED.replace(EFFECTIVE_ROLE_BINDING_SQL, 'TRUE'), [
    userLinkId,
  ]);
  return result.rows.length;
}

export async function truncatedBySlice(
  executor: FixtureExecutor,
  userLinkId: string,
): Promise<number> {
  const result = await executor.query(GUARDED.slice(0, GUARDED.indexOf(' AND ')), [userLinkId]);
  return result.rows.length;
}

export async function foldedByCase(executor: FixtureExecutor, userLinkId: string): Promise<number> {
  const result = await executor.query(GUARDED.toLowerCase(), [userLinkId]);
  return result.rows.length;
}
