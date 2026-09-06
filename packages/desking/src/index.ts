/**
 * @dealer/desking — FBL-120: appraisal, trade, pricing and desking.
 *
 * The desk file opened from Release Train 4's one handed-on fact, the trade
 * unit and the versioned evidence about it, the rule book every figure is
 * computed under, the deterministic priced versions themselves, and the
 * attributable manager decision that freezes exactly one of them.
 *
 * This package owns migration 065's tables and nothing else. It stops before
 * the deal jacket, e-sign, credit, funding, title, registration, delivery and
 * sold inventory — FBL-130 through FBL-160 own those — and it writes no
 * authoritative revenue: an approved scenario is a priced proposal, not a sale.
 */
export * from './money';
export * from './calculator';
export * from './intake';
export * from './appraisal';
export * from './rules';
export * from './scenarios';
export * from './reads';
export * from './actions';

/**
 * The FBL-140 seam, added when the deal jacket was built. It reads the approved
 * version this phase froze, and the current approval a bound jacket can be
 * measured against, and changes nothing — the same shape as the one seam
 * Release Train 4 added to `@dealer/crm` and the one FBL-120 added to
 * `@dealer/sales`.
 */
export * from './jacket-seam';
