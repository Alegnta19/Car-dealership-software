/**
 * RELEASE TRAIN 4 — SELECTION, DEMONSTRATION, FOLLOW-UP AND NEGOTIATION.
 *
 * WHAT THE CUSTOMER IS LOOKING AT, WHAT THEY DROVE, WHAT WAS SAID AFTERWARDS,
 * AND HOW THE HAGGLING WENT — everything between "they are in the building" and
 * "they decided", and nothing past it.
 *
 * THREE RULES HOLD THIS FILE TOGETHER:
 *
 *   * A CHILD IS WRITTEN THROUGH ITS PARENT. Every service here takes the
 *     opportunity it was authorized against, and a row belonging to a different
 *     one is NOT FOUND rather than forbidden — the lesson RT3-C1 taught, applied
 *     from the first line rather than after a review.
 *   * A FINISHED OPPORTUNITY TAKES NO MORE WORK. Won and lost absorb, so a
 *     close-rate report is not quietly edited a week later.
 *   * NOBODY QUOTES A PRICE. `negotiation_rounds` has no amount column, because
 *     a nullable one would be filled in within a week and the platform would be
 *     stating figures it has no authority to state. Pricing is FBL-120.
 */
import { withTenantTransaction, type Executor } from '@dealer/database';
import {
  permittedRooftopIds,
  recordMutation,
  requireActor,
  type MutationResult,
} from '@dealer/identity-access';
import { assertOpportunityOpen } from './opportunities';

interface Row {
  [key: string]: unknown;
}

// ── vehicle selection ───────────────────────────────────────────────────────

export type VehicleInterestStatus = 'considering' | 'demonstrated' | 'rejected' | 'selected';

/** Where a shortlisted car can stand. The service owns this, not the CHECK. */
export const VEHICLE_INTEREST_STATUSES: readonly VehicleInterestStatus[] = [
  'considering',
  'demonstrated',
  'rejected',
  'selected',
];

export interface OpportunityVehicleView {
  readonly opportunityVehicleId: string;
  readonly opportunityId: string;
  readonly stockItemId: string;
  readonly rank: number;
  readonly status: VehicleInterestStatus;
  readonly rejectedReason: string | null;
  readonly authorizationVersion: number;
}

const VEHICLE_COLUMNS = `opportunity_vehicle_id, opportunity_id, stock_item_id, rank, status,
       rejected_reason, authorization_version`;

function mapVehicle(row: Row): OpportunityVehicleView {
  return {
    opportunityVehicleId: String(row.opportunity_vehicle_id),
    opportunityId: String(row.opportunity_id),
    stockItemId: String(row.stock_item_id),
    rank: Number(row.rank),
    status: String(row.status) as VehicleInterestStatus,
    rejectedReason: row.rejected_reason === null ? null : String(row.rejected_reason),
    authorizationVersion: Number(row.authorization_version),
  };
}

export type ShortlistOutcome =
  | { outcome: 'added'; vehicle: OpportunityVehicleView; mutation: MutationResult }
  | { outcome: 'already_shortlisted'; vehicle: OpportunityVehicleView }
  | { outcome: 'not_found' }
  | { outcome: 'invalid'; error: string };

/**
 * Puts a car on the shortlist. It must be REAL STOCK at the opportunity's own
 * rooftop: a customer at Downtown cannot be shown a Northside car as though it
 * were on the lot in front of them.
 */
