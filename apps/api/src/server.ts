import * as promClient from 'prom-client';
import { createApp } from './app';
import { startMetricsAggregation } from '@dealer/fixed-ops';
import { assertRuntimePosture, closePool } from '@dealer/database';
import { AppConfig, initConfig, loadConfig, logger } from '@dealer/platform';

/**
 * Composition root. Configuration is loaded and validated HERE, once, before the
 * process accepts traffic — a process that cannot authenticate or reach its database
 * must fail at startup, not at the first request. `loadConfig` names the offending
 * variable in its error and never includes a value, so this failure path is safe to
 * print.
 */
async function main(): Promise<void> {
  let config: AppConfig;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    process.stderr.write(
      `Invalid configuration: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
    return;
  }
  initConfig(config);

  // FBL-020-R7-C1 §2 — FAIL CLOSED ON THE RUNTIME DATABASE POSTURE. In
  // production the process must serve on a NON-OWNER, non-superuser database
  // login (migration 060's dealership_app); it asks the database who it
  // actually is and refuses to accept traffic if the connection is privileged
  // or cannot even record decisions. Gated to production so local/test smoke,
  // which legitimately connects as the owner to set fixtures up, still runs.
  if (config.isProduction) {
    try {
      const posture = await assertRuntimePosture();
      logger.info({ dbUser: posture.currentUser }, 'Runtime database posture verified');
    } catch (err) {
      process.stderr.write(
        `Refusing to start: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      await closePool().catch(() => undefined);
      process.exit(1);
      return;
    }
  }

  // Node process baseline (event-loop lag, GC, heap, open handles). These series are
  // label-free and bounded, so they satisfy the /metrics invariants (no tenant labels,
  // nothing request-driven). Registered here rather than in createApp() so each test's
  // app instance does not attempt a duplicate registration.
  promClient.collectDefaultMetrics();

  const server = createApp().listen(config.port, () =>
    logger.info({ port: config.port }, 'Service cockpit API listening'),
  );

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
      logger.error(
        { graceMs: config.shutdownGraceMs },
        'Graceful shutdown timed out; forcing exit',
      );
      process.exit(1);
    }, config.shutdownGraceMs);
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

void main();
