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
 *   --once        runs one pass of every job and exits with the pool closed. This is
 *                 also the shape an external scheduler (cron, a Kubernetes CronJob)
 *                 would invoke, so the periodic mode is a convenience, not a
 *                 requirement.
 *   (default)     runs each job on its configured interval until SIGTERM/SIGINT, then
 *                 finishes the pass in flight and closes the pool.
 *
 * This is a COMPOSITION ROOT: it may read process.env (check-env-access allows exactly
 * this file, apps/api/src/server.ts and the config boundary). It holds no SQL and
 * imports no query primitive — the transition lives in @dealer/identity-access, which
 * owns every write to the support tables.
 */
import { closePool } from '@dealer/database';
import { expireDueSupportSessions } from '@dealer/identity-access';
import { getConfig, logger } from '@dealer/platform';

/** The registered job names. `--list-jobs` prints exactly this. */
export const SUPPORT_ACCESS_EXPIRY_JOB = 'identity.support_access.expiry';

export const WORKER_JOBS: readonly string[] = [SUPPORT_ACCESS_EXPIRY_JOB];

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
 * Runs one pass of every registered job. A job that throws is logged and does NOT
 * stop the others or the loop: a transient database failure must not silently retire
 * the process that keeps the support trail complete.
 */
export async function runAllJobsOnce(): Promise<void> {
  try {
    await runSupportAccessExpiryOnce();
  } catch (err) {
    logger.error({ err, job: SUPPORT_ACCESS_EXPIRY_JOB }, 'worker job pass failed');
  }
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

  if (argv.includes('--once')) {
    logger.info({ jobs: WORKER_JOBS, mode: 'once' }, 'worker single pass');
    await runAllJobsOnce();
    await closePool();
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
