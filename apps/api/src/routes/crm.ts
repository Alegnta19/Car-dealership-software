/**
 * RELEASE TRAIN 3 — THE CRM AND MARKETING SURFACE (/api/crm).
 *
 * The BDC and marketing UI's API. It follows the conventions Release Trains 1
 * and 2 established on `/api/admin` and `/api/inventory` exactly, because they
 * are the ones this repository's gates and reviewers expect:
 *
 *   * `authenticate` + `requireAction(<catalog action>)` on every route, so
 *     every decision goes through the one policy path and leaves its evidence;
 *   * `application/problem+json` (RFC 9457) errors with a stable `code` and both
 *     correlation identifiers, rendered by this router's OWN error middleware —
 *     the legacy envelope on the pre-train surfaces is untouched;
 *   * `Idempotency-Key` on creating commands, with the outcome recorded in the
 *     SAME transaction as the effect;
 *   * `expected_version` optimistic concurrency on updates, answered 409.
 *
 * ROOFTOP AUTHORIZATION IS STRUCTURAL, NOT CHECKED HERE. Routes that act on a
 * lead name `:leadId`, and the catalog declares `lead` as the resource type, so
 * the policy engine resolves the lead to the rooftop that owns it and refuses a
 * binding that does not reach it — reporting the row as NOT FOUND rather than
 * forbidden, so existence is never leaked. Nothing in this file re-implements
 * that decision.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import {
  ATTRIBUTION_MODELS,
  CONSENT_PURPOSES,
  approveCampaignVersion,
  assignLead,
  attributionReport,
  buildAudience,
  campaignBoard,
  campaignSendSummary,
  captureLeadWithin,
  closeActivity,
  computeAttribution,
  createCampaignWithin,
  createQueueWithin,
  crmOverview,
  defineLeadSourceWithin,
  draftCampaignVersionWithin,
  executeCampaignVersion,
  getLead,
  handOffLead,
  leadTimeline,
  listLeads,
  listPurposeConsents,
  listQueues,
  listLeadSources,
  listSuppressions,
  logActivityWithin,
  recordCampaignResponse,
  reconcileSend,
  rescheduleAppointment,
  retireLeadSource,
  scheduleAppointmentWithin,
  setAppointmentState,
  setPurposeConsent,
  setSlaPolicy,
  suppressContactWithin,
  transitionLead,
  versionSends,
  type AttributionModel,
  type ConsentPurpose,
} from '@dealer/crm';
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
    throw new ForbiddenError('The CRM surface is tenant-scoped', { code: 'tenant_required' });
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
    case 'duplicate':
      throw new ConflictError('that already exists', { code: 'duplicate' });
    default:
      throw new UnprocessableError('the command was refused', { code: 'refused' });
  }
}

/**
 * The rooftops this actor may see — the SQL-level filter for every read on this
 * surface.
 *
 * It is read from the actor's EFFECTIVE role bindings rather than from anything
 * on the request, so a dashboard cannot outlive the authority behind it: a
 * binding revoked a minute ago stops widening this list immediately, because
 * `permittedRooftopIds` reads through the same shared effectiveness predicate
 * the policy engine decides from.
 */
async function rooftopsOf(req: Request): Promise<string[]> {
  const permitted = await permittedRooftopIds(tenantOf(req), actorOf(req));
  // A NAMED ROOFTOP NARROWS, IT NEVER WIDENS. `location_id` is also what the
  // middleware turns into the engine's scope hint, which is how a
  // rooftop-bound employee reaches a tenant-scoped read at all — so honouring
  // it here keeps the rows returned identical to the rows authorized. It is
  // intersected with the permitted set rather than trusted, because a caller
  // naming a rooftop they do not hold must get nothing rather than an error
  // that confirms the rooftop exists.
  const fromQuery = (req.query as Record<string, unknown>).location_id;
  const fromBody = body(req).location_id;
  const named = typeof fromQuery === 'string' ? fromQuery : fromBody;
  if (typeof named === 'string' && UUID_RE.test(named)) {
    return permitted.filter((id) => id === named);
  }
  return permitted;
}

