import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { after, beforeEach, describe, test } from 'node:test';
import {
  ADMIN_OUTBOX_DISPATCH_JOB,
  LISTING_DISPATCH_JOB,
  LOGIN_TRANSACTION_EXPIRY_JOB,
  REAUTHENTICATION_EXPIRY_JOB,
  SUPPORT_ACCESS_EXPIRY_JOB,
  CAMPAIGN_DISPATCH_JOB,
  LEAD_SLA_SWEEP_JOB,
  CEREMONY_EXPIRY_JOB,
  WORKER_JOBS,
} from '@dealer/worker';
import {
  INTEGRATION_DATABASE_URL,
  TEST_REAUTH_CALLBACK_URI,
  ensureActiveConnection,
  fixtureAuthorizationStateWrite,
  resetDatabase,
  seedLocalSession,
  seedTenantViaService,
  skipIntegration,
} from '@dealer/test-kit';
import { closePool, query } from '@dealer/database';
import { startLoginTransaction, startReauthentication } from '@dealer/identity-access';

/**
 * FBL-020-R5 §4.8 — THE JOB REGISTRY, READ OFF THE ARTIFACT THAT SHIPS.
 *
 * `tests/worker-jobs.test.ts` proves each registered sweep performs its transition
 * exactly once, driving the worker's own pass. This file proves the OTHER half: that the
 * compiled entry point — `apps/worker/dist/main.js`, the file the Dockerfile's CMD runs —
 * advertises those jobs, and advertises exactly what the source registry declares.
 *
 * IT IS A SEPARATE BATTERY ON PURPOSE. `scripts/mutation-kill.ts` copies the tree WITHOUT
 * any `dist/`, so a battery that needs the compiled output cannot run there; keeping this
 * assertion in its own file lets the behavioural battery be mutation-tested while this one
 * still holds the shipped artifact to the source. It needs no database.
 */

const ROOT = join(__dirname, '..');
const COMPILED_WORKER = join(ROOT, 'apps', 'worker', 'dist', 'main.js');

describe('the worker job registry, through the compiled entry point (FBL-020-R5 §4.8)', () => {
  test('the compiled entry point advertises every registered job', () => {
    /*
     * `--list-jobs` is deliberately database-free, so this runs anywhere. It is SPAWNED
     * rather than imported: importing `../apps/worker/src/main` would prove a claim about
     * the TypeScript, and what a deployment executes is the emitted JavaScript.
     */
    assert.ok(
      existsSync(COMPILED_WORKER),
      `${COMPILED_WORKER} is missing — run \`npm run build\` first; CI builds before it tests`,
    );
    const run = spawnSync(process.execPath, [COMPILED_WORKER, '--list-jobs'], {
      encoding: 'utf8',
      cwd: ROOT,
    });
    assert.equal(run.status, 0, `--list-jobs exited ${String(run.status)}: ${run.stderr}`);

    const printed = JSON.parse(run.stdout.trim()) as { jobs: string[] };
    assert.deepEqual(
      printed.jobs,
      [
        SUPPORT_ACCESS_EXPIRY_JOB,
        LOGIN_TRANSACTION_EXPIRY_JOB,
        REAUTHENTICATION_EXPIRY_JOB,
        ADMIN_OUTBOX_DISPATCH_JOB,
        LISTING_DISPATCH_JOB,
        CAMPAIGN_DISPATCH_JOB,
        LEAD_SLA_SWEEP_JOB,
        CEREMONY_EXPIRY_JOB,
      ],
      'the compiled worker must register the three sweeps, both outbox dispatchers, ' +
        'the campaign dispatcher, the first-response sweep and the ceremony-expiry sweep',
    );

    /*
     * …and the compiled list must equal the SOURCE registry. Without this, a build made
     * before the registry changed would keep this battery green while the deployment ran
     * something else — the artifact and the source would be allowed to disagree, which is
     * the same class of gap as a flow nothing reaches.
     */
    assert.deepEqual(
      printed.jobs,
      [...WORKER_JOBS],
      'the compiled artifact and the source registry disagree — rebuild (`npm run build`)',
    );
  });
});

