/**
 * @dealer/worker — the background process, and as of FBL-020-R4 §4 it RUNS SOMETHING.
 *
 * It stayed deliberately job-free through FBL-010 because no durable-events machinery
 * was authorized. §4 does not authorize any either: there is no queue here, no outbox,
 * no scheduler table and no lease. What there is, is one periodic transition that the
 * database itself makes exactly-once safe — recording that a delegated support-access
 * window has closed.
 *
 * WHY A WORKER AT ALL, rather than a function some request path calls. The transition
 * has no request to hang off: a support window expires whether or not anybody is
 * talking to the platform, and the whole point is that the audit trail records the
 * closing even when nothing else happens afterwards. Putting it on the request path
 * would mean the trail was complete only for busy tenants, and FBL-020-R3 was rejected
 * once for shipping an implemented-but-unreachable flow — so this process is in the
 * deployment topology (Dockerfile builds it, docker-compose runs it) and this file is
 * where it is reached.
 *
 * THREE MODES, because a process that only knows how to run for ever cannot be proven:
 *
 *   --list-jobs   prints the registered jobs and exits. Touches NO database, so it is
 *                 a truthful smoke test of the wiring on a machine with no schema.
 *   --once        runs one pass of every job and exits with the pool closed, NON-ZERO
 *                 if any registered sweep failed (FBL-020-R6 §2.7 — it used to
 *                 swallow every failure and exit 0). This is also the shape an
 *                 external scheduler (cron, a Kubernetes CronJob) would invoke, so
 *                 the periodic mode is a convenience, not a requirement — and the
 *                 exit status is the only thing such a scheduler reads.
 *   (default)     runs each job on its configured interval until SIGTERM/SIGINT, then
 *                 finishes the pass in flight and closes the pool.
 *
 * This is a COMPOSITION ROOT: it may read process.env (check-env-access allows exactly
 * this file, apps/api/src/server.ts and the config boundary). It holds no SQL and
 * imports no query primitive — the transition lives in @dealer/identity-access, which
 * owns every write to the support tables.
 */
import { assertRuntimePosture, closePool } from '@dealer/database';
import {
  dispatchDueAdminOutboxEvents,
  expireDueSupportSessions,
  expireStaleLoginTransactions,
  expireStaleReauthenticationTransactions,
} from '@dealer/identity-access';
import { dispatchDueListingEvents } from '@dealer/inventory';
import { runCampaignDispatchPass, runSlaSweepPass } from '@dealer/crm';
import { getConfig, logger } from '@dealer/platform';

/** The registered job names. `--list-jobs` prints exactly this. */
export const SUPPORT_ACCESS_EXPIRY_JOB = 'identity.support_access.expiry';

/**
 * FBL-020-R5 §4.8 — THE OTHER TWO SWEEPS ARE REGISTERED HERE TOO.
 *
 * `expireStaleLoginTransactions` and `expireStaleReauthenticationTransactions` were
 * written, audited and tested, and then reached by NOTHING that ships: the registry
 * below held one name, so on a deployed system a login transaction abandoned at the
 * provider and a step-up nobody completed stayed `pending`/`started` for ever, and the
 * `identity.login.expired` / `identity.reauthentication.expired` rows their own audit
 * inventory promises were written only when a test called the function. Their doc
 * comments each say "for the scheduled aggregator" — this is the aggregator, and until
 * now it did not schedule them.
 *
 * That is the same defect FBL-020-R3 was rejected for (an implemented-but-unreachable
 * flow), so the correction is registration, not new behaviour: the transitions, their
 * SQL and their audit rows are unchanged and still live in @dealer/identity-access.
 */
export const LOGIN_TRANSACTION_EXPIRY_JOB = 'identity.login_transaction.expiry';
export const REAUTHENTICATION_EXPIRY_JOB = 'identity.reauthentication_transaction.expiry';

