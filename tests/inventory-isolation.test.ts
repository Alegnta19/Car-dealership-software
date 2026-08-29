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
    /**
     * AN UNRELATED LOW-PRIVILEGE LOGIN. Not the dealership runtime, not a member
     * of anything: the ordinary shape of "some other account exists on this
     * cluster". It must have no path to either resolver, which is a different
     * claim from the runtime having none.
     */
    const STRANGER = 'rt2c2_unrelated_login';
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
      listingId: string;
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
        await owner.query(`DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${STRANGER}') THEN
            CREATE ROLE ${STRANGER} LOGIN;
          END IF;
        END $$`);
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
      const owner = new Client({ connectionString: OWNER_URL });
      await owner.connect();
      try {
        await owner.query(`DROP ROLE IF EXISTS ${STRANGER}`);
      } finally {
        await owner.end();
      }
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
      const listing = await fixtureAuthorizationStateWrite(
        'seed-authorization-state',
        `INSERT INTO stock_listings (tenant_id, stock_item_id, channel, state,
                                     created_by_user_link_id, updated_by_user_link_id)
         VALUES ($1, $2, 'marketplace', 'draft', $3, $3) RETURNING listing_id`,
        [tenantId, stockItemId, admin],
      );
      return {
        tenantId,
        rooftopA: a.rooftopId,
        rooftopB: b.rooftopId,
        stockItemId,
        listingId: String((listing.rows[0] as { listing_id: unknown }).listing_id),
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

    // ── RT2-C1 §2: the resource resolver is not a lookup service ─────────────
    //
    // `resource_org_leaf` reads past row security so the authorization engine
    // can resolve a resource before deciding who may see it. It used to take
    // the tenant as an ARGUMENT, which made that power directly addressable: a
    // runtime connection could name another dealership beside a known stock or
    // listing id and be told which rooftop owned it — no forged context, no
    // broken policy, just a function call. These probes are run on the genuine
    // `dealership_app` connection, because that is who could ask.

    async function leaf(tenantId: string, type: string, id: string): Promise<string | null> {
      const r = await app.query(`SELECT resource_org_leaf($1, $2, $3) AS leaf`, [
        tenantId,
        type,
        id,
      ]);
      const value = (r.rows[0] as { leaf: string | null }).leaf;
      return value === null ? null : String(value);
    }

    /** The RLS-constrained lookup the runtime is actually allowed to use. */
    async function visible(type: string, id: string): Promise<string | null> {
      const r = await app.query(`SELECT resource_org_leaf_visible($1, $2) AS leaf`, [type, id]);
      const value = (r.rows[0] as { leaf: string | null }).leaf;
      return value === null ? null : String(value);
    }

    /**
     * Whatever the bypass resolver does when the runtime calls it: the refusal
     * itself, or the value it should never have produced.
     */
    async function leafAttempt(
      tenantId: string,
      type: string,
      id: string,
    ): Promise<{ refused: true; code: string } | { refused: false; leaf: string | null }> {
      try {
        return { refused: false, leaf: await leaf(tenantId, type, id) };
      } catch (err) {
        return { refused: true, code: String((err as { code?: string }).code ?? 'unknown') };
      }
    }

    // ── RT2-C2 §A: the bypass resolver is not reachable from the runtime ─────
    //
    // RT2-C1 bound `resource_org_leaf` to `app_tenant_ctx()`. That was not a
    // fix: `app.tenant_id` is CLIENT-WRITABLE. Any holder of the runtime login
    // could set it to Beta and ask the SECURITY DEFINER resolver — which reads
    // past row security — for a Beta rooftop, and be told. Authority had moved
    // from one caller-supplied value to another.
    //
    // The fix is a PRIVILEGE, not a predicate: the bypass resolver is executable
    // only by an explicit, non-assumable database-owned role. No session state a
    // client can write reaches it, because none of it changes who you are.

    test('the bypass resolver refuses the runtime under every session state it can set', async () => {
      const attempts: Array<[string, () => Promise<void>]> = [
        ['a bound Alpha context', async () => contextOf(alpha.tenantId)],
        ['app.tenant_id forged to Beta', async () => contextOf(beta.tenantId)],
        ['no context at all', async () => noContext()],
        [
          'app.tenant_id forged to Beta by plain SET',
          async () => {
            await app.query(`SET app.tenant_id = '${beta.tenantId}'`);
          },
        ],
        [
          'after SET ROLE dealership_runtime',
          async () => {
            await app.query('SET ROLE dealership_runtime');
            await app.query(`SELECT set_config('app.tenant_id', $1, false)`, [beta.tenantId]);
          },
        ],
        [
          'after RESET ROLE',
          async () => {
            await app.query('RESET ROLE');
            await app.query(`SELECT set_config('app.tenant_id', $1, false)`, [beta.tenantId]);
          },
        ],
      ];

      for (const [label, arrange] of attempts) {
        await arrange();
        for (const [type, id] of [
          ['stock_item', beta.stockItemId],
          ['stock_listing', beta.listingId],
        ] as const) {
          for (const named of [beta.tenantId, alpha.tenantId]) {
            const got = await leafAttempt(named, type, id);
            assert.equal(
              got.refused,
              true,
              `${label}: resource_org_leaf answered a ${type} question instead of refusing`,
            );
            assert.equal(
              (got as { code: string }).code,
              '42501',
              `${label}: the refusal must be INSUFFICIENT PRIVILEGE, not a lucky null`,
            );
          }
        }
      }

      // The role it would need is one it cannot become.
      await assert.rejects(
        app.query('SET ROLE dealership_evidence_owner'),
        /permission denied|must be (a )?member/i,
        'the runtime cannot assume the role that holds the resolver',
      );
      await app.query('RESET ROLE');
    });

    test('PUBLIC holds no grant on the bypass resolver, and an unrelated login has no path', async () => {
      const acl = await app.query(
        `SELECT COALESCE(array_to_string(p.proacl, ','), '(default: PUBLIC)') AS acl
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname = 'resource_org_leaf'`,
      );
      const entries = String((acl.rows[0] as { acl: string }).acl);
      assert.ok(
        !entries.includes('(default: PUBLIC)'),
        'a NULL proacl IS a PUBLIC grant — the resolver must carry an explicit ACL',
      );
      assert.ok(
        !/(^|,)=X\//.test(entries),
        `PUBLIC still holds EXECUTE on the bypass resolver: ${entries}`,
      );
      assert.ok(
        entries.includes('dealership_evidence_owner=X/'),
        `the non-assumable owner must hold the only granted path: ${entries}`,
      );
      assert.ok(
        !/dealership_runtime=X\/|dealership_app=X\//.test(entries),
        `the runtime must hold no grant of its own: ${entries}`,
      );

      // An unrelated low-privilege login — no dealership membership at all.
      const owner = new Client({ connectionString: OWNER_URL });
      await owner.connect();
      await owner.query(`ALTER ROLE ${STRANGER} PASSWORD '${APP_PASSWORD}'`);
      await owner.end();
      const u = new URL(OWNER_URL);
      u.username = STRANGER;
      u.password = APP_PASSWORD;
      const stranger = new Client({ connectionString: u.toString() });
      await stranger.connect();
      try {
        await assert.rejects(
          stranger.query(`SELECT resource_org_leaf($1, 'stock_item', $2)`, [
            beta.tenantId,
            beta.stockItemId,
          ]),
          /permission denied/i,
          'an unrelated login has no execution path to the bypass resolver',
        );
        await assert.rejects(
          stranger.query(`SELECT resource_org_leaf_visible('stock_item', $1)`, [beta.stockItemId]),
          /permission denied/i,
          'nor to the runtime lookup',
        );
      } finally {
        await stranger.end();
      }
    });

    test('the runtime resolves its own resources through an RLS-constrained lookup, and nothing else', async () => {
      await contextOf(alpha.tenantId);
      assert.equal(
        await visible('stock_item', alpha.stockItemId),
        alpha.rooftopA,
        'CONTROL: the engine can still resolve the car it is authorizing',
      );
      assert.equal(
        await visible('stock_listing', alpha.listingId),
        alpha.rooftopA,
        'CONTROL: and its listing',
      );
      assert.equal(await visible('stock_item', beta.stockItemId), null);
      assert.equal(await visible('stock_listing', beta.listingId), null);

      // No tenant argument exists to supply, and an unbound session sees nothing.
      await noContext();
      for (const [type, id] of [
        ['stock_item', alpha.stockItemId],
        ['stock_listing', alpha.listingId],
        ['stock_item', beta.stockItemId],
        ['stock_listing', beta.listingId],
      ] as const) {
        assert.equal(await visible(type, id), null, `${type} resolves to nothing when unbound`);
      }
      await contextOf(randomUUID());
      assert.equal(await visible('stock_item', alpha.stockItemId), null);
    });

    test('POSITIVE CONTROL: the privileged path still resolves, through the real evidence writer', async () => {
      // Migration 059 §3.4 REFUSES a resource-typed ALLOW whose resource does
      // not resolve. So a decision that lands is the resolver answering — from
      // inside the trigger, on the path that kept its grant.
      const manager = await seedActor(env.issuer, {
        tenantId: alpha.tenantId,
        roles: [ROLES.INVENTORY_MANAGER],
      });
      const res = await fetch(`${base}/api/inventory/stock/${alpha.stockItemId}`, {
        headers: { authorization: `Bearer ${manager.token}` },
      });
      assert.equal(res.status, 200, 'CONTROL: the authorized read succeeds');

      const decided = await fixtureAuthorizationStateWrite(
        'seed-authorization-state',
        `SELECT resource_rooftop_id::text AS rooftop FROM policy_decisions
          WHERE tenant_id = $1 AND decision = 'allow' AND resource_type = 'stock_item'
            AND resource_id = $2
          ORDER BY occurred_at DESC LIMIT 1`,
        [alpha.tenantId, alpha.stockItemId],
      );
      assert.equal(decided.rows.length, 1, 'the ALLOW was recorded, so §3.4 resolved the resource');
      assert.equal(
        String((decided.rows[0] as { rooftop: string }).rooftop),
        alpha.rooftopA,
        "and the rooftop it stamped is the database's own resolution",
      );
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
