/**
 * @dealer/crm — Release Train 3: CRM, BDC and marketing.
 *
 * Lead intake and identity, routing, lifecycle and the first-response clock,
 * one shared timeline of activities and appointments, consent-safe campaigns
 * whose suppression is rechecked at send time, and deterministic versioned
 * attribution — up to the sales handoff and no further.
 *
 * This package owns migration 063's tables and nothing else. It depends on
 * @dealer/inventory for customer identity, because Release Train 2 owns that
 * and a second identity here would be the thing that splits a customer in two.
 * It holds no HTTP, no provider SDK, no sale, and no revenue figure.
 */
export * from './providers';
export * from './consent';
export * from './consent-records';
export * from './sources';
export * from './leads';
export * from './routing';
export * from './activities';
export * from './campaigns';
export * from './sends';
export * from './attribution';
export * from './reads';
export * from './actions';
export * from './worker';
