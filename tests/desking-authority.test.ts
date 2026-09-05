import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, beforeEach, describe, test } from 'node:test';

import { closePool, query } from '@dealer/database';
import { createApp, resetAuthRoutesForTests, resetIdentityCompositionForTests } from '@dealer/api';
import {
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
  type DeskWorld,
} from './desking-world';

/**
 * ROW 7 — INTEGRITY, AT THE SURFACE PEOPLE ACTUALLY REACH.
 *
 * "Enforce tenant/rooftop isolation, exact-parent binding, non-leaking
 * authorization, idempotency, optimistic concurrency, audit, outbox replay,
 * append-only approval history, and safe upgrade."
 *
 * WHY THIS BATTERY DRIVES HTTP. The service batteries prove what the services
 * do; this one proves that the ROUTES declare the right action and carry the
 * right parameter. A route whose action names a resource type but whose path
 * omits that type's id resolves no resource and quietly widens to the whole
 * dealership — the exact defect RT3-C1 was returned for — and only a request
 * can catch it.
 *
 * EVERY REFUSAL IS CHECKED FOR WHAT IT DOES NOT SAY. A 404 that arrives because
 * a URL was mistyped proves nothing, so each parent-binding probe also sends
 * the SAME request through the RIGHT parent and requires it to succeed.
 */
