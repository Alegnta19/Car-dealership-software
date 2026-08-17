/**
 * NEGATIVE FIXTURE (FBL-020-R4 §5) — deliberately WRONG.
 *
 * The statement is SPLIT across a concatenation so that no single literal both says
 * UPDATE and names the table. The guard renders the assembled value, so it must still
 * reject this as `owned-mutation-write-outside-owner`.
 */
import { query } from '@dealer/database';

export async function deactivate(userLinkId: string): Promise<void> {
  const sql = 'UPDATE ' + 'user_links SET status = ' + "'deactivated' WHERE user_link_id = $1";
  await query(sql, [userLinkId]);
}
