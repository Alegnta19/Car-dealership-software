import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, beforeEach, describe, test } from 'node:test';
import {
  bootstrapAdministrator,
  ensureActiveConnection,
  resetDatabase,
  seedLocalSession,
  skipIntegration,
  testIssuer,
  mintReauthGrant,
} from '@dealer/test-kit';
import { closePool, query, withTransaction } from '@dealer/database';
import { createTenant } from '@dealer/organization';
import {
  completeReauthentication,
  consumeReauthenticationGrant,
  decideSupportAccess,
  grantRole,
  listActiveSupportSessions,
  oidcNonceDigest,
  requestSupportAccess,
  revokeSupportSession,
  startReauthentication,
  type StartedReauthentication,
} from '@dealer/identity-access';

/**
 * FBL-020 reauthentication negative matrix: single-use transactions,
 * auth_time-after-start proof, hash-only storage, binding to tenant/user/
 * action/resource, atomic consumption, fail-closed replay and rollback —
 * plus the delegated support-access lifecycle.
 */
describe(
  'reauthentication + support access',
  { skip: skipIntegration ? 'set TEST_DATABASE_URL to run' : false },
  () => {
    after(async () => {
      await closePool();
    });

    let tenantId: string;
    let userLinkId: string;
    /**
     * FBL-020-R3: a step-up is a statement about the person behind a LIVE local
     * session, and `startReauthentication` derives every identity fact from
     * that session rather than from anything a caller hands it. The suite
     * therefore holds a real session for the acting link.
     */
    let sessionId: string;

    beforeEach(async () => {
      await resetDatabase();
      const tenant = await createTenant({ name: 'Reauth Motors', status: 'active' });
      tenantId = tenant.tenantId;
      userLinkId = await makeUser(tenantId);
      sessionId = (await seedLocalSession(userLinkId)).sessionId;
    });

    async function makeUser(tenant: string | null): Promise<string> {
      await ensureActiveConnection(tenant);
      const result = await query(
        `INSERT INTO user_links
         (actor_scope, tenant_id, provider, provider_user_id, status, activated_at,
          connection_id, issuer, provider_organization_id)
       SELECT $1, $2, 'workos', $3, 'activated', NOW(),
              c.connection_id, c.issuer, c.provider_organization_id
         FROM identity_provider_connections c
        WHERE c.tenant_id IS NOT DISTINCT FROM $2 AND c.provider = 'workos' AND c.status = 'active'
        LIMIT 1
       RETURNING user_link_id`,
        [tenant === null ? 'platform' : 'dealership', tenant, 'user_' + randomUUID()],
      );
      return String((result.rows[0] as { user_link_id: unknown }).user_link_id);
    }

    /**
     * FBL-020-R3 section I: support access is no longer merely a
     * separation-of-duty exercise between two arbitrary identities. Filing
     * requires a CURRENT active platform-support actor, and deciding or
     * revoking requires a CURRENT tenant administrator of the target tenant.
     * These helpers give the lifecycle tests the authority the operation now
     * demands — an unauthorized identity is exercised in the boundary suite.
     */
    async function makePlatformSupportActor(): Promise<string> {
      const id = await makeUser(null);
      await grantRole({
        actingUserLinkId: await bootstrapAdministrator(null),
        tenantId: null,
        userLinkId: id,
        role: 'platform_support',
        scopeLevel: 'platform',
        scopeId: null,
      });
      return id;
    }

    async function makeTenantAdmin(tenant: string): Promise<string> {
      const id = await makeUser(tenant);
      await grantRole({
        actingUserLinkId: await bootstrapAdministrator(tenant),
        tenantId: tenant,
        userLinkId: id,
        role: 'tenant_admin',
        scopeLevel: 'tenant',
        scopeId: tenant,
      });
      return id;
    }

    const RO = randomUUID();

    /** The binding a GRANT is consumed against — no session, by design. */
    function startInput() {
      return {
        tenantId,
        userLinkId,
        action: 'service.ro.authorization.record',
        resourceType: 'repair_order',
        resourceId: RO,
      };
    }

    /** …and the same thing plus the live session a step-up starts FROM. */
    async function start(
      overrides: { ttlSeconds?: number } = {},
    ): Promise<StartedReauthentication> {
      const started = await startReauthentication({ ...startInput(), sessionId, ...overrides });
      assert.ok(started, 'the starting identity chain must hold');
      return started;
    }

    /**
     * Exactly what a real `/auth/reauth/callback` hands the completion: the
     * digest of the OIDC nonce the START generated and stored, and the four
     * identity facts a verified token proves. Every one of them is REQUIRED —
     * a missing value is a failure, not a skipped comparison — so the helper
     * builds the whole set and individual tests override one at a time.
     */
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

    test('happy path: start -> fresh auth_time -> ONE grant -> ONE consumption', async () => {
      const started = await start();
      assert.equal(started.transaction.state, 'started');
      // opaque values never hit the database
      const storedTxn = await query(
        `SELECT nonce_hash, oidc_nonce_hash, session_id FROM reauthentication_transactions`,
        [],
      );
      const stored = storedTxn.rows[0] as {
        nonce_hash: string;
        oidc_nonce_hash: string;
        session_id: string;
      };
      assert.notEqual(String(stored.nonce_hash), started.nonce);
      assert.notEqual(String(stored.oidc_nonce_hash), started.oidcNonce);
      // …and the transaction names the LIVE session it stepped up from
      assert.equal(String(stored.session_id), sessionId);

      const completed = await completeReauthentication(completionFor(started));
      assert.ok(completed);
      assert.equal(completed.transaction.state, 'completed');
      const storedGrant = await query(`SELECT grant_hash FROM reauthentication_grants`, []);
      assert.notEqual(
        String((storedGrant.rows[0] as { grant_hash: string }).grant_hash),
        completed.grant,
      );

      const consumed = await withTransaction((tx) =>
        consumeReauthenticationGrant(tx, { grant: completed.grant, ...startInput() }),
      );
      assert.equal(consumed, true);

      // replay fails closed
      const replay = await withTransaction((tx) =>
        consumeReauthenticationGrant(tx, { grant: completed.grant, ...startInput() }),
      );
      assert.equal(replay, false);
    });

    test('a stale auth_time (before the transaction started) mints NOTHING and fails the transaction', async () => {
      const started = await start();
      const stale = new Date(started.transaction.startedAt.getTime() - 10 * 60_000);
      const completed = await completeReauthentication({
        ...completionFor(started),
        verifiedAuthTime: stale,
      });
      assert.equal(completed, null);
      const txn = await query(`SELECT state FROM reauthentication_transactions`, []);
      assert.equal(String((txn.rows[0] as { state: string }).state), 'failed');
      const grants = await query(`SELECT COUNT(*)::int AS n FROM reauthentication_grants`, []);
      assert.equal(Number((grants.rows[0] as { n: number }).n), 0);
    });

    test('transactions are single-use: a completed nonce cannot complete again', async () => {
      const started = await start();
      assert.ok(await completeReauthentication(completionFor(started)));
      assert.equal(await completeReauthentication(completionFor(started)), null);
    });

    test('a nonce belongs to ONE user: another user cannot complete it', async () => {
      const started = await start();
      const otherUser = await makeUser(tenantId);
      assert.equal(
        await completeReauthentication({ ...completionFor(started), userLinkId: otherUser }),
        null,
      );
    });

    /**
     * FBL-020-R3: the STORED OIDC nonce participates in the completion.
     *
     * R2 wrote `oidc_nonce_hash` at start and then never read it, so the only
     * nonce check that ever ran was against the value the transaction COOKIE
     * carried. This test makes the stored digest the thing that matters: the
     * row's digest is replaced with another one, the caller still presents the
     * digest the provider genuinely returned, and the completion refuses —
     * terminally, minting nothing.
     */
    test('a completion whose STORED oidc nonce does not match mints nothing', async () => {
      const started = await start();
      // Somebody else's nonce, digested the same way the verifier digests the
      // claim it reads. The raw value never enters the table, only this digest.
      const foreign = oidcNonceDigest('a-nonce-this-transaction-never-issued');
      await query(
        `UPDATE reauthentication_transactions SET oidc_nonce_hash = $1 WHERE reauth_txn_id = $2`,
        [foreign, started.transaction.reauthTxnId],
      );

      assert.equal(
        await completeReauthentication(completionFor(started)),
        null,
        'the digest the provider returned must equal the digest the row stored',
      );
      const txn = await query(`SELECT state FROM reauthentication_transactions`, []);
      assert.equal(
        String((txn.rows[0] as { state: string }).state),
        'failed',
        'a nonce miss is terminal, not retryable',
      );
      const grants = await query(`SELECT COUNT(*)::int AS n FROM reauthentication_grants`, []);
      assert.equal(Number((grants.rows[0] as { n: number }).n), 0);
    });

    test('a MISSING verified value is a failure, never a skipped comparison', async () => {
      // A token that carried no nonce at all presents `null`. R2 read that as
      // "nothing to compare"; it now reads as "nothing was proved".
      for (const missing of [
        { verifiedNonceDigest: null },
        { verifiedIssuer: null },
        { verifiedOrganizationId: null },
        { verifiedProviderSubject: null },
        { verifiedConnectionId: null },
      ]) {
        const started = await start();
        assert.equal(
          await completeReauthentication({ ...completionFor(started), ...missing }),
          null,
          `a null ${Object.keys(missing)[0]} must fail closed`,
        );
        const state = await query(
          `SELECT state FROM reauthentication_transactions WHERE reauth_txn_id = $1`,
          [started.transaction.reauthTxnId],
        );
        assert.equal(String((state.rows[0] as { state: string }).state), 'failed');
      }
    });

    test('the START derives its binding; a caller belief that DISAGREES refuses', async () => {
      const started = await start();
      // The derived facts are the session's, not the caller's — the caller was
      // asked for none of them above and got them all back.
      assert.equal(started.binding.sessionId, sessionId);
      assert.equal(started.binding.issuer, testIssuer());

      // Stating something false refuses the start outright, and writes nothing.
      const before = Number(
        (
          (await query(`SELECT COUNT(*)::int AS n FROM reauthentication_transactions`, []))
            .rows[0] as { n: number }
        ).n,
      );
      assert.equal(
        await startReauthentication({
          ...startInput(),
          sessionId,
          expectedProviderSubject: 'somebody-else',
        }),
        null,
        'a disagreeing belief is refused, not adopted',
      );
      assert.equal(
        await startReauthentication({
          ...startInput(),
          sessionId,
          expectedIssuer: 'https://not-the-issuer.invalid',
        }),
        null,
      );
      const after = Number(
        (
          (await query(`SELECT COUNT(*)::int AS n FROM reauthentication_transactions`, []))
            .rows[0] as { n: number }
        ).n,
      );
      assert.equal(after, before, 'a refused start writes no row');
    });

    test('a step-up cannot start from — or complete without — a live local session', async () => {
      // revoked before the start: there is nothing to step up FROM
      await query(
        `UPDATE identity_sessions SET revoked_at = NOW(), revoked_reason = 'test' WHERE session_id = $1`,
        [sessionId],
      );
      assert.equal(await startReauthentication({ ...startInput(), sessionId }), null);

      // revoked BETWEEN start and callback: the grant would outlive the access
      // it steps up, so the completion refuses and mints nothing
      sessionId = (await seedLocalSession(userLinkId)).sessionId;
      const started = await start();
      await query(
        `UPDATE identity_sessions SET revoked_at = NOW(), revoked_reason = 'test' WHERE session_id = $1`,
        [sessionId],
      );
      assert.equal(await completeReauthentication(completionFor(started)), null);
      const grants = await query(`SELECT COUNT(*)::int AS n FROM reauthentication_grants`, []);
      assert.equal(Number((grants.rows[0] as { n: number }).n), 0);
    });

    test('grants are bound: wrong action, wrong resource, wrong user or wrong tenant all fail closed', async () => {
      const started = await start();
      const completed = await completeReauthentication(completionFor(started));
      assert.ok(completed);

      const otherTenant = await createTenant({ name: 'Other Reauth', status: 'active' });
      const otherUser = await makeUser(tenantId);
      interface ConsumeBinding {
        tenantId: string;
        userLinkId: string;
        action: string;
        resourceType?: string | null;
        resourceId?: string | null;
      }
      const attempts: ConsumeBinding[] = [
        { ...startInput(), action: 'service.ro.transition' },
        { ...startInput(), resourceId: randomUUID() },
        { ...startInput(), resourceType: 'service_appointment' },
        { ...startInput(), userLinkId: otherUser },
        { ...startInput(), tenantId: otherTenant.tenantId },
      ];
      for (const attempt of attempts) {
        const ok: boolean = await withTransaction((tx) =>
          consumeReauthenticationGrant(tx, { grant: completed.grant, ...attempt }),
        );
        assert.equal(ok, false, `mismatched consumption must fail: ${JSON.stringify(attempt)}`);
      }
      // the correctly bound consumption still works exactly once afterwards
      assert.equal(
        await withTransaction((tx) =>
          consumeReauthenticationGrant(tx, { grant: completed.grant, ...startInput() }),
        ),
        true,
      );
    });

    test('ROLLBACK leaves the grant unconsumed — the action it paid for never happened', async () => {
      const started = await start();
      const completed = await completeReauthentication(completionFor(started));
      assert.ok(completed);

      await assert.rejects(
        withTransaction(async (tx) => {
          assert.equal(
            await consumeReauthenticationGrant(tx, { grant: completed.grant, ...startInput() }),
            true,
          );
          throw new Error('business action failed after the spend');
        }),
      );
      // the spend rolled back with the business action; a real retry still works
      assert.equal(
        await withTransaction((tx) =>
          consumeReauthenticationGrant(tx, { grant: completed.grant, ...startInput() }),
        ),
        true,
      );
    });

    test('an expired transaction cannot complete; an expired grant cannot consume', async () => {
      const started = await start({ ttlSeconds: 60 });
      await query(
        `UPDATE reauthentication_transactions SET started_at = NOW() - INTERVAL '10 minutes', expires_at = NOW() - INTERVAL '5 minutes'`,
        [],
      );
      assert.equal(await completeReauthentication(completionFor(started)), null);

      await resetDatabase();
      const tenant = await createTenant({ name: 'Reauth Motors 2', status: 'active' });
      tenantId = tenant.tenantId;
      userLinkId = await makeUser(tenantId);
      sessionId = (await seedLocalSession(userLinkId)).sessionId;
      const fresh = await start();
      const completed = await completeReauthentication({
        ...completionFor(fresh),
        grantTtlSeconds: 60,
      });
      assert.ok(completed);
      await query(
        `UPDATE reauthentication_grants SET issued_at = NOW() - INTERVAL '10 minutes', expires_at = NOW() - INTERVAL '5 minutes'`,
        [],
      );
      assert.equal(
        await withTransaction((tx) =>
          consumeReauthenticationGrant(tx, { grant: completed.grant, ...startInput() }),
        ),
        false,
      );
    });

    test('support access lifecycle: request -> different-user approval -> live indicator -> revoke', async () => {
      const supportActor = await makePlatformSupportActor();
      const approver = await makeTenantAdmin(tenantId);

      const request = await requestSupportAccess({
        tenantId,
        requesterUserLinkId: supportActor,
        requestedActions: ['service.ro.view'],
        reason: 'ticket 7710: reconcile RO totals with the customer',
        requestedDurationMinutes: 45,
      });
      assert.equal(request.status, 'pending');

      // the reason NEVER enters audit details
      const audits = await query(
        `SELECT details FROM audit_events WHERE event_type = 'identity.support.requested'`,
        [],
      );
      assert.equal(audits.rows.length, 1);
      assert.ok(
        !JSON.stringify((audits.rows[0] as { details: unknown }).details).includes('ticket 7710'),
      );

      // R2: self-approval is refused BEFORE the database CHECK is reached,
      // because the approver's own high-assurance grant is validated first.
      // (The requester<>approver CHECK from 055 remains as the backstop.)
      assert.equal(
        await decideSupportAccess({
          requestId: request.requestId,
          decidedByUserLinkId: supportActor,
          approve: true,
          approvalGrant: null,
        }),
        null,
        'self-approval is refused',
      );

      // R2: an approval requires a HIGH-ASSURANCE grant belonging to the
      // approver. Separation of duty alone no longer suffices.
      assert.equal(
        await decideSupportAccess({
          requestId: request.requestId,
          decidedByUserLinkId: approver,
          approve: true,
        }),
        null,
        'approval without a high-assurance grant is refused',
      );

      const approvalGrant = await mintReauthGrant({
        tenantId,
        userLinkId: approver,
        action: 'identity.support.approve',
        resourceType: 'support_access_request',
        resourceId: request.requestId,
      });
      const session = await decideSupportAccess({
        requestId: request.requestId,
        decidedByUserLinkId: approver,
        approve: true,
        approvalGrant,
      });
      assert.ok(session);
      assert.ok(session.expiresAt.getTime() - session.grantedAt.getTime() <= 60 * 60_000);

      const live = await listActiveSupportSessions(tenantId);
      assert.equal(live.length, 1);
      assert.equal(live[0]!.actorUserLinkId, supportActor);

      assert.equal(
        await revokeSupportSession({
          supportSessionId: session.supportSessionId,
          revokedByUserLinkId: approver,
        }),
        true,
      );
      assert.deepEqual(await listActiveSupportSessions(tenantId), []);
      // second revoke is a no-op
      assert.equal(
        await revokeSupportSession({
          supportSessionId: session.supportSessionId,
          revokedByUserLinkId: approver,
        }),
        false,
      );
    });

    test('a denied request creates NO session; a decided request cannot be re-decided', async () => {
      const supportActor = await makePlatformSupportActor();
      const approver = await makeTenantAdmin(tenantId);
      const request = await requestSupportAccess({
        tenantId,
        requesterUserLinkId: supportActor,
        requestedActions: ['service.ro.view'],
        reason: 'ticket 8: check comeback linkage',
        requestedDurationMinutes: 15,
      });
      assert.equal(
        await decideSupportAccess({
          requestId: request.requestId,
          decidedByUserLinkId: approver,
          approve: false,
        }),
        null,
      );
      assert.deepEqual(await listActiveSupportSessions(tenantId), []);
      // already denied — a later approval attempt is a no-op
      assert.equal(
        await decideSupportAccess({
          requestId: request.requestId,
          decidedByUserLinkId: approver,
          approve: true,
        }),
        null,
      );
    });
  },
);
