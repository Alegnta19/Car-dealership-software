import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, beforeEach, describe, test } from 'node:test';
import {
  certifyMfaPolicy,
  resetDatabase,
  seedRooftopIdentity,
  skipIntegration,
  startIdentityTestEnv,
  testIssuer,
  testOrganizationId,
  type IdentityTestEnv,
  mintReauthGrant,
} from '@dealer/test-kit';
import { closePool, query } from '@dealer/database';
import { ROLES } from '@dealer/contracts';
import { createRooftop, createDealerGroup, createLegalEntity } from '@dealer/organization';
import {
  decideSupportAccess,
  activateUserLink,
  observeUserLinkOnLogin,
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
        issuer: testIssuer(),
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

      // ── 6. The backfilled organization is still PENDING, and pending
      //       authorizes nothing — migration 055 promises exactly this, so
      //       nobody can work at that rooftop until it is deliberately
      //       activated, not even the tenant administrator.
      const beforeActivation = await call(adminToken, 'POST', '/api/service/appointments', {
        location_id: legacyLocation,
        mdm_customer_id: randomUUID(),
        mdm_vehicle_id: randomUUID(),
        scheduled_start: new Date(Date.now() + 86_400_000).toISOString(),
      });
      assert.equal(
        beforeActivation.status,
        404,
        'a pending_configuration rooftop must not resolve as a scope',
      );

      // The administrator activates the chain the runbook describes.
      await query(`UPDATE dealer_groups SET status = 'active' WHERE tenant_id = $1`, [tenantId]);
      await query(`UPDATE legal_entities SET status = 'active' WHERE tenant_id = $1`, [tenantId]);
      await query(`UPDATE rooftops SET status = 'active' WHERE tenant_id = $1`, [tenantId]);

      // ── 6b. tenant_admin is NOT a service role: deny by default holds ─────
      const adminWrite = await call(adminToken, 'POST', '/api/service/appointments', {
        location_id: legacyLocation,
        mdm_customer_id: randomUUID(),
        mdm_vehicle_id: randomUUID(),
        scheduled_start: new Date(Date.now() + 86_400_000).toISOString(),
      });
      assert.equal(adminWrite.status, 403, 'administering identities is not doing service work');

      // ── 7. A new advisor logs in and receives NO privilege ────────────────
      const advisorLink = await observeUserLinkOnLogin({
        tenantId,
        providerUserId: 'user_advisor',
        email: 'advisor@delta.example',
        displayName: 'Ada Advisor',
      });
      assert.ok(advisorLink);
      assert.equal(advisorLink.status, 'pending', 'login must NOT activate (R1 section B)');
      const advisorToken = await tokenFor('user_advisor', tenantId);
      // a pending link carries no session and no access at all
      assert.equal((await call(advisorToken, 'GET', '/api/service/home')).status, 401);
      // the administrator activates it explicitly
      assert.ok(
        await activateUserLink({
          userLinkId: advisorLink.userLinkId,
          activatedByUserLinkId: adminLinkId,
        }),
      );
      const beforeRole = await call(advisorToken, 'GET', '/api/service/home');
      assert.equal(beforeRole.status, 403, 'a fresh identity carries no role');

      // ── 8. The administrator grants a ROOFTOP-scoped advisor role ─────────
      await grantRole(tenantId, advisorLink.userLinkId, ROLES.SERVICE_ADVISOR, {
        level: 'rooftop',
        id: legacyLocation,
      });
      // A ROOFTOP binding reaches that rooftop — and NOT the whole tenant. An
      // unfiltered cockpit read spans every rooftop, so it is refused; naming
      // their own rooftop is allowed. (This is the escalation FBL-020-R0
      // closed: before the fix the narrowest binding answered tenant-wide.)
      assert.equal((await call(advisorToken, 'GET', '/api/service/home')).status, 403);
      assert.equal(
        (await call(advisorToken, 'GET', `/api/service/home?location_id=${legacyLocation}`)).status,
        200,
      );

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

      // …and the same holds for CREATING at the sibling rooftop: the rooftop
      // binding does not reach it, so planting work there is refused.
      const plantElsewhere = await call(advisorToken, 'POST', '/api/service/appointments', {
        location_id: otherRooftop,
        mdm_customer_id: randomUUID(),
        mdm_vehicle_id: randomUUID(),
        scheduled_start: new Date(Date.now() + 86_400_000).toISOString(),
      });
      assert.equal(
        plantElsewhere.status,
        403,
        'a rooftop-scoped advisor cannot create work at another rooftop',
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
      // The reauth leg must return to its OWN callback, never the login one.
      assert.match(
        started.body!.data.authorization_url as string,
        /auth%2Freauth%2Fcallback|auth\/reauth\/callback/,
        'the reauthentication authorization URL must redirect to /auth/reauth/callback',
      );
      const txn = await query(
        `SELECT reauth_txn_id FROM reauthentication_transactions WHERE reauth_txn_id = $1`,
        [started.body!.data.reauth_txn_id],
      );
      assert.equal(txn.rows.length, 1);
      // Complete the EXACT transaction the route opened, using the nonce it
      // sealed into the cookie — the same value /auth/reauth/callback reads.
      // R1 journey step 7: FRESH authentication alone must NOT mint a
      // high-assurance grant while the organization's MFA policy is
      // uncertified. Freshness and policy are separate facts.
      const connectionRow = await query(
        `SELECT connection_id, mfa_policy_certified FROM identity_provider_connections
          WHERE tenant_id = $1`,
        [tenantId],
      );
      const connectionId = String(
        (connectionRow.rows[0] as { connection_id: unknown }).connection_id,
      );
      assert.equal(
        (connectionRow.rows[0] as { mfa_policy_certified: boolean }).mfa_policy_certified,
        false,
        'the connection starts uncertified',
      );
      const refusedGrant = await completeStartedReauthentication(
        started.headers.get('set-cookie'),
        advisorLink.userLinkId,
        String(started.body!.data.reauth_txn_id),
        connectionId,
        false,
      );
      assert.equal(refusedGrant, null, 'uncertified MFA policy must fail closed');
      const noGrantYet = await query(`SELECT COUNT(*)::int AS n FROM reauthentication_grants`, []);
      assert.equal(Number((noGrantYet.rows[0] as { n: number }).n), 0);

      // R1 journey step 8: certify the policy, start again, and exactly ONE
      // bound grant is created.
      await certifyMfaPolicy(tenantId);
      const started2 = await call(advisorToken, 'POST', '/auth/reauth/start', {
        action: 'service.ro.transition',
        qualifier: 'authorized',
        resource: { type: 'repair_order', id: roId },
      });
      assert.equal(started2.status, 200, JSON.stringify(started2.body));
      assert.equal(started2.body!.data.mfa_policy_certified, true);
      const grantResult = await completeStartedReauthentication(
        started2.headers.get('set-cookie'),
        advisorLink.userLinkId,
        String(started2.body!.data.reauth_txn_id),
        connectionId,
        true,
      );
      assert.ok(grantResult, 'certified policy plus freshness mints the grant');
      // exactly ONE transaction and ONE grant exist — no shadow transaction
      const txnCount = await query(
        `SELECT COUNT(*)::int AS n FROM reauthentication_transactions WHERE state = 'completed'`,
        [],
      );
      assert.equal(Number((txnCount.rows[0] as { n: number }).n), 1, 'exactly one completed');
      const grantCount = await query(`SELECT COUNT(*)::int AS n FROM reauthentication_grants`, []);
      assert.equal(Number((grantCount.rows[0] as { n: number }).n), 1);
      const authorized = await call(advisorToken, 'POST', `/api/service/ros/${roId}/transition`, {
        to_status: 'authorized',
        step_up_token: grantResult,
      });
      assert.equal(authorized.status, 200, JSON.stringify(authorized.body));

      // ── 13. Delegated support access: request, approve, act, indicate ─────
      // R2: the platform connection must exist BEFORE the platform support
      // identity can be activated — activation binds a link to exactly one
      // active connection, and there is nothing to bind to otherwise.
      await query(
        `INSERT INTO identity_provider_connections
         (connection_scope, tenant_id, provider, provider_organization_id, status, issuer)
       VALUES ('platform', NULL, 'workos', 'org_platform_support', 'active', $1)`,
        [testIssuer()],
      );
      const supportLink = await observeUserLinkOnLogin({
        tenantId: null,
        providerUserId: 'user_support',
        email: 'support@platform.example',
        displayName: 'Sam Support',
      });
      assert.ok(supportLink);
      assert.ok(
        await activateUserLink({
          userLinkId: supportLink.userLinkId,
          activatedByUserLinkId: adminLinkId,
        }),
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
      // R2 obligation 10: approval requires the APPROVER's own high-assurance
      // reauthentication. Separation of duty alone no longer suffices.
      assert.equal(
        await decideSupportAccess({
          requestId: supportRequest.requestId,
          decidedByUserLinkId: adminLinkId,
          approve: true,
        }),
        null,
        'approval without a high-assurance grant is refused',
      );
      await mintReauthGrant({
        tenantId,
        userLinkId: adminLinkId,
        action: 'identity.support.approve',
        resourceId: randomUUID(),
      });
      const approvalGrantRow = await query(
        `UPDATE reauthentication_grants SET consumed_at = NOW()
          WHERE user_link_id = $1 AND action = 'identity.support.approve'
          RETURNING grant_id`,
        [adminLinkId],
      );
      const supportSession = await decideSupportAccess({
        requestId: supportRequest.requestId,
        decidedByUserLinkId: adminLinkId,
        approve: true,
        approvalGrantId: String((approvalGrantRow.rows[0] as { grant_id: unknown }).grant_id),
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

      // ── 14b. R1: a missing nonce and a missing org_id are both rejected ───
      {
        const { createAccessTokenVerifier, TokenVerificationError } =
          await import('@dealer/identity-access');
        const v = createAccessTokenVerifier({
          issuer: env.issuer.issuer,
          audience: env.issuer.audience,
          jwksUri: env.issuer.jwksUri,
        });
        await assert.rejects(
          v.verify(await env.issuer.signAccessToken({}, { omit: ['org_id'] })),
          TokenVerificationError,
          'a token without org_id is rejected by the verifier itself',
        );
        await assert.rejects(
          v.verify(await env.issuer.signAccessToken({}), { requireNonce: 'the-demanded-nonce' }),
          TokenVerificationError,
          'a demanded nonce that is absent is rejected',
        );
        await assert.rejects(
          v.verify(await env.issuer.signAccessToken({ nonce: 'some-other-value' }), {
            requireNonce: 'the-demanded-nonce',
          }),
          TokenVerificationError,
          'a mismatched nonce is rejected',
        );
      }

      // ── 14c. R1: disabling the provider connection denies the next request
      await query(
        `UPDATE identity_provider_connections SET status = 'disabled' WHERE tenant_id = $1`,
        [tenantId],
      );
      assert.equal(
        (await call(adminToken, 'GET', '/auth/session')).status,
        401,
        'a disabled provider connection denies the very next request',
      );
      await query(
        `UPDATE identity_provider_connections SET status = 'active' WHERE tenant_id = $1`,
        [tenantId],
      );

      // ── 15. The evidence trail tells the whole story ──────────────────────
      const evidence = await query(
        `SELECT action, decision, reason_code, actor_user_link_id, support_session_id, details,
              matched_role_binding_ids, matched_authorization_versions,
              freshness_classification, mfa_assurance_classification, correlation_id
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
      // R1 section G: allows name the bindings they matched, with versions
      const allowRows = rows.filter((r) => String(r.decision) === 'allow');
      assert.ok(allowRows.length > 0);
      const roleAllows = allowRows.filter((r) => String(r.reason_code) === 'ALLOW_ROLE_BINDING');
      assert.ok(roleAllows.length > 0, 'at least one role-binding allow exists');
      for (const row of roleAllows) {
        const ids = row.matched_role_binding_ids as string[];
        const versions = row.matched_authorization_versions as unknown[];
        assert.ok(ids.length > 0, 'a role-binding allow names its binding');
        assert.equal(ids.length, versions.length, 'ids and versions stay aligned');
      }
      // …and denies never claim one
      for (const row of rows.filter((r) => String(r.decision) === 'deny')) {
        assert.equal((row.matched_role_binding_ids as string[]).length, 0);
      }
      // assurance classification is recorded, never invented
      for (const row of rows) {
        assert.ok(
          ['not_applicable', 'stale', 'fresh'].includes(String(row.freshness_classification)),
        );
        assert.ok(
          ['not_applicable', 'uncertified', 'certified'].includes(
            String(row.mfa_assurance_classification),
          ),
        );
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
     * Completes the EXACT transaction that POST /auth/reauth/start opened, by
     * opening the sealed transaction cookie the route set — the same nonce the
     * real /auth/reauth/callback reads. The only thing stubbed is the provider
     * code exchange (that needs live WorkOS); the transaction, its nonce, the
     * auth_time proof and the grant all come from production code.
     */
    async function completeStartedReauthentication(
      setCookieHeader: string | null,
      userLinkId: string,
      expectedTxnId: string,
      connectionId: string | null,
      mfaCertified: boolean,
    ): Promise<string | null> {
      const { completeReauthentication, openCookiePayload } =
        await import('@dealer/identity-access');
      assert.ok(setCookieHeader, 'the reauth start must seal a transaction cookie');
      const match = /dealer_reauth_txn=([^;,]+)/.exec(setCookieHeader);
      assert.ok(match, 'the sealed reauth transaction cookie must be present');
      const sealed = decodeURIComponent(match[1]!);
      const payload = openCookiePayload(sealed, env.cookiePassword, { maxAgeSeconds: 600 });
      assert.ok(payload, 'the sealed cookie must open with the configured cookie password');
      assert.equal(payload.purpose, 'reauth');
      const nonce = String(payload.nonce);

      const connection =
        connectionId === null ? null : { connectionId, mfaPolicyCertified: mfaCertified };
      const completed = await completeReauthentication({
        nonce,
        userLinkId,
        verifiedAuthTime: new Date(),
        connection,
      });
      if (completed === null) return null;
      assert.equal(
        completed.transaction.reauthTxnId,
        expectedTxnId,
        'the grant must belong to the transaction /auth/reauth/start opened, not a fresh one',
      );
      return completed.grant;
    }
  },
);
