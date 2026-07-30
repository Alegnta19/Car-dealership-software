import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';
import {
  INTEGRATION_DATABASE_URL,
  countRows,
  makeWorld,
  resetDatabase,
  seedMPITemplate,
  seedTechnician,
  skipIntegration,
  type TestWorld,
} from './helpers/db';
import * as promClient from 'prom-client';
import { closePool, query, withTransaction } from '../src/shared/database/pool';
import { consumeStepUpToken, signStepUpToken } from '../src/shared/security/step-up';
import { refreshAggregatedMetrics } from '../src/modules/service-cockpit/services/metrics-aggregator';
import * as svc from '../src/modules/service-cockpit/services/service-cockpit-service';

/**
 * Behaviour that only exists against a real database: transaction rollback, row locks,
 * unique-index backstops, and the tenant predicates that carry isolation.
 */
describe('service cockpit integration', { skip: skipIntegration ? 'set TEST_DATABASE_URL to run' : false }, () => {
  let w: TestWorld;

  before(async () => {
    assert.ok(INTEGRATION_DATABASE_URL, 'database URL required');
  });

  after(async () => {
    await closePool();
  });

  beforeEach(async () => {
    await resetDatabase();
    w = makeWorld();
  });

  const futureISO = (days = 1) => new Date(Date.now() + days * 86_400_000).toISOString();

  async function newAppointment(ctx = w.tenantA, locationId = w.locationA) {
    return svc.createAppointment(ctx, {
      location_id: locationId,
      mdm_customer_id: w.customer,
      mdm_vehicle_id: w.vehicle,
      scheduled_start: futureISO(),
    });
  }

  /** Drives an RO to the point where a customer decision can be recorded. */
  async function roAwaitingAuthorization() {
    const appt = await newAppointment();
    const ro = await svc.checkIn(w.tenantA, appt.appointment_id, { odometer: 10_000 });
    const line = await svc.addLineItem(w.tenantA, ro.ro_id, {
      line_type: 'labor',
      description: 'Replace front brake pads',
      estimated_hours: 1.5,
    });
    const estimate = await svc.generateEstimate(w.tenantA, ro.ro_id, {});
    await svc.sendEstimate(w.tenantA, ro.ro_id, estimate.estimate_id, {});
    return { ro, line, estimate };
  }

  // ── Tenant isolation ────────────────────────────────────────

  test('another tenant cannot read a repair order by id', async () => {
    const appt = await newAppointment();
    const ro = await svc.checkIn(w.tenantA, appt.appointment_id, {});

    await assert.rejects(
      () => svc.getRO(w.tenantB, ro.ro_id),
      (err: any) => err.code === 'ro_not_found' && err.statusCode === 404,
    );
  });

  test('another tenant cannot transition or attach work to a repair order', async () => {
    const appt = await newAppointment();
    const ro = await svc.checkIn(w.tenantA, appt.appointment_id, {});

    await assert.rejects(() => svc.transitionRO(w.tenantB, ro.ro_id, 'canceled', {}), /not found/i);
    await assert.rejects(
      () => svc.addLineItem(w.tenantB, ro.ro_id, { line_type: 'labor', description: 'theirs' }),
      /not found/i,
    );
    assert.equal(await countRows('ro_line_items', 'ro_id=$1', [ro.ro_id]), 0);
  });

  test('recordAuthorization cannot approve a line item belonging to another repair order', async () => {
    const first = await roAwaitingAuthorization();
    const second = await roAwaitingAuthorization();

    await assert.rejects(
      () => svc.recordAuthorization(w.tenantA, first.ro.ro_id, {
        estimate_id: first.estimate.estimate_id,
        method: 'portal',
        approved_items: [second.line.line_item_id],
        evidence_refs: { portal_submission_id: randomUUID() },
      }),
      (err: any) => err.code === 'unknown_line_items',
    );

    const untouched = await query(`SELECT authorization_status FROM ro_line_items WHERE line_item_id=$1`, [
      second.line.line_item_id,
    ]);
    assert.equal(untouched.rows[0].authorization_status, 'pending');
  });

  // ── Idempotency and atomicity ───────────────────────────────

  test('checking in twice yields one repair order, not two', async () => {
    const appt = await newAppointment();
    const first = await svc.checkIn(w.tenantA, appt.appointment_id, { odometer: 1000 });
    const second = await svc.checkIn(w.tenantA, appt.appointment_id, { odometer: 1000 });

    assert.equal(second.ro_id, first.ro_id);
    assert.equal(second.idempotent_replay, true);
    assert.equal(await countRows('repair_orders', 'appointment_id=$1', [appt.appointment_id]), 1);
  });

  test('the unique index refuses a second repair order for one appointment', async () => {
    const appt = await newAppointment();
    await svc.checkIn(w.tenantA, appt.appointment_id, {});

    await assert.rejects(
      () => svc.createRO(w.tenantA, {
        location_id: w.locationA,
        mdm_customer_id: w.customer,
        mdm_vehicle_id: w.vehicle,
        appointment_id: appt.appointment_id,
      }),
      (err: any) => err.code === 'appointment_already_converted' && err.statusCode === 409,
    );
  });

  test('a failed authorization leaves no partial write behind', async () => {
    const { ro, line, estimate } = await roAwaitingAuthorization();

    // Contradictory decision: rejected after validation, before anything is written.
    await assert.rejects(
      () => svc.recordAuthorization(w.tenantA, ro.ro_id, {
        estimate_id: estimate.estimate_id,
        method: 'portal',
        approved_items: [line.line_item_id],
        declined_items: [line.line_item_id],
        evidence_refs: { portal_submission_id: randomUUID() },
      }),
      (err: any) => err.code === 'contradictory_decision',
    );

    assert.equal(await countRows('ro_authorizations', 'ro_id=$1', [ro.ro_id]), 0);
    const still = await query(`SELECT authorization_status FROM ro_line_items WHERE line_item_id=$1`, [line.line_item_id]);
    assert.equal(still.rows[0].authorization_status, 'pending');
  });

  // ── The authorization gate ──────────────────────────────────

  test('an all-declined decision does not open the authorization gate', async () => {
    const { ro, line, estimate } = await roAwaitingAuthorization();

    const auth = await svc.recordAuthorization(w.tenantA, ro.ro_id, {
      estimate_id: estimate.estimate_id,
      method: 'portal',
      approved_items: [],
      declined_items: [line.line_item_id],
      evidence_refs: { portal_submission_id: randomUUID() },
    });
    assert.equal(auth.status, 'declined');

    const token = signStepUpToken({
      tenantId: w.tenantA.tenantId,
      userId: w.tenantA.userId,
      action: 'ro.transition:authorized',
      resourceId: ro.ro_id,
    });
    await assert.rejects(
      () => svc.transitionRO(w.tenantA, ro.ro_id, 'authorized', { step_up_token: token }),
      (err: any) => err.code === 'authorization_required' && err.statusCode === 422,
    );
  });

  test('a genuine approval plus step-up opens the gate exactly once', async () => {
    const { ro, line, estimate } = await roAwaitingAuthorization();

    const auth = await svc.recordAuthorization(w.tenantA, ro.ro_id, {
      estimate_id: estimate.estimate_id,
      method: 'portal',
      approved_items: [line.line_item_id],
      evidence_refs: { portal_submission_id: randomUUID() },
    });
    assert.equal(auth.status, 'approved');

    const estimateRow = await query(`SELECT status FROM ro_estimates WHERE estimate_id=$1`, [estimate.estimate_id]);
    assert.equal(estimateRow.rows[0].status, 'approved');

    const binding = {
      tenantId: w.tenantA.tenantId,
      userId: w.tenantA.userId,
      action: 'ro.transition:authorized',
      resourceId: ro.ro_id,
    };
    const token = signStepUpToken(binding);

    const moved = await svc.transitionRO(w.tenantA, ro.ro_id, 'authorized', { step_up_token: token });
    assert.equal(moved.status, 'authorized');

    // A token bound to a different action is refused — binding, not consumption.
    await svc.transitionRO(w.tenantA, ro.ro_id, 'in_repair', {});
    await assert.rejects(
      () => svc.transitionRO(w.tenantA, ro.ro_id, 'canceled', { step_up_token: token }),
      (err: any) => err.code === 'step_up_required',
    );

    // Consumption specifically: replaying the *same* token for the *same* action on the
    // *same* resource must fail, and the only thing that can make it fail is the ledger.
    // Asserted through consumeStepUpToken directly, because the state machine will not
    // let one repair order make the same gated transition twice.
    const fresh = signStepUpToken(binding);
    await withTransaction((tx) => consumeStepUpToken(tx, fresh, binding));
    await assert.rejects(
      () => withTransaction((tx) => consumeStepUpToken(tx, fresh, binding)),
      (err: any) => err.code === 'step_up_required' && /already been used/i.test(err.message),
      'a spent token is refused on replay',
    );
  });

  test('a rolled-back operation releases its step-up token for a genuine retry', async () => {
    const binding = {
      tenantId: w.tenantA.tenantId,
      userId: w.tenantA.userId,
      action: 'ro.transition:authorized',
      resourceId: randomUUID(),
    };
    const token = signStepUpToken(binding);

    // Consume it inside a transaction that then fails: the ledger row must roll back
    // with it, or a transient error would burn the customer's step-up.
    await assert.rejects(() => withTransaction(async (tx) => {
      await consumeStepUpToken(tx, token, binding);
      throw new Error('simulated downstream failure');
    }), /simulated downstream failure/);

    await withTransaction((tx) => consumeStepUpToken(tx, token, binding));
  });

  test('transitioning to authorized without a step-up token is refused', async () => {
    const { ro, line, estimate } = await roAwaitingAuthorization();
    await svc.recordAuthorization(w.tenantA, ro.ro_id, {
      estimate_id: estimate.estimate_id,
      method: 'portal',
      approved_items: [line.line_item_id],
      evidence_refs: { portal_submission_id: randomUUID() },
    });

    await assert.rejects(
      () => svc.transitionRO(w.tenantA, ro.ro_id, 'authorized', {}),
      (err: any) => err.code === 'step_up_required' && err.statusCode === 403,
    );
  });

  test('an approval of a superseded estimate does not authorize the current one', async () => {
    const { ro, line, estimate } = await roAwaitingAuthorization();
    await svc.recordAuthorization(w.tenantA, ro.ro_id, {
      estimate_id: estimate.estimate_id,
      method: 'portal',
      approved_items: [line.line_item_id],
      evidence_refs: { portal_submission_id: randomUUID() },
    });

    // Re-estimate: a new version supersedes the approved one, and is sent for a fresh
    // decision the customer has not yet given.
    await svc.transitionRO(w.tenantA, ro.ro_id, 'estimate_pending', { reason: 'extra work found' });
    await svc.addLineItem(w.tenantA, ro.ro_id, { line_type: 'labor', description: 'Rear rotors', estimated_hours: 2 });
    const revised = await svc.generateEstimate(w.tenantA, ro.ro_id, {});
    assert.equal(revised.version, 2);
    await svc.sendEstimate(w.tenantA, ro.ro_id, revised.estimate_id, {});

    const token = signStepUpToken({
      tenantId: w.tenantA.tenantId,
      userId: w.tenantA.userId,
      action: 'ro.transition:authorized',
      resourceId: ro.ro_id,
    });
    await assert.rejects(
      () => svc.transitionRO(w.tenantA, ro.ro_id, 'authorized', { step_up_token: token }),
      (err: any) => err.code === 'authorization_required',
    );
  });

  // ── Queue lifecycle ─────────────────────────────────────────

  test('queue items follow the repair order instead of accumulating', async () => {
    const appt = await newAppointment();
    const ro = await svc.checkIn(w.tenantA, appt.appointment_id, {});

    const openTypes = async () =>
      (await query(
        `SELECT queue_type FROM service_queue_items
          WHERE ro_id=$1 AND status NOT IN ('done','canceled') ORDER BY queue_type`,
        [ro.ro_id],
      )).rows.map((r: any) => r.queue_type);

    assert.deepEqual(await openTypes(), ['waiting_checkin']);

    await svc.addLineItem(w.tenantA, ro.ro_id, { line_type: 'labor', description: 'Oil change', estimated_hours: 0.5 });
    const estimate = await svc.generateEstimate(w.tenantA, ro.ro_id, {});
    assert.deepEqual(await openTypes(), ['waiting_authorization'], 'check-in queue closed when the estimate is drafted');

    await svc.sendEstimate(w.tenantA, ro.ro_id, estimate.estimate_id, {});
    assert.deepEqual(await openTypes(), ['waiting_authorization'], 'no duplicate authorization item');

    await svc.transitionRO(w.tenantA, ro.ro_id, 'canceled', {
      step_up_token: signStepUpToken({
        tenantId: w.tenantA.tenantId,
        userId: w.tenantA.userId,
        action: 'ro.transition:canceled',
        resourceId: ro.ro_id,
      }),
    });
    assert.deepEqual(await openTypes(), [], 'a terminal repair order leaves no open queue work');
  });

  // ── Inspections ─────────────────────────────────────────────

  test('re-recording an inspection item replaces it rather than duplicating', async () => {
    const appt = await newAppointment();
    const ro = await svc.checkIn(w.tenantA, appt.appointment_id, {});
    const templateId = await seedMPITemplate(w.tenantA, w.locationA);
    const session = await svc.startMPISession(w.tenantA, ro.ro_id, {
      template_id: templateId,
      tech_user_id: w.technician.userId,
    });

    await svc.recordMPIResult(w.tenantA, session.mpi_session_id, {
      item_key: 'brake_pads_front', status: 'attention', severity: 'maintenance',
    });
    await svc.recordMPIResult(w.tenantA, session.mpi_session_id, {
      item_key: 'brake_pads_front', status: 'fail', severity: 'safety',
    });

    assert.equal(await countRows('mpi_results', 'mpi_session_id=$1', [session.mpi_session_id]), 1);

    const submitted = await svc.submitMPISession(w.tenantA, session.mpi_session_id);
    assert.equal(submitted.recommendations_generated, 1);

    const rec = await query(`SELECT priority FROM service_recommendations WHERE ro_id=$1`, [ro.ro_id]);
    assert.equal(rec.rows[0].priority, 'p0', 'a safety failure is p0, not the old default of p2');
  });

  test('a failed inspection item must state its severity', async () => {
    const appt = await newAppointment();
    const ro = await svc.checkIn(w.tenantA, appt.appointment_id, {});
    const templateId = await seedMPITemplate(w.tenantA, w.locationA);
    const session = await svc.startMPISession(w.tenantA, ro.ro_id, {
      template_id: templateId,
      tech_user_id: w.technician.userId,
    });

    await assert.rejects(
      () => svc.recordMPIResult(w.tenantA, session.mpi_session_id, { item_key: 'tyres', status: 'fail' }),
      (err: any) => err.code === 'severity_required',
    );
  });

  // ── Technician time ─────────────────────────────────────────

  test('clock events must form a coherent sequence', async () => {
    const appt = await newAppointment();
    const ro = await svc.checkIn(w.tenantA, appt.appointment_id, {});
    const line = await svc.addLineItem(w.tenantA, ro.ro_id, { line_type: 'labor', description: 'Diagnose noise' });
    await seedTechnician(w.tenantA, w.locationA, w.technician.userId);

    const ticket = await svc.dispatchTech(w.tenantA, {
      ro_id: ro.ro_id,
      line_item_id: line.line_item_id,
      tech_user_id: w.technician.userId,
    });

    await assert.rejects(
      () => svc.recordTimeEntry(w.technician, ticket.ticket_id, { event_type: 'stop' }),
      (err: any) => err.code === 'invalid_time_sequence',
    );

    await svc.recordTimeEntry(w.technician, ticket.ticket_id, { event_type: 'start' });
    await assert.rejects(
      () => svc.recordTimeEntry(w.technician, ticket.ticket_id, { event_type: 'start' }),
      (err: any) => err.code === 'invalid_time_sequence',
    );
    await svc.recordTimeEntry(w.technician, ticket.ticket_id, { event_type: 'pause' });
    await svc.recordTimeEntry(w.technician, ticket.ticket_id, { event_type: 'resume' });
    await svc.recordTimeEntry(w.technician, ticket.ticket_id, { event_type: 'stop' });

    assert.equal(await countRows('tech_time_entries', 'ticket_id=$1', [ticket.ticket_id]), 4);
  });

  test('work cannot be dispatched to someone with no profile at the location', async () => {
    const appt = await newAppointment();
    const ro = await svc.checkIn(w.tenantA, appt.appointment_id, {});
    const line = await svc.addLineItem(w.tenantA, ro.ro_id, { line_type: 'labor', description: 'Alignment' });

    await assert.rejects(
      () => svc.dispatchTech(w.tenantA, {
        ro_id: ro.ro_id,
        line_item_id: line.line_item_id,
        tech_user_id: randomUUID(),
      }),
      (err: any) => err.code === 'tech_not_available',
    );
  });

  // ── Quality gate ────────────────────────────────────────────

  test('a vehicle with open work cannot be marked ready for pickup', async () => {
    const { ro, line, estimate } = await roAwaitingAuthorization();
    await svc.recordAuthorization(w.tenantA, ro.ro_id, {
      estimate_id: estimate.estimate_id,
      method: 'portal',
      approved_items: [line.line_item_id],
      evidence_refs: { portal_submission_id: randomUUID() },
    });
    await svc.transitionRO(w.tenantA, ro.ro_id, 'authorized', {
      step_up_token: signStepUpToken({
        tenantId: w.tenantA.tenantId,
        userId: w.tenantA.userId,
        action: 'ro.transition:authorized',
        resourceId: ro.ro_id,
      }),
    });
    await svc.transitionRO(w.tenantA, ro.ro_id, 'in_repair', {});
    await svc.transitionRO(w.tenantA, ro.ro_id, 'qc', {});

    await assert.rejects(
      () => svc.transitionRO(w.tenantA, ro.ro_id, 'ready_for_pickup', {}),
      (err: any) => err.code === 'work_incomplete',
    );

    await svc.updateLineItem(w.tenantA, ro.ro_id, line.line_item_id, { status: 'completed' });
    const ready = await svc.transitionRO(w.tenantA, ro.ro_id, 'ready_for_pickup', {});
    assert.equal(ready.status, 'ready_for_pickup');
  });

  test('a declined line cannot be reopened by the shop floor', async () => {
    const { ro, line, estimate } = await roAwaitingAuthorization();
    await svc.recordAuthorization(w.tenantA, ro.ro_id, {
      estimate_id: estimate.estimate_id,
      method: 'portal',
      approved_items: [],
      declined_items: [line.line_item_id],
      evidence_refs: { portal_submission_id: randomUUID() },
    });

    await assert.rejects(
      () => svc.updateLineItem(w.tenantA, ro.ro_id, line.line_item_id, { status: 'in_progress' }),
      (err: any) => err.code === 'line_item_declined',
    );
  });

  // ── Schema-level guarantees ─────────────────────────────────

  test('updated_at is maintained by the database, not by remembering to set it', async () => {
    const appt = await newAppointment();

    // Back-date it, so "the trigger fired" and "nothing happened" cannot look alike.
    await query(
      `UPDATE service_appointments SET updated_at = NOW() - INTERVAL '10 days' WHERE appointment_id=$1`,
      [appt.appointment_id],
    );
    await query(
      `UPDATE service_appointments SET updated_at = NOW() - INTERVAL '10 days' WHERE appointment_id=$1`,
      [appt.appointment_id],
    );
    const stale = await query(`SELECT updated_at FROM service_appointments WHERE appointment_id=$1`, [
      appt.appointment_id,
    ]);
    const staleAt = new Date(stale.rows[0].updated_at).getTime();

    // A statement that touches a different column and deliberately never mentions
    // updated_at. Only the trigger can move it.
    await query(`UPDATE service_appointments SET scheduled_end = NOW() WHERE appointment_id=$1`, [
      appt.appointment_id,
    ]);

    const after = await query(`SELECT updated_at FROM service_appointments WHERE appointment_id=$1`, [
      appt.appointment_id,
    ]);
    const afterAt = new Date(after.rows[0].updated_at).getTime();
    assert.ok(afterAt > staleAt, 'updated_at must advance without the statement setting it');
    assert.ok(Date.now() - afterAt < 60_000, 'and it must advance to now, not to some other stale value');
  });

  test('a rejected second offer leaves no orphan appointment behind', async () => {
    const dealId = randomUUID();
    await svc.createFirstServiceOffer(w.tenantA, {
      location_id: w.locationA, mdm_customer_id: w.customer, mdm_vehicle_id: w.vehicle,
      deal_id: dealId, recommended_window_start: futureISO(90),
    });
    const apptsAfterFirst = await countRows('service_appointments', 'tenant_id=$1', [w.tenantA.tenantId]);

    await assert.rejects(
      () => svc.createFirstServiceOffer(w.tenantA, {
        location_id: w.locationA, mdm_customer_id: w.customer, mdm_vehicle_id: w.vehicle,
        deal_id: dealId, recommended_window_start: futureISO(90),
      }),
      (err: any) => err.code === 'offer_already_exists',
    );

    // The appointment for the rejected retry was rolled back with the offer insert.
    assert.equal(
      await countRows('service_appointments', 'tenant_id=$1', [w.tenantA.tenantId]),
      apptsAfterFirst,
      'the failed offer did not strand a second appointment',
    );
  });

  test('comeback rate keeps the returning repair order in its own denominator', async () => {
    // Two repair orders closed; one comes back. The rate must be 1/2, not 1/1 — the
    // denominator is "closed in the window", read from the event log, so flipping the
    // original to comeback must not drop it from the count.
    const closeRO = async () => {
      const { ro, line, estimate } = await roAwaitingAuthorization();
      await svc.recordAuthorization(w.tenantA, ro.ro_id, {
        estimate_id: estimate.estimate_id, method: 'portal', approved_items: [line.line_item_id],
        evidence_refs: { portal_submission_id: randomUUID() },
      });
      await svc.transitionRO(w.tenantA, ro.ro_id, 'authorized', {
        step_up_token: signStepUpToken({
          tenantId: w.tenantA.tenantId, userId: w.tenantA.userId,
          action: 'ro.transition:authorized', resourceId: ro.ro_id,
        }),
      });
      await svc.transitionRO(w.tenantA, ro.ro_id, 'in_repair', {});
      await svc.updateLineItem(w.tenantA, ro.ro_id, line.line_item_id, { status: 'completed' });
      await svc.transitionRO(w.tenantA, ro.ro_id, 'qc', {});
      await svc.transitionRO(w.tenantA, ro.ro_id, 'ready_for_pickup', {});
      await svc.transitionRO(w.tenantA, ro.ro_id, 'closed', {});
      return ro;
    };

    const first = await closeRO();
    await closeRO();
    const fresh = await svc.createRO(w.tenantA, {
      location_id: w.locationA, mdm_customer_id: w.customer, mdm_vehicle_id: w.vehicle,
    });
    await svc.createComebackCase(w.tenantA, {
      original_ro_id: first.ro_id, new_ro_id: fresh.ro_id, root_cause_category: 'workmanship', reason_codes: [],
    });

    await refreshAggregatedMetrics();
    const exposition = await promClient.register.metrics();
    const line = exposition.split('\n').find((l) =>
      l.startsWith('service_comeback_rate{') && l.includes(`location="${w.locationA}"`));
    assert.ok(line, 'comeback rate published');
    const value = Number(line!.slice(line!.lastIndexOf(' ') + 1));
    assert.ok(Math.abs(value - 0.5) < 1e-6, `expected 1 comeback ÷ 2 closed = 0.5, got ${value}`);
  });

  test('parts wait time is measured once, from first receipt', async () => {
    const { ro, line } = await roAwaitingAuthorization();
    const part = await svc.requestPart(w.tenantA, ro.ro_id, {
      line_item_id: line.line_item_id, part_number: 'BP-77', description: 'Pads',
    });

    await svc.updatePartLine(w.tenantA, part.part_line_id, { status: 'received' });
    const firstReceipt = await query(`SELECT received_at FROM ro_parts_lines WHERE part_line_id=$1`, [part.part_line_id]);
    assert.ok(firstReceipt.rows[0].received_at, 'received_at stamped on receipt');

    // A later progression must not move received_at.
    await svc.updatePartLine(w.tenantA, part.part_line_id, { status: 'installed' });
    const afterInstall = await query(`SELECT received_at FROM ro_parts_lines WHERE part_line_id=$1`, [part.part_line_id]);
    assert.equal(
      new Date(afterInstall.rows[0].received_at).getTime(),
      new Date(firstReceipt.rows[0].received_at).getTime(),
      'received_at is a fixed point, not bumped on later status changes',
    );
  });

  test('a drained queue publishes zero depth, not its last non-zero reading', async () => {
    const appt = await newAppointment();
    const ro = await svc.checkIn(w.tenantA, appt.appointment_id, {});
    await refreshAggregatedMetrics();
    let exposition = await promClient.register.metrics();
    assert.ok(
      exposition.includes(`service_queue_depth{queue_type="waiting_checkin",location="${w.locationA}"} 1`),
      'depth reads 1 while the item is open',
    );

    await svc.transitionRO(w.tenantA, ro.ro_id, 'canceled', {
      step_up_token: signStepUpToken({
        tenantId: w.tenantA.tenantId, userId: w.tenantA.userId,
        action: 'ro.transition:canceled', resourceId: ro.ro_id,
      }),
    });
    await refreshAggregatedMetrics();
    exposition = await promClient.register.metrics();
    assert.ok(
      !exposition.includes(`service_queue_depth{queue_type="waiting_checkin",location="${w.locationA}"}`),
      'the drained queue series is gone, not stuck at 1',
    );
  });

  test('the retention bridge records the deal and marks it converted on check-in', async () => {
    const dealId = randomUUID();
    const offer = await svc.createFirstServiceOffer(w.tenantA, {
      location_id: w.locationA,
      mdm_customer_id: w.customer,
      mdm_vehicle_id: w.vehicle,
      deal_id: dealId,
      recommended_window_start: futureISO(90),
    });

    const offered = await query(`SELECT status, deal_id FROM first_service_offers WHERE offer_id=$1`, [offer.offer_id]);
    assert.equal(offered.rows[0].status, 'offered');
    assert.equal(offered.rows[0].deal_id, dealId);

    await svc.checkIn(w.tenantA, offer.appointment_id, {});

    const converted = await query(`SELECT status, ro_id FROM first_service_offers WHERE offer_id=$1`, [offer.offer_id]);
    assert.equal(converted.rows[0].status, 'converted');
    assert.ok(converted.rows[0].ro_id, 'the converted offer points at the repair order');
  });

  test('pagination is honoured and capped', async () => {
    const appt = await newAppointment();
    await svc.checkIn(w.tenantA, appt.appointment_id, {});

    const page = await svc.listServiceQueueItems(w.tenantA, { limit: 1 });
    assert.equal(page.length, 1);

    await assert.rejects(() => svc.listServiceQueueItems(w.tenantA, { limit: -1 }), /non-negative/);
    await assert.rejects(() => svc.listServiceQueueItems(w.tenantA, { limit: 0 }), /greater than zero/);
  });

  // ── Scheduled metrics ───────────────────────────────────────

  test('the aggregator computes technician ratios without inflating the denominator', async () => {
    const tech = randomUUID();
    await seedTechnician(w.tenantA, w.locationA, tech);

    // Two tickets for one technician: scheduled hours must be counted once, not twice.
    for (const label of ['first', 'second']) {
      const appt = await newAppointment();
      const ro = await svc.checkIn(w.tenantA, appt.appointment_id, {});
      const line = await svc.addLineItem(w.tenantA, ro.ro_id, {
        line_type: 'labor', description: `Job ${label}`, estimated_hours: 1,
      });
      const ticket = await svc.dispatchTech(w.tenantA, {
        ro_id: ro.ro_id, line_item_id: line.line_item_id, tech_user_id: tech,
      });
      await svc.recordTimeEntry(w.tenantA, ticket.ticket_id, {
        event_type: 'start', occurred_at: new Date(Date.now() - 7_200_000).toISOString(),
      });
      await svc.recordTimeEntry(w.tenantA, ticket.ticket_id, {
        event_type: 'stop', occurred_at: new Date(Date.now() - 3_600_000).toISOString(),
      });
      await svc.updateLineItem(w.tenantA, ro.ro_id, line.line_item_id, { sold_hours: 1 });
    }

    await refreshAggregatedMetrics();
    const exposition = await promClient.register.metrics();
    const seriesFor = (name: string) => {
      const line = exposition.split('\n').find((l) => l.startsWith(`${name}{location="${w.locationA}"}`));
      assert.ok(line, `${name} should be published`);
      return Number(line!.slice(line!.lastIndexOf(' ') + 1));
    };

    // Two clocked hours against one technician's 40h/week over the 30-day window.
    const expectedUtilization = 2 / (40 * (30 / 7));
    assert.ok(
      Math.abs(seriesFor('service_tech_utilization') - expectedUtilization) < 1e-4,
      'scheduled hours counted once per technician, not once per ticket',
    );
    assert.ok(Math.abs(seriesFor('service_tech_efficiency') - 1) < 1e-4, '2 sold ÷ 2 clocked');
    assert.ok(Math.abs(seriesFor('service_tech_proficiency') - 1) < 1e-4, '2 estimated ÷ 2 clocked');

    // No parts were requested, so the backorder ratio has no denominator and is absent
    // rather than reported as a confident zero.
    assert.ok(
      !exposition.includes(`service_parts_backorder_rate{location="${w.locationA}"}`),
      'no parts activity means no parts series',
    );
  });

  test('a ratio with no denominator publishes nothing rather than a misleading zero', async () => {
    // Real activity at this location, but none of it gives the comeback rate a
    // denominator: no repair order has closed, so there is nothing to divide by.
    // The series must be absent, not 0.
    const appt = await newAppointment();
    await svc.checkIn(w.tenantA, appt.appointment_id, {});

    await refreshAggregatedMetrics();
    const exposition = await promClient.register.metrics();

    assert.ok(
      exposition.includes(`service_queue_depth{queue_type="waiting_checkin",location="${w.locationA}"} 1`),
      'the location is live and publishing what it can measure',
    );
    assert.ok(
      !exposition.split('\n').some((l) => l.startsWith('service_comeback_rate{') && l.includes(w.locationA)),
      'but a ratio with a zero denominator publishes no series at all',
    );
  });

  test('clock entries cannot be back-dated behind the previous entry', async () => {
    const tech = randomUUID();
    await seedTechnician(w.tenantA, w.locationA, tech);
    const appt = await newAppointment();
    const ro = await svc.checkIn(w.tenantA, appt.appointment_id, {});
    const line = await svc.addLineItem(w.tenantA, ro.ro_id, { line_type: 'labor', description: 'Backdate probe' });
    const ticket = await svc.dispatchTech(w.tenantA, {
      ro_id: ro.ro_id, line_item_id: line.line_item_id, tech_user_id: tech,
    });

    await svc.recordTimeEntry(w.tenantA, ticket.ticket_id, { event_type: 'start' });
    await assert.rejects(
      () => svc.recordTimeEntry(w.tenantA, ticket.ticket_id, {
        event_type: 'stop', occurred_at: new Date(Date.now() - 86_400_000).toISOString(),
      }),
      (err: any) => err.code === 'invalid_time_sequence',
    );
  });

  test('estimate totals report money when lines carry it, and flag when they do not', async () => {
    const appt = await newAppointment();
    const ro = await svc.checkIn(w.tenantA, appt.appointment_id, {});
    const priced = await svc.addLineItem(w.tenantA, ro.ro_id, { line_type: 'labor', description: 'Brakes', estimated_hours: 2 });
    await svc.addLineItem(w.tenantA, ro.ro_id, { line_type: 'fee', description: 'Shop supplies' });
    await svc.updateLineItem(w.tenantA, ro.ro_id, priced.line_item_id, {
      price_ref: { amount_cents: 24_900, currency: 'USD' },
    });

    const estimate = await svc.generateEstimate(w.tenantA, ro.ro_id, {});
    assert.equal(estimate.totals_ref.amount_cents, 24_900);
    assert.equal(estimate.totals_ref.currency, 'USD');
    assert.equal(estimate.totals_ref.priced_line_count, 1);
    assert.equal(estimate.totals_ref.unpriced_line_count, 1);
  });
});
