/**
 * THE DESK CALCULATOR — one pure function, and the order it works in.
 *
 * Row 3 of Master Blueprint Version 3.1 §14.3 Part B: "Calculate each scenario
 * from explicit versioned inputs using fixed decimal and currency rules …
 * identical inputs reproduce identical outputs." This module is where that is
 * true or not true. It touches no database, reads no clock and holds no state:
 * the inputs and the resolved rule book go in, the figures and their digests
 * come out, and `tests/desking-scenarios.test.ts` runs it twice on the same
 * arguments and demands the same 64 hex characters.
 *
 * THE ORDER OF OPERATIONS IS FIXED AND WRITTEN DOWN, because "what is taxed"
 * is the question every desk argues about and a calculator that answers it
 * differently on Tuesday is worse than one that answers it wrongly every day.
 *
 *   1. TRADE EQUITY = allowance − payoff. It may be NEGATIVE, and negative
 *      equity is not an error: it is a customer who owes more than the car is
 *      worth, which is most of them, and it increases the amount financed.
 *   2. THE TAXABLE BASE. Whether a trade reduces it is jurisdiction policy, not
 *      arithmetic, so it arrives as a `policy` rule with the code
 *      `trade_tax_credit` whose rate is the creditable FRACTION of the trade
 *      ALLOWANCE — 1_000_000 ppm for a full credit, 0 for none, and no rule at
 *      all for a jurisdiction that has never heard of one. The credit is taken
 *      on the allowance rather than on the equity because that is what the
 *      statutes that grant it say; the payoff is the customer's debt, not the
 *      dealer's purchase.
 *   3. THE FIRST PASS: every tax and fee written against `vehicle_price` or
 *      `taxable_amount`.
 *   4. THE SUBTOTAL: vehicle price + those taxes + those fees.
 *   5. THE SECOND PASS: everything written against `total`, computed on that
 *      subtotal — a percentage doc fee, a rate-based incentive — so a rule that
 *      depends on the total has a total to depend on, and the two passes cannot
 *      chase each other.
 *   6. THE AMOUNT FINANCED = price + tax + fee − incentive − cash down − trade
 *      equity.
 *   7. THE MONTHLY FIGURE, only when a term and a rate were both given.
 *
 * `valuation` rules are resolved for the appraisal, not for the deal, so they
 * are not applied here. A `policy` rule that changed the taxable base IS
 * recorded as an application, because a base nobody can explain is a figure
 * nobody can approve.
 */
import { PPM, applyRate, fingerprint, monthlyPayment } from './money';

export type RuleKind = 'tax' | 'fee' | 'incentive' | 'valuation' | 'policy';
export type RuleBasis = 'rate_ppm' | 'flat_amount';
export type RuleTarget = 'vehicle_price' | 'taxable_amount' | 'total';
export type LineKind = 'price' | 'trade' | 'tax' | 'fee' | 'incentive' | 'down_payment';

/** A rule as the rule book resolved it, with everything an audit needs. */
export interface ResolvedRule {
  readonly ruleId: string;
  readonly ruleKind: RuleKind;
  readonly ruleCode: string;
  readonly label: string;
  readonly source: string;
  readonly jurisdiction: string;
  readonly rooftopScoped: boolean;
  readonly version: number;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly basis: RuleBasis;
  readonly ratePpm: bigint | null;
  readonly amountCents: bigint | null;
  readonly appliesTo: RuleTarget;
}

export interface ScenarioInputs {
  readonly vehiclePriceCents: bigint;
  readonly tradeAllowanceCents: bigint;
  readonly tradePayoffCents: bigint;
  readonly cashDownCents: bigint;
  readonly termMonths: number | null;
  readonly aprPpm: bigint | null;
  readonly currency: string;
  readonly jurisdiction: string;
  /** The instant the rule book was read at, as an ISO-8601 string. */
  readonly pricedAt: string;
}

export interface ComputedLine {
  readonly sequenceNo: number;
  readonly kind: LineKind;
  readonly lineCode: string;
  readonly label: string;
  /** SIGNED: what this line does to the balance. */
  readonly amountCents: bigint;
  readonly ruleId: string | null;
  readonly ruleVersion: number | null;
}

export interface RuleApplication {
  readonly ruleId: string;
  readonly ruleKind: RuleKind;
  readonly ruleCode: string;
  readonly ruleVersion: number;
  readonly source: string;
  readonly jurisdiction: string;
  readonly rooftopScoped: boolean;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly resolvedAmountCents: bigint;
}

