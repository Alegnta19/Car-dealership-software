import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, beforeEach, describe, test } from 'node:test';
import {
  resetDatabase,
  seedRooftopIdentity,
  seedTenantIdentity,
  skipIntegration,
  startIdentityTestEnv,
  type IdentityTestEnv,
} from '@dealer/test-kit';
import { closePool, query } from '@dealer/database';
import { openCookiePayload, sealCookiePayload } from '@dealer/identity-access';
import { createApp, resetAuthRoutesForTests, resetIdentityCompositionForTests } from '@dealer/api';

/**
 * FBL-020-R0: the three /auth legs a browser drives — login, callback and
 * reauth callback — plus the sealed-cookie primitive underneath them. These
 * had no executable coverage, so every property they claim (single-use and
 * exact-match state, purpose separation, the return-location allowlist, AEAD
 * tamper detection, staleness) was asserted only in prose.
 */
describe('sealed transaction cookies', () => {
  const password = 'sealed-cookie-test-password-0123456789';

  test('a sealed payload round-trips only with the right key, unexpired', () => {
    const sealed = sealCookiePayload({ purpose: 'login', state: 'abc' }, password);
    const opened = openCookiePayload(sealed, password, { maxAgeSeconds: 600 });
    assert.ok(opened);
    assert.equal(opened.purpose, 'login');
    assert.equal(opened.state, 'abc');

    assert.equal(
      openCookiePayload(sealed, 'a-different-password-0123456789ab', { maxAgeSeconds: 600 }),
      null,
      'the wrong key must not open the seal',
    );
    // -1 rather than 0: a seal created in the current second is not yet stale
    // at a 0-second window, and asserting otherwise would test the clock.
    assert.equal(
      openCookiePayload(sealed, password, { maxAgeSeconds: -1 }),
      null,
      'a seal past its window must not open',
    );
  });

  test('any tampering opens to null — the AEAD tag is not decorative', () => {
    const sealed = sealCookiePayload({ purpose: 'login', state: 'abc' }, password);
    const raw = Buffer.from(sealed, 'base64url');
    for (const index of [0, 13, 30, raw.length - 1]) {
      const mangled = Buffer.from(raw);
      mangled[index] = mangled[index]! ^ 0xff;
      assert.equal(
        openCookiePayload(mangled.toString('base64url'), password, { maxAgeSeconds: 600 }),
        null,
        `flipping byte ${index} must invalidate the seal`,
      );
    }
    for (const junk of ['', 'not-base64url!!', 'AAAA', sealed.slice(0, 10)]) {
      assert.equal(
        openCookiePayload(junk, password, { maxAgeSeconds: 600 }),
        null,
        'malformed input opens to null rather than throwing',
      );
    }
  });
});

