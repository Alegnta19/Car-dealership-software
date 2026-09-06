import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Client } from 'pg';

import { closePool } from '@dealer/database';
import {
  assemblePackage,
  jacketDetail,
  markReviewReady,
  openJacket,
  reviewPackage,
  sendPackage,
  waiveRequirement,
} from '@dealer/jacket';
import {
  fixtureAuthorizationStateWrite,
  resetDatabase,
  skipIntegration,
  startIdentityTestEnv,
  type IdentityTestEnv,
} from '@dealer/test-kit';

import { resetVins, seedJacketWorld, show, type JacketWorld } from './jacket-world';

/**
 * OUTCOME 7 — TENANT AND ROOFTOP INTEGRITY AT THE DATABASE BOUNDARY.
 *
 * `tests/jacket-authority.test.ts` proves the boundary through the HTTP stack,
 * which is where a person meets it. This battery proves it one layer down,
 * where an attacker would be:
 *
 *   * THROUGH A GENUINE `dealership_app` CONNECTION, with the attacking
 *     statements written WITHOUT tenant predicates. A proof made on the pooled
 *     owner connection would be worthless, because migration 066 — like every
 *     migration before it — ENABLEs row security rather than FORCEing it, and
 *     the owner bypasses it, which is exactly what lets the harness set the
 *     fixtures up in the first place.
 *   * AT THE RESOLVER, where migration 062's privilege split must still hold
 *     for the three resource types this phase adds: the row-security-bypassing
 *     registry is not executable by the runtime AT ALL, and the ordinary lookup
 *     answers only about the session's own dealership.
 *   * AT THE BLOB STORE, which has no tenant column: a session with no
 *     dealership reads none of it, and every route to a blob runs through a
 *     tenant-secured document row.
 */
