/**
 * RELEASE TRAIN 3, ROWS 1 AND 2 — THE LEAD.
 *
 * WHAT A LEAD IS HERE: one customer's interest, at one rooftop, owned by one
 * employee at a time, from the moment it arrives to the moment it is handed to
 * sales. This train stops at that handoff and does not reach past it.
 *
 * FOUR PROPERTIES THIS FILE IS RESPONSIBLE FOR:
 *
 *   * INTAKE CONVERGES. A form submitted twice, a webhook redelivered, two
 *     browser tabs, a retried import row — all of them are ONE lead. Two
 *     mechanisms do it together: an `intake_key` that makes a repeat of the
 *     SAME capture return the SAME answer, and a transaction-scoped advisory
 *     lock on (rooftop, party, interest) that makes two DIFFERENT captures of
 *     the same interest queue rather than race. The partial unique index in
 *     migration 063 is the backstop under both.
 *   * IDENTITY IS BORROWED, NEVER INVENTED. Release Train 2 owns customers. A
 *     lead resolves to an existing party when the contact details match one and
 *     creates one only when they match nothing — so lead intake can never be
 *     the thing that splits a customer in two.
 *   * SOURCE HISTORY IS APPEND-ONLY. Every touch is written and none is edited,
 *     because attribution runs over these rows and a touch that can be
 *     corrected in place is a number that can be corrected in place.
 *   * THE LIFECYCLE IS A MACHINE, NOT A FIELD. Transitions are enumerated,
 *     terminal states are absorbing, and every move writes an event — so the
 *     funnel can be measured rather than inferred from a current-state column.
 */
import { withTenantTransaction, type Executor } from '@dealer/database';
import { recordMutation, requireActor, type MutationResult } from '@dealer/identity-access';
import {
  createPartyWithin,
  normalizeEmail,
  normalizePhone,
  type PartyDetails,
} from '@dealer/inventory';
import { payloadFingerprint, type ProviderLeadPayload } from './providers';

interface Row {
  [key: string]: unknown;
}

export type LeadState =
  'new' | 'working' | 'qualified' | 'appointment_set' | 'handed_off' | 'closed';

export type LeadDisposition =
  | 'sold_elsewhere'
  | 'not_interested'
  | 'unqualified'
  | 'duplicate'
  | 'no_contact'
  | 'handed_to_sales';

export type IntakeChannel = 'manual' | 'import' | 'campaign' | 'website' | 'provider';

export const LEAD_STATES: readonly LeadState[] = [
  'new',
  'working',
  'qualified',
  'appointment_set',
  'handed_off',
  'closed',
];

/**
 * THE STATE MACHINE, WRITTEN DOWN ONCE.
 *
 * `handed_off` and `closed` are ABSORBING: a lead that has been given to sales
 * is not the CRM's to move any more, and a closed lead is reopened by capturing
 * a new one rather than by rewriting history. Every legal move is listed, so a
 * move that is not listed is refused by name rather than by an accident of
 * which `if` ran first.
 */
const LEGAL_TRANSITIONS: Record<LeadState, readonly LeadState[]> = {
  new: ['working', 'closed'],
  working: ['qualified', 'closed'],
  qualified: ['appointment_set', 'handed_off', 'closed'],
  appointment_set: ['qualified', 'handed_off', 'closed'],
  handed_off: [],
  closed: [],
};

