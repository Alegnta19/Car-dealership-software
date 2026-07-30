import * as promClient from 'prom-client';
import { query } from '@dealer/database';
import { pruneConsumedStepUpTokens } from '../security/step-up';
import { logger } from '@dealer/platform';
import { aggregatedMetrics, COMEBACK_ROOT_CAUSES, QUEUE_TYPES } from './service-cockpit-service';

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

type Publish = () => void;

/** How far back rate calculations look. */
const WINDOW_DAYS = Number(process.env.METRICS_WINDOW_DAYS ?? 30);

/*
 * Label values that come from a database column are bounded here before they reach the
 * registry.
 *
 * `queue_type` and `root_cause_category` carry CHECK constraints, but both were added
 * NOT VALID so that history containing free text would not block the migration — which
 * means the columns can still hold arbitrary strings today. /metrics is unauthenticated
 * and a Prometheus label is a new time series per distinct value, so publishing those
 * strings verbatim turned old free-text data into unbounded cardinality on a public
 * surface. Anything outside the known set is reported as `other`: the series stays
 * countable and the unrecognised value is logged once per pass instead.
 */
const KNOWN_QUEUE_TYPES: ReadonlySet<string> = new Set(QUEUE_TYPES);
const KNOWN_ROOT_CAUSES: ReadonlySet<string> = new Set(COMEBACK_ROOT_CAUSES);

function boundedLabel(value: unknown, known: ReadonlySet<string>, field: string): string {
  if (typeof value === 'string' && known.has(value)) return value;
  logger.debug({ field, value }, 'Unrecognised label value collapsed to "other"');
  return 'other';
}

function ratio(numerator: unknown, denominator: unknown): number | null {
  const n = Number(numerator);
  const d = Number(denominator);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return null;
  return n / d;
}

/*
 * Gauges are level readings, not counters, so each pass clears them before republishing —
 * otherwise a queue that drained, or a location that went quiet, would keep reporting its
 * last non-zero value forever. The clearing is done per group (see the group table in
 * `refreshAggregatedMetrics`) so one failing query cannot blank unrelated series.
 * Histograms are excluded throughout: they are cumulative by definition.
 */

async function refreshPartsMetrics(): Promise<Publish> {
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

  const publishBackorder: Publish = () => {
    for (const row of rows) {
      const rate = ratio(row.backordered, row.total);
      if (rate !== null) svcPartsBackorderRate.set({ location: row.location_id }, rate);
    }
  };

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

  return publishBackorder;
}

/**
 * Parts received at or before this instant have already been observed.
 *
 * Process-local, and deliberately initialised to "now" rather than the epoch: the
 * histogram it feeds is cumulative and resets with the process, so starting at the epoch
 * made every restart replay the entire parts history into it, spiking the count and
 * skewing every quantile. A restart now simply resumes from the moment it came up.
 */
let partsWaitHighWater = new Date();

