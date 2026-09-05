/**
 * FBL-140 — DIGESTS, TOKENS AND THE ONE COMPARISON THAT MUST NOT LEAK TIME.
 *
 * Everything this phase calls evidence is a sha256 over bytes it can name:
 * a rendered document is its content digest, a package is the digest of its
 * documents' digests in order, a signature is the digest of exactly what was
 * signed and by whom. This module is the only place those digests are computed,
 * so two callers cannot disagree about what "the package hash" covers.
 *
 * TOKENS ARE NEVER STORED. A signer's link and an artifact grant carry a random
 * value the database holds only as its digest — a leaked table gives an
 * attacker nothing to present. The raw value exists once, in the response that
 * hands it to the lane it belongs to, and is gone.
 *
 * THE PROVIDER'S SIGNATURE IS COMPARED IN CONSTANT TIME. A byte-by-byte
 * comparison that stops at the first difference tells a caller how many bytes
 * they got right; `timingSafeEqual` does not.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { canonicalize } from '@dealer/desking';

const HEX64 = /^[0-9a-f]{64}$/;

export function sha256Hex(input: Buffer | string): string {
  return createHash('sha256').update(input).digest('hex');
}

/** The digest of a value in canonical form: same value, same digest, any machine. */
export function digestOf(value: unknown): string {
  return sha256Hex(canonicalize(value));
}

/**
 * THE PACKAGE HASH: the digest of the ordered list of document digests. Order
 * matters — the same documents in another order are a different package — and
 * the list form means a reader with the documents can recompute it without the
 * database.
 */
export function packageHashOf(documentDigests: readonly string[]): string {
  for (const d of documentDigests) {
    if (!HEX64.test(d)) throw new TypeError(`packageHashOf: ${d} is not a sha256 digest`);
  }
  return sha256Hex(documentDigests.join('\n'));
}

/** 32 random bytes, base64url: the raw form of a signer link or an artifact grant. */
export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

/** What the database holds instead of the token. */
export function tokenDigest(token: string): string {
  return sha256Hex(token);
}

/**
 * A lane token carries the dealership it belongs to in the clear, joined to the
 * random part with a dot, so an unauthenticated route can set the tenant
 * context BEFORE it looks the digest up under row security. The tenant id
 * discloses nothing a caller could use without the random part, and the random
 * part is checked only as its digest.
 */
export function composeLaneToken(tenantId: string, token: string): string {
  return `${tenantId}.${token}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function splitLaneToken(value: string): { tenantId: string; token: string } | null {
  const dot = value.indexOf('.');
  if (dot < 0) return null;
  const tenantId = value.slice(0, dot);
  const token = value.slice(dot + 1);
  if (!UUID_RE.test(tenantId) || !/^[A-Za-z0-9_-]{32,64}$/.test(token)) return null;
  return { tenantId: tenantId.toLowerCase(), token };
}

export function hmacSha256Hex(secret: string, body: Buffer | string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

/** True when two hex digests are equal, without saying where they differ. */
export function digestsEqual(a: string, b: string): boolean {
  if (!HEX64.test(a) || !HEX64.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

export function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && HEX64.test(value);
}
