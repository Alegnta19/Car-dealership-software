/**
 * NEGATIVE FIXTURE (FBL-020-R4 §3) — deliberately WRONG.
 *
 * The hole the `identity.` literal scan cannot see on its own: an audit write in a BRAND
 * NEW namespace, from a file nobody declared an audit writer. Nothing about
 * `tenant.provisioned` is in the identity namespace, so no amount of enumerating
 * `identity.*` would notice it — the rule that catches it is about FILES.
 *
 * The checker must reject it as `audit-write-outside-declared-writer`.
 */
import { query } from '@dealer/database';

export async function auditTenantProvisioned(tenantId: string): Promise<void> {
  await query(
    `INSERT INTO audit_events (tenant_id, event_type, entity_type, entity_id, details)
     VALUES ($1, 'tenant.provisioned', 'tenant', $1, '{}'::jsonb)`,
    [tenantId],
  );
}
