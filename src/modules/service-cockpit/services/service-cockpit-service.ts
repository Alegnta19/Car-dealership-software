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
import { consumeStepUpToken } from '../../../shared/security/step-up';
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
const svcMPIConversionRate = new promClient.Gauge({ name: 'service_mpi_conversion_rate', help: 'MPI conversion rate', labelNames: ['recommendation_type', 'location'] });
const svcFirstServiceCaptureRate = new promClient.Gauge({ name: 'service_retention_first_service_capture_rate', help: 'First service capture rate', labelNames: ['location'] });

/**
 * The 11 metrics that are rates, ratios or depths rather than per-request events.
 * `metrics-aggregator.ts` recomputes them on a schedule; nothing in the request path
 * touches them.
 *
 * That split is deliberate. A gauge nudged by whichever request happened to arrive is
 * last-writer-wins, and none of these series carries a tenant label — `/metrics` is a
 * shared, unauthenticated scrape target, so one tenant's number would overwrite
 * another's, and adding a tenant label would publish a tenant roster instead.
 */
export const aggregatedMetrics = {
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
  svcQueueDepth,
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

/**
 * Guards the `TEXT[]` columns. Postgres rejects a bare string or object with
 * "malformed array literal", which would otherwise surface as a 500 rather than a 400.
 */
function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new ValidationError(`${field} must be an array of strings`);
  }
  return value as string[];
}

/** Validates an optional timestamp, rejecting nulls and unparseable values alike. */
function requireTimestamp(value: unknown, field: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new ValidationError(`${field} must be a timestamp`);
  }
  return value;
}

function hasAnyRole(ctx: AuthContext, ...roles: Role[]): boolean {
  return ctx.roles.includes(ROLES.ADMIN) || ctx.roles.some((r) => roles.includes(r));
}

export interface Page {
  limit: number;
  offset: number;
}

/**
 * Validates caller-supplied paging. `limit` is capped so a client cannot ask for an
 * unbounded result set, which is what the previously hardcoded limits were protecting
 * against — at the cost of making anything past the first page unreachable.
 */
function pagination(input: { limit?: unknown; offset?: unknown } | undefined, defaultLimit: number, maxLimit: number): Page {
  const parse = (value: unknown, field: string): number | undefined => {
    if (value === undefined || value === null || value === '') return undefined;
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isInteger(n) || n < 0) throw new ValidationError(`${field} must be a non-negative integer`);
    return n;
  };

  const limit = parse(input?.limit, 'limit');
  const offset = parse(input?.offset, 'offset');
  if (limit === 0) throw new ValidationError('limit must be greater than zero');
  // Bounded well inside bigint: an offset past this overflows in Postgres and 500s.
  if (offset !== undefined && offset > 1_000_000) throw new ValidationError('offset must not exceed 1000000');

  return { limit: Math.min(limit ?? defaultLimit, maxLimit), offset: offset ?? 0 };
}

/**
 * The `concerns` contract: a JSON array, which is what the column defaults to and what
 * every reader assumes. `updateAppointment` has always enforced this; both creation paths
 * did not, so an appointment could be born holding a bare string or number that no
 * consumer could iterate.
 */
function requireConcerns(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ValidationError('concerns must be an array');
  return value;
}

/**
 * The `price_ref` contract, enforced at the only ingress that accepts it.
 *
 * `price_ref` is an untyped JSONB blob, but two things downstream do read inside it: the
 * money summary and the SQL billing gate that decides whether a vehicle may be handed
 * back. Accepting `{ amount_cents: "abc" }` used to store a value the gate could not cast,
 * and because that gate runs on every delivery attempt the repair order was then wedged at
 * HTTP 500 with no way out through the API. The gate is now cast-safe as well — this check
 * is what stops such a row from being created in the first place.
 */
function validatePriceRef(value: unknown): void {
  if (value === undefined || value === null) return;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError('price_ref must be an object');
  }
  const price = value as Record<string, unknown>;
  const amount = price.amount_cents;
  if (amount !== undefined && amount !== null) {
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
      throw new ValidationError('price_ref.amount_cents must be a non-negative finite number');
    }
  }
  if (price.currency !== undefined && price.currency !== null && typeof price.currency !== 'string') {
    throw new ValidationError('price_ref.currency must be a string');
  }
}

/**
 * Sums line-item money when it is present.
 *
 * `price_ref` is an untyped JSONB blob inherited from the original schema. Where it
 * follows the `{ amount_cents, currency }` shape the totals include it; otherwise the
 * line is reported as unpriced rather than silently counted as zero, so a caller can
 * always tell whether a total is complete.
 */
function summariseMoney(rows: any[]): {
  currency: string | null;
  amount_cents: number | null;
  priced_line_count: number;
  unpriced_line_count: number;
} {
  let total = 0;
  let currency: string | null = null;
  let priced = 0;
  let unpriced = 0;

  for (const row of rows) {
    const price = row.price_ref;
    // `typeof number` specifically: Number(null)/Number(true)/Number([]) are all finite,
    // so a line whose amount_cents is null, a boolean, or an empty array would otherwise
    // count as a priced line worth zero and silently understate the estimate.
    const raw = price && typeof price === 'object' && !Array.isArray(price) ? (price as any).amount_cents : undefined;
    const amount = typeof raw === 'number' ? raw : NaN;
    if (!Number.isFinite(amount) || amount < 0) {
      unpriced += 1;
      continue;
    }
    const rowCurrency = typeof (price as any).currency === 'string' ? (price as any).currency : 'USD';
    if (currency === null) currency = rowCurrency;
    else if (currency !== rowCurrency) {
      throw new ValidationError('Line items on one estimate must share a currency', {
        code: 'mixed_currency',
        details: { found: [currency, rowCurrency] },
      });
    }
    total += amount;
    priced += 1;
  }

  return {
    currency: priced > 0 ? currency : null,
    amount_cents: priced > 0 ? total : null,
    priced_line_count: priced,
    unpriced_line_count: unpriced,
  };
}

/**
 * The work queue a repair order belongs in while it sits in a given status. Statuses
 * absent from this map (`draft`, `authorized`, `sublet_in_progress`, `closed`,
 * `canceled`) put the RO in no queue at all.
 */
const RO_STATUS_QUEUE: Record<string, string> = {
  checked_in: 'waiting_checkin',
  inspection_in_progress: 'in_repair',
  estimate_pending: 'waiting_authorization',
  awaiting_authorization: 'waiting_authorization',
  authorized: 'in_repair',
  in_repair: 'in_repair',
  waiting_parts: 'waiting_parts',
  sublet_in_progress: 'in_repair',
  qc: 'qc',
  ready_for_pickup: 'ready_pickup',
  comeback: 'comeback_review',
};

/**
 * Brings the repair order's queue presence in line with its status: closes items for
 * work it has moved past, and opens one for where it now sits.
 *
 * Without this the cockpit only ever accumulated queue items — nothing marked them
 * done, so every dashboard count drifted upward for the life of the tenant. Runs on
 * the caller's executor so queue state commits with the status change that caused it.
 */
async function syncQueueForRO(ex: Executor, ctx: AuthContext, ro: any): Promise<void> {
  const target = RO_STATUS_QUEUE[ro.status];

  await ex.query(
    `UPDATE service_queue_items SET status='done', updated_at=NOW()
      WHERE ro_id=$1 AND tenant_id=$2 AND status NOT IN ('done','canceled')
        AND ($3::text IS NULL OR queue_type <> $3)`,
    [ro.ro_id, ctx.tenantId, target ?? null],
  );

  if (!target) return;

  const open = (
    await ex.query(
      `SELECT queue_item_id FROM service_queue_items
        WHERE ro_id=$1 AND tenant_id=$2 AND queue_type=$3 AND status NOT IN ('done','canceled')
        LIMIT 1`,
      [ro.ro_id, ctx.tenantId, target],
    )
  ).rows[0];
  if (open) return;

  await createServiceQueueItem(ex, ctx, {
    location_id: ro.location_id,
    queue_type: target,
    ro_id: ro.ro_id,
  });
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

/**
 * Loads a line item proven to belong to both the caller's tenant and the given RO.
 * `lock: true` takes `FOR UPDATE`, which any read-validate-write on the line needs.
 */
async function assertLineItem(
  ex: Executor,
  ctx: AuthContext,
  roId: string,
  lineItemId: string,
  opts: { lock?: boolean } = {},
): Promise<any> {
  requireUuid(lineItemId, 'line_item_id');
  const item = (
    await ex.query(
      `SELECT * FROM ro_line_items WHERE line_item_id=$1 AND ro_id=$2 AND tenant_id=$3${opts.lock ? ' FOR UPDATE' : ''}`,
      [lineItemId, roId, ctx.tenantId],
    )
  ).rows[0];
  if (!item) throw new NotFoundError('Line item not found on this repair order', { code: 'line_item_not_found' });
  return item;
}

/**
 * Verifies every supplied line-item id belongs to this RO and tenant, and returns the
 * rows. Any unknown id is rejected outright rather than silently skipped — a caller
 * must not be able to probe for, or act on, ids that are not theirs.
 */
async function assertLineItemsOnRO(
  ex: Executor,
  ctx: AuthContext,
  roId: string,
  ids: string[],
  opts: { lock?: boolean } = {},
): Promise<any[]> {
  if (ids.length === 0) return [];
  for (const id of ids) requireUuid(id, 'line_item_id');

  const rows = (
    await ex.query(
      `SELECT * FROM ro_line_items WHERE line_item_id = ANY($1) AND ro_id=$2 AND tenant_id=$3
        ORDER BY line_item_id${opts.lock ? ' FOR UPDATE' : ''}`,
      [ids, roId, ctx.tenantId],
    )
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

/**
 * The dealership's timezone for day-boundary questions. Location timezones belong to
 * the platform's location domain, which this service does not own, so the caller
 * supplies one and `SERVICE_DEFAULT_TIMEZONE` is the fallback. Validated against the
 * IANA database here so an unknown name is a 400 rather than a Postgres error.
 */
function resolveTimezone(supplied?: unknown): string {
  const candidate = typeof supplied === 'string' && supplied.trim() !== ''
    ? supplied
    : process.env.SERVICE_DEFAULT_TIMEZONE ?? 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate });
  } catch {
    throw new ValidationError(`Unknown timezone: ${candidate}`, { code: 'unknown_timezone' });
  }
  return candidate;
}

