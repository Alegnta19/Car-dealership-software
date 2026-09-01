/**
 * RELEASE TRAIN 4 — THE SHOWROOM FLOOR, AND THE PEOPLE STANDING ON IT.
 *
 * ONE PERSON IS IN THE BUILDING OR THEY ARE NOT. A customer has at most one
 * active visit, and that is enforced in TWO places on purpose: the service says
 * it so the caller gets a sentence and a converged answer, and
 * `uq_showroom_visits_one_active` says it so a retry with a different request
 * key, a second till, a script or a future integration cannot get round it. Two
 * open visits is not a busy showroom — it is a board that double-counts a
 * customer, a wait timer measuring the wrong arrival, and two salespeople each
 * believing they have them.
 *
 * CHECK-IN CONVERGES RATHER THAN COLLIDES. Repeated check-ins and genuinely
 * concurrent ones — including ones carrying DIFFERENT request keys, which the
 * idempotency layer cannot merge because it has never seen them before — all
 * end on the same visit. The business key is the customer, not the request.
 *
 * AN APPOINTMENT IS VALIDATED AND MARKED KEPT ATOMICALLY. Release Train 3 owns
 * appointments, so the marking goes through RT3's own service inside THIS
 * transaction: a crash between "they arrived" and "the booking was kept" would
 * otherwise leave a customer in the building against an appointment that still
 * says scheduled, and the kept-appointment figures a dealership manages by
 * would quietly under-count.
 *
 * GREETING AND ACCEPTANCE ARE DIFFERENT ACTS. Greeting is the door, and the up
 * rotation decides who does it. Acceptance is a salesperson saying this one is
 * mine to work — which a manager greeting somebody they will not sell to does
 * not do, and which a salesperson may decline.
 */
import { withTenantTransaction, type Executor } from '@dealer/database';
import {
  permittedRooftopIds,
  recordMutation,
  requireActor,
  type MutationResult,
} from '@dealer/identity-access';
import { setAppointmentStateWithin } from '@dealer/crm';

interface Row {
  [key: string]: unknown;
}

// ── the up rotation ─────────────────────────────────────────────────────────

export type RotationStatus = 'available' | 'with_customer' | 'unavailable';

export interface RotationEntry {
  readonly rotationId: string;
  readonly rooftopId: string;
  readonly userLinkId: string;
  readonly position: number;
  readonly status: RotationStatus;
  readonly lastTakenAt: string | null;
  readonly authorizationVersion: number;
}

const ROTATION_COLUMNS = `rotation_id, rooftop_id, user_link_id, position, status,
       last_taken_at, authorization_version`;

function mapRotation(row: Row): RotationEntry {
  return {
    rotationId: String(row.rotation_id),
    rooftopId: String(row.rooftop_id),
    userLinkId: String(row.user_link_id),
    position: Number(row.position),
    status: String(row.status) as RotationStatus,
    lastTakenAt:
      row.last_taken_at === null ? null : new Date(row.last_taken_at as string).toISOString(),
    authorizationVersion: Number(row.authorization_version),
  };
}

export type RotationOutcome =
  | { outcome: 'joined'; entry: RotationEntry; mutation: MutationResult }
  | { outcome: 'already_on_the_floor'; entry: RotationEntry }
  | { outcome: 'invalid'; error: string };

/**
 * DOES THIS PERSON WORK THIS SHOWROOM?
 *
 * The commands that CREATE a row — joining the floor, leaving it, checking a
 * customer in — name no `resourceType`, so the policy engine has nothing to
 * resolve and the rooftop arrives as a plain field. A field in a request body
 * is a claim, not an authorization. The engine still decides WHETHER this actor
 * may run the command; this decides WHERE, from the same effective bindings the
 * engine reads, so the two cannot disagree.
 */
async function reaches(tenantId: string, userLinkId: string, rooftopId: string): Promise<boolean> {
  const permitted = await permittedRooftopIds(tenantId, userLinkId);
  return permitted.includes(rooftopId);
}