export async function shortlistVehicleWithin(
  executor: Executor,
  input: {
    actingUserLinkId: string;
    tenantId: string;
    opportunityId: string;
    stockItemId: string;
    rank?: number | undefined;
  },
): Promise<ShortlistOutcome> {
  const actor = await requireActor(executor, input.actingUserLinkId);
  const open = await assertOpportunityOpen(executor, input.tenantId, input.opportunityId);
  if (!open.ok) {
    return open.reason === 'not_found'
      ? { outcome: 'not_found' }
      : { outcome: 'invalid', error: open.reason };
  }

  const stock = await executor.query(
    `SELECT rooftop_id, lifecycle_state FROM stock_items
      WHERE tenant_id = $1 AND stock_item_id = $2`,
    [input.tenantId, input.stockItemId],
  );
  if (stock.rows.length === 0) return { outcome: 'not_found' };
  const car = stock.rows[0] as Row;
  if (String(car.rooftop_id) !== open.opportunity.rooftopId) {
    return { outcome: 'invalid', error: 'that vehicle is at a different rooftop' };
  }
  if (String(car.lifecycle_state) === 'retired') {
    return { outcome: 'invalid', error: 'that vehicle is no longer in stock' };
  }

  const existing = await executor.query(
    `SELECT ${VEHICLE_COLUMNS} FROM opportunity_vehicles
      WHERE tenant_id = $1 AND opportunity_id = $2 AND stock_item_id = $3`,
    [input.tenantId, input.opportunityId, input.stockItemId],
  );
  if (existing.rows.length > 0) {
    return { outcome: 'already_shortlisted', vehicle: mapVehicle(existing.rows[0] as Row) };
  }

  const written = await executor.query(
    `INSERT INTO opportunity_vehicles
       (tenant_id, opportunity_id, stock_item_id, rank,
        created_by_user_link_id, updated_by_user_link_id)
     VALUES ($1, $2, $3,
             COALESCE($4::int, (SELECT COALESCE(MAX(rank), 0) + 1 FROM opportunity_vehicles
                                 WHERE tenant_id = $1 AND opportunity_id = $2)),
             $5, $5)
     RETURNING ${VEHICLE_COLUMNS}`,
    [input.tenantId, input.opportunityId, input.stockItemId, input.rank ?? null, actor],
  );
  const vehicle = mapVehicle(written.rows[0] as Row);
  const mutation = await recordMutation(executor, {
    tenantId: input.tenantId,
    entityType: 'opportunity_vehicle',
    entityId: vehicle.opportunityVehicleId,
    eventType: 'sales.vehicle.shortlisted',
    actingUserLinkId: actor,
    authorizationVersion: vehicle.authorizationVersion,
    details: { opportunity_id: input.opportunityId, stock_item_id: input.stockItemId },
  });
  return { outcome: 'added', vehicle, mutation };
}

export async function shortlistVehicle(input: {
  actingUserLinkId: string;
  tenantId: string;
  opportunityId: string;
  stockItemId: string;
  rank?: number | undefined;
}): Promise<ShortlistOutcome> {
  return withTenantTransaction(input.tenantId, (tx) => shortlistVehicleWithin(tx, input));
}

export type VehicleStatusOutcome =
  | { outcome: 'updated'; vehicle: OpportunityVehicleView; mutation: MutationResult }
  | { outcome: 'version_conflict'; currentVersion: number }
  | { outcome: 'not_found' }
  | { outcome: 'invalid'; error: string };

/**
 * Marks where a car stands with this customer. Selecting one is exclusive —
 * migration 064's partial unique index admits a single `selected` row per
 * opportunity — so the previous selection is stood down in the same
 * transaction rather than colliding.
 */
