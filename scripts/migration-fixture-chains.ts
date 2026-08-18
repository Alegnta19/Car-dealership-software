/**
 * FBL-020-R5 §0.4 — THE PARTIAL-CHAIN FIXTURE MODE, AND ITS ALLOWLIST.
 *
 * `scripts/migrate.ts` applies `migrations/`. Handing it any other directory is the one
 * way a partial, reordered or altered chain could reach a database, and until this order
 * that redirection was UNGUARDED: `MIGRATIONS_DIR` was read straight out of the
 * environment, and the runner's response to a ledger row it could not find a body for was
 * a warning followed by carrying on.
 *
 * So the redirection is now an OPT-IN mode with three properties, and the third is the
 * one that matters:
 *
 *   1. THE CALLER NAMES THE CHAIN. `MIGRATION_FIXTURE_CHAIN` must hold the id of a chain
 *      declared in `architecture/migration-fixture-chains.json`. An unset variable, or a
 *      name that is not declared, refuses.
 *   2. THE DIRECTORY MUST MATCH THE DECLARATION EXACTLY — the set of filenames, and each
 *      file's canonical-LF digest. An extra file, a missing file or a changed body refuses.
 *   3. IT WEAKENS NO CHECK. A fixture mode whose effect is to switch off the ledger
 *      refusals would be worthless, and would make the tests that exercise those refusals
 *      unfalsifiable. Every refusal applies identically in both modes; what a chain grants
 *      is the right to use a RESTRICTED DIRECTORY, and bodies the restricted directory does
 *      not carry are still resolved from `migrations/` and still verified there.
 *
 * Also refused: naming a chain while pointed at the real `migrations/` directory. Somebody
 * who asks for fixture behavior in production has misunderstood something, and the safe
 * response to that is to stop.
 */
import { createHash } from 'crypto';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join, resolve } from 'path';

/**
 * Resolved for BOTH layouts this runs in — `scripts/*.ts` under tsx, and
 * `scripts/dist/*.js` in the container image — the same way `scripts/migrate.ts` resolves
 * `migrations/`. The image does not ship `architecture/` at all, which is deliberate and is
 * why `decideMode` never reads this file in production mode; see the note there.
 */
export const FIXTURE_CHAINS_FILE =
  [
    join(__dirname, '..', 'architecture', 'migration-fixture-chains.json'),
    join(__dirname, '..', '..', 'architecture', 'migration-fixture-chains.json'),
  ].find((f) => existsSync(f)) ??
  join(__dirname, '..', 'architecture', 'migration-fixture-chains.json');

/** The environment variable that opts in. Named once, here. */
export const FIXTURE_CHAIN_ENV = 'MIGRATION_FIXTURE_CHAIN';

/** A chain whose every file is pinned to a fixed canonical-LF digest. */
export interface PinnedChain {
  kind: 'pinned';
  reason: string;
  files: Record<string, string>;
}

/**
 * A chain that is `migrations/` with ONE statement deleted from ONE named file. Its other
 * files are digest-pinned; the mutated file is admitted only if it is the canonical text
 * with a single contiguous span removed, and that span holds exactly one statement
 * terminator.
 */
export interface SingleStatementDeletionChain {
  kind: 'single-statement-deletion';
  reason: string;
  mutated_file: string;
  mutated_file_canonical_sha256: string;
  files: Record<string, string>;
}

/**
 * A chain pinned by FILENAME ONLY, in a namespace reserved for probes. Used by the battery
 * that exercises the runner's refusals, whose fixtures must be free to change because
 * changing them is how the refusals are fired.
 */
export interface ReservedProbeChain {
  kind: 'reserved-probe-filenames';
  reason: string;
  filename_pattern: string;
  filenames: string[];
}

export type FixtureChain = PinnedChain | SingleStatementDeletionChain | ReservedProbeChain;

interface ChainsFile {
  chains: Record<string, FixtureChain>;
}

export function loadFixtureChains(file = FIXTURE_CHAINS_FILE): Record<string, FixtureChain> {
  return (JSON.parse(readFileSync(file, 'utf8')) as ChainsFile).chains;
}

/** The canonical-LF text of a migration: what is hashed AND what is executed. */
export function canonicalText(raw: Buffer | string): string {
  return (typeof raw === 'string' ? raw : raw.toString('utf8')).replace(/\r\n/g, '\n');
}

export function canonicalDigest(raw: Buffer | string): string {
  return createHash('sha256').update(canonicalText(raw), 'utf8').digest('hex');
}

