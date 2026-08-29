/**
 * RELEASE TRAIN 2 — THE INVENTORY SURFACE (/api/inventory).
 *
 * The staff UI's API for acquiring, identifying, stocking, pricing,
 * merchandising and publishing vehicles. It follows the conventions Release
 * Train 1 established on `/api/admin` exactly, because they are the ones this
 * repository's gates and reviewers expect:
 *
 *   * `authenticate` + `requireAction(<catalog action>)` on every route, so
 *     every decision goes through the one policy path and leaves its evidence;
 *   * `application/problem+json` (RFC 9457) errors with a stable `code` and
 *     both correlation identifiers, rendered by this router's OWN error
 *     middleware — the legacy envelope on the pre-train surfaces is untouched;
 *   * `Idempotency-Key` on creating commands, with the outcome recorded in the
 *     SAME transaction as the effect;
 *   * `expected_version` optimistic concurrency on updates, answered 409.
 *
 * ROOFTOP AUTHORIZATION IS STRUCTURAL, NOT CHECKED HERE. Routes that act on a
 * vehicle name `:stockItemId`, and the catalog declares `stock_item` as the
 * resource type, so the policy engine resolves the car to the rooftop that
 * owns it and refuses a binding that does not reach it — reporting the row as
 * NOT FOUND rather than forbidden, so existence is never leaked. Nothing in
 * this file re-implements that decision.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import {
  ACQUISITION_SOURCES,
  CONSENT_CHANNELS,
  HOLD_TYPES,
  LIFECYCLE_STATES,
  PARTY_IMPORT_LIMIT,
  PRICE_TYPES,
  acquireStockWithin,
  addStockMediaWithin,
  contactableOn,
  createPartyWithin,
  decodeVehicle,
  getListing,
  getParty,
  getVehicle,
  importParties,
  inventoryView,
  listPartyConsents,
  listRooftops,
  listingHistory,
  mergeParties,
  placeStockHoldWithin,
  recordStockCost,
  recordStockDocument,
  releaseStockHold,
  reconcileListing,
  removeStockMedia,
  replaceStockFeaturesWithin,
  requestListingPublicationWithin,
  requestListingWithdrawalWithin,
  requestStockTransferWithin,
  searchParties,
  setPartyConsent,
  setStockPriceWithin,
  settleStockTransferWithin,
  stockDetail,
  transitionStockWithin,
  updateParty,
  updateStockDetails,
  updateVehicleAppearance,
  type AcquisitionSource,
  type ConsentChannel,
  type ConsentState,
  type HoldType,
  type LifecycleState,
  type PriceType,
} from '@dealer/inventory';
import { requestFingerprint, runIdempotentAdminCommand } from '@dealer/identity-access';
import type { Executor } from '@dealer/database';
import {
  AppError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnprocessableError,
  ValidationError,
  getRequestContext,
  toProblemDetails,
} from '@dealer/platform';
import {
  authenticate,
  rejectTenantOverride,
  requireAction,
  requireContext,
} from '../middleware/auth';

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Body {
  [key: string]: unknown;
}

function handler(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      rejectTenantOverride(req);
    } catch (err) {
      next(err);
      return;
    }
    fn(req, res).catch(next);
  };
}

function tenantOf(req: Request): string {
  const ctx = requireContext(req);
  if (ctx.tenantId === null || ctx.tenantId === undefined) {
    throw new ForbiddenError('The inventory surface is tenant-scoped', { code: 'tenant_required' });
  }
  return ctx.tenantId;
}

function actorOf(req: Request): string {
  return requireContext(req).userId;
}

function body(req: Request): Body {
  return (req.body ?? {}) as Body;
}

function requireUuidParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new NotFoundError('Resource not found');
  }
  return value;
}

function idempotencyKeyOf(req: Request): string | null {
  const raw = req.header('idempotency-key');
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed.length < 1 || trimmed.length > 128) {
    throw new ValidationError('Idempotency-Key must be 1-128 characters', {
      code: 'idempotency_key_invalid',
    });
  }
  return trimmed;
}

/** The model year the VIN cycle resolves against. */
function referenceYear(): number {
  return new Date().getUTCFullYear();
}

