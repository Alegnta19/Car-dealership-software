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

/**
 * Bounded safe format for ids that cross a process boundary. Bounded so a hostile
 * header cannot inject log content or absurd lengths into every downstream log line.
 */
const SAFE_ID = /^[A-Za-z0-9._-]{8,128}$/;

export function isSafeId(candidate: string): boolean {
  return SAFE_ID.test(candidate);
}

/**
 * FBL-020-R4 §2.3 — UNTRUSTED CLIENT TRACE METADATA.
 *
 * A gateway's own trace ids are useful to an operator joining our logs to theirs, and
 * they are worth keeping. What they must never be is AUTHORITATIVE: they are chosen by
 * whoever made the request, so a decision, an audit row or a log line that adopted one
 * would record a caller-controlled value under a name claiming the server assigned it.
 * Two requests could then share an id, and a hostile caller could deliberately reuse
 * somebody else's id and make the two indistinguishable in the trail.
 *
 * The values therefore live in a SEPARATE, OPAQUE box. It is a class, not a string, and
 * it exposes its contents only through `describe()`, which returns an OBJECT. There is
 * no `toString`, no `valueOf` and no readable string property, so
 * `requestId: ctx.untrustedClientTrace` does not compile, a template interpolation
 * yields `[object Object]` rather than the value, and nothing here can be handed to a
 * function that expects an id. The separation is enforced by the type, not by a comment
 * asking the next reader to be careful.
 */
export class UntrustedClientTrace {
  // ECMAScript `#` PRIVATE FIELDS, not TypeScript `private`. TypeScript's modifier is
  // erased at runtime: the values would still be enumerable, so `JSON.stringify(ctx)`
  // or the logger's object walk would print a caller-supplied value under a key called
  // `requestIdHeader` — precisely the confusion this class exists to prevent. A `#`
  // field is invisible to `Object.keys`, to `JSON.stringify` and to the redactor, so
  // the ONLY way to the values is `describe()`.
  readonly #requestIdHeader: string | null;
  readonly #correlationIdHeader: string | null;

  constructor(requestIdHeader: unknown, correlationIdHeader: unknown) {
    this.#requestIdHeader = UntrustedClientTrace.sanitize(requestIdHeader);
    this.#correlationIdHeader = UntrustedClientTrace.sanitize(correlationIdHeader);
  }

  /** Bounded, or dropped entirely: a hostile header value never reaches a log line. */
  private static sanitize(candidate: unknown): string | null {
    return typeof candidate === 'string' && SAFE_ID.test(candidate) ? candidate : null;
  }

  /** True when the caller sent anything at all worth reporting. */
  present(): boolean {
    return this.#requestIdHeader !== null || this.#correlationIdHeader !== null;
  }

  /**
   * The values, under names that state what they are. Deliberately keyed
   * `client_*_untrusted`: a reader has to name the untrust to reach them, and no field
   * of the result is called `requestId` or `correlationId`.
   */
  describe(): {
    client_request_id_untrusted: string | null;
    client_correlation_id_untrusted: string | null;
  } {
    return {
      client_request_id_untrusted: this.#requestIdHeader,
      client_correlation_id_untrusted: this.#correlationIdHeader,
    };
  }
}

export interface RequestContext {
  /** SERVER-GENERATED and authoritative. Never a header value. */
  readonly requestId: string;
  /** SERVER-GENERATED and authoritative. Never a header value. */
  readonly correlationId: string;
  readonly startTime: number;
  /** The caller's trace headers, boxed so they cannot be mistaken for the two above. */
  readonly untrustedClientTrace?: UntrustedClientTrace;
  tenantId?: string;
  userId?: string;
  roles?: readonly string[];
  /**
   * FBL-020-R4 §4 — the DELEGATED SUPPORT ACCESS this request is being served under,
   * or absent when it is not. Written once by `bindSupportContext`, never cleared.
   */
  readonly support?: SupportAccessFacts;
}

/**
 * FBL-020-R4 §4 — WHAT "SERVED UNDER SUPPORT ACCESS" MEANS, IN ONE SHAPE.
 *
 * A platform person acting inside a customer's data is the single most sensitive thing
 * this platform permits, and R3 propagated a fraction of it: the response header named
 * the session and nothing else, and the request context and log lines named none of it.
 * An operator reading the logs of an incident could therefore see a platform user id and
 * a tenant id and had no way to learn that the access was DELEGATED, which request
 * authorized it, what it was approved to do, or when it lapses.
 *
 * All seven facts travel together, deliberately: any subset invites a reader to conclude
 * something the missing fields would have contradicted. Every one of them is an
 * identifier, a classification or an instant.
 *
 * WHAT IS NOT HERE, and must never be added: the free-text support REASON (it lives in
 * `support_access_requests.reason` and is read by nothing else), the platform person's
 * email or display name, any provider token, subject or session id, and any customer
 * data. The reason in particular is the field that would turn every ordinary log line
 * into a disclosure.
 */
