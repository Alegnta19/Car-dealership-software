import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, beforeEach, describe, test } from 'node:test';
import {
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
import { closePool, query, withTenantTransaction } from '@dealer/database';
import { ROLES } from '@dealer/contracts';
import { TENANT_ADMIN_ROLE } from '@dealer/identity-access';
import { createPartyWithin } from '@dealer/inventory';
import { createApp, resetAuthRoutesForTests, resetIdentityCompositionForTests } from '@dealer/api';

/**
 * RELEASE TRAIN 2 — THE ACQUISITION-TO-PUBLISHED-LISTING JOURNEY, through the
 * real HTTP stack against a real database (acceptance rows 1, 2, 3 and 5).
 *
 * One authorized employee walks the whole owner-visible gate: find or create
 * the acquisition party, acquire and decode a VIN, establish one canonical
 * stock identity, record documents and costs, advance to retail-ready, price
 * it, photograph it, merchandise it, hold and transfer it, and publish it —
 * and every state survives a reload with attributable evidence.
 *
 * The refusals are asserted as hard as the successes, because a journey that
 * only proves the happy path proves the platform cannot say no.
 */
describe(
  'inventory: the acquisition-to-listing journey (RT2 rows 1, 2, 3, 5)',
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
    });

    type ParsedJson = ReturnType<typeof JSON.parse>;

    async function call(
      token: string | null,
      method: string,
      path: string,
      payload?: unknown,
      extraHeaders: Record<string, string> = {},
    ) {
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
        contentType: res.headers.get('content-type') ?? '',
        replayed: res.headers.get('idempotency-replayed') === 'true',
        body: text ? (JSON.parse(text) as ParsedJson) : null,
      };
    }

    function assertProblem(
      r: { status: number; contentType: string; body: ParsedJson | null },
      status: number,
      code: string,
    ): void {
      assert.equal(r.status, status, `expected ${status} ${code}, got ${r.status}`);
      assert.match(r.contentType, /application\/problem\+json/);
      assert.equal(r.body!.code, code);
      assert.ok(
        typeof r.body!.correlationId === 'string' && r.body!.correlationId.length > 0,
        'a problem names its correlation identifier',
      );
    }

    async function auditCount(eventType: string, actor: string): Promise<number> {
      const r = await query(
        `SELECT COUNT(*)::int AS n FROM audit_events
          WHERE event_type = $1 AND actor_user_id = $2`,
        [eventType, actor],
      );
      return Number((r.rows[0] as { n: number }).n);
    }

    interface World {
      tenantId: string;
      rooftopId: string;
      secondRooftopId: string;
      manager: { userLinkId: string; token: string };
      clerk: { userLinkId: string; token: string };
    }

    /** A dealership with two rooftops, a manager and a clerk. */
    async function seedWorld(): Promise<World> {
      const tenantId = randomUUID();
      await seedTenantIdentity(tenantId, 'Aurora Auto Group');
      const group = await seedDealerGroup({ tenantId, name: 'Aurora Group', status: 'active' });
      const entity = await seedLegalEntity({
        tenantId,
        dealerGroupId: group.dealerGroupId,
        name: 'Aurora LLC',
        status: 'active',
      });
      const rooftop = await seedRooftop({
        tenantId,
        legalEntityId: entity.legalEntityId,
        name: 'Downtown',
        status: 'active',
      });
      const second = await seedRooftop({
        tenantId,
        legalEntityId: entity.legalEntityId,
        name: 'Northside',
        status: 'active',
      });
      const manager = await seedActor(env.issuer, {
        tenantId,
        roles: [ROLES.INVENTORY_MANAGER],
      });
      const clerk = await seedActor(env.issuer, { tenantId, roles: [ROLES.INVENTORY_CLERK] });
      return {
        tenantId,
        rooftopId: rooftop.rooftopId,
        secondRooftopId: second.rooftopId,
        manager: { userLinkId: manager.userLinkId, token: manager.token },
        clerk: { userLinkId: clerk.userLinkId, token: clerk.token },
      };
    }

    const VIN = '1HGCM82633A004352';

    test('an employee acquires, identifies, merchandises and publishes one vehicle', async () => {
      const w = await seedWorld();
      const t = w.manager.token;

      // ── row 1: the acquisition party ─────────────────────────────────────
      const seller = await call(
        t,
        'POST',
        '/api/inventory/parties',
        {
          party_type: 'person',
          given_name: 'Sarah',
          family_name: 'Bekele',
          email: 'sarah@example.com',
          phone: '555-0100',
        },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(seller.status, 201);
      const sellerId = String(seller.body!.party.partyId);
      assert.equal(seller.body!.party.displayName, 'Sarah Bekele');
      // The phone is normalized to digits on the way in.
      assert.equal(seller.body!.party.phone, '5550100');

      // A second party with the SAME email is detected, not silently created.
      const dup = await call(t, 'POST', '/api/inventory/parties', {
        party_type: 'person',
        given_name: 'Daniel',
        family_name: 'Bekele',
        email: 'sarah@example.com',
      });
      assert.equal(dup.status, 409);
      assert.equal(dup.body!.outcome, 'duplicate');
      assert.equal(dup.body!.candidates[0].matchedOn, 'email');

      // …and a household really can share one, once a human decides so.
      const spouse = await call(t, 'POST', '/api/inventory/parties', {
        party_type: 'person',
        given_name: 'Daniel',
        family_name: 'Bekele',
        email: 'sarah@example.com',
        allow_duplicate: true,
      });
      assert.equal(spouse.status, 201);

      // Consent is opt-in: unknown until recorded.
      const before = await call(t, 'GET', `/api/inventory/parties/${sellerId}/contactable/email`);
      assert.equal(before.body!.contactable, false);
      const consent = await call(t, 'PUT', `/api/inventory/parties/${sellerId}/consents/email`, {
        state: 'granted',
        source: 'signed trade-in form',
      });
      assert.equal(consent.status, 200);
      const afterConsent = await call(
        t,
        'GET',
        `/api/inventory/parties/${sellerId}/contactable/email`,
      );
      assert.equal(afterConsent.body!.contactable, true);

      // ── row 2: acquisition and canonical stock identity ──────────────────
      const badVin = await call(t, 'POST', '/api/inventory/stock', {
        location_id: w.rooftopId,
        vin: '1HGCM82633A00435I',
        stock_number: 'A1234',
        acquisition_source: 'trade_in',
        acquired_on: '2026-08-01',
        acquisition_party_id: sellerId,
      });
      assertProblem(badVin, 422, 'invalid_request');
      assert.match(String(badVin.body!.detail), /I, O and Q/);

      const acquired = await call(
        t,
        'POST',
        '/api/inventory/stock',
        {
          location_id: w.rooftopId,
          vin: '1hg cm82633a004352',
          stock_number: 'a1234',
          acquisition_source: 'trade_in',
          acquired_on: '2026-08-01',
          acquisition_party_id: sellerId,
          odometer: 48250,
        },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(acquired.status, 201);
      const stockItemId = String(acquired.body!.stockItem.stockItemId);
      const vehicleId = String(acquired.body!.vehicle.vehicleId);
      // Normalization happened: spaces stripped, upper-cased.
      assert.equal(acquired.body!.vehicle.vin, VIN);
      assert.equal(acquired.body!.stockItem.stockNumber, 'A1234');
      assert.equal(acquired.body!.stockItem.lifecycleState, 'acquired');
      assert.equal(acquired.body!.vehicleCreated, true);

      // THE SAME VEHICLE CANNOT BE STOCKED TWICE.
      const again = await call(t, 'POST', '/api/inventory/stock', {
        location_id: w.rooftopId,
        vin: VIN,
        stock_number: 'B9999',
        acquisition_source: 'auction',
        acquired_on: '2026-08-02',
      });
      assertProblem(again, 409, 'vehicle_already_stocked');

      // …nor the same stock number reused at that rooftop.
      const numberClash = await call(t, 'POST', '/api/inventory/stock', {
        location_id: w.rooftopId,
        vin: '5YJ3E1EA7JF000316',
        stock_number: 'A1234',
        acquisition_source: 'auction',
        acquired_on: '2026-08-02',
      });
      assertProblem(numberClash, 409, 'duplicate_stock_number');

      // …but the OTHER rooftop may use it, because stock numbers are a
      // rooftop's own series.
      const otherRooftop = await call(
        t,
        'POST',
        '/api/inventory/stock',
        {
          location_id: w.secondRooftopId,
          vin: '5YJ3E1EA7JF000316',
          stock_number: 'A1234',
          acquisition_source: 'auction',
          acquired_on: '2026-08-02',
        },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(otherRooftop.status, 201);

      // A trade-in must name who it came from.
      const noParty = await call(t, 'POST', '/api/inventory/stock', {
        location_id: w.rooftopId,
        vin: 'JTDKARFU2J3060000',
        stock_number: 'C5555',
        acquisition_source: 'trade_in',
        acquired_on: '2026-08-02',
      });
      assertProblem(noParty, 422, 'invalid_request');

      // ── the decode ───────────────────────────────────────────────────────
      const decoded = await call(t, 'POST', `/api/inventory/vehicles/${vehicleId}/decode`);
      assert.equal(decoded.status, 200);
      assert.equal(decoded.body!.outcome, 'decoded');
      assert.equal(decoded.body!.vehicle.make, 'Honda');
      assert.equal(decoded.body!.vehicle.decodeStatus, 'decoded');
      assert.ok(decoded.body!.features.length > 0, 'a decode yields merchandising features');
      // Every attempt is recorded as evidence.
      const decodeRows = await query(
        `SELECT outcome FROM vehicle_decodes WHERE tenant_id = $1 AND vehicle_id = $2`,
        [w.tenantId, vehicleId],
      );
      assert.equal(decodeRows.rows.length, 1);

      // ── documents and costs (readiness = vendor, cost, date) ─────────────
      const title = await call(t, 'POST', `/api/inventory/stock/${stockItemId}/documents`, {
        document_type: 'title',
        status: 'received',
        received_on: '2026-08-02',
        reference: 'TTL-99',
      });
      assert.equal(title.status, 201);
      const recon = await call(t, 'POST', `/api/inventory/stock/${stockItemId}/costs`, {
        cost_type: 'reconditioning',
        amount_cents: 45000,
        status: 'actual',
        vendor: 'Downtown Detail',
        incurred_on: '2026-08-03',
      });
      assert.equal(recon.status, 201);

      // ── lifecycle to retail-ready ────────────────────────────────────────
      const illegal = await call(t, 'POST', `/api/inventory/stock/${stockItemId}/transition`, {
        to: 'not_a_state',
      });
      assertProblem(illegal, 422, 'illegal_transition');

      await call(
        t,
        'POST',
        `/api/inventory/stock/${stockItemId}/transition`,
        { to: 'in_reconditioning' },
        { 'idempotency-key': randomUUID() },
      );
      const ready = await call(
        t,
        'POST',
        `/api/inventory/stock/${stockItemId}/transition`,
        { to: 'retail_ready' },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(ready.status, 200);
      assert.equal(ready.body!.stockItem.lifecycleState, 'retail_ready');
      assert.ok(ready.body!.stockItem.retailReadyAt !== null, 'becoming ready stamps the clock');

      // ── row 3: merchandising ─────────────────────────────────────────────
      // Publication is refused before the car is priced and photographed.
      const tooEarly = await call(t, 'POST', `/api/inventory/stock/${stockItemId}/listings`, {
        channel: 'cars_com',
      });
      assertProblem(tooEarly, 422, 'precondition_unmet');
      assert.match(String(tooEarly.body!.detail), /price/);

      const priced = await call(
        t,
        'POST',
        `/api/inventory/stock/${stockItemId}/prices`,
        { price_type: 'internet', amount_cents: 1899000, reason: 'launch' },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(priced.status, 201);

      const stillNoPhoto = await call(t, 'POST', `/api/inventory/stock/${stockItemId}/listings`, {
        channel: 'cars_com',
      });
      assertProblem(stillNoPhoto, 422, 'precondition_unmet');
      assert.match(String(stillNoPhoto.body!.detail), /photograph/);

      await call(
        t,
        'POST',
        `/api/inventory/stock/${stockItemId}/media`,
        { uri: 'https://cdn.example.com/a1234-1.jpg', caption: 'Front three-quarter' },
        { 'idempotency-key': randomUUID() },
      );

      // A markdown SUPERSEDES rather than overwrites.
      const markdown = await call(
        t,
        'POST',
        `/api/inventory/stock/${stockItemId}/prices`,
        { price_type: 'internet', amount_cents: 1799000, reason: 'aged 30 days' },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(markdown.status, 201);
      assert.ok(markdown.body!.superseded !== null, 'the previous price is superseded, not erased');

      const features = await call(t, 'PUT', `/api/inventory/stock/${stockItemId}/features`, {
        features: [
          { code: 'heated_seats', label: 'Heated seats', source: 'decoded' },
          { code: 'sunroof', label: 'Sunroof', source: 'manual' },
        ],
      });
      assert.equal(features.status, 200);

      // ── holds block publication ──────────────────────────────────────────
      const hold = await call(
        t,
        'POST',
        `/api/inventory/stock/${stockItemId}/holds`,
        { hold_type: 'inspection', reason: 'state safety check' },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(hold.status, 201);
      const heldPublish = await call(t, 'POST', `/api/inventory/stock/${stockItemId}/listings`, {
        channel: 'cars_com',
      });
      assertProblem(heldPublish, 422, 'precondition_unmet');
      assert.match(String(heldPublish.body!.detail), /hold/);
      const released = await call(
        t,
        'POST',
        `/api/inventory/stock/${stockItemId}/holds/${String(hold.body!.hold.holdId)}/release`,
        { release_reason: 'passed' },
      );
      assert.equal(released.status, 200);

      // ── publication ──────────────────────────────────────────────────────
      const published = await call(
        t,
        'POST',
        `/api/inventory/stock/${stockItemId}/listings`,
        { channel: 'cars_com' },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(published.status, 202);
      assert.equal(published.body!.listing.state, 'publish_pending');
      // The request and its outbox event commit together.
      const queued = await query(
        `SELECT event_type FROM admin_outbox WHERE tenant_id = $1 AND delivered_at IS NULL`,
        [w.tenantId],
      );
      assert.equal(queued.rows.length, 1);
      assert.equal(
        String((queued.rows[0] as { event_type: unknown }).event_type),
        'inventory.listing.publish_requested',
      );

      // ── row 6 (owner view) and reload ────────────────────────────────────
      const overview = await call(t, 'GET', '/api/inventory/overview');
      assert.equal(overview.status, 200);
      assert.equal(overview.body!.rooftops.length, 2);
      const row = overview.body!.inventory.rows.find(
        (r: ParsedJson) => r.stockItemId === stockItemId,
      );
      assert.ok(row, 'the acquired vehicle appears in the owner view');
      assert.equal(row.stockNumber, 'A1234');
      assert.equal(row.internetPriceCents, 1799000);
      assert.equal(row.totalCostCents, 45000);
      assert.equal(row.photoCount, 1);
      assert.equal(row.onHold, false);
      assert.ok(row.daysInInventory >= 0, 'aging is computed');

      const detail = await call(t, 'GET', `/api/inventory/stock/${stockItemId}`);
      assert.equal(detail.status, 200);
      assert.equal(detail.body!.vehicle.vin, VIN);
      assert.equal(detail.body!.acquisitionPartyName, 'Sarah Bekele');
      assert.equal(detail.body!.prices.length, 2, 'both prices survive — one live, one superseded');
      assert.equal(detail.body!.features.length, 2);
      assert.equal(detail.body!.documents.length, 1);
      assert.equal(detail.body!.holds.length, 1, 'the released hold is still history');

      // ── row 5: attributable evidence ─────────────────────────────────────
      for (const [eventType, atLeast] of [
        ['inventory.party.created', 2],
        ['inventory.party.consent_recorded', 1],
        ['inventory.vehicle.created', 1],
        ['inventory.vehicle.decoded', 1],
        ['inventory.stock.acquired', 2],
        ['inventory.stock.transitioned', 2],
        ['inventory.stock.document_recorded', 1],
        ['inventory.stock.cost_recorded', 1],
        ['inventory.price.set', 2],
        ['inventory.media.added', 1],
        ['inventory.features.replaced', 1],
        ['inventory.hold.placed', 1],
        ['inventory.hold.released', 1],
        ['inventory.listing.publish_requested', 1],
      ] as const) {
        assert.ok(
          (await auditCount(eventType, w.manager.userLinkId)) >= atLeast,
          `${eventType} is audited and attributed to the employee who did it`,
        );
      }
    });

    // ── row 5: safe commands ─────────────────────────────────────────────────

    test('commands are retry-safe, version-aware, and refuse a reused key', async () => {
      const w = await seedWorld();
      const t = w.manager.token;

      const key = randomUUID();
      const first = await call(
        t,
        'POST',
        '/api/inventory/stock',
        {
          location_id: w.rooftopId,
          vin: VIN,
          stock_number: 'R1',
          acquisition_source: 'auction',
          acquired_on: '2026-08-01',
        },
        { 'idempotency-key': key },
      );
      assert.equal(first.status, 201);
      const stockItemId = String(first.body!.stockItem.stockItemId);

      // THE RETRY REPLAYS. Without this the second call would be refused as a
      // duplicate vehicle — the replay is what makes a network retry safe.
      const retry = await call(
        t,
        'POST',
        '/api/inventory/stock',
        {
          location_id: w.rooftopId,
          vin: VIN,
          stock_number: 'R1',
          acquisition_source: 'auction',
          acquired_on: '2026-08-01',
        },
        { 'idempotency-key': key },
      );
      assert.equal(retry.status, 201);
      assert.equal(retry.replayed, true);
      assert.equal(String(retry.body!.stockItem.stockItemId), stockItemId);
      const count = await query(`SELECT COUNT(*)::int AS n FROM stock_items WHERE tenant_id = $1`, [
        w.tenantId,
      ]);
      assert.equal(Number((count.rows[0] as { n: number }).n), 1, 'one acquisition, not two');

      // The same key on a DIFFERENT request is refused.
      const misused = await call(
        t,
        'POST',
        '/api/inventory/stock',
        {
          location_id: w.rooftopId,
          vin: '5YJ3E1EA7JF000316',
          stock_number: 'R2',
          acquisition_source: 'auction',
          acquired_on: '2026-08-01',
        },
        { 'idempotency-key': key },
      );
      assertProblem(misused, 422, 'idempotency_key_conflict');

      // Optimistic concurrency: a stale version cannot overwrite.
      const detail = await call(t, 'GET', `/api/inventory/stock/${stockItemId}`);
      const version = Number(detail.body!.stockItem.authorizationVersion);
      const ok = await call(t, 'PUT', `/api/inventory/stock/${stockItemId}`, {
        expected_version: version,
        odometer: 51000,
      });
      assert.equal(ok.status, 200);
      const stale = await call(t, 'PUT', `/api/inventory/stock/${stockItemId}`, {
        expected_version: version,
        odometer: 99999,
      });
      assertProblem(stale, 409, 'version_conflict');
      const after = await call(t, 'GET', `/api/inventory/stock/${stockItemId}`);
      assert.equal(after.body!.stockItem.odometer, 51000, 'the stale write changed nothing');
    });

    // ── row 1: merge ─────────────────────────────────────────────────────────

    test('merging two customers preserves both records and moves the relationships', async () => {
      const w = await seedWorld();
      const t = w.manager.token;

      const a = await call(t, 'POST', '/api/inventory/parties', {
        party_type: 'person',
        given_name: 'Chen',
        family_name: 'Wu',
        email: 'chen@example.com',
      });
      const b = await call(t, 'POST', '/api/inventory/parties', {
        party_type: 'person',
        given_name: 'Chen',
        family_name: 'Wu',
        phone: '5550199',
      });
      const survivingId = String(a.body!.party.partyId);
      const mergedId = String(b.body!.party.partyId);

      // The absorbed record owns a vehicle; the merge must move it.
      await call(
        t,
        'POST',
        '/api/inventory/stock',
        {
          location_id: w.rooftopId,
          vin: VIN,
          stock_number: 'M1',
          acquisition_source: 'trade_in',
          acquired_on: '2026-08-01',
          acquisition_party_id: mergedId,
        },
        { 'idempotency-key': randomUUID() },
      );
      await call(t, 'PUT', `/api/inventory/parties/${mergedId}/consents/sms`, {
        state: 'withdrawn',
        source: 'phone call',
      });

      const merged = await call(t, 'POST', '/api/inventory/parties/merge', {
        surviving_party_id: survivingId,
        merged_party_id: mergedId,
        reason: 'same customer, two intake forms',
      });
      assert.equal(merged.status, 200);
      assert.equal(merged.body!.summary.stockItemsRepointed, 1);
      assert.equal(merged.body!.summary.consentsAdopted, 1);

      // BOTH RECORDS SURVIVE. The absorbed one keeps its identifiers and
      // points at the survivor.
      const absorbed = await call(t, 'GET', `/api/inventory/parties/${mergedId}`);
      assert.equal(absorbed.status, 200);
      assert.equal(absorbed.body!.party.status, 'merged');
      assert.equal(absorbed.body!.party.mergedIntoPartyId, survivingId);
      assert.equal(absorbed.body!.party.phone, '5550199', 'its contact details are not erased');

      // The survivor inherited the withdrawal — a 'do not text me' must not be
      // lost by an administrative merge.
      const survivorConsents = await call(t, 'GET', `/api/inventory/parties/${survivingId}`);
      const sms = survivorConsents.body!.consents.find((c: ParsedJson) => c.channel === 'sms');
      assert.ok(sms, 'the survivor inherited the consent record');
      assert.equal(sms.state, 'withdrawn');

      // …and the vehicle now belongs to the survivor.
      const ledger = await query(
        `SELECT moved FROM party_merges WHERE tenant_id = $1 AND merged_party_id = $2`,
        [w.tenantId, mergedId],
      );
      assert.equal(ledger.rows.length, 1, 'the merge is recorded in its own ledger');
    });

    // ── row 1: bounded import ────────────────────────────────────────────────

    test('an import reports every row and never half-loads', async () => {
      const w = await seedWorld();
      const summary = await call(w.manager.token, 'POST', '/api/inventory/parties/import', {
        rows: [
          { given_name: 'Ada', family_name: 'Lovelace', email: 'ada@example.com' },
          { given_name: 'Grace', family_name: 'Hopper', email: 'grace@example.com' },
          { given_name: 'Ada', family_name: 'Duplicate', email: 'ada@example.com' },
          { party_type: 'person' },
        ],
      });
      assert.equal(summary.status, 200);
      assert.equal(summary.body!.created, 2);
      assert.equal(summary.body!.duplicates, 1);
      assert.equal(summary.body!.invalid, 1);
      assert.equal(summary.body!.rows.length, 4, 'every row is reported, not just the failures');
      assert.equal(summary.body!.rows[2].result, 'duplicate');
      assert.equal(summary.body!.rows[3].result, 'invalid');
    });

    // ── row 3: transfers ─────────────────────────────────────────────────────

    test('a transfer moves the vehicle between rooftops and carries authorization with it', async () => {
      const w = await seedWorld();
      const t = w.manager.token;
      const acquired = await call(
        t,
        'POST',
        '/api/inventory/stock',
        {
          location_id: w.rooftopId,
          vin: VIN,
          stock_number: 'T1',
          acquisition_source: 'auction',
          acquired_on: '2026-08-01',
        },
        { 'idempotency-key': randomUUID() },
      );
      const stockItemId = String(acquired.body!.stockItem.stockItemId);

      const requested = await call(
        t,
        'POST',
        `/api/inventory/stock/${stockItemId}/transfers`,
        { to_rooftop_id: w.secondRooftopId, reason: 'better market' },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(requested.status, 201);
      // THE ORIGIN IS DERIVED BY THE DATABASE, not taken from the caller.
      assert.equal(requested.body!.transfer.fromRooftopId, w.rooftopId);
      const transferId = String(requested.body!.transfer.transferId);

      const settled = await call(
        t,
        'POST',
        `/api/inventory/stock/${stockItemId}/transfers/${transferId}/settle`,
        { state: 'completed' },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(settled.status, 200);

      const after = await call(t, 'GET', `/api/inventory/stock/${stockItemId}`);
      assert.equal(
        after.body!.stockItem.rooftopId,
        w.secondRooftopId,
        'completing the transfer is what moves the car',
      );
    });

    // ── row 4 (application half): insufficient role ──────────────────────────

    test('a clerk may work the car and may not price or publish it', async () => {
      const w = await seedWorld();
      const acquired = await call(
        w.clerk.token,
        'POST',
        '/api/inventory/stock',
        {
          location_id: w.rooftopId,
          vin: VIN,
          stock_number: 'K1',
          acquisition_source: 'auction',
          acquired_on: '2026-08-01',
        },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(acquired.status, 201, 'a clerk acquires vehicles');
      const stockItemId = String(acquired.body!.stockItem.stockItemId);

      const photo = await call(
        w.clerk.token,
        'POST',
        `/api/inventory/stock/${stockItemId}/media`,
        { uri: 'https://cdn.example.com/k1.jpg' },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(photo.status, 201, 'a clerk photographs them');

      /*
       * THE REFUSAL SHAPE IS ASYMMETRIC, DELIBERATELY, and this is where that
       * shows. Pricing names a RESOURCE (`stock_item`), so a denial reports
       * the row as NOT FOUND — the platform will not confirm that a car exists
       * to someone who may not act on it, which is the same rule that makes a
       * wrong-rooftop employee indistinguishable from a wrong identifier.
       * Merging names no resource, so its denial is an honest 403.
       *
       * Asserting the exact status per path rather than "denied" is what keeps
       * that distinction from silently collapsing.
       */
      const price = await call(
        w.clerk.token,
        'POST',
        `/api/inventory/stock/${stockItemId}/prices`,
        {
          price_type: 'internet',
          amount_cents: 1000000,
        },
      );
      assert.equal(price.status, 404, 'a clerk does not decide price, and is not told it exists');
      assert.match(price.contentType, /application\/problem\+json/);

      const publish = await call(
        w.clerk.token,
        'POST',
        `/api/inventory/stock/${stockItemId}/listings`,
        { channel: 'cars_com' },
      );
      assert.equal(publish.status, 404, 'a clerk does not decide exposure');

      const merge = await call(w.clerk.token, 'POST', '/api/inventory/parties/merge', {
        surviving_party_id: randomUUID(),
        merged_party_id: randomUUID(),
      });
      assert.equal(merge.status, 403, 'a clerk does not merge customer identities');
      assert.match(merge.contentType, /application\/problem\+json/);

      // …and the manager, who may, is answered on the merits rather than hidden
      // from — which is what proves the 404s above are about authority and not
      // a broken route.
      const managerPrice = await call(
        w.manager.token,
        'POST',
        `/api/inventory/stock/${stockItemId}/prices`,
        { price_type: 'internet', amount_cents: 1000000 },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(managerPrice.status, 201, 'CONTROL: the manager prices the same vehicle');
    });

    test('the unauthenticated and the wrong-role are refused as problems', async () => {
      const w = await seedWorld();
      const anon = await call(null, 'GET', '/api/inventory/overview');
      assert.equal(anon.status, 401);
      assert.match(anon.contentType, /application\/problem\+json/);

      // A service advisor holds no inventory authority at all.
      const advisor = await seedActor(env.issuer, {
        tenantId: w.tenantId,
        roles: [ROLES.SERVICE_ADVISOR],
      });
      const denied = await call(advisor.token, 'GET', '/api/inventory/overview');
      assert.equal(denied.status, 403);

      // …and a tenant administrator holds all of it.
      const admin = await seedActor(env.issuer, {
        tenantId: w.tenantId,
        roles: [TENANT_ADMIN_ROLE],
      });
      const allowed = await call(admin.token, 'GET', '/api/inventory/overview');
      assert.equal(allowed.status, 200);

      const nowhere = await call(admin.token, 'GET', '/api/inventory/does-not-exist');
      assertProblem(nowhere, 404, 'route_not_found');
    });

    // ── RT2-C1 §1: the duplicate decision, under concurrency ─────────────────
    //
    // The five probes the correction is owed. They are written against the real
    // HTTP surface because that is where the concurrency actually happens: two
    // requests, two connections, two transactions, no cooperation between them.

    test('two parallel matching creates produce one customer and one duplicate', async () => {
      const w = await seedWorld();
      const shared = 'race@example.com';

      // TWO TRANSACTIONS THAT GENUINELY OVERLAP, forced rather than hoped for.
      //
      // Firing two HTTP requests with Promise.all does NOT reliably overlap the
      // window that matters — the few microseconds between deciding and
      // writing — so a test built that way passes whether the decision is
      // serialized or not, and proves nothing. This one holds the first
      // transaction OPEN across the second's entire decision, which is the
      // interleaving that used to produce two customers.
      let firstHasWritten!: () => void;
      const written = new Promise<void>((resolve) => (firstHasWritten = resolve));
      let commitNow!: () => void;
      const held = new Promise<void>((resolve) => (commitNow = resolve));

      const mk = (given: string) => ({
        actingUserLinkId: w.manager.userLinkId,
        tenantId: w.tenantId,
        partyType: 'person' as const,
        details: { givenName: given, familyName: 'Race', email: shared },
      });

      const first = withTenantTransaction(w.tenantId, async (tx) => {
        const r = await createPartyWithin(tx, mk('Lea'));
        firstHasWritten();
        await held; // the row exists, uncommitted and invisible to anyone else
        return r;
      });
      await written;

      const second = withTenantTransaction(w.tenantId, (tx) => createPartyWithin(tx, mk('Noor')));

      // WAIT UNTIL THE SECOND IS OBSERVABLY QUEUED BEHIND THE FIRST. This is
      // the assertion, not the setup: releasing the first on a timer would let
      // the probe pass against a build that never serialized anything, because
      // the second would simply read the committed row. An ungranted advisory
      // lock in `pg_locks` is the database saying, in its own words, that the
      // competing decision is waiting its turn.
      let queued = false;
      for (let i = 0; i < 200 && !queued; i += 1) {
        const waiting = await query(
          `SELECT COUNT(*)::int AS n FROM pg_locks
            WHERE locktype = 'advisory' AND NOT granted`,
        );
        queued = Number((waiting.rows[0] as { n: number }).n) > 0;
        if (!queued) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.ok(queued, 'the second create queued behind the first rather than racing it');

      commitNow();
      const [a, b] = await Promise.all([first, second]);

      const outcomes = [a.outcome, b.outcome].sort();
      assert.deepEqual(outcomes, ['created', 'duplicate'], 'one creation, one refusal');
      const refused = (a.outcome === 'duplicate' ? a : b) as {
        outcome: 'duplicate';
        candidates: Array<{ matchedOn: string }>;
      };
      assert.equal(refused.candidates[0]!.matchedOn, 'email', 'and it says why');

      // …and the database holds ONE active party with that address, which is
      // the claim the outcomes are only evidence for.
      const live = await query(
        `SELECT COUNT(*)::int AS n FROM parties
          WHERE tenant_id = $1 AND status = 'active' AND lower(email) = $2`,
        [w.tenantId, shared],
      );
      assert.equal(Number((live.rows[0] as { n: number }).n), 1, 'one row, not two');

      // The same thing through the real surface, which is what staff actually
      // drive: a second create naming a taken address is a 409 carrying the
      // candidate, never a silent second customer.
      const overHttp = await call(
        w.manager.token,
        'POST',
        '/api/inventory/parties',
        { party_type: 'person', given_name: 'Third', family_name: 'Race', email: shared },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(overHttp.status, 409);
      assert.equal(overHttp.body!.outcome, 'duplicate');
    });

    test('an update onto another customer’s contact details is refused, and changes nothing', async () => {
      const w = await seedWorld();
      const t = w.manager.token;
      const mk = async (given: string, email: string, phone: string) => {
        const r = await call(
          t,
          'POST',
          '/api/inventory/parties',
          { party_type: 'person', given_name: given, family_name: 'Hailu', email, phone },
          { 'idempotency-key': randomUUID() },
        );
        assert.equal(r.status, 201);
        return r.body!.party;
      };
      const first = await mk('Meron', 'meron@example.com', '5550111');
      const second = await mk('Tigist', 'tigist@example.com', '5550222');

      const collide = await call(t, 'PUT', `/api/inventory/parties/${second.partyId}`, {
        expected_version: second.authorizationVersion,
        email: 'meron@example.com',
      });
      assert.equal(collide.status, 409, 'the edit is refused');
      assert.equal(collide.body!.code, 'duplicate_party');

      // NEITHER ROW MOVED — not the target, not the party it would have
      // collided with, and the version was not consumed either.
      const after = await query(
        `SELECT party_id::text, email, authorization_version FROM parties
          WHERE tenant_id = $1 ORDER BY email`,
        [w.tenantId],
      );
      const rows = after.rows as Array<{
        party_id: string;
        email: string;
        authorization_version: string;
      }>;
      assert.deepEqual(
        rows.map((r) => r.email),
        ['meron@example.com', 'tigist@example.com'],
        'both customers still hold the address they started with',
      );
      const target = rows.find((r) => r.party_id === second.partyId)!;
      assert.equal(
        Number(target.authorization_version),
        Number(second.authorizationVersion),
        'a refused edit does not burn the version it was offered',
      );
      const collidedWith = rows.find((r) => r.party_id === first.partyId)!;
      assert.equal(
        Number(collidedWith.authorization_version),
        Number(first.authorizationVersion),
        'and the customer it would have collided with is untouched',
      );

      // A phone collision is refused on the same terms.
      const phoneCollide = await call(t, 'PUT', `/api/inventory/parties/${second.partyId}`, {
        expected_version: second.authorizationVersion,
        phone: '555-0111',
      });
      assert.equal(phoneCollide.status, 409, 'the phone is identifying too');
    });

    test('a household shares one address by explicit decision, on create and on edit', async () => {
      const w = await seedWorld();
      const t = w.manager.token;
      const household = 'kebede.family@example.com';

      const first = await call(
        t,
        'POST',
        '/api/inventory/parties',
        { party_type: 'person', given_name: 'Abel', family_name: 'Kebede', email: household },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(first.status, 201);
      assert.equal(
        first.body!.party.contactSharingOverride,
        false,
        'the first holder shares nothing',
      );

      // Without the decision: refused.
      const blocked = await call(
        t,
        'POST',
        '/api/inventory/parties',
        { party_type: 'person', given_name: 'Hanna', family_name: 'Kebede', email: household },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(blocked.status, 409);

      // With it: created, and the row says so out loud.
      const spouse = await call(
        t,
        'POST',
        '/api/inventory/parties',
        {
          party_type: 'person',
          given_name: 'Hanna',
          family_name: 'Kebede',
          email: household,
          allow_duplicate: true,
        },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(spouse.status, 201, 'a household member is a real person');
      assert.equal(spouse.body!.party.contactSharingOverride, true);

      // The same decision is available on an EDIT, and refused without it.
      const third = await call(
        t,
        'POST',
        '/api/inventory/parties',
        {
          party_type: 'person',
          given_name: 'Sami',
          family_name: 'Kebede',
          email: 'sami@example.com',
        },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(third.status, 201);
      const moved = await call(t, 'PUT', `/api/inventory/parties/${third.body!.party.partyId}`, {
        expected_version: third.body!.party.authorizationVersion,
        email: household,
        allow_duplicate: true,
      });
      assert.equal(moved.status, 200, 'the third family member may join the address deliberately');
      assert.equal(moved.body!.party.contactSharingOverride, true);

      const sharing = await query(
        `SELECT COUNT(*)::int AS n FROM parties
          WHERE tenant_id = $1 AND status = 'active' AND lower(email) = $2`,
        [w.tenantId, household],
      );
      assert.equal(Number((sharing.rows[0] as { n: number }).n), 3, 'three people, one inbox');
    });

    test('the override is in the audit trail, and the contact details are not', async () => {
      const w = await seedWorld();
      const t = w.manager.token;
      const household = 'shared.audit@example.com';
      const phone = '5550909';

      const first = await call(
        t,
        'POST',
        '/api/inventory/parties',
        {
          party_type: 'person',
          given_name: 'Yonas',
          family_name: 'Tesfaye',
          email: household,
          phone,
        },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(first.status, 201);
      const spouse = await call(
        t,
        'POST',
        '/api/inventory/parties',
        {
          party_type: 'person',
          given_name: 'Selam',
          family_name: 'Tesfaye',
          email: household,
          phone,
          allow_duplicate: true,
        },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(spouse.status, 201);

      const events = await query(
        `SELECT details FROM audit_events
          WHERE tenant_id = $1 AND event_type = 'inventory.party.created'
            AND entity_id = $2 AND actor_user_id = $3`,
        [w.tenantId, spouse.body!.party.partyId, w.manager.userLinkId],
      );
      assert.equal(events.rows.length, 1, 'the create is attributed exactly once');
      const details = (events.rows[0] as { details: Record<string, unknown> }).details;

      // THAT an override happened, and WHICH records it concerns.
      assert.equal(details.contact_sharing_override, true);
      assert.deepEqual(details.shared_contact_fields, ['email', 'phone']);
      assert.deepEqual(details.shared_contact_with_party_ids, [first.body!.party.partyId]);
      assert.equal(details.shared_contact_party_count, 1);

      // …and NOT the customer's contact details themselves. The row carries
      // those; an audit detail is not the place to copy them to.
      const serialized = JSON.stringify(details);
      assert.ok(!serialized.includes(household), 'the shared email is not copied into the audit');
      assert.ok(!serialized.includes(phone), 'nor the shared phone');
      assert.ok(!serialized.includes('Selam'), 'nor the name');

      // The un-overridden create alongside it is silent about sharing, so the
      // marker means something rather than being always present.
      const plain = await query(
        `SELECT details FROM audit_events
          WHERE tenant_id = $1 AND event_type = 'inventory.party.created' AND entity_id = $2`,
        [w.tenantId, first.body!.party.partyId],
      );
      assert.equal(
        (plain.rows[0] as { details: Record<string, unknown> }).details.contact_sharing_override,
        undefined,
        'an ordinary create carries no override marker',
      );
    });

    test('two dealerships decide independently about the same address', async () => {
      const a = await seedWorld();
      const b = await seedWorld();
      const shared = 'same.person@example.com';

      const inA = await call(
        a.manager.token,
        'POST',
        '/api/inventory/parties',
        { party_type: 'person', given_name: 'Rediet', family_name: 'Alemu', email: shared },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(inA.status, 201);

      // The other dealership has never seen this customer, and the first
      // dealership's record is none of its business.
      const inB = await call(
        b.manager.token,
        'POST',
        '/api/inventory/parties',
        { party_type: 'person', given_name: 'Rediet', family_name: 'Alemu', email: shared },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(inB.status, 201, 'the same address is free in another dealership');

      // …and the second attempt WITHIN that dealership is still refused, so the
      // independence is per-tenant rather than an absence of control.
      const again = await call(
        b.manager.token,
        'POST',
        '/api/inventory/parties',
        { party_type: 'person', given_name: 'Rediet', family_name: 'Alemu', email: shared },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(again.status, 409);

      for (const [tenantId, label] of [
        [a.tenantId, 'first'],
        [b.tenantId, 'second'],
      ] as const) {
        const n = await query(
          `SELECT COUNT(*)::int AS n FROM parties WHERE tenant_id = $1 AND lower(email) = $2`,
          [tenantId, shared],
        );
        assert.equal(Number((n.rows[0] as { n: number }).n), 1, `${label} dealership holds one`);
      }
    });
  },
);
