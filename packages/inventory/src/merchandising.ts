/**
 * RELEASE TRAIN 2, ROW 3 (first half) — MERCHANDISING THE CAR.
 *
 * Pricing, photographs, features, holds and transfers between the
 * dealership's own rooftops. Everything here hangs off a stock item, and every
 * command is authorized through that stock item's rooftop — which is why none
 * of these tables carries a rooftop of its own.
 *
 * PRICING IS VERSIONED, NOT OVERWRITTEN. A price change supersedes the
 * standing row and inserts a new one, so what a vehicle was advertised at last
 * week survives this week's markdown. `uq_stock_prices_current` makes "exactly
 * one live price per type" a database fact rather than a convention, and the
 * supersession is written in the same statement pair as the insert so the two
 * can never disagree.
 *
 * A HOLD IS THE ONE THING THAT STOPS PUBLICATION. At most one may be live per
 * vehicle (`uq_stock_holds_live`), so "is this car available" has exactly one
 * answer and the listing service can ask it without interpreting a set.
 */
import { withTenantTransaction, type Executor } from '@dealer/database';
import { recordMutation, requireActor, type MutationResult } from '@dealer/identity-access';

interface Row {
  [key: string]: unknown;
}

export type PriceType = 'retail' | 'internet' | 'wholesale' | 'msrp';
export type HoldType = 'sold_pending' | 'inspection' | 'manager' | 'transport';
export type TransferState = 'requested' | 'completed' | 'cancelled';

export const PRICE_TYPES: readonly PriceType[] = ['retail', 'internet', 'wholesale', 'msrp'];
export const HOLD_TYPES: readonly HoldType[] = [
  'sold_pending',
  'inspection',
  'manager',
  'transport',
];

export interface PriceView {
  readonly priceId: string;
  readonly priceType: PriceType;
  readonly amountCents: number;
  readonly currency: string;
  readonly effectiveFrom: string;
  readonly supersededAt: string | null;
  readonly reason: string | null;
}

export interface MediaView {
  readonly mediaId: string;
  readonly mediaKind: 'photo' | 'video';
  readonly uri: string;
  readonly position: number;
  readonly caption: string | null;
  readonly status: 'active' | 'removed';
}

export interface FeatureView {
  readonly featureCode: string;
  readonly label: string;
  readonly source: 'decoded' | 'manual';
}

export interface HoldView {
  readonly holdId: string;
  readonly holdType: HoldType;
  readonly reason: string;
  readonly placedAt: string;
  readonly releasedAt: string | null;
  readonly releaseReason: string | null;
}

export interface TransferView {
  readonly transferId: string;
  readonly stockItemId: string;
  readonly fromRooftopId: string;
  readonly toRooftopId: string;
  readonly state: TransferState;
  readonly reason: string | null;
  readonly requestedAt: string;
  readonly settledAt: string | null;
  readonly authorizationVersion: number;
}

function iso(value: unknown): string {
  return new Date(value as string).toISOString();
}

/** Locks the parent stock item — every merchandising write is a write about it. */
async function lockStockItem(
  executor: Executor,
  tenantId: string,
  stockItemId: string,
): Promise<{ rooftopId: string; version: number; lifecycleState: string } | null> {
  const found = await executor.query(
    `SELECT rooftop_id, authorization_version, lifecycle_state FROM stock_items
      WHERE tenant_id = $1 AND stock_item_id = $2 FOR UPDATE`,
    [tenantId, stockItemId],
  );
  if (found.rows.length === 0) return null;
  const row = found.rows[0] as Row;
  return {
    rooftopId: String(row.rooftop_id),
    version: Number(row.authorization_version),
    lifecycleState: String(row.lifecycle_state),
  };
}

// ── pricing ─────────────────────────────────────────────────────────────────

export type PriceOutcome =
  | { outcome: 'priced'; price: PriceView; superseded: string | null; mutation: MutationResult }
  | { outcome: 'invalid'; error: string }
  | { outcome: 'not_found' };

/**
 * Sets the live price of one type, superseding whatever stood before it.
 *
 * The supersession and the insert are one transaction and the standing row is
 * locked first, so two concurrent markdowns cannot both believe they replaced
 * the same price — the second waits, sees the first's row, and supersedes THAT.
 */
