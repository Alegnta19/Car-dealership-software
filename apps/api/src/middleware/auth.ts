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
  findActiveConnectionById,
  findUserLinkByProviderIdentity,
  isTenantEffective,
  isUserLinkUsable,
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
  /** The provider connection this credential was resolved through (R1 §C/§E). */
  connectionId: string | null;
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
    if (rawName === name) {
      const raw = rest.join('=');
      try {
        return decodeURIComponent(raw);
      } catch {
        // Malformed percent-encoding is a malformed credential, not a server
        // fault: return it undecoded so it fails the normal credential path
        // (a neutral 401), never a 500 with a stack from an anonymous caller.
        return raw;
      }
    }
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
    // FBL-020-R1 section C: the whole chain is re-checked on EVERY request —
    // connection, issuer agreement, tenant, link. Disabling any link in that
    // chain denies the very next request with the same otherwise-valid token;
    // no restart and no waiting for expiry.
    const connection = await resolveActiveConnection(verified.organizationId);
    if (connection === null) throw new UnauthorizedError('Invalid access token');
    // The connection's CONFIGURED issuer must agree with the verified token
    // issuer. Provider identifiers are mapping inputs, not authorization
    // evidence.
    if (connection.issuer !== identitySettings().issuer) {
      throw new UnauthorizedError('Invalid access token');
    }
    if (connection.tenantId !== null && !(await isTenantEffective(connection.tenantId))) {
      throw new UnauthorizedError('Invalid access token');
    }
    const link = await findUserLinkByProviderIdentity(connection.tenantId, verified.providerUserId);
    if (
      link === null ||
      link.status !== 'activated' ||
      !(await isUserLinkUsable(link.userLinkId))
    ) {
      throw new UnauthorizedError('Invalid access token');
    }
    return {
      userLinkId: link.userLinkId,
      actorScope: connection.connectionScope,
      tenantId: connection.tenantId,
      authTime: verified.authTime,
      sessionId: verified.providerSessionId,
      connectionId: connection.connectionId,
      credential: 'bearer',
    };
  }

  if (sessionCookie !== undefined) {
    const session = await validateSessionToken(sessionCookie);
    if (session === null) throw new UnauthorizedError('Invalid or expired session');
    // The same chain a bearer walks: an existing session must die the moment
    // its tenant, provider connection or user link stops being effective.
    if (session.tenantId !== null && !(await isTenantEffective(session.tenantId))) {
      throw new UnauthorizedError('Invalid or expired session');
    }
    if (session.connectionId !== null) {
      const connection = await findActiveConnectionById(session.connectionId);
      if (connection === null || connection.issuer !== identitySettings().issuer) {
        throw new UnauthorizedError('Invalid or expired session');
      }
    }
    if (!(await isUserLinkUsable(session.userLinkId))) {
      throw new UnauthorizedError('Invalid or expired session');
    }
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
      connectionId: session.connectionId,
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

  // A resource-less action names no existing row, but it usually names WHERE
  // it lands: `location_id` is the legacy column that migration 055 made the
  // rooftop id. Passing it as a scope hint keeps a rooftop-scoped binding
  // working at its own rooftop while denying it the rest of the tenant. When
  // no location is named the action reaches the whole tenant, and only a
  // tenant-scope binding may authorize it (enforced in the policy engine).
  let scopeHint: { level: 'rooftop'; id: string } | null = null;
  if (def !== undefined && def.resourceType === null) {
    const fromBody = (req.body as Record<string, unknown> | undefined)?.location_id;
    const fromQuery = req.query?.location_id;
    const named = typeof fromBody === 'string' ? fromBody : fromQuery;
    if (typeof named === 'string' && isUuid(named)) {
      scopeHint = { level: 'rooftop', id: named };
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
    scopeHint,
    correlationId: safeCorrelationId(req),
    // The evidence row records the SANITIZED correlation id — the same one
    // the response header echoes. A hostile header value must never reach an
    // append-only table (nor violate its CHECK and 500 the request).
    requestId: safeRequestId(req),
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

  // Roles bound in the TARGET tenant only: a platform binding must not leak
  // into the dealership domain guards (it grants no dealership access).
  const roles = (await rolesForUserLink(identity.userLinkId, targetTenantId)) as Role[];
  req.tenantContext = {
    tenantId: targetTenantId as string,
    userId: identity.userLinkId,
    roles,
  };
  bindRequestActor({ tenantId: targetTenantId as string, userId: identity.userLinkId, roles });
}

/**
 * The correlation id, screened exactly as request-context screens it: a
 * hostile or malformed `x-request-id` is dropped rather than propagated.
 */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{8,128}$/;

function safeRequestId(req: Request): string | null {
  const raw = req.headers['x-request-id'];
  return typeof raw === 'string' && SAFE_REQUEST_ID.test(raw) ? raw : null;
}

/**
 * The correlation id ties a whole flow together and is deliberately distinct
 * from the per-call request id. Screened the same way.
 */
function safeCorrelationId(req: Request): string | null {
  const raw = req.headers['x-correlation-id'];
  return typeof raw === 'string' && SAFE_REQUEST_ID.test(raw) ? raw : null;
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
