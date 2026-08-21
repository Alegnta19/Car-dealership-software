import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { Client } from 'pg';
import { INTEGRATION_DATABASE_URL, skipIntegration } from '@dealer/test-kit';
import { closePool, query } from '@dealer/database';
import { ledgerRefusals } from '../scripts/migrate';
import {
  FIXTURE_CHAINS_FILE,
  FIXTURE_CHAIN_ENV,
  WITHDRAWN_CHAIN_KEYS,
  canonicalDigest as chainDigest,
  decideMode,
  loadFixtureChains,
  validateChainDirectory,
} from '../scripts/migration-fixture-chains';
import type { ControlAnchor } from '../scripts/upgrade-negative-controls';
import {
  CONTROLS,
  canonical057,
  loadAnchors,
  removeStatement,
} from '../scripts/upgrade-negative-controls';

/**
 * FBL-020-R6 §1.4 — THE BODIES THE LEDGER BATTERY WRITES, IN ONE PLACE.
 *
 * Every one of them is declared in `architecture/migration-fixture-chains.json` under the
 * filename it occupies, by its canonical-LF digest, and a test below proves that. They live
 * at module scope rather than inside the integration `describe` so that proof runs even when
 * no database is configured — a fixture-admission rule that is only checked when
 * `TEST_DATABASE_URL` happens to be set is not a rule.
 */
const PROBE_BODIES = {
  alpha: 'CREATE TABLE ledger_probe_alpha (id integer PRIMARY KEY);\n',
  alphaDrifted: 'CREATE TABLE ledger_probe_alpha (id integer PRIMARY KEY, extra text);\n',
  beta: 'CREATE TABLE ledger_probe_beta (id integer PRIMARY KEY);\n',
  gamma: 'CREATE TABLE ledger_probe_gamma (id integer PRIMARY KEY);\n',
} as const;

/** Which probe filename each body may be written to. */
const PROBE_FILENAMES: Record<keyof typeof PROBE_BODIES, string> = {
  alpha: '900_ledger_probe_alpha.sql',
  alphaDrifted: '900_ledger_probe_alpha.sql',
  beta: '901_ledger_probe_beta.sql',
  gamma: '902_ledger_probe_gamma.sql',
};

/**
 * FBL-020-R4 §0 — MIGRATION LEDGER INTEGRITY.
 *
 * The ledger used to record a filename and a timestamp, and the runner skipped any
 * filename it already held. A migration whose BODY changed after being applied was
 * therefore skipped in silence: the environment reported it as applied while carrying a
 * different schema, and nothing could distinguish the two. These tests pin the
 * correction from the outside — by running `scripts/migrate.ts` as a real process
 * against a real throwaway database — because the property under test is what the
 * RUNNER does, not what a function returns.
 */
