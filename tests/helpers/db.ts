import { randomUUID } from 'node:crypto';
import { query } from '../../src/shared/database/pool';
import { ROLES } from '../../src/shared/middleware/auth';
import type { AuthContext } from '../../src/modules/service-cockpit/services/service-cockpit-service';

/**
 * Integration tests need a real PostgreSQL instance, because what they verify —
 * transaction rollback, row locking, unique-index backstops, tenant predicates — has no
 * meaning against a mock. They are skipped rather than failed when one is not
 * configured, so `npm test` still works on a machine without a database.
 *
 * `TEST_DATABASE_URL` ONLY. This deliberately does not fall back to `DATABASE_URL`:
 * this suite calls TRUNCATE on every table, and a developer with a staging or
 * production URL exported in their shell would otherwise destroy it by running
 * `npm test`. Opting in has to be an explicit, separate act.
 */
export const INTEGRATION_DATABASE_URL = process.env.TEST_DATABASE_URL;

/**
 * Second gate: the database must also *name* itself as disposable. Even a deliberate
 * `TEST_DATABASE_URL` is refused unless the database name says so, which stops a
 * mistyped or copy-pasted connection string from wiping something real.
 */
const DISPOSABLE_NAME = /(^|[_-])(test|tmp|temp|scratch|ci)([_-]|$)/i;

function assertDisposable(url: string): void {
  let name: string;
  try {
    name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  } catch {
    throw new Error(`TEST_DATABASE_URL is not a valid URL: ${url}`);
  }
  if (!DISPOSABLE_NAME.test(name)) {
    throw new Error(
      `Refusing to run destructive integration tests against database "${name}". ` +
        'This suite TRUNCATEs every table. Name the database so it is obviously disposable ' +
        '(e.g. dealership_test, dealership_ci) or set ALLOW_DESTRUCTIVE_TESTS=1 to override.',
    );
  }
}

if (INTEGRATION_DATABASE_URL && process.env.ALLOW_DESTRUCTIVE_TESTS !== '1') {
  assertDisposable(INTEGRATION_DATABASE_URL);
}

// In CI the database-backed suites are REQUIRED: a missing TEST_DATABASE_URL must fail
// the build, not silently skip 72 tests and report green (FBL-000: "eliminate conditional
// skips for required suites"). Locally the skip remains so `npm test` works without a
// database.
if (process.env.REQUIRE_DB_TESTS === '1' && !INTEGRATION_DATABASE_URL) {
  throw new Error(
    'REQUIRE_DB_TESTS=1 but TEST_DATABASE_URL is not set — the database-backed suites are ' +
      'required in this environment and must not be skipped.',
  );
}

export const skipIntegration = !INTEGRATION_DATABASE_URL;

if (INTEGRATION_DATABASE_URL) {
  process.env.DATABASE_URL = INTEGRATION_DATABASE_URL;
}
process.env.JWT_SECRET ??= 'integration-test-jwt-secret-long-enough-value';
process.env.STEP_UP_SECRET ??= 'integration-test-step-up-secret-long-enough';

/** Every table the service writes, ordered so truncation is safe. */
const TABLES = [
  'service_waitlist_entries',
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
