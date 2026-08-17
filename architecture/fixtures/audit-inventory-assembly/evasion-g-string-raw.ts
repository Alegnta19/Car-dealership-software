/**
 * NEGATIVE FIXTURE (FBL-020-R4 §3, correction F1a) — deliberately WRONG.
 *
 * `String.raw`, which is a template whose pieces are its RAW source text. It is also
 * an interpolated head, so it is the two evasions at once. The role-bindings guard
 * used to skip raw templates outright — an undeclared, unvalidated, one-token off
 * switch — and this file is why that mistake is not repeated here.
 *
 * The gate must reject it as `audit-event-type-missing-from-inventory`.
 */
const ROOT = 'identity.';

export const STAPLED_EVENT = String.raw`${ROOT}support.stapled`;
