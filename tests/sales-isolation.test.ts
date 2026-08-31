import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Client } from 'pg';
import {
  fixtureAuthorizationStateWrite,
  resetDatabase,
  seedActor,
  seedDealerGroup,
  seedLegalEntity,
  seedRooftop,
  seedTenantIdentity,
  skipIntegration,
  startIdentityTestEnv,
  type IdentityTestEnv,
} from '@dealer/test-kit';
import { closePool } from '@dealer/database';
import { ROLES } from '@dealer/contracts';
import { acquireStock } from '@dealer/inventory';
import { captureLead, defineLeadSource, handOffLead, transitionLead } from '@dealer/crm';
import {
  joinFloor,
  receiveHandoff,
  recordArrival,
  shortlistVehicle,
  startDemonstration,
} from '@dealer/sales';

/**
 * RELEASE TRAIN 4 — TENANT AND ROOFTOP INTEGRITY AT THE DATABASE BOUNDARY.
 *
 * `tests/sales-authority.test.ts` proves the boundary through the HTTP stack,
 * which is where a person meets it. This battery proves it one layer down,
 * where an attacker would be:
 *
 *   * THROUGH A GENUINE `dealership_app` CONNECTION, with the attacking
 *     statements written WITHOUT tenant predicates. A proof made on the pooled
 *     owner connection would be worthless, because migration 064 deliberately
 *     does not FORCE row security and the owner bypasses it — which is exactly
 *     what lets the test harness set fixtures up in the first place.
 *   * AT THE RESOLVER, where Release Train 2's privilege split must still hold
 *     for the three resource types this train adds: the row-security-bypassing
 *     registry is not executable by the runtime AT ALL, and the ordinary lookup
 *     answers only about the session's own dealership.
 */
