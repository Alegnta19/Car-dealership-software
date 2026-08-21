/**
 * FBL-020-R5 §0.3 / §0.4 — THE REFUSALS, PROBED AGAINST A REAL MIGRATED DATABASE.
 *
 *   DATABASE_URL=postgres://…/<a fully migrated database> \
 *     npx tsx scripts/migrate-refusal-probe.ts --out artifacts/refusal-probes.json [--log <txt>]
 *
 * ── WHY THIS EXISTS SEPARATELY FROM THE SUITE ───────────────────────────────
 *
 * `tests/migration-ledger.test.ts` drives every refusal against a scratch database holding
 * two synthetic probe migrations. That is the right way to test the LOGIC, and it is the
 * only way to exercise the reserved-namespace chain — but the probe migrations are not this
 * repository's chain, and a control that has only ever been fired at a fixture has only ever
 * been shown to work on a fixture.
 *
 * So the CI upgrade job runs these probes against the database it has just migrated through
 * the real chain, `057` included. Each probe:
 *
 *   1. copies that database (`CREATE DATABASE … TEMPLATE`), so the drill database is never
 *      written to and the probes cannot contaminate each other;
 *   2. damages the COPY's ledger, or hands the runner a directory no chain admits;
 *   3. runs the REAL runner and requires a non-zero exit whose output names the declared
 *      refusal kind;
 *   4. drops the copy.
 *
 * A probe whose damage does NOT stop the runner is a FAILED probe and this script exits
 * non-zero. Nothing is repaired, and the template is left byte-identical.
 */
import { spawnSync } from 'child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Client } from 'pg';
import { FIXTURE_CHAIN_ENV, canonicalDigest } from './migration-fixture-chains';

const IS_WINDOWS = process.platform === 'win32';
const MIGRATIONS = join(__dirname, '..', 'migrations');

/**
 * One probe. `damage` runs SQL against the copy; `chain`/`dirKind` decide what directory the
 * runner is pointed at. `expect` is a substring the runner's output MUST contain — declared,
 * not discovered, so a refusal that starts happening for a different reason is a review event
 * rather than a silent pass.
 */
interface Probe {
  id: string;
  what: string;
  /** SQL applied to the COPY before the runner is invoked. */
  damage?: string;
  /** The directory to hand the runner: the real chain, a partial copy, or a foreign one. */
  directory: 'canonical' | 'pre-057-copy' | 'unadmitted';
  /** Value for MIGRATION_FIXTURE_CHAIN, or undefined to leave it unset. */
  chain?: string;
  expect: string;
  /** True when the runner is expected to SUCCEED — the control's own pass case. */
  expectSuccess?: boolean;
}

