/**
 * FBL-000 quality ratchet.
 *
 *   npx tsx scripts/quality-ratchet.ts check [dimension]  — fail if debt GREW anywhere
 *   npx tsx scripts/quality-ratchet.ts update              — record current debt
 *
 * Three dimensions, each compared per file as well as in total (a per-file check stops
 * debt from being shuffled between files to hide growth):
 *   - tsc-strict: errors under tsconfig.strict.json (noUncheckedIndexedAccess,
 *     exactOptionalPropertyTypes, noImplicitOverride — the flags the codebase does not
 *     yet satisfy; noImplicitAny is already enforced by the MAIN tsconfig).
 *   - eslint: errors + warnings under eslint.config.mjs.
 *   - format: files prettier considers non-clean (FBL-000-R1 correction C). The
 *     application is not mass-formatted; each recorded file is one unit of debt, and
 *     `check format` (exposed as `npm run format:check`) blocks any growth.
 *
 * The rule of the ratchet: existing findings are recorded debt, paid down when the code
 * they sit in is touched for real reasons; NEW findings fail CI immediately. When debt
 * drops, `update` re-records the lower water mark so it cannot rise back.
 */
import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { join, relative } from 'path';

const ROOT = join(__dirname, '..');
const BASELINE_PATH = join(ROOT, 'quality-baselines.json');

interface Counts {
  total: number;
  byFile: Record<string, number>;
}

function runTscStrict(): Counts {
  let out = '';
  try {
    execFileSync('npx', ['tsc', '-p', 'tsconfig.strict.json', '--noEmit'], {
      cwd: ROOT,
      encoding: 'utf8',
      shell: process.platform === 'win32',
    });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
  const byFile: Record<string, number> = {};
  let total = 0;
  for (const line of out.split(/\r?\n/)) {
    const m = /^(.+?)\(\d+,\d+\): error TS\d+/.exec(line);
    if (!m || m[1] === undefined) continue;
    const file = m[1].replace(/\\/g, '/');
    byFile[file] = (byFile[file] ?? 0) + 1;
    total += 1;
  }
  return { total, byFile };
}

function runEslint(): Counts {
  let out: string;
  try {
    out = execFileSync('npx', ['eslint', '.', '--format', 'json'], {
      cwd: ROOT,
      encoding: 'utf8',
      shell: process.platform === 'win32',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    // eslint exits non-zero when it finds errors; the JSON is still on stdout.
    out = (err as { stdout?: string }).stdout ?? '';
  }
  const results = JSON.parse(out) as Array<{
    filePath: string;
    errorCount: number;
    warningCount: number;
  }>;
  const byFile: Record<string, number> = {};
  let total = 0;
  for (const r of results) {
    const n = r.errorCount + r.warningCount;
    if (n === 0) continue;
    const file = relative(ROOT, r.filePath).replace(/\\/g, '/');
    byFile[file] = (byFile[file] ?? 0) + n;
    total += n;
  }
  return { total, byFile };
}

function runPrettier(): Counts {
  let out: string;
  try {
    out = execFileSync('npx', ['prettier', '--list-different', '.'], {
      cwd: ROOT,
      encoding: 'utf8',
      shell: process.platform === 'win32',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    // prettier exits 1 when files differ; the file list is still on stdout.
    out = (err as { stdout?: string }).stdout ?? '';
  }
  const byFile: Record<string, number> = {};
  let total = 0;
  for (const line of out.split(/\r?\n/)) {
    const file = line.trim().replace(/\\/g, '/');
    if (file === '') continue;
    byFile[file] = 1;
    total += 1;
  }
  return { total, byFile };
}

function compare(name: string, current: Counts, baseline: Counts | undefined): string[] {
  const problems: string[] = [];
  if (!baseline) {
    problems.push(
      `${name}: no baseline recorded — run "quality-ratchet.ts update" once and commit quality-baselines.json`,
    );
    return problems;
  }
  if (current.total > baseline.total) {
    problems.push(`${name}: total debt grew ${baseline.total} -> ${current.total}`);
  }
  for (const [file, n] of Object.entries(current.byFile)) {
    const allowed = baseline.byFile[file] ?? 0;
    if (n > allowed) {
      problems.push(`${name}: ${file} grew ${allowed} -> ${n}`);
    }
  }
  return problems;
}

const RUNNERS: Record<string, () => Counts> = {
  'tsc-strict': runTscStrict,
  eslint: runEslint,
  format: runPrettier,
};

function main(): void {
  const mode = process.argv[2];
  if (mode !== 'check' && mode !== 'update') {
    console.error('Usage: quality-ratchet.ts <check|update> [tsc-strict|eslint|format]');
    process.exit(2);
  }
  const only = process.argv[3];
  if (only !== undefined && !(only in RUNNERS)) {
    console.error(
      `Unknown dimension "${only}" — expected one of: ${Object.keys(RUNNERS).join(', ')}`,
    );
    process.exit(2);
  }

  if (mode === 'update') {
    const current: Record<string, Counts> = {};
    for (const [name, run] of Object.entries(RUNNERS)) current[name] = run();
    writeFileSync(BASELINE_PATH, JSON.stringify(current, null, 2) + '\n');
    console.log(
      'Baseline recorded: ' +
        Object.entries(current)
          .map(([n, c]) => `${n}=${c.total}`)
          .join(', '),
    );
    return;
  }

  let baseline: Record<string, Counts>;
  try {
    baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  } catch {
    console.error(
      'quality-baselines.json is missing or unreadable — run "quality-ratchet.ts update"',
    );
    process.exit(1);
    return;
  }

  const dims = only !== undefined ? [only] : Object.keys(RUNNERS);
  const problems: string[] = [];
  let improved = false;
  for (const name of dims) {
    const runner = RUNNERS[name];
    if (runner === undefined) continue;
    const current = runner();
    problems.push(...compare(name, current, baseline[name]));
    console.log(`${name}: ${current.total} (baseline ${baseline[name]?.total ?? '—'})`);
    if (current.total < (baseline[name]?.total ?? 0)) improved = true;
  }

  if (problems.length > 0) {
    console.error('\nQuality ratchet FAILED — new debt introduced:');
    for (const p of problems) console.error('  ' + p);
    console.error('\nFix the new findings (do not raise the baseline to admit them).');
    process.exit(1);
  }

  if (improved) {
    console.log(
      '\nDebt went DOWN — run "quality-ratchet.ts update" and commit the lower baseline.',
    );
  }
  console.log('Quality ratchet OK.');
}

main();
