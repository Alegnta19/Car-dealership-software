import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, describe, test } from 'node:test';
import { Client } from 'pg';
import { runtimePostureViolations, type RuntimePosture } from '@dealer/database';
import { loadConfig, loadDatabaseConfig } from '@dealer/platform';
import { fixtureAuthorizationStateWrite, skipIntegration } from '@dealer/test-kit';

/**
 * FBL-020-R7-C1 §2 + FBL-020-R7-C2 §1 — THE RUNTIME CONNECTION IS A REAL,
 * NON-OWNER LOGIN, JUDGED ABOUT BOTH OF ITS IDENTITIES.
 *
 * The unit half pins `runtimePostureViolations` to each property, the
 * concealment rule (session_user must equal current_user) included, and pins
 * the configuration loaders to REFUSING `DATABASE_RUNTIME_ROLE` — startup role
 * switching is removed, so an owner URL plus that variable fails startup
 * before a pool exists.
 *
 * The integration half opens REAL connections: as migration 060's
 * `dealership_app` login (not a superuser impersonating it) it proves the
 * database itself grants exactly the least-privilege posture — no assumable
 * owner, no ledger write in any verb, no direct child evidence, forged GUC and
 * all — and as the OWNER, with and without a `-c role=` startup switch, it
 * proves the posture gate exposes what `current_user` alone used to conceal.
 */
