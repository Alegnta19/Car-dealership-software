/**
 * RELEASE TRAIN 4 — CHOOSING A CAR, DRIVING IT, AND WHAT IS OWED NEXT.
 *
 * THE SHORTLIST KEEPS ITS HISTORY. `opportunity_vehicles.status` is the current
 * answer and it is corrected in place; `opportunity_vehicle_events` is the
 * sequence, append-only, because a customer who selected one car, drove another
 * and came back to the first leaves a single row reading `selected` and the
 * story that a second-choice car won is otherwise gone.
 *
 * A TEST DRIVE HAS FIVE FACTS, NOT TWO. Issued is the keys leaving the cabinet;
 * started is the car leaving the lot; returned is it back with an answer;
 * cancelled is it never went; exception is the one nobody wants to model and
 * every dealership eventually needs — damage, an accident, a car that is not
 * back. The gap between issued and started is where a licence is photocopied,
 * and a dealership asked "where is that car" needs the difference.
 *
 * THE REFUSALS DO NOT LEAK. A car at another rooftop is NOT FOUND, in the same
 * words as a car that does not exist, because "that vehicle is at Northside" is
 * a fact about another store's inventory that this caller has no authority to
 * learn. A collision says the vehicle is unavailable and names NO demonstration
 * — the id of somebody else's drive is somebody else's record.
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

async function reaches(tenantId: string, userLinkId: string, rooftopId: string): Promise<boolean> {
  const permitted = await permittedRooftopIds(tenantId, userLinkId);
  return permitted.includes(rooftopId);
}

// ── the shortlist ───────────────────────────────────────────────────────────

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

/** One append-only line of the shortlist's story. */
async function recordVehicleEvent(
  executor: Executor,
  input: {
    tenantId: string;
    opportunityId: string;
    opportunityVehicleId: string;
    stockItemId: string;
    eventType:
      | 'shortlisted'
      | 'considering'
      | 'demonstrated'
      | 'rejected'
      | 'selected'
      | 'stood_down'
      | 'removed';
    fromStatus?: string | null | undefined;
    toStatus?: string | null | undefined;
    reason?: string | null | undefined;
    actor: string;
  },
): Promise<void> {
  await executor.query(
    `INSERT INTO opportunity_vehicle_events
       (tenant_id, opportunity_id, opportunity_vehicle_id, stock_item_id, event_type,
        from_status, to_status, reason, actor_user_link_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      input.tenantId,
      input.opportunityId,
      input.opportunityVehicleId,
      input.stockItemId,
      input.eventType,
      input.fromStatus ?? null,
      input.toStatus ?? null,
      input.reason ?? null,
      input.actor,
    ],
  );
}

export type ShortlistOutcome =
  | { outcome: 'added'; vehicle: OpportunityVehicleView; mutation: MutationResult }
  | { outcome: 'already_shortlisted'; vehicle: OpportunityVehicleView }
  | { outcome: 'not_found' }
  | { outcome: 'invalid'; error: string };

/**
 * Puts a car on the shortlist. It must be REAL STOCK at the opportunity's own
 * rooftop, and a car anywhere else is NOT FOUND rather than described.
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

  const existing = await executor.query(
    `SELECT ${VEHICLE_COLUMNS} FROM opportunity_vehicles
      WHERE tenant_id = $1 AND opportunity_id = $2 AND stock_item_id = $3`,
    [input.tenantId, input.opportunityId, input.stockItemId],
  );
  if (existing.rows.length > 0) {
    return { outcome: 'already_shortlisted', vehicle: mapVehicle(existing.rows[0] as Row) };
  }

  // FOREIGN INVENTORY IS NOT FOUND, in the same words as inventory that does not
  // exist. Saying "that car is at another rooftop" tells the caller another
  // store's stock number is real.
  const stock = await executor.query(
    `SELECT rooftop_id, lifecycle_state FROM stock_items
      WHERE tenant_id = $1 AND stock_item_id = $2`,
    [input.tenantId, input.stockItemId],
  );
  if (stock.rows.length === 0) return { outcome: 'not_found' };
  const row = stock.rows[0] as Row;
  if (String(row.rooftop_id) !== open.opportunity.rooftopId) return { outcome: 'not_found' };
  if (String(row.lifecycle_state) === 'retired') {
    return { outcome: 'invalid', error: 'that vehicle is no longer in stock' };
  }

  const written = await executor.query(
    `INSERT INTO opportunity_vehicles
       (tenant_id, opportunity_id, stock_item_id, rank,
        created_by_user_link_id, updated_by_user_link_id)
     VALUES ($1, $2, $3,
             COALESCE($4, (SELECT COUNT(*) + 1 FROM opportunity_vehicles
                            WHERE tenant_id = $1 AND opportunity_id = $2)),
             $5, $5)
     RETURNING ${VEHICLE_COLUMNS}`,
    [input.tenantId, input.opportunityId, input.stockItemId, input.rank ?? null, actor],
  );
  const vehicle = mapVehicle(written.rows[0] as Row);
  await recordVehicleEvent(executor, {
    tenantId: input.tenantId,
    opportunityId: input.opportunityId,
    opportunityVehicleId: vehicle.opportunityVehicleId,
    stockItemId: vehicle.stockItemId,
    eventType: 'shortlisted',
    toStatus: vehicle.status,
    actor,
  });
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
  | { outcome: 'already_there'; vehicle: OpportunityVehicleView }
  | { outcome: 'version_conflict'; currentVersion: number }
  | { outcome: 'not_found' }
  | { outcome: 'invalid'; error: string };

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
    if (current.status === input.status) {
      return { outcome: 'already_there' as const, vehicle: current };
    }
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
      // guarantee rather than an obstacle — EXCLUDING the row being selected, so
      // choosing the car that is already chosen cannot lose to its own side
      // effect. Each stand-down is a line of the shortlist's history.
      const standDown = await tx.query(
        `UPDATE opportunity_vehicles
            SET status = 'considering', updated_by_user_link_id = $3, updated_at = NOW(),
                authorization_version = authorization_version + 1
          WHERE tenant_id = $1 AND opportunity_id = $2 AND status = 'selected'
            AND opportunity_vehicle_id <> $4
          RETURNING opportunity_vehicle_id, stock_item_id`,
        [input.tenantId, input.opportunityId, actor, input.opportunityVehicleId],
      );
      for (const stood of standDown.rows as Row[]) {
        await recordVehicleEvent(tx, {
          tenantId: input.tenantId,
          opportunityId: input.opportunityId,
          opportunityVehicleId: String(stood.opportunity_vehicle_id),
          stockItemId: String(stood.stock_item_id),
          eventType: 'stood_down',
          fromStatus: 'selected',
          toStatus: 'considering',
          reason: 'the customer chose a different car',
          actor,
        });
      }
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
    await recordVehicleEvent(tx, {
      tenantId: input.tenantId,
      opportunityId: input.opportunityId,
      opportunityVehicleId: vehicle.opportunityVehicleId,
      stockItemId: vehicle.stockItemId,
      eventType: input.status,
      fromStatus: current.status,
      toStatus: input.status,
      reason: input.rejectedReason ?? null,
      actor,
    });
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

export type DemonstrationState = 'issued' | 'in_progress' | 'returned' | 'cancelled' | 'exception';

/** A demonstration is ACTIVE while the keys are out, whatever the odometer says. */
export const ACTIVE_DEMONSTRATION_STATES: readonly DemonstrationState[] = ['issued', 'in_progress'];

export type DemonstrationVerdict = 'interested' | 'not_interested' | 'wants_alternative';

/** What a customer can come back from a test drive thinking. */
export const DEMONSTRATION_VERDICTS: readonly DemonstrationVerdict[] = [
  'interested',
  'not_interested',
  'wants_alternative',
];

export type DemonstrationExceptionKind =
  'damage' | 'accident' | 'not_returned' | 'breakdown' | 'other';

export const DEMONSTRATION_EXCEPTION_KINDS: readonly DemonstrationExceptionKind[] = [
  'damage',
  'accident',
  'not_returned',
  'breakdown',
  'other',
];

export interface DemonstrationView {
  readonly demonstrationId: string;
  readonly rooftopId: string;
  readonly opportunityId: string;
  readonly stockItemId: string;
  readonly visitId: string | null;
  readonly driverPartyId: string;
  readonly accompaniedByUserLinkId: string;
  readonly licenceVerified: boolean;
  readonly state: DemonstrationState;
  readonly outcome: DemonstrationVerdict | null;
  readonly exceptionKind: DemonstrationExceptionKind | null;
  readonly issuedAt: string;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly authorizationVersion: number;
}

const DEMO_COLUMNS = `demonstration_id, rooftop_id, opportunity_id, stock_item_id, visit_id,
       driver_party_id, accompanied_by_user_link_id, licence_verified, state, outcome,
       exception_kind, issued_at, started_at, ended_at, authorization_version`;

function mapDemo(row: Row): DemonstrationView {
  const iso = (v: unknown): string | null =>
    v === null || v === undefined ? null : new Date(v as string).toISOString();
  return {
    demonstrationId: String(row.demonstration_id),
    rooftopId: String(row.rooftop_id),
    opportunityId: String(row.opportunity_id),
    stockItemId: String(row.stock_item_id),
    visitId: row.visit_id === null ? null : String(row.visit_id),
    driverPartyId: String(row.driver_party_id),
    accompaniedByUserLinkId: String(row.accompanied_by_user_link_id),
    licenceVerified: row.licence_verified === true,
    state: String(row.state) as DemonstrationState,
    outcome: row.outcome === null ? null : (String(row.outcome) as DemonstrationVerdict),
    exceptionKind:
      row.exception_kind === null
        ? null
        : (String(row.exception_kind) as DemonstrationExceptionKind),
    issuedAt: new Date(row.issued_at as string).toISOString(),
    startedAt: iso(row.started_at),
    endedAt: iso(row.ended_at),
    authorizationVersion: Number(row.authorization_version),
  };
}

async function recordDemoEvent(
  executor: Executor,
  input: {
    tenantId: string;
    demonstrationId: string;
    eventType: 'issued' | 'started' | 'returned' | 'cancelled' | 'exception';
    outcome?: string | null | undefined;
    exceptionKind?: string | null | undefined;
    note?: string | null | undefined;
    actor: string;
  },
): Promise<void> {
  await executor.query(
    `INSERT INTO demonstration_events
       (tenant_id, demonstration_id, event_type, outcome, exception_kind, note,
        actor_user_link_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      input.tenantId,
      input.demonstrationId,
      input.eventType,
      input.outcome ?? null,
      input.exceptionKind ?? null,
      input.note ?? null,
      input.actor,
    ],
  );
}

