import { query } from '../../../shared/database/pool';
import { pruneConsumedStepUpTokens } from '../../../shared/security/step-up';
import { logger } from '../../../shared/utils/logger';
import { aggregatedMetrics } from './service-cockpit-service';

// ============================================================
// Phase 248 — Metrics aggregation
//
// The eleven metrics that cannot be derived from a single request live here. They are
// rates and ratios over a window, so they are computed on a schedule rather than being
// nudged by whichever request happened to arrive — a gauge driven from request traffic
// is last-writer-wins and reports whoever polled last.
//
// Every series is labelled by `location_id`, never by tenant: /metrics is a shared,
// unauthenticated scrape target, and a tenant label would publish a tenant roster.
// Location ids are UUIDs and already tenant-unique.
// ============================================================

const {
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
} = aggregatedMetrics;

/** How far back rate calculations look. */
const WINDOW_DAYS = Number(process.env.METRICS_WINDOW_DAYS ?? 30);

function ratio(numerator: unknown, denominator: unknown): number | null {
  const n = Number(numerator);
  const d = Number(denominator);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return null;
  return n / d;
}

/**
 * Every gauge this module owns, cleared at the start of each pass.
 *
 * Gauges are level readings, not counters: without a reset a queue that drained, or a
 * location that went quiet, would keep publishing its last non-zero value forever.
 * Histograms are deliberately excluded — they are cumulative by definition.
 */
const RESETTABLE_GAUGES = [
  svcPartsBackorderRate,
  svcQCFailRate,
  svcTechUtilization,
  svcTechEfficiency,
  svcTechProficiency,
  svcSLABreachRate,
  svcMPIConversionRate,
  svcComebackRate,
  svcFirstServiceCaptureRate,
  svcQueueDepth,
];

async function refreshPartsMetrics(): Promise<void> {
  const rows = (
    await query(
      `SELECT ro.location_id,
              COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE rpl.status='backordered')::int AS backordered
         FROM ro_parts_lines rpl
         JOIN repair_orders ro ON rpl.ro_id = ro.ro_id AND ro.tenant_id = rpl.tenant_id
        WHERE rpl.created_at > NOW() - ($1 || ' days')::interval
        GROUP BY ro.location_id`,
      [WINDOW_DAYS],
    )
  ).rows;

  for (const row of rows) {
    const rate = ratio(row.backordered, row.total);
    if (rate !== null) svcPartsBackorderRate.set({ location: row.location_id }, rate);
  }

  // Observed once per part, keyed on `received_at` — a timestamp written when the part
  // first arrives and never moved again. Measuring from `updated_at` re-observed the
  // same part as a longer wait every time it progressed to picked, then installed.
  //
  // The high-water mark advances to the largest `received_at` actually read, not to the
  // wall clock: a part received while this query was running would otherwise fall into
  // the gap between the two and never be observed at all.
  const received = (
    await query(
      `SELECT ro.location_id,
              rpl.received_at,
              EXTRACT(EPOCH FROM (rpl.received_at - rpl.created_at)) / 60 AS wait_minutes
         FROM ro_parts_lines rpl
         JOIN repair_orders ro ON rpl.ro_id = ro.ro_id AND ro.tenant_id = rpl.tenant_id
        WHERE rpl.received_at IS NOT NULL
          AND rpl.received_at > $1
        ORDER BY rpl.received_at`,
      [partsWaitHighWater],
    )
  ).rows;

  for (const row of received) {
    const minutes = Number(row.wait_minutes);
    if (Number.isFinite(minutes) && minutes >= 0) {
      svcPartsWaitTime.observe({ location: row.location_id }, minutes);
    }
    const seen = new Date(row.received_at);
    if (seen > partsWaitHighWater) partsWaitHighWater = seen;
  }
}

/** Parts received at or before this instant have already been observed. */
let partsWaitHighWater = new Date(0);