/**
 * RELEASE TRAIN 1 — the administration outbox dispatcher. Events written in the
 * same transaction as the administrative state they describe (today: the
 * staff-invitation email) leave the service through this pass: at-least-once
 * delivery, exactly-once business effect via the `admin_outbox_deliveries`
 * dedupe ledger, failures retried with backoff on the event row.
 */
export const ADMIN_OUTBOX_DISPATCH_JOB = 'admin.outbox.dispatch';

/**
 * RELEASE TRAIN 2 — the listing dispatcher. It carries a vehicle's publication
 * or withdrawal to the listing provider and reconciles the answer, claiming
 * ONLY `inventory.` outbox events so it and the administration dispatcher
 * above share one table without consuming each other's work.
 */
export const LISTING_DISPATCH_JOB = 'inventory.listing.dispatch';

/**
 * RELEASE TRAIN 3. Two passes, deliberately separate jobs: dispatching a
 * campaign is provider work with retries and quiet hours, and sweeping the
 * first-response clock is a cheap scan that must keep running even when a
 * provider is down. One job doing both would let the slow half starve the
 * half that raises the alarm.
 */
export const CAMPAIGN_DISPATCH_JOB = 'crm.campaign.dispatch';
export const LEAD_SLA_SWEEP_JOB = 'crm.lead.sla_sweep';

/**
 * THE ONE REGISTRY. A name and the pass that runs it are the SAME entry, so the list
 * `--list-jobs` advertises and the work `--once` performs cannot drift apart: there is
 * no second array to keep in step, and a job cannot be announced without being run or
 * run without being announced. Two parallel lists were the obvious way to write this
 * and would have re-created, one level up, exactly the defect this section is fixing.
 */
interface RegisteredJob {
  readonly name: string;
  readonly run: () => Promise<number>;
}

const REGISTRY: readonly RegisteredJob[] = [
  { name: SUPPORT_ACCESS_EXPIRY_JOB, run: () => runSupportAccessExpiryOnce() },
  { name: LOGIN_TRANSACTION_EXPIRY_JOB, run: () => runLoginTransactionExpiryOnce() },
  { name: REAUTHENTICATION_EXPIRY_JOB, run: () => runReauthenticationExpiryOnce() },
  { name: ADMIN_OUTBOX_DISPATCH_JOB, run: () => runAdminOutboxDispatchOnce() },
  { name: LISTING_DISPATCH_JOB, run: () => runListingDispatchOnce() },
  { name: CAMPAIGN_DISPATCH_JOB, run: () => runCampaignDispatchOnce() },
  { name: LEAD_SLA_SWEEP_JOB, run: () => runLeadSlaSweepOnce() },
];

/** The registered job names, derived from the registry above — never restated. */
export const WORKER_JOBS: readonly string[] = REGISTRY.map((job) => job.name);

/**
 * ONE pass of the support-expiry job.
 *
 * Returns how many windows it recorded so the caller can log a number rather than a
 * hope. A pass that finds nothing is the normal case and logs at debug; a pass that
 * records something logs at info with IDS ONLY — never the support reason, never a
 * provider profile, never a token.
 */
export async function runSupportAccessExpiryOnce(): Promise<number> {
  const expired = await expireDueSupportSessions();
  if (expired.length === 0) {
    logger.debug({ job: SUPPORT_ACCESS_EXPIRY_JOB, expired: 0 }, 'no support windows to close');
    return 0;
  }
  for (const one of expired) {
    logger.info(
      {
        job: SUPPORT_ACCESS_EXPIRY_JOB,
        tenant_id: one.tenantId,
        support_session_id: one.supportSessionId,
        support_request_id: one.requestId,
        support_actor_user_link_id: one.actorUserLinkId,
        support_session_expires_at: one.expiresAt.toISOString(),
        support_session_expired_at: one.expiredAt.toISOString(),
        authorization_version: one.authorizationVersion,
        audit_event_id: one.auditEventId,
      },
      'support access window closed by expiry',
    );
  }
  logger.info(
    { job: SUPPORT_ACCESS_EXPIRY_JOB, expired: expired.length },
    'support expiry pass complete',
  );
  return expired.length;
}

