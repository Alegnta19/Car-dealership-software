/**
 * FBL-000-R1 (correction D): proves the upgraded database is in the intended state.
 *
 *   DATABASE_URL=... npx tsx scripts/verify-upgrade-state.ts
 *
 * Run by the CI migration-upgrade job after the current chain is applied on top of the
 * f76a27a fixture + legacy seed. Asserts, with evidence on stdout:
 *   1. the legacy seed SURVIVED the upgrade (the known free-text rows still exist);
 *   2. the two CHECK constraints migration 050 adds over those columns are present and
 *      still NOT VALID (pg_constraint.convalidated = false) — new rows are checked,
 *      history is tolerated, exactly as designed. If someone ever makes them validate
 *      immediately, the upgrade itself fails earlier; if someone VALIDATEs them in a
 *      later migration without cleaning history first, this check fails.
 */
import { closePool, query } from '@dealer/database';

async function main(): Promise<void> {
  const failures: string[] = [];

  const constraints = (
    await query(
      `SELECT conname, convalidated FROM pg_constraint
        WHERE conname IN ('service_queue_items_queue_type_check','comeback_cases_root_cause_check')
        ORDER BY conname`,
    )
  ).rows as Array<{ conname: string; convalidated: boolean }>;

  for (const expected of [
    'comeback_cases_root_cause_check',
    'service_queue_items_queue_type_check',
  ]) {
    const row = constraints.find((c) => c.conname === expected);
    if (!row) failures.push(`constraint ${expected} is MISSING`);
    else if (row.convalidated !== false)
      failures.push(`constraint ${expected} is validated — expected NOT VALID`);
    else console.log(`constraint=${expected} convalidated=false (expected)`);
  }

  const seedChecks: Array<[string, string]> = [
    [
      'legacy free-text queue item',
      `SELECT COUNT(*)::int AS n FROM service_queue_items WHERE queue_type = 'legacy express lane'`,
    ],
    [
      'legacy free-text comeback case',
      `SELECT COUNT(*)::int AS n FROM comeback_cases WHERE root_cause_category = 'came back - misc'`,
    ],
    [
      'legacy non-numeric price_ref line',
      `SELECT COUNT(*)::int AS n FROM ro_line_items WHERE price_ref->>'amount_cents' = 'call for price'`,
    ],
    [
      'legacy repair orders',
      `SELECT COUNT(*)::int AS n FROM repair_orders WHERE tenant_id = '99999999-9999-4999-8999-999999999999'`,
    ],
  ];
  for (const [label, sql] of seedChecks) {
    const n = Number((await query(sql)).rows[0]?.n ?? 0);
    if (n < 1) failures.push(`${label}: expected >= 1 surviving row, found ${n}`);
    else console.log(`seed-survived=${JSON.stringify(label)} rows=${n}`);
  }

  // ── FBL-020 (migration 055): backfill reconciliation ─────────────────
  // Every legacy tenant_id must have become a pending-configuration tenant;
  // every legacy (tenant, location) pair must resolve to a rooftop whose id
  // IS the location_id, with an intact chain up to its tenant; and no user,
  // role binding, session, provider connection or policy decision may have
  // been invented by the migration.
  const orphanTenants = Number(
    (
      await query(
        `SELECT COUNT(*)::int AS n FROM (
           SELECT tenant_id FROM service_appointments UNION
           SELECT tenant_id FROM repair_orders UNION
           SELECT tenant_id FROM mpi_templates UNION
           SELECT tenant_id FROM service_queue_items UNION
           SELECT tenant_id FROM comeback_cases UNION
           SELECT tenant_id FROM service_waitlist_entries UNION
           SELECT tenant_id FROM first_service_offers UNION
           SELECT tenant_id FROM audit_events
         ) legacy WHERE tenant_id NOT IN (SELECT tenant_id FROM tenants)`,
      )
    ).rows[0]?.n ?? -1,
  );
  if (orphanTenants !== 0)
    failures.push(`backfill: ${orphanTenants} legacy tenant_id(s) missing from tenants`);
  else console.log('backfill-tenants=complete');

  const nonPending = Number(
    (await query(`SELECT COUNT(*)::int AS n FROM tenants WHERE status <> 'pending_configuration'`))
      .rows[0]?.n ?? -1,
  );
  if (nonPending !== 0)
    failures.push(
      `backfill: ${nonPending} tenant(s) not pending_configuration — 055 must not activate anything`,
    );
  else console.log('backfill-tenants-status=pending_configuration');

  const orphanRooftops = Number(
    (
      await query(
        `SELECT COUNT(*)::int AS n FROM (
           SELECT tenant_id, location_id FROM service_appointments WHERE location_id IS NOT NULL UNION
           SELECT tenant_id, location_id FROM repair_orders WHERE location_id IS NOT NULL UNION
           SELECT tenant_id, location_id FROM mpi_templates WHERE location_id IS NOT NULL UNION
           SELECT tenant_id, location_id FROM tech_profiles WHERE location_id IS NOT NULL UNION
           SELECT tenant_id, location_id FROM service_queue_items WHERE location_id IS NOT NULL UNION
           SELECT tenant_id, location_id FROM first_service_offers WHERE location_id IS NOT NULL UNION
           SELECT tenant_id, location_id FROM service_waitlist_entries WHERE location_id IS NOT NULL
         ) legacy
         WHERE NOT EXISTS (
           SELECT 1 FROM rooftops r
            WHERE r.rooftop_id = legacy.location_id AND r.tenant_id = legacy.tenant_id
         )`,
      )
    ).rows[0]?.n ?? -1,
  );
  if (orphanRooftops !== 0)
    failures.push(
      `backfill: ${orphanRooftops} legacy (tenant, location) pair(s) without a matching rooftop`,
    );
  else console.log('backfill-rooftops=complete (rooftop_id = legacy location_id)');

  const brokenChains = Number(
    (
      await query(
        `SELECT COUNT(*)::int AS n FROM rooftops r
          WHERE NOT EXISTS (
            SELECT 1 FROM legal_entities le
            JOIN dealer_groups g
              ON g.tenant_id = le.tenant_id AND g.dealer_group_id = le.dealer_group_id
            JOIN tenants t ON t.tenant_id = le.tenant_id
            WHERE le.tenant_id = r.tenant_id AND le.legal_entity_id = r.legal_entity_id
          )`,
      )
    ).rows[0]?.n ?? -1,
  );
  if (brokenChains !== 0)
    failures.push(`backfill: ${brokenChains} rooftop(s) with a broken ancestor chain`);
  else console.log('backfill-ancestry=intact');

  for (const table of [
    'user_links',
    'identity_sessions',
    'role_bindings',
    'identity_provider_connections',
    'policy_decisions',
    'reauthentication_transactions',
    'reauthentication_grants',
    'support_access_requests',
    'support_access_sessions',
  ]) {
    // role-binding-effectiveness-opt-out(all-bindings-including-ineffective): this
    // counts EVERY row in each identity table, `role_bindings` among them, to assert
    // that migration 055 invented no identities and no evidence. A count that
    // filtered by effectiveness would report zero for a table holding a future-dated
    // or aged-out binding and so would pass while the upgrade had in fact fabricated
    // a standing grant — the precise thing this assertion exists to catch. It reads
    // the table as it is and decides nothing about what any row authorizes.
    const n = Number((await query(`SELECT COUNT(*)::int AS n FROM ${table}`)).rows[0]?.n ?? -1);
    if (n !== 0)
      failures.push(
        `backfill: ${table} has ${n} row(s) — 055 must invent no identities or evidence`,
      );
    else console.log(`backfill-empty=${table}`);
  }

  if (failures.length > 0) {
    for (const f of failures) console.error('FAIL: ' + f);
    process.exitCode = 1;
    return;
  }
  console.log('Upgrade-state verification OK.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
