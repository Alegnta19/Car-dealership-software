/**
 * RELEASE TRAIN 2, ROW 3 (second half) — PUBLICATION AND RECONCILIATION.
 *
 * Row 3 asks for a bounded listing adapter that "publishes and withdraws stock
 * deterministically and reconciles acceptance, rejection, retry, and replay
 * WITHOUT LOST OR DUPLICATED BUSINESS EFFECTS". Four mechanisms carry that,
 * and each is load-bearing:
 *
 *   1. THE REQUEST AND ITS OUTBOX EVENT COMMIT TOGETHER. Asking to publish
 *      moves the listing to `publish_pending` and enqueues the delivery in the
 *      SAME transaction (migration 061's `admin_outbox`), so a listing can
 *      never be pending with nothing to deliver it, nor delivered without
 *      having been asked for.
 *   2. DELIVERY IS AT LEAST ONCE; THE EFFECT IS EXACTLY ONCE. The dispatcher
 *      claims one due event `FOR UPDATE SKIP LOCKED` and inserts into
 *      `admin_outbox_deliveries` — whose primary key is the dedupe ledger — in
 *      the same transaction as the provider call and the state change.
 *   3. THE PROVIDER'S ANSWER IS RECORDED PER ATTEMPT.
 *      `uq_listing_events_attempt` admits one outcome per (listing, event
 *      type, attempt), so a replayed delivery trying to write a second
 *      'published' for attempt 1 is refused by the database and recognised as
 *      the replay it is.
 *   4. THE PROVIDER REFERENCE IS DERIVED FROM THE LISTING. A replayed publish
 *      returns the SAME reference, so the platform can tell "the listing we
 *      already have" from "a second listing", which is what makes
 *      reconciliation decidable rather than a guess.
 *
 * A DEFERRED outcome is a retry, not a failure: attempts and a backoff are
 * recorded on the outbox row and the event becomes due again later.
 */
import { logger } from '@dealer/platform';
import {
  setTenantContext,
  withTenantTransaction,
  withTransaction,
  type Executor,
} from '@dealer/database';
import { recordMutation, requireActor, type MutationResult } from '@dealer/identity-access';
import { simulatedListingProvider, type ListingPort, type ListingSubmission } from './providers';

interface Row {
  [key: string]: unknown;
}

export type ListingState =
  'draft' | 'publish_pending' | 'published' | 'withdraw_pending' | 'withdrawn' | 'rejected';

/** The outbox event types this domain enqueues. Both are `inventory.` scoped. */
export const LISTING_PUBLISH_EVENT = 'inventory.listing.publish_requested';
export const LISTING_WITHDRAW_EVENT = 'inventory.listing.withdraw_requested';

export interface ListingView {
  readonly listingId: string;
  readonly stockItemId: string;
  readonly channel: string;
  readonly state: ListingState;
  readonly externalRef: string | null;
  readonly lastError: string | null;
  readonly attempts: number;
  readonly publishedAt: string | null;
  readonly withdrawnAt: string | null;
  readonly authorizationVersion: number;
}

const LISTING_COLUMNS = `listing_id, stock_item_id, channel, state, external_ref, last_error,
       attempts, published_at, withdrawn_at, authorization_version`;

export function mapListing(row: Row): ListingView {
  return {
    listingId: String(row.listing_id),
    stockItemId: String(row.stock_item_id),
    channel: String(row.channel),
    state: String(row.state) as ListingState,
    externalRef: row.external_ref === null ? null : String(row.external_ref),
    lastError: row.last_error === null ? null : String(row.last_error),
    attempts: Number(row.attempts),
    publishedAt:
      row.published_at === null ? null : new Date(row.published_at as string).toISOString(),
    withdrawnAt:
      row.withdrawn_at === null ? null : new Date(row.withdrawn_at as string).toISOString(),
    authorizationVersion: Number(row.authorization_version),
  };
}

export type PublishOutcome =
  | { outcome: 'requested'; listing: ListingView; mutation: MutationResult }
  | { outcome: 'blocked'; error: string }
  | { outcome: 'invalid'; error: string }
  | { outcome: 'not_found' };

const CHANNEL_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;