// ── overview and reads ──────────────────────────────────────────────────────

router.get(
  '/overview',
  authenticate,
  requireAction('crm.lead.view'),
  handler(async (req, res) => {
    res.json(await crmOverview(tenantOf(req), await rooftopsOf(req)));
  }),
);

router.get(
  '/leads',
  authenticate,
  requireAction('crm.lead.view'),
  handler(async (req, res) => {
    const q = req.query as Record<string, unknown>;
    res.json({
      leads: await listLeads({
        tenantId: tenantOf(req),
        rooftopIds: await rooftopsOf(req),
        state: typeof q.state === 'string' ? q.state : null,
        ownerUserLinkId: typeof q.owner === 'string' && UUID_RE.test(q.owner) ? q.owner : null,
        limit: typeof q.limit === 'string' ? Number(q.limit) : undefined,
      }),
    });
  }),
);

router.get(
  '/leads/:leadId',
  authenticate,
  requireAction('crm.lead.read'),
  handler(async (req, res) => {
    const leadId = requireUuidParam(req, 'leadId');
    const tenantId = tenantOf(req);
    const lead = await getLead(tenantId, leadId);
    if (lead === null) throw new NotFoundError('Resource not found');
    res.json({ lead, timeline: await leadTimeline(tenantId, leadId, await rooftopsOf(req)) });
  }),
);

// ── row 1: sources and intake ───────────────────────────────────────────────

router.get(
  '/sources',
  authenticate,
  requireAction('crm.source.view'),
  handler(async (req, res) => {
    res.json({ sources: await listLeadSources(tenantOf(req)) });
  }),
);

router.post(
  '/sources',
  authenticate,
  requireAction('crm.source.manage'),
  handler(async (req, res) => {
    const b = body(req);
    await idempotent(req, res, async (tx) => {
      const created = await defineLeadSourceWithin(tx, {
        actingUserLinkId: actorOf(req),
        tenantId: tenantOf(req),
        sourceCode: String(b.source_code ?? ''),
        displayName: String(b.display_name ?? ''),
        channel: String(b.channel ?? 'web') as never,
        medium: String(b.medium ?? 'unknown') as never,
      });
      if (created.outcome === 'invalid') {
        throw new UnprocessableError(created.error, { code: 'invalid_request' });
      }
      if (created.outcome === 'duplicate') {
        return { status: 200, body: { source: created.source, outcome: 'duplicate' } };
      }
      return { status: 201, body: { source: created.source } };
    });
  }),
);

router.delete(
  '/sources/:sourceId',
  authenticate,
  requireAction('crm.source.manage'),
  handler(async (req, res) => {
    const outcome = await retireLeadSource({
      actingUserLinkId: actorOf(req),
      tenantId: tenantOf(req),
      leadSourceId: requireUuidParam(req, 'sourceId'),
      expectedVersion: expectedVersionOf(req),
    });
    if (outcome.outcome !== 'retired') refuse(outcome);
    res.json({ source: outcome.source });
  }),
);

router.post(
  '/leads',
  authenticate,
  requireAction('crm.lead.capture'),
  handler(async (req, res) => {
    const b = body(req);
    await idempotent(req, res, async (tx) => {
      const captured = await captureLeadWithin(tx, {
        actingUserLinkId: actorOf(req),
        tenantId: tenantOf(req),
        rooftopId: String(b.location_id ?? ''),
        intakeKey: String(b.intake_key ?? ''),
        channel: String(b.channel ?? 'manual') as never,
        sourceCode: String(b.source_code ?? ''),
        partyId: typeof b.party_id === 'string' ? b.party_id : null,
        party:
          typeof b.customer === 'object' && b.customer !== null
            ? {
                givenName: strOrUndefined((b.customer as Body).given_name),
                familyName: strOrUndefined((b.customer as Body).family_name),
                email: strOrUndefined((b.customer as Body).email),
                phone: strOrUndefined((b.customer as Body).phone),
              }
            : undefined,
        interestStockItemId: typeof b.stock_item_id === 'string' ? b.stock_item_id : null,
        interestVehicleId: typeof b.vehicle_id === 'string' ? b.vehicle_id : null,
      });
      if (captured.outcome === 'invalid') {
        throw new UnprocessableError(captured.error, { code: 'invalid_request' });
      }
      if (captured.outcome === 'merged_into_existing') {
        return {
          status: 200,
          body: {
            lead: captured.lead,
            outcome: 'merged_into_existing',
            replayed: captured.replayed,
          },
        };
      }
      return { status: 201, body: { lead: captured.lead } };
    });
  }),
);

function strOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

// ── row 2: routing and lifecycle ────────────────────────────────────────────

router.get(
  '/queues',
  authenticate,
  requireAction('crm.lead.view'),
  handler(async (req, res) => {
    res.json({ queues: await listQueues(tenantOf(req), await rooftopsOf(req)) });
  }),
);

router.post(
  '/queues',
  authenticate,
  requireAction('crm.queue.manage'),
  handler(async (req, res) => {
    const b = body(req);
    await idempotent(req, res, async (tx) => {
      const created = await createQueueWithin(tx, {
        actingUserLinkId: actorOf(req),
        tenantId: tenantOf(req),
        rooftopId: String(b.location_id ?? ''),
        name: String(b.name ?? ''),
      });
      if (created.outcome === 'invalid') {
        throw new UnprocessableError(created.error, { code: 'invalid_request' });
      }
      if (created.outcome === 'duplicate') {
        return { status: 200, body: { queue: created.queue, outcome: 'duplicate' } };
      }
      return { status: 201, body: { queue: created.queue } };
    });
  }),
);

router.put(
  '/sla',
  authenticate,
  requireAction('crm.sla.manage'),
  handler(async (req, res) => {
    const b = body(req);
    const outcome = await setSlaPolicy({
      actingUserLinkId: actorOf(req),
      tenantId: tenantOf(req),
      rooftopId: String(b.location_id ?? ''),
      firstResponseMinutes: Number(b.first_response_minutes),
      escalateAfterMinutes: Number(b.escalate_after_minutes),
    });
    if (outcome.outcome !== 'saved') refuse(outcome);
    res.json({ policy: outcome.policy });
  }),
);

router.post(
  '/leads/:leadId/assignment',
  authenticate,
  requireAction('crm.lead.assign'),
  handler(async (req, res) => {
    const b = body(req);
    const outcome = await assignLead({
      actingUserLinkId: actorOf(req),
      tenantId: tenantOf(req),
      leadId: requireUuidParam(req, 'leadId'),
      expectedVersion: expectedVersionOf(req),
      toUserLinkId: typeof b.to_user_link_id === 'string' ? b.to_user_link_id : null,
      queueId: typeof b.queue_id === 'string' ? b.queue_id : null,
      reason: String(b.reason ?? 'manual_assignment') as never,
      note: strOrUndefined(b.note) ?? null,
    });
    if (outcome.outcome !== 'assigned') refuse(outcome);
    res.json({ lead: outcome.lead });
  }),
);

router.post(
  '/leads/:leadId/transition',
  authenticate,
  requireAction('crm.lead.transition'),
  handler(async (req, res) => {
    const b = body(req);
    const outcome = await transitionLead({
      actingUserLinkId: actorOf(req),
      tenantId: tenantOf(req),
      leadId: requireUuidParam(req, 'leadId'),
      toState: String(b.to_state ?? '') as never,
      expectedVersion: expectedVersionOf(req),
      disposition: typeof b.disposition === 'string' ? (b.disposition as never) : null,
      note: strOrUndefined(b.note) ?? null,
    });
    if (outcome.outcome !== 'moved') refuse(outcome);
    res.json({ lead: outcome.lead });
  }),
);

router.post(
  '/leads/:leadId/handoff',
  authenticate,
  requireAction('crm.lead.hand_off'),
  handler(async (req, res) => {
    const b = body(req);
    const outcome = await handOffLead({
      actingUserLinkId: actorOf(req),
      tenantId: tenantOf(req),
      leadId: requireUuidParam(req, 'leadId'),
      expectedVersion: expectedVersionOf(req),
      handedToUserLinkId: String(b.handed_to_user_link_id ?? ''),
    });
    if (outcome.outcome === 'already_handed_off') {
      res.status(200).json({ outcome: 'already_handed_off', handoffId: outcome.handoffId });
      return;
    }
    if (outcome.outcome !== 'handed_off') refuse(outcome);
    res.status(201).json({ lead: outcome.lead, handoffId: outcome.handoffId });
  }),
);

