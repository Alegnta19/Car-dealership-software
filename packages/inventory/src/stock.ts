/**
 * RELEASE TRAIN 2, ROW 2 (second half) — STOCK IDENTITY AND ACQUISITION.
 *
 * `acquireStock` is the train's central command. In ONE transaction it
 * resolves (or creates) the canonical vehicle for a VIN, optionally creates
 * the party the car came from, and establishes the stock record — so a
 * half-finished acquisition cannot exist, and a retried acquisition cannot
 * produce two of anything.
 *
 * TWO UNIQUENESS PROMISES, BOTH KEPT BY THE DATABASE rather than by this file:
 *   * one live stock record per vehicle — `uq_stock_items_live_vehicle`;
 *   * one live stock number per dealership — `uq_stock_items_live_number`.
 * Both are partial on `lifecycle_state <> 'retired'`, so a retired record
 * keeps its number and its vehicle without blocking a later re-acquisition.
 * This service TRANSLATES those violations into answers a caller can act on
 * instead of letting a constraint name reach the API.
 *
 * THE LIFECYCLE IS THE READINESS PROGRESSION AND NOTHING ELSE:
 *
 *     acquired ──▶ in_reconditioning ──▶ retail_ready ──▶ retired
 *         │                │                   │            ▲
 *         └────────────────┴───────────────────┴────────────┘
 *
 * A vehicle may go straight from `acquired` to `retail_ready` (nothing needed
 * doing), may return from `retail_ready` to `in_reconditioning` (something was
 * found), and may retire from anywhere. Whether it is listed, held or in
 * transit are separate facts in their own tables.
 */
import { withTenantTransaction, type Executor } from '@dealer/database';
import { recordMutation, requireActor, type MutationResult } from '@dealer/identity-access';
import { createPartyWithin, type PartyDetails, type PartyType, type PartyView } from './parties';
import { resolveVehicleByVin, type VehicleView } from './vehicles';

interface Row {
  [key: string]: unknown;
}

export type LifecycleState = 'acquired' | 'in_reconditioning' | 'retail_ready' | 'retired';
export type AcquisitionSource =
  'trade_in' | 'auction' | 'private_purchase' | 'fleet' | 'consignment' | 'transfer';
export type TitleStatus = 'pending' | 'in_hand' | 'sent' | 'lost';

export const LIFECYCLE_STATES: readonly LifecycleState[] = [
  'acquired',
  'in_reconditioning',
  'retail_ready',
  'retired',
];

export const ACQUISITION_SOURCES: readonly AcquisitionSource[] = [
  'trade_in',
  'auction',
  'private_purchase',
  'fleet',
  'consignment',
  'transfer',
];

/**
 * Which transitions are legal. `retired` is terminal — a retired record is
 * history, and bringing a car back means acquiring it again, which is exactly
 * what the partial unique indexes are shaped to allow.
 */
const LEGAL_TRANSITIONS: Readonly<Record<LifecycleState, readonly LifecycleState[]>> = {
  acquired: ['in_reconditioning', 'retail_ready', 'retired'],
  in_reconditioning: ['retail_ready', 'retired'],
  retail_ready: ['in_reconditioning', 'retired'],
  retired: [],
};

/** The sources that name a counterparty. An auction or fleet purchase need not. */
const SOURCES_REQUIRING_PARTY: readonly AcquisitionSource[] = ['trade_in', 'consignment'];

