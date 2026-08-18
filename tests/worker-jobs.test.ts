import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, beforeEach, describe, test } from 'node:test';
import {
  TEST_REAUTH_CALLBACK_URI,
  bootstrapAdministrator,
  ensureActiveConnection,
  fixtureAuthorizationStateWrite,
  mintReauthGrant,
  resetDatabase,
  seedLocalSession,
  seedTenantViaService,
  skipIntegration,
} from '@dealer/test-kit';
import { closePool, query } from '@dealer/database';
import {
  decideSupportAccess,
  expireDueSupportSessions,
  expireStaleLoginTransactions,
  expireStaleReauthenticationTransactions,
  grantRole,
  requestSupportAccess,
  revokeSupportSession,
  startLoginTransaction,
  startReauthentication,
} from '@dealer/identity-access';
import { runAllJobsOnce } from '@dealer/worker';

/**
 * FBL-020-R5 §4.8 — THE WORKER RUNS EVERY EXPIRY SWEEP THAT EXISTS.
 *
 * ── THE DEFECT THIS BATTERY EXISTS FOR ──────────────────────────────────────
 *
 * Three expiry transitions were implemented and audited: support windows, login
 * transactions and reauthentication step-ups. Exactly ONE of them was registered in the
 * worker. `expireStaleLoginTransactions` and `expireStaleReauthenticationTransactions`
 * were reachable only from tests — their own doc comments call them "housekeeping for
 * the scheduled aggregator" while the aggregator scheduled neither — so on a deployed
 * system an abandoned login stayed `pending` for ever, an uncompleted step-up stayed
 * `started` for ever, and the `identity.login.expired` / `identity.reauthentication.
 * expired` rows the audit inventory promises were written only when a test asked for
 * them. FBL-020-R3 was rejected once for exactly this shape: an implemented flow that
 * nothing in production reaches.
 *
 * ── WHAT IS PROVED HERE, AND HOW HARD ───────────────────────────────────────
 *
 * For EACH of the three kinds, a row seeded expired is transitioned by ONE pass of
 * `runAllJobsOnce` — the exact function `main --once` calls — and audited EXACTLY ONCE,
 * and a SECOND pass writes no second audit row and moves nothing.
 *
 * That last clause is what makes these tests kill a mutation rather than decorate one.
 * Asserting only "the row changed" would still pass with the sweep running twice, and
 * asserting only the count returned by the sweep would pass with no audit row at all.
 *
 * The COMPILED entry point's advertised job list is held to this registry in
 * `tests/worker-entrypoint.test.ts`, which is separate because the mutation-kill copy
 * carries no `dist/`.
 */

