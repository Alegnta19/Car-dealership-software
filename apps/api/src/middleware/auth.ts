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
 * FBL-020-R3: BOTH credentials now resolve a LOCAL, revocable session. A bearer
 * token used to be authenticated against the provider alone, which left the
 * provider as the only authority on whether the caller was still logged in —
 * so a local logout could not deny an access token that had not expired yet.
 * A verified bearer with no local session establishes one; every later request
 * resolves it and is refused if it is revoked or expired.
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
  bindSupportContext,
  getConfig,
  isUuid,
  logger,
} from '@dealer/platform';
import {
  SUPPORT_ACCESS_HEADER,
  TokenVerificationError,
  createAccessTokenVerifier,
  createIdentityActionCatalog,
  createPolicyEngine,
  findActiveConnectionById,
  findUserLinkByProviderIdentity,
  isTenantEffective,
  isUserLinkUsable,
  maintainProviderSession,
  mergeActionCatalogs,
  resolveActiveConnection,
  resolveOrEstablishBearerSession,
  revalidateSessionIdentity,
  rolesForUserLink,
  supportAccessHeaderValue,
  validateSessionToken,
  verifyCsrfToken,
  type AccessTokenVerifier,
  type ActionCatalog,
  type IdentitySession,
  type PolicyEngine,
} from '@dealer/identity-access';
import { createInventoryActionCatalog } from '@dealer/inventory';
import { createServiceActionCatalog, resolveServiceResourceScope } from '@dealer/fixed-ops';
import { identityProvider } from '../identity/provider';

export type { Role, TenantContext };

export const SESSION_COOKIE = 'dealer_session';

