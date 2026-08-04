/**
 * Delegated support access (FBL-020, ADR-008). Never impersonation: the
 * platform-support person stays the actor everywhere. Requests carry an
 * explicit action set, scope, bounded reason and duration; approval must
 * come from a DIFFERENT user (schema-enforced); sessions are structurally
 * capped at 60 minutes and revocable at any instant. The reason text lives
 * in the request row ONLY — it is never copied into ordinary logs.
 */
import { query, withTransaction } from '@dealer/database';

export interface SupportAccessRequest {
  readonly requestId: string;
  readonly tenantId: string;
  readonly requesterUserLinkId: string;
  readonly requestedActions: readonly string[];
  readonly scopeLevel: string;
  readonly scopeId: string | null;
  readonly requestedDurationMinutes: number;
  readonly status: 'pending' | 'approved' | 'denied' | 'cancelled' | 'expired';
}

export interface SupportAccessSession {
  readonly supportSessionId: string;
  readonly requestId: string;
  readonly tenantId: string;
  readonly actorUserLinkId: string;
  readonly grantedAt: Date;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
}

interface Row {
  [key: string]: unknown;
}

function ts(v: unknown): Date {
  return v instanceof Date ? v : new Date(String(v));
}

function mapRequest(r: Row): SupportAccessRequest {
  return {
    requestId: String(r.request_id),
    tenantId: String(r.tenant_id),
    requesterUserLinkId: String(r.requester_user_link_id),
    requestedActions: (r.requested_actions as string[]) ?? [],
    scopeLevel: String(r.scope_level),
    scopeId: r.scope_id === null ? null : String(r.scope_id),
    requestedDurationMinutes: Number(r.requested_duration_minutes),
    status: String(r.status) as SupportAccessRequest['status'],
  };
}

function mapSession(r: Row): SupportAccessSession {
  return {
    supportSessionId: String(r.support_session_id),
    requestId: String(r.request_id),
    tenantId: String(r.tenant_id),
    actorUserLinkId: String(r.actor_user_link_id),
    grantedAt: ts(r.granted_at),
    expiresAt: ts(r.expires_at),
    revokedAt: r.revoked_at === null || r.revoked_at === undefined ? null : ts(r.revoked_at),
  };
}