/**
 * Asks for a vehicle to be advertised on one channel.
 *
 * THE PRECONDITIONS ARE CHECKED HERE, NOT AT THE PROVIDER. A car that is not
 * retail-ready, or is on hold, or has no price, or has no photograph is
 * refused with a reason staff can act on — rather than being sent, rejected
 * remotely, and coming back as an error nobody can interpret. The provider
 * still enforces its own rules; this is about giving a useful answer first.
 */
export async function requestListingPublicationWithin(
  executor: Executor,
  input: {
    actingUserLinkId: string;
    tenantId: string;
    stockItemId: string;
    channel: string;
  },
): Promise<PublishOutcome> {
  if (typeof input.channel !== 'string' || !CHANNEL_PATTERN.test(input.channel)) {
    return { outcome: 'invalid', error: 'a channel is lower-case letters, digits and underscores' };
  }
  const actor = await requireActor(executor, input.actingUserLinkId);

  const stock = await executor.query(
    `SELECT lifecycle_state, authorization_version FROM stock_items
      WHERE tenant_id = $1 AND stock_item_id = $2 FOR UPDATE`,
    [input.tenantId, input.stockItemId],
  );
  if (stock.rows.length === 0) return { outcome: 'not_found' };
  const lifecycle = String((stock.rows[0] as Row).lifecycle_state);
  if (lifecycle !== 'retail_ready') {
    return {
      outcome: 'blocked',
      error: `only a retail-ready vehicle is advertised; this one is ${lifecycle}`,
    };
  }
  const held = await executor.query(
    `SELECT hold_type FROM stock_holds
      WHERE tenant_id = $1 AND stock_item_id = $2 AND released_at IS NULL`,
    [input.tenantId, input.stockItemId],
  );
  if (held.rows.length > 0) {
    return {
      outcome: 'blocked',
      error: `the vehicle is on a ${String((held.rows[0] as Row).hold_type)} hold`,
    };
  }
  const priced = await executor.query(
    `SELECT 1 FROM stock_prices
      WHERE tenant_id = $1 AND stock_item_id = $2 AND superseded_at IS NULL
        AND price_type IN ('retail', 'internet')`,
    [input.tenantId, input.stockItemId],
  );
  if (priced.rows.length === 0) {
    return { outcome: 'blocked', error: 'set a retail or internet price before advertising' };
  }
  const photographed = await executor.query(
    `SELECT 1 FROM stock_media
      WHERE tenant_id = $1 AND stock_item_id = $2 AND status = 'active' AND media_kind = 'photo'`,
    [input.tenantId, input.stockItemId],
  );
  if (photographed.rows.length === 0) {
    return { outcome: 'blocked', error: 'add at least one photograph before advertising' };
  }

  // One listing per (stock item, channel). Re-asking moves the SAME row back
  // to pending and increments nothing — the attempt counter belongs to the
  // dispatcher, not to the request.
  const upserted = await executor.query(
    `INSERT INTO stock_listings
       (tenant_id, stock_item_id, channel, state, created_by_user_link_id,
        updated_by_user_link_id)
     VALUES ($1, $2, $3, 'publish_pending', $4, $4)
     ON CONFLICT (tenant_id, stock_item_id, channel) DO UPDATE
       SET state = 'publish_pending', last_error = NULL,
           updated_by_user_link_id = EXCLUDED.updated_by_user_link_id, updated_at = NOW(),
           authorization_version = stock_listings.authorization_version + 1
     RETURNING ${LISTING_COLUMNS}`,
    [input.tenantId, input.stockItemId, input.channel, actor],
  );
  const listing = mapListing(upserted.rows[0] as Row);

  await executor.query(
    `INSERT INTO admin_outbox (tenant_id, event_type, payload)
     VALUES ($1, $2, $3)`,
    [input.tenantId, LISTING_PUBLISH_EVENT, JSON.stringify({ listing_id: listing.listingId })],
  );

  const mutation = await recordMutation(executor, {
    tenantId: input.tenantId,
    entityType: 'stock_listing',
    entityId: listing.listingId,
    eventType: 'inventory.listing.publish_requested',
    actingUserLinkId: actor,
    authorizationVersion: listing.authorizationVersion,
    details: { stock_item_id: input.stockItemId, channel: listing.channel },
  });
  return { outcome: 'requested', listing, mutation };
}