export type DemonstrationIssueOutcome =
  | { outcome: 'issued'; demonstration: DemonstrationView; mutation: MutationResult }
  | {
      /**
       * NEUTRAL AND ID-FREE. The caller learns the thing they asked for is not
       * available and WHICH of their own inputs caused it — never the identifier
       * of the demonstration, customer or employee that holds it.
       */
      outcome: 'unavailable';
      conflict: 'vehicle' | 'driver' | 'escort';
    }
  | { outcome: 'not_found' }
  | { outcome: 'invalid'; error: string };

/** The advisory-lock key an issue serializes on. Derived, never supplied. */
function issueKey(tenantId: string, stockItemId: string): string {
  return `sales.demonstration:${tenantId}:${stockItemId}`;
}

/**
 * ISSUES A CAR FOR A TEST DRIVE — keys out, licence checked, not yet moving.
 *
 * ── the three incompatible combinations ────────────────────────────────────
 *
 * Each is one PHYSICAL thing that can be in one place at a time, and each is
 * checked here so the caller gets a sentence and enforced by a partial unique
 * index so it is true for callers that never came through here:
 *
 *   1. THE CAR — one stock item, one active demonstration.
 *   2. THE DRIVER — one person cannot be driving two cars.
 *   3. THE SALESPERSON RIDING ALONG — one employee cannot accompany two drives.
 *
 * ── the lock, and why the index is not enough on its own ───────────────────
 *
 * The index makes two simultaneous issues IMPOSSIBLE, but a unique violation
 * reaches the caller as a 500 — which reads as "the platform broke" rather than
 * "somebody has that car". Serializing on the vehicle means the second caller
 * WAITS and then reads the truth.
 */
