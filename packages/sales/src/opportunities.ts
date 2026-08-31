/**
 * RELEASE TRAIN 4 — THE OPPORTUNITY, AND THE SEAM IT COMES THROUGH.
 *
 * AN OPPORTUNITY CANNOT BE CONJURED. It is created FROM a lead handoff and
 * from nothing else, which is what makes the two trains one pipeline rather
 * than two systems that happen to share a database. Release Train 3 froze a
 * snapshot at the moment of the handoff; this reads it, and one handoff yields
 * exactly one opportunity — a database constraint, so a retried creation
 * converges instead of splitting a customer's history in two.
 *
 * THE STAGE MACHINE IS ENUMERATED and its terminal states absorb, for the same
 * reason the lead's does: a won opportunity that can be moved back into
 * negotiation is a close-rate report nobody can trust.
 *
 * NO MONEY PASSES THROUGH HERE. `deal_status` says NOT_YET_AVAILABLE and
 * migration 064's `ck_opportunity_pre_deal` refuses anything else, because a
 * customer agreeing to buy is not the same fact as a deal record existing, and
 * FBL-140 is what writes the second one.
 */
import { withTenantTransaction, type Executor } from '@dealer/database';
import {
  permittedRooftopIds,
  recordMutation,
  requireActor,
  type MutationResult,
} from '@dealer/identity-access';

interface Row {
  [key: string]: unknown;
}

export type OpportunityStage =
  'received' | 'in_showroom' | 'demonstrated' | 'negotiating' | 'won' | 'lost';

export type OpportunityDisposition =
  | 'sold'
  | 'lost_to_competitor'
  | 'lost_no_decision'
  | 'lost_credit'
  | 'lost_no_vehicle'
  | 'customer_unreachable';

/**
 * THE VOCABULARIES ARE THE SERVICE'S TO ENFORCE, not the CHECK constraint's.
 *
 * Migration 064 constrains each of these columns, so an unknown value cannot be
 * stored either way. The difference is what the caller is TOLD: a value that
 * travels to the constraint comes back as a 500, which reads as "the platform
 * broke" rather than "that is not one of the words", and it takes a database
 * log to find out which field was wrong.
 */
