/**
 * Repair-order lifecycle (ROLS2). Pure domain logic — no database, no I/O — so the
 * rules can be unit-tested without a Postgres instance.
 */

export const RO_STATUSES = [
  'draft',
  'checked_in',
  'inspection_in_progress',
  'estimate_pending',
  'awaiting_authorization',
  'authorized',
  'in_repair',
  'waiting_parts',
  'sublet_in_progress',
  'qc',
  'ready_for_pickup',
  'closed',
  'canceled',
  'comeback',
] as const;

export type ROStatus = (typeof RO_STATUSES)[number];

export const RO_TRANSITIONS: Record<ROStatus, ROStatus[]> = {
  draft: ['checked_in', 'canceled'],
  checked_in: ['inspection_in_progress', 'estimate_pending', 'canceled'],
  inspection_in_progress: ['estimate_pending', 'awaiting_authorization', 'authorized', 'canceled'],
  estimate_pending: ['awaiting_authorization', 'canceled'],
  awaiting_authorization: ['authorized', 'estimate_pending', 'canceled'],
  authorized: ['in_repair', 'waiting_parts', 'sublet_in_progress', 'canceled'],
  in_repair: ['waiting_parts', 'sublet_in_progress', 'qc', 'canceled'],
  waiting_parts: ['in_repair', 'canceled'],
  sublet_in_progress: ['in_repair', 'qc', 'canceled'],
  qc: ['ready_for_pickup', 'in_repair', 'canceled'],
  ready_for_pickup: ['closed'],
  closed: ['comeback'],
  canceled: [],
  comeback: ['checked_in'],
};

/**
 * Transitions that commit the customer to money, or destroy work in progress, and so
 * require a freshly re-authenticated actor (see `shared/security/step-up`).
 */
export const STEP_UP_TRANSITIONS: ReadonlySet<string> = new Set<ROStatus>(['authorized', 'canceled']);

/** Transitions whose customer-authorization evidence must exist before they are allowed. */
export const AUTHORIZATION_GATED_TRANSITIONS: ReadonlySet<string> = new Set<ROStatus>(['authorized']);

export function isROStatus(value: unknown): value is ROStatus {
  return typeof value === 'string' && (RO_STATUSES as readonly string[]).includes(value);
}

export function allowedTransitionsFrom(status: string): ROStatus[] {
  return isROStatus(status) ? RO_TRANSITIONS[status] : [];
}

export function isTransitionAllowed(from: string, to: string): boolean {
  return allowedTransitionsFrom(from).includes(to as ROStatus);
}

export function transitionRequiresStepUp(to: string): boolean {
  return STEP_UP_TRANSITIONS.has(to);
}

export function transitionRequiresAuthorization(to: string): boolean {
  return AUTHORIZATION_GATED_TRANSITIONS.has(to);
}
