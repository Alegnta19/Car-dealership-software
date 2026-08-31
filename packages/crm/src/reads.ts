/**
 * RELEASE TRAIN 3, ROW 6 — WHAT THE OWNER AND THE MANAGER ACTUALLY SEE.
 *
 * THE ROOFTOP LIST IS THE AUTHORIZATION FILTER, AND IT IS APPLIED IN SQL.
 * Every read here takes the rooftops the actor may see and puts them in the
 * WHERE clause. Filtering after the query would mean the database handed the
 * process rows it may not show, and the only thing standing between that and a
 * leak would be that nobody forgot a `filter()` — which is not a boundary, it
 * is a habit.
 *
 * THE COUNTS ARE COMPUTED, NEVER STORED. A dashboard that reads a maintained
 * counter is a dashboard that is wrong the first time a write path forgets to
 * increment it, and it is wrong quietly.
 */
import { withTenantTransaction, type Executor } from '@dealer/database';
import { REVENUE_NOT_YET_AVAILABLE } from './attribution';

interface Row {
  [key: string]: unknown;
}

export interface RooftopRef {
  readonly rooftopId: string;
  readonly name: string;
}

export async function listRooftops(tenantId: string, rooftopIds: string[]): Promise<RooftopRef[]> {
  return withTenantTransaction(tenantId, async (tx) => {
    const found = await tx.query(
      `SELECT rooftop_id, name FROM rooftops
        WHERE tenant_id = $1 AND rooftop_id = ANY($2::uuid[]) AND status = 'active'
        ORDER BY name`,
      [tenantId, rooftopIds],
    );
    return (found.rows as Row[]).map((r) => ({
      rooftopId: String(r.rooftop_id),
      name: String(r.name),
    }));
  });
}

export interface LeadRow {
  readonly leadId: string;
  readonly rooftopId: string;
  readonly rooftopName: string;
  readonly partyId: string;
  readonly customerName: string;
  readonly lifecycleState: string;
  readonly disposition: string | null;
  readonly ownerUserLinkId: string | null;
  readonly sourceCode: string;
  readonly interestSummary: string | null;
  readonly ageHours: number;
  readonly firstResponseDueAt: string | null;
  readonly firstResponseAt: string | null;
  readonly slaBreached: boolean;
  readonly escalated: boolean;
  readonly authorizationVersion: number;
}

/**
 * The working list. `slaBreached` is DERIVED at read time from the clock and
 * the answer, not stored: an unanswered lead becomes breached by the passage of
 * time, and nothing writes to the row when time passes.
 */
export async function listLeads(input: {
  tenantId: string;
  rooftopIds: string[];
  state?: string | null | undefined;
  ownerUserLinkId?: string | null | undefined;
  limit?: number | undefined;
}): Promise<LeadRow[]> {
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
  return withTenantTransaction(input.tenantId, async (tx) => {
    const found = await tx.query(
      `SELECT l.lead_id, l.rooftop_id, r.name AS rooftop_name, l.party_id,
              p.display_name AS customer_name, l.lifecycle_state, l.disposition,
              l.owner_user_link_id, s.source_code,
              COALESCE(si.stock_number, v.model, NULL) AS interest_summary,
              EXTRACT(EPOCH FROM (NOW() - l.created_at)) / 3600.0 AS age_hours,
              l.first_response_due_at, l.first_response_at,
              (l.first_response_at IS NULL
                 AND l.first_response_due_at IS NOT NULL
                 AND l.first_response_due_at <= NOW()) AS sla_breached,
              (l.escalated_at IS NOT NULL) AS escalated,
              l.authorization_version
         FROM leads l
         JOIN rooftops r ON r.tenant_id = l.tenant_id AND r.rooftop_id = l.rooftop_id
         JOIN parties p ON p.tenant_id = l.tenant_id AND p.party_id = l.party_id
         JOIN lead_sources s
           ON s.tenant_id = l.tenant_id AND s.lead_source_id = l.primary_source_id
         LEFT JOIN stock_items si
           ON si.tenant_id = l.tenant_id AND si.stock_item_id = l.interest_stock_item_id
         LEFT JOIN vehicles v
           ON v.tenant_id = l.tenant_id AND v.vehicle_id = l.interest_vehicle_id
        WHERE l.tenant_id = $1
          AND l.rooftop_id = ANY($2::uuid[])
          AND ($3::text IS NULL OR l.lifecycle_state = $3)
          AND ($4::uuid IS NULL OR l.owner_user_link_id = $4)
        ORDER BY l.created_at DESC
        LIMIT $5`,
      [input.tenantId, input.rooftopIds, input.state ?? null, input.ownerUserLinkId ?? null, limit],
    );
    return (found.rows as Row[]).map((r) => ({
      leadId: String(r.lead_id),
      rooftopId: String(r.rooftop_id),
      rooftopName: String(r.rooftop_name),
      partyId: String(r.party_id),
      customerName: String(r.customer_name),
      lifecycleState: String(r.lifecycle_state),
      disposition: r.disposition === null ? null : String(r.disposition),
      ownerUserLinkId: r.owner_user_link_id === null ? null : String(r.owner_user_link_id),
      sourceCode: String(r.source_code),
      interestSummary: r.interest_summary === null ? null : String(r.interest_summary),
      ageHours: Math.round(Number(r.age_hours) * 10) / 10,
      firstResponseDueAt:
        r.first_response_due_at === null
          ? null
          : new Date(r.first_response_due_at as string).toISOString(),
      firstResponseAt:
        r.first_response_at === null ? null : new Date(r.first_response_at as string).toISOString(),
      slaBreached: r.sla_breached === true,
      escalated: r.escalated === true,
      authorizationVersion: Number(r.authorization_version),
    }));
  });
}