async function refreshQualityMetrics(): Promise<Publish> {
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

  const publishQC: Publish = () => {
    for (const row of rows) {
      const rate = ratio(row.failures, row.inspections);
      if (rate !== null) svcQCFailRate.set({ location: row.location_id }, rate);
    }
  };

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
    // Same cohort as the denominator: comebacks against repair orders that CLOSED in the
    // window, not comebacks RAISED in it. Counting by raise date mixed in returns against
    // work closed months earlier, which can report more comebacks than there were closures.
    query(
      `SELECT ro.location_id, cc.root_cause_category AS category, COUNT(DISTINCT cc.comeback_id)::int AS comebacks
         FROM comeback_cases cc
         JOIN repair_orders ro ON cc.original_ro_id = ro.ro_id AND ro.tenant_id = cc.tenant_id
         JOIN ro_events e ON e.ro_id = cc.original_ro_id AND e.tenant_id = cc.tenant_id
        WHERE e.event_type = 'status_changed'
          AND e.payload_ref->>'to' = 'closed'
          AND e.occurred_at > NOW() - ($1 || ' days')::interval
        GROUP BY ro.location_id, cc.root_cause_category`,
      [WINDOW_DAYS],
    ),
  ]);

  const closedByLocation = new Map<string, number>(
    closings.rows.map((r: any) => [r.location_id, Number(r.closed_ros)]),
  );

  return () => {
    publishQC();
    for (const row of comebacks.rows) {
      const rate = ratio(row.comebacks, closedByLocation.get(row.location_id));
      if (rate !== null) {
        svcComebackRate.set(
          { location: row.location_id, category: boundedLabel(row.category, KNOWN_ROOT_CAUSES, 'root_cause_category') },
          rate,
        );
      }
    }
  };
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
async function refreshTechnicianMetrics(): Promise<Publish> {
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
       ),
       clocked AS (
         SELECT twt.tenant_id, twt.line_item_id, SUM(w.clocked_hours) AS clocked_hours
           FROM worked w
           JOIN tech_work_tickets twt ON twt.ticket_id = w.ticket_id AND twt.tenant_id = w.tenant_id
          GROUP BY twt.tenant_id, twt.line_item_id
       )
       -- Rolled up per LINE ITEM before joining it: a line worked under two tickets
       -- (a reassignment, a paused-and-resumed job) otherwise contributed its sold and
       -- estimated hours once per ticket, inflating efficiency and proficiency.
       -- Two different populations, deliberately. Efficiency and proficiency compare a
       -- WHOLE-LINE figure (sold, estimated) against clocked time, so they may only count
       -- lines whose work has finished; a half-worked line makes the bay look ever more
       -- efficient the longer it stays open. Utilization has no whole-line numerator --
       -- clocked hours are clocked hours -- so restricting it to completed lines would
       -- have hidden every hour spent on work still in progress.
       SELECT ro.location_id,
              SUM(c.clocked_hours)                                                       AS clocked_hours,
              SUM(c.clocked_hours) FILTER (WHERE li.status = 'completed')                AS clocked_hours_done,
              SUM(COALESCE(li.sold_hours, 0)) FILTER (WHERE li.status = 'completed')      AS sold_hours,
              SUM(COALESCE(li.estimated_hours, 0)) FILTER (WHERE li.status = 'completed') AS estimated_hours
         FROM clocked c
         JOIN ro_line_items li ON li.line_item_id = c.line_item_id AND li.tenant_id = c.tenant_id
         JOIN repair_orders ro ON ro.ro_id = li.ro_id AND ro.tenant_id = li.tenant_id
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

  return () => {
    for (const row of work.rows) {
      const efficiency = ratio(row.sold_hours, row.clocked_hours_done);
      const proficiency = ratio(row.estimated_hours, row.clocked_hours_done);
      const utilization = ratio(row.clocked_hours, scheduledByLocation.get(row.location_id));
      if (efficiency !== null) svcTechEfficiency.set({ location: row.location_id }, efficiency);
      if (proficiency !== null) svcTechProficiency.set({ location: row.location_id }, proficiency);
      if (utilization !== null) svcTechUtilization.set({ location: row.location_id }, utilization);
    }
  };
}

async function refreshQueueMetrics(): Promise<Publish> {
  const depth = (
    await query(
      `SELECT location_id, queue_type, COUNT(*)::int AS cnt
         FROM service_queue_items
        WHERE status NOT IN ('done','canceled')
        GROUP BY location_id, queue_type`,
    )
  ).rows;


  // A breach counts whether or not the item is still open. Filtering the numerator to
  // 'queued'/'in_progress' meant an item that blew its SLA and was then completed left
  // the numerator while staying in the denominator — so the worse a shop performed at
  // clearing overdue work, the better its breach rate looked.
  const sla = (
    await query(
      `SELECT location_id, queue_type,
              COUNT(*)::int AS total,
              COUNT(*) FILTER (
                WHERE sla_due_at < COALESCE(completed_at, NOW()))::int AS breached
         FROM (
           -- updated_at is a last-modified column the trigger bumps on ANY later touch,
           -- so using it as the completion time let an unrelated edit retroactively turn an
           -- on-time item into a breach. Judged against now instead: an item that is closed
           -- and was never overdue while open cannot become overdue afterwards.
           SELECT location_id, queue_type, sla_due_at,
                  CASE WHEN status IN ('done','canceled') THEN LEAST(updated_at, NOW()) END AS completed_at
             FROM service_queue_items
            WHERE sla_due_at IS NOT NULL
              AND created_at > NOW() - ($1 || ' days')::interval
         ) q
        GROUP BY location_id, queue_type`,
      [WINDOW_DAYS],
    )
  ).rows;

  return () => {
    // Several raw queue_type values can collapse onto `other`, so depths are summed
    // per published label rather than set — otherwise the last row written would win and
    // the depth would under-report.
    const depthByLabel = new Map<string, number>();
    for (const row of depth) {
      const label = boundedLabel(row.queue_type, KNOWN_QUEUE_TYPES, 'queue_type');
      const key = `${label} ${row.location_id}`;
      depthByLabel.set(key, (depthByLabel.get(key) ?? 0) + Number(row.cnt));
    }
    for (const [key, cnt] of depthByLabel) {
      const [queue_type, location] = key.split(' ');
      svcQueueDepth.set({ queue_type, location }, cnt);
    }

    // Breach rates are ratios, so collapsed labels must be recombined from their parts
    // before dividing; averaging two rates would weight a 1-item queue like a 100-item one.
    const slaByLabel = new Map<string, { breached: number; total: number }>();
    for (const row of sla) {
      const label = boundedLabel(row.queue_type, KNOWN_QUEUE_TYPES, 'queue_type');
      const key = `${label} ${row.location_id}`;
      const acc = slaByLabel.get(key) ?? { breached: 0, total: 0 };
      acc.breached += Number(row.breached);
      acc.total += Number(row.total);
      slaByLabel.set(key, acc);
    }
    for (const [key, acc] of slaByLabel) {
      const [job_type, location] = key.split(' ');
      const rate = ratio(acc.breached, acc.total);
      if (rate !== null) svcSLABreachRate.set({ job_type, location }, rate);
    }
  };
}

