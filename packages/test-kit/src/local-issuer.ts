/**
 * Deterministic local OIDC issuer for CI and local runs (FBL-020).
 *
 * Stands in for the provider so the verifier's behaviour — configured-JWKS
 * pinning, algorithm allowlists, claim requirements, unknown-kid refresh
 * bounds, rotation without restart, fail-closed outages — is provable with
 * NO live WorkOS credential. Serves a real HTTP JWKS endpoint on 127.0.0.1
 * and counts every fetch so tests can assert refresh-bounding exactly.
 */
import { createServer, type Server } from 'node:http';
import { createSecretKey, randomUUID } from 'node:crypto';
import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose';

export interface LocalIssuerClaims {
  sub?: string;
  sid?: string;
  org_id?: string | null;
  auth_time?: number;
  iat?: number;
  exp?: number;
  nbf?: number;
  aud?: string;
  iss?: string;
  role?: string;
  permissions?: string[];
  [claim: string]: unknown;
}

export interface SignOptions {
  /** Sign with a key whose kid the JWKS does NOT publish. */
  unpublishedKey?: boolean;
  /** Sign symmetrically (HS256) — must always be rejected. */
  symmetric?: boolean;
  /** Emit an unsigned alg=none token — must always be rejected. */
  unsigned?: boolean;
  /** Drop these claims entirely from the payload. */
  omit?: readonly string[];
}

export interface LocalIssuer {
  readonly issuer: string;
  readonly jwksUri: string;
  readonly audience: string;
  /** How many times the JWKS endpoint has been fetched. */
  jwksFetchCount(): number;
  /** Replace the signing key (new kid); the JWKS serves only the new key. */
  rotateKeys(): Promise<void>;
  /** Refuse to serve JWKS (simulated provider outage). */
  setOutage(outage: boolean): void;
  signAccessToken(claims?: LocalIssuerClaims, options?: SignOptions): Promise<string>;
  stop(): Promise<void>;
}

type GeneratedKeyPair = Awaited<ReturnType<typeof generateKeyPair>>;

interface KeyState {
  kid: string;
  privateKey: GeneratedKeyPair['privateKey'];
  publicJwk: JWK;
}

async function makeKey(): Promise<KeyState> {
  const kid = 'local-' + randomUUID();
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const publicJwk = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' };
  return { kid, privateKey, publicJwk };
}

export async function startLocalIssuer(options?: { audience?: string }): Promise<LocalIssuer> {
  let current = await makeKey();
  const unpublished = await makeKey();
  let fetches = 0;
  let outage = false;

  const server: Server = createServer((req, res) => {
    if (req.url !== undefined && req.url.startsWith('/jwks')) {
      fetches += 1;
      if (outage) {
        res.statusCode = 503;
        res.end('issuer outage (simulated)');
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ keys: [current.publicJwk] }));
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('local issuer failed to bind');
  }
  const origin = `http://127.0.0.1:${address.port}`;
  const audience = options?.audience ?? 'dealer-platform-api';

  return {
    issuer: origin,
    jwksUri: origin + '/jwks.json',
    audience,
    jwksFetchCount: () => fetches,
    async rotateKeys(): Promise<void> {
      current = await makeKey();
    },
    setOutage(value: boolean): void {
      outage = value;
    },
    async signAccessToken(claims?: LocalIssuerClaims, signOptions?: SignOptions): Promise<string> {
      const now = Math.floor(Date.now() / 1000);
      const payload: Record<string, unknown> = {
        iss: origin,
        aud: audience,
        sub: 'user_local_' + randomUUID().slice(0, 8),
        sid: 'session_' + randomUUID().slice(0, 8),
        org_id: 'org_local_test',
        auth_time: now,
        iat: now,
        exp: now + 300,
        ...claims,
      };
      for (const name of signOptions?.omit ?? []) {
        delete payload[name];
      }

      if (signOptions?.unsigned === true) {
        const b64 = (obj: unknown) =>
          Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
        return `${b64({ alg: 'none', typ: 'JWT' })}.${b64(payload)}.`;
      }
      if (signOptions?.symmetric === true) {
        const secret = createSecretKey(
          Buffer.from('local-issuer-symmetric-test-secret-0001', 'utf8'),
        );
        return new SignJWT(payload as LocalIssuerClaims)
          .setProtectedHeader({ alg: 'HS256', kid: current.kid })
          .sign(secret);
      }
      const key = signOptions?.unpublishedKey === true ? unpublished : current;
      return new SignJWT(payload as LocalIssuerClaims)
        .setProtectedHeader({ alg: 'RS256', kid: key.kid })
        .sign(key.privateKey);
    },
    async stop(): Promise<void> {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}
