/**
 * RELEASE TRAIN 3, ROW 2 — ROUTING, OWNERSHIP AND THE CLOCK.
 *
 * Three things live here and they are one subject: WHO has the lead, HOW LONG
 * they have had it, and WHAT HAPPENS when that is too long.
 *
 *   * ASSIGNMENT IS A MOVE, RECORDED. `leads.owner_user_link_id` is the current
 *     answer and `lead_assignments` is how it got there. Reassignment disputes
 *     are about history, and a current-owner column cannot settle one.
 *   * ASSIGNMENT IS CONCURRENCY-SAFE. The lead row is locked and the caller's
 *     version is checked, so two managers reassigning at once produce one move
 *     and one refusal rather than a last-writer-wins shrug.
 *   * ESCALATION IS IDEMPOTENT BY CONSTRUCTION. The sweep can run every minute,
 *     twice at once, or twice after a crash, and a lead is escalated once:
 *     `lead_escalations` is unique on (lead, level), so the second attempt is
 *     refused by the database rather than by hoping the sweep is a singleton.
 */
import { withTenantTransaction, type Executor } from '@dealer/database';
import {
  permittedRooftopIds,
  recordMutation,
  requireActor,
  type MutationResult,
} from '@dealer/identity-access';
import { mapLead, type LeadView } from './leads';

interface Row {
  [key: string]: unknown;
}

const LEAD_COLUMNS = `lead_id, rooftop_id, party_id, interest_stock_item_id, interest_vehicle_id,
       lifecycle_state, disposition, owner_user_link_id, queue_id, primary_source_id,
       first_response_due_at, escalate_at, first_response_at, escalated_at, handed_off_at, closed_at,
       authorization_version, created_at, updated_at`;

// ── queues ──────────────────────────────────────────────────────────────────

export interface QueueView {
  readonly queueId: string;
  readonly rooftopId: string;
  readonly name: string;
  readonly status: 'active' | 'retired';
  readonly authorizationVersion: number;
}

function mapQueue(row: Row): QueueView {
  return {
    queueId: String(row.queue_id),
    rooftopId: String(row.rooftop_id),
    name: String(row.name),
    status: String(row.status) as 'active' | 'retired',
    authorizationVersion: Number(row.authorization_version),
  };
}

const QUEUE_COLUMNS = `queue_id, rooftop_id, name, status, authorization_version`;

export type QueueOutcome =
  | { outcome: 'saved'; queue: QueueView; mutation: MutationResult }
  | { outcome: 'duplicate'; queue: QueueView }
  | { outcome: 'invalid'; error: string };

export async function createQueueWithin(
  executor: Executor,
  input: { actingUserLinkId: string; tenantId: string; rooftopId: string; name: string },
): Promise<QueueOutcome> {
  const name = (input.name ?? '').trim();
  if (name.length === 0 || name.length > 120) {
    return { outcome: 'invalid', error: 'a queue needs a name' };
  }
  const actor = await requireActor(executor, input.actingUserLinkId);
  const existing = await executor.query(
    `SELECT ${QUEUE_COLUMNS} FROM lead_queues
      WHERE tenant_id = $1 AND rooftop_id = $2 AND lower(name) = lower($3) AND status = 'active'`,
    [input.tenantId, input.rooftopId, name],
  );
  if (existing.rows.length > 0) {
    return { outcome: 'duplicate', queue: mapQueue(existing.rows[0] as Row) };
  }
  const written = await executor.query(
    `INSERT INTO lead_queues
       (tenant_id, rooftop_id, name, created_by_user_link_id, updated_by_user_link_id)
     VALUES ($1, $2, $3, $4, $4) RETURNING ${QUEUE_COLUMNS}`,
    [input.tenantId, input.rooftopId, name, actor],
  );
  const queue = mapQueue(written.rows[0] as Row);
  const mutation = await recordMutation(executor, {
    tenantId: input.tenantId,
    entityType: 'lead_queue',
    entityId: queue.queueId,
    eventType: 'crm.queue.created',
    actingUserLinkId: actor,
    authorizationVersion: queue.authorizationVersion,
    details: { rooftop_id: input.rooftopId },
  });
  return { outcome: 'saved', queue, mutation };
}

