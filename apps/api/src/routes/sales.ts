/**
 * RELEASE TRAIN 4 — THE SALES SURFACE (/api/sales).
 *
 * It follows the conventions the earlier trains established, because they are
 * the ones this repository's gates and reviewers expect: `authenticate` +
 * `requireAction`, problem+json errors, `Idempotency-Key` on creating commands
 * with the outcome recorded in the same transaction as the effect, and
 * `expected_version` optimistic concurrency.
 *
 * EVERY CHILD IS ADDRESSED THROUGH ITS AUTHORIZED PARENT. A route whose action
 * declares `resourceType: 'opportunity'` carries `:opportunityId`, and the
 * service is handed that id so a row belonging to a different opportunity is
 * NOT FOUND rather than acted on.
 *
 * NOTHING HERE ASKS ANYBODY TO TYPE AN IDENTIFIER. The `/find/*` reads are the
 * lists the console picks from — handoffs, customers, appointments, vehicles,
 * colleagues — each filtered to the rooftops the caller's bindings reach. A
 * form that asks for a UUID is both a worse interface and a way to probe for
 * records, and every refusal that explains what it refused leaks.
 *
 * REPLAYS CONVERGE. Beyond the idempotency layer, the commands that matter
 * answer their own "you already did this" case — `already_received`,
 * `already_assigned`, `already_there`, `already_here` — because a retry that
 * arrives with a fresh request key is invisible to that layer and must still be
 * safe.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import {
  acceptOpportunity,
  acceptVisit,
  activeDemonstrations,
  assignOpportunity,
  cancelDemonstration,
  checkInWithin,
  chooseInventory,
  closeSalesActivity,
  departVisit,
  eligibleStaff,
  expectedAppointments,
  getOpportunity,
  greetVisit,
  issueDemonstrationWithin,
  joinFloorWithin,
  listFloor,
  listOpportunities,
  listShortlist,
  listVisits,
  logSalesActivityWithin,
  moveOpportunityStage,
  openActions,
  openWalkInWithin,
  opportunityHeader,
  opportunityTimeline,
  pendingHandoffs,
  receiveHandoffWithin,
  recordDemonstrationException,
  recordNegotiationRound,
  recordTurnover,
  releaseToFloor,
  returnDemonstration,
  salesBoard,
  setVehicleStatus,
  shortlistVehicleWithin,
  startDemonstration,
  SALES_ROLES,
  type OpportunityStage,
} from '@dealer/sales';
import { searchParties, createPartyWithin } from '@dealer/inventory';
import {
  permittedRooftopIds,
  requestFingerprint,
  runIdempotentAdminCommand,
} from '@dealer/identity-access';
import { ROLES } from '@dealer/contracts';
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
    throw new ForbiddenError('The sales surface is tenant-scoped', { code: 'tenant_required' });
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

function requireUuidField(b: Body, name: string): string {
  const value = b[name];
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new ValidationError(`${name} must name a record you selected`, {
      code: 'selection_required',
    });
  }
  return value;
}

function optionalUuidField(b: Body, name: string): string | null {
  const value = b[name];
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new ValidationError(`${name} must name a record you selected`, {
      code: 'selection_required',
    });
  }
  return value;
}

function expectedVersionOf(req: Request): number {
  const raw = body(req).expected_version;
  if (!Number.isInteger(Number(raw))) {
    throw new ValidationError('expected_version is required', {
      code: 'expected_version_required',
    });
  }
  return Number(raw);
}

function strOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
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
      throw new NotFoundError('Resource not found');
    case 'version_conflict':
      throw new ConflictError('This record changed since you loaded it — reload and retry', {
        code: 'version_conflict',
        details: { current_version: outcome.currentVersion as number },
      });
    case 'invalid':
      throw new UnprocessableError(String(outcome.error), { code: 'invalid_request' });
    case 'nobody_available':
      throw new UnprocessableError('nobody is available on the floor', { code: 'floor_empty' });
    case 'unavailable':
      // NEUTRAL AND ID-FREE. The caller learns which of their own inputs is
      // busy and nothing at all about the record that holds it — not its id,
      // not whose it is, not which customer has the car.
      throw new ConflictError(
        outcome.conflict === 'vehicle'
          ? 'that vehicle is not available right now'
          : outcome.conflict === 'driver'
            ? 'that driver is already out on a test drive'
            : 'that salesperson is already out on a test drive',
        { code: 'unavailable', details: { conflict: outcome.conflict as string } },
      );
    default:
      throw new UnprocessableError('the command was refused', { code: 'refused' });
  }
}

/**
 * The rooftops this actor may see — the SQL-level filter for every read.
 *
 * Read from the actor's EFFECTIVE bindings, and narrowed (never widened) by a
 * named `location_id`, which is also what the middleware turns into the
 * engine's scope hint. Honouring it here keeps the rows returned identical to
 * the rows authorized.
 */
