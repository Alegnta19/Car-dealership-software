import * as promClient from 'prom-client';
import { Executor, query, withTransaction } from '../../../shared/database/pool';
import { distinct, generateId, isUuid } from '../../../shared/utils/helpers';
import { logger } from '../../../shared/utils/logger';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnprocessableError,
  ValidationError,
} from '../../../shared/middleware/error-handler';
import { ROLES, Role } from '../../../shared/middleware/auth';
import { verifyStepUpToken } from '../../../shared/security/step-up';
import {
  allowedTransitionsFrom,
  isTransitionAllowed,
  transitionRequiresAuthorization,
  transitionRequiresStepUp,
} from '../domain/state-machine';
import {
  deriveAuthorizationStatus,
  deriveEstimateStatus,
  isAuthorizationMethod,
  methodRequiresStepUp,
} from '../domain/authorization';

// ============================================================
// Phase 248 — Service Cockpit v2 & Fixed Ops Operations Platform
// 13 Subdomains — Full Service Layer
//
// Tenancy rule for this module: `ctx.tenantId` comes from the verified bearer token
// and is the ONLY tenant identity used. Every statement that reads or writes a
// tenant-owned row carries `tenant_id` in its WHERE clause, and every child write
// proves its parent belongs to the caller's tenant first.
// ============================================================

/** Verified caller identity. Built by the route layer from `req.tenantContext`. */
export interface AuthContext {
  tenantId: string;
  userId: string;
  roles: Role[];
}

// ── Prometheus Observability (15 metrics per spec) ────────────

const svcAppointmentsTotal = new promClient.Counter({ name: 'service_appointments_total', help: 'Appointments', labelNames: ['status', 'location'] });
const svcROTotal = new promClient.Counter({ name: 'service_ro_total', help: 'Repair orders', labelNames: ['status', 'location'] });
const svcROCycleTime = new promClient.Histogram({ name: 'service_ro_cycle_time_minutes_p95', help: 'RO cycle time', labelNames: ['location'], buckets: [30, 60, 120, 240, 480, 720, 1440] });
const svcApprovalTime = new promClient.Histogram({ name: 'service_approval_time_minutes_p95', help: 'Approval time', labelNames: ['location'], buckets: [5, 15, 30, 60, 120, 240, 480] });
const svcPartsBackorderRate = new promClient.Gauge({ name: 'service_parts_backorder_rate', help: 'Parts backorder rate', labelNames: ['location'] });
const svcPartsWaitTime = new promClient.Histogram({ name: 'service_parts_wait_time_minutes_p95', help: 'Parts wait time', labelNames: ['location'], buckets: [30, 60, 240, 480, 1440, 2880] });
const svcQCFailRate = new promClient.Gauge({ name: 'service_qc_fail_rate', help: 'QC failure rate', labelNames: ['location'] });
const svcComebackRate = new promClient.Gauge({ name: 'service_comeback_rate', help: 'Comeback rate', labelNames: ['location', 'category'] });
const svcTechUtilization = new promClient.Gauge({ name: 'service_tech_utilization', help: 'Tech utilization', labelNames: ['location'] });
const svcTechEfficiency = new promClient.Gauge({ name: 'service_tech_efficiency', help: 'Tech efficiency', labelNames: ['location'] });
const svcTechProficiency = new promClient.Gauge({ name: 'service_tech_proficiency', help: 'Tech proficiency', labelNames: ['location'] });
const svcQueueDepth = new promClient.Gauge({ name: 'service_queue_depth', help: 'Queue depth', labelNames: ['queue_type', 'location'] });
const svcSLABreachRate = new promClient.Gauge({ name: 'service_sla_breach_rate', help: 'SLA breach rate', labelNames: ['job_type', 'location'] });
const svcMPIConversionRate = new promClient.Gauge({ name: 'service_mpi_conversion_rate', help: 'MPI conversion rate', labelNames: ['recommendation_type'] });
const svcFirstServiceCaptureRate = new promClient.Gauge({ name: 'service_retention_first_service_capture_rate', help: 'First service capture rate', labelNames: ['location'] });

/**
 * Declared-but-unwired gauges. They are part of the Phase-248 metric contract and are
 * exported so the aggregation job that will populate them (outstanding work, see
 * docs/REMEDIATION.md) has a single import site. Publishing a placeholder constant
 * would be worse than publishing nothing, so nothing sets them here.
 */
export const unwiredMetrics = {
  svcPartsBackorderRate,
  svcPartsWaitTime,
  svcQCFailRate,
  svcTechUtilization,
  svcTechEfficiency,
  svcTechProficiency,
  svcSLABreachRate,
  svcMPIConversionRate,
  svcComebackRate,
  svcFirstServiceCaptureRate,
};

// ── Helpers ───────────────────────────────────────────────────

function i18n(en: string, es: string) {
  return { en, es };
}

/**
 * Best-effort platform audit. Deliberately runs on the pool AFTER the business
 * transaction commits: a failed statement aborts an open Postgres transaction, so a
 * swallowed error inside one would poison the commit it was meant to describe.
 */
async function emitAudit(
  ctx: AuthContext,
  action: string,
  entityType: string,
  entityId: string,
  details: Record<string, unknown>,
): Promise<void> {
  try {
    await query(
      `INSERT INTO audit_events (event_id,tenant_id,event_type,entity_type,entity_id,actor_user_id,details,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())`,
      [generateId(), ctx.tenantId, `service.${action}`, entityType, entityId, ctx.userId, JSON.stringify(details)],
    );
  } catch (err) {
    logger.warn({ action, entityId, err }, 'Audit emit failed');
  }
}

/**
 * Appends a repair-order domain event. Runs on the caller's executor so it commits or
 * rolls back with the change it describes — an RO must never move without its event.
 */
