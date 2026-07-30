import { NextFunction, Request, Response, Router } from 'express';
import { authenticate, authorize, rejectTenantOverride, requireContext } from '../middleware/auth';
import { READ_ROLES, ROLES } from '@dealer/contracts';
import { ForbiddenError, ValidationError } from '@dealer/platform';
import * as svc from '@dealer/fixed-ops';

// ============================================================
// Phase 248 — Service Cockpit v2 & Fixed Ops Operations Platform
// Full Route Layer — 10 API Sections + Home
//
// Every route is `authenticate` + `authorize(...)`. Tenant and actor identity come
// from the verified token via `requireContext(req)`; request bodies are read only for
// domain input. A body or query `tenant_id` that disagrees with the token is rejected.
// ============================================================

const router = Router();

/** Wraps an async handler so rejections reach the error middleware. */
function handler(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve()
      .then(() => {
        rejectTenantOverride(req);
        return fn(req, res);
      })
      .catch(next);
  };
}

function requireFields(body: Record<string, unknown>, fields: string[]): void {
  const missing = fields.filter((f) => body?.[f] === undefined || body[f] === null || body[f] === '');
  if (missing.length > 0) throw new ValidationError(`${missing.join(', ')} required`, { details: { missing } });
}

/**
 * Rejects fields the caller must not set, rather than dropping them silently — a
 * client that believes it set `authorization_status` should be told it did not.
 */
function refuseFields(body: Record<string, unknown>, fields: string[]): void {
  const present = fields.filter((f) => body && f in body);
  if (present.length > 0) {
    throw new ForbiddenError(`${present.join(', ')} cannot be set directly`, {
      code: 'authorization_fields_readonly',
      details: { refused: present },
    });
  }
}

const WRITE_SERVICE = [ROLES.SERVICE_ADVISOR, ROLES.SERVICE_MANAGER];
const SHOP_FLOOR = [ROLES.TECHNICIAN, ROLES.SERVICE_ADVISOR, ROLES.SERVICE_MANAGER];
const PARTS = [ROLES.PARTS_CLERK, ROLES.SERVICE_ADVISOR, ROLES.SERVICE_MANAGER];

// ────────────────────────────────────────────────────────────
// 1) Service Home & Dashboards (SCM2)
// ────────────────────────────────────────────────────────────

router.get('/home', authenticate, authorize(...READ_ROLES), handler(async (req, res) => {
  const data = await svc.getServiceCockpitHome(requireContext(req), req.query.location_id as string | undefined, {
    timezone: req.query.timezone,
  });
  res.json({ success: true, data });
}));

router.post('/query/view', authenticate, authorize(...READ_ROLES), handler(async (req, res) => {
  requireFields(req.body, ['view_id']);
  const { view_id, overrides, limit, offset } = req.body;
  const data = await svc.queryServiceCockpitView(requireContext(req), view_id, overrides, { limit, offset });
  res.json({ success: true, data });
}));

// ────────────────────────────────────────────────────────────
// 2) Scheduling & Intake (SSIS2)
// ────────────────────────────────────────────────────────────

router.post('/appointments', authenticate, authorize(...WRITE_SERVICE), handler(async (req, res) => {
  requireFields(req.body, ['location_id', 'mdm_customer_id', 'mdm_vehicle_id', 'scheduled_start']);
  const { location_id, mdm_customer_id, mdm_vehicle_id, scheduled_start, scheduled_end,
    concerns, preferred_contact_channel, language_preference, source } = req.body;
  const data = await svc.createAppointment(requireContext(req), {
    location_id, mdm_customer_id, mdm_vehicle_id, scheduled_start, scheduled_end,
    concerns, preferred_contact_channel, language_preference, source,
  });
  res.status(201).json({ success: true, data });
}));

router.patch('/appointments/:appointmentId', authenticate, authorize(...WRITE_SERVICE), handler(async (req, res) => {
  const data = await svc.updateAppointment(requireContext(req), req.params.appointmentId, req.body);
  res.json({ success: true, data });
}));

router.post('/appointments/:appointmentId/confirm', authenticate, authorize(...WRITE_SERVICE), handler(async (req, res) => {
  const data = await svc.confirmAppointment(requireContext(req), req.params.appointmentId);
  res.json({ success: true, data });
}));

