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
import { createHash } from 'node:crypto';
import {
  NotFoundError,
  UnauthorizedError,
  ValidationError,
  getConfig,
  getRequestContext,
  type AppConfig,
} from '@dealer/platform';
import {
  SUPPORT_ACCESS_HEADER,
  TokenVerificationError,
  admitLoginAndEstablishSession,
  claimLoginTransactionAtomically,
  claimReauthentication,
  completeReauthentication,
  exchangeMatchesVerifiedToken,
  failLoginTransaction,
  failReauthentication,
  createAccessTokenVerifier,
  csrfTokenForSession,
  describeAuthenticatedSession,
  findActiveConnectionById,
  findUserLinkByProviderIdentity,
  openCookiePayload,
  resolveActiveConnection,
  revokeSessionByToken,
  revokeSessionById,
  sealCookiePayload,
  startLoginTransaction,
  startReauthentication,
  supportAccessHeaderValue,
  type AccessTokenVerifier,
  type IdentityProviderPort,
  type LoginTransactionFailureReason,
} from '@dealer/identity-access';
import {
  SESSION_COOKIE,
  actionCatalog,
  authenticate,
  policyEngine,
  readCookie,
} from '../middleware/auth';
import { identityProvider, resetIdentityProviderForTests } from '../identity/provider';

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

let verifierInstance: AccessTokenVerifier | undefined;

/**
 * R3 correction C1: the port is resolved from the SHARED accessor. Request
 * authentication now refreshes provider sessions too, so a second adapter
 * constructed here would mean two SDK clients and two configurations for one
 * process.
 */
function provider(): IdentityProviderPort {
  return identityProvider(settings());
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
  resetIdentityProviderForTests();
  verifierInstance = undefined;
}

/**
 * FBL-020-R3 correction B1 — `Secure` is decided by the configuration fact
 * that carries a HOST condition, not by NODE_ENV.
 *
 * This used to read `isLocalDevelopment`, which is NODE_ENV alone, so a real
 * deployment with all-remote HTTPS identity URLs that happened to run
 * NODE_ENV=development issued its session and transaction cookies — and its
 * clearing cookies — WITHOUT `Secure`, over the public internet.
 * `allowsInsecureCookies` is true only for development/test with EVERY
 * identity URL on loopback.
 */
function secureCookies(config: AppConfig): boolean {
  return !config.allowsInsecureCookies;
}

/**
 * The Set-Cookie header this surface emits, as a pure function of the
 * configuration — exported so a test can assert the `Secure` ATTRIBUTE that
 * actually reaches the wire, not merely the intent behind it. Both writers
 * below are this function, so a cookie and the cookie that clears it cannot
 * carry different attributes.
 */