/**
 * Is `mutated` exactly `canonical` with ONE contiguous span deleted?
 *
 * The greedy common prefix and the greedy common suffix (bounded so they cannot overlap)
 * must together account for the whole of `mutated`. That is not a heuristic — it holds if
 * and only if a single contiguous deletion produces `mutated`:
 *
 *   * two separate deletions leave a middle stretch that neither the prefix nor the suffix
 *     reaches, so their lengths fall short;
 *   * a SUBSTITUTION of equal length is rejected by the length comparison, and a
 *     substitution that also shortens leaves a changed character between the two runs, so
 *     the lengths fall short again;
 *   * an INSERTION cannot make the text shorter.
 *
 * `tests/migration-ledger.test.ts` drives all four cases.
 */
export function singleSpanDeletion(
  canonical: string,
  mutated: string,
): { ok: boolean; deleted: string; reason: string } {
  if (mutated.length >= canonical.length)
    return {
      ok: false,
      deleted: '',
      reason: 'the file is not shorter than the canonical text, so nothing was deleted from it',
    };
  let prefix = 0;
  while (prefix < mutated.length && canonical[prefix] === mutated[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < mutated.length - prefix &&
    canonical[canonical.length - 1 - suffix] === mutated[mutated.length - 1 - suffix]
  )
    suffix += 1;
  if (prefix + suffix !== mutated.length)
    return {
      ok: false,
      deleted: '',
      reason:
        'the file is not the canonical text with one contiguous span removed — a common ' +
        `prefix of ${prefix} and a common suffix of ${suffix} do not account for its ` +
        `${mutated.length} characters`,
    };
  return {
    ok: true,
    deleted: canonical.slice(prefix, canonical.length - suffix),
    reason: '',
  };
}

export interface ChainValidation {
  ok: boolean;
  chain: string;
  problems: string[];
  /** What was found, for the evidence trail. */
  observed: Array<{ file: string; sha256: string }>;
}

/**
 * Compares a directory against a declared chain. Returns every problem rather than the
 * first: an operator staring at a refused fixture needs the whole difference, not a hint.
 */
export function validateChainDirectory(
  chainId: string,
  dir: string,
  chains: Record<string, FixtureChain> = loadFixtureChains(),
  canonicalMigrationsDir?: string,
): ChainValidation {
  const problems: string[] = [];
  const chain = chains[chainId];
  if (chain === undefined) {
    return {
      ok: false,
      chain: chainId,
      problems: [
        `'${chainId}' is not a declared migration fixture chain. Declared: ` +
          `${Object.keys(chains).sort().join(', ')}. A chain must be added to ` +
          'architecture/migration-fixture-chains.json, with its reason, before it can run.',
      ],
      observed: [],
    };
  }
  if (!existsSync(dir))
    return {
      ok: false,
      chain: chainId,
      problems: [`the fixture directory does not exist: ${dir}`],
      observed: [],
    };

  const present = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const observed = present.map((f) => ({
    file: f,
    sha256: canonicalDigest(readFileSync(join(dir, f))),
  }));

  if (chain.kind === 'reserved-probe-filenames') {
    const pattern = new RegExp(chain.filename_pattern);
    const declared = new Set(chain.filenames);
    for (const f of present) {
      if (!pattern.test(f))
        problems.push(
          `${f} is not in the reserved probe namespace ${chain.filename_pattern} — a probe ` +
            'chain may only carry files no real migration could ever be named',
        );
      else if (!declared.has(f))
        problems.push(`${f} matches the reserved pattern but is not one of the declared filenames`);
    }
    if (present.length === 0) problems.push('the probe chain directory holds no .sql file at all');
    return { ok: problems.length === 0, chain: chainId, problems, observed };
  }

  const pinned = chain.files;
  const expectedNames = new Set(Object.keys(pinned));
  const mutatedFile = chain.kind === 'single-statement-deletion' ? chain.mutated_file : undefined;
  if (mutatedFile !== undefined) expectedNames.add(mutatedFile);

  for (const f of present)
    if (!expectedNames.has(f))
      problems.push(`${f} is present in the fixture directory but the chain does not declare it`);
  for (const f of expectedNames)
    if (!present.includes(f)) problems.push(`${f} is declared by the chain but is not present`);

  for (const [file, expected] of Object.entries(pinned)) {
    const found = observed.find((o) => o.file === file);
    if (found === undefined) continue; // already reported as missing
    if (found.sha256 !== expected)
      problems.push(
        `${file}: expected canonical-LF sha256 ${expected}, found ${found.sha256} — the chain ` +
          'pins a fixed digest, so a changed body is a refusal and not a new baseline',
      );
  }

  if (chain.kind === 'single-statement-deletion' && present.includes(chain.mutated_file)) {
    const canonicalDir = canonicalMigrationsDir ?? join(__dirname, '..', 'migrations');
    const canonicalPath = join(canonicalDir, chain.mutated_file);
    if (!existsSync(canonicalPath)) {
      problems.push(
        `${chain.mutated_file}: the canonical body is not present at ${canonicalPath}, so the ` +
          'mutation cannot be checked against it',
      );
    } else {
      const canonical = canonicalText(readFileSync(canonicalPath));
      const canonicalSha = canonicalDigest(canonical);
      if (canonicalSha !== chain.mutated_file_canonical_sha256)
        problems.push(
          `${chain.mutated_file}: the chain pins the canonical digest ` +
            `${chain.mutated_file_canonical_sha256} but migrations/ now holds ${canonicalSha}. ` +
            'The pin must be updated deliberately when the migration is corrected.',
        );
      const mutated = canonicalText(readFileSync(join(dir, chain.mutated_file)));
      const span = singleSpanDeletion(canonical, mutated);
      if (!span.ok) problems.push(`${chain.mutated_file}: ${span.reason}`);
      else {
        const terminators = (span.deleted.match(/;/g) ?? []).length;
        if (terminators !== 1)
          problems.push(
            `${chain.mutated_file}: the removed span holds ${terminators} statement ` +
              'terminator(s), so it is not exactly one statement',
          );
      }
    }
  }

  return { ok: problems.length === 0, chain: chainId, problems, observed };
}

/** Two paths naming the same directory, compared without caring about separators or case. */
export function sameDirectory(a: string, b: string): boolean {
  const norm = (p: string): string =>
    resolve(p).split('\\').join('/').replace(/\/+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

export interface ModeDecision {
  mode: 'production' | 'fixture';
  chain: string | undefined;
  /** Non-empty means REFUSE, and each entry says why. */
  problems: string[];
}

/**
 * Decides which mode a run is in, and refuses the two shapes that must not proceed: a
 * non-canonical directory with no chain named, and a chain named for the canonical one.
 */
export function decideMode(
  migrationsDir: string,
  canonicalMigrationsDir: string,
  chainFromEnv: string | undefined,
  /*
   * A THUNK, not an object. The production path must not merely avoid USING the allowlist,
   * it must not READ it — and only a lazily-invoked loader makes that testable: the suite
   * passes one that throws, so a future edit that hoisted the load above the production
   * return would fail there rather than in a container nobody was watching.
   */
  loadChains: () => Record<string, FixtureChain> = loadFixtureChains,
): ModeDecision {
  const isCanonical = sameDirectory(migrationsDir, canonicalMigrationsDir);
  const named = chainFromEnv !== undefined && chainFromEnv !== '';

  /*
   * THE PRODUCTION PATH RETURNS BEFORE THE ALLOWLIST IS EVEN READ, and that is a
   * requirement rather than an optimisation. The container image ships `migrations/` and
   * `scripts/dist/` and NOT `architecture/` — correctly, since a deployed image has no
   * business carrying fixture declarations — so a version of this function that loaded the
   * allowlist eagerly made `node scripts/dist/migrate.js` die on a missing file before it
   * had looked at a single migration. Production mode must depend on nothing that only the
   * repository has.
   */
  if (isCanonical && !named) return { mode: 'production', chain: undefined, problems: [] };

  const chains = loadChains();

  if (isCanonical && named)
    return {
      mode: 'production',
      chain: chainFromEnv,
      problems: [
        `${FIXTURE_CHAIN_ENV}=${String(chainFromEnv)} was set while the runner is pointed at ` +
          'the real migrations directory. Fixture behavior in production is never wanted, so ' +
          'this refuses rather than picking one of the two intentions.',
      ],
    };

  if (!named)
    return {
      mode: 'fixture',
      chain: undefined,
      problems: [
        `MIGRATIONS_DIR is ${migrationsDir}, which is not the canonical migrations directory ` +
          `(${canonicalMigrationsDir}). A restricted or altered chain must be opted into by ` +
          `name: set ${FIXTURE_CHAIN_ENV} to a chain declared in ` +
          'architecture/migration-fixture-chains.json. Declared: ' +
          `${Object.keys(chains).sort().join(', ')}.`,
      ],
    };

  const validation = validateChainDirectory(
    chainFromEnv,
    migrationsDir,
    chains,
    canonicalMigrationsDir,
  );
  return { mode: 'fixture', chain: chainFromEnv, problems: validation.problems };
}