export interface LeadView {
  readonly leadId: string;
  readonly rooftopId: string;
  readonly partyId: string;
  readonly interestStockItemId: string | null;
  readonly interestVehicleId: string | null;
  readonly lifecycleState: LeadState;
  readonly disposition: LeadDisposition | null;
  readonly ownerUserLinkId: string | null;
  readonly queueId: string | null;
  readonly primarySourceId: string;
  readonly firstResponseDueAt: string | null;
  readonly escalateAt: string | null;
  readonly firstResponseAt: string | null;
  readonly escalatedAt: string | null;
  readonly handedOffAt: string | null;
  readonly closedAt: string | null;
  readonly authorizationVersion: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const LEAD_COLUMNS = `lead_id, rooftop_id, party_id, interest_stock_item_id, interest_vehicle_id,
       lifecycle_state, disposition, owner_user_link_id, queue_id, primary_source_id,
       first_response_due_at, escalate_at, first_response_at, escalated_at, handed_off_at, closed_at,
       authorization_version, created_at, updated_at`;

export function mapLead(row: Row): LeadView {
  const iso = (v: unknown): string | null =>
    v === null ? null : new Date(v as string).toISOString();
  return {
    leadId: String(row.lead_id),
    rooftopId: String(row.rooftop_id),
    partyId: String(row.party_id),
    interestStockItemId:
      row.interest_stock_item_id === null ? null : String(row.interest_stock_item_id),
    interestVehicleId: row.interest_vehicle_id === null ? null : String(row.interest_vehicle_id),
    lifecycleState: String(row.lifecycle_state) as LeadState,
    disposition: row.disposition === null ? null : (String(row.disposition) as LeadDisposition),
    ownerUserLinkId: row.owner_user_link_id === null ? null : String(row.owner_user_link_id),
    queueId: row.queue_id === null ? null : String(row.queue_id),
    primarySourceId: String(row.primary_source_id),
    firstResponseDueAt: iso(row.first_response_due_at),
    escalateAt: iso(row.escalate_at),
    firstResponseAt: iso(row.first_response_at),
    escalatedAt: iso(row.escalated_at),
    handedOffAt: iso(row.handed_off_at),
    closedAt: iso(row.closed_at),
    authorizationVersion: Number(row.authorization_version),
    createdAt: new Date(row.created_at as string).toISOString(),
    updatedAt: new Date(row.updated_at as string).toISOString(),
  };
}

// ── the intake decision ─────────────────────────────────────────────────────

/**
 * SERIALIZE THE INTAKE DECISION, IN A STABLE ORDER.
 *
 * The same reasoning as the party duplicate decision in Release Train 2: a
 * check followed by a write is a guess two requests can both make. Every
 * capture takes a transaction-scoped advisory lock on the interest it is about
 * to claim, so the second one reads the first one's committed answer instead of
 * racing it. The key is fully qualified, so two dealerships never queue behind
 * each other.
 */
async function lockIntakeDecision(
  executor: Executor,
  tenantId: string,
  rooftopId: string,
  partyId: string,
  interestKey: string,
): Promise<void> {
  await executor.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `crm-lead-interest:${tenantId}:${rooftopId}:${partyId}:${interestKey}`,
  ]);
}

/** The same derivation migration 063 generates, so the service can lock on it. */
function interestKeyOf(input: {
  interestStockItemId?: string | null | undefined;
  interestVehicleId?: string | null | undefined;
}): string {
  return input.interestStockItemId ?? input.interestVehicleId ?? 'general';
}

export interface LeadCaptureInput {
  actingUserLinkId: string;
  tenantId: string;
  rooftopId: string;
  /** The caller's own handle for this capture. A repeat converges on it. */
  intakeKey: string;
  channel: IntakeChannel;
  sourceCode: string;
  /** An existing customer, when the caller already knows which one. */
  partyId?: string | null | undefined;
  /** Otherwise, the contact details to resolve or create one from. */
  party?: PartyDetails | undefined;
  interestStockItemId?: string | null | undefined;
  interestVehicleId?: string | null | undefined;
  campaignVersionId?: string | null | undefined;
  payload?: ProviderLeadPayload | undefined;
}

export type LeadCaptureOutcome =
  | { outcome: 'created'; lead: LeadView; partyId: string; mutation: MutationResult }
  | { outcome: 'merged_into_existing'; lead: LeadView; partyId: string; replayed: boolean }
  | { outcome: 'invalid'; error: string };

/**
 * CAPTURE, inside the caller's transaction.
 *
 * The order of operations is the whole design:
 *
 *   1. the intake key is claimed first, so a redelivery short-circuits before
 *      it can do anything else;
 *   2. the party is resolved — found if the contact details match a live
 *      customer, created if they match nobody;
 *   3. the interest is LOCKED, and only then is the open-lead question asked;
 *   4. the lead is created or joined, and either way a source touch is
 *      appended, because a second enquiry from the same person about the same
 *      car is a real touch even when it is not a new lead.
 */
