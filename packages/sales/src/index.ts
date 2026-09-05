/**
 * @dealer/sales — Release Train 4: sales pipeline and showroom management.
 *
 * The opportunity created from the CRM handoff, the showroom visit and the
 * floor rotation that decides who takes it, vehicle selection and
 * demonstration against real stock, the sales-side timeline, negotiation
 * rounds recorded without figures, and manager turnover.
 *
 * This package owns migration 064's tables and nothing else. It stops before
 * desking, the deal record, F&I, title and delivery, and it holds no money
 * column anywhere — pricing is FBL-120 and the deal record is FBL-140.
 */
export * from './opportunities';
export * from './showroom';
export * from './selling';
export * from './reads';
export * from './actions';
