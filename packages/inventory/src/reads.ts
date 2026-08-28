/**
 * RELEASE TRAIN 2 — THE READ MODELS.
 *
 * Every read the inventory API renders lives here, because `apps/` may hold no
 * SQL. Each one runs inside a tenant-context transaction, so the row-secured
 * tables answer for exactly the caller's dealership and a defective predicate
 * in this file could not widen that.
 *
 * AGING IS COMPUTED, NOT STORED. Days in inventory is `now - acquired_on` and
 * days retail-ready is `now - retail_ready_at`; storing either would mean a
 * number that is wrong between recalculations. `retail_ready_at` is stamped
 * once and never reset, so a car that goes back for a repair keeps its true
 * age rather than appearing freshly ready.
 */
import { withTenantTransaction } from '@dealer/database';
import { mapListing, type ListingView } from './listings';
import { mapStockItem, type StockItemView } from './stock';
import { mapVehicle, type VehicleView } from './vehicles';
import type { FeatureView, HoldView, MediaView, PriceView, TransferView } from './merchandising';
import type { StockCostView, StockDocumentView } from './stock';

interface Row {
  [key: string]: unknown;
}

function iso(value: unknown): string | null {
  return value === null || value === undefined ? null : new Date(value as string).toISOString();
}

// ── the owner's inventory view ──────────────────────────────────────────────

export interface InventoryRow {
  readonly stockItemId: string;
  readonly stockNumber: string;
  readonly rooftopId: string;
  readonly rooftopName: string;
  readonly vin: string;
  readonly modelYear: number | null;
  readonly make: string | null;
  readonly model: string | null;
  readonly trimLevel: string | null;
  readonly lifecycleState: string;
  readonly acquiredOn: string;
  /** Whole days since the vehicle was acquired — the age a manager asks about. */
  readonly daysInInventory: number;
  /** Whole days since it first became sellable, or null while it is not. */
  readonly daysRetailReady: number | null;
  readonly internetPriceCents: number | null;
  readonly retailPriceCents: number | null;
  readonly totalCostCents: number;
  readonly photoCount: number;
  readonly onHold: boolean;
  readonly holdType: string | null;
  readonly listingState: string | null;
  readonly listingChannel: string | null;
  readonly transferPending: boolean;
}

export interface InventorySummary {
  readonly rows: InventoryRow[];
  readonly total: number;
  readonly countsByState: Record<string, number>;
  readonly rooftops: { rooftopId: string; rooftopName: string; count: number }[];
}

/**
 * THE OWNER VIEW (row 6). One row per live vehicle across the rooftops the
 * caller may see, with the aging, pricing, cost, merchandising and listing
 * facts a manager needs on one screen.
 *
 * `rooftopIds` is the AUTHORIZATION FILTER and it is applied in SQL rather
 * than after the fact: a caller who may see two of five rooftops never has the
 * other three's rows in memory. Passing null means "every rooftop of this
 * dealership", which the API only does for a tenant-scoped administrator.
 */
