/**
 * NEGATIVE FIXTURE (FBL-020-R4 §3, correction F1a) — deliberately WRONG.
 *
 * `String.prototype.concat`, in both spellings: the multi-argument call and the chain
 * of single-argument calls. A resolver that handled only a flat argument list would
 * leave the chain open, which is why there are two names here and not one.
 *
 * The gate must reject both as `audit-event-type-missing-from-inventory`.
 */
const ROOT = 'identity.';
const FAMILY = 'support';

export const SEALED_EVENT = ROOT.concat(FAMILY, '.sealed');
export const CHAINED_EVENT = ROOT.concat(FAMILY).concat('.chained');
