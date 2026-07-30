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
