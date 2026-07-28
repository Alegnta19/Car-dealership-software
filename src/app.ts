import express, { Express, Request, Response } from 'express';
import * as promClient from 'prom-client';
import serviceCockpitRouter from './modules/service-cockpit/routes';
import { errorHandler, notFoundHandler } from './shared/middleware/error-handler';

export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: process.env.JSON_BODY_LIMIT ?? '1mb' }));

  app.get('/healthz', (_req: Request, res: Response) => {
    res.json({ status: 'ok' });
  });

  // Prometheus scrape target. Unauthenticated by design — bind it to an internal
  // interface or gate it at the ingress, not in application code.
  app.get('/metrics', async (_req: Request, res: Response) => {
    res.set('Content-Type', promClient.register.contentType);
    res.end(await promClient.register.metrics());
  });

  app.use('/api/service', serviceCockpitRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
