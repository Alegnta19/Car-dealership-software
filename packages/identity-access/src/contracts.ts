/**
 * Provider-neutral identity contracts (FBL-020). NOTHING in this file — or in
 * any export of this package — may mention a WorkOS SDK type: the adapter in
 * ./provider/workos is the only place the SDK exists, and the architecture
 * rule `workos-sdk-confined-to-adapter` enforces it.
 */

export const IDENTITY_PROVIDER_WORKOS = 'workos' as const;
export type IdentityProviderKind = typeof IDENTITY_PROVIDER_WORKOS;

/**
 * FBL-020-R3 — the shared identity RECORD shapes.
 *
 * They live here, beside the other provider-neutral contracts, because the
 * module that OWNS the writes (./mutations) and the modules that own the READS
 * (./user-link, ./support-access) both need them. Declaring them in a reading
 * module and importing them back into the writing one would be a dependency
 * cycle — and the architecture gate is right to refuse it.
 */
export type ActorScope = 'dealership' | 'platform';
export type UserLinkStatus = 'pending' | 'activated' | 'deactivated';

/** The internal record binding a provider identity to a tenant (or platform). */
export interface UserLink {
  readonly userLinkId: string;
  readonly actorScope: ActorScope;
  readonly tenantId: string | null;
  readonly provider: IdentityProviderKind;
  readonly providerUserId: string;
  readonly email: string | null;
  readonly displayName: string | null;
  readonly status: UserLinkStatus;
  readonly activatedAt: Date | null;
}

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

/** Internal administrative role names introduced by FBL-020. */
export const TENANT_ADMIN_ROLE = 'tenant_admin' as const;
export const PLATFORM_ADMIN_ROLE = 'platform_admin' as const;
export const PLATFORM_SUPPORT_ROLE = 'platform_support' as const;

/**
 * FBL-020-R3 correction F1 — the roles that constitute PLATFORM-SUPPORT
 * AUTHORITY, written ONCE.
 *
 * Three things ask "does this person hold platform-support authority?": the
 * published `platform.support.request` action (whose `allowedRoles` IS this
 * list), the mutation gate that admits filing, approval and session start, and
 * the policy engine's support branch, which re-judges the authority of a LIVE
 * session's actor on every single decision. They must agree, so the list is
 * declared here instead of being restated three times.
 */
export const PLATFORM_SUPPORT_AUTHORITY_ROLES = [
  PLATFORM_SUPPORT_ROLE,
  PLATFORM_ADMIN_ROLE,
] as const;

/**
 * FBL-020-R3 — provider-neutral IMPERSONATION classification.
 *
 * A provider may let its own staff act as one of our users (WorkOS calls this
 * impersonation; the resulting tokens are otherwise ordinary). This platform
 * refuses such a session on every credential path, so the fact must cross the
 * provider boundary — but the impersonator's identity must NOT. Exactly two
 * booleans travel: whether the session is impersonated at all, and whether an
 * impersonator EMAIL was present to be classified. The email itself is read,
 * tested for presence, and dropped inside the adapter/verifier; it is never
 * returned, stored or logged.
 */
export interface ImpersonationClassification {
  /** True when the provider says this session acts on behalf of someone. */
  readonly impersonated: boolean;
  /** True only when an impersonator email existed. The value never escapes. */
  readonly impersonatorEmailPresent: boolean;
}

/** The CLOSED value: no impersonation asserted, nothing to classify. */
export const NOT_IMPERSONATED: ImpersonationClassification = Object.freeze({
  impersonated: false,
  impersonatorEmailPresent: false,
});

/**
 * The verified content of a provider access token AFTER standards-based
 * verification. Role material from the token is surfaced ONLY as
 * `roleHints` — display hints, never inputs to authorization; the policy
 * engine reads database RoleBindings instead.
 */
export interface VerifiedAccessToken {
  readonly providerUserId: string;
  readonly providerSessionId: string;
  /** Always present: the verifier requires a bounded non-empty org_id. */
  readonly organizationId: string;
  readonly authTime: Date;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly roleHints: readonly string[];
  /**
   * FBL-020-R3 — the SHA-256 hex digest of the `nonce` claim the provider
   * returned, or null when the token carried none.
   *
   * The DIGEST rather than the value, deliberately. A reauthentication stores
   * `oidc_nonce_hash` and nothing else, so the completion compares digest
   * against digest and the raw nonce never leaves the verifier — it cannot
   * reach a log line, a response body, an error or the database. `null` is the
   * CLOSED value: a caller that demands nonce binding treats it as a failure,
   * never as "no comparison needed".
   */
  readonly nonceDigest: string | null;
  /**
   * R3: what the TOKEN itself claims about impersonation. Every credential
   * path (login, bearer, refresh, reauthentication) refuses an impersonated
   * token — the verifier only reports the fact, it does not decide.
   */
  readonly impersonation: ImpersonationClassification;
}