export interface SupportAccessFacts {
  /** The live support session — the object an operator can revoke this instant. */
  readonly supportSessionId: string;
  /** The approved REQUEST that authorized it: the "why", by reference, never by text. */
  readonly supportRequestId: string;
  /** The TRUE actor: the platform-support person. Never an impersonated customer user. */
  readonly supportActorUserLinkId: string;
  /** The customer tenant being reached into. */
  readonly targetTenantId: string;
  /** The approved scope: how far into the tenant the grant reaches. */
  readonly approvedScopeLevel: string;
  readonly approvedScopeId: string | null;
  /** The approved action set. A support session authorizes NOTHING outside it. */
  readonly approvedActions: readonly string[];
  /** When the window closes. Every carrier of these facts must carry this one. */
  readonly expiresAt: Date;
}

/**
 * Raised when one request is asked to serve TWO different support sessions.
 *
 * It cannot legitimately happen — a request presents one credential and the engine
 * matches one live session — so if it does, something has confused two requests'
 * contexts, and continuing would mean logging and auditing the wrong session for the
 * data being touched. Failing is the only safe direction.
 */
export class SupportContextConflictError extends Error {}

const storage = new AsyncLocalStorage<RequestContext>();

/**
 * FBL-020-R4 §2.3 — THIS REPLACES `acceptOrGenerateId`, AND THE NAME IS THE POINT.
 *
 * Under the old name a caller-supplied value that matched `SAFE_ID` BECAME the request
 * id, and only a malformed one was replaced. A well-formed `x-request-id` was therefore
 * the authoritative id of the request: echoed in the response, stamped on every log
 * line, and carried through the request context into `policy_decisions.request_id`,
 * which is append-only evidence. The id is now ALWAYS generated here; the caller's
 * value is retained separately, as `UntrustedClientTrace`, or not at all.
 */
export function generateRequestId(): string {
  return randomUUID();
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

/**
 * FBL-020-R4 §4 — BINDS THE SUPPORT FACTS TO THIS REQUEST, NON-SUPPRESSIBLY.
 *
 * "Non-suppressible" is not a wish here, it is the property the two lines below buy:
 *
 *   - `writable: false` — nothing downstream can blank the facts out. A route, a later
 *     middleware or a well-meaning error handler that assigned `ctx.support = undefined`
 *     throws (strict mode) or is ignored; either way the log lines and the audit trail
 *     keep saying that this request was served under delegated access.
 *   - `configurable: false` — nor can the property be deleted and redefined, which is the
 *     obvious way around a merely read-only field.
 *
 * Re-binding the SAME session is a no-op, so a middleware that runs twice is harmless.
 * Re-binding a DIFFERENT session throws: see `SupportContextConflictError`.
 *
 * The facts are frozen and the action list is copied, so the caller cannot mutate what
 * the logs will print after the fact.
 */
export function bindSupportContext(facts: SupportAccessFacts): void {
  const store = storage.getStore();
  if (!store) return;
  const existing = store.support;
  if (existing !== undefined) {
    if (existing.supportSessionId === facts.supportSessionId) return;
    throw new SupportContextConflictError(
      'this request is already bound to a different support session',
    );
  }
  Object.defineProperty(store, 'support', {
    value: Object.freeze({
      supportSessionId: facts.supportSessionId,
      supportRequestId: facts.supportRequestId,
      supportActorUserLinkId: facts.supportActorUserLinkId,
      targetTenantId: facts.targetTenantId,
      approvedScopeLevel: facts.approvedScopeLevel,
      approvedScopeId: facts.approvedScopeId,
      approvedActions: Object.freeze([...facts.approvedActions]),
      expiresAt: new Date(facts.expiresAt.getTime()),
    }),
    writable: false,
    enumerable: true,
    configurable: false,
  });
}

/**
 * The support facts as LOG FIELDS: snake_case keys, bounded values, no Date objects.
 *
 * It lives beside the binder rather than in the logger so there is exactly one mapping
 * from facts to field names — the response header, the audit details and the log line
 * are then talking about the same seven things under the same names.
 */
export function supportContextLogFields(
  facts: SupportAccessFacts,
): Record<string, string | number | readonly string[] | null> {
  return {
    support_access: 'active',
    support_session_id: facts.supportSessionId,
    support_request_id: facts.supportRequestId,
    support_actor_user_link_id: facts.supportActorUserLinkId,
    support_target_tenant_id: facts.targetTenantId,
    support_approved_scope_level: facts.approvedScopeLevel,
    support_approved_scope_id: facts.approvedScopeId,
    support_approved_actions: facts.approvedActions,
    support_session_expires_at: facts.expiresAt.toISOString(),
  };
}
