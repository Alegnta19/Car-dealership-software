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
import { createHash, randomBytes } from 'node:crypto';
import { query, withTransaction, type Executor } from '@dealer/database';

function sha256hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
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
  const result = await query(
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
        created_by_user_link_id)
     SELECT d.tenant_id, d.user_link_id, d.session_id, $3, $4, $5, $6,
            NOW() + make_interval(secs => $7), $8, $9,
            d.connection_id, d.issuer, d.provider_organization_id, d.provider_subject,
            d.user_link_id
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
    ],
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0] as Row;
  return {
    transaction: mapTxn(row),
    nonce,
    oidcNonce,
    binding: {
      connectionId: String(row.connection_id),
      issuer: String(row.issuer),
      providerOrganizationId: String(row.provider_organization_id),
      providerSubject: String(row.provider_subject),
      sessionId: String(row.session_id),
    },
  };
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
    const found = await executor.query(
      `SELECT * FROM reauthentication_transactions
        WHERE nonce_hash = $1 AND user_link_id = $2 AND state = 'started' AND expires_at > NOW()
        FOR UPDATE`,
      [sha256hex(input.nonce), input.userLinkId],
    );
    if (found.rows.length === 0) return null;
    const startRow = found.rows[0] as Row;
    const txn = mapTxn(startRow);

    const fail = async (): Promise<null> => {
      await executor.query(
        `UPDATE reauthentication_transactions SET state = 'failed' WHERE reauth_txn_id = $1`,
        [txn.reauthTxnId],
      );
      return null;
    };

    // stale authentication — the person did NOT freshly re-authenticate
    if (input.verifiedAuthTime.getTime() < txn.startedAt.getTime() - skewMs) {
      return fail();
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
      return fail();
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
      return fail();
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
      `SELECT COALESCE(c.mfa_policy_certified, FALSE) AS mfa_policy_certified
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
    if (chain.rows.length === 0) return fail();

    // Assurance: freshness alone never satisfies a high-assurance action, and
    // the certification is the one the connection carries right now.
    const required = String(startRow.required_assurance ?? 'fresh_only') as AssuranceLevel;
    const certified = (chain.rows[0] as Row).mfa_policy_certified === true;
    if (required === 'fresh_and_mfa_policy' && !certified) {
      return fail();
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
    await executor.query(
      `UPDATE reauthentication_transactions
          SET state = 'completed', completed_at = NOW() WHERE reauth_txn_id = $1`,
      [txn.reauthTxnId],
    );
    await executor.query(
      `INSERT INTO audit_events (tenant_id, event_type, entity_type, entity_id, actor_user_id, details)
       VALUES ($1, 'identity.reauthentication.granted', 'reauth_transaction', $2, $3, $4)`,
      [
        txn.tenantId,
        txn.reauthTxnId,
        txn.userLinkId,
        JSON.stringify({
          action: txn.action,
          resource_type: txn.resourceType,
          assurance_level: required,
          mfa_policy_certified: certified,
          freshness: 'fresh',
        }),
      ],
    );
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
      RETURNING grant_id`,
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
  return String(row.grant_id);
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

/**
 * Bookkeeping hygiene for the scheduled aggregator: transactions that were
 * started but never completed move to 'expired'. Grants need no sweep —
 * consumption and expiry are decided by their own columns at read time.
 */
export async function expireStaleReauthenticationTransactions(): Promise<number> {
  const result = await query(
    `UPDATE reauthentication_transactions SET state = 'expired'
      WHERE state = 'started' AND expires_at < NOW()`,
  );
  return result.rowCount ?? 0;
}
