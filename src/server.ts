import * as promClient from 'prom-client';
import { createApp } from './app';
import { startMetricsAggregation } from './modules/service-cockpit/services/metrics-aggregator';
import { closePool } from './shared/database/pool';
import { logger } from './shared/utils/logger';

/**
 * Fail fast on missing secrets rather than at the first request that needs them —
 * a process that starts without `JWT_SECRET` would accept traffic it cannot
 * authenticate.
 */
function assertRequiredEnv(): void {
  const missing = ['DATABASE_URL', 'JWT_SECRET', 'STEP_UP_SECRET'].filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  // The verifiers enforce a 32-character minimum at call time. Checking only presence
  // here let the service start, pass its health check, and then fail every authenticated
  // request with a 500 — a configuration error presenting as an outage.
  const tooShort = (['JWT_SECRET', 'STEP_UP_SECRET'] as const).filter((key) => (process.env[key] ?? '').length < 32);
  if (tooShort.length > 0) {
    throw new Error(`These secrets must be at least 32 characters: ${tooShort.join(', ')}`);
  }
}

/** How long a graceful shutdown may take before the process force-exits. */
const SHUTDOWN_GRACE_MS = Number(process.env.SHUTDOWN_GRACE_MS ?? 30_000);

function main(): void {
  assertRequiredEnv();

  // Node process baseline (event-loop lag, GC, heap, open handles). These series are
  // label-free and bounded, so they satisfy the /metrics invariants (no tenant labels,
  // nothing request-driven). Registered here rather than in createApp() so each test's
  // app instance does not attempt a duplicate registration.
  promClient.collectDefaultMetrics();

  const port = Number(process.env.PORT ?? 3000);
  const server = createApp().listen(port, () => logger.info({ port }, 'Service cockpit API listening'));

  // Rates and ratios are computed on a schedule rather than from request traffic.
  const stopMetrics = startMetricsAggregation();

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'Shutting down');
    stopMetrics();

    // server.close() waits for in-flight requests, but a stuck keep-alive connection can
    // hold it open indefinitely — under an orchestrator that means SIGKILL mid-write at
    // the end of the termination grace period, at a moment we did not choose. Bound the
    // wait ourselves and exit non-zero so the failure is visible. unref'd, so the timer
    // never keeps an otherwise-finished process alive.
    const deadline = setTimeout(() => {
      logger.error({ graceMs: SHUTDOWN_GRACE_MS }, 'Graceful shutdown timed out; forcing exit');
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    deadline.unref();

    server.close(() => {
      closePool()
        .catch((err) => logger.error({ err }, 'Failed to close the database pool'))
        .finally(() => process.exit(0));
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
