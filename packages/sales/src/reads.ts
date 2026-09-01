/**
 * RELEASE TRAIN 4 — WHAT THE SALESPERSON AND THE MANAGER SEE, AND WHAT THEY
 * CHOOSE FROM.
 *
 * THE ROOFTOP LIST IS THE AUTHORIZATION FILTER, AND IT IS APPLIED IN SQL. The
 * same rule the earlier trains follow: filtering after the query means the
 * database handed the process rows it may not show, and the only thing between
 * that and a leak is nobody forgetting a `filter()`.
 *
 * DISCOVERY IS A READ, NOT A FORM FIELD. Every identifier a person needs — a
 * pending handoff, a customer, an expected appointment, a car, a colleague — is
 * something they PICK from a list this file produces, filtered to what their
 * bindings reach. Asking somebody to type a UUID is not a user interface; it is
 * also an authorization hole, because a typed identifier is a guess the server
 * then has to refuse, and every refusal that names what it refused leaks.
 *
 * THE MANAGER'S BOARD IS ONE RECONCILED VIEW. Not eight endpoints a screen
 * stitches together in whatever order they happen to return: one read, one
 * consistent moment, one set of numbers that agree with each other.
 */
import { withTenantTransaction } from '@dealer/database';
import { EFFECTIVE_ROLE_BINDING_SQL } from '@dealer/identity-access';

interface Row {
  [key: string]: unknown;
}

/** Every figure this train does not have, said once and said plainly. */
export const NOT_YET_AVAILABLE = {
  revenue: 'NOT_YET_AVAILABLE',
  roi: 'NOT_YET_AVAILABLE',
  gross: 'NOT_YET_AVAILABLE',
  commission: 'NOT_YET_AVAILABLE',
  close: 'NOT_YET_AVAILABLE',
  pricing: 'NOT_YET_AVAILABLE',
  deal: 'NOT_YET_AVAILABLE',
} as const;

// ── discovery: what a person picks from ─────────────────────────────────────

export interface PendingHandoffRow {
  readonly handoffId: string;
  readonly leadId: string;
  readonly rooftopId: string;
  readonly rooftopName: string;
  readonly customerName: string;
  readonly handedToUserLinkId: string;
  readonly occurredAt: string;
  readonly appointmentAt: string | null;
}

/**
 * THE HANDOFFS WAITING TO BE RECEIVED.
 *
 * What replaces typing a handoff id. Only handoffs at rooftops this actor
 * reaches, and only ones no opportunity has taken yet — so the list is the work
 * outstanding rather than a history somebody has to scroll past.
 */
export async function pendingHandoffs(
  tenantId: string,
  rooftopIds: string[],
  limit = 50,
): Promise<PendingHandoffRow[]> {
  const capped = Math.min(Math.max(limit, 1), 200);
  return withTenantTransaction(tenantId, async (tx) => {
    const found = await tx.query(
      `SELECT h.handoff_id, h.lead_id, l.rooftop_id, r.name AS rooftop_name,
              p.display_name AS customer_name, h.handed_to_user_link_id, h.occurred_at,
              (SELECT MIN(a.starts_at) FROM appointments a
                WHERE a.tenant_id = h.tenant_id AND a.lead_id = h.lead_id
                  AND a.state IN ('scheduled', 'confirmed')) AS appointment_at
         FROM lead_handoffs h
         JOIN leads l ON l.tenant_id = h.tenant_id AND l.lead_id = h.lead_id
         JOIN rooftops r ON r.tenant_id = l.tenant_id AND r.rooftop_id = l.rooftop_id
         JOIN parties p ON p.tenant_id = l.tenant_id AND p.party_id = l.party_id
        WHERE h.tenant_id = $1
          AND l.rooftop_id = ANY($2::uuid[])
          AND NOT EXISTS (SELECT 1 FROM opportunities o
                           WHERE o.tenant_id = h.tenant_id AND o.handoff_id = h.handoff_id)
        ORDER BY h.occurred_at
        LIMIT $3`,
      [tenantId, rooftopIds, capped],
    );
    return (found.rows as Row[]).map((r) => ({
      handoffId: String(r.handoff_id),
      leadId: String(r.lead_id),
      rooftopId: String(r.rooftop_id),
      rooftopName: String(r.rooftop_name),
      customerName: String(r.customer_name),
      handedToUserLinkId: String(r.handed_to_user_link_id),
      occurredAt: new Date(r.occurred_at as string).toISOString(),
      appointmentAt:
        r.appointment_at === null ? null : new Date(r.appointment_at as string).toISOString(),
    }));
  });
}

export interface ExpectedAppointmentRow {
  readonly appointmentId: string;
  readonly leadId: string;
  readonly partyId: string;
  readonly customerName: string;
  readonly rooftopId: string;
  readonly purpose: string;
  readonly state: string;
  readonly startsAt: string;
  readonly stockItemId: string | null;
}

/**
 * WHO IS EXPECTED, and only who can still turn up.
 *
 * Completed, cancelled and no-show bookings are deliberately absent: they are
 * not appointments anybody can be checked in against, and offering them would
 * invite exactly the misuse check-in has to refuse.
 */
