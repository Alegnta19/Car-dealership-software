/**
 * HTTP authentication/authorization middleware (FBL-020).
 *
 * Authentication accepts EXACTLY ONE credential per request:
 *   - `Authorization: Bearer <provider access token>` — verified by the
 *     standards-based OIDC verifier against the CONFIGURED issuer, audience
 *     and JWKS. Locally signed HS256 tokens are gone from production paths.
 *   - the HttpOnly session cookie minted by /auth/callback — validated
 *     against the server-side session store; unsafe methods additionally
 *     require the session's CSRF token in `x-csrf-token`.
 * A request carrying BOTH is ambiguous and refused outright.
 *
 * The tenant a request operates on still never comes from a body or query
 * string: dealership actors act in the tenant their identity maps to, full
 * stop. A platform actor names a target tenant in `x-target-tenant`, and the
 * POLICY ENGINE decides whether any support-access session actually admits
 * them — a platform role alone grants nothing.
 *
 * Authorization is `requireAction(...)`: routes declare ONE catalog action;
 * the central engine decides from database RoleBindings and writes the
 * append-only evidence row. Resource-scoped denials render the existing
 * not-found envelope (unauthorized ≡ nonexistent — non-enumeration).
 */
import { NextFunction, Request, Response } from 'express';
import { Role, TenantContext } from '@dealer/contracts';
import {
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  bindRequestActor,
  getConfig,
  isUuid,
} from '@dealer/platform';
import {
  TokenVerificationError,
  createAccessTokenVerifier,
  createIdentityActionCatalog,
  createPolicyEngine,
  findUserLinkByProviderIdentity,
  mergeActionCatalogs,
  resolveActiveConnection,
  rolesForUserLink,
  validateSessionToken,
  verifyCsrfToken,
  type AccessTokenVerifier,
  type ActionCatalog,
  type PolicyEngine,
} from '@dealer/identity-access';
import { createServiceActionCatalog, resolveServiceResourceScope } from '@dealer/fixed-ops';

export type { Role, TenantContext };

export const SESSION_COOKIE = 'dealer_session';

/** The verified actor identity carried on the request. */
export interface RequestIdentity {
  userLinkId: string;
  actorScope: 'dealership' | 'platform';
  /** dealership actors carry their tenant; platform actors carry null */
  tenantId: string | null;
  authTime: Date | null;
  sessionId: string | null;
  credential: 'bearer' | 'session';
}

declare module 'express-serve-static-core' {
  interface Request {
    identity?: RequestIdentity;
  }
}

// ── lazily composed singletons (config-dependent) ──────────────────────────

let verifierInstance: AccessTokenVerifier | undefined;
let engineInstance: PolicyEngine | undefined;
let catalogInstance: ActionCatalog | undefined;

function identitySettings() {
  const identity = getConfig().identity;
  if (identity.provider !== 'workos') {
    throw new UnauthorizedError('Identity provider is not configured');
  }
  return identity.workos;
}

function verifier(): AccessTokenVerifier {
  if (verifierInstance === undefined) {
    const settings = identitySettings();
    verifierInstance = createAccessTokenVerifier({
      issuer: settings.issuer,
      audience: settings.oidcAudience,
      jwksUri: settings.jwksUri,
      clockSkewSeconds: settings.oidcClockSkewSeconds,
    });
  }
  return verifierInstance;
}

export function actionCatalog(): ActionCatalog {
  if (catalogInstance === undefined) {
    catalogInstance = mergeActionCatalogs(
      createServiceActionCatalog(),
      createIdentityActionCatalog(),
    );
  }
  return catalogInstance;
}

export function policyEngine(): PolicyEngine {
  if (engineInstance === undefined) {
    engineInstance = createPolicyEngine({
      catalog: actionCatalog(),
      resolveResourceScope: resolveServiceResourceScope,
    });
  }
  return engineInstance;
}

/** Test-only: drops composed singletons so a new configuration takes effect. */
export function resetIdentityCompositionForTests(): void {
  verifierInstance = undefined;
  engineInstance = undefined;
  catalogInstance = undefined;
}