export async function setVehicleStatus(input: {
  actingUserLinkId: string;
  tenantId: string;
  opportunityId: string;
  opportunityVehicleId: string;
  expectedVersion: number;
  status: VehicleInterestStatus;
  rejectedReason?: string | null | undefined;
}): Promise<VehicleStatusOutcome> {
  return withTenantTransaction(input.tenantId, async (tx) => {
    const actor = await requireActor(tx, input.actingUserLinkId);
    const open = await assertOpportunityOpen(tx, input.tenantId, input.opportunityId);
    if (!open.ok) {
      return open.reason === 'not_found'
        ? { outcome: 'not_found' as const }
        : { outcome: 'invalid' as const, error: open.reason };
    }
    const existing = await tx.query(
      `SELECT ${VEHICLE_COLUMNS} FROM opportunity_vehicles
        WHERE tenant_id = $1 AND opportunity_vehicle_id = $2 FOR UPDATE`,
      [input.tenantId, input.opportunityVehicleId],
    );
    if (existing.rows.length === 0) return { outcome: 'not_found' as const };
    const current = mapVehicle(existing.rows[0] as Row);
    // EXACT PARENT: authorized against one opportunity, acting on its own row.
    if (current.opportunityId !== input.opportunityId) return { outcome: 'not_found' as const };
    if (current.authorizationVersion !== input.expectedVersion) {
      return { outcome: 'version_conflict' as const, currentVersion: current.authorizationVersion };
    }
    if (!VEHICLE_INTEREST_STATUSES.includes(input.status)) {
      return {
        outcome: 'invalid' as const,
        error: `a shortlisted car is ${VEHICLE_INTEREST_STATUSES.join(', ')} — not ${input.status}`,
      };
    }
    if (input.status === 'rejected' && (input.rejectedReason ?? '').trim().length === 0) {
      return { outcome: 'invalid' as const, error: 'rejecting a vehicle states why' };
    }

    if (input.status === 'selected') {
      // One car is bought. Standing the previous choice down keeps the index a
      // guarantee rather than an obstacle.
      // EXCLUDING THE ROW BEING SELECTED. Without that exclusion, choosing the
      // car that is ALREADY chosen stands it down, advances its version, and
      // the update below then loses to its own side effect — so a salesperson
      // double-clicking "this is the one" is told the record changed under them
      // by the very click they just made.
      await tx.query(
        `UPDATE opportunity_vehicles
            SET status = 'considering', updated_by_user_link_id = $3, updated_at = NOW(),
                authorization_version = authorization_version + 1
          WHERE tenant_id = $1 AND opportunity_id = $2 AND status = 'selected'
            AND opportunity_vehicle_id <> $4`,
        [input.tenantId, input.opportunityId, actor, input.opportunityVehicleId],
      );
    }

    const written = await tx.query(
      `UPDATE opportunity_vehicles
          SET status = $3,
              rejected_reason = CASE WHEN $3 = 'rejected' THEN $4 ELSE NULL END,
              updated_by_user_link_id = $5, updated_at = NOW(),
              authorization_version = authorization_version + 1
        WHERE tenant_id = $1 AND opportunity_vehicle_id = $2 AND authorization_version = $6
        RETURNING ${VEHICLE_COLUMNS}`,
      [
        input.tenantId,
        input.opportunityVehicleId,
        input.status,
        input.rejectedReason ?? null,
        actor,
        input.expectedVersion,
      ],
    );
    if (written.rows.length === 0) {
      return { outcome: 'version_conflict' as const, currentVersion: current.authorizationVersion };
    }
    const vehicle = mapVehicle(written.rows[0] as Row);
    const mutation = await recordMutation(tx, {
      tenantId: input.tenantId,
      entityType: 'opportunity_vehicle',
      entityId: vehicle.opportunityVehicleId,
      eventType: 'sales.vehicle.status_changed',
      actingUserLinkId: actor,
      authorizationVersion: vehicle.authorizationVersion,
      details: { opportunity_id: input.opportunityId, status: input.status },
    });
    return { outcome: 'updated' as const, vehicle, mutation };
  });
}

// ── demonstrations ──────────────────────────────────────────────────────────

export type DemonstrationOutcome =
  | { outcome: 'started'; demonstration: DemonstrationView; mutation: MutationResult }
  | { outcome: 'vehicle_out'; demonstrationId: string }
  | { outcome: 'not_found' }
  | { outcome: 'invalid'; error: string };

export interface DemonstrationView {
  readonly demonstrationId: string;
  readonly opportunityId: string;
  readonly stockItemId: string;
  readonly visitId: string | null;
  readonly driverPartyId: string;
  readonly licenceVerified: boolean;
  readonly state: 'in_progress' | 'completed' | 'abandoned';
  readonly outcome: 'interested' | 'not_interested' | 'wants_alternative' | null;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly authorizationVersion: number;
}

const DEMO_COLUMNS = `demonstration_id, opportunity_id, stock_item_id, visit_id, driver_party_id,
       licence_verified, state, outcome, started_at, ended_at, authorization_version`;

function mapDemo(row: Row): DemonstrationView {
  return {
    demonstrationId: String(row.demonstration_id),
    opportunityId: String(row.opportunity_id),
    stockItemId: String(row.stock_item_id),
    visitId: row.visit_id === null ? null : String(row.visit_id),
    driverPartyId: String(row.driver_party_id),
    licenceVerified: row.licence_verified === true,
    state: String(row.state) as 'in_progress' | 'completed' | 'abandoned',
    outcome:
      row.outcome === null
        ? null
        : (String(row.outcome) as 'interested' | 'not_interested' | 'wants_alternative'),
    startedAt: new Date(row.started_at as string).toISOString(),
    endedAt: row.ended_at === null ? null : new Date(row.ended_at as string).toISOString(),
    authorizationVersion: Number(row.authorization_version),
  };
}

/**
 * STARTS A TEST DRIVE.
 *
 * THE LICENCE CHECK IS A REQUIRED FACT, not a checkbox the caller may omit. A
 * dealership that cannot show it verified a driver's licence before handing
 * over a car has, for every practical purpose, not verified it — so the service
 * refuses to start the drive rather than recording a `false` nobody reads.
 *
 * One car is out at a time; migration 064's partial unique index makes a second
 * simultaneous drive of the same vehicle unrepresentable, and the collision is
 * reported as what it is rather than as a database error.
 */
