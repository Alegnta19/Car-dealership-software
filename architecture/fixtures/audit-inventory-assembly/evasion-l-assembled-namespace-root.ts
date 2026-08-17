/**
 * NEGATIVE FIXTURE (FBL-020-R4 §3, correction F1a) — deliberately WRONG.
 *
 * The mirror image of `../audit-inventory-gap/assembled-event-type.ts`: there the ROOT
 * was readable and the leaf was not, here the root is supplied by a caller and the
 * DECLARED FAMILY and the leaf are spelled out. Nothing in this string says
 * `identity.`, so the rule that looks for a readable root followed by an unreadable
 * tail cannot see it — and a gate that stopped there would have a hole shaped exactly
 * like this file.
 *
 * A declared family standing between two dots is enough to know this is a name in the
 * inventoried namespace, so the gate must reject it as
 * `audit-event-type-namespace-root-assembled-at-run-time`.
 */
export function quarantinedEvent(root: string): string {
  return `${root}.support.quarantined`;
}
