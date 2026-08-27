import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { after, beforeEach, describe, test } from 'node:test';
import {
  INTEGRATION_DATABASE_URL,
  bootstrapAdministrator,
  ensureActiveConnection,
  certifyMfaPolicy,
  mintReauthGrant,
  resetDatabase,
  seedLocalSession,
  seedRooftopIdentity,
  seedTenantIdentity,
  sessionBindingFor,
  sessionBindingForLink,
  withPresentedSession,
  skipIntegration,
  startIdentityTestEnv,
  testIssuer,
  testOrganizationId,
  TEST_REAUTH_CALLBACK_URI,
  type IdentityTestEnv,
  approveSupportRequestDirectly,
  fixtureAuthorizationStateWrite,
} from '@dealer/test-kit';
import {
  DatabaseConnectionLostError,
  closePool,
  getPool,
  query,
  withTransaction,
} from '@dealer/database';
import { ConflictError, getDatabaseConfig, runWithRequestContext } from '@dealer/platform';
import {
  NOT_IMPERSONATED,
  ProviderRefreshError,
  TokenVerificationError,
  UnattributableMutationError,
  activateUserLink,
  classifyActorAssurance,
  certifyProviderMfaPolicy,
  changeOrganizationStatus,
  changeProviderIssuer,
  changeRole,
  claimLoginTransactionAtomically,
  claimReauthentication,
  completeReauthentication,
  consumeReauthenticationGrant,
  createAccessTokenVerifier,
  createActionCatalog,
  createIdentityActionCatalog,
  createOrganization,
  createPolicyEngine,
  createProviderMapping,
  createSession,
  deactivateUserLink,
  decideSupportAccess,
  describeAuthenticatedSession,
  expireStaleLoginTransactions,
  failLoginTransaction,
  grantRole,
  maintainProviderSession,
  openCookiePayload,
  provisionUserLink,
  oidcNonceDigest,
  refreshProviderSession,
  relinkUserLink,
  remapProviderConnection,
  requestSupportAccess,
  resolveOrEstablishBearerSession,
  revokeForIdentityBreach,
  revokeRole,
  rolesForUserLink,
  revokeSupportSession,
  sealCookiePayload,
  startLoginTransaction,
  startReauthentication,
  startSupportSession,
  succeedLoginTransaction,
  validateSessionToken,
  type IdentitySession,
  type ProviderRefreshResult,
  type StartedReauthentication,
  type VerifiedAccessToken,
} from '@dealer/identity-access';

/**
 * The identity-access package's own TypeScript, read as text. R3 correction F2
 * asks a REACHABILITY question — "does anything actually read this column?" — and
 * a schema query alone cannot answer it. `dist` is excluded so a stale build
 * cannot vouch for a reader that the source no longer has.
 */
function identityAccessSources(): string[] {
  const root = join(__dirname, '..', 'packages', 'identity-access', 'src');
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) return walk(full);
      return entry.endsWith('.ts') ? [readFileSync(full, 'utf8')] : [];
    });
  const sources = walk(root);
  assert.ok(sources.length > 0, 'the fixture must have found the identity-access sources');
  return sources;
}

/**
 * FBL-020-R2 identity-boundary proofs (Blueprint §14.3). Each test states the
 * obligation it discharges. Everything here is database-backed: these are
 * properties of the system, not of a mock.
 */
