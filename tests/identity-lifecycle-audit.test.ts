import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, beforeEach, describe, test } from 'node:test';
import {
  TEST_REAUTH_CALLBACK_URI,
  bootstrapAdministrator,
  certifyMfaPolicy,
  ensureActiveConnection,
  resetDatabase,
  seedLocalSession,
  seedTenantIdentity,
  sessionBindingForLink,
  skipIntegration,
  testIssuer,
  testOrganizationId,
  fixtureAuthorizationStateWrite,
} from '@dealer/test-kit';
import { closePool, query, withTransaction } from '@dealer/database';
import {
  IDENTITY_AUDIT_INVENTORY,
  MutationAuthorityError,
  NOT_IMPERSONATED,
  REQUIRED_IDENTITY_AUDIT_TRANSITIONS,
  certifyProviderMfaPolicy,
  claimLoginTransactionAtomically,
  claimReauthentication,
  completeReauthentication,
  consumeReauthenticationGrant,
  createSession,
  expireStaleLoginTransactions,
  expireStaleReauthenticationTransactions,
  failLoginTransaction,
  failReauthentication,
  findActiveConnectionById,
  grantRole,
  oidcNonceDigest,
  refreshProviderSession,
  revokeProviderMfaPolicyCertification,
  revokeSessionByToken,
  revokeSessionById,
  startLoginTransaction,
  startReauthentication,
  succeedLoginTransaction,
  type ProviderRefreshResult,
  type StartedReauthentication,
  type VerifiedAccessToken,
} from '@dealer/identity-access';

const LOGIN_REDIRECT = 'http://127.0.0.1:3000/auth/callback';
const COOKIE_PASSWORD = 'lifecycle-audit-cookie-password-0123456789';

/**
 * FBL-020-R4 §3 — REAUTHENTICATION AUTHORITY, TERMINAL STATES, THE AUDIT
 * INVENTORY, MFA-CERTIFICATION VALIDITY, AND REFRESH BINDING.
 *
 * The order's findings, each with its own executable proof:
 *
 *   * the reauthentication row — not a browser cookie — is authoritative for the
 *     opaque handle, the callback, the correlation ids, the state/nonce/PKCE
 *     digests, the binding facts, and the terminal reason and time;
 *   * every provider-side failure enters EXACTLY ONE terminal state and writes
 *     EXACTLY ONE audit event (R3 left several rows stuck at 'started');
 *   * the machine-readable audit inventory is COMPLETE and every entry is true;
 *   * MFA-policy certification has an explicit validity and revocation, fails
 *     closed when false/revoked/missing/expired, and only an authorized
 *     administrative actor may set it;
 *   * a refresh binds the provider session `sid` exactly and never slides the
 *     LOCAL session expiry later than its original value.
 */
