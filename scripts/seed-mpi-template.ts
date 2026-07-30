/**
 * Seeds the standard bilingual MPI template for one tenant.
 *
 *   DATABASE_URL=... npx tsx scripts/seed-mpi-template.ts --tenant <uuid> [--location <uuid>]
 *
 * A seed script rather than a migration on purpose: `mpi_templates.tenant_id` is
 * NOT NULL — there is no such thing as a global template, so template creation is a
 * per-tenant operational act, not a schema change. Idempotent: if the tenant (at that
 * location scope) already has an active template with this name, nothing is written
 * and the existing id is reported.
 */
import { closePool, query } from '../src/shared/database/pool';
import {
  STANDARD_MPI_ITEMS,
  STANDARD_MPI_TEMPLATE_NAME,
} from '../src/modules/service-cockpit/domain/standard-mpi-template';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

export async function seedStandardMPITemplate(
  tenantId: string,
  locationId?: string,
): Promise<{ template_id: string; created: boolean }> {
  if (!UUID_RE.test(tenantId)) throw new Error('--tenant must be a UUID');
  if (locationId !== undefined && !UUID_RE.test(locationId)) throw new Error('--location must be a UUID');

  // Location scoping follows listMPITemplates: a NULL location_id template is
  // tenant-wide; a located template belongs to that location. The idempotency check
  // matches on the same scope it would insert into.
  const existing = (
    await query(
      `SELECT template_id FROM mpi_templates
        WHERE tenant_id=$1 AND name=$2 AND status='active' AND location_id IS NOT DISTINCT FROM $3`,
      [tenantId, STANDARD_MPI_TEMPLATE_NAME, locationId ?? null],
    )
  ).rows[0];
  if (existing) return { template_id: existing.template_id, created: false };

  const row = (
    await query(
      `INSERT INTO mpi_templates (tenant_id, location_id, name, version, items, status)
       VALUES ($1, $2, $3, 1, $4, 'active') RETURNING template_id`,
      [tenantId, locationId ?? null, STANDARD_MPI_TEMPLATE_NAME, JSON.stringify(STANDARD_MPI_ITEMS)],
    )
  ).rows[0];
  return { template_id: row.template_id, created: true };
}

async function main(): Promise<void> {
  const tenant = arg('tenant');
  if (!tenant) {
    console.error('Usage: npx tsx scripts/seed-mpi-template.ts --tenant <uuid> [--location <uuid>]');
    process.exit(2);
  }
  const result = await seedStandardMPITemplate(tenant, arg('location'));
  console.log(
    result.created
      ? `Created "${STANDARD_MPI_TEMPLATE_NAME}" (${STANDARD_MPI_ITEMS.length} items): ${result.template_id}`
      : `Already present: ${result.template_id} (nothing written)`,
  );
}

// Run only as a CLI; tests import seedStandardMPITemplate directly.
if (require.main === module) {
  main()
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => closePool());
}