async function idempotent(
  req: Request,
  res: Response,
  work: (tx: Executor) => Promise<{ status: number; body: unknown }>,
): Promise<void> {
  const outcome = await runIdempotentAdminCommand({
    tenantId: tenantOf(req),
    actorUserLinkId: actorOf(req),
    idempotencyKey: idempotencyKeyOf(req),
    fingerprint: requestFingerprint(
      req.method,
      req.originalUrl.split('?')[0] ?? req.path,
      req.body,
    ),
    work,
  });
  if (outcome.conflict === true) {
    throw new UnprocessableError('This Idempotency-Key was already used for a different request', {
      code: 'idempotency_key_conflict',
    });
  }
  if (outcome.replayed) res.setHeader('Idempotency-Replayed', 'true');
  res.status(outcome.status).json(outcome.body);
}

/** Turns a service's refusal union into the problem the caller should see. */
function refuse(outcome: { outcome: string } & Record<string, unknown>): never {
  switch (outcome.outcome) {
    case 'not_found':
    case 'rooftop_not_found':
      throw new NotFoundError('Resource not found');
    case 'version_conflict':
      throw new ConflictError('This record changed since you loaded it — reload and retry', {
        code: 'version_conflict',
        details: { current_version: outcome.currentVersion as number },
      });
    case 'invalid':
      throw new UnprocessableError(String(outcome.error), { code: 'invalid_request' });
    case 'blocked':
      throw new UnprocessableError(String(outcome.error), { code: 'precondition_unmet' });
    case 'illegal':
      throw new UnprocessableError(
        `a vehicle cannot go from ${String(outcome.from)} to ${String(outcome.to)}`,
        { code: 'illegal_transition' },
      );
    case 'duplicate_stock_number':
      throw new ConflictError(`stock number ${String(outcome.stockNumber)} is already in use`, {
        code: 'duplicate_stock_number',
      });
    case 'vehicle_already_stocked':
      throw new ConflictError('this vehicle is already in stock', {
        code: 'vehicle_already_stocked',
        details: { stock_item_id: (outcome.stockItem as { stockItemId: string }).stockItemId },
      });
    case 'already_held':
      throw new ConflictError('this vehicle is already on hold', { code: 'already_held' });
    case 'already_open':
      throw new ConflictError('this vehicle already has an open transfer', {
        code: 'transfer_already_open',
      });
    default:
      throw new UnprocessableError('the command was refused', { code: 'refused' });
  }
}

// ── the owner view ──────────────────────────────────────────────────────────

router.get(
  '/overview',
  authenticate,
  requireAction('inventory.view'),
  handler(async (req, res) => {
    const tenantId = tenantOf(req);
    const rooftops = await listRooftops(tenantId);
    const view = await inventoryView(tenantId, {
      rooftopIds: null,
      limit: 200,
    });
    res.json({
      rooftops,
      inventory: view,
      vocabulary: {
        lifecycleStates: LIFECYCLE_STATES,
        acquisitionSources: ACQUISITION_SOURCES,
        priceTypes: PRICE_TYPES,
        holdTypes: HOLD_TYPES,
        consentChannels: CONSENT_CHANNELS,
        partyImportLimit: PARTY_IMPORT_LIMIT,
      },
    });
  }),
);

router.get(
  '/stock',
  authenticate,
  requireAction('inventory.view'),
  handler(async (req, res) => {
    const q = req.query as Record<string, unknown>;
    const rooftopId = typeof q.rooftop_id === 'string' ? q.rooftop_id : null;
    if (rooftopId !== null && !UUID_RE.test(rooftopId)) {
      throw new ValidationError('rooftop_id must be an identifier', { code: 'rooftop_invalid' });
    }
    res.json(
      await inventoryView(tenantOf(req), {
        rooftopIds: rooftopId === null ? null : [rooftopId],
        lifecycleState: typeof q.lifecycle_state === 'string' ? q.lifecycle_state : null,
        query: typeof q.q === 'string' ? q.q : null,
        includeRetired: q.include_retired === 'true',
        limit: typeof q.limit === 'string' ? Number(q.limit) : undefined,
        offset: typeof q.offset === 'string' ? Number(q.offset) : undefined,
      }),
    );
  }),
);

// ── row 1: acquisition parties ──────────────────────────────────────────────

router.get(
  '/parties',
  authenticate,
  requireAction('inventory.party.view'),
  handler(async (req, res) => {
    const q = req.query as Record<string, unknown>;
    res.json(
      await searchParties(tenantOf(req), {
        query: typeof q.q === 'string' ? q.q : null,
        includeInactive: q.include_inactive === 'true',
        limit: typeof q.limit === 'string' ? Number(q.limit) : undefined,
      }),
    );
  }),
);