export interface StockItemView {
  readonly stockItemId: string;
  readonly vehicleId: string;
  readonly rooftopId: string;
  readonly stockNumber: string;
  readonly lifecycleState: LifecycleState;
  readonly acquisitionSource: AcquisitionSource;
  readonly acquisitionPartyId: string | null;
  readonly acquiredOn: string;
  readonly odometer: number | null;
  readonly odometerUnit: 'mi' | 'km';
  readonly titleStatus: TitleStatus;
  readonly locationLabel: string | null;
  readonly retailReadyAt: string | null;
  readonly retiredAt: string | null;
  readonly retiredReason: string | null;
  readonly authorizationVersion: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const STOCK_COLUMNS = `stock_item_id, vehicle_id, rooftop_id, stock_number, lifecycle_state,
       acquisition_source, acquisition_party_id, acquired_on, odometer, odometer_unit,
       title_status, location_label, retail_ready_at, retired_at, retired_reason,
       authorization_version, created_at, updated_at`;

function isoDate(value: unknown): string {
  return value instanceof Date
    ? (value.toISOString().slice(0, 10) as string)
    : String(value).slice(0, 10);
}

export function mapStockItem(row: Row): StockItemView {
  return {
    stockItemId: String(row.stock_item_id),
    vehicleId: String(row.vehicle_id),
    rooftopId: String(row.rooftop_id),
    stockNumber: String(row.stock_number),
    lifecycleState: String(row.lifecycle_state) as LifecycleState,
    acquisitionSource: String(row.acquisition_source) as AcquisitionSource,
    acquisitionPartyId: row.acquisition_party_id === null ? null : String(row.acquisition_party_id),
    acquiredOn: isoDate(row.acquired_on),
    odometer: row.odometer === null ? null : Number(row.odometer),
    odometerUnit: String(row.odometer_unit) as 'mi' | 'km',
    titleStatus: String(row.title_status) as TitleStatus,
    locationLabel: row.location_label === null ? null : String(row.location_label),
    retailReadyAt:
      row.retail_ready_at === null ? null : new Date(row.retail_ready_at as string).toISOString(),
    retiredAt: row.retired_at === null ? null : new Date(row.retired_at as string).toISOString(),
    retiredReason: row.retired_reason === null ? null : String(row.retired_reason),
    authorizationVersion: Number(row.authorization_version),
    createdAt: new Date(row.created_at as string).toISOString(),
    updatedAt: new Date(row.updated_at as string).toISOString(),
  };
}

/** Stock numbers are upper-cased; the schema's grammar refuses the rest. */
export function normalizeStockNumber(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toUpperCase();
  return /^[A-Z0-9][A-Z0-9-]{0,23}$/.test(value) ? value : null;
}

function uniqueViolation(err: unknown): string | null {
  const e = err as { code?: string; constraint?: string } | null;
  return e?.code === '23505' ? (e.constraint ?? '') : null;
}

// ── acquisition ─────────────────────────────────────────────────────────────

export interface AcquisitionInput {
  actingUserLinkId: string;
  tenantId: string;
  rooftopId: string;
  vin: unknown;
  stockNumber: unknown;
  acquisitionSource: AcquisitionSource;
  acquiredOn: string;
  referenceYear: number;
  odometer?: number | null | undefined;
  odometerUnit?: 'mi' | 'km' | undefined;
  titleStatus?: TitleStatus | undefined;
  locationLabel?: string | null | undefined;
  /** An existing party this vehicle came from. */
  acquisitionPartyId?: string | null | undefined;
  /** …or the party to create, in the same transaction as the acquisition. */
  newParty?: { partyType: PartyType; details: PartyDetails } | null | undefined;
}

export type AcquisitionOutcome =
  | {
      outcome: 'acquired';
      stockItem: StockItemView;
      vehicle: VehicleView;
      party: PartyView | null;
      vehicleCreated: boolean;
      mutation: MutationResult;
    }
  | { outcome: 'invalid'; error: string }
  | { outcome: 'duplicate_stock_number'; stockNumber: string }
  | { outcome: 'vehicle_already_stocked'; stockItem: StockItemView }
  | { outcome: 'rooftop_not_found' };

/**
 * THE ACQUISITION COMMAND. Executor-taking so the API can run it inside an
 * idempotent command's transaction, which is what makes a retried acquisition
 * replay one outcome instead of creating a second car.
 */
export async function acquireStockWithin(
  executor: Executor,
  input: AcquisitionInput,
): Promise<AcquisitionOutcome> {
  if (!ACQUISITION_SOURCES.includes(input.acquisitionSource)) {
    return { outcome: 'invalid', error: `unknown acquisition source ${input.acquisitionSource}` };
  }
  const stockNumber = normalizeStockNumber(input.stockNumber);
  if (stockNumber === null) {
    return {
      outcome: 'invalid',
      error: 'a stock number is up to 24 characters of letters, digits and hyphens',
    };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.acquiredOn)) {
    return { outcome: 'invalid', error: 'acquired_on must be a YYYY-MM-DD date' };
  }
  if (input.acquisitionPartyId != null && input.newParty != null) {
    return {
      outcome: 'invalid',
      error: 'name an existing party or create one, not both',
    };
  }