async function refreshConversionMetrics(): Promise<Publish> {
  // How many recommendations put in front of a customer were accepted, by priority —
  // the closest thing the schema has to a recommendation "type".
  // Grouped by location as well as priority. Grouping by priority alone blended every
  // tenant into one global series, so a shop converting 100% and one converting 0%
  // published as 50% and neither could see its own number.
  const rows = (
    await query(
      `SELECT ro.location_id, sr.priority AS recommendation_type,
              COUNT(*) FILTER (WHERE sr.status='accepted')::int AS accepted,
              COUNT(*) FILTER (WHERE sr.status IN ('sent_to_customer','accepted','declined','expired'))::int AS presented
         FROM service_recommendations sr
         JOIN repair_orders ro ON ro.ro_id = sr.ro_id AND ro.tenant_id = sr.tenant_id
        WHERE sr.created_at > NOW() - ($1 || ' days')::interval
        GROUP BY ro.location_id, sr.priority`,
      [WINDOW_DAYS],
    )
  ).rows;


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

  return () => {
    for (const row of rows) {
      const rate = ratio(row.accepted, row.presented);
      if (rate !== null) {
        svcMPIConversionRate.set({ recommendation_type: row.recommendation_type, location: row.location_id }, rate);
      }
    }
    for (const row of retention) {
      const rate = ratio(row.converted, row.offered);
      if (rate !== null) svcFirstServiceCaptureRate.set({ location: row.location_id }, rate);
    }
  };
}

async function pruneExpiredStepUpTokens(): Promise<Publish> {
  const removed = await pruneConsumedStepUpTokens({ query });
  if (removed > 0) logger.debug({ removed }, 'Pruned consumed step-up tokens');
  return () => undefined;
}

/**
 * Recomputes every scheduled metric. Safe to call concurrently with request traffic —
 * it only reads, apart from pruning expired step-up ledger rows. A failure in one group
 * does not stop the others: a stale gauge beats no metrics at all, and the next pass
 * corrects it.
 */
export async function refreshAggregatedMetrics(): Promise<void> {
  // Each group clears only its OWN gauges, and only once it has data to replace them
  // with. Resetting everything up front meant one failing query blanked every series for
  // a whole interval — the opposite of the "a stale gauge beats no metrics" intent.
  const groups: Array<[string, () => Promise<Publish>, promClient.Gauge<string>[]]> = [
    ['parts', refreshPartsMetrics, [svcPartsBackorderRate]],
    ['quality', refreshQualityMetrics, [svcQCFailRate, svcComebackRate]],
    ['technicians', refreshTechnicianMetrics, [svcTechUtilization, svcTechEfficiency, svcTechProficiency]],
    ['queues', refreshQueueMetrics, [svcQueueDepth, svcSLABreachRate]],
    ['conversion', refreshConversionMetrics, [svcMPIConversionRate, svcFirstServiceCaptureRate]],
    ['step_up_ledger', pruneExpiredStepUpTokens, []],
  ];

  for (const [name, run, owned] of groups) {
    try {
      // Collect first, then clear and publish together. Clearing before the query meant a
      // transient failure wiped the group's series for the whole interval, which is exactly
      // the outcome the per-group split was meant to avoid.
      const publish = await run();
      for (const gauge of owned) gauge.reset();
      publish();
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
