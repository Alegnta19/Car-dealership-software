/**
 * FBL-000 quality ratchet.
 *
 *   npx tsx scripts/quality-ratchet.ts check    — fail if debt GREW anywhere
 *   npx tsx scripts/quality-ratchet.ts update   — record current debt as the baseline
 *
 * Two dimensions, both compared per file as well as in total (a per-file check stops
 * debt from being shuffled between files to hide growth):
 *   - tsc-strict: errors under tsconfig.strict.json (noUncheckedIndexedAccess,
 *     exactOptionalPropertyTypes, noImplicitOverride — the flags the codebase does not
 *     yet satisfy; noImplicitAny is already enforced by the MAIN tsconfig).
 *   - eslint: errors + warnings under eslint.config.mjs.
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
      cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32',
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
      cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    // eslint exits non-zero when it finds errors; the JSON is still on stdout.
    out = (err as { stdout?: string }).stdout ?? '';
  }
  const results = JSON.parse(out) as Array<{ filePath: string; errorCount: number; warningCount: number }>;
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

function compare(name: string, current: Counts, baseline: Counts | undefined): string[] {
  const problems: string[] = [];
  if (!baseline) {
    problems.push(`${name}: no baseline recorded — run "quality-ratchet.ts update" once and commit quality-baselines.json`);
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

function main(): void {
  const mode = process.argv[2];
  if (mode !== 'check' && mode !== 'update') {
    console.error('Usage: quality-ratchet.ts <check|update>');
    process.exit(2);
  }

  const current = { 'tsc-strict': runTscStrict(), eslint: runEslint() };

  if (mode === 'update') {
    writeFileSync(BASELINE_PATH, JSON.stringify(current, null, 2) + '\n');
    console.log(`Baseline recorded: tsc-strict=${current['tsc-strict'].total}, eslint=${current.eslint.total}`);
    return;
  }

  let baseline: Record<string, Counts>;
  try {
    baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  } catch {
    console.error('quality-baselines.json is missing or unreadable — run "quality-ratchet.ts update"');
    process.exit(1);
    return;
  }

  const problems = [
    ...compare('tsc-strict', current['tsc-strict'], baseline['tsc-strict']),
    ...compare('eslint', current.eslint, baseline.eslint),
  ];

  console.log(`tsc-strict: ${current['tsc-strict'].total} (baseline ${baseline['tsc-strict']?.total ?? '—'})`);
  console.log(`eslint:     ${current.eslint.total} (baseline ${baseline.eslint?.total ?? '—'})`);

  if (problems.length > 0) {
    console.error('\nQuality ratchet FAILED — new debt introduced:');
    for (const p of problems) console.error('  ' + p);
    console.error('\nFix the new findings (do not raise the baseline to admit them).');
    process.exit(1);
  }

  const improved =
    current['tsc-strict'].total < (baseline['tsc-strict']?.total ?? 0) ||
    current.eslint.total < (baseline.eslint?.total ?? 0);
  if (improved) {
    console.log('\nDebt went DOWN — run "quality-ratchet.ts update" and commit the lower baseline.');
  }
  console.log('Quality ratchet OK.');
}

main();
