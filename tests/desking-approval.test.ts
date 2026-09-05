import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';

import { closePool, query } from '@dealer/database';
import {
  buildScenario,
  decideScenario,
  deskBoard,
  expireScenario,
  openDeskingCase,
  recordAppraisal,
  recordSourceQuotation,
  scenarioDetail,
  submitScenario,
} from '@dealer/desking';
import {
  fixtureAuthorizationStateWrite,
  resetDatabase,
  skipIntegration,
  startIdentityTestEnv,
  type IdentityTestEnv,
} from '@dealer/test-kit';

import {
  JURISDICTION,
  seedDeskWorld,
  seedRuleBook,
  resetVins,
  show,
  tradeEvidence,
  type DeskWorld,
} from './desking-world';

/**
 * ROWS 5 AND 6 — MANAGER APPROVAL AND FREEZE, LIFECYCLE AND OVERSIGHT.
 *
 * "Approval binds an eligible manager, the exact scenario version reviewed, any
 * required limit or override reason, and one immutable decision time. Approved
 * versions cannot be edited; rejection, expiry, and explicit audited
 * supersession are modeled without rewriting history."
 *
 * "Support draft, revise, compare, submit, approve, reject, expire, and
 * supersede with one current approved version per opportunity. The manager view
 * reconciles appraisal variance, scenario versions, pending approvals,
 * exceptions, and source freshness across permitted rooftops without inventing
 * gross or sale facts."
 *
 * THE FREEZE IS PROVED AT THE TABLE, not at the service. Two of these probes
 * issue their UPDATE and their INSERT directly, because "an approved version
 * cannot be edited" is a claim about the database or it is a claim about
 * whichever code path happened to be tested.
 */
