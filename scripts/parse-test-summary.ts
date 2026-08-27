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
 * It moved 577 → 589 / 59 → 60 under FBL-020-R6 §1, which added twelve: five in
 * `tests/migration-ledger.test.ts` for the checksum-only fixture admission that replaced
 * filename-only and single-statement-deletion admission (§1.4), four in
 * `tests/migration-census.test.ts` for the completeness rule, the runner-authority reading
 * and the source-head provenance (§1.1/§1.3), two in
 * `tests/delivery-documentation.test.ts` refusing a runner census and requiring the
 * operator census to be committed rather than read out of the gitignored `artifacts/`
 * (§1.2), and one new SUITE of two in `tests/ci-gates.test.ts` for the workflow assertions
 * that carry §1.2.
 * It moved 589 → 605 / 60 → 62 under FBL-020-R6 §2, the runtime-lifecycle closure, which
 * added sixteen across five batteries: seven in `tests/login-admission.test.ts` (five
 * callback-binding refusals routed through the lifecycle service instead of being refused
 * by the route, the slow exchange that crosses expiry with NO sweep, and the fault-injected
 * login-success audit that must leave no custody); a new SUITE of four in
 * `tests/reauth-callback-lifecycle.test.ts` (the control, the state-less step-up callback,
 * the wrong active user and the no-sweep step-up expiry, all through the real HTTP routes);
 * a new SUITE of three in `tests/mfa-certification-concurrency.test.ts` (the control and
 * the two barrier-controlled tenant races); and one each in `tests/worker-jobs.test.ts` and
 * `tests/worker-entrypoint.test.ts` for the failing-sweep exit status, in process and
 * through the compiled artifact.
 * It moved 605 → 625 / 62 → 63 under FBL-020-R6 §3, the database-reconstructable-evidence
 * closure, which added twenty: a new SUITE of nineteen in
 * `tests/identity-evidence-reconstruction.test.ts` — the direct-SQL adversarial cases §3.5
 * enumerates, every one built out of cross-wired REAL rows rather than random UUIDs (an
 * invented authentication instant and another real session's; a superseded binding version;
 * revoked, windowed-out, wrong-tenant, platform-scope and wrong-resource bindings; an extra
 * normalized row and a repeated ordinality, both with the writer guard's marker forged; a
 * platform-support tenant allow carrying no delegation; and unapproved, over-broad, revoked
 * and lapsed support evidence) — plus one in `tests/ci-gates.test.ts` pinning the
 * database-control mutation gate into the workflow. `tests/identity-evidence.test.ts` kept
 * its own count: §3.1 replaced one arbitrary `new Date()` in its fixture rather than adding
 * a case.
 * It moved 625 → 642 / 63 → 64 under FBL-020-R6 §4, which added seventeen: fifteen in
 * `tests/delivery-documentation.test.ts` — a new SUITE driving `scripts/check-final-state.ts`
 * in both directions (the record as shipped; every withdrawn sentence reintroduced into every
 * governed document; the withdrawal marker permitting a quotation and only a quotation; the
 * exemption counted and bounded; every required sentence removed from every document that owns
 * it; the sentences shown to DERIVE from the record; a commit dropped from the recorded range,
 * which is the R5 undercount itself; an invented commit and a wrong subject; a run whose
 * head_sha is not the commit it is attributed to; a run painted success over a failed job; the
 * head relation decided by git in both directions; a softened budget verdict; the submission
 * status forced by an OPEN §3.1; the withdrawal list held to the refusal list in both
 * directions; and the whole gate re-run with `artifacts/` MOVED ASIDE) — plus one in
 * `tests/login-admission.test.ts` for the §4.2 route-level `session_establishment_failed`
 * closure, and one in `tests/ci-gates.test.ts` pinning the final-state gate into the workflow.
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
/*
 * FBL-020-R6 gate findings C1, C2 and C7 add FOUR tests to the battery:
 *
 *   * three in `tests/identity-evidence-reconstruction.test.ts` for C7's scope hierarchy —
 *     a rooftop binding cited for its SIBLING rooftop, the same binding cited for the WHOLE
 *     TENANT (with the department beneath it accepted, so the rule is not simply always
 *     red), and a tenant-scope binding naming a DIFFERENT tenant;
 *   * one in `tests/delivery-documentation.test.ts` for C2, which makes a REAL
 *     `git clone --depth 1` and runs the real final-state gate against it.
 *
 * C1's proof is not a new test: it is the retained fixture gaining four ordinary ALLOWs with
 * non-empty matched-binding arrays, plus new assertions inside the existing upgrade-drill
 * verifier and the existing ci-gates fixture test.
 *
 * ── THE FLOOR IS THE MEASURED TOTAL, WITH NO SLACK ────────────────────────────
 *
 * THIS REVISION, and this block replaces one that named the discipline while the constant
 * broke it. The rule is the one stated above: a floor is raised only AFTER a measured run,
 * and it is raised TO what that run reported. `artifacts/test-summary.json` reports 652 tests
 * and 64 suites on this tree, so the constants below are 652 and 64.
 *
 * THE CONSTANT SAT AT 646 — SIX BELOW THE MEASURED BATTERY — INSIDE A COMMENT THAT SAID IT
 * WAS PINNED TO THE MEASUREMENT. 646 was right when it was written: 642 plus the four tests
 * above. The corrective waves that followed added SIX more tests to the batteries they
 * touched — finding F4's three named direct-SQL adversarial tests for the `dealer_group`,
 * `legal_entity` and `department` scope levels among them — and nobody moved the constant.
 * Six tests of slack still catches a suite that collapses, but it silently permits six tests
 * to be DELETED, which is precisely what a floor exists to refuse, and a constant that
 * contradicts its own docstring teaches the next reader to disbelieve the docstring. Raised
 * rather than explained away.
 *
 * §4.3's own floor is 577 tests / 59 suites; the declared floors below are above it, so the
 * order's number is cleared with room and is stated in `docs/orders/FBL-020-R6.md`.
 */
export const MINIMUM_TESTS = 723;
export const MINIMUM_SUITES = 69;

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
