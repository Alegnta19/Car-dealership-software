/**
 * NEGATIVE FIXTURE (FBL-020-R4 §3, correction F1a) — deliberately WRONG.
 *
 * THE SECOND HALF OF THE FINDING. The pre-F1a gate refused a template whose HEAD
 * already ended inside the namespace (`identity.support.` followed by an
 * interpolation) by inspecting `node.head.text`. Where the interpolation comes FIRST
 * the head is the EMPTY STRING, so that inspection saw nothing at all and the
 * assembled name was never compared to the inventory.
 *
 * The gate must reject it as `audit-event-type-missing-from-inventory`.
 */
const NS = 'identity.support';

export const REOPENED_EVENT = `${NS}.reopened`;