export async function captureLeadWithin(
  executor: Executor,
  input: LeadCaptureInput,
): Promise<LeadCaptureOutcome> {
  const intakeKey = (input.intakeKey ?? '').trim();
  if (intakeKey.length === 0 || intakeKey.length > 200) {
    return { outcome: 'invalid', error: 'an intake needs a key' };
  }
  if (input.interestStockItemId != null && input.interestVehicleId != null) {
    return { outcome: 'invalid', error: 'a lead is about one car or one model, not both' };
  }
  const actor = await requireActor(executor, input.actingUserLinkId);

  // 1. A REPEAT OF THE SAME CAPTURE RETURNS THE SAME ANSWER.
  const replay = await executor.query(
    `SELECT i.lead_id, i.outcome, i.reason
       FROM lead_intakes i
      WHERE i.tenant_id = $1 AND i.intake_key = $2`,
    [input.tenantId, intakeKey],
  );
  if (replay.rows.length > 0) {
    const prior = replay.rows[0] as Row;
    if (prior.lead_id === null) {
      return { outcome: 'invalid', error: String(prior.reason ?? 'the intake was refused') };
    }
    const lead = await readLead(executor, input.tenantId, String(prior.lead_id));
    if (lead === null) return { outcome: 'invalid', error: 'the recorded lead no longer exists' };
    return { outcome: 'merged_into_existing', lead, partyId: lead.partyId, replayed: true };
  }

  const source = await executor.query(
    `SELECT lead_source_id FROM lead_sources
      WHERE tenant_id = $1 AND source_code = $2 AND status = 'active'`,
    [input.tenantId, input.sourceCode],
  );
  if (source.rows.length === 0) {
    return { outcome: 'invalid', error: `no active lead source named ${input.sourceCode}` };
  }
  const sourceId = String((source.rows[0] as Row).lead_source_id);

  // 2. THE CUSTOMER. Borrowed from Release Train 2, never invented here.
  const resolved = await resolveParty(executor, input, actor);
  if (resolved.kind === 'invalid') {
    await recordIntake(executor, {
      tenantId: input.tenantId,
      intakeKey,
      channel: input.channel,
      leadId: null,
      outcome: 'rejected',
      reason: resolved.error,
      fingerprint: fingerprintOf(input),
      actor,
    });
    return { outcome: 'invalid', error: resolved.error };
  }
  const partyId = resolved.partyId;

  // 3. THE INTEREST, LOCKED before it is asked about.
  const interestKey = interestKeyOf(input);
  await lockIntakeDecision(executor, input.tenantId, input.rooftopId, partyId, interestKey);

  const open = await executor.query(
    `SELECT ${LEAD_COLUMNS} FROM leads
      WHERE tenant_id = $1 AND rooftop_id = $2 AND party_id = $3 AND interest_key = $4
        AND lifecycle_state NOT IN ('handed_off', 'closed')`,
    [input.tenantId, input.rooftopId, partyId, interestKey],
  );

  if (open.rows.length > 0) {
    const lead = mapLead(open.rows[0] as Row);
    await recordSourceTouchWithin(executor, {
      tenantId: input.tenantId,
      leadId: lead.leadId,
      leadSourceId: sourceId,
      campaignVersionId: input.campaignVersionId ?? null,
      detail: { channel: input.channel },
    });
    await recordIntake(executor, {
      tenantId: input.tenantId,
      intakeKey,
      channel: input.channel,
      leadId: lead.leadId,
      outcome: 'merged_into_existing',
      reason: null,
      fingerprint: fingerprintOf(input),
      actor,
    });
    return { outcome: 'merged_into_existing', lead, partyId, replayed: false };
  }

  // 4. A NEW LEAD, with its clock set from the rooftop's own policy.
  // BOTH deadlines come off the rooftop's own policy, and they are different
  // deadlines: the response target is the promise to the customer, the
  // escalation threshold is when a manager is told the promise was missed.
  const sla = await executor.query(
    `SELECT first_response_minutes, escalate_after_minutes FROM lead_sla_policies
      WHERE tenant_id = $1 AND rooftop_id = $2 AND status = 'active'`,
    [input.tenantId, input.rooftopId],
  );
  const dueMinutes =
    sla.rows.length === 0 ? null : Number((sla.rows[0] as Row).first_response_minutes);
  const escalateMinutes =
    sla.rows.length === 0 ? null : Number((sla.rows[0] as Row).escalate_after_minutes);

  const written = await executor.query(
    `INSERT INTO leads
       (tenant_id, rooftop_id, party_id, interest_stock_item_id, interest_vehicle_id,
        primary_source_id, first_response_due_at, escalate_at,
        created_by_user_link_id, updated_by_user_link_id)
     VALUES ($1, $2, $3, $4, $5, $6,
             CASE WHEN $7::int IS NULL THEN NULL ELSE NOW() + ($7::int * INTERVAL '1 minute') END,
             CASE WHEN $8::int IS NULL THEN NULL ELSE NOW() + ($8::int * INTERVAL '1 minute') END,
             $9, $9)
     RETURNING ${LEAD_COLUMNS}`,
    [
      input.tenantId,
      input.rooftopId,
      partyId,
      input.interestStockItemId ?? null,
      input.interestVehicleId ?? null,
      sourceId,
      dueMinutes,
      escalateMinutes,
      actor,
    ],
  );
  const lead = mapLead(written.rows[0] as Row);

  await recordSourceTouchWithin(executor, {
    tenantId: input.tenantId,
    leadId: lead.leadId,
    leadSourceId: sourceId,
    campaignVersionId: input.campaignVersionId ?? null,
    detail: { channel: input.channel, first: true },
  });
  await recordIntake(executor, {
    tenantId: input.tenantId,
    intakeKey,
    channel: input.channel,
    leadId: lead.leadId,
    outcome: 'created',
    reason: null,
    fingerprint: fingerprintOf(input),
    actor,
  });

  const mutation = await recordMutation(executor, {
    tenantId: input.tenantId,
    entityType: 'lead',
    entityId: lead.leadId,
    eventType: 'crm.lead.captured',
    actingUserLinkId: actor,
    authorizationVersion: lead.authorizationVersion,
    // The channel and the source, never the customer's contact details or what
    // they wrote in the comment box.
    details: { channel: input.channel, source_code: input.sourceCode },
  });
  return { outcome: 'created', lead, partyId, mutation };
}

