import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  applyRate,
  canonicalize,
  computeScenario,
  fingerprint,
  formatCents,
  monthlyPayment,
  roundDiv,
  type ResolvedRule,
  type ScenarioInputs,
} from '@dealer/desking';

/**
 * ROW 3 — DETERMINISTIC SCENARIOS, proved where determinism either holds or
 * does not: in the arithmetic itself.
 *
 * These tests need no database on purpose. The calculator is a pure function,
 * so the property the order asks for — "identical inputs reproduce identical
 * outputs" — is checkable directly, and a battery that could only check it
 * through four tables would be proving the tables.
 */
describe('desking: the arithmetic is integer, and it is deterministic (FBL-120 Row 3)', () => {
  const RULES: ResolvedRule[] = [
    {
      ruleId: '11111111-1111-4111-8111-111111111111',
      ruleKind: 'policy',
      ruleCode: 'trade_tax_credit',
      label: 'Trade allowance reduces the taxable base',
      source: 'Colorado Revised Statutes §39-26-113(5)',
      jurisdiction: 'US-CO',
      rooftopScoped: false,
      version: 1,
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      effectiveTo: null,
      basis: 'rate_ppm',
      ratePpm: 1_000_000n,
      amountCents: null,
      appliesTo: 'taxable_amount',
    },
    {
      ruleId: '22222222-2222-4222-8222-222222222222',
      ruleKind: 'tax',
      ruleCode: 'state_sales_tax',
      label: 'State sales tax',
      source: 'Colorado Revised Statutes §39-26-104',
      jurisdiction: 'US-CO',
      rooftopScoped: false,
      version: 1,
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      effectiveTo: null,
      basis: 'rate_ppm',
      ratePpm: 29_000n,
      amountCents: null,
      appliesTo: 'taxable_amount',
    },
    {
      ruleId: '33333333-3333-4333-8333-333333333333',
      ruleKind: 'fee',
      ruleCode: 'documentation_fee',
      label: 'Documentation fee',
      source: 'Rooftop pricing policy 2026-01',
      jurisdiction: 'US-CO',
      rooftopScoped: false,
      version: 1,
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      effectiveTo: null,
      basis: 'flat_amount',
      ratePpm: null,
      amountCents: 69_900n,
      appliesTo: 'vehicle_price',
    },
  ];

  const INPUTS: ScenarioInputs = {
    vehiclePriceCents: 4_550_000n,
    tradeAllowanceCents: 1_200_000n,
    tradePayoffCents: 1_450_000n,
    cashDownCents: 300_000n,
    termMonths: 72,
    aprPpm: 74_900n,
    currency: 'USD',
    jurisdiction: 'US-CO',
    pricedAt: '2026-09-01T15:04:05.000Z',
  };

  test('the same inputs and the same rule book reproduce the same figures and the same digests', () => {
    const first = computeScenario(INPUTS, RULES);
    const second = computeScenario(INPUTS, RULES);
    assert.equal(first.outputFingerprint, second.outputFingerprint);
    assert.equal(first.inputFingerprint, second.inputFingerprint);
    assert.equal(first.amountFinancedCents, second.amountFinancedCents);
    assert.equal(first.monthlyPaymentCents, second.monthlyPaymentCents);
    assert.match(first.outputFingerprint, /^[0-9a-f]{64}$/);
  });

  test('the rule book may arrive in any order and the figures do not move', () => {
    const forwards = computeScenario(INPUTS, RULES);
    const backwards = computeScenario(INPUTS, [...RULES].reverse());
    const shuffled = computeScenario(INPUTS, [
      RULES[1] as ResolvedRule,
      RULES[2] as ResolvedRule,
      RULES[0] as ResolvedRule,
    ]);
    assert.equal(backwards.outputFingerprint, forwards.outputFingerprint);
    assert.equal(shuffled.outputFingerprint, forwards.outputFingerprint);
  });

  test('every figure can be checked by hand, in whole cents', () => {
    const c = computeScenario(INPUTS, RULES);
    // Equity is allowance less payoff, and it is NEGATIVE here on purpose:
    // the customer owes more than the trade is worth.
    assert.equal(c.tradeEquityCents, -250_000n);
    // The credit is taken on the ALLOWANCE, in full, so the base is
    // 45,500.00 − 12,000.00.
    assert.equal(c.taxableAmountCents, 3_350_000n);
    // 2.9% of 33,500.00 = 971.50.
    assert.equal(c.taxTotalCents, 97_150n);
    assert.equal(c.feeTotalCents, 69_900n);
    assert.equal(c.incentiveTotalCents, 0n);
    // 45,500.00 + 971.50 + 699.00 − 3,000.00 − (−2,500.00). The negative
    // equity ADDS: the customer's shortfall on the old car is financed too.
    assert.equal(c.amountFinancedCents, 4_667_050n);
    assert.equal(formatCents(c.amountFinancedCents), '46670.50');
  });

  test('a rule that applies to the total sees the total, and only after the first pass', () => {
    const withTotalFee: ResolvedRule[] = [
      ...RULES,
      {
        ruleId: '44444444-4444-4444-8444-444444444444',
        ruleKind: 'fee',
        ruleCode: 'processing_fee',
        label: 'Processing fee',
        source: 'Rooftop pricing policy 2026-01',
        jurisdiction: 'US-CO',
        rooftopScoped: false,
        version: 1,
        effectiveFrom: '2026-01-01T00:00:00.000Z',
        effectiveTo: null,
        basis: 'rate_ppm',
        ratePpm: 10_000n,
        amountCents: null,
        appliesTo: 'total',
      },
    ];
    const c = computeScenario(INPUTS, withTotalFee);
    // 1% of (45,500.00 + 971.50 + 699.00) = 471.705, which rounds half away
    // from zero to 471.71 — one rounding, on the line, as the rule says.
    assert.equal(c.feeTotalCents, 69_900n + 47_171n);
  });

  test('an incentive takes money off, and the rule book still records it as a positive magnitude', () => {
    const withIncentive: ResolvedRule[] = [
      ...RULES,
      {
        ruleId: '55555555-5555-4555-8555-555555555555',
        ruleKind: 'incentive',
        ruleCode: 'manufacturer_rebate',
        label: 'Manufacturer rebate',
        source: 'Bulletin 2026-08',
        jurisdiction: 'US-CO',
        rooftopScoped: false,
        version: 1,
        effectiveFrom: '2026-01-01T00:00:00.000Z',
        effectiveTo: null,
        basis: 'flat_amount',
        ratePpm: null,
        amountCents: 150_000n,
        appliesTo: 'vehicle_price',
      },
    ];
    const c = computeScenario(INPUTS, withIncentive);
    assert.equal(c.incentiveTotalCents, 150_000n);
    const line = c.lines.find((l) => l.lineCode === 'manufacturer_rebate');
    assert.ok(line !== undefined);
    assert.equal(line.amountCents, -150_000n, 'the LINE is signed; the rule book is not');
    const application = c.applications.find((a) => a.ruleCode === 'manufacturer_rebate');
    assert.equal(application?.resolvedAmountCents, 150_000n);
  });

  test('a different input changes the input digest, and a rule version change changes it too', () => {
    const base = computeScenario(INPUTS, RULES);
    const dearer = computeScenario({ ...INPUTS, vehiclePriceCents: 4_550_001n }, RULES);
    assert.notEqual(dearer.inputFingerprint, base.inputFingerprint);

    const reversioned = computeScenario(INPUTS, [
      RULES[0] as ResolvedRule,
      { ...(RULES[1] as ResolvedRule), version: 2 },
      RULES[2] as ResolvedRule,
    ]);
    assert.notEqual(
      reversioned.inputFingerprint,
      base.inputFingerprint,
      'the digest covers WHICH version of each rule was applied, not only the numbers',
    );
    assert.equal(
      reversioned.outputFingerprint,
      base.outputFingerprint,
      'and the figures themselves are unchanged, because the rate did not change',
    );
  });

  test('rounding is half away from zero, once per line and never on an intermediate', () => {
    assert.equal(roundDiv(5n, 2n), 3n);
    assert.equal(roundDiv(-5n, 2n), -3n);
    assert.equal(roundDiv(4n, 2n), 2n);
    assert.equal(roundDiv(1n, 3n), 0n);
    // 2.9% of 33,333.33 = 966.6666…, which is 966.67 and not 966.66.
    assert.equal(applyRate(3_333_333n, 29_000n), 96_667n);
    assert.throws(() => roundDiv(1n, 0n), RangeError);
  });

  test('the monthly figure is the annuity formula, and a zero rate is answered rather than divided by', () => {
    // 46,170.50 over 72 months at 7.49%. The exact annuity value is
    // 79806.9574… cents, so the answer is 798.07 — checked against a
    // 50-digit decimal evaluation of P·r·(1+r)^n / ((1+r)^n − 1), not against
    // whatever this implementation happened to return.
    assert.equal(monthlyPayment(4_617_050n, 72, 74_900n), 79_807n);
    // Twice, because that is the whole claim.
    assert.equal(monthlyPayment(4_617_050n, 72, 74_900n), 79_807n);
    assert.equal(monthlyPayment(1_200_000n, 24, 0n), 50_000n);
    assert.equal(monthlyPayment(0n, 24, 74_900n), 0n);
    assert.throws(() => monthlyPayment(100n, 0, 0n), RangeError);
    assert.throws(() => monthlyPayment(100n, 121, 0n), RangeError);
  });

  test('no monthly figure is invented when the desk did not give a term and a rate', () => {
    const cash = computeScenario({ ...INPUTS, termMonths: null, aprPpm: null }, RULES);
    assert.equal(cash.monthlyPaymentCents, null);
  });

  test('the canonical form sorts keys and writes bigints as strings, so a digest is portable', () => {
    assert.equal(canonicalize({ b: 1n, a: 'x' }), '{"a":"x","b":"1"}');
    assert.equal(canonicalize({ a: 'x', b: 1n }), '{"a":"x","b":"1"}');
    assert.equal(fingerprint({ a: 1n }), fingerprint({ a: 1n }));
    assert.notEqual(fingerprint({ a: 1n }), fingerprint({ a: 2n }));
    assert.equal(canonicalize({ a: undefined, b: 2 }), '{"b":2}');
    assert.throws(() => canonicalize(Number.POSITIVE_INFINITY), TypeError);
  });

  test('an empty rule book prices the car and nothing else, and says so in the lines', () => {
    const c = computeScenario(INPUTS, []);
    assert.equal(c.taxTotalCents, 0n);
    assert.equal(c.feeTotalCents, 0n);
    assert.equal(c.taxableAmountCents, INPUTS.vehiclePriceCents, 'no credit rule, no credit');
    assert.deepEqual(
      c.lines.map((l) => l.lineCode),
      ['vehicle_price', 'trade_equity', 'cash_down'],
    );
    assert.equal(c.applications.length, 0);
  });
});
