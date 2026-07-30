import * as promClient from 'prom-client';
import { createApp } from './app';
import { startMetricsAggregation } from '@dealer/fixed-ops';
import { closePool } from '@dealer/database';
import { AppConfig, initConfig, loadConfig, logger } from '@dealer/platform';

/**
 * Composition root. Configuration is loaded and validated HERE, once, before the
 * process accepts traffic — a process that cannot authenticate or reach its database
 * must fail at startup, not at the first request. `loadConfig` names the offending
 * variable in its error and never includes a value, so this failure path is safe to
 * print.
 */
function main(): void {
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

main();
