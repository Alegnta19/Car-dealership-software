import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, beforeEach, describe, test } from 'node:test';
import {
  ensureActiveConnection,
  resetDatabase,
  skipIntegration,
  mintReauthGrant,
} from '@dealer/test-kit';
import { closePool, query, withTransaction } from '@dealer/database';
import { createTenant } from '@dealer/organization';
import {
  completeReauthentication,
  consumeReauthenticationGrant,
  decideSupportAccess,
  listActiveSupportSessions,
  requestSupportAccess,
  revokeSupportSession,
  startReauthentication,
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

    beforeEach(async () => {
      await resetDatabase();
      const tenant = await createTenant({ name: 'Reauth Motors', status: 'active' });
      tenantId = tenant.tenantId;
      userLinkId = await makeUser(tenantId);
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

    const RO = randomUUID();

    function startInput() {
      return {
        tenantId,
        userLinkId,
        action: 'service.ro.authorization.record',
        resourceType: 'repair_order',
        resourceId: RO,
      };
    }

    test('happy path: start -> fresh auth_time -> ONE grant -> ONE consumption', async () => {
      const started = await startReauthentication(startInput());
      assert.equal(started.transaction.state, 'started');
      // opaque values never hit the database
      const storedTxn = await query(`SELECT nonce_hash FROM reauthentication_transactions`, []);
      assert.notEqual(
        String((storedTxn.rows[0] as { nonce_hash: string }).nonce_hash),
        started.nonce,
      );

      const completed = await completeReauthentication({
        nonce: started.nonce,
        userLinkId,
        verifiedAuthTime: new Date(),
      });
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
      const started = await startReauthentication(startInput());
      const stale = new Date(started.transaction.startedAt.getTime() - 10 * 60_000);
      const completed = await completeReauthentication({
        nonce: started.nonce,
        userLinkId,
        verifiedAuthTime: stale,
      });
      assert.equal(completed, null);
      const txn = await query(`SELECT state FROM reauthentication_transactions`, []);
      assert.equal(String((txn.rows[0] as { state: string }).state), 'failed');
      const grants = await query(`SELECT COUNT(*)::int AS n FROM reauthentication_grants`, []);
      assert.equal(Number((grants.rows[0] as { n: number }).n), 0);
    });

    test('transactions are single-use: a completed nonce cannot complete again', async () => {
      const started = await startReauthentication(startInput());
      assert.ok(
        await completeReauthentication({
          nonce: started.nonce,
          userLinkId,
          verifiedAuthTime: new Date(),
        }),
      );
      assert.equal(
        await completeReauthentication({
          nonce: started.nonce,
          userLinkId,
          verifiedAuthTime: new Date(),
        }),
        null,
      );
    });

    test('a nonce belongs to ONE user: another user cannot complete it', async () => {
      const started = await startReauthentication(startInput());
      const otherUser = await makeUser(tenantId);
      assert.equal(
        await completeReauthentication({
          nonce: started.nonce,
          userLinkId: otherUser,
          verifiedAuthTime: new Date(),
        }),
        null,
      );
    });

    test('grants are bound: wrong action, wrong resource, wrong user or wrong tenant all fail closed', async () => {
      const started = await startReauthentication(startInput());
      const completed = await completeReauthentication({
        nonce: started.nonce,
        userLinkId,
        verifiedAuthTime: new Date(),
      });
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
      const started = await startReauthentication(startInput());
      const completed = await completeReauthentication({
        nonce: started.nonce,
        userLinkId,
        verifiedAuthTime: new Date(),
      });
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
      const started = await startReauthentication({ ...startInput(), ttlSeconds: 60 });
      await query(
        `UPDATE reauthentication_transactions SET started_at = NOW() - INTERVAL '10 minutes', expires_at = NOW() - INTERVAL '5 minutes'`,
        [],
      );
      assert.equal(
        await completeReauthentication({
          nonce: started.nonce,
          userLinkId,
          verifiedAuthTime: new Date(),
        }),
        null,
      );

      await resetDatabase();
      const tenant = await createTenant({ name: 'Reauth Motors 2', status: 'active' });
      tenantId = tenant.tenantId;
      userLinkId = await makeUser(tenantId);
      const fresh = await startReauthentication(startInput());
      const completed = await completeReauthentication({
        nonce: fresh.nonce,
        userLinkId,
        verifiedAuthTime: new Date(),
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
      const supportActor = await makeUser(null);
      const approver = await makeUser(tenantId);

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
          approvalGrantId: null,
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

      await mintReauthGrant({
        tenantId,
        userLinkId: approver,
        action: 'identity.support.approve',
        resourceId: randomUUID(),
      });
      const grantRow = await query(
        `UPDATE reauthentication_grants SET consumed_at = NOW()
          WHERE user_link_id = $1 AND action = 'identity.support.approve'
          RETURNING grant_id`,
        [approver],
      );
      const session = await decideSupportAccess({
        requestId: request.requestId,
        decidedByUserLinkId: approver,
        approve: true,
        approvalGrantId: String((grantRow.rows[0] as { grant_id: unknown }).grant_id),
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
      const supportActor = await makeUser(null);
      const approver = await makeUser(tenantId);
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