router.get(
  '/parties/:partyId',
  authenticate,
  requireAction('inventory.party.view'),
  handler(async (req, res) => {
    const partyId = requireUuidParam(req, 'partyId');
    const tenantId = tenantOf(req);
    const party = await getParty(tenantId, partyId);
    if (party === null) throw new NotFoundError('Resource not found');
    res.json({ party, consents: await listPartyConsents(tenantId, partyId) });
  }),
);

router.post(
  '/parties',
  authenticate,
  requireAction('inventory.party.create'),
  handler(async (req, res) => {
    const b = body(req);
    const partyType = b.party_type === 'organization' ? 'organization' : 'person';
    await idempotent(req, res, async (tx) => {
      const created = await createPartyWithin(tx, {
        actingUserLinkId: actorOf(req),
        tenantId: tenantOf(req),
        partyType,
        allowDuplicate: b.allow_duplicate === true,
        details: {
          displayName: typeof b.display_name === 'string' ? b.display_name : undefined,
          givenName: typeof b.given_name === 'string' ? b.given_name : undefined,
          familyName: typeof b.family_name === 'string' ? b.family_name : undefined,
          organizationName:
            typeof b.organization_name === 'string' ? b.organization_name : undefined,
          email: typeof b.email === 'string' ? b.email : undefined,
          phone: typeof b.phone === 'string' ? b.phone : undefined,
          addressLine1: typeof b.address_line1 === 'string' ? b.address_line1 : undefined,
          addressCity: typeof b.address_city === 'string' ? b.address_city : undefined,
          addressRegion: typeof b.address_region === 'string' ? b.address_region : undefined,
          addressPostalCode:
            typeof b.address_postal_code === 'string' ? b.address_postal_code : undefined,
          addressCountry: typeof b.address_country === 'string' ? b.address_country : undefined,
        },
      });
      if (created.outcome === 'invalid') {
        throw new UnprocessableError(created.error, { code: 'invalid_request' });
      }
      // A DUPLICATE IS AN ANSWER, NOT AN ERROR. The caller is shown who the
      // candidates are so a human can decide, and may repeat the request with
      // allow_duplicate to record that decision.
      if (created.outcome === 'duplicate') {
        return {
          status: 409,
          body: {
            outcome: 'duplicate',
            candidates: created.candidates.map((c: { matchedOn: string; party: unknown }) => ({
              matchedOn: c.matchedOn,
              party: c.party,
            })),
          },
        };
      }
      return { status: 201, body: { party: created.party } };
    });
  }),
);

router.put(
  '/parties/:partyId',
  authenticate,
  requireAction('inventory.party.update'),
  handler(async (req, res) => {
    const partyId = requireUuidParam(req, 'partyId');
    const b = body(req);
    if (!Number.isInteger(Number(b.expected_version))) {
      throw new ValidationError('expected_version is required', {
        code: 'expected_version_required',
      });
    }
    const updated = await updateParty({
      actingUserLinkId: actorOf(req),
      tenantId: tenantOf(req),
      partyId,
      expectedVersion: Number(b.expected_version),
      // The same explicit staff decision the create path takes: retyping one
      // customer's email onto another record is refused unless a human says
      // these really are two people who share it.
      allowDuplicate: b.allow_duplicate === true,
      details: {
        displayName: typeof b.display_name === 'string' ? b.display_name : undefined,
        givenName: typeof b.given_name === 'string' ? b.given_name : undefined,
        familyName: typeof b.family_name === 'string' ? b.family_name : undefined,
        organizationName: typeof b.organization_name === 'string' ? b.organization_name : undefined,
        email: b.email === undefined ? undefined : String(b.email),
        phone: b.phone === undefined ? undefined : String(b.phone),
        addressLine1: typeof b.address_line1 === 'string' ? b.address_line1 : undefined,
        addressCity: typeof b.address_city === 'string' ? b.address_city : undefined,
        addressRegion: typeof b.address_region === 'string' ? b.address_region : undefined,
        addressPostalCode:
          typeof b.address_postal_code === 'string' ? b.address_postal_code : undefined,
        addressCountry: typeof b.address_country === 'string' ? b.address_country : undefined,
      },
    });
    if (updated.outcome === 'duplicate') {
      throw new ConflictError('those contact details belong to another customer', {
        code: 'duplicate_party',
      });
    }
    if (updated.outcome !== 'saved') refuse(updated);
    res.json({ party: updated.party });
  }),
);

