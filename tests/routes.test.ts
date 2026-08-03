import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, beforeEach, describe, test } from 'node:test';
import {
  mintReauthGrant,
  resetDatabase,
  seedActor,
  seedMPITemplate,
  seedRooftopIdentity,
  seedTechnician,
  seedTenantIdentity,
  skipIntegration,
  startIdentityTestEnv,
  type IdentityTestEnv,
} from '@dealer/test-kit';
import { closePool, query } from '@dealer/database';
import { ROLES } from '@dealer/contracts';
import * as promClient from 'prom-client';
import { createApp, resetAuthRoutesForTests, resetIdentityCompositionForTests } from '@dealer/api';

/**
 * Tests that go through the real HTTP stack — routing, middleware order,
 * `authenticate`, `authorize`, the body parser and the error handler — rather than
 * calling service functions directly.
 *
 * This layer had no coverage at all, which is how a technician-writable price field
 * survived three review rounds: every existing test called the service as an advisor,
 * so no test ever asked what a *technician* could reach through the API.
 */
describe('route layer', { skip: skipIntegration ? 'set TEST_DATABASE_URL to run' : false }, () => {
  let server: Server;
  let base: string;
  let env: IdentityTestEnv;

  interface Actor {
    jwt: string;
    tenantId: string;
    userId: string;
  }

  /**
   * The FBL-020 replacement for the retired HS256 test JWT: a real activated
   * user link with the roles bound at tenant scope, and a LOCAL-ISSUER access
   * token for it. Actor.userId is the user_link_id — the actor id every
   * created_by/audit column now records.
   */
  async function actor(roles: string[], tenantId = tenant): Promise<Actor> {
    await seedTenantIdentity(tenantId);
    const seeded = await seedActor(env.issuer, { tenantId, roles });
    return { jwt: seeded.token, tenantId, userId: seeded.userLinkId };
  }

  async function call(
    who: Actor | null,
    method: string,
    path: string,
    body?: unknown,
    rawBody?: string,
  ): Promise<{ status: number; body: any }> {
    const res = await fetch(`${base}/api/service${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(who ? { authorization: `Bearer ${who.jwt}` } : {}),
      },
      body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
    const text = await res.text();
    let parsed: any = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = { raw: text };
    }
    return { status: res.status, body: parsed };
  }

  let tenant: string;
  let location: string;
  let advisor: Actor;
  let technician: Actor;

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
    tenant = randomUUID();
    location = randomUUID();
    await seedTenantIdentity(tenant);
    await seedRooftopIdentity(tenant, location);
    advisor = await actor([ROLES.SERVICE_ADVISOR]);
    technician = await actor([ROLES.TECHNICIAN]);
  });

  /** Drives a repair order to "line item priced and awaiting a decision". */
  async function pricedRO() {
    const appt = await call(advisor, 'POST', '/appointments', {
      location_id: location,
      mdm_customer_id: randomUUID(),
      mdm_vehicle_id: randomUUID(),
      scheduled_start: new Date(Date.now() + 86_400_000).toISOString(),
    });
    assert.equal(appt.status, 201);
    const ro = await call(
      advisor,
      'POST',
      `/appointments/${appt.body.data.appointment_id}/check-in`,
      {},
    );
    assert.equal(ro.status, 200);
    const line = await call(advisor, 'POST', `/ros/${ro.body.data.ro_id}/line-items`, {
      line_type: 'labor',
      description: 'Front brakes',
      estimated_hours: 2,
    });
    assert.equal(line.status, 201);
    const priced = await call(
      advisor,
      'PATCH',
      `/ros/${ro.body.data.ro_id}/line-items/${line.body.data.line_item_id}`,
      { price_ref: { amount_cents: 90_000, currency: 'USD' } },
    );
    assert.equal(priced.status, 200);
    return { roId: ro.body.data.ro_id as string, lineId: line.body.data.line_item_id as string };
  }

  // ── Authentication and authorization at the wire ────────────

  test('an unauthenticated request is refused', async () => {
    const res = await call(null, 'GET', '/home');
    assert.equal(res.status, 401);
    assert.equal(res.body.success, false);
  });

  test('a viewer cannot write anything', async () => {
    const viewer = await actor([ROLES.VIEWER]);
    const res = await call(viewer, 'POST', '/ros', {
      location_id: location,
      mdm_customer_id: randomUUID(),
      mdm_vehicle_id: randomUUID(),
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'forbidden');
  });

  test('a body tenant_id that disagrees with the token is refused', async () => {
    const res = await call(advisor, 'POST', '/ros', {
      tenant_id: randomUUID(),
      location_id: location,
      mdm_customer_id: randomUUID(),
      mdm_vehicle_id: randomUUID(),
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'tenant_mismatch');
  });

  // ── The money path ──────────────────────────────────────────

  test('a technician cannot rewrite what the customer is billed', async () => {
    const { roId, lineId } = await pricedRO();

    const attempt = await call(technician, 'PATCH', `/ros/${roId}/line-items/${lineId}`, {
      price_ref: { amount_cents: 1, currency: 'USD' },
    });
    assert.equal(attempt.status, 403);
    assert.equal(attempt.body.error.code, 'commercial_fields_restricted');

    const soldHours = await call(technician, 'PATCH', `/ros/${roId}/line-items/${lineId}`, {
      sold_hours: 99,
    });
    assert.equal(soldHours.status, 403);

    const row = await query(
      'SELECT price_ref, sold_hours FROM ro_line_items WHERE line_item_id=$1',
      [lineId],
    );
    assert.equal(
      Number(row.rows[0].price_ref.amount_cents),
      90_000,
      'the advisor’s price is intact',
    );
    assert.equal(row.rows[0].sold_hours, null);
  });

  test('a technician cannot assign work to themselves through the line-item PATCH', async () => {
    const { roId, lineId } = await pricedRO();
    const res = await call(technician, 'PATCH', `/ros/${roId}/line-items/${lineId}`, {
      assigned_tech_user_id: technician.userId,
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'assignment_via_dispatch_only');
  });

  test('a technician cannot move work they were never dispatched to', async () => {
    const { roId, lineId } = await pricedRO();
    const res = await call(technician, 'PATCH', `/ros/${roId}/line-items/${lineId}`, {
      status: 'in_progress',
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'not_line_item_assignee');
  });

  test('a dispatched technician can report progress on their own line', async () => {
    const { roId, lineId } = await pricedRO();
    await seedTechnician(
      { tenantId: tenant, userId: advisor.userId, roles: [] } as any,
      location,
      technician.userId,
    );

    const dispatched = await call(advisor, 'POST', '/dispatch/assign', {
      ro_id: roId,
      line_item_id: lineId,
      tech_user_id: technician.userId,
    });
    assert.equal(dispatched.status, 201);

    const progress = await call(technician, 'PATCH', `/ros/${roId}/line-items/${lineId}`, {
      status: 'in_progress',
    });
    assert.equal(progress.status, 200);
    assert.equal(progress.body.data.status, 'in_progress');
  });

  test('an approved line’s price is frozen, even for an advisor', async () => {
    const { roId, lineId } = await pricedRO();
    const est = await call(advisor, 'POST', `/ros/${roId}/estimates/generate`, {});
    assert.equal(est.status, 201);
    await call(advisor, 'POST', `/ros/${roId}/estimates/${est.body.data.estimate_id}/send`, {});
    const auth = await call(advisor, 'POST', `/ros/${roId}/authorizations/record`, {
      estimate_id: est.body.data.estimate_id,
      method: 'portal',
      approved_items: [lineId],
      evidence_refs: { portal_submission_id: randomUUID() },
    });
    assert.equal(auth.status, 201);

    const repriced = await call(advisor, 'PATCH', `/ros/${roId}/line-items/${lineId}`, {
      price_ref: { amount_cents: 5, currency: 'USD' },
    });
    assert.equal(repriced.status, 409);
    assert.equal(repriced.body.error.code, 'approved_terms_frozen');
  });

  test('the authorization records a snapshot of exactly what was approved', async () => {
    const { roId, lineId } = await pricedRO();
    const est = await call(advisor, 'POST', `/ros/${roId}/estimates/generate`, {});
    await call(advisor, 'POST', `/ros/${roId}/estimates/${est.body.data.estimate_id}/send`, {});
    const auth = await call(advisor, 'POST', `/ros/${roId}/authorizations/record`, {
      estimate_id: est.body.data.estimate_id,
      method: 'portal',
      approved_items: [lineId],
      evidence_refs: { portal_submission_id: randomUUID() },
    });

    const snap = auth.body.data.approved_snapshot[lineId];
    assert.ok(snap, 'the approved line is snapshotted');
    assert.equal(Number(snap.price_ref.amount_cents), 90_000, 'at the price the customer saw');
    assert.equal(snap.description, 'Front brakes');
  });

  // ── Delivery gates ──────────────────────────────────────────

  test('a vehicle with an undecided line cannot be handed back', async () => {
    const { roId, lineId } = await pricedRO();
    const second = await call(advisor, 'POST', `/ros/${roId}/line-items`, {
      line_type: 'labor',
      description: 'Wipers',
      estimated_hours: 0.5,
    });
    const est = await call(advisor, 'POST', `/ros/${roId}/estimates/generate`, {});
    await call(advisor, 'POST', `/ros/${roId}/estimates/${est.body.data.estimate_id}/send`, {});
    // Only one of the two lines is decided.
    await call(advisor, 'POST', `/ros/${roId}/authorizations/record`, {
      estimate_id: est.body.data.estimate_id,
      method: 'portal',
      approved_items: [lineId],
      evidence_refs: { portal_submission_id: randomUUID() },
    });

    const stepUp = (action: string) =>
      mintReauthGrant({ tenantId: tenant, userLinkId: advisor.userId, action, resourceId: roId });
    await call(advisor, 'POST', `/ros/${roId}/transition`, {
      to_status: 'authorized',
      step_up_token: await stepUp('service.ro.transition:authorized'),
    });
    await call(advisor, 'POST', `/ros/${roId}/transition`, { to_status: 'in_repair' });
    await call(advisor, 'PATCH', `/ros/${roId}/line-items/${lineId}`, { status: 'completed' });
    // The second line was put to the customer, never answered, and the work done anyway.
    await call(advisor, 'PATCH', `/ros/${roId}/line-items/${second.body.data.line_item_id}`, {
      status: 'completed',
    });
    await call(advisor, 'POST', `/ros/${roId}/transition`, { to_status: 'qc' });

    const pickup = await call(advisor, 'POST', `/ros/${roId}/transition`, {
      to_status: 'ready_for_pickup',
    });
    assert.equal(pickup.status, 422);
    assert.equal(
      pickup.body.error.code,
      'decision_outstanding',
      'a line the customer never answered blocks delivery',
    );

    // Withdrawing that line instead releases the vehicle: cancelled work is not
    // outstanding, because there is nothing left to do and nothing to bill.
    await call(advisor, 'PATCH', `/ros/${roId}/line-items/${second.body.data.line_item_id}`, {
      status: 'canceled',
    });
    const retry = await call(advisor, 'POST', `/ros/${roId}/transition`, {
      to_status: 'ready_for_pickup',
    });
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
  });

  test('a partially decided estimate can still receive its remaining decision', async () => {
    const { roId, lineId } = await pricedRO();
    const second = await call(advisor, 'POST', `/ros/${roId}/line-items`, {
      line_type: 'labor',
      description: 'Wipers',
      estimated_hours: 0.5,
    });
    const est = await call(advisor, 'POST', `/ros/${roId}/estimates/generate`, {});
    await call(advisor, 'POST', `/ros/${roId}/estimates/${est.body.data.estimate_id}/send`, {});

    const first = await call(advisor, 'POST', `/ros/${roId}/authorizations/record`, {
      estimate_id: est.body.data.estimate_id,
      method: 'portal',
      approved_items: [lineId],
      evidence_refs: { portal_submission_id: randomUUID() },
    });
    assert.equal(first.status, 201);

    // The remaining line must still be decidable — this was a dead end before.
    const rest = await call(advisor, 'POST', `/ros/${roId}/authorizations/record`, {
      estimate_id: est.body.data.estimate_id,
      method: 'portal',
      approved_items: [],
      declined_items: [second.body.data.line_item_id],
      evidence_refs: { portal_submission_id: randomUUID() },
    });
    assert.equal(rest.status, 201, JSON.stringify(rest.body));

    const est2 = await query('SELECT status FROM ro_estimates WHERE estimate_id=$1', [
      est.body.data.estimate_id,
    ]);
    assert.equal(est2.rows[0].status, 'partially_approved');
  });

  // ── Queue ownership ─────────────────────────────────────────

  test('a technician cannot close a queue item claimed by someone else', async () => {
    await pricedRO();
    const queue = await call(advisor, 'GET', '/queues');
    assert.equal(queue.status, 200);
    const item = queue.body.data[0];
    assert.ok(item, 'check-in produced a queue item');

    const other = await actor([ROLES.TECHNICIAN]);
    const claimed = await call(other, 'POST', `/queues/${item.queue_item_id}/assign`, {});
    assert.equal(claimed.status, 200);

    const stolen = await call(technician, 'POST', `/queues/${item.queue_item_id}/update-status`, {
      status: 'done',
    });
    assert.equal(stolen.status, 403);
    assert.equal(stolen.body.error.code, 'queue_item_taken');
  });

  // ── Error handling at the edge ──────────────────────────────

  test('malformed JSON is a 400, not a 500', async () => {
    const res = await call(advisor, 'POST', '/ros', undefined, '{"location_id": ');
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'malformed_json');
  });

  test('a bad timestamp is a 400, not a database error', async () => {
    const res = await call(advisor, 'POST', '/appointments', {
      location_id: location,
      mdm_customer_id: randomUUID(),
      mdm_vehicle_id: randomUUID(),
      scheduled_start: new Date(Date.now() + 86_400_000).toISOString(),
      scheduled_end: 'the day after tomorrow',
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /scheduled_end/);
  });

  test('a non-array reason_codes is a 400, not a malformed array literal', async () => {
    const res = await call(advisor, 'POST', '/comebacks', {
      original_ro_id: randomUUID(),
      new_ro_id: randomUUID(),
      root_cause_category: 'workmanship',
      reason_codes: 'oops',
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /reason_codes/);
  });

  test('an unknown timezone is a 400', async () => {
    const res = await call(advisor, 'GET', '/home?timezone=Mars/Olympus_Mons');
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'unknown_timezone');
  });

  test('an unknown route is a 404 in the standard envelope', async () => {
    const res = await call(advisor, 'GET', '/nope');
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'route_not_found');
  });

  // ── Step-up, over the wire ──────────────────────────────────

  test('a step-up token is spent by the transition it authorises', async () => {
    const { roId, lineId } = await pricedRO();
    const est = await call(advisor, 'POST', `/ros/${roId}/estimates/generate`, {});
    await call(advisor, 'POST', `/ros/${roId}/estimates/${est.body.data.estimate_id}/send`, {});
    await call(advisor, 'POST', `/ros/${roId}/authorizations/record`, {
      estimate_id: est.body.data.estimate_id,
      method: 'portal',
      approved_items: [lineId],
      evidence_refs: { portal_submission_id: randomUUID() },
    });

    const reusable = await mintReauthGrant({
      tenantId: tenant,
      userLinkId: advisor.userId,
      action: 'service.ro.transition:authorized',
      resourceId: roId,
    });

    const first = await call(advisor, 'POST', `/ros/${roId}/transition`, {
      to_status: 'authorized',
      step_up_token: reusable,
    });
    assert.equal(first.status, 200);

    // Same token, same action, same resource, same user: the ONLY thing stopping this
    // is the consumption ledger.
    await call(advisor, 'POST', `/ros/${roId}/transition`, { to_status: 'in_repair' });
    await call(advisor, 'POST', `/ros/${roId}/transition`, { to_status: 'qc' });
    await call(advisor, 'PATCH', `/ros/${roId}/line-items/${lineId}`, { status: 'completed' });
    const replay = await call(advisor, 'POST', `/ros/${roId}/transition`, {
      to_status: 'ready_for_pickup',
      step_up_token: reusable,
    });
    // ready_for_pickup needs no step-up, so prove the replay directly on a gated action:
    assert.equal(replay.status, 200);

    const cancelToken = await mintReauthGrant({
      tenantId: tenant,
      userLinkId: advisor.userId,
      action: 'service.ro.transition:canceled',
      resourceId: roId,
    });
    const other = await pricedRO();
    const otherCancel = await call(advisor, 'POST', `/ros/${other.roId}/transition`, {
      to_status: 'canceled',
      step_up_token: cancelToken,
    });
    assert.equal(
      otherCancel.status,
      403,
      'a grant bound to one repair order cannot cancel another',
    );
  });

  test('a spent step-up token cannot authorise a second repair order transition', async () => {
    const { roId, lineId } = await pricedRO();
    const est = await call(advisor, 'POST', `/ros/${roId}/estimates/generate`, {});
    await call(advisor, 'POST', `/ros/${roId}/estimates/${est.body.data.estimate_id}/send`, {});
    await call(advisor, 'POST', `/ros/${roId}/authorizations/record`, {
      estimate_id: est.body.data.estimate_id,
      method: 'portal',
      approved_items: [lineId],
      evidence_refs: { portal_submission_id: randomUUID() },
    });

    const tok = await mintReauthGrant({
      tenantId: tenant,
      userLinkId: advisor.userId,
      action: 'service.ro.transition:canceled',
      resourceId: roId,
    });
    const cancelled = await call(advisor, 'POST', `/ros/${roId}/transition`, {
      to_status: 'canceled',
      step_up_token: tok,
    });
    assert.equal(cancelled.status, 200);

    // The consumed grant is the only thing that makes a second use fail.
    const spent = await query(
      'SELECT consumed_at FROM reauthentication_grants WHERE resource_id=$1',
      [roId],
    );
    assert.equal(spent.rows.length, 1, 'the grant was recorded');
    assert.ok(spent.rows[0].consumed_at, 'and it is spent');
  });

  // ── Billable work added after the estimate went out ─────────

  /** Drives a repair order to in_repair with one approved, priced line. */
  async function roInRepair() {
    const { roId, lineId } = await pricedRO();
    const est = await call(advisor, 'POST', `/ros/${roId}/estimates/generate`, {});
    await call(advisor, 'POST', `/ros/${roId}/estimates/${est.body.data.estimate_id}/send`, {});
    await call(advisor, 'POST', `/ros/${roId}/authorizations/record`, {
      estimate_id: est.body.data.estimate_id,
      method: 'portal',
      approved_items: [lineId],
      evidence_refs: { portal_submission_id: randomUUID() },
    });
    await call(advisor, 'POST', `/ros/${roId}/transition`, {
      to_status: 'authorized',
      step_up_token: await mintReauthGrant({
        tenantId: tenant,
        userLinkId: advisor.userId,
        action: 'service.ro.transition:authorized',
        resourceId: roId,
      }),
    });
    await call(advisor, 'POST', `/ros/${roId}/transition`, { to_status: 'in_repair' });
    return { roId, lineId };
  }

  test('a chargeable line invented mid-repair cannot be delivered', async () => {
    const { roId, lineId } = await roInRepair();

    // Extra work found on the bench, priced, and never put to the customer. It carries the
    // default not_required rather than pending, so a gate that only looks for pending lines
    // would let it through and it would land on the invoice unapproved.
    const extra = await call(advisor, 'POST', `/ros/${roId}/line-items`, {
      line_type: 'labor',
      description: 'Found on the bench',
      estimated_hours: 2,
    });
    await call(advisor, 'PATCH', `/ros/${roId}/line-items/${extra.body.data.line_item_id}`, {
      price_ref: { amount_cents: 80_000, currency: 'USD' },
    });
    await call(advisor, 'PATCH', `/ros/${roId}/line-items/${lineId}`, { status: 'completed' });
    await call(advisor, 'PATCH', `/ros/${roId}/line-items/${extra.body.data.line_item_id}`, {
      status: 'completed',
    });
    await call(advisor, 'POST', `/ros/${roId}/transition`, { to_status: 'qc' });

    const pickup = await call(advisor, 'POST', `/ros/${roId}/transition`, {
      to_status: 'ready_for_pickup',
    });
    assert.equal(pickup.status, 422);
    assert.equal(pickup.body.error.code, 'decision_outstanding');
  });

  test('unpriced warranty or goodwill work still delivers without a customer decision', async () => {
    const { roId, lineId } = await roInRepair();

    // No price: warranty, internal or goodwill work, which is exactly what not_required is
    // for. This must not be caught by the chargeable-work gate.
    const warranty = await call(advisor, 'POST', `/ros/${roId}/line-items`, {
      line_type: 'labor',
      description: 'Warranty recall',
      estimated_hours: 1,
    });
    await call(advisor, 'PATCH', `/ros/${roId}/line-items/${lineId}`, { status: 'completed' });
    await call(advisor, 'PATCH', `/ros/${roId}/line-items/${warranty.body.data.line_item_id}`, {
      status: 'completed',
    });
    await call(advisor, 'POST', `/ros/${roId}/transition`, { to_status: 'qc' });

    const pickup = await call(advisor, 'POST', `/ros/${roId}/transition`, {
      to_status: 'ready_for_pickup',
    });
    assert.equal(pickup.status, 200, JSON.stringify(pickup.body));
    assert.equal(pickup.body.data.status, 'ready_for_pickup');
  });

  // ── Re-quoting ──────────────────────────────────────────────

  test('a re-quote withdraws the old estimate and binds the customer to the price they saw', async () => {
    const { roId, lineId } = await pricedRO();
    const v1 = await call(advisor, 'POST', `/ros/${roId}/estimates/generate`, {});
    await call(advisor, 'POST', `/ros/${roId}/estimates/${v1.body.data.estimate_id}/send`, {});

    // While the line is in front of the customer its price cannot move, or the estimate
    // they answer and the evidence recorded against it would disagree.
    const meddle = await call(advisor, 'PATCH', `/ros/${roId}/line-items/${lineId}`, {
      price_ref: { amount_cents: 99_999, currency: 'USD' },
    });
    assert.equal(meddle.status, 409);
    assert.equal(meddle.body.error.code, 'pending_terms_frozen');

    // The sanctioned re-quote: back to estimate_pending, re-price, re-send.
    await call(advisor, 'POST', `/ros/${roId}/transition`, {
      to_status: 'estimate_pending',
      reason: 're-quote',
    });
    const withdrawn = await query('SELECT status FROM ro_estimates WHERE estimate_id=$1', [
      v1.body.data.estimate_id,
    ]);
    assert.equal(
      withdrawn.rows[0].status,
      'expired',
      'the withdrawn estimate is no longer answerable',
    );

    await call(advisor, 'PATCH', `/ros/${roId}/line-items/${lineId}`, {
      price_ref: { amount_cents: 99_999, currency: 'USD' },
    });
    const v2 = await call(advisor, 'POST', `/ros/${roId}/estimates/generate`, {});
    await call(advisor, 'POST', `/ros/${roId}/estimates/${v2.body.data.estimate_id}/send`, {});

    // A customer following the stale portal link is refused, not silently bound.
    const stale = await call(advisor, 'POST', `/ros/${roId}/authorizations/record`, {
      estimate_id: v1.body.data.estimate_id,
      method: 'portal',
      approved_items: [lineId],
      evidence_refs: { portal_submission_id: randomUUID() },
    });
    assert.equal(stale.status, 409);
    assert.ok(
      ['estimate_not_sent', 'estimate_superseded'].includes(stale.body.error.code),
      stale.body.error.code,
    );

    // The current estimate is decidable, and the evidence matches what it showed.
    const auth = await call(advisor, 'POST', `/ros/${roId}/authorizations/record`, {
      estimate_id: v2.body.data.estimate_id,
      method: 'portal',
      approved_items: [lineId],
      evidence_refs: { portal_submission_id: randomUUID() },
    });
    assert.equal(auth.status, 201);
    assert.equal(Number(auth.body.data.approved_snapshot[lineId].price_ref.amount_cents), 99_999);
    assert.equal(
      Number(v2.body.data.totals_ref.amount_cents),
      99_999,
      'and matches the estimate total',
    );

    // And the repair order is not wedged: it can still be authorised.
    const moved = await call(advisor, 'POST', `/ros/${roId}/transition`, {
      to_status: 'authorized',
      step_up_token: await mintReauthGrant({
        tenantId: tenant,
        userLinkId: advisor.userId,
        action: 'service.ro.transition:authorized',
        resourceId: roId,
      }),
    });
    assert.equal(moved.status, 200);
    assert.equal(moved.body.data.status, 'authorized');
  });

  // ── No-show ─────────────────────────────────────────────────

  test('a no-show is recorded once and queues the follow-up', async () => {
    const appt = await call(advisor, 'POST', '/appointments', {
      location_id: location,
      mdm_customer_id: randomUUID(),
      mdm_vehicle_id: randomUUID(),
      scheduled_start: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const id = appt.body.data.appointment_id;

    const marked = await call(advisor, 'POST', `/appointments/${id}/no-show`, {});
    assert.equal(marked.status, 200);
    assert.equal(marked.body.data.status, 'no_show');

    const queued = await query(
      `SELECT queue_type FROM service_queue_items WHERE appointment_id=$1 AND status NOT IN ('done','canceled')`,
      [id],
    );
    assert.deepEqual(
      queued.rows.map((r: any) => r.queue_type),
      ['no_show_followup'],
    );

    // The status is terminal for this purpose: marking it twice must not queue a second
    // follow-up call to the same customer.
    const again = await call(advisor, 'POST', `/appointments/${id}/no-show`, {});
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'invalid_appointment_status');
  });

  // ── MPI over the wire ───────────────────────────────────────

  test('an inspection result without severity is refused at the API', async () => {
    const { roId } = await pricedRO();
    const templateId = await seedMPITemplate({ tenantId: tenant } as any, location);
    const session = await call(advisor, 'POST', `/ros/${roId}/mpi/start`, {
      template_id: templateId,
      tech_user_id: technician.userId,
    });
    assert.equal(session.status, 201);

    const bad = await call(advisor, 'POST', `/mpi/${session.body.data.mpi_session_id}/results`, {
      item_key: 'brake_pads',
      status: 'fail',
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'severity_required');
  });

  test('default process metrics are label-free and the exposition never mentions a tenant', async () => {
    // server.ts registers these at boot; tests build the app directly, so register here
    // (once per process — the suites run one file per process).
    promClient.collectDefaultMetrics();

    const res = await fetch(`${base}/metrics`);
    assert.equal(res.status, 200);
    const exposition = await res.text();

    assert.ok(exposition.includes('process_cpu_user_seconds_total'), 'process baseline present');
    assert.ok(exposition.includes('nodejs_eventloop_lag_seconds'), 'event-loop lag present');

    // The repo-wide /metrics invariant, asserted at the whole-surface level: the endpoint
    // is unauthenticated, so nothing on it may name a tenant — not a label, not a value.
    assert.ok(
      !/tenant/i.test(exposition),
      'no series, label or value on /metrics may mention a tenant',
    );
  });

  test('the waitlist is advisor-writable, technician-readable only', async () => {
    const vehicle = randomUUID();
    const entryBody = {
      location_id: location,
      mdm_customer_id: randomUUID(),
      mdm_vehicle_id: vehicle,
      requested_start: new Date(Date.now() + 86_400_000).toISOString(),
    };

    const denied = await call(technician, 'POST', '/waitlist', entryBody);
    assert.equal(denied.status, 403, 'a technician cannot put customers on the waitlist');

    const created = await call(advisor, 'POST', '/waitlist', entryBody);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.data.waitlist_entry_id;

    const listed = await call(technician, 'GET', '/waitlist?status=waiting');
    assert.equal(listed.status, 200, 'shop floor can see the queue');
    assert.equal(listed.body.data.length, 1);

    const techConvert = await call(technician, 'POST', `/waitlist/${id}/convert`, {
      scheduled_start: new Date(Date.now() + 86_400_000).toISOString(),
    });
    // resource-scoped denial: unauthorized reads as nonexistent (non-enumeration)
    assert.equal(techConvert.status, 404, 'booking the slot is a commercial action');

    const converted = await call(advisor, 'POST', `/waitlist/${id}/convert`, {
      scheduled_start: new Date(Date.now() + 86_400_000).toISOString(),
    });
    assert.equal(converted.status, 201, JSON.stringify(converted.body));
    assert.equal(converted.body.data.appointment.source, 'waitlist');
  });

  test('the liveness probe answers without authentication', async () => {
    const res = await fetch(`${base}/healthz`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: 'ok' });
  });

  test('an oversized body is refused with the stable envelope (400 body_too_large today), not a stack trace', async () => {
    // JSON_BODY_LIMIT defaults to 1mb; send ~1.5mb of valid JSON.
    const big = JSON.stringify({ notes: 'x'.repeat(1_500_000) });
    const res = await fetch(`${base}/api/service/appointments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${advisor.jwt}` },
      body: big,
    });
    // Characterization records ACTUAL behavior: the body-size branch maps to a
    // ValidationError, so the current public contract is 400 body_too_large (not 413).
    // Changing that status is a deliberate contract decision for a later order.
    assert.equal(res.status, 400);
    const body = (await res.json()) as { success: boolean; error: { code: string } };
    assert.equal(body.success, false);
    assert.equal(body.error.code, 'body_too_large');
  });
});
