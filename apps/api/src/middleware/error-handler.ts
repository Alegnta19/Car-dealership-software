/**
 * Renders @dealer/platform errors as the stable public envelope
 * `{ success: false, error: { code, message, details? } }`. The envelope, status codes
 * and stable error codes are contract-characterized (tests/http-contract.test.ts) and
 * must not change here — public Problem Details adoption is FBL-040 work.
 */
import { NextFunction, Request, Response } from 'express';
import { AppError, logger } from '@dealer/platform';

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    success: false,
    error: { code: 'route_not_found', message: `No route for ${req.method} ${req.originalUrl}` },
  });
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof AppError) {
    if (err.statusCode >= 500) logger.error({ err, path: req.originalUrl }, 'Request failed');
    else
      logger.warn(
        { code: err.code, path: req.originalUrl, status: err.statusCode },
        'Request rejected',
      );

    res.status(err.statusCode).json({
      success: false,
      error: {
        code: err.code,
        message: err.message,
        ...(err.messageI18n ? { message_i18n: err.messageI18n } : {}),
        ...(err.details ? { details: err.details } : {}),
      },
    });
    return;
  }

  // Unexpected failures never leak driver text (which can echo row values) to the client.
  logger.error({ err, path: req.originalUrl }, 'Unhandled error');
  res.status(500).json({
    success: false,
    error: { code: 'internal_error', message: 'Internal server error' },
  });
}
