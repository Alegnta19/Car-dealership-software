import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
  MINIMUM_SUITES,
  MINIMUM_TESTS,
  ORDER_MINIMUM_SUITES,
  ORDER_MINIMUM_TESTS,
  counterContradictions,
  gateFailures,
  logGateFailures,
  observeTapLines,
  parseSummaryLines,
  type TestSummary,
} from '../scripts/parse-test-summary';
import {
  MAP_ORDER,
  checkRequirementMap,
  declaredTestNames,
  loadRequirementMap,
  orderTextClauses,
  workflowStepNames,
  type ClauseEntry,
  type MappedRequirement,
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
import {
  buildInventory,
  isReconciliation,
  loadDeclarations,
  normalizeStatement,
  parseStatements,
  splitStatements,
} from '../scripts/reconciliation-inventory';
import { compareToChain, manifest } from '../scripts/migration-manifest';
import { loadFixtureChains } from '../scripts/migration-fixture-chains';

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

  /*
   * ── FBL-020-R5 gate finding G2 ─────────────────────────────────────────
   *
   * A run printed `not ok 38 - migration ledger…` and the gate said OK, because every
   * field the gate read was a COUNTER and the counters read `fail 0`. These three tests
   * pin the correction: a printed failure is fatal whatever the counters say, a nested
   * one is not hidden by its indentation, and a counter that contradicts the lines is
   * itself reported. Each drives `logGateFailures`, which is what `main` now calls, so
   * deleting the check from the CLI path breaks them.
   */
  test('a printed `not ok` is FATAL even when the counters read fail=0', () => {
    const clean = ['TAP version 13'];
    for (let i = 1; i <= goodSummary().tests; i += 1) clean.push(`ok ${i} - assertion ${i}`);
    const cleanLog = clean.join('\n');

    // The baseline passes, or nothing below proves anything.
    assert.deepEqual(logGateFailures(cleanLog, goodSummary()), []);

    const withFailure = `${cleanLog}\nnot ok 38 - migration ledger integrity (FBL-020-R4 §0)`;
    const problems = logGateFailures(withFailure, goodSummary());
    assert.ok(
      problems.some((line) => line.includes('FAILING assertion line(s)')),
      `a printed failure must be refused, got: ${problems.join('; ')}`,
    );
    assert.ok(
      problems.some((line) => line.includes('not ok 38 - migration ledger integrity')),
      'the gate must NAME the failing line it found',
    );
  });

  test('an indented subtest failure is not hidden by its indentation', () => {
    const lines = ['TAP version 13'];
    for (let i = 1; i <= goodSummary().tests; i += 1) lines.push(`ok ${i} - assertion ${i}`);
    lines.push('    not ok 1 - a subtest whose parent reported ok');
    const observed = observeTapLines(lines.join('\n'));
    assert.equal(observed.not_ok, 1, 'a nested `not ok` must be counted');
    assert.ok(
      logGateFailures(lines.join('\n'), goodSummary()).some((line) =>
        line.includes('FAILING assertion line(s)'),
      ),
    );
  });

  test('counters that contradict the observed lines are reported as a defect', () => {
    const base = goodSummary();
    const observed = { ok: base.tests, not_ok: 0, not_ok_lines: [] };
    assert.deepEqual(counterContradictions(base, observed), []);

    assert.ok(
      counterContradictions(base, {
        ok: base.tests,
        not_ok: 2,
        not_ok_lines: ['not ok 1', 'not ok 2'],
      }).some((line) => line.includes('claims failed=0')),
      'failed=0 beside printed failures is a contradiction',
    );
    assert.ok(
      counterContradictions({ ...base, failed: 3, passed: base.tests - 3 }, observed).some((line) =>
        line.includes('but no'),
      ),
      'a failure count nobody printed is a contradiction',
    );
    assert.ok(
      counterContradictions(base, { ok: 0, not_ok: 0, not_ok_lines: [] }).some((line) =>
        line.includes('no'),
      ),
      'a summary describing a log with no assertions is a contradiction',
    );
    // A log with no assertion line at all is refused outright.
    assert.ok(
      logGateFailures('# tests 1\n', base).some((line) => line.includes('no assertions in it')),
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
     * (59 declarations, 59 suites at this revision), so a floor above the count would make CI red
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
     * declaration count is a LOWER bound on what runs — 548 declarations against 572
     * tests reported at this revision — and it therefore CANNOT confirm that a floor pinned to the
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

describe('the requirement map (FBL-020-R5 §3.5)', () => {
  test('every requirement names tests that exist, and every mapped battery is claimed', () => {
    const problems = checkRequirementMap();
    assert.deepEqual(problems, [], problems.join('\n'));
  });

  test('an OMITTED requirement fails the clause-coverage check', () => {
    /*
     * §3.5's point. R4's map validated the rows it happened to contain and could not
     * notice a clause with no row at all — the failure mode is silence, so the check is
     * only worth having if it has been shown to break. One clause's requirements are
     * dropped and the clause must come back as UNCOVERED, by name.
     */
    const map = loadRequirementMap();
    const clause = '§3.4';
    assert.ok(
      map.requirements.some((r) => r.revision === MAP_ORDER && r.clause === clause),
      `sanity: ${clause} is covered in the real map`,
    );
    const problems = checkRequirementMap({
      ...map,
      requirements: map.requirements.filter(
        (r) => !(r.revision === MAP_ORDER && r.clause === clause),
      ),
    });
    assert.ok(
      problems.some((p) => p.includes(`clause ${clause}`) && p.includes('NO FBL-020-R5')),
      `dropping ${clause} must be REPORTED as uncovered: ${problems.join('; ')}`,
    );
    // …and the real map must be clean, or the assertion above proves nothing.
    assert.deepEqual(checkRequirementMap(map), []);
  });

  test('a duplicate id, a malformed id and an undeclared clause are each REPORTED', () => {
    const map = loadRequirementMap();
    const first = map.requirements[0] as MappedRequirement;

    const duplicated = checkRequirementMap({ ...map, requirements: [...map.requirements, first] });
    assert.ok(
      duplicated.some((p) => p.includes(`${first.id}: duplicate requirement id`)),
      `a repeated id must be reported: ${duplicated.join('; ')}`,
    );

    const malformed = checkRequirementMap({
      ...map,
      requirements: [...map.requirements, { ...first, id: 'R5_3.5_requirement_map' }],
    });
    assert.ok(
      malformed.some((p) => p.includes('the id must read')),
      `an id of the wrong shape must be reported: ${malformed.join('; ')}`,
    );

    // An id whose clause and revision contradict their own declaration: both are caught,
    // because a row can otherwise claim to prove a clause it is not filed under.
    const contradictory = checkRequirementMap({
      ...map,
      requirements: [
        ...map.requirements,
        { ...first, id: 'R5-§0.1-mislabelled', revision: 'FBL-020-R4', clause: '§9.9' },
      ],
    });
    assert.ok(
      contradictory.some((p) => p.includes('declares revision FBL-020-R4, which its id')),
      `a revision that contradicts its id must be reported: ${contradictory.join('; ')}`,
    );
    assert.ok(
      contradictory.some((p) => p.includes('declares clause §9.9, which its id')),
      `a clause that contradicts its id must be reported: ${contradictory.join('; ')}`,
    );
  });

  test('the inventory cannot invent a clause the order text does not declare', () => {
    /*
     * The inventory's anchor is the checked-in order text (§3.2), not this repository's
     * own opinion: `docs/orders/FBL-020-R5.md` carries a clause register, and the two must
     * list the same clauses in both directions. A clause invented here is reported, and so
     * is a clause the order declares that the map forgot.
     */
    const map = loadRequirementMap();
    const declared = orderTextClauses();
    assert.ok(declared.size >= 10, `sanity: the order text registers ${declared.size} clauses`);

    const ghost: ClauseEntry = {
      clause: '§9.9',
      title: 'a clause no order ever issued',
      text_held_verbatim: false,
      evidence: 'none, which is the point',
    };
    const invented = checkRequirementMap({
      ...map,
      clause_inventory: [...map.clause_inventory, ghost],
    });
    assert.ok(
      invented.some((p) => p.includes('clause §9.9 is in the inventory but not in the order text')),
      `an invented clause must be reported: ${invented.join('; ')}`,
    );

    const dropped = checkRequirementMap({
      ...map,
      clause_inventory: map.clause_inventory.slice(1),
    });
    const missing = map.clause_inventory[0] as ClauseEntry;
    assert.ok(
      dropped.some(
        (p) => p.includes(`clause ${missing.clause}`) && p.includes('not in the inventory'),
      ),
      `a clause the order declares but the map omits must be reported: ${dropped.join('; ')}`,
    );

    /*
     * And a clause claimed as held verbatim must really be a heading in the order text.
     *
     * THE PERTURBATION HAS TO SUPPLY THE CLAUSE, and that is a fact about the tree rather
     * than a convenience. An earlier version of this assertion flipped the real §0.1
     * entry's `text_held_verbatim` to `true` — which was a genuine overclaim while the
     * order file still recorded some clauses as "text not held". `docs/orders/FBL-020-R5.md`
     * now carries EVERY clause of the order verbatim, with its own heading, so there is no
     * longer a real clause the flip could overclaim: the perturbation became inert and the
     * assertion stopped proving anything. A clause the order text does not carry at all is
     * therefore introduced, which is the only shape that still reaches this branch.
     */
    const overclaimed = checkRequirementMap({
      ...map,
      clause_inventory: [...map.clause_inventory, { ...ghost, text_held_verbatim: true }],
    });
    assert.ok(
      overclaimed.some((p) => p.includes('§9.9 is declared as held verbatim')),
      `claiming text the order file does not carry must be reported: ${overclaimed.join('; ')}`,
    );
    // …and the real inventory claims nothing the order file does not carry.
    assert.deepEqual(checkRequirementMap(map), []);
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

describe('the reconciliation inventory of migration 057 (FBL-020-R5 §0.6)', () => {
  test('every reconciliation in 057 is accounted for, and nothing is declared that is not there', () => {
    const result = buildInventory();
    assert.deepEqual(result.problems, [], result.problems.join('\n'));
    // The numbers the delivery report is allowed to quote, asserted here so a claim about
    // coverage cannot drift away from what the inventory actually found.
    assert.equal(result.totals.reconciliations_unaccounted, 0);
    assert.equal(
      result.totals.reconciliations,
      result.totals.reconciliations_covered_by_a_negative_control +
        result.totals.reconciliations_declared_not_load_bearing +
        result.totals.reconciliations_that_are_refusal_guards,
      'the three buckets must partition the reconciliations exactly',
    );
    assert.ok(result.totals.reconciliations >= 30, `only ${result.totals.reconciliations} found`);
  });

  test('a reconciliation with NO control and NO declaration is REPORTED, not tolerated', () => {
    /*
     * The check is worth nothing if it cannot fail. One declaration is dropped and the
     * statement it covered must come back as UNACCOUNTED — which is exactly the state R4 was
     * in for two of the three statements of the grantless-approval reconciliation, with
     * nothing anywhere to say so.
     */
    const declarations = loadDeclarations();
    assert.ok(declarations.length > 0, 'the inventory must declare something');
    const dropped = declarations[0]!;
    const result = buildInventory(canonical057(), declarations.slice(1));
    assert.ok(
      result.problems.some((p) => p.includes('nothing accounts') && p.includes(dropped.key)),
      `dropping ${dropped.statement} must produce an UNACCOUNTED problem: ${result.problems.join('; ')}`,
    );
    assert.equal(result.totals.reconciliations_unaccounted, 1);
  });

  test('a declaration that matches no statement is REPORTED, so the file cannot go stale', () => {
    const declarations = loadDeclarations();
    const result = buildInventory(canonical057(), [
      ...declarations,
      {
        key: 'f'.repeat(64),
        classification: 'not-load-bearing' as const,
        section: '§0 — nowhere',
        statement: 'a statement that no longer exists',
        reason: 'it was deleted, and this declaration was not',
      },
    ]);
    assert.ok(
      result.problems.some((p) => p.includes('no statement in 057 has that key any more')),
      result.problems.join('; '),
    );
  });

  test('control coverage is COMPUTED from the anchors, so it cannot be overstated', () => {
    // Every control must resolve to a statement in 057, and each of the three statements of
    // the grantless-approval reconciliation must be covered by a DIFFERENT control. That last
    // part is the R4 defect, stated as an assertion.
    const result = buildInventory();
    const covered = result.rows.filter((r) => r.classification === 'control');
    assert.equal(
      covered.length,
      CONTROLS.length,
      'every declared control must resolve to exactly one statement in 057',
    );
    const grantless = [
      'sas_grantless_approval_session_revoked',
      'aud_grantless_approval_supersession_recorded',
      'sar_approval_without_grant_superseded',
    ];
    for (const id of grantless)
      assert.ok(
        covered.some((r) => r.control_id === id),
        `${id} must cover a statement of its own`,
      );
    const keys = new Set(
      covered.filter((r) => grantless.includes(r.control_id ?? '')).map((r) => r.key),
    );
    assert.equal(keys.size, 3, 'the three controls must remove three DIFFERENT statements');
  });

  test('the statement splitter respects dollar-quoting, strings and comments', () => {
    /*
     * A `split(';')` would cut every DO block and function body in 057 into fragments, and
     * the inventory built from those fragments would classify nothing correctly while
     * appearing to work. These are the four constructs that make the naive version wrong.
     */
    const sql = [
      "SELECT 'a;b';",
      'DO $$ BEGIN RAISE EXCEPTION $x$no;pe$x$; END $$;',
      '-- a comment with a ; in it',
      '/* block ; comment */',
      'UPDATE t SET x = 1;',
    ].join('\n');
    const statements = splitStatements(sql);
    assert.equal(statements.length, 3, statements.map((x) => x.text.trim()).join(' || '));

    const parsed = parseStatements(sql);
    assert.deepEqual(
      parsed.map((x) => x.verb),
      ['SELECT', 'DO', 'UPDATE'],
    );
    assert.equal(parsed[1]?.raises, true, 'a DO block that RAISEs is a refusal guard');
    assert.equal(parsed[2]?.target, 't');
    assert.deepEqual(parsed.map(isReconciliation), [false, true, true]);

    // The key ignores whitespace and comments, and nothing else.
    assert.equal(
      normalizeStatement('UPDATE  t\n   SET x = 1; -- why\n'),
      normalizeStatement('UPDATE t SET x = 1;'),
    );
    assert.notEqual(
      normalizeStatement('UPDATE t SET x = 1;'),
      normalizeStatement('UPDATE t SET x = 2;'),
    );
  });

  test('the inventory is wired into CI and gates on zero unaccounted reconciliations', () => {
    assert.ok(WORKFLOW.includes('scripts/reconciliation-inventory.ts'));
    assert.ok(
      WORKFLOW.includes('"reconciliations_unaccounted": 0'),
      'CI must FAIL on an unaccounted reconciliation, not merely record it',
    );
  });
});

describe('the retained-fixture digest pin (FBL-020-R5 §0.5)', () => {
  const FIXTURE = join(ROOT, 'tests', 'fixtures', 'schema-f76a27a');

  test('the retained fixture matches its FIXED committed digests', () => {
    const problems = compareToChain(manifest(FIXTURE), 'schema-f76a27a');
    assert.deepEqual(problems, [], problems.join('\n'));
  });

  test('a CHANGED, EXTRA or MISSING fixture file is refused, not re-recorded', () => {
    /*
     * The step this replaces was named "must stay byte-identical to f76a27a" and could not
     * detect that it had not: it wrote down whatever it found. So the comparison is driven
     * against a perturbed manifest here, in all three directions.
     */
    const good = manifest(FIXTURE);
    assert.ok(good.length >= 2);

    const changed = good.map((e, i) =>
      i === 0 ? { ...e, sha256_canonical_lf: 'a'.repeat(64) } : e,
    );
    assert.ok(
      compareToChain(changed, 'schema-f76a27a').some((p) => p.includes('has CHANGED')),
      'a changed body must be refused',
    );

    const extra = [
      ...good,
      { file: '999_smuggled.sql', sha256: 'b'.repeat(64), sha256_canonical_lf: 'b'.repeat(64) },
    ];
    assert.ok(
      compareToChain(extra, 'schema-f76a27a').some((p) => p.includes('NOT DECLARED')),
      'an undeclared extra file must be refused',
    );

    assert.ok(
      compareToChain(good.slice(1), 'schema-f76a27a').some((p) => p.includes('NOT PRESENT')),
      'a missing declared file must be refused',
    );

    // …and a chain whose bodies are deliberately NOT pinned cannot be compared this way,
    // rather than silently reporting a pass.
    assert.ok(
      compareToChain(good, 'ledger-probe').some((p) => p.includes('not pinned to fixed digests')),
    );
  });

  test('the manifest pins the CANONICAL-LF digest, not the bytes on disk', () => {
    // On a Windows checkout the two differ for every file (core.autocrlf), so a pin against
    // the raw bytes could only ever pass on one platform. The chain's declared value must be
    // the canonical one.
    const chains = loadFixtureChains();
    const chain = chains['schema-f76a27a'];
    assert.ok(chain !== undefined && chain.kind === 'pinned');
    if (chain === undefined || chain.kind !== 'pinned') return;
    for (const e of manifest(FIXTURE)) {
      assert.equal(chain.files[e.file], e.sha256_canonical_lf);
      assert.match(e.sha256, /^[0-9a-f]{64}$/, 'the raw digest is still recorded, as evidence');
    }
  });

  test('CI compares the retained fixture instead of merely recording it', () => {
    assert.ok(
      WORKFLOW.includes('--expect-chain schema-f76a27a'),
      'the upgrade job must COMPARE the retained fixture against the committed digests',
    );
    assert.ok(WORKFLOW.includes('MIGRATION_FIXTURE_CHAIN'), 'and declare each partial chain');
  });
});
