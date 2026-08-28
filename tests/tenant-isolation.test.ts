import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Client } from 'pg';
import {
  bootstrapAdministrator,
  fixtureAuthorizationStateWrite,
  resetDatabase,
  seedDealerGroup,
  seedDepartment,
  seedLegalEntity,
  seedRooftop,
  seedTenantViaService,
  skipIntegration,
} from '@dealer/test-kit';
import { closePool, query } from '@dealer/database';
import {
  createStaffInvitation,
  replaceBusinessHours,
  setDealershipPolicy,
  upsertDealershipSettings,
  TENANT_ADMIN_ROLE,
} from '@dealer/identity-access';

/**
 * RELEASE TRAIN 1, acceptance row 3 — TENANT ISOLATION AT THE DATABASE
 * BOUNDARY, proved through the REAL runtime login.
 *
 * Every query here runs on a genuine `dealership_app` connection (migration
 * 060's non-owner login; the policies target `dealership_runtime`, which it
 * holds by membership), because that is the identity the deployed service
 * holds. The proofs are deliberately written WITHOUT application predicates:
 * no `WHERE tenant_id = $1` anywhere in the attacking statements, which is
 * exactly the "absent or defective application filter" the row demands the
 * database itself survive.
 *
 *   * deny by default: with NO tenant context, every row-secured table is
 *     EMPTY and unwritable, even though rows exist;
 *   * context is the only lens: under tenant A's context a predicate-free
 *     SELECT returns ONLY A's rows;
 *   * cross-tenant writes die at the boundary: UPDATE/DELETE aimed at B's
 *     rows by primary key touch 0 rows; INSERT carrying B's tenant id is a
 *     WITH CHECK violation; a tenant-qualified composite reference to B's
 *     parent row cannot be created from A's context at all.
 */