export async function startDemonstrationWithin(
  executor: Executor,
  input: {
    actingUserLinkId: string;
    tenantId: string;
    opportunityId: string;
    stockItemId: string;
    driverPartyId: string;
    licenceVerified: boolean;
    visitId?: string | null | undefined;
  },
): Promise<DemonstrationOutcome> {
  const actor = await requireActor(executor, input.actingUserLinkId);
  const open = await assertOpportunityOpen(executor, input.tenantId, input.opportunityId);
  if (!open.ok) {
    return open.reason === 'not_found'
      ? { outcome: 'not_found' }
      : { outcome: 'invalid', error: open.reason };
  }
  if (input.licenceVerified !== true) {
    return {
      outcome: 'invalid',
      error: 'a test drive starts after the driver’s licence has been checked',
    };
  }

  const stock = await executor.query(
    `SELECT rooftop_id FROM stock_items WHERE tenant_id = $1 AND stock_item_id = $2`,
    [input.tenantId, input.stockItemId],
  );
  if (stock.rows.length === 0) return { outcome: 'not_found' };
  if (String((stock.rows[0] as Row).rooftop_id) !== open.opportunity.rooftopId) {
    return { outcome: 'invalid', error: 'that vehicle is at a different rooftop' };
  }

  // ONE CAR, ONE SET OF KEYS — SERIALIZED ON THE CAR ITSELF.
  //
  // `uq_demonstrations_vehicle_out` already makes two simultaneous drives
  // IMPOSSIBLE, but a unique violation reaches the caller as a 500, which reads
  // as "the platform broke" rather than "somebody has that car". Taking a
  // transaction-scoped advisory lock on the stock item first means the second
  // salesperson WAITS for the first to commit and then reads the drive that
  // beat them, so the refusal names where the car actually is. The lock is on
  // the tenant and stock item together, so two dealerships never queue behind
  // each other.
  await executor.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
    `sales.demonstration:${input.tenantId}:${input.stockItemId}`,
  ]);

  const out = await executor.query(
    `SELECT demonstration_id FROM demonstrations
      WHERE tenant_id = $1 AND stock_item_id = $2 AND state = 'in_progress'`,
    [input.tenantId, input.stockItemId],
  );
  if (out.rows.length > 0) {
    return {
      outcome: 'vehicle_out',
      demonstrationId: String((out.rows[0] as Row).demonstration_id),
    };
  }

  const written = await executor.query(
    `INSERT INTO demonstrations
       (tenant_id, rooftop_id, opportunity_id, stock_item_id, visit_id, driver_party_id,
        accompanied_by_user_link_id, licence_verified,
        created_by_user_link_id, updated_by_user_link_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, true, $7, $7)
     RETURNING ${DEMO_COLUMNS}`,
    [
      input.tenantId,
      open.opportunity.rooftopId,
      input.opportunityId,
      input.stockItemId,
      input.visitId ?? null,
      input.driverPartyId,
      actor,
    ],
  );
  const demonstration = mapDemo(written.rows[0] as Row);
  if (input.visitId != null) {
    await executor.query(
      `INSERT INTO visit_events (tenant_id, visit_id, event_type, actor_user_link_id)
       VALUES ($1, $2, 'demonstration_started', $3)`,
      [input.tenantId, input.visitId, actor],
    );
  }
  const mutation = await recordMutation(executor, {
    tenantId: input.tenantId,
    entityType: 'demonstration',
    entityId: demonstration.demonstrationId,
    eventType: 'sales.demonstration.started',
    actingUserLinkId: actor,
    authorizationVersion: demonstration.authorizationVersion,
    details: { opportunity_id: input.opportunityId, stock_item_id: input.stockItemId },
  });
  return { outcome: 'started', demonstration, mutation };
}

export async function startDemonstration(input: {
  actingUserLinkId: string;
  tenantId: string;
  opportunityId: string;
  stockItemId: string;
  driverPartyId: string;
  licenceVerified: boolean;
  visitId?: string | null | undefined;
}): Promise<DemonstrationOutcome> {
  return withTenantTransaction(input.tenantId, (tx) => startDemonstrationWithin(tx, input));
}

export type DemonstrationVerdict = 'interested' | 'not_interested' | 'wants_alternative';

export type DemonstrationEndOutcome =
  | { outcome: 'ended'; demonstration: DemonstrationView; mutation: MutationResult }
  | { outcome: 'version_conflict'; currentVersion: number }
  | { outcome: 'not_found' }
  | { outcome: 'invalid'; error: string };

