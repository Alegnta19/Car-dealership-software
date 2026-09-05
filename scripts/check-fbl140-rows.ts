/**
 * THE FBL-140 ROW GATE.
 *
 * The architect's FBL-140 order locks EIGHT outcomes and asks for them proven at the
 * finish line. This gate is what stops that checklist from being prose, in the same shape
 * `scripts/check-fbl120-rows.ts` gave the seven rows before it: it reads
 * `docs/FBL-140-ACCEPTANCE-ROWS.json`, and for every outcome that claims to be PROVEN it
 * requires the named tests to EXIST — the file on disk and the `test('…')` declaration
 * inside it. A row that names a test nobody wrote, or a test whose name drifted after the
 * row was written, fails here rather than being believed.
 *
 * ONE THING IS STRICTER THAN THE FBL-120 GATE. FBL-120's rows were quoted from a .docx
 * whose bytes the gate could only prove were present; FBL-140's order is committed as
 * text at `docs/orders/FBL-140-ORDER.md`, so every `order_text` is required to appear in
 * that file VERBATIM. A paraphrased outcome — however faithful — is refused, because an
 * acceptance contract the implementer re-typed is a contract with their fingerprints on it.
 *
 * A row may sit at LOCKED with no tests while the phase is being built; that is what
 * LOCKED means. What it may not do is reach PROVEN on an empty list, and what the
 * delivery may not do is finish with a row still at LOCKED — `tests/jacket-delivery.test.ts`
 * holds that last condition, because "all eight are proven" is a claim about the DELIVERY
 * rather than about this file.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { declaredTestNames } from './check-requirement-map';

const ROOT = join(__dirname, '..');
const RECORD = 'docs/FBL-140-ACCEPTANCE-ROWS.json';

export type Fbl140RowState = 'LOCKED' | 'PROVEN';

export interface Fbl140Row {
  readonly row: number;
  readonly title: string;
  readonly order_text: string;
  readonly state: Fbl140RowState;
  readonly tests: ReadonlyArray<{ readonly file: string; readonly name: string }>;
}

export interface Fbl140Record {
  readonly order: {
    readonly phase: string;
    readonly document: string;
    readonly repository_path: string;
    readonly issued_under: string;
    readonly received_on: string;
    readonly starting_point: string;
    readonly first_migration: string;
    readonly locked_before: string;
  };
  readonly rows: readonly Fbl140Row[];
  readonly exclusions: string;
  readonly binary_proof: string;
}

export function loadFbl140Rows(): Fbl140Record {
  return JSON.parse(readFileSync(join(ROOT, RECORD), 'utf8')) as Fbl140Record;
}

export function fbl140RowProblems(record: Fbl140Record = loadFbl140Rows()): string[] {
  const problems: string[] = [];

  if (record.rows.length !== 8) {
    problems.push(`the order locks EIGHT outcomes; this record holds ${record.rows.length}`);
  }

  // The order this record quotes must be the one committed here, and every quotation
  // must be its own words.
  const orderPath = join(ROOT, record.order.repository_path);
  let orderText: string | null = null;
  if (!existsSync(orderPath)) {
    problems.push(
      `the order this record quotes is not in the repository: ${record.order.repository_path}`,
    );
  } else {
    orderText = readFileSync(orderPath, 'utf8').replace(/\r\n/g, '\n');
  }

  for (let i = 0; i < record.rows.length; i += 1) {
    const row = record.rows[i] as Fbl140Row;
    if (row.row !== i + 1) problems.push(`row ${i + 1} is numbered ${row.row}`);
    if (!row.order_text.startsWith(`${row.row}. ${row.title}`)) {
      problems.push(`row ${row.row} does not open with the order's own numbered heading`);
    }
    if (orderText !== null && !orderText.includes(row.order_text.replace(/\r\n/g, '\n'))) {
      problems.push(
        `row ${row.row} (${row.title}) is not quoted verbatim from ${record.order.repository_path}`,
      );
    }
    if (row.state !== 'LOCKED' && row.state !== 'PROVEN') {
      problems.push(`row ${row.row} is in the unknown state ${JSON.stringify(row.state)}`);
      continue;
    }
    if (row.state === 'PROVEN' && row.tests.length === 0) {
      problems.push(
        `row ${row.row} (${row.title}) claims PROVEN and names no test. A row proves itself ` +
          'by naming the test that would fail if it stopped being true.',
      );
    }
    for (const t of row.tests) {
      const path = join(ROOT, t.file);
      if (!existsSync(path)) {
        problems.push(`row ${row.row} names ${t.file}, which does not exist`);
        continue;
      }
      if (!declaredTestNames(t.file).has(t.name)) {
        problems.push(`row ${row.row} names a test ${t.file} does not declare: ${t.name}`);
      }
    }
  }
  return problems;
}

function main(): void {
  const record = loadFbl140Rows();
  const problems = fbl140RowProblems(record);
  const proven = record.rows.filter((r) => r.state === 'PROVEN').length;
  console.log(`record: ${RECORD}`);
  console.log(`order:  ${record.order.repository_path} (received ${record.order.received_on})`);
  for (const row of record.rows) {
    const tests = row.tests.length === 0 ? 'no test named yet' : `${row.tests.length} test(s)`;
    console.log(`  Outcome ${row.row} — ${row.title}: ${row.state}, ${tests}`);
  }
  console.log(`${proven} of ${record.rows.length} outcomes proven`);
  if (problems.length > 0) {
    console.error('\nThe FBL-140 row record does not describe this repository:');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log('Every proven outcome names a test this repository declares.');
}

if (require.main === module) main();
