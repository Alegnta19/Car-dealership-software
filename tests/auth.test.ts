import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, beforeEach, describe, test } from 'node:test';
import {
  bootstrapAdministrator,
  resetDatabase,
  sessionBindingFor,
  seedActor,
  seedRooftopIdentity,
  seedTenantIdentity,
  skipIntegration,
  startIdentityTestEnv,
  testOrganizationId,
  type IdentityTestEnv,
  fixtureAuthorizationStateWrite,
} from '@dealer/test-kit';
import { closePool, query } from '@dealer/database';
import { resetConfigForTests } from '@dealer/platform';
import { ROLES } from '@dealer/contracts';
import {
  NOT_IMPERSONATED,
  ProviderRefreshError,
  createAccessTokenVerifier,
  createSession,
  csrfTokenForSession,
  activateUserLink,
  grantRole,
  observeUserLinkOnLogin,
  revokeRolesForUserLink,
  revokeSessionByToken,
  revokeSessionsForUserLink,
  type IdentityProviderPort,
} from '@dealer/identity-access';
import {
  createApp,
  resetAuthRoutesForTests,
  resetIdentityCompositionForTests,
  useIdentityProviderForTests,
} from '@dealer/api';

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
      await fixtureAuthorizationStateWrite(
        'simulate-authorization-drift',
        `UPDATE user_links SET status = 'deactivated', deactivated_at = NOW()
          WHERE user_link_id = $1`,
        [advisor.userLinkId],
      );
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

    /**
     * FBL-020-R3 / ADR-008: WorkOS impersonation is not used, and "not used" is
     * enforced rather than trusted. A token that says it is being wielded ON
     * BEHALF OF one of our users is refused on the credential path itself, so
     * leaving the feature enabled in the dashboard by mistake still grants
     * nobody anything. Three carriers, one refusal.
     */
    test('an IMPERSONATED bearer token authenticates nobody, whatever carries the claim', async () => {
      const advisor = await seedActor(env.issuer, {
        tenantId: tenant,
        roles: [ROLES.SERVICE_ADVISOR],
      });
      // the same identity, unimpersonated, does work — otherwise this proves nothing
      assert.equal(
        (await get('/api/service/home', { authorization: `Bearer ${advisor.token}` })).status,
        200,
      );

      for (const carrier of [
        { act: { sub: 'workos_staff', email: 'staff@workos.example' } },
        { impersonator: { email: 'staff@workos.example' } },
        { authentication_method: 'Impersonation' },
      ]) {
        const token = await env.issuer.signAccessToken({
          sub: advisor.providerUserId,
          org_id: testOrganizationId(tenant),
          ...carrier,
        });
        const res = await get('/api/service/home', { authorization: `Bearer ${token}` });
        assert.equal(
          res.status,
          401,
          `an impersonated token must not authenticate: ${JSON.stringify(carrier)}`,
        );
        assert.ok(
          !JSON.stringify(res.body).includes('workos.example'),
          'and the impersonator identity never reaches the response',
        );
      }
    });

    async function sessionFor(
      roles: string[],
      /**
       * R3 correction C1: seeds the session exactly as /auth/callback does when
       * the provider hands back a refresh token — sealed state, its replay
       * digest, and the expiry of the access token the login verified.
       */
      refresh?: { refreshToken: string; accessTokenExpiresAt: Date },
    ) {
      const providerUserId = 'user_session_' + randomUUID().slice(0, 8);
      // R3: the session's provider subject is the LINK's subject. It is not a
      // placeholder the harness gets to invent — revalidation compares them.
      const binding = await sessionBindingFor(tenant, providerUserId);
      const link = await observeUserLinkOnLogin({
        tenantId: tenant,
        providerUserId,
        email: null,
        displayName: null,
        connectionId: binding.connectionId,
        issuer: binding.issuer,
        providerOrganizationId: binding.providerOrganizationId,
      });
      assert.ok(link);
      // R1 §B: login left it PENDING. An administrator activates it explicitly.
      const activated = await activateUserLink({
        userLinkId: link.userLinkId,
        activatedByUserLinkId: link.userLinkId,
      });
      assert.ok(activated, 'explicit activation must succeed');
      const grantedBy = await bootstrapAdministrator(tenant);
      for (const role of roles) {
        await grantRole({
          actingUserLinkId: grantedBy,
          tenantId: tenant,
          userLinkId: link.userLinkId,
          role,
          scopeLevel: 'tenant',
          scopeId: tenant,
        });
      }
      const created = await createSession({
        ...binding,
        tenantId: tenant,
        userLinkId: link.userLinkId,
        providerSessionId: 'sid_' + randomUUID().slice(0, 8),
        authTime: new Date(),
        ttlSeconds: 3600,
        ...(refresh === undefined
          ? {}
          : {
              refreshToken: refresh.refreshToken,
              cookiePassword: env.cookiePassword,
              providerAccessTokenExpiresAt: refresh.accessTokenExpiresAt,
            }),
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
      // FBL-020-R3: the CSRF token is NOT an identity fact, so it left the
      // bounded body and travels as its own response header instead.
      const csrf = sess.headers.get('x-csrf-token');
      assert.ok(typeof csrf === 'string' && csrf.length > 0);
      assert.equal(sess.body.data.csrf_token, undefined, 'no token in the session body');

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
        { cookie, 'x-csrf-token': csrf },
        {
          location_id: location,
          mdm_customer_id: randomUUID(),
          mdm_vehicle_id: randomUUID(),
          scheduled_start: new Date(Date.now() + 86_400_000).toISOString(),
        },
      );
      assert.equal(allowed.status, 201, JSON.stringify(allowed.body));
    });

    /**
     * FBL-020-R3: GET /auth/session is BOUNDED.
     *
     * R2 answered with whatever the request identity happened to carry, so the
     * endpoint's contract was "everything the server knows" — and the set of
     * things it knew grew every time the identity object did. The body is now a
     * closed list of eight facts, and this test asserts the KEY SET rather than
     * the presence of a few fields: a future field added by accident fails here
     * instead of quietly shipping a disclosure.
     */
    test('GET /auth/session is bounded: eight facts, no email, no provider profile, no tokens', async () => {
      const { link, created } = await sessionFor([ROLES.SERVICE_ADVISOR]);
      const email = 'advisor.person@dealer.example';
      const displayName = 'Advisor Person';
      // The link genuinely HOLDS a profile — otherwise the assertion below
      // would pass because there was nothing to leak.
      await fixtureAuthorizationStateWrite(
        'simulate-authorization-drift',
        `UPDATE user_links SET email = $2, display_name = $3 WHERE user_link_id = $1`,
        [link.userLinkId, email, displayName],
      );
      const subject = String(
        (
          (
            await query(`SELECT provider_user_id FROM user_links WHERE user_link_id = $1`, [
              link.userLinkId,
            ])
          ).rows[0] as { provider_user_id: unknown }
        ).provider_user_id,
      );

      const sess = await get('/auth/session', { cookie: `dealer_session=${created.sessionToken}` });
      assert.equal(sess.status, 200);
      assert.deepEqual(
        Object.keys(sess.body.data as Record<string, unknown>).sort(),
        [
          'freshness',
          'local_session_expires_at',
          'mfa_assurance',
          'organization_scope',
          'roles',
          'support_access',
          'tenant_id',
          'user_link_id',
        ],
        'the session body is exactly the eight bounded facts',
      );

      // and the values are the right ones
      assert.equal(sess.body.data.user_link_id, link.userLinkId);
      assert.equal(sess.body.data.tenant_id, tenant);
      assert.deepEqual(sess.body.data.roles, [ROLES.SERVICE_ADVISOR]);
      assert.equal(sess.body.data.organization_scope.actor_scope, 'dealership');
      assert.equal(sess.body.data.organization_scope.tenant_effective, true);
      assert.ok(['not_applicable', 'stale', 'fresh'].includes(String(sess.body.data.freshness)));
      assert.ok(
        ['not_applicable', 'uncertified', 'certified'].includes(
          String(sess.body.data.mfa_assurance),
        ),
      );
      assert.ok(
        Date.parse(String(sess.body.data.local_session_expires_at)) > Date.now(),
        'the LOCAL session expiry is reported, because that is what an operator can revoke',
      );

      // NOTHING identifying the person, the provider or the credential
      const serialized = JSON.stringify(sess.body);
      for (const forbidden of [email, displayName, subject, created.sessionToken]) {
        assert.ok(
          !serialized.includes(forbidden),
          `GET /auth/session must never carry ${forbidden.slice(0, 12)}…`,
        );
      }
      for (const key of [
        'email',
        'display_name',
        'provider_session_id',
        'provider_subject',
        'access_token',
        'refresh_token',
        'refresh_state',
        'csrf_token',
        'credential',
        'auth_time',
      ]) {
        assert.ok(!serialized.includes(key), `"${key}" must not appear in the session response`);
      }
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
      const out = await post('/auth/logout', {
        cookie,
        'x-csrf-token': sess.headers.get('x-csrf-token') ?? '',
      });
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
      // R3: revocation goes through the owned mutation service — attributed,
      // versioned and audited. A raw UPDATE that left the version alone is
      // exactly the shape this revision removed.
      const revoked = await revokeRolesForUserLink({
        actingUserLinkId: await bootstrapAdministrator(tenant),
        userLinkId: advisor.userLinkId,
      });
      assert.equal(revoked.length, 1, 'the advisor held exactly one binding to revoke');
      // the SAME still-valid token now fails: nothing to outlive the binding
      assert.equal((await post('/api/service/appointments', auth, body)).status, 403);
    });

    test('R1 section C: disabling ANY link in the chain denies the very next request', async () => {
      // One otherwise-valid bearer token, four independent kill switches.
      //
      // FBL-020-R4 §5: each switch is a DECLARED fixture bypass. Every one of these is a
      // state no production service will write — a disabled connection, an effective
      // window closed in the past — which is precisely why the suite must write it
      // itself, and precisely why it is named and reasoned rather than a bare `query`.
      for (const kill of [
        {
          label: 'provider connection disabled',
          break: (tenant: string) =>
            fixtureAuthorizationStateWrite(
              'simulate-authorization-drift',
              `UPDATE identity_provider_connections SET status = 'disabled' WHERE tenant_id = $1`,
              [tenant],
            ),
        },
        {
          label: 'provider connection expired',
          break: (tenant: string) =>
            fixtureAuthorizationStateWrite(
              'simulate-authorization-drift',
              `UPDATE identity_provider_connections
                   SET effective_from = NOW() - INTERVAL '2 hours',
                       effective_to = NOW() - INTERVAL '1 minute'
                 WHERE tenant_id = $1`,
              [tenant],
            ),
        },
        {
          label: 'tenant suspended',
          break: (tenant: string) =>
            fixtureAuthorizationStateWrite(
              'simulate-authorization-drift',
              `UPDATE tenants SET status = 'suspended' WHERE tenant_id = $1`,
              [tenant],
            ),
        },
        {
          label: 'user link expired',
          break: (tenant: string) =>
            fixtureAuthorizationStateWrite(
              'simulate-authorization-drift',
              `UPDATE user_links
                   SET effective_from = NOW() - INTERVAL '2 hours',
                       effective_to = NOW() - INTERVAL '1 minute'
                 WHERE tenant_id = $1`,
              [tenant],
            ),
        },
      ]) {
        await resetDatabase();
        tenant = randomUUID();
        location = randomUUID();
        await seedTenantIdentity(tenant);
        await seedRooftopIdentity(tenant, location);
        const advisor = await seedActor(env.issuer, {
          tenantId: tenant,
          roles: [ROLES.SERVICE_ADVISOR],
        });
        const auth = { authorization: `Bearer ${advisor.token}` };

        assert.equal((await get('/api/service/home', auth)).status, 200, kill.label);
        await kill.break(tenant);
        // SAME token, no restart, no expiry
        assert.equal(
          (await get('/api/service/home', auth)).status,
          401,
          `${kill.label} must deny the next request`,
        );
      }
    });

    test('R1 section C: a connection whose issuer disagrees with configuration is refused', async () => {
      const advisor = await seedActor(env.issuer, {
        tenantId: tenant,
        roles: [ROLES.SERVICE_ADVISOR],
      });
      const auth = { authorization: `Bearer ${advisor.token}` };
      assert.equal((await get('/api/service/home', auth)).status, 200);

      // FBL-020-R4 §2.1 — THIS DRIFT IS NO LONGER REPRESENTABLE, WHICH IS STRONGER
      // THAN BEING DENIED. Re-pointing a connection's trust anchor while an activated
      // link is bound to it used to be an ordinary UPDATE, and the platform's only
      // defence was that every later request re-checked the agreement. The composite
      // key `ul_connection_identity_tuple` refuses the statement outright: a trust
      // anchor cannot be swapped out from under the identities that were admitted
      // through it, so no window exists in which the two disagree.
      await assert.rejects(
        fixtureAuthorizationStateWrite(
          'simulate-authorization-drift',
          `UPDATE identity_provider_connections SET issuer = 'https://someone-elses-issuer.example'
            WHERE tenant_id = $1`,
          [tenant],
        ),
        /ul_connection_identity_tuple/,
        'a bound connection cannot be re-anchored',
      );
      assert.equal(
        (await get('/api/service/home', auth)).status,
        200,
        'and the refusal left the identity chain intact',
      );

      // The remaining representable disagreement is with CONFIGURATION: the database
      // still names the issuer it was seeded with, and the platform is now configured
      // to trust a different one. Mapping inputs are not authorization evidence, so the
      // request is refused.
      const configuredIssuer = process.env.WORKOS_ISSUER;
      process.env.WORKOS_ISSUER = 'https://someone-elses-issuer.example';
      resetConfigForTests();
      try {
        assert.equal((await get('/api/service/home', auth)).status, 401);
      } finally {
        process.env.WORKOS_ISSUER = configuredIssuer;
        resetConfigForTests();
      }
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

    // ── FBL-020-R3: the bearer credential's LOCAL, revocable session ────────

    interface LocalSessionRow {
      session_id: string;
      credential_kind: string;
      revoked_at: Date | null;
      revoked_reason: string | null;
      provider_session_id: string | null;
      session_token_hash: string | null;
      bearer_key_hash: string | null;
    }

    /** Every local session row belonging to one user link, oldest first. */
    async function sessionsOf(userLinkId: string): Promise<LocalSessionRow[]> {
      const rows = await query(
        `SELECT session_id, credential_kind, revoked_at, revoked_reason, provider_session_id,
                session_token_hash, bearer_key_hash
           FROM identity_sessions WHERE user_link_id = $1 ORDER BY issued_at`,
        [userLinkId],
      );
      return rows.rows as LocalSessionRow[];
    }

    /** The one local session a bearer credential is expected to have. */
    async function onlySessionOf(userLinkId: string): Promise<LocalSessionRow> {
      const [only, ...rest] = await sessionsOf(userLinkId);
      assert.ok(only, 'expected exactly one local session');
      assert.equal(rest.length, 0, 'a repeated credential must not mint a session per request');
      return only;
    }

    test('R3: a verified bearer establishes ONE local session and reuses it', async () => {
      const advisor = await seedActor(env.issuer, {
        tenantId: tenant,
        roles: [ROLES.SERVICE_ADVISOR],
      });
      const auth = { authorization: `Bearer ${advisor.token}` };
      assert.equal((await get('/api/service/home', auth)).status, 200);
      assert.equal((await get('/api/service/home', auth)).status, 200);

      const session = await onlySessionOf(advisor.userLinkId);
      assert.equal(session.credential_kind, 'bearer');
      // A bearer session holds NO cookie digest: it is not a value any client
      // can present, and the schema keeps the two keys in different columns.
      assert.equal(session.session_token_hash, null);
      assert.match(String(session.bearer_key_hash), /^[0-9a-f]{64}$/);
    });

    test('R3: local logout denies the very next request with the SAME bearer token', async () => {
      const advisor = await seedActor(env.issuer, {
        tenantId: tenant,
        roles: [ROLES.SERVICE_ADVISOR],
      });
      const auth = { authorization: `Bearer ${advisor.token}` };
      assert.equal((await get('/api/service/home', auth)).status, 200);

      const out = await post('/auth/logout', auth);
      assert.equal(out.status, 200, JSON.stringify(out.body));
      assert.equal(out.body.data.logged_out, true);

      // The PROVIDER token is still perfectly valid — proved independently,
      // against the same configured issuer, audience and JWKS the app uses.
      const independent = createAccessTokenVerifier({
        issuer: env.issuer.issuer,
        audience: env.issuer.audience,
        jwksUri: env.issuer.jwksUri,
      });
      const stillValid = await independent.verify(advisor.token);
      assert.equal(stillValid.providerUserId, advisor.providerUserId);
      assert.ok(stillValid.expiresAt.getTime() > Date.now(), 'the token has NOT expired');

      // …and the very next request carrying it is refused anyway. Local
      // revocation beats a live provider credential: that is the whole point.
      assert.equal((await get('/api/service/home', auth)).status, 401);

      // Re-presenting it does not quietly establish a replacement session.
      const session = await onlySessionOf(advisor.userLinkId);
      assert.notEqual(session.revoked_at, null);
      assert.equal(session.revoked_reason, 'logout');
    });

    test('R3: revoking the local session denies the next bearer request', async () => {
      const advisor = await seedActor(env.issuer, {
        tenantId: tenant,
        roles: [ROLES.SERVICE_ADVISOR],
      });
      const auth = { authorization: `Bearer ${advisor.token}` };
      assert.equal((await get('/api/service/home', auth)).status, 200);
      assert.equal(await revokeSessionsForUserLink(advisor.userLinkId, 'security_event'), 1);
      assert.equal((await get('/api/service/home', auth)).status, 401);
    });

    test('R3: an EXPIRED local session refuses a still-valid bearer token', async () => {
      const advisor = await seedActor(env.issuer, {
        tenantId: tenant,
        roles: [ROLES.SERVICE_ADVISOR],
      });
      const auth = { authorization: `Bearer ${advisor.token}` };
      assert.equal((await get('/api/service/home', auth)).status, 200);
      await fixtureAuthorizationStateWrite(
        'simulate-authorization-drift',
        `UPDATE identity_sessions SET issued_at = NOW() - INTERVAL '2 hours',
                                      expires_at = NOW() - INTERVAL '1 minute'
          WHERE user_link_id = $1`,
        [advisor.userLinkId],
      );
      assert.equal((await get('/api/service/home', auth)).status, 401);
    });

    test('R3: a NEW provider authentication is a new local session, not a lockout', async () => {
      const advisor = await seedActor(env.issuer, {
        tenantId: tenant,
        roles: [ROLES.SERVICE_ADVISOR],
      });
      const auth = { authorization: `Bearer ${advisor.token}` };
      assert.equal((await get('/api/service/home', auth)).status, 200);
      assert.equal((await post('/auth/logout', auth)).status, 200);
      assert.equal((await get('/api/service/home', auth)).status, 401);

      // A genuinely new provider login carries a new `sid`, which is a
      // different bearer key — the revocation bounded the SESSION, not the
      // person.
      const fresh = await env.issuer.signAccessToken({
        sub: advisor.providerUserId,
        org_id: testOrganizationId(tenant),
      });
      assert.equal(
        (await get('/api/service/home', { authorization: `Bearer ${fresh}` })).status,
        200,
      );
      const [first, second, ...rest] = await sessionsOf(advisor.userLinkId);
      assert.ok(first && second);
      assert.equal(rest.length, 0);
      assert.notEqual(first.provider_session_id, second.provider_session_id);
    });

    test('R3: an organization remap does NOT inherit the old UserLink', async () => {
      const advisor = await seedActor(env.issuer, {
        tenantId: tenant,
        roles: [ROLES.SERVICE_ADVISOR],
      });
      const original = { authorization: `Bearer ${advisor.token}` };
      assert.equal((await get('/api/service/home', original)).status, 200);

      // FBL-020-R4 §2.1: re-pointing the connection at a different provider
      // organization is now refused while a link is bound to it — the organization is
      // part of the composite key that ties the link to the connection, so the remap
      // cannot happen behind the link's back.
      const remappedOrg = 'org_remapped_' + randomUUID().slice(0, 8);
      await assert.rejects(
        fixtureAuthorizationStateWrite(
          'simulate-authorization-drift',
          `UPDATE identity_provider_connections SET provider_organization_id = $2
            WHERE tenant_id = $1`,
          [tenant, remappedOrg],
        ),
        /ul_connection_identity_tuple/,
        'a bound connection cannot be re-homed to another organization',
      );

      // The claim this test exists for still holds, and is now provable without any
      // drift at all: the same person, the same tenant, the same connection row, but a
      // token issued by ANOTHER organization inherits nothing. The six-fact lookup
      // finds no link for that organization, so no session is established.
      const remapped = await env.issuer.signAccessToken({
        sub: advisor.providerUserId,
        org_id: remappedOrg,
      });
      assert.equal(
        (await get('/api/service/home', { authorization: `Bearer ${remapped}` })).status,
        401,
        'a remapped organization must not inherit the previous organization’s link',
      );
      // The ORIGINAL token still maps, because nothing was allowed to move.
      assert.equal((await get('/api/service/home', original)).status, 200);
      // …and nothing was established for the remapped identity.
      assert.equal((await onlySessionOf(advisor.userLinkId)).credential_kind, 'bearer');
    });

    /**
     * FBL-020-R4 §2.1 — EVERY LAYER THAT CARRIES AN ISSUER IS NOW TIED TO THE ONE
     * ABOVE IT BY A COMPOSITE KEY, so a disagreeing issuer is not merely denied on the
     * next request: it cannot be written at all. Each mutation below used to succeed,
     * leaving a live, active, in-window chain whose parts disagreed, and the platform's
     * defence was that every request re-derived the agreement. Both halves are asserted
     * here — the statement is REFUSED, and the credential still works afterwards,
     * because a refused mutation must not have half-landed.
     */
    test('R3/R4: an issuer mismatch is refused at EVERY layer that carries one', async () => {
      const foreign = 'https://someone-elses-issuer.example';
      // FBL-020-R4 §5: an ADVERSARIAL bypass — the point of each attempt is that the
      // database refuses it, so it is declared as an attempt rather than hidden in a
      // bare `query`.
      for (const layer of [
        {
          label: 'connection issuer',
          drift: (tenant: string, issuer: string) =>
            fixtureAuthorizationStateWrite(
              'adversarial-bypass-attempt',
              `UPDATE identity_provider_connections SET issuer = $2 WHERE tenant_id = $1`,
              [tenant, issuer],
            ),
          constraint: /ul_connection_identity_tuple/,
        },
        {
          label: 'user link issuer',
          drift: (tenant: string, issuer: string) =>
            fixtureAuthorizationStateWrite(
              'adversarial-bypass-attempt',
              `UPDATE user_links SET issuer = $2 WHERE tenant_id = $1`,
              [tenant, issuer],
            ),
          constraint: /ul_connection_identity_tuple|is_link_identity_tuple/,
        },
        {
          label: 'local session issuer',
          drift: (tenant: string, issuer: string) =>
            fixtureAuthorizationStateWrite(
              'adversarial-bypass-attempt',
              `UPDATE identity_sessions SET issuer = $2 WHERE tenant_id = $1`,
              [tenant, issuer],
            ),
          constraint: /is_link_identity_tuple/,
        },
      ]) {
        await resetDatabase();
        tenant = randomUUID();
        location = randomUUID();
        await seedTenantIdentity(tenant);
        await seedRooftopIdentity(tenant, location);
        const advisor = await seedActor(env.issuer, {
          tenantId: tenant,
          roles: [ROLES.SERVICE_ADVISOR],
        });
        const auth = { authorization: `Bearer ${advisor.token}` };
        assert.equal((await get('/api/service/home', auth)).status, 200, layer.label);
        await assert.rejects(
          layer.drift(tenant, foreign),
          layer.constraint,
          `${layer.label}: a disagreeing issuer must be unrepresentable`,
        );
        assert.equal(
          (await get('/api/service/home', auth)).status,
          200,
          `${layer.label}: the refused mutation left the chain intact`,
        );
      }
    });

    test('R3/R4: a cookie session cannot be left with ONE fact out of agreement', async () => {
      // Each mutation leaves every row present, active and inside its window — only the
      // AGREEMENT between them breaks. R2 checked the facts one at a time and would have
      // accepted all three; R3 re-derived the whole chain per request and denied them.
      // R4 §2.1 removes the state itself: each is refused by a composite key.
      for (const drift of [
        {
          label: 'link re-homed to another organization',
          attempt: (userLinkId: string) =>
            fixtureAuthorizationStateWrite(
              'adversarial-bypass-attempt',
              `UPDATE user_links SET provider_organization_id = 'org_moved_elsewhere'
                 WHERE user_link_id = $1`,
              [userLinkId],
            ),
        },
        {
          label: 'link subject rewritten',
          attempt: (userLinkId: string) =>
            fixtureAuthorizationStateWrite(
              'adversarial-bypass-attempt',
              `UPDATE user_links SET provider_user_id = 'user_someone_else'
                 WHERE user_link_id = $1`,
              [userLinkId],
            ),
        },
        {
          label: 'session organization no longer the connection’s',
          attempt: (userLinkId: string) =>
            fixtureAuthorizationStateWrite(
              'adversarial-bypass-attempt',
              `UPDATE identity_sessions SET provider_organization_id = 'org_moved_elsewhere'
                 WHERE user_link_id = $1`,
              [userLinkId],
            ),
        },
      ]) {
        await resetDatabase();
        tenant = randomUUID();
        location = randomUUID();
        await seedTenantIdentity(tenant);
        await seedRooftopIdentity(tenant, location);
        const { created, link } = await sessionFor([ROLES.SERVICE_ADVISOR]);
        const cookie = `dealer_session=${created.sessionToken}`;
        assert.equal((await get('/api/service/home', { cookie })).status, 200, drift.label);
        await assert.rejects(
          drift.attempt(link.userLinkId),
          /ul_connection_identity_tuple|is_link_identity_tuple/,
          `${drift.label}: a chain that no longer agrees must be unrepresentable`,
        );
        assert.equal(
          (await get('/api/service/home', { cookie })).status,
          200,
          `${drift.label}: the refused mutation left the session usable`,
        );
      }

      // THE REQUEST-TIME CHAIN CHECK IS STILL LIVE, and this proves it: disabling the
      // connection is a legitimate, representable act — status is not part of the
      // identity tuple — and the very next request must be denied by the application's
      // own re-derivation rather than by any constraint.
      await resetDatabase();
      tenant = randomUUID();
      location = randomUUID();
      await seedTenantIdentity(tenant);
      await seedRooftopIdentity(tenant, location);
      const { created } = await sessionFor([ROLES.SERVICE_ADVISOR]);
      const cookie = `dealer_session=${created.sessionToken}`;
      assert.equal((await get('/api/service/home', { cookie })).status, 200);
      await fixtureAuthorizationStateWrite(
        'simulate-authorization-drift',
        `UPDATE identity_provider_connections SET status = 'disabled' WHERE tenant_id = $1`,
        [tenant],
      );
      assert.equal(
        (await get('/api/service/home', { cookie })).status,
        401,
        'a disabled connection must deny the very next request',
      );
    });

    // ── FBL-020-R3 correction C1: the provider refresh is REACHABLE ─────────
    //
    // The review found `refreshProviderSession` correct at both ends and called
    // by nothing but its own unit tests, while /auth/callback took custody of a
    // sealed provider refresh credential on EVERY login. A long-lived credential
    // at rest that no running code can spend is blast radius with no benefit.
    //
    // These drive the WHOLE production path over real HTTP — middleware, session
    // maintenance, verification, rotation, revocation. The only substituted part
    // is the provider PORT: a live WorkOS refresh would be non-deterministic and
    // would prove nothing extra about this platform's side of the contract.

    interface FakeRefreshPort extends IdentityProviderPort {
      /** Every refresh token the port was actually handed, in order. */
      readonly presented: string[];
    }

    function fakeProviderPort(behaviour: {
      subject: string;
      replacement?: string;
      fail?: 'definitive' | 'transient';
      /** The lifetime of the access token the refresh returns. */
      accessTokenTtlSeconds?: number;
      /**
       * FBL-020-R4 §3: the provider session id (`sid`) the reply carries. A REFRESH
       * keeps the provider session it is refreshing, and the platform now BINDS it
       * exactly — both in the reply and in the verified replacement token — so a
       * reply naming a different provider session revokes the local session instead
       * of silently overwriting the stored value. Every caller therefore hands over
       * the sid its own session was established with.
       */
      providerSessionId: string;
      /** Holds the exchange open, so a second request must queue on the row lock. */
      delayMs?: number;
    }): FakeRefreshPort {
      const presented: string[] = [];
      const unused = (): never => {
        throw new Error('the refresh tests use only refreshSession');
      };
      return {
        presented,
        buildAuthorizationUrl: unused,
        exchangeCode: unused,
        buildLogoutUrl: unused,
        async refreshSession(input: { refreshToken: string }) {
          presented.push(input.refreshToken);
          if (behaviour.delayMs !== undefined) {
            await new Promise<void>((resolve) => setTimeout(resolve, behaviour.delayMs));
          }
          if (behaviour.fail !== undefined) {
            throw new ProviderRefreshError(behaviour.fail, 'fake provider failure');
          }
          const now = Math.floor(Date.now() / 1000);
          return {
            // A REAL locally-signed token: the production path verifies the
            // replacement, so a fake string would be revoked, not adopted.
            accessToken: await env.issuer.signAccessToken({
              sub: behaviour.subject,
              sid: behaviour.providerSessionId,
              org_id: testOrganizationId(tenant),
              exp: now + (behaviour.accessTokenTtlSeconds ?? 300),
            }),
            refreshToken: behaviour.replacement ?? 'provider-refresh-next',
            providerUserId: behaviour.subject,
            providerSessionId: behaviour.providerSessionId,
            organizationId: testOrganizationId(tenant),
            impersonation: NOT_IMPERSONATED,
          };
        },
      };
    }

    interface SessionRow {
      readonly digest: string | null;
      readonly sealed: string | null;
      readonly rotationCount: number;
      readonly accessExpiresAt: string | null;
      readonly expiresAt: string;
      readonly revokedAt: unknown;
      readonly revokedReason: unknown;
    }

    async function sessionRow(sessionId: string): Promise<SessionRow> {
      const r = await query(
        `SELECT refresh_token_hash, refresh_state_sealed, refresh_rotation_count,
                provider_access_token_expires_at, expires_at, revoked_at, revoked_reason
           FROM identity_sessions WHERE session_id = $1`,
        [sessionId],
      );
      const row = r.rows[0] as Record<string, unknown>;
      return {
        digest: row.refresh_token_hash === null ? null : String(row.refresh_token_hash),
        sealed: row.refresh_state_sealed === null ? null : String(row.refresh_state_sealed),
        rotationCount: Number(row.refresh_rotation_count),
        accessExpiresAt:
          row.provider_access_token_expires_at === null
            ? null
            : new Date(String(row.provider_access_token_expires_at)).toISOString(),
        expiresAt: new Date(String(row.expires_at)).toISOString(),
        revokedAt: row.revoked_at,
        revokedReason: row.revoked_reason,
      };
    }

    const sha256hex = (v: string) => createHash('sha256').update(v, 'utf8').digest('hex');

    /** R3 correction D1: does any attempt currently CLAIM this session's refresh? */
    async function refreshLeaseHeld(sessionId: string): Promise<boolean> {
      const r = await query(
        `SELECT refresh_lease_id FROM identity_sessions WHERE session_id = $1`,
        [sessionId],
      );
      const row = r.rows[0] as Record<string, unknown>;
      return row.refresh_lease_id !== null && row.refresh_lease_id !== undefined;
    }

    /**
     * Bounds the TEST's own wait, so a request that never comes back is a failure
     * with a message rather than a suite that hangs until the runner gives up.
     */
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

    /** Installs the fake port for one test and always restores the real one. */
    async function withProvider(port: FakeRefreshPort, body: () => Promise<void>): Promise<void> {
      useIdentityProviderForTests(port);
      try {
        await body();
      } finally {
        useIdentityProviderForTests(undefined);
      }
    }

    test('C1: a session whose provider token is near expiry IS refreshed on the live request path', async () => {
      const { link, created } = await sessionFor([ROLES.SERVICE_ADVISOR], {
        refreshToken: 'provider-refresh-1',
        // inside the 60-second leeway, so this request finds a refresh DUE
        accessTokenExpiresAt: new Date(Date.now() + 20_000),
      });
      const before = await sessionRow(created.session.sessionId);
      assert.equal(before.rotationCount, 0);
      assert.equal(before.digest, sha256hex('provider-refresh-1'));

      const port = fakeProviderPort({
        subject: link.providerUserId,
        providerSessionId: created.session.providerSessionId!,
        replacement: 'provider-refresh-2',
      });
      await withProvider(port, async () => {
        const res = await get('/api/service/home', {
          cookie: `dealer_session=${created.sessionToken}`,
        });
        assert.equal(res.status, 200, 'the request is served');

        // THE POINT: the credential taken into custody at login was spent.
        assert.deepEqual(port.presented, ['provider-refresh-1']);

        const after = await sessionRow(created.session.sessionId);
        assert.equal(after.rotationCount, 1, 'the rotation was persisted');
        assert.equal(after.digest, sha256hex('provider-refresh-2'), 'keyed on the REPLACEMENT');
        assert.notEqual(after.sealed, before.sealed, 'the sealed state was replaced');
        assert.equal(after.revokedAt, null);
        // The new expiry came from the VERIFIED replacement token, so the next
        // refresh is scheduled against a fact rather than a guess.
        assert.ok(after.accessExpiresAt !== null);
        assert.ok(
          new Date(after.accessExpiresAt).getTime() > Date.now() + 120_000,
          'the stored expiry moved to the refreshed token’s exp',
        );
        // A refresh renews the PROVIDER credential, not the person's session:
        // the local bound must not slide forward.
        assert.ok(
          new Date(after.expiresAt).getTime() <= new Date(before.expiresAt).getTime(),
          'the local session expiry was not extended',
        );
        // …and no raw refresh token is anywhere in the row.
        assert.ok(!JSON.stringify(after).includes('provider-refresh'));
      });
    });

    test('C1: a session whose provider token is NOT near expiry is left alone', async () => {
      const { link, created } = await sessionFor([ROLES.SERVICE_ADVISOR], {
        refreshToken: 'provider-refresh-untouched',
        accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
      });
      const port = fakeProviderPort({
        subject: link.providerUserId,
        providerSessionId: created.session.providerSessionId!,
      });
      await withProvider(port, async () => {
        assert.equal(
          (await get('/api/service/home', { cookie: `dealer_session=${created.sessionToken}` }))
            .status,
          200,
        );
        assert.deepEqual(port.presented, [], 'no provider round trip on an unexpired credential');
        const after = await sessionRow(created.session.sessionId);
        assert.equal(after.rotationCount, 0);
        assert.equal(after.digest, sha256hex('provider-refresh-untouched'));
      });
    });

    /**
     * A single-use credential must be spent ONCE even when several requests
     * arrive at once. The exchange holds the session row's lock, so a parallel
     * request queues behind it — and then re-judges dueness against the row it
     * finally holds rather than the copy it read before queuing. Without that
     * second judgement every queued request spends another refresh token for a
     * session that was refreshed a millisecond ago.
     */
    test('C1: simultaneous requests on a due session refresh ONCE, not once each', async () => {
      const { link, created } = await sessionFor([ROLES.SERVICE_ADVISOR], {
        refreshToken: 'provider-refresh-concurrent',
        accessTokenExpiresAt: new Date(Date.now() + 20_000),
      });
      const port = fakeProviderPort({
        subject: link.providerUserId,
        providerSessionId: created.session.providerSessionId!,
        replacement: 'provider-refresh-concurrent-2',
        delayMs: 250,
      });
      await withProvider(port, async () => {
        const cookie = `dealer_session=${created.sessionToken}`;
        const [first, second] = await Promise.all([
          get('/api/service/home', { cookie }),
          get('/api/service/home', { cookie }),
        ]);
        assert.equal(first.status, 200);
        assert.equal(second.status, 200);
        assert.deepEqual(
          port.presented,
          ['provider-refresh-concurrent'],
          'the request that waited for the lock must spend nothing',
        );
        const after = await sessionRow(created.session.sessionId);
        assert.equal(after.rotationCount, 1, 'exactly one rotation');
        assert.equal(after.digest, sha256hex('provider-refresh-concurrent-2'));
        assert.equal(after.revokedAt, null, 'and nobody was logged out for racing');
      });
    });

    test('C1: a TRANSIENT provider failure does not break a still-valid local session', async () => {
      const { link, created } = await sessionFor([ROLES.SERVICE_ADVISOR], {
        refreshToken: 'provider-refresh-transient',
        accessTokenExpiresAt: new Date(Date.now() + 20_000),
      });
      const before = await sessionRow(created.session.sessionId);
      const port = fakeProviderPort({
        subject: link.providerUserId,
        providerSessionId: created.session.providerSessionId!,
        fail: 'transient',
      });
      await withProvider(port, async () => {
        const cookie = `dealer_session=${created.sessionToken}`;
        assert.equal(
          (await get('/api/service/home', { cookie })).status,
          200,
          'a provider that did not answer must NOT log the person out',
        );
        // …and it stays that way: an unavailable provider is not a slow logout.
        assert.equal((await get('/auth/session', { cookie })).status, 200);
        assert.deepEqual(port.presented, [
          'provider-refresh-transient',
          'provider-refresh-transient',
        ]);
        const after = await sessionRow(created.session.sessionId);
        assert.deepEqual(after, before, 'session state is byte-for-byte unchanged');
      });
    });

    test('C1: a DEFINITIVE provider refusal ends the session on the spot', async () => {
      const { link, created } = await sessionFor([ROLES.SERVICE_ADVISOR], {
        refreshToken: 'provider-refresh-dead',
        accessTokenExpiresAt: new Date(Date.now() + 20_000),
      });
      const port = fakeProviderPort({
        subject: link.providerUserId,
        providerSessionId: created.session.providerSessionId!,
        fail: 'definitive',
      });
      await withProvider(port, async () => {
        const cookie = `dealer_session=${created.sessionToken}`;
        assert.equal(
          (await get('/api/service/home', { cookie })).status,
          401,
          'the provider has ended this session; the platform must agree at once',
        );
        const after = await sessionRow(created.session.sessionId);
        assert.ok(after.revokedAt !== null);
        assert.equal(after.revokedReason, 'refresh_failed');
        // Revocation DESTROYS the credential, it does not merely stop using it.
        assert.equal(after.sealed, null);
        assert.equal(after.digest, null);
      });
      // the cookie is dead for good, with the provider port back to normal
      assert.equal(
        (await get('/api/service/home', { cookie: `dealer_session=${created.sessionToken}` }))
          .status,
        401,
      );
    });

    test('C1: an IMPERSONATED refresh reply revokes instead of being adopted', async () => {
      const { link, created } = await sessionFor([ROLES.SERVICE_ADVISOR], {
        refreshToken: 'provider-refresh-impersonated',
        accessTokenExpiresAt: new Date(Date.now() + 20_000),
      });
      const base = fakeProviderPort({
        subject: link.providerUserId,
        providerSessionId: created.session.providerSessionId!,
      });
      const port: FakeRefreshPort = {
        ...base,
        async refreshSession(input: { refreshToken: string }) {
          const result = await base.refreshSession(input);
          return {
            ...result,
            impersonation: { impersonated: true, impersonatorEmailPresent: true },
          };
        },
      };
      await withProvider(port, async () => {
        assert.equal(
          (await get('/api/service/home', { cookie: `dealer_session=${created.sessionToken}` }))
            .status,
          401,
        );
        const after = await sessionRow(created.session.sessionId);
        assert.equal(after.revokedReason, 'impersonation_detected');
        assert.equal(after.sealed, null);
      });
    });

    test('C1: a forged unsafe request cannot spend the refresh token on its way to 403', async () => {
      const { link, created } = await sessionFor([ROLES.SERVICE_ADVISOR], {
        refreshToken: 'provider-refresh-csrf',
        accessTokenExpiresAt: new Date(Date.now() + 20_000),
      });
      const port = fakeProviderPort({
        subject: link.providerUserId,
        providerSessionId: created.session.providerSessionId!,
      });
      await withProvider(port, async () => {
        const blocked = await post(
          '/api/service/appointments',
          { cookie: `dealer_session=${created.sessionToken}` },
          {
            location_id: location,
            mdm_customer_id: randomUUID(),
            mdm_vehicle_id: randomUUID(),
            scheduled_start: new Date(Date.now() + 86_400_000).toISOString(),
          },
        );
        assert.equal(blocked.status, 403);
        assert.equal(blocked.body.error.code, 'csrf_required');
        assert.deepEqual(
          port.presented,
          [],
          'a single-use provider credential is not spent for a request that is being refused',
        );
      });
    });

    /**
     * FBL-020-R3 correction D1 — the case the previous wave could not express.
     *
     * Its fakes either delayed 250ms or threw, and BOTH release a row lock. A
     * provider that HANGS releases nothing: R3 awaited it inside a transaction
     * holding `SELECT ... FOR UPDATE` on the session row, so one hung exchange per
     * due session pinned one connection of the pool the whole API shares.
     *
     * This drives it over real HTTP against a port that never settles at all. Two
     * obligations, and the request path must satisfy both: the request is SERVED
     * (a provider that did not answer is transient, never a logout), and it is
     * served WITHIN THE BOUND rather than whenever the provider feels like it.
     */
    test('D1: a provider that NEVER ANSWERS still serves the request, within the bound', async () => {
      const { link, created } = await sessionFor([ROLES.SERVICE_ADVISOR], {
        refreshToken: 'provider-refresh-hang',
        accessTokenExpiresAt: new Date(Date.now() + 20_000),
      });
      const before = await sessionRow(created.session.sessionId);
      const presented: string[] = [];
      const port: FakeRefreshPort = {
        ...fakeProviderPort({
          subject: link.providerUserId,
          providerSessionId: created.session.providerSessionId!,
        }),
        presented,
        refreshSession(input: { refreshToken: string }) {
          presented.push(input.refreshToken);
          // never resolves and never rejects
          return new Promise<never>(() => undefined);
        },
      };
      await withProvider(port, async () => {
        const cookie = `dealer_session=${created.sessionToken}`;
        const res = await within(8_000, 'the request', get('/api/service/home', { cookie }));
        assert.equal(res.status, 200, 'a provider that never answered must not fail the request');
        assert.deepEqual(presented, ['provider-refresh-hang'], 'the exchange was attempted once');

        // TRANSIENT, not definitive: nothing about the session changed.
        assert.deepEqual(
          await sessionRow(created.session.sessionId),
          before,
          'session state is byte-for-byte unchanged',
        );
        // …and the CLAIM was released, so the session is not wedged. A hung attempt
        // that kept its claim would leave the session unable to refresh at all.
        assert.equal(
          await refreshLeaseHeld(created.session.sessionId),
          false,
          'the abandoned attempt released its lease',
        );

        // The next request therefore tries again — and is served again.
        const again = await within(
          8_000,
          'the second request',
          get('/api/service/home', { cookie }),
        );
        assert.equal(again.status, 200);
        assert.deepEqual(presented, ['provider-refresh-hang', 'provider-refresh-hang']);
      });
    });
  },
);