async function rooftopsOf(req: Request): Promise<string[]> {
  const permitted = await permittedRooftopIds(tenantOf(req), actorOf(req));
  const fromQuery = (req.query as Record<string, unknown>).location_id;
  const fromBody = body(req).location_id;
  const named = typeof fromQuery === 'string' ? fromQuery : fromBody;
  if (typeof named === 'string' && UUID_RE.test(named)) {
    return permitted.filter((id) => id === named);
  }
  return permitted;
}

/** A rooftop named in a body, checked against what this actor reaches. */
async function namedRooftop(req: Request, b: Body): Promise<string> {
  const rooftopId = requireUuidField(b, 'location_id');
  const permitted = await permittedRooftopIds(tenantOf(req), actorOf(req));
  if (!permitted.includes(rooftopId)) throw new NotFoundError('Resource not found');
  return rooftopId;
}

// ── discovery: the lists that replace typed identifiers ─────────────────────

router.get(
  '/find/handoffs',
  authenticate,
  requireAction('sales.discovery.read'),
  handler(async (req, res) => {
    res.json({ handoffs: await pendingHandoffs(tenantOf(req), await rooftopsOf(req)) });
  }),
);

router.get(
  '/find/customers',
  authenticate,
  requireAction('sales.discovery.read'),
  handler(async (req, res) => {
    const q = (req.query as Record<string, unknown>).q;
    const found = await searchParties(tenantOf(req), {
      query: typeof q === 'string' ? q : null,
      limit: 25,
    });
    // The canonical customer list, and only what a salesperson needs to
    // recognise somebody: a name, a masked contact and whether the record is
    // live. Full contact details belong to the CRM screens that own them.
    res.json({
      customers: found.parties.map((p) => ({
        partyId: p.partyId,
        displayName: p.displayName,
        partyType: p.partyType,
        status: p.status,
        hasEmail: p.email !== null,
        hasPhone: p.phone !== null,
      })),
      total: found.total,
    });
  }),
);

router.get(
  '/find/appointments',
  authenticate,
  requireAction('sales.discovery.read'),
  handler(async (req, res) => {
    res.json({ appointments: await expectedAppointments(tenantOf(req), await rooftopsOf(req)) });
  }),
);

router.get(
  '/find/vehicles',
  authenticate,
  requireAction('sales.discovery.read'),
  handler(async (req, res) => {
    const q = (req.query as Record<string, unknown>).q;
    res.json({
      vehicles: await chooseInventory(tenantOf(req), await rooftopsOf(req), {
        query: typeof q === 'string' ? q : null,
      }),
    });
  }),
);

router.get(
  '/find/staff',
  authenticate,
  requireAction('sales.discovery.read'),
  handler(async (req, res) => {
    const q = req.query as Record<string, unknown>;
    const rooftops = await rooftopsOf(req);
    const rooftopId = typeof q.location_id === 'string' ? q.location_id : rooftops[0];
    if (rooftopId === undefined || !rooftops.includes(rooftopId)) {
      throw new ValidationError('location_id names which showroom’s people to list', {
        code: 'location_required',
      });
    }
    const wanted = q.role === 'manager' ? [ROLES.SALES_MANAGER] : SALES_ROLES;
    res.json({ staff: await eligibleStaff(tenantOf(req), rooftopId, wanted), rooftopId });
  }),
);