export interface TimelineEntry {
  readonly at: string;
  readonly kind: string;
  readonly summary: string;
  readonly detail: string | null;
}

/**
 * ONE TIMELINE, MERGED IN SQL AND ORDERED ONCE. Activities, appointment
 * history, lifecycle moves and source touches are four tables and one story;
 * merging them in the query means there is exactly one ordering, rather than
 * four lists a screen has to interleave and can interleave differently.
 */
export async function leadTimeline(
  tenantId: string,
  leadId: string,
  rooftopIds: string[],
): Promise<TimelineEntry[]> {
  return withTenantTransaction(tenantId, async (tx) => {
    const visible = await tx.query(
      `SELECT 1 FROM leads
        WHERE tenant_id = $1 AND lead_id = $2 AND rooftop_id = ANY($3::uuid[])`,
      [tenantId, leadId, rooftopIds],
    );
    if (visible.rows.length === 0) return [];
    const found = await tx.query(
      `SELECT at, kind, summary, detail FROM (
         SELECT a.created_at AS at, 'activity.' || a.kind AS kind, a.subject AS summary,
                a.direction AS detail
           FROM lead_activities a WHERE a.tenant_id = $1 AND a.lead_id = $2
         UNION ALL
         SELECT e.occurred_at, 'status', e.from_state || ' -> ' || e.to_state, e.note
           FROM lead_status_events e WHERE e.tenant_id = $1 AND e.lead_id = $2
         UNION ALL
         SELECT t.occurred_at, 'touch', s.source_code, NULL
           FROM lead_source_touches t
           JOIN lead_sources s
             ON s.tenant_id = t.tenant_id AND s.lead_source_id = t.lead_source_id
          WHERE t.tenant_id = $1 AND t.lead_id = $2
         UNION ALL
         SELECT ae.occurred_at, 'appointment.' || ae.event_type, ap.purpose, ae.note
           FROM appointment_events ae
           JOIN appointments ap
             ON ap.tenant_id = ae.tenant_id AND ap.appointment_id = ae.appointment_id
          WHERE ae.tenant_id = $1 AND ap.lead_id = $2
       ) merged
       ORDER BY at, kind`,
      [tenantId, leadId],
    );
    return (found.rows as Row[]).map((r) => ({
      at: new Date(r.at as string).toISOString(),
      kind: String(r.kind),
      summary: String(r.summary),
      detail: r.detail === null ? null : String(r.detail),
    }));
  });
}

export interface CrmOverview {
  readonly rooftops: RooftopRef[];
  readonly leads: {
    readonly open: number;
    readonly new: number;
    readonly working: number;
    readonly qualified: number;
    readonly appointmentSet: number;
    readonly handedOff: number;
    readonly closed: number;
  };
  readonly sla: {
    readonly awaitingFirstResponse: number;
    readonly breached: number;
    readonly escalated: number;
    readonly medianFirstResponseMinutes: number | null;
  };
  readonly appointments: {
    readonly upcoming: number;
    readonly completed: number;
    readonly cancelled: number;
    readonly noShow: number;
  };
  readonly campaigns: {
    readonly active: number;
    readonly executing: number;
    readonly sent: number;
    readonly suppressed: number;
    readonly deferred: number;
    readonly responses: number;
    readonly optOuts: number;
  };
  readonly bySource: Array<{ sourceCode: string; displayName: string; leads: number }>;
  readonly revenueStatus: 'NOT_YET_AVAILABLE' | 'AVAILABLE';
  readonly roiStatus: 'NOT_YET_AVAILABLE' | 'AVAILABLE';
}