/**
 * ONE pass of the login-transaction expiry job.
 *
 * The transition itself is `expireStaleLoginTransactions`, which moves every login
 * transaction still `pending`/`consuming` past its `expires_at` to `failed` and writes
 * one `identity.login.expired` audit row per transaction, inside the same database
 * transaction. Only the COUNT is logged: a login transaction id is not sensitive but
 * nothing here needs it, and the per-row trail is in `audit_events` already.
 */
export async function runLoginTransactionExpiryOnce(): Promise<number> {
  const expired = await expireStaleLoginTransactions();
  if (expired === 0) {
    logger.debug({ job: LOGIN_TRANSACTION_EXPIRY_JOB, expired: 0 }, 'no login transactions to age');
    return 0;
  }
  logger.info(
    { job: LOGIN_TRANSACTION_EXPIRY_JOB, expired },
    'login transaction expiry pass complete',
  );
  return expired;
}

/**
 * ONE pass of the reauthentication-transaction expiry job.
 *
 * `expireStaleReauthenticationTransactions` moves every `started` step-up past its
 * `expires_at` to `expired` with `terminal_reason = 'expired'`, writing one
 * `identity.reauthentication.expired` audit row per transaction in the same database
 * transaction. Grants are deliberately NOT swept — consumption and expiry are decided
 * from their own columns at read time — so this job must not be read as retiring them.
 */
export async function runReauthenticationExpiryOnce(): Promise<number> {
  const expired = await expireStaleReauthenticationTransactions();
  if (expired === 0) {
    logger.debug({ job: REAUTHENTICATION_EXPIRY_JOB, expired: 0 }, 'no step-ups to age');
    return 0;
  }
  logger.info(
    { job: REAUTHENTICATION_EXPIRY_JOB, expired },
    'reauthentication expiry pass complete',
  );
  return expired;
}

/**
 * ONE pass of the administration outbox dispatcher.
 *
 * `dispatchDueAdminOutboxEvents` claims due events one small transaction at a
 * time (FOR UPDATE SKIP LOCKED), delivers through the default logging port,
 * and records failures on the event row with backoff — a failing event never
 * aborts the batch, so this pass only THROWS on an infrastructure fault before
 * any claim. Counts only in the log; payloads carry ids, never an address.
 */
export async function runAdminOutboxDispatchOnce(): Promise<number> {
  const result = await dispatchDueAdminOutboxEvents();
  const processed = result.delivered + result.deduplicated + result.failed;
  if (processed === 0) {
    logger.debug({ job: ADMIN_OUTBOX_DISPATCH_JOB, processed: 0 }, 'no outbox events due');
    return 0;
  }
  logger.info(
    {
      job: ADMIN_OUTBOX_DISPATCH_JOB,
      delivered: result.delivered,
      deduplicated: result.deduplicated,
      failed: result.failed,
    },
    'administration outbox dispatch pass complete',
  );
  return processed;
}

/**
 * ONE pass of the listing dispatcher.
 *
 * `dispatchDueListingEvents` claims due `inventory.listing.*` events one small
 * transaction at a time, calls the provider, and commits the outcome, the
 * listing's new state and the delivery-ledger row together. A DEFERRED answer
 * is a retry rather than a failure — the event is pushed out with backoff and
 * counted separately — so a busy channel does not look like a broken one.
 */
export async function runListingDispatchOnce(): Promise<number> {
  const result = await dispatchDueListingEvents();
  const processed = result.delivered + result.deduplicated + result.deferred + result.failed;
  if (processed === 0) {
    logger.debug({ job: LISTING_DISPATCH_JOB, processed: 0 }, 'no listing events due');
    return 0;
  }
  logger.info(
    {
      job: LISTING_DISPATCH_JOB,
      delivered: result.delivered,
      deduplicated: result.deduplicated,
      deferred: result.deferred,
      failed: result.failed,
    },
    'listing dispatch pass complete',
  );
  return processed;
}

