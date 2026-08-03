/**
 * The /auth surface (FBL-020): six routes, outside /api/service.
 *
 *   GET  /auth/login            -> provider redirect (Code + PKCE + state)
 *   GET  /auth/callback         -> code exchange, UserLink, session cookie
 *   POST /auth/logout           -> revoke session, provider logout URL
 *   GET  /auth/session          -> who am I + roles + CSRF + support indicator
 *   POST /auth/reauth/start     -> policy-checked max_age=0 reauth transaction
 *   GET  /auth/reauth/callback  -> auth_time proof -> single-use grant
 *
 * OAuth round-trip state (state, PKCE verifier, reauth nonce) travels in a
 * SEALED short-lived HttpOnly cookie — AES-256-GCM under the configured
 * cookie password; tampering opens to null and the flow fails closed with a
 * neutral error. Session and transaction cookies are HttpOnly, SameSite=Lax,
 * host-only (no Domain attribute) and Secure outside development.
 */
import { Request, Response, Router } from 'express';
import { randomBytes, createHash } from 'node:crypto';
import { NotFoundError, UnauthorizedError, ValidationError, getConfig } from '@dealer/platform';
import {
  IDENTITY_PROVIDER_WORKOS,
  TokenVerificationError,
  completeReauthentication,
  createAccessTokenVerifier,
  createSession,
  createWorkosProvider,
  csrfTokenForSession,
  ensureActivatedUserLink,
  findUserLinkByProviderIdentity,
  listActiveSupportSessions,
  openCookiePayload,
  resolveActiveConnection,
  revokeSessionByToken,
  rolesForUserLink,
  sealCookiePayload,
  startReauthentication,
  validateSessionToken,
  type AccessTokenVerifier,
  type IdentityProviderPort,
} from '@dealer/identity-access';
import {
  SESSION_COOKIE,
  actionCatalog,
  authenticate,
  policyEngine,
  readCookie,
  requireContext,
} from '../middleware/auth';

const router = Router();

const AUTH_TXN_COOKIE = 'dealer_auth_txn';
const REAUTH_TXN_COOKIE = 'dealer_reauth_txn';
const SESSION_TTL_SECONDS = 8 * 3600;
const TXN_COOKIE_TTL_SECONDS = 600;

function settings() {
  const identity = getConfig().identity;
  if (identity.provider !== 'workos') {
    // the /auth surface simply does not exist without a provider
    throw new NotFoundError('Not found');
  }
  return identity.workos;
}

let providerInstance: IdentityProviderPort | undefined;
let verifierInstance: AccessTokenVerifier | undefined;

function provider(): IdentityProviderPort {
  if (providerInstance === undefined) {
    const s = settings();
    providerInstance = createWorkosProvider({
      clientId: s.clientId,
      apiKey: s.apiKey,
      redirectUri: s.redirectUri,
      reauthRedirectUri: s.reauthRedirectUri,
      logoutRedirectUri: s.logoutRedirectUri,
    });
  }
  return providerInstance;
}

function verifier(): AccessTokenVerifier {
  if (verifierInstance === undefined) {
    const s = settings();
    verifierInstance = createAccessTokenVerifier({
      issuer: s.issuer,
      audience: s.oidcAudience,
      jwksUri: s.jwksUri,
      clockSkewSeconds: s.oidcClockSkewSeconds,
    });
  }
  return verifierInstance;
}

/** Test-only: drops provider/verifier singletons after a config change. */
export function resetAuthRoutesForTests(): void {
  providerInstance = undefined;
  verifierInstance = undefined;
}

function secureCookies(): boolean {
  return getConfig().isProduction;
}

