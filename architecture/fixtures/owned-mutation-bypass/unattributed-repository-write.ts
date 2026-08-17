/**
 * NEGATIVE FIXTURE (FBL-020-R4 §5) — deliberately WRONG.
 *
 * The exact shape §5 removed from `@dealer/organization`: a production module writing
 * authorization state with no acting actor, no version advance and no audit row.
 * Archiving a rooftop revokes every binding scoped beneath it, so this is a mass
 * revocation nobody performed. The guard must reject it as
 * `owned-mutation-write-outside-owner`.
 */
import { query } from '@dealer/database';

export async function archiveRooftop(tenantId: string, rooftopId: string): Promise<void> {
  await query(`UPDATE rooftops SET status = 'archived' WHERE tenant_id = $1 AND rooftop_id = $2`, [
    tenantId,
    rooftopId,
  ]);
}