export async function setStockPriceWithin(
  executor: Executor,
  input: {
    actingUserLinkId: string;
    tenantId: string;
    stockItemId: string;
    priceType: PriceType;
    amountCents: number;
    currency?: string | undefined;
    reason?: string | null | undefined;
  },
): Promise<PriceOutcome> {
  if (!PRICE_TYPES.includes(input.priceType)) {
    return { outcome: 'invalid', error: `unknown price type ${input.priceType}` };
  }
  if (!Number.isInteger(input.amountCents) || input.amountCents < 0) {
    return { outcome: 'invalid', error: 'a price is a whole number of cents, at least zero' };
  }
  const actor = await requireActor(executor, input.actingUserLinkId);
  const stock = await lockStockItem(executor, input.tenantId, input.stockItemId);
  if (stock === null) return { outcome: 'not_found' };

  // SUPERSEDE FIRST, THEN INSERT — the order is forced by
  // `uq_stock_prices_current`, which admits exactly one live row per price
  // type. Inserting first would collide with the price still standing, so the
  // standing row is closed before its replacement exists. Both statements are
  // in one transaction, so no reader ever sees a vehicle with no live price.
  const superseded = await executor.query(
    `UPDATE stock_prices
        SET superseded_at = NOW(), updated_at = NOW(),
            authorization_version = authorization_version + 1
      WHERE tenant_id = $1 AND stock_item_id = $2 AND price_type = $3
        AND superseded_at IS NULL
      RETURNING price_id`,
    [input.tenantId, input.stockItemId, input.priceType],
  );

  const written = await executor.query(
    `INSERT INTO stock_prices
       (tenant_id, stock_item_id, price_type, amount_cents, currency, reason,
        created_by_user_link_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING price_id, price_type, amount_cents, currency, effective_from,
               superseded_at, reason`,
    [
      input.tenantId,
      input.stockItemId,
      input.priceType,
      input.amountCents,
      input.currency ?? 'USD',
      input.reason ?? null,
      actor,
    ],
  );
  const row = written.rows[0] as Row;
  const priceId = String(row.price_id);

  // …and now the closed rows can point at what replaced them, which is what
  // makes the price history a chain rather than a pile.
  if (superseded.rows.length > 0) {
    await executor.query(
      `UPDATE stock_prices SET superseded_by_price_id = $3
        WHERE tenant_id = $1 AND price_id = ANY($2::uuid[])`,
      [input.tenantId, (superseded.rows as Row[]).map((r) => String(r.price_id)), priceId],
    );
  }

  const price: PriceView = {
    priceId,
    priceType: String(row.price_type) as PriceType,
    amountCents: Number(row.amount_cents),
    currency: String(row.currency),
    effectiveFrom: iso(row.effective_from),
    supersededAt: null,
    reason: row.reason === null ? null : String(row.reason),
  };
  const mutation = await recordMutation(executor, {
    tenantId: input.tenantId,
    entityType: 'stock_price',
    entityId: priceId,
    eventType: 'inventory.price.set',
    actingUserLinkId: actor,
    authorizationVersion: 1,
    details: {
      stock_item_id: input.stockItemId,
      price_type: price.priceType,
      superseded: superseded.rows.length,
    },
  });
  return {
    outcome: 'priced',
    price,
    superseded: superseded.rows.length > 0 ? String((superseded.rows[0] as Row).price_id) : null,
    mutation,
  };
}

export async function setStockPrice(input: {
  actingUserLinkId: string;
  tenantId: string;
  stockItemId: string;
  priceType: PriceType;
  amountCents: number;
  currency?: string | undefined;
  reason?: string | null | undefined;
}): Promise<PriceOutcome> {
  return withTenantTransaction(input.tenantId, (tx) => setStockPriceWithin(tx, input));
}

// ── media ───────────────────────────────────────────────────────────────────

export type MediaOutcome =
  | { outcome: 'added'; media: MediaView; mutation: MutationResult }
  | { outcome: 'invalid'; error: string }
  | { outcome: 'not_found' };

/**
 * Adds a photograph. The position defaults to the end of the gallery, so the
 * ordinary case — staff uploading shots in order — needs no arithmetic from
 * the caller.
 */
