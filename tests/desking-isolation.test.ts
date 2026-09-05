import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Client } from 'pg';

import { closePool } from '@dealer/database';
import {
  buildScenario,
  decideScenario,
  openDeskingCase,
  recordAppraisal,
  recordSourceQuotation,
  submitScenario,
} from '@dealer/desking';
import {
  fixtureAuthorizationStateWrite,
  resetDatabase,
  skipIntegration,
  startIdentityTestEnv,
  type IdentityTestEnv,
} from '@dealer/test-kit';

import {
  JURISDICTION,
  seedDeskWorld,
  seedRuleBook,
  resetVins,
  show,
  tradeEvidence,
  type DeskWorld,
} from './desking-world';

/**
 * ROW 7 — TENANT AND ROOFTOP INTEGRITY AT THE DATABASE BOUNDARY.
 *
 * `tests/desking-authority.test.ts` proves the boundary through the HTTP stack,
 * which is where a person meets it. This battery proves it one layer down,
 * where an attacker would be:
 *
 *   * THROUGH A GENUINE `dealership_app` CONNECTION, with the attacking
 *     statements written WITHOUT tenant predicates. A proof made on the pooled
 *     owner connection would be worthless, because migration 065 — like every
 *     migration before it — ENABLEs row security rather than FORCEing it, and
 *     the owner bypasses it, which is exactly what lets the harness set the
 *     fixtures up in the first place.
 *   * AT THE RESOLVER, where migration 062's privilege split must still hold
 *     for the three resource types this phase adds: the row-security-bypassing
 *     registry is not executable by the runtime AT ALL, and the ordinary lookup
 *     answers only about the session's own dealership.
 */
