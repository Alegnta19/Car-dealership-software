import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';
import {
  INTEGRATION_DATABASE_URL,
  bootstrapAdministrator,
  countRows,
  makeWorld,
  resetDatabase,
  seedMPITemplate,
  seedTechnician,
  seedUserLinkRow,
  skipIntegration,
  type TestWorld,
} from '@dealer/test-kit';
import { ROLES } from '@dealer/contracts';
import { grantRole, rolesForUserLink } from '@dealer/identity-access';
import type { AuthContext } from '@dealer/fixed-ops';
import * as promClient from 'prom-client';
import { closePool, query, withTransaction } from '@dealer/database';
import { consumeSensitiveActionGrant } from '@dealer/fixed-ops';
import { mintReauthGrant, seedTestWorldIdentity } from '@dealer/test-kit';
import { refreshAggregatedMetrics } from '@dealer/fixed-ops';
import * as svc from '@dealer/fixed-ops';
import { seedStandardMPITemplate } from '../scripts/seed-mpi-template';
import { STANDARD_MPI_ITEMS } from '@dealer/fixed-ops';

/**
 * Behaviour that only exists against a real database: transaction rollback, row locks,
 * unique-index backstops, and the tenant predicates that carry isolation.
 */
describe(
  'service cockpit integration',
  { skip: skipIntegration ? 'set TEST_DATABASE_URL to run' : false },
  () => {
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
      // FBL-020: reauthentication grants FK real tenants and user links
      await seedTestWorldIdentity(w);
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

      await assert.rejects(
        () => svc.transitionRO(w.tenantB, ro.ro_id, 'canceled', {}),
        /not found/i,
      );
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
        () =>
          svc.recordAuthorization(w.tenantA, first.ro.ro_id, {
            estimate_id: first.estimate.estimate_id,
            method: 'portal',
            approved_items: [second.line.line_item_id],
            evidence_refs: { portal_submission_id: randomUUID() },
          }),
        (err: any) => err.code === 'unknown_line_items',
      );

      const untouched = await query(
        `SELECT authorization_status FROM ro_line_items WHERE line_item_id=$1`,
        [second.line.line_item_id],
      );
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
        () =>
          svc.createRO(w.tenantA, {
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
        () =>
          svc.recordAuthorization(w.tenantA, ro.ro_id, {
            estimate_id: estimate.estimate_id,
            method: 'portal',
            approved_items: [line.line_item_id],
            declined_items: [line.line_item_id],
            evidence_refs: { portal_submission_id: randomUUID() },
          }),
        (err: any) => err.code === 'contradictory_decision',
      );

      assert.equal(await countRows('ro_authorizations', 'ro_id=$1', [ro.ro_id]), 0);
      const still = await query(
        `SELECT authorization_status FROM ro_line_items WHERE line_item_id=$1`,
        [line.line_item_id],
      );
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

      const token = await mintReauthGrant({
        tenantId: w.tenantA.tenantId,
        userLinkId: w.tenantA.userId,
        action: 'service.ro.transition:authorized',
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

      const estimateRow = await query(`SELECT status FROM ro_estimates WHERE estimate_id=$1`, [
        estimate.estimate_id,
      ]);
      assert.equal(estimateRow.rows[0].status, 'approved');

      const binding = {
        tenantId: w.tenantA.tenantId,
        userId: w.tenantA.userId,
        action: 'service.ro.transition:authorized',
        resourceId: ro.ro_id,
      };
      const token = await mintReauthGrant({
        tenantId: binding.tenantId,
        userLinkId: binding.userId,
        action: binding.action,
        resourceId: binding.resourceId,
      });

      const moved = await svc.transitionRO(w.tenantA, ro.ro_id, 'authorized', {
        step_up_token: token,
      });
      assert.equal(moved.status, 'authorized');

      // A grant bound to a different action is refused — binding, not consumption.
      await svc.transitionRO(w.tenantA, ro.ro_id, 'in_repair', {});
      const staleForCancel = await mintReauthGrant({
        tenantId: binding.tenantId,
        userLinkId: binding.userId,
        action: 'service.ro.transition:authorized',
        resourceId: ro.ro_id,
      });
      await assert.rejects(
        () => svc.transitionRO(w.tenantA, ro.ro_id, 'canceled', { step_up_token: staleForCancel }),
        (err: any) => err.code === 'step_up_required',
      );

      // Consumption specifically: replaying the *same* grant for the *same* action on the
      // *same* resource must fail, and the only thing that can make it fail is the atomic
      // spend. Asserted through consumeSensitiveActionGrant directly, because the state
      // machine will not let one repair order make the same gated transition twice.
      const fresh = await mintReauthGrant({
        tenantId: binding.tenantId,
        userLinkId: binding.userId,
        action: binding.action,
        resourceId: binding.resourceId,
      });
      await withTransaction((tx) => consumeSensitiveActionGrant(tx, fresh, binding));
      await assert.rejects(
        () => withTransaction((tx) => consumeSensitiveActionGrant(tx, fresh, binding)),
        (err: any) => err.code === 'step_up_required',
        'a spent grant is refused on replay',
      );
    });

    test('a rolled-back operation releases its reauthentication grant for a genuine retry', async () => {
      const binding = {
        tenantId: w.tenantA.tenantId,
        userId: w.tenantA.userId,
        action: 'service.ro.transition:authorized',
        resourceId: randomUUID(),
      };
      const token = await mintReauthGrant({
        tenantId: binding.tenantId,
        userLinkId: binding.userId,
        action: binding.action,
        resourceId: binding.resourceId,
      });

      // Spend it inside a transaction that then fails: the spend must roll back
      // with it, or a transient error would burn the customer's reauthentication.
      await assert.rejects(
        () =>
          withTransaction(async (tx) => {
            await consumeSensitiveActionGrant(tx, token, binding);
            throw new Error('simulated downstream failure');
          }),
        /simulated downstream failure/,
      );

      await withTransaction((tx) => consumeSensitiveActionGrant(tx, token, binding));
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
      await svc.transitionRO(w.tenantA, ro.ro_id, 'estimate_pending', {
        reason: 'extra work found',
      });
      await svc.addLineItem(w.tenantA, ro.ro_id, {
        line_type: 'labor',
        description: 'Rear rotors',
        estimated_hours: 2,
      });
      const revised = await svc.generateEstimate(w.tenantA, ro.ro_id, {});
      assert.equal(revised.version, 2);
      await svc.sendEstimate(w.tenantA, ro.ro_id, revised.estimate_id, {});

      const token = await mintReauthGrant({
        tenantId: w.tenantA.tenantId,
        userLinkId: w.tenantA.userId,
        action: 'service.ro.transition:authorized',
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
        (
          await query(
            `SELECT queue_type FROM service_queue_items
          WHERE ro_id=$1 AND status NOT IN ('done','canceled') ORDER BY queue_type`,
            [ro.ro_id],
          )
        ).rows.map((r: any) => r.queue_type);

      assert.deepEqual(await openTypes(), ['waiting_checkin']);

      await svc.addLineItem(w.tenantA, ro.ro_id, {
        line_type: 'labor',
        description: 'Oil change',
        estimated_hours: 0.5,
      });
      const estimate = await svc.generateEstimate(w.tenantA, ro.ro_id, {});
      assert.deepEqual(
        await openTypes(),
        ['waiting_authorization'],
        'check-in queue closed when the estimate is drafted',
      );

      await svc.sendEstimate(w.tenantA, ro.ro_id, estimate.estimate_id, {});
      assert.deepEqual(
        await openTypes(),
        ['waiting_authorization'],
        'no duplicate authorization item',
      );

      await svc.transitionRO(w.tenantA, ro.ro_id, 'canceled', {
        step_up_token: await mintReauthGrant({
          tenantId: w.tenantA.tenantId,
          userLinkId: w.tenantA.userId,
          action: 'service.ro.transition:canceled',
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
        item_key: 'brake_pads_front',
        status: 'attention',
        severity: 'maintenance',
      });
      await svc.recordMPIResult(w.tenantA, session.mpi_session_id, {
        item_key: 'brake_pads_front',
        status: 'fail',
        severity: 'safety',
      });

      assert.equal(
        await countRows('mpi_results', 'mpi_session_id=$1', [session.mpi_session_id]),
        1,
      );

      const submitted = await svc.submitMPISession(w.tenantA, session.mpi_session_id);
      assert.equal(submitted.recommendations_generated, 1);

      const rec = await query(`SELECT priority FROM service_recommendations WHERE ro_id=$1`, [
        ro.ro_id,
      ]);
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
        () =>
          svc.recordMPIResult(w.tenantA, session.mpi_session_id, {
            item_key: 'tyres',
            status: 'fail',
          }),
        (err: any) => err.code === 'severity_required',
      );
    });

    // ── Technician time ─────────────────────────────────────────

    test('clock events must form a coherent sequence', async () => {
      const appt = await newAppointment();
      const ro = await svc.checkIn(w.tenantA, appt.appointment_id, {});
      const line = await svc.addLineItem(w.tenantA, ro.ro_id, {
        line_type: 'labor',
        description: 'Diagnose noise',
      });
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
      const line = await svc.addLineItem(w.tenantA, ro.ro_id, {
        line_type: 'labor',
        description: 'Alignment',
      });

      await assert.rejects(
        () =>
          svc.dispatchTech(w.tenantA, {
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
        step_up_token: await mintReauthGrant({
          tenantId: w.tenantA.tenantId,
          userLinkId: w.tenantA.userId,
          action: 'service.ro.transition:authorized',
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

      // First direction: the column is not the statement's to write. This UPDATE asks for a
      // ten-day-old value and must not get it -- `set_updated_at` is a BEFORE UPDATE trigger
      // that assigns NOW() unconditionally, so it overrides whatever the statement supplied.
      // (An earlier version of this test back-dated the row as a setup step and then compared
      // timestamps in JavaScript. The back-dating was silently undone by the very trigger
      // under test, so both readings were really NOW() taken milliseconds apart, and the
      // assertion passed or failed on clock resolution.)
      const backdated = await query(
        `UPDATE service_appointments SET updated_at = NOW() - INTERVAL '10 days'
        WHERE appointment_id=$1
        RETURNING updated_at > NOW() - INTERVAL '1 minute' AS trigger_won, updated_at::text AS at`,
        [appt.appointment_id],
      );
      assert.ok(
        backdated.rows[0].trigger_won,
        'the trigger must override an updated_at supplied by the statement',
      );
      const before = backdated.rows[0].at;

      // Second direction: it advances on a statement that never mentions it. Compared inside
      // Postgres against the captured text, so the check keeps full microsecond precision --
      // a JavaScript Date truncates to whole milliseconds, which is what made this flaky.
      // The sleep puts the two statements in provably distinct transaction clocks.
      await query(`SELECT pg_sleep(0.05)`);
      await query(`UPDATE service_appointments SET scheduled_end = NOW() WHERE appointment_id=$1`, [
        appt.appointment_id,
      ]);

      const after = await query(
        `SELECT updated_at > $2::timestamptz AS advanced,
              updated_at <= NOW()          AS not_in_the_future
         FROM service_appointments WHERE appointment_id=$1`,
        [appt.appointment_id, before],
      );
      assert.ok(after.rows[0].advanced, 'updated_at must advance without the statement setting it');
      assert.ok(
        after.rows[0].not_in_the_future,
        'and it must advance to now, not to some other value',
      );
    });

    test('a rejected second offer leaves no orphan appointment behind', async () => {
      const dealId = randomUUID();
      await svc.createFirstServiceOffer(w.tenantA, {
        location_id: w.locationA,
        mdm_customer_id: w.customer,
        mdm_vehicle_id: w.vehicle,
        deal_id: dealId,
        recommended_window_start: futureISO(90),
      });
      const apptsAfterFirst = await countRows('service_appointments', 'tenant_id=$1', [
        w.tenantA.tenantId,
      ]);

      await assert.rejects(
        () =>
          svc.createFirstServiceOffer(w.tenantA, {
            location_id: w.locationA,
            mdm_customer_id: w.customer,
            mdm_vehicle_id: w.vehicle,
            deal_id: dealId,
            recommended_window_start: futureISO(90),
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
          estimate_id: estimate.estimate_id,
          method: 'portal',
          approved_items: [line.line_item_id],
          evidence_refs: { portal_submission_id: randomUUID() },
        });
        await svc.transitionRO(w.tenantA, ro.ro_id, 'authorized', {
          step_up_token: await mintReauthGrant({
            tenantId: w.tenantA.tenantId,
            userLinkId: w.tenantA.userId,
            action: 'service.ro.transition:authorized',
            resourceId: ro.ro_id,
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
        location_id: w.locationA,
        mdm_customer_id: w.customer,
        mdm_vehicle_id: w.vehicle,
      });
      await svc.createComebackCase(w.tenantA, {
        original_ro_id: first.ro_id,
        new_ro_id: fresh.ro_id,
        root_cause_category: 'workmanship',
        reason_codes: [],
      });

      await refreshAggregatedMetrics();
      const exposition = await promClient.register.metrics();
      const line = exposition
        .split('\n')
        .find(
          (l) => l.startsWith('service_comeback_rate{') && l.includes(`location="${w.locationA}"`),
        );
      assert.ok(line, 'comeback rate published');
      const value = Number(line!.slice(line!.lastIndexOf(' ') + 1));
      assert.ok(Math.abs(value - 0.5) < 1e-6, `expected 1 comeback ÷ 2 closed = 0.5, got ${value}`);
    });

    test('parts wait time is measured once, from first receipt', async () => {
      const { ro, line } = await roAwaitingAuthorization();
      const part = await svc.requestPart(w.tenantA, ro.ro_id, {
        line_item_id: line.line_item_id,
        part_number: 'BP-77',
        description: 'Pads',
      });

      await svc.updatePartLine(w.tenantA, part.part_line_id, { status: 'received' });
      const firstReceipt = await query(
        `SELECT received_at FROM ro_parts_lines WHERE part_line_id=$1`,
        [part.part_line_id],
      );
      assert.ok(firstReceipt.rows[0].received_at, 'received_at stamped on receipt');

      // A later progression must not move received_at.
      await svc.updatePartLine(w.tenantA, part.part_line_id, { status: 'installed' });
      const afterInstall = await query(
        `SELECT received_at FROM ro_parts_lines WHERE part_line_id=$1`,
        [part.part_line_id],
      );
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
        exposition.includes(
          `service_queue_depth{queue_type="waiting_checkin",location="${w.locationA}"} 1`,
        ),
        'depth reads 1 while the item is open',
      );

      await svc.transitionRO(w.tenantA, ro.ro_id, 'canceled', {
        step_up_token: await mintReauthGrant({
          tenantId: w.tenantA.tenantId,
          userLinkId: w.tenantA.userId,
          action: 'service.ro.transition:canceled',
          resourceId: ro.ro_id,
        }),
      });
      await refreshAggregatedMetrics();
      exposition = await promClient.register.metrics();
      assert.ok(
        !exposition.includes(
          `service_queue_depth{queue_type="waiting_checkin",location="${w.locationA}"}`,
        ),
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

      const offered = await query(
        `SELECT status, deal_id FROM first_service_offers WHERE offer_id=$1`,
        [offer.offer_id],
      );
      assert.equal(offered.rows[0].status, 'offered');
      assert.equal(offered.rows[0].deal_id, dealId);

      await svc.checkIn(w.tenantA, offer.appointment_id, {});

      const converted = await query(
        `SELECT status, ro_id FROM first_service_offers WHERE offer_id=$1`,
        [offer.offer_id],
      );
      assert.equal(converted.rows[0].status, 'converted');
      assert.ok(converted.rows[0].ro_id, 'the converted offer points at the repair order');
    });

    test('pagination is honoured and capped', async () => {
      const appt = await newAppointment();
      await svc.checkIn(w.tenantA, appt.appointment_id, {});

      const page = await svc.listServiceQueueItems(w.tenantA, { limit: 1 });
      assert.equal(page.length, 1);

      await assert.rejects(
        () => svc.listServiceQueueItems(w.tenantA, { limit: -1 }),
        /non-negative/,
      );
      await assert.rejects(
        () => svc.listServiceQueueItems(w.tenantA, { limit: 0 }),
        /greater than zero/,
      );
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
          line_type: 'labor',
          description: `Job ${label}`,
          estimated_hours: 1,
        });
        const ticket = await svc.dispatchTech(w.tenantA, {
          ro_id: ro.ro_id,
          line_item_id: line.line_item_id,
          tech_user_id: tech,
        });
        await svc.recordTimeEntry(w.tenantA, ticket.ticket_id, {
          event_type: 'start',
          occurred_at: new Date(Date.now() - 7_200_000).toISOString(),
        });
        await svc.recordTimeEntry(w.tenantA, ticket.ticket_id, {
          event_type: 'stop',
          occurred_at: new Date(Date.now() - 3_600_000).toISOString(),
        });
        await svc.updateLineItem(w.tenantA, ro.ro_id, line.line_item_id, { sold_hours: 1 });
        await svc.updateLineItem(w.tenantA, ro.ro_id, line.line_item_id, { status: 'completed' });
      }

      // A third job, clocked but still open. It belongs in the utilization numerator -- the
      // bay really was busy -- but must stay out of efficiency and proficiency, whose
      // numerators are whole-line figures that only mean something once the work is done.
      const openAppt = await newAppointment();
      const openRO = await svc.checkIn(w.tenantA, openAppt.appointment_id, {});
      const openLine = await svc.addLineItem(w.tenantA, openRO.ro_id, {
        line_type: 'labor',
        description: 'Job still open',
        estimated_hours: 8,
      });
      const openTicket = await svc.dispatchTech(w.tenantA, {
        ro_id: openRO.ro_id,
        line_item_id: openLine.line_item_id,
        tech_user_id: tech,
      });
      await svc.recordTimeEntry(w.tenantA, openTicket.ticket_id, {
        event_type: 'start',
        occurred_at: new Date(Date.now() - 7_200_000).toISOString(),
      });
      await svc.recordTimeEntry(w.tenantA, openTicket.ticket_id, {
        event_type: 'stop',
        occurred_at: new Date(Date.now() - 3_600_000).toISOString(),
      });
      await svc.updateLineItem(w.tenantA, openRO.ro_id, openLine.line_item_id, { sold_hours: 8 });

      await refreshAggregatedMetrics();
      const exposition = await promClient.register.metrics();
      const seriesFor = (name: string) => {
        const line = exposition
          .split('\n')
          .find((l) => l.startsWith(`${name}{location="${w.locationA}"}`));
        assert.ok(line, `${name} should be published`);
        return Number(line!.slice(line!.lastIndexOf(' ') + 1));
      };

      // Three clocked hours in total against one technician's 40h/week over the 30-day
      // window -- the open job's hour counts here too.
      const expectedUtilization = 3 / (40 * (30 / 7));
      assert.ok(
        Math.abs(seriesFor('service_tech_utilization') - expectedUtilization) < 1e-4,
        'scheduled hours counted once per technician, not once per ticket, and open work still counts as clocked',
      );

      // Efficiency and proficiency see only the two finished jobs: 2 sold ÷ 2 clocked and
      // 2 estimated ÷ 2 clocked. If the open job leaked in, its 8 sold hours against 1
      // clocked hour would drag efficiency to 10/3.
      assert.ok(
        Math.abs(seriesFor('service_tech_efficiency') - 1) < 1e-4,
        '2 sold ÷ 2 clocked on finished work',
      );
      assert.ok(
        Math.abs(seriesFor('service_tech_proficiency') - 1) < 1e-4,
        '2 estimated ÷ 2 clocked on finished work',
      );

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
        exposition.includes(
          `service_queue_depth{queue_type="waiting_checkin",location="${w.locationA}"} 1`,
        ),
        'the location is live and publishing what it can measure',
      );
      assert.ok(
        !exposition
          .split('\n')
          .some((l) => l.startsWith('service_comeback_rate{') && l.includes(w.locationA)),
        'but a ratio with a zero denominator publishes no series at all',
      );
    });

    test('clock entries cannot be back-dated behind the previous entry', async () => {
      const tech = randomUUID();
      await seedTechnician(w.tenantA, w.locationA, tech);
      const appt = await newAppointment();
      const ro = await svc.checkIn(w.tenantA, appt.appointment_id, {});
      const line = await svc.addLineItem(w.tenantA, ro.ro_id, {
        line_type: 'labor',
        description: 'Backdate probe',
      });
      const ticket = await svc.dispatchTech(w.tenantA, {
        ro_id: ro.ro_id,
        line_item_id: line.line_item_id,
        tech_user_id: tech,
      });

      await svc.recordTimeEntry(w.tenantA, ticket.ticket_id, { event_type: 'start' });
      await assert.rejects(
        () =>
          svc.recordTimeEntry(w.tenantA, ticket.ticket_id, {
            event_type: 'stop',
            occurred_at: new Date(Date.now() - 86_400_000).toISOString(),
          }),
        (err: any) => err.code === 'invalid_time_sequence',
      );
    });

    test('estimate totals report money when lines carry it, and flag when they do not', async () => {
      const appt = await newAppointment();
      const ro = await svc.checkIn(w.tenantA, appt.appointment_id, {});
      const priced = await svc.addLineItem(w.tenantA, ro.ro_id, {
        line_type: 'labor',
        description: 'Brakes',
        estimated_hours: 2,
      });
      await svc.addLineItem(w.tenantA, ro.ro_id, {
        line_type: 'fee',
        description: 'Shop supplies',
      });
      await svc.updateLineItem(w.tenantA, ro.ro_id, priced.line_item_id, {
        price_ref: { amount_cents: 24_900, currency: 'USD' },
      });

      const estimate = await svc.generateEstimate(w.tenantA, ro.ro_id, {});
      assert.equal(estimate.totals_ref.amount_cents, 24_900);
      assert.equal(estimate.totals_ref.currency, 'USD');
      assert.equal(estimate.totals_ref.priced_line_count, 1);
      assert.equal(estimate.totals_ref.unpriced_line_count, 1);
    });

    // -- Standard MPI template seed ------------------------------

    test('the standard MPI template seeds once, per tenant, and is genuinely usable', async () => {
      const first = await seedStandardMPITemplate(w.tenantA.tenantId);
      const second = await seedStandardMPITemplate(w.tenantA.tenantId);
      assert.equal(first.created, true);
      assert.equal(second.created, false);
      assert.equal(
        second.template_id,
        first.template_id,
        'idempotent: same row, nothing new written',
      );

      // A different tenant gets its own template — the content is shared, the row is not.
      const other = await seedStandardMPITemplate(w.tenantB.tenantId);
      assert.equal(other.created, true);
      assert.notEqual(other.template_id, first.template_id);

      const stored = await query(
        `SELECT items, tenant_id FROM mpi_templates WHERE template_id=$1`,
        [first.template_id],
      );
      assert.equal(stored.rows[0].tenant_id, w.tenantA.tenantId);
      assert.equal(stored.rows[0].items.length, 18);
      const keys = new Set(stored.rows[0].items.map((i: any) => i.item_key));
      assert.equal(keys.size, 18, 'item keys are unique');
      for (const item of stored.rows[0].items) {
        assert.ok(
          ['info', 'maintenance', 'safety'].includes(item.default_severity),
          `${item.item_key} severity must be from the repo vocabulary`,
        );
        assert.ok(item.title_i18n.en && item.title_i18n.es, `${item.item_key} is bilingual`);
        if (item.severity_rubric) {
          assert.deepEqual(
            Object.keys(item.severity_rubric).sort(),
            ['attention', 'fail', 'pass'],
            'rubric keys use the MPI result vocabulary the API accepts',
          );
        }
      }

      // Usable end to end: start a session against it, record a failing item from the
      // template, and the submit turns it into a customer recommendation.
      const appt = await newAppointment();
      const ro = await svc.checkIn(w.tenantA, appt.appointment_id, {});
      const seededTech = randomUUID();
      await seedTechnician(w.tenantA, w.locationA, seededTech);
      const session = await svc.startMPISession(w.tenantA, ro.ro_id, {
        template_id: first.template_id,
        tech_user_id: seededTech,
      });
      const brakeItem = STANDARD_MPI_ITEMS.find((i) => i.item_key === 'brake_pads_front')!;
      await svc.recordMPIResult(w.tenantA, session.mpi_session_id, {
        item_key: brakeItem.item_key,
        status: 'fail',
        severity: brakeItem.default_severity,
      });
      await svc.submitMPISession(w.tenantA, session.mpi_session_id);

      const recs = await query(
        `SELECT priority FROM service_recommendations WHERE ro_id=$1 AND tenant_id=$2`,
        [ro.ro_id, w.tenantA.tenantId],
      );
      assert.equal(recs.rows.length, 1);
      assert.equal(recs.rows[0].priority, 'p0', 'a failed safety item becomes a p0 recommendation');
    });

    // -- Waitlist ------------------------------------------------

    async function newWaitlistEntry(overrides: Record<string, unknown> = {}) {
      return svc.createWaitlistEntry(w.tenantA, {
        location_id: w.locationA,
        mdm_customer_id: w.customer,
        mdm_vehicle_id: w.vehicle,
        requested_start: futureISO(2),
        concerns: [{ category: 'brakes', description: 'squeal at low speed' }],
        ...overrides,
      } as any);
    }

    test('a vehicle joins the waitlist once per location, and cancelling frees the spot', async () => {
      const entry = await newWaitlistEntry();
      assert.equal(entry.status, 'waiting');

      await assert.rejects(
        () => newWaitlistEntry(),
        (err: any) => err.code === 'waitlist_entry_exists' && err.statusCode === 409,
        'a second open entry for the same vehicle at the same location is refused',
      );

      // A different location is a different queue.
      const otherLocation = await newWaitlistEntry({ location_id: randomUUID() });
      assert.equal(otherLocation.status, 'waiting');

      await svc.cancelWaitlistEntry(w.tenantA, entry.waitlist_entry_id);
      const again = await newWaitlistEntry();
      assert.equal(again.status, 'waiting', 'a cancelled entry no longer blocks the vehicle');
    });

    test('the unique index is a real backstop, not just an application check', async () => {
      await newWaitlistEntry();
      // Straight to the table, skipping the service-layer check entirely.
      await assert.rejects(
        () =>
          query(
            `INSERT INTO service_waitlist_entries (waitlist_entry_id,tenant_id,location_id,mdm_customer_id,mdm_vehicle_id,requested_start,created_by_user_id)
         VALUES ($1,$2,$3,$4,$5,NOW() + INTERVAL '1 day',$6)`,
            [
              randomUUID(),
              w.tenantA.tenantId,
              w.locationA,
              w.customer,
              w.vehicle,
              w.tenantA.userId,
            ],
          ),
        (err: any) => err.code === '23505',
      );
    });

    test('converting a waitlist entry books the appointment atomically and carries the context', async () => {
      const entry = await newWaitlistEntry({
        preferred_contact_channel: 'email',
        language_preference: 'es',
      });
      await svc.offerWaitlistSlot(w.tenantA, entry.waitlist_entry_id, {});

      const start = futureISO(1);
      const outcome = await svc.convertWaitlistEntry(w.tenantA, entry.waitlist_entry_id, {
        scheduled_start: start,
      });

      assert.equal(outcome.entry.status, 'scheduled');
      assert.equal(
        outcome.entry.appointment_id,
        outcome.appointment.appointment_id,
        'the entry points at the appointment it created',
      );
      assert.equal(outcome.appointment.source, 'waitlist', 'provenance is recorded, not inferred');
      assert.equal(outcome.appointment.preferred_contact_channel, 'email');
      assert.equal(outcome.appointment.language_preference, 'es');
      assert.deepEqual(
        outcome.appointment.concerns,
        [{ category: 'brakes', description: 'squeal at low speed' }],
        'the concerns the customer gave the waitlist ride into the appointment',
      );

      const events = await query(
        `SELECT event_type FROM service_appointment_events WHERE appointment_id=$1 AND tenant_id=$2`,
        [outcome.appointment.appointment_id, w.tenantA.tenantId],
      );
      assert.ok(events.rows.some((r: any) => r.event_type === 'scheduled_from_waitlist'));

      // The appointment is real, not a shadow row: it checks in like any other.
      const ro = await svc.checkIn(w.tenantA, outcome.appointment.appointment_id, {
        odometer: 500,
      });
      assert.equal(ro.status, 'checked_in');

      // And the entry is now terminal.
      await assert.rejects(
        () =>
          svc.convertWaitlistEntry(w.tenantA, entry.waitlist_entry_id, { scheduled_start: start }),
        (err: any) => err.code === 'waitlist_entry_closed',
      );
    });

    test('an expired offer fails closed at conversion', async () => {
      const entry = await newWaitlistEntry();
      await svc.offerWaitlistSlot(w.tenantA, entry.waitlist_entry_id, {});
      // Lapse the hold from the database side — offer_expires_at is data, not clock magic.
      await query(
        `UPDATE service_waitlist_entries SET offer_expires_at = NOW() - INTERVAL '1 minute' WHERE waitlist_entry_id=$1`,
        [entry.waitlist_entry_id],
      );

      await assert.rejects(
        () =>
          svc.convertWaitlistEntry(w.tenantA, entry.waitlist_entry_id, {
            scheduled_start: futureISO(1),
          }),
        (err: any) => err.code === 'waitlist_offer_expired' && err.statusCode === 409,
      );

      const after = await query(
        `SELECT status FROM service_waitlist_entries WHERE waitlist_entry_id=$1`,
        [entry.waitlist_entry_id],
      );
      assert.equal(
        after.rows[0].status,
        'expired',
        'the refusal is also recorded: the entry is expired, not silently still offered',
      );

      const appts = await query(
        `SELECT COUNT(*)::int AS n FROM service_appointments WHERE mdm_vehicle_id=$1 AND tenant_id=$2`,
        [w.vehicle, w.tenantA.tenantId],
      );
      assert.equal(appts.rows[0].n, 0, 'no appointment was created on the refused path');
    });

    test('another tenant cannot see or move a waitlist entry', async () => {
      const entry = await newWaitlistEntry();
      await assert.rejects(
        () =>
          svc.convertWaitlistEntry(w.tenantB, entry.waitlist_entry_id, {
            scheduled_start: futureISO(1),
          }),
        (err: any) => err.code === 'waitlist_not_found' && err.statusCode === 404,
      );
      await assert.rejects(
        () => svc.cancelWaitlistEntry(w.tenantB, entry.waitlist_entry_id),
        (err: any) => err.code === 'waitlist_not_found',
      );
      const mine = await svc.listWaitlistEntries(w.tenantA, {});
      const theirs = await svc.listWaitlistEntries(w.tenantB, {});
      assert.equal(mine.length, 1);
      assert.equal(theirs.length, 0);
    });

    test('waitlist actions leave audit rows under their documented names', async () => {
      const entry = await newWaitlistEntry();
      await svc.offerWaitlistSlot(w.tenantA, entry.waitlist_entry_id, {});
      await svc.convertWaitlistEntry(w.tenantA, entry.waitlist_entry_id, {
        scheduled_start: futureISO(1),
      });

      // The documented action names (§14) are what a compliance export filters on. An
      // earlier draft passed pre-prefixed names into emitAudit, which prefixes 'service.'
      // itself — every row landed as 'service.service.waitlist.*' and the documented
      // names never appeared in the database.
      const events = await query(
        `SELECT event_type FROM audit_events WHERE tenant_id=$1 AND event_type LIKE '%waitlist%' ORDER BY created_at`,
        [w.tenantA.tenantId],
      );
      assert.deepEqual(
        events.rows.map((r: any) => r.event_type),
        ['service.waitlist.created', 'service.waitlist.offered', 'service.waitlist.converted'],
      );
    });

    test('an appointment cannot claim waitlist provenance it does not have', async () => {
      // 'waitlist' is in the source CHECK so conversion can write it, but it asserts that
      // a waitlist entry was converted — the create endpoint must refuse to take the
      // caller's word for it.
      await assert.rejects(
        () =>
          svc.createAppointment(w.tenantA, {
            location_id: w.locationA,
            mdm_customer_id: w.customer,
            mdm_vehicle_id: w.vehicle,
            scheduled_start: futureISO(),
            source: 'waitlist',
          } as any),
        (err: any) => err.statusCode === 400 && /waitlist conversion/.test(err.message),
      );
    });

    test('waitlist input is validated at the boundary', async () => {
      await assert.rejects(
        () => newWaitlistEntry({ requested_end: new Date(Date.now() + 1000).toISOString() }),
        (err: any) => err.statusCode === 400 && /requested_end/.test(err.message),
        'a window that ends before it starts is refused',
      );
      await assert.rejects(
        () => newWaitlistEntry({ priority: 'urgent' }),
        (err: any) => err.statusCode === 400,
        'priority is a closed set',
      );
      await assert.rejects(
        () => newWaitlistEntry({ concerns: 'squeaky brakes' }),
        (err: any) => err.statusCode === 400 && /concerns must be an array/.test(err.message),
      );
      const entry = await newWaitlistEntry();
      await assert.rejects(
        () =>
          svc.offerWaitlistSlot(w.tenantA, entry.waitlist_entry_id, {
            offer_expires_at: new Date(Date.now() - 1000).toISOString(),
          }),
        (err: any) => err.statusCode === 400 && /future/.test(err.message),
        'an offer that is already expired cannot be made',
      );
    });

    // -- Round five: populations, boundaries and label bounds ----

    const estimateStatus = async (estimateId: string) =>
      (await query(`SELECT status FROM ro_estimates WHERE estimate_id=$1`, [estimateId])).rows[0]
        .status;

    const stepUp = (roId: string) =>
      mintReauthGrant({
        tenantId: w.tenantA.tenantId,
        userLinkId: w.tenantA.userId,
        action: 'service.ro.transition:authorized',
        resourceId: roId,
      });

    test('a supplemental estimate is scored on its own lines, not the whole repair order', async () => {
      const appt = await newAppointment();
      const ro = await svc.checkIn(w.tenantA, appt.appointment_id, {});
      const brakes = await svc.addLineItem(w.tenantA, ro.ro_id, {
        line_type: 'labor',
        description: 'Brakes',
      });
      const wipers = await svc.addLineItem(w.tenantA, ro.ro_id, {
        line_type: 'labor',
        description: 'Wipers',
      });

      const v1 = await svc.generateEstimate(w.tenantA, ro.ro_id, {});
      await svc.sendEstimate(w.tenantA, ro.ro_id, v1.estimate_id, {});
      await svc.recordAuthorization(w.tenantA, ro.ro_id, {
        estimate_id: v1.estimate_id,
        method: 'portal',
        approved_items: [brakes.line_item_id],
        declined_items: [wipers.line_item_id],
        evidence_refs: { portal_submission_id: randomUUID() },
      });
      assert.equal(
        await estimateStatus(v1.estimate_id),
        'partially_approved',
        'one line taken, one refused',
      );

      await svc.transitionRO(w.tenantA, ro.ro_id, 'authorized', {
        step_up_token: await stepUp(ro.ro_id),
      });
      await svc.transitionRO(w.tenantA, ro.ro_id, 'in_repair', {});

      // Extra work found on the bench, quoted as a supplemental and approved outright.
      const coolant = await svc.addLineItem(w.tenantA, ro.ro_id, {
        line_type: 'labor',
        description: 'Coolant flush',
      });
      const v2 = await svc.generateEstimate(w.tenantA, ro.ro_id, {});
      await svc.sendEstimate(w.tenantA, ro.ro_id, v2.estimate_id, {});
      await svc.recordAuthorization(w.tenantA, ro.ro_id, {
        estimate_id: v2.estimate_id,
        method: 'portal',
        approved_items: [coolant.line_item_id],
        evidence_refs: { portal_submission_id: randomUUID() },
      });

      // v2 asked about one line and the customer took it. Counting the whole repair order
      // instead dragged the earlier decline into v2's score and reported partially_approved.
      assert.equal(
        await estimateStatus(v2.estimate_id),
        'approved',
        'v2 is scored on the line v2 asked about',
      );
      assert.equal(
        await estimateStatus(v1.estimate_id),
        'partially_approved',
        'and v1 is left as the customer left it',
      );
    });

    test('a line withdrawn while undecided does not hold its estimate open forever', async () => {
      const appt = await newAppointment();
      const ro = await svc.checkIn(w.tenantA, appt.appointment_id, {});
      const keep = await svc.addLineItem(w.tenantA, ro.ro_id, {
        line_type: 'labor',
        description: 'Brakes',
      });
      const drop = await svc.addLineItem(w.tenantA, ro.ro_id, {
        line_type: 'labor',
        description: 'Wipers',
      });

      const est = await svc.generateEstimate(w.tenantA, ro.ro_id, {});
      await svc.sendEstimate(w.tenantA, ro.ro_id, est.estimate_id, {});

      // Withdrawn before the customer answered: no longer outstanding, and never decided.
      await svc.updateLineItem(w.tenantA, ro.ro_id, drop.line_item_id, { status: 'canceled' });
      await svc.recordAuthorization(w.tenantA, ro.ro_id, {
        estimate_id: est.estimate_id,
        method: 'portal',
        approved_items: [keep.line_item_id],
        evidence_refs: { portal_submission_id: randomUUID() },
      });

      assert.equal(
        await estimateStatus(est.estimate_id),
        'approved',
        'every surviving line was approved, so a cancelled line must not count as still pending',
      );
    });

    test('price_ref must carry a readable amount', async () => {
      const appt = await newAppointment();
      const ro = await svc.checkIn(w.tenantA, appt.appointment_id, {});
      const line = await svc.addLineItem(w.tenantA, ro.ro_id, {
        line_type: 'labor',
        description: 'Brakes',
      });

      const rejected: unknown[] = [
        { amount_cents: 'call for price' },
        { amount_cents: -1 },
        { amount_cents: Number.NaN },
        { amount_cents: 100, currency: 7 },
        [1, 2],
      ];
      for (const bad of rejected) {
        await assert.rejects(
          () => svc.updateLineItem(w.tenantA, ro.ro_id, line.line_item_id, { price_ref: bad }),
          (err: any) => err.statusCode === 400,
          `price_ref ${JSON.stringify(bad)} must be refused at the boundary`,
        );
      }

      // The shape the rest of the system reads is still accepted, including "no charge".
      await svc.updateLineItem(w.tenantA, ro.ro_id, line.line_item_id, {
        price_ref: { amount_cents: 0, currency: 'USD' },
      });
      await svc.updateLineItem(w.tenantA, ro.ro_id, line.line_item_id, { price_ref: {} });
    });

    test('a line whose stored price cannot be read blocks handover instead of crashing the gate', async () => {
      const { ro, line, estimate } = await roAwaitingAuthorization();
      await svc.recordAuthorization(w.tenantA, ro.ro_id, {
        estimate_id: estimate.estimate_id,
        method: 'portal',
        approved_items: [line.line_item_id],
        evidence_refs: { portal_submission_id: randomUUID() },
      });
      await svc.transitionRO(w.tenantA, ro.ro_id, 'authorized', {
        step_up_token: await stepUp(ro.ro_id),
      });
      await svc.transitionRO(w.tenantA, ro.ro_id, 'in_repair', {});
      await svc.updateLineItem(w.tenantA, ro.ro_id, line.line_item_id, { status: 'completed' });

      // Written straight to the table, the way data predating the validation looks. The
      // delivery gate casts amount_cents to numeric, so free text here used to raise
      // invalid_text_representation -- and because the gate runs on every handover attempt,
      // the repair order was wedged at HTTP 500 with no route out through the API.
      await query(
        `INSERT INTO ro_line_items (line_item_id,tenant_id,ro_id,line_type,description,
         authorization_status,status,price_ref)
       VALUES ($1,$2,$3,'parts','Legacy part','not_required','completed','{"amount_cents":"call for price"}')`,
        [randomUUID(), w.tenantA.tenantId, ro.ro_id],
      );

      await svc.transitionRO(w.tenantA, ro.ro_id, 'qc', {});
      await assert.rejects(
        () => svc.transitionRO(w.tenantA, ro.ro_id, 'ready_for_pickup', {}),
        (err: any) => err.code === 'decision_outstanding' && err.statusCode === 422,
        'an unreadable price fails closed with an actionable 422, not a 500',
      );
    });

    test('creating a repair order validates the same fields check-in does', async () => {
      const base = {
        location_id: w.locationA,
        mdm_customer_id: w.customer,
        mdm_vehicle_id: w.vehicle,
      };

      await assert.rejects(
        () => svc.createRO(w.tenantA, { ...base, odometer: 12.5 }),
        (err: any) => err.statusCode === 400 && /odometer/.test(err.message),
      );
      await assert.rejects(
        () => svc.createRO(w.tenantA, { ...base, odometer: -1 }),
        (err: any) => err.statusCode === 400,
      );
      await assert.rejects(
        () => svc.createRO(w.tenantA, { ...base, promised_time: 'tomorrow afternoon' }),
        (err: any) => err.statusCode === 400 && /promised_time/.test(err.message),
      );

      const ok = await svc.createRO(w.tenantA, {
        ...base,
        odometer: 42_000,
        promised_time: futureISO(),
      });
      assert.equal(ok.odometer, 42_000);
    });

    test('concerns must be an array wherever it is written', async () => {
      await assert.rejects(
        () =>
          svc.createAppointment(w.tenantA, {
            location_id: w.locationA,
            mdm_customer_id: w.customer,
            mdm_vehicle_id: w.vehicle,
            scheduled_start: futureISO(),
            concerns: 'brakes squeal at low speed',
          }),
        (err: any) => err.statusCode === 400 && /concerns must be an array/.test(err.message),
      );

      const appt = await newAppointment();
      await assert.rejects(
        () => svc.updateAppointment(w.tenantA, appt.appointment_id, { concerns: 'still a string' }),
        (err: any) => err.statusCode === 400 && /concerns must be an array/.test(err.message),
      );

      // The column defaults to an array and every reader assumes one.
      assert.ok(Array.isArray(appt.concerns));
    });

    test('an unsupported view override is refused whatever type it arrives as', async () => {
      // A query string turns everything into a string, which is how a caller most easily
      // reaches this argument. The guard used to look for object keys without first
      // establishing that the value WAS an object, so every scalar fell through and was
      // quietly dropped -- leaving the caller believing their filter had been applied.
      const refused: unknown[] = [
        'location=store2',
        42,
        true,
        ['location'],
        { location: 'store2' },
      ];
      for (const override of refused) {
        await assert.rejects(
          () => svc.queryServiceCockpitView(w.tenantA, 'todays_queue', override),
          (err: any) => err.code === 'overrides_unsupported',
          `override ${JSON.stringify(override)} must be refused, not ignored`,
        );
      }

      // Absent, or present but empty, both mean "no overrides" and are fine.
      await svc.queryServiceCockpitView(w.tenantA, 'todays_queue');
      await svc.queryServiceCockpitView(w.tenantA, 'todays_queue', {});
    });

    test('an unrecognised queue type is published as "other" rather than as its own series', async () => {
      // The CHECK constraints on these columns were added NOT VALID so that history holding
      // free text would not block the migration, which means such rows can still be present.
      // Simulated by dropping the constraint for the length of this test.
      await query(
        `ALTER TABLE service_queue_items DROP CONSTRAINT service_queue_items_queue_type_check`,
      );
      try {
        for (const legacy of ['legacy_queue_alpha', 'legacy_queue_beta']) {
          await query(
            `INSERT INTO service_queue_items (queue_item_id,tenant_id,location_id,queue_type,status,priority)
           VALUES ($1,$2,$3,$4,'queued','p1')`,
            [randomUUID(), w.tenantA.tenantId, w.locationA, legacy],
          );
        }

        await refreshAggregatedMetrics();
        const exposition = await promClient.register.metrics();

        assert.ok(
          !/service_queue_depth\{queue_type="legacy_queue/.test(exposition),
          'free text from the database must never become a Prometheus label on an unauthenticated endpoint',
        );
        assert.ok(
          exposition.includes(
            `service_queue_depth{queue_type="other",location="${w.locationA}"} 2`,
          ),
          'and the two collapsed rows must be summed, not overwritten by whichever was written last',
        );
      } finally {
        await query(
          `ALTER TABLE service_queue_items ADD CONSTRAINT service_queue_items_queue_type_check CHECK (queue_type IN (
           'appointments_today','waiting_checkin','waiting_authorization','waiting_parts',
           'in_repair','qc','ready_pickup','comeback_review','no_show_followup')) NOT VALID`,
        );
      }
    });

    // ── FBL-020-R3 §E2: the ownership consequence ───────────────────────────
    //
    // `rolesForUserLink` is what the API middleware writes into
    // `req.tenantContext.roles`, and `hasAnyRole` reads those roles to decide
    // SUPERVISOR reach: a service advisor or manager may work on anyone's
    // inspection and anyone's work ticket, while a technician is confined to
    // their own. The roles list therefore authorizes, and it used to filter
    // `status = 'active'` with no effective-window predicate — so a technician
    // whose `service_advisor` binding had AGED OUT still passed the supervisor
    // path and could read and write ANOTHER technician's MPI session and work
    // ticket. Their engine-level allow came from their still-effective
    // `service_technician` binding, so the stale binding did the widening.
    //
    // This test drives the real composition: the roles come from the identity
    // package exactly as the middleware fetches them, and the guards are the
    // real Fixed Ops ones. No Fixed Ops behaviour changed — only the roles list
    // became correct.
    describe('a windowed-out supervisor binding stops widening technician reach', () => {
      /** The context the middleware would build for this actor, right now. */
      async function contextFor(userLinkId: string): Promise<AuthContext> {
        const roles = await rolesForUserLink(userLinkId, w.tenantA.tenantId);
        return {
          tenantId: w.tenantA.tenantId,
          userId: userLinkId,
          roles: roles as AuthContext['roles'],
        };
      }

      /** Moves a binding's window without touching its lifecycle status. */
      async function ageOut(userLinkId: string, role: string): Promise<void> {
        const moved = await query(
          `UPDATE role_bindings
              SET effective_from = NOW() - INTERVAL '2 days',
                  effective_to = NOW() - INTERVAL '1 day'
            WHERE user_link_id = $1 AND role = $2 AND status = 'active'
            RETURNING status`,
          [userLinkId, role],
        );
        assert.equal(moved.rows.length, 1, 'the fixture moved exactly one binding');
        assert.equal(
          moved.rows[0].status,
          'active',
          "the binding stays 'active' — only its window has passed, which is the shape that slipped through",
        );
      }

      test('another technician MPI session and work ticket become unreachable', async () => {
        const granter = await bootstrapAdministrator(w.tenantA.tenantId);
        const otherTech = randomUUID();
        await seedUserLinkRow(w.tenantA.tenantId, otherTech);
        await seedTechnician(w.tenantA, w.locationA, otherTech);

        // The actor: a technician who ALSO holds a service_advisor binding.
        // Both grants go through the owned mutation service, as production does.
        for (const role of [ROLES.TECHNICIAN, ROLES.SERVICE_ADVISOR]) {
          await grantRole({
            actingUserLinkId: granter,
            tenantId: w.tenantA.tenantId,
            userLinkId: w.technician.userId,
            role,
            scopeLevel: 'tenant',
            scopeId: w.tenantA.tenantId,
          });
        }

        // Work that belongs to the OTHER technician: an inspection they own and
        // a ticket assigned to them.
        const appt = await newAppointment();
        const ro = await svc.checkIn(w.tenantA, appt.appointment_id, {});
        const line = await svc.addLineItem(w.tenantA, ro.ro_id, {
          line_type: 'labor',
          description: 'Replace rear pads',
        });
        const templateId = await seedMPITemplate(w.tenantA, w.locationA);
        const session = await svc.startMPISession(w.tenantA, ro.ro_id, {
          template_id: templateId,
          tech_user_id: otherTech,
        });
        const ticket = await svc.dispatchTech(w.tenantA, {
          ro_id: ro.ro_id,
          line_item_id: line.line_item_id,
          tech_user_id: otherTech,
        });

        // CONTROL — while the service_advisor binding is inside its window the
        // supervisor path is real, and reaching another technician's work is
        // legitimate. This half proves the test is not vacuous.
        const supervising = await contextFor(w.technician.userId);
        assert.ok(
          supervising.roles.includes(ROLES.SERVICE_ADVISOR),
          'the effective binding puts service_advisor in the context',
        );
        await svc.recordMPIResult(supervising, session.mpi_session_id, {
          item_key: 'brake_pads_rear',
          status: 'pass',
        });
        await svc.recordTimeEntry(supervising, ticket.ticket_id, { event_type: 'start' });

        // THE DEFECT — the service_advisor binding ages out. It is still
        // 'active', and the technician binding is untouched and still effective,
        // so this actor keeps every legitimate permission they had.
        await ageOut(w.technician.userId, ROLES.SERVICE_ADVISOR);
        const confined = await contextFor(w.technician.userId);

        // THE SECURITY CONSEQUENCE, asserted first: ownership is enforced
        // again, so the other technician's inspection and ticket are refused —
        // and refused by the ownership guards specifically, not by some other
        // rule that happens to reject the call.
        await assert.rejects(
          () =>
            svc.recordMPIResult(confined, session.mpi_session_id, {
              item_key: 'tyres',
              status: 'pass',
            }),
          (err: unknown) => (err as { code?: string }).code === 'not_inspection_owner',
          "a technician must not record findings on another technician's inspection",
        );
        await assert.rejects(
          () => svc.recordTimeEntry(confined, ticket.ticket_id, { event_type: 'pause' }),
          (err: unknown) => (err as { code?: string }).code === 'not_ticket_assignee',
          "nor clock time against another technician's work ticket",
        );

        // …because the aged-out binding is no longer in the context at all, and
        // only that one is gone.
        assert.deepEqual(
          [...confined.roles].sort(),
          [ROLES.TECHNICIAN],
          'the aged-out binding must be gone from the context, and only that one',
        );

        // …and nothing was widened away: the technician's OWN work is still
        // theirs to do, so the fix confines rather than breaks.
        const ownSession = await svc.startMPISession(w.tenantA, ro.ro_id, {
          template_id: templateId,
          tech_user_id: w.technician.userId,
        });
        await svc.recordMPIResult(confined, ownSession.mpi_session_id, {
          item_key: 'brake_pads_front',
          status: 'pass',
        });
      });
    });
  },
);