/** Runs promise-returning thunks one at a time, so one request holds one connection. */
async function sequentially<T>(thunks: Array<() => Promise<T>>): Promise<T[]> {
  const out: T[] = [];
  for (const thunk of thunks) out.push(await thunk());
  return out;
}

// ============================================================
// 1) SCM2 — Service Cockpit Module v2
// ============================================================

export async function getServiceCockpitHome(
  ctx: AuthContext,
  locationId?: string,
  options?: { timezone?: unknown },
): Promise<any> {
  if (locationId !== undefined) requireUuid(locationId, 'location_id');

  const timezone = resolveTimezone(options?.timezone);
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

  // "Today" is the dealership's today, not the database server's. Comparing against
  // CURRENT_DATE rolled the panel over at the server's midnight, which on a UTC server
  // is late afternoon on the US west coast — the board cleared mid-shift.
  const todayAppts = (
    await query(
      `SELECT status, COUNT(*)::int AS cnt FROM service_appointments
       WHERE tenant_id=$1${scope('location_id')}
         AND (scheduled_start AT TIME ZONE $${params.length + 1})::date
           = (NOW() AT TIME ZONE $${params.length + 1})::date
       GROUP BY status`,
      [...params, timezone],
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

export async function queryServiceCockpitView(
  ctx: AuthContext,
  viewId: string,
  overrides?: unknown,
  options?: { limit?: unknown; offset?: unknown },
): Promise<any> {
  // `Object.hasOwn`, not a truthiness check: inherited keys like `constructor` or
  // `toString` would otherwise pass the guard and reach the query as a function.
  const queueTypes = typeof viewId === 'string' && Object.hasOwn(VIEW_QUEUE_MAP, viewId) ? VIEW_QUEUE_MAP[viewId] : undefined;
  if (!queueTypes) {
    throw new ValidationError('Unknown view_id', {
      code: 'unknown_view',
      details: { known_views: Object.keys(VIEW_QUEUE_MAP) },
    });
  }

  // View overrides are not implemented. Rejecting is honest; silently ignoring them
  // would let a caller believe a filter had been applied.
  //
  // Anything other than an absent or empty object is refused. The earlier form tested
  // `typeof overrides === 'object'` before looking for keys, so a caller who sent a
  // string, a number or a boolean — `overrides=location%3Dstore2` from a query string is
  // the obvious way to arrive here — fell through the guard and was told nothing, which
  // is the precise outcome the guard exists to prevent.
  if (overrides !== undefined && overrides !== null) {
    const isEmptyObject = typeof overrides === 'object'
      && !Array.isArray(overrides)
      && Object.keys(overrides as object).length === 0;
    if (!isEmptyObject) {
      throw new ValidationError('View overrides are not supported', { code: 'overrides_unsupported' });
    }
  }

  const page = pagination(options, 100, 200);
  const items = (
    await query(
      `SELECT qi.*, ro.status AS ro_status, ro.mdm_customer_id, ro.mdm_vehicle_id, ro.promised_time
       FROM service_queue_items qi
       LEFT JOIN repair_orders ro ON qi.ro_id = ro.ro_id AND ro.tenant_id = qi.tenant_id
       WHERE qi.tenant_id=$1 AND qi.queue_type = ANY($2) AND qi.status NOT IN ('done','canceled')
       ORDER BY qi.priority, qi.sla_due_at NULLS LAST, qi.queue_item_id
       LIMIT $3 OFFSET $4`,
      [ctx.tenantId, queueTypes, page.limit, page.offset],
    )
  ).rows;

  return { view_id: viewId, items, count: items.length, limit: page.limit, offset: page.offset };
}

// ============================================================
// 2) SSIS2 — Service Scheduling & Intake
// ============================================================

const APPOINTMENT_SOURCES = ['walk_in', 'phone', 'web', 'sales_handoff'] as const;
const LANGUAGE_PREFERENCES = ['en', 'es', 'auto'] as const;
const CONTACT_CHANNELS = ['sms', 'email', 'phone', 'portal'] as const;

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
  requireTimestamp(params.scheduled_start, 'scheduled_start');
  if (params.scheduled_end !== undefined && params.scheduled_end !== null) {
    requireTimestamp(params.scheduled_end, 'scheduled_end');
  }

  const source = params.source ? requireOneOf(params.source, APPOINTMENT_SOURCES, 'source') : 'phone';
  const language = params.language_preference
    ? requireOneOf(params.language_preference, LANGUAGE_PREFERENCES, 'language_preference')
    : 'en';
  const channel = params.preferred_contact_channel
    ? requireOneOf(params.preferred_contact_channel, CONTACT_CHANNELS, 'preferred_contact_channel')
    : 'sms';

  const id = generateId();
  const appt = (
    await query(
      `INSERT INTO service_appointments (appointment_id,tenant_id,location_id,mdm_customer_id,mdm_vehicle_id,
         scheduled_start,scheduled_end,concerns,preferred_contact_channel,language_preference,source,created_by_user_id,status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'scheduled') RETURNING *`,
      [
        id, ctx.tenantId, params.location_id, params.mdm_customer_id, params.mdm_vehicle_id,
        params.scheduled_start, params.scheduled_end ?? null, JSON.stringify(requireConcerns(params.concerns)),
        channel, language, source, ctx.userId,
      ],
    )
  ).rows[0];

  svcAppointmentsTotal.inc({ status: 'scheduled', location: params.location_id });
  await emitAudit(ctx, 'appointment.created', 'service_appointment', id, { source });
  return appt;
}

/**
 * Inserts an appointment on the caller's executor, so it can join a surrounding
 * transaction (the retention bridge creates an appointment and its offer atomically).
 * Validation is the caller's responsibility here; `createAppointment` is the validated
 * public entry point.
 */
async function insertAppointment(
  ex: Executor,
  ctx: AuthContext,
  params: {
    location_id: string; mdm_customer_id: string; mdm_vehicle_id: string; scheduled_start: string;
    concerns?: unknown; language_preference?: string; source?: string;
  },
): Promise<any> {
  const id = generateId();
  return (
    await ex.query(
      `INSERT INTO service_appointments (appointment_id,tenant_id,location_id,mdm_customer_id,mdm_vehicle_id,
         scheduled_start,concerns,language_preference,source,created_by_user_id,status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'scheduled') RETURNING *`,
      [
        id, ctx.tenantId, params.location_id, params.mdm_customer_id, params.mdm_vehicle_id,
        params.scheduled_start, JSON.stringify(requireConcerns(params.concerns)),
        params.language_preference ?? 'en', params.source ?? 'phone', ctx.userId,
      ],
    )
  ).rows[0];
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

  // Validated to the same standard as the create path — otherwise a bad value reaches
  // a CHECK constraint or a timestamp column and comes back as an opaque 500.
  // scheduled_start is NOT NULL in the schema, so a null here must be a 400 rather than
  // a constraint violation surfacing as a 500. scheduled_end is nullable, so an explicit
  // null is a legitimate "clear it".
  if (updates.scheduled_start !== undefined) requireTimestamp(updates.scheduled_start, 'scheduled_start');
  if (updates.scheduled_end !== undefined && updates.scheduled_end !== null) {
    requireTimestamp(updates.scheduled_end, 'scheduled_end');
  }
  if (updates.language_preference !== undefined) {
    requireOneOf(updates.language_preference, LANGUAGE_PREFERENCES, 'language_preference');
  }
  if (updates.preferred_contact_channel !== undefined) {
    requireOneOf(updates.preferred_contact_channel, CONTACT_CHANNELS, 'preferred_contact_channel');
  }
  if (updates.concerns !== undefined) requireConcerns(updates.concerns);

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
    await syncQueueForRO(tx, ctx, ro);

    // A first-service offer that produced this visit is now converted.
    await tx.query(
      `UPDATE first_service_offers SET status='converted', ro_id=$3, converted_at=NOW()
        WHERE appointment_id=$1 AND tenant_id=$2 AND status IN ('offered','scheduled')`,
      [appointmentId, ctx.tenantId, roId],
    );

    return { ro, appointment: appt, created: true };
  });

  if (result.created) {
    svcROTotal.inc({ status: 'checked_in', location: result.appointment.location_id });
    await emitAudit(ctx, 'ro.created_from_appointment', 'repair_order', result.ro.ro_id, { appointment_id: appointmentId });
  }

  return { ...result.ro, appointment_id: appointmentId, idempotent_replay: !result.created };
}