export async function inventoryView(
  tenantId: string,
  input: {
    rooftopIds?: readonly string[] | null | undefined;
    lifecycleState?: string | null | undefined;
    query?: string | null | undefined;
    includeRetired?: boolean | undefined;
    limit?: number | undefined;
    offset?: number | undefined;
  },
): Promise<InventorySummary> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  const offset = Math.max(input.offset ?? 0, 0);
  const rooftops = input.rooftopIds == null ? null : [...input.rooftopIds];
  const search = (input.query ?? '').trim().toLowerCase();
  const like = search.length > 0 ? `%${search}%` : null;

  return withTenantTransaction(tenantId, async (tx) => {
    const predicate = `si.tenant_id = $1
        AND ($2::uuid[] IS NULL OR si.rooftop_id = ANY($2))
        AND ($3::boolean OR si.lifecycle_state <> 'retired')
        AND ($4::text IS NULL OR si.lifecycle_state = $4)
        AND ($5::text IS NULL
             OR lower(si.stock_number) LIKE $5
             OR lower(v.vin) LIKE $5
             OR lower(COALESCE(v.make, '')) LIKE $5
             OR lower(COALESCE(v.model, '')) LIKE $5)`;
    const params = [
      tenantId,
      rooftops,
      input.includeRetired === true,
      input.lifecycleState ?? null,
      like,
    ];

    const rows = await tx.query(
      `SELECT si.stock_item_id, si.stock_number, si.rooftop_id, r.name AS rooftop_name,
              si.lifecycle_state, si.acquired_on, si.retail_ready_at,
              v.vin, v.model_year, v.make, v.model, v.trim_level,
              (SELECT p.amount_cents FROM stock_prices p
                WHERE p.tenant_id = si.tenant_id AND p.stock_item_id = si.stock_item_id
                  AND p.price_type = 'internet' AND p.superseded_at IS NULL) AS internet_price,
              (SELECT p.amount_cents FROM stock_prices p
                WHERE p.tenant_id = si.tenant_id AND p.stock_item_id = si.stock_item_id
                  AND p.price_type = 'retail' AND p.superseded_at IS NULL) AS retail_price,
              COALESCE((SELECT SUM(c.amount_cents) FROM stock_costs c
                WHERE c.tenant_id = si.tenant_id AND c.stock_item_id = si.stock_item_id), 0)
                AS total_cost,
              (SELECT COUNT(*)::int FROM stock_media m
                WHERE m.tenant_id = si.tenant_id AND m.stock_item_id = si.stock_item_id
                  AND m.status = 'active') AS photo_count,
              (SELECT h.hold_type FROM stock_holds h
                WHERE h.tenant_id = si.tenant_id AND h.stock_item_id = si.stock_item_id
                  AND h.released_at IS NULL LIMIT 1) AS hold_type,
              (SELECT l.state FROM stock_listings l
                WHERE l.tenant_id = si.tenant_id AND l.stock_item_id = si.stock_item_id
                ORDER BY l.updated_at DESC LIMIT 1) AS listing_state,
              (SELECT l.channel FROM stock_listings l
                WHERE l.tenant_id = si.tenant_id AND l.stock_item_id = si.stock_item_id
                ORDER BY l.updated_at DESC LIMIT 1) AS listing_channel,
              EXISTS (SELECT 1 FROM stock_transfers t
                       WHERE t.tenant_id = si.tenant_id AND t.stock_item_id = si.stock_item_id
                         AND t.state = 'requested') AS transfer_pending,
              (CURRENT_DATE - si.acquired_on) AS days_in_inventory,
              CASE WHEN si.retail_ready_at IS NULL THEN NULL
                   ELSE (CURRENT_DATE - si.retail_ready_at::date) END AS days_retail_ready
         FROM stock_items si
         JOIN vehicles v ON v.tenant_id = si.tenant_id AND v.vehicle_id = si.vehicle_id
         JOIN rooftops r ON r.tenant_id = si.tenant_id AND r.rooftop_id = si.rooftop_id
        WHERE ${predicate}
        ORDER BY si.acquired_on, si.stock_number
        LIMIT $6 OFFSET $7`,
      [...params, limit, offset],
    );

    const [total, byState, byRooftop] = await Promise.all([
      tx.query(
        `SELECT COUNT(*)::int AS n FROM stock_items si
           JOIN vehicles v ON v.tenant_id = si.tenant_id AND v.vehicle_id = si.vehicle_id
          WHERE ${predicate}`,
        params,
      ),
      tx.query(
        `SELECT si.lifecycle_state, COUNT(*)::int AS n FROM stock_items si
           JOIN vehicles v ON v.tenant_id = si.tenant_id AND v.vehicle_id = si.vehicle_id
          WHERE ${predicate} GROUP BY si.lifecycle_state`,
        params,
      ),
      tx.query(
        `SELECT si.rooftop_id, r.name AS rooftop_name, COUNT(*)::int AS n
           FROM stock_items si
           JOIN vehicles v ON v.tenant_id = si.tenant_id AND v.vehicle_id = si.vehicle_id
           JOIN rooftops r ON r.tenant_id = si.tenant_id AND r.rooftop_id = si.rooftop_id
          WHERE ${predicate}
          GROUP BY si.rooftop_id, r.name ORDER BY r.name`,
        params,
      ),
    ]);

    const countsByState: Record<string, number> = {};
    for (const r of byState.rows as Row[]) {
      countsByState[String(r.lifecycle_state)] = Number(r.n);
    }

    return {
      rows: (rows.rows as Row[]).map((r) => ({
        stockItemId: String(r.stock_item_id),
        stockNumber: String(r.stock_number),
        rooftopId: String(r.rooftop_id),
        rooftopName: String(r.rooftop_name),
        vin: String(r.vin),
        modelYear: r.model_year === null ? null : Number(r.model_year),
        make: r.make === null ? null : String(r.make),
        model: r.model === null ? null : String(r.model),
        trimLevel: r.trim_level === null ? null : String(r.trim_level),
        lifecycleState: String(r.lifecycle_state),
        acquiredOn: String(r.acquired_on).slice(0, 10),
        daysInInventory: Number(r.days_in_inventory),
        daysRetailReady: r.days_retail_ready === null ? null : Number(r.days_retail_ready),
        internetPriceCents: r.internet_price === null ? null : Number(r.internet_price),
        retailPriceCents: r.retail_price === null ? null : Number(r.retail_price),
        totalCostCents: Number(r.total_cost),
        photoCount: Number(r.photo_count),
        onHold: r.hold_type !== null,
        holdType: r.hold_type === null ? null : String(r.hold_type),
        listingState: r.listing_state === null ? null : String(r.listing_state),
        listingChannel: r.listing_channel === null ? null : String(r.listing_channel),
        transferPending: r.transfer_pending === true,
      })),
      total: Number((total.rows[0] as Row).n),
      countsByState,
      rooftops: (byRooftop.rows as Row[]).map((r) => ({
        rooftopId: String(r.rooftop_id),
        rooftopName: String(r.rooftop_name),
        count: Number(r.n),
      })),
    };
  });
}

