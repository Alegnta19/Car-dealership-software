/**
 * Provider-backed reauthentication (FBL-020, ADR-006) — the replacement for
 * every locally signed step-up trust path.
 *
 * Flow: a sensitive action STARTS a transaction (bound to tenant, user,
 * action and resource); the person re-authenticates at the provider with
 * max_age=0; the callback proves auth_time happened AFTER the transaction
 * started (bounded skew) and mints ONE single-use grant. Opaque values are
 * returned exactly once and stored only as SHA-256 digests. Consumption is
 * an atomic conditional UPDATE executed INSIDE the business transaction:
 * a replay fails closed, and a rolled-back business action leaves the grant
 * unconsumed because the action it paid for never happened.
 *
 * ── FBL-020-R3: where the STARTING FACTS come from ────────────────────────
 *
 * R2 let the caller state the identity a reauthentication started from:
 * connection, issuer, organization and subject were optional inputs, and the
 * insert fell back to a COALESCE over the database only when they were
 * absent. A caller therefore decided what the completion would later be
 * compared against — which makes the comparison a formality, because a caller
 * that can choose both sides of an equality proves nothing by satisfying it.
 *
 * R3 inverts that. Every starting fact is DERIVED SERVER-SIDE, in one
 * statement, from the LIVE LOCAL SESSION the step-up is being requested from:
 * the session names its connection, the connection names the issuer and the
 * organization, and the user link names the provider subject. A caller may
 * still say what it believes those values are — `expected*` — and a
 * disagreement REFUSES the start. Belief is checked; it is never authority.
 *
 * The OIDC nonce is likewise generated here, returned once, and persisted
 * only as `oidc_nonce_hash`. R2 stored that digest and then never looked at
 * it again; the completion now compares the digest of the nonce the PROVIDER
 * returned against it, and a missing digest is a failure rather than a
 * skipped comparison.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { withTransaction, type Executor } from '@dealer/database';
import { getRequestContext } from '@dealer/platform';
import { EFFECTIVE_MFA_CERTIFICATION_SQL } from './contracts';

function sha256hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * The correlation shape the evidence tables enforce. Anything else is DROPPED
 * rather than truncated — the same rule `login-transaction.ts` applies, for the
 * same reason: a value trimmed into shape correlates a flow to the wrong
 * request, and no header value may reach a CHECK.
 */
const SAFE_CORRELATION = /^[A-Za-z0-9._-]{8,128}$/;

/**
 * FBL-020-R4 section 3 — the correlation pair a step-up records, read from the
 * REQUEST CONTEXT rather than accepted from a caller.
 *
 * It is the very pair the outermost middleware minted and every log line for
 * this request already carries, so a reauthentication row joins to its logs on
 * ids nobody chose. Off-request (a scheduler, a CLI, a test) one is generated,
 * because "no id" is not a fact a security transition may record about itself.
 */
function correlationPair(): { requestId: string; correlationId: string } {
  const context = getRequestContext();
  const requestId = safeCorrelation(context?.requestId);
  const correlationId = safeCorrelation(context?.correlationId);
  if (requestId !== null && correlationId !== null) return { requestId, correlationId };
  const generated = randomUUID();
  return { requestId: requestId ?? generated, correlationId: correlationId ?? generated };
}

function safeCorrelation(value: string | null | undefined): string | null {
  return typeof value === 'string' && SAFE_CORRELATION.test(value) ? value : null;
}

/**
 * FBL-020-R4 section 3 — WHY a reauthentication ended. A CLOSED vocabulary
 * written by the server: never a provider message, never a token, a nonce, an
 * authorization code or anything a caller supplied.
 *
 * `granted` is the success terminal. Everything else is a refusal, and the
 * answer rendered outward is identical for all of them — the reason lives on
 * the row and in the audit trail, never in a response body.
 */
export type ReauthenticationTerminalReason =
  | 'granted'
  | 'callback_state_mismatch'
  | 'provider_exchange_failed'
  | 'impersonation_detected'
  | 'token_verification_failed'
  | 'identity_not_admitted'
  | 'stale_authentication'
  | 'nonce_mismatch'
  | 'binding_mismatch'
  | 'identity_chain_broken'
  | 'assurance_not_certified'
  | 'session_establishment_failed'
  /**
   * FBL-020-R5 §1.5 — the step-up leg's equivalents of the two login reasons: the
   * provider redirected to the callback with an `error` and no code, or the
   * callback carried no authorization code. Both are terminal, both are recorded,
   * and neither carries the provider's own message.
   */
  | 'provider_error_callback'
  | 'authorization_code_missing'
  /**
   * FBL-020-R6 §2.1 — the sealed cookie presented a purpose that is not this leg's.
   * Its own terminal reason rather than a route-level 401, for the same reason as
   * every other binding failure: a callback that named a real transaction must end
   * that transaction rather than leave it claimable.
   */
  | 'callback_purpose_mismatch'
  /**
   * FBL-020-R6 §2.4 — the completion named a DIFFERENT person from the one this
   * step-up was started for. R5 put `user_link_id` in the lookup predicate, so a
   * wrong-subject callback found no row, returned `null`, terminalized nothing and
   * audited nothing: the step-up stayed `started` with its nonce claimable, and the
   * single most interesting thing that can happen to a step-up left no trace.
   */
  | 'wrong_subject'
  /**
   * FBL-020-R6 §2.4 — a completion reached a transaction that had never been
   * claimed. R5 filtered `claimed_at IS NOT NULL` in the lookup, which made an
   * unclaimed completion indistinguishable from an unknown handle.
   */
  | 'completion_without_claim'
  | 'replayed'
  | 'expired';

