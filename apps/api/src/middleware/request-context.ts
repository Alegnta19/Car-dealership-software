/**
 * Outermost request middleware: establishes the platform request context for the whole
 * request lifetime and echoes the request id back to the caller.
 *
 * A caller-provided x-request-id is accepted only when it satisfies the bounded safe
 * format; anything else is replaced with a generated UUID (never trusted into logs).
 * x-correlation-id follows the same rule and defaults to the request id, so a gateway
 * that only propagates one header still correlates.
 */
import { NextFunction, Request, Response } from 'express';
import { acceptOrGenerateId, isSafeId, runWithRequestContext } from '@dealer/platform';

export function requestContext(req: Request, res: Response, next: NextFunction): void {
  const requestId = acceptOrGenerateId(req.headers['x-request-id']);
  const rawCorrelation = req.headers['x-correlation-id'];
  const correlationId =
    typeof rawCorrelation === 'string' && isSafeId(rawCorrelation) ? rawCorrelation : requestId;

  res.setHeader('x-request-id', requestId);
  runWithRequestContext({ requestId, correlationId, startTime: Date.now() }, () => next());
}
