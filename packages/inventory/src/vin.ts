/**
 * RELEASE TRAIN 2 — VIN NORMALIZATION AND VALIDATION.
 *
 * A VIN arrives from a scanner, a keyboard or an auction sheet, and each of
 * those produces a different shape of the same number: lower case, spaces,
 * hyphens, and — the expensive one — the letters I, O and Q typed where the
 * digits 1, 0 and 0 belong. The standard excludes those three letters for
 * exactly that reason, so a VIN containing one is either a transcription error
 * or not a VIN at all.
 *
 * This module is deliberately PURE: no database, no provider, no clock. It
 * decides what a VIN is, not what a vehicle is, so it can be exercised
 * exhaustively without a schema and reused by the decode simulator, the
 * acquisition service and the UI's client-side check alike.
 *
 * THE CHECK DIGIT IS REPORTED, NEVER ENFORCED. Position nine of a North
 * American VIN carries a checksum, and a mistyped VIN usually fails it — but
 * so do many legitimately-issued VINs outside that scheme. Refusing an
 * acquisition because the digit disagrees would block real cars from being
 * stocked; the platform therefore records `checkDigitValid` and lets the
 * dealership see it. Only the SHAPE is enforced.
 */

/** The transliteration the standard defines. I, O and Q are absent by design. */
const LETTER_VALUES: Readonly<Record<string, number>> = {
  A: 1,
  B: 2,
  C: 3,
  D: 4,
  E: 5,
  F: 6,
  G: 7,
  H: 8,
  J: 1,
  K: 2,
  L: 3,
  M: 4,
  N: 5,
  P: 7,
  R: 9,
  S: 2,
  T: 3,
  U: 4,
  V: 5,
  W: 6,
  X: 7,
  Y: 8,
  Z: 9,
};

/** Positional weights, most significant first; position nine weighs nothing. */
const WEIGHTS: readonly number[] = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

/**
 * The model-year code at position ten, in the standard's 30-year cycle. The
 * same letter means two years thirty apart, so the cycle is resolved against a
 * reference year rather than guessed.
 */
const YEAR_CODES = 'ABCDEFGHJKLMNPRSTVWXY123456789';

export const VIN_LENGTH = 17;

/** The shape a VIN must have once normalized: 17 characters, no I, O or Q. */
export const VIN_PATTERN = /^[A-HJ-NPR-Z0-9]{17}$/;

export type VinRejection = 'empty' | 'wrong_length' | 'illegal_character' | 'excluded_letter';

export interface VinNormalization {
  /** The normalized VIN, present only when the shape is acceptable. */
  readonly vin: string | null;
  /** Why the input is not a VIN, present only when `vin` is null. */
  readonly rejection: VinRejection | null;
  /**
   * Whether position nine matches the computed checksum. Meaningful only when
   * `vin` is non-null; false is a WARNING to show, never a refusal.
   */
  readonly checkDigitValid: boolean;
  /** The model year the tenth character implies, or null when it is a digit-coded year outside the window. */
  readonly modelYear: number | null;
  /** The World Manufacturer Identifier — the first three characters. */
  readonly wmi: string | null;
}

/**
 * Strips formatting and upper-cases. Hyphens and whitespace are removed
 * because paperwork and scanners both introduce them; nothing else is.
 */
export function normalizeVinInput(raw: string): string {
  return raw.replace(/[\s-]/g, '').toUpperCase();
}

/**
 * Computes the check character for the first eight and last eight positions.
 * Returns null when the VIN contains a character the standard cannot weigh,
 * which the shape test refuses before this is ever reached.
 */
export function vinCheckCharacter(vin: string): string | null {
  let total = 0;
  for (let i = 0; i < VIN_LENGTH; i += 1) {
    const ch = vin[i] as string;
    const value = ch >= '0' && ch <= '9' ? Number(ch) : LETTER_VALUES[ch];
    if (value === undefined) return null;
    total += value * (WEIGHTS[i] as number);
  }
  const remainder = total % 11;
  return remainder === 10 ? 'X' : String(remainder);
}

/**
 * Resolves the tenth character to a model year within the 30-year cycle that
 * ENDS at `referenceYear + 1` — dealerships stock next year's models, and the
 * alternative (a car thirty years older) is the far less likely reading.
 */
export function vinModelYear(vin: string, referenceYear: number): number | null {
  const index = YEAR_CODES.indexOf(vin[9] as string);
  if (index < 0) return null;
  const latest = referenceYear + 1;
  // The cycle repeats every 30 codes; pick the most recent occurrence at or
  // before `latest`.
  const cycleStart = latest - ((latest - (1980 + index)) % 30);
  return cycleStart;
}

/**
 * The one entry point: normalize, judge the shape, and report what can be read
 * off a well-shaped VIN without consulting any provider.
 */
export function normalizeVin(raw: unknown, referenceYear: number): VinNormalization {
  const rejected = (rejection: VinRejection): VinNormalization => ({
    vin: null,
    rejection,
    checkDigitValid: false,
    modelYear: null,
    wmi: null,
  });

  if (typeof raw !== 'string' || raw.trim().length === 0) return rejected('empty');
  const candidate = normalizeVinInput(raw);
  if (candidate.length !== VIN_LENGTH) return rejected('wrong_length');
  // The excluded letters get their own answer: 'I, O and Q are not VIN
  // characters' is actionable, where 'illegal character' sends the reader
  // hunting for which one.
  if (/[IOQ]/.test(candidate)) return rejected('excluded_letter');
  if (!VIN_PATTERN.test(candidate)) return rejected('illegal_character');

  return {
    vin: candidate,
    rejection: null,
    checkDigitValid: vinCheckCharacter(candidate) === candidate[8],
    modelYear: vinModelYear(candidate, referenceYear),
    wmi: candidate.slice(0, 3),
  };
}

/** A human-readable reason, for the API's problem detail and the UI alike. */
export function describeVinRejection(rejection: VinRejection): string {
  switch (rejection) {
    case 'empty':
      return 'a VIN is required';
    case 'wrong_length':
      return `a VIN is ${VIN_LENGTH} characters once spaces and hyphens are removed`;
    case 'excluded_letter':
      return 'the letters I, O and Q are not VIN characters — check for 1 and 0';
    case 'illegal_character':
      return 'a VIN contains only letters and digits';
  }
}
