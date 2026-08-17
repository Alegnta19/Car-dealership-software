/**
 * POSITIVE FIXTURE (FBL-020-R4 §3) — deliberately CORRECT.
 *
 * A file that names event types the inventory already carries, and a policy action key it
 * declares as NOT an event. `scripts/check-audit-inventory.ts` must ACCEPT it.
 *
 * This is the control that stops the sibling `../audit-inventory-gap/` proof from being
 * satisfied by a checker that rejects any extra target it is pointed at.
 */
export const READ_BY_OPERATORS = [
  'identity.login.succeeded',
  'identity.session.established',
  'identity.support.expired',
] as const;

/** An ACTION, not an event — declared in IDENTITY_NON_AUDIT_NAMESPACE_LITERALS. */
export const APPROVE_ACTION = 'identity.support.approve';
