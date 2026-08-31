/**
 * RELEASE TRAIN 4 — WHAT THE SALESPERSON AND THE MANAGER SEE.
 *
 * THE ROOFTOP LIST IS THE AUTHORIZATION FILTER, AND IT IS APPLIED IN SQL. The
 * same rule the earlier trains follow: filtering after the query means the
 * database handed the process rows it may not show, and the only thing between
 * that and a leak is nobody forgetting a `filter()`.
 *
 * THE MANAGER'S BOARD IS THE POINT OF THE ROW. A sales manager's job is to see
 * who is on the floor, who is waiting, which opportunities are stalling and
 * where the turnovers went — computed, never stored, so no write path can
 * forget to keep a counter and leave the board quietly wrong.
 */
import { withTenantTransaction } from '@dealer/database';

interface Row {
  [key: string]: unknown;
}

export interface OpportunityRow {
  readonly opportunityId: string;
  readonly rooftopId: string;
  readonly rooftopName: string;
  readonly customerName: string;
  readonly stage: string;
  readonly disposition: string | null;
  readonly ownerUserLinkId: string | null;
  readonly vehiclesShortlisted: number;
  readonly demonstrations: number;
  readonly negotiationRounds: number;
  readonly ageHours: number;
  readonly dealStatus: string;
  readonly authorizationVersion: number;
}

export async function listOpportunities(input: {
  tenantId: string;
  rooftopIds: string[];
  stage?: string | null | undefined;
  ownerUserLinkId?: string | null | undefined;
  limit?: number | undefined;
}): Promise<OpportunityRow[]> {
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
  return withTenantTransaction(input.tenantId, async (tx) => {
    const found = await tx.query(
      `SELECT o.opportunity_id, o.rooftop_id, r.name AS rooftop_name,
              p.display_name AS customer_name, o.stage, o.disposition, o.owner_user_link_id,
              o.deal_status, o.authorization_version,
              EXTRACT(EPOCH FROM (NOW() - o.created_at)) / 3600.0 AS age_hours,
              (SELECT COUNT(*)::int FROM opportunity_vehicles v
                WHERE v.tenant_id = o.tenant_id AND v.opportunity_id = o.opportunity_id)
                AS vehicles_shortlisted,
              (SELECT COUNT(*)::int FROM demonstrations d
                WHERE d.tenant_id = o.tenant_id AND d.opportunity_id = o.opportunity_id)
                AS demonstrations,
              (SELECT COUNT(*)::int FROM negotiation_rounds n
                WHERE n.tenant_id = o.tenant_id AND n.opportunity_id = o.opportunity_id)
                AS negotiation_rounds
         FROM opportunities o
         JOIN rooftops r ON r.tenant_id = o.tenant_id AND r.rooftop_id = o.rooftop_id
         JOIN parties p ON p.tenant_id = o.tenant_id AND p.party_id = o.party_id
        WHERE o.tenant_id = $1
          AND o.rooftop_id = ANY($2::uuid[])
          AND ($3::text IS NULL OR o.stage = $3)
          AND ($4::uuid IS NULL OR o.owner_user_link_id = $4)
        ORDER BY o.created_at DESC
        LIMIT $5`,
      [input.tenantId, input.rooftopIds, input.stage ?? null, input.ownerUserLinkId ?? null, limit],
    );
    return (found.rows as Row[]).map((r) => ({
      opportunityId: String(r.opportunity_id),
      rooftopId: String(r.rooftop_id),
      rooftopName: String(r.rooftop_name),
      customerName: String(r.customer_name),
      stage: String(r.stage),
      disposition: r.disposition === null ? null : String(r.disposition),
      ownerUserLinkId: r.owner_user_link_id === null ? null : String(r.owner_user_link_id),
      vehiclesShortlisted: Number(r.vehicles_shortlisted),
      demonstrations: Number(r.demonstrations),
      negotiationRounds: Number(r.negotiation_rounds),
      ageHours: Math.round(Number(r.age_hours) * 10) / 10,
      dealStatus: String(r.deal_status),
      authorizationVersion: Number(r.authorization_version),
    }));
  });
}

export interface SalesTimelineEntry {
  readonly at: string;
  readonly kind: string;
  readonly summary: string;
  readonly detail: string | null;
}

