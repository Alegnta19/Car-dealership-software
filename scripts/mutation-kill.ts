/**
 * FBL-020-R4 §7 — TARGETED MUTATION-KILL CHECKS, IN AN ISOLATED COPY OF THE TREE.
 *
 *   TEST_DATABASE_URL=… npx tsx scripts/mutation-kill.ts \
 *     --out artifacts/mutation-kill.json --log artifacts/mutation-kill.txt
 *
 * ── WHY ─────────────────────────────────────────────────────────────────────
 *
 * R3's review found a test that still PASSED with a security predicate deleted. A
 * green suite is therefore not, on its own, evidence that the suite is holding
 * anything: a test can assert around a control instead of asserting the control.
 *
 * This runner removes the doubt mechanically. For each named control it:
 *   1. copies the working tree into a temporary directory (node_modules is shared
 *      read-only via a link; `@dealer/*` resolves through tsconfig `paths`, so it
 *      resolves INTO the copy — asserted, not assumed);
 *   2. runs the declared test file UNMUTATED and requires it to PASS, so a battery
 *      that is already broken cannot "kill" anything;
 *   3. applies ONE exact source edit that removes or weakens the control;
 *   4. re-runs the same test file and requires it to FAIL, with the DECLARED test
 *      name among the failures;
 *   5. restores the file and moves on.
 *
 * A mutation that SURVIVES — the suite still green with the control gone — is a
 * FAILED check and this runner exits non-zero. The working tree is never modified:
 * every edit happens in the copy, and the original file's digest is re-checked after
 * each mutation.
 *
 * ── WHAT IS AND IS NOT COVERED HERE ────────────────────────────────────────
 *
 * These are controls in TypeScript sources — the application packages and the
 * migration RUNNER. Reconciliation inside a migration BODY is proved load-bearing by
 * `scripts/upgrade-negative-controls.ts` instead, because a mutated migration cannot
 * change a database that has already been migrated — removing a statement from 057 and
 * re-running the suite would prove nothing. The two runners are complementary and both
 * gate CI.
 */
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

export interface Mutation {
  id: string;
  /** The control the mutation removes, in one sentence. */
  control: string;
  /** Repository-relative path of the file to edit. */
  file: string;
  /** Exact text to replace; must occur EXACTLY ONCE in the file. */
  from: string;
  /** The weakened replacement. */
  to: string;
  /** The battery that must fail. */
  testFile: string;
  /** The test name that must be among the failures. */
  testName: string;
}

