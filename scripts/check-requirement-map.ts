/**
 * FBL-020-R4 §7 — THE REQUIREMENT MAP CANNOT NAME A TEST THAT DOES NOT EXIST.
 *
 *   npx tsx scripts/check-requirement-map.ts [--out <file>]
 *
 * A requirement-to-test table written by hand is a claim, and a claim about tests
 * decays the moment one is renamed. This checker turns the table into something
 * mechanically true, or fails:
 *
 *   * every named test file exists;
 *   * every named test NAME appears verbatim in it, as a `test('…')` declaration;
 *   * every named code path, fixture and script exists on disk;
 *   * every named CI step exists as a step `name:` in .github/workflows/ci.yml;
 *   * every named artifact is listed in a workflow evidence-completeness check;
 *   * and — the direction that catches the omission rather than the typo — every
 *     test file introduced by R4 is claimed by at least one requirement, so a
 *     battery cannot exist outside the map.
 *
 * `tests/ci-gates.test.ts` runs this inside the suite, and the CI job runs it as its
 * own step so the artifact records the result independently of the suite.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const MAP_PATH = join(ROOT, 'docs', 'FBL-020-R4-REQUIREMENT-MAP.json');
const WORKFLOW_PATH = join(ROOT, '.github', 'workflows', 'ci.yml');

/**
 * The test files R4 introduced. Declared here rather than inferred from git so the
 * check works in a clean archive with no history, and so ADDING a battery without
 * mapping it is a failure rather than a silent omission.
 */
const R4_TEST_FILES = [
  'tests/audit-inventory-rules.test.ts',
  'tests/ci-gates.test.ts',
  'tests/delivery-documentation.test.ts',
  'tests/identity-evidence.test.ts',
  'tests/identity-lifecycle-audit.test.ts',
  'tests/login-admission.test.ts',
  'tests/migration-ledger.test.ts',
  'tests/owned-mutations.test.ts',
  'tests/support-context.test.ts',
  'tests/support-expiry.test.ts',
] as const;

export interface RequirementMap {
  order: string;
  governing_document: Record<string, unknown>;
  requirements: Array<{
    id: string;
    requirement: string;
    verdict?: string;
    code?: string[];
    ci_steps?: string[];
    artifacts?: string[];
    tests: Array<{ file: string; name: string }>;
  }>;
}

export function loadRequirementMap(): RequirementMap {
  return JSON.parse(readFileSync(MAP_PATH, 'utf8')) as RequirementMap;
}

/** Every `test('…')` name declared in a test file. */
export function declaredTestNames(file: string): Set<string> {
  const source = readFileSync(join(ROOT, file), 'utf8');
  const names = new Set<string>();
  for (const m of source.matchAll(/\btest\(\s*'((?:[^'\\]|\\.)*)'/g)) {
    names.add((m[1] as string).replace(/\\'/g, "'").replace(/\\\\/g, '\\'));
  }
  return names;
}

/** Every step `name:` in the CI workflow. */
export function workflowStepNames(): Set<string> {
  const yaml = readFileSync(WORKFLOW_PATH, 'utf8');
  const names = new Set<string>();
  for (const m of yaml.matchAll(/^\s+-\s+name:\s*(?:'([^']*)'|"([^"]*)"|(.*))$/gm)) {
    const raw = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (raw !== '') names.add(raw);
  }
  return names;
}

export function checkRequirementMap(): string[] {
  const problems: string[] = [];
  const map = loadRequirementMap();
  if (map.order !== 'FBL-020-R4') problems.push(`the map declares order ${map.order}`);

  const stepNames = workflowStepNames();
  const workflow = readFileSync(WORKFLOW_PATH, 'utf8');
  const namesByFile = new Map<string, Set<string>>();
  const claimedFiles = new Set<string>();
  let mappedTests = 0;

  for (const req of map.requirements) {
    if (req.tests.length === 0 && req.verdict === undefined && (req.ci_steps ?? []).length === 0) {
      problems.push(`${req.id}: names no test, no CI step and no verdict — it proves nothing`);
    }
    for (const path of req.code ?? []) {
      if (!existsSync(join(ROOT, path)))
        problems.push(`${req.id}: code path ${path} does not exist`);
    }
    for (const step of req.ci_steps ?? []) {
      if (!stepNames.has(step)) problems.push(`${req.id}: CI step "${step}" is not in ci.yml`);
    }
    for (const artifact of req.artifacts ?? []) {
      if (!workflow.includes(artifact))
        problems.push(`${req.id}: artifact ${artifact} is never produced by ci.yml`);
    }
    for (const t of req.tests) {
      claimedFiles.add(t.file);
      if (!existsSync(join(ROOT, t.file))) {
        problems.push(`${req.id}: test file ${t.file} does not exist`);
        continue;
      }
      let names = namesByFile.get(t.file);
      if (names === undefined) {
        names = declaredTestNames(t.file);
        namesByFile.set(t.file, names);
      }
      if (!names.has(t.name)) {
        problems.push(`${req.id}: ${t.file} declares no test named ${JSON.stringify(t.name)}`);
      }
      mappedTests += 1;
    }
  }

  for (const file of R4_TEST_FILES) {
    if (!existsSync(join(ROOT, file))) {
      problems.push(`R4 test file ${file} is missing from the tree`);
    } else if (!claimedFiles.has(file)) {
      problems.push(`R4 test file ${file} is not claimed by any requirement in the map`);
    }
  }

  // Every test file on disk must be a real file the suite runs — a guard against a
  // map that cites a helper module as though it were a battery.
  const onDisk = new Set(readdirSync(join(ROOT, 'tests')).filter((f) => f.endsWith('.test.ts')));
  for (const file of claimedFiles) {
    if (!onDisk.has(file.replace(/^tests\//, '')))
      problems.push(`${file} is cited by the map but is not a tests/*.test.ts battery`);
  }

  console.log(
    `requirements=${map.requirements.length} mapped_tests=${mappedTests} ` +
      `test_files_claimed=${claimedFiles.size} r4_test_files=${R4_TEST_FILES.length}`,
  );
  return problems;
}

function main(): void {
  let out: string | undefined;
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') out = argv[(i += 1)];
    else {
      console.error(`Unrecognized argument: ${argv[i]}`);
      process.exit(2);
    }
  }

  const problems = checkRequirementMap();
  const report =
    problems.length === 0
      ? 'requirement map OK: every requirement resolves to tests, code, steps and artifacts that exist\n'
      : problems.map((p) => `FAIL: ${p}`).join('\n') + '\n';
  process.stdout.write(report);
  if (out !== undefined) writeFileSync(out, report);
  if (problems.length > 0) process.exit(1);
}

if (require.main === module) main();