/**
 * Ends a drive. A completed one carries what the customer thought; an abandoned
 * one deliberately does not, because nobody found out — and recording a guess
 * there would put an opinion the customer never expressed into the record a
 * salesperson is judged on.
 */
/** What a customer can come back from a test drive thinking. */
export const DEMONSTRATION_VERDICTS: readonly DemonstrationVerdict[] = [
  'interested',
  'not_interested',
  'wants_alternative',
];

export async function endDemonstration(input: {
  actingUserLinkId: string;
  tenantId: string;
  opportunityId: string;
  demonstrationId: string;
  expectedVersion: number;
  state: 'completed' | 'abandoned';
  outcome?: DemonstrationVerdict | null | undefined;
  notes?: string | null | undefined;
}): Promise<DemonstrationEndOutcome> {
  return withTenantTransaction(input.tenantId, async (tx) => {
    const actor = await requireActor(tx, input.actingUserLinkId);
    const existing = await tx.query(
      `SELECT ${DEMO_COLUMNS}, visit_id FROM demonstrations
        WHERE tenant_id = $1 AND demonstration_id = $2 FOR UPDATE`,
      [input.tenantId, input.demonstrationId],
    );
    if (existing.rows.length === 0) return { outcome: 'not_found' as const };
    const current = mapDemo(existing.rows[0] as Row);
    if (current.opportunityId !== input.opportunityId) return { outcome: 'not_found' as const };
    if (current.state !== 'in_progress') {
      return { outcome: 'invalid' as const, error: `that drive already ${current.state}` };
    }
    if (current.authorizationVersion !== input.expectedVersion) {
      return { outcome: 'version_conflict' as const, currentVersion: current.authorizationVersion };
    }
    const verdict = input.outcome ?? null;
    // THE VOCABULARY IS THE SERVICE'S TO ENFORCE. Letting an unknown verdict
    // travel to the CHECK constraint turns a caller's typo into a 500, which
    // tells them nothing and looks like the platform broke.
    if (verdict !== null && !DEMONSTRATION_VERDICTS.includes(verdict)) {
      return {
        outcome: 'invalid' as const,
        error: `a drive ends ${DEMONSTRATION_VERDICTS.join(', ')} — not ${verdict}`,
      };
    }
    if (input.state !== 'completed' && input.state !== 'abandoned') {
      return { outcome: 'invalid' as const, error: `a drive ends completed or abandoned` };
    }
    if (input.state === 'completed' && verdict === null) {
      return { outcome: 'invalid' as const, error: 'a finished drive records what they thought' };
    }
    if (input.state === 'abandoned' && verdict !== null) {
      return {
        outcome: 'invalid' as const,
        error: 'an abandoned drive records no verdict, because nobody found out',
      };
    }

    const written = await tx.query(
      `UPDATE demonstrations
          SET state = $3, outcome = $4, ended_at = NOW(), notes = $5,
              updated_by_user_link_id = $6, updated_at = NOW(),
              authorization_version = authorization_version + 1
        WHERE tenant_id = $1 AND demonstration_id = $2 AND authorization_version = $7
        RETURNING ${DEMO_COLUMNS}`,
      [
        input.tenantId,
        input.demonstrationId,
        input.state,
        verdict,
        input.notes ?? null,
        actor,
        input.expectedVersion,
      ],
    );
    if (written.rows.length === 0) {
      return { outcome: 'version_conflict' as const, currentVersion: current.authorizationVersion };
    }
    const demonstration = mapDemo(written.rows[0] as Row);
    if (current.visitId !== null) {
      await tx.query(
        `INSERT INTO visit_events (tenant_id, visit_id, event_type, actor_user_link_id)
         VALUES ($1, $2, 'demonstration_ended', $3)`,
        [input.tenantId, current.visitId, actor],
      );
    }
    // The car was driven, so the shortlist says so.
    await tx.query(
      `UPDATE opportunity_vehicles
          SET status = 'demonstrated', updated_by_user_link_id = $4, updated_at = NOW(),
              authorization_version = authorization_version + 1
        WHERE tenant_id = $1 AND opportunity_id = $2 AND stock_item_id = $3
          AND status = 'considering'`,
      [input.tenantId, input.opportunityId, current.stockItemId, actor],
    );
    const mutation = await recordMutation(tx, {
      tenantId: input.tenantId,
      entityType: 'demonstration',
      entityId: demonstration.demonstrationId,
      eventType: 'sales.demonstration.ended',
      actingUserLinkId: actor,
      authorizationVersion: demonstration.authorizationVersion,
      details: { opportunity_id: input.opportunityId, state: input.state, outcome: verdict },
    });
    return { outcome: 'ended' as const, demonstration, mutation };
  });
}