describe(
  'migration ledger integrity (FBL-020-R4 §0)',
  { skip: skipIntegration ? 'set TEST_DATABASE_URL to run' : false },
  () => {
    const RUNNER = join(__dirname, '..', 'scripts', 'migrate.ts');
    const SCRATCH_DB = 'dealership_test_ledger_probe';
    let scratchUrl: string;
    let dir: string;

    /** The canonical-LF digest the runner must record, computed independently here. */
    function canonicalDigest(text: string): string {
      return createHash('sha256').update(text.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
    }

    interface Run {
      status: number | null;
      output: string;
    }

    /*
     * FBL-020-R6 §1.4: this battery runs the runner against a THROWAWAY directory of probe
     * migrations, which is exactly the redirection that is opt-in. So it declares the
     * `ledger-probe` chain by name, the same way CI declares `pre-057`. Under R5 that chain
     * pinned the probe FILENAMES and not their bodies, on the reasoning that a body has to
     * change for the drift refusal to fire; R6 declares the drifted body too, so every body
     * `PROBE_BODIES` holds is pinned by checksum and a fourth body is refused. The chain
     * still suppresses no refusal whatsoever, which is what the tests in this file
     * demonstrate.
     */
    function runMigrate(env: Record<string, string> = {}): Run {
      const child = spawnSync(process.execPath, ['--import', 'tsx', RUNNER], {
        encoding: 'utf8',
        timeout: 120_000,
        env: {
          ...process.env,
          DATABASE_URL: scratchUrl,
          MIGRATIONS_DIR: dir,
          [FIXTURE_CHAIN_ENV]: 'ledger-probe',
          ...env,
        },
      });
      return {
        status: child.status,
        output: `${child.stdout ?? ''}\n${child.stderr ?? ''}`,
      };
    }

    /** Reads the scratch ledger through a one-shot connection to the scratch database. */
    function ledger(): Array<{
      filename: string;
      checksum: string | null;
      algorithm: string | null;
    }> {
      const child = spawnSync(
        process.execPath,
        [
          '-e',
          `const {Client}=require('pg');(async()=>{const c=new Client({connectionString:process.env.PROBE_URL});` +
            `await c.connect();const r=await c.query('SELECT filename, checksum_sha256, checksum_algorithm ` +
            `FROM schema_migrations ORDER BY filename');await c.end();console.log('LEDGER '+JSON.stringify(r.rows));})()` +
            `.catch(e=>{console.error(String(e.message));process.exit(1);})`,
        ],
        {
          encoding: 'utf8',
          cwd: join(__dirname, '..'),
          env: { ...process.env, PROBE_URL: scratchUrl },
        },
      );
      const line = (child.stdout ?? '').split('\n').find((l) => l.startsWith('LEDGER '));
      assert.ok(
        line !== undefined,
        `ledger read failed: ${child.stdout ?? ''}${child.stderr ?? ''}`,
      );
      return (
        JSON.parse(line.slice('LEDGER '.length)) as Array<{
          filename: string;
          checksum_sha256: string | null;
          checksum_algorithm: string | null;
        }>
      ).map((r) => ({
        filename: r.filename,
        checksum: r.checksum_sha256,
        algorithm: r.checksum_algorithm,
      }));
    }

    function scratchExec(sql: string): { status: number | null; output: string } {
      const child = spawnSync(
        process.execPath,
        [
          '-e',
          `const {Client}=require('pg');(async()=>{const c=new Client({connectionString:process.env.PROBE_URL});` +
            `await c.connect();try{await c.query(process.env.PROBE_SQL);console.log('OK');}finally{await c.end();}})()` +
            `.catch(e=>{console.error('ERR '+String(e.message));process.exit(1);})`,
        ],
        {
          encoding: 'utf8',
          cwd: join(__dirname, '..'),
          env: { ...process.env, PROBE_URL: scratchUrl, PROBE_SQL: sql },
        },
      );
      return { status: child.status, output: `${child.stdout ?? ''}\n${child.stderr ?? ''}` };
    }

    /**
     * DELIBERATELY CRLF. Every migration file on a Windows checkout has CRLF endings
     * (`core.autocrlf=true`), and the same file in CI has LF. A ledger that hashed the
     * working bytes would therefore disagree with itself across the two, so the fixture
     * writes the hostile case rather than the convenient one.
     */
    const ALPHA_LF = PROBE_BODIES.alpha;
    const BETA_LF = PROBE_BODIES.beta;
    const toCrlf = (text: string): string => text.replace(/\n/g, '\r\n');

    function writeMigrations(alpha: string, beta: string): void {
      writeFileSync(join(dir, '900_ledger_probe_alpha.sql'), toCrlf(alpha), 'utf8');
      writeFileSync(join(dir, '901_ledger_probe_beta.sql'), toCrlf(beta), 'utf8');
    }

    /*
     * ── WHY THE SCRATCH DATABASE IS NOT MANAGED THROUGH THE SUITE'S POOL ──────────
     *
     * These hooks used to run `DROP DATABASE IF EXISTS …` and `CREATE DATABASE …`
     * through `@dealer/database`'s shared pool. That made BOTH mandatory gates — the
     * full suite and `scripts/mutation-kill.ts` — fail intermittently, from this
     * suite's hooks and nowhere else. The recorded failures name the mechanism:
     *
     *   failureType: 'hookFailed'
     *   error: 'canceling statement due to statement timeout'   code: '57014'
     *   at tests/migration-ledger.test.ts:162   (the `after` hook's DROP DATABASE)
     *
     * Two separate facts combine to produce it, and both are fixed here rather than
     * papered over with a retry or a longer timeout:
     *
     *   1. THE PROBES LEAVE BACKENDS BEHIND FOR A MOMENT. Every probe in this file
     *      (`runMigrate`, `ledger`, `scratchExec`) is a CHILD PROCESS that connects to
     *      the scratch database. `spawnSync` returns when the child exits, but the
     *      server-side backend is reaped slightly later, and under the load of a full
     *      suite or a mutation sweep "slightly later" is long enough to matter. A
     *      `DROP DATABASE` issued in that window does not fail fast: PostgreSQL spins
     *      in `CountOtherDBBackends` and only then reports
     *      `55006 database "…" is being accessed by other users`, and while a backend
     *      is still establishing it blocks on the database object lock instead.
     *      Measured directly against this cluster, with one session deliberately held
     *      open: the plain statement returned 55006 after 5,607 ms.
     *
     *   2. THE POOL CARRIES AN APPLICATION STATEMENT TIMEOUT. `getPool()` opens every
     *      connection with `-c statement_timeout=<PG_STATEMENT_TIMEOUT_MS>` (30,000 ms
     *      by default). That bound is right for application statements and wrong for a
     *      cluster-level maintenance statement, which must never be cancelled halfway
     *      through removing a database directory. A wait that outlived the bound is
     *      exactly the `57014` above.
     *
     * So the scratch database is created and dropped on a DEDICATED maintenance
     * connection with no statement timeout, the conflicting backends are terminated
     * explicitly first, and the drop is `WITH (FORCE)` — which makes the statement
     * independent of whether anything is still attached, instead of waiting to find
     * out. The absence of the database is then ASSERTED, so a silent partial teardown
     * cannot masquerade as success.
     *
     * `TEMPLATE template0` for the same reason: `template1` is the default target of
     * any stray connection and of anything installed cluster-wide, and a single
     * session attached to it makes `CREATE DATABASE` fail. `template0` is the pristine
     * template nothing ever connects to. An earlier form of this flake was in fact a
     * `before`-hook failure — `58P01 could not open file "base/1/4171"`, base/1 being
     * template1 — on a cluster whose template1 had been damaged by a force-killed
     * postmaster; templating from template0 makes this suite independent of that too.
     */
    async function maintenance<T>(work: (client: Client) => Promise<T>): Promise<T> {
      const client = new Client({
        connectionString: INTEGRATION_DATABASE_URL as string,
        options: '-c statement_timeout=0 -c idle_in_transaction_session_timeout=0',
        connectionTimeoutMillis: 15_000,
      });
      await client.connect();
      try {
        return await work(client);
      } finally {
        await client.end().catch(() => undefined);
      }
    }

    /*
     * ── WHAT WAS STILL RACY, AND WHY THE CORRECTION ABOVE WAS NOT ENOUGH ──────────
     *
     * The teardown above stopped the 57014 cancellation, and then the SAME hook went on
     * failing about one run in two under the full suite and under `mutation-kill.ts`.
     * The failure shape is why it took a second pass to see: node:test reports a broken
     * HOOK as `not ok <n> - migration ledger integrity (FBL-020-R4 §0)` — the SUITE
     * line — while `# fail` counts only tests and therefore stays 0. So the run printed
     * a failure and the summary said zero failures. (`scripts/parse-test-summary.ts` no
     * longer accepts that combination; see gate finding G2.)
     *
     * Two windows were left open, and both are closed here rather than waited out:
     *
     *   1. TERMINATE-THEN-DROP CAN LOSE TO A CONNECTION IN FLIGHT. `pg_terminate_backend`
     *      and `DROP DATABASE … WITH (FORCE)` both act on backends ALREADY registered
     *      against the database. A `spawnSync` child whose backend is still being set up
     *      is not one of them, and it attaches immediately afterwards. `WITH (FORCE)`
     *      then waits its own fixed five seconds in `CountOtherDBBackends` and raises
     *      55006. Setting `ALLOW_CONNECTIONS false` FIRST shuts the door: after it, no
     *      new backend can attach at all, so terminating the ones that remain is final.
     *
     *   2. NOTHING WAITED FOR THE BACKENDS TO ACTUALLY GO. The drop was issued and hoped
     *      for. It is now issued only once the SERVER ITSELF reports no other backend on
     *      that database. That is a wait on the real precondition, not a retry of a
     *      failed statement, and when the precondition never arrives the error names the
     *      pids and what they were doing instead of failing blind.
     *
     * The `%TEMP%` directory is removed with `maxRetries`, for the third mechanism in
     * the same family: on Windows a child process's handles on the files it read are
     * released by the OS a moment AFTER the process exits, and `rmSync` without retries
     * raises EBUSY/EPERM into the hook. That is Node's documented remedy for exactly
     * this latency, it is bounded, and the directory's absence is asserted afterwards —
     * so it cannot degrade into ignoring a failure.
     */

    /** Waits until the server reports no other backend on `name`. */
    async function waitForNoBackends(client: Client, name: string): Promise<void> {
      const deadline = Date.now() + 30_000;
      for (;;) {
        await client.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
             WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [name],
        );
        const left = await client.query<{ pid: number; state: string | null; query: string }>(
          `SELECT pid, state, left(query, 60) AS query FROM pg_stat_activity
             WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [name],
        );
        if (left.rowCount === 0) return;
        if (Date.now() > deadline)
          throw new Error(
            `${name} still has ${left.rowCount} attached backend(s) 30s after ` +
              `ALLOW_CONNECTIONS was withdrawn and every pid was terminated: ` +
              JSON.stringify(left.rows),
          );
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }

    /** Removes `name` unconditionally, and proves it is gone before returning. */
    async function dropDatabase(name: string): Promise<void> {
      await maintenance(async (client) => {
        const exists = await client.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [name]);
        if (exists.rowCount !== 0) {
          // Shut the door BEFORE terminating, so nothing can walk back in behind us.
          await client.query(`ALTER DATABASE ${name} WITH ALLOW_CONNECTIONS false`);
          await waitForNoBackends(client, name);
        }
        await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
        const left = await client.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [name]);
        assert.equal(left.rowCount, 0, `${name} survived its forced drop`);
      });
    }

    /** Creates `name` from the pristine template, after making sure it does not exist. */
    async function createDatabase(name: string): Promise<void> {
      await dropDatabase(name);
      await maintenance(async (client) => {
        await client.query(`CREATE DATABASE ${name} TEMPLATE template0`);
      });
    }

    /**
     * Removes a directory a just-exited child process was reading, and PROVES it is gone.
     * `maxRetries` covers the Windows handle-release latency Node documents; the
     * assertion is what stops that becoming a licence to ignore a real failure.
     */
    function removeScratchDirectory(path: string): void {
      rmSync(path, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
      assert.ok(!existsSync(path), `${path} was not removed`);
    }

    before(async () => {
      const url = new URL(INTEGRATION_DATABASE_URL as string);
      url.pathname = `/${SCRATCH_DB}`;
      scratchUrl = url.toString();
      await createDatabase(SCRATCH_DB);
      dir = mkdtempSync(join(tmpdir(), 'fbl020-ledger-'));
      writeMigrations(ALPHA_LF, BETA_LF);
    });

    after(async () => {
      /*
       * THE DATABASE FIRST. `dir` is undefined if `before` threw before it was assigned,
       * and a teardown that died on the temp directory used to leave the scratch database
       * behind for the NEXT run to trip over — so the ordering is now the other way
       * round, and each step runs whatever the one before it did. Every failure is
       * collected and re-raised together: a hook that reports only the first thing that
       * went wrong is how the second cause stayed hidden through one correction.
       */
      const failures: string[] = [];
      try {
        await dropDatabase(SCRATCH_DB);
      } catch (err) {
        failures.push(`dropping ${SCRATCH_DB}: ${(err as Error).message}`);
      }
      try {
        if (dir !== undefined) removeScratchDirectory(dir);
      } catch (err) {
        failures.push(`removing ${dir ?? '<unset>'}: ${(err as Error).message}`);
      }
      try {
        await closePool();
      } catch (err) {
        failures.push(`closing the pool: ${(err as Error).message}`);
      }
      assert.deepEqual(failures, [], failures.join('\n'));
    });

    test('the recorded checksum is the CANONICAL-LF digest, identical on Windows and in CI', () => {
      const first = runMigrate();
      assert.equal(first.status, 0, `first run failed:\n${first.output}`);

      const rows = ledger();
      assert.deepEqual(
        rows.map((r) => r.filename),
        ['900_ledger_probe_alpha.sql', '901_ledger_probe_beta.sql'],
      );
      for (const row of rows) {
        assert.equal(row.algorithm, 'sha256-canonical-lf', 'the algorithm is recorded beside it');
      }

      // The digest of the file as COMMITTED (LF), not of the CRLF bytes on disk. The
      // second assertion is the one that matters: a raw hash of the working file would
      // differ, so recording it would make the ledger disagree with itself across
      // platforms and be useless as a control.
      const onDisk = readFileSync(join(dir, '900_ledger_probe_alpha.sql'), 'utf8');
      assert.ok(onDisk.includes('\r\n'), 'the fixture really is CRLF on disk');
      assert.equal(rows[0]?.checksum, canonicalDigest(ALPHA_LF));
      assert.notEqual(
        rows[0]?.checksum,
        createHash('sha256').update(onDisk, 'utf8').digest('hex'),
        'the raw CRLF digest is NOT what is recorded',
      );

      // Re-running unchanged is still a no-op: verification does not re-apply anything.
      const second = runMigrate();
      assert.equal(second.status, 0, `second run failed:\n${second.output}`);
      assert.match(second.output, /"applied":0/);
    });

    test('a CHANGED body of an applied migration REFUSES the run, names the file and both digests', () => {
      // 900 is already applied. Its body is now edited — the exact scenario the old
      // ledger could not see, because it matched on filename alone.
      const changed = PROBE_BODIES.alphaDrifted;
      writeFileSync(join(dir, '900_ledger_probe_alpha.sql'), toCrlf(changed), 'utf8');
      // …and a genuinely new migration is queued behind it, so "nothing was applied"
      // is observable rather than asserted.
      writeFileSync(join(dir, '902_ledger_probe_gamma.sql'), toCrlf(PROBE_BODIES.gamma), 'utf8');

      const run = runMigrate();
      assert.equal(run.status, 1, `the runner must refuse to proceed:\n${run.output}`);
      assert.match(run.output, /integrity check FAILED/i);
      assert.match(run.output, /900_ledger_probe_alpha\.sql/, 'the filename is reported');
      assert.match(run.output, new RegExp(canonicalDigest(ALPHA_LF)), 'the RECORDED digest');
      assert.match(run.output, new RegExp(canonicalDigest(changed)), 'the COMPUTED digest');

      // NO auto-repair: the recorded checksum still describes the body that ran.
      const rows = ledger();
      assert.equal(rows[0]?.checksum, canonicalDigest(ALPHA_LF));
      // NO partial progress: the queued migration behind the drift was not applied.
      assert.deepEqual(
        rows.map((r) => r.filename),
        ['900_ledger_probe_alpha.sql', '901_ledger_probe_beta.sql'],
      );
      const gamma = scratchExec(`SELECT 1 FROM ledger_probe_gamma`);
      assert.equal(gamma.status, 1, 'the pending migration must NOT have been applied');
      assert.match(gamma.output, /ledger_probe_gamma/);

      // Restoring the body restores the run — the refusal tracks the body, not a latch.
      writeFileSync(join(dir, '900_ledger_probe_alpha.sql'), toCrlf(ALPHA_LF), 'utf8');
      const after_ = runMigrate();
      assert.equal(after_.status, 0, `restored body must apply cleanly:\n${after_.output}`);
      assert.equal(ledger().length, 3, 'and the queued migration then lands');
      rmSync(join(dir, '902_ledger_probe_gamma.sql'), { force: true });
      const cleanup = scratchExec(`DROP TABLE ledger_probe_gamma`);
      assert.equal(cleanup.status, 0, cleanup.output);
      const forget = scratchExec(
        `DELETE FROM schema_migrations WHERE filename = '902_ledger_probe_gamma.sql'`,
      );
      assert.equal(forget.status, 0, forget.output);
    });

    test('a row with NO recorded checksum REFUSES the run, and no checksum is invented for it', () => {
      /*
       * FBL-020-R5 §0.3. This test previously asserted the OPPOSITE — `status === 0`, on the
       * reasoning that "an unverifiable row must not brick the runner". That was the defect:
       * a warning nobody reads, followed by applying further migrations on top of a schema
       * nobody can describe. The row below is exactly the shape the pre-checksum runner left
       * behind, and the runner must now stop.
       */
      const blank = scratchExec(
        `UPDATE schema_migrations SET checksum_sha256 = NULL, checksum_algorithm = NULL
          WHERE filename = '901_ledger_probe_beta.sql'`,
      );
      assert.equal(blank.status, 0, blank.output);

      // …and a genuinely new migration is queued behind it, so "nothing was applied" is
      // OBSERVABLE rather than merely asserted.
      writeFileSync(join(dir, '902_ledger_probe_gamma.sql'), toCrlf(PROBE_BODIES.gamma), 'utf8');

      const run = runMigrate();
      assert.equal(run.status, 1, `an unverifiable row must REFUSE the run:\n${run.output}`);
      assert.match(run.output, /unverifiable-checksum/, 'the refusal names the condition');
      assert.match(run.output, /901_ledger_probe_beta\.sql/, 'and the file');

      const row = ledger().find((r) => r.filename === '901_ledger_probe_beta.sql');
      // THE HONEST REPRESENTATION: still NULL. Hashing the file as it sits today would
      // assert "this is the body that was applied" — the one claim that cannot be proven for
      // such a row, and the way a changed body would be laundered into a verified one.
      // Refusing is not repairing.
      assert.equal(row?.checksum, null);
      assert.equal(row?.algorithm, null);
      assert.equal(
        scratchExec(`SELECT 1 FROM ledger_probe_gamma`).status,
        1,
        'the queued migration must NOT have been applied',
      );

      const restore = scratchExec(
        `UPDATE schema_migrations
            SET checksum_sha256 = '${canonicalDigest(BETA_LF)}',
                checksum_algorithm = 'sha256-canonical-lf'
          WHERE filename = '901_ledger_probe_beta.sql'`,
      );
      assert.equal(restore.status, 0, restore.output);

      // Restored, the queued migration lands: the refusal tracks the condition, not a latch.
      const after_ = runMigrate();
      assert.equal(after_.status, 0, `a verifiable ledger must apply cleanly:\n${after_.output}`);
      rmSync(join(dir, '902_ledger_probe_gamma.sql'), { force: true });
      assert.equal(scratchExec(`DROP TABLE ledger_probe_gamma`).status, 0);
      assert.equal(
        scratchExec(`DELETE FROM schema_migrations WHERE filename = '902_ledger_probe_gamma.sql'`)
          .status,
        0,
      );
    });

    test('a ledger row whose migration BODY is nowhere available REFUSES the run', () => {
      /*
       * The third condition R4 only warned about. `MIGRATIONS_DIR` is legitimately restricted
       * by the CI upgrade job, so the old runner treated "the ledger names a file I cannot
       * find" as unremarkable and carried on — which meant an environment whose ledger
       * referenced a migration nobody could produce stayed unverifiable across every run, for
       * ever, with one line of log to show for it.
       *
       * The body is resolved from the restricted directory FIRST and `migrations/` SECOND, so
       * a fixture that WITHHOLDS a real migration does not trigger this; only a name that
       * exists in neither does. Both halves are asserted here, because "restricting what is
       * applied must not reduce what is verified" is the property that makes the fixture mode
       * safe, and it is worth nothing if only one direction is checked.
       */
      const orphan = scratchExec(
        `INSERT INTO schema_migrations (filename, checksum_sha256, checksum_algorithm)
         VALUES ('903_ledger_probe_vanished.sql', '${'b'.repeat(64)}', 'sha256-canonical-lf')`,
      );
      assert.equal(orphan.status, 0, orphan.output);

      const run = runMigrate();
      assert.equal(run.status, 1, `a missing body must REFUSE the run:\n${run.output}`);
      assert.match(run.output, /missing-body/);
      assert.match(run.output, /903_ledger_probe_vanished\.sql/);
      assert.equal(
        scratchExec(
          `DELETE FROM schema_migrations WHERE filename = '903_ledger_probe_vanished.sql'`,
        ).status,
        0,
      );

      // A row naming a REAL migration this restricted directory does not carry: verified
      // against migrations/, so no refusal.
      const real = readFileSync(
        join(__dirname, '..', 'migrations', '000_platform_core.sql'),
        'utf8',
      );
      assert.equal(
        scratchExec(
          `INSERT INTO schema_migrations (filename, checksum_sha256, checksum_algorithm)
           VALUES ('000_platform_core.sql', '${canonicalDigest(real)}', 'sha256-canonical-lf')`,
        ).status,
        0,
      );
      const tolerated = runMigrate();
      assert.equal(
        tolerated.status,
        0,
        `a withheld-but-real migration must verify from migrations/:\n${tolerated.output}`,
      );
      assert.doesNotMatch(tolerated.output, /missing-body/);

      // …and if its recorded digest does NOT match the repository's copy, that IS a refusal.
      // This is what proves the fallback VERIFIES rather than merely resolves.
      assert.equal(
        scratchExec(
          `UPDATE schema_migrations SET checksum_sha256 = '${'c'.repeat(64)}'
            WHERE filename = '000_platform_core.sql'`,
        ).status,
        0,
      );
      const drifted = runMigrate();
      assert.equal(drifted.status, 1, drifted.output);
      assert.match(drifted.output, /checksum-drift/);
      assert.match(drifted.output, /000_platform_core\.sql/);
      assert.equal(
        scratchExec(`DELETE FROM schema_migrations WHERE filename = '000_platform_core.sql'`)
          .status,
        0,
      );
      assert.equal(runMigrate().status, 0, 'and the probe chain is clean again');
    });

    test('an unsupported checksum ALGORITHM refuses, because it cannot be recomputed', () => {
      assert.equal(
        scratchExec(
          `UPDATE schema_migrations SET checksum_algorithm = 'md5-something'
            WHERE filename = '901_ledger_probe_beta.sql'`,
        ).status,
        0,
      );
      const run = runMigrate();
      assert.equal(run.status, 1, run.output);
      assert.match(run.output, /unsupported-algorithm/);
      assert.equal(
        scratchExec(
          `UPDATE schema_migrations SET checksum_algorithm = 'sha256-canonical-lf'
            WHERE filename = '901_ledger_probe_beta.sql'`,
        ).status,
        0,
      );
      assert.equal(runMigrate().status, 0);
    });

    test('the runner REFUSES a migrations directory that no declared chain admits', () => {
      // The §1.4 opt-in, driven through a real process. Without a chain name the redirection
      // is refused; with an undeclared name it is refused; and a file the chain does not
      // declare is refused even under the right chain name.
      const unnamed = runMigrate({ [FIXTURE_CHAIN_ENV]: '' });
      assert.equal(unnamed.status, 1, unnamed.output);
      assert.match(unnamed.output, /fixture-chain check FAILED/i);

      const unknown = runMigrate({ [FIXTURE_CHAIN_ENV]: 'no-such-chain' });
      assert.equal(unknown.status, 1, unknown.output);
      assert.match(unknown.output, /not a declared migration fixture chain/);

      writeFileSync(join(dir, '058_pretend_migration.sql'), 'SELECT 1;\n', 'utf8');
      const intruder = runMigrate();
      assert.equal(intruder.status, 1, intruder.output);
      assert.match(intruder.output, /does not declare it/);
      rmSync(join(dir, '058_pretend_migration.sql'), { force: true });

      assert.equal(runMigrate().status, 0, 'and the admitted chain still runs');
    });

    test('the RUNNER refuses an undeclared body written to a DECLARED probe filename', () => {
      /*
       * FBL-020-R6 §1.4, through the real process rather than through `validateChainDirectory`
       * alone. Until R6 this chain admitted its files by FILENAME, so any body at all could be
       * written to `902_ledger_probe_gamma.sql` and the runner would apply it. The name is now
       * only half the admission: the body must hash to a digest the chain declares.
       */
      writeFileSync(
        join(dir, '902_ledger_probe_gamma.sql'),
        toCrlf('CREATE TABLE ledger_probe_smuggled (id integer PRIMARY KEY);\n'),
        'utf8',
      );
      const smuggled = runMigrate();
      assert.equal(
        smuggled.status,
        1,
        `an undeclared body must REFUSE the run:\n${smuggled.output}`,
      );
      assert.match(smuggled.output, /is not an admitted variant of this file/);
      assert.match(smuggled.output, /902_ledger_probe_gamma\.sql/);
      assert.equal(
        scratchExec(`SELECT 1 FROM ledger_probe_smuggled`).status,
        1,
        'and nothing it declared was created',
      );

      // The DECLARED body under the same filename is admitted, so what was refused is the
      // body and not the name.
      writeFileSync(join(dir, '902_ledger_probe_gamma.sql'), toCrlf(PROBE_BODIES.gamma), 'utf8');
      const declared = runMigrate();
      assert.equal(declared.status, 0, `the declared body must apply:\n${declared.output}`);
      assert.equal(scratchExec(`SELECT 1 FROM ledger_probe_gamma`).status, 0);

      rmSync(join(dir, '902_ledger_probe_gamma.sql'), { force: true });
      assert.equal(scratchExec(`DROP TABLE ledger_probe_gamma`).status, 0);
      assert.equal(
        scratchExec(`DELETE FROM schema_migrations WHERE filename = '902_ledger_probe_gamma.sql'`)
          .status,
        0,
      );
      assert.equal(runMigrate().status, 0, 'and the probe chain is clean again');
    });

    test('the ledger refuses a malformed digest and a digest with no algorithm', () => {
      const badShape = scratchExec(
        `INSERT INTO schema_migrations (filename, checksum_sha256, checksum_algorithm)
         VALUES ('999_probe.sql', 'not-a-digest', 'sha256-canonical-lf')`,
      );
      assert.equal(badShape.status, 1, badShape.output);
      assert.match(badShape.output, /schema_migrations_checksum_shape/);

      const unpaired = scratchExec(
        `INSERT INTO schema_migrations (filename, checksum_sha256)
         VALUES ('999_probe.sql', '${'a'.repeat(64)}')`,
      );
      assert.equal(unpaired.status, 1, unpaired.output);
      assert.match(unpaired.output, /schema_migrations_checksum_paired/);
    });

    test('every migration in this repository is recorded under its committed canonical digest', async () => {
      // The real ledger of the real test database, against the real migrations/ files:
      // if the runner ever recorded a platform-dependent digest, this fails on one OS
      // and passes on the other, which is precisely the failure mode being excluded.
      const rows = (
        await query(
          `SELECT filename, checksum_sha256, checksum_algorithm FROM schema_migrations ORDER BY filename`,
        )
      ).rows as Array<{
        filename: string;
        checksum_sha256: string | null;
        checksum_algorithm: string | null;
      }>;
      assert.ok(rows.length >= 10, `expected the full chain, saw ${rows.length}`);
      const root = join(__dirname, '..', 'migrations');
      for (const row of rows) {
        assert.equal(
          row.checksum_algorithm,
          'sha256-canonical-lf',
          `${row.filename} carries no algorithm — re-create the test database with the ` +
            'current runner (a NULL here means it was migrated by the pre-checksum runner)',
        );
        assert.equal(
          row.checksum_sha256,
          canonicalDigest(readFileSync(join(root, row.filename), 'utf8')),
          `${row.filename} does not match its recorded checksum`,
        );
      }
      // An anchor the FBL-020-R4 census itself published: the canonical-LF digest of
      // migration 057's R3 body. It is asserted as a KNOWN-LENGTH hex digest rather
      // than a fixed value because 057 is corrected by this very order — the shape is
      // the invariant, the value moves with the file.
      assert.match(
        canonicalDigest(readFileSync(join(root, '057_identity_boundary_completion.sql'), 'utf8')),
        /^[0-9a-f]{64}$/,
      );
    });

    test('the scratch-database teardown survives a session that is still attached', async () => {
      /*
       * THE MUTATION-PROOF FOR THE HOOK CORRECTION ABOVE. The condition the hooks kept
       * losing to — a probe's backend still attached when the teardown runs — is created
       * deliberately here rather than waited for, so both halves are deterministic:
       * the statement the hooks USED to run fails in this state, and the statement they
       * run now does not. A retry or a longer timeout would leave the first assertion
       * failing; only removing the dependence on the attached session satisfies both.
       *
       * A database of its own, so nothing here can disturb the ledger probe database the
       * surrounding battery is using.
       */
      const DROP_PROBE_DB = 'dealership_test_ledger_drop_probe';
      await createDatabase(DROP_PROBE_DB);

      const url = new URL(INTEGRATION_DATABASE_URL as string);
      url.pathname = `/${DROP_PROBE_DB}`;
      const attached = new Client({ connectionString: url.toString() });
      // The whole point of the corrected teardown is that it TERMINATES this session, so
      // this client WILL see `57P01`/ECONNRESET. Without a listener that arrives as an
      // unhandled 'error' event after the test has returned, which node:test reports as
      // asynchronous activity and fails the run — a second, self-inflicted flake.
      const terminations: string[] = [];
      attached.on('error', (err: Error) => terminations.push(err.message));
      await attached.connect();
      try {
        await attached.query('SELECT 1');

        // (a) The OLD hook statement, verbatim, on the suite's pool. It cannot succeed
        // while a session is attached, which is precisely why the hooks were flaky.
        let naive: { code?: string; message?: string } | undefined;
        try {
          await query(`DROP DATABASE IF EXISTS ${DROP_PROBE_DB}`);
        } catch (err) {
          naive = err as { code?: string; message?: string };
        }
        assert.ok(
          naive !== undefined,
          'the un-forced drop must NOT succeed while a session is attached — if it does, ' +
            'this test no longer proves anything about the flake it was written for',
        );
        assert.ok(
          // 55006 objects_in_use is the fail-fast form; 57014 is the same wait cancelled
          // by the pool's statement timeout, which is how it surfaced in the gate logs.
          naive.code === '55006' || naive.code === '57014',
          `expected 55006 or 57014, saw ${naive.code}: ${naive.message}`,
        );

        // (b) The CORRECTED teardown, in the same state. It terminates the attached
        // session, drops the database and proves it is gone.
        await dropDatabase(DROP_PROBE_DB);
        const gone = await query(`SELECT 1 FROM pg_database WHERE datname = $1`, [DROP_PROBE_DB]);
        assert.equal(gone.rowCount, 0, 'the forced teardown removed the database');

        // Settle this client inside the test rather than leaving its termination to
        // arrive afterwards, and assert that it really was the one terminated.
        await attached.end().catch(() => undefined);
        assert.ok(
          terminations.some((m) => /terminat|ECONNRESET|Connection terminated/i.test(m)),
          `the attached session was terminated by the teardown; saw ${JSON.stringify(terminations)}`,
        );
      } finally {
        await attached.end().catch(() => undefined);
        await dropDatabase(DROP_PROBE_DB);
      }
    });
  },
);

/**
 * FBL-020-R5 §0.3 and §0.4 as PURE LOGIC.
 *
 * The battery above drives the real runner against a real database, which is the only way to
 * prove what the RUNNER does. These tests drive the same decision functions directly, so
 * every branch is exercised — including the ones a green run never reaches — without needing
 * a database to be present.
 */
describe('the migration fixture-chain admission rules (FBL-020-R6 §1.4)', () => {
  const CANONICAL = join(__dirname, '..', 'migrations');
  const chains = loadFixtureChains();

  /** Stages a directory, runs `work` against it, and removes it whatever happens. */
  function staged(work: (dir: string) => void): void {
    const dir = mkdtempSync(join(tmpdir(), 'fbl020-chain-'));
    try {
      work(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  }

  /** Copies `migrations/` into `dir`, which is what both mutating chains start from. */
  function copyMigrations(dir: string): void {
    for (const f of readdirSync(CANONICAL).filter((x) => x.endsWith('.sql')))
      writeFileSync(join(dir, f), readFileSync(join(CANONICAL, f)));
  }

  test('a non-canonical directory with no chain named is REFUSED', () => {
    const decision = decideMode('/tmp/somewhere', CANONICAL, undefined, () => chains);
    assert.equal(decision.mode, 'fixture');
    assert.ok(
      decision.problems.some((p) => p.includes('must be opted into by name')),
      decision.problems.join('; '),
    );
    // …and the message lists what IS declared, so an operator is not left guessing.
    assert.ok(decision.problems.some((p) => p.includes('schema-f76a27a')));
  });

  test('the canonical directory with a chain named is REFUSED, not silently obeyed', () => {
    // Fixture behavior against the real migrations directory is never what anybody wants,
    // and picking one of the two intentions would be guessing at a production run.
    const decision = decideMode(CANONICAL, CANONICAL, 'pre-057', () => chains);
    assert.equal(decision.mode, 'production');
    assert.ok(
      decision.problems.some((p) => p.includes('pointed at')),
      decision.problems.join('; '),
    );
  });

  test('the canonical directory with no chain is production mode, with nothing to complain about', () => {
    const decision = decideMode(CANONICAL, CANONICAL, undefined, () => chains);
    assert.equal(decision.mode, 'production');
    assert.deepEqual(decision.problems, []);
    // Separator and case must not decide the answer: the same directory named differently
    // is still the same directory, or a Windows caller would land in fixture mode.
    assert.deepEqual(
      decideMode(CANONICAL.split('\\').join('/'), CANONICAL, undefined, () => chains).problems,
      [],
    );
  });

  test('production mode NEVER READS the chain allowlist, so the container can migrate without it', () => {
    /*
     * The deployed image ships `migrations/` and `scripts/dist/` and NOT `architecture/`.
     * An earlier draft of `decideMode` loaded the allowlist as a default parameter, which is
     * evaluated on EVERY call — so `node scripts/dist/migrate.js` in the container would have
     * died on a missing file before looking at a single migration, and nothing in the suite
     * or in CI would have noticed, because both run from a full checkout.
     *
     * The loader is a thunk that throws here. If the production path reads it, this fails.
     */
    const explode = (): Record<string, never> => {
      throw new Error('the allowlist must NOT be read in production mode');
    };
    const decision = decideMode(CANONICAL, CANONICAL, undefined, explode);
    assert.equal(decision.mode, 'production');
    assert.deepEqual(decision.problems, []);

    // …and every path that IS a fixture path must read it, or the check above would pass
    // simply because nothing ever loads the allowlist at all.
    assert.throws(
      () => decideMode('/tmp/elsewhere', CANONICAL, 'pre-057', explode),
      /must NOT be read/,
    );
    assert.throws(
      () => decideMode('/tmp/elsewhere', CANONICAL, undefined, explode),
      /must NOT be read/,
    );
    assert.throws(() => decideMode(CANONICAL, CANONICAL, 'pre-057', explode), /must NOT be read/);
  });

  test('every declared chain matches its committed digests exactly, today', () => {
    // The `pre-057` chain must equal migrations/ WITHHOLDING 057 AND EVERYTHING AFTER IT,
    // and `schema-f76a27a` must equal the retained fixture. If a pinned digest and the file
    // it pins ever part company, the CI upgrade job stops working — and it should stop,
    // loudly, here.
    //
    // FBL-020-R6 §3: the staging rule is stated by NUMBER, not by naming one file. It used
    // to be "everything except 057", which was the same set only while 057 was the last
    // migration; with `058` on disk that form would have staged a POST-057 file into a
    // directory meant to hold the schema as it stood BEFORE 057 — and the chain, correctly,
    // refuses a file it does not declare. The CI job's staging step carries the same rule.
    const f76 = validateChainDirectory(
      'schema-f76a27a',
      join(__dirname, 'fixtures', 'schema-f76a27a'),
      chains,
    );
    assert.deepEqual(f76.problems, [], f76.problems.join('\n'));

    staged((dir) => {
      for (const f of readdirSync(CANONICAL).filter((x) => x.endsWith('.sql')))
        if (Number(f.slice(0, 3)) < 57)
          writeFileSync(join(dir, f), readFileSync(join(CANONICAL, f)));
      const pre = validateChainDirectory('pre-057', dir, chains);
      assert.deepEqual(pre.problems, [], pre.problems.join('\n'));

      // An EXTRA file is refused — this is the case that would let an unreviewed migration
      // ride along inside a directory the chain otherwise admits.
      writeFileSync(join(dir, '999_unreviewed.sql'), 'SELECT 1;\n', 'utf8');
      const intruder = validateChainDirectory('pre-057', dir, chains);
      assert.ok(
        intruder.problems.some(
          (p) => p.includes('999_unreviewed.sql') && p.includes('does not declare it'),
        ),
        intruder.problems.join('; '),
      );
      rmSync(join(dir, '999_unreviewed.sql'), { force: true });

      // A CHANGED body is refused, and the message says the digest is not a new baseline.
      writeFileSync(join(dir, '055_identity_organization.sql'), 'SELECT 1;\n', 'utf8');
      const changed = validateChainDirectory('pre-057', dir, chains);
      assert.ok(
        changed.problems.some(
          (p) =>
            p.includes('055_identity_organization.sql') &&
            p.includes('is not an admitted variant of this file'),
        ),
        changed.problems.join('; '),
      );

      // A MISSING required file is refused too.
      rmSync(join(dir, '055_identity_organization.sql'), { force: true });
      const missing = validateChainDirectory('pre-057', dir, chains);
      assert.ok(
        missing.problems.some(
          (p) =>
            p.includes('055_identity_organization.sql') &&
            p.includes('declared REQUIRED by the chain but is not present'),
        ),
        missing.problems.join('; '),
      );
    });
  });

  /*
   * ── FBL-020-R6 §1.4: THE TWO WITHDRAWN ADMISSION RULES ─────────────────────────
   *
   * R5 admitted the ledger-probe fixtures by FILENAME and the negative-control 057 by a
   * COMPUTED RULE about deletions. Both are gone. The four tests below are the proof that
   * they are gone rather than merely renamed: one for each withdrawn rule at the data
   * layer, one for each at the admission layer.
   */

  test('a fixture admitted only by its FILENAME is REFUSED', () => {
    /*
     * The exact R5 behaviour, driven at the file the rule used to cover. `ledger-probe`
     * declared `filename_pattern` and a list of names and NO digests, so any body at all was
     * admitted under `900_ledger_probe_alpha.sql`. It now carries two digests — the probe
     * body and the drifted body the changed-body refusal is fired with — and a third body is
     * refused however plausible its name.
     */
    staged((dir) => {
      writeFileSync(join(dir, '900_ledger_probe_alpha.sql'), PROBE_BODIES.alpha, 'utf8');
      writeFileSync(join(dir, '901_ledger_probe_beta.sql'), PROBE_BODIES.beta, 'utf8');
      const admitted = validateChainDirectory('ledger-probe', dir, chains);
      assert.deepEqual(admitted.problems, [], admitted.problems.join('\n'));

      // The name stays right; only the BODY changes. Under the withdrawn rule this passed.
      const undeclared =
        'CREATE TABLE ledger_probe_alpha (id integer PRIMARY KEY, smuggled text);\n';
      writeFileSync(join(dir, '900_ledger_probe_alpha.sql'), undeclared, 'utf8');
      const refused = validateChainDirectory('ledger-probe', dir, chains);
      assert.ok(
        refused.problems.some(
          (p) =>
            p.includes('900_ledger_probe_alpha.sql') &&
            p.includes('is not an admitted variant of this file') &&
            p.includes(chainDigest(undeclared)),
        ),
        `a body admitted only by its filename must be refused: ${refused.problems.join('; ')}`,
      );
      assert.equal(refused.ok, false);

      // And the DRIFTED body, which the refusal battery needs, IS declared — so what was
      // refused above is the undeclared body and not the act of changing one.
      writeFileSync(join(dir, '900_ledger_probe_alpha.sql'), PROBE_BODIES.alphaDrifted, 'utf8');
      assert.deepEqual(validateChainDirectory('ledger-probe', dir, chains).problems, []);
    });
  });

  test('the allowlist REFUSES a chain that declares a filename with no checksum', () => {
    /*
     * The data-layer half of the same removal. A chain may not come back to filename-only
     * admission by declaring a file with an empty variant list, and it may not carry the
     * withdrawn rules' keys at all — `loadFixtureChains` throws before any directory is
     * compared against anything.
     */
    const dir = mkdtempSync(join(tmpdir(), 'fbl020-allowlist-'));
    try {
      const nameOnly = join(dir, 'name-only.json');
      writeFileSync(
        nameOnly,
        JSON.stringify({
          chains: {
            probe: { reason: 'x', files: { '900_p.sql': { required: true, variants: [] } } },
          },
        }),
        'utf8',
      );
      assert.throws(
        () => loadFixtureChains(nameOnly),
        /FILENAME-ONLY ADMISSION/,
        'a filename with no digest must be refused at load',
      );

      for (const key of WITHDRAWN_CHAIN_KEYS) {
        const withdrawn = join(dir, `withdrawn-${key}.json`);
        writeFileSync(
          withdrawn,
          JSON.stringify({
            chains: {
              probe: {
                reason: 'x',
                [key]: 'anything',
                files: {
                  '900_p.sql': {
                    required: true,
                    variants: [{ sha256: 'a'.repeat(64), note: 'n' }],
                  },
                },
              },
            },
          }),
          'utf8',
        );
        assert.throws(
          () => loadFixtureChains(withdrawn),
          new RegExp(`declares '${key}', which belonged to an admission rule`),
          `${key} must not be loadable`,
        );
      }

      // The shipped allowlist itself loads, so the checks above are not simply refusing
      // everything.
      assert.ok(Object.keys(loadFixtureChains(FIXTURE_CHAINS_FILE)).length > 0);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });

  test('every negative-control deletion variant is declared by the digest the harness produces', () => {
    /*
     * The allowlist and the harness must agree, and the agreement is COMPUTED rather than
     * asserted by hand: each control's mutated body is regenerated here from the committed
     * anchors and canonical 057, and its digest must be one the chain declares for that file.
     * If 057 is corrected, or an anchor moves, twelve digests change and this fails — which
     * is the point. The harness must refuse rather than run a mutation nobody declared.
     */
    const entry = chains['negative-control-057']?.files['057_identity_boundary_completion.sql'];
    assert.ok(entry !== undefined, 'the chain must declare the file it mutates');
    if (entry === undefined) return;

    const anchors = loadAnchors();
    const base = canonical057();
    const produced = CONTROLS.map((control) => {
      const anchor = anchors[control.id];
      assert.ok(anchor !== undefined, `no anchor for ${control.id}`);
      return {
        id: control.id,
        sha256: chainDigest(removeStatement(base, control, anchor as ControlAnchor)),
      };
    });

    assert.equal(produced.length, 12, 'twelve controls, twelve declared variants');
    for (const { id, sha256 } of produced)
      assert.ok(
        entry.variants.some((v) => v.sha256 === sha256 && v.note.includes(id)),
        `the chain declares no variant ${sha256} noted for ${id}`,
      );
    assert.deepEqual(
      [...entry.variants].map((v) => v.sha256).sort(),
      produced.map((p) => p.sha256).sort(),
      'the chain declares exactly the twelve bodies the harness produces, and no others',
    );
  });

  test('an UNLISTED deletion variant is REFUSED', () => {
    /*
     * The rule R6 §1.4 withdrew admitted ANY body reachable from 057 by deleting one
     * contiguous span holding one `;` — a large set whose membership was computed, not
     * reviewed. The three bodies below are all in that set or beside it, none is one of the
     * twelve, and all three are now refused:
     *
     *   1. a single-statement deletion nobody declared — the case the withdrawn rule ADMITTED;
     *   2. the unmutated canonical 057 — no control produces it;
     *   3. a two-statement deletion — refused under both rules, kept so the test cannot pass
     *      merely because the new rule refuses everything.
     */
    const text = canonical057();

    staged((dir) => {
      copyMigrations(dir);
      const first = text.indexOf(';');
      const undeclaredOneStatement = text.slice(0, first) + text.slice(first + 1);
      writeFileSync(
        join(dir, '057_identity_boundary_completion.sql'),
        undeclaredOneStatement,
        'utf8',
      );
      const one = validateChainDirectory('negative-control-057', dir, chains);
      assert.ok(
        one.problems.some(
          (p) =>
            p.includes('057_identity_boundary_completion.sql') &&
            p.includes('is not an admitted variant of this file') &&
            p.includes(chainDigest(undeclaredOneStatement)),
        ),
        `an undeclared one-statement deletion must be refused: ${one.problems.join('; ')}`,
      );
    });

    staged((dir) => {
      copyMigrations(dir);
      const unmutated = validateChainDirectory('negative-control-057', dir, chains);
      assert.ok(
        unmutated.problems.some(
          (p) =>
            p.includes('057_identity_boundary_completion.sql') &&
            p.includes(
              chainDigest(readFileSync(join(CANONICAL, '057_identity_boundary_completion.sql'))),
            ),
        ),
        `the unmutated 057 is not a control's body and must be refused: ${unmutated.problems.join('; ')}`,
      );
    });

    staged((dir) => {
      copyMigrations(dir);
      const first = text.indexOf(';');
      const second = text.indexOf(';', first + 1);
      writeFileSync(
        join(dir, '057_identity_boundary_completion.sql'),
        text.slice(0, first) + text.slice(second + 1),
        'utf8',
      );
      const twoGone = validateChainDirectory('negative-control-057', dir, chains);
      assert.ok(
        twoGone.problems.some((p) => p.includes('is not an admitted variant of this file')),
        twoGone.problems.join('; '),
      );
    });

    // …and a body that IS one of the twelve is admitted, so the chain is not simply closed.
    staged((dir) => {
      copyMigrations(dir);
      const control = CONTROLS[0] as (typeof CONTROLS)[number];
      const anchor = loadAnchors()[control.id];
      assert.ok(anchor !== undefined);
      writeFileSync(
        join(dir, '057_identity_boundary_completion.sql'),
        removeStatement(text, control, anchor as ControlAnchor),
        'utf8',
      );
      const declared = validateChainDirectory('negative-control-057', dir, chains);
      assert.deepEqual(declared.problems, [], declared.problems.join('\n'));
    });
  });

  test('every ledger-probe body the battery writes is declared under the filename it occupies', () => {
    // The bodies live at module scope and the allowlist pins their digests; nothing but this
    // comparison keeps the two in step, so a probe body that is edited without the allowlist
    // being updated fails here rather than in the integration battery.
    const chain = chains['ledger-probe'];
    assert.ok(chain !== undefined);
    if (chain === undefined) return;
    for (const [key, body] of Object.entries(PROBE_BODIES)) {
      const filename = PROBE_FILENAMES[key as keyof typeof PROBE_BODIES];
      const entry = chain.files[filename];
      assert.ok(entry !== undefined, `${filename} is not declared by the ledger-probe chain`);
      assert.ok(
        entry?.variants.some((v) => v.sha256 === chainDigest(body)),
        `the body written as ${key} (${chainDigest(body)}) is not a declared variant of ${filename}`,
      );
    }
  });
});

