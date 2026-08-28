import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Client } from 'pg';
import {
  bootstrapAdministrator,
  fixtureAuthorizationStateWrite,
  resetDatabase,
  seedActor,
  seedDealerGroup,
  seedLegalEntity,
  seedRooftop,
  seedTenantIdentity,
  skipIntegration,
  startIdentityTestEnv,
  type IdentityTestEnv,
} from '@dealer/test-kit';
import { closePool } from '@dealer/database';
import { ROLES } from '@dealer/contracts';
import { acquireStock, setStockPrice } from '@dealer/inventory';
import { createApp, resetAuthRoutesForTests, resetIdentityCompositionForTests } from '@dealer/api';

/**
 * RELEASE TRAIN 2, ROW 4 — TENANT AND ROOFTOP INTEGRITY.
 *
 * The row asks for two different guarantees and this battery proves them
 * separately, because passing one says nothing about the other:
 *
 *   * AT THE DATABASE BOUNDARY, through a genuine `dealership_app` connection,
 *     with the attacking statements written WITHOUT tenant predicates — the
 *     "even when application predicates are absent or defective" clause. A
 *     proof made on the pooled owner connection would be worthless, because
 *     migration 062 deliberately does not FORCE row security and the owner
 *     bypasses it.
 *   * AT THE ROOFTOP, through the real HTTP stack, where an employee bound to
 *     one store must be unable to touch another store's car and must not learn
 *     that it exists.
 */
