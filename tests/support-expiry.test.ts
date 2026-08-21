import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, beforeEach, describe, test } from 'node:test';
import {
  bootstrapAdministrator,
  ensureActiveConnection,
  fixtureAuthorizationStateWrite,
  mintReauthGrant,
  resetDatabase,
  seedTenantViaService,
  skipIntegration,
  shiftSupportWindowIntoThePast,
} from '@dealer/test-kit';
import { closePool, query } from '@dealer/database';
import {
  SUPPORT_SESSION_EXPIRED_EVENT,
  decideSupportAccess,
  expireDueSupportSessions,
  grantRole,
  listActiveSupportSessions,
  requestSupportAccess,
  revokeSupportSession,
} from '@dealer/identity-access';
import { SUPPORT_ACCESS_EXPIRY_JOB, WORKER_JOBS, runSupportAccessExpiryOnce } from '@dealer/worker';

/**
 * FBL-020-R4 §4 — THE SUPPORT-EXPIRY TRANSITION.
 *
 * R3 filtered expired support sessions out of every read and called it done: access did
 * stop at the right instant, but no row changed, no `authorization_version` advanced and
 * no audit event was written, so the trail recorded every support window a PERSON ended
 * and none that simply ran out. "Its hour passed" and "it is still open" were the same
 * evidence.
 *
 * What is proved here, in the order the risks matter:
 *   1. the transition happens, once, with its version and its single audit row;
 *   2. repeating it is a no-op — no second audit row, no second version bump;
 *   3. CONCURRENT processors cannot double-transition anything (three at once, and the
 *      count of transitions must equal the count of due sessions exactly);
 *   4. a live window is not touched, and a revoked one is not re-ended;
 *   5. the database refuses an expiry recorded EARLY and refuses a session that claims
 *      both endings, so the invariants do not depend on this processor being the only
 *      writer;
 *   6. the flow is reachable from the WORKER — the thing production runs.
 */
