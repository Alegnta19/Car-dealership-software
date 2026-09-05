import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';
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
import { closePool, getPool, query } from '@dealer/database';
import { ROLES } from '@dealer/contracts';
import { createParty, acquireStock } from '@dealer/inventory';
import { captureLead, defineLeadSource, handOffLead, transitionLead } from '@dealer/crm';
import {
  checkIn,
  greetVisit,
  issueDemonstration,
  issueDemonstrationWithin,
  joinFloor,
  listFloor,
  moveOpportunityStage,
  receiveHandoff,
  releaseToFloor,
  setVehicleStatus,
  shortlistVehicle,
} from '@dealer/sales';

/**
 * RELEASE TRAIN 4 — THE FLOOR UNDER CONTENTION.
 *
 * A showroom floor is the one place in a dealership where two people really do
 * reach for the same thing at the same moment: two managers greeting two
 * walk-ins from one up-list, two salespeople sending the same car out. Both
 * races are decided in the database, and this battery proves it by RUNNING them
 * rather than by reasoning about the SQL.
 *
 * THE PROBES ASSERT ON `pg_locks`, NOT ON TIMERS. A test that waits a fixed
 * number of milliseconds and calls the result serialization proves only that
 * the machine was slow that afternoon.
 */
describe(
  'sales: the floor under contention (RT4)',
  { skip: skipIntegration ? 'set TEST_DATABASE_URL to run' : false },
  () => {
    let env: IdentityTestEnv;

    before(async () => {
      env = await startIdentityTestEnv();
    });

    after(async () => {
      await env.stop();
      await closePool();
    });

    beforeEach(async () => {
      await resetDatabase();
    });

    interface Floor {
      tenantId: string;
      rooftopId: string;
      manager: string;
      sellers: string[];
      parties: string[];
    }

    async function seedFloor(sellerCount = 2, partyCount = 2): Promise<Floor> {
      const tenantId = randomUUID();
      await seedTenantIdentity(tenantId, 'Aurora Auto Group');
      const group = await seedDealerGroup({ tenantId, name: 'Aurora Group', status: 'active' });
      const entity = await seedLegalEntity({
        tenantId,
        dealerGroupId: group.dealerGroupId,
        name: 'Aurora LLC',
        status: 'active',
      });
      const rooftop = await seedRooftop({
        tenantId,
        legalEntityId: entity.legalEntityId,
        name: 'Downtown',
        status: 'active',
      });
      const manager = await seedActor(env.issuer, { tenantId, roles: [ROLES.SALES_MANAGER] });
      const sellers: string[] = [];
      for (let i = 0; i < sellerCount; i += 1) {
        const seller = await seedActor(env.issuer, { tenantId, roles: [ROLES.SALESPERSON] });
        sellers.push(seller.userLinkId);
      }
      // EVERY ROW THIS BATTERY NEEDS IS MADE BY THE SERVICE THAT OWNS IT.
      // Customers come from Release Train 2, leads and handoffs from Release
      // Train 3 — so nothing here plants authorization state behind a service's
      // back, and nothing here can drift from the schema those trains enforce.
      const parties: string[] = [];
      for (let i = 0; i < partyCount; i += 1) {
        const created = await createParty({
          actingUserLinkId: manager.userLinkId,
          tenantId,
          partyType: 'person',
          details: { givenName: 'Walk', familyName: `In${i}`, email: `walkin${i}@example.com` },
        });
        assert.equal(created.outcome, 'created', JSON.stringify(created));
        parties.push((created as { party: { partyId: string } }).party.partyId);
      }
      return {
        tenantId,
        rooftopId: rooftop.rooftopId,
        manager: manager.userLinkId,
        sellers,
        parties,
      };
    }

    async function arrive(f: Floor, partyId: string): Promise<{ id: string; version: number }> {
      const arrived = await checkIn({
        actingUserLinkId: f.manager,
        tenantId: f.tenantId,
        rooftopId: f.rooftopId,
        partyId,
        opportunityId: null,
        appointmentId: null,
      });
      assert.equal(arrived.outcome, 'checked_in', JSON.stringify(arrived));
      const visit = (arrived as { visit: { visitId: string; authorizationVersion: number } }).visit;
      return { id: visit.visitId, version: visit.authorizationVersion };
    }

    /**
     * ONE LEAD, CAPTURED AND HANDED OFF, and nothing received yet — the state
     * the intake race starts from. Built through Release Train 3's own
     * services, so the frozen snapshot the receipt reads is a real one.
     */
    async function handOffOneLead(f: Floor, partyId: string, key: string): Promise<string> {
      const source = await defineLeadSource({
        actingUserLinkId: f.manager,
        tenantId: f.tenantId,
        sourceCode: 'walk_in',
        displayName: 'Walk in',
        channel: 'walk_in',
        medium: 'direct',
      });
      assert.ok(
        source.outcome === 'saved' || source.outcome === 'duplicate',
        JSON.stringify(source),
      );
      const captured = await captureLead({
        actingUserLinkId: f.manager,
        tenantId: f.tenantId,
        rooftopId: f.rooftopId,
        intakeKey: key,
        channel: 'manual',
        sourceCode: 'walk_in',
        partyId,
      });
      assert.equal(captured.outcome, 'created', JSON.stringify(captured));
      const lead = (captured as { lead: { leadId: string; authorizationVersion: number } }).lead;
      let version = lead.authorizationVersion;
      for (const state of ['working', 'qualified'] as const) {
        const moved = await transitionLead({
          actingUserLinkId: f.manager,
          tenantId: f.tenantId,
          leadId: lead.leadId,
          toState: state,
          expectedVersion: version,
        });
        assert.equal(moved.outcome, 'moved', JSON.stringify(moved));
        version = (moved as { lead: { authorizationVersion: number } }).lead.authorizationVersion;
      }
      const handed = await handOffLead({
        actingUserLinkId: f.manager,
        tenantId: f.tenantId,
        leadId: lead.leadId,
        expectedVersion: version,
        handedToUserLinkId: f.sellers[0]!,
      });
      assert.equal(handed.outcome, 'handed_off', JSON.stringify(handed));
      return (handed as { handoffId: string }).handoffId;
    }

    /** VINs handed out one at a time, so two probes never collide on one car. */
    const VINS = [
      '1HGCM82633A004352',
      '2HGCM82633A004353',
      '3HGCM82633A004354',
      '5HGCM82633A004356',
      '6HGCM82633A004357',
      '7HGCM82633A004358',
      '8HGCM82633A004359',
      '9HGCM82633A004360',
      '1JGCM82633A004361',
      '2JGCM82633A004362',
      '3JGCM82633A004363',
      '4JGCM82633A004364',
    ];

    /**
     * ONE CAR ON THE LOT AND TWO OPPORTUNITIES THAT BOTH WANT IT — built the way
     * a dealership builds it: acquired through Release Train 2, captured,
     * qualified and handed off through Release Train 3, received through this
     * one. No probe writes a row a service would not have written.
     */
    async function oneCarTwoBuyers(
      f: Floor,
      vin: string,
    ): Promise<{ stockItemId: string; opportunityIds: string[]; partyIds: string[] }> {
      // ITS OWN CUSTOMERS, ONE PAIR PER CALL. `uq_opportunities_open_per_party`
      // allows one OPEN opportunity per customer per rooftop, so a fixture that
      // reused the world's two people would collide with the constraint the
      // second time it ran — which is the constraint being right, not the
      // fixture being unlucky.
      const buyers: string[] = [];
      for (let i = 0; i < 2; i += 1) {
        const made = await createParty({
          actingUserLinkId: f.manager,
          tenantId: f.tenantId,
          partyType: 'person',
          details: {
            givenName: 'Buyer',
            familyName: `Of${vin.slice(-4)}${i}`,
            email: `buyer.${vin.slice(-4).toLowerCase()}.${i}@example.com`,
          },
        });
        assert.equal(made.outcome, 'created', JSON.stringify(made));
        buyers.push((made as { party: { partyId: string } }).party.partyId);
      }
      const source = await defineLeadSource({
        actingUserLinkId: f.manager,
        tenantId: f.tenantId,
        sourceCode: 'walk_in',
        displayName: 'Walk in',
        channel: 'walk_in',
        medium: 'direct',
      });
      assert.ok(
        source.outcome === 'saved' || source.outcome === 'duplicate',
        JSON.stringify(source),
      );

      const acquired = await acquireStock({
        actingUserLinkId: f.manager,
        tenantId: f.tenantId,
        rooftopId: f.rooftopId,
        vin,
        stockNumber: vin.slice(-6),
        acquisitionSource: 'trade_in',
        acquiredOn: '2026-08-01',
        referenceYear: 2022,
        newParty: {
          partyType: 'person',
          details: { givenName: 'Trade', familyName: `In${vin.slice(-4)}` },
        },
      });
      assert.equal(acquired.outcome, 'acquired', JSON.stringify(acquired));
      const stockItemId = (acquired as { stockItem: { stockItemId: string } }).stockItem
        .stockItemId;

      const opportunityIds: string[] = [];
      for (let i = 0; i < 2; i += 1) {
        const captured = await captureLead({
          actingUserLinkId: f.manager,
          tenantId: f.tenantId,
          rooftopId: f.rooftopId,
          intakeKey: `floor-${vin}-${i}`,
          channel: 'manual',
          sourceCode: 'walk_in',
          partyId: buyers[i]!,
        });
        assert.equal(captured.outcome, 'created', JSON.stringify(captured));
        const lead = (captured as { lead: { leadId: string; authorizationVersion: number } }).lead;
        let version = lead.authorizationVersion;
        for (const state of ['working', 'qualified'] as const) {
          const moved = await transitionLead({
            actingUserLinkId: f.manager,
            tenantId: f.tenantId,
            leadId: lead.leadId,
            toState: state,
            expectedVersion: version,
          });
          assert.equal(moved.outcome, 'moved', JSON.stringify(moved));
          version = (moved as { lead: { authorizationVersion: number } }).lead.authorizationVersion;
        }
        const handed = await handOffLead({
          actingUserLinkId: f.manager,
          tenantId: f.tenantId,
          leadId: lead.leadId,
          expectedVersion: version,
          handedToUserLinkId: f.sellers[i] ?? f.sellers[0]!,
        });
        assert.equal(handed.outcome, 'handed_off', JSON.stringify(handed));
        const received = await receiveHandoff({
          actingUserLinkId: f.sellers[i] ?? f.sellers[0]!,
          tenantId: f.tenantId,
          handoffId: (handed as { handoffId: string }).handoffId,
        });
        assert.equal(received.outcome, 'received', JSON.stringify(received));
        opportunityIds.push(
          (received as { opportunity: { opportunityId: string } }).opportunity.opportunityId,
        );
      }
      return { stockItemId, opportunityIds, partyIds: buyers };
    }

    test('concurrent receipt of one handoff converges on one opportunity', async () => {
      const f = await seedFloor(2, 2);
      const handoffId = await handOffOneLead(f, f.parties[0]!, 'race-1');

      // TWO GENUINELY CONCURRENT RECEIPTS. A provider that delivers its webhook
      // twice, or a person double-clicking, or a retry racing the original —
      // this is what all three look like at the service.
      const [a, b] = await Promise.all([
        receiveHandoff({
          actingUserLinkId: f.sellers[0]!,
          tenantId: f.tenantId,
          handoffId,
        }),
        receiveHandoff({
          actingUserLinkId: f.sellers[1]!,
          tenantId: f.tenantId,
          handoffId,
        }),
      ]);

      // ONE RECEIVES, ONE CONVERGES, AND NEITHER SEES A KEY ERROR. The unique
      // key already made two opportunities impossible; what the advisory lock
      // adds is that the loser is told the truth instead of being handed a
      // constraint violation as a 500 — which a retrying provider would simply
      // retry again.
      const outcomes = [a.outcome, b.outcome].sort();
      assert.deepEqual(
        outcomes,
        ['already_received', 'received'],
        `one handoff, one opportunity — got ${JSON.stringify([a, b])}`,
      );
      const ids = [a, b].map(
        (x) => (x as { opportunity: { opportunityId: string } }).opportunity.opportunityId,
      );
      assert.equal(ids[0], ids[1], 'both callers hold the same opportunity');

      const rows = await query(
        `SELECT COUNT(*)::int AS n FROM opportunities WHERE tenant_id = $1 AND handoff_id = $2`,
        [f.tenantId, handoffId],
      );
      assert.equal(Number((rows.rows[0] as { n: number }).n), 1);

      // …AND THE CANONICAL REFERENCES CAME FROM THE FROZEN SNAPSHOT.
      const stored = await query(
        `SELECT o.origin, o.party_id, o.lead_id, o.rooftop_id,
                h.handed_snapshot->>'party_id' AS snap_party,
                h.handed_snapshot->>'lead_id' AS snap_lead,
                h.handed_snapshot->>'rooftop_id' AS snap_rooftop
           FROM opportunities o
           JOIN lead_handoffs h ON h.tenant_id = o.tenant_id AND h.handoff_id = o.handoff_id
          WHERE o.tenant_id = $1 AND o.handoff_id = $2`,
        [f.tenantId, handoffId],
      );
      const row = stored.rows[0] as Record<string, string>;
      assert.equal(String(row.origin), 'crm_handoff');
      assert.equal(String(row.party_id), String(row.snap_party), 'the customer is the frozen one');
      assert.equal(String(row.lead_id), String(row.snap_lead), 'so is the lead');
      assert.equal(String(row.rooftop_id), String(row.snap_rooftop), 'so is the rooftop');
    });

    test('concurrent check-ins with DIFFERENT request keys converge on one visit', async () => {
      const f = await seedFloor(2, 1);

      // THE IDEMPOTENCY LAYER CANNOT SAVE THIS. Two honest requests with two
      // honest keys — a receptionist at the desk and a salesperson on a tablet
      // — are the same arrival, and only the BUSINESS key can merge them.
      const [a, b] = await Promise.all([
        checkIn({
          actingUserLinkId: f.sellers[0]!,
          tenantId: f.tenantId,
          rooftopId: f.rooftopId,
          partyId: f.parties[0]!,
          opportunityId: null,
          appointmentId: null,
        }),
        checkIn({
          actingUserLinkId: f.sellers[1]!,
          tenantId: f.tenantId,
          rooftopId: f.rooftopId,
          partyId: f.parties[0]!,
          opportunityId: null,
          appointmentId: null,
        }),
      ]);

      const outcomes = [a.outcome, b.outcome].sort();
      assert.deepEqual(
        outcomes,
        ['already_here', 'checked_in'],
        `one customer, one visit — got ${JSON.stringify([a, b])}`,
      );
      const ids = [a, b].map((x) => (x as { visit: { visitId: string } }).visit.visitId);
      assert.equal(ids[0], ids[1], 'both callers hold the same visit');

      const rows = await query(
        `SELECT COUNT(*)::int AS n FROM showroom_visits
          WHERE tenant_id = $1 AND party_id = $2 AND state <> 'departed'`,
        [f.tenantId, f.parties[0]!],
      );
      assert.equal(Number((rows.rows[0] as { n: number }).n), 1);
    });

    test('the desking fact is raised exactly once, even under a concurrent move', async () => {
      const f = await seedFloor(2, 2);
      const world = await oneCarTwoBuyers(f, VINS.shift()!);
      const opportunityId = world.opportunityIds[0]!;

      // A car they committed to, so the fact has something to name.
      const shortlisted = await shortlistVehicle({
        actingUserLinkId: f.sellers[0]!,
        tenantId: f.tenantId,
        opportunityId,
        stockItemId: world.stockItemId,
      });
      assert.equal(shortlisted.outcome, 'added', JSON.stringify(shortlisted));
      const chosen = await setVehicleStatus({
        actingUserLinkId: f.sellers[0]!,
        tenantId: f.tenantId,
        opportunityId,
        opportunityVehicleId: (shortlisted as { vehicle: { opportunityVehicleId: string } }).vehicle
          .opportunityVehicleId,
        expectedVersion: 1,
        status: 'selected',
      });
      assert.equal(chosen.outcome, 'updated', JSON.stringify(chosen));

      const staged = await moveOpportunityStage({
        actingUserLinkId: f.sellers[0]!,
        tenantId: f.tenantId,
        opportunityId,
        toStage: 'negotiating',
        expectedVersion: 1,
      });
      assert.equal(staged.outcome, 'moved', JSON.stringify(staged));
      const version = (staged as { opportunity: { authorizationVersion: number } }).opportunity
        .authorizationVersion;

      // TWO CONCURRENT POSITIVE CONCLUSIONS. One wins on the version; the other
      // must not produce a second file on the desk.
      const [a, b] = await Promise.all([
        moveOpportunityStage({
          actingUserLinkId: f.sellers[0]!,
          tenantId: f.tenantId,
          opportunityId,
          toStage: 'ready_for_desking',
          expectedVersion: version,
          disposition: 'committed_to_purchase',
        }),
        moveOpportunityStage({
          actingUserLinkId: f.sellers[1]!,
          tenantId: f.tenantId,
          opportunityId,
          toStage: 'ready_for_desking',
          expectedVersion: version,
          disposition: 'committed_to_purchase',
        }),
      ]);

      // Whatever order they landed in, the outcomes are one success and one
      // non-success — never two successes.
      const moved = [a, b].filter((x) => x.outcome === 'moved');
      assert.equal(moved.length, 1, `two conclusions succeeded — ${JSON.stringify([a, b])}`);
      const other = [a, b].find((x) => x.outcome !== 'moved');
      assert.ok(
        other !== undefined &&
          (other.outcome === 'version_conflict' || other.outcome === 'already_there'),
        `the loser answered ${JSON.stringify(other)}`,
      );

      // EXACTLY ONE FACT AND EXACTLY ONE EVENT, whichever way the race went.
      const counts = await query(
        `SELECT (SELECT COUNT(*)::int FROM desking_handoffs WHERE tenant_id = $1) AS facts,
                (SELECT COUNT(*)::int FROM admin_outbox
                  WHERE tenant_id = $1
                    AND event_type = 'sales.opportunity.ready_for_appraisal_desking') AS events`,
        [f.tenantId],
      );
      assert.deepEqual(counts.rows[0], { facts: 1, events: 1 });

      // …AND A LATER REPLAY STILL RAISES NOTHING, so the guarantee is not an
      // artefact of the two calls having overlapped.
      const replay = await moveOpportunityStage({
        actingUserLinkId: f.sellers[0]!,
        tenantId: f.tenantId,
        opportunityId,
        toStage: 'ready_for_desking',
        expectedVersion: version + 1,
        disposition: 'committed_to_purchase',
      });
      assert.equal(replay.outcome, 'already_there', JSON.stringify(replay));
      const after = await query(
        `SELECT (SELECT COUNT(*)::int FROM desking_handoffs WHERE tenant_id = $1) AS facts,
                (SELECT COUNT(*)::int FROM admin_outbox
                  WHERE tenant_id = $1
                    AND event_type = 'sales.opportunity.ready_for_appraisal_desking') AS events`,
        [f.tenantId],
      );
      assert.deepEqual(after.rows[0], { facts: 1, events: 1 });

      // NO SOLD INVENTORY. The car this train handed on is untouched.
      const stock = await query(
        `SELECT lifecycle_state FROM stock_items WHERE stock_item_id = $1`,
        [world.stockItemId],
      );
      assert.equal(
        String((stock.rows[0] as { lifecycle_state: string }).lifecycle_state),
        'acquired',
      );
    });

    test('the database itself refuses a second desking handoff, service stepped round', async () => {
      const f = await seedFloor(2, 2);
      const world = await oneCarTwoBuyers(f, VINS.shift()!);
      const opportunityId = world.opportunityIds[0]!;

      const staged = await moveOpportunityStage({
        actingUserLinkId: f.sellers[0]!,
        tenantId: f.tenantId,
        opportunityId,
        toStage: 'negotiating',
        expectedVersion: 1,
      });
      assert.equal(staged.outcome, 'moved', JSON.stringify(staged));
      const desked = await moveOpportunityStage({
        actingUserLinkId: f.sellers[0]!,
        tenantId: f.tenantId,
        opportunityId,
        toStage: 'ready_for_desking',
        expectedVersion: (staged as { opportunity: { authorizationVersion: number } }).opportunity
          .authorizationVersion,
        disposition: 'committed_to_purchase',
      });
      assert.equal(desked.outcome, 'moved', JSON.stringify(desked));

      // THE SERVICE'S REPLAY ANSWER IS NOT THE LAST LINE OF DEFENCE.
      //
      // `moveOpportunityStage` returns `already_there` before it writes anything,
      // so the service path never reaches this key — which means the key is only
      // testable by stepping round the service, exactly as
      // `uq_demonstrations_vehicle_out` is. A worker, a repair script or a
      // service written next year reaches this table with no such short-circuit,
      // and `UNIQUE (tenant_id, opportunity_id)` is what makes "exactly one file
      // on the desk" true for them too.
      const opportunity = await query(
        `SELECT rooftop_id, party_id FROM opportunities WHERE opportunity_id = $1`,
        [opportunityId],
      );
      const row = opportunity.rows[0] as { rooftop_id: string; party_id: string };
      const event = await query(`SELECT event_id FROM admin_outbox WHERE tenant_id = $1 LIMIT 1`, [
        f.tenantId,
      ]);
      await assert.rejects(
        () =>
          fixtureAuthorizationStateWrite(
            'adversarial-bypass-attempt',
            `INSERT INTO desking_handoffs
               (tenant_id, opportunity_id, rooftop_id, party_id,
                handed_by_user_link_id, outbox_event_id)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              f.tenantId,
              opportunityId,
              row.rooftop_id,
              row.party_id,
              f.sellers[0]!,
              String((event.rows[0] as { event_id: string }).event_id),
            ],
          ),
        /desking_handoffs_tenant_id_opportunity_id_key/,
        'the database let one customer be handed to the desk twice',
      );

      const facts = await query(
        `SELECT COUNT(*)::int AS n FROM desking_handoffs WHERE tenant_id = $1`,
        [f.tenantId],
      );
      assert.equal(Number((facts.rows[0] as { n: number }).n), 1);
    });

    test('a caller who does not work a showroom cannot touch its floor, service-direct', async () => {
      // THE SERVICES ARE NOT ONLY REACHED THROUGH HTTP. A worker, a script or a
      // future package calls them with a tenant, a rooftop and an actor and no
      // middleware in between — so the rooftop in the argument list is a claim
      // exactly as the rooftop in a request body is, and the service has to
      // decide it rather than trust it. `tests/sales-authority.test.ts` proves
      // the HTTP half, where the policy engine refuses first.
      const home = await seedFloor(1, 1);
      const away = await seedFloor(1, 1);

      const wrongFloor = await joinFloor({
        actingUserLinkId: home.manager,
        tenantId: away.tenantId,
        rooftopId: away.rooftopId,
        userLinkId: away.sellers[0]!,
      });
      assert.equal(wrongFloor.outcome, 'invalid', JSON.stringify(wrongFloor));
      assert.match(
        String((wrongFloor as { error: string }).error),
        /you do not run the floor/i,
        'a manager from another dealership seeded this up-list',
      );

      const wrongArrival = await checkIn({
        actingUserLinkId: home.manager,
        tenantId: away.tenantId,
        rooftopId: away.rooftopId,
        partyId: away.parties[0]!,
        opportunityId: null,
        appointmentId: null,
      });
      assert.equal(wrongArrival.outcome, 'invalid', JSON.stringify(wrongArrival));
      assert.match(String((wrongArrival as { error: string }).error), /you do not work/i);

      // …and nothing was planted by either refusal.
      assert.deepEqual(await listFloor(away.tenantId, away.rooftopId), []);
      const visits = await query(
        `SELECT COUNT(*)::int AS n FROM showroom_visits WHERE rooftop_id = $1`,
        [away.rooftopId],
      );
      assert.equal(Number((visits.rows[0] as { n: number }).n), 0);

      // CONTROL: the same three calls from somebody who DOES work there succeed,
      // so the refusals were about the rooftop and not about the command.
      const ownFloor = await joinFloor({
        actingUserLinkId: away.manager,
        tenantId: away.tenantId,
        rooftopId: away.rooftopId,
        userLinkId: away.sellers[0]!,
      });
      assert.equal(ownFloor.outcome, 'joined', JSON.stringify(ownFloor));
      const ownArrival = await checkIn({
        actingUserLinkId: away.manager,
        tenantId: away.tenantId,
        rooftopId: away.rooftopId,
        partyId: away.parties[0]!,
        opportunityId: null,
        appointmentId: null,
      });
      assert.equal(ownArrival.outcome, 'checked_in', JSON.stringify(ownArrival));

      // Taking somebody off the floor is the same authority as putting them on.
      const wrongRelease = await releaseToFloor({
        actingUserLinkId: home.manager,
        tenantId: away.tenantId,
        rooftopId: away.rooftopId,
        userLinkId: away.sellers[0]!,
      });
      assert.equal(wrongRelease.outcome, 'not_found', JSON.stringify(wrongRelease));
      const ownRelease = await releaseToFloor({
        actingUserLinkId: away.manager,
        tenantId: away.tenantId,
        rooftopId: away.rooftopId,
        userLinkId: away.sellers[0]!,
      });
      assert.equal(ownRelease.outcome, 'released', JSON.stringify(ownRelease));
    });

    test('two customers, one salesperson: only one greeting takes the turn', async () => {
      const f = await seedFloor(1, 2);
      const joined = await joinFloor({
        actingUserLinkId: f.manager,
        tenantId: f.tenantId,
        rooftopId: f.rooftopId,
        userLinkId: f.sellers[0]!,
      });
      assert.equal(joined.outcome, 'joined', JSON.stringify(joined));

      const a = await arrive(f, f.parties[0]!);
      const b = await arrive(f, f.parties[1]!);

      // BOTH GREETINGS ARE ISSUED AT ONCE against a floor with one person on it.
      const [first, second] = await Promise.all([
        greetVisit({
          actingUserLinkId: f.manager,
          tenantId: f.tenantId,
          visitId: a.id,
          expectedVersion: a.version,
          greetedByUserLinkId: null,
        }),
        greetVisit({
          actingUserLinkId: f.manager,
          tenantId: f.tenantId,
          visitId: b.id,
          expectedVersion: b.version,
          greetedByUserLinkId: null,
        }),
      ]);

      const outcomes = [first.outcome, second.outcome].sort();
      assert.deepEqual(
        outcomes,
        ['greeted', 'nobody_available'],
        `one turn, one greeting — got ${JSON.stringify([first, second])}`,
      );

      // THE ONE SALESPERSON IS WITH EXACTLY ONE CUSTOMER, not both.
      const floor = await listFloor(f.tenantId, f.rooftopId);
      assert.equal(floor.length, 1);
      assert.equal(floor[0]!.status, 'with_customer');

      const greetedRows = await query(
        `SELECT COUNT(*)::int AS n FROM showroom_visits
          WHERE tenant_id = $1 AND greeted_by_user_link_id IS NOT NULL`,
        [f.tenantId],
      );
      assert.equal(Number((greetedRows.rows[0] as { n: number }).n), 1);
    });

    test('the up-list is a queue: turns come back around in order', async () => {
      const f = await seedFloor(3, 3);
      for (const seller of f.sellers) {
        const joined = await joinFloor({
          actingUserLinkId: f.manager,
          tenantId: f.tenantId,
          rooftopId: f.rooftopId,
          userLinkId: seller,
        });
        assert.equal(joined.outcome, 'joined');
      }

      // Three customers arrive one after another; each takes the next up.
      const took: string[] = [];
      for (const partyId of f.parties) {
        const visit = await arrive(f, partyId);
        const greeted = await greetVisit({
          actingUserLinkId: f.manager,
          tenantId: f.tenantId,
          visitId: visit.id,
          expectedVersion: visit.version,
          greetedByUserLinkId: null,
        });
        assert.equal(greeted.outcome, 'greeted', JSON.stringify(greeted));
        took.push((greeted as { greetedBy: string }).greetedBy);
      }

      assert.deepEqual(
        [...took].sort(),
        [...f.sellers].sort(),
        'three customers, three different salespeople — nobody was skipped or doubled',
      );
      assert.deepEqual(took, f.sellers, 'and in the order they joined the floor');
    });

    test('an explicit greeter is honoured, and must actually be on the floor', async () => {
      const f = await seedFloor(2, 2);
      await joinFloor({
        actingUserLinkId: f.manager,
        tenantId: f.tenantId,
        rooftopId: f.rooftopId,
        userLinkId: f.sellers[0]!,
      });

      // A CUSTOMER WHO ASKS FOR THEIR SALESPERSON GETS THEIR SALESPERSON,
      // regardless of whose turn it is.
      const visit = await arrive(f, f.parties[0]!);
      const named = await greetVisit({
        actingUserLinkId: f.manager,
        tenantId: f.tenantId,
        visitId: visit.id,
        expectedVersion: visit.version,
        greetedByUserLinkId: f.sellers[0]!,
      });
      assert.equal(named.outcome, 'greeted', JSON.stringify(named));
      assert.equal((named as { greetedBy: string }).greetedBy, f.sellers[0]);
      assert.equal(
        (named as { fromRotation: boolean }).fromRotation,
        false,
        'a requested salesperson is not a turn from the up-list',
      );

      // …but somebody who is not on the floor cannot be handed a customer.
      const second = await arrive(f, f.parties[1]!);
      const absent = await greetVisit({
        actingUserLinkId: f.manager,
        tenantId: f.tenantId,
        visitId: second.id,
        expectedVersion: second.version,
        greetedByUserLinkId: f.sellers[1]!,
      });
      assert.equal(absent.outcome, 'invalid', JSON.stringify(absent));
      assert.match(String((absent as { error: string }).error), /floor/i);
    });

    test('one car, two salespeople: the second is refused, and told nothing about the first', async () => {
      const f = await seedFloor(2, 2);

      // Two opportunities at the same rooftop, and one car both want.
      const world = await oneCarTwoBuyers(f, VINS.shift()!);

      // BOTH DRIVES ARE STARTED AT ONCE. One car cannot be in two places.
      const [one, two] = await Promise.all([
        issueDemonstration({
          actingUserLinkId: f.sellers[0]!,
          tenantId: f.tenantId,
          opportunityId: world.opportunityIds[0]!,
          stockItemId: world.stockItemId,
          driverPartyId: world.partyIds[0]!,
          licenceVerified: true,
          visitId: null,
        }),
        issueDemonstration({
          actingUserLinkId: f.sellers[1]!,
          tenantId: f.tenantId,
          opportunityId: world.opportunityIds[1]!,
          stockItemId: world.stockItemId,
          driverPartyId: world.partyIds[1]!,
          licenceVerified: true,
          visitId: null,
        }),
      ]);

      const results = [one.outcome, two.outcome].sort();
      assert.deepEqual(
        results,
        ['issued', 'unavailable'],
        `one car, one drive — got ${JSON.stringify([one, two])}`,
      );

      const out = await query(
        `SELECT COUNT(*)::int AS n FROM demonstrations
          WHERE tenant_id = $1 AND stock_item_id = $2
            AND state IN ('issued', 'in_progress')`,
        [f.tenantId, world.stockItemId],
      );
      assert.equal(Number((out.rows[0] as { n: number }).n), 1);

      // THE REFUSAL DOES NOT LEAK, and this is the assertion that pins it.
      //
      // The loser learns which of their OWN inputs is busy — the vehicle — and
      // nothing whatever about the record that holds it. An earlier revision of
      // this train returned the winning demonstration's id so the salesperson
      // "could go and find it"; that id belongs to another customer's drive,
      // possibly at another salesperson's desk, and handing it over on a
      // refusal is exactly the leak RT4-C1 closed. The refusal payload is
      // checked field by field rather than by eye.
      const refused = one.outcome === 'unavailable' ? one : two;
      const issued = one.outcome === 'issued' ? one : two;
      assert.deepEqual(
        refused,
        { outcome: 'unavailable', conflict: 'vehicle' },
        'the refusal carried something beyond which input was busy',
      );
      const winningId = (issued as { demonstration: { demonstrationId: string } }).demonstration
        .demonstrationId;
      assert.doesNotMatch(
        JSON.stringify(refused),
        new RegExp(winningId),
        'the refusal named the other demonstration',
      );
      assert.doesNotMatch(
        JSON.stringify(refused),
        new RegExp(
          world.partyIds[0]! + '|' + world.partyIds[1]! + '|' + f.sellers[0]! + '|' + f.sellers[1]!,
        ),
        'the refusal named a customer or an employee',
      );
    });

    test('the other two incompatible combinations are refused as neutrally', async () => {
      const f = await seedFloor(2, 2);
      const world = await oneCarTwoBuyers(f, VINS.shift()!);
      const second = await oneCarTwoBuyers(f, VINS.shift()!);

      const first = await issueDemonstration({
        actingUserLinkId: f.sellers[0]!,
        tenantId: f.tenantId,
        opportunityId: world.opportunityIds[0]!,
        stockItemId: world.stockItemId,
        driverPartyId: world.partyIds[0]!,
        licenceVerified: true,
        accompaniedByUserLinkId: f.sellers[0]!,
        visitId: null,
      });
      assert.equal(first.outcome, 'issued', JSON.stringify(first));

      // THE DRIVER. One person cannot be driving two cars — a second active
      // drive for the same customer means somebody typed the wrong car, and
      // nobody would know afterwards which record was the real one.
      const sameDriver = await issueDemonstration({
        actingUserLinkId: f.sellers[1]!,
        tenantId: f.tenantId,
        opportunityId: world.opportunityIds[0]!,
        stockItemId: second.stockItemId,
        driverPartyId: world.partyIds[0]!,
        licenceVerified: true,
        accompaniedByUserLinkId: f.sellers[1]!,
        visitId: null,
      });
      assert.deepEqual(sameDriver, { outcome: 'unavailable', conflict: 'driver' });

      // THE SALESPERSON RIDING ALONG. One employee cannot accompany two drives.
      const sameEscort = await issueDemonstration({
        actingUserLinkId: f.sellers[0]!,
        tenantId: f.tenantId,
        opportunityId: second.opportunityIds[1]!,
        stockItemId: second.stockItemId,
        driverPartyId: second.partyIds[1]!,
        licenceVerified: true,
        accompaniedByUserLinkId: f.sellers[0]!,
        visitId: null,
      });
      assert.deepEqual(sameEscort, { outcome: 'unavailable', conflict: 'escort' });

      // CONTROL: a different car, a different driver and a different escort all
      // succeed, so the two refusals were about the collisions and not about the
      // command being broken.
      const clean = await issueDemonstration({
        actingUserLinkId: f.sellers[1]!,
        tenantId: f.tenantId,
        opportunityId: second.opportunityIds[1]!,
        stockItemId: second.stockItemId,
        driverPartyId: second.partyIds[1]!,
        licenceVerified: true,
        accompaniedByUserLinkId: f.sellers[1]!,
        visitId: null,
      });
      assert.equal(clean.outcome, 'issued', JSON.stringify(clean));

      // …and exactly two cars are out, not three.
      const active = await query(
        `SELECT COUNT(*)::int AS n FROM demonstrations
          WHERE tenant_id = $1 AND state IN ('issued', 'in_progress')`,
        [f.tenantId],
      );
      assert.equal(Number((active.rows[0] as { n: number }).n), 2);
    });

    test('the backstop keys refuse duplicates with every service stepped round', async () => {
      const f = await seedFloor(2, 2);
      const world = await oneCarTwoBuyers(f, VINS.shift()!);

      // ── the four keys, and why they are only testable from here ───────────
      //
      // Each of these is checked by its service FIRST, so a caller coming
      // through `/api/sales` never reaches the key: the service answers with a
      // sentence instead. That is the right order for a person — and it means
      // the keys themselves can only be exercised by stepping ROUND the
      // services, which is what a worker, a repair script or a service written
      // next year would effectively do. Each bypass below is declared as the
      // adversary it stands in for.
      const visit = await checkIn({
        actingUserLinkId: f.sellers[0]!,
        tenantId: f.tenantId,
        rooftopId: f.rooftopId,
        partyId: world.partyIds[0]!,
        opportunityId: null,
        appointmentId: null,
      });
      assert.equal(visit.outcome, 'checked_in', JSON.stringify(visit));

      // 1. ONE ACTIVE VISIT PER CUSTOMER.
      await assert.rejects(
        () =>
          fixtureAuthorizationStateWrite(
            'adversarial-bypass-attempt',
            `INSERT INTO showroom_visits
               (tenant_id, rooftop_id, party_id, created_by_user_link_id,
                updated_by_user_link_id)
             VALUES ($1, $2, $3, $4, $4)`,
            [f.tenantId, f.rooftopId, world.partyIds[0]!, f.sellers[0]!],
          ),
        /uq_showroom_visits_one_active/,
        'the database let one customer hold two open visits',
      );

      const issued = await issueDemonstration({
        actingUserLinkId: f.sellers[0]!,
        tenantId: f.tenantId,
        opportunityId: world.opportunityIds[0]!,
        stockItemId: world.stockItemId,
        driverPartyId: world.partyIds[0]!,
        licenceVerified: true,
        accompaniedByUserLinkId: f.sellers[0]!,
        visitId: null,
      });
      assert.equal(issued.outcome, 'issued', JSON.stringify(issued));

      const second = await oneCarTwoBuyers(f, VINS.shift()!);
      const raw = (stockItemId: string, driverPartyId: string, escort: string): Promise<unknown> =>
        fixtureAuthorizationStateWrite(
          'adversarial-bypass-attempt',
          `INSERT INTO demonstrations
             (tenant_id, rooftop_id, opportunity_id, stock_item_id, driver_party_id,
              accompanied_by_user_link_id, licence_verified, state,
              created_by_user_link_id, updated_by_user_link_id)
           VALUES ($1, $2, $3, $4, $5, $6, true, 'issued', $6, $6)`,
          [f.tenantId, f.rooftopId, second.opportunityIds[0]!, stockItemId, driverPartyId, escort],
        );

      // 2. ONE ACTIVE DRIVE PER CAR.
      await assert.rejects(
        () => raw(world.stockItemId, second.partyIds[0]!, f.sellers[1]!),
        /uq_demonstrations_vehicle_out/,
        'the database let one car go out on two drives at once',
      );

      // 3. ONE ACTIVE DRIVE PER DRIVER.
      await assert.rejects(
        () => raw(second.stockItemId, world.partyIds[0]!, f.sellers[1]!),
        /uq_demonstrations_driver_out/,
        'the database let one person drive two cars at once',
      );

      // 4. ONE ACTIVE DRIVE PER ACCOMPANYING SALESPERSON.
      await assert.rejects(
        () => raw(second.stockItemId, second.partyIds[0]!, f.sellers[0]!),
        /uq_demonstrations_escort_out/,
        'the database let one employee ride along on two drives at once',
      );

      // …AND EXACTLY WHAT SHOULD BE THERE IS THERE.
      const counts = await query(
        `SELECT (SELECT COUNT(*)::int FROM showroom_visits WHERE tenant_id = $1) AS visits,
                (SELECT COUNT(*)::int FROM demonstrations
                  WHERE tenant_id = $1 AND state IN ('issued', 'in_progress')) AS active`,
        [f.tenantId],
      );
      assert.deepEqual(counts.rows[0], { visits: 1, active: 1 });
    });

    test('the second drive really BLOCKS on the first — proven on pg_locks, not a timer', async () => {
      const f = await seedFloor(2, 2);
      const world = await oneCarTwoBuyers(f, VINS.shift()!);

      // Hold the first transaction OPEN, mid-flight, so the second one has
      // something real to wait on.
      const holder = await getPool().connect();
      const release = { fire: (): void => {} };
      const held = new Promise<void>((resolve) => {
        release.fire = resolve;
      });

      let blockedSeen = false;
      try {
        await holder.query('BEGIN');
        await holder.query(`SELECT set_config('app.tenant_id', $1, true)`, [f.tenantId]);
        const first = await issueDemonstrationWithin(holder, {
          actingUserLinkId: f.sellers[0]!,
          tenantId: f.tenantId,
          opportunityId: world.opportunityIds[0]!,
          stockItemId: world.stockItemId,
          driverPartyId: world.partyIds[0]!,
          licenceVerified: true,
          visitId: null,
        });
        assert.equal(first.outcome, 'issued', JSON.stringify(first));

        // The second attempt runs on its own connection while the first is held.
        const contender = issueDemonstration({
          actingUserLinkId: f.sellers[1]!,
          tenantId: f.tenantId,
          opportunityId: world.opportunityIds[1]!,
          stockItemId: world.stockItemId,
          driverPartyId: world.partyIds[1]!,
          licenceVerified: true,
          visitId: null,
        }).finally(() => release.fire());

        // WAIT FOR THE LOCK, NOT FOR THE CLOCK. This polls until the second
        // transaction is recorded as waiting on an advisory lock nobody has
        // released — the only evidence that the serialization is real.
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline && !blockedSeen) {
          const waiting = await query(
            `SELECT COUNT(*)::int AS n FROM pg_locks
              WHERE locktype = 'advisory' AND NOT granted`,
          );
          if (Number((waiting.rows[0] as { n: number }).n) > 0) {
            blockedSeen = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 25));
        }
        assert.equal(blockedSeen, true, 'the second drive never waited — nothing serialized it');

        // Now let the first one commit; the second must find the car taken.
        await holder.query('COMMIT');
        const second = await contender;
        assert.deepEqual(second, { outcome: 'unavailable', conflict: 'vehicle' });
      } finally {
        try {
          await holder.query('ROLLBACK');
        } catch {
          // already committed — the finally exists to return the connection
        }
        holder.release();
        await held.catch(() => undefined);
      }
    });
  },
);