export async function addStockMediaWithin(
  executor: Executor,
  input: {
    actingUserLinkId: string;
    tenantId: string;
    stockItemId: string;
    uri: string;
    caption?: string | null | undefined;
    position?: number | null | undefined;
    mediaKind?: 'photo' | 'video' | undefined;
  },
): Promise<MediaOutcome> {
  if (
    typeof input.uri !== 'string' ||
    !/^(https:\/\/|\/)/.test(input.uri) ||
    input.uri.length > 500
  ) {
    return { outcome: 'invalid', error: 'a photo URI is an https URL or an absolute path' };
  }
  const actor = await requireActor(executor, input.actingUserLinkId);
  const stock = await lockStockItem(executor, input.tenantId, input.stockItemId);
  if (stock === null) return { outcome: 'not_found' };

  let position = input.position ?? null;
  if (position === null) {
    const last = await executor.query(
      `SELECT COALESCE(MAX(position), 0) + 1 AS next FROM stock_media
        WHERE tenant_id = $1 AND stock_item_id = $2 AND status = 'active'`,
      [input.tenantId, input.stockItemId],
    );
    position = Number((last.rows[0] as Row).next);
  }
  if (!Number.isInteger(position) || position < 1 || position > 100) {
    return { outcome: 'invalid', error: 'a gallery holds up to 100 photographs' };
  }

  const written = await executor.query(
    `INSERT INTO stock_media
       (tenant_id, stock_item_id, media_kind, uri, position, caption,
        created_by_user_link_id, updated_by_user_link_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
     RETURNING media_id, media_kind, uri, position, caption, status`,
    [
      input.tenantId,
      input.stockItemId,
      input.mediaKind ?? 'photo',
      input.uri,
      position,
      input.caption ?? null,
      actor,
    ],
  );
  const row = written.rows[0] as Row;
  const media: MediaView = {
    mediaId: String(row.media_id),
    mediaKind: String(row.media_kind) as 'photo' | 'video',
    uri: String(row.uri),
    position: Number(row.position),
    caption: row.caption === null ? null : String(row.caption),
    status: String(row.status) as 'active' | 'removed',
  };
  const mutation = await recordMutation(executor, {
    tenantId: input.tenantId,
    entityType: 'stock_media',
    entityId: media.mediaId,
    eventType: 'inventory.media.added',
    actingUserLinkId: actor,
    authorizationVersion: 1,
    details: { stock_item_id: input.stockItemId, position: media.position },
  });
  return { outcome: 'added', media, mutation };
}

export async function addStockMedia(input: {
  actingUserLinkId: string;
  tenantId: string;
  stockItemId: string;
  uri: string;
  caption?: string | null | undefined;
  position?: number | null | undefined;
  mediaKind?: 'photo' | 'video' | undefined;
}): Promise<MediaOutcome> {
  return withTenantTransaction(input.tenantId, (tx) => addStockMediaWithin(tx, input));
}

export type MediaRemoveOutcome =
  { outcome: 'removed'; mutation: MutationResult } | { outcome: 'not_found' };

/**
 * Retires a photograph. The row survives as `removed` rather than being
 * deleted, so a gallery that was published can still be reconstructed.
 */
export async function removeStockMedia(input: {
  actingUserLinkId: string;
  tenantId: string;
  stockItemId: string;
  mediaId: string;
}): Promise<MediaRemoveOutcome> {
  return withTenantTransaction(input.tenantId, async (executor) => {
    const actor = await requireActor(executor, input.actingUserLinkId);
    const updated = await executor.query(
      `UPDATE stock_media
          SET status = 'removed', updated_by_user_link_id = $4, updated_at = NOW(),
              authorization_version = authorization_version + 1
        WHERE tenant_id = $1 AND stock_item_id = $2 AND media_id = $3 AND status = 'active'
        RETURNING media_id, authorization_version`,
      [input.tenantId, input.stockItemId, input.mediaId, actor],
    );
    if (updated.rows.length === 0) return { outcome: 'not_found' as const };
    const mutation = await recordMutation(executor, {
      tenantId: input.tenantId,
      entityType: 'stock_media',
      entityId: input.mediaId,
      eventType: 'inventory.media.removed',
      actingUserLinkId: actor,
      authorizationVersion: Number((updated.rows[0] as Row).authorization_version),
      details: { stock_item_id: input.stockItemId },
    });
    return { outcome: 'removed' as const, mutation };
  });
}