async function refreshQualityMetrics(): Promise<void> {
  // A QC failure is a repair order sent back from qc to in_repair — the transition is
  // in the event log even though no checklist exists yet.
  const rows = (
    await query(
      `SELECT ro.location_id,
              COUNT(*) FILTER (
                WHERE e.payload_ref->>'from' = 'qc' AND e.payload_ref->>'to' = 'in_repair')::int AS failures,
              COUNT(*) FILTER (WHERE e.payload_ref->>'to' = 'qc')::int AS inspections
         FROM ro_events e
         JOIN repair_orders ro ON e.ro_id = ro.ro_id AND ro.tenant_id = e.tenant_id
        WHERE e.event_type = 'status_changed'
          AND e.occurred_at > NOW() - ($1 || ' days')::interval
        GROUP BY ro.location_id`,
      [WINDOW_DAYS],
    )
  ).rows;

  for (const row of rows) {
    const rate = ratio(row.failures, row.inspections);
    if (rate !== null) svcQCFailRate.set({ location: row.location_id }, rate);
  }

  // The denominator is "repair orders that CLOSED in the window", taken from the event
  // log rather than from current status. Opening a comeback flips the original out of
  // `closed`, so a status-based denominator would exclude precisely the repair orders
  // the numerator counts — reporting k/(N−k), and publishing nothing at all in the
  // worst case where every closed order came back.
  const [closings, comebacks] = await Promise.all([
    query(
      `SELECT ro.location_id, COUNT(DISTINCT e.ro_id)::int AS closed_ros
         FROM ro_events e
         JOIN repair_orders ro ON e.ro_id = ro.ro_id AND ro.tenant_id = e.tenant_id
        WHERE e.event_type = 'status_changed'
          AND e.payload_ref->>'to' = 'closed'
          AND e.occurred_at > NOW() - ($1 || ' days')::interval
        GROUP BY ro.location_id`,
      [WINDOW_DAYS],
    ),
    query(
      `SELECT ro.location_id, cc.root_cause_category AS category, COUNT(*)::int AS comebacks
         FROM comeback_cases cc
         JOIN repair_orders ro ON cc.original_ro_id = ro.ro_id AND ro.tenant_id = cc.tenant_id
        WHERE cc.created_at > NOW() - ($1 || ' days')::interval
        GROUP BY ro.location_id, cc.root_cause_category`,
      [WINDOW_DAYS],
    ),
  ]);

  const closedByLocation = new Map<string, number>(
    closings.rows.map((r: any) => [r.location_id, Number(r.closed_ros)]),
  );

  for (const row of comebacks.rows) {
    const rate = ratio(row.comebacks, closedByLocation.get(row.location_id));
    if (rate !== null) svcComebackRate.set({ location: row.location_id, category: row.category }, rate);
  }
}

/**
 * Fixed-ops technician ratios over the window:
 *   efficiency  = sold hours ÷ clocked hours      (are we billing what we work?)
 *   proficiency = estimated hours ÷ clocked hours (do jobs land on the flat rate?)
 *   utilization = clocked hours ÷ scheduled hours (is the bay busy?)
 *
 * Clocked hours come from paired start/resume → pause/stop entries on work tickets, and
 * are attributed to the location of the repair order the work was done on. Capacity is
 * summed separately from `tech_profiles`: joining the two would fan out a technician who
 * holds profiles at more than one location, counting their hours once per profile.
 */
async function refreshTechnicianMetrics(): Promise<void> {
  const [work, capacity] = await Promise.all([
    query(
      `WITH paired AS (
         SELECT te.tenant_id,
                te.ticket_id,
                te.event_type,
                te.occurred_at,
                LEAD(te.occurred_at) OVER (PARTITION BY te.ticket_id ORDER BY te.occurred_at) AS next_at
           FROM tech_time_entries te
          WHERE te.occurred_at > NOW() - ($1 || ' days')::interval
       ),
       worked AS (
         SELECT p.tenant_id, p.ticket_id,
                SUM(EXTRACT(EPOCH FROM (p.next_at - p.occurred_at)) / 3600) AS clocked_hours
           FROM paired p
          WHERE p.event_type IN ('start','resume') AND p.next_at IS NOT NULL
          GROUP BY p.tenant_id, p.ticket_id
       )
       SELECT ro.location_id,
              SUM(w.clocked_hours)                  AS clocked_hours,
              SUM(COALESCE(li.sold_hours, 0))       AS sold_hours,
              SUM(COALESCE(li.estimated_hours, 0))  AS estimated_hours
         FROM worked w
         JOIN tech_work_tickets twt ON twt.ticket_id = w.ticket_id AND twt.tenant_id = w.tenant_id
         JOIN ro_line_items li ON li.line_item_id = twt.line_item_id AND li.tenant_id = twt.tenant_id
         JOIN repair_orders ro ON ro.ro_id = twt.ro_id AND ro.tenant_id = twt.tenant_id
        GROUP BY ro.location_id`,
      [WINDOW_DAYS],
    ),
    query(
      `SELECT location_id,
              SUM(scheduled_hours_per_week * ($1::numeric / 7.0)) AS scheduled_hours
         FROM tech_profiles
        WHERE status = 'active'
        GROUP BY location_id`,
      [WINDOW_DAYS],
    ),
  ]);

  const scheduledByLocation = new Map<string, number>(
    capacity.rows.map((r: any) => [r.location_id, Number(r.scheduled_hours)]),
  );

  for (const row of work.rows) {
    const efficiency = ratio(row.sold_hours, row.clocked_hours);
    const proficiency = ratio(row.estimated_hours, row.clocked_hours);
    const utilization = ratio(row.clocked_hours, scheduledByLocation.get(row.location_id));
    if (efficiency !== null) svcTechEfficiency.set({ location: row.location_id }, efficiency);
    if (proficiency !== null) svcTechProficiency.set({ location: row.location_id }, proficiency);
    if (utilization !== null) svcTechUtilization.set({ location: row.location_id }, utilization);
  }
}

