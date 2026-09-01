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
 * A customer the BDC already spoke to arrives for their appointment. TWO PEOPLE
 * work them: a salesperson takes the journey, and a manager does the things
 * only a manager can — reassignment and the board. Everything is DISCOVERED
 * rather than typed: the handoff comes off a list, the customer off a search,
 * the car off a rooftop-filtered chooser, the colleague off a staff list.
 *
 * THE REFUSALS ARE ASSERTED AS HARD AS THE SUCCESSES, and so are the CONVERGENCES:
 * a retry that arrives with a fresh request key is invisible to the idempotency
 * layer and must still be safe.
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
      // TWO SEPARATE, ELIGIBLE IDENTITIES. The manager holds only manager
      // authority and the salespeople only theirs, so an assignment or a
      // turnover in this journey is a real crossing between two people rather
      // than one account with every role wearing two hats.
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
     * A lead captured by the BDC, given an appointment and handed to sales.
     * Driven through the real CRM surface, because the seam between the two
     * trains is part of what is being proven.
     */
    async function handOffALead(
      w: World,
      opts: { rooftopId?: string; email?: string; handTo?: string } = {},
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
          intake_key: `web-${randomUUID()}`,
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
      // and the showroom's check-in is recorded against that booking — which is
      // what makes a kept appointment countable.
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
          handed_to_user_link_id: opts.handTo ?? w.seller.userLinkId,
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

    test('an expected customer arrives, is sold to, and is handed to desking', async () => {
      const w = await seedWorld();
      const t = w.seller.token;
      const lead = await handOffALead(w);
      const carA = await acquireCar(w, '1HGCM82633A004352', 'A1234');
      const carB = await acquireCar(w, '2HGCM82633A004353', 'B5678');

      // ── the up rotation ───────────────────────────────────────────────────
      // The manager picks the salesperson off the staff list rather than typing
      // an id — and the list only offers people whose bindings reach this floor.
      const staff = await call(
        w.manager.token,
        'GET',
        `/api/sales/find/staff?location_id=${w.rooftopId}`,
      );
      assert.equal(staff.status, 200, JSON.stringify(staff.body));
      const candidates = (staff.body!.staff as ParsedJson[]).map((x) => String(x.userLinkId));
      assert.ok(candidates.includes(w.seller.userLinkId), 'the salesperson is offered');
      assert.ok(candidates.includes(w.other.userLinkId), 'so is their colleague');
      assert.ok(
        !candidates.includes(w.bdc.userLinkId),
        'somebody with no sales role is not offered',
      );

      const onFloor = await call(
        w.manager.token,
        'POST',
        '/api/sales/floor',
        { location_id: w.rooftopId, user_link_id: w.seller.userLinkId },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(onFloor.status, 201, JSON.stringify(onFloor.body));

      // ── the arrival, against a booking picked off a list ──────────────────
      const expected = await call(t, 'GET', '/api/sales/find/appointments');
      assert.equal(expected.status, 200, JSON.stringify(expected.body));
      const mine = (expected.body!.appointments as ParsedJson[]).find(
        (a) => String(a.appointmentId) === lead.appointmentId,
      );
      assert.ok(mine !== undefined, 'the booking is on the expected list');
      assert.equal(String(mine!.partyId), lead.partyId);

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
      const visitId = String(arrived.body!.visit.visitId);
      assert.equal(arrived.body!.visit.state, 'arrived');
      assert.equal(arrived.body!.appointmentKept, true, 'the booking was marked kept');

      // THE BOOKING IS KEPT IN THE SAME ACT, and RT3's own record says so.
      const kept = await query(
        `SELECT state, completed_at FROM appointments WHERE appointment_id = $1`,
        [lead.appointmentId],
      );
      assert.equal(String((kept.rows[0] as { state: string }).state), 'completed');
      assert.ok((kept.rows[0] as { completed_at: unknown }).completed_at !== null);

      // …and it has left the expected list, so nobody can be checked in twice
      // against it.
      const afterKept = await call(t, 'GET', '/api/sales/find/appointments');
      assert.ok(
        !(afterKept.body!.appointments as ParsedJson[]).some(
          (a) => String(a.appointmentId) === lead.appointmentId,
        ),
        'a kept booking is no longer offered',
      );

      // A SECOND CHECK-IN WITH A DIFFERENT REQUEST KEY CONVERGES. The
      // idempotency layer has never seen this key, so only the business key can
      // save it — and it does.
      const again = await call(
        t,
        'POST',
        '/api/sales/visits',
        { location_id: w.rooftopId, party_id: lead.partyId },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(again.status, 200, JSON.stringify(again.body));
      assert.equal(again.body!.outcome, 'already_here');
      assert.equal(again.body!.visit.visitId, visitId, 'one visit, not two');

      const visitCount = await query(
        `SELECT COUNT(*)::int AS n FROM showroom_visits WHERE tenant_id = $1`,
        [w.tenantId],
      );
      assert.equal(Number((visitCount.rows[0] as { n: number }).n), 1);

      // ── greeting, then explicit acceptance ────────────────────────────────
      const greeted = await call(t, 'POST', `/api/sales/visits/${visitId}/greet`, {
        expected_version: Number(arrived.body!.visit.authorizationVersion),
      });
      assert.equal(greeted.status, 200, JSON.stringify(greeted.body));
      assert.equal(greeted.body!.visit.state, 'greeted');
      assert.equal(greeted.body!.greetedBy, w.seller.userLinkId);
      assert.equal(greeted.body!.fromRotation, true, 'the up system gave the turn');

      const taken = await call(t, 'POST', `/api/sales/visits/${visitId}/acceptance`, {
        expected_version: Number(greeted.body!.visit.authorizationVersion),
      });
      assert.equal(taken.status, 200, JSON.stringify(taken.body));
      assert.equal(taken.body!.visit.state, 'with_salesperson');
      assert.equal(taken.body!.visit.acceptedByUserLinkId, w.seller.userLinkId);

      // Replaying the acceptance converges rather than refusing.
      const takenAgain = await call(t, 'POST', `/api/sales/visits/${visitId}/acceptance`, {
        expected_version: Number(taken.body!.visit.authorizationVersion),
      });
      assert.equal(takenAgain.status, 200);
      assert.equal(takenAgain.body!.outcome, 'already_accepted');

      // ── the opportunity, received off the pending list ────────────────────
      const pending = await call(t, 'GET', '/api/sales/find/handoffs');
      assert.equal(pending.status, 200, JSON.stringify(pending.body));
      const waiting = (pending.body!.handoffs as ParsedJson[]).find(
        (h) => String(h.handoffId) === lead.handoffId,
      );
      assert.ok(waiting !== undefined, 'the handoff is on the pending list');
      assert.equal(String(waiting!.customerName), 'Marta Silva');

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
      assert.equal(opp.body!.opportunity.origin, 'crm_handoff');
      assert.equal(
        opp.body!.opportunity.partyId,
        lead.partyId,
        'the customer came from the frozen snapshot, not from the request',
      );
      assert.equal(opp.body!.opportunity.rooftopId, w.rooftopId);
      assert.equal(opp.body!.opportunity.leadId, lead.leadId);
      assert.equal(
        opp.body!.opportunity.appointmentId,
        null,
        'the booking was already kept, so there is no pending appointment to carry',
      );
      // ONE AUDITED OWNER, ESTABLISHED AT RECEIPT — the person the CRM handed it
      // to, because they still work this rooftop.
      assert.equal(opp.body!.opportunity.ownerUserLinkId, w.seller.userLinkId);
      assert.equal(
        opp.body!.opportunity.dealStatus,
        'NOT_YET_AVAILABLE',
        'no deal exists until FBL-120 desks one',
      );

      const owners = await query(
        `SELECT to_user_link_id, reason FROM opportunity_assignments
          WHERE tenant_id = $1 AND opportunity_id = $2`,
        [w.tenantId, opportunityId],
      );
      assert.equal(owners.rows.length, 1, 'the ownership is on the record, not just in the row');

      // …and it has left the pending list.
      const afterReceipt = await call(t, 'GET', '/api/sales/find/handoffs');
      assert.ok(
        !(afterReceipt.body!.handoffs as ParsedJson[]).some(
          (h) => String(h.handoffId) === lead.handoffId,
        ),
        'a received handoff is no longer waiting',
      );

      // ONE OPPORTUNITY PER HANDOFF, and a fresh request key does not change it.
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

      // ── the shortlist, chosen off a rooftop-filtered list ─────────────────
      const chooser = await call(t, 'GET', '/api/sales/find/vehicles');
      assert.equal(chooser.status, 200, JSON.stringify(chooser.body));
      const offered = (chooser.body!.vehicles as ParsedJson[]).map((v) => String(v.stockItemId));
      assert.ok(offered.includes(carA) && offered.includes(carB), 'both cars are offered');

      // A CAR AT ANOTHER ROOFTOP IS NOT OFFERED, and is NOT FOUND if named.
      const elsewhere = await acquireCar(w, '3HGCM82633A004354', 'C9012', w.secondRooftopId);
      const chooserAgain = await call(
        t,
        'GET',
        `/api/sales/find/vehicles?location_id=${w.rooftopId}`,
      );
      assert.ok(
        !(chooserAgain.body!.vehicles as ParsedJson[]).some(
          (v) => String(v.stockItemId) === elsewhere,
        ),
        'another showroom’s car is not on this list',
      );
      const wrongLot = await call(
        t,
        'POST',
        `/api/sales/opportunities/${opportunityId}/vehicles`,
        { stock_item_id: elsewhere },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(wrongLot.status, 404, JSON.stringify(wrongLot.body));
      assert.doesNotMatch(
        JSON.stringify(wrongLot.body),
        /Northside|C9012/,
        'the refusal named the other showroom or its stock',
      );

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

      // ── the demonstration, as five facts ─────────────────────────────────
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

      const issued = await call(
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
      assert.equal(issued.status, 201, JSON.stringify(issued.body));
      const demonstrationId = String(issued.body!.demonstration.demonstrationId);
      assert.equal(issued.body!.demonstration.state, 'issued', 'keys out, not yet moving');

      const stateUrl = `/api/sales/opportunities/${opportunityId}/demonstrations/${demonstrationId}/state`;
      const started = await call(t, 'POST', stateUrl, {
        expected_version: Number(issued.body!.demonstration.authorizationVersion),
        to_state: 'in_progress',
      });
      assert.equal(started.status, 200, JSON.stringify(started.body));
      assert.equal(started.body!.demonstration.state, 'in_progress');
      assert.ok(started.body!.demonstration.startedAt !== null, 'the car left at a stated time');

      // A CUSTOMER CANNOT LEAVE WHILE A CAR IS OUT.
      const tooSoon = await call(t, 'POST', `/api/sales/visits/${visitId}/depart`, {
        expected_version: Number(taken.body!.visit.authorizationVersion),
      });
      assertProblem(tooSoon, 422, 'invalid_request');
      assert.match(String(tooSoon.body!.detail), /still out/i);

      // AN UNKNOWN VERDICT IS THE CALLER'S MISTAKE, not a server failure.
      const nonsense = await call(t, 'POST', stateUrl, {
        expected_version: Number(started.body!.demonstration.authorizationVersion),
        to_state: 'returned',
        outcome: 'positive',
      });
      assertProblem(nonsense, 422, 'invalid_request');

      const back = await call(t, 'POST', stateUrl, {
        expected_version: Number(started.body!.demonstration.authorizationVersion),
        to_state: 'returned',
        outcome: 'interested',
        notes: 'liked the ride, wants the other colour',
      });
      assert.equal(back.status, 200, JSON.stringify(back.body));
      assert.equal(back.body!.demonstration.state, 'returned');
      assert.equal(back.body!.demonstration.outcome, 'interested');

      // Replaying the return converges.
      const backAgain = await call(t, 'POST', stateUrl, {
        expected_version: Number(back.body!.demonstration.authorizationVersion),
        to_state: 'returned',
        outcome: 'interested',
      });
      assert.equal(backAgain.status, 200);
      assert.equal(backAgain.body!.outcome, 'already_there');

      // ── the selection, with its history kept ─────────────────────────────
      const fresh = await call(t, 'GET', `/api/sales/opportunities/${opportunityId}`);
      const rowsNow = fresh.body!.shortlist as ParsedJson[];
      const versionOf = (id: string): number =>
        Number(rowsNow.find((v) => String(v.opportunityVehicleId) === id)!.authorizationVersion);
      assert.equal(
        String(rowsNow.find((v) => String(v.opportunityVehicleId) === shortAId)!.status),
        'demonstrated',
        'driving a car says so on the shortlist without anybody typing it',
      );

      const selectedB = await call(
        t,
        'POST',
        `/api/sales/opportunities/${opportunityId}/vehicles/${shortBId}/status`,
        { expected_version: versionOf(shortBId), status: 'selected' },
      );
      assert.equal(selectedB.status, 200, JSON.stringify(selectedB.body));

      // A SECOND SELECTION STANDS THE FIRST ONE DOWN rather than being refused
      // — a customer changing their mind is normal, two selected cars are not.
      const changed = await call(
        t,
        'POST',
        `/api/sales/opportunities/${opportunityId}/vehicles/${shortAId}/status`,
        { expected_version: versionOf(shortAId), status: 'selected' },
      );
      assert.equal(changed.status, 200, JSON.stringify(changed.body));
      const shortlistNow = await call(t, 'GET', `/api/sales/opportunities/${opportunityId}`);
      const selectedRows = (shortlistNow.body!.shortlist as ParsedJson[]).filter(
        (v) => String(v.status) === 'selected',
      );
      assert.equal(selectedRows.length, 1, 'exactly one car is the one they want');
      assert.equal(String(selectedRows[0]!.opportunityVehicleId), shortAId);

      // …AND THE SEQUENCE SURVIVED. The current row says `selected`; the history
      // says a second-choice car was selected first and stood down.
      const vehicleStory = (shortlistNow.body!.timeline as ParsedJson[])
        .filter((e) => String(e.kind).startsWith('vehicle.'))
        .map((e) => String(e.kind));
      assert.ok(
        vehicleStory.includes('vehicle.shortlisted'),
        'the shortlisting is on the timeline',
      );
      assert.ok(vehicleStory.includes('vehicle.demonstrated'), 'so is the drive');
      assert.ok(vehicleStory.includes('vehicle.selected'), 'so is each selection');
      assert.ok(
        vehicleStory.includes('vehicle.stood_down'),
        'and so is the car that lost — which a status column alone cannot say',
      );

      // ── what is owed next ────────────────────────────────────────────────
      const logged = await call(
        t,
        'POST',
        `/api/sales/opportunities/${opportunityId}/activities`,
        { kind: 'call', direction: 'outbound', subject: 'talked through the warranty' },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(logged.status, 201, JSON.stringify(logged.body));

      const task = await call(
        t,
        'POST',
        `/api/sales/opportunities/${opportunityId}/activities`,
        {
          kind: 'task',
          subject: 'send the warranty booklet',
          due_at: new Date(Date.now() + 86_400_000).toISOString(),
        },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(task.status, 201, JSON.stringify(task.body));
      const taskId = String(task.body!.activity.activityId);

      // THE EARLIEST OPEN DUE ACTION IS EXPOSED, on the opportunity itself.
      const withAction = await call(t, 'GET', `/api/sales/opportunities/${opportunityId}`);
      assert.equal(withAction.body!.opportunity.nextActionId, taskId);
      assert.equal(withAction.body!.opportunity.nextActionSubject, 'send the warranty booklet');
      assert.equal((withAction.body!.openActions as ParsedJson[]).length, 1);

      // …and it can be completed.
      const done = await call(
        t,
        'POST',
        `/api/sales/opportunities/${opportunityId}/activities/${taskId}/close`,
        { expected_version: Number(task.body!.activity.authorizationVersion), state: 'completed' },
      );
      assert.equal(done.status, 200, JSON.stringify(done.body));
      assert.equal(done.body!.activity.state, 'completed');
      const afterDone = await call(t, 'GET', `/api/sales/opportunities/${opportunityId}`);
      assert.equal(afterDone.body!.opportunity.nextActionId, null, 'nothing is owed now');

      // …or cancelled, which is a different fact and states why.
      const another = await call(
        t,
        'POST',
        `/api/sales/opportunities/${opportunityId}/activities`,
        {
          kind: 'task',
          subject: 'chase the part-exchange photos',
          due_at: new Date(Date.now() + 172_800_000).toISOString(),
        },
        { 'idempotency-key': randomUUID() },
      );
      const noReason = await call(
        t,
        'POST',
        `/api/sales/opportunities/${opportunityId}/activities/${String(
          another.body!.activity.activityId,
        )}/close`,
        {
          expected_version: Number(another.body!.activity.authorizationVersion),
          state: 'cancelled',
        },
      );
      assertProblem(noReason, 422, 'invalid_request');
      const cancelled = await call(
        t,
        'POST',
        `/api/sales/opportunities/${opportunityId}/activities/${String(
          another.body!.activity.activityId,
        )}/close`,
        {
          expected_version: Number(another.body!.activity.authorizationVersion),
          state: 'cancelled',
          reason: 'they sent them by email instead',
        },
      );
      assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
      assert.equal(cancelled.body!.activity.state, 'cancelled');

      // ── negotiation, and a real manager ──────────────────────────────────
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

      // The manager is picked off the list, not typed.
      const managers = await call(
        t,
        'GET',
        `/api/sales/find/staff?location_id=${w.rooftopId}&role=manager`,
      );
      assert.equal(managers.status, 200, JSON.stringify(managers.body));
      const managerIds = (managers.body!.staff as ParsedJson[]).map((x) => String(x.userLinkId));
      assert.deepEqual(managerIds, [w.manager.userLinkId], 'exactly one manager works this floor');

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

      // ── the manager reassigns it, which only a manager can ───────────────
      const current = await call(t, 'GET', `/api/sales/opportunities/${opportunityId}`);
      let version = Number(current.body!.opportunity.authorizationVersion);

      const notAManager = await call(
        t,
        'POST',
        `/api/sales/opportunities/${opportunityId}/assignment`,
        { expected_version: version, to_user_link_id: w.other.userLinkId },
      );
      assert.equal(notAManager.status, 404, JSON.stringify(notAManager.body));

      const reassigned = await call(
        w.manager.token,
        'POST',
        `/api/sales/opportunities/${opportunityId}/assignment`,
        {
          expected_version: version,
          to_user_link_id: w.other.userLinkId,
          reason: 'reassignment',
          note: 'their customer from last year',
        },
      );
      assert.equal(reassigned.status, 200, JSON.stringify(reassigned.body));
      assert.equal(reassigned.body!.opportunity.ownerUserLinkId, w.other.userLinkId);
      version = Number(reassigned.body!.opportunity.authorizationVersion);

      // REPLAYING IT CONVERGES, on a stale version — because holding a stale
      // version is the CONSEQUENCE of the first call having succeeded.
      const replayed = await call(
        w.manager.token,
        'POST',
        `/api/sales/opportunities/${opportunityId}/assignment`,
        { expected_version: version - 1, to_user_link_id: w.other.userLinkId },
      );
      assert.equal(replayed.status, 200, JSON.stringify(replayed.body));
      assert.equal(replayed.body!.outcome, 'already_assigned');

      // THE HISTORY KEPT BOTH OWNERS.
      const history = await query(
        `SELECT from_user_link_id, to_user_link_id, reason FROM opportunity_assignments
          WHERE tenant_id = $1 AND opportunity_id = $2 ORDER BY occurred_at`,
        [w.tenantId, opportunityId],
      );
      assert.equal(history.rows.length, 2, 'receipt and reassignment are both on the record');
      assert.equal(
        String((history.rows[1] as { to_user_link_id: string }).to_user_link_id),
        w.other.userLinkId,
      );

      // ── the stage machine, ending at desking ─────────────────────────────
      const t2 = w.other.token;
      for (const stage of ['in_showroom', 'demonstrated', 'negotiating']) {
        const moved = await call(t2, 'POST', `/api/sales/opportunities/${opportunityId}/stage`, {
          expected_version: version,
          to_stage: stage,
        });
        assert.equal(moved.status, 200, `${stage}: ${JSON.stringify(moved.body)}`);
        assert.equal(moved.body!.opportunity.stage, stage);
        version = Number(moved.body!.opportunity.authorizationVersion);
      }

      // A STALE VERSION LOSES on a move that is not a replay.
      const stale = await call(t2, 'POST', `/api/sales/opportunities/${opportunityId}/stage`, {
        expected_version: version - 1,
        to_stage: 'follow_up',
      });
      assertProblem(stale, 409, 'version_conflict');

      // A MOVE THE MACHINE DOES NOT ADMIT IS REFUSED.
      const backwards = await call(t2, 'POST', `/api/sales/opportunities/${opportunityId}/stage`, {
        expected_version: version,
        to_stage: 'received',
      });
      assertProblem(backwards, 422, 'invalid_request');
      assert.match(String(backwards.body!.detail), /may move to/);

      // THERE IS NO `won` STAGE AND NO `sold` DISPOSITION. RT4 cannot sell.
      const soldAttempt = await call(
        t2,
        'POST',
        `/api/sales/opportunities/${opportunityId}/stage`,
        {
          expected_version: version,
          to_stage: 'won',
          disposition: 'sold',
        },
      );
      assertProblem(soldAttempt, 422, 'invalid_request');
      assert.match(String(soldAttempt.body!.detail), /unknown stage won/);

      // A positive conclusion needs the positive disposition and nothing else.
      const wrongReason = await call(
        t2,
        'POST',
        `/api/sales/opportunities/${opportunityId}/stage`,
        {
          expected_version: version,
          to_stage: 'ready_for_desking',
          disposition: 'lost_to_competitor',
        },
      );
      assertProblem(wrongReason, 422, 'invalid_request');

      const desked = await call(t2, 'POST', `/api/sales/opportunities/${opportunityId}/stage`, {
        expected_version: version,
        to_stage: 'ready_for_desking',
        disposition: 'committed_to_purchase',
        note: 'wants to sign on Saturday',
      });
      assert.equal(desked.status, 200, JSON.stringify(desked.body));
      assert.equal(desked.body!.opportunity.stage, 'ready_for_desking');
      assert.ok(desked.body!.deskingHandoffId !== null, 'the desk was handed the customer');
      const deskingHandoffId = String(desked.body!.deskingHandoffId);
      version = Number(desked.body!.opportunity.authorizationVersion);

      // ── EXACTLY ONE FACT, AND NOTHING ELSE ───────────────────────────────
      const facts = await query(
        `SELECT desking_handoff_id, stock_item_id, desking_status, outbox_event_id
           FROM desking_handoffs WHERE tenant_id = $1`,
        [w.tenantId],
      );
      assert.equal(facts.rows.length, 1, 'exactly one desking handoff');
      const fact = facts.rows[0] as Record<string, unknown>;
      assert.equal(String(fact.desking_handoff_id), deskingHandoffId);
      assert.equal(String(fact.stock_item_id), carA, 'it names the car they committed to');
      assert.equal(String(fact.desking_status), 'NOT_YET_AVAILABLE');

      const outbox = await query(
        `SELECT event_id, event_type, payload FROM admin_outbox
          WHERE tenant_id = $1 AND event_type LIKE 'sales.%'`,
        [w.tenantId],
      );
      assert.equal(outbox.rows.length, 1, 'exactly one outbox event');
      const event = outbox.rows[0] as Record<string, unknown>;
      assert.equal(
        String(event.event_type),
        'sales.opportunity.ready_for_appraisal_desking',
        'the fact is named as the order names it',
      );
      assert.equal(String(event.event_id), String(fact.outbox_event_id), 'the pair is traceable');

      // REPLAYING THE MOVE RAISES NOTHING NEW.
      const replayDesk = await call(t2, 'POST', `/api/sales/opportunities/${opportunityId}/stage`, {
        expected_version: version,
        to_stage: 'ready_for_desking',
        disposition: 'committed_to_purchase',
      });
      assert.equal(replayDesk.status, 200, JSON.stringify(replayDesk.body));
      assert.equal(replayDesk.body!.outcome, 'already_there');
      assert.equal(replayDesk.body!.deskingHandoffId, deskingHandoffId, 'the same fact');
      const stillOne = await query(
        `SELECT (SELECT COUNT(*)::int FROM desking_handoffs WHERE tenant_id = $1) AS facts,
                (SELECT COUNT(*)::int FROM admin_outbox
                  WHERE tenant_id = $1 AND event_type LIKE 'sales.%') AS events`,
        [w.tenantId],
      );
      assert.deepEqual(stillOne.rows[0], { facts: 1, events: 1 });

      // NO SALE, NO SOLD INVENTORY, NO DEAL, NO DELIVERY, NO MONEY.
      const stock = await query(
        `SELECT lifecycle_state FROM stock_items WHERE stock_item_id = $1`,
        [carA],
      );
      assert.equal(
        String((stock.rows[0] as { lifecycle_state: string }).lifecycle_state),
        'acquired',
        'the car this train handed on is NOT marked sold',
      );
      const moneyColumns = await query(
        `SELECT table_name, column_name FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name IN ('opportunities', 'negotiation_rounds', 'desking_handoffs',
                               'opportunity_vehicles', 'demonstrations')
            AND (column_name LIKE '%cents%' OR column_name LIKE '%price%'
                 OR column_name LIKE '%amount%' OR column_name LIKE '%gross%'
                 OR column_name LIKE '%commission%' OR column_name LIKE '%revenue%')`,
      );
      assert.deepEqual(moneyColumns.rows, [], 'a money column appeared');

      // ── the visit ends, and the salesperson is free ──────────────────────
      const visitNow = await call(t, 'GET', '/api/sales/visits');
      const openVisit = (visitNow.body!.visits as ParsedJson[]).find(
        (v) => String(v.visitId) === visitId,
      );
      const left = await call(t, 'POST', `/api/sales/visits/${visitId}/depart`, {
        expected_version: Number(openVisit!.authorizationVersion),
        note: 'coming back Saturday to sign',
      });
      assert.equal(left.status, 200, JSON.stringify(left.body));
      assert.equal(left.body!.visit.state, 'departed');

      const afterFloor = await call(
        w.manager.token,
        'GET',
        `/api/sales/floor?location_id=${w.rooftopId}`,
      );
      const backOn = (afterFloor.body!.floor as ParsedJson[]).find(
        (e) => String(e.userLinkId) === w.seller.userLinkId,
      );
      assert.equal(String(backOn!.status), 'available');

      // ── the manager's one reconciled view ────────────────────────────────
      const board = await call(w.manager.token, 'GET', '/api/sales/board');
      assert.equal(board.status, 200, JSON.stringify(board.body));
      assert.equal(Number(board.body!.appointments.kept), 1, 'the kept booking is counted');
      assert.equal(Number(board.body!.showroom.departedToday), 1);
      assert.equal(Number(board.body!.floor.available), 1);
      assert.equal(Number(board.body!.pipeline.readyForDesking), 1);
      assert.equal(Number(board.body!.pipeline.open), 0);
      assert.equal(Number(board.body!.vehicles.selected), 0, 'a desked deal is no longer open');
      assert.equal(Number(board.body!.demonstrations.returnedToday), 1);
      assert.equal(Number(board.body!.negotiation.roundsToday), 1);
      assert.equal(Number(board.body!.negotiation.turnovers), 1);
      assert.equal(Number(board.body!.dispositions.readyForDesking), 1);
      assert.equal(Number(board.body!.nextActions.open), 0);

      // EVERY MONEY QUESTION ANSWERS THE SAME WAY.
      for (const key of [
        'revenueStatus',
        'roiStatus',
        'grossStatus',
        'commissionStatus',
        'closeStatus',
        'pricingStatus',
        'dealStatus',
      ]) {
        assert.equal(board.body![key], 'NOT_YET_AVAILABLE', key);
      }
      // …AND EVERY MONEY-NAMED FIELD HOLDS THAT STRING AND NOTHING ELSE.
      //
      // The board is REQUIRED to name revenue, ROI, gross, commission, close,
      // pricing and deal — that is how it says the figures do not exist, rather
      // than leaving a reader to infer a zero. So the check is not that those
      // words are absent; it is that no field named after money carries a
      // VALUE, anywhere in the payload, at any depth.
      const moneyish = /cents|gross|commission|revenue|price|amount|roi|close/i;
      const offenders: string[] = [];
      const walk = (node: unknown, path: string): void => {
        if (node === null || node === undefined) return;
        if (Array.isArray(node)) {
          node.forEach((item, i) => walk(item, `${path}[${i}]`));
          return;
        }
        if (typeof node === 'object') {
          for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
            const here = path === '' ? k : `${path}.${k}`;
            if (moneyish.test(k) && v !== 'NOT_YET_AVAILABLE') {
              offenders.push(`${here}=${JSON.stringify(v)}`);
            }
            walk(v, here);
          }
        }
      };
      walk(board.body, '');
      assert.deepEqual(offenders, [], 'a money-named field carried a value');

      // ── the trail ────────────────────────────────────────────────────────
      for (const eventType of [
        'sales.opportunity.received',
        'sales.opportunity.assigned',
        'sales.opportunity.stage_changed',
        'sales.visit.arrived',
        'sales.visit.greeted',
        'sales.visit.accepted',
        'sales.visit.departed',
        'sales.demonstration.issued',
        'sales.demonstration.started',
        'sales.demonstration.returned',
        'sales.activity.completed',
        'sales.activity.cancelled',
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

    test('a walk-in resolves to the canonical customer, never a second record', async () => {
      const w = await seedWorld();
      const t = w.seller.token;
      const lead = await handOffALead(w, { email: 'marta.known@example.com' });

      // The customer the dealership already knows is FOUND, not retyped.
      const search = await call(t, 'GET', '/api/sales/find/customers?q=silva');
      assert.equal(search.status, 200, JSON.stringify(search.body));
      const known = (search.body!.customers as ParsedJson[]).find(
        (c) => String(c.partyId) === lead.partyId,
      );
      assert.ok(known !== undefined, 'the existing customer is on the list');
      assert.equal(String(known!.displayName), 'Marta Silva');
      // The list carries no contact detail — only whether one exists.
      assert.equal(known!.email, undefined);
      assert.equal(known!.hasEmail, true);

      // A WALK-IN BY SOMEBODY BRAND NEW creates the canonical record here, where
      // Release Train 2's duplicate detection can answer.
      const fresh = await call(
        t,
        'POST',
        '/api/sales/walk-ins',
        {
          location_id: w.rooftopId,
          customer: { given_name: 'Tomas', family_name: 'Novak', email: 'tomas@example.com' },
        },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(fresh.status, 201, JSON.stringify(fresh.body));
      assert.equal(fresh.body!.opportunity.origin, 'walk_in');
      assert.equal(fresh.body!.opportunity.handoffId, null);
      assert.equal(fresh.body!.opportunity.leadId, null);
      assert.equal(fresh.body!.customerCreated, true);
      assert.equal(
        fresh.body!.opportunity.ownerUserLinkId,
        w.seller.userLinkId,
        'whoever took the walk-in owns it',
      );

      // THE SAME PERSON AGAIN IS NOT A SECOND CUSTOMER. RT2's own detection
      // answers, and the salesperson is shown who the dealership already has.
      const dup = await call(
        t,
        'POST',
        '/api/sales/walk-ins',
        {
          location_id: w.rooftopId,
          customer: { given_name: 'Tomas', family_name: 'Novakova', email: 'tomas@example.com' },
        },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(dup.status, 409, JSON.stringify(dup.body));
      assert.equal(dup.body!.outcome, 'duplicate');
      assert.equal(String(dup.body!.candidates[0].matchedOn), 'email');
      assert.equal(String(dup.body!.candidates[0].displayName), 'Tomas Novak');

      const customers = await query(
        `SELECT COUNT(*)::int AS n FROM parties
          WHERE tenant_id = $1 AND email = 'tomas@example.com'`,
        [w.tenantId],
      );
      assert.equal(Number((customers.rows[0] as { n: number }).n), 1, 'one Tomas, not two');

      // A WALK-IN BY A CUSTOMER PICKED FROM THE SEARCH uses their real record.
      const picked = await call(
        t,
        'POST',
        '/api/sales/walk-ins',
        { location_id: w.rooftopId, party_id: lead.partyId },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(picked.status, 201, JSON.stringify(picked.body));
      assert.equal(picked.body!.opportunity.partyId, lead.partyId);
      assert.equal(picked.body!.customerCreated, false);
      const walkInId = String(picked.body!.opportunity.opportunityId);

      // …AND A SECOND WALK-IN BY THE SAME PERSON CONVERGES on the open file,
      // even with a fresh request key the idempotency layer has never seen.
      const twice = await call(
        t,
        'POST',
        '/api/sales/walk-ins',
        { location_id: w.rooftopId, party_id: lead.partyId },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(twice.status, 200, JSON.stringify(twice.body));
      assert.equal(twice.body!.outcome, 'already_open');
      assert.equal(twice.body!.opportunity.opportunityId, walkInId, 'one open file, not two');

      // NO RAW IDENTIFIER IS ACCEPTED WHERE A SELECTION IS EXPECTED.
      const typed = await call(
        t,
        'POST',
        '/api/sales/walk-ins',
        { location_id: w.rooftopId, party_id: 'not-a-uuid' },
        { 'idempotency-key': randomUUID() },
      );
      assertProblem(typed, 400, 'selection_required');
    });

    test('a concluded opportunity is concluded: terminal states refuse further work', async () => {
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

      // A LOST DEAL RAISES NO DESKING FACT.
      const facts = await query(
        `SELECT COUNT(*)::int AS n FROM desking_handoffs WHERE tenant_id = $1`,
        [w.tenantId],
      );
      assert.equal(Number((facts.rows[0] as { n: number }).n), 0);

      // A CONCLUSION WITHOUT A REASON IS NOT A CONCLUSION — proven on a second.
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

      // A FOLLOW-UP NEEDS SOMETHING OWED.
      const noPromise = await call(
        t,
        'POST',
        `/api/sales/opportunities/${String(opp2.body!.opportunity.opportunityId)}/stage`,
        {
          expected_version: Number(opp2.body!.opportunity.authorizationVersion),
          to_stage: 'follow_up',
        },
      );
      assertProblem(noPromise, 422, 'invalid_request');
      assert.match(String(noPromise.body!.detail), /owed/i);

      // …and with a due task, it is allowed.
      const promise = await call(
        t,
        'POST',
        `/api/sales/opportunities/${String(opp2.body!.opportunity.opportunityId)}/activities`,
        {
          kind: 'task',
          subject: 'ring them Thursday',
          due_at: new Date(Date.now() + 86_400_000).toISOString(),
        },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(promise.status, 201, JSON.stringify(promise.body));
      const parked = await call(
        t,
        'POST',
        `/api/sales/opportunities/${String(opp2.body!.opportunity.opportunityId)}/stage`,
        {
          expected_version: Number(opp2.body!.opportunity.authorizationVersion),
          to_stage: 'follow_up',
        },
      );
      assert.equal(parked.status, 200, JSON.stringify(parked.body));
      assert.equal(parked.body!.opportunity.stage, 'follow_up');
      assert.equal(parked.body!.opportunity.disposition, null, 'follow-up is not a conclusion');

      // EVERY WRITE THROUGH THE LOST OPPORTUNITY IS REFUSED. Not the read.
      const car = await acquireCar(w, '1HGCM82633A004352', 'A1234');
      const shortlist = await call(
        t,
        'POST',
        `/api/sales/opportunities/${opportunityId}/vehicles`,
        { stock_item_id: car },
        { 'idempotency-key': randomUUID() },
      );
      assertProblem(shortlist, 422, 'invalid_request');
      assert.match(String(shortlist.body!.detail), /lost|finished/i);

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
