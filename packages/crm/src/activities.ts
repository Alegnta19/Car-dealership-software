/**
 * RELEASE TRAIN 3, ROW 3 — THE SHARED TIMELINE, AND THE APPOINTMENT.
 *
 * ONE TIMELINE, NOT FIVE. A task, a note, a call, an email and a reminder are
 * the same kind of thing to the person reading a lead's history — something
 * that happened, or is due to — so they are one table. Five tables merged in
 * the query would eventually disagree about ordering, and the first time
 * somebody asks "what did we actually do about this customer" is the worst
 * moment to find that out.
 *
 * THE FIRST OUTBOUND COMMUNICATION STOPS THE CLOCK. Logging a call, an email or
 * an SMS in the outbound direction stamps `leads.first_response_at`, once and
 * never again. A note does not, and neither does an inbound call: the customer
 * ringing back is not the dealership responding.
 *
 * A RESCHEDULE KEEPS BOTH TIMES. `appointment_events` records the move with the
 * old start and the new one, so "you changed my appointment twice" is
 * answerable a month later rather than being a claim about a column that only
 * ever holds the latest value.
 */
import { withTenantTransaction, type Executor } from '@dealer/database';
import { recordMutation, requireActor, type MutationResult } from '@dealer/identity-access';
import { mapLead, stampFirstResponseWithin, type LeadView } from './leads';

interface Row {
  [key: string]: unknown;
}

export type ActivityKind = 'task' | 'note' | 'call' | 'email' | 'sms' | 'reminder';
export type ActivityDirection = 'inbound' | 'outbound';
export type ActivityState = 'open' | 'completed' | 'cancelled';

const COMMUNICATIONS: readonly ActivityKind[] = ['call', 'email', 'sms'];
const SCHEDULABLE: readonly ActivityKind[] = ['task', 'reminder'];

export interface ActivityView {
  readonly activityId: string;
  readonly leadId: string;
  readonly kind: ActivityKind;
  readonly direction: ActivityDirection | null;
  readonly subject: string;
  readonly body: string | null;
  readonly state: ActivityState;
  readonly dueAt: string | null;
  readonly completedAt: string | null;
  readonly assignedToUserLinkId: string | null;
  readonly createdAt: string;
  readonly authorizationVersion: number;
}

const ACTIVITY_COLUMNS = `activity_id, lead_id, kind, direction, subject, body, state, due_at,
       completed_at, assigned_to_user_link_id, created_at, authorization_version`;

function mapActivity(row: Row): ActivityView {
  const iso = (v: unknown): string | null =>
    v === null ? null : new Date(v as string).toISOString();
  return {
    activityId: String(row.activity_id),
    leadId: String(row.lead_id),
    kind: String(row.kind) as ActivityKind,
    direction: row.direction === null ? null : (String(row.direction) as ActivityDirection),
    subject: String(row.subject),
    body: row.body === null ? null : String(row.body),
    state: String(row.state) as ActivityState,
    dueAt: iso(row.due_at),
    completedAt: iso(row.completed_at),
    assignedToUserLinkId:
      row.assigned_to_user_link_id === null ? null : String(row.assigned_to_user_link_id),
    createdAt: new Date(row.created_at as string).toISOString(),
    authorizationVersion: Number(row.authorization_version),
  };
}

export type ActivityOutcome =
  | { outcome: 'logged'; activity: ActivityView; lead: LeadView; mutation: MutationResult }
  | { outcome: 'not_found' }
  | { outcome: 'invalid'; error: string };