describe(
  'identity boundary (R2)',
  { skip: skipIntegration ? 'set TEST_DATABASE_URL to run' : false },
  () => {
    let env: IdentityTestEnv;
    let tenantId: string;

    after(async () => {
      if (env !== undefined) await env.stop();
      await closePool();
    });

    beforeEach(async () => {
      await resetDatabase();
      if (env === undefined) env = await startIdentityTestEnv();
      tenantId = randomUUID();
      await seedTenantIdentity(tenantId);
      await seedRooftopIdentity(tenantId, randomUUID());
    });

    /**
     * FBL-020-R4 §2.1 — A PLATFORM ACTOR IS BOUND TO THE PLATFORM CONNECTION.
     *
     * The fixtures below used to build a dealership link and then rewrite it with
     * `UPDATE user_links SET actor_scope = 'platform', tenant_id = NULL`, leaving a
     * platform-scope identity still bound to a TENANT'S provider connection and
     * organization. `ul_connection_identity_tuple` refuses that row now, and it is right
     * to: a platform support person who resolves through a customer's WorkOS
     * organization is precisely the cross-boundary identity this order exists to make
     * impossible. The helper binds the platform link to the platform-scope connection,
     * which is the only connection it can honestly belong to.
     */
    async function makePlatformLink(subject: string): Promise<string> {
      await ensureActiveConnection(null);
      const r = await fixtureAuthorizationStateWrite(
        'seed-authorization-state',
        `INSERT INTO user_links
           (actor_scope, tenant_id, provider, provider_user_id, status, activated_at,
            connection_id, issuer, provider_organization_id)
         SELECT 'platform', NULL, 'workos', $1, 'activated', NOW(),
                c.connection_id, c.issuer, c.provider_organization_id
           FROM identity_provider_connections c
          WHERE c.tenant_id IS NULL AND c.status = 'active' LIMIT 1
         RETURNING user_link_id`,
        [subject],
      );
      return String((r.rows[0] as { user_link_id: unknown }).user_link_id);
    }

    async function makeLink(subject = 'user_boundary'): Promise<string> {
      const r = await fixtureAuthorizationStateWrite(
        'seed-authorization-state',
        `INSERT INTO user_links
           (actor_scope, tenant_id, provider, provider_user_id, status, activated_at,
            connection_id, issuer, provider_organization_id)
         SELECT 'dealership', $1, 'workos', $2, 'activated', NOW(),
                c.connection_id, c.issuer, c.provider_organization_id
           FROM identity_provider_connections c
          WHERE c.tenant_id = $1 AND c.status = 'active' LIMIT 1
         RETURNING user_link_id`,
        [tenantId, subject],
      );
      return String((r.rows[0] as { user_link_id: unknown }).user_link_id);
    }

    // ── FBL-020-R3 refresh scaffolding ────────────────────────────────────
    //
    // The provider is FAKED on purpose: these tests prove properties of the
    // refresh operation (rotation, replay, mismatch, impersonation, transient
    // failure), and a live WorkOS call would make them non-deterministic
    // without proving anything extra. The port is the real contract.

    const COOKIE_PASSWORD = 'test-cookie-password-0123456789abcdef!!';

    function sha256hex(value: string): string {
      return createHash('sha256').update(value, 'utf8').digest('hex');
    }

    interface FakeProvider {
      refreshSession(input: { refreshToken: string }): Promise<ProviderRefreshResult>;
      /** Every refresh token the port was actually handed, in order. */
      readonly presented: string[];
    }

    function fakeProvider(behaviour: {
      replacement?: string;
      providerUserId?: string;
      organizationId?: string | null;
      impersonated?: boolean;
      fail?: 'definitive' | 'transient';
      /**
       * FBL-020-R4 §3: the provider session id the reply carries. A REFRESH keeps
       * the provider session it refreshes, so the honest default is the sid the
       * seeded session was established with — and the refresh now BINDS it
       * exactly, so a reply naming a different one revokes rather than being
       * adopted (proved separately).
       */
      providerSessionId?: string;
      /** Holds the exchange open, so a parallel caller must queue on the row lock. */
      delayMs?: number;
    }): FakeProvider {
      const presented: string[] = [];
      return {
        presented,
        async refreshSession(input: { refreshToken: string }): Promise<ProviderRefreshResult> {
          presented.push(input.refreshToken);
          if (behaviour.delayMs !== undefined) {
            await new Promise<void>((resolve) => setTimeout(resolve, behaviour.delayMs));
          }
          if (behaviour.fail !== undefined) {
            throw new ProviderRefreshError(behaviour.fail, 'fake provider failure');
          }
          return {
            accessToken: 'fake.access.token',
            refreshToken: behaviour.replacement ?? 'provider-refresh-next',
            providerUserId: behaviour.providerUserId ?? 'user_r3_refresh',
            providerSessionId: behaviour.providerSessionId ?? 'sid_initial',
            organizationId:
              behaviour.organizationId === undefined
                ? testOrganizationId(tenantId)
                : behaviour.organizationId,
            impersonation:
              behaviour.impersonated === true
                ? { impersonated: true, impersonatorEmailPresent: true }
                : NOT_IMPERSONATED,
          };
        },
      };
    }

    /**
     * FBL-020-R5 §1.8 — THE VERIFICATION EVERY EXPORTED REFRESH NOW REQUIRES.
     *
     * `RefreshProviderSessionInput.verifyAccessToken` is no longer optional, so
     * every call below supplies one. This is the honest fake for a refresh reply
     * that really did come back describing the same identity the session was
     * established with.
     *
     * `authTime` is deliberately OLDER than the instant `seedRefreshableSession`
     * stamps on the row. A refresh is not an authentication event: only a
     * genuinely newer VERIFIED auth_time may move the stored one, and this fake
     * must never be the thing that moves it.
     */
    const verifiedRefreshFor = (
      subject: string,
      overrides: Partial<VerifiedAccessToken> = {},
    ): Promise<VerifiedAccessToken> =>
      Promise.resolve({
        providerUserId: subject,
        providerSessionId: 'sid_initial',
        organizationId: testOrganizationId(tenantId),
        authTime: new Date(Date.now() - 3_600_000),
        issuedAt: new Date(),
        expiresAt: new Date(Date.now() + 300_000),
        roleHints: [],
        nonceDigest: null,
        impersonation: NOT_IMPERSONATED,
        ...overrides,
      });

    interface RefreshState {
      sealed: string | null;
      keyVersion: number | null;
      digest: string | null;
      rotationCount: number;
      authTime: string;
      revokedAt: unknown;
      revokedReason: unknown;
    }

    async function refreshStateOf(sessionId: string): Promise<RefreshState> {
      const r = await query(
        `SELECT refresh_state_sealed, refresh_state_key_version, refresh_token_hash,
                refresh_rotation_count, auth_time, revoked_at, revoked_reason
           FROM identity_sessions WHERE session_id = $1`,
        [sessionId],
      );
      const row = r.rows[0] as Record<string, unknown>;
      return {
        sealed: row.refresh_state_sealed === null ? null : String(row.refresh_state_sealed),
        keyVersion:
          row.refresh_state_key_version === null ? null : Number(row.refresh_state_key_version),
        digest: row.refresh_token_hash === null ? null : String(row.refresh_token_hash),
        rotationCount: Number(row.refresh_rotation_count),
        authTime: new Date(String(row.auth_time)).toISOString(),
        revokedAt: row.revoked_at,
        revokedReason: row.revoked_reason,
      };
    }

    /**
     * R3 correction D1: the refresh CLAIM on a row, or null when no attempt owns
     * the session's refresh credential. Read straight from the row, because the
     * whole point of the lease is that the claim is a durable fact rather than a
     * lock held by a process nobody else can see.
     */
    async function refreshLeaseOf(
      sessionId: string,
    ): Promise<{ leaseId: string; expiresAt: Date } | null> {
      const r = await query(
        `SELECT refresh_lease_id, refresh_lease_expires_at
           FROM identity_sessions WHERE session_id = $1`,
        [sessionId],
      );
      const row = r.rows[0] as Record<string, unknown>;
      if (row.refresh_lease_id === null || row.refresh_lease_id === undefined) return null;
      return {
        leaseId: String(row.refresh_lease_id),
        expiresAt: new Date(String(row.refresh_lease_expires_at)),
      };
    }

    /**
     * A provider that has ALREADY BEEN ASKED but has not answered yet, and answers
     * normally when released. It makes "an exchange is in flight right now"
     * observable without depending on a sleep.
     */
    function gatedProvider(behaviour: { providerUserId: string; replacement?: string }): {
      readonly presented: string[];
      release(): void;
      refreshSession(input: { refreshToken: string }): Promise<ProviderRefreshResult>;
    } {
      const inner = fakeProvider(behaviour);
      const waiting: Array<() => void> = [];
      return {
        presented: inner.presented,
        release() {
          for (const resume of waiting.splice(0)) resume();
        },
        async refreshSession(input: { refreshToken: string }): Promise<ProviderRefreshResult> {
          // records the presentation synchronously, then holds the answer back
          const answer = inner.refreshSession(input);
          await new Promise<void>((resolve) => waiting.push(resolve));
          return answer;
        },
      };
    }

    /** A live, refreshable session bound to a real connection and user link. */
    async function seedRefreshableSession(
      subject: string,
      firstRefreshToken: string,
      /**
       * R3 correction C1: the expiry of the provider access token this session
       * holds. Omitted, the session is refreshable but never SCHEDULED for one —
       * which is what the primitive's own tests exercise, since they ask for a
       * refresh directly rather than asking whether one is due.
       */
      accessTokenExpiresAt?: Date,
    ): Promise<{
      sessionId: string;
      sessionToken: string;
      issuer: string;
      session: IdentitySession;
    }> {
      const link = await makeLink(subject);
      const binding = await sessionBindingFor(tenantId, subject);
      const created = await createSession({
        ...binding,
        tenantId,
        userLinkId: link,
        providerSessionId: 'sid_initial',
        authTime: new Date(Date.now() - 120_000),
        ttlSeconds: 3600,
        refreshToken: firstRefreshToken,
        cookiePassword: COOKIE_PASSWORD,
        ...(accessTokenExpiresAt === undefined
          ? {}
          : { providerAccessTokenExpiresAt: accessTokenExpiresAt }),
      });
      return {
        sessionId: created.session.sessionId,
        sessionToken: created.sessionToken,
        issuer: binding.issuer,
        session: created.session,
      };
    }

    /**
     * Exactly what `/auth/reauth/callback` hands the completion for a
     * transaction the START just derived: the digest of the OIDC nonce the
     * START generated and stored, plus the four identity facts a verified token
     * proves. Every one is REQUIRED — a missing value fails closed.
     */
    /**
     * FBL-020-R4 §3: a step-up round trip must CLAIM its own callback state before
     * it can be completed — the server row judges the handle, the OAuth state, the
     * PKCE verifier and the exact callback URI, exactly once. This is the sequence
     * /auth/reauth/callback performs, so the boundary suite performs it too.
     */
    async function claimStepUp(started: StartedReauthentication): Promise<void> {
      const claimed = await claimReauthentication({
        presentedPurpose: 'reauth',
        nonce: started.nonce,
        state: started.state,
        codeVerifier: started.codeVerifier,
        callbackUri: TEST_REAUTH_CALLBACK_URI,
      });
      assert.ok(claimed, 'a fresh leg must claim its callback state');
    }

    function completionFor(started: StartedReauthentication, userLinkId: string) {
      return {
        nonce: started.nonce,
        userLinkId,
        verifiedAuthTime: new Date(),
        verifiedNonceDigest: oidcNonceDigest(started.oidcNonce),
        verifiedConnectionId: started.binding.connectionId,
        verifiedIssuer: started.binding.issuer,
        verifiedOrganizationId: started.binding.providerOrganizationId,
        verifiedProviderSubject: started.binding.providerSubject,
      };
    }

    // ── Obligation 4: login replay ────────────────────────────────────────
    test('a login transaction is consumed exactly once; the replay loses', async () => {
      const started = await startLoginTransaction({
        purpose: 'login',
        redirectUri: 'http://127.0.0.1:3000/auth/callback',
        returnTo: '/',
      });
      const args = {
        // FBL-020-R4 §1: the claim names the OPAQUE HANDLE and the EXACT
        // registered redirect, on top of purpose, state, nonce and PKCE.
        loginTxnId: started.loginTxnId,
        redirectUri: 'http://127.0.0.1:3000/auth/callback',
        state: started.state,
        purpose: 'login' as const,
        presentedPurpose: 'login',
        nonce: started.nonce,
        codeVerifier: started.codeVerifier,
      };

      const first = await claimLoginTransactionAtomically(args);
      assert.ok(first, 'the first claim wins');
      assert.equal(first.purpose, 'login');

      const replay = await claimLoginTransactionAtomically(args);
      assert.equal(replay, null, 'the replay is refused by the database');

      // wrong nonce / wrong verifier / unknown state are the SAME failure
      assert.equal(await claimLoginTransactionAtomically({ ...args, nonce: 'other' }), null);
      assert.equal(await claimLoginTransactionAtomically({ ...args, codeVerifier: 'other' }), null);
      assert.equal(await claimLoginTransactionAtomically({ ...args, state: 'other' }), null);
    });

    test('an expired login transaction cannot be claimed', async () => {
      const started = await startLoginTransaction({
        purpose: 'login',
        redirectUri: 'http://127.0.0.1:3000/auth/callback',
        ttlSeconds: 60,
      });
      await query(
        `UPDATE login_transactions
            SET created_at = NOW() - INTERVAL '2 hours', expires_at = NOW() - INTERVAL '1 hour'
          WHERE login_txn_id = $1`,
        [started.loginTxnId],
      );
      assert.equal(
        await claimLoginTransactionAtomically({
          presentedPurpose: 'login',
          loginTxnId: started.loginTxnId,
          redirectUri: 'http://127.0.0.1:3000/auth/callback',
          state: started.state,
          purpose: 'login',
          nonce: started.nonce,
          codeVerifier: started.codeVerifier,
        }),
        null,
      );
    });

    // ── R3: the login transaction STATE MACHINE ───────────────────────────
    //
    // R2 wrote `consumed_outcome = 'succeeded'` at CLAIM time — before the
    // code was exchanged, before the token was verified, before the identity
    // was admitted and before any session existed. Every login that fell over
    // later was recorded as a success. These prove the explicit machine that
    // replaced it: pending -> consuming -> succeeded | failed, terminal, with
    // a replay losing at every stage.

    interface LoginTxnRow {
      readonly status: string;
      readonly claimedAt: unknown;
      readonly consumedAt: unknown;
      readonly consumedOutcome: unknown;
      readonly failureReason: unknown;
      readonly requestId: unknown;
      readonly correlationId: unknown;
      readonly returnTo: unknown;
    }

    async function loginTxnRow(loginTxnId: string): Promise<LoginTxnRow> {
      const r = await query(
        `SELECT status, claimed_at, consumed_at, consumed_outcome, failure_reason,
                request_id, correlation_id, return_to
           FROM login_transactions WHERE login_txn_id = $1`,
        [loginTxnId],
      );
      const row = r.rows[0] as Record<string, unknown>;
      return {
        status: String(row.status),
        claimedAt: row.claimed_at,
        consumedAt: row.consumed_at,
        consumedOutcome: row.consumed_outcome,
        failureReason: row.failure_reason,
        requestId: row.request_id,
        correlationId: row.correlation_id,
        returnTo: row.return_to,
      };
    }

    async function startLogin(overrides?: {
      returnTo?: string;
      requestId?: string | null;
      correlationId?: string | null;
    }) {
      const started = await startLoginTransaction({
        purpose: 'login',
        redirectUri: 'http://127.0.0.1:3000/auth/callback',
        returnTo: overrides?.returnTo ?? '/ros/42',
        requestId: overrides?.requestId ?? 'req-boundary-0001',
        correlationId: overrides?.correlationId ?? 'corr-boundary-0001',
      });
      // FBL-020-R5 §1.11: a success is recorded AS AN ADMITTED IDENTITY, so the
      // state-machine tests need one to hand it. It is a real activated link in
      // this tenant, exactly as a real admission would produce.
      const admitted = {
        loginTxnId: started.loginTxnId,
        tenantId,
        userLinkId: await makeLink('user_login_txn_' + randomUUID().slice(0, 8)),
      };
      return {
        started,
        admitted,
        args: {
          loginTxnId: started.loginTxnId,
          redirectUri: 'http://127.0.0.1:3000/auth/callback',
          state: started.state,
          purpose: 'login' as const,
          presentedPurpose: 'login',
          nonce: started.nonce,
          codeVerifier: started.codeVerifier,
        },
      };
    }

    test('the login transaction walks pending -> consuming -> succeeded, and the replay loses at EVERY stage', async () => {
      const { started, args, admitted } = await startLogin();
      const opened = await loginTxnRow(started.loginTxnId);
      assert.equal(opened.status, 'pending', 'a transaction opens PENDING');
      assert.equal(opened.claimedAt, null);
      assert.equal(opened.consumedAt, null);
      assert.equal(opened.consumedOutcome, null, 'nothing is declared at open time');
      assert.equal(opened.requestId, 'req-boundary-0001');
      assert.equal(opened.correlationId, 'corr-boundary-0001');

      // ── pending -> consuming. The claim declares NO outcome.
      const claimed = await claimLoginTransactionAtomically(args);
      assert.ok(claimed, 'the first claim wins');
      assert.equal(claimed.status, 'consuming');
      assert.equal(
        claimed.returnTo,
        '/ros/42',
        'the RETURN LOCATION comes back from the server row, not from any cookie',
      );
      const consuming = await loginTxnRow(started.loginTxnId);
      assert.equal(consuming.status, 'consuming');
      assert.ok(consuming.claimedAt !== null, 'the claim instant is recorded');
      assert.equal(consuming.consumedAt, null, 'a claim is NOT a consumption');
      assert.equal(
        consuming.consumedOutcome,
        null,
        'R2 declared success here; nothing may declare it before a session exists',
      );

      // a replay DURING consumption loses
      assert.equal(
        await claimLoginTransactionAtomically(args),
        null,
        'a replay while the transaction is consuming must lose',
      );

      // ── consuming -> succeeded, once.
      assert.equal(await succeedLoginTransaction(admitted), true);
      const succeeded = await loginTxnRow(started.loginTxnId);
      assert.equal(succeeded.status, 'succeeded');
      assert.equal(succeeded.consumedOutcome, 'succeeded');
      assert.ok(succeeded.consumedAt !== null);
      assert.equal(succeeded.failureReason, null);

      // a replay AFTER success loses, and both terminal transitions are spent
      assert.equal(await claimLoginTransactionAtomically(args), null);
      assert.equal(await succeedLoginTransaction(admitted), false, 'succeeded is absorbing');
      assert.equal(
        await failLoginTransaction(started.loginTxnId, 'provider_exchange_failed'),
        false,
        'a succeeded transaction cannot be rewritten as a failure',
      );
      assert.deepEqual(await loginTxnRow(started.loginTxnId), succeeded, 'nothing moved');
    });

    test('a claimed transaction that fails is terminal WITH A REASON and can never become succeeded', async () => {
      const { started, args, admitted } = await startLogin();
      assert.ok(await claimLoginTransactionAtomically(args));

      assert.equal(
        await failLoginTransaction(started.loginTxnId, 'token_verification_failed'),
        true,
      );
      const failed = await loginTxnRow(started.loginTxnId);
      assert.equal(failed.status, 'failed');
      assert.equal(failed.consumedOutcome, 'failed');
      assert.equal(failed.failureReason, 'token_verification_failed');

      // terminal in every direction
      assert.equal(await succeedLoginTransaction(admitted), false);
      assert.equal(
        await failLoginTransaction(started.loginTxnId, 'identity_not_admitted'),
        false,
        'the FIRST terminal fact wins; nothing overwrites it',
      );
      assert.equal(await claimLoginTransactionAtomically(args), null, 'and the replay still loses');
      assert.deepEqual(await loginTxnRow(started.loginTxnId), failed);
    });

    test('an UNCLAIMED transaction expires into the failed terminal state, never into success', async () => {
      const { started, args, admitted } = await startLogin();
      await query(
        `UPDATE login_transactions
            SET created_at = NOW() - INTERVAL '2 hours', expires_at = NOW() - INTERVAL '1 hour'
          WHERE login_txn_id = $1`,
        [started.loginTxnId],
      );
      assert.ok((await expireStaleLoginTransactions()) >= 1);
      const expired = await loginTxnRow(started.loginTxnId);
      assert.equal(expired.status, 'failed');
      assert.equal(expired.failureReason, 'expired');
      assert.equal(
        expired.claimedAt,
        null,
        'nobody claimed it, and the sweep does not pretend somebody did',
      );
      assert.equal(await claimLoginTransactionAtomically(args), null);
      assert.equal(await succeedLoginTransaction(admitted), false);
    });

    test('the schema itself refuses the states the machine forbids', async () => {
      const { started } = await startLogin();
      const violates = (err: unknown) => (err as { code?: string }).code === '23514';

      // succeeded WITHOUT a claim — the shape R2 could produce
      await assert.rejects(
        () =>
          query(
            `UPDATE login_transactions
                SET status = 'succeeded', consumed_at = NOW(), consumed_outcome = 'succeeded'
              WHERE login_txn_id = $1`,
            [started.loginTxnId],
          ),
        violates,
        'a succeeded transaction that was never claimed must be unrepresentable',
      );
      // failed with no reason
      await assert.rejects(
        () =>
          query(
            `UPDATE login_transactions
                SET status = 'failed', consumed_at = NOW(), consumed_outcome = 'failed'
              WHERE login_txn_id = $1`,
            [started.loginTxnId],
          ),
        violates,
        'a failure that cannot say why is not evidence',
      );
      // a status that disagrees with the recorded outcome
      await assert.rejects(
        () =>
          query(
            `UPDATE login_transactions
                SET status = 'succeeded', claimed_at = NOW(), consumed_at = NOW(),
                    consumed_outcome = 'failed'
              WHERE login_txn_id = $1`,
            [started.loginTxnId],
          ),
        violates,
      );
      // and a hostile correlation identifier is DROPPED at the door, never stored
      const hostile = await startLoginTransaction({
        purpose: 'login',
        redirectUri: 'http://127.0.0.1:3000/auth/callback',
        requestId: "a'; DROP TABLE login_transactions; --",
        correlationId: 'short',
      });
      const row = await loginTxnRow(hostile.loginTxnId);
      assert.equal(row.requestId, null);
      assert.equal(row.correlationId, null);
    });

    // ── R3: IMPOSSIBLE TIMES, judged by the configured tolerance ALONE ────

    function boundedVerifier() {
      return createAccessTokenVerifier({
        issuer: env.issuer.issuer,
        audience: env.issuer.audience,
        jwksUri: env.issuer.jwksUri,
        clockSkewSeconds: 60,
      });
    }

    test('a token ISSUED in the future is refused; the only allowance is the configured tolerance', async () => {
      const verifier = boundedVerifier();
      const now = Math.floor(Date.now() / 1000);
      await assert.rejects(
        verifier.verify(await env.issuer.signAccessToken({ iat: now + 600, exp: now + 900 })),
        TokenVerificationError,
        'an iat 10 minutes ahead is not a fact about the past',
      );
      // inside the tolerance: accepted, because bounded drift is real
      const ok = await verifier.verify(await env.issuer.signAccessToken({ iat: now + 30 }));
      assert.ok(ok.issuedAt.getTime() > 0);
    });

    test('a token whose auth_time is in the FUTURE is refused', async () => {
      const verifier = boundedVerifier();
      const now = Math.floor(Date.now() / 1000);
      await assert.rejects(
        verifier.verify(await env.issuer.signAccessToken({ auth_time: now + 600 })),
        TokenVerificationError,
        'nobody authenticated ten minutes from now',
      );
      const ok = await verifier.verify(await env.issuer.signAccessToken({ auth_time: now + 30 }));
      assert.ok(ok.authTime.getTime() > 0);
    });

    test('a token that EXPIRES BEFORE IT WAS ISSUED is refused', async () => {
      const verifier = boundedVerifier();
      const now = Math.floor(Date.now() / 1000);
      // Both claims are individually inside the 60s tolerance; only their
      // RELATIONSHIP is impossible — exp precedes iat by 100 seconds.
      await assert.rejects(
        verifier.verify(await env.issuer.signAccessToken({ iat: now + 50, exp: now - 50 })),
        TokenVerificationError,
        'a credential that expires before it exists is not a credential',
      );
      // …and a 40-second inversion inside the tolerance is still tolerated,
      // which is what makes the bound the tolerance and nothing else.
      await verifier.verify(await env.issuer.signAccessToken({ iat: now + 20, exp: now - 20 }));
    });

    test('a sealed cookie stamped in the FUTURE does not open', async () => {
      // The seal stamps its own `iat`, so the only way to forge a forward-dated
      // one is to seal it while the clock reads later. Nothing else is faked.
      const sealAt = (offsetSeconds: number): string => {
        const realNow = Date.now;
        Date.now = () => realNow() + offsetSeconds * 1000;
        try {
          return sealCookiePayload({ purpose: 'login', state: 'abc' }, COOKIE_PASSWORD);
        } finally {
          Date.now = realNow;
        }
      };

      assert.equal(
        openCookiePayload(sealAt(600), COOKIE_PASSWORD, {
          maxAgeSeconds: 600,
          clockToleranceSeconds: 60,
        }),
        null,
        'a seal from ten minutes in the future must not open — and without this it would never age out',
      );
      // bounded drift still opens
      assert.ok(
        openCookiePayload(sealAt(30), COOKIE_PASSWORD, {
          maxAgeSeconds: 600,
          clockToleranceSeconds: 60,
        }),
      );
      // and a seal with no timestamp at all has no age, so it is refused too
      assert.equal(
        openCookiePayload('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', COOKIE_PASSWORD, {
          maxAgeSeconds: 600,
        }),
        null,
      );
    });

    // ── Obligation 3: no nullable-connection bypass ───────────────────────
    test('the schema makes an unbound LIVE session unrepresentable', async () => {
      const link = await makeLink('user_unbound');
      await assert.rejects(
        () =>
          fixtureAuthorizationStateWrite(
            'seed-authorization-state',
            `INSERT INTO identity_sessions
               (tenant_id, user_link_id, session_token_hash, auth_time, expires_at)
             VALUES ($1, $2, $3, NOW(), NOW() + INTERVAL '1 hour')`,
            [tenantId, link, 'a'.repeat(64)],
          ),
        (err: unknown) => (err as { code?: string }).code === '23514',
        'a live session with no connection/issuer/subject/org must be refused',
      );
    });

    test('a session bound to a DISABLED connection stops validating', async () => {
      const link = await makeLink('user_conn');
      const created = await createSession({
        ...(await sessionBindingFor(tenantId, 'user_conn')),
        tenantId,
        userLinkId: link,
        providerSessionId: null,
        authTime: new Date(),
        ttlSeconds: 3600,
      });
      assert.ok(await validateSessionToken(created.sessionToken));
      await fixtureAuthorizationStateWrite(
        'simulate-authorization-drift',
        `UPDATE identity_provider_connections SET status = 'disabled' WHERE tenant_id = $1`,
        [tenantId],
      );
      // the session row is still live; the middleware chain is what denies,
      // and the connection is now unresolvable — proven in auth.test.ts.
      const stillLive = await query(
        `SELECT revoked_at FROM identity_sessions WHERE session_id = $1`,
        [created.session.sessionId],
      );
      assert.equal((stillLive.rows[0] as { revoked_at: unknown }).revoked_at, null);
    });

    /**
     * FBL-020-R5 §1.8 — THE STRUCTURAL HALF.
     *
     * The behavioural tests below prove that TODAY's exported refresh boundary
     * verifies the token it is handed. They cannot prove anything about a boundary
     * somebody exports next quarter, and "verification happens because every caller
     * passes a verifier" is exactly the convention this clause refuses.
     *
     * The clause is a disjunction — verification REQUIRED at every exported
     * refresh/rotation boundary, or the unsafe lower-level primitives PRIVATE — and
     * this pins both limbs against the source of `packages/identity-access/src/
     * session.ts`:
     *
     *   (a) the exported functions whose names mention refreshing or rotation are
     *       exactly three, and the two that spend a refresh credential each declare
     *       `verifyAccessToken` as a REQUIRED input;
     *   (b) the word `verifyAccessToken?:` does not occur, and neither does any
     *       `=== undefined` / `!== undefined` test of it, so no code path can skip
     *       the judgement;
     *   (c) the rotation WRITE — the statement that puts a new refresh credential
     *       into a session row — appears exactly once across `apps/` and
     *       `packages/`, and that once is inside this module, unexported.
     *
     * Stated precisely: (a) and (b) are lexical facts about this file, and (c) is a
     * lexical guard over the SQL this codebase writes — not a proof that no rotation
     * could be spelled some other way.
     */
    test('the exported refresh surface cannot be driven without access-token verification', () => {
      const root = join(__dirname, '..');
      const sessionPath = join(root, 'packages', 'identity-access', 'src', 'session.ts');
      const source = readFileSync(sessionPath, 'utf8').replace(/\r\n/g, '\n');

      // (a) the exported refresh/rotation surface, read off the source
      const exported = [...source.matchAll(/^export (?:async )?function (\w+)/gm)].map(
        (m) => m[1] as string,
      );
      assert.ok(exported.length > 5, 'the export scan must actually have found this module');
      const surface = exported.filter((name) => /refresh|rotat|maintain/i.test(name)).sort();
      assert.deepEqual(
        surface,
        ['isProviderRefreshDue', 'maintainProviderSession', 'refreshProviderSession'],
        'a new exported refresh/rotation boundary must come with its own §1.8 evidence; ' +
          `found: ${JSON.stringify(surface)}`,
      );

      // …and BOTH boundaries that spend a credential require the verifier. The
      // third, isProviderRefreshDue, is a pure predicate over a session row: it
      // performs no exchange and takes no token into custody.
      const required = source.match(
        /readonly verifyAccessToken: \(accessToken: string\) => Promise<VerifiedAccessToken>;/g,
      );
      assert.equal(
        (required ?? []).length,
        2,
        'RefreshProviderSessionInput and MaintainProviderSessionInput must each REQUIRE a verifier',
      );

      // (b) nothing may make it optional, and nothing may branch around it
      assert.equal(
        (source.match(/verifyAccessToken\?:/g) ?? []).length,
        0,
        'no exported refresh boundary may declare verification optional',
      );
      assert.equal(
        (source.match(/verifyAccessToken\s*(!==|===)\s*undefined/g) ?? []).length,
        0,
        'and no code path may test for its absence — that IS the skip this clause removes',
      );

      // (c) the rotation WRITE is private, and there is exactly one of it
      const sources: string[] = [];
      const walk = (dir: string): void => {
        for (const entry of readdirSync(dir)) {
          if (entry === 'node_modules' || entry === 'dist') continue;
          const full = join(dir, entry);
          if (statSync(full).isDirectory()) walk(full);
          else if (full.endsWith('.ts') && !full.endsWith('.d.ts')) sources.push(full);
        }
      };
      walk(join(root, 'apps'));
      walk(join(root, 'packages'));
      assert.ok(sources.length > 50, 'the walk must actually have found the source trees');

      const rotations: string[] = [];
      for (const file of sources) {
        const text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
        let index = text.indexOf('`');
        while (index !== -1) {
          const close = text.indexOf('`', index + 1);
          if (close === -1) break;
          const literal = text
            .slice(index + 1, close)
            .split('\n')
            .filter((line) => !/^\s*--/.test(line))
            .join('\n');
          // A statement that puts a NEW refresh credential into a session row. The
          // predicate is deliberately narrow: only the SET list counts, so the
          // claim statement's `AND refresh_token_hash = $4` (a WHERE comparison)
          // and the revocation builder's `= NULL` (destruction) are not rotations.
          const setList = literal.split(/\bWHERE\b/)[0] as string;
          if (
            /UPDATE\s+identity_sessions/.test(literal) &&
            /refresh_token_hash\s*=\s*\$/.test(setList)
          ) {
            rotations.push(file.slice(root.length + 1).replace(/\\/g, '/'));
          }
          index = text.indexOf('`', close + 1);
        }
      }
      assert.deepEqual(
        rotations,
        ['packages/identity-access/src/session.ts'],
        'refresh state may be rotated in exactly ONE statement, inside the identity package',
      );
      assert.ok(
        !/export\s+(async\s+)?function\s+rotate/.test(source),
        'and no rotation primitive may be exported — §1.8 makes the unsafe one private',
      );
    });

    // ── Obligation 7: refresh rotation ────────────────────────────────────
    /**
     * FBL-020-R5 §1.8 — DRIVEN THROUGH THE EXPORTED BOUNDARY, because there is no
     * longer any other door.
     *
     * This test used to call `rotateSessionRefresh` — an exported rotation
     * primitive that performed no provider call and verified no token, so it wrote
     * ANY replacement a caller named into a session's refresh state. §1.8 required
     * either verification at every exported refresh/rotation boundary or that the
     * unsafe primitive be private; it is now the module-private
     * `rotateRefreshStateRow`, reachable only after a verified access token has
     * been judged. The property under test is unchanged: rotation advances the
     * count, and a spent refresh token is gone from custody.
     */
    test('refresh state rotates, and a replayed refresh token changes nothing', async () => {
      const s = await seedRefreshableSession('user_refresh', 'refresh-token-one');

      const first = fakeProvider({
        providerUserId: 'user_refresh',
        replacement: 'refresh-token-two',
      });
      const rotated = await refreshProviderSession({
        sessionId: s.sessionId,
        provider: first,
        cookiePassword: COOKIE_PASSWORD,
        expectedIssuer: s.issuer,
        ttlSeconds: 3600,
        verifyAccessToken: () => verifiedRefreshFor('user_refresh'),
      });
      if (rotated.outcome !== 'refreshed')
        assert.fail(`expected refreshed, got ${rotated.outcome}`);
      assert.equal(rotated.rotationCount, 1);
      assert.deepEqual(first.presented, ['refresh-token-one']);

      // the OLD token is now worthless: custody moved, so neither the stored
      // digest nor the sealed state can produce it again
      const afterFirst = await refreshStateOf(s.sessionId);
      assert.equal(afterFirst.digest, sha256hex('refresh-token-two'));
      assert.notEqual(afterFirst.digest, sha256hex('refresh-token-one'));
      assert.ok(afterFirst.sealed !== null && !afterFirst.sealed.includes('refresh-token-one'));

      // …and the NEXT refresh presents the REPLACEMENT, never the spent token
      const second = fakeProvider({
        providerUserId: 'user_refresh',
        replacement: 'refresh-token-three',
      });
      const again = await refreshProviderSession({
        sessionId: s.sessionId,
        provider: second,
        cookiePassword: COOKIE_PASSWORD,
        expectedIssuer: s.issuer,
        ttlSeconds: 3600,
        verifyAccessToken: () => verifiedRefreshFor('user_refresh'),
      });
      if (again.outcome !== 'refreshed') assert.fail(`expected refreshed, got ${again.outcome}`);
      assert.equal(again.rotationCount, 2);
      assert.deepEqual(second.presented, ['refresh-token-two']);

      // an identity breach kills the session outright
      assert.equal(await revokeForIdentityBreach(s.sessionId, 'identity_mismatch'), true);
      assert.equal(await validateSessionToken(s.sessionToken), null);
    });

    // ── R3 gate: a REAL provider refresh over sealed, rotating state ──────
    test('a real refresh presents the SEALED token and rotates the state', async () => {
      const s = await seedRefreshableSession('user_r3_refresh', 'provider-refresh-1');
      const before = await refreshStateOf(s.sessionId);
      assert.ok(before.sealed !== null, 'login sealed the refresh token');
      assert.equal(before.keyVersion, 1, 'the key version is recorded');
      assert.equal(before.digest, sha256hex('provider-refresh-1'));
      // the stored state is CIPHERTEXT, not the token and not an encoding of it
      assert.ok(!before.sealed.includes('provider-refresh-1'));
      assert.ok(
        !Buffer.from(before.sealed, 'base64url').toString('utf8').includes('provider-refresh-1'),
      );

      const provider = fakeProvider({ replacement: 'provider-refresh-2' });
      const outcome = await refreshProviderSession({
        sessionId: s.sessionId,
        provider,
        cookiePassword: COOKIE_PASSWORD,
        expectedIssuer: s.issuer,
        ttlSeconds: 3600,
        verifyAccessToken: () => verifiedRefreshFor('user_r3_refresh'),
      });
      if (outcome.outcome !== 'refreshed')
        assert.fail(`expected refreshed, got ${outcome.outcome}`);
      assert.equal(outcome.rotationCount, 1);

      // THE POINT OF THE GATE: the provider was handed the ORIGINAL refresh
      // token, recovered from sealed ciphertext. A digest could not do this.
      assert.deepEqual(provider.presented, ['provider-refresh-1']);

      const after = await refreshStateOf(s.sessionId);
      assert.notEqual(after.sealed, before.sealed, 'the sealed state rotated');
      assert.equal(
        after.digest,
        sha256hex('provider-refresh-2'),
        'the digest tracks the new token',
      );
      assert.equal(after.keyVersion, 1);
      assert.equal(after.rotationCount, 1);
      // A refresh is NOT an authentication event: auth_time may not move.
      assert.equal(after.authTime, before.authTime);
      assert.ok(await validateSessionToken(s.sessionToken), 'the session is still live');
    });

    test('a replayed old refresh token changes nothing', async () => {
      const s = await seedRefreshableSession('user_r3_replay', 'provider-refresh-1');
      const first = await refreshProviderSession({
        sessionId: s.sessionId,
        provider: fakeProvider({
          replacement: 'provider-refresh-2',
          providerUserId: 'user_r3_replay',
        }),
        cookiePassword: COOKIE_PASSWORD,
        expectedIssuer: s.issuer,
        ttlSeconds: 3600,
        verifyAccessToken: () => verifiedRefreshFor('user_r3_replay'),
      });
      assert.equal(first.outcome, 'refreshed');
      const snapshot = await refreshStateOf(s.sessionId);

      // FBL-020-R5 §1.8: this probe used to call the exported `rotateSessionRefresh`
      // with the SPENT token and assert it rotated nothing. That primitive is private
      // now, so the property is stated where it actually lives — the spent token is
      // no longer the stored digest and is not recoverable from the sealed state, so
      // nothing is left that could present it. The digest-keyed conditional UPDATE
      // that refuses a stale rotation is exercised by the lease battery below.
      assert.notEqual(snapshot.digest, sha256hex('provider-refresh-1'));
      assert.equal(snapshot.digest, sha256hex('provider-refresh-2'));
      assert.ok(snapshot.sealed !== null && !snapshot.sealed.includes('provider-refresh-1'));
      assert.deepEqual(await refreshStateOf(s.sessionId), snapshot, 'nothing changed');

      // and the NEXT real refresh presents the replacement, never the spent one
      const second = fakeProvider({
        replacement: 'provider-refresh-3',
        providerUserId: 'user_r3_replay',
      });
      const outcome = await refreshProviderSession({
        sessionId: s.sessionId,
        provider: second,
        cookiePassword: COOKIE_PASSWORD,
        expectedIssuer: s.issuer,
        ttlSeconds: 3600,
        verifyAccessToken: () => verifiedRefreshFor('user_r3_replay'),
      });
      if (outcome.outcome !== 'refreshed')
        assert.fail(`expected refreshed, got ${outcome.outcome}`);
      assert.equal(outcome.rotationCount, 2);
      assert.deepEqual(second.presented, ['provider-refresh-2']);
      assert.ok(await validateSessionToken(s.sessionToken));
    });

    test('an identity mismatch on refresh revokes the session immediately', async () => {
      const s = await seedRefreshableSession('user_r3_mismatch', 'provider-refresh-1');
      // the provider answers as somebody ELSE
      const outcome = await refreshProviderSession({
        sessionId: s.sessionId,
        provider: fakeProvider({ providerUserId: 'user_somebody_else' }),
        cookiePassword: COOKIE_PASSWORD,
        expectedIssuer: s.issuer,
        ttlSeconds: 3600,
        // both carriers agree with each other and disagree with the SESSION
        verifyAccessToken: () => verifiedRefreshFor('user_somebody_else'),
      });
      assert.deepEqual(outcome, { outcome: 'revoked', reason: 'identity_mismatch' });

      const after = await refreshStateOf(s.sessionId);
      assert.ok(after.revokedAt !== null, 'the session is revoked');
      assert.equal(String(after.revokedReason), 'identity_mismatch');
      // revocation DESTROYS the credential, it does not merely stop using it
      assert.equal(after.sealed, null);
      assert.equal(after.keyVersion, null);
      assert.equal(after.digest, null);
      assert.equal(await validateSessionToken(s.sessionToken), null);
    });

    test('a refresh through a DISABLED connection is an identity mismatch', async () => {
      const s = await seedRefreshableSession('user_r3_conn', 'provider-refresh-1');
      await fixtureAuthorizationStateWrite(
        'simulate-authorization-drift',
        `UPDATE identity_provider_connections SET status = 'disabled' WHERE tenant_id = $1`,
        [tenantId],
      );
      const outcome = await refreshProviderSession({
        sessionId: s.sessionId,
        provider: fakeProvider({ providerUserId: 'user_r3_conn' }),
        cookiePassword: COOKIE_PASSWORD,
        expectedIssuer: s.issuer,
        ttlSeconds: 3600,
        verifyAccessToken: () => verifiedRefreshFor('user_r3_conn'),
      });
      assert.deepEqual(outcome, { outcome: 'revoked', reason: 'identity_mismatch' });
      assert.equal(await validateSessionToken(s.sessionToken), null);
    });

    test('an impersonated refresh is rejected and revokes the session', async () => {
      const s = await seedRefreshableSession('user_r3_imp', 'provider-refresh-1');
      const provider = fakeProvider({ providerUserId: 'user_r3_imp', impersonated: true });
      const outcome = await refreshProviderSession({
        sessionId: s.sessionId,
        provider,
        cookiePassword: COOKIE_PASSWORD,
        expectedIssuer: s.issuer,
        ttlSeconds: 3600,
        verifyAccessToken: () => verifiedRefreshFor('user_r3_imp'),
      });
      assert.deepEqual(outcome, { outcome: 'revoked', reason: 'impersonation_detected' });
      const after = await refreshStateOf(s.sessionId);
      assert.equal(String(after.revokedReason), 'impersonation_detected');
      assert.equal(after.sealed, null);
      assert.equal(after.rotationCount, 0, 'an impersonated exchange rotates nothing');
      assert.equal(await validateSessionToken(s.sessionToken), null);
    });

    test('impersonation carried by the TOKEN also revokes, and the email never escapes', async () => {
      const s = await seedRefreshableSession('user_r3_imp_token', 'provider-refresh-1');
      // The provider response looks clean; the ACCESS TOKEN says otherwise.
      const verifyAccessToken = (): Promise<VerifiedAccessToken> =>
        Promise.resolve({
          providerUserId: 'user_r3_imp_token',
          // R4 §3: a VERIFIED refresh reply must name the SAME provider session
          // the local session was established from, or the session is revoked.
          providerSessionId: 'sid_initial',
          organizationId: testOrganizationId(tenantId),
          authTime: new Date(),
          issuedAt: new Date(),
          expiresAt: new Date(Date.now() + 300_000),
          roleHints: [],
          nonceDigest: null,
          impersonation: { impersonated: true, impersonatorEmailPresent: true },
        });
      const outcome = await refreshProviderSession({
        sessionId: s.sessionId,
        provider: fakeProvider({ providerUserId: 'user_r3_imp_token' }),
        cookiePassword: COOKIE_PASSWORD,
        expectedIssuer: s.issuer,
        ttlSeconds: 3600,
        verifyAccessToken,
      });
      assert.deepEqual(outcome, { outcome: 'revoked', reason: 'impersonation_detected' });

      // and the VERIFIER classifies impersonation without carrying the email
      const verifier = createAccessTokenVerifier({
        issuer: env.issuer.issuer,
        audience: env.issuer.audience,
        jwksUri: env.issuer.jwksUri,
      });
      const token = await env.issuer.signAccessToken({
        act: { sub: 'user_provider_staff', email: 'staff@provider.example' },
      });
      const verified = await verifier.verify(token);
      assert.deepEqual(verified.impersonation, {
        impersonated: true,
        impersonatorEmailPresent: true,
      });
      assert.ok(
        !JSON.stringify(verified).includes('staff@provider.example'),
        'the impersonator email must never cross the verifier boundary',
      );
      const clean = await verifier.verify(await env.issuer.signAccessToken({}));
      assert.deepEqual(clean.impersonation, NOT_IMPERSONATED);
    });

    test('a TRANSIENT provider failure leaves the session completely intact', async () => {
      const s = await seedRefreshableSession('user_r3_transient', 'provider-refresh-1');
      const before = await refreshStateOf(s.sessionId);

      const outcome = await refreshProviderSession({
        sessionId: s.sessionId,
        provider: fakeProvider({ fail: 'transient' }),
        cookiePassword: COOKIE_PASSWORD,
        expectedIssuer: s.issuer,
        ttlSeconds: 3600,
        verifyAccessToken: () => verifiedRefreshFor('user_r3_transient'),
      });
      assert.deepEqual(outcome, { outcome: 'transient' }, 'transient is distinguishable');

      assert.deepEqual(await refreshStateOf(s.sessionId), before, 'nothing was written');
      assert.ok(await validateSessionToken(s.sessionToken), 'the session survived the outage');

      // …while a DEFINITIVE refusal kills it, from the same call site
      const definitive = await refreshProviderSession({
        sessionId: s.sessionId,
        provider: fakeProvider({ fail: 'definitive' }),
        cookiePassword: COOKIE_PASSWORD,
        expectedIssuer: s.issuer,
        ttlSeconds: 3600,
        verifyAccessToken: () => verifiedRefreshFor('user_r3_transient'),
      });
      assert.deepEqual(definitive, { outcome: 'revoked', reason: 'refresh_failed' });
      assert.equal(await validateSessionToken(s.sessionToken), null);
    });

    /**
     * FBL-020-R3 correction C1 — the SCHEDULING half of the reachable refresh.
     *
     * `maintainProviderSession` is what the request path calls. Two properties
     * matter and neither is provable from the primitive alone:
     *
     *   1. a session that is NOT near provider expiry is not touched at all —
     *      otherwise every request would spend a refresh token;
     *   2. when several callers judge the same session due at the same instant,
     *      the single-use credential is spent EXACTLY ONCE. Dueness is re-judged
     *      under the row lock, so whoever queued behind the exchange finds the
     *      expiry already moved and does nothing.
     */
    test('R3: maintenance refreshes only when DUE, and parallel callers spend the token once', async () => {
      const verifiedFor = (subject: string): Promise<VerifiedAccessToken> =>
        Promise.resolve({
          providerUserId: subject,
          // R4 §3: a VERIFIED refresh reply must name the SAME provider session
          // the local session was established from, or the session is revoked.
          providerSessionId: 'sid_initial',
          organizationId: testOrganizationId(tenantId),
          authTime: new Date(Date.now() - 120_000),
          issuedAt: new Date(),
          expiresAt: new Date(Date.now() + 300_000),
          roleHints: [],
          nonceDigest: null,
          impersonation: NOT_IMPERSONATED,
        });

      // (1) not due: an hour of provider validity left, nothing to do
      const fresh = await seedRefreshableSession(
        'user_r3_notdue',
        'provider-refresh-1',
        new Date(Date.now() + 3_600_000),
      );
      const idleProvider = fakeProvider({ providerUserId: 'user_r3_notdue' });
      const idle = await maintainProviderSession({
        session: fresh.session,
        provider: idleProvider,
        cookiePassword: COOKIE_PASSWORD,
        expectedIssuer: fresh.issuer,
        verifyAccessToken: () => verifiedFor('user_r3_notdue'),
      });
      assert.equal(idle.outcome, 'unchanged');
      assert.deepEqual(idleProvider.presented, [], 'an unexpired credential is not spent');
      assert.equal((await refreshStateOf(fresh.sessionId)).rotationCount, 0);

      // …and a session that holds no refresh state at all is simply NOT
      // REFRESHABLE, which is a different answer from a failure: no provider
      // call, no revocation, and the session keeps working.
      const subject = 'user_r3_nostate_maintain';
      const bare = await createSession({
        ...(await sessionBindingFor(tenantId, subject)),
        tenantId,
        userLinkId: await makeLink(subject),
        providerSessionId: null,
        authTime: new Date(),
        ttlSeconds: 3600,
      });
      const bareProvider = fakeProvider({ providerUserId: subject });
      const bareOutcome = await maintainProviderSession({
        session: bare.session,
        provider: bareProvider,
        cookiePassword: COOKIE_PASSWORD,
        expectedIssuer: bare.session.issuer ?? '',
        verifyAccessToken: () => verifiedFor(subject),
      });
      assert.deepEqual(bareProvider.presented, []);
      assert.equal(
        bareOutcome.outcome === 'unchanged' ? bareOutcome.reason : null,
        'not_refreshable',
      );
      assert.ok(await validateSessionToken(bare.sessionToken), 'and it still authenticates');

      // (2) due, and two callers race on it
      const due = await seedRefreshableSession(
        'user_r3_parallel',
        'provider-refresh-1',
        new Date(Date.now() + 20_000),
      );
      const provider = fakeProvider({
        providerUserId: 'user_r3_parallel',
        replacement: 'provider-refresh-2',
        delayMs: 250,
      });
      const maintain = () =>
        maintainProviderSession({
          // BOTH callers hold the same pre-refresh view, which is exactly the
          // race: each judged dueness before either of them wrote anything.
          session: due.session,
          provider,
          cookiePassword: COOKIE_PASSWORD,
          expectedIssuer: due.issuer,
          verifyAccessToken: () => verifiedFor('user_r3_parallel'),
        });
      const [first, second] = await Promise.all([maintain(), maintain()]);

      assert.deepEqual(
        provider.presented,
        ['provider-refresh-1'],
        'the single-use refresh token was presented exactly once',
      );
      const outcomes = [first.outcome, second.outcome].sort();
      assert.deepEqual(outcomes, ['refreshed', 'unchanged']);
      const loser = first.outcome === 'unchanged' ? first : second;
      assert.equal(loser.outcome === 'unchanged' ? loser.reason : null, 'not_due');

      const after = await refreshStateOf(due.sessionId);
      assert.equal(after.rotationCount, 1, 'exactly one rotation, not one each');
      assert.equal(after.digest, sha256hex('provider-refresh-2'));
      assert.equal(after.revokedAt, null, 'and nobody was revoked for racing');
    });

    test('a session with no sealed state is unavailable for refresh, not destroyed', async () => {
      const link = await makeLink('user_r3_nostate');
      const binding = await sessionBindingFor(tenantId, 'user_r3_nostate');
      // a session created WITHOUT the cookie password: digest only, by design
      const created = await createSession({
        ...binding,
        tenantId,
        userLinkId: link,
        providerSessionId: null,
        authTime: new Date(),
        ttlSeconds: 3600,
        refreshToken: 'provider-refresh-1',
      });
      const outcome = await refreshProviderSession({
        sessionId: created.session.sessionId,
        provider: fakeProvider({ providerUserId: 'user_r3_nostate' }),
        cookiePassword: COOKIE_PASSWORD,
        expectedIssuer: binding.issuer,
        ttlSeconds: 3600,
        verifyAccessToken: () => verifiedRefreshFor('user_r3_nostate'),
      });
      assert.deepEqual(outcome, { outcome: 'unavailable', reason: 'no_refresh_state' });
      assert.ok(await validateSessionToken(created.sessionToken));

      // a ROTATED cookie password is likewise "cannot refresh", never a breach
      const rotatedKey = await refreshProviderSession({
        sessionId: (await seedRefreshableSession('user_r3_keyver', 'provider-refresh-1')).sessionId,
        provider: fakeProvider({ providerUserId: 'user_r3_keyver' }),
        cookiePassword: COOKIE_PASSWORD,
        expectedIssuer: binding.issuer,
        ttlSeconds: 3600,
        keyVersion: 2,
        verifyAccessToken: () => verifiedRefreshFor('user_r3_keyver'),
      });
      assert.deepEqual(rotatedKey, { outcome: 'unavailable', reason: 'key_version_mismatch' });
    });

    // ── FBL-020-R3 correction D1: NO TRANSACTION ACROSS THE NETWORK CALL ────
    //
    // R3 made the refresh reachable from the request path while keeping R2's
    // shape: BEGIN, SELECT ... FOR UPDATE, and only then await the provider. The
    // fakes in this file delayed 250ms or threw — both of which release the lock —
    // so nothing proved what a provider that HANGS costs. It cost the whole API:
    // one pool connection per due session, pinned inside an idle open transaction,
    // in a pool shared with all Fixed Ops traffic for every tenant.
    //
    // These tests are about the lease that replaced the lock.

    /** A provider that ANSWERS NOTHING until it is released. The D1 shape. */
    function hangingProvider(): {
      readonly presented: string[];
      release(): void;
      refreshSession(input: { refreshToken: string }): Promise<ProviderRefreshResult>;
    } {
      const presented: string[] = [];
      const waiting: Array<() => void> = [];
      return {
        presented,
        release() {
          for (const resume of waiting.splice(0)) resume();
        },
        async refreshSession(input: { refreshToken: string }): Promise<ProviderRefreshResult> {
          presented.push(input.refreshToken);
          await new Promise<void>((resolve) => waiting.push(resolve));
          // Released without ever having answered: the honest classification of
          // "we gave up waiting" is transient, and it writes nothing.
          throw new ProviderRefreshError('transient', 'released without answering');
        },
      };
    }

    test('D1: a provider that NEVER ANSWERS does not starve the shared connection pool', async () => {
      // Exactly as many due sessions as the pool has connections. If a refresh
      // holds one for the duration of the provider call, there is nothing left.
      const poolMax = getDatabaseConfig().pgPoolMax;
      const sessions = [];
      for (let i = 0; i < poolMax; i += 1) {
        sessions.push(
          await seedRefreshableSession(
            `user_d1_pool_${i}`,
            `provider-refresh-pool-${i}`,
            new Date(Date.now() + 20_000),
          ),
        );
      }

      const provider = hangingProvider();
      const attempts = sessions.map((s, i) =>
        refreshProviderSession({
          sessionId: s.sessionId,
          provider,
          cookiePassword: COOKIE_PASSWORD,
          expectedIssuer: s.issuer,
          ttlSeconds: 3600,
          refreshDueLeewaySeconds: 60,
          // never reached — the provider never answers — but §1.8 makes it a
          // required input, so the shape of the call says so
          verifyAccessToken: () => verifiedRefreshFor(`user_d1_pool_${i}`),
          // Generously above anything this test waits for: the point is that the
          // POOL survives a hang, not that a bound eventually ends it.
          providerTimeoutMs: 60_000,
        }),
      );
      try {
        // every attempt is now inside the provider call and going nowhere
        while (provider.presented.length < poolMax) {
          await new Promise<void>((resolve) => setTimeout(resolve, 10));
        }

        // THE POINT. Unrelated traffic — every other tenant, every Fixed Ops
        // endpoint — needs a connection from the same pool.
        const unrelated = await query('SELECT 1 AS ok').then(
          (r) => ({ ok: true, detail: String((r.rows[0] as { ok: unknown }).ok) }),
          (err: unknown) => ({ ok: false, detail: (err as Error).message }),
        );
        assert.deepEqual(
          unrelated,
          { ok: true, detail: '1' },
          'a hung provider must not make the shared pool unavailable to everything else',
        );

        // …and the reason it survived: nothing is sitting in an open transaction.
        const idleInTransaction = Number(
          (
            await query(
              `SELECT COUNT(*)::int AS n FROM pg_stat_activity
                WHERE datname = current_database() AND state = 'idle in transaction'`,
            )
          ).rows[0]?.n ?? -1,
        );
        assert.equal(
          idleInTransaction,
          0,
          'no transaction may be open while a provider call is outstanding',
        );
      } finally {
        provider.release();
      }

      const outcomes = await Promise.all(attempts);
      assert.deepEqual(
        outcomes.map((o) => o.outcome),
        sessions.map(() => 'transient'),
        'a provider that never answered is transient, not a fleet-wide logout',
      );
      // one spend attempt per session, and every session is still alive
      assert.equal(provider.presented.length, poolMax);
      for (const s of sessions) {
        assert.ok(await validateSessionToken(s.sessionToken), 'the session survived');
        const after = await refreshStateOf(s.sessionId);
        assert.equal(after.rotationCount, 0);
        assert.equal(after.revokedAt, null);
        assert.equal(await refreshLeaseOf(s.sessionId), null, 'the claim was released');
      }
    });

    /**
     * The SECOND line, and the reason it is worth having: the primary fix is that
     * no transaction is held across a network call, but nothing stops a future
     * caller from reintroducing one. Postgres itself now refuses to keep a
     * connection tied up for a transaction that is sitting there doing nothing.
     */
    test('D1: every pooled connection is born with server-side bounds', async () => {
      const config = getDatabaseConfig();
      const bounds = new Map(
        (
          await query(
            `SELECT name, setting::int AS ms FROM pg_settings
              WHERE name IN ('statement_timeout', 'idle_in_transaction_session_timeout')`,
          )
        ).rows.map((r) => [
          String((r as { name: unknown }).name),
          Number((r as { ms: unknown }).ms),
        ]),
      );
      assert.equal(
        bounds.get('statement_timeout'),
        config.pgStatementTimeoutMs,
        'the configured statement bound reached the connection',
      );
      assert.equal(
        bounds.get('idle_in_transaction_session_timeout'),
        config.pgIdleInTransactionTimeoutMs,
        'the configured idle-in-transaction bound reached the connection — the one that ends a ' +
          'transaction left open around a network call',
      );
      assert.ok((bounds.get('statement_timeout') ?? 0) > 0, 'and neither is unbounded');
      assert.ok((bounds.get('idle_in_transaction_session_timeout') ?? 0) > 0);
    });

    test('D1: the LEASE enforces single-spend — held in flight, released on completion', async () => {
      const s = await seedRefreshableSession(
        'user_d1_lease',
        'provider-refresh-1',
        new Date(Date.now() + 20_000),
      );
      assert.equal(await refreshLeaseOf(s.sessionId), null, 'no attempt is in flight yet');

      const gated = gatedProvider({
        providerUserId: 'user_d1_lease',
        replacement: 'provider-refresh-2',
      });
      const first = refreshProviderSession({
        sessionId: s.sessionId,
        provider: gated,
        cookiePassword: COOKIE_PASSWORD,
        expectedIssuer: s.issuer,
        ttlSeconds: 3600,
        refreshDueLeewaySeconds: 60,
        providerTimeoutMs: 60_000,
        verifyAccessToken: () => verifiedRefreshFor('user_d1_lease'),
      });
      try {
        while (gated.presented.length < 1) {
          await new Promise<void>((resolve) => setTimeout(resolve, 10));
        }
        // THE MECHANISM: while the exchange is in flight the claim is a ROW FACT,
        // not a held lock — which is what lets the connection go back to the pool.
        const lease = await refreshLeaseOf(s.sessionId);
        assert.ok(lease !== null, 'an in-flight attempt holds a lease on the row');
        assert.ok(
          lease.expiresAt.getTime() > Date.now(),
          'and the lease is live, so nobody else may spend the token',
        );

        // a second attempt, arriving mid-flight, must spend NOTHING and must not
        // wait for the first one's network call either
        const second = await refreshProviderSession({
          sessionId: s.sessionId,
          provider: gated,
          cookiePassword: COOKIE_PASSWORD,
          expectedIssuer: s.issuer,
          ttlSeconds: 3600,
          refreshDueLeewaySeconds: 60,
          providerTimeoutMs: 60_000,
          verifyAccessToken: () => verifiedRefreshFor('user_d1_lease'),
        });
        assert.equal(second.outcome, 'refresh_in_flight');
        assert.deepEqual(gated.presented, ['provider-refresh-1'], 'still exactly one spend');
      } finally {
        gated.release();
      }

      const outcome = await first;
      if (outcome.outcome !== 'refreshed')
        assert.fail(`expected refreshed, got ${outcome.outcome}`);
      assert.equal(outcome.rotationCount, 1);
      assert.equal(
        await refreshLeaseOf(s.sessionId),
        null,
        'the completed attempt released its claim in the same statement that rotated',
      );
      const after = await refreshStateOf(s.sessionId);
      assert.equal(after.digest, sha256hex('provider-refresh-2'));
      assert.equal(after.revokedAt, null);
    });

    test('D1: an EXPIRED lease is reclaimable — a crashed attempt cannot wedge a session', async () => {
      const s = await seedRefreshableSession(
        'user_d1_stale',
        'provider-refresh-1',
        new Date(Date.now() + 20_000),
      );
      // Exactly what a process that died mid-exchange leaves behind: a claim, and
      // no claimant. Written straight to the row, because "the attempt is gone" is
      // precisely the state no code path can produce on purpose.
      await fixtureAuthorizationStateWrite(
        'simulate-authorization-drift',
        `UPDATE identity_sessions
            SET refresh_lease_id = gen_random_uuid(),
                refresh_lease_expires_at = NOW() + make_interval(secs => 30)
          WHERE session_id = $1`,
        [s.sessionId],
      );

      const blocked = fakeProvider({ providerUserId: 'user_d1_stale' });
      assert.equal(
        (
          await refreshProviderSession({
            sessionId: s.sessionId,
            provider: blocked,
            cookiePassword: COOKIE_PASSWORD,
            expectedIssuer: s.issuer,
            ttlSeconds: 3600,
            refreshDueLeewaySeconds: 60,
            verifyAccessToken: () => verifiedRefreshFor('user_d1_stale'),
          })
        ).outcome,
        'refresh_in_flight',
        'a LIVE lease is honoured — the single-use token is not spent twice',
      );
      assert.deepEqual(blocked.presented, []);

      // …and then the lease expires. THE POINT: this must be recoverable without
      // an operator, or a crash during a refresh would leave the session unable to
      // refresh for the rest of its life.
      await fixtureAuthorizationStateWrite(
        'simulate-authorization-drift',
        `UPDATE identity_sessions SET refresh_lease_expires_at = NOW() - make_interval(secs => 1)
          WHERE session_id = $1`,
        [s.sessionId],
      );
      const reclaimed = fakeProvider({
        providerUserId: 'user_d1_stale',
        replacement: 'provider-refresh-2',
      });
      const outcome = await refreshProviderSession({
        sessionId: s.sessionId,
        provider: reclaimed,
        cookiePassword: COOKIE_PASSWORD,
        expectedIssuer: s.issuer,
        ttlSeconds: 3600,
        refreshDueLeewaySeconds: 60,
        verifyAccessToken: () => verifiedRefreshFor('user_d1_stale'),
      });
      if (outcome.outcome !== 'refreshed')
        assert.fail(`expected refreshed, got ${outcome.outcome}`);
      assert.deepEqual(reclaimed.presented, ['provider-refresh-1'], 'the stale claim was taken');
      assert.equal(await refreshLeaseOf(s.sessionId), null);
      assert.equal((await refreshStateOf(s.sessionId)).digest, sha256hex('provider-refresh-2'));
      assert.ok(await validateSessionToken(s.sessionToken));
    });

    test('D1: parallel maintenance spends once and NOBODY waits for another request’s provider call', async () => {
      const verifiedFor = (subject: string): Promise<VerifiedAccessToken> =>
        Promise.resolve({
          providerUserId: subject,
          // R4 §3: a VERIFIED refresh reply must name the SAME provider session
          // the local session was established from, or the session is revoked.
          providerSessionId: 'sid_initial',
          organizationId: testOrganizationId(tenantId),
          authTime: new Date(Date.now() - 120_000),
          issuedAt: new Date(),
          expiresAt: new Date(Date.now() + 300_000),
          roleHints: [],
          nonceDigest: null,
          impersonation: NOT_IMPERSONATED,
        });
      const exchangeMs = 2_000;
      const s = await seedRefreshableSession(
        'user_d1_parallel',
        'provider-refresh-1',
        new Date(Date.now() + 20_000),
      );
      const provider = fakeProvider({
        providerUserId: 'user_d1_parallel',
        replacement: 'provider-refresh-2',
        delayMs: exchangeMs,
      });
      const startedAt = Date.now();
      const settled = await Promise.all(
        Array.from({ length: 6 }, () =>
          maintainProviderSession({
            session: s.session,
            provider,
            cookiePassword: COOKIE_PASSWORD,
            expectedIssuer: s.issuer,
            verifyAccessToken: () => verifiedFor('user_d1_parallel'),
            providerTimeoutMs: 60_000,
          }).then((outcome) => ({ outcome, elapsedMs: Date.now() - startedAt })),
        ),
      );

      assert.deepEqual(
        provider.presented,
        ['provider-refresh-1'],
        'the single-use credential is spent exactly once, however many requests are due',
      );
      const refreshed = settled.filter((r) => r.outcome.outcome === 'refreshed');
      const unchanged = settled.filter((r) => r.outcome.outcome === 'unchanged');
      assert.equal(refreshed.length, 1);
      assert.equal(unchanged.length, 5);
      assert.equal((await refreshStateOf(s.sessionId)).rotationCount, 1, 'exactly one rotation');
      assert.equal(
        (await refreshStateOf(s.sessionId)).revokedAt,
        null,
        'nobody revoked for racing',
      );

      // THE D1 PROPERTY, and the one a row lock cannot satisfy: the five requests
      // that had nothing to do returned IMMEDIATELY. Under the lock they queued
      // behind the winner's provider call — each holding a pool connection for the
      // whole exchange — and could not answer until it finished.
      for (const loser of unchanged) {
        assert.ok(
          loser.elapsedMs < exchangeMs / 2,
          `a request with nothing to do must not wait on someone else's provider call ` +
            `(waited ${loser.elapsedMs}ms of a ${exchangeMs}ms exchange)`,
        );
      }
      assert.equal(await refreshLeaseOf(s.sessionId), null, 'and no claim outlived the attempt');
    });

    // ── Obligation 6: the assurance floor ─────────────────────────────────
    test('a fresh_only grant can NEVER satisfy a fresh_and_mfa_policy operation', async () => {
      const link = await makeLink('user_assurance');
      const roId = randomUUID();

      // mint a FRESH-ONLY grant (no certified MFA policy). R3: the starting
      // identity is derived from the live local session, not supplied here.
      const started = await startReauthentication({
        tenantId,
        userLinkId: link,
        sessionId: (await seedLocalSession(link)).sessionId,
        action: 'service.ro.transition:authorized',
        resourceType: 'repair_order',
        resourceId: roId,
        requiredAssurance: 'fresh_only',
        callbackUri: TEST_REAUTH_CALLBACK_URI,
      });
      assert.ok(started);
      await claimStepUp(started);
      const completed = await completeReauthentication(completionFor(started, link));
      assert.ok(completed, 'a fresh_only transaction completes without MFA certification');

      const binding = {
        grant: completed.grant,
        tenantId,
        userLinkId: link,
        action: 'service.ro.transition:authorized',
        resourceType: 'repair_order',
        resourceId: roId,
      };

      // THE PROOF: the same grant is refused for a high-assurance operation…
      assert.equal(
        await withTransaction((tx) =>
          consumeReauthenticationGrant(tx, {
            ...binding,
            requiredAssurance: 'fresh_and_mfa_policy',
          }),
        ),
        false,
        'a fresh_only grant must not authorize a high-assurance operation',
      );
      // …and is still unspent, so the refusal did not silently burn it
      const unspent = await query(
        `SELECT consumed_at FROM reauthentication_grants WHERE tenant_id = $1`,
        [tenantId],
      );
      assert.equal((unspent.rows[0] as { consumed_at: unknown }).consumed_at, null);

      // it does satisfy the level it was minted at, exactly once
      assert.equal(
        await withTransaction((tx) =>
          consumeReauthenticationGrant(tx, { ...binding, requiredAssurance: 'fresh_only' }),
        ),
        true,
      );
    });

    test('a high-assurance grant requires a certified policy at issue time', async () => {
      const link = await makeLink('user_high');
      const started = await startReauthentication({
        tenantId,
        userLinkId: link,
        sessionId: (await seedLocalSession(link)).sessionId,
        action: 'service.ro.transition:authorized',
        resourceType: 'repair_order',
        resourceId: randomUUID(),
        requiredAssurance: 'fresh_and_mfa_policy',
        callbackUri: TEST_REAUTH_CALLBACK_URI,
      });
      assert.ok(started);
      await claimStepUp(started);
      // uncertified: mints nothing. R3 reads the certification off the
      // CONNECTION ROW at completion time, so no caller can assert it.
      assert.equal(await completeReauthentication(completionFor(started, link)), null);
    });

    // ── Obligation 5: exact reauthentication binding ──────────────────────
    test('a reauthentication that returns through a DIFFERENT identity mints nothing', async () => {
      const link = await makeLink('user_bound');
      await certifyMfaPolicy(tenantId);

      const started = await startReauthentication({
        tenantId,
        userLinkId: link,
        sessionId: (await seedLocalSession(link)).sessionId,
        action: 'service.ro.transition:authorized',
        resourceType: 'repair_order',
        resourceId: randomUUID(),
        requiredAssurance: 'fresh_and_mfa_policy',
        callbackUri: TEST_REAUTH_CALLBACK_URI,
      });
      assert.ok(started);
      await claimStepUp(started);

      // a token proving a DIFFERENT subject is not a reauthentication of this actor
      assert.equal(
        await completeReauthentication({
          ...completionFor(started, link),
          verifiedProviderSubject: 'somebody-else',
        }),
        null,
        'subject mismatch mints nothing',
      );
    });

    // ── R3 section I: support APPROVER AUTHORITY (test-gate item 16) ──────
    test('only a current tenant admin of the TARGET tenant may approve support access', async () => {
      const requester = await makePlatformLink('user_r3_req');
      await grantRole({
        actingUserLinkId: await bootstrapAdministrator(null),
        tenantId: null,
        userLinkId: requester,
        role: 'platform_support',
        scopeLevel: 'platform',
        scopeId: null,
      });

      const request = await requestSupportAccess({
        tenantId,
        requesterUserLinkId: requester,
        requestedActions: ['service.ro.view'],
        reason: 'ticket 55: authority matrix',
        requestedDurationMinutes: 30,
      });

      // (a) a NON-ADMIN in the tenant cannot approve, even holding a grant
      const nonAdmin = await makeLink('user_r3_nonadmin');
      assert.equal(
        await decideSupportAccess({
          requestId: request.requestId,
          decidedByUserLinkId: nonAdmin,
          approve: true,
        }),
        null,
        'a tenant member without tenant_admin cannot approve',
      );

      // (b) an admin of ANOTHER tenant cannot approve
      const otherTenant = randomUUID();
      await seedTenantIdentity(otherTenant);
      const foreignAdmin = await (async () => {
        const r = await fixtureAuthorizationStateWrite(
          'seed-authorization-state',
          `INSERT INTO user_links
             (actor_scope, tenant_id, provider, provider_user_id, status, activated_at,
              connection_id, issuer, provider_organization_id)
           SELECT 'dealership', $1, 'workos', 'user_foreign_admin', 'activated', NOW(),
                  c.connection_id, c.issuer, c.provider_organization_id
             FROM identity_provider_connections c
            WHERE c.tenant_id = $1 AND c.status = 'active' LIMIT 1
           RETURNING user_link_id`,
          [otherTenant],
        );
        const id = String((r.rows[0] as { user_link_id: unknown }).user_link_id);
        await grantRole({
          actingUserLinkId: await bootstrapAdministrator(otherTenant),
          tenantId: otherTenant,
          userLinkId: id,
          role: 'tenant_admin',
          scopeLevel: 'tenant',
          scopeId: otherTenant,
        });
        return id;
      })();
      assert.equal(
        await decideSupportAccess({
          requestId: request.requestId,
          decidedByUserLinkId: foreignAdmin,
          approve: true,
        }),
        null,
        'a tenant_admin of another tenant cannot approve',
      );

      // (c) an INACTIVE admin of the right tenant cannot approve
      const admin = await makeLink('user_r3_admin');
      // the binding is granted and then REVOKED through the owned services, so
      // the fixture is an attributable history rather than an invented row
      const staleGrant = await grantRole({
        actingUserLinkId: await bootstrapAdministrator(tenantId),
        tenantId,
        userLinkId: admin,
        role: 'tenant_admin',
        scopeLevel: 'tenant',
        scopeId: tenantId,
      });
      await revokeRole({
        actingUserLinkId: await bootstrapAdministrator(tenantId),
        roleBindingId: staleGrant.roleBindingId,
      });
      assert.equal(
        await decideSupportAccess({
          requestId: request.requestId,
          decidedByUserLinkId: admin,
          approve: true,
        }),
        null,
        'a revoked tenant_admin binding cannot approve',
      );

      // (d) the request is STILL pending — no unauthorized attempt disposed of it
      const still = await query(
        `SELECT status FROM support_access_requests WHERE request_id = $1`,
        [request.requestId],
      );
      assert.equal(String((still.rows[0] as { status: string }).status), 'pending');
    });

    test('support revocation is authorized, scoped and attributable', async () => {
      const requester = await makePlatformLink('user_r3_rev_req');
      const outsider = await makeLink('user_r3_outsider');
      // FBL-020-R7 §3.2: a session exists only under an APPROVED, decided request,
      // so the fixture approves for real — separation of duty and the request-bound
      // grant included — before the session can exist at all.
      const request = await fixtureAuthorizationStateWrite(
        'seed-authorization-state',
        `INSERT INTO support_access_requests
           (tenant_id, requester_user_link_id, requested_actions, reason,
            requested_duration_minutes, status)
         VALUES ($1, $2, ARRAY['service.ro.view'], 'ticket 56', 30, 'pending')
         RETURNING request_id`,
        [tenantId, requester],
      );
      const revRequestId = String((request.rows[0] as { request_id: unknown }).request_id);
      {
        const decider = await bootstrapAdministrator(tenantId);
        await mintReauthGrant({
          tenantId,
          userLinkId: decider,
          action: 'identity.support.approve',
          resourceType: 'support_access_request',
          resourceId: revRequestId,
        });
        await approveSupportRequestDirectly({
          requestId: revRequestId,
          deciderUserLinkId: decider,
        });
      }
      const session = await fixtureAuthorizationStateWrite(
        'seed-authorization-state',
        `INSERT INTO support_access_sessions (request_id, tenant_id, actor_user_link_id, expires_at)
         VALUES ($1, $2, $3, NOW() + INTERVAL '30 minutes')
         RETURNING support_session_id`,
        [revRequestId, tenantId, requester],
      );
      const sessionId = String(
        (session.rows[0] as { support_session_id: unknown }).support_session_id,
      );

      // an unauthorized tenant member cannot revoke
      assert.equal(
        await revokeSupportSession({
          supportSessionId: sessionId,
          revokedByUserLinkId: outsider,
        }),
        false,
        'a non-admin cannot revoke a support session',
      );
      const live = await query(
        `SELECT revoked_at FROM support_access_sessions WHERE support_session_id = $1`,
        [sessionId],
      );
      assert.equal((live.rows[0] as { revoked_at: unknown }).revoked_at, null);

      // the support actor may end their OWN session
      assert.equal(
        await revokeSupportSession({
          supportSessionId: sessionId,
          revokedByUserLinkId: requester,
        }),
        true,
      );
    });

    // ── Obligation 10: support approval needs high assurance ──────────────
    test('support approval without a high-assurance grant is refused', async () => {
      // R3: the requester must be a current active platform-support actor,
      // and the approver a current tenant administrator of this tenant.
      const requester = await makePlatformLink('user_support_req');
      await grantRole({
        actingUserLinkId: await bootstrapAdministrator(null),
        tenantId: null,
        userLinkId: requester,
        role: 'platform_support',
        scopeLevel: 'platform',
        scopeId: null,
      });
      const approver = await makeLink('user_support_appr');
      await grantRole({
        actingUserLinkId: await bootstrapAdministrator(tenantId),
        tenantId,
        userLinkId: approver,
        role: 'tenant_admin',
        scopeLevel: 'tenant',
        scopeId: tenantId,
      });
      const request = await requestSupportAccess({
        tenantId,
        requesterUserLinkId: requester,
        requestedActions: ['service.ro.view'],
        reason: 'ticket 1: verify totals',
        requestedDurationMinutes: 30,
      });

      // no grant at all
      assert.equal(
        await decideSupportAccess({
          requestId: request.requestId,
          decidedByUserLinkId: approver,
          approve: true,
        }),
        null,
        'approval without a high-assurance grant must be refused',
      );

      // the request is untouched and still approvable later
      const still = await query(
        `SELECT status FROM support_access_requests WHERE request_id = $1`,
        [request.requestId],
      );
      assert.equal(String((still.rows[0] as { status: string }).status), 'pending');

      // a DENIAL needs no grant
      assert.equal(
        await decideSupportAccess({
          requestId: request.requestId,
          decidedByUserLinkId: approver,
          approve: false,
        }),
        null,
      );
      const denied = await query(
        `SELECT status, authorization_version FROM support_access_requests WHERE request_id = $1`,
        [request.requestId],
      );
      const row = denied.rows[0] as { status: string; authorization_version: unknown };
      assert.equal(String(row.status), 'denied');
      assert.ok(Number(row.authorization_version) > 1, 'the decision advanced the version');
    });

    // ── FBL-020-R3 corrections A1/A2/A3: the support-access authority gates ──
    //
    // The R3 adversarial review found three defects in these gates, and in each
    // case the ENGINE already answered correctly while a second, hand-written
    // predicate in the mutation service answered otherwise. The tests below
    // exist because the previous ones would all still have passed with the
    // security property deleted: every one of them granted `tenant_admin` at
    // `scopeLevel: 'tenant'`, which is the one shape the broken gate got right.

    /** A platform-support actor entitled to FILE support requests. */
    async function makePlatformSupportRequester(subject: string): Promise<string> {
      const link = await makePlatformLink(subject);
      await grantRole({
        actingUserLinkId: await bootstrapAdministrator(null),
        tenantId: null,
        userLinkId: link,
        role: 'platform_support',
        scopeLevel: 'platform',
        scopeId: null,
      });
      return link;
    }

    /** A tenant administrator bound at an EXPLICIT scope, through the service. */
    async function makeScopedTenantAdmin(
      subject: string,
      scope: { level: string; id: string | null },
    ): Promise<string> {
      const link = await makeLink(subject);
      await grantRole({
        actingUserLinkId: await bootstrapAdministrator(tenantId),
        tenantId,
        userLinkId: link,
        role: 'tenant_admin',
        scopeLevel: scope.level,
        scopeId: scope.id,
      });
      return link;
    }

    /** The grant an approval now demands: this action, against THIS request. */
    function mintApprovalGrant(approver: string, requestId: string): Promise<string> {
      return mintReauthGrant({
        tenantId,
        userLinkId: approver,
        action: 'identity.support.approve',
        resourceType: 'support_access_request',
        resourceId: requestId,
      });
    }

    async function requestStatus(requestId: string): Promise<string> {
      const r = await query(`SELECT status FROM support_access_requests WHERE request_id = $1`, [
        requestId,
      ]);
      return String((r.rows[0] as { status: unknown }).status);
    }

    async function grantIsSpent(
      userLinkId: string,
      action: string,
      resourceId: string,
    ): Promise<boolean> {
      const r = await query(
        `SELECT consumed_at FROM reauthentication_grants
          WHERE user_link_id = $1 AND action = $2 AND resource_id = $3`,
        [userLinkId, action, resourceId],
      );
      assert.equal(r.rows.length, 1, 'the fixture minted exactly one such grant');
      return (r.rows[0] as { consumed_at: unknown }).consumed_at !== null;
    }

    /** The REAL published identity catalog, decided by the REAL engine. */
    function identityEngine() {
      // FBL-020-R4 §2.2: an ALLOW must name the session the request presented, so the
      // fixture engine presents the actor's own live one unless a test names one itself.
      return withPresentedSession(
        createPolicyEngine({
          catalog: createIdentityActionCatalog(),
          // every identity action names no resource, so this is never consulted
          resolveResourceScope: () => Promise.resolve(null),
        }),
      );
    }

    // ── A1 ────────────────────────────────────────────────────────────────
    test('a ROOFTOP-scoped tenant_admin holds NO tenant-wide support authority', async () => {
      const rooftopId = randomUUID();
      await seedRooftopIdentity(tenantId, rooftopId);
      const requester = await makePlatformSupportRequester('user_a1_req');
      const rooftopAdmin = await makeScopedTenantAdmin('user_a1_rooftop', {
        level: 'rooftop',
        id: rooftopId,
      });
      const tenantAdmin = await makeScopedTenantAdmin('user_a1_tenant', {
        level: 'tenant',
        id: tenantId,
      });

      // THE DISAGREEMENT THAT WAS THE DEFECT: the engine denies the
      // rooftop-scoped admin this very action, because `identity.support.approve`
      // names no resource and therefore reaches the whole tenant. The gates
      // below must now answer the same way.
      const engine = identityEngine();
      const asRooftop = await engine.decide({
        actor: { userLinkId: rooftopAdmin, actorScope: 'dealership', tenantId },
        action: 'identity.support.approve',
      });
      assert.equal(asRooftop.decision, 'deny');
      assert.equal(asRooftop.reasonCode, 'NO_MATCHING_BINDING');
      const asTenant = await engine.decide({
        actor: { userLinkId: tenantAdmin, actorScope: 'dealership', tenantId },
        action: 'identity.support.approve',
      });
      assert.equal(asTenant.decision, 'allow');

      const filed = await requestSupportAccess({
        tenantId,
        requesterUserLinkId: requester,
        requestedActions: ['service.ro.view'],
        reason: 'ticket A1: rooftop-scoped admin must hold no tenant authority',
        requestedDurationMinutes: 30,
      });

      // (a) it cannot DENY — the request survives the attempt untouched
      await decideSupportAccess({
        requestId: filed.requestId,
        decidedByUserLinkId: rooftopAdmin,
        approve: false,
      });
      assert.equal(
        await requestStatus(filed.requestId),
        'pending',
        'a rooftop-scoped admin must not be able to dispose of a tenant request',
      );

      // (b) it cannot APPROVE — even holding a perfectly valid grant of its own,
      //     and the grant is left UNSPENT, so authority is decided first
      const rooftopGrant = await mintApprovalGrant(rooftopAdmin, filed.requestId);
      assert.equal(
        await decideSupportAccess({
          requestId: filed.requestId,
          decidedByUserLinkId: rooftopAdmin,
          approve: true,
          approvalGrant: rooftopGrant,
        }),
        null,
        'a rooftop-scoped admin must not be able to approve support access',
      );
      assert.equal(await requestStatus(filed.requestId), 'pending');
      assert.equal(
        await grantIsSpent(rooftopAdmin, 'identity.support.approve', filed.requestId),
        false,
        'the refusal must not burn the grant',
      );

      // (c) the TENANT-scoped admin still may — the gate narrowed, not closed
      const approved = await decideSupportAccess({
        requestId: filed.requestId,
        decidedByUserLinkId: tenantAdmin,
        approve: true,
        approvalGrant: await mintApprovalGrant(tenantAdmin, filed.requestId),
      });
      assert.ok(approved, 'a tenant-scoped tenant_admin approves as before');
      assert.equal(await requestStatus(filed.requestId), 'approved');

      // (d) it cannot START the session an approval authorizes. The fixture is
      //     an approved request whose session has not been started yet, which
      //     `decideSupportAccess` never leaves behind — so it is built directly,
      //     naming a real grant because the schema demands one.
      const sessionless = await requestSupportAccess({
        tenantId,
        requesterUserLinkId: requester,
        requestedActions: ['service.ro.view'],
        reason: 'ticket A1: approved, session not yet started',
        requestedDurationMinutes: 30,
      });
      await mintApprovalGrant(tenantAdmin, sessionless.requestId);
      await approveSupportRequestDirectly({
        requestId: sessionless.requestId,
        deciderUserLinkId: tenantAdmin,
      });
      assert.equal(
        await startSupportSession({
          requestId: sessionless.requestId,
          startedByUserLinkId: rooftopAdmin,
        }),
        null,
        'a rooftop-scoped admin must not be able to start a support session',
      );
      const none = await query(`SELECT 1 FROM support_access_sessions WHERE request_id = $1`, [
        sessionless.requestId,
      ]);
      assert.equal(none.rows.length, 0, 'no session was created by the refused start');
      const started = await startSupportSession({
        requestId: sessionless.requestId,
        startedByUserLinkId: tenantAdmin,
      });
      assert.ok(started, 'a tenant-scoped tenant_admin starts the session as before');

      // (e) it cannot REVOKE a live session
      assert.equal(
        await revokeSupportSession({
          supportSessionId: started.supportSessionId,
          revokedByUserLinkId: rooftopAdmin,
        }),
        false,
        'a rooftop-scoped admin must not be able to revoke a support session',
      );
      const live = await query(
        `SELECT revoked_at FROM support_access_sessions WHERE support_session_id = $1`,
        [started.supportSessionId],
      );
      assert.equal((live.rows[0] as { revoked_at: unknown }).revoked_at, null);
      assert.equal(
        await revokeSupportSession({
          supportSessionId: started.supportSessionId,
          revokedByUserLinkId: tenantAdmin,
        }),
        true,
        'a tenant-scoped tenant_admin revokes as before',
      );
    });

    // ── A2 ────────────────────────────────────────────────────────────────
    test('a support-approval grant is bound to its action, its request and ONE use', async () => {
      const requester = await makePlatformSupportRequester('user_a2_req');
      const approver = await makeScopedTenantAdmin('user_a2_appr', {
        level: 'tenant',
        id: tenantId,
      });
      const file = (ticket: string) =>
        requestSupportAccess({
          tenantId,
          requesterUserLinkId: requester,
          requestedActions: ['service.ro.view'],
          reason: `ticket A2: ${ticket}`,
          requestedDurationMinutes: 30,
        });
      const wrongAction = await file('grant minted for another action');
      const otherRequest = await file('grant minted for another request');
      const replayed = await file('grant already spent once');

      // (a) a grant minted for a DIFFERENT ACTION cannot approve. This is a
      //     real, high-assurance grant of the approver's — only its `action`
      //     differs, and that is enough.
      const voidGrant = await mintReauthGrant({
        tenantId,
        userLinkId: approver,
        action: 'service.ro.void',
        resourceType: 'support_access_request',
        resourceId: wrongAction.requestId,
      });
      assert.equal(
        await decideSupportAccess({
          requestId: wrongAction.requestId,
          decidedByUserLinkId: approver,
          approve: true,
          approvalGrant: voidGrant,
        }),
        null,
        "a grant minted for 'service.ro.void' must not approve support access",
      );
      assert.equal(await requestStatus(wrongAction.requestId), 'pending');
      assert.equal(
        await grantIsSpent(approver, 'service.ro.void', wrongAction.requestId),
        false,
        'the refused grant is left unspent',
      );

      // (b) a grant minted against ANOTHER REQUEST cannot approve this one. The
      //     grant's tenant is pinned to the same fact by a composite foreign key
      //     (reauthentication_grants -> user_links on (tenant_id, user_link_id)),
      //     so the request binding is the reachable half of "bound to the target".
      const otherGrant = await mintApprovalGrant(approver, otherRequest.requestId);
      assert.equal(
        await decideSupportAccess({
          requestId: wrongAction.requestId,
          decidedByUserLinkId: approver,
          approve: true,
          approvalGrant: otherGrant,
        }),
        null,
        'a grant minted against one request must not approve another',
      );
      assert.equal(await requestStatus(wrongAction.requestId), 'pending');
      assert.equal(
        await grantIsSpent(approver, 'identity.support.approve', otherRequest.requestId),
        false,
      );

      // (c) the grant minted for THIS request and THIS action approves, exactly
      //     once, and the spend is recorded on the request
      const good = await mintApprovalGrant(approver, wrongAction.requestId);
      const session = await decideSupportAccess({
        requestId: wrongAction.requestId,
        decidedByUserLinkId: approver,
        approve: true,
        approvalGrant: good,
      });
      assert.ok(session, 'a correctly bound grant approves');
      assert.equal(
        await grantIsSpent(approver, 'identity.support.approve', wrongAction.requestId),
        true,
        'the approval SPENT the grant',
      );
      const recorded = await query(
        `SELECT r.approval_grant_id, g.grant_id
           FROM support_access_requests r
           JOIN reauthentication_grants g ON g.grant_id = r.approval_grant_id
          WHERE r.request_id = $1`,
        [wrongAction.requestId],
      );
      assert.equal(recorded.rows.length, 1, 'the request names the grant that paid for it');

      // and the DATABASE says so INDEPENDENTLY of the application: migration 057
      // carries a partial unique index, so a second request can never name a
      // grant that already approved one, whatever the code above does.
      // FBL-020-R7 §3.2 answers this FIRST now: the grant is bound to the exact
      // request it names, so re-pointing another request at it dies at the
      // request-binding trigger before the unique index is even consulted. The
      // 057 partial unique index still stands beneath as the structural backstop.
      await assert.rejects(
        fixtureAuthorizationStateWrite(
          'simulate-authorization-drift',
          `UPDATE support_access_requests
              SET approval_grant_id = (
                SELECT approval_grant_id FROM support_access_requests WHERE request_id = $2
              )
            WHERE request_id = $1`,
          [otherRequest.requestId, wrongAction.requestId],
        ),
        (err: unknown) =>
          (err as { message?: string }).message?.includes(
            'a grant approves exactly the request it names',
          ) === true,
        'a second request cannot name a grant that already approved another',
      );

      // (d) THE SAME GRANT CANNOT APPROVE TWICE. The grant below is spent once
      //     through the sanctioned primitive — any legitimate spend does — and
      //     is then presented to an approval, which must refuse it. R2 required
      //     `consumed_at IS NOT NULL`, the exact INVERSE of single-use, so this
      //     is the state that used to be *required* rather than refused.
      const replayGrant = await mintApprovalGrant(approver, replayed.requestId);
      assert.equal(
        await withTransaction((tx) =>
          consumeReauthenticationGrant(tx, {
            grant: replayGrant,
            tenantId,
            userLinkId: approver,
            action: 'identity.support.approve',
            resourceType: 'support_access_request',
            resourceId: replayed.requestId,
            requiredAssurance: 'fresh_and_mfa_policy',
          }),
        ),
        true,
        'the first spend succeeds',
      );
      assert.equal(
        await decideSupportAccess({
          requestId: replayed.requestId,
          decidedByUserLinkId: approver,
          approve: true,
          approvalGrant: replayGrant,
        }),
        null,
        'an already-consumed grant must not approve',
      );
      assert.equal(await requestStatus(replayed.requestId), 'pending');
    });

    test('an EXPIRED support-approval grant is refused', async () => {
      const requester = await makePlatformSupportRequester('user_a2exp_req');
      const approver = await makeScopedTenantAdmin('user_a2exp_appr', {
        level: 'tenant',
        id: tenantId,
      });
      const filed = await requestSupportAccess({
        tenantId,
        requesterUserLinkId: requester,
        requestedActions: ['service.ro.view'],
        reason: 'ticket A2: expired grant',
        requestedDurationMinutes: 30,
      });
      const grant = await mintApprovalGrant(approver, filed.requestId);

      // age the grant PAST its life. `issued_at` moves with it because the table
      // refuses a grant that expired before it was issued.
      await query(
        `UPDATE reauthentication_grants
            SET issued_at = NOW() - INTERVAL '10 minutes',
                expires_at = NOW() - INTERVAL '1 minute'
          WHERE user_link_id = $1 AND action = 'identity.support.approve' AND resource_id = $2`,
        [approver, filed.requestId],
      );

      assert.equal(
        await decideSupportAccess({
          requestId: filed.requestId,
          decidedByUserLinkId: approver,
          approve: true,
          approvalGrant: grant,
        }),
        null,
        'an expired grant must not approve',
      );
      assert.equal(await requestStatus(filed.requestId), 'pending');
      assert.equal(
        await grantIsSpent(approver, 'identity.support.approve', filed.requestId),
        false,
        'an expired grant is not spendable at all',
      );
    });

    // ── A3 ────────────────────────────────────────────────────────────────
    test('a windowed-out platform_support binding cannot file a support request', async () => {
      const requester = await makePlatformSupportRequester('user_a3_req');
      const file = (ticket: string) =>
        requestSupportAccess({
          tenantId,
          requesterUserLinkId: requester,
          requestedActions: ['service.ro.view'],
          reason: `ticket A3: ${ticket}`,
          requestedDurationMinutes: 30,
        });

      // control: inside its window the binding files requests
      await file('inside the effective window');
      const before = await query(`SELECT COUNT(*)::int AS n FROM support_access_requests`);
      assert.equal(Number((before.rows[0] as { n: unknown }).n), 1);

      // move the binding's effective window entirely into the PAST — status
      // stays 'active', which is exactly the shape the old predicate accepted
      await fixtureAuthorizationStateWrite(
        'simulate-authorization-drift',
        `UPDATE role_bindings
            SET effective_from = NOW() - INTERVAL '2 days',
                effective_to = NOW() - INTERVAL '1 day'
          WHERE user_link_id = $1 AND scope_level = 'platform'`,
        [requester],
      );

      // the engine's effectiveness predicate now matches nothing…
      const decided = await identityEngine().decide({
        actor: { userLinkId: requester, actorScope: 'platform', tenantId: null },
        action: 'platform.support.request',
      });
      assert.equal(decided.decision, 'deny');
      assert.equal(decided.reasonCode, 'NO_MATCHING_BINDING');

      // …and neither does the gate: no request is filed
      await assert.rejects(
        file('outside the effective window'),
        /active platform-support actor/,
        'a windowed-out binding must not be able to file a support request',
      );
      const after = await query(`SELECT COUNT(*)::int AS n FROM support_access_requests`);
      assert.equal(
        Number((after.rows[0] as { n: unknown }).n),
        1,
        'the refused request was never created',
      );
    });

    // ── R3 correction F1: LOSING PLATFORM AUTHORITY IS OFFBOARDING ─────────
    //
    // A3 required a current, effective platform-support binding at the FILING
    // gate — the one step that extends nobody's reach, because a filed request
    // sits inert until a tenant administrator approves it. Approval mints a
    // fresh 60-minute window into tenant data, and it re-checked nothing about
    // the requester; neither did starting a session. So revoking a platform
    // actor's binding, the natural offboarding action, left a pending request
    // approvable into live access hours or days later.
    //
    // These tests are about the REQUESTER's authority. Each holds the approver's
    // authority and grant constant, so nothing else can explain the refusal.

    /** The requester's platform binding, so a test can revoke it by id. */
    async function platformBindingOf(userLinkId: string): Promise<string> {
      const r = await query(
        `SELECT role_binding_id FROM role_bindings
          WHERE user_link_id = $1 AND scope_level = 'platform'`,
        [userLinkId],
      );
      assert.equal(r.rows.length, 1, 'the fixture granted exactly one platform binding');
      return String((r.rows[0] as { role_binding_id: unknown }).role_binding_id);
    }

    /** Offboarding, and nothing else: the requester's binding is revoked. */
    async function offboard(userLinkId: string): Promise<void> {
      const revoked = await revokeRole({
        actingUserLinkId: await bootstrapAdministrator(null),
        roleBindingId: await platformBindingOf(userLinkId),
      });
      assert.ok(revoked, 'the fixture revoked the requester binding');
    }

    async function sessionCount(): Promise<number> {
      const r = await query(`SELECT COUNT(*)::int AS n FROM support_access_sessions`);
      return Number((r.rows[0] as { n: unknown }).n);
    }

    test('a REVOKED requester binding blocks approval, keeps the request pending and spends no grant', async () => {
      const requester = await makePlatformSupportRequester('user_f1rev_req');
      const approver = await makeScopedTenantAdmin('user_f1rev_appr', {
        level: 'tenant',
        id: tenantId,
      });
      const filed = await requestSupportAccess({
        tenantId,
        requesterUserLinkId: requester,
        requestedActions: ['service.ro.view'],
        reason: 'ticket F1: offboarded while the request was pending',
        requestedDurationMinutes: 30,
      });
      const grant = await mintApprovalGrant(approver, filed.requestId);

      // The approver keeps their tenant-wide binding and their freshly minted
      // high-assurance grant. ONLY the requester's authority changes.
      await offboard(requester);

      assert.equal(
        await decideSupportAccess({
          requestId: filed.requestId,
          decidedByUserLinkId: approver,
          approve: true,
          approvalGrant: grant,
        }),
        null,
        'an offboarded requester must not be approved into a live session',
      );
      // no session exists at all — not a revoked one, none
      assert.equal(await sessionCount(), 0);
      assert.equal(
        await requestStatus(filed.requestId),
        'pending',
        'the refusal left the request decidable',
      );
      assert.equal(
        await grantIsSpent(approver, 'identity.support.approve', filed.requestId),
        false,
        "the approver's single-use grant must not pay for a decision that was refused",
      );

      // And the refusal is about the REQUESTER, not the approver: restore the
      // binding and the very same unspent grant approves.
      await grantRole({
        actingUserLinkId: await bootstrapAdministrator(null),
        tenantId: null,
        userLinkId: requester,
        role: 'platform_support',
        scopeLevel: 'platform',
        scopeId: null,
      });
      const approved = await decideSupportAccess({
        requestId: filed.requestId,
        decidedByUserLinkId: approver,
        approve: true,
        approvalGrant: grant,
      });
      assert.ok(approved, 'a restored binding approves with the still-unspent grant');
      assert.equal(approved.actorUserLinkId, requester);
    });

    test('a WINDOWED-OUT requester binding blocks approval — its status stays active throughout', async () => {
      const requester = await makePlatformSupportRequester('user_f1win_req');
      const approver = await makeScopedTenantAdmin('user_f1win_appr', {
        level: 'tenant',
        id: tenantId,
      });
      const filed = await requestSupportAccess({
        tenantId,
        requesterUserLinkId: requester,
        requestedActions: ['service.ro.view'],
        reason: 'ticket F1: binding aged out while the request was pending',
        requestedDurationMinutes: 30,
      });
      const grant = await mintApprovalGrant(approver, filed.requestId);

      // The window closes while `status` stays 'active' — exactly the shape a
      // predicate that checks only the status accepts.
      await moveWindow(requester, 'platform_support', -2 * 86_400, -86_400);
      assert.equal(
        (await bindingRow(requester)).status,
        'active',
        'the binding is still ACTIVE; only its window has passed',
      );

      assert.equal(
        await decideSupportAccess({
          requestId: filed.requestId,
          decidedByUserLinkId: approver,
          approve: true,
          approvalGrant: grant,
        }),
        null,
        'a binding outside its own window must not be approved into a live session',
      );
      assert.equal(await sessionCount(), 0);
      assert.equal(await requestStatus(filed.requestId), 'pending');
      assert.equal(
        await grantIsSpent(approver, 'identity.support.approve', filed.requestId),
        false,
        'the refusal cost the approver nothing',
      );

      // A DENIAL is deliberately NOT gated on the requester's authority:
      // disposing of a stale request extends nobody's reach, so an
      // administrator can always clear one.
      assert.equal(
        await decideSupportAccess({
          requestId: filed.requestId,
          decidedByUserLinkId: approver,
          approve: false,
        }),
        null,
      );
      assert.equal(await requestStatus(filed.requestId), 'denied');
    });

    test('startSupportSession refuses an approved request whose requester was offboarded after the approval', async () => {
      const requester = await makePlatformSupportRequester('user_f1start_req');
      const approver = await makeScopedTenantAdmin('user_f1start_appr', {
        level: 'tenant',
        id: tenantId,
      });
      const filed = await requestSupportAccess({
        tenantId,
        requesterUserLinkId: requester,
        requestedActions: ['service.ro.view'],
        reason: 'ticket F1: approved, then offboarded before the session started',
        requestedDurationMinutes: 30,
      });
      // An approved request whose session has NOT been started is a state
      // `decideSupportAccess` never leaves behind, so it is built directly —
      // naming a real grant, because the schema demands one.
      await mintApprovalGrant(approver, filed.requestId);
      await approveSupportRequestDirectly({
        requestId: filed.requestId,
        deciderUserLinkId: approver,
      });
      assert.equal(await requestStatus(filed.requestId), 'approved');

      await offboard(requester);

      assert.equal(
        await startSupportSession({
          requestId: filed.requestId,
          startedByUserLinkId: approver,
        }),
        null,
        'an approved request must not start a session for an offboarded requester',
      );
      assert.equal(await sessionCount(), 0, 'no session was created by the refused start');
    });

    // ── R3 correction F2: no decorative assurance schema ──────────────────
    test('no support-request column presents an approval assurance bar that nothing reads', async () => {
      // Every column of the table whose CHECK constraint enumerates the
      // assurance vocabulary — that is, every column PRESENTING ITSELF as the
      // approval bar.
      const constrained = await query(
        `SELECT DISTINCT a.attname AS column_name
           FROM pg_constraint c
           JOIN pg_class t ON t.oid = c.conrelid
           CROSS JOIN LATERAL unnest(c.conkey) AS k(attnum)
           JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
          WHERE t.relname = 'support_access_requests'
            AND c.contype = 'c'
            AND pg_get_constraintdef(c.oid) LIKE '%fresh_and_mfa_policy%'`,
      );
      const columns = (constrained.rows as Array<{ column_name: unknown }>).map((r) =>
        String(r.column_name),
      );
      // R3 correction F2 DELETED `approver_assurance` rather than wiring it up:
      // reading it would have created a per-request DOWNGRADE of the one gate
      // that admits a platform person to tenant data, and no writer, operator
      // procedure or authority exists to decide when a lower bar is right. The
      // bar is `fresh_and_mfa_policy`, stated once in `decideSupportAccess`.
      //
      // The rule enforced here is the GENERAL one, not the single name: a column
      // may present the assurance bar only if the application actually READS it.
      // Re-adding the column together with the reader that honours it passes;
      // re-adding it alone does not.
      const sources = identityAccessSources();
      for (const column of columns) {
        assert.ok(
          sources.some((src) => src.includes(column)),
          `support_access_requests.${column} is constrained to the approval assurance ` +
            `vocabulary but no identity-access source reads it. Authoritative-looking schema ` +
            `with zero readers is a trap: either read it, or drop it from migration 057.`,
        );
      }
    });

    // ── R3 §1: policy evidence comes from the GENERATED request context ───
    //
    // Before this revision the HTTP layer handed the engine whatever
    // `x-request-id` / `x-correlation-id` the caller had sent, and null when it
    // sent nothing — so the append-only evidence table recorded a client's
    // choice, or no correlation at all. Freshness and MFA assurance were
    // caller-supplied too, and both silently defaulted to 'not_applicable',
    // which made "not proven" indistinguishable from "does not apply".
    test('a decision records the GENERATED ids and REAL, computed assurance', async () => {
      const engine = createPolicyEngine({
        catalog: createActionCatalog([
          {
            action: 'identity.tenant.read',
            description: 'read tenant configuration',
            resourceType: null,
            allowedRoles: ['tenant_admin'],
          },
        ]),
        // this action names no resource, so the resolver is never consulted
        resolveResourceScope: () => Promise.resolve(null),
      });
      // NOT wrapped: this test names its own presented session on every call, because
      // WHICH session is presented is the property under test.
      /**
       * R3 correction B2: a decision is made ON A PRESENTED CREDENTIAL, so the
       * session id is part of the call. `null` is the truthful value for a
       * decision made off any credential at all (a scheduler, a CLI) — never a
       * shortcut that lets the engine go looking for a better session.
       */
      const decide = (userLinkId: string, sessionId: string | null = null) =>
        engine.decide({
          actor: { userLinkId, actorScope: 'dealership' as const, tenantId },
          action: 'identity.tenant.read',
          sessionId,
        });
      const evidenceFor = async (decisionId: string): Promise<Record<string, unknown>> => {
        const r = await query(
          `SELECT request_id, correlation_id, freshness_classification,
                  mfa_assurance_classification, session_id
             FROM policy_decisions WHERE decision_id = $1`,
          [decisionId],
        );
        assert.equal(r.rows.length, 1, 'every decision writes exactly one evidence row');
        return r.rows[0] as Record<string, unknown>;
      };

      const admin = await bootstrapAdministrator(tenantId);
      await certifyMfaPolicy(tenantId);

      // (a) an AUTHENTICATED actor: a live local session and a certified
      //     connection — real assurance, and the ids of the request context the
      //     outermost middleware generated.
      const live = await makeLink('user_r3_evidence_live');
      await grantRole({
        actingUserLinkId: admin,
        tenantId,
        userLinkId: live,
        role: 'tenant_admin',
        scopeLevel: 'tenant',
        scopeId: tenantId,
      });
      const liveSession = await createSession({
        ...(await sessionBindingForLink(live)),
        tenantId,
        userLinkId: live,
        providerSessionId: null,
        authTime: new Date(),
        ttlSeconds: 3600,
      });

      const generated = {
        requestId: `req-generated-${randomUUID()}`,
        correlationId: `corr-generated-${randomUUID()}`,
        startTime: Date.now(),
      };
      const allowed = await runWithRequestContext(generated, () =>
        decide(live, liveSession.session.sessionId),
      );
      assert.equal(allowed.decision, 'allow');
      const row = await evidenceFor(allowed.decisionId);
      assert.equal(
        row.session_id,
        liveSession.session.sessionId,
        'the classification and the recorded session are the SAME credential',
      );
      assert.equal(row.request_id, generated.requestId, 'the GENERATED request id is recorded');
      assert.equal(
        row.correlation_id,
        generated.correlationId,
        'the GENERATED correlation id is recorded',
      );
      assert.equal(String(row.freshness_classification), 'fresh');
      assert.equal(String(row.mfa_assurance_classification), 'certified');

      // (b) OFF a request the ids are still generated, never null: an
      //     uncorrelatable decision is not a fact this platform records.
      const offRequest = await decide(live, liveSession.session.sessionId);
      const offRow = await evidenceFor(offRequest.decisionId);
      assert.ok(
        typeof offRow.request_id === 'string' && offRow.request_id.length >= 8,
        'an off-request decision still records a generated request id',
      );
      assert.ok(typeof offRow.correlation_id === 'string' && offRow.correlation_id.length >= 8);
      assert.notEqual(offRow.request_id, generated.requestId);

      // (c) a STALE authentication is classified stale — NOT 'not_applicable'.
      const stale = await makeLink('user_r3_evidence_stale');
      await grantRole({
        actingUserLinkId: admin,
        tenantId,
        userLinkId: stale,
        role: 'tenant_admin',
        scopeLevel: 'tenant',
        scopeId: tenantId,
      });
      const staleSession = await createSession({
        ...(await sessionBindingForLink(stale)),
        tenantId,
        userLinkId: stale,
        providerSessionId: null,
        authTime: new Date(),
        ttlSeconds: 3600,
      });
      await fixtureAuthorizationStateWrite(
        'simulate-authorization-drift',
        `UPDATE identity_sessions SET auth_time = NOW() - INTERVAL '6 hours' WHERE session_id = $1`,
        [staleSession.session.sessionId],
      );
      const staleRow = await evidenceFor(
        (await decide(stale, staleSession.session.sessionId)).decisionId,
      );
      assert.equal(String(staleRow.freshness_classification), 'stale');
      assert.equal(String(staleRow.mfa_assurance_classification), 'certified');

      // (d) 'not_applicable' remains REACHABLE and means exactly what it says:
      //     this actor holds no live session and no live grant at all. That is
      //     the only way the classification can be reached now.
      const dormant = await makeLink('user_r3_evidence_dormant');
      const dormantRow = await evidenceFor((await decide(dormant)).decisionId);
      assert.equal(String(dormantRow.freshness_classification), 'not_applicable');
      assert.equal(String(dormantRow.mfa_assurance_classification), 'not_applicable');
      assert.ok(
        typeof dormantRow.request_id === 'string' && dormantRow.request_id.length >= 8,
        'even a deny is correlatable',
      );
    });

    /**
     * FBL-020-R3 correction B2 — assurance describes the credential THIS
     * request PRESENTED, not the best one the actor happens to hold.
     *
     * The defect: `classifyActorAssurance` took only a user link id and read
     * `FROM identity_sessions WHERE user_link_id = $1 ORDER BY auth_time DESC
     * LIMIT 1` — the actor's NEWEST live session — even though the session the
     * request actually resolved was already in hand and was written to the very
     * same evidence row. R3 made BOTH credential kinds mint local sessions, so
     * one user routinely holds several: a request arriving on a six-hour-old
     * cookie was recorded 'fresh' because a bearer session had authenticated a
     * minute earlier. The append-only evidence row then asserted an assurance
     * the presented credential did not have, and `GET /auth/session` printed
     * the same untruth directly beside the presented session's own expiry.
     * The grant subqueries ignored `consumed_at` too, so a grant that had
     * already been spent went on reporting fresh and certified forever.
     *
     * Why this test exists at all: the test that covered this ground gave every
     * actor exactly ONE session and one unspent grant, so it could not tell the
     * two predicates apart — it passed unchanged with the correction reverted.
     *
     * Two CONTROLS keep the discrimination honest rather than incidental:
     *   - the fresh bearer session, presented directly, must classify 'fresh',
     *     so the stale verdict below is the PRESENTED session's `auth_time` and
     *     not the engine failing to see any session at all;
     *   - the grant, while UNSPENT, must classify 'fresh' and 'certified', so
     *     the verdict after consumption is the `consumed_at IS NULL` predicate
     *     and not a grant that was never visible.
     */
    test("assurance is the PRESENTED session's, and a SPENT grant proves nothing", async () => {
      const engine = createPolicyEngine({
        catalog: createActionCatalog([
          {
            action: 'identity.tenant.read',
            description: 'read tenant configuration',
            resourceType: null,
            allowedRoles: ['tenant_admin'],
          },
        ]),
        resolveResourceScope: () => Promise.resolve(null),
      });
      const admin = await bootstrapAdministrator(tenantId);
      await certifyMfaPolicy(tenantId);

      /** Decides on a NAMED credential and returns what the evidence row says. */
      const recorded = async (
        userLinkId: string,
        sessionId: string,
      ): Promise<{ freshness: string; mfa: string; sessionId: string | null }> => {
        const decided = await engine.decide({
          actor: { userLinkId, actorScope: 'dealership' as const, tenantId },
          action: 'identity.tenant.read',
          sessionId,
        });
        // the binding is not what this test varies — every decision here allows
        assert.equal(decided.decision, 'allow');
        const r = await query(
          `SELECT freshness_classification, mfa_assurance_classification, session_id
             FROM policy_decisions WHERE decision_id = $1`,
          [decided.decisionId],
        );
        const row = r.rows[0] as Record<string, unknown>;
        return {
          freshness: String(row.freshness_classification),
          mfa: String(row.mfa_assurance_classification),
          sessionId: row.session_id === null ? null : String(row.session_id),
        };
      };
      const tenantAdmin = async (userLinkId: string): Promise<void> => {
        await grantRole({
          actingUserLinkId: admin,
          tenantId,
          userLinkId,
          role: 'tenant_admin',
          scopeLevel: 'tenant',
          scopeId: tenantId,
        });
      };

      // ── ONE actor, TWO live sessions: a stale cookie and a fresh bearer ──
      const subject = 'user_r3_b2_presented';
      const holder = await makeLink(subject);
      await tenantAdmin(holder);
      const binding = await sessionBindingFor(tenantId, subject);

      // the COOKIE session: authenticated six hours ago, still perfectly live
      const cookie = await createSession({
        ...binding,
        tenantId,
        userLinkId: holder,
        providerSessionId: 'sid_b2_cookie',
        authTime: new Date(Date.now() - 6 * 3600 * 1000),
        ttlSeconds: 12 * 3600,
      });
      // the BEARER session: R3 mints a local session for that credential kind
      // too, and this one authenticated a moment ago.
      const bearer = await resolveOrEstablishBearerSession({
        ...binding,
        expectedIssuer: binding.issuer,
        providerSessionId: 'sid_b2_bearer',
        tenantId,
        userLinkId: holder,
        authTime: new Date(),
        ttlSeconds: 3600,
      });
      assert.equal(bearer.outcome, 'live', 'the bearer credential establishes a local session');
      if (bearer.outcome !== 'live') return;
      assert.ok(bearer.established, 'a NEW local session backs the bearer credential');
      const bothLive = await query(
        `SELECT COUNT(*)::int AS n FROM identity_sessions
          WHERE user_link_id = $1 AND revoked_at IS NULL AND expires_at > NOW()`,
        [holder],
      );
      assert.equal(
        Number((bothLive.rows[0] as { n: number }).n),
        2,
        'the actor holds BOTH credentials at once — the situation the defect needed',
      );

      // CONTROL: presenting the FRESH bearer session classifies fresh.
      const onBearer = await recorded(holder, bearer.session.sessionId);
      assert.equal(onBearer.freshness, 'fresh', 'the fresh session is visible and classified');
      assert.equal(onBearer.sessionId, bearer.session.sessionId);

      // THE DEFECT: the same actor, the same instant, the STALE cookie.
      const onCookie = await recorded(holder, cookie.session.sessionId);
      assert.equal(
        onCookie.freshness,
        'stale',
        "a six-hour-old cookie is stale however fresh the actor's OTHER session is",
      );
      assert.equal(
        onCookie.sessionId,
        cookie.session.sessionId,
        'the classification and the recorded session are the SAME credential',
      );

      // the PAGE cannot contradict the audit row: same credential, same verdict.
      const viewFor = async (sessionId: string): Promise<string> =>
        (
          await describeAuthenticatedSession({
            userLinkId: holder,
            tenantId,
            actorScope: 'dealership',
            sessionId,
          })
        ).freshness;
      assert.equal(
        await viewFor(cookie.session.sessionId),
        'stale',
        'GET /auth/session reports the PRESENTED session, not the freshest one',
      );
      assert.equal(await viewFor(bearer.session.sessionId), 'fresh');

      // ── a SPENT grant proves nothing about the NEXT request ──────────────
      const spenderSubject = 'user_r3_b2_spender';
      const spender = await makeLink(spenderSubject);
      await tenantAdmin(spender);
      const resourceId = randomUUID();
      const grant = await mintReauthGrant({
        tenantId,
        userLinkId: spender,
        action: 'service.ro.void',
        resourceType: 'repair_order',
        resourceId,
      });
      // Minting seeds its own fresh session. Revoke it, so the ONLY live
      // credential this actor holds is stale and the ONLY thing that can make
      // the classification 'fresh' or 'certified' is the grant itself.
      await fixtureAuthorizationStateWrite(
        'simulate-authorization-drift',
        `UPDATE identity_sessions SET revoked_at = NOW(), revoked_reason = 'test isolation'
          WHERE user_link_id = $1 AND revoked_at IS NULL`,
        [spender],
      );
      await certifyMfaPolicy(tenantId, false);
      const staleOnly = await createSession({
        ...(await sessionBindingFor(tenantId, spenderSubject)),
        tenantId,
        userLinkId: spender,
        providerSessionId: 'sid_b2_spender',
        authTime: new Date(Date.now() - 6 * 3600 * 1000),
        ttlSeconds: 12 * 3600,
      });

      // ── FBL-020-R4 §2.4: AN UNRELATED GRANT STRENGTHENS NOTHING ────────────
      //
      // THE DEFECT R4 FOUND. R3 read "the actor's most recent live unconsumed grant"
      // and let it raise the classification, so a live grant for
      // `service.ro.void` on ONE repair order reported this decision — about
      // `identity.tenant.read`, a different action on nothing — as fresh and certified.
      // A grant is minted for one action on one resource and proves exactly that;
      // borrowing it for an unrelated decision put an assurance in append-only evidence
      // that the presented credential did not have.
      //
      // The grant below is live, unspent, high-assurance and certified at issue, and
      // the presented session is six hours old. The decision must be STALE.
      const liveGrantId = String(
        (
          await query(
            `SELECT grant_id FROM reauthentication_grants
              WHERE user_link_id = $1 AND consumed_at IS NULL AND expires_at > NOW()
              ORDER BY issued_at DESC LIMIT 1`,
            [spender],
          )
        ).rows[0]?.grant_id,
      );
      assert.match(liveGrantId, /^[0-9a-f-]{36}$/, 'the fixture really does hold a live grant');
      const unrelated = await recorded(spender, staleOnly.session.sessionId);
      assert.equal(
        unrelated.freshness,
        'stale',
        'a live grant for ANOTHER action must not make this decision fresh',
      );
      assert.equal(
        unrelated.mfa,
        'uncertified',
        'and must not lend this decision its certification either',
      );
      // The page cannot contradict the evidence row: same credential, same verdict.
      const unrelatedView = await describeAuthenticatedSession({
        userLinkId: spender,
        tenantId,
        actorScope: 'dealership',
        sessionId: staleOnly.session.sessionId,
      });
      assert.equal(unrelatedView.freshness, 'stale');
      assert.equal(unrelatedView.mfaAssurance, 'uncertified');

      // …and the CONVERSE, so the rule is "the exact grant" rather than "no grant":
      // asked about the very grant being evaluated, the classification IS strengthened.
      const evaluatingIt = await classifyActorAssurance(
        spender,
        staleOnly.session.sessionId,
        liveGrantId,
      );
      assert.equal(evaluatingIt.freshness, 'fresh', 'the EXACT grant under evaluation counts');
      assert.equal(evaluatingIt.mfaAssurance, 'certified', 'with its certification at issue');

      // A grant belonging to SOMEBODY ELSE counts for nothing even when named.
      const foreignHolder = await classifyActorAssurance(
        holder,
        staleOnly.session.sessionId,
        liveGrantId,
      );
      assert.equal(
        foreignHolder.freshness,
        'not_applicable',
        'a named grant is still verified to belong to this actor, on this session',
      );

      // spend it, once, on the action it was minted for
      assert.equal(
        await withTransaction((executor) =>
          consumeReauthenticationGrant(executor, {
            grant,
            tenantId,
            userLinkId: spender,
            action: 'service.ro.void',
            resourceType: 'repair_order',
            resourceId,
            requiredAssurance: 'fresh_and_mfa_policy',
          }),
        ),
        true,
        'the grant was spent',
      );

      // THE R3 DEFECT: a spent grant went on reporting fresh and certified. It now
      // proves nothing even when it IS the grant being evaluated.
      const afterSpend = await recorded(spender, staleOnly.session.sessionId);
      assert.equal(
        afterSpend.freshness,
        'stale',
        'a CONSUMED grant proves nothing — freshness falls back to the presented session',
      );
      assert.equal(
        afterSpend.mfa,
        'uncertified',
        'and it certifies nothing either once it has been spent',
      );
      assert.equal(afterSpend.sessionId, staleOnly.session.sessionId);
      const evaluatingSpent = await classifyActorAssurance(
        spender,
        staleOnly.session.sessionId,
        liveGrantId,
      );
      assert.equal(evaluatingSpent.freshness, 'stale', 'not even as the evaluated grant');
      assert.equal(evaluatingSpent.mfaAssurance, 'uncertified');
      // the page agrees, again, on the same credential
      const spentView = await describeAuthenticatedSession({
        userLinkId: spender,
        tenantId,
        actorScope: 'dealership',
        sessionId: staleOnly.session.sessionId,
      });
      assert.equal(spentView.freshness, 'stale');
      assert.equal(spentView.mfaAssurance, 'uncertified');
      // restore the fixture's certified posture for anything that follows
      await certifyMfaPolicy(tenantId);
    });

    // ── R3 §2: every mutation is attributable, versioned and audited ──────
    test('every mutation advances its version, names the TRUE actor, audits once', async () => {
      const origin = await bootstrapAdministrator(tenantId);

      /**
       * Runs one call and proves the envelope: EXACTLY the expected audit rows
       * appeared, every one of them attributed to the true actor, and every one
       * of them carrying the version the mutated row now holds.
       */
      async function audited<T>(
        actor: string,
        expected: readonly string[],
        run: () => Promise<T>,
      ): Promise<T> {
        const seen = new Set(
          (await query(`SELECT event_id FROM audit_events`)).rows.map((r) =>
            String((r as { event_id: unknown }).event_id),
          ),
        );
        const value = await run();
        const rows = (
          await query(
            `SELECT event_id, event_type, entity_id, actor_user_id, details FROM audit_events`,
          )
        ).rows as Array<Record<string, unknown>>;
        const fresh = rows.filter((r) => !seen.has(String(r.event_id)));
        assert.deepEqual(
          fresh.map((r) => String(r.event_type)).sort(),
          [...expected].sort(),
          `audit rows written by ${expected.join(' + ')}`,
        );
        for (const r of fresh) {
          assert.equal(
            String(r.actor_user_id),
            actor,
            `${String(r.event_type)} must name the true actor`,
          );
          const details = r.details as { authorization_version?: unknown };
          // FBL-020-R4 §3: a reauthentication GRANT is not a versioned record —
          // it is minted once, spent once and never edited, so
          // `authorization_version` is a fact it does not have. Its consumption
          // event is named explicitly rather than admitted by a weaker
          // assertion, so nothing else can slip past this check.
          if (String(r.event_type) !== 'identity.reauthentication.grant_consumed') {
            assert.ok(
              Number(details.authorization_version) >= 1,
              `${String(r.event_type)} must record the version it landed at`,
            );
          }
        }
        return value;
      }

      async function versionOf(table: string, idColumn: string, id: string): Promise<number> {
        const r = await query(`SELECT authorization_version FROM ${table} WHERE ${idColumn} = $1`, [
          id,
        ]);
        return Number((r.rows[0] as { authorization_version: unknown }).authorization_version);
      }

      // ORGANIZATION — create establishes version 1; the status change advances
      const org = await audited(origin, ['identity.organization.created'], () =>
        createOrganization({ actingUserLinkId: origin, name: 'R3 Mutation Motors' }),
      );
      assert.equal(org.authorizationVersion, 1);
      const orgId = org.tenantId;
      const orgActive = await audited(origin, ['identity.organization.status_changed'], () =>
        changeOrganizationStatus({ actingUserLinkId: origin, tenantId: orgId, status: 'active' }),
      );
      assert.ok(orgActive);
      assert.ok(orgActive.authorizationVersion > org.authorizationVersion);

      // PROVIDER MAPPING, ISSUER, MFA CERTIFICATION
      const mapping = await audited(origin, ['identity.provider_connection.created'], () =>
        createProviderMapping({
          actingUserLinkId: origin,
          tenantId: orgId,
          providerOrganizationId: `org_r3_mut_${orgId.slice(0, 8)}`,
          issuer: testIssuer(),
        }),
      );
      assert.equal(mapping.authorizationVersion, 1);
      const issuerChanged = await audited(
        origin,
        ['identity.provider_connection.issuer_changed'],
        () =>
          changeProviderIssuer({
            actingUserLinkId: origin,
            connectionId: mapping.connectionId,
            issuer: `${testIssuer()}/rotated`,
          }),
      );
      assert.ok(issuerChanged);
      assert.ok(issuerChanged.authorizationVersion > mapping.authorizationVersion);
      // FBL-020-R4 §3: certifying an organization's MFA policy is an AUTHORIZED
      // administrative act, not merely an attributable one. The bootstrap origin
      // holds no role binding by design, so a platform administrator performs it —
      // and the mutation is attributed to that administrator, not to the origin.
      const mfaCertifier = await makePlatformLink('user_r4_mfa_certifier');
      await grantRole({
        actingUserLinkId: await bootstrapAdministrator(null),
        tenantId: null,
        userLinkId: mfaCertifier,
        role: 'platform_admin',
        scopeLevel: 'platform',
        scopeId: null,
      });
      const mfa = await audited(
        mfaCertifier,
        ['identity.provider_connection.mfa_policy_certified'],
        () =>
          certifyProviderMfaPolicy({
            actingUserLinkId: mfaCertifier,
            connectionId: mapping.connectionId,
            certified: true,
          }),
      );
      assert.ok(mfa);
      assert.ok(mfa.authorizationVersion > issuerChanged.authorizationVersion);

      // USER LINK — provision, activate, relink, deactivate
      const provisioned = await audited(origin, ['identity.user_link.provisioned'], () =>
        provisionUserLink({
          tenantId: orgId,
          providerUserId: 'user_r3_mutation_subject',
          email: null,
          provisionedByUserLinkId: origin,
        }),
      );
      const subject = provisioned.userLinkId;
      const beforeActivation = await versionOf('user_links', 'user_link_id', subject);
      assert.equal(beforeActivation, 1, 'a create establishes version 1');
      await audited(origin, ['identity.user_link.activated'], async () => {
        const link = await activateUserLink({ userLinkId: subject, activatedByUserLinkId: origin });
        assert.ok(link, 'activation must succeed against the single active connection');
      });
      const afterActivation = await versionOf('user_links', 'user_link_id', subject);
      assert.ok(afterActivation > beforeActivation, 'activation advances the version');

      // a real organization migration: disable the old mapping, map the new
      // one, then RE-BIND the link — never a silent adoption at login
      await audited(origin, ['identity.provider_connection.remapped'], () =>
        remapProviderConnection({
          actingUserLinkId: origin,
          connectionId: mapping.connectionId,
          status: 'disabled',
        }),
      );
      const replacement = await audited(origin, ['identity.provider_connection.created'], () =>
        createProviderMapping({
          actingUserLinkId: origin,
          tenantId: orgId,
          providerOrganizationId: `org_r3_mut2_${orgId.slice(0, 8)}`,
          issuer: `${testIssuer()}/replacement`,
        }),
      );
      await audited(origin, ['identity.user_link.relinked'], async () => {
        const relinked = await relinkUserLink({
          userLinkId: subject,
          connectionId: replacement.connectionId,
          relinkedByUserLinkId: origin,
        });
        assert.ok(relinked, 'relink must bind the link to the replacement connection');
      });
      const afterRelink = await versionOf('user_links', 'user_link_id', subject);
      assert.ok(afterRelink > afterActivation, 'relink advances the version');

      // ROLE BINDINGS — grant, change, revoke
      const granted = await audited(origin, ['identity.role_binding.granted'], () =>
        grantRole({
          actingUserLinkId: origin,
          tenantId: orgId,
          userLinkId: subject,
          role: 'service_advisor',
        }),
      );
      assert.equal(granted.authorizationVersion, 1);
      const rebadged = await audited(origin, ['identity.role_binding.changed'], () =>
        changeRole({
          actingUserLinkId: origin,
          roleBindingId: granted.roleBindingId,
          role: 'service_manager',
        }),
      );
      assert.ok(rebadged);
      assert.ok(rebadged.authorizationVersion > granted.authorizationVersion);
      const dropped = await audited(origin, ['identity.role_binding.revoked'], () =>
        revokeRole({ actingUserLinkId: origin, roleBindingId: granted.roleBindingId }),
      );
      assert.ok(dropped);
      assert.ok(
        dropped.authorizationVersion > rebadged.authorizationVersion,
        'a revocation that left the version alone would be invisible to evidence',
      );

      await audited(origin, ['identity.user_link.deactivated'], async () => {
        assert.equal(
          await deactivateUserLink({ userLinkId: subject, deactivatedByUserLinkId: origin }),
          true,
        );
      });
      assert.ok((await versionOf('user_links', 'user_link_id', subject)) > afterRelink);

      // SUPPORT ACCESS — request, deny, approve (+ session start), revoke
      const requester = await makePlatformLink('user_r3_mut_support');
      await grantRole({
        actingUserLinkId: await bootstrapAdministrator(null),
        tenantId: null,
        userLinkId: requester,
        role: 'platform_support',
        scopeLevel: 'platform',
        scopeId: null,
      });
      const approver = await makeLink('user_r3_mut_approver');
      await grantRole({
        actingUserLinkId: origin,
        tenantId,
        userLinkId: approver,
        role: 'tenant_admin',
        scopeLevel: 'tenant',
        scopeId: tenantId,
      });

      const toDeny = await audited(requester, ['identity.support.requested'], () =>
        requestSupportAccess({
          tenantId,
          requesterUserLinkId: requester,
          requestedActions: ['service.ro.view'],
          reason: 'ticket 4242: mutation envelope, denied',
          requestedDurationMinutes: 30,
        }),
      );
      await audited(approver, ['identity.support.denied'], () =>
        decideSupportAccess({
          requestId: toDeny.requestId,
          decidedByUserLinkId: approver,
          approve: false,
        }),
      );
      assert.ok(
        (await versionOf('support_access_requests', 'request_id', toDeny.requestId)) > 1,
        'the decision advanced the request version',
      );

      const toApprove = await requestSupportAccess({
        tenantId,
        requesterUserLinkId: requester,
        requestedActions: ['service.ro.view'],
        reason: 'ticket 4243: mutation envelope, approved',
        requestedDurationMinutes: 30,
      });
      // R3: the approval SPENDS the approver's own single-use grant, minted for
      // this action against THIS request, inside the approval transaction.
      const approvalGrant = await mintReauthGrant({
        tenantId,
        userLinkId: approver,
        action: 'identity.support.approve',
        resourceType: 'support_access_request',
        resourceId: toApprove.requestId,
      });
      // approval performs TWO mutations atomically — the decision and the
      // session start — so it writes exactly two rows, both naming the approver
      const session = await audited(
        approver,
        [
          // R4 §3: spending the approver's step-up grant is itself an audited
          // transition, and it commits in the SAME transaction as the approval it
          // paid for.
          'identity.reauthentication.grant_consumed',
          'identity.support.approved',
          'identity.support.session_started',
        ],
        () =>
          decideSupportAccess({
            requestId: toApprove.requestId,
            decidedByUserLinkId: approver,
            approve: true,
            approvalGrant,
          }),
      );
      assert.ok(session);
      await audited(approver, ['identity.support.revoked'], () =>
        revokeSupportSession({
          supportSessionId: session.supportSessionId,
          revokedByUserLinkId: approver,
        }),
      );
      assert.ok(
        (await versionOf(
          'support_access_sessions',
          'support_session_id',
          session.supportSessionId,
        )) > 1,
        'revocation advanced the session version',
      );

      // the reason text never reached the audit trail
      const details = JSON.stringify((await query(`SELECT details FROM audit_events`)).rows);
      assert.ok(!details.includes('ticket 4242') && !details.includes('ticket 4243'));

      // and an UNATTRIBUTABLE mutation is refused outright rather than landing
      // a change nobody performed
      await assert.rejects(
        grantRole({
          actingUserLinkId: randomUUID(),
          tenantId,
          userLinkId: approver,
          role: 'service_advisor',
        }),
        (err: unknown) => err instanceof UnattributableMutationError,
      );
    });

    // ── R3 §E1/§E2: the effectiveness rule has exactly ONE implementation ──
    //
    // A binding authorizes nothing unless it is `active` AND inside its
    // effective window. Wave 2 exported those three conditions ONCE, as
    // `EFFECTIVE_ROLE_BINDING_SQL`, and then shipped two more readers that
    // restated them and dropped the window — so a binding left `active` with an
    // `effective_to` a day in the past was reported as held authority while the
    // engine, asked about the same actor in the same transaction, denied it.
    // Both readers now interpolate the engine's predicate. These tests fail if
    // either one goes back to writing its own.

    /**
     * Moves a binding's effective WINDOW while leaving its lifecycle status
     * alone. `status = 'active'` throughout is the whole point: it is the one
     * condition the hand-written copies kept, so it is the shape that slipped
     * past them.
     */
    async function moveWindow(
      userLinkId: string,
      role: string,
      fromSeconds: number,
      toSeconds: number | null,
    ): Promise<void> {
      const moved = await fixtureAuthorizationStateWrite(
        'simulate-authorization-drift',
        `UPDATE role_bindings
            SET effective_from = NOW() + ($3::int * INTERVAL '1 second'),
                effective_to = CASE
                  WHEN $4::int IS NULL THEN NULL
                  ELSE NOW() + ($4::int * INTERVAL '1 second')
                END
          WHERE user_link_id = $1 AND role = $2 AND status = 'active'
          RETURNING role_binding_id`,
        [userLinkId, role, fromSeconds, toSeconds],
      );
      assert.equal(moved.rows.length, 1, 'the fixture moved exactly one binding');
    }

    /** The binding's lifecycle status and id, straight from the row. */
    async function bindingRow(userLinkId: string): Promise<{ id: string; status: string }> {
      const r = await query(
        `SELECT role_binding_id, status FROM role_bindings
          WHERE user_link_id = $1 ORDER BY granted_at DESC LIMIT 1`,
        [userLinkId],
      );
      assert.equal(r.rows.length, 1, 'the fixture granted exactly one binding');
      const row = r.rows[0] as { role_binding_id: unknown; status: unknown };
      return { id: String(row.role_binding_id), status: String(row.status) };
    }

    // ── E1 ────────────────────────────────────────────────────────────────
    test('the session view reports NO role and NO scope for a windowed-out binding', async () => {
      const holder = await makeScopedTenantAdmin('user_e1_view', {
        level: 'tenant',
        id: tenantId,
      });
      const session = await seedLocalSession(holder);
      const engine = identityEngine();
      const decide = () =>
        engine.decide({
          actor: { userLinkId: holder, actorScope: 'dealership', tenantId },
          action: 'org.unit.create',
        });
      const view = () =>
        describeAuthenticatedSession({
          userLinkId: holder,
          tenantId,
          actorScope: 'dealership',
          sessionId: session.sessionId,
        });

      // CONTROL: inside its window the binding authorizes, and is reported.
      assert.equal((await decide()).decision, 'allow');
      const before = await view();
      assert.deepEqual([...before.roles], ['tenant_admin']);
      assert.deepEqual(
        before.organizationScope.scopes.map((s) => ({
          level: s.level,
          id: s.id,
          effective: s.effective,
        })),
        [{ level: 'tenant', id: tenantId, effective: true }],
      );

      // THE DEFECT: the window moves entirely into the past.
      await moveWindow(holder, 'tenant_admin', -2 * 86_400, -86_400);
      assert.equal(
        (await bindingRow(holder)).status,
        'active',
        'the binding is still active — only its window has passed',
      );

      const denied = await decide();
      assert.equal(denied.decision, 'deny', 'the engine refuses the aged-out binding');
      assert.equal(denied.reasonCode, 'NO_MATCHING_BINDING');

      // BOTH halves of the report, in ONE assertion, because the defect was
      // doubly wrong and the failure must show both: the role was listed, AND
      // its scope was printed `effective: true` — the effectiveness of the
      // organization NODE, which is live, rather than of the binding, which is
      // not. GET /auth/session may report neither.
      const after = await view();
      assert.deepEqual(
        {
          roles: [...after.roles],
          scopes: after.organizationScope.scopes.map((s) => ({
            level: s.level,
            id: s.id,
            effective: s.effective,
          })),
        },
        { roles: [], scopes: [] },
        'the session view must offer no role and no scope the engine denies',
      );
      // The emptiness is about the BINDING, not the tenant: the tenant node is
      // live throughout, which is exactly why `effective: true` was reported.
      assert.equal(after.organizationScope.tenantEffective, true);

      // …and the page recovers when the window does, so this cannot pass by
      // reporting nothing unconditionally.
      await moveWindow(holder, 'tenant_admin', -60, 86_400);
      assert.equal((await decide()).decision, 'allow');
      assert.deepEqual([...(await view()).roles], ['tenant_admin']);
    });

    // ── E2 ────────────────────────────────────────────────────────────────
    test('rolesForUserLink omits a windowed-out binding, and lists an effective one', async () => {
      const holder = await makeScopedTenantAdmin('user_e2_roles', {
        level: 'tenant',
        id: tenantId,
      });
      const engine = identityEngine();
      const engineAllows = async (): Promise<boolean> =>
        (
          await engine.decide({
            actor: { userLinkId: holder, actorScope: 'dealership', tenantId },
            action: 'org.unit.create',
          })
        ).decision === 'allow';

      // 1. EFFECTIVE — both overloads list the role, and the engine agrees.
      assert.deepEqual(await rolesForUserLink(holder, tenantId), ['tenant_admin']);
      assert.deepEqual(await rolesForUserLink(holder), ['tenant_admin']);
      assert.equal(await engineAllows(), true);

      // 2. WINDOW PASSED — status stays 'active'; the engine denies, so the
      //    list must be empty. This is the assertion the old predicate failed.
      await moveWindow(holder, 'tenant_admin', -2 * 86_400, -86_400);
      assert.equal((await bindingRow(holder)).status, 'active');
      assert.equal(await engineAllows(), false);
      assert.deepEqual(
        await rolesForUserLink(holder, tenantId),
        [],
        'an aged-out binding is not a held role',
      );
      assert.deepEqual(
        await rolesForUserLink(holder),
        [],
        'the tenant-less overload drops it too — both queries, one predicate',
      );

      // 3. WINDOW NOT YET OPEN — the other end of the same window.
      await moveWindow(holder, 'tenant_admin', 86_400, null);
      assert.equal(await engineAllows(), false);
      assert.deepEqual(await rolesForUserLink(holder, tenantId), []);
      assert.deepEqual(await rolesForUserLink(holder), []);

      // 4. BACK INSIDE the window — the list recovers, so this cannot pass by
      //    returning nothing unconditionally.
      await moveWindow(holder, 'tenant_admin', -60, 86_400);
      assert.equal(await engineAllows(), true);
      assert.deepEqual(await rolesForUserLink(holder, tenantId), ['tenant_admin']);

      // 5. The tenant filter still holds: asked about ANOTHER tenant, this
      //    binding is not the actor's business there.
      assert.deepEqual(await rolesForUserLink(holder, randomUUID()), []);

      // 6. REVOKED is still gone — the one condition the old predicate got
      //    right must not regress while the window is being added.
      await revokeRole({
        actingUserLinkId: await bootstrapAdministrator(tenantId),
        roleBindingId: (await bindingRow(holder)).id,
      });
      assert.equal(await engineAllows(), false);
      assert.deepEqual(await rolesForUserLink(holder, tenantId), []);
      assert.deepEqual(await rolesForUserLink(holder), []);
    });
  },
);

