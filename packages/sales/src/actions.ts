/**
 * RELEASE TRAIN 4 — THE SALES ACTION CATALOG.
 *
 * Every route on this surface names one of these, and the policy engine decides
 * it from database-authoritative role bindings.
 *
 * AN ACTION WITH A `resourceType` IS ROOFTOP-SCOPED, and — the lesson RT3-C1
 * taught at some cost — the route that names it MUST carry that type's
 * parameter, or the middleware resolves no resource and the decision silently
 * widens to the whole dealership. Everything hanging off an opportunity is
 * authorized THROUGH the opportunity, which is why `opportunityId` is in the
 * path even for a test drive or a negotiation round.
 *
 * THE TWO ROLES ARE NOT INTERCHANGEABLE. A salesperson works their own
 * customers: shortlist, demonstrate, follow up, record what was said, ask for a
 * manager. A sales manager runs the floor: the rotation, reassignment, and the
 * board. Both admit `tenant_admin`, who is the dealership's owner.
 */
import { ROLES } from '@dealer/contracts';
import {
  TENANT_ADMIN_ROLE,
  createActionCatalog,
  type ActionCatalog,
} from '@dealer/identity-access';

/** Anyone who sells. */
const SALES_ANY: readonly string[] = [TENANT_ADMIN_ROLE, ROLES.SALES_MANAGER, ROLES.SALESPERSON];

/** Running the floor, rather than working one customer on it. */
const SALES_MANAGER_UP: readonly string[] = [TENANT_ADMIN_ROLE, ROLES.SALES_MANAGER];

export const SALES_ACTION_DEFINITIONS = [
  // ── the pipeline ────────────────────────────────────────────────────────
  {
    action: 'sales.opportunity.view',
    description: 'Read the sales pipeline and the floor board',
    resourceType: null,
    allowedRoles: SALES_ANY,
  },
  {
    action: 'sales.opportunity.receive',
    description: 'Receive a handed-off lead into the sales pipeline',
    resourceType: null,
    allowedRoles: SALES_ANY,
  },
  {
    action: 'sales.opportunity.read',
    description: 'Read one opportunity and its timeline',
    resourceType: 'opportunity',
    allowedRoles: SALES_ANY,
  },
  {
    action: 'sales.opportunity.progress',
    description: 'Move an opportunity along its stages, or close it with a disposition',
    resourceType: 'opportunity',
    allowedRoles: SALES_ANY,
  },
  {
    action: 'sales.opportunity.assign',
    description: 'Assign or reassign an opportunity to a salesperson',
    resourceType: 'opportunity',
    allowedRoles: SALES_MANAGER_UP,
  },
  // ── the showroom floor ──────────────────────────────────────────────────
  {
    action: 'sales.visit.record',
    description: 'Record an arrival on the showroom floor',
    resourceType: null,
    allowedRoles: SALES_ANY,
  },
  {
    action: 'sales.visit.manage',
    description: 'Greet a waiting customer and close out their visit',
    resourceType: 'showroom_visit',
    allowedRoles: SALES_ANY,
  },
  {
    action: 'sales.floor.manage',
    description: 'Put a salesperson on the floor rotation, or take them off it',
    resourceType: null,
    allowedRoles: SALES_MANAGER_UP,
  },
  // ── selection and demonstration ─────────────────────────────────────────
  {
    action: 'sales.vehicle.shortlist',
    description: 'Shortlist a vehicle for a customer, and mark where it stands',
    resourceType: 'opportunity',
    allowedRoles: SALES_ANY,
  },
  {
    action: 'sales.demonstration.start',
    description: 'Start a test drive, after the licence has been checked',
    resourceType: 'opportunity',
    allowedRoles: SALES_ANY,
  },
  {
    action: 'sales.demonstration.manage',
    description: 'End a test drive and record what the customer thought',
    resourceType: 'demonstration',
    allowedRoles: SALES_ANY,
  },
  // ── follow-up, negotiation and oversight ────────────────────────────────
  {
    action: 'sales.activity.log',
    description: 'Log a note, call, message or follow-up task against an opportunity',
    resourceType: 'opportunity',
    allowedRoles: SALES_ANY,
  },
  {
    action: 'sales.negotiation.record',
    description: 'Record a round of negotiation — what was discussed, never a figure',
    resourceType: 'opportunity',
    allowedRoles: SALES_ANY,
  },
  {
    action: 'sales.turnover.record',
    description: 'Bring a manager into a deal, and record why',
    resourceType: 'opportunity',
    allowedRoles: SALES_ANY,
  },
] as const;

export function createSalesActionCatalog(): ActionCatalog {
  return createActionCatalog(SALES_ACTION_DEFINITIONS.map((d) => ({ ...d })));
}

/** The roles a dealership may put on sales work, for the invitation UI. */
export const SALES_ROLES: readonly string[] = [ROLES.SALES_MANAGER, ROLES.SALESPERSON];