export async function logActivityWithin(
  executor: Executor,
  input: {
    actingUserLinkId: string;
    tenantId: string;
    leadId: string;
    kind: ActivityKind;
    direction?: ActivityDirection | null | undefined;
    subject: string;
    body?: string | null | undefined;
    dueAt?: string | null | undefined;
    assignedToUserLinkId?: string | null | undefined;
  },
): Promise<ActivityOutcome> {
  const subject = (input.subject ?? '').trim();
  if (subject.length === 0 || subject.length > 200) {
    return { outcome: 'invalid', error: 'an activity needs a subject' };
  }
  const isCommunication = COMMUNICATIONS.includes(input.kind);
  const direction = input.direction ?? null;
  if (isCommunication && direction === null) {
    return { outcome: 'invalid', error: 'a communication is inbound or outbound' };
  }
  if (!isCommunication && direction !== null) {
    return { outcome: 'invalid', error: `a ${input.kind} has no direction` };
  }
  const dueAt = input.dueAt ?? null;
  if (dueAt !== null && !SCHEDULABLE.includes(input.kind)) {
    return { outcome: 'invalid', error: `a ${input.kind} cannot be due` };
  }

  const actor = await requireActor(executor, input.actingUserLinkId);
  const lead = await executor.query(
    `SELECT lifecycle_state FROM leads WHERE tenant_id = $1 AND lead_id = $2`,
    [input.tenantId, input.leadId],
  );
  if (lead.rows.length === 0) return { outcome: 'not_found' };
  // TERMINAL STATES ABSORB (RT3-C1 §2). A closed lead is finished, and a
  // handed-off lead is SALES' lead — letting the BDC keep logging against it
  // would make the frozen handoff snapshot a partial account of a record that
  // is still moving, which is the one thing the snapshot exists to prevent.
  const state = String((lead.rows[0] as Row).lifecycle_state);
  if (state === 'closed' || state === 'handed_off') {
    return { outcome: 'invalid', error: `a ${state} lead takes no further activity` };
  }

  const written = await executor.query(
    `INSERT INTO lead_activities
       (tenant_id, lead_id, kind, direction, subject, body, due_at,
        assigned_to_user_link_id, created_by_user_link_id, updated_by_user_link_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
     RETURNING ${ACTIVITY_COLUMNS}`,
    [
      input.tenantId,
      input.leadId,
      input.kind,
      direction,
      subject,
      input.body ?? null,
      dueAt,
      input.assignedToUserLinkId ?? null,
      actor,
    ],
  );
  const activity = mapActivity(written.rows[0] as Row);

  // THE CLOCK STOPS ON THE FIRST OUTBOUND CONTACT, and on nothing else.
  if (isCommunication && direction === 'outbound') {
    await stampFirstResponseWithin(executor, input.tenantId, input.leadId);
  }
  const after = await executor.query(
    `SELECT lead_id, rooftop_id, party_id, interest_stock_item_id, interest_vehicle_id,
            lifecycle_state, disposition, owner_user_link_id, queue_id, primary_source_id,
            first_response_due_at, escalate_at, first_response_at, escalated_at, handed_off_at, closed_at,
            authorization_version, created_at, updated_at
       FROM leads WHERE tenant_id = $1 AND lead_id = $2`,
    [input.tenantId, input.leadId],
  );

  const mutation = await recordMutation(executor, {
    tenantId: input.tenantId,
    entityType: 'lead_activity',
    entityId: activity.activityId,
    eventType: 'crm.activity.logged',
    actingUserLinkId: actor,
    authorizationVersion: activity.authorizationVersion,
    // The KIND and the DIRECTION. What was said to the customer is in the row,
    // and an audit detail is not the place to copy it.
    details: { lead_id: input.leadId, kind: input.kind, direction },
  });
  return {
    outcome: 'logged',
    activity,
    lead: mapLead(after.rows[0] as Row),
    mutation,
  };
}

export async function logActivity(input: {
  actingUserLinkId: string;
  tenantId: string;
  leadId: string;
  kind: ActivityKind;
  direction?: ActivityDirection | null | undefined;
  subject: string;
  body?: string | null | undefined;
  dueAt?: string | null | undefined;
  assignedToUserLinkId?: string | null | undefined;
}): Promise<ActivityOutcome> {
  return withTenantTransaction(input.tenantId, (tx) => logActivityWithin(tx, input));
}

export type ActivityCloseOutcome =
  | { outcome: 'closed'; activity: ActivityView; mutation: MutationResult }
  | { outcome: 'version_conflict'; currentVersion: number }
  | { outcome: 'not_found' }
  | { outcome: 'invalid'; error: string };

