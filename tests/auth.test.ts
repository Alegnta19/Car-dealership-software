import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, beforeEach, describe, test } from 'node:test';
import {
  resetDatabase,
  seedActor,
  seedRooftopIdentity,
  seedTenantIdentity,
  skipIntegration,
  startIdentityTestEnv,
  type IdentityTestEnv,
} from '@dealer/test-kit';
import { closePool, query } from '@dealer/database';
import { ROLES } from '@dealer/contracts';
import {
  createSession,
  csrfTokenForSession,
  ensureActivatedUserLink,
  revokeSessionByToken,
} from '@dealer/identity-access';
import { createApp, resetAuthRoutesForTests, resetIdentityCompositionForTests } from '@dealer/api';

/**
 * FBL-020 authentication matrix at the wire: provider-verified bearer tokens
 * OR server-side session cookies, one at a time; locally signed HS256 is
 * gone; CSRF guards cookie-authenticated writes; policy denials render 403
 * for tenant-context actions and the not-found envelope for resource-scoped
 * ones (non-enumeration).
 */
describe(
  'authentication and authorization at the wire',
  { skip: skipIntegration ? 'set TEST_DATABASE_URL to run' : false },
  () => {
    let server: Server;
    let base: string;
    let env: IdentityTestEnv;
    let tenant: string;
    let location: string;

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
      location = randomUUID();
      await seedTenantIdentity(tenant);
      await seedRooftopIdentity(tenant, location);
    });

    async function get(path: string, headers: Record<string, string> = {}) {
      const res = await fetch(base + path, { headers });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
    }

    async function post(path: string, headers: Record<string, string> = {}, body: unknown = {}) {
      const res = await fetch(base + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
    }

    test('a valid provider bearer token authenticates and resolves the database identity', async () => {
      const advisor = await seedActor(env.issuer, {
        tenantId: tenant,
        roles: [ROLES.SERVICE_ADVISOR],
      });
      const res = await get('/api/service/home', { authorization: `Bearer ${advisor.token}` });
      assert.equal(res.status, 200);
    });

    test('locally signed HS256 tokens are DEAD — the FBL-020 regression proof', async () => {
      const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
      const header = b64({ alg: 'HS256', typ: 'JWT' });
      const payload = b64({
        sub: randomUUID(),
        tid: tenant,
        roles: [ROLES.SERVICE_ADVISOR, 'platform_admin'],
        exp: Math.floor(Date.now() / 1000) + 3600,
      });
      for (const secret of [
        'integration-test-jwt-secret-long-enough-value',
        'any-other-secret-value-32-chars!!',
      ]) {
        const sig = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
        const res = await get('/api/service/home', {
          authorization: `Bearer ${header}.${payload}.${sig}`,
        });
        assert.equal(res.status, 401, 'an HS256 token must never authenticate again');
      }
    });

    test('garbage, expired and unknown-identity bearers are all a neutral 401', async () => {
      // garbage
      assert.equal(
        (await get('/api/service/home', { authorization: 'Bearer not-a-token' })).status,
        401,
      );
      // cryptographically valid but expired
      const now = Math.floor(Date.now() / 1000);
      const expired = await env.issuer.signAccessToken({
        exp: now - 600,
        iat: now - 700,
        auth_time: now - 700,
      });
      assert.equal(
        (await get('/api/service/home', { authorization: `Bearer ${expired}` })).status,
        401,
      );
      // valid token for an organization with no active connection
      const foreignOrg = await env.issuer.signAccessToken({
        org_id: 'org_unknown_' + randomUUID().slice(0, 8),
      });
      assert.equal(
        (await get('/api/service/home', { authorization: `Bearer ${foreignOrg}` })).status,
        401,
      );
      // valid token, known org, but no user link
      const strangers = await env.issuer.signAccessToken({ org_id: `org_test_${tenant}` });
      assert.equal(
        (await get('/api/service/home', { authorization: `Bearer ${strangers}` })).status,
        401,
      );
    });

    test('a deactivated identity is refused even with a valid provider token', async () => {
      const advisor = await seedActor(env.issuer, {
        tenantId: tenant,
        roles: [ROLES.SERVICE_ADVISOR],
      });
      await query(`UPDATE user_links SET status = 'deactivated' WHERE user_link_id = $1`, [
        advisor.userLinkId,
      ]);
      const res = await get('/api/service/home', { authorization: `Bearer ${advisor.token}` });
      assert.equal(res.status, 401);
    });

    test('bearer + cookie together is ambiguous and refused', async () => {
      const advisor = await seedActor(env.issuer, {
        tenantId: tenant,
        roles: [ROLES.SERVICE_ADVISOR],
      });
      const res = await get('/api/service/home', {
        authorization: `Bearer ${advisor.token}`,
        cookie: 'dealer_session=whatever',
      });
      assert.equal(res.status, 401);
    });

    async function sessionFor(roles: string[]) {
      const link = await ensureActivatedUserLink({
        tenantId: tenant,
        providerUserId: 'user_session_' + randomUUID().slice(0, 8),
        email: null,
        displayName: null,
      });
      assert.ok(link);
      for (const role of roles) {
        await query(
          `INSERT INTO role_bindings (tenant_id, user_link_id, role, scope_level, scope_id)
         VALUES ($1, $2, $3, 'tenant', $1)`,
          [tenant, link.userLinkId, role],
        );
      }
      const created = await createSession({
        tenantId: tenant,
        userLinkId: link.userLinkId,
        providerSessionId: 'sid_' + randomUUID().slice(0, 8),
        authTime: new Date(),
        ttlSeconds: 3600,
      });
      return { link, created };
    }

    test('session cookies authenticate reads; unsafe methods demand the CSRF token', async () => {
      const { created } = await sessionFor([ROLES.SERVICE_ADVISOR]);
      const cookie = `dealer_session=${created.sessionToken}`;

      const read = await get('/api/service/home', { cookie });
      assert.equal(read.status, 200);

      const sess = await get('/auth/session', { cookie });
      assert.equal(sess.status, 200);
      assert.equal(sess.body.data.tenant_id, tenant);
      assert.ok(typeof sess.body.data.csrf_token === 'string');

      // write WITHOUT the CSRF token: refused with its own code
      const blocked = await post(
        '/api/service/appointments',
        { cookie },
        {
          location_id: location,
          mdm_customer_id: randomUUID(),
          mdm_vehicle_id: randomUUID(),
          scheduled_start: new Date(Date.now() + 86_400_000).toISOString(),
        },
      );
      assert.equal(blocked.status, 403);
      assert.equal(blocked.body.error.code, 'csrf_required');

      // with it: accepted
      const allowed = await post(
        '/api/service/appointments',
        { cookie, 'x-csrf-token': sess.body.data.csrf_token },
        {
          location_id: location,
          mdm_customer_id: randomUUID(),
          mdm_vehicle_id: randomUUID(),
          scheduled_start: new Date(Date.now() + 86_400_000).toISOString(),
        },
      );
      assert.equal(allowed.status, 201, JSON.stringify(allowed.body));
    });

    test('a revoked session dies immediately', async () => {
      const { created } = await sessionFor([ROLES.SERVICE_ADVISOR]);
      const cookie = `dealer_session=${created.sessionToken}`;
      assert.equal((await get('/api/service/home', { cookie })).status, 200);
      await revokeSessionByToken(created.sessionToken, 'test');
      assert.equal((await get('/api/service/home', { cookie })).status, 401);
    });

    test('logout revokes the session, clears the cookie and returns the provider logout URL', async () => {
      const { created } = await sessionFor([ROLES.SERVICE_ADVISOR]);
      const cookie = `dealer_session=${created.sessionToken}`;
      const sess = await get('/auth/session', { cookie });
      const out = await post('/auth/logout', { cookie, 'x-csrf-token': sess.body.data.csrf_token });
      assert.equal(out.status, 200, JSON.stringify(out.body));
      assert.equal(out.body.data.logged_out, true);
      const setCookie = out.headers.get('set-cookie') ?? '';
      assert.match(setCookie, /dealer_session=;/);
      assert.equal((await get('/api/service/home', { cookie })).status, 401);
    });

    test('deny-by-default: an authenticated identity with NO bindings gets 403 on tenant actions', async () => {
      const nobody = await seedActor(env.issuer, { tenantId: tenant, roles: [] });
      const res = await post(
        '/api/service/ros',
        { authorization: `Bearer ${nobody.token}` },
        {
          location_id: location,
          mdm_customer_id: randomUUID(),
          mdm_vehicle_id: randomUUID(),
        },
      );
      assert.equal(res.status, 403);
      assert.equal(res.body.error.code, 'forbidden');
      // and the decision left evidence
      const evidence = await query(
        `SELECT COUNT(*)::int AS n FROM policy_decisions WHERE decision = 'deny' AND actor_user_link_id = $1`,
        [nobody.userLinkId],
      );
      assert.ok(Number((evidence.rows[0] as { n: number }).n) >= 1);
    });

    test('non-enumeration: a resource-scoped denial is indistinguishable from a missing resource', async () => {
      const advisor = await seedActor(env.issuer, {
        tenantId: tenant,
        roles: [ROLES.SERVICE_ADVISOR],
      });
      const auth = { authorization: `Bearer ${advisor.token}` };
      const appt = await post('/api/service/appointments', auth, {
        location_id: location,
        mdm_customer_id: randomUUID(),
        mdm_vehicle_id: randomUUID(),
        scheduled_start: new Date(Date.now() + 86_400_000).toISOString(),
      });
      assert.equal(appt.status, 201);
      const checkedIn = await post(
        `/api/service/appointments/${appt.body.data.appointment_id}/check-in`,
        auth,
      );
      const roId = checkedIn.body.data.ro_id as string;

      // an actor in ANOTHER tenant, real role, probing this RO id
      const otherTenant = randomUUID();
      await seedTenantIdentity(otherTenant);
      const outsider = await seedActor(env.issuer, {
        tenantId: otherTenant,
        roles: [ROLES.SERVICE_ADVISOR],
      });
      const probe = await get(`/api/service/ros/${roId}`, {
        authorization: `Bearer ${outsider.token}`,
      });
      const ghost = await get(`/api/service/ros/${randomUUID()}`, {
        authorization: `Bearer ${outsider.token}`,
      });
      assert.equal(probe.status, 404);
      assert.equal(ghost.status, 404);
      assert.deepEqual(
        { code: probe.body.error.code },
        { code: ghost.body.error.code },
        'cross-tenant and nonexistent must be the SAME answer',
      );
    });

    test('revoking a role binding denies the very next request', async () => {
      const advisor = await seedActor(env.issuer, {
        tenantId: tenant,
        roles: [ROLES.SERVICE_ADVISOR],
      });
      const auth = { authorization: `Bearer ${advisor.token}` };
      const body = {
        location_id: location,
        mdm_customer_id: randomUUID(),
        mdm_vehicle_id: randomUUID(),
        scheduled_start: new Date(Date.now() + 86_400_000).toISOString(),
      };
      assert.equal((await post('/api/service/appointments', auth, body)).status, 201);
      await query(
        `UPDATE role_bindings SET status = 'revoked', revoked_at = NOW() WHERE user_link_id = $1`,
        [advisor.userLinkId],
      );
      // the SAME still-valid token now fails: nothing to outlive the binding
      assert.equal((await post('/api/service/appointments', auth, body)).status, 403);
    });

    test('the tenant a request operates on comes from the identity, never the body', async () => {
      const advisor = await seedActor(env.issuer, {
        tenantId: tenant,
        roles: [ROLES.SERVICE_ADVISOR],
      });
      const res = await post(
        '/api/service/ros',
        { authorization: `Bearer ${advisor.token}` },
        {
          tenant_id: randomUUID(),
          location_id: location,
          mdm_customer_id: randomUUID(),
          mdm_vehicle_id: randomUUID(),
        },
      );
      assert.equal(res.status, 403);
      assert.equal(res.body.error.code, 'tenant_mismatch');
    });
  },
);