const PROBES: Probe[] = [
  {
    id: 'unverifiable_checksum_refuses',
    what:
      'a ledger row with a NULL checksum — the shape the pre-checksum runner left behind — ' +
      'refuses the run instead of producing a warning',
    damage: `UPDATE schema_migrations SET checksum_sha256 = NULL, checksum_algorithm = NULL
              WHERE filename = '057_identity_boundary_completion.sql'`,
    directory: 'canonical',
    expect: 'unverifiable-checksum',
  },
  {
    id: 'unsupported_algorithm_refuses',
    what: 'a digest recorded under an algorithm this runner cannot recompute refuses the run',
    damage: `UPDATE schema_migrations SET checksum_algorithm = 'sha1-raw-bytes'
              WHERE filename = '056_identity_contract_completion.sql'`,
    directory: 'canonical',
    expect: 'unsupported-algorithm',
  },
  {
    id: 'missing_body_refuses',
    what:
      'a ledger row naming a migration no tree in scope holds refuses the run, instead of ' +
      'being skipped with a warning for ever',
    damage: `INSERT INTO schema_migrations (filename, checksum_sha256, checksum_algorithm)
             VALUES ('058_never_existed.sql', repeat('a', 64), 'sha256-canonical-lf')`,
    directory: 'canonical',
    expect: 'missing-body',
  },
  {
    id: 'checksum_drift_refuses',
    what: 'a body that no longer matches its recorded digest refuses the run',
    damage: `UPDATE schema_migrations SET checksum_sha256 = repeat('b', 64)
              WHERE filename = '055_identity_organization.sql'`,
    directory: 'canonical',
    expect: 'checksum-drift',
  },
  {
    id: 'restricted_directory_without_a_chain_refuses',
    what:
      'a partial chain handed to the runner with no chain named refuses, so a restricted ' +
      'directory cannot reach a database unannounced',
    directory: 'pre-057-copy',
    expect: 'fixture-chain check FAILED',
  },
  {
    id: 'restricted_directory_with_its_chain_is_admitted_and_still_verifies',
    what:
      'the same partial chain, DECLARED, is admitted — and the ledger rows whose bodies it ' +
      'withholds are still verified against migrations/, so restricting what is applied does ' +
      'not reduce what is verified',
    directory: 'pre-057-copy',
    chain: 'pre-057',
    expect: '"mode":"fixture"',
    expectSuccess: true,
  },
  {
    id: 'restricted_directory_with_its_chain_still_refuses_a_damaged_ledger',
    what:
      'the declared partial chain does NOT suppress a refusal: the withheld 057 row is ' +
      'verified from migrations/ and its drift stops the run',
    damage: `UPDATE schema_migrations SET checksum_sha256 = repeat('c', 64)
              WHERE filename = '057_identity_boundary_completion.sql'`,
    directory: 'pre-057-copy',
    chain: 'pre-057',
    expect: 'checksum-drift',
  },
  {
    id: 'unadmitted_directory_refuses_even_with_a_declared_chain_name',
    what:
      'a directory carrying a file the chain does not declare is refused even under a real ' +
      'chain name, so an unreviewed migration cannot ride along inside an admitted fixture',
    directory: 'unadmitted',
    chain: 'pre-057',
    expect: 'does not declare',
  },
  {
    id: 'fixture_chain_named_for_the_production_directory_refuses',
    what:
      'naming a fixture chain while pointed at the real migrations directory refuses rather ' +
      'than guessing which of the two intentions was meant',
    directory: 'canonical',
    chain: 'pre-057',
    expect: 'pointed at',
  },
];

function parseArgs(): { out: string; log: string | undefined } {
  const argv = process.argv.slice(2);
  let out: string | undefined;
  let log: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === '--out') out = argv[(i += 1)];
    else if (arg === '--log') log = argv[(i += 1)];
    else {
      console.error(`Unrecognized argument: ${arg}`);
      process.exit(2);
    }
  }
  if (out === undefined) {
    console.error('Usage: migrate-refusal-probe.ts --out <json> [--log <txt>]');
    process.exit(2);
  }
  return { out, log };
}

function maintenanceUrl(databaseUrl: string): { admin: string; database: string } {
  const url = new URL(databaseUrl);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  url.pathname = '/postgres';
  return { admin: url.toString(), database };
}

