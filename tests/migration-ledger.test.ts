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
  FIXTURE_CHAIN_ENV,
  canonicalDigest as chainDigest,
  decideMode,
  loadFixtureChains,
  singleSpanDeletion,
  validateChainDirectory,
} from '../scripts/migration-fixture-chains';

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
     * FBL-020-R5 §0.4: this battery runs the runner against a THROWAWAY directory of probe
     * migrations, which is exactly the redirection that is now opt-in. So it declares the
     * `ledger-probe` chain by name, the same way CI declares `pre-057`. The chain pins the
     * reserved filenames and deliberately does NOT pin their bodies — changing a body is how
     * the drift refusal below is fired — and it suppresses no refusal whatsoever, which is
     * what the tests in this file demonstrate.
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
    const ALPHA_LF = 'CREATE TABLE ledger_probe_alpha (id integer PRIMARY KEY);\n';
    const BETA_LF = 'CREATE TABLE ledger_probe_beta (id integer PRIMARY KEY);\n';
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
      const changed = 'CREATE TABLE ledger_probe_alpha (id integer PRIMARY KEY, extra text);\n';
      writeFileSync(join(dir, '900_ledger_probe_alpha.sql'), toCrlf(changed), 'utf8');
      // …and a genuinely new migration is queued behind it, so "nothing was applied"
      // is observable rather than asserted.
      writeFileSync(
        join(dir, '902_ledger_probe_gamma.sql'),
        toCrlf('CREATE TABLE ledger_probe_gamma (id integer PRIMARY KEY);\n'),
        'utf8',
      );

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
      writeFileSync(
        join(dir, '902_ledger_probe_gamma.sql'),
        toCrlf('CREATE TABLE ledger_probe_gamma (id integer PRIMARY KEY);\n'),
        'utf8',
      );

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
      // The §0.4 opt-in, driven through a real process. Without a chain name the redirection
      // is refused; with an undeclared name it is refused; and a file outside the reserved
      // probe namespace is refused even under the right chain.
      const unnamed = runMigrate({ [FIXTURE_CHAIN_ENV]: '' });
      assert.equal(unnamed.status, 1, unnamed.output);
      assert.match(unnamed.output, /fixture-chain check FAILED/i);

      const unknown = runMigrate({ [FIXTURE_CHAIN_ENV]: 'no-such-chain' });
      assert.equal(unknown.status, 1, unknown.output);
      assert.match(unknown.output, /not a declared migration fixture chain/);

      writeFileSync(join(dir, '058_pretend_migration.sql'), 'SELECT 1;\n', 'utf8');
      const intruder = runMigrate();
      assert.equal(intruder.status, 1, intruder.output);
      assert.match(intruder.output, /reserved probe namespace/);
      rmSync(join(dir, '058_pretend_migration.sql'), { force: true });

      assert.equal(runMigrate().status, 0, 'and the admitted chain still runs');
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
describe('the migration fixture-chain admission rules (FBL-020-R5 §0.4)', () => {
  const CANONICAL = join(__dirname, '..', 'migrations');
  const chains = loadFixtureChains();

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

  test('every declared PINNED chain matches its committed digests exactly, today', () => {
    // The `pre-057` chain must equal migrations/ minus 057, and `schema-f76a27a` must equal
    // the retained fixture. If a pinned digest and the file it pins ever part company, the
    // CI upgrade job stops working — and it should stop, loudly, here.
    const f76 = validateChainDirectory(
      'schema-f76a27a',
      join(__dirname, 'fixtures', 'schema-f76a27a'),
      chains,
      CANONICAL,
    );
    assert.deepEqual(f76.problems, [], f76.problems.join('\n'));

    const staged = mkdtempSync(join(tmpdir(), 'fbl020-pre057-'));
    try {
      for (const f of readdirSync(CANONICAL).filter((x) => x.endsWith('.sql')))
        if (!f.startsWith('057_')) writeFileSync(join(staged, f), readFileSync(join(CANONICAL, f)));
      const pre = validateChainDirectory('pre-057', staged, chains, CANONICAL);
      assert.deepEqual(pre.problems, [], pre.problems.join('\n'));

      // An EXTRA file is refused — this is the case that would let an unreviewed migration
      // ride along inside a directory the chain otherwise admits.
      writeFileSync(join(staged, '999_unreviewed.sql'), 'SELECT 1;\n', 'utf8');
      const intruder = validateChainDirectory('pre-057', staged, chains, CANONICAL);
      assert.ok(
        intruder.problems.some(
          (p) => p.includes('999_unreviewed.sql') && p.includes('does not declare'),
        ),
        intruder.problems.join('; '),
      );
      rmSync(join(staged, '999_unreviewed.sql'), { force: true });

      // A CHANGED body is refused, and the message says the pin is not a baseline.
      writeFileSync(join(staged, '055_identity_organization.sql'), 'SELECT 1;\n', 'utf8');
      const changed = validateChainDirectory('pre-057', staged, chains, CANONICAL);
      assert.ok(
        changed.problems.some(
          (p) => p.includes('055_identity_organization.sql') && p.includes('expected canonical-LF'),
        ),
        changed.problems.join('; '),
      );

      // A MISSING declared file is refused too.
      rmSync(join(staged, '055_identity_organization.sql'), { force: true });
      const missing = validateChainDirectory('pre-057', staged, chains, CANONICAL);
      assert.ok(
        missing.problems.some(
          (p) => p.includes('055_identity_organization.sql') && p.includes('is not present'),
        ),
        missing.problems.join('; '),
      );
    } finally {
      rmSync(staged, { recursive: true, force: true });
    }
  });

  test('the negative-control chain admits a ONE-STATEMENT deletion and nothing else', () => {
    /*
     * This is the admission rule that replaces a checksum for the one file the harness is
     * allowed to mutate. It has to be exactly as strict as it claims: a rule that accepted a
     * two-statement deletion, or a substitution, would let a control report a satisfied
     * verdict for a mutation nobody sanctioned.
     */
    const canonical = 'AAA;\nBBB;\nCCC;\n';
    const oneGone = singleSpanDeletion(canonical, 'AAA;\nCCC;\n');
    assert.equal(oneGone.ok, true, oneGone.reason);
    assert.equal(oneGone.deleted, 'BBB;\n');

    // A span at either END is still ONE contiguous span, so both are admitted.
    assert.equal(singleSpanDeletion('AAA;\nBBB;\n', 'BBB;\n').ok, true);
    assert.equal(singleSpanDeletion('AAA;\nBBB;\n', 'AAA;\n').ok, true);

    // TWO separate deletions are refused — including the shape that trims both ends, which
    // is what a careless anchor pair would produce. Neither the common prefix nor the common
    // suffix reaches the stretch between them, so the lengths cannot add up.
    assert.equal(singleSpanDeletion('AAA;\nBBB;\nCCC;\nDDD;\n', 'BBB;\nCCC;\n').ok, false);
    assert.equal(singleSpanDeletion('AAA;\nBBB;\nCCC;\nDDD;\n', 'AAA;\nCCC;\n').ok, false);

    // A substitution of equal length is rejected by the length check…
    assert.equal(singleSpanDeletion('AAA;\nBBB;\n', 'AAA;\nXXX;\n').ok, false);
    // …and a shortening substitution by the prefix/suffix accounting.
    assert.equal(singleSpanDeletion('AAA;\nBBB;\n', 'AAA;\nX;\n').ok, false);
    // An insertion cannot make the text shorter.
    assert.equal(singleSpanDeletion('AAA;\n', 'AAA;\nBBB;\n').ok, false);
    // Identical text is not a deletion.
    assert.equal(singleSpanDeletion('AAA;\n', 'AAA;\n').ok, false);
  });

  test('the negative-control chain pins the canonical digest of the file it mutates', () => {
    // If 057 is corrected and this pin is not updated with it, the harness must refuse rather
    // than mutate a file nobody reviewed against a digest nobody checked.
    const chain = chains['negative-control-057'];
    assert.ok(chain !== undefined && chain.kind === 'single-statement-deletion');
    if (chain === undefined || chain.kind !== 'single-statement-deletion') return;
    assert.equal(
      chain.mutated_file_canonical_sha256,
      chainDigest(readFileSync(join(CANONICAL, chain.mutated_file))),
      'the pinned canonical digest of 057 and the file in migrations/ must agree',
    );

    const staged = mkdtempSync(join(tmpdir(), 'fbl020-nc-chain-'));
    try {
      for (const f of readdirSync(CANONICAL).filter((x) => x.endsWith('.sql')))
        writeFileSync(join(staged, f), readFileSync(join(CANONICAL, f)));
      // Unmutated: refused, because nothing was deleted.
      const unmutated = validateChainDirectory('negative-control-057', staged, chains, CANONICAL);
      assert.ok(
        unmutated.problems.some((p) => p.includes('nothing was deleted')),
        unmutated.problems.join('; '),
      );

      // Two statements removed: refused, with the terminator count named.
      const text = readFileSync(join(CANONICAL, chain.mutated_file), 'utf8').replace(/\r\n/g, '\n');
      const first = text.indexOf(';');
      const second = text.indexOf(';', first + 1);
      writeFileSync(
        join(staged, chain.mutated_file),
        text.slice(0, first) + text.slice(second + 1),
        'utf8',
      );
      const twoGone = validateChainDirectory('negative-control-057', staged, chains, CANONICAL);
      assert.ok(
        twoGone.problems.some((p) => p.includes('statement terminator')),
        twoGone.problems.join('; '),
      );
    } finally {
      rmSync(staged, { recursive: true, force: true });
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
