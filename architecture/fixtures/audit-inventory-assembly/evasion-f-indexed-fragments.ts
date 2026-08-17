/**
 * NEGATIVE FIXTURE (FBL-020-R4 §3, correction F1a) — deliberately WRONG.
 *
 * No join and no concatenation call: the fragments are read back out of an array by
 * INDEX, once with `[i]` and once with `.at(i)`. Two shapes, because indexing and
 * `.at` reach the elements by different paths in the resolver.
 *
 * The gate must reject both as `audit-event-type-missing-from-inventory`.
 */
const PARTS = ['identity.', 'support', '.folded'];
const PIECES = ['identity.', 'support', '.picked'];

export const FOLDED_EVENT = String(PARTS[0]) + String(PARTS[1]) + String(PARTS[2]);
export const PICKED_EVENT = String(PIECES.at(0)) + String(PIECES.at(1)) + String(PIECES.at(2));