// ── cookie plumbing (no cookie-parser dependency needed for one cookie) ────

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (header === undefined) return undefined;
  for (const part of header.split(';')) {
    const [rawName, ...rest] = part.trim().split('=');
    if (rawName === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

/**
 * CSRF applies to everything that is not a read. Expressed as a SAFE-method
 * allowlist rather than a list of writes: a method nobody anticipated is
 * treated as state-changing, which is the failure direction we want.
 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// ── authentication ─────────────────────────────────────────────────────────

export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  authenticateAsync(req)
    .then((identity) => {
      req.identity = identity;
      // Dealership actors get a tenant context immediately; requireAction
      // re-derives it (with roles) after the policy decision.
      if (identity.tenantId !== null) {
        req.tenantContext = { tenantId: identity.tenantId, userId: identity.userLinkId, roles: [] };
      }
      bindRequestActor({
        tenantId: identity.tenantId ?? 'platform',
        userId: identity.userLinkId,
        roles: [],
      });
      next();
    })
    .catch((err: unknown) => next(err));
}

async function authenticateAsync(req: Request): Promise<RequestIdentity> {
  const header = req.headers.authorization;
  const sessionCookie = readCookie(req, SESSION_COOKIE);

  if (header !== undefined && sessionCookie !== undefined) {
    // Two credentials means a confused (or malicious) client. Refuse.
    throw new UnauthorizedError('Ambiguous credentials');
  }

  if (header !== undefined) {
    if (!header.startsWith('Bearer ')) throw new UnauthorizedError('Missing credentials');
    let verified;
    try {
      verified = await verifier().verify(header.slice('Bearer '.length).trim());
    } catch (err) {
      if (err instanceof TokenVerificationError) {
        throw new UnauthorizedError('Invalid access token');
      }
      throw err;
    }
    if (verified.organizationId === null) {
      // No organization context — this platform admits organization members
      // only. (Platform staff belong to the platform-scope organization.)
      throw new UnauthorizedError('Invalid access token');
    }
    const connection = await resolveActiveConnection(verified.organizationId);
    if (connection === null) throw new UnauthorizedError('Invalid access token');
    const link = await findUserLinkByProviderIdentity(connection.tenantId, verified.providerUserId);
    if (link === null || link.status !== 'activated') {
      throw new UnauthorizedError('Invalid access token');
    }
    return {
      userLinkId: link.userLinkId,
      actorScope: connection.connectionScope,
      tenantId: connection.tenantId,
      authTime: verified.authTime,
      sessionId: verified.providerSessionId,
      credential: 'bearer',
    };
  }

  if (sessionCookie !== undefined) {
    const session = await validateSessionToken(sessionCookie);
    if (session === null) throw new UnauthorizedError('Invalid or expired session');
    if (!SAFE_METHODS.has(req.method)) {
      const presented = req.headers['x-csrf-token'];
      const settings = identitySettings();
      if (
        typeof presented !== 'string' ||
        !verifyCsrfToken(session.sessionId, settings.cookiePassword, presented)
      ) {
        throw new ForbiddenError('CSRF token missing or invalid', { code: 'csrf_required' });
      }
    }
    return {
      userLinkId: session.userLinkId,
      actorScope: session.tenantId === null ? 'platform' : 'dealership',
      tenantId: session.tenantId,
      authTime: session.authTime,
      sessionId: session.sessionId,
      credential: 'session',
    };
  }

  throw new UnauthorizedError('Missing credentials');
}

// ── authorization ──────────────────────────────────────────────────────────

/** Which route parameter names each resource type (catalog-driven). */
const RESOURCE_PARAMS: Record<string, string> = {
  service_appointment: 'appointmentId',
  repair_order: 'roId',
  mpi_session: 'mpiSessionId',
  service_queue_item: 'queueItemId',
  ro_parts_line: 'partLineId',
  service_portal_task: 'portalTaskId',
  ro_sublet_job: 'subletJobId',
  tech_work_ticket: 'ticketId',
  service_waitlist_entry: 'waitlistEntryId',
  comeback_case: 'comebackId',
  ro_line_item: 'lineItemId',
};

export function requireAction(action: string) {
  const middleware = (req: Request, res: Response, next: NextFunction): void => {
    requireActionAsync(action, req, res)
      .then(() => next())
      .catch((err: unknown) => next(err));
  };
  // Introspection metadata for the HTTP contract characterization: the route
  // inventory reads which action gates each endpoint.
  middleware.requiredAction = action;
  return middleware;
}

async function requireActionAsync(action: string, req: Request, res: Response): Promise<void> {
  const identity = req.identity;
  if (identity === undefined) throw new UnauthorizedError('Authentication required');

  // Platform actors name their target tenant explicitly; dealership actors'
  // target IS their tenant — a header from them is ignored, never trusted.
  let targetTenantId = identity.tenantId;
  if (identity.actorScope === 'platform') {
    const named = req.headers['x-target-tenant'];
    if (typeof named === 'string' && isUuid(named)) targetTenantId = named;
  }

  const def = actionCatalog().get(action);
  let resource: { type: string; id: string } | null = null;
  if (def !== undefined && def.resourceType !== null) {
    const param = RESOURCE_PARAMS[def.resourceType];
    const id = param === undefined ? undefined : req.params[param];
    if (typeof id === 'string' && isUuid(id)) {
      resource = { type: def.resourceType, id };
    } else if (typeof id === 'string') {
      // a non-UUID id can never exist — same envelope as any other missing resource
      throw new NotFoundError('Resource not found');
    }
  }

  const decision = await policyEngine().decide({
    actor: {
      userLinkId: identity.userLinkId,
      actorScope: identity.actorScope,
      tenantId: identity.tenantId,
    },
    action,
    targetTenantId,
    resource,
    requestId: typeof req.headers['x-request-id'] === 'string' ? req.headers['x-request-id'] : null,
  });

  if (decision.decision !== 'allow') {
    if (!decision.resourceVisible) {
      // unauthorized ≡ nonexistent for resource-scoped requests
      throw new NotFoundError('Resource not found');
    }
    throw new ForbiddenError('Your role may not perform this action', {
      details: { required_action: action },
    });
  }

  // Non-suppressible support indicator: every response served under support
  // access says so, and the policy evidence row already recorded it.
  if (decision.supportSessionId !== null) {
    res.setHeader('x-support-access', `active; support_session=${decision.supportSessionId}`);
  }

  const roles = (await rolesForUserLink(identity.userLinkId)) as Role[];
  req.tenantContext = {
    tenantId: targetTenantId as string,
    userId: identity.userLinkId,
    roles,
  };
  bindRequestActor({ tenantId: targetTenantId as string, userId: identity.userLinkId, roles });
}

/** Convenience used by route handlers (unchanged shape from FBL-010). */
export function requireContext(req: Request): TenantContext {
  if (!req.tenantContext) throw new UnauthorizedError('Authentication required');
  return req.tenantContext;
}

/**
 * Rejects a request that carries an explicit `tenant_id` disagreeing with the
 * authenticated (or, for support access, policy-admitted) tenant. Callers are
 * free to omit it entirely; sending a *different* one is always a bug or an
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
