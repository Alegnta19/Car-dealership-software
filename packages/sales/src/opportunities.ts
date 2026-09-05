/**
 * RELEASE TRAIN 4 — THE OPPORTUNITY, THE TWO DOORS IN, AND WHERE ITS AUTHORITY
 * STOPS.
 *
 * TWO WAYS A CUSTOMER BECOMES SALES WORK, and no third. The ordinary one is a
 * CRM HANDOFF: Release Train 3 froze a snapshot at the moment of the handoff,
 * and this reads THAT rather than the live lead, because the snapshot is what
 * the CRM committed to while the lead can still move. The other is a WALK-IN,
 * because a platform that could not record somebody arriving unannounced would
 * be refusing the most ordinary thing a showroom does — and a walk-in still
 * resolves to a CANONICAL party through Release Train 2's
 * search-create-deduplicate path, never to a second record for a person the
 * dealership already knows.
 *
 * INTAKE IS ATOMIC, AND CONVERGES. A provider that delivers twice, a retry, and
 * two genuinely concurrent receipts all end with ONE opportunity and none of
 * them sees a unique-key error: the transaction takes an advisory lock on the
 * handoff, and the insert converges on the existing row rather than colliding
 * with it.
 *
 * THE STAGE MACHINE IS ENUMERATED and its terminal states absorb, for the same
 * reason the lead's does: an opportunity that can be moved back out of a
 * conclusion is a report nobody can trust.
 *
 * WHERE THIS TRAIN'S AUTHORITY ENDS. There is no `won`, and no `sold`. A
 * customer saying yes on the floor produces exactly one thing: the FACT that
 * they are ready to be appraised and desked, raised once, and handed to
 * FBL-120. No sale, no sold-inventory transition, no deal, no delivery, no
 * revenue, and no figure anywhere on the way.
 */
import { withTenantTransaction, type Executor } from '@dealer/database';
import {
  enqueueAdminOutboxEvent,
  permittedRooftopIds,
  recordMutation,
  requireActor,
  type MutationResult,
} from '@dealer/identity-access';

interface Row {
  [key: string]: unknown;
}

export type OpportunityOrigin = 'crm_handoff' | 'walk_in';

export type OpportunityStage =
  | 'received'
  | 'in_showroom'
  | 'demonstrated'
  | 'negotiating'
  | 'follow_up'
  | 'ready_for_desking'
  | 'lost';

export type OpportunityDisposition =
  | 'committed_to_purchase'
  | 'lost_to_competitor'
  | 'lost_no_decision'
  | 'lost_credit'
  | 'lost_no_vehicle'
  | 'customer_unreachable';

export const OPPORTUNITY_STAGES: readonly OpportunityStage[] = [
  'received',
  'in_showroom',
  'demonstrated',
  'negotiating',
  'follow_up',
  'ready_for_desking',
  'lost',
];

/**
 * THE VOCABULARIES ARE THE SERVICE'S TO ENFORCE, not the CHECK constraint's.
 *
 * Migration 064 constrains each of these columns, so an unknown value cannot be
 * stored either way. The difference is what the caller is TOLD: a value that
 * travels to the constraint comes back as a 500, which reads as "the platform
 * broke" rather than "that is not one of the words".
 */
export const OPPORTUNITY_DISPOSITIONS: readonly OpportunityDisposition[] = [
  'committed_to_purchase',
  'lost_to_competitor',
  'lost_no_decision',
  'lost_credit',
  'lost_no_vehicle',
  'customer_unreachable',
];

export type AssignmentReason =
  'floor_rotation' | 'manual_assignment' | 'reassignment' | 'turnover' | 'manager_override';

export const ASSIGNMENT_REASONS: readonly AssignmentReason[] = [
  'floor_rotation',
  'manual_assignment',
  'reassignment',
  'turnover',
  'manager_override',
];

/** The two absorbing stages. Nothing writes through an opportunity in one. */
export const TERMINAL_STAGES: readonly OpportunityStage[] = ['ready_for_desking', 'lost'];

/** The outbox event type FBL-120 will consume. Named once, here. */
export const DESKING_READY_EVENT = 'sales.opportunity.ready_for_appraisal_desking';

/**
 * THE MACHINE, WRITTEN DOWN ONCE.
 *
 * A customer can walk in, drive something and negotiate, or negotiate without
 * ever driving — so the moves forward skip freely. `follow_up` is reachable
 * from every live stage and leads back out of itself, because "they went away
 * to think about it" is a state a deal sits in for weeks and comes back from.
 * `lost` is reachable from everywhere because a customer can stop at any point
 * and most of them do. `ready_for_desking` is reachable only from a stage where
 * a real conversation has happened.
 */
const LEGAL_STAGES: Record<OpportunityStage, readonly OpportunityStage[]> = {
  received: ['in_showroom', 'demonstrated', 'negotiating', 'follow_up', 'lost'],
  in_showroom: ['demonstrated', 'negotiating', 'follow_up', 'ready_for_desking', 'lost'],
  demonstrated: ['negotiating', 'in_showroom', 'follow_up', 'ready_for_desking', 'lost'],
  negotiating: ['demonstrated', 'follow_up', 'ready_for_desking', 'lost'],
  follow_up: ['in_showroom', 'demonstrated', 'negotiating', 'ready_for_desking', 'lost'],
  ready_for_desking: [],
  lost: [],
};

