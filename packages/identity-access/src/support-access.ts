/**
 * Delegated support access (FBL-020, ADR-008). Never impersonation: the
 * platform-support person stays the actor everywhere. Requests carry an
 * explicit action set, scope, bounded reason and duration; approval must
 * come from a DIFFERENT user (schema-enforced); sessions are structurally
 * capped at 60 minutes and revocable at any instant. The reason text lives
 * in the request row ONLY — it is never copied into ordinary logs.
 *
 * FBL-020-R3: the WRITES live in ./mutations.ts, with every other mutation that
 * can change what an actor may do — one true actor, one advancing
 * authorization_version, one audit row in the same transaction. This module
 * keeps the contracts and the non-suppressible READ.
 */
import { query } from '@dealer/database';
import { mapSupportAccessSession } from './mutations';
import type { SupportAccessSession } from './contracts';

interface Row {
  [key: string]: unknown;
}

/**
 * The NON-SUPPRESSIBLE indicator source: every live session for a tenant.
 * /auth/session, the response header and the logs all read this — a web
 * surface must render it and may not hide it.
 */
export async function listActiveSupportSessions(tenantId: string): Promise<SupportAccessSession[]> {
  const result = await query(
    `SELECT * FROM support_access_sessions
      WHERE tenant_id = $1 AND revoked_at IS NULL AND expires_at > NOW()
      ORDER BY granted_at DESC`,
    [tenantId],
  );
  return (result.rows as Row[]).map(mapSupportAccessSession);
}
