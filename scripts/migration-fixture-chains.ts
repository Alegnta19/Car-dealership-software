/**
 * FBL-020-R6 §1.4 — THE PARTIAL-CHAIN FIXTURE MODE, AND ITS CHECKSUM ALLOWLIST.
 *
 * `scripts/migrate.ts` applies `migrations/`. Handing it any other directory is the one
 * way a partial, reordered or altered chain could reach a database, so that redirection is
 * an OPT-IN mode with three properties, and the third is the one that matters:
 *
 *   1. THE CALLER NAMES THE CHAIN. `MIGRATION_FIXTURE_CHAIN` must hold the id of a chain
 *      declared in `architecture/migration-fixture-chains.json`. An unset variable, or a
 *      name that is not declared, refuses.
 *   2. EVERY BODY IS ADMITTED BY CHECKSUM, NEVER BY NAME. The directory must carry only
 *      files the chain declares, every declared file marked `required` must be present,
 *      and each file present must hash — canonical-LF sha256 — to one of the digests
 *      declared for THAT filename. A file whose name is right and whose body is not on the
 *      list is refused exactly as hard as a file nobody declared.
 *   3. IT WEAKENS NO CHECK. A fixture mode whose effect is to switch off the ledger
 *      refusals would be worthless, and would make the tests that exercise those refusals
 *      unfalsifiable. Every refusal applies identically in both modes; what a chain grants
 *      is the right to use a RESTRICTED DIRECTORY, and bodies the restricted directory does
 *      not carry are still resolved from `migrations/` and still verified there.
 *
 * Also refused: naming a chain while pointed at the real `migrations/` directory. Somebody
 * who asks for fixture behavior in production has misunderstood something, and the safe
 * response to that is to stop.
 *
 * ── WHAT R6 §1.4 REMOVED, AND WHY ───────────────────────────────────────────
 *
 * Two admission rules used to live here beside the checksum one, and both are gone from
 * this module — not disabled, not guarded by a flag, DELETED — because both admitted
 * bodies nobody had ever read:
 *
 *   * `reserved-probe-filenames` admitted ANY body under a declared FILENAME, on the
 *     reasoning that the ledger-probe fixtures must be free to change because changing
 *     them is how the drift refusal is fired. True, and it does not require open
 *     admission: the probe bodies are a handful of one-line `CREATE TABLE`s and the drift
 *     variant is one of them, so all of them are now declared, each by its own digest,
 *     under the filename it may occupy.
 *   * `single-statement-deletion` admitted any body reachable from canonical `057` by
 *     deleting one contiguous span holding one `;`. That is a large set — every statement
 *     in the file, and every span that happens to hold exactly one terminator — and
 *     membership of it was COMPUTED, not reviewed. The twelve deletions the negative
 *     controls actually perform are deterministic, so all twelve are now declared by the
 *     canonical digest of the RESULTING body, and a thirteenth is a refusal.
 *
 * `loadFixtureChains` refuses a declaration carrying either rule's keys, so neither can
 * come back as data while this file stays as it is.
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

/** One admitted body of one file: a canonical-LF digest, and what that body is. */
export interface ChainVariant {
  sha256: string;
  /** Why this body exists — the committed migration, a probe fixture, one control's deletion. */
  note: string;
}

/**
 * One filename a chain may carry, with the complete list of bodies admitted under it.
 *
 * `variants` may never be empty: a filename with no digest IS filename-only admission, and
 * that is the rule R6 §1.4 removed. `loadFixtureChains` refuses such a declaration.
 */
export interface ChainFile {
  /** Whether the directory must carry it. An optional file is still checksum-pinned. */
  required: boolean;
  variants: ChainVariant[];
}

export interface FixtureChain {
  reason: string;
  files: Record<string, ChainFile>;
}

interface ChainsFile {
  chains: Record<string, unknown>;
}

/** Keys that belonged to the two admission rules R6 §1.4 removed. */
export const WITHDRAWN_CHAIN_KEYS = [
  'kind',
  'filename_pattern',
  'filenames',
  'mutated_file',
  'mutated_file_canonical_sha256',
] as const;

const DIGEST = /^[0-9a-f]{64}$/;

