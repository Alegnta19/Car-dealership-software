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

function main(): void {
  assertRequiredEnv();

  const port = Number(process.env.PORT ?? 3000);
  const server = createApp().listen(port, () => logger.info({ port }, 'Service cockpit API listening'));

  // Rates and ratios are computed on a schedule rather than from request traffic.
  const stopMetrics = startMetricsAggregation();

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'Shutting down');
    stopMetrics();
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
