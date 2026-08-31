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
  greetVisit,
  joinFloor,
  releaseToFloor,
  listFloor,
  receiveHandoff,
  recordArrival,
  startDemonstration,
  startDemonstrationWithin,
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
      const arrived = await recordArrival({
        actingUserLinkId: f.manager,
        tenantId: f.tenantId,
        rooftopId: f.rooftopId,
        partyId,
        opportunityId: null,
        appointmentId: null,
      });
      assert.equal(arrived.outcome, 'arrived', JSON.stringify(arrived));
      const visit = (arrived as { visit: { visitId: string; authorizationVersion: number } }).visit;
      return { id: visit.visitId, version: visit.authorizationVersion };
    }

    /** VINs handed out one at a time, so two probes never collide on one car. */
    const VINS = [
      '1HGCM82633A004352',
      '2HGCM82633A004353',
      '3HGCM82633A004354',
      '5HGCM82633A004356',
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
    ): Promise<{ stockItemId: string; opportunityIds: string[] }> {
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
          partyId: f.parties[i]!,
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
      return { stockItemId, opportunityIds };
    }

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

      const wrongArrival = await recordArrival({
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
      const ownArrival = await recordArrival({
        actingUserLinkId: away.manager,
        tenantId: away.tenantId,
        rooftopId: away.rooftopId,
        partyId: away.parties[0]!,
        opportunityId: null,
        appointmentId: null,
      });
      assert.equal(ownArrival.outcome, 'arrived', JSON.stringify(ownArrival));

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

    test('one car, two salespeople: the second is refused, and told which drive has it', async () => {
      const f = await seedFloor(2, 2);

      // Two opportunities at the same rooftop, and one car both want.
      const world = await oneCarTwoBuyers(f, VINS.shift()!);

      // BOTH DRIVES ARE STARTED AT ONCE. One car cannot be in two places.
      const [one, two] = await Promise.all([
        startDemonstration({
          actingUserLinkId: f.sellers[0]!,
          tenantId: f.tenantId,
          opportunityId: world.opportunityIds[0]!,
          stockItemId: world.stockItemId,
          driverPartyId: f.parties[0]!,
          licenceVerified: true,
          visitId: null,
        }),
        startDemonstration({
          actingUserLinkId: f.sellers[1]!,
          tenantId: f.tenantId,
          opportunityId: world.opportunityIds[1]!,
          stockItemId: world.stockItemId,
          driverPartyId: f.parties[1]!,
          licenceVerified: true,
          visitId: null,
        }),
      ]);

      const results = [one.outcome, two.outcome].sort();
      assert.deepEqual(
        results,
        ['started', 'vehicle_out'],
        `one car, one drive — got ${JSON.stringify([one, two])}`,
      );

      const out = await query(
        `SELECT COUNT(*)::int AS n FROM demonstrations
          WHERE tenant_id = $1 AND stock_item_id = $2 AND state = 'in_progress'`,
        [f.tenantId, world.stockItemId],
      );
      assert.equal(Number((out.rows[0] as { n: number }).n), 1);

      // THE REFUSAL NAMES THE DRIVE THAT HAS THE CAR, so the salesperson can go
      // and find it rather than guess.
      const refused = one.outcome === 'vehicle_out' ? one : two;
      const started = one.outcome === 'started' ? one : two;
      assert.equal(
        (refused as { demonstrationId: string }).demonstrationId,
        (started as { demonstration: { demonstrationId: string } }).demonstration.demonstrationId,
      );
    });

    test('the database itself refuses a second drive, with the service out of the way', async () => {
      const f = await seedFloor(2, 2);
      const world = await oneCarTwoBuyers(f, VINS.shift()!);
      const started = await startDemonstration({
        actingUserLinkId: f.sellers[0]!,
        tenantId: f.tenantId,
        opportunityId: world.opportunityIds[0]!,
        stockItemId: world.stockItemId,
        driverPartyId: f.parties[0]!,
        licenceVerified: true,
        visitId: null,
      });
      assert.equal(started.outcome, 'started', JSON.stringify(started));

      // THE ADVISORY LOCK IS NOT THE LAST LINE OF DEFENCE, and this proves it.
      //
      // The lock lives in the service, so a future caller reaching the table by
      // another route — a script, a repair, a second service written next year
      // — would go straight past it. `uq_demonstrations_vehicle_out` is what
      // makes one car in two places IMPOSSIBLE rather than merely serialized,
      // and the only way to test a backstop is to step round the thing in
      // front of it, which is what this deliberate bypass does.
      await assert.rejects(
        () =>
          fixtureAuthorizationStateWrite(
            'adversarial-bypass-attempt',
            `INSERT INTO demonstrations
               (tenant_id, rooftop_id, opportunity_id, stock_item_id, driver_party_id,
                accompanied_by_user_link_id, licence_verified,
                created_by_user_link_id, updated_by_user_link_id)
             VALUES ($1, $2, $3, $4, $5, $6, true, $6, $6)`,
            [
              f.tenantId,
              f.rooftopId,
              world.opportunityIds[1]!,
              world.stockItemId,
              f.parties[1]!,
              f.sellers[1]!,
            ],
          ),
        /uq_demonstrations_vehicle_out/,
        'the database let one car go out on two drives at once',
      );

      const out = await query(
        `SELECT COUNT(*)::int AS n FROM demonstrations
          WHERE tenant_id = $1 AND stock_item_id = $2 AND state = 'in_progress'`,
        [f.tenantId, world.stockItemId],
      );
      assert.equal(Number((out.rows[0] as { n: number }).n), 1);
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
        const first = await startDemonstrationWithin(holder, {
          actingUserLinkId: f.sellers[0]!,
          tenantId: f.tenantId,
          opportunityId: world.opportunityIds[0]!,
          stockItemId: world.stockItemId,
          driverPartyId: f.parties[0]!,
          licenceVerified: true,
          visitId: null,
        });
        assert.equal(first.outcome, 'started', JSON.stringify(first));

        // The second attempt runs on its own connection while the first is held.
        const contender = startDemonstration({
          actingUserLinkId: f.sellers[1]!,
          tenantId: f.tenantId,
          opportunityId: world.opportunityIds[1]!,
          stockItemId: world.stockItemId,
          driverPartyId: f.parties[1]!,
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
        assert.equal(second.outcome, 'vehicle_out', JSON.stringify(second));
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