/**
 * Records that the customer never arrived, and queues the follow-up call.
 *
 * `no_show` has been in the appointment status enum since 049, but nothing could ever set
 * it: `updateAppointment` refuses raw status writes and no other path produced it. The
 * `no_show_followup` queue, and the cockpit view built on it, were therefore unreachable.
 */
export async function markAppointmentNoShow(ctx: AuthContext, appointmentId: string): Promise<any> {
  requireUuid(appointmentId, 'appointment_id');

  return withTransaction(async (tx) => {
    const appt = (
      await tx.query(`SELECT * FROM service_appointments WHERE appointment_id=$1 AND tenant_id=$2 FOR UPDATE`, [
        appointmentId,
        ctx.tenantId,
      ])
    ).rows[0];
    if (!appt) throw new NotFoundError('Appointment not found');
    if (!['requested', 'scheduled', 'confirmed'].includes(appt.status)) {
      throw new ConflictError(`An appointment that is '${appt.status}' cannot be marked a no-show`, {
        code: 'invalid_appointment_status',
        details: { status: appt.status },
      });
    }

    const row = (
      await tx.query(
        `UPDATE service_appointments SET status='no_show', updated_at=NOW()
          WHERE appointment_id=$1 AND tenant_id=$2 RETURNING *`,
        [appointmentId, ctx.tenantId],
      )
    ).rows[0];

    await recordAppointmentEvent(tx, ctx, appointmentId, 'no_show', { user_id: ctx.userId });
    await createServiceQueueItem(tx, ctx, {
      location_id: appt.location_id,
      queue_type: 'no_show_followup',
      appointment_id: appointmentId,
    });

    return row;
  });
}

/**
 * Pre-intake lookup for the advisor at the drive lane.
 *
 * Deliberately writes nothing — the durable record begins at `checkIn`. What it does
 * return is real: given a vehicle, the service history this tenant already holds, so
 * the advisor can see prior visits, an open repair order, and recommendations the
 * customer previously declined before they start typing.
 *
 * A VIN alone cannot be resolved here: VIN-to-vehicle identity belongs to the MDM
 * domain, which this service does not own.
 */