/** Completes or cancels an open item. A finished item does not reopen. */
export async function closeActivity(input: {
  actingUserLinkId: string;
  tenantId: string;
  /** The lead the CALLER was authorized against; the activity must be its own. */
  leadId: string;
  activityId: string;
  expectedVersion: number;
  state: 'completed' | 'cancelled';
}): Promise<ActivityCloseOutcome> {
  if (input.state !== 'completed' && input.state !== 'cancelled') {
    return { outcome: 'invalid', error: 'an activity is completed or cancelled' };
  }
  return withTenantTransaction(input.tenantId, async (tx) => {
    const actor = await requireActor(tx, input.actingUserLinkId);
    const existing = await tx.query(
      `SELECT ${ACTIVITY_COLUMNS} FROM lead_activities
        WHERE tenant_id = $1 AND activity_id = $2 FOR UPDATE`,
      [input.tenantId, input.activityId],
    );
    if (existing.rows.length === 0) return { outcome: 'not_found' as const };
    const current = mapActivity(existing.rows[0] as Row);
    // EXACT PARENT. The engine authorized a LEAD; this activity must be that
    // lead's, or the caller is reaching past the resource they were granted.
    // Not-found rather than forbidden, so nothing is learned about an activity
    // the caller was never entitled to name.
    if (current.leadId !== input.leadId) return { outcome: 'not_found' as const };
    // THE PARENT DECIDES. An activity belongs to a lead, and a lead that has
    // been handed to sales or closed is not the CRM's to work — including
    // through one of its children.
    const parent = await tx.query(
      `SELECT lifecycle_state FROM leads WHERE tenant_id = $1 AND lead_id = $2`,
      [input.tenantId, current.leadId],
    );
    const parentState = String((parent.rows[0] as Row).lifecycle_state);
    if (parentState === 'closed' || parentState === 'handed_off') {
      return { outcome: 'invalid' as const, error: `a ${parentState} lead takes no further work` };
    }
    if (current.state !== 'open') {
      return { outcome: 'invalid' as const, error: `that activity is already ${current.state}` };
    }
    if (current.authorizationVersion !== input.expectedVersion) {
      return { outcome: 'version_conflict' as const, currentVersion: current.authorizationVersion };
    }
    const written = await tx.query(
      `UPDATE lead_activities
          SET state = $3,
              completed_at = CASE WHEN $3 = 'completed' THEN NOW() ELSE NULL END,
              updated_by_user_link_id = $4, updated_at = NOW(),
              authorization_version = authorization_version + 1
        WHERE tenant_id = $1 AND activity_id = $2 AND authorization_version = $5
        RETURNING ${ACTIVITY_COLUMNS}`,
      [input.tenantId, input.activityId, input.state, actor, input.expectedVersion],
    );
    if (written.rows.length === 0) {
      return { outcome: 'version_conflict' as const, currentVersion: current.authorizationVersion };
    }
    const activity = mapActivity(written.rows[0] as Row);
    const mutation = await recordMutation(tx, {
      tenantId: input.tenantId,
      entityType: 'lead_activity',
      entityId: activity.activityId,
      eventType: 'crm.activity.closed',
      actingUserLinkId: actor,
      authorizationVersion: activity.authorizationVersion,
      details: { lead_id: activity.leadId, state: input.state },
    });
    return { outcome: 'closed' as const, activity, mutation };
  });
}

// ── appointments ────────────────────────────────────────────────────────────

export type AppointmentPurpose =
  'test_drive' | 'showroom_visit' | 'consultation' | 'delivery_preview' | 'callback';
export type AppointmentState = 'scheduled' | 'confirmed' | 'completed' | 'cancelled' | 'no_show';

export interface AppointmentView {
  readonly appointmentId: string;
  readonly rooftopId: string;
  readonly leadId: string;
  readonly partyId: string;
  readonly stockItemId: string | null;
  readonly purpose: AppointmentPurpose;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly state: AppointmentState;
  readonly rescheduleCount: number;
  readonly assignedToUserLinkId: string | null;
  readonly authorizationVersion: number;
}

const APPOINTMENT_COLUMNS = `appointment_id, rooftop_id, lead_id, party_id, stock_item_id, purpose,
       starts_at, ends_at, state, reschedule_count, assigned_to_user_link_id,
       authorization_version`;

function mapAppointment(row: Row): AppointmentView {
  return {
    appointmentId: String(row.appointment_id),
    rooftopId: String(row.rooftop_id),
    leadId: String(row.lead_id),
    partyId: String(row.party_id),
    stockItemId: row.stock_item_id === null ? null : String(row.stock_item_id),
    purpose: String(row.purpose) as AppointmentPurpose,
    startsAt: new Date(row.starts_at as string).toISOString(),
    endsAt: new Date(row.ends_at as string).toISOString(),
    state: String(row.state) as AppointmentState,
    rescheduleCount: Number(row.reschedule_count),
    assignedToUserLinkId:
      row.assigned_to_user_link_id === null ? null : String(row.assigned_to_user_link_id),
    authorizationVersion: Number(row.authorization_version),
  };
}

