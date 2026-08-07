import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
    assert.match(output, /11 modules/);
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
});
