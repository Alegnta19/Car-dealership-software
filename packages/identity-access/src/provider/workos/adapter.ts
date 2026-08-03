/**
 * The ONLY file that touches @workos-inc/node (architecture-enforced). Every
 * shape crossing this boundary is a plain provider-neutral contract type; SDK
 * classes, enums and errors stop here.
 */
import { WorkOS } from '@workos-inc/node';
import type {
  AuthorizationRequest,
  CodeExchangeResult,
  IdentityProviderPort,
} from '../../contracts';

export interface WorkosAdapterOptions {
  readonly clientId: string;
  readonly apiKey: string;
  readonly redirectUri: string;
  readonly reauthRedirectUri: string;
  readonly logoutRedirectUri: string;
}

export function createWorkosProvider(options: WorkosAdapterOptions): IdentityProviderPort {
  const workos = new WorkOS(options.apiKey, { clientId: options.clientId });

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
