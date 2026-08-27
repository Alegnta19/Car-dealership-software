import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, beforeEach, describe, test } from 'node:test';
import {
  actionPlane,
  createActionCatalog,
  createIdentityActionCatalog,
  createPolicyEngine,
  mergeActionCatalogs,
  type ActionDefinition,
} from '@dealer/identity-access';
import {
  bootstrapAdministrator,
  ensureActiveConnection,
  resetDatabase,
  seedLocalSession,
  seedTenantViaService,
  skipIntegration,
  fixtureAuthorizationStateWrite,
} from '@dealer/test-kit';
import { closePool, query } from '@dealer/database';

/**
 * FBL-020-R7-C1 §3 — THE AUTHORITY PLANE IS STRUCTURAL, NOT A NAME.
 *
 * The engine's control-plane behavior used to be selected by
 * `action.startsWith('platform.')`. It is now selected by the structural
 * `plane` field, validated at catalog construction. These tests prove the two
 * things a name-derived plane could never guarantee: catalog construction
 * REJECTS a contradictory definition, and RENAMING an action cannot move it
 * between planes — plus the engine behavioral consequence, that a
 * `platform.*`-NAMED customer action does not reach the control plane while a
 * genuine control-plane action does.
 */
describe('the authority plane is structural (FBL-020-R7-C1 §3)', () => {
  // ── pure catalog guarantees (no database) ──────────────────────────────

  test('the plane defaults to tenant, and a platform-NAMED action is tenant unless declared', () => {
    const named: ActionDefinition = {
      action: 'platform.looks.controlplane',
      description: 'a tenant action whose NAME merely starts with platform.',
      resourceType: 'repair_order',
      allowedRoles: ['service_advisor'],
    };
    assert.equal(actionPlane(named), 'tenant', 'absence of a plane means tenant');
    // It constructs fine BECAUSE it is a tenant action — the name buys nothing.
    const catalog = createActionCatalog([named]);
    assert.equal(actionPlane(catalog.get('platform.looks.controlplane')!), 'tenant');
  });

  test('catalog construction REJECTS a control-plane action carrying a customer resource', () => {
    assert.throws(
      () =>
        createActionCatalog([
          {
            action: 'platform.tenant.inspect',
            description: 'contradictory: control-plane but names a resource',
            resourceType: 'repair_order',
            allowedRoles: ['platform_admin'],
            plane: 'control_plane',
          },
        ]),
      /control_plane but names resourceType|carries no customer-resource payload/,
      'a control-plane action with a resource payload is a contradiction',
    );
  });

  test('catalog construction REJECTS an unknown plane', () => {
    assert.throws(
      () =>
        createActionCatalog([
          {
            action: 'identity.thing.do',
            description: 'bad plane',
            resourceType: null,
            allowedRoles: ['tenant_admin'],
            plane: 'wildcard' as unknown as 'tenant',
          },
        ]),
      /unknown plane/,
    );
  });

  test('renaming an action cannot change its authority plane', () => {
    // The SAME definition object under two different action strings keeps its
    // declared plane: the plane travels with the field, never with the name.
    const base = {
      description: 'genuine control-plane action',
      resourceType: null,
      allowedRoles: ['platform_admin'],
      plane: 'control_plane' as const,
    };
    const a = createActionCatalog([{ ...base, action: 'platform.tenant.provision' }]);
    const b = createActionCatalog([{ ...base, action: 'renamed.tenant.provision' }]);
    assert.equal(actionPlane(a.get('platform.tenant.provision')!), 'control_plane');
    assert.equal(
      actionPlane(b.get('renamed.tenant.provision')!),
      'control_plane',
      'the plane survives a name that no longer starts with platform.',
    );
    // And a tenant action does NOT gain a plane by being named platform.*
    const c = createActionCatalog([
      { action: 'platform.pretend', description: 't', resourceType: null, allowedRoles: ['x'] },
    ]);
    assert.equal(actionPlane(c.get('platform.pretend')!), 'tenant');
  });

  test('the real identity catalog marks exactly the three genuine control-plane actions', () => {
    const catalog = createIdentityActionCatalog();
    const controlPlane = catalog
      .list()
      .filter((d) => actionPlane(d) === 'control_plane')
      .map((d) => d.action)
      .sort();
    assert.deepEqual(controlPlane, [
      'platform.connection.certify_mfa_policy',
      'platform.support.request',
      'platform.tenant.provision',
    ]);
    // Every control-plane action names no resource — the structural invariant.
    for (const d of catalog.list()) {
      if (actionPlane(d) === 'control_plane') {
        assert.equal(
          d.resourceType,
          null,
          `${d.action} is control-plane and must carry no resource`,
        );
      }
    }
  });

  test('merging catalogs preserves each action’s declared plane', () => {
    const merged = mergeActionCatalogs(
      createActionCatalog([
        { action: 'a.tenant.thing', description: 't', resourceType: null, allowedRoles: ['r'] },
      ]),
      createActionCatalog([
        {
          action: 'b.platform.thing',
          description: 'c',
          resourceType: null,
          allowedRoles: ['r'],
          plane: 'control_plane',
        },
      ]),
    );
    assert.equal(actionPlane(merged.get('a.tenant.thing')!), 'tenant');
    assert.equal(actionPlane(merged.get('b.platform.thing')!), 'control_plane');
  });

  // ── engine behavioral proof (against the database) ─────────────────────

  describe(
    'the engine reads the plane, not the name',
    { skip: skipIntegration ? 'set TEST_DATABASE_URL to run' : false },
    () => {
      after(async () => {
        await closePool();
      });

      // A custom catalog whose NAMES both start with `platform.` but whose
      // PLANES differ: one genuine control-plane action, one tenant action.
      const CATALOG = createActionCatalog([
        {
          action: 'platform.real.inspect',
          description: 'a genuine control-plane action',
          resourceType: null,
          allowedRoles: ['platform_admin'],
          plane: 'control_plane',
        },
        {
          action: 'platform.fake.inspect',
          description: 'a tenant action whose NAME merely starts with platform.',
          resourceType: null,
          allowedRoles: ['platform_admin'],
        },
      ]);

      let platformLinkId: string;
      let platformSessionId: string;
      let tenantId: string;

      beforeEach(async () => {
        await resetDatabase();
        const tenant = await seedTenantViaService({ name: 'Plane Motors', status: 'active' });
        tenantId = tenant.tenantId;
        await ensureActiveConnection(tenant.tenantId);
        await ensureActiveConnection(null);
        // A real platform person with a platform-scope platform_admin binding.
        const subject = 'user_' + randomUUID();
        const link = await fixtureAuthorizationStateWrite(
          'seed-authorization-state',
          `INSERT INTO user_links
             (actor_scope, tenant_id, provider, provider_user_id, status, activated_at,
              connection_id, issuer, provider_organization_id)
           SELECT 'platform', NULL, 'workos', $1, 'activated', NOW(),
                  c.connection_id, c.issuer, c.provider_organization_id
             FROM identity_provider_connections c
            WHERE c.tenant_id IS NULL AND c.status = 'active' LIMIT 1
           RETURNING user_link_id`,
          [subject],
        );
        platformLinkId = String((link.rows[0] as Record<string, unknown>).user_link_id);
        platformSessionId = (await seedLocalSession(platformLinkId)).sessionId;
        const admin = await bootstrapAdministrator(null);
        await fixtureAuthorizationStateWrite(
          'seed-authorization-state',
          `INSERT INTO role_bindings
             (tenant_id, user_link_id, role, scope_level, scope_id, status,
              effective_from, granted_by_user_link_id, authorization_version)
           VALUES (NULL, $1, 'platform_admin', 'platform', NULL, 'active',
                   NOW() - INTERVAL '1 hour', $2, 1)`,
          [platformLinkId, admin],
        );
      });

      function engine() {
        return createPolicyEngine({
          catalog: CATALOG,
          resolveResourceScope: () => Promise.resolve(null),
        });
      }

      test('a genuine control-plane action succeeds via the platform binding', async () => {
        const outcome = await engine().decide({
          actor: { userLinkId: platformLinkId, actorScope: 'platform', tenantId: null },
          action: 'platform.real.inspect',
          sessionId: platformSessionId,
          targetTenantId: tenantId,
        });
        assert.equal(outcome.decision, 'allow', 'the control-plane action is authorized');
        assert.equal(outcome.reasonCode, 'ALLOW_PLATFORM_ROLE');
      });

      test('a control-plane invocation carrying a customer resource is REFUSED, not laundered', async () => {
        // FBL-020-R7-C2 §2 — the engine used to ignore `resource` on the
        // control-plane branch entirely: the payload was silently discarded
        // and the caller got ALLOW. A genuine control-plane action invoked
        // WITH a customer resource now denies, with its own reason code, and
        // the evidence row records the denial.
        const outcome = await engine().decide({
          actor: { userLinkId: platformLinkId, actorScope: 'platform', tenantId: null },
          action: 'platform.real.inspect',
          sessionId: platformSessionId,
          targetTenantId: tenantId,
          resource: { type: 'repair_order', id: randomUUID() },
        });
        assert.equal(outcome.decision, 'deny');
        assert.equal(outcome.reasonCode, 'CONTROL_PLANE_CUSTOMER_PAYLOAD');
        const rows = await query(
          `SELECT decision, reason_code FROM policy_decisions
            WHERE action = 'platform.real.inspect'`,
        );
        assert.equal(rows.rows.length, 1, 'exactly the denial was recorded');
        assert.deepEqual(rows.rows[0], {
          decision: 'deny',
          reason_code: 'CONTROL_PLANE_CUSTOMER_PAYLOAD',
        });
      });

      test('a control-plane invocation carrying an organization scopeHint is REFUSED too', async () => {
        const outcome = await engine().decide({
          actor: { userLinkId: platformLinkId, actorScope: 'platform', tenantId: null },
          action: 'platform.real.inspect',
          sessionId: platformSessionId,
          targetTenantId: tenantId,
          scopeHint: { level: 'rooftop', id: randomUUID() },
        });
        assert.equal(outcome.decision, 'deny');
        assert.equal(outcome.reasonCode, 'CONTROL_PLANE_CUSTOMER_PAYLOAD');
        // …and the SAME invocation with the payload removed still succeeds —
        // the refusal is about the payload, never about the actor's authority.
        const clean = await engine().decide({
          actor: { userLinkId: platformLinkId, actorScope: 'platform', tenantId: null },
          action: 'platform.real.inspect',
          sessionId: platformSessionId,
          targetTenantId: tenantId,
        });
        assert.equal(clean.decision, 'allow');
        assert.equal(clean.reasonCode, 'ALLOW_PLATFORM_ROLE');
      });

      test('a platform-NAMED tenant action does NOT reach the control plane', async () => {
        // Same actor, same binding, an action whose NAME also starts with
        // platform. — but its plane is tenant, so the engine routes it to the
        // delegated-support path, which has no live session here and denies.
        // The name bought no control-plane authority.
        const outcome = await engine().decide({
          actor: { userLinkId: platformLinkId, actorScope: 'platform', tenantId: null },
          action: 'platform.fake.inspect',
          sessionId: platformSessionId,
          targetTenantId: tenantId,
        });
        assert.equal(
          outcome.decision,
          'deny',
          'a platform-named tenant action is not control-plane',
        );
        // and no control-plane evidence was written for it
        const rows = await query(
          `SELECT scope_level, tenant_id FROM policy_decisions WHERE action = 'platform.fake.inspect'`,
        );
        const row = rows.rows[0] as Record<string, unknown>;
        assert.notEqual(
          row.scope_level,
          'platform',
          'it was never recorded as a control-plane decision',
        );
      });
    },
  );
});
