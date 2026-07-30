/**
 * Renders @dealer/platform errors as the stable public envelope
 * `{ success: false, error: { code, message, details? } }`. The envelope, status codes
 * and stable error codes are contract-characterized (tests/http-contract.test.ts) and
 * must not change here — public Problem Details adoption is FBL-040 work.
 */
import { NextFunction, Request, Response } from 'express';
import { AppError, logger, toProblemDetails } from '@dealer/platform';

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    success: false,
    error: { code: 'route_not_found', message: `No route for ${req.method} ${req.originalUrl}` },
  });
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  // The typed internal representation is canonical; what goes on the wire below is the
  // characterized compatibility envelope rendered FROM it. Status and code always come
  // from the model, so the two can never disagree.
  const problem = toProblemDetails(err, { instance: req.originalUrl });

  if (err instanceof AppError) {
    if (problem.status >= 500) logger.error({ err, path: req.originalUrl }, 'Request failed');
    else
      logger.warn(
        { code: problem.code, path: req.originalUrl, status: problem.status },
        'Request rejected',
      );

    res.status(problem.status).json({
      success: false,
      error: {
        code: problem.code,
        message: err.message,
        ...(err.messageI18n ? { message_i18n: err.messageI18n } : {}),
        ...(err.details ? { details: err.details } : {}),
      },
    });
    return;
  }

  // Unexpected failures never leak driver text (which can echo row values) to the client:
  // the model's detail is a generic constant for non-AppError failures.
  logger.error({ err, path: req.originalUrl }, 'Unhandled error');
  res.status(problem.status).json({
    success: false,
    error: { code: problem.code, message: problem.detail ?? 'Internal server error' },
  });
}