  const actor = await requireActor(executor, input.actingUserLinkId);

  // The rooftop must be this dealership's. The composite foreign key would
  // refuse anything else, but a checked answer beats a constraint violation.
  const rooftop = await executor.query(
    `SELECT 1 FROM rooftops WHERE tenant_id = $1 AND rooftop_id = $2`,
    [input.tenantId, input.rooftopId],
  );
  if (rooftop.rows.length === 0) return { outcome: 'rooftop_not_found' };

  const resolved = await resolveVehicleByVin(executor, {
    actingUserLinkId: actor,
    tenantId: input.tenantId,
    vin: input.vin,
    referenceYear: input.referenceYear,
  });
  if (resolved.outcome === 'invalid') return { outcome: 'invalid', error: resolved.error };
  const vehicle = resolved.vehicle;

  // A vehicle already on the lot cannot be acquired again. Reporting WHICH
  // stock record holds it is what makes the answer actionable.
  const held = await executor.query(
    `SELECT ${STOCK_COLUMNS} FROM stock_items
      WHERE tenant_id = $1 AND vehicle_id = $2 AND lifecycle_state <> 'retired'`,
    [input.tenantId, vehicle.vehicleId],
  );
  if (held.rows.length > 0) {
    return { outcome: 'vehicle_already_stocked', stockItem: mapStockItem(held.rows[0] as Row) };
  }

  let party: PartyView | null = null;
  if (input.newParty != null) {
    const created = await createPartyWithin(executor, {
      actingUserLinkId: actor,
      tenantId: input.tenantId,
      partyType: input.newParty.partyType,
      details: input.newParty.details,
    });
    if (created.outcome === 'invalid') return { outcome: 'invalid', error: created.error };
    if (created.outcome === 'duplicate') {
      return {
        outcome: 'invalid',
        error:
          'that seller matches an existing customer — select the existing record or merge them first',
      };
    }
    party = created.party;
  } else if (input.acquisitionPartyId != null) {
    const found = await executor.query(
      `SELECT party_id, status FROM parties WHERE tenant_id = $1 AND party_id = $2`,
      [input.tenantId, input.acquisitionPartyId],
    );
    if (found.rows.length === 0) {
      return { outcome: 'invalid', error: 'the acquisition party does not exist' };
    }
    if (String((found.rows[0] as Row).status) !== 'active') {
      return { outcome: 'invalid', error: 'the acquisition party is not active' };
    }
  }

  const partyId = party?.partyId ?? input.acquisitionPartyId ?? null;
  if (partyId === null && SOURCES_REQUIRING_PARTY.includes(input.acquisitionSource)) {
    return {
      outcome: 'invalid',
      error: `a ${input.acquisitionSource} acquisition names the party it came from`,
    };
  }

  let written;
  try {
    written = await executor.query(
      `INSERT INTO stock_items
         (tenant_id, vehicle_id, rooftop_id, stock_number, acquisition_source,
          acquisition_party_id, acquired_on, odometer, odometer_unit, title_status,
          location_label, created_by_user_link_id, updated_by_user_link_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7::date, $8, $9, $10, $11, $12, $12)
       RETURNING ${STOCK_COLUMNS}`,
      [
        input.tenantId,
        vehicle.vehicleId,
        input.rooftopId,
        stockNumber,
        input.acquisitionSource,
        partyId,
        input.acquiredOn,
        input.odometer ?? null,
        input.odometerUnit ?? 'mi',
        input.titleStatus ?? 'pending',
        input.locationLabel ?? null,
        actor,
      ],
    );
  } catch (err) {
    const constraint = uniqueViolation(err);
    if (constraint === null) throw err;
    if (constraint.includes('number')) {
      return { outcome: 'duplicate_stock_number', stockNumber };
    }
    const raced = await executor.query(
      `SELECT ${STOCK_COLUMNS} FROM stock_items
        WHERE tenant_id = $1 AND vehicle_id = $2 AND lifecycle_state <> 'retired'`,
      [input.tenantId, vehicle.vehicleId],
    );
    if (raced.rows.length > 0) {
      return { outcome: 'vehicle_already_stocked', stockItem: mapStockItem(raced.rows[0] as Row) };
    }
    throw err;
  }