export interface ComputedScenario {
  readonly tradeEquityCents: bigint;
  readonly taxableAmountCents: bigint;
  readonly taxTotalCents: bigint;
  readonly feeTotalCents: bigint;
  readonly incentiveTotalCents: bigint;
  readonly amountFinancedCents: bigint;
  readonly monthlyPaymentCents: bigint | null;
  readonly lines: readonly ComputedLine[];
  readonly applications: readonly RuleApplication[];
  readonly inputFingerprint: string;
  readonly outputFingerprint: string;
}

const TRADE_TAX_CREDIT = 'trade_tax_credit';

function magnitude(rule: ResolvedRule, base: bigint): bigint {
  if (rule.basis === 'flat_amount') return rule.amountCents ?? 0n;
  return applyRate(base, rule.ratePpm ?? 0n);
}

/**
 * Rules are applied in a FIXED order regardless of the order they were handed
 * over in, so two callers who read the same rule book in different orders get
 * the same figures. Kind first (the passes above depend on it), then code, then
 * version — all three, because a tie broken by chance is not determinism.
 */
function ordered(rules: readonly ResolvedRule[]): ResolvedRule[] {
  const rank: Record<RuleKind, number> = { policy: 0, tax: 1, fee: 2, incentive: 3, valuation: 4 };
  return [...rules].sort(
    (a, b) =>
      rank[a.ruleKind] - rank[b.ruleKind] ||
      (a.ruleCode < b.ruleCode ? -1 : a.ruleCode > b.ruleCode ? 1 : 0) ||
      a.version - b.version,
  );
}

