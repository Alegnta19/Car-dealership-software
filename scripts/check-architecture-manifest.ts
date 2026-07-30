/**
 * FBL-010: keeps architecture/modules.json honest against the real workspace.
 *
 * Fails when a workspace package is missing from the manifest (or vice versa), when a
 * declared public entry point does not exist, or when a package.json declares a
 * @dealer/* dependency the manifest does not allow — the dependency-cruiser rules are
 * generated from the manifest, so an undeclared edge would otherwise be enforced
 * against silently stale data.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');

interface ModuleMeta {
  path: string;
  owner: string;
  purpose: string;
  publicEntry: string;
  allowedDealerDeps: string[];
  prohibited: string[];
  database: string;
  status: string;
}

function main(): void {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'architecture', 'modules.json'), 'utf8')) as {
    modules: Record<string, ModuleMeta>;
  };
  const failures: string[] = [];

  const onDisk = new Map<string, string>(); // package name -> dir
  for (const tree of ['apps', 'packages']) {
    for (const entry of readdirSync(join(ROOT, tree))) {
      const pkgPath = join(ROOT, tree, entry, 'package.json');
      if (!existsSync(pkgPath)) continue;
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
        name: string;
        private?: boolean;
        dependencies?: Record<string, string>;
      };
      onDisk.set(pkg.name, `${tree}/${entry}`);

      const meta = manifest.modules[pkg.name];
      if (!meta) {
        failures.push(`${pkg.name} (${tree}/${entry}) has no entry in architecture/modules.json`);
        continue;
      }
      if (meta.path !== `${tree}/${entry}`) {
        failures.push(`${pkg.name}: manifest path ${meta.path} != actual ${tree}/${entry}`);
      }
      if (!existsSync(join(ROOT, meta.publicEntry))) {
        failures.push(`${pkg.name}: declared public entry ${meta.publicEntry} does not exist`);
      }
      if (pkg.private !== true) {
        failures.push(`${pkg.name}: workspace packages must be private (never published)`);
      }
      for (const [field, req] of ['owner', 'purpose', 'status'].map(
        (f) => [f, meta[f as keyof ModuleMeta]] as const,
      )) {
        if (typeof req !== 'string' || req.trim() === '') {
          failures.push(`${pkg.name}: manifest field "${field}" is missing or empty`);
        }
      }

      const declaredDealerDeps = Object.keys(pkg.dependencies ?? {}).filter((d) =>
        d.startsWith('@dealer/'),
      );
      for (const dep of declaredDealerDeps) {
        if (!meta.allowedDealerDeps.includes(dep)) {
          failures.push(
            `${pkg.name}: package.json depends on ${dep}, which modules.json does not allow`,
          );
        }
      }
      for (const dep of meta.allowedDealerDeps) {
        if (!declaredDealerDeps.includes(dep)) {
          failures.push(
            `${pkg.name}: modules.json allows ${dep} but package.json does not declare it (stale headroom)`,
          );
        }
      }
    }
  }

  // Package TypeScript lives under src/ — anywhere else sits outside every dependency
  // rule scope, which is exactly how boundaries erode (found by adversarial review).
  const strayRoots = ['apps', 'packages'];
  for (const tree of strayRoots) {
    for (const entry of readdirSync(join(ROOT, tree))) {
      const pkgDir = join(ROOT, tree, entry);
      if (!existsSync(join(pkgDir, 'package.json'))) continue;
      const stack = [pkgDir];
      while (stack.length > 0) {
        const dir = stack.pop()!;
        for (const item of readdirSync(dir)) {
          const full = join(dir, item);
          const rel = full
            .slice(ROOT.length + 1)
            .split('\\')
            .join('/');
          const stat = statSync(full);
          if (stat.isDirectory()) {
            if (item === 'node_modules' || item === 'dist' || item === 'src') continue;
            stack.push(full);
          } else if (item.endsWith('.ts') && !rel.includes('/src/')) {
            failures.push(
              `${rel}: package TypeScript must live under src/ (dependency rules do not govern stray locations)`,
            );
          }
        }
      }
    }
  }

  for (const name of Object.keys(manifest.modules)) {
    if (!onDisk.has(name)) failures.push(`${name} is in architecture/modules.json but not on disk`);
  }

  if (failures.length > 0) {
    for (const f of failures) console.error('ARCH-MANIFEST: ' + f);
    process.exit(1);
  }
  console.log(
    `architecture manifest OK: ${onDisk.size} modules, ownership and dependency declarations consistent`,
  );
}

main();