export async function joinFloorWithin(
  executor: Executor,
  input: {
    actingUserLinkId: string;
    tenantId: string;
    rooftopId: string;
    userLinkId: string;
  },
): Promise<RotationOutcome> {
  const actor = await requireActor(executor, input.actingUserLinkId);
  if (!(await reaches(input.tenantId, actor, input.rooftopId))) {
    return { outcome: 'invalid', error: 'you do not run the floor at that rooftop' };
  }
  if (!(await reaches(input.tenantId, input.userLinkId, input.rooftopId))) {
    return { outcome: 'invalid', error: 'that employee does not work this rooftop' };
  }

  const existing = await executor.query(
    `SELECT ${ROTATION_COLUMNS} FROM floor_rotations
      WHERE tenant_id = $1 AND rooftop_id = $2 AND user_link_id = $3`,
    [input.tenantId, input.rooftopId, input.userLinkId],
  );
  if (existing.rows.length > 0) {
    return { outcome: 'already_on_the_floor', entry: mapRotation(existing.rows[0] as Row) };
  }

  const written = await executor.query(
    `INSERT INTO floor_rotations
       (tenant_id, rooftop_id, user_link_id, position,
        created_by_user_link_id, updated_by_user_link_id)
     VALUES ($1, $2, $3,
             COALESCE((SELECT MAX(position) + 1 FROM floor_rotations
                        WHERE tenant_id = $1 AND rooftop_id = $2), 0),
             $4, $4)
     RETURNING ${ROTATION_COLUMNS}`,
    [input.tenantId, input.rooftopId, input.userLinkId, actor],
  );
  const entry = mapRotation(written.rows[0] as Row);
  const mutation = await recordMutation(executor, {
    tenantId: input.tenantId,
    entityType: 'floor_rotation',
    entityId: entry.rotationId,
    eventType: 'sales.floor.joined',
    actingUserLinkId: actor,
    authorizationVersion: entry.authorizationVersion,
    details: { rooftop_id: input.rooftopId, user_link_id: input.userLinkId },
  });
  return { outcome: 'joined', entry, mutation };
}

export async function joinFloor(input: {
  actingUserLinkId: string;
  tenantId: string;
  rooftopId: string;
  userLinkId: string;
}): Promise<RotationOutcome> {
  return withTenantTransaction(input.tenantId, (tx) => joinFloorWithin(tx, input));
}

export async function listFloor(tenantId: string, rooftopId: string): Promise<RotationEntry[]> {
  return withTenantTransaction(tenantId, async (tx) => {
    const found = await tx.query(
      `SELECT ${ROTATION_COLUMNS} FROM floor_rotations
        WHERE tenant_id = $1 AND rooftop_id = $2
        ORDER BY position`,
      [tenantId, rooftopId],
    );
    return (found.rows as Row[]).map(mapRotation);
  });
}

/**
 * WHOSE TURN IT IS, taken under a lock.
 *
 * The next available person by position, moved to the back and marked busy, all
 * in one transaction. Locking the ROOFTOP's rotation rows is what makes two
 * simultaneous greetings produce two different salespeople; reading first and
 * writing after would hand both customers to whoever the query happened to see.
 */
async function takeNextTurnWithin(
  executor: Executor,
  tenantId: string,
  rooftopId: string,
  actor: string,
): Promise<string | null> {
  const next = await executor.query(
    `SELECT rotation_id, user_link_id FROM floor_rotations
      WHERE tenant_id = $1 AND rooftop_id = $2 AND status = 'available'
      ORDER BY position
      LIMIT 1
      FOR UPDATE SKIP LOCKED`,
    [tenantId, rooftopId],
  );
  if (next.rows.length === 0) return null;
  const row = next.rows[0] as Row;
  await executor.query(
    `UPDATE floor_rotations
        SET status = 'with_customer', last_taken_at = NOW(),
            position = COALESCE((SELECT MAX(position) + 1 FROM floor_rotations
                                  WHERE tenant_id = $1 AND rooftop_id = $2), 0),
            updated_by_user_link_id = $4, updated_at = NOW(),
            authorization_version = authorization_version + 1
      WHERE tenant_id = $1 AND rotation_id = $3`,
    [tenantId, rooftopId, String(row.rotation_id), actor],
  );
  return String(row.user_link_id);
}