// ── the board and the pipeline ──────────────────────────────────────────────

router.get(
  '/board',
  authenticate,
  requireAction('sales.opportunity.view'),
  handler(async (req, res) => {
    res.json(await salesBoard(tenantOf(req), await rooftopsOf(req)));
  }),
);

router.get(
  '/opportunities',
  authenticate,
  requireAction('sales.opportunity.view'),
  handler(async (req, res) => {
    const q = req.query as Record<string, unknown>;
    res.json({
      opportunities: await listOpportunities({
        tenantId: tenantOf(req),
        rooftopIds: await rooftopsOf(req),
        stage: strOrNull(q.stage),
        ownerUserLinkId: typeof q.owner === 'string' && UUID_RE.test(q.owner) ? q.owner : null,
        limit: typeof q.limit === 'string' ? Number(q.limit) : undefined,
      }),
    });
  }),
);

router.get(
  '/opportunities/:opportunityId',
  authenticate,
  requireAction('sales.opportunity.read'),
  handler(async (req, res) => {
    const opportunityId = requireUuidParam(req, 'opportunityId');
    const tenantId = tenantOf(req);
    const opportunity = await getOpportunity(tenantId, opportunityId);
    if (opportunity === null) throw new NotFoundError('Resource not found');
    const rooftops = await rooftopsOf(req);
    // The header carries the names and the next thing owed, and it is ALSO the
    // visibility check: a rooftop this actor cannot reach returns nothing, so a
    // tenant-wide row lookup still answers 404 at the rooftop.
    const header = await opportunityHeader(tenantId, opportunityId, rooftops);
    if (header === null) throw new NotFoundError('Resource not found');
    res.json({
      opportunity: { ...opportunity, ...header },
      shortlist: await listShortlist(tenantId, opportunityId, rooftops),
      outOnDrive: await activeDemonstrations(tenantId, rooftops, opportunityId),
      openActions: await openActions(tenantId, opportunityId, rooftops),
      timeline: await opportunityTimeline(tenantId, opportunityId, rooftops),
    });
  }),
);

router.post(
  '/opportunities',
  authenticate,
  requireAction('sales.opportunity.receive'),
  handler(async (req, res) => {
    const b = body(req);
    const handoffId = requireUuidField(b, 'handoff_id');
    await idempotent(req, res, async (tx) => {
      const received = await receiveHandoffWithin(tx, {
        actingUserLinkId: actorOf(req),
        tenantId: tenantOf(req),
        handoffId,
      });
      if (received.outcome === 'not_found') throw new NotFoundError('Resource not found');
      if (received.outcome === 'invalid') {
        throw new UnprocessableError(received.error, { code: 'invalid_request' });
      }
      if (received.outcome === 'already_received') {
        return {
          status: 200,
          body: { opportunity: received.opportunity, outcome: 'already_received' },
        };
      }
      return { status: 201, body: { opportunity: received.opportunity } };
    });
  }),
);

/**
 * SOMEBODY WALKED IN.
 *
 * The customer is resolved through Release Train 2's canonical path in the SAME
 * transaction as the opportunity: an existing record is picked from
 * `/find/customers`, and a genuinely new person is created here — where RT2's
 * own duplicate detection answers, so a walk-in cannot quietly open a second
 * file on a customer the dealership already knows.
 */