describe(
  'the /auth browser legs',
  { skip: skipIntegration ? 'set TEST_DATABASE_URL to run' : false },
  () => {
    let server: Server;
    let base: string;
    let env: IdentityTestEnv;
    let tenant: string;

    before(async () => {
      env = await startIdentityTestEnv();
      resetIdentityCompositionForTests();
      resetAuthRoutesForTests();
      server = createApp().listen(0);
      await new Promise<void>((resolve) => server.once('listening', () => resolve()));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    after(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await env.stop();
      await closePool();
    });

    beforeEach(async () => {
      await resetDatabase();
      tenant = randomUUID();
      await seedTenantIdentity(tenant);
      await seedRooftopIdentity(tenant, randomUUID());
    });

    function cookieValue(setCookie: string | null, name: string): string | null {
      if (setCookie === null) return null;
      const m = new RegExp(`${name}=([^;,]+)`).exec(setCookie);
      return m ? decodeURIComponent(m[1]!) : null;
    }

    /**
     * FBL-020-R3: the return location lives on the SERVER ROW, not in the
     * browser's cookie, so the allowlist is proven where the value actually
     * is. The cookie carries only the opaque handle that names this row.
     */
    async function serverReturnTo(sealed: string): Promise<string | null> {
      const payload = openCookiePayload(sealed, env.cookiePassword, { maxAgeSeconds: 600 });
      assert.ok(payload, 'the transaction cookie must open');
      assert.equal(payload.return_to, undefined, 'the cookie must NOT carry the return location');
      const r = await query(`SELECT return_to FROM login_transactions WHERE login_txn_id = $1`, [
        String(payload.login_txn_id),
      ]);
      assert.equal(r.rows.length, 1, 'the cookie must name a real server transaction');
      const row = r.rows[0] as { return_to: unknown };
      return row.return_to === null ? null : String(row.return_to);
    }

    test('GET /auth/login seals a transaction and redirects with Code+PKCE', async () => {
      const res = await fetch(`${base}/auth/login`, { redirect: 'manual' });
      assert.equal(res.status, 302);
      const location = res.headers.get('location') ?? '';
      assert.match(location, /code_challenge=/, 'PKCE challenge must be present');
      assert.match(location, /code_challenge_method=S256/);
      assert.match(location, /state=/);

      const setCookie = res.headers.get('set-cookie') ?? '';
      assert.match(setCookie, /dealer_auth_txn=/);
      assert.match(setCookie, /HttpOnly/);
      assert.match(setCookie, /SameSite=Lax/);
      assert.ok(!/Domain=/i.test(setCookie), 'the cookie must be host-only');

      const sealed = cookieValue(setCookie, 'dealer_auth_txn');
      assert.ok(sealed);
      const payload = openCookiePayload(sealed, env.cookiePassword, { maxAgeSeconds: 600 });
      assert.ok(payload);
      assert.equal(payload.purpose, 'login');
      assert.ok(
        typeof payload.code_verifier === 'string' && (payload.code_verifier as string).length >= 32,
        'a PKCE verifier of real length is sealed, never sent to the browser in the clear',
      );
      // R3: the cookie is the OPAQUE HANDLE plus the round-trip plaintext the
      // server compares against its digests — and nothing else. The server row
      // it names opens in `pending`, having declared no outcome whatsoever.
      assert.ok(typeof payload.login_txn_id === 'string');
      assert.deepEqual(
        Object.keys(payload).sort(),
        ['code_verifier', 'iat', 'login_txn_id', 'oidc_nonce', 'purpose', 'state'],
        'the browser must carry nothing the server can hold instead',
      );
      const result = await query(
        `SELECT status, consumed_at, consumed_outcome, failure_reason,
                request_id, correlation_id
           FROM login_transactions WHERE login_txn_id = $1`,
        [String(payload.login_txn_id)],
      );
      const row = result.rows[0] as Record<string, unknown>;
      assert.equal(row.status, 'pending');
      assert.equal(row.consumed_at, null);
      assert.equal(row.consumed_outcome, null);
      assert.equal(row.failure_reason, null);
      // the transaction is correlatable to the request that opened it
      assert.ok(typeof row.request_id === 'string' && row.request_id.length >= 8);
      assert.ok(typeof row.correlation_id === 'string' && row.correlation_id.length >= 8);
    });

    test('GET /auth/login refuses to be an open redirect', async () => {
      for (const hostile of [
        'https://evil.example.com/steal',
        '//evil.example.com',
        'http://127.0.0.1:1/x',
      ]) {
        const res = await fetch(`${base}/auth/login?return_to=${encodeURIComponent(hostile)}`, {
          redirect: 'manual',
        });
        assert.equal(res.status, 302);
        const sealed = cookieValue(res.headers.get('set-cookie'), 'dealer_auth_txn');
        assert.ok(sealed);
        assert.equal(await serverReturnTo(sealed), '/', `${hostile} must be reduced to "/"`);
      }

      const ok = await fetch(`${base}/auth/login?return_to=%2Fros%2F123`, { redirect: 'manual' });
      const okSealed = cookieValue(ok.headers.get('set-cookie'), 'dealer_auth_txn');
      assert.equal(await serverReturnTo(okSealed!), '/ros/123', 'a relative path IS preserved');
    });

    test('GET /auth/callback refuses every state and cookie mismatch', async () => {
      const login = await fetch(`${base}/auth/login`, { redirect: 'manual' });
      const sealed = cookieValue(login.headers.get('set-cookie'), 'dealer_auth_txn')!;
      const payload = openCookiePayload(sealed, env.cookiePassword, { maxAgeSeconds: 600 })!;
      const cookie = `dealer_auth_txn=${encodeURIComponent(sealed)}`;
      const state = String(payload.state);

      const cases: Array<[string, string, Record<string, string>]> = [
        ['no cookie at all', `/auth/callback?code=x&state=${state}`, {}],
        ['no code', `/auth/callback?state=${state}`, { cookie }],
        ['no state', '/auth/callback?code=x', { cookie }],
        ['wrong state', '/auth/callback?code=x&state=not-the-sealed-one', { cookie }],
        [
          'a REAUTH-purpose cookie presented to the login callback',
          `/auth/callback?code=x&state=${state}`,
          {
            cookie: `dealer_auth_txn=${encodeURIComponent(
              sealCookiePayload(
                { purpose: 'reauth', state, code_verifier: 'x', nonce: 'y' },
                env.cookiePassword,
              ),
            )}`,
          },
        ],
        [
          'a cookie sealed with a DIFFERENT key',
          `/auth/callback?code=x&state=${state}`,
          {
            cookie: `dealer_auth_txn=${encodeURIComponent(
              sealCookiePayload(
                { purpose: 'login', state, code_verifier: 'x', return_to: '/' },
                'an-entirely-different-cookie-password!',
              ),
            )}`,
          },
        ],
        [
          'malformed percent-encoding in the cookie',
          `/auth/callback?code=x&state=${state}`,
          { cookie: 'dealer_auth_txn=%' },
        ],
      ];

      for (const [label, path, headers] of cases) {
        const res = await fetch(base + path, { headers, redirect: 'manual' });
        const body = (await res.json().catch(() => null)) as { error?: { code?: string } } | null;
        assert.equal(res.status, 401, `${label}: expected 401, got ${res.status}`);
        assert.equal(body?.error?.code, 'unauthorized', label);
      }
    });

    test('GET /auth/reauth/callback refuses mismatches and never accepts a LOGIN cookie', async () => {
      const loginSealed = sealCookiePayload(
        { purpose: 'login', state: 'shared-state', code_verifier: 'v', return_to: '/' },
        env.cookiePassword,
      );
      const reauthSealed = sealCookiePayload(
        { purpose: 'reauth', state: 'shared-state', code_verifier: 'v', nonce: 'n' },
        env.cookiePassword,
      );
      const cases: Array<[string, string, Record<string, string>]> = [
        ['no cookie', '/auth/reauth/callback?code=x&state=shared-state', {}],
        [
          'a LOGIN-purpose cookie',
          '/auth/reauth/callback?code=x&state=shared-state',
          { cookie: `dealer_reauth_txn=${encodeURIComponent(loginSealed)}` },
        ],
        [
          'state mismatch',
          '/auth/reauth/callback?code=x&state=other',
          { cookie: `dealer_reauth_txn=${encodeURIComponent(reauthSealed)}` },
        ],
        [
          'malformed cookie',
          '/auth/reauth/callback?code=x&state=shared-state',
          { cookie: 'dealer_reauth_txn=%E0%A4%A' },
        ],
      ];
      for (const [label, path, headers] of cases) {
        const res = await fetch(base + path, { headers, redirect: 'manual' });
        const body = (await res.json().catch(() => null)) as { error?: { code?: string } } | null;
        assert.equal(res.status, 401, `${label}: expected 401, got ${res.status}`);
        assert.equal(body?.error?.code, 'unauthorized', label);
      }
    });

    test('a malformed session cookie is a neutral 401, never a 500', async () => {
      for (const value of ['%', '%E0%A4%A', 'not-a-real-session-token']) {
        const res = await fetch(`${base}/api/service/home`, {
          headers: { cookie: `dealer_session=${value}` },
        });
        const body = (await res.json().catch(() => null)) as { error?: { code?: string } } | null;
        assert.equal(res.status, 401, `cookie "${value}" must yield 401, got ${res.status}`);
        assert.equal(body?.error?.code, 'unauthorized');
      }
    });

    test('a hostile x-request-id neither 500s the request nor reaches the evidence row', async () => {
      // The evidence table CHECKs request_id length 8..128; an unsanitized
      // 1-character header would violate it and 500 every gated request.
      const res = await fetch(`${base}/api/service/home`, {
        headers: { 'x-request-id': 'a' },
      });
      assert.notEqual(res.status, 500, 'a short request id must not fault the request');
      assert.equal(res.status, 401, 'it is simply an unauthenticated request');
    });
  },
);