/**
 * TAKES A NAMED SALESPERSON OFF THE FLOOR, the override's half of the turn.
 *
 * It makes exactly the state change `takeNextTurnWithin` makes — busy, moved to
 * the back — so a customer who asked for their salesperson costs that person a
 * turn just as a walk-in would. The row is locked before it is read, because
 * two managers can name the same person at the same moment.
 */
async function claimNamedTurnWithin(
  executor: Executor,
  tenantId: string,
  rooftopId: string,
  userLinkId: string,
  actor: string,
): Promise<'claimed' | 'absent' | 'busy'> {
  const found = await executor.query(
    `SELECT rotation_id, status FROM floor_rotations
      WHERE tenant_id = $1 AND rooftop_id = $2 AND user_link_id = $3
      FOR UPDATE`,
    [tenantId, rooftopId, userLinkId],
  );
  if (found.rows.length === 0) return 'absent';
  const row = found.rows[0] as Row;
  if (String(row.status) !== 'available') return 'busy';
  await executor.query(
    `UPDATE floor_rotations
        SET status = 'with_customer', last_taken_at = NOW(),
            position = COALESCE((SELECT MAX(position) + 1 FROM floor_rotations
                                  WHERE tenant_id = $1 AND rooftop_id = $2), 0),
            updated_by_user_link_id = $4, updated_at = NOW(),
            authorization_version = authorization_version + 1
      WHERE tenant_id = $1 AND rotation_id = $3`,
    [tenantId, rooftopId, String(row.rotation_id), actor],
  );
  return 'claimed';
}

export type ReleaseOutcome =
  | { outcome: 'released'; entry: RotationEntry; mutation: MutationResult }
  | { outcome: 'not_found' };

/** Puts somebody back on the floor once their customer has gone. */
export async function releaseToFloor(input: {
  actingUserLinkId: string;
  tenantId: string;
  rooftopId: string;
  userLinkId: string;
}): Promise<ReleaseOutcome> {
  return withTenantTransaction(input.tenantId, async (tx) => {
    const actor = await requireActor(tx, input.actingUserLinkId);
    // Taking somebody OFF the floor is the same authority as putting them on it,
    // and reads the same rooftop out of the same request body.
    if (!(await reaches(input.tenantId, actor, input.rooftopId))) {
      return { outcome: 'not_found' as const };
    }
    const written = await tx.query(
      `UPDATE floor_rotations
          SET status = 'available', updated_by_user_link_id = $4, updated_at = NOW(),
              authorization_version = authorization_version + 1
        WHERE tenant_id = $1 AND rooftop_id = $2 AND user_link_id = $3
        RETURNING ${ROTATION_COLUMNS}`,
      [input.tenantId, input.rooftopId, input.userLinkId, actor],
    );
    if (written.rows.length === 0) return { outcome: 'not_found' as const };
    const entry = mapRotation(written.rows[0] as Row);
    const mutation = await recordMutation(tx, {
      tenantId: input.tenantId,
      entityType: 'floor_rotation',
      entityId: entry.rotationId,
      eventType: 'sales.floor.released',
      actingUserLinkId: actor,
      authorizationVersion: entry.authorizationVersion,
      details: { rooftop_id: input.rooftopId, user_link_id: input.userLinkId },
    });
    return { outcome: 'released' as const, entry, mutation };
  });
}

/** Frees whoever was with this visit, if the floor still has them busy. */
async function releaseWithin(
  executor: Executor,
  tenantId: string,
  rooftopId: string,
  userLinkId: string | null,
  actor: string,
): Promise<void> {
  if (userLinkId === null) return;
  await executor.query(
    `UPDATE floor_rotations
        SET status = 'available', updated_by_user_link_id = $4, updated_at = NOW(),
            authorization_version = authorization_version + 1
      WHERE tenant_id = $1 AND rooftop_id = $2 AND user_link_id = $3
        AND status = 'with_customer'`,
    [tenantId, rooftopId, userLinkId, actor],
  );
}

// ── the visit ───────────────────────────────────────────────────────────────