router.put(
  '/parties/:partyId/consents/:channel',
  authenticate,
  requireAction('inventory.party.update'),
  handler(async (req, res) => {
    const partyId = requireUuidParam(req, 'partyId');
    const b = body(req);
    const result = await setPartyConsent({
      actingUserLinkId: actorOf(req),
      tenantId: tenantOf(req),
      partyId,
      channel: String(req.params.channel ?? '') as ConsentChannel,
      state: String(b.state ?? '') as ConsentState,
      source: typeof b.source === 'string' ? b.source : '',
      note: typeof b.note === 'string' ? b.note : null,
    });
    if (result.outcome !== 'saved') refuse(result);
    res.json({ consents: result.consents });
  }),
);

router.get(
  '/parties/:partyId/contactable/:channel',
  authenticate,
  requireAction('inventory.party.view'),
  handler(async (req, res) => {
    const partyId = requireUuidParam(req, 'partyId');
    const channel = String(req.params.channel ?? '') as ConsentChannel;
    if (!CONSENT_CHANNELS.includes(channel)) throw new NotFoundError('Resource not found');
    res.json({ channel, contactable: await contactableOn(tenantOf(req), partyId, channel) });
  }),
);

router.post(
  '/parties/merge',
  authenticate,
  requireAction('inventory.party.merge'),
  handler(async (req, res) => {
    const b = body(req);
    const surviving = String(b.surviving_party_id ?? '');
    const merged = String(b.merged_party_id ?? '');
    if (!UUID_RE.test(surviving) || !UUID_RE.test(merged)) {
      throw new ValidationError('both party identifiers are required', {
        code: 'party_ids_required',
      });
    }
    const result = await mergeParties({
      actingUserLinkId: actorOf(req),
      tenantId: tenantOf(req),
      survivingPartyId: surviving,
      mergedPartyId: merged,
      reason: typeof b.reason === 'string' ? b.reason : null,
    });
    if (result.outcome !== 'merged') refuse(result);
    res.json({
      surviving: result.surviving,
      merged: result.merged,
      summary: result.summary,
    });
  }),
);

router.post(
  '/parties/import',
  authenticate,
  requireAction('inventory.party.import'),
  handler(async (req, res) => {
    const b = body(req);
    if (!Array.isArray(b.rows)) {
      throw new ValidationError('rows must be an array', { code: 'rows_required' });
    }
    const summary = await importParties({
      actingUserLinkId: actorOf(req),
      tenantId: tenantOf(req),
      rows: (b.rows as Body[]).map((r) => ({
        partyType: typeof r.party_type === 'string' ? r.party_type : undefined,
        displayName: typeof r.display_name === 'string' ? r.display_name : undefined,
        givenName: typeof r.given_name === 'string' ? r.given_name : undefined,
        familyName: typeof r.family_name === 'string' ? r.family_name : undefined,
        organizationName: typeof r.organization_name === 'string' ? r.organization_name : undefined,
        email: typeof r.email === 'string' ? r.email : undefined,
        phone: typeof r.phone === 'string' ? r.phone : undefined,
      })),
    });
    if ('error' in summary) {
      throw new UnprocessableError(summary.error, { code: 'import_invalid' });
    }
    res.json(summary);
  }),
);

// ── row 2: vehicles and acquisition ─────────────────────────────────────────

router.get(
  '/vehicles/:vehicleId',
  authenticate,
  requireAction('inventory.vehicle.view'),
  handler(async (req, res) => {
    const vehicleId = requireUuidParam(req, 'vehicleId');
    const vehicle = await getVehicle(tenantOf(req), vehicleId);
    if (vehicle === null) throw new NotFoundError('Resource not found');
    res.json({ vehicle });
  }),
);