/**
 * THE MANAGER'S VIEW, across the rooftops this actor may see and no others.
 *
 * Revenue and ROI are carried as explicit statuses rather than as numbers or
 * omissions, for the same reason the attribution report does it: a missing
 * field reads as zero to a person looking at a dashboard.
 */
export async function crmOverview(tenantId: string, rooftopIds: string[]): Promise<CrmOverview> {
  return withTenantTransaction(tenantId, async (tx) => {
    const rooftops = await readRooftops(tx, tenantId, rooftopIds);
    const leads = await tx.query(
      `SELECT
         COUNT(*) FILTER (WHERE lifecycle_state NOT IN ('handed_off','closed'))::int AS open,
         COUNT(*) FILTER (WHERE lifecycle_state = 'new')::int AS new,
         COUNT(*) FILTER (WHERE lifecycle_state = 'working')::int AS working,
         COUNT(*) FILTER (WHERE lifecycle_state = 'qualified')::int AS qualified,
         COUNT(*) FILTER (WHERE lifecycle_state = 'appointment_set')::int AS appointment_set,
         COUNT(*) FILTER (WHERE lifecycle_state = 'handed_off')::int AS handed_off,
         COUNT(*) FILTER (WHERE lifecycle_state = 'closed')::int AS closed,
         COUNT(*) FILTER (WHERE first_response_at IS NULL
                            AND lifecycle_state NOT IN ('handed_off','closed'))::int AS awaiting,
         COUNT(*) FILTER (WHERE first_response_at IS NULL
                            AND first_response_due_at IS NOT NULL
                            AND first_response_due_at <= NOW()
                            AND lifecycle_state NOT IN ('handed_off','closed'))::int AS breached,
         COUNT(*) FILTER (WHERE escalated_at IS NOT NULL)::int AS escalated,
         PERCENTILE_CONT(0.5) WITHIN GROUP (
           ORDER BY EXTRACT(EPOCH FROM (first_response_at - created_at)) / 60.0
         ) FILTER (WHERE first_response_at IS NOT NULL) AS median_first_response
       FROM leads
      WHERE tenant_id = $1 AND rooftop_id = ANY($2::uuid[])`,
      [tenantId, rooftopIds],
    );
    const l = leads.rows[0] as Row;

    const appointments = await tx.query(
      `SELECT
         COUNT(*) FILTER (WHERE state IN ('scheduled','confirmed') AND starts_at >= NOW())::int
           AS upcoming,
         COUNT(*) FILTER (WHERE state = 'completed')::int AS completed,
         COUNT(*) FILTER (WHERE state = 'cancelled')::int AS cancelled,
         COUNT(*) FILTER (WHERE state = 'no_show')::int AS no_show
       FROM appointments WHERE tenant_id = $1 AND rooftop_id = ANY($2::uuid[])`,
      [tenantId, rooftopIds],
    );
    const a = appointments.rows[0] as Row;

    const campaigns = await tx.query(
      `SELECT
         (SELECT COUNT(*) FROM campaigns c
           WHERE c.tenant_id = $1 AND c.rooftop_id = ANY($2::uuid[])
             AND c.status = 'active')::int AS active,
         (SELECT COUNT(*) FROM campaign_versions v
            JOIN campaigns c ON c.tenant_id = v.tenant_id AND c.campaign_id = v.campaign_id
           WHERE v.tenant_id = $1 AND c.rooftop_id = ANY($2::uuid[])
             AND v.state = 'executing')::int AS executing,
         (SELECT COUNT(*) FROM campaign_sends s
            JOIN campaign_versions v
              ON v.tenant_id = s.tenant_id AND v.campaign_version_id = s.campaign_version_id
            JOIN campaigns c ON c.tenant_id = v.tenant_id AND c.campaign_id = v.campaign_id
           WHERE s.tenant_id = $1 AND c.rooftop_id = ANY($2::uuid[])
             AND s.state = 'sent')::int AS sent,
         (SELECT COUNT(*) FROM campaign_sends s
            JOIN campaign_versions v
              ON v.tenant_id = s.tenant_id AND v.campaign_version_id = s.campaign_version_id
            JOIN campaigns c ON c.tenant_id = v.tenant_id AND c.campaign_id = v.campaign_id
           WHERE s.tenant_id = $1 AND c.rooftop_id = ANY($2::uuid[])
             AND s.state = 'suppressed')::int AS suppressed,
         (SELECT COUNT(*) FROM campaign_sends s
            JOIN campaign_versions v
              ON v.tenant_id = s.tenant_id AND v.campaign_version_id = s.campaign_version_id
            JOIN campaigns c ON c.tenant_id = v.tenant_id AND c.campaign_id = v.campaign_id
           WHERE s.tenant_id = $1 AND c.rooftop_id = ANY($2::uuid[])
             AND s.state = 'deferred_quiet_hours')::int AS deferred,
         (SELECT COUNT(*) FROM campaign_responses cr
            JOIN campaign_sends s ON s.tenant_id = cr.tenant_id AND s.send_id = cr.send_id
            JOIN campaign_versions v
              ON v.tenant_id = s.tenant_id AND v.campaign_version_id = s.campaign_version_id
            JOIN campaigns c ON c.tenant_id = v.tenant_id AND c.campaign_id = v.campaign_id
           WHERE cr.tenant_id = $1 AND c.rooftop_id = ANY($2::uuid[]))::int AS responses,
         (SELECT COUNT(*) FROM campaign_responses cr
            JOIN campaign_sends s ON s.tenant_id = cr.tenant_id AND s.send_id = cr.send_id
            JOIN campaign_versions v
              ON v.tenant_id = s.tenant_id AND v.campaign_version_id = s.campaign_version_id
            JOIN campaigns c ON c.tenant_id = v.tenant_id AND c.campaign_id = v.campaign_id
           WHERE cr.tenant_id = $1 AND c.rooftop_id = ANY($2::uuid[])
             AND cr.response_type = 'opt_out')::int AS opt_outs`,
      [tenantId, rooftopIds],
    );
    const c = campaigns.rows[0] as Row;

    const bySource = await tx.query(
      `SELECT s.source_code, s.display_name, COUNT(l.lead_id)::int AS leads
         FROM lead_sources s
         LEFT JOIN leads l
           ON l.tenant_id = s.tenant_id AND l.primary_source_id = s.lead_source_id
          AND l.rooftop_id = ANY($2::uuid[])
        WHERE s.tenant_id = $1 AND s.status = 'active'
        GROUP BY s.source_code, s.display_name
        ORDER BY COUNT(l.lead_id) DESC, s.source_code`,
      [tenantId, rooftopIds],
    );

    return {
      rooftops,
      leads: {
        open: Number(l.open),
        new: Number(l.new),
        working: Number(l.working),
        qualified: Number(l.qualified),
        appointmentSet: Number(l.appointment_set),
        handedOff: Number(l.handed_off),
        closed: Number(l.closed),
      },
      sla: {
        awaitingFirstResponse: Number(l.awaiting),
        breached: Number(l.breached),
        escalated: Number(l.escalated),
        medianFirstResponseMinutes:
          l.median_first_response === null
            ? null
            : Math.round(Number(l.median_first_response) * 10) / 10,
      },
      appointments: {
        upcoming: Number(a.upcoming),
        completed: Number(a.completed),
        cancelled: Number(a.cancelled),
        noShow: Number(a.no_show),
      },
      campaigns: {
        active: Number(c.active),
        executing: Number(c.executing),
        sent: Number(c.sent),
        suppressed: Number(c.suppressed),
        deferred: Number(c.deferred),
        responses: Number(c.responses),
        optOuts: Number(c.opt_outs),
      },
      bySource: (bySource.rows as Row[]).map((r) => ({
        sourceCode: String(r.source_code),
        displayName: String(r.display_name),
        leads: Number(r.leads),
      })),
      revenueStatus: REVENUE_NOT_YET_AVAILABLE,
      roiStatus: REVENUE_NOT_YET_AVAILABLE,
    };
  });
}

