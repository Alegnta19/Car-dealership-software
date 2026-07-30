/**
 * FBL-010: deterministic dependency-rule gate.
 *
 *   npx tsx scripts/check-dependencies.ts <target> [target...]
 *
 * Wraps dependency-cruiser with `--output-type json` and decides the exit code from the
 * parsed violation summary itself. The CLI's own exit semantics proved
 * platform-dependent (a rule violation exited 1 on Windows and 0 on Linux under the
 * same version); a gate must not depend on that. Violations are printed rule-by-rule;
 * exit 1 when any error-severity violation exists.
 */
import { execFileSync } from 'child_process';

interface Violation {
  from: string;
  to: string;
  rule: { severity: string; name: string };
}
interface CruiseResult {
  summary: { error: number; warn: number; violations: Violation[] };
}

function main(): void {
  const targets = process.argv.slice(2);
  if (targets.length === 0) {
    console.error('Usage: check-dependencies.ts <target> [target...]');
    process.exit(2);
  }

  let raw: string;
  try {
    raw = execFileSync(
      'npx',
      ['depcruise', ...targets, '--config', '.dependency-cruiser.cjs', '--output-type', 'json'],
      { encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 256 * 1024 * 1024 },
    );
  } catch (err) {
    // Some versions exit non-zero when violations exist; the JSON is still on stdout.
    const e = err as { stdout?: string; stderr?: string };
    raw = e.stdout ?? '';
    if (raw.trim() === '') {
      console.error('dependency-cruiser produced no output:');
      console.error(e.stderr ?? '(no stderr)');
      process.exit(1);
    }
  }

  let result: CruiseResult;
  try {
    result = JSON.parse(raw) as CruiseResult;
  } catch {
    console.error('dependency-cruiser output was not parseable JSON');
    process.exit(1);
    return;
  }

  const errors = result.summary.violations.filter((v) => v.rule.severity === 'error');
  for (const v of errors) {
    console.error(`  error ${v.rule.name}: ${v.from} -> ${v.to}`);
  }
  if (errors.length > 0) {
    console.error(`dependency check FAILED: ${errors.length} error-severity violation(s)`);
    process.exit(1);
  }
  console.log(`dependency check OK (${targets.join(' ')}): no error-severity violations`);
}

main();
