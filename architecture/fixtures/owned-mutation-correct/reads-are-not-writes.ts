/**
 * POSITIVE FIXTURE (FBL-020-R4 §5) — deliberately RIGHT.
 *
 * READS of the owned tables are not the boundary's business, and prose that mentions
 * an update is not a statement. Both must be accepted, or the guard would push every
 * reader of these tables into a pointless exemption list.
 *
 * "This function used to UPDATE user_links; it no longer does." — that sentence is in a
 * comment and must not trip anything.
 */
import { query } from '@dealer/database';

export async function activatedLinks(tenantId: string): Promise<unknown[]> {
  const result = await query(
    `SELECT user_link_id FROM user_links WHERE tenant_id = $1 AND status = 'activated'`,
    [tenantId],
  );
  return result.rows;
}
