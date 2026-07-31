/**
 * THE Fixed Ops action catalog (FBL-020): every service-cockpit capability as
 * one named action. Routes declare actions from this catalog — never role
 * arrays — and the central policy engine decides against database
 * RoleBindings. The role lists here are the action->role matrix (who MAY be
 * granted a role that performs this), not a bypass: possession of a role
 * matters only as a RoleBinding row.
 *
 * One action per HTTP capability, exactly mirroring the 44-endpoint contract
 * snapshot. `sensitive: true` marks actions that may additionally demand a
 * provider-backed reauthentication grant (ADR-006) under their domain rules.
 */
import { ROLES } from '@dealer/contracts';
import {
  createActionCatalog,
  type ActionCatalog,
  type ActionDefinition,
} from '@dealer/identity-access';

const ADVISOR_UP = [ROLES.SERVICE_ADVISOR, ROLES.SERVICE_MANAGER];
const TECH_UP = [ROLES.SERVICE_ADVISOR, ROLES.SERVICE_MANAGER, ROLES.TECHNICIAN];
const PARTS_UP = [ROLES.PARTS_CLERK, ROLES.SERVICE_ADVISOR, ROLES.SERVICE_MANAGER];
const ALL_READ = [
  ROLES.PARTS_CLERK,
  ROLES.SERVICE_ADVISOR,
  ROLES.SERVICE_MANAGER,
  ROLES.TECHNICIAN,
  ROLES.VIEWER,
  ROLES.WARRANTY_ADMIN,
];

