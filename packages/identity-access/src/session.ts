/**
 * Server-side identity sessions (FBL-020). The browser holds ONE opaque
 * value in an HttpOnly cookie; the database holds only its SHA-256 digest,
 * so neither a database read nor a log line can ever be replayed as a
 * session. CSRF protection is a keyed HMAC over the session id — the CSRF
 * token is delivered to the page, required on cookie-authenticated unsafe
 * requests, and verified without a database round trip.
 */
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { query, withTransaction, type Executor } from '@dealer/database';
import { ProviderRefreshError, type ImpersonationClassification } from './contracts';
import type { IdentityProviderPort, ProviderRefreshResult, VerifiedAccessToken } from './contracts';
import { openCookiePayload, sealCookiePayload } from './sealed-cookie';

/**
 * Which credential a local session belongs to. BOTH are locally revocable —
 * that is the entire point of R3's bearer session: a provider access token
 * that is still inside its validity window must stop working the instant the
 * local session behind it is revoked.
 */
export type SessionCredentialKind = 'cookie' | 'bearer';

export interface IdentitySession {
  readonly sessionId: string;
  readonly credentialKind: SessionCredentialKind;
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
  /**
   * FBL-020-R3 correction C1 — when the PROVIDER ACCESS TOKEN this session last
   * obtained stops being valid, or null when the platform never learned it.
   *
   * An instant, never a credential: the token itself is not stored on this path.
   * It is the fact `isProviderRefreshDue` reads, which is what gives the sealed
   * refresh state a runtime spender instead of leaving it at rest unused.
   */
  readonly providerAccessTokenExpiresAt: Date | null;
  /**
   * Whether this session holds sealed refresh state — i.e. whether a provider
   * refresh could even be attempted. The ciphertext itself never leaves the
   * database row; only this boolean does.
   */
  readonly refreshable: boolean;
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
    credentialKind: String(r.credential_kind) as SessionCredentialKind,
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
    providerAccessTokenExpiresAt:
      r.provider_access_token_expires_at === null ||
      r.provider_access_token_expires_at === undefined
        ? null
        : ts(r.provider_access_token_expires_at),
    refreshable: typeof r.refresh_state_sealed === 'string' && r.refresh_state_sealed.length > 0,
  };
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * `audit_events.tenant_id` is NOT NULL; a PLATFORM-scope session is recorded
 * under the nil tenant so the row is still written transactionally.
 */
const NIL_TENANT = '00000000-0000-0000-0000-000000000000';

/**
 * FBL-020-R4 section 3 — the ONE audit writer for SESSION LIFECYCLE transitions.
 *
 * R3 audited user-link and role mutations and support access, and audited the
 * session lifecycle nowhere: establishment, refresh, credential rotation, logout
 * and revocation left no `audit_events` row at all. The session is the credential
 * — an operator asking "when did this person's access start and stop" had only
 * the mutable session row itself, which revocation overwrites.
 *
 * It always runs on the CALLER'S EXECUTOR, so the event commits with the state
 * change it describes or neither happens. Details carry identifiers, reasons and
 * counts only: never a session token, a refresh token, sealed state or a digest
 * of any of them.
 */
async function auditSession(
  executor: Executor,
  input: {
    sessionId: string;
    tenantId: string | null;
    userLinkId: string | null;
    eventType: string;
    /**
     * The TRUE actor. A person's own session establishment and logout are
     * theirs; a platform-initiated revocation names NOBODY rather than
     * attributing a machine decision to a human who did not make it.
     */
    actorUserLinkId: string | null;
    details: Record<string, unknown>;
  },
): Promise<void> {
  await executor.query(
    `INSERT INTO audit_events
       (tenant_id, event_type, entity_type, entity_id, actor_user_id, details)
     VALUES ($1, $2, 'identity_session', $3, $4, $5)`,
    [
      input.tenantId ?? NIL_TENANT,
      input.eventType,
      input.sessionId,
      input.actorUserLinkId,
      JSON.stringify(input.details),
    ],
  );
}

/**
 * The audit rows a batch of just-revoked sessions owes, written on the same
 * executor as the UPDATE that revoked them.
 *
 * `logout` is separated from every other reason deliberately: they are different
 * transitions in the audit inventory, and an operator reading "this person left"
 * must not have to distinguish it from "the platform threw them out" by parsing
 * a reason string.
 */
async function auditRevocations(
  executor: Executor,
  rows: readonly Row[],
  reason: string,
  actorUserLinkId: string | null,
): Promise<void> {
  for (const row of rows) {
    await auditSession(executor, {
      sessionId: String(row.session_id),
      tenantId: row.tenant_id === null ? null : String(row.tenant_id),
      userLinkId: row.user_link_id === null ? null : String(row.user_link_id),
      eventType: reason === 'logout' ? 'identity.session.logged_out' : 'identity.session.revoked',
      actorUserLinkId,
      details: {
        reason,
        credential_kind: String(row.credential_kind),
        authorization_version: Number(row.authorization_version),
      },
    });
  }
}

export interface CreatedSession {
  readonly session: IdentitySession;
  /** The opaque cookie value. Returned ONCE; never stored, never logged. */
  readonly sessionToken: string;
}

export interface CreateSessionInput {
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
  /**
   * FBL-020-R3: supplying it SEALS the refresh token so a later refresh can
   * actually present it. Without it only the replay digest is stored and the
   * session is simply not refreshable — never a silent half-state.
   *
   * `| undefined` on this and the next property is explicit because the strict
   * configuration sets `exactOptionalPropertyTypes`: the login path forwards both
   * straight from its own optional custody settings, and under that rule "absent"
   * and "present and undefined" are different types. Widening here keeps the
   * forwarding honest instead of making the caller rebuild the object key by key.
   */
  cookiePassword?: string | undefined;
  refreshStateKeyVersion?: number | undefined;
  /**
   * R3 correction C1: the `exp` of the provider access token this login just
   * proved. Recorded so the request path can tell when the provider credential
   * behind the session is at or near expiry; omitted, no refresh is scheduled.
   */
  providerAccessTokenExpiresAt?: Date | null;
}

/**
 * Creates a session in its OWN transaction. Callers that must decide something
 * else in the same breath — login admission does, and R5 §1.3 requires it to —
 * use `createSessionWithin` on their executor instead.
 */
export async function createSession(input: CreateSessionInput): Promise<CreatedSession> {
  return withTransaction((executor) => createSessionWithin(executor, input));
}

/**
 * FBL-020-R5 §1.3 — SESSION ESTABLISHMENT AND CREDENTIAL CUSTODY ON THE CALLER'S
 * EXECUTOR.
 *
 * Taking the provider refresh credential into custody IS this statement: the
 * sealed state and its replay digest are columns of the row being inserted. So
 * "admission and custody are one decision" is achievable only if the admission
 * and this INSERT share a transaction — which is what `admitLoginAndEstablishSession`
 * now does, and what R4's commit-then-insert shape could not.
 */