/**
 * The audit event type each terminal reason is recorded under. EXACTLY ONE row
 * per terminal transition, written in the SAME transaction as the state change,
 * so a transaction cannot end without the trail saying so.
 */
function terminalEventType(reason: ReauthenticationTerminalReason): string {
  if (reason === 'granted') return 'identity.reauthentication.granted';
  if (reason === 'replayed') return 'identity.reauthentication.replayed';
  if (reason === 'expired') return 'identity.reauthentication.expired';
  return 'identity.reauthentication.failed';
}

/**
 * Writes the ONE audit row a reauthentication transition owes, on the caller's
 * executor so it commits with the state change it describes.
 *
 * Details carry identifiers, classifications and the closed-vocabulary reason
 * and NOTHING else: no nonce, no state, no PKCE verifier, no token, no provider
 * profile, no PII.
 */
async function auditReauthentication(
  executor: Executor,
  input: {
    tenantId: string;
    reauthTxnId: string;
    userLinkId: string | null;
    eventType: string;
    details: Record<string, unknown>;
  },
): Promise<void> {
  await executor.query(
    `INSERT INTO audit_events
       (tenant_id, event_type, entity_type, entity_id, actor_user_id, details)
     VALUES ($1, $2, 'reauth_transaction', $3, $4, $5)`,
    [
      input.tenantId,
      input.eventType,
      input.reauthTxnId,
      input.userLinkId,
      JSON.stringify(input.details),
    ],
  );
}

/**
 * The ONE way a reauthentication transaction reaches a terminal state.
 *
 * FBL-020-R4 section 3 — R3 had no such function, and that is the defect. The
 * completion set `state = 'failed'` for the proofs it judged itself, and every
 * failure BEFORE it — a provider exchange that threw, an impersonated reply, a
 * token that would not verify, an identity that no longer resolved — returned a
 * 401 from the route and left the row sitting at `started`. Those rows were
 * indistinguishable from legs still legitimately in flight, they kept their
 * nonce claimable until the expiry sweep noticed, and they produced no audit
 * event at all.
 *
 * The move is conditional on the row being NON-terminal, so the FIRST terminal
 * fact wins and nothing overwrites it; and it writes its audit row inside the
 * same transaction, so exactly one event accompanies exactly one transition.
 * `false` means the transaction was already terminal — the audit row for the
 * ATTEMPT is still written, because a replayed callback is itself a fact.
 */
async function terminateWithin(
  executor: Executor,
  input: {
    reauthTxnId: string;
    tenantId: string;
    userLinkId: string | null;
    reason: ReauthenticationTerminalReason;
    state: 'completed' | 'failed' | 'expired';
    /** Extra IDENTIFIERS and CLASSIFICATIONS for the trail. Never a secret. */
    details?: Record<string, unknown>;
  },
): Promise<boolean> {
  const moved = await executor.query(
    `UPDATE reauthentication_transactions
        SET state = $2,
            terminal_reason = $3,
            terminal_at = NOW(),
            completed_at = CASE WHEN $2 = 'completed' THEN NOW() ELSE completed_at END,
            updated_at = NOW()
      WHERE reauth_txn_id = $1 AND state = 'started'`,
    [input.reauthTxnId, input.state, input.reason],
  );
  const first = (moved.rowCount ?? 0) > 0;
  // EXACTLY ONE terminal event per transaction. A transition that did not happen
  // — the row was already terminal — writes nothing, so the trail cannot show two
  // endings for one step-up. The single exception is a REPLAY, which is a fact
  // about an ATTEMPT rather than about the transaction's ending: a replayed
  // callback must be visible even when the row it targets is already closed.
  if (!first && input.reason !== 'replayed') return false;
  await auditReauthentication(executor, {
    tenantId: input.tenantId,
    reauthTxnId: input.reauthTxnId,
    userLinkId: input.userLinkId,
    eventType: terminalEventType(input.reason),
    details: {
      ...(input.details ?? {}),
      reason: input.reason,
      terminal_state: first ? input.state : 'already_terminal',
    },
  });
  return first;
}

/**
 * The application-facing terminal move, for the route legs that discover a
 * failure OUTSIDE any database transaction — a provider exchange that threw, an
 * impersonated reply, an unverifiable token. It owns its own transaction so no
 * app file imports a database primitive, and it is keyed on the OPAQUE HANDLE,
 * which is the only thing the caller holds.
 */
export async function failReauthentication(input: {
  nonce: string;
  reason: ReauthenticationTerminalReason;
}): Promise<boolean> {
  return withTransaction(async (executor) => {
    const found = await executor.query(
      `SELECT reauth_txn_id, tenant_id, user_link_id FROM reauthentication_transactions
        WHERE nonce_hash = $1 FOR UPDATE`,
      [sha256hex(input.nonce)],
    );
    if (found.rows.length === 0) return false;
    const row = found.rows[0] as Row;
    return terminateWithin(executor, {
      reauthTxnId: String(row.reauth_txn_id),
      tenantId: String(row.tenant_id),
      userLinkId: row.user_link_id === null ? null : String(row.user_link_id),
      reason: input.reason,
      state: 'failed',
    });
  });
}