/** Single, deliberately unspecific verification failure (fail closed). */
export class TokenVerificationError extends Error {
  readonly code = 'token_invalid' as const;

  /**
   * Diagnostic detail for STRUCTURED logging through safeError(); it must
   * never be echoed into an HTTP response body.
   */
  readonly internalReason: string;

  constructor(internalReason: string, options?: { cause?: unknown }) {
    super('access token verification failed', options);
    this.name = 'TokenVerificationError';
    this.internalReason = internalReason;
  }
}

/**
 * What a provider adapter must offer the /auth routes. Shapes are plain
 * strings and URLs — the SDK stays behind the port.
 */
export interface AuthorizationRequest {
  readonly state: string;
  readonly codeChallenge: string;
  /** provider organization to log into, when known up front */
  readonly organizationId?: string;
  /** force fresh authentication (reauthentication uses 0) */
  readonly maxAgeSeconds?: number;
  /**
   * The OIDC nonce the provider must echo back in the id/access token. Bound
   * to ONE single-use transaction; never logged, never reused as state.
   */
  readonly nonce?: string;
  /**
   * Which registered callback this leg returns to. Login and
   * REAUTHENTICATION are different routes, so they need different redirect
   * URIs — sending the reauth leg to the login callback strands it there and
   * no grant can ever be minted. Defaults to the login redirect.
   */
  readonly redirectUri?: string;
}

export interface CodeExchangeResult {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly providerUserId: string;
  readonly providerSessionId: string | null;
  readonly organizationId: string | null;
  readonly email: string | null;
  readonly displayName: string | null;
  /** R3: whether this authentication was an impersonation. Login refuses it. */
  readonly impersonation: ImpersonationClassification;
}

/**
 * FBL-020-R3 — the result of a REAL provider refresh exchange.
 *
 * `refreshToken` is the REPLACEMENT: the presented one is spent the moment the
 * provider answers, so the caller must persist this value (sealed) atomically
 * or revoke. Nothing here is a raw provider profile — no email, no name, no
 * impersonator identity.
 */
export interface ProviderRefreshResult {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly providerUserId: string;
  readonly providerSessionId: string | null;
  readonly organizationId: string | null;
  readonly impersonation: ImpersonationClassification;
}

/**
 * The only two failure shapes a caller can act on differently:
 *
 *   - `definitive` — the provider ANSWERED and refused. The refresh token is
 *     dead; the local session must die with it.
 *   - `transient`  — no answer we can trust (network, timeout, rate limit,
 *     provider 5xx, or anything unrecognised). Destroying session state here
 *     would turn a provider hiccup into a forced logout for every user, so
 *     the session is left exactly as it was.
 */
export type ProviderRefreshFailureKind = 'definitive' | 'transient';

export class ProviderRefreshError extends Error {
  readonly code = 'provider_refresh_failed' as const;

  readonly kind: ProviderRefreshFailureKind;

  /** Diagnostic detail for STRUCTURED logs only; never echoed outward. */
  readonly internalReason: string;

  constructor(
    kind: ProviderRefreshFailureKind,
    internalReason: string,
    options?: { cause?: unknown },
  ) {
    super('provider refresh failed', options);
    this.name = 'ProviderRefreshError';
    this.kind = kind;
    this.internalReason = internalReason;
  }
}

export interface IdentityProviderPort {
  buildAuthorizationUrl(request: AuthorizationRequest): string;
  exchangeCode(input: { code: string; codeVerifier: string }): Promise<CodeExchangeResult>;
  /**
   * R3: the REAL refresh exchange. Throws ProviderRefreshError — and only
   * ProviderRefreshError — so the caller can distinguish "the provider said
   * no" from "the provider did not answer" without ever seeing an SDK type.
   *
   * R3 correction D1: `signal` is the CALLER's deadline. The exchange happens on
   * the live request path, so the caller bounds it; an implementation that reaches
   * the network passes the signal through, so an abandoned exchange stops
   * consuming a socket and cannot spend the single-use refresh token in the
   * background after the caller has given up on it. An implementation must still
   * enforce a bound of its OWN — the adapter does — because a port may never
   * assume its caller set one.
   */
  refreshSession(input: {
    refreshToken: string;
    signal?: AbortSignal;
  }): Promise<ProviderRefreshResult>;
  buildLogoutUrl(input: { providerSessionId: string }): string;
}
