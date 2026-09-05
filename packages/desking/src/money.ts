/**
 * THE DESK'S ARITHMETIC, AND WHY NONE OF IT IS A `number`.
 *
 * Row 3 of Master Blueprint Version 3.1 §14.3 Part B requires identical inputs
 * to reproduce identical outputs. A binary float cannot promise that — 0.1 + 0.2
 * is not 0.3, and a tax on a trade allowance is exactly the kind of chain where
 * that shows up as a cent that appears on one machine and not another. So every
 * figure in this phase is an integer:
 *
 *   * MONEY is `bigint` cents, exactly as migration 062's `stock_prices` stores
 *     it and migration 065 continues.
 *   * RATES are `bigint` parts per million — 6.5% is 65_000n — so a rate is a
 *     whole number of the smallest unit anybody quotes.
 *   * ROUNDING is half away from zero, applied once per line item and never to
 *     an intermediate, because rounding twice is how two correct calculators
 *     disagree by a cent.
 *
 * The exported functions are pure. They read no clock, no database and no
 * environment; everything they need is an argument, which is what lets
 * `tests/desking-scenarios.test.ts` run the same inputs twice and demand the
 * same digest.
 */
import { createHash } from 'node:crypto';

/** Parts per million: 100% is 1_000_000. */
export const PPM = 1_000_000n;

/** A scale for the intermediate fixed-point used by the payment formula. */
const PAYMENT_SCALE = 1_000_000_000_000n; // 1e12

/**
 * Divide and round HALF AWAY FROM ZERO. `divisor` must be positive; the sign of
 * the answer follows the dividend, so a negative line item rounds the same
 * distance from zero as its positive twin. Ties going away from zero is the
 * convention a desk uses on paper, and picking one and writing it down is worth
 * more than picking the cleverest.
 */
export function roundDiv(dividend: bigint, divisor: bigint): bigint {
  if (divisor <= 0n) throw new RangeError('roundDiv: the divisor must be positive');
  const negative = dividend < 0n;
  const magnitude = negative ? -dividend : dividend;
  const rounded = (magnitude * 2n + divisor) / (divisor * 2n);
  return negative ? -rounded : rounded;
}

/** `amount` × `ratePpm`, rounded to whole cents exactly once. */
export function applyRate(amountCents: bigint, ratePpm: bigint): bigint {
  return roundDiv(amountCents * ratePpm, PPM);
}

/**
 * The monthly payment of an amount financed over a term at an annual rate,
 * in whole cents.
 *
 * WHY IT IS WRITTEN OUT RATHER THAN CALLED FROM A LIBRARY. The standard
 * annuity formula needs (1 + r)^n, and every floating implementation of it
 * returns something a hair different on a different machine. Here r is a
 * fixed-point integer scaled by 1e12, the power is computed by repeated
 * multiplication with the scale divided back out each step — at most 120 of
 * them, since the schema caps the term — and the single rounding happens at
 * the end. Two runs with the same three arguments return the same cent, on any
 * machine, forever.
 *
 * A ZERO RATE IS NOT A SPECIAL CASE THAT WAS FORGOTTEN. It is one the formula
 * cannot answer — the denominator is zero — so it is answered directly, which
 * is also the only honest reading of "no interest": the balance, split evenly.
 */
export function monthlyPayment(
  amountFinancedCents: bigint,
  termMonths: number,
  aprPpm: bigint,
): bigint {
  if (!Number.isInteger(termMonths) || termMonths < 1 || termMonths > 120) {
    throw new RangeError('monthlyPayment: the term is a whole number of months, 1 to 120');
  }
  if (aprPpm < 0n) throw new RangeError('monthlyPayment: a negative rate is not a price');
  if (amountFinancedCents <= 0n) return 0n;

  const n = BigInt(termMonths);
  if (aprPpm === 0n) return roundDiv(amountFinancedCents, n);

  // r, scaled: the annual rate divided across twelve months.
  const r = roundDiv(aprPpm * PAYMENT_SCALE, PPM * 12n);
  if (r === 0n) return roundDiv(amountFinancedCents, n);

  // (1 + r)^n, carried at the same scale throughout.
  const onePlusR = PAYMENT_SCALE + r;
  let growth = PAYMENT_SCALE;
  for (let i = 0; i < termMonths; i += 1) {
    growth = (growth * onePlusR) / PAYMENT_SCALE;
  }
  const denominator = growth - PAYMENT_SCALE;
  if (denominator <= 0n) return roundDiv(amountFinancedCents, n);

  // payment = P · r · (1+r)^n / ((1+r)^n − 1), with one rounding at the end.
  const numerator = amountFinancedCents * r * growth;
  return roundDiv(numerator, denominator * PAYMENT_SCALE);
}

/**
 * A canonical digest over a value: object keys sorted, bigints written as
 * decimal strings, `undefined` refused rather than silently dropped.
 *
 * The point is not secrecy. It is that two structures that mean the same thing
 * produce the same 64 hex characters regardless of the order their keys were
 * written in, so a fingerprint can be compared by a database trigger that knows
 * nothing about JavaScript.
 */
export function fingerprint(value: unknown): string {
  return createHash('sha256').update(canonicalize(value)).digest('hex');
}

export function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'bigint') return `"${value.toString()}"`;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonicalize: a non-finite number');
    return JSON.stringify(value);
  }
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(',')}}`;
  }
  throw new TypeError(`canonicalize: ${typeof value} has no canonical form`);
}

/** Postgres hands BIGINT back as a string; this is the one place that knows it. */
export function toCents(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new TypeError('toCents: not a safe integer');
    return BigInt(value);
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  throw new TypeError(`toCents: ${JSON.stringify(value)} is not an integer amount`);
}

/** Cents as a plain decimal string, for a screen or a JSON body. */
export function formatCents(cents: bigint): string {
  const negative = cents < 0n;
  const magnitude = negative ? -cents : cents;
  const whole = magnitude / 100n;
  const part = magnitude % 100n;
  return `${negative ? '-' : ''}${whole.toString()}.${part.toString().padStart(2, '0')}`;
}
