/**
 * RELEASE TRAIN 3 — THE CRM AND MARKETING ACTION CATALOG.
 *
 * Every route on this surface names one of these, and the policy engine decides
 * it from database-authoritative role bindings. The two shapes matter:
 *
 *   * AN ACTION WITH A `resourceType` IS ROOFTOP-SCOPED. The engine resolves the
 *     named resource to the rooftop that owns it, walks that rooftop's
 *     ancestry, and admits only a binding sitting on the chain — so an agent
 *     bound at one store reaching another store's lead is told the lead does
 *     not exist, rather than that they are forbidden. Everything hanging off a
 *     lead is authorized THROUGH the lead, which is why `leadId` is the route
 *     parameter even for a note or an appointment.
 *   * AN ACTION WITHOUT ONE IS TENANT-SCOPED. Consent and suppression are
 *     statements about a person and an address, not about a store, so they are
 *     tenant-scoped by design: an unsubscribe recorded at one rooftop must stop
 *     contact from every rooftop, and scoping it to a store would create a
 *     dealership that keeps emailing somebody who asked it not to.
 *
 * THE THREE ROLES ARE NOT INTERCHANGEABLE. A BDC agent works the leads —
 * answer, log, book, qualify, hand over. A marketing manager decides who gets
 * contacted at all: campaigns, audiences, approval, suppression and
 * attribution. A tenant admin is the dealership's owner and may do both.
 *
 * APPROVAL IS SEPARATED FROM DRAFTING ON PURPOSE. `marketing.campaign.draft`
 * and `marketing.campaign.approve` are different actions so that a dealership
 * can, if it chooses, put them in different hands — which is the whole point of
 * having an approval step rather than a save button.
 */
import { ROLES } from '@dealer/contracts';
import {
  TENANT_ADMIN_ROLE,
  createActionCatalog,
  type ActionCatalog,
} from '@dealer/identity-access';

/** Anyone who works leads at all. */
const CRM_ANY: readonly string[] = [TENANT_ADMIN_ROLE, ROLES.MARKETING_MANAGER, ROLES.BDC_AGENT];

/** Decisions about who is contacted, and about the record of it. */
const MARKETING_MANAGER_UP: readonly string[] = [TENANT_ADMIN_ROLE, ROLES.MARKETING_MANAGER];

export const CRM_ACTION_DEFINITIONS = [
  // ── row 1: intake and identity ──────────────────────────────────────────
  {
    action: 'crm.lead.view',
    description: 'Read leads and their timeline',
    resourceType: null,
    allowedRoles: CRM_ANY,
  },
  {
    action: 'crm.lead.capture',
    description: 'Capture a lead from any channel, resolving it to one customer',
    resourceType: null,
    allowedRoles: CRM_ANY,
  },
  {
    action: 'crm.lead.read',
    description: 'Read one lead',
    resourceType: 'lead',
    allowedRoles: CRM_ANY,
  },
  {
    action: 'crm.source.view',
    description: 'Read the lead source catalog',
    resourceType: null,
    allowedRoles: CRM_ANY,
  },
  {
    action: 'crm.source.manage',
    description: 'Define and retire lead sources',
    resourceType: null,
    allowedRoles: MARKETING_MANAGER_UP,
  },
  // ── row 2: routing and lifecycle ────────────────────────────────────────
  {
    action: 'crm.lead.assign',
    description: 'Assign or reassign a lead, or return it to a queue',
    resourceType: 'lead',
    allowedRoles: CRM_ANY,
  },
  {
    action: 'crm.lead.transition',
    description: 'Move a lead along its lifecycle, or close it with a disposition',
    resourceType: 'lead',
    allowedRoles: CRM_ANY,
  },
  {
    action: 'crm.lead.hand_off',
    description: 'Hand a qualified lead to sales, freezing what was handed over',
    resourceType: 'lead',
    allowedRoles: CRM_ANY,
  },
  {
    action: 'crm.queue.manage',
    description: 'Create and retire lead queues',
    resourceType: null,
    allowedRoles: MARKETING_MANAGER_UP,
  },
  {
    action: 'crm.sla.manage',
    description: 'Set the response and escalation policy for a rooftop',
    resourceType: null,
    allowedRoles: MARKETING_MANAGER_UP,
  },
  // ── row 3: activity and appointments ────────────────────────────────────
  {
    action: 'crm.activity.log',
    description: 'Log a task, note, call, email, message or reminder against a lead',
    resourceType: 'lead',
    allowedRoles: CRM_ANY,
  },
  {
    action: 'crm.appointment.schedule',
    description: 'Book an appointment for a lead',
    resourceType: 'lead',
    allowedRoles: CRM_ANY,
  },
  {
    action: 'crm.appointment.manage',
    description: 'Reschedule, confirm, complete or cancel an appointment',
    resourceType: 'appointment',
    allowedRoles: CRM_ANY,
  },
  // ── row 4: consent-safe campaigns ───────────────────────────────────────
  {
    action: 'crm.consent.view',
    description: 'Read consent and the suppression list',
    resourceType: null,
    allowedRoles: CRM_ANY,
  },
  {
    action: 'crm.consent.record',
    description: 'Record consent per channel and purpose, and suppress a contact value',
    resourceType: null,
    allowedRoles: MARKETING_MANAGER_UP,
  },
  {
    action: 'marketing.campaign.view',
    description: 'Read campaigns, versions and their delivery results',
    resourceType: null,
    allowedRoles: CRM_ANY,
  },
  {
    action: 'marketing.campaign.create',
    description: 'Create a campaign',
    resourceType: null,
    allowedRoles: MARKETING_MANAGER_UP,
  },
  {
    action: 'marketing.campaign.draft',
    description: 'Draft a campaign version, its message and its audience',
    resourceType: 'campaign',
    allowedRoles: MARKETING_MANAGER_UP,
  },
  {
    action: 'marketing.campaign.approve',
    description: 'Approve a campaign version for sending',
    resourceType: 'campaign',
    allowedRoles: MARKETING_MANAGER_UP,
  },
  {
    action: 'marketing.campaign.execute',
    description: 'Launch an approved campaign version',
    resourceType: 'campaign',
    allowedRoles: MARKETING_MANAGER_UP,
  },
  {
    action: 'marketing.campaign.reconcile',
    description: 'Record a provider answer or a customer response against a send',
    resourceType: 'campaign',
    allowedRoles: MARKETING_MANAGER_UP,
  },
  // ── row 5: attribution ──────────────────────────────────────────────────
  {
    action: 'marketing.attribution.view',
    description: 'Read attribution results, and the revenue availability status',
    resourceType: null,
    allowedRoles: CRM_ANY,
  },
  {
    action: 'marketing.attribution.compute',
    description: 'Compute a versioned attribution run over the immutable touch history',
    resourceType: null,
    allowedRoles: MARKETING_MANAGER_UP,
  },
] as const;

export function createCrmActionCatalog(): ActionCatalog {
  return createActionCatalog(CRM_ACTION_DEFINITIONS.map((d) => ({ ...d })));
}

/** The roles a dealership may put on CRM and marketing work, for the invitation UI. */
export const CRM_ROLES: readonly string[] = [ROLES.MARKETING_MANAGER, ROLES.BDC_AGENT];
