import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
  MINIMUM_SUITES,
  MINIMUM_TESTS,
  ORDER_MINIMUM_SUITES,
  ORDER_MINIMUM_TESTS,
  gateFailures,
  parseSummaryLines,
  type TestSummary,
} from '../scripts/parse-test-summary';
import {
  checkRequirementMap,
  declaredTestNames,
  loadRequirementMap,
  workflowStepNames,
} from '../scripts/check-requirement-map';
import { MUTATIONS, anchorProblems } from '../scripts/mutation-kill';
import {
  CONTROLS,
  NOT_LOAD_BEARING,
  canonical057,
  loadAnchors,
  removeStatement,
  type ControlAnchor,
} from '../scripts/upgrade-negative-controls';

/**
 * FBL-020-R4 §7 — THE GATES ARE TESTED, NOT TRUSTED.
 *
 * Every gate in this file used to exist only as a step in `ci.yml`, which meant its
 * REFUSALS were never exercised: a parser that silently stopped requiring a field, a
 * floor nobody enforced, a requirement map naming a renamed test, a mutation whose
 * anchor no longer matched — each would have produced a green run.
 *
 * So the gate logic is imported and driven directly here, and the workflow itself is
 * read as a document and checked for the steps that must be in it. Nothing in this file
 * touches the database.
 */

const ROOT = join(__dirname, '..');
const WORKFLOW = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');

/**
 * A run that should pass every check, used as the baseline to perturb.
 *
 * DERIVED FROM THE DECLARED FLOORS, deliberately. This fixture was written with a
 * hardcoded `suites: 40`, and it silently stopped being an acceptable run the moment
 * R4's new batteries advanced the suite floor to 41 — every "this perturbation is
 * refused" assertion below still passed, because they only ask THAT the run was
 * refused, while the fixture was by then being refused for a reason that had nothing
 * to do with the perturbation. Only the `gateFailures(goodSummary())` assertion at the
 * end of the shrink test caught it. Deriving the baseline from the floors removes the
 * whole drift class: a fixed headroom above each floor stays acceptable whatever the
 * floors later become.
 */
function goodSummary(): TestSummary {
  const tests = MINIMUM_TESTS + 75;
  return {
    tests,
    suites: MINIMUM_SUITES + 9,
    passed: tests,
    failed: 0,
    cancelled: 0,
    skipped: 0,
    todo: 0,
    duration_ms: 1234,
  };
}

