import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';

import { closePool, query } from '@dealer/database';
import { openDeskingCase } from '@dealer/desking';
import {
  assemblePackage,
  jacketBoard,
  jacketDetail,
  openableDeskingCases,
  openJacket,
  voidJacket,
} from '@dealer/jacket';
import {
  fixtureAuthorizationStateWrite,
  resetDatabase,
  skipIntegration,
  startIdentityTestEnv,
  type IdentityTestEnv,
} from '@dealer/test-kit';

import { seedDeskWorld, seedRuleBook } from './desking-world';
import { approveVersion, resetVins, seedJacketWorld, show, type JacketWorld } from './jacket-world';

/**
 * OUTCOME 1 — CANONICAL INTAKE AND IDENTITY.
 *
 * "Consume the exact approved desking version through FBL-120’s public
 * interface or published fact. Bind tenant, legal entity, rooftop, opportunity,
 * party, selected stock, trade/appraisal context, approved scenario version,
 * and rule versions. Retry and concurrency must converge without duplicate
 * active jackets."
 *
 * THE FACT IS FBL-120'S OWN. Every version this battery opens a jacket from was
 * built, submitted and approved by `@dealer/desking`'s services, and read back
 * through the seam that package exposes — nothing here selects from a desking
 * table to decide what to bind.
 */
