/**
 * NEGATIVE FIXTURE (FBL-020-R4 §3, correction F1a) — deliberately WRONG.
 *
 * THE REPRODUCTION FROM THE FINDING, in shape. The pre-F1a gate looked for
 * `identity.<a>.<b>` inside ONE string literal, so neither half of
 * `'identity.support' + '.quarantined'` matched: the first has only one segment after
 * the root, the second has no root at all. A brand-new audit event type in a DECLARED
 * family, handed to the same private `recordMutation` the real writers use, produced a
 * real audit row and an `exit 0`.
 *
 * The gate must reject it as `audit-event-type-missing-from-inventory` — which means
 * the shared resolver has to CONCATENATE the two fragments before the name is judged.
 * That is the whole point: no piece of this file is an event type.
 */

/** Root plus family. One segment after the root, so not a name on its own. */
const PROBE_NS = 'identity.support';

/** A leaf. No root, so not a name on its own either. */
const PROBE_LEAF = '.quarantined';

export const PROBE_V2_EVENT = PROBE_NS + PROBE_LEAF;
