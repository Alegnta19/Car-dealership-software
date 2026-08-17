/**
 * NEGATIVE FIXTURE (FBL-020-R4 §3, correction F1a) — deliberately WRONG.
 *
 * FIVE operations the resolver deliberately does NOT model, each applied to a value
 * that is already inside the namespace. `.replace` can substitute any part of the
 * name, `.slice` can truncate it, a case fold changes what every pattern matches, a
 * `.reduce` callback is a function this gate does not run, and neither is a template
 * tag other than `String.raw`. Treating any of them as an identity would be a hole;
 * skipping them would be the silence the fail-loud rule abolishes.
 *
 * So the INPUT is rendered — which is how each string is still recognised as sitting
 * inside `identity.` — and the operation is refused as
 * `audit-event-type-assembled-at-run-time`: an unreadable name requires an explicit,
 * reviewed declaration, never a silent pass.
 */
const ROOT = 'identity.';
const NEARLY = 'identity.support';

function eventTag(strings: TemplateStringsArray, ...values: string[]): string {
  return strings.raw.join('|') + values.join('|');
}

export const VIA_REPLACE = NEARLY.replace('support', 'support.reworked');
export const VIA_SLICE = NEARLY.slice(0, 16);
export const VIA_CASE_FOLD = NEARLY.toUpperCase();
export const VIA_REDUCE = [ROOT, 'support'].reduce((left, right) => left + right, '');
export const VIA_TAG = eventTag`${ROOT}support`;