// ── the sales-side timeline ─────────────────────────────────────────────────

export type SalesActivityKind = 'note' | 'call' | 'email' | 'sms' | 'task' | 'appointment_followup';

export const SALES_ACTIVITY_KINDS: readonly SalesActivityKind[] = [
  'note',
  'call',
  'email',
  'sms',
  'task',
  'appointment_followup',
];

export const NEGOTIATION_OUTCOMES = ['countered', 'accepted', 'declined', 'adjourned'] as const;

export type TurnoverReason =
  'price_authority' | 'customer_request' | 'second_voice' | 'escalation' | 'closing';

export const TURNOVER_REASONS: readonly TurnoverReason[] = [
  'price_authority',
  'customer_request',
  'second_voice',
  'escalation',
  'closing',
];

export interface SalesActivityView {
  readonly activityId: string;
  readonly opportunityId: string;
  readonly kind: SalesActivityKind;
  readonly direction: 'inbound' | 'outbound' | null;
  readonly subject: string;
  readonly state: 'open' | 'completed' | 'cancelled';
  readonly dueAt: string | null;
  readonly authorizationVersion: number;
}

const ACTIVITY_COLUMNS = `activity_id, opportunity_id, kind, direction, subject, state, due_at,
       authorization_version`;

function mapActivity(row: Row): SalesActivityView {
  return {
    activityId: String(row.activity_id),
    opportunityId: String(row.opportunity_id),
    kind: String(row.kind) as SalesActivityKind,
    direction: row.direction === null ? null : (String(row.direction) as 'inbound' | 'outbound'),
    subject: String(row.subject),
    state: String(row.state) as 'open' | 'completed' | 'cancelled',
    dueAt: row.due_at === null ? null : new Date(row.due_at as string).toISOString(),
    authorizationVersion: Number(row.authorization_version),
  };
}

export type SalesActivityOutcome =
  | { outcome: 'logged'; activity: SalesActivityView; mutation: MutationResult }
  | { outcome: 'not_found' }
  | { outcome: 'invalid'; error: string };

export async function logSalesActivityWithin(
  executor: Executor,
  input: {
    actingUserLinkId: string;
    tenantId: string;
    opportunityId: string;
    kind: SalesActivityKind;
    direction?: 'inbound' | 'outbound' | null | undefined;
    subject: string;
    body?: string | null | undefined;
    dueAt?: string | null | undefined;
  },
): Promise<SalesActivityOutcome> {
  const subject = (input.subject ?? '').trim();
  if (subject.length === 0 || subject.length > 200) {
    return { outcome: 'invalid', error: 'an activity needs a subject' };
  }
  if (!SALES_ACTIVITY_KINDS.includes(input.kind)) {
    return {
      outcome: 'invalid',
      error: `an activity is ${SALES_ACTIVITY_KINDS.join(', ')} — not ${input.kind}`,
    };
  }
  const isCommunication = ['call', 'email', 'sms'].includes(input.kind);
  const direction = input.direction ?? null;
  if (direction !== null && direction !== 'inbound' && direction !== 'outbound') {
    return {
      outcome: 'invalid',
      error: `a communication is inbound or outbound — not ${direction}`,
    };
  }
  if (isCommunication && direction === null) {
    return { outcome: 'invalid', error: 'a communication is inbound or outbound' };
  }
  if (!isCommunication && direction !== null) {
    return { outcome: 'invalid', error: `a ${input.kind} has no direction` };
  }
  const dueAt = input.dueAt ?? null;
  if (dueAt !== null && !['task', 'appointment_followup'].includes(input.kind)) {
    return { outcome: 'invalid', error: `a ${input.kind} cannot be due` };
  }

  const actor = await requireActor(executor, input.actingUserLinkId);
  const open = await assertOpportunityOpen(executor, input.tenantId, input.opportunityId);
  if (!open.ok) {
    return open.reason === 'not_found'
      ? { outcome: 'not_found' }
      : { outcome: 'invalid', error: open.reason };
  }

  const written = await executor.query(
    `INSERT INTO opportunity_activities
       (tenant_id, opportunity_id, kind, direction, subject, body, due_at,
        created_by_user_link_id, updated_by_user_link_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
     RETURNING ${ACTIVITY_COLUMNS}`,
    [
      input.tenantId,
      input.opportunityId,
      input.kind,
      direction,
      subject,
      input.body ?? null,
      dueAt,
      actor,
    ],
  );
  const activity = mapActivity(written.rows[0] as Row);
  const mutation = await recordMutation(executor, {
    tenantId: input.tenantId,
    entityType: 'opportunity_activity',
    entityId: activity.activityId,
    eventType: 'sales.activity.logged',
    actingUserLinkId: actor,
    authorizationVersion: activity.authorizationVersion,
    details: { opportunity_id: input.opportunityId, kind: input.kind, direction },
  });
  return { outcome: 'logged', activity, mutation };
}

