import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

/**
 * FBL-010 section C: the dependency rules are binding, in both directions.
 *
 * Positive: the real repository passes the checker. Negative: a fixture that reaches
 * into another module's persistence adapter is REJECTED — the test succeeds only
 * because the forbidden import produces a nonzero result, proving the checker actually
 * bites rather than silently passing everything.
 */

const ROOT = join(__dirname, '..');

function depcruise(target: string): { code: number; output: string } {
  // Through the same wrapper the CI gate uses: dependency-cruiser's own exit code
  // proved platform-dependent, so the wrapper owns the verdict from parsed JSON.
  try {
    const output = execFileSync(
      'npx',
      ['tsx', 'scripts/check-dependencies.ts', ...target.split(' ')],
      {
        cwd: ROOT,
        encoding: 'utf8',
        shell: process.platform === 'win32',
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    return { code: 0, output };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

function run(script: string): { code: number; output: string } {
  return runWith(script, []);
}

function runWith(script: string, args: string[]): { code: number; output: string } {
  try {
    const output = execFileSync('npx', ['tsx', script, ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      shell: process.platform === 'win32',
      maxBuffer: 64 * 1024 * 1024,
    });
    return { code: 0, output };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

describe('architecture enforcement', () => {
  test('the real repository passes every dependency rule', () => {
    const { code, output } = depcruise('apps packages');
    assert.equal(code, 0, `dependency violations in the real tree:\n${output}`);
  });

  test('a forbidden import of another module persistence adapter is rejected', () => {
    const { code, output } = depcruise('architecture/fixtures');
    assert.notEqual(
      code,
      0,
      'the checker accepted the forbidden fixture — it is not enforcing anything',
    );
    assert.match(
      output,
      /no-outside-deep-import-into-packages[\s\S]*reaches-into-persistence/,
      'the rejection must come from the deep-import rule, on the fixture file',
    );
  });

  test('the real apps tree passes the app-SQL guard', () => {
    const { code, output } = run('scripts/check-app-sql.ts');
    assert.equal(code, 0, output);
    assert.match(output, /app-SQL guard OK/);
  });

  test('an app importing a query primitive and embedding SQL is rejected', () => {
    const { code, output } = runWith('scripts/check-app-sql.ts', [
      'architecture/fixtures/forbidden-app-sql',
    ]);
    assert.notEqual(code, 0, 'the app-SQL guard accepted the forbidden fixture');
    assert.match(output, /app-no-db-query-primitives[\s\S]*app-with-sql/);
    assert.match(output, /app-no-sql-literals[\s\S]*SELECT/);
  });

  test('the ownership manifest matches the real workspace', () => {
    const { code, output } = run('scripts/check-architecture-manifest.ts');
    assert.equal(code, 0, output);
    assert.match(output, /14 modules/);
  });

  test('process.env stays confined to the approved configuration/composition files', () => {
    const { code, output } = run('scripts/check-env-access.ts');
    assert.equal(code, 0, output);
  });

  /**
   * FBL-020-R3 correction E3, hardened by H1. Three of that revision's defects
   * were one shape: a second, hand-written copy of the role-bindings
   * effectiveness rule that had dropped the effective window, so a binding left
   * `active` with an `effective_to` in the past passed one gate while the policy
   * engine refused. Wave 2 exported the predicate once and then shipped two more
   * restatements of it anyway, which is the evidence that review does not hold
   * this line. The build does.
   *
   * H1 then found that the guard itself was a set of text-shape heuristics, with
   * holes in both directions: SQL that never spelled the table in one literal, or
   * that interpolated the predicate and then ORed it away, or that carried twenty
   * characters of unvalidated prose as an "opt-out", all passed with exit 0 — and
   * correct code that reached the predicate through a namespaced or aliased
   * import was REJECTED. So the guard's own correctness is pinned here, by a
   * fixture battery rather than by a one-off manual run: every fixture's exact
   * rule set is asserted, and the guard is the thing under test.
   */
  describe('the role-bindings effectiveness rule has exactly one implementation', () => {
    const OPT_OUT_CODES = [
      'predicate-definition',
      'migration-reconciliation',
      'all-bindings-including-ineffective',
      'unresolvable-sql-hand-reviewed',
    ];

    /**
     * file → the exact set of rules that file exists to raise, AND HOW MANY
     * violations it raises. The count is load-bearing rather than decorative:
     * several of these fixtures hold more than one drifting statement, each
     * reached through a different mechanism, and a rule set on its own would let
     * one of them stop biting while a sibling in the same file went on raising
     * the same rule names.
     */
    const EXPECTED_REJECTIONS: Record<string, { violations: number; rules: string[] }> = {
      // The four controls: caught before H1, and still caught. A rewrite that
      // gained reach while losing these would have traded one hole for another.
      'control-1-coalesce-hidden-filter.ts': {
        violations: 1,
        rules: ['role-binding-read-must-use-shared-predicate'],
      },
      'control-2-no-filter-at-all.ts': {
        violations: 1,
        rules: ['role-binding-read-must-use-shared-predicate'],
      },
      'control-3-uppercase-and-schema-qualified.ts': {
        violations: 4,
        rules: [
          'role-binding-effectiveness-must-not-be-restated',
          'role-binding-read-must-use-shared-predicate',
        ],
      },
      'control-4-cte-rename-and-second-read.ts': {
        violations: 3,
        rules: [
          'role-binding-effectiveness-must-not-be-restated',
          'role-binding-read-must-use-shared-predicate',
        ],
      },
      // (a) and (b): the table name and the SQL body assembled indirectly. Both
      // reported `0 statement(s) inspected, OK` before H1.
      'evasion-a-interpolated-table-name.ts': {
        violations: 2,
        rules: [
          'role-binding-effectiveness-must-not-be-restated',
          'role-binding-read-must-use-shared-predicate',
        ],
      },
      'evasion-b-assembled-fragments.ts': {
        violations: 4,
        rules: [
          'role-binding-effectiveness-must-not-be-restated',
          'role-binding-read-must-use-shared-predicate',
        ],
      },
      // (c) the predicate interpolated and then neutralised: one read, one use,
      // no restated column — fully compliant to the pre-H1 guard.
      'evasion-c-neutralised-predicate.ts': {
        violations: 3,
        rules: ['role-binding-effectiveness-must-not-be-weakened'],
      },
      // (d) twenty characters of prose as an exception.
      'evasion-d-unvalidated-opt-out.ts': {
        violations: 1,
        rules: ['role-binding-effectiveness-opt-out-must-name-a-reason-code'],
      },
      // …and the closed set is validated, not merely parsed.
      'evasion-d2-opt-out-validation.ts': {
        violations: 3,
        rules: [
          'role-binding-effectiveness-opt-out-reason-code-not-applicable-here',
          'role-binding-effectiveness-opt-out-reason-code-unrecognised',
          'role-binding-effectiveness-opt-out-unjustified',
        ],
      },
      // "I could not tell" is a failure now, not a silent pass.
      'evasion-e-unresolvable-table.ts': {
        violations: 1,
        rules: ['role-binding-sql-not-statically-resolvable'],
      },
      // A local constant of the same name is not the shared predicate.
      'evasion-f-shadowed-predicate.ts': {
        violations: 3,
        rules: [
          'role-binding-effectiveness-must-not-be-restated',
          'role-binding-predicate-must-be-declared-once',
          'role-binding-read-must-use-shared-predicate',
        ],
      },
      // (g) and (h): ONE statement, MANY possible tables — taken from an object
      // literal under a key nothing static can resolve, and from a `for … of`
      // over an array of names. Both begin with an innocent possibility, so a
      // resolver that judged ONE value per expression rather than all of them
      // would clear both files while the role-bindings read went unexamined.
      'evasion-g-lookup-map-table.ts': {
        violations: 2,
        rules: [
          'role-binding-effectiveness-must-not-be-restated',
          'role-binding-read-must-use-shared-predicate',
        ],
      },
      'evasion-h-loop-over-table-list.ts': {
        violations: 2,
        rules: [
          'role-binding-effectiveness-must-not-be-restated',
          'role-binding-read-must-use-shared-predicate',
        ],
      },
      // (i) the third shape that produces many possibilities: `?:`, `??` and
      // `||`, each with the innocent name in the branch that is read first.
      'evasion-i-alternative-table.ts': {
        violations: 6,
        rules: [
          'role-binding-effectiveness-must-not-be-restated',
          'role-binding-read-must-use-shared-predicate',
        ],
      },
      // (j) … (r): ASSEMBLY. H1 resolved `${…}` and `+` and nothing else, so the
      // same fragments combined by any other spelling produced `0 statement(s)
      // inspected, OK` — a call expression carried no SELECT, no FROM and no
      // table name, so no variant looked like SQL and nothing was judged. Each of
      // these files is that hole in a different spelling.
      'evasion-j-array-join.ts': {
        violations: 6,
        rules: [
          'role-binding-effectiveness-must-not-be-restated',
          'role-binding-read-must-use-shared-predicate',
        ],
      },
      'evasion-k-string-concat.ts': {
        violations: 4,
        rules: [
          'role-binding-effectiveness-must-not-be-restated',
          'role-binding-read-must-use-shared-predicate',
        ],
      },
      // (l) `String.raw` was an UNDECLARED, UNVALIDATED, one-token off switch:
      // the literal was skipped outright, needing no reason code and no
      // justification — precisely what the opt-out validation exists to forbid.
      'evasion-l-string-raw.ts': {
        violations: 4,
        rules: [
          'role-binding-effectiveness-must-not-be-restated',
          'role-binding-read-must-use-shared-predicate',
        ],
      },
      // (m) the statement is COMPLIANT and then rewritten. `.replace` can delete
      // the shared predicate; `.slice` can cut the statement off before it; a
      // case fold changes what every rule matches. None is modelled, so none may
      // be assumed innocent — the receiver identifies the read and the rewrite is
      // reported.
      'evasion-m-opaque-string-operations.ts': {
        violations: 3,
        rules: ['role-binding-sql-not-statically-resolvable'],
      },
      // (n) and (o): the pieces are resolvable, the COMBINER is not — a reducer's
      // callback and a template tag are both functions this guard does not run.
      // Both are reported for what the pieces say AND marked unresolvable, rather
      // than either being assumed safe or being skipped.
      'evasion-n-reduce-accumulation.ts': {
        violations: 3,
        rules: [
          'role-binding-effectiveness-must-not-be-restated',
          'role-binding-read-must-use-shared-predicate',
          'role-binding-sql-not-statically-resolvable',
        ],
      },
      'evasion-o-custom-template-tag.ts': {
        violations: 3,
        rules: [
          'role-binding-effectiveness-must-not-be-restated',
          'role-binding-read-must-use-shared-predicate',
          'role-binding-sql-not-statically-resolvable',
        ],
      },
      // (p) the fragment list is transformed before it is joined. `.slice` with
      // literal bounds, `Object.values` and array `.concat` are exact; `.map` and
      // `.flat` rearrange or rewrite in a callback, so those two also raise the
      // unresolvable rule — which is why this file's set contains all three.
      'evasion-p-array-transforms.ts': {
        violations: 12,
        rules: [
          'role-binding-effectiveness-must-not-be-restated',
          'role-binding-read-must-use-shared-predicate',
          'role-binding-sql-not-statically-resolvable',
        ],
      },
      // (q) no join at all: the fragments are read back out by index. `sites`
      // answered an index through the object-literal path, and an array is not an
      // object literal, so every fragment resolved to nothing.
      'evasion-q-indexed-fragments.ts': {
        violations: 4,
        rules: [
          'role-binding-effectiveness-must-not-be-restated',
          'role-binding-read-must-use-shared-predicate',
        ],
      },
      // (r) the oldest spelling there is, and the one with no assembly expression
      // in it: an accumulator appended to across several statements, which by the
      // time it reaches `query()` is a bare identifier whose declaration is one
      // innocent fragment.
      'evasion-r-accumulated-statement.ts': {
        violations: 4,
        rules: [
          'role-binding-effectiveness-must-not-be-restated',
          'role-binding-read-must-use-shared-predicate',
        ],
      },
      // (s) … (w): the R3 closeout. Every one of these passed the guard as
      // shipped, and every one is a claim the header made that the code did not
      // keep — which is the same failure as drifting SQL, one level up.
      //
      // (s) rule 4 wanted TWO structural marks before calling a string a
      // statement, and the second had to be a clause keyword. An unguarded
      // full-table read is the one shape with no clause in it, so
      // `SELECT … FROM ${table}` was reported nowhere while the same read with a
      // `LIMIT` was reported. A SELECT LIST is now the second mark too.
      'evasion-s-blind-full-table-read.ts': {
        violations: 2,
        rules: ['role-binding-sql-not-statically-resolvable'],
      },
      // (t) rule 1 counted uses GLOBALLY, so a second copy of the predicate in
      // one read paid for a second unguarded read — defeating control 4 with one
      // edit. A use is now bound to the read it follows.
      'evasion-t-guarded-once-counted-twice.ts': {
        violations: 2,
        rules: ['role-binding-read-must-use-shared-predicate'],
      },
      // (u) rule 3 reads what is ADJACENT to the predicate, and a comment is
      // text: `${…} -- …\n OR TRUE` moved the OR out of adjacency. Comments are
      // stripped before anything is judged.
      'evasion-u-comment-carried-weakening.ts': {
        violations: 2,
        rules: ['role-binding-effectiveness-must-not-be-weakened'],
      },
      // (v) the predicate in the SELECT list defeated rules 1 and 3 at once: it
      // counted as a use and it filters nothing. It now counts as no use (so the
      // read it pretended to guard is reported) and is named under rule 3 —
      // which is why this file raises both.
      'evasion-v-predicate-in-projection.ts': {
        violations: 2,
        rules: [
          'role-binding-effectiveness-must-not-be-weakened',
          'role-binding-read-must-use-shared-predicate',
        ],
      },
      // (w) negation not spelled next to the predicate: De Morgan's
      // `NOT (x AND ${…})`, and `(${…}) IS NOT TRUE`. The enclosing groups are
      // examined and the comparison is named.
      'evasion-w-negated-without-an-adjacent-not.ts': {
        violations: 2,
        rules: ['role-binding-effectiveness-must-not-be-weakened'],
      },
    };

    test('the real tree passes, and every exception declares a recognised reason code', () => {
      const { code, output } = run('scripts/check-role-binding-effectiveness.ts');
      assert.equal(code, 0, output);
      assert.match(output, /role-bindings effectiveness guard OK/);
      // The guard must actually be looking at something: a run that inspected
      // zero statements would "pass" while enforcing nothing.
      const inspected = /(\d+) statement\(s\) inspected/.exec(output);
      assert.ok(inspected?.[1] !== undefined, `no inspection count in output:\n${output}`);
      assert.ok(
        Number(inspected[1]) >= 8,
        `only ${inspected[1]} statement(s) inspected — the guard is not reaching the identity SQL`,
      );
      // Each opt-out prints its category and its justification, so growth in
      // their number is visible in review rather than buried in a script. The
      // declared count in the summary must match the number of lines actually
      // printed — an exception that did not name itself would be invisible.
      const declared = /(\d+) declared opt-out\(s\)/.exec(output);
      assert.ok(declared?.[1] !== undefined, `no opt-out count in output:\n${output}`);
      const printed = output
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.startsWith('opt-out '));
      assert.equal(printed.length, Number(declared[1]), `every opt-out must print:\n${output}`);
      for (const line of printed) {
        const parsed = /^opt-out \S+:\d+ \[([a-z0-9-]+)\] — (\S[\s\S]*)$/.exec(line);
        assert.ok(parsed !== null, `an opt-out must print its reason code and reason: ${line}`);
        assert.ok(
          OPT_OUT_CODES.includes(String(parsed[1])),
          `"${String(parsed[1])}" is outside the closed set of exception categories: ${line}`,
        );
        assert.ok(
          String(parsed[2]).length >= 40,
          `an opt-out must state a real reason, not a label: ${line}`,
        );
      }
    });

    test('every adversarial fixture is REJECTED, with exactly the rules it exists to prove', () => {
      const { code, output } = runWith('scripts/check-role-binding-effectiveness.ts', [
        'architecture/fixtures/role-binding-drift',
      ]);
      assert.notEqual(
        code,
        0,
        `the guard accepted the drifting fixtures — it is not enforcing anything:\n${output}`,
      );
      const byFile = new Map<string, { violations: number; rules: Set<string> }>();
      for (const line of output.split(/\r?\n/)) {
        const parsed = /^\s*error ([a-z0-9-]+): architecture\/fixtures\/[^/]+\/([^:]+):\d+ /.exec(
          line,
        );
        if (parsed === null) continue;
        const file = String(parsed[2]);
        const seen = byFile.get(file) ?? { violations: 0, rules: new Set<string>() };
        seen.violations += 1;
        seen.rules.add(String(parsed[1]));
        byFile.set(file, seen);
      }
      const actual: Record<string, { violations: number; rules: string[] }> = {};
      for (const [file, seen] of byFile) {
        actual[file] = { violations: seen.violations, rules: [...seen.rules].sort() };
      }
      // Deep equality in BOTH directions: a fixture that stopped being rejected
      // fails, and so does a fixture rejected for a reason it was not written to
      // prove — which is what a rule quietly widening past its statement looks like.
      assert.deepEqual(
        actual,
        Object.fromEntries(
          Object.entries(EXPECTED_REJECTIONS).map(([f, e]) => [
            f,
            { violations: e.violations, rules: [...e.rules].sort() },
          ]),
        ),
        `the fixture verdicts changed:\n${output}`,
      );
      // Rule names alone would be satisfied by a guard that reported the right
      // rule for the wrong reason, so the load-bearing details are pinned too.
      assert.match(
        output,
        /evasion-c[^\n]*the shared predicate is the LEFT operand of an OR with TRUE/,
        'the neutralised predicate must be named as a disjunction with a tautology',
      );
      assert.match(
        output,
        /evasion-c[^\n]*the shared predicate is NEGATED/,
        'NOT (predicate) must be named as a negation',
      );
      assert.match(
        output,
        /control-4[^\n]*2 read\(s\) of the role-bindings table, 1 resolved use\(s\)/,
        'resolving the shared predicate for ONE of two reads is not compliance',
      );
      assert.match(
        output,
        /evasion-e[^\n]*cannot resolve `table`, `filter`/,
        'an unresolvable statement must name what it could not resolve',
      );
      // The assembly fixtures must be RESOLVED, not merely noticed. A guard that
      // reported them as unreadable would satisfy the rule names above while
      // saying nothing about what the statement does, so the join fixture is
      // pinned to an exact, fully resolved reading: one read, no predicate.
      assert.match(
        output,
        /evasion-j[^\n]*1 read\(s\) of the role-bindings table, 0 resolved use\(s\)/,
        'a joined array must render as ONE resolved statement',
      );
      // (That it raises ONLY those two rules — that a resolvable assembly is not
      // reported as opaque instead — is already pinned by the deep equality
      // above, in both directions.)
      // And the operations that CANNOT be resolved must name themselves, so a
      // reviewer sees which rewrite the guard declined to model.
      assert.match(
        output,
        /evasion-m[^\n]*cannot resolve `GUARDED\.replace\(/,
        'a rewrite of a compliant statement must be named as the thing that could not be resolved',
      );
      assert.match(
        output,
        /evasion-o[^\n]*cannot resolve `sql`/,
        'an unmodelled template tag must be named',
      );
      // The R3 closeout, pinned the same way: each of these is a rule name that
      // would be raised by the wrong mechanism if the detail were not checked.
      assert.match(
        output,
        /evasion-s[^\n]*cannot resolve `table`/,
        'a full-table read through a blind table position must be reported without needing a clause',
      );
      assert.match(
        output,
        /evasion-t[^\n]*2 read\(s\) of the role-bindings table, 2 resolved use\(s\)[^\n]*none bound to it/,
        'two uses interpolated into ONE read must not pay for a second, unguarded read',
      );
      assert.match(
        output,
        /evasion-u[^\n]*the shared predicate is the LEFT operand of an OR with TRUE/,
        'a comment between the predicate and the OR must not carry the OR out of adjacency',
      );
      assert.match(
        output,
        /evasion-v[^\n]*the shared predicate sits in a SELECT LIST/,
        'a predicate in the projection must be named as a returned column, not counted as a guard',
      );
      assert.match(
        output,
        /evasion-w[^\n]*the shared predicate is NEGATED/,
        "De Morgan's negation of an enclosing group must be named as a negation",
      );
      assert.match(
        output,
        /evasion-w[^\n]*COMPARED rather than conjoined \(IS NOT TRUE\)/,
        'a comparison applied to the predicate must be named with the spelling used',
      );
    });

    test('correct code is ACCEPTED however the shared predicate is spelled', () => {
      // Two of the first three shapes were REJECTED before H1, because "guarded"
      // was a count of the literal substring `${EFFECTIVE_ROLE_BINDING_SQL}`. A
      // guard that rejects correct code teaches authors to route around it, which
      // is how the drift it exists to prevent gets written.
      //
      // The last two are the false-positive controls for the assembly work: a
      // statement built by `.join`, `.concat` and `String.raw` that DOES resolve
      // the predicate, and the raw templates that really do build regular
      // expressions — which the guard used to skip wholesale and now judges.
      const { code, output } = runWith('scripts/check-role-binding-effectiveness.ts', [
        'architecture/fixtures/role-binding-correct',
      ]);
      assert.equal(code, 0, `correct code was rejected:\n${output}`);
      assert.match(
        output,
        /8 statement\(s\) inspected, 0 declared opt-out\(s\)/,
        'every spelling must be inspected — a skipped one is a hole — and none may need an exception',
      );
    });
  });

  /**
   * FBL-020-R4 §3 — THE AUDIT-INVENTORY COMPLETENESS GATE.
   *
   * The inventory's header claimed that "a transition added to the platform without an
   * entry fails the completeness assertion". No such assertion existed anywhere, and the
   * inventory was in fact a SUBSET: production code wrote 33 identity audit event types
   * it did not list, four of them inside its own declared `support` family, and
   * `identity.support.expired` — the event §4's OWN expiry processor writes — among them.
   * The suite stayed green throughout, because nothing compared the list to the code.
   *
   * `scripts/check-audit-inventory.ts` is the assertion that sentence described. These
   * tests are what stop it from becoming another sentence: the real tree must PASS, and
   * each way of bringing an uninventoried audit event into existence must be REJECTED BY
   * ITS OWN RULE.
   *
   * R4 correction F1a is the reason there is a second fixture corpus. The gate's FIRST
   * version read names with one regular expression over `node.text` plus one look at
   * `node.head.text`, and both were defeated in twelve lines: `'identity.support' +
   * '.quarantined'` puts no complete name in any literal, and `` `${NS}.quarantined` ``
   * has an EMPTY head. Most of the twelve spellings in
   * `architecture/fixtures/audit-inventory-assembly/` were invisible to that version;
   * the exact count is deliberately not stated, because it was published as ten here
   * and as eleven in two documents and never re-measured — see KNOWN-LIMITATIONS. What
   * this suite asserts is the part that matters and is reproducible: the gate that ships
   * rejects all twelve. The evaluator that reads
   * all of them already existed in the SIBLING guard, so it now lives in
   * `scripts/static-string-resolver.ts` and both gates import it — which is the same "one
   * implementation" rule the role-bindings guard enforces for SQL, applied to the guards.
   *
   * The rules that judge the DECLARATION rather than a scanned file cannot be reached by
   * a fixture at all; they are driven directly, one test per rule, in
   * `tests/audit-inventory-rules.test.ts` (R4 correction F2).
   */
  describe('audit inventory completeness (FBL-020-R4 §3)', () => {
    /** Per-fixture verdicts from one gate run: how many violations, and which rules. */
    function auditVerdicts(dir: string): {
      code: number;
      output: string;
      actual: Record<string, { violations: number; rules: string[] }>;
    } {
      const { code, output } = runWith('scripts/check-audit-inventory.ts', [dir]);
      const byFile = new Map<string, { violations: number; rules: Set<string> }>();
      for (const line of output.split(/\r?\n/)) {
        const parsed = /^\s*error ([a-z0-9-]+): architecture\/fixtures\/[^/]+\/([^:]+):\d+ /.exec(
          line,
        );
        if (parsed === null) continue;
        const file = String(parsed[2]);
        const seen = byFile.get(file) ?? { violations: 0, rules: new Set<string>() };
        seen.violations += 1;
        seen.rules.add(String(parsed[1]));
        byFile.set(file, seen);
      }
      const actual: Record<string, { violations: number; rules: string[] }> = {};
      for (const [file, seen] of byFile) {
        actual[file] = { violations: seen.violations, rules: [...seen.rules].sort() };
      }
      return { code, output, actual };
    }

    function expect(
      table: Record<string, { violations: number; rules: string[] }>,
    ): Record<string, { violations: number; rules: string[] }> {
      return Object.fromEntries(
        Object.entries(table).map(([f, e]) => [
          f,
          { violations: e.violations, rules: [...e.rules].sort() },
        ]),
      );
    }

    const MISSING = 'audit-event-type-missing-from-inventory';
    const ASSEMBLED = 'audit-event-type-assembled-at-run-time';
    const ASSEMBLED_ROOT = 'audit-event-type-namespace-root-assembled-at-run-time';
    const UNDECLARED_WRITER = 'audit-write-outside-declared-writer';

    test('the real repository passes the audit-inventory gate', () => {
      const { code, output } = run('scripts/check-audit-inventory.ts');
      assert.equal(code, 0, `the real tree has an unaccounted audit event type:\n${output}`);
      // The scan's REACH is what makes the gate mean anything, so the run states it and
      // this asserts it: a checker that quietly stopped finding files would still pass.
      assert.match(
        output,
        /scanned \d\d+ production TypeScript file\(s\) and \d+ migration\(s\); \d\d+ distinct/,
        'the gate must report the breadth it actually scanned',
      );
      assert.match(output, /46 entries over 9 declared families/);
      // The event the finding named, with its disposition, pinned by name.
      assert.match(output, /identity\.support\.expired → INVENTORY support\/support\.expiry/);
      // …and the one declared non-enumerable writer, stated rather than implied away.
      assert.match(output, /service\. \(NOT statically enumerable — declared residue\)/);
    });

    test('EVERY way of writing an uninventoried audit event is REJECTED, each by its own rule', () => {
      const { code, output, actual } = auditVerdicts('architecture/fixtures/audit-inventory-gap');
      assert.notEqual(code, 0, `the gate accepted the gap fixtures:\n${output}`);
      // Deep equality in BOTH directions: a fixture that stopped being rejected fails,
      // and so does a fixture rejected for a reason it was not written to prove — which
      // is what a rule quietly widening past its statement looks like.
      assert.deepEqual(
        actual,
        expect({
          // the finding's own shape: a new event inside a DECLARED family. It is also an
          // audit write from a file nobody declared, so it raises both.
          'undeclared-support-event.ts': { violations: 2, rules: [MISSING, UNDECLARED_WRITER] },
          // the evasion a name scan cannot see: a name assembled at run time
          'assembled-event-type.ts': { violations: 2, rules: [ASSEMBLED, UNDECLARED_WRITER] },
          // the hole OUTSIDE the identity namespace: an audit write from a new file
          'undeclared-writer.ts': { violations: 1, rules: [UNDECLARED_WRITER] },
        }),
        `the gap fixture verdicts changed:\n${output}`,
      );
      // The rule name alone would be satisfied by the right rule raised for the wrong
      // reason, so the load-bearing detail is pinned too: the gate must NAME the value
      // it could not resolve.
      assert.match(
        output,
        /assembled-event-type[^\n]*assembled from `outcome`/,
        'an unreadable name must name what made it unreadable',
      );
    });

    /**
     * R4 correction F1a. Twelve spellings, one property: a name the shared resolver can
     * READ is compared to the inventory however it was assembled, and a name it cannot
     * read is REFUSED rather than passed over. No fragment in any of these files is a
     * complete event type, which is exactly why the pre-F1a gate saw nothing in most of
     * them. The precise count is withdrawn rather than restated — it was published
     * inconsistently and never re-measured.
     */
    test('EVERY assembly spelling the shared resolver reads is REJECTED, and none passes silently', () => {
      const { code, output, actual } = auditVerdicts(
        'architecture/fixtures/audit-inventory-assembly',
      );
      assert.notEqual(code, 0, `the gate accepted the assembly fixtures:\n${output}`);
      assert.deepEqual(
        actual,
        expect({
          // (a) and (b) are the finding's own two reproductions.
          'evasion-a-string-concat.ts': { violations: 1, rules: [MISSING] },
          'evasion-b-interpolated-head.ts': { violations: 1, rules: [MISSING] },
          'evasion-c-array-join.ts': { violations: 1, rules: [MISSING] },
          // two shapes each: the flat call and the chain; `[i]` and `.at(i)`.
          'evasion-d-concat-call.ts': { violations: 2, rules: [MISSING] },
          'evasion-e-accumulated.ts': { violations: 1, rules: [MISSING] },
          'evasion-f-indexed-fragments.ts': { violations: 2, rules: [MISSING] },
          'evasion-g-string-raw.ts': { violations: 1, rules: [MISSING] },
          // one expression, several possible names — every possibility is judged.
          'evasion-h-lookup-map.ts': { violations: 2, rules: [MISSING] },
          'evasion-i-alternative-fragment.ts': { violations: 4, rules: [MISSING] },
          'evasion-j-cross-file-fragment.ts': { violations: 2, rules: [MISSING] },
          // (k) five operations the resolver refuses to model: FAIL LOUD, not silence.
          'evasion-k-opaque-rewrites.ts': { violations: 5, rules: [ASSEMBLED] },
          // (l) the root assembled and the family spelled out — the mirror of
          // `assembled-event-type.ts`, and the rule that closes that half.
          'evasion-l-assembled-namespace-root.ts': { violations: 1, rules: [ASSEMBLED_ROOT] },
          // `cross-file-fragments.ts` holds FRAGMENTS and must raise nothing; its absence
          // from this table is asserted by the deep equality.
        }),
        `the assembly fixture verdicts changed:\n${output}`,
      );
      // The names must be RESOLVED, not merely noticed: a gate that reported these as
      // unreadable would satisfy the rule names above while saying nothing about what
      // the code does. So the assembled names themselves are pinned.
      for (const name of [
        'identity.support.quarantined', // concatenation
        'identity.support.reopened', // interpolated head
        'identity.support.archived', // Array.prototype.join
        'identity.support.sealed',
        'identity.support.chained', // String.prototype.concat, both spellings
        'identity.support.drained', // += accumulation
        'identity.support.folded',
        'identity.support.picked', // [i] and .at(i)
        'identity.support.stapled', // String.raw
        'identity.session.smuggled', // lookup map, the guilty possibility
        'identity.support.smothered', // conditional
        'identity.session.smoked', // ??
        'identity.support.imported',
        'identity.support.aliased', // cross-file, plain and aliased import
      ]) {
        assert.match(
          output,
          new RegExp(`'${name.replace(/\./g, '\\.')}' appears in production code`),
          `${name} must be RESOLVED and named, not merely reported as unreadable`,
        );
      }
      assert.match(
        output,
        /evasion-k[^\n]*assembled from `NEARLY\.replace\(/,
        'a rewrite of a readable name must be named as the thing that could not be resolved',
      );
      assert.match(
        output,
        /evasion-l[^\n]*a declared family follows `root`/,
        'an assembled namespace ROOT must be named by the family that identifies it',
      );
    });

    /**
     * The other half of F1b: what the gate does NOT enforce is stated as a narrower
     * claim, and the claim is TESTED. These files are wrong and the gate accepts them.
     * If a later revision closes one of these residues, this test goes red and the
     * documents have to change with it — which is the opposite of how the four rejected
     * revisions handled a limit.
     */
    test('the residue the gate cannot see is ACCEPTED, and named in the documents', () => {
      const { code, output } = runWith('scripts/check-audit-inventory.ts', [
        'architecture/fixtures/audit-inventory-residue',
      ]);
      assert.equal(
        code,
        0,
        `a residue fixture was rejected — the limitation has been closed, so the gate ` +
          `header and KNOWN-LIMITATIONS must stop naming it:\n${output}`,
      );
      const limits = readFileSync(join(ROOT, 'docs', 'identity', 'KNOWN-LIMITATIONS.md'), 'utf8');
      const gate = readFileSync(join(ROOT, 'scripts', 'check-audit-inventory.ts'), 'utf8');
      const inventory = readFileSync(
        join(ROOT, 'packages', 'identity-access', 'src', 'audit-inventory.ts'),
        'utf8',
      );
      // Every "here is what is NOT enforced" section must name this residue — the three
      // sections whose whole purpose is to be exhaustive, and which omitted it before.
      for (const [name, doc] of [
        ['KNOWN-LIMITATIONS', limits],
        ["the gate's own header", gate],
        ["the inventory's own header", inventory],
      ] as const) {
        assert.ok(
          doc.includes('audit-inventory-residue'),
          `${name} must point at the fixtures that DEMONSTRATE the residue`,
        );
        assert.match(
          doc,
          /root .*AND.* family are both assembled|root and family are both assembled|neither the root nor a declared family/i,
          `${name} must name the residue: a name with neither a readable root nor a readable family`,
        );
      }
    });

    test('a file naming only DECLARED event types is ACCEPTED — the gate is not simply always red', () => {
      const { code, output } = runWith('scripts/check-audit-inventory.ts', [
        'architecture/fixtures/audit-inventory-declared',
      ]);
      assert.equal(code, 0, `the gate rejected declared event types:\n${output}`);
    });

    /**
     * R4 correction F1a's structural half. The defect was not only that the audit gate
     * read strings badly — it was that a THIRD hand-written string analysis existed at
     * all, so it drifted from the one that already handled these spellings. This test is
     * what makes a FOURTH copy fail the build.
     */
    test('both gates import ONE static string resolver, and neither keeps a private copy', () => {
      const resolver = readFileSync(join(ROOT, 'scripts', 'static-string-resolver.ts'), 'utf8');
      // The resolver really is the implementation: these are its load-bearing parts.
      for (const owned of [
        'function literalTexts',
        'function arrayShapes',
        'function assembly',
        'function flatten',
        'function render',
        'function textValuesIn',
      ]) {
        assert.ok(resolver.includes(owned), `the shared resolver must own ${owned}`);
      }
      for (const gate of ['check-audit-inventory.ts', 'check-role-binding-effectiveness.ts']) {
        const source = readFileSync(join(ROOT, 'scripts', gate), 'utf8');
        assert.match(
          source,
          /createStaticStringResolver\(/,
          `${gate} must resolve strings through the shared resolver`,
        );
        assert.match(
          source,
          /from '\.\/static-string-resolver'/,
          `${gate} must import the shared resolver rather than reimplement it`,
        );
        // A second copy of any of the resolver's parts inside a gate is the defect.
        for (const owned of [
          'function literalTexts',
          'function arrayShapes',
          'function assembly(',
          'function flatten(',
          'function textValues',
        ]) {
          assert.ok(
            !source.includes(owned),
            `${gate} declares its own ${owned} — that is a second string analysis, and ` +
              'drifting duplicates are what this whole correction is about',
          );
        }
      }
    });

    test('the gate is part of npm run architecture:check', () => {
      // A guard nobody runs is not a guard. The wiring is read from the manifest rather
      // than asserted in a document.
      const scripts = (
        JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
          scripts: Record<string, string>;
        }
      ).scripts;
      assert.match(scripts['architecture:check'] ?? '', /check-audit-inventory\.ts/);
    });
  });

  describe('the resource registry has exactly one branch list (RT2-C2 §A)', () => {
    /**
     * Migration 062 split the registry by PRIVILEGE: `resource_org_leaf` keeps
     * the row-security bypass and is executable only by the evidence owner, and
     * `resource_org_leaf_visible` is the ordinary lookup the engine calls.
     *
     * Two functions is two places to register a resource type, and a type
     * present in one and missing from the other is the worst kind of drift: the
     * engine would authorize it one way while the evidence trigger validated it
     * another, and nothing would be red. This is the thing that stops that.
     */
    /**
     * THE LAST DECLARATION IS THE ONE IN FORCE. Each train that registers a
     * resource type re-declares both resolvers, so reading a migration by name
     * would pin this gate to whichever train happened to be current when it was
     * written — and it would keep passing against a copy nothing runs. The
     * migrations are applied in filename order, so the newest file that
     * declares a function holds its live body.
     */
    const migrationFiles = readdirSync(join(ROOT, 'migrations'))
      .filter((f) => f.endsWith('.sql'))
      .sort();

    function declaringMigration(functionName: string): string {
      const needle = `CREATE OR REPLACE FUNCTION ${functionName}(`;
      for (let i = migrationFiles.length - 1; i >= 0; i -= 1) {
        const text = readFileSync(join(ROOT, 'migrations', migrationFiles[i] as string), 'utf8');
        if (text.includes(needle)) return text;
      }
      assert.fail(`${functionName} is declared in no migration at all`);
    }

    function branchesOf(functionName: string): string[] {
      const migration = declaringMigration(functionName);
      const start = migration.indexOf(`CREATE OR REPLACE FUNCTION ${functionName}(`);
      const end = migration.indexOf('$$ LANGUAGE plpgsql STABLE;', start);
      assert.ok(end > start, `${functionName} has no recognisable end`);
      const body = migration.slice(start, end);
      return [...body.matchAll(/p_type = '([a-z_]+)'/g)].map((m) => m[1] as string).sort();
    }

    test('every resource type the privileged resolver knows, the ordinary one knows too', () => {
      const privileged = branchesOf('resource_org_leaf');
      const visible = branchesOf('resource_org_leaf_visible');
      assert.ok(privileged.length >= 14, `the registry looks truncated: ${privileged.join(',')}`);
      assert.deepEqual(
        visible,
        privileged,
        'the two resource registries disagree about which types exist',
      );
      // …and the two Release Train 2 types are genuinely among them, so the
      // comparison is not two identical empty lists agreeing about nothing.
      for (const type of ['stock_item', 'stock_listing']) {
        assert.ok(privileged.includes(type), `${type} is not registered at all`);
      }
    });

    test('the privileged resolver is granted away from PUBLIC, in the migration itself', () => {
      const migration = declaringMigration('resource_org_leaf');
      assert.match(
        migration,
        /REVOKE ALL ON FUNCTION resource_org_leaf\(uuid, text, uuid\) FROM PUBLIC;/,
        'a NULL proacl grants EXECUTE to PUBLIC — the revoke must be written down',
      );
      assert.match(
        migration,
        /GRANT EXECUTE ON FUNCTION resource_org_leaf\(uuid, text, uuid\) TO dealership_evidence_owner;/,
      );
      assert.ok(
        !/GRANT EXECUTE ON FUNCTION resource_org_leaf\(uuid, text, uuid\) TO dealership_runtime/.test(
          migration,
        ),
        'granting the bypass resolver back to the runtime would undo the whole correction',
      );
      // The ordinary lookup takes no tenant argument: the vector cannot be
      // supplied because the signature does not accept it.
      assert.match(
        migration,
        /CREATE OR REPLACE FUNCTION resource_org_leaf_visible\(p_type text, p_id uuid\)/,
      );
    });
  });
});