export async function issueDemonstrationWithin(
  executor: Executor,
  input: {
    actingUserLinkId: string;
    tenantId: string;
    opportunityId: string;
    stockItemId: string;
    driverPartyId: string;
    licenceVerified: boolean;
    accompaniedByUserLinkId?: string | null | undefined;
    visitId?: string | null | undefined;
  },
): Promise<DemonstrationIssueOutcome> {
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

  const escort = input.accompaniedByUserLinkId ?? actor;
  if (!(await reaches(input.tenantId, escort, open.opportunity.rooftopId))) {
    return { outcome: 'invalid', error: 'that employee does not work this rooftop' };
  }

  const stock = await executor.query(
    `SELECT rooftop_id, lifecycle_state FROM stock_items
      WHERE tenant_id = $1 AND stock_item_id = $2`,
    [input.tenantId, input.stockItemId],
  );
  if (stock.rows.length === 0) return { outcome: 'not_found' };
  const stockRow = stock.rows[0] as Row;
  // FOREIGN INVENTORY IS NOT FOUND. No rooftop is named back.
  if (String(stockRow.rooftop_id) !== open.opportunity.rooftopId) return { outcome: 'not_found' };
  if (String(stockRow.lifecycle_state) === 'retired') {
    return { outcome: 'invalid', error: 'that vehicle is no longer in stock' };
  }

  await executor.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
    issueKey(input.tenantId, input.stockItemId),
  ]);

  // The three collision checks, in the order a person would notice them.
  const carOut = await executor.query(
    `SELECT 1 FROM demonstrations
      WHERE tenant_id = $1 AND stock_item_id = $2 AND state IN ('issued', 'in_progress')
      LIMIT 1`,
    [input.tenantId, input.stockItemId],
  );
  if (carOut.rows.length > 0) return { outcome: 'unavailable', conflict: 'vehicle' };

  const driverOut = await executor.query(
    `SELECT 1 FROM demonstrations
      WHERE tenant_id = $1 AND driver_party_id = $2 AND state IN ('issued', 'in_progress')
      LIMIT 1`,
    [input.tenantId, input.driverPartyId],
  );
  if (driverOut.rows.length > 0) return { outcome: 'unavailable', conflict: 'driver' };

  const escortOut = await executor.query(
    `SELECT 1 FROM demonstrations
      WHERE tenant_id = $1 AND accompanied_by_user_link_id = $2
        AND state IN ('issued', 'in_progress')
      LIMIT 1`,
    [input.tenantId, escort],
  );
  if (escortOut.rows.length > 0) return { outcome: 'unavailable', conflict: 'escort' };

  const written = await executor.query(
    `INSERT INTO demonstrations
       (tenant_id, rooftop_id, opportunity_id, stock_item_id, visit_id, driver_party_id,
        accompanied_by_user_link_id, licence_verified,
        created_by_user_link_id, updated_by_user_link_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8, $8)
     RETURNING ${DEMO_COLUMNS}`,
    [
      input.tenantId,
      open.opportunity.rooftopId,
      input.opportunityId,
      input.stockItemId,
      input.visitId ?? null,
      input.driverPartyId,
      escort,
      actor,
    ],
  );
  const demonstration = mapDemo(written.rows[0] as Row);
  await recordDemoEvent(executor, {
    tenantId: input.tenantId,
    demonstrationId: demonstration.demonstrationId,
    eventType: 'issued',
    note: 'keys issued, licence checked',
    actor,
  });
  if (demonstration.visitId !== null) {
    await executor.query(
      `INSERT INTO visit_events (tenant_id, visit_id, event_type, actor_user_link_id)
       VALUES ($1, $2, 'demonstration_issued', $3)`,
      [input.tenantId, demonstration.visitId, actor],
    );
  }
  const mutation = await recordMutation(executor, {
    tenantId: input.tenantId,
    entityType: 'demonstration',
    entityId: demonstration.demonstrationId,
    eventType: 'sales.demonstration.issued',
    actingUserLinkId: actor,
    authorizationVersion: demonstration.authorizationVersion,
    details: { opportunity_id: input.opportunityId, stock_item_id: input.stockItemId },
  });
  return { outcome: 'issued', demonstration, mutation };
}