export type VisitState = 'arrived' | 'greeted' | 'with_salesperson' | 'departed';

export interface VisitView {
  readonly visitId: string;
  readonly rooftopId: string;
  readonly partyId: string;
  readonly opportunityId: string | null;
  readonly appointmentId: string | null;
  readonly greetedByUserLinkId: string | null;
  readonly acceptedByUserLinkId: string | null;
  readonly state: VisitState;
  readonly arrivedAt: string;
  readonly greetedAt: string | null;
  readonly acceptedAt: string | null;
  readonly departedAt: string | null;
  readonly authorizationVersion: number;
}

const VISIT_COLUMNS = `visit_id, rooftop_id, party_id, opportunity_id, appointment_id,
       greeted_by_user_link_id, accepted_by_user_link_id, state, arrived_at, greeted_at,
       accepted_at, departed_at, authorization_version`;

export function mapVisit(row: Row): VisitView {
  const iso = (v: unknown): string | null =>
    v === null || v === undefined ? null : new Date(v as string).toISOString();
  const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
  return {
    visitId: String(row.visit_id),
    rooftopId: String(row.rooftop_id),
    partyId: String(row.party_id),
    opportunityId: str(row.opportunity_id),
    appointmentId: str(row.appointment_id),
    greetedByUserLinkId: str(row.greeted_by_user_link_id),
    acceptedByUserLinkId: str(row.accepted_by_user_link_id),
    state: String(row.state) as VisitState,
    arrivedAt: new Date(row.arrived_at as string).toISOString(),
    greetedAt: iso(row.greeted_at),
    acceptedAt: iso(row.accepted_at),
    departedAt: iso(row.departed_at),
    authorizationVersion: Number(row.authorization_version),
  };
}

export type CheckInOutcome =
  | {
      outcome: 'checked_in';
      visit: VisitView;
      appointmentKept: boolean;
      mutation: MutationResult;
    }
  | { outcome: 'already_here'; visit: VisitView; appointmentKept: boolean }
  | { outcome: 'not_found' }
  | { outcome: 'invalid'; error: string };

/** The advisory-lock key a check-in serializes on. Derived, never supplied. */
function checkInKey(tenantId: string, partyId: string): string {
  return `sales.showroom.checkin:${tenantId}:${partyId}`;
}

/**
 * A CUSTOMER IS IN THE BUILDING.
 *
 * ── converging, and why the request key is not enough ──────────────────────
 *
 * The idempotency layer merges two requests carrying the SAME key. It cannot
 * merge two carrying different ones — a receptionist checking somebody in at
 * the desk while a salesperson does the same on a tablet are two honest
 * requests with two honest keys, and both are the same arrival. So the
 * convergence is on the BUSINESS key: this customer, active. The advisory lock
 * serializes the racing pair and the unique index holds for any caller that
 * never took it.
 *
 * ── the appointment, validated and marked kept in one act ──────────────────
 *
 * A booking that was completed, cancelled or marked a no-show is not a booking
 * this arrival can be against, and saying so is the point: a no-show that can
 * be checked in an hour later makes the no-show figure a guess. A valid one is
 * marked kept through Release Train 3's own service inside this transaction, so
 * the arrival and the kept booking commit together or not at all.
 */
