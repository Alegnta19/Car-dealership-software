import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, beforeEach, describe, test } from 'node:test';
import {
  TEST_REAUTH_CALLBACK_URI,
  bootstrapAdministrator,
  seedDealerGroup,
  seedLegalEntity,
  seedRooftop,
  ensureActiveConnection,
  fixtureAuthorizationStateWrite,
  mintReauthGrant,
  resetDatabase,
  seedLocalSession,
  seedTenantViaService,
  skipIntegration,
  shiftSupportWindowIntoThePast,
} from '@dealer/test-kit';
import { closePool, query } from '@dealer/database';
import {
  TENANT_ADMIN_ROLE,
  createStaffInvitation,
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
import { LOGIN_TRANSACTION_EXPIRY_JOB, main, runAllJobsOnce } from '@dealer/worker';
import { createParty } from '@dealer/inventory';
import {
  approveCampaignVersion,
  buildAudience,
  captureLead,
  createCampaign,
  defineLeadSource,
  draftCampaignVersion,
  executeCampaignVersion,
  setPurposeConsent,
  setSlaPolicy,
} from '@dealer/crm';

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
      await shiftSupportWindowIntoThePast(session.supportSessionId);

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

    /**
     * Moves a window's expiry into the past — via the R7 rebuild, since the
     * window is immutable (§3.2). Same ids, same values, shifted instants.
     */
    async function lapse(supportSessionId: string): Promise<void> {
      await shiftSupportWindowIntoThePast(supportSessionId);
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

    /**
     * ── FBL-020-R6 §2.7: A FAILED SWEEP IS REPORTED, NOT SWALLOWED ──────────
     *
     * `runAllJobsOnce` returned `void`: it caught every job's error, logged it, and
     * discarded it, so `main --once` exited 0 whatever happened. A scheduler has one
     * signal — the exit status — so a sweep that had been throwing on every pass for a
     * week was indistinguishable from a sweep with nothing to do, while the expiry
     * audit rows this very inventory promises were never written.
     *
     * THE END-TO-END PROOF IS THE EXIT STATUS OF THE COMPILED ARTIFACT, and it lives
     * in `tests/worker-entrypoint.test.ts`, because only a spawned process has an exit
     * status. That battery cannot run under `scripts/mutation-kill.ts`, whose isolated
     * copy carries no `dist/`. This test is the same control at the level the mutation
     * runner CAN reach: the pass reports WHICH job failed, and `main(['--once'])` — the
     * exact function the compiled entry point calls — REJECTS rather than returning,
     * which is what the `require.main` guard turns into a non-zero exit.
     *
     * The failure is injected in the DATABASE, so the sweep fails for a reason the
     * worker cannot anticipate or special-case. The trigger is dropped in `finally`;
     * `resetDatabase` TRUNCATEs and would not remove it.
     */
    test('a pass in which a registered sweep FAILS reports it, and --once refuses to report success', async () => {
      // CONTROL FIRST: the same pass, with nothing injected, reports NO failed jobs.
      assert.deepEqual(
        [...(await runAllJobsOnce())],
        [],
        'CONTROL: a healthy pass must report no failed jobs',
      );

      const stale = await startLoginTransaction({ purpose: 'login', redirectUri: LOGIN_REDIRECT });
      await query(
        `UPDATE login_transactions
            SET created_at = NOW() - INTERVAL '2 hours', expires_at = NOW() - INTERVAL '1 hour'
          WHERE login_txn_id = $1`,
        [stale.loginTxnId],
      );

      await query(`CREATE OR REPLACE FUNCTION fbl_r6_fail_login_sweep_inproc()
                     RETURNS TRIGGER AS $$
                     BEGIN
                       RAISE EXCEPTION 'FBL-020-R6 fault injection: login transaction sweep';
                     END;
                     $$ LANGUAGE plpgsql`);
      let failed: readonly string[];
      let onceRejected = false;
      try {
        await query(`CREATE TRIGGER fbl_r6_fail_login_sweep_inproc
                       BEFORE UPDATE ON login_transactions
                       FOR EACH ROW EXECUTE FUNCTION fbl_r6_fail_login_sweep_inproc()`);
        failed = await runAllJobsOnce();
        // `main --once` closes the pool on its way out, exactly as the shipped process
        // does; `getPool()` rebuilds it for the statements below.
        await main(['--once']).then(
          () => undefined,
          () => {
            onceRejected = true;
          },
        );
      } finally {
        await query(`DROP TRIGGER IF EXISTS fbl_r6_fail_login_sweep_inproc ON login_transactions`);
        await query(`DROP FUNCTION IF EXISTS fbl_r6_fail_login_sweep_inproc()`);
      }

      assert.deepEqual(
        [...failed],
        [LOGIN_TRANSACTION_EXPIRY_JOB],
        'the pass must report WHICH sweep failed, and only that one',
      );
      assert.equal(
        onceRejected,
        true,
        '--once must refuse to report success when a registered sweep failed',
      );

      // …and the injection really did stop that sweep, rather than being absorbed
      // somewhere harmless.
      assert.equal(
        (
          await scalar(
            `SELECT status FROM login_transactions WHERE login_txn_id = $1`,
            stale.loginTxnId,
          )
        ).status,
        'pending',
        'the injected failure really did stop the login-transaction sweep',
      );
    });

    // ── job 4: the administration outbox dispatcher (RT1) ────────────────────
    test('the worker pass delivers a due administration outbox event, exactly once', async () => {
      const admin = await makeUser(tenantId);
      const created = await createStaffInvitation({
        actingUserLinkId: admin,
        tenantId,
        email: 'invitee@example.com',
        invitedRole: TENANT_ADMIN_ROLE,
      });
      assert.ok(!('error' in created), 'the seed invitation must be created');

      const pending = await query(
        `SELECT event_id FROM admin_outbox WHERE tenant_id = $1 AND delivered_at IS NULL`,
        [tenantId],
      );
      assert.equal(pending.rows.length, 1, 'the invitation must enqueue exactly one event');
      const eventId = String((pending.rows[0] as { event_id: unknown }).event_id);

      // Pass 1: the WORKER'S OWN pass — the exact function `--once` calls —
      // delivers the event and records the delivery in the dedupe ledger.
      assert.deepEqual([...(await runAllJobsOnce())], [], 'the dispatch pass must not fail');
      const afterFirst = await scalar(
        `SELECT (delivered_at IS NOT NULL)::text AS delivered, attempts::int AS attempts
           FROM admin_outbox WHERE event_id = $1`,
        eventId,
      );
      assert.equal(afterFirst.delivered, 'true', 'one pass must mark the event delivered');
      assert.equal(Number(afterFirst.attempts), 1, 'one pass is one attempt');
      const ledgerCount = async (): Promise<number> =>
        Number(
          (
            (
              await query(
                `SELECT COUNT(*)::int AS n FROM admin_outbox_deliveries WHERE event_id = $1`,
                [eventId],
              )
            ).rows[0] as { n: number }
          ).n,
        );
      assert.equal(await ledgerCount(), 1, 'the delivery must be recorded in the dedupe ledger');

      // Pass 2: a delivered event is not claimable — nothing moves.
      assert.deepEqual([...(await runAllJobsOnce())], []);
      const afterSecond = await scalar(
        `SELECT attempts::int AS attempts FROM admin_outbox WHERE event_id = $1`,
        eventId,
      );
      assert.equal(Number(afterSecond.attempts), 1, 'a second pass must not touch the event');

      // REPLAY: crash recovery re-marks the event undelivered. The ledger's
      // primary key makes the business effect exactly-once — the replayed
      // event is re-marked delivered WITHOUT a second delivery row.
      await query(`UPDATE admin_outbox SET delivered_at = NULL WHERE event_id = $1`, [eventId]);
      assert.deepEqual([...(await runAllJobsOnce())], []);
      const afterReplay = await scalar(
        `SELECT (delivered_at IS NOT NULL)::text AS delivered FROM admin_outbox
          WHERE event_id = $1`,
        eventId,
      );
      assert.equal(afterReplay.delivered, 'true', 'a replayed event must re-mark delivered');
      assert.equal(
        await ledgerCount(),
        1,
        'a replayed delivery must hit the ledger conflict — the effect happens exactly once',
      );
    });
    // ── jobs 6 and 7: the Release Train 3 passes ─────────────────────────────
    //
    // Both are driven through `runAllJobsOnce` — the exact function `--once`
    // calls — rather than through the service, so removing the registry entry
    // breaks them. A test that called the pass directly would stay green while
    // the deployment ran nothing, which is the failure these exist to catch.

    /** A dealership with one rooftop, and the source every lead needs. */
    async function seedCrmWorld(): Promise<{ rooftopId: string; admin: string }> {
      const group = await seedDealerGroup({ tenantId, name: 'Sweep Group', status: 'active' });
      const entity = await seedLegalEntity({
        tenantId,
        dealerGroupId: group.dealerGroupId,
        name: 'Sweep LLC',
        status: 'active',
      });
      const rooftop = await seedRooftop({
        tenantId,
        legalEntityId: entity.legalEntityId,
        name: 'Sweep Downtown',
        status: 'active',
      });
      const admin = await bootstrapAdministrator(tenantId);
      const source = await defineLeadSource({
        actingUserLinkId: admin,
        tenantId,
        sourceCode: 'website',
        displayName: 'Website',
        channel: 'web',
        medium: 'organic',
      });
      assert.equal(source.outcome, 'saved');
      return { rooftopId: rooftop.rooftopId, admin };
    }

    test('the worker pass dispatches a due campaign send, exactly once', async () => {
      const { rooftopId, admin } = await seedCrmWorld();
      const party = await createParty({
        actingUserLinkId: admin,
        tenantId,
        partyType: 'person',
        details: { givenName: 'Reader', familyName: 'One', email: 'reader.one@example.com' },
      });
      assert.equal(party.outcome, 'created');
      const partyId = (party as { party: { partyId: string } }).party.partyId;
      const consent = await setPurposeConsent({
        actingUserLinkId: admin,
        tenantId,
        partyId,
        channel: 'email',
        purpose: 'sales_marketing',
        state: 'granted',
        source: 'counter',
      });
      assert.equal(consent.outcome, 'saved');

      const campaign = await createCampaign({
        actingUserLinkId: admin,
        tenantId,
        rooftopId,
        name: 'Sweep Spring',
        channel: 'email',
        purpose: 'sales_marketing',
        sourceCode: 'website',
        // No quiet window: this test is about the worker running at all.
        quietHoursStartMinute: 0,
        quietHoursEndMinute: 0,
      });
      assert.equal(campaign.outcome, 'created');
      const campaignId = (campaign as { campaign: { campaignId: string } }).campaign.campaignId;

      const version = await draftCampaignVersion({
        actingUserLinkId: admin,
        tenantId,
        campaignId,
        subject: 'Spring',
        body: 'Come and see us. Reply STOP to unsubscribe.',
      });
      assert.equal(version.outcome, 'drafted');
      const drafted = (
        version as { version: { campaignVersionId: string; authorizationVersion: number } }
      ).version;
      const audience = await buildAudience({
        actingUserLinkId: admin,
        tenantId,
        campaignId,
        campaignVersionId: drafted.campaignVersionId,
        rule: 'all_active_customers',
      });
      assert.equal(audience.outcome, 'built');
      assert.equal((audience as { result: { included: number } }).result.included, 1);
      const approved = await approveCampaignVersion({
        actingUserLinkId: admin,
        tenantId,
        campaignId,
        campaignVersionId: drafted.campaignVersionId,
        expectedVersion: drafted.authorizationVersion,
      });
      assert.equal(approved.outcome, 'approved', JSON.stringify(approved));
      const launched = await executeCampaignVersion({
        actingUserLinkId: admin,
        tenantId,
        campaignId,
        campaignVersionId: drafted.campaignVersionId,
        expectedVersion: (approved as { version: { authorizationVersion: number } }).version
          .authorizationVersion,
      });
      assert.equal(launched.outcome, 'executing', JSON.stringify(launched));

      const pending = await query(`SELECT state FROM campaign_sends WHERE tenant_id = $1`, [
        tenantId,
      ]);
      assert.equal(String((pending.rows[0] as { state: string }).state), 'pending');

      // THE PRODUCTION PASS.
      assert.deepEqual(await runAllJobsOnce(), [], 'no job failed');
      const afterOne = await query(
        `SELECT state, attempts, external_ref FROM campaign_sends WHERE tenant_id = $1`,
        [tenantId],
      );
      const row = afterOne.rows[0] as { state: string; attempts: number; external_ref: string };
      assert.equal(row.state, 'sent', 'the worker actually delivered it');
      assert.equal(Number(row.attempts), 1);

      // …and a second pass does it no second time.
      assert.deepEqual(await runAllJobsOnce(), []);
      const afterTwo = await query(`SELECT attempts FROM campaign_sends WHERE tenant_id = $1`, [
        tenantId,
      ]);
      assert.equal(Number((afterTwo.rows[0] as { attempts: number }).attempts), 1, 'exactly once');
      const sentEvents = await query(
        `SELECT COUNT(*)::int AS n FROM campaign_send_events
          WHERE tenant_id = $1 AND event_type = 'sent'`,
        [tenantId],
      );
      assert.equal(Number((sentEvents.rows[0] as { n: number }).n), 1, 'one sent event, ever');
    });

    test('the worker pass escalates an unanswered lead, exactly once', async () => {
      const { rooftopId, admin } = await seedCrmWorld();
      const policy = await setSlaPolicy({
        actingUserLinkId: admin,
        tenantId,
        rooftopId,
        firstResponseMinutes: 30,
        escalateAfterMinutes: 60,
      });
      assert.equal(policy.outcome, 'saved');
      const captured = await captureLead({
        actingUserLinkId: admin,
        tenantId,
        rooftopId,
        intakeKey: 'unanswered-1',
        channel: 'website',
        sourceCode: 'website',
        party: { givenName: 'Waiting', familyName: 'Customer', email: 'waiting@example.com' },
      });
      assert.equal(captured.outcome, 'created', JSON.stringify(captured));
      const leadId = (captured as { lead: { leadId: string } }).lead.leadId;

      // Nothing is late yet, so a pass now must escalate nothing.
      assert.deepEqual(await runAllJobsOnce(), []);
      const early = await query(
        `SELECT COUNT(*)::int AS n FROM lead_escalations WHERE tenant_id = $1`,
        [tenantId],
      );
      assert.equal(Number((early.rows[0] as { n: number }).n), 0, 'a fresh lead is not late');

      // THE ESCALATION clock runs out — not merely the response target. Only
      // the deadline moves; the lead is untouched, which is what actually
      // happens as time passes.
      await fixtureAuthorizationStateWrite(
        'simulate-authorization-drift',
        `UPDATE leads SET escalate_at = NOW() - INTERVAL '5 minutes'
          WHERE tenant_id = $1 AND lead_id = $2`,
        [tenantId, leadId],
      );

      assert.deepEqual(await runAllJobsOnce(), []);
      const raised = await query(
        `SELECT COUNT(*)::int AS n FROM lead_escalations WHERE tenant_id = $1 AND lead_id = $2`,
        [tenantId, leadId],
      );
      assert.equal(Number((raised.rows[0] as { n: number }).n), 1, 'the alarm was raised');

      // …and a second pass raises nothing further.
      assert.deepEqual(await runAllJobsOnce(), []);
      const still = await query(
        `SELECT COUNT(*)::int AS n FROM lead_escalations WHERE tenant_id = $1 AND lead_id = $2`,
        [tenantId, leadId],
      );
      assert.equal(Number((still.rows[0] as { n: number }).n), 1, 'exactly once');
    });
  },
);
