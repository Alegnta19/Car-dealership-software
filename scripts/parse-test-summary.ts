/**
 * FBL-000-R1 (correction A): deterministic test-summary enforcement.
 *
 *   npx tsx scripts/parse-test-summary.ts <raw-test-log> <out-json>
 *
 * The original CI step grepped for the spec reporter's human glyph ("ℹ tests 115").
 * Node 20 on a non-TTY chose the TAP reporter, whose summary lines use "#", so the
 * grep found nothing, test-counts.txt was empty, and a fully passing suite exited the
 * job with failure. This parser depends on neither glyph, color, locale, nor reporter
 * choice: it accepts the summary key/value lines that both the TAP and spec reporters
 * emit ("# tests 115" / "ℹ tests 115"), takes the LAST occurrence of each key (the
 * run-level summary follows any per-file ones), and enforces the gate itself:
 * non-empty summary, internally consistent counts, failed=0, skipped=0, cancelled=0.
 */
import { readFileSync, writeFileSync } from 'fs';

type Key = 'tests' | 'suites' | 'pass' | 'fail' | 'cancelled' | 'skipped' | 'todo' | 'duration_ms';

function main(): void {
  const [logPath, outPath] = [process.argv[2], process.argv[3]];
  if (logPath === undefined || outPath === undefined) {
    console.error('Usage: parse-test-summary.ts <raw-test-log> <out-json>');
    process.exit(2);
  }

  const raw = readFileSync(logPath, 'utf8');
  const found: Partial<Record<Key, number>> = {};
  const line =
    /^[\s]*[#ℹ][\s]+(tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)[\s]+([0-9]+(?:\.[0-9]+)?)[\s]*$/;
  for (const l of raw.split(/\r?\n/)) {
    const m = line.exec(l);
    if (m && m[1] !== undefined && m[2] !== undefined) {
      found[m[1] as Key] = Number(m[2]); // last occurrence wins — the final summary
    }
  }

  const required: Key[] = ['tests', 'suites', 'pass', 'fail', 'skipped', 'duration_ms'];
  const missing = required.filter((k) => found[k] === undefined);
  if (missing.length > 0) {
    console.error(`Test summary is EMPTY or unparseable — missing: ${missing.join(', ')}.`);
    console.error('Refusing to treat an unverifiable run as green.');
    process.exit(1);
  }

  const summary = {
    tests: found.tests ?? 0,
    suites: found.suites ?? 0,
    passed: found.pass ?? 0,
    failed: found.fail ?? 0,
    cancelled: found.cancelled ?? 0,
    skipped: found.skipped ?? 0,
    todo: found.todo ?? 0,
    duration_ms: found.duration_ms ?? 0,
  };
  writeFileSync(outPath, JSON.stringify(summary, null, 2) + '\n');
  console.log(
    `tests=${summary.tests} suites=${summary.suites} passed=${summary.passed} ` +
      `failed=${summary.failed} cancelled=${summary.cancelled} skipped=${summary.skipped} ` +
      `duration_ms=${summary.duration_ms}`,
  );

  const accounted =
    summary.passed + summary.failed + summary.cancelled + summary.skipped + summary.todo;
  if (accounted !== summary.tests) {
    console.error(
      `Inconsistent summary: pass+fail+cancelled+skipped+todo=${accounted} != tests=${summary.tests}`,
    );
    process.exit(1);
  }
  if (summary.tests <= 0) {
    console.error('Zero tests ran — an empty run is not a green run.');
    process.exit(1);
  }
  if (summary.failed !== 0 || summary.skipped !== 0 || summary.cancelled !== 0) {
    console.error('Gate: failed=0, skipped=0 and cancelled=0 are required.');
    process.exit(1);
  }
  console.log('Test summary gate OK.');
}

main();
