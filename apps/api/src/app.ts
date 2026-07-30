import express, { Express, NextFunction, Request, Response } from 'express';
import * as promClient from 'prom-client';
import serviceCockpitRouter from './routes/service-cockpit';
import { ValidationError } from '@dealer/platform';
import { errorHandler, notFoundHandler } from './middleware/error-handler';

export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: process.env.JSON_BODY_LIMIT ?? '1mb' }));

  // A malformed or oversized body is a client error, not a server fault. Without this
  // the body parser's SyntaxError reached the generic handler, which answered 500 and
  // logged a full stack — unauthenticated, and as many times as anyone cared to send.
  app.use((err: any, _req: Request, _res: Response, next: NextFunction) => {
    if (err?.type === 'entity.too.large') {
      return next(new ValidationError('Request body is too large', { code: 'body_too_large' }));
    }
    if (err instanceof SyntaxError && 'body' in err) {
      return next(new ValidationError('Request body is not valid JSON', { code: 'malformed_json' }));
    }
    return next(err);
  });

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