/**
 * The digest form an OIDC nonce is compared in. Exported because the
 * comparison has exactly one shape everywhere: the verifier reduces the
 * returned `nonce` claim to this digest, the transaction row stores this
 * digest, and nothing in between ever holds the raw value.
 */
export function oidcNonceDigest(nonce: string): string {
  return sha256hex(nonce);
}

/**
 * FBL-020-R1 section E. Fresh authentication and certified MFA policy are
 * SEPARATE facts:
 *
 *   - `fresh_only`            — max_age=0 plus an auth_time after the
 *                               transaction start proves a fresh provider
 *                               authentication event, and nothing more.
 *   - `fresh_and_mfa_policy`  — additionally requires that the ACTIVE
 *                               provider connection certifies the mapped
 *                               WorkOS organization as MFA-required.
 *
 * WorkOS documents organization MFA policy separately from max_age
 * reauthentication, so a fresh auth_time cannot stand in for the policy. An
 * uncertified, false, expired or inactive certification fails CLOSED. No AMR
 * value is fabricated and no specific authentication method is claimed.
 */
export type AssuranceLevel = 'fresh_only' | 'fresh_and_mfa_policy';

export interface ReauthenticationTransaction {
  readonly reauthTxnId: string;
  readonly tenantId: string;
  readonly userLinkId: string;
  readonly action: string;
  readonly resourceType: string | null;
  readonly resourceId: string | null;
  readonly startedAt: Date;
  readonly expiresAt: Date;
  readonly state: 'started' | 'completed' | 'failed' | 'expired';
}

interface Row {
  [key: string]: unknown;
}

function ts(v: unknown): Date {
  return v instanceof Date ? v : new Date(String(v));
}

function mapTxn(r: Row): ReauthenticationTransaction {
  return {
    reauthTxnId: String(r.reauth_txn_id),
    tenantId: String(r.tenant_id),
    userLinkId: String(r.user_link_id),
    action: String(r.action),
    resourceType: r.resource_type === null ? null : String(r.resource_type),
    resourceId: r.resource_id === null ? null : String(r.resource_id),
    startedAt: ts(r.started_at),
    expiresAt: ts(r.expires_at),
    state: String(r.state) as ReauthenticationTransaction['state'],
  };
}

export interface StartedReauthentication {
  readonly transaction: ReauthenticationTransaction;
  /** Opaque internal handle for the round trip. Returned ONCE, stored hashed. */
  readonly nonce: string;
  /**
   * The OIDC nonce this leg demands back from the provider. Generated here so
   * no caller can choose it; returned ONCE, persisted only as a digest.
   */
  readonly oidcNonce: string;
  /**
   * FBL-020-R4 section 3 — the OAuth `state` and PKCE verifier for THIS leg,
   * generated HERE and persisted as digests on the row.
   *
   * R3 generated both inside the HTTP route and stored neither, so the only
   * record of what the callback had to present was the browser's sealed copy:
   * the round-trip state was client-authoritative and no server row could say
   * "this one is spent". Returned exactly once, like every other opaque value in
   * this module.
   */
  readonly state: string;
  readonly codeVerifier: string;
  /**
   * The SERVER-DERIVED identity this reauthentication starts from. Returned so
   * the caller can build the authorization request without re-reading (and
   * without being tempted to supply its own values).
   */
  readonly binding: {
    readonly connectionId: string;
    readonly issuer: string;
    readonly providerOrganizationId: string;
    readonly providerSubject: string;
    readonly sessionId: string;
  };
}

/**
 * The identity chain a step-up may be started from, and the chain its
 * completion must still find intact. Written once, used by both ends.
 *
 *   1. local session — live, unrevoked, unexpired, and the acting link's
 *   2. UserLink      — activated, effective, tenant-coherent, and carrying the
 *                      session's provider subject and binding
 *   3. connection    — active, effective, and agreeing with both on issuer and
 *                      provider organization
 *   4. tenant        — active and effective (a platform actor has none)
 *
 * `s`/`ul`/`c` are the session, user-link and connection aliases.
 */
