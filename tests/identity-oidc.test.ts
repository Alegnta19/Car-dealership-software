import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { startLocalIssuer, type LocalIssuer } from '@dealer/test-kit';
import {
  TokenVerificationError,
  createAccessTokenVerifier,
  type AccessTokenVerifier,
} from '@dealer/identity-access';

/**
 * FBL-020 authentication negative matrix, proven against the deterministic
 * local issuer — no live provider credential involved. The verifier trusts
 * only its CONFIGURATION; every row here tries to make token content override
 * that and must fail closed with the single unspecific error.
 */
describe('OIDC access-token verification', () => {
  let issuer: LocalIssuer;

  before(async () => {
    issuer = await startLocalIssuer();
  });

  after(async () => {
    await issuer.stop();
  });

  function makeVerifier(overrides?: {
    issuer?: string;
    audience?: string;
    clockSkewSeconds?: number;
    jwksCooldownMs?: number;
    fetchTimeoutMs?: number;
  }): AccessTokenVerifier {
    return createAccessTokenVerifier({
      issuer: overrides?.issuer ?? issuer.issuer,
      audience: overrides?.audience ?? issuer.audience,
      jwksUri: issuer.jwksUri,
      clockSkewSeconds: overrides?.clockSkewSeconds ?? 60,
      jwksCooldownMs: overrides?.jwksCooldownMs ?? 30_000,
      fetchTimeoutMs: overrides?.fetchTimeoutMs ?? 5_000,
    });
  }

  async function assertRejected(promise: Promise<unknown>, label: string): Promise<void> {
    await assert.rejects(promise, (err: unknown) => {
      assert.ok(
        err instanceof TokenVerificationError,
        `${label}: expected TokenVerificationError, got ${String(err)}`,
      );
      // the OUTWARD message is deliberately unspecific — detail is internal only
      assert.equal((err as Error).message, 'access token verification failed');
      return true;
    });
  }

  test('a well-formed token verifies and maps every claim', async () => {
    const verifier = makeVerifier();
    const token = await issuer.signAccessToken({
      sub: 'user_happy',
      sid: 'session_happy',
      org_id: 'org_happy',
      role: 'admin_hint',
      permissions: ['widgets:manage'],
    });
    const verified = await verifier.verify(token);
    assert.equal(verified.providerUserId, 'user_happy');
    assert.equal(verified.providerSessionId, 'session_happy');
    assert.equal(verified.organizationId, 'org_happy');
    assert.ok(verified.authTime instanceof Date);
    assert.ok(verified.expiresAt.getTime() > Date.now() - 60_000);
    assert.deepEqual(verified.roleHints, ['admin_hint', 'widgets:manage']);
  });

  test('a token without org_id verifies with organizationId null (platform shape)', async () => {
    const verifier = makeVerifier();
    const token = await issuer.signAccessToken({}, { omit: ['org_id'] });
    const verified = await verifier.verify(token);
    assert.equal(verified.organizationId, null);
  });

  test('HS256 tokens are rejected — symmetric signing can never verify', async () => {
    const verifier = makeVerifier();
    await assertRejected(
      verifier.verify(await issuer.signAccessToken({}, { symmetric: true })),
      'HS256',
    );
  });

  test('alg=none tokens are rejected', async () => {
    const verifier = makeVerifier();
    await assertRejected(
      verifier.verify(await issuer.signAccessToken({}, { unsigned: true })),
      'none',
    );
  });

  test('the verifier refuses to be CONSTRUCTED with a symmetric or none allowlist', () => {
    for (const alg of ['HS256', 'none']) {
      assert.throws(() =>
        createAccessTokenVerifier({
          issuer: issuer.issuer,
          audience: issuer.audience,
          jwksUri: issuer.jwksUri,
          algorithms: [alg],
        }),
      );
    }
  });

  test('issuer and audience are exact-match configuration', async () => {
    const verifier = makeVerifier();
    await assertRejected(
      verifier.verify(await issuer.signAccessToken({ iss: 'https://evil.example.com' })),
      'wrong issuer',
    );
    await assertRejected(
      verifier.verify(await issuer.signAccessToken({ aud: 'some-other-api' })),
      'wrong audience',
    );
  });

  test('temporal claims: expiry, not-before and bounded skew', async () => {
    const verifier = makeVerifier({ clockSkewSeconds: 60 });
    const now = Math.floor(Date.now() / 1000);
    // beyond skew: rejected
    await assertRejected(
      verifier.verify(await issuer.signAccessToken({ exp: now - 120 })),
      'expired beyond skew',
    );
    // inside skew: tolerated (bounded clock drift, not permanence)
    await verifier.verify(await issuer.signAccessToken({ exp: now - 30 }));
    // not yet valid
    await assertRejected(
      verifier.verify(await issuer.signAccessToken({ nbf: now + 300 })),
      'future nbf',
    );
  });

  test('every identity-bearing claim is REQUIRED: sub, sid, auth_time, iat, exp', async () => {
    const verifier = makeVerifier();
    for (const claim of ['sub', 'sid', 'auth_time', 'iat', 'exp']) {
      await assertRejected(
        verifier.verify(await issuer.signAccessToken({}, { omit: [claim] })),
        `missing ${claim}`,
      );
    }
  });

  test('a tampered payload is rejected', async () => {
    const verifier = makeVerifier();
    const token = await issuer.signAccessToken({ sub: 'user_original' });
    const [header = '', payload = '', signature = ''] = token.split('.');
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    decoded.sub = 'user_forged';
    const forged = Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64url');
    await assertRejected(verifier.verify(`${header}.${forged}.${signature}`), 'tampered payload');
  });

  test('unknown kid: at most ONE bounded JWKS refresh, no stampede', async () => {
    // fresh verifier — its cache starts empty
    const verifier = makeVerifier({ jwksCooldownMs: 60_000 });
    const before_ = issuer.jwksFetchCount();

    // ten CONCURRENT verifications of unpublished-kid tokens: the fetch is
    // deduplicated and the unknown kid triggers no per-attempt refetch storm
    const tokens = await Promise.all(
      Array.from({ length: 10 }, () => issuer.signAccessToken({}, { unpublishedKey: true })),
    );
    await Promise.all(tokens.map((t) => assertRejected(verifier.verify(t), 'unknown kid')));
    const afterConcurrent = issuer.jwksFetchCount();
    assert.ok(
      afterConcurrent - before_ <= 2,
      `expected at most 2 JWKS fetches for 10 concurrent unknown-kid attempts, saw ${afterConcurrent - before_}`,
    );

    // and a fresh unknown-kid attempt inside the cooldown adds NO fetch
    await assertRejected(
      verifier.verify(await issuer.signAccessToken({}, { unpublishedKey: true })),
      'unknown kid again',
    );
    assert.equal(
      issuer.jwksFetchCount(),
      afterConcurrent,
      'cooldown must suppress further refetches',
    );
  });

  test('key rotation is honoured WITHOUT a restart', async () => {
    const verifier = makeVerifier({ jwksCooldownMs: 0 });
    await verifier.verify(await issuer.signAccessToken());
    await issuer.rotateKeys();
    // the same verifier instance picks up the new key set on demand
    const verified = await verifier.verify(
      await issuer.signAccessToken({ sub: 'user_after_rotation' }),
    );
    assert.equal(verified.providerUserId, 'user_after_rotation');
  });

  test('a JWKS outage fails CLOSED, quickly, with the unspecific error', async () => {
    issuer.setOutage(true);
    try {
      const verifier = makeVerifier({ fetchTimeoutMs: 1_000 });
      await assertRejected(verifier.verify(await issuer.signAccessToken()), 'jwks outage');
    } finally {
      issuer.setOutage(false);
    }
  });

  test('reauthentication proof: auth_time must not predate the transaction start', async () => {
    const verifier = makeVerifier({ clockSkewSeconds: 60 });
    const now = Math.floor(Date.now() / 1000);
    const transactionStart = new Date();

    // stale authentication (10 minutes old) — no fresh login happened
    await assert.rejects(
      verifier.verify(await issuer.signAccessToken({ auth_time: now - 600 }), {
        requireAuthTimeAtOrAfter: transactionStart,
      }),
      TokenVerificationError,
    );
    // fresh authentication passes
    const verified = await verifier.verify(await issuer.signAccessToken({ auth_time: now }), {
      requireAuthTimeAtOrAfter: transactionStart,
    });
    assert.ok(verified.authTime.getTime() >= transactionStart.getTime() - 60_000);
  });

  test('forged role claims verify as HINTS only — they carry no authority here', async () => {
    const verifier = makeVerifier();
    const verified = await verifier.verify(
      await issuer.signAccessToken({ role: 'platform_admin', permissions: ['everything'] }),
    );
    // the hints surface exactly as claimed…
    assert.deepEqual(verified.roleHints, ['platform_admin', 'everything']);
    // …and the type carries NO authorization fields to leak into decisions
    assert.ok(!('roles' in verified));
    assert.ok(!('isAdmin' in verified));
  });
});
