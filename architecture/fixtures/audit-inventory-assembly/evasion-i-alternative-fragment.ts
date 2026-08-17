/**
 * NEGATIVE FIXTURE (FBL-020-R4 §3, correction F1a) — deliberately WRONG.
 *
 * The other shape that produces several possibilities: a conditional and a `??`, each
 * with a different family fragment on each side. Every alternative is rendered and
 * every alternative is judged; taking only the first would clear the file.
 *
 * The gate must reject all four names as `audit-event-type-missing-from-inventory`.
 */
const PREFERRED = 'support';
const FALLBACK = 'session';
const OVERRIDE: string | undefined = FALLBACK;

export function smothered(useFallback: boolean): string {
  return `identity.${useFallback ? FALLBACK : PREFERRED}.smothered`;
}

export function smoked(): string {
  return `identity.${OVERRIDE ?? PREFERRED}.smoked`;
}