  const stockItem = mapStockItem(written.rows[0] as Row);
  const mutation = await recordMutation(executor, {
    tenantId: input.tenantId,
    entityType: 'stock_item',
    entityId: stockItem.stockItemId,
    eventType: 'inventory.stock.acquired',
    actingUserLinkId: actor,
    authorizationVersion: stockItem.authorizationVersion,
    details: {
      acquisition_source: stockItem.acquisitionSource,
      rooftop_id: stockItem.rooftopId,
      vehicle_id: stockItem.vehicleId,
      party_named: partyId !== null,
    },
  });
  return {
    outcome: 'acquired',
    stockItem,
    vehicle,
    party,
    vehicleCreated: resolved.created,
    mutation,
  };
}

export async function acquireStock(input: AcquisitionInput): Promise<AcquisitionOutcome> {
  return withTenantTransaction(input.tenantId, (tx) => acquireStockWithin(tx, input));
}

// ── lifecycle ───────────────────────────────────────────────────────────────

export type TransitionOutcome =
  | { outcome: 'transitioned'; stockItem: StockItemView; mutation: MutationResult }
  | { outcome: 'illegal'; from: LifecycleState; to: LifecycleState }
  | { outcome: 'version_conflict'; currentVersion: number }
  | { outcome: 'blocked'; error: string }
  | { outcome: 'not_found' };

/**
 * Advances one stock record through the readiness progression.
 *
 * `retail_ready_at` is stamped the FIRST time the car becomes retail-ready and
 * is never rewritten by a later return to reconditioning — inventory aging is
 * measured from when the car first became sellable, and a vehicle that goes
 * back for a repair does not get its clock reset.
 */
export async function transitionStockWithin(
  executor: Executor,
  input: {
    actingUserLinkId: string;
    tenantId: string;
    stockItemId: string;
    to: LifecycleState;
    expectedVersion?: number | null | undefined;
    reason?: string | null | undefined;
  },
): Promise<TransitionOutcome> {
  const actor = await requireActor(executor, input.actingUserLinkId);
  const found = await executor.query(
    `SELECT ${STOCK_COLUMNS} FROM stock_items
      WHERE tenant_id = $1 AND stock_item_id = $2 FOR UPDATE`,
    [input.tenantId, input.stockItemId],
  );
  if (found.rows.length === 0) return { outcome: 'not_found' };
  const current = mapStockItem(found.rows[0] as Row);
  if (
    input.expectedVersion !== undefined &&
    input.expectedVersion !== null &&
    current.authorizationVersion !== input.expectedVersion
  ) {
    return { outcome: 'version_conflict', currentVersion: current.authorizationVersion };
  }
  if (!LIFECYCLE_STATES.includes(input.to)) {
    return { outcome: 'illegal', from: current.lifecycleState, to: input.to };
  }
  // Asking for the state it already holds is a no-op, not an error: a retried
  // command must converge rather than refuse its own earlier success.
  if (current.lifecycleState === input.to) {
    return {
      outcome: 'transitioned',
      stockItem: current,
      mutation: await recordMutation(executor, {
        tenantId: input.tenantId,
        entityType: 'stock_item',
        entityId: current.stockItemId,
        eventType: 'inventory.stock.transition_noop',
        actingUserLinkId: actor,
        authorizationVersion: current.authorizationVersion,
        details: { state: input.to },
      }),
    };
  }
  if (!(LEGAL_TRANSITIONS[current.lifecycleState] ?? []).includes(input.to)) {
    return { outcome: 'illegal', from: current.lifecycleState, to: input.to };
  }
  if (input.to === 'retired') {
    const reason = (input.reason ?? '').trim();
    if (reason.length === 0) {
      return { outcome: 'blocked', error: 'retiring a stock record records why' };
    }
    // A live listing must be withdrawn before the car leaves inventory, or the
    // dealership would keep advertising something it no longer holds.
    const listed = await executor.query(
      `SELECT 1 FROM stock_listings
        WHERE tenant_id = $1 AND stock_item_id = $2
          AND state IN ('publish_pending', 'published', 'withdraw_pending')`,
      [input.tenantId, input.stockItemId],
    );
    if (listed.rows.length > 0) {
      return { outcome: 'blocked', error: 'withdraw the listing before retiring this vehicle' };
    }
  }

  const updated = await executor.query(
    `UPDATE stock_items
        SET lifecycle_state = $3,
            retail_ready_at = CASE WHEN $3 = 'retail_ready' AND retail_ready_at IS NULL
                                   THEN NOW() ELSE retail_ready_at END,
            retired_at = CASE WHEN $3 = 'retired' THEN NOW() ELSE NULL END,
            retired_reason = CASE WHEN $3 = 'retired' THEN $4 ELSE NULL END,
            updated_by_user_link_id = $5, updated_at = NOW(),
            authorization_version = authorization_version + 1
      WHERE tenant_id = $1 AND stock_item_id = $2 AND authorization_version = $6
      RETURNING ${STOCK_COLUMNS}`,
    [
      input.tenantId,
      input.stockItemId,
      input.to,
      input.reason ?? null,
      actor,
      current.authorizationVersion,
    ],
  );
  if (updated.rows.length === 0) {
    return { outcome: 'version_conflict', currentVersion: current.authorizationVersion };
  }
  const stockItem = mapStockItem(updated.rows[0] as Row);
  const mutation = await recordMutation(executor, {
    tenantId: input.tenantId,
    entityType: 'stock_item',
    entityId: stockItem.stockItemId,
    eventType: 'inventory.stock.transitioned',
    actingUserLinkId: actor,
    authorizationVersion: stockItem.authorizationVersion,
    details: { from: current.lifecycleState, to: stockItem.lifecycleState },
  });
  return { outcome: 'transitioned', stockItem, mutation };
}