router.post(
  '/walk-ins',
  authenticate,
  requireAction('sales.opportunity.receive'),
  handler(async (req, res) => {
    const b = body(req);
    const rooftopId = await namedRooftop(req, b);
    const existingPartyId = optionalUuidField(b, 'party_id');
    const customer = (b.customer ?? null) as Record<string, unknown> | null;
    if (existingPartyId === null && customer === null) {
      throw new ValidationError('pick the customer, or give their details to create one', {
        code: 'customer_required',
      });
    }
    const interestStockItemId = optionalUuidField(b, 'stock_item_id');

    await idempotent(req, res, async (tx) => {
      let partyId = existingPartyId;
      let created = false;
      if (partyId === null && customer !== null) {
        const made = await createPartyWithin(tx, {
          actingUserLinkId: actorOf(req),
          tenantId: tenantOf(req),
          partyType: 'person',
          details: {
            givenName: strOrNull(customer.given_name) ?? undefined,
            familyName: strOrNull(customer.family_name) ?? undefined,
            email: strOrNull(customer.email) ?? undefined,
            phone: strOrNull(customer.phone) ?? undefined,
          },
          allowDuplicate: b.allow_duplicate === true,
        });
        if (made.outcome === 'invalid') {
          throw new UnprocessableError(made.error, { code: 'invalid_request' });
        }
        if (made.outcome === 'duplicate') {
          // NOT AN ERROR TO HIDE. The salesperson is shown who the dealership
          // already has, so they can pick the real person rather than create a
          // second one — which is the whole point of a canonical path.
          return {
            status: 409,
            body: {
              outcome: 'duplicate',
              candidates: made.candidates.map((c) => ({
                partyId: c.party.partyId,
                displayName: c.party.displayName,
                matchedOn: c.matchedOn,
              })),
            },
          };
        }
        partyId = made.party.partyId;
        created = true;
      }

      const opened = await openWalkInWithin(tx, {
        actingUserLinkId: actorOf(req),
        tenantId: tenantOf(req),
        rooftopId,
        partyId: partyId as string,
        interestStockItemId,
      });
      if (opened.outcome === 'not_found') throw new NotFoundError('Resource not found');
      if (opened.outcome === 'invalid') {
        throw new UnprocessableError(opened.error, { code: 'invalid_request' });
      }
      if (opened.outcome === 'already_open') {
        return {
          status: 200,
          body: {
            opportunity: opened.opportunity,
            outcome: 'already_open',
            customerCreated: false,
          },
        };
      }
      return { status: 201, body: { opportunity: opened.opportunity, customerCreated: created } };
    });
  }),
);

router.post(
  '/opportunities/:opportunityId/acceptance',
  authenticate,
  requireAction('sales.opportunity.accept'),
  handler(async (req, res) => {
    const outcome = await acceptOpportunity({
      actingUserLinkId: actorOf(req),
      tenantId: tenantOf(req),
      opportunityId: requireUuidParam(req, 'opportunityId'),
      expectedVersion: expectedVersionOf(req),
    });
    if (outcome.outcome === 'already_owned') {
      res.json({ opportunity: outcome.opportunity, outcome: 'already_owned' });
      return;
    }
    if (outcome.outcome !== 'accepted') refuse(outcome);
    res.json({ opportunity: outcome.opportunity });
  }),
);

router.post(
  '/opportunities/:opportunityId/stage',
  authenticate,
  requireAction('sales.opportunity.progress'),
  handler(async (req, res) => {
    const b = body(req);
    const outcome = await moveOpportunityStage({
      actingUserLinkId: actorOf(req),
      tenantId: tenantOf(req),
      opportunityId: requireUuidParam(req, 'opportunityId'),
      toStage: String(b.to_stage ?? '') as OpportunityStage,
      expectedVersion: expectedVersionOf(req),
      disposition: typeof b.disposition === 'string' ? (b.disposition as never) : null,
      note: strOrNull(b.note),
    });
    if (outcome.outcome === 'already_there') {
      res.json({
        opportunity: outcome.opportunity,
        deskingHandoffId: outcome.deskingHandoffId,
        outcome: 'already_there',
      });
      return;
    }
    if (outcome.outcome !== 'moved') refuse(outcome);
    res.json({ opportunity: outcome.opportunity, deskingHandoffId: outcome.deskingHandoffId });
  }),
);