export async function captureLead(input: LeadCaptureInput): Promise<LeadCaptureOutcome> {
  return withTenantTransaction(input.tenantId, (tx) => captureLeadWithin(tx, input));
}

function fingerprintOf(input: LeadCaptureInput): string {
  return payloadFingerprint(
    input.payload ?? {
      externalId: input.intakeKey,
      givenName: input.party?.givenName ?? undefined,
      familyName: input.party?.familyName ?? undefined,
      email: input.party?.email ?? undefined,
      phone: input.party?.phone ?? undefined,
    },
  );
}

async function recordIntake(
  executor: Executor,
  input: {
    tenantId: string;
    intakeKey: string;
    channel: IntakeChannel;
    leadId: string | null;
    outcome: 'created' | 'merged_into_existing' | 'rejected';
    reason: string | null;
    fingerprint: string;
    actor: string;
  },
): Promise<void> {
  await executor.query(
    `INSERT INTO lead_intakes
       (tenant_id, intake_key, channel, lead_id, outcome, reason, payload_fingerprint,
        received_by_user_link_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      input.tenantId,
      input.intakeKey,
      input.channel,
      input.leadId,
      input.outcome,
      input.reason === null ? null : input.reason.slice(0, 200),
      input.fingerprint,
      input.actor,
    ],
  );
}

type ResolvedParty = { kind: 'party'; partyId: string } | { kind: 'invalid'; error: string };

/**
 * THE CUSTOMER THIS LEAD IS ABOUT.
 *
 * A named party is used as given. Otherwise Release Train 2's create is asked,
 * and its `duplicate` answer is treated as SUCCESS rather than as a refusal —
 * which is the difference between lead intake and a staff member typing a new
 * customer. When a form arrives from someone the dealership already knows, the
 * right answer is "that is them", not "please decide". That decision is the one
 * thing standing between an inbound form and a split customer record.
 */
async function resolveParty(
  executor: Executor,
  input: LeadCaptureInput,
  actor: string,
): Promise<ResolvedParty> {
  if (input.partyId != null) {
    const known = await executor.query(
      `SELECT party_id FROM parties
        WHERE tenant_id = $1 AND party_id = $2 AND status = 'active'`,
      [input.tenantId, input.partyId],
    );
    if (known.rows.length === 0) return { kind: 'invalid', error: 'that customer does not exist' };
    return { kind: 'party', partyId: String((known.rows[0] as Row).party_id) };
  }
  const details = input.party;
  if (details === undefined) {
    return { kind: 'invalid', error: 'a lead needs a customer or the details to identify one' };
  }
  if (normalizeEmail(details.email) === null && normalizePhone(details.phone) === null) {
    return { kind: 'invalid', error: 'a lead needs an email address or a phone number' };
  }
  const created = await createPartyWithin(executor, {
    actingUserLinkId: actor,
    tenantId: input.tenantId,
    partyType: 'person',
    details,
  });
  if (created.outcome === 'created') return { kind: 'party', partyId: created.party.partyId };
  if (created.outcome === 'duplicate') {
    const match = created.candidates[0];
    if (match === undefined)
      return { kind: 'invalid', error: 'the customer could not be resolved' };
    return { kind: 'party', partyId: match.party.partyId };
  }
  return { kind: 'invalid', error: created.error };
}

// ── source touches ──────────────────────────────────────────────────────────

/**
 * Appends a touch. `touch_seq` is assigned by migration 063's trigger, never
 * here, so nothing in the application can choose its place in a history that
 * attribution orders by.
 *
 * Two touches for one lead written concurrently collide on
 * `uq_lead_source_touches_lead_seq` and one is refused; that is the correct
 * outcome and it is why the caller holds the interest lock. A history is a
 * sequence, and a sequence cannot be written twice at the same position.
 */
export async function recordSourceTouchWithin(
  executor: Executor,
  input: {
    tenantId: string;
    leadId: string;
    leadSourceId: string;
    campaignVersionId?: string | null | undefined;
    detail?: Record<string, unknown> | undefined;
  },
): Promise<string> {
  // SERIALIZE THE SEQUENCE (RT3-C1 §3). Migration 063's trigger assigns
  // `touch_seq` as MAX + 1, which two concurrent writers both compute as the
  // same number — one wins, the other dies on the unique index. That refusal is
  // correct but it is not acceptable: a campaign reply and a website form
  // arriving together for one lead are both real touches, and losing one loses
  // an attribution input for ever. Locking the LEAD makes the two queue, so
  // both are recorded, in the order they arrived.
  await executor.query(`SELECT 1 FROM leads WHERE tenant_id = $1 AND lead_id = $2 FOR UPDATE`, [
    input.tenantId,
    input.leadId,
  ]);
  const written = await executor.query(
    `INSERT INTO lead_source_touches
       (tenant_id, lead_id, lead_source_id, campaign_version_id, touch_seq, detail)
     VALUES ($1, $2, $3, $4, 0, $5)
     RETURNING touch_id`,
    [
      input.tenantId,
      input.leadId,
      input.leadSourceId,
      input.campaignVersionId ?? null,
      JSON.stringify(input.detail ?? {}),
    ],
  );
  return String((written.rows[0] as Row).touch_id);
}

// ── reads ───────────────────────────────────────────────────────────────────

async function readLead(
  executor: Executor,
  tenantId: string,
  leadId: string,
): Promise<LeadView | null> {
  const found = await executor.query(
    `SELECT ${LEAD_COLUMNS} FROM leads WHERE tenant_id = $1 AND lead_id = $2`,
    [tenantId, leadId],
  );
  return found.rows.length === 0 ? null : mapLead(found.rows[0] as Row);
}

export async function getLead(tenantId: string, leadId: string): Promise<LeadView | null> {
  return withTenantTransaction(tenantId, (tx) => readLead(tx, tenantId, leadId));
}

// ── lifecycle ───────────────────────────────────────────────────────────────

export type LeadTransitionOutcome =
  | { outcome: 'moved'; lead: LeadView; mutation: MutationResult }
  | { outcome: 'version_conflict'; currentVersion: number }
  | { outcome: 'not_found' }
  | { outcome: 'invalid'; error: string };

/**
 * Moves a lead along the machine under optimistic concurrency. A move that the
 * machine does not allow is refused BY NAME — "a handed-off lead is finished"
 * rather than a silent no-op — because a CRM that quietly ignores a transition
 * teaches its users that the button is broken.
 */
export async function transitionLead(input: {
  actingUserLinkId: string;
  tenantId: string;
  leadId: string;
  toState: LeadState;
  expectedVersion: number;
  disposition?: LeadDisposition | null | undefined;
  note?: string | null | undefined;
}): Promise<LeadTransitionOutcome> {
  if (!LEAD_STATES.includes(input.toState)) {
    return { outcome: 'invalid', error: `unknown lead state ${input.toState}` };
  }
  return withTenantTransaction(input.tenantId, async (tx) => {
    const actor = await requireActor(tx, input.actingUserLinkId);
    const existing = await tx.query(
      `SELECT ${LEAD_COLUMNS} FROM leads
        WHERE tenant_id = $1 AND lead_id = $2 FOR UPDATE`,
      [input.tenantId, input.leadId],
    );
    if (existing.rows.length === 0) return { outcome: 'not_found' as const };
    const current = mapLead(existing.rows[0] as Row);
    if (current.authorizationVersion !== input.expectedVersion) {
      return { outcome: 'version_conflict' as const, currentVersion: current.authorizationVersion };
    }
    const allowed = LEGAL_TRANSITIONS[current.lifecycleState];
    if (!allowed.includes(input.toState)) {
      return {
        outcome: 'invalid' as const,
        error:
          allowed.length === 0
            ? `a ${current.lifecycleState} lead is finished and cannot move`
            : `a ${current.lifecycleState} lead may move to ${allowed.join(' or ')}, not ${input.toState}`,
      };
    }
    const terminal = input.toState === 'closed';
    if (terminal && (input.disposition ?? null) === null) {
      return { outcome: 'invalid' as const, error: 'closing a lead states why' };
    }
    if (input.toState === 'handed_off') {
      return {
        outcome: 'invalid' as const,
        error: 'a handoff is recorded by handing the lead over, not by setting its state',
      };
    }

    const written = await tx.query(
      `UPDATE leads
          SET lifecycle_state = $3,
              disposition = $4,
              closed_at = CASE WHEN $3 = 'closed' THEN NOW() ELSE closed_at END,
              updated_by_user_link_id = $5, updated_at = NOW(),
              authorization_version = authorization_version + 1
        WHERE tenant_id = $1 AND lead_id = $2 AND authorization_version = $6
        RETURNING ${LEAD_COLUMNS}`,
      [
        input.tenantId,
        input.leadId,
        input.toState,
        terminal ? (input.disposition ?? null) : null,
        actor,
        input.expectedVersion,
      ],
    );
    if (written.rows.length === 0) {
      return { outcome: 'version_conflict' as const, currentVersion: current.authorizationVersion };
    }
    const lead = mapLead(written.rows[0] as Row);
    await tx.query(
      `INSERT INTO lead_status_events
         (tenant_id, lead_id, from_state, to_state, disposition, note, changed_by_user_link_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        input.tenantId,
        input.leadId,
        current.lifecycleState,
        input.toState,
        terminal ? (input.disposition ?? null) : null,
        input.note ?? null,
        actor,
      ],
    );
    const mutation = await recordMutation(tx, {
      tenantId: input.tenantId,
      entityType: 'lead',
      entityId: lead.leadId,
      eventType: 'crm.lead.transitioned',
      actingUserLinkId: actor,
      authorizationVersion: lead.authorizationVersion,
      details: {
        from_state: current.lifecycleState,
        to_state: input.toState,
        ...(terminal ? { disposition: input.disposition } : {}),
      },
    });
    return { outcome: 'moved' as const, lead, mutation };
  });
}