router.post(
  '/vehicles/:vehicleId/decode',
  authenticate,
  requireAction('inventory.vehicle.decode'),
  handler(async (req, res) => {
    const vehicleId = requireUuidParam(req, 'vehicleId');
    const result = await decodeVehicle({
      actingUserLinkId: actorOf(req),
      tenantId: tenantOf(req),
      vehicleId,
      referenceYear: referenceYear(),
    });
    if (result.outcome === 'not_found') throw new NotFoundError('Resource not found');
    if (result.outcome !== 'decoded') {
      // A provider that will not decode is not a client error: the request was
      // right, the answer was 'no'. It is reported with the vehicle so the UI
      // can show what it does know and offer a retry.
      res.status(200).json({
        outcome: result.outcome,
        message: result.message,
        vehicle: result.vehicle,
        features: [],
      });
      return;
    }
    res.json({
      outcome: 'decoded',
      vehicle: result.vehicle,
      features: result.features,
    });
  }),
);

router.put(
  '/vehicles/:vehicleId/appearance',
  authenticate,
  requireAction('inventory.vehicle.decode'),
  handler(async (req, res) => {
    const vehicleId = requireUuidParam(req, 'vehicleId');
    const b = body(req);
    const updated = await updateVehicleAppearance({
      actingUserLinkId: actorOf(req),
      tenantId: tenantOf(req),
      vehicleId,
      expectedVersion: Number(b.expected_version),
      exteriorColor: b.exterior_color === undefined ? undefined : String(b.exterior_color),
      interiorColor: b.interior_color === undefined ? undefined : String(b.interior_color),
    });
    if (updated.outcome !== 'saved') refuse(updated);
    res.json({ vehicle: updated.vehicle });
  }),
);

/**
 * THE ACQUISITION. `location_id` in the body is not decoration: the action is
 * resource-less (the car does not exist yet), so the policy engine builds its
 * scope hint from that field and a rooftop-bound employee may only acquire
 * into their own rooftop.
 */
router.post(
  '/stock',
  authenticate,
  requireAction('inventory.stock.acquire'),
  handler(async (req, res) => {
    const b = body(req);
    const rooftopId = String(b.location_id ?? '');
    if (!UUID_RE.test(rooftopId)) {
      throw new ValidationError('location_id names the rooftop acquiring the vehicle', {
        code: 'location_required',
      });
    }
    const newParty =
      b.new_party === undefined || b.new_party === null
        ? null
        : (() => {
            const np = b.new_party as Body;
            return {
              partyType: (np.party_type === 'organization' ? 'organization' : 'person') as
                'person' | 'organization',
              details: {
                displayName: typeof np.display_name === 'string' ? np.display_name : undefined,
                givenName: typeof np.given_name === 'string' ? np.given_name : undefined,
                familyName: typeof np.family_name === 'string' ? np.family_name : undefined,
                organizationName:
                  typeof np.organization_name === 'string' ? np.organization_name : undefined,
                email: typeof np.email === 'string' ? np.email : undefined,
                phone: typeof np.phone === 'string' ? np.phone : undefined,
              },
            };
          })();

    await idempotent(req, res, async (tx) => {
      const acquired = await acquireStockWithin(tx, {
        actingUserLinkId: actorOf(req),
        tenantId: tenantOf(req),
        rooftopId,
        vin: b.vin,
        stockNumber: b.stock_number,
        acquisitionSource: String(b.acquisition_source ?? '') as AcquisitionSource,
        acquiredOn: String(b.acquired_on ?? ''),
        referenceYear: referenceYear(),
        odometer: b.odometer === undefined || b.odometer === null ? null : Number(b.odometer),
        odometerUnit: b.odometer_unit === 'km' ? 'km' : 'mi',
        titleStatus: typeof b.title_status === 'string' ? (b.title_status as 'pending') : undefined,
        locationLabel: typeof b.location_label === 'string' ? b.location_label : null,
        acquisitionPartyId:
          typeof b.acquisition_party_id === 'string' ? b.acquisition_party_id : null,
        newParty,
      });
      if (acquired.outcome !== 'acquired') refuse(acquired);
      return {
        status: 201,
        body: {
          stockItem: acquired.stockItem,
          vehicle: acquired.vehicle,
          party: acquired.party,
          vehicleCreated: acquired.vehicleCreated,
        },
      };
    });
  }),
);

router.get(
  '/stock/:stockItemId',
  authenticate,
  requireAction('inventory.stock.view'),
  handler(async (req, res) => {
    const stockItemId = requireUuidParam(req, 'stockItemId');
    const detail = await stockDetail(tenantOf(req), stockItemId);
    if (detail === null) throw new NotFoundError('Resource not found');
    res.json(detail);
  }),
);