export async function logSalesActivity(input: {
  actingUserLinkId: string;
  tenantId: string;
  opportunityId: string;
  kind: SalesActivityKind;
  direction?: 'inbound' | 'outbound' | null | undefined;
  subject: string;
  body?: string | null | undefined;
  dueAt?: string | null | undefined;
}): Promise<SalesActivityOutcome> {
  return withTenantTransaction(input.tenantId, (tx) => logSalesActivityWithin(tx, input));
}

// ── negotiation and manager oversight ───────────────────────────────────────

export interface NegotiationRoundView {
  readonly roundId: string;
  readonly opportunityId: string;
  readonly roundNumber: number;
  readonly initiatedBy: 'customer' | 'dealership';
  readonly summary: string;
  readonly managerInvolved: boolean;
  readonly outcome: 'countered' | 'accepted' | 'declined' | 'adjourned';
  readonly pricingStatus: 'NOT_YET_AVAILABLE' | 'AVAILABLE';
  readonly occurredAt: string;
}

export type NegotiationOutcome =
  | { outcome: 'recorded'; round: NegotiationRoundView; mutation: MutationResult }
  | { outcome: 'not_found' }
  | { outcome: 'invalid'; error: string };

/**
 * RECORDS A ROUND OF NEGOTIATION — the fact of it, not the figures.
 *
 * The round number is assigned under a lock on the opportunity, so two people
 * writing up the same conversation produce rounds 3 and 4 rather than colliding
 * on 3. `pricingStatus` is returned rather than omitted: a screen that showed a
 * negotiation with no money on it would invite a reader to assume the price was
 * zero, and saying NOT_YET_AVAILABLE is the honest alternative until FBL-120
 * exists.
 */
export async function recordNegotiationRound(input: {
  actingUserLinkId: string;
  tenantId: string;
  opportunityId: string;
  initiatedBy: 'customer' | 'dealership';
  summary: string;
  managerInvolved?: boolean | undefined;
  outcome: (typeof NEGOTIATION_OUTCOMES)[number];
}): Promise<NegotiationOutcome> {
  const summary = (input.summary ?? '').trim();
  if (summary.length === 0 || summary.length > 1000) {
    return { outcome: 'invalid', error: 'a negotiation round records what was discussed' };
  }
  if (input.initiatedBy !== 'customer' && input.initiatedBy !== 'dealership') {
    return {
      outcome: 'invalid',
      error: `a negotiation is started by the customer or the dealership — not ${input.initiatedBy}`,
    };
  }
  if (!NEGOTIATION_OUTCOMES.includes(input.outcome)) {
    return {
      outcome: 'invalid',
      error: `a round ends ${NEGOTIATION_OUTCOMES.join(', ')} — not ${input.outcome}`,
    };
  }
  return withTenantTransaction(input.tenantId, async (tx) => {
    const actor = await requireActor(tx, input.actingUserLinkId);
    // The lock that makes the sequence a sequence.
    const locked = await tx.query(
      `SELECT stage FROM opportunities
        WHERE tenant_id = $1 AND opportunity_id = $2 FOR UPDATE`,
      [input.tenantId, input.opportunityId],
    );
    if (locked.rows.length === 0) return { outcome: 'not_found' as const };
    const stage = String((locked.rows[0] as Row).stage);
    if (stage === 'won' || stage === 'lost') {
      return { outcome: 'invalid' as const, error: `a ${stage} opportunity takes no further work` };
    }

    const written = await tx.query(
      `INSERT INTO negotiation_rounds
         (tenant_id, opportunity_id, round_number, initiated_by, summary, manager_involved,
          outcome, recorded_by_user_link_id)
       VALUES ($1, $2,
               COALESCE((SELECT MAX(round_number) + 1 FROM negotiation_rounds
                          WHERE tenant_id = $1 AND opportunity_id = $2), 1),
               $3, $4, $5, $6, $7)
       RETURNING round_id, opportunity_id, round_number, initiated_by, summary,
                 manager_involved, outcome, pricing_status, occurred_at`,
      [
        input.tenantId,
        input.opportunityId,
        input.initiatedBy,
        summary,
        input.managerInvolved ?? false,
        input.outcome,
        actor,
      ],
    );
    const raw = written.rows[0] as Row;
    const round: NegotiationRoundView = {
      roundId: String(raw.round_id),
      opportunityId: String(raw.opportunity_id),
      roundNumber: Number(raw.round_number),
      initiatedBy: String(raw.initiated_by) as 'customer' | 'dealership',
      summary: String(raw.summary),
      managerInvolved: raw.manager_involved === true,
      outcome: String(raw.outcome) as 'countered' | 'accepted' | 'declined' | 'adjourned',
      pricingStatus: String(raw.pricing_status) as 'NOT_YET_AVAILABLE' | 'AVAILABLE',
      occurredAt: new Date(raw.occurred_at as string).toISOString(),
    };
    const mutation = await recordMutation(tx, {
      tenantId: input.tenantId,
      entityType: 'opportunity',
      entityId: input.opportunityId,
      eventType: 'sales.negotiation.round_recorded',
      actingUserLinkId: actor,
      authorizationVersion: round.roundNumber,
      details: {
        round_number: round.roundNumber,
        initiated_by: round.initiatedBy,
        outcome: round.outcome,
        pricing_status: round.pricingStatus,
      },
    });
    return { outcome: 'recorded' as const, round, mutation };
  });
}