export const MUTATIONS: Mutation[] = [
  {
    id: 'role_binding_effectiveness_ignored',
    control:
      'a role binding authorizes only inside its effective window; status alone is not authority',
    file: 'packages/identity-access/src/policy.ts',
    from:
      "export const EFFECTIVE_ROLE_BINDING_SQL = `rb.status = 'active'\n" +
      '        AND rb.effective_from <= NOW()\n' +
      '        AND (rb.effective_to IS NULL OR rb.effective_to > NOW())`;',
    to: "export const EFFECTIVE_ROLE_BINDING_SQL = `rb.status = 'active'`;",
    testFile: 'tests/policy.test.ts',
    testName:
      'a LIVE support session stops authorizing when the actor binding ages out of its window',
  },
  {
    id: 'mfa_certification_never_expires',
    control: 'an MFA-policy certification counts only while it is inside its validity deadline',
    file: 'packages/identity-access/src/contracts.ts',
    from:
      '   AND c.mfa_policy_certification_expires_at IS NOT NULL\n' +
      '   AND c.mfa_policy_certification_expires_at > NOW()\n' +
      '  )`;',
    to: '  )`;',
    testFile: 'tests/identity-lifecycle-audit.test.ts',
    testName: 'MFA certification fails CLOSED when false, missing, expired or revoked',
  },
  {
    id: 'pending_link_admitted',
    control: 'only an ACTIVATED user link may be admitted at login',
    file: 'packages/identity-access/src/login-admission.ts',
    from: "        AND ul.status = 'activated'",
    to: "        AND ul.status IN ('activated', 'pending')",
    testFile: 'tests/login-admission.test.ts',
    // NOT the pre-existing 'refuses a PENDING link' test: that one's pending link is
    // created UNBOUND by the observation, so the binding clause refuses it whatever its
    // status, and this mutation SURVIVED against it. The test named here was added in
    // R4 §7 for exactly that reason — a bound pending link, the shape migration 057 §1
    // produces — and it is the one that dies.
    testName: 'a BOUND but PENDING link is refused — binding is provenance, not authority',
  },
  {
    id: 'client_request_id_adopted',
    control: 'the request id in policy evidence is server-generated; a caller can never name it',
    file: 'apps/api/src/middleware/request-context.ts',
    from: '  const requestId = generateRequestId();',
    to:
      "  const claimed = req.headers['x-request-id'];\n" +
      '  const requestId =\n' +
      "    typeof claimed === 'string' && /^[A-Za-z0-9._-]{8,128}$/.test(claimed)\n" +
      '      ? claimed\n' +
      '      : generateRequestId();',
    testFile: 'tests/platform.test.ts',
    testName: 'a caller-supplied x-request-id NEVER becomes the request id, well-formed or not',
  },
  {
    id: 'support_header_omits_expiry',
    control: 'the support-access indicator always declares the window it is bounded by',
    file: 'packages/identity-access/src/support-access.ts',
    from:
      '        `active; support_session=${g.supportSessionId}; support_request=${g.supportRequestId}; ` +\n' +
      '        `expires_at=${g.expiresAt.toISOString()}`,',
    to: '        `active; support_session=${g.supportSessionId}; support_request=${g.supportRequestId}`,',
    testFile: 'tests/support-context.test.ts',
    testName: 'the header format has ONE writer, and it cannot omit the expiry',
  },
  {
    id: 'assurance_floor_removed',
    control: 'a fresh_only grant can never satisfy an operation that requires fresh_and_mfa_policy',
    file: 'packages/identity-access/src/reauthentication.ts',
    from:
      '        AND (\n' +
      "          $7 = 'fresh_only'\n" +
      "          OR (assurance_level = 'fresh_and_mfa_policy' AND mfa_policy_certified_at_issue = TRUE)\n" +
      '        )',
    to: '        AND $7 IS NOT NULL',
    testFile: 'tests/identity-boundary.test.ts',
    testName: 'a fresh_only grant can NEVER satisfy a fresh_and_mfa_policy operation',
  },
  {
    /*
     * The §0 blocker. The pre-R4 runner matched on FILENAME ALONE, so a migration whose
     * body changed after it had been applied was skipped forever and the database and
     * the repository could disagree about the schema in force with nothing able to tell
     * them apart. This mutation restores exactly that defect — the comparison is still
     * made, its result is simply not acted on — and requires the battery to notice.
     */
    id: 'ledger_drift_ignored',
    control:
      'a previously applied migration whose body has changed REFUSES the run; the ledger ' +
      'records what was applied, not merely that something was',
    file: 'scripts/migrate.ts',
    from:
      '    if (computed !== row.checksum_sha256) {\n' +
      '      drifted.push({ filename: row.filename, recorded: row.checksum_sha256, computed });\n' +
      '    }',
    to:
      '    if (computed !== row.checksum_sha256) {\n' +
      '      void computed; // mutation: the drift is seen and deliberately not acted on\n' +
      '    }',
    testFile: 'tests/migration-ledger.test.ts',
    testName:
      'a CHANGED body of an applied migration REFUSES the run, names the file and both digests',
  },
];

const ROOT = join(__dirname, '..');
const IS_WINDOWS = process.platform === 'win32';

/**
 * The workspace trees the mutations edit. Their presence INSIDE the copy is what makes
 * the copy isolated: `@dealer/*` resolves through the tsconfig `paths` map, whose
 * `baseUrl` is the config's own directory, so inside the copy those specifiers resolve
 * to the copy's own sources and never reach back into the working tree.
 */
const WORKSPACE_DIRS = ['apps', 'packages', 'scripts'];

