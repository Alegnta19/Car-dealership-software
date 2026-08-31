/**
 * RELEASE TRAIN 4 — THE SHOWROOM FLOOR.
 *
 * TWO THINGS LIVE HERE and they are one subject: who is up next, and what
 * happened to the person who walked in.
 *
 *   * THE ROTATION IS A RECORD, NOT A HABIT. Which salesperson takes the next
 *     customer is the single most argued-about fact on a showroom floor, and a
 *     platform that leaves it to whoever reaches the door first has taken a
 *     side. Taking a turn advances the queue under a lock, so two receptionists
 *     greeting two customers at the same moment cannot hand both to the same
 *     person — or skip somebody's turn.
 *   * A VISIT IS A LIFECYCLE, and its stamps are one-way. A visit that was
 *     greeted keeps that fact after the customer leaves, because "how long did
 *     they wait" is a question somebody asks the next morning.
 *
 * A WALK-IN NEEDS NO OPPORTUNITY. Most people who come through the door have
 * never been a lead, and requiring an opportunity first would make the platform
 * refuse the most ordinary thing a showroom does. The visit can be attached to
 * one later, when there is one.
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

// ── the floor rotation ──────────────────────────────────────────────────────

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

const ROTATION_COLUMNS = `rotation_id, rooftop_id, user_link_id, position, status, last_taken_at,
       authorization_version`;

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
 * Puts a salesperson on the floor, at the back of the queue.
 *
 * They must be able to REACH the rooftop — the same rule opportunity assignment
 * follows. Somebody in the rotation for a store they cannot see would be handed
 * customers the policy engine then tells them do not exist.
 */
