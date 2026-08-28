import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, beforeEach, describe, test } from 'node:test';
import {
  resetDatabase,
  seedDealerGroup,
  seedLegalEntity,
  seedRooftop,
  seedTenantIdentity,
  skipIntegration,
  bootstrapAdministrator,
  fixtureAuthorizationStateWrite,
} from '@dealer/test-kit';
import { closePool, query } from '@dealer/database';
import {
  acquireStock,
  addStockMedia,
  requestListingPublication,
  requestListingWithdrawal,
  reconcileListing,
  reconcileListing as reconcile,
  setStockPrice,
  transitionStock,
  getListing,
  listingHistory,
  simulatedProviderRef,
  type ListingOutcome,
  type ListingPort,
} from '@dealer/inventory';
import { runAllJobsOnce, runListingDispatchOnce } from '@dealer/worker';

/**
 * RELEASE TRAIN 2, ROW 3 — PUBLICATION, RETRY, WITHDRAWAL AND RECONCILIATION,
 * "without lost or duplicated business effects".
 *
 * Every claim here is made against the WORKER'S OWN PASS — the function
 * `main --once` calls — rather than against a copy of the dispatch logic, so
 * what is proved is what a deployment runs.
 *
 * The provider is the deterministic simulator the order requires, which is
 * what lets these assertions be exact rather than tolerant: a given listing
 * always meets the same verdict, and a replay always returns the same
 * reference.
 */