function digest(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Every text in every mutation must anchor uniquely — checked before anything runs. */
export function anchorProblems(): string[] {
  const problems: string[] = [];
  for (const m of MUTATIONS) {
    const path = join(ROOT, m.file);
    if (!existsSync(path)) {
      problems.push(`${m.id}: ${m.file} does not exist`);
      continue;
    }
    const source = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
    const occurrences = source.split(m.from).length - 1;
    if (occurrences !== 1)
      problems.push(`${m.id}: the anchor occurs ${occurrences} time(s) in ${m.file}, expected 1`);
    if (m.from === m.to) problems.push(`${m.id}: the mutation changes nothing`);
    const testPath = join(ROOT, m.testFile);
    if (!existsSync(testPath)) {
      problems.push(`${m.id}: ${m.testFile} does not exist`);
    } else if (!readFileSync(testPath, 'utf8').includes(m.testName)) {
      problems.push(`${m.id}: ${m.testFile} declares no test named ${JSON.stringify(m.testName)}`);
    }
  }
  return problems;
}

/**
 * Copies the tree, excluding what must not be duplicated, and links node_modules.
 *
 * `@dealer/*` resolves through the tsconfig `paths` map, whose `baseUrl` is the
 * config's own directory — so inside the copy it resolves to the COPY's packages.
 * That is verified below rather than trusted: a copy whose imports reached back into
 * the original tree would report every mutation as surviving.
 */
function isolatedCopy(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fbl020-mut-'));
  const copy = join(dir, 'tree');
  cpSync(ROOT, copy, {
    recursive: true,
    filter: (src) => {
      const rel = src.slice(ROOT.length).replace(/\\/g, '/').replace(/^\//, '');
      if (rel === '') return true;
      const first = rel.split('/')[0] as string;
      if (first === 'node_modules' || first === '.git') return false;
      if (rel.endsWith('.tsbuildinfo')) return false;
      return !/(^|\/)dist(\/|$)/.test(rel);
    },
  });
  // Shared, read-only: 85 MB of third-party packages are identical in both trees and
  // nothing here mutates them. A junction is used on Windows so no elevated privilege
  // is required.
  symlinkSync(
    join(ROOT, 'node_modules'),
    join(copy, 'node_modules'),
    IS_WINDOWS ? 'junction' : 'dir',
  );
  return copy;
}

function assertIsolation(copy: string): void {
  for (const tree of WORKSPACE_DIRS) {
    const probe = join(copy, tree);
    if (!existsSync(probe)) throw new Error(`isolated copy is missing ${tree}/`);
    if (!realpathSync(probe).startsWith(realpathSync(copy)))
      throw new Error(`isolated copy's ${tree}/ resolves outside the copy`);
  }
  /*
   * The decisive one, and it is derived from MUTATIONS rather than hard-coded: EVERY
   * file a mutation edits must be present in the copy and byte-identical to the
   * original. A hard-coded marker proves only that one module was copied, so a mutation
   * added later against a tree the filter happened to exclude — `scripts/`, say — would
   * be written into a file no battery reads, and the check would report the control as
   * surviving for a reason that has nothing to do with the control.
   */
  for (const relative of new Set(MUTATIONS.map((m) => m.file))) {
    const marker = join(copy, relative);
    if (!existsSync(marker)) throw new Error(`isolated copy is missing ${relative}`);
    if (digest(marker) !== digest(join(ROOT, relative)))
      throw new Error(`the copy of ${relative} does not match the original`);
  }
}

interface TestRun {
  status: number;
  failed: string[];
}

/** Runs one battery inside the copy and returns the names of the tests that failed. */
function runBattery(copy: string, testFile: string): TestRun {
  const result = spawnSync(
    'npx',
    ['tsx', '--test', '--test-concurrency=1', '--test-reporter=tap', testFile],
    {
      cwd: copy,
      encoding: 'utf8',
      env: process.env,
      shell: IS_WINDOWS,
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const failed: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const m = /^\s*not ok \d+ - (.*)$/.exec(line);
    if (m) failed.push((m[1] as string).trim());
  }
  return { status: result.status ?? 1, failed };
}

function parseArgs(): { out: string | undefined; log: string | undefined } {
  const argv = process.argv.slice(2);
  let out: string | undefined;
  let log: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') out = argv[(i += 1)];
    else if (argv[i] === '--log') log = argv[(i += 1)];
    else {
      console.error(`Unrecognized argument: ${argv[i]}`);
      process.exit(2);
    }
  }
  return { out, log };
}

function main(): void {
  const { out, log } = parseArgs();

  const problems = anchorProblems();
  if (problems.length > 0) {
    for (const p of problems) console.error(`FAIL: ${p}`);
    console.error('Refusing to run: a mutation whose anchor is wrong proves nothing.');
    process.exit(1);
  }

  const copy = isolatedCopy();
  const lines: string[] = [`isolated_copy=${copy}`, ''];
  const results: Array<Record<string, unknown>> = [];
  const baseline = new Map<string, TestRun>();
  let survivors = 0;

  try {
    assertIsolation(copy);

    for (const m of MUTATIONS) {
      const target = join(copy, m.file);
      const original = readFileSync(target, 'utf8');
      const originalDigest = digest(join(ROOT, m.file));

      // 2. The battery must be GREEN before the mutation, or its later failure says
      //    nothing about the control.
      let base = baseline.get(m.testFile);
      if (base === undefined) {
        base = runBattery(copy, m.testFile);
        baseline.set(m.testFile, base);
      }
      const baselineGreen = base.status === 0 && base.failed.length === 0;

      // 3. One exact edit. `split/join` rather than a regex: the anchor is literal text
      //    and a regex would give a `$` in the replacement a second meaning.
      const mutated = original.replace(/\r\n/g, '\n').split(m.from).join(m.to);
      writeFileSync(target, mutated, 'utf8');

      // 4. The same battery must now FAIL, and the declared test must be among the dead.
      const after = runBattery(copy, m.testFile);
      const killed = after.status !== 0 && after.failed.some((f) => f.includes(m.testName));

      writeFileSync(target, original, 'utf8');

      // The working tree is untouched — verified, not asserted in prose.
      const treeIntact = digest(join(ROOT, m.file)) === originalDigest;

      const ok = baselineGreen && killed && treeIntact;
      if (!ok) survivors += 1;

      const verdict = ok
        ? 'MUTATION KILLED'
        : !baselineGreen
          ? `INCONCLUSIVE — ${m.testFile} was not green before the mutation`
          : !treeIntact
            ? 'ABORTED — the working tree changed, which must never happen'
            : 'MUTATION SURVIVED — the control was removed and the suite stayed green';

      lines.push(
        `mutation=${m.id}`,
        `  control=${m.control}`,
        `  file=${m.file}`,
        `  battery=${m.testFile}`,
        `  expected_dead_test=${JSON.stringify(m.testName)}`,
        `  baseline_green=${baselineGreen}`,
        `  after_status=${after.status} failed_tests=${after.failed.length}`,
        `  dead_tests=${JSON.stringify(after.failed.slice(0, 6))}`,
        `  working_tree_intact=${treeIntact}`,
        `  verdict=${verdict}`,
        '',
      );
      results.push({
        id: m.id,
        control: m.control,
        file: m.file,
        battery: m.testFile,
        expected_dead_test: m.testName,
        baseline_green: baselineGreen,
        after_status: after.status,
        dead_tests: after.failed,
        working_tree_intact: treeIntact,
        killed: ok,
      });
    }
  } finally {
    rmSync(join(copy, '..'), { recursive: true, force: true });
  }

  const summary = {
    mutations_total: MUTATIONS.length,
    mutations_killed: MUTATIONS.length - survivors,
    mutations_survived: survivors,
    mutations: results,
  };
  if (out !== undefined) writeFileSync(out, JSON.stringify(summary, null, 2) + '\n');

  lines.push(
    `mutations_total=${MUTATIONS.length} killed=${MUTATIONS.length - survivors} survived=${survivors}`,
  );
  const text = lines.join('\n') + '\n';
  process.stdout.write(text);
  if (log !== undefined) writeFileSync(log, text);

  if (survivors > 0) {
    console.error(
      `${survivors} mutation(s) SURVIVED: a control was removed and the suite did not notice.`,
    );
    process.exitCode = 1;
  }
}

if (require.main === module) main();
