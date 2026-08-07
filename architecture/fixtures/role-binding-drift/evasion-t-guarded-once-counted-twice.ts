/**
 * NEGATIVE FIXTURE — THE SECOND READ PAID FOR WITH A SECOND COPY OF THE
 * PREDICATE.
 *
 * Rule 1 said "every one of those reads" and enforced a GLOBAL count:
 * `reads > guarded`. Interpolating the shared predicate TWICE into ONE read
 * therefore bought a second, entirely unguarded read of the same table — two
 * reads, two uses, no violation — which is precisely the compliance
 * `control-4-cte-rename-and-second-read.ts` (`guardedOnceReadTwice`) exists to
 * refuse. The control was one edit away from being defeated by the thing it was
 * written to catch.
 *
 * A use is now bound to the READ IT FOLLOWS, and every read needs one bound to
 * it. Both functions here are that hole in the two orders it can be written:
 * both copies before the second read, and both copies after it.
 *
 * The binding is positional and that suffices, because the shared predicate
 * names the table by its canonical alias `rb` — only one read in a statement can
 * be the read it constrains, so a statement that reaches the table twice needs a
 * declared exception rather than a second interpolation.
 */
import { EFFECTIVE_ROLE_BINDING_SQL } from '@dealer/identity-access';

interface FixtureExecutor {
  query(sql: string, params: readonly unknown[]): Promise<{ rows: Array<{ role: string }> }>;
}

/** Both copies land on the first read; the subquery's read has none. */
export async function boughtWithADuplicate(
  executor: FixtureExecutor,
  userLinkId: string,
): Promise<number> {
  const result = await executor.query(
    `SELECT rb.role
       FROM role_bindings rb
      WHERE rb.user_link_id = $1
        AND ${EFFECTIVE_ROLE_BINDING_SQL}
        AND ${EFFECTIVE_ROLE_BINDING_SQL}
        AND rb.scope_id IN (SELECT other.scope_id FROM role_bindings other
                             WHERE other.user_link_id = $1)`,
    [userLinkId],
  );
  return result.rows.length;
}

/** Both copies land on the joined read; the driving read has none. */
export async function bothCopiesAfterBothReads(
  executor: FixtureExecutor,
  userLinkId: string,
): Promise<number> {
  const result = await executor.query(
    `SELECT rb.role
       FROM role_bindings rb
       JOIN role_bindings other ON other.scope_id = rb.scope_id
      WHERE rb.user_link_id = $1
        AND (${EFFECTIVE_ROLE_BINDING_SQL})
        AND (${EFFECTIVE_ROLE_BINDING_SQL})`,
    [userLinkId],
  );
  return result.rows.length;
}
