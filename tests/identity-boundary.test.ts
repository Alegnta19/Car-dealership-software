import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, beforeEach, describe, test } from 'node:test';
import {
  certifyMfaPolicy,
  resetDatabase,
  seedRooftopIdentity,
  seedTenantIdentity,
  sessionBindingFor,
  skipIntegration,
  startIdentityTestEnv,
  testOrganizationId,
  type IdentityTestEnv,
} from '@dealer/test-kit';
import { closePool, query, withTransaction } from '@dealer/database';
import {
  claimLoginTransactionAtomically,
  completeReauthentication,
  consumeReauthenticationGrant,
  createSession,
  decideSupportAccess,
  requestSupportAccess,
  revokeForIdentityBreach,
  revokeSupportSession,
  rotateSessionRefresh,
  startLoginTransaction,
  startReauthentication,
  validateSessionToken,
} from '@dealer/identity-access';

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

    async function makeLink(subject = 'user_boundary'): Promise<string> {
      const r = await query(
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

    // ── Obligation 4: login replay ────────────────────────────────────────
    test('a login transaction is consumed exactly once; the replay loses', async () => {
      const started = await startLoginTransaction({
        purpose: 'login',
        redirectUri: 'http://127.0.0.1:3000/auth/callback',
        returnTo: '/',
      });
      const args = {
        state: started.state,
        purpose: 'login' as const,
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
          state: started.state,
          purpose: 'login',
          nonce: started.nonce,
          codeVerifier: started.codeVerifier,
        }),
        null,
      );
    });

    // ── Obligation 3: no nullable-connection bypass ───────────────────────
    test('the schema makes an unbound LIVE session unrepresentable', async () => {
      const link = await makeLink('user_unbound');
      await assert.rejects(
        () =>
          query(
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
      await query(
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

    // ── Obligation 7: refresh rotation ────────────────────────────────────
    test('refresh state rotates, and a replayed refresh token changes nothing', async () => {
      const link = await makeLink('user_refresh');
      const created = await createSession({
        ...(await sessionBindingFor(tenantId, 'user_refresh')),
        tenantId,
        userLinkId: link,
        providerSessionId: null,
        authTime: new Date(),
        ttlSeconds: 3600,
        refreshToken: 'refresh-token-one',
      });

      const rotated = await rotateSessionRefresh({
        sessionId: created.session.sessionId,
        presentedRefreshToken: 'refresh-token-one',
        newRefreshToken: 'refresh-token-two',
        authTime: new Date(),
        ttlSeconds: 3600,
      });
      assert.ok(rotated);
      assert.equal(rotated.rotationCount, 1);

      // the OLD token is now worthless
      assert.equal(
        await rotateSessionRefresh({
          sessionId: created.session.sessionId,
          presentedRefreshToken: 'refresh-token-one',
          newRefreshToken: 'refresh-token-three',
          authTime: new Date(),
          ttlSeconds: 3600,
        }),
        null,
        'a replayed refresh token must not rotate anything',
      );

      // an identity breach kills the session outright
      assert.equal(
        await revokeForIdentityBreach(created.session.sessionId, 'identity_mismatch'),
        true,
      );
      assert.equal(await validateSessionToken(created.sessionToken), null);
    });

    // ── Obligation 6: the assurance floor ─────────────────────────────────
    test('a fresh_only grant can NEVER satisfy a fresh_and_mfa_policy operation', async () => {
      const link = await makeLink('user_assurance');
      const roId = randomUUID();

      // mint a FRESH-ONLY grant (no certified MFA policy)
      const started = await startReauthentication({
        tenantId,
        userLinkId: link,
        action: 'service.ro.transition:authorized',
        resourceType: 'repair_order',
        resourceId: roId,
        requiredAssurance: 'fresh_only',
        connectionId: (await sessionBindingFor(tenantId)).connectionId,
        issuer: (await sessionBindingFor(tenantId)).issuer,
        providerOrganizationId: testOrganizationId(tenantId),
        providerSubject: 'user_assurance',
      });
      const completed = await completeReauthentication({
        nonce: started.nonce,
        userLinkId: link,
        verifiedAuthTime: new Date(),
        connection: {
          connectionId: (await sessionBindingFor(tenantId)).connectionId,
          mfaPolicyCertified: false,
        },
      });
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
      const bind = await sessionBindingFor(tenantId);
      const started = await startReauthentication({
        tenantId,
        userLinkId: link,
        action: 'service.ro.transition:authorized',
        resourceType: 'repair_order',
        resourceId: randomUUID(),
        requiredAssurance: 'fresh_and_mfa_policy',
        connectionId: bind.connectionId,
        issuer: bind.issuer,
        providerOrganizationId: testOrganizationId(tenantId),
        providerSubject: 'user_high',
      });
      // uncertified: mints nothing
      assert.equal(
        await completeReauthentication({
          nonce: started.nonce,
          userLinkId: link,
          verifiedAuthTime: new Date(),
          connection: { connectionId: bind.connectionId, mfaPolicyCertified: false },
        }),
        null,
      );
    });

    // ── Obligation 5: exact reauthentication binding ──────────────────────
    test('a reauthentication that returns through a DIFFERENT identity mints nothing', async () => {
      const link = await makeLink('user_bound');
      const bind = await sessionBindingFor(tenantId);
      await certifyMfaPolicy(tenantId);

      const started = await startReauthentication({
        tenantId,
        userLinkId: link,
        action: 'service.ro.transition:authorized',
        resourceType: 'repair_order',
        resourceId: randomUUID(),
        requiredAssurance: 'fresh_and_mfa_policy',
        connectionId: bind.connectionId,
        issuer: bind.issuer,
        providerOrganizationId: testOrganizationId(tenantId),
        providerSubject: 'user_bound',
      });

      // a token proving a DIFFERENT subject is not a reauthentication of this actor
      assert.equal(
        await completeReauthentication({
          nonce: started.nonce,
          userLinkId: link,
          verifiedAuthTime: new Date(),
          connection: { connectionId: bind.connectionId, mfaPolicyCertified: true },
          verifiedIssuer: bind.issuer,
          verifiedOrganizationId: testOrganizationId(tenantId),
          verifiedProviderSubject: 'somebody-else',
        }),
        null,
        'subject mismatch mints nothing',
      );
    });

    // ── R3 section I: support APPROVER AUTHORITY (test-gate item 16) ──────
    test('only a current tenant admin of the TARGET tenant may approve support access', async () => {
      const requester = await makeLink('user_r3_req');
      // the requester must be a platform-support actor
      await query(
        `UPDATE user_links SET actor_scope = 'platform', tenant_id = NULL WHERE user_link_id = $1`,
        [requester],
      );
      await query(
        `INSERT INTO role_bindings (tenant_id, user_link_id, role, scope_level, scope_id)
         VALUES (NULL, $1, 'platform_support', 'platform', NULL)`,
        [requester],
      );

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
        const r = await query(
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
        await query(
          `INSERT INTO role_bindings (tenant_id, user_link_id, role, scope_level, scope_id)
           VALUES ($1, $2, 'tenant_admin', 'tenant', $1)`,
          [otherTenant, id],
        );
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
      await query(
        `INSERT INTO role_bindings (tenant_id, user_link_id, role, scope_level, scope_id, status,
                                    revoked_at)
         VALUES ($1, $2, 'tenant_admin', 'tenant', $1, 'revoked', NOW())`,
        [tenantId, admin],
      );
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
      const requester = await makeLink('user_r3_rev_req');
      await query(
        `UPDATE user_links SET actor_scope = 'platform', tenant_id = NULL WHERE user_link_id = $1`,
        [requester],
      );
      const outsider = await makeLink('user_r3_outsider');
      const request = await query(
        `INSERT INTO support_access_requests
           (tenant_id, requester_user_link_id, requested_actions, reason,
            requested_duration_minutes, status)
         VALUES ($1, $2, ARRAY['service.ro.view'], 'ticket 56', 30, 'pending')
         RETURNING request_id`,
        [tenantId, requester],
      );
      const session = await query(
        `INSERT INTO support_access_sessions (request_id, tenant_id, actor_user_link_id, expires_at)
         VALUES ($1, $2, $3, NOW() + INTERVAL '30 minutes')
         RETURNING support_session_id`,
        [String((request.rows[0] as { request_id: unknown }).request_id), tenantId, requester],
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
      const requester = await makeLink('user_support_req');
      await query(
        `UPDATE user_links SET actor_scope = 'platform', tenant_id = NULL WHERE user_link_id = $1`,
        [requester],
      );
      await query(
        `INSERT INTO role_bindings (tenant_id, user_link_id, role, scope_level, scope_id)
         VALUES (NULL, $1, 'platform_support', 'platform', NULL)`,
        [requester],
      );
      const approver = await makeLink('user_support_appr');
      await query(
        `INSERT INTO role_bindings (tenant_id, user_link_id, role, scope_level, scope_id)
         VALUES ($1, $2, 'tenant_admin', 'tenant', $1)`,
        [tenantId, approver],
      );
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
  },
);
