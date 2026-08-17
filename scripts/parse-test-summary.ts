/**
 * Deterministic test-summary enforcement.
 *
 *   npx tsx scripts/parse-test-summary.ts <raw-test-log> <out-json>
 *
 * ── WHY THE PARSER LOOKS LIKE THIS (FBL-000-R1, correction A) ────────────────
 *
 * The original CI step grepped for the spec reporter's human glyph ("ℹ tests 115").
 * Node 20 on a non-TTY chose the TAP reporter, whose summary lines use "#", so the
 * grep found nothing, the counts file was empty, and a fully passing suite exited the
 * job with failure. This parser depends on neither glyph, colour, locale nor reporter
 * choice: it accepts the summary key/value lines that both the TAP and spec reporters
 * emit, and takes the LAST occurrence of each key (the run-level summary follows any
 * per-file ones).
 *
 * ── WHY IT ALSO ENFORCES FLOORS (FBL-020-R4 §7) ──────────────────────────────
 *
 * Two holes were found in the R3 gate, and both had the same shape — a green result
 * that proved less than it appeared to:
 *
 *   1. `todo` WAS NOT REQUIRED. It was read when present and defaulted to 0 when
 *      absent, so a reporter that stopped emitting it would have silently removed
 *      `todo` from the consistency equation AND from the zero-check. A test parked as
 *      `todo` would then have counted as an accounted-for, non-failing test.
 *   2. NOTHING ENFORCED A FLOOR. `tests > 0` was the only size check, so deleting
 *      every test but one — or a glob that quietly matched a single file — was a pass.
 *      A suite that shrinks is the single most common way a battery stops covering
 *      what it used to cover, and it is invisible in a green log.
 *
 * So all eight summary fields are now REQUIRED, `todo` is checked against zero
 * alongside failed/cancelled/skipped, and the run must be AT LEAST as large as the
 * declared floors below.
 *
 * ── ON RAISING THE FLOORS ────────────────────────────────────────────────────
 *
 * These are a RATCHET on coverage size, and the same discipline as the quality
 * ratchet applies in the opposite direction: they may be raised when the suite really
 * has grown, and lowering one is a deliberate, reviewable act that must be justified
 * in the delivery report. They are NOT the count of the moment — they are the floor
 * the architect's order fixed, advanced to what this revision actually delivers.
 */
import { readFileSync, writeFileSync } from 'fs';

type Key = 'tests' | 'suites' | 'pass' | 'fail' | 'cancelled' | 'skipped' | 'todo' | 'duration_ms';

/**
 * FBL-020-R4 §7 floors. The governing order fixed the minimum at 315 tests and 29
 * suites; R4's own additions must INCREASE the totals, so the floors are set to the
 * counts this revision measured (`tests/ci-gates.test.ts` asserts they never fall
 * below the order's minimum).
 */
export const MINIMUM_TESTS = 459;
export const MINIMUM_SUITES = 47;

/** The order's own floor. Recorded so a future edit cannot quietly drop below it. */
export const ORDER_MINIMUM_TESTS = 315;
export const ORDER_MINIMUM_SUITES = 29;

/** Nothing may be parked, aborted or unrun. */
const MUST_BE_ZERO: Array<'failed' | 'cancelled' | 'skipped' | 'todo'> = [
  'failed',
  'cancelled',
  'skipped',
  'todo',
];

export interface TestSummary {
  tests: number;
  suites: number;
  passed: number;
  failed: number;
  cancelled: number;
  skipped: number;
  todo: number;
  duration_ms: number;
}

