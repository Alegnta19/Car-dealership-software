import { createHmac, timingSafeEqual } from 'crypto';
import { NextFunction, Request, Response } from 'express';
import { isUuid } from '../utils/helpers';
import { ForbiddenError, UnauthorizedError } from './error-handler';

/**
 * Roles recognised by the service platform. A principal may hold several.
 * `platform_admin` is implicitly allowed everywhere (see `authorize`).
 */
export const ROLES = {
  ADMIN: 'platform_admin',
  SERVICE_MANAGER: 'service_manager',
  SERVICE_ADVISOR: 'service_advisor',
  TECHNICIAN: 'service_technician',
  PARTS_CLERK: 'parts_clerk',
  WARRANTY_ADMIN: 'warranty_admin',
  VIEWER: 'service_viewer',
} as const;

export type Role = (typeof ROLES)[keyof typeof ROLES];

/** Every role that may look at service data at all. */
export const READ_ROLES: Role[] = [
  ROLES.SERVICE_MANAGER,
  ROLES.SERVICE_ADVISOR,
  ROLES.TECHNICIAN,
  ROLES.PARTS_CLERK,
  ROLES.WARRANTY_ADMIN,
  ROLES.VIEWER,
];

export interface TenantContext {
  tenantId: string;
  userId: string;
  roles: Role[];
}

function b64urlJson(segment: string): any {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function jwtSecret(): string {
  const value = process.env.JWT_SECRET;
  if (!value || value.length < 32) {
    throw new Error('JWT_SECRET must be set to at least 32 characters');
  }
  return value;
}

/**
 * Minimal HS256 verifier. Deliberately rejects any `alg` other than HS256 — accepting
 * the token's own algorithm claim is the classic JWT confusion bug.
 */
function verifyJwtHs256(token: string): Record<string, any> {
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
  if (!isObject(header) || !isObject(payload)) throw new UnauthorizedError('Malformed bearer token');
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

/**
 * Establishes `req.tenantContext` from the bearer token and nothing else.
 *
 * The tenant a request operates on is decided **here**, from the signed credential.
 * Request bodies and query strings are never consulted for tenant identity — that was
 * the original spoofing vector, where a client-supplied `tenant_id` took precedence
 * over the authenticated one.
 */
export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedError('Missing bearer token');

    const claims = verifyJwtHs256(header.slice('Bearer '.length).trim());

    const tenantId = claims.tid;
    const userId = claims.sub;
    if (!isUuid(tenantId)) throw new UnauthorizedError('Token is missing a valid tenant claim');
    if (!isUuid(userId)) throw new UnauthorizedError('Token is missing a valid subject claim');

    const roles: Role[] = Array.isArray(claims.roles)
      ? claims.roles.filter((r: unknown): r is Role => typeof r === 'string')
      : [];

    req.tenantContext = { tenantId, userId, roles };
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Restricts a route to the listed roles. `platform_admin` always passes. Must be
 * mounted after `authenticate`.
 */
export function authorize(...allowed: Role[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const ctx = req.tenantContext;
    if (!ctx) {
      next(new UnauthorizedError('Authentication required'));
      return;
    }

    const permitted = ctx.roles.includes(ROLES.ADMIN) || ctx.roles.some((role) => allowed.includes(role));
    if (!permitted) {
      next(new ForbiddenError('Your role may not perform this action', {
        details: { required_any_of: allowed },
      }));
      return;
    }
    next();
  };
}

/**
 * Returns the authenticated context or throws. Route handlers use this instead of
 * reading `req.body.tenant_id` / `req.body.user_id`.
 */
export function requireContext(req: Request): TenantContext {
  if (!req.tenantContext) throw new UnauthorizedError('Authentication required');
  return req.tenantContext;
}

/**
 * Rejects a request that carries an explicit `tenant_id` disagreeing with the token.
 * Callers are free to omit it entirely; sending a *different* one is always a bug or an
 * attempt, and failing loudly beats silently ignoring it.
 */
export function rejectTenantOverride(req: Request): void {
  const ctx = requireContext(req);
  for (const source of [req.body, req.query]) {
    const supplied = source && (source as Record<string, unknown>).tenant_id;
    if (supplied !== undefined && supplied !== ctx.tenantId) {
      throw new ForbiddenError('tenant_id does not match the authenticated tenant', {
        code: 'tenant_mismatch',
      });
    }
  }
}
