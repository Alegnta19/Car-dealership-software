/**
 * FBL-000-R1 (correction D): migration manifest — filenames + SHA-256 checksums.
 *
 *   npx tsx scripts/migration-manifest.ts <dir> [--out <file>]
 *
 * Used twice in CI: over migrations/ (the current chain) and over
 * tests/fixtures/schema-f76a27a/ (the retained fixtures, which must stay
 * byte-identical to commit f76a27a — their published checksums make any drift
 * visible in the evidence pack).
 */
import { createHash } from 'crypto';
import { readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

function main(): void {
  const dir = process.argv[2];
  if (dir === undefined) {
    console.error('Usage: migration-manifest.ts <dir> [--out <file>]');
    process.exit(2);
  }
  const outIdx = process.argv.indexOf('--out');
  const outPath = outIdx >= 0 ? process.argv[outIdx + 1] : undefined;

  const entries = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((file) => ({
      file,
      sha256: createHash('sha256')
        .update(readFileSync(join(dir, file)))
        .digest('hex'),
    }));

  if (entries.length === 0) {
    console.error(`No .sql files found in ${dir}`);
    process.exit(1);
  }

  for (const e of entries) console.log(`${e.sha256}  ${e.file}`);
  if (outPath !== undefined) {
    writeFileSync(outPath, JSON.stringify({ dir, files: entries }, null, 2) + '\n');
    console.log(`written=${outPath}`);
  }
}

main();
