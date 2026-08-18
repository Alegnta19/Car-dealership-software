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
 * FBL-020-R4 §7 floors, ADVANCED BY R5. Each revision's additions must INCREASE the
 * totals, so the floors are set to the counts the revision measured
 * (`tests/ci-gates.test.ts` asserts they never fall below the order's minimum, and never
 * rise above what can actually run).
 *
 * R4 measured 459 tests in 47 suites. R5 adds the §0 census, fixture-chain, ledger-refusal,
 * reconciliation-inventory and retained-fixture-pin batteries; the §1 revocation and
 * admission-concurrency batteries; the §2 relational-coherence battery; and the §3
 * documentation, clause-inventory and published-figure checks. Raising the floor is the
 * point: it exists so a suite that shrinks cannot pass, and a floor left at the previous
 * revision's count would stop noticing the moment the new batteries were deleted.
 *
 * The floor moved 526 → 554 when the Appendix A item 6 pass added fourteen direct-SQL
 * relational-coherence tests to `tests/identity-evidence.test.ts` — one per rejection
 * class R5 §2.2 enumerates, each proved against the real schema. It moved 554 → 567 when
 * the gate findings G1, G2 and G5 added the census disposability battery, the TAP-line
 * observation checks and the census-versus-prose comparison, 567 → 572 when the
 * stale-figure gate and its revert proofs were added, and 572 → 573 when that gate's
 * MUTUAL-CONSISTENCY limb — the one binding two publications of a figure to each other when
 * no artifact is readable to arbitrate between them — got its own named test. It moved
 * 573 → 577 when the R5 verification pass added four: the census absence-versus-silence
 * test (S1), the §3.6 uncommitted-working-tree class check (S3), and the two that pin the
 * inventory key's shape and refuse a credential-shaped literal under `architecture/` (S5).
 * Each of these numbers was MEASURED before it was written here.
 *
 * A floor is raised only AFTER a measured run, never to a number nobody has seen run.
 * `tests/ci-gates.test.ts` refuses a suite floor above the declarations that exist and a
 * test floor below them; the stale floor this revision inherited was found by exactly that
 * assertion, not by review. `scripts/check-published-figures.ts` then holds every DOCUMENT
 * that restates these constants to the values they actually carry — the defect that
 * shipped when the requirement map published `MINIMUM_TESTS = 554` against a source
 * holding 567.
 */
export const MINIMUM_TESTS = 577;
export const MINIMUM_SUITES = 59;

/**
 * The order's own floor.
 *
 * THREE FLOOR FIGURES ARE IN PLAY AND THEY ARE NOT THE SAME NUMBER, so which one this
 * constant carries is stated rather than assumed:
 *
 *   * FBL-020-R5 §4 — "The existing 459-test/47-suite floor may not shrink." That is the
 *     order's FLOOR clause, and it is the one recorded here.
 *   * FBL-020-R5 Appendix A item 9 — "The reported 525 tests/57 suites must have zero
 *     failed, cancelled, skipped, and todo results." That is a quality condition on a
 *     count the implementer had already reported, not a second floor.
 *   * FBL-020-R4 §7 — 315 / 29, which is what this constant used to hold. It was named
 *     "the order's own floor" while carrying the PREVIOUS order's number, and the
 *     requirement map recorded that as a standing finding instead of correcting it.
 *
 * The declared floors above clear all three, so no reading of the order is disadvantaged
 * by the choice; the constant nonetheless names §4's number, because §4 is the clause that
 * fixes a floor.
 */
export const ORDER_MINIMUM_TESTS = 459;
export const ORDER_MINIMUM_SUITES = 47;

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
 * What the log's own assertion lines say, independently of the counters.
 *
 * ── WHY THIS EXISTS (FBL-020-R5, gate finding G2) ───────────────────────────
 *
 * A run emitted
 *
 *     not ok 38 - migration ledger integrity (FBL-020-R4 §0)
 *
 * while the summary counters that follow it read `# fail 0`, and this gate printed
 * "Test summary gate OK." Everything the gate looked at agreed the run was clean,
 * because everything the gate looked at was the counters. A gate that cannot see a
 * failing assertion is not a gate.
 *
 * So the log is now read TWICE and the two readings must agree. The `ok` / `not ok`
 * lines are TAP's actual results; the `# pass` / `# fail` lines are a summary of them.
 * A `not ok` is fatal on its own, whatever the counters say — and a counter that
 * contradicts the lines is reported as a defect in its own right, because the two can
 * only disagree if something between the assertion and the summary went wrong.
 *
 * Nested subtests are counted too (`^\s*not ok`). A subtest failure that its parent
 * swallowed is exactly the shape of failure this gate exists to catch, and indenting it
 * must not hide it.
 */