router.post(
  '/opportunities/:opportunityId/assignment',
  authenticate,
  requireAction('sales.opportunity.assign'),
  handler(async (req, res) => {
    const b = body(req);
    const outcome = await assignOpportunity({
      actingUserLinkId: actorOf(req),
      tenantId: tenantOf(req),
      opportunityId: requireUuidParam(req, 'opportunityId'),
      expectedVersion: expectedVersionOf(req),
      toUserLinkId: requireUuidField(b, 'to_user_link_id'),
      reason: String(b.reason ?? 'manual_assignment') as never,
      note: strOrNull(b.note),
    });
    if (outcome.outcome === 'already_assigned') {
      res.json({ opportunity: outcome.opportunity, outcome: 'already_assigned' });
      return;
    }
    if (outcome.outcome !== 'assigned') refuse(outcome);
    res.json({ opportunity: outcome.opportunity });
  }),
);

// ── the showroom floor ──────────────────────────────────────────────────────

router.get(
  '/visits',
  authenticate,
  requireAction('sales.opportunity.view'),
  handler(async (req, res) => {
    const q = req.query as Record<string, unknown>;
    res.json({
      visits: await listVisits({
        tenantId: tenantOf(req),
        rooftopIds: await rooftopsOf(req),
        includeDeparted: q.include_departed === 'true',
      }),
    });
  }),
);

router.post(
  '/visits',
  authenticate,
  requireAction('sales.visit.record'),
  handler(async (req, res) => {
    const b = body(req);
    const rooftopId = await namedRooftop(req, b);
    const partyId = requireUuidField(b, 'party_id');
    const opportunityId = optionalUuidField(b, 'opportunity_id');
    const appointmentId = optionalUuidField(b, 'appointment_id');
    await idempotent(req, res, async (tx) => {
      const arrived = await checkInWithin(tx, {
        actingUserLinkId: actorOf(req),
        tenantId: tenantOf(req),
        rooftopId,
        partyId,
        opportunityId,
        appointmentId,
      });
      if (arrived.outcome === 'not_found') throw new NotFoundError('Resource not found');
      if (arrived.outcome === 'invalid') {
        throw new UnprocessableError(arrived.error, { code: 'invalid_request' });
      }
      if (arrived.outcome === 'already_here') {
        return {
          status: 200,
          body: {
            visit: arrived.visit,
            appointmentKept: arrived.appointmentKept,
            outcome: 'already_here',
          },
        };
      }
      return {
        status: 201,
        body: { visit: arrived.visit, appointmentKept: arrived.appointmentKept },
      };
    });
  }),
);

router.post(
  '/visits/:visitId/greet',
  authenticate,
  requireAction('sales.visit.manage'),
  handler(async (req, res) => {
    const b = body(req);
    const outcome = await greetVisit({
      actingUserLinkId: actorOf(req),
      tenantId: tenantOf(req),
      visitId: requireUuidParam(req, 'visitId'),
      expectedVersion: expectedVersionOf(req),
      greetedByUserLinkId: optionalUuidField(b, 'greeted_by_user_link_id'),
    });
    if (outcome.outcome !== 'greeted') refuse(outcome);
    res.json({
      visit: outcome.visit,
      greetedBy: outcome.greetedBy,
      fromRotation: outcome.fromRotation,
    });
  }),
);

router.post(
  '/visits/:visitId/acceptance',
  authenticate,
  requireAction('sales.visit.manage'),
  handler(async (req, res) => {
    const outcome = await acceptVisit({
      actingUserLinkId: actorOf(req),
      tenantId: tenantOf(req),
      visitId: requireUuidParam(req, 'visitId'),
      expectedVersion: expectedVersionOf(req),
    });
    if (outcome.outcome === 'already_accepted') {
      res.json({ visit: outcome.visit, outcome: 'already_accepted' });
      return;
    }
    if (outcome.outcome !== 'accepted') refuse(outcome);
    res.json({ visit: outcome.visit });
  }),
);

