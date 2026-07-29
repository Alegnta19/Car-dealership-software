import { randomUUID } from 'node:crypto';
import { query } from '../../src/shared/database/pool';
import { ROLES } from '../../src/shared/middleware/auth';
import type { AuthContext } from '../../src/modules/service-cockpit/services/service-cockpit-service';

/**
 * Integration tests need a real PostgreSQL instance, because what they verify —
 * transaction rollback, row locking, unique-index backstops, tenant predicates — has no
 * meaning against a mock. They are skipped rather than failed when one is not
 * configured, so `npm test` still works on a machine without a database.
 */
export const INTEGRATION_DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
export const skipIntegration = !INTEGRATION_DATABASE_URL;

if (INTEGRATION_DATABASE_URL) {
  process.env.DATABASE_URL = INTEGRATION_DATABASE_URL;
}
process.env.JWT_SECRET ??= 'integration-test-jwt-secret-long-enough-value';
process.env.STEP_UP_SECRET ??= 'integration-test-step-up-secret-long-enough';

/** Every table the service writes, ordered so truncation is safe. */
const TABLES = [
  'step_up_token_uses', 'service_sla_defaults', 'first_service_offers', 'service_portal_tasks',
  'service_queue_items', 'comeback_cases', 'warranty_claims', 'tech_time_entries', 'tech_work_tickets',
  'tech_profiles', 'ro_sublet_jobs', 'ro_parts_lines', 'ro_authorizations', 'ro_estimates',
  'service_recommendations', 'mpi_results', 'mpi_sessions', 'mpi_templates', 'ro_line_items',
  'ro_events', 'repair_orders', 'service_appointment_events', 'service_appointments', 'audit_events',
];

export async function resetDatabase(): Promise<void> {
  await query(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);
}

export interface TestWorld {
  tenantA: AuthContext;
  tenantB: AuthContext;
  technician: AuthContext;
  locationA: string;
  locationB: string;
  customer: string;
  vehicle: string;
}

export function makeWorld(): TestWorld {
  const tenantAId = randomUUID();
  const tenantBId = randomUUID();
  return {
    tenantA: { tenantId: tenantAId, userId: randomUUID(), roles: [ROLES.SERVICE_ADVISOR] },
    tenantB: { tenantId: tenantBId, userId: randomUUID(), roles: [ROLES.SERVICE_ADVISOR] },
    technician: { tenantId: tenantAId, userId: randomUUID(), roles: [ROLES.TECHNICIAN] },
    locationA: randomUUID(),
    locationB: randomUUID(),
    customer: randomUUID(),
    vehicle: randomUUID(),
  };
}

/** Registers a technician so dispatch has someone to assign work to. */
export async function seedTechnician(ctx: AuthContext, locationId: string, techUserId: string): Promise<void> {
  await query(
    `INSERT INTO tech_profiles (tech_profile_id,tenant_id,tech_user_id,location_id,status)
     VALUES ($1,$2,$3,$4,'active')`,
    [randomUUID(), ctx.tenantId, techUserId, locationId],
  );
}

export async function seedMPITemplate(ctx: AuthContext, locationId: string): Promise<string> {
  const templateId = randomUUID();
  await query(
    `INSERT INTO mpi_templates (template_id,tenant_id,location_id,name,items,status)
     VALUES ($1,$2,$3,'Standard MPI','[]','active')`,
    [templateId, ctx.tenantId, locationId],
  );
  return templateId;
}

export async function countRows(table: string, where: string, params: unknown[]): Promise<number> {
  const result = await query(`SELECT COUNT(*)::int AS cnt FROM ${table} WHERE ${where}`, params);
  return Number(result.rows[0].cnt);
}