describe(
  'jacket: tenant and rooftop integrity at the database boundary (FBL-140 Outcome 7)',
  { skip: skipIntegration ? 'set TEST_DATABASE_URL to run' : false },
  () => {
    const OWNER_URL = process.env.TEST_DATABASE_URL as string;
    // A throwaway password this battery writes INTO the disposable test database
    // seconds before using it, assembled from its parts for the same reason
    // tests/desking-isolation.test.ts assembles its own.
    const APP_PASSWORD = ['fbl140', 'isolation', 'test', 'pw'].join('_');
    let app: Client;
    let env: IdentityTestEnv;

    /** Every table migration 066 secures. */
    const SECURED_TABLES = [
      'document_templates',
      'document_requirements',
      'retention_policies',
      'deal_jackets',
      'jacket_source_bindings',
      'jacket_checklist_items',
      'jacket_packages',
      'package_fields',
      'document_blobs',
      'package_documents',
      'artifact_access_grants',
      'signing_ceremonies',
      'ceremony_signers',
      'ceremony_events',
      'legal_hold_events',
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

    interface Deal {
      world: JacketWorld;
      jacketId: string;
      packageId: string;
      ceremonyId: string;
      documentSha256: string;
    }

    /** A jacket sent for signature, built through the services that own every row. */
    async function seedDeal(): Promise<Deal> {
      const world = await seedJacketWorld(env);
      const out = await openJacket({
        actingUserLinkId: world.seller,
        tenantId: world.tenantId,
        deskingCaseId: world.caseId,
      });
      assert.equal(out.outcome, 'opened', show(out));
      const jacket = (out as { jacket: { jacketId: string; authorizationVersion: number } }).jacket;
      const a = await assemblePackage({
        actingUserLinkId: world.seller,
        tenantId: world.tenantId,
        jacketId: jacket.jacketId,
        expectedVersion: jacket.authorizationVersion,
      });
      assert.equal(a.outcome, 'assembled', show(a));
      let pkg = (a as { package: { packageId: string; authorizationVersion: number } }).package;
      // The agreement carries the approval instant, so two dealerships' agreements are
      // different bytes. (Their privacy notices are IDENTICAL bytes and share one blob:
      // that is content addressing working — a dealership that can produce the bytes
      // already holds them, and it still cannot reach the other's document ROW.)
      const documentSha256 = (
        a as { documents: readonly { contentSha256: string; templateCode: string | null }[] }
      ).documents.find((d) => d.templateCode === 'retail_agreement')!.contentSha256;
      const detail = await jacketDetail(world.tenantId, world.seller, jacket.jacketId);
      const insurance = detail!.checklist.find((i) => i.requirementCode === 'proof_of_insurance')!;
      await waiveRequirement({
        actingUserLinkId: world.manager,
        tenantId: world.tenantId,
        jacketId: jacket.jacketId,
        itemId: insurance.itemId,
        reason: 'binder to follow',
        policyVersion: 3,
        evidenceUri: 'file://x',
        expectedVersion: insurance.authorizationVersion,
      });
      const ready = await markReviewReady({
        actingUserLinkId: world.seller,
        tenantId: world.tenantId,
        packageId: pkg.packageId,
        expectedVersion: pkg.authorizationVersion,
      });
      pkg = (ready as { package: typeof pkg }).package;
      const reviewed = await reviewPackage({
        actingUserLinkId: world.manager,
        tenantId: world.tenantId,
        packageId: pkg.packageId,
        expectedVersion: pkg.authorizationVersion,
      });
      pkg = (reviewed as { package: typeof pkg }).package;
      const sent = await sendPackage({
        actingUserLinkId: world.manager,
        tenantId: world.tenantId,
        packageId: pkg.packageId,
        expectedVersion: pkg.authorizationVersion,
      });
      assert.equal(sent.outcome, 'sent', show(sent));
      return {
        world,
        jacketId: jacket.jacketId,
        packageId: pkg.packageId,
        ceremonyId: (sent as { ceremony: { ceremonyId: string } }).ceremony.ceremonyId,
        documentSha256,
      };
    }

    test('every table this phase adds is secured, and a session without a dealership sees none of it', async () => {
      const deal = await seedDeal();
      assert.ok(deal.jacketId.length > 0);
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

    test('one dealership cannot read, edit or delete another’s jacket, package, documents or signatures', async () => {
      const alpha = await seedDeal();
      const beta = await seedDeal();
      await contextOf(alpha.world.tenantId);

      // NO TENANT PREDICATE ANYWHERE BELOW — that is the point.
      const jackets = await app.query(`SELECT jacket_id FROM deal_jackets`);
      assert.deepEqual(
        jackets.rows.map((r) => String((r as { jacket_id: string }).jacket_id)),
        [alpha.jacketId],
      );
      const packages = await app.query(`SELECT package_id FROM jacket_packages`);
      assert.deepEqual(
        packages.rows.map((r) => String((r as { package_id: string }).package_id)),
        [alpha.packageId],
      );
      const foreignDocs = await app.query(
        `SELECT COUNT(*)::int AS n FROM package_documents WHERE package_id = $1`,
        [beta.packageId],
      );
      assert.equal(Number((foreignDocs.rows[0] as { n: number }).n), 0, 'named directly, and gone');
      const foreignSigners = await app.query(
        `SELECT COUNT(*)::int AS n FROM ceremony_signers WHERE ceremony_id = $1`,
        [beta.ceremonyId],
      );
      assert.equal(Number((foreignSigners.rows[0] as { n: number }).n), 0);
      const foreignEvents = await app.query(
        `SELECT COUNT(*)::int AS n FROM ceremony_events WHERE ceremony_id = $1`,
        [beta.ceremonyId],
      );
      assert.equal(Number((foreignEvents.rows[0] as { n: number }).n), 0);

      // THROUGH THE DECLARED BYPASS, on the app role: the adversary this test exists to watch fail.
      const foreignEdit = await fixtureAuthorizationStateWrite(
        'adversarial-bypass-attempt',
        `UPDATE jacket_packages SET state = 'voided' WHERE package_id = $1`,
        [beta.packageId],
        { executor: app },
      );
      assert.equal(foreignEdit.rowCount, 0, 'an UPDATE naming a foreign row touches nothing');
      const foreignSign = await fixtureAuthorizationStateWrite(
        'adversarial-bypass-attempt',
        `UPDATE ceremony_signers SET state = 'declined', declined_at = NOW(), decline_reason = 'x' WHERE ceremony_id = $1`,
        [beta.ceremonyId],
        { executor: app },
      );
      assert.equal(foreignSign.rowCount, 0);

      // The runtime holds no DELETE on anything this phase adds — one literal
      // statement per table, so the owned-mutation guard can read every one.
      await assert.rejects(() => app.query(`DELETE FROM package_documents`), /permission denied/);
      await assert.rejects(
        () =>
          fixtureAuthorizationStateWrite(
            'adversarial-bypass-attempt',
            `DELETE FROM ceremony_signers`,
            [],
            {
              executor: app,
            },
          ),
        /permission denied/,
      );
      await assert.rejects(() => app.query(`DELETE FROM ceremony_events`), /permission denied/);
      await assert.rejects(
        () =>
          fixtureAuthorizationStateWrite(
            'adversarial-bypass-attempt',
            `DELETE FROM deal_jackets`,
            [],
            {
              executor: app,
            },
          ),
        /permission denied/,
      );
      await assert.rejects(() => app.query(`DELETE FROM document_blobs`), /permission denied/);
    });

    test('a write that names another dealership is refused by the policy, not merely filtered', async () => {
      const alpha = await seedDeal();
      const beta = await seedDeal();
      await contextOf(alpha.world.tenantId);
      await assert.rejects(
        () =>
          app.query(
            `INSERT INTO legal_hold_events (tenant_id, jacket_id, action, reason, acted_by_user_link_id)
             VALUES ($1, $2, 'placed', 'x', $3)`,
            [beta.world.tenantId, beta.jacketId, beta.world.admin],
          ),
        /row-level security|violates/i,
        'writing INTO another dealership is refused by the WITH CHECK, not silently dropped',
      );
    });

    test('the blob store is reachable only through a dealership’s own document rows', async () => {
      const alpha = await seedDeal();
      const beta = await seedDeal();
      await noContext();
      const blind = await app.query(`SELECT COUNT(*)::int AS n FROM document_blobs`);
      assert.equal(Number((blind.rows[0] as { n: number }).n), 0, 'no dealership, no bytes');

      await contextOf(alpha.world.tenantId);
      // The ROUTE to a blob is the document row, and that row is tenant-secured…
      const viaDocument = await app.query(
        `SELECT b.content_sha256 FROM package_documents d JOIN document_blobs b ON b.content_sha256 = d.content_sha256
          WHERE d.content_sha256 = $1`,
        [beta.documentSha256],
      );
      assert.equal(
        viaDocument.rows.length,
        0,
        'another dealership’s document row is not there to follow',
      );
      const own = await app.query(
        `SELECT b.content_sha256 FROM package_documents d JOIN document_blobs b ON b.content_sha256 = d.content_sha256
          WHERE d.content_sha256 = $1`,
        [alpha.documentSha256],
      );
      assert.equal(own.rows.length, 1);
    });

    test('the privileged resolver is not executable by the runtime, and the ordinary one is dealership-bound', async () => {
      const alpha = await seedDeal();
      const beta = await seedDeal();
      await contextOf(alpha.world.tenantId);
      for (const [type, id] of [
        ['deal_jacket', alpha.jacketId],
        ['jacket_package', alpha.packageId],
        ['signing_ceremony', alpha.ceremonyId],
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
      for (const [type, id] of [
        ['deal_jacket', beta.jacketId],
        ['jacket_package', beta.packageId],
        ['signing_ceremony', beta.ceremonyId],
      ] as const) {
        const blind = await app.query(`SELECT resource_org_leaf_visible($1, $2) AS leaf`, [
          type,
          id,
        ]);
        assert.equal(
          (blind.rows[0] as { leaf: string | null }).leaf,
          null,
          `${type}: a foreign row resolves to nothing`,
        );
      }
    });
  },
);
