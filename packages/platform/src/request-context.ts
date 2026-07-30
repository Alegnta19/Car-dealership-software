/**
 * @dealer/platform — request context (FBL-010 section E).
 *
 * One AsyncLocalStorage store per request, established by the API's outermost
 * middleware. Structured logging reads it implicitly, so every log line inside a
 * request carries request_id / correlation_id (and tenant/user once authenticated)
 * without any global mutable request state — and without leaking between concurrent
 * requests, which AsyncLocalStorage guarantees per async execution tree.
 *
 * The context never carries request bodies, tokens, cookies, or PII: ids here are
 * opaque UUIDs/identifiers only.
 */
import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';

export interface RequestContext {
  readonly requestId: string;
  readonly correlationId: string;
  readonly startTime: number;
  tenantId?: string;
  userId?: string;
  roles?: readonly string[];
}

const storage = new AsyncLocalStorage<RequestContext>();

/**
 * Bounded safe format for caller-provided ids: anything else is discarded and a fresh
 * UUID is generated. Bounded so a hostile header cannot inject log content or absurd
 * lengths into every downstream log line.
 */
const SAFE_ID = /^[A-Za-z0-9._-]{8,128}$/;

export function isSafeId(candidate: string): boolean {
  return SAFE_ID.test(candidate);
}

export function acceptOrGenerateId(candidate: unknown): string {
  return typeof candidate === 'string' && SAFE_ID.test(candidate) ? candidate : randomUUID();
}

export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * Attaches the authenticated actor to the current request's context (no-op outside a
 * request). Called by the API's authenticate middleware after the token is verified —
 * authorization decisions themselves are unchanged and never read this store.
 */
export function bindRequestActor(actor: {
  tenantId: string;
  userId: string;
  roles: readonly string[];
}): void {
  const store = storage.getStore();
  if (!store) return;
  store.tenantId = actor.tenantId;
  store.userId = actor.userId;
  store.roles = [...actor.roles];
}