router.post(
  '/visits/:visitId/depart',
  authenticate,
  requireAction('sales.visit.manage'),
  handler(async (req, res) => {
    const b = body(req);
    const outcome = await departVisit({
      actingUserLinkId: actorOf(req),
      tenantId: tenantOf(req),
      visitId: requireUuidParam(req, 'visitId'),
      expectedVersion: expectedVersionOf(req),
      note: strOrNull(b.note),
    });
    if (outcome.outcome === 'already_departed') {
      res.json({ visit: outcome.visit, outcome: 'already_departed' });
      return;
    }
    if (outcome.outcome !== 'departed') refuse(outcome);
    res.json({ visit: outcome.visit });
  }),
);

router.get(
  '/floor',
  authenticate,
  requireAction('sales.opportunity.view'),
  handler(async (req, res) => {
    // A ROTATION BELONGS TO ONE SHOWROOM. Picking a rooftop for a caller who can
    // reach several would answer a question they did not ask — and the answer
    // would change with the order the bindings happened to come back in.
    const named = (req.query as Record<string, unknown>).location_id;
    if (typeof named !== 'string' || !UUID_RE.test(named)) {
      throw new ValidationError('location_id names which showroom floor to read', {
        code: 'location_required',
      });
    }
    const rooftops = await rooftopsOf(req);
    if (!rooftops.includes(named)) throw new NotFoundError('Resource not found');
    res.json({ floor: await listFloor(tenantOf(req), named), rooftopId: named });
  }),
);

router.post(
  '/floor',
  authenticate,
  requireAction('sales.floor.manage'),
  handler(async (req, res) => {
    const b = body(req);
    const rooftopId = await namedRooftop(req, b);
    const userLinkId = requireUuidField(b, 'user_link_id');
    await idempotent(req, res, async (tx) => {
      const joined = await joinFloorWithin(tx, {
        actingUserLinkId: actorOf(req),
        tenantId: tenantOf(req),
        rooftopId,
        userLinkId,
      });
      if (joined.outcome === 'invalid') {
        throw new UnprocessableError(joined.error, { code: 'invalid_request' });
      }
      if (joined.outcome === 'already_on_the_floor') {
        return { status: 200, body: { entry: joined.entry, outcome: 'already_on_the_floor' } };
      }
      return { status: 201, body: { entry: joined.entry } };
    });
  }),
);

router.post(
  '/floor/release',
  authenticate,
  requireAction('sales.floor.manage'),
  handler(async (req, res) => {
    const b = body(req);
    const outcome = await releaseToFloor({
      actingUserLinkId: actorOf(req),
      tenantId: tenantOf(req),
      rooftopId: requireUuidField(b, 'location_id'),
      userLinkId: requireUuidField(b, 'user_link_id'),
    });
    if (outcome.outcome !== 'released') refuse(outcome);
    res.json({ entry: outcome.entry });
  }),
);

// ── selection and demonstration ─────────────────────────────────────────────

router.post(
  '/opportunities/:opportunityId/vehicles',
  authenticate,
  requireAction('sales.vehicle.shortlist'),
  handler(async (req, res) => {
    const b = body(req);
    const opportunityId = requireUuidParam(req, 'opportunityId');
    const stockItemId = requireUuidField(b, 'stock_item_id');
    await idempotent(req, res, async (tx) => {
      const added = await shortlistVehicleWithin(tx, {
        actingUserLinkId: actorOf(req),
        tenantId: tenantOf(req),
        opportunityId,
        stockItemId,
        rank: b.rank === undefined ? undefined : Number(b.rank),
      });
      if (added.outcome === 'not_found') throw new NotFoundError('Resource not found');
      if (added.outcome === 'invalid') {
        throw new UnprocessableError(added.error, { code: 'invalid_request' });
      }
      if (added.outcome === 'already_shortlisted') {
        return { status: 200, body: { vehicle: added.vehicle, outcome: 'already_shortlisted' } };
      }
      return { status: 201, body: { vehicle: added.vehicle } };
    });
  }),
);