describe(
  'inventory: tenant and rooftop integrity (RT2 row 4)',
  { skip: skipIntegration ? 'set TEST_DATABASE_URL to run' : false },
  () => {
    const OWNER_URL = process.env.TEST_DATABASE_URL as string;
    const APP_PASSWORD = 'rt2_isolation_test_pw';
    let app: Client;
    let server: Server;
    let base: string;
    let env: IdentityTestEnv;

    /** Every table migration 062 secures. */
    const SECURED_TABLES = [
      'parties',
      'party_consents',
      'party_merges',
      'vehicles',
      'vehicle_decodes',
      'stock_items',
      'stock_documents',
      'stock_costs',
      'stock_prices',
      'stock_media',
      'stock_features',
      'stock_holds',
      'stock_transfers',
      'stock_listings',
      'listing_events',
    ] as const;

    interface Dealership {
      tenantId: string;
      rooftopA: string;
      rooftopB: string;
      stockItemId: string;
      partyId: string;
      admin: string;
    }

    let alpha: Dealership;
    let beta: Dealership;

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
      resetIdentityCompositionForTests();
      resetAuthRoutesForTests();
      server = createApp().listen(0);
      await new Promise<void>((resolve) => server.once('listening', () => resolve()));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    after(async () => {
      await app.end();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await env.stop();
      await closePool();
    });

    async function noContext(): Promise<void> {
      // The empty string is how "no context" reads: app_tenant_ctx() NULLIFs
      // it, so every policy matches nothing. RESET would error on a custom GUC
      // the session never defined.
      await app.query(`SELECT set_config('app.tenant_id', '', false)`);
    }

    async function contextOf(tenantId: string): Promise<void> {
      await app.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenantId]);
    }

    async function seedDealership(name: string, vin: string): Promise<Dealership> {
      const tenantId = randomUUID();
      await seedTenantIdentity(tenantId, name);
      const group = await seedDealerGroup({ tenantId, name: `${name} Group`, status: 'active' });
      const entity = await seedLegalEntity({
        tenantId,
        dealerGroupId: group.dealerGroupId,
        name: `${name} LLC`,
        status: 'active',
      });
      const a = await seedRooftop({
        tenantId,
        legalEntityId: entity.legalEntityId,
        name: `${name} North`,
        status: 'active',
      });
      const b = await seedRooftop({
        tenantId,
        legalEntityId: entity.legalEntityId,
        name: `${name} South`,
        status: 'active',
      });
      const admin = await bootstrapAdministrator(tenantId);
      const acquired = await acquireStock({
        actingUserLinkId: admin,
        tenantId,
        rooftopId: a.rooftopId,
        vin,
        stockNumber: 'S1',
        acquisitionSource: 'auction',
        acquiredOn: '2026-08-01',
        referenceYear: 2026,
      });
      assert.equal(acquired.outcome, 'acquired', `${name} must acquire a vehicle`);
      const stockItemId = (acquired as { stockItem: { stockItemId: string } }).stockItem
        .stockItemId;
      await setStockPrice({
        actingUserLinkId: admin,
        tenantId,
        stockItemId,
        priceType: 'internet',
        amountCents: 1000000,
      });
      const party = await fixtureAuthorizationStateWrite(
        'seed-authorization-state',
        `INSERT INTO parties (tenant_id, party_type, display_name, created_by_user_link_id,
                              updated_by_user_link_id)
         VALUES ($1, 'person', $2, $3, $3) RETURNING party_id`,
        [tenantId, `${name} Customer`, admin],
      );
      return {
        tenantId,
        rooftopA: a.rooftopId,
        rooftopB: b.rooftopId,
        stockItemId,
        partyId: String((party.rows[0] as { party_id: unknown }).party_id),
        admin,
      };
    }

    beforeEach(async () => {
      await resetDatabase();
      await noContext();
      alpha = await seedDealership('Alpha', '1HGCM82633A004352');
      beta = await seedDealership('Beta', '5YJ3E1EA7JF000316');
    });

    // ── the database boundary ────────────────────────────────────────────────

    test('row security is enabled, with a policy, on every table this train adds', async () => {
      for (const table of SECURED_TABLES) {
        const r = await app.query(
          `SELECT c.relrowsecurity,
                  (SELECT COUNT(*)::int FROM pg_policies p
                    WHERE p.schemaname = 'public' AND p.tablename = $1) AS policies
             FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relname = $1 AND n.nspname = 'public'`,
          [table],
        );
        assert.equal(r.rows.length, 1, `${table} exists`);
        const row = r.rows[0] as { relrowsecurity: boolean; policies: number };
        assert.equal(row.relrowsecurity, true, `${table} has row security enabled`);
        assert.ok(Number(row.policies) >= 1, `${table} carries a policy`);
      }
    });

    test('deny by default: with no tenant context every secured table is empty', async () => {
      await noContext();
      for (const table of SECURED_TABLES) {
        // No tenant predicate at all — the absent application filter.
        const r = await app.query(`SELECT COUNT(*)::int AS n FROM ${table}`);
        assert.equal(
          Number((r.rows[0] as { n: number }).n),
          0,
          `${table}: two dealerships hold rows, and none are visible without a context`,
        );
      }
      await assert.rejects(
        fixtureAuthorizationStateWrite(
          'adversarial-bypass-attempt',
          `INSERT INTO parties (tenant_id, party_type, display_name, created_by_user_link_id,
                                updated_by_user_link_id)
           VALUES ($1, 'person', 'Ghost', $2, $2)`,
          [alpha.tenantId, alpha.admin],
          { executor: app },
        ),
        /row-level security/,
        'a context-free INSERT is a row-security violation, not a write',
      );
    });

    test('a predicate-free read under one dealership returns only its own rows', async () => {
      await contextOf(alpha.tenantId);
      for (const table of SECURED_TABLES) {
        const r = await app.query(`SELECT tenant_id::text FROM ${table}`);
        for (const row of r.rows as Array<{ tenant_id: string }>) {
          assert.equal(
            row.tenant_id,
            alpha.tenantId,
            `${table}: a predicate-free SELECT surfaced another dealership's row`,
          );
        }
      }
      // …and it is not simply empty: the tables that should have rows do.
      const own = await app.query(`SELECT COUNT(*)::int AS n FROM stock_items`);
      assert.equal(Number((own.rows[0] as { n: number }).n), 1, 'CONTROL: its own car is visible');
    });

    test('cross-dealership reads by exact identifier find nothing', async () => {
      await contextOf(alpha.tenantId);
      for (const [table, column, id] of [
        ['stock_items', 'stock_item_id', beta.stockItemId],
        ['parties', 'party_id', beta.partyId],
      ] as const) {
        const r = await app.query(`SELECT 1 FROM ${table} WHERE ${column} = $1`, [id]);
        assert.equal(r.rows.length, 0, `${table}: another dealership's row is not readable by id`);
      }
    });

    test('cross-dealership writes touch zero rows and refuse at WITH CHECK', async () => {
      await contextOf(alpha.tenantId);
      const upd = await fixtureAuthorizationStateWrite(
        'adversarial-bypass-attempt',
        `UPDATE stock_items SET stock_number = 'STOLEN' WHERE stock_item_id = $1`,
        [beta.stockItemId],
        { executor: app },
      );
      assert.equal(upd.rowCount, 0, "an UPDATE aimed at another dealership's car changes nothing");

      const del = await fixtureAuthorizationStateWrite(
        'adversarial-bypass-attempt',
        `DELETE FROM stock_features WHERE tenant_id = $1`,
        [beta.tenantId],
        { executor: app },
      );
      assert.equal(del.rowCount, 0, 'a DELETE aimed at another dealership deletes nothing');

      await assert.rejects(
        fixtureAuthorizationStateWrite(
          'adversarial-bypass-attempt',
          `INSERT INTO parties (tenant_id, party_type, display_name, created_by_user_link_id,
                                updated_by_user_link_id)
           VALUES ($1, 'person', 'Planted', $2, $2)`,
          [beta.tenantId, alpha.admin],
          { executor: app },
        ),
        /row-level security/,
        "a write stamped with another dealership's id dies in WITH CHECK",
      );

      // Nothing moved, read back from the other dealership's own context.
      await contextOf(beta.tenantId);
      const intact = await app.query(`SELECT stock_number FROM stock_items`);
      assert.equal((intact.rows[0] as { stock_number: string }).stock_number, 'S1');
    });

    test("a tenant-qualified reference to another dealership's parent cannot be created", async () => {
      await contextOf(alpha.tenantId);
      // Alpha's tenant id with Beta's stock item: the composite foreign key
      // names a pair that does not exist.
      await assert.rejects(
        fixtureAuthorizationStateWrite(
          'adversarial-bypass-attempt',
          `INSERT INTO stock_costs
             (tenant_id, stock_item_id, cost_type, amount_cents, incurred_on,
              created_by_user_link_id, updated_by_user_link_id)
           VALUES ($1, $2, 'fee', 100, '2026-08-01', $3, $3)`,
          [alpha.tenantId, beta.stockItemId, alpha.admin],
          { executor: app },
        ),
        (err: unknown) =>
          err instanceof Error && /foreign key|row-level security/.test(err.message),
        "a cost under Alpha referencing Beta's car is refused by the database",
      );

      // CONTROL: the honest same-dealership write from the same context works,
      // so the refusal above is the constraint rather than a broken table.
      const ok = await fixtureAuthorizationStateWrite(
        'simulate-authorization-drift',
        `INSERT INTO stock_costs
           (tenant_id, stock_item_id, cost_type, amount_cents, incurred_on,
            created_by_user_link_id, updated_by_user_link_id)
         VALUES ($1, $2, 'fee', 100, '2026-08-01', $3, $3) RETURNING cost_id`,
        [alpha.tenantId, alpha.stockItemId, alpha.admin],
        { executor: app },
      );
      assert.equal(ok.rows.length, 1);
    });

    test('a forged context naming no real dealership sees nothing', async () => {
      await contextOf(randomUUID());
      for (const table of SECURED_TABLES) {
        const r = await app.query(`SELECT COUNT(*)::int AS n FROM ${table}`);
        assert.equal(
          Number((r.rows[0] as { n: number }).n),
          0,
          `${table} is empty under a forged context`,
        );
      }
    });

    // ── the rooftop boundary, through the real HTTP stack ────────────────────

    test('a rooftop-bound employee cannot reach another rooftop’s car, and is not told it exists', async () => {
      // Two cars in ONE dealership, at two different rooftops.
      const second = await acquireStock({
        actingUserLinkId: alpha.admin,
        tenantId: alpha.tenantId,
        rooftopId: alpha.rooftopB,
        vin: 'JTDKARFU2J3060000',
        stockNumber: 'S2',
        acquisitionSource: 'auction',
        acquiredOn: '2026-08-01',
        referenceYear: 2026,
      });
      assert.equal(second.outcome, 'acquired');
      const southCar = (second as { stockItem: { stockItemId: string } }).stockItem.stockItemId;

      // An employee bound at the NORTH rooftop only.
      const north = await seedActor(env.issuer, {
        tenantId: alpha.tenantId,
        roles: [ROLES.INVENTORY_MANAGER],
        scope: { level: 'rooftop', id: alpha.rooftopA },
      });

      const call = async (method: string, path: string, payload?: unknown) => {
        const res = await fetch(base + path, {
          method,
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${north.token}`,
          },
          ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        });
        const text = await res.text();
        return { status: res.status, body: text ? JSON.parse(text) : null };
      };

      // CONTROL FIRST: their own rooftop's car is readable, so the refusal
      // below cannot be blamed on a broken route or a roleless actor.
      const own = await call('GET', `/api/inventory/stock/${alpha.stockItemId}`);
      assert.equal(own.status, 200, 'CONTROL: the north employee reads the north car');

      // …and the south car is reported as NOT FOUND rather than forbidden, so
      // its existence is never confirmed to someone who may not touch it.
      const other = await call('GET', `/api/inventory/stock/${southCar}`);
      assert.equal(other.status, 404, 'the south car does not exist for the north employee');

      const priced = await call('POST', `/api/inventory/stock/${southCar}/prices`, {
        price_type: 'internet',
        amount_cents: 1,
      });
      assert.equal(priced.status, 404, 'nor can they price it');

      // A car in ANOTHER dealership entirely is equally invisible.
      const foreign = await call('GET', `/api/inventory/stock/${beta.stockItemId}`);
      assert.equal(foreign.status, 404);
    });

    test('an acquisition may not be aimed at a rooftop the employee does not hold', async () => {
      const north = await seedActor(env.issuer, {
        tenantId: alpha.tenantId,
        roles: [ROLES.INVENTORY_MANAGER],
        scope: { level: 'rooftop', id: alpha.rooftopA },
      });
      const acquire = async (rooftopId: string, vin: string, stockNumber: string) => {
        const res = await fetch(base + '/api/inventory/stock', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${north.token}`,
            'idempotency-key': randomUUID(),
          },
          body: JSON.stringify({
            location_id: rooftopId,
            vin,
            stock_number: stockNumber,
            acquisition_source: 'auction',
            acquired_on: '2026-08-01',
          }),
        });
        return res.status;
      };

      // CONTROL: into their own rooftop, which they may.
      assert.equal(
        await acquire(alpha.rooftopA, '1FTFW1ET5DFC10312', 'N1'),
        201,
        'CONTROL: the north employee acquires into north',
      );
      // …and into the other rooftop, which they may not. The action names no
      // resource, so the refusal is an honest 403 rather than a 404.
      assert.equal(await acquire(alpha.rooftopB, '4T1BF1FK5CU513448', 'N2'), 403);
      // …and into ANOTHER DEALERSHIP's rooftop, which does not resolve at all.
      assert.equal(await acquire(beta.rooftopA, 'WBA3A5C51DF598900', 'N3'), 404);
    });
  },
);
