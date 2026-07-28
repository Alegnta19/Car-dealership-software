/**
 * Estimate & authorization rules (EAS2). Pure domain logic — no database, no I/O.
 *
 * The authorization record is the evidence a customer approved paid work, and the
 * repair-order state machine gates on it. Its status must therefore be *derived* from
 * what the customer actually decided, never asserted by the caller.
 */

export type AuthorizationStatus = 'pending' | 'approved' | 'declined' | 'revoked';
export type EstimateStatus = 'draft' | 'sent' | 'partially_approved' | 'approved' | 'declined' | 'expired';

/** Methods by which a customer decision can be captured. */
export const AUTHORIZATION_METHODS = ['portal', 'signature', 'staff_attestation', 'recorded_call_ref'] as const;
export type AuthorizationMethod = (typeof AUTHORIZATION_METHODS)[number];

export function isAuthorizationMethod(value: unknown): value is AuthorizationMethod {
  return typeof value === 'string' && (AUTHORIZATION_METHODS as readonly string[]).includes(value);
}

/**
 * Methods where staff record the decision on the customer's behalf, with no artifact
 * the customer produced themselves. These require step-up re-authentication so an
 * "approval" cannot be manufactured from a single compromised or careless session.
 */
export const STAFF_ASSERTED_METHODS: ReadonlySet<string> = new Set<AuthorizationMethod>(['staff_attestation']);

export function methodRequiresStepUp(method: string): boolean {
  return STAFF_ASSERTED_METHODS.has(method);
}

/**
 * An authorization counts as `approved` only when the customer approved at least one
 * line. An all-declined decision is a real, recordable outcome — but it is `declined`,
 * and must not satisfy the state machine's authorization gate.
 */
export function deriveAuthorizationStatus(approvedItems: string[], declinedItems: string[]): AuthorizationStatus {
  if (approvedItems.length > 0) return 'approved';
  if (declinedItems.length > 0) return 'declined';
  // Guarded upstream: a decision must cover at least one line.
  return 'pending';
}

/**
 * Estimate outcome after a decision has been applied.
 *
 * `remainingUndecidedCount` is how many of the estimate's lines are STILL awaiting a
 * customer decision once this one is recorded. An estimate is only `approved` when the
 * customer took every line and declined none; anything partial — some declined, or some
 * still undecided — is `partially_approved`, so a later decision can still complete it.
 */
export function deriveEstimateStatus(
  approvedCount: number,
  declinedCount: number,
  remainingUndecidedCount: number,
): EstimateStatus {
  if (approvedCount === 0) return remainingUndecidedCount > 0 ? 'partially_approved' : 'declined';
  if (declinedCount === 0 && remainingUndecidedCount === 0) return 'approved';
  return 'partially_approved';
}