function setCookie(
  res: Response,
  name: string,
  value: string,
  options: { maxAgeSeconds: number; path: string },
): void {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Max-Age=${options.maxAgeSeconds}`,
    `Path=${options.path}`,
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (secureCookies()) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

function clearCookie(res: Response, name: string, path: string): void {
  res.append('Set-Cookie', `${name}=; Max-Age=0; Path=${path}; HttpOnly; SameSite=Lax`);
}

/** Relative-path allowlist: same-origin navigation only, never an open redirect. */
function safeReturnTo(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0) return '/';
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return '/';
  return raw;
}

function sha256base64url(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('base64url');
}

function asyncRoute(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: (err?: unknown) => void): void => {
    fn(req, res).catch(next);
  };
}

// ── GET /auth/login ────────────────────────────────────────────────────────
router.get(
  '/login',
  asyncRoute(async (req, res) => {
    const s = settings();
    const state = randomBytes(32).toString('base64url');
    const codeVerifier = randomBytes(32).toString('base64url');
    const sealed = sealCookiePayload(
      {
        purpose: 'login',
        state,
        code_verifier: codeVerifier,
        return_to: safeReturnTo(req.query.return_to),
      },
      s.cookiePassword,
    );
    setCookie(res, AUTH_TXN_COOKIE, sealed, {
      maxAgeSeconds: TXN_COOKIE_TTL_SECONDS,
      path: '/auth',
    });
    res.redirect(
      provider().buildAuthorizationUrl({ state, codeChallenge: sha256base64url(codeVerifier) }),
    );
  }),
);

// ── GET /auth/callback ─────────────────────────────────────────────────────
router.get(
  '/callback',
  asyncRoute(async (req, res) => {
    const s = settings();
    const sealed = readCookie(req, AUTH_TXN_COOKIE);
    const txn =
      sealed === undefined
        ? null
        : openCookiePayload(sealed, s.cookiePassword, { maxAgeSeconds: TXN_COOKIE_TTL_SECONDS });
    const code = req.query.code;
    if (
      txn === null ||
      txn.purpose !== 'login' ||
      typeof code !== 'string' ||
      typeof req.query.state !== 'string' ||
      req.query.state !== txn.state
    ) {
      clearCookie(res, AUTH_TXN_COOKIE, '/auth');
      throw new UnauthorizedError('Authentication failed');
    }
    clearCookie(res, AUTH_TXN_COOKIE, '/auth');

    const exchanged = await provider().exchangeCode({
      code,
      codeVerifier: String(txn.code_verifier),
    });
    let verified;
    try {
      verified = await verifier().verify(exchanged.accessToken);
    } catch (err) {
      if (err instanceof TokenVerificationError)
        throw new UnauthorizedError('Authentication failed');
      throw err;
    }
    if (verified.organizationId === null) throw new UnauthorizedError('Authentication failed');
    const connection = await resolveActiveConnection(verified.organizationId);
    if (connection === null) throw new UnauthorizedError('Authentication failed');

    const link = await ensureActivatedUserLink({
      tenantId: connection.tenantId,
      provider: IDENTITY_PROVIDER_WORKOS,
      providerUserId: verified.providerUserId,
      email: exchanged.email,
      displayName: exchanged.displayName,
    });
    if (link === null) {
      // deactivated identity — neutral refusal, no detail
      throw new UnauthorizedError('Authentication failed');
    }

    const created = await createSession({
      tenantId: connection.tenantId,
      userLinkId: link.userLinkId,
      providerSessionId: verified.providerSessionId,
      authTime: verified.authTime,
      ttlSeconds: SESSION_TTL_SECONDS,
    });
    setCookie(res, SESSION_COOKIE, created.sessionToken, {
      maxAgeSeconds: SESSION_TTL_SECONDS,
      path: '/',
    });
    res.redirect(safeReturnTo(txn.return_to));
  }),
);

// ── POST /auth/logout ──────────────────────────────────────────────────────
router.post(
  '/logout',
  authenticate,
  asyncRoute(async (req, res) => {
    const identity = req.identity;
    if (identity === undefined || identity.credential !== 'session') {
      throw new UnauthorizedError('A session cookie is required to log out');
    }
    const cookie = readCookie(req, SESSION_COOKIE);
    if (cookie !== undefined) await revokeSessionByToken(cookie, 'logout');
    clearCookie(res, SESSION_COOKIE, '/');
    const logoutUrl =
      identity.sessionId === null
        ? null
        : provider().buildLogoutUrl({ providerSessionId: identity.sessionId });
    res.json({ data: { logged_out: true, provider_logout_url: logoutUrl } });
  }),
);

// ── GET /auth/session ──────────────────────────────────────────────────────
router.get(
  '/session',
  authenticate,
  asyncRoute(async (req, res) => {
    const identity = req.identity!;
    const s = settings();
    const roles = await rolesForUserLink(identity.userLinkId);
    // The NON-SUPPRESSIBLE support indicator: any live support session for
    // this tenant is visible to every session of the tenant, every time.
    const support =
      identity.tenantId === null ? [] : await listActiveSupportSessions(identity.tenantId);
    if (support.length > 0) {
      res.setHeader(
        'x-support-access',
        support.map((x) => `active; support_session=${x.supportSessionId}`).join(', '),
      );
    }
    res.json({
      data: {
        user_link_id: identity.userLinkId,
        actor_scope: identity.actorScope,
        tenant_id: identity.tenantId,
        roles,
        auth_time: identity.authTime?.toISOString() ?? null,
        credential: identity.credential,
        support_access: support.map((x) => ({
          support_session_id: x.supportSessionId,
          actor_user_link_id: x.actorUserLinkId,
          granted_at: x.grantedAt.toISOString(),
          expires_at: x.expiresAt.toISOString(),
        })),
        csrf_token:
          identity.credential === 'session' && identity.sessionId !== null
            ? csrfTokenForSession(identity.sessionId, s.cookiePassword)
            : null,
      },
    });
  }),
);

// ── POST /auth/reauth/start ────────────────────────────────────────────────
router.post(
  '/reauth/start',
  authenticate,
  asyncRoute(async (req, res) => {
    const identity = req.identity!;
    const s = settings();
    const { action, qualifier, resource } = (req.body ?? {}) as {
      action?: unknown;
      qualifier?: unknown;
      resource?: { type?: unknown; id?: unknown };
    };
    if (typeof action !== 'string' || actionCatalog().get(action) === undefined) {
      throw new ValidationError('action must name a catalog action');
    }
    const def = actionCatalog().get(action)!;
    if (def.sensitive !== true) {
      throw new ValidationError('action does not require reauthentication');
    }
    if (identity.tenantId === null) {
      throw new ValidationError('reauthentication applies to dealership actors');
    }
    const resourceInput =
      resource && typeof resource.type === 'string' && typeof resource.id === 'string'
        ? { type: resource.type, id: resource.id }
        : null;

    // The person must currently be ALLOWED to perform the action; only then
    // is a reauthentication transaction worth opening. Evidence either way.
    const decision = await policyEngine().decide({
      actor: {
        userLinkId: identity.userLinkId,
        actorScope: identity.actorScope,
        tenantId: identity.tenantId,
      },
      action,
      targetTenantId: identity.tenantId,
      resource: resourceInput,
    });
    if (decision.decision !== 'allow') {
      if (!decision.resourceVisible) throw new NotFoundError('Resource not found');
      throw new ValidationError('action is not permitted, reauthentication cannot help');
    }

    const boundAction =
      typeof qualifier === 'string' && qualifier.length > 0 ? `${action}:${qualifier}` : action;
    const started = await startReauthentication({
      tenantId: identity.tenantId,
      userLinkId: identity.userLinkId,
      action: boundAction,
      resourceType: resourceInput?.type ?? null,
      resourceId: resourceInput?.id ?? null,
    });

    const state = randomBytes(32).toString('base64url');
    const codeVerifier = randomBytes(32).toString('base64url');
    const sealed = sealCookiePayload(
      { purpose: 'reauth', state, code_verifier: codeVerifier, nonce: started.nonce },
      s.cookiePassword,
    );
    setCookie(res, REAUTH_TXN_COOKIE, sealed, {
      maxAgeSeconds: TXN_COOKIE_TTL_SECONDS,
      path: '/auth',
    });
    res.json({
      data: {
        reauth_txn_id: started.transaction.reauthTxnId,
        expires_at: started.transaction.expiresAt.toISOString(),
        authorization_url: provider().buildAuthorizationUrl({
          state,
          codeChallenge: sha256base64url(codeVerifier),
          maxAgeSeconds: 0,
          // The reauth leg MUST return to /auth/reauth/callback: the login
          // callback reads a different transaction cookie and would strand it.
          redirectUri: s.reauthRedirectUri,
        }),
      },
    });
  }),
);

// ── GET /auth/reauth/callback ──────────────────────────────────────────────
router.get(
  '/reauth/callback',
  asyncRoute(async (req, res) => {
    const s = settings();
    const sealed = readCookie(req, REAUTH_TXN_COOKIE);
    const txn =
      sealed === undefined
        ? null
        : openCookiePayload(sealed, s.cookiePassword, { maxAgeSeconds: TXN_COOKIE_TTL_SECONDS });
    const code = req.query.code;
    if (
      txn === null ||
      txn.purpose !== 'reauth' ||
      typeof code !== 'string' ||
      typeof req.query.state !== 'string' ||
      req.query.state !== txn.state
    ) {
      clearCookie(res, REAUTH_TXN_COOKIE, '/auth');
      throw new UnauthorizedError('Reauthentication failed');
    }
    clearCookie(res, REAUTH_TXN_COOKIE, '/auth');

    const exchanged = await provider().exchangeCode({
      code,
      codeVerifier: String(txn.code_verifier),
    });
    let verified;
    try {
      verified = await verifier().verify(exchanged.accessToken);
    } catch (err) {
      if (err instanceof TokenVerificationError)
        throw new UnauthorizedError('Reauthentication failed');
      throw err;
    }
    if (verified.organizationId === null) throw new UnauthorizedError('Reauthentication failed');
    const connection = await resolveActiveConnection(verified.organizationId);
    if (connection === null) throw new UnauthorizedError('Reauthentication failed');
    const link = await findUserLinkByProviderIdentity(connection.tenantId, verified.providerUserId);
    if (link === null || link.status !== 'activated') {
      throw new UnauthorizedError('Reauthentication failed');
    }

    const completed = await completeReauthentication({
      nonce: String(txn.nonce),
      userLinkId: link.userLinkId,
      verifiedAuthTime: verified.authTime,
      clockSkewSeconds: s.oidcClockSkewSeconds,
    });
    if (completed === null) throw new UnauthorizedError('Reauthentication failed');
    res.json({
      data: {
        grant: completed.grant,
        expires_at: completed.grantExpiresAt.toISOString(),
        reauth_txn_id: completed.transaction.reauthTxnId,
      },
    });
  }),
);

export default router;
