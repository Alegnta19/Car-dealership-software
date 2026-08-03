/**
 * Standards-based access-token verification (FBL-020, ADR-006).
 *
 * Every trust decision is pinned to CONFIGURATION, never to token content:
 * the issuer, the audience, the JWKS URL and the algorithm allowlist all come
 * from the caller's configuration. The `kid` header selects a key from the
 * configured JWKS only — a token can never steer verification to a different
 * key set. jose's remote JWK set provides the cache, the single bounded
 * refetch on an unknown kid (cooldown-limited, so a stream of forged kids
 * cannot stampede the provider), and key rotation without a restart.
 *
 * Failure model: ONE error type, fail closed. Internal detail rides on the
 * error object for structured logs; callers must never echo it outward.
 */
import { timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { TokenVerificationError, type VerifiedAccessToken } from '../contracts';

export interface AccessTokenVerifierOptions {
  readonly issuer: string;
  readonly audience: string;
  readonly jwksUri: string;
  /** Asymmetric allowlist. HS* and 'none' are structurally impossible. */
  readonly algorithms?: readonly string[];
  readonly clockSkewSeconds?: number;
  readonly jwksCacheMaxAgeMs?: number;
  /** Minimum time between JWKS refetches triggered by unknown kids. */
  readonly jwksCooldownMs?: number;
  readonly fetchTimeoutMs?: number;
}

export interface VerifyOptions {
  /**
   * Reauthentication proof: auth_time must be at or after this instant
   * (minus the bounded skew). Used with provider max_age=0 flows.
   */
  readonly requireAuthTimeAtOrAfter?: Date;
  /**
   * FBL-020-R1 section D: the OIDC nonce this transaction demands back. The
   * token's `nonce` claim must be present and equal. Missing, mismatched or
   * replayed values fail closed, and the value is never logged.
   */
  readonly requireNonce?: string;
}

export interface AccessTokenVerifier {
  verify(token: string, options?: VerifyOptions): Promise<VerifiedAccessToken>;
}

const DEFAULT_ALGORITHMS = ['RS256'] as const;

function claimString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TokenVerificationError(`claim ${name} missing or not a non-empty string`);
  }
  return value;
}

function claimEpochSeconds(value: unknown, name: string): Date {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TokenVerificationError(`claim ${name} missing or not a number`);
  }
  return new Date(value * 1000);
}

export function createAccessTokenVerifier(
  options: AccessTokenVerifierOptions,
): AccessTokenVerifier {
  const algorithms = [...(options.algorithms ?? DEFAULT_ALGORITHMS)];
  for (const alg of algorithms) {
    // Symmetric or unsigned algorithms in the allowlist would defeat the
    // entire model — refuse to construct.
    if (alg === 'none' || alg.startsWith('HS')) {
      throw new Error(`refusing symmetric or unsigned algorithm in allowlist: ${alg}`);
    }
  }
  const clockTolerance = options.clockSkewSeconds ?? 60;
  const jwks = createRemoteJWKSet(new URL(options.jwksUri), {
    cacheMaxAge: options.jwksCacheMaxAgeMs ?? 10 * 60_000,
    cooldownDuration: options.jwksCooldownMs ?? 30_000,
    timeoutDuration: options.fetchTimeoutMs ?? 5_000,
  });

  return {
    async verify(token: string, verifyOptions?: VerifyOptions): Promise<VerifiedAccessToken> {
      let payload;
      try {
        ({ payload } = await jwtVerify(token, jwks, {
          issuer: options.issuer,
          audience: options.audience,
          algorithms,
          clockTolerance,
          // org_id is REQUIRED here, in the verifier itself: this platform
          // admits organization members only, and a token without an
          // organization must never reach a later, softer check.
          requiredClaims: ['exp', 'iat', 'sub', 'sid', 'auth_time', 'org_id'],
        }));
      } catch (err) {
        if (err instanceof TokenVerificationError) throw err;
        throw new TokenVerificationError('signature, header or registered-claim rejection', {
          cause: err,
        });
      }

      const providerUserId = claimString(payload.sub, 'sub');
      const providerSessionId = claimString(payload.sid, 'sid');
      const authTime = claimEpochSeconds(payload.auth_time, 'auth_time');
      const issuedAt = claimEpochSeconds(payload.iat, 'iat');
      const expiresAt = claimEpochSeconds(payload.exp, 'exp');
      // Bounded, non-empty, and mandatory.
      const organizationId = claimString(payload.org_id, 'org_id');
      if (organizationId.length > 200) {
        throw new TokenVerificationError('claim org_id exceeds the bounded length');
      }

      if (verifyOptions?.requireNonce !== undefined) {
        const presented = payload.nonce;
        if (typeof presented !== 'string' || presented.length === 0) {
          throw new TokenVerificationError('claim nonce missing');
        }
        // constant-time compare; the value itself never reaches a log line
        const expected = Buffer.from(verifyOptions.requireNonce, 'utf8');
        const actual = Buffer.from(presented, 'utf8');
        if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
          throw new TokenVerificationError('claim nonce mismatch');
        }
      }

      if (verifyOptions?.requireAuthTimeAtOrAfter !== undefined) {
        const earliest = verifyOptions.requireAuthTimeAtOrAfter.getTime() - clockTolerance * 1000;
        if (authTime.getTime() < earliest) {
          throw new TokenVerificationError('auth_time predates the reauthentication transaction');
        }
      }

      // Display hints ONLY. Authorization never reads these.
      const roleHints: string[] = [];
      if (typeof payload.role === 'string' && payload.role.length > 0) roleHints.push(payload.role);
      if (Array.isArray(payload.permissions)) {
        for (const p of payload.permissions) {
          if (typeof p === 'string' && p.length > 0) roleHints.push(p);
        }
      }

      return {
        providerUserId,
        providerSessionId,
        organizationId,
        authTime,
        issuedAt,
        expiresAt,
        roleHints,
      };
    },
  };
}
