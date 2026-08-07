/**
 * POSITIVE FIXTURE — FALSE POSITIVE (3): the statement is ASSEMBLED, and correct.
 *
 * The evasions in `role-binding-drift/` taught the guard to resolve `.join`,
 * `.concat` and `String.raw`. This file is the other half of that: assembling a
 * statement out of fragments is a legitimate thing to do, and an author who does
 * it while resolving the shared predicate must be left alone.
 *
 * A guard that rejected these three would teach exactly the lesson the H1 rewrite
 * was written to un-teach — that satisfying the checker means spelling the SQL
 * its way — and an author who cannot satisfy the checker writes SQL somewhere the
 * checker does not look.
 *
 * The fragments are deliberately the SAME ONES as
 * `role-binding-drift/evasion-j-array-join.ts`, assembled the same way. The only
 * difference between that file and this one is which predicate ends up in the
 * WHERE clause, which is the only difference the guard is entitled to notice.
 */
import { EFFECTIVE_ROLE_BINDING_SQL } from '@dealer/identity-access';

interface FixtureExecutor {
  query(sql: string, params: readonly unknown[]): Promise<{ rows: Array<{ role: string }> }>;
}

const HEAD = 'SELECT rb.role FROM ';
const BARE_TABLE = 'role_bindings';
const WHERE_LINK = ' rb WHERE rb.user_link_id = $1 AND ';
const ORDER = ' ORDER BY rb.role';

export async function rolesJoined(executor: FixtureExecutor, userLinkId: string): Promise<number> {
  const statement = [HEAD, BARE_TABLE, WHERE_LINK, EFFECTIVE_ROLE_BINDING_SQL, ORDER].join('');
  const result = await executor.query(statement, [userLinkId]);
  return result.rows.length;
}

export async function rolesConcatenated(
  executor: FixtureExecutor,
  userLinkId: string,
): Promise<number> {
  const statement = HEAD.concat(BARE_TABLE, WHERE_LINK, EFFECTIVE_ROLE_BINDING_SQL, ORDER);
  const result = await executor.query(statement, [userLinkId]);
  return result.rows.length;
}

export async function rolesFromRawTemplate(
  executor: FixtureExecutor,
  userLinkId: string,
): Promise<number> {
  const result = await executor.query(
    String.raw`SELECT rb.role FROM role_bindings rb
      WHERE rb.user_link_id = $1 AND ${EFFECTIVE_ROLE_BINDING_SQL}
      ORDER BY rb.role`,
    [userLinkId],
  );
  return result.rows.length;
}