/**
 * Reads the allowlist AND checks its shape, because the shape is the control. A chain that
 * declared a filename with no digests would be filename-only admission wearing the new
 * type's clothes, and a chain carrying `filename_pattern` or `mutated_file` would be one of
 * the withdrawn rules coming back as data. Both throw here, at load, before any directory
 * is compared against anything.
 */
export function loadFixtureChains(file = FIXTURE_CHAINS_FILE): Record<string, FixtureChain> {
  const parsed = (JSON.parse(readFileSync(file, 'utf8')) as ChainsFile).chains;
  const problems: string[] = [];
  const chains: Record<string, FixtureChain> = {};

  for (const [id, raw] of Object.entries(parsed)) {
    const chain = raw as Partial<FixtureChain> & Record<string, unknown>;
    for (const withdrawn of WITHDRAWN_CHAIN_KEYS)
      if (chain[withdrawn] !== undefined)
        problems.push(
          `chain '${id}' declares '${withdrawn}', which belonged to an admission rule ` +
            'FBL-020-R6 §1.4 REMOVED. Every body is admitted by exact filename AND canonical ' +
            'checksum, and by nothing else.',
        );
    if (typeof chain.reason !== 'string' || chain.reason.trim() === '')
      problems.push(`chain '${id}' states no reason, so nobody can review why it exists`);
    if (chain.files === undefined || Object.keys(chain.files).length === 0) {
      problems.push(`chain '${id}' declares no files`);
      continue;
    }
    for (const [filename, entry] of Object.entries(chain.files)) {
      if (typeof entry?.required !== 'boolean')
        problems.push(`chain '${id}': ${filename} does not say whether it is required`);
      const variants = entry?.variants;
      if (!Array.isArray(variants) || variants.length === 0) {
        problems.push(
          `chain '${id}': ${filename} declares no admitted checksum. A filename with no ` +
            'digest is FILENAME-ONLY ADMISSION, which is what this allowlist exists to stop.',
        );
        continue;
      }
      for (const variant of variants) {
        if (typeof variant?.sha256 !== 'string' || !DIGEST.test(variant.sha256))
          problems.push(
            `chain '${id}': ${filename} declares ${JSON.stringify(variant?.sha256)}, which is ` +
              'not a canonical-LF sha256',
          );
        if (typeof variant?.note !== 'string' || variant.note.trim() === '')
          problems.push(
            `chain '${id}': ${filename} declares a digest with no note saying what body it is`,
          );
      }
    }
    chains[id] = chain as FixtureChain;
  }

  if (problems.length > 0)
    throw new Error(`${file} is not a valid fixture-chain allowlist:\n  ${problems.join('\n  ')}`);
  return chains;
}

/** The canonical-LF text of a migration: what is hashed AND what is executed. */
export function canonicalText(raw: Buffer | string): string {
  return (typeof raw === 'string' ? raw : raw.toString('utf8')).replace(/\r\n/g, '\n');
}

export function canonicalDigest(raw: Buffer | string): string {
  return createHash('sha256').update(canonicalText(raw), 'utf8').digest('hex');
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

  for (const [filename, entry] of Object.entries(chain.files))
    if (entry.required && !present.includes(filename))
      problems.push(`${filename} is declared REQUIRED by the chain but is not present`);

  for (const found of observed) {
    const entry = chain.files[found.file];
    if (entry === undefined) {
      problems.push(
        `${found.file} is present in the fixture directory but the chain does not declare it`,
      );
      continue;
    }
    if (!entry.variants.some((v) => v.sha256 === found.sha256))
      problems.push(
        `${found.file}: canonical-LF sha256 ${found.sha256} is not an admitted variant of this ` +
          `file. The chain admits ${entry.variants.length}: ` +
          `${entry.variants.map((v) => `${v.sha256} (${v.note})`).join('; ')}. A body is ` +
          'admitted by its CHECKSUM and never by its name, so an undeclared body is a refusal ' +
          'and not a new baseline.',
      );
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

  const validation = validateChainDirectory(chainFromEnv, migrationsDir, chains);
  return { mode: 'fixture', chain: chainFromEnv, problems: validation.problems };
}