async function readRooftops(
  executor: Executor,
  tenantId: string,
  rooftopIds: string[],
): Promise<RooftopRef[]> {
  const found = await executor.query(
    `SELECT rooftop_id, name FROM rooftops
      WHERE tenant_id = $1 AND rooftop_id = ANY($2::uuid[]) AND status = 'active'
      ORDER BY name`,
    [tenantId, rooftopIds],
  );
  return (found.rows as Row[]).map((r) => ({
    rooftopId: String(r.rooftop_id),
    name: String(r.name),
  }));
}

export interface CampaignSendSummary {
  readonly campaignVersionId: string;
  readonly state: string;
  readonly pending: number;
  readonly sent: number;
  readonly failed: number;
  readonly suppressed: number;
  readonly deferred: number;
  readonly responses: number;
}

export async function campaignSendSummary(
  tenantId: string,
  campaignVersionId: string,
  rooftopIds: string[],
): Promise<CampaignSendSummary | null> {
  return withTenantTransaction(tenantId, async (tx) => {
    const found = await tx.query(
      `SELECT v.campaign_version_id, v.state,
              COUNT(s.send_id) FILTER (WHERE s.state = 'pending')::int AS pending,
              COUNT(s.send_id) FILTER (WHERE s.state = 'sent')::int AS sent,
              COUNT(s.send_id) FILTER (WHERE s.state = 'failed')::int AS failed,
              COUNT(s.send_id) FILTER (WHERE s.state = 'suppressed')::int AS suppressed,
              COUNT(s.send_id) FILTER (WHERE s.state = 'deferred_quiet_hours')::int AS deferred,
              (SELECT COUNT(*) FROM campaign_responses cr
                 JOIN campaign_sends cs ON cs.tenant_id = cr.tenant_id AND cs.send_id = cr.send_id
                WHERE cr.tenant_id = v.tenant_id
                  AND cs.campaign_version_id = v.campaign_version_id)::int AS responses
         FROM campaign_versions v
         JOIN campaigns c ON c.tenant_id = v.tenant_id AND c.campaign_id = v.campaign_id
         LEFT JOIN campaign_sends s
           ON s.tenant_id = v.tenant_id AND s.campaign_version_id = v.campaign_version_id
        WHERE v.tenant_id = $1 AND v.campaign_version_id = $2
          AND c.rooftop_id = ANY($3::uuid[])
        GROUP BY v.campaign_version_id, v.state, v.tenant_id`,
      [tenantId, campaignVersionId, rooftopIds],
    );
    if (found.rows.length === 0) return null;
    const r = found.rows[0] as Row;
    return {
      campaignVersionId: String(r.campaign_version_id),
      state: String(r.state),
      pending: Number(r.pending),
      sent: Number(r.sent),
      failed: Number(r.failed),
      suppressed: Number(r.suppressed),
      deferred: Number(r.deferred),
      responses: Number(r.responses),
    };
  });
}