export function identitySetCookieHeader(
  config: AppConfig,
  name: string,
  value: string,
  options: { maxAgeSeconds: number; path: string },
): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Max-Age=${options.maxAgeSeconds}`,
    `Path=${options.path}`,
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (secureCookies(config)) parts.push('Secure');
  return parts.join('; ');
}

function setCookie(
  res: Response,
  name: string,
  value: string,
  options: { maxAgeSeconds: number; path: string },
): void {
  res.append('Set-Cookie', identitySetCookieHeader(getConfig(), name, value, options));
}

function clearCookie(res: Response, name: string, path: string): void {
  // R3 section J: a clearing cookie must carry the SAME attributes as the one
  // it replaces. Dropping Secure makes the clear a no-op for a __Secure-style
  // cookie and can leave the original live over a plaintext downgrade. It is
  // the same builder, so "the same attributes" is structural rather than a
  // pair of lists that must be kept in step by hand.
  res.append(
    'Set-Cookie',
    identitySetCookieHeader(getConfig(), name, '', { maxAgeSeconds: 0, path }),
  );
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

/**
 * The correlation identifiers THIS request's log lines already carry. Taken
 * from the request context rather than from the raw headers on purpose: the
 * context has already screened a caller-supplied value (or generated one), so
 * the transaction row and the logs name the same request and no hostile header
 * value can reach the table. The identity package screens them again on the
 * way in — one policy, enforced twice, never bypassed.
 */
function correlation(): { requestId: string | null; correlationId: string | null } {
  const context = getRequestContext();
  return {
    requestId: context?.requestId ?? null,
    correlationId: context?.correlationId ?? null,
  };
}

/**
 * How a sealed transaction cookie is opened everywhere on this surface: its
 * own maximum age, and the CONFIGURED clock tolerance as the only allowance
 * for a seal stamped ahead of us (R3 — a forward-dated seal never ages out).
 */
function openTxnCookie(sealed: string, s: ReturnType<typeof settings>) {
  return openCookiePayload(sealed, s.cookiePassword, {
    maxAgeSeconds: TXN_COOKIE_TTL_SECONDS,
    clockToleranceSeconds: s.oidcClockSkewSeconds,
  });
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
      // R3: the RETURN LOCATION is a server fact. It is allowlisted here and
      // stored on the row; the browser never carries it, so a client cannot
      // restate where a successful login lands by editing what it holds.
      returnTo: safeReturnTo(req.query.return_to),
      ttlSeconds: TXN_COOKIE_TTL_SECONDS,
      ...correlation(),
    });
    const state = txn.state;
    const codeVerifier = txn.codeVerifier;
    const oidcNonce = txn.nonce;
    // R3: the cookie carries the OPAQUE HANDLE plus the minimal round-trip
    // state the server must compare against its stored digests — and nothing
    // else. Everything the server can hold, the server holds.
    const sealed = sealCookiePayload(
      {
        purpose: 'login',
        login_txn_id: txn.loginTxnId,
        state,
        code_verifier: codeVerifier,
        oidc_nonce: oidcNonce,
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
    const txn = sealed === undefined ? null : openTxnCookie(sealed, s);
    const code = req.query.code;
    // ── FBL-020-R6 §2.1: THE ROUTE DECIDES EXACTLY ONE THING ──────────────
    //
    // Is there a valid sealed cookie naming a SERVER TRANSACTION HANDLE? That is
    // the only question this leg is entitled to answer for itself, because it is
    // the only one that can be answered without the row: no cookie, a cookie that
    // does not open under the server key, or a cookie carrying no handle names no
    // claimable transaction at all, so there is nothing to terminalize and nothing
    // to attribute an audit event to — inventing one would be fabricating evidence.
    //
    // WHAT MOVED OUT OF THIS GUARD, and why. R5 also refused here when the query
    // `state` was missing or disagreed with the SEALED copy — even for a valid
    // handle naming a live `pending` row. That refusal spent nothing: the row stayed
    // `pending` with its state unburned and no audit event, so the transaction the
    // callback named survived the callback that named it. The authority for `state`
    // is the digest ON THE ROW, not a copy in the browser, and the same is true of
    // the PKCE verifier, the OIDC nonce, the purpose and the registered redirect.
    // Every one of them is now PRESENTED to the lifecycle service and classified
    // there, with the row locked, in one transaction that ends terminally.
    //
    // (R5 §1.5 had already moved `typeof code !== 'string'` out for the same
    // reason: a provider `error` callback carries the original state and no code,
    // and refusing it here left its transaction pending until the sweep aged it.)
    clearCookie(res, AUTH_TXN_COOKIE, '/auth');
    if (txn === null) throw new UnauthorizedError('Authentication failed');
    const handle = typeof txn.login_txn_id === 'string' ? txn.login_txn_id : null;
    if (handle === null) throw new UnauthorizedError('Authentication failed');

    // Atomically claim the SERVER transaction: pending -> consuming. A replay
    // at any stage, an expired row, an unknown handle and a tampered cookie are
    // one indistinguishable failure. Nothing is declared succeeded here — the
    // claim only says the state is spent and this request owns it.
    //
    // FBL-020-R4 §1: the claim names the OPAQUE TRANSACTION HANDLE and the EXACT
    // registered redirect this leg was opened for, on top of purpose, state, nonce
    // and the PKCE binding. R3 claimed by state alone, so nothing proved the
    // callback presenting a state was the callback that had been handed the
    // transaction, and nothing tied the leg to its own redirect.
    //
    // FBL-020-R6 §2.1: each presented value may be `null` — "the callback did not
    // carry this" — and the service classifies that as the mismatch it is. The
    // route does not pre-screen any of them.
    const presented = (name: string): string | null => {
      const value = txn[name];
      return typeof value === 'string' ? value : null;
    };
    const claimed = await claimLoginTransactionAtomically({
      loginTxnId: handle,
      // The state the PROVIDER returned, compared against the digest the START
      // stored. The sealed copy is not consulted: a value the browser carries
      // cannot be one side of its own comparison.
      state: typeof req.query.state === 'string' ? req.query.state : null,
      purpose: 'login',
      presentedPurpose: presented('purpose'),
      nonce: presented('oidc_nonce'),
      codeVerifier: presented('code_verifier'),
      redirectUri: s.redirectUri,
    });
    if (claimed === null) throw new UnauthorizedError('Authentication failed');

    // Every exit from here to the end of the leg is TERMINAL: the claimed
    // transaction reaches `failed` with a reason, or `succeeded` after a
    // session exists. It can never be left mid-flight for a replay to find.
    // The answer outward is the SAME neutral 401 in every case; the reason is
    // recorded on the row, never rendered.
    const refusal = async (reason: LoginTransactionFailureReason): Promise<UnauthorizedError> => {
      await failLoginTransaction(claimed.loginTxnId, reason);
      return new UnauthorizedError('Authentication failed');
    };

    // FBL-020-R5 §1.5 — the two terminal ends that need no provider call.
    //
    // Order matters: a provider `error` callback carries no `code` either, so
    // testing `error` first is what keeps the recorded reason the TRUE one rather
    // than collapsing an authorization-server refusal into "malformed callback".
    //
    // The provider's `error` and `error_description` values are read only to
    // decide THAT this is an error callback. Neither is stored, logged or
    // returned: the vocabulary on the row is the server's own, and the answer
    // outward is the same neutral 401 as every other refusal on this leg.
    if (typeof req.query.error === 'string' && req.query.error.length > 0) {
      throw await refusal('provider_error_callback');
    }
    if (typeof code !== 'string' || code.length === 0) {
      throw await refusal('authorization_code_missing');
    }

    let exchanged;
    try {
      exchanged = await provider().exchangeCode({
        code,
        codeVerifier: String(txn.code_verifier),
      });
    } catch {
      // The provider exchange failed: burn the claimed transaction so its
      // state can never be presented again, and answer neutrally.
      throw await refusal('provider_exchange_failed');
    }
    let verified;
    try {
      // The nonce bound to THIS single-use transaction must come back in the
      // token: missing, mismatched, expired or replayed all fail closed. R3:
      // so do impossible token times — a future iat or auth_time, or an exp
      // that precedes the iat, judged against the configured tolerance alone.
      verified = await verifier().verify(exchanged.accessToken, {
        requireNonce: String(txn.oidc_nonce),
      });
    } catch (err) {
      if (err instanceof TokenVerificationError) throw await refusal('token_verification_failed');
      // Not a verification refusal but a fault: the transaction is still
      // terminated, so a retry of the same state cannot pick it up.
      await failLoginTransaction(claimed.loginTxnId, 'token_verification_failed');
      throw err;
    }

    // ── FBL-020-R5 §1.3: ADMISSION AND CUSTODY, ONE ATOMIC DECISION ───────
    //
    // Everything that must hold before a session can exist is decided by the
    // identity package — the exchange response bound EXACTLY to the verified token
    // (provider user, organization, provider session id and impersonation state),
    // the connection active and effective with its issuer EQUAL to the configured
    // trusted issuer, the tenant and its organization hierarchy active and
    // effective, and the UserLink activated AND inside its effective window — and
    // the session is established, with the provider refresh credential sealed into
    // it, in THE SAME TRANSACTION under the same row locks.
    //
    // R4 called two functions here: an admission that committed, then a
    // `createSession` that inserted unconditionally. A suspension, disablement,
    // deactivation, relink or window closure landing between those two commits
    // still produced a session AND stored the provider credential. The route
    // cannot fix that by asking again — that is the same defect one step later —
    // so there is one call, and it does not offer an admission without a session.
    //
    // THE PROVIDER CALLS ARE ABOVE, AND STAY THERE. Both carriers were obtained
    // before this line; nothing below opens a network call, and no transaction is
    // held across one.
    let admission;
    try {
      admission = await admitLoginAndEstablishSession({
        trustedIssuer: s.issuer,
        exchanged,
        verified,
        // FBL-020-R6 §2.5: the CLAIMED transaction goes in, because the success
        // transition is part of the same commit as the custody. The route no longer
        // records it afterwards — it has no afterwards to record it in.
        loginTxnId: claimed.loginTxnId,
        session: {
          ttlSeconds: SESSION_TTL_SECONDS,
          // R3: the refresh token is stored as SEALED ciphertext (plus its replay
          // digest) so a later refresh can actually present it to the provider.
          cookiePassword: s.cookiePassword,
        },
      });
    } catch (err) {
      // A login that produced no local session did not succeed, whatever the
      // provider said. Terminate the transaction before rethrowing.
      await failLoginTransaction(claimed.loginTxnId, 'session_establishment_failed');
      throw err;
    }
    if (!admission.admitted) {
      // FBL-020-R6 §2.3/§2.5 — the transaction could not be completed: it had
      // expired in DATABASE TIME at the moment of completion, or it was no longer
      // `consuming`. Nothing survives (the session row and the sealed provider
      // credential rolled back with the refused transition) and the identity
      // package has ALREADY recorded the terminal state and its one audit event,
      // so this leg answers neutrally and writes nothing further. R5 handed the
      // cookie out here and then tried to compensate with a revocation.
      if (admission.refusal === 'login_not_completable') {
        throw new UnauthorizedError('Authentication failed');
      }
      // ONE neutral answer for every other condition. The internal reason is
      // recorded on the transaction row and in the audit trail; nothing
      // distinguishes an inactive tenant from a pending link, an expired window,
      // an issuer drift or a carrier mismatch from outside.
      throw await refusal(
        admission.refusal === 'impersonation_detected'
          ? 'impersonation_detected'
          : admission.refusal === 'exchange_token_mismatch'
            ? 'exchange_token_mismatch'
            : 'identity_not_admitted',
      );
    }
    const created = admission.created;

    setCookie(res, SESSION_COOKIE, created.sessionToken, {
      maxAgeSeconds: SESSION_TTL_SECONDS,
      path: '/',
    });
    // The RETURN LOCATION comes from the SERVER ROW, never from the cookie:
    // the browser carried only the handle, so the destination of a successful
    // login is not something a client can restate. It is re-allowlisted on the
    // way out because a stored value is still an input.
    res.redirect(safeReturnTo(claimed.returnTo));
  }),
);

// ── POST /auth/logout ──────────────────────────────────────────────────────
router.post(
  '/logout',
  authenticate,
  asyncRoute(async (req, res) => {
    const identity = req.identity;
    if (identity === undefined) throw new UnauthorizedError('Authentication required');
    // R3: logout is a LOCAL act on BOTH credentials. The bearer path used to be
    // refused here because there was no local object to revoke; now there is,
    // and revoking it denies the very next request made with the same — still
    // provider-valid — access token.
    if (identity.credential === 'session') {
      const cookie = readCookie(req, SESSION_COOKIE);
      if (cookie !== undefined) await revokeSessionByToken(cookie, 'logout');
      clearCookie(res, SESSION_COOKIE, '/');
    } else if (identity.sessionId !== null) {
      await revokeSessionById(identity.sessionId, 'logout');
    }
    // The PROVIDER's session identifier, never the local one: handing the
    // provider our own session id would produce a logout URL that ends nothing.
    const logoutUrl =
      identity.providerSessionId === null
        ? null
        : provider().buildLogoutUrl({ providerSessionId: identity.providerSessionId });
    res.json({ data: { logged_out: true, provider_logout_url: logoutUrl } });
  }),
);

// ── GET /auth/session ──────────────────────────────────────────────────────
//
// FBL-020-R3: a BOUNDED response. R2 answered with whatever the request
// identity happened to carry, which made the endpoint's contract "everything
// the server knows" and put the provider session id and the credential kind on
// the wire for no authorization purpose whatsoever. The body is now exactly the
// eight facts `describeAuthenticatedSession` produces — the identity package
// owns the shape, so a later field cannot be added here by accident. No email,
// no display name, no provider profile, no provider subject or session id, no
// access or refresh token, no refresh state.
//
// The CSRF token is NOT an identity fact and is therefore not in the body. It
// still has to reach the page — a cookie client cannot make an unsafe request
// without it — so it travels as its own response header, which is where an
// anti-forgery value belongs. It is a keyed HMAC over the local session id and
// is unusable without that cookie.
router.get(
  '/session',
  authenticate,
  asyncRoute(async (req, res) => {
    const identity = req.identity!;
    const s = settings();
    const view = await describeAuthenticatedSession({
      userLinkId: identity.userLinkId,
      tenantId: identity.tenantId,
      actorScope: identity.actorScope,
      sessionId: identity.sessionId,
    });
    // FBL-020-R4 §4: the SAME formatter the authorization middleware uses, so this
    // header and that one cannot describe the same thing differently — and neither can
    // be built without an expiry. R3 had two hand-written formats here and there, both
    // naming a session id and nothing else.
    const supportHeader = supportAccessHeaderValue(view.supportAccess);
    if (supportHeader !== null) {
      res.setHeader(SUPPORT_ACCESS_HEADER, supportHeader);
    }
    if (identity.credential === 'session' && identity.sessionId !== null) {
      res.setHeader('x-csrf-token', csrfTokenForSession(identity.sessionId, s.cookiePassword));
    }
    res.json({
      data: {
        user_link_id: view.userLinkId,
        tenant_id: view.tenantId,
        organization_scope: {
          actor_scope: view.organizationScope.actorScope,
          tenant_effective: view.organizationScope.tenantEffective,
          scopes: view.organizationScope.scopes.map((x) => ({
            level: x.level,
            id: x.id,
            effective: x.effective,
          })),
        },
        roles: view.roles,
        freshness: view.freshness,
        mfa_assurance: view.mfaAssurance,
        local_session_expires_at: view.localSessionExpiresAt?.toISOString() ?? null,
        // FBL-020-R4 §4 — the WHOLE grant, both directions.
        //
        // R3 published four fields (session, actor, granted, expiry) for grants into
        // the caller's tenant, and nothing at all for a platform actor's own live
        // access. A tenant administrator could see that somebody was in their data
        // and not what they were approved to do; a platform-support person could not
        // see their own access at all.
        //
        // Still bounded, and the bound is unchanged: identifiers, classifications and
        // instants. No email, no display name, no provider subject or session id, no
        // token, and never the free-text support reason.
        support_access: view.supportAccess.map((x) => ({
          relationship: x.relationship,
          support_session_id: x.supportSessionId,
          support_request_id: x.supportRequestId,
          actor_user_link_id: x.supportActorUserLinkId,
          target_tenant_id: x.targetTenantId,
          approved_scope_level: x.approvedScopeLevel,
          approved_scope_id: x.approvedScopeId,
          approved_actions: x.approvedActions,
          granted_at: x.grantedAt.toISOString(),
          expires_at: x.expiresAt.toISOString(),
        })),
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
      // FBL-020-R4 §2.5 — THE PRESENTED SESSION, WHICH THIS ROUTE USED TO OMIT.
      //
      // This pre-check is a real authorization decision about a real person on a
      // real credential, and it passed no session at all: its append-only
      // evidence row named no presented session, no authentication instant, no
      // connection and no provider subject, so the one decision taken
      // immediately before a step-up was the least reconstructable in the
      // system. The engine derives the rest of the credential facts from this id.
      sessionId: identity.sessionId,
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

    if (connection === null || identity.sessionId === null) {
      // No provable connection, or no live LOCAL session to step up FROM,
      // means no reauthentication can be bound to anything.
      throw new UnauthorizedError('Reauthentication is unavailable');
    }
    // FBL-020-R3: the starting identity is DERIVED by the identity package from
    // the live local session — this route supplies no binding of its own. What
    // it passes below is an EXPECTATION taken from the already-authenticated
    // request, and a disagreement refuses the start rather than being adopted.
    // The OIDC nonce is generated inside the same statement that stores its
    // digest, so nothing here (and no caller) ever chooses it.
    const started = await startReauthentication({
      tenantId: identity.tenantId,
      userLinkId: identity.userLinkId,
      sessionId: identity.sessionId,
      action: boundAction,
      resourceType: resourceInput?.type ?? null,
      resourceId: resourceInput?.id ?? null,
      requiredAssurance,
      // FBL-020-R4 §3: the EXACT callback this leg will be completed at, stored
      // on the server row and re-compared when the callback claims it.
      callbackUri: s.reauthRedirectUri,
      expectedConnectionId: connection.connectionId,
      expectedIssuer: connection.issuer,
      expectedProviderOrganizationId: connection.providerOrganizationId,
      expectedProviderSubject: identity.providerSubject,
    });
    if (started === null) {
      // The chain no longer holds, or the request's view of it disagreed with
      // the database's. Both are the same neutral refusal outward.
      throw new UnauthorizedError('Reauthentication is unavailable');
    }
    const oidcNonce = started.oidcNonce;

    // FBL-020-R4 §3 — THE ROUTE NO LONGER CHOOSES THE ROUND-TRIP STATE.
    //
    // R3 generated `state` and the PKCE verifier here and put them in the sealed
    // cookie, and the server stored NEITHER: the only record of what the callback
    // had to present was the browser's copy, so the step-up's round-trip state
    // was client-authoritative and nothing could say "this one is spent". Both
    // values are now generated inside the same statement that persists their
    // digests. The cookie carries the plaintext back for comparison; the ROW is
    // the authority.
    const state = started.state;
    const codeVerifier = started.codeVerifier;
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
    const txn = sealed === undefined ? null : openTxnCookie(sealed, s);
    const code = req.query.code;
    // FBL-020-R6 §2.1, the step-up leg — same rule, same reason as the login
    // callback above: the ONLY thing decided here is whether a valid sealed cookie
    // names a server handle. A missing or disagreeing `state`, a disagreeing PKCE
    // verifier, a disagreeing purpose and a disagreeing callback URI are all
    // presented to the claim and classified against the ROW's stored digests, under
    // its lock, terminally. R5 refused the state cases here and left the row at
    // `started` with its nonce still claimable.
    //
    // (R5 §1.5 had already moved the provider `error` callback and the
    // missing-`code` callback past this guard, for the same reason.)
    clearCookie(res, REAUTH_TXN_COOKIE, '/auth');
    if (txn === null) throw new UnauthorizedError('Reauthentication failed');
    const handle = typeof txn.nonce === 'string' ? txn.nonce : null;
    if (handle === null) throw new UnauthorizedError('Reauthentication failed');

    // ── FBL-020-R4 §3: THE SERVER ROW CLAIMS ITS OWN CALLBACK, ONCE ───────
    //
    // Before a single provider call is made, the transaction row compares the
    // opaque handle, the OAuth state, the PKCE verifier and the exact callback
    // URI against what it stored at start, and marks itself claimed in the same
    // conditional UPDATE. A second callback bearing the same state loses to the
    // database. Every refusal below is one neutral answer and one recorded
    // terminal state — never a row left at `started` for a replay to find.
    const presented = (name: string): string | null => {
      const value = txn[name];
      return typeof value === 'string' ? value : null;
    };
    const claim = await claimReauthentication({
      nonce: handle,
      // The state the PROVIDER returned, never the sealed copy of it.
      state: typeof req.query.state === 'string' ? req.query.state : null,
      presentedPurpose: presented('purpose'),
      codeVerifier: presented('code_verifier'),
      callbackUri: s.reauthRedirectUri,
    });
    if (claim === null) throw new UnauthorizedError('Reauthentication failed');

    // From here on EVERY exit is terminal: the claimed transaction reaches
    // `failed` with a closed-vocabulary reason and exactly one audit event, or
    // `completed` with its grant. R3 returned a bare 401 from each of these
    // branches and left the row at `started`, which is the defect this closes.
    const refusal = async (
      reason: Parameters<typeof failReauthentication>[0]['reason'],
    ): Promise<UnauthorizedError> => {
      await failReauthentication({ nonce: handle, reason });
      return new UnauthorizedError('Reauthentication failed');
    };

    // FBL-020-R5 §1.5 — terminal, before any provider call. `error` is tested
    // first so an authorization-server refusal is recorded as one; neither the
    // provider's error code nor its description is stored, logged or returned.
    if (typeof req.query.error === 'string' && req.query.error.length > 0) {
      throw await refusal('provider_error_callback');
    }
    if (typeof code !== 'string' || code.length === 0) {
      throw await refusal('authorization_code_missing');
    }

    let exchanged;
    try {
      exchanged = await provider().exchangeCode({
        code,
        codeVerifier: String(txn.code_verifier),
      });
    } catch {
      throw await refusal('provider_exchange_failed');
    }
    // R3: an impersonated re-authentication proves nothing about the ACTOR,
    // so it can never mint a step-up grant.
    if (exchanged.impersonation.impersonated || exchanged.impersonation.impersonatorEmailPresent) {
      throw await refusal('impersonation_detected');
    }
    let verified;
    try {
      verified = await verifier().verify(exchanged.accessToken, {
        requireNonce: String(txn.oidc_nonce),
      });
    } catch (err) {
      if (err instanceof TokenVerificationError) throw await refusal('token_verification_failed');
      // A fault rather than a verification refusal: the transaction is STILL
      // terminated before the error propagates, so nothing is left in flight.
      await failReauthentication({ nonce: handle, reason: 'token_verification_failed' });
      throw err;
    }
    if (verified.impersonation.impersonated || verified.impersonation.impersonatorEmailPresent) {
      throw await refusal('impersonation_detected');
    }
    // R4 §3: the two carriers of this identity must agree EXACTLY — provider
    // user, organization, provider session id and impersonation state — exactly
    // as the login leg requires. The step-up leg compared neither in R3.
    if (!exchangeMatchesVerifiedToken(exchanged, verified)) {
      throw await refusal('binding_mismatch');
    }
    const connection = await resolveActiveConnection(verified.organizationId);
    // …and the connection's issuer must be the CONFIGURED trusted issuer, not
    // merely some issuer the row happens to carry.
    if (connection === null || connection.issuer !== s.issuer) {
      throw await refusal('identity_not_admitted');
    }
    // R3: six facts, same as every other credential path.
    const link = await findUserLinkByProviderIdentity({
      tenantId: connection.tenantId,
      providerUserId: verified.providerUserId,
      connectionId: connection.connectionId,
      issuer: connection.issuer,
      providerOrganizationId: connection.providerOrganizationId,
    });
    if (link === null || link.status !== 'activated') {
      throw await refusal('identity_not_admitted');
    }

    // Everything the completion judges is a VERIFIED fact from this round
    // trip, and nothing is optional. Freshness comes from auth_time; the OIDC
    // nonce is compared as a digest against the one the transaction STORED (the
    // cookie compare above is a second, independent check, not the authority);
    // issuer, organization, subject and connection must each equal what the
    // transaction was bound to; and the MFA policy fact is re-read from the
    // connection row inside the completion. A missing value is a failure there,
    // never a skipped comparison, so passing `verified.nonceDigest` straight
    // through is safe even when the token carried no nonce at all.
    const completed = await completeReauthentication({
      nonce: handle,
      userLinkId: link.userLinkId,
      verifiedAuthTime: verified.authTime,
      clockSkewSeconds: s.oidcClockSkewSeconds,
      verifiedNonceDigest: verified.nonceDigest,
      verifiedConnectionId: connection.connectionId,
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
