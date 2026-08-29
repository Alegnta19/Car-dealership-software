import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Client } from 'pg';
import {
  bootstrapAdministrator,
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
import { captureLead, defineLeadSource, scheduleAppointment, createCampaign } from '@dealer/crm';
import { createApp, resetAuthRoutesForTests, resetIdentityCompositionForTests } from '@dealer/api';

/**
 * RELEASE TRAIN 3, ROW 6 — TENANT AND ROOFTOP INTEGRITY.
 *
 * The row asks for three guarantees and this battery proves them separately,
 * because passing one says nothing about the others:
 *
 *   * AT THE DATABASE BOUNDARY, through a genuine `dealership_app` connection,
 *     with the attacking statements written WITHOUT tenant predicates. A proof
 *     made on the pooled owner connection would be worthless, because migration
 *     063 deliberately does not FORCE row security and the owner bypasses it.
 *   * AT THE RESOLVER, where Release Train 2's correction must still hold for
 *     the three resource types this train adds: the row-security-bypassing
 *     registry is not executable by the runtime at all, and the ordinary lookup
 *     answers only about the session's own tenant.
 *   * AT THE ROOFTOP, through the real HTTP stack, where an employee bound to
 *     one store must be unable to touch another store's lead and must not learn
 *     that it exists.
 */
describe(
  'crm: tenant and rooftop integrity (RT3 row 6)',
  { skip: skipIntegration ? 'set TEST_DATABASE_URL to run' : false },
  () => {
    const OWNER_URL = process.env.TEST_DATABASE_URL as string;
    const APP_PASSWORD = 'rt3_isolation_test_pw';
    let app: Client;
    let server: Server;
    let base: string;
    let env: IdentityTestEnv;

    /** Every table migration 063 secures. */
    const SECURED_TABLES = [
      'lead_sources',
      'leads',
      'lead_intakes',
      'lead_source_touches',
      'lead_queues',
      'lead_assignments',
      'lead_status_events',
      'lead_sla_policies',
      'lead_escalations',
      'lead_handoffs',
      'lead_activities',
      'appointments',
      'appointment_events',
      'party_purpose_consents',
      'contact_suppressions',
      'campaigns',
      'campaign_versions',
      'campaign_templates',
      'campaign_audience_members',
      'campaign_sends',
      'campaign_send_events',
      'campaign_responses',
      'attribution_runs',
      'lead_attributions',
    ] as const;

    interface Dealership {
      tenantId: string;
      rooftopA: string;
      rooftopB: string;
      leadId: string;
      appointmentId: string;
      campaignId: string;
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
      resetIdentityCompositionForTests();
      resetAuthRoutesForTests();
      server = createApp().listen(0);
      await new Promise<void>((resolve) => server.once('listening', () => resolve()));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    after(async () => {
      await app.end();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await env.stop();
      await closePool();
    });

    async function noContext(): Promise<void> {
      await app.query(`SELECT set_config('app.tenant_id', '', false)`);
    }

    async function contextOf(tenantId: string): Promise<void> {
      await app.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenantId]);
    }

    async function seedDealership(name: string): Promise<Dealership> {
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
      const admin = await bootstrapAdministrator(tenantId);
      const source = await defineLeadSource({
        actingUserLinkId: admin,
        tenantId,
        sourceCode: 'website',
        displayName: 'Website',
        channel: 'web',
        medium: 'organic',
      });
      assert.equal(source.outcome, 'saved');
      const captured = await captureLead({
        actingUserLinkId: admin,
        tenantId,
        rooftopId: a.rooftopId,
        intakeKey: `${name}-1`,
        channel: 'website',
        sourceCode: 'website',
        party: { givenName: name, familyName: 'Customer', email: `${name.toLowerCase()}@x.com` },
      });
      assert.equal(captured.outcome, 'created', `${name}: ${JSON.stringify(captured)}`);
      const leadId = (captured as { lead: { leadId: string } }).lead.leadId;
      const partyId = (captured as { partyId: string }).partyId;

      const appointment = await scheduleAppointment({
        actingUserLinkId: admin,
        tenantId,
        leadId,
        purpose: 'consultation',
        startsAt: new Date(Date.now() + 86_400_000).toISOString(),
        endsAt: new Date(Date.now() + 90_000_000).toISOString(),
      });
      assert.equal(appointment.outcome, 'scheduled', JSON.stringify(appointment));

      const campaign = await createCampaign({
        actingUserLinkId: admin,
        tenantId,
        rooftopId: a.rooftopId,
        name: `${name} Spring`,
        channel: 'email',
        purpose: 'sales_marketing',
        sourceCode: 'website',
      });
      assert.equal(campaign.outcome, 'created', JSON.stringify(campaign));

      return {
        tenantId,
        rooftopA: a.rooftopId,
        rooftopB: b.rooftopId,
        leadId,
        appointmentId: (appointment as { appointment: { appointmentId: string } }).appointment
          .appointmentId,
        campaignId: (campaign as { campaign: { campaignId: string } }).campaign.campaignId,
        partyId,
        admin,
      };
    }

    beforeEach(async () => {
      await resetDatabase();
      await noContext();
      alpha = await seedDealership('Alpha');
      beta = await seedDealership('Beta');
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
          `INSERT INTO lead_queues (tenant_id, rooftop_id, name, created_by_user_link_id,
                                    updated_by_user_link_id)
           VALUES ($1, $2, 'Ghost', $3, $3)`,
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
      const own = await app.query(`SELECT COUNT(*)::int AS n FROM leads`);
      assert.equal(Number((own.rows[0] as { n: number }).n), 1, 'CONTROL: its own lead is visible');
    });

    test('cross-dealership reads by exact identifier find nothing', async () => {
      await contextOf(alpha.tenantId);
      for (const [table, column, id] of [
        ['leads', 'lead_id', beta.leadId],
        ['appointments', 'appointment_id', beta.appointmentId],
        ['campaigns', 'campaign_id', beta.campaignId],
      ] as const) {
        const r = await app.query(`SELECT 1 FROM ${table} WHERE ${column} = $1`, [id]);
        assert.equal(r.rows.length, 0, `${table}: another dealership's row is not readable by id`);
      }
    });

    test('cross-dealership writes touch zero rows and refuse at WITH CHECK', async () => {
      await contextOf(alpha.tenantId);
      const upd = await fixtureAuthorizationStateWrite(
        'adversarial-bypass-attempt',
        `UPDATE leads SET lifecycle_state = 'closed' WHERE lead_id = $1`,
        [beta.leadId],
        { executor: app },
      );
      assert.equal(upd.rowCount, 0, "an UPDATE aimed at another dealership's lead changes nothing");

      await assert.rejects(
        fixtureAuthorizationStateWrite(
          'adversarial-bypass-attempt',
          `INSERT INTO lead_queues (tenant_id, rooftop_id, name, created_by_user_link_id,
                                    updated_by_user_link_id)
           VALUES ($1, $2, 'Planted', $3, $3)`,
          [beta.tenantId, beta.rooftopA, alpha.admin],
          { executor: app },
        ),
        /row-level security/,
        "a write stamped with another dealership's id dies in WITH CHECK",
      );

      // NOTHING MOVED, read back from the other dealership's own context. The
      // attacking UPDATE tried to close this lead; the seed left it at
      // `appointment_set`, and that is exactly where it still is.
      await contextOf(beta.tenantId);
      const intact = await app.query(`SELECT lifecycle_state FROM leads`);
      assert.equal(
        (intact.rows[0] as { lifecycle_state: string }).lifecycle_state,
        'appointment_set',
        'the refused cross-dealership write changed nothing',
      );
    });

    test("a tenant-qualified reference to another dealership's parent cannot be created", async () => {
      await contextOf(alpha.tenantId);
      // Alpha's tenant id with Beta's lead: the composite foreign key names a
      // pair that does not exist.
      await assert.rejects(
        fixtureAuthorizationStateWrite(
          'adversarial-bypass-attempt',
          `INSERT INTO lead_activities
             (tenant_id, lead_id, kind, subject, created_by_user_link_id, updated_by_user_link_id)
           VALUES ($1, $2, 'note', 'Planted', $3, $3)`,
          [alpha.tenantId, beta.leadId, alpha.admin],
          { executor: app },
        ),
        (err: unknown) =>
          err instanceof Error && /foreign key|row-level security/.test(err.message),
        "an activity under Alpha referencing Beta's lead is refused by the database",
      );

      // CONTROL: the honest same-dealership write from the same context works.
      const ok = await fixtureAuthorizationStateWrite(
        'simulate-authorization-drift',
        `INSERT INTO lead_activities
           (tenant_id, lead_id, kind, subject, created_by_user_link_id, updated_by_user_link_id)
         VALUES ($1, $2, 'note', 'Honest', $3, $3) RETURNING activity_id`,
        [alpha.tenantId, alpha.leadId, alpha.admin],
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

    test('the bypass resolver refuses the runtime for a lead, an appointment and a campaign', async () => {
      // Release Train 2's correction must keep holding for the types Release
      // Train 3 adds: the row-security-bypassing registry is a PRIVILEGE the
      // runtime does not hold, so no session state reaches it.
      for (const arrange of [
        () => contextOf(alpha.tenantId),
        () => contextOf(beta.tenantId),
        () => noContext(),
      ]) {
        await arrange();
        for (const [type, id] of [
          ['lead', beta.leadId],
          ['appointment', beta.appointmentId],
          ['campaign', beta.campaignId],
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
      assert.equal(await leaf('lead', alpha.leadId), alpha.rooftopA);
      assert.equal(await leaf('appointment', alpha.appointmentId), alpha.rooftopA);
      assert.equal(await leaf('campaign', alpha.campaignId), alpha.rooftopA);

      // …and Beta's identifiers resolve to nothing for an Alpha-bound session.
      assert.equal(await leaf('lead', beta.leadId), null);
      assert.equal(await leaf('appointment', beta.appointmentId), null);
      assert.equal(await leaf('campaign', beta.campaignId), null);

      // The refusal is a refusal, not an absence: bound to Beta, they resolve.
      await contextOf(beta.tenantId);
      assert.equal(await leaf('lead', beta.leadId), beta.rooftopA);

      // An unbound session resolves nothing at all.
      await noContext();
      assert.equal(await leaf('lead', alpha.leadId), null);
      assert.equal(await leaf('campaign', beta.campaignId), null);
    });

    // ── the rooftop boundary, through the real HTTP stack ────────────────────

    test('a rooftop-bound employee cannot reach another rooftop’s lead, and is not told it exists', async () => {
      // A second lead in ONE dealership, at the other rooftop.
      const south = await captureLead({
        actingUserLinkId: alpha.admin,
        tenantId: alpha.tenantId,
        rooftopId: alpha.rooftopB,
        intakeKey: 'south-1',
        channel: 'manual',
        sourceCode: 'website',
        party: { givenName: 'South', familyName: 'Shopper', email: 'south@x.com' },
      });
      assert.equal(south.outcome, 'created');
      const southLead = (south as { lead: { leadId: string } }).lead.leadId;

      // An employee bound at the NORTH rooftop only.
      const north = await seedActor(env.issuer, {
        tenantId: alpha.tenantId,
        roles: [ROLES.BDC_AGENT],
        scope: { level: 'rooftop', id: alpha.rooftopA },
      });

      const callAs = async (method: string, path: string, payload?: unknown) => {
        const res = await fetch(base + path, {
          method,
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${north.token}`,
            'idempotency-key': randomUUID(),
          },
          ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        });
        const text = await res.text();
        return { status: res.status, body: text ? JSON.parse(text) : null };
      };

      // CONTROL FIRST: their own rooftop's lead is readable.
      const own = await callAs('GET', `/api/crm/leads/${alpha.leadId}`);
      assert.equal(own.status, 200, 'CONTROL: the north employee reads the north lead');

      // …and the south lead is NOT FOUND rather than forbidden.
      const other = await callAs('GET', `/api/crm/leads/${southLead}`);
      assert.equal(other.status, 404, 'the south lead does not exist for the north employee');

      const logged = await callAs('POST', `/api/crm/leads/${southLead}/activities`, {
        kind: 'note',
        subject: 'Prying',
      });
      assert.equal(logged.status, 404, 'nor can they work it');

      // A lead in ANOTHER dealership entirely is equally invisible.
      const foreign = await callAs('GET', `/api/crm/leads/${beta.leadId}`);
      assert.equal(foreign.status, 404);

      // …and the work list they DO get is scoped to the rooftop they hold.
      //
      // A rooftop-bound employee names their rooftop, which is what lets a
      // tenant-scoped read authorize at all: the middleware turns
      // `location_id` into the engine's scope hint, and the read returns
      // exactly the rows that hint authorized. Asking without one is refused,
      // because a rooftop binding does not reach the whole dealership.
      const unscoped = await callAs('GET', '/api/crm/leads');
      assert.equal(unscoped.status, 403, 'a rooftop binding does not reach the whole tenant');

      const list = await callAs('GET', `/api/crm/leads?location_id=${alpha.rooftopA}`);
      assert.equal(list.status, 200);
      const ids = (list.body.leads as Array<{ leadId: string }>).map((l) => l.leadId);
      assert.deepEqual(ids, [alpha.leadId], 'one rooftop, one lead');

      const overview = await callAs('GET', `/api/crm/overview?location_id=${alpha.rooftopA}`);
      assert.equal(overview.status, 200);
      assert.equal(overview.body.leads.open, 1, 'the counts are the permitted rooftops’ counts');
      assert.deepEqual(
        (overview.body.rooftops as Array<{ rooftopId: string }>).map((r) => r.rooftopId),
        [alpha.rooftopA],
      );
    });

    test('a lead may not be captured into a rooftop the employee does not hold', async () => {
      const north = await seedActor(env.issuer, {
        tenantId: alpha.tenantId,
        roles: [ROLES.BDC_AGENT],
        scope: { level: 'rooftop', id: alpha.rooftopA },
      });
      const capture = async (rooftopId: string, key: string) => {
        const res = await fetch(base + '/api/crm/leads', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${north.token}`,
            'idempotency-key': randomUUID(),
          },
          body: JSON.stringify({
            location_id: rooftopId,
            intake_key: key,
            channel: 'manual',
            source_code: 'website',
            customer: { given_name: key, family_name: 'Person', email: `${key}@x.com` },
          }),
        });
        return res.status;
      };
      // CONTROL: into their own rooftop, which they may.
      assert.equal(await capture(alpha.rooftopA, 'n1'), 201, 'CONTROL: north captures into north');
      // …and into the other rooftop, which they may not.
      assert.equal(await capture(alpha.rooftopB, 'n2'), 403);
      // …and into ANOTHER DEALERSHIP's rooftop, which does not resolve at all.
      assert.equal(await capture(beta.rooftopA, 'n3'), 404);
    });
  },
);