router.post('/appointments/:appointmentId/check-in', authenticate, authorize(...WRITE_SERVICE), handler(async (req, res) => {
  const data = await svc.checkIn(requireContext(req), req.params.appointmentId, { odometer: req.body?.odometer });
  res.json({ success: true, data });
}));

router.post('/appointments/:appointmentId/no-show', authenticate, authorize(...WRITE_SERVICE), handler(async (req, res) => {
  const data = await svc.markAppointmentNoShow(requireContext(req), req.params.appointmentId);
  res.json({ success: true, data });
}));

router.post('/intake/quick-start', authenticate, authorize(...WRITE_SERVICE), handler(async (req, res) => {
  requireFields(req.body, ['location_id']);
  const { location_id, scan_vin, mdm_vehicle_id, language_preference } = req.body;
  const data = await svc.quickStartIntake(requireContext(req), {
    location_id, scan_vin, mdm_vehicle_id, language_preference,
  });
  res.json({ success: true, data });
}));


// Waitlist: customers waiting for a slot the schedule cannot give them yet.
// waiting → offered → scheduled | canceled | expired; conversion books the
// appointment in the same transaction.

router.post('/waitlist', authenticate, authorize(...WRITE_SERVICE), handler(async (req, res) => {
  requireFields(req.body, ['location_id', 'mdm_customer_id', 'mdm_vehicle_id', 'requested_start']);
  const { location_id, mdm_customer_id, mdm_vehicle_id, requested_start, requested_end,
    concerns, priority, preferred_contact_channel, language_preference, notes } = req.body;
  const data = await svc.createWaitlistEntry(requireContext(req), {
    location_id, mdm_customer_id, mdm_vehicle_id, requested_start, requested_end,
    concerns, priority, preferred_contact_channel, language_preference, notes,
  });
  res.status(201).json({ success: true, data });
}));

router.get('/waitlist', authenticate, authorize(...READ_ROLES), handler(async (req, res) => {
  const data = await svc.listWaitlistEntries(requireContext(req), {
    status: req.query.status as string | undefined,
    location_id: req.query.location_id as string | undefined,
    limit: req.query.limit,
    offset: req.query.offset,
  });
  res.json({ success: true, data });
}));

router.post('/waitlist/:waitlistEntryId/offer', authenticate, authorize(...WRITE_SERVICE), handler(async (req, res) => {
  const data = await svc.offerWaitlistSlot(requireContext(req), req.params.waitlistEntryId, {
    offer_expires_at: req.body?.offer_expires_at,
  });
  res.json({ success: true, data });
}));

router.post('/waitlist/:waitlistEntryId/convert', authenticate, authorize(...WRITE_SERVICE), handler(async (req, res) => {
  requireFields(req.body, ['scheduled_start']);
  const data = await svc.convertWaitlistEntry(requireContext(req), req.params.waitlistEntryId, {
    scheduled_start: req.body.scheduled_start,
    scheduled_end: req.body.scheduled_end,
  });
  res.status(201).json({ success: true, data });
}));

router.post('/waitlist/:waitlistEntryId/cancel', authenticate, authorize(...WRITE_SERVICE), handler(async (req, res) => {
  const data = await svc.cancelWaitlistEntry(requireContext(req), req.params.waitlistEntryId);
  res.json({ success: true, data });
}));

// ────────────────────────────────────────────────────────────
// 3) Repair Orders (ROLS2)
// ────────────────────────────────────────────────────────────

router.post('/ros', authenticate, authorize(...WRITE_SERVICE), handler(async (req, res) => {
  requireFields(req.body, ['location_id', 'mdm_customer_id', 'mdm_vehicle_id']);
  const { location_id, mdm_customer_id, mdm_vehicle_id, appointment_id, odometer, promised_time, advisor_user_id } = req.body;
  const data = await svc.createRO(requireContext(req), {
    location_id, mdm_customer_id, mdm_vehicle_id, appointment_id, odometer, promised_time, advisor_user_id,
  });
  res.status(201).json({ success: true, data });
}));

router.get('/ros/:roId', authenticate, authorize(...READ_ROLES), handler(async (req, res) => {
  const data = await svc.getRO(requireContext(req), req.params.roId, { event_limit: req.query.event_limit });
  res.json({ success: true, data });
}));