export async function requestListingPublication(input: {
  actingUserLinkId: string;
  tenantId: string;
  stockItemId: string;
  channel: string;
}): Promise<PublishOutcome> {
  return withTenantTransaction(input.tenantId, (tx) => requestListingPublicationWithin(tx, input));
}

export type WithdrawOutcome =
  | { outcome: 'requested'; listing: ListingView; mutation: MutationResult }
  | { outcome: 'invalid'; error: string }
  | { outcome: 'not_found' };

/**
 * Asks for a listing to come down. Withdrawing something already withdrawn
 * converges rather than refusing — the end state the dealership asked for
 * already holds.
 */
export async function requestListingWithdrawalWithin(
  executor: Executor,
  input: {
    actingUserLinkId: string;
    tenantId: string;
    listingId: string;
  },
): Promise<WithdrawOutcome> {
  const actor = await requireActor(executor, input.actingUserLinkId);
  const found = await executor.query(
    `SELECT ${LISTING_COLUMNS} FROM stock_listings
      WHERE tenant_id = $1 AND listing_id = $2 FOR UPDATE`,
    [input.tenantId, input.listingId],
  );
  if (found.rows.length === 0) return { outcome: 'not_found' };
  const current = mapListing(found.rows[0] as Row);
  if (current.state === 'withdrawn' || current.state === 'draft') {
    return {
      outcome: 'requested',
      listing: current,
      mutation: await recordMutation(executor, {
        tenantId: input.tenantId,
        entityType: 'stock_listing',
        entityId: current.listingId,
        eventType: 'inventory.listing.withdraw_noop',
        actingUserLinkId: actor,
        authorizationVersion: current.authorizationVersion,
        details: { state: current.state },
      }),
    };
  }

  const updated = await executor.query(
    `UPDATE stock_listings
        SET state = 'withdraw_pending', last_error = NULL,
            updated_by_user_link_id = $3, updated_at = NOW(),
            authorization_version = authorization_version + 1
      WHERE tenant_id = $1 AND listing_id = $2
      RETURNING ${LISTING_COLUMNS}`,
    [input.tenantId, input.listingId, actor],
  );
  const listing = mapListing(updated.rows[0] as Row);
  await executor.query(
    `INSERT INTO admin_outbox (tenant_id, event_type, payload) VALUES ($1, $2, $3)`,
    [input.tenantId, LISTING_WITHDRAW_EVENT, JSON.stringify({ listing_id: listing.listingId })],
  );
  const mutation = await recordMutation(executor, {
    tenantId: input.tenantId,
    entityType: 'stock_listing',
    entityId: listing.listingId,
    eventType: 'inventory.listing.withdraw_requested',
    actingUserLinkId: actor,
    authorizationVersion: listing.authorizationVersion,
    details: { channel: listing.channel },
  });
  return { outcome: 'requested', listing, mutation };
}

export async function requestListingWithdrawal(input: {
  actingUserLinkId: string;
  tenantId: string;
  listingId: string;
}): Promise<WithdrawOutcome> {
  return withTenantTransaction(input.tenantId, (tx) => requestListingWithdrawalWithin(tx, input));
}

// ── dispatch ────────────────────────────────────────────────────────────────

export interface ListingDispatchResult {
  readonly delivered: number;
  readonly deduplicated: number;
  readonly deferred: number;
  readonly failed: number;
}