export interface OpportunityView {
  readonly opportunityId: string;
  readonly rooftopId: string;
  readonly partyId: string;
  readonly origin: OpportunityOrigin;
  readonly handoffId: string | null;
  readonly leadId: string | null;
  readonly appointmentId: string | null;
  readonly interestStockItemId: string | null;
  readonly ownerUserLinkId: string | null;
  readonly stage: OpportunityStage;
  readonly disposition: OpportunityDisposition | null;
  readonly dealStatus: 'NOT_YET_AVAILABLE' | 'AVAILABLE';
  readonly deskingReadyAt: string | null;
  readonly lostAt: string | null;
  readonly authorizationVersion: number;
  readonly createdAt: string;
}

const OPPORTUNITY_COLUMNS = `opportunity_id, rooftop_id, party_id, origin, handoff_id, lead_id,
       appointment_id, interest_stock_item_id, owner_user_link_id, stage, disposition,
       deal_status, desking_ready_at, lost_at, authorization_version, created_at`;

export function mapOpportunity(row: Row): OpportunityView {
  const iso = (v: unknown): string | null =>
    v === null || v === undefined ? null : new Date(v as string).toISOString();
  const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
  return {
    opportunityId: String(row.opportunity_id),
    rooftopId: String(row.rooftop_id),
    partyId: String(row.party_id),
    origin: String(row.origin) as OpportunityOrigin,
    handoffId: str(row.handoff_id),
    leadId: str(row.lead_id),
    appointmentId: str(row.appointment_id),
    interestStockItemId: str(row.interest_stock_item_id),
    ownerUserLinkId: str(row.owner_user_link_id),
    stage: String(row.stage) as OpportunityStage,
    disposition:
      row.disposition === null ? null : (String(row.disposition) as OpportunityDisposition),
    dealStatus: String(row.deal_status) as 'NOT_YET_AVAILABLE' | 'AVAILABLE',
    deskingReadyAt: iso(row.desking_ready_at),
    lostAt: iso(row.lost_at),
    authorizationVersion: Number(row.authorization_version),
    createdAt: new Date(row.created_at as string).toISOString(),
  };
}

/** Does this person's authority reach this showroom? */
async function reaches(tenantId: string, userLinkId: string, rooftopId: string): Promise<boolean> {
  const permitted = await permittedRooftopIds(tenantId, userLinkId);
  return permitted.includes(rooftopId);
}

// ── intake ──────────────────────────────────────────────────────────────────

export type ReceiveOutcome =
  | { outcome: 'received'; opportunity: OpportunityView; mutation: MutationResult }
  | { outcome: 'already_received'; opportunity: OpportunityView }
  | { outcome: 'not_found' }
  | { outcome: 'invalid'; error: string };

/**
 * The advisory-lock key intake serializes on. Derived, never caller-supplied.
 */
function intakeKey(tenantId: string, handoffId: string): string {
  return `sales.intake.handoff:${tenantId}:${handoffId}`;
}

/**
 * RECEIVES A HANDED-OFF LEAD INTO THE PIPELINE, ATOMICALLY.
 *
 * ── three guards, and each one alone is enough ─────────────────────────────
 *
 * `UNIQUE (tenant_id, handoff_id)` already makes two opportunities per handoff
 * impossible. What it does NOT do is make the second caller's experience sane:
 * a plain read-then-insert lets both callers see nothing, and the loser gets a
 * raw constraint violation — which reaches a provider retrying a webhook as a
 * 500 and gets retried again.
 *
 * So there are three layers, deliberately, and the order they appear in is the
 * order they cost least:
 *
 *   1. THE ADVISORY LOCK plus the pre-check beneath it. The second caller waits,
 *      then reads the row the first one committed and is told
 *      `already_received` without attempting an insert at all.
 *   2. `ON CONFLICT (tenant_id, handoff_id) DO NOTHING`. A caller that reaches
 *      the insert anyway writes nothing instead of raising 23505.
 *   3. THE RACED RE-SELECT. A caller whose insert wrote no row reads what the
 *      winner wrote and answers with it.
 *
 * EACH ONE ALONE PRODUCES THE CORRECT ANSWER, which is worth knowing and is why
 * `scripts/mutation-kill.ts` carries no mutation for this path: removing any
 * single one leaves the convergence intact, so no honest single-line mutation
 * exists. Two were tried and both survived. The registry says so in place of the
 * entry, and `tests/sales-floor.test.ts` proves the OUTCOME by running the race.
 *
 * ── why the snapshot and not the lead ──────────────────────────────────────
 *
 * Every fact is read from `lead_handoffs.handed_snapshot` — the FROZEN account
 * the CRM committed to — rather than from the live lead, which can still be
 * edited, reassigned or merged after the handoff. Reading the live row would
 * make the opportunity's provenance depend on when sales happened to click.
 * The appointment is the one exception, resolved canonically from the lead,
 * because migration 063's snapshot shape is frozen and carries no appointment.
 */