describe(
  'inventory: listing publication and reconciliation (RT2 row 3)',
  { skip: skipIntegration ? 'set TEST_DATABASE_URL to run' : false },
  () => {
    let tenantId: string;
    let rooftopId: string;
    let actor: string;

    after(async () => {
      await closePool();
    });

    beforeEach(async () => {
      await resetDatabase();
      tenantId = randomUUID();
      await seedTenantIdentity(tenantId, 'Listing Motors');
      const group = await seedDealerGroup({ tenantId, name: 'Group', status: 'active' });
      const entity = await seedLegalEntity({
        tenantId,
        dealerGroupId: group.dealerGroupId,
        name: 'Entity',
        status: 'active',
      });
      const rooftop = await seedRooftop({
        tenantId,
        legalEntityId: entity.legalEntityId,
        name: 'Main',
        status: 'active',
      });
      rooftopId = rooftop.rooftopId;
      actor = await bootstrapAdministrator(tenantId);
    });

    /** A retail-ready, priced, photographed vehicle — publishable by construction. */
    async function publishableStock(
      vin = '1HGCM82633A004352',
      stockNumber = 'L1',
    ): Promise<string> {
      const acquired = await acquireStock({
        actingUserLinkId: actor,
        tenantId,
        rooftopId,
        vin,
        stockNumber,
        acquisitionSource: 'auction',
        acquiredOn: '2026-08-01',
        referenceYear: 2026,
      });
      assert.equal(acquired.outcome, 'acquired');
      const stockItemId = (acquired as { stockItem: { stockItemId: string } }).stockItem
        .stockItemId;
      await transitionStock({ actingUserLinkId: actor, tenantId, stockItemId, to: 'retail_ready' });
      await setStockPrice({
        actingUserLinkId: actor,
        tenantId,
        stockItemId,
        priceType: 'internet',
        amountCents: 1500000,
      });
      await addStockMedia({
        actingUserLinkId: actor,
        tenantId,
        stockItemId,
        uri: 'https://cdn.example.com/l1.jpg',
      });
      return stockItemId;
    }

    async function outboxRows(): Promise<{ delivered: number; pending: number }> {
      const r = await query(
        `SELECT COUNT(*) FILTER (WHERE delivered_at IS NOT NULL)::int AS delivered,
                COUNT(*) FILTER (WHERE delivered_at IS NULL)::int AS pending
           FROM admin_outbox WHERE tenant_id = $1 AND event_type LIKE 'inventory.%'`,
        [tenantId],
      );
      const row = r.rows[0] as { delivered: number; pending: number };
      return { delivered: Number(row.delivered), pending: Number(row.pending) };
    }

    test('the worker pass publishes a due listing, exactly once', async () => {
      const stockItemId = await publishableStock();
      const requested = await requestListingPublication({
        actingUserLinkId: actor,
        tenantId,
        stockItemId,
        channel: 'cars_com',
      });
      assert.equal(requested.outcome, 'requested');
      const listingId = (requested as { listing: { listingId: string } }).listing.listingId;
      assert.equal((await outboxRows()).pending, 1);

      // THE WORKER'S OWN PASS — the exact function `--once` calls.
      const failed = await runAllJobsOnce();
      assert.deepEqual([...failed], [], 'the dispatch pass must not fail');

      const published = await getListing(tenantId, listingId);
      assert.equal(published?.state, 'published');
      assert.equal(
        published?.externalRef,
        simulatedProviderRef(listingId),
        'the provider reference is recorded',
      );
      assert.ok(published?.publishedAt !== null, 'publication stamps its instant');
      assert.equal((await outboxRows()).pending, 0);

      // EXACTLY ONCE: a second pass finds nothing due and writes no second
      // history row.
      await runAllJobsOnce();
      const history = await listingHistory(tenantId, listingId);
      const publishedEvents = history.filter((h) => h.eventType === 'published');
      assert.equal(publishedEvents.length, 1, 'one publication, one history row');
    });

    test('a REPLAYED delivery performs no second effect', async () => {
      const stockItemId = await publishableStock();
      const requested = await requestListingPublication({
        actingUserLinkId: actor,
        tenantId,
        stockItemId,
        channel: 'cars_com',
      });
      const listingId = (requested as { listing: { listingId: string } }).listing.listingId;
      await runListingDispatchOnce();
      const afterFirst = await getListing(tenantId, listingId);

      // Crash recovery: the event is marked undeliverable again, exactly as a
      // redelivery would arrive. The delivery ledger — not this service — is
      // what makes the effect happen once.
      await query(
        `UPDATE admin_outbox SET delivered_at = NULL
          WHERE tenant_id = $1 AND event_type LIKE 'inventory.%'`,
        [tenantId],
      );
      const result = await runListingDispatchOnce();
      assert.ok(result > 0, 'the replayed event was claimed');

      const history = await listingHistory(tenantId, listingId);
      assert.equal(
        history.filter((h) => h.eventType === 'published').length,
        1,
        'the replay wrote no second publication',
      );
      const afterReplay = await getListing(tenantId, listingId);
      assert.equal(afterReplay?.externalRef, afterFirst?.externalRef, 'and the same reference');
      assert.equal((await outboxRows()).pending, 0);
    });

    test('a REJECTED listing is recorded with its reason and not retried into success', async () => {
      // A vehicle with no photograph is refused by the provider. It is made
      // publishable, then stripped, so the refusal comes from the PROVIDER
      // rather than from the platform's own precondition check.
      const stockItemId = await publishableStock();
      const requested = await requestListingPublication({
        actingUserLinkId: actor,
        tenantId,
        stockItemId,
        channel: 'cars_com',
      });
      const listingId = (requested as { listing: { listingId: string } }).listing.listingId;
      // A DECLARED fixture bypass: no production path strips a car's last
      // photograph while its publication is already in flight, and that race is
      // exactly the state this test needs the provider to meet.
      await fixtureAuthorizationStateWrite(
        'simulate-authorization-drift',
        `UPDATE stock_media SET status = 'removed' WHERE tenant_id = $1 AND stock_item_id = $2`,
        [tenantId, stockItemId],
      );

      await runListingDispatchOnce();
      const rejected = await getListing(tenantId, listingId);
      assert.equal(rejected?.state, 'rejected');
      assert.match(String(rejected?.lastError), /photograph/);
      assert.equal(rejected?.publishedAt, null, 'a rejection publishes nothing');

      const history = await listingHistory(tenantId, listingId);
      assert.equal(history.filter((h) => h.eventType === 'rejected').length, 1);
    });

    test('a DEFERRED channel is retried rather than failed, and succeeds on the retry', async () => {
      const stockItemId = await publishableStock();
      // The simulator defers the first attempt on this channel and accepts the
      // second, which is what gives the retry path something real to exercise.
      const requested = await requestListingPublication({
        actingUserLinkId: actor,
        tenantId,
        stockItemId,
        channel: 'slow_channel',
      });
      const listingId = (requested as { listing: { listingId: string } }).listing.listingId;

      await runListingDispatchOnce();
      const afterFirst = await getListing(tenantId, listingId);
      assert.equal(afterFirst?.state, 'publish_pending', 'a deferral leaves it pending');
      const pending = await query(
        `SELECT attempts, available_at > NOW() AS backed_off FROM admin_outbox
          WHERE tenant_id = $1 AND event_type LIKE 'inventory.%' AND delivered_at IS NULL`,
        [tenantId],
      );
      assert.equal(pending.rows.length, 1, 'the event is still due later, not lost');
      assert.equal(
        (pending.rows[0] as { backed_off: boolean }).backed_off,
        true,
        'and it is backed off rather than hot-looped',
      );

      // Make it due again, as the backoff eventually would.
      await query(
        `UPDATE admin_outbox SET available_at = NOW()
          WHERE tenant_id = $1 AND delivered_at IS NULL`,
        [tenantId],
      );
      await runListingDispatchOnce();
      const afterRetry = await getListing(tenantId, listingId);
      assert.equal(afterRetry?.state, 'published', 'the retry succeeds');
      assert.ok(afterRetry !== null && afterRetry.attempts >= 2, 'and the attempt is counted');
    });

    test('withdrawal takes a published listing down and converges when repeated', async () => {
      const stockItemId = await publishableStock();
      const requested = await requestListingPublication({
        actingUserLinkId: actor,
        tenantId,
        stockItemId,
        channel: 'cars_com',
      });
      const listingId = (requested as { listing: { listingId: string } }).listing.listingId;
      await runListingDispatchOnce();
      const published = await getListing(tenantId, listingId);
      assert.equal(published?.state, 'published');

      await requestListingWithdrawal({ actingUserLinkId: actor, tenantId, listingId });
      await runListingDispatchOnce();
      const withdrawn = await getListing(tenantId, listingId);
      assert.equal(withdrawn?.state, 'withdrawn');
      // THE PUBLICATION HISTORY SURVIVES THE WITHDRAWAL. `published_at` is the
      // fact the dealership reports days-on-market from, and taking the car
      // down must not erase that it was ever up.
      assert.ok(withdrawn?.publishedAt !== null, 'it still records when it went live');
      assert.ok(withdrawn?.withdrawnAt !== null);

      // Withdrawing again converges rather than refusing.
      const again = await requestListingWithdrawal({
        actingUserLinkId: actor,
        tenantId,
        listingId,
      });
      assert.equal(again.outcome, 'requested');
    });

    test('reconciliation corrects the platform when the provider disagrees', async () => {
      const stockItemId = await publishableStock();
      const requested = await requestListingPublication({
        actingUserLinkId: actor,
        tenantId,
        stockItemId,
        channel: 'cars_com',
      });
      const listingId = (requested as { listing: { listingId: string } }).listing.listingId;
      await runListingDispatchOnce();

      // AGREEMENT is the control: without it, a reconciliation that always
      // "corrects" would look identical to one that works.
      const agreed = await reconcile({ tenantId, listingId });
      assert.equal(agreed?.agreed, true);
      assert.equal(agreed?.correctedTo, null);

      // Now the platform believes something the provider does not: the row is
      // marked withdrawn behind the service's back, as a lost delivery would.
      // A DECLARED fixture bypass: this is the platform's record drifting away
      // from the provider's — a lost delivery — which no service will produce
      // on purpose and which reconciliation exists to find.
      await fixtureAuthorizationStateWrite(
        'simulate-authorization-drift',
        `UPDATE stock_listings SET state = 'withdrawn', withdrawn_at = NOW()
          WHERE tenant_id = $1 AND listing_id = $2`,
        [tenantId, listingId],
      );
      const corrected = await reconcileListing({ tenantId, listingId });
      assert.equal(corrected?.agreed, false);
      assert.equal(corrected?.providerHasListing, true);
      assert.equal(
        corrected?.correctedTo,
        'published',
        'the provider is authoritative about its own site',
      );
      const after = await getListing(tenantId, listingId);
      assert.equal(after?.state, 'published');

      const history = await listingHistory(tenantId, listingId);
      assert.ok(
        history.some((h) => h.eventType === 'reconciled'),
        'the disagreement is recorded rather than silently smoothed over',
      );
    });

    test('the two dispatchers share one outbox without consuming each other’s work', async () => {
      const stockItemId = await publishableStock();
      await requestListingPublication({
        actingUserLinkId: actor,
        tenantId,
        stockItemId,
        channel: 'cars_com',
      });
      // An administration event sits beside it, exactly as it would in life.
      await query(
        `INSERT INTO admin_outbox (tenant_id, event_type, payload)
         VALUES ($1, 'admin.staff_invitation.created', '{"invitation_id":null}'::jsonb)`,
        [tenantId],
      );

      // The LISTING dispatcher must take only its own.
      await runListingDispatchOnce();
      const left = await query(
        `SELECT event_type FROM admin_outbox
          WHERE tenant_id = $1 AND delivered_at IS NULL`,
        [tenantId],
      );
      assert.equal(left.rows.length, 1, 'the administration event is untouched');
      assert.equal(
        String((left.rows[0] as { event_type: unknown }).event_type),
        'admin.staff_invitation.created',
      );
    });

    test('a provider that fails outright defers the event instead of losing it', async () => {
      const stockItemId = await publishableStock();
      const requested = await requestListingPublication({
        actingUserLinkId: actor,
        tenantId,
        stockItemId,
        channel: 'cars_com',
      });
      const listingId = (requested as { listing: { listingId: string } }).listing.listingId;

      const throwing: ListingPort = {
        provider: 'exploding',
        async publish(): Promise<ListingOutcome> {
          throw new Error('the provider is unreachable');
        },
        async withdraw(): Promise<ListingOutcome> {
          throw new Error('the provider is unreachable');
        },
        async describe(): Promise<ListingOutcome> {
          throw new Error('the provider is unreachable');
        },
      };

      const { dispatchDueListingEvents } = await import('@dealer/inventory');
      const result = await dispatchDueListingEvents({ port: throwing });
      assert.equal(result.failed, 1, 'the failure is counted, not swallowed');

      const still = await getListing(tenantId, listingId);
      assert.equal(still?.state, 'publish_pending', 'the listing did not advance on a failure');
      const pending = await query(
        `SELECT last_error FROM admin_outbox
          WHERE tenant_id = $1 AND delivered_at IS NULL AND event_type LIKE 'inventory.%'`,
        [tenantId],
      );
      assert.equal(pending.rows.length, 1, 'the event survives to be retried');
      assert.match(String((pending.rows[0] as { last_error: unknown }).last_error), /unreachable/);

      // The delivery-ledger row rolled back with the failed transaction, so the
      // retry is a genuine first delivery rather than a permanent duplicate.
      const ledger = await query(`SELECT COUNT(*)::int AS n FROM admin_outbox_deliveries`);
      assert.equal(Number((ledger.rows[0] as { n: number }).n), 0);
    });
  },
);