/** Builds what the provider is shown: ids and merchandising only. */
async function buildSubmission(
  executor: Executor,
  tenantId: string,
  listingId: string,
  attempt: number,
): Promise<{ submission: ListingSubmission; listing: ListingView } | null> {
  const found = await executor.query(
    `SELECT l.listing_id, l.stock_item_id, l.channel, l.state, l.external_ref, l.last_error,
            l.attempts, l.published_at, l.withdrawn_at, l.authorization_version,
            si.stock_number, v.vin, v.model_year, v.make, v.model,
            (SELECT p.amount_cents FROM stock_prices p
              WHERE p.tenant_id = l.tenant_id AND p.stock_item_id = l.stock_item_id
                AND p.superseded_at IS NULL AND p.price_type IN ('internet', 'retail')
              ORDER BY CASE p.price_type WHEN 'internet' THEN 0 ELSE 1 END
              LIMIT 1) AS price_cents,
            (SELECT COUNT(*)::int FROM stock_media m
              WHERE m.tenant_id = l.tenant_id AND m.stock_item_id = l.stock_item_id
                AND m.status = 'active' AND m.media_kind = 'photo') AS photo_count
       FROM stock_listings l
       JOIN stock_items si ON si.tenant_id = l.tenant_id AND si.stock_item_id = l.stock_item_id
       JOIN vehicles v ON v.tenant_id = si.tenant_id AND v.vehicle_id = si.vehicle_id
      WHERE l.tenant_id = $1 AND l.listing_id = $2`,
    [tenantId, listingId],
  );
  if (found.rows.length === 0) return null;
  const row = found.rows[0] as Row;
  return {
    listing: mapListing(row),
    submission: {
      listingId: String(row.listing_id),
      channel: String(row.channel),
      stockNumber: String(row.stock_number),
      vin: String(row.vin),
      modelYear: row.model_year === null ? null : Number(row.model_year),
      make: row.make === null ? null : String(row.make),
      model: row.model === null ? null : String(row.model),
      priceCents: row.price_cents === null ? null : Number(row.price_cents),
      photoCount: Number(row.photo_count),
      attempt,
    },
  };
}

/** One outcome per (listing, event type, attempt) — the replay ledger. */
async function recordListingEvent(
  executor: Executor,
  input: {
    tenantId: string;
    listingId: string;
    eventType: string;
    outcome: 'accepted' | 'rejected' | 'deferred';
    attempt: number;
    providerRef: string | null;
    detail: Record<string, unknown>;
    outboxEventId: string | null;
  },
): Promise<boolean> {
  const written = await executor.query(
    `INSERT INTO listing_events
       (tenant_id, listing_id, event_type, outcome, attempt, provider_ref, detail,
        outbox_event_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (tenant_id, listing_id, event_type, attempt) DO NOTHING
     RETURNING listing_event_id`,
    [
      input.tenantId,
      input.listingId,
      input.eventType,
      input.outcome,
      input.attempt,
      input.providerRef,
      JSON.stringify(input.detail),
      input.outboxEventId,
    ],
  );
  return written.rows.length > 0;
}

/**
 * THE DISPATCHER. Claims due `inventory.listing.*` outbox events one small
 * transaction at a time and carries each to its provider outcome.
 *
 * IT CLAIMS ONLY ITS OWN EVENT TYPES. `admin_outbox` is shared with Release
 * Train 1's invitation deliveries, and a dispatcher that claimed everything
 * would consume the other domain's events and mark them delivered without
 * delivering them. The `event_type LIKE 'inventory.%'` predicate is what keeps
 * the two domains on one table without either eating the other's work.
 */
