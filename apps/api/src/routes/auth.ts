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
  claimLoginTransactionAtomically,
  completeReauthentication,
  failLoginTransaction,
  createAccessTokenVerifier,
  createSession,
  createWorkosProvider,
  csrfTokenForSession,
  observeUserLinkOnLogin,
  findActiveConnectionById,
  findUserLinkByProviderIdentity,
  listActiveSupportSessions,
  openCookiePayload,
  resolveActiveConnection,
  revokeSessionByToken,
  rolesForUserLink,
  sealCookiePayload,
  startLoginTransaction,
  startReauthentication,
  type AccessTokenVerifier,
  type IdentityProviderPort,
} from '@dealer/identity-access';
import {
  SESSION_COOKIE,
  actionCatalog,
  authenticate,
  policyEngine,
  readCookie,
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
  // Secure everywhere except explicit local development/test — staging is
  // NOT a place to drop the flag.
  return !getConfig().isLocalDevelopment;
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
  // R3 section J: a clearing cookie must carry the SAME attributes as the one
  // it replaces. Dropping Secure makes the clear a no-op for a __Secure-style
  // cookie and can leave the original live over a plaintext downgrade.
  const parts = [`${name}=`, 'Max-Age=0', `Path=${path}`, 'HttpOnly', 'SameSite=Lax'];
  if (secureCookies()) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
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
    // FBL-020-R2: the AUTHORITY for state, nonce, PKCE and redirect is a
    // server row that expires and is consumed exactly once. The cookie below
    // is only the pointer that carries the plaintext back for comparison, so
    // a replayed callback loses an atomic UPDATE rather than being trusted.
    const txn = await startLoginTransaction({
      purpose: 'login',
      redirectUri: s.redirectUri,
      returnTo: safeReturnTo(req.query.return_to),
      ttlSeconds: TXN_COOKIE_TTL_SECONDS,
    });
    const state = txn.state;
    const codeVerifier = txn.codeVerifier;
    const oidcNonce = txn.nonce;
    const sealed = sealCookiePayload(
      {
        purpose: 'login',
        login_txn_id: txn.loginTxnId,
        state,
        code_verifier: codeVerifier,
        oidc_nonce: oidcNonce,
        return_to: safeReturnTo(req.query.return_to),
      },
      s.cookiePassword,
    );
    setCookie(res, AUTH_TXN_COOKIE, sealed, {
      maxAgeSeconds: TXN_COOKIE_TTL_SECONDS,
      path: '/auth',
    });
    res.redirect(
      provider().buildAuthorizationUrl({
        state,
        codeChallenge: sha256base64url(codeVerifier),
        nonce: oidcNonce,
      }),
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

    // Atomically claim the SERVER transaction. A replay, an expired row, an
    // unknown state and a tampered cookie are one indistinguishable failure.
    const claimed = await claimLoginTransactionAtomically({
      state: String(txn.state),
      purpose: 'login',
      nonce: String(txn.oidc_nonce),
      codeVerifier: String(txn.code_verifier),
    });
    if (claimed === null) throw new UnauthorizedError('Authentication failed');

    let exchanged;
    try {
      exchanged = await provider().exchangeCode({
        code,
        codeVerifier: String(txn.code_verifier),
      });
    } catch {
      // The provider exchange failed: burn the claimed transaction so its
      // state can never be presented again, and answer neutrally.
      await failLoginTransaction(claimed.loginTxnId);
      throw new UnauthorizedError('Authentication failed');
    }
    let verified;
    try {
      // The nonce bound to THIS single-use transaction must come back in the
      // token: missing, mismatched, expired or replayed all fail closed.
      verified = await verifier().verify(exchanged.accessToken, {
        requireNonce: String(txn.oidc_nonce),
      });
    } catch (err) {
      if (err instanceof TokenVerificationError)
        throw new UnauthorizedError('Authentication failed');
      throw err;
    }
    const connection = await resolveActiveConnection(verified.organizationId);
    if (connection === null) throw new UnauthorizedError('Authentication failed');

    // FBL-020-R1 section B: login OBSERVES the identity. It may create or
    // refresh a PENDING link, and it never activates one. Only an already
    // activated link receives a session; everything else is a neutral 401,
    // so pending, deactivated and unknown are externally indistinguishable.
    const link = await observeUserLinkOnLogin({
      tenantId: connection.tenantId,
      provider: IDENTITY_PROVIDER_WORKOS,
      providerUserId: verified.providerUserId,
      email: exchanged.email,
      displayName: exchanged.displayName,
    });
    if (link === null || link.status !== 'activated') {
      throw new UnauthorizedError('Authentication failed');
    }

    const created = await createSession({
      tenantId: connection.tenantId,
      userLinkId: link.userLinkId,
      providerSessionId: verified.providerSessionId,
      authTime: verified.authTime,
      ttlSeconds: SESSION_TTL_SECONDS,
      connectionId: connection.connectionId,
      issuer: connection.issuer,
      providerSubject: verified.providerUserId,
      providerOrganizationId: connection.providerOrganizationId,
      refreshToken: exchanged.refreshToken,
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

    // A sensitive action demands HIGH assurance: a fresh provider
    // authentication AND a connection certifying the organization's MFA
    // policy. The two are separate facts and both are required (R1 §E).
    const connection =
      identity.connectionId === null ? null : await findActiveConnectionById(identity.connectionId);
    const requiredAssurance = 'fresh_and_mfa_policy' as const;

    if (connection === null) {
      // No provable connection means no reauthentication can be bound.
      throw new UnauthorizedError('Reauthentication is unavailable');
    }
    const oidcNonce = randomBytes(32).toString('base64url');
    const started = await startReauthentication({
      tenantId: identity.tenantId,
      userLinkId: identity.userLinkId,
      action: boundAction,
      resourceType: resourceInput?.type ?? null,
      resourceId: resourceInput?.id ?? null,
      requiredAssurance,
      oidcNonce,
      // R2: the exact identity this reauthentication starts from
      connectionId: connection.connectionId,
      issuer: connection.issuer,
      providerOrganizationId: connection.providerOrganizationId,
      providerSubject: identity.providerSubject,
    });

    const state = randomBytes(32).toString('base64url');
    const codeVerifier = randomBytes(32).toString('base64url');
    const sealed = sealCookiePayload(
      {
        purpose: 'reauth',
        state,
        code_verifier: codeVerifier,
        nonce: started.nonce,
        oidc_nonce: oidcNonce,
      },
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
        required_assurance: requiredAssurance,
        mfa_policy_certified: connection?.mfaPolicyCertified === true,
        authorization_url: provider().buildAuthorizationUrl({
          state,
          codeChallenge: sha256base64url(codeVerifier),
          maxAgeSeconds: 0,
          nonce: oidcNonce,
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
      verified = await verifier().verify(exchanged.accessToken, {
        requireNonce: String(txn.oidc_nonce),
      });
    } catch (err) {
      if (err instanceof TokenVerificationError)
        throw new UnauthorizedError('Reauthentication failed');
      throw err;
    }
    const connection = await resolveActiveConnection(verified.organizationId);
    if (connection === null) throw new UnauthorizedError('Reauthentication failed');
    const link = await findUserLinkByProviderIdentity(connection.tenantId, verified.providerUserId);
    if (link === null || link.status !== 'activated') {
      throw new UnauthorizedError('Reauthentication failed');
    }

    // Freshness comes from auth_time; the MFA policy fact comes from the
    // connection. A high-assurance transaction fails closed without both.
    const completed = await completeReauthentication({
      nonce: String(txn.nonce),
      userLinkId: link.userLinkId,
      verifiedAuthTime: verified.authTime,
      clockSkewSeconds: s.oidcClockSkewSeconds,
      connection: {
        connectionId: connection.connectionId,
        mfaPolicyCertified: connection.mfaPolicyCertified,
      },
      // R2: what the returning token actually proved, revalidated against
      // what the transaction started from.
      verifiedIssuer: connection.issuer,
      verifiedOrganizationId: verified.organizationId,
      verifiedProviderSubject: verified.providerUserId,
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