export interface CampaignVersionRow {
  readonly campaignVersionId: string;
  readonly versionNumber: number;
  readonly state: string;
  readonly authorizationVersion: number;
  readonly audienceSize: number;
  readonly sent: number;
  readonly withheld: number;
}

export interface CampaignBoardRow {
  readonly campaignId: string;
  readonly rooftopId: string;
  readonly rooftopName: string;
  readonly name: string;
  readonly channel: string;
  readonly purpose: string;
  readonly status: string;
  readonly quietHours: string;
  readonly authorizationVersion: number;
  readonly versions: CampaignVersionRow[];
}

/**
 * THE CAMPAIGN BOARD — every campaign the actor may see, with the versions
 * underneath it and what each version actually did.
 *
 * The withheld count sits beside the sent count on purpose. A screen that
 * showed only what went out would teach a marketer that their list is small,
 * when what is small is the PERMISSION — and that is a different problem with a
 * different fix.
 */
export async function campaignBoard(
  tenantId: string,
  rooftopIds: string[],
): Promise<CampaignBoardRow[]> {
  return withTenantTransaction(tenantId, async (tx) => {
    const found = await tx.query(
      `SELECT c.campaign_id, c.rooftop_id, r.name AS rooftop_name, c.name, c.channel, c.purpose,
              c.status, c.quiet_hours_start_minute, c.quiet_hours_end_minute, c.time_zone,
              c.authorization_version
         FROM campaigns c
         JOIN rooftops r ON r.tenant_id = c.tenant_id AND r.rooftop_id = c.rooftop_id
        WHERE c.tenant_id = $1 AND c.rooftop_id = ANY($2::uuid[])
        ORDER BY c.status, c.name`,
      [tenantId, rooftopIds],
    );
    const versions = await tx.query(
      `SELECT v.campaign_id, v.campaign_version_id, v.version_number, v.state,
              v.authorization_version,
              (SELECT COUNT(*)::int FROM campaign_audience_members m
                WHERE m.tenant_id = v.tenant_id
                  AND m.campaign_version_id = v.campaign_version_id) AS audience_size,
              (SELECT COUNT(*)::int FROM campaign_sends s
                WHERE s.tenant_id = v.tenant_id
                  AND s.campaign_version_id = v.campaign_version_id
                  AND s.state = 'sent') AS sent,
              (SELECT COUNT(*)::int FROM campaign_sends s
                WHERE s.tenant_id = v.tenant_id
                  AND s.campaign_version_id = v.campaign_version_id
                  AND s.state IN ('suppressed', 'deferred_quiet_hours', 'failed')) AS withheld
         FROM campaign_versions v
         JOIN campaigns c ON c.tenant_id = v.tenant_id AND c.campaign_id = v.campaign_id
        WHERE v.tenant_id = $1 AND c.rooftop_id = ANY($2::uuid[])
        ORDER BY v.version_number DESC`,
      [tenantId, rooftopIds],
    );
    const byCampaign = new Map<string, CampaignVersionRow[]>();
    for (const raw of versions.rows as Row[]) {
      const key = String(raw.campaign_id);
      const list = byCampaign.get(key) ?? [];
      list.push({
        campaignVersionId: String(raw.campaign_version_id),
        versionNumber: Number(raw.version_number),
        state: String(raw.state),
        authorizationVersion: Number(raw.authorization_version),
        audienceSize: Number(raw.audience_size),
        sent: Number(raw.sent),
        withheld: Number(raw.withheld),
      });
      byCampaign.set(key, list);
    }
    return (found.rows as Row[]).map((r) => ({
      campaignId: String(r.campaign_id),
      rooftopId: String(r.rooftop_id),
      rooftopName: String(r.rooftop_name),
      name: String(r.name),
      channel: String(r.channel),
      purpose: String(r.purpose),
      status: String(r.status),
      quietHours:
        Number(r.quiet_hours_start_minute) === Number(r.quiet_hours_end_minute)
          ? 'none'
          : `${minuteLabel(Number(r.quiet_hours_start_minute))}–` +
            `${minuteLabel(Number(r.quiet_hours_end_minute))} ${String(r.time_zone)}`,
      authorizationVersion: Number(r.authorization_version),
      versions: byCampaign.get(String(r.campaign_id)) ?? [],
    }));
  });
}

