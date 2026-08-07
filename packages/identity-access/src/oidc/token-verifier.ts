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
import { createHash, timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import {
  NOT_IMPERSONATED,
  TokenVerificationError,
  type ImpersonationClassification,
  type VerifiedAccessToken,
} from '../contracts';

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * FBL-020-R3 — does this token say it is being used ON BEHALF OF someone?
 *
 * Three carriers are recognised, any one of which classifies the token as
 * impersonated: the RFC 8693 `act` (actor) claim, a provider-specific
 * `impersonator` claim, and an authentication method of 'Impersonation'. The
 * actor's EMAIL is examined only to record that one existed — the value is
 * never returned, so it cannot reach a response, a log or the database.
 *
 * Reporting is all this does. Refusing is the caller's job, and every
 * credential path (login, bearer, refresh, reauthentication) refuses.
 */
function classifyImpersonation(payload: Record<string, unknown>): ImpersonationClassification {
  const carrier = isRecord(payload.act)
    ? payload.act
    : isRecord(payload.impersonator)
      ? payload.impersonator
      : null;
  if (carrier !== null) {
    const email = carrier.email;
    return {
      impersonated: true,
      impersonatorEmailPresent: typeof email === 'string' && email.length > 0,
    };
  }
  // A bare non-empty scalar in either claim, or the explicit method, still
  // asserts impersonation — it just carries no email to classify.
  const scalarActor =
    (typeof payload.act === 'string' && payload.act.length > 0) ||
    (typeof payload.impersonator === 'string' && payload.impersonator.length > 0) ||
    payload.authentication_method === 'Impersonation';
  return scalarActor ? { impersonated: true, impersonatorEmailPresent: false } : NOT_IMPERSONATED;
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

      // ── FBL-020-R3: IMPOSSIBLE TIMES ────────────────────────────────────
      //
      // jose enforces `exp` and `nbf` against the clock. It does NOT judge
      // `iat`, `auth_time`, or whether the claims are coherent with each
      // other — so a token that says it was issued next week, or that the
      // person authenticated next week, or that it expired before it was
      // issued, verified cleanly and its times then flowed into session
      // freshness and reauthentication proofs.
      //
      // The ONE allowance is the CONFIGURED clock tolerance, the same bound
      // jose is given. It exists for hosts that disagree by a little; it is
      // not a licence to accept the future as the past. Every rejection is
      // the same closed failure, and no claim value is ever echoed.
      const nowMs = Date.now();
      const toleranceMs = clockTolerance * 1000;
      if (issuedAt.getTime() > nowMs + toleranceMs) {
        throw new TokenVerificationError('claim iat lies in the future beyond the clock tolerance');
      }
      if (authTime.getTime() > nowMs + toleranceMs) {
        throw new TokenVerificationError(
          'claim auth_time lies in the future beyond the clock tolerance',
        );
      }
      // A credential that expires before it exists is not a credential.
      if (expiresAt.getTime() < issuedAt.getTime() - toleranceMs) {
        throw new TokenVerificationError('claim exp precedes claim iat beyond the clock tolerance');
      }

      // The returned nonce, reduced to a DIGEST here and nowhere else. The raw
      // claim is read inside this function and dropped; only the digest travels
      // outward, which is what lets a caller compare it against a stored
      // `*_nonce_hash` without the value existing anywhere it could leak.
      const presentedNonce = payload.nonce;
      const nonceDigest =
        typeof presentedNonce === 'string' && presentedNonce.length > 0
          ? createHash('sha256').update(presentedNonce, 'utf8').digest('hex')
          : null;

      if (verifyOptions?.requireNonce !== undefined) {
        if (typeof presentedNonce !== 'string' || presentedNonce.length === 0) {
          throw new TokenVerificationError('claim nonce missing');
        }
        // constant-time compare; the value itself never reaches a log line
        const expected = Buffer.from(verifyOptions.requireNonce, 'utf8');
        const actual = Buffer.from(presentedNonce, 'utf8');
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
        nonceDigest,
        impersonation: classifyImpersonation(payload),
      };
    },
  };
}