router.post(
  '/opportunities/:opportunityId/vehicles/:opportunityVehicleId/status',
  authenticate,
  requireAction('sales.vehicle.shortlist'),
  handler(async (req, res) => {
    const b = body(req);
    const outcome = await setVehicleStatus({
      actingUserLinkId: actorOf(req),
      tenantId: tenantOf(req),
      opportunityId: requireUuidParam(req, 'opportunityId'),
      opportunityVehicleId: requireUuidParam(req, 'opportunityVehicleId'),
      expectedVersion: expectedVersionOf(req),
      status: String(b.status ?? '') as never,
      rejectedReason: strOrNull(b.rejected_reason),
    });
    if (outcome.outcome === 'already_there') {
      res.json({ vehicle: outcome.vehicle, outcome: 'already_there' });
      return;
    }
    if (outcome.outcome !== 'updated') refuse(outcome);
    res.json({ vehicle: outcome.vehicle });
  }),
);

router.post(
  '/opportunities/:opportunityId/demonstrations',
  authenticate,
  requireAction('sales.demonstration.start'),
  handler(async (req, res) => {
    const b = body(req);
    const opportunityId = requireUuidParam(req, 'opportunityId');
    const stockItemId = requireUuidField(b, 'stock_item_id');
    const driverPartyId = requireUuidField(b, 'driver_party_id');
    const accompaniedBy = optionalUuidField(b, 'accompanied_by_user_link_id');
    const visitId = optionalUuidField(b, 'visit_id');
    await idempotent(req, res, async (tx) => {
      const issued = await issueDemonstrationWithin(tx, {
        actingUserLinkId: actorOf(req),
        tenantId: tenantOf(req),
        opportunityId,
        stockItemId,
        driverPartyId,
        licenceVerified: b.licence_verified === true,
        accompaniedByUserLinkId: accompaniedBy,
        visitId,
      });
      if (issued.outcome === 'not_found') throw new NotFoundError('Resource not found');
      if (issued.outcome === 'invalid') {
        throw new UnprocessableError(issued.error, { code: 'invalid_request' });
      }
      if (issued.outcome === 'unavailable') refuse(issued);
      return { status: 201, body: { demonstration: issued.demonstration } };
    });
  }),
);

/**
 * THE FOUR THINGS THAT CAN HAPPEN TO AN ISSUED CAR, on one route.
 *
 * `to_state` names which — started, returned, cancelled or exception — because
 * they are one decision a person makes at one moment about one vehicle, and
 * four endpoints would invite a screen to offer three of them.
 */
router.post(
  '/opportunities/:opportunityId/demonstrations/:demonstrationId/state',
  authenticate,
  requireAction('sales.demonstration.manage'),
  handler(async (req, res) => {
    const b = body(req);
    const common = {
      actingUserLinkId: actorOf(req),
      tenantId: tenantOf(req),
      opportunityId: requireUuidParam(req, 'opportunityId'),
      demonstrationId: requireUuidParam(req, 'demonstrationId'),
      expectedVersion: expectedVersionOf(req),
    };
    const to = String(b.to_state ?? '');
    const outcome =
      to === 'in_progress'
        ? await startDemonstration(common)
        : to === 'returned'
          ? await returnDemonstration({
              ...common,
              verdict: String(b.outcome ?? '') as never,
              notes: strOrNull(b.notes),
            })
          : to === 'cancelled'
            ? await cancelDemonstration({ ...common, reason: String(b.reason ?? '') })
            : to === 'exception'
              ? await recordDemonstrationException({
                  ...common,
                  exceptionKind: String(b.exception_kind ?? '') as never,
                  notes: String(b.notes ?? ''),
                })
              : null;
    if (outcome === null) {
      throw new UnprocessableError(
        'a drive moves to in_progress, returned, cancelled or exception',
        { code: 'invalid_request' },
      );
    }
    if (outcome.outcome === 'already_there') {
      res.json({ demonstration: outcome.demonstration, outcome: 'already_there' });
      return;
    }
    if (outcome.outcome !== 'moved') refuse(outcome);
    res.json({ demonstration: outcome.demonstration });
  }),
);