/**
 * FBL-020-R5 §1.6 — THE SWEEPS, DRIVEN THROUGH THE ARTIFACT THAT SHIPS, AGAINST A
 * REAL SCHEMA, WITH SEEDED EXPIRED ROWS.
 *
 * The battery above proves the compiled entry point ADVERTISES the three jobs.
 * `tests/worker-jobs.test.ts` proves each sweep is bounded, idempotent and
 * concurrency-safe, driving `runAllJobsOnce` — the exact function `--once` calls.
 * Neither proves the last link: that running `apps/worker/dist/main.js --once`, the
 * command the Dockerfile's CMD and any external scheduler invoke, actually performs
 * those transitions on a database.
 *
 * That link is where FBL-020-R3 was rejected before — an implemented flow nothing in
 * production reaches — and it cannot be proved by importing anything, because what a
 * deployment executes is the emitted JavaScript in a separate process with its own
 * configuration. So the rows are seeded here, the compiled file is SPAWNED with
 * DATABASE_URL pointing at this database, and the transitions are read back here.
 *
 * The second spawn is not decoration: idempotency through the artifact is a
 * different claim from idempotency through the function, since a process that
 * re-ran a sweep on startup would satisfy the latter and violate the former.
 */
describe(
  'the compiled worker performs its sweeps on seeded expired rows (FBL-020-R5 §1.6)',
  { skip: skipIntegration ? 'set TEST_DATABASE_URL to run' : false },
  () => {
    let tenantId: string;

    after(async () => {
      await closePool();
    });

    beforeEach(async () => {
      await resetDatabase();
      tenantId = (await seedTenantViaService({ name: 'Compiled Sweep Motors', status: 'active' }))
        .tenantId;
    });

    async function eventCount(eventType: string, entityId: string): Promise<number> {
      const r = await query(
        `SELECT COUNT(*)::int AS n FROM audit_events WHERE event_type = $1 AND entity_id = $2`,
        [eventType, entityId],
      );
      return Number((r.rows[0] as { n: number }).n);
    }

    /** Runs the SHIPPED file exactly as a scheduler would, and returns its output. */
    function runCompiledOnce(): { status: number | null; stdout: string; stderr: string } {
      const run = spawnSync(process.execPath, [COMPILED_WORKER, '--once'], {
        encoding: 'utf8',
        cwd: ROOT,
        env: {
          ...process.env,
          // The worker is a composition root: it reads its own configuration from the
          // environment. Pointing DATABASE_URL at THIS database is the whole point —
          // the child process must reach the rows seeded below.
          DATABASE_URL: INTEGRATION_DATABASE_URL,
        },
      });
      return { status: run.status, stdout: run.stdout, stderr: run.stderr };
    }

    test('the compiled entry point ages seeded expired rows, once, through a real --once pass', async () => {
      assert.ok(
        existsSync(COMPILED_WORKER),
        `${COMPILED_WORKER} is missing — run \`npm run build\` first; CI builds before it tests`,
      );

      // ── seed one expired row of each kind the registry claims to sweep ──
      const login = await startLoginTransaction({
        purpose: 'login',
        redirectUri: 'http://127.0.0.1:3000/auth/callback',
      });
      await ensureActiveConnection(tenantId);
      const seeded = await fixtureAuthorizationStateWrite(
        'seed-authorization-state',
        `INSERT INTO user_links
           (actor_scope, tenant_id, provider, provider_user_id, status, activated_at,
            connection_id, issuer, provider_organization_id)
         SELECT 'dealership', $1, 'workos', $2, 'activated', NOW(),
                c.connection_id, c.issuer, c.provider_organization_id
           FROM identity_provider_connections c
          WHERE c.tenant_id IS NOT DISTINCT FROM $1 AND c.provider = 'workos'
            AND c.status = 'active'
          LIMIT 1
         RETURNING user_link_id`,
        [tenantId, 'user_' + randomUUID()],
      );
      const userLinkId = String((seeded.rows[0] as { user_link_id: unknown }).user_link_id);
      const { sessionId } = await seedLocalSession(userLinkId);
      const stepUp = await startReauthentication({
        tenantId,
        userLinkId,
        sessionId,
        action: 'service.ro.transition:authorized',
        resourceType: 'repair_order',
        resourceId: randomUUID(),
        callbackUri: TEST_REAUTH_CALLBACK_URI,
      });
      assert.ok(stepUp, 'sanity: the step-up must start');
      const reauthTxnId = stepUp.transaction.reauthTxnId;

      // Only the clock moves — a declared fixture bypass, because no production
      // service back-dates these rows and back-dating IS the state the sweeps exist
      // for.
      await query(
        `UPDATE login_transactions
            SET created_at = NOW() - INTERVAL '2 hours', expires_at = NOW() - INTERVAL '1 hour'
          WHERE login_txn_id = $1`,
        [login.loginTxnId],
      );
      await query(
        `UPDATE reauthentication_transactions
            SET started_at = NOW() - INTERVAL '2 hours', expires_at = NOW() - INTERVAL '1 hour'
          WHERE reauth_txn_id = $1`,
        [reauthTxnId],
      );

      // ── the SHIPPED file, run the way a scheduler runs it ──
      const first = runCompiledOnce();
      assert.equal(first.status, 0, `--once exited ${String(first.status)}: ${first.stderr}`);
      assert.match(first.stdout, /"mode":"once"/, 'the pass announces itself as CI greps for');

      const aged = (
        await query(
          `SELECT status, failure_reason FROM login_transactions WHERE login_txn_id = $1`,
          [login.loginTxnId],
        )
      ).rows[0] as { status: string; failure_reason: unknown };
      assert.equal(aged.status, 'failed', 'the SHIPPED worker aged the login transaction');
      assert.equal(aged.failure_reason, 'expired');
      assert.equal(await eventCount('identity.login.expired', login.loginTxnId), 1);

      const expired = (
        await query(
          `SELECT state, terminal_reason FROM reauthentication_transactions WHERE reauth_txn_id = $1`,
          [reauthTxnId],
        )
      ).rows[0] as { state: string; terminal_reason: unknown };
      assert.equal(expired.state, 'expired', 'and the step-up');
      assert.equal(expired.terminal_reason, 'expired');
      assert.equal(await eventCount('identity.reauthentication.expired', reauthTxnId), 1);

      // ── and a SECOND run of the same artifact changes nothing ──
      const second = runCompiledOnce();
      assert.equal(second.status, 0, `the second --once exited ${String(second.status)}`);
      assert.equal(
        await eventCount('identity.login.expired', login.loginTxnId),
        1,
        'a second pass of the shipped artifact must not re-expire anything',
      );
      assert.equal(await eventCount('identity.reauthentication.expired', reauthTxnId), 1);
    });

    /**
     * ── FBL-020-R6 §2.7: A FAILING SWEEP MUST BE A NON-ZERO EXIT ────────────
     *
     * `runAllJobsOnce` caught every job's error, logged it and DISCARDED it, and
     * `--once` then exited 0 regardless. A scheduler — cron, a Kubernetes CronJob,
     * anything — has exactly one signal, the exit status, so a sweep that had been
     * throwing on every pass for a week was indistinguishable from a sweep with
     * nothing to do, while the `identity.login.expired` /
     * `identity.reauthentication.expired` rows the audit inventory promises were
     * never written. Silent, permanent, and reported as success.
     *
     * IT IS TESTED THROUGH THE COMPILED ENTRY POINT, because the exit status of
     * `apps/worker/dist/main.js` is the thing under test and no in-process call has
     * one. The failure is injected in the DATABASE — a trigger that raises on any
     * UPDATE of `login_transactions` — so the sweep fails for a reason the worker
     * cannot anticipate or special-case, which is what a real transient failure looks
     * like. The trigger is dropped in `finally`; `resetDatabase` TRUNCATEs and would
     * not remove it.
     *
     * TWO PROPERTIES, ONE RUN. The exit is non-zero AND the step-up sweep — which is
     * registered AFTER the login sweep — still performed its transition. The second
     * half is what stops this correction from turning "one sweep failed" into "the
     * rest were skipped", and it is now a measured result rather than a reading of
     * the code.
     */
    test('the compiled --once exits NON-ZERO when a registered sweep fails, and still runs the others', async () => {
      assert.ok(
        existsSync(COMPILED_WORKER),
        `${COMPILED_WORKER} is missing — run \`npm run build\` first; CI builds before it tests`,
      );

      const login = await startLoginTransaction({
        purpose: 'login',
        redirectUri: 'http://127.0.0.1:3000/auth/callback',
      });
      await ensureActiveConnection(tenantId);
      const seeded = await fixtureAuthorizationStateWrite(
        'seed-authorization-state',
        `INSERT INTO user_links
           (actor_scope, tenant_id, provider, provider_user_id, status, activated_at,
            connection_id, issuer, provider_organization_id)
         SELECT 'dealership', $1, 'workos', $2, 'activated', NOW(),
                c.connection_id, c.issuer, c.provider_organization_id
           FROM identity_provider_connections c
          WHERE c.tenant_id IS NOT DISTINCT FROM $1 AND c.provider = 'workos'
            AND c.status = 'active'
          LIMIT 1
         RETURNING user_link_id`,
        [tenantId, 'user_' + randomUUID()],
      );
      const userLinkId = String((seeded.rows[0] as { user_link_id: unknown }).user_link_id);
      const { sessionId } = await seedLocalSession(userLinkId);
      const stepUp = await startReauthentication({
        tenantId,
        userLinkId,
        sessionId,
        action: 'service.ro.transition:authorized',
        resourceType: 'repair_order',
        resourceId: randomUUID(),
        callbackUri: TEST_REAUTH_CALLBACK_URI,
      });
      assert.ok(stepUp, 'sanity: the step-up must start');
      const reauthTxnId = stepUp.transaction.reauthTxnId;

      // Only the clock moves — the same declared fixture bypass the pass above uses.
      await query(
        `UPDATE login_transactions
            SET created_at = NOW() - INTERVAL '2 hours', expires_at = NOW() - INTERVAL '1 hour'
          WHERE login_txn_id = $1`,
        [login.loginTxnId],
      );
      await query(
        `UPDATE reauthentication_transactions
            SET started_at = NOW() - INTERVAL '2 hours', expires_at = NOW() - INTERVAL '1 hour'
          WHERE reauth_txn_id = $1`,
        [reauthTxnId],
      );

      await query(`CREATE OR REPLACE FUNCTION fbl_r6_fail_login_sweep()
                     RETURNS TRIGGER AS $$
                     BEGIN
                       RAISE EXCEPTION 'FBL-020-R6 fault injection: login transaction sweep';
                     END;
                     $$ LANGUAGE plpgsql`);
      let failing: { status: number | null; stdout: string; stderr: string };
      try {
        await query(`CREATE TRIGGER fbl_r6_fail_login_sweep
                       BEFORE UPDATE ON login_transactions
                       FOR EACH ROW EXECUTE FUNCTION fbl_r6_fail_login_sweep()`);
        failing = runCompiledOnce();
      } finally {
        await query(`DROP TRIGGER IF EXISTS fbl_r6_fail_login_sweep ON login_transactions`);
        await query(`DROP FUNCTION IF EXISTS fbl_r6_fail_login_sweep()`);
      }

      // (1) THE EXIT STATUS — the only thing a scheduler reads.
      assert.notEqual(
        failing.status,
        0,
        'a pass in which a registered sweep failed must NOT report success',
      );
      // …and it names which one, so an operator reading the log knows where to look.
      assert.match(
        `${failing.stdout}${failing.stderr}`,
        /identity\.login_transaction\.expiry/,
        'the failing sweep must be named in the output',
      );

      // (2) THE LOOP DID NOT STOP. The login sweep threw; the step-up sweep, which is
      // registered after it, still aged its row and wrote its audit event.
      const stepUpRow = (
        await query(
          `SELECT state, terminal_reason FROM reauthentication_transactions WHERE reauth_txn_id = $1`,
          [reauthTxnId],
        )
      ).rows[0] as { state: string; terminal_reason: unknown };
      assert.equal(stepUpRow.state, 'expired', 'a later sweep must still have run');
      assert.equal(stepUpRow.terminal_reason, 'expired');
      assert.equal(await eventCount('identity.reauthentication.expired', reauthTxnId), 1);

      // …and the login transaction was genuinely NOT aged, so the injection landed
      // where it was aimed rather than being absorbed somewhere harmless.
      const notAged = (
        await query(`SELECT status FROM login_transactions WHERE login_txn_id = $1`, [
          login.loginTxnId,
        ])
      ).rows[0] as { status: string };
      assert.equal(notAged.status, 'pending', 'the injected failure really did stop that sweep');

      // (3) THE CONTROL. With the trigger gone, the identical command exits 0 and the
      // login transaction ages — so the non-zero status above is the failure and not
      // something permanently wrong with this artifact or this database.
      const healthy = runCompiledOnce();
      assert.equal(healthy.status, 0, `the recovered pass exited ${String(healthy.status)}`);
      const aged = (
        await query(
          `SELECT status, failure_reason FROM login_transactions WHERE login_txn_id = $1`,
          [login.loginTxnId],
        )
      ).rows[0] as { status: string; failure_reason: unknown };
      assert.equal(aged.status, 'failed');
      assert.equal(aged.failure_reason, 'expired');
      assert.equal(await eventCount('identity.login.expired', login.loginTxnId), 1);
    });
  },
);