function minuteLabel(minute: number): string {
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export interface SendRow {
  readonly sendId: string;
  readonly customerName: string;
  readonly channel: string;
  readonly state: string;
  readonly withheldReason: string | null;
  readonly attempts: number;
  readonly externalRef: string | null;
  readonly responses: string[];
}

/**
 * The messages one version produced, WITH the ones it deliberately did not
 * send. Each withheld row carries the reason it was withheld for, so a
 * marketer can tell "they asked us not to" from "we have no address".
 */
export async function versionSends(
  tenantId: string,
  campaignId: string,
  campaignVersionId: string,
  rooftopIds: string[],
): Promise<SendRow[]> {
  return withTenantTransaction(tenantId, async (tx) => {
    const found = await tx.query(
      `SELECT s.send_id, p.display_name AS customer_name, s.channel, s.state,
              s.withheld_reason, s.attempts, s.external_ref,
              COALESCE(
                (SELECT array_agg(cr.response_type ORDER BY cr.response_type)
                   FROM campaign_responses cr
                  WHERE cr.tenant_id = s.tenant_id AND cr.send_id = s.send_id),
                ARRAY[]::text[]
              ) AS responses
         FROM campaign_sends s
         JOIN parties p ON p.tenant_id = s.tenant_id AND p.party_id = s.party_id
         JOIN campaign_versions v
           ON v.tenant_id = s.tenant_id AND v.campaign_version_id = s.campaign_version_id
         JOIN campaigns c ON c.tenant_id = v.tenant_id AND c.campaign_id = v.campaign_id
        WHERE s.tenant_id = $1
          AND s.campaign_version_id = $2
          AND v.campaign_id = $3
          AND c.rooftop_id = ANY($4::uuid[])
        ORDER BY p.display_name`,
      [tenantId, campaignVersionId, campaignId, rooftopIds],
    );
    return (found.rows as Row[]).map((r) => ({
      sendId: String(r.send_id),
      customerName: String(r.customer_name),
      channel: String(r.channel),
      state: String(r.state),
      withheldReason: r.withheld_reason === null ? null : String(r.withheld_reason),
      attempts: Number(r.attempts),
      externalRef: r.external_ref === null ? null : String(r.external_ref),
      responses: (r.responses as string[] | null) ?? [],
    }));
  });
}
