/**
 * RELEASE TRAIN 4 — THE SALES SURFACE (/api/sales).
 *
 * The showroom's API. It follows the conventions the earlier trains
 * established, because they are the ones this repository's gates and reviewers
 * expect: `authenticate` + `requireAction`, problem+json errors,
 * `Idempotency-Key` on creating commands with the outcome recorded in the same
 * transaction as the effect, and `expected_version` optimistic concurrency.
 *
 * EVERY CHILD IS ADDRESSED THROUGH ITS AUTHORIZED PARENT. A route whose action
 * declares `resourceType: 'opportunity'` carries `:opportunityId`, and the
 * service is handed that id so a row belonging to a different opportunity is
 * NOT FOUND rather than acted on. RT3-C1 was returned for exactly this, and it
 * is built in here rather than retrofitted.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import {
  assignOpportunity,
  departVisit,
  endDemonstration,
  getOpportunity,
  greetVisit,
  joinFloorWithin,
  listFloor,
  listOpportunities,
  listShortlist,
  listVisits,
  logSalesActivityWithin,
  moveOpportunityStage,
  openDemonstrations,
  opportunityHeader,
  opportunityTimeline,
  receiveHandoffWithin,
  recordArrivalWithin,
  recordNegotiationRound,
  recordTurnover,
  releaseToFloor,
  salesBoard,
  setVehicleStatus,
  shortlistVehicleWithin,
  startDemonstrationWithin,
  type OpportunityStage,
} from '@dealer/sales';
import {
  permittedRooftopIds,
  requestFingerprint,
  runIdempotentAdminCommand,
} from '@dealer/identity-access';
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
      throw new UnprocessableError('nobody is available on the floor', {
        code: 'floor_empty',
      });
    case 'vehicle_out':
      throw new ConflictError('that vehicle is already out on a test drive', {
        code: 'vehicle_out',
        details: { demonstration_id: outcome.demonstrationId as string },
      });
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
    // The header carries the names, and it is ALSO the visibility check: a
    // rooftop this actor cannot reach returns nothing, so an opportunity read
    // through a tenant-wide row lookup still answers 404 at the rooftop.
    const header = await opportunityHeader(tenantId, opportunityId, rooftops);
    if (header === null) throw new NotFoundError('Resource not found');
    res.json({
      opportunity: { ...opportunity, ...header },
      shortlist: await listShortlist(tenantId, opportunityId, rooftops),
      outOnDrive: await openDemonstrations(tenantId, opportunityId, rooftops),
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
    await idempotent(req, res, async (tx) => {
      const received = await receiveHandoffWithin(tx, {
        actingUserLinkId: actorOf(req),
        tenantId: tenantOf(req),
        handoffId: String(b.handoff_id ?? ''),
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
    if (outcome.outcome !== 'moved') refuse(outcome);
    res.json({ opportunity: outcome.opportunity });
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
      toUserLinkId: String(b.to_user_link_id ?? ''),
      reason: String(b.reason ?? 'manual_assignment') as never,
      note: strOrNull(b.note),
    });
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
    await idempotent(req, res, async (tx) => {
      const arrived = await recordArrivalWithin(tx, {
        actingUserLinkId: actorOf(req),
        tenantId: tenantOf(req),
        rooftopId: String(b.location_id ?? ''),
        partyId: String(b.party_id ?? ''),
        opportunityId: strOrNull(b.opportunity_id),
        appointmentId: strOrNull(b.appointment_id),
      });
      if (arrived.outcome === 'not_found') throw new NotFoundError('Resource not found');
      if (arrived.outcome === 'invalid') {
        throw new UnprocessableError(arrived.error, { code: 'invalid_request' });
      }
      return { status: 201, body: { visit: arrived.visit } };
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
      greetedByUserLinkId: strOrNull(b.greeted_by_user_link_id),
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
    if (outcome.outcome !== 'departed') refuse(outcome);
    res.json({ visit: outcome.visit });
  }),
);

router.get(
  '/floor',
  authenticate,
  requireAction('sales.opportunity.view'),
  handler(async (req, res) => {
    // A ROTATION BELONGS TO ONE SHOWROOM. Picking a rooftop for the caller when
    // they can reach several would answer a question they did not ask — and the
    // answer would change with the order the bindings happened to come back in.
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
    await idempotent(req, res, async (tx) => {
      const joined = await joinFloorWithin(tx, {
        actingUserLinkId: actorOf(req),
        tenantId: tenantOf(req),
        rooftopId: String(b.location_id ?? ''),
        userLinkId: String(b.user_link_id ?? ''),
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
      rooftopId: String(b.location_id ?? ''),
      userLinkId: String(b.user_link_id ?? ''),
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
    await idempotent(req, res, async (tx) => {
      const added = await shortlistVehicleWithin(tx, {
        actingUserLinkId: actorOf(req),
        tenantId: tenantOf(req),
        opportunityId,
        stockItemId: String(b.stock_item_id ?? ''),
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
    await idempotent(req, res, async (tx) => {
      const started = await startDemonstrationWithin(tx, {
        actingUserLinkId: actorOf(req),
        tenantId: tenantOf(req),
        opportunityId,
        stockItemId: String(b.stock_item_id ?? ''),
        driverPartyId: String(b.driver_party_id ?? ''),
        licenceVerified: b.licence_verified === true,
        visitId: strOrNull(b.visit_id),
      });
      if (started.outcome === 'not_found') throw new NotFoundError('Resource not found');
      if (started.outcome === 'invalid') {
        throw new UnprocessableError(started.error, { code: 'invalid_request' });
      }
      if (started.outcome === 'vehicle_out') {
        throw new ConflictError('that vehicle is already out on a test drive', {
          code: 'vehicle_out',
          details: { demonstration_id: started.demonstrationId },
        });
      }
      return { status: 201, body: { demonstration: started.demonstration } };
    });
  }),
);

router.post(
  '/opportunities/:opportunityId/demonstrations/:demonstrationId/end',
  authenticate,
  requireAction('sales.demonstration.manage'),
  handler(async (req, res) => {
    const b = body(req);
    const outcome = await endDemonstration({
      actingUserLinkId: actorOf(req),
      tenantId: tenantOf(req),
      opportunityId: requireUuidParam(req, 'opportunityId'),
      demonstrationId: requireUuidParam(req, 'demonstrationId'),
      expectedVersion: expectedVersionOf(req),
      state: String(b.state ?? 'completed') as 'completed' | 'abandoned',
      outcome: typeof b.outcome === 'string' ? (b.outcome as never) : null,
      notes: strOrNull(b.notes),
    });
    if (outcome.outcome !== 'ended') refuse(outcome);
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
      managerUserLinkId: String(b.manager_user_link_id ?? ''),
      reason: String(b.reason ?? 'second_voice') as never,
      visitId: strOrNull(b.visit_id),
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
