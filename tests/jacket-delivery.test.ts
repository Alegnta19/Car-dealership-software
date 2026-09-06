import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { fbl140RowProblems, loadFbl140Rows } from '../scripts/check-fbl140-rows';
import { CONTROLS } from '../scripts/database-control-mutations';
import { MUTATIONS } from '../scripts/mutation-kill';

/**
 * OUTCOME 8 — THE REAL PERSISTED USER JOURNEY, AND THE DELIVERY PROOF.
 *
 * "Demonstrate the shipped UI without raw UUID entry: salesperson opens the
 * approved desking result and assembles the jacket; required documents and
 * missing items are visible; an authorized manager completes any configured
 * review; a separate customer identity receives, reviews, consents, and signs
 * the exact package; staff sees the completed certificate and immutable
 * timeline; an unauthorized user cannot approve or sign for another actor;
 * package supersession preserves the earlier package, figures, signatures, and
 * decisions."
 *
 * The order asks for the eight outcomes LOCKED before coding and returned proven
 * at the finish line. `scripts/check-fbl140-rows.ts` holds the first half — a
 * row that reaches PROVEN must name tests that exist, quoted verbatim from the
 * committed order. This battery holds the second: at the finish line every
 * outcome IS proven, the journey was walked by four different people through
 * the shipped console and the shipped signing page, and the documents say what
 * the repository actually contains.
 *
 * IT NEEDS NO DATABASE. Everything here is a fact about files.
 */
const ROOT = join(__dirname, '..');

function read(...rel: string[]): string {
  return readFileSync(join(ROOT, ...rel), 'utf8');
}

interface JourneyStage {
  readonly stage: number;
  readonly who: string;
  readonly what: string;
  readonly saw?: string;
  readonly typed?: string;
  readonly refused?: number;
}

interface Journey {
  readonly phase: string;
  readonly walked_in: string;
  readonly identities: Record<string, string>;
  readonly stages: readonly JourneyStage[];
  readonly refusals: readonly { stage: number; who: string; status: number }[];
  readonly no_identifier_was_typed: boolean;
  readonly staff_view: Record<string, unknown>;
  readonly board_view: Record<string, unknown>;
}

const journey = (): Journey =>
  JSON.parse(read('docs', 'evidence', 'FBL-140-OWNER-JOURNEY.json')) as Journey;

