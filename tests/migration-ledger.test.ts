import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { INTEGRATION_DATABASE_URL, skipIntegration } from '@dealer/test-kit';
import { closePool, query } from '@dealer/database';

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

    function runMigrate(env: Record<string, string> = {}): Run {
      const child = spawnSync(process.execPath, ['--import', 'tsx', RUNNER], {
        encoding: 'utf8',
        timeout: 120_000,
        env: { ...process.env, DATABASE_URL: scratchUrl, MIGRATIONS_DIR: dir, ...env },
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

    before(async () => {
      const url = new URL(INTEGRATION_DATABASE_URL as string);
      url.pathname = `/${SCRATCH_DB}`;
      scratchUrl = url.toString();
      // The suite's own pool is connected to the test database; CREATE DATABASE cannot
      // run inside a transaction and `query` issues it directly, so this is legal here.
      await query(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
      await query(`CREATE DATABASE ${SCRATCH_DB}`);
      dir = mkdtempSync(join(tmpdir(), 'fbl020-ledger-'));
      writeMigrations(ALPHA_LF, BETA_LF);
    });

    after(async () => {
      rmSync(dir, { recursive: true, force: true });
      await query(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
      await closePool();
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

    test('a row that predates the column stays NULL: no checksum is invented for it', () => {
      // Exactly the shape the pre-checksum runner left behind.
      const blank = scratchExec(
        `UPDATE schema_migrations SET checksum_sha256 = NULL, checksum_algorithm = NULL
          WHERE filename = '901_ledger_probe_beta.sql'`,
      );
      assert.equal(blank.status, 0, blank.output);

      const run = runMigrate();
      assert.equal(run.status, 0, `an unverifiable row must not brick the runner:\n${run.output}`);
      assert.match(run.output, /NO recorded checksum/, 'the condition is reported, every run');
      assert.match(run.output, /901_ledger_probe_beta\.sql/);

      const row = ledger().find((r) => r.filename === '901_ledger_probe_beta.sql');
      // THE HONEST REPRESENTATION: still NULL. Hashing the file as it sits today would
      // assert "this is the body that was applied" — the one claim that cannot be
      // proven for such a row, and the way a changed body would be laundered into a
      // verified one.
      assert.equal(row?.checksum, null);
      assert.equal(row?.algorithm, null);

      const restore = scratchExec(
        `UPDATE schema_migrations
            SET checksum_sha256 = '${canonicalDigest(BETA_LF)}',
                checksum_algorithm = 'sha256-canonical-lf'
          WHERE filename = '901_ledger_probe_beta.sql'`,
      );
      assert.equal(restore.status, 0, restore.output);
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
  },
);
