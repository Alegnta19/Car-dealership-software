/**
 * Sealed (encrypted + authenticated) cookie payloads for the OAuth
 * transaction round trip (state, PKCE verifier, reauth nonce). AES-256-GCM
 * under a key derived from the configured cookie password; tampering or a
 * stale seal opens to null — every failure is indistinguishable and closed.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * FBL-020-R3: the ONLY allowance made for clock drift when judging a seal's
 * own timestamp. It exists because two hosts may disagree by a little; it is
 * not a window in which the future is accepted as the past. Callers that hold
 * the configured OIDC skew pass it, so the platform has ONE tolerance rather
 * than one per primitive.
 */
const DEFAULT_CLOCK_TOLERANCE_SECONDS = 60;

export interface OpenCookieOptions {
  /** How old a seal may be, measured from its own `iat`. */
  readonly maxAgeSeconds: number;
  /** Clock drift allowance for a seal stamped ahead of us. Defaults to 60s. */
  readonly clockToleranceSeconds?: number;
}

function keyFor(cookiePassword: string): Buffer {
  return createHash('sha256').update(cookiePassword, 'utf8').digest();
}

export function sealCookiePayload(
  payload: Record<string, unknown>,
  cookiePassword: string,
): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFor(cookiePassword), iv);
  const plaintext = Buffer.from(
    JSON.stringify({ ...payload, iat: Math.floor(Date.now() / 1000) }),
    'utf8',
  );
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
}

export function openCookiePayload(
  sealed: string,
  cookiePassword: string,
  options: OpenCookieOptions,
): Record<string, unknown> | null {
  try {
    const raw = Buffer.from(sealed, 'base64url');
    if (raw.length < 12 + 16 + 2) return null;
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const encrypted = raw.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', keyFor(cookiePassword), iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString(
      'utf8',
    );
    const payload = JSON.parse(plaintext) as Record<string, unknown>;
    // A seal with no usable timestamp has no age, and something with no age
    // can never go stale. Refuse it rather than treat it as brand new.
    const iat = payload.iat;
    if (typeof iat !== 'number' || !Number.isFinite(iat)) return null;
    const now = Math.floor(Date.now() / 1000);
    // FBL-020-R3: a seal stamped in the FUTURE is refused. Without this the
    // staleness test below is trivially defeated — `now - iat` goes negative,
    // so a forward-dated seal never expires and one issued by a host with a
    // running-fast clock outlives its whole window. The allowance is the
    // configured clock tolerance and nothing else.
    const tolerance = options.clockToleranceSeconds ?? DEFAULT_CLOCK_TOLERANCE_SECONDS;
    if (iat - now > tolerance) return null;
    if (now - iat > options.maxAgeSeconds) return null;
    return payload;
  } catch {
    return null;
  }
}