export async function transitionStock(input: {
  actingUserLinkId: string;
  tenantId: string;
  stockItemId: string;
  to: LifecycleState;
  expectedVersion?: number | null | undefined;
  reason?: string | null | undefined;
}): Promise<TransitionOutcome> {
  return withTenantTransaction(input.tenantId, (tx) => transitionStockWithin(tx, input));
}

export type StockUpdateOutcome =
  | { outcome: 'saved'; stockItem: StockItemView; mutation: MutationResult }
  | { outcome: 'version_conflict'; currentVersion: number }
  | { outcome: 'not_found' };

/** The acquisition facts staff correct after the car is on the lot. */
export async function updateStockDetails(input: {
  actingUserLinkId: string;
  tenantId: string;
  stockItemId: string;
  expectedVersion: number;
  odometer?: number | null | undefined;
  odometerUnit?: 'mi' | 'km' | undefined;
  titleStatus?: TitleStatus | undefined;
  locationLabel?: string | null | undefined;
}): Promise<StockUpdateOutcome> {
  return withTenantTransaction(input.tenantId, async (executor) => {
    const actor = await requireActor(executor, input.actingUserLinkId);
    const found = await executor.query(
      `SELECT ${STOCK_COLUMNS} FROM stock_items
        WHERE tenant_id = $1 AND stock_item_id = $2 FOR UPDATE`,
      [input.tenantId, input.stockItemId],
    );
    if (found.rows.length === 0) return { outcome: 'not_found' as const };
    const current = mapStockItem(found.rows[0] as Row);
    if (current.authorizationVersion !== input.expectedVersion) {
      return { outcome: 'version_conflict' as const, currentVersion: current.authorizationVersion };
    }
    const updated = await executor.query(
      `UPDATE stock_items
          SET odometer = $3, odometer_unit = $4, title_status = $5, location_label = $6,
              updated_by_user_link_id = $7, updated_at = NOW(),
              authorization_version = authorization_version + 1
        WHERE tenant_id = $1 AND stock_item_id = $2 AND authorization_version = $8
        RETURNING ${STOCK_COLUMNS}`,
      [
        input.tenantId,
        input.stockItemId,
        input.odometer === undefined ? current.odometer : input.odometer,
        input.odometerUnit ?? current.odometerUnit,
        input.titleStatus ?? current.titleStatus,
        input.locationLabel === undefined ? current.locationLabel : input.locationLabel,
        actor,
        input.expectedVersion,
      ],
    );
    if (updated.rows.length === 0) {
      return { outcome: 'version_conflict' as const, currentVersion: current.authorizationVersion };
    }
    const stockItem = mapStockItem(updated.rows[0] as Row);
    const mutation = await recordMutation(executor, {
      tenantId: input.tenantId,
      entityType: 'stock_item',
      entityId: stockItem.stockItemId,
      eventType: 'inventory.stock.updated',
      actingUserLinkId: actor,
      authorizationVersion: stockItem.authorizationVersion,
      details: {},
    });
    return { outcome: 'saved' as const, stockItem, mutation };
  });
}