export async function expectedAppointments(
  tenantId: string,
  rooftopIds: string[],
  input: { fromHours?: number | undefined; toHours?: number | undefined; limit?: number } = {},
): Promise<ExpectedAppointmentRow[]> {
  const capped = Math.min(Math.max(input.limit ?? 50, 1), 200);
  const from = input.fromHours ?? 12;
  const to = input.toHours ?? 12;
  return withTenantTransaction(tenantId, async (tx) => {
    const found = await tx.query(
      `SELECT a.appointment_id, a.lead_id, a.party_id, p.display_name AS customer_name,
              a.rooftop_id, a.purpose, a.state, a.starts_at, a.stock_item_id
         FROM appointments a
         JOIN parties p ON p.tenant_id = a.tenant_id AND p.party_id = a.party_id
        WHERE a.tenant_id = $1
          AND a.rooftop_id = ANY($2::uuid[])
          AND a.state IN ('scheduled', 'confirmed')
          AND a.starts_at BETWEEN NOW() - ($3 || ' hours')::interval
                              AND NOW() + ($4 || ' hours')::interval
        ORDER BY a.starts_at
        LIMIT $5`,
      [tenantId, rooftopIds, String(from), String(to), capped],
    );
    return (found.rows as Row[]).map((r) => ({
      appointmentId: String(r.appointment_id),
      leadId: String(r.lead_id),
      partyId: String(r.party_id),
      customerName: String(r.customer_name),
      rooftopId: String(r.rooftop_id),
      purpose: String(r.purpose),
      state: String(r.state),
      startsAt: new Date(r.starts_at as string).toISOString(),
      stockItemId: r.stock_item_id === null ? null : String(r.stock_item_id),
    }));
  });
}

export interface ChooserVehicleRow {
  readonly stockItemId: string;
  readonly stockNumber: string;
  readonly rooftopId: string;
  readonly rooftopName: string;
  readonly description: string;
  readonly vin: string;
  readonly lifecycleState: string;
  readonly outOnDemonstration: boolean;
}

/**
 * THE CANONICAL INVENTORY CHOOSER, filtered to the rooftops this person works.
 *
 * An ordinary salesperson needs to find a car without holding inventory
 * authority and without typing a stock id, so this read is exposed under the
 * sales surface rather than the inventory one — and it shows the same canonical
 * stock rows, never a copy. Retired stock is out; a car currently out on a
 * demonstration is IN, marked, because "who has the blue one" is the question
 * this list gets opened to answer.
 */
export async function chooseInventory(
  tenantId: string,
  rooftopIds: string[],
  input: { query?: string | null | undefined; limit?: number | undefined } = {},
): Promise<ChooserVehicleRow[]> {
  const capped = Math.min(Math.max(input.limit ?? 50, 1), 200);
  const raw = (input.query ?? '').trim().toLowerCase();
  const like = raw.length > 0 ? `%${raw}%` : null;
  return withTenantTransaction(tenantId, async (tx) => {
    const found = await tx.query(
      `SELECT si.stock_item_id, si.stock_number, si.rooftop_id, r.name AS rooftop_name,
              si.lifecycle_state, v.vin,
              TRIM(BOTH ' ' FROM COALESCE(v.model_year::text, '') || ' ' ||
                   COALESCE(v.make, '') || ' ' || COALESCE(v.model, '')) AS description,
              EXISTS (SELECT 1 FROM demonstrations d
                       WHERE d.tenant_id = si.tenant_id AND d.stock_item_id = si.stock_item_id
                         AND d.state IN ('issued', 'in_progress')) AS out_on_demonstration
         FROM stock_items si
         JOIN rooftops r ON r.tenant_id = si.tenant_id AND r.rooftop_id = si.rooftop_id
         JOIN vehicles v ON v.tenant_id = si.tenant_id AND v.vehicle_id = si.vehicle_id
        WHERE si.tenant_id = $1
          AND si.rooftop_id = ANY($2::uuid[])
          AND si.lifecycle_state <> 'retired'
          AND ($3::text IS NULL
               OR lower(si.stock_number) LIKE $3
               OR lower(v.vin) LIKE $3
               OR lower(COALESCE(v.make, '')) LIKE $3
               OR lower(COALESCE(v.model, '')) LIKE $3)
        ORDER BY si.stock_number
        LIMIT $4`,
      [tenantId, rooftopIds, like, capped],
    );
    return (found.rows as Row[]).map((r) => ({
      stockItemId: String(r.stock_item_id),
      stockNumber: String(r.stock_number),
      rooftopId: String(r.rooftop_id),
      rooftopName: String(r.rooftop_name),
      description: String(r.description),
      vin: String(r.vin),
      lifecycleState: String(r.lifecycle_state),
      outOnDemonstration: r.out_on_demonstration === true,
    }));
  });
}

export interface StaffRow {
  readonly userLinkId: string;
  readonly roles: string[];
  readonly onFloor: boolean;
  readonly floorStatus: string | null;
  readonly openOpportunities: number;
}

/**
 * THE COLLEAGUES THIS PERSON CAN NAME, and only ones eligible for the job.
 *
 * What replaces typing a salesperson's or manager's id. `roles` is the filter
 * the caller passes — a turnover offers managers, an assignment offers
 * salespeople — and every candidate is somebody whose EFFECTIVE bindings reach
 * the named rooftop, so a name that appears here cannot then be refused by the
 * service for the reason the list exists to prevent.
 */
