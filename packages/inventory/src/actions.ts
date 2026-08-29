/**
 * RELEASE TRAIN 2 — THE INVENTORY ACTION CATALOG.
 *
 * Every route on the inventory surface names one of these, and the policy
 * engine decides it from database-authoritative role bindings. Two facts about
 * the shape are load-bearing:
 *
 *   * AN ACTION WITH A `resourceType` IS ROOFTOP-SCOPED. The engine resolves
 *     the named resource to the rooftop that owns it (migration 062's
 *     `resource_org_leaf`), walks that rooftop's ancestry, and admits only a
 *     binding sitting on the chain — so a clerk bound at one store touching
 *     another store's car is told the car does not exist, not that they are
 *     forbidden. Everything hanging off a stock item is authorized THROUGH the
 *     stock item, which is why `stockItemId` is the route parameter even for a
 *     price or a photograph.
 *   * AN ACTION WITHOUT ONE IS TENANT-SCOPED, and where a create needs to land
 *     at a rooftop the route sends `location_id` so the engine can resolve a
 *     scope hint. Customers and vehicles belong to the dealership rather than
 *     to one store, so their actions are tenant-scoped by design.
 *
 * THE TWO ROLES ARE NOT INTERCHANGEABLE. A clerk does the day's work — find
 * the customer, acquire the car, photograph it, record what it cost. A manager
 * additionally decides money and exposure: pricing, transfers between stores,
 * publication, and merging two customer records into one. Every action below
 * also admits `tenant_admin`, who is the dealership's owner.
 */
import { ROLES } from '@dealer/contracts';
import {
  TENANT_ADMIN_ROLE,
  createActionCatalog,
  type ActionCatalog,
} from '@dealer/identity-access';

/** Anyone who works inventory at all. */
const INVENTORY_ANY: readonly string[] = [
  TENANT_ADMIN_ROLE,
  ROLES.INVENTORY_MANAGER,
  ROLES.INVENTORY_CLERK,
];

/** Decisions about money, exposure and identity. */
const INVENTORY_MANAGER_UP: readonly string[] = [TENANT_ADMIN_ROLE, ROLES.INVENTORY_MANAGER];

export const INVENTORY_ACTION_DEFINITIONS = [
  // ── row 1: the acquisition party ────────────────────────────────────────
  {
    action: 'inventory.party.view',
    description: 'Search and read acquisition parties (customers and sellers)',
    resourceType: null,
    allowedRoles: INVENTORY_ANY,
  },
  {
    action: 'inventory.party.create',
    description: 'Create an acquisition party, with duplicate detection',
    resourceType: null,
    allowedRoles: INVENTORY_ANY,
  },
  {
    action: 'inventory.party.update',
    description: 'Correct an acquisition party and record contact consent',
    resourceType: null,
    allowedRoles: INVENTORY_ANY,
  },
  {
    action: 'inventory.party.merge',
    description: 'Merge two duplicate acquisition parties, preserving both records',
    resourceType: null,
    allowedRoles: INVENTORY_MANAGER_UP,
  },
  {
    action: 'inventory.party.import',
    description: 'Import a bounded list of acquisition parties',
    resourceType: null,
    allowedRoles: INVENTORY_MANAGER_UP,
  },

  // ── row 2: the vehicle and its stock identity ───────────────────────────
  {
    action: 'inventory.vehicle.view',
    description: 'Read a canonical vehicle and its decode history',
    resourceType: null,
    allowedRoles: INVENTORY_ANY,
  },
  {
    action: 'inventory.vehicle.decode',
    description: 'Decode a VIN through the build-data provider',
    resourceType: null,
    allowedRoles: INVENTORY_ANY,
  },
  {
    action: 'inventory.view',
    description: 'Read the inventory across the rooftops this actor may see',
    resourceType: null,
    allowedRoles: INVENTORY_ANY,
  },
  {
    action: 'inventory.stock.acquire',
    description: 'Acquire a vehicle into stock at a rooftop',
    resourceType: null,
    allowedRoles: INVENTORY_ANY,
  },
  {
    action: 'inventory.stock.view',
    description: 'Read one stock record in full',
    resourceType: 'stock_item',
    allowedRoles: INVENTORY_ANY,
  },
  {
    action: 'inventory.stock.update',
    description: 'Correct a stock record’s acquisition facts',
    resourceType: 'stock_item',
    allowedRoles: INVENTORY_ANY,
  },
  {
    action: 'inventory.stock.transition',
    description: 'Advance a stock record through its readiness lifecycle',
    resourceType: 'stock_item',
    allowedRoles: INVENTORY_ANY,
  },
  {
    action: 'inventory.stock.document',
    description: 'Record acquisition paperwork against a stock record',
    resourceType: 'stock_item',
    allowedRoles: INVENTORY_ANY,
  },
  {
    action: 'inventory.stock.cost',
    description: 'Record a cost, including readiness work, against a stock record',
    resourceType: 'stock_item',
    allowedRoles: INVENTORY_ANY,
  },

  // ── row 3: merchandising and publication ────────────────────────────────
  {
    action: 'inventory.price.set',
    description: 'Set a versioned price on a stock record',
    resourceType: 'stock_item',
    allowedRoles: INVENTORY_MANAGER_UP,
  },
  {
    action: 'inventory.media.manage',
    description: 'Add or retire photographs on a stock record',
    resourceType: 'stock_item',
    allowedRoles: INVENTORY_ANY,
  },
  {
    action: 'inventory.features.manage',
    description: 'Replace the feature set on a stock record',
    resourceType: 'stock_item',
    allowedRoles: INVENTORY_ANY,
  },
  {
    action: 'inventory.hold.manage',
    description: 'Place or release a hold on a stock record',
    resourceType: 'stock_item',
    allowedRoles: INVENTORY_ANY,
  },
  {
    action: 'inventory.transfer.request',
    description: 'Request a transfer of a stock record to another rooftop',
    resourceType: 'stock_item',
    allowedRoles: INVENTORY_MANAGER_UP,
  },
  {
    action: 'inventory.transfer.settle',
    description: 'Complete or cancel an open transfer',
    resourceType: 'stock_item',
    allowedRoles: INVENTORY_MANAGER_UP,
  },
  {
    action: 'inventory.listing.publish',
    description: 'Advertise a stock record on a channel',
    resourceType: 'stock_item',
    allowedRoles: INVENTORY_MANAGER_UP,
  },
  {
    action: 'inventory.listing.withdraw',
    description: 'Withdraw a listing from its channel',
    resourceType: 'stock_listing',
    allowedRoles: INVENTORY_MANAGER_UP,
  },
  {
    action: 'inventory.listing.reconcile',
    description: 'Reconcile a listing against what the provider carries',
    resourceType: 'stock_listing',
    allowedRoles: INVENTORY_MANAGER_UP,
  },
] as const;

export function createInventoryActionCatalog(): ActionCatalog {
  return createActionCatalog(INVENTORY_ACTION_DEFINITIONS.map((d) => ({ ...d })));
}

/** The roles a dealership may put on inventory work, for the invitation UI. */
export const INVENTORY_ROLES: readonly string[] = [ROLES.INVENTORY_MANAGER, ROLES.INVENTORY_CLERK];