export type AppointmentOutcome =
  | { outcome: 'scheduled'; appointment: AppointmentView; lead: LeadView; mutation: MutationResult }
  | { outcome: 'not_found' }
  | { outcome: 'invalid'; error: string };

/**
 * Books an appointment and advances the lead to `appointment_set` in the SAME
 * transaction. The two facts are one fact — a booked appointment IS what that
 * lifecycle state means — and letting them commit separately would produce
 * leads that are booked but not marked, which is exactly the state a BDC
 * manager's morning report is supposed to be able to trust.
 *
 * A LEAD STILL MARKED `new` ADVANCES TOO (RT3-C1 §1). It used to advance only
 * from `working` or `qualified`, so a walk-in call answered and booked in one
 * go stayed in the pipeline as "New" with an appointment already in the diary —
 * the screen said one thing and the calendar another. Booking IS working the
 * lead, and the status event records the state it actually came from rather
 * than inventing an intermediate move nobody made.
 */
export async function scheduleAppointmentWithin(
  executor: Executor,
  input: {
    actingUserLinkId: string;
    tenantId: string;
    leadId: string;
    purpose: AppointmentPurpose;
    startsAt: string;
    endsAt: string;
    stockItemId?: string | null | undefined;
    assignedToUserLinkId?: string | null | undefined;
  },
): Promise<AppointmentOutcome> {
  const starts = new Date(input.startsAt);
  const ends = new Date(input.endsAt);
  if (Number.isNaN(starts.getTime()) || Number.isNaN(ends.getTime())) {
    return { outcome: 'invalid', error: 'an appointment needs a start and an end' };
  }
  if (ends <= starts) return { outcome: 'invalid', error: 'an appointment ends after it starts' };

  const actor = await requireActor(executor, input.actingUserLinkId);
  const lead = await executor.query(
    `SELECT lead_id, rooftop_id, party_id, interest_stock_item_id, interest_vehicle_id,
            lifecycle_state, disposition, owner_user_link_id, queue_id, primary_source_id,
            first_response_due_at, escalate_at, first_response_at, escalated_at, handed_off_at, closed_at,
            authorization_version, created_at, updated_at
       FROM leads WHERE tenant_id = $1 AND lead_id = $2 FOR UPDATE`,
    [input.tenantId, input.leadId],
  );
  if (lead.rows.length === 0) return { outcome: 'not_found' };
  const current = mapLead(lead.rows[0] as Row);
  if (current.lifecycleState === 'handed_off' || current.lifecycleState === 'closed') {
    return { outcome: 'invalid', error: `a ${current.lifecycleState} lead takes no appointments` };
  }

  const written = await executor.query(
    `INSERT INTO appointments
       (tenant_id, rooftop_id, lead_id, party_id, stock_item_id, purpose, starts_at, ends_at,
        assigned_to_user_link_id, created_by_user_link_id, updated_by_user_link_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
     RETURNING ${APPOINTMENT_COLUMNS}`,
    [
      input.tenantId,
      current.rooftopId,
      input.leadId,
      current.partyId,
      input.stockItemId ?? null,
      input.purpose,
      starts.toISOString(),
      ends.toISOString(),
      input.assignedToUserLinkId ?? null,
      actor,
    ],
  );
  const appointment = mapAppointment(written.rows[0] as Row);
  await executor.query(
    `INSERT INTO appointment_events
       (tenant_id, appointment_id, event_type, actor_user_link_id)
     VALUES ($1, $2, 'scheduled', $3)`,
    [input.tenantId, appointment.appointmentId, actor],
  );

  const advanced = await executor.query(
    `UPDATE leads
        SET lifecycle_state = 'appointment_set', updated_by_user_link_id = $3, updated_at = NOW(),
            authorization_version = authorization_version + 1
      WHERE tenant_id = $1 AND lead_id = $2
        AND lifecycle_state IN ('new', 'working', 'qualified')
      RETURNING lead_id, rooftop_id, party_id, interest_stock_item_id, interest_vehicle_id,
                lifecycle_state, disposition, owner_user_link_id, queue_id, primary_source_id,
                first_response_due_at, escalate_at, first_response_at, escalated_at, handed_off_at, closed_at,
                authorization_version, created_at, updated_at`,
    [input.tenantId, input.leadId, actor],
  );
  if (advanced.rows.length > 0) {
    await executor.query(
      `INSERT INTO lead_status_events
         (tenant_id, lead_id, from_state, to_state, changed_by_user_link_id)
       VALUES ($1, $2, $3, 'appointment_set', $4)`,
      [input.tenantId, input.leadId, current.lifecycleState, actor],
    );
  }

  const mutation = await recordMutation(executor, {
    tenantId: input.tenantId,
    entityType: 'appointment',
    entityId: appointment.appointmentId,
    eventType: 'crm.appointment.scheduled',
    actingUserLinkId: actor,
    authorizationVersion: appointment.authorizationVersion,
    details: { lead_id: input.leadId, purpose: input.purpose },
  });
  return {
    outcome: 'scheduled',
    appointment,
    lead: advanced.rows.length > 0 ? mapLead(advanced.rows[0] as Row) : current,
    mutation,
  };
}