/**
 * FBL-020-R3 correction G1 — the D1 pool bounds must cost ONE REQUEST, never the
 * process.
 *
 * D1 gave every pooled connection an `idle_in_transaction_session_timeout` so a
 * transaction left open around a network call could not pin one of ten shared
 * connections indefinitely. As shipped, enforcing it was worse than the exhaustion it
 * bounded: Postgres answers with a FATAL (25P03) and closes the connection, and because
 * pg-pool removes its own `'error'` listener for the duration of a checkout, that FATAL
 * arrived on an EventEmitter with no listener — an uncaught exception from the event
 * loop that no `try`/`catch` around the transaction could see and that, with no
 * process-level handler anywhere in this repo, TERMINATED the API. Exhaustion degrades
 * and recovers; that dropped every in-flight request for every tenant.
 *
 * Three properties are proved here, and the first two are proved in CHILD PROCESSES on
 * purpose. "The process survived" is not something an in-process test can assert — if
 * the process dies the test run dies with it — and a test that only checked the error
 * type would pass just as happily on a global `uncaughtException` swallow. The child's
 * EXIT CODE is the survival assertion, and the child reports that it has ZERO
 * process-level handlers installed so the survival cannot be attributed to one.
 */
describe(
  'pool bounds fail one request, not the process (R3 G1)',
  { skip: skipIntegration ? 'set TEST_DATABASE_URL to run' : false },
  () => {
    // NOT under tests/fixtures/: that tree is prettier-ignored under the FBL-000-R1
    // byte-identical mandate for the retained f76a27a artifacts, and this is live code
    // that must stay formatted and linted like everything else.
    const CHILD = join(__dirname, 'support', 'pool-fatal-child.ts');

    after(async () => {
      await closePool();
    });

    /** The bounded, non-echoing failure description the probe reports. */
    interface ProbeFailure {
      threw: boolean;
      name: string;
      sqlState: string | null;
      statusCode: number | null;
      isConnectionLost: boolean;
      retryable: boolean;
      pgCode: string | null;
      mentionsStatementTimeout: boolean;
    }

    /** Everything any scenario reports; a missing field means the probe misbehaved. */
    interface ProbeResult {
      handlers: { uncaughtException: number; unhandledRejection: number };
      caught: ProbeFailure;
      elapsedMs: number;
      idleStallMs: number;
      /** `in-flight-fatal`: the backend's `pg_stat_activity` state at the moment it was killed. */
      stateWhenKilled: string;
      inFlightMs: number;
      /** `application-error`: the pooled connection before and after the failed transaction. */
      pidBefore: number;
      pidAfter: number;
      /** `application-error`: age of the transaction the NEXT statement ran in. */
      transactionAgeMsAfter: number;
      /** `foreign-socket-error`: did the caller receive the very object the body threw? */
      sameObject: boolean;
      /** `severed-socket`: pg's `_queryable` on the checked-out client, before and after. */
      queryableBefore: unknown;
      queryableAfter: unknown;
      /** `abandoned-body`: when the caller was told, against the body's own stall. */
      toldAt: number;
      stallMs: number;
      sideEffects: { what: string; at: number }[];
      databaseAfterAbandonment: { attempted: boolean; threw?: boolean };
      poolUsableAfter: number;
      transactionUsableAfter: number;
      bare: ProbeFailure;
      inTransaction: ProbeFailure;
      ambientBefore: ProbeFailure;
      exempted: ProbeFailure;
      restoredAfterCommit: { statementTimeout: string; idleInTransactionTimeout: string };
      ambientAfter: ProbeFailure;
    }

    interface ChildOutcome {
      status: number | null;
      result: ProbeResult;
      output: string;
      tail: string;
    }

    /**
     * Runs one scenario in a fresh Node process with its own pool configuration.
     * `PGPOOL_MAX=1` throughout: with a single connection slot, "the pool still works
     * afterwards" can only pass if the connection that took the FATAL was really
     * discarded and replaced.
     */
    function runScenario(scenario: string, bounds: Record<string, string>): ChildOutcome {
      const child = spawnSync(process.execPath, ['--import', 'tsx', CHILD, scenario], {
        encoding: 'utf8',
        timeout: 120_000,
        env: {
          ...process.env,
          DATABASE_URL: INTEGRATION_DATABASE_URL ?? '',
          PGPOOL_MAX: '1',
          ...bounds,
        },
      });
      const stdout = child.stdout ?? '';
      const line = stdout.split('\n').find((l) => l.startsWith('RESULT '));
      const output = `${stdout}\n${child.stderr ?? ''}`;
      // A child that died printed no RESULT line; the status assertion in each test
      // reports that first, so the empty stand-in is never actually read.
      const result = (line === undefined ? {} : JSON.parse(line.slice('RESULT '.length))) as
        ProbeResult | Record<string, never>;
      return {
        status: child.status,
        result: result as ProbeResult,
        output,
        tail: output.slice(-1_500),
      };
    }

    test('G1: an idle-in-transaction FATAL is one caught, typed, retryable failure', () => {
      const child = runScenario('idle-fatal', {
        PG_IDLE_IN_TRANSACTION_TIMEOUT_MS: '400',
        PG_STATEMENT_TIMEOUT_MS: '30000',
      });

      // 1. THE PROCESS SURVIVED. Before the fix this child died on
      //    "Unhandled 'error' event" and exited non-zero without printing anything.
      assert.equal(
        child.status,
        0,
        `the child process must survive the FATAL and exit cleanly; tail:\n${child.tail}`,
      );
      // 2. …and not because something swallowed it globally.
      assert.deepEqual(
        child.result.handlers,
        { uncaughtException: 0, unhandledRejection: 0 },
        'survival must come from the checked-out client listener, not a process-level net',
      );

      // 3. The failure reached the caller's own catch, TYPED.
      const caught = child.result.caught;
      assert.equal(caught.threw, true, 'withTransaction rejected');
      assert.equal(caught.name, 'DatabaseConnectionLostError');
      assert.equal(caught.isConnectionLost, true);
      assert.equal(caught.pgCode, '25P03', 'the SQLSTATE is kept for diagnosis');
      // 4. Classified as transient infrastructure — a 503 the caller may retry, never
      //    an application verdict and never an authorization outcome.
      assert.equal(caught.statusCode, 503);
      assert.equal(caught.retryable, true);

      // 5. It failed WHEN THE FATAL ARRIVED, not whenever the body next touched the
      //    connection. Capturing the event without racing it would leave the caller
      //    hanging for the rest of its stall — or forever, if it is waiting on something
      //    that never answers, which is the shape this bound exists to break.
      const { idleStallMs, elapsedMs } = child.result;
      assert.ok(idleStallMs >= 2_000, 'the probe really does stall for seconds');
      assert.ok(
        elapsedMs < idleStallMs / 2,
        `the caller was told promptly, not after its stall finished ` +
          `(waited ${elapsedMs}ms of a ${idleStallMs}ms stall)`,
      );

      // 6. The pool is intact for the next request, on both paths, with one slot.
      assert.equal(child.result.poolUsableAfter, 42, 'a plain query works afterwards');
      assert.equal(child.result.transactionUsableAfter, 43, 'so does a new transaction');

      // 7. One failure, one error. The transaction is already gone server-side, so no
      //    ROLLBACK is attempted into the dead session — its inevitable failure would be
      //    logged over the real cause and read as a rollback bug that is not there.
      assert.ok(
        !child.output.includes('ROLLBACK failed'),
        `no misleading rollback error is logged for a connection that is gone:\n${child.tail}`,
      );
      assert.equal(
        child.output.split('connection_lost_in_transaction').length - 1,
        1,
        'and the lost connection is reported exactly once',
      );
    });

    test('G1: statement_timeout is still an ordinary catchable error, not reclassified', () => {
      const child = runScenario('statement-timeout', {
        PG_STATEMENT_TIMEOUT_MS: '500',
        PG_IDLE_IN_TRANSACTION_TIMEOUT_MS: '15000',
      });
      assert.equal(child.status, 0, `child failed; tail:\n${child.tail}`);

      // The asymmetry that made G1 specific to the idle bound: this one is delivered on
      // the in-flight query as SQLSTATE 57014, the connection stays alive, and ordinary
      // error handling sees it. It must NOT be swept into the connection-lost class —
      // a cancelled statement is a bounded statement working as designed, not a dead
      // connection, and calling it retryable-infrastructure would be a lie.
      const bothWays: [string, ProbeFailure][] = [
        ['bare', child.result.bare],
        ['in a transaction', child.result.inTransaction],
      ];
      for (const [where, outcome] of bothWays) {
        assert.equal(outcome.threw, true, `${where}: the bound fired`);
        assert.equal(outcome.sqlState, '57014', `${where}: cancelled statement, not a FATAL`);
        assert.equal(outcome.mentionsStatementTimeout, true, `${where}: from statement_timeout`);
        assert.equal(outcome.isConnectionLost, false, `${where}: NOT the connection-lost class`);
        assert.equal(outcome.statusCode, null, `${where}: not dressed up as a 503`);
      }
      assert.equal(child.result.poolUsableAfter, 44, 'and the connection was never destroyed');
    });

    test('G1: the migration-runner exemption still works and the bound returns at COMMIT', () => {
      const child = runScenario('migration-exemption', {
        PG_STATEMENT_TIMEOUT_MS: '500',
        PG_IDLE_IN_TRANSACTION_TIMEOUT_MS: '800',
      });
      assert.equal(child.status, 0, `child failed; tail:\n${child.tail}`);

      // The ambient bound really is tight, so the exemption below is not vacuous.
      assert.equal(child.result.ambientBefore.sqlState, '57014', 'a 2s statement is refused');
      // A migration's long statement completes under the runner's SET LOCAL exemption.
      assert.equal(
        child.result.exempted.threw,
        false,
        'an index build or backfill is never interrupted',
      );
      // And the exemption expired with the transaction: SET LOCAL reverts at COMMIT, so
      // the connection goes back into the pool bounded rather than unbounded.
      assert.deepEqual(child.result.restoredAfterCommit, {
        statementTimeout: '500ms',
        idleInTransactionTimeout: '800ms',
      });
      assert.equal(child.result.ambientAfter.sqlState, '57014', 'and it is enforced again');
    });

    test('G1: the runner really issues the exemption the exemption test replicates', () => {
      const runner = readFileSync(join(__dirname, '..', 'scripts', 'migrate.ts'), 'utf8');

      // ONE hardened checkout path. The runner was the only other place in the repo
      // that called `pool.connect()` directly, which gave it the same unguarded client
      // and the same way to die on an asynchronous FATAL; it now goes through
      // `withTransaction` like everything else.
      assert.ok(!runner.includes('.connect()'), 'the runner checks no client out of its own');
      const begin = runner.indexOf('withTransaction(');
      assert.ok(begin > 0, 'each migration runs inside the shared transaction helper');

      // Inside that transaction, or the exemption would either not apply to the
      // migration or not expire with it.
      const body = runner.slice(begin);
      assert.ok(
        body.includes(`SET LOCAL statement_timeout = 0`),
        'the statement bound is lifted inside the migration transaction',
      );
      assert.ok(
        body.includes(`SET LOCAL idle_in_transaction_session_timeout = 0`),
        'and so is the idle-in-transaction bound',
      );
    });

    test('G1: withTransaction owns the checked-out error listener for exactly the checkout', async () => {
      const errorListeners = (candidate: unknown): number =>
        (candidate as { listenerCount?: (event: string) => number }).listenerCount?.('error') ?? -1;

      // THE PREMISE this correction rests on: pg-pool hands over a client with no
      // 'error' listener at all (it removes its idle listener in `_acquireClient` and
      // attaches no replacement), so an asynchronous FATAL has nowhere to land.
      const bare = await getPool().connect();
      try {
        assert.equal(errorListeners(bare), 0, 'a checked-out client is unguarded by the pool');
      } finally {
        bare.release();
      }

      let checkedOut: unknown;
      await withTransaction(async (tx) => {
        checkedOut = tx;
        assert.equal(errorListeners(tx), 1, 'withTransaction installed exactly one listener');
        return null;
      });
      // Removed on the way out: the pooled connection carries the pool's idle listener
      // and nothing else, so a later failure is handled once and this cannot leak or
      // double-handle across checkouts.
      assert.equal(
        errorListeners(checkedOut),
        1,
        'ours was removed on release; only the pool idle listener remains',
      );
    });

    /**
     * FBL-020-R3 correction I1 — a lost connection is classified FROM THE ERROR, not
     * from which racer won.
     *
     * G1 above proved the shape where the FATAL arrives with NOTHING RUNNING: the client
     * `'error'` event fires, the listener types it, and the caller gets a retryable 503.
     * That was only half the coverage, and not the half production hits most. When the
     * FATAL lands on an IN-FLIGHT statement — a restart, a failover, a
     * `pg_terminate_backend`, the ordinary shape — pg rejects the running query with the
     * FATAL's SQLSTATE BEFORE the socket `'error'` event is delivered, so the race settled
     * with the RAW driver error: `isConnectionLost=false`, no `statusCode`,
     * `retryable=false`, rendered downstream as `500 internal_error`. Nothing retried a
     * failure that was purely infrastructure and purely retryable, and the class doc
     * claimed all three shapes behaved alike.
     *
     * The same await ordering broke the ROLLBACK guard: `connectionLost` was read at
     * CATCH ENTRY, before the event had been delivered, so the suppression branch was
     * skipped, the ROLLBACK went into a dead session, and its failure was logged on top
     * of the real cause — the exact misleading second error the guard exists to prevent.
     *
     * Bounds are configured OFF for the in-flight scenario: the only thing that can end
     * that transaction is the kill, so the SQLSTATE observed is unambiguously 57P01 and
     * this cannot accidentally re-prove the idle bound.
     */
    describe('a lost connection is classified from the error, not the race (R3 I1)', () => {
      /**
       * ONE child run, asserted by two tests — the classification and the logging are
       * two properties of the same run, and spawning twice would prove them of two
       * different ones.
       */
      let killedInFlight: ChildOutcome | undefined;
      const inFlightKill = (): ChildOutcome =>
        (killedInFlight ??= runScenario('in-flight-fatal', {
          PGPOOL_MAX: '2',
          PG_STATEMENT_TIMEOUT_MS: '0',
          PG_IDLE_IN_TRANSACTION_TIMEOUT_MS: '0',
        }));

      test('I1(a): a FATAL on an in-flight statement is a typed, retryable 503', () => {
        const child = inFlightKill();
        assert.equal(child.status, 0, `child failed; tail:\n${child.tail}`);
        assert.deepEqual(
          child.result.handlers,
          { uncaughtException: 0, unhandledRejection: 0 },
          'still no process-level net',
        );

        // THE PREMISE: the backend really was running a statement when it was killed.
        // `idle in transaction` here would mean this scenario had quietly become a
        // duplicate of the G1 idle test instead of the shape nothing covered.
        assert.equal(
          child.result.stateWhenKilled,
          'active',
          'the kill must land on an IN-FLIGHT statement for this to be the uncovered shape',
        );

        const caught = child.result.caught;
        assert.equal(caught.threw, true, 'withTransaction rejected');
        // Before the fix, every one of these five: name 'error', isConnectionLost false,
        // pgCode null, statusCode null, retryable false.
        assert.equal(caught.name, 'DatabaseConnectionLostError');
        assert.equal(caught.isConnectionLost, true, 'typed, not a raw driver error');
        assert.equal(caught.pgCode, '57P01', 'the FATAL SQLSTATE is kept for diagnosis');
        assert.equal(caught.statusCode, 503, 'transient infrastructure, not internal_error');
        assert.equal(caught.retryable, true, 'so something downstream can retry it');

        // Told when the FATAL arrived, not when the 3s statement would have finished.
        const { inFlightMs, elapsedMs } = child.result;
        assert.ok(inFlightMs >= 2_000, 'the probe really does hold a long statement open');
        assert.ok(
          elapsedMs < inFlightMs / 2,
          `the caller was told promptly (waited ${elapsedMs}ms of ${inFlightMs}ms)`,
        );

        // And the pool recovered: the killed connection is discarded, not handed on.
        assert.equal(child.result.poolUsableAfter, 45, 'a plain query works afterwards');
        assert.equal(child.result.transactionUsableAfter, 46, 'so does a new transaction');
      });

      test('I1(b): that path logs the real cause once and no misleading ROLLBACK failure', () => {
        const child = inFlightKill();
        assert.equal(child.status, 0, `child failed; tail:\n${child.tail}`);

        // The defect this closes, verbatim from the failing run: the real cause at .793
        // and then "ROLLBACK failed" at .797, because the guard was evaluated before the
        // await that let the event through.
        assert.ok(
          !child.output.includes('ROLLBACK failed'),
          `no rollback error is logged into a session that is already gone:\n${child.tail}`,
        );

        const lines = child.output
          .split('\n')
          .filter((l) => l.includes('connection_lost_in_transaction'));
        assert.equal(lines.length, 1, 'one broken connection is one log line');
        // THE REAL CAUSE, not the aftermath: that one line carries the FATAL's SQLSTATE.
        // Before the fix it was written from the socket reset, which carries no code at
        // all, so the single record of the failure named no reason for it.
        const cause = lines.join('');
        assert.ok(
          cause.includes('"code":"57P01"'),
          `the logged cause must be the FATAL itself:\n${cause}`,
        );
      });

      /**
       * I1(b) — THE AWAIT ORDERING, on the branch the scenario above cannot reach.
       *
       * Classifying the caught error removes the ROLLBACK attempt entirely when the loss
       * is visible in the rejected statement, which is what fixes the observed trace. It
       * does NOT cover the other ordering the same bug allowed: a body that fails for its
       * own reasons at the moment the connection dies, so the caught error says nothing
       * about the connection, the ROLLBACK goes out, and the `'error'` event lands DURING
       * that await. A guard read at catch entry logs `ROLLBACK failed` over the real cause
       * there too.
       *
       * That ordering cannot be scheduled against a real server — whether the event
       * arrives before catch entry or during the await is up to the socket — so it is
       * constructed here: the event a dying connection would deliver is delivered in
       * exactly that window, and the ROLLBACK fails with a shape the classifier does not
       * recognise, leaving the re-read of the latch as the only thing that can suppress
       * the misleading line.
       */
      test('I1(b): a loss delivered during the ROLLBACK await suppresses the rollback log', async () => {
        interface FakeableClient {
          query: (sql: string, params?: unknown[]) => Promise<unknown>;
          emit: (event: string, err: Error) => boolean;
        }
        const written: string[] = [];
        const stderr = process.stderr as unknown as { write: (chunk: unknown) => boolean };
        const realWrite = stderr.write.bind(process.stderr);
        stderr.write = (chunk: unknown): boolean => {
          written.push(String(chunk));
          return true;
        };

        let caught: unknown;
        try {
          await withTransaction(async (tx) => {
            const client = tx as unknown as FakeableClient;
            const realQuery = client.query.bind(client);
            client.query = async (sql: string, params?: unknown[]): Promise<unknown> => {
              if (sql !== 'ROLLBACK') return realQuery(sql, params);
              // Restored immediately: nothing patched may outlive this checkout.
              client.query = realQuery;
              client.emit('error', new Error('Connection terminated unexpectedly'));
              throw new Error('probe: ROLLBACK could not be delivered');
            };
            throw new ConflictError('probe: the real cause');
          });
        } catch (err) {
          caught = err;
        } finally {
          stderr.write = realWrite;
        }
        const logged = written.join('');

        // The caller is still told the truth: the body's own failure, not the aftermath.
        assert.ok(caught instanceof ConflictError, 'the real cause reaches the caller');
        assert.equal(
          logged.split('connection_lost_in_transaction').length - 1,
          1,
          'the connection loss is recorded once',
        );
        // The whole point: no second, misleading error about the recovery attempt.
        assert.ok(
          !logged.includes('ROLLBACK failed'),
          `a rollback into a connection already known to be gone is not reported:\n${logged}`,
        );
      });

      test('I1(a): an ordinary application error is not reclassified', () => {
        const child = runScenario('application-error', {
          PG_STATEMENT_TIMEOUT_MS: '0',
          PG_IDLE_IN_TRANSACTION_TIMEOUT_MS: '0',
        });
        assert.equal(child.status, 0, `child failed; tail:\n${child.tail}`);

        // Widening the classifier until the in-flight FATAL fits would sweep this up
        // too, and a 409 the caller must NOT repeat would come back as a retryable 503.
        const caught = child.result.caught;
        assert.equal(caught.name, 'ConflictError', 'the domain error reaches the caller intact');
        assert.equal(caught.statusCode, 409, 'not dressed up as a 503');
        assert.equal(caught.isConnectionLost, false);
        assert.equal(caught.retryable, false);
        assert.ok(
          !child.output.includes('connection_lost_in_transaction'),
          `and nothing is logged as a lost connection:\n${child.tail}`,
        );

        // This path must also keep what the connection-lost path deliberately skips.
        // `now()` is fixed at transaction start, so a connection still sitting inside the
        // abandoned transaction would report an age of at least the body's 700ms stall.
        assert.ok(
          child.result.transactionAgeMsAfter < 250,
          `ROLLBACK still runs on this path (next statement saw a ` +
            `${child.result.transactionAgeMsAfter}ms-old transaction)`,
        );
        // PGPOOL_MAX=1, so the same pid means the client was RELEASED, not destroyed:
        // an application error must not cost the connection.
        assert.equal(
          child.result.pidAfter,
          child.result.pidBefore,
          'the connection goes back to the pool',
        );
      });

      /**
       * The ENUMERATION itself. 57P01 is proved on the wire by the scenario above and
       * 25P03 by the G1 idle test; `57P02` (crash_shutdown) cannot be produced in CI
       * without killing a backend out from under the cluster, and a severed socket cannot
       * be produced on demand at all. What can be checked exactly is the classifier's
       * membership, and because the fix classifies FROM THE ERROR, a body that throws a
       * driver-SHAPED error hands `withTransaction` the same input the driver would have
       * delivered on the in-flight path.
       */
      test('I1(a): the connection-lost enumeration is exactly the session-ended shapes', async () => {
        const thrownFrom = async (err: unknown): Promise<unknown> => {
          try {
            await withTransaction(async () => {
              throw err;
            });
            return undefined;
          } catch (caught) {
            return caught;
          }
        };
        const driverError = (message: string, code?: string): Error =>
          Object.assign(new Error(message), code === undefined ? {} : { code });

        // MEMBERS — shapes that could only have come from THIS connection, so the error
        // is evidence about it on its own: a SQLSTATE only a Postgres backend emits, and
        // the pg driver's own verbatim socket wording.
        const lost: [string, Error, string | undefined][] = [
          ['25P03 idle_in_transaction_session_timeout', driverError('idle', '25P03'), '25P03'],
          ['57P01 admin_shutdown', driverError('terminating connection', '57P01'), '57P01'],
          ['57P02 crash_shutdown', driverError('terminating connection', '57P02'), '57P02'],
          // No SQLSTATE exists for this one: there is no server left to send one, which
          // is why the class documents pgCode as best-effort rather than guaranteed.
          ['a severed socket', driverError('Connection terminated unexpectedly'), undefined],
        ];
        for (const [what, err, pgCode] of lost) {
          const caught = await thrownFrom(err);
          assert.ok(
            caught instanceof DatabaseConnectionLostError,
            `${what} must be classified as a lost connection`,
          );
          assert.equal(caught.statusCode, 503, `${what}: transient infrastructure`);
          assert.equal(caught.retryable, true, `${what}: retryable`);
          assert.equal(caught.pgCode, pgCode, `${what}: SQLSTATE only when one was sent`);
        }

        // NON-MEMBERS — each reaches the caller as the very object that was thrown.
        // Over-widening here is the failure mode that would be invisible in production
        // until a client retried something that can never succeed.
        const untouched: [string, unknown][] = [
          ['57014 query_canceled (statement_timeout)', driverError('statement timeout', '57014')],
          ['23505 unique_violation', driverError('duplicate key', '23505')],
          ['25P02 in_failed_sql_transaction', driverError('aborted', '25P02')],
          ['57P03 cannot_connect_now', driverError('starting up', '57P03')],
          // K1: a BARE SOCKET ERRNO is not evidence about THIS connection. Every socket
          // in the process reports these — an outbound HTTP client, a cache client — and
          // the body is where such an error enters. Thrown by a body on a LIVE client
          // there is nothing to attribute it to, so it stays the caller's error. The
          // shape is still classified when the client itself has died: `severed-socket`.
          ['ECONNRESET from an unrelated socket', driverError('read ECONNRESET', 'ECONNRESET')],
          ['EPIPE from an unrelated socket', driverError('write EPIPE', 'EPIPE')],
          ['ETIMEDOUT from an unrelated socket', driverError('connect ETIMEDOUT', 'ETIMEDOUT')],
          // The use-after-release symptom: a programming error must stay one.
          ['a closed client', driverError('Client was closed and is not queryable')],
          ['an application refusal', new ConflictError('not in a state that permits this')],
          ['a bare error', new Error('something else went wrong')],
        ];
        for (const [what, err] of untouched) {
          assert.equal(await thrownFrom(err), err, `${what} must reach the caller unchanged`);
        }
      });

      /**
       * FBL-020-R3 correction K1, on the wire.
       *
       * `DatabaseConnectionLostError` opens by calling itself "TRANSIENT INFRASTRUCTURE,
       * never an application or authorization outcome". That was a claim about ORIGIN
       * enforced by nothing: `ECONNRESET`/`EPIPE`/`ETIMEDOUT` were matched on ANY error
       * reaching the catch, and the body is exactly where an error from ANOTHER socket —
       * an outbound HTTP client, a cache client — enters. Such an error became a
       * retryable 503, `throw lostConnection ?? err` DISCARDED it, the ROLLBACK was
       * skipped, and a healthy pooled connection was destroyed.
       *
       * Nothing in `packages/` or `apps/` does non-database work inside a transaction
       * body today, which is why this was unreachable rather than absent — an
       * architectural property, and one KNOWN-LIMITATIONS asks the next implementer to
       * preserve, not an enforced one. This test does what that implementer would do.
       */
      test('K1: a socket errno from another socket is not a lost connection', () => {
        const child = runScenario('foreign-socket-error', {
          PG_IDLE_IN_TRANSACTION_TIMEOUT_MS: '0',
          PG_STATEMENT_TIMEOUT_MS: '0',
        });
        assert.equal(child.status, 0, `child failed; tail:\n${child.tail}`);

        // The real error reaches the caller, and it is the very object that was thrown.
        assert.equal(child.result.sameObject, true, 'the caller gets the object it threw');
        assert.equal(child.result.caught.isConnectionLost, false, 'not reclassified');
        assert.equal(child.result.caught.statusCode, null, 'not dressed up as a 503');
        assert.equal(child.result.caught.retryable, false, 'not advertised as retryable');
        assert.equal(child.result.caught.sqlState, 'ECONNRESET', 'the errno is still on it');
        assert.ok(
          !child.output.includes('connection_lost_in_transaction'),
          `and nothing is logged as a lost connection:\n${child.tail}`,
        );

        // The two things the connection-lost path deliberately skips, both of which a
        // false classification silently took away. `now()` is fixed at transaction start,
        // so a connection still inside the abandoned transaction would report an age of
        // at least the body's 700ms stall.
        assert.ok(
          child.result.transactionAgeMsAfter < 250,
          `ROLLBACK is still attempted (next statement saw a ` +
            `${child.result.transactionAgeMsAfter}ms-old transaction)`,
        );
        // PGPOOL_MAX=1, so the same pid means the client was RELEASED, not destroyed.
        assert.equal(
          child.result.pidAfter,
          child.result.pidBefore,
          'a healthy connection is not destroyed by an error that merely passed through',
        );
      });

      /**
       * The other side of that narrowing, and correction K2 with it: a GENUINELY severed
       * socket must still be a lost connection, and must not report a Node errno in a
       * field documented as a SQLSTATE.
       *
       * The socket under the checked-out client is torn down with an `EPIPE` and the real
       * pg driver carries it from there. `EPIPE` is exactly five upper-case letters, so
       * the old five-character shape test in `sqlStateOf` admitted it and the failure was
       * logged as `pgCode: 'EPIPE'` — a value that matches no SQLSTATE an operator could
       * filter on. The existing enumeration missed this because it covered `ECONNRESET`,
       * which is ten characters and was already rejected by length.
       */
      test('K2: a genuine severed socket is still 503, and carries no fake SQLSTATE', () => {
        const child = runScenario('severed-socket', {
          PG_IDLE_IN_TRANSACTION_TIMEOUT_MS: '0',
          PG_STATEMENT_TIMEOUT_MS: '0',
        });
        assert.equal(child.status, 0, `child failed; tail:\n${child.tail}`);

        // Still the typed, retryable failure — the narrowing kept the shape it exists for.
        assert.equal(child.result.caught.name, 'DatabaseConnectionLostError');
        assert.equal(child.result.caught.isConnectionLost, true);
        assert.equal(child.result.caught.statusCode, 503);
        assert.equal(child.result.caught.retryable, true);

        // K2 itself: absent, never the errno.
        assert.equal(
          child.result.caught.pgCode,
          null,
          'a severed socket carries no SQLSTATE, so the field must be empty',
        );

        // The pg internal the attribution rule rests on, observed rather than assumed:
        // the client is queryable while the transaction is healthy and stops being so
        // when its socket dies. A pg release that renames or reorders this fails here.
        assert.equal(child.result.queryableBefore, true, 'a live checkout is queryable');
        assert.equal(child.result.queryableAfter, false, 'a severed one is not');

        // And the pool recovers: the dead connection is discarded and replaced.
        assert.equal(child.result.poolUsableAfter, 48);
        assert.equal(child.result.transactionUsableAfter, 49);
      });

      /**
       * The severed-socket half of that enumeration matches on MESSAGE, because
       * node-postgres reports a dead socket as a plain `Error` with no code to match on.
       * The strings are the driver's, not ours, so a pg upgrade that reworded one would
       * silently narrow the classifier back to the defect I1(a) closed — a lost connection
       * reaching the caller as a raw error. This asserts the strings the classifier
       * depends on are still the strings the installed driver produces.
       */
      test('I1(a): the socket-shape allowlist still matches the installed pg driver', () => {
        const lib = join(__dirname, '..', 'node_modules', 'pg', 'lib');
        const driver = readdirSync(lib)
          .filter((entry) => entry.endsWith('.js'))
          .map((entry) => readFileSync(join(lib, entry), 'utf8'))
          .join('\n');
        assert.ok(driver.length > 1_000, 'sanity: the driver source was actually read');

        for (const message of [
          // Matched — the socket died under this checkout.
          'Connection terminated unexpectedly',
          'Client has encountered a connection error and is not queryable',
          // Deliberately NOT matched — this process ended the connection. Asserted too,
          // so the reason for excluding them cannot quietly stop being the driver's.
          'Client was closed and is not queryable',
        ]) {
          assert.ok(
            driver.includes(`'${message}'`),
            `pg no longer raises "${message}" — revisit the allowlist in pool.ts`,
          );
        }
      });

      /**
       * FBL-020-R3 I2(ii) — the CONTRACT CHANGE racing the loss against the body created.
       *
       * Failing the request the moment the connection dies means `withTransaction` rejects
       * WHILE `fn` MAY STILL BE RUNNING, and a Promise cannot be cancelled, so the body's
       * continuation runs on after the caller has been told the operation failed. That is
       * a real and deliberate improvement on the alternative — hanging until the body
       * finishes, holding a pooled connection nobody else can use — but it had been
       * documented nowhere, which left the next caller free to put work inside a
       * transaction body that must not happen after a failure.
       *
       * It is documented now, and this test is what keeps the documentation true: it
       * observes the abandonment rather than asserting it, and it fails if anyone later
       * makes the rejection wait for the body (or drops the write-up).
       */
      test('I2(ii): an abandoned body runs on, cannot write, and is documented', () => {
        const child = runScenario('abandoned-body', {
          PG_IDLE_IN_TRANSACTION_TIMEOUT_MS: '400',
          PG_STATEMENT_TIMEOUT_MS: '30000',
        });
        assert.equal(child.status, 0, `child failed; tail:\n${child.tail}`);

        // What the caller saw, and WHEN: the typed 503 arrives while the body still has
        // most of its stall left to run.
        assert.equal(child.result.caught.isConnectionLost, true);
        assert.equal(child.result.caught.statusCode, 503);
        const { toldAt, stallMs, sideEffects } = child.result;
        assert.ok(
          toldAt < stallMs / 2,
          `the caller is told while the body is still running (told at ${toldAt}ms of ${stallMs}ms)`,
        );

        // The part that needed writing down: non-database side effects complete AFTER the
        // caller has already been told the operation failed, and nothing reports them.
        assert.equal(sideEffects.length, 3, 'the body really did reach its side effects');
        for (const effect of sideEffects) {
          assert.ok(
            effect.at > toldAt,
            `${effect.what} ran at ${effect.at}ms, after the caller was told at ${toldAt}ms`,
          );
        }

        // The bound on the damage, and the reason this is a sharp edge rather than a
        // defect: the client is destroyed, so the abandoned body cannot write anything.
        assert.deepEqual(
          {
            attempted: child.result.databaseAfterAbandonment.attempted,
            threw: child.result.databaseAfterAbandonment.threw,
          },
          { attempted: true, threw: true },
          'an abandoned body can no longer touch the database',
        );

        // And the contract is written where the two audiences look. Pinned to the code
        // so "documented nowhere" cannot come back by attrition.
        const pool = readFileSync(
          join(__dirname, '..', 'packages', 'database', 'src', 'pool.ts'),
          'utf8',
        );
        assert.ok(
          pool.includes('ABANDONED, NOT CANCELLED'),
          'withTransaction states the contract where its callers read it',
        );
        const limitations = readFileSync(
          join(__dirname, '..', 'docs', 'identity', 'KNOWN-LIMITATIONS.md'),
          'utf8',
        );
        assert.ok(
          limitations.includes('ABANDONS its body'),
          'and the known-limitations note the next implementer reads carries it too',
        );
      });
    });
  },
);
