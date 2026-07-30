/**
 * FBL-010: `process.env` is read only at approved configuration/composition points.
 *
 * Everything else gets configuration through @dealer/platform's typed boundary.
 * Deterministic text scan over production sources (apps/, packages/); scripts/, tests/
 * and @dealer/test-kit are tooling/test surfaces and are exempt by policy.
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

const ROOT = join(__dirname, '..');

const ALLOWED = new Set([
  'packages/platform/src/config.ts', // THE configuration boundary
  'apps/api/src/server.ts', // composition root: loadConfig(process.env)
  'apps/worker/src/main.ts', // composition root (shell)
]);

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      return entry === 'node_modules' || entry === 'dist' ? [] : sources(full);
    }
    return full.endsWith('.ts') ? [full] : [];
  });
}

function main(): void {
  const failures: string[] = [];
  for (const tree of ['apps', 'packages']) {
    for (const file of sources(join(ROOT, tree))) {
      const rel = relative(ROOT, file).replace(/\\/g, '/');
      if (ALLOWED.has(rel) || rel.startsWith('packages/test-kit/')) continue;
      const text = readFileSync(file, 'utf8');
      if (text.includes('process.env')) {
        failures.push(rel);
      }
    }
  }
  if (failures.length > 0) {
    console.error('process.env read outside the approved configuration/composition files:');
    for (const f of failures) console.error('  ' + f);
    process.exit(1);
  }
  console.log(
    'env-access OK: process.env confined to the approved configuration/composition files',
  );
}

main();