export async function eligibleStaff(
  tenantId: string,
  rooftopId: string,
  roles: readonly string[],
): Promise<StaffRow[]> {
  return withTenantTransaction(tenantId, async (tx) => {
    // THE SAME AUTHORITY RULE AS `permittedRooftopIds`, ASKED THE OTHER WAY
    // ROUND. That function answers "which rooftops does this person reach";
    // this answers "who reaches this rooftop", and it walks migration 059's
    // `org_ancestry_all` exactly as that one does — so a name this list offers
    // cannot then be refused by the service for not working here, which is the
    // whole point of offering a list instead of a text box.
    const found = await tx.query(
      `WITH reachable AS (
         SELECT DISTINCT rb.user_link_id, rb.role
           FROM rooftops r
           JOIN role_bindings rb
             ON rb.tenant_id = r.tenant_id
            AND ${EFFECTIVE_ROLE_BINDING_SQL}
          WHERE r.tenant_id = $1
            AND r.rooftop_id = $2
            AND r.status = 'active'
            AND rb.role = ANY($3::text[])
            AND (
              rb.scope_level = 'tenant'
              OR (rb.scope_level = 'rooftop' AND rb.scope_id = r.rooftop_id)
              OR EXISTS (
                SELECT 1 FROM org_ancestry_all($1, 'rooftop', r.rooftop_id) chain
                 WHERE chain.level = rb.scope_level AND chain.node_id = rb.scope_id
              )
            )
       )
       SELECT x.user_link_id,
              ARRAY_AGG(DISTINCT x.role) AS roles,
              (SELECT fr.status FROM floor_rotations fr
                WHERE fr.tenant_id = $1 AND fr.rooftop_id = $2
                  AND fr.user_link_id = x.user_link_id) AS floor_status,
              (SELECT COUNT(*)::int FROM opportunities o
                WHERE o.tenant_id = $1 AND o.rooftop_id = $2
                  AND o.owner_user_link_id = x.user_link_id
                  AND o.stage NOT IN ('ready_for_desking', 'lost')) AS open_opportunities
         FROM reachable x
        GROUP BY x.user_link_id
        ORDER BY x.user_link_id`,
      [tenantId, rooftopId, [...roles]],
    );
    return (found.rows as Row[]).map((r) => ({
      userLinkId: String(r.user_link_id),
      roles: (r.roles as string[]) ?? [],
      onFloor: r.floor_status !== null,
      floorStatus: r.floor_status === null ? null : String(r.floor_status),
      openOpportunities: Number(r.open_opportunities),
    }));
  });
}

// ── the opportunity, and what is owed on it ─────────────────────────────────

export interface OpportunityRow {
  readonly opportunityId: string;
  readonly rooftopId: string;
  readonly rooftopName: string;
  readonly customerName: string;
  readonly origin: string;
  readonly stage: string;
  readonly disposition: string | null;
  readonly ownerUserLinkId: string | null;
  readonly vehiclesShortlisted: number;
  readonly demonstrations: number;
  readonly negotiationRounds: number;
  readonly ageHours: number;
  readonly dealStatus: string;
  readonly nextActionDueAt: string | null;
  readonly nextActionSubject: string | null;
  readonly authorizationVersion: number;
}

const OPPORTUNITY_ROW_SQL = `
  SELECT o.opportunity_id, o.rooftop_id, r.name AS rooftop_name,
         p.display_name AS customer_name, o.origin, o.stage, o.disposition,
         o.owner_user_link_id, o.deal_status, o.authorization_version,
         EXTRACT(EPOCH FROM (NOW() - o.created_at)) / 3600.0 AS age_hours,
         (SELECT COUNT(*)::int FROM opportunity_vehicles v
           WHERE v.tenant_id = o.tenant_id AND v.opportunity_id = o.opportunity_id)
           AS vehicles_shortlisted,
         (SELECT COUNT(*)::int FROM demonstrations d
           WHERE d.tenant_id = o.tenant_id AND d.opportunity_id = o.opportunity_id)
           AS demonstrations,
         (SELECT COUNT(*)::int FROM negotiation_rounds n
           WHERE n.tenant_id = o.tenant_id AND n.opportunity_id = o.opportunity_id)
           AS negotiation_rounds,
         next_action.due_at AS next_action_due_at,
         next_action.subject AS next_action_subject
    FROM opportunities o
    JOIN rooftops r ON r.tenant_id = o.tenant_id AND r.rooftop_id = o.rooftop_id
    JOIN parties p ON p.tenant_id = o.tenant_id AND p.party_id = o.party_id
    LEFT JOIN LATERAL (
      SELECT a.due_at, a.subject
        FROM opportunity_activities a
       WHERE a.tenant_id = o.tenant_id AND a.opportunity_id = o.opportunity_id
         AND a.state = 'open' AND a.due_at IS NOT NULL
       ORDER BY a.due_at
       LIMIT 1
    ) next_action ON TRUE`;

function mapOpportunityRow(r: Row): OpportunityRow {
  return {
    opportunityId: String(r.opportunity_id),
    rooftopId: String(r.rooftop_id),
    rooftopName: String(r.rooftop_name),
    customerName: String(r.customer_name),
    origin: String(r.origin),
    stage: String(r.stage),
    disposition: r.disposition === null ? null : String(r.disposition),
    ownerUserLinkId: r.owner_user_link_id === null ? null : String(r.owner_user_link_id),
    vehiclesShortlisted: Number(r.vehicles_shortlisted),
    demonstrations: Number(r.demonstrations),
    negotiationRounds: Number(r.negotiation_rounds),
    ageHours: Math.round(Number(r.age_hours) * 10) / 10,
    dealStatus: String(r.deal_status),
    nextActionDueAt:
      r.next_action_due_at === null ? null : new Date(r.next_action_due_at as string).toISOString(),
    nextActionSubject: r.next_action_subject === null ? null : String(r.next_action_subject),
    authorizationVersion: Number(r.authorization_version),
  };
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
      `${OPPORTUNITY_ROW_SQL}
        WHERE o.tenant_id = $1
          AND o.rooftop_id = ANY($2::uuid[])
          AND ($3::text IS NULL OR o.stage = $3)
          AND ($4::uuid IS NULL OR o.owner_user_link_id = $4)
        ORDER BY o.created_at DESC
        LIMIT $5`,
      [input.tenantId, input.rooftopIds, input.stage ?? null, input.ownerUserLinkId ?? null, limit],
    );
    return (found.rows as Row[]).map(mapOpportunityRow);
  });
}