/**
 * Privileged transitions (`authorized`, `canceled`) additionally require a step-up
 * token bound to this user and this repair order; see shared/security/step-up.
 */
router.post('/ros/:roId/transition', authenticate, authorize(...WRITE_SERVICE), handler(async (req, res) => {
  requireFields(req.body, ['to_status']);
  const { to_status, reason, step_up_token } = req.body;
  const data = await svc.transitionRO(requireContext(req), req.params.roId, to_status, { reason, step_up_token });
  res.json({ success: true, data });
}));

router.post('/ros/:roId/line-items', authenticate, authorize(...WRITE_SERVICE), handler(async (req, res) => {
  requireFields(req.body, ['line_type', 'description']);
  refuseFields(req.body, ['authorization_status', 'authorization_ref']);
  const { line_type, category, description, labor_op_code, estimated_hours } = req.body;
  const data = await svc.addLineItem(requireContext(req), req.params.roId, {
    line_type, category, description, labor_op_code, estimated_hours,
  });
  res.status(201).json({ success: true, data });
}));

/**
 * Shop floor may report progress; only advisors and managers may change what the
 * customer is billed. `updateLineItem` enforces that split per field, and restricts a
 * technician to the lines they were dispatched to.
 */
router.patch('/ros/:roId/line-items/:lineItemId', authenticate, authorize(...SHOP_FLOOR), handler(async (req, res) => {
  const data = await svc.updateLineItem(requireContext(req), req.params.roId, req.params.lineItemId, req.body);
  res.json({ success: true, data });
}));

// ────────────────────────────────────────────────────────────
// 4) MPI (DMRS2)
// ────────────────────────────────────────────────────────────

router.get('/mpi/templates', authenticate, authorize(...READ_ROLES), handler(async (req, res) => {
  const data = await svc.listMPITemplates(requireContext(req), req.query.location_id as string | undefined);
  res.json({ success: true, data });
}));

router.post('/ros/:roId/mpi/start', authenticate, authorize(...SHOP_FLOOR), handler(async (req, res) => {
  requireFields(req.body, ['template_id', 'tech_user_id']);
  const { template_id, tech_user_id } = req.body;
  const data = await svc.startMPISession(requireContext(req), req.params.roId, { template_id, tech_user_id });
  res.status(201).json({ success: true, data });
}));

router.post('/mpi/:mpiSessionId/results', authenticate, authorize(...SHOP_FLOOR), handler(async (req, res) => {
  requireFields(req.body, ['item_key', 'status']);
  const { item_key, status, severity, notes, evidence_artifact_refs } = req.body;
  const data = await svc.recordMPIResult(requireContext(req), req.params.mpiSessionId, {
    item_key, status, severity, notes, evidence_artifact_refs,
  });
  res.status(201).json({ success: true, data });
}));

router.post('/mpi/:mpiSessionId/submit', authenticate, authorize(...SHOP_FLOOR), handler(async (req, res) => {
  const data = await svc.submitMPISession(requireContext(req), req.params.mpiSessionId);
  res.json({ success: true, data });
}));

router.post('/ros/:roId/recommendations/send-to-customer', authenticate, authorize(...WRITE_SERVICE), handler(async (req, res) => {
  const { channel, language } = req.body ?? {};
  const data = await svc.sendRecommendationsToCustomer(requireContext(req), req.params.roId, { channel, language });
  res.json({ success: true, data });
}));

// ────────────────────────────────────────────────────────────
// 5) Estimates & Authorizations (EAS2)
// ────────────────────────────────────────────────────────────

router.post('/ros/:roId/estimates/generate', authenticate, authorize(...WRITE_SERVICE), handler(async (req, res) => {
  const data = await svc.generateEstimate(requireContext(req), req.params.roId, { language_mode: req.body?.language_mode });
  res.status(201).json({ success: true, data });
}));

router.post('/ros/:roId/estimates/:estimateId/send', authenticate, authorize(...WRITE_SERVICE), handler(async (req, res) => {
  const { channel, language } = req.body ?? {};
  const data = await svc.sendEstimate(requireContext(req), req.params.roId, req.params.estimateId, { channel, language });
  res.json({ success: true, data });
}));