export async function checkInWithin(
  executor: Executor,
  input: {
    actingUserLinkId: string;
    tenantId: string;
    rooftopId: string;
    partyId: string;
    opportunityId?: string | null | undefined;
    appointmentId?: string | null | undefined;
  },
): Promise<CheckInOutcome> {
  const actor = await requireActor(executor, input.actingUserLinkId);
  if (!(await reaches(input.tenantId, actor, input.rooftopId))) {
    return { outcome: 'invalid', error: 'you do not work at that rooftop' };
  }

  await executor.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
    checkInKey(input.tenantId, input.partyId),
  ]);

  // ONE ACTIVE VISIT. A customer already in the building is the SAME arrival,
  // whatever request key asked, and the answer is that visit.
  const active = await executor.query(
    `SELECT ${VISIT_COLUMNS} FROM showroom_visits
      WHERE tenant_id = $1 AND party_id = $2 AND state <> 'departed'`,
    [input.tenantId, input.partyId],
  );
  if (active.rows.length > 0) {
    const visit = mapVisit(active.rows[0] as Row);
    return {
      outcome: 'already_here',
      visit,
      appointmentKept: visit.appointmentId !== null,
    };
  }

  const party = await executor.query(
    `SELECT status FROM parties WHERE tenant_id = $1 AND party_id = $2`,
    [input.tenantId, input.partyId],
  );
  if (party.rows.length === 0) return { outcome: 'not_found' };

  // An attached opportunity must belong to THIS rooftop and THIS customer, or
  // the floor board would show somebody standing in a showroom their record is
  // not in, against a deal that is not theirs.
  if (input.opportunityId != null) {
    const owner = await executor.query(
      `SELECT rooftop_id, party_id FROM opportunities
        WHERE tenant_id = $1 AND opportunity_id = $2`,
      [input.tenantId, input.opportunityId],
    );
    if (owner.rows.length === 0) return { outcome: 'not_found' };
    const row = owner.rows[0] as Row;
    if (String(row.rooftop_id) !== input.rooftopId) {
      return { outcome: 'invalid', error: 'that opportunity belongs to a different rooftop' };
    }
    if (String(row.party_id) !== input.partyId) {
      return { outcome: 'invalid', error: 'that opportunity belongs to a different customer' };
    }
  }

  // ── the appointment ──────────────────────────────────────────────────────
  let appointmentKept = false;
  if (input.appointmentId != null) {
    const booked = await executor.query(
      `SELECT rooftop_id, party_id, state, authorization_version FROM appointments
        WHERE tenant_id = $1 AND appointment_id = $2
        FOR UPDATE`,
      [input.tenantId, input.appointmentId],
    );
    if (booked.rows.length === 0) return { outcome: 'not_found' };
    const appointment = booked.rows[0] as Row;
    if (String(appointment.rooftop_id) !== input.rooftopId) {
      return { outcome: 'invalid', error: 'that appointment is at a different rooftop' };
    }
    if (String(appointment.party_id) !== input.partyId) {
      return { outcome: 'invalid', error: 'that appointment was booked for somebody else' };
    }
    const state = String(appointment.state);
    if (state !== 'scheduled' && state !== 'confirmed') {
      return {
        outcome: 'invalid',
        error: `that appointment is already ${state}, so nobody can be checked in against it`,
      };
    }
    const kept = await setAppointmentStateWithin(executor, {
      actingUserLinkId: actor,
      tenantId: input.tenantId,
      appointmentId: input.appointmentId,
      expectedVersion: Number(appointment.authorization_version),
      state: 'completed',
    });
    if (kept.outcome !== 'moved') {
      return {
        outcome: 'invalid',
        error: 'that appointment could not be marked kept, so the arrival was not recorded',
      };
    }
    appointmentKept = true;
  }

  const written = await executor.query(
    `INSERT INTO showroom_visits
       (tenant_id, rooftop_id, party_id, opportunity_id, appointment_id,
        created_by_user_link_id, updated_by_user_link_id)
     VALUES ($1, $2, $3, $4, $5, $6, $6)
     RETURNING ${VISIT_COLUMNS}`,
    [
      input.tenantId,
      input.rooftopId,
      input.partyId,
      input.opportunityId ?? null,
      input.appointmentId ?? null,
      actor,
    ],
  );
  const visit = mapVisit(written.rows[0] as Row);
  await executor.query(
    `INSERT INTO visit_events (tenant_id, visit_id, event_type, actor_user_link_id)
     VALUES ($1, $2, 'arrived', $3)`,
    [input.tenantId, visit.visitId, actor],
  );
  if (appointmentKept) {
    await executor.query(
      `INSERT INTO visit_events (tenant_id, visit_id, event_type, note, actor_user_link_id)
       VALUES ($1, $2, 'appointment_kept', 'they turned up for their booking', $3)`,
      [input.tenantId, visit.visitId, actor],
    );
  }
  const mutation = await recordMutation(executor, {
    tenantId: input.tenantId,
    entityType: 'showroom_visit',
    entityId: visit.visitId,
    eventType: 'sales.visit.arrived',
    actingUserLinkId: actor,
    authorizationVersion: visit.authorizationVersion,
    details: {
      rooftop_id: input.rooftopId,
      opportunity_id: visit.opportunityId,
      appointment_kept: appointmentKept,
    },
  });
  return { outcome: 'checked_in', visit, appointmentKept, mutation };
}