describe(
  'jacket: canonical intake and identity (FBL-140 Outcome 1)',
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

    async function opened(w: JacketWorld) {
      const out = await openJacket({
        actingUserLinkId: w.seller,
        tenantId: w.tenantId,
        deskingCaseId: w.caseId,
      });
      assert.equal(out.outcome, 'opened', show(out));
      return (out as { jacket: { jacketId: string; authorizationVersion: number } }).jacket;
    }

    test('opening a jacket binds every canonical reference at the version it carried', async () => {
      const w = await seedJacketWorld(env);
      const out = await openJacket({
        actingUserLinkId: w.seller,
        tenantId: w.tenantId,
        deskingCaseId: w.caseId,
      });
      assert.equal(out.outcome, 'opened', show(out));
      const jacket = (out as unknown as { jacket: Record<string, unknown> }).jacket;

      // THE IDENTITY OF THE DEAL, copied from the desk's fact and not from the pipeline as it stands.
      assert.equal(jacket.deskingCaseId, w.caseId);
      assert.equal(jacket.rooftopId, w.rooftopId);
      assert.equal(jacket.partyId, w.partyId);
      assert.equal(jacket.stockItemId, w.stockItemId);
      assert.equal(jacket.opportunityId, w.opportunityId);
      assert.equal(jacket.appraisalId, w.appraisalId);
      assert.equal(jacket.approvedScenarioId, w.approvedScenarioId);
      assert.equal(jacket.scenarioVersionNo, w.approvedVersionNo);
      assert.equal(jacket.approvedOutputFingerprint, w.approvedFingerprint);
      assert.equal(jacket.transactionType, 'retail_finance', 'a 72-month term is a finance deal');
      assert.equal(jacket.jurisdiction, 'US-CO');
      assert.equal(jacket.state, 'open');

      const entity = await query(
        `SELECT legal_entity_id FROM rooftops WHERE tenant_id = $1 AND rooftop_id = $2`,
        [w.tenantId, w.rooftopId],
      );
      assert.equal(
        jacket.legalEntityId,
        String((entity.rows[0] as { legal_entity_id: string }).legal_entity_id),
      );

      // EVERY SOURCE, WITH ITS VERSION.
      const detail = await jacketDetail(w.tenantId, w.seller, String(jacket.jacketId));
      assert.ok(detail !== null);
      const kinds = detail.bindings.map((b) => b.sourceKind).sort();
      for (const expected of [
        'legal_entity',
        'rooftop',
        'party',
        'stock_item',
        'vehicle',
        'appraisal_version',
        'desking_scenario',
        'scenario_approval',
        'desking_rule',
      ]) {
        assert.ok(
          kinds.includes(expected),
          `bound ${expected}; bound kinds were ${kinds.join(', ')}`,
        );
      }
      const scenarioBinding = detail.bindings.find((b) => b.sourceKind === 'desking_scenario');
      assert.equal(scenarioBinding?.sourceId, w.approvedScenarioId);
      assert.equal(scenarioBinding?.sourceVersion, String(w.approvedVersionNo));
      assert.equal(scenarioBinding?.sourceFingerprint, w.approvedFingerprint);
      const rules = detail.bindings.filter((b) => b.sourceKind === 'desking_rule');
      assert.equal(
        rules.length,
        3,
        'tax, doc fee and trade-credit policy — every rule the version was priced under',
      );
      const appraisal = detail.bindings.find((b) => b.sourceKind === 'appraisal_version');
      assert.equal(appraisal?.sourceVersion, '1', 'the trade at evidence version 1');

      // AND THE CHECKLIST, RESOLVED FROM CONFIGURATION AT THE INSTANT OF OPENING.
      assert.equal(detail.checklist.length, 4);
      assert.deepEqual(
        detail.checklist.map((i) => [i.requirementCode, i.requirementVersion, i.state]).sort(),
        [
          ['odometer_disclosure', 1, 'missing'],
          ['privacy_notice', 1, 'missing'],
          ['proof_of_insurance', 1, 'missing'],
          ['retail_agreement', 1, 'missing'],
        ],
      );
      for (const item of detail.checklist)
        assert.ok(item.requirementSource.length > 0, 'every requirement shows its source');
    });

    test('a repeated intake converges on the jacket that already exists', async () => {
      const w = await seedJacketWorld(env);
      const first = await opened(w);
      const second = await openJacket({
        actingUserLinkId: w.otherSeller,
        tenantId: w.tenantId,
        deskingCaseId: w.caseId,
      });
      assert.equal(second.outcome, 'already_open', show(second));
      assert.equal((second as { jacket: { jacketId: string } }).jacket.jacketId, first.jacketId);
      const count = await query(
        `SELECT COUNT(*)::int AS n FROM deal_jackets WHERE tenant_id = $1`,
        [w.tenantId],
      );
      assert.equal(Number((count.rows[0] as { n: number }).n), 1);
    });

    test('two genuinely concurrent intakes converge on one jacket', async () => {
      const w = await seedJacketWorld(env);
      const [a, b] = await Promise.all([
        openJacket({ actingUserLinkId: w.seller, tenantId: w.tenantId, deskingCaseId: w.caseId }),
        openJacket({
          actingUserLinkId: w.otherSeller,
          tenantId: w.tenantId,
          deskingCaseId: w.caseId,
        }),
      ]);
      assert.deepEqual([a.outcome, b.outcome].sort(), ['already_open', 'opened'], show([a, b]));
      const ids = [a, b].map((x) => (x as { jacket: { jacketId: string } }).jacket.jacketId);
      assert.equal(ids[0], ids[1]);
      const count = await query(
        `SELECT COUNT(*)::int AS n FROM deal_jackets WHERE tenant_id = $1`,
        [w.tenantId],
      );
      assert.equal(Number((count.rows[0] as { n: number }).n), 1);
    });

    test('a deal nothing is approved on cannot have a jacket, and a foreign or missing file is simply not found', async () => {
      const desk = await seedDeskWorld(env);
      await seedRuleBook(desk);
      const file = await openDeskingCase({
        actingUserLinkId: desk.seller,
        tenantId: desk.tenantId,
        deskingHandoffId: desk.deskingHandoffId,
      });
      const caseId = (file as { deskingCase: { deskingCaseId: string } }).deskingCase.deskingCaseId;

      const early = await openJacket({
        actingUserLinkId: desk.seller,
        tenantId: desk.tenantId,
        deskingCaseId: caseId,
      });
      assert.equal(early.outcome, 'not_approved', show(early));

      // A salesperson at the OTHER rooftop gets the words a missing file gets — not "not approved".
      const foreign = await openJacket({
        actingUserLinkId: desk.foreignSeller,
        tenantId: desk.tenantId,
        deskingCaseId: caseId,
      });
      assert.equal(foreign.outcome, 'not_found', show(foreign));

      const missing = await openJacket({
        actingUserLinkId: desk.seller,
        tenantId: desk.tenantId,
        deskingCaseId: '00000000-0000-4000-8000-000000000000',
      });
      assert.equal(missing.outcome, 'not_found');

      // ONCE APPROVED, the same call opens — for somebody who works the rooftop. The foreign
      // seller is refused BEFORE anybody opens it (the fact is at a rooftop they do not work)
      // and AFTER (the jacket that exists is not theirs), in the same words both times.
      await approveVersion(desk, caseId);
      const foreignFirst = await openJacket({
        actingUserLinkId: desk.foreignSeller,
        tenantId: desk.tenantId,
        deskingCaseId: caseId,
      });
      assert.equal(foreignFirst.outcome, 'not_found', show(foreignFirst));
      const now = await openJacket({
        actingUserLinkId: desk.seller,
        tenantId: desk.tenantId,
        deskingCaseId: caseId,
      });
      assert.equal(now.outcome, 'opened', show(now));
      const jacketId = (now as { jacket: { jacketId: string } }).jacket.jacketId;
      const foreignAfter = await openJacket({
        actingUserLinkId: desk.foreignSeller,
        tenantId: desk.tenantId,
        deskingCaseId: caseId,
      });
      assert.equal(foreignAfter.outcome, 'not_found', show(foreignAfter));
      assert.equal(await jacketDetail(desk.tenantId, desk.foreignSeller, jacketId), null);
      assert.equal((await jacketBoard(desk.tenantId, desk.foreignSeller)).rows.length, 0);
    });

    test('the discovery list holds approved deals nobody has opened a jacket for, and drops them once opened', async () => {
      const w = await seedJacketWorld(env);
      const before = await openableDeskingCases(w.tenantId, w.seller);
      assert.deepEqual(
        before.map((c) => [c.deskingCaseId, c.approvedScenarioId, c.versionNo]),
        [[w.caseId, w.approvedScenarioId, w.approvedVersionNo]],
      );
      assert.equal(before[0]?.customerName, 'Dana Ortiz');
      assert.ok(
        (before[0]?.amountFinancedCents ?? 0n) > 0n,
        'the figure the desk approved rides along',
      );
      assert.equal(
        typeof before[0]?.amountFinancedCents,
        'bigint',
        'money is an integer on this list too',
      );
      // The list is scoped: the foreign seller sees nothing.
      assert.deepEqual(await openableDeskingCases(w.tenantId, w.foreignSeller), []);

      await opened(w);
      assert.deepEqual(await openableDeskingCases(w.tenantId, w.seller), []);
    });

    test('the backstop keys refuse a duplicate active jacket with every service stepped round', async () => {
      const w = await seedJacketWorld(env);
      const j = await opened(w);
      const row = await query(
        `SELECT * FROM deal_jackets WHERE tenant_id = $1 AND jacket_id = $2`,
        [w.tenantId, j.jacketId],
      );
      const r = row.rows[0] as Record<string, unknown>;

      // A second jacket on the same approved version: the unique key. The probe row
      // is VOIDED so that only this key can refuse it — an open duplicate would also
      // collide with the one-active-per-case index, and which of two violated keys
      // Postgres names depends on the order the indexes were created in, which the
      // control registry changes when it drops and re-adds this one.
      await assert.rejects(
        fixtureAuthorizationStateWrite(
          'adversarial-bypass-attempt',
          `INSERT INTO deal_jackets
             (tenant_id, legal_entity_id, rooftop_id, desking_case_id, opportunity_id, party_id,
              approved_scenario_id, scenario_version_no, approved_output_fingerprint, approval_id,
              jurisdiction, transaction_type, opened_by_user_link_id, state)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'voided')`,
          [
            w.tenantId,
            r.legal_entity_id,
            r.rooftop_id,
            r.desking_case_id,
            r.opportunity_id,
            r.party_id,
            r.approved_scenario_id,
            r.scenario_version_no,
            r.approved_output_fingerprint,
            r.approval_id,
            r.jurisdiction,
            r.transaction_type,
            w.seller,
          ],
        ),
        /deal_jackets_tenant_id_approved_scenario_id_key/,
      );

      // A second ACTIVE jacket on the same desk file naming another version: the partial index.
      const other = await approveVersion(w, w.caseId, { cashDownCents: 400_000n });
      const approval = await query(
        `SELECT approval_id FROM scenario_approvals WHERE tenant_id = $1 AND scenario_id = $2`,
        [w.tenantId, other.scenarioId],
      );
      await assert.rejects(
        fixtureAuthorizationStateWrite(
          'adversarial-bypass-attempt',
          `INSERT INTO deal_jackets
             (tenant_id, legal_entity_id, rooftop_id, desking_case_id, opportunity_id, party_id,
              approved_scenario_id, scenario_version_no, approved_output_fingerprint, approval_id,
              jurisdiction, transaction_type, opened_by_user_link_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [
            w.tenantId,
            r.legal_entity_id,
            r.rooftop_id,
            r.desking_case_id,
            r.opportunity_id,
            r.party_id,
            other.scenarioId,
            other.versionNo,
            other.fingerprint,
            (approval.rows[0] as { approval_id: string }).approval_id,
            r.jurisdiction,
            r.transaction_type,
            w.seller,
          ],
        ),
        /uq_deal_jackets_one_active_per_case/,
      );
    });

    test('when the desk approves a newer version the jacket is stale, assembly refuses, and void-then-open binds the new one', async () => {
      const w = await seedJacketWorld(env);
      const j = await opened(w);

      const successor = await approveVersion(w, w.caseId, { cashDownCents: 500_000n });
      assert.notEqual(successor.scenarioId, w.approvedScenarioId);

      const board = await jacketBoard(w.tenantId, w.manager);
      const row = board.rows.find((x) => x.jacketId === j.jacketId);
      assert.ok(row !== undefined);
      assert.equal(row.stale, true);
      assert.equal(row.currentApprovedVersionNo, successor.versionNo);
      assert.ok(row.exceptions.includes('desk approval moved'), show(row.exceptions));
      assert.equal(board.queues.stale_inputs, 1);

      const refused = await assemblePackage({
        actingUserLinkId: w.seller,
        tenantId: w.tenantId,
        jacketId: j.jacketId,
        expectedVersion: j.authorizationVersion,
      });
      assert.equal(refused.outcome, 'stale_source', show(refused));
      assert.equal((refused as { boundVersionNo: number }).boundVersionNo, w.approvedVersionNo);
      assert.equal((refused as { currentVersionNo: number }).currentVersionNo, successor.versionNo);

      // The intake still converges on the STALE jacket — it is the active one — until a manager voids it.
      const again = await openJacket({
        actingUserLinkId: w.seller,
        tenantId: w.tenantId,
        deskingCaseId: w.caseId,
      });
      assert.equal(again.outcome, 'already_open');

      const bySeller = await voidJacket({
        actingUserLinkId: w.seller,
        tenantId: w.tenantId,
        jacketId: j.jacketId,
        reason: 'desk moved on',
        expectedVersion: j.authorizationVersion,
      });
      assert.equal(
        bySeller.outcome,
        'not_found',
        'a salesperson cannot void, and the refusal explains nothing',
      );
      const voided = await voidJacket({
        actingUserLinkId: w.manager,
        tenantId: w.tenantId,
        jacketId: j.jacketId,
        reason: 'desk moved on',
        expectedVersion: j.authorizationVersion,
      });
      assert.equal(voided.outcome, 'moved', show(voided));

      const reopened = await openJacket({
        actingUserLinkId: w.seller,
        tenantId: w.tenantId,
        deskingCaseId: w.caseId,
      });
      assert.equal(reopened.outcome, 'opened', show(reopened));
      const fresh = (
        reopened as {
          jacket: { jacketId: string; approvedScenarioId: string; scenarioVersionNo: number };
        }
      ).jacket;
      assert.notEqual(fresh.jacketId, j.jacketId);
      assert.equal(fresh.approvedScenarioId, successor.scenarioId);
      assert.equal(fresh.scenarioVersionNo, successor.versionNo);

      // The voided jacket is still there, voided — nothing was deleted.
      const kept = await query(
        `SELECT state FROM deal_jackets WHERE tenant_id = $1 AND jacket_id = $2`,
        [w.tenantId, j.jacketId],
      );
      assert.equal(String((kept.rows[0] as { state: string }).state), 'voided');
    });
  },
);