export type TurnoverOutcome =
  | { outcome: 'recorded'; turnoverId: string; mutation: MutationResult }
  | { outcome: 'not_found' }
  | { outcome: 'invalid'; error: string };

/**
 * THE DESK LOG. A salesperson brings a manager in; the record is append-only,
 * because it is the evidence oversight is judged on.
 *
 * The manager must be able to reach the rooftop, and cannot be the person who
 * asked — a turnover to yourself is not oversight.
 */
export async function recordTurnover(input: {
  actingUserLinkId: string;
  tenantId: string;
  opportunityId: string;
  managerUserLinkId: string;
  reason: TurnoverReason;
  visitId?: string | null | undefined;
  note?: string | null | undefined;
}): Promise<TurnoverOutcome> {
  return withTenantTransaction(input.tenantId, async (tx) => {
    const actor = await requireActor(tx, input.actingUserLinkId);
    const open = await assertOpportunityOpen(tx, input.tenantId, input.opportunityId);
    if (!open.ok) {
      return open.reason === 'not_found'
        ? { outcome: 'not_found' as const }
        : { outcome: 'invalid' as const, error: open.reason };
    }
    if (!TURNOVER_REASONS.includes(input.reason)) {
      return {
        outcome: 'invalid' as const,
        error: `a turnover is ${TURNOVER_REASONS.join(', ')} — not ${input.reason}`,
      };
    }
    if (input.managerUserLinkId === actor) {
      return { outcome: 'invalid' as const, error: 'a turnover to yourself is not oversight' };
    }
    const reach = await permittedRooftopIds(input.tenantId, input.managerUserLinkId);
    if (!reach.includes(open.opportunity.rooftopId)) {
      return { outcome: 'invalid' as const, error: 'that manager does not work this rooftop' };
    }

    const written = await tx.query(
      `INSERT INTO manager_turnovers
         (tenant_id, opportunity_id, visit_id, requested_by_user_link_id, manager_user_link_id,
          reason, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING turnover_id`,
      [
        input.tenantId,
        input.opportunityId,
        input.visitId ?? null,
        actor,
        input.managerUserLinkId,
        input.reason,
        input.note ?? null,
      ],
    );
    const turnoverId = String((written.rows[0] as Row).turnover_id);
    if (input.visitId != null) {
      await tx.query(
        `INSERT INTO visit_events (tenant_id, visit_id, event_type, actor_user_link_id)
         VALUES ($1, $2, 'turned_over', $3)`,
        [input.tenantId, input.visitId, actor],
      );
    }
    const mutation = await recordMutation(tx, {
      tenantId: input.tenantId,
      entityType: 'opportunity',
      entityId: input.opportunityId,
      eventType: 'sales.turnover.recorded',
      actingUserLinkId: actor,
      authorizationVersion: open.opportunity.authorizationVersion,
      details: { manager_user_link_id: input.managerUserLinkId, reason: input.reason },
    });
    return { outcome: 'recorded' as const, turnoverId, mutation };
  });
}
