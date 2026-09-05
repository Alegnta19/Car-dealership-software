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
 * RELEASE TRAIN 4 — THE OPERATIONS A SHOWROOM ACTUALLY PERFORMS.
 *
 * The journey battery walks the path a good afternoon takes. This one walks the
 * rest of the day: bookings that move, bookings that are called off, customers
 * who do not turn up, cars that go out and come back a different way, and the
 * exception nobody wants to write down.
 *
 * WHY THE APPOINTMENT MISUSE CASES MATTER. A no-show that can be checked in an
 * hour later makes the no-show figure a guess; a cancelled booking that can be
 * kept makes the cancellation figure a guess; and both are numbers a general
 * manager makes staffing decisions on. Refusing them is the whole point of
 * validating the appointment rather than merely recording its id.
 */
describe(
  'sales: showroom operations and demonstration facts (RT4)',
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
      manager: { userLinkId: string; token: string };
      seller: { userLinkId: string; token: string };
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
      const manager = await seedActor(env.issuer, { tenantId, roles: [ROLES.SALES_MANAGER] });
      const seller = await seedActor(env.issuer, { tenantId, roles: [ROLES.SALESPERSON] });
      const bdc = await seedActor(env.issuer, { tenantId, roles: [ROLES.BDC_AGENT] });
      const marketing = await seedActor(env.issuer, { tenantId, roles: [ROLES.MARKETING_MANAGER] });
      const inventory = await seedActor(env.issuer, { tenantId, roles: [ROLES.INVENTORY_MANAGER] });
      return {
        tenantId,
        rooftopId: rooftop.rooftopId,
        manager: { userLinkId: manager.userLinkId, token: manager.token },
        seller: { userLinkId: seller.userLinkId, token: seller.token },
        bdc: { userLinkId: bdc.userLinkId, token: bdc.token },
        marketing: { userLinkId: marketing.userLinkId, token: marketing.token },
        inventory: { userLinkId: inventory.userLinkId, token: inventory.token },
      };
    }

    /** A lead with an appointment, not yet handed over. */
    async function bookAnAppointment(
      w: World,
      email = `person.${randomUUID()}@example.com`,
    ): Promise<{ leadId: string; partyId: string; appointmentId: string; version: number }> {
      const t = w.bdc.token;
      await call(
        w.marketing.token,
        'POST',
        '/api/crm/sources',
        { source_code: 'website', display_name: 'Website', channel: 'web', medium: 'organic' },
        { 'idempotency-key': randomUUID() },
      );
      const captured = await call(
        t,
        'POST',
        '/api/crm/leads',
        {
          location_id: w.rooftopId,
          intake_key: `web-${randomUUID()}`,
          channel: 'website',
          source_code: 'website',
          customer: { given_name: 'Ines', family_name: 'Duarte', email },
        },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(captured.status, 201, JSON.stringify(captured.body));
      const leadId = String(captured.body!.lead.leadId);
      const partyId = String(captured.body!.lead.partyId);
      const moved = await call(t, 'POST', `/api/crm/leads/${leadId}/transition`, {
        expected_version: Number(captured.body!.lead.authorizationVersion),
        to_state: 'working',
      });
      assert.equal(moved.status, 200, JSON.stringify(moved.body));

      const starts = new Date(Date.now() + 3_600_000);
      const booked = await call(
        t,
        'POST',
        `/api/crm/leads/${leadId}/appointments`,
        {
          purpose: 'showroom_visit',
          starts_at: starts.toISOString(),
          ends_at: new Date(starts.getTime() + 3_600_000).toISOString(),
        },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(booked.status, 201, JSON.stringify(booked.body));
      return {
        leadId,
        partyId,
        appointmentId: String(booked.body!.appointment.appointmentId),
        version: Number(booked.body!.appointment.authorizationVersion),
      };
    }

    async function acquireCar(w: World, vin: string, stockNumber: string): Promise<string> {
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
          location_id: w.rooftopId,
          vin,
          stock_number: stockNumber,
          acquisition_source: 'trade_in',
          acquired_on: '2026-08-01',
          acquisition_party_id: String(seller.body!.party.partyId),
        },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(acquired.status, 201, JSON.stringify(acquired.body));
      return String(acquired.body!.stockItem.stockItemId);
    }

    /** A walk-in opportunity for a customer who already exists. */
    async function openWalkIn(w: World, partyId: string): Promise<string> {
      const opened = await call(
        w.seller.token,
        'POST',
        '/api/sales/walk-ins',
        { location_id: w.rooftopId, party_id: partyId },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(opened.status, 201, JSON.stringify(opened.body));
      return String(opened.body!.opportunity.opportunityId);
    }

    test('a booking that moved, was called off, or was missed cannot be kept', async () => {
      const w = await seedWorld();
      const t = w.seller.token;

      // ── RESCHEDULED: still keepable, at the new time ─────────────────────
      const moved = await bookAnAppointment(w, 'moved@example.com');
      const later = new Date(Date.now() + 7_200_000);
      const rescheduled = await call(
        w.bdc.token,
        'POST',
        `/api/crm/appointments/${moved.appointmentId}/reschedule`,
        {
          expected_version: moved.version,
          starts_at: later.toISOString(),
          ends_at: new Date(later.getTime() + 3_600_000).toISOString(),
        },
      );
      assert.equal(rescheduled.status, 200, JSON.stringify(rescheduled.body));

      // It is still on the expected list, at the new time, and still keepable.
      const expected = await call(t, 'GET', '/api/sales/find/appointments');
      const stillExpected = (expected.body!.appointments as ParsedJson[]).find(
        (a) => String(a.appointmentId) === moved.appointmentId,
      );
      assert.ok(stillExpected !== undefined, 'a moved booking is still expected');
      const arrivedLate = await call(
        t,
        'POST',
        '/api/sales/visits',
        {
          location_id: w.rooftopId,
          party_id: moved.partyId,
          appointment_id: moved.appointmentId,
        },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(arrivedLate.status, 201, JSON.stringify(arrivedLate.body));
      assert.equal(arrivedLate.body!.appointmentKept, true);

      // ── CANCELLED: not keepable ──────────────────────────────────────────
      const dropped = await bookAnAppointment(w, 'dropped@example.com');
      const cancelled = await call(
        w.bdc.token,
        'POST',
        `/api/crm/appointments/${dropped.appointmentId}/state`,
        {
          expected_version: dropped.version,
          state: 'cancelled',
          reason: 'the customer called to say they cannot come',
        },
      );
      assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));

      const notOffered = await call(t, 'GET', '/api/sales/find/appointments');
      assert.ok(
        !(notOffered.body!.appointments as ParsedJson[]).some(
          (a) => String(a.appointmentId) === dropped.appointmentId,
        ),
        'a cancelled booking is not offered',
      );
      const afterCancel = await call(
        t,
        'POST',
        '/api/sales/visits',
        {
          location_id: w.rooftopId,
          party_id: dropped.partyId,
          appointment_id: dropped.appointmentId,
        },
        { 'idempotency-key': randomUUID() },
      );
      assertProblem(afterCancel, 422, 'invalid_request');
      assert.match(String(afterCancel.body!.detail), /already cancelled/i);

      // ── NO-SHOW: not keepable either ─────────────────────────────────────
      const missed = await bookAnAppointment(w, 'missed@example.com');
      const noShow = await call(
        w.bdc.token,
        'POST',
        `/api/crm/appointments/${missed.appointmentId}/state`,
        { expected_version: missed.version, state: 'no_show' },
      );
      assert.equal(noShow.status, 200, JSON.stringify(noShow.body));
      const afterNoShow = await call(
        t,
        'POST',
        '/api/sales/visits',
        {
          location_id: w.rooftopId,
          party_id: missed.partyId,
          appointment_id: missed.appointmentId,
        },
        { 'idempotency-key': randomUUID() },
      );
      assertProblem(afterNoShow, 422, 'invalid_request');
      assert.match(String(afterNoShow.body!.detail), /already no_show/i);

      // ── ALREADY KEPT: not keepable twice ─────────────────────────────────
      const twice = await call(
        t,
        'POST',
        '/api/sales/visits',
        {
          location_id: w.rooftopId,
          party_id: moved.partyId,
          appointment_id: moved.appointmentId,
        },
        { 'idempotency-key': randomUUID() },
      );
      // The customer is still in the building, so this converges on their visit
      // rather than reaching the appointment at all — which is the right answer
      // and the reason the visit check comes first.
      assert.equal(twice.status, 200, JSON.stringify(twice.body));
      assert.equal(twice.body!.outcome, 'already_here');

      // NOTHING WAS RECORDED BY EITHER REFUSAL.
      const visits = await query(
        `SELECT COUNT(*)::int AS n FROM showroom_visits WHERE tenant_id = $1`,
        [w.tenantId],
      );
      assert.equal(Number((visits.rows[0] as { n: number }).n), 1, 'one arrival, from one booking');

      // …AND THE FIGURES A MANAGER READS ARE THE TRUE ONES.
      const board = await call(w.manager.token, 'GET', '/api/sales/board');
      assert.equal(Number(board.body!.appointments.kept), 1);
      assert.equal(Number(board.body!.appointments.cancelled), 1);
      assert.equal(Number(board.body!.appointments.noShow), 1);
    });

    test('a car goes out and comes back a different way each time', async () => {
      const w = await seedWorld();
      const t = w.seller.token;
      const booked = await bookAnAppointment(w);
      const opportunityId = await openWalkIn(w, booked.partyId);
      const carA = await acquireCar(w, '1HGCM82633A004352', 'A1234');
      const carB = await acquireCar(w, '2HGCM82633A004353', 'B5678');
      const carC = await acquireCar(w, '3HGCM82633A004354', 'C9012');

      const issue = async (stockItemId: string) => {
        const res = await call(
          t,
          'POST',
          `/api/sales/opportunities/${opportunityId}/demonstrations`,
          { stock_item_id: stockItemId, driver_party_id: booked.partyId, licence_verified: true },
          { 'idempotency-key': randomUUID() },
        );
        assert.equal(res.status, 201, JSON.stringify(res.body));
        return {
          id: String(res.body!.demonstration.demonstrationId),
          version: Number(res.body!.demonstration.authorizationVersion),
        };
      };
      const stateUrl = (id: string) =>
        `/api/sales/opportunities/${opportunityId}/demonstrations/${id}/state`;

      // ── CANCELLED: the keys came out and went straight back ──────────────
      const first = await issue(carA);
      const noReason = await call(t, 'POST', stateUrl(first.id), {
        expected_version: first.version,
        to_state: 'cancelled',
      });
      assertProblem(noReason, 422, 'invalid_request');
      const calledOff = await call(t, 'POST', stateUrl(first.id), {
        expected_version: first.version,
        to_state: 'cancelled',
        reason: 'it started raining and they went home',
      });
      assert.equal(calledOff.status, 200, JSON.stringify(calledOff.body));
      assert.equal(calledOff.body!.demonstration.state, 'cancelled');
      assert.equal(calledOff.body!.demonstration.outcome, null, 'nobody found out');

      // THE CAR IS FREE AGAIN, because a cancelled drive is not an active one.
      const freeAgain = await call(t, 'GET', '/api/sales/find/vehicles');
      const carAnow = (freeAgain.body!.vehicles as ParsedJson[]).find(
        (v) => String(v.stockItemId) === carA,
      );
      assert.equal(carAnow!.outOnDemonstration, false);

      // ── EXCEPTION: something happened to it ──────────────────────────────
      const second = await issue(carB);
      const started = await call(t, 'POST', stateUrl(second.id), {
        expected_version: second.version,
        to_state: 'in_progress',
      });
      assert.equal(started.status, 200, JSON.stringify(started.body));

      const noKind = await call(t, 'POST', stateUrl(second.id), {
        expected_version: Number(started.body!.demonstration.authorizationVersion),
        to_state: 'exception',
        notes: 'kerbed the alloy',
      });
      assertProblem(noKind, 422, 'invalid_request');

      const noNotes = await call(t, 'POST', stateUrl(second.id), {
        expected_version: Number(started.body!.demonstration.authorizationVersion),
        to_state: 'exception',
        exception_kind: 'damage',
      });
      assertProblem(noNotes, 422, 'invalid_request');
      assert.match(String(noNotes.body!.detail), /what happened/i);

      const damaged = await call(t, 'POST', stateUrl(second.id), {
        expected_version: Number(started.body!.demonstration.authorizationVersion),
        to_state: 'exception',
        exception_kind: 'damage',
        notes: 'kerbed the nearside alloy on the way back',
      });
      assert.equal(damaged.status, 200, JSON.stringify(damaged.body));
      assert.equal(damaged.body!.demonstration.state, 'exception');
      assert.equal(damaged.body!.demonstration.exceptionKind, 'damage');
      assert.equal(damaged.body!.demonstration.outcome, null, 'an exception is not a verdict');

      // ── RETURNED: the ordinary way ───────────────────────────────────────
      const third = await issue(carC);
      const rolling = await call(t, 'POST', stateUrl(third.id), {
        expected_version: third.version,
        to_state: 'in_progress',
      });
      assert.equal(rolling.status, 200);
      const returned = await call(t, 'POST', stateUrl(third.id), {
        expected_version: Number(rolling.body!.demonstration.authorizationVersion),
        to_state: 'returned',
        outcome: 'wants_alternative',
        notes: 'liked it but wants the estate',
      });
      assert.equal(returned.status, 200, JSON.stringify(returned.body));
      assert.equal(returned.body!.demonstration.state, 'returned');

      // ── ALL FIVE FACTS ARE ON THE RECORD, in order ───────────────────────
      const events = await query(
        `SELECT de.event_type FROM demonstration_events de
           JOIN demonstrations d
             ON d.tenant_id = de.tenant_id AND d.demonstration_id = de.demonstration_id
          WHERE de.tenant_id = $1 AND d.opportunity_id = $2
          ORDER BY de.occurred_at, de.event_type`,
        [w.tenantId, opportunityId],
      );
      const kinds = (events.rows as Array<{ event_type: string }>).map((r) => r.event_type);
      for (const fact of ['issued', 'started', 'returned', 'cancelled', 'exception']) {
        assert.ok(kinds.includes(fact), `the ${fact} fact is not on the record`);
      }

      // …and the opportunity's own timeline carries them, so the screen does
      // not have to go looking in a second place.
      const detail = await call(t, 'GET', `/api/sales/opportunities/${opportunityId}`);
      const timelineKinds = (detail.body!.timeline as ParsedJson[]).map((e) => String(e.kind));
      assert.ok(timelineKinds.includes('demonstration.issued'));
      assert.ok(timelineKinds.includes('demonstration.cancelled'));
      assert.ok(timelineKinds.includes('demonstration.exception'));
      assert.ok(timelineKinds.includes('demonstration.returned'));

      // ── AND THE MANAGER'S BOARD SHOWS THE ONE THAT NEEDS ACTING ON ───────
      const board = await call(w.manager.token, 'GET', '/api/sales/board');
      assert.equal(Number(board.body!.demonstrations.issuedToday), 3);
      assert.equal(Number(board.body!.demonstrations.returnedToday), 1);
      assert.equal(Number(board.body!.demonstrations.cancelledToday), 1);
      assert.equal(Number(board.body!.demonstrations.exceptions), 1);
      assert.equal(Number(board.body!.demonstrations.activeNow), 0);
      const exception = (board.body!.exceptions as ParsedJson[]).find(
        (e) => String(e.kind) === 'demonstration_exception',
      );
      assert.ok(exception !== undefined, 'the damaged car is on the actionable list');
      assert.match(String(exception!.detail), /B5678: damage/);
    });

    test('the manager’s board is one reconciled view, and it surfaces what needs doing', async () => {
      const w = await seedWorld();
      const t = w.seller.token;

      // Somebody waiting a long time, an unowned opportunity, and an overdue
      // action — the three things a manager opens the board to find.
      const waiting = await bookAnAppointment(w, 'waiting@example.com');
      const arrived = await call(
        t,
        'POST',
        '/api/sales/visits',
        { location_id: w.rooftopId, party_id: waiting.partyId },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(arrived.status, 201, JSON.stringify(arrived.body));
      // AGEING THE ROW, DELIBERATELY. There is no service that makes a visit
      // older, because time does that — so proving the board notices a long wait
      // means moving the clock backwards on a real arrival. Declared as the
      // bypass it is rather than slipped through as an ordinary write.
      await fixtureAuthorizationStateWrite(
        'simulate-authorization-drift',
        `UPDATE showroom_visits SET arrived_at = NOW() - INTERVAL '40 minutes'
          WHERE visit_id = $1`,
        [String(arrived.body!.visit.visitId)],
      );

      const opportunityId = await openWalkIn(w, waiting.partyId);
      const task = await call(
        t,
        'POST',
        `/api/sales/opportunities/${opportunityId}/activities`,
        {
          kind: 'task',
          subject: 'ring them about the finance quote',
          due_at: new Date(Date.now() + 60_000).toISOString(),
        },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(task.status, 201, JSON.stringify(task.body));
      // Same reason: a task becomes overdue by the passage of time, and this is
      // the only way to have one without waiting an hour.
      await fixtureAuthorizationStateWrite(
        'simulate-authorization-drift',
        `UPDATE opportunity_activities SET due_at = NOW() - INTERVAL '1 hour'
          WHERE activity_id = $1`,
        [String(task.body!.activity.activityId)],
      );

      const board = await call(w.manager.token, 'GET', '/api/sales/board');
      assert.equal(board.status, 200, JSON.stringify(board.body));

      // ── EVERYTHING THE ORDER NAMES IS ON IT ──────────────────────────────
      for (const section of [
        'appointments',
        'showroom',
        'floor',
        'pipeline',
        'vehicles',
        'demonstrations',
        'negotiation',
        'nextActions',
        'dispositions',
        'exceptions',
      ]) {
        assert.ok(board.body![section] !== undefined, `the board has no ${section}`);
      }
      assert.equal(Number(board.body!.showroom.waiting), 1);
      assert.ok(Number(board.body!.showroom.longestWaitMinutes) >= 39, 'the wait is measured');
      assert.equal(Number(board.body!.pipeline.open), 1);
      assert.equal(Number(board.body!.nextActions.overdue), 1);

      const kinds = (board.body!.exceptions as ParsedJson[]).map((e) => String(e.kind));
      assert.ok(kinds.includes('waiting_too_long'), 'the long wait is actionable');
      assert.ok(kinds.includes('action_overdue'), 'the overdue task is actionable');

      // ── AND IT IS ONE VIEW: the numbers agree with the lists ─────────────
      const visits = await call(w.manager.token, 'GET', '/api/sales/visits');
      assert.equal(
        (visits.body!.visits as ParsedJson[]).filter((v) => String(v.state) === 'arrived').length,
        Number(board.body!.showroom.waiting),
        'the waiting count and the visit list disagree',
      );
      const pipeline = await call(w.manager.token, 'GET', '/api/sales/opportunities');
      assert.equal(
        (pipeline.body!.opportunities as ParsedJson[]).filter(
          (o) => !['ready_for_desking', 'lost'].includes(String(o.stage)),
        ).length,
        Number(board.body!.pipeline.open),
        'the open count and the pipeline list disagree',
      );

      // ── SOMEBODY WITH NO SALES ROLE SEES NONE OF IT ──────────────────────
      const outsider = await call(w.inventory.token, 'GET', '/api/sales/board');
      assert.equal(outsider.status, 403, JSON.stringify(outsider.body));
    });
  },
);