export async function receiveHandoffWithin(
  executor: Executor,
  input: { actingUserLinkId: string; tenantId: string; handoffId: string },
): Promise<ReceiveOutcome> {
  const actor = await requireActor(executor, input.actingUserLinkId);

  await executor.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
    intakeKey(input.tenantId, input.handoffId),
  ]);

  const existing = await executor.query(
    `SELECT ${OPPORTUNITY_COLUMNS} FROM opportunities
      WHERE tenant_id = $1 AND handoff_id = $2`,
    [input.tenantId, input.handoffId],
  );
  if (existing.rows.length > 0) {
    return { outcome: 'already_received', opportunity: mapOpportunity(existing.rows[0] as Row) };
  }

  // THE FROZEN SNAPSHOT IS THE SOURCE. `handed_snapshot` is jsonb written in the
  // handoff's own transaction; the lead is joined ONLY to confirm it really was
  // handed off, never to supply a fact the snapshot already carries.
  const handoff = await executor.query(
    `SELECT h.handoff_id,
            h.handed_to_user_link_id,
            h.handed_snapshot,
            l.lifecycle_state
       FROM lead_handoffs h
       JOIN leads l ON l.tenant_id = h.tenant_id AND l.lead_id = h.lead_id
      WHERE h.tenant_id = $1 AND h.handoff_id = $2`,
    [input.tenantId, input.handoffId],
  );
  if (handoff.rows.length === 0) return { outcome: 'not_found' };
  const seam = handoff.rows[0] as Row;
  if (String(seam.lifecycle_state) !== 'handed_off') {
    return {
      outcome: 'invalid',
      error: 'that lead is not handed off, so there is nothing for sales to receive',
    };
  }
  const snapshot = (seam.handed_snapshot ?? {}) as Record<string, unknown>;
  const snapLeadId = snapshot.lead_id === undefined ? null : String(snapshot.lead_id);
  const snapRooftopId = snapshot.rooftop_id === undefined ? null : String(snapshot.rooftop_id);
  const snapPartyId = snapshot.party_id === undefined ? null : String(snapshot.party_id);
  if (snapLeadId === null || snapRooftopId === null || snapPartyId === null) {
    return {
      outcome: 'invalid',
      error: 'that handoff snapshot is incomplete, so its customer cannot be established',
    };
  }
  const snapStockItemId =
    snapshot.interest_stock_item_id === null || snapshot.interest_stock_item_id === undefined
      ? null
      : String(snapshot.interest_stock_item_id);

  // THE APPOINTMENT, RESOLVED CANONICALLY. The one this customer is still
  // expected on, soonest first. A cancelled or no-show booking is not the
  // appointment sales inherits.
  const appointment = await executor.query(
    `SELECT appointment_id FROM appointments
      WHERE tenant_id = $1 AND lead_id = $2 AND state IN ('scheduled', 'confirmed')
      ORDER BY starts_at
      LIMIT 1`,
    [input.tenantId, snapLeadId],
  );
  const appointmentId =
    appointment.rows.length === 0 ? null : String((appointment.rows[0] as Row).appointment_id);

  // ONE OWNER, ESTABLISHED AT RECEIPT WHERE THAT IS POSSIBLE.
  //
  // The CRM handed the lead TO somebody; if that person still works this
  // rooftop they are the owner, and the receipt is what records it. If they do
  // not — they left, moved store, or the handoff named a queue rather than a
  // person — the receiving salesperson takes it if THEY reach the rooftop.
  // Failing both, it arrives unowned and needs an explicit acceptance, which is
  // an honest state and a visible one on the board.
  const handedTo =
    seam.handed_to_user_link_id === null ? null : String(seam.handed_to_user_link_id);
  let owner: string | null = null;
  if (handedTo !== null && (await reaches(input.tenantId, handedTo, snapRooftopId))) {
    owner = handedTo;
  } else if (await reaches(input.tenantId, actor, snapRooftopId)) {
    owner = actor;
  }

  const written = await executor.query(
    `INSERT INTO opportunities
       (tenant_id, rooftop_id, party_id, origin, handoff_id, lead_id, appointment_id,
        interest_stock_item_id, owner_user_link_id,
        created_by_user_link_id, updated_by_user_link_id)
     VALUES ($1, $2, $3, 'crm_handoff', $4, $5, $6, $7, $8, $9, $9)
     ON CONFLICT (tenant_id, handoff_id) DO NOTHING
     RETURNING ${OPPORTUNITY_COLUMNS}`,
    [
      input.tenantId,
      snapRooftopId,
      snapPartyId,
      input.handoffId,
      snapLeadId,
      appointmentId,
      snapStockItemId,
      owner,
      actor,
    ],
  );
  if (written.rows.length === 0) {
    // Somebody else won the race despite the lock — a caller reaching this
    // table by another route. Converge on what they wrote.
    const raced = await executor.query(
      `SELECT ${OPPORTUNITY_COLUMNS} FROM opportunities
        WHERE tenant_id = $1 AND handoff_id = $2`,
      [input.tenantId, input.handoffId],
    );
    if (raced.rows.length === 0) return { outcome: 'not_found' };
    return { outcome: 'already_received', opportunity: mapOpportunity(raced.rows[0] as Row) };
  }
  const opportunity = mapOpportunity(written.rows[0] as Row);
  if (owner !== null) {
    await executor.query(
      `INSERT INTO opportunity_assignments
         (tenant_id, opportunity_id, from_user_link_id, to_user_link_id, reason,
          note, assigned_by_user_link_id)
       VALUES ($1, $2, NULL, $3, 'manual_assignment', $4, $5)`,
      [input.tenantId, opportunity.opportunityId, owner, 'established at receipt', actor],
    );
  }
  const mutation = await recordMutation(executor, {
    tenantId: input.tenantId,
    entityType: 'opportunity',
    entityId: opportunity.opportunityId,
    eventType: 'sales.opportunity.received',
    actingUserLinkId: actor,
    authorizationVersion: opportunity.authorizationVersion,
    details: {
      origin: 'crm_handoff',
      handoff_id: input.handoffId,
      lead_id: opportunity.leadId,
      appointment_id: appointmentId,
      owner_established: owner !== null,
    },
  });
  return { outcome: 'received', opportunity, mutation };
}

