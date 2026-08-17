/**
 * NEGATIVE FIXTURE (FBL-020-R4 §3, correction F1a) — deliberately WRONG.
 *
 * The fragments live in ANOTHER FILE, reached once by a plain named import and once by
 * an ALIASED one. Resolution has to cross the module boundary and follow the alias, or
 * each name here is one unreadable reference plus a leaf.
 *
 * The gate must reject both as `audit-event-type-missing-from-inventory`.
 */
import { NAMESPACE_ROOT, SUPPORT_FAMILY, SUPPORT_FAMILY as FAM } from './cross-file-fragments';

export const IMPORTED_EVENT = NAMESPACE_ROOT + SUPPORT_FAMILY + '.imported';
export const ALIASED_EVENT = NAMESPACE_ROOT + FAM + '.aliased';
