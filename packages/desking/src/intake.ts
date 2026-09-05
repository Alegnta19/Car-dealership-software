/**
 * ROW 1 — CANONICAL INTAKE.
 *
 * "Consume the desking-ready fact exactly once and preserve the canonical
 * opportunity, customer, rooftop, selected stock, and optional trade vehicle.
 * Repeated or concurrent intake converges; foreign or mismatched references
 * refuse without disclosure."
 *
 * CONVERGENCE IS BUILT THREE TIMES, and each guard alone gives the right
 * answer — the same construction Release Train 4 arrived at, for the same
 * reason. An advisory lock keyed on the fact serialises two callers who arrive
 * together; `ON CONFLICT DO NOTHING` catches the pair the lock cannot (two
 * connections, two transactions, one committed between the pre-check and the
 * insert); and the raced re-select turns the empty RETURNING into the case the
 * other caller just wrote. Deleting any one of them leaves the outcome correct,
 * which is exactly why no honest single-line mutation of this function exists
 * and why `tests/desking-intake.test.ts` runs the race for real instead.
 *
 * FOREIGN REFERENCES REFUSE WITHOUT DISCLOSURE. A handoff at a rooftop the
 * caller does not work answers `not_found` — the same words a handoff that was
 * never written gets. Nothing in the refusal says whether the row exists,
 * because "does this id exist" is the question a probe is asking.
 */
import { withTenantTransaction, type Executor } from '@dealer/database';
import {
  permittedRooftopIds,
  recordMutation,
  requireActor,
  type MutationResult,
} from '@dealer/identity-access';
import { getDeskingHandoffWithin, markDeskingHandoffAvailableWithin } from '@dealer/sales';

interface Row {
  [key: string]: unknown;
}

export type DeskingCaseState = 'open' | 'approved';

export interface DeskingCaseView {
  readonly deskingCaseId: string;
  readonly rooftopId: string;
  readonly opportunityId: string;
  readonly partyId: string;
  readonly stockItemId: string | null;
  readonly deskingHandoffId: string;
  readonly state: DeskingCaseState;
  readonly openedByUserLinkId: string;
  readonly approvedAt: string | null;
  readonly authorizationVersion: number;
  readonly createdAt: string;
}

export const CASE_COLUMNS = `desking_case_id, rooftop_id, opportunity_id, party_id, stock_item_id,
  desking_handoff_id, state, opened_by_user_link_id, approved_at, authorization_version, created_at`;

export function mapCase(row: Row): DeskingCaseView {
  return {
    deskingCaseId: String(row.desking_case_id),
    rooftopId: String(row.rooftop_id),
    opportunityId: String(row.opportunity_id),
    partyId: String(row.party_id),
    stockItemId: row.stock_item_id === null ? null : String(row.stock_item_id),
    deskingHandoffId: String(row.desking_handoff_id),
    state: String(row.state) as DeskingCaseState,
    openedByUserLinkId: String(row.opened_by_user_link_id),
    approvedAt: row.approved_at === null ? null : new Date(String(row.approved_at)).toISOString(),
    authorizationVersion: Number(row.authorization_version),
    createdAt: new Date(String(row.created_at)).toISOString(),
  };
}

export type IntakeOutcome =
  | { outcome: 'opened'; deskingCase: DeskingCaseView; mutation: MutationResult }
  | { outcome: 'already_open'; deskingCase: DeskingCaseView }
  | { outcome: 'not_found' };

/** The advisory key: one fact, one queue. */
function intakeKey(tenantId: string, deskingHandoffId: string): string {
  return `fbl120:intake:${tenantId}:${deskingHandoffId}`;
}

export async function reaches(
  tenantId: string,
  userLinkId: string,
  rooftopId: string,
): Promise<boolean> {
  const permitted = await permittedRooftopIds(tenantId, userLinkId);
  return permitted.includes(rooftopId);
}

