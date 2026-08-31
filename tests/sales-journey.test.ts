import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, beforeEach, describe, test } from 'node:test';
import {
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
 * RELEASE TRAIN 4 — THE SHOWROOM JOURNEY, through the real HTTP stack against a
 * real database.
 *
 * A customer the BDC already spoke to walks in. One salesperson takes the whole
 * journey: the up rotation gives them the turn, they greet the arrival, receive
 * the opportunity handed over from CRM, shortlist two cars off the real
 * inventory, take one out on a demonstration, record what the customer said,
 * bring a manager in, and close the visit — and the manager's board reflects all
 * of it with no money anywhere in sight.
 *
 * THE REFUSALS ARE ASSERTED AS HARD AS THE SUCCESSES. A journey that only walks
 * the happy path proves the platform cannot say no.
 */
describe(
  'sales: the showroom journey (RT4)',
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
        replayed: res.headers.get('idempotency-replayed') === 'true',
        body: text ? (JSON.parse(text) as ParsedJson) : null,
      };
    }

    function assertProblem(
      res: { status: number; contentType: string; body: ParsedJson },
      status: number,
      code: string,
    ): void {
      assert.equal(res.status, status, JSON.stringify(res.body));
      assert.match(res.contentType, /application\/problem\+json/);
      assert.equal(res.body!.code, code, JSON.stringify(res.body));
    }

    interface World {
      tenantId: string;
      rooftopId: string;
      secondRooftopId: string;
      manager: { userLinkId: string; token: string };
      seller: { userLinkId: string; token: string };
      other: { userLinkId: string; token: string };
      bdc: { userLinkId: string; token: string };
      marketing: { userLinkId: string; token: string };
      inventory: { userLinkId: string; token: string };
    }

    async function seedWorld(): Promise<World> {
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
      const second = await seedRooftop({
        tenantId,
        legalEntityId: entity.legalEntityId,
        name: 'Northside',
        status: 'active',
      });
      const manager = await seedActor(env.issuer, { tenantId, roles: [ROLES.SALES_MANAGER] });
      const seller = await seedActor(env.issuer, { tenantId, roles: [ROLES.SALESPERSON] });
      const other = await seedActor(env.issuer, { tenantId, roles: [ROLES.SALESPERSON] });
      const bdc = await seedActor(env.issuer, { tenantId, roles: [ROLES.BDC_AGENT] });
      const marketing = await seedActor(env.issuer, {
        tenantId,
        roles: [ROLES.MARKETING_MANAGER],
      });
      const inventory = await seedActor(env.issuer, {
        tenantId,
        roles: [ROLES.INVENTORY_MANAGER],
      });
      return {
        tenantId,
        rooftopId: rooftop.rooftopId,
        secondRooftopId: second.rooftopId,
        manager: { userLinkId: manager.userLinkId, token: manager.token },
        seller: { userLinkId: seller.userLinkId, token: seller.token },
        other: { userLinkId: other.userLinkId, token: other.token },
        bdc: { userLinkId: bdc.userLinkId, token: bdc.token },
        marketing: { userLinkId: marketing.userLinkId, token: marketing.token },
        inventory: { userLinkId: inventory.userLinkId, token: inventory.token },
      };
    }

    /**
     * A lead captured by the BDC and handed to sales — the ONLY door into the
     * pipeline. The journey uses the real CRM surface rather than planting rows,
     * because the seam between the two trains is part of what is being proven.
     */
    async function handOffALead(
      w: World,
      opts: { rooftopId?: string; email?: string; intakeKey?: string } = {},
    ): Promise<{
      handoffId: string;
      leadId: string;
      partyId: string;
      appointmentId: string;
    }> {
      const rooftopId = opts.rooftopId ?? w.rooftopId;
      const t = w.bdc.token;
      const source = await call(
        w.marketing.token,
        'POST',
        '/api/crm/sources',
        { source_code: 'website', display_name: 'Website', channel: 'web', medium: 'organic' },
        { 'idempotency-key': randomUUID() },
      );
      assert.ok(
        source.status === 201 || source.status === 200 || source.status === 409,
        `source: ${source.status} ${JSON.stringify(source.body)}`,
      );

      const captured = await call(
        t,
        'POST',
        '/api/crm/leads',
        {
          location_id: rooftopId,
          intake_key: opts.intakeKey ?? `web-${randomUUID()}`,
          channel: 'website',
          source_code: 'website',
          customer: {
            given_name: 'Marta',
            family_name: 'Silva',
            email: opts.email ?? `marta.${randomUUID()}@example.com`,
          },
        },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(captured.status, 201, JSON.stringify(captured.body));
      const leadId = String(captured.body!.lead.leadId);
      const partyId = String(captured.body!.lead.partyId);

      let version = Number(captured.body!.lead.authorizationVersion);
      for (const state of ['working', 'qualified']) {
        const moved = await call(t, 'POST', `/api/crm/leads/${leadId}/transition`, {
          expected_version: version,
          to_state: state,
        });
        assert.equal(moved.status, 200, `${state}: ${JSON.stringify(moved.body)}`);
        version = Number(moved.body!.lead.authorizationVersion);
      }

      // FBL-100 STARTS AT THE APPOINTMENT. The BDC books it before handing over,
      // and the showroom's arrival is recorded against that booking rather than
      // against nothing — which is what makes a kept appointment countable.
      const starts = new Date(Date.now() + 3_600_000);
      const booked = await call(
        t,
        'POST',
        `/api/crm/leads/${leadId}/appointments`,
        {
          purpose: 'test_drive',
          starts_at: starts.toISOString(),
          ends_at: new Date(starts.getTime() + 3_600_000).toISOString(),
        },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(booked.status, 201, JSON.stringify(booked.body));
      const appointmentId = String(booked.body!.appointment.appointmentId);
      version = Number(booked.body!.lead.authorizationVersion);

      const handed = await call(
        t,
        'POST',
        `/api/crm/leads/${leadId}/handoff`,
        {
          expected_version: version,
          handed_to_user_link_id: w.seller.userLinkId,
        },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(handed.status, 201, JSON.stringify(handed.body));
      return { handoffId: String(handed.body!.handoffId), leadId, partyId, appointmentId };
    }

    /** A real car on a real rooftop, acquired through the RT2 surface. */
    async function acquireCar(
      w: World,
      vin: string,
      stockNumber: string,
      rooftopId = w.rooftopId,
    ): Promise<string> {
      const t = w.inventory.token;
      const seller = await call(
        t,
        'POST',
        '/api/inventory/parties',
        {
          party_type: 'person',
          given_name: 'Trade',
          family_name: `In${stockNumber}`,
          email: `trade.${stockNumber.toLowerCase()}@example.com`,
        },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(seller.status, 201, JSON.stringify(seller.body));
      const acquired = await call(
        t,
        'POST',
        '/api/inventory/stock',
        {
          location_id: rooftopId,
          vin,
          stock_number: stockNumber,
          acquisition_source: 'trade_in',
          acquired_on: '2026-08-01',
          acquisition_party_id: String(seller.body!.party.partyId),
          odometer: 30000,
        },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(acquired.status, 201, JSON.stringify(acquired.body));
      return String(acquired.body!.stockItem.stockItemId);
    }

    async function auditCount(tenantId: string, eventType: string): Promise<number> {
      const r = await query(
        `SELECT COUNT(*)::int AS n FROM audit_events WHERE tenant_id = $1 AND event_type = $2`,
        [tenantId, eventType],
      );
      return Number((r.rows[0] as { n: number }).n);
    }

    test('a walk-in is greeted, sold to, demonstrated, negotiated and closed', async () => {
      const w = await seedWorld();
      const t = w.seller.token;

      // ── the up rotation ───────────────────────────────────────────────────
      const onFloor = await call(
        w.manager.token,
        'POST',
        '/api/sales/floor',
        { location_id: w.rooftopId, user_link_id: w.seller.userLinkId },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(onFloor.status, 201, JSON.stringify(onFloor.body));
      assert.equal(onFloor.body!.entry.status, 'available');

      // Twice on the floor is still ONCE on the floor.
      const twice = await call(
        w.manager.token,
        'POST',
        '/api/sales/floor',
        { location_id: w.rooftopId, user_link_id: w.seller.userLinkId },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(twice.status, 200);
      assert.equal(twice.body!.outcome, 'already_on_the_floor');

      // ── the arrival ───────────────────────────────────────────────────────
      const lead = await handOffALead(w);
      const arrived = await call(
        t,
        'POST',
        '/api/sales/visits',
        {
          location_id: w.rooftopId,
          party_id: lead.partyId,
          appointment_id: lead.appointmentId,
        },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(arrived.status, 201, JSON.stringify(arrived.body));
      assert.equal(
        arrived.body!.visit.appointmentId,
        lead.appointmentId,
        'the arrival is against the booking, so a kept appointment is countable',
      );
      const visitId = String(arrived.body!.visit.visitId);
      assert.equal(arrived.body!.visit.state, 'arrived');
      assert.equal(arrived.body!.visit.greetedByUserLinkId, null);

      // SOMEBODY ELSE'S BOOKING IS NOT THIS CUSTOMER'S ARRIVAL. Accepting it
      // would put a kept appointment against a person who never had one.
      const otherBooking = await handOffALead(w, {
        email: `booking.${randomUUID()}@example.com`,
      });
      const wrongPerson = await call(
        t,
        'POST',
        '/api/sales/visits',
        {
          location_id: w.rooftopId,
          party_id: lead.partyId,
          appointment_id: otherBooking.appointmentId,
        },
        { 'idempotency-key': randomUUID() },
      );
      assertProblem(wrongPerson, 422, 'invalid_request');
      assert.match(String(wrongPerson.body!.detail), /somebody else/i);

      // …and a booking made at another showroom is not an arrival at this one.
      const otherLot = await handOffALead(w, {
        rooftopId: w.secondRooftopId,
        email: `north.${randomUUID()}@example.com`,
      });
      const wrongLotBooking = await call(
        t,
        'POST',
        '/api/sales/visits',
        {
          location_id: w.rooftopId,
          party_id: otherLot.partyId,
          appointment_id: otherLot.appointmentId,
        },
        { 'idempotency-key': randomUUID() },
      );
      assertProblem(wrongLotBooking, 422, 'invalid_request');
      assert.match(String(wrongLotBooking.body!.detail), /different rooftop/i);

      // GREETING TAKES THE TURN. The rotation decides who, not the caller.
      const greeted = await call(t, 'POST', `/api/sales/visits/${visitId}/greet`, {
        expected_version: Number(arrived.body!.visit.authorizationVersion),
      });
      assert.equal(greeted.status, 200, JSON.stringify(greeted.body));
      assert.equal(greeted.body!.visit.state, 'greeted');
      assert.equal(greeted.body!.greetedBy, w.seller.userLinkId);
      assert.equal(greeted.body!.fromRotation, true, 'the up system gave the turn');

      // …and that salesperson is now busy, not waiting for another customer.
      // A FLOOR READ NAMES ITS SHOWROOM. Asking for "the" floor when you can
      // reach two of them is a question with no answer, and it is refused.
      const unnamed = await call(w.manager.token, 'GET', '/api/sales/floor');
      assertProblem(unnamed, 400, 'location_required');

      const floor = await call(
        w.manager.token,
        'GET',
        `/api/sales/floor?location_id=${w.rooftopId}`,
      );
      assert.equal(floor.status, 200, JSON.stringify(floor.body));
      const mine = (floor.body!.floor as ParsedJson[]).find(
        (e) => String(e.userLinkId) === w.seller.userLinkId,
      );
      assert.equal(String(mine!.status), 'with_customer');

      // ── the opportunity, received from CRM ────────────────────────────────
      const opp = await call(
        t,
        'POST',
        '/api/sales/opportunities',
        { handoff_id: lead.handoffId },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(opp.status, 201, JSON.stringify(opp.body));
      const opportunityId = String(opp.body!.opportunity.opportunityId);
      assert.equal(opp.body!.opportunity.stage, 'received');
      assert.equal(
        opp.body!.opportunity.partyId,
        lead.partyId,
        'the customer came from the handoff, not from the request',
      );
      assert.equal(opp.body!.opportunity.rooftopId, w.rooftopId);
      assert.equal(
        opp.body!.opportunity.dealStatus,
        'NOT_YET_AVAILABLE',
        'no deal exists until FBL-120 desks one',
      );

      // ONE OPPORTUNITY PER HANDOFF, even from a different salesperson.
      const dup = await call(
        w.other.token,
        'POST',
        '/api/sales/opportunities',
        { handoff_id: lead.handoffId },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(dup.status, 200);
      assert.equal(dup.body!.outcome, 'already_received');
      assert.equal(dup.body!.opportunity.opportunityId, opportunityId);

      // ── the shortlist, off the real inventory ─────────────────────────────
      const carA = await acquireCar(w, '1HGCM82633A004352', 'A1234');
      const carB = await acquireCar(w, '2HGCM82633A004353', 'B5678');

      const shortA = await call(
        t,
        'POST',
        `/api/sales/opportunities/${opportunityId}/vehicles`,
        { stock_item_id: carA, rank: 1 },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(shortA.status, 201, JSON.stringify(shortA.body));
      const shortAId = String(shortA.body!.vehicle.opportunityVehicleId);
      const shortB = await call(
        t,
        'POST',
        `/api/sales/opportunities/${opportunityId}/vehicles`,
        { stock_item_id: carB, rank: 2 },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(shortB.status, 201);
      const shortBId = String(shortB.body!.vehicle.opportunityVehicleId);

      // A CAR AT ANOTHER ROOFTOP IS NOT ON THIS LOT and cannot be shortlisted.
      const elsewhere = await acquireCar(w, '3HGCM82633A004354', 'C9012', w.secondRooftopId);
      const wrongLot = await call(
        t,
        'POST',
        `/api/sales/opportunities/${opportunityId}/vehicles`,
        { stock_item_id: elsewhere },
        { 'idempotency-key': randomUUID() },
      );
      assertProblem(wrongLot, 422, 'invalid_request');
      assert.match(String(wrongLot.body!.detail), /rooftop/i);

      // ── the demonstration ─────────────────────────────────────────────────
      // WITHOUT A LICENCE CHECK, NO CAR LEAVES THE LOT.
      const noLicence = await call(
        t,
        'POST',
        `/api/sales/opportunities/${opportunityId}/demonstrations`,
        { stock_item_id: carA, driver_party_id: lead.partyId, licence_verified: false },
        { 'idempotency-key': randomUUID() },
      );
      assertProblem(noLicence, 422, 'invalid_request');
      assert.match(String(noLicence.body!.detail), /licen/i);

      const drive = await call(
        t,
        'POST',
        `/api/sales/opportunities/${opportunityId}/demonstrations`,
        {
          stock_item_id: carA,
          driver_party_id: lead.partyId,
          licence_verified: true,
          visit_id: visitId,
        },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(drive.status, 201, JSON.stringify(drive.body));
      const demonstrationId = String(drive.body!.demonstration.demonstrationId);
      assert.equal(drive.body!.demonstration.state, 'in_progress');

      // THE SAME CAR CANNOT BE OUT TWICE. Another customer's opportunity asks
      // for it and is refused with the demonstration that already has it.
      const second = await handOffALead(w, { email: `other.${randomUUID()}@example.com` });
      const secondOpp = await call(
        w.other.token,
        'POST',
        '/api/sales/opportunities',
        { handoff_id: second.handoffId },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(secondOpp.status, 201);
      const secondOppId = String(secondOpp.body!.opportunity.opportunityId);
      await call(
        w.other.token,
        'POST',
        `/api/sales/opportunities/${secondOppId}/vehicles`,
        { stock_item_id: carA },
        { 'idempotency-key': randomUUID() },
      );
      const clash = await call(
        w.other.token,
        'POST',
        `/api/sales/opportunities/${secondOppId}/demonstrations`,
        { stock_item_id: carA, driver_party_id: second.partyId, licence_verified: true },
        { 'idempotency-key': randomUUID() },
      );
      assertProblem(clash, 409, 'vehicle_out');
      assert.equal(clash.body!.errors.demonstration_id, demonstrationId);

      // AN UNKNOWN VERDICT IS THE CALLER'S MISTAKE, not a server failure.
      const nonsense = await call(
        t,
        'POST',
        `/api/sales/opportunities/${opportunityId}/demonstrations/${demonstrationId}/end`,
        {
          expected_version: Number(drive.body!.demonstration.authorizationVersion),
          state: 'completed',
          outcome: 'positive',
        },
      );
      assertProblem(nonsense, 422, 'invalid_request');

      const back = await call(
        t,
        'POST',
        `/api/sales/opportunities/${opportunityId}/demonstrations/${demonstrationId}/end`,
        {
          expected_version: Number(drive.body!.demonstration.authorizationVersion),
          state: 'completed',
          outcome: 'interested',
          notes: 'liked the ride, wants the other colour',
        },
      );
      assert.equal(back.status, 200, JSON.stringify(back.body));
      assert.equal(back.body!.demonstration.state, 'completed');
      assert.equal(back.body!.demonstration.outcome, 'interested');

      // …and the car is available to demonstrate again now it is back.
      const nowFree = await call(
        w.other.token,
        'POST',
        `/api/sales/opportunities/${secondOppId}/demonstrations`,
        { stock_item_id: carA, driver_party_id: second.partyId, licence_verified: true },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(nowFree.status, 201, JSON.stringify(nowFree.body));

      // ── the selection ─────────────────────────────────────────────────────
      // The drive already advanced car A's shortlist row to `demonstrated`, so
      // the versions the caller holds are stale — exactly as a screen's would
      // be. Re-read before writing, which is what the console does.
      const fresh = await call(t, 'GET', `/api/sales/opportunities/${opportunityId}`);
      const rowsNow = fresh.body!.shortlist as ParsedJson[];
      const versionOf = (id: string): number =>
        Number(rowsNow.find((v) => String(v.opportunityVehicleId) === id)!.authorizationVersion);
      assert.equal(
        String(rowsNow.find((v) => String(v.opportunityVehicleId) === shortAId)!.status),
        'demonstrated',
        'driving a car says so on the shortlist without anybody typing it',
      );

      const selected = await call(
        t,
        'POST',
        `/api/sales/opportunities/${opportunityId}/vehicles/${shortBId}/status`,
        {
          expected_version: versionOf(shortBId),
          status: 'selected',
        },
      );
      assert.equal(selected.status, 200, JSON.stringify(selected.body));
      assert.equal(selected.body!.vehicle.status, 'selected');

      // A SECOND SELECTION STANDS THE FIRST ONE DOWN rather than being refused
      // — a customer changing their mind is normal, two selected cars are not.
      const changed = await call(
        t,
        'POST',
        `/api/sales/opportunities/${opportunityId}/vehicles/${shortAId}/status`,
        {
          expected_version: versionOf(shortAId),
          status: 'selected',
        },
      );
      assert.equal(changed.status, 200, JSON.stringify(changed.body));
      const shortlist = await call(t, 'GET', `/api/sales/opportunities/${opportunityId}`);
      const selectedRows = (shortlist.body!.shortlist as ParsedJson[]).filter(
        (v) => String(v.status) === 'selected',
      );
      assert.equal(selectedRows.length, 1, 'exactly one car is the one they want');
      assert.equal(String(selectedRows[0]!.opportunityVehicleId), shortAId);

      // ── negotiation, and the manager ──────────────────────────────────────
      const round = await call(t, 'POST', `/api/sales/opportunities/${opportunityId}/negotiation`, {
        initiated_by: 'customer',
        summary: 'asked what could be done on the trade',
        manager_involved: false,
        outcome: 'countered',
      });
      assert.equal(round.status, 201, JSON.stringify(round.body));
      assert.equal(round.body!.round.roundNumber, 1);
      assert.equal(
        round.body!.round.pricingStatus,
        'NOT_YET_AVAILABLE',
        'a negotiation carries what was SAID; the numbers belong to desking',
      );

      const turnover = await call(t, 'POST', `/api/sales/opportunities/${opportunityId}/turnover`, {
        manager_user_link_id: w.manager.userLinkId,
        reason: 'second_voice',
        visit_id: visitId,
        note: 'wants reassurance on the warranty',
      });
      assert.equal(turnover.status, 201, JSON.stringify(turnover.body));

      // NOBODY TURNS A DEAL OVER TO THEMSELVES.
      const self = await call(t, 'POST', `/api/sales/opportunities/${opportunityId}/turnover`, {
        manager_user_link_id: w.seller.userLinkId,
        reason: 'second_voice',
      });
      assertProblem(self, 422, 'invalid_request');

      // ── the stage machine ─────────────────────────────────────────────────
      const current = await call(t, 'GET', `/api/sales/opportunities/${opportunityId}`);
      let version = Number(current.body!.opportunity.authorizationVersion);
      for (const stage of ['in_showroom', 'demonstrated', 'negotiating']) {
        const moved = await call(t, 'POST', `/api/sales/opportunities/${opportunityId}/stage`, {
          expected_version: version,
          to_stage: stage,
        });
        assert.equal(moved.status, 200, `${stage}: ${JSON.stringify(moved.body)}`);
        assert.equal(moved.body!.opportunity.stage, stage);
        version = Number(moved.body!.opportunity.authorizationVersion);
      }

      // A STALE VERSION LOSES. Two people editing the same record is normal;
      // one of them silently overwriting the other is not.
      const stale = await call(t, 'POST', `/api/sales/opportunities/${opportunityId}/stage`, {
        expected_version: version - 1,
        to_stage: 'received',
      });
      assertProblem(stale, 409, 'version_conflict');

      // A MOVE THE MACHINE DOES NOT ADMIT IS REFUSED, not quietly allowed.
      const backwards = await call(t, 'POST', `/api/sales/opportunities/${opportunityId}/stage`, {
        expected_version: version,
        to_stage: 'received',
      });
      assertProblem(backwards, 422, 'invalid_request');
      assert.match(String(backwards.body!.detail), /may move to/);

      // A WIN STATES WHAT IT WAS. 'sold' is the only disposition a win takes.
      const wrongReason = await call(t, 'POST', `/api/sales/opportunities/${opportunityId}/stage`, {
        expected_version: version,
        to_stage: 'won',
        disposition: 'lost_to_competitor',
      });
      assertProblem(wrongReason, 422, 'invalid_request');

      // ── follow-up, and closing the visit ──────────────────────────────────
      // What HAPPENED is logged as what it was…
      const logged = await call(
        t,
        'POST',
        `/api/sales/opportunities/${opportunityId}/activities`,
        { kind: 'call', direction: 'outbound', subject: 'talked through the warranty' },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(logged.status, 201, JSON.stringify(logged.body));
      assert.equal(logged.body!.activity.dueAt, null);

      // …and a call that already happened cannot also be due later.
      const confused = await call(
        t,
        'POST',
        `/api/sales/opportunities/${opportunityId}/activities`,
        {
          kind: 'call',
          direction: 'outbound',
          subject: 'ring them Saturday',
          due_at: new Date(Date.now() + 86_400_000).toISOString(),
        },
        { 'idempotency-key': randomUUID() },
      );
      assertProblem(confused, 422, 'invalid_request');

      // What is still OWED is a task, and it carries the date.
      const activity = await call(
        t,
        'POST',
        `/api/sales/opportunities/${opportunityId}/activities`,
        {
          kind: 'task',
          subject: 'follow up on the warranty question',
          due_at: new Date(Date.now() + 86_400_000).toISOString(),
        },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(activity.status, 201, JSON.stringify(activity.body));
      assert.equal(activity.body!.activity.state, 'open');
      assert.ok(activity.body!.activity.dueAt !== null);

      const left = await call(t, 'POST', `/api/sales/visits/${visitId}/depart`, {
        expected_version: Number(greeted.body!.visit.authorizationVersion),
        note: 'coming back Saturday with their spouse',
      });
      assert.equal(left.status, 200, JSON.stringify(left.body));
      assert.equal(left.body!.visit.state, 'departed');

      // THE SALESPERSON GOES BACK ON THE FLOOR IN THE SAME BREATH — a floor
      // that leaks people is a floor that stops giving out turns.
      const afterFloor = await call(
        w.manager.token,
        'GET',
        `/api/sales/floor?location_id=${w.rooftopId}`,
      );
      const backOn = (afterFloor.body!.floor as ParsedJson[]).find(
        (e) => String(e.userLinkId) === w.seller.userLinkId,
      );
      assert.equal(String(backOn!.status), 'available');

      // ── the manager's board ───────────────────────────────────────────────
      const board = await call(w.manager.token, 'GET', '/api/sales/board');
      assert.equal(board.status, 200, JSON.stringify(board.body));
      assert.equal(Number(board.body!.pipeline.open), 2, 'two live opportunities');
      assert.equal(Number(board.body!.pipeline.negotiating), 1);
      assert.ok(Number(board.body!.activity.demonstrationsToday) >= 2);
      assert.equal(Number(board.body!.activity.negotiationRounds), 1);
      assert.equal(Number(board.body!.activity.turnovers), 1);
      assert.equal(Number(board.body!.showroom.departedToday), 1);
      assert.equal(Number(board.body!.floor.available), 1);

      // THE BOARD SAYS THE NUMBER DOES NOT EXIST YET. It does not report zero,
      // and there is no money field on it for anybody to misread.
      assert.equal(board.body!.dealStatus, 'NOT_YET_AVAILABLE');
      assert.equal(board.body!.pricingStatus, 'NOT_YET_AVAILABLE');
      assert.doesNotMatch(
        JSON.stringify(board.body),
        /cents|gross|revenue|commission|price/i,
        JSON.stringify(board.body),
      );

      // ── the trail ─────────────────────────────────────────────────────────
      for (const eventType of [
        'sales.opportunity.received',
        'sales.opportunity.stage_changed',
        'sales.visit.greeted',
        'sales.demonstration.started',
        'sales.demonstration.ended',
        'sales.negotiation.round_recorded',
        'sales.turnover.recorded',
      ]) {
        assert.ok(await auditCount(w.tenantId, eventType), `no audit row for ${eventType}`);
      }

      // NOT ONE AUDIT ROW CARRIES A PRICE OR A CONTACT DETAIL.
      const details = await query(
        `SELECT details::text AS d FROM audit_events
          WHERE tenant_id = $1 AND event_type LIKE 'sales.%'`,
        [w.tenantId],
      );
      for (const row of details.rows as Array<{ d: string }>) {
        assert.doesNotMatch(row.d, /cents|price|amount|@example\.com/i, row.d);
      }
    });

    test('a closed opportunity is closed: terminal states refuse further work', async () => {
      const w = await seedWorld();
      const t = w.seller.token;
      const lead = await handOffALead(w);
      const opp = await call(
        t,
        'POST',
        '/api/sales/opportunities',
        { handoff_id: lead.handoffId },
        { 'idempotency-key': randomUUID() },
      );
      const opportunityId = String(opp.body!.opportunity.opportunityId);

      const closed = await call(t, 'POST', `/api/sales/opportunities/${opportunityId}/stage`, {
        expected_version: Number(opp.body!.opportunity.authorizationVersion),
        to_stage: 'lost',
        disposition: 'lost_to_competitor',
        note: 'bought across the street',
      });
      assert.equal(closed.status, 200, JSON.stringify(closed.body));
      assert.equal(closed.body!.opportunity.stage, 'lost');
      assert.equal(closed.body!.opportunity.disposition, 'lost_to_competitor');
      const version = Number(closed.body!.opportunity.authorizationVersion);

      // A CLOSE WITHOUT A REASON IS NOT A CLOSE — proven on a second one.
      const other = await handOffALead(w, { email: `two.${randomUUID()}@example.com` });
      const opp2 = await call(
        t,
        'POST',
        '/api/sales/opportunities',
        { handoff_id: other.handoffId },
        { 'idempotency-key': randomUUID() },
      );
      const noReason = await call(
        t,
        'POST',
        `/api/sales/opportunities/${String(opp2.body!.opportunity.opportunityId)}/stage`,
        {
          expected_version: Number(opp2.body!.opportunity.authorizationVersion),
          to_stage: 'lost',
        },
      );
      assertProblem(noReason, 422, 'invalid_request');
      assert.match(String(noReason.body!.detail), /states why/i);

      // EVERY WRITE THROUGH THE CLOSED OPPORTUNITY IS REFUSED. Not the read.
      const car = await acquireCar(w, '1HGCM82633A004352', 'A1234');
      const shortlist = await call(
        t,
        'POST',
        `/api/sales/opportunities/${opportunityId}/vehicles`,
        { stock_item_id: car },
        { 'idempotency-key': randomUUID() },
      );
      assertProblem(shortlist, 422, 'invalid_request');
      assert.match(String(shortlist.body!.detail), /lost|finished|closed/i);

      const demo = await call(
        t,
        'POST',
        `/api/sales/opportunities/${opportunityId}/demonstrations`,
        { stock_item_id: car, driver_party_id: lead.partyId, licence_verified: true },
        { 'idempotency-key': randomUUID() },
      );
      assertProblem(demo, 422, 'invalid_request');

      const negotiation = await call(
        t,
        'POST',
        `/api/sales/opportunities/${opportunityId}/negotiation`,
        { initiated_by: 'customer', summary: 'one more try', outcome: 'countered' },
      );
      assertProblem(negotiation, 422, 'invalid_request');

      const assign = await call(
        w.manager.token,
        'POST',
        `/api/sales/opportunities/${opportunityId}/assignment`,
        { expected_version: version, to_user_link_id: w.other.userLinkId },
      );
      assertProblem(assign, 422, 'invalid_request');

      const stage = await call(t, 'POST', `/api/sales/opportunities/${opportunityId}/stage`, {
        expected_version: version,
        to_stage: 'negotiating',
      });
      assertProblem(stage, 422, 'invalid_request');

      // …and it is still READABLE, because history does not disappear.
      const read = await call(t, 'GET', `/api/sales/opportunities/${opportunityId}`);
      assert.equal(read.status, 200);
      assert.equal(read.body!.opportunity.stage, 'lost');
    });
  },
);
