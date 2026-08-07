/**
 * The ONLY file that touches @workos-inc/node (architecture-enforced). Every
 * shape crossing this boundary is a plain provider-neutral contract type; SDK
 * classes, enums and errors stop here.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { WorkOS } from '@workos-inc/node';
import { NOT_IMPERSONATED, ProviderRefreshError } from '../../contracts';
import type {
  AuthorizationRequest,
  CodeExchangeResult,
  IdentityProviderPort,
  ImpersonationClassification,
  ProviderRefreshFailureKind,
  ProviderRefreshResult,
} from '../../contracts';

export interface WorkosAdapterOptions {
  readonly clientId: string;
  readonly apiKey: string;
  readonly redirectUri: string;
  readonly reauthRedirectUri: string;
  readonly logoutRedirectUri: string;
  /**
   * FBL-020-R3 correction D1 — the HARD BOUND, in milliseconds, on an HTTP call
   * to the provider. REQUIRED: an unbounded call on the request path is the
   * defect, so there is no default here to forget to override.
   *
   * The SDK exposes no per-call deadline, so the value is applied twice:
   *   * as the SDK client's own per-request timeout, which is what puts an
   *     AbortSignal on the socket and tears the connection down;
   *   * as a TOTAL bound around the refresh exchange in `refreshSession`, so this
   *     port settles within the bound even if the SDK's internal timer never
   *     fires. A port that can hang forever makes every caller above it hang too.
   *
   * Because it configures the client, it bounds `exchangeCode` as well. That is
   * intended and stated rather than hidden: the code exchange is on a request path
   * too, and the SDK's own default (60s) is not a bound this platform chose.
   */
  readonly refreshTimeoutMs: number;
}

/**
 * R3 correction D1 — the CALLER's deadline for the exchange running on this async
 * context, so it can reach the socket.
 *
 * The SDK builds its own AbortController per request and hands only that signal
 * to `fetch`; there is no argument for passing one in. `fetchFn` is the seam that
 * exists, and AsyncLocalStorage is what makes the ambient value correct under
 * concurrency — a module-level variable would be read by whichever exchange
 * happened to be in flight, which is exactly the kind of cross-request confusion
 * this package refuses everywhere else.
 */
const callerDeadline = new AsyncLocalStorage<AbortSignal>();

/** Raised when the adapter's own total bound elapsed. Never definitive. */
class ProviderRefreshTimeout extends Error {
  constructor(timeoutMs: number) {
    super(`the provider did not answer the refresh exchange within ${timeoutMs}ms`);
    this.name = 'ProviderRefreshTimeout';
  }
}

/** An aborted signal from either side, as one signal fetch can be given. */
function combineSignals(a: AbortSignal | null | undefined, b: AbortSignal): AbortSignal {
  if (a === null || a === undefined) return b;
  const controller = new AbortController();
  for (const source of [a, b]) {
    if (source.aborted) {
      controller.abort(source.reason);
      return controller.signal;
    }
    source.addEventListener('abort', () => controller.abort(source.reason), { once: true });
  }
  return controller.signal;
}

/**
 * Runs `work` under a hard deadline, aborting the signal it is given so the
 * in-flight HTTP request is actually cancelled rather than merely abandoned. An
 * abandoned refresh exchange is worse than a cancelled one: it could still spend
 * the single-use refresh token after the caller has classified the attempt as
 * transient and released its claim on the session.
 *
 * The losing promise is explicitly consumed — a race whose loser rejects later
 * would otherwise become an unhandled rejection and take the process down, which
 * would turn a slow provider into a crash.
 */