/**
 * DOES THIS PERSON WORK THIS SHOWROOM?
 *
 * Three commands on this surface — putting somebody on the floor, taking them
 * off it, and recording an arrival — CREATE a row rather than acting on one, so
 * their actions name no `resourceType` and the policy engine has nothing to
 * resolve. The rooftop arrives as a plain field in the request body, and a
 * field in a request body is a claim, not an authorization: without this check
 * a manager at one store could seed the up-list at another store, or plant a
 * walk-in on somebody else's showroom board.
 *
 * The engine still decides WHETHER this actor may run the command at all. This
 * decides WHERE, from the same effective bindings the engine reads, so the two
 * cannot disagree.
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
        ORDER BY status <> 'available', position`,
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

// ── the visit ───────────────────────────────────────────────────────────────

export type VisitState = 'arrived' | 'greeted' | 'with_salesperson' | 'departed';

export interface VisitView {
  readonly visitId: string;
  readonly rooftopId: string;
  readonly partyId: string;
  readonly opportunityId: string | null;
  readonly appointmentId: string | null;
  readonly greetedByUserLinkId: string | null;
  readonly state: VisitState;
  readonly arrivedAt: string;
  readonly greetedAt: string | null;
  readonly departedAt: string | null;
  readonly authorizationVersion: number;
}

const VISIT_COLUMNS = `visit_id, rooftop_id, party_id, opportunity_id, appointment_id,
       greeted_by_user_link_id, state, arrived_at, greeted_at, departed_at,
       authorization_version`;

export function mapVisit(row: Row): VisitView {
  const iso = (v: unknown): string | null =>
    v === null ? null : new Date(v as string).toISOString();
  return {
    visitId: String(row.visit_id),
    rooftopId: String(row.rooftop_id),
    partyId: String(row.party_id),
    opportunityId: row.opportunity_id === null ? null : String(row.opportunity_id),
    appointmentId: row.appointment_id === null ? null : String(row.appointment_id),
    greetedByUserLinkId:
      row.greeted_by_user_link_id === null ? null : String(row.greeted_by_user_link_id),
    state: String(row.state) as VisitState,
    arrivedAt: new Date(row.arrived_at as string).toISOString(),
    greetedAt: iso(row.greeted_at),
    departedAt: iso(row.departed_at),
    authorizationVersion: Number(row.authorization_version),
  };
}

export type ArrivalOutcome =
  | { outcome: 'arrived'; visit: VisitView; mutation: MutationResult }
  | { outcome: 'not_found' }
  | { outcome: 'invalid'; error: string };

/** Somebody walked in. Nothing else is required yet — not even a reason. */
export async function recordArrivalWithin(
  executor: Executor,
  input: {
    actingUserLinkId: string;
    tenantId: string;
    rooftopId: string;
    partyId: string;
    opportunityId?: string | null | undefined;
    appointmentId?: string | null | undefined;
  },
): Promise<ArrivalOutcome> {
  const actor = await requireActor(executor, input.actingUserLinkId);
  if (!(await reaches(input.tenantId, actor, input.rooftopId))) {
    return { outcome: 'invalid', error: 'you do not work at that rooftop' };
  }

  // An attached opportunity must belong to THIS rooftop, or the floor board
  // would show a customer standing in a showroom their record is not in.
  if (input.opportunityId != null) {
    const owner = await executor.query(
      `SELECT rooftop_id FROM opportunities WHERE tenant_id = $1 AND opportunity_id = $2`,
      [input.tenantId, input.opportunityId],
    );
    if (owner.rows.length === 0) return { outcome: 'not_found' };
    if (String((owner.rows[0] as Row).rooftop_id) !== input.rooftopId) {
      return { outcome: 'invalid', error: 'that opportunity belongs to a different rooftop' };
    }
  }

  // AN APPOINTMENT IS A CLAIM ABOUT WHO WAS EXPECTED AND WHERE. Accepting the
  // id unchecked would let one customer's arrival be recorded against another
  // customer's booking, at another rooftop — and the CRM's kept-appointment
  // figures are computed from exactly this link, so a wrong one is not a
  // cosmetic error. The appointment must be at THIS rooftop and belong to THIS
  // customer; anything else is a caller's mistake, not an arrival.
  if (input.appointmentId != null) {
    const booked = await executor.query(
      `SELECT rooftop_id, party_id, state FROM appointments
        WHERE tenant_id = $1 AND appointment_id = $2`,
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
    if (String(appointment.state) === 'cancelled') {
      return { outcome: 'invalid', error: 'that appointment was cancelled' };
    }
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
  const mutation = await recordMutation(executor, {
    tenantId: input.tenantId,
    entityType: 'showroom_visit',
    entityId: visit.visitId,
    eventType: 'sales.visit.arrived',
    actingUserLinkId: actor,
    authorizationVersion: visit.authorizationVersion,
    details: { rooftop_id: input.rooftopId, had_appointment: input.appointmentId != null },
  });
  return { outcome: 'arrived', visit, mutation };
}

export async function recordArrival(input: {
  actingUserLinkId: string;
  tenantId: string;
  rooftopId: string;
  partyId: string;
  opportunityId?: string | null | undefined;
  appointmentId?: string | null | undefined;
}): Promise<ArrivalOutcome> {
  return withTenantTransaction(input.tenantId, (tx) => recordArrivalWithin(tx, input));
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
 * A named salesperson skips the rotation, which a manager sometimes must do;
 * that it was an override rather than a turn is recorded either way.
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
      const reach = await permittedRooftopIds(input.tenantId, greeter);
      if (!reach.includes(current.rooftopId)) {
        return { outcome: 'invalid' as const, error: 'that employee does not work this rooftop' };
      }
      // BEING ALLOWED TO WORK THIS FLOOR IS NOT THE SAME AS BEING ON IT. A
      // manager naming somebody who went home hands a customer to an empty
      // desk; and if the override skipped the rotation write, the up-list would
      // still think that person was free and give them a second walk-in.
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

export type VisitCloseOutcome =
  | { outcome: 'departed'; visit: VisitView; mutation: MutationResult }
  | { outcome: 'version_conflict'; currentVersion: number }
  | { outcome: 'not_found' }
  | { outcome: 'invalid'; error: string };

/**
 * The customer left. The salesperson who had them goes back on the floor in the
 * same transaction, because a rotation that only advances is a rotation that
 * empties.
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
      return { outcome: 'invalid' as const, error: 'this visit already ended' };
    }
    if (current.authorizationVersion !== input.expectedVersion) {
      return { outcome: 'version_conflict' as const, currentVersion: current.authorizationVersion };
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
    if (current.greetedByUserLinkId !== null) {
      await tx.query(
        `UPDATE floor_rotations
            SET status = 'available', updated_by_user_link_id = $4, updated_at = NOW(),
                authorization_version = authorization_version + 1
          WHERE tenant_id = $1 AND rooftop_id = $2 AND user_link_id = $3
            AND status = 'with_customer'`,
        [input.tenantId, current.rooftopId, current.greetedByUserLinkId, actor],
      );
    }
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