/**
 * ONE TIMELINE, MERGED IN SQL AND ORDERED ONCE. Stage moves, assignments,
 * activities, demonstrations, negotiation rounds and turnovers are six tables
 * and one story; merging them in the query means there is exactly one ordering
 * rather than six lists a screen has to interleave and can interleave
 * differently.
 */
export async function opportunityTimeline(
  tenantId: string,
  opportunityId: string,
  rooftopIds: string[],
): Promise<SalesTimelineEntry[]> {
  return withTenantTransaction(tenantId, async (tx) => {
    const visible = await tx.query(
      `SELECT 1 FROM opportunities
        WHERE tenant_id = $1 AND opportunity_id = $2 AND rooftop_id = ANY($3::uuid[])`,
      [tenantId, opportunityId, rooftopIds],
    );
    if (visible.rows.length === 0) return [];
    const found = await tx.query(
      `SELECT at, kind, summary, detail FROM (
         SELECT e.occurred_at AS at, 'stage' AS kind,
                e.from_stage || ' -> ' || e.to_stage AS summary, e.note AS detail
           FROM opportunity_stage_events e
          WHERE e.tenant_id = $1 AND e.opportunity_id = $2
         UNION ALL
         SELECT a.occurred_at, 'assignment', a.reason, a.note
           FROM opportunity_assignments a
          WHERE a.tenant_id = $1 AND a.opportunity_id = $2
         UNION ALL
         SELECT ac.created_at, 'activity.' || ac.kind, ac.subject, ac.direction
           FROM opportunity_activities ac
          WHERE ac.tenant_id = $1 AND ac.opportunity_id = $2
         UNION ALL
         SELECT d.started_at, 'demonstration.started', si.stock_number, NULL
           FROM demonstrations d
           JOIN stock_items si
             ON si.tenant_id = d.tenant_id AND si.stock_item_id = d.stock_item_id
          WHERE d.tenant_id = $1 AND d.opportunity_id = $2
         UNION ALL
         SELECT d.ended_at, 'demonstration.' || d.state, si.stock_number, d.outcome
           FROM demonstrations d
           JOIN stock_items si
             ON si.tenant_id = d.tenant_id AND si.stock_item_id = d.stock_item_id
          WHERE d.tenant_id = $1 AND d.opportunity_id = $2 AND d.ended_at IS NOT NULL
         UNION ALL
         SELECT n.occurred_at, 'negotiation.round ' || n.round_number,
                n.initiated_by || ': ' || n.outcome, n.summary
           FROM negotiation_rounds n
          WHERE n.tenant_id = $1 AND n.opportunity_id = $2
         UNION ALL
         SELECT t.occurred_at, 'turnover', t.reason, t.note
           FROM manager_turnovers t
          WHERE t.tenant_id = $1 AND t.opportunity_id = $2
       ) merged
       ORDER BY at, kind`,
      [tenantId, opportunityId],
    );
    return (found.rows as Row[]).map((r) => ({
      at: new Date(r.at as string).toISOString(),
      kind: String(r.kind),
      summary: String(r.summary),
      detail: r.detail === null ? null : String(r.detail),
    }));
  });
}

export interface SalesBoard {
  readonly rooftops: Array<{ rooftopId: string; name: string }>;
  readonly pipeline: {
    readonly open: number;
    readonly received: number;
    readonly inShowroom: number;
    readonly demonstrated: number;
    readonly negotiating: number;
    readonly won: number;
    readonly lost: number;
  };
  readonly showroom: {
    readonly waiting: number;
    readonly withSalesperson: number;
    readonly departedToday: number;
    readonly medianWaitMinutes: number | null;
  };
  readonly floor: {
    readonly available: number;
    readonly withCustomer: number;
    readonly unavailable: number;
  };
  readonly activity: {
    readonly demonstrationsToday: number;
    readonly demonstrationsInProgress: number;
    readonly negotiationRounds: number;
    readonly turnovers: number;
  };
  readonly dealStatus: 'NOT_YET_AVAILABLE' | 'AVAILABLE';
  readonly pricingStatus: 'NOT_YET_AVAILABLE' | 'AVAILABLE';
}

/**
 * THE MANAGER'S BOARD, across the rooftops this actor may see and no others.
 *
 * `dealStatus` and `pricingStatus` are carried as explicit statuses rather than
 * as numbers or omissions, for the same reason Release Train 3 carries the
 * revenue one: a missing field reads as zero to somebody looking at a
 * dashboard, and there is no money in this train to show.
 */