export async function scheduleAppointment(input: {
  actingUserLinkId: string;
  tenantId: string;
  leadId: string;
  purpose: AppointmentPurpose;
  startsAt: string;
  endsAt: string;
  stockItemId?: string | null | undefined;
  assignedToUserLinkId?: string | null | undefined;
}): Promise<AppointmentOutcome> {
  return withTenantTransaction(input.tenantId, (tx) => scheduleAppointmentWithin(tx, input));
}

export type AppointmentMoveOutcome =
  | { outcome: 'moved'; appointment: AppointmentView; mutation: MutationResult }
  | { outcome: 'version_conflict'; currentVersion: number }
  | { outcome: 'not_found' }
  | { outcome: 'invalid'; error: string };

const APPOINTMENT_TRANSITIONS: Record<AppointmentState, readonly AppointmentState[]> = {
  scheduled: ['confirmed', 'completed', 'cancelled', 'no_show'],
  confirmed: ['completed', 'cancelled', 'no_show'],
  completed: [],
  cancelled: [],
  no_show: [],
};

/**
 * Moves an appointment in time. The old start and the new one are BOTH written
 * to the event ledger, and migration 063's trigger recomputes the reschedule
 * count from that ledger rather than incrementing a column — so the count
 * cannot drift from the history it is meant to summarize.
 */
export async function rescheduleAppointment(input: {
  actingUserLinkId: string;
  tenantId: string;
  appointmentId: string;
  expectedVersion: number;
  startsAt: string;
  endsAt: string;
  note?: string | null | undefined;
}): Promise<AppointmentMoveOutcome> {
  const starts = new Date(input.startsAt);
  const ends = new Date(input.endsAt);
  if (Number.isNaN(starts.getTime()) || Number.isNaN(ends.getTime()) || ends <= starts) {
    return { outcome: 'invalid', error: 'a reschedule needs a valid new time' };
  }
  return withTenantTransaction(input.tenantId, async (tx) => {
    const actor = await requireActor(tx, input.actingUserLinkId);
    const existing = await tx.query(
      `SELECT ${APPOINTMENT_COLUMNS} FROM appointments
        WHERE tenant_id = $1 AND appointment_id = $2 FOR UPDATE`,
      [input.tenantId, input.appointmentId],
    );
    if (existing.rows.length === 0) return { outcome: 'not_found' as const };
    const current = mapAppointment(existing.rows[0] as Row);
    if (APPOINTMENT_TRANSITIONS[current.state].length === 0) {
      return { outcome: 'invalid' as const, error: `a ${current.state} appointment cannot move` };
    }
    if (current.authorizationVersion !== input.expectedVersion) {
      return { outcome: 'version_conflict' as const, currentVersion: current.authorizationVersion };
    }
    const written = await tx.query(
      `UPDATE appointments
          SET starts_at = $3, ends_at = $4, updated_by_user_link_id = $5, updated_at = NOW(),
              authorization_version = authorization_version + 1
        WHERE tenant_id = $1 AND appointment_id = $2 AND authorization_version = $6
        RETURNING ${APPOINTMENT_COLUMNS}`,
      [
        input.tenantId,
        input.appointmentId,
        starts.toISOString(),
        ends.toISOString(),
        actor,
        input.expectedVersion,
      ],
    );
    if (written.rows.length === 0) {
      return { outcome: 'version_conflict' as const, currentVersion: current.authorizationVersion };
    }
    await tx.query(
      `INSERT INTO appointment_events
         (tenant_id, appointment_id, event_type, from_starts_at, to_starts_at, note,
          actor_user_link_id)
       VALUES ($1, $2, 'rescheduled', $3, $4, $5, $6)`,
      [
        input.tenantId,
        input.appointmentId,
        current.startsAt,
        starts.toISOString(),
        input.note ?? null,
        actor,
      ],
    );
    const refreshed = await tx.query(
      `SELECT ${APPOINTMENT_COLUMNS} FROM appointments
        WHERE tenant_id = $1 AND appointment_id = $2`,
      [input.tenantId, input.appointmentId],
    );
    const appointment = mapAppointment(refreshed.rows[0] as Row);
    const mutation = await recordMutation(tx, {
      tenantId: input.tenantId,
      entityType: 'appointment',
      entityId: appointment.appointmentId,
      eventType: 'crm.appointment.rescheduled',
      actingUserLinkId: actor,
      authorizationVersion: appointment.authorizationVersion,
      details: { lead_id: appointment.leadId, reschedule_count: appointment.rescheduleCount },
    });
    return { outcome: 'moved' as const, appointment, mutation };
  });
}