// ── follow-up, negotiation and oversight ────────────────────────────────────

router.post(
  '/opportunities/:opportunityId/activities',
  authenticate,
  requireAction('sales.activity.log'),
  handler(async (req, res) => {
    const b = body(req);
    const opportunityId = requireUuidParam(req, 'opportunityId');
    await idempotent(req, res, async (tx) => {
      const logged = await logSalesActivityWithin(tx, {
        actingUserLinkId: actorOf(req),
        tenantId: tenantOf(req),
        opportunityId,
        kind: String(b.kind ?? 'note') as never,
        direction: typeof b.direction === 'string' ? (b.direction as never) : null,
        subject: String(b.subject ?? ''),
        body: strOrNull(b.body),
        dueAt: strOrNull(b.due_at),
      });
      if (logged.outcome === 'not_found') throw new NotFoundError('Resource not found');
      if (logged.outcome === 'invalid') {
        throw new UnprocessableError(logged.error, { code: 'invalid_request' });
      }
      return { status: 201, body: { activity: logged.activity } };
    });
  }),
);

router.post(
  '/opportunities/:opportunityId/activities/:activityId/close',
  authenticate,
  requireAction('sales.activity.close'),
  handler(async (req, res) => {
    const b = body(req);
    const outcome = await closeSalesActivity({
      actingUserLinkId: actorOf(req),
      tenantId: tenantOf(req),
      opportunityId: requireUuidParam(req, 'opportunityId'),
      activityId: requireUuidParam(req, 'activityId'),
      expectedVersion: expectedVersionOf(req),
      state: String(b.state ?? 'completed') as 'completed' | 'cancelled',
      reason: strOrNull(b.reason),
      outcomeNote: strOrNull(b.outcome_note),
    });
    if (outcome.outcome === 'already_closed') {
      res.json({ activity: outcome.activity, outcome: 'already_closed' });
      return;
    }
    if (outcome.outcome !== 'closed') refuse(outcome);
    res.json({ activity: outcome.activity });
  }),
);

router.post(
  '/opportunities/:opportunityId/negotiation',
  authenticate,
  requireAction('sales.negotiation.record'),
  handler(async (req, res) => {
    const b = body(req);
    const outcome = await recordNegotiationRound({
      actingUserLinkId: actorOf(req),
      tenantId: tenantOf(req),
      opportunityId: requireUuidParam(req, 'opportunityId'),
      initiatedBy: String(b.initiated_by ?? 'customer') as 'customer' | 'dealership',
      summary: String(b.summary ?? ''),
      managerInvolved: b.manager_involved === true,
      outcome: String(b.outcome ?? 'countered') as never,
    });
    if (outcome.outcome !== 'recorded') refuse(outcome);
    res.status(201).json({ round: outcome.round });
  }),
);

router.post(
  '/opportunities/:opportunityId/turnover',
  authenticate,
  requireAction('sales.turnover.record'),
  handler(async (req, res) => {
    const b = body(req);
    const outcome = await recordTurnover({
      actingUserLinkId: actorOf(req),
      tenantId: tenantOf(req),
      opportunityId: requireUuidParam(req, 'opportunityId'),
      managerUserLinkId: requireUuidField(b, 'manager_user_link_id'),
      reason: String(b.reason ?? 'second_voice') as never,
      visitId: optionalUuidField(b, 'visit_id'),
      note: strOrNull(b.note),
    });
    if (outcome.outcome !== 'recorded') refuse(outcome);
    res.status(201).json({ turnoverId: outcome.turnoverId });
  }),
);

// ── problem rendering ───────────────────────────────────────────────────────

router.use((req: Request, res: Response) => {
  const instance = req.originalUrl.split('?')[0] ?? req.path;
  const context = getRequestContext();
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