// ── documents and costs ─────────────────────────────────────────────────────

export type DocumentType =
  'title' | 'bill_of_sale' | 'odometer_statement' | 'inspection' | 'lien_release' | 'other';
export type DocumentStatus = 'expected' | 'received' | 'sent' | 'missing';

export interface StockDocumentView {
  readonly documentId: string;
  readonly documentType: DocumentType;
  readonly reference: string | null;
  readonly status: DocumentStatus;
  readonly receivedOn: string | null;
  readonly note: string | null;
  readonly authorizationVersion: number;
}

export type CostType = 'purchase' | 'transport' | 'reconditioning' | 'inspection' | 'fee' | 'other';

export interface StockCostView {
  readonly costId: string;
  readonly costType: CostType;
  readonly amountCents: number;
  readonly currency: string;
  readonly status: 'estimated' | 'actual';
  readonly vendor: string | null;
  readonly incurredOn: string;
  readonly targetOn: string | null;
  readonly note: string | null;
  readonly authorizationVersion: number;
}

export type DocumentOutcome =
  | { outcome: 'recorded'; document: StockDocumentView; mutation: MutationResult }
  | { outcome: 'invalid'; error: string }
  | { outcome: 'not_found' };

/** Records acquisition paperwork. Status and reference only — never content. */
export async function recordStockDocument(input: {
  actingUserLinkId: string;
  tenantId: string;
  stockItemId: string;
  documentType: DocumentType;
  status?: DocumentStatus | undefined;
  reference?: string | null | undefined;
  receivedOn?: string | null | undefined;
  note?: string | null | undefined;
}): Promise<DocumentOutcome> {
  const status = input.status ?? 'expected';
  if (status === 'received' && (input.receivedOn ?? '') === '') {
    return { outcome: 'invalid', error: 'a received document records the date it arrived' };
  }
  if (status !== 'received' && (input.receivedOn ?? '') !== '') {
    return { outcome: 'invalid', error: 'only a received document carries a received date' };
  }
  return withTenantTransaction(input.tenantId, async (executor) => {
    const actor = await requireActor(executor, input.actingUserLinkId);
    const stock = await executor.query(
      `SELECT 1 FROM stock_items WHERE tenant_id = $1 AND stock_item_id = $2`,
      [input.tenantId, input.stockItemId],
    );
    if (stock.rows.length === 0) return { outcome: 'not_found' as const };
    const written = await executor.query(
      `INSERT INTO stock_documents
         (tenant_id, stock_item_id, document_type, reference, status, received_on, note,
          created_by_user_link_id, updated_by_user_link_id)
       VALUES ($1, $2, $3, $4, $5, $6::date, $7, $8, $8)
       RETURNING document_id, document_type, reference, status, received_on, note,
                 authorization_version`,
      [
        input.tenantId,
        input.stockItemId,
        input.documentType,
        input.reference ?? null,
        status,
        (input.receivedOn ?? '') === '' ? null : input.receivedOn,
        input.note ?? null,
        actor,
      ],
    );
    const row = written.rows[0] as Row;
    const document: StockDocumentView = {
      documentId: String(row.document_id),
      documentType: String(row.document_type) as DocumentType,
      reference: row.reference === null ? null : String(row.reference),
      status: String(row.status) as DocumentStatus,
      receivedOn: row.received_on === null ? null : isoDate(row.received_on),
      note: row.note === null ? null : String(row.note),
      authorizationVersion: Number(row.authorization_version),
    };
    const mutation = await recordMutation(executor, {
      tenantId: input.tenantId,
      entityType: 'stock_document',
      entityId: document.documentId,
      eventType: 'inventory.stock.document_recorded',
      actingUserLinkId: actor,
      authorizationVersion: document.authorizationVersion,
      details: { document_type: document.documentType, status: document.status },
    });
    return { outcome: 'recorded' as const, document, mutation };
  });
}