const STEP_UP_IDENTITY_SQL = `
        s.revoked_at IS NULL
    AND s.expires_at > NOW()
    AND ul.user_link_id = s.user_link_id
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
 * Opens a reauthentication transaction, deriving every identity fact from the
 * live local session named by `sessionId`. Returns null — a refusal, not an
 * exception — when the chain does not hold, or when a supplied `expected*`
 * value disagrees with the derived one. Nothing is written in that case.
 */
export async function startReauthentication(input: {
  tenantId: string;
  userLinkId: string;
  /** The LIVE local session this step-up starts from. Not optional. */
  sessionId: string;
  action: string;
  resourceType?: string | null;
  resourceId?: string | null;
  ttlSeconds?: number;
  requiredAssurance?: AssuranceLevel;
  /**
   * FBL-020-R4 section 3 — the EXACT callback this leg will be completed at.
   * Stored on the row and re-compared at claim time, so a leg issued for one
   * redirect can never be completed at another. Defaults to nothing: the
   * schema refuses a `started` transaction that cannot name it.
   */
  callbackUri: string;
  /**
   * OPTIONAL caller beliefs about the starting identity. Each is COMPARED
   * against the server-derived value and a disagreement refuses the start.
   * None of them can ever supply a value the server did not derive itself.
   */
  expectedConnectionId?: string | null;
  expectedIssuer?: string | null;
  expectedProviderOrganizationId?: string | null;
  expectedProviderSubject?: string | null;
}): Promise<StartedReauthentication | null> {
  const nonce = randomBytes(32).toString('base64url');
  const oidcNonce = randomBytes(32).toString('base64url');
  // R4 section 3: state and the PKCE verifier are generated HERE, beside the
  // digests that will be compared against them. No caller — and therefore no
  // route and no browser — chooses either.
  const state = randomBytes(32).toString('base64url');
  const codeVerifier = randomBytes(32).toString('base64url');
  const { requestId, correlationId } = correlationPair();
  return withTransaction(async (executor) => {
    const result = await executor.query(
      `WITH derived AS (
       SELECT s.session_id, s.tenant_id, ul.user_link_id,
              c.connection_id, c.issuer, c.provider_organization_id,
              ul.provider_user_id AS provider_subject
         FROM identity_sessions s
         JOIN user_links ul ON ul.user_link_id = s.user_link_id
         JOIN identity_provider_connections c ON c.connection_id = s.connection_id
        WHERE s.session_id = $2
          AND s.user_link_id = $1
          AND s.tenant_id IS NOT DISTINCT FROM $10
          AND ${STEP_UP_IDENTITY_SQL}
          -- caller BELIEFS: compared, never authoritative. NULL means "no
          -- belief stated", which asserts nothing and overrides nothing.
          AND ($11::uuid IS NULL OR $11::uuid = c.connection_id)
          AND ($12::text IS NULL OR $12::text = c.issuer)
          AND ($13::text IS NULL OR $13::text = c.provider_organization_id)
          AND ($14::text IS NULL OR $14::text = ul.provider_user_id)
     )
     INSERT INTO reauthentication_transactions
       (tenant_id, user_link_id, session_id, action, resource_type, resource_id, nonce_hash,
        expires_at, required_assurance, oidc_nonce_hash,
        connection_id, issuer, provider_organization_id, provider_subject,
        created_by_user_link_id,
        state_hash, code_verifier_hash, callback_uri, request_id, correlation_id)
     SELECT d.tenant_id, d.user_link_id, d.session_id, $3, $4, $5, $6,
            NOW() + make_interval(secs => $7), $8, $9,
            d.connection_id, d.issuer, d.provider_organization_id, d.provider_subject,
            d.user_link_id,
            $15, $16, $17, $18, $19
       FROM derived d
     RETURNING *`,
      [
        input.userLinkId,
        input.sessionId,
        input.action,
        input.resourceType ?? null,
        input.resourceId ?? null,
        sha256hex(nonce),
        input.ttlSeconds ?? 300,
        input.requiredAssurance ?? 'fresh_only',
        sha256hex(oidcNonce),
        input.tenantId,
        input.expectedConnectionId ?? null,
        input.expectedIssuer ?? null,
        input.expectedProviderOrganizationId ?? null,
        input.expectedProviderSubject ?? null,
        sha256hex(state),
        sha256hex(codeVerifier),
        input.callbackUri,
        requestId,
        correlationId,
      ],
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0] as Row;
    const txn = mapTxn(row);
    // The START is an audited transition: R3 recorded only the GRANT, so a
    // step-up that was opened and then abandoned left no trail that it had ever
    // been asked for.
    await auditReauthentication(executor, {
      tenantId: txn.tenantId,
      reauthTxnId: txn.reauthTxnId,
      userLinkId: txn.userLinkId,
      eventType: 'identity.reauthentication.started',
      details: {
        action: txn.action,
        resource_type: txn.resourceType,
        required_assurance: String(row.required_assurance),
      },
    });
    return {
      transaction: txn,
      nonce,
      oidcNonce,
      state,
      codeVerifier,
      binding: {
        connectionId: String(row.connection_id),
        issuer: String(row.issuer),
        providerOrganizationId: String(row.provider_organization_id),
        providerSubject: String(row.provider_subject),
        sessionId: String(row.session_id),
      },
    };
  });
}

/**
 * FBL-020-R4 section 3 — the CLAIM: the server-side row judges its own callback,
 * exactly once.
 *
 * Everything the callback presents is compared against what the START stored —
 * the opaque handle, the OAuth state, the PKCE verifier and the exact callback
 * URI — and the claim is a conditional UPDATE on `claimed_at IS NULL`, so a
 * second callback bearing the same state LOSES to the database rather than being
 * judged by trust. R3 compared the state to a copy the browser carried and
 * nothing else, which is not a claim at all.
 *
 * Returns null on every refusal, and the refusals are indistinguishable to the
 * caller: an unknown handle, a mismatch, an expired leg and a replay all yield
 * null. Each one that names a real row TERMINATES it and writes exactly one
 * audit event.
 */
export async function claimReauthentication(input: {
  nonce: string;
  /**
   * FBL-020-R6 §2.1 — the values the CALLBACK presented, each `null`-able because
   * "the callback did not carry this" is a fact this service classifies rather than
   * a reason for a route to refuse before the row has been consulted.
   */
  state: string | null;
  codeVerifier: string | null;
  /** The purpose the sealed cookie carried. Omitted, it is taken to have said `reauth`. */
  presentedPurpose?: string | null;
  callbackUri: string;
}): Promise<{ reauthTxnId: string; tenantId: string } | null> {
  return withTransaction(async (executor) => {
    const found = await executor.query(
      `SELECT *, (expires_at <= NOW()) AS is_expired FROM reauthentication_transactions
        WHERE nonce_hash = $1 FOR UPDATE`,
      [sha256hex(input.nonce)],
    );
    if (found.rows.length === 0) return null;
    const row = found.rows[0] as Row;
    const reauthTxnId = String(row.reauth_txn_id);
    const tenantId = String(row.tenant_id);
    const userLinkId = row.user_link_id === null ? null : String(row.user_link_id);
    const terminate = async (reason: ReauthenticationTerminalReason): Promise<null> => {
      await terminateWithin(executor, {
        reauthTxnId,
        tenantId,
        userLinkId,
        reason,
        state: reason === 'expired' ? 'expired' : 'failed',
      });
      return null;
    };
    // A leg that is already spent or already terminal is a REPLAY. Terminating
    // it is the fail-closed direction: two callbacks for one single-use state
    // means something is wrong, and the first terminal fact still wins.
    if (row.claimed_at !== null || String(row.state) !== 'started') {
      return terminate('replayed');
    }
    // FBL-020-R6 §2.3's rule, applied here too: expiry is DATABASE TIME, computed by
    // the same statement that locked the row, never this process's `Date.now()`
    // compared against a timestamp that travelled through JavaScript.
    if (row.is_expired === true) return terminate('expired');
    // FBL-020-R6 §2.1 — the purpose the sealed cookie presented must be this leg's.
    // Omitted means "the cookie agreed"; a disagreement is terminal here rather than
    // a route-level refusal that left the row claimable.
    if ((input.presentedPurpose ?? 'reauth') !== 'reauth') {
      return terminate('callback_purpose_mismatch');
    }
    // Handle, state, PKCE and the exact callback: every one required, every one
    // compared against what the START stored. A missing stored digest cannot be
    // satisfied by a missing presented value — the schema forbids the NULL, and
    // the comparison below would fail anyway.
    //
    // The PERSON is deliberately NOT part of this predicate: the callback leg is
    // unauthenticated (the browser is arriving from the provider), so the actor is
    // not known until the token has been verified. `completeReauthentication`
    // requires `nonce_hash` AND `user_link_id` to agree, so the round trip is
    // proven here and the identity is proven there — both required, neither
    // standing in for the other.
    if (
      input.state === null ||
      input.codeVerifier === null ||
      typeof row.state_hash !== 'string' ||
      typeof row.code_verifier_hash !== 'string' ||
      typeof row.callback_uri !== 'string' ||
      row.state_hash !== sha256hex(input.state) ||
      row.code_verifier_hash !== sha256hex(input.codeVerifier) ||
      row.callback_uri !== input.callbackUri
    ) {
      return terminate('callback_state_mismatch');
    }
    const claimed = await executor.query(
      `UPDATE reauthentication_transactions
          SET claimed_at = NOW(), updated_at = NOW()
        WHERE reauth_txn_id = $1
          AND state = 'started'
          AND claimed_at IS NULL
          AND expires_at > NOW()`,
      [reauthTxnId],
    );
    if ((claimed.rowCount ?? 0) === 0) return terminate('replayed');
    await auditReauthentication(executor, {
      tenantId,
      reauthTxnId,
      userLinkId,
      eventType: 'identity.reauthentication.claimed',
      details: { action: String(row.action), resource_type: row.resource_type ?? null },
    });
    return { reauthTxnId, tenantId };
  });
}

export interface CompletedReauthentication {
  readonly transaction: ReauthenticationTransaction;
  /** The single-use grant. Returned ONCE, stored hashed. */
  readonly grant: string;
  readonly grantExpiresAt: Date;
}

/**
 * Completes a transaction after the provider round trip. The CALLER has
 * already verified the fresh access token cryptographically (issuer,
 * audience, algorithm, JWKS); this function enforces every transaction-side
 * proof, and each one FAILS CLOSED:
 *
 *   1. the internal nonce names a live `started` transaction for THIS user;
 *   2. `auth_time` is at or after the transaction start minus bounded skew;
 *   3. the digest of the OIDC nonce the provider returned equals the stored
 *      `oidc_nonce_hash` — a MISSING digest is a failure, never a skip;
 *   4. issuer, provider organization, provider subject and connection each
 *      equal what the transaction was bound to at start, and a MISSING
 *      verified value is a failure, never a skipped comparison;
 *   5. the whole identity chain — tenant, connection, UserLink and the local
 *      session the step-up started from — is re-read and must still hold;
 *   6. MFA certification is read from the CONNECTION ROW at this instant, not
 *      from anything the caller asserts.
 *
 * Any miss marks the transaction `failed` and mints nothing.
 */
export async function completeReauthentication(input: {
  nonce: string;
  userLinkId: string;
  verifiedAuthTime: Date;
  /**
   * The SHA-256 hex digest of the `nonce` claim the provider returned. `null`
   * is the closed value: it means the token carried no nonce, which cannot
   * satisfy a nonce-bound transaction.
   */
  verifiedNonceDigest: string | null;
  /**
   * What the RETURNING token actually proved. Each must equal what the
   * transaction started from; `null` — nothing proved — is a failure.
   */
  verifiedIssuer: string | null;
  verifiedOrganizationId: string | null;
  verifiedProviderSubject: string | null;
  verifiedConnectionId: string | null;
  clockSkewSeconds?: number;
  grantTtlSeconds?: number;
}): Promise<CompletedReauthentication | null> {
  const skewMs = (input.clockSkewSeconds ?? 60) * 1000;
  return withTransaction(async (executor) => {
    /*
     * ── FBL-020-R6 §2.4: FIND AND LOCK BY THE SERVER HANDLE, THEN CLASSIFY ────
     *
     * R5 put four things in this predicate — `user_link_id = $2`, `state =
     * 'started'`, `claimed_at IS NOT NULL` and `expires_at > NOW()` — so a step-up
     * that failed any of them SELECTED NOTHING, and the function returned `null`
     * with no terminalization and no audit row at all. Two of those are exactly the
     * cases an operator most needs to see:
     *
     *   * WRONG SUBJECT. A callback that verifies as somebody else — the browser
     *     signed in as a different person mid-round-trip, or a deliberate attempt to
     *     complete another person's step-up — found no row, so the transaction it
     *     targeted stayed `started` with its nonce still claimable, and the attempt
     *     was invisible.
     *   * EXPIRY DURING THE EXCHANGE. A leg claimed just before `expires_at` and
     *     completed after it fell out of the predicate the same way, and the step-up
     *     sat `started` until a SWEEP eventually aged it — under a reason and at a
     *     time that had nothing to do with what actually happened.
     *
     * The lookup is now the HANDLE ALONE, under `FOR UPDATE`, and every one of the
     * four conditions is classified below with its own terminal reason and its own
     * single audit event. `is_expired` is computed by this statement, so the clock
     * is the database's.
     */
    const found = await executor.query(
      `SELECT *, (expires_at <= NOW()) AS is_expired FROM reauthentication_transactions
        WHERE nonce_hash = $1
        FOR UPDATE`,
      [sha256hex(input.nonce)],
    );
    if (found.rows.length === 0) return null;
    const startRow = found.rows[0] as Row;
    const txn = mapTxn(startRow);

    // Every refusal below is TERMINAL, with a closed-vocabulary reason, an
    // instant, and exactly one audit row — all in this transaction. R3 wrote
    // `state = 'failed'` and nothing else, so an operator could see that a
    // step-up had failed but never why or when.
    const fail = async (reason: ReauthenticationTerminalReason): Promise<null> => {
      await terminateWithin(executor, {
        reauthTxnId: txn.reauthTxnId,
        tenantId: txn.tenantId,
        // The TRUE owner of the transaction, read from the row. On a wrong-subject
        // refusal this is deliberately NOT the identity the callback presented: the
        // audit row belongs to the step-up, and naming the caller's link would
        // attribute a transaction to somebody it was never opened for.
        userLinkId: txn.userLinkId,
        reason,
        state: reason === 'expired' ? 'expired' : 'failed',
      });
      return null;
    };

    // A leg that is already terminal is a REPLAY, and `terminateWithin` records the
    // ATTEMPT even though it changes nothing — the first terminal fact still wins.
    if (String(startRow.state) !== 'started') return fail('replayed');
    // The claim is where the server judged its own callback state, so a completion
    // that could run without one would make the claim optional — and R3's completion
    // could, because no claim existed at all.
    if (startRow.claimed_at === null) return fail('completion_without_claim');
    if (startRow.is_expired === true) return fail('expired');
    // THE SUBJECT, compared rather than filtered.
    if (txn.userLinkId !== input.userLinkId) return fail('wrong_subject');

    // stale authentication — the person did NOT freshly re-authenticate
    if (input.verifiedAuthTime.getTime() < txn.startedAt.getTime() - skewMs) {
      return fail('stale_authentication');
    }

    // ── R3: the STORED OIDC nonce participates, directly ──────────────────
    //
    // The digest the provider's token reduced to must equal the digest this
    // transaction stored at start. A transaction with no stored digest cannot
    // be completed at all (the schema forbids one in `started`), and a token
    // that carried no nonce presents `null`, which matches nothing.
    const storedNonceHash = startRow.oidc_nonce_hash;
    if (
      typeof storedNonceHash !== 'string' ||
      storedNonceHash.length === 0 ||
      typeof input.verifiedNonceDigest !== 'string' ||
      input.verifiedNonceDigest.length === 0 ||
      input.verifiedNonceDigest !== storedNonceHash
    ) {
      return fail('nonce_mismatch');
    }

    // ── Exact binding: every value REQUIRED, every value COMPARED ─────────
    //
    // R2 wrote `stored !== null && supplied !== undefined && stored !== supplied`,
    // so an absent verified value silently skipped its own check. Absence is
    // now indistinguishable from disagreement, which is the only safe reading
    // of "the token did not prove this".
    if (
      input.verifiedConnectionId === null ||
      input.verifiedIssuer === null ||
      input.verifiedOrganizationId === null ||
      input.verifiedProviderSubject === null ||
      startRow.connection_id === null ||
      startRow.issuer === null ||
      startRow.provider_organization_id === null ||
      startRow.provider_subject === null ||
      String(startRow.connection_id) !== input.verifiedConnectionId ||
      String(startRow.issuer) !== input.verifiedIssuer ||
      String(startRow.provider_organization_id) !== input.verifiedOrganizationId ||
      String(startRow.provider_subject) !== input.verifiedProviderSubject
    ) {
      return fail('binding_mismatch');
    }

    // ── The chain, re-read at THIS instant ────────────────────────────────
    //
    // Tenant, connection, UserLink and the local session the step-up started
    // from. Suspending the tenant, disabling the connection, deactivating the
    // link or revoking the session between start and callback all mint
    // nothing — the grant would otherwise outlive the access it steps up.
    // `mfa_policy_certified` comes from this read, so the certification is a
    // fact at issue time rather than a claim made by the caller.
    const chain = await executor.query(
      `SELECT COALESCE(${EFFECTIVE_MFA_CERTIFICATION_SQL}, FALSE) AS mfa_policy_certified
         FROM reauthentication_transactions r
         JOIN identity_sessions s ON s.session_id = r.session_id
         JOIN user_links ul ON ul.user_link_id = r.user_link_id
         JOIN identity_provider_connections c ON c.connection_id = r.connection_id
        WHERE r.reauth_txn_id = $1
          AND s.user_link_id = r.user_link_id
          AND s.connection_id = r.connection_id
          AND s.issuer = r.issuer
          AND s.provider_organization_id = r.provider_organization_id
          AND s.provider_subject = r.provider_subject
          AND s.tenant_id IS NOT DISTINCT FROM r.tenant_id
          AND ${STEP_UP_IDENTITY_SQL}`,
      [txn.reauthTxnId],
    );
    if (chain.rows.length === 0) return fail('identity_chain_broken');

    // Assurance: freshness alone never satisfies a high-assurance action, and
    // the certification is the one the connection carries right now.
    const required = String(startRow.required_assurance ?? 'fresh_only') as AssuranceLevel;
    const certified = (chain.rows[0] as Row).mfa_policy_certified === true;
    if (required === 'fresh_and_mfa_policy' && !certified) {
      return fail('assurance_not_certified');
    }

    const grant = randomBytes(32).toString('base64url');
    const grantResult = await executor.query(
      `INSERT INTO reauthentication_grants
         (reauth_txn_id, tenant_id, user_link_id, action, resource_type, resource_id, grant_hash,
          expires_at, assurance_level, connection_id, mfa_policy_certified_at_issue)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW() + make_interval(secs => $8), $9, $10, $11)
       RETURNING expires_at`,
      [
        txn.reauthTxnId,
        txn.tenantId,
        txn.userLinkId,
        txn.action,
        txn.resourceType,
        txn.resourceId,
        sha256hex(grant),
        input.grantTtlSeconds ?? 120,
        required,
        String(startRow.connection_id),
        certified,
      ],
    );
    // The SUCCESS terminal, through the same one door every refusal uses: the
    // state, the reason, the instant and the single audit row are written
    // together, so a granted step-up cannot exist without its trail.
    await terminateWithin(executor, {
      reauthTxnId: txn.reauthTxnId,
      tenantId: txn.tenantId,
      userLinkId: txn.userLinkId,
      reason: 'granted',
      state: 'completed',
      details: {
        action: txn.action,
        resource_type: txn.resourceType,
        assurance_level: required,
        mfa_policy_certified: certified,
        freshness: 'fresh',
      },
    });
    return {
      transaction: { ...txn, state: 'completed' },
      grant,
      grantExpiresAt: ts((grantResult.rows[0] as Row).expires_at),
    };
  });
}

/** What a caller must state to spend a grant. Every field participates. */
export interface ReauthenticationGrantSpend {
  readonly grant: string;
  readonly tenantId: string;
  readonly userLinkId: string;
  readonly action: string;
  readonly resourceType?: string | null;
  readonly resourceId?: string | null;
  /**
   * FBL-020-R2: the assurance the OPERATION demands. A `fresh_only` grant
   * must never authorize a `fresh_and_mfa_policy` operation — the predicate
   * below refuses it in the same atomic UPDATE that spends it, so there is no
   * window in which a weaker grant is briefly accepted.
   */
  readonly requiredAssurance?: AssuranceLevel;
}

/**
 * Atomic single consumption, executed on the CALLER's executor so the spend
 * commits (or rolls back) with the business action it authorizes. The grant
 * must match tenant, user, action AND resource — a grant minted for one thing
 * can never pay for another. Returns the id of the grant it SPENT, or null
 * (fail closed) on any miss, replay included.
 *
 * FBL-020-R3: the id is returned because a caller that must RECORD which grant
 * paid for a change — support approval writes it to
 * `support_access_requests.approval_grant_id` — would otherwise need its own
 * query to find out, and the R3 review showed exactly where that leads: a
 * second, hand-written grant predicate that accepted expired, reusable and
 * wrongly-bound grants. There is ONE predicate, below, and both public entry
 * points are it.
 */
export async function consumeReauthenticationGrantReturningId(
  executor: Executor,
  input: ReauthenticationGrantSpend,
): Promise<string | null> {
  if (typeof input.grant !== 'string' || input.grant.length === 0) return null;
  const required: AssuranceLevel = input.requiredAssurance ?? 'fresh_only';
  const result = await executor.query(
    `UPDATE reauthentication_grants
        SET consumed_at = NOW()
      WHERE grant_hash = $1
        AND tenant_id = $2
        AND user_link_id = $3
        AND action = $4
        AND resource_type IS NOT DISTINCT FROM $5
        AND resource_id IS NOT DISTINCT FROM $6
        AND consumed_at IS NULL
        AND expires_at > NOW()
        -- ASSURANCE FLOOR: a fresh_only grant satisfies only a fresh_only
        -- operation. Requiring fresh_and_mfa_policy admits only a grant
        -- minted at that level, and the grant must still have been issued
        -- against a connection that certified the policy at issue time.
        AND (
          $7 = 'fresh_only'
          OR (assurance_level = 'fresh_and_mfa_policy' AND mfa_policy_certified_at_issue = TRUE)
        )
      RETURNING grant_id, assurance_level`,
    [
      sha256hex(input.grant),
      input.tenantId,
      input.userLinkId,
      input.action,
      input.resourceType ?? null,
      input.resourceId ?? null,
      required,
    ],
  );
  if ((result.rowCount ?? 0) !== 1) return null;
  const row = result.rows[0] as Row | undefined;
  if (row === undefined || row.grant_id === null || row.grant_id === undefined) return null;
  const grantId = String(row.grant_id);
  // FBL-020-R4 section 3 — GRANT CONSUMPTION IS AN AUDITED TRANSITION.
  //
  // Spending a step-up grant is the moment a sensitive action becomes permitted.
  // R3 recorded the grant being MINTED and never recorded it being SPENT, so the
  // trail showed a step-up had been performed and not what it paid for. The row
  // is written on the caller's executor, which is the business transaction the
  // spend belongs to: if the action rolls back, so does its audit.
  await executor.query(
    `INSERT INTO audit_events
       (tenant_id, event_type, entity_type, entity_id, actor_user_id, details)
     VALUES ($1, 'identity.reauthentication.grant_consumed', 'reauth_grant', $2, $3, $4)`,
    [
      input.tenantId,
      grantId,
      input.userLinkId,
      JSON.stringify({
        action: input.action,
        resource_type: input.resourceType ?? null,
        required_assurance: required,
        assurance_level: String(row.assurance_level),
      }),
    ],
  );
  return grantId;
}

/**
 * The same single consumption, for callers that only need to know whether the
 * spend happened. It DELEGATES — it does not restate the predicate.
 */
export async function consumeReauthenticationGrant(
  executor: Executor,
  input: ReauthenticationGrantSpend,
): Promise<boolean> {
  return (await consumeReauthenticationGrantReturningId(executor, input)) !== null;
}

/** How many stale step-ups ONE pass will age. Bounded on purpose. */
export const REAUTHENTICATION_EXPIRY_DEFAULT_BATCH = 200;
const REAUTHENTICATION_EXPIRY_MAX_BATCH = 1000;

/**
 * FBL-020-R5 §1.6 — THE STEP-UP EXPIRY SWEEP, under exactly the same three
 * properties and for exactly the same reasons as the login sweep in
 * `login-transaction.ts`; the reasoning is written out once there and not restated.
 *
 * In short: one row claimed and transitioned per short transaction, at most `limit`
 * times; `state = 'started'` is both the claim predicate and the predicate the
 * write invalidates, which is what makes a repeat pass and a concurrent pass no-ops
 * for the same reason; `FOR UPDATE SKIP LOCKED` is liveness, not the guarantee.
 * R4's version was one unbounded UPDATE over the whole backlog.
 *
 * Grants need no sweep — consumption and expiry are decided from their own columns
 * at read time — so this must not be read as retiring them.
 *
 * R4 section 3's property is preserved: the sweep records WHY and WHEN and writes
 * one audit row per transaction it expires, in the same transaction as the state
 * change. An expiry that left no trail made "this step-up was never completed" a
 * fact an operator could only infer from a missing grant.
 */
export async function expireStaleReauthenticationTransactions(options?: {
  limit?: number;
}): Promise<number> {
  const requested = options?.limit ?? REAUTHENTICATION_EXPIRY_DEFAULT_BATCH;
  if (
    !Number.isInteger(requested) ||
    requested < 1 ||
    requested > REAUTHENTICATION_EXPIRY_MAX_BATCH
  ) {
    throw new RangeError(
      `reauthentication expiry batch limit must be an integer in 1..${REAUTHENTICATION_EXPIRY_MAX_BATCH}`,
    );
  }
  let recorded = 0;
  for (let i = 0; i < requested; i += 1) {
    const aged = await withTransaction<boolean>(async (executor) => {
      const expired = await executor.query(
        `UPDATE reauthentication_transactions
            SET state = 'expired', terminal_reason = 'expired', terminal_at = NOW(),
                updated_at = NOW()
          WHERE reauth_txn_id = (
            SELECT rt.reauth_txn_id
              FROM reauthentication_transactions rt
             WHERE rt.state = 'started'
               AND rt.expires_at < NOW()
             ORDER BY rt.expires_at
             FOR UPDATE SKIP LOCKED
             LIMIT 1
          )
          RETURNING reauth_txn_id, tenant_id, user_link_id, action, resource_type`,
      );
      if (expired.rows.length === 0) return false;
      const raw = expired.rows[0] as Row;
      await auditReauthentication(executor, {
        tenantId: String(raw.tenant_id),
        reauthTxnId: String(raw.reauth_txn_id),
        userLinkId: raw.user_link_id === null ? null : String(raw.user_link_id),
        eventType: 'identity.reauthentication.expired',
        details: {
          reason: 'expired',
          terminal_state: 'expired',
          action: String(raw.action),
          resource_type: raw.resource_type ?? null,
        },
      });
      return true;
    });
    if (!aged) break;
    recorded += 1;
  }
  return recorded;
}