async function refreshQueueMetrics(): Promise<void> {
  const depth = (
    await query(
      `SELECT location_id, queue_type, COUNT(*)::int AS cnt
         FROM service_queue_items
        WHERE status NOT IN ('done','canceled')
        GROUP BY location_id, queue_type`,
    )
  ).rows;

  for (const row of depth) {
    svcQueueDepth.set({ queue_type: row.queue_type, location: row.location_id }, Number(row.cnt));
  }

  const sla = (
    await query(
      `SELECT location_id, queue_type,
              COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE sla_due_at < NOW() AND status IN ('queued','in_progress'))::int AS breached
         FROM service_queue_items
        WHERE sla_due_at IS NOT NULL
          AND created_at > NOW() - ($1 || ' days')::interval
        GROUP BY location_id, queue_type`,
      [WINDOW_DAYS],
    )
  ).rows;

  for (const row of sla) {
    const rate = ratio(row.breached, row.total);
    if (rate !== null) svcSLABreachRate.set({ job_type: row.queue_type, location: row.location_id }, rate);
  }
}

async function refreshConversionMetrics(): Promise<void> {
  // How many recommendations put in front of a customer were accepted, by priority —
  // the closest thing the schema has to a recommendation "type".
  const rows = (
    await query(
      `SELECT priority AS recommendation_type,
              COUNT(*) FILTER (WHERE status='accepted')::int AS accepted,
              COUNT(*) FILTER (WHERE status IN ('sent_to_customer','accepted','declined','expired'))::int AS presented
         FROM service_recommendations
        WHERE created_at > NOW() - ($1 || ' days')::interval
        GROUP BY priority`,
      [WINDOW_DAYS],
    )
  ).rows;

  for (const row of rows) {
    const rate = ratio(row.accepted, row.presented);
    if (rate !== null) svcMPIConversionRate.set({ recommendation_type: row.recommendation_type }, rate);
  }

  const retention = (
    await query(
      `SELECT location_id,
              COUNT(*) FILTER (WHERE status='converted')::int AS converted,
              COUNT(*)::int AS offered
         FROM first_service_offers
        WHERE offered_at > NOW() - ($1 || ' days')::interval
        GROUP BY location_id`,
      [WINDOW_DAYS],
    )
  ).rows;

  for (const row of retention) {
    const rate = ratio(row.converted, row.offered);
    if (rate !== null) svcFirstServiceCaptureRate.set({ location: row.location_id }, rate);
  }
}

async function pruneExpiredStepUpTokens(): Promise<void> {
  const removed = await pruneConsumedStepUpTokens({ query });
  if (removed > 0) logger.debug({ removed }, 'Pruned consumed step-up tokens');
}

/**
 * Recomputes every scheduled metric. Safe to call concurrently with request traffic —
 * it only reads, apart from pruning expired step-up ledger rows. A failure in one group
 * does not stop the others: a stale gauge beats no metrics at all, and the next pass
 * corrects it.
 */
export async function refreshAggregatedMetrics(): Promise<void> {
  for (const gauge of RESETTABLE_GAUGES) gauge.reset();

  const groups: Array<[string, () => Promise<void>]> = [
    ['parts', refreshPartsMetrics],
    ['quality', refreshQualityMetrics],
    ['technicians', refreshTechnicianMetrics],
    ['queues', refreshQueueMetrics],
    ['conversion', refreshConversionMetrics],
    ['step_up_ledger', pruneExpiredStepUpTokens],
  ];

  for (const [name, run] of groups) {
    try {
      await run();
    } catch (err) {
      logger.error({ err, group: name }, 'Metrics aggregation group failed');
    }
  }
}

/**
 * Starts the periodic refresh. Returns a stop function. The timer is unref'd so it
 * never holds the process open during shutdown.
 */
export function startMetricsAggregation(intervalMs = Number(process.env.METRICS_INTERVAL_MS ?? 60_000)): () => void {
  let running = false;

  const tick = async () => {
    if (running) return; // a slow pass must not overlap the next one
    running = true;
    try {
      await refreshAggregatedMetrics();
    } finally {
      running = false;
    }
  };

  void tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();

  return () => clearInterval(timer);
}