export interface TapObservation {
  ok: number;
  not_ok: number;
  /** The failing lines themselves, so the gate's message names what it found. */
  not_ok_lines: string[];
}

export function observeTapLines(raw: string): TapObservation {
  const okLine = /^\s*ok\s+[0-9]+/;
  const notOkLine = /^\s*not ok\s+[0-9]+/;
  let ok = 0;
  const notOkLines: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (notOkLine.test(line)) notOkLines.push(line.trim());
    else if (okLine.test(line)) ok += 1;
  }
  return { ok, not_ok: notOkLines.length, not_ok_lines: notOkLines };
}

/**
 * The counter-versus-observation comparison. Kept separate so the suite can drive each
 * contradiction on its own.
 *
 * Exact equality is NOT required: `# tests` counts differently from the `ok` lines under
 * some reporters, and a gate that failed on an off-by-one would be turned off. What is
 * required is that the two never CONTRADICT each other in direction — which is precisely
 * the failure that got through: zero failures claimed, a failure printed.
 */
export function counterContradictions(summary: TestSummary, observed: TapObservation): string[] {
  const problems: string[] = [];
  if (summary.failed === 0 && observed.not_ok > 0)
    problems.push(
      `Gate: the summary claims failed=0 but the log contains ${observed.not_ok} 'not ok' ` +
        'line(s). The counters and the assertions disagree, and the assertions are the run.',
    );
  if (summary.failed > 0 && observed.not_ok === 0)
    problems.push(
      `Gate: the summary claims failed=${summary.failed} but no 'not ok' line appears in the ` +
        'log. A failure nobody printed is a summary nobody can check.',
    );
  if (summary.passed > 0 && observed.ok === 0)
    problems.push(
      `Gate: the summary claims passed=${summary.passed} but the log contains no 'ok' line. ` +
        'The summary does not describe this log.',
    );
  if (summary.passed === 0 && observed.ok > 0)
    problems.push(
      `Gate: the summary claims passed=0 but the log contains ${observed.ok} 'ok' line(s).`,
    );
  return problems;
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

/**
 * The whole gate, over the RAW LOG rather than over a summary somebody extracted from
 * it. This is what `main` calls, and what CI therefore enforces.
 *
 * A `not ok` line is fatal FIRST and unconditionally: before the floors, before the
 * zero-checks, before the counters are consulted at all. Nothing about a summary can
 * make a printed failure acceptable.
 */
export function logGateFailures(
  raw: string,
  summary: TestSummary,
  floors: { tests: number; suites: number } = { tests: MINIMUM_TESTS, suites: MINIMUM_SUITES },
): string[] {
  const observed = observeTapLines(raw);
  const problems: string[] = [];
  if (observed.not_ok > 0) {
    problems.push(
      `Gate: the log contains ${observed.not_ok} FAILING assertion line(s), so the run failed ` +
        'whatever the counters say:',
    );
    for (const line of observed.not_ok_lines.slice(0, 20)) problems.push(`  ${line}`);
    if (observed.not_ok_lines.length > 20)
      problems.push(`  … and ${observed.not_ok_lines.length - 20} more`);
  }
  if (observed.ok === 0 && observed.not_ok === 0)
    problems.push(
      "Gate: the log contains no 'ok' or 'not ok' line at all. A log with no assertions in " +
        'it is not the log of a run that asserted anything.',
    );
  problems.push(...counterContradictions(summary, observed));
  problems.push(...gateFailures(summary, floors));
  return problems;
}

function main(): void {
  const [logPath, outPath] = [process.argv[2], process.argv[3]];
  if (logPath === undefined || outPath === undefined) {
    console.error('Usage: parse-test-summary.ts <raw-test-log> <out-json>');
    process.exit(2);
  }

  const raw = readFileSync(logPath, 'utf8');
  const found = parseSummaryLines(raw);

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
  const observed = observeTapLines(raw);
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        ...summary,
        floor_tests: MINIMUM_TESTS,
        floor_suites: MINIMUM_SUITES,
        observed_ok_lines: observed.ok,
        observed_not_ok_lines: observed.not_ok,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    `tests=${summary.tests} suites=${summary.suites} passed=${summary.passed} ` +
      `failed=${summary.failed} cancelled=${summary.cancelled} skipped=${summary.skipped} ` +
      `todo=${summary.todo} duration_ms=${summary.duration_ms} ` +
      `floor_tests=${MINIMUM_TESTS} floor_suites=${MINIMUM_SUITES} ` +
      `observed_ok=${observed.ok} observed_not_ok=${observed.not_ok}`,
  );

  const problems = logGateFailures(raw, summary);
  if (problems.length > 0) {
    for (const p of problems) console.error(p);
    process.exit(1);
  }
  console.log('Test summary gate OK.');
}

// Importable by the suite without running the CLI: the gate is TESTED, not assumed.
if (require.main === module) main();