export async function requestSupportAccess(input: {
  tenantId: string;
  requesterUserLinkId: string;
  requestedActions: readonly string[];
  scopeLevel?: string;
  scopeId?: string | null;
  reason: string;
  requestedDurationMinutes: number;
}): Promise<SupportAccessRequest> {
  return withTransaction(async (executor) => {
    const result = await executor.query(
      `INSERT INTO support_access_requests
         (tenant_id, requester_user_link_id, requested_actions, scope_level, scope_id, reason, requested_duration_minutes)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [
        input.tenantId,
        input.requesterUserLinkId,
        [...input.requestedActions],
        input.scopeLevel ?? 'tenant',
        input.scopeId ?? null,
        input.reason,
        input.requestedDurationMinutes,
      ],
    );
    const request = mapRequest(result.rows[0] as Row);
    // the audit row records THAT a request exists — never its reason text
    await executor.query(
      `INSERT INTO audit_events (tenant_id, event_type, entity_type, entity_id, actor_user_id, details)
       VALUES ($1, 'identity.support.requested', 'support_access_request', $2, $3, $4)`,
      [
        request.tenantId,
        request.requestId,
        request.requesterUserLinkId,
        JSON.stringify({
          requested_actions: request.requestedActions,
          scope_level: request.scopeLevel,
          duration_minutes: request.requestedDurationMinutes,
        }),
      ],
    );
    return request;
  });
}

/**
 * Approval (or denial) by a DIFFERENT authorized administrator — the
 * requester/approver separation is also a table CHECK, so a self-approval
 * attempt is a database error even if a bug reaches this far. Approval
 * creates the bounded session in the same transaction.
 */
export async function decideSupportAccess(input: {
  requestId: string;
  decidedByUserLinkId: string;
  approve: boolean;
  /**
   * FBL-020-R2: an APPROVAL must be backed by a high-assurance
   * reauthentication grant belonging to the approver. Separation of duty
   * alone is not enough — the approver must have freshly re-authenticated
   * under a certified MFA policy. Denials need no grant.
   */
  approvalGrantId?: string | null;
}): Promise<SupportAccessSession | null> {
  return withTransaction(async (executor) => {
    if (input.approve) {
      // The grant must exist, be consumed, belong to the approver, and have
      // been minted at fresh_and_mfa_policy. Anything less cannot approve.
      const grant = await executor.query(
        `SELECT 1 FROM reauthentication_grants
          WHERE grant_id = $1
            AND user_link_id = $2
            AND assurance_level = 'fresh_and_mfa_policy'
            AND mfa_policy_certified_at_issue = TRUE
            AND consumed_at IS NOT NULL`,
        [input.approvalGrantId ?? null, input.decidedByUserLinkId],
      );
      if (grant.rows.length === 0) return null;
    }
    const updated = await executor.query(
      `UPDATE support_access_requests
          SET status = $3,
              decided_by_user_link_id = $2,
              decided_at = NOW(),
              approval_grant_id = $4,
              authorization_version = authorization_version + 1
        WHERE request_id = $1 AND status = 'pending'
        RETURNING *`,
      [
        input.requestId,
        input.decidedByUserLinkId,
        input.approve ? 'approved' : 'denied',
        input.approve ? (input.approvalGrantId ?? null) : null,
      ],
    );
    if (updated.rows.length === 0) return null;
    const request = mapRequest(updated.rows[0] as Row);

    await executor.query(
      `INSERT INTO audit_events (tenant_id, event_type, entity_type, entity_id, actor_user_id, details)
       VALUES ($1, $2, 'support_access_request', $3, $4, $5)`,
      [
        request.tenantId,
        input.approve ? 'identity.support.approved' : 'identity.support.denied',
        request.requestId,
        input.decidedByUserLinkId,
        JSON.stringify({ requester_user_link_id: request.requesterUserLinkId }),
      ],
    );
    if (!input.approve) return null;

    const session = await executor.query(
      `INSERT INTO support_access_sessions (request_id, tenant_id, actor_user_link_id, expires_at)
       VALUES ($1, $2, $3, NOW() + make_interval(mins => $4)) RETURNING *`,
      [
        request.requestId,
        request.tenantId,
        request.requesterUserLinkId,
        request.requestedDurationMinutes,
      ],
    );
    return mapSession(session.rows[0] as Row);
  });
}

/** Revocation ends access on the very next policy decision. */
export async function revokeSupportSession(input: {
  supportSessionId: string;
  revokedByUserLinkId: string;
}): Promise<boolean> {
  return withTransaction(async (executor) => {
    const updated = await executor.query(
      `UPDATE support_access_sessions
          SET revoked_at = NOW(),
              revoked_by_user_link_id = $2,
              authorization_version = authorization_version + 1
        WHERE support_session_id = $1 AND revoked_at IS NULL
        RETURNING tenant_id, actor_user_link_id`,
      [input.supportSessionId, input.revokedByUserLinkId],
    );
    if (updated.rows.length === 0) return false;
    const row = updated.rows[0] as Row;
    await executor.query(
      `INSERT INTO audit_events (tenant_id, event_type, entity_type, entity_id, actor_user_id, details)
       VALUES ($1, 'identity.support.revoked', 'support_access_session', $2, $3, $4)`,
      [
        String(row.tenant_id),
        input.supportSessionId,
        input.revokedByUserLinkId,
        JSON.stringify({ actor_user_link_id: String(row.actor_user_link_id) }),
      ],
    );
    return true;
  });
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
  return (result.rows as Row[]).map(mapSession);
}