export async function createSessionWithin(
  executor: Executor,
  input: CreateSessionInput,
): Promise<CreatedSession> {
  const sessionToken = randomBytes(32).toString('base64url');
  const refreshToken =
    input.refreshToken === undefined || input.refreshToken === null ? null : input.refreshToken;
  const sealed =
    refreshToken === null || input.cookiePassword === undefined
      ? null
      : sealRefreshState(refreshToken, input.cookiePassword);
  const result = await executor.query(
    `INSERT INTO identity_sessions
       (tenant_id, user_link_id, credential_kind, session_token_hash, provider_session_id,
        auth_time, expires_at, connection_id, issuer, provider_subject, provider_organization_id,
        refresh_token_hash, refresh_state_sealed, refresh_state_key_version,
        provider_access_token_expires_at)
     VALUES ($1, $2, 'cookie', $3, $4, $5, NOW() + make_interval(secs => $6),
             $7, $8, $9, $10, $11, $12, $13, $14)
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
      refreshToken === null ? null : hashSessionToken(refreshToken),
      sealed,
      sealed === null ? null : (input.refreshStateKeyVersion ?? REFRESH_STATE_KEY_VERSION),
      input.providerAccessTokenExpiresAt ?? null,
    ],
  );
  const session = mapSession(result.rows[0] as Row);
  await auditSession(executor, {
    sessionId: session.sessionId,
    tenantId: session.tenantId,
    userLinkId: session.userLinkId,
    eventType: 'identity.session.established',
    // A login establishes the person's OWN session, so the true actor is that
    // person. Nothing else performed it.
    actorUserLinkId: session.userLinkId,
    details: {
      credential_kind: session.credentialKind,
      refreshable: session.refreshable,
      expires_at: session.expiresAt.toISOString(),
    },
  });
  return { session, sessionToken };
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

/**
 * WHICH sessions a revocation is aimed at. A CLOSED set — there is no free-text
 * predicate — so `revokeSessionsWithin` below can own the whole statement and a
 * caller can choose only the target, never the shape of the write.
 */
type RevocationTarget =
  /** The cookie the browser presented, already digested. */
  | { readonly by: 'session_token_hash'; readonly value: string }
  /** One local session, whatever credential it belongs to. */
  | { readonly by: 'session_id'; readonly value: string }
  /** Every LIVE session of one user link (deactivation, security event). */
  | { readonly by: 'user_link_id'; readonly value: string };

const REVOCATION_TARGET_SQL: Record<RevocationTarget['by'], string> = {
  session_token_hash: 'session_token_hash = $1',
  session_id: 'session_id = $1::uuid',
  // A sweep touches LIVE sessions only; an already-expired row has nothing left
  // to take away and re-stamping it would rewrite history.
  user_link_id: 'user_link_id = $1::uuid AND expires_at > NOW()',
};

/**
 * FBL-020-R5 §1.1 — THE ONE STATEMENT THAT REVOKES A SESSION.
 *
 * ── the defect this replaces ────────────────────────────────────────────────
 *
 * R3 put the clearing clause in a shared constant and interpolated it into FOUR
 * hand-written UPDATEs, and its own comment claimed "every revocation path clears
 * the sealed state … in the SAME statement that sets revoked_at". Three did. The
 * fourth — `revokeSessionByToken`, the COOKIE LOGOUT path — did not, and nothing
 * could notice: the constant existed, so the omission looked like the absence of a
 * line rather than the presence of a defect.
 *
 * The consequence was not a cosmetic inconsistency. `/auth/callback` always stores
 * refresh state, so logging out of any callback-created cookie session tried to
 * write a revoked row still holding `refresh_token_hash` and `refresh_state_sealed`
 * — which migration 057's `is_revoked_holds_no_refresh_state` refuses. The CHECK
 * aborted the statement, `withTransaction` rolled the whole thing back, and the
 * session the person had just logged out of REMAINED LIVE AND USABLE.
 *
 * MEASURED, not inferred: with the R4 code restored, `POST /auth/logout` answered
 * 500 `internal_error` (SQLSTATE 23514), the row kept `revoked_at IS NULL`, its
 * sealed refresh state and its original `authorization_version`, and the same
 * cookie still returned 200 from `/api/service/home` afterwards. So the caller was
 * not told "logged out" — it was told nothing useful, and was still logged in.
 *
 * ── why this shape ─────────────────────────────────────────────────────────
 *
 * A shared clause that a caller must remember to interpolate is a convention. This
 * is a single function that owns the entire statement: the SET list is written
 * once, here, and callers supply only a target from the closed set above. Adding a
 * fifth revocation entry point cannot produce a fifth SET list, because there is
 * nowhere to put one — the only way to revoke is to call this. That is the
 * difference between "kept in step by hand" and structurally unforgettable, and
 * `tests/identity-revocation.test.ts` pins it from the other side: across every
 * `.ts` source under `apps/` and `packages/`, exactly ONE template literal may both
 * `UPDATE identity_sessions` and assign `revoked_at`, and that one must carry all
 * five clearing assignments. A lexical guard over the SQL this codebase writes, not
 * a proof about SQL it could conceivably write some other way.
 *
 * WHAT COMMITS TOGETHER, on the caller's executor: the revocation, the destruction
 * of the provider refresh credential and its replay digest and lease, and the
 * authorization-version advance are ONE statement; the audit row each revoked
 * session owes is a second statement on the same executor. So a constraint that
 * refuses any part of the revocation refuses all of it, and a revocation performed
 * through this function cannot leave a revoked row holding a live refresh
 * credential — whether the audit row and the revocation also commit together is the
 * caller's transaction to own, and every entry point below opens one.
 */
async function revokeSessionsWithin(
  executor: Executor,
  target: RevocationTarget,
  reason: string,
  actingUserLinkId: string | null,
): Promise<Row[]> {
  const result = await executor.query(
    `UPDATE identity_sessions
        SET revoked_at = NOW(),
            revoked_reason = $2,
            revoked_by_user_link_id = COALESCE($3::uuid, revoked_by_user_link_id),
            -- R4 section 3: a revocation CHANGES what this credential authorizes,
            -- so the version advances. A revocation invisible to the version would
            -- leave cached authorization believing it is current.
            authorization_version = authorization_version + 1,
            updated_at = NOW(),
            -- REVOCATION DESTROYS THE PROVIDER CREDENTIAL, it does not merely stop
            -- honouring it. Migration 057's is_revoked_holds_no_refresh_state makes
            -- the alternative unrepresentable, and the lease CHECKs make a claim on
            -- destroyed state unrepresentable with it. The audit fields (revoked_at,
            -- revoked_reason, revoked_by_user_link_id) are what survives.
            refresh_token_hash = NULL,
            refresh_state_sealed = NULL,
            refresh_state_key_version = NULL,
            refresh_lease_id = NULL,
            refresh_lease_expires_at = NULL
      WHERE ${REVOCATION_TARGET_SQL[target.by]} AND revoked_at IS NULL
      RETURNING session_id, tenant_id, user_link_id, credential_kind, authorization_version`,
    [target.value, reason, actingUserLinkId],
  );
  const rows = result.rows as Row[];
  // A LOGOUT is the session owner's own act, so when no acting link was named the
  // actor falls back to the link the revoked rows name rather than to nobody. Every
  // target above revokes rows of a single user link, so `rows[0]` names it for all
  // of them. A platform-initiated revocation keeps `null`: attributing a machine
  // decision to the person it was taken against would put a claim in the trail that
  // nobody made.
  const actor =
    actingUserLinkId ??
    (reason === 'logout' && rows.length > 0 ? String(rows[0]!.user_link_id) : null);
  await auditRevocations(executor, rows, reason, actor);
  return rows;
}

export async function revokeSessionByToken(
  sessionToken: string,
  reason: string,
  /** The person performing it, when a person did. Logout is their own act. */
  actingUserLinkId?: string | null,
): Promise<boolean> {
  return withTransaction(
    async (executor) =>
      (
        await revokeSessionsWithin(
          executor,
          { by: 'session_token_hash', value: hashSessionToken(sessionToken) },
          reason,
          actingUserLinkId ?? null,
        )
      ).length > 0,
  );
}

/** Revokes every live session of a user link (deactivation, security event). */
export async function revokeSessionsForUserLink(
  userLinkId: string,
  reason: string,
  /** The administrator performing the sweep, when one did. */
  actingUserLinkId?: string | null,
): Promise<number> {
  return withTransaction(
    async (executor) =>
      (
        await revokeSessionsWithin(
          executor,
          { by: 'user_link_id', value: userLinkId },
          reason,
          actingUserLinkId ?? null,
        )
      ).length,
  );
}

/**
 * Revokes ONE local session by its id, whatever credential it belongs to.
 * Used by logout on the bearer path, where there is no cookie to hash.
 */
export async function revokeSessionById(
  sessionId: string,
  reason: string,
  actingUserLinkId?: string | null,
): Promise<boolean> {
  return withTransaction(
    async (executor) =>
      (
        await revokeSessionsWithin(
          executor,
          { by: 'session_id', value: sessionId },
          reason,
          actingUserLinkId ?? null,
        )
      ).length > 0,
  );
}

// ── FBL-020-R3: the SIX identity facts, revalidated on every request ───────

/**
 * The join every accepted request must survive, expressed once.
 *
 * A local session is only as alive as the identity behind it. Every fact is
 * re-read from the database — never believed from a token — and every one of
 * them is checked inside its EFFECTIVE WINDOW, so disabling, expiring or
 * re-homing any link in the chain denies the very next request:
 *
 *   1. tenant        — active and effective (platform scope has none)
 *   2. connection    — active, effective, and still the session's connection
 *   3. issuer        — the connection's, the link's, the session's and the
 *                      CONFIGURED one must all be the same string
 *   4. organization  — the connection's and the link's must equal the
 *                      session's provider organization
 *   5. UserLink      — activated, effective, tenant-coherent, and carrying the
 *                      session's provider subject
 *   6. local session — not revoked, not expired
 *
 * `s` is the identity_sessions alias; `$1` is the configured issuer.
 */
const IDENTITY_REVALIDATION_SQL = `
        ul.user_link_id = s.user_link_id
    AND ul.status = 'activated'
    AND ul.effective_from <= NOW()
    AND (ul.effective_to IS NULL OR ul.effective_to > NOW())
    AND ul.tenant_id IS NOT DISTINCT FROM s.tenant_id
    AND ul.provider_user_id = s.provider_subject
    AND ul.connection_id = s.connection_id
    AND ul.issuer = s.issuer
    AND ul.provider_organization_id = s.provider_organization_id
    AND c.connection_id = s.connection_id
    AND c.status = 'active'
    AND c.effective_from <= NOW()
    AND (c.effective_to IS NULL OR c.effective_to > NOW())
    AND c.issuer = s.issuer
    AND c.provider_organization_id = s.provider_organization_id
    AND c.tenant_id IS NOT DISTINCT FROM s.tenant_id
    AND s.revoked_at IS NULL
    AND s.expires_at > NOW()
    AND s.issuer = $1
    AND (
      s.tenant_id IS NULL
      OR EXISTS (
        SELECT 1 FROM tenants t
         WHERE t.tenant_id = s.tenant_id
           AND t.status = 'active'
           AND t.effective_from <= NOW()
           AND (t.effective_to IS NULL OR t.effective_to > NOW())
      )
    )`;

/**
 * Re-reads a live session and revalidates the whole identity chain behind it.
 * Returns null the moment ANY of the six facts stops holding — which is what
 * makes an administrative change deny the next request rather than the next
 * login.
 */
export async function revalidateSessionIdentity(input: {
  sessionId: string;
  expectedIssuer: string;
}): Promise<IdentitySession | null> {
  const result = await query(
    `SELECT s.* FROM identity_sessions s, user_links ul, identity_provider_connections c
      WHERE s.session_id = $2 AND ${IDENTITY_REVALIDATION_SQL}`,
    [input.expectedIssuer, input.sessionId],
  );
  return result.rows.length > 0 ? mapSession(result.rows[0] as Row) : null;
}

// ── FBL-020-R3: locally revocable BEARER sessions ──────────────────────────

/**
 * How long a bearer session lives before the caller must authenticate with the
 * provider again. It is NOT slid forward on use: a local session that could
 * never expire would make "expired" unreachable, and the bound is the point.
 */
export const DEFAULT_BEARER_SESSION_TTL_SECONDS = 8 * 3600;

/** The seven facts a bearer session is keyed by. All of them, every time. */
export interface BearerSessionIdentity {
  readonly issuer: string;
  /** The provider's own session identifier (`sid`). A new login ⇒ a new one. */
  readonly providerSessionId: string;
  readonly providerOrganizationId: string;
  readonly providerSubject: string;
  readonly tenantId: string | null;
  readonly userLinkId: string;
  readonly connectionId: string;
}

export interface ResolveBearerSessionInput extends BearerSessionIdentity {
  /** The verified token's auth_time — recorded, never invented. */
  readonly authTime: Date;
  /** The CONFIGURED issuer. Must equal the session's own issuer. */
  readonly expectedIssuer: string;
  readonly ttlSeconds?: number;
}

/**
 * Why a bearer credential was refused. `revoked` is the one that matters most:
 * it is what a local logout produces, and it must beat a provider token that
 * is still perfectly valid.
 */
export type BearerSessionRefusal =
  'revoked' | 'expired' | 'issuer_mismatch' | 'identity_not_effective';

export type BearerSessionOutcome =
  | { readonly outcome: 'live'; readonly session: IdentitySession; readonly established: boolean }
  | { readonly outcome: 'refused'; readonly reason: BearerSessionRefusal };

/**
 * The lookup key for a bearer session: SHA-256 over a domain-separated,
 * LENGTH-PREFIXED join of the seven facts. Length prefixing is not decoration —
 * a plain delimiter join lets two different fact tuples collide by moving a
 * separator into a value, which would let one identity resolve another's
 * session.
 *
 * This is an INDEX KEY, never a credential. It is derived from identifiers the
 * server already holds, it is never sent anywhere, and the schema keeps it in a
 * different column from `session_token_hash` so it can never be presented as a
 * cookie.
 */
function bearerSessionKey(identity: BearerSessionIdentity): string {
  const parts = [
    'dealer.bearer-session.v1',
    identity.issuer,
    identity.providerSessionId,
    identity.providerOrganizationId,
    identity.providerSubject,
    identity.tenantId ?? '',
    identity.userLinkId,
    identity.connectionId,
  ];
  const digest = createHash('sha256');
  for (const part of parts) {
    digest.update(`${Buffer.byteLength(part, 'utf8')}:`, 'utf8');
    digest.update(part, 'utf8');
  }
  return digest.digest('hex');
}

/** The seven facts, in the order the resolve/establish statements bind them. */
function bearerParams(input: ResolveBearerSessionInput): unknown[] {
  return [
    input.expectedIssuer, // $1 — consumed by IDENTITY_REVALIDATION_SQL
    bearerSessionKey(input), // $2
    input.tenantId, // $3
    input.userLinkId, // $4
    input.connectionId, // $5
    input.providerOrganizationId, // $6
    input.providerSubject, // $7
    input.providerSessionId, // $8
  ];
}

/**
 * FBL-020-R3 — the BEARER credential's local, revocable session.
 *
 * Before this, a bearer request verified a provider token, resolved a link and
 * proceeded: there was no local object behind the credential, so a local logout
 * could not deny an access token that was still inside its validity window. The
 * provider was the only authority on "is this caller still logged in", which is
 * exactly the authority this platform must keep for itself.
 *
 * On a verified bearer with no local session, ONE is established — but only if
 * the identity chain currently holds (the INSERT carries the same six-fact
 * guard the resolve does, so a session can never come into existence for an
 * identity that is not effective right now). On every subsequent request the
 * session is RESOLVED and revalidated, and a revoked or expired one refuses.
 *
 * A revoked bearer session stays in the way of the credential that produced it
 * for good: the unique key includes the provider `sid`, so the only way back in
 * is a genuinely new provider authentication.
 */
export async function resolveOrEstablishBearerSession(
  input: ResolveBearerSessionInput,
): Promise<BearerSessionOutcome> {
  // The connection's issuer and the CONFIGURED issuer are two separate facts,
  // and a session may only exist where they are the same string. Checked here
  // rather than left implicit in a join, so the refusal is nameable.
  if (input.issuer !== input.expectedIssuer) {
    return { outcome: 'refused', reason: 'issuer_mismatch' };
  }
  const params = bearerParams(input);
  const resolved = await resolveBearerSession(params);
  if (resolved !== null) return { outcome: 'live', session: resolved, established: false };

  const refusal = await classifyMissingBearerSession(params[1] as string);
  if (refusal !== null) return { outcome: 'refused', reason: refusal };

  const established = await establishBearerSession(input, params);
  if (established !== null) return { outcome: 'live', session: established, established: true };

  // Either the establishment guard refused the identity, or a concurrent
  // request won the unique key. One bounded re-resolve tells the two apart.
  const afterRace = await resolveBearerSession(params);
  if (afterRace !== null) return { outcome: 'live', session: afterRace, established: false };
  const raced = await classifyMissingBearerSession(params[1] as string);
  return { outcome: 'refused', reason: raced ?? 'identity_not_effective' };
}

async function resolveBearerSession(params: unknown[]): Promise<IdentitySession | null> {
  const result = await query(
    `UPDATE identity_sessions s
        SET last_seen_at = NOW()
       FROM user_links ul, identity_provider_connections c
      WHERE s.bearer_key_hash = $2
        AND s.credential_kind = 'bearer'
        AND s.tenant_id IS NOT DISTINCT FROM $3::uuid
        AND s.user_link_id = $4::uuid
        AND s.connection_id = $5::uuid
        AND s.provider_organization_id = $6
        AND s.provider_subject = $7
        AND s.provider_session_id = $8
        AND ${IDENTITY_REVALIDATION_SQL}
      RETURNING s.*`,
    params,
  );
  return result.rows.length > 0 ? mapSession(result.rows[0] as Row) : null;
}

/**
 * A bearer session exists for this key but did not resolve. Says WHY, so a
 * local logout is never silently re-established as a fresh session.
 */
async function classifyMissingBearerSession(key: string): Promise<BearerSessionRefusal | null> {
  const result = await query(
    `SELECT revoked_at, expires_at FROM identity_sessions
      WHERE bearer_key_hash = $1 AND credential_kind = 'bearer'`,
    [key],
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0] as Row;
  if (row.revoked_at !== null && row.revoked_at !== undefined) return 'revoked';
  if (ts(row.expires_at).getTime() <= Date.now()) return 'expired';
  return 'identity_not_effective';
}

async function establishBearerSession(
  input: ResolveBearerSessionInput,
  params: unknown[],
): Promise<IdentitySession | null> {
  return withTransaction(async (executor) => {
    const result = await executor.query(
      `INSERT INTO identity_sessions
       (tenant_id, user_link_id, credential_kind, bearer_key_hash, session_token_hash,
        provider_session_id, auth_time, expires_at, connection_id, issuer,
        provider_subject, provider_organization_id)
     SELECT $3::uuid, $4::uuid, 'bearer', $2, NULL,
            $8, $9, NOW() + make_interval(secs => $10), $5::uuid, $1,
            $7, $6
      WHERE EXISTS (
        SELECT 1
          FROM user_links ul
          JOIN identity_provider_connections c ON c.connection_id = ul.connection_id
         WHERE ul.user_link_id = $4::uuid
           AND ul.status = 'activated'
           AND ul.effective_from <= NOW()
           AND (ul.effective_to IS NULL OR ul.effective_to > NOW())
           AND ul.tenant_id IS NOT DISTINCT FROM $3::uuid
           AND ul.provider_user_id = $7
           AND ul.connection_id = $5::uuid
           AND ul.issuer = $1
           AND ul.provider_organization_id = $6
           AND c.status = 'active'
           AND c.effective_from <= NOW()
           AND (c.effective_to IS NULL OR c.effective_to > NOW())
           AND c.issuer = $1
           AND c.provider_organization_id = $6
           AND c.tenant_id IS NOT DISTINCT FROM $3::uuid
           AND (
             $3::uuid IS NULL
             OR EXISTS (
               SELECT 1 FROM tenants t
                WHERE t.tenant_id = $3::uuid
                  AND t.status = 'active'
                  AND t.effective_from <= NOW()
                  AND (t.effective_to IS NULL OR t.effective_to > NOW())
             )
           )
      )
     ON CONFLICT (bearer_key_hash) WHERE bearer_key_hash IS NOT NULL DO NOTHING
     RETURNING *`,
      [...params, input.authTime, input.ttlSeconds ?? DEFAULT_BEARER_SESSION_TTL_SECONDS],
    );
    if (result.rows.length === 0) return null;
    const session = mapSession(result.rows[0] as Row);
    // The BEARER establishment is the same audited transition as a cookie login:
    // a locally revocable session came into existence, and the trail says so.
    await auditSession(executor, {
      sessionId: session.sessionId,
      tenantId: session.tenantId,
      userLinkId: session.userLinkId,
      eventType: 'identity.session.established',
      actorUserLinkId: session.userLinkId,
      details: {
        credential_kind: session.credentialKind,
        refreshable: session.refreshable,
        expires_at: session.expiresAt.toISOString(),
      },
    });
    return session;
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

// ── FBL-020-R3: REAL provider session refresh over sealed, rotating state ──

/**
 * The key version the current build seals with. It is stored beside the
 * ciphertext so rotating the cookie password produces a provably unopenable
 * state ("cannot refresh") instead of an indistinguishable decryption failure.
 */
export const REFRESH_STATE_KEY_VERSION = 1;

/**
 * How old sealed refresh state may be before it is treated as unusable. This
 * is a sanity bound on the ciphertext, not the security boundary — the
 * session row's own revoked_at/expires_at decide whether a session lives.
 */
const DEFAULT_REFRESH_STATE_MAX_AGE_SECONDS = 30 * 24 * 3600;

function sealRefreshState(refreshToken: string, cookiePassword: string): string {
  return sealCookiePayload({ refresh_token: refreshToken }, cookiePassword);
}

function openRefreshState(
  sealed: string,
  cookiePassword: string,
  maxAgeSeconds: number,
): string | null {
  const opened = openCookiePayload(sealed, cookiePassword, { maxAgeSeconds });
  if (opened === null) return null;
  const token = opened.refresh_token;
  return typeof token === 'string' && token.length > 0 ? token : null;
}

/**
 * FBL-020-R5 §1.8 — WHY THERE IS NO EXPORTED `rotateSessionRefresh` ANY MORE.
 *
 * The clause is a disjunction: access-token verification is REQUIRED at every
 * exported refresh/rotation boundary, or the unsafe lower-level primitives are
 * PRIVATE. Both limbs are taken here, each where it belongs.
 *
 * `rotateSessionRefresh` was the second limb's subject. It was an EXPORTED
 * rotation boundary that, by its own doc comment, "performs no provider call and
 * makes no trust decision": hand it a session id, the digest-matching refresh
 * token and any replacement, and it wrote that replacement into the session's
 * refresh state — no provider exchange, no token verification, no identity
 * re-check. Its safety rested entirely on nothing outside this package ever
 * calling it, which is a convention, not a boundary. It is now the module-private
 * `rotateRefreshStateRow` below, reachable ONLY from `persistRefreshedState`,
 * which reaches it only after a verified access token has been judged.
 *
 * The first limb is taken on `RefreshProviderSessionInput.verifyAccessToken`,
 * which is no longer optional — see the comment there.
 *
 * `tests/identity-boundary.test.ts` pins both from the source side:
 * "the exported refresh surface cannot be driven without access-token verification".
 */
async function rotateRefreshStateRow(
  executor: Executor,
  input: {
    sessionId: string;
    presentedRefreshToken: string;
    newRefreshToken: string;
    authTime: Date;
    ttlSeconds: number;
    cookiePassword?: string;
    refreshStateKeyVersion?: number;
    providerAccessTokenExpiresAt?: Date | null;
    /**
     * R3 correction D1: the LEASE this rotation is the completion of. Supplied,
     * the write additionally requires that the lease is still the claimant's, so
     * an attempt whose claim expired and was reclaimed by someone else cannot
     * land its replacement over the newer attempt's. Omitted (the standalone
     * an exported rotation primitive), the digest predicate alone decides.
     */
    expectedLeaseId?: string;
  },
): Promise<Row | null> {
  const sealed =
    input.cookiePassword === undefined
      ? null
      : sealRefreshState(input.newRefreshToken, input.cookiePassword);
  const result = await executor.query(
    `UPDATE identity_sessions
        SET refresh_token_hash = $3,
            refresh_state_sealed = $6,
            refresh_state_key_version = $7,
            refresh_rotation_count = refresh_rotation_count + 1,
            last_refreshed_at = NOW(),
            auth_time = $4,
            -- FBL-020-R4 section 3: the provider session id is NOT rewritten.
            -- R3 wrote COALESCE($8, provider_session_id), so whatever sid the
            -- refresh reply happened to carry silently REPLACED the one the
            -- session was established with — and since nothing compared them, a
            -- reply describing a different provider session was simply adopted.
            -- The identity check now requires equality, so there is nothing left
            -- to overwrite; the column is left exactly as it is.
            provider_access_token_expires_at = $8,
            -- …and the LOCAL expiry never slides LATER than the value this
            -- session was issued with. A refresh renews the PROVIDER credential;
            -- it is not an authentication event and it may not extend the
            -- person's local session. R3 wrote NOW() + ttl unconditionally, so
            -- any caller passing a full TTL — and the standalone primitive does —
            -- re-armed the local bound and made "expired" unreachable for a
            -- client that kept polling. LEAST() makes the original the ceiling.
            expires_at = LEAST(expires_at, NOW() + make_interval(secs => $5)),
            -- the attempt is over: its claim is released in the SAME statement
            -- that persists its result, so a completed refresh never leaves a
            -- lease behind for the expiry to have to clean up
            refresh_lease_id = NULL,
            refresh_lease_expires_at = NULL,
            updated_at = NOW()
      WHERE session_id = $1
        AND refresh_token_hash = $2
        AND revoked_at IS NULL
        AND expires_at > NOW()
        AND ($9::uuid IS NULL OR refresh_lease_id = $9::uuid)
      RETURNING *`,
    [
      input.sessionId,
      hashSessionToken(input.presentedRefreshToken),
      hashSessionToken(input.newRefreshToken),
      input.authTime,
      input.ttlSeconds,
      sealed,
      sealed === null ? null : (input.refreshStateKeyVersion ?? REFRESH_STATE_KEY_VERSION),
      input.providerAccessTokenExpiresAt ?? null,
      input.expectedLeaseId ?? null,
    ],
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0] as Row;
  // The CREDENTIAL ROTATION is its own audited transition: the refresh token
  // this session holds has been replaced, which is a fact about a long-lived
  // credential and belongs in the trail with its rotation count.
  await auditSession(executor, {
    sessionId: String(row.session_id),
    tenantId: row.tenant_id === null ? null : String(row.tenant_id),
    userLinkId: String(row.user_link_id),
    eventType: 'identity.session.refresh_state_rotated',
    actorUserLinkId: null,
    details: {
      rotation_count: Number(row.refresh_rotation_count),
      credential_kind: String(row.credential_kind),
      authorization_version: Number(row.authorization_version),
    },
  });
  return row;
}

/** Why a refresh killed the session. Each is a security fact, not a hiccup. */
export type IdentityBreachReason =
  'identity_mismatch' | 'refresh_failed' | 'impersonation_detected' | 'refresh_replay_detected';

/**
 * An identity breach during refresh — the provider returned a different
 * subject, organization or issuer, the refresh was definitively refused, an
 * impersonation was detected, or an already-rotated refresh state was
 * re-presented — revokes the local session immediately. There is no
 * "degraded" state: the session dies, and its refresh credential with it.
 */
export async function revokeForIdentityBreach(
  sessionId: string,
  reason: IdentityBreachReason,
): Promise<boolean> {
  // R5 §1.1: its OWN transaction. R3 ran this entry point on the bare pool, so the
  // revocation and the audit row it owes were two independent implicit
  // transactions and a failure between them left a destroyed session with no trail.
  return withTransaction((executor) => revokeWithin(executor, sessionId, reason));
}

/**
 * A breach revocation on the CALLER'S executor, for the refresh paths that are
 * already inside a transaction and must commit the revocation with whatever else
 * they decided. The actor is deliberately null: a breach revocation is the
 * PLATFORM's act, and attributing it to the person whose session was just destroyed
 * would put a decision in the trail that they did not make.
 */
async function revokeWithin(
  executor: Executor,
  sessionId: string,
  reason: IdentityBreachReason,
): Promise<boolean> {
  const rows = await revokeSessionsWithin(
    executor,
    { by: 'session_id', value: sessionId },
    reason,
    null,
  );
  return rows.length > 0;
}

/**
 * The outcome of a real refresh. Deliberately distinguishable shapes —
 * collapsing "the provider said no" into "the provider did not answer" is what
 * turns a network blip into a fleet-wide logout.
 */
export type RefreshSessionOutcome =
  | {
      readonly outcome: 'refreshed';
      readonly session: IdentitySession;
      readonly rotationCount: number;
    }
  | { readonly outcome: 'revoked'; readonly reason: IdentityBreachReason }
  | { readonly outcome: 'transient' }
  | {
      readonly outcome: 'unavailable';
      readonly reason:
        'no_live_session' | 'no_refresh_state' | 'key_version_mismatch' | 'sealed_state_unreadable';
    }
  /**
   * R3 correction C1: the LOCKED row says a refresh is not due — reachable only
   * when the caller asked for a due-gated refresh. It is what a request discovers
   * after a concurrent request has already refreshed: the session is carried back
   * so the loser proceeds on the CURRENT row rather than spending a second refresh
   * token for the same session.
   */
  | { readonly outcome: 'not_due'; readonly session: IdentitySession }
  /**
   * R3 correction D1: ANOTHER attempt owns this session's refresh right now — it
   * holds an unexpired lease. Distinct from `not_due` (where there is nothing to
   * do at all) because the reason is different, but the request must do exactly
   * the same thing about it: spend NOTHING and proceed on the current row. This
   * is what enforces single-spend now that the provider call no longer happens
   * under a row lock.
   */
  | { readonly outcome: 'refresh_in_flight'; readonly session: IdentitySession };

export interface RefreshProviderSessionInput {
  readonly sessionId: string;
  /** Only `refreshSession` is used; a fake port is a first-class caller. */
  readonly provider: Pick<IdentityProviderPort, 'refreshSession'>;
  /** The AES-256-GCM key material for the sealed state (config, not database). */
  readonly cookiePassword: string;
  /** The configured issuer. The session's issuer must still equal it. */
  readonly expectedIssuer: string;
  readonly ttlSeconds: number;
  readonly keyVersion?: number;
  readonly refreshStateMaxAgeSeconds?: number;
  /**
   * FBL-020-R5 §1.8 — MANDATORY standards-based verification of the NEW access
   * token. It is authoritative: a verification failure revokes, an impersonated
   * token revokes, the verified subject/organization/provider-session must equal
   * the ones the session was established with, and a genuinely newer auth_time is
   * the ONLY thing that may move auth_time forward.
   *
   * It used to be OPTIONAL, and an absence test around the call below
   * simply skipped the whole judgement when it was absent. That made this — an
   * EXPORTED refresh boundary, re-exported wholesale by the package index — a
   * surface on which a caller could take a brand-new provider access token into
   * custody and schedule the session's future on its `exp` without ever proving
   * the token was issued by the trusted issuer, was for this audience, or named
   * this identity. "Every caller happens to pass one" is not a boundary; a
   * required property is.
   */
  readonly verifyAccessToken: (accessToken: string) => Promise<VerifiedAccessToken>;
  /**
   * R3 correction C1 — DUE-GATE the exchange on the LOCKED row.
   *
   * Supplied, the refresh proceeds only while the row's own
   * `provider_access_token_expires_at` is within this many seconds of now (an
   * unknown expiry is never due). It closes the concurrency hole the request
   * path would otherwise open: several simultaneous requests all judge dueness
   * from their own pre-claim read, and every one of them would spend another
   * single-use refresh token for a session another request had just refreshed.
   * Re-judging inside the CLAIM transaction makes the losers no-ops (and the
   * lease makes the losers of a still-in-flight attempt no-ops too).
   *
   * Omitted, dueness is not a concept and the caller's request to refresh is
   * simply performed — which is what the primitive's own tests exercise.
   */
  readonly refreshDueLeewaySeconds?: number;
  /**
   * R3 correction D1 — the HARD BOUND on the provider exchange, in milliseconds.
   *
   * The exchange happens on the live request path, so it must be bounded here as
   * well as inside the adapter: the port is provider-NEUTRAL, and this operation
   * cannot assume that whatever implements it ever returns. Expiry is TRANSIENT —
   * a bound that elapsed says the provider did not answer, and that is not
   * evidence that the session was revoked.
   */
  readonly providerTimeoutMs?: number;
}

/**
 * R3 correction D1 — the default bound on ONE provider refresh exchange.
 *
 * The configured value (`WORKOS_REFRESH_TIMEOUT_MS`) is what production uses; this
 * is the floor under a caller that names none, so the operation is TOTAL even when
 * nothing above it chose a deadline.
 */
export const DEFAULT_PROVIDER_REFRESH_TIMEOUT_MS = 10_000;

/**
 * The JWKS fetch inside the access-token verifier is bounded at 5s
 * (`oidc/token-verifier.ts`). The lease has to outlive that too, so it is part of
 * the budget rather than a hidden assumption.
 */
const ACCESS_TOKEN_VERIFICATION_BOUND_SECONDS = 5;

/** Slack for a process that is merely slow, not stuck. */
const REFRESH_LEASE_SLACK_SECONDS = 10;

/**
 * How long a claimed refresh attempt owns a session's refresh credential.
 *
 * DERIVED from the bound on the attempt rather than configured beside it, because
 * the relationship is the invariant: the lease must be LONGER than everything a
 * bounded attempt can legitimately spend (the provider exchange plus the token
 * verification), or a slow-but-successful refresh would lose its own claim and
 * throw away a replacement credential it had already paid for. It must not be
 * much longer, because until it expires a crashed attempt keeps the session from
 * refreshing at all.
 */
function refreshLeaseSeconds(providerTimeoutMs: number): number {
  return (
    Math.ceil(providerTimeoutMs / 1000) +
    ACCESS_TOKEN_VERIFICATION_BOUND_SECONDS +
    REFRESH_LEASE_SLACK_SECONDS
  );
}

/** Raised when an attempt exceeded its bound. Never a definitive failure. */
class ProviderCallTimeout extends Error {
  constructor(timeoutMs: number) {
    super(`the provider did not answer within ${timeoutMs}ms`);
    this.name = 'ProviderCallTimeout';
  }
}

/**
 * Runs `work` with a hard deadline and an AbortSignal, so a port that never
 * settles cannot make this operation never settle either.
 *
 * The losing promise is explicitly consumed: a race whose loser rejects later
 * would otherwise surface as an unhandled rejection and, under Node's default,
 * take the process down — which would turn a hung provider into a crash instead
 * of a bounded, transient failure.
 */
async function withDeadline<T>(
  timeoutMs: number,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const running = work(controller.signal);
  void running.catch(() => undefined);
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ProviderCallTimeout(timeoutMs));
    }, timeoutMs);
  });
  try {
    return await Promise.race([running, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** What phase 1 came back with: a claim, or the answer this call must return. */
type RefreshClaim =
  | {
      readonly kind: 'claimed';
      readonly leaseId: string;
      readonly refreshToken: string;
    }
  | { readonly kind: 'closed'; readonly outcome: RefreshSessionOutcome };

/**
 * PHASE 1 — re-judge the locked row and CLAIM the attempt. One short transaction
 * containing nothing but local statements: it commits and gives its pool
 * connection back BEFORE anything touches the network.
 */
async function claimRefreshAttempt(
  input: RefreshProviderSessionInput,
  keyVersion: number,
  leaseSeconds: number,
): Promise<RefreshClaim> {
  return withTransaction(async (executor): Promise<RefreshClaim> => {
    const locked = await executor.query(
      `SELECT * FROM identity_sessions
        WHERE session_id = $1 AND revoked_at IS NULL AND expires_at > NOW()
        FOR UPDATE`,
      [input.sessionId],
    );
    if (locked.rows.length === 0) {
      return { kind: 'closed', outcome: { outcome: 'unavailable', reason: 'no_live_session' } };
    }
    const row = locked.rows[0] as Row;

    // Dueness is re-judged HERE, against the row this transaction holds, not
    // against the copy the caller read before queuing for the lock. A concurrent
    // request that already refreshed has moved the expiry forward, so this one
    // finds nothing to do and spends no refresh token.
    if (input.refreshDueLeewaySeconds !== undefined) {
      const lockedSession = mapSession(row);
      if (!isProviderRefreshDue(lockedSession, { leewaySeconds: input.refreshDueLeewaySeconds })) {
        return { kind: 'closed', outcome: { outcome: 'not_due', session: lockedSession } };
      }
    }

    // …and an attempt that is ALREADY IN FLIGHT owns the credential. This is what
    // replaced holding the row lock across the provider call: the lock enforced
    // single-spend by making everyone wait (and pinning a pool connection per
    // waiter); the lease enforces it by making everyone else a no-op. An EXPIRED
    // lease is not a lease — a crashed or hung attempt must not wedge the session
    // forever — so it is simply overwritten below.
    if (row.refresh_lease_id !== null && row.refresh_lease_id !== undefined) {
      const leaseExpiry = ts(row.refresh_lease_expires_at);
      if (leaseExpiry.getTime() > Date.now()) {
        return {
          kind: 'closed',
          outcome: { outcome: 'refresh_in_flight', session: mapSession(row) },
        };
      }
    }

    const sealed = row.refresh_state_sealed;
    if (typeof sealed !== 'string' || sealed.length === 0) {
      return { kind: 'closed', outcome: { outcome: 'unavailable', reason: 'no_refresh_state' } };
    }
    if (Number(row.refresh_state_key_version) !== keyVersion) {
      // A rotated cookie password: the state is unopenable BY DESIGN. The
      // session keeps living on its own cookie; it just cannot be refreshed.
      return {
        kind: 'closed',
        outcome: { outcome: 'unavailable', reason: 'key_version_mismatch' },
      };
    }
    const refreshToken = openRefreshState(
      sealed,
      input.cookiePassword,
      input.refreshStateMaxAgeSeconds ?? DEFAULT_REFRESH_STATE_MAX_AGE_SECONDS,
    );
    if (refreshToken === null) {
      return {
        kind: 'closed',
        outcome: { outcome: 'unavailable', reason: 'sealed_state_unreadable' },
      };
    }
    // The sealed state and the replay digest must describe the SAME token. A
    // divergence means the pair was tampered with or an old state was written
    // back over a newer one — a replay either way.
    const presentedDigest = hashSessionToken(refreshToken);
    if (String(row.refresh_token_hash) !== presentedDigest) {
      await revokeWithin(executor, input.sessionId, 'refresh_replay_detected');
      return {
        kind: 'closed',
        outcome: { outcome: 'revoked', reason: 'refresh_replay_detected' },
      };
    }

    const leaseId = randomUUID();
    const claimed = await executor.query(
      `UPDATE identity_sessions
          SET refresh_lease_id = $2,
              refresh_lease_expires_at = NOW() + make_interval(secs => $3),
              updated_at = NOW()
        WHERE session_id = $1
          AND refresh_token_hash = $4
          AND revoked_at IS NULL
          AND expires_at > NOW()
          AND (refresh_lease_id IS NULL OR refresh_lease_expires_at <= NOW())
        RETURNING session_id`,
      [input.sessionId, leaseId, leaseSeconds, presentedDigest],
    );
    if (claimed.rows.length === 0) {
      // The DATABASE is the authority on whether the lease has expired, not the
      // process: the predicate above compares `refresh_lease_expires_at` to the
      // server's own NOW(). The JavaScript check further up reads the same two
      // values against this process's clock, so under clock skew the two can
      // disagree — and when they do, THIS is the answer that stands. That is why
      // the claim is a conditional write and not a blind one.
      return {
        kind: 'closed',
        outcome: { outcome: 'refresh_in_flight', session: mapSession(row) },
      };
    }
    return { kind: 'claimed', leaseId, refreshToken };
  });
}

/**
 * Releases OUR claim and nothing else. Keyed on the lease id, so an attempt whose
 * lease expired and was reclaimed cannot release the newer attempt's claim.
 */
async function releaseRefreshLease(sessionId: string, leaseId: string): Promise<void> {
  await query(
    `UPDATE identity_sessions
        SET refresh_lease_id = NULL, refresh_lease_expires_at = NULL, updated_at = NOW()
      WHERE session_id = $1 AND refresh_lease_id = $2`,
    [sessionId, leaseId],
  );
}

/**
 * FBL-020-R3 — a REAL provider refresh, in THREE PHASES.
 *
 * R2 shipped only a hash-rotation helper: nothing ever spoke to the provider,
 * and the stored digest could not be exchanged even in principle. This is the
 * operation.
 *
 * ── correction D1: NO DATABASE TRANSACTION IS HELD ACROSS THE NETWORK CALL ──
 *
 * R3 made this reachable from the request path and kept R2's shape: open a
 * transaction, take `SELECT ... FOR UPDATE` on the session row, and only THEN
 * await the provider. The lock did enforce single-spend — and it also meant that
 * a provider which HANGS rather than errors pinned one connection of the shared
 * pool, inside an idle open transaction, for as long as it hung. Ten due sessions
 * exhausted a pool of ten, and the pool is shared with all Fixed Ops traffic for
 * every tenant, so one unresponsive provider host was an API-wide outage. A
 * timeout alone would only have shortened it.
 *
 * So the exchange is split, and a LEASE — not a lock — is what serialises it:
 *
 *   1. CLAIM (short transaction): lock the row, re-judge dueness on it, open the
 *      sealed state, prove it matches the replay digest, and write a lease id and
 *      lease expiry. COMMIT. The connection goes back to the pool.
 *   2. EXCHANGE (no transaction at all): call the provider through the
 *      provider-neutral port under a hard deadline, then verify the replacement
 *      access token. No database connection is held for either.
 *   3. PERSIST (short transaction): lock the row again, prove the lease is still
 *      ours, re-verify the identity from the database, and rotate the sealed state
 *      keyed on the old digest — or revoke, or release the lease. COMMIT.
 *
 * The properties this preserves are the ones that matter:
 *   * SINGLE-SPEND — exactly one refresh token is spent however many requests
 *     judge the same session due at the same instant. The lease does what the
 *     lock did, without making anyone wait for the network: a second request sees
 *     an unexpired lease and takes the `refresh_in_flight` path.
 *   * NO WEDGED SESSION — a crashed or hung attempt leaves an EXPIRED lease,
 *     which the next request reclaims. The lease is derived from the attempt's own
 *     bound, so a legitimate slow attempt cannot outlive its claim.
 *   * auth_time is PRESERVED. A refresh is not an authentication event, so it can
 *     never rewind or fabricate freshness; only a verified token carrying a
 *     genuinely newer auth_time moves it forward.
 *
 * Failure model: a definitive refusal, an identity mismatch, a replay or an
 * impersonation REVOKES the session immediately. A transient failure — including
 * a provider that did not answer within the bound — changes nothing at all,
 * releases the claim, and is reported distinguishably, because destroying session
 * state because the network blinked is a self-inflicted outage.
 */
export async function refreshProviderSession(
  input: RefreshProviderSessionInput,
): Promise<RefreshSessionOutcome> {
  const keyVersion = input.keyVersion ?? REFRESH_STATE_KEY_VERSION;
  const providerTimeoutMs = input.providerTimeoutMs ?? DEFAULT_PROVIDER_REFRESH_TIMEOUT_MS;

  // ── PHASE 1: claim ──────────────────────────────────────────────────────
  const claim = await claimRefreshAttempt(
    input,
    keyVersion,
    refreshLeaseSeconds(providerTimeoutMs),
  );
  if (claim.kind === 'closed') return claim.outcome;
  const { leaseId, refreshToken } = claim;

  // ── PHASE 2: the exchange, with NO transaction open ─────────────────────
  let refreshed: ProviderRefreshResult;
  try {
    refreshed = await withDeadline(providerTimeoutMs, (signal) =>
      input.provider.refreshSession({ refreshToken, signal }),
    );
  } catch (err) {
    if (err instanceof ProviderRefreshError && err.kind === 'definitive') {
      return revokeLeasedSession(input.sessionId, 'refresh_failed');
    }
    // Transient, unclassifiable, or OUR OWN deadline: NOTHING is written and the
    // claim is released so the next request may try again. An error we cannot
    // classify is not evidence of a breach — and neither is silence — and
    // treating either as one would hand any flaky dependency the power to log
    // everybody out.
    await releaseRefreshLease(input.sessionId, leaseId);
    return { outcome: 'transient' };
  }

  if (isImpersonated(refreshed.impersonation)) {
    return revokeLeasedSession(input.sessionId, 'impersonation_detected');
  }

  // FBL-020-R5 §1.8: NOT a branch. There is no path from a provider reply to the
  // persistence below that skips verification — the absence test that used to wrap
  // this call is gone, and with it the possibility of an
  // exported refresh that took a token into custody without proving anything
  // about it.
  let verified: VerifiedAccessToken;
  try {
    verified = await input.verifyAccessToken(refreshed.accessToken);
  } catch {
    // The provider answered with a token we cannot verify. That is a
    // definitive failure of THIS session, not a transient one.
    return revokeLeasedSession(input.sessionId, 'refresh_failed');
  }
  if (isImpersonated(verified.impersonation)) {
    return revokeLeasedSession(input.sessionId, 'impersonation_detected');
  }

  // ── PHASE 3: persist ────────────────────────────────────────────────────
  return persistRefreshedState({
    input,
    keyVersion,
    leaseId,
    refreshToken,
    refreshed,
    verified,
  });
}

/**
 * Revoking answers, in ONE transaction of their own. The lease is cleared by the
 * revocation statement itself (`revokeSessionsWithin`), and deliberately WITHOUT a
 * lease predicate: "the provider says this session is over" is a fact about the
 * session, not about whose claim was current.
 */
async function revokeLeasedSession(
  sessionId: string,
  reason: IdentityBreachReason,
): Promise<RefreshSessionOutcome> {
  await withTransaction((executor) => revokeWithin(executor, sessionId, reason));
  return { outcome: 'revoked', reason };
}

/**
 * PHASE 3 — the replacement is persisted, or the session dies, in one short
 * transaction that touches nothing but the database.
 */
async function persistRefreshedState(args: {
  input: RefreshProviderSessionInput;
  keyVersion: number;
  leaseId: string;
  refreshToken: string;
  refreshed: ProviderRefreshResult;
  /** FBL-020-R5 §1.8: never null. The boundary above cannot produce one. */
  verified: VerifiedAccessToken;
}): Promise<RefreshSessionOutcome> {
  const { input, keyVersion, leaseId, refreshToken, refreshed, verified } = args;
  return withTransaction(async (executor): Promise<RefreshSessionOutcome> => {
    const locked = await executor.query(
      `SELECT * FROM identity_sessions
        WHERE session_id = $1 AND revoked_at IS NULL AND expires_at > NOW()
        FOR UPDATE`,
      [input.sessionId],
    );
    if (locked.rows.length === 0) {
      // The row was revoked or expired while the exchange was in flight. There is
      // nothing left to persist onto, and nothing to revoke either.
      return { outcome: 'unavailable', reason: 'no_live_session' };
    }
    const row = locked.rows[0] as Row;

    // THE CLAIM MUST STILL BE OURS. It can only fail to be if this attempt
    // outlived its own lease and another one reclaimed it — which means the
    // single-use token this attempt just spent is also being (or has been) spent
    // by that one. That is the replay condition, not a race to be smoothed over:
    // fail closed, exactly as a lost conditional rotation does below.
    if (String(row.refresh_lease_id) !== leaseId) {
      await revokeWithin(executor, input.sessionId, 'refresh_replay_detected');
      return { outcome: 'revoked', reason: 'refresh_replay_detected' };
    }

    if (!(await identityStillMatches(executor, row, input.expectedIssuer, refreshed, verified))) {
      await revokeWithin(executor, input.sessionId, 'identity_mismatch');
      return { outcome: 'revoked', reason: 'identity_mismatch' };
    }

    // auth_time moves ONLY forward, and only on verified evidence.
    const storedAuthTime = ts(row.auth_time);
    const nextAuthTime =
      verified.authTime.getTime() > storedAuthTime.getTime() ? verified.authTime : storedAuthTime;

    const rotated = await rotateRefreshStateRow(executor, {
      sessionId: input.sessionId,
      presentedRefreshToken: refreshToken,
      newRefreshToken: refreshed.refreshToken,
      authTime: nextAuthTime,
      ttlSeconds: input.ttlSeconds,
      cookiePassword: input.cookiePassword,
      refreshStateKeyVersion: keyVersion,
      // The new provider credential's expiry, and ONLY from a verified token.
      // Believing an `expires_in` the exchange volunteered would let the
      // provider response schedule its own next refresh; a verified `exp` is
      // the same fact the login recorded, proved the same way.
      providerAccessTokenExpiresAt: verified.expiresAt,
      expectedLeaseId: leaseId,
    });
    if (rotated === null) {
      // The conditional UPDATE lost: the digest moved, or the session was
      // revoked, between the lock and the write. Fail closed.
      await revokeWithin(executor, input.sessionId, 'refresh_replay_detected');
      return { outcome: 'revoked', reason: 'refresh_replay_detected' };
    }
    const session = mapSession(rotated);
    await auditSession(executor, {
      sessionId: session.sessionId,
      tenantId: session.tenantId,
      userLinkId: session.userLinkId,
      eventType: 'identity.session.refreshed',
      actorUserLinkId: null,
      details: {
        rotation_count: Number(rotated.refresh_rotation_count),
        auth_time_advanced: nextAuthTime.getTime() > storedAuthTime.getTime(),
        provider_session_id_bound: true,
      },
    });
    return {
      outcome: 'refreshed',
      session,
      rotationCount: Number(rotated.refresh_rotation_count),
    };
  });
}

function isImpersonated(classification: ImpersonationClassification): boolean {
  return classification.impersonated || classification.impersonatorEmailPresent;
}

/**
 * The SIX facts a refreshed session must still satisfy, every one of them
 * re-read from the database rather than believed from the provider response:
 * issuer, organization, subject, tenant, connection and UserLink. A provider
 * identifier is a mapping input; it is never authorization evidence.
 */
async function identityStillMatches(
  executor: Executor,
  row: Row,
  expectedIssuer: string,
  refreshed: ProviderRefreshResult,
  verified: VerifiedAccessToken,
): Promise<boolean> {
  const connectionId = row.connection_id;
  const sessionIssuer = row.issuer;
  const sessionOrg = row.provider_organization_id;
  const sessionSubject = row.provider_subject;
  if (
    typeof connectionId !== 'string' ||
    typeof sessionIssuer !== 'string' ||
    typeof sessionOrg !== 'string' ||
    typeof sessionSubject !== 'string'
  ) {
    return false;
  }
  // The session's own issuer must still be the CONFIGURED one.
  if (sessionIssuer !== expectedIssuer) return false;
  // What the provider just returned must describe the same identity.
  if (refreshed.providerUserId !== sessionSubject) return false;
  if (refreshed.organizationId !== null && refreshed.organizationId !== sessionOrg) return false;
  // FBL-020-R4 section 3 — THE PROVIDER SESSION ID, BOUND EXACTLY.
  //
  // R3 compared subject, organization, issuer, tenant, connection and link, and
  // never compared `sid` — while writing whatever `sid` came back over the stored
  // one. A refresh reply describing a DIFFERENT provider session was therefore
  // adopted silently, and `sid` is exactly the value logout is keyed on: the
  // local session ended up pointing at a provider session it was never
  // established from, so ending it at the provider ended the wrong one (or
  // nothing at all).
  //
  // A session that cannot name its own `sid`, or a reply that does not carry one,
  // proves nothing about sameness and fails CLOSED — absence is a disagreement,
  // never a skipped comparison.
  const sessionProviderSessionId = row.provider_session_id;
  if (typeof sessionProviderSessionId !== 'string' || sessionProviderSessionId.length === 0) {
    return false;
  }
  if (refreshed.providerSessionId !== sessionProviderSessionId) return false;
  // FBL-020-R5 §1.8: unconditional. A verified token is always present here, so
  // these three comparisons are made on every single refresh rather than only when
  // a caller chose to supply a verifier.
  if (verified.providerUserId !== sessionSubject) return false;
  if (verified.organizationId !== sessionOrg) return false;
  if (verified.providerSessionId !== sessionProviderSessionId) return false;
  // Connection, tenant and UserLink, all still effective, all still agreeing.
  const facts = await executor.query(
    `SELECT c.issuer          AS connection_issuer,
            c.provider_organization_id AS connection_org,
            c.tenant_id       AS connection_tenant,
            ul.provider_user_id AS link_subject,
            ul.tenant_id      AS link_tenant
       FROM identity_provider_connections c
       JOIN user_links ul ON ul.user_link_id = $2
      WHERE c.connection_id = $1
        AND c.status = 'active'
        AND c.effective_from <= NOW()
        AND (c.effective_to IS NULL OR c.effective_to > NOW())
        AND ul.status = 'activated'
        AND ul.effective_from <= NOW()
        AND (ul.effective_to IS NULL OR ul.effective_to > NOW())
        AND (
          ul.tenant_id IS NULL
          OR EXISTS (
            SELECT 1 FROM tenants t
             WHERE t.tenant_id = ul.tenant_id
               AND t.status = 'active'
               AND t.effective_from <= NOW()
               AND (t.effective_to IS NULL OR t.effective_to > NOW())
          )
        )`,
    [connectionId, row.user_link_id],
  );
  if (facts.rows.length === 0) return false;
  const f = facts.rows[0] as Row;
  const sessionTenant = row.tenant_id === null ? null : String(row.tenant_id);
  const connectionTenant = f.connection_tenant === null ? null : String(f.connection_tenant);
  const linkTenant = f.link_tenant === null ? null : String(f.link_tenant);
  return (
    String(f.connection_issuer) === sessionIssuer &&
    String(f.connection_org) === sessionOrg &&
    String(f.link_subject) === sessionSubject &&
    connectionTenant === sessionTenant &&
    linkTenant === sessionTenant
  );
}

// ── FBL-020-R3 correction C1: the MIDDLE of the refresh flow ───────────────
//
// The review found `refreshProviderSession` correct at both ends and reachable
// from nothing: /auth/callback took custody of a sealed provider refresh
// credential on EVERY login, and no runtime path could ever spend it. A
// long-lived credential at rest that nothing uses is pure blast radius, and it
// is the same shape as the unreachable reauthentication callback R0 rejected.
//
// This is the missing middle. `maintainProviderSession` is what the request
// path calls — one function, all the SQL still inside this package — and it
// decides from a stored FACT (the expiry of the provider access token the
// session last obtained) whether a refresh is due before this request is
// served. It adds no product feature: the outcomes are exactly the ones
// `refreshProviderSession` already implements, mapped to the only three things
// a request can do about them.

/**
 * How long BEFORE the provider access token expires a refresh becomes due.
 *
 * A leeway rather than "when it has expired": the exchange takes a round trip,
 * and a session that only refreshes after its provider credential is already
 * dead has a window in which the provider can no longer be consulted at all.
 */
export const DEFAULT_PROVIDER_REFRESH_LEEWAY_SECONDS = 60;

/**
 * Is this session's provider credential at or near expiry?
 *
 * Three closed answers, and only the first is "yes":
 *   - refreshable, expiry known, and inside the leeway → DUE
 *   - no sealed refresh state → never due (there is nothing to spend)
 *   - expiry unknown (NULL)  → never due (nothing to schedule against; the
 *     session simply lives out its local TTL)
 */
export function isProviderRefreshDue(
  session: IdentitySession,
  options?: { readonly leewaySeconds?: number; readonly now?: Date },
): boolean {
  if (!session.refreshable) return false;
  if (session.providerAccessTokenExpiresAt === null) return false;
  const leewayMs = (options?.leewaySeconds ?? DEFAULT_PROVIDER_REFRESH_LEEWAY_SECONDS) * 1000;
  const nowMs = (options?.now ?? new Date()).getTime();
  return session.providerAccessTokenExpiresAt.getTime() - leewayMs <= nowMs;
}

/** Why a maintained session was left exactly as it was. */
export type SessionUnchangedReason =
  'not_due' | 'not_refreshable' | 'transient_provider_failure' | 'refresh_unavailable';

/**
 * The THREE things a request can do about a maintenance attempt, and nothing
 * else:
 *   - `unchanged`     — proceed on the session it already had
 *   - `refreshed`     — proceed on the ROTATED session (its auth_time and
 *                       provider session id may have moved forward)
 *   - `session_ended` — the session is dead; refuse this request
 */
export type SessionMaintenanceOutcome =
  | {
      readonly outcome: 'unchanged';
      readonly session: IdentitySession;
      readonly reason: SessionUnchangedReason;
    }
  | {
      readonly outcome: 'refreshed';
      readonly session: IdentitySession;
      readonly rotationCount: number;
    }
  | {
      readonly outcome: 'session_ended';
      readonly reason: IdentityBreachReason | 'no_live_session';
    };

export interface MaintainProviderSessionInput {
  /** The session THIS request resolved, re-read from the database. */
  readonly session: IdentitySession;
  readonly provider: Pick<IdentityProviderPort, 'refreshSession'>;
  readonly cookiePassword: string;
  readonly expectedIssuer: string;
  /**
   * Standards-based verification of the NEW access token. REQUIRED here, unlike
   * on the primitive below it: the live path must never accept a refreshed
   * credential it did not verify, an impersonated one must revoke, and the
   * verified `exp` is the only honest source for the next refresh schedule.
   */
  readonly verifyAccessToken: (accessToken: string) => Promise<VerifiedAccessToken>;
  readonly leewaySeconds?: number;
  /**
   * R3 correction D1: the bound on the provider exchange this maintenance may
   * perform. Passed through from configuration, so an operator can tighten what a
   * request is willing to wait for without touching code.
   */
  readonly providerTimeoutMs?: number;
}

/**
 * Refreshes the provider session behind a live local session WHEN IT IS DUE,
 * before the request is served.
 *
 * The failure model, corrected in R3-D1 so the HANG case is stated truthfully
 * rather than folded into "transient":
 *
 *   | the provider…                              | this session          | this request |
 *   | ------------------------------------------ | --------------------- | ------------ |
 *   | definitively refuses                       | ENDED (revoked)       | 401          |
 *   | answers as a different identity / imposter | ENDED (revoked)       | 401          |
 *   | replays already-rotated refresh state      | ENDED (revoked)       | 401          |
 *   | errors transiently (429, 5xx, socket)      | untouched             | served       |
 *   | HANGS — never answers at all               | untouched             | served after |
 *   |                                            |                       | the bound    |
 *   | (no state, wrong key version, unreadable)  | untouched             | served       |
 *   | is already being refreshed by another      | untouched             | served       |
 *   | request (unexpired lease)                   |                       | immediately  |
 *
 * The HANG row is the one R3 got wrong. It was described as "transient", and it
 * IS classified transient — a bound that elapsed is not evidence of revocation —
 * but the cost was never bounded: the exchange ran inside an open transaction
 * holding a shared pool connection, so a hung provider took the whole API down
 * for every tenant rather than delaying one request. The bound
 * (`providerTimeoutMs`) is what makes the row true; the three-phase split in
 * `refreshProviderSession` is what makes it cheap.
 *
 * A transient provider failure therefore CANNOT fail a request whose local
 * session is still valid — turning a provider hiccup into a fleet-wide logout
 * is the outage this shape exists to prevent. The revoking outcomes end the
 * session inside `refreshProviderSession`'s own short transaction; this returns
 * `session_ended` so the caller refuses the request it is holding.
 *
 * A refresh renews the PROVIDER credential; it does NOT renew the person's local
 * session. The rotation is therefore given the session's REMAINING life rather
 * than a fresh TTL: the local bound is the point (the same reason a bearer
 * session's TTL never slides), and a session that re-armed itself every few
 * minutes for as long as a browser tab kept polling would make "expired"
 * unreachable for an idle-but-open client.
 */
export async function maintainProviderSession(
  input: MaintainProviderSessionInput,
): Promise<SessionMaintenanceOutcome> {
  const leewaySeconds = input.leewaySeconds ?? DEFAULT_PROVIDER_REFRESH_LEEWAY_SECONDS;
  if (!isProviderRefreshDue(input.session, { leewaySeconds })) {
    return {
      outcome: 'unchanged',
      session: input.session,
      reason: input.session.refreshable ? 'not_due' : 'not_refreshable',
    };
  }
  const remainingSeconds = Math.max(
    1,
    Math.floor((input.session.expiresAt.getTime() - Date.now()) / 1000),
  );
  const refreshed = await refreshProviderSession({
    sessionId: input.session.sessionId,
    provider: input.provider,
    cookiePassword: input.cookiePassword,
    expectedIssuer: input.expectedIssuer,
    ttlSeconds: remainingSeconds,
    verifyAccessToken: input.verifyAccessToken,
    refreshDueLeewaySeconds: leewaySeconds,
    ...(input.providerTimeoutMs === undefined
      ? {}
      : { providerTimeoutMs: input.providerTimeoutMs }),
  });
  switch (refreshed.outcome) {
    case 'refreshed':
      return {
        outcome: 'refreshed',
        session: refreshed.session,
        rotationCount: refreshed.rotationCount,
      };
    case 'revoked':
      return { outcome: 'session_ended', reason: refreshed.reason };
    case 'transient':
      return {
        outcome: 'unchanged',
        session: input.session,
        reason: 'transient_provider_failure',
      };
    case 'not_due':
      // A concurrent request refreshed while this one waited for the row lock.
      // The CURRENT row comes back, so this request proceeds on what is true now.
      return { outcome: 'unchanged', session: refreshed.session, reason: 'not_due' };
    case 'refresh_in_flight':
      // R3 correction D1: another request holds the refresh lease. Collapsed onto
      // the same answer as `not_due` deliberately — a request can do exactly ONE
      // thing about either, which is proceed on the current row and spend nothing.
      // What it must NOT do is wait for the other attempt: waiting for a network
      // call somebody else is making, while holding this request's own resources,
      // is the defect this correction removes.
      return { outcome: 'unchanged', session: refreshed.session, reason: 'not_due' };
    case 'unavailable':
      // `no_live_session` is not an unavailability, it is a death: the row was
      // revoked or expired between this request resolving it and the lock being
      // taken. Every other reason leaves a live, unrefreshable session — which
      // keeps working on its own local TTL.
      return refreshed.reason === 'no_live_session'
        ? { outcome: 'session_ended', reason: 'no_live_session' }
        : { outcome: 'unchanged', session: input.session, reason: 'refresh_unavailable' };
  }
}
