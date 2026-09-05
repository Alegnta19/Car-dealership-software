/**
 * THE ONE SEAM FBL-120 REACHES THROUGH, AND NOTHING ELSE.
 *
 * Release Train 4 ends by writing a `desking_handoffs` row and an outbox event
 * in one transaction. FBL-120 has to READ that fact to open a desk file, and it
 * has to say the desk now holds it. This module is that pair of operations, and
 * it is deliberately the whole of the sales package's public surface to the
 * desk: appraisal and pricing never touch an opportunity, a visit, a
 * demonstration or a rotation, and nothing here lets them.
 *
 * WHY IT IS HERE RATHER THAN A QUERY IN THE OTHER PACKAGE. `desking_handoffs`
 * is migration 064's table and this package owns it. A reader in the desking
 * package would be a second place that knows the column names, and the first
 * time one of them changed the two would disagree — which is the same argument
 * Release Train 4 made when it consumed Release Train 3's handoff through
 * `@dealer/crm` rather than by selecting from `lead_handoffs`.
 *
 * WHY `desking_status` MOVES AT ALL. Migration 064 shipped the column pinned to
 * NOT_YET_AVAILABLE by a CHECK, because the desk did not exist and pretending
 * otherwise would have been a lie told to every reader of the table. Migration
 * 065 takes the pin off and grants UPDATE on that ONE column. AVAILABLE means
 * exactly one thing: a desking case has been opened from this fact.
 */
import { withTenantTransaction, type Executor } from '@dealer/database';
import { permittedRooftopIds, requireActor } from '@dealer/identity-access';

interface Row {
  [key: string]: unknown;
}

export type DeskingHandoffStatus = 'NOT_YET_AVAILABLE' | 'AVAILABLE';

/** The fact Release Train 4 hands on, exactly as it was written. */
export interface DeskingHandoffFact {
  readonly deskingHandoffId: string;
  readonly opportunityId: string;
  readonly rooftopId: string;
  readonly partyId: string;
  readonly stockItemId: string | null;
  readonly handedByUserLinkId: string;
  readonly outboxEventId: string;
  readonly deskingStatus: DeskingHandoffStatus;
  readonly occurredAt: string;
}

const HANDOFF_COLUMNS = `desking_handoff_id, opportunity_id, rooftop_id, party_id,
  stock_item_id, handed_by_user_link_id, outbox_event_id, desking_status, occurred_at`;

function mapHandoff(row: Row): DeskingHandoffFact {
  return {
    deskingHandoffId: String(row.desking_handoff_id),
    opportunityId: String(row.opportunity_id),
    rooftopId: String(row.rooftop_id),
    partyId: String(row.party_id),
    stockItemId: row.stock_item_id === null ? null : String(row.stock_item_id),
    handedByUserLinkId: String(row.handed_by_user_link_id),
    outboxEventId: String(row.outbox_event_id),
    deskingStatus: String(row.desking_status) as DeskingHandoffStatus,
    occurredAt: new Date(String(row.occurred_at)).toISOString(),
  };
}

/**
 * One fact by its id, locked for the caller's transaction.
 *
 * `FOR UPDATE` because the caller is about to decide whether a desk file exists
 * for it, and two callers deciding that at once is exactly the race Row 1 of
 * the FBL-120 order names.
 */
export async function getDeskingHandoffWithin(
  executor: Executor,
  input: { tenantId: string; deskingHandoffId: string },
): Promise<DeskingHandoffFact | null> {
  const found = await executor.query(
    `SELECT ${HANDOFF_COLUMNS} FROM desking_handoffs
      WHERE tenant_id = $1 AND desking_handoff_id = $2
      FOR UPDATE`,
    [input.tenantId, input.deskingHandoffId],
  );
  return found.rows.length === 0 ? null : mapHandoff(found.rows[0] as Row);
}

/**
 * The facts this person may open a desk file from: the rooftops they work, and
 * only those. A handoff at a rooftop they do not work is not refused with an
 * explanation — it is simply not in the list, which is the same non-enumerating
 * answer every other discovery read in this repository gives.
 */
export async function pendingDeskingHandoffs(
  tenantId: string,
  actingUserLinkId: string,
): Promise<DeskingHandoffFact[]> {
  return withTenantTransaction(tenantId, async (tx) => {
    const actor = await requireActor(tx, actingUserLinkId);
    const rooftops = await permittedRooftopIds(tenantId, actor);
    if (rooftops.length === 0) return [];
    const found = await tx.query(
      `SELECT ${HANDOFF_COLUMNS} FROM desking_handoffs
        WHERE tenant_id = $1 AND rooftop_id = ANY($2::uuid[])
        ORDER BY occurred_at DESC
        LIMIT 200`,
      [tenantId, rooftops],
    );
    return found.rows.map((r) => mapHandoff(r as Row));
  });
}

/**
 * Say the desk holds it. Idempotent by construction — setting AVAILABLE twice
 * is setting it once — so a replayed intake converges here as it does
 * everywhere else in this chain.
 */
export async function markDeskingHandoffAvailableWithin(
  executor: Executor,
  input: { tenantId: string; deskingHandoffId: string },
): Promise<void> {
  await executor.query(
    `UPDATE desking_handoffs SET desking_status = 'AVAILABLE'
      WHERE tenant_id = $1 AND desking_handoff_id = $2`,
    [input.tenantId, input.deskingHandoffId],
  );
}
