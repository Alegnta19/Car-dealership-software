import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, beforeEach, describe, test } from 'node:test';
import { resetDatabase, skipIntegration } from '@dealer/test-kit';
import { closePool, query } from '@dealer/database';
import { createTenant } from '@dealer/organization';
import {
  createPendingUserLink,
  createSession,
  csrfTokenForSession,
  deactivateUserLink,
  ensureActivatedUserLink,
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
        `INSERT INTO identity_provider_connections (connection_scope, tenant_id, provider, provider_organization_id, status)
       VALUES ('dealership', $1, 'workos', $2, 'active')`,
        [tenant.tenantId, orgId],
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

    test('first login creates an ACTIVATED link with ZERO role bindings, audited', async () => {
      const tenant = await seedTenantWithConnection('org_first');
      const link = await ensureActivatedUserLink({
        tenantId: tenant.tenantId,
        providerUserId: 'user_first',
        email: 'first@example.com',
        displayName: 'First User',
      });
      assert.ok(link);
      assert.equal(link.status, 'activated');
      assert.ok(link.activatedAt instanceof Date);

      const bindings = await query(
        `SELECT COUNT(*)::int AS n FROM role_bindings WHERE user_link_id = $1`,
        [link.userLinkId],
      );
      assert.equal(
        Number((bindings.rows[0] as { n: number }).n),
        0,
        'no default role — deny-by-default holds',
      );

      const audit = await query(
        `SELECT COUNT(*)::int AS n FROM audit_events
        WHERE entity_type = 'user_link' AND entity_id = $1 AND event_type = 'identity.user_link.created'`,
        [link.userLinkId],
      );
      assert.equal(Number((audit.rows[0] as { n: number }).n), 1);

      // idempotent: a second login refreshes metadata, mints nothing new
      const again = await ensureActivatedUserLink({
        tenantId: tenant.tenantId,
        providerUserId: 'user_first',
        email: 'renamed@example.com',
        displayName: 'Renamed User',
      });
      assert.ok(again);
      assert.equal(again.userLinkId, link.userLinkId);
      assert.equal(again.email, 'renamed@example.com');
      const count = await query(`SELECT COUNT(*)::int AS n FROM user_links`, []);
      assert.equal(Number((count.rows[0] as { n: number }).n), 1);
    });

    test('pre-provisioned pending links activate on first login; deactivated links refuse login', async () => {
      const tenant = await seedTenantWithConnection('org_pending');
      const pending = await createPendingUserLink({
        tenantId: tenant.tenantId,
        providerUserId: 'user_pending',
        email: 'pending@example.com',
        createdByUserLinkId: null,
      });
      assert.equal(pending.status, 'pending');
      assert.equal(pending.activatedAt, null);

      const activated = await ensureActivatedUserLink({
        tenantId: tenant.tenantId,
        providerUserId: 'user_pending',
        email: 'pending@example.com',
        displayName: 'Pending Person',
      });
      assert.ok(activated);
      assert.equal(activated.userLinkId, pending.userLinkId);
      assert.equal(activated.status, 'activated');

      assert.ok(
        await deactivateUserLink({ userLinkId: pending.userLinkId, deactivatedByUserLinkId: null }),
      );
      const refused = await ensureActivatedUserLink({
        tenantId: tenant.tenantId,
        providerUserId: 'user_pending',
        email: 'pending@example.com',
        displayName: 'Pending Person',
      });
      assert.equal(refused, null, 'a deactivated identity must not re-enter through login');
    });

    test('sessions: opaque token round trip, revocation, expiry, and read-time kill on deactivation', async () => {
      const tenant = await seedTenantWithConnection('org_sessions');
      const link = await ensureActivatedUserLink({
        tenantId: tenant.tenantId,
        providerUserId: 'user_sessions',
        email: null,
        displayName: null,
      });
      assert.ok(link);

      const created = await createSession({
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
      const link = await ensureActivatedUserLink({
        tenantId: tenant.tenantId,
        providerUserId: 'user_sweep',
        email: null,
        displayName: null,
      });
      assert.ok(link);
      await createSession({
        tenantId: tenant.tenantId,
        userLinkId: link.userLinkId,
        providerSessionId: null,
        authTime: new Date(),
        ttlSeconds: 3600,
      });
      await createSession({
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