export interface OpportunityHeader {
  readonly customerName: string;
  readonly rooftopName: string;
  readonly nextActionId: string | null;
  readonly nextActionSubject: string | null;
  readonly nextActionDueAt: string | null;
  readonly nextActionVersion: number | null;
}

/**
 * THE NAMES AND THE NEXT THING OWED, kept out of the opportunity row itself.
 *
 * `OpportunityView` is what the WRITE services return, and it holds the row's
 * own columns and nothing else — a service that joined in a display name would
 * be carrying presentation through every mutation. The screen still has to say
 * who the customer is and what is due next, so the read that draws it fetches
 * both beside the row, filtered by the same rooftop list as everything else.
 */
export async function opportunityHeader(
  tenantId: string,
  opportunityId: string,
  rooftopIds: string[],
): Promise<OpportunityHeader | null> {
  return withTenantTransaction(tenantId, async (tx) => {
    const found = await tx.query(
      `SELECT p.display_name AS customer_name, r.name AS rooftop_name,
              next_action.activity_id, next_action.subject, next_action.due_at,
              next_action.authorization_version
         FROM opportunities o
         JOIN parties p ON p.tenant_id = o.tenant_id AND p.party_id = o.party_id
         JOIN rooftops r ON r.tenant_id = o.tenant_id AND r.rooftop_id = o.rooftop_id
         LEFT JOIN LATERAL (
           SELECT a.activity_id, a.subject, a.due_at, a.authorization_version
             FROM opportunity_activities a
            WHERE a.tenant_id = o.tenant_id AND a.opportunity_id = o.opportunity_id
              AND a.state = 'open' AND a.due_at IS NOT NULL
            ORDER BY a.due_at
            LIMIT 1
         ) next_action ON TRUE
        WHERE o.tenant_id = $1 AND o.opportunity_id = $2 AND o.rooftop_id = ANY($3::uuid[])`,
      [tenantId, opportunityId, rooftopIds],
    );
    if (found.rows.length === 0) return null;
    const row = found.rows[0] as Row;
    return {
      customerName: String(row.customer_name),
      rooftopName: String(row.rooftop_name),
      nextActionId: row.activity_id === null ? null : String(row.activity_id),
      nextActionSubject: row.subject === null ? null : String(row.subject),
      nextActionDueAt: row.due_at === null ? null : new Date(row.due_at as string).toISOString(),
      nextActionVersion:
        row.authorization_version === null ? null : Number(row.authorization_version),
    };
  });
}

export interface OpenActionRow {
  readonly activityId: string;
  readonly kind: string;
  readonly subject: string;
  readonly dueAt: string | null;
  readonly overdue: boolean;
  readonly authorizationVersion: number;
}

