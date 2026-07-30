import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

/**
 * The architecture reference is the document people are told to read before changing the
 * security model, so a claim in it that no longer matches the code is worse than no claim
 * at all. Three review rounds in a row turned up the same two kinds of drift — an error
 * code thrown but never listed, and a metric whose label set had grown — both of which a
 * reader can only catch by checking every line by hand.
 *
 * These are the parts that can be compared mechanically, so they are.
 */

const ROOT = join(__dirname, '..');
const DOC = readFileSync(join(ROOT, 'docs', 'PHASE-248-SERVICE-COCKPIT-V2.md'), 'utf8');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

const SOURCE = sourceFiles(join(ROOT, 'src')).map((f) => readFileSync(f, 'utf8')).join('\n');

/** The one appendix line that enumerates error codes. */
const codeAppendix = DOC.split('\n').find((l) => l.startsWith('**Error codes:**'));

describe('documentation matches the code it describes', () => {
  test('every error code the API can return is listed in the appendix', () => {
    assert.ok(codeAppendix, 'the appendix must carry an "**Error codes:**" line');

    const thrown = new Set(
      [...SOURCE.matchAll(/\bcode: '([a-z_]+)'/g)].map((m) => m[1]),
    );
    assert.ok(thrown.size > 40, 'sanity: the scan should find the whole code vocabulary');

    const documented = new Set(
      [...codeAppendix!.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]),
    );

    const missing = [...thrown].filter((c) => !documented.has(c)).sort();
    assert.deepEqual(
      missing,
      [],
      `error codes thrown by the code but absent from the §14 appendix: ${missing.join(', ')}`,
    );
  });

  test('the appendix does not promise error codes that no longer exist', () => {
    const thrown = new Set([...SOURCE.matchAll(/\bcode: '([a-z_]+)'/g)].map((m) => m[1]));
    // These four come from the error handler's defaults rather than an explicit `code:`,
    // so they are documented without appearing in the scan above.
    const fromDefaults = new Set(['forbidden', 'not_found', 'unauthorized', 'validation_error']);

    const documented = [...codeAppendix!.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]);
    const stale = documented.filter((c) => !thrown.has(c) && !fromDefaults.has(c)).sort();
    assert.deepEqual(stale, [], `documented error codes that nothing throws: ${stale.join(', ')}`);
  });

  test('the metrics table lists the labels each metric actually carries', () => {
    const declared = new Map<string, string[]>();
    for (const m of SOURCE.matchAll(/name: '(service_[a-z0-9_]+)'[^}]*?labelNames: \[([^\]]*)\]/g)) {
      declared.set(m[1], [...m[2].matchAll(/'([a-z_]+)'/g)].map((l) => l[1]).sort());
    }
    assert.equal(declared.size, 15, 'sanity: all fifteen metrics should be found');

    for (const [metric, labels] of declared) {
      const row = DOC.split('\n').find((l) => l.startsWith(`| \`${metric}\``));
      assert.ok(row, `${metric} must appear in the §9 metrics table`);

      const documented = row!.split('|')[3].split(',').map((l) => l.trim()).filter(Boolean).sort();
      assert.deepEqual(
        documented,
        labels,
        `${metric} is declared with labels [${labels.join(', ')}] but documented as [${documented.join(', ')}]`,
      );
    }
  });

  test('every migration on disk is listed in the appendix', () => {
    const onDisk = readdirSync(join(ROOT, 'migrations'))
      .filter((f) => f.endsWith('.sql'))
      .map((f) => f.replace(/\.sql$/, ''));
    assert.ok(onDisk.length >= 6, 'sanity: the migration directory should not be empty');

    const missing = onDisk.filter((m) => !DOC.includes(`\`${m}\``)).sort();
    assert.deepEqual(missing, [], `migrations absent from the §14 appendix: ${missing.join(', ')}`);
  });
});