export async function issueDemonstration(input: {
  actingUserLinkId: string;
  tenantId: string;
  opportunityId: string;
  stockItemId: string;
  driverPartyId: string;
  licenceVerified: boolean;
  accompaniedByUserLinkId?: string | null | undefined;
  visitId?: string | null | undefined;
}): Promise<DemonstrationIssueOutcome> {
  return withTenantTransaction(input.tenantId, (tx) => issueDemonstrationWithin(tx, input));
}

export type DemonstrationMoveOutcome =
  | { outcome: 'moved'; demonstration: DemonstrationView; mutation: MutationResult }
  | { outcome: 'already_there'; demonstration: DemonstrationView }
  | { outcome: 'version_conflict'; currentVersion: number }
  | { outcome: 'not_found' }
  | { outcome: 'invalid'; error: string };

/** Reads one demonstration THROUGH its opportunity, or answers not-found. */
async function demoThroughParent(
  executor: Executor,
  tenantId: string,
  opportunityId: string,
  demonstrationId: string,
): Promise<DemonstrationView | null> {
  const existing = await executor.query(
    `SELECT ${DEMO_COLUMNS} FROM demonstrations
      WHERE tenant_id = $1 AND demonstration_id = $2 FOR UPDATE`,
    [tenantId, demonstrationId],
  );
  if (existing.rows.length === 0) return null;
  const current = mapDemo(existing.rows[0] as Row);
  // EXACT PARENT: authorized against one opportunity, acting on its own drive.
  if (current.opportunityId !== opportunityId) return null;
  return current;
}

/** THE CAR HAS LEFT THE LOT. */
export async function startDemonstration(input: {
  actingUserLinkId: string;
  tenantId: string;
  opportunityId: string;
  demonstrationId: string;
  expectedVersion: number;
}): Promise<DemonstrationMoveOutcome> {
  return withTenantTransaction(input.tenantId, async (tx) => {
    const actor = await requireActor(tx, input.actingUserLinkId);
    const current = await demoThroughParent(
      tx,
      input.tenantId,
      input.opportunityId,
      input.demonstrationId,
    );
    if (current === null) return { outcome: 'not_found' as const };
    if (current.state === 'in_progress') {
      return { outcome: 'already_there' as const, demonstration: current };
    }
    if (current.state !== 'issued') {
      return { outcome: 'invalid' as const, error: `that drive is already ${current.state}` };
    }
    if (current.authorizationVersion !== input.expectedVersion) {
      return { outcome: 'version_conflict' as const, currentVersion: current.authorizationVersion };
    }
    const written = await tx.query(
      `UPDATE demonstrations
          SET state = 'in_progress', started_at = NOW(),
              updated_by_user_link_id = $3, updated_at = NOW(),
              authorization_version = authorization_version + 1
        WHERE tenant_id = $1 AND demonstration_id = $2 AND authorization_version = $4
        RETURNING ${DEMO_COLUMNS}`,
      [input.tenantId, input.demonstrationId, actor, input.expectedVersion],
    );
    if (written.rows.length === 0) {
      return { outcome: 'version_conflict' as const, currentVersion: current.authorizationVersion };
    }
    const demonstration = mapDemo(written.rows[0] as Row);
    await recordDemoEvent(tx, {
      tenantId: input.tenantId,
      demonstrationId: demonstration.demonstrationId,
      eventType: 'started',
      actor,
    });
    if (demonstration.visitId !== null) {
      await tx.query(
        `INSERT INTO visit_events (tenant_id, visit_id, event_type, actor_user_link_id)
         VALUES ($1, $2, 'demonstration_started', $3)`,
        [input.tenantId, demonstration.visitId, actor],
      );
    }
    const mutation = await recordMutation(tx, {
      tenantId: input.tenantId,
      entityType: 'demonstration',
      entityId: demonstration.demonstrationId,
      eventType: 'sales.demonstration.started',
      actingUserLinkId: actor,
      authorizationVersion: demonstration.authorizationVersion,
      details: { opportunity_id: input.opportunityId },
    });
    return { outcome: 'moved' as const, demonstration, mutation };
  });
}

