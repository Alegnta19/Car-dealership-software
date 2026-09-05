import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { loadAcceptanceRows, rowProblems } from '../scripts/check-fbl120-rows';
import { CONTROLS } from '../scripts/database-control-mutations';
import { MUTATIONS } from '../scripts/mutation-kill';

/**
 * ROW 7 — THE DELIVERY PROOF, which is a claim about this repository rather
 * than about any one service.
 *
 * The order asks for the seven rows LOCKED before coding and returned as a
 * seven-row checklist at the finish line. `scripts/check-fbl120-rows.ts` holds
 * the first half — a row that reaches PROVEN must name tests that exist. This
 * battery holds the second: at the finish line every row IS proven, the journey
 * was walked by two different people through the shipped console, and the
 * documents say what the repository actually contains.
 *
 * IT NEEDS NO DATABASE. Everything here is a fact about files, which is exactly
 * what makes it a delivery proof rather than another service test.
 */
const ROOT = join(__dirname, '..');

function read(...rel: string[]): string {
  return readFileSync(join(ROOT, ...rel), 'utf8');
}

interface JourneyStage {
  readonly stage: number;
  readonly who: string;
  readonly what: string;
  readonly [key: string]: unknown;
}

interface Journey {
  readonly phase: string;
  readonly identities: Record<string, string>;
  readonly stages: readonly JourneyStage[];
  readonly no_identifier_was_typed: boolean;
  readonly manager_view: Record<string, unknown>;
}

describe('desking: the delivery says what this repository holds (FBL-120 Row 7)', () => {
  test('all seven acceptance rows are proven, and each names tests this repository declares', () => {
    const record = loadAcceptanceRows();
    assert.equal(record.rows.length, 7);
    assert.deepEqual(rowProblems(record), []);
    for (const row of record.rows) {
      assert.equal(row.state, 'PROVEN', `Row ${row.row} (${row.title}) is not proven`);
      assert.ok(row.tests.length > 0, `Row ${row.row} names no test`);
    }
  });

  test('the rows are quoted from the order, not paraphrased from memory', () => {
    const record = loadAcceptanceRows();
    assert.equal(record.order.version_label, 'Version 3.1');
    assert.equal(record.order.section, '14.3 Part B');
    assert.ok(existsSync(join(ROOT, record.order.repository_path)), 'the order must be committed');
    // Each quotation is the order's own sentence, opening with its own row number.
    for (const row of record.rows) {
      assert.match(row.order_text, new RegExp(`^Row ${row.row} - `));
      assert.ok(row.order_text.length > 120, `Row ${row.row} is quoted too thinly to be the order`);
    }
    assert.match(record.exclusions, /^FBL-120 exclusions\./);
    assert.match(record.binary_proof, /^FBL-120 binary proof\./);
  });

  test('the journey was walked in the shipped console by two different people', () => {
    const journey = JSON.parse(read('docs', 'evidence', 'FBL-120-OWNER-JOURNEY.json')) as Journey;
    assert.equal(journey.phase, 'FBL-120');
    const who = new Set(journey.stages.map((s) => s.who));
    assert.ok(who.has('salesperson'), 'a salesperson walked part of it');
    assert.ok(who.has('sales_manager'), 'and a manager walked the rest');
    assert.ok(
      journey.identities.salesperson !== journey.identities.sales_manager,
      'two identities, not one login wearing both hats',
    );
    assert.ok(journey.stages.length >= 20, `only ${journey.stages.length} stages were recorded`);
    for (let i = 0; i < journey.stages.length; i += 1) {
      assert.equal(journey.stages[i]?.stage, i + 1, 'the stages are numbered in the order walked');
    }
  });

  test('nothing in the journey was reached by typing an identifier', () => {
    const journey = JSON.parse(read('docs', 'evidence', 'FBL-120-OWNER-JOURNEY.json')) as Journey;
    assert.equal(journey.no_identifier_was_typed, true);
    for (const stage of journey.stages) {
      if (typeof stage.typed === 'string') {
        assert.doesNotMatch(
          stage.typed,
          /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
          `stage ${stage.stage} typed an identifier`,
        );
      }
    }
  });

  test('the manager view carries figures, and says NOT_YET_AVAILABLE for what this phase lacks', () => {
    const journey = JSON.parse(read('docs', 'evidence', 'FBL-120-OWNER-JOURNEY.json')) as Journey;
    const view = journey.manager_view;
    // The board's own field, as the API actually serialises it — asserting a
    // shape the console never receives would prove nothing about the console.
    const absent = view.notYetAvailable as Record<string, string>;
    for (const name of [
      'gross',
      'revenue',
      'commission',
      'close',
      'roi',
      'deal',
      'sold_inventory',
      'delivery',
    ]) {
      assert.equal(absent[name], 'NOT_YET_AVAILABLE', `${name} must not carry a figure`);
    }
    /*
     * …and a DEPTH WALK over the whole recorded view, because a field named for
     * money that carries anything else is the failure this assertion exists to
     * catch — the placeholder being present says nothing about the field beside
     * it.
     */
    const moneyNamed = /gross|revenue|commission|close_rate|roi|deal_value|sold|delivery/i;
    const walk = (node: unknown, path: string): void => {
      if (node === null || typeof node !== 'object') return;
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (moneyNamed.test(k) && (typeof v === 'string' || typeof v === 'number')) {
          assert.equal(
            String(v),
            'NOT_YET_AVAILABLE',
            `${path}.${k} carries ${String(v)} in a phase that has no such figure`,
          );
        }
        walk(v, `${path}.${k}`);
      }
    };
    walk(view, 'manager_view');
  });

  test('every FBL-120 control the registries declare names a test that exists', () => {
    const fbl120Mutations = MUTATIONS.filter((m) => m.file.startsWith('packages/desking/'));
    assert.ok(fbl120Mutations.length >= 12, `only ${fbl120Mutations.length} runtime mutations`);
    const fbl120Controls = CONTROLS.filter((c) => c.section.startsWith('065 '));
    assert.ok(fbl120Controls.length >= 8, `only ${fbl120Controls.length} database controls`);
    for (const m of fbl120Mutations) {
      assert.ok(existsSync(join(ROOT, m.file)), `${m.id}: ${m.file}`);
      assert.equal(
        read(...m.file.split('/')).split(m.from).length - 1,
        1,
        `${m.id}: its anchor must occur exactly once in ${m.file}`,
      );
      assert.ok(existsSync(join(ROOT, m.testFile)), `${m.id}: ${m.testFile}`);
    }
    for (const c of fbl120Controls) {
      assert.ok(existsSync(join(ROOT, c.testFile)), `${c.id}: ${c.testFile}`);
    }
  });

  test('the delivery report names the order, the seam and the constraint this phase did NOT relax', () => {
    const report = read('docs', 'FBL-120-DELIVERY-REPORT.md');
    assert.match(report, /Version 3\.1/);
    assert.match(report, /c57894f4/, 'the order is named by digest');
    assert.match(report, /ck_attribution_pre_sale_revenue/);
    assert.match(
      report,
      /still in force/i,
      'migration 064 predicted this phase would relax it; the report says plainly that it did not',
    );
    assert.match(report, /ck_desking_pre_fbl120/, 'and names the pin it DID take off');
    for (const row of loadAcceptanceRows().rows) {
      assert.ok(
        report.includes(`Row ${row.row} — ${row.title}`),
        `the report does not account for Row ${row.row}`,
      );
    }
  });
});
