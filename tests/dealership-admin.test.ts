import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, beforeEach, describe, test } from 'node:test';
import {
  mintReauthGrant,
  resetDatabase,
  seedActor,
  seedTenantIdentity,
  skipIntegration,
  startIdentityTestEnv,
  type IdentityTestEnv,
} from '@dealer/test-kit';
import { closePool, query } from '@dealer/database';
import { ROLES } from '@dealer/contracts';
import { TENANT_ADMIN_ROLE, deactivateUserLink } from '@dealer/identity-access';
import { createApp, resetAuthRoutesForTests, resetIdentityCompositionForTests } from '@dealer/api';

/**
 * RELEASE TRAIN 1 — THE DEALERSHIP ADMINISTRATION JOURNEY, through the real
 * HTTP stack against a real database (acceptance rows 1, 2 and 4).
 *
 *   * row 1: an owner configures the dealership end to end — settings,
 *     branding, business hours, bounded policies, the organization tree,
 *     invitations, roles — and everything persists, reloads and updates
 *     safely with optimistic concurrency;
 *   * row 2: the same operations are REFUSED for the unauthenticated, the
 *     wrong role, the deactivated, and cross-tenant targets — without leaking
 *     whether the foreign thing exists;
 *   * row 4: this surface speaks application/problem+json with stable codes
 *     and correlation identifiers; creating commands honor Idempotency-Key
 *     (same-transaction record, replay on retry, 422 on key reuse with a
 *     different request); sensitive commands spend a single-use step-up grant.
 */