/** THE CAR IS BACK, and the customer has a view. */
export async function returnDemonstration(input: {
  actingUserLinkId: string;
  tenantId: string;
  opportunityId: string;
  demonstrationId: string;
  expectedVersion: number;
  verdict: DemonstrationVerdict;
  notes?: string | null | undefined;
}): Promise<DemonstrationMoveOutcome> {
  return withTenantTransaction(input.tenantId, async (tx) => {
    const actor = await requireActor(tx, input.actingUserLinkId);
    const current = await demoThroughParent(
      tx,
      input.tenantId,
      input.opportunityId,
      input.demonstrationId,
    );
    if (current === null) return { outcome: 'not_found' as const };
    if (current.state === 'returned') {
      return { outcome: 'already_there' as const, demonstration: current };
    }
    if (!ACTIVE_DEMONSTRATION_STATES.includes(current.state)) {
      return { outcome: 'invalid' as const, error: `that drive is already ${current.state}` };
    }
    if (current.authorizationVersion !== input.expectedVersion) {
      return { outcome: 'version_conflict' as const, currentVersion: current.authorizationVersion };
    }
    if (!DEMONSTRATION_VERDICTS.includes(input.verdict)) {
      return {
        outcome: 'invalid' as const,
        error: `a drive ends ${DEMONSTRATION_VERDICTS.join(', ')} — not ${input.verdict}`,
      };
    }

    const written = await tx.query(
      `UPDATE demonstrations
          SET state = 'returned', outcome = $3, ended_at = NOW(), notes = $4,
              updated_by_user_link_id = $5, updated_at = NOW(),
              authorization_version = authorization_version + 1
        WHERE tenant_id = $1 AND demonstration_id = $2 AND authorization_version = $6
        RETURNING ${DEMO_COLUMNS}`,
      [
        input.tenantId,
        input.demonstrationId,
        input.verdict,
        input.notes ?? null,
        actor,
        input.expectedVersion,
      ],
    );
    if (written.rows.length === 0) {
      return { outcome: 'version_conflict' as const, currentVersion: current.authorizationVersion };
    }
    const demonstration = mapDemo(written.rows[0] as Row);
    await recordDemoEvent(tx, {
      tenantId: input.tenantId,
      demonstrationId: demonstration.demonstrationId,
      eventType: 'returned',
      outcome: input.verdict,
      note: input.notes ?? null,
      actor,
    });
    if (demonstration.visitId !== null) {
      await tx.query(
        `INSERT INTO visit_events (tenant_id, visit_id, event_type, actor_user_link_id)
         VALUES ($1, $2, 'demonstration_returned', $3)`,
        [input.tenantId, demonstration.visitId, actor],
      );
    }
    // The car was driven, so the shortlist says so — and the shortlist's own
    // history records that it was driving that changed it, not a person typing.
    const touched = await tx.query(
      `UPDATE opportunity_vehicles
          SET status = 'demonstrated', updated_by_user_link_id = $4, updated_at = NOW(),
              authorization_version = authorization_version + 1
        WHERE tenant_id = $1 AND opportunity_id = $2 AND stock_item_id = $3
          AND status = 'considering'
        RETURNING opportunity_vehicle_id`,
      [input.tenantId, input.opportunityId, demonstration.stockItemId, actor],
    );
    for (const row of touched.rows as Row[]) {
      await recordVehicleEvent(tx, {
        tenantId: input.tenantId,
        opportunityId: input.opportunityId,
        opportunityVehicleId: String(row.opportunity_vehicle_id),
        stockItemId: demonstration.stockItemId,
        eventType: 'demonstrated',
        fromStatus: 'considering',
        toStatus: 'demonstrated',
        reason: 'the customer drove it',
        actor,
      });
    }
    const mutation = await recordMutation(tx, {
      tenantId: input.tenantId,
      entityType: 'demonstration',
      entityId: demonstration.demonstrationId,
      eventType: 'sales.demonstration.returned',
      actingUserLinkId: actor,
      authorizationVersion: demonstration.authorizationVersion,
      details: { opportunity_id: input.opportunityId, outcome: input.verdict },
    });
    return { outcome: 'moved' as const, demonstration, mutation };
  });
}