// ── features ────────────────────────────────────────────────────────────────

export type FeatureOutcome =
  | { outcome: 'replaced'; features: FeatureView[]; mutation: MutationResult }
  | { outcome: 'version_conflict'; currentVersion: number }
  | { outcome: 'invalid'; error: string }
  | { outcome: 'not_found' };

/**
 * Replaces the whole feature set for one vehicle — the PUT model, so a retried
 * save converges on the same state instead of accumulating.
 *
 * OPTIMISTIC CONCURRENCY ANCHORS ON THE PARENT. The features themselves are
 * deleted and re-inserted, so their own versions cannot carry the comparison;
 * the caller states the stock item's version, and that is what is checked and
 * advanced. Two people editing one car's features therefore conflict properly.
 */
export async function replaceStockFeaturesWithin(
  executor: Executor,
  input: {
    actingUserLinkId: string;
    tenantId: string;
    stockItemId: string;
    expectedVersion?: number | null | undefined;
    features: readonly { code: string; label: string; source?: 'decoded' | 'manual' }[];
  },
): Promise<FeatureOutcome> {
  const actor = await requireActor(executor, input.actingUserLinkId);
  const stock = await lockStockItem(executor, input.tenantId, input.stockItemId);
  if (stock === null) return { outcome: 'not_found' };
  if (
    input.expectedVersion !== undefined &&
    input.expectedVersion !== null &&
    stock.version !== input.expectedVersion
  ) {
    return { outcome: 'version_conflict', currentVersion: stock.version };
  }
  const seen = new Set<string>();
  for (const f of input.features) {
    if (typeof f.code !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(f.code)) {
      return { outcome: 'invalid', error: `feature code ${String(f.code)} is not usable` };
    }
    if (typeof f.label !== 'string' || f.label.length < 1 || f.label.length > 100) {
      return { outcome: 'invalid', error: `feature ${f.code} needs a label` };
    }
    if (seen.has(f.code)) return { outcome: 'invalid', error: `feature ${f.code} appears twice` };
    seen.add(f.code);
  }

  await executor.query(`DELETE FROM stock_features WHERE tenant_id = $1 AND stock_item_id = $2`, [
    input.tenantId,
    input.stockItemId,
  ]);
  for (const f of input.features) {
    await executor.query(
      `INSERT INTO stock_features
         (tenant_id, stock_item_id, feature_code, label, source, created_by_user_link_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [input.tenantId, input.stockItemId, f.code, f.label, f.source ?? 'manual', actor],
    );
  }
  const bumped = await executor.query(
    `UPDATE stock_items
        SET updated_by_user_link_id = $3, updated_at = NOW(),
            authorization_version = authorization_version + 1
      WHERE tenant_id = $1 AND stock_item_id = $2
      RETURNING authorization_version`,
    [input.tenantId, input.stockItemId, actor],
  );
  const mutation = await recordMutation(executor, {
    tenantId: input.tenantId,
    entityType: 'stock_item',
    entityId: input.stockItemId,
    eventType: 'inventory.features.replaced',
    actingUserLinkId: actor,
    authorizationVersion: Number((bumped.rows[0] as Row).authorization_version),
    details: { feature_count: input.features.length },
  });
  return {
    outcome: 'replaced',
    features: input.features.map((f) => ({
      featureCode: f.code,
      label: f.label,
      source: f.source ?? 'manual',
    })),
    mutation,
  };
}

export async function replaceStockFeatures(input: {
  actingUserLinkId: string;
  tenantId: string;
  stockItemId: string;
  expectedVersion?: number | null | undefined;
  features: readonly { code: string; label: string; source?: 'decoded' | 'manual' }[];
}): Promise<FeatureOutcome> {
  return withTenantTransaction(input.tenantId, (tx) => replaceStockFeaturesWithin(tx, input));
}

// ── holds ───────────────────────────────────────────────────────────────────

export type HoldOutcome =
  | { outcome: 'placed'; hold: HoldView; mutation: MutationResult }
  | { outcome: 'already_held'; hold: HoldView }
  | { outcome: 'invalid'; error: string }
  | { outcome: 'not_found' };

function mapHold(row: Row): HoldView {
  return {
    holdId: String(row.hold_id),
    holdType: String(row.hold_type) as HoldType,
    reason: String(row.reason),
    placedAt: iso(row.placed_at),
    releasedAt: row.released_at === null ? null : iso(row.released_at),
    releaseReason: row.release_reason === null ? null : String(row.release_reason),
  };
}

/** Takes a vehicle off the market. One live hold per vehicle, enforced by index. */
export async function placeStockHoldWithin(
  executor: Executor,
  input: {
    actingUserLinkId: string;
    tenantId: string;
    stockItemId: string;
    holdType: HoldType;
    reason: string;
  },
): Promise<HoldOutcome> {
  if (!HOLD_TYPES.includes(input.holdType)) {
    return { outcome: 'invalid', error: `unknown hold type ${input.holdType}` };
  }
  const reason = (input.reason ?? '').trim();
  if (reason.length === 0 || reason.length > 200) {
    return { outcome: 'invalid', error: 'a hold records why it was placed' };
  }
  const actor = await requireActor(executor, input.actingUserLinkId);
  const stock = await lockStockItem(executor, input.tenantId, input.stockItemId);
  if (stock === null) return { outcome: 'not_found' };

  const live = await executor.query(
    `SELECT hold_id, hold_type, reason, placed_at, released_at, release_reason
       FROM stock_holds
      WHERE tenant_id = $1 AND stock_item_id = $2 AND released_at IS NULL`,
    [input.tenantId, input.stockItemId],
  );
  if (live.rows.length > 0) {
    return { outcome: 'already_held', hold: mapHold(live.rows[0] as Row) };
  }

  const written = await executor.query(
    `INSERT INTO stock_holds
       (tenant_id, stock_item_id, hold_type, reason, placed_by_user_link_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING hold_id, hold_type, reason, placed_at, released_at, release_reason,
               authorization_version`,
    [input.tenantId, input.stockItemId, input.holdType, reason, actor],
  );
  const row = written.rows[0] as Row;
  const hold = mapHold(row);
  const mutation = await recordMutation(executor, {
    tenantId: input.tenantId,
    entityType: 'stock_hold',
    entityId: hold.holdId,
    eventType: 'inventory.hold.placed',
    actingUserLinkId: actor,
    authorizationVersion: Number(row.authorization_version),
    details: { stock_item_id: input.stockItemId, hold_type: hold.holdType },
  });
  return { outcome: 'placed', hold, mutation };
}

export async function placeStockHold(input: {
  actingUserLinkId: string;
  tenantId: string;
  stockItemId: string;
  holdType: HoldType;
  reason: string;
}): Promise<HoldOutcome> {
  return withTenantTransaction(input.tenantId, (tx) => placeStockHoldWithin(tx, input));
}

export type HoldReleaseOutcome =
  { outcome: 'released'; hold: HoldView; mutation: MutationResult } | { outcome: 'not_found' };

export async function releaseStockHold(input: {
  actingUserLinkId: string;
  tenantId: string;
  stockItemId: string;
  holdId: string;
  releaseReason?: string | null | undefined;
}): Promise<HoldReleaseOutcome> {
  return withTenantTransaction(input.tenantId, async (executor) => {
    const actor = await requireActor(executor, input.actingUserLinkId);
    const updated = await executor.query(
      `UPDATE stock_holds
          SET released_at = NOW(), released_by_user_link_id = $4, release_reason = $5,
              updated_at = NOW(), authorization_version = authorization_version + 1
        WHERE tenant_id = $1 AND stock_item_id = $2 AND hold_id = $3 AND released_at IS NULL
        RETURNING hold_id, hold_type, reason, placed_at, released_at, release_reason,
                  authorization_version`,
      [input.tenantId, input.stockItemId, input.holdId, actor, input.releaseReason ?? null],
    );
    if (updated.rows.length === 0) return { outcome: 'not_found' as const };
    const row = updated.rows[0] as Row;
    const hold = mapHold(row);
    const mutation = await recordMutation(executor, {
      tenantId: input.tenantId,
      entityType: 'stock_hold',
      entityId: hold.holdId,
      eventType: 'inventory.hold.released',
      actingUserLinkId: actor,
      authorizationVersion: Number(row.authorization_version),
      details: { stock_item_id: input.stockItemId },
    });
    return { outcome: 'released' as const, hold, mutation };
  });
}

// ── transfers ───────────────────────────────────────────────────────────────

function mapTransfer(row: Row): TransferView {
  return {
    transferId: String(row.transfer_id),
    stockItemId: String(row.stock_item_id),
    fromRooftopId: String(row.from_rooftop_id),
    toRooftopId: String(row.to_rooftop_id),
    state: String(row.state) as TransferState,
    reason: row.reason === null ? null : String(row.reason),
    requestedAt: iso(row.requested_at),
    settledAt: row.settled_at === null ? null : iso(row.settled_at),
    authorizationVersion: Number(row.authorization_version),
  };
}

const TRANSFER_COLUMNS = `transfer_id, stock_item_id, from_rooftop_id, to_rooftop_id, state,
       reason, requested_at, settled_at, authorization_version`;

export type TransferOutcome =
  | { outcome: 'requested'; transfer: TransferView; mutation: MutationResult }
  | { outcome: 'already_open'; transfer: TransferView }
  | { outcome: 'invalid'; error: string }
  | { outcome: 'not_found' };

/**
 * Requests a move between the dealership's own rooftops.
 *
 * The ORIGIN is not taken from the caller: migration 062's
 * `trg_stock_transfers_origin_derived` stamps it from the stock item itself,
 * so a request cannot claim the car is somewhere it is not. The destination is
 * checked here and is composite-foreign-keyed to this tenant's rooftops, so a
 * transfer out of the dealership is unrepresentable.
 */
export async function requestStockTransferWithin(
  executor: Executor,
  input: {
    actingUserLinkId: string;
    tenantId: string;
    stockItemId: string;
    toRooftopId: string;
    reason?: string | null | undefined;
  },
): Promise<TransferOutcome> {
  const actor = await requireActor(executor, input.actingUserLinkId);
  const stock = await lockStockItem(executor, input.tenantId, input.stockItemId);
  if (stock === null) return { outcome: 'not_found' };
  if (stock.lifecycleState === 'retired') {
    return { outcome: 'invalid', error: 'a retired vehicle cannot be transferred' };
  }
  if (stock.rooftopId === input.toRooftopId) {
    return { outcome: 'invalid', error: 'the vehicle is already at that rooftop' };
  }
  const destination = await executor.query(
    `SELECT 1 FROM rooftops WHERE tenant_id = $1 AND rooftop_id = $2`,
    [input.tenantId, input.toRooftopId],
  );
  if (destination.rows.length === 0) {
    return { outcome: 'invalid', error: 'the destination rooftop does not exist' };
  }
  const open = await executor.query(
    `SELECT ${TRANSFER_COLUMNS} FROM stock_transfers
      WHERE tenant_id = $1 AND stock_item_id = $2 AND state = 'requested'`,
    [input.tenantId, input.stockItemId],
  );
  if (open.rows.length > 0) {
    return { outcome: 'already_open', transfer: mapTransfer(open.rows[0] as Row) };
  }

  const written = await executor.query(
    `INSERT INTO stock_transfers
       (tenant_id, stock_item_id, from_rooftop_id, to_rooftop_id, reason,
        requested_by_user_link_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${TRANSFER_COLUMNS}`,
    [
      input.tenantId,
      input.stockItemId,
      // Supplied only to satisfy NOT NULL; the trigger overwrites it with the
      // stock item's true rooftop, which is the point.
      stock.rooftopId,
      input.toRooftopId,
      input.reason ?? null,
      actor,
    ],
  );
  const transfer = mapTransfer(written.rows[0] as Row);
  const mutation = await recordMutation(executor, {
    tenantId: input.tenantId,
    entityType: 'stock_transfer',
    entityId: transfer.transferId,
    eventType: 'inventory.transfer.requested',
    actingUserLinkId: actor,
    authorizationVersion: transfer.authorizationVersion,
    details: {
      stock_item_id: input.stockItemId,
      from_rooftop_id: transfer.fromRooftopId,
      to_rooftop_id: transfer.toRooftopId,
    },
  });
  return { outcome: 'requested', transfer, mutation };
}

export async function requestStockTransfer(input: {
  actingUserLinkId: string;
  tenantId: string;
  stockItemId: string;
  toRooftopId: string;
  reason?: string | null | undefined;
}): Promise<TransferOutcome> {
  return withTenantTransaction(input.tenantId, (tx) => requestStockTransferWithin(tx, input));
}

export type TransferSettleOutcome =
  | { outcome: 'settled'; transfer: TransferView; mutation: MutationResult }
  | { outcome: 'invalid'; error: string }
  | { outcome: 'not_found' };

/**
 * Completes or cancels an open transfer.
 *
 * COMPLETION IS WHAT MOVES THE CAR. The stock item's rooftop changes here and
 * nowhere else, in the same transaction as the transfer's own settlement, so
 * the two can never disagree about where the vehicle is — and because the
 * rooftop is what `resource_org_leaf` resolves, authorization follows the car
 * the instant it lands.
 */
export async function settleStockTransferWithin(
  executor: Executor,
  input: {
    actingUserLinkId: string;
    tenantId: string;
    transferId: string;
    state: 'completed' | 'cancelled';
  },
): Promise<TransferSettleOutcome> {
  if (input.state !== 'completed' && input.state !== 'cancelled') {
    return { outcome: 'invalid', error: 'a transfer settles as completed or cancelled' };
  }
  const actor = await requireActor(executor, input.actingUserLinkId);
  const found = await executor.query(
    `SELECT ${TRANSFER_COLUMNS} FROM stock_transfers
      WHERE tenant_id = $1 AND transfer_id = $2 FOR UPDATE`,
    [input.tenantId, input.transferId],
  );
  if (found.rows.length === 0) return { outcome: 'not_found' };
  const current = mapTransfer(found.rows[0] as Row);
  // A settled transfer asked to settle the same way again converges; asked to
  // settle the OTHER way it refuses, because that would rewrite history.
  if (current.state !== 'requested') {
    return current.state === input.state
      ? {
          outcome: 'settled',
          transfer: current,
          mutation: await noopTransferMutation(executor, input.tenantId, actor, current),
        }
      : { outcome: 'invalid', error: `this transfer is already ${current.state}` };
  }

  const settled = await executor.query(
    `UPDATE stock_transfers
        SET state = $3, settled_at = NOW(), settled_by_user_link_id = $4, updated_at = NOW(),
            authorization_version = authorization_version + 1
      WHERE tenant_id = $1 AND transfer_id = $2 AND state = 'requested'
      RETURNING ${TRANSFER_COLUMNS}`,
    [input.tenantId, input.transferId, input.state, actor],
  );
  if (settled.rows.length === 0) return { outcome: 'not_found' };
  const transfer = mapTransfer(settled.rows[0] as Row);

  if (input.state === 'completed') {
    await executor.query(
      `UPDATE stock_items
          SET rooftop_id = $3, updated_by_user_link_id = $4, updated_at = NOW(),
              authorization_version = authorization_version + 1
        WHERE tenant_id = $1 AND stock_item_id = $2`,
      [input.tenantId, transfer.stockItemId, transfer.toRooftopId, actor],
    );
  }

  const mutation = await recordMutation(executor, {
    tenantId: input.tenantId,
    entityType: 'stock_transfer',
    entityId: transfer.transferId,
    eventType:
      input.state === 'completed' ? 'inventory.transfer.completed' : 'inventory.transfer.cancelled',
    actingUserLinkId: actor,
    authorizationVersion: transfer.authorizationVersion,
    details: {
      stock_item_id: transfer.stockItemId,
      from_rooftop_id: transfer.fromRooftopId,
      to_rooftop_id: transfer.toRooftopId,
    },
  });
  return { outcome: 'settled', transfer, mutation };
}

async function noopTransferMutation(
  executor: Executor,
  tenantId: string,
  actor: string,
  transfer: TransferView,
): Promise<MutationResult> {
  return recordMutation(executor, {
    tenantId,
    entityType: 'stock_transfer',
    entityId: transfer.transferId,
    eventType: 'inventory.transfer.settle_noop',
    actingUserLinkId: actor,
    authorizationVersion: transfer.authorizationVersion,
    details: { state: transfer.state },
  });
}

export async function settleStockTransfer(input: {
  actingUserLinkId: string;
  tenantId: string;
  transferId: string;
  state: 'completed' | 'cancelled';
}): Promise<TransferSettleOutcome> {
  return withTenantTransaction(input.tenantId, (tx) => settleStockTransferWithin(tx, input));
}