describe(
  'every registered worker job performs its transition exactly once (FBL-020-R5 §4.8)',
  { skip: skipIntegration ? 'set TEST_DATABASE_URL to run' : false },
  () => {
    const LOGIN_REDIRECT = 'http://127.0.0.1:3000/auth/callback';
    let tenantId: string;

    after(async () => {
      await closePool();
    });

    beforeEach(async () => {
      await resetDatabase();
      tenantId = (await seedTenantViaService({ name: 'Sweep Motors', status: 'active' })).tenantId;
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

    async function eventCount(eventType: string, entityId: string): Promise<number> {
      const r = await query(
        `SELECT COUNT(*)::int AS n FROM audit_events WHERE event_type = $1 AND entity_id = $2`,
        [eventType, entityId],
      );
      return Number((r.rows[0] as { n: number }).n);
    }

    async function scalar(sql: string, id: string): Promise<Record<string, unknown>> {
      const r = await query(sql, [id]);
      return r.rows[0] as Record<string, unknown>;
    }

    // ── job 2: login transactions ────────────────────────────────────────────
    test('the worker pass ages a stale LOGIN transaction, exactly once', async () => {
      const stale = await startLoginTransaction({ purpose: 'login', redirectUri: LOGIN_REDIRECT });
      // Only the clock moves. A DECLARED fixture bypass: no production service back-dates
      // a login transaction, and back-dating is precisely the state the sweep is for.
      await query(
        `UPDATE login_transactions
            SET created_at = NOW() - INTERVAL '2 hours', expires_at = NOW() - INTERVAL '1 hour'
          WHERE login_txn_id = $1`,
        [stale.loginTxnId],
      );
      assert.equal(
        (
          await scalar(
            `SELECT status FROM login_transactions WHERE login_txn_id = $1`,
            stale.loginTxnId,
          )
        ).status,
        'pending',
        'sanity: the transaction is still pending before the worker runs',
      );

      await runAllJobsOnce();

      const row = await scalar(
        `SELECT status, failure_reason FROM login_transactions WHERE login_txn_id = $1`,
        stale.loginTxnId,
      );
      assert.equal(row.status, 'failed');
      assert.equal(row.failure_reason, 'expired');
      assert.equal(await eventCount('identity.login.expired', stale.loginTxnId), 1);

      // EXACTLY once: a second pass finds nothing to do and writes no second row.
      await runAllJobsOnce();
      assert.equal(
        await eventCount('identity.login.expired', stale.loginTxnId),
        1,
        'a second worker pass must not re-expire an already-expired transaction',
      );
    });

    // ── job 3: reauthentication step-ups ─────────────────────────────────────
    test('the worker pass ages a stale STEP-UP, exactly once', async () => {
      const userLinkId = await makeUser(tenantId);
      const { sessionId } = await seedLocalSession(userLinkId);
      const started = await startReauthentication({
        tenantId,
        userLinkId,
        sessionId,
        action: 'service.ro.transition:authorized',
        resourceType: 'repair_order',
        resourceId: randomUUID(),
        callbackUri: TEST_REAUTH_CALLBACK_URI,
      });
      assert.ok(started, 'sanity: the step-up must start');
      const reauthTxnId = started.transaction.reauthTxnId;
      await query(
        `UPDATE reauthentication_transactions
            SET started_at = NOW() - INTERVAL '2 hours', expires_at = NOW() - INTERVAL '1 hour'
          WHERE reauth_txn_id = $1`,
        [reauthTxnId],
      );
      assert.equal(
        (
          await scalar(
            `SELECT state FROM reauthentication_transactions WHERE reauth_txn_id = $1`,
            reauthTxnId,
          )
        ).state,
        'started',
        'sanity: the step-up is still started before the worker runs',
      );

      await runAllJobsOnce();

      const row = await scalar(
        `SELECT state, terminal_reason, terminal_at FROM reauthentication_transactions
          WHERE reauth_txn_id = $1`,
        reauthTxnId,
      );
      assert.equal(row.state, 'expired');
      assert.equal(row.terminal_reason, 'expired');
      assert.notEqual(row.terminal_at, null);
      assert.equal(await eventCount('identity.reauthentication.expired', reauthTxnId), 1);

      await runAllJobsOnce();
      assert.equal(
        await eventCount('identity.reauthentication.expired', reauthTxnId),
        1,
        'a second worker pass must not re-expire an already-expired step-up',
      );
    });

    // ── job 1: support windows (the sweep that WAS registered) ───────────────
    test('the worker pass closes an expired SUPPORT window, exactly once', async () => {
      const actor = await makeUser(null);
      await grantRole({
        actingUserLinkId: await bootstrapAdministrator(null),
        tenantId: null,
        userLinkId: actor,
        role: 'platform_support',
        scopeLevel: 'platform',
        scopeId: null,
      });
      const approver = await makeUser(tenantId);
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
        requesterUserLinkId: actor,
        requestedActions: ['service.ro.view'],
        reason: 'ticket 77: the customer reports a missing line',
        requestedDurationMinutes: 30,
      });
      const session = await decideSupportAccess({
        requestId: request.requestId,
        decidedByUserLinkId: approver,
        approve: true,
        approvalGrant: await mintReauthGrant({
          tenantId,
          userLinkId: approver,
          action: 'identity.support.approve',
          resourceType: 'support_access_request',
          resourceId: request.requestId,
        }),
      });
      assert.ok(session, 'sanity: the support session must have started');
      await fixtureAuthorizationStateWrite(
        'simulate-authorization-drift',
        `UPDATE support_access_sessions
            SET granted_at = NOW() - INTERVAL '90 minutes',
                expires_at = NOW() - INTERVAL '31 minutes'
          WHERE support_session_id = $1`,
        [session.supportSessionId],
      );

      await runAllJobsOnce();

      const row = await scalar(
        `SELECT expired_at, revoked_at FROM support_access_sessions WHERE support_session_id = $1`,
        session.supportSessionId,
      );
      assert.ok(row.expired_at instanceof Date, 'the window must be recorded as expired');
      assert.equal(row.revoked_at, null, 'expiry is not revocation');
      assert.equal(await eventCount('identity.support.expired', session.supportSessionId), 1);

      await runAllJobsOnce();
      assert.equal(
        await eventCount('identity.support.expired', session.supportSessionId),
        1,
        'a second worker pass must not re-close an already-closed window',
      );
    });

    // ── FBL-020-R5 §1.6: BOUNDED, AND CONCURRENCY-SAFE ───────────────────────
    //
    // Registration and idempotency are proved above. §1.6 names two more properties
    // that R4's sweeps did not have, because both were ONE unbounded UPDATE over the
    // whole backlog with the audit rows written in a loop inside the same
    // transaction:
    //
    //   BOUNDED — the size of the work decided the size of the transaction, so a
    //   backlog (an outage, a first deployment, a burst of abandoned logins) meant
    //   one statement locking every matching row and one pool connection held for as
    //   long as it took. That is the shape that turns a backlog into an outage.
    //
    //   CONCURRENCY-SAFE — two workers were SAFE (the second matched nothing) but
    //   not INDEPENDENT: the loser blocked on the winner's row locks for the whole
    //   pass instead of taking other work.
    //
    // Both sweeps now claim ONE row per short transaction under `FOR UPDATE SKIP
    // LOCKED`, at most `limit` times.

    /** Opens `count` login transactions and back-dates every one of them. */
    async function staleLogins(count: number): Promise<string[]> {
      const ids: string[] = [];
      for (let i = 0; i < count; i += 1) {
        const t = await startLoginTransaction({ purpose: 'login', redirectUri: LOGIN_REDIRECT });
        ids.push(t.loginTxnId);
      }
      await query(
        `UPDATE login_transactions
            SET created_at = NOW() - INTERVAL '2 hours', expires_at = NOW() - INTERVAL '1 hour'
          WHERE login_txn_id = ANY($1::uuid[])`,
        [ids],
      );
      return ids;
    }

    test('the login-transaction sweep is BOUNDED by its limit, and refuses one outside its range', async () => {
      const ids = await staleLogins(3);

      assert.equal(
        await expireStaleLoginTransactions({ limit: 1 }),
        1,
        'a pass may not age more rows than it was asked to',
      );
      const agedAfterFirst = await query(
        `SELECT COUNT(*)::int AS n FROM login_transactions
          WHERE login_txn_id = ANY($1::uuid[]) AND status = 'failed'`,
        [ids],
      );
      assert.equal(Number((agedAfterFirst.rows[0] as { n: number }).n), 1);

      assert.equal(await expireStaleLoginTransactions({ limit: 2 }), 2, 'the rest, next pass');
      assert.equal(
        await expireStaleLoginTransactions({ limit: 2 }),
        0,
        'and a pass with nothing to do stops immediately rather than spinning to its limit',
      );
      for (const id of ids) {
        assert.equal(await eventCount('identity.login.expired', id), 1);
      }

      // A limit that is not a whole number in range is a programming error, not a
      // value to clamp: clamping would silently change how much work a deployment
      // does, which is the opposite of bounded.
      for (const bad of [0, -1, 1.5, 1001, Number.NaN]) {
        await assert.rejects(
          () => expireStaleLoginTransactions({ limit: bad }),
          RangeError,
          `limit ${String(bad)} must be refused`,
        );
      }
    });

    test('CONCURRENT login-transaction sweeps age each stale transaction exactly once', async () => {
      const ids = await staleLogins(6);

      // Two passes started together against the same backlog. Neither is allowed to
      // double-count, and between them they must finish the work.
      const [a, b] = await Promise.all([
        expireStaleLoginTransactions(),
        expireStaleLoginTransactions(),
      ]);
      assert.equal(
        a + b,
        ids.length,
        'between them the two passes age every row, and no row twice',
      );

      for (const id of ids) {
        assert.equal(
          await eventCount('identity.login.expired', id),
          1,
          'exactly one expiry event per transaction, whichever pass won it',
        );
      }
      const left = await query(
        `SELECT COUNT(*)::int AS n FROM login_transactions
          WHERE login_txn_id = ANY($1::uuid[]) AND status <> 'failed'`,
        [ids],
      );
      assert.equal(Number((left.rows[0] as { n: number }).n), 0, 'nothing was skipped');
    });

    /** Starts `count` step-ups for one user and back-dates every one of them. */
    async function staleStepUps(count: number): Promise<string[]> {
      const userLinkId = await makeUser(tenantId);
      const ids: string[] = [];
      for (let i = 0; i < count; i += 1) {
        const { sessionId } = await seedLocalSession(userLinkId);
        const started = await startReauthentication({
          tenantId,
          userLinkId,
          sessionId,
          action: 'service.ro.transition:authorized',
          resourceType: 'repair_order',
          resourceId: randomUUID(),
          callbackUri: TEST_REAUTH_CALLBACK_URI,
        });
        assert.ok(started, 'sanity: the step-up must start');
        ids.push(started.transaction.reauthTxnId);
      }
      await query(
        `UPDATE reauthentication_transactions
            SET started_at = NOW() - INTERVAL '2 hours', expires_at = NOW() - INTERVAL '1 hour'
          WHERE reauth_txn_id = ANY($1::uuid[])`,
        [ids],
      );
      return ids;
    }

    test('the STEP-UP sweep is BOUNDED by its limit, and refuses one outside its range', async () => {
      const ids = await staleStepUps(3);

      assert.equal(await expireStaleReauthenticationTransactions({ limit: 1 }), 1);
      assert.equal(await expireStaleReauthenticationTransactions({ limit: 5 }), 2);
      assert.equal(await expireStaleReauthenticationTransactions({ limit: 5 }), 0);
      for (const id of ids) {
        assert.equal(await eventCount('identity.reauthentication.expired', id), 1);
      }
      for (const bad of [0, -1, 1.5, 1001, Number.NaN]) {
        await assert.rejects(
          () => expireStaleReauthenticationTransactions({ limit: bad }),
          RangeError,
          `limit ${String(bad)} must be refused`,
        );
      }
    });

    test('CONCURRENT step-up sweeps expire each transaction exactly once', async () => {
      const ids = await staleStepUps(6);

      const [a, b] = await Promise.all([
        expireStaleReauthenticationTransactions(),
        expireStaleReauthenticationTransactions(),
      ]);
      assert.equal(a + b, ids.length);

      for (const id of ids) {
        assert.equal(await eventCount('identity.reauthentication.expired', id), 1);
      }
      const left = await query(
        `SELECT COUNT(*)::int AS n FROM reauthentication_transactions
          WHERE reauth_txn_id = ANY($1::uuid[]) AND state <> 'expired'`,
        [ids],
      );
      assert.equal(Number((left.rows[0] as { n: number }).n), 0);
    });

    // ── FBL-020-R5 §1.10: THE EXPIRY OWNS THE ENDING ─────────────────────────
    //
    // "A support session whose expiry instant has passed must receive the expiry
    // transition; a later human revocation must not steal or relabel that ending."
    //
    // Migration 057's `sas_ends_once_and_one_way` closed the SECOND ordering already
    // — once the sweep has recorded an expiry, a revocation fails loudly. The first
    // ordering was open, and it is the common one: between the expiry INSTANT and
    // the sweep's next pass (typically the whole worker interval) a revocation
    // landed, the row became unexpirable, and the trail recorded
    // `identity.support.revoked` — naming a person as the author of an ending a
    // clock had already made, and losing the `identity.support.expired` event the
    // audit inventory promises. Both orderings are driven below.

    /** An approved, live support window, plus the tenant admin who may revoke it. */
    async function liveSupportWindow(): Promise<{
      supportSessionId: string;
      approver: string;
      actor: string;
    }> {
      const actor = await makeUser(null);
      await grantRole({
        actingUserLinkId: await bootstrapAdministrator(null),
        tenantId: null,
        userLinkId: actor,
        role: 'platform_support',
        scopeLevel: 'platform',
        scopeId: null,
      });
      const approver = await makeUser(tenantId);
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
        requesterUserLinkId: actor,
        requestedActions: ['service.ro.view'],
        reason: 'ticket 91: precedence of endings',
        requestedDurationMinutes: 30,
      });
      const session = await decideSupportAccess({
        requestId: request.requestId,
        decidedByUserLinkId: approver,
        approve: true,
        approvalGrant: await mintReauthGrant({
          tenantId,
          userLinkId: approver,
          action: 'identity.support.approve',
          resourceType: 'support_access_request',
          resourceId: request.requestId,
        }),
      });
      assert.ok(session, 'sanity: the support session must have started');
      return { supportSessionId: session.supportSessionId, approver, actor };
    }

    /** Moves a window's expiry into the past without touching anything else. */
    async function lapse(supportSessionId: string): Promise<void> {
      await fixtureAuthorizationStateWrite(
        'simulate-authorization-drift',
        `UPDATE support_access_sessions
            SET granted_at = NOW() - INTERVAL '90 minutes',
                expires_at = NOW() - INTERVAL '31 minutes'
          WHERE support_session_id = $1`,
        [supportSessionId],
      );
    }

    test('ORDERING A — a window that has LAPSED but not yet been swept cannot be revoked', async () => {
      const { supportSessionId, approver } = await liveSupportWindow();

      // sanity: while it is RUNNING, this very administrator can revoke it. Without
      // this leg the assertion below would pass for an actor who simply had no
      // authority, which proves nothing about precedence.
      const running = await liveSupportWindow();
      assert.equal(
        await revokeSupportSession({
          supportSessionId: running.supportSessionId,
          revokedByUserLinkId: running.approver,
        }),
        true,
        'CONTROL: a live window is revocable by this administrator',
      );

      await lapse(supportSessionId);
      assert.equal(
        await revokeSupportSession({ supportSessionId, revokedByUserLinkId: approver }),
        false,
        'the clock has already ended this window; a human may not claim the ending',
      );
      const afterAttempt = await scalar(
        `SELECT revoked_at, expired_at FROM support_access_sessions WHERE support_session_id = $1`,
        supportSessionId,
      );
      assert.equal(afterAttempt.revoked_at, null, 'and nothing was written');
      assert.equal(afterAttempt.expired_at, null);
      assert.equal(await eventCount('identity.support.revoked', supportSessionId), 0);

      // …and the sweep then records the ending that actually happened.
      await runAllJobsOnce();
      const swept = await scalar(
        `SELECT revoked_at, expired_at FROM support_access_sessions WHERE support_session_id = $1`,
        supportSessionId,
      );
      assert.ok(swept.expired_at instanceof Date, 'the expiry transition still lands');
      assert.equal(swept.revoked_at, null);
      assert.equal(await eventCount('identity.support.expired', supportSessionId), 1);
      assert.equal(await eventCount('identity.support.revoked', supportSessionId), 0);
    });

    test('ORDERING B — a window already EXPIRED by the sweep cannot be relabelled a revocation', async () => {
      const { supportSessionId, approver } = await liveSupportWindow();
      await lapse(supportSessionId);
      assert.equal(await expireDueSupportSessions().then((x) => x.length), 1);
      assert.equal(await eventCount('identity.support.expired', supportSessionId), 1);

      assert.equal(
        await revokeSupportSession({ supportSessionId, revokedByUserLinkId: approver }),
        false,
        'a recorded expiry is the ending; a later revocation may not steal it',
      );
      const row = await scalar(
        `SELECT revoked_at, expired_at, revoked_by_user_link_id
           FROM support_access_sessions WHERE support_session_id = $1`,
        supportSessionId,
      );
      assert.equal(row.revoked_at, null);
      assert.equal(row.revoked_by_user_link_id, null, 'and nobody is named as its author');
      assert.ok(row.expired_at instanceof Date);
      assert.equal(await eventCount('identity.support.revoked', supportSessionId), 0);
      assert.equal(
        await eventCount('identity.support.expired', supportSessionId),
        1,
        'still exactly one ending, still the true one',
      );
    });
  },
);
