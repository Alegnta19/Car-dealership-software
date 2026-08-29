/**
 * @dealer/inventory — Release Train 2: vehicle acquisition and inventory.
 *
 * The acquisition party, the canonical VIN-identified vehicle, its stock
 * identity and lifecycle, acquisition documents and costs, merchandising
 * (versioned pricing, media, features, holds, transfers, aging) and listing
 * publication reconciled through bounded provider adapters.
 *
 * This package owns migration 062's tables and nothing else. It depends on
 * @dealer/identity-access for the attributed-mutation envelope
 * (requireActor / recordMutation) and on @dealer/database for the
 * tenant-context transaction; it holds no HTTP, no provider SDK and no Fixed
 * Ops business rule.
 */
export * from './vin';
export * from './providers';
export * from './parties';
export * from './vehicles';
export * from './stock';
export * from './merchandising';
export * from './listings';
export * from './reads';
export * from './actions';