/** Parses the reporter-independent summary lines. Returns whatever it found. */
export function parseSummaryLines(raw: string): Partial<Record<Key, number>> {
  const found: Partial<Record<Key, number>> = {};
  const line =
    /^[\s]*[#ℹ][\s]+(tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)[\s]+([0-9]+(?:\.[0-9]+)?)[\s]*$/;
  for (const l of raw.split(/\r?\n/)) {
    const m = line.exec(l);
    if (m && m[1] !== undefined && m[2] !== undefined) {
      found[m[1] as Key] = Number(m[2]); // last occurrence wins — the final summary
    }
  }
  return found;
}

/**
 * The gate itself, as a pure function so the suite can prove each refusal rather than
 * trusting that the CI step would have refused. Returns the reasons a run is not
 * acceptable; an empty array is a pass.
 */
export function gateFailures(
  summary: TestSummary,
  floors: { tests: number; suites: number } = { tests: MINIMUM_TESTS, suites: MINIMUM_SUITES },
): string[] {
  const problems: string[] = [];

  const accounted =
    summary.passed + summary.failed + summary.cancelled + summary.skipped + summary.todo;
  if (accounted !== summary.tests) {
    problems.push(
      `Inconsistent summary: pass+fail+cancelled+skipped+todo=${accounted} != tests=${summary.tests}`,
    );
  }
  for (const key of MUST_BE_ZERO) {
    if (summary[key] !== 0) problems.push(`Gate: ${key}=${summary[key]}, required 0`);
  }
  if (summary.tests < floors.tests) {
    problems.push(
      `Gate: ${summary.tests} test(s) ran, floor is ${floors.tests}. A suite that SHRANK is ` +
        'not a suite that passed.',
    );
  }
  if (summary.suites < floors.suites) {
    problems.push(`Gate: ${summary.suites} suite(s) ran, floor is ${floors.suites}.`);
  }
  if (summary.duration_ms <= 0) {
    problems.push('Gate: duration_ms is not positive — the run did not measure itself.');
  }
  return problems;
}

function main(): void {
  const [logPath, outPath] = [process.argv[2], process.argv[3]];
  if (logPath === undefined || outPath === undefined) {
    console.error('Usage: parse-test-summary.ts <raw-test-log> <out-json>');
    process.exit(2);
  }

  const found = parseSummaryLines(readFileSync(logPath, 'utf8'));

  // EVERY field is required, `todo` and `duration_ms` among them. A missing field
  // means the summary is unverifiable, and an unverifiable run is not a green run.
  const required: Key[] = [
    'tests',
    'suites',
    'pass',
    'fail',
    'cancelled',
    'skipped',
    'todo',
    'duration_ms',
  ];
  const missing = required.filter((k) => found[k] === undefined);
  if (missing.length > 0) {
    console.error(`Test summary is EMPTY or unparseable — missing: ${missing.join(', ')}.`);
    console.error('Refusing to treat an unverifiable run as green.');
    process.exit(1);
  }

  const summary: TestSummary = {
    tests: found.tests ?? 0,
    suites: found.suites ?? 0,
    passed: found.pass ?? 0,
    failed: found.fail ?? 0,
    cancelled: found.cancelled ?? 0,
    skipped: found.skipped ?? 0,
    todo: found.todo ?? 0,
    duration_ms: found.duration_ms ?? 0,
  };
  writeFileSync(
    outPath,
    JSON.stringify(
      { ...summary, floor_tests: MINIMUM_TESTS, floor_suites: MINIMUM_SUITES },
      null,
      2,
    ) + '\n',
  );
  console.log(
    `tests=${summary.tests} suites=${summary.suites} passed=${summary.passed} ` +
      `failed=${summary.failed} cancelled=${summary.cancelled} skipped=${summary.skipped} ` +
      `todo=${summary.todo} duration_ms=${summary.duration_ms} ` +
      `floor_tests=${MINIMUM_TESTS} floor_suites=${MINIMUM_SUITES}`,
  );

  const problems = gateFailures(summary);
  if (problems.length > 0) {
    for (const p of problems) console.error(p);
    process.exit(1);
  }
  console.log('Test summary gate OK.');
}

// Importable by the suite without running the CLI: the gate is TESTED, not assumed.
if (require.main === module) main();