router.put(
  '/stock/:stockItemId',
  authenticate,
  requireAction('inventory.stock.update'),
  handler(async (req, res) => {
    const stockItemId = requireUuidParam(req, 'stockItemId');
    const b = body(req);
    const updated = await updateStockDetails({
      actingUserLinkId: actorOf(req),
      tenantId: tenantOf(req),
      stockItemId,
      expectedVersion: Number(b.expected_version),
      odometer:
        b.odometer === undefined ? undefined : b.odometer === null ? null : Number(b.odometer),
      odometerUnit: b.odometer_unit === 'km' ? 'km' : b.odometer_unit === 'mi' ? 'mi' : undefined,
      titleStatus: typeof b.title_status === 'string' ? (b.title_status as 'pending') : undefined,
      locationLabel: b.location_label === undefined ? undefined : String(b.location_label),
    });
    if (updated.outcome !== 'saved') refuse(updated);
    res.json({ stockItem: updated.stockItem });
  }),
);

router.post(
  '/stock/:stockItemId/transition',
  authenticate,
  requireAction('inventory.stock.transition'),
  handler(async (req, res) => {
    const stockItemId = requireUuidParam(req, 'stockItemId');
    const b = body(req);
    await idempotent(req, res, async (tx) => {
      const result = await transitionStockWithin(tx, {
        actingUserLinkId: actorOf(req),
        tenantId: tenantOf(req),
        stockItemId,
        to: String(b.to ?? '') as LifecycleState,
        expectedVersion:
          b.expected_version === undefined || b.expected_version === null
            ? null
            : Number(b.expected_version),
        reason: typeof b.reason === 'string' ? b.reason : null,
      });
      if (result.outcome !== 'transitioned') refuse(result);
      return { status: 200, body: { stockItem: result.stockItem } };
    });
  }),
);

router.post(
  '/stock/:stockItemId/documents',
  authenticate,
  requireAction('inventory.stock.document'),
  handler(async (req, res) => {
    const stockItemId = requireUuidParam(req, 'stockItemId');
    const b = body(req);
    const result = await recordStockDocument({
      actingUserLinkId: actorOf(req),
      tenantId: tenantOf(req),
      stockItemId,
      documentType: String(b.document_type ?? '') as 'title',
      status: typeof b.status === 'string' ? (b.status as 'expected') : undefined,
      reference: typeof b.reference === 'string' ? b.reference : null,
      receivedOn: typeof b.received_on === 'string' ? b.received_on : null,
      note: typeof b.note === 'string' ? b.note : null,
    });
    if (result.outcome !== 'recorded') refuse(result);
    res.status(201).json({ document: result.document });
  }),
);

router.post(
  '/stock/:stockItemId/costs',
  authenticate,
  requireAction('inventory.stock.cost'),
  handler(async (req, res) => {
    const stockItemId = requireUuidParam(req, 'stockItemId');
    const b = body(req);
    const result = await recordStockCost({
      actingUserLinkId: actorOf(req),
      tenantId: tenantOf(req),
      stockItemId,
      costType: String(b.cost_type ?? '') as 'purchase',
      amountCents: Number(b.amount_cents),
      currency: typeof b.currency === 'string' ? b.currency : undefined,
      status: b.status === 'actual' ? 'actual' : 'estimated',
      vendor: typeof b.vendor === 'string' ? b.vendor : null,
      incurredOn: String(b.incurred_on ?? ''),
      targetOn: typeof b.target_on === 'string' ? b.target_on : null,
      note: typeof b.note === 'string' ? b.note : null,
    });
    if (result.outcome !== 'recorded') refuse(result);
    res.status(201).json({ cost: result.cost });
  }),
);

// ── row 3: merchandising ────────────────────────────────────────────────────

router.post(
  '/stock/:stockItemId/prices',
  authenticate,
  requireAction('inventory.price.set'),
  handler(async (req, res) => {
    const stockItemId = requireUuidParam(req, 'stockItemId');
    const b = body(req);
    await idempotent(req, res, async (tx) => {
      const result = await setStockPriceWithin(tx, {
        actingUserLinkId: actorOf(req),
        tenantId: tenantOf(req),
        stockItemId,
        priceType: String(b.price_type ?? '') as PriceType,
        amountCents: Number(b.amount_cents),
        currency: typeof b.currency === 'string' ? b.currency : undefined,
        reason: typeof b.reason === 'string' ? b.reason : null,
      });
      if (result.outcome !== 'priced') refuse(result);
      return { status: 201, body: { price: result.price, superseded: result.superseded } };
    });
  }),
);