router.get('/ros/:roId/authorizations', authenticate, authorize(...READ_ROLES), handler(async (req, res) => {
  const data = await svc.listAuthorizations(requireContext(req), req.params.roId);
  res.json({ success: true, data });
}));

/**
 * Records the customer's decision. `staff_attestation` — staff asserting approval on
 * the customer's behalf — additionally requires a step-up token.
 */
router.post('/ros/:roId/authorizations/record', authenticate, authorize(...WRITE_SERVICE), handler(async (req, res) => {
  requireFields(req.body, ['estimate_id', 'method']);
  const { estimate_id, method, approved_items, declined_items, evidence_refs, customer_language_used, step_up_token } = req.body;
  const data = await svc.recordAuthorization(requireContext(req), req.params.roId, {
    estimate_id, method, approved_items: approved_items ?? [], declined_items,
    evidence_refs, customer_language_used, step_up_token,
  });
  res.status(201).json({ success: true, data });
}));

// ────────────────────────────────────────────────────────────
// 6) Parts (POS2)
// ────────────────────────────────────────────────────────────

router.post('/ros/:roId/parts/request', authenticate, authorize(...PARTS), handler(async (req, res) => {
  requireFields(req.body, ['line_item_id', 'part_number', 'description']);
  const { line_item_id, part_number, description, quantity } = req.body;
  const data = await svc.requestPart(requireContext(req), req.params.roId, { line_item_id, part_number, description, quantity });
  res.status(201).json({ success: true, data });
}));

router.patch('/parts/:partLineId', authenticate, authorize(...PARTS), handler(async (req, res) => {
  const data = await svc.updatePartLine(requireContext(req), req.params.partLineId, req.body);
  res.json({ success: true, data });
}));

// ────────────────────────────────────────────────────────────
// 7) Sublet (SOS2)
// ────────────────────────────────────────────────────────────

router.post('/ros/:roId/sublet/create', authenticate, authorize(...PARTS), handler(async (req, res) => {
  requireFields(req.body, ['line_item_id', 'vendor_ref']);
  const { line_item_id, vendor_ref, expected_return_at } = req.body;
  const data = await svc.createSubletJob(requireContext(req), req.params.roId, { line_item_id, vendor_ref, expected_return_at });
  res.status(201).json({ success: true, data });
}));

router.patch('/sublet/:subletJobId', authenticate, authorize(...PARTS), handler(async (req, res) => {
  const data = await svc.updateSubletJob(requireContext(req), req.params.subletJobId, req.body);
  res.json({ success: true, data });
}));

// ────────────────────────────────────────────────────────────
// 8) Technician Dispatch & Time (TDTS2)
// ────────────────────────────────────────────────────────────

router.post('/dispatch/assign', authenticate, authorize(...WRITE_SERVICE), handler(async (req, res) => {
  requireFields(req.body, ['ro_id', 'line_item_id', 'tech_user_id']);
  const { ro_id, line_item_id, tech_user_id } = req.body;
  const data = await svc.dispatchTech(requireContext(req), { ro_id, line_item_id, tech_user_id });
  res.status(201).json({ success: true, data });
}));

router.post('/tech/tickets/:ticketId/status', authenticate, authorize(...SHOP_FLOOR), handler(async (req, res) => {
  requireFields(req.body, ['status']);
  const { status, pause_reason } = req.body;
  const data = await svc.updateTicketStatus(requireContext(req), req.params.ticketId, { status, pause_reason });
  res.json({ success: true, data });
}));

router.post('/tech/tickets/:ticketId/time', authenticate, authorize(...SHOP_FLOOR), handler(async (req, res) => {
  requireFields(req.body, ['event_type']);
  const { event_type, occurred_at } = req.body;
  const data = await svc.recordTimeEntry(requireContext(req), req.params.ticketId, { event_type, occurred_at });
  res.status(201).json({ success: true, data });
}));

// ────────────────────────────────────────────────────────────
// 9) Warranty & Comebacks (WPCS2 + QCS2)
// ────────────────────────────────────────────────────────────