/**
 * Stamps the first response, ONCE. Called by the activity service when an
 * outbound communication is logged. It is deliberately not idempotent-by-reset:
 * a lead answered late is not repaired by answering it again, so the first
 * stamp is the only one, and the SLA report reads the truth.
 */
export async function stampFirstResponseWithin(
  executor: Executor,
  tenantId: string,
  leadId: string,
): Promise<void> {
  await executor.query(
    `UPDATE leads SET first_response_at = NOW(), updated_at = NOW()
      WHERE tenant_id = $1 AND lead_id = $2 AND first_response_at IS NULL`,
    [tenantId, leadId],
  );
}

// ── the sales handoff ───────────────────────────────────────────────────────

export type HandoffOutcome =
  | { outcome: 'handed_off'; lead: LeadView; handoffId: string; mutation: MutationResult }
  | { outcome: 'already_handed_off'; handoffId: string }
  | { outcome: 'version_conflict'; currentVersion: number }
  | { outcome: 'not_found' }
  | { outcome: 'invalid'; error: string };

/**
 * THE SEAM. Release Train 3's authority ends here.
 *
 * The handoff FREEZES A SNAPSHOT of what sales is being given, rather than
 * pointing at the live lead, because the two are different claims: "what the
 * BDC handed over" must not change when someone later edits a note. Sales does
 * not exist yet; when it does, it reads this row.
 *
 * One handoff per lead is a database constraint, so "handed off twice" is not
 * representable and a retried request converges on the first.
 */