// ── one vehicle, everything about it ────────────────────────────────────────

export interface StockDetail {
  readonly stockItem: StockItemView;
  readonly vehicle: VehicleView;
  readonly rooftopName: string;
  readonly acquisitionPartyName: string | null;
  readonly documents: StockDocumentView[];
  readonly costs: StockCostView[];
  readonly prices: PriceView[];
  readonly media: MediaView[];
  readonly features: FeatureView[];
  readonly holds: HoldView[];
  readonly transfers: TransferView[];
  readonly listings: ListingView[];
  readonly daysInInventory: number;
  readonly totalCostCents: number;
}

/** Everything one stock record carries, for the vehicle detail screen. */
export async function stockDetail(
  tenantId: string,
  stockItemId: string,
): Promise<StockDetail | null> {
  return withTenantTransaction(tenantId, async (tx) => {
    const base = await tx.query(
      `SELECT si.stock_item_id, si.vehicle_id, si.rooftop_id, si.stock_number,
              si.lifecycle_state, si.acquisition_source, si.acquisition_party_id,
              si.acquired_on, si.odometer, si.odometer_unit, si.title_status,
              si.location_label, si.retail_ready_at, si.retired_at, si.retired_reason,
              si.authorization_version, si.created_at, si.updated_at,
              r.name AS rooftop_name, p.display_name AS party_name,
              (CURRENT_DATE - si.acquired_on) AS days_in_inventory
         FROM stock_items si
         JOIN rooftops r ON r.tenant_id = si.tenant_id AND r.rooftop_id = si.rooftop_id
         LEFT JOIN parties p ON p.tenant_id = si.tenant_id
                            AND p.party_id = si.acquisition_party_id
        WHERE si.tenant_id = $1 AND si.stock_item_id = $2`,
      [tenantId, stockItemId],
    );
    if (base.rows.length === 0) return null;
    const row = base.rows[0] as Row;

    const [vehicle, documents, costs, prices, media, features, holds, transfers, listings] =
      await Promise.all([
        tx.query(
          `SELECT vehicle_id, vin, vin_check_digit_valid, model_year, make, model,
                  trim_level, body_style, drivetrain, fuel_type, transmission,
                  exterior_color, interior_color, decode_status, decoded_at, decode_source,
                  authorization_version
             FROM vehicles WHERE tenant_id = $1 AND vehicle_id = $2`,
          [tenantId, String(row.vehicle_id)],
        ),
        tx.query(
          `SELECT document_id, document_type, reference, status, received_on, note,
                  authorization_version
             FROM stock_documents WHERE tenant_id = $1 AND stock_item_id = $2
            ORDER BY document_type`,
          [tenantId, stockItemId],
        ),
        tx.query(
          `SELECT cost_id, cost_type, amount_cents, currency, status, vendor, incurred_on,
                  target_on, note, authorization_version
             FROM stock_costs WHERE tenant_id = $1 AND stock_item_id = $2
            ORDER BY incurred_on, cost_type`,
          [tenantId, stockItemId],
        ),
        tx.query(
          `SELECT price_id, price_type, amount_cents, currency, effective_from,
                  superseded_at, reason
             FROM stock_prices WHERE tenant_id = $1 AND stock_item_id = $2
            ORDER BY price_type, effective_from DESC`,
          [tenantId, stockItemId],
        ),
        tx.query(
          `SELECT media_id, media_kind, uri, position, caption, status
             FROM stock_media WHERE tenant_id = $1 AND stock_item_id = $2 AND status = 'active'
            ORDER BY position, created_at`,
          [tenantId, stockItemId],
        ),
        tx.query(
          `SELECT feature_code, label, source FROM stock_features
            WHERE tenant_id = $1 AND stock_item_id = $2 ORDER BY label`,
          [tenantId, stockItemId],
        ),
        tx.query(
          `SELECT hold_id, hold_type, reason, placed_at, released_at, release_reason
             FROM stock_holds WHERE tenant_id = $1 AND stock_item_id = $2
            ORDER BY placed_at DESC`,
          [tenantId, stockItemId],
        ),
        tx.query(
          `SELECT transfer_id, stock_item_id, from_rooftop_id, to_rooftop_id, state, reason,
                  requested_at, settled_at, authorization_version
             FROM stock_transfers WHERE tenant_id = $1 AND stock_item_id = $2
            ORDER BY requested_at DESC`,
          [tenantId, stockItemId],
        ),
        tx.query(
          `SELECT listing_id, stock_item_id, channel, state, external_ref, last_error,
                  attempts, published_at, withdrawn_at, authorization_version
             FROM stock_listings WHERE tenant_id = $1 AND stock_item_id = $2
            ORDER BY channel`,
          [tenantId, stockItemId],
        ),
      ]);

    const costRows = (costs.rows as Row[]).map((c) => ({
      costId: String(c.cost_id),
      costType: String(c.cost_type) as StockCostView['costType'],
      amountCents: Number(c.amount_cents),
      currency: String(c.currency),
      status: String(c.status) as 'estimated' | 'actual',
      vendor: c.vendor === null ? null : String(c.vendor),
      incurredOn: String(c.incurred_on).slice(0, 10),
      targetOn: c.target_on === null ? null : String(c.target_on).slice(0, 10),
      note: c.note === null ? null : String(c.note),
      authorizationVersion: Number(c.authorization_version),
    }));

    return {
      stockItem: mapStockItem(row),
      vehicle: mapVehicle(vehicle.rows[0] as Row),
      rooftopName: String(row.rooftop_name),
      acquisitionPartyName: row.party_name === null ? null : String(row.party_name),
      documents: (documents.rows as Row[]).map((d) => ({
        documentId: String(d.document_id),
        documentType: String(d.document_type) as StockDocumentView['documentType'],
        reference: d.reference === null ? null : String(d.reference),
        status: String(d.status) as StockDocumentView['status'],
        receivedOn: d.received_on === null ? null : String(d.received_on).slice(0, 10),
        note: d.note === null ? null : String(d.note),
        authorizationVersion: Number(d.authorization_version),
      })),
      costs: costRows,
      prices: (prices.rows as Row[]).map((p) => ({
        priceId: String(p.price_id),
        priceType: String(p.price_type) as PriceView['priceType'],
        amountCents: Number(p.amount_cents),
        currency: String(p.currency),
        effectiveFrom: iso(p.effective_from) as string,
        supersededAt: iso(p.superseded_at),
        reason: p.reason === null ? null : String(p.reason),
      })),
      media: (media.rows as Row[]).map((m) => ({
        mediaId: String(m.media_id),
        mediaKind: String(m.media_kind) as 'photo' | 'video',
        uri: String(m.uri),
        position: Number(m.position),
        caption: m.caption === null ? null : String(m.caption),
        status: String(m.status) as 'active' | 'removed',
      })),
      features: (features.rows as Row[]).map((f) => ({
        featureCode: String(f.feature_code),
        label: String(f.label),
        source: String(f.source) as 'decoded' | 'manual',
      })),
      holds: (holds.rows as Row[]).map((h) => ({
        holdId: String(h.hold_id),
        holdType: String(h.hold_type) as HoldView['holdType'],
        reason: String(h.reason),
        placedAt: iso(h.placed_at) as string,
        releasedAt: iso(h.released_at),
        releaseReason: h.release_reason === null ? null : String(h.release_reason),
      })),
      transfers: (transfers.rows as Row[]).map((t) => ({
        transferId: String(t.transfer_id),
        stockItemId: String(t.stock_item_id),
        fromRooftopId: String(t.from_rooftop_id),
        toRooftopId: String(t.to_rooftop_id),
        state: String(t.state) as TransferView['state'],
        reason: t.reason === null ? null : String(t.reason),
        requestedAt: iso(t.requested_at) as string,
        settledAt: iso(t.settled_at),
        authorizationVersion: Number(t.authorization_version),
      })),
      listings: (listings.rows as Row[]).map(mapListing),
      daysInInventory: Number(row.days_in_inventory),
      totalCostCents: costRows.reduce((sum, c) => sum + c.amountCents, 0),
    };
  });
}

