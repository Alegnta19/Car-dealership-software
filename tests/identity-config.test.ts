import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { loadConfig } from '@dealer/platform';
import {
  PLATFORM_SUPPORT_AUTHORITY_ROLES,
  ProviderRefreshError,
  createWorkosProvider,
} from '@dealer/identity-access';
import { identitySetCookieHeader } from '@dealer/api';

const BASE = {
  DATABASE_URL: 'postgresql://localhost/db',
};

const WORKOS = {
  ...BASE,
  IDENTITY_PROVIDER: 'workos',
  WORKOS_CLIENT_ID: 'client_01ABC',
  WORKOS_API_KEY: 'k'.repeat(40),
  WORKOS_ISSUER: 'https://auth.example.workos.com',
  WORKOS_JWKS_URI: 'https://auth.example.workos.com/oauth2/jwks',
  WORKOS_REDIRECT_URI: 'https://app.example.com/auth/callback',
  WORKOS_REAUTH_REDIRECT_URI: 'https://app.example.com/auth/reauth/callback',
  WORKOS_LOGOUT_REDIRECT_URI: 'https://app.example.com/',
  WORKOS_COOKIE_PASSWORD: 'c'.repeat(40),
  OIDC_AUDIENCE: 'dealer-platform-api',
};

describe('identity configuration (FBL-020)', () => {
  test('identity defaults to DISABLED — CI and local dev need no WorkOS variable', () => {
    const config = loadConfig(BASE);
    assert.deepEqual(config.identity, { provider: 'disabled' });
  });

  test('unknown providers are refused by name', () => {
    assert.throws(() => loadConfig({ ...BASE, IDENTITY_PROVIDER: 'auth0' }), /IDENTITY_PROVIDER/);
  });

  test('provider=workos loads the full validated settings block', () => {
    const config = loadConfig(WORKOS);
    assert.equal(config.identity.provider, 'workos');
    if (config.identity.provider !== 'workos') return;
    assert.equal(config.identity.workos.clientId, 'client_01ABC');
    assert.equal(config.identity.workos.oidcClockSkewSeconds, 60);
  });

  test('every WorkOS variable is REQUIRED once the provider is selected', () => {
    for (const name of [
      'WORKOS_CLIENT_ID',
      'WORKOS_API_KEY',
      'WORKOS_ISSUER',
      'WORKOS_JWKS_URI',
      'WORKOS_REDIRECT_URI',
      'WORKOS_REAUTH_REDIRECT_URI',
      'WORKOS_LOGOUT_REDIRECT_URI',
      'WORKOS_COOKIE_PASSWORD',
      'OIDC_AUDIENCE',
    ]) {
      const env: Record<string, string | undefined> = { ...WORKOS };
      delete env[name];
      assert.throws(() => loadConfig(env), new RegExp(name), `${name} must be required`);
    }
  });

  test('secrets have a minimum length and errors NAME the variable, never its value', () => {
    try {
      loadConfig({ ...WORKOS, WORKOS_API_KEY: 'short' });
      assert.fail('expected a config error');
    } catch (err) {
      const message = (err as Error).message;
      assert.match(message, /WORKOS_API_KEY/);
      assert.ok(!message.includes('short'), 'the invalid value must not be echoed');
    }
  });

  test('production demands https on every identity URL', () => {
    for (const name of [
      'WORKOS_ISSUER',
      'WORKOS_JWKS_URI',
      'WORKOS_REDIRECT_URI',
      'WORKOS_REAUTH_REDIRECT_URI',
      'WORKOS_LOGOUT_REDIRECT_URI',
    ] as const) {
      const env = { ...WORKOS, NODE_ENV: 'production', [name]: 'http://plain.example.com/x' };
      assert.throws(
        () => loadConfig(env),
        /https outside local development/,
        `${name} must demand https in production`,
      );
    }
    // FBL-020-R2: http is no longer permitted merely by "not production".
    // Staging commonly runs NODE_ENV=production, and a shared host with
    // NODE_ENV=development must not silently downgrade. Local development
    // must DECLARE itself.
    assert.throws(
      () => loadConfig({ ...WORKOS, WORKOS_ISSUER: 'http://127.0.0.1:39999' }),
      /https outside local development/,
      'http is refused without an explicit local-development declaration',
    );
    // …and is permitted once declared, which is what the test harness does.
    // R3 section J: the ALLOW_INSECURE_LOCAL_IDENTITY override is GONE — it
    // permitted http on any host, including staging.
    assert.throws(
      () =>
        loadConfig({
          ...WORKOS,
          WORKOS_ISSUER: 'http://issuer.staging.example.com',
          NODE_ENV: 'development',
        }),
      /https outside local development/,
      'a REMOTE host may not use http even in development',
    );
    assert.equal(
      loadConfig({ ...WORKOS, WORKOS_ISSUER: 'http://localhost:39999', NODE_ENV: 'development' })
        .identity.provider,
      'workos',
    );
    assert.equal(
      loadConfig({ ...WORKOS, WORKOS_ISSUER: 'http://127.0.0.1:39999', NODE_ENV: 'test' }).identity
        .provider,
      'workos',
    );
  });

  /**
   * FBL-020-R3 correction B1 — the cookie decision, asserted on the SET-COOKIE
   * ATTRIBUTE the /auth surface actually emits.
   *
   * The defect: `isLocalDevelopment` was NODE_ENV alone and the cookie writer
   * read it, so a real deployment whose identity URLs were all remote HTTPS
   * but whose process ran NODE_ENV=development issued session, transaction and
   * CLEARING cookies with no `Secure` attribute. URL validation was untouched
   * by that bug — it has its own loopback condition — which is exactly why
   * this test asserts the header rather than the validator.
   */
  const LOOPBACK_IDENTITY = {
    ...WORKOS,
    WORKOS_ISSUER: 'http://127.0.0.1:39999',
    WORKOS_JWKS_URI: 'http://127.0.0.1:39999/oauth2/jwks',
    WORKOS_REDIRECT_URI: 'http://127.0.0.1:3000/auth/callback',
    WORKOS_REAUTH_REDIRECT_URI: 'http://localhost:3000/auth/reauth/callback',
    WORKOS_LOGOUT_REDIRECT_URI: 'http://127.0.0.1:3000/',
  };

  const sessionCookie = (env: Record<string, string | undefined>): string =>
    identitySetCookieHeader(loadConfig(env), 'dealer_session', 'opaque-session-token', {
      maxAgeSeconds: 3600,
      path: '/',
    });
  const clearingCookie = (env: Record<string, string | undefined>): string =>
    identitySetCookieHeader(loadConfig(env), 'dealer_session', '', {
      maxAgeSeconds: 0,
      path: '/',
    });

  test('a REMOTE deployment keeps Secure cookies even at NODE_ENV=development', () => {
    // THE DEFECT, stated as configuration: every identity URL is remote https,
    // and the process happens to run NODE_ENV=development.
    const remoteDev = { ...WORKOS, NODE_ENV: 'development' };
    assert.equal(
      loadConfig(remoteDev).allowsInsecureCookies,
      false,
      'NODE_ENV alone must never license an insecure cookie',
    );
    assert.match(
      sessionCookie(remoteDev),
      /(^|; )Secure($|;)/,
      'the session cookie of a remote deployment must carry Secure',
    );
    assert.match(
      clearingCookie(remoteDev),
      /(^|; )Secure($|;)/,
      'the CLEARING cookie must carry the same Secure attribute it replaces',
    );
    assert.match(sessionCookie({ ...WORKOS, NODE_ENV: 'test' }), /(^|; )Secure($|;)/);

    // a MIXED set — loopback redirect URIs, a remote provider issuer — is a
    // real deployment too: one remote URL is enough to keep Secure on.
    const mixed = {
      ...LOOPBACK_IDENTITY,
      WORKOS_ISSUER: WORKOS.WORKOS_ISSUER,
      WORKOS_JWKS_URI: WORKOS.WORKOS_JWKS_URI,
      NODE_ENV: 'development',
    };
    assert.equal(loadConfig(mixed).allowsInsecureCookies, false);
    assert.match(sessionCookie(mixed), /(^|; )Secure($|;)/);

    // staging (NODE_ENV unset) and production are unchanged: Secure.
    assert.match(sessionCookie(WORKOS), /(^|; )Secure($|;)/);
    assert.match(sessionCookie({ ...WORKOS, NODE_ENV: 'production' }), /(^|; )Secure($|;)/);
  });

  test('ONLY development|test with EVERY identity URL on loopback drops Secure', () => {
    for (const nodeEnv of ['development', 'test']) {
      const env = { ...LOOPBACK_IDENTITY, NODE_ENV: nodeEnv };
      assert.equal(loadConfig(env).allowsInsecureCookies, true, `${nodeEnv} loopback is local`);
      assert.ok(
        !sessionCookie(env).includes('Secure'),
        `the local ${nodeEnv} harness may serve a plain-http cookie`,
      );
      assert.ok(!clearingCookie(env).includes('Secure'));
    }
    // …and never outside those two values, loopback or not.
    for (const nodeEnv of [undefined, 'production', 'staging', 'preview']) {
      const env = { ...LOOPBACK_IDENTITY, NODE_ENV: nodeEnv };
      // http URLs are refused outside development/test, so the comparable
      // loopback deployment is an https one.
      const https = {
        ...env,
        WORKOS_ISSUER: 'https://127.0.0.1:39999',
        WORKOS_JWKS_URI: 'https://127.0.0.1:39999/oauth2/jwks',
        WORKOS_REDIRECT_URI: 'https://127.0.0.1:3000/auth/callback',
        WORKOS_REAUTH_REDIRECT_URI: 'https://localhost:3000/auth/reauth/callback',
        WORKOS_LOGOUT_REDIRECT_URI: 'https://127.0.0.1:3000/',
      };
      assert.equal(loadConfig(https).allowsInsecureCookies, false, `${String(nodeEnv)} is remote`);
      assert.match(sessionCookie(https), /(^|; )Secure($|;)/);
    }
    // an identity-DISABLED process issues no identity cookie at all, so the
    // secure direction is the truthful one.
    assert.equal(loadConfig({ ...BASE, NODE_ENV: 'development' }).allowsInsecureCookies, false);

    // the UNCONDITIONAL attributes are on every header either way
    for (const header of [
      sessionCookie({ ...WORKOS, NODE_ENV: 'development' }),
      clearingCookie({ ...WORKOS, NODE_ENV: 'development' }),
      sessionCookie({ ...LOOPBACK_IDENTITY, NODE_ENV: 'test' }),
    ]) {
      assert.match(header, /HttpOnly/);
      assert.match(header, /SameSite=Lax/);
      assert.ok(!/Domain=/i.test(header), 'session cookies stay host-only');
    }
  });

  test('clock skew is bounded', () => {
    assert.throws(
      () => loadConfig({ ...WORKOS, OIDC_CLOCK_SKEW_SECONDS: '9999' }),
      /OIDC_CLOCK_SKEW_SECONDS/,
    );
    const config = loadConfig({ ...WORKOS, OIDC_CLOCK_SKEW_SECONDS: '30' });
    if (config.identity.provider === 'workos') {
      assert.equal(config.identity.workos.oidcClockSkewSeconds, 30);
    }
  });

  // ── FBL-020-R3 correction D1: the provider exchange is BOUNDED ───────────

  test('D1: the refresh bound and the two database bounds have conservative defaults', () => {
    const config = loadConfig(WORKOS);
    if (config.identity.provider !== 'workos') return assert.fail('expected workos');
    assert.equal(config.identity.workos.providerRefreshTimeoutMs, 10_000);
    // The pool's second line, on EVERY connection this process opens.
    assert.equal(config.pgStatementTimeoutMs, 30_000);
    assert.equal(config.pgIdleInTransactionTimeoutMs, 15_000);

    // Configurable, bounded, and 0 means "no server-side bound" for the pool
    // settings only — a refresh with no deadline at all is the defect, so the
    // identity bound has a floor.
    assert.throws(
      () => loadConfig({ ...WORKOS, WORKOS_REFRESH_TIMEOUT_MS: '0' }),
      /WORKOS_REFRESH_TIMEOUT_MS/,
    );
    assert.throws(
      () => loadConfig({ ...WORKOS, WORKOS_REFRESH_TIMEOUT_MS: '600000' }),
      /WORKOS_REFRESH_TIMEOUT_MS/,
    );
    const tightened = loadConfig({
      ...WORKOS,
      WORKOS_REFRESH_TIMEOUT_MS: '2500',
      PG_STATEMENT_TIMEOUT_MS: '0',
      PG_IDLE_IN_TRANSACTION_TIMEOUT_MS: '5000',
    });
    if (tightened.identity.provider !== 'workos') return assert.fail('expected workos');
    assert.equal(tightened.identity.workos.providerRefreshTimeoutMs, 2500);
    assert.equal(tightened.pgStatementTimeoutMs, 0);
    assert.equal(tightened.pgIdleInTransactionTimeoutMs, 5000);
  });

  /**
   * The adapter's OWN bound, which is the second line under the operation's.
   * R3 set neither a timeout nor an AbortSignal on `authenticateWithRefreshToken`,
   * so a provider that accepted the connection and then said nothing kept the
   * exchange — and the request path above it — waiting indefinitely.
   *
   * Driven through the real adapter with `fetch` substituted, because what is
   * under test is exactly what the adapter hands the transport.
   */
  test('D1: the WorkOS refresh exchange is bounded, aborts its socket, and is TRANSIENT', async () => {
    const realFetch = globalThis.fetch;
    let carriedSignal = false;
    let socketAborted = false;
    // A provider that accepts the request and then answers NOTHING. Substituted
    // BEFORE the adapter is built, because the SDK captures its transport at
    // construction — so this test reaches the transport whether or not the adapter
    // installs a wrapper of its own, and never touches a real network.
    globalThis.fetch = ((_input: unknown, init?: { signal?: AbortSignal }) => {
      carriedSignal = init?.signal !== undefined && init.signal !== null;
      return new Promise<never>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => {
            socketAborted = true;
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          },
          { once: true },
        );
      });
    }) as typeof fetch;

    const provider = createWorkosProvider({
      clientId: 'client_01ABC',
      apiKey: 'sk_test_' + 'k'.repeat(32),
      redirectUri: 'https://app.example.com/auth/callback',
      reauthRedirectUri: 'https://app.example.com/auth/reauth/callback',
      logoutRedirectUri: 'https://app.example.com/',
      refreshTimeoutMs: 700,
    });

    const startedAt = Date.now();
    try {
      const failure = await within(
        5_000,
        'the refresh exchange',
        provider.refreshSession({ refreshToken: 'rt_never_answered' }).then(
          () => null,
          (err: unknown) => err,
        ),
      );
      const elapsedMs = Date.now() - startedAt;
      assert.ok(failure instanceof ProviderRefreshError, 'no SDK type escapes the adapter');
      assert.equal(
        (failure as ProviderRefreshError).kind,
        'transient',
        'silence is NOT a definitive refusal — a timeout must never revoke a session',
      );
      assert.ok(elapsedMs < 4_000, `the exchange ended at its own bound (took ${elapsedMs}ms)`);
      assert.equal(carriedSignal, true, 'the HTTP call carries an AbortSignal');
      assert.equal(socketAborted, true, 'and the socket is aborted, not merely abandoned');
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test('migration 060’s support-role array IS PLATFORM_SUPPORT_AUTHORITY_ROLES, verbatim', () => {
    // FBL-020-R7-C2 §2 — the write-instant authority trigger hardcodes the
    // allowed support roles in SQL, because a trigger cannot import a
    // TypeScript constant. Two lists that must agree and are pinned nowhere
    // WILL drift; this is the pin migration 060's own comment names. The SQL
    // literal is extracted from the migration text and compared, as a SET, to
    // the one declaration the engine, the mutation gate and the published
    // action all read — so moving either side without the other is a red test,
    // not a silent fail-closed outage for every delegated support decision.
    const migration = readFileSync(
      join(__dirname, '..', 'migrations', '060_identity_boundary_acceptance_closure.sql'),
      'utf8',
    );
    const literal = migration.match(/rb\.role = ANY \(ARRAY\[([^\]]+)\]\)/);
    assert.ok(
      literal,
      'the trigger’s support-role ANY(ARRAY[...]) literal exists exactly where §2 declares it',
    );
    const sqlRoles = (literal as RegExpMatchArray)[1]!
      .split(',')
      .map((s) => s.trim().replace(/^'|'$/g, ''))
      .sort();
    assert.deepEqual(
      sqlRoles,
      [...PLATFORM_SUPPORT_AUTHORITY_ROLES].sort(),
      'the trigger’s role list and the engine’s PLATFORM_SUPPORT_AUTHORITY_ROLES are one list',
    );
  });
});

/** Bounds the TEST's own wait, so an unbounded exchange FAILS instead of hanging. */
async function within<T>(ms: number, label: string, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not finish within ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
