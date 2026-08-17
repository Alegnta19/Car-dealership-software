/**
 * NEGATIVE FIXTURE (FBL-020-R4 §3, correction F1a) — deliberately WRONG.
 *
 * The same name assembled by `Array.prototype.join`. No fragment carries a root AND
 * two segments, and the call expression itself carries no text at all, so a reader
 * that understood only `+` and template interpolation saw nothing here.
 *
 * The gate must reject it as `audit-event-type-missing-from-inventory`.
 */
const SEGMENTS = ['identity.', 'support', '.', 'archived'];

export const ARCHIVED_EVENT = SEGMENTS.join('');