// ── row 3: activity and appointments ────────────────────────────────────────

router.post(
  '/leads/:leadId/activities',
  authenticate,
  requireAction('crm.activity.log'),
  handler(async (req, res) => {
    const b = body(req);
    const leadId = requireUuidParam(req, 'leadId');
    await idempotent(req, res, async (tx) => {
      const logged = await logActivityWithin(tx, {
        actingUserLinkId: actorOf(req),
        tenantId: tenantOf(req),
        leadId,
        kind: String(b.kind ?? 'note') as never,
        direction: typeof b.direction === 'string' ? (b.direction as never) : null,
        subject: String(b.subject ?? ''),
        body: strOrUndefined(b.body) ?? null,
        dueAt: strOrUndefined(b.due_at) ?? null,
        assignedToUserLinkId: typeof b.assigned_to === 'string' ? b.assigned_to : null,
      });
      if (logged.outcome === 'not_found') throw new NotFoundError('Resource not found');
      if (logged.outcome === 'invalid') {
        throw new UnprocessableError(logged.error, { code: 'invalid_request' });
      }
      return { status: 201, body: { activity: logged.activity, lead: logged.lead } };
    });
  }),
);

// UNDER ITS LEAD, BECAUSE THAT IS WHAT AUTHORIZES IT (RT3-C1 §2).
//
// This used to be `/activities/:activityId/close`. The action declares
// `resourceType: 'lead'`, and the middleware resolves a resource by looking for
// the route parameter that type names — `leadId`. There was none, so no
// resource was resolved, the decision fell back to the tenant-scoped path, and
// any authorized agent could close an activity at a rooftop they cannot reach.
// A child is addressed through its parent or it is not addressed at all.
router.post(
  '/leads/:leadId/activities/:activityId/close',
  authenticate,
  requireAction('crm.activity.log'),
  handler(async (req, res) => {
    const b = body(req);
    const outcome = await closeActivity({
      actingUserLinkId: actorOf(req),
      tenantId: tenantOf(req),
      leadId: requireUuidParam(req, 'leadId'),
      activityId: requireUuidParam(req, 'activityId'),
      expectedVersion: expectedVersionOf(req),
      state: String(b.state ?? 'completed') as 'completed' | 'cancelled',
    });
    if (outcome.outcome !== 'closed') refuse(outcome);
    res.json({ activity: outcome.activity });
  }),
);

router.post(
  '/leads/:leadId/appointments',
  authenticate,
  requireAction('crm.appointment.schedule'),
  handler(async (req, res) => {
    const b = body(req);
    const leadId = requireUuidParam(req, 'leadId');
    await idempotent(req, res, async (tx) => {
      const scheduled = await scheduleAppointmentWithin(tx, {
        actingUserLinkId: actorOf(req),
        tenantId: tenantOf(req),
        leadId,
        purpose: String(b.purpose ?? 'consultation') as never,
        startsAt: String(b.starts_at ?? ''),
        endsAt: String(b.ends_at ?? ''),
        stockItemId: typeof b.stock_item_id === 'string' ? b.stock_item_id : null,
        assignedToUserLinkId: typeof b.assigned_to === 'string' ? b.assigned_to : null,
      });
      if (scheduled.outcome === 'not_found') throw new NotFoundError('Resource not found');
      if (scheduled.outcome === 'invalid') {
        throw new UnprocessableError(scheduled.error, { code: 'invalid_request' });
      }
      return {
        status: 201,
        body: { appointment: scheduled.appointment, lead: scheduled.lead },
      };
    });
  }),
);

