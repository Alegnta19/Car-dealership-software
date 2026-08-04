import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, beforeEach, describe, test } from 'node:test';
import { resetDatabase, sessionBindingFor, skipIntegration } from '@dealer/test-kit';
import { closePool, query } from '@dealer/database';
import { createTenant } from '@dealer/organization';
import {
  createPendingUserLink,
  createSession,
  csrfTokenForSession,
  deactivateUserLink,
  activateUserLink,
  observeUserLinkOnLogin,
  findUserLink,
  resolveConnectionByOrganization,
  revokeSessionByToken,
  revokeSessionsForUserLink,
  validateSessionToken,
  verifyCsrfToken,
} from '@dealer/identity-access';
import { BootstrapRefused, bootstrapIdentity } from '../scripts/bootstrap-identity';

describe(
  'identity core (database)',
  { skip: skipIntegration ? 'set TEST_DATABASE_URL to run' : false },
  () => {
    after(async () => {
      await closePool();
    });

    beforeEach(async () => {
      await resetDatabase();
    });

    async function seedTenantWithConnection(orgId: string) {
      const tenant = await createTenant({ name: 'Identity Tenant ' + orgId, status: 'active' });
      await query(
        `INSERT INTO identity_provider_connections
         (connection_scope, tenant_id, provider, provider_organization_id, status, issuer)
       VALUES ('dealership', $1, 'workos', $2, 'active', $3)`,
        [tenant.tenantId, orgId, 'https://issuer.test.local'],
      );
      return tenant;
    }

    test('organization resolution: only ACTIVE connections resolve; unknown fails closed', async () => {
      const tenant = await seedTenantWithConnection('org_resolve');
      const pool = { query };
      const resolved = await resolveConnectionByOrganization(pool, 'workos', 'org_resolve');
      assert.deepEqual(resolved, { connectionScope: 'dealership', tenantId: tenant.tenantId });

      assert.equal(await resolveConnectionByOrganization(pool, 'workos', 'org_unknown'), null);

      await query(
        `UPDATE identity_provider_connections SET status = 'disabled' WHERE provider_organization_id = 'org_resolve'`,
      );
      assert.equal(await resolveConnectionByOrganization(pool, 'workos', 'org_resolve'), null);
    });

    test('first login creates a PENDING link, grants NOTHING, and never activates', async () => {
      const tenant = await seedTenantWithConnection('org_first');
      const link = await observeUserLinkOnLogin({
        tenantId: tenant.tenantId,
        providerUserId: 'user_first',
        email: 'first@example.com',
        displayName: 'First User',
      });
      assert.ok(link);
      // R1 section B: login OBSERVES. It does not activate.
      assert.equal(link.status, 'pending');
      assert.equal(link.activatedAt, null);

      const bindings = await query(
        `SELECT COUNT(*)::int AS n FROM role_bindings WHERE user_link_id = $1`,
        [link.userLinkId],
      );
      assert.equal(Number((bindings.rows[0] as { n: number }).n), 0);

      const audit = await query(
        `SELECT COUNT(*)::int AS n FROM audit_events
          WHERE entity_type = 'user_link' AND entity_id = $1
            AND event_type = 'identity.user_link.pending_created'`,
        [link.userLinkId],
      );
      assert.equal(Number((audit.rows[0] as { n: number }).n), 1);

      // a second login refreshes bounded identifiers and STILL does not activate
      const again = await observeUserLinkOnLogin({
        tenantId: tenant.tenantId,
        providerUserId: 'user_first',
        email: 'renamed@example.com',
        displayName: 'Renamed User',
      });
      assert.ok(again);
      assert.equal(again.userLinkId, link.userLinkId);
      assert.equal(again.email, 'renamed@example.com');
      assert.equal(again.status, 'pending', 'repeated login must never activate');
      const count = await query(`SELECT COUNT(*)::int AS n FROM user_links`, []);
      assert.equal(Number((count.rows[0] as { n: number }).n), 1);

      // the attempted pending login left policy/audit evidence
      const refusalAudit = await query(
        `SELECT COUNT(*)::int AS n FROM audit_events
          WHERE entity_id = $1 AND event_type = 'identity.user_link.pending_login_refused'`,
        [link.userLinkId],
      );
      assert.ok(Number((refusalAudit.rows[0] as { n: number }).n) >= 1);
    });

    test('activation is an explicit, attributable administrative act that grants no role', async () => {
      const tenant = await seedTenantWithConnection('org_activate');
      const admin = await createPendingUserLink({
        tenantId: tenant.tenantId,
        providerUserId: 'user_admin_actor',
        email: null,
        createdByUserLinkId: null,
      });
      const pending = await createPendingUserLink({
        tenantId: tenant.tenantId,
        providerUserId: 'user_pending',
        email: 'pending@example.com',
        createdByUserLinkId: null,
      });
      assert.equal(pending.status, 'pending');

      const activated = await activateUserLink({
        userLinkId: pending.userLinkId,
        activatedByUserLinkId: admin.userLinkId,
      });
      assert.ok(activated);
      assert.equal(activated.status, 'activated');
      assert.ok(activated.activatedAt instanceof Date);

      // attributable, versioned, and role-free
      const row = await query(
        `SELECT activated_by_user_link_id, authorization_version FROM user_links WHERE user_link_id = $1`,
        [pending.userLinkId],
      );
      const r = row.rows[0] as {
        activated_by_user_link_id: unknown;
        authorization_version: unknown;
      };
      assert.equal(String(r.activated_by_user_link_id), admin.userLinkId);
      assert.ok(
        Number(r.authorization_version) > 1,
        'activation increments the authorization version',
      );
      const bindings = await query(
        `SELECT COUNT(*)::int AS n FROM role_bindings WHERE user_link_id = $1`,
        [pending.userLinkId],
      );
      assert.equal(Number((bindings.rows[0] as { n: number }).n), 0, 'activation grants no role');

      // activating twice is a no-op, not a second activation
      assert.equal(
        await activateUserLink({
          userLinkId: pending.userLinkId,
          activatedByUserLinkId: admin.userLinkId,
        }),
        null,
      );

      // a deactivated identity is refused at login and cannot be re-activated
      assert.ok(
        await deactivateUserLink({ userLinkId: pending.userLinkId, deactivatedByUserLinkId: null }),
      );
      assert.equal(
        await observeUserLinkOnLogin({
          tenantId: tenant.tenantId,
          providerUserId: 'user_pending',
          email: null,
          displayName: null,
        }),
        null,
        'a deactivated identity must not re-enter through login',
      );
      assert.equal(
        await activateUserLink({
          userLinkId: pending.userLinkId,
          activatedByUserLinkId: admin.userLinkId,
        }),
        null,
        'deactivated links are not re-activated by the activation path either',
      );
    });

    test('sessions: opaque token round trip, revocation, expiry, and read-time kill on deactivation', async () => {
      const tenant = await seedTenantWithConnection('org_sessions');
      const linkPending = await observeUserLinkOnLogin({
        tenantId: tenant.tenantId,
        providerUserId: 'user_sessions',
        email: null,
        displayName: null,
      });
      assert.ok(linkPending);
      const link = await activateUserLink({
        userLinkId: linkPending.userLinkId,
        activatedByUserLinkId: linkPending.userLinkId,
      });
      assert.ok(link);

      const created = await createSession({
        ...(await sessionBindingFor(tenant.tenantId)),
        tenantId: tenant.tenantId,
        userLinkId: link.userLinkId,
        providerSessionId: 'sid_abc',
        authTime: new Date(),
        ttlSeconds: 3600,
      });
      // the opaque value never appears in the database
      const stored = await query(`SELECT session_token_hash FROM identity_sessions`, []);
      assert.notEqual(
        String((stored.rows[0] as { session_token_hash: string }).session_token_hash),
        created.sessionToken,
      );

      const valid = await validateSessionToken(created.sessionToken);
      assert.ok(valid);
      assert.equal(valid.userLinkId, link.userLinkId);
      assert.equal(await validateSessionToken('forged-token-value'), null);

      // expiry (simulated by moving the clock of the ROW, not sleeping)
      await query(
        `UPDATE identity_sessions
          SET issued_at = NOW() - INTERVAL '2 hours', expires_at = NOW() - INTERVAL '1 hour'
        WHERE session_id = $1`,
        [created.session.sessionId],
      );
      assert.equal(await validateSessionToken(created.sessionToken), null);
      await query(
        `UPDATE identity_sessions SET expires_at = NOW() + INTERVAL '1 hour' WHERE session_id = $1`,
        [created.session.sessionId],
      );
      assert.ok(await validateSessionToken(created.sessionToken));

      // revocation is immediate
      assert.ok(await revokeSessionByToken(created.sessionToken, 'logout'));
      assert.equal(await validateSessionToken(created.sessionToken), null);
      assert.ok(
        !(await revokeSessionByToken(created.sessionToken, 'logout')),
        'second revoke is a no-op',
      );

      // deactivating the user kills remaining sessions at READ time
      const second = await createSession({
        ...(await sessionBindingFor(tenant.tenantId)),
        tenantId: tenant.tenantId,
        userLinkId: link.userLinkId,
        providerSessionId: null,
        authTime: new Date(),
        ttlSeconds: 3600,
      });
      await deactivateUserLink({ userLinkId: link.userLinkId, deactivatedByUserLinkId: null });
      assert.equal(await validateSessionToken(second.sessionToken), null);
    });

    test('revokeSessionsForUserLink sweeps every live session', async () => {
      const tenant = await seedTenantWithConnection('org_sweep');
      const linkPending = await observeUserLinkOnLogin({
        tenantId: tenant.tenantId,
        providerUserId: 'user_sweep',
        email: null,
        displayName: null,
      });
      assert.ok(linkPending);
      const link = await activateUserLink({
        userLinkId: linkPending.userLinkId,
        activatedByUserLinkId: linkPending.userLinkId,
      });
      assert.ok(link);
      await createSession({
        ...(await sessionBindingFor(tenant.tenantId)),
        tenantId: tenant.tenantId,
        userLinkId: link.userLinkId,
        providerSessionId: null,
        authTime: new Date(),
        ttlSeconds: 3600,
      });
      await createSession({
        ...(await sessionBindingFor(tenant.tenantId)),
        tenantId: tenant.tenantId,
        userLinkId: link.userLinkId,
        providerSessionId: null,
        authTime: new Date(),
        ttlSeconds: 3600,
      });
      assert.equal(await revokeSessionsForUserLink(link.userLinkId, 'security_event'), 2);
      assert.equal(await revokeSessionsForUserLink(link.userLinkId, 'security_event'), 0);
    });

    test('CSRF tokens are keyed to the session and verified in constant time', () => {
      const sessionId = randomUUID();
      const secret = 's'.repeat(40);
      const token = csrfTokenForSession(sessionId, secret);
      assert.ok(verifyCsrfToken(sessionId, secret, token));
      assert.ok(!verifyCsrfToken(sessionId, secret, token + 'x'));
      assert.ok(!verifyCsrfToken(sessionId, secret, undefined));
      assert.ok(!verifyCsrfToken(sessionId, 'different-secret-value-................', token));
      assert.ok(!verifyCsrfToken(randomUUID(), secret, token));
    });

    test('bootstrap: dry-run writes NOTHING; apply is idempotent; ambiguity refuses', async () => {
      const tenantId = randomUUID();
      const base = {
        tenantId,
        tenantName: 'Bootstrap Motors',
        providerOrganizationId: 'org_bootstrap',
        issuer: 'https://issuer.test.local',
        adminProviderUserId: 'user_admin',
        adminEmail: 'admin@example.com',
      };

      // dry-run: full plan, zero rows
      const plan = await bootstrapIdentity({ ...base, apply: false });
      assert.deepEqual(
        plan.map((s) => `${s.step}:${s.action}`),
        ['tenant:create', 'connection:create', 'user_link:create', 'role_binding:create'],
      );
      for (const table of [
        'tenants',
        'identity_provider_connections',
        'user_links',
        'role_bindings',
      ]) {
        const n = Number(
          ((await query(`SELECT COUNT(*)::int AS n FROM ${table}`, [])).rows[0] as { n: number }).n,
        );
        assert.equal(n, 0, `${table} must stay empty after a dry-run`);
      }

      // apply: everything lands, audited
      await bootstrapIdentity({ ...base, apply: true });
      const admin = await findUserLink({ query }, 'workos', tenantId, 'user_admin');
      assert.ok(admin);
      assert.equal(admin.status, 'activated');
      const binding = await query(
        `SELECT COUNT(*)::int AS n FROM role_bindings
        WHERE tenant_id = $1 AND user_link_id = $2 AND role = 'tenant_admin' AND status = 'active'`,
        [tenantId, admin.userLinkId],
      );
      assert.equal(Number((binding.rows[0] as { n: number }).n), 1);
      const audit = await query(
        `SELECT COUNT(*)::int AS n FROM audit_events WHERE event_type = 'identity.bootstrap.applied'`,
        [],
      );
      assert.equal(Number((audit.rows[0] as { n: number }).n), 1);

      // idempotent second apply: no new rows anywhere
      const second = await bootstrapIdentity({ ...base, apply: true });
      assert.deepEqual(
        second.map((s) => `${s.step}:${s.action}`),
        ['tenant:exists', 'connection:exists', 'user_link:exists', 'role_binding:exists'],
      );
      const links = Number(
        ((await query(`SELECT COUNT(*)::int AS n FROM user_links`, [])).rows[0] as { n: number }).n,
      );
      assert.equal(links, 1);

      // ambiguity: the SAME provider org claimed for a DIFFERENT tenant refuses
      await assert.rejects(
        bootstrapIdentity({ ...base, tenantId: randomUUID(), apply: true }),
        BootstrapRefused,
      );
    });
  },
);
