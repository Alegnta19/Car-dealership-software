/**
 * NEGATIVE FIXTURE (FBL-020-R4 §3, correction F1a) — deliberately WRONG.
 *
 * ONE expression, MANY possible names: the family is taken from an object literal
 * under a key nothing static can resolve. The resolver over-approximates — every
 * property is a possibility and every possibility is judged — so BOTH assembled names
 * are compared to the inventory. A resolver that judged one value per expression would
 * clear this file.
 *
 * No fragment here is a name: `support` and `session` are families, and `.smuggled`
 * has no root.
 *
 * The gate must reject both names as `audit-event-type-missing-from-inventory`.
 */
const FAMILIES = { first: 'support', second: 'session' };

export function smuggled(which: string): string {
  return 'identity.' + FAMILIES[which as keyof typeof FAMILIES] + '.smuggled';
}