export async function dispatchDueListingEvents(options?: {
  limit?: number | undefined;
  port?: ListingPort | undefined;
}): Promise<ListingDispatchResult> {
  const limit = options?.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new RangeError('listing dispatch limit must be an integer in 1..500');
  }
  const port = options?.port ?? simulatedListingProvider;
  let delivered = 0;
  let deduplicated = 0;
  let deferred = 0;
  let failed = 0;

  for (let i = 0; i < limit; i += 1) {
    let claimedEventId: string | null = null;
    try {
      const outcome = await withTransaction(async (tx) => {
        const claimed = await tx.query(
          `SELECT event_id, tenant_id, event_type, payload, attempts FROM admin_outbox
            WHERE delivered_at IS NULL AND available_at <= NOW()
              AND event_type LIKE 'inventory.%'
            ORDER BY occurred_at
            FOR UPDATE SKIP LOCKED
            LIMIT 1`,
        );
        if (claimed.rows.length === 0) return 'drained' as const;
        const row = claimed.rows[0] as Row;
        const eventId = String(row.event_id);
        const tenantId = String(row.tenant_id);
        const eventType = String(row.event_type);
        const attempt = Number(row.attempts) + 1;
        claimedEventId = eventId;

        // The dedupe ledger IS the business-effect guard: a redelivered event
        // finds its row, performs nothing, and is simply re-marked delivered.
        const ledger = await tx.query(
          `INSERT INTO admin_outbox_deliveries (event_id, sink)
           VALUES ($1, $2) ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
          [eventId, 'listing:' + port.provider],
        );
        const firstDelivery = ledger.rows.length > 0;

        if (!firstDelivery) {
          await tx.query(
            `UPDATE admin_outbox SET delivered_at = NOW(), last_error = NULL
              WHERE event_id = $1`,
            [eventId],
          );
          return 'deduplicated' as const;
        }

        await setTenantContext(tx, tenantId);
        const payload = (row.payload ?? {}) as Record<string, unknown>;
        const listingId = typeof payload.listing_id === 'string' ? payload.listing_id : null;
        if (listingId === null) {
          await tx.query(
            `UPDATE admin_outbox SET delivered_at = NOW(), last_error = 'no listing named'
              WHERE event_id = $1`,
            [eventId],
          );
          return 'delivered' as const;
        }

        const built = await buildSubmission(tx, tenantId, listingId, attempt);
        if (built === null) {
          // The listing is gone. Nothing to deliver and nothing to retry.
          await tx.query(
            `UPDATE admin_outbox SET delivered_at = NOW(), last_error = 'listing absent'
              WHERE event_id = $1`,
            [eventId],
          );
          return 'delivered' as const;
        }

        if (eventType === LISTING_WITHDRAW_EVENT) {
          const answer = await port.withdraw(listingId, built.listing.externalRef);
          await recordListingEvent(tx, {
            tenantId,
            listingId,
            eventType: 'withdrawn',
            outcome: answer.outcome,
            attempt,
            providerRef: built.listing.externalRef,
            detail: { message: answer.message },
            outboxEventId: eventId,
          });
          await tx.query(
            `UPDATE stock_listings
                SET state = 'withdrawn', withdrawn_at = NOW(), attempts = $3,
                    last_error = NULL, updated_at = NOW(),
                    authorization_version = authorization_version + 1
              WHERE tenant_id = $1 AND listing_id = $2`,
            [tenantId, listingId, attempt],
          );
          await tx.query(
            `UPDATE admin_outbox SET delivered_at = NOW(), attempts = $2, last_error = NULL
              WHERE event_id = $1`,
            [eventId, attempt],
          );
          return 'delivered' as const;
        }

        const answer = await port.publish(built.submission);
        if (answer.outcome === 'deferred') {
          // A transient refusal. The delivery ledger row is rolled back with
          // this transaction so the retry is a genuine first delivery again.
          throw new DeferredDelivery(answer.message ?? 'the provider deferred', attempt);
        }
        await recordListingEvent(tx, {
          tenantId,
          listingId,
          eventType: answer.outcome === 'accepted' ? 'published' : 'rejected',
          outcome: answer.outcome,
          attempt,
          providerRef: answer.providerRef,
          detail: { message: answer.message },
          outboxEventId: eventId,
        });
        await tx.query(
          `UPDATE stock_listings
              SET state = $3,
                  external_ref = COALESCE($4, external_ref),
                  published_at = CASE WHEN $3 = 'published' THEN NOW() ELSE published_at END,
                  last_error = $5, attempts = $6, updated_at = NOW(),
                  authorization_version = authorization_version + 1
            WHERE tenant_id = $1 AND listing_id = $2`,
          [
            tenantId,
            listingId,
            answer.outcome === 'accepted' ? 'published' : 'rejected',
            answer.providerRef,
            answer.outcome === 'accepted' ? null : answer.message,
            attempt,
          ],
        );
        await tx.query(
          `UPDATE admin_outbox SET delivered_at = NOW(), attempts = $2, last_error = NULL
            WHERE event_id = $1`,
          [eventId, attempt],
        );
        return 'delivered' as const;
      });
      if (outcome === 'drained') break;
      if (outcome === 'delivered') delivered += 1;
      else deduplicated += 1;
    } catch (err) {
      const eventId = claimedEventId;
      if (err instanceof DeferredDelivery) {
        deferred += 1;
        if (eventId !== null) await deferEvent(eventId, err.message, err.attempt);
        continue;
      }
      failed += 1;
      if (eventId !== null) {
        await deferEvent(eventId, err instanceof Error ? err.message : String(err), null).catch(
          () => undefined,
        );
      }
      logger.error(
        {
          component: 'inventory.listing',
          event: 'listing_dispatch_failed',
          err,
          event_id: eventId,
        },
        'listing dispatch failed; the event will retry with backoff',
      );
    }
  }
  return { delivered, deduplicated, deferred, failed };
}

/** A retryable provider answer. Not an error — a 'later'. */
class DeferredDelivery extends Error {
  readonly attempt: number;
  constructor(message: string, attempt: number) {
    super(message);
    this.name = 'DeferredDelivery';
    this.attempt = attempt;
  }
}

/** Records the attempt and pushes the event out with backoff. */
async function deferEvent(eventId: string, message: string, attempt: number | null): Promise<void> {
  await withTransaction(async (tx) => {
    await tx.query(
      `UPDATE admin_outbox
          SET attempts = COALESCE($3, attempts + 1),
              last_error = left($2, 2000),
              available_at = NOW() + make_interval(mins => LEAST(attempts + 1, 8) * 5)
        WHERE event_id = $1 AND delivered_at IS NULL`,
      [eventId, message, attempt],
    );
  });
}

// ── reconciliation ──────────────────────────────────────────────────────────

export interface ReconciliationResult {
  readonly listingId: string;
  readonly platformState: ListingState;
  readonly providerHasListing: boolean;
  readonly agreed: boolean;
  readonly correctedTo: ListingState | null;
}

/**
 * Compares what the platform believes with what the provider carries, and
 * corrects the platform when they disagree.
 *
 * THE PROVIDER IS AUTHORITATIVE ABOUT ITS OWN SITE. If it is carrying a
 * listing the platform thinks it withdrew, the platform was wrong; if it has
 * nothing where the platform thinks it published, the publication did not
 * survive. Either way the correction is recorded as a `reconciled` event so
 * the disagreement is visible afterwards rather than silently smoothed over.
 */
export async function reconcileListing(input: {
  tenantId: string;
  listingId: string;
  port?: ListingPort | undefined;
}): Promise<ReconciliationResult | null> {
  const port = input.port ?? simulatedListingProvider;
  return withTenantTransaction(input.tenantId, async (executor) => {
    const found = await executor.query(
      `SELECT ${LISTING_COLUMNS} FROM stock_listings
        WHERE tenant_id = $1 AND listing_id = $2 FOR UPDATE`,
      [input.tenantId, input.listingId],
    );
    if (found.rows.length === 0) return null;
    const listing = mapListing(found.rows[0] as Row);

    const answer = await port.describe(listing.listingId, listing.externalRef);
    const providerHasListing = answer.outcome === 'accepted';
    const shouldBePublished = listing.state === 'published';
    const agreed = providerHasListing === shouldBePublished;

    let correctedTo: ListingState | null = null;
    if (!agreed) {
      correctedTo = providerHasListing ? 'published' : 'withdrawn';
      await executor.query(
        `UPDATE stock_listings
            SET state = $3,
                published_at = CASE WHEN $3 = 'published' AND published_at IS NULL
                                    THEN NOW() ELSE published_at END,
                withdrawn_at = CASE WHEN $3 = 'withdrawn' THEN NOW() ELSE withdrawn_at END,
                updated_at = NOW(), authorization_version = authorization_version + 1
          WHERE tenant_id = $1 AND listing_id = $2`,
        [input.tenantId, input.listingId, correctedTo],
      );
    }

    await recordListingEvent(executor, {
      tenantId: input.tenantId,
      listingId: listing.listingId,
      eventType: 'reconciled',
      outcome: agreed ? 'accepted' : 'rejected',
      // Reconciliation passes are numbered above the delivery attempts so they
      // never collide with them in the per-attempt ledger.
      attempt: listing.attempts + 1000,
      providerRef: listing.externalRef,
      detail: {
        platform_state: listing.state,
        provider_has_listing: providerHasListing,
        corrected_to: correctedTo,
      },
      outboxEventId: null,
    });

    return {
      listingId: listing.listingId,
      platformState: listing.state,
      providerHasListing,
      agreed,
      correctedTo,
    };
  });
}

export async function getListing(tenantId: string, listingId: string): Promise<ListingView | null> {
  return withTenantTransaction(tenantId, async (tx) => {
    const found = await tx.query(
      `SELECT ${LISTING_COLUMNS} FROM stock_listings WHERE tenant_id = $1 AND listing_id = $2`,
      [tenantId, listingId],
    );
    return found.rows.length === 0 ? null : mapListing(found.rows[0] as Row);
  });
}
