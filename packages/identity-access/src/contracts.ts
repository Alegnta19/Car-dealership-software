/**
 * Provider-neutral identity contracts (FBL-020). NOTHING in this file — or in
 * any export of this package — may mention a WorkOS SDK type: the adapter in
 * ./provider/workos is the only place the SDK exists, and the architecture
 * rule `workos-sdk-confined-to-adapter` enforces it.
 */

export const IDENTITY_PROVIDER_WORKOS = 'workos' as const;
export type IdentityProviderKind = typeof IDENTITY_PROVIDER_WORKOS;

/** Internal administrative role names introduced by FBL-020. */
export const TENANT_ADMIN_ROLE = 'tenant_admin' as const;
export const PLATFORM_ADMIN_ROLE = 'platform_admin' as const;
export const PLATFORM_SUPPORT_ROLE = 'platform_support' as const;

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
}

export interface IdentityProviderPort {
  buildAuthorizationUrl(request: AuthorizationRequest): string;
  exchangeCode(input: { code: string; codeVerifier: string }): Promise<CodeExchangeResult>;
  buildLogoutUrl(input: { providerSessionId: string }): string;
}
