/**
 * FBL-000-R1 (correction D): migration manifest — filenames + SHA-256 checksums.
 *
 *   npx tsx scripts/migration-manifest.ts <dir> [--out <file>] [--expect-chain <id>]
 *
 * Used twice in CI: over `migrations/` (the current chain, recorded for the evidence pack)
 * and over `tests/fixtures/schema-f76a27a/` (the retained fixture).
 *
 * ── FBL-020-R5 §0.5: THE RETAINED FIXTURE IS COMPARED, NOT MERELY RECORDED ──
 *
 * Until this correction the second use wrote down whatever it found and the job carried on.
 * The step was NAMED "must stay byte-identical to f76a27a" and it could not detect that it
 * had not: a changed fixture produced a manifest of the changed fixture, `test -s` found the
 * file non-empty, and the drill then reproduced a "retained schema" that was not the
 * retained schema. An output-only manifest is a record, not a control.
 *
 * `--expect-chain` names a chain in `architecture/migration-fixture-chains.json`, whose
 * digests are FIXED COMMITTED VALUES. Every declared file must be present with exactly its
 * declared digest, and no undeclared file may be present. Anything else exits non-zero.
 *
 * ── TWO DIGESTS PER FILE, AND WHY THE PINNED ONE IS CANONICAL-LF ────────────
 *
 * `sha256` is over the bytes as they sit on disk. It is informational, and it is
 * PLATFORM-DEPENDENT: this repository is developed on Windows with `core.autocrlf=true`, so
 * every .sql file has CRLF endings locally and LF in CI, and the two hashes differ for
 * every file ever written. A committed expectation pinned to that value could only ever
 * pass on one platform.
 *
 * `sha256_canonical_lf` is over the text normalized to LF — the same value
 * `scripts/migrate.ts` records in the ledger and the same value the chain allowlist pins.
 * That is the digest the comparison uses, so the check means the same thing on a developer's
 * machine and on a runner.
 */
import { createHash } from 'crypto';
import { readFileSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { canonicalDigest, loadFixtureChains } from './migration-fixture-chains';

export interface ManifestEntry {
  file: string;
  sha256: string;
  sha256_canonical_lf: string;
}

export function manifest(dir: string): ManifestEntry[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((file) => {
      const raw = readFileSync(join(dir, file));
      return {
        file,
        sha256: createHash('sha256').update(raw).digest('hex'),
        sha256_canonical_lf: canonicalDigest(raw),
      };
    });
}

/**
 * Compares a manifest against a chain's FIXED EXPECTED digests. Returns every problem, so
 * a reader sees the whole difference rather than the first line of it.
 */
export function compareToChain(
  entries: ManifestEntry[],
  chainId: string,
  chains = loadFixtureChains(),
): string[] {
  const chain = chains[chainId];
  if (chain === undefined)
    return [
      `--expect-chain ${chainId} names no declared chain. Declared: ` +
        `${Object.keys(chains).sort().join(', ')}`,
    ];
  /*
   * FBL-020-R6 §1.4: a chain declares, per filename, the complete list of bodies admitted
   * under it. A retained fixture is compared against a chain that admits exactly ONE body
   * per file — against a file with several admitted variants this would report a pass that
   * means nothing, because "it is one of the several" is not "it is the historical schema".
   * So the multi-variant case is refused here rather than approximated.
   */
  const multi = Object.entries(chain.files)
    .filter(([, entry]) => entry.variants.length !== 1)
    .map(([file, entry]) => `${file} (${entry.variants.length})`);
  if (multi.length > 0)
    return [
      `--expect-chain ${chainId} admits more than one body for: ${multi.join(', ')}. A ` +
        'retained fixture is compared against a chain that pins exactly one body per file; ' +
        'a chain with alternatives cannot answer "is this the historical schema".',
    ];

  const problems: string[] = [];
  const found = new Map(entries.map((e) => [e.file, e.sha256_canonical_lf]));
  for (const [file, entry] of Object.entries(chain.files)) {
    const expected = entry.variants[0]?.sha256;
    const actual = found.get(file);
    if (actual === undefined) problems.push(`${file}: declared by the chain but NOT PRESENT`);
    else if (actual !== expected)
      problems.push(
        `${file}: expected canonical-LF sha256 ${String(expected)}, found ${actual} — the ` +
          'retained fixture has CHANGED. The pinned value is not a baseline to refresh; the ' +
          'drill reproduces a historical schema and a different file is a different schema.',
      );
  }
  for (const e of entries)
    if (chain.files[e.file] === undefined)
      problems.push(`${e.file}: present but NOT DECLARED by chain ${chainId}`);
  return problems;
}

function main(): void {
  const dir = process.argv[2];
  if (dir === undefined || dir.startsWith('--')) {
    console.error('Usage: migration-manifest.ts <dir> [--out <file>] [--expect-chain <id>]');
    process.exit(2);
  }
  const outIdx = process.argv.indexOf('--out');
  const outPath = outIdx >= 0 ? process.argv[outIdx + 1] : undefined;
  const expectIdx = process.argv.indexOf('--expect-chain');
  const expectChain = expectIdx >= 0 ? process.argv[expectIdx + 1] : undefined;

  const entries = manifest(dir);
  if (entries.length === 0) {
    console.error(`No .sql files found in ${dir}`);
    process.exit(1);
  }

  for (const e of entries) console.log(`${e.sha256_canonical_lf}  ${e.file}`);

  const problems = expectChain === undefined ? [] : compareToChain(entries, expectChain);
  if (outPath !== undefined) {
    writeFileSync(
      outPath,
      JSON.stringify(
        {
          dir,
          digest: 'sha256_canonical_lf is the pinned value; sha256 is the raw bytes on disk',
          expected_chain: expectChain ?? null,
          comparison:
            expectChain === undefined ? 'NOT COMPARED' : problems.length === 0 ? 'OK' : 'FAILED',
          problems,
          files: entries,
        },
        null,
        2,
      ) + '\n',
    );
    console.log(`written=${outPath}`);
  }

  if (expectChain !== undefined) {
    if (problems.length > 0) {
      console.error(
        `Retained fixture does NOT match the committed digests of chain ${expectChain}:`,
      );
      for (const p of problems) console.error('  ' + p);
      process.exit(1);
    }
    console.log(`expected-chain=${expectChain} match=OK files=${entries.length}`);
  }
}

if (require.main === module) main();