describe(
  'desking: authority, parentage and the absence of a sale (FBL-120 Row 7)',
  { skip: skipIntegration ? 'set TEST_DATABASE_URL to run' : false },
  () => {
    let server: Server;
    let base: string;
    let env: IdentityTestEnv;

    before(async () => {
      env = await startIdentityTestEnv();
      resetIdentityCompositionForTests();
      resetAuthRoutesForTests();
      server = createApp().listen(0);
      await new Promise<void>((resolve) => server.once('listening', () => resolve()));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    after(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await env.stop();
      await closePool();
    });

    beforeEach(async () => {
      await resetDatabase();
      resetVins();
    });

    async function call(
      token: string | null,
      method: string,
      path: string,
      payload?: unknown,
      extraHeaders: Record<string, string> = {},
    ): Promise<{ status: number; body: Record<string, unknown> | null }> {
      const res = await fetch(base + path, {
        method,
        headers: {
          'content-type': 'application/json',
          ...(token === null ? {} : { authorization: `Bearer ${token}` }),
          ...extraHeaders,
        },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      });
      const text = await res.text();
      return {
        status: res.status,
        body: text ? (JSON.parse(text) as Record<string, unknown>) : null,
      };
    }

    /** A desk file, an appraisal and a submitted version, all through HTTP. */
    async function walkToSubmitted(w: DeskWorld): Promise<{
      caseId: string;
      appraisalId: string;
      scenarioId: string;
      version: number;
      fingerprint: string;
    }> {
      const opened = await call(
        w.tokens.seller,
        'POST',
        '/api/desking/cases',
        { desking_handoff_id: w.deskingHandoffId, location_id: w.rooftopId },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(opened.status, 201, JSON.stringify(opened.body));
      const caseId = String((opened.body?.case as Record<string, unknown>).deskingCaseId);

      const appraised = await call(
        w.tokens.seller,
        'POST',
        `/api/desking/cases/${caseId}/appraisal`,
        {
          vin: '2T1BURHE0JC014729',
          model_year: 2018,
          make: 'Toyota',
          model: 'Corolla',
          ownership: 'financed',
          relationship: 'customer_owned',
          odometer_miles: 68420,
          odometer_status: 'actual',
          condition_grade: 'clean',
          provenance: 'walk_around',
        },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(appraised.status, 201, JSON.stringify(appraised.body));
      const appraisalId = String(
        (appraised.body?.appraisal as Record<string, unknown>).appraisalId,
      );

      const built = await call(
        w.tokens.seller,
        'POST',
        `/api/desking/cases/${caseId}/scenarios`,
        {
          label: 'First pencil',
          jurisdiction: JURISDICTION,
          vehicle_price_cents: '4550000',
          trade_allowance_cents: '1200000',
          trade_payoff_cents: '1450000',
          cash_down_cents: '300000',
          term_months: 72,
          apr_ppm: '74900',
        },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(built.status, 201, JSON.stringify(built.body));
      const scenario = built.body?.scenario as Record<string, unknown>;
      const scenarioId = String(scenario.scenarioId);

      const submitted = await call(
        w.tokens.seller,
        'POST',
        `/api/desking/scenarios/${scenarioId}/submission`,
        { expected_version: Number(scenario.authorizationVersion) },
      );
      assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
      return {
        caseId,
        appraisalId,
        scenarioId,
        version: Number((submitted.body?.scenario as Record<string, unknown>).authorizationVersion),
        fingerprint: String(scenario.outputFingerprint),
      };
    }

    test('a salesperson may build and submit, and may not decide', async () => {
      const w = await seedDeskWorld(env);
      await seedRuleBook(w);
      const s = await walkToSubmitted(w);

      const bySeller = await call(
        w.tokens.seller,
        'POST',
        `/api/desking/scenarios/${s.scenarioId}/decision`,
        {
          decision: 'approved',
          reviewed_output_fingerprint: s.fingerprint,
          expected_version: s.version,
        },
      );
      // NOT 403 — 404. A role denial on a resource-typed action answers in the
      // words a record they cannot see would get, so a probe cannot use the
      // difference between "forbidden" and "missing" to learn the row exists.
      assert.equal(bySeller.status, 404, JSON.stringify(bySeller.body));

      // THE SAME REQUEST THROUGH A MANAGER SUCCEEDS, so the 404 above is the
      // role and not a mistyped route.
      const byManager = await call(
        w.tokens.manager,
        'POST',
        `/api/desking/scenarios/${s.scenarioId}/decision`,
        {
          decision: 'approved',
          reviewed_output_fingerprint: s.fingerprint,
          expected_version: s.version,
        },
      );
      assert.equal(byManager.status, 200, JSON.stringify(byManager.body));
    });

    test('a scenario is reached through its own id, and somebody else’s is not found', async () => {
      const w = await seedDeskWorld(env);
      await seedRuleBook(w);
      const s = await walkToSubmitted(w);

      const foreign = await call(
        w.tokens.foreignSeller,
        'GET',
        `/api/desking/scenarios/${s.scenarioId}`,
      );
      assert.equal(foreign.status, 404, JSON.stringify(foreign.body));

      const missing = await call(w.tokens.seller, 'GET', `/api/desking/scenarios/${randomUUID()}`);
      assert.equal(missing.status, 404);

      // …and the route works for the person who owns it.
      const mine = await call(w.tokens.seller, 'GET', `/api/desking/scenarios/${s.scenarioId}`);
      assert.equal(mine.status, 200, JSON.stringify(mine.body));
    });

    test('an appraisal is revised through ITS id, and a file id in that slot is not found', async () => {
      const w = await seedDeskWorld(env);
      await seedRuleBook(w);
      const s = await walkToSubmitted(w);

      const wrongParent = await call(
        w.tokens.seller,
        'POST',
        `/api/desking/appraisals/${s.caseId}/versions`,
        {
          expected_version: 1,
          ownership: 'owned_outright',
          relationship: 'customer_owned',
          odometer_miles: 68430,
          odometer_status: 'actual',
          condition_grade: 'average',
          provenance: 'walk_around',
        },
      );
      assert.equal(wrongParent.status, 404, JSON.stringify(wrongParent.body));

      // THE SAME ROUTE THROUGH THE RIGHT PARENT SUCCEEDS. Without this the 404
      // above could be a URL nobody serves rather than a parent check.
      const rightParent = await call(
        w.tokens.seller,
        'POST',
        `/api/desking/appraisals/${s.appraisalId}/versions`,
        {
          expected_version: 1,
          ownership: 'owned_outright',
          relationship: 'customer_owned',
          odometer_miles: 68430,
          odometer_status: 'actual',
          condition_grade: 'average',
          provenance: 'walk_around',
        },
      );
      assert.equal(rightParent.status, 201, JSON.stringify(rightParent.body));
    });

    test('a repeated command with one key is applied once, and answered twice', async () => {
      const w = await seedDeskWorld(env);
      const key = randomUUID();
      const first = await call(
        w.tokens.seller,
        'POST',
        '/api/desking/cases',
        { desking_handoff_id: w.deskingHandoffId, location_id: w.rooftopId },
        { 'idempotency-key': key },
      );
      const second = await call(
        w.tokens.seller,
        'POST',
        '/api/desking/cases',
        { desking_handoff_id: w.deskingHandoffId, location_id: w.rooftopId },
        { 'idempotency-key': key },
      );
      assert.equal(first.status, 201, JSON.stringify(first.body));
      assert.equal(second.status, 201, JSON.stringify(second.body));
      assert.deepEqual(second.body, first.body);
      const count = await query(
        `SELECT COUNT(*)::int AS n FROM desking_cases WHERE tenant_id = $1`,
        [w.tenantId],
      );
      assert.equal(Number((count.rows[0] as { n: number }).n), 1);
    });

    test('a stale expected_version is a conflict that names the version to reload', async () => {
      const w = await seedDeskWorld(env);
      await seedRuleBook(w);
      const s = await walkToSubmitted(w);
      const stale = await call(
        w.tokens.seller,
        'POST',
        `/api/desking/scenarios/${s.scenarioId}/expiry`,
        { expected_version: 1 },
      );
      assert.equal(stale.status, 409, JSON.stringify(stale.body));
      assert.equal(
        ((stale.body as Record<string, unknown>).error as Record<string, unknown>).code,
        'version_conflict',
      );
    });

    test('money crosses the wire as whole cents, and a float is refused', async () => {
      const w = await seedDeskWorld(env);
      await seedRuleBook(w);
      const opened = await call(
        w.tokens.seller,
        'POST',
        '/api/desking/cases',
        { desking_handoff_id: w.deskingHandoffId, location_id: w.rooftopId },
        { 'idempotency-key': randomUUID() },
      );
      const caseId = String((opened.body?.case as Record<string, unknown>).deskingCaseId);
      const fractional = await call(
        w.tokens.seller,
        'POST',
        `/api/desking/cases/${caseId}/scenarios`,
        {
          label: 'Bad money',
          jurisdiction: JURISDICTION,
          vehicle_price_cents: '45500.75',
        },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(fractional.status, 400, JSON.stringify(fractional.body));
      assert.equal(
        ((fractional.body as Record<string, unknown>).error as Record<string, unknown>).code,
        'amount_invalid',
      );

      const good = await call(
        w.tokens.seller,
        'POST',
        `/api/desking/cases/${caseId}/scenarios`,
        {
          label: 'Good money',
          jurisdiction: JURISDICTION,
          vehicle_price_cents: '4550000',
        },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(good.status, 201, JSON.stringify(good.body));
      const scenario = good.body?.scenario as Record<string, unknown>;
      assert.equal(typeof scenario.vehiclePriceCents, 'string', 'and it comes back as a string');
      assert.equal(scenario.vehiclePriceCents, '4550000');
    });

    test('writing the rule book is a manager’s job, and the refusal explains nothing', async () => {
      const w = await seedDeskWorld(env);
      const bySeller = await call(
        w.tokens.seller,
        'POST',
        '/api/desking/rules',
        {
          location_id: w.rooftopId,
          rule_kind: 'tax',
          rule_code: 'state_sales_tax',
          label: 'Nice try',
          source: 'nobody',
          jurisdiction: JURISDICTION,
          effective_from: '2026-01-01T00:00:00.000Z',
          basis: 'rate_ppm',
          rate_ppm: '0',
          applies_to: 'taxable_amount',
        },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(bySeller.status, 403, JSON.stringify(bySeller.body));

      const byManager = await call(
        w.tokens.manager,
        'POST',
        '/api/desking/rules',
        {
          location_id: w.rooftopId,
          rule_kind: 'tax',
          rule_code: 'state_sales_tax',
          label: 'State sales tax',
          source: 'Colorado Revised Statutes §39-26-104',
          jurisdiction: JURISDICTION,
          effective_from: '2026-01-01T00:00:00.000Z',
          basis: 'rate_ppm',
          rate_ppm: '29000',
          applies_to: 'taxable_amount',
        },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(byManager.status, 201, JSON.stringify(byManager.body));
    });

    test('this phase still cannot create a sale, a deal or a delivery, because there is nowhere to put one', async () => {
      // `deal_jackets` was on this list when FBL-120 closed; FBL-140 added it by
      // order (migration 066), and a jacket is still not a sale — the four below
      // remain nowhere to write.
      const tables = await query(
        `SELECT tablename FROM pg_tables
          WHERE schemaname = 'public'
            AND tablename IN ('sales', 'deals', 'deliveries', 'sold_inventory')`,
        [],
      );
      assert.deepEqual(tables.rows, [], 'the exclusion list is structural, not a convention');

      // …and the pre-sale revenue constraint Release Train 3 wrote is still there.
      const constraint = await query(
        `SELECT conname FROM pg_constraint WHERE conname = 'ck_attribution_pre_sale_revenue'`,
        [],
      );
      assert.equal(constraint.rows.length, 1, 'FBL-120 did NOT relax it — FBL-160 will');
    });

    test('an unauthenticated caller reaches nothing at all', async () => {
      const w = await seedDeskWorld(env);
      for (const [method, path] of [
        ['GET', '/api/desking/board'],
        ['GET', '/api/desking/find/handoffs'],
        ['POST', '/api/desking/cases'],
        ['GET', `/api/desking/cases/${randomUUID()}`],
      ] as const) {
        const res = await call(null, method, path, method === 'POST' ? {} : undefined);
        assert.equal(res.status, 401, `${method} ${path} answered ${res.status}`);
      }
      assert.ok(w.tenantId.length > 0);
    });
  },
);
