import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';

import { ROLES, authenticate, authorize, rejectTenantOverride, requireContext } from '../src/shared/middleware/auth';

// The module reads its secret per call, so setting it here is enough.
const SECRET = 'test-jwt-secret-that-is-definitely-long-enough';
process.env.JWT_SECRET = SECRET;

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '99999999-9999-4999-8999-999999999999';
const USER = '22222222-2222-4222-8222-222222222222';

function b64(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/** Mints a token that is valid by default; pass `exp` explicitly to override. */
function mintToken(payload: Record<string, unknown>, opts: { alg?: string; secret?: string } = {}): string {
  const header = b64({ alg: opts.alg ?? 'HS256', typ: 'JWT' });
  const body = b64({ exp: Math.floor(Date.now() / 1000) + 3600, ...payload });
  const signature = createHmac('sha256', opts.secret ?? SECRET).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

/** Mints a token from exactly the given claims, with no defaults added. */
function mintRawToken(payload: unknown): string {
  const header = b64({ alg: 'HS256', typ: 'JWT' });
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', SECRET).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

function runMiddleware(mw: any, req: any): any {
  let captured: any = null;
  mw(req, {}, (err?: any) => {
    captured = err ?? null;
  });
  return captured;
}

function requestWith(token?: string, extra: Record<string, any> = {}): any {
  return { headers: token ? { authorization: `Bearer ${token}` } : {}, body: {}, query: {}, ...extra };
}

test('a valid token establishes the tenant context', () => {
  const req = requestWith(mintToken({ sub: USER, tid: TENANT, roles: [ROLES.SERVICE_ADVISOR] }));
  assert.equal(runMiddleware(authenticate, req), null);
  assert.deepEqual(req.tenantContext, { tenantId: TENANT, userId: USER, roles: [ROLES.SERVICE_ADVISOR] });
});

test('a request with no token is rejected', () => {
  const err = runMiddleware(authenticate, requestWith());
  assert.equal(err?.statusCode, 401);
});

test('a token signed with the wrong key is rejected', () => {
  const token = mintToken({ sub: USER, tid: TENANT, roles: [] }, { secret: 'a-completely-different-secret-value-here' });
  assert.equal(runMiddleware(authenticate, requestWith(token))?.statusCode, 401);
});

test('algorithm confusion is rejected', () => {
  const token = mintToken({ sub: USER, tid: TENANT, roles: [] }, { alg: 'none' });
  assert.equal(runMiddleware(authenticate, requestWith(token))?.statusCode, 401);
});

test('an expired token is rejected', () => {
  const token = mintToken({ sub: USER, tid: TENANT, roles: [], exp: Math.floor(Date.now() / 1000) - 10 });
  assert.equal(runMiddleware(authenticate, requestWith(token))?.statusCode, 401);
});

test('a token without a usable tenant claim is rejected', () => {
  const token = mintToken({ sub: USER, tid: 'acme-motors', roles: [] });
  assert.equal(runMiddleware(authenticate, requestWith(token))?.statusCode, 401);
});

test('a token with no expiry is rejected rather than treated as valid forever', () => {
  // An optional exp would make such a token a permanent credential.
  const token = mintRawToken({ sub: USER, tid: TENANT, roles: [] });
  assert.equal(runMiddleware(authenticate, requestWith(token))?.statusCode, 401);
});

test('a non-numeric expiry is rejected', () => {
  const token = mintRawToken({ sub: USER, tid: TENANT, roles: [], exp: '9999999999' });
  assert.equal(runMiddleware(authenticate, requestWith(token))?.statusCode, 401);
});

test('a scalar or null token payload is rejected, not crashed on', () => {
  for (const payload of [null, 1, 'string', []]) {
    const err = runMiddleware(authenticate, requestWith(mintRawToken(payload)));
    assert.equal(err?.statusCode, 401, `payload ${JSON.stringify(payload)} should be a 401`);
  }
});

test('the tenant always comes from the token, never from the request body', () => {
  const req = requestWith(mintToken({ sub: USER, tid: TENANT, roles: [] }), { body: { tenant_id: OTHER_TENANT } });
  runMiddleware(authenticate, req);
  assert.equal(requireContext(req).tenantId, TENANT);
});

test('a body tenant_id that disagrees with the token is refused outright', () => {
  const req = requestWith(mintToken({ sub: USER, tid: TENANT, roles: [] }), { body: { tenant_id: OTHER_TENANT } });
  runMiddleware(authenticate, req);
  assert.throws(() => rejectTenantOverride(req), (err: any) => err?.code === 'tenant_mismatch' && err?.statusCode === 403);
});

test('a query tenant_id that disagrees with the token is refused outright', () => {
  const req = requestWith(mintToken({ sub: USER, tid: TENANT, roles: [] }), { query: { tenant_id: OTHER_TENANT } });
  runMiddleware(authenticate, req);
  assert.throws(() => rejectTenantOverride(req), (err: any) => err?.code === 'tenant_mismatch');
});

test('an echoed matching tenant_id is accepted', () => {
  const req = requestWith(mintToken({ sub: USER, tid: TENANT, roles: [] }), { body: { tenant_id: TENANT } });
  runMiddleware(authenticate, req);
  rejectTenantOverride(req);
});

test('authorize admits a permitted role and refuses the rest', () => {
  const advisor = requestWith(mintToken({ sub: USER, tid: TENANT, roles: [ROLES.SERVICE_ADVISOR] }));
  runMiddleware(authenticate, advisor);
  assert.equal(runMiddleware(authorize(ROLES.SERVICE_ADVISOR, ROLES.SERVICE_MANAGER), advisor), null);

  const tech = requestWith(mintToken({ sub: USER, tid: TENANT, roles: [ROLES.TECHNICIAN] }));
  runMiddleware(authenticate, tech);
  assert.equal(runMiddleware(authorize(ROLES.SERVICE_ADVISOR, ROLES.SERVICE_MANAGER), tech)?.statusCode, 403);
});

test('a principal with no roles is refused', () => {
  const req = requestWith(mintToken({ sub: USER, tid: TENANT, roles: [] }));
  runMiddleware(authenticate, req);
  assert.equal(runMiddleware(authorize(ROLES.SERVICE_ADVISOR), req)?.statusCode, 403);
});

test('platform_admin passes every role check', () => {
  const req = requestWith(mintToken({ sub: USER, tid: TENANT, roles: [ROLES.ADMIN] }));
  runMiddleware(authenticate, req);
  assert.equal(runMiddleware(authorize(ROLES.WARRANTY_ADMIN), req), null);
});

test('authorize refuses when authenticate never ran', () => {
  assert.equal(runMiddleware(authorize(ROLES.SERVICE_ADVISOR), requestWith())?.statusCode, 401);
});