export async function receiveHandoff(input: {
  actingUserLinkId: string;
  tenantId: string;
  handoffId: string;
}): Promise<ReceiveOutcome> {
  return withTenantTransaction(input.tenantId, (tx) => receiveHandoffWithin(tx, input));
}

export type WalkInOutcome =
  | { outcome: 'opened'; opportunity: OpportunityView; mutation: MutationResult }
  | { outcome: 'already_open'; opportunity: OpportunityView }
  | { outcome: 'not_found' }
  | { outcome: 'invalid'; error: string };

/** The advisory-lock key a walk-in serializes on. Derived, never supplied. */
function walkInKey(tenantId: string, rooftopId: string, partyId: string): string {
  return `sales.intake.walkin:${tenantId}:${rooftopId}:${partyId}`;
}

/**
 * OPENS AN OPPORTUNITY FOR SOMEBODY WHO JUST WALKED IN.
 *
 * The party must ALREADY be canonical — resolved through Release Train 2's
 * search-create-deduplicate path before this is called — because the one thing
 * a walk-in must not do is create a second record for a customer the dealership
 * already knows. This service takes the id that path produced; it does not
 * invent identity.
 *
 * CONVERGES, for the same reason intake does. Two people at two terminals
 * checking in the same customer, or one person double-clicking, must end with
 * ONE open file. The advisory lock serializes them and
 * `uq_opportunities_open_per_party` makes it true for any other caller.
 */
export async function openWalkInWithin(
  executor: Executor,
  input: {
    actingUserLinkId: string;
    tenantId: string;
    rooftopId: string;
    partyId: string;
    interestStockItemId?: string | null | undefined;
  },
): Promise<WalkInOutcome> {
  const actor = await requireActor(executor, input.actingUserLinkId);
  if (!(await reaches(input.tenantId, actor, input.rooftopId))) {
    return { outcome: 'invalid', error: 'you do not work at that rooftop' };
  }

  await executor.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
    walkInKey(input.tenantId, input.rooftopId, input.partyId),
  ]);

  const open = await executor.query(
    `SELECT ${OPPORTUNITY_COLUMNS} FROM opportunities
      WHERE tenant_id = $1 AND rooftop_id = $2 AND party_id = $3
        AND stage NOT IN ('ready_for_desking', 'lost')`,
    [input.tenantId, input.rooftopId, input.partyId],
  );
  if (open.rows.length > 0) {
    return { outcome: 'already_open', opportunity: mapOpportunity(open.rows[0] as Row) };
  }

  const party = await executor.query(
    `SELECT status FROM parties WHERE tenant_id = $1 AND party_id = $2`,
    [input.tenantId, input.partyId],
  );
  if (party.rows.length === 0) return { outcome: 'not_found' };
  if (String((party.rows[0] as Row).status) !== 'active') {
    return {
      outcome: 'invalid',
      error: 'that customer record is not active, so it is not the canonical one',
    };
  }

  // A car named at the door must be ON this lot, or the shortlist would start
  // with something the customer cannot be shown.
  if (input.interestStockItemId != null) {
    const stock = await executor.query(
      `SELECT rooftop_id, lifecycle_state FROM stock_items
        WHERE tenant_id = $1 AND stock_item_id = $2`,
      [input.tenantId, input.interestStockItemId],
    );
    if (stock.rows.length === 0) return { outcome: 'not_found' };
    const row = stock.rows[0] as Row;
    if (String(row.rooftop_id) !== input.rooftopId) return { outcome: 'not_found' };
    if (String(row.lifecycle_state) === 'retired') {
      return { outcome: 'invalid', error: 'that vehicle is no longer in stock' };
    }
  }

  const written = await executor.query(
    `INSERT INTO opportunities
       (tenant_id, rooftop_id, party_id, origin, interest_stock_item_id,
        owner_user_link_id, created_by_user_link_id, updated_by_user_link_id)
     VALUES ($1, $2, $3, 'walk_in', $4, $5, $5, $5)
     RETURNING ${OPPORTUNITY_COLUMNS}`,
    [input.tenantId, input.rooftopId, input.partyId, input.interestStockItemId ?? null, actor],
  );
  const opportunity = mapOpportunity(written.rows[0] as Row);
  await executor.query(
    `INSERT INTO opportunity_assignments
       (tenant_id, opportunity_id, from_user_link_id, to_user_link_id, reason,
        note, assigned_by_user_link_id)
     VALUES ($1, $2, NULL, $3, 'manual_assignment', 'took the walk-in', $3)`,
    [input.tenantId, opportunity.opportunityId, actor],
  );
  const mutation = await recordMutation(executor, {
    tenantId: input.tenantId,
    entityType: 'opportunity',
    entityId: opportunity.opportunityId,
    eventType: 'sales.opportunity.received',
    actingUserLinkId: actor,
    authorizationVersion: opportunity.authorizationVersion,
    details: { origin: 'walk_in', owner_established: true },
  });
  return { outcome: 'opened', opportunity, mutation };
}

