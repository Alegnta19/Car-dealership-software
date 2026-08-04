/**
 * Server-side identity sessions (FBL-020). The browser holds ONE opaque
 * value in an HttpOnly cookie; the database holds only its SHA-256 digest,
 * so neither a database read nor a log line can ever be replayed as a
 * session. CSRF protection is a keyed HMAC over the session id — the CSRF
 * token is delivered to the page, required on cookie-authenticated unsafe
 * requests, and verified without a database round trip.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { query, withTransaction } from '@dealer/database';

export interface IdentitySession {
  readonly sessionId: string;
  readonly tenantId: string | null;
  readonly userLinkId: string;
  /** The provider connection this session was established through (R1 §C). */
  readonly connectionId: string | null;
  /** R2: the exact issuer, organization and subject this session is bound to. */
  readonly issuer: string | null;
  readonly providerSubject: string | null;
  readonly providerOrganizationId: string | null;
  readonly providerSessionId: string | null;
  readonly authTime: Date;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
}

interface Row {
  [key: string]: unknown;
}

function ts(v: unknown): Date {
  return v instanceof Date ? v : new Date(String(v));
}

function mapSession(r: Row): IdentitySession {
  return {
    sessionId: String(r.session_id),
    tenantId: r.tenant_id === null ? null : String(r.tenant_id),
    userLinkId: String(r.user_link_id),
    connectionId:
      r.connection_id === null || r.connection_id === undefined ? null : String(r.connection_id),
    issuer: r.issuer === null || r.issuer === undefined ? null : String(r.issuer),
    providerSubject:
      r.provider_subject === null || r.provider_subject === undefined
        ? null
        : String(r.provider_subject),
    providerOrganizationId:
      r.provider_organization_id === null || r.provider_organization_id === undefined
        ? null
        : String(r.provider_organization_id),
    providerSessionId: r.provider_session_id === null ? null : String(r.provider_session_id),
    authTime: ts(r.auth_time),
    issuedAt: ts(r.issued_at),
    expiresAt: ts(r.expires_at),
  };
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export interface CreatedSession {
  readonly session: IdentitySession;
  /** The opaque cookie value. Returned ONCE; never stored, never logged. */
  readonly sessionToken: string;
}

export async function createSession(input: {
  tenantId: string | null;
  userLinkId: string;
  providerSessionId: string | null;
  authTime: Date;
  ttlSeconds: number;
  connectionId?: string | null;
  issuer?: string | null;
  providerSubject?: string | null;
  providerOrganizationId?: string | null;
  refreshToken?: string | null;
}): Promise<CreatedSession> {
  const sessionToken = randomBytes(32).toString('base64url');
  const result = await query(
    `INSERT INTO identity_sessions
       (tenant_id, user_link_id, session_token_hash, provider_session_id, auth_time,
        expires_at, connection_id, issuer, provider_subject, provider_organization_id,
        refresh_token_hash)
     VALUES ($1, $2, $3, $4, $5, NOW() + make_interval(secs => $6), $7, $8, $9, $10, $11)
     RETURNING *`,
    [
      input.tenantId,
      input.userLinkId,
      hashSessionToken(sessionToken),
      input.providerSessionId,
      input.authTime,
      input.ttlSeconds,
      input.connectionId ?? null,
      input.issuer ?? null,
      input.providerSubject ?? null,
      input.providerOrganizationId ?? null,
      input.refreshToken === undefined || input.refreshToken === null
        ? null
        : hashSessionToken(input.refreshToken),
    ],
  );
  return { session: mapSession(result.rows[0] as Row), sessionToken };
}

/**
 * Resolves a cookie value to a live session: not expired, not revoked, and
 * belonging to a still-activated user link (deactivation kills sessions at
 * read time, not at the next cleanup). Touches last_seen_at as a side effect.
 */
export async function validateSessionToken(sessionToken: string): Promise<IdentitySession | null> {
  const result = await query(
    `UPDATE identity_sessions s
        SET last_seen_at = NOW()
       FROM user_links ul
      WHERE s.session_token_hash = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > NOW()
        AND ul.user_link_id = s.user_link_id
        AND ul.status = 'activated'
        AND ul.effective_from <= NOW()
        AND (ul.effective_to IS NULL OR ul.effective_to > NOW())
      RETURNING s.*`,
    [hashSessionToken(sessionToken)],
  );
  return result.rows.length > 0 ? mapSession(result.rows[0] as Row) : null;
}

export async function revokeSessionByToken(sessionToken: string, reason: string): Promise<boolean> {
  const result = await query(
    `UPDATE identity_sessions SET revoked_at = NOW(), revoked_reason = $2
      WHERE session_token_hash = $1 AND revoked_at IS NULL`,
    [hashSessionToken(sessionToken), reason],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Revokes every live session of a user link (deactivation, security event). */
export async function revokeSessionsForUserLink(
  userLinkId: string,
  reason: string,
): Promise<number> {
  return withTransaction(async (executor) => {
    const result = await executor.query(
      `UPDATE identity_sessions SET revoked_at = NOW(), revoked_reason = $2
        WHERE user_link_id = $1 AND revoked_at IS NULL AND expires_at > NOW()`,
      [userLinkId, reason],
    );
    return result.rowCount ?? 0;
  });
}

// ── CSRF (double-submit with a keyed derivation) ───────────────────────────

export function csrfTokenForSession(sessionId: string, cookiePassword: string): string {
  return createHmac('sha256', cookiePassword)
    .update('csrf:' + sessionId, 'utf8')
    .digest('base64url');
}

export function verifyCsrfToken(
  sessionId: string,
  cookiePassword: string,
  presented: string | undefined,
): boolean {
  if (presented === undefined || presented.length === 0) return false;
  const expected = Buffer.from(csrfTokenForSession(sessionId, cookiePassword), 'utf8');
  const actual = Buffer.from(presented, 'utf8');
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

// ── FBL-020-R2: provider session refresh with rotating sealed state ────────

export interface RefreshOutcome {
  readonly session: IdentitySession;
  /** The NEW opaque refresh token. Returned once; stored only as a digest. */
  readonly refreshToken: string;
  readonly rotationCount: number;
}

/**
 * Rotates a session's refresh state after a successful provider refresh.
 *
 * The rotation is a conditional UPDATE keyed on the CURRENT digest, so a
 * replayed old refresh token loses the race and changes nothing. The caller
 * must have already re-verified the provider's response; identity mismatch,
 * refresh failure and impersonation are handled by `revokeForIdentityBreach`
 * below, which kills the session immediately rather than degrading it.
 */
export async function rotateSessionRefresh(input: {
  sessionId: string;
  presentedRefreshToken: string;
  newRefreshToken: string;
  authTime: Date;
  ttlSeconds: number;
}): Promise<RefreshOutcome | null> {
  const result = await query(
    `UPDATE identity_sessions
        SET refresh_token_hash = $3,
            refresh_rotation_count = refresh_rotation_count + 1,
            last_refreshed_at = NOW(),
            auth_time = $4,
            expires_at = NOW() + make_interval(secs => $5)
      WHERE session_id = $1
        AND refresh_token_hash = $2
        AND revoked_at IS NULL
        AND expires_at > NOW()
      RETURNING *`,
    [
      input.sessionId,
      hashSessionToken(input.presentedRefreshToken),
      hashSessionToken(input.newRefreshToken),
      input.authTime,
      input.ttlSeconds,
    ],
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0] as Row;
  return {
    session: mapSession(row),
    refreshToken: input.newRefreshToken,
    rotationCount: Number(row.refresh_rotation_count),
  };
}

/**
 * An identity breach during refresh — the provider returned a different
 * subject, organization or issuer, the refresh failed, or an impersonation
 * was detected — revokes the local session immediately. There is no
 * "degraded" state: the session dies.
 */
export async function revokeForIdentityBreach(
  sessionId: string,
  reason: 'identity_mismatch' | 'refresh_failed' | 'impersonation_detected',
): Promise<boolean> {
  const result = await query(
    `UPDATE identity_sessions
        SET revoked_at = NOW(), revoked_reason = $2
      WHERE session_id = $1 AND revoked_at IS NULL`,
    [sessionId, reason],
  );
  return (result.rowCount ?? 0) > 0;
}