router.post('/warranty/claims', authenticate, authorize(ROLES.WARRANTY_ADMIN, ...WRITE_SERVICE), handler(async (req, res) => {
  requireFields(req.body, ['ro_id']);
  const { ro_id, evidence_refs, provider_ref } = req.body;
  const data = await svc.createWarrantyClaim(requireContext(req), { ro_id, evidence_refs, provider_ref });
  res.status(201).json({ success: true, data });
}));

router.post('/comebacks', authenticate, authorize(...WRITE_SERVICE), handler(async (req, res) => {
  requireFields(req.body, ['original_ro_id', 'new_ro_id', 'root_cause_category']);
  const { original_ro_id, new_ro_id, root_cause_category, reason_codes, severity } = req.body;
  const data = await svc.createComebackCase(requireContext(req), {
    original_ro_id, new_ro_id, root_cause_category, reason_codes: reason_codes ?? [], severity,
  });
  res.status(201).json({ success: true, data });
}));

router.patch('/comebacks/:comebackId', authenticate, authorize(...WRITE_SERVICE), handler(async (req, res) => {
  const data = await svc.updateComebackCase(requireContext(req), req.params.comebackId, { status: req.body?.status });
  res.json({ success: true, data });
}));

// ────────────────────────────────────────────────────────────
// 10) Queues & SLAs (SSR2)
// ────────────────────────────────────────────────────────────

router.get('/queues', authenticate, authorize(...READ_ROLES), handler(async (req, res) => {
  const data = await svc.listServiceQueueItems(requireContext(req), {
    location_id: req.query.location_id as string | undefined,
    queue_type: req.query.queue_type as string | undefined,
    status: req.query.status as string | undefined,
    limit: req.query.limit,
    offset: req.query.offset,
  });
  res.json({ success: true, data });
}));

router.post('/queues/:queueItemId/assign', authenticate, authorize(...SHOP_FLOOR), handler(async (req, res) => {
  const data = await svc.assignServiceQueueItem(requireContext(req), req.params.queueItemId);
  res.json({ success: true, data });
}));

router.post('/queues/:queueItemId/update-status', authenticate, authorize(...SHOP_FLOOR), handler(async (req, res) => {
  requireFields(req.body, ['status']);
  const { status, block_reason_codes } = req.body;
  const data = await svc.updateServiceQueueItemStatus(requireContext(req), req.params.queueItemId, { status, block_reason_codes });
  res.json({ success: true, data });
}));

router.post('/queues/:queueItemId/escalate', authenticate, authorize(ROLES.SERVICE_MANAGER), handler(async (req, res) => {
  requireFields(req.body, ['reason']);
  const { reason, create_runbook } = req.body;
  const data = await svc.escalateServiceQueueItem(requireContext(req), req.params.queueItemId, { reason, create_runbook });
  res.json({ success: true, data });
}));

// ────────────────────────────────────────────────────────────
// 11) Customer Portal Tasks (CSPP2)
// ────────────────────────────────────────────────────────────

router.get('/ros/:roId/portal-tasks', authenticate, authorize(...READ_ROLES), handler(async (req, res) => {
  const data = await svc.listPortalTasks(requireContext(req), req.params.roId);
  res.json({ success: true, data });
}));

router.patch('/portal-tasks/:portalTaskId', authenticate, authorize(...WRITE_SERVICE), handler(async (req, res) => {
  requireFields(req.body, ['status']);
  const data = await svc.updatePortalTaskStatus(requireContext(req), req.params.portalTaskId, { status: req.body.status });
  res.json({ success: true, data });
}));

// ────────────────────────────────────────────────────────────
// PSFSRB2 — First Service Retention
// ────────────────────────────────────────────────────────────

router.post('/retention/first-service', authenticate, authorize(...WRITE_SERVICE), handler(async (req, res) => {
  requireFields(req.body, ['location_id', 'mdm_customer_id', 'mdm_vehicle_id', 'deal_id']);
  const { location_id, mdm_customer_id, mdm_vehicle_id, deal_id, recommended_window_start, language_preference } = req.body;
  const data = await svc.createFirstServiceOffer(requireContext(req), {
    location_id, mdm_customer_id, mdm_vehicle_id, deal_id,
    recommended_window_start: recommended_window_start ?? new Date(Date.now() + 90 * 86_400_000).toISOString(),
    language_preference,
  });
  res.status(201).json({ success: true, data });
}));

export default router;