describe('the test-summary gate (FBL-020-R4 §7)', () => {
  test('all eight summary fields are REQUIRED, todo among them', () => {
    // TAP output with `todo` deliberately absent: the R3 parser accepted this and
    // defaulted todo to 0, which removed it from the consistency equation AND from
    // the zero-check in one step.
    const withoutTodo = [
      '# tests 500',
      '# suites 40',
      '# pass 500',
      '# fail 0',
      '# cancelled 0',
      '# skipped 0',
      '# duration_ms 1234',
    ].join('\n');
    const parsed = parseSummaryLines(withoutTodo);
    assert.equal(parsed.todo, undefined, 'the log genuinely omits todo');

    const complete = parseSummaryLines(withoutTodo + '\n# todo 0');
    for (const key of [
      'tests',
      'suites',
      'pass',
      'fail',
      'cancelled',
      'skipped',
      'todo',
      'duration_ms',
    ] as const) {
      assert.notEqual(complete[key], undefined, `${key} must be parsed when present`);
    }

    // …and the CI step is the one that refuses the incomplete log, so the required-set
    // and the script that owns it must not drift apart.
    const script = readFileSync(join(ROOT, 'scripts', 'parse-test-summary.ts'), 'utf8');
    const requiredBlock = /const required: Key\[\] = \[([\s\S]*?)\];/.exec(script);
    assert.ok(requiredBlock, 'the parser must declare its required field list');
    for (const key of [
      'tests',
      'suites',
      'pass',
      'fail',
      'cancelled',
      'skipped',
      'todo',
      'duration_ms',
    ]) {
      assert.ok(
        (requiredBlock[1] as string).includes(`'${key}'`),
        `${key} must be a REQUIRED field, not an optional one`,
      );
    }
  });

  test('a run that SHRANK below the declared floor is refused', () => {
    const shrunk = { ...goodSummary(), tests: 12, passed: 12 };
    const problems = gateFailures(shrunk);
    assert.ok(
      problems.some((p) => p.includes('test(s) ran, floor is')),
      `a 12-test run must be refused, got: ${problems.join('; ')}`,
    );

    const fewSuites = { ...goodSummary(), suites: 3 };
    assert.ok(
      gateFailures(fewSuites).some((p) => p.includes('suite(s) ran, floor is')),
      'a run with three suites must be refused',
    );

    // The baseline itself must PASS, or the checks above prove nothing.
    assert.deepEqual(gateFailures(goodSummary()), []);
  });

  test('todo, skipped, cancelled and failed are each independently fatal', () => {
    const base = goodSummary();
    for (const key of ['failed', 'cancelled', 'skipped', 'todo'] as const) {
      // `passed` is reduced by exactly one so the summary stays INTERNALLY CONSISTENT:
      // the point is that a single parked or aborted test is fatal ON ITS OWN, which an
      // inconsistency complaint in the same result would mask.
      const summary = { ...base, [key]: 1, passed: base.tests - 1 } as TestSummary;
      const problems = gateFailures(summary);
      assert.ok(
        problems.some((p) => p.startsWith(`Gate: ${key}=1`)),
        `${key}=1 must be fatal on its own, got: ${problems.join('; ')}`,
      );
    }
    // An inconsistent summary — counts that do not add up — is also refused, so a
    // reporter that miscounts cannot be read as a pass.
    assert.ok(
      gateFailures({ ...base, passed: base.tests - 1 }).some((p) =>
        p.startsWith('Inconsistent summary'),
      ),
    );
    assert.ok(
      gateFailures({ ...goodSummary(), duration_ms: 0 }).some((p) => p.includes('duration')),
    );
  });

  test('the declared floors never fall below the floors the order fixed', () => {
    const script = readFileSync(join(ROOT, 'scripts', 'parse-test-summary.ts'), 'utf8');
    const tests = Number(/const MINIMUM_TESTS = (\d+);/.exec(script)?.[1]);
    const suites = Number(/const MINIMUM_SUITES = (\d+);/.exec(script)?.[1]);
    assert.ok(Number.isInteger(tests) && Number.isInteger(suites));
    assert.ok(
      tests >= ORDER_MINIMUM_TESTS,
      `the test floor is ${tests}; the order fixed a minimum of ${ORDER_MINIMUM_TESTS}`,
    );
    assert.ok(
      suites >= ORDER_MINIMUM_SUITES,
      `the suite floor is ${suites}; the order fixed a minimum of ${ORDER_MINIMUM_SUITES}`,
    );
  });

  test('each floor is bounded by the declarations that actually exist', () => {
    /*
     * A floor above what can run makes CI permanently red; a floor below what runs stops
     * catching a shrinking suite. This test bounds each floor in the direction that is
     * SOUNDLY checkable from source, and says plainly where source cannot decide.
     *
     * COUNTING IS ANCHORED TO STATEMENT POSITION. A `test(` or `describe(` appearing in
     * a comment or an assertion message is not a declaration, and the distinction is not
     * pedantic: a naive /\bdescribe\(/ count over THIS FILE is inflated by the very
     * sentences describing the check, so the bound could be satisfied by writing about
     * it. That is not a hypothetical — the first draft of this test was written with a
     * naive count and a deliberately over-raised floor SURVIVED it, because the new
     * prose had lifted the count past the floor.
     */
    const files = readdirSync(join(ROOT, 'tests')).filter((f) => f.endsWith('.test.ts'));
    let declaredTests = 0;
    let declaredSuites = 0;
    for (const f of files) {
      const source = readFileSync(join(ROOT, 'tests', f), 'utf8');
      declaredTests += [...source.matchAll(/^[ \t]*(?:await[ \t]+)?test\(/gm)].length;
      declaredSuites += [...source.matchAll(/^[ \t]*describe\(/gm)].length;
    }

    // The literals and the exported constants must be the same numbers, so a floor
    // cannot be raised in the source text while importers keep the old value.
    const script = readFileSync(join(ROOT, 'scripts', 'parse-test-summary.ts'), 'utf8');
    const testFloor = Number(/const MINIMUM_TESTS = (\d+);/.exec(script)?.[1]);
    const suiteFloor = Number(/const MINIMUM_SUITES = (\d+);/.exec(script)?.[1]);
    assert.equal(testFloor, MINIMUM_TESTS, 'the declared test floor and the export must agree');
    assert.equal(suiteFloor, MINIMUM_SUITES, 'the declared suite floor and the export must agree');

    /*
     * THE SUITE FLOOR IS EXACTLY BOUNDABLE. Node reports one suite per `describe(`
     * declaration, and this tree's anchored count matches the reported total exactly
     * (47 declarations, 47 suites), so a floor above the count would make CI red
     * forever. This direction was checked NOWHERE before — the asymmetry is how the
     * suite floor reached 41 while the baseline fixture above still called a 40-suite
     * run acceptable.
     */
    assert.ok(
      suiteFloor <= declaredSuites,
      `the suite floor is ${suiteFloor} but only ${declaredSuites} suite declarations exist`,
    );

    /*
     * THE TEST FLOOR IS NOT UPPER-BOUNDABLE FROM SOURCE, and this test does not pretend
     * otherwise. A declaration inside a loop yields several tests from one site, so the
     * declaration count is a LOWER bound on what runs — 444 declarations against 459
     * tests reported — and it therefore CANNOT confirm that a floor pinned to the
     * measured total is reachable. Only a measured run can, which is why the floor is
     * pinned to `artifacts/test-summary.json` and the delivery report cites that
     * artifact rather than resting on this assertion.
     *
     * What source CAN decide is the other direction: a floor below the declaration count
     * is certainly too low, because at least that many tests must run.
     */
    assert.ok(
      declaredTests <= testFloor,
      `${declaredTests} test declarations exist but the floor is only ${testFloor}`,
    );
    assert.ok(files.length >= 20, `sanity: ${files.length} batteries exist`);
  });
});

describe('the requirement map (FBL-020-R4 §7)', () => {
  test('every requirement names tests that exist, and every R4 test file is claimed', () => {
    const problems = checkRequirementMap();
    assert.deepEqual(problems, [], problems.join('\n'));
  });

  test('a renamed or deleted test BREAKS the map', () => {
    // The check is only worth having if it can fail. `declaredTestNames` is the exact
    // function the checker uses, so a name that is NOT declared must be reported as
    // absent — proving the lookup is a real comparison and not a substring search
    // over the whole file.
    const map = loadRequirementMap();
    const withTests = map.requirements.find((r) => r.tests.length > 0);
    assert.ok(withTests, 'the map must name at least one test');
    const sample = withTests!.tests[0]!;
    const names = declaredTestNames(sample.file);
    assert.ok(names.has(sample.name), 'the sampled name is genuinely declared');
    assert.equal(
      names.has(sample.name + ' (renamed)'),
      false,
      'a renamed test must NOT be found, or the check would pass on anything',
    );
  });
});

describe('the mutation-kill runner (FBL-020-R4 §7)', () => {
  test('every mutation names code that EXISTS exactly once, in the file it claims', () => {
    const problems = anchorProblems();
    assert.deepEqual(problems, [], problems.join('\n'));
    assert.ok(MUTATIONS.length >= 6, 'the check must cover more than a token control');
  });

  test('removing a control statement really changes migration 057, and the runner refuses a bad anchor', () => {
    /*
     * The negative-control runner's anchors are the other half of the §6 gate, and the
     * same reasoning applies: an anchor that silently stopped matching would turn every
     * control into a no-op. The runner's own module is imported — not its source text
     * scraped — so this check cannot be fooled by a reformat and cannot disagree with
     * what the runner will actually do.
     */
    const sql = canonical057();
    // Loading the anchors is itself a check: it throws if any control has none, or if the
    // anchor file holds one no control uses.
    const anchors = loadAnchors();
    assert.ok(
      CONTROLS.length >= 10,
      `the runner must declare at least ten controls, found ${CONTROLS.length}`,
    );

    for (const control of CONTROLS) {
      const anchor = anchors[control.id] as ControlAnchor;
      const occurrences = sql.split(anchor.from).length - 1;
      assert.equal(
        occurrences,
        1,
        `${control.id}: its anchor occurs ${occurrences} time(s) in 057, expected exactly 1`,
      );
      // …and removing it must genuinely change the migration by exactly one statement.
      const mutated = removeStatement(sql, control, anchor);
      assert.ok(mutated.length < sql.length, `${control.id}: the removal changed nothing`);
      assert.equal(
        (sql.match(/;/g) ?? []).length - (mutated.match(/;/g) ?? []).length,
        1,
        `${control.id}: the removal must drop exactly one statement terminator`,
      );
    }

    // The refusal path: an anchor that does not resolve must THROW rather than mutate
    // approximately, because a control derived from a near-miss proves nothing.
    const sample = CONTROLS[0] as (typeof CONTROLS)[number];
    const good = anchors[sample.id] as ControlAnchor;
    assert.throws(
      () => removeStatement(sql, sample, { ...good, from: 'no such text in the migration' }),
      /start anchor not found/,
    );
    assert.throws(
      () => removeStatement(sql, sample, { ...good, to: 'ZZZ_no_such_terminator' }),
      /end anchor not found/,
    );
  });

  test('the mutation-kill job is wired into CI and gates on zero survivors', () => {
    assert.ok(
      WORKFLOW.includes('scripts/mutation-kill.ts'),
      'CI must run the mutation-kill checks',
    );
    assert.ok(
      WORKFLOW.includes('"mutations_survived": 0'),
      'CI must FAIL when a mutation survives, not merely record it',
    );
    assert.ok(WORKFLOW.includes('mutation-kill.json'), 'the result must be an artifact');
    assert.ok(workflowStepNames().has('Mutation-kill checks (isolated copy of the tree)'));
  });
});

describe('the populated upgrade drill (FBL-020-R4 §6)', () => {
  test('the populated identity fixture exists, is NONEMPTY, and is seeded by CI before 057', () => {
    const fixturePath = join(ROOT, 'tests', 'fixtures', 'legacy-identity-seed-pre-057.sql');
    assert.ok(existsSync(fixturePath), 'the populated identity fixture must be committed');
    const sql = readFileSync(fixturePath, 'utf8');

    /*
     * Every table the drill's census measures must actually be written by the fixture.
     * The targets are EXTRACTED from the fixture and compared as a set, rather than
     * built into a pattern per table: a pattern assembled from a table name is an
     * interpolated write position, which `scripts/check-owned-mutations.ts` refuses
     * everywhere — correctly, since that is the one shape a real write could hide in.
     */
    const seeded = new Set(
      [...sql.matchAll(/INSERT INTO ([a-z_]+)/g)].map((m) => (m[1] as string).trim()),
    );
    const required = [
      'tenants',
      'identity_provider_connections',
      'user_links',
      'identity_sessions',
      'role_bindings',
      'policy_decisions',
      'reauthentication_transactions',
      'reauthentication_grants',
      'support_access_requests',
      'support_access_sessions',
    ];
    const unseeded = required.filter((t) => !seeded.has(t));
    assert.deepEqual(
      unseeded,
      [],
      `the fixture must seed every census table — an empty table exercises no reconciliation: ${unseeded.join(', ')}`,
    );
    // The shapes the order requires: both link kinds, both revocation branches, both
    // effectiveness classes, an incomplete history and a pending request.
    assert.ok(sql.includes("'activated'"), 'activated links');
    assert.ok(sql.includes("'pending'"), 'a pending link and a pending support request');
    assert.ok(sql.includes("'disabled'"), 'a disabled connection, so a link is AMBIGUOUS');
    assert.ok(sql.includes("'approved'"), 'an approved support request with no grant');
    assert.ok(sql.includes("'revoked'"), 'a revoked role binding');
    assert.ok(sql.includes('2099-01-01'), 'a future-dated (ineffective) role binding');
    assert.ok(sql.includes('mfa_policy_certified'), 'an unbounded MFA certification');

    // …and CI must seed it BEFORE 057, or none of it is a pre-057 fixture.
    const seedAt = WORKFLOW.indexOf('legacy-identity-seed-pre-057.sql');
    const applyAt = WORKFLOW.indexOf('Apply 057 on top of the populated legacy data');
    assert.ok(seedAt > 0 && applyAt > 0, 'both steps must exist');
    assert.ok(seedAt < applyAt, 'the fixture must be seeded before 057 is applied');
  });

  test('the upgrade verifier has three phases and REFUSES to run without one', () => {
    const verifier = readFileSync(join(ROOT, 'scripts', 'verify-upgrade-state.ts'), 'utf8');
    for (const phase of ['backfill', 'pre-057', 'post-057']) {
      assert.ok(verifier.includes(`'${phase}'`), `the verifier must implement phase ${phase}`);
    }
    // Fail closed: no default phase, because a default would let a mis-typed flag run
    // the weakest set of assertions and report a pass.
    assert.ok(
      /if \(phase === undefined \|\| !PHASES\.includes/.test(verifier),
      'an unknown or absent phase must exit non-zero rather than defaulting',
    );
    // The empty-identity-tables assertion is KEPT — at the phase where it is true.
    assert.ok(
      verifier.includes('assertIdentityTablesEmpty'),
      "055/056's no-invention property must still be asserted",
    );
    assert.ok(
      verifier.includes('assertFixturePresent'),
      'and the populated phase must refuse an empty fixture',
    );
  });

  test('the upgrade job runs every phase, the negative controls, and gates on their JSON', () => {
    const steps = workflowStepNames();
    for (const step of [
      'Stage the pre-057 chain',
      'Migrate through the last PRE-057 migration (050..056)',
      'Verify the organization backfill invented no identities (phase=backfill)',
      'Seed NONEMPTY legacy identity data (pre-057 schema)',
      'Verify the identity fixture is present and NONEMPTY (phase=pre-057)',
      'Reconciliation negative controls (isolated copies of the pre-057 database)',
      'Apply 057 on top of the populated legacy data',
      'Verify the reconciled state and before/after counts (phase=post-057)',
      'Fingerprints must be identical (fresh chain vs upgrade path)',
    ]) {
      assert.ok(steps.has(step), `ci.yml must carry the step: ${step}`);
    }
    // A step that merely PRINTS a failure is not a gate.
    assert.ok(WORKFLOW.includes('"controls_failed": 0'), 'a failed control must fail the job');
    assert.ok(
      (WORKFLOW.match(/'"result": "OK"'/g) ?? []).length >= 2,
      'both populated phases must be gated on their own JSON verdict',
    );
  });

  test('every negative control names a statement that EXISTS exactly once in migration 057', () => {
    // Each control must declare WHERE it fails and WHAT the failure mentions, so a change
    // in 057 that shifts the failure mode is a review event rather than a silent
    // downgrade. An undeclared expectation would reduce the control to "something broke".
    const ids = new Set<string>();
    for (const c of CONTROLS) {
      assert.ok(/^[a-z0-9_]+$/.test(c.id), `control id ${c.id} must be a stable slug`);
      assert.equal(ids.has(c.id), false, `duplicate control id ${c.id}`);
      ids.add(c.id);
      assert.ok(
        c.expectStage === 'migration' || c.expectStage === 'verifier',
        `${c.id} must declare the stage it fails at`,
      );
      assert.ok(c.expectSignature.length > 3, `${c.id} must declare a failure signature`);
      assert.ok(c.intent.length > 40, `${c.id} must say what is lost when it is removed`);
      assert.ok(c.section.includes('§'), `${c.id} must name the section of 057 it belongs to`);
    }
    // Both stages must be represented: a set of controls that all fail the same way is
    // not covering the DATA failures, which are the ones with no error message.
    assert.ok(CONTROLS.some((c) => c.expectStage === 'migration'));
    assert.ok(CONTROLS.some((c) => c.expectStage === 'verifier'));

    // And the reconciliations that CANNOT be load-bearing on a pre-057 database are
    // enumerated with their reason rather than quietly omitted.
    assert.ok(
      NOT_LOAD_BEARING.length >= 6,
      `zero-row reconciliations must be enumerated, found ${NOT_LOAD_BEARING.length}`,
    );
    for (const entry of NOT_LOAD_BEARING) {
      assert.ok(entry.statement.includes('§'), 'each must name the section it is in');
      assert.ok(entry.reason.length > 20, 'each must say WHY it cannot be load-bearing');
    }
  });
});