export async function checkIn(input: {
  actingUserLinkId: string;
  tenantId: string;
  rooftopId: string;
  partyId: string;
  opportunityId?: string | null | undefined;
  appointmentId?: string | null | undefined;
}): Promise<CheckInOutcome> {
  return withTenantTransaction(input.tenantId, (tx) => checkInWithin(tx, input));
}

export type GreetOutcome =
  | {
      outcome: 'greeted';
      visit: VisitView;
      greetedBy: string;
      fromRotation: boolean;
      mutation: MutationResult;
    }
  | { outcome: 'nobody_available' }
  | { outcome: 'version_conflict'; currentVersion: number }
  | { outcome: 'not_found' }
  | { outcome: 'invalid'; error: string };

/**
 * GREETS A WAITING CUSTOMER, taking the next turn off the floor.
 *
 * The turn and the greeting commit together. If they did not, a crash between
 * them would either burn somebody's turn on a customer they never met, or greet
 * a customer without advancing the queue — and the second one is how the same
 * salesperson ends up taking every walk-in of the afternoon.
 *
 * A named salesperson skips the rotation, which a manager sometimes must do,
 * and must still be ON the floor and free: being allowed to work a rooftop is
 * not the same as standing on it, and an override that skipped the rotation
 * write would leave the up-list believing that person was still available.
 */
export async function greetVisit(input: {
  actingUserLinkId: string;
  tenantId: string;
  visitId: string;
  expectedVersion: number;
  greetedByUserLinkId?: string | null | undefined;
}): Promise<GreetOutcome> {
  return withTenantTransaction(input.tenantId, async (tx) => {
    const actor = await requireActor(tx, input.actingUserLinkId);
    const existing = await tx.query(
      `SELECT ${VISIT_COLUMNS} FROM showroom_visits
        WHERE tenant_id = $1 AND visit_id = $2 FOR UPDATE`,
      [input.tenantId, input.visitId],
    );
    if (existing.rows.length === 0) return { outcome: 'not_found' as const };
    const current = mapVisit(existing.rows[0] as Row);
    if (current.state !== 'arrived') {
      return { outcome: 'invalid' as const, error: `this visit is already ${current.state}` };
    }
    if (current.authorizationVersion !== input.expectedVersion) {
      return { outcome: 'version_conflict' as const, currentVersion: current.authorizationVersion };
    }

    let greeter = input.greetedByUserLinkId ?? null;
    let fromRotation = false;
    if (greeter === null) {
      greeter = await takeNextTurnWithin(tx, input.tenantId, current.rooftopId, actor);
      if (greeter === null) return { outcome: 'nobody_available' as const };
      fromRotation = true;
    } else {
      if (!(await reaches(input.tenantId, greeter, current.rooftopId))) {
        return { outcome: 'invalid' as const, error: 'that employee does not work this rooftop' };
      }
      const claimed = await claimNamedTurnWithin(
        tx,
        input.tenantId,
        current.rooftopId,
        greeter,
        actor,
      );
      if (claimed === 'absent') {
        return {
          outcome: 'invalid' as const,
          error: 'that salesperson is not on the floor right now',
        };
      }
      if (claimed === 'busy') {
        return {
          outcome: 'invalid' as const,
          error: 'that salesperson is already with a customer',
        };
      }
    }

    const written = await tx.query(
      `UPDATE showroom_visits
          SET state = 'greeted', greeted_at = NOW(), greeted_by_user_link_id = $3,
              updated_by_user_link_id = $4, updated_at = NOW(),
              authorization_version = authorization_version + 1
        WHERE tenant_id = $1 AND visit_id = $2 AND authorization_version = $5
        RETURNING ${VISIT_COLUMNS}`,
      [input.tenantId, input.visitId, greeter, actor, input.expectedVersion],
    );
    if (written.rows.length === 0) {
      return { outcome: 'version_conflict' as const, currentVersion: current.authorizationVersion };
    }
    const visit = mapVisit(written.rows[0] as Row);
    await tx.query(
      `INSERT INTO visit_events (tenant_id, visit_id, event_type, note, actor_user_link_id)
       VALUES ($1, $2, 'greeted', $3, $4)`,
      [
        input.tenantId,
        input.visitId,
        fromRotation ? 'took the next turn on the floor' : 'assigned by name',
        actor,
      ],
    );
    const mutation = await recordMutation(tx, {
      tenantId: input.tenantId,
      entityType: 'showroom_visit',
      entityId: visit.visitId,
      eventType: 'sales.visit.greeted',
      actingUserLinkId: actor,
      authorizationVersion: visit.authorizationVersion,
      details: { greeted_by: greeter, from_rotation: fromRotation },
    });
    return { outcome: 'greeted' as const, visit, greetedBy: greeter, fromRotation, mutation };
  });
}