router.post(
  '/appointments/:appointmentId/reschedule',
  authenticate,
  requireAction('crm.appointment.manage'),
  handler(async (req, res) => {
    const b = body(req);
    const outcome = await rescheduleAppointment({
      actingUserLinkId: actorOf(req),
      tenantId: tenantOf(req),
      appointmentId: requireUuidParam(req, 'appointmentId'),
      expectedVersion: expectedVersionOf(req),
      startsAt: String(b.starts_at ?? ''),
      endsAt: String(b.ends_at ?? ''),
      note: strOrUndefined(b.note) ?? null,
    });
    if (outcome.outcome !== 'moved') refuse(outcome);
    res.json({ appointment: outcome.appointment });
  }),
);

router.post(
  '/appointments/:appointmentId/state',
  authenticate,
  requireAction('crm.appointment.manage'),
  handler(async (req, res) => {
    const b = body(req);
    const outcome = await setAppointmentState({
      actingUserLinkId: actorOf(req),
      tenantId: tenantOf(req),
      appointmentId: requireUuidParam(req, 'appointmentId'),
      expectedVersion: expectedVersionOf(req),
      state: String(b.state ?? '') as never,
      reason: strOrUndefined(b.reason) ?? null,
    });
    if (outcome.outcome !== 'moved') refuse(outcome);
    res.json({ appointment: outcome.appointment });
  }),
);

// ── row 4: consent, suppression and campaigns ───────────────────────────────

router.get(
  '/parties/:partyId/consents',
  authenticate,
  requireAction('crm.consent.view'),
  handler(async (req, res) => {
    res.json({
      consents: await listPurposeConsents(tenantOf(req), requireUuidParam(req, 'partyId')),
      purposes: CONSENT_PURPOSES,
    });
  }),
);

router.put(
  '/parties/:partyId/consents',
  authenticate,
  requireAction('crm.consent.record'),
  handler(async (req, res) => {
    const b = body(req);
    const outcome = await setPurposeConsent({
      actingUserLinkId: actorOf(req),
      tenantId: tenantOf(req),
      partyId: requireUuidParam(req, 'partyId'),
      channel: String(b.channel ?? '') as never,
      purpose: String(b.purpose ?? '') as ConsentPurpose,
      state: String(b.state ?? '') as never,
      source: String(b.source ?? 'staff'),
    });
    if (outcome.outcome !== 'saved') refuse(outcome);
    res.json({ consents: outcome.consents });
  }),
);

router.get(
  '/suppressions',
  authenticate,
  requireAction('crm.consent.view'),
  handler(async (req, res) => {
    res.json({ suppressions: await listSuppressions(tenantOf(req)) });
  }),
);

router.post(
  '/suppressions',
  authenticate,
  requireAction('crm.consent.record'),
  handler(async (req, res) => {
    const b = body(req);
    await idempotent(req, res, async (tx) => {
      const outcome = await suppressContactWithin(tx, {
        actingUserLinkId: actorOf(req),
        tenantId: tenantOf(req),
        contactKind: String(b.contact_kind ?? 'email') as 'email' | 'phone',
        contactValue: String(b.contact_value ?? ''),
        reason: String(b.reason ?? 'do_not_contact') as never,
        partyId: typeof b.party_id === 'string' ? b.party_id : null,
      });
      if (outcome.outcome === 'invalid') {
        throw new UnprocessableError(outcome.error, { code: 'invalid_request' });
      }
      if (outcome.outcome === 'already_suppressed') {
        return {
          status: 200,
          body: { suppression: outcome.suppression, outcome: 'already_suppressed' },
        };
      }
      return { status: 201, body: { suppression: outcome.suppression } };
    });
  }),
);

router.get(
  '/campaigns',
  authenticate,
  requireAction('marketing.campaign.view'),
  handler(async (req, res) => {
    res.json({ campaigns: await campaignBoard(tenantOf(req), await rooftopsOf(req)) });
  }),
);

router.get(
  '/campaigns/:campaignId/versions/:versionId/sends',
  authenticate,
  requireAction('marketing.campaign.view'),
  handler(async (req, res) => {
    res.json({
      sends: await versionSends(
        tenantOf(req),
        requireUuidParam(req, 'campaignId'),
        requireUuidParam(req, 'versionId'),
        await rooftopsOf(req),
      ),
    });
  }),
);

