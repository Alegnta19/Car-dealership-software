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
  try {
    const output = execFileSync('npx', ['tsx', script], {
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

  test('the ownership manifest matches the real workspace', () => {
    const { code, output } = run('scripts/check-architecture-manifest.ts');
    assert.equal(code, 0, output);
    assert.match(output, /9 modules/);
  });

  test('process.env stays confined to the approved configuration/composition files', () => {
    const { code, output } = run('scripts/check-env-access.ts');
    assert.equal(code, 0, output);
  });
});
