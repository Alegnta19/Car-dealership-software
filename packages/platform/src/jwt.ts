/**
 * @dealer/platform — minimal HS256 JWT verification.
 *
 * Pure verification logic: no Express types, no request objects. The API middleware
 * (apps/api) adapts this to HTTP. Secret resolution stays here so business code never
 * touches it.
 */
import { createHmac, timingSafeEqual } from 'crypto';
import { getConfig } from './config';
import { UnauthorizedError } from './errors';

function b64urlJson(segment: string): any {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function jwtSecret(): string {
  return getConfig().jwtSecret;
}

/**
 * Minimal HS256 verifier. Deliberately rejects any `alg` other than HS256 — accepting
 * the token's own algorithm claim is the classic JWT confusion bug.
 */
export function verifyJwtHs256(token: string): Record<string, any> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new UnauthorizedError('Malformed bearer token');

  const [headerSegment, payloadSegment, signatureSegment] = parts;

  let header: Record<string, any>;
  let payload: Record<string, any>;
  try {
    header = b64urlJson(headerSegment);
    payload = b64urlJson(payloadSegment);
  } catch {
    throw new UnauthorizedError('Malformed bearer token');
  }

  // `JSON.parse` happily returns null or a scalar for well-formed input like "null"
  // or "1", which would then throw a TypeError on property access and surface as a
  // 500 to an unauthenticated caller.
  if (!isObject(header) || !isObject(payload))
    throw new UnauthorizedError('Malformed bearer token');
  if (header.alg !== 'HS256') throw new UnauthorizedError('Unsupported token algorithm');

  const expected = createHmac('sha256', jwtSecret())
    .update(`${headerSegment}.${payloadSegment}`)
    .digest('base64url');
  const provided = Buffer.from(signatureSegment, 'utf8');
  const computed = Buffer.from(expected, 'utf8');
  if (provided.length !== computed.length || !timingSafeEqual(provided, computed)) {
    throw new UnauthorizedError('Invalid token signature');
  }

  // `exp` is mandatory: treating it as optional would make a token without one a
  // permanent credential that no rotation or revocation window can reach.
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) {
    throw new UnauthorizedError('Token is missing an expiry');
  }
  if (payload.exp <= now) throw new UnauthorizedError('Token expired');
  if (payload.nbf !== undefined && (typeof payload.nbf !== 'number' || payload.nbf > now)) {
    throw new UnauthorizedError('Token not yet valid');
  }

  return payload;
}