describe(
  'desking: tenant and rooftop integrity at the database boundary (FBL-120 Row 7)',
  { skip: skipIntegration ? 'set TEST_DATABASE_URL to run' : false },
  () => {
    const OWNER_URL = process.env.TEST_DATABASE_URL as string;
    const APP_PASSWORD = 'fbl120_isolation_test_pw';
    let app: Client;
    let env: IdentityTestEnv;

    /** Every table migration 065 secures. */
    const SECURED_TABLES = [
      'desking_cases',
      'appraisals',
      'appraisal_versions',
      'appraisal_damage_items',
      'appraisal_equipment',
      'appraisal_observations',
      'appraisal_attachments',
      'appraisal_source_quotations',
      'desking_rules',
      'desking_scenarios',
      'scenario_line_items',
      'scenario_rule_applications',
      'scenario_state_events',
      'scenario_approvals',
    ] as const;

    before(async () => {
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
      app = new Client({ connectionString: u.toString() });
      await app.connect();
      env = await startIdentityTestEnv();
    });

    after(async () => {
      await app.end();
      await env.stop();
      await closePool();
    });

    beforeEach(async () => {
      await resetDatabase();
      resetVins();
    });

    async function noContext(): Promise<void> {
      await app.query(`SELECT set_config('app.tenant_id', '', false)`);
    }

    async function contextOf(tenantId: string): Promise<void> {
      await app.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenantId]);
    }

    interface Desk {
      world: DeskWorld;
      caseId: string;
      appraisalId: string;
      scenarioId: string;
    }

    /** A whole desk file, built through the services that own every row. */
    async function seedDesk(): Promise<Desk> {
      const world = await seedDeskWorld(env);
      await seedRuleBook(world);
      const opened = await openDeskingCase({
        actingUserLinkId: world.seller,
        tenantId: world.tenantId,
        deskingHandoffId: world.deskingHandoffId,
      });
      assert.equal(opened.outcome, 'opened', show(opened));
      const caseId = (opened as { deskingCase: { deskingCaseId: string } }).deskingCase
        .deskingCaseId;

      const appraised = await recordAppraisal({
        actingUserLinkId: world.seller,
        tenantId: world.tenantId,
        deskingCaseId: caseId,
        vin: '2T1BURHE0JC014729',
        modelYear: 2018,
        make: 'Toyota',
        model: 'Corolla',
        evidence: tradeEvidence() as never,
      });
      assert.equal(appraised.outcome, 'recorded', show(appraised));
      const appraisalId = (appraised as { appraisal: { appraisalId: string } }).appraisal
        .appraisalId;
      await recordSourceQuotation({
        actingUserLinkId: world.seller,
        tenantId: world.tenantId,
        appraisalId,
        providerCode: 'book_sim',
        providerKind: 'deterministic_simulator',
        availability: 'quoted',
        quotedValueCents: 1_100_000n,
        currency: 'USD',
      });

      const built = await buildScenario({
        actingUserLinkId: world.seller,
        tenantId: world.tenantId,
        deskingCaseId: caseId,
        label: 'First pencil',
        jurisdiction: JURISDICTION,
        vehiclePriceCents: 4_550_000n,
        tradeAllowanceCents: 1_200_000n,
        termMonths: 72,
        aprPpm: 74_900n,
      });
      assert.equal(built.outcome, 'built', show(built));
      const scenario = (
        built as {
          scenario: { scenarioId: string; authorizationVersion: number; outputFingerprint: string };
        }
      ).scenario;
      const submitted = await submitScenario({
        actingUserLinkId: world.seller,
        tenantId: world.tenantId,
        scenarioId: scenario.scenarioId,
        expectedVersion: scenario.authorizationVersion,
      });
      assert.equal(submitted.outcome, 'moved', show(submitted));
      const decided = await decideScenario({
        actingUserLinkId: world.manager,
        tenantId: world.tenantId,
        scenarioId: scenario.scenarioId,
        decision: 'approved',
        reviewedOutputFingerprint: scenario.outputFingerprint,
        expectedVersion: (submitted as { scenario: { authorizationVersion: number } }).scenario
          .authorizationVersion,
      });
      assert.equal(decided.outcome, 'decided', show(decided));
      return { world, caseId, appraisalId, scenarioId: scenario.scenarioId };
    }

    test('every table this phase adds is secured, and a session without a dealership sees none of it', async () => {
      const desk = await seedDesk();
      assert.ok(desk.caseId.length > 0);

      const secured = await app.query(
        `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relrowsecurity AND c.relname = ANY($1::text[])
          ORDER BY 1`,
        [SECURED_TABLES],
      );
      assert.deepEqual(
        secured.rows.map((r) => String((r as { relname: string }).relname)),
        [...SECURED_TABLES].sort(),
        'a table this phase added without row security would be readable by every dealership',
      );

      await noContext();
      for (const table of SECURED_TABLES) {
        const rows = await app.query(`SELECT COUNT(*)::int AS n FROM ${table}`);
        assert.equal(
          Number((rows.rows[0] as { n: number }).n),
          0,
          `${table} answered a session with no dealership`,
        );
      }
    });

    test('one dealership cannot read, edit or delete another’s desk', async () => {
      const alpha = await seedDesk();
      const beta = await seedDesk();

      await contextOf(alpha.world.tenantId);
      // NO TENANT PREDICATE ANYWHERE BELOW — that is the point.
      const cases = await app.query(`SELECT desking_case_id FROM desking_cases`);
      assert.deepEqual(
        cases.rows.map((r) => String((r as { desking_case_id: string }).desking_case_id)),
        [alpha.caseId],
        'alpha sees exactly its own file',
      );

      const scenarios = await app.query(`SELECT scenario_id FROM desking_scenarios`);
      assert.deepEqual(
        scenarios.rows.map((r) => String((r as { scenario_id: string }).scenario_id)),
        [alpha.scenarioId],
      );

      const foreignRead = await app.query(
        `SELECT COUNT(*)::int AS n FROM desking_scenarios WHERE scenario_id = $1`,
        [beta.scenarioId],
      );
      assert.equal(Number((foreignRead.rows[0] as { n: number }).n), 0, 'named directly, and gone');

      // THROUGH THE DECLARED BYPASS, and through the app role. The write is the
      // adversary this test exists to watch fail, so it is a reasoned fixture
      // write rather than an undeclared one — and it runs on the `dealership_app`
      // connection, because on the pooled owner it would simply succeed.
      const foreignEdit = await fixtureAuthorizationStateWrite(
        'adversarial-bypass-attempt',
        `UPDATE desking_cases SET updated_at = NOW() WHERE desking_case_id = $1`,
        [beta.caseId],
        { executor: app },
      );
      assert.equal(foreignEdit.rowCount, 0, 'an UPDATE naming a foreign row touches nothing');

      // The runtime holds no DELETE on anything this phase adds, so the attempt
      // fails on the privilege rather than merely on the policy.
      await assert.rejects(
        () => app.query(`DELETE FROM scenario_approvals`),
        /permission denied/,
        'approved history cannot be deleted by the runtime at all',
      );
    });

    test('a write that names another dealership is refused by the policy, not merely filtered', async () => {
      const alpha = await seedDesk();
      const beta = await seedDesk();
      await contextOf(alpha.world.tenantId);
      await assert.rejects(
        () =>
          app.query(
            `INSERT INTO scenario_state_events
               (tenant_id, scenario_id, from_state, to_state, changed_by_user_link_id)
             VALUES ($1, $2, 'draft', 'submitted', $3)`,
            [beta.world.tenantId, beta.scenarioId, beta.world.seller],
          ),
        /row-level security|violates/i,
        'writing INTO another dealership is refused by the WITH CHECK, not silently dropped',
      );
    });

    test('the privileged resolver is not executable by the runtime, and the ordinary one is dealership-bound', async () => {
      const alpha = await seedDesk();
      const beta = await seedDesk();

      await contextOf(alpha.world.tenantId);
      for (const [type, id] of [
        ['desking_case', alpha.caseId],
        ['appraisal', alpha.appraisalId],
        ['desking_scenario', alpha.scenarioId],
      ] as const) {
        await assert.rejects(
          () => app.query(`SELECT resource_org_leaf($1, $2, $3)`, [alpha.world.tenantId, type, id]),
          /permission denied/,
          `${type}: the row-security-bypassing registry must stay out of the runtime's reach`,
        );
        const visible = await app.query(`SELECT resource_org_leaf_visible($1, $2) AS leaf`, [
          type,
          id,
        ]);
        assert.equal(
          String((visible.rows[0] as { leaf: string }).leaf),
          alpha.world.rooftopId,
          `${type} resolves to its own rooftop`,
        );
      }

      // …and the same lookup says NOTHING about the other dealership's rows.
      for (const [type, id] of [
        ['desking_case', beta.caseId],
        ['appraisal', beta.appraisalId],
        ['desking_scenario', beta.scenarioId],
      ] as const) {
        const blind = await app.query(`SELECT resource_org_leaf_visible($1, $2) AS leaf`, [
          type,
          id,
        ]);
        assert.equal(
          (blind.rows[0] as { leaf: string | null }).leaf,
          null,
          `${type}: a foreign row resolves to nothing, which is what a probe learns`,
        );
      }
    });
  },
);