function copyUrl(databaseUrl: string, copyName: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${copyName}`;
  return url.toString();
}

async function main(): Promise<void> {
  const { out, log } = parseArgs();
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl === '') {
    console.error('DATABASE_URL must name a fully migrated database, used as the TEMPLATE.');
    process.exit(2);
  }
  const { admin, database: template } = maintenanceUrl(databaseUrl);

  const staging = mkdtempSync(join(tmpdir(), 'fbl020-refusal-'));
  // A copy of `migrations/` with 057 AND EVERYTHING AFTER IT withheld: the same shape the CI
  // upgrade job stages, and byte-identical to the repository's files, so the `pre-057` chain
  // admits it.
  //
  // FBL-020-R6 §3: the rule is stated by NUMBER rather than by naming one file. It used to
  // delete `057_identity_boundary_completion.sql` and keep the rest, which was the same set
  // only while 057 was the last migration; with `058` on disk that form staged a POST-057
  // file into a directory meant to be the chain BEFORE 057, and the `pre-057` chain — quite
  // correctly — refused a file it does not declare.
  const partial = join(staging, 'pre-057');
  mkdirSync(partial, { recursive: true });
  cpSync(MIGRATIONS, partial, { recursive: true });
  for (const file of readdirSync(partial)) {
    if (file.endsWith('.sql') && Number(file.slice(0, 3)) >= 57) {
      rmSync(join(partial, file), { force: true });
    }
  }
  // …and one that additionally carries a file no chain declares.
  const unadmitted = join(staging, 'unadmitted');
  mkdirSync(unadmitted, { recursive: true });
  cpSync(partial, unadmitted, { recursive: true });
  writeFileSync(join(unadmitted, '999_unreviewed.sql'), 'SELECT 1;\n', 'utf8');

  const directories: Record<Probe['directory'], string> = {
    canonical: MIGRATIONS,
    'pre-057-copy': partial,
    unadmitted,
  };

  const client = new Client({ connectionString: admin });
  await client.connect();
  const results: Array<Record<string, unknown>> = [];
  const lines: string[] = [];
  let failed = 0;

  try {
    for (const [index, probe] of PROBES.entries()) {
      const copy = `${template}_rp${index}`.slice(0, 63);
      await client.query(`DROP DATABASE IF EXISTS "${copy}"`);
      await client.query(`CREATE DATABASE "${copy}" TEMPLATE "${template}"`);

      if (probe.damage !== undefined) {
        const damaged = new Client({ connectionString: copyUrl(databaseUrl, copy) });
        await damaged.connect();
        try {
          await damaged.query(probe.damage);
        } finally {
          await damaged.end();
        }
      }

      const env: NodeJS.ProcessEnv = {
        ...process.env,
        DATABASE_URL: copyUrl(databaseUrl, copy),
        MIGRATIONS_DIR: directories[probe.directory],
      };
      if (probe.chain !== undefined) env[FIXTURE_CHAIN_ENV] = probe.chain;
      else delete env[FIXTURE_CHAIN_ENV];

      const run = spawnSync('npx', ['tsx', 'scripts/migrate.ts'], {
        encoding: 'utf8',
        env,
        shell: IS_WINDOWS,
        maxBuffer: 64 * 1024 * 1024,
        timeout: 300_000,
      });
      const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
      const status = run.status ?? 1;
      const wanted = probe.expectSuccess === true;
      const exitAsExpected = wanted ? status === 0 : status !== 0;
      const sawExpected = output.includes(probe.expect);
      const ok = exitAsExpected && sawExpected;
      if (!ok) failed += 1;

      results.push({
        id: probe.id,
        what: probe.what,
        directory: probe.directory,
        chain: probe.chain ?? null,
        expect_exit: wanted ? 'zero' : 'non-zero',
        observed_exit: status,
        expect_output_contains: probe.expect,
        output_contained_it: sawExpected,
        satisfied: ok,
      });
      lines.push(
        `probe=${probe.id}`,
        `  what=${probe.what}`,
        `  directory=${probe.directory} chain=${probe.chain ?? '(unset)'}`,
        `  expected_exit=${wanted ? 'zero' : 'non-zero'} observed_exit=${status}`,
        `  expected_output=${JSON.stringify(probe.expect)} seen=${sawExpected}`,
        `  verdict=${ok ? 'PROBE SATISFIED' : 'PROBE FAILED'}`,
        '',
      );

      await client.query(`DROP DATABASE IF EXISTS "${copy}"`);
    }
  } finally {
    await client.end();
    rmSync(staging, { recursive: true, force: true });
  }

  const summary = {
    template_database: template,
    migration_057_sha256_canonical_lf: canonicalDigest(
      readFileSync(join(MIGRATIONS, '057_identity_boundary_completion.sql')),
    ),
    probes_total: PROBES.length,
    probes_satisfied: PROBES.length - failed,
    probes_failed: failed,
    probes: results,
  };
  writeFileSync(out, JSON.stringify(summary, null, 2) + '\n');

  lines.push(`probes_total=${PROBES.length} satisfied=${PROBES.length - failed} failed=${failed}`);
  const text = lines.join('\n') + '\n';
  process.stdout.write(text);
  if (log !== undefined) writeFileSync(log, text);

  if (failed > 0) {
    console.error(
      `${failed} refusal probe(s) FAILED: a condition the runner is supposed to refuse did ` +
        'not stop it, or stopped it for a reason other than the declared one.',
    );
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