router.post(
  '/campaigns',
  authenticate,
  requireAction('marketing.campaign.create'),
  handler(async (req, res) => {
    const b = body(req);
    await idempotent(req, res, async (tx) => {
      const created = await createCampaignWithin(tx, {
        actingUserLinkId: actorOf(req),
        tenantId: tenantOf(req),
        rooftopId: String(b.location_id ?? ''),
        name: String(b.name ?? ''),
        channel: String(b.channel ?? 'email') as 'email' | 'sms',
        purpose: String(b.purpose ?? 'sales_marketing') as never,
        sourceCode: String(b.source_code ?? ''),
        quietHoursStartMinute:
          b.quiet_hours_start_minute === undefined ? undefined : Number(b.quiet_hours_start_minute),
        quietHoursEndMinute:
          b.quiet_hours_end_minute === undefined ? undefined : Number(b.quiet_hours_end_minute),
        timeZone: strOrUndefined(b.time_zone),
      });
      if (created.outcome === 'invalid') {
        throw new UnprocessableError(created.error, { code: 'invalid_request' });
      }
      if (created.outcome === 'duplicate') {
        return { status: 200, body: { campaign: created.campaign, outcome: 'duplicate' } };
      }
      return { status: 201, body: { campaign: created.campaign } };
    });
  }),
);

router.post(
  '/campaigns/:campaignId/versions',
  authenticate,
  requireAction('marketing.campaign.draft'),
  handler(async (req, res) => {
    const b = body(req);
    const campaignId = requireUuidParam(req, 'campaignId');
    await idempotent(req, res, async (tx) => {
      const drafted = await draftCampaignVersionWithin(tx, {
        actingUserLinkId: actorOf(req),
        tenantId: tenantOf(req),
        campaignId,
        subject: strOrUndefined(b.subject) ?? null,
        body: String(b.body ?? ''),
        includesOptOut: b.includes_opt_out === undefined ? undefined : b.includes_opt_out === true,
      });
      if (drafted.outcome === 'not_found') throw new NotFoundError('Resource not found');
      if (drafted.outcome === 'invalid') {
        throw new UnprocessableError(drafted.error, { code: 'invalid_request' });
      }
      return { status: 201, body: { version: drafted.version } };
    });
  }),
);

router.post(
  '/campaigns/:campaignId/versions/:versionId/audience',
  authenticate,
  requireAction('marketing.campaign.draft'),
  handler(async (req, res) => {
    const b = body(req);
    const outcome = await buildAudience({
      actingUserLinkId: actorOf(req),
      tenantId: tenantOf(req),
      campaignId: requireUuidParam(req, 'campaignId'),
      campaignVersionId: requireUuidParam(req, 'versionId'),
      rule: String(b.rule ?? 'all_active_customers') as never,
      partyIds: Array.isArray(b.party_ids)
        ? (b.party_ids as unknown[]).filter((v): v is string => typeof v === 'string')
        : undefined,
    });
    if (outcome.outcome !== 'built') refuse(outcome);
    res.json({ audience: outcome.result });
  }),
);

router.post(
  '/campaigns/:campaignId/versions/:versionId/approve',
  authenticate,
  requireAction('marketing.campaign.approve'),
  handler(async (req, res) => {
    const outcome = await approveCampaignVersion({
      actingUserLinkId: actorOf(req),
      tenantId: tenantOf(req),
      campaignId: requireUuidParam(req, 'campaignId'),
      campaignVersionId: requireUuidParam(req, 'versionId'),
      expectedVersion: expectedVersionOf(req),
    });
    if (outcome.outcome !== 'approved') refuse(outcome);
    res.json({ version: outcome.version });
  }),
);

router.post(
  '/campaigns/:campaignId/versions/:versionId/execute',
  authenticate,
  requireAction('marketing.campaign.execute'),
  handler(async (req, res) => {
    const outcome = await executeCampaignVersion({
      actingUserLinkId: actorOf(req),
      tenantId: tenantOf(req),
      campaignId: requireUuidParam(req, 'campaignId'),
      campaignVersionId: requireUuidParam(req, 'versionId'),
      expectedVersion: expectedVersionOf(req),
    });
    if (outcome.outcome === 'already_executing') {
      res.status(200).json({ version: outcome.version, outcome: 'already_executing' });
      return;
    }
    if (outcome.outcome !== 'executing') refuse(outcome);
    res.status(202).json({ version: outcome.version, prepared: outcome.result });
  }),
);