/** Everything still owed on this deal, earliest first. */
export async function openActions(
  tenantId: string,
  opportunityId: string,
  rooftopIds: string[],
): Promise<OpenActionRow[]> {
  return withTenantTransaction(tenantId, async (tx) => {
    const found = await tx.query(
      `SELECT a.activity_id, a.kind, a.subject, a.due_at, a.authorization_version,
              (a.due_at IS NOT NULL AND a.due_at < NOW()) AS overdue
         FROM opportunity_activities a
         JOIN opportunities o
           ON o.tenant_id = a.tenant_id AND o.opportunity_id = a.opportunity_id
        WHERE a.tenant_id = $1 AND a.opportunity_id = $2
          AND o.rooftop_id = ANY($3::uuid[])
          AND a.state = 'open'
        ORDER BY a.due_at NULLS LAST, a.created_at`,
      [tenantId, opportunityId, rooftopIds],
    );
    return (found.rows as Row[]).map((r) => ({
      activityId: String(r.activity_id),
      kind: String(r.kind),
      subject: String(r.subject),
      dueAt: r.due_at === null ? null : new Date(r.due_at as string).toISOString(),
      overdue: r.overdue === true,
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
 * activities, vehicle selection, demonstrations, negotiation rounds and
 * turnovers are seven tables and one story; merging them in the query means
 * there is exactly one ordering rather than seven lists a screen has to
 * interleave and can interleave differently.
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
         SELECT ve.occurred_at, 'vehicle.' || ve.event_type, si.stock_number, ve.reason
           FROM opportunity_vehicle_events ve
           JOIN stock_items si
             ON si.tenant_id = ve.tenant_id AND si.stock_item_id = ve.stock_item_id
          WHERE ve.tenant_id = $1 AND ve.opportunity_id = $2
         UNION ALL
         SELECT de.occurred_at, 'demonstration.' || de.event_type, si.stock_number,
                COALESCE(de.outcome, de.exception_kind, de.note)
           FROM demonstration_events de
           JOIN demonstrations d
             ON d.tenant_id = de.tenant_id AND d.demonstration_id = de.demonstration_id
           JOIN stock_items si
             ON si.tenant_id = d.tenant_id AND si.stock_item_id = d.stock_item_id
          WHERE de.tenant_id = $1 AND d.opportunity_id = $2
         UNION ALL
         SELECT n.occurred_at, 'negotiation.round ' || n.round_number,
                n.initiated_by || ': ' || n.outcome, n.summary
           FROM negotiation_rounds n
          WHERE n.tenant_id = $1 AND n.opportunity_id = $2
         UNION ALL
         SELECT t.occurred_at, 'turnover', t.reason, t.note
           FROM manager_turnovers t
          WHERE t.tenant_id = $1 AND t.opportunity_id = $2
         UNION ALL
         SELECT dh.occurred_at, 'desking.ready',
                'handed to appraisal and desking', NULL
           FROM desking_handoffs dh
          WHERE dh.tenant_id = $1 AND dh.opportunity_id = $2
       ) merged
       ORDER BY at, kind`,
      [tenantId, opportunityId],
    );
    return (found.rows as Row[]).map((r) => ({
      at: new Date(r.at as string).toISOString(),
      kind: String(r.kind),
      summary: r.summary === null ? '' : String(r.summary),
      detail: r.detail === null ? null : String(r.detail),
    }));
  });
}

export interface VisitRow {
  readonly visitId: string;
  readonly customerName: string;
  readonly partyId: string;
  readonly state: string;
  readonly arrivedAt: string;
  readonly greetedAt: string | null;
  readonly greetedByUserLinkId: string | null;
  readonly acceptedByUserLinkId: string | null;
  readonly waitingMinutes: number | null;
  readonly opportunityId: string | null;
  readonly appointmentId: string | null;
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
      `SELECT v.visit_id, p.display_name AS customer_name, v.party_id, v.state, v.arrived_at,
              v.greeted_at, v.greeted_by_user_link_id, v.accepted_by_user_link_id,
              v.opportunity_id, v.appointment_id, v.authorization_version,
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
      partyId: String(r.party_id),
      state: String(r.state),
      arrivedAt: new Date(r.arrived_at as string).toISOString(),
      greetedAt: r.greeted_at === null ? null : new Date(r.greeted_at as string).toISOString(),
      greetedByUserLinkId:
        r.greeted_by_user_link_id === null ? null : String(r.greeted_by_user_link_id),
      acceptedByUserLinkId:
        r.accepted_by_user_link_id === null ? null : String(r.accepted_by_user_link_id),
      waitingMinutes:
        r.waiting_minutes === null ? null : Math.round(Number(r.waiting_minutes) * 10) / 10,
      opportunityId: r.opportunity_id === null ? null : String(r.opportunity_id),
      appointmentId: r.appointment_id === null ? null : String(r.appointment_id),
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

export interface ActiveDemonstrationRow {
  readonly demonstrationId: string;
  readonly opportunityId: string;
  readonly stockItemId: string;
  readonly stockNumber: string;
  readonly driverPartyId: string;
  readonly driverName: string;
  readonly accompaniedByUserLinkId: string;
  readonly state: string;
  readonly issuedAt: string;
  readonly startedAt: string | null;
  readonly minutesOut: number;
  readonly authorizationVersion: number;
}

/** The cars that are out, whether moving or merely issued. */
export async function activeDemonstrations(
  tenantId: string,
  rooftopIds: string[],
  opportunityId?: string | null,
): Promise<ActiveDemonstrationRow[]> {
  return withTenantTransaction(tenantId, async (tx) => {
    const found = await tx.query(
      `SELECT d.demonstration_id, d.opportunity_id, d.stock_item_id, si.stock_number,
              d.driver_party_id, p.display_name AS driver_name,
              d.accompanied_by_user_link_id, d.state, d.issued_at, d.started_at,
              d.authorization_version,
              EXTRACT(EPOCH FROM (NOW() - d.issued_at)) / 60.0 AS minutes_out
         FROM demonstrations d
         JOIN stock_items si
           ON si.tenant_id = d.tenant_id AND si.stock_item_id = d.stock_item_id
         JOIN parties p ON p.tenant_id = d.tenant_id AND p.party_id = d.driver_party_id
        WHERE d.tenant_id = $1 AND d.rooftop_id = ANY($2::uuid[])
          AND d.state IN ('issued', 'in_progress')
          AND ($3::uuid IS NULL OR d.opportunity_id = $3)
        ORDER BY d.issued_at`,
      [tenantId, rooftopIds, opportunityId ?? null],
    );
    return (found.rows as Row[]).map((r) => ({
      demonstrationId: String(r.demonstration_id),
      opportunityId: String(r.opportunity_id),
      stockItemId: String(r.stock_item_id),
      stockNumber: String(r.stock_number),
      driverPartyId: String(r.driver_party_id),
      driverName: String(r.driver_name),
      accompaniedByUserLinkId: String(r.accompanied_by_user_link_id),
      state: String(r.state),
      issuedAt: new Date(r.issued_at as string).toISOString(),
      startedAt: r.started_at === null ? null : new Date(r.started_at as string).toISOString(),
      minutesOut: Math.round(Number(r.minutes_out)),
      authorizationVersion: Number(r.authorization_version),
    }));
  });
}

// ── the one reconciled manager view ─────────────────────────────────────────

export interface SalesBoard {
  readonly rooftops: Array<{ rooftopId: string; name: string }>;
  readonly appointments: {
    readonly expectedToday: number;
    readonly kept: number;
    readonly cancelled: number;
    readonly noShow: number;
    readonly stillExpected: number;
  };
  readonly showroom: {
    readonly waiting: number;
    readonly greeted: number;
    readonly withSalesperson: number;
    readonly departedToday: number;
    readonly medianWaitMinutes: number | null;
    readonly longestWaitMinutes: number | null;
  };
  readonly floor: {
    readonly available: number;
    readonly withCustomer: number;
    readonly unavailable: number;
  };
  readonly pipeline: {
    readonly open: number;
    readonly unowned: number;
    readonly received: number;
    readonly inShowroom: number;
    readonly demonstrated: number;
    readonly negotiating: number;
    readonly followUp: number;
    readonly readyForDesking: number;
    readonly lost: number;
    readonly medianAgeHours: number | null;
    readonly stalledOverDay: number;
  };
  readonly vehicles: {
    readonly selected: number;
    readonly shortlisted: number;
  };
  readonly demonstrations: {
    readonly activeNow: number;
    readonly issuedToday: number;
    readonly returnedToday: number;
    readonly cancelledToday: number;
    readonly exceptions: number;
  };
  readonly negotiation: {
    readonly roundsToday: number;
    readonly opportunitiesNegotiating: number;
    readonly turnovers: number;
  };
  readonly nextActions: {
    readonly open: number;
    readonly overdue: number;
    readonly dueToday: number;
  };
  readonly dispositions: {
    readonly readyForDesking: number;
    readonly lost: number;
    readonly lostReasons: Array<{ disposition: string; count: number }>;
  };
  /** The rows a manager can actually do something about, right now. */
  readonly exceptions: Array<{
    readonly kind: string;
    readonly detail: string;
    readonly opportunityId: string | null;
    readonly visitId: string | null;
    readonly since: string;
  }>;
  readonly revenueStatus: string;
  readonly roiStatus: string;
  readonly grossStatus: string;
  readonly commissionStatus: string;
  readonly closeStatus: string;
  readonly pricingStatus: string;
  readonly dealStatus: string;
}

/**
 * THE MANAGER'S BOARD — ONE READ, ONE MOMENT, ONE SET OF NUMBERS.
 *
 * Everything a sales manager runs a Saturday on: who was expected and who
 * turned up, who is waiting and how long, who is on the floor, where every live
 * deal stands and how old it is, which cars are selected and which are out,
 * what was negotiated, what is owed next, how things concluded — and the rows
 * that need somebody to act.
 *
 * IT IS ONE QUERY-SET IN ONE TRANSACTION, deliberately. Eight endpoints a
 * screen stitches together return eight different moments, and a board whose
 * waiting count and visit list disagree is a board people stop believing. The
 * rooftop list is the authorization filter and it is applied in SQL, so this
 * cannot show a store the reader may not see.
 *
 * EVERY MONEY QUESTION ANSWERS `NOT_YET_AVAILABLE`. Revenue, ROI, gross,
 * commission, close rate, pricing and deal value are FBL-120 and later. Saying
 * so is the honest alternative to a zero somebody reads as a bad month.
 */
export async function salesBoard(tenantId: string, rooftopIds: string[]): Promise<SalesBoard> {
  return withTenantTransaction(tenantId, async (tx) => {
    const rooftops = await tx.query(
      `SELECT rooftop_id, name FROM rooftops
        WHERE tenant_id = $1 AND rooftop_id = ANY($2::uuid[]) AND status = 'active'
        ORDER BY name`,
      [tenantId, rooftopIds],
    );

    const appointments = await tx.query(
      `SELECT
         COUNT(*) FILTER (WHERE a.starts_at::date = NOW()::date)::int AS expected_today,
         COUNT(*) FILTER (WHERE a.state = 'completed'
                            AND a.completed_at::date = NOW()::date)::int AS kept,
         COUNT(*) FILTER (WHERE a.state = 'cancelled'
                            AND a.cancelled_at::date = NOW()::date)::int AS cancelled,
         COUNT(*) FILTER (WHERE a.state = 'no_show'
                            AND a.starts_at::date = NOW()::date)::int AS no_show,
         COUNT(*) FILTER (WHERE a.state IN ('scheduled', 'confirmed')
                            AND a.starts_at >= NOW())::int AS still_expected
       FROM appointments a
      WHERE a.tenant_id = $1 AND a.rooftop_id = ANY($2::uuid[])`,
      [tenantId, rooftopIds],
    );

    const showroom = await tx.query(
      `SELECT
         COUNT(*) FILTER (WHERE state = 'arrived')::int AS waiting,
         COUNT(*) FILTER (WHERE state = 'greeted')::int AS greeted,
         COUNT(*) FILTER (WHERE state = 'with_salesperson')::int AS with_salesperson,
         COUNT(*) FILTER (WHERE state = 'departed'
                            AND departed_at::date = NOW()::date)::int AS departed_today,
         PERCENTILE_CONT(0.5) WITHIN GROUP (
           ORDER BY EXTRACT(EPOCH FROM (COALESCE(greeted_at, NOW()) - arrived_at)) / 60.0
         ) FILTER (WHERE arrived_at::date = NOW()::date) AS median_wait,
         MAX(EXTRACT(EPOCH FROM (NOW() - arrived_at)) / 60.0)
           FILTER (WHERE state = 'arrived') AS longest_wait
       FROM showroom_visits
      WHERE tenant_id = $1 AND rooftop_id = ANY($2::uuid[])`,
      [tenantId, rooftopIds],
    );

    const floor = await tx.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'available')::int AS available,
         COUNT(*) FILTER (WHERE status = 'with_customer')::int AS with_customer,
         COUNT(*) FILTER (WHERE status = 'unavailable')::int AS unavailable
       FROM floor_rotations
      WHERE tenant_id = $1 AND rooftop_id = ANY($2::uuid[])`,
      [tenantId, rooftopIds],
    );

    const pipeline = await tx.query(
      `SELECT
         COUNT(*) FILTER (WHERE stage NOT IN ('ready_for_desking', 'lost'))::int AS open,
         COUNT(*) FILTER (WHERE stage NOT IN ('ready_for_desking', 'lost')
                            AND owner_user_link_id IS NULL)::int AS unowned,
         COUNT(*) FILTER (WHERE stage = 'received')::int AS received,
         COUNT(*) FILTER (WHERE stage = 'in_showroom')::int AS in_showroom,
         COUNT(*) FILTER (WHERE stage = 'demonstrated')::int AS demonstrated,
         COUNT(*) FILTER (WHERE stage = 'negotiating')::int AS negotiating,
         COUNT(*) FILTER (WHERE stage = 'follow_up')::int AS follow_up,
         COUNT(*) FILTER (WHERE stage = 'ready_for_desking')::int AS ready_for_desking,
         COUNT(*) FILTER (WHERE stage = 'lost')::int AS lost,
         PERCENTILE_CONT(0.5) WITHIN GROUP (
           ORDER BY EXTRACT(EPOCH FROM (NOW() - created_at)) / 3600.0
         ) FILTER (WHERE stage NOT IN ('ready_for_desking', 'lost')) AS median_age,
         COUNT(*) FILTER (WHERE stage NOT IN ('ready_for_desking', 'lost')
                            AND updated_at < NOW() - INTERVAL '1 day')::int AS stalled
       FROM opportunities
      WHERE tenant_id = $1 AND rooftop_id = ANY($2::uuid[])`,
      [tenantId, rooftopIds],
    );

    const vehicles = await tx.query(
      `SELECT
         COUNT(*) FILTER (WHERE ov.status = 'selected')::int AS selected,
         COUNT(*)::int AS shortlisted
       FROM opportunity_vehicles ov
       JOIN opportunities o
         ON o.tenant_id = ov.tenant_id AND o.opportunity_id = ov.opportunity_id
      WHERE ov.tenant_id = $1 AND o.rooftop_id = ANY($2::uuid[])
        AND o.stage NOT IN ('ready_for_desking', 'lost')`,
      [tenantId, rooftopIds],
    );

    const demos = await tx.query(
      `SELECT
         COUNT(*) FILTER (WHERE state IN ('issued', 'in_progress'))::int AS active_now,
         COUNT(*) FILTER (WHERE issued_at::date = NOW()::date)::int AS issued_today,
         COUNT(*) FILTER (WHERE state = 'returned'
                            AND ended_at::date = NOW()::date)::int AS returned_today,
         COUNT(*) FILTER (WHERE state = 'cancelled'
                            AND ended_at::date = NOW()::date)::int AS cancelled_today,
         COUNT(*) FILTER (WHERE state = 'exception')::int AS exceptions
       FROM demonstrations
      WHERE tenant_id = $1 AND rooftop_id = ANY($2::uuid[])`,
      [tenantId, rooftopIds],
    );

    const negotiation = await tx.query(
      `SELECT
         (SELECT COUNT(*)::int FROM negotiation_rounds n
           JOIN opportunities o
             ON o.tenant_id = n.tenant_id AND o.opportunity_id = n.opportunity_id
          WHERE n.tenant_id = $1 AND o.rooftop_id = ANY($2::uuid[])
            AND n.occurred_at::date = NOW()::date) AS rounds_today,
         (SELECT COUNT(*)::int FROM opportunities o
           WHERE o.tenant_id = $1 AND o.rooftop_id = ANY($2::uuid[])
             AND o.stage = 'negotiating') AS negotiating,
         (SELECT COUNT(*)::int FROM manager_turnovers t
           JOIN opportunities o
             ON o.tenant_id = t.tenant_id AND o.opportunity_id = t.opportunity_id
          WHERE t.tenant_id = $1 AND o.rooftop_id = ANY($2::uuid[])) AS turnovers`,
      [tenantId, rooftopIds],
    );

    const actions = await tx.query(
      `SELECT
         COUNT(*) FILTER (WHERE a.state = 'open')::int AS open,
         COUNT(*) FILTER (WHERE a.state = 'open' AND a.due_at < NOW())::int AS overdue,
         COUNT(*) FILTER (WHERE a.state = 'open'
                            AND a.due_at::date = NOW()::date)::int AS due_today
       FROM opportunity_activities a
       JOIN opportunities o
         ON o.tenant_id = a.tenant_id AND o.opportunity_id = a.opportunity_id
      WHERE a.tenant_id = $1 AND o.rooftop_id = ANY($2::uuid[])`,
      [tenantId, rooftopIds],
    );

    const lostReasons = await tx.query(
      `SELECT disposition, COUNT(*)::int AS n
         FROM opportunities
        WHERE tenant_id = $1 AND rooftop_id = ANY($2::uuid[]) AND stage = 'lost'
        GROUP BY disposition
        ORDER BY n DESC, disposition`,
      [tenantId, rooftopIds],
    );

    // ── the rows a manager can act on ────────────────────────────────────────
    const exceptions = await tx.query(
      `SELECT kind, detail, opportunity_id, visit_id, since FROM (
         SELECT 'waiting_too_long' AS kind,
                p.display_name || ' has been waiting' AS detail,
                v.opportunity_id, v.visit_id, v.arrived_at AS since
           FROM showroom_visits v
           JOIN parties p ON p.tenant_id = v.tenant_id AND p.party_id = v.party_id
          WHERE v.tenant_id = $1 AND v.rooftop_id = ANY($2::uuid[])
            AND v.state = 'arrived' AND v.arrived_at < NOW() - INTERVAL '15 minutes'
         UNION ALL
         SELECT 'demonstration_overdue',
                si.stock_number || ' has been out a long time',
                d.opportunity_id, d.visit_id, d.issued_at
           FROM demonstrations d
           JOIN stock_items si
             ON si.tenant_id = d.tenant_id AND si.stock_item_id = d.stock_item_id
          WHERE d.tenant_id = $1 AND d.rooftop_id = ANY($2::uuid[])
            AND d.state IN ('issued', 'in_progress')
            AND d.issued_at < NOW() - INTERVAL '2 hours'
         UNION ALL
         SELECT 'demonstration_exception',
                si.stock_number || ': ' || d.exception_kind,
                d.opportunity_id, d.visit_id, d.ended_at
           FROM demonstrations d
           JOIN stock_items si
             ON si.tenant_id = d.tenant_id AND si.stock_item_id = d.stock_item_id
          WHERE d.tenant_id = $1 AND d.rooftop_id = ANY($2::uuid[])
            AND d.state = 'exception'
         UNION ALL
         SELECT 'unowned_opportunity',
                p.display_name || ' has nobody working them',
                o.opportunity_id, NULL::uuid, o.created_at
           FROM opportunities o
           JOIN parties p ON p.tenant_id = o.tenant_id AND p.party_id = o.party_id
          WHERE o.tenant_id = $1 AND o.rooftop_id = ANY($2::uuid[])
            AND o.stage NOT IN ('ready_for_desking', 'lost')
            AND o.owner_user_link_id IS NULL
         UNION ALL
         SELECT 'action_overdue',
                a.subject,
                a.opportunity_id, NULL::uuid, a.due_at
           FROM opportunity_activities a
           JOIN opportunities o
             ON o.tenant_id = a.tenant_id AND o.opportunity_id = a.opportunity_id
          WHERE a.tenant_id = $1 AND o.rooftop_id = ANY($2::uuid[])
            AND a.state = 'open' AND a.due_at < NOW()
       ) e
       ORDER BY since
       LIMIT 50`,
      [tenantId, rooftopIds],
    );

    const a = appointments.rows[0] as Row;
    const s = showroom.rows[0] as Row;
    const f = floor.rows[0] as Row;
    const pl = pipeline.rows[0] as Row;
    const v = vehicles.rows[0] as Row;
    const d = demos.rows[0] as Row;
    const n = negotiation.rows[0] as Row;
    const act = actions.rows[0] as Row;
    const round1 = (x: unknown): number | null =>
      x === null || x === undefined ? null : Math.round(Number(x) * 10) / 10;

    return {
      rooftops: (rooftops.rows as Row[]).map((r) => ({
        rooftopId: String(r.rooftop_id),
        name: String(r.name),
      })),
      appointments: {
        expectedToday: Number(a.expected_today),
        kept: Number(a.kept),
        cancelled: Number(a.cancelled),
        noShow: Number(a.no_show),
        stillExpected: Number(a.still_expected),
      },
      showroom: {
        waiting: Number(s.waiting),
        greeted: Number(s.greeted),
        withSalesperson: Number(s.with_salesperson),
        departedToday: Number(s.departed_today),
        medianWaitMinutes: round1(s.median_wait),
        longestWaitMinutes: round1(s.longest_wait),
      },
      floor: {
        available: Number(f.available),
        withCustomer: Number(f.with_customer),
        unavailable: Number(f.unavailable),
      },
      pipeline: {
        open: Number(pl.open),
        unowned: Number(pl.unowned),
        received: Number(pl.received),
        inShowroom: Number(pl.in_showroom),
        demonstrated: Number(pl.demonstrated),
        negotiating: Number(pl.negotiating),
        followUp: Number(pl.follow_up),
        readyForDesking: Number(pl.ready_for_desking),
        lost: Number(pl.lost),
        medianAgeHours: round1(pl.median_age),
        stalledOverDay: Number(pl.stalled),
      },
      vehicles: { selected: Number(v.selected), shortlisted: Number(v.shortlisted) },
      demonstrations: {
        activeNow: Number(d.active_now),
        issuedToday: Number(d.issued_today),
        returnedToday: Number(d.returned_today),
        cancelledToday: Number(d.cancelled_today),
        exceptions: Number(d.exceptions),
      },
      negotiation: {
        roundsToday: Number(n.rounds_today),
        opportunitiesNegotiating: Number(n.negotiating),
        turnovers: Number(n.turnovers),
      },
      nextActions: {
        open: Number(act.open),
        overdue: Number(act.overdue),
        dueToday: Number(act.due_today),
      },
      dispositions: {
        readyForDesking: Number(pl.ready_for_desking),
        lost: Number(pl.lost),
        lostReasons: (lostReasons.rows as Row[]).map((r) => ({
          disposition: String(r.disposition),
          count: Number(r.n),
        })),
      },
      exceptions: (exceptions.rows as Row[]).map((r) => ({
        kind: String(r.kind),
        detail: String(r.detail),
        opportunityId: r.opportunity_id === null ? null : String(r.opportunity_id),
        visitId: r.visit_id === null ? null : String(r.visit_id),
        since: new Date(r.since as string).toISOString(),
      })),
      revenueStatus: NOT_YET_AVAILABLE.revenue,
      roiStatus: NOT_YET_AVAILABLE.roi,
      grossStatus: NOT_YET_AVAILABLE.gross,
      commissionStatus: NOT_YET_AVAILABLE.commission,
      closeStatus: NOT_YET_AVAILABLE.close,
      pricingStatus: NOT_YET_AVAILABLE.pricing,
      dealStatus: NOT_YET_AVAILABLE.deal,
    };
  });
}