// ── listing history ─────────────────────────────────────────────────────────

export interface ListingEventView {
  readonly listingEventId: string;
  readonly eventType: string;
  readonly outcome: string;
  readonly attempt: number;
  readonly providerRef: string | null;
  readonly detail: unknown;
  readonly occurredAt: string;
}

/** The reconciliation history of one listing, newest first. */
export async function listingHistory(
  tenantId: string,
  listingId: string,
): Promise<ListingEventView[]> {
  return withTenantTransaction(tenantId, async (tx) => {
    const rows = await tx.query(
      `SELECT listing_event_id, event_type, outcome, attempt, provider_ref, detail, occurred_at
         FROM listing_events WHERE tenant_id = $1 AND listing_id = $2
        ORDER BY occurred_at DESC, attempt DESC`,
      [tenantId, listingId],
    );
    return (rows.rows as Row[]).map((r) => ({
      listingEventId: String(r.listing_event_id),
      eventType: String(r.event_type),
      outcome: String(r.outcome),
      attempt: Number(r.attempt),
      providerRef: r.provider_ref === null ? null : String(r.provider_ref),
      detail: r.detail,
      occurredAt: iso(r.occurred_at) as string,
    }));
  });
}

/** The rooftops of this dealership, for pickers and the owner view's filter. */
export async function listRooftops(
  tenantId: string,
): Promise<{ rooftopId: string; name: string; status: string }[]> {
  return withTenantTransaction(tenantId, async (tx) => {
    const rows = await tx.query(
      `SELECT rooftop_id, name, status FROM rooftops WHERE tenant_id = $1 ORDER BY name`,
      [tenantId],
    );
    return (rows.rows as Row[]).map((r) => ({
      rooftopId: String(r.rooftop_id),
      name: String(r.name),
      status: String(r.status),
    }));
  });
}
