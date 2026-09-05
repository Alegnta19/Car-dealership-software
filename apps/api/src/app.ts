import path from 'path';
import express, { Express, NextFunction, Request, Response } from 'express';
import * as promClient from 'prom-client';
import authRouter from './routes/auth';
import serviceCockpitRouter from './routes/service-cockpit';
import adminRouter from './routes/admin';
import inventoryRouter from './routes/inventory';
import crmRouter from './routes/crm';
import salesRouter from './routes/sales';
import deskingRouter from './routes/desking';
import jacketRouter from './routes/jacket';
import signRouter from './routes/sign';
import esignCallbackRouter from './routes/esign-callback';
import { ValidationError, getConfig } from '@dealer/platform';
import { errorHandler, notFoundHandler } from './middleware/error-handler';
import { requestContext } from './middleware/request-context';

export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  // Outermost: every subsequent middleware, handler and log line runs inside the
  // request context established here.
  app.use(requestContext);
  // FBL-140: the e-sign provider's callback is verified over its RAW bytes, so it
  // is mounted BEFORE the JSON parser and reads the body itself.
  app.use('/api/jacket/provider', esignCallbackRouter);
  app.use(express.json({ limit: getConfig().jsonBodyLimit }));

  // A malformed or oversized body is a client error, not a server fault. Without this
  // the body parser's SyntaxError reached the generic handler, which answered 500 and
  // logged a full stack — unauthenticated, and as many times as anyone cared to send.
  app.use((err: any, _req: Request, _res: Response, next: NextFunction) => {
    if (err?.type === 'entity.too.large') {
      return next(new ValidationError('Request body is too large', { code: 'body_too_large' }));
    }
    if (err instanceof SyntaxError && 'body' in err) {
      return next(
        new ValidationError('Request body is not valid JSON', { code: 'malformed_json' }),
      );
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

  app.use('/auth', authRouter);
  app.use('/api/service', serviceCockpitRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api/inventory', inventoryRouter);
  app.use('/api/crm', crmRouter);
  app.use('/api/sales', salesRouter);
  app.use('/api/desking', deskingRouter);
  app.use('/api/jacket', jacketRouter);
  // FBL-140: the CUSTOMER SIGNER'S lane. No staff session, no WorkOS — a lane
  // token the provider delivered is the only credential, and the page is served
  // same-origin so the token never crosses to another host.
  app.use('/sign/api', signRouter);
  app.use('/sign', express.static(path.join(__dirname, '..', '..', 'web', 'sign')));

  // RT1: the staff administration UI — static, dependency-free, served
  // same-origin so the session cookie and CSRF model apply unchanged. The
  // path resolves identically from src (tsx) and dist (compiled): both sit
  // two directories below apps/.
  app.use('/admin', express.static(path.join(__dirname, '..', '..', 'web', 'public')));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