describe(
  'dealership administration (RT1 rows 1, 2, 4)',
  { skip: skipIntegration ? 'set TEST_DATABASE_URL to run' : false },
  () => {
    let server: Server;
    let base: string;
    let env: IdentityTestEnv;

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
    });

    /** What a response body IS: whatever JSON.parse produced. */
    type ParsedJson = ReturnType<typeof JSON.parse>;

    async function call(
      token: string | null,
      method: string,
      path: string,
      body?: unknown,
      extraHeaders: Record<string, string> = {},
    ) {
      const res = await fetch(base + path, {
        method,
        headers: {
          'content-type': 'application/json',
          ...(token === null ? {} : { authorization: `Bearer ${token}` }),
          ...extraHeaders,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await res.text();
      return {
        status: res.status,
        contentType: res.headers.get('content-type') ?? '',
        replayed: res.headers.get('idempotency-replayed') === 'true',
        body: text ? (JSON.parse(text) as ParsedJson) : null,
      };
    }

    /** Every refusal on this surface must be a Problem Details document. */
    function assertProblem(
      r: { status: number; contentType: string; body: ParsedJson | null },
      status: number,
      code: string,
    ): void {
      assert.equal(r.status, status);
      assert.match(r.contentType, /application\/problem\+json/);
      assert.ok(r.body, 'a problem has a body');
      assert.equal(r.body!.status, status);
      assert.equal(r.body!.code, code);
      assert.equal(typeof r.body!.type, 'string');
      assert.equal(typeof r.body!.title, 'string');
      assert.ok(
        typeof r.body!.correlationId === 'string' && r.body!.correlationId.length > 0,
        'a problem names its correlation identifier',
      );
    }

    async function auditCount(eventType: string, actor: string): Promise<number> {
      const r = await query(
        `SELECT COUNT(*)::int AS n FROM audit_events
          WHERE event_type = $1 AND actor_user_id = $2`,
        [eventType, actor],
      );
      return Number((r.rows[0] as { n: number }).n);
    }

    async function seedAdmin(): Promise<{
      tenantId: string;
      userLinkId: string;
      token: string;
    }> {
      const tenantId = randomUUID();
      await seedTenantIdentity(tenantId, 'Journey Motors');
      const admin = await seedActor(env.issuer, { tenantId, roles: [TENANT_ADMIN_ROLE] });
      return { tenantId, userLinkId: admin.userLinkId, token: admin.token };
    }

    // ── row 1: the working journey ───────────────────────────────────────────

    test('an owner configures the dealership end to end, and it all persists', async () => {
      const { tenantId, userLinkId, token } = await seedAdmin();

      // 1. The overview loads before anything is configured.
      const empty = await call(token, 'GET', '/api/admin/overview');
      assert.equal(empty.status, 200);
      assert.equal(empty.body!.settings, null);
      assert.equal(empty.body!.counts.rooftops, 0);
      assert.ok(Array.isArray(empty.body!.invitableRoles));

      // 2. Settings: create, reload, safe concurrent update.
      const created = await call(token, 'PUT', '/api/admin/settings', {
        display_name: 'Journey Motors of Springfield',
        legal_name: 'Journey Motors LLC',
        brand_primary_color: '#0a5c36',
        logo_url: '/logo.png',
        timezone: 'America/Chicago',
        locale: 'en-US',
        expected_version: null,
      });
      assert.equal(created.status, 200);
      assert.equal(created.body!.settings.displayName, 'Journey Motors of Springfield');
      assert.equal(created.body!.settings.authorizationVersion, 1);

      const reloaded = await call(token, 'GET', '/api/admin/settings');
      assert.equal(reloaded.body!.settings.brandPrimaryColor, '#0a5c36');

      const updated = await call(token, 'PUT', '/api/admin/settings', {
        display_name: 'Journey Motors of Springfield',
        legal_name: 'Journey Motors LLC',
        brand_primary_color: '#123456',
        timezone: 'America/Chicago',
        expected_version: 1,
      });
      assert.equal(updated.status, 200);
      assert.equal(updated.body!.settings.authorizationVersion, 2);

      // A STALE version cannot clobber the newer save.
      const stale = await call(token, 'PUT', '/api/admin/settings', {
        display_name: 'Clobber',
        expected_version: 1,
      });
      assertProblem(stale, 409, 'version_conflict');
      assert.equal(stale.body!.errors.current_version, 2);
      const survived = await call(token, 'GET', '/api/admin/settings');
      assert.equal(survived.body!.settings.brandPrimaryColor, '#123456');

      // 3. Business hours: full-week replacement, coherent times enforced.
      const week = [0, 1, 2, 3, 4, 5, 6].map((day) => ({
        day_of_week: day,
        closed: day === 0,
        open_time: day === 0 ? null : '08:00',
        close_time: day === 0 ? null : '18:00',
      }));
      const hours = await call(token, 'PUT', '/api/admin/business-hours', { days: week });
      assert.equal(hours.status, 200);
      assert.equal(hours.body!.businessHours.length, 7);
      const badHours = await call(token, 'PUT', '/api/admin/business-hours', {
        days: [{ day_of_week: 2, closed: false, open_time: '18:00', close_time: '08:00' }],
      });
      assertProblem(badHours, 422, 'business_hours_invalid');

      // 4. Policies: bounded catalog, validated values.
      const policy = await call(
        token,
        'PUT',
        '/api/admin/policies/appointments.lead_time_minutes',
        {
          value: 120,
        },
      );
      assert.equal(policy.status, 200);
      assert.equal(policy.body!.policy.policyValue, 120);
      const badPolicy = await call(
        token,
        'PUT',
        '/api/admin/policies/appointments.lead_time_minutes',
        { value: 999999 },
      );
      assertProblem(badPolicy, 422, 'policy_invalid');
      const unknownPolicy = await call(token, 'PUT', '/api/admin/policies/not.a.policy', {
        value: 1,
      });
      assertProblem(unknownPolicy, 422, 'policy_invalid');

      // 5. The organization tree: a rooftop under the seeded legal entity, a
      //    department under the rooftop — idempotently.
      const org = await call(token, 'GET', '/api/admin/organization');
      const entityId = String(org.body!.legalEntities[0].legal_entity_id);
      const rooftopKey = randomUUID();
      const rooftop = await call(
        token,
        'POST',
        '/api/admin/organization/rooftop',
        { name: 'Downtown Rooftop', parent_id: entityId },
        { 'idempotency-key': rooftopKey },
      );
      assert.equal(rooftop.status, 201);
      const rooftopId = String(rooftop.body!.unit.unitId);

      // The SAME command retried replays the SAME outcome — no second rooftop.
      const retried = await call(
        token,
        'POST',
        '/api/admin/organization/rooftop',
        { name: 'Downtown Rooftop', parent_id: entityId },
        { 'idempotency-key': rooftopKey },
      );
      assert.equal(retried.status, 201);
      assert.equal(retried.replayed, true, 'the retry is a replay, not a re-execution');
      assert.equal(retried.body!.unit.unitId, rooftopId);
      const rooftopCount = await query(
        `SELECT COUNT(*)::int AS n FROM rooftops WHERE tenant_id = $1`,
        [tenantId],
      );
      assert.equal(Number((rooftopCount.rows[0] as { n: number }).n), 1);

      // The same KEY with a DIFFERENT request is refused.
      const misused = await call(
        token,
        'POST',
        '/api/admin/organization/rooftop',
        { name: 'A Different Rooftop', parent_id: entityId },
        { 'idempotency-key': rooftopKey },
      );
      assertProblem(misused, 422, 'idempotency_key_conflict');

      const department = await call(
        token,
        'POST',
        '/api/admin/organization/department',
        { name: 'Service', code: 'service', parent_id: rooftopId },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(department.status, 201);

      // Status transition, and a retried transition CONVERGES instead of 404ing.
      const off = await call(
        token,
        'PATCH',
        `/api/admin/organization/rooftop/${rooftopId}/status`,
        {
          status: 'inactive',
        },
      );
      assert.equal(off.status, 200);
      const offAgain = await call(
        token,
        'PATCH',
        `/api/admin/organization/rooftop/${rooftopId}/status`,
        { status: 'inactive' },
      );
      assert.equal(offAgain.status, 200, 'a retried PATCH converges on its own success');
      const on = await call(token, 'PATCH', `/api/admin/organization/rooftop/${rooftopId}/status`, {
        status: 'active',
      });
      assert.equal(on.status, 200);

      // 6. Invite a staff member: the invitation row and its outbox event are
      //    created together.
      const invite = await call(
        token,
        'POST',
        '/api/admin/users/invite',
        { email: 'new.advisor@example.com', role: ROLES.SERVICE_ADVISOR },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(invite.status, 201);
      const invitationId = String(invite.body!.invitation.invitationId);
      const outbox = await query(
        `SELECT event_type, payload FROM admin_outbox WHERE tenant_id = $1`,
        [tenantId],
      );
      assert.equal(outbox.rows.length, 1, 'the invitation enqueued exactly one outbox event');
      assert.equal(
        String((outbox.rows[0] as { event_type: unknown }).event_type),
        'admin.staff_invitation.created',
      );
      assert.equal(
        JSON.stringify((outbox.rows[0] as { payload: unknown }).payload).includes('example.com'),
        false,
        'the outbox payload carries ids only, never the address',
      );
      const dupInvite = await call(token, 'POST', '/api/admin/users/invite', {
        email: 'NEW.ADVISOR@example.com',
        role: ROLES.SERVICE_ADVISOR,
      });
      assertProblem(dupInvite, 422, 'invitation_invalid');

      // 7. Users: the roster lists the admin and the open invitation.
      const users = await call(token, 'GET', '/api/admin/users');
      assert.equal(users.status, 200);
      assert.ok(
        users.body!.users.some((u: ParsedJson) => u.userLinkId === userLinkId),
        'the administrator appears in their own roster',
      );
      assert.ok(
        users.body!.invitations.some((i: ParsedJson) => i.invitationId === invitationId),
        'the open invitation appears',
      );

      // 8. Role management on a second activated user — SENSITIVE, so the
      //    command spends a step-up grant inside its own transaction.
      const staff = await seedActor(env.issuer, { tenantId, roles: [] });
      const grantToken = await mintReauthGrant({
        tenantId,
        userLinkId,
        action: 'identity.role.grant',
        resourceId: null,
      });
      const grantKey = randomUUID();
      const granted = await call(
        token,
        'POST',
        `/api/admin/users/${staff.userLinkId}/roles`,
        {
          role: ROLES.SERVICE_MANAGER,
          scope_level: 'rooftop',
          scope_id: rooftopId,
          step_up_token: grantToken,
        },
        { 'idempotency-key': grantKey },
      );
      assert.equal(granted.status, 201);
      const bindingId = String(granted.body!.binding.roleBindingId);

      // The retry replays WITHOUT needing (or spending) another grant.
      const grantRetried = await call(
        token,
        'POST',
        `/api/admin/users/${staff.userLinkId}/roles`,
        {
          role: ROLES.SERVICE_MANAGER,
          scope_level: 'rooftop',
          scope_id: rooftopId,
          step_up_token: grantToken,
        },
        { 'idempotency-key': grantKey },
      );
      assert.equal(grantRetried.status, 201);
      assert.equal(grantRetried.replayed, true);
      assert.equal(grantRetried.body!.binding.roleBindingId, bindingId);
      const bindingCount = await query(
        `SELECT COUNT(*)::int AS n FROM role_bindings WHERE user_link_id = $1 AND status = 'active'`,
        [staff.userLinkId],
      );
      assert.equal(Number((bindingCount.rows[0] as { n: number }).n), 1);

      // 9. Revoke it again (a fresh grant — the last one was spent).
      const revokeToken = await mintReauthGrant({
        tenantId,
        userLinkId,
        action: 'identity.role.revoke',
        resourceId: null,
      });
      const revoked = await call(
        token,
        'DELETE',
        `/api/admin/users/${staff.userLinkId}/roles/${bindingId}`,
        { step_up_token: revokeToken },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(revoked.status, 200);

      // 10. Deactivate the staff member.
      const deactToken = await mintReauthGrant({
        tenantId,
        userLinkId,
        action: 'identity.user.deactivate',
        resourceId: null,
      });
      const deactivated = await call(
        token,
        'POST',
        `/api/admin/users/${staff.userLinkId}/deactivate`,
        { step_up_token: deactToken },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(deactivated.status, 200);
      const roster = await call(token, 'GET', '/api/admin/users');
      const row = roster.body!.users.find((u: ParsedJson) => u.userLinkId === staff.userLinkId);
      assert.equal(row.status, 'deactivated');

      // 11. Every administrative change above left an ATTRIBUTABLE audit row.
      for (const [eventType, atLeast] of [
        ['admin.settings.created', 1],
        ['admin.settings.updated', 1],
        ['admin.business_hours.replaced', 1],
        ['admin.policy.updated', 1],
        ['admin.invitation.created', 1],
        ['identity.organization_unit.created', 2],
        ['identity.organization_unit.status_changed', 2],
        ['identity.role_binding.granted', 1],
        ['identity.role_binding.revoked', 1],
        ['identity.user_link.deactivated', 1],
      ] as const) {
        assert.ok(
          (await auditCount(eventType, userLinkId)) >= atLeast,
          `${eventType} is audited and attributed to the administrator`,
        );
      }
    });

    // ── row 2: scoped administration, refusals without leaks ─────────────────

    test('the surface refuses the unauthenticated, the wrong role, the wrong tenant and the deactivated', async () => {
      const a = await seedAdmin();
      const b = await seedAdmin();

      // Unauthenticated: a problem, not a stack trace, not the legacy envelope.
      const anon = await call(null, 'GET', '/api/admin/overview');
      assert.equal(anon.status, 401);
      assert.match(anon.contentType, /application\/problem\+json/);

      // Wrong role: an activated service advisor holds no administration action.
      const advisor = await seedActor(env.issuer, {
        tenantId: a.tenantId,
        roles: [ROLES.SERVICE_ADVISOR],
      });
      const denied = await call(advisor.token, 'GET', '/api/admin/overview');
      assert.equal(denied.status, 403);
      assert.match(denied.contentType, /application\/problem\+json/);
      assert.equal(
        denied.body!.detail.includes(a.tenantId),
        false,
        'no tenant data in the refusal',
      );

      const deniedWrite = await call(advisor.token, 'PUT', '/api/admin/settings', {
        display_name: 'Nope',
        expected_version: null,
      });
      assert.equal(deniedWrite.status, 403);

      // Cross-tenant: B's administrator aiming at A's user — indistinguishable
      // from a nonexistent one, and nothing about A comes back.
      const bGrant = await mintReauthGrant({
        tenantId: b.tenantId,
        userLinkId: b.userLinkId,
        action: 'identity.role.grant',
        resourceId: null,
      });
      const crossTenant = await call(
        b.token,
        'POST',
        `/api/admin/users/${a.userLinkId}/roles`,
        { role: ROLES.SERVICE_MANAGER, step_up_token: bGrant },
        { 'idempotency-key': randomUUID() },
      );
      assertProblem(crossTenant, 404, 'not_found');

      // …and B's roster shows exactly B's people, none of A's.
      const bUsers = await call(b.token, 'GET', '/api/admin/users');
      assert.equal(
        bUsers.body!.users.some((u: ParsedJson) => u.userLinkId === a.userLinkId),
        false,
      );

      // A tenant override in the body disagreeing with the credential is refused.
      const override = await call(a.token, 'PUT', '/api/admin/settings', {
        display_name: 'Sneak',
        expected_version: null,
        tenant_id: b.tenantId,
      });
      assertProblem(override, 403, 'tenant_mismatch');

      // Deactivated: the same credential that worked stops working.
      const shortLived = await seedActor(env.issuer, {
        tenantId: a.tenantId,
        roles: [TENANT_ADMIN_ROLE],
      });
      const before = await call(shortLived.token, 'GET', '/api/admin/overview');
      assert.equal(before.status, 200);
      await deactivateUserLink({
        userLinkId: shortLived.userLinkId,
        deactivatedByUserLinkId: a.userLinkId,
      });
      const afterDeact = await call(shortLived.token, 'GET', '/api/admin/overview');
      assert.equal(afterDeact.status, 401, 'a deactivated identity is refused at read time');
    });

    // ── row 4: safe-command mechanics beyond the journey ─────────────────────

    test('sensitive commands demand a live step-up grant, exactly once', async () => {
      const { tenantId, userLinkId, token } = await seedAdmin();
      const staff = await seedActor(env.issuer, { tenantId, roles: [] });

      // Without a token: refused before anything happens.
      const missing = await call(
        token,
        'POST',
        `/api/admin/users/${staff.userLinkId}/roles`,
        { role: ROLES.SERVICE_MANAGER },
        { 'idempotency-key': randomUUID() },
      );
      assertProblem(missing, 403, 'step_up_required');

      // With garbage: refused, and nothing was granted.
      const garbage = await call(
        token,
        'POST',
        `/api/admin/users/${staff.userLinkId}/roles`,
        { role: ROLES.SERVICE_MANAGER, step_up_token: 'not-a-grant' },
        { 'idempotency-key': randomUUID() },
      );
      assertProblem(garbage, 403, 'step_up_rejected');

      // A real grant works ONCE; its second spend (a NEW command, not a
      // replay) is refused — single use is the property.
      const grant = await mintReauthGrant({
        tenantId,
        userLinkId,
        action: 'identity.role.grant',
        resourceId: null,
      });
      const first = await call(
        token,
        'POST',
        `/api/admin/users/${staff.userLinkId}/roles`,
        { role: ROLES.SERVICE_MANAGER, step_up_token: grant },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(first.status, 201);
      const second = await call(
        token,
        'POST',
        `/api/admin/users/${staff.userLinkId}/roles`,
        { role: ROLES.PARTS_CLERK, step_up_token: grant },
        { 'idempotency-key': randomUUID() },
      );
      assertProblem(second, 403, 'step_up_rejected');
      const bindings = await query(
        `SELECT COUNT(*)::int AS n FROM role_bindings WHERE user_link_id = $1 AND status = 'active'`,
        [staff.userLinkId],
      );
      assert.equal(
        Number((bindings.rows[0] as { n: number }).n),
        1,
        'only the first spend granted',
      );

      // A refused sensitive command consumed NO idempotency key: the same key
      // retried with a REAL grant succeeds rather than replaying the refusal.
      const retryKey = randomUUID();
      const refusedFirst = await call(
        token,
        'POST',
        `/api/admin/users/${staff.userLinkId}/deactivate`,
        {},
        { 'idempotency-key': retryKey },
      );
      assertProblem(refusedFirst, 403, 'step_up_required');
      const realGrant = await mintReauthGrant({
        tenantId,
        userLinkId,
        action: 'identity.user.deactivate',
        resourceId: null,
      });
      const thenSucceeds = await call(
        token,
        'POST',
        `/api/admin/users/${staff.userLinkId}/deactivate`,
        { step_up_token: realGrant },
        { 'idempotency-key': retryKey },
      );
      assert.equal(thenSucceeds.status, 200, 'the refusal did not burn the key');
    });

    test('self-deactivation is refused and unknown admin routes are problems', async () => {
      const { userLinkId, token } = await seedAdmin();
      const self = await call(token, 'POST', `/api/admin/users/${userLinkId}/deactivate`, {});
      assertProblem(self, 422, 'self_deactivation_refused');

      const nowhere = await call(token, 'GET', '/api/admin/does-not-exist');
      assertProblem(nowhere, 404, 'route_not_found');
    });
  },
);