async function withRefreshDeadline<T>(
  timeoutMs: number,
  caller: AbortSignal | undefined,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const onCallerAbort = (): void => controller.abort(caller?.reason);
  if (caller !== undefined) {
    if (caller.aborted) onCallerAbort();
    else caller.addEventListener('abort', onCallerAbort, { once: true });
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const running = work(controller.signal);
  void running.catch(() => undefined);
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ProviderRefreshTimeout(timeoutMs));
    }, timeoutMs);
  });
  try {
    return await Promise.race([running, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (caller !== undefined) caller.removeEventListener('abort', onCallerAbort);
  }
}

export function createWorkosProvider(options: WorkosAdapterOptions): IdentityProviderPort {
  const workos = new WorkOS(options.apiKey, {
    clientId: options.clientId,
    // The SDK's per-request bound: it attaches an AbortSignal to every fetch it
    // makes and aborts at this value.
    timeout: options.refreshTimeoutMs,
    // …and the caller's deadline is merged onto that same fetch, so an exchange
    // the caller has given up on stops holding a socket immediately instead of
    // running to the SDK's own timer.
    fetchFn: (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const caller = callerDeadline.getStore();
      if (caller === undefined) return fetch(input, init);
      return fetch(input, { ...init, signal: combineSignals(init?.signal, caller) });
    },
  });

  return {
    buildAuthorizationUrl(request: AuthorizationRequest): string {
      const url = new URL(
        workos.userManagement.getAuthorizationUrl({
          provider: 'authkit',
          clientId: options.clientId,
          redirectUri: request.redirectUri ?? options.redirectUri,
          state: request.state,
          codeChallenge: request.codeChallenge,
          codeChallengeMethod: 'S256',
          ...(request.organizationId !== undefined
            ? { organizationId: request.organizationId }
            : {}),
        }),
      );
      // Reauthentication: force a fresh provider authentication event.
      if (request.maxAgeSeconds !== undefined) {
        url.searchParams.set('max_age', String(request.maxAgeSeconds));
      }
      // OIDC nonce: the provider echoes it into the token, and the verifier
      // requires it to equal the value bound to this single-use transaction.
      if (request.nonce !== undefined) {
        url.searchParams.set('nonce', request.nonce);
      }
      return url.toString();
    },

    async exchangeCode(input: { code: string; codeVerifier: string }): Promise<CodeExchangeResult> {
      const result = await workos.userManagement.authenticateWithCode({
        clientId: options.clientId,
        code: input.code,
        codeVerifier: input.codeVerifier,
      });
      const name = [result.user.firstName, result.user.lastName]
        .filter((part): part is string => typeof part === 'string' && part.length > 0)
        .join(' ');
      return {
        accessToken: result.accessToken,
        refreshToken: result.refreshToken ?? null,
        providerUserId: result.user.id,
        providerSessionId: extractSessionId(result.accessToken),
        organizationId: result.organizationId ?? null,
        email: result.user.email ?? null,
        displayName: name.length > 0 ? name : null,
        impersonation: classifyImpersonation(
          result.impersonator,
          result.authenticationMethod ?? null,
        ),
      };
    },

    /**
     * FBL-020-R3: the REAL refresh exchange, replacing the hash-rotation
     * helper that never spoke to a provider. The presented refresh token is
     * spent here and `refreshToken` in the result is its REPLACEMENT.
     *
     * Every SDK exception is translated into ProviderRefreshError with a
     * classification the caller can act on; no SDK class escapes this file.
     *
     * R3 correction D1: the exchange is BOUNDED. It used to set no timeout and no
     * AbortSignal, so a provider that hung rather than errored made this call —
     * and the request path above it — wait indefinitely. Expiry is classified
     * TRANSIENT, never definitive: silence is not proof that a refresh token was
     * revoked, and treating it as proof would log people out for a network fault.
     */
    async refreshSession(input: {
      refreshToken: string;
      signal?: AbortSignal;
    }): Promise<ProviderRefreshResult> {
      let result;
      try {
        result = await withRefreshDeadline(options.refreshTimeoutMs, input.signal, (signal) =>
          callerDeadline.run(signal, () =>
            workos.userManagement.authenticateWithRefreshToken({
              clientId: options.clientId,
              refreshToken: input.refreshToken,
            }),
          ),
        );
      } catch (err) {
        throw new ProviderRefreshError(
          classifyRefreshFailure(err),
          'the provider refused, or did not answer, the refresh exchange',
          { cause: err },
        );
      }
      return {
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        providerUserId: result.user.id,
        providerSessionId: extractSessionId(result.accessToken),
        organizationId: result.organizationId ?? null,
        impersonation: classifyImpersonation(
          result.impersonator,
          result.authenticationMethod ?? null,
        ),
      };
    },

    buildLogoutUrl(input: { providerSessionId: string }): string {
      return workos.userManagement.getLogoutUrl({
        sessionId: input.providerSessionId,
        returnTo: options.logoutRedirectUri,
      });
    },
  };
}

/**
 * FBL-020-R3 — impersonation, classified and then FORGOTTEN.
 *
 * WorkOS reports an impersonated authentication two ways: an `impersonator`
 * object carrying the staff member's email and reason, and the authentication
 * method 'Impersonation'. Either one is enough to classify the session as
 * impersonated. The email is inspected ONLY to record that one existed — it is
 * never copied into the returned value, so nothing downstream can log, store
 * or leak it.
 */
function classifyImpersonation(
  impersonator: { email?: unknown; reason?: unknown } | undefined,
  authenticationMethod: string | null,
): ImpersonationClassification {
  const byMethod = authenticationMethod === 'Impersonation';
  if (impersonator === undefined || impersonator === null) {
    return byMethod ? { impersonated: true, impersonatorEmailPresent: false } : NOT_IMPERSONATED;
  }
  const email = impersonator.email;
  return {
    impersonated: true,
    impersonatorEmailPresent: typeof email === 'string' && email.length > 0,
  };
}

/**
 * Statuses that mean the PROVIDER ANSWERED AND REFUSED: the refresh token is
 * unusable and the local session must die. Everything else — 429, any 5xx,
 * DNS/socket/timeout failures, and anything unrecognised — is transient, so a
 * provider hiccup can never mass-revoke live sessions.
 */
const DEFINITIVE_REFRESH_STATUSES: ReadonlySet<number> = new Set([400, 401, 403, 404, 422]);

function classifyRefreshFailure(err: unknown): ProviderRefreshFailureKind {
  // R3 correction D1: SILENCE IS NOT A REFUSAL. A bound that elapsed, or a socket
  // this platform itself aborted, says only that the provider did not answer —
  // classifying either as definitive would let a slow network revoke sessions.
  // Stated ahead of the status check, and not merely left to the transient
  // default, so a future edit to the definitive set cannot capture a timeout.
  if (err instanceof ProviderRefreshTimeout) return 'transient';
  if (err instanceof Error && err.name === 'AbortError') return 'transient';
  const status = (err as { status?: unknown } | null | undefined)?.status;
  if (typeof status === 'number' && DEFINITIVE_REFRESH_STATUSES.has(status)) return 'definitive';
  return 'transient';
}

/**
 * The provider session id lives in the access token's `sid` claim. This is a
 * NON-VERIFYING read used solely to carry the sid into the logout URL — every
 * trust decision goes through the standards-based verifier instead.
 */
function extractSessionId(accessToken: string): string | null {
  const parts = accessToken.split('.');
  if (parts.length !== 3 || parts[1] === undefined) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as {
      sid?: unknown;
    };
    return typeof payload.sid === 'string' && payload.sid.length > 0 ? payload.sid : null;
  } catch {
    return null;
  }
}
