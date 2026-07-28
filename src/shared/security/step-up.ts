import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import { ForbiddenError } from '../middleware/error-handler';

/**
 * A step-up token proves that a *specific* actor re-authenticated to perform one
 * *specific* privileged action on one *specific* resource, recently. It is bound to
 * all four so a token minted for one repair order cannot be replayed against another,
 * and a token minted for a technician cannot be used by an advisor.
 */
export interface StepUpBinding {
  tenantId: string;
  userId: string;
  /** e.g. `ro.transition:authorized`, `authorization.record:staff_attestation` */
  action: string;
  /** The id of the row being acted on. */
  resourceId: string;
}

interface StepUpPayload extends StepUpBinding {
  /** Unix seconds. */
  exp: number;
  jti: string;
}

const DEFAULT_TTL_SECONDS = 300;

function secret(): string {
  const value = process.env.STEP_UP_SECRET;
  if (!value || value.length < 32) {
    throw new Error('STEP_UP_SECRET must be set to at least 32 characters');
  }
  return value;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function sign(body: string): string {
  return createHmac('sha256', secret()).update(body).digest('base64url');
}

/**
 * Mints a step-up token. Issued by the step-up/re-auth flow (or by tests); this module
 * is the single place that decides what a valid token looks like.
 */
export function signStepUpToken(binding: StepUpBinding, ttlSeconds: number = DEFAULT_TTL_SECONDS): string {
  const payload: StepUpPayload = {
    ...binding,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
    jti: randomUUID(),
  };
  const body = b64url(JSON.stringify(payload));
  return `${body}.${sign(body)}`;
}

/**
 * Verifies a token against the action being attempted. Throws `ForbiddenError` unless
 * the signature is valid, the token has not expired, and every binding field matches.
 * Callers must treat any throw as a hard refusal — there is no partial success.
 */
export function verifyStepUpToken(token: unknown, expected: StepUpBinding): void {
  const reject = (reason: string): never => {
    throw new ForbiddenError('Step-up verification is required for this action', {
      code: 'step_up_required',
      details: { reason, action: expected.action },
    });
  };

  if (typeof token !== 'string' || !token.includes('.')) reject('missing_or_malformed_token');

  const [body, providedSignature] = (token as string).split('.');
  if (!body || !providedSignature) reject('malformed_token');

  const expectedSignature = sign(body);
  const provided = Buffer.from(providedSignature, 'utf8');
  const computed = Buffer.from(expectedSignature, 'utf8');
  if (provided.length !== computed.length || !timingSafeEqual(provided, computed)) reject('bad_signature');

  let payload: StepUpPayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return reject('undecodable_payload');
  }

  if (typeof payload.exp !== 'number' || payload.exp * 1000 <= Date.now()) reject('expired');
  if (payload.tenantId !== expected.tenantId) reject('tenant_mismatch');
  if (payload.userId !== expected.userId) reject('user_mismatch');
  if (payload.action !== expected.action) reject('action_mismatch');
  if (payload.resourceId !== expected.resourceId) reject('resource_mismatch');
}
