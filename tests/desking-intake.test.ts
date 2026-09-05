import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';

import { closePool, query } from '@dealer/database';
import { openDeskingCase, getDeskingCase, awaitingDesk } from '@dealer/desking';
import {
  resetDatabase,
  skipIntegration,
  startIdentityTestEnv,
  type IdentityTestEnv,
} from '@dealer/test-kit';

import { show, seedDeskWorld, resetVins } from './desking-world';

/**
 * ROW 1 — CANONICAL INTAKE.
 *
 * "Consume the desking-ready fact exactly once and preserve the canonical
 * opportunity, customer, rooftop, selected stock, and optional trade vehicle.
 * Repeated or concurrent intake converges; foreign or mismatched references
 * refuse without disclosure."
 *
 * THE RACE IS RUN, NOT REASONED ABOUT. `openDeskingCaseWithin` has three
 * independent guards and each alone produces the right answer, so no honest
 * single-line mutation of it exists — which is exactly why this battery starts
 * two real transactions and lets them collide instead of trusting a registry
 * entry to prove convergence.
 */
describe(
  'desking: one fact, one desk file (FBL-120 Row 1)',
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
      resetVins();
    });

    test('opening a desk file carries every canonical reference the fact was written with', async () => {
      const w = await seedDeskWorld(env);
      const opened = await openDeskingCase({
        actingUserLinkId: w.seller,
        tenantId: w.tenantId,
        deskingHandoffId: w.deskingHandoffId,
      });
      assert.equal(opened.outcome, 'opened', show(opened));
      const file = (opened as unknown as { deskingCase: Record<string, unknown> }).deskingCase;

      assert.equal(file.opportunityId, w.opportunityId, 'the opportunity it came from');
      assert.equal(file.partyId, w.partyId, 'the canonical customer');
      assert.equal(file.rooftopId, w.rooftopId, 'the rooftop that owns it');
      assert.equal(file.stockItemId, w.stockItemId, 'the car they settled on');
      assert.equal(file.deskingHandoffId, w.deskingHandoffId, 'and the fact itself');
      assert.equal(file.state, 'open');

      // NOT COPIED FROM THE OPPORTUNITY AS IT IS NOW — copied from the fact.
      const fact = await query(
        `SELECT rooftop_id, party_id, stock_item_id, desking_status
           FROM desking_handoffs WHERE tenant_id = $1 AND desking_handoff_id = $2`,
        [w.tenantId, w.deskingHandoffId],
      );
      const row = fact.rows[0] as Record<string, unknown>;
      assert.equal(String(row.rooftop_id), file.rooftopId);
      assert.equal(String(row.party_id), file.partyId);
      assert.equal(String(row.stock_item_id), file.stockItemId);

      // AND THE SEAM SAYS THE DESK HOLDS IT. Migration 064 shipped this column
      // pinned to NOT_YET_AVAILABLE because the desk did not exist; 065 took
      // the pin off, and this is the write that earns it.
      assert.equal(String(row.desking_status), 'AVAILABLE');
    });

    test('a repeated intake converges on the file that already exists', async () => {
      const w = await seedDeskWorld(env);
      const first = await openDeskingCase({
        actingUserLinkId: w.seller,
        tenantId: w.tenantId,
        deskingHandoffId: w.deskingHandoffId,
      });
      const second = await openDeskingCase({
        actingUserLinkId: w.otherSeller,
        tenantId: w.tenantId,
        deskingHandoffId: w.deskingHandoffId,
      });
      assert.equal(first.outcome, 'opened');
      assert.equal(second.outcome, 'already_open', show(second));
      assert.equal(
        (first as { deskingCase: { deskingCaseId: string } }).deskingCase.deskingCaseId,
        (second as { deskingCase: { deskingCaseId: string } }).deskingCase.deskingCaseId,
      );
      const count = await query(
        `SELECT COUNT(*)::int AS n FROM desking_cases WHERE tenant_id = $1 AND opportunity_id = $2`,
        [w.tenantId, w.opportunityId],
      );
      assert.equal(Number((count.rows[0] as { n: number }).n), 1);
    });

    test('two genuinely concurrent intakes converge on one desk file', async () => {
      const w = await seedDeskWorld(env);

      // TWO REAL TRANSACTIONS, STARTED TOGETHER. A worker draining the outbox
      // while a salesperson clicks, or one delivery arriving twice — this is
      // what all of those look like at the service.
      const [a, b] = await Promise.all([
        openDeskingCase({
          actingUserLinkId: w.seller,
          tenantId: w.tenantId,
          deskingHandoffId: w.deskingHandoffId,
        }),
        openDeskingCase({
          actingUserLinkId: w.otherSeller,
          tenantId: w.tenantId,
          deskingHandoffId: w.deskingHandoffId,
        }),
      ]);

      // ONE OPENS, ONE CONVERGES, AND NEITHER SEES A UNIQUE-KEY ERROR.
      assert.deepEqual(
        [a.outcome, b.outcome].sort(),
        ['already_open', 'opened'],
        `one fact, one file — got ${show([a, b])}`,
      );
      const ids = [a, b].map(
        (x) => (x as { deskingCase: { deskingCaseId: string } }).deskingCase.deskingCaseId,
      );
      assert.equal(ids[0], ids[1], 'both callers hold the same file');

      const count = await query(
        `SELECT COUNT(*)::int AS n FROM desking_cases
          WHERE tenant_id = $1 AND desking_handoff_id = $2`,
        [w.tenantId, w.deskingHandoffId],
      );
      assert.equal(Number((count.rows[0] as { n: number }).n), 1);
    });

    test('a fact at a rooftop this person does not work is refused in the words a missing one gets', async () => {
      const w = await seedDeskWorld(env);
      const foreign = await openDeskingCase({
        actingUserLinkId: w.foreignSeller,
        tenantId: w.tenantId,
        deskingHandoffId: w.deskingHandoffId,
      });
      const absent = await openDeskingCase({
        actingUserLinkId: w.seller,
        tenantId: w.tenantId,
        deskingHandoffId: randomUUID(),
      });
      assert.deepEqual(foreign, { outcome: 'not_found' });
      assert.deepEqual(
        absent,
        foreign,
        'the refusal for a real fact somebody else owns is the same object as the refusal for one that never existed',
      );

      // …AND THE PROBE LEFT NOTHING BEHIND.
      const count = await query(
        `SELECT COUNT(*)::int AS n FROM desking_cases WHERE tenant_id = $1`,
        [w.tenantId],
      );
      assert.equal(Number((count.rows[0] as { n: number }).n), 0);
    });

    test('a file opened at another rooftop is not readable, and not listed', async () => {
      const w = await seedDeskWorld(env);
      const opened = await openDeskingCase({
        actingUserLinkId: w.seller,
        tenantId: w.tenantId,
        deskingHandoffId: w.deskingHandoffId,
      });
      const caseId = (opened as { deskingCase: { deskingCaseId: string } }).deskingCase
        .deskingCaseId;

      assert.equal(await getDeskingCase(w.tenantId, w.foreignSeller, caseId), null);
      assert.notEqual(await getDeskingCase(w.tenantId, w.seller, caseId), null);
    });

    test('the discovery list holds facts nobody has opened yet, and drops them once opened', async () => {
      const w = await seedDeskWorld(env);
      const before = await awaitingDesk(w.tenantId, w.seller);
      assert.equal(before.length, 1, show(before));
      assert.equal(before[0]?.deskingHandoffId, w.deskingHandoffId);

      await openDeskingCase({
        actingUserLinkId: w.seller,
        tenantId: w.tenantId,
        deskingHandoffId: w.deskingHandoffId,
      });
      assert.deepEqual(await awaitingDesk(w.tenantId, w.seller), []);

      // A salesperson at the other rooftop never saw it at all.
      assert.deepEqual(await awaitingDesk(w.tenantId, w.foreignSeller), []);
    });
  },
);
