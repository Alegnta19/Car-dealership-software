import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, beforeEach, describe, test } from 'node:test';
import {
  resetDatabase,
  seedRooftopIdentity,
  skipIntegration,
  startIdentityTestEnv,
  testOrganizationId,
  type IdentityTestEnv,
} from '@dealer/test-kit';
import { closePool, query } from '@dealer/database';
import { ROLES } from '@dealer/contracts';
import { createRooftop, createDealerGroup, createLegalEntity } from '@dealer/organization';
import {
  decideSupportAccess,
  ensureActivatedUserLink,
  requestSupportAccess,
  revokeSupportSession,
} from '@dealer/identity-access';
import { createApp, resetAuthRoutesForTests, resetIdentityCompositionForTests } from '@dealer/api';
import { bootstrapIdentity } from '../scripts/bootstrap-identity';

/**
 * The FBL-020 end-to-end journey, against a real database and the real HTTP
 * stack: from an unconfigured tenant to daily work, delegated support, and
 * revocation — fifteen steps, each asserting the property that step exists to
 * guarantee. No live provider credential: the deterministic local issuer
 * signs the tokens WorkOS would sign.
 */
describe(
  'identity journey (end to end)',
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
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      return {
        status: res.status,
        body: text ? (JSON.parse(text) as Record<string, any>) : null,
        headers: res.headers,
      };
    }

    async function tokenFor(providerUserId: string, tenantId: string): Promise<string> {
      return env.issuer.signAccessToken({
        sub: providerUserId,
        org_id: testOrganizationId(tenantId),
      });
    }

    async function grantRole(
      tenantId: string,
      userLinkId: string,
      role: string,
      scope: { level: string; id: string | null },
    ): Promise<void> {
      await query(
        `INSERT INTO role_bindings (tenant_id, user_link_id, role, scope_level, scope_id)
       VALUES ($1, $2, $3, $4, $5)`,
        [tenantId, userLinkId, role, scope.level, scope.id],
      );
    }

    test('a dealership goes from legacy data to daily work, support and revocation', async () => {
      const tenantId = randomUUID();
      const legacyLocation = randomUUID();

      // ── 1. A legacy tenant exists only as fixed-ops data ──────────────────
      // (Migration 055 already ran on this database; simulate the backfill
      // outcome for a tenant that has retained data: pending, not usable.)
      await query(
        `INSERT INTO tenants (tenant_id, name, status) VALUES ($1, 'Pending configuration', 'pending_configuration')`,
        [tenantId],
      );
      const group = await createDealerGroup({ tenantId, name: 'Pending configuration' });
      const entity = await createLegalEntity({
        tenantId,
        dealerGroupId: group.dealerGroupId,
        name: 'Pending configuration',
      });
      await createRooftop({
        tenantId,
        legalEntityId: entity.legalEntityId,
        rooftopId: legacyLocation,
        name: 'Rooftop ' + legacyLocation.slice(0, 8),
      });
      const pending = await query(`SELECT status FROM tenants WHERE tenant_id = $1`, [tenantId]);
      assert.equal(String((pending.rows[0] as { status: string }).status), 'pending_configuration');

      // ── 2. Nobody can do anything yet: no identities exist at all ─────────
      const strangerToken = await tokenFor('user_stranger', tenantId);
      assert.equal((await call(strangerToken, 'GET', '/api/service/home')).status, 401);

      // ── 3. Bootstrap DRY RUN writes nothing ───────────────────────────────
      const bootstrapArgs = {
        tenantId,
        tenantName: 'Delta Motors',
        providerOrganizationId: testOrganizationId(tenantId),
        adminProviderUserId: 'user_admin',
        adminEmail: 'admin@delta.example',
      };
      await bootstrapIdentity({ ...bootstrapArgs, apply: false });
      const afterDryRun = await query(`SELECT COUNT(*)::int AS n FROM user_links`, []);
      assert.equal(
        Number((afterDryRun.rows[0] as { n: number }).n),
        0,
        'a dry run must write nothing',
      );

      // ── 4. Bootstrap APPLY activates the tenant and mints ONE admin ───────
      await bootstrapIdentity({ ...bootstrapArgs, apply: true });
      const activated = await query(`SELECT status FROM tenants WHERE tenant_id = $1`, [tenantId]);
      assert.equal(String((activated.rows[0] as { status: string }).status), 'active');
      const adminRow = await query(
        `SELECT user_link_id FROM user_links WHERE provider_user_id = 'user_admin'`,
        [],
      );
      const adminLinkId = String((adminRow.rows[0] as { user_link_id: unknown }).user_link_id);

      // ── 5. The administrator works through the real HTTP stack ───────────
      const adminToken = await tokenFor('user_admin', tenantId);
      const session = await call(adminToken, 'GET', '/auth/session');
      assert.equal(session.status, 200);
      assert.deepEqual(session.body!.data.roles, ['tenant_admin']);
      assert.equal(session.body!.data.tenant_id, tenantId);

      // ── 6. tenant_admin is NOT a service role: deny by default holds ──────
      const adminWrite = await call(adminToken, 'POST', '/api/service/appointments', {
        location_id: legacyLocation,
        mdm_customer_id: randomUUID(),
        mdm_vehicle_id: randomUUID(),
        scheduled_start: new Date(Date.now() + 86_400_000).toISOString(),
      });
      assert.equal(adminWrite.status, 403, 'administering identities is not doing service work');

      // ── 7. A new advisor logs in and receives NO privilege ────────────────
      const advisorLink = await ensureActivatedUserLink({
        tenantId,
        providerUserId: 'user_advisor',
        email: 'advisor@delta.example',
        displayName: 'Ada Advisor',
      });
      assert.ok(advisorLink);
      const advisorToken = await tokenFor('user_advisor', tenantId);
      const beforeRole = await call(advisorToken, 'GET', '/api/service/home');
      assert.equal(beforeRole.status, 403, 'a fresh identity carries no role');

      // ── 8. The administrator grants a ROOFTOP-scoped advisor role ─────────
      await grantRole(tenantId, advisorLink.userLinkId, ROLES.SERVICE_ADVISOR, {
        level: 'rooftop',
        id: legacyLocation,
      });
      assert.equal((await call(advisorToken, 'GET', '/api/service/home')).status, 200);

      // ── 9. Real work: appointment → check-in → priced line ────────────────
      const appt = await call(advisorToken, 'POST', '/api/service/appointments', {
        location_id: legacyLocation,
        mdm_customer_id: randomUUID(),
        mdm_vehicle_id: randomUUID(),
        scheduled_start: new Date(Date.now() + 86_400_000).toISOString(),
      });
      assert.equal(appt.status, 201, JSON.stringify(appt.body));
      const checkedIn = await call(
        advisorToken,
        'POST',
        `/api/service/appointments/${appt.body!.data.appointment_id}/check-in`,
        {},
      );
      assert.equal(checkedIn.status, 200);
      const roId = checkedIn.body!.data.ro_id as string;
      const line = await call(advisorToken, 'POST', `/api/service/ros/${roId}/line-items`, {
        line_type: 'labor',
        description: 'Front brakes',
        estimated_hours: 2,
      });
      assert.equal(line.status, 201);
      await call(
        advisorToken,
        'PATCH',
        `/api/service/ros/${roId}/line-items/${line.body!.data.line_item_id}`,
        {
          price_ref: { amount_cents: 90_000, currency: 'USD' },
        },
      );

      // ── 10. Scope is real: a SECOND rooftop is invisible to this advisor ──
      const otherRooftop = randomUUID();
      await seedRooftopIdentity(tenantId, otherRooftop, 'South Store');
      const otherAppt = await query(
        `INSERT INTO service_appointments (tenant_id, location_id, mdm_customer_id, mdm_vehicle_id, scheduled_start)
       VALUES ($1, $2, $3, $4, NOW() + INTERVAL '1 day') RETURNING appointment_id`,
        [tenantId, otherRooftop, randomUUID(), randomUUID()],
      );
      const foreignId = String((otherAppt.rows[0] as { appointment_id: unknown }).appointment_id);
      const outOfScope = await call(
        advisorToken,
        'POST',
        `/api/service/appointments/${foreignId}/confirm`,
        {},
      );
      const nonexistent = await call(
        advisorToken,
        'POST',
        `/api/service/appointments/${randomUUID()}/confirm`,
        {},
      );
      assert.equal(outOfScope.status, 404);
      assert.equal(nonexistent.status, 404);
      assert.equal(
        outOfScope.body!.error.code,
        nonexistent.body!.error.code,
        'out-of-scope and nonexistent must be indistinguishable',
      );

      // ── 11. A sensitive action demands reauthentication ───────────────────
      const est = await call(
        advisorToken,
        'POST',
        `/api/service/ros/${roId}/estimates/generate`,
        {},
      );
      assert.equal(est.status, 201, JSON.stringify(est.body));
      await call(
        advisorToken,
        'POST',
        `/api/service/ros/${roId}/estimates/${est.body!.data.estimate_id}/send`,
        {},
      );
      await call(advisorToken, 'POST', `/api/service/ros/${roId}/authorizations/record`, {
        estimate_id: est.body!.data.estimate_id,
        method: 'portal',
        approved_items: [line.body!.data.line_item_id],
        evidence_refs: { portal_submission_id: randomUUID() },
      });
      const noGrant = await call(advisorToken, 'POST', `/api/service/ros/${roId}/transition`, {
        to_status: 'authorized',
      });
      assert.equal(noGrant.status, 403);
      assert.equal(noGrant.body!.error.code, 'step_up_required');

      // ── 12. Reauth start → callback-equivalent → single-use grant ─────────
      const started = await call(advisorToken, 'POST', '/auth/reauth/start', {
        action: 'service.ro.transition',
        qualifier: 'authorized',
        resource: { type: 'repair_order', id: roId },
      });
      assert.equal(started.status, 200, JSON.stringify(started.body));
      assert.match(started.body!.data.authorization_url as string, /max_age=0/);
      // The provider round trip is exercised in the OIDC suite; here the grant
      // is minted through the same production service the callback calls.
      const { completeReauthentication } = await import('@dealer/identity-access');
      const txn = await query(
        `SELECT reauth_txn_id FROM reauthentication_transactions WHERE reauth_txn_id = $1`,
        [started.body!.data.reauth_txn_id],
      );
      assert.equal(txn.rows.length, 1);
      const grantResult = await mintGrantForStartedTransaction(
        advisorLink.userLinkId,
        String(started.body!.data.reauth_txn_id),
        completeReauthentication,
      );
      const authorized = await call(advisorToken, 'POST', `/api/service/ros/${roId}/transition`, {
        to_status: 'authorized',
        step_up_token: grantResult,
      });
      assert.equal(authorized.status, 200, JSON.stringify(authorized.body));

      // ── 13. Delegated support access: request, approve, act, indicate ─────
      const supportLink = await ensureActivatedUserLink({
        tenantId: null,
        providerUserId: 'user_support',
        email: 'support@platform.example',
        displayName: 'Sam Support',
      });
      assert.ok(supportLink);
      await query(
        `INSERT INTO identity_provider_connections (connection_scope, tenant_id, provider, provider_organization_id, status)
       VALUES ('platform', NULL, 'workos', 'org_platform_support', 'active')`,
      );
      await query(
        `INSERT INTO role_bindings (tenant_id, user_link_id, role, scope_level, scope_id)
       VALUES (NULL, $1, 'platform_support', 'platform', NULL)`,
        [supportLink.userLinkId],
      );
      const supportToken = await env.issuer.signAccessToken({
        sub: 'user_support',
        org_id: 'org_platform_support',
      });

      // platform identity alone reaches NOTHING in the tenant
      const beforeApproval = await call(
        supportToken,
        'GET',
        `/api/service/ros/${roId}`,
        undefined,
        {
          'x-target-tenant': tenantId,
        },
      );
      assert.equal(
        beforeApproval.status,
        404,
        'a platform role must not even confirm the RO exists',
      );

      const supportRequest = await requestSupportAccess({
        tenantId,
        requesterUserLinkId: supportLink.userLinkId,
        requestedActions: ['service.ro.view'],
        reason: 'ticket 4821: customer disputes the authorized total',
        requestedDurationMinutes: 30,
      });
      const supportSession = await decideSupportAccess({
        requestId: supportRequest.requestId,
        decidedByUserLinkId: adminLinkId,
        approve: true,
      });
      assert.ok(supportSession);

      const underSupport = await call(supportToken, 'GET', `/api/service/ros/${roId}`, undefined, {
        'x-target-tenant': tenantId,
      });
      assert.equal(
        underSupport.status,
        200,
        'the approved action in the approved tenant is allowed',
      );
      assert.match(
        underSupport.headers.get('x-support-access') ?? '',
        new RegExp(supportSession.supportSessionId),
        'the support indicator is not suppressible',
      );
      // still bounded: an action OUTSIDE the approved set stays denied
      const outsideSet = await call(
        supportToken,
        'POST',
        `/api/service/ros/${roId}/transition`,
        {
          to_status: 'in_repair',
        },
        { 'x-target-tenant': tenantId },
      );
      assert.equal(outsideSet.status, 404);

      // the tenant can SEE the support session on its own session endpoint
      const tenantView = await call(adminToken, 'GET', '/auth/session');
      assert.equal(tenantView.body!.data.support_access.length, 1);
      assert.equal(
        tenantView.body!.data.support_access[0].support_session_id,
        supportSession.supportSessionId,
      );

      // ── 14. Revocation is immediate, everywhere ───────────────────────────
      await revokeSupportSession({
        supportSessionId: supportSession.supportSessionId,
        revokedByUserLinkId: adminLinkId,
      });
      const afterRevoke = await call(supportToken, 'GET', `/api/service/ros/${roId}`, undefined, {
        'x-target-tenant': tenantId,
      });
      assert.equal(afterRevoke.status, 404, 'revocation ends access on the next decision');

      await query(
        `UPDATE role_bindings SET status = 'revoked', revoked_at = NOW() WHERE user_link_id = $1`,
        [advisorLink.userLinkId],
      );
      assert.equal(
        (await call(advisorToken, 'GET', '/api/service/home')).status,
        403,
        'the advisor loses access on the very next request, same token',
      );

      // ── 15. The evidence trail tells the whole story ──────────────────────
      const evidence = await query(
        `SELECT action, decision, reason_code, actor_user_link_id, support_session_id, details
         FROM policy_decisions ORDER BY occurred_at`,
        [],
      );
      const rows = evidence.rows as Array<Record<string, unknown>>;
      assert.ok(rows.length >= 12, `expected a full decision trail, saw ${rows.length}`);
      const codes = new Set(rows.map((r) => String(r.reason_code)));
      for (const expected of [
        'ALLOW_ROLE_BINDING',
        'NO_MATCHING_BINDING',
        'ALLOW_SUPPORT_SESSION',
      ]) {
        assert.ok(codes.has(expected), `evidence must include ${expected}`);
      }
      assert.ok(
        rows.some((r) => String(r.support_session_id ?? '') === supportSession.supportSessionId),
        'the support session id is on the decisions it authorized',
      );
      // evidence carries ids and codes only — never PII or free text
      for (const row of rows) {
        assert.equal(JSON.stringify(row.details), '{}');
      }
      // and it is append-only
      await assert.rejects(
        query(`UPDATE policy_decisions SET decision = 'allow' WHERE decision = 'deny'`),
        (err: unknown) => (err as { code?: string }).code === 'P0001',
      );

      // the reason text never leaked into the audit trail
      const audits = await query(`SELECT details FROM audit_events`, []);
      const serialized = JSON.stringify(audits.rows);
      assert.ok(
        !serialized.includes('ticket 4821'),
        'support reason text stays in the request row',
      );
    });

    /**
     * Mints the grant for a transaction opened through POST /auth/reauth/start.
     * The provider leg is proven in the OIDC suite; this drives the same
     * production completion service the callback route calls, with a verified
     * auth_time of "now".
     */
    async function mintGrantForStartedTransaction(
      userLinkId: string,
      reauthTxnId: string,
      complete: typeof import('@dealer/identity-access').completeReauthentication,
    ): Promise<string> {
      // The route sealed the nonce into a cookie; re-open the transaction the
      // way the callback does by minting a fresh one bound identically.
      const { startReauthentication } = await import('@dealer/identity-access');
      const row = await query(
        `SELECT tenant_id, action, resource_type, resource_id FROM reauthentication_transactions
        WHERE reauth_txn_id = $1`,
        [reauthTxnId],
      );
      const t = row.rows[0] as Record<string, unknown>;
      const restarted = await startReauthentication({
        tenantId: String(t.tenant_id),
        userLinkId,
        action: String(t.action),
        resourceType: t.resource_type === null ? null : String(t.resource_type),
        resourceId: t.resource_id === null ? null : String(t.resource_id),
      });
      const completed = await complete({
        nonce: restarted.nonce,
        userLinkId,
        verifiedAuthTime: new Date(),
      });
      assert.ok(completed, 'the reauthentication must complete');
      return completed.grant;
    }
  },
);
