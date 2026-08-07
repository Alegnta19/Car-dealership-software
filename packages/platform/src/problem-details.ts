/**
 * @dealer/platform — mapping from the application error vocabulary to the internal
 * RFC 9457-compatible Problem Details model (FBL-010 section G).
 *
 * Canonical internally; NOT the public wire format yet. The API's error renderer
 * consumes this and emits the characterized compatibility envelope; switching public
 * responses to application/problem+json is FBL-040 work.
 */
import { ProblemDetails } from '@dealer/contracts';
import { AppError } from './errors';
import { getRequestContext } from './request-context';

const TITLES: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  413: 'Content Too Large',
  422: 'Unprocessable Content',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};

export function toProblemDetails(err: unknown, opts: { instance?: string } = {}): ProblemDetails {
  const requestId = getRequestContext()?.requestId;
  const base = {
    ...(opts.instance !== undefined ? { instance: opts.instance } : {}),
    ...(requestId !== undefined ? { requestId } : {}),
  };

  if (err instanceof AppError) {
    return Object.freeze({
      type: `urn:dealer:error:${err.code}`,
      title: TITLES[err.statusCode] ?? 'Error',
      status: err.statusCode,
      detail: err.message,
      code: err.code,
      ...(err.details !== undefined ? { errors: err.details } : {}),
      ...base,
    });
  }

  // Unexpected failures: nothing from the underlying error reaches the model's
  // client-facing fields — driver text can echo row values or connection strings.
  return Object.freeze({
    type: 'urn:dealer:error:internal_error',
    title: 'Internal Server Error',
    status: 500,
    detail: 'Internal server error',
    code: 'internal_error',
    ...base,
  });
}
