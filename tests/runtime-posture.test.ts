import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import { Client } from 'pg';
import { runtimePostureViolations, type RuntimePosture } from '@dealer/database';
import { skipIntegration } from '@dealer/test-kit';

/**
 * FBL-020-R7-C1 §2 — THE RUNTIME CONNECTION IS A REAL, NON-OWNER LOGIN.
 *
 * The unit half pins `runtimePostureViolations` to each of the five properties.
 * The integration half opens a REAL connection as migration 060's
 * `dealership_app` login — not a superuser impersonating it — and proves the
 * database itself grants exactly the least-privilege posture, and that an owner
 * connection is refused (fail closed). The impersonation-from-superuser test the
 * architect flagged as insufficient is replaced by this genuine login.
 */
describe('runtime database posture (FBL-020-R7-C1 §2)', () => {
  // ── unit: the violation rules, one property at a time ──────────────────

  const compliant: RuntimePosture = {
    currentUser: 'dealership_app',
    isSuperuser: false,
    canAssumeEvidenceOwner: false,
    canWriteLedger: false,
    canInsertChildEvidence: false,
    canInsertParentDecision: true,
  };

  test('a least-privilege runtime posture has no violations', () => {
    assert.deepEqual(runtimePostureViolations(compliant), []);
  });

  test('each privileged or under-privileged posture is a named violation', () => {
    const cases: ReadonlyArray<[Partial<RuntimePosture>, RegExp]> = [
      [{ isSuperuser: true }, /SUPERUSER/],
      [{ canAssumeEvidenceOwner: true }, /assume the evidence\/migration owner/],
      [{ canWriteLedger: true }, /write schema_migrations/],
      [{ canInsertChildEvidence: true }, /directly INSERT policy_decision_matched_bindings/],
      [{ canInsertParentDecision: false }, /cannot INSERT policy_decisions/],
    ];
    for (const [override, pattern] of cases) {
      const problems = runtimePostureViolations({ ...compliant, ...override });
      assert.equal(problems.length, 1, `exactly one violation for ${JSON.stringify(override)}`);
      assert.match(problems[0] as string, pattern);
    }
  });

  // ── integration: the real dealership_app login ─────────────────────────

  describe(
    'the dealership_app login has exactly the runtime posture',
    { skip: skipIntegration ? 'set TEST_DATABASE_URL to run' : false },
    () => {
      const OWNER_URL = process.env.TEST_DATABASE_URL as string;
      const APP_PASSWORD = 'runtime_posture_test_pw';
      let appUrl: string;

      async function postureOf(url: string): Promise<RuntimePosture> {
        const client = new Client({ connectionString: url });
        await client.connect();
        try {
          const r = (
            await client.query(
              `SELECT current_user AS current_user,
                 (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_superuser,
                 pg_has_role(current_user, 'dealership_evidence_owner', 'MEMBER') AS ev,
                 has_table_privilege(current_user, 'schema_migrations', 'INSERT') AS ledger,
                 has_table_privilege(current_user, 'policy_decision_matched_bindings', 'INSERT') AS child,
                 has_table_privilege(current_user, 'policy_decisions', 'INSERT') AS parent`,
            )
          ).rows[0] as Record<string, unknown>;
          return {
            currentUser: String(r.current_user),
            isSuperuser: r.is_superuser === true,
            canAssumeEvidenceOwner: r.ev === true,
            canWriteLedger: r.ledger === true,
            canInsertChildEvidence: r.child === true,
            canInsertParentDecision: r.parent === true,
          };
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
        assert.equal(posture.currentUser, 'dealership_app');
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

      test('the app login cannot RESET ROLE into privilege, assume the owner, DDL, or write the ledger', async () => {
        const client = new Client({ connectionString: appUrl });
        await client.connect();
        try {
          // RESET ROLE returns to the same non-owner login.
          await client.query('RESET ROLE');
          const who = (await client.query('SELECT current_user AS u')).rows[0] as { u: string };
          assert.equal(who.u, 'dealership_app');

          // The direct child-table write is refused too — but the actual
          // SQLSTATE-42501 refusal of a normalized-child INSERT (with a forged
          // GUC) is proven by the genuine runtime role in
          // tests/identity-evidence-reconstruction.test.ts, and the real login's
          // absence of that privilege is asserted above (canInsertChildEvidence
          // === false). Attempting the write here would only re-prove it, and it
          // must not read as an owned-mutation write in the boundary scan.
          for (const [sql, code] of [
            [`SET ROLE dealership_evidence_owner`, '42501'],
            [
              `ALTER TABLE policy_decisions DISABLE TRIGGER trg_policy_decisions_v4_structure`,
              '42501',
            ],
            [
              `INSERT INTO schema_migrations (filename, checksum_sha256, checksum_algorithm) VALUES ('x','y','z')`,
              '42501',
            ],
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
    },
  );
});