describe('runtime database posture (FBL-020-R7-C1 §2, C2 §1)', () => {
  // ── unit: the violation rules, one property at a time ──────────────────

  const compliant: RuntimePosture = {
    sessionUser: 'dealership_app',
    currentUser: 'dealership_app',
    isSuperuser: false,
    assumableOwners: [],
    canWriteLedger: false,
    canInsertChildEvidence: false,
    canInsertParentDecision: true,
  };

  test('a least-privilege runtime posture has no violations', () => {
    assert.deepEqual(runtimePostureViolations(compliant), []);
  });

  test('each privileged, concealed or under-privileged posture is a named violation', () => {
    const cases: ReadonlyArray<[Partial<RuntimePosture>, RegExp]> = [
      [{ sessionUser: 'cockpit' }, /switched role conceals the real login/],
      [{ isSuperuser: true }, /SUPERUSER/],
      [{ assumableOwners: ['cockpit'] }, /can assume actual owner role\(s\) cockpit/],
      [{ canWriteLedger: true }, /INSERT, UPDATE, DELETE or TRUNCATE schema_migrations/],
      [{ canInsertChildEvidence: true }, /directly INSERT policy_decision_matched_bindings/],
      [{ canInsertParentDecision: false }, /cannot INSERT policy_decisions/],
    ];
    for (const [override, pattern] of cases) {
      const problems = runtimePostureViolations({ ...compliant, ...override });
      assert.equal(problems.length, 1, `exactly one violation for ${JSON.stringify(override)}`);
      assert.match(problems[0] as string, pattern);
    }
  });

  test('DATABASE_RUNTIME_ROLE fails startup — role switching cannot dress an owner login', () => {
    // C2 §1: "owner URL plus DATABASE_RUNTIME_ROLE=dealership_runtime fails
    // startup". Both configuration loaders refuse the variable outright, so
    // the process never reaches a pool, whatever the URL names.
    const env = {
      DATABASE_URL: 'postgres://owner:pw@localhost:5432/db',
      DATABASE_RUNTIME_ROLE: 'dealership_runtime',
    };
    assert.throws(() => loadDatabaseConfig(env), /DATABASE_RUNTIME_ROLE is no longer supported/);
    assert.throws(() => loadConfig(env), /DATABASE_RUNTIME_ROLE is no longer supported/);
    // And the refusal is about the variable being SET, not about its value.
    assert.throws(
      () => loadDatabaseConfig({ ...env, DATABASE_RUNTIME_ROLE: 'anything_else' }),
      /authenticate directly as the/i,
    );
  });

  // ── integration: the real dealership_app login ─────────────────────────

  describe(
    'the dealership_app login has exactly the runtime posture',
    { skip: skipIntegration ? 'set TEST_DATABASE_URL to run' : false },
    () => {
      const OWNER_URL = process.env.TEST_DATABASE_URL as string;
      const APP_PASSWORD = 'runtime_posture_test_pw';
      let appUrl: string;

      const POSTURE_SQL = `WITH actual_owners AS (
         SELECT pg_get_userbyid(d.datdba)::text AS owner
           FROM pg_database d WHERE d.datname = current_database()
         UNION
         SELECT pg_get_userbyid(n.nspowner)::text
           FROM pg_namespace n WHERE n.nspname = 'public'
         UNION
         SELECT DISTINCT c.relowner::regrole::text
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
         UNION
         SELECT 'dealership_evidence_owner'
          WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dealership_evidence_owner')
         UNION
         SELECT r.rolname::text FROM pg_roles r WHERE r.rolsuper
       )
       SELECT
         session_user AS session_user,
         current_user AS current_user,
         (SELECT rolsuper FROM pg_roles WHERE rolname = session_user)
           OR (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_superuser,
         COALESCE(
           (SELECT array_agg(DISTINCT o.owner ORDER BY o.owner)
              FROM actual_owners o
             WHERE pg_has_role(session_user, o.owner, 'MEMBER')
                OR pg_has_role(current_user, o.owner, 'MEMBER')),
           ARRAY[]::text[]) AS assumable_owners,
         has_table_privilege(session_user, 'schema_migrations', 'INSERT')
           OR has_table_privilege(session_user, 'schema_migrations', 'UPDATE')
           OR has_table_privilege(session_user, 'schema_migrations', 'DELETE')
           OR has_table_privilege(session_user, 'schema_migrations', 'TRUNCATE')
           OR has_table_privilege(current_user, 'schema_migrations', 'INSERT')
           OR has_table_privilege(current_user, 'schema_migrations', 'UPDATE')
           OR has_table_privilege(current_user, 'schema_migrations', 'DELETE')
           OR has_table_privilege(current_user, 'schema_migrations', 'TRUNCATE') AS can_write_ledger,
         has_table_privilege(session_user, 'policy_decision_matched_bindings', 'INSERT')
           OR has_table_privilege(current_user, 'policy_decision_matched_bindings', 'INSERT')
           AS can_insert_child,
         has_table_privilege(current_user, 'policy_decisions', 'INSERT') AS can_insert_parent`;

      async function postureOfClient(client: Client): Promise<RuntimePosture> {
        const r = (await client.query(POSTURE_SQL)).rows[0] as Record<string, unknown>;
        return {
          sessionUser: String(r.session_user),
          currentUser: String(r.current_user),
          isSuperuser: r.is_superuser === true,
          assumableOwners: Array.isArray(r.assumable_owners) ? r.assumable_owners.map(String) : [],
          canWriteLedger: r.can_write_ledger === true,
          canInsertChildEvidence: r.can_insert_child === true,
          canInsertParentDecision: r.can_insert_parent === true,
        };
      }

      async function postureOf(url: string, options?: string): Promise<RuntimePosture> {
        const client = new Client({
          connectionString: url,
          ...(options === undefined ? {} : { options }),
        });
        await client.connect();
        try {
          return await postureOfClient(client);
        } finally {
          await client.end();
        }
      }

      before(async () => {
        // Provision an EPHEMERAL password for the migration-created role, exactly
        // as an operator would out of band. Never committed, never logged.
        const owner = new Client({ connectionString: OWNER_URL });
        await owner.connect();
        try {
          await owner.query(`ALTER ROLE dealership_app PASSWORD '${APP_PASSWORD}'`);
        } finally {
          await owner.end();
        }
        const u = new URL(OWNER_URL);
        u.username = 'dealership_app';
        u.password = APP_PASSWORD;
        appUrl = u.toString();
      });

      test('the app login is non-owner, non-superuser, and least-privilege', async () => {
        const posture = await postureOf(appUrl);
        assert.equal(posture.sessionUser, 'dealership_app');
        assert.equal(posture.currentUser, 'dealership_app');
        assert.deepEqual(posture.assumableOwners, [], 'it can assume NO actual owner');
        assert.deepEqual(
          runtimePostureViolations(posture),
          [],
          'the real dealership_app connection is compliant',
        );
        assert.equal(posture.canInsertParentDecision, true, 'it can record decisions');
        assert.equal(
          posture.canInsertChildEvidence,
          false,
          'it cannot write normalized child rows',
        );
      });

      test('an owner/superuser connection FAILS the posture (fail closed)', async () => {
        const posture = await postureOf(OWNER_URL);
        assert.ok(
          runtimePostureViolations(posture).length > 0,
          'the owner connection is refused by the runtime posture gate',
        );
      });

      test('an owner login behind a -c role= startup switch cannot conceal itself', async () => {
        // The exact shape R7 §3.7 used and C2 §1 removes: the OWNER credential
        // with the runtime role assumed at connection startup. current_user
        // reads as the runtime role — the concealment — while session_user is
        // still the owner. The posture reads BOTH and refuses.
        const posture = await postureOf(OWNER_URL, '-c role=dealership_runtime');
        assert.equal(posture.currentUser, 'dealership_runtime', 'the costume is on');
        assert.notEqual(posture.sessionUser, 'dealership_runtime', 'the login is not it');
        const problems = runtimePostureViolations(posture);
        assert.ok(problems.length > 0, 'the switched-owner connection is refused');
        assert.ok(
          problems.some((p) => /switched role conceals the real login/.test(p)),
          'and the refusal names the concealment itself',
        );
      });

      test('membership in a nothing-owning superuser role cannot hide from the posture', async () => {
        // SUPERUSER is an attribute, not an inheritable privilege: a login
        // granted membership in a superuser role that owns nothing shows
        // rolsuper=false on both of its own identities, no owned table and no
        // ACL privilege — while sitting one SET ROLE away from total bypass.
        // The posture's owner enumeration therefore carries a superuser arm,
        // and this misgrant is what it exists to expose.
        const owner = new Client({ connectionString: OWNER_URL });
        await owner.connect();
        try {
          await owner.query(`DROP ROLE IF EXISTS posture_breakglass_probe`);
          await owner.query(`CREATE ROLE posture_breakglass_probe SUPERUSER NOLOGIN`);
          await owner.query(`GRANT posture_breakglass_probe TO dealership_app`);
          try {
            const posture = await postureOf(appUrl);
            assert.equal(posture.isSuperuser, false, 'neither identity is itself a superuser');
            assert.ok(
              posture.assumableOwners.includes('posture_breakglass_probe'),
              'the assumable superuser role is enumerated',
            );
            assert.ok(
              runtimePostureViolations(posture).some((p) =>
                /can assume actual owner role\(s\)/.test(p),
              ),
              'and the posture refuses the connection',
            );
          } finally {
            await owner.query(`REVOKE posture_breakglass_probe FROM dealership_app`);
            await owner.query(`DROP ROLE posture_breakglass_probe`);
          }
        } finally {
          await owner.end();
        }
      });

      test('the app login cannot RESET ROLE into privilege, assume any actual owner, DDL, or write the ledger in any verb', async () => {
        const client = new Client({ connectionString: appUrl });
        await client.connect();
        try {
          // RESET ROLE returns to the same non-owner login.
          await client.query('RESET ROLE');
          const who = (await client.query('SELECT current_user AS u, session_user AS s'))
            .rows[0] as { u: string; s: string };
          assert.equal(who.u, 'dealership_app');
          assert.equal(who.s, 'dealership_app');

          // The ACTUAL database owner, read from the database, is not
          // assumable either — "cannot assume any actual database, schema,
          // migration, table, or evidence owner" is proven against the real
          // owner name, not a guessed one.
          const dbOwner = (
            await client.query(
              `SELECT pg_get_userbyid(d.datdba) AS o FROM pg_database d
                WHERE d.datname = current_database()`,
            )
          ).rows[0] as { o: string };

          for (const [sql, code] of [
            [`SET ROLE dealership_evidence_owner`, '42501'],
            [`SET ROLE "${dbOwner.o}"`, '42501'],
            [
              `ALTER TABLE policy_decisions DISABLE TRIGGER trg_policy_decisions_v4_structure`,
              '42501',
            ],
            [
              `INSERT INTO schema_migrations (filename, checksum_sha256, checksum_algorithm) VALUES ('x','y','z')`,
              '42501',
            ],
            [`UPDATE schema_migrations SET checksum_sha256 = 'x' WHERE filename = '000'`, '42501'],
            [`DELETE FROM schema_migrations WHERE filename = 'never'`, '42501'],
            [`TRUNCATE schema_migrations`, '42501'],
          ] as ReadonlyArray<[string, string]>) {
            let code_seen: string | undefined;
            try {
              await client.query(sql);
            } catch (err) {
              code_seen = (err as { code?: string }).code;
            }
            assert.equal(code_seen, code, `refused by the privilege system: ${sql.slice(0, 40)}`);
            await client.query('ROLLBACK').catch(() => undefined);
          }
        } finally {
          await client.end();
        }
      });

      test('a forged normalizer GUC buys the app login nothing — the child insert is refused by privilege', async () => {
        // C2 §1: "forged-GUC child insertion remains refused" — through the
        // REAL runtime login, not a superuser SET ROLEd down. The privilege
        // system refuses before any trigger or foreign key runs, so no
        // fixture rows are needed: the 42501 is about WHO is writing.
        const client = new Client({ connectionString: appUrl });
        await client.connect();
        try {
          await client.query(
            `SELECT set_config('policy_evidence.normalizing_decision', $1, false)`,
            [randomUUID()],
          );
          let refused: { code?: string } | undefined;
          try {
            await fixtureAuthorizationStateWrite(
              'adversarial-bypass-attempt',
              `INSERT INTO policy_decision_matched_bindings
                 (decision_id, role_binding_id, actor_user_link_id, authorization_version,
                  match_ordinality)
               VALUES ($1, $2, $3, 1, 1)`,
              [randomUUID(), randomUUID(), randomUUID()],
              { executor: client },
            );
          } catch (err) {
            refused = err as { code?: string };
          }
          assert.equal(
            refused?.code,
            '42501',
            'refused by the privilege system (insufficient_privilege), marker or no marker',
          );
        } finally {
          await client.end();
        }
      });
    },
  );
});