export async function openWalkIn(input: {
  actingUserLinkId: string;
  tenantId: string;
  rooftopId: string;
  partyId: string;
  interestStockItemId?: string | null | undefined;
}): Promise<WalkInOutcome> {
  return withTenantTransaction(input.tenantId, (tx) => openWalkInWithin(tx, input));
}

// ── ownership ───────────────────────────────────────────────────────────────

export type AcceptOutcome =
  | { outcome: 'accepted'; opportunity: OpportunityView; mutation: MutationResult }
  | { outcome: 'already_owned'; opportunity: OpportunityView }
  | { outcome: 'version_conflict'; currentVersion: number }
  | { outcome: 'not_found' }
  | { outcome: 'invalid'; error: string };

/**
 * A SALESPERSON TAKING AN UNOWNED OPPORTUNITY ON, EXPLICITLY.
 *
 * The other half of "one eligible audited owner during receipt OR explicit
 * acceptance". Receipt establishes the owner when it can; this is what happens
 * when it could not — and it is a salesperson's own act, not a manager's
 * assignment, so it needs no assignment authority.
 *
 * Replaying it is not an error: somebody who already owns it is told
 * `already_owned` rather than refused, because a double-click is not a mistake
 * worth punishing.
 */
export async function acceptOpportunity(input: {
  actingUserLinkId: string;
  tenantId: string;
  opportunityId: string;
  expectedVersion: number;
}): Promise<AcceptOutcome> {
  return withTenantTransaction(input.tenantId, async (tx) => {
    const actor = await requireActor(tx, input.actingUserLinkId);
    const existing = await tx.query(
      `SELECT ${OPPORTUNITY_COLUMNS} FROM opportunities
        WHERE tenant_id = $1 AND opportunity_id = $2 FOR UPDATE`,
      [input.tenantId, input.opportunityId],
    );
    if (existing.rows.length === 0) return { outcome: 'not_found' as const };
    const current = mapOpportunity(existing.rows[0] as Row);
    if (current.ownerUserLinkId === actor) {
      return { outcome: 'already_owned' as const, opportunity: current };
    }
    if (TERMINAL_STAGES.includes(current.stage)) {
      return {
        outcome: 'invalid' as const,
        error: `a ${current.stage} opportunity takes no further work`,
      };
    }
    if (current.ownerUserLinkId !== null) {
      return {
        outcome: 'invalid' as const,
        error: 'somebody already owns this — a manager reassigns it, you cannot take it',
      };
    }
    if (current.authorizationVersion !== input.expectedVersion) {
      return { outcome: 'version_conflict' as const, currentVersion: current.authorizationVersion };
    }
    if (!(await reaches(input.tenantId, actor, current.rooftopId))) {
      return { outcome: 'not_found' as const };
    }

    const written = await tx.query(
      `UPDATE opportunities
          SET owner_user_link_id = $3, updated_by_user_link_id = $3, updated_at = NOW(),
              authorization_version = authorization_version + 1
        WHERE tenant_id = $1 AND opportunity_id = $2 AND authorization_version = $4
        RETURNING ${OPPORTUNITY_COLUMNS}`,
      [input.tenantId, input.opportunityId, actor, input.expectedVersion],
    );
    if (written.rows.length === 0) {
      return { outcome: 'version_conflict' as const, currentVersion: current.authorizationVersion };
    }
    const opportunity = mapOpportunity(written.rows[0] as Row);
    await tx.query(
      `INSERT INTO opportunity_assignments
         (tenant_id, opportunity_id, from_user_link_id, to_user_link_id, reason,
          note, assigned_by_user_link_id)
       VALUES ($1, $2, NULL, $3, 'manual_assignment', 'accepted by the salesperson', $3)`,
      [input.tenantId, input.opportunityId, actor],
    );
    const mutation = await recordMutation(tx, {
      tenantId: input.tenantId,
      entityType: 'opportunity',
      entityId: opportunity.opportunityId,
      eventType: 'sales.opportunity.accepted',
      actingUserLinkId: actor,
      authorizationVersion: opportunity.authorizationVersion,
      details: { owner: actor },
    });
    return { outcome: 'accepted' as const, opportunity, mutation };
  });
}