async function recordROEvent(
  ex: Executor,
  ctx: AuthContext,
  roId: string,
  eventType: string,
  actor: Record<string, unknown>,
  payload: Record<string, unknown> = {},
): Promise<void> {
  await ex.query(
    `INSERT INTO ro_events (ro_event_id,ro_id,tenant_id,event_type,actor_ref,payload_ref)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [generateId(), roId, ctx.tenantId, eventType, JSON.stringify(actor), JSON.stringify(payload)],
  );
}

async function recordAppointmentEvent(
  ex: Executor,
  ctx: AuthContext,
  appointmentId: string,
  eventType: string,
  actor: Record<string, unknown>,
): Promise<void> {
  await ex.query(
    `INSERT INTO service_appointment_events (event_id,appointment_id,tenant_id,event_type,actor_ref)
     VALUES ($1,$2,$3,$4,$5)`,
    [generateId(), appointmentId, ctx.tenantId, eventType, JSON.stringify(actor)],
  );
}

function requireUuid(value: unknown, field: string): string {
  if (!isUuid(value)) throw new ValidationError(`${field} must be a UUID`);
  return value;
}

function requireOneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new ValidationError(`${field} must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

function hasAnyRole(ctx: AuthContext, ...roles: Role[]): boolean {
  return ctx.roles.includes(ROLES.ADMIN) || ctx.roles.some((r) => roles.includes(r));
}

/**
 * Loads a repair order that belongs to the caller's tenant, or throws 404.
 *
 * This is the ownership proof every `:roId`-scoped write depends on. Cross-tenant
 * misses are reported as "not found" so the API never confirms that another tenant's
 * repair order exists.
 */
async function assertRO(ex: Executor, ctx: AuthContext, roId: string, opts: { lock?: boolean } = {}): Promise<any> {
  requireUuid(roId, 'ro_id');
  const ro = (
    await ex.query(
      `SELECT * FROM repair_orders WHERE ro_id=$1 AND tenant_id=$2${opts.lock ? ' FOR UPDATE' : ''}`,
      [roId, ctx.tenantId],
    )
  ).rows[0];
  if (!ro) throw new NotFoundError('Repair order not found', { code: 'ro_not_found' });
  return ro;
}

/** Loads a line item proven to belong to both the caller's tenant and the given RO. */
async function assertLineItem(ex: Executor, ctx: AuthContext, roId: string, lineItemId: string): Promise<any> {
  requireUuid(lineItemId, 'line_item_id');
  const item = (
    await ex.query(`SELECT * FROM ro_line_items WHERE line_item_id=$1 AND ro_id=$2 AND tenant_id=$3`, [
      lineItemId,
      roId,
      ctx.tenantId,
    ])
  ).rows[0];
  if (!item) throw new NotFoundError('Line item not found on this repair order', { code: 'line_item_not_found' });
  return item;
}

/**
 * Verifies every supplied line-item id belongs to this RO and tenant, and returns the
 * rows. Any unknown id is rejected outright rather than silently skipped — a caller
 * must not be able to probe for, or act on, ids that are not theirs.
 */
async function assertLineItemsOnRO(ex: Executor, ctx: AuthContext, roId: string, ids: string[]): Promise<any[]> {
  if (ids.length === 0) return [];
  for (const id of ids) requireUuid(id, 'line_item_id');

  const rows = (
    await ex.query(`SELECT * FROM ro_line_items WHERE line_item_id = ANY($1) AND ro_id=$2 AND tenant_id=$3`, [
      ids,
      roId,
      ctx.tenantId,
    ])
  ).rows;

  if (rows.length !== ids.length) {
    const found = new Set(rows.map((r: any) => r.line_item_id));
    throw new ValidationError('One or more line items do not belong to this repair order', {
      code: 'unknown_line_items',
      details: { unknown: ids.filter((id) => !found.has(id)) },
    });
  }
  return rows;
}

// ============================================================
// 1) SCM2 — Service Cockpit Module v2
// ============================================================

export async function getServiceCockpitHome(ctx: AuthContext, locationId?: string): Promise<any> {
  if (locationId !== undefined) requireUuid(locationId, 'location_id');

  const params: unknown[] = locationId ? [ctx.tenantId, locationId] : [ctx.tenantId];
  const scope = (column: string) => (locationId ? ` AND ${column}=$2` : '');

  const queueSummary = (
    await query(
      `SELECT queue_type, status, COUNT(*)::int AS cnt FROM service_queue_items
       WHERE tenant_id=$1${scope('location_id')} AND status NOT IN ('done','canceled')
       GROUP BY queue_type, status`,
      params,
    )
  ).rows;

  const overdueItems = (
    await query(
      `SELECT * FROM service_queue_items
       WHERE tenant_id=$1${scope('location_id')} AND sla_due_at < NOW() AND status IN ('queued','in_progress')
       ORDER BY sla_due_at LIMIT 20`,
      params,
    )
  ).rows;

  const todayAppts = (
    await query(
      `SELECT status, COUNT(*)::int AS cnt FROM service_appointments
       WHERE tenant_id=$1${scope('location_id')} AND scheduled_start::date = CURRENT_DATE
       GROUP BY status`,
      params,
    )
  ).rows;

  const partsDelays = (
    await query(
      `SELECT COUNT(*)::int AS cnt FROM ro_parts_lines rpl
       JOIN repair_orders ro ON rpl.ro_id = ro.ro_id AND ro.tenant_id = rpl.tenant_id
       WHERE rpl.tenant_id=$1${scope('ro.location_id')} AND rpl.status='backordered'`,
      params,
    )
  ).rows[0];

  // Scoped through the originating RO so a per-location cockpit does not report the
  // tenant-wide comeback count.
  const comebacks = (
    await query(
      `SELECT COUNT(*)::int AS cnt FROM comeback_cases cc
       JOIN repair_orders ro ON cc.original_ro_id = ro.ro_id AND ro.tenant_id = cc.tenant_id
       WHERE cc.tenant_id=$1${scope('ro.location_id')} AND cc.status IN ('open','in_progress')`,
      params,
    )
  ).rows[0];

  return {
    tenant_id: ctx.tenantId,
    location_id: locationId ?? null,
    queue_summary: queueSummary,
    overdue_items: overdueItems,
    todays_appointments: todayAppts,
    exceptions: { parts_delays: partsDelays?.cnt ?? 0, open_comebacks: comebacks?.cnt ?? 0 },
    featured_views: [
      { key: 'todays_queue', label_i18n: i18n("Today's Queue", 'Cola de Hoy') },
      { key: 'waiting_authorization', label_i18n: i18n('Waiting Authorization', 'Esperando Autorización') },
      { key: 'waiting_parts', label_i18n: i18n('Waiting Parts', 'Esperando Repuestos') },
      { key: 'qc_review', label_i18n: i18n('QC Review', 'Revisión de Calidad') },
      { key: 'ready_pickup', label_i18n: i18n('Ready for Pickup', 'Listo para Recoger') },
      { key: 'comebacks', label_i18n: i18n('Comebacks', 'Retornos') },
    ],
    trust_summary: { data_freshness: 'live', confidence_level: 'high' },
  };
}

const VIEW_QUEUE_MAP: Record<string, string[]> = {
  todays_queue: ['appointments_today', 'waiting_checkin', 'in_repair'],
  waiting_authorization: ['waiting_authorization'],
  waiting_parts: ['waiting_parts'],
  qc_review: ['qc'],
  ready_pickup: ['ready_pickup'],
  comebacks: ['comeback_review'],
  no_show_followup: ['no_show_followup'],
};

export async function queryServiceCockpitView(ctx: AuthContext, viewId: string, overrides?: unknown): Promise<any> {
  const queueTypes = VIEW_QUEUE_MAP[viewId];
  if (!queueTypes) {
    throw new ValidationError('Unknown view_id', {
      code: 'unknown_view',
      details: { known_views: Object.keys(VIEW_QUEUE_MAP) },
    });
  }

  // View overrides are not implemented. Rejecting is honest; silently ignoring them
  // would let a caller believe a filter had been applied.
  if (overrides && typeof overrides === 'object' && Object.keys(overrides as object).length > 0) {
    throw new ValidationError('View overrides are not supported', { code: 'overrides_unsupported' });
  }

  const items = (
    await query(
      `SELECT qi.*, ro.status AS ro_status, ro.mdm_customer_id, ro.mdm_vehicle_id, ro.promised_time
       FROM service_queue_items qi
       LEFT JOIN repair_orders ro ON qi.ro_id = ro.ro_id AND ro.tenant_id = qi.tenant_id
       WHERE qi.tenant_id=$1 AND qi.queue_type = ANY($2) AND qi.status NOT IN ('done','canceled')
       ORDER BY qi.priority, qi.sla_due_at NULLS LAST LIMIT 100`,
      [ctx.tenantId, queueTypes],
    )
  ).rows;

  return { view_id: viewId, items, total: items.length };
}

// ============================================================
// 2) SSIS2 — Service Scheduling & Intake
// ============================================================

const APPOINTMENT_SOURCES = ['walk_in', 'phone', 'web', 'sales_handoff'] as const;
const LANGUAGE_PREFERENCES = ['en', 'es', 'auto'] as const;

export async function createAppointment(
  ctx: AuthContext,
  params: {
    location_id: string;
    mdm_customer_id: string;
    mdm_vehicle_id: string;
    scheduled_start: string;
    scheduled_end?: string;
    concerns?: unknown;
    preferred_contact_channel?: string;
    language_preference?: string;
    source?: string;
  },
): Promise<any> {
  requireUuid(params.location_id, 'location_id');
  requireUuid(params.mdm_customer_id, 'mdm_customer_id');
  requireUuid(params.mdm_vehicle_id, 'mdm_vehicle_id');
  if (Number.isNaN(Date.parse(params.scheduled_start))) throw new ValidationError('scheduled_start must be a timestamp');

  const source = params.source ? requireOneOf(params.source, APPOINTMENT_SOURCES, 'source') : 'phone';
  const language = params.language_preference
    ? requireOneOf(params.language_preference, LANGUAGE_PREFERENCES, 'language_preference')
    : 'en';

  const id = generateId();
  const appt = (
    await query(
      `INSERT INTO service_appointments (appointment_id,tenant_id,location_id,mdm_customer_id,mdm_vehicle_id,
         scheduled_start,scheduled_end,concerns,preferred_contact_channel,language_preference,source,created_by_user_id,status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'scheduled') RETURNING *`,
      [
        id, ctx.tenantId, params.location_id, params.mdm_customer_id, params.mdm_vehicle_id,
        params.scheduled_start, params.scheduled_end ?? null, JSON.stringify(params.concerns ?? []),
        params.preferred_contact_channel ?? 'sms', language, source, ctx.userId,
      ],
    )
  ).rows[0];

  svcAppointmentsTotal.inc({ status: 'scheduled', location: params.location_id });
  await emitAudit(ctx, 'appointment.created', 'service_appointment', id, { source });
  return appt;
}

const APPOINTMENT_UPDATABLE = ['scheduled_start', 'scheduled_end', 'concerns', 'preferred_contact_channel', 'language_preference'] as const;

/**
 * Reschedule / detail edits only.
 *
 * `status` is intentionally NOT updatable here: appointment state changes go through
 * `confirmAppointment` and `checkIn`, which enforce the legal source states and write
 * the matching audit event. Allowing a raw status write let a caller move an
 * appointment anywhere, including undoing a conversion to a repair order.
 */
export async function updateAppointment(ctx: AuthContext, appointmentId: string, updates: Record<string, unknown>): Promise<any> {
  requireUuid(appointmentId, 'appointment_id');

  if ('status' in updates) {
    throw new ValidationError('status cannot be set directly; use the confirm or check-in endpoints', {
      code: 'status_not_directly_updatable',
    });
  }

  const sets: string[] = [];
  const vals: unknown[] = [appointmentId, ctx.tenantId];
  for (const [k, v] of Object.entries(updates)) {
    if ((APPOINTMENT_UPDATABLE as readonly string[]).includes(k)) {
      vals.push(k === 'concerns' ? JSON.stringify(v) : v);
      sets.push(`${k}=$${vals.length}`);
    }
  }
  if (sets.length === 0) throw new ValidationError('No updatable fields supplied');
  sets.push('updated_at=NOW()');

  const row = (
    await query(
      `UPDATE service_appointments SET ${sets.join(',')} WHERE appointment_id=$1 AND tenant_id=$2 RETURNING *`,
      vals,
    )
  ).rows[0];
  if (!row) throw new NotFoundError('Appointment not found');
  return row;
}

export async function confirmAppointment(ctx: AuthContext, appointmentId: string): Promise<any> {
  requireUuid(appointmentId, 'appointment_id');

  return withTransaction(async (tx) => {
    const appt = (
      await tx.query(`SELECT * FROM service_appointments WHERE appointment_id=$1 AND tenant_id=$2 FOR UPDATE`, [
        appointmentId,
        ctx.tenantId,
      ])
    ).rows[0];
    if (!appt) throw new NotFoundError('Appointment not found');
    if (!['requested', 'scheduled'].includes(appt.status)) {
      throw new ConflictError(`Appointment cannot be confirmed from status '${appt.status}'`, {
        code: 'invalid_appointment_status',
        details: { status: appt.status },
      });
    }

    const row = (
      await tx.query(
        `UPDATE service_appointments SET status='confirmed', updated_at=NOW()
         WHERE appointment_id=$1 AND tenant_id=$2 RETURNING *`,
        [appointmentId, ctx.tenantId],
      )
    ).rows[0];

    await recordAppointmentEvent(tx, ctx, appointmentId, 'confirmed', { user_id: ctx.userId });
    return row;
  });
}

/**
 * Converts an appointment into a repair order.
 *
 * Idempotent by construction: the appointment row is locked, its status is checked
 * against the states that may still be converted, and an appointment that already
 * produced a repair order returns that same RO instead of creating a second one. The
 * partial unique index on `repair_orders(appointment_id)` is the backstop if two
 * requests race on separate connections.
 */
export async function checkIn(ctx: AuthContext, appointmentId: string, params: { odometer?: number }): Promise<any> {
  requireUuid(appointmentId, 'appointment_id');
  if (params.odometer !== undefined && (!Number.isInteger(params.odometer) || params.odometer < 0)) {
    throw new ValidationError('odometer must be a non-negative integer');
  }

  const result = await withTransaction(async (tx) => {
    const appt = (
      await tx.query(`SELECT * FROM service_appointments WHERE appointment_id=$1 AND tenant_id=$2 FOR UPDATE`, [
        appointmentId,
        ctx.tenantId,
      ])
    ).rows[0];
    if (!appt) throw new NotFoundError('Appointment not found');

    const existing = (
      await tx.query(`SELECT * FROM repair_orders WHERE appointment_id=$1 AND tenant_id=$2`, [
        appointmentId,
        ctx.tenantId,
      ])
    ).rows[0];
    if (existing) return { ro: existing, appointment: appt, created: false };

    if (!['requested', 'scheduled', 'confirmed'].includes(appt.status)) {
      throw new ConflictError(`Appointment cannot be checked in from status '${appt.status}'`, {
        code: 'invalid_appointment_status',
        details: { status: appt.status },
      });
    }

    const roId = generateId();
    const ro = (
      await tx.query(
        `INSERT INTO repair_orders (ro_id,tenant_id,location_id,appointment_id,mdm_customer_id,mdm_vehicle_id,status,odometer,created_by_user_id)
         VALUES ($1,$2,$3,$4,$5,$6,'checked_in',$7,$8) RETURNING *`,
        [roId, ctx.tenantId, appt.location_id, appointmentId, appt.mdm_customer_id, appt.mdm_vehicle_id, params.odometer ?? null, ctx.userId],
      )
    ).rows[0];

    await tx.query(
      `UPDATE service_appointments SET status='converted_to_ro', updated_at=NOW()
       WHERE appointment_id=$1 AND tenant_id=$2`,
      [appointmentId, ctx.tenantId],
    );

    await recordAppointmentEvent(tx, ctx, appointmentId, 'checked_in', { user_id: ctx.userId });
    await recordROEvent(tx, ctx, roId, 'created_from_appointment', { user_id: ctx.userId }, { appointment_id: appointmentId });
    await createServiceQueueItem(tx, ctx, {
      location_id: appt.location_id,
      queue_type: 'waiting_checkin',
      ro_id: roId,
    });

    return { ro, appointment: appt, created: true };
  });

  if (result.created) {
    svcROTotal.inc({ status: 'checked_in', location: result.appointment.location_id });
    await emitAudit(ctx, 'ro.created_from_appointment', 'repair_order', result.ro.ro_id, { appointment_id: appointmentId });
  }

  return { ...result.ro, appointment_id: appointmentId, idempotent_replay: !result.created };
}

/**
 * Pre-intake scratch pad: echoes back what the advisor scanned so the UI can start a
 * form. Persists nothing and creates no repair order — the durable record begins at
 * `checkIn`.
 */
export async function quickStartIntake(
  ctx: AuthContext,
  params: { location_id: string; scan_vin?: string; language_preference?: string },
): Promise<any> {
  requireUuid(params.location_id, 'location_id');
  const language = params.language_preference
    ? requireOneOf(params.language_preference, LANGUAGE_PREFERENCES, 'language_preference')
    : 'en';

  return {
    intake_session_ref: generateId(),
    persisted: false,
    tenant_id: ctx.tenantId,
    location_id: params.location_id,
    scan_vin: params.scan_vin ?? null,
    language_preference: language,
    mdm_match_preview: params.scan_vin ? { vin: params.scan_vin, status: 'lookup_required' } : null,
  };
}

// ============================================================
// 3) ROLS2 — Repair Order Lifecycle
// ============================================================

export async function createRO(
  ctx: AuthContext,
  params: {
    location_id: string;
    mdm_customer_id: string;
    mdm_vehicle_id: string;
    appointment_id?: string;
    odometer?: number;
    promised_time?: string;
    advisor_user_id?: string;
  },
): Promise<any> {
  requireUuid(params.location_id, 'location_id');
  requireUuid(params.mdm_customer_id, 'mdm_customer_id');
  requireUuid(params.mdm_vehicle_id, 'mdm_vehicle_id');
  if (params.appointment_id !== undefined) requireUuid(params.appointment_id, 'appointment_id');
  if (params.advisor_user_id !== undefined) requireUuid(params.advisor_user_id, 'advisor_user_id');

  const roId = generateId();
  const ro = await withTransaction(async (tx) => {
    // An appointment may only be attached if it is ours.
    if (params.appointment_id) {
      const appt = (
        await tx.query(`SELECT appointment_id FROM service_appointments WHERE appointment_id=$1 AND tenant_id=$2`, [
          params.appointment_id,
          ctx.tenantId,
        ])
      ).rows[0];
      if (!appt) throw new NotFoundError('Appointment not found');
    }

    const row = (
      await tx.query(
        `INSERT INTO repair_orders (ro_id,tenant_id,location_id,appointment_id,mdm_customer_id,mdm_vehicle_id,status,odometer,promised_time,advisor_user_id,created_by_user_id)
         VALUES ($1,$2,$3,$4,$5,$6,'draft',$7,$8,$9,$10) RETURNING *`,
        [
          roId, ctx.tenantId, params.location_id, params.appointment_id ?? null, params.mdm_customer_id,
          params.mdm_vehicle_id, params.odometer ?? null, params.promised_time ?? null,
          params.advisor_user_id ?? null, ctx.userId,
        ],
      )
    ).rows[0];

    await recordROEvent(tx, ctx, roId, 'created', { user_id: ctx.userId });
    return row;
  });

  svcROTotal.inc({ status: 'draft', location: params.location_id });
  await emitAudit(ctx, 'ro.created', 'repair_order', roId, {});
  return ro;
}

export async function getRO(ctx: AuthContext, roId: string): Promise<any> {
  const ro = await assertRO({ query }, ctx, roId);

  const [lineItems, events, estimates, auths, partsList, subletJobs, tickets] = await Promise.all([
    query(`SELECT * FROM ro_line_items WHERE ro_id=$1 AND tenant_id=$2 ORDER BY created_at`, [roId, ctx.tenantId]),
    query(`SELECT * FROM ro_events WHERE ro_id=$1 AND tenant_id=$2 ORDER BY occurred_at DESC LIMIT 30`, [roId, ctx.tenantId]),
    query(`SELECT * FROM ro_estimates WHERE ro_id=$1 AND tenant_id=$2 ORDER BY version DESC`, [roId, ctx.tenantId]),
    query(`SELECT * FROM ro_authorizations WHERE ro_id=$1 AND tenant_id=$2 ORDER BY created_at DESC`, [roId, ctx.tenantId]),
    query(`SELECT * FROM ro_parts_lines WHERE ro_id=$1 AND tenant_id=$2 ORDER BY status`, [roId, ctx.tenantId]),
    query(`SELECT * FROM ro_sublet_jobs WHERE ro_id=$1 AND tenant_id=$2 ORDER BY status`, [roId, ctx.tenantId]),
    query(`SELECT * FROM tech_work_tickets WHERE ro_id=$1 AND tenant_id=$2 ORDER BY created_at`, [roId, ctx.tenantId]),
  ]);

  return {
    ...ro,
    line_items: lineItems.rows,
    events: events.rows,
    estimates: estimates.rows,
    authorizations: auths.rows,
    parts_lines: partsList.rows,
    sublet_jobs: subletJobs.rows,
    work_tickets: tickets.rows,
  };
}

/**
 * Moves a repair order through its lifecycle.
 *
 * Runs entirely inside one transaction with the RO row locked, so the read that
 * validates the transition and the write that performs it cannot be interleaved by a
 * concurrent caller. The UPDATE additionally re-asserts the source status, so a lost
 * update surfaces as a conflict rather than silently overwriting.
 */
export async function transitionRO(
  ctx: AuthContext,
  roId: string,
  toStatus: string,
  params: { reason?: string; step_up_token?: unknown },
): Promise<any> {
  const outcome = await withTransaction(async (tx) => {
    const ro = await assertRO(tx, ctx, roId, { lock: true });

    if (!isTransitionAllowed(ro.status, toStatus)) {
      throw new UnprocessableError(`Cannot move a repair order from '${ro.status}' to '${toStatus}'`, {
        code: 'invalid_transition',
        details: { from: ro.status, to: toStatus, allowed: allowedTransitionsFrom(ro.status) },
      });
    }

    // Privileged transitions require a freshly re-authenticated actor, bound to this
    // exact user, tenant, action and repair order.
    if (transitionRequiresStepUp(toStatus)) {
      verifyStepUpToken(params.step_up_token, {
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        action: `ro.transition:${toStatus}`,
        resourceId: roId,
      });
    }

    if (transitionRequiresAuthorization(toStatus)) {
      // Evidence must be a real approval (at least one approved line) AND must belong
      // to the estimate currently in front of the customer — an approval of v1 does not
      // authorise the work priced in v3.
      const evidence = (
        await tx.query(
          `SELECT a.authorization_id
             FROM ro_authorizations a
            WHERE a.ro_id=$1 AND a.tenant_id=$2 AND a.status='approved'
              AND COALESCE(array_length(a.approved_items,1),0) > 0
              AND a.estimate_id = (
                    SELECT e.estimate_id FROM ro_estimates e
                     WHERE e.ro_id=$1 AND e.tenant_id=$2
                     ORDER BY e.version DESC LIMIT 1)
            LIMIT 1`,
          [roId, ctx.tenantId],
        )
      ).rows[0];

      if (!evidence) {
        throw new UnprocessableError('Customer authorization for the current estimate is required', {
          code: 'authorization_required',
          messageI18n: i18n(
            'Customer authorization for the current estimate is required',
            'Se requiere la autorización del cliente para el presupuesto actual',
          ),
        });
      }
    }

    const updated = (
      await tx.query(
        `UPDATE repair_orders SET status=$3, updated_at=NOW()
          WHERE ro_id=$1 AND tenant_id=$2 AND status=$4 RETURNING *`,
        [roId, ctx.tenantId, toStatus, ro.status],
      )
    ).rows[0];
    if (!updated) {
      throw new ConflictError('Repair order changed while the transition was being applied', {
        code: 'concurrent_modification',
      });
    }

    await recordROEvent(tx, ctx, roId, 'status_changed', { user_id: ctx.userId }, {
      from: ro.status,
      to: toStatus,
      reason: params.reason ?? null,
    });

    return { ro, updated };
  });

  if (toStatus === 'closed' && outcome.ro.created_at) {
    svcROCycleTime.observe(
      { location: outcome.ro.location_id },
      (Date.now() - new Date(outcome.ro.created_at).getTime()) / 60_000,
    );
  }
  await emitAudit(ctx, 'ro.transitioned', 'repair_order', roId, { from: outcome.ro.status, to: toStatus });

  return outcome.updated;
}

const LINE_TYPES = ['labor', 'parts', 'sublet', 'fee'] as const;
const LINE_AUTHORIZATION_STATUSES = ['not_required', 'pending', 'approved', 'declined'] as const;
const LINE_STATUSES = ['proposed', 'approved', 'declined', 'in_progress', 'completed', 'canceled'] as const;

export async function addLineItem(
  ctx: AuthContext,
  roId: string,
  params: {
    line_type: string;
    category?: string;
    description: string;
    labor_op_code?: string;
    estimated_hours?: number;
    authorization_status?: string;
  },
): Promise<any> {
  const lineType = requireOneOf(params.line_type, LINE_TYPES, 'line_type');
  if (typeof params.description !== 'string' || params.description.trim() === '') {
    throw new ValidationError('description is required');
  }
  if (params.estimated_hours !== undefined && (typeof params.estimated_hours !== 'number' || params.estimated_hours < 0)) {
    throw new ValidationError('estimated_hours must be a non-negative number');
  }
  const authStatus = params.authorization_status
    ? requireOneOf(params.authorization_status, LINE_AUTHORIZATION_STATUSES, 'authorization_status')
    : 'not_required';

  return withTransaction(async (tx) => {
    await assertRO(tx, ctx, roId);
    return (
      await tx.query(
        `INSERT INTO ro_line_items (line_item_id,tenant_id,ro_id,line_type,category,description,labor_op_code,estimated_hours,authorization_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [
          generateId(), ctx.tenantId, roId, lineType, params.category ?? null, params.description,
          params.labor_op_code ?? null, params.estimated_hours ?? null, authStatus,
        ],
      )
    ).rows[0];
  });
}

/**
 * Work-progress edits to a line item.
 *
 * `authorization_status` and `authorization_ref` are not settable here — they are
 * written only by `recordAuthorization`, from a real customer decision. Allowing them
 * to be PATCHed would let any caller mark work approved without evidence, which is
 * exactly what the repair-order authorization gate checks for.
 */
const LINE_ITEM_UPDATABLE = ['status', 'assigned_tech_user_id', 'sold_hours', 'price_ref'] as const;

export async function updateLineItem(
  ctx: AuthContext,
  roId: string,
  lineItemId: string,
  updates: Record<string, unknown>,
): Promise<any> {
  for (const forbidden of ['authorization_status', 'authorization_ref']) {
    if (forbidden in updates) {
      throw new ForbiddenError(`${forbidden} is set from a recorded customer authorization, not directly`, {
        code: 'authorization_fields_readonly',
      });
    }
  }
  if (updates.status !== undefined) requireOneOf(updates.status, LINE_STATUSES, 'status');
  if (updates.assigned_tech_user_id !== undefined && updates.assigned_tech_user_id !== null) {
    requireUuid(updates.assigned_tech_user_id, 'assigned_tech_user_id');
  }

  return withTransaction(async (tx) => {
    await assertRO(tx, ctx, roId);
    await assertLineItem(tx, ctx, roId, lineItemId);

    const sets: string[] = [];
    const vals: unknown[] = [lineItemId, roId, ctx.tenantId];
    for (const [k, v] of Object.entries(updates)) {
      if ((LINE_ITEM_UPDATABLE as readonly string[]).includes(k)) {
        vals.push(k === 'price_ref' ? JSON.stringify(v) : v);
        sets.push(`${k}=$${vals.length}`);
      }
    }
    if (sets.length === 0) throw new ValidationError('No updatable fields supplied');
    sets.push('updated_at=NOW()');

    return (
      await tx.query(
        `UPDATE ro_line_items SET ${sets.join(',')} WHERE line_item_id=$1 AND ro_id=$2 AND tenant_id=$3 RETURNING *`,
        vals,
      )
    ).rows[0];
  });
}

// ============================================================
// 4) DMRS2 — Digital MPI & Recommendations
// ============================================================

export async function listMPITemplates(ctx: AuthContext, locationId?: string): Promise<any[]> {
  if (locationId !== undefined) {
    requireUuid(locationId, 'location_id');
    return (
      await query(
        `SELECT * FROM mpi_templates
          WHERE tenant_id=$1 AND (location_id=$2 OR location_id IS NULL) AND status='active'`,
        [ctx.tenantId, locationId],
      )
    ).rows;
  }
  return (await query(`SELECT * FROM mpi_templates WHERE tenant_id=$1 AND status='active'`, [ctx.tenantId])).rows;
}

export async function startMPISession(
  ctx: AuthContext,
  roId: string,
  params: { template_id: string; tech_user_id: string },
): Promise<any> {
  requireUuid(params.template_id, 'template_id');
  requireUuid(params.tech_user_id, 'tech_user_id');

  return withTransaction(async (tx) => {
    await assertRO(tx, ctx, roId, { lock: true });

    const template = (
      await tx.query(`SELECT template_id FROM mpi_templates WHERE template_id=$1 AND tenant_id=$2 AND status='active'`, [
        params.template_id,
        ctx.tenantId,
      ])
    ).rows[0];
    if (!template) throw new NotFoundError('MPI template not found');

    const id = generateId();
    const session = (
      await tx.query(
        `INSERT INTO mpi_sessions (mpi_session_id,tenant_id,ro_id,template_id,tech_user_id)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [id, ctx.tenantId, roId, params.template_id, params.tech_user_id],
      )
    ).rows[0];

    await tx.query(
      `UPDATE repair_orders SET status='inspection_in_progress', updated_at=NOW()
        WHERE ro_id=$1 AND tenant_id=$2 AND status='checked_in'`,
      [roId, ctx.tenantId],
    );
    await recordROEvent(tx, ctx, roId, 'mpi_started', { tech_user_id: params.tech_user_id }, { mpi_session_id: id });
    return session;
  });
}

const MPI_RESULT_STATUSES = ['pass', 'attention', 'fail'] as const;
const MPI_SEVERITIES = ['info', 'maintenance', 'safety'] as const;

export async function recordMPIResult(
  ctx: AuthContext,
  mpiSessionId: string,
  params: { item_key: string; status: string; severity?: string; notes?: string; evidence_artifact_refs?: string[] },
): Promise<any> {
  requireUuid(mpiSessionId, 'mpi_session_id');
  const status = requireOneOf(params.status, MPI_RESULT_STATUSES, 'status');
  const severity = params.severity ? requireOneOf(params.severity, MPI_SEVERITIES, 'severity') : 'info';
  if (typeof params.item_key !== 'string' || params.item_key.trim() === '') {
    throw new ValidationError('item_key is required');
  }

  return withTransaction(async (tx) => {
    const session = (
      await tx.query(`SELECT * FROM mpi_sessions WHERE mpi_session_id=$1 AND tenant_id=$2 FOR UPDATE`, [
        mpiSessionId,
        ctx.tenantId,
      ])
    ).rows[0];
    if (!session) throw new NotFoundError('MPI session not found');
    if (!['started', 'in_progress'].includes(session.status)) {
      throw new ConflictError(`Results cannot be recorded on a '${session.status}' session`, {
        code: 'invalid_session_status',
      });
    }

    await tx.query(
      `UPDATE mpi_sessions SET status='in_progress', updated_at=NOW()
        WHERE mpi_session_id=$1 AND tenant_id=$2 AND status='started'`,
      [mpiSessionId, ctx.tenantId],
    );

    return (
      await tx.query(
        `INSERT INTO mpi_results (result_id,tenant_id,mpi_session_id,item_key,status,severity,notes,evidence_artifact_refs)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [generateId(), ctx.tenantId, mpiSessionId, params.item_key, status, severity, params.notes ?? null, params.evidence_artifact_refs ?? []],
      )
    ).rows[0];
  });
}

export async function submitMPISession(ctx: AuthContext, mpiSessionId: string): Promise<any> {
  requireUuid(mpiSessionId, 'mpi_session_id');

  return withTransaction(async (tx) => {
    const session = (
      await tx.query(`SELECT * FROM mpi_sessions WHERE mpi_session_id=$1 AND tenant_id=$2 FOR UPDATE`, [
        mpiSessionId,
        ctx.tenantId,
      ])
    ).rows[0];
    if (!session) throw new NotFoundError('MPI session not found');
    if (!['started', 'in_progress'].includes(session.status)) {
      throw new ConflictError(`Session is already '${session.status}'`, { code: 'invalid_session_status' });
    }

    const submitted = (
      await tx.query(
        `UPDATE mpi_sessions SET status='submitted', updated_at=NOW()
          WHERE mpi_session_id=$1 AND tenant_id=$2 RETURNING *`,
        [mpiSessionId, ctx.tenantId],
      )
    ).rows[0];

    const results = (
      await tx.query(
        `SELECT * FROM mpi_results WHERE mpi_session_id=$1 AND tenant_id=$2 AND status IN ('attention','fail')`,
        [mpiSessionId, ctx.tenantId],
      )
    ).rows;

    for (const r of results) {
      const priority = r.severity === 'safety' ? 'p0' : r.severity === 'maintenance' ? 'p1' : 'p2';
      await tx.query(
        `INSERT INTO service_recommendations (recommendation_id,tenant_id,ro_id,source,title_i18n,description_i18n,priority)
         VALUES ($1,$2,$3,'mpi',$4,$5,$6)`,
        [
          generateId(), ctx.tenantId, session.ro_id,
          JSON.stringify(i18n(`MPI: ${r.item_key} (${r.status})`, `IPM: ${r.item_key} (${r.status})`)),
          JSON.stringify(
            i18n(
              r.notes || `Inspection item ${r.item_key} needs ${r.status === 'fail' ? 'immediate ' : ''}attention`,
              r.notes || `El artículo ${r.item_key} necesita atención${r.status === 'fail' ? ' inmediata' : ''}`,
            ),
          ),
          priority,
        ],
      );
    }

    await recordROEvent(tx, ctx, session.ro_id, 'mpi_submitted', { user_id: ctx.userId }, {
      mpi_session_id: mpiSessionId,
      results_count: results.length,
    });

    return { ...submitted, recommendations_generated: results.length };
  });
}

/**
 * Publishes the inspection findings to the customer portal.
 *
 * The portal task is written to `service_portal_tasks`, which this module owns and
 * which keys on `ro_id`. (The original implementation wrote into the sales domain's
 * `deal_portal_tasks`, passing the repair-order id in the `deal_id` column.)
 */
export async function sendRecommendationsToCustomer(
  ctx: AuthContext,
  roId: string,
  params: { channel?: string; language?: string },
): Promise<any> {
  return withTransaction(async (tx) => {
    await assertRO(tx, ctx, roId);

    const recs = (
      await tx.query(
        `UPDATE service_recommendations SET status='sent_to_customer', updated_at=NOW()
          WHERE ro_id=$1 AND tenant_id=$2 AND status='proposed' RETURNING *`,
        [roId, ctx.tenantId],
      )
    ).rows;

    const taskId = generateId();
    await tx.query(
      `INSERT INTO service_portal_tasks (portal_task_id,tenant_id,ro_id,task_type,title_i18n,description_i18n,status)
       VALUES ($1,$2,$3,'review_recommendations',$4,$5,'created')`,
      [
        taskId, ctx.tenantId, roId,
        JSON.stringify(i18n('Review Inspection Results', 'Revisar Resultados de Inspección')),
        JSON.stringify(
          i18n(
            'Please review the inspection findings and approve recommended services.',
            'Por favor revise los hallazgos de la inspección y apruebe los servicios recomendados.',
          ),
        ),
      ],
    );

    await recordROEvent(tx, ctx, roId, 'recommendations_sent', { user_id: ctx.userId }, {
      portal_task_id: taskId,
      sent_count: recs.length,
      channel: params.channel ?? null,
    });

    return { sent_count: recs.length, portal_task_id: taskId };
  });
}

// ============================================================
// 5) EAS2 — Estimate & Authorization
// ============================================================

const LANGUAGE_MODES = ['en', 'es', 'bilingual', 'auto'] as const;

export async function generateEstimate(
  ctx: AuthContext,
  roId: string,
  params: { language_mode?: string },
): Promise<any> {
  const languageMode = params.language_mode
    ? requireOneOf(params.language_mode, LANGUAGE_MODES, 'language_mode')
    : 'auto';

  return withTransaction(async (tx) => {
    // Locking the RO serialises version assignment for this repair order; the unique
    // index on (ro_id, version) is the backstop.
    await assertRO(tx, ctx, roId, { lock: true });

    const lineItems = (
      await tx.query(
        `SELECT * FROM ro_line_items WHERE ro_id=$1 AND tenant_id=$2 AND status NOT IN ('canceled','declined')`,
        [roId, ctx.tenantId],
      )
    ).rows;
    if (lineItems.length === 0) {
      throw new ConflictError('Cannot generate an estimate with no active line items', { code: 'no_line_items' });
    }

    const maxVer = (
      await tx.query(`SELECT COALESCE(MAX(version),0)::int AS v FROM ro_estimates WHERE ro_id=$1 AND tenant_id=$2`, [
        roId,
        ctx.tenantId,
      ])
    ).rows[0].v;

    const estId = generateId();
    const totals = {
      line_count: lineItems.length,
      estimated_hours: lineItems.reduce((s: number, l: any) => s + Number(l.estimated_hours ?? 0), 0),
    };

    const est = (
      await tx.query(
        `INSERT INTO ro_estimates (estimate_id,tenant_id,ro_id,version,totals_ref,language_mode)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [estId, ctx.tenantId, roId, maxVer + 1, JSON.stringify(totals), languageMode],
      )
    ).rows[0];

    await tx.query(
      `UPDATE ro_line_items SET authorization_status='pending', updated_at=NOW()
        WHERE ro_id=$1 AND tenant_id=$2 AND authorization_status='not_required' AND status='proposed'`,
      [roId, ctx.tenantId],
    );
    await tx.query(
      `UPDATE repair_orders SET status='estimate_pending', updated_at=NOW()
        WHERE ro_id=$1 AND tenant_id=$2 AND status IN ('inspection_in_progress','checked_in')`,
      [roId, ctx.tenantId],
    );
    await recordROEvent(tx, ctx, roId, 'estimate_generated', { user_id: ctx.userId }, {
      estimate_id: estId,
      version: maxVer + 1,
    });

    return est;
  });
}

export async function sendEstimate(
  ctx: AuthContext,
  roId: string,
  estimateId: string,
  params: { channel?: string; language?: string },
): Promise<any> {
  requireUuid(estimateId, 'estimate_id');

  return withTransaction(async (tx) => {
    const ro = await assertRO(tx, ctx, roId, { lock: true });

    // The estimate must belong to THIS repair order; matching on estimate_id alone let
    // a mismatched pair advance an unrelated RO.
    const est = (
      await tx.query(`SELECT * FROM ro_estimates WHERE estimate_id=$1 AND ro_id=$2 AND tenant_id=$3 FOR UPDATE`, [
        estimateId,
        roId,
        ctx.tenantId,
      ])
    ).rows[0];
    if (!est) throw new NotFoundError('Estimate not found on this repair order', { code: 'estimate_not_found' });
    if (est.status !== 'draft') {
      throw new ConflictError(`Estimate is already '${est.status}'`, { code: 'estimate_not_draft' });
    }

    const sent = (
      await tx.query(
        `UPDATE ro_estimates SET status='sent', sent_at=NOW(), updated_at=NOW()
          WHERE estimate_id=$1 AND tenant_id=$2 RETURNING *`,
        [estimateId, ctx.tenantId],
      )
    ).rows[0];

    await tx.query(
      `UPDATE repair_orders SET status='awaiting_authorization', updated_at=NOW()
        WHERE ro_id=$1 AND tenant_id=$2 AND status='estimate_pending'`,
      [roId, ctx.tenantId],
    );
    await recordROEvent(tx, ctx, roId, 'estimate_sent', { user_id: ctx.userId }, {
      estimate_id: estimateId,
      channel: params.channel ?? null,
    });

    // Carries the real location so the item is visible in location-filtered queues.
    const queueItem = await createServiceQueueItem(tx, ctx, {
      location_id: ro.location_id,
      queue_type: 'waiting_authorization',
      ro_id: roId,
    });

    return { ...sent, queue_item_id: queueItem.queue_item_id };
  });
}

export async function listAuthorizations(ctx: AuthContext, roId: string): Promise<any[]> {
  await assertRO({ query }, ctx, roId);
  return (
    await query(`SELECT * FROM ro_authorizations WHERE ro_id=$1 AND tenant_id=$2 ORDER BY created_at DESC`, [
      roId,
      ctx.tenantId,
    ])
  ).rows;
}

/**
 * Records the customer's decision on an estimate.
 *
 * This row is the evidence the repair-order state machine gates on, so it is built
 * defensively:
 *  - the estimate must belong to this RO and be the one that was sent;
 *  - every approved/declined line id must belong to this RO (unknown ids are rejected,
 *    not skipped, so a caller cannot flip lines on someone else's repair order);
 *  - the record's status is DERIVED from the decision — an all-declined outcome is
 *    stored as `declined` and does not satisfy the authorization gate;
 *  - staff-asserted methods require step-up re-authentication.
 */
export async function recordAuthorization(
  ctx: AuthContext,
  roId: string,
  params: {
    estimate_id: string;
    method: string;
    approved_items: unknown;
    declined_items?: unknown;
    evidence_refs?: Record<string, unknown>;
    customer_language_used?: string;
    step_up_token?: unknown;
  },
): Promise<any> {
  requireUuid(params.estimate_id, 'estimate_id');
  if (!isAuthorizationMethod(params.method)) {
    throw new ValidationError('method must be one of: portal, signature, staff_attestation, recorded_call_ref');
  }
  if (!Array.isArray(params.approved_items)) throw new ValidationError('approved_items must be an array');
  if (params.declined_items !== undefined && !Array.isArray(params.declined_items)) {
    throw new ValidationError('declined_items must be an array');
  }

  const approved = distinct(params.approved_items as string[]);
  const declined = distinct((params.declined_items ?? []) as string[]);
  if (approved.length === 0 && declined.length === 0) {
    throw new ValidationError('A decision must approve or decline at least one line item');
  }
  const overlap = approved.filter((id) => declined.includes(id));
  if (overlap.length > 0) {
    throw new ValidationError('A line item cannot be both approved and declined', {
      code: 'contradictory_decision',
      details: { line_item_ids: overlap },
    });
  }

  if (methodRequiresStepUp(params.method)) {
    verifyStepUpToken(params.step_up_token, {
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      action: `authorization.record:${params.method}`,
      resourceId: roId,
    });
  }

  const language = params.customer_language_used
    ? requireOneOf(params.customer_language_used, ['en', 'es'] as const, 'customer_language_used')
    : 'en';

  const outcome = await withTransaction(async (tx) => {
    await assertRO(tx, ctx, roId, { lock: true });

    const estimate = (
      await tx.query(`SELECT * FROM ro_estimates WHERE estimate_id=$1 AND ro_id=$2 AND tenant_id=$3 FOR UPDATE`, [
        params.estimate_id,
        roId,
        ctx.tenantId,
      ])
    ).rows[0];
    if (!estimate) throw new NotFoundError('Estimate not found on this repair order', { code: 'estimate_not_found' });
    if (estimate.status !== 'sent') {
      throw new ConflictError(`Estimate is '${estimate.status}'; only a sent estimate can be decided`, {
        code: 'estimate_not_sent',
      });
    }

    await assertLineItemsOnRO(tx, ctx, roId, [...approved, ...declined]);

    const pendingCount = Number(
      (
        await tx.query(
          `SELECT COUNT(*)::int AS cnt FROM ro_line_items
            WHERE ro_id=$1 AND tenant_id=$2 AND authorization_status='pending'`,
          [roId, ctx.tenantId],
        )
      ).rows[0].cnt,
    );

    const authStatus = deriveAuthorizationStatus(approved, declined);
    const authId = generateId();
    const auth = (
      await tx.query(
        `INSERT INTO ro_authorizations (authorization_id,tenant_id,ro_id,estimate_id,method,status,
           approved_items,declined_items,evidence_refs,customer_language_used,authorized_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW()) RETURNING *`,
        [
          authId, ctx.tenantId, roId, params.estimate_id, params.method, authStatus,
          approved, declined, JSON.stringify(params.evidence_refs ?? {}), language,
        ],
      )
    ).rows[0];

    if (approved.length > 0) {
      await tx.query(
        `UPDATE ro_line_items SET authorization_status='approved', authorization_ref=$2, updated_at=NOW()
          WHERE line_item_id = ANY($1) AND ro_id=$3 AND tenant_id=$4`,
        [approved, authId, roId, ctx.tenantId],
      );
    }
    if (declined.length > 0) {
      await tx.query(
        `UPDATE ro_line_items SET authorization_status='declined', status='declined', authorization_ref=$2, updated_at=NOW()
          WHERE line_item_id = ANY($1) AND ro_id=$3 AND tenant_id=$4`,
        [declined, authId, roId, ctx.tenantId],
      );
    }

    await tx.query(
      `UPDATE ro_estimates SET status=$3, updated_at=NOW() WHERE estimate_id=$1 AND tenant_id=$2`,
      [params.estimate_id, ctx.tenantId, deriveEstimateStatus(approved.length, declined.length, pendingCount)],
    );

    await recordROEvent(tx, ctx, roId, 'authorization_received', { user_id: ctx.userId }, {
      authorization_id: authId,
      method: params.method,
      status: authStatus,
      approved: approved.length,
      declined: declined.length,
    });

    return { auth, estimate };
  });

  if (outcome.estimate.sent_at) {
    const ro = (await query(`SELECT location_id FROM repair_orders WHERE ro_id=$1 AND tenant_id=$2`, [roId, ctx.tenantId])).rows[0];
    svcApprovalTime.observe(
      { location: ro?.location_id ?? 'unknown' },
      (Date.now() - new Date(outcome.estimate.sent_at).getTime()) / 60_000,
    );
  }
  await emitAudit(ctx, 'authorization.recorded', 'ro_authorization', outcome.auth.authorization_id, {
    ro_id: roId,
    method: params.method,
    status: outcome.auth.status,
  });

  return outcome.auth;
}

// ============================================================
// 6) POS2 — Parts Operations
// ============================================================

const PART_STATUSES = ['requested', 'ordered', 'backordered', 'received', 'picked', 'installed', 'canceled'] as const;

export async function requestPart(
  ctx: AuthContext,
  roId: string,
  params: { line_item_id: string; part_number: string; description: string; quantity?: number },
): Promise<any> {
  if (typeof params.part_number !== 'string' || params.part_number.trim() === '') {
    throw new ValidationError('part_number is required');
  }
  if (typeof params.description !== 'string' || params.description.trim() === '') {
    throw new ValidationError('description is required');
  }
  const quantity = params.quantity ?? 1;
  if (typeof quantity !== 'number' || quantity <= 0) throw new ValidationError('quantity must be greater than zero');

  return withTransaction(async (tx) => {
    await assertRO(tx, ctx, roId);
    await assertLineItem(tx, ctx, roId, params.line_item_id);

    return (
      await tx.query(
        `INSERT INTO ro_parts_lines (part_line_id,tenant_id,ro_id,line_item_id,part_number,description,quantity)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [generateId(), ctx.tenantId, roId, params.line_item_id, params.part_number, params.description, quantity],
      )
    ).rows[0];
  });
}

export async function updatePartLine(
  ctx: AuthContext,
  partLineId: string,
  updates: { status?: string; eta?: string; supplier_ref?: unknown },
): Promise<any> {
  requireUuid(partLineId, 'part_line_id');

  const sets: string[] = [];
  const vals: unknown[] = [partLineId, ctx.tenantId];
  if (updates.status !== undefined) {
    vals.push(requireOneOf(updates.status, PART_STATUSES, 'status'));
    sets.push(`status=$${vals.length}`);
  }
  if (updates.eta !== undefined) {
    if (Number.isNaN(Date.parse(updates.eta))) throw new ValidationError('eta must be a timestamp');
    vals.push(updates.eta);
    sets.push(`eta=$${vals.length}`);
  }
  if (updates.supplier_ref !== undefined) {
    vals.push(JSON.stringify(updates.supplier_ref));
    sets.push(`supplier_ref=$${vals.length}`);
  }
  if (sets.length === 0) throw new ValidationError('No updatable fields supplied');
  sets.push('updated_at=NOW()');

  const row = (
    await query(`UPDATE ro_parts_lines SET ${sets.join(',')} WHERE part_line_id=$1 AND tenant_id=$2 RETURNING *`, vals)
  ).rows[0];
  if (!row) throw new NotFoundError('Part line not found');
  return row;
}

// ============================================================
// 7) SOS2 — Sublet Operations
// ============================================================

const SUBLET_STATUSES = ['requested', 'sent', 'in_progress', 'returned', 'verified', 'canceled'] as const;

export async function createSubletJob(
  ctx: AuthContext,
  roId: string,
  params: { line_item_id: string; vendor_ref: unknown; expected_return_at?: string },
): Promise<any> {
  if (!params.vendor_ref || typeof params.vendor_ref !== 'object') {
    throw new ValidationError('vendor_ref must be an object');
  }
  if (params.expected_return_at !== undefined && Number.isNaN(Date.parse(params.expected_return_at))) {
    throw new ValidationError('expected_return_at must be a timestamp');
  }

  return withTransaction(async (tx) => {
    await assertRO(tx, ctx, roId);
    await assertLineItem(tx, ctx, roId, params.line_item_id);

    return (
      await tx.query(
        `INSERT INTO ro_sublet_jobs (sublet_job_id,tenant_id,ro_id,line_item_id,vendor_ref,expected_return_at)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [generateId(), ctx.tenantId, roId, params.line_item_id, JSON.stringify(params.vendor_ref), params.expected_return_at ?? null],
      )
    ).rows[0];
  });
}

export async function updateSubletJob(
  ctx: AuthContext,
  subletJobId: string,
  updates: { status?: string; invoice_artifact_ref?: string },
): Promise<any> {
  requireUuid(subletJobId, 'sublet_job_id');

  const sets: string[] = [];
  const vals: unknown[] = [subletJobId, ctx.tenantId];
  if (updates.status !== undefined) {
    vals.push(requireOneOf(updates.status, SUBLET_STATUSES, 'status'));
    sets.push(`status=$${vals.length}`);
  }
  if (updates.invoice_artifact_ref !== undefined) {
    vals.push(updates.invoice_artifact_ref);
    sets.push(`invoice_artifact_ref=$${vals.length}`);
  }
  if (sets.length === 0) throw new ValidationError('No updatable fields supplied');
  sets.push('updated_at=NOW()');

  const row = (
    await query(`UPDATE ro_sublet_jobs SET ${sets.join(',')} WHERE sublet_job_id=$1 AND tenant_id=$2 RETURNING *`, vals)
  ).rows[0];
  if (!row) throw new NotFoundError('Sublet job not found');
  return row;
}

// ============================================================
// 8) TDTS2 — Technician Dispatch & Time
// ============================================================

const TICKET_STATUSES = ['assigned', 'started', 'paused', 'completed', 'reassigned', 'canceled'] as const;
const TIME_EVENT_TYPES = ['start', 'pause', 'resume', 'stop'] as const;

export async function dispatchTech(
  ctx: AuthContext,
  params: { ro_id: string; line_item_id: string; tech_user_id: string },
): Promise<any> {
  requireUuid(params.tech_user_id, 'tech_user_id');

  return withTransaction(async (tx) => {
    await assertRO(tx, ctx, params.ro_id);
    await assertLineItem(tx, ctx, params.ro_id, params.line_item_id);

    const ticket = (
      await tx.query(
        `INSERT INTO tech_work_tickets (ticket_id,tenant_id,ro_id,line_item_id,assigned_tech_user_id)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [generateId(), ctx.tenantId, params.ro_id, params.line_item_id, params.tech_user_id],
      )
    ).rows[0];

    await tx.query(
      `UPDATE ro_line_items SET assigned_tech_user_id=$3, updated_at=NOW()
        WHERE line_item_id=$1 AND tenant_id=$2`,
      [params.line_item_id, ctx.tenantId, params.tech_user_id],
    );
    return ticket;
  });
}

/** Loads a work ticket the caller is allowed to act on: their own, or any if they supervise. */
async function assertOwnTicket(ex: Executor, ctx: AuthContext, ticketId: string): Promise<any> {
  requireUuid(ticketId, 'ticket_id');
  const ticket = (
    await ex.query(`SELECT * FROM tech_work_tickets WHERE ticket_id=$1 AND tenant_id=$2`, [ticketId, ctx.tenantId])
  ).rows[0];
  if (!ticket) throw new NotFoundError('Work ticket not found');

  const supervises = hasAnyRole(ctx, ROLES.SERVICE_MANAGER, ROLES.SERVICE_ADVISOR);
  if (!supervises && ticket.assigned_tech_user_id !== ctx.userId) {
    throw new ForbiddenError('This work ticket is assigned to another technician', {
      code: 'not_ticket_assignee',
    });
  }
  return ticket;
}

export async function updateTicketStatus(
  ctx: AuthContext,
  ticketId: string,
  params: { status: string; pause_reason?: string },
): Promise<any> {
  const status = requireOneOf(params.status, TICKET_STATUSES, 'status');

  return withTransaction(async (tx) => {
    await assertOwnTicket(tx, ctx, ticketId);

    // pause_reason is only rewritten when the caller supplies one, or when the ticket
    // leaves the paused state; a plain status bump no longer erases it.
    const clearsReason = status !== 'paused';
    const sets = ['status=$3', 'updated_at=NOW()'];
    const vals: unknown[] = [ticketId, ctx.tenantId, status];
    if (params.pause_reason !== undefined) {
      vals.push(params.pause_reason);
      sets.push(`pause_reason=$${vals.length}`);
    } else if (clearsReason) {
      sets.push('pause_reason=NULL');
    }

    return (
      await tx.query(`UPDATE tech_work_tickets SET ${sets.join(',')} WHERE ticket_id=$1 AND tenant_id=$2 RETURNING *`, vals)
    ).rows[0];
  });
}

export async function recordTimeEntry(
  ctx: AuthContext,
  ticketId: string,
  params: { event_type: string; occurred_at?: string },
): Promise<any> {
  const eventType = requireOneOf(params.event_type, TIME_EVENT_TYPES, 'event_type');

  let occurredAt = new Date();
  if (params.occurred_at !== undefined) {
    const parsed = Date.parse(params.occurred_at);
    if (Number.isNaN(parsed)) throw new ValidationError('occurred_at must be a timestamp');
    // Offline capture may back-date, but nobody clocks time in the future.
    if (parsed > Date.now() + 60_000) throw new ValidationError('occurred_at cannot be in the future');
    occurredAt = new Date(parsed);
  }

  return withTransaction(async (tx) => {
    const ticket = await assertOwnTicket(tx, ctx, ticketId);

    return (
      await tx.query(
        `INSERT INTO tech_time_entries (time_entry_id,tenant_id,ticket_id,tech_user_id,event_type,occurred_at)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [generateId(), ctx.tenantId, ticketId, ticket.assigned_tech_user_id, eventType, occurredAt.toISOString()],
      )
    ).rows[0];
  });
}

// ============================================================
// 9) WPCS2 — Warranty Claims
// ============================================================

export async function createWarrantyClaim(
  ctx: AuthContext,
  params: { ro_id: string; evidence_refs?: Record<string, unknown>; provider_ref?: Record<string, unknown> },
): Promise<any> {
  return withTransaction(async (tx) => {
    await assertRO(tx, ctx, params.ro_id);
    return (
      await tx.query(
        `INSERT INTO warranty_claims (claim_id,tenant_id,ro_id,evidence_refs,provider_ref)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [
          generateId(), ctx.tenantId, params.ro_id,
          JSON.stringify(params.evidence_refs ?? {}),
          params.provider_ref ? JSON.stringify(params.provider_ref) : null,
        ],
      )
    ).rows[0];
  });
}

// ============================================================
// 10) QCS2 — Quality & Comebacks
// ============================================================

const COMEBACK_SEVERITIES = ['sev0', 'sev1', 'sev2', 'sev3'] as const;
const COMEBACK_STATUSES = ['open', 'in_progress', 'resolved', 'canceled'] as const;

export async function createComebackCase(
  ctx: AuthContext,
  params: {
    original_ro_id: string;
    new_ro_id: string;
    root_cause_category: string;
    reason_codes: string[];
    severity?: string;
  },
): Promise<any> {
  if (params.original_ro_id === params.new_ro_id) {
    throw new ValidationError('A comeback must reference two different repair orders');
  }
  if (typeof params.root_cause_category !== 'string' || params.root_cause_category.trim() === '') {
    throw new ValidationError('root_cause_category is required');
  }
  const severity = params.severity ? requireOneOf(params.severity, COMEBACK_SEVERITIES, 'severity') : 'sev2';

  const comeback = await withTransaction(async (tx) => {
    const original = await assertRO(tx, ctx, params.original_ro_id, { lock: true });
    await assertRO(tx, ctx, params.new_ro_id);

    if (original.status !== 'closed') {
      throw new ConflictError(`The original repair order is '${original.status}'; only a closed RO can come back`, {
        code: 'original_ro_not_closed',
      });
    }

    const cb = (
      await tx.query(
        `INSERT INTO comeback_cases (comeback_id,tenant_id,original_ro_id,new_ro_id,root_cause_category,reason_codes,severity)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [
          generateId(), ctx.tenantId, params.original_ro_id, params.new_ro_id,
          params.root_cause_category, params.reason_codes ?? [], severity,
        ],
      )
    ).rows[0];

    await tx.query(
      `UPDATE repair_orders SET status='comeback', updated_at=NOW()
        WHERE ro_id=$1 AND tenant_id=$2 AND status='closed'`,
      [params.original_ro_id, ctx.tenantId],
    );

    await recordROEvent(tx, ctx, params.original_ro_id, 'comeback_opened', { user_id: ctx.userId }, {
      comeback_id: cb.comeback_id,
      new_ro_id: params.new_ro_id,
    });
    await recordROEvent(tx, ctx, params.new_ro_id, 'comeback_linked', { user_id: ctx.userId }, {
      comeback_id: cb.comeback_id,
      original_ro_id: params.original_ro_id,
    });

    return cb;
  });

  await emitAudit(ctx, 'comeback.created', 'comeback_case', comeback.comeback_id, {
    original_ro_id: params.original_ro_id,
    new_ro_id: params.new_ro_id,
  });
  return comeback;
}

export async function updateComebackCase(ctx: AuthContext, comebackId: string, updates: { status?: string }): Promise<any> {
  requireUuid(comebackId, 'comeback_id');
  const status = requireOneOf(updates.status, COMEBACK_STATUSES, 'status');

  const row = (
    await query(
      `UPDATE comeback_cases SET status=$3, updated_at=NOW() WHERE comeback_id=$1 AND tenant_id=$2 RETURNING *`,
      [comebackId, ctx.tenantId, status],
    )
  ).rows[0];
  if (!row) throw new NotFoundError('Comeback case not found');
  return row;
}

// ============================================================
// 11) SSR2 — Service SLA & Queue Management
// ============================================================

const QUEUE_PRIORITIES = ['p0', 'p1', 'p2'] as const;
const QUEUE_STATUSES = ['queued', 'in_progress', 'blocked', 'done', 'canceled'] as const;

/**
 * Internal: creates a queue item on the caller's executor so it joins the surrounding
 * transaction. Not exposed as an endpoint — queue items are produced by the lifecycle
 * flows that need them.
 */
export async function createServiceQueueItem(
  ex: Executor,
  ctx: AuthContext,
  params: {
    location_id: string;
    queue_type: string;
    ro_id?: string;
    appointment_id?: string;
    priority?: string;
    sla_due_at?: string;
  },
): Promise<any> {
  requireUuid(params.location_id, 'location_id');
  const priority = params.priority ? requireOneOf(params.priority, QUEUE_PRIORITIES, 'priority') : 'p1';

  return (
    await ex.query(
      `INSERT INTO service_queue_items (queue_item_id,tenant_id,location_id,queue_type,ro_id,appointment_id,priority,sla_due_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [
        generateId(), ctx.tenantId, params.location_id, params.queue_type,
        params.ro_id ?? null, params.appointment_id ?? null, priority, params.sla_due_at ?? null,
      ],
    )
  ).rows[0];
}

export async function listServiceQueueItems(
  ctx: AuthContext,
  filters: { location_id?: string; queue_type?: string; status?: string },
): Promise<any[]> {
  const conds = ['qi.tenant_id=$1'];
  const vals: unknown[] = [ctx.tenantId];

  if (filters.location_id) {
    vals.push(requireUuid(filters.location_id, 'location_id'));
    conds.push(`qi.location_id=$${vals.length}`);
  }
  if (filters.queue_type) {
    vals.push(filters.queue_type);
    conds.push(`qi.queue_type=$${vals.length}`);
  }
  if (filters.status) {
    vals.push(requireOneOf(filters.status, QUEUE_STATUSES, 'status'));
    conds.push(`qi.status=$${vals.length}`);
  } else {
    conds.push(`qi.status NOT IN ('done','canceled')`);
  }

  const rows = (
    await query(
      `SELECT qi.*, ro.status AS ro_status, ro.mdm_customer_id, ro.mdm_vehicle_id, ro.promised_time
         FROM service_queue_items qi
         LEFT JOIN repair_orders ro ON qi.ro_id = ro.ro_id AND ro.tenant_id = qi.tenant_id
        WHERE ${conds.join(' AND ')}
        ORDER BY qi.priority, qi.sla_due_at NULLS LAST LIMIT 200`,
      vals,
    )
  ).rows;

  if (filters.queue_type) {
    // Counted separately: the page above is capped at 200, so its length is not the
    // queue depth.
    const depth = (
      await query(
        `SELECT COUNT(*)::int AS cnt FROM service_queue_items
          WHERE tenant_id=$1 AND queue_type=$2 AND status NOT IN ('done','canceled')
            ${filters.location_id ? 'AND location_id=$3' : ''}`,
        filters.location_id ? [ctx.tenantId, filters.queue_type, filters.location_id] : [ctx.tenantId, filters.queue_type],
      )
    ).rows[0];
    svcQueueDepth.set({ queue_type: filters.queue_type, location: filters.location_id ?? 'all' }, Number(depth.cnt));
  }

  return rows;
}

export async function assignServiceQueueItem(ctx: AuthContext, queueItemId: string): Promise<any> {
  requireUuid(queueItemId, 'queue_item_id');
  const row = (
    await query(
      `UPDATE service_queue_items SET assigned_to_user_id=$3, status='in_progress', updated_at=NOW()
        WHERE queue_item_id=$1 AND tenant_id=$2 RETURNING *`,
      [queueItemId, ctx.tenantId, ctx.userId],
    )
  ).rows[0];
  if (!row) throw new NotFoundError('Queue item not found');
  return row;
}

export async function updateServiceQueueItemStatus(
  ctx: AuthContext,
  queueItemId: string,
  params: { status: string; block_reason_codes?: string[] },
): Promise<any> {
  requireUuid(queueItemId, 'queue_item_id');
  const status = requireOneOf(params.status, QUEUE_STATUSES, 'status');

  // Block reasons are only rewritten when supplied, or cleared when the item unblocks.
  const sets = ['status=$3', 'updated_at=NOW()'];
  const vals: unknown[] = [queueItemId, ctx.tenantId, status];
  if (params.block_reason_codes !== undefined) {
    vals.push(params.block_reason_codes);
    sets.push(`block_reason_codes=$${vals.length}`);
  } else if (status !== 'blocked') {
    sets.push('block_reason_codes=NULL');
  }

  const row = (
    await query(`UPDATE service_queue_items SET ${sets.join(',')} WHERE queue_item_id=$1 AND tenant_id=$2 RETURNING *`, vals)
  ).rows[0];
  if (!row) throw new NotFoundError('Queue item not found');
  return row;
}

export async function escalateServiceQueueItem(
  ctx: AuthContext,
  queueItemId: string,
  params: { reason: string; create_runbook?: boolean },
): Promise<any> {
  requireUuid(queueItemId, 'queue_item_id');
  if (typeof params.reason !== 'string' || params.reason.trim() === '') {
    throw new ValidationError('reason is required');
  }
  // Runbook creation is not implemented; accepting the flag and reporting success would
  // tell an operator a runbook exists when none does.
  if (params.create_runbook) {
    throw new ValidationError('Runbook creation is not available in this build', { code: 'runbook_unsupported' });
  }

  const row = (
    await query(
      `UPDATE service_queue_items SET priority='p0', updated_at=NOW()
        WHERE queue_item_id=$1 AND tenant_id=$2 RETURNING *`,
      [queueItemId, ctx.tenantId],
    )
  ).rows[0];
  if (!row) throw new NotFoundError('Queue item not found');

  await emitAudit(ctx, 'queue_item.escalated', 'service_queue_item', queueItemId, { reason: params.reason });
  return { ...row, escalated: true, runbook_created: false };
}

// ============================================================
// 12) CSPP2 — Customer Service Portal Packager
//
// Portal tasks are written by the flows that create customer-facing work (currently
// `sendRecommendationsToCustomer`). A standalone packager API is outstanding work.
// ============================================================

// ============================================================
// 13) PSFSRB2 — Post-Sale First Service Retention Bridge
// ============================================================

export async function createFirstServiceOffer(
  ctx: AuthContext,
  params: {
    location_id: string;
    mdm_customer_id: string;
    mdm_vehicle_id: string;
    deal_id: string;
    recommended_window_start: string;
    language_preference?: string;
  },
): Promise<any> {
  requireUuid(params.deal_id, 'deal_id');

  const appt = await createAppointment(ctx, {
    location_id: params.location_id,
    mdm_customer_id: params.mdm_customer_id,
    mdm_vehicle_id: params.mdm_vehicle_id,
    scheduled_start: params.recommended_window_start,
    source: 'sales_handoff',
    language_preference: params.language_preference ?? 'en',
    concerns: [
      {
        category: 'first_service',
        description: 'New vehicle first service',
        priority: 'p2',
        // Persisted so a converted appointment can be attributed back to the deal.
        deal_id: params.deal_id,
      },
    ],
  });

  return { appointment_id: appt.appointment_id, deal_id: params.deal_id, status: 'offer_created' };
}
