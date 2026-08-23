import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, beforeEach, describe, test } from 'node:test';
import {
  bootstrapAdministrator,
  ensureActiveConnection,
  resetDatabase,
  skipIntegration,
  withPresentedSession,
  fixtureAuthorizationStateWrite,
  seedDealerGroup,
  seedDepartment,
  seedLegalEntity,
  seedRooftop,
  seedTenantViaService,
} from '@dealer/test-kit';
import { closePool, query } from '@dealer/database';
import {
  POLICY_VERSION,
  RoleScopeMismatchError,
  changeRole,
  createActionCatalog,
  createIdentityActionCatalog,
  createPolicyEngine,
  grantRole,
  mergeActionCatalogs,
  revokeRole,
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
      // FBL-020-R4 §2: an ALLOW must name the session the request presented, so the
      // fixture engine presents the actor's own live session for any call that does
      // not name one itself. It never overrides an explicit `sessionId`, so the tests
      // below that are ABOUT the presented credential still control it exactly.
      engine = withPresentedSession(
        createPolicyEngine({
          catalog: mergeActionCatalogs(createServiceActionCatalog(), createIdentityActionCatalog()),
          resolveResourceScope: resolveServiceResourceScope,
        }),
      );
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
      const tenant = await seedTenantViaService({ name: 'Policy Motors', status: 'active' });
      const group = await seedDealerGroup({
        tenantId: tenant.tenantId,
        name: 'Group',
        status: 'active',
      });
      const entity = await seedLegalEntity({
        tenantId: tenant.tenantId,
        dealerGroupId: group.dealerGroupId,
        name: 'Entity LLC',
        status: 'active',
      });
      const rooftopA = await seedRooftop({
        tenantId: tenant.tenantId,
        legalEntityId: entity.legalEntityId,
        name: 'North Store',
        status: 'active',
      });
      const rooftopB = await seedRooftop({
        tenantId: tenant.tenantId,
        legalEntityId: entity.legalEntityId,
        name: 'South Store',
        status: 'active',
      });
      const departmentA = await seedDepartment({
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
      await ensureActiveConnection(tenantId);
      const result = await fixtureAuthorizationStateWrite(
        'seed-authorization-state',
        `INSERT INTO user_links
         (actor_scope, tenant_id, provider, provider_user_id, status, activated_at,
          connection_id, issuer, provider_organization_id)
       SELECT $1, $2, 'workos', $3, 'activated', NOW(),
              c.connection_id, c.issuer, c.provider_organization_id
         FROM identity_provider_connections c
        WHERE c.tenant_id IS NOT DISTINCT FROM $2 AND c.provider = 'workos' AND c.status = 'active'
        LIMIT 1
       RETURNING user_link_id`,
        [tenantId === null ? 'platform' : 'dealership', tenantId, 'user_' + randomUUID()],
      );
      return String((result.rows[0] as { user_link_id: unknown }).user_link_id);
    }

    /**
     * FBL-020-R3: authorization is never created by raw SQL here. Every grant
     * runs through the owned mutation service, attributed to the origin-of-trust
     * administrator, so the fixture leaves the same version + audit trail a
     * production grant does.
     */
    async function bind(
      tenantId: string | null,
      userLinkId: string,
      role: string,
      scopeLevel: string,
      scopeId: string | null,
    ): Promise<string> {
      const granted = await grantRole({
        actingUserLinkId: await bootstrapAdministrator(tenantId),
        tenantId,
        userLinkId,
        role,
        scopeLevel,
        scopeId,
      });
      return granted.roleBindingId;
    }

    /** The matching revocation: attributed, and it ADVANCES the version. */
    async function unbind(tenantId: string | null, roleBindingId: string): Promise<void> {
      const revoked = await revokeRole({
        actingUserLinkId: await bootstrapAdministrator(tenantId),
        roleBindingId,
      });
      assert.ok(revoked, 'the fixture revocation must have revoked an active binding');
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
      await fixtureAuthorizationStateWrite(
        'simulate-authorization-drift',
        `UPDATE rooftops SET status = 'archived' WHERE rooftop_id = $1`,
        [world.rooftopA],
      );
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
      await fixtureAuthorizationStateWrite(
        'simulate-authorization-drift',
        `UPDATE legal_entities SET status = 'inactive' WHERE tenant_id = $1`,
        [world.tenantId],
      );
      assert.equal((await engine.decide(input)).decision, 'deny');
    });

    test('a still-pending backfilled rooftop authorizes nothing until activated', async () => {
      const world = await buildWorld();
      const user = await makeUser(world.tenantId);
      await bind(world.tenantId, user, 'service_advisor', 'tenant', world.tenantId);
      // migration 055 writes backfilled rooftops as pending_configuration
      await fixtureAuthorizationStateWrite(
        'simulate-authorization-drift',
        `UPDATE rooftops SET status = 'pending_configuration' WHERE rooftop_id = $1`,
        [world.rooftopA],
      );
      const decision = await engine.decide({
        actor: { userLinkId: user, actorScope: 'dealership', tenantId: world.tenantId },
        action: 'service.ro.transition',
        resource: { type: 'repair_order', id: world.roA },
      });
      assert.equal(decision.decision, 'deny');
      assert.equal(decision.resourceVisible, false);
    });

    test('an exact resource binding permits ONLY its typed resource', async () => {
      const world = await buildWorld();
      const user = await makeUser(world.tenantId);
      // no organization binding at all — one exact resource binding
      const bindingId = (
        await grantRole({
          actingUserLinkId: await bootstrapAdministrator(world.tenantId),
          tenantId: world.tenantId,
          userLinkId: user,
          role: 'service_advisor',
          scopeLevel: 'resource',
          scopeId: null,
          resourceType: 'repair_order',
          resourceId: world.roA,
        })
      ).roleBindingId;
      const actor = {
        userLinkId: user,
        actorScope: 'dealership' as const,
        tenantId: world.tenantId,
      };

      // the exact resource: allowed, and the evidence names the binding
      const allowed = await engine.decide({
        actor,
        action: 'service.ro.transition',
        resource: { type: 'repair_order', id: world.roA },
      });
      assert.equal(allowed.decision, 'allow');
      assert.deepEqual(
        allowed.matchedBindings.map((m) => m.roleBindingId),
        [bindingId],
      );

      // a SIBLING resource: denied, invisibly
      const sibling = await engine.decide({
        actor,
        action: 'service.ro.transition',
        resource: { type: 'repair_order', id: world.roB },
      });
      assert.equal(sibling.decision, 'deny');
      assert.equal(sibling.resourceVisible, false);

      // the wrong TYPE with the same id: denied
      const wrongType = await engine.decide({
        actor,
        action: 'service.appointment.confirm',
        resource: { type: 'service_appointment', id: world.roA },
      });
      assert.equal(wrongType.decision, 'deny');

      // a tenant-wide action: a resource binding never widens to it
      const tenantWide = await engine.decide({ actor, action: 'service.ro.create' });
      assert.equal(tenantWide.decision, 'deny');
      assert.equal(tenantWide.reasonCode, 'NO_MATCHING_BINDING');

      // a nonexistent resource stays indistinguishable from an inaccessible one
      const ghost = await engine.decide({
        actor,
        action: 'service.ro.transition',
        resource: { type: 'repair_order', id: randomUUID() },
      });
      assert.equal(ghost.decision, 'deny');
      assert.equal(ghost.resourceVisible, sibling.resourceVisible);

      // revoking it denies the very next decision
      await unbind(world.tenantId, bindingId);
      const afterRevoke = await engine.decide({
        actor,
        action: 'service.ro.transition',
        resource: { type: 'repair_order', id: world.roA },
      });
      assert.equal(afterRevoke.decision, 'deny');
    });

    test('the database refuses ambiguous and incomplete resource scope', async () => {
      const world = await buildWorld();
      const user = await makeUser(world.tenantId);
      // FBL-020-R4 §5: four ADVERSARIAL bypass attempts. Each writes a binding shape the
      // grant service refuses to construct, and the assertion is that the DATABASE
      // refuses it too — so the write has to be raw, and is therefore declared.
      const attempts: Array<[string, () => Promise<unknown>]> = [
        [
          'resource level without a resource',
          () =>
            fixtureAuthorizationStateWrite(
              'adversarial-bypass-attempt',
              `INSERT INTO role_bindings (tenant_id, user_link_id, role, scope_level)
         VALUES ($1, $2, 'service_advisor', 'resource')`,
              [world.tenantId, user],
            ),
        ],
        [
          'resource level with only a type',
          () =>
            fixtureAuthorizationStateWrite(
              'adversarial-bypass-attempt',
              `INSERT INTO role_bindings (tenant_id, user_link_id, role, scope_level, resource_type)
         VALUES ($1, $2, 'service_advisor', 'resource', 'repair_order')`,
              [world.tenantId, user],
            ),
        ],
        [
          'resource level ALSO claiming an organization node',
          () =>
            fixtureAuthorizationStateWrite(
              'adversarial-bypass-attempt',
              `INSERT INTO role_bindings
           (tenant_id, user_link_id, role, scope_level, scope_id, resource_type, resource_id)
         VALUES ($1, $2, 'service_advisor', 'resource', $3, 'repair_order', $4)`,
              [world.tenantId, user, world.rooftopA, world.roA],
            ),
        ],
        [
          'an organization level carrying a resource',
          () =>
            fixtureAuthorizationStateWrite(
              'adversarial-bypass-attempt',
              `INSERT INTO role_bindings
           (tenant_id, user_link_id, role, scope_level, scope_id, resource_type, resource_id)
         VALUES ($1, $2, 'service_advisor', 'rooftop', $3, 'repair_order', $4)`,
              [world.tenantId, user, world.rooftopA, world.roA],
            ),
        ],
      ];
      for (const [label, attempt] of attempts) {
        await assert.rejects(
          attempt,
          (err: unknown) => (err as { code?: string }).code === '23514',
          `${label} must be refused by a CHECK`,
        );
      }
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

      await unbind(world.tenantId, bindingId);
      const after_ = await engine.decide(input);
      assert.equal(after_.decision, 'deny');
      assert.equal(after_.reasonCode, 'NO_MATCHING_BINDING');
    });

    test('cross-tenant is denied unconditionally, resource invisible', async () => {
      const world = await buildWorld();
      const other = await seedTenantViaService({ name: 'Other Motors', status: 'active' });
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

    /**
     * FBL-020-R3 correction B3 — a platform ROLE NAME at a tenant SCOPE reaches
     * no control-plane action, and cannot be recorded in the first place.
     *
     * The defect: `role_bindings.role` is free text under a name regex, and the
     * engine's last test for a dealership actor was
     * `def.allowedRoles.includes(b.role)` against a binding that covered the
     * tenant. A dealership actor holding
     * `{role: 'platform_admin', scopeLevel: 'tenant'}` was therefore ALLOWED
     * `platform.tenant.provision` — the whole control plane, from inside one
     * tenant.
     *
     * The CONTROL that makes this test a real one: the very same forged binding
     * is exercised against a NON-platform action that admits the very same role.
     * That decision must ALLOW — proving the row is active, effective, loaded by
     * the engine and covering the tenant — so the platform denial below can only
     * be the scope rule, not an incidental failure to see the binding.
     */
    test('a platform role at TENANT scope reaches no platform.* action, and cannot be granted', async () => {
      const world = await buildWorld();
      const user = await makeUser(world.tenantId);
      const admin = await bootstrapAdministrator(world.tenantId);

      // ── the WRITE layer: the misgrant is refused, at EVERY non-platform scope
      for (const [scopeLevel, scopeId] of [
        ['tenant', world.tenantId],
        ['rooftop', world.rooftopA],
        ['department', world.departmentA],
      ] as const) {
        await assert.rejects(
          grantRole({
            actingUserLinkId: admin,
            tenantId: world.tenantId,
            userLinkId: user,
            role: 'platform_admin',
            scopeLevel,
            scopeId,
          }),
          RoleScopeMismatchError,
          `platform_admin must not be grantable at ${scopeLevel} scope`,
        );
      }
      // …and the CONVERSE: a tenant role may not sit at platform scope. Nor may
      // a role this package has never published — platform scope is closed.
      for (const role of ['tenant_admin', 'service_advisor']) {
        await assert.rejects(
          grantRole({
            actingUserLinkId: await bootstrapAdministrator(null),
            tenantId: null,
            userLinkId: await makeUser(null),
            role,
            scopeLevel: 'platform',
            scopeId: null,
          }),
          RoleScopeMismatchError,
          `${role} must not be grantable at platform scope`,
        );
      }
      // a refused grant records NOTHING: no binding, no audit row.
      const recorded = await query(
        `SELECT COUNT(*)::int AS n FROM role_bindings WHERE role = 'platform_admin'`,
        [],
      );
      assert.equal(Number((recorded.rows[0] as { n: number }).n), 0, 'no misgrant was recorded');

      // ── changeRole is the OTHER way a role reaches a scope: same rule, and
      //    the refusal rolls the version back with the write.
      const legitimate = await bind(world.tenantId, user, 'tenant_admin', 'tenant', world.tenantId);
      await assert.rejects(
        changeRole({
          actingUserLinkId: admin,
          roleBindingId: legitimate,
          role: 'platform_admin',
        }),
        RoleScopeMismatchError,
        'changeRole must not be able to relabel a tenant binding as a platform role',
      );
      const unchanged = await query(
        `SELECT role, authorization_version FROM role_bindings WHERE role_binding_id = $1`,
        [legitimate],
      );
      const unchangedRow = unchanged.rows[0] as { role: string; authorization_version: string };
      assert.equal(unchangedRow.role, 'tenant_admin', 'the refused change was rolled back');
      assert.equal(Number(unchangedRow.authorization_version), 1, 'the version did not advance');

      // ── the ENGINE layer, proved independently of the write layer.
      //    This binding is forged by RAW SQL precisely BECAUSE the mutation
      //    service now refuses to produce it: the engine must refuse to honour
      //    such a row however it got there — a pre-correction row, a manual
      //    database fix, some future writer.
      await fixtureAuthorizationStateWrite(
        'seed-authorization-state',
        `INSERT INTO role_bindings (tenant_id, user_link_id, role, scope_level, scope_id)
         VALUES ($1, $2, 'platform_admin', 'tenant', $1)`,
        [world.tenantId, user],
      );

      // one catalog, two actions, the SAME allowed role — the only difference
      // between them is the STRUCTURAL plane (FBL-020-R7-C1 §3). The control-plane
      // action DECLARES its plane; the tenant action does not. The `platform.`
      // NAME buys nothing — a `platform.`-named action without the declared plane
      // is a tenant action, so the plane is what the engine reads, not the prefix.
      const twoActions = withPresentedSession(
        createPolicyEngine({
          catalog: createActionCatalog([
            {
              action: 'platform.tenant.provision',
              description: 'provision a tenant (control plane)',
              resourceType: null,
              allowedRoles: ['platform_admin'],
              plane: 'control_plane',
            },
            {
              action: 'org.unit.create',
              description: 'a TENANT-context action admitting the same role name',
              resourceType: null,
              allowedRoles: ['platform_admin'],
            },
          ]),
          resolveResourceScope: () => Promise.resolve(null),
        }),
      );
      const actor = {
        userLinkId: user,
        actorScope: 'dealership' as const,
        tenantId: world.tenantId,
      };

      // the CONTROL: the forged binding is live, effective, and covers the
      // tenant — so the engine does see it and does act on it.
      const tenantScoped = await twoActions.decide({ actor, action: 'org.unit.create' });
      assert.equal(
        tenantScoped.decision,
        'allow',
        'the forged tenant-scope binding must be visible to the engine',
      );
      assert.equal(tenantScoped.reasonCode, 'ALLOW_ROLE_BINDING');

      // THE DEFECT: the same binding, the same role, a platform action.
      const controlPlane = await twoActions.decide({ actor, action: 'platform.tenant.provision' });
      assert.equal(
        controlPlane.decision,
        'deny',
        'a tenant-scope binding reaches no control plane',
      );
      assert.equal(controlPlane.reasonCode, 'NO_MATCHING_BINDING');
      assert.deepEqual(controlPlane.matchedBindings, [], 'a deny claims no binding');

      // the denial is evidence, like every other decision
      const evidence = await query(
        `SELECT decision, reason_code FROM policy_decisions
          WHERE decision_id = $1`,
        [controlPlane.decisionId],
      );
      assert.deepEqual(evidence.rows[0], {
        decision: 'deny',
        reason_code: 'NO_MATCHING_BINDING',
      });
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
      const tenant = await seedTenantViaService({ name: 'Sleepy Motors' }); // pending_configuration
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

    /**
     * A LIVE approved support session, built directly so the ENGINE is the only
     * thing under test: the mutation services have their own authority gates,
     * and a fixture that went through them could not tell an engine defect from
     * a mutation-gate defect.
     *
     * Restricted to rooftop A, one read action and one write action.
     */
    async function seedLiveSupportSession(
      world: World,
      supportActor: string,
      approver: string,
    ): Promise<{ requestId: string; sessionId: string }> {
      // R2: an approved support request must name the high-assurance grant that
      // backed the approval — and R7 §3.2 requires the grant to name the REQUEST,
      // so the request is filed first, the grant is minted against it, and the
      // approval then cites the grant: the same order the production path takes.
      const request = await fixtureAuthorizationStateWrite(
        'seed-authorization-state',
        `INSERT INTO support_access_requests
         (tenant_id, requester_user_link_id, requested_actions, scope_level, scope_id, reason,
          requested_duration_minutes)
       VALUES ($1, $2, ARRAY['service.ro.view','service.ro.transition'], 'rooftop', $3,
              'ticket 9: verify stuck RO', 30)
       RETURNING request_id`,
        [world.tenantId, supportActor, world.rooftopA],
      );
      const requestId = String((request.rows[0] as { request_id: unknown }).request_id);
      const txn = await query(
        // R3: a grant belongs to a COMPLETED transaction. `rat_started_is_bound`
        // governs the `started` state — it demands the local session and the OIDC
        // nonce digest, and is proven in the schema and reauthentication suites.
        `INSERT INTO reauthentication_transactions
         (tenant_id, user_link_id, action, nonce_hash, expires_at, required_assurance,
          state, completed_at, terminal_reason, terminal_at,
          connection_id, issuer, provider_organization_id, provider_subject, oidc_nonce_hash)
       SELECT $1, $2, 'identity.support.approve', $3, NOW() + INTERVAL '5 minutes',
              'fresh_and_mfa_policy', 'completed', NOW(), 'granted', NOW(),
              c.connection_id, c.issuer,
              c.provider_organization_id, 'approver', $4
         FROM identity_provider_connections c WHERE c.tenant_id = $1 LIMIT 1
       RETURNING reauth_txn_id`,
        [world.tenantId, approver, 'b'.repeat(64), 'd'.repeat(64)],
      );
      await query(
        `INSERT INTO reauthentication_grants
         (reauth_txn_id, tenant_id, user_link_id, action, resource_type, resource_id,
          grant_hash, expires_at, assurance_level, mfa_policy_certified_at_issue, consumed_at)
       VALUES ($1, $2, $3, 'identity.support.approve', 'support_access_request', $5,
               $4, NOW() + INTERVAL '5 minutes', 'fresh_and_mfa_policy', TRUE, NOW())`,
        [
          String((txn.rows[0] as { reauth_txn_id: unknown }).reauth_txn_id),
          world.tenantId,
          approver,
          'c'.repeat(64),
          requestId,
        ],
      );

      await fixtureAuthorizationStateWrite(
        'seed-authorization-state',
        `UPDATE support_access_requests
            SET status = 'approved', decided_by_user_link_id = $2, decided_at = NOW(),
                approval_grant_id = (
                  SELECT g.grant_id FROM reauthentication_grants g
                   WHERE g.resource_id = $1 AND g.action = 'identity.support.approve')
          WHERE request_id = $1`,
        [requestId, approver],
      );
      const session = await fixtureAuthorizationStateWrite(
        'seed-authorization-state',
        `INSERT INTO support_access_sessions (request_id, tenant_id, actor_user_link_id, expires_at)
       VALUES ($1, $2, $3, NOW() + INTERVAL '30 minutes') RETURNING support_session_id`,
        [requestId, world.tenantId, supportActor],
      );
      return {
        requestId,
        sessionId: String((session.rows[0] as { support_session_id: unknown }).support_session_id),
      };
    }

    test('support access: live approved session grants EXACTLY its action set, in scope, while unexpired and unrevoked', async () => {
      const world = await buildWorld();
      const supportActor = await makeUser(null);
      await bind(null, supportActor, 'platform_support', 'platform', null);
      const approver = await makeUser(world.tenantId);

      const { sessionId } = await seedLiveSupportSession(world, supportActor, approver);

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

      // FBL-020-R4 §3 — SUPPORT USE IS AUDITED, once, in the evidence transaction.
      //
      // A request SERVED under delegated support access is a platform person
      // reaching into a customer's data. `policy_decisions` recorded it; the
      // `audit_events` trail an operator reads for "who touched this tenant"
      // recorded it nowhere. The row names the session, the actor and the
      // decision it belongs to — and never the free-text support reason.
      const used = await query(
        `SELECT actor_user_id, details FROM audit_events
          WHERE event_type = 'identity.support.used' AND entity_id = $1`,
        [sessionId],
      );
      assert.equal(used.rows.length, 1, 'a served support request writes exactly one audit event');
      const usedRow = used.rows[0] as { actor_user_id: unknown; details: Record<string, unknown> };
      assert.equal(String(usedRow.actor_user_id), supportActor, 'and names the TRUE actor');
      assert.equal(String(usedRow.details.action), 'service.ro.view');
      assert.equal(String(usedRow.details.decision_id), allowed.decisionId);
      assert.ok(
        !JSON.stringify(usedRow.details).includes('ticket 9'),
        'the support reason text never reaches the audit trail',
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
      await fixtureAuthorizationStateWrite(
        'simulate-authorization-drift',
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

    /**
     * FBL-020-R3 correction F1 — REVOKING THE BINDING IS OFFBOARDING.
     *
     * The engine's support branch used to consult the live session and the
     * approved request and NO role binding at all, so a platform actor whose
     * platform-support binding had been revoked — or had simply aged out of its
     * window — went on being answered `allow ALLOW_SUPPORT_SESSION` until the
     * session expired or somebody remembered to call `revokeSupportSession`.
     *
     * These tests leave the session itself untouched and LIVE: the only thing
     * that changes is the binding, so nothing else can explain the denial.
     */
    test('a LIVE support session stops authorizing the moment the actor binding is revoked', async () => {
      const world = await buildWorld();
      const supportActor = await makeUser(null);
      const supportBinding = await bind(null, supportActor, 'platform_support', 'platform', null);
      const approver = await makeUser(world.tenantId);
      const { sessionId } = await seedLiveSupportSession(world, supportActor, approver);

      const actor = { userLinkId: supportActor, actorScope: 'platform' as const, tenantId: null };
      const view = () =>
        engine.decide({
          actor,
          action: 'service.ro.view',
          targetTenantId: world.tenantId,
          resource: { type: 'repair_order', id: world.roA },
        });

      // control: with the binding in force the session authorizes
      const before = await view();
      assert.equal(before.reasonCode, 'ALLOW_SUPPORT_SESSION');
      assert.equal(before.supportSessionId, sessionId);

      // OFFBOARDING — the binding, and only the binding
      await unbind(null, supportBinding);
      const untouched = await query(
        `SELECT revoked_at, expires_at > NOW() AS unexpired
           FROM support_access_sessions WHERE support_session_id = $1`,
        [sessionId],
      );
      const state = untouched.rows[0] as { revoked_at: unknown; unexpired: unknown };
      assert.equal(state.revoked_at, null, 'the session was NOT revoked');
      assert.equal(state.unexpired, true, 'the session has NOT expired');

      const after = await view();
      assert.equal(after.decision, 'deny', 'a revoked binding ends a live session immediately');
      assert.equal(after.reasonCode, 'SUPPORT_ACTOR_UNAUTHORIZED');
      assert.equal(after.supportSessionId, null, 'a denial claims no session');
      assert.deepEqual(after.matchedBindings, []);
      // non-enumeration still holds: losing authority is not an existence oracle
      assert.equal(after.resourceVisible, false);
      // and the denial is evidence, like every other decision
      const evidence = await query(
        `SELECT decision, reason_code, support_session_id FROM policy_decisions
          WHERE decision_id = $1`,
        [after.decisionId],
      );
      assert.deepEqual(evidence.rows[0], {
        decision: 'deny',
        reason_code: 'SUPPORT_ACTOR_UNAUTHORIZED',
        support_session_id: null,
      });
    });

    test('a LIVE support session stops authorizing when the actor binding ages out of its window', async () => {
      const world = await buildWorld();
      const supportActor = await makeUser(null);
      await bind(null, supportActor, 'platform_support', 'platform', null);
      const approver = await makeUser(world.tenantId);
      const { sessionId } = await seedLiveSupportSession(world, supportActor, approver);

      const actor = { userLinkId: supportActor, actorScope: 'platform' as const, tenantId: null };
      const view = () =>
        engine.decide({
          actor,
          action: 'service.ro.view',
          targetTenantId: world.tenantId,
          resource: { type: 'repair_order', id: world.roA },
        });
      assert.equal((await view()).reasonCode, 'ALLOW_SUPPORT_SESSION');

      // The window closes; `status` stays 'active' — the shape a predicate that
      // checks only the status accepts.
      const moved = await fixtureAuthorizationStateWrite(
        'simulate-authorization-drift',
        `UPDATE role_bindings
            SET effective_from = NOW() - INTERVAL '2 days',
                effective_to = NOW() - INTERVAL '1 day'
          WHERE user_link_id = $1 AND scope_level = 'platform' AND status = 'active'
        RETURNING status`,
        [supportActor],
      );
      assert.equal(moved.rows.length, 1);
      assert.equal(String((moved.rows[0] as { status: unknown }).status), 'active');

      const after = await view();
      assert.equal(after.decision, 'deny');
      assert.equal(after.reasonCode, 'SUPPORT_ACTOR_UNAUTHORIZED');
      assert.equal(after.supportSessionId, null);
      const live = await query(
        `SELECT revoked_at FROM support_access_sessions WHERE support_session_id = $1`,
        [sessionId],
      );
      assert.equal((live.rows[0] as { revoked_at: unknown }).revoked_at, null);
    });

    test('evidence is append-only and PII-free: every decision row survives, ids and codes only', async () => {
      const world = await buildWorld();
      const user = await makeUser(world.tenantId);
      await bind(world.tenantId, user, 'service_advisor', 'tenant', world.tenantId);

      await engine.decide({
        actor: { userLinkId: user, actorScope: 'dealership', tenantId: world.tenantId },
        action: 'service.ro.transition',
        resource: { type: 'repair_order', id: world.roA },
      });
      const rows = await query(`SELECT * FROM policy_decisions`, []);
      assert.ok(rows.rows.length >= 1);
      for (const raw of rows.rows) {
        const row = raw as Record<string, unknown>;
        // reason codes and versions, never free text or personal data
        assert.match(String(row.reason_code), /^[A-Z][A-Z0-9_]*$/);
        assert.equal(String(row.policy_version), POLICY_VERSION);
        assert.equal(JSON.stringify(row.details), '{}');
        // FBL-020-R3: the correlatable ids are GENERATED, never taken from a
        // caller-supplied header — and never absent.
        assert.ok(typeof row.request_id === 'string' && (row.request_id as string).length >= 8);
        assert.ok(
          typeof row.correlation_id === 'string' && (row.correlation_id as string).length >= 8,
        );
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