export function computeScenario(
  inputs: ScenarioInputs,
  rules: readonly ResolvedRule[],
): ComputedScenario {
  const book = ordered(rules);
  const lines: ComputedLine[] = [];
  const applications: RuleApplication[] = [];
  let sequenceNo = 0;
  const push = (line: Omit<ComputedLine, 'sequenceNo'>): void => {
    sequenceNo += 1;
    lines.push({ sequenceNo, ...line });
  };
  const applied = (rule: ResolvedRule, resolvedAmountCents: bigint): void => {
    applications.push({
      ruleId: rule.ruleId,
      ruleKind: rule.ruleKind,
      ruleCode: rule.ruleCode,
      ruleVersion: rule.version,
      source: rule.source,
      jurisdiction: rule.jurisdiction,
      rooftopScoped: rule.rooftopScoped,
      effectiveFrom: rule.effectiveFrom,
      effectiveTo: rule.effectiveTo,
      resolvedAmountCents,
    });
  };

  // 1 — the car, and the trade.
  push({
    kind: 'price',
    lineCode: 'vehicle_price',
    label: 'Vehicle price',
    amountCents: inputs.vehiclePriceCents,
    ruleId: null,
    ruleVersion: null,
  });
  const tradeEquityCents = inputs.tradeAllowanceCents - inputs.tradePayoffCents;
  if (inputs.tradeAllowanceCents !== 0n || inputs.tradePayoffCents !== 0n) {
    push({
      kind: 'trade',
      lineCode: 'trade_equity',
      label: 'Trade equity (allowance less payoff)',
      amountCents: -tradeEquityCents,
      ruleId: null,
      ruleVersion: null,
    });
  }

  // 2 — the taxable base.
  const creditRule = book.find(
    (r) => r.ruleKind === 'policy' && r.ruleCode === TRADE_TAX_CREDIT && r.basis === 'rate_ppm',
  );
  let creditCents = 0n;
  if (creditRule !== undefined) {
    creditCents = applyRate(inputs.tradeAllowanceCents, creditRule.ratePpm ?? 0n);
    applied(creditRule, creditCents);
  }
  const taxableAmountCents =
    inputs.vehiclePriceCents - creditCents > 0n ? inputs.vehiclePriceCents - creditCents : 0n;

  // 3 — the first pass: taxes and fees on the price or the taxable base.
  let taxTotalCents = 0n;
  let feeTotalCents = 0n;
  let incentiveTotalCents = 0n;
  const firstPass = book.filter(
    (r) =>
      (r.ruleKind === 'tax' || r.ruleKind === 'fee' || r.ruleKind === 'incentive') &&
      r.appliesTo !== 'total',
  );
  for (const rule of firstPass) {
    const base =
      rule.appliesTo === 'taxable_amount' ? taxableAmountCents : inputs.vehiclePriceCents;
    const amount = magnitude(rule, base);
    applied(rule, amount);
    if (rule.ruleKind === 'tax') taxTotalCents += amount;
    else if (rule.ruleKind === 'fee') feeTotalCents += amount;
    else incentiveTotalCents += amount;
    push({
      // A tax, a fee or an incentive — the three rule kinds that become lines.
      // The filter above admits nothing else, and this narrows the type to say so.
      kind: rule.ruleKind as 'tax' | 'fee' | 'incentive',
      lineCode: rule.ruleCode,
      label: rule.label,
      amountCents: rule.ruleKind === 'incentive' ? -amount : amount,
      ruleId: rule.ruleId,
      ruleVersion: rule.version,
    });
  }

  // 4 and 5 — the subtotal, and everything written against it.
  const subtotalCents = inputs.vehiclePriceCents + taxTotalCents + feeTotalCents;
  const secondPass = book.filter(
    (r) =>
      (r.ruleKind === 'tax' || r.ruleKind === 'fee' || r.ruleKind === 'incentive') &&
      r.appliesTo === 'total',
  );
  for (const rule of secondPass) {
    const amount = magnitude(rule, subtotalCents);
    applied(rule, amount);
    if (rule.ruleKind === 'tax') taxTotalCents += amount;
    else if (rule.ruleKind === 'fee') feeTotalCents += amount;
    else incentiveTotalCents += amount;
    push({
      // A tax, a fee or an incentive — the three rule kinds that become lines.
      // The filter above admits nothing else, and this narrows the type to say so.
      kind: rule.ruleKind as 'tax' | 'fee' | 'incentive',
      lineCode: rule.ruleCode,
      label: rule.label,
      amountCents: rule.ruleKind === 'incentive' ? -amount : amount,
      ruleId: rule.ruleId,
      ruleVersion: rule.version,
    });
  }

  // 6 — what is left to finance.
  if (inputs.cashDownCents !== 0n) {
    push({
      kind: 'down_payment',
      lineCode: 'cash_down',
      label: 'Cash down',
      amountCents: -inputs.cashDownCents,
      ruleId: null,
      ruleVersion: null,
    });
  }
  const amountFinancedCents =
    inputs.vehiclePriceCents +
    taxTotalCents +
    feeTotalCents -
    incentiveTotalCents -
    inputs.cashDownCents -
    tradeEquityCents;

  // 7 — the monthly figure, when and only when both assumptions were given.
  const monthlyPaymentCents =
    inputs.termMonths === null || inputs.aprPpm === null
      ? null
      : monthlyPayment(amountFinancedCents, inputs.termMonths, inputs.aprPpm);

  const inputFingerprint = fingerprint({
    vehicle_price_cents: inputs.vehiclePriceCents,
    trade_allowance_cents: inputs.tradeAllowanceCents,
    trade_payoff_cents: inputs.tradePayoffCents,
    cash_down_cents: inputs.cashDownCents,
    term_months: inputs.termMonths,
    apr_ppm: inputs.aprPpm,
    currency: inputs.currency,
    jurisdiction: inputs.jurisdiction,
    priced_at: inputs.pricedAt,
    // The rule book, as VERSIONS rather than as values: a rule edited in place
    // is impossible (each version is its own row), so the pair is enough to
    // reconstruct exactly what was applied.
    rules: applications.map((a) => [a.ruleId, a.ruleVersion] as const),
  });
  const outputFingerprint = fingerprint({
    trade_equity_cents: tradeEquityCents,
    taxable_amount_cents: taxableAmountCents,
    tax_total_cents: taxTotalCents,
    fee_total_cents: feeTotalCents,
    incentive_total_cents: incentiveTotalCents,
    amount_financed_cents: amountFinancedCents,
    monthly_payment_cents: monthlyPaymentCents,
    lines: lines.map((l) => [l.sequenceNo, l.kind, l.lineCode, l.amountCents] as const),
  });

  return {
    tradeEquityCents,
    taxableAmountCents,
    taxTotalCents,
    feeTotalCents,
    incentiveTotalCents,
    amountFinancedCents,
    monthlyPaymentCents,
    lines,
    applications,
    inputFingerprint,
    outputFingerprint,
  };
}

/** The share of a percentage rule that a reader can check by hand. */
export function ratePercent(ratePpm: bigint): string {
  const whole = ratePpm / (PPM / 100n);
  const part = ((ratePpm % (PPM / 100n)) * 10000n) / (PPM / 100n);
  return `${whole.toString()}.${part.toString().padStart(4, '0')}%`;
}