export async function handOffLead(input: {
  actingUserLinkId: string;
  tenantId: string;
  leadId: string;
  expectedVersion: number;
  handedToUserLinkId: string;
}): Promise<HandoffOutcome> {
  return withTenantTransaction(input.tenantId, async (tx) => {
    const actor = await requireActor(tx, input.actingUserLinkId);
    const existing = await tx.query(
      `SELECT ${LEAD_COLUMNS} FROM leads WHERE tenant_id = $1 AND lead_id = $2 FOR UPDATE`,
      [input.tenantId, input.leadId],
    );
    if (existing.rows.length === 0) return { outcome: 'not_found' as const };
    const current = mapLead(existing.rows[0] as Row);

    const prior = await tx.query(
      `SELECT handoff_id FROM lead_handoffs WHERE tenant_id = $1 AND lead_id = $2`,
      [input.tenantId, input.leadId],
    );
    if (prior.rows.length > 0) {
      return {
        outcome: 'already_handed_off' as const,
        handoffId: String((prior.rows[0] as Row).handoff_id),
      };
    }
    if (current.authorizationVersion !== input.expectedVersion) {
      return { outcome: 'version_conflict' as const, currentVersion: current.authorizationVersion };
    }
    if (!LEGAL_TRANSITIONS[current.lifecycleState].includes('handed_off')) {
      return {
        outcome: 'invalid' as const,
        error: `a ${current.lifecycleState} lead is not ready to hand to sales`,
      };
    }

    const written = await tx.query(
      `UPDATE leads
          SET lifecycle_state = 'handed_off', disposition = 'handed_to_sales',
              handed_off_at = NOW(), updated_by_user_link_id = $3, updated_at = NOW(),
              authorization_version = authorization_version + 1
        WHERE tenant_id = $1 AND lead_id = $2 AND authorization_version = $4
        RETURNING ${LEAD_COLUMNS}`,
      [input.tenantId, input.leadId, actor, input.expectedVersion],
    );
    if (written.rows.length === 0) {
      return { outcome: 'version_conflict' as const, currentVersion: current.authorizationVersion };
    }
    const lead = mapLead(written.rows[0] as Row);

    const snapshot = {
      lead_id: lead.leadId,
      rooftop_id: lead.rooftopId,
      party_id: lead.partyId,
      interest_stock_item_id: lead.interestStockItemId,
      interest_vehicle_id: lead.interestVehicleId,
      primary_source_id: lead.primarySourceId,
      owner_user_link_id: lead.ownerUserLinkId,
      first_response_at: lead.firstResponseAt,
      handed_off_at: lead.handedOffAt,
    };
    const handoff = await tx.query(
      `INSERT INTO lead_handoffs
         (tenant_id, lead_id, handed_snapshot, handed_to_user_link_id, handed_by_user_link_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING handoff_id`,
      [input.tenantId, input.leadId, JSON.stringify(snapshot), input.handedToUserLinkId, actor],
    );
    await tx.query(
      `INSERT INTO lead_status_events
         (tenant_id, lead_id, from_state, to_state, disposition, changed_by_user_link_id)
       VALUES ($1, $2, $3, 'handed_off', 'handed_to_sales', $4)`,
      [input.tenantId, input.leadId, current.lifecycleState, actor],
    );
    const mutation = await recordMutation(tx, {
      tenantId: input.tenantId,
      entityType: 'lead',
      entityId: lead.leadId,
      eventType: 'crm.lead.handed_off',
      actingUserLinkId: actor,
      authorizationVersion: lead.authorizationVersion,
      details: { from_state: current.lifecycleState, handed_to: input.handedToUserLinkId },
    });
    return {
      outcome: 'handed_off' as const,
      lead,
      handoffId: String((handoff.rows[0] as Row).handoff_id),
      mutation,
    };
  });
}