export type VisitAcceptOutcome =
  | { outcome: 'accepted'; visit: VisitView; mutation: MutationResult }
  | { outcome: 'already_accepted'; visit: VisitView }
  | { outcome: 'version_conflict'; currentVersion: number }
  | { outcome: 'not_found' }
  | { outcome: 'invalid'; error: string };

/**
 * THE SALESPERSON TAKES THE CUSTOMER ON, explicitly and in their own name.
 *
 * Greeting is the door and a manager can do it. This is the separate act of a
 * salesperson saying "this one is mine to work", which is what the floor board
 * means by `with_salesperson` and what a customer means when they ask who they
 * are dealing with. Replaying it converges rather than refusing.
 */
export async function acceptVisit(input: {
  actingUserLinkId: string;
  tenantId: string;
  visitId: string;
  expectedVersion: number;
}): Promise<VisitAcceptOutcome> {
  return withTenantTransaction(input.tenantId, async (tx) => {
    const actor = await requireActor(tx, input.actingUserLinkId);
    const existing = await tx.query(
      `SELECT ${VISIT_COLUMNS} FROM showroom_visits
        WHERE tenant_id = $1 AND visit_id = $2 FOR UPDATE`,
      [input.tenantId, input.visitId],
    );
    if (existing.rows.length === 0) return { outcome: 'not_found' as const };
    const current = mapVisit(existing.rows[0] as Row);
    if (current.acceptedByUserLinkId === actor) {
      return { outcome: 'already_accepted' as const, visit: current };
    }
    if (current.state === 'departed') {
      return { outcome: 'invalid' as const, error: 'that customer has already left' };
    }
    if (current.state === 'arrived') {
      return {
        outcome: 'invalid' as const,
        error: 'greet the customer before taking them on',
      };
    }
    if (current.acceptedByUserLinkId !== null) {
      return {
        outcome: 'invalid' as const,
        error: 'another salesperson has already taken this customer on',
      };
    }
    if (current.authorizationVersion !== input.expectedVersion) {
      return { outcome: 'version_conflict' as const, currentVersion: current.authorizationVersion };
    }
    if (!(await reaches(input.tenantId, actor, current.rooftopId))) {
      return { outcome: 'not_found' as const };
    }

    const written = await tx.query(
      `UPDATE showroom_visits
          SET state = 'with_salesperson', accepted_at = NOW(), accepted_by_user_link_id = $3,
              updated_by_user_link_id = $3, updated_at = NOW(),
              authorization_version = authorization_version + 1
        WHERE tenant_id = $1 AND visit_id = $2 AND authorization_version = $4
        RETURNING ${VISIT_COLUMNS}`,
      [input.tenantId, input.visitId, actor, input.expectedVersion],
    );
    if (written.rows.length === 0) {
      return { outcome: 'version_conflict' as const, currentVersion: current.authorizationVersion };
    }
    const visit = mapVisit(written.rows[0] as Row);
    await tx.query(
      `INSERT INTO visit_events (tenant_id, visit_id, event_type, note, actor_user_link_id)
       VALUES ($1, $2, 'accepted', 'took the customer on', $3)`,
      [input.tenantId, input.visitId, actor],
    );
    const mutation = await recordMutation(tx, {
      tenantId: input.tenantId,
      entityType: 'showroom_visit',
      entityId: visit.visitId,
      eventType: 'sales.visit.accepted',
      actingUserLinkId: actor,
      authorizationVersion: visit.authorizationVersion,
      details: { accepted_by: actor },
    });
    return { outcome: 'accepted' as const, visit, mutation };
  });
}

