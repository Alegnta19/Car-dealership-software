/**
 * The ONE provider port this process talks to (FBL-020-R3 correction C1).
 *
 * Two paths need it, and they used to have no way to share it: the /auth
 * surface (code exchange, logout URL) and REQUEST AUTHENTICATION, which now
 * refreshes a provider session whose access token is at or near expiry before
 * serving the request. Constructing a second adapter inside the middleware
 * would mean two SDK clients, two configuration reads and two things to keep in
 * step, so the instance lives here and both callers resolve it.
 *
 * The port is provider-NEUTRAL by contract (`IdentityProviderPort`), which is
 * what lets a test drive the whole production refresh path — middleware, session
 * maintenance, rotation, revocation — against a deterministic fake instead of
 * reaching WorkOS over the network. That substitution is the only reason
 * `useIdentityProviderForTests` exists; nothing in a running process calls it.
 */
import { createWorkosProvider, type IdentityProviderPort } from '@dealer/identity-access';
import type { WorkosIdentitySettings } from '@dealer/platform';

let instance: IdentityProviderPort | undefined;
let testOverride: IdentityProviderPort | undefined;

/**
 * The adapter for the CONFIGURED provider. Settings are passed in rather than
 * read here, so each caller keeps its own answer to "there is no provider
 * configured" (the /auth surface does not exist; a request is unauthorized).
 */
export function identityProvider(settings: WorkosIdentitySettings): IdentityProviderPort {
  if (testOverride !== undefined) return testOverride;
  if (instance === undefined) {
    instance = createWorkosProvider({
      clientId: settings.clientId,
      apiKey: settings.apiKey,
      redirectUri: settings.redirectUri,
      reauthRedirectUri: settings.reauthRedirectUri,
      logoutRedirectUri: settings.logoutRedirectUri,
      // R3 correction D1: request authentication refreshes provider sessions, so
      // the adapter is never allowed to make an unbounded HTTP call.
      refreshTimeoutMs: settings.providerRefreshTimeoutMs,
    });
  }
  return instance;
}

/**
 * Test-only: substitutes the provider port so a suite can exercise the real
 * request path without a live WorkOS credential. Passing `undefined` restores
 * the configured adapter.
 */
export function useIdentityProviderForTests(port: IdentityProviderPort | undefined): void {
  testOverride = port;
}

/** Test-only: drops the memoized adapter and any substitution. */
export function resetIdentityProviderForTests(): void {
  instance = undefined;
  testOverride = undefined;
}