export async function openDeskingCaseWithin(
  executor: Executor,
  input: { actingUserLinkId: string; tenantId: string; deskingHandoffId: string },
): Promise<IntakeOutcome> {
  const actor = await requireActor(executor, input.actingUserLinkId);

  await executor.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
    intakeKey(input.tenantId, input.deskingHandoffId),
  ]);

  // GUARD ONE — the case may already be open. Answered before the fact is even
  // read, so a replay costs one index lookup.
  const existing = await executor.query(
    `SELECT ${CASE_COLUMNS} FROM desking_cases
      WHERE tenant_id = $1 AND desking_handoff_id = $2`,
    [input.tenantId, input.deskingHandoffId],
  );
  if (existing.rows.length > 0) {
    const already = mapCase(existing.rows[0] as Row);
    if (!(await reaches(input.tenantId, actor, already.rooftopId))) {
      return { outcome: 'not_found' };
    }
    return { outcome: 'already_open', deskingCase: already };
  }

  const fact = await getDeskingHandoffWithin(executor, {
    tenantId: input.tenantId,
    deskingHandoffId: input.deskingHandoffId,
  });
  // A fact that does not exist and a fact at somebody else's rooftop are the
  // same answer, in the same words.
  if (fact === null) return { outcome: 'not_found' };
  if (!(await reaches(input.tenantId, actor, fact.rooftopId))) return { outcome: 'not_found' };

  // GUARD TWO — the unique key on (tenant_id, desking_handoff_id) decides it.
  const written = await executor.query(
    `INSERT INTO desking_cases
       (tenant_id, rooftop_id, opportunity_id, party_id, stock_item_id,
        desking_handoff_id, intake_outbox_event_id, opened_by_user_link_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (tenant_id, desking_handoff_id) DO NOTHING
     RETURNING ${CASE_COLUMNS}`,
    [
      input.tenantId,
      fact.rooftopId,
      fact.opportunityId,
      fact.partyId,
      fact.stockItemId,
      fact.deskingHandoffId,
      fact.outboxEventId,
      actor,
    ],
  );

  // GUARD THREE — the other caller won; read what they wrote and agree with it.
  if (written.rows.length === 0) {
    const raced = await executor.query(
      `SELECT ${CASE_COLUMNS} FROM desking_cases
        WHERE tenant_id = $1 AND desking_handoff_id = $2`,
      [input.tenantId, input.deskingHandoffId],
    );
    if (raced.rows.length === 0) return { outcome: 'not_found' };
    return { outcome: 'already_open', deskingCase: mapCase(raced.rows[0] as Row) };
  }

  const opened = mapCase(written.rows[0] as Row);

  // The desk holds it now, and the seam says so in the same transaction that
  // opened the file. A reader of `desking_handoffs` alone can see the truth.
  await markDeskingHandoffAvailableWithin(executor, {
    tenantId: input.tenantId,
    deskingHandoffId: input.deskingHandoffId,
  });

  const mutation = await recordMutation(executor, {
    tenantId: input.tenantId,
    entityType: 'desking_case',
    entityId: opened.deskingCaseId,
    eventType: 'desking.case.opened',
    actingUserLinkId: actor,
    authorizationVersion: opened.authorizationVersion,
    details: {
      desking_handoff_id: opened.deskingHandoffId,
      opportunity_id: opened.opportunityId,
      party_id: opened.partyId,
      stock_item_id: opened.stockItemId,
    },
  });
  return { outcome: 'opened', deskingCase: opened, mutation };
}

export async function openDeskingCase(input: {
  actingUserLinkId: string;
  tenantId: string;
  deskingHandoffId: string;
}): Promise<IntakeOutcome> {
  return withTenantTransaction(input.tenantId, async (tx) => openDeskingCaseWithin(tx, input));
}

/** One case, or nothing the caller may see. */
export async function getDeskingCase(
  tenantId: string,
  actingUserLinkId: string,
  deskingCaseId: string,
): Promise<DeskingCaseView | null> {
  return withTenantTransaction(tenantId, async (tx) => {
    const actor = await requireActor(tx, actingUserLinkId);
    const found = await tx.query(
      `SELECT ${CASE_COLUMNS} FROM desking_cases
        WHERE tenant_id = $1 AND desking_case_id = $2`,
      [tenantId, deskingCaseId],
    );
    if (found.rows.length === 0) return null;
    const view = mapCase(found.rows[0] as Row);
    return (await reaches(tenantId, actor, view.rooftopId)) ? view : null;
  });
}

/** Lock a case for a command, and refuse to say whether a foreign one exists. */
export async function requireCaseWithin(
  executor: Executor,
  tenantId: string,
  actor: string,
  deskingCaseId: string,
): Promise<DeskingCaseView | null> {
  const found = await executor.query(
    `SELECT ${CASE_COLUMNS} FROM desking_cases
      WHERE tenant_id = $1 AND desking_case_id = $2
      FOR UPDATE`,
    [tenantId, deskingCaseId],
  );
  if (found.rows.length === 0) return null;
  const view = mapCase(found.rows[0] as Row);
  return (await reaches(tenantId, actor, view.rooftopId)) ? view : null;
}