export async function salesBoard(tenantId: string, rooftopIds: string[]): Promise<SalesBoard> {
  return withTenantTransaction(tenantId, async (tx) => {
    const rooftops = await tx.query(
      `SELECT rooftop_id, name FROM rooftops
        WHERE tenant_id = $1 AND rooftop_id = ANY($2::uuid[]) AND status = 'active'
        ORDER BY name`,
      [tenantId, rooftopIds],
    );
    const pipeline = await tx.query(
      `SELECT
         COUNT(*) FILTER (WHERE stage NOT IN ('won','lost'))::int AS open,
         COUNT(*) FILTER (WHERE stage = 'received')::int AS received,
         COUNT(*) FILTER (WHERE stage = 'in_showroom')::int AS in_showroom,
         COUNT(*) FILTER (WHERE stage = 'demonstrated')::int AS demonstrated,
         COUNT(*) FILTER (WHERE stage = 'negotiating')::int AS negotiating,
         COUNT(*) FILTER (WHERE stage = 'won')::int AS won,
         COUNT(*) FILTER (WHERE stage = 'lost')::int AS lost
       FROM opportunities WHERE tenant_id = $1 AND rooftop_id = ANY($2::uuid[])`,
      [tenantId, rooftopIds],
    );
    const showroom = await tx.query(
      `SELECT
         COUNT(*) FILTER (WHERE state = 'arrived')::int AS waiting,
         COUNT(*) FILTER (WHERE state IN ('greeted','with_salesperson'))::int AS with_salesperson,
         COUNT(*) FILTER (WHERE state = 'departed'
                            AND departed_at >= date_trunc('day', NOW()))::int AS departed_today,
         PERCENTILE_CONT(0.5) WITHIN GROUP (
           ORDER BY EXTRACT(EPOCH FROM (greeted_at - arrived_at)) / 60.0
         ) FILTER (WHERE greeted_at IS NOT NULL) AS median_wait
       FROM showroom_visits WHERE tenant_id = $1 AND rooftop_id = ANY($2::uuid[])`,
      [tenantId, rooftopIds],
    );
    const floor = await tx.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'available')::int AS available,
         COUNT(*) FILTER (WHERE status = 'with_customer')::int AS with_customer,
         COUNT(*) FILTER (WHERE status = 'unavailable')::int AS unavailable
       FROM floor_rotations WHERE tenant_id = $1 AND rooftop_id = ANY($2::uuid[])`,
      [tenantId, rooftopIds],
    );
    const activity = await tx.query(
      `SELECT
         (SELECT COUNT(*) FROM demonstrations d
           WHERE d.tenant_id = $1 AND d.rooftop_id = ANY($2::uuid[])
             AND d.started_at >= date_trunc('day', NOW()))::int AS demos_today,
         (SELECT COUNT(*) FROM demonstrations d
           WHERE d.tenant_id = $1 AND d.rooftop_id = ANY($2::uuid[])
             AND d.state = 'in_progress')::int AS demos_out,
         (SELECT COUNT(*) FROM negotiation_rounds n
            JOIN opportunities o
              ON o.tenant_id = n.tenant_id AND o.opportunity_id = n.opportunity_id
           WHERE n.tenant_id = $1 AND o.rooftop_id = ANY($2::uuid[]))::int AS rounds,
         (SELECT COUNT(*) FROM manager_turnovers t
            JOIN opportunities o
              ON o.tenant_id = t.tenant_id AND o.opportunity_id = t.opportunity_id
           WHERE t.tenant_id = $1 AND o.rooftop_id = ANY($2::uuid[]))::int AS turnovers`,
      [tenantId, rooftopIds],
    );
    const p = pipeline.rows[0] as Row;
    const s = showroom.rows[0] as Row;
    const f = floor.rows[0] as Row;
    const a = activity.rows[0] as Row;
    return {
      rooftops: (rooftops.rows as Row[]).map((r) => ({
        rooftopId: String(r.rooftop_id),
        name: String(r.name),
      })),
      pipeline: {
        open: Number(p.open),
        received: Number(p.received),
        inShowroom: Number(p.in_showroom),
        demonstrated: Number(p.demonstrated),
        negotiating: Number(p.negotiating),
        won: Number(p.won),
        lost: Number(p.lost),
      },
      showroom: {
        waiting: Number(s.waiting),
        withSalesperson: Number(s.with_salesperson),
        departedToday: Number(s.departed_today),
        medianWaitMinutes:
          s.median_wait === null ? null : Math.round(Number(s.median_wait) * 10) / 10,
      },
      floor: {
        available: Number(f.available),
        withCustomer: Number(f.with_customer),
        unavailable: Number(f.unavailable),
      },
      activity: {
        demonstrationsToday: Number(a.demos_today),
        demonstrationsInProgress: Number(a.demos_out),
        negotiationRounds: Number(a.rounds),
        turnovers: Number(a.turnovers),
      },
      // No money in this train, said rather than left to inference.
      dealStatus: 'NOT_YET_AVAILABLE',
      pricingStatus: 'NOT_YET_AVAILABLE',
    };
  });
}

export interface VisitRow {
  readonly visitId: string;
  readonly customerName: string;
  readonly state: string;
  readonly arrivedAt: string;
  readonly greetedAt: string | null;
  readonly greetedByUserLinkId: string | null;
  readonly waitingMinutes: number | null;
  readonly opportunityId: string | null;
  readonly authorizationVersion: number;
}

/** The floor board: who is in the building right now, and how long they waited. */
export async function listVisits(input: {
  tenantId: string;
  rooftopIds: string[];
  includeDeparted?: boolean | undefined;
  limit?: number | undefined;
}): Promise<VisitRow[]> {
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
  return withTenantTransaction(input.tenantId, async (tx) => {
    const found = await tx.query(
      `SELECT v.visit_id, p.display_name AS customer_name, v.state, v.arrived_at, v.greeted_at,
              v.greeted_by_user_link_id, v.opportunity_id, v.authorization_version,
              EXTRACT(EPOCH FROM (COALESCE(v.greeted_at, NOW()) - v.arrived_at)) / 60.0
                AS waiting_minutes
         FROM showroom_visits v
         JOIN parties p ON p.tenant_id = v.tenant_id AND p.party_id = v.party_id
        WHERE v.tenant_id = $1 AND v.rooftop_id = ANY($2::uuid[])
          AND ($3::boolean OR v.state <> 'departed')
        ORDER BY v.arrived_at DESC
        LIMIT $4`,
      [input.tenantId, input.rooftopIds, input.includeDeparted ?? false, limit],
    );
    return (found.rows as Row[]).map((r) => ({
      visitId: String(r.visit_id),
      customerName: String(r.customer_name),
      state: String(r.state),
      arrivedAt: new Date(r.arrived_at as string).toISOString(),
      greetedAt: r.greeted_at === null ? null : new Date(r.greeted_at as string).toISOString(),
      greetedByUserLinkId:
        r.greeted_by_user_link_id === null ? null : String(r.greeted_by_user_link_id),
      waitingMinutes:
        r.waiting_minutes === null ? null : Math.round(Number(r.waiting_minutes) * 10) / 10,
      opportunityId: r.opportunity_id === null ? null : String(r.opportunity_id),
      authorizationVersion: Number(r.authorization_version),
    }));
  });
}

export interface OpportunityHeader {
  readonly customerName: string;
  readonly rooftopName: string;
}

/**
 * THE NAMES THE DETAIL SCREEN NEEDS, kept out of the opportunity row itself.
 *
 * `OpportunityView` is what the WRITE services return, and it holds the row's
 * own columns and nothing else — a service that joined in a display name would
 * be carrying presentation through every mutation. The screen still has to say
 * who the customer is, so the read that draws it fetches the names beside the
 * row, filtered by the same rooftop list as everything else here.
 */
export async function opportunityHeader(
  tenantId: string,
  opportunityId: string,
  rooftopIds: string[],
): Promise<OpportunityHeader | null> {
  return withTenantTransaction(tenantId, async (tx) => {
    const found = await tx.query(
      `SELECT p.display_name AS customer_name, r.name AS rooftop_name
         FROM opportunities o
         JOIN parties p ON p.tenant_id = o.tenant_id AND p.party_id = o.party_id
         JOIN rooftops r ON r.tenant_id = o.tenant_id AND r.rooftop_id = o.rooftop_id
        WHERE o.tenant_id = $1 AND o.opportunity_id = $2 AND o.rooftop_id = ANY($3::uuid[])`,
      [tenantId, opportunityId, rooftopIds],
    );
    if (found.rows.length === 0) return null;
    const row = found.rows[0] as Row;
    return { customerName: String(row.customer_name), rooftopName: String(row.rooftop_name) };
  });
}

export interface OpenDemonstrationRow {
  readonly demonstrationId: string;
  readonly stockItemId: string;
  readonly stockNumber: string;
  readonly driverPartyId: string;
  readonly startedAt: string;
  readonly authorizationVersion: number;
}

/**
 * THE CAR THAT IS OUT RIGHT NOW, if there is one.
 *
 * A screen that can send a car out and cannot bring it back leaves the vehicle
 * marked in-progress for ever, which blocks the next customer from driving it —
 * so the read that draws the opportunity has to carry what the end-drive command
 * needs: the drive's id and the version it is at.
 */
export async function openDemonstrations(
  tenantId: string,
  opportunityId: string,
  rooftopIds: string[],
): Promise<OpenDemonstrationRow[]> {
  return withTenantTransaction(tenantId, async (tx) => {
    const found = await tx.query(
      `SELECT d.demonstration_id, d.stock_item_id, si.stock_number, d.driver_party_id,
              d.started_at, d.authorization_version
         FROM demonstrations d
         JOIN opportunities o
           ON o.tenant_id = d.tenant_id AND o.opportunity_id = d.opportunity_id
         JOIN stock_items si
           ON si.tenant_id = d.tenant_id AND si.stock_item_id = d.stock_item_id
        WHERE d.tenant_id = $1 AND d.opportunity_id = $2 AND d.state = 'in_progress'
          AND o.rooftop_id = ANY($3::uuid[])
        ORDER BY d.started_at`,
      [tenantId, opportunityId, rooftopIds],
    );
    return (found.rows as Row[]).map((r) => ({
      demonstrationId: String(r.demonstration_id),
      stockItemId: String(r.stock_item_id),
      stockNumber: String(r.stock_number),
      driverPartyId: String(r.driver_party_id),
      startedAt: new Date(r.started_at as string).toISOString(),
      authorizationVersion: Number(r.authorization_version),
    }));
  });
}

export interface ShortlistRow {
  readonly opportunityVehicleId: string;
  readonly stockItemId: string;
  readonly stockNumber: string;
  readonly description: string;
  readonly rank: number;
  readonly status: string;
  readonly rejectedReason: string | null;
  readonly demonstrated: boolean;
  readonly authorizationVersion: number;
}

export async function listShortlist(
  tenantId: string,
  opportunityId: string,
  rooftopIds: string[],
): Promise<ShortlistRow[]> {
  return withTenantTransaction(tenantId, async (tx) => {
    const found = await tx.query(
      `SELECT ov.opportunity_vehicle_id, ov.stock_item_id, si.stock_number, ov.rank, ov.status,
              ov.rejected_reason, ov.authorization_version,
              TRIM(BOTH ' ' FROM COALESCE(veh.model_year::text, '') || ' ' ||
                   COALESCE(veh.make, '') || ' ' || COALESCE(veh.model, '')) AS description,
              EXISTS (SELECT 1 FROM demonstrations d
                       WHERE d.tenant_id = ov.tenant_id
                         AND d.opportunity_id = ov.opportunity_id
                         AND d.stock_item_id = ov.stock_item_id) AS demonstrated
         FROM opportunity_vehicles ov
         JOIN opportunities o
           ON o.tenant_id = ov.tenant_id AND o.opportunity_id = ov.opportunity_id
         JOIN stock_items si
           ON si.tenant_id = ov.tenant_id AND si.stock_item_id = ov.stock_item_id
         JOIN vehicles veh ON veh.tenant_id = si.tenant_id AND veh.vehicle_id = si.vehicle_id
        WHERE ov.tenant_id = $1 AND ov.opportunity_id = $2
          AND o.rooftop_id = ANY($3::uuid[])
        ORDER BY ov.rank, si.stock_number`,
      [tenantId, opportunityId, rooftopIds],
    );
    return (found.rows as Row[]).map((r) => ({
      opportunityVehicleId: String(r.opportunity_vehicle_id),
      stockItemId: String(r.stock_item_id),
      stockNumber: String(r.stock_number),
      description: String(r.description),
      rank: Number(r.rank),
      status: String(r.status),
      rejectedReason: r.rejected_reason === null ? null : String(r.rejected_reason),
      demonstrated: r.demonstrated === true,
      authorizationVersion: Number(r.authorization_version),
    }));
  });
}
