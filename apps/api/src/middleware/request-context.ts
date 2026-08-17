/**
 * Outermost request middleware: establishes the platform request context for the whole
 * request lifetime and echoes the SERVER-GENERATED request id back to the caller.
 *
 * FBL-020-R4 §2.3 — THE IDS ARE GENERATED HERE AND NOWHERE ELSE.
 *
 * This middleware used to ADOPT `x-request-id` whenever it matched a bounded safe
 * format, and `x-correlation-id` likewise. The consequence ran far past logging: the
 * request context is what `@dealer/identity-access` reads when it writes an
 * append-only `policy_decisions` row, so a caller chose the `request_id` and
 * `correlation_id` of the evidence recorded about its own authorization decisions. It
 * could give two requests the same id, or reuse the id of somebody else's request, and
 * the audit trail could not tell them apart.
 *
 * Both ids are now minted per request. The caller's headers are still READ — a gateway
 * trace is genuinely useful — but they are boxed in `UntrustedClientTrace`, which has
 * no string form and no field named like an id, so they cannot be assigned to,
 * confused with, or logged as the authoritative pair. `x-correlation-id` no longer
 * defaults the correlation id either: it defaults to the GENERATED request id, so a
 * gateway that propagates only one header still correlates, without a caller naming
 * anything.
 */
import { NextFunction, Request, Response } from 'express';
import { UntrustedClientTrace, generateRequestId, runWithRequestContext } from '@dealer/platform';

export function requestContext(req: Request, res: Response, next: NextFunction): void {
  const requestId = generateRequestId();
  // One generated value for both by default: an operator joining a decision row to its
  // log lines needs them to agree, and nothing outside this process gets to decide it.
  const correlationId = requestId;
  const untrustedClientTrace = new UntrustedClientTrace(
    req.headers['x-request-id'],
    req.headers['x-correlation-id'],
  );

  // The echo is the GENERATED id. A caller that sent its own header gets ours back,
  // which is the honest answer to "what id did you file this request under".
  res.setHeader('x-request-id', requestId);
  runWithRequestContext(
    { requestId, correlationId, startTime: Date.now(), untrustedClientTrace },
    () => next(),
  );
}
