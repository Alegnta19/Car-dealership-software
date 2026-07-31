import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { loadConfig } from '@dealer/platform';

const BASE = {
  DATABASE_URL: 'postgresql://localhost/db',
  JWT_SECRET: 'x'.repeat(40),
  STEP_UP_SECRET: 'y'.repeat(40),
};

const WORKOS = {
  ...BASE,
  IDENTITY_PROVIDER: 'workos',
  WORKOS_CLIENT_ID: 'client_01ABC',
  WORKOS_API_KEY: 'k'.repeat(40),
  WORKOS_ISSUER: 'https://auth.example.workos.com',
  WORKOS_JWKS_URI: 'https://auth.example.workos.com/oauth2/jwks',
  WORKOS_REDIRECT_URI: 'https://app.example.com/auth/callback',
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
      'WORKOS_LOGOUT_REDIRECT_URI',
    ] as const) {
      const env = { ...WORKOS, NODE_ENV: 'production', [name]: 'http://plain.example.com/x' };
      assert.throws(
        () => loadConfig(env),
        /https in production/,
        `${name} must demand https in production`,
      );
    }
    // outside production the local issuer harness may use http
    const env = { ...WORKOS, WORKOS_ISSUER: 'http://127.0.0.1:39999' };
    assert.equal(loadConfig(env).identity.provider, 'workos');
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
});
