/**
 * NEGATIVE FIXTURE (FBL-020-R4 §5) — deliberately WRONG.
 *
 * The bootstrap bypass: a script minting a role binding directly instead of routing
 * through the attributed origin service. `owned-mutation-write-outside-owner`.
 */
import { query } from '@dealer/database';

export async function grantAdmin(tenantId: string, userLinkId: string): Promise<void> {
  await query(
    `INSERT INTO role_bindings (tenant_id, user_link_id, role, scope_level, scope_id)
     VALUES ($1, $2, 'tenant_admin', 'tenant', $1)`,
    [tenantId, userLinkId],
  );
}
