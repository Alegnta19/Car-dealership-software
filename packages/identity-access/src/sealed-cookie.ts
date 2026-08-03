/**
 * Sealed (encrypted + authenticated) cookie payloads for the OAuth
 * transaction round trip (state, PKCE verifier, reauth nonce). AES-256-GCM
 * under a key derived from the configured cookie password; tampering or a
 * stale seal opens to null — every failure is indistinguishable and closed.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

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
  options: { maxAgeSeconds: number },
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
    const iat = typeof payload.iat === 'number' ? payload.iat : 0;
    if (Math.floor(Date.now() / 1000) - iat > options.maxAgeSeconds) return null;
    return payload;
  } catch {
    return null;
  }
}