router.post(
  '/stock/:stockItemId/media',
  authenticate,
  requireAction('inventory.media.manage'),
  handler(async (req, res) => {
    const stockItemId = requireUuidParam(req, 'stockItemId');
    const b = body(req);
    await idempotent(req, res, async (tx) => {
      const result = await addStockMediaWithin(tx, {
        actingUserLinkId: actorOf(req),
        tenantId: tenantOf(req),
        stockItemId,
        uri: String(b.uri ?? ''),
        caption: typeof b.caption === 'string' ? b.caption : null,
        position: b.position === undefined || b.position === null ? null : Number(b.position),
      });
      if (result.outcome !== 'added') refuse(result);
      return { status: 201, body: { media: result.media } };
    });
  }),
);

router.delete(
  '/stock/:stockItemId/media/:mediaId',
  authenticate,
  requireAction('inventory.media.manage'),
  handler(async (req, res) => {
    const stockItemId = requireUuidParam(req, 'stockItemId');
    const mediaId = requireUuidParam(req, 'mediaId');
    const result = await removeStockMedia({
      actingUserLinkId: actorOf(req),
      tenantId: tenantOf(req),
      stockItemId,
      mediaId,
    });
    if (result.outcome !== 'removed') refuse(result);
    res.json({ media: { mediaId, status: 'removed' } });
  }),
);

router.put(
  '/stock/:stockItemId/features',
  authenticate,
  requireAction('inventory.features.manage'),
  handler(async (req, res) => {
    const stockItemId = requireUuidParam(req, 'stockItemId');
    const b = body(req);
    if (!Array.isArray(b.features)) {
      throw new ValidationError('features must be an array', { code: 'features_required' });
    }
    await idempotent(req, res, async (tx) => {
      const result = await replaceStockFeaturesWithin(tx, {
        actingUserLinkId: actorOf(req),
        tenantId: tenantOf(req),
        stockItemId,
        expectedVersion:
          b.expected_version === undefined || b.expected_version === null
            ? null
            : Number(b.expected_version),
        features: (b.features as Body[]).map((f) => ({
          code: String(f.code ?? ''),
          label: String(f.label ?? ''),
          source: f.source === 'decoded' ? 'decoded' : 'manual',
        })),
      });
      if (result.outcome !== 'replaced') refuse(result);
      return { status: 200, body: { features: result.features } };
    });
  }),
);

router.post(
  '/stock/:stockItemId/holds',
  authenticate,
  requireAction('inventory.hold.manage'),
  handler(async (req, res) => {
    const stockItemId = requireUuidParam(req, 'stockItemId');
    const b = body(req);
    await idempotent(req, res, async (tx) => {
      const result = await placeStockHoldWithin(tx, {
        actingUserLinkId: actorOf(req),
        tenantId: tenantOf(req),
        stockItemId,
        holdType: String(b.hold_type ?? '') as HoldType,
        reason: String(b.reason ?? ''),
      });
      if (result.outcome !== 'placed') refuse(result);
      return { status: 201, body: { hold: result.hold } };
    });
  }),
);

router.post(
  '/stock/:stockItemId/holds/:holdId/release',
  authenticate,
  requireAction('inventory.hold.manage'),
  handler(async (req, res) => {
    const stockItemId = requireUuidParam(req, 'stockItemId');
    const holdId = requireUuidParam(req, 'holdId');
    const result = await releaseStockHold({
      actingUserLinkId: actorOf(req),
      tenantId: tenantOf(req),
      stockItemId,
      holdId,
      releaseReason:
        typeof body(req).release_reason === 'string' ? String(body(req).release_reason) : null,
    });
    if (result.outcome !== 'released') refuse(result);
    res.json({ hold: result.hold });
  }),
);

router.post(
  '/stock/:stockItemId/transfers',
  authenticate,
  requireAction('inventory.transfer.request'),
  handler(async (req, res) => {
    const stockItemId = requireUuidParam(req, 'stockItemId');
    const b = body(req);
    const toRooftopId = String(b.to_rooftop_id ?? '');
    if (!UUID_RE.test(toRooftopId)) {
      throw new ValidationError('to_rooftop_id is required', { code: 'to_rooftop_required' });
    }
    await idempotent(req, res, async (tx) => {
      const result = await requestStockTransferWithin(tx, {
        actingUserLinkId: actorOf(req),
        tenantId: tenantOf(req),
        stockItemId,
        toRooftopId,
        reason: typeof b.reason === 'string' ? b.reason : null,
      });
      if (result.outcome !== 'requested') refuse(result);
      return { status: 201, body: { transfer: result.transfer } };
    });
  }),
);