export async function quickStartIntake(
  ctx: AuthContext,
  params: { location_id: string; scan_vin?: string; mdm_vehicle_id?: string; language_preference?: string },
): Promise<any> {
  requireUuid(params.location_id, 'location_id');
  if (params.mdm_vehicle_id !== undefined) requireUuid(params.mdm_vehicle_id, 'mdm_vehicle_id');
  const language = params.language_preference
    ? requireOneOf(params.language_preference, LANGUAGE_PREFERENCES, 'language_preference')
    : 'en';

  let history: any = null;
  if (params.mdm_vehicle_id) {
    const [recentROs, openRO, declined] = await Promise.all([
      query(
        `SELECT ro_id, status, odometer, created_at FROM repair_orders
          WHERE tenant_id=$1 AND mdm_vehicle_id=$2
          ORDER BY created_at DESC LIMIT 5`,
        [ctx.tenantId, params.mdm_vehicle_id],
      ),
      query(
        `SELECT ro_id, status FROM repair_orders
          WHERE tenant_id=$1 AND mdm_vehicle_id=$2 AND status NOT IN ('closed','canceled')
          ORDER BY created_at DESC LIMIT 1`,
        [ctx.tenantId, params.mdm_vehicle_id],
      ),
      query(
        `SELECT sr.recommendation_id, sr.title_i18n, sr.priority, sr.created_at
           FROM service_recommendations sr
           JOIN repair_orders ro ON sr.ro_id = ro.ro_id AND ro.tenant_id = sr.tenant_id
          WHERE sr.tenant_id=$1 AND ro.mdm_vehicle_id=$2 AND sr.status='declined'
          ORDER BY sr.created_at DESC LIMIT 10`,
        [ctx.tenantId, params.mdm_vehicle_id],
      ),
    ]);

    history = {
      recent_repair_orders: recentROs.rows,
      open_repair_order: openRO.rows[0] ?? null,
      previously_declined_recommendations: declined.rows,
    };
  }

  return {
    intake_session_ref: generateId(),
    persisted: false,
    tenant_id: ctx.tenantId,
    location_id: params.location_id,
    scan_vin: params.scan_vin ?? null,
    language_preference: language,
    // VIN resolution belongs to MDM; supply mdm_vehicle_id to get real history back.
    mdm_match_preview: params.scan_vin && !params.mdm_vehicle_id
      ? { vin: params.scan_vin, status: 'lookup_required', resolve_via: 'mdm' }
      : null,
    vehicle_history: history,
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
  // `checkIn` has always validated odometer; this path, which creates the same row, did
  // not — so a walk-in repair order accepted a non-integer odometer and a malformed
  // promised_time, and both surfaced as a 500 from Postgres instead of a 400.
  if (params.odometer !== undefined && params.odometer !== null
      && (!Number.isInteger(params.odometer) || params.odometer < 0)) {
    throw new ValidationError('odometer must be a non-negative integer');
  }
  if (params.promised_time !== undefined && params.promised_time !== null) {
    requireTimestamp(params.promised_time, 'promised_time');
  }

  const roId = generateId();
  const ro = await withTransaction(async (tx) => {
    // An appointment may only be attached if it is ours, and only once — a second
    // repair order for the same appointment would hit the unique index and surface as
    // an opaque 500 instead of a domain conflict.
    if (params.appointment_id) {
      const appt = (
        await tx.query(
          `SELECT appointment_id FROM service_appointments WHERE appointment_id=$1 AND tenant_id=$2 FOR UPDATE`,
          [params.appointment_id, ctx.tenantId],
        )
      ).rows[0];
      if (!appt) throw new NotFoundError('Appointment not found');

      const existing = (
        await tx.query(`SELECT ro_id FROM repair_orders WHERE appointment_id=$1 AND tenant_id=$2`, [
          params.appointment_id,
          ctx.tenantId,
        ])
      ).rows[0];
      if (existing) {
        throw new ConflictError('This appointment already has a repair order', {
          code: 'appointment_already_converted',
          details: { ro_id: existing.ro_id },
        });
      }
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

export async function getRO(ctx: AuthContext, roId: string, options?: { event_limit?: unknown }): Promise<any> {
  const ro = await assertRO({ query }, ctx, roId);
  const events_page = pagination({ limit: options?.event_limit }, 30, 200);

  // Sequential, not Promise.all: fanning seven child reads out concurrently checked out
  // eight pool connections for a single request against a default pool of ten, so a
  // handful of simultaneous reads exhausted the pool and turned into 500s instead of
  // queueing. These are indexed point lookups; the round-trips are cheap.
  const [lineItems, events, estimates, auths, partsList, subletJobs, tickets] = await sequentially([
    () => query(`SELECT * FROM ro_line_items WHERE ro_id=$1 AND tenant_id=$2 ORDER BY created_at`, [roId, ctx.tenantId]),
    () => query(`SELECT * FROM ro_events WHERE ro_id=$1 AND tenant_id=$2 ORDER BY occurred_at DESC LIMIT $3`, [roId, ctx.tenantId, events_page.limit]),
    () => query(`SELECT * FROM ro_estimates WHERE ro_id=$1 AND tenant_id=$2 ORDER BY version DESC`, [roId, ctx.tenantId]),
    () => query(`SELECT * FROM ro_authorizations WHERE ro_id=$1 AND tenant_id=$2 ORDER BY created_at DESC`, [roId, ctx.tenantId]),
    () => query(`SELECT * FROM ro_parts_lines WHERE ro_id=$1 AND tenant_id=$2 ORDER BY status`, [roId, ctx.tenantId]),
    () => query(`SELECT * FROM ro_sublet_jobs WHERE ro_id=$1 AND tenant_id=$2 ORDER BY status`, [roId, ctx.tenantId]),
    () => query(`SELECT * FROM tech_work_tickets WHERE ro_id=$1 AND tenant_id=$2 ORDER BY created_at`, [roId, ctx.tenantId]),
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
    // exact user, tenant, action and repair order. The token is burned in this same
    // transaction, so it cannot be replayed and a rolled-back transition releases it.
    if (transitionRequiresStepUp(toStatus)) {
      await consumeStepUpToken(tx, params.step_up_token, {
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        action: `ro.transition:${toStatus}`,
        resourceId: roId,
      });
    }

    // Quality gate: nothing may be handed back to the customer while work is still
    // open on the repair order.
    if (toStatus === 'ready_for_pickup') {
      const openWork = (
        await tx.query(
          `SELECT line_item_id, description, status FROM ro_line_items
            WHERE ro_id=$1 AND tenant_id=$2 AND status IN ('proposed','approved','in_progress')`,
          [roId, ctx.tenantId],
        )
      ).rows;
      if (openWork.length > 0) {
        throw new UnprocessableError('Every line item must be completed, declined or canceled before pickup', {
          code: 'work_incomplete',
          details: { open_line_items: openWork.map((l: any) => ({ line_item_id: l.line_item_id, status: l.status })) },
          messageI18n: i18n(
            'Work is still open on this repair order',
            'Todavía hay trabajo abierto en esta orden de reparación',
          ),
        });
      }

      // Billing gate: no line may still be awaiting a customer decision. Otherwise work
      // the customer was asked about but never answered could be completed and handed
      // back — and then invoiced — with no approval behind it.
      // The population is "billable work", not "work marked pending". A line added after
      // the estimate went out carries the default `not_required`, never `pending`, so a
      // priced line invented mid-repair would otherwise sail through this gate and be
      // invoiced with no decision behind it. `not_required` legitimately covers warranty,
      // internal and goodwill work — which is precisely the work that carries no charge.
      const undecided = (
        await tx.query(
          `SELECT line_item_id, description, authorization_status FROM ro_line_items
            WHERE ro_id=$1 AND tenant_id=$2
              AND status <> 'canceled'
              AND (
                authorization_status = 'pending'
                OR (authorization_status = 'not_required'
                    -- Cast-safe by construction. A plain ::numeric cast raises
                    -- invalid_text_representation on any amount that is not a JSON number,
                    -- and because this gate runs on every delivery attempt one legacy row
                    -- holding free text wedged the repair order at HTTP 500 permanently.
                    -- The CASE only evaluates the cast on the 'number' branch, and an
                    -- amount we cannot read fails CLOSED: better a 422 naming the line,
                    -- which an advisor can act on, than a silent pass on the money path.
                    AND CASE COALESCE(jsonb_typeof(price_ref->'amount_cents'), 'null')
                          WHEN 'number' THEN (price_ref->>'amount_cents')::numeric > 0
                          WHEN 'null' THEN false
                          ELSE true
                        END)
              )`,
          [roId, ctx.tenantId],
        )
      ).rows;
      if (undecided.length > 0) {
        throw new UnprocessableError('Every chargeable line item must have a recorded customer decision before pickup', {
          code: 'decision_outstanding',
          details: {
            undecided_line_items: undecided.map((l: any) => ({
              line_item_id: l.line_item_id,
              authorization_status: l.authorization_status,
            })),
          },
          messageI18n: i18n(
            'The customer has not decided on all chargeable work',
            'El cliente no ha decidido sobre todo el trabajo facturable',
          ),
        });
      }
    }

    // Work may only begin once the customer has approved something to do. Lines still
    // `pending` are fine here — they may be decided while the approved work proceeds —
    // but at least one line must carry a real approval.
    if (toStatus === 'in_repair') {
      const approvedWork = (
        await tx.query(
          `SELECT 1 FROM ro_line_items
            WHERE ro_id=$1 AND tenant_id=$2 AND authorization_status IN ('approved','not_required')
            LIMIT 1`,
          [roId, ctx.tenantId],
        )
      ).rows[0];
      if (!approvedWork) {
        throw new UnprocessableError('No line item on this repair order is approved to work on', {
          code: 'no_approved_work',
          messageI18n: i18n(
            'No approved work on this repair order',
            'No hay trabajo aprobado en esta orden de reparación',
          ),
        });
      }
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

    // Returning to `estimate_pending` is the re-quote edge: the outstanding estimate is
    // withdrawn and the lines the customer had not yet answered go back to un-shown, so
    // they can be re-priced and put in front of them again. Without this the old estimate
    // stayed answerable and its lines stayed locked, so a re-quote could neither be
    // decided nor superseded.
    if (toStatus === 'estimate_pending') {
      await tx.query(
        `UPDATE ro_estimates SET status='expired', updated_at=NOW()
          WHERE ro_id=$1 AND tenant_id=$2 AND status IN ('sent','partially_approved')`,
        [roId, ctx.tenantId],
      );
      await tx.query(
        `UPDATE ro_line_items SET authorization_status='not_required', updated_at=NOW()
          WHERE ro_id=$1 AND tenant_id=$2 AND authorization_status='pending'`,
        [roId, ctx.tenantId],
      );
    }

    await syncQueueForRO(tx, ctx, updated);

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
const LINE_STATUSES = ['proposed', 'approved', 'declined', 'in_progress', 'completed', 'canceled'] as const;

/**
 * Adds a line to a repair order.
 *
 * A new line always starts at `not_required`. The caller cannot choose its
 * `authorization_status` — accepting one here would reintroduce, on the create path,
 * exactly what `updateLineItem` refuses: a line marked `approved` with no customer
 * decision behind it. Authorization status is written only by `recordAuthorization`
 * (moving it to `approved`/`declined`) and `generateEstimate` (moving it to `pending`).
 */
export async function addLineItem(
  ctx: AuthContext,
  roId: string,
  params: {
    line_type: string;
    category?: string;
    description: string;
    labor_op_code?: string;
    estimated_hours?: number;
  },
): Promise<any> {
  if ('authorization_status' in params || 'authorization_ref' in params) {
    throw new ForbiddenError('authorization_status is set from a recorded customer authorization, not directly', {
      code: 'authorization_fields_readonly',
    });
  }
  const lineType = requireOneOf(params.line_type, LINE_TYPES, 'line_type');
  if (typeof params.description !== 'string' || params.description.trim() === '') {
    throw new ValidationError('description is required');
  }
  if (params.estimated_hours !== undefined && (typeof params.estimated_hours !== 'number' || params.estimated_hours < 0)) {
    throw new ValidationError('estimated_hours must be a non-negative number');
  }

  return withTransaction(async (tx) => {
    await assertRO(tx, ctx, roId);
    return (
      await tx.query(
        `INSERT INTO ro_line_items (line_item_id,tenant_id,ro_id,line_type,category,description,labor_op_code,estimated_hours,authorization_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'not_required') RETURNING *`,
        [
          generateId(), ctx.tenantId, roId, lineType, params.category ?? null, params.description,
          params.labor_op_code ?? null, params.estimated_hours ?? null,
        ],
      )
    ).rows[0];
  });
}

/**
 * Fields on a line item, split by who may write them and why.
 *
 * The split is the point. `price_ref` and `sold_hours` decide what the customer is
 * billed, so they belong to the commercial roles; `status` is shop-floor progress.
 * Previously every shop-floor role could write all of them on any line in the tenant,
 * which meant a technician could rewrite the money on a repair order they had never
 * touched — and that number flowed straight into the estimate the customer approved.
 *
 * `assigned_tech_user_id` is absent entirely: assignment goes through `dispatchTech`,
 * which verifies the technician has an active profile at the repair order's location.
 * Accepting it here was a way around that check.
 *
 * `authorization_status`/`authorization_ref` are written only by `generateEstimate` and
 * `recordAuthorization`, from a real customer decision.
 */
const LINE_ITEM_PROGRESS_FIELDS = ['status'] as const;
const LINE_ITEM_COMMERCIAL_FIELDS = ['sold_hours', 'price_ref'] as const;

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
  if ('assigned_tech_user_id' in updates) {
    throw new ForbiddenError('assigned_tech_user_id is set by dispatch, not directly', {
      code: 'assignment_via_dispatch_only',
    });
  }

  const commercial = (LINE_ITEM_COMMERCIAL_FIELDS as readonly string[]).filter((f) => f in updates);
  const supervises = hasAnyRole(ctx, ROLES.SERVICE_ADVISOR, ROLES.SERVICE_MANAGER);
  if (commercial.length > 0 && !supervises) {
    throw new ForbiddenError('Only a service advisor or manager may change what the customer is billed', {
      code: 'commercial_fields_restricted',
      details: { fields: commercial },
    });
  }

  if (updates.status !== undefined) requireOneOf(updates.status, LINE_STATUSES, 'status');
  if (updates.sold_hours !== undefined && updates.sold_hours !== null
      && (typeof updates.sold_hours !== 'number' || updates.sold_hours < 0)) {
    throw new ValidationError('sold_hours must be a non-negative number');
  }
  if ('price_ref' in updates) validatePriceRef(updates.price_ref);

  return withTransaction(async (tx) => {
    await assertRO(tx, ctx, roId);
    // Locked: the guards below are a read-validate-write, so without FOR UPDATE a
    // customer decline landing concurrently would be read as "still pending" here and
    // then silently overwritten by this update.
    const line = await assertLineItem(tx, ctx, roId, lineItemId, { lock: true });

    // A technician may only move work they were actually dispatched to.
    if (!supervises && line.assigned_tech_user_id !== ctx.userId) {
      throw new ForbiddenError('This line item is assigned to another technician', {
        code: 'not_line_item_assignee',
      });
    }

    // `status` on a declined line is the record that the customer said no. Letting it
    // be rewritten would quietly return declined work to the shop floor.
    if (line.authorization_status === 'declined' && updates.status !== undefined && updates.status !== 'declined') {
      throw new ConflictError('This line was declined by the customer and cannot be reopened', {
        code: 'line_item_declined',
      });
    }

    // Commercial terms are frozen from the moment the line goes in front of the customer
    // until they answer, and permanently once they have agreed. Allowing an edit while the
    // line is `pending` is what let the price shown on an estimate diverge from the price
    // recorded as approved.
    if (line.authorization_status === 'pending' && commercial.length > 0) {
      throw new ConflictError(
        'This line is out with the customer; move the repair order back to estimate_pending to re-quote it',
        { code: 'pending_terms_frozen', details: { fields: commercial } },
      );
    }
    if (line.authorization_status === 'approved' && commercial.length > 0) {
      throw new ConflictError(
        'This line is customer-approved; its price is now part of the agreement and cannot be changed',
        { code: 'approved_terms_frozen', details: { fields: commercial } },
      );
    }

    const writable = [...LINE_ITEM_PROGRESS_FIELDS, ...(supervises ? LINE_ITEM_COMMERCIAL_FIELDS : [])] as string[];
    const sets: string[] = [];
    const vals: unknown[] = [lineItemId, roId, ctx.tenantId];
    for (const [k, v] of Object.entries(updates)) {
      if (writable.includes(k)) {
        vals.push(k === 'price_ref' ? JSON.stringify(v) : v);
        sets.push(`${k}=$${vals.length}`);
      }
    }
    if (sets.length === 0) throw new ValidationError('No updatable fields supplied');
    sets.push('updated_at=NOW()');

    // The authorization_status is re-asserted so a decision that commits between the
    // read above and this write turns into a lost-update conflict rather than a silent
    // overwrite.
    vals.push(line.authorization_status);
    const updated = (
      await tx.query(
        `UPDATE ro_line_items SET ${sets.join(',')}
          WHERE line_item_id=$1 AND ro_id=$2 AND tenant_id=$3 AND authorization_status=$${vals.length}
          RETURNING *`,
        vals,
      )
    ).rows[0];
    if (!updated) {
      throw new ConflictError('The line item changed while this update was being applied', {
        code: 'concurrent_modification',
      });
    }
    return updated;
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
    const ro = await assertRO(tx, ctx, roId, { lock: true });
    // An inspection only makes sense before the estimate is priced. Checking here means
    // the conditional status write below is a no-op only when the RO is already being
    // inspected, never because the caller was silently ignored.
    if (!['checked_in', 'inspection_in_progress'].includes(ro.status)) {
      throw new ConflictError(`An inspection cannot be started on a '${ro.status}' repair order`, {
        code: 'ro_not_inspectable',
        details: { status: ro.status },
      });
    }

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

    const moved = (
      await tx.query(
        `UPDATE repair_orders SET status='inspection_in_progress', updated_at=NOW()
          WHERE ro_id=$1 AND tenant_id=$2 AND status='checked_in' RETURNING *`,
        [roId, ctx.tenantId],
      )
    ).rows[0];
    if (moved) await syncQueueForRO(tx, ctx, moved);

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
  if (typeof params.item_key !== 'string' || params.item_key.trim() === '') {
    throw new ValidationError('item_key is required');
  }

  // Severity drives the priority of the recommendation this becomes, so it cannot be
  // defaulted for a finding: defaulting to 'info' turned a failed safety item into a
  // p2 suggestion. Only a passing item may omit it.
  if (status !== 'pass' && params.severity === undefined) {
    throw new ValidationError(`severity is required when status is '${status}'`, {
      code: 'severity_required',
      details: { allowed: MPI_SEVERITIES },
    });
  }
  const severity = params.severity ? requireOneOf(params.severity, MPI_SEVERITIES, 'severity') : 'info';
  const evidenceRefs = params.evidence_artifact_refs === undefined
    ? []
    : requireStringArray(params.evidence_artifact_refs, 'evidence_artifact_refs');

  return withTransaction(async (tx) => {
    const session = await assertOwnMPISession(tx, ctx, mpiSessionId, { lock: true });
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

    // Upsert on (session, item): a technician correcting a reading should replace it,
    // not add a second row that becomes a duplicate customer recommendation on submit.
    return (
      await tx.query(
        `INSERT INTO mpi_results (result_id,tenant_id,mpi_session_id,item_key,status,severity,notes,evidence_artifact_refs)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (mpi_session_id, item_key) DO UPDATE
           SET status=EXCLUDED.status,
               severity=EXCLUDED.severity,
               notes=EXCLUDED.notes,
               evidence_artifact_refs=EXCLUDED.evidence_artifact_refs
         RETURNING *`,
        [generateId(), ctx.tenantId, mpiSessionId, params.item_key, status, severity, params.notes ?? null, evidenceRefs],
      )
    ).rows[0];
  });
}

export async function submitMPISession(ctx: AuthContext, mpiSessionId: string): Promise<any> {
  requireUuid(mpiSessionId, 'mpi_session_id');

  return withTransaction(async (tx) => {
    const session = await assertOwnMPISession(tx, ctx, mpiSessionId, { lock: true });
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
              // The generated sentence is genuinely bilingual. A technician's free-text
              // note is not — echoing it into the Spanish field would present English
              // prose to a Spanish-speaking customer as if it had been translated. The
              // note is carried separately so the portal can label it as untranslated.
              `Inspection item ${r.item_key} needs ${r.status === 'fail' ? 'immediate ' : ''}attention`,
              `El artículo ${r.item_key} necesita atención${r.status === 'fail' ? ' inmediata' : ''}`,
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
    // Locked: the open-task lookup below is a read-validate-write, so concurrent re-sends
    // would each find no open task and each create one, stacking duplicates on the
    // customer's portal.
    await assertRO(tx, ctx, roId, { lock: true });

    const recs = (
      await tx.query(
        `UPDATE service_recommendations SET status='sent_to_customer', updated_at=NOW()
          WHERE ro_id=$1 AND tenant_id=$2 AND status='proposed' RETURNING *`,
        [roId, ctx.tenantId],
      )
    ).rows;

    // Reuse an open task rather than stacking a new one on the customer's portal
    // every time an advisor re-sends.
    const openTask = (
      await tx.query(
        `SELECT portal_task_id FROM service_portal_tasks
          WHERE ro_id=$1 AND tenant_id=$2 AND task_type='review_recommendations'
            AND status IN ('created','viewed')
          ORDER BY created_at DESC LIMIT 1`,
        [roId, ctx.tenantId],
      )
    ).rows[0];

    if (openTask) {
      await recordROEvent(tx, ctx, roId, 'recommendations_sent', { user_id: ctx.userId }, {
        portal_task_id: openTask.portal_task_id,
        sent_count: recs.length,
        channel: params.channel ?? null,
      });
      return { sent_count: recs.length, portal_task_id: openTask.portal_task_id, reused_existing_task: true };
    }

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
    const ro = await assertRO(tx, ctx, roId, { lock: true });
    // Quoting happens in two situations. Before work starts, from the intake and
    // estimating states. And once work is under way, as a supplemental for extra work the
    // technician discovered on the bench — which is routine in a service department, and
    // which the repair order must not have to reverse out of `in_repair` to quote.
    // `awaiting_authorization` is excluded on purpose: an estimate already in front of the
    // customer is re-quoted through the explicit transition back to `estimate_pending`, so
    // the repair order's status never disagrees with what is being asked.
    const QUOTABLE = [
      'checked_in', 'inspection_in_progress', 'estimate_pending',
      'authorized', 'in_repair', 'waiting_parts', 'sublet_in_progress', 'qc',
    ];
    if (!QUOTABLE.includes(ro.status)) {
      throw new ConflictError(`An estimate cannot be generated for a '${ro.status}' repair order`, {
        code: 'ro_not_estimable',
        details: { status: ro.status },
      });
    }

    // Exactly the lines this estimate puts to the customer: undecided work that has not
    // been shown yet. Totalling every active line instead would price work the customer
    // already decided on into an estimate that never asks about it, so the figure they
    // answer would disagree with the decision recorded against it.
    const lineItems = (
      await tx.query(
        `SELECT * FROM ro_line_items
          WHERE ro_id=$1 AND tenant_id=$2 AND authorization_status='not_required'
            AND status NOT IN ('canceled','declined')
          ORDER BY created_at`,
        [roId, ctx.tenantId],
      )
    ).rows;
    if (lineItems.length === 0) {
      throw new ConflictError('There is no undecided work to quote on this repair order', { code: 'no_line_items' });
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
      ...summariseMoney(lineItems),
    };

    const est = (
      await tx.query(
        `INSERT INTO ro_estimates (estimate_id,tenant_id,ro_id,version,totals_ref,language_mode)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [estId, ctx.tenantId, roId, maxVer + 1, JSON.stringify(totals), languageMode],
      )
    ).rows[0];

    // Same predicate as the SELECT above, in the same transaction under the repair
    // order's lock, so the lines marked pending are exactly the lines that were totalled.
    // `estimate_id` records that association: without it, deriving this estimate's status
    // later had no way to tell its own lines from the rest of the repair order's.
    await tx.query(
      `UPDATE ro_line_items SET authorization_status='pending', estimate_id=$3, updated_at=NOW()
        WHERE ro_id=$1 AND tenant_id=$2 AND authorization_status='not_required'
          AND status NOT IN ('canceled','declined')`,
      [roId, ctx.tenantId, estId],
    );
    // Only a pre-work repair order moves to `estimate_pending`. A supplemental raised
    // mid-repair leaves the repair order where it is; the work already approved carries on
    // while the customer considers the extra.
    const moved = (
      await tx.query(
        `UPDATE repair_orders SET status='estimate_pending', updated_at=NOW()
          WHERE ro_id=$1 AND tenant_id=$2 AND status IN ('inspection_in_progress','checked_in') RETURNING *`,
        [roId, ctx.tenantId],
      )
    ).rows[0];
    if (moved) await syncQueueForRO(tx, ctx, moved);

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
    // A pre-work estimate moves the repair order to `awaiting_authorization`. A
    // supplemental raised while work is under way is sent without disturbing the repair
    // order's state, mirroring `generateEstimate`.
    const WORK_STATES = ['authorized', 'in_repair', 'waiting_parts', 'sublet_in_progress', 'qc'];
    if (ro.status !== 'estimate_pending' && !WORK_STATES.includes(ro.status)) {
      throw new ConflictError(`An estimate cannot be sent from a '${ro.status}' repair order`, {
        code: 'ro_not_estimate_pending',
        details: { status: ro.status },
      });
    }

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

    const moved = (
      await tx.query(
        `UPDATE repair_orders SET status='awaiting_authorization', updated_at=NOW()
          WHERE ro_id=$1 AND tenant_id=$2 AND status='estimate_pending' RETURNING *`,
        [roId, ctx.tenantId],
      )
    ).rows[0];
    if (moved) await syncQueueForRO(tx, ctx, moved);

    await recordROEvent(tx, ctx, roId, 'estimate_sent', { user_id: ctx.userId }, {
      estimate_id: estimateId,
      channel: params.channel ?? null,
    });

    return sent;
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

  if (!methodRequiresStepUp(params.method) && (!params.evidence_refs || Object.keys(params.evidence_refs).length === 0)) {
    // Every other method claims a customer-produced artifact — a portal submission, a
    // signature, a call recording. The record must carry a pointer to it, otherwise
    // "the customer approved via the portal" is an unfalsifiable assertion and the
    // step-up requirement is avoidable just by naming a different method.
    throw new ValidationError(`evidence_refs is required for method '${params.method}'`, {
      code: 'evidence_required',
      details: { method: params.method },
    });
  }

  const language = params.customer_language_used
    ? requireOneOf(params.customer_language_used, ['en', 'es'] as const, 'customer_language_used')
    : 'en';

  const outcome = await withTransaction(async (tx) => {
    await assertRO(tx, ctx, roId, { lock: true });

    if (methodRequiresStepUp(params.method)) {
      // Staff asserting the decision on the customer's behalf: no customer-produced
      // artifact exists, so the actor must re-authenticate. Burned in this transaction.
      await consumeStepUpToken(tx, params.step_up_token, {
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        action: `authorization.record:${params.method}`,
        resourceId: roId,
      });
    }

    const estimate = (
      await tx.query(`SELECT * FROM ro_estimates WHERE estimate_id=$1 AND ro_id=$2 AND tenant_id=$3 FOR UPDATE`, [
        params.estimate_id,
        roId,
        ctx.tenantId,
      ])
    ).rows[0];
    if (!estimate) throw new NotFoundError('Estimate not found on this repair order', { code: 'estimate_not_found' });
    // `partially_approved` is decidable too: a customer who approved some lines and
    // left the rest open must be able to come back and decide the remainder. Accepting
    // only `sent` made the partial state a dead end that could never be completed.
    if (!['sent', 'partially_approved'].includes(estimate.status)) {
      throw new ConflictError(`Estimate is '${estimate.status}'; only a sent or partially decided estimate can be decided`, {
        code: 'estimate_not_sent',
      });
    }

    // A decision must answer the version currently in front of the customer. Accepting an
    // older one let a stale portal link bind the customer to terms they never saw.
    const current = (
      await tx.query(
        `SELECT estimate_id, version FROM ro_estimates
          WHERE ro_id=$1 AND tenant_id=$2 ORDER BY version DESC LIMIT 1`,
        [roId, ctx.tenantId],
      )
    ).rows[0];
    if (current && current.estimate_id !== estimate.estimate_id) {
      throw new ConflictError('This estimate has been superseded by a newer version', {
        code: 'estimate_superseded',
        details: { answered_version: estimate.version, current_version: current.version },
      });
    }

    // Locked in a stable order so two decisions on overlapping lines serialise instead
    // of interleaving.
    const decidedLines = await assertLineItemsOnRO(tx, ctx, roId, [...approved, ...declined], { lock: true });
    const notPending = decidedLines.filter((l: any) => l.authorization_status !== 'pending');
    if (notPending.length > 0) {
      throw new ConflictError('One or more line items are not awaiting a customer decision', {
        code: 'line_items_not_pending',
        details: { line_item_ids: notPending.map((l: any) => l.line_item_id) },
      });
    }

    // Snapshot what the customer actually agreed to, before any of it can move. This is
    // the record an invoice dispute is settled against, and the reason a later price
    // edit on an approved line is refused rather than silently accepted.
    const approvedSet = new Set(approved);
    const snapshot: Record<string, unknown> = {};
    for (const l of decidedLines) {
      if (!approvedSet.has(l.line_item_id)) continue;
      snapshot[l.line_item_id] = {
        description: l.description,
        line_type: l.line_type,
        labor_op_code: l.labor_op_code,
        estimated_hours: l.estimated_hours,
        sold_hours: l.sold_hours,
        price_ref: l.price_ref,
      };
    }

    const authStatus = deriveAuthorizationStatus(approved, declined);
    const authId = generateId();
    const auth = (
      await tx.query(
        `INSERT INTO ro_authorizations (authorization_id,tenant_id,ro_id,estimate_id,method,status,
           approved_items,declined_items,evidence_refs,customer_language_used,approved_snapshot,authorized_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW()) RETURNING *`,
        [
          authId, ctx.tenantId, roId, params.estimate_id, params.method, authStatus,
          approved, declined, JSON.stringify(params.evidence_refs ?? {}), language,
          JSON.stringify(snapshot),
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

    // Counted AFTER the updates above, cumulatively, and over THIS ESTIMATE'S line
    // population.
    //
    // Cumulative because a customer who approves some lines now and decides the rest
    // later leaves two authorization records: reading the second one alone would report
    // `declined` and lose the approval the first recorded.
    //
    // Scoped to the estimate because the count used to cover every line on the repair
    // order. A supplemental quote was then scored against the earlier estimate's
    // decisions too, and a line cancelled while undecided counted as pending forever, so
    // an estimate whose every surviving line was approved could never reach `approved`.
    //
    // A line cancelled while still awaiting an answer is withdrawn, not outstanding, so
    // it leaves the pending count — but a cancellation AFTER a decision does not erase
    // that decision, which is why only the pending filter excludes cancelled lines.
    const tally = (
      await tx.query(
        `SELECT
           COUNT(*) FILTER (WHERE authorization_status='approved')::int AS approved,
           COUNT(*) FILTER (WHERE authorization_status='declined')::int AS declined,
           COUNT(*) FILTER (WHERE authorization_status='pending'
                              AND status <> 'canceled')::int           AS pending,
           COUNT(*)::int                                               AS scoped
         FROM ro_line_items
         WHERE ro_id=$1 AND tenant_id=$2 AND estimate_id=$3`,
        [roId, ctx.tenantId, params.estimate_id],
      )
    ).rows[0];

    // Estimates generated before the association existed have no tagged lines. Fall back
    // to the previous repair-order-wide count for them rather than deriving a status from
    // an empty population, which `deriveEstimateStatus` would read as fully declined.
    const scoped = Number(tally.scoped) > 0
      ? tally
      : (
        await tx.query(
          `SELECT
             COUNT(*) FILTER (WHERE authorization_status='approved')::int AS approved,
             COUNT(*) FILTER (WHERE authorization_status='declined')::int AS declined,
             COUNT(*) FILTER (WHERE authorization_status='pending')::int  AS pending
           FROM ro_line_items WHERE ro_id=$1 AND tenant_id=$2`,
          [roId, ctx.tenantId],
        )
      ).rows[0];

    await tx.query(
      `UPDATE ro_estimates SET status=$3, updated_at=NOW() WHERE estimate_id=$1 AND tenant_id=$2`,
      [
        params.estimate_id,
        ctx.tenantId,
        deriveEstimateStatus(Number(scoped.approved), Number(scoped.declined), Number(scoped.pending)),
      ],
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
    const status = requireOneOf(updates.status, PART_STATUSES, 'status');
    vals.push(status);
    sets.push(`status=$${vals.length}`);
    // Stamp the arrival exactly once, the first time the part reaches the shop. This is
    // the fixed point the parts wait-time metric measures to; leaving it on updated_at
    // re-measured the same part on every later status change.
    if (['received', 'picked', 'installed'].includes(status)) {
      sets.push('received_at=COALESCE(received_at, NOW())');
    }
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
    const ro = await assertRO(tx, ctx, params.ro_id);
    // Locked: superseding the previous ticket and inserting the new one is a
    // read-validate-write, so two concurrent dispatches would otherwise both supersede
    // nothing and leave two live tickets clocking hours onto the same line.
    await assertLineItem(tx, ctx, params.ro_id, params.line_item_id, { lock: true });

    // Work goes only to a technician who is actually on staff at this location.
    const profile = (
      await tx.query(
        `SELECT tech_profile_id FROM tech_profiles
          WHERE tenant_id=$1 AND tech_user_id=$2 AND location_id=$3 AND status='active'`,
        [ctx.tenantId, params.tech_user_id, ro.location_id],
      )
    ).rows[0];
    if (!profile) {
      throw new ValidationError('No active technician profile at this location', {
        code: 'tech_not_available',
        details: { tech_user_id: params.tech_user_id, location_id: ro.location_id },
      });
    }

    // Re-dispatching supersedes the previous assignment rather than stacking a second
    // live ticket on the same line. Two open tickets meant two sets of clock entries for
    // one job, which double-counted the line's sold and estimated hours in the technician
    // efficiency metrics. `reassigned` is the status the schema already reserved for this.
    await tx.query(
      `UPDATE tech_work_tickets SET status='reassigned', updated_at=NOW()
        WHERE line_item_id=$1 AND tenant_id=$2 AND status IN ('assigned','started','paused')`,
      [params.line_item_id, ctx.tenantId],
    );

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

/**
 * Loads a work ticket the caller is allowed to act on: their own, or any if they
 * supervise. `lock: true` takes `FOR UPDATE` so a read-validate-write sequence on the
 * ticket (e.g. appending the next time entry) is serialised against concurrent callers.
 */
/**
 * Loads an inspection session the caller may work on: their own, or any if they supervise.
 * Without this, one technician could record findings on — or submit — another's inspection,
 * and those findings become the recommendations the customer is asked to pay for.
 */
async function assertOwnMPISession(
  ex: Executor,
  ctx: AuthContext,
  mpiSessionId: string,
  opts: { lock?: boolean } = {},
): Promise<any> {
  requireUuid(mpiSessionId, 'mpi_session_id');
  const session = (
    await ex.query(
      `SELECT * FROM mpi_sessions WHERE mpi_session_id=$1 AND tenant_id=$2${opts.lock ? ' FOR UPDATE' : ''}`,
      [mpiSessionId, ctx.tenantId],
    )
  ).rows[0];
  if (!session) throw new NotFoundError('MPI session not found');

  const supervises = hasAnyRole(ctx, ROLES.SERVICE_MANAGER, ROLES.SERVICE_ADVISOR);
  if (!supervises && session.tech_user_id !== ctx.userId) {
    throw new ForbiddenError('This inspection belongs to another technician', {
      code: 'not_inspection_owner',
    });
  }
  return session;
}

async function assertOwnTicket(ex: Executor, ctx: AuthContext, ticketId: string, opts: { lock?: boolean } = {}): Promise<any> {
  requireUuid(ticketId, 'ticket_id');
  const ticket = (
    await ex.query(
      `SELECT * FROM tech_work_tickets WHERE ticket_id=$1 AND tenant_id=$2${opts.lock ? ' FOR UPDATE' : ''}`,
      [ticketId, ctx.tenantId],
    )
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
    const ticket = await assertOwnTicket(tx, ctx, ticketId, { lock: true });

    // A ticket that has been completed, cancelled or handed to someone else is finished.
    // Without this a technician taken off a job could revive their superseded ticket and
    // carry on clocking hours against the line.
    if (['completed', 'reassigned', 'canceled'].includes(ticket.status)) {
      throw new ConflictError(`This work ticket is '${ticket.status}' and cannot be reopened`, {
        code: 'ticket_closed',
        details: { status: ticket.status },
      });
    }

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
    // Locked: two entries racing on the same ticket must not both read the same "last"
    // event and each believe they are a valid next step.
    const ticket = await assertOwnTicket(tx, ctx, ticketId, { lock: true });

    // Clock events must form a coherent sequence; without this a ticket could record a
    // stop with no start, or two starts, and any hours computed from it would be junk.
    // Ordered by insertion, not by occurred_at: occurred_at is client-suppliable and
    // back-datable, so ordering by it would let a caller slot an event behind the real
    // last one and build an incoherent sequence that still passed this check.
    const last = (
      await tx.query(
        `SELECT event_type, occurred_at FROM tech_time_entries
          WHERE ticket_id=$1 AND tenant_id=$2
          ORDER BY created_at DESC, time_entry_id DESC LIMIT 1`,
        [ticketId, ctx.tenantId],
      )
    ).rows[0];

    // Clock time must also move forward, or the paired durations the technician
    // metrics are built from come out negative.
    if (last && occurredAt.getTime() < new Date(last.occurred_at).getTime()) {
      throw new ConflictError('occurred_at is before the previous entry on this ticket', {
        code: 'invalid_time_sequence',
        details: { previous_occurred_at: last.occurred_at },
      });
    }

    const previous: string | null = last?.event_type ?? null;
    const allowedNext: Record<string, string[]> = {
      start: ['pause', 'stop'],
      resume: ['pause', 'stop'],
      pause: ['resume', 'stop'],
      stop: ['start'],
    };
    const permitted = previous === null ? ['start'] : allowedNext[previous] ?? [];
    if (!permitted.includes(eventType)) {
      throw new ConflictError(
        previous === null
          ? 'The first time entry on a ticket must be a start'
          : `A '${previous}' entry cannot be followed by '${eventType}'`,
        { code: 'invalid_time_sequence', details: { previous, attempted: eventType, allowed: permitted } },
      );
    }

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
/** Closed taxonomy — this column is a reporting dimension, so free text made it useless. */
export const COMEBACK_ROOT_CAUSES = [
  'workmanship',
  'parts_failure',
  'misdiagnosis',
  'incomplete_repair',
  'customer_expectation',
  'vendor_sublet',
  'unrelated',
] as const;

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
  const rootCause = requireOneOf(params.root_cause_category, COMEBACK_ROOT_CAUSES, 'root_cause_category');
  const reasonCodes = params.reason_codes === undefined ? [] : requireStringArray(params.reason_codes, 'reason_codes');
  const severity = params.severity ? requireOneOf(params.severity, COMEBACK_SEVERITIES, 'severity') : 'sev2';

  const comeback = await withTransaction(async (tx) => {
    // Both repair orders are locked, in a deterministic order. Locking only one leaves
    // a crossed pair (A→B and B→A opened concurrently) able to deadlock; sorting the
    // ids gives every caller the same acquisition order.
    const [firstId, secondId] = [params.original_ro_id, params.new_ro_id].sort();
    await assertRO(tx, ctx, firstId, { lock: true });
    await assertRO(tx, ctx, secondId, { lock: true });

    const original = await assertRO(tx, ctx, params.original_ro_id);

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
          rootCause, reasonCodes, severity,
        ],
      )
    ).rows[0];

    const flagged = (
      await tx.query(
        `UPDATE repair_orders SET status='comeback', updated_at=NOW()
          WHERE ro_id=$1 AND tenant_id=$2 AND status='closed' RETURNING *`,
        [params.original_ro_id, ctx.tenantId],
      )
    ).rows[0];
    if (flagged) await syncQueueForRO(tx, ctx, flagged);

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

/** Closed set of work queues the cockpit understands. */
export const QUEUE_TYPES = [
  'appointments_today',
  'waiting_checkin',
  'waiting_authorization',
  'waiting_parts',
  'in_repair',
  'qc',
  'ready_pickup',
  'comeback_review',
  'no_show_followup',
] as const;

/**
 * Internal: creates a queue item on the caller's executor so it joins the surrounding
 * transaction. Not exposed as an endpoint — queue items are produced by the lifecycle
 * flows that need them.
 */
/**
 * Resolves the SLA due time for a new queue item. An explicit value wins; otherwise the
 * tenant's configured target for that queue (`service_sla_defaults`) is applied. With no
 * default configured the item has no due time and simply does not count toward the SLA
 * breach metric.
 */
async function resolveSlaDueAt(
  ex: Executor,
  ctx: AuthContext,
  queueType: string,
  explicit?: string,
): Promise<string | null> {
  if (explicit) {
    if (Number.isNaN(Date.parse(explicit))) throw new ValidationError('sla_due_at must be a timestamp');
    return explicit;
  }
  const target = (
    await ex.query(
      `SELECT target_minutes FROM service_sla_defaults WHERE tenant_id=$1 AND queue_type=$2`,
      [ctx.tenantId, queueType],
    )
  ).rows[0];
  if (!target) return null;
  return (
    await ex.query(`SELECT (NOW() + ($1 || ' minutes')::interval) AS due`, [target.target_minutes])
  ).rows[0].due;
}

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
  const slaDueAt = await resolveSlaDueAt(ex, ctx, params.queue_type, params.sla_due_at);

  return (
    await ex.query(
      `INSERT INTO service_queue_items (queue_item_id,tenant_id,location_id,queue_type,ro_id,appointment_id,priority,sla_due_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [
        generateId(), ctx.tenantId, params.location_id, params.queue_type,
        params.ro_id ?? null, params.appointment_id ?? null, priority, slaDueAt,
      ],
    )
  ).rows[0];
}

export async function listServiceQueueItems(
  ctx: AuthContext,
  filters: { location_id?: string; queue_type?: string; status?: string; limit?: unknown; offset?: unknown },
): Promise<any[]> {
  const page = pagination(filters, 100, 200);
  const conds = ['qi.tenant_id=$1'];
  const vals: unknown[] = [ctx.tenantId];

  if (filters.location_id) {
    vals.push(requireUuid(filters.location_id, 'location_id'));
    conds.push(`qi.location_id=$${vals.length}`);
  }
  if (filters.queue_type) {
    // Validated against a closed set: this value used to reach a Prometheus label,
    // where an arbitrary string is unbounded cardinality.
    vals.push(requireOneOf(filters.queue_type, QUEUE_TYPES, 'queue_type'));
    conds.push(`qi.queue_type=$${vals.length}`);
  }
  if (filters.status) {
    vals.push(requireOneOf(filters.status, QUEUE_STATUSES, 'status'));
    conds.push(`qi.status=$${vals.length}`);
  } else {
    conds.push(`qi.status NOT IN ('done','canceled')`);
  }

  vals.push(page.limit, page.offset);
  return (
    await query(
      `SELECT qi.*, ro.status AS ro_status, ro.mdm_customer_id, ro.mdm_vehicle_id, ro.promised_time
         FROM service_queue_items qi
         LEFT JOIN repair_orders ro ON qi.ro_id = ro.ro_id AND ro.tenant_id = qi.tenant_id
        WHERE ${conds.join(' AND ')}
        ORDER BY qi.priority, qi.sla_due_at NULLS LAST, qi.queue_item_id
        LIMIT $${vals.length - 1} OFFSET $${vals.length}`,
      vals,
    )
  ).rows;
}

/**
 * Claims a queue item for the caller.
 *
 * Guarded so it is a claim rather than a blind overwrite: a finished item cannot be
 * resurrected, and an item already being worked by someone else is a conflict rather
 * than a silent reassignment that leaves two people believing they own it.
 */
export async function assignServiceQueueItem(ctx: AuthContext, queueItemId: string): Promise<any> {
  requireUuid(queueItemId, 'queue_item_id');

  return withTransaction(async (tx) => {
    const item = (
      await tx.query(`SELECT * FROM service_queue_items WHERE queue_item_id=$1 AND tenant_id=$2 FOR UPDATE`, [
        queueItemId,
        ctx.tenantId,
      ])
    ).rows[0];
    if (!item) throw new NotFoundError('Queue item not found');

    if (['done', 'canceled'].includes(item.status)) {
      throw new ConflictError(`Queue item is already '${item.status}'`, { code: 'queue_item_closed' });
    }
    if (item.assigned_to_user_id && item.assigned_to_user_id !== ctx.userId) {
      throw new ConflictError('Queue item is already assigned to another user', {
        code: 'queue_item_taken',
        details: { assigned_to_user_id: item.assigned_to_user_id },
      });
    }

    return (
      await tx.query(
        `UPDATE service_queue_items SET assigned_to_user_id=$3, status='in_progress', updated_at=NOW()
          WHERE queue_item_id=$1 AND tenant_id=$2 RETURNING *`,
        [queueItemId, ctx.tenantId, ctx.userId],
      )
    ).rows[0];
  });
}

export async function updateServiceQueueItemStatus(
  ctx: AuthContext,
  queueItemId: string,
  params: { status: string; block_reason_codes?: string[] },
): Promise<any> {
  requireUuid(queueItemId, 'queue_item_id');
  const status = requireOneOf(params.status, QUEUE_STATUSES, 'status');
  if (params.block_reason_codes !== undefined) requireStringArray(params.block_reason_codes, 'block_reason_codes');

  return withTransaction(async (tx) => {
    const item = (
      await tx.query(`SELECT * FROM service_queue_items WHERE queue_item_id=$1 AND tenant_id=$2 FOR UPDATE`, [
        queueItemId,
        ctx.tenantId,
      ])
    ).rows[0];
    if (!item) throw new NotFoundError('Queue item not found');

    // Both of `assignServiceQueueItem`'s rules, not just one: a technician works their own
    // queue, and a closed item stays closed. The ownership half was carried over when this
    // guard was added and the closed-item half was not, which left any finished item
    // reopenable onto the cockpit board indefinitely.
    const supervises = hasAnyRole(ctx, ROLES.SERVICE_MANAGER, ROLES.SERVICE_ADVISOR);
    if (!supervises && item.assigned_to_user_id && item.assigned_to_user_id !== ctx.userId) {
      throw new ForbiddenError('This queue item is assigned to another user', { code: 'queue_item_taken' });
    }
    if (['done', 'canceled'].includes(item.status) && !['done', 'canceled'].includes(status)) {
      throw new ConflictError(`Queue item is already '${item.status}' and cannot be reopened`, {
        code: 'queue_item_closed',
      });
    }

    // Block reasons are only rewritten when supplied, or cleared when the item unblocks.
    const sets = ['status=$3', 'updated_at=NOW()'];
    const vals: unknown[] = [queueItemId, ctx.tenantId, status];
    if (params.block_reason_codes !== undefined) {
      vals.push(params.block_reason_codes);
      sets.push(`block_reason_codes=$${vals.length}`);
    } else if (status !== 'blocked') {
      sets.push('block_reason_codes=NULL');
    }

    return (
      await tx.query(
        `UPDATE service_queue_items SET ${sets.join(',')} WHERE queue_item_id=$1 AND tenant_id=$2 RETURNING *`,
        vals,
      )
    ).rows[0];
  });
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

/**
 * Books the first-service visit that a completed sale earns, and records the link
 * between the deal and the appointment in `first_service_offers`.
 *
 * That bridge row is what makes retention measurable: `checkIn` marks it `converted`
 * when the appointment becomes a repair order, giving the capture-rate metric both a
 * numerator and a denominator. Previously the `deal_id` was only echoed back to the
 * caller and the link was lost.
 */
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
  requireUuid(params.location_id, 'location_id');
  requireUuid(params.mdm_customer_id, 'mdm_customer_id');
  requireUuid(params.mdm_vehicle_id, 'mdm_vehicle_id');
  if (Number.isNaN(Date.parse(params.recommended_window_start))) {
    throw new ValidationError('recommended_window_start must be a timestamp');
  }
  const language = params.language_preference
    ? requireOneOf(params.language_preference, LANGUAGE_PREFERENCES, 'language_preference')
    : 'en';

  // Appointment and offer are inserted together: if the deal already has an offer, the
  // whole transaction rolls back rather than leaving a stranded appointment behind.
  const { offer, appt } = await withTransaction(async (tx) => {
    const appointment = await insertAppointment(tx, ctx, {
      location_id: params.location_id,
      mdm_customer_id: params.mdm_customer_id,
      mdm_vehicle_id: params.mdm_vehicle_id,
      scheduled_start: params.recommended_window_start,
      source: 'sales_handoff',
      language_preference: language,
      concerns: [{ category: 'first_service', description: 'New vehicle first service', priority: 'p2' }],
    });

    const created = (
      await tx.query(
        `INSERT INTO first_service_offers
           (offer_id,tenant_id,location_id,deal_id,mdm_customer_id,mdm_vehicle_id,appointment_id,status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'offered')
         ON CONFLICT (tenant_id, deal_id) DO NOTHING
         RETURNING *`,
        [
          generateId(), ctx.tenantId, params.location_id, params.deal_id,
          params.mdm_customer_id, params.mdm_vehicle_id, appointment.appointment_id,
        ],
      )
    ).rows[0];

    if (!created) {
      throw new ConflictError('This deal already has a first-service offer', {
        code: 'offer_already_exists',
        details: { deal_id: params.deal_id },
      });
    }
    return { offer: created, appt: appointment };
  });

  svcAppointmentsTotal.inc({ status: 'scheduled', location: params.location_id });
  await emitAudit(ctx, 'retention.first_service_offered', 'first_service_offer', offer.offer_id, {
    deal_id: params.deal_id,
    appointment_id: appt.appointment_id,
  });

  return { offer_id: offer.offer_id, appointment_id: appt.appointment_id, deal_id: params.deal_id, status: 'offer_created' };
}

// ============================================================
// 12) CSPP2 — Customer Service Portal Packager
// ============================================================

const PORTAL_TASK_STATUSES = ['created', 'viewed', 'completed', 'expired', 'canceled'] as const;

export async function listPortalTasks(ctx: AuthContext, roId: string): Promise<any[]> {
  await assertRO({ query }, ctx, roId);
  return (
    await query(
      `SELECT * FROM service_portal_tasks WHERE ro_id=$1 AND tenant_id=$2 ORDER BY created_at DESC`,
      [roId, ctx.tenantId],
    )
  ).rows;
}

export async function updatePortalTaskStatus(
  ctx: AuthContext,
  portalTaskId: string,
  params: { status: string },
): Promise<any> {
  requireUuid(portalTaskId, 'portal_task_id');
  const status = requireOneOf(params.status, PORTAL_TASK_STATUSES, 'status');

  const row = (
    await query(
      `UPDATE service_portal_tasks SET status=$3 WHERE portal_task_id=$1 AND tenant_id=$2 RETURNING *`,
      [portalTaskId, ctx.tenantId, status],
    )
  ).rows[0];
  if (!row) throw new NotFoundError('Portal task not found');
  return row;
}
