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
import { closePool, query, withTenantTransaction } from '@dealer/database';
import { ROLES } from '@dealer/contracts';
import { TENANT_ADMIN_ROLE } from '@dealer/identity-access';
import { captureLeadWithin, runSlaSweepPass } from '@dealer/crm';
import { createApp, resetAuthRoutesForTests, resetIdentityCompositionForTests } from '@dealer/api';

/**
 * RELEASE TRAIN 3 — THE LEAD-TO-HANDOFF JOURNEY, through the real HTTP stack
 * against a real database (acceptance rows 1, 2, 3, 5 and 6's owner journey).
 *
 * One BDC employee walks the whole owner-visible gate: a lead arrives from a
 * website form, resolves to the customer the dealership already knows, is
 * routed and answered inside the response target, gets an appointment, and is
 * handed to sales without rekeying anything. A manager then sees accurate
 * numbers and an attribution result that reports revenue as NOT_YET_AVAILABLE
 * rather than as zero.
 *
 * The refusals are asserted as hard as the successes, because a journey that
 * only proves the happy path proves the platform cannot say no.
 */
describe(
  'crm: the lead-to-handoff journey (RT3 rows 1, 2, 3, 5)',
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

    interface World {
      tenantId: string;
      rooftopId: string;
      secondRooftopId: string;
      manager: { userLinkId: string; token: string };
      agent: { userLinkId: string; token: string };
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
      const manager = await seedActor(env.issuer, {
        tenantId,
        roles: [ROLES.MARKETING_MANAGER],
      });
      const agent = await seedActor(env.issuer, { tenantId, roles: [ROLES.BDC_AGENT] });
      return {
        tenantId,
        rooftopId: rooftop.rooftopId,
        secondRooftopId: second.rooftopId,
        manager: { userLinkId: manager.userLinkId, token: manager.token },
        agent: { userLinkId: agent.userLinkId, token: agent.token },
      };
    }

    /** Every campaign and lead needs a source; the manager owns the catalog. */
    async function seedSource(w: World, code = 'website'): Promise<void> {
      const made = await call(
        w.manager.token,
        'POST',
        '/api/crm/sources',
        { source_code: code, display_name: code, channel: 'web', medium: 'organic' },
        { 'idempotency-key': randomUUID() },
      );
      assert.ok(made.status === 201 || made.status === 200, `source ${code}: ${made.status}`);
    }

    async function auditCount(tenantId: string, eventType: string): Promise<number> {
      const r = await query(
        `SELECT COUNT(*)::int AS n FROM audit_events WHERE tenant_id = $1 AND event_type = $2`,
        [tenantId, eventType],
      );
      return Number((r.rows[0] as { n: number }).n);
    }

    test('a lead arrives, is answered, booked and handed to sales without rekeying', async () => {
      const w = await seedWorld();
      await seedSource(w);
      const t = w.agent.token;

      // ── row 2: the dealership's own response target ──────────────────────
      const sla = await call(w.manager.token, 'PUT', '/api/crm/sla', {
        location_id: w.rooftopId,
        first_response_minutes: 30,
        escalate_after_minutes: 60,
      });
      assert.equal(sla.status, 200);

      // ── row 1: a website form, from somebody nobody has met ──────────────
      const first = await call(
        t,
        'POST',
        '/api/crm/leads',
        {
          location_id: w.rooftopId,
          intake_key: 'web-form-1001',
          channel: 'website',
          source_code: 'website',
          customer: {
            given_name: 'Marta',
            family_name: 'Silva',
            email: 'Marta.Silva@example.com',
            phone: '555-0142',
          },
        },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(first.status, 201, JSON.stringify(first.body));
      const leadId = String(first.body!.lead.leadId);
      assert.equal(first.body!.lead.lifecycleState, 'new');
      assert.ok(first.body!.lead.firstResponseDueAt !== null, 'the clock started');

      // THE SAME FORM, SUBMITTED TWICE. One lead, and the platform says so.
      const again = await call(
        t,
        'POST',
        '/api/crm/leads',
        {
          location_id: w.rooftopId,
          intake_key: 'web-form-1001',
          channel: 'website',
          source_code: 'website',
          customer: { given_name: 'Marta', family_name: 'Silva', email: 'Marta.Silva@example.com' },
        },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(again.status, 200);
      assert.equal(again.body!.outcome, 'merged_into_existing');
      assert.equal(again.body!.lead.leadId, leadId, 'the same lead, not a second one');

      // A DIFFERENT CAPTURE OF THE SAME PERSON AND INTEREST — a phone call
      // logged after the form — is also one lead, and the customer is the SAME
      // customer: identity is borrowed from Release Train 2, never invented.
      const byPhone = await call(
        t,
        'POST',
        '/api/crm/leads',
        {
          location_id: w.rooftopId,
          intake_key: 'phone-2002',
          channel: 'manual',
          source_code: 'website',
          customer: { given_name: 'Marta', family_name: 'Silva', email: 'marta.silva@example.com' },
        },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(byPhone.status, 200);
      assert.equal(byPhone.body!.lead.leadId, leadId);

      const customers = await query(
        `SELECT COUNT(*)::int AS n FROM parties WHERE tenant_id = $1 AND status = 'active'`,
        [w.tenantId],
      );
      assert.equal(
        Number((customers.rows[0] as { n: number }).n),
        1,
        'three captures, one customer record',
      );

      // ── row 2: routing ───────────────────────────────────────────────────
      const assigned = await call(t, 'POST', `/api/crm/leads/${leadId}/assignment`, {
        expected_version: first.body!.lead.authorizationVersion,
        to_user_link_id: w.agent.userLinkId,
        reason: 'initial_routing',
      });
      assert.equal(assigned.status, 200, JSON.stringify(assigned.body));
      assert.equal(assigned.body!.lead.ownerUserLinkId, w.agent.userLinkId);
      assert.equal(assigned.body!.lead.lifecycleState, 'working', 'routing starts the work');

      // ── row 3: the timeline, and the clock stopping ──────────────────────
      const note = await call(
        t,
        'POST',
        `/api/crm/leads/${leadId}/activities`,
        { kind: 'note', subject: 'Interested in a hatchback' },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(note.status, 201);
      assert.equal(note.body!.lead.firstResponseAt, null, 'a note is not a response');

      const called = await call(
        t,
        'POST',
        `/api/crm/leads/${leadId}/activities`,
        { kind: 'call', direction: 'outbound', subject: 'Called back, arranging a visit' },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(called.status, 201);
      assert.ok(called.body!.lead.firstResponseAt !== null, 'an outbound call IS the response');
      const respondedAt = String(called.body!.lead.firstResponseAt);

      // …and answering again does not move the stamp.
      const calledAgain = await call(
        t,
        'POST',
        `/api/crm/leads/${leadId}/activities`,
        { kind: 'email', direction: 'outbound', subject: 'Confirming' },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(calledAgain.body!.lead.firstResponseAt, respondedAt, 'the FIRST response');

      // ── row 3: the appointment ───────────────────────────────────────────
      const starts = new Date(Date.now() + 86_400_000).toISOString();
      const ends = new Date(Date.now() + 90_000_000).toISOString();
      const booked = await call(
        t,
        'POST',
        `/api/crm/leads/${leadId}/appointments`,
        { purpose: 'test_drive', starts_at: starts, ends_at: ends },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(booked.status, 201, JSON.stringify(booked.body));
      const appointmentId = String(booked.body!.appointment.appointmentId);
      assert.equal(
        booked.body!.lead.lifecycleState,
        'appointment_set',
        'booking IS what that state means',
      );

      const moved = await call(t, 'POST', `/api/crm/appointments/${appointmentId}/reschedule`, {
        expected_version: booked.body!.appointment.authorizationVersion,
        starts_at: new Date(Date.now() + 172_800_000).toISOString(),
        ends_at: new Date(Date.now() + 176_400_000).toISOString(),
      });
      assert.equal(moved.status, 200, JSON.stringify(moved.body));
      assert.equal(moved.body!.appointment.rescheduleCount, 1, 'the move is counted from history');

      const confirmed = await call(t, 'POST', `/api/crm/appointments/${appointmentId}/state`, {
        expected_version: moved.body!.appointment.authorizationVersion,
        state: 'confirmed',
      });
      assert.equal(confirmed.status, 200);

      // ── row 2: qualification and the seam ────────────────────────────────
      const detail = await call(t, 'GET', `/api/crm/leads/${leadId}`);
      assert.equal(detail.status, 200);
      const qualified = await call(t, 'POST', `/api/crm/leads/${leadId}/transition`, {
        expected_version: detail.body!.lead.authorizationVersion,
        to_state: 'qualified',
      });
      assert.equal(qualified.status, 200, JSON.stringify(qualified.body));

      const handed = await call(t, 'POST', `/api/crm/leads/${leadId}/handoff`, {
        expected_version: qualified.body!.lead.authorizationVersion,
        handed_to_user_link_id: w.manager.userLinkId,
      });
      assert.equal(handed.status, 201, JSON.stringify(handed.body));
      assert.equal(handed.body!.lead.lifecycleState, 'handed_off');
      assert.equal(handed.body!.lead.disposition, 'handed_to_sales');

      // THE SEAM HOLDS. A handed-off lead is not the CRM's to move any more.
      const afterHandoff = await call(t, 'POST', `/api/crm/leads/${leadId}/assignment`, {
        expected_version: handed.body!.lead.authorizationVersion,
        to_user_link_id: w.manager.userLinkId,
        reason: 'reassignment',
      });
      assert.equal(afterHandoff.status, 422, 'the CRM stops at the handoff');

      // …and handing off twice converges rather than duplicating.
      const twice = await call(t, 'POST', `/api/crm/leads/${leadId}/handoff`, {
        expected_version: handed.body!.lead.authorizationVersion,
        handed_to_user_link_id: w.manager.userLinkId,
      });
      assert.equal(twice.status, 200);
      assert.equal(twice.body!.outcome, 'already_handed_off');

      // The snapshot is frozen, and it is what sales will read.
      const snapshot = await query(
        `SELECT handed_snapshot FROM lead_handoffs WHERE tenant_id = $1 AND lead_id = $2`,
        [w.tenantId, leadId],
      );
      assert.equal(snapshot.rows.length, 1);
      const frozen = (snapshot.rows[0] as { handed_snapshot: Record<string, unknown> })
        .handed_snapshot;
      assert.equal(frozen.lead_id, leadId);
      assert.ok(frozen.first_response_at !== null, 'the handoff carries how fast we answered');

      // ── the timeline is one story, in order ──────────────────────────────
      const finalDetail = await call(t, 'GET', `/api/crm/leads/${leadId}`);
      const timeline = finalDetail.body!.timeline as Array<{ kind: string; at: string }>;
      assert.ok(timeline.length >= 8, `the timeline carries the whole story: ${timeline.length}`);
      const kinds = timeline.map((e) => e.kind);
      assert.ok(kinds.includes('touch'), 'the source touches are on it');
      assert.ok(kinds.includes('activity.call'), 'so are the calls');
      assert.ok(kinds.includes('appointment.rescheduled'), 'and the appointment history');
      assert.ok(kinds.includes('status'), 'and every lifecycle move');
      const times = timeline.map((e) => Date.parse(e.at));
      assert.deepEqual(
        [...times].sort((a, b) => a - b),
        times,
        'ordered once, in SQL',
      );

      // ── attribution is attributed, and honest about revenue ──────────────
      const run = await call(w.manager.token, 'POST', '/api/crm/attribution', {
        location_id: w.rooftopId,
        model: 'linear',
        window_start: new Date(Date.now() - 86_400_000).toISOString(),
        window_end: new Date(Date.now() + 86_400_000).toISOString(),
      });
      assert.equal(run.status, 201, JSON.stringify(run.body));
      assert.equal(run.body!.run.leadsConsidered, 1);
      assert.equal(run.body!.run.revenueStatus, 'NOT_YET_AVAILABLE');
      assert.equal(run.body!.run.attributedRevenueCents, null, 'no amount beside the status');

      const report = await call(
        w.manager.token,
        'GET',
        `/api/crm/attribution?model=linear&location_id=${w.rooftopId}`,
      );
      assert.equal(report.status, 200);
      assert.equal(report.body!.revenueStatus, 'NOT_YET_AVAILABLE');
      assert.equal(report.body!.roiStatus, 'NOT_YET_AVAILABLE');
      const credited = report.body!.bySource as Array<{ sourceCode: string; weightBp: number }>;
      assert.equal(credited.length, 1);
      assert.equal(credited[0]!.sourceCode, 'website');
      assert.equal(credited[0]!.weightBp, 10000, 'the whole credit, split across the touches');

      // ── row 6: the manager's numbers ─────────────────────────────────────
      const overview = await call(w.manager.token, 'GET', '/api/crm/overview');
      assert.equal(overview.status, 200);
      assert.equal(overview.body!.leads.handedOff, 1);
      assert.equal(overview.body!.leads.open, 0);
      assert.equal(overview.body!.appointments.upcoming, 1);
      assert.equal(overview.body!.sla.breached, 0, 'answered inside the target');
      assert.ok(overview.body!.sla.medianFirstResponseMinutes !== null);
      assert.equal(overview.body!.revenueStatus, 'NOT_YET_AVAILABLE');

      // ── every step is attributed ─────────────────────────────────────────
      assert.equal(await auditCount(w.tenantId, 'crm.lead.captured'), 1);
      assert.equal(await auditCount(w.tenantId, 'crm.lead.handed_off'), 1);
      assert.ok((await auditCount(w.tenantId, 'crm.activity.logged')) >= 3);
    });

    test('two intakes of one interest race, and produce one lead', async () => {
      const w = await seedWorld();
      await seedSource(w);

      // A customer the dealership already knows, so both captures resolve to
      // the same person and collide on the same interest.
      const seeded = await call(
        w.agent.token,
        'POST',
        '/api/crm/leads',
        {
          location_id: w.rooftopId,
          intake_key: 'seed',
          channel: 'manual',
          source_code: 'website',
          customer: { given_name: 'Ravi', family_name: 'Patel', email: 'ravi@example.com' },
        },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(seeded.status, 201);
      const partyId = String(
        (
          (await query(`SELECT party_id FROM parties WHERE tenant_id = $1 LIMIT 1`, [w.tenantId]))
            .rows[0] as { party_id: string }
        ).party_id,
      );
      // Close it, so the next two captures are genuinely creating a new lead.
      const closed = await call(
        w.agent.token,
        'POST',
        `/api/crm/leads/${seeded.body!.lead.leadId}/transition`,
        {
          expected_version: seeded.body!.lead.authorizationVersion,
          to_state: 'closed',
          disposition: 'not_interested',
        },
      );
      assert.equal(closed.status, 200);

      // TWO TRANSACTIONS THAT GENUINELY OVERLAP. Firing two HTTP requests with
      // Promise.all does not reliably overlap the window between deciding and
      // writing, so the first transaction is held OPEN across the second's
      // entire decision — the interleaving that produces two leads.
      let hasWritten!: () => void;
      const written = new Promise<void>((resolve) => (hasWritten = resolve));
      let commitNow!: () => void;
      const held = new Promise<void>((resolve) => (commitNow = resolve));

      const mk = (key: string) => ({
        actingUserLinkId: w.agent.userLinkId,
        tenantId: w.tenantId,
        rooftopId: w.rooftopId,
        intakeKey: key,
        channel: 'website' as const,
        sourceCode: 'website',
        partyId,
      });

      const first = withTenantTransaction(w.tenantId, async (tx) => {
        const r = await captureLeadWithin(tx, mk('race-a'));
        hasWritten();
        await held;
        return r;
      });
      await written;
      const second = withTenantTransaction(w.tenantId, (tx) => captureLeadWithin(tx, mk('race-b')));

      // The assertion, not the setup: an ungranted advisory lock is the
      // database saying the competing capture is waiting its turn. Releasing
      // the first on a timer would let this pass against a build that never
      // serialized anything.
      let queued = false;
      for (let i = 0; i < 200 && !queued; i += 1) {
        const waiting = await query(
          `SELECT COUNT(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`,
        );
        queued = Number((waiting.rows[0] as { n: number }).n) > 0;
        if (!queued) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.ok(queued, 'the second capture queued behind the first rather than racing it');

      commitNow();
      const [a, b] = await Promise.all([first, second]);
      const outcomes = [a.outcome, b.outcome].sort();
      assert.deepEqual(outcomes, ['created', 'merged_into_existing'], 'one lead, not two');
      assert.equal(
        (a as { lead: { leadId: string } }).lead.leadId,
        (b as { lead: { leadId: string } }).lead.leadId,
        'and both captures name it',
      );

      const open = await query(
        `SELECT COUNT(*)::int AS n FROM leads
          WHERE tenant_id = $1 AND lifecycle_state NOT IN ('handed_off','closed')`,
        [w.tenantId],
      );
      assert.equal(Number((open.rows[0] as { n: number }).n), 1, 'one open lead, not two');

      // Both captures are in the intake ledger, including the one that joined.
      const intakes = await query(
        `SELECT outcome FROM lead_intakes WHERE tenant_id = $1 ORDER BY intake_key`,
        [w.tenantId],
      );
      assert.deepEqual(
        (intakes.rows as Array<{ outcome: string }>).map((r) => r.outcome).sort(),
        ['created', 'created', 'merged_into_existing'],
        'every capture attempt is recorded, not only the ones that made a lead',
      );
    });

    test('an unanswered lead is escalated once, however often the sweep runs', async () => {
      const w = await seedWorld();
      await seedSource(w);
      await call(w.manager.token, 'PUT', '/api/crm/sla', {
        location_id: w.rooftopId,
        first_response_minutes: 30,
        escalate_after_minutes: 60,
      });
      const lead = await call(
        w.agent.token,
        'POST',
        '/api/crm/leads',
        {
          location_id: w.rooftopId,
          intake_key: 'slow-1',
          channel: 'website',
          source_code: 'website',
          customer: { given_name: 'Ana', family_name: 'Costa', email: 'ana@example.com' },
        },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(lead.status, 201);
      const leadId = String(lead.body!.lead.leadId);

      // Nothing is due yet.
      assert.equal((await runSlaSweepPass()).escalated, 0, 'a fresh lead is not late');

      // A MISSED RESPONSE TARGET IS NOT YET AN ESCALATION (RT3-C1 §3).
      //
      // The dealership asked for two different things: answer within thirty
      // minutes, tell a manager after sixty. Aging only the response target
      // makes the lead BREACHED — the promise to the customer is broken and the
      // pipeline says so — while the manager is not yet involved. A sweep that
      // fired here would make `escalate_after_minutes` a settings field nothing
      // reads.
      await fixtureAuthorizationStateWrite(
        'simulate-authorization-drift',
        `UPDATE leads SET first_response_due_at = NOW() - INTERVAL '5 minutes'
          WHERE tenant_id = $1 AND lead_id = $2`,
        [w.tenantId, leadId],
      );
      const breachedOnly = await runSlaSweepPass();
      assert.equal(breachedOnly.escalated, 0, 'the response target is not the escalation clock');
      const breachedView = await call(w.manager.token, 'GET', '/api/crm/overview');
      assert.equal(breachedView.body!.sla.breached, 1, 'CONTROL: it IS breached');
      assert.equal(breachedView.body!.sla.escalated, 0, 'and nobody has been told yet');

      // …and when the ESCALATION deadline passes, the manager is told, once.
      await fixtureAuthorizationStateWrite(
        'simulate-authorization-drift',
        `UPDATE leads SET escalate_at = NOW() - INTERVAL '5 minutes'
          WHERE tenant_id = $1 AND lead_id = $2`,
        [w.tenantId, leadId],
      );

      const firstSweep = await runSlaSweepPass();
      assert.equal(firstSweep.escalated, 1);
      const secondSweep = await runSlaSweepPass();
      assert.equal(secondSweep.escalated, 0, 'the second sweep raises nothing');

      const raised = await query(
        `SELECT COUNT(*)::int AS n FROM lead_escalations WHERE tenant_id = $1 AND lead_id = $2`,
        [w.tenantId, leadId],
      );
      assert.equal(Number((raised.rows[0] as { n: number }).n), 1, 'one alarm, not two');

      const overview = await call(w.manager.token, 'GET', '/api/crm/overview');
      assert.equal(overview.body!.sla.breached, 1);
      assert.equal(overview.body!.sla.escalated, 1);

      // Escalation does not move the funnel: it is a fact about the clock.
      const after = await call(w.agent.token, 'GET', `/api/crm/leads/${leadId}`);
      assert.equal(after.body!.lead.lifecycleState, 'new');
    });

    test('the lifecycle machine refuses what it does not allow, and says so', async () => {
      const w = await seedWorld();
      await seedSource(w);
      const lead = await call(
        w.agent.token,
        'POST',
        '/api/crm/leads',
        {
          location_id: w.rooftopId,
          intake_key: 'machine-1',
          channel: 'manual',
          source_code: 'website',
          customer: { given_name: 'Tom', family_name: 'Wu', phone: '5550188' },
        },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(lead.status, 201);
      const leadId = String(lead.body!.lead.leadId);
      const v0 = Number(lead.body!.lead.authorizationVersion);

      // `new` does not jump to `qualified`.
      const jump = await call(w.agent.token, 'POST', `/api/crm/leads/${leadId}/transition`, {
        expected_version: v0,
        to_state: 'qualified',
      });
      assert.equal(jump.status, 422);
      assert.match(String(jump.body!.detail), /may move to/);

      // A handoff is not a state you set.
      const sneak = await call(w.agent.token, 'POST', `/api/crm/leads/${leadId}/transition`, {
        expected_version: v0,
        to_state: 'handed_off',
      });
      assert.equal(sneak.status, 422);

      // Closing states why.
      const silent = await call(w.agent.token, 'POST', `/api/crm/leads/${leadId}/transition`, {
        expected_version: v0,
        to_state: 'closed',
      });
      assert.equal(silent.status, 422);

      const closed = await call(w.agent.token, 'POST', `/api/crm/leads/${leadId}/transition`, {
        expected_version: v0,
        to_state: 'closed',
        disposition: 'no_contact',
      });
      assert.equal(closed.status, 200);

      // A stale version changes nothing.
      const stale = await call(w.agent.token, 'POST', `/api/crm/leads/${leadId}/transition`, {
        expected_version: v0,
        to_state: 'working',
      });
      assert.equal(stale.status, 409);
    });

    test('the unauthenticated and the wrong-role are refused as problems', async () => {
      const w = await seedWorld();
      const anon = await call(null, 'GET', '/api/crm/overview');
      assert.equal(anon.status, 401);
      assert.match(anon.contentType, /application\/problem\+json/);

      // A service advisor holds no CRM authority at all.
      const advisor = await seedActor(env.issuer, {
        tenantId: w.tenantId,
        roles: [ROLES.SERVICE_ADVISOR],
      });
      const denied = await call(advisor.token, 'GET', '/api/crm/overview');
      assert.equal(denied.status, 403);

      // A BDC agent works leads but does not decide who is contacted.
      const agentSource = await call(
        w.agent.token,
        'POST',
        '/api/crm/sources',
        { source_code: 'walkin', display_name: 'Walk in', channel: 'walk_in', medium: 'direct' },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(agentSource.status, 403, 'the catalog is the manager’s');

      const admin = await seedActor(env.issuer, {
        tenantId: w.tenantId,
        roles: [TENANT_ADMIN_ROLE],
      });
      const allowed = await call(admin.token, 'GET', '/api/crm/overview');
      assert.equal(allowed.status, 200);

      const nowhere = await call(admin.token, 'GET', '/api/crm/does-not-exist');
      assert.equal(nowhere.status, 404);
      assert.equal(nowhere.body!.code, 'route_not_found');
    });
  },
);
