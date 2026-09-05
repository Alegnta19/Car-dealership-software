/**
 * THE FBL-120 ROW GATE.
 *
 * Master Blueprint Version 3.1 §14.3 Part B orders the seven acceptance rows LOCKED
 * BEFORE CODING and returned as a seven-row checklist at the finish line. This gate is
 * what stops that checklist from being prose: it reads
 * `docs/FBL-120-ACCEPTANCE-ROWS.json`, and for every row that claims to be PROVEN it
 * requires the named tests to EXIST — the file on disk and the `test('…')` declaration
 * inside it. A row that names a test nobody wrote, or a test whose name drifted after
 * the row was written, fails here rather than being believed.
 *
 * A row may sit at LOCKED with no tests while the phase is being built; that is what
 * LOCKED means. What it may not do is reach PROVEN on an empty list, and what the
 * delivery may not do is finish with a row still at LOCKED — `tests/desking-delivery.test.ts`
 * holds that last condition, because "all seven are proven" is a claim about the
 * DELIVERY rather than about this file.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { declaredTestNames } from './check-requirement-map';

const ROOT = join(__dirname, '..');
const RECORD = 'docs/FBL-120-ACCEPTANCE-ROWS.json';

export type RowState = 'LOCKED' | 'PROVEN';

export interface AcceptanceRow {
  readonly row: number;
  readonly title: string;
  readonly order_text: string;
  readonly state: RowState;
  readonly tests: ReadonlyArray<{ readonly file: string; readonly name: string }>;
}

export interface AcceptanceRecord {
  readonly order: {
    readonly document: string;
    readonly document_sha256: string;
    readonly version_label: string;
    readonly section: string;
    readonly repository_path: string;
  };
  readonly rows: readonly AcceptanceRow[];
  readonly exclusions: string;
  readonly binary_proof: string;
}

export function loadAcceptanceRows(): AcceptanceRecord {
  return JSON.parse(readFileSync(join(ROOT, RECORD), 'utf8')) as AcceptanceRecord;
}

export function rowProblems(record: AcceptanceRecord = loadAcceptanceRows()): string[] {
  const problems: string[] = [];

  if (record.rows.length !== 7) {
    problems.push(`the order locks SEVEN rows; this record holds ${record.rows.length}`);
  }
  for (let i = 0; i < record.rows.length; i += 1) {
    const row = record.rows[i] as AcceptanceRow;
    if (row.row !== i + 1) problems.push(`row ${i + 1} is numbered ${row.row}`);
    if (!row.order_text.startsWith(`Row ${row.row} - `)) {
      problems.push(`row ${row.row} does not quote the order's own sentence`);
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

  // The order that produced this record must be the one committed here, or the rows are
  // quoted from a document nobody else can open.
  const orderPath = join(ROOT, record.order.repository_path);
  if (!existsSync(orderPath)) {
    problems.push(
      `the order this record quotes is not in the repository: ${record.order.repository_path}`,
    );
  }
  return problems;
}

function main(): void {
  const record = loadAcceptanceRows();
  const problems = rowProblems(record);
  const proven = record.rows.filter((r) => r.state === 'PROVEN').length;
  console.log(`record: ${RECORD}`);
  console.log(`order:  ${record.order.version_label} §${record.order.section}`);
  for (const row of record.rows) {
    const tests = row.tests.length === 0 ? 'no test named yet' : `${row.tests.length} test(s)`;
    console.log(`  Row ${row.row} — ${row.title}: ${row.state}, ${tests}`);
  }
  console.log(`${proven} of ${record.rows.length} rows proven`);
  if (problems.length > 0) {
    console.error('\nThe FBL-120 row record does not describe this repository:');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log('Every proven row names a test this repository declares.');
}

if (require.main === module) main();