describe('jacket: the delivery says what this repository holds (FBL-140 Outcome 8)', () => {
  test('all eight outcomes are proven, and each names tests this repository declares', () => {
    const record = loadFbl140Rows();
    assert.equal(record.rows.length, 8);
    assert.deepEqual(fbl140RowProblems(record), []);
    for (const row of record.rows) {
      assert.equal(row.state, 'PROVEN', `Outcome ${row.row} (${row.title}) is not proven`);
      assert.ok(row.tests.length > 0, `Outcome ${row.row} names no test`);
    }
  });

  test('the outcomes are quoted verbatim from the committed order, not paraphrased from memory', () => {
    const record = loadFbl140Rows();
    assert.ok(existsSync(join(ROOT, record.order.repository_path)), 'the order must be committed');
    const order = read(...record.order.repository_path.split('/')).replace(/\r\n/g, '\n');
    for (const row of record.rows) {
      assert.match(row.order_text, new RegExp(`^${row.row}\\. `));
      assert.ok(order.includes(row.order_text), `Outcome ${row.row} is not the order's own words`);
      assert.ok(
        row.order_text.length > 120,
        `Outcome ${row.row} is quoted too thinly to be the order`,
      );
    }
    assert.match(record.exclusions, /^FBL-140 exclusions\./);
    assert.match(record.binary_proof, /^FBL-140 binary proof\./);
    assert.match(record.order.locked_before, /migration 066 existed/);
  });

  test('the journey was walked in the shipped console and signing page by four different people', () => {
    const j = journey();
    assert.equal(j.phase, 'FBL-140');
    assert.match(j.walked_in, /\/admin\//, 'the staff console');
    assert.match(j.walked_in, /\/sign\//, 'and the customer signing page');
    assert.match(j.walked_in, /\/auth\/login/, 'through the production sign-in routes');
    const ids = new Set(Object.values(j.identities));
    assert.equal(ids.size, 4, 'four identities, not one login wearing four hats');
    for (const who of ['salesperson', 'sales_manager', 'tenant_admin', 'customer']) {
      assert.ok(who in j.identities, `${who} has an identity`);
      assert.ok(
        j.stages.some((s) => s.who === who),
        `${who} walked part of the journey`,
      );
    }
    assert.match(
      j.identities.customer!,
      /no user link/,
      'the customer holds no dealership identity',
    );
    assert.ok(j.stages.length >= 25, `only ${j.stages.length} stages were recorded`);
    for (let i = 0; i < j.stages.length; i += 1) {
      assert.equal(j.stages[i]?.stage, i + 1, 'the stages are numbered in the order walked');
    }
  });

  test('every bullet of Outcome 8 has a stage that shows it', () => {
    const text = journey()
      .stages.map((s) => `${s.who} :: ${s.what} :: ${s.saw ?? ''}`)
      .join('\n');
    // salesperson opens the approved desking result and assembles the jacket
    assert.match(text, /salesperson :: chose Marta Silva[^\n]*approved version/);
    assert.match(text, /salesperson :: pressed “Assemble the package”/);
    // required documents and missing items are visible
    assert.match(text, /required item\(s\) still missing/);
    assert.match(text, /Every required item is met\./);
    // an authorized manager completes any configured review
    assert.match(text, /sales_manager :: pressed “Record manager review”[^\n]*Review recorded/);
    // a separate customer identity receives, reviews, consents, and signs the exact package
    assert.match(text, /customer :: received the invitation the simulated provider delivered/);
    assert.match(text, /customer :: opened the Retail purchase agreement/);
    assert.match(text, /customer :: pressed “I agree to electronic records”/);
    assert.match(text, /customer :: pressed “Sign”[^\n]*package hash it had displayed/);
    // staff sees the completed certificate and immutable timeline
    assert.match(text, /sales_manager :: opened the completion certificate/);
    assert.match(text, /Timeline: ceremony\.created[^\n]*ceremony\.completed/);
    // an unauthorized user cannot approve or sign for another actor
    assert.match(
      text,
      /salesperson :: pressed “Record manager review” as a salesperson, and was refused/,
    );
    assert.match(
      text,
      /salesperson :: [^\n]*tried to sign as the dealership’s representative — refused/,
    );
    // package supersession preserves the earlier package, figures, signatures, and decisions
    assert.match(text, /Version 1 superseded[^\n]*superseded by version 2/);
    assert.match(text, /Marta Silva \(customer\) signed 6745de01a0dc/);
    assert.match(text, /certificate b116ebf78ee5/);
  });

  test('every cross-lane attempt was refused in the words a missing record gets', () => {
    const j = journey();
    assert.ok(j.refusals.length >= 3, `only ${j.refusals.length} refusals recorded`);
    for (const r of j.refusals) {
      assert.equal(
        r.status,
        404,
        `stage ${r.stage}: a role denial on a resource answers 404, not 403`,
      );
      assert.equal(
        r.who,
        'salesperson',
        'every refused attempt was a salesperson reaching for a manager’s act',
      );
    }
  });

  test('nothing in the journey was reached by typing an identifier', () => {
    const j = journey();
    assert.equal(j.no_identifier_was_typed, true);
    for (const stage of j.stages) {
      if (typeof stage.typed === 'string') {
        assert.doesNotMatch(
          stage.typed,
          /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
          `stage ${stage.stage} typed an identifier`,
        );
      }
    }
  });

  test('the staff view carries hashes and figures, and says NOT_YET_AVAILABLE for what this phase lacks', () => {
    const j = journey();
    const absent = j.staff_view.notYetAvailable as Record<string, string>;
    for (const name of [
      'sale',
      'funding',
      'delivery',
      'sold_inventory',
      'accounting_posting',
      'gross',
      'commission',
      'revenue',
      'credit_application',
      'title_registration',
      'document_disposal',
    ]) {
      assert.equal(absent[name], 'NOT_YET_AVAILABLE', `${name} must not carry a figure`);
    }
    const excluded = new Set([
      'gross',
      'revenue',
      'commission',
      'funding',
      'sale',
      'sold_inventory',
      'delivery',
      'accounting_posting',
      'credit_application',
      'title_registration',
      'document_disposal',
    ]);
    // …and a DEPTH WALK over both recorded views: a key named for an excluded
    // fact that carries anything but the placeholder is the failure this exists
    // to catch.
    const walk = (node: unknown, path: string): void => {
      if (node === null || typeof node !== 'object') return;
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (excluded.has(k) && (typeof v === 'string' || typeof v === 'number')) {
          assert.equal(String(v), 'NOT_YET_AVAILABLE', `${path}.${k} carries ${String(v)}`);
        }
        walk(v, `${path}.${k}`);
      }
    };
    walk(j.staff_view, 'staff_view');
    walk(j.board_view, 'board_view');

    // The view is the API's own shape: two package versions, the first superseded with its ceremony completed.
    const packages = j.staff_view.packages as {
      package: { versionNo: number; state: string };
      ceremony: { state: string } | null;
    }[];
    assert.deepEqual(
      packages.map((p) => [p.package.versionNo, p.package.state, p.ceremony?.state ?? null]),
      [
        [2, 'draft', null],
        [1, 'superseded', 'completed'],
      ],
    );
  });

  test('every FBL-140 control the registries declare names a test that exists, and every anchor occurs exactly once', () => {
    const mutations = MUTATIONS.filter((m) => m.file.startsWith('packages/jacket/'));
    assert.ok(mutations.length >= 20, `only ${mutations.length} runtime mutations`);
    const controls = CONTROLS.filter((c) => c.section.startsWith('066 '));
    assert.ok(controls.length >= 10, `only ${controls.length} database controls`);
    for (const m of mutations) {
      assert.ok(existsSync(join(ROOT, m.file)), `${m.id}: ${m.file}`);
      assert.ok(
        !m.from.includes('\n'),
        `${m.id}: anchors are one line, so CRLF and LF trees read the same`,
      );
      assert.equal(
        read(...m.file.split('/')).split(m.from).length - 1,
        1,
        `${m.id}: its anchor must occur exactly once in ${m.file}`,
      );
      assert.ok(existsSync(join(ROOT, m.testFile)), `${m.id}: ${m.testFile}`);
    }
    for (const c of controls) {
      assert.ok(existsSync(join(ROOT, c.testFile)), `${c.id}: ${c.testFile}`);
    }
  });

  test('the delivery report names the order, the seam, the five lanes and every outcome', () => {
    const report = read('docs', 'FBL-140-DELIVERY-REPORT.md');
    assert.match(report, /docs\/orders\/FBL-140-ORDER\.md/);
    assert.match(report, /Version 3\.1/, 'the standing order it was issued under');
    assert.match(report, /jacket-seam\.ts/, 'the one seam into @dealer/desking');
    assert.match(report, /ck_attribution_pre_sale_revenue/);
    assert.match(report, /still in force/i);
    assert.match(report, /unapproved_sample/, 'the honest template default');
    for (const lane of ['salesperson', 'manager', 'customer', 'administrator', 'provider']) {
      assert.ok(report.toLowerCase().includes(lane), `the report names the ${lane} lane`);
    }
    for (const row of loadFbl140Rows().rows) {
      assert.ok(
        report.includes(`Outcome ${row.row} — ${row.title}`),
        `the report does not account for Outcome ${row.row}`,
      );
    }
  });
});