export type AssignOutcome =
  | { outcome: 'assigned'; opportunity: OpportunityView; mutation: MutationResult }
  | { outcome: 'already_assigned'; opportunity: OpportunityView }
  | { outcome: 'version_conflict'; currentVersion: number }
  | { outcome: 'not_found' }
  | { outcome: 'invalid'; error: string };

/**
 * A MANAGER GIVING THE DEAL TO SOMEBODY, with the history kept.
 *
 * `opportunities.owner_user_link_id` is the current answer;
 * `opportunity_assignments` is how it got there, append-only, which is what a
 * commission dispute needs a year later.
 *
 * IDEMPOTENTLY REPLAYABLE. Assigning it to whoever already has it answers
 * `already_assigned` and writes nothing — so a retried request, a double
 * submit, or a client that lost the response and sent again all converge
 * instead of producing a second history row or a version conflict.
 */
export async function assignOpportunity(input: {
  actingUserLinkId: string;
  tenantId: string;
  opportunityId: string;
  expectedVersion: number;
  toUserLinkId: string;
  reason: AssignmentReason;
  note?: string | null | undefined;
}): Promise<AssignOutcome> {
  return withTenantTransaction(input.tenantId, async (tx) => {
    const actor = await requireActor(tx, input.actingUserLinkId);
    const existing = await tx.query(
      `SELECT ${OPPORTUNITY_COLUMNS} FROM opportunities
        WHERE tenant_id = $1 AND opportunity_id = $2 FOR UPDATE`,
      [input.tenantId, input.opportunityId],
    );
    if (existing.rows.length === 0) return { outcome: 'not_found' as const };
    const current = mapOpportunity(existing.rows[0] as Row);

    // THE REPLAY ANSWER COMES FIRST, before the version check. A caller who
    // retried a request that already succeeded holds a stale version BECAUSE it
    // succeeded; refusing them on that basis would make the retry unsafe.
    if (current.ownerUserLinkId === input.toUserLinkId) {
      return { outcome: 'already_assigned' as const, opportunity: current };
    }
    if (TERMINAL_STAGES.includes(current.stage)) {
      return {
        outcome: 'invalid' as const,
        error: `a ${current.stage} opportunity takes no further work`,
      };
    }
    if (current.authorizationVersion !== input.expectedVersion) {
      return { outcome: 'version_conflict' as const, currentVersion: current.authorizationVersion };
    }
    if (!ASSIGNMENT_REASONS.includes(input.reason)) {
      return {
        outcome: 'invalid' as const,
        error: `an assignment is ${ASSIGNMENT_REASONS.join(', ')} — not ${input.reason}`,
      };
    }
    if (!(await reaches(input.tenantId, input.toUserLinkId, current.rooftopId))) {
      return {
        outcome: 'invalid' as const,
        error: 'that employee does not work the rooftop this opportunity belongs to',
      };
    }

    const written = await tx.query(
      `UPDATE opportunities
          SET owner_user_link_id = $3, updated_by_user_link_id = $4, updated_at = NOW(),
              authorization_version = authorization_version + 1
        WHERE tenant_id = $1 AND opportunity_id = $2 AND authorization_version = $5
        RETURNING ${OPPORTUNITY_COLUMNS}`,
      [input.tenantId, input.opportunityId, input.toUserLinkId, actor, input.expectedVersion],
    );
    if (written.rows.length === 0) {
      return { outcome: 'version_conflict' as const, currentVersion: current.authorizationVersion };
    }
    const opportunity = mapOpportunity(written.rows[0] as Row);
    await tx.query(
      `INSERT INTO opportunity_assignments
         (tenant_id, opportunity_id, from_user_link_id, to_user_link_id, reason,
          note, assigned_by_user_link_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        input.tenantId,
        input.opportunityId,
        current.ownerUserLinkId,
        input.toUserLinkId,
        input.reason,
        input.note ?? null,
        actor,
      ],
    );
    const mutation = await recordMutation(tx, {
      tenantId: input.tenantId,
      entityType: 'opportunity',
      entityId: opportunity.opportunityId,
      eventType: 'sales.opportunity.assigned',
      actingUserLinkId: actor,
      authorizationVersion: opportunity.authorizationVersion,
      details: { reason: input.reason, to_user_link_id: input.toUserLinkId },
    });
    return { outcome: 'assigned' as const, opportunity, mutation };
  });
}

// ── the stage machine, and the one fact it may hand on ───────────────────────

export type StageOutcome =
  | {
      outcome: 'moved';
      opportunity: OpportunityView;
      /** Set only on the move to `ready_for_desking`. */
      deskingHandoffId: string | null;
      mutation: MutationResult;
    }
  | { outcome: 'already_there'; opportunity: OpportunityView; deskingHandoffId: string | null }
  | { outcome: 'version_conflict'; currentVersion: number }
  | { outcome: 'not_found' }
  | { outcome: 'invalid'; error: string };

/**
 * MOVES AN OPPORTUNITY, and — on exactly one move — hands it to desking.
 *
 * IDEMPOTENTLY REPLAYABLE, the same way assignment is: a caller asking for the
 * stage it is already in is told `already_there` and nothing is written, so a
 * retry is safe. That matters most on the desking move, where a second write
 * would mean a second file on the desk; the answer carries the EXISTING
 * handoff id, so the caller sees the same fact rather than a new one.
 *
 * WHAT THE POSITIVE MOVE DOES, AND ALL IT DOES. It stamps the opportunity, it
 * writes ONE `desking_handoffs` row whose unique key is the idempotence
 * guarantee, and it raises ONE outbox event in the SAME transaction. It does
 * not touch inventory, does not create a deal, a delivery or a sale, and
 * records no figure — there is nowhere in this train to put one.
 */
export async function moveOpportunityStage(input: {
  actingUserLinkId: string;
  tenantId: string;
  opportunityId: string;
  toStage: OpportunityStage;
  expectedVersion: number;
  disposition?: OpportunityDisposition | null | undefined;
  note?: string | null | undefined;
}): Promise<StageOutcome> {
  if (!OPPORTUNITY_STAGES.includes(input.toStage)) {
    return { outcome: 'invalid', error: `unknown stage ${input.toStage}` };
  }
  return withTenantTransaction(input.tenantId, async (tx) => {
    const actor = await requireActor(tx, input.actingUserLinkId);
    const existing = await tx.query(
      `SELECT ${OPPORTUNITY_COLUMNS} FROM opportunities
        WHERE tenant_id = $1 AND opportunity_id = $2 FOR UPDATE`,
      [input.tenantId, input.opportunityId],
    );
    if (existing.rows.length === 0) return { outcome: 'not_found' as const };
    const current = mapOpportunity(existing.rows[0] as Row);

    // THE REPLAY ANSWER, before the version check and before the machine.
    if (current.stage === input.toStage) {
      const already = await tx.query(
        `SELECT desking_handoff_id FROM desking_handoffs
          WHERE tenant_id = $1 AND opportunity_id = $2`,
        [input.tenantId, input.opportunityId],
      );
      return {
        outcome: 'already_there' as const,
        opportunity: current,
        deskingHandoffId:
          already.rows.length === 0 ? null : String((already.rows[0] as Row).desking_handoff_id),
      };
    }

    const allowed = LEGAL_STAGES[current.stage];
    if (!allowed.includes(input.toStage)) {
      return {
        outcome: 'invalid' as const,
        error:
          allowed.length === 0
            ? `a ${current.stage} opportunity is finished and cannot move`
            : `a ${current.stage} opportunity may move to ${allowed.join(', ')} — not ${input.toStage}`,
      };
    }
    if (current.authorizationVersion !== input.expectedVersion) {
      return { outcome: 'version_conflict' as const, currentVersion: current.authorizationVersion };
    }

    const terminal = TERMINAL_STAGES.includes(input.toStage);
    const disposition = input.disposition ?? null;
    if (disposition !== null && !OPPORTUNITY_DISPOSITIONS.includes(disposition)) {
      return {
        outcome: 'invalid' as const,
        error: `an opportunity concludes ${OPPORTUNITY_DISPOSITIONS.join(', ')} — not ${disposition}`,
      };
    }
    if (terminal && disposition === null) {
      return { outcome: 'invalid' as const, error: 'concluding an opportunity states why' };
    }
    if (!terminal && disposition !== null) {
      return {
        outcome: 'invalid' as const,
        error: `a ${input.toStage} opportunity is not concluded, so it carries no disposition`,
      };
    }
    if (input.toStage === 'ready_for_desking' && disposition !== 'committed_to_purchase') {
      return {
        outcome: 'invalid' as const,
        error: 'an opportunity reaches desking because the customer committed to purchase',
      };
    }
    if (input.toStage === 'lost' && disposition === 'committed_to_purchase') {
      return {
        outcome: 'invalid' as const,
        error: 'a lost opportunity did not commit to purchase',
      };
    }
    // A FOLLOW-UP IS A PROMISE, AND IT NEEDS A DATE. Moving a deal to follow-up
    // with nothing owed is how a pipeline fills with rows nobody looks at
    // again.
    if (input.toStage === 'follow_up') {
      const owed = await tx.query(
        `SELECT 1 FROM opportunity_activities
          WHERE tenant_id = $1 AND opportunity_id = $2
            AND state = 'open' AND due_at IS NOT NULL
          LIMIT 1`,
        [input.tenantId, input.opportunityId],
      );
      if (owed.rows.length === 0) {
        return {
          outcome: 'invalid' as const,
          error: 'a follow-up needs something owed: log the task that is due first',
        };
      }
    }

    const written = await tx.query(
      `UPDATE opportunities
          SET stage = $3,
              disposition = $4,
              desking_ready_at = CASE WHEN $3 = 'ready_for_desking'
                                      THEN NOW() ELSE desking_ready_at END,
              lost_at = CASE WHEN $3 = 'lost' THEN NOW() ELSE lost_at END,
              updated_by_user_link_id = $5, updated_at = NOW(),
              authorization_version = authorization_version + 1
        WHERE tenant_id = $1 AND opportunity_id = $2 AND authorization_version = $6
        RETURNING ${OPPORTUNITY_COLUMNS}`,
      [
        input.tenantId,
        input.opportunityId,
        input.toStage,
        terminal ? disposition : null,
        actor,
        input.expectedVersion,
      ],
    );
    if (written.rows.length === 0) {
      return { outcome: 'version_conflict' as const, currentVersion: current.authorizationVersion };
    }
    const opportunity = mapOpportunity(written.rows[0] as Row);
    await tx.query(
      `INSERT INTO opportunity_stage_events
         (tenant_id, opportunity_id, from_stage, to_stage, disposition, note,
          changed_by_user_link_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        input.tenantId,
        input.opportunityId,
        current.stage,
        input.toStage,
        terminal ? disposition : null,
        input.note ?? null,
        actor,
      ],
    );

    // ── the one fact this train may hand on ──────────────────────────────────
    let deskingHandoffId: string | null = null;
    if (input.toStage === 'ready_for_desking') {
      const selected = await tx.query(
        `SELECT stock_item_id FROM opportunity_vehicles
          WHERE tenant_id = $1 AND opportunity_id = $2 AND status = 'selected'`,
        [input.tenantId, input.opportunityId],
      );
      const stockItemId =
        selected.rows.length === 0 ? null : String((selected.rows[0] as Row).stock_item_id);

      // The event is raised FIRST so the row can carry its id, and both are in
      // this transaction: the fact and its delivery commit together or not at
      // all. The row's unique key is what makes it exactly one.
      const eventId = await enqueueAdminOutboxEvent(tx, {
        tenantId: input.tenantId,
        eventType: DESKING_READY_EVENT,
        payload: {
          opportunity_id: input.opportunityId,
          rooftop_id: opportunity.rooftopId,
          party_id: opportunity.partyId,
          stock_item_id: stockItemId,
        },
      });
      const fact = await tx.query(
        `INSERT INTO desking_handoffs
           (tenant_id, opportunity_id, rooftop_id, party_id, stock_item_id,
            handed_by_user_link_id, outbox_event_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING desking_handoff_id`,
        [
          input.tenantId,
          input.opportunityId,
          opportunity.rooftopId,
          opportunity.partyId,
          stockItemId,
          actor,
          eventId,
        ],
      );
      deskingHandoffId = String((fact.rows[0] as Row).desking_handoff_id);
    }

    const mutation = await recordMutation(tx, {
      tenantId: input.tenantId,
      entityType: 'opportunity',
      entityId: opportunity.opportunityId,
      eventType: 'sales.opportunity.stage_changed',
      actingUserLinkId: actor,
      authorizationVersion: opportunity.authorizationVersion,
      details: {
        from_stage: current.stage,
        to_stage: input.toStage,
        disposition: terminal ? disposition : null,
        desking_handoff_id: deskingHandoffId,
      },
    });
    return { outcome: 'moved' as const, opportunity, deskingHandoffId, mutation };
  });
}

