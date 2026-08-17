/**
 * NEGATIVE FIXTURE (FBL-020-R4 §3, correction F1a) — deliberately WRONG.
 *
 * The oldest spelling there is, and the one with no assembly expression in it at all:
 * a name accumulated with `+=` across three statements. Read at its DECLARATION the
 * value is the innocent `identity.`; only reading it at its LAST append gives the name
 * that would reach the audit table.
 *
 * The gate must reject it as `audit-event-type-missing-from-inventory`.
 */
let drained = 'identity.';
drained += 'support';
drained += '.drained';

export function drainedEvent(): string {
  return drained;
}
