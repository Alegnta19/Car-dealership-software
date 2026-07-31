/**
 * Fixed Ops' implementation of the policy engine's ResourceScopeResolver
 * port (FBL-020). Resolves a service resource to the organization node it
 * lives under — its rooftop, via the legacy location_id column, which IS the
 * rooftop id after the migration-055 backfill. Composed into the engine at
 * the application root: identity-access never touches these tables, and this
 * module never decides policy.
 *
 * Every lookup is tenant-scoped, so a resource from another tenant resolves
 * to null exactly like a resource that does not exist — non-enumeration
 * starts here.
 */
import { query } from '@dealer/database';
import type { OrganizationNodeRef, ResourceScopeResolver } from '@dealer/identity-access';

/** direct: the table carries location_id itself */
const DIRECT: Record<string, { table: string; pk: string }> = {
  service_appointment: { table: 'service_appointments', pk: 'appointment_id' },
  repair_order: { table: 'repair_orders', pk: 'ro_id' },
  service_queue_item: { table: 'service_queue_items', pk: 'queue_item_id' },
  service_waitlist_entry: { table: 'service_waitlist_entries', pk: 'waitlist_entry_id' },
};

/** via repair order: the table joins repair_orders through an RO column */
const VIA_RO: Record<string, { table: string; pk: string; roColumn: string }> = {
  mpi_session: { table: 'mpi_sessions', pk: 'mpi_session_id', roColumn: 'ro_id' },
  ro_line_item: { table: 'ro_line_items', pk: 'line_item_id', roColumn: 'ro_id' },
  ro_parts_line: { table: 'ro_parts_lines', pk: 'part_line_id', roColumn: 'ro_id' },
  ro_sublet_job: { table: 'ro_sublet_jobs', pk: 'sublet_job_id', roColumn: 'ro_id' },
  service_portal_task: { table: 'service_portal_tasks', pk: 'portal_task_id', roColumn: 'ro_id' },
  tech_work_ticket: { table: 'tech_work_tickets', pk: 'ticket_id', roColumn: 'ro_id' },
  warranty_claim: { table: 'warranty_claims', pk: 'claim_id', roColumn: 'ro_id' },
  comeback_case: { table: 'comeback_cases', pk: 'comeback_id', roColumn: 'original_ro_id' },
};

interface Row {
  [key: string]: unknown;
}

export const resolveServiceResourceScope: ResourceScopeResolver = async (
  tenantId: string,
  resourceType: string,
  resourceId: string,
): Promise<OrganizationNodeRef | null> => {
  const direct = DIRECT[resourceType];
  if (direct !== undefined) {
    const result = await query(
      `SELECT location_id FROM ${direct.table} WHERE tenant_id = $1 AND ${direct.pk} = $2`,
      [tenantId, resourceId],
    );
    if (result.rows.length === 0) return null;
    return { level: 'rooftop', id: String((result.rows[0] as Row).location_id) };
  }

  const viaRo = VIA_RO[resourceType];
  if (viaRo !== undefined) {
    const result = await query(
      `SELECT ro.location_id FROM ${viaRo.table} t
         JOIN repair_orders ro ON ro.tenant_id = t.tenant_id AND ro.ro_id = t.${viaRo.roColumn}
        WHERE t.tenant_id = $1 AND t.${viaRo.pk} = $2`,
      [tenantId, resourceId],
    );
    if (result.rows.length === 0) return null;
    return { level: 'rooftop', id: String((result.rows[0] as Row).location_id) };
  }

  // an unknown resource type resolves to nothing — deny, never guess
  return null;
};