/**
 * ONE pass of the campaign dispatcher, across every active tenant.
 *
 * The pass drains the marketing outbox exactly once per launch and then
 * dispatches due sends — which is where suppression and quiet hours are
 * re-checked immediately before anything reaches a provider. A deferral is not
 * a failure and is counted separately, so a campaign waiting for morning does
 * not look like a broken one.
 */
export async function runCampaignDispatchOnce(): Promise<number> {
  const result = await runCampaignDispatchPass();
  const processed =
    result.sent + result.deferred + result.suppressed + result.retrying + result.failed;
  if (processed === 0 && result.outboxDelivered === 0) {
    logger.debug({ job: CAMPAIGN_DISPATCH_JOB, processed: 0 }, 'no campaign work due');
    return 0;
  }
  logger.info(
    {
      job: CAMPAIGN_DISPATCH_JOB,
      tenants: result.tenantsVisited,
      outboxDelivered: result.outboxDelivered,
      outboxReplayed: result.outboxReplayed,
      sent: result.sent,
      deferred: result.deferred,
      suppressed: result.suppressed,
      retrying: result.retrying,
      failed: result.failed,
    },
    'campaign dispatch pass complete',
  );
  return processed;
}

/**
 * ONE pass of the first-response sweep. Idempotent by construction: the
 * escalation ledger is unique per (lead, level), so running this twice — or
 * twice at once — raises each alarm exactly once.
 */
export async function runLeadSlaSweepOnce(): Promise<number> {
  const result = await runSlaSweepPass();
  if (result.escalated === 0 && result.examined === 0) {
    logger.debug({ job: LEAD_SLA_SWEEP_JOB, processed: 0 }, 'no overdue leads');
    return 0;
  }
  logger.info(
    {
      job: LEAD_SLA_SWEEP_JOB,
      tenants: result.tenantsVisited,
      examined: result.examined,
      escalated: result.escalated,
      alreadyEscalated: result.alreadyEscalated,
    },
    'lead sla sweep complete',
  );
  return result.escalated;
}

/**
 * Runs one pass of EVERY registered job and RETURNS THE NAMES OF THE ONES THAT FAILED.
 *
 * A job that throws is logged and does not stop the loop: a transient database failure
 * must not silently retire the process that keeps the support trail complete. Each job
 * is caught SEPARATELY rather than under one shared `try`, so a throw in the first sweep
 * does not skip the remaining ones — and that is now a MEASURED result rather than a
 * reading of the code: `tests/worker-entrypoint.test.ts` makes the login sweep fail and
 * asserts that the step-up and support sweeps still performed their transitions.
 *
 * ── FBL-020-R6 §2.7: WHY THIS RETURNS SOMETHING NOW ─────────────────────────
 *
 * It returned `void`. Every failure was logged and then DISCARDED, so `--once` — the
 * shape a cron entry, a Kubernetes CronJob or any external scheduler invokes — exited 0
 * whatever happened inside it. A scheduler's only signal is the exit status, so a sweep
 * that had been throwing on every pass for a week looked exactly like a sweep that had
 * nothing to do, and the `identity.login.expired`,
 * `identity.reauthentication.expired` and `identity.support.expired` rows those sweeps
 * owe were simply never written while every run reported success.
 *
 * The NAMES, not a count: the caller logs WHICH sweeps failed, and a job name is a
 * server-side constant — never a tenant identifier, a token or anything a caller
 * supplied. The error objects stay in the log lines below and are not returned, so no
 * database message can travel up into an exit path.
 *
 * The PERIODIC mode deliberately does NOT stop on a failure; it is the `--once` caller
 * that turns a failure into a non-zero exit, because that is the mode with a supervisor
 * on the other end of it.
 */
export async function runAllJobsOnce(): Promise<readonly string[]> {
  const failed: string[] = [];
  for (const job of REGISTRY) {
    try {
      await job.run();
    } catch (err) {
      failed.push(job.name);
      logger.error({ err, job: job.name }, 'worker job pass failed');
    }
  }
  return failed;
}