router.get(
  '/campaigns/:campaignId/versions/:versionId',
  authenticate,
  requireAction('marketing.campaign.view'),
  handler(async (req, res) => {
    requireUuidParam(req, 'campaignId');
    const summary = await campaignSendSummary(
      tenantOf(req),
      requireUuidParam(req, 'versionId'),
      await rooftopsOf(req),
    );
    if (summary === null) throw new NotFoundError('Resource not found');
    res.json({ summary });
  }),
);

router.post(
  '/campaigns/:campaignId/sends/:sendId/response',
  authenticate,
  requireAction('marketing.campaign.reconcile'),
  handler(async (req, res) => {
    const b = body(req);
    const outcome = await recordCampaignResponse({
      actingUserLinkId: actorOf(req),
      tenantId: tenantOf(req),
      campaignId: requireUuidParam(req, 'campaignId'),
      sendId: requireUuidParam(req, 'sendId'),
      responseType: String(b.response_type ?? 'reply') as never,
      detail: strOrUndefined(b.detail) ?? null,
    });
    if (outcome.outcome === 'already_recorded') {
      res.status(200).json({ outcome: 'already_recorded', responseId: outcome.responseId });
      return;
    }
    if (outcome.outcome !== 'recorded') refuse(outcome);
    res.status(201).json({ responseId: outcome.responseId, leadId: outcome.leadId });
  }),
);

router.post(
  '/campaigns/:campaignId/sends/:sendId/reconcile',
  authenticate,
  requireAction('marketing.campaign.reconcile'),
  handler(async (req, res) => {
    const b = body(req);
    const outcome = await reconcileSend({
      tenantId: tenantOf(req),
      campaignId: requireUuidParam(req, 'campaignId'),
      sendId: requireUuidParam(req, 'sendId'),
      providerState: String(b.provider_state ?? 'sent') as 'sent' | 'failed',
      detail: strOrUndefined(b.detail) ?? null,
      externalRef: strOrUndefined(b.external_ref) ?? null,
    });
    if (outcome.outcome === 'not_found') throw new NotFoundError('Resource not found');
    res.json(outcome);
  }),
);

// ── row 5: attribution ──────────────────────────────────────────────────────

router.get(
  '/attribution',
  authenticate,
  requireAction('marketing.attribution.view'),
  handler(async (req, res) => {
    const q = req.query as Record<string, unknown>;
    const model = typeof q.model === 'string' ? q.model : 'linear';
    if (!ATTRIBUTION_MODELS.includes(model as AttributionModel)) {
      throw new ValidationError('unknown attribution model', { code: 'invalid_request' });
    }
    const permitted = await rooftopsOf(req);
    const rooftopId = typeof q.location_id === 'string' ? q.location_id : permitted[0];
    if (rooftopId === undefined || !permitted.includes(rooftopId)) {
      throw new NotFoundError('Resource not found');
    }
    res.json(
      await attributionReport({
        tenantId: tenantOf(req),
        rooftopId,
        model: model as AttributionModel,
      }),
    );
  }),
);

router.post(
  '/attribution',
  authenticate,
  requireAction('marketing.attribution.compute'),
  handler(async (req, res) => {
    const b = body(req);
    const rooftopId = String(b.location_id ?? '');
    if (!(await rooftopsOf(req)).includes(rooftopId)) {
      throw new NotFoundError('Resource not found');
    }
    const outcome = await computeAttribution({
      actingUserLinkId: actorOf(req),
      tenantId: tenantOf(req),
      rooftopId,
      model: String(b.model ?? 'linear') as AttributionModel,
      windowStart: String(b.window_start ?? ''),
      windowEnd: String(b.window_end ?? ''),
    });
    if (outcome.outcome !== 'computed') refuse(outcome);
    res.status(201).json({ run: outcome.run });
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
