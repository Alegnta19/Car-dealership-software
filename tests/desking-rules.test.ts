import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';

import { closePool, query } from '@dealer/database';
import { buildScenario, openDeskingCase, recordRule, resolveRuleBook } from '@dealer/desking';
import {
  resetDatabase,
  skipIntegration,
  startIdentityTestEnv,
  type IdentityTestEnv,
} from '@dealer/test-kit';

import {
  JURISDICTION,
  show,
  seedDeskWorld,
  seedRuleBook,
  resetVins,
  type DeskWorld,
} from './desking-world';

/**
 * ROW 4 — RULE AND SOURCE TRUTH.
 *
 * "Every tax, fee, incentive, valuation, and policy input names its source,
 * jurisdiction or rooftop scope, effective interval, and version. Expired,
 * overlapping, missing, or inapplicable rules refuse or remain
 * NOT_YET_AVAILABLE; deterministic simulators may stand in for uncertified
 * providers without pretending to be live data."
 *
 * OVERLAP IS THE DATABASE'S ANSWER, not the service's, and this battery proves
 * it by writing the second rule straight at the table. A rule book that can
 * answer twice cannot say what the tax is, and the place to refuse that is the
 * only place where the answer is still cheap: the write.
 */
describe(
  'desking: the rule book answers once, or refuses (FBL-120 Row 4)',
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

    async function openFile(w: DeskWorld): Promise<string> {
      const opened = await openDeskingCase({
        actingUserLinkId: w.seller,
        tenantId: w.tenantId,
        deskingHandoffId: w.deskingHandoffId,
      });
      return (opened as { deskingCase: { deskingCaseId: string } }).deskingCase.deskingCaseId;
    }

    test('every rule names its source, scope, interval and version', async () => {
      const w = await seedDeskWorld(env);
      await seedRuleBook(w);
      const book = await resolveRuleBook({
        tenantId: w.tenantId,
        jurisdiction: JURISDICTION,
        rooftopId: w.rooftopId,
        at: '2026-09-01T12:00:00.000Z',
      });
      assert.equal(book.rules.length, 3, show(book.rules));
      for (const rule of book.rules) {
        assert.ok(rule.source.length > 0, `${rule.ruleCode} names no source`);
        assert.equal(rule.jurisdiction, JURISDICTION);
        assert.ok(rule.version >= 1);
        assert.ok(rule.effectiveFrom.length > 0);
        assert.equal(typeof rule.rooftopScoped, 'boolean');
      }
      assert.deepEqual(book.missing, []);
      assert.deepEqual(book.expired, []);
    });

    test('two rules of the same kind and code cannot both be in force over one instant', async () => {
      const w = await seedDeskWorld(env);
      await seedRuleBook(w);

      // THROUGH THE SERVICE: the refusal is a business outcome, not a 500.
      const overlapping = await recordRule({
        actingUserLinkId: w.manager,
        tenantId: w.tenantId,
        ruleKind: 'tax',
        ruleCode: 'state_sales_tax',
        label: 'State sales tax, raised',
        source: 'Colorado Revised Statutes §39-26-104 (2026 amendment)',
        jurisdiction: JURISDICTION,
        rooftopId: null,
        effectiveFrom: '2026-06-01T00:00:00.000Z',
        effectiveTo: null,
        basis: 'rate_ppm',
        ratePpm: 31_000n,
        amountCents: null,
        appliesTo: 'taxable_amount',
      });
      assert.equal(overlapping.outcome, 'overlaps', show(overlapping));
      assert.match(String((overlapping as { error: string }).error), /already in force/);

      // ROUND THE SERVICE: the exclusion constraint is what actually holds.
      await assert.rejects(
        () =>
          query(
            `INSERT INTO desking_rules
               (tenant_id, rule_kind, rule_code, label, source, jurisdiction, rooftop_id, version,
                effective_from, effective_to, basis, rate_ppm, applies_to, recorded_by_user_link_id)
             VALUES ($1, 'tax', 'state_sales_tax', 'Sneaked in', 'nobody', $2, NULL, 99,
                     '2026-06-01T00:00:00Z', NULL, 'rate_ppm', 31000, 'taxable_amount', $3)`,
            [w.tenantId, JURISDICTION, w.manager],
          ),
        /uq_desking_rules_no_overlap/,
      );
    });

    test('a rule that starts where the last one stopped is accepted, and only one is in force', async () => {
      const w = await seedDeskWorld(env);
      const closed = await recordRule({
        actingUserLinkId: w.manager,
        tenantId: w.tenantId,
        ruleKind: 'tax',
        ruleCode: 'state_sales_tax',
        label: 'State sales tax, until June',
        source: 'Colorado Revised Statutes §39-26-104',
        jurisdiction: JURISDICTION,
        rooftopId: null,
        effectiveFrom: '2026-01-01T00:00:00.000Z',
        effectiveTo: '2026-06-01T00:00:00.000Z',
        basis: 'rate_ppm',
        ratePpm: 29_000n,
        amountCents: null,
        appliesTo: 'taxable_amount',
      });
      assert.equal(closed.outcome, 'recorded', show(closed));
      const next = await recordRule({
        actingUserLinkId: w.manager,
        tenantId: w.tenantId,
        ruleKind: 'tax',
        ruleCode: 'state_sales_tax',
        label: 'State sales tax, from June',
        source: 'Colorado Revised Statutes §39-26-104 (2026 amendment)',
        jurisdiction: JURISDICTION,
        rooftopId: null,
        effectiveFrom: '2026-06-01T00:00:00.000Z',
        effectiveTo: null,
        basis: 'rate_ppm',
        ratePpm: 31_000n,
        amountCents: null,
        appliesTo: 'taxable_amount',
      });
      assert.equal(next.outcome, 'recorded', show(next));
      assert.equal((next as { rule: { version: number } }).rule.version, 2, 'versions count up');

      const inMay = await resolveRuleBook({
        tenantId: w.tenantId,
        jurisdiction: JURISDICTION,
        rooftopId: w.rooftopId,
        at: '2026-05-01T00:00:00.000Z',
      });
      const inJuly = await resolveRuleBook({
        tenantId: w.tenantId,
        jurisdiction: JURISDICTION,
        rooftopId: w.rooftopId,
        at: '2026-07-01T00:00:00.000Z',
      });
      assert.equal(inMay.rules.length, 1);
      assert.equal(inMay.rules[0]?.ratePpm, 29_000n);
      assert.equal(inJuly.rules.length, 1);
      assert.equal(inJuly.rules[0]?.ratePpm, 31_000n);
    });

    test("a rooftop's own rule beats the tenant-wide one, and the audit says which won", async () => {
      const w = await seedDeskWorld(env);
      await seedRuleBook(w);
      const local = await recordRule({
        actingUserLinkId: w.manager,
        tenantId: w.tenantId,
        ruleKind: 'fee',
        ruleCode: 'documentation_fee',
        label: 'Documentation fee, Riverside',
        source: 'Riverside rooftop policy 2026-03',
        jurisdiction: JURISDICTION,
        rooftopId: w.rooftopId,
        effectiveFrom: '2026-01-01T00:00:00.000Z',
        effectiveTo: null,
        basis: 'flat_amount',
        ratePpm: null,
        amountCents: 49_900n,
        appliesTo: 'vehicle_price',
      });
      assert.equal(local.outcome, 'recorded', show(local));

      const here = await resolveRuleBook({
        tenantId: w.tenantId,
        jurisdiction: JURISDICTION,
        rooftopId: w.rooftopId,
        at: '2026-09-01T12:00:00.000Z',
      });
      const fee = here.rules.find((r) => r.ruleCode === 'documentation_fee');
      assert.equal(fee?.amountCents, 49_900n, "the rooftop's own figure");
      assert.equal(fee?.rooftopScoped, true);

      const elsewhere = await resolveRuleBook({
        tenantId: w.tenantId,
        jurisdiction: JURISDICTION,
        rooftopId: w.otherRooftopId,
        at: '2026-09-01T12:00:00.000Z',
      });
      const other = elsewhere.rules.find((r) => r.ruleCode === 'documentation_fee');
      assert.equal(other?.amountCents, 69_900n, 'the tenant default, at the other rooftop');
      assert.equal(other?.rooftopScoped, false);
    });

    test('a jurisdiction nobody configured refuses the pricing rather than pricing it at zero', async () => {
      const w = await seedDeskWorld(env);
      const caseId = await openFile(w);
      const built = await buildScenario({
        actingUserLinkId: w.seller,
        tenantId: w.tenantId,
        deskingCaseId: caseId,
        label: 'First pencil',
        jurisdiction: JURISDICTION,
        vehiclePriceCents: 4_550_000n,
      });
      assert.equal(built.outcome, 'rules_unavailable', show(built));
      assert.deepEqual((built as { missing: readonly string[] }).missing, ['tax']);
      assert.deepEqual((built as { expired: readonly string[] }).expired, []);

      const nothing = await query(
        `SELECT COUNT(*)::int AS n FROM desking_scenarios WHERE tenant_id = $1`,
        [w.tenantId],
      );
      assert.equal(Number((nothing.rows[0] as { n: number }).n), 0, 'and nothing was written');
    });

    test('a rule book that ran out is a different answer from one that was never written', async () => {
      const w = await seedDeskWorld(env);
      const caseId = await openFile(w);
      const lapsed = await recordRule({
        actingUserLinkId: w.manager,
        tenantId: w.tenantId,
        ruleKind: 'tax',
        ruleCode: 'state_sales_tax',
        label: 'State sales tax, expired schedule',
        source: 'Colorado Revised Statutes §39-26-104',
        jurisdiction: JURISDICTION,
        rooftopId: null,
        effectiveFrom: '2026-01-01T00:00:00.000Z',
        effectiveTo: '2026-02-01T00:00:00.000Z',
        basis: 'rate_ppm',
        ratePpm: 29_000n,
        amountCents: null,
        appliesTo: 'taxable_amount',
      });
      assert.equal(lapsed.outcome, 'recorded', show(lapsed));

      const built = await buildScenario({
        actingUserLinkId: w.seller,
        tenantId: w.tenantId,
        deskingCaseId: caseId,
        label: 'First pencil',
        jurisdiction: JURISDICTION,
        vehiclePriceCents: 4_550_000n,
        pricedAt: '2026-09-01T12:00:00.000Z',
      });
      assert.equal(built.outcome, 'rules_unavailable', show(built));
      assert.deepEqual(
        (built as { expired: readonly string[] }).expired,
        ['tax'],
        'EXPIRED, not missing — a rooftop whose configuration went stale is not one nobody configured',
      );
      assert.deepEqual((built as { missing: readonly string[] }).missing, []);
    });

    test('what a version was priced under is copied beside it, so a later edit cannot rewrite it', async () => {
      const w = await seedDeskWorld(env);
      await seedRuleBook(w);
      const caseId = await openFile(w);
      const built = await buildScenario({
        actingUserLinkId: w.seller,
        tenantId: w.tenantId,
        deskingCaseId: caseId,
        label: 'First pencil',
        jurisdiction: JURISDICTION,
        vehiclePriceCents: 4_550_000n,
        tradeAllowanceCents: 1_200_000n,
        pricedAt: '2026-09-01T12:00:00.000Z',
      });
      assert.equal(built.outcome, 'built', show(built));
      const scenarioId = (built as { scenario: { scenarioId: string } }).scenario.scenarioId;

      const applications = await query(
        `SELECT rule_kind, rule_code, rule_version, source, jurisdiction, rooftop_scoped,
                effective_from, resolved_amount_cents
           FROM scenario_rule_applications WHERE tenant_id = $1 AND scenario_id = $2
          ORDER BY rule_kind, rule_code`,
        [w.tenantId, scenarioId],
      );
      assert.equal(applications.rows.length, 3, show(applications.rows));
      for (const row of applications.rows as Record<string, unknown>[]) {
        assert.ok(String(row.source).length > 0, 'every application names its source');
        assert.equal(String(row.jurisdiction), JURISDICTION);
        assert.equal(Number(row.rule_version), 1);
        assert.ok(row.effective_from !== null);
      }

      // The rule book moves on; the priced version does not.
      const superseded = await recordRule({
        actingUserLinkId: w.manager,
        tenantId: w.tenantId,
        ruleKind: 'fee',
        ruleCode: 'documentation_fee',
        label: 'Documentation fee, raised',
        source: 'Rooftop pricing policy 2026-09',
        jurisdiction: JURISDICTION,
        rooftopId: w.rooftopId,
        effectiveFrom: '2026-09-02T00:00:00.000Z',
        effectiveTo: null,
        basis: 'flat_amount',
        ratePpm: null,
        amountCents: 99_900n,
        appliesTo: 'vehicle_price',
      });
      assert.equal(superseded.outcome, 'recorded', show(superseded));

      const after = await query(
        `SELECT fee_total_cents FROM desking_scenarios WHERE tenant_id = $1 AND scenario_id = $2`,
        [w.tenantId, scenarioId],
      );
      assert.equal(
        String((after.rows[0] as Record<string, unknown>).fee_total_cents),
        '69900',
        'the version keeps the fee it was priced with',
      );
    });
  },
);
