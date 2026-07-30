/**
 * HTTP authentication/authorization middleware — the transport adapter over
 * @dealer/platform's JWT verification and @dealer/contracts' role vocabulary.
 * Tenant identity comes from the verified token and nothing else.
 */
import { NextFunction, Request, Response } from 'express';
import { READ_ROLES, ROLES, Role, TenantContext } from '@dealer/contracts';
import {
  ForbiddenError,
  UnauthorizedError,
  bindRequestActor,
  isUuid,
  verifyJwtHs256,
} from '@dealer/platform';

export { READ_ROLES, ROLES };
export type { Role, TenantContext };

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
    // Correlation only: logs gain tenant/user ids. Authorization decisions never read
    // the request context store.
    bindRequestActor({ tenantId, userId, roles });
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
  const middleware = (req: Request, _res: Response, next: NextFunction): void => {
    const ctx = req.tenantContext;
    if (!ctx) {
      next(new UnauthorizedError('Authentication required'));
      return;
    }

    const permitted =
      ctx.roles.includes(ROLES.ADMIN) || ctx.roles.some((role) => allowed.includes(role));
    if (!permitted) {
      next(
        new ForbiddenError('Your role may not perform this action', {
          details: { required_any_of: allowed },
        }),
      );
      return;
    }
    next();
  };
  // Introspection metadata for the HTTP contract characterization (FBL-010): the route
  // inventory reads which roles gate each endpoint without changing how the gate works.
  middleware.requiredRoles = [...allowed];
  return middleware;
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