router.post(
  '/stock/:stockItemId/transfers/:transferId/settle',
  authenticate,
  requireAction('inventory.transfer.settle'),
  handler(async (req, res) => {
    requireUuidParam(req, 'stockItemId');
    const transferId = requireUuidParam(req, 'transferId');
    const state = body(req).state === 'cancelled' ? 'cancelled' : 'completed';
    await idempotent(req, res, async (tx) => {
      const result = await settleStockTransferWithin(tx, {
        actingUserLinkId: actorOf(req),
        tenantId: tenantOf(req),
        transferId,
        state,
      });
      if (result.outcome !== 'settled') refuse(result);
      return { status: 200, body: { transfer: result.transfer } };
    });
  }),
);

// ── row 3: publication ──────────────────────────────────────────────────────

router.post(
  '/stock/:stockItemId/listings',
  authenticate,
  requireAction('inventory.listing.publish'),
  handler(async (req, res) => {
    const stockItemId = requireUuidParam(req, 'stockItemId');
    const channel = String(body(req).channel ?? '');
    await idempotent(req, res, async (tx) => {
      const result = await requestListingPublicationWithin(tx, {
        actingUserLinkId: actorOf(req),
        tenantId: tenantOf(req),
        stockItemId,
        channel,
      });
      if (result.outcome !== 'requested') refuse(result);
      return { status: 202, body: { listing: result.listing } };
    });
  }),
);

router.post(
  '/listings/:listingId/withdraw',
  authenticate,
  requireAction('inventory.listing.withdraw'),
  handler(async (req, res) => {
    const listingId = requireUuidParam(req, 'listingId');
    await idempotent(req, res, async (tx) => {
      const result = await requestListingWithdrawalWithin(tx, {
        actingUserLinkId: actorOf(req),
        tenantId: tenantOf(req),
        listingId,
      });
      if (result.outcome !== 'requested') refuse(result);
      return { status: 202, body: { listing: result.listing } };
    });
  }),
);

router.post(
  '/listings/:listingId/reconcile',
  authenticate,
  requireAction('inventory.listing.reconcile'),
  handler(async (req, res) => {
    const listingId = requireUuidParam(req, 'listingId');
    const result = await reconcileListing({ tenantId: tenantOf(req), listingId });
    if (result === null) throw new NotFoundError('Resource not found');
    res.json(result);
  }),
);

router.get(
  '/listings/:listingId',
  authenticate,
  requireAction('inventory.listing.reconcile'),
  handler(async (req, res) => {
    const listingId = requireUuidParam(req, 'listingId');
    const tenantId = tenantOf(req);
    const listing = await getListing(tenantId, listingId);
    if (listing === null) throw new NotFoundError('Resource not found');
    res.json({ listing, history: await listingHistory(tenantId, listingId) });
  }),
);

// ── problem+json rendering (RFC 9457) ───────────────────────────────────────

router.use((req: Request, res: Response) => {
  const context = getRequestContext();
  const instance = req.originalUrl.split('?')[0] ?? '';
  res
    .status(404)
    .type('application/problem+json')
    .json({
      type: 'urn:dealer:error:route_not_found',
      title: 'Not Found',
      status: 404,
      detail: `No route for ${req.method} ${instance}`,
      instance,
      code: 'route_not_found',
      ...(context !== undefined
        ? { requestId: context.requestId, correlationId: context.correlationId }
        : {}),
    });
});

// Express recognizes an error handler by its arity — the fourth parameter must
// exist even though this terminal renderer never calls it.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
router.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  const problem = toProblemDetails(err, { instance: req.originalUrl.split('?')[0] ?? req.path });
  const context = getRequestContext();
  res
    .status(problem.status)
    .type('application/problem+json')
    .json({
      ...problem,
      ...(context !== undefined ? { correlationId: context.correlationId } : {}),
      ...(err instanceof AppError && err.details !== undefined ? { errors: err.details } : {}),
    });
});

export default router;