describe(
  'identity lifecycle audit and authority (FBL-020-R4 §3)',
  { skip: skipIntegration ? 'set TEST_DATABASE_URL to run' : false },
  () => {
    let tenantId: string;
    let userLinkId: string;
    let sessionId: string;

    after(async () => {
      await closePool();
    });

    beforeEach(async () => {
      await resetDatabase();
      tenantId = randomUUID();
      await seedTenantIdentity(tenantId);
      await ensureActiveConnection(tenantId);
      userLinkId = await makeLink('user_lifecycle_' + randomUUID().slice(0, 8));
      sessionId = (await seedLocalSession(userLinkId)).sessionId;
    });

    async function makeLink(subject: string): Promise<string> {
      const r = await fixtureAuthorizationStateWrite(
        'seed-authorization-state',
        `INSERT INTO user_links
           (actor_scope, tenant_id, provider, provider_user_id, status, activated_at,
            connection_id, issuer, provider_organization_id)
         SELECT 'dealership', $1, 'workos', $2, 'activated', NOW(),
                c.connection_id, c.issuer, c.provider_organization_id
           FROM identity_provider_connections c
          WHERE c.tenant_id = $1 AND c.provider = 'workos' AND c.status = 'active'
          LIMIT 1
         RETURNING user_link_id`,
        [tenantId, subject],
      );
      return String((r.rows[0] as { user_link_id: unknown }).user_link_id);
    }

    async function makePlatformAdmin(): Promise<string> {
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
        ['user_platform_admin_' + randomUUID().slice(0, 8)],
      );
      const id = String((r.rows[0] as { user_link_id: unknown }).user_link_id);
      await grantRole({
        actingUserLinkId: await bootstrapAdministrator(null),
        tenantId: null,
        userLinkId: id,
        role: 'platform_admin',
        scopeLevel: 'platform',
        scopeId: null,
      });
      return id;
    }

    async function connectionIdFor(tenant: string | null): Promise<string> {
      const r = await query(
        `SELECT connection_id FROM identity_provider_connections
          WHERE tenant_id IS NOT DISTINCT FROM $1 AND status = 'active' LIMIT 1`,
        [tenant],
      );
      return String((r.rows[0] as { connection_id: unknown }).connection_id);
    }

    async function eventCount(eventType: string, entityId?: string): Promise<number> {
      const r =
        entityId === undefined
          ? await query(`SELECT COUNT(*)::int AS n FROM audit_events WHERE event_type = $1`, [
              eventType,
            ])
          : await query(
              `SELECT COUNT(*)::int AS n FROM audit_events
                WHERE event_type = $1 AND entity_id = $2`,
              [eventType, entityId],
            );
      return Number((r.rows[0] as { n: number }).n);
    }

    async function startStepUp(
      overrides: { requiredAssurance?: 'fresh_only' | 'fresh_and_mfa_policy' } = {},
    ): Promise<StartedReauthentication> {
      const started = await startReauthentication({
        tenantId,
        userLinkId,
        sessionId,
        action: 'service.ro.transition:authorized',
        resourceType: 'repair_order',
        resourceId: randomUUID(),
        callbackUri: TEST_REAUTH_CALLBACK_URI,
        ...overrides,
      });
      assert.ok(started, 'the starting identity chain must hold');
      return started;
    }

    function completionFor(started: StartedReauthentication) {
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

    async function stepUpRow(reauthTxnId: string) {
      const r = await query(
        `SELECT state, terminal_reason, terminal_at, claimed_at, state_hash, code_verifier_hash,
                callback_uri, request_id, correlation_id, nonce_hash, oidc_nonce_hash,
                connection_id, issuer, provider_organization_id, provider_subject, session_id
           FROM reauthentication_transactions WHERE reauth_txn_id = $1`,
        [reauthTxnId],
      );
      return r.rows[0] as Record<string, unknown>;
    }

    // ── the LOGIN claim: handle AND exact redirect, both required ─────────
    //
    // FBL-020-R6 §2.2 CHANGED WHAT A REFUSAL LEAVES BEHIND, and this test says so.
    // R5 recorded a redirect disagreement as `identity.login.replayed` and left the
    // row `pending` — its state unburned, ready for the next attempt — and this test
    // asserted that pending row as if it were the property. It was the defect. A
    // callback that NAMES A REAL TRANSACTION and disagrees with it now ends that
    // transaction, with its own reason and exactly one terminal audit event.
    //
    // The handle case is different in kind and stays different: a claim naming a
    // handle that exists nowhere touches no row at all, so THIS transaction is
    // untouched and there is nothing to attribute an event to.
    async function openLogin() {
      const started = await startLoginTransaction({
        purpose: 'login',
        redirectUri: LOGIN_REDIRECT,
        returnTo: '/',
      });
      return {
        started,
        good: {
          loginTxnId: started.loginTxnId,
          redirectUri: LOGIN_REDIRECT,
          state: started.state,
          purpose: 'login' as const,
          presentedPurpose: 'login',
          nonce: started.nonce,
          codeVerifier: started.codeVerifier,
        },
      };
    }
    async function loginStatus(loginTxnId: string) {
      return (
        await query(
          `SELECT status, failure_reason FROM login_transactions WHERE login_txn_id = $1`,
          [loginTxnId],
        )
      ).rows[0] as { status: string; failure_reason: unknown };
    }

    test('the login claim requires the OPAQUE HANDLE and the EXACT redirect', async () => {
      const { started, good } = await openLogin();

      // R3 claimed by state alone: a callback naming a state it had somehow
      // obtained was claimed even though it had never been handed THIS
      // transaction, and the leg's own registered redirect participated in
      // nothing at all.
      assert.equal(
        await claimLoginTransactionAtomically({ ...good, loginTxnId: randomUUID() }),
        null,
        'a claim naming a different transaction handle must lose',
      );
      // …and THIS transaction is untouched by it: no row was named, so no row moved
      // and no event was written against one.
      assert.equal((await loginStatus(started.loginTxnId)).status, 'pending');
      assert.equal(await eventCount('identity.login.failed', started.loginTxnId), 0);
      assert.ok(await claimLoginTransactionAtomically(good), 'the correct claim still wins');

      // The REDIRECT disagreement, on a transaction of its own because it is now
      // terminal: the leg was opened for one registered redirect and presented
      // another, so the transaction ends rather than staying claimable.
      const other = await openLogin();
      assert.equal(
        await claimLoginTransactionAtomically({
          ...other.good,
          redirectUri: 'http://127.0.0.1:3000/auth/reauth/callback',
        }),
        null,
        'a claim naming a different redirect must lose',
      );
      const burned = await loginStatus(other.started.loginTxnId);
      assert.equal(burned.status, 'failed', 'and it must burn the transaction, not park it');
      assert.equal(burned.failure_reason, 'callback_redirect_mismatch');
      assert.equal(
        await eventCount('identity.login.failed', other.started.loginTxnId),
        1,
        'exactly one terminal audit event',
      );
      // A LATER CORRECT CALLBACK LOSES — the whole point of burning it.
      assert.equal(
        await claimLoginTransactionAtomically(other.good),
        null,
        'the correct callback arriving afterwards must lose to the terminal row',
      );
      assert.deepEqual(
        await loginStatus(other.started.loginTxnId),
        burned,
        'and it changes nothing: the FIRST terminal fact wins',
      );
    });

    // ── the SERVER ROW is authoritative for the callback ──────────────────
    test('the reauthentication ROW is authoritative for handle, callback, correlation, digests and binding', async () => {
      const started = await startStepUp();
      const row = await stepUpRow(started.transaction.reauthTxnId);

      // R4 §3: the round-trip state and PKCE verifier are generated by the
      // SERVICE and persisted as digests. R3 generated them in the HTTP route and
      // stored neither, so the cookie was the only record of either.
      assert.match(String(row.state_hash), /^[0-9a-f]{64}$/);
      assert.match(String(row.code_verifier_hash), /^[0-9a-f]{64}$/);
      assert.notEqual(String(row.state_hash), started.state, 'the raw state is never stored');
      assert.notEqual(
        String(row.code_verifier_hash),
        started.codeVerifier,
        'the raw PKCE verifier is never stored',
      );
      assert.match(String(row.nonce_hash), /^[0-9a-f]{64}$/);
      assert.match(String(row.oidc_nonce_hash), /^[0-9a-f]{64}$/);

      // the exact callback, the correlation pair, the binding facts, the session
      assert.equal(String(row.callback_uri), TEST_REAUTH_CALLBACK_URI);
      assert.match(String(row.request_id), /^[A-Za-z0-9._-]{8,128}$/);
      assert.match(String(row.correlation_id), /^[A-Za-z0-9._-]{8,128}$/);
      assert.equal(String(row.connection_id), started.binding.connectionId);
      assert.equal(String(row.issuer), started.binding.issuer);
      assert.equal(String(row.provider_organization_id), started.binding.providerOrganizationId);
      assert.equal(String(row.provider_subject), started.binding.providerSubject);
      assert.equal(String(row.session_id), sessionId);

      // …and a non-terminal row carries no terminal facts at all, which is what
      // makes "stuck at started" a detectable condition.
      assert.equal(row.claimed_at, null);
      assert.equal(row.terminal_reason, null);
      assert.equal(row.terminal_at, null);
    });

    test('the claim is SINGLE-USE and refuses a wrong state, a wrong verifier and a wrong callback', async () => {
      const started = await startStepUp();
      const good = {
        nonce: started.nonce,
        state: started.state,
        codeVerifier: started.codeVerifier,
        presentedPurpose: 'reauth',
        callbackUri: TEST_REAUTH_CALLBACK_URI,
      };

      // Each perturbation TERMINATES the leg, so each needs its own transaction —
      // and each is recorded under the reason for the binding that ACTUALLY failed,
      // FBL-020-R7 §2.3. R6 recorded all three as `callback_state_mismatch`, and
      // this test pinned that mislabelling as though it were the property. The
      // perturbation is applied to the FRESH leg's own correct values: presenting a
      // different leg's state alongside a wrong verifier would be a genuine state
      // mismatch, and the truthful classifier would be right to say so.
      for (const [label, perturbation, expectedReason] of [
        ['a wrong OAuth state', { state: 'not-the-stored-state' }, 'callback_state_mismatch'],
        [
          'a wrong PKCE verifier',
          { codeVerifier: 'not-the-stored-verifier' },
          'callback_pkce_mismatch',
        ],
        [
          'a wrong callback',
          { callbackUri: 'http://127.0.0.1:3000/auth/callback' },
          'callback_redirect_mismatch',
        ],
      ] as const) {
        const fresh = await startStepUp();
        assert.equal(
          await claimReauthentication({
            nonce: fresh.nonce,
            state: fresh.state,
            codeVerifier: fresh.codeVerifier,
            presentedPurpose: 'reauth',
            callbackUri: TEST_REAUTH_CALLBACK_URI,
            ...perturbation,
          }),
          null,
          `${label} must not claim`,
        );
        const row = await stepUpRow(fresh.transaction.reauthTxnId);
        assert.equal(row.state, 'failed', `${label} leaves a TERMINAL row`);
        assert.equal(row.terminal_reason, expectedReason, `${label} is recorded truthfully`);
        assert.notEqual(row.terminal_at, null);
      }

      // the correct claim wins exactly once; the replay loses and is terminal
      const claimed = await claimReauthentication(good);
      assert.ok(claimed);
      assert.equal(await claimReauthentication(good), null, 'the replay loses');
      const replayed = await stepUpRow(started.transaction.reauthTxnId);
      assert.equal(replayed.state, 'failed');
      assert.equal(replayed.terminal_reason, 'replayed');
      assert.equal(
        await eventCount('identity.reauthentication.replayed', started.transaction.reauthTxnId),
        1,
        'a replay writes exactly one audit event',
      );
    });

    test('an UNCLAIMED transaction cannot be completed — the claim is not optional', async () => {
      const started = await startStepUp();
      assert.equal(
        await completeReauthentication(completionFor(started)),
        null,
        'a completion without a claim proves no callback state at all',
      );
      // …and the same leg completes once it HAS claimed, so the refusal above is
      // the claim requirement and not some other missing fact.
      const second = await startStepUp();
      assert.ok(
        await claimReauthentication({
          presentedPurpose: 'reauth',
          nonce: second.nonce,
          state: second.state,
          codeVerifier: second.codeVerifier,
          callbackUri: TEST_REAUTH_CALLBACK_URI,
        }),
      );
      assert.ok(await completeReauthentication(completionFor(second)));
    });

    // ── EXACTLY ONE terminal state, EXACTLY ONE audit event ──────────────
    test('every provider-side failure reaches exactly ONE terminal state and ONE audit event', async () => {
      const reasons = [
        'provider_exchange_failed',
        'impersonation_detected',
        'token_verification_failed',
        'identity_not_admitted',
        'binding_mismatch',
      ] as const;

      for (const reason of reasons) {
        const started = await startStepUp();
        assert.ok(
          await claimReauthentication({
            presentedPurpose: 'reauth',
            nonce: started.nonce,
            state: started.state,
            codeVerifier: started.codeVerifier,
            callbackUri: TEST_REAUTH_CALLBACK_URI,
          }),
        );
        // the route's terminal move for a failure discovered outside any transaction
        assert.equal(await failReauthentication({ nonce: started.nonce, reason }), true);
        const row = await stepUpRow(started.transaction.reauthTxnId);
        assert.equal(row.state, 'failed', `${reason} must be terminal, never left at started`);
        assert.equal(row.terminal_reason, reason);
        assert.notEqual(row.terminal_at, null);
        assert.equal(
          await eventCount('identity.reauthentication.failed', started.transaction.reauthTxnId),
          1,
          `${reason} writes exactly one audit event`,
        );

        // The FIRST terminal fact wins: a second attempt changes nothing on the row.
        assert.equal(
          await failReauthentication({ nonce: started.nonce, reason: 'expired' }),
          false,
          'a terminal transaction cannot be re-terminated',
        );
        const after = await stepUpRow(started.transaction.reauthTxnId);
        assert.equal(after.terminal_reason, reason, 'nothing overwrote the first reason');
        // …and the refused second attempt wrote NO second terminal event, so one
        // transaction can never show two endings.
        assert.equal(
          await eventCount('identity.reauthentication.expired', started.transaction.reauthTxnId),
          0,
          'a refused re-termination writes no event',
        );
        assert.equal(
          await eventCount('identity.reauthentication.failed', started.transaction.reauthTxnId),
          1,
          'still exactly one terminal event for this transaction',
        );
        // …and the transaction can never be completed afterwards
        assert.equal(await completeReauthentication(completionFor(started)), null);
      }
    });

    test('the expiry sweep records WHY and WHEN, and audits each transaction once', async () => {
      const started = await startStepUp();
      await query(
        `UPDATE reauthentication_transactions
            SET started_at = NOW() - INTERVAL '2 hours', expires_at = NOW() - INTERVAL '1 hour'
          WHERE reauth_txn_id = $1`,
        [started.transaction.reauthTxnId],
      );
      assert.ok((await expireStaleReauthenticationTransactions()) >= 1);
      const row = await stepUpRow(started.transaction.reauthTxnId);
      assert.equal(row.state, 'expired');
      assert.equal(row.terminal_reason, 'expired');
      assert.notEqual(row.terminal_at, null);
      assert.equal(
        await eventCount('identity.reauthentication.expired', started.transaction.reauthTxnId),
        1,
      );
    });

    // ── MFA-policy certification: validity, revocation, authority ─────────
    test('MFA certification fails CLOSED when false, missing, expired or revoked', async () => {
      const connectionId = await connectionIdFor(tenantId);

      // (1) missing — the default
      const uncertified = await findActiveConnectionById(connectionId);
      assert.equal(uncertified?.mfaPolicyCertified, false);
      const noCert = await startStepUp({ requiredAssurance: 'fresh_and_mfa_policy' });
      await claimReauthentication({
        presentedPurpose: 'reauth',
        nonce: noCert.nonce,
        state: noCert.state,
        codeVerifier: noCert.codeVerifier,
        callbackUri: TEST_REAUTH_CALLBACK_URI,
      });
      assert.equal(await completeReauthentication(completionFor(noCert)), null);
      assert.equal(
        (await stepUpRow(noCert.transaction.reauthTxnId)).terminal_reason,
        'assurance_not_certified',
      );

      // (2) certified and IN DATE — the only case that mints
      await certifyMfaPolicy(tenantId);
      assert.equal((await findActiveConnectionById(connectionId))?.mfaPolicyCertified, true);
      const good = await startStepUp({ requiredAssurance: 'fresh_and_mfa_policy' });
      await claimReauthentication({
        presentedPurpose: 'reauth',
        nonce: good.nonce,
        state: good.state,
        codeVerifier: good.codeVerifier,
        callbackUri: TEST_REAUTH_CALLBACK_URI,
      });
      assert.ok(await completeReauthentication(completionFor(good)));

      // (3) EXPIRED — the deadline passed, so it counts for nothing
      await fixtureAuthorizationStateWrite(
        'simulate-authorization-drift',
        `UPDATE identity_provider_connections
            SET mfa_policy_certified_at = NOW() - INTERVAL '2 days',
                mfa_policy_certification_expires_at = NOW() - INTERVAL '1 day'
          WHERE connection_id = $1`,
        [connectionId],
      );
      assert.equal(
        (await findActiveConnectionById(connectionId))?.mfaPolicyCertified,
        false,
        'an EXPIRED certification is not a certification',
      );
      const stale = await startStepUp({ requiredAssurance: 'fresh_and_mfa_policy' });
      await claimReauthentication({
        presentedPurpose: 'reauth',
        nonce: stale.nonce,
        state: stale.state,
        codeVerifier: stale.codeVerifier,
        callbackUri: TEST_REAUTH_CALLBACK_URI,
      });
      assert.equal(await completeReauthentication(completionFor(stale)), null);

      // (4) REVOKED — an explicit, attributable withdrawal
      const admin = await makePlatformAdmin();
      await certifyProviderMfaPolicy({ actingUserLinkId: admin, connectionId, certified: true });
      assert.equal((await findActiveConnectionById(connectionId))?.mfaPolicyCertified, true);
      const revoked = await revokeProviderMfaPolicyCertification({
        actingUserLinkId: admin,
        connectionId,
      });
      assert.ok(revoked);
      assert.equal(
        (await findActiveConnectionById(connectionId))?.mfaPolicyCertified,
        false,
        'a REVOKED certification is not a certification',
      );
      const revokedRow = (
        await query(
          `SELECT mfa_policy_certification_revoked_at,
                  mfa_policy_certification_revoked_by_user_link_id
             FROM identity_provider_connections WHERE connection_id = $1`,
          [connectionId],
        )
      ).rows[0] as Record<string, unknown>;
      assert.notEqual(revokedRow.mfa_policy_certification_revoked_at, null);
      assert.equal(
        String(revokedRow.mfa_policy_certification_revoked_by_user_link_id),
        admin,
        'a withdrawal names the person who performed it',
      );
      assert.equal(
        await eventCount('identity.provider_connection.mfa_policy_certification_revoked'),
        1,
      );
    });

    /**
     * FBL-020-R5 §1.9 — CERTIFICATION IS SUBJECT TO THE TENANT'S OWN AUTHORITY RULE.
     *
     * "Tenant-scoped MFA certification must require a currently active/effective
     * tenant under the same authority rule as policy evaluation."
     *
     * The policy engine applies that rule to every non-platform decision: it resolves
     * the target tenant and denies TENANT_INACTIVE unless the row is `active` AND
     * inside its effective window. The certification gate applied NO tenant rule at
     * all — it read role bindings and user links and never looked at the tenant — so a
     * suspended dealership, or one whose effective window had closed, could still have
     * the single fact its whole high-assurance step-up path rests on re-asserted.
     *
     * Three legs, because the first two alone would pass for an actor who simply had
     * no authority:
     *
     *   CONTROL   — an active, effective tenant: the same administrator certifies.
     *   SUSPENDED — status is not 'active': refused.
     *   LAPSED    — status IS 'active' but the effective window has closed: refused.
     *
     * The third is the one that distinguishes "the same rule as policy evaluation"
     * from "a status check": a status-only gate would let the lapsed tenant through.
     */
    test('tenant-scoped MFA certification requires a currently ACTIVE and EFFECTIVE tenant', async () => {
      const connectionId = await connectionIdFor(tenantId);
      const tenantAdmin = await makeLink('user_mfa_tenant_admin_' + randomUUID().slice(0, 8));
      await grantRole({
        actingUserLinkId: await bootstrapAdministrator(tenantId),
        tenantId,
        userLinkId: tenantAdmin,
        role: 'tenant_admin',
        scopeLevel: 'tenant',
        scopeId: tenantId,
      });

      // CONTROL — with a live tenant this administrator certifies successfully.
      assert.ok(
        await certifyProviderMfaPolicy({
          actingUserLinkId: tenantAdmin,
          connectionId,
          certified: true,
        }),
        'CONTROL: a live tenant admits the certification',
      );
      assert.equal((await findActiveConnectionById(connectionId))?.mfaPolicyCertified, true);

      // SUSPENDED — the tenant is no longer active. A DECLARED fixture bypass: no
      // production service suspends a tenant on this path, and a suspended tenant is
      // exactly the authorization state under test.
      await fixtureAuthorizationStateWrite(
        'simulate-authorization-drift',
        `UPDATE tenants SET status = 'suspended' WHERE tenant_id = $1`,
        [tenantId],
      );
      await assert.rejects(
        () =>
          certifyProviderMfaPolicy({
            actingUserLinkId: tenantAdmin,
            connectionId,
            certified: true,
          }),
        MutationAuthorityError,
        'a suspended tenant has no live authority to certify anything for',
      );

      // LAPSED — active, but outside its effective window. A status-only gate would
      // let this through, which is precisely the drift this clause forbids.
      await fixtureAuthorizationStateWrite(
        'simulate-authorization-drift',
        `UPDATE tenants
            SET status = 'active',
                effective_from = NOW() - INTERVAL '2 days',
                effective_to = NOW() - INTERVAL '1 day'
          WHERE tenant_id = $1`,
        [tenantId],
      );
      await assert.rejects(
        () =>
          certifyProviderMfaPolicy({
            actingUserLinkId: tenantAdmin,
            connectionId,
            certified: true,
          }),
        MutationAuthorityError,
        'an effective window that has closed is the same fact as an inactive tenant',
      );

      // …and the certification the CONTROL leg wrote is untouched by either refusal:
      // a refused certification changes nothing at all.
      const row = (
        await query(
          `SELECT mfa_policy_certified FROM identity_provider_connections WHERE connection_id = $1`,
          [connectionId],
        )
      ).rows[0] as { mfa_policy_certified: unknown };
      assert.equal(row.mfa_policy_certified, true, 'a refusal is not a withdrawal');
    });

    test('only an AUTHORIZED administrative actor may certify an MFA policy', async () => {
      const connectionId = await connectionIdFor(tenantId);

      // A real, existing, activated link with NO administrative binding. R3
      // required only that the acting link exist, so this succeeded.
      await assert.rejects(
        () =>
          certifyProviderMfaPolicy({
            actingUserLinkId: userLinkId,
            connectionId,
            certified: true,
          }),
        MutationAuthorityError,
        'an ordinary identity must not be able to certify an organization MFA policy',
      );
      assert.equal((await findActiveConnectionById(connectionId))?.mfaPolicyCertified, false);

      // A tenant administrator of THIS tenant may.
      const tenantAdmin = await makeLink('user_tenant_admin_' + randomUUID().slice(0, 8));
      await grantRole({
        actingUserLinkId: await bootstrapAdministrator(tenantId),
        tenantId,
        userLinkId: tenantAdmin,
        role: 'tenant_admin',
        scopeLevel: 'tenant',
        scopeId: tenantId,
      });
      const certified = await certifyProviderMfaPolicy({
        actingUserLinkId: tenantAdmin,
        connectionId,
        certified: true,
      });
      assert.ok(certified);
      assert.equal((await findActiveConnectionById(connectionId))?.mfaPolicyCertified, true);

      // …and the certification carries a DEADLINE, so it can go stale rather than
      // being true for ever.
      const row = (
        await query(
          `SELECT mfa_policy_certification_expires_at, mfa_policy_certified_by_user_link_id
             FROM identity_provider_connections WHERE connection_id = $1`,
          [connectionId],
        )
      ).rows[0] as Record<string, unknown>;
      assert.notEqual(row.mfa_policy_certification_expires_at, null);
      assert.equal(String(row.mfa_policy_certified_by_user_link_id), tenantAdmin);
    });

    // ── refresh: the provider session id, bound exactly ──────────────────
    interface RefreshFixture {
      readonly sessionId: string;
      readonly providerSessionId: string;
      readonly expiresAt: number;
    }

    async function refreshableSession(): Promise<RefreshFixture> {
      const link = await makeLink('user_refresh_' + randomUUID().slice(0, 8));
      const binding = await sessionBindingForLink(link);
      const providerSessionId = 'sid_bound_' + randomUUID().slice(0, 8);
      const created = await createSession({
        ...binding,
        tenantId,
        userLinkId: link,
        providerSessionId,
        authTime: new Date(Date.now() - 120_000),
        ttlSeconds: 3600,
        refreshToken: 'provider-refresh-1',
        cookiePassword: COOKIE_PASSWORD,
        providerAccessTokenExpiresAt: new Date(Date.now() + 20_000),
      });
      return {
        sessionId: created.session.sessionId,
        providerSessionId,
        expiresAt: created.session.expiresAt.getTime(),
      };
    }

    function refreshPort(providerSessionId: string) {
      return {
        async refreshSession(): Promise<ProviderRefreshResult> {
          return {
            accessToken: 'fake.access.token',
            refreshToken: 'provider-refresh-2',
            providerUserId: 'unused-overridden-below',
            providerSessionId,
            organizationId: testOrganizationId(tenantId),
            impersonation: NOT_IMPERSONATED,
          };
        },
      };
    }

    /**
     * FBL-020-R5 §1.8 — `refreshProviderSession` no longer accepts an absent
     * verifier, so every call in this battery supplies one. `authTime` is older
     * than the instant the session was established with, because a refresh is not
     * an authentication event and this fake must never be what moves auth_time.
     */
    function verifiedRefresh(
      subject: string,
      providerSessionId: string,
    ): Promise<VerifiedAccessToken> {
      return Promise.resolve({
        providerUserId: subject,
        providerSessionId,
        organizationId: testOrganizationId(tenantId),
        authTime: new Date(Date.now() - 3_600_000),
        issuedAt: new Date(),
        expiresAt: new Date(Date.now() + 300_000),
        roleHints: [],
        nonceDigest: null,
        impersonation: NOT_IMPERSONATED,
      });
    }

    async function subjectOf(session: string): Promise<string> {
      const r = await query(
        `SELECT provider_subject FROM identity_sessions WHERE session_id = $1`,
        [session],
      );
      return String((r.rows[0] as { provider_subject: unknown }).provider_subject);
    }

    test('a refresh reply naming a DIFFERENT provider session revokes instead of being adopted', async () => {
      const f = await refreshableSession();
      const subject = await subjectOf(f.sessionId);
      const port = refreshPort('sid_somebody_elses_session');
      const outcome = await refreshProviderSession({
        sessionId: f.sessionId,
        provider: {
          refreshSession: async () => ({
            ...(await port.refreshSession()),
            providerUserId: subject,
          }),
        },
        cookiePassword: COOKIE_PASSWORD,
        expectedIssuer: testIssuer(),
        ttlSeconds: 3600,
        // both carriers name the SAME foreign provider session, so the disagreement
        // under test is with the local row and nothing else
        verifyAccessToken: () => verifiedRefresh(subject, 'sid_somebody_elses_session'),
      });
      assert.equal(outcome.outcome, 'revoked');
      assert.equal(outcome.outcome === 'revoked' ? outcome.reason : null, 'identity_mismatch');
      const row = (
        await query(
          `SELECT revoked_reason, provider_session_id FROM identity_sessions WHERE session_id = $1`,
          [f.sessionId],
        )
      ).rows[0] as Record<string, unknown>;
      assert.equal(String(row.revoked_reason), 'identity_mismatch');
      assert.equal(
        String(row.provider_session_id),
        f.providerSessionId,
        'the stored sid was never overwritten by the reply',
      );
    });

    test('a refresh PRESERVES the original local expiry and never slides it later', async () => {
      const f = await refreshableSession();
      const subject = await subjectOf(f.sessionId);
      const verified: VerifiedAccessToken = {
        providerUserId: subject,
        providerSessionId: f.providerSessionId,
        organizationId: testOrganizationId(tenantId),
        authTime: new Date(Date.now() - 120_000),
        issuedAt: new Date(),
        expiresAt: new Date(Date.now() + 300_000),
        roleHints: [],
        nonceDigest: null,
        impersonation: NOT_IMPERSONATED,
      };
      const outcome = await refreshProviderSession({
        sessionId: f.sessionId,
        provider: {
          refreshSession: async () => ({
            ...(await refreshPort(f.providerSessionId).refreshSession()),
            providerUserId: subject,
          }),
        },
        cookiePassword: COOKIE_PASSWORD,
        expectedIssuer: testIssuer(),
        // A caller asking for a FULL fresh TTL: R3 wrote NOW() + ttl and re-armed
        // the local bound, so a client that kept polling could never expire.
        ttlSeconds: 8 * 3600,
        verifyAccessToken: () => Promise.resolve(verified),
      });
      assert.equal(outcome.outcome, 'refreshed');
      const after = (
        await query(`SELECT expires_at FROM identity_sessions WHERE session_id = $1`, [f.sessionId])
      ).rows[0] as { expires_at: unknown };
      assert.ok(
        new Date(String(after.expires_at)).getTime() <= f.expiresAt,
        'the local session expiry must never move later than its original value',
      );
    });

    // ── THE AUDIT INVENTORY, driven end to end ───────────────────────────
    test('the audit inventory is complete, and every transition in it writes its event', async () => {
      // (a) the inventory covers exactly the transitions the order enumerates
      //
      // WHAT THIS TEST DOES AND DOES NOT PROVE, stated because the inventory's header
      // once claimed the second half: it drives the login, session and reauthentication
      // families end to end in ONE database and asserts each named event type really
      // appears. It cannot prove the inventory is COMPLETE against production code —
      // that is a code-scanning question, answered by
      // `scripts/check-audit-inventory.ts` in `npm run architecture:check`, whose own
      // proof is in `tests/architecture.test.ts`.
      const covered = IDENTITY_AUDIT_INVENTORY.map((e) => e.transition);
      for (const required of REQUIRED_IDENTITY_AUDIT_TRANSITIONS) {
        assert.ok(covered.includes(required), `the inventory must cover ${required}`);
      }
      assert.equal(new Set(covered).size, covered.length, 'no transition is listed twice');
      for (const entry of IDENTITY_AUDIT_INVENTORY) {
        assert.ok(entry.eventType.startsWith('identity.'), entry.eventType);
        assert.ok(entry.provenBy.length > 0, `${entry.transition} must name its proving test`);
        assert.ok(entry.provenIn.length > 0, `${entry.transition} must name the file it is in`);
        assert.ok(entry.writtenBy.length > 0, `${entry.transition} must name its writer`);
      }

      // (b) LOGIN: start, claim, success
      const ok = await startLoginTransaction({
        purpose: 'login',
        redirectUri: LOGIN_REDIRECT,
        returnTo: '/',
      });
      assert.equal(await eventCount('identity.login.started', ok.loginTxnId), 1);
      const claimArgs = {
        loginTxnId: ok.loginTxnId,
        redirectUri: LOGIN_REDIRECT,
        state: ok.state,
        purpose: 'login' as const,
        presentedPurpose: 'login',
        nonce: ok.nonce,
        codeVerifier: ok.codeVerifier,
      };
      assert.ok(await claimLoginTransactionAtomically(claimArgs));
      assert.equal(await eventCount('identity.login.claimed', ok.loginTxnId), 1);
      assert.equal(
        await succeedLoginTransaction({
          loginTxnId: ok.loginTxnId,
          tenantId,
          // FBL-020-R5 §1.11: the success names the ADMITTED identity, so the
          // `identity.login.succeeded` row lands in this tenant's trail with an
          // actor on it rather than under the nil tenant naming nobody.
          userLinkId: await makeLink('user_login_ok_' + randomUUID().slice(0, 8)),
        }),
        true,
      );
      assert.equal(await eventCount('identity.login.succeeded', ok.loginTxnId), 1);
      // replay of a terminal transaction
      assert.equal(await claimLoginTransactionAtomically(claimArgs), null);
      assert.equal(await eventCount('identity.login.replayed', ok.loginTxnId), 1);

      // failure
      const bad = await startLoginTransaction({ purpose: 'login', redirectUri: LOGIN_REDIRECT });
      assert.equal(await failLoginTransaction(bad.loginTxnId, 'token_verification_failed'), true);
      assert.equal(await eventCount('identity.login.failed', bad.loginTxnId), 1);

      // expiry, through the sweep
      const stale = await startLoginTransaction({ purpose: 'login', redirectUri: LOGIN_REDIRECT });
      await query(
        `UPDATE login_transactions
            SET created_at = NOW() - INTERVAL '2 hours', expires_at = NOW() - INTERVAL '1 hour'
          WHERE login_txn_id = $1`,
        [stale.loginTxnId],
      );
      assert.ok((await expireStaleLoginTransactions()) >= 1);
      assert.equal(await eventCount('identity.login.expired', stale.loginTxnId), 1);

      // (c) SESSION: establishment, refresh, rotation, logout, revocation
      const f = await refreshableSession();
      assert.equal(await eventCount('identity.session.established', f.sessionId), 1);
      const subject = await subjectOf(f.sessionId);
      const refreshed = await refreshProviderSession({
        sessionId: f.sessionId,
        provider: {
          refreshSession: async () => ({
            ...(await refreshPort(f.providerSessionId).refreshSession()),
            providerUserId: subject,
          }),
        },
        cookiePassword: COOKIE_PASSWORD,
        expectedIssuer: testIssuer(),
        ttlSeconds: 3600,
        verifyAccessToken: () => verifiedRefresh(subject, f.providerSessionId),
      });
      assert.equal(refreshed.outcome, 'refreshed');
      assert.equal(await eventCount('identity.session.refreshed', f.sessionId), 1);
      assert.equal(await eventCount('identity.session.refresh_state_rotated', f.sessionId), 1);
      assert.equal(await revokeSessionById(f.sessionId, 'security_event'), true);
      assert.equal(await eventCount('identity.session.revoked', f.sessionId), 1);

      const loggedOut = await seedLocalSession(
        await makeLink('user_logout_' + randomUUID().slice(0, 8)),
      );
      assert.equal(await revokeSessionByToken(loggedOut.sessionToken, 'logout'), true);
      assert.equal(await eventCount('identity.session.logged_out', loggedOut.sessionId), 1);

      // (d) REAUTHENTICATION: start, claim, success, grant consumption
      await certifyMfaPolicy(tenantId);
      const step = await startStepUp({ requiredAssurance: 'fresh_and_mfa_policy' });
      assert.equal(
        await eventCount('identity.reauthentication.started', step.transaction.reauthTxnId),
        1,
      );
      assert.ok(
        await claimReauthentication({
          presentedPurpose: 'reauth',
          nonce: step.nonce,
          state: step.state,
          codeVerifier: step.codeVerifier,
          callbackUri: TEST_REAUTH_CALLBACK_URI,
        }),
      );
      assert.equal(
        await eventCount('identity.reauthentication.claimed', step.transaction.reauthTxnId),
        1,
      );
      const completed = await completeReauthentication(completionFor(step));
      assert.ok(completed);
      assert.equal(
        await eventCount('identity.reauthentication.granted', step.transaction.reauthTxnId),
        1,
      );
      const spent = await withTransaction((tx) =>
        consumeReauthenticationGrant(tx, {
          grant: completed.grant,
          tenantId,
          userLinkId,
          action: step.transaction.action,
          resourceType: step.transaction.resourceType,
          resourceId: step.transaction.resourceId,
          requiredAssurance: 'fresh_and_mfa_policy',
        }),
      );
      assert.equal(spent, true);
      assert.equal(await eventCount('identity.reauthentication.grant_consumed'), 1);

      // …a FAILED step-up, and an EXPIRED one, so the two remaining reauth
      // transitions in the inventory are exercised in this same database.
      const failing = await startStepUp();
      assert.ok(
        await claimReauthentication({
          presentedPurpose: 'reauth',
          nonce: failing.nonce,
          state: failing.state,
          codeVerifier: failing.codeVerifier,
          callbackUri: TEST_REAUTH_CALLBACK_URI,
        }),
      );
      assert.equal(
        await failReauthentication({ nonce: failing.nonce, reason: 'provider_exchange_failed' }),
        true,
      );
      assert.equal(
        await eventCount('identity.reauthentication.failed', failing.transaction.reauthTxnId),
        1,
      );
      // …a REPLAYED step-up callback: the same claim presented twice.
      const replayed = await startStepUp();
      const replayArgs = {
        nonce: replayed.nonce,
        state: replayed.state,
        codeVerifier: replayed.codeVerifier,
        presentedPurpose: 'reauth',
        callbackUri: TEST_REAUTH_CALLBACK_URI,
      };
      assert.ok(await claimReauthentication(replayArgs));
      assert.equal(await claimReauthentication(replayArgs), null);
      assert.equal(
        await eventCount('identity.reauthentication.replayed', replayed.transaction.reauthTxnId),
        1,
      );

      const expiring = await startStepUp();
      await query(
        `UPDATE reauthentication_transactions
            SET started_at = NOW() - INTERVAL '2 hours', expires_at = NOW() - INTERVAL '1 hour'
          WHERE reauth_txn_id = $1`,
        [expiring.transaction.reauthTxnId],
      );
      assert.ok((await expireStaleReauthenticationTransactions()) >= 1);
      assert.equal(
        await eventCount('identity.reauthentication.expired', expiring.transaction.reauthTxnId),
        1,
      );

      // (e) every event type in the three families driven ABOVE has now been
      //     observed in THIS database. The filter is on the family rather than a
      //     hand-written skip list, so adding a login, session or reauthentication
      //     event type to the inventory forces it to be driven here — while the
      //     families this test does not drive (support, and the identity mutations)
      //     are held to their own batteries, which the audit-inventory gate checks
      //     by name through each entry's `provenIn` / `provenBy`.
      const drivenHere: readonly string[] = ['login', 'session', 'reauthentication'];
      const observed = new Set(
        (
          await query(`SELECT DISTINCT event_type FROM audit_events WHERE event_type LIKE $1`, [
            'identity.%',
          ])
        ).rows.map((r) => String((r as { event_type: unknown }).event_type)),
      );
      const expected = IDENTITY_AUDIT_INVENTORY.filter((e) => drivenHere.includes(e.family));
      assert.ok(expected.length >= 18, 'sanity: the three families this test drives are not empty');
      for (const entry of expected) {
        assert.ok(
          observed.has(entry.eventType),
          `${entry.transition} claims to write ${entry.eventType}, which never appeared`,
        );
      }
    });

    test('the support-use inventory entry names the event the policy engine actually writes', () => {
      // The engine's own write is driven end to end in the policy suite ("support
      // access: live approved session grants EXACTLY its action set…"), which
      // asserts one row, the true actor and no reason text. What is checked HERE
      // is that the machine-readable mapping still names that exact event type and
      // entity type — the failure mode this guards against is the inventory
      // drifting away from the code it documents.
      const entry = IDENTITY_AUDIT_INVENTORY.find((e) => e.transition === 'support.use');
      assert.ok(entry);
      assert.equal(entry.eventType, 'identity.support.used');
      assert.equal(entry.entityType, 'support_access_session');
      assert.match(entry.writtenBy, /policy engine/);
    });
  },
);