/** IT NEVER WENT OUT, which is not the same as going badly. */
export async function cancelDemonstration(input: {
  actingUserLinkId: string;
  tenantId: string;
  opportunityId: string;
  demonstrationId: string;
  expectedVersion: number;
  reason: string;
}): Promise<DemonstrationMoveOutcome> {
  return withTenantTransaction(input.tenantId, async (tx) => {
    const actor = await requireActor(tx, input.actingUserLinkId);
    const current = await demoThroughParent(
      tx,
      input.tenantId,
      input.opportunityId,
      input.demonstrationId,
    );
    if (current === null) return { outcome: 'not_found' as const };
    if (current.state === 'cancelled') {
      return { outcome: 'already_there' as const, demonstration: current };
    }
    if (!ACTIVE_DEMONSTRATION_STATES.includes(current.state)) {
      return { outcome: 'invalid' as const, error: `that drive is already ${current.state}` };
    }
    if (current.authorizationVersion !== input.expectedVersion) {
      return { outcome: 'version_conflict' as const, currentVersion: current.authorizationVersion };
    }
    const reason = (input.reason ?? '').trim();
    if (reason.length === 0) {
      return { outcome: 'invalid' as const, error: 'cancelling a drive states why' };
    }

    const written = await tx.query(
      `UPDATE demonstrations
          SET state = 'cancelled', ended_at = NOW(), notes = $3,
              updated_by_user_link_id = $4, updated_at = NOW(),
              authorization_version = authorization_version + 1
        WHERE tenant_id = $1 AND demonstration_id = $2 AND authorization_version = $5
        RETURNING ${DEMO_COLUMNS}`,
      [input.tenantId, input.demonstrationId, reason, actor, input.expectedVersion],
    );
    if (written.rows.length === 0) {
      return { outcome: 'version_conflict' as const, currentVersion: current.authorizationVersion };
    }
    const demonstration = mapDemo(written.rows[0] as Row);
    await recordDemoEvent(tx, {
      tenantId: input.tenantId,
      demonstrationId: demonstration.demonstrationId,
      eventType: 'cancelled',
      note: reason,
      actor,
    });
    if (demonstration.visitId !== null) {
      await tx.query(
        `INSERT INTO visit_events (tenant_id, visit_id, event_type, note, actor_user_link_id)
         VALUES ($1, $2, 'demonstration_cancelled', $3, $4)`,
        [input.tenantId, demonstration.visitId, reason, actor],
      );
    }
    const mutation = await recordMutation(tx, {
      tenantId: input.tenantId,
      entityType: 'demonstration',
      entityId: demonstration.demonstrationId,
      eventType: 'sales.demonstration.cancelled',
      actingUserLinkId: actor,
      authorizationVersion: demonstration.authorizationVersion,
      details: { opportunity_id: input.opportunityId },
    });
    return { outcome: 'moved' as const, demonstration, mutation };
  });
}

/**
 * SOMETHING WENT WRONG WITH THE CAR.
 *
 * The fact every dealership eventually needs and no schema wants to admit:
 * damage, an accident, a breakdown, or a vehicle that is simply not back. It
 * frees the car from the active set — because the next customer must not be
 * offered it — while recording plainly that it is not a normal return, so the
 * manager's board can show it as something to act on rather than as a completed
 * drive.
 */
export async function recordDemonstrationException(input: {
  actingUserLinkId: string;
  tenantId: string;
  opportunityId: string;
  demonstrationId: string;
  expectedVersion: number;
  exceptionKind: DemonstrationExceptionKind;
  notes: string;
}): Promise<DemonstrationMoveOutcome> {
  return withTenantTransaction(input.tenantId, async (tx) => {
    const actor = await requireActor(tx, input.actingUserLinkId);
    const current = await demoThroughParent(
      tx,
      input.tenantId,
      input.opportunityId,
      input.demonstrationId,
    );
    if (current === null) return { outcome: 'not_found' as const };
    if (current.state === 'exception') {
      return { outcome: 'already_there' as const, demonstration: current };
    }
    if (!ACTIVE_DEMONSTRATION_STATES.includes(current.state)) {
      return { outcome: 'invalid' as const, error: `that drive is already ${current.state}` };
    }
    if (current.authorizationVersion !== input.expectedVersion) {
      return { outcome: 'version_conflict' as const, currentVersion: current.authorizationVersion };
    }
    if (!DEMONSTRATION_EXCEPTION_KINDS.includes(input.exceptionKind)) {
      return {
        outcome: 'invalid' as const,
        error: `an exception is ${DEMONSTRATION_EXCEPTION_KINDS.join(', ')} — not ${input.exceptionKind}`,
      };
    }
    const notes = (input.notes ?? '').trim();
    if (notes.length === 0) {
      return { outcome: 'invalid' as const, error: 'an exception says what happened' };
    }

    const written = await tx.query(
      `UPDATE demonstrations
          SET state = 'exception', exception_kind = $3, ended_at = NOW(), notes = $4,
              updated_by_user_link_id = $5, updated_at = NOW(),
              authorization_version = authorization_version + 1
        WHERE tenant_id = $1 AND demonstration_id = $2 AND authorization_version = $6
        RETURNING ${DEMO_COLUMNS}`,
      [
        input.tenantId,
        input.demonstrationId,
        input.exceptionKind,
        notes,
        actor,
        input.expectedVersion,
      ],
    );
    if (written.rows.length === 0) {
      return { outcome: 'version_conflict' as const, currentVersion: current.authorizationVersion };
    }
    const demonstration = mapDemo(written.rows[0] as Row);
    await recordDemoEvent(tx, {
      tenantId: input.tenantId,
      demonstrationId: demonstration.demonstrationId,
      eventType: 'exception',
      exceptionKind: input.exceptionKind,
      note: notes,
      actor,
    });
    if (demonstration.visitId !== null) {
      await tx.query(
        `INSERT INTO visit_events (tenant_id, visit_id, event_type, note, actor_user_link_id)
         VALUES ($1, $2, 'demonstration_exception', $3, $4)`,
        [input.tenantId, demonstration.visitId, input.exceptionKind, actor],
      );
    }
    const mutation = await recordMutation(tx, {
      tenantId: input.tenantId,
      entityType: 'demonstration',
      entityId: demonstration.demonstrationId,
      eventType: 'sales.demonstration.exception',
      actingUserLinkId: actor,
      authorizationVersion: demonstration.authorizationVersion,
      details: { opportunity_id: input.opportunityId, exception_kind: input.exceptionKind },
    });
    return { outcome: 'moved' as const, demonstration, mutation };
  });
}