export async function createQueue(input: {
  actingUserLinkId: string;
  tenantId: string;
  rooftopId: string;
  name: string;
}): Promise<QueueOutcome> {
  return withTenantTransaction(input.tenantId, (tx) => createQueueWithin(tx, input));
}

export async function listQueues(tenantId: string, rooftopIds: string[]): Promise<QueueView[]> {
  return withTenantTransaction(tenantId, async (tx) => {
    const found = await tx.query(
      `SELECT ${QUEUE_COLUMNS} FROM lead_queues
        WHERE tenant_id = $1 AND status = 'active' AND rooftop_id = ANY($2::uuid[])
        ORDER BY name`,
      [tenantId, rooftopIds],
    );
    return (found.rows as Row[]).map(mapQueue);
  });
}

// ── assignment ──────────────────────────────────────────────────────────────

export type AssignmentReason =
  'initial_routing' | 'manual_assignment' | 'reassignment' | 'escalation' | 'queue_return';

export type AssignOutcome =
  | { outcome: 'assigned'; lead: LeadView; mutation: MutationResult }
  | { outcome: 'version_conflict'; currentVersion: number }
  | { outcome: 'not_found' }
  | { outcome: 'invalid'; error: string };

/**
 * Puts the lead in somebody's hands, or back in a queue.
 *
 * A lead that has been handed to sales is not reassignable: this train's
 * authority over it ended at the seam, and letting a BDC manager move its owner
 * afterwards would make the handoff snapshot a lie.
 */
