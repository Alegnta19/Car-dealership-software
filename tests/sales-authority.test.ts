import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
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
import { closePool, query } from '@dealer/database';
import { ROLES } from '@dealer/contracts';
import { createApp, resetAuthRoutesForTests, resetIdentityCompositionForTests } from '@dealer/api';

/**
 * RELEASE TRAIN 4 — AUTHORITY, PARENTAGE AND THE ABSENCE OF MONEY.
 *
 * Three things this train has to be able to prove, none of which the journey
 * battery can prove by walking a happy path:
 *
 *   1. EVERY CHILD IS REACHED THROUGH ITS PARENT. A demonstration is authorized
 *      through its opportunity, a shortlist row through its opportunity, a visit
 *      through itself. Naming somebody else's child under YOUR parent is NOT
 *      FOUND, not a decision taken against the wrong record. This is the exact
 *      shape RT3-C1 was returned for, so it is pinned per route.
 *   2. A ROOFTOP IS A BOUNDARY, and a tenant is a wall. Neither leaks, and the
 *      denial does not confirm the row exists.
 *   3. PRE-SALE MONEY IS UNREPRESENTABLE. Not absent from the API — refused by
 *      the database, on INSERT and on UPDATE, by a constraint with a name.
 */
describe(
  'sales: authority, parentage and pre-sale money (RT4)',
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

    type ParsedJson = ReturnType<typeof JSON.parse>;

    async function call(
      token: string | null,
      method: string,
      path: string,
      payload?: unknown,
      extraHeaders: Record<string, string> = {},
    ) {
      const res = await fetch(base + path, {
        method,
        headers: {
          'content-type': 'application/json',
          ...(token === null ? {} : { authorization: `Bearer ${token}` }),
          ...extraHeaders,
        },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      });
      const text = await res.text();
      return {
        status: res.status,
        contentType: res.headers.get('content-type') ?? '',
        body: text ? (JSON.parse(text) as ParsedJson) : null,
      };
    }

    interface Rooftop {
      rooftopId: string;
      manager: { userLinkId: string; token: string };
      seller: { userLinkId: string; token: string };
      otherSeller: { userLinkId: string; token: string };
    }

    interface Dealership {
      tenantId: string;
      alpha: Rooftop;
      beta: Rooftop;
      /** Reaches both rooftops — the person who sets up the fixtures. */
      principal: { userLinkId: string; token: string };
      staff: { bdc: string; marketing: string; inventory: string };
      tokens: { bdc: string; marketing: string; inventory: string };
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
      const rooftops: Rooftop[] = [];
      for (const label of ['Alpha', 'Beta']) {
        const rooftop = await seedRooftop({
          tenantId,
          legalEntityId: entity.legalEntityId,
          name: label,
          status: 'active',
        });
        // BOUND TO THIS ROOFTOP AND NO OTHER. A tenant-scoped binding would
        // make the boundary probes below pass for the wrong reason.
        const manager = await seedActor(env.issuer, {
          tenantId,
          roles: [ROLES.SALES_MANAGER],
          scope: { level: 'rooftop', id: rooftop.rooftopId },
        });
        const seller = await seedActor(env.issuer, {
          tenantId,
          roles: [ROLES.SALESPERSON],
          scope: { level: 'rooftop', id: rooftop.rooftopId },
        });
        const otherSeller = await seedActor(env.issuer, {
          tenantId,
          roles: [ROLES.SALESPERSON],
          scope: { level: 'rooftop', id: rooftop.rooftopId },
        });
        rooftops.push({
          rooftopId: rooftop.rooftopId,
          manager: { userLinkId: manager.userLinkId, token: manager.token },
          seller: { userLinkId: seller.userLinkId, token: seller.token },
          otherSeller: { userLinkId: otherSeller.userLinkId, token: otherSeller.token },
        });
      }
      const principal = await seedActor(env.issuer, {
        tenantId,
        roles: [ROLES.SALES_MANAGER, ROLES.SALESPERSON],
      });
      const bdc = await seedActor(env.issuer, { tenantId, roles: [ROLES.BDC_AGENT] });
      const marketing = await seedActor(env.issuer, { tenantId, roles: [ROLES.MARKETING_MANAGER] });
      const inventory = await seedActor(env.issuer, {
        tenantId,
        roles: [ROLES.INVENTORY_MANAGER],
      });
      return {
        tenantId,
        alpha: rooftops[0]!,
        beta: rooftops[1]!,
        principal: { userLinkId: principal.userLinkId, token: principal.token },
        staff: {
          bdc: bdc.userLinkId,
          marketing: marketing.userLinkId,
          inventory: inventory.userLinkId,
        },
        tokens: { bdc: bdc.token, marketing: marketing.token, inventory: inventory.token },
      };
    }

    /** An opportunity at one rooftop, built through the real CRM seam. */
    async function opportunityAt(
      d: Dealership,
      rooftopId: string,
      handedTo: string,
    ): Promise<{ opportunityId: string; partyId: string; version: number }> {
      await call(
        d.tokens.marketing,
        'POST',
        '/api/crm/sources',
        { source_code: 'website', display_name: 'Website', channel: 'web', medium: 'organic' },
        { 'idempotency-key': randomUUID() },
      );
      const captured = await call(
        d.tokens.bdc,
        'POST',
        '/api/crm/leads',
        {
          location_id: rooftopId,
          intake_key: `probe-${randomUUID()}`,
          channel: 'website',
          source_code: 'website',
          customer: {
            given_name: 'Probe',
            family_name: 'Customer',
            email: `probe.${randomUUID()}@example.com`,
          },
        },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(captured.status, 201, JSON.stringify(captured.body));
      const leadId = String(captured.body!.lead.leadId);
      let version = Number(captured.body!.lead.authorizationVersion);
      for (const state of ['working', 'qualified']) {
        const moved = await call(d.tokens.bdc, 'POST', `/api/crm/leads/${leadId}/transition`, {
          expected_version: version,
          to_state: state,
        });
        assert.equal(moved.status, 200, JSON.stringify(moved.body));
        version = Number(moved.body!.lead.authorizationVersion);
      }
      const handed = await call(
        d.tokens.bdc,
        'POST',
        `/api/crm/leads/${leadId}/handoff`,
        { expected_version: version, handed_to_user_link_id: handedTo },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(handed.status, 201, JSON.stringify(handed.body));
      const received = await call(
        d.principal.token,
        'POST',
        '/api/sales/opportunities',
        { handoff_id: String(handed.body!.handoffId) },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(received.status, 201, JSON.stringify(received.body));
      return {
        opportunityId: String(received.body!.opportunity.opportunityId),
        partyId: String(received.body!.opportunity.partyId),
        version: Number(received.body!.opportunity.authorizationVersion),
      };
    }

    async function carAt(d: Dealership, rooftopId: string, vin: string): Promise<string> {
      const seller = await call(
        d.tokens.inventory,
        'POST',
        '/api/inventory/parties',
        {
          party_type: 'person',
          given_name: 'Trade',
          family_name: `In${vin.slice(-4)}`,
          email: `trade.${vin.toLowerCase()}@example.com`,
        },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(seller.status, 201, JSON.stringify(seller.body));
      const acquired = await call(
        d.tokens.inventory,
        'POST',
        '/api/inventory/stock',
        {
          location_id: rooftopId,
          vin,
          stock_number: vin.slice(-6),
          acquisition_source: 'trade_in',
          acquired_on: '2026-08-01',
          acquisition_party_id: String(seller.body!.party.partyId),
        },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(acquired.status, 201, JSON.stringify(acquired.body));
      return String(acquired.body!.stockItem.stockItemId);
    }

    test('a child is reachable only through its own parent', async () => {
      const d = await seedDealership('Aurora');
      const t = d.principal.token;
      const mine = await opportunityAt(d, d.alpha.rooftopId, d.alpha.seller.userLinkId);
      const theirs = await opportunityAt(d, d.alpha.rooftopId, d.alpha.seller.userLinkId);
      const car = await carAt(d, d.alpha.rooftopId, '1HGCM82633A004352');
      const otherCar = await carAt(d, d.alpha.rooftopId, '2HGCM82633A004353');

      // A shortlist row and a drive, each belonging to `theirs`.
      const short = await call(
        t,
        'POST',
        `/api/sales/opportunities/${theirs.opportunityId}/vehicles`,
        { stock_item_id: car },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(short.status, 201, JSON.stringify(short.body));
      const theirVehicleId = String(short.body!.vehicle.opportunityVehicleId);

      const drive = await call(
        t,
        'POST',
        `/api/sales/opportunities/${theirs.opportunityId}/demonstrations`,
        { stock_item_id: car, driver_party_id: theirs.partyId, licence_verified: true },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(drive.status, 201, JSON.stringify(drive.body));
      const theirDemonstrationId = String(drive.body!.demonstration.demonstrationId);

      // NAMING THEIR CHILD UNDER MY PARENT IS NOT FOUND — and it is 404 rather
      // than 403, because a 403 would confirm the row exists.
      const stolenVehicle = await call(
        t,
        'POST',
        `/api/sales/opportunities/${mine.opportunityId}/vehicles/${theirVehicleId}/status`,
        { expected_version: 1, status: 'selected' },
      );
      assert.equal(stolenVehicle.status, 404, JSON.stringify(stolenVehicle.body));

      const stolenDrive = await call(
        t,
        'POST',
        `/api/sales/opportunities/${mine.opportunityId}/demonstrations/${theirDemonstrationId}/state`,
        { expected_version: 1, to_state: 'returned', outcome: 'interested' },
      );
      assert.equal(stolenDrive.status, 404, JSON.stringify(stolenDrive.body));

      // AND THE ROUTE ITSELF IS REAL, so the 404 above is the parent check
      // refusing rather than a mistyped URL falling through to route-not-found.
      // A probe that passes because it asked for something that does not exist
      // proves nothing, and this is the assertion that keeps it honest.
      const throughTheRightParent = await call(
        t,
        'POST',
        `/api/sales/opportunities/${theirs.opportunityId}/demonstrations/${theirDemonstrationId}/state`,
        { expected_version: 1, to_state: 'in_progress' },
      );
      assert.equal(throughTheRightParent.status, 200, JSON.stringify(throughTheRightParent.body));

      // …and the rows are untouched: the refusal was a refusal, not a partial.
      const stillOut = await query(`SELECT state FROM demonstrations WHERE demonstration_id = $1`, [
        theirDemonstrationId,
      ]);
      assert.equal(String((stillOut.rows[0] as { state: string }).state), 'in_progress');
      const stillConsidering = await query(
        `SELECT status FROM opportunity_vehicles WHERE opportunity_vehicle_id = $1`,
        [theirVehicleId],
      );
      assert.equal(String((stillConsidering.rows[0] as { status: string }).status), 'considering');

      // The same operation through the RIGHT parent works, so the 404 above was
      // about parentage and not about the operation being broken.
      const rightParent = await call(
        t,
        'POST',
        `/api/sales/opportunities/${theirs.opportunityId}/vehicles/${theirVehicleId}/status`,
        { expected_version: 1, status: 'rejected', rejected_reason: 'too small' },
      );
      assert.equal(rightParent.status, 200, JSON.stringify(rightParent.body));

      // A shortlist under MY opportunity is mine, and does not collide.
      const ok = await call(
        t,
        'POST',
        `/api/sales/opportunities/${mine.opportunityId}/vehicles`,
        { stock_item_id: otherCar },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(ok.status, 201, JSON.stringify(ok.body));
    });

    test('a rooftop is a boundary and a tenant is a wall', async () => {
      const aurora = await seedDealership('Aurora');
      const borealis = await seedDealership('Borealis');
      const atAlpha = await opportunityAt(
        aurora,
        aurora.alpha.rooftopId,
        aurora.alpha.seller.userLinkId,
      );

      // BETA'S SALESPERSON CANNOT REACH ALPHA'S OPPORTUNITY. They are one
      // dealership, one database and one URL apart — and it is still 404.
      const acrossRooftop = await call(
        aurora.beta.seller.token,
        'GET',
        `/api/sales/opportunities/${atAlpha.opportunityId}`,
      );
      assert.equal(acrossRooftop.status, 404, JSON.stringify(acrossRooftop.body));

      const acrossRooftopWrite = await call(
        aurora.beta.seller.token,
        'POST',
        `/api/sales/opportunities/${atAlpha.opportunityId}/stage`,
        { expected_version: atAlpha.version, to_stage: 'in_showroom' },
      );
      assert.equal(acrossRooftopWrite.status, 404, JSON.stringify(acrossRooftopWrite.body));

      // ANOTHER DEALERSHIP CANNOT SEE IT AT ALL.
      const acrossTenant = await call(
        borealis.principal.token,
        'GET',
        `/api/sales/opportunities/${atAlpha.opportunityId}`,
      );
      assert.equal(acrossTenant.status, 404, JSON.stringify(acrossTenant.body));

      // …and the board a neighbour reads contains none of it.
      const neighbourBoard = await call(borealis.principal.token, 'GET', '/api/sales/board');
      assert.equal(neighbourBoard.status, 200);
      assert.equal(Number(neighbourBoard.body!.pipeline.open), 0);
      assert.doesNotMatch(JSON.stringify(neighbourBoard.body), new RegExp(atAlpha.opportunityId));

      // ALPHA'S MANAGER CANNOT PUT BETA'S SALESPERSON ON A DEAL. Assignment
      // reaches through the org tree, and Beta is not under Alpha.
      const wrongPerson = await call(
        aurora.alpha.manager.token,
        'POST',
        `/api/sales/opportunities/${atAlpha.opportunityId}/assignment`,
        { expected_version: atAlpha.version, to_user_link_id: aurora.beta.seller.userLinkId },
      );
      assert.equal(wrongPerson.status, 422, JSON.stringify(wrongPerson.body));
      assert.match(String(wrongPerson.body!.detail), /rooftop|reach/i);

      // …and their own salesperson can be assigned, so the refusal was real.
      const rightPerson = await call(
        aurora.alpha.manager.token,
        'POST',
        `/api/sales/opportunities/${atAlpha.opportunityId}/assignment`,
        { expected_version: atAlpha.version, to_user_link_id: aurora.alpha.seller.userLinkId },
      );
      assert.equal(rightPerson.status, 200, JSON.stringify(rightPerson.body));

      // A SALESPERSON IS NOT A MANAGER. Assignment is a manager's decision, and
      // because the action NAMES a resource the denial is 404 — telling a
      // salesperson "forbidden" would confirm the opportunity exists, which is
      // the enumeration this platform refuses everywhere else.
      const notAManager = await call(
        aurora.alpha.seller.token,
        'POST',
        `/api/sales/opportunities/${atAlpha.opportunityId}/assignment`,
        { expected_version: 2, to_user_link_id: aurora.alpha.seller.userLinkId },
      );
      assert.equal(notAManager.status, 404, JSON.stringify(notAManager.body));

      // …nor can they open or close the floor rotation.
      const notTheirFloor = await call(
        aurora.alpha.seller.token,
        'POST',
        '/api/sales/floor',
        { location_id: aurora.alpha.rooftopId, user_link_id: aurora.alpha.seller.userLinkId },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(notTheirFloor.status, 403, JSON.stringify(notTheirFloor.body));

      // A COMMAND THAT NAMES NO RESOURCE STILL BELONGS TO A ROOFTOP. Putting
      // somebody on the floor, taking them off it and recording an arrival all
      // CREATE a row, so there is no resource for the policy engine to resolve
      // and the rooftop arrives as a plain field in the body.
      //
      // THROUGH THIS SURFACE THE ENGINE GETS THERE FIRST, and the denial is 403
      // rather than 404: the middleware turns that `location_id` into the scope
      // hint, and a rooftop-bound manager naming another rooftop is outside
      // their scope before any service runs. The services check it a SECOND
      // time, for callers who never come through here — a worker, a script,
      // another package — and `tests/sales-floor.test.ts` proves that half by
      // calling them directly. Both halves are asserted rather than one assumed
      // to imply the other.
      const otherFloor = await call(
        aurora.alpha.manager.token,
        'POST',
        '/api/sales/floor',
        { location_id: aurora.beta.rooftopId, user_link_id: aurora.beta.seller.userLinkId },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(otherFloor.status, 403, JSON.stringify(otherFloor.body));
      assert.equal(otherFloor.body!.errors.required_action, 'sales.floor.manage');

      const otherRelease = await call(
        aurora.alpha.manager.token,
        'POST',
        '/api/sales/floor/release',
        {
          location_id: aurora.beta.rooftopId,
          user_link_id: aurora.beta.seller.userLinkId,
        },
      );
      assert.equal(otherRelease.status, 403, JSON.stringify(otherRelease.body));

      const otherArrival = await call(
        aurora.alpha.manager.token,
        'POST',
        '/api/sales/visits',
        { location_id: aurora.beta.rooftopId, party_id: atAlpha.partyId },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(otherArrival.status, 403, JSON.stringify(otherArrival.body));

      // …and the same three commands at their OWN rooftop work, so the refusals
      // above were about the rooftop and not about the command being broken.
      const ownFloor = await call(
        aurora.alpha.manager.token,
        'POST',
        '/api/sales/floor',
        { location_id: aurora.alpha.rooftopId, user_link_id: aurora.alpha.seller.userLinkId },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(ownFloor.status, 201, JSON.stringify(ownFloor.body));

      // NOTHING WAS PLANTED AT THE OTHER ROOFTOP by the refused calls.
      const betaFloor = await query(
        `SELECT COUNT(*)::int AS n FROM floor_rotations WHERE rooftop_id = $1`,
        [aurora.beta.rooftopId],
      );
      assert.equal(Number((betaFloor.rows[0] as { n: number }).n), 0);
      const betaVisits = await query(
        `SELECT COUNT(*)::int AS n FROM showroom_visits WHERE rooftop_id = $1`,
        [aurora.beta.rooftopId],
      );
      assert.equal(Number((betaVisits.rows[0] as { n: number }).n), 0);

      // AND SOMEBODY WITH NO SALES ROLE AT ALL IS REFUSED THE WHOLE SURFACE.
      const outsider = await call(aurora.tokens.inventory, 'GET', '/api/sales/board');
      assert.equal(outsider.status, 403, JSON.stringify(outsider.body));
    });

    test('a word this platform does not know is the caller’s mistake, never a 500', async () => {
      const d = await seedDealership('Aurora');
      const t = d.principal.token;
      const opp = await opportunityAt(d, d.alpha.rooftopId, d.alpha.seller.userLinkId);
      const car = await carAt(d, d.alpha.rooftopId, '1HGCM82633A004352');
      const short = await call(
        t,
        'POST',
        `/api/sales/opportunities/${opp.opportunityId}/vehicles`,
        { stock_item_id: car },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(short.status, 201, JSON.stringify(short.body));
      const vehicleId = String(short.body!.vehicle.opportunityVehicleId);

      // EVERY ENUMERATED FIELD ON THIS SURFACE, given a word the platform does
      // not use. Each column is ALSO constrained in migration 064, so none of
      // these could ever be stored — the point is what the caller is TOLD. A
      // value that travels to a CHECK constraint comes back as "Internal Server
      // Error", which reads as "the platform broke" and takes a database log to
      // diagnose; the service knowing its own vocabulary makes it a 422 that
      // names the field and lists the words.
      const nonsense: Array<[string, string, unknown]> = [
        [
          'stage',
          `/api/sales/opportunities/${opp.opportunityId}/stage`,
          {
            expected_version: opp.version,
            to_stage: 'haggling',
          },
        ],
        [
          'disposition',
          `/api/sales/opportunities/${opp.opportunityId}/stage`,
          {
            expected_version: opp.version,
            to_stage: 'lost',
            disposition: 'changed_their_mind',
          },
        ],
        [
          'vehicle status',
          `/api/sales/opportunities/${opp.opportunityId}/vehicles/${vehicleId}/status`,
          {
            expected_version: 1,
            status: 'maybe',
          },
        ],
        [
          'activity kind',
          `/api/sales/opportunities/${opp.opportunityId}/activities`,
          {
            kind: 'carrier_pigeon',
            subject: 'hello',
          },
        ],
        [
          'activity direction',
          `/api/sales/opportunities/${opp.opportunityId}/activities`,
          {
            kind: 'call',
            direction: 'sideways',
            subject: 'hello',
          },
        ],
        [
          'negotiation initiator',
          `/api/sales/opportunities/${opp.opportunityId}/negotiation`,
          {
            initiated_by: 'the weather',
            summary: 'talked',
            outcome: 'countered',
          },
        ],
        [
          'negotiation outcome',
          `/api/sales/opportunities/${opp.opportunityId}/negotiation`,
          {
            initiated_by: 'customer',
            summary: 'talked',
            outcome: 'vibes',
          },
        ],
        [
          'turnover reason',
          `/api/sales/opportunities/${opp.opportunityId}/turnover`,
          {
            manager_user_link_id: d.alpha.manager.userLinkId,
            reason: 'because',
          },
        ],
      ];

      for (const [what, path, payload] of nonsense) {
        const res = await call(t, 'POST', path, payload, { 'idempotency-key': randomUUID() });
        assert.equal(res.status, 422, `${what}: ${res.status} ${JSON.stringify(res.body)}`);
        assert.equal(res.body!.code, 'invalid_request', what);
        assert.match(res.contentType, /application\/problem\+json/, what);
      }

      // …and an assignment reason, which is a manager's command.
      //
      // AIMED AT SOMEBODY WHO DOES NOT ALREADY OWN IT. Receipt establishes the
      // owner now, and assigning it to whoever already has it answers
      // `already_assigned` BEFORE the vocabulary is read — which is right, and
      // which would make this probe pass for the wrong reason.
      const badReason = await call(
        d.alpha.manager.token,
        'POST',
        `/api/sales/opportunities/${opp.opportunityId}/assignment`,
        {
          expected_version: opp.version,
          to_user_link_id: d.alpha.otherSeller.userLinkId,
          reason: 'felt like it',
        },
      );
      assert.equal(badReason.status, 422, JSON.stringify(badReason.body));

      // NOTHING WAS WRITTEN by any of them.
      const rounds = await query(
        `SELECT COUNT(*)::int AS n FROM negotiation_rounds WHERE tenant_id = $1`,
        [d.tenantId],
      );
      assert.equal(Number((rounds.rows[0] as { n: number }).n), 0);
      const acts = await query(
        `SELECT COUNT(*)::int AS n FROM opportunity_activities WHERE tenant_id = $1`,
        [d.tenantId],
      );
      assert.equal(Number((acts.rows[0] as { n: number }).n), 0);
      const stage = await query(`SELECT stage FROM opportunities WHERE opportunity_id = $1`, [
        opp.opportunityId,
      ]);
      assert.equal(String((stage.rows[0] as { stage: string }).stage), 'received');
    });

    test('pre-sale money is unrepresentable — the database refuses it, by name', async () => {
      const d = await seedDealership('Aurora');
      const opp = await opportunityAt(d, d.alpha.rooftopId, d.alpha.seller.userLinkId);

      // ── the opportunity ──────────────────────────────────────────────────
      // `deal_status` may not be flipped to AVAILABLE before FBL-120 exists.
      // THIS WRITE GOES ROUND EVERY SERVICE ON PURPOSE. The claim being tested
      // is not "the API declines to set this" — it is that the DATABASE refuses
      // it even when the caller is inside the box with a direct connection, so
      // the bypass is declared as the adversary it is standing in for.
      await assert.rejects(
        () =>
          fixtureAuthorizationStateWrite(
            'adversarial-bypass-attempt',
            `UPDATE opportunities SET deal_status = 'AVAILABLE' WHERE opportunity_id = $1`,
            [opp.opportunityId],
          ),
        /ck_opportunity_pre_deal/,
        'a deal became available with no desking to make it one',
      );

      // ── the negotiation ──────────────────────────────────────────────────
      const round = await call(
        d.principal.token,
        'POST',
        `/api/sales/opportunities/${opp.opportunityId}/negotiation`,
        { initiated_by: 'customer', summary: 'asked about the payment', outcome: 'countered' },
      );
      assert.equal(round.status, 201, JSON.stringify(round.body));

      await assert.rejects(
        () =>
          fixtureAuthorizationStateWrite(
            'adversarial-bypass-attempt',
            `UPDATE negotiation_rounds SET pricing_status = 'AVAILABLE' WHERE tenant_id = $1`,
            [d.tenantId],
          ),
        /ck_negotiation_pre_desking/,
        'a negotiation round started carrying a price',
      );

      // THERE IS NO MONEY COLUMN TO SET IN THE FIRST PLACE. A constraint on a
      // column that exists is one migration away from being dropped; a column
      // that was never added cannot be filled by accident.
      const columns = await query(
        `SELECT table_name, column_name FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name IN ('opportunities', 'negotiation_rounds', 'opportunity_vehicles',
                               'demonstrations', 'showroom_visits', 'manager_turnovers',
                               'desking_handoffs', 'opportunity_vehicle_events',
                               'demonstration_events')
            AND (column_name LIKE '%cents%' OR column_name LIKE '%price%'
                 OR column_name LIKE '%amount%' OR column_name LIKE '%gross%'
                 OR column_name LIKE '%commission%' OR column_name LIKE '%revenue%')`,
      );
      assert.deepEqual(
        columns.rows,
        [],
        `RT4 grew a money column: ${JSON.stringify(columns.rows)}`,
      );

      // ── and the constraints are really there, under those names ───────────
      const named = await query(
        `SELECT conname FROM pg_constraint
          WHERE conname IN ('ck_opportunity_pre_deal', 'ck_negotiation_pre_desking',
                            'ck_desking_pre_fbl120')
          ORDER BY conname`,
      );
      assert.deepEqual(
        (named.rows as Array<{ conname: string }>).map((r) => r.conname),
        ['ck_desking_pre_fbl120', 'ck_negotiation_pre_desking', 'ck_opportunity_pre_deal'],
        'the prohibition is structural, not a comment',
      );

      // ── AND THERE IS NO `won` STAGE OR `sold` DISPOSITION LEFT TO REACH ────
      //
      // The order removed the endpoint; this checks the DATABASE removed the
      // vocabulary, so no future caller — a script, a repair, a service written
      // next year — can record a sale this platform cannot substantiate.
      const vocab = await query(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conrelid = 'opportunities'::regclass AND contype = 'c'`,
      );
      const defs = (vocab.rows as Array<{ def: string }>).map((r) => r.def).join(' ');
      assert.doesNotMatch(defs, /'won'/, 'a `won` stage is still reachable');
      assert.doesNotMatch(defs, /'sold'/, 'a `sold` disposition is still reachable');

      // ── RT3's own prohibition still holds, untouched by this train ────────
      const rt3 = await query(
        `SELECT conname FROM pg_constraint WHERE conname = 'ck_attribution_pre_sale_revenue'`,
      );
      assert.equal(rt3.rows.length, 1, 'Release Train 3’s revenue constraint survived RT4');
    });
  },
);