// ── the sales-side timeline, and what is owed next ──────────────────────────

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
  readonly completedAt: string | null;
  readonly cancelledAt: string | null;
  readonly authorizationVersion: number;
}

const ACTIVITY_COLUMNS = `activity_id, opportunity_id, kind, direction, subject, state, due_at,
       completed_at, cancelled_at, authorization_version`;

function mapActivity(row: Row): SalesActivityView {
  const iso = (v: unknown): string | null =>
    v === null || v === undefined ? null : new Date(v as string).toISOString();
  return {
    activityId: String(row.activity_id),
    opportunityId: String(row.opportunity_id),
    kind: String(row.kind) as SalesActivityKind,
    direction: row.direction === null ? null : (String(row.direction) as 'inbound' | 'outbound'),
    subject: String(row.subject),
    state: String(row.state) as 'open' | 'completed' | 'cancelled',
    dueAt: iso(row.due_at),
    completedAt: iso(row.completed_at),
    cancelledAt: iso(row.cancelled_at),
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
  const actor = await requireActor(executor, input.actingUserLinkId);
  const open = await assertOpportunityOpen(executor, input.tenantId, input.opportunityId);
  if (!open.ok) {
    return open.reason === 'not_found'
      ? { outcome: 'not_found' }
      : { outcome: 'invalid', error: open.reason };
  }
  const subject = (input.subject ?? '').trim();
  if (subject.length === 0 || subject.length > 200) {
    return { outcome: 'invalid', error: 'an activity needs a subject of up to 200 characters' };
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

  // WHAT HAPPENED IS NOT WHAT IS OWED.
  //
  // A note, a call, an email or a text is a record of something already done,
  // and leaving it `open` would make "how many actions are outstanding" count
  // every conversation the dealership has ever had — a figure that only ever
  // grows and that nobody can act on. Only a TASK is owed, so only a task
  // starts open; the rest are logged as done at the moment they are logged.
  const owed = input.kind === 'task' || input.kind === 'appointment_followup';
  const written = await executor.query(
    `INSERT INTO opportunity_activities
       (tenant_id, opportunity_id, kind, direction, subject, body, due_at, state,
        completed_at, created_by_user_link_id, updated_by_user_link_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7,
             CASE WHEN $9::boolean THEN 'open' ELSE 'completed' END,
             CASE WHEN $9::boolean THEN NULL ELSE NOW() END,
             $8, $8)
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
      owed,
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
    details: { opportunity_id: input.opportunityId, kind: input.kind, due: dueAt !== null },
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

export type ActivityCloseOutcome =
  | { outcome: 'closed'; activity: SalesActivityView; mutation: MutationResult }
  | { outcome: 'already_closed'; activity: SalesActivityView }
  | { outcome: 'version_conflict'; currentVersion: number }
  | { outcome: 'not_found' }
  | { outcome: 'invalid'; error: string };

/**
 * THE DUE ACTION IS DONE, OR IT IS CALLED OFF.
 *
 * Both halves of what an open action needs, because a list that can only be
 * added to stops being a list of what is owed within a week. `completed` says
 * the promise was kept; `cancelled` says it no longer applies and states why —
 * which is a different fact, and a manager reading a follow-up figure needs
 * them apart.
 *
 * Addressed THROUGH the opportunity that authorizes it: an activity id under
 * somebody else's deal is NOT FOUND.
 */
export async function closeSalesActivity(input: {
  actingUserLinkId: string;
  tenantId: string;
  opportunityId: string;
  activityId: string;
  expectedVersion: number;
  state: 'completed' | 'cancelled';
  reason?: string | null | undefined;
  outcomeNote?: string | null | undefined;
}): Promise<ActivityCloseOutcome> {
  return withTenantTransaction(input.tenantId, async (tx) => {
    const actor = await requireActor(tx, input.actingUserLinkId);
    if (input.state !== 'completed' && input.state !== 'cancelled') {
      return {
        outcome: 'invalid' as const,
        error: 'an action is completed or cancelled',
      };
    }
    const existing = await tx.query(
      `SELECT ${ACTIVITY_COLUMNS} FROM opportunity_activities
        WHERE tenant_id = $1 AND activity_id = $2 FOR UPDATE`,
      [input.tenantId, input.activityId],
    );
    if (existing.rows.length === 0) return { outcome: 'not_found' as const };
    const current = mapActivity(existing.rows[0] as Row);
    if (current.opportunityId !== input.opportunityId) return { outcome: 'not_found' as const };
    if (current.state === input.state) {
      return { outcome: 'already_closed' as const, activity: current };
    }
    if (current.state !== 'open') {
      return {
        outcome: 'invalid' as const,
        error:
          current.kind === 'task' || current.kind === 'appointment_followup'
            ? `that action is already ${current.state}`
            : `a ${current.kind} is a record of what happened, not something owed`,
      };
    }
    if (current.authorizationVersion !== input.expectedVersion) {
      return { outcome: 'version_conflict' as const, currentVersion: current.authorizationVersion };
    }
    const reason = (input.reason ?? '').trim();
    if (input.state === 'cancelled' && reason.length === 0) {
      return { outcome: 'invalid' as const, error: 'cancelling an action states why' };
    }

    const written = await tx.query(
      `UPDATE opportunity_activities
          SET state = $3,
              completed_at = CASE WHEN $3 = 'completed' THEN NOW() ELSE NULL END,
              cancelled_at = CASE WHEN $3 = 'cancelled' THEN NOW() ELSE NULL END,
              cancelled_reason = CASE WHEN $3 = 'cancelled' THEN $4 ELSE NULL END,
              outcome_note = $5,
              updated_by_user_link_id = $6, updated_at = NOW(),
              authorization_version = authorization_version + 1
        WHERE tenant_id = $1 AND activity_id = $2 AND authorization_version = $7
        RETURNING ${ACTIVITY_COLUMNS}`,
      [
        input.tenantId,
        input.activityId,
        input.state,
        input.state === 'cancelled' ? reason : null,
        input.outcomeNote ?? null,
        actor,
        input.expectedVersion,
      ],
    );
    if (written.rows.length === 0) {
      return { outcome: 'version_conflict' as const, currentVersion: current.authorizationVersion };
    }
    const activity = mapActivity(written.rows[0] as Row);
    const mutation = await recordMutation(tx, {
      tenantId: input.tenantId,
      entityType: 'opportunity_activity',
      entityId: activity.activityId,
      eventType:
        input.state === 'completed' ? 'sales.activity.completed' : 'sales.activity.cancelled',
      actingUserLinkId: actor,
      authorizationVersion: activity.authorizationVersion,
      details: { opportunity_id: input.opportunityId, state: input.state },
    });
    return { outcome: 'closed' as const, activity, mutation };
  });
}

// ── negotiation and manager oversight ───────────────────────────────────────

export interface NegotiationRoundView {
  readonly roundId: string;
  readonly opportunityId: string;
  readonly roundNumber: number;
  readonly initiatedBy: 'customer' | 'dealership';
  readonly summary: string;
  readonly managerInvolved: boolean;
  readonly outcome: (typeof NEGOTIATION_OUTCOMES)[number];
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
 * writing up the same conversation produce rounds 3 and 4 rather than colliding.
 *
 * THERE IS NO AMOUNT PARAMETER, and `negotiation_rounds` has no amount column.
 * Pricing is FBL-120. `pricingStatus` states the absence rather than leaving a
 * reader to assume the round was free.
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
    const locked = await tx.query(
      `SELECT stage FROM opportunities
        WHERE tenant_id = $1 AND opportunity_id = $2 FOR UPDATE`,
      [input.tenantId, input.opportunityId],
    );
    if (locked.rows.length === 0) return { outcome: 'not_found' as const };
    const stage = String((locked.rows[0] as Row).stage);
    if (stage === 'ready_for_desking' || stage === 'lost') {
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
        input.managerInvolved === true,
        input.outcome,
        actor,
      ],
    );
    const row = written.rows[0] as Row;
    const round: NegotiationRoundView = {
      roundId: String(row.round_id),
      opportunityId: String(row.opportunity_id),
      roundNumber: Number(row.round_number),
      initiatedBy: String(row.initiated_by) as 'customer' | 'dealership',
      summary: String(row.summary),
      managerInvolved: row.manager_involved === true,
      outcome: String(row.outcome) as (typeof NEGOTIATION_OUTCOMES)[number],
      pricingStatus: String(row.pricing_status) as 'NOT_YET_AVAILABLE' | 'AVAILABLE',
      occurredAt: new Date(row.occurred_at as string).toISOString(),
    };
    const mutation = await recordMutation(tx, {
      tenantId: input.tenantId,
      entityType: 'negotiation_round',
      entityId: round.roundId,
      eventType: 'sales.negotiation.round_recorded',
      actingUserLinkId: actor,
      authorizationVersion: round.roundNumber,
      details: {
        opportunity_id: input.opportunityId,
        round_number: round.roundNumber,
        outcome: input.outcome,
      },
    });
    return { outcome: 'recorded' as const, round, mutation };
  });
}

export type TurnoverOutcome =
  | { outcome: 'recorded'; turnoverId: string; mutation: MutationResult }
  | { outcome: 'not_found' }
  | { outcome: 'invalid'; error: string };

/** Brings a manager into the deal, and records why. */
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
    if (!(await reaches(input.tenantId, input.managerUserLinkId, open.opportunity.rooftopId))) {
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
        `INSERT INTO visit_events (tenant_id, visit_id, event_type, note, actor_user_link_id)
         VALUES ($1, $2, 'turned_over', $3, $4)`,
        [input.tenantId, input.visitId, input.reason, actor],
      );
    }
    const mutation = await recordMutation(tx, {
      tenantId: input.tenantId,
      entityType: 'manager_turnover',
      entityId: turnoverId,
      eventType: 'sales.turnover.recorded',
      actingUserLinkId: actor,
      authorizationVersion: 1,
      details: {
        opportunity_id: input.opportunityId,
        manager_user_link_id: input.managerUserLinkId,
        reason: input.reason,
      },
    });
    return { outcome: 'recorded' as const, turnoverId, mutation };
  });
}