export const OPPORTUNITY_DISPOSITIONS: readonly OpportunityDisposition[] = [
  'sold',
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

export const OPPORTUNITY_STAGES: readonly OpportunityStage[] = [
  'received',
  'in_showroom',
  'demonstrated',
  'negotiating',
  'won',
  'lost',
];

/**
 * THE MACHINE, WRITTEN DOWN ONCE.
 *
 * A customer can walk in, drive something and negotiate, or negotiate without
 * ever driving — so the moves forward skip freely. What they cannot do is go
 * backwards out of a terminal state, and `lost` is reachable from everywhere
 * because a customer can stop at any point and most of them do.
 */
const LEGAL_STAGES: Record<OpportunityStage, readonly OpportunityStage[]> = {
  received: ['in_showroom', 'demonstrated', 'negotiating', 'won', 'lost'],
  in_showroom: ['demonstrated', 'negotiating', 'won', 'lost'],
  demonstrated: ['negotiating', 'in_showroom', 'won', 'lost'],
  negotiating: ['demonstrated', 'won', 'lost'],
  won: [],
  lost: [],
};

export interface OpportunityView {
  readonly opportunityId: string;
  readonly rooftopId: string;
  readonly partyId: string;
  readonly handoffId: string;
  readonly leadId: string;
  readonly ownerUserLinkId: string | null;
  readonly stage: OpportunityStage;
  readonly disposition: OpportunityDisposition | null;
  readonly dealStatus: 'NOT_YET_AVAILABLE' | 'AVAILABLE';
  readonly wonAt: string | null;
  readonly lostAt: string | null;
  readonly authorizationVersion: number;
  readonly createdAt: string;
}

export const OPPORTUNITY_COLUMNS = `opportunity_id, rooftop_id, party_id, handoff_id, lead_id,
       owner_user_link_id, stage, disposition, deal_status, won_at, lost_at,
       authorization_version, created_at`;

export function mapOpportunity(row: Row): OpportunityView {
  const iso = (v: unknown): string | null =>
    v === null ? null : new Date(v as string).toISOString();
  return {
    opportunityId: String(row.opportunity_id),
    rooftopId: String(row.rooftop_id),
    partyId: String(row.party_id),
    handoffId: String(row.handoff_id),
    leadId: String(row.lead_id),
    ownerUserLinkId: row.owner_user_link_id === null ? null : String(row.owner_user_link_id),
    stage: String(row.stage) as OpportunityStage,
    disposition:
      row.disposition === null ? null : (String(row.disposition) as OpportunityDisposition),
    dealStatus: String(row.deal_status) as 'NOT_YET_AVAILABLE' | 'AVAILABLE',
    wonAt: iso(row.won_at),
    lostAt: iso(row.lost_at),
    authorizationVersion: Number(row.authorization_version),
    createdAt: new Date(row.created_at as string).toISOString(),
  };
}

export type ReceiveOutcome =
  | { outcome: 'received'; opportunity: OpportunityView; mutation: MutationResult }
  | { outcome: 'already_received'; opportunity: OpportunityView }
  | { outcome: 'not_found' }
  | { outcome: 'invalid'; error: string };

/**
 * RECEIVES A HANDED-OFF LEAD INTO THE PIPELINE.
 *
 * The handoff is the only door. Everything the opportunity needs — the
 * customer, the rooftop, the lead behind it — is read from the handoff and its
 * lead rather than taken from the caller, so an opportunity cannot be created
 * for a customer at a rooftop the handoff never named.
 */
export async function receiveHandoffWithin(
  executor: Executor,
  input: { actingUserLinkId: string; tenantId: string; handoffId: string },
): Promise<ReceiveOutcome> {
  const actor = await requireActor(executor, input.actingUserLinkId);

  const existing = await executor.query(
    `SELECT ${OPPORTUNITY_COLUMNS} FROM opportunities
      WHERE tenant_id = $1 AND handoff_id = $2`,
    [input.tenantId, input.handoffId],
  );
  if (existing.rows.length > 0) {
    return { outcome: 'already_received', opportunity: mapOpportunity(existing.rows[0] as Row) };
  }

  // THE FACTS COME FROM THE HANDOFF, not from the request. A caller who could
  // name the rooftop could put somebody else's customer on their own floor.
  const handoff = await executor.query(
    `SELECT h.handoff_id, h.lead_id, l.rooftop_id, l.party_id, l.lifecycle_state
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

  const written = await executor.query(
    `INSERT INTO opportunities
       (tenant_id, rooftop_id, party_id, handoff_id, lead_id,
        created_by_user_link_id, updated_by_user_link_id)
     VALUES ($1, $2, $3, $4, $5, $6, $6)
     RETURNING ${OPPORTUNITY_COLUMNS}`,
    [
      input.tenantId,
      String(seam.rooftop_id),
      String(seam.party_id),
      input.handoffId,
      String(seam.lead_id),
      actor,
    ],
  );
  const opportunity = mapOpportunity(written.rows[0] as Row);
  const mutation = await recordMutation(executor, {
    tenantId: input.tenantId,
    entityType: 'opportunity',
    entityId: opportunity.opportunityId,
    eventType: 'sales.opportunity.received',
    actingUserLinkId: actor,
    authorizationVersion: opportunity.authorizationVersion,
    details: { handoff_id: input.handoffId, lead_id: opportunity.leadId },
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

export type StageOutcome =
  | { outcome: 'moved'; opportunity: OpportunityView; mutation: MutationResult }
  | { outcome: 'version_conflict'; currentVersion: number }
  | { outcome: 'not_found' }
  | { outcome: 'invalid'; error: string };

/**
 * Moves an opportunity along the machine under optimistic concurrency. A move
 * the machine does not allow is refused BY NAME, because an interface that
 * silently ignores a button teaches its users the button is broken.
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
    if (current.authorizationVersion !== input.expectedVersion) {
      return { outcome: 'version_conflict' as const, currentVersion: current.authorizationVersion };
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

    const terminal = input.toStage === 'won' || input.toStage === 'lost';
    const disposition = input.disposition ?? null;
    if (disposition !== null && !OPPORTUNITY_DISPOSITIONS.includes(disposition)) {
      return {
        outcome: 'invalid' as const,
        error: `an opportunity closes ${OPPORTUNITY_DISPOSITIONS.join(', ')} — not ${disposition}`,
      };
    }
    if (terminal && disposition === null) {
      return { outcome: 'invalid' as const, error: 'closing an opportunity states why' };
    }
    if (input.toStage === 'won' && disposition !== 'sold') {
      return { outcome: 'invalid' as const, error: 'a won opportunity was sold' };
    }
    if (input.toStage === 'lost' && disposition === 'sold') {
      return { outcome: 'invalid' as const, error: 'a lost opportunity was not sold' };
    }

    const written = await tx.query(
      `UPDATE opportunities
          SET stage = $3,
              disposition = $4,
              won_at = CASE WHEN $3 = 'won' THEN NOW() ELSE won_at END,
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
        ...(terminal ? { disposition } : {}),
      },
    });
    return { outcome: 'moved' as const, opportunity, mutation };
  });
}

export type AssignOutcome =
  | { outcome: 'assigned'; opportunity: OpportunityView; mutation: MutationResult }
  | { outcome: 'version_conflict'; currentVersion: number }
  | { outcome: 'not_found' }
  | { outcome: 'invalid'; error: string };

/**
 * Puts the opportunity in a salesperson's hands.
 *
 * The assignee must be able to REACH the rooftop, read from their effective
 * bindings through the shared predicate — the same rule Release Train 3's lead
 * assignment learned the hard way. Without it the platform accepts a request
 * that produces an opportunity nobody can work: the owner opens it and is told
 * by the policy engine that their own customer does not exist.
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
    if (current.stage === 'won' || current.stage === 'lost') {
      return {
        outcome: 'invalid' as const,
        error: `a ${current.stage} opportunity is finished and is not reassignable`,
      };
    }
    if (current.authorizationVersion !== input.expectedVersion) {
      return { outcome: 'version_conflict' as const, currentVersion: current.authorizationVersion };
    }
    if (current.ownerUserLinkId === input.toUserLinkId) {
      return { outcome: 'invalid' as const, error: 'that is already whose it is' };
    }
    if (!ASSIGNMENT_REASONS.includes(input.reason)) {
      return {
        outcome: 'invalid' as const,
        error: `an assignment is ${ASSIGNMENT_REASONS.join(', ')} — not ${input.reason}`,
      };
    }
    const reach = await permittedRooftopIds(input.tenantId, input.toUserLinkId);
    if (!reach.includes(current.rooftopId)) {
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
         (tenant_id, opportunity_id, from_user_link_id, to_user_link_id, reason, note,
          assigned_by_user_link_id)
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
  if (opportunity.stage === 'won' || opportunity.stage === 'lost') {
    return { ok: false, reason: `a ${opportunity.stage} opportunity takes no further work` };
  }
  return { ok: true, opportunity };
}