export type CostOutcome =
  | { outcome: 'recorded'; cost: StockCostView; mutation: MutationResult }
  | { outcome: 'invalid'; error: string }
  | { outcome: 'not_found' };

/**
 * Records what the vehicle has cost, INCLUDING readiness work.
 *
 * A reconditioning row names a vendor, an amount, a status and a date and
 * stops there. It is deliberately NOT a repair order: the order excludes
 * repair diagnosis, technicians, labour operations and parts from this train,
 * and "readiness tracking remains inventory workflow only".
 */
export async function recordStockCost(input: {
  actingUserLinkId: string;
  tenantId: string;
  stockItemId: string;
  costType: CostType;
  amountCents: number;
  currency?: string | undefined;
  status?: 'estimated' | 'actual' | undefined;
  vendor?: string | null | undefined;
  incurredOn: string;
  targetOn?: string | null | undefined;
  note?: string | null | undefined;
}): Promise<CostOutcome> {
  if (!Number.isInteger(input.amountCents) || input.amountCents < 0) {
    return { outcome: 'invalid', error: 'an amount is a whole number of cents, at least zero' };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.incurredOn)) {
    return { outcome: 'invalid', error: 'incurred_on must be a YYYY-MM-DD date' };
  }
  return withTenantTransaction(input.tenantId, async (executor) => {
    const actor = await requireActor(executor, input.actingUserLinkId);
    const stock = await executor.query(
      `SELECT 1 FROM stock_items WHERE tenant_id = $1 AND stock_item_id = $2`,
      [input.tenantId, input.stockItemId],
    );
    if (stock.rows.length === 0) return { outcome: 'not_found' as const };
    const written = await executor.query(
      `INSERT INTO stock_costs
         (tenant_id, stock_item_id, cost_type, amount_cents, currency, status, vendor,
          incurred_on, target_on, note, created_by_user_link_id, updated_by_user_link_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::date, $9::date, $10, $11, $11)
       RETURNING cost_id, cost_type, amount_cents, currency, status, vendor, incurred_on,
                 target_on, note, authorization_version`,
      [
        input.tenantId,
        input.stockItemId,
        input.costType,
        input.amountCents,
        input.currency ?? 'USD',
        input.status ?? 'estimated',
        input.vendor ?? null,
        input.incurredOn,
        (input.targetOn ?? '') === '' ? null : input.targetOn,
        input.note ?? null,
        actor,
      ],
    );
    const row = written.rows[0] as Row;
    const cost: StockCostView = {
      costId: String(row.cost_id),
      costType: String(row.cost_type) as CostType,
      amountCents: Number(row.amount_cents),
      currency: String(row.currency),
      status: String(row.status) as 'estimated' | 'actual',
      vendor: row.vendor === null ? null : String(row.vendor),
      incurredOn: isoDate(row.incurred_on),
      targetOn: row.target_on === null ? null : isoDate(row.target_on),
      note: row.note === null ? null : String(row.note),
      authorizationVersion: Number(row.authorization_version),
    };
    const mutation = await recordMutation(executor, {
      tenantId: input.tenantId,
      entityType: 'stock_cost',
      entityId: cost.costId,
      eventType: 'inventory.stock.cost_recorded',
      actingUserLinkId: actor,
      authorizationVersion: cost.authorizationVersion,
      details: { cost_type: cost.costType, status: cost.status },
    });
    return { outcome: 'recorded' as const, cost, mutation };
  });
}
