import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { after, beforeEach, describe, test } from 'node:test';
import {
  bootstrapAdministrator,
  ensureActiveConnection,
  fixtureAuthorizationStateWrite,
  fixtureWriteCounters,
  resetDatabase,
  seedTenantViaService,
  skipIntegration,
  withPresentedSession,
} from '@dealer/test-kit';
import { closePool, query } from '@dealer/database';
import * as organization from '@dealer/organization';
import {
  UnattributableMutationError,
  changeOrganizationUnitStatus,
  createIdentityActionCatalog,
  createOrganizationUnit,
  createPolicyEngine,
  grantRole,
} from '@dealer/identity-access';
import { createServiceActionCatalog, resolveServiceResourceScope } from '@dealer/fixed-ops';
import { mergeActionCatalogs } from '@dealer/identity-access';

const ROOT = join(__dirname, '..');

function runGuard(args: string[]): { code: number; output: string } {
  try {
    const output = execFileSync('npx', ['tsx', 'scripts/check-owned-mutations.ts', ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      shell: process.platform === 'win32',
      maxBuffer: 64 * 1024 * 1024,
    });
    return { code: 0, output };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

/**
 * FBL-020-R4 §5 — THE OWNED MUTATION BOUNDARY.
 *
 * Two halves, and both have to hold or the section is theatre:
 *
 *   THE SURFACE. `@dealer/organization` exported six production writes that changed
 *   authorization state with no acting actor, no version advance and no audit row — and
 *   `setUnitStatus(..., 'archived')` in particular revoked the reach of every binding
 *   scoped beneath the node, because the policy engine denies any decision whose ancestry
 *   chain contains an ineffective node. They are gone; the attributed services replace
 *   them; this suite proves the replacement leaves the trail and that the archival really
 *   does revoke.
 *
 *   THE GUARD. `scripts/check-owned-mutations.ts` is run here against fixtures that
 *   deliberately reintroduce each bypass. It must REJECT every one of them by name, and
 *   ACCEPT the sanctioned paths — a guard that failed everything would be no guard at all.
 */
describe(
  'owned mutation boundary (FBL-020-R4 §5)',
  { skip: skipIntegration ? 'set TEST_DATABASE_URL to run' : false },
  () => {
    after(async () => {
      await closePool();
    });

    let tenantId: string;

    beforeEach(async () => {
      await resetDatabase();
      tenantId = (await seedTenantViaService({ name: 'Owned Motors', status: 'active' })).tenantId;
    });

    async function actor(): Promise<string> {
      return bootstrapAdministrator(null);
    }

    async function makeUser(): Promise<string> {
      await ensureActiveConnection(tenantId);
      const result = await fixtureAuthorizationStateWrite(
        'seed-authorization-state',
        `INSERT INTO user_links
           (actor_scope, tenant_id, provider, provider_user_id, status, activated_at,
            connection_id, issuer, provider_organization_id)
         SELECT 'dealership', $1, 'workos', $2, 'activated', NOW(),
                c.connection_id, c.issuer, c.provider_organization_id
           FROM identity_provider_connections c
          WHERE c.tenant_id IS NOT DISTINCT FROM $1 AND c.provider = 'workos'
            AND c.status = 'active'
          LIMIT 1
         RETURNING user_link_id`,
        [tenantId, 'user_' + randomUUID()],
      );
      return String((result.rows[0] as { user_link_id: unknown }).user_link_id);
    }

    test('the organization package exports NO write any more', () => {
      const surface = organization as unknown as Record<string, unknown>;
      for (const gone of [
        'createTenant',
        'setTenantStatus',
        'createDealerGroup',
        'createLegalEntity',
        'createRooftop',
        'createDepartment',
        'setUnitStatus',
      ]) {
        assert.equal(
          typeof surface[gone],
          'undefined',
          `${gone} is an unattributed authorization-state write and must not be exported`,
        );
      }
      // …and the reads it legitimately owns are still there.
      for (const kept of ['getTenant', 'listRooftops', 'getUnit', 'resolveAncestry']) {
        assert.equal(typeof surface[kept], 'function', `${kept} is a read and must remain`);
      }
    });

    test('creating a unit is attributed, versioned and audited', async () => {
      const acting = await actor();
      const group = await createOrganizationUnit({
        actingUserLinkId: acting,
        tenantId,
        level: 'dealer_group',
        parentId: tenantId,
        name: 'Attributed Group',
        status: 'active',
      });
      assert.equal(group.authorizationVersion, 1, 'a create ESTABLISHES version 1');
      assert.equal(group.actingUserLinkId, acting);

      const row = await query(
        `SELECT created_by_user_link_id, updated_by_user_link_id, authorization_version, status
           FROM dealer_groups WHERE dealer_group_id = $1`,
        [group.unitId],
      );
      const stored = row.rows[0] as Record<string, unknown>;
      assert.equal(String(stored.created_by_user_link_id), acting);
      assert.equal(String(stored.updated_by_user_link_id), acting);
      assert.equal(Number(stored.authorization_version), 1);

      const audit = await query(
        `SELECT event_type, actor_user_id, details FROM audit_events
          WHERE entity_type = 'dealer_group' AND entity_id = $1`,
        [group.unitId],
      );
      assert.equal(audit.rows.length, 1, 'exactly one audit row, in the mutation transaction');
      const event = audit.rows[0] as {
        event_type: string;
        actor_user_id: string;
        details: Record<string, unknown>;
      };
      assert.equal(event.event_type, 'identity.organization_unit.created');
      assert.equal(event.actor_user_id, acting);
      assert.equal(event.details.level, 'dealer_group');
      assert.equal(event.details.parent_id, tenantId);
      assert.equal(event.details.authorization_version, 1);
    });

    test('an unattributable create is REFUSED rather than landing unowned', async () => {
      await assert.rejects(
        createOrganizationUnit({
          actingUserLinkId: randomUUID(), // a well-formed id belonging to nobody
          tenantId,
          level: 'dealer_group',
          parentId: tenantId,
          name: 'Ghost Group',
        }),
        UnattributableMutationError,
      );
      await assert.rejects(
        createOrganizationUnit({
          actingUserLinkId: 'not-a-uuid',
          tenantId,
          level: 'dealer_group',
          parentId: tenantId,
          name: 'Ghost Group',
        }),
        UnattributableMutationError,
      );
      const count = await query(
        `SELECT COUNT(*)::int AS n FROM dealer_groups WHERE tenant_id = $1`,
        [tenantId],
      );
      // The refused writes left NOTHING: an unattributable mutation must not half-land.
      assert.equal(Number((count.rows[0] as { n: number }).n), 0);
    });

    test('archiving a rooftop is a versioned, audited MASS REVOCATION — and it revokes', async () => {
      const acting = await actor();
      const group = await createOrganizationUnit({
        actingUserLinkId: acting,
        tenantId,
        level: 'dealer_group',
        parentId: tenantId,
        name: 'Group',
        status: 'active',
      });
      const entity = await createOrganizationUnit({
        actingUserLinkId: acting,
        tenantId,
        level: 'legal_entity',
        parentId: group.unitId,
        name: 'Entity',
        status: 'active',
      });
      const rooftop = await createOrganizationUnit({
        actingUserLinkId: acting,
        tenantId,
        level: 'rooftop',
        parentId: entity.unitId,
        name: 'North',
        status: 'active',
      });

      const user = await makeUser();
      await grantRole({
        actingUserLinkId: acting,
        tenantId,
        userLinkId: user,
        role: 'service_advisor',
        scopeLevel: 'rooftop',
        scopeId: rooftop.unitId,
      });
      const roId = randomUUID();
      await query(
        `INSERT INTO repair_orders (ro_id, tenant_id, location_id, mdm_customer_id, mdm_vehicle_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [roId, tenantId, rooftop.unitId, randomUUID(), randomUUID()],
      );
      // FBL-020-R4 §2: an ALLOW must name the session the request presented, so the
      // fixture engine presents the actor's own live one — the same wrapper the policy
      // suite uses.
      const engine = withPresentedSession(
        createPolicyEngine({
          catalog: mergeActionCatalogs(createServiceActionCatalog(), createIdentityActionCatalog()),
          resolveResourceScope: resolveServiceResourceScope,
        }),
      );
      const before = await engine.decide({
        actor: { userLinkId: user, actorScope: 'dealership', tenantId },
        action: 'service.ro.view',
        resource: { type: 'repair_order', id: roId },
      });
      assert.equal(before.decision, 'allow');

      // THE TRANSITION. It advances the version and writes its own audit row — the two
      // things `setUnitStatus` did not do, for an act that revokes everything beneath it.
      const archived = await changeOrganizationUnitStatus({
        actingUserLinkId: acting,
        tenantId,
        level: 'rooftop',
        unitId: rooftop.unitId,
        status: 'archived',
      });
      assert.ok(archived);
      assert.equal(archived.authorizationVersion, 2);
      const audit = await query(
        `SELECT event_type, actor_user_id, details FROM audit_events
          WHERE entity_type = 'rooftop' AND entity_id = $1
            AND event_type = 'identity.organization_unit.status_changed'`,
        [rooftop.unitId],
      );
      assert.equal(audit.rows.length, 1);
      assert.equal((audit.rows[0] as { actor_user_id: string }).actor_user_id, acting);

      // …and the revocation is real: the SAME binding, untouched, now authorizes nothing,
      // because the ancestry chain is no longer effective.
      const after = await engine.decide({
        actor: { userLinkId: user, actorScope: 'dealership', tenantId },
        action: 'service.ro.view',
        resource: { type: 'repair_order', id: roId },
      });
      assert.equal(after.decision, 'deny');
    });

    test('a status transition that changes nothing is recorded as nothing', async () => {
      const acting = await actor();
      const group = await createOrganizationUnit({
        actingUserLinkId: acting,
        tenantId,
        level: 'dealer_group',
        parentId: tenantId,
        name: 'Idempotent Group',
        status: 'active',
      });
      assert.equal(
        await changeOrganizationUnitStatus({
          actingUserLinkId: acting,
          tenantId,
          level: 'dealer_group',
          unitId: group.unitId,
          status: 'active',
        }),
        null,
        'no row changed, so no version advance and no audit row',
      );
      const audit = await query(
        `SELECT COUNT(*)::int AS n FROM audit_events
          WHERE entity_id = $1 AND event_type = 'identity.organization_unit.status_changed'`,
        [group.unitId],
      );
      assert.equal(Number((audit.rows[0] as { n: number }).n), 0);
      // A unit of ANOTHER tenant is invisible to this one, and equally records nothing.
      const other = await seedTenantViaService({ name: 'Other Motors', status: 'active' });
      assert.equal(
        await changeOrganizationUnitStatus({
          actingUserLinkId: acting,
          tenantId: other.tenantId,
          level: 'dealer_group',
          unitId: group.unitId,
          status: 'archived',
        }),
        null,
      );
    });

    test('a department needs its code, and nothing else may carry one', async () => {
      const acting = await actor();
      await assert.rejects(
        createOrganizationUnit({
          actingUserLinkId: acting,
          tenantId,
          level: 'department',
          parentId: randomUUID(),
          name: 'Service',
        }),
        /a department requires a code/,
      );
      await assert.rejects(
        createOrganizationUnit({
          actingUserLinkId: acting,
          tenantId,
          level: 'dealer_group',
          parentId: tenantId,
          name: 'Coded Group',
          code: 'service',
        }),
        /has no code column/,
        'a value the row cannot store must be refused, never silently dropped',
      );
    });

    test('fixture bypasses are counted, so the suite can see how many it has', async () => {
      const before = fixtureWriteCounters();
      await fixtureAuthorizationStateWrite(
        'simulate-authorization-drift',
        `UPDATE tenants SET status = 'suspended' WHERE tenant_id = $1`,
        [tenantId],
      );
      const after = fixtureWriteCounters();
      assert.equal(after.total, before.total + 1, 'every bypass increments the total');
      assert.equal(
        after.byReason['simulate-authorization-drift'],
        before.byReason['simulate-authorization-drift'] + 1,
        'and increments its own reason, so the classes can be counted separately',
      );
      assert.equal(
        after.byReason['adversarial-bypass-attempt'],
        before.byReason['adversarial-bypass-attempt'],
        'and no other reason moves',
      );
    });

    // ── the guard itself ────────────────────────────────────────────────────

    test('the real repository passes the owned-mutation guard', () => {
      const { code, output } = runGuard([]);
      assert.equal(code, 0, `the real tree violates the boundary:\n${output}`);
      // The owned set is DERIVED from the migrations; if that stopped working the guard
      // would silently enforce less, so the run states what it found and this asserts it.
      assert.match(output, /12 authorization-state table\(s\) derived from migrations/);
      for (const table of ['tenants', 'rooftops', 'role_bindings', 'user_links']) {
        assert.match(output, new RegExp(table));
      }
    });

    test('EVERY reintroduced bypass is REJECTED, each by its own rule', () => {
      const { code, output } = runGuard(['architecture/fixtures/owned-mutation-bypass']);
      assert.notEqual(code, 0, `the guard accepted the bypass fixtures:\n${output}`);
      const expected: Array<[string, string]> = [
        ['unattributed-repository-write.ts', 'owned-mutation-write-outside-owner'],
        ['bootstrap-script-raw-write.ts', 'owned-mutation-write-outside-owner'],
        ['interpolated-table-write.ts', 'owned-mutation-target-not-statically-resolvable'],
        ['assembled-statement-write.ts', 'owned-mutation-write-outside-owner'],
        ['production-imports-test-kit.ts', 'test-kit-must-not-be-imported-by-production'],
      ];
      for (const [fixture, rule] of expected) {
        assert.match(
          output,
          new RegExp(`error ${rule}: architecture/fixtures/owned-mutation-bypass/${fixture}`),
          `${fixture} must be rejected as ${rule}`,
        );
      }
    });

    test('the sanctioned paths are ACCEPTED — the guard is not simply always red', () => {
      const { code, output } = runGuard(['architecture/fixtures/owned-mutation-correct']);
      assert.equal(code, 0, `the guard rejected the sanctioned paths:\n${output}`);
    });

    test('a test-side write outside the declared primitive FAILS the guard', () => {
      // The other half of rule 2, proved on a real file rather than argued: the guard is
      // pointed at a suite file and must accept it, and pointed at the same shape written
      // as a bare `query` (the bypass fixture) it must not.
      const clean = runGuard(['tests/owned-mutations.test.ts']);
      assert.equal(clean.code, 0, `this very file must satisfy rule 2:\n${clean.output}`);
      const dirty = runGuard([
        'architecture/fixtures/owned-mutation-bypass/unattributed-repository-write.ts',
      ]);
      assert.notEqual(dirty.code, 0);
    });
  },
);