describe('the migration ledger refusal rules (FBL-020-R5 §0.3)', () => {
  const body = 'CREATE TABLE t (id integer);\n';
  const good = createHash('sha256').update(body, 'utf8').digest('hex');
  const resolve = (name: string): string | undefined => (name === 'a.sql' ? body : undefined);

  test('a verifiable ledger produces NO refusals', () => {
    assert.deepEqual(
      ledgerRefusals(
        [{ filename: 'a.sql', checksum_sha256: good, checksum_algorithm: 'sha256-canonical-lf' }],
        resolve,
      ),
      [],
    );
  });

  test('each of the four untrustworthy shapes produces its OWN refusal kind', () => {
    // The kinds are distinguished because the REMEDIES are different: a missing body needs a
    // different tree, an unverifiable row needs an operator decision, and drift needs the
    // body restored or the change accepted. A single "ledger bad" would tell nobody which.
    const kinds = (rows: Parameters<typeof ledgerRefusals>[0]): string[] =>
      ledgerRefusals(rows, resolve).map((r) => r.kind);

    assert.deepEqual(
      kinds([
        { filename: 'gone.sql', checksum_sha256: good, checksum_algorithm: 'sha256-canonical-lf' },
      ]),
      ['missing-body'],
    );
    assert.deepEqual(
      kinds([{ filename: 'a.sql', checksum_sha256: null, checksum_algorithm: null }]),
      ['unverifiable-checksum'],
    );
    assert.deepEqual(
      kinds([{ filename: 'a.sql', checksum_sha256: good, checksum_algorithm: 'md5' }]),
      ['unsupported-algorithm'],
    );
    assert.deepEqual(
      kinds([
        {
          filename: 'a.sql',
          checksum_sha256: 'd'.repeat(64),
          checksum_algorithm: 'sha256-canonical-lf',
        },
      ]),
      ['checksum-drift'],
    );
  });

  test('EVERY offending row is reported, not just the first', () => {
    // An operator repairing a legacy ledger needs the whole list; stopping at the first row
    // turns one fix-and-rerun cycle into as many cycles as there are bad rows.
    const refusals = ledgerRefusals(
      [
        { filename: 'a.sql', checksum_sha256: null, checksum_algorithm: null },
        { filename: 'gone.sql', checksum_sha256: good, checksum_algorithm: 'sha256-canonical-lf' },
      ],
      resolve,
    );
    assert.equal(refusals.length, 2);
    assert.deepEqual(refusals.map((r) => r.filename).sort(), ['a.sql', 'gone.sql']);
  });
});