/** Confirms, completes, cancels or marks a no-show. Terminal states absorb. */
export async function setAppointmentState(input: {
  actingUserLinkId: string;
  tenantId: string;
  appointmentId: string;
  expectedVersion: number;
  state: AppointmentState;
  reason?: string | null | undefined;
}): Promise<AppointmentMoveOutcome> {
  return withTenantTransaction(input.tenantId, async (tx) => {
    const actor = await requireActor(tx, input.actingUserLinkId);
    const existing = await tx.query(
      `SELECT ${APPOINTMENT_COLUMNS} FROM appointments
        WHERE tenant_id = $1 AND appointment_id = $2 FOR UPDATE`,
      [input.tenantId, input.appointmentId],
    );
    if (existing.rows.length === 0) return { outcome: 'not_found' as const };
    const current = mapAppointment(existing.rows[0] as Row);
    const allowed = APPOINTMENT_TRANSITIONS[current.state];
    if (!allowed.includes(input.state)) {
      return {
        outcome: 'invalid' as const,
        error:
          allowed.length === 0
            ? `a ${current.state} appointment is finished`
            : `a ${current.state} appointment may become ${allowed.join(' or ')}`,
      };
    }
    if (input.state === 'cancelled' && (input.reason ?? '').trim().length === 0) {
      return { outcome: 'invalid' as const, error: 'a cancellation states why' };
    }
    if (current.authorizationVersion !== input.expectedVersion) {
      return { outcome: 'version_conflict' as const, currentVersion: current.authorizationVersion };
    }
    const written = await tx.query(
      `UPDATE appointments
          SET state = $3,
              cancelled_at = CASE WHEN $3 = 'cancelled' THEN NOW() ELSE cancelled_at END,
              cancelled_reason = CASE WHEN $3 = 'cancelled' THEN $4 ELSE cancelled_reason END,
              completed_at = CASE WHEN $3 = 'completed' THEN NOW() ELSE completed_at END,
              updated_by_user_link_id = $5, updated_at = NOW(),
              authorization_version = authorization_version + 1
        WHERE tenant_id = $1 AND appointment_id = $2 AND authorization_version = $6
        RETURNING ${APPOINTMENT_COLUMNS}`,
      [
        input.tenantId,
        input.appointmentId,
        input.state,
        input.reason ?? null,
        actor,
        input.expectedVersion,
      ],
    );
    if (written.rows.length === 0) {
      return { outcome: 'version_conflict' as const, currentVersion: current.authorizationVersion };
    }
    const appointment = mapAppointment(written.rows[0] as Row);
    await tx.query(
      `INSERT INTO appointment_events
         (tenant_id, appointment_id, event_type, note, actor_user_link_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [input.tenantId, input.appointmentId, input.state, input.reason ?? null, actor],
    );
    const mutation = await recordMutation(tx, {
      tenantId: input.tenantId,
      entityType: 'appointment',
      entityId: appointment.appointmentId,
      eventType: 'crm.appointment.state_changed',
      actingUserLinkId: actor,
      authorizationVersion: appointment.authorizationVersion,
      details: { lead_id: appointment.leadId, state: input.state },
    });
    return { outcome: 'moved' as const, appointment, mutation };
  });
}
