import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, beforeEach, describe, test } from 'node:test';
import { resetDatabase, skipIntegration } from '@dealer/test-kit';
import { closePool, query } from '@dealer/database';
import {
  createDealerGroup,
  createDepartment,
  createLegalEntity,
  createRooftop,
  createTenant,
} from '@dealer/organization';
import {
  POLICY_VERSION,
  createActionCatalog,
  createIdentityActionCatalog,
  createPolicyEngine,
  mergeActionCatalogs,
  type PolicyEngine,
} from '@dealer/identity-access';
import {
  SERVICE_ACTION_DEFINITIONS,
  createServiceActionCatalog,
  resolveServiceResourceScope,
} from '@dealer/fixed-ops';

/**
 * FBL-020 policy negative matrix: deny-by-default, database-authoritative
 * bindings, descendant scope coverage, immediate revocation, cross-tenant
 * denial, platform_admin without implicit dealership access, support-session
 * pathway, non-enumeration, and append-only evidence for every decision.
 */
describe(
  'central policy engine',
  { skip: skipIntegration ? 'set TEST_DATABASE_URL to run' : false },
  () => {
    after(async () => {
      await closePool();
    });

    let engine: PolicyEngine;

    beforeEach(async () => {
      await resetDatabase();
      engine = createPolicyEngine({
        catalog: mergeActionCatalogs(createServiceActionCatalog(), createIdentityActionCatalog()),
        resolveResourceScope: resolveServiceResourceScope,
      });
    });

    interface World {
      tenantId: string;
      rooftopA: string;
      rooftopB: string;
      departmentA: string;
      roA: string; // repair order under rooftop A
      roB: string; // repair order under rooftop B
    }

    async function buildWorld(): Promise<World> {
      const tenant = await createTenant({ name: 'Policy Motors', status: 'active' });
      const group = await createDealerGroup({
        tenantId: tenant.tenantId,
        name: 'Group',
        status: 'active',
      });
      const entity = await createLegalEntity({
        tenantId: tenant.tenantId,
        dealerGroupId: group.dealerGroupId,
        name: 'Entity LLC',
        status: 'active',
      });
      const rooftopA = await createRooftop({
        tenantId: tenant.tenantId,
        legalEntityId: entity.legalEntityId,
        name: 'North Store',
        status: 'active',
      });
      const rooftopB = await createRooftop({
        tenantId: tenant.tenantId,
        legalEntityId: entity.legalEntityId,
        name: 'South Store',
        status: 'active',
      });
      const departmentA = await createDepartment({
        tenantId: tenant.tenantId,
        rooftopId: rooftopA.rooftopId,
        code: 'service',
        name: 'Service',
        status: 'active',
      });
      const roA = randomUUID();
      const roB = randomUUID();
      for (const [roId, rooftopId] of [
        [roA, rooftopA.rooftopId],
        [roB, rooftopB.rooftopId],
      ] as const) {
        await query(
          `INSERT INTO repair_orders (ro_id, tenant_id, location_id, mdm_customer_id, mdm_vehicle_id)
         VALUES ($1, $2, $3, $4, $5)`,
          [roId, tenant.tenantId, rooftopId, randomUUID(), randomUUID()],
        );
      }
      return {
        tenantId: tenant.tenantId,
        rooftopA: rooftopA.rooftopId,
        rooftopB: rooftopB.rooftopId,
        departmentA: departmentA.departmentId,
        roA,
        roB,
      };
    }

    async function makeUser(tenantId: string | null): Promise<string> {
      const result = await query(
        `INSERT INTO user_links (actor_scope, tenant_id, provider, provider_user_id, status, activated_at)
       VALUES ($1, $2, 'workos', $3, 'activated', NOW()) RETURNING user_link_id`,
        [tenantId === null ? 'platform' : 'dealership', tenantId, 'user_' + randomUUID()],
      );
      return String((result.rows[0] as { user_link_id: unknown }).user_link_id);
    }

    async function bind(
      tenantId: string | null,
      userLinkId: string,
      role: string,
      scopeLevel: string,
      scopeId: string | null,
    ): Promise<string> {
      const result = await query(
        `INSERT INTO role_bindings (tenant_id, user_link_id, role, scope_level, scope_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING role_binding_id`,
        [tenantId, userLinkId, role, scopeLevel, scopeId],
      );
      return String((result.rows[0] as { role_binding_id: unknown }).role_binding_id);
    }

    async function evidenceCount(where = ''): Promise<number> {
      const result = await query(`SELECT COUNT(*)::int AS n FROM policy_decisions ${where}`, []);
      return Number((result.rows[0] as { n: number }).n);
    }

    test('deny by default: no bindings means deny, with an evidence row', async () => {
      const world = await buildWorld();
      const user = await makeUser(world.tenantId);

      const result = await engine.decide({
        actor: { userLinkId: user, actorScope: 'dealership', tenantId: world.tenantId },
        action: 'service.ro.create',
      });
      assert.equal(result.decision, 'deny');
      assert.equal(result.reasonCode, 'NO_MATCHING_BINDING');

      const rows = await query(`SELECT * FROM policy_decisions`, []);
      assert.equal(rows.rows.length, 1);
      const row = rows.rows[0] as Record<string, unknown>;
      assert.equal(String(row.decision), 'deny');
      assert.equal(String(row.policy_version), POLICY_VERSION);
      assert.equal(String(row.actor_user_link_id), user);
    });

    test('tenant-scope binding covers every descendant resource; evidence records the allow', async () => {
      const world = await buildWorld();
      const user = await makeUser(world.tenantId);
      await bind(world.tenantId, user, 'service_advisor', 'tenant', world.tenantId);

      for (const ro of [world.roA, world.roB]) {
        const result = await engine.decide({
          actor: { userLinkId: user, actorScope: 'dealership', tenantId: world.tenantId },
          action: 'service.ro.transition',
          resource: { type: 'repair_order', id: ro },
        });
        assert.equal(result.decision, 'allow', `tenant binding must cover RO ${ro}`);
        assert.equal(result.reasonCode, 'ALLOW_ROLE_BINDING');
      }
      assert.equal(await evidenceCount(`WHERE decision = 'allow'`), 2);
    });

    test('rooftop-scope binding covers ITS rooftop only — the sibling is invisible, not forbidden', async () => {
      const world = await buildWorld();
      const user = await makeUser(world.tenantId);
      await bind(world.tenantId, user, 'service_advisor', 'rooftop', world.rooftopA);

      const allowed = await engine.decide({
        actor: { userLinkId: user, actorScope: 'dealership', tenantId: world.tenantId },
        action: 'service.ro.transition',
        resource: { type: 'repair_order', id: world.roA },
      });
      assert.equal(allowed.decision, 'allow');

      const denied = await engine.decide({
        actor: { userLinkId: user, actorScope: 'dealership', tenantId: world.tenantId },
        action: 'service.ro.transition',
        resource: { type: 'repair_order', id: world.roB },
      });
      assert.equal(denied.decision, 'deny');
      assert.equal(denied.reasonCode, 'NO_MATCHING_BINDING');
      // non-enumeration: the route must render not-found, never a 403
      assert.equal(denied.resourceVisible, false);
    });

    test('a sub-tenant binding does NOT widen to tenant-wide reach on resource-less actions', async () => {
      const world = await buildWorld();
      const user = await makeUser(world.tenantId);
      // ONE rooftop-scoped binding — the narrowest thing an advisor can hold
      await bind(world.tenantId, user, 'service_advisor', 'rooftop', world.rooftopA);
      const actor = {
        userLinkId: user,
        actorScope: 'dealership' as const,
        tenantId: world.tenantId,
      };

      // a resource-less action naming NO location reaches the whole tenant:
      // a rooftop binding must not authorize it (this was the escalation)
      const tenantWide = await engine.decide({ actor, action: 'service.ro.create' });
      assert.equal(tenantWide.decision, 'deny');
      assert.equal(tenantWide.reasonCode, 'NO_MATCHING_BINDING');

      // naming THEIR rooftop is allowed…
      const own = await engine.decide({
        actor,
        action: 'service.ro.create',
        scopeHint: { level: 'rooftop', id: world.rooftopA },
      });
      assert.equal(own.decision, 'allow');

      // …and naming the SIBLING rooftop is denied
      const sibling = await engine.decide({
        actor,
        action: 'service.ro.create',
        scopeHint: { level: 'rooftop', id: world.rooftopB },
      });
      assert.equal(sibling.decision, 'deny');
      assert.equal(sibling.reasonCode, 'NO_MATCHING_BINDING');

      // a scope hint that does not resolve in this tenant stays invisible
      const foreign = await engine.decide({
        actor,
        action: 'service.ro.create',
        scopeHint: { level: 'rooftop', id: randomUUID() },
      });
      assert.equal(foreign.decision, 'deny');
      assert.equal(foreign.reasonCode, 'SCOPE_NOT_FOUND');
      assert.equal(foreign.resourceVisible, false);

      // a TENANT-scope binding still reaches tenant-wide actions
      const boss = await makeUser(world.tenantId);
      await bind(world.tenantId, boss, 'service_advisor', 'tenant', world.tenantId);
      const bossDecision = await engine.decide({
        actor: { userLinkId: boss, actorScope: 'dealership', tenantId: world.tenantId },
        action: 'service.ro.create',
      });
      assert.equal(bossDecision.decision, 'allow');
    });

    test('archiving an organization node revokes every binding scoped to it', async () => {
      const world = await buildWorld();
      const user = await makeUser(world.tenantId);
      await bind(world.tenantId, user, 'service_advisor', 'rooftop', world.rooftopA);
      const actor = {
        userLinkId: user,
        actorScope: 'dealership' as const,
        tenantId: world.tenantId,
      };
      const input = {
        actor,
        action: 'service.ro.transition',
        resource: { type: 'repair_order', id: world.roA },
      };
      assert.equal((await engine.decide(input)).decision, 'allow');

      // retire the rooftop the documented way — the binding row is untouched
      await query(`UPDATE rooftops SET status = 'archived' WHERE rooftop_id = $1`, [
        world.rooftopA,
      ]);
      const afterArchive = await engine.decide(input);
      assert.equal(afterArchive.decision, 'deny', 'an archived rooftop must authorize nothing');
      assert.equal(afterArchive.resourceVisible, false);
      const stillActive = await query(
        `SELECT COUNT(*)::int AS n FROM role_bindings WHERE user_link_id = $1 AND status = 'active'`,
        [user],
      );
      assert.equal(
        Number((stillActive.rows[0] as { n: number }).n),
        1,
        'the binding itself was not touched',
      );
    });

    test('an ANCESTOR that is not effective breaks the chain', async () => {
      const world = await buildWorld();
      const user = await makeUser(world.tenantId);
      await bind(world.tenantId, user, 'service_advisor', 'tenant', world.tenantId);
      const input = {
        actor: { userLinkId: user, actorScope: 'dealership' as const, tenantId: world.tenantId },
        action: 'service.ro.transition',
        resource: { type: 'repair_order', id: world.roA },
      };
      assert.equal((await engine.decide(input)).decision, 'allow');
      // deactivate the LEGAL ENTITY above the rooftop
      await query(`UPDATE legal_entities SET status = 'inactive' WHERE tenant_id = $1`, [
        world.tenantId,
      ]);
      assert.equal((await engine.decide(input)).decision, 'deny');
    });

    test('a still-pending backfilled rooftop authorizes nothing until activated', async () => {
      const world = await buildWorld();
      const user = await makeUser(world.tenantId);
      await bind(world.tenantId, user, 'service_advisor', 'tenant', world.tenantId);
      // migration 055 writes backfilled rooftops as pending_configuration
      await query(`UPDATE rooftops SET status = 'pending_configuration' WHERE rooftop_id = $1`, [
        world.rooftopA,
      ]);
      const decision = await engine.decide({
        actor: { userLinkId: user, actorScope: 'dealership', tenantId: world.tenantId },
        action: 'service.ro.transition',
        resource: { type: 'repair_order', id: world.roA },
      });
      assert.equal(decision.decision, 'deny');
      assert.equal(decision.resourceVisible, false);
    });

    test('revocation denies the VERY NEXT decision — no token to outlive it', async () => {
      const world = await buildWorld();
      const user = await makeUser(world.tenantId);
      const bindingId = await bind(
        world.tenantId,
        user,
        'service_advisor',
        'tenant',
        world.tenantId,
      );

      const input = {
        actor: { userLinkId: user, actorScope: 'dealership' as const, tenantId: world.tenantId },
        action: 'service.ro.create',
      };
      assert.equal((await engine.decide(input)).decision, 'allow');

      await query(
        `UPDATE role_bindings SET status = 'revoked', revoked_at = NOW() WHERE role_binding_id = $1`,
        [bindingId],
      );
      const after_ = await engine.decide(input);
      assert.equal(after_.decision, 'deny');
      assert.equal(after_.reasonCode, 'NO_MATCHING_BINDING');
    });

    test('cross-tenant is denied unconditionally, resource invisible', async () => {
      const world = await buildWorld();
      const other = await createTenant({ name: 'Other Motors', status: 'active' });
      const user = await makeUser(other.tenantId);
      await bind(other.tenantId, user, 'service_advisor', 'tenant', other.tenantId);

      // explicit cross-tenant target
      const crossTarget = await engine.decide({
        actor: { userLinkId: user, actorScope: 'dealership', tenantId: other.tenantId },
        action: 'service.ro.transition',
        targetTenantId: world.tenantId,
        resource: { type: 'repair_order', id: world.roA },
      });
      assert.equal(crossTarget.decision, 'deny');
      assert.equal(crossTarget.reasonCode, 'CROSS_TENANT');
      assert.equal(crossTarget.resourceVisible, false);

      // same-tenant target, foreign resource id: resolves to nothing
      const foreignResource = await engine.decide({
        actor: { userLinkId: user, actorScope: 'dealership', tenantId: other.tenantId },
        action: 'service.ro.transition',
        resource: { type: 'repair_order', id: world.roA },
      });
      assert.equal(foreignResource.decision, 'deny');
      assert.equal(foreignResource.reasonCode, 'RESOURCE_NOT_FOUND');
      assert.equal(foreignResource.resourceVisible, false);
    });

    test('platform_admin has NO implicit dealership access; platform actions still work', async () => {
      const world = await buildWorld();
      const admin = await makeUser(null);
      await bind(null, admin, 'platform_admin', 'platform', null);

      const dealership = await engine.decide({
        actor: { userLinkId: admin, actorScope: 'platform', tenantId: null },
        action: 'service.ro.transition',
        targetTenantId: world.tenantId,
        resource: { type: 'repair_order', id: world.roA },
      });
      assert.equal(dealership.decision, 'deny');
      assert.equal(dealership.reasonCode, 'NO_MATCHING_BINDING');
      assert.equal(
        dealership.resourceVisible,
        false,
        'tenant data must not even confirm existence',
      );

      const platform = await engine.decide({
        actor: { userLinkId: admin, actorScope: 'platform', tenantId: null },
        action: 'platform.tenant.provision',
        targetTenantId: null,
      });
      assert.equal(platform.decision, 'allow');
      assert.equal(platform.reasonCode, 'ALLOW_PLATFORM_ROLE');
    });

    test('an unknown action denies before any lookup', async () => {
      const world = await buildWorld();
      const user = await makeUser(world.tenantId);
      const result = await engine.decide({
        actor: { userLinkId: user, actorScope: 'dealership', tenantId: world.tenantId },
        action: 'service.ro.delete_everything',
      });
      assert.equal(result.decision, 'deny');
      assert.equal(result.reasonCode, 'ACTION_UNKNOWN');
    });

    test('a pending_configuration tenant cannot act — activation is explicit', async () => {
      const tenant = await createTenant({ name: 'Sleepy Motors' }); // pending_configuration
      const user = await makeUser(tenant.tenantId);
      await bind(tenant.tenantId, user, 'service_advisor', 'tenant', tenant.tenantId);

      const result = await engine.decide({
        actor: { userLinkId: user, actorScope: 'dealership', tenantId: tenant.tenantId },
        action: 'service.ro.create',
      });
      assert.equal(result.decision, 'deny');
      assert.equal(result.reasonCode, 'TENANT_INACTIVE');
    });

    test('the role a token CLAIMS is irrelevant — the engine has no token input at all', async () => {
      const world = await buildWorld();
      const user = await makeUser(world.tenantId);
      // The actor arrives with nothing but a user link id: whatever role hints a
      // provider token carried, there is no parameter to pass them through.
      const result = await engine.decide({
        actor: { userLinkId: user, actorScope: 'dealership', tenantId: world.tenantId },
        action: 'service.ro.create',
      });
      assert.equal(result.decision, 'deny');
    });

    test('support access: live approved session grants EXACTLY its action set, in scope, while unexpired and unrevoked', async () => {
      const world = await buildWorld();
      const supportActor = await makeUser(null);
      await bind(null, supportActor, 'platform_support', 'platform', null);
      const approver = await makeUser(world.tenantId);

      // approved request restricted to rooftop A, one read action + one write action
      const request = await query(
        `INSERT INTO support_access_requests
         (tenant_id, requester_user_link_id, requested_actions, scope_level, scope_id, reason, requested_duration_minutes, status, decided_by_user_link_id, decided_at)
       VALUES ($1, $2, ARRAY['service.ro.view','service.ro.transition'], 'rooftop', $3, 'ticket 9: verify stuck RO', 30, 'approved', $4, NOW())
       RETURNING request_id`,
        [world.tenantId, supportActor, world.rooftopA, approver],
      );
      const requestId = String((request.rows[0] as { request_id: unknown }).request_id);
      const session = await query(
        `INSERT INTO support_access_sessions (request_id, tenant_id, actor_user_link_id, expires_at)
       VALUES ($1, $2, $3, NOW() + INTERVAL '30 minutes') RETURNING support_session_id`,
        [requestId, world.tenantId, supportActor],
      );
      const sessionId = String(
        (session.rows[0] as { support_session_id: unknown }).support_session_id,
      );

      const actor = { userLinkId: supportActor, actorScope: 'platform' as const, tenantId: null };

      // in scope, in action set: allowed, evidence carries the session id
      const allowed = await engine.decide({
        actor,
        action: 'service.ro.view',
        targetTenantId: world.tenantId,
        resource: { type: 'repair_order', id: world.roA },
      });
      assert.equal(allowed.decision, 'allow');
      assert.equal(allowed.reasonCode, 'ALLOW_SUPPORT_SESSION');
      assert.equal(allowed.supportSessionId, sessionId);
      const evidenced = await query(
        `SELECT support_session_id FROM policy_decisions WHERE decision = 'allow' ORDER BY occurred_at DESC LIMIT 1`,
        [],
      );
      assert.equal(
        String((evidenced.rows[0] as { support_session_id: unknown }).support_session_id),
        sessionId,
      );

      // outside the approved action set: denied
      const wrongAction = await engine.decide({
        actor,
        action: 'service.ro.authorization.record',
        targetTenantId: world.tenantId,
        resource: { type: 'repair_order', id: world.roA },
      });
      assert.equal(wrongAction.decision, 'deny');

      // outside the approved scope (rooftop B): denied, invisible
      const wrongScope = await engine.decide({
        actor,
        action: 'service.ro.view',
        targetTenantId: world.tenantId,
        resource: { type: 'repair_order', id: world.roB },
      });
      assert.equal(wrongScope.decision, 'deny');
      assert.equal(wrongScope.resourceVisible, false);

      // revocation ends access immediately
      await query(
        `UPDATE support_access_sessions SET revoked_at = NOW() WHERE support_session_id = $1`,
        [sessionId],
      );
      const afterRevoke = await engine.decide({
        actor,
        action: 'service.ro.view',
        targetTenantId: world.tenantId,
        resource: { type: 'repair_order', id: world.roA },
      });
      assert.equal(afterRevoke.decision, 'deny');
    });

    test('evidence is append-only and PII-free: every decision row survives, ids and codes only', async () => {
      const world = await buildWorld();
      const user = await makeUser(world.tenantId);
      await bind(world.tenantId, user, 'service_advisor', 'tenant', world.tenantId);

      await engine.decide({
        actor: { userLinkId: user, actorScope: 'dealership', tenantId: world.tenantId },
        action: 'service.ro.transition',
        resource: { type: 'repair_order', id: world.roA },
        requestId: 'req_' + 'a'.repeat(10),
      });
      const rows = await query(`SELECT * FROM policy_decisions`, []);
      assert.ok(rows.rows.length >= 1);
      for (const raw of rows.rows) {
        const row = raw as Record<string, unknown>;
        // reason codes and versions, never free text or personal data
        assert.match(String(row.reason_code), /^[A-Z][A-Z0-9_]*$/);
        assert.equal(String(row.policy_version), POLICY_VERSION);
        assert.equal(JSON.stringify(row.details), '{}');
      }
    });

    test('the service catalog is complete and well-formed: 44 actions, unique, sensitive flags on staff-asserted paths', () => {
      assert.equal(SERVICE_ACTION_DEFINITIONS.length, 44);
      const catalog = createServiceActionCatalog(); // construction validates names + uniqueness
      assert.equal(catalog.list().length, 44);
      const record = catalog.get('service.ro.authorization.record');
      assert.ok(record);
      assert.equal(
        record.sensitive,
        true,
        'staff-asserted authorization recording must be sensitive',
      );
      // merged with the identity catalog without collision
      const merged = mergeActionCatalogs(
        createServiceActionCatalog(),
        createIdentityActionCatalog(),
      );
      assert.ok(merged.list().length > 44);
      // and a duplicate action is a CONSTRUCTION failure, not a runtime surprise
      assert.throws(() =>
        createActionCatalog([
          { action: 'x.y', description: 'a', resourceType: null, allowedRoles: ['r'] },
          { action: 'x.y', description: 'b', resourceType: null, allowedRoles: ['r'] },
        ]),
      );
    });

    test('scope resolver: RO-adjacent resources resolve through their repair order, tenant-scoped', async () => {
      const world = await buildWorld();
      // an MPI session on RO A resolves to rooftop A
      const mpiTemplate = await query(
        `INSERT INTO mpi_templates (tenant_id, location_id, name, items, status)
       VALUES ($1, $2, 'T', '[]', 'active') RETURNING template_id`,
        [world.tenantId, world.rooftopA],
      );
      const session = await query(
        `INSERT INTO mpi_sessions (tenant_id, ro_id, template_id, tech_user_id, status)
       VALUES ($1, $2, $3, $4, 'in_progress') RETURNING mpi_session_id`,
        [
          world.tenantId,
          world.roA,
          String((mpiTemplate.rows[0] as { template_id: unknown }).template_id),
          randomUUID(),
        ],
      );
      const ref = await resolveServiceResourceScope(
        world.tenantId,
        'mpi_session',
        String((session.rows[0] as { mpi_session_id: unknown }).mpi_session_id),
      );
      assert.deepEqual(ref, { level: 'rooftop', id: world.rooftopA });

      // another tenant sees nothing
      const foreign = await resolveServiceResourceScope(randomUUID(), 'repair_order', world.roA);
      assert.equal(foreign, null);

      // unknown types resolve to nothing — deny, never guess
      assert.equal(
        await resolveServiceResourceScope(world.tenantId, 'mystery_thing', randomUUID()),
        null,
      );
    });
  },
);