export const SERVICE_ACTION_DEFINITIONS: readonly ActionDefinition[] = [
  // appointments
  {
    action: 'service.appointment.create',
    description: 'Create a service appointment',
    resourceType: null,
    allowedRoles: ADVISOR_UP,
  },
  {
    action: 'service.appointment.update',
    description: 'Amend a service appointment',
    resourceType: 'service_appointment',
    allowedRoles: ADVISOR_UP,
  },
  {
    action: 'service.appointment.check_in',
    description: 'Check a vehicle in (opens the RO path)',
    resourceType: 'service_appointment',
    allowedRoles: ADVISOR_UP,
  },
  {
    action: 'service.appointment.confirm',
    description: 'Confirm an appointment',
    resourceType: 'service_appointment',
    allowedRoles: ADVISOR_UP,
  },
  {
    action: 'service.appointment.no_show',
    description: 'Record a no-show',
    resourceType: 'service_appointment',
    allowedRoles: ADVISOR_UP,
  },
  // comebacks
  {
    action: 'service.comeback.create',
    description: 'Open a comeback case',
    resourceType: null,
    allowedRoles: ADVISOR_UP,
  },
  {
    action: 'service.comeback.update',
    description: 'Progress a comeback case',
    resourceType: 'comeback_case',
    allowedRoles: ADVISOR_UP,
  },
  // dispatch + queues
  {
    action: 'service.dispatch.assign',
    description: 'Dispatch work to a technician',
    resourceType: null,
    allowedRoles: ADVISOR_UP,
  },
  {
    action: 'service.queue.view',
    description: 'View service queues',
    resourceType: null,
    allowedRoles: ALL_READ,
  },
  {
    action: 'service.queue.assign',
    description: 'Assign a queue item',
    resourceType: 'service_queue_item',
    allowedRoles: TECH_UP,
  },
  {
    action: 'service.queue.escalate',
    description: 'Escalate a queue item',
    resourceType: 'service_queue_item',
    allowedRoles: [ROLES.SERVICE_MANAGER],
  },
  {
    action: 'service.queue.update_status',
    description: 'Update a queue item status',
    resourceType: 'service_queue_item',
    allowedRoles: TECH_UP,
  },
  // cockpit reads
  {
    action: 'service.cockpit.view',
    description: 'View the service home cockpit',
    resourceType: null,
    allowedRoles: ALL_READ,
  },
  {
    action: 'service.cockpit.query',
    description: 'Run a cockpit query view',
    resourceType: null,
    allowedRoles: ALL_READ,
  },
  // intake + retention
  {
    action: 'service.intake.quick_start',
    description: 'Quick-start intake for a walk-in',
    resourceType: null,
    allowedRoles: ADVISOR_UP,
  },
  {
    action: 'service.retention.record_first_service',
    description: 'Record a first-service retention offer',
    resourceType: null,
    allowedRoles: ADVISOR_UP,
  },
  // MPI
  {
    action: 'service.mpi.view_templates',
    description: 'List MPI templates',
    resourceType: null,
    allowedRoles: ALL_READ,
  },
  {
    action: 'service.mpi.start',
    description: 'Start an MPI session on a repair order',
    resourceType: 'repair_order',
    allowedRoles: TECH_UP,
  },
  {
    action: 'service.mpi.record_results',
    description: 'Record MPI results',
    resourceType: 'mpi_session',
    allowedRoles: TECH_UP,
  },
  {
    action: 'service.mpi.submit',
    description: 'Submit a completed MPI',
    resourceType: 'mpi_session',
    allowedRoles: TECH_UP,
  },
  // parts
  {
    action: 'service.parts.request',
    description: 'Request parts for a repair order',
    resourceType: 'repair_order',
    allowedRoles: PARTS_UP,
  },
  {
    action: 'service.parts.update',
    description: 'Progress a parts line',
    resourceType: 'ro_parts_line',
    allowedRoles: PARTS_UP,
  },
  // portal tasks
  {
    action: 'service.portal_task.view',
    description: 'View portal tasks for a repair order',
    resourceType: 'repair_order',
    allowedRoles: ALL_READ,
  },
  {
    action: 'service.portal_task.update',
    description: 'Progress a portal task',
    resourceType: 'service_portal_task',
    allowedRoles: ADVISOR_UP,
  },
  // repair orders
  {
    action: 'service.ro.create',
    description: 'Open a repair order',
    resourceType: null,
    allowedRoles: ADVISOR_UP,
  },
  {
    action: 'service.ro.view',
    description: 'View a repair order',
    resourceType: 'repair_order',
    allowedRoles: ALL_READ,
  },
  {
    action: 'service.ro.transition',
    description: 'Transition repair-order state',
    resourceType: 'repair_order',
    allowedRoles: ADVISOR_UP,
  },
  {
    action: 'service.ro.line_item.create',
    description: 'Add a repair-order line item',
    resourceType: 'repair_order',
    allowedRoles: ADVISOR_UP,
  },
  {
    action: 'service.ro.line_item.update',
    description: 'Progress a repair-order line item',
    resourceType: 'ro_line_item',
    allowedRoles: TECH_UP,
  },
  {
    action: 'service.ro.estimate.generate',
    description: 'Generate an estimate',
    resourceType: 'repair_order',
    allowedRoles: ADVISOR_UP,
  },
  {
    action: 'service.ro.estimate.send',
    description: 'Send an estimate to the customer',
    resourceType: 'repair_order',
    allowedRoles: ADVISOR_UP,
  },
  {
    action: 'service.ro.authorization.record',
    description:
      'Record a customer authorization decision (staff-asserted methods demand a reauthentication grant)',
    resourceType: 'repair_order',
    allowedRoles: ADVISOR_UP,
    sensitive: true,
  },
  {
    action: 'service.ro.authorization.view',
    description: 'View authorizations on a repair order',
    resourceType: 'repair_order',
    allowedRoles: ALL_READ,
  },
  {
    action: 'service.ro.recommendation.send',
    description: 'Send recommendations to the customer',
    resourceType: 'repair_order',
    allowedRoles: ADVISOR_UP,
  },
  {
    action: 'service.ro.sublet.create',
    description: 'Create a sublet job on a repair order',
    resourceType: 'repair_order',
    allowedRoles: PARTS_UP,
  },
  {
    action: 'service.sublet.update',
    description: 'Progress a sublet job',
    resourceType: 'ro_sublet_job',
    allowedRoles: PARTS_UP,
  },
  // technicians
  {
    action: 'service.tech.ticket_status',
    description: 'Update a work-ticket status',
    resourceType: 'tech_work_ticket',
    allowedRoles: TECH_UP,
  },
  {
    action: 'service.tech.ticket_time',
    description: 'Record time on a work ticket',
    resourceType: 'tech_work_ticket',
    allowedRoles: TECH_UP,
  },
  // waitlist
  {
    action: 'service.waitlist.view',
    description: 'View the waitlist',
    resourceType: null,
    allowedRoles: ALL_READ,
  },
  {
    action: 'service.waitlist.create',
    description: 'Add a waitlist entry',
    resourceType: null,
    allowedRoles: ADVISOR_UP,
  },
  {
    action: 'service.waitlist.cancel',
    description: 'Cancel a waitlist entry',
    resourceType: 'service_waitlist_entry',
    allowedRoles: ADVISOR_UP,
  },
  {
    action: 'service.waitlist.convert',
    description: 'Convert a waitlist entry to an appointment',
    resourceType: 'service_waitlist_entry',
    allowedRoles: ADVISOR_UP,
  },
  {
    action: 'service.waitlist.offer',
    description: 'Offer a slot to a waitlist entry',
    resourceType: 'service_waitlist_entry',
    allowedRoles: ADVISOR_UP,
  },
  // warranty
  {
    action: 'service.warranty.claim_create',
    description: 'Create a warranty claim',
    resourceType: null,
    allowedRoles: [ROLES.SERVICE_ADVISOR, ROLES.SERVICE_MANAGER, ROLES.WARRANTY_ADMIN],
  },
];

export function createServiceActionCatalog(): ActionCatalog {
  return createActionCatalog(SERVICE_ACTION_DEFINITIONS);
}