interface WorkerHandle {
  /** Resolves once the loop has stopped and the pass in flight has finished. */
  readonly stopped: Promise<void>;
  stop(): void;
}

/**
 * The periodic loop. `setTimeout` is re-armed AFTER each pass rather than using
 * `setInterval`, so a pass that takes longer than the interval cannot overlap itself —
 * two overlapping passes would still be safe (the transition is concurrency-safe by
 * construction) but they would waste connections proving it.
 */
export function startWorker(intervalMs: number): WorkerHandle {
  let stopping = false;
  let timer: NodeJS.Timeout | undefined;
  let resolveStopped: () => void = () => {};
  const stopped = new Promise<void>((resolve) => {
    resolveStopped = resolve;
  });

  const tick = async (): Promise<void> => {
    await runAllJobsOnce();
    if (stopping) {
      resolveStopped();
      return;
    }
    timer = setTimeout(() => void tick(), intervalMs);
    // The timer must not hold the process open on its own: a stop() between passes
    // clears it, and an unreferenced timer lets the event loop drain if it does not.
    timer.unref();
  };

  void tick();

  return {
    stopped,
    stop(): void {
      if (stopping) return;
      stopping = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
        // No pass is in flight (a timer was pending), so the loop is already stopped.
        resolveStopped();
      }
    },
  };
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  if (argv.includes('--list-jobs')) {
    // Deliberately database-free: the wiring can be proven on a host with no schema,
    // which is what makes this a smoke test rather than an integration test.
    process.stdout.write(
      JSON.stringify({
        level: 'info',
        msg: 'worker jobs registered',
        jobs: WORKER_JOBS,
      }) + '\n',
    );
    return;
  }

  // FBL-020-R7-C1 §2 — FAIL CLOSED ON THE RUNTIME DATABASE POSTURE before any
  // job touches the database. The worker never loads the full AppConfig (it runs
  // on the DB-only lazy path), so it gates on NODE_ENV directly: in production it
  // must run as the non-owner runtime login (migration 060's dealership_app) and
  // refuses to run a sweep otherwise. `--list-jobs` returned above, database-free.
  if (process.env.NODE_ENV === 'production') {
    try {
      const posture = await assertRuntimePosture();
      logger.info({ dbUser: posture.currentUser }, 'Runtime database posture verified');
    } catch (err) {
      process.stderr.write(
        `Refusing to run: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      await closePool().catch(() => undefined);
      throw err;
    }
  }

  if (argv.includes('--once')) {
    logger.info({ jobs: WORKER_JOBS, mode: 'once' }, 'worker single pass');
    const failed = await runAllJobsOnce();
    // The pool is closed BEFORE the outcome is decided, so a failing pass releases
    // its connections exactly as a succeeding one does. A process that leaked a pool
    // on the failure path would turn one bad sweep into an exhausted database.
    await closePool();
    if (failed.length > 0) {
      /*
       * FBL-020-R6 §2.7 — THE EXIT STATUS IS THE ONLY THING A SCHEDULER READS.
       *
       * Throwing rather than assigning `process.exitCode` on purpose: `main` is
       * exported and driven directly by the batteries, and a function that reached
       * into the process's exit status would make any test that called it poison the
       * runner's own result. The `require.main === module` guard below is the single
       * place that translates a failure into a status, which is the same "one writer"
       * rule the job registry itself follows.
       */
      throw new Error(
        `worker single pass: ${failed.length} registered job(s) failed: ${failed.join(', ')}`,
      );
    }
    return;
  }

  const intervalMs = getConfig().supportAccessExpiryIntervalMs;
  logger.info({ jobs: WORKER_JOBS, mode: 'periodic', intervalMs }, 'worker started');
  const handle = startWorker(intervalMs);
  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'worker stopping');
    handle.stop();
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
  await handle.stopped;
  await closePool();
  logger.info({ jobs: WORKER_JOBS }, 'worker stopped');
}

if (require.main === module) {
  main().catch((err: unknown) => {
    logger.error({ err }, 'worker failed');
    process.exitCode = 1;
  });
}