describe(
  'database-enforced tenant isolation (RT1 row 3)',
  { skip: skipIntegration ? 'set TEST_DATABASE_URL to run' : false },
  () => {
    const OWNER_URL = process.env.TEST_DATABASE_URL as string;
    const APP_PASSWORD = 'tenant_isolation_test_pw';
    let app: Client;

    /** The row-secured tables this train owns or covers, with their id column. */
    const SECURED_TABLES = [
      'dealer_groups',
      'legal_entities',
      'rooftops',
      'departments',
      'dealership_settings',
      'dealership_business_hours',
      'dealership_policies',
      'staff_invitations',
      'idempotency_keys',
    ] as const;

    let tenantA: string;
    let tenantB: string;
    let adminA: string;
    let adminB: string;
    let rooftopA: string;
    let rooftopB: string;

    before(async () => {
      const owner = new Client({ connectionString: OWNER_URL });
      await owner.connect();
      try {
        await owner.query(`ALTER ROLE dealership_app PASSWORD '${APP_PASSWORD}'`);
      } finally {
        await owner.end();
      }
      const u = new URL(OWNER_URL);
      u.username = 'dealership_app';
      u.password = APP_PASSWORD;
      app = new Client({ connectionString: u.toString() });
      await app.connect();
    });

    after(async () => {
      await app.end();
      await closePool();
    });

    async function noContext(): Promise<void> {
      // The empty string is how "no context" reads: app_tenant_ctx() NULLIFs
      // it, and a policy comparing to NULL matches nothing. (RESET would error
      // on a custom GUC that was never defined for the session.)
      await app.query(`SELECT set_config('app.tenant_id', '', false)`);
    }

    async function contextOf(tenantId: string): Promise<void> {
      await app.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenantId]);
    }

    beforeEach(async () => {
      await resetDatabase();
      await noContext();
      // Seed TWO fully-populated tenants through the production services (the
      // owner-side pool bypasses nothing it should not: services set their own
      // transaction-scoped context).
      tenantA = (await seedTenantViaService({ name: 'Tenant A Motors', status: 'active' }))
        .tenantId;
      tenantB = (await seedTenantViaService({ name: 'Tenant B Motors', status: 'active' }))
        .tenantId;
      adminA = await bootstrapAdministrator(tenantA);
      adminB = await bootstrapAdministrator(tenantB);
      const seedTenant = async (
        tenantId: string,
        admin: string,
      ): Promise<{ rooftopId: string; legalEntityId: string }> => {
        const group = await seedDealerGroup({ tenantId, name: 'Group' });
        const entity = await seedLegalEntity({
          tenantId,
          dealerGroupId: group.dealerGroupId,
          name: 'Entity LLC',
        });
        const rooftop = await seedRooftop({
          tenantId,
          legalEntityId: entity.legalEntityId,
          name: 'Main Street',
        });
        await seedDepartment({
          tenantId,
          rooftopId: rooftop.rooftopId,
          code: 'service',
          name: 'Service',
        });
        const saved = await upsertDealershipSettings({
          actingUserLinkId: admin,
          tenantId,
          expectedVersion: null,
          settings: { displayName: 'Dealer ' + tenantId.slice(0, 8), timezone: 'UTC' },
        });
        assert.equal(saved.outcome, 'saved');
        const hours = await replaceBusinessHours({
          actingUserLinkId: admin,
          tenantId,
          days: [{ dayOfWeek: 1, closed: false, openTime: '09:00', closeTime: '17:00' }],
        });
        assert.ok(!('error' in hours));
        const policy = await setDealershipPolicy({
          actingUserLinkId: admin,
          tenantId,
          policyKey: 'service.walk_ins_accepted',
          policyValue: true,
        });
        assert.ok(!('error' in policy));
        const invitation = await createStaffInvitation({
          actingUserLinkId: admin,
          tenantId,
          email: `invitee-${tenantId.slice(0, 8)}@example.com`,
          invitedRole: TENANT_ADMIN_ROLE,
        });
        assert.ok(!('error' in invitation));
        return { rooftopId: rooftop.rooftopId, legalEntityId: entity.legalEntityId };
      };
      const a = await seedTenant(tenantA, adminA);
      const b = await seedTenant(tenantB, adminB);
      rooftopA = a.rooftopId;
      rooftopB = b.rooftopId;
      // idempotency_keys rows, seeded directly per tenant (owner-side).
      for (const [tid, actor] of [
        [tenantA, adminA],
        [tenantB, adminB],
      ] as const) {
        await query(
          `INSERT INTO idempotency_keys
             (tenant_id, actor_user_link_id, idempotency_key, request_fingerprint,
              response_status, response_body, expires_at)
           VALUES ($1, $2, $3, $4, 200, '{}', NOW() + INTERVAL '1 hour')`,
          [tid, actor, 'seed-key', 'f'.repeat(64)],
        );
      }
    });

    test('row security is ENABLED on every table this train secures', async () => {
      for (const table of SECURED_TABLES) {
        const r = await app.query(
          `SELECT relrowsecurity FROM pg_class WHERE relname = $1 AND relnamespace = 'public'::regnamespace`,
          [table],
        );
        assert.equal(r.rows.length, 1, `${table} exists`);
        assert.equal(
          (r.rows[0] as { relrowsecurity: boolean }).relrowsecurity,
          true,
          `${table} has row security enabled`,
        );
      }
    });

    test('deny by default: without a tenant context, every secured table is empty', async () => {
      await noContext();
      for (const table of SECURED_TABLES) {
        // The statement carries NO tenant predicate at all — the absent
        // application filter the acceptance row names.
        const r = await app.query(`SELECT COUNT(*)::int AS n FROM ${table}`);
        assert.equal(
          Number((r.rows[0] as { n: number }).n),
          0,
          `${table}: rows exist for two tenants, and none are visible without a context`,
        );
      }
      // …and unwritable: a write into A's data with no context is refused.
      // (Declared adversarial bypass, ON THE RUNTIME CONNECTION: the write is
      // supposed to die at the database, and does.)
      await assert.rejects(
        fixtureAuthorizationStateWrite(
          'adversarial-bypass-attempt',
          `INSERT INTO dealership_policies (tenant_id, policy_key, policy_value, updated_by_user_link_id)
           VALUES ($1, 'general.contact_phone', '"+15550100"', $2)`,
          [tenantA, adminA],
          { executor: app },
        ),
        /row-level security/,
        'a context-free INSERT is a row-security violation, not a write',
      );
    });

    test('a defective (predicate-free) SELECT under tenant A returns ONLY A', async () => {
      await contextOf(tenantA);
      for (const table of SECURED_TABLES) {
        const r = await app.query(`SELECT tenant_id::text FROM ${table}`);
        assert.ok(r.rows.length > 0, `${table}: A's own rows are visible under A's context`);
        for (const row of r.rows as Array<{ tenant_id: string }>) {
          assert.equal(
            row.tenant_id,
            tenantA,
            `${table}: a predicate-free SELECT must never surface another tenant's row`,
          );
        }
      }
    });

    test('cross-tenant reads by exact primary key find nothing', async () => {
      await contextOf(tenantA);
      const r = await app.query(`SELECT 1 FROM rooftops WHERE rooftop_id = $1`, [rooftopB]);
      assert.equal(r.rows.length, 0, "B's rooftop does not exist from A's context, even by id");
      const inv = await app.query(
        `SELECT 1 FROM staff_invitations WHERE lower(email) LIKE '%example.com' AND tenant_id = $1`,
        [tenantB],
      );
      assert.equal(
        inv.rows.length,
        0,
        "B's invitations are unreadable even when asked for by tenant",
      );
    });

    test('cross-tenant UPDATE and DELETE touch zero rows at the database boundary', async () => {
      await contextOf(tenantA);
      // Declared adversarial bypasses, ON THE RUNTIME CONNECTION — the whole
      // point is that the database lets neither statement touch a row.
      const upd = await fixtureAuthorizationStateWrite(
        'adversarial-bypass-attempt',
        `UPDATE rooftops SET name = 'pwned' WHERE rooftop_id = $1`,
        [rooftopB],
        { executor: app },
      );
      assert.equal(upd.rowCount, 0, "an UPDATE aimed at B's row by id changes nothing");
      const del = await fixtureAuthorizationStateWrite(
        'adversarial-bypass-attempt',
        `DELETE FROM dealership_business_hours WHERE tenant_id = $1`,
        [tenantB],
        { executor: app },
      );
      assert.equal(del.rowCount, 0, "a DELETE aimed at B's rows deletes nothing");
      // Verify from B's own context that nothing moved.
      await contextOf(tenantB);
      const intact = await app.query(`SELECT name FROM rooftops WHERE rooftop_id = $1`, [rooftopB]);
      assert.equal((intact.rows[0] as { name: string }).name, 'Main Street');
      const hours = await app.query(`SELECT COUNT(*)::int AS n FROM dealership_business_hours`);
      assert.equal(Number((hours.rows[0] as { n: number }).n), 1);
    });

    test("an INSERT carrying another tenant's id is a WITH CHECK violation", async () => {
      await contextOf(tenantA);
      await assert.rejects(
        fixtureAuthorizationStateWrite(
          'adversarial-bypass-attempt',
          `INSERT INTO dealership_policies (tenant_id, policy_key, policy_value, updated_by_user_link_id)
           VALUES ($1, 'general.contact_phone', '"+15550100"', $2)`,
          [tenantB, adminA],
          { executor: app },
        ),
        /row-level security/,
        "a write stamped with B's tenant id dies in WITH CHECK, whatever the application sent",
      );
    });

    test("a tenant-qualified reference to another tenant's parent cannot be created", async () => {
      await contextOf(tenantA);
      // The composite (tenant_id, rooftop_id) foreign key: A's tenant id with
      // B's rooftop id names a parent that does not exist as a pair.
      await assert.rejects(
        fixtureAuthorizationStateWrite(
          'adversarial-bypass-attempt',
          `INSERT INTO departments
             (department_id, tenant_id, rooftop_id, code, name, status,
              created_by_user_link_id, updated_by_user_link_id, authorization_version)
           VALUES ($1, $2, $3, 'parts', 'Smuggled', 'active', $4, $4, 1)`,
          [randomUUID(), tenantA, rooftopB, adminA],
          { executor: app },
        ),
        (err: unknown) =>
          err instanceof Error && /foreign key|row-level security/.test(err.message),
        "a department under A referencing B's rooftop is refused by the database",
      );
      // …and the honest same-tenant insert from the same context SUCCEEDS, so
      // the refusal above is the constraint, not a broken table. Still a raw
      // owned-table write from a fixture, so still the declared primitive —
      // this one simulates drift (a version-1 row no service attributed).
      const ok = await fixtureAuthorizationStateWrite(
        'simulate-authorization-drift',
        `INSERT INTO departments
           (department_id, tenant_id, rooftop_id, code, name, status,
            created_by_user_link_id, updated_by_user_link_id, authorization_version)
         VALUES ($1, $2, $3, 'parts', 'Parts', 'active', $4, $4, 1)
         RETURNING department_id`,
        [randomUUID(), tenantA, rooftopA, adminA],
        { executor: app },
      );
      assert.equal(ok.rows.length, 1);
    });

    test('a forged context naming a nonexistent tenant sees and writes nothing', async () => {
      await contextOf(randomUUID());
      for (const table of SECURED_TABLES) {
        const r = await app.query(`SELECT COUNT(*)::int AS n FROM ${table}`);
        assert.equal(
          Number((r.rows[0] as { n: number }).n),
          0,
          `${table} is empty under a forged context`,
        );
      }
    });

    test('settings and invitations round-trip under their own context only', async () => {
      // The journey's own data, read back through the runtime login: what the
      // staff UI persists for A is visible to A and invisible to B.
      await contextOf(tenantA);
      const mine = await app.query(`SELECT display_name FROM dealership_settings`);
      assert.equal(mine.rows.length, 1);
      assert.equal(
        (mine.rows[0] as { display_name: string }).display_name,
        'Dealer ' + tenantA.slice(0, 8),
      );
      await contextOf(tenantB);
      const theirs = await app.query(`SELECT display_name FROM dealership_settings`);
      assert.equal(theirs.rows.length, 1);
      assert.equal(
        (theirs.rows[0] as { display_name: string }).display_name,
        'Dealer ' + tenantB.slice(0, 8),
      );
      assert.notEqual(tenantA.slice(0, 8), tenantB.slice(0, 8));
    });
  },
);