// ── shared helpers the rest of the package authorizes through ────────────────

export async function getOpportunity(
  tenantId: string,
  opportunityId: string,
): Promise<OpportunityView | null> {
  return withTenantTransaction(tenantId, async (tx) => {
    const found = await tx.query(
      `SELECT ${OPPORTUNITY_COLUMNS} FROM opportunities
        WHERE tenant_id = $1 AND opportunity_id = $2`,
      [tenantId, opportunityId],
    );
    return found.rows.length === 0 ? null : mapOpportunity(found.rows[0] as Row);
  });
}

/** Terminal opportunities are finished; children refuse to be written. */
export async function assertOpportunityOpen(
  executor: Executor,
  tenantId: string,
  opportunityId: string,
): Promise<
  { ok: true; opportunity: OpportunityView } | { ok: false; reason: 'not_found' | string }
> {
  const found = await executor.query(
    `SELECT ${OPPORTUNITY_COLUMNS} FROM opportunities
      WHERE tenant_id = $1 AND opportunity_id = $2`,
    [tenantId, opportunityId],
  );
  if (found.rows.length === 0) return { ok: false, reason: 'not_found' };
  const opportunity = mapOpportunity(found.rows[0] as Row);
  if (TERMINAL_STAGES.includes(opportunity.stage)) {
    return { ok: false, reason: `a ${opportunity.stage} opportunity takes no further work` };
  }
  return { ok: true, opportunity };
}