/** The verified actor identity carried on the request. */
export interface RequestIdentity {
  userLinkId: string;
  actorScope: 'dealership' | 'platform';
  /** dealership actors carry their tenant; platform actors carry null */
  tenantId: string | null;
  authTime: Date | null;
  /**
   * The LOCAL, revocable session this request resolved. R3: BOTH credential
   * kinds now have one — a bearer credential without a live local session is
   * not authenticated, which is what makes local logout beat a provider token
   * that has not expired yet.
   */
  sessionId: string | null;
  /**
   * The PROVIDER's session identifier (`sid`). A mapping input and a logout
   * argument — never authorization evidence, and never the local session id.
   */
  providerSessionId: string | null;
  /** The provider connection this credential was resolved through (R1 §C/§E). */
  connectionId: string | null;
  /** R2: the provider subject this credential proved. */
  providerSubject: string | null;
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
      createInventoryActionCatalog(),
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
    // FBL-020-R3: an IMPERSONATED token is refused before anything else is
    // resolved. A provider staff member acting as one of our users is not an
    // actor this platform admits, on any credential path.
    if (verified.impersonation.impersonated) {
      throw new UnauthorizedError('Invalid access token');
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
    // The token's organization must be the connection's organization: a
    // provider identifier is a mapping input, never authorization evidence.
    if (connection.providerOrganizationId !== verified.organizationId) {
      throw new UnauthorizedError('Invalid access token');
    }
    // Impossible token times: an auth_time in the future beyond the bounded
    // skew is not a fact this platform accepts.
    if (verified.authTime.getTime() > Date.now() + identitySettings().oidcClockSkewSeconds * 1000) {
      throw new UnauthorizedError('Invalid access token');
    }
    // R3: the SIX-fact link lookup. Connection, issuer and provider
    // organization are compared, not merely carried, so a link bound to a
    // different organization is invisible here — an organization remap never
    // hands the new organization the old organization's account.
    const link = await findUserLinkByProviderIdentity({
      tenantId: connection.tenantId,
      providerUserId: verified.providerUserId,
      connectionId: connection.connectionId,
      issuer: connection.issuer,
      providerOrganizationId: connection.providerOrganizationId,
    });
    if (
      link === null ||
      link.status !== 'activated' ||
      !(await isUserLinkUsable(link.userLinkId))
    ) {
      throw new UnauthorizedError('Invalid access token');
    }
    // R3: the bearer credential resolves a LOCAL session. Established on first
    // use, revalidated on every later request against the whole identity
    // chain, and refused the moment it is revoked or expired — so a local
    // logout denies the very next request with a provider token that is still
    // perfectly valid, without waiting for that token to expire.
    const bearerSession = await resolveOrEstablishBearerSession({
      issuer: connection.issuer,
      expectedIssuer: identitySettings().issuer,
      providerSessionId: verified.providerSessionId,
      providerOrganizationId: connection.providerOrganizationId,
      providerSubject: verified.providerUserId,
      tenantId: connection.tenantId,
      userLinkId: link.userLinkId,
      connectionId: connection.connectionId,
      authTime: verified.authTime,
    });
    if (bearerSession.outcome !== 'live') {
      // Revoked, expired, issuer-disagreeing and no-longer-effective are ONE
      // neutral answer outward; the distinction stays inside the platform.
      throw new UnauthorizedError('Invalid access token');
    }
    return {
      userLinkId: link.userLinkId,
      actorScope: connection.connectionScope,
      tenantId: connection.tenantId,
      authTime: verified.authTime,
      sessionId: bearerSession.session.sessionId,
      providerSessionId: verified.providerSessionId,
      connectionId: connection.connectionId,
      providerSubject: verified.providerUserId,
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
    // FBL-020-R2: NO nullable-connection bypass. R1 checked the connection
    // only when the session named one, so a session with a NULL connection
    // skipped the check entirely. A session that cannot prove the connection,
    // issuer, organization and subject it was established through is
    // unprovable and is refused.
    if (
      session.connectionId === null ||
      session.issuer === null ||
      session.providerSubject === null ||
      session.providerOrganizationId === null
    ) {
      throw new UnauthorizedError('Invalid or expired session');
    }
    const connection = await findActiveConnectionById(session.connectionId);
    if (
      connection === null ||
      connection.issuer !== identitySettings().issuer ||
      connection.issuer !== session.issuer ||
      connection.providerOrganizationId !== session.providerOrganizationId
    ) {
      throw new UnauthorizedError('Invalid or expired session');
    }
    if (!(await isUserLinkUsable(session.userLinkId))) {
      throw new UnauthorizedError('Invalid or expired session');
    }
    // R3: ONE statement re-reads the whole chain — tenant, connection, issuer,
    // organization, UserLink and the session itself, each inside its EFFECTIVE
    // WINDOW, and each compared against the others rather than merely present.
    // The individual checks above stay: they name their own failures, and this
    // is the one that cannot be satisfied by a partially-agreeing chain (a link
    // re-bound to a different connection than the session was established
    // through, for instance, passes every check above and fails here).
    if (
      (await revalidateSessionIdentity({
        sessionId: session.sessionId,
        expectedIssuer: identitySettings().issuer,
      })) === null
    ) {
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
    // FBL-020-R3 correction C1: the PROVIDER SESSION is maintained before this
    // request is served. /auth/callback takes custody of a sealed provider
    // refresh credential on every login; until now nothing running could spend
    // it, which made an 8-hour credential at rest with no operational benefit.
    // A session whose provider access token is at or near expiry is refreshed
    // here, so the provider's continued assent is re-checked within minutes
    // rather than never, and the credential rotates instead of sitting still.
    //
    // Deliberately AFTER the CSRF check: a forged unsafe request must not be
    // able to spend a single-use refresh token on its way to being refused.
    const live = await maintainSession(session);
    return {
      userLinkId: live.userLinkId,
      actorScope: live.tenantId === null ? 'platform' : 'dealership',
      tenantId: live.tenantId,
      // The refreshed row, not the pre-refresh one: a rotation may have moved
      // auth_time forward (only on verified evidence) and may have been handed a
      // new provider session id, and the policy evidence must record what is
      // true now.
      authTime: live.authTime,
      sessionId: live.sessionId,
      providerSessionId: live.providerSessionId,
      connectionId: live.connectionId,
      providerSubject: live.providerSubject,
      credential: 'session',
    };
  }

  throw new UnauthorizedError('Missing credentials');
}

/**
 * FBL-020-R3 correction C1 — the provider session behind a cookie session is
 * MAINTAINED on the request path, and this is the whole of the app's part in it:
 * one call into the identity package, which owns every statement.
 *
 * Returns the session this request must proceed on — the rotated row when a
 * refresh happened, the one it already had otherwise. A refusal is thrown only
 * when the session is genuinely gone (definitive provider refusal, identity
 * mismatch, replay, impersonation, or a row revoked underneath us); a provider
 * that merely did not answer leaves a still-valid local session serving traffic.
 */
async function maintainSession(session: IdentitySession): Promise<IdentitySession> {
  const settings = identitySettings();
  const maintained = await maintainProviderSession({
    session,
    provider: identityProvider(settings),
    cookiePassword: settings.cookiePassword,
    expectedIssuer: settings.issuer,
    // The refreshed access token is VERIFIED by the same standards-based
    // verifier a bearer credential faces. An unverifiable or impersonated
    // replacement therefore kills the session rather than being adopted.
    verifyAccessToken: (accessToken: string) => verifier().verify(accessToken),
    // R3 correction D1: a refresh on the request path is BOUNDED. The exchange no
    // longer holds a database transaction, so a provider that hangs costs this one
    // request the bound and nothing else — but it must still cost only the bound.
    providerTimeoutMs: settings.providerRefreshTimeoutMs,
  });
  if (maintained.outcome === 'session_ended') {
    // Same neutral answer as every other session failure: the distinction stays
    // inside the platform, on the session row's revoked_reason.
    throw new UnauthorizedError('Invalid or expired session');
  }
  return maintained.session;
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
  // ── RELEASE TRAIN 2 ──────────────────────────────────────────────────────
  //
  // Everything hanging off a stock item — its prices, photographs, features,
  // holds, costs, documents and transfers — is authorized THROUGH the stock
  // item, so those routes all name `stockItemId` and declare
  // `resourceType: 'stock_item'`. A listing gets its own entry because it is
  // withdrawn and reconciled by its own identifier, after the vehicle it
  // advertises has already been left behind in the URL.
  stock_item: 'stockItemId',
  stock_listing: 'listingId',
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
    // R3: the LOCAL session id, for both credential kinds. A bearer request
    // now has one, so the evidence row names the object an operator can
    // actually revoke instead of recording nothing.
    //
    // FBL-020-R4 §2: this is now the ONLY identity fact this middleware passes.
    // It used to hand over `authTime`, `connectionId` and `providerSubject` as
    // well, and the engine wrote them into append-only evidence unexamined —
    // three caller-asserted claims about a credential the engine could read for
    // itself. It reads them from the presented session row now, so the evidence
    // describes what the database can see rather than what this layer believed.
    sessionId: identity.sessionId,
    // FBL-020-R3: the request and correlation ids are NOT passed from here any
    // more. They used to be read off `x-request-id` / `x-correlation-id`, so a
    // client decided what the append-only evidence row recorded — and recorded
    // nothing at all when it sent nothing. The engine now reads the GENERATED
    // pair the outermost middleware minted, which is also the pair every log
    // line carries, so the decision and its logs join on ids no caller chose.
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

  // FBL-020-R4 §4 — THE NON-SUPPRESSIBLE SUPPORT INDICATOR, IN FULL.
  //
  // R3 set a header naming the session id and did nothing else, so a tenant knew
  // delegated access was in force without knowing when it ends — the one fact that
  // decides whether to wait or to revoke — and the request context and every log
  // line inside the request said nothing about it at all.
  //
  // Two things happen here now, and neither is optional:
  //   - the header is built by the ONE formatter in @dealer/identity-access, whose
  //     input type makes an expiry-less value impossible to construct;
  //   - the facts are BOUND to the request context, so every log line this request
  //     goes on to write names the session, the approving request, the true support
  //     actor, the target tenant, the approved scope and action set, and the expiry.
  //     `bindSupportContext` defines that field non-writable and non-configurable, so
  //     nothing downstream — route, middleware or error handler — can blank it out.
  if (decision.support !== null) {
    const header = supportAccessHeaderValue([decision.support]);
    if (header !== null) res.setHeader(SUPPORT_ACCESS_HEADER, header);
    bindSupportContext(decision.support);
    // ONE line per support-served request, and it is written HERE rather than left to
    // whatever the route happens to log. An ordinary request logs nothing on the happy
    // path, so without this the log stream would only ever mention delegated access when
    // something else went wrong — and "a platform person read this customer's data" is
    // exactly the event an operator greps for. The fields come from the bound context, so
    // this call carries the whole set without naming any of it (and cannot name the
    // reason).
    logger.info(
      { component: 'api.authorization', event: 'support_access_served', action },
      'request served under delegated support access',
    );
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