describe(
  'desking: the decision, and what it freezes (FBL-120 Rows 5 and 6)',
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

    interface Priced {
      caseId: string;
      scenarioId: string;
      version: number;
      fingerprint: string;
    }

    async function priced(w: DeskWorld, overrides: Record<string, unknown> = {}): Promise<Priced> {
      const opened = await openDeskingCase({
        actingUserLinkId: w.seller,
        tenantId: w.tenantId,
        deskingHandoffId: w.deskingHandoffId,
      });
      const caseId = (opened as { deskingCase: { deskingCaseId: string } }).deskingCase
        .deskingCaseId;
      const built = await buildScenario({
        actingUserLinkId: w.seller,
        tenantId: w.tenantId,
        deskingCaseId: caseId,
        label: 'First pencil',
        jurisdiction: JURISDICTION,
        vehiclePriceCents: 4_550_000n,
        tradeAllowanceCents: 1_200_000n,
        tradePayoffCents: 1_450_000n,
        cashDownCents: 300_000n,
        termMonths: 72,
        aprPpm: 74_900n,
        ...overrides,
      });
      assert.equal(built.outcome, 'built', show(built));
      const s = (
        built as {
          scenario: {
            scenarioId: string;
            authorizationVersion: number;
            outputFingerprint: string;
          };
        }
      ).scenario;
      return {
        caseId,
        scenarioId: s.scenarioId,
        version: s.authorizationVersion,
        fingerprint: s.outputFingerprint,
      };
    }

    async function submitted(w: DeskWorld, p: Priced): Promise<Priced> {
      const moved = await submitScenario({
        actingUserLinkId: w.seller,
        tenantId: w.tenantId,
        scenarioId: p.scenarioId,
        expectedVersion: p.version,
      });
      assert.equal(moved.outcome, 'moved', show(moved));
      return {
        ...p,
        version: (moved as { scenario: { authorizationVersion: number } }).scenario
          .authorizationVersion,
      };
    }

    test('an approval names the manager, the exact version reviewed and one decision time', async () => {
      const w = await seedDeskWorld(env);
      await seedRuleBook(w);
      const p = await submitted(w, await priced(w));

      const decided = await decideScenario({
        actingUserLinkId: w.manager,
        tenantId: w.tenantId,
        scenarioId: p.scenarioId,
        decision: 'approved',
        reviewedOutputFingerprint: p.fingerprint,
        expectedVersion: p.version,
        overrideReason: 'Within the desk limit; customer taking delivery Friday.',
      });
      assert.equal(decided.outcome, 'decided', show(decided));

      const row = await query(
        `SELECT decision, decided_by_user_link_id, decided_at, reviewed_output_fingerprint,
                scenario_version_no, override_reason
           FROM scenario_approvals WHERE tenant_id = $1 AND scenario_id = $2`,
        [w.tenantId, p.scenarioId],
      );
      assert.equal(row.rows.length, 1, 'one decision, and only one');
      const a = row.rows[0] as Record<string, unknown>;
      assert.equal(String(a.decision), 'approved');
      assert.equal(String(a.decided_by_user_link_id), w.manager, 'attributable to the manager');
      assert.equal(String(a.reviewed_output_fingerprint), p.fingerprint, 'the EXACT version');
      assert.equal(Number(a.scenario_version_no), 1);
      assert.ok(a.decided_at !== null, 'one immutable decision time');

      // …and the file follows the decision.
      const file = await query(
        `SELECT state, approved_at FROM desking_cases WHERE tenant_id = $1 AND desking_case_id = $2`,
        [w.tenantId, p.caseId],
      );
      assert.equal(String((file.rows[0] as Record<string, unknown>).state), 'approved');
    });

    test('a manager looking at figures that were rebuilt is refused, and nothing is written', async () => {
      const w = await seedDeskWorld(env);
      await seedRuleBook(w);
      const p = await submitted(w, await priced(w));

      const stale = await decideScenario({
        actingUserLinkId: w.manager,
        tenantId: w.tenantId,
        scenarioId: p.scenarioId,
        decision: 'approved',
        reviewedOutputFingerprint: 'f'.repeat(64),
        expectedVersion: p.version,
      });
      assert.equal(stale.outcome, 'stale_view', show(stale));
      assert.equal((stale as { currentFingerprint: string }).currentFingerprint, p.fingerprint);

      const none = await query(
        `SELECT COUNT(*)::int AS n FROM scenario_approvals WHERE tenant_id = $1`,
        [w.tenantId],
      );
      assert.equal(Number((none.rows[0] as { n: number }).n), 0);
    });

    test('the database refuses a decision that names the wrong figures, with the service stepped round', async () => {
      const w = await seedDeskWorld(env);
      await seedRuleBook(w);
      const p = await submitted(w, await priced(w));

      await assert.rejects(
        () =>
          query(
            `INSERT INTO scenario_approvals
               (tenant_id, desking_case_id, scenario_id, scenario_version_no, decision,
                reviewed_output_fingerprint, decided_by_user_link_id)
             VALUES ($1, $2, $3, 1, 'approved', $4, $5)`,
            [w.tenantId, p.caseId, p.scenarioId, 'a'.repeat(64), w.manager],
          ),
        /a decision binds the exact version reviewed/,
      );
    });

    test('an approved version cannot be edited, and only supersession moves it', async () => {
      const w = await seedDeskWorld(env);
      await seedRuleBook(w);
      const p = await submitted(w, await priced(w));
      const decided = await decideScenario({
        actingUserLinkId: w.manager,
        tenantId: w.tenantId,
        scenarioId: p.scenarioId,
        decision: 'approved',
        reviewedOutputFingerprint: p.fingerprint,
        expectedVersion: p.version,
      });
      assert.equal(decided.outcome, 'decided', show(decided));

      await assert.rejects(
        () =>
          fixtureAuthorizationStateWrite(
            'adversarial-bypass-attempt',
            `UPDATE desking_scenarios SET vehicle_price_cents = 1
                WHERE tenant_id = $1 AND scenario_id = $2`,
            [w.tenantId, p.scenarioId],
          ),
        /is a written version/,
        'a figure cannot be edited on any version, decided or not',
      );
      await assert.rejects(
        () =>
          fixtureAuthorizationStateWrite(
            'adversarial-bypass-attempt',
            `UPDATE desking_scenarios SET state = 'draft'
                WHERE tenant_id = $1 AND scenario_id = $2`,
            [w.tenantId, p.scenarioId],
          ),
        /an approved version may only be superseded/,
      );
    });

    test('a rejection says what it was measured against, and a rejected version is final', async () => {
      const w = await seedDeskWorld(env);
      await seedRuleBook(w);
      const p = await submitted(w, await priced(w));

      const silent = await decideScenario({
        actingUserLinkId: w.manager,
        tenantId: w.tenantId,
        scenarioId: p.scenarioId,
        decision: 'rejected',
        reviewedOutputFingerprint: p.fingerprint,
        expectedVersion: p.version,
      });
      assert.equal(silent.outcome, 'invalid', show(silent));

      const rejected = await decideScenario({
        actingUserLinkId: w.manager,
        tenantId: w.tenantId,
        scenarioId: p.scenarioId,
        decision: 'rejected',
        reviewedOutputFingerprint: p.fingerprint,
        expectedVersion: p.version,
        limitReason: 'Below the floor gross the rooftop holds for this model line.',
      });
      assert.equal(rejected.outcome, 'decided', show(rejected));

      await assert.rejects(
        () =>
          fixtureAuthorizationStateWrite(
            'adversarial-bypass-attempt',
            `UPDATE desking_scenarios SET state = 'submitted'
                WHERE tenant_id = $1 AND scenario_id = $2`,
            [w.tenantId, p.scenarioId],
          ),
        /rejected is a final state/,
      );
    });

    test('a second decision on one version is refused, and a replayed one converges', async () => {
      const w = await seedDeskWorld(env);
      await seedRuleBook(w);
      const p = await submitted(w, await priced(w));
      const first = await decideScenario({
        actingUserLinkId: w.manager,
        tenantId: w.tenantId,
        scenarioId: p.scenarioId,
        decision: 'approved',
        reviewedOutputFingerprint: p.fingerprint,
        expectedVersion: p.version,
      });
      assert.equal(first.outcome, 'decided', show(first));

      // THE REPLAY ANSWER COMES BEFORE THE VERSION CHECK: the caller is holding
      // a stale version precisely BECAUSE the first call succeeded.
      const again = await decideScenario({
        actingUserLinkId: w.manager,
        tenantId: w.tenantId,
        scenarioId: p.scenarioId,
        decision: 'approved',
        reviewedOutputFingerprint: p.fingerprint,
        expectedVersion: p.version,
      });
      assert.equal(again.outcome, 'already_decided', show(again));
      assert.equal(
        (again as { approvalId: string }).approvalId,
        (first as { approvalId: string }).approvalId,
      );

      const flipped = await decideScenario({
        actingUserLinkId: w.manager,
        tenantId: w.tenantId,
        scenarioId: p.scenarioId,
        decision: 'rejected',
        reviewedOutputFingerprint: p.fingerprint,
        expectedVersion: p.version,
        limitReason: 'changed my mind',
      });
      assert.equal(flipped.outcome, 'invalid', show(flipped));
      assert.match(String((flipped as { error: string }).error), /already approved/);

      const count = await query(
        `SELECT COUNT(*)::int AS n FROM scenario_approvals WHERE tenant_id = $1`,
        [w.tenantId],
      );
      assert.equal(Number((count.rows[0] as { n: number }).n), 1);
    });

    test('a later revision supersedes its predecessor without changing approved history', async () => {
      const w = await seedDeskWorld(env);
      await seedRuleBook(w);
      const first = await submitted(w, await priced(w));
      const approvedFirst = await decideScenario({
        actingUserLinkId: w.manager,
        tenantId: w.tenantId,
        scenarioId: first.scenarioId,
        decision: 'approved',
        reviewedOutputFingerprint: first.fingerprint,
        expectedVersion: first.version,
      });
      assert.equal(approvedFirst.outcome, 'decided', show(approvedFirst));
      const before = await query(
        `SELECT amount_financed_cents, output_fingerprint FROM desking_scenarios
          WHERE tenant_id = $1 AND scenario_id = $2`,
        [w.tenantId, first.scenarioId],
      );
      const firstFigures = before.rows[0] as Record<string, unknown>;

      // THE CUSTOMER ASKS FOR A BIGGER DOWN PAYMENT: a NEW version, naming the
      // one it supersedes.
      const second = await buildScenario({
        actingUserLinkId: w.seller,
        tenantId: w.tenantId,
        deskingCaseId: first.caseId,
        label: 'More down',
        jurisdiction: JURISDICTION,
        vehiclePriceCents: 4_550_000n,
        tradeAllowanceCents: 1_200_000n,
        tradePayoffCents: 1_450_000n,
        cashDownCents: 600_000n,
        termMonths: 72,
        aprPpm: 74_900n,
        supersedesScenarioId: first.scenarioId,
      });
      assert.equal(second.outcome, 'built', show(second));
      const s2 = (
        second as {
          scenario: {
            scenarioId: string;
            authorizationVersion: number;
            outputFingerprint: string;
            versionNo: number;
          };
        }
      ).scenario;
      assert.equal(s2.versionNo, 2);

      const submitted2 = await submitScenario({
        actingUserLinkId: w.seller,
        tenantId: w.tenantId,
        scenarioId: s2.scenarioId,
        expectedVersion: s2.authorizationVersion,
      });
      assert.equal(submitted2.outcome, 'moved', show(submitted2));
      const decided2 = await decideScenario({
        actingUserLinkId: w.manager,
        tenantId: w.tenantId,
        scenarioId: s2.scenarioId,
        decision: 'approved',
        reviewedOutputFingerprint: s2.outputFingerprint,
        expectedVersion: (submitted2 as { scenario: { authorizationVersion: number } }).scenario
          .authorizationVersion,
      });
      assert.equal(decided2.outcome, 'decided', show(decided2));

      const states = await query(
        `SELECT version_no, state, amount_financed_cents, output_fingerprint
           FROM desking_scenarios WHERE tenant_id = $1 AND desking_case_id = $2
          ORDER BY version_no`,
        [w.tenantId, first.caseId],
      );
      const rows = states.rows as Record<string, unknown>[];
      assert.equal(String(rows[0]?.state), 'superseded');
      assert.equal(String(rows[1]?.state), 'approved');
      assert.equal(
        String(rows[0]?.amount_financed_cents),
        String(firstFigures.amount_financed_cents),
        'the superseded version keeps every figure it carried',
      );
      assert.equal(String(rows[0]?.output_fingerprint), String(firstFigures.output_fingerprint));

      // BOTH DECISIONS SURVIVE. Supersession is not a deletion.
      const decisions = await query(
        `SELECT scenario_version_no, decision FROM scenario_approvals
          WHERE tenant_id = $1 ORDER BY scenario_version_no`,
        [w.tenantId],
      );
      assert.deepEqual(
        decisions.rows.map((r) => Number((r as Record<string, unknown>).scenario_version_no)),
        [1, 2],
      );

      // …and exactly one approved version exists, which the database itself holds.
      const approved = await query(
        `SELECT COUNT(*)::int AS n FROM desking_scenarios
          WHERE tenant_id = $1 AND desking_case_id = $2 AND state = 'approved'`,
        [w.tenantId, first.caseId],
      );
      assert.equal(Number((approved.rows[0] as { n: number }).n), 1);
    });

    test('a version whose expiry passed cannot be approved, and expiry itself is a state', async () => {
      const w = await seedDeskWorld(env);
      await seedRuleBook(w);
      const p = await submitted(
        w,
        await priced(w, {
          expiresAt: '2026-09-02T00:00:00.000Z',
          pricedAt: '2026-09-01T00:00:00.000Z',
        }),
      );
      const late = await decideScenario({
        actingUserLinkId: w.manager,
        tenantId: w.tenantId,
        scenarioId: p.scenarioId,
        decision: 'approved',
        reviewedOutputFingerprint: p.fingerprint,
        expectedVersion: p.version,
        now: '2026-09-03T00:00:00.000Z',
      });
      assert.equal(late.outcome, 'invalid', show(late));
      assert.match(String((late as { error: string }).error), /expired/);

      const expired = await expireScenario({
        actingUserLinkId: w.seller,
        tenantId: w.tenantId,
        scenarioId: p.scenarioId,
        expectedVersion: p.version,
        reason: 'The quote ran out before the customer came back.',
      });
      assert.equal(expired.outcome, 'moved', show(expired));
      const again = await expireScenario({
        actingUserLinkId: w.seller,
        tenantId: w.tenantId,
        scenarioId: p.scenarioId,
        expectedVersion: 999,
      });
      assert.equal(again.outcome, 'already_there', show(again));
    });

    test('a salesperson cannot decide their own deal, and the refusal explains nothing', async () => {
      const w = await seedDeskWorld(env);
      await seedRuleBook(w);
      const p = await submitted(w, await priced(w));
      const bySeller = await decideScenario({
        actingUserLinkId: w.seller,
        tenantId: w.tenantId,
        scenarioId: p.scenarioId,
        decision: 'approved',
        reviewedOutputFingerprint: p.fingerprint,
        expectedVersion: p.version,
      });
      assert.deepEqual(
        bySeller,
        { outcome: 'not_found' },
        'the same answer a scenario they cannot see would give',
      );
      const none = await query(
        `SELECT COUNT(*)::int AS n FROM scenario_approvals WHERE tenant_id = $1`,
        [w.tenantId],
      );
      assert.equal(Number((none.rows[0] as { n: number }).n), 0);
    });

    test('the lifecycle is readable end to end, with every state change attributed', async () => {
      const w = await seedDeskWorld(env);
      await seedRuleBook(w);
      const p = await submitted(w, await priced(w));
      await decideScenario({
        actingUserLinkId: w.manager,
        tenantId: w.tenantId,
        scenarioId: p.scenarioId,
        decision: 'approved',
        reviewedOutputFingerprint: p.fingerprint,
        expectedVersion: p.version,
      });
      const detail = await scenarioDetail(w.tenantId, w.manager, p.scenarioId);
      assert.ok(detail !== null);
      assert.deepEqual(
        detail.history.map((h) => `${h.fromState}->${h.toState}`),
        ['none->draft', 'draft->submitted', 'submitted->approved'],
      );
      assert.equal(detail.decision?.decision, 'approved');
      assert.equal(detail.decision?.decidedByUserLinkId, w.manager);
      assert.ok(detail.lines.length > 0, 'the figures are itemised');
      assert.ok(detail.rules.length > 0, 'and each names the rule it came from');
      for (const line of detail.lines) assert.match(line.amount, /^-?\d+\.\d{2}$/);
    });

    test('the board reconciles the floor and invents no gross or sale fact', async () => {
      const w = await seedDeskWorld(env);
      await seedRuleBook(w);
      const p = await priced(w);

      // A trade with a quotation behind it, so the variance is a real figure.
      const appraised = await recordAppraisal({
        actingUserLinkId: w.seller,
        tenantId: w.tenantId,
        deskingCaseId: p.caseId,
        vin: '2T1BURHE0JC014729',
        modelYear: 2018,
        make: 'Toyota',
        model: 'Corolla',
        evidence: tradeEvidence() as never,
      });
      assert.equal(appraised.outcome, 'recorded', show(appraised));
      await recordSourceQuotation({
        actingUserLinkId: w.seller,
        tenantId: w.tenantId,
        appraisalId: (appraised as { appraisal: { appraisalId: string } }).appraisal.appraisalId,
        providerCode: 'book_sim',
        providerKind: 'deterministic_simulator',
        availability: 'quoted',
        quotedValueCents: 1_100_000n,
        currency: 'USD',
      });
      await submitScenario({
        actingUserLinkId: w.seller,
        tenantId: w.tenantId,
        scenarioId: p.scenarioId,
        expectedVersion: p.version,
      });

      const board = await deskBoard(w.tenantId, w.manager);
      assert.equal(board.rows.length, 1, show(board.rows));
      const row = board.rows[0];
      assert.ok(row !== undefined);
      assert.equal(row.pendingApproval, true, 'waiting on a decision');
      assert.equal(board.awaitingApproval, 1);
      assert.equal(row.versions, 1);
      assert.equal(row.latestState, 'submitted');
      // Allowance 12,000.00 priced against a 11,000.00 quotation.
      assert.equal(row.appraisalVarianceCents, 100_000n);
      assert.ok(row.oldestSourceAt !== null, 'source freshness is readable');
      assert.deepEqual(row.exceptions, ['waiting on a decision']);

      // WHAT THIS PHASE STILL DOES NOT KNOW, said rather than computed.
      for (const [name, value] of Object.entries(board.notYetAvailable)) {
        assert.equal(value, 'NOT_YET_AVAILABLE', `${name} must not carry a figure`);
      }
      const money = JSON.stringify(board.notYetAvailable);
      assert.match(money, /gross/);
      assert.match(money, /revenue/);
      assert.match(money, /commission/);

      // A salesperson at another rooftop sees an empty board rather than a refusal.
      const foreign = await deskBoard(w.tenantId, w.foreignSeller);
      assert.deepEqual(foreign.rows, []);
    });

    /**
     * THE BACKSTOP KEYS, WITH EVERY SERVICE STEPPED ROUND.
     *
     * Five of this phase's guarantees are keys the services check FIRST — the
     * desk file per fact, the appraisal per file, one approved version per file,
     * one decision per version. A probe that goes through the service therefore
     * proves the service, and a control-mutation runner that dropped the key
     * would watch every test still pass. This one writes the duplicate rows
     * DIRECTLY, so each key is what refuses, by name.
     */
    test('the backstop keys refuse duplicates with every service stepped round', async () => {
      const w = await seedDeskWorld(env);
      await seedRuleBook(w);
      const p = await submitted(w, await priced(w));
      const appraised = await recordAppraisal({
        actingUserLinkId: w.seller,
        tenantId: w.tenantId,
        deskingCaseId: p.caseId,
        vin: '2T1BURHE0JC014729',
        modelYear: 2018,
        make: 'Toyota',
        model: 'Corolla',
        evidence: tradeEvidence() as never,
      });
      assert.equal(appraised.outcome, 'recorded', show(appraised));
      const decided = await decideScenario({
        actingUserLinkId: w.manager,
        tenantId: w.tenantId,
        scenarioId: p.scenarioId,
        decision: 'approved',
        reviewedOutputFingerprint: p.fingerprint,
        expectedVersion: p.version,
      });
      assert.equal(decided.outcome, 'decided', show(decided));

      // ONE DESK FILE PER FACT, AND PER OPPORTUNITY.
      await assert.rejects(
        () =>
          fixtureAuthorizationStateWrite(
            'adversarial-bypass-attempt',
            `INSERT INTO desking_cases
                 (tenant_id, rooftop_id, opportunity_id, party_id, stock_item_id,
                  desking_handoff_id, opened_by_user_link_id)
               SELECT tenant_id, rooftop_id, opportunity_id, party_id, stock_item_id,
                      desking_handoff_id, opened_by_user_link_id
                 FROM desking_cases WHERE tenant_id = $1`,
            [w.tenantId],
          ),
        /duplicate key value|unique constraint/i,
        'a second desk file on one fact',
      );

      // ONE APPRAISAL PER FILE.
      await assert.rejects(
        () =>
          fixtureAuthorizationStateWrite(
            'adversarial-bypass-attempt',
            `INSERT INTO appraisals
                 (tenant_id, rooftop_id, desking_case_id, vin, model_year, make, model,
                  created_by_user_link_id)
               SELECT tenant_id, rooftop_id, desking_case_id, vin, model_year, make, model,
                      created_by_user_link_id
                 FROM appraisals WHERE tenant_id = $1`,
            [w.tenantId],
          ),
        /duplicate key value|unique constraint/i,
        'a second trade on one file',
      );

      // ONE APPROVED VERSION PER FILE. The partial index is the whole rule.
      await assert.rejects(
        () =>
          fixtureAuthorizationStateWrite(
            'adversarial-bypass-attempt',
            `INSERT INTO desking_scenarios
                 (tenant_id, rooftop_id, desking_case_id, version_no, label, state,
                  vehicle_price_cents, trade_allowance_cents, trade_payoff_cents, cash_down_cents,
                  currency, jurisdiction, priced_at, trade_equity_cents, taxable_amount_cents,
                  tax_total_cents, fee_total_cents, incentive_total_cents, amount_financed_cents,
                  input_fingerprint, output_fingerprint, built_by_user_link_id)
               SELECT tenant_id, rooftop_id, desking_case_id, version_no + 50, label, 'approved',
                      vehicle_price_cents, trade_allowance_cents, trade_payoff_cents, cash_down_cents,
                      currency, jurisdiction, priced_at, trade_equity_cents, taxable_amount_cents,
                      tax_total_cents, fee_total_cents, incentive_total_cents, amount_financed_cents,
                      input_fingerprint, repeat('b', 64), built_by_user_link_id
                 FROM desking_scenarios WHERE tenant_id = $1 AND state = 'approved'`,
            [w.tenantId],
          ),
        /uq_scenario_one_approved_per_case|duplicate key value/i,
        'a second approved version on one file',
      );

      // ONE DECISION PER VERSION.
      await assert.rejects(
        () =>
          query(
            `INSERT INTO scenario_approvals
               (tenant_id, desking_case_id, scenario_id, scenario_version_no, decision,
                reviewed_output_fingerprint, decided_by_user_link_id)
             SELECT tenant_id, desking_case_id, scenario_id, scenario_version_no, decision,
                    reviewed_output_fingerprint, decided_by_user_link_id
               FROM scenario_approvals WHERE tenant_id = $1`,
            [w.tenantId],
          ),
        /duplicate key value|unique constraint/i,
        'a second decision on one version',
      );
    });

    test('a file with no appraisal and no version says so, in words a manager can act on', async () => {
      const w = await seedDeskWorld(env);
      const opened = await openDeskingCase({
        actingUserLinkId: w.seller,
        tenantId: w.tenantId,
        deskingHandoffId: w.deskingHandoffId,
      });
      assert.equal(opened.outcome, 'opened', show(opened));
      const board = await deskBoard(w.tenantId, w.manager);
      assert.deepEqual(board.rows[0]?.exceptions, ['no appraisal recorded', 'no scenario built']);
      assert.equal(board.openCases, 1);
      assert.equal(board.approvedCases, 0);
    });
  },
);