describe(
  'sales: tenant and rooftop integrity at the database boundary (RT4)',
  { skip: skipIntegration ? 'set TEST_DATABASE_URL to run' : false },
  () => {
    const OWNER_URL = process.env.TEST_DATABASE_URL as string;
    const APP_PASSWORD = 'rt4_isolation_test_pw';
    let app: Client;
    let env: IdentityTestEnv;

    /** Every table migration 064 secures. */
    const SECURED_TABLES = [
      'opportunities',
      'opportunity_stage_events',
      'opportunity_assignments',
      'floor_rotations',
      'showroom_visits',
      'visit_events',
      'opportunity_vehicles',
      'demonstrations',
      'opportunity_activities',
      'negotiation_rounds',
      'manager_turnovers',
    ] as const;

    interface Dealership {
      tenantId: string;
      rooftopA: string;
      rooftopB: string;
      opportunityId: string;
      visitId: string;
      demonstrationId: string;
      stockItemId: string;
      partyId: string;
      admin: string;
    }

    let alpha: Dealership;
    let beta: Dealership;

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
      env = await startIdentityTestEnv();
    });

    after(async () => {
      await app.end();
      await env.stop();
      await closePool();
    });

    async function noContext(): Promise<void> {
      await app.query(`SELECT set_config('app.tenant_id', '', false)`);
    }

    async function contextOf(tenantId: string): Promise<void> {
      await app.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenantId]);
    }

    /**
     * A whole dealership with a live deal on the floor, built entirely through
     * the services that own each row — RT2's inventory, RT3's CRM, RT4's own.
     * Nothing here is planted, so nothing here can drift from the schema.
     */
    async function seedDealership(name: string, vin: string): Promise<Dealership> {
      const tenantId = randomUUID();
      await seedTenantIdentity(tenantId, name);
      const group = await seedDealerGroup({ tenantId, name: `${name} Group`, status: 'active' });
      const entity = await seedLegalEntity({
        tenantId,
        dealerGroupId: group.dealerGroupId,
        name: `${name} LLC`,
        status: 'active',
      });
      const a = await seedRooftop({
        tenantId,
        legalEntityId: entity.legalEntityId,
        name: `${name} North`,
        status: 'active',
      });
      const b = await seedRooftop({
        tenantId,
        legalEntityId: entity.legalEntityId,
        name: `${name} South`,
        status: 'active',
      });
      // A REAL SALESPERSON, not the bootstrap administrator. That link is the
      // GRANTOR — it holds no role bindings of its own — so it reaches no
      // rooftop, and the services this battery drives now say so. Building the
      // world through somebody who actually works here is both what the
      // services require and a truer fixture.
      const staff = await seedActor(env.issuer, {
        tenantId,
        roles: [ROLES.SALES_MANAGER, ROLES.SALESPERSON, ROLES.BDC_AGENT, ROLES.INVENTORY_MANAGER],
      });
      const admin = staff.userLinkId;

      const source = await defineLeadSource({
        actingUserLinkId: admin,
        tenantId,
        sourceCode: 'walk_in',
        displayName: 'Walk in',
        channel: 'walk_in',
        medium: 'direct',
      });
      assert.equal(source.outcome, 'saved', JSON.stringify(source));

      const captured = await captureLead({
        actingUserLinkId: admin,
        tenantId,
        rooftopId: a.rooftopId,
        intakeKey: `${name}-1`,
        channel: 'manual',
        sourceCode: 'walk_in',
        party: { givenName: name, familyName: 'Buyer', email: `${name.toLowerCase()}@x.com` },
      });
      assert.equal(captured.outcome, 'created', `${name}: ${JSON.stringify(captured)}`);
      const lead = (captured as { lead: { leadId: string; authorizationVersion: number } }).lead;
      const partyId = (captured as { partyId: string }).partyId;

      let version = lead.authorizationVersion;
      for (const state of ['working', 'qualified'] as const) {
        const moved = await transitionLead({
          actingUserLinkId: admin,
          tenantId,
          leadId: lead.leadId,
          toState: state,
          expectedVersion: version,
        });
        assert.equal(moved.outcome, 'moved', JSON.stringify(moved));
        version = (moved as { lead: { authorizationVersion: number } }).lead.authorizationVersion;
      }
      const handed = await handOffLead({
        actingUserLinkId: admin,
        tenantId,
        leadId: lead.leadId,
        expectedVersion: version,
        handedToUserLinkId: admin,
      });
      assert.equal(handed.outcome, 'handed_off', JSON.stringify(handed));

      const received = await receiveHandoff({
        actingUserLinkId: admin,
        tenantId,
        handoffId: (handed as { handoffId: string }).handoffId,
      });
      assert.equal(received.outcome, 'received', JSON.stringify(received));
      const opportunityId = (received as { opportunity: { opportunityId: string } }).opportunity
        .opportunityId;

      const acquired = await acquireStock({
        actingUserLinkId: admin,
        tenantId,
        rooftopId: a.rooftopId,
        vin,
        stockNumber: vin.slice(-6),
        acquisitionSource: 'trade_in',
        acquiredOn: '2026-08-01',
        referenceYear: 2022,
        newParty: { partyType: 'person', details: { givenName: 'Trade', familyName: name } },
      });
      assert.equal(acquired.outcome, 'acquired', JSON.stringify(acquired));
      const stockItemId = (acquired as { stockItem: { stockItemId: string } }).stockItem
        .stockItemId;

      const shortlisted = await shortlistVehicle({
        actingUserLinkId: admin,
        tenantId,
        opportunityId,
        stockItemId,
      });
      assert.equal(shortlisted.outcome, 'added', JSON.stringify(shortlisted));

      await joinFloor({
        actingUserLinkId: admin,
        tenantId,
        rooftopId: a.rooftopId,
        userLinkId: admin,
      });
      const arrived = await recordArrival({
        actingUserLinkId: admin,
        tenantId,
        rooftopId: a.rooftopId,
        partyId,
        opportunityId,
        appointmentId: null,
      });
      assert.equal(arrived.outcome, 'arrived', JSON.stringify(arrived));

      const drive = await startDemonstration({
        actingUserLinkId: admin,
        tenantId,
        opportunityId,
        stockItemId,
        driverPartyId: partyId,
        licenceVerified: true,
        visitId: (arrived as { visit: { visitId: string } }).visit.visitId,
      });
      assert.equal(drive.outcome, 'started', JSON.stringify(drive));

      return {
        tenantId,
        rooftopA: a.rooftopId,
        rooftopB: b.rooftopId,
        opportunityId,
        visitId: (arrived as { visit: { visitId: string } }).visit.visitId,
        demonstrationId: (drive as { demonstration: { demonstrationId: string } }).demonstration
          .demonstrationId,
        stockItemId,
        partyId,
        admin,
      };
    }

    beforeEach(async () => {
      await resetDatabase();
      await noContext();
      alpha = await seedDealership('Alpha', '1HGCM82633A004352');
      beta = await seedDealership('Beta', '2HGCM82633A004353');
    });

    // ── the database boundary ────────────────────────────────────────────────

    test('row security is enabled, with a policy, on every table this train adds', async () => {
      for (const table of SECURED_TABLES) {
        const r = await app.query(
          `SELECT c.relrowsecurity,
                  (SELECT COUNT(*)::int FROM pg_policies p
                    WHERE p.schemaname = 'public' AND p.tablename = $1) AS policies
             FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relname = $1 AND n.nspname = 'public'`,
          [table],
        );
        assert.equal(r.rows.length, 1, `${table} exists`);
        const row = r.rows[0] as { relrowsecurity: boolean; policies: number };
        assert.equal(row.relrowsecurity, true, `${table} has row security enabled`);
        assert.ok(Number(row.policies) >= 1, `${table} carries a policy`);
      }
    });

    test('deny by default: with no tenant context every secured table is empty', async () => {
      await noContext();
      for (const table of SECURED_TABLES) {
        // No tenant predicate at all — the absent application filter.
        const r = await app.query(`SELECT COUNT(*)::int AS n FROM ${table}`);
        assert.equal(
          Number((r.rows[0] as { n: number }).n),
          0,
          `${table}: two dealerships hold rows, and none are visible without a context`,
        );
      }
      await assert.rejects(
        fixtureAuthorizationStateWrite(
          'adversarial-bypass-attempt',
          `INSERT INTO floor_rotations (tenant_id, rooftop_id, user_link_id, position,
                                        created_by_user_link_id, updated_by_user_link_id)
           VALUES ($1, $2, $3, 99, $3, $3)`,
          [alpha.tenantId, alpha.rooftopA, alpha.admin],
          { executor: app },
        ),
        /row-level security/,
        'a context-free INSERT is a row-security violation, not a write',
      );
    });

    test('a predicate-free read under one dealership returns only its own rows', async () => {
      await contextOf(alpha.tenantId);
      for (const table of SECURED_TABLES) {
        const r = await app.query(`SELECT tenant_id::text FROM ${table}`);
        for (const row of r.rows as Array<{ tenant_id: string }>) {
          assert.equal(
            row.tenant_id,
            alpha.tenantId,
            `${table}: a predicate-free SELECT surfaced another dealership's row`,
          );
        }
      }
      const own = await app.query(`SELECT COUNT(*)::int AS n FROM opportunities`);
      assert.equal(
        Number((own.rows[0] as { n: number }).n),
        1,
        'CONTROL: its own opportunity is visible',
      );
    });

    test('cross-dealership reads by exact identifier find nothing', async () => {
      await contextOf(alpha.tenantId);
      for (const [table, column, id] of [
        ['opportunities', 'opportunity_id', beta.opportunityId],
        ['showroom_visits', 'visit_id', beta.visitId],
        ['demonstrations', 'demonstration_id', beta.demonstrationId],
      ] as const) {
        const r = await app.query(`SELECT 1 FROM ${table} WHERE ${column} = $1`, [id]);
        assert.equal(r.rows.length, 0, `${table}: another dealership's row is not readable by id`);
      }
    });

    test('cross-dealership writes touch zero rows and refuse at WITH CHECK', async () => {
      await contextOf(alpha.tenantId);
      const upd = await fixtureAuthorizationStateWrite(
        'adversarial-bypass-attempt',
        `UPDATE opportunities SET stage = 'lost', disposition = 'lost_no_decision'
          WHERE opportunity_id = $1`,
        [beta.opportunityId],
        { executor: app },
      );
      assert.equal(
        upd.rowCount,
        0,
        "an UPDATE aimed at another dealership's opportunity changes nothing",
      );

      await assert.rejects(
        fixtureAuthorizationStateWrite(
          'adversarial-bypass-attempt',
          `INSERT INTO floor_rotations (tenant_id, rooftop_id, user_link_id, position,
                                        created_by_user_link_id, updated_by_user_link_id)
           VALUES ($1, $2, $3, 99, $4, $4)`,
          [beta.tenantId, beta.rooftopA, beta.admin, alpha.admin],
          { executor: app },
        ),
        /row-level security/,
        "a write stamped with another dealership's id dies in WITH CHECK",
      );

      // NOTHING MOVED, read back from the other dealership's own context. The
      // attacking UPDATE tried to lose this deal; the seed left it at
      // `received`, and that is exactly where it still is.
      await contextOf(beta.tenantId);
      const intact = await app.query(`SELECT stage FROM opportunities`);
      assert.equal(
        (intact.rows[0] as { stage: string }).stage,
        'received',
        'the refused cross-dealership write changed nothing',
      );
    });

    test("a tenant-qualified reference to another dealership's parent cannot be created", async () => {
      await contextOf(alpha.tenantId);
      // Alpha's tenant id with Beta's opportunity: the composite foreign key
      // names a pair that does not exist.
      await assert.rejects(
        fixtureAuthorizationStateWrite(
          'adversarial-bypass-attempt',
          `INSERT INTO opportunity_activities
             (tenant_id, opportunity_id, kind, subject,
              created_by_user_link_id, updated_by_user_link_id)
           VALUES ($1, $2, 'note', 'Planted', $3, $3)`,
          [alpha.tenantId, beta.opportunityId, alpha.admin],
          { executor: app },
        ),
        (err: unknown) =>
          err instanceof Error && /foreign key|row-level security/.test(err.message),
        "an activity under Alpha referencing Beta's opportunity is refused by the database",
      );

      // CONTROL: the honest same-dealership write from the same context works.
      const ok = await fixtureAuthorizationStateWrite(
        'simulate-authorization-drift',
        `INSERT INTO opportunity_activities
           (tenant_id, opportunity_id, kind, subject,
            created_by_user_link_id, updated_by_user_link_id)
         VALUES ($1, $2, 'note', 'Honest', $3, $3) RETURNING activity_id`,
        [alpha.tenantId, alpha.opportunityId, alpha.admin],
        { executor: app },
      );
      assert.equal(ok.rows.length, 1);
    });

    test('a forged context naming no real dealership sees nothing', async () => {
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

    // ── the resolver, for the three types this train registers ───────────────

    test('the bypass resolver refuses the runtime for the three types RT4 adds', async () => {
      // Release Train 2's correction must keep holding for every type added
      // since: the row-security-bypassing registry is a PRIVILEGE the runtime
      // does not hold, so NO session state reaches it — which is why the
      // arrangement is varied rather than assumed.
      for (const arrange of [
        () => contextOf(alpha.tenantId),
        () => contextOf(beta.tenantId),
        () => noContext(),
      ]) {
        await arrange();
        for (const [type, id] of [
          ['opportunity', beta.opportunityId],
          ['showroom_visit', beta.visitId],
          ['demonstration', beta.demonstrationId],
        ] as const) {
          await assert.rejects(
            app.query(`SELECT resource_org_leaf($1, $2, $3)`, [beta.tenantId, type, id]),
            /permission denied/i,
            `${type}: the bypass resolver answered the runtime`,
          );
        }
      }
      await contextOf(alpha.tenantId);
    });

    test('the ordinary lookup resolves this session’s own resources and nothing else', async () => {
      await contextOf(alpha.tenantId);
      const leaf = async (type: string, id: string): Promise<string | null> => {
        const r = await app.query(`SELECT resource_org_leaf_visible($1, $2) AS leaf`, [type, id]);
        const v = (r.rows[0] as { leaf: string | null }).leaf;
        return v === null ? null : String(v);
      };
      // CONTROL FIRST: the engine can still resolve what it is authorizing.
      assert.equal(await leaf('opportunity', alpha.opportunityId), alpha.rooftopA);
      assert.equal(await leaf('showroom_visit', alpha.visitId), alpha.rooftopA);
      assert.equal(await leaf('demonstration', alpha.demonstrationId), alpha.rooftopA);

      // …and Beta's identifiers resolve to nothing for an Alpha-bound session.
      assert.equal(await leaf('opportunity', beta.opportunityId), null);
      assert.equal(await leaf('showroom_visit', beta.visitId), null);
      assert.equal(await leaf('demonstration', beta.demonstrationId), null);

      // The refusal is a refusal, not an absence: bound to Beta, they resolve.
      await contextOf(beta.tenantId);
      assert.equal(await leaf('opportunity', beta.opportunityId), beta.rooftopA);
      assert.equal(await leaf('demonstration', beta.demonstrationId), beta.rooftopA);

      // An unbound session resolves nothing at all.
      await noContext();
      assert.equal(await leaf('opportunity', alpha.opportunityId), null);
      assert.equal(await leaf('demonstration', beta.demonstrationId), null);
    });
  },
);