export async function assignLead(input: {
  actingUserLinkId: string;
  tenantId: string;
  leadId: string;
  expectedVersion: number;
  toUserLinkId?: string | null | undefined;
  queueId?: string | null | undefined;
  reason: AssignmentReason;
  note?: string | null | undefined;
}): Promise<AssignOutcome> {
  const toUser = input.toUserLinkId ?? null;
  const queueId = input.queueId ?? null;
  if (toUser === null && queueId === null) {
    return { outcome: 'invalid', error: 'an assignment names a person or a queue' };
  }
  return withTenantTransaction(input.tenantId, async (tx) => {
    const actor = await requireActor(tx, input.actingUserLinkId);
    const existing = await tx.query(
      `SELECT ${LEAD_COLUMNS} FROM leads WHERE tenant_id = $1 AND lead_id = $2 FOR UPDATE`,
      [input.tenantId, input.leadId],
    );
    if (existing.rows.length === 0) return { outcome: 'not_found' as const };
    const current = mapLead(existing.rows[0] as Row);
    if (current.lifecycleState === 'handed_off' || current.lifecycleState === 'closed') {
      return {
        outcome: 'invalid' as const,
        error: `a ${current.lifecycleState} lead is no longer the CRM's to assign`,
      };
    }
    if (current.authorizationVersion !== input.expectedVersion) {
      return { outcome: 'version_conflict' as const, currentVersion: current.authorizationVersion };
    }
    if (current.ownerUserLinkId === toUser && current.queueId === queueId) {
      return { outcome: 'invalid' as const, error: 'that is already where the lead is' };
    }

    // ASSIGNMENT AUTHORITY (RT3-C1 §2). A lead may only be handed to somebody
    // who can actually reach its rooftop. Without this an authorized manager
    // could park a Downtown lead on a Northside-only agent, who would then be
    // told by the policy engine that their own lead does not exist — a lead
    // nobody can work, produced by a request the platform accepted.
    //
    // The list comes from the actor's EFFECTIVE bindings, through the same
    // shared predicate the engine decides from, so an assignment cannot outlive
    // the authority behind it.
    if (toUser !== null) {
      const reach = await permittedRooftopIds(input.tenantId, toUser);
      if (!reach.includes(current.rooftopId)) {
        return {
          outcome: 'invalid' as const,
          error: 'that employee does not work the rooftop this lead belongs to',
        };
      }
    }

    // A QUEUE BELONGS TO ONE ROOFTOP, and a lead may only wait in a queue at
    // its own. The composite key makes a cross-tenant queue unrepresentable;
    // this is the rooftop half of the same idea.
    if (queueId !== null) {
      const queue = await tx.query(
        `SELECT rooftop_id FROM lead_queues
          WHERE tenant_id = $1 AND queue_id = $2 AND status = 'active'`,
        [input.tenantId, queueId],
      );
      if (queue.rows.length === 0) return { outcome: 'not_found' as const };
      if (String((queue.rows[0] as Row).rooftop_id) !== current.rooftopId) {
        return {
          outcome: 'invalid' as const,
          error: 'that queue belongs to a different rooftop',
        };
      }
    }

    const written = await tx.query(
      `UPDATE leads
          SET owner_user_link_id = $3, queue_id = $4,
              lifecycle_state = CASE WHEN lifecycle_state = 'new' AND $3::uuid IS NOT NULL
                                     THEN 'working' ELSE lifecycle_state END,
              updated_by_user_link_id = $5, updated_at = NOW(),
              authorization_version = authorization_version + 1
        WHERE tenant_id = $1 AND lead_id = $2 AND authorization_version = $6
        RETURNING ${LEAD_COLUMNS}`,
      [input.tenantId, input.leadId, toUser, queueId, actor, input.expectedVersion],
    );
    if (written.rows.length === 0) {
      return { outcome: 'version_conflict' as const, currentVersion: current.authorizationVersion };
    }
    const lead = mapLead(written.rows[0] as Row);
    if (current.lifecycleState === 'new' && lead.lifecycleState === 'working') {
      await tx.query(
        `INSERT INTO lead_status_events
           (tenant_id, lead_id, from_state, to_state, changed_by_user_link_id)
         VALUES ($1, $2, 'new', 'working', $3)`,
        [input.tenantId, input.leadId, actor],
      );
    }
    await tx.query(
      `INSERT INTO lead_assignments
         (tenant_id, lead_id, from_user_link_id, to_user_link_id, queue_id, reason, note,
          assigned_by_user_link_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        input.tenantId,
        input.leadId,
        current.ownerUserLinkId,
        toUser,
        queueId,
        input.reason,
        input.note ?? null,
        actor,
      ],
    );
    const mutation = await recordMutation(tx, {
      tenantId: input.tenantId,
      entityType: 'lead',
      entityId: lead.leadId,
      eventType: 'crm.lead.assigned',
      actingUserLinkId: actor,
      authorizationVersion: lead.authorizationVersion,
      details: { reason: input.reason, to_user_link_id: toUser, queue_id: queueId },
    });
    return { outcome: 'assigned' as const, lead, mutation };
  });
}

// ── the clock ───────────────────────────────────────────────────────────────

export interface SlaPolicyView {
  readonly slaPolicyId: string;
  readonly rooftopId: string;
  readonly firstResponseMinutes: number;
  readonly escalateAfterMinutes: number;
  readonly authorizationVersion: number;
}

const SLA_COLUMNS = `sla_policy_id, rooftop_id, first_response_minutes, escalate_after_minutes,
       authorization_version`;

function mapSla(row: Row): SlaPolicyView {
  return {
    slaPolicyId: String(row.sla_policy_id),
    rooftopId: String(row.rooftop_id),
    firstResponseMinutes: Number(row.first_response_minutes),
    escalateAfterMinutes: Number(row.escalate_after_minutes),
    authorizationVersion: Number(row.authorization_version),
  };
}

export type SlaOutcome =
  | { outcome: 'saved'; policy: SlaPolicyView; mutation: MutationResult }
  | { outcome: 'invalid'; error: string };

/**
 * Sets the rooftop's response policy. SUPERSEDE-THEN-INSERT, for the same
 * reason Release Train 2 prices that way: the partial unique index admits one
 * live policy per rooftop, so the old one must stop being live before the new
 * one exists, and the history stays readable rather than being overwritten.
 */
export async function setSlaPolicy(input: {
  actingUserLinkId: string;
  tenantId: string;
  rooftopId: string;
  firstResponseMinutes: number;
  escalateAfterMinutes: number;
}): Promise<SlaOutcome> {
  if (!Number.isInteger(input.firstResponseMinutes) || input.firstResponseMinutes < 1) {
    return { outcome: 'invalid', error: 'a response target is a whole number of minutes' };
  }
  if (input.escalateAfterMinutes < input.firstResponseMinutes) {
    return { outcome: 'invalid', error: 'escalation cannot precede the response it escalates' };
  }
  return withTenantTransaction(input.tenantId, async (tx) => {
    const actor = await requireActor(tx, input.actingUserLinkId);
    await tx.query(
      `UPDATE lead_sla_policies
          SET status = 'superseded', updated_by_user_link_id = $3, updated_at = NOW(),
              authorization_version = authorization_version + 1
        WHERE tenant_id = $1 AND rooftop_id = $2 AND status = 'active'`,
      [input.tenantId, input.rooftopId, actor],
    );
    const written = await tx.query(
      `INSERT INTO lead_sla_policies
         (tenant_id, rooftop_id, first_response_minutes, escalate_after_minutes,
          created_by_user_link_id, updated_by_user_link_id)
       VALUES ($1, $2, $3, $4, $5, $5) RETURNING ${SLA_COLUMNS}`,
      [
        input.tenantId,
        input.rooftopId,
        input.firstResponseMinutes,
        input.escalateAfterMinutes,
        actor,
      ],
    );
    const policy = mapSla(written.rows[0] as Row);
    const mutation = await recordMutation(tx, {
      tenantId: input.tenantId,
      entityType: 'lead_sla_policy',
      entityId: policy.slaPolicyId,
      eventType: 'crm.sla_policy.set',
      actingUserLinkId: actor,
      authorizationVersion: policy.authorizationVersion,
      details: {
        rooftop_id: input.rooftopId,
        first_response_minutes: input.firstResponseMinutes,
        escalate_after_minutes: input.escalateAfterMinutes,
      },
    });
    return { outcome: 'saved' as const, policy, mutation };
  });
}

export interface EscalationSweepResult {
  readonly examined: number;
  readonly escalated: number;
  readonly alreadyEscalated: number;
}

/**
 * THE SWEEP. Finds leads whose first-response clock has run out and raises one
 * escalation each.
 *
 * IDEMPOTENT BY CONSTRUCTION, not by luck: `lead_escalations` is unique on
 * (lead, level), so a second sweep — concurrent, retried after a crash, or run
 * by a second worker — inserts nothing and counts it as already raised. There
 * is no "have we escalated this?" read to lose a race on.
 *
 * It also does NOT move the lead's lifecycle. An overdue lead is still whatever
 * it was; escalation is a fact about the clock, and a sweep that changed the
 * funnel would corrupt the funnel with an operational detail.
 */
export async function runEscalationSweep(input: {
  tenantId: string;
  limit?: number | undefined;
}): Promise<EscalationSweepResult> {
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
  return withTenantTransaction(input.tenantId, async (tx) => {
    // THE ESCALATION CLOCK IS ITS OWN CLOCK (RT3-C1 §3).
    //
    // This swept on `first_response_due_at`, which meant a manager was told the
    // instant the promise to the customer came due — leaving
    // `escalate_after_minutes` a policy field nothing read. A dealership that
    // sets a thirty-minute response target and a four-hour escalation is asking
    // for two different things, and honouring only the first makes the second
    // a lie in the settings screen.
    const due = await tx.query(
      `SELECT l.lead_id, l.escalate_at
         FROM leads l
        WHERE l.tenant_id = $1
          AND l.first_response_at IS NULL
          AND l.escalated_at IS NULL
          AND l.escalate_at IS NOT NULL
          AND l.escalate_at <= NOW()
          AND l.lifecycle_state NOT IN ('handed_off', 'closed')
        ORDER BY l.escalate_at
        LIMIT $2
        FOR UPDATE OF l SKIP LOCKED`,
      [input.tenantId, limit],
    );
    let escalated = 0;
    let already = 0;
    for (const row of due.rows as Row[]) {
      const leadId = String(row.lead_id);
      const raised = await tx.query(
        `INSERT INTO lead_escalations (tenant_id, lead_id, level, due_at)
         VALUES ($1, $2, 'first_response', $3)
         ON CONFLICT (tenant_id, lead_id, level) DO NOTHING
         RETURNING escalation_id`,
        [input.tenantId, leadId, row.escalate_at],
      );
      if (raised.rows.length === 0) {
        already += 1;
        continue;
      }
      escalated += 1;
      await tx.query(
        `UPDATE leads SET escalated_at = NOW(), updated_at = NOW()
          WHERE tenant_id = $1 AND lead_id = $2 AND escalated_at IS NULL`,
        [input.tenantId, leadId],
      );
    }
    return { examined: due.rows.length, escalated, alreadyEscalated: already };
  });
}
