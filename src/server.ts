import { createApp } from './app';
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
}

function main(): void {
  assertRequiredEnv();

  const port = Number(process.env.PORT ?? 3000);
  const server = createApp().listen(port, () => logger.info({ port }, 'Service cockpit API listening'));

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'Shutting down');
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