export type VisitCloseOutcome =
  | { outcome: 'departed'; visit: VisitView; mutation: MutationResult }
  | { outcome: 'already_departed'; visit: VisitView }
  | { outcome: 'version_conflict'; currentVersion: number }
  | { outcome: 'not_found' }
  | { outcome: 'invalid'; error: string };

/**
 * THE CUSTOMER HAS GONE, and whoever was with them goes back on the floor in
 * the same transaction. A floor that leaks people is a floor that stops giving
 * out turns.
 */
export async function departVisit(input: {
  actingUserLinkId: string;
  tenantId: string;
  visitId: string;
  expectedVersion: number;
  note?: string | null | undefined;
}): Promise<VisitCloseOutcome> {
  return withTenantTransaction(input.tenantId, async (tx) => {
    const actor = await requireActor(tx, input.actingUserLinkId);
    const existing = await tx.query(
      `SELECT ${VISIT_COLUMNS} FROM showroom_visits
        WHERE tenant_id = $1 AND visit_id = $2 FOR UPDATE`,
      [input.tenantId, input.visitId],
    );
    if (existing.rows.length === 0) return { outcome: 'not_found' as const };
    const current = mapVisit(existing.rows[0] as Row);
    if (current.state === 'departed') {
      return { outcome: 'already_departed' as const, visit: current };
    }
    if (current.authorizationVersion !== input.expectedVersion) {
      return { outcome: 'version_conflict' as const, currentVersion: current.authorizationVersion };
    }

    // A CAR CANNOT STILL BE OUT. Letting a customer "leave" while a
    // demonstration is active would close the visit that explains where the
    // vehicle went.
    const out = await tx.query(
      `SELECT 1 FROM demonstrations
        WHERE tenant_id = $1 AND visit_id = $2 AND state IN ('issued', 'in_progress')
        LIMIT 1`,
      [input.tenantId, input.visitId],
    );
    if (out.rows.length > 0) {
      return {
        outcome: 'invalid' as const,
        error: 'a car is still out on this visit — close the demonstration first',
      };
    }

    const written = await tx.query(
      `UPDATE showroom_visits
          SET state = 'departed', departed_at = NOW(),
              updated_by_user_link_id = $3, updated_at = NOW(),
              authorization_version = authorization_version + 1
        WHERE tenant_id = $1 AND visit_id = $2 AND authorization_version = $4
        RETURNING ${VISIT_COLUMNS}`,
      [input.tenantId, input.visitId, actor, input.expectedVersion],
    );
    if (written.rows.length === 0) {
      return { outcome: 'version_conflict' as const, currentVersion: current.authorizationVersion };
    }
    const visit = mapVisit(written.rows[0] as Row);
    await tx.query(
      `INSERT INTO visit_events (tenant_id, visit_id, event_type, note, actor_user_link_id)
       VALUES ($1, $2, 'departed', $3, $4)`,
      [input.tenantId, input.visitId, input.note ?? null, actor],
    );
    await releaseWithin(
      tx,
      input.tenantId,
      visit.rooftopId,
      visit.acceptedByUserLinkId ?? visit.greetedByUserLinkId,
      actor,
    );
    const mutation = await recordMutation(tx, {
      tenantId: input.tenantId,
      entityType: 'showroom_visit',
      entityId: visit.visitId,
      eventType: 'sales.visit.departed',
      actingUserLinkId: actor,
      authorizationVersion: visit.authorizationVersion,
      details: { rooftop_id: visit.rooftopId },
    });
    return { outcome: 'departed' as const, visit, mutation };
  });
}