describe(
  'support access expiry (FBL-020-R4 §4)',
  { skip: skipIntegration ? 'set TEST_DATABASE_URL to run' : false },
  () => {
    after(async () => {
      await closePool();
    });

    let tenantId: string;

    beforeEach(async () => {
      await resetDatabase();
      tenantId = (await seedTenantViaService({ name: 'Expiry Motors', status: 'active' })).tenantId;
    });

    async function makeUser(tenant: string | null): Promise<string> {
      await ensureActiveConnection(tenant);
      const result = await fixtureAuthorizationStateWrite(
        'seed-authorization-state',
        `INSERT INTO user_links
           (actor_scope, tenant_id, provider, provider_user_id, status, activated_at,
            connection_id, issuer, provider_organization_id)
         SELECT $1, $2, 'workos', $3, 'activated', NOW(),
                c.connection_id, c.issuer, c.provider_organization_id
           FROM identity_provider_connections c
          WHERE c.tenant_id IS NOT DISTINCT FROM $2 AND c.provider = 'workos'
            AND c.status = 'active'
          LIMIT 1
         RETURNING user_link_id`,
        [tenant === null ? 'platform' : 'dealership', tenant, 'user_' + randomUUID()],
      );
      return String((result.rows[0] as { user_link_id: unknown }).user_link_id);
    }

    async function platformSupportActor(): Promise<string> {
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

    async function tenantAdmin(): Promise<string> {
      const id = await makeUser(tenantId);
      await grantRole({
        actingUserLinkId: await bootstrapAdministrator(tenantId),
        tenantId,
        userLinkId: id,
        role: 'tenant_admin',
        scopeLevel: 'tenant',
        scopeId: tenantId,
      });
      return id;
    }

    /**
     * ONE live support session, through the whole production path: a platform-support
     * actor files, a DIFFERENT tenant administrator approves with a real single-use
     * high-assurance grant, and the approval starts the session. Nothing about the
     * session row is hand-written — which matters, because a fixture-built session would
     * not prove the processor works on the rows the platform actually creates.
     */
    async function liveSupportSession(): Promise<{
      supportSessionId: string;
      requestId: string;
      actor: string;
    }> {
      const actor = await platformSupportActor();
      const approver = await tenantAdmin();
      const request = await requestSupportAccess({
        tenantId,
        requesterUserLinkId: actor,
        requestedActions: ['service.ro.view'],
        reason: 'ticket 41: the customer reports a missing line',
        requestedDurationMinutes: 30,
      });
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
      assert.ok(session, 'the support session must have started');
      return {
        supportSessionId: session.supportSessionId,
        requestId: session.requestId,
        actor,
      };
    }

    /**
     * Moves a live window into the past — through the R7 rebuild, because the
     * window itself is immutable now (§3.2). Only the clock moves: the reborn
     * rows carry the same ids, values, versions and attribution.
     */
    async function lapse(supportSessionId: string): Promise<void> {
      await shiftSupportWindowIntoThePast(supportSessionId);
    }

    async function sessionRow(supportSessionId: string): Promise<{
      expired_at: Date | null;
      revoked_at: Date | null;
      authorization_version: number;
    }> {
      const r = await query(
        `SELECT expired_at, revoked_at, authorization_version FROM support_access_sessions
          WHERE support_session_id = $1`,
        [supportSessionId],
      );
      const row = r.rows[0] as {
        expired_at: Date | null;
        revoked_at: Date | null;
        authorization_version: string | number;
      };
      return {
        expired_at: row.expired_at,
        revoked_at: row.revoked_at,
        authorization_version: Number(row.authorization_version),
      };
    }

    async function expiryEvents(
      supportSessionId: string,
    ): Promise<Array<{ actor_user_id: string | null; details: Record<string, unknown> }>> {
      const r = await query(
        `SELECT actor_user_id, details FROM audit_events
          WHERE entity_type = 'support_access_session' AND entity_id = $1 AND event_type = $2
          ORDER BY created_at`,
        [supportSessionId, SUPPORT_SESSION_EXPIRED_EVENT],
      );
      return r.rows as Array<{ actor_user_id: string | null; details: Record<string, unknown> }>;
    }

    test('a lapsed window is transitioned ONCE, with its version and one audit row', async () => {
      const live = await liveSupportSession();
      const before = await sessionRow(live.supportSessionId);
      assert.equal(before.expired_at, null, 'a live window carries no expiry transition');
      assert.equal(before.authorization_version, 1);

      await lapse(live.supportSessionId);
      const recorded = await expireDueSupportSessions();
      assert.equal(recorded.length, 1);
      assert.equal(recorded[0]!.supportSessionId, live.supportSessionId);
      assert.equal(recorded[0]!.requestId, live.requestId);
      assert.equal(recorded[0]!.actorUserLinkId, live.actor);
      assert.equal(recorded[0]!.tenantId, tenantId);
      assert.equal(recorded[0]!.authorizationVersion, 2);

      const after = await sessionRow(live.supportSessionId);
      assert.ok(after.expired_at instanceof Date, 'the transition is recorded on the row');
      assert.equal(after.revoked_at, null, 'an expiry is not a revocation');
      assert.equal(after.authorization_version, 2);

      // ONE audit event, naming NO author — a clock is not a person — and carrying the
      // subject, the approving request and the window it closed.
      const events = await expiryEvents(live.supportSessionId);
      assert.equal(events.length, 1);
      assert.equal(events[0]!.actor_user_id, null);
      const details = events[0]!.details;
      assert.equal(details.actor_type, 'system');
      assert.equal(details.processor, 'support_access_expiry');
      assert.equal(details.actor_user_link_id, live.actor);
      assert.equal(details.request_id, live.requestId);
      assert.equal(details.authorization_version, 2);
      assert.ok(typeof details.expires_at === 'string');
      // The free-text reason never travels: not in the event, not anywhere near it.
      assert.ok(
        !JSON.stringify(details).includes('ticket 41'),
        'the support reason must never reach an audit event',
      );
    });

    test('repeated processing is idempotent: no second audit row, no second version bump', async () => {
      const live = await liveSupportSession();
      await lapse(live.supportSessionId);
      assert.equal((await expireDueSupportSessions()).length, 1);

      for (let i = 0; i < 3; i += 1) {
        assert.equal(
          (await expireDueSupportSessions()).length,
          0,
          'a second pass must find nothing to do',
        );
      }
      const after = await sessionRow(live.supportSessionId);
      assert.equal(after.authorization_version, 2, 'the version advanced exactly once');
      assert.equal((await expiryEvents(live.supportSessionId)).length, 1);
    });

    test('CONCURRENT processors transition each window exactly once', async () => {
      // Six due windows, three processors running at the same time. The claim and the
      // write are one statement, so the only safe outcome is six transitions in total —
      // never seven, and never five with one row locked out for ever.
      const sessions: string[] = [];
      for (let i = 0; i < 6; i += 1) {
        const live = await liveSupportSession();
        await lapse(live.supportSessionId);
        sessions.push(live.supportSessionId);
      }

      const passes = await Promise.all([
        expireDueSupportSessions(),
        expireDueSupportSessions(),
        expireDueSupportSessions(),
      ]);
      const transitioned = passes.flat().map((r) => r.supportSessionId);
      assert.equal(transitioned.length, 6, 'exactly the due windows, no more and no fewer');
      assert.equal(new Set(transitioned).size, 6, 'no window was transitioned twice');
      assert.deepEqual([...transitioned].sort(), [...sessions].sort());

      for (const id of sessions) {
        const row = await sessionRow(id);
        assert.ok(row.expired_at instanceof Date);
        assert.equal(row.authorization_version, 2, `${id}: exactly one version advance`);
        assert.equal((await expiryEvents(id)).length, 1, `${id}: exactly one audit row`);
      }
      const total = await query(
        `SELECT COUNT(*)::int AS n FROM audit_events WHERE event_type = $1`,
        [SUPPORT_SESSION_EXPIRED_EVENT],
      );
      assert.equal(Number((total.rows[0] as { n: number }).n), 6);
    });

    test('a LIVE window is not transitioned, and stays visible as an active grant', async () => {
      const live = await liveSupportSession();
      assert.equal((await expireDueSupportSessions()).length, 0);
      const row = await sessionRow(live.supportSessionId);
      assert.equal(row.expired_at, null);
      assert.equal(row.authorization_version, 1);
      const active = await listActiveSupportSessions(tenantId);
      assert.equal(active.length, 1);
      assert.equal(active[0]!.supportSessionId, live.supportSessionId);
    });

    test('a REVOKED window is not re-ended by the processor', async () => {
      const live = await liveSupportSession();
      const admin = await tenantAdmin();
      assert.equal(
        await revokeSupportSession({
          supportSessionId: live.supportSessionId,
          revokedByUserLinkId: admin,
        }),
        true,
      );
      const afterRevoke = await sessionRow(live.supportSessionId);
      assert.ok(afterRevoke.revoked_at instanceof Date);

      // …even once its expiry instant has passed: the window ended when a person ended
      // it, and that attribution must not be overwritten by the clock.
      await lapse(live.supportSessionId);
      assert.equal((await expireDueSupportSessions()).length, 0);
      const after = await sessionRow(live.supportSessionId);
      assert.equal(after.expired_at, null);
      assert.equal(
        after.authorization_version,
        afterRevoke.authorization_version,
        'nothing about a revoked window changed',
      );
      assert.equal((await expiryEvents(live.supportSessionId)).length, 0);
    });

    test('the DATABASE refuses an expiry recorded EARLY', async () => {
      const live = await liveSupportSession();
      await assert.rejects(
        fixtureAuthorizationStateWrite(
          'adversarial-bypass-attempt',
          `UPDATE support_access_sessions SET expired_at = NOW() WHERE support_session_id = $1`,
          [live.supportSessionId],
        ),
        /sas_expiry_is_not_early/,
        'a live window cannot be retired by claiming it expired — that act is revocation',
      );
    });

    test('the DATABASE refuses a window that claims BOTH endings', async () => {
      const live = await liveSupportSession();
      await lapse(live.supportSessionId);
      assert.equal((await expireDueSupportSessions()).length, 1);
      await assert.rejects(
        fixtureAuthorizationStateWrite(
          'adversarial-bypass-attempt',
          `UPDATE support_access_sessions SET revoked_at = NOW() WHERE support_session_id = $1`,
          [live.supportSessionId],
        ),
        /sas_ends_once_and_one_way/,
        'a window ends once, one way — otherwise the trail depends on write order',
      );
    });

    test('the WORKER is where this runs in production', async () => {
      // The job is registered under the name the deployment smoke test greps for…
      assert.ok(WORKER_JOBS.includes(SUPPORT_ACCESS_EXPIRY_JOB));
      assert.equal(SUPPORT_ACCESS_EXPIRY_JOB, 'identity.support_access.expiry');

      // …and driving the worker's own pass — the exact function `main --once` calls —
      // performs the transition. R3 was rejected for shipping a flow nothing reached;
      // this asserts the reachable one works, rather than a copy of it.
      const live = await liveSupportSession();
      await lapse(live.supportSessionId);
      assert.equal(await runSupportAccessExpiryOnce(), 1);
      assert.ok((await sessionRow(live.supportSessionId)).expired_at instanceof Date);
      assert.equal(await runSupportAccessExpiryOnce(), 0);
    });

    test('the batch limit is bounded and validated', async () => {
      await assert.rejects(() => expireDueSupportSessions({ limit: 0 }), RangeError);
      await assert.rejects(() => expireDueSupportSessions({ limit: 1001 }), RangeError);
      await assert.rejects(() => expireDueSupportSessions({ limit: 1.5 }), RangeError);

      // A bounded pass leaves the rest for the next one rather than silently dropping it.
      const first = await liveSupportSession();
      const second = await liveSupportSession();
      await lapse(first.supportSessionId);
      await lapse(second.supportSessionId);
      assert.equal((await expireDueSupportSessions({ limit: 1 })).length, 1);
      assert.equal((await expireDueSupportSessions({ limit: 1 })).length, 1);
      assert.equal((await expireDueSupportSessions({ limit: 1 })).length, 0);
    });
  },
);
