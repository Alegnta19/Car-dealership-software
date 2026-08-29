/**
 * RELEASE TRAIN 1 — THE TRANSACTIONAL OUTBOX FOR ADMINISTRATION EVENTS.
 *
 * An event that must LEAVE the service (today: the staff-invitation email) is
 * written by `enqueueAdminOutboxEvent` in the SAME transaction as the state it
 * describes — an invitation cannot exist without its event, an event cannot
 * exist for an invitation that rolled back. The worker then dispatches events
 * AT LEAST once via `dispatchDueAdminOutboxEvents`; the business effect is
 * made exactly-once by the `admin_outbox_deliveries` primary key, which is the
 * consumer-side dedupe ledger: a redelivered event finds its delivery row and
 * performs nothing again.
 *
 * Delivery semantics, stated precisely:
 *   * a delivery attempt claims ONE due event `FOR UPDATE SKIP LOCKED`, so
 *     concurrent dispatchers never fight over a row;
 *   * the dedupe-ledger INSERT, the port call and the delivered_at mark commit
 *     ATOMICALLY — a port failure rolls all three back and the event retries
 *     later with backoff (`attempts`, `available_at`, `last_error`);
 *   * REPLAY loses nothing and duplicates nothing: an event marked undelivered
 *     again (crash recovery, manual replay) hits the ledger conflict, skips
 *     the port, and is simply re-marked delivered.
 *
 * The payload carries IDS ONLY. The dispatcher re-reads the invitation row —
 * under the event's own tenant context, because that table is row-secured —
 * for the address at delivery time, so the outbox never becomes a second copy
 * of personal data.
 */
import { logger } from '@dealer/platform';
import { setTenantContext, withTransaction, type Executor } from '@dealer/database';

interface Row {
  [key: string]: unknown;
}

export interface AdminOutboxEventInput {
  readonly tenantId: string;
  readonly eventType: string;
  /** ids only — the dispatcher hydrates current state at delivery time */
  readonly payload: Record<string, unknown>;
}

/** Written INSIDE the caller's (tenant-context) transaction. */
export async function enqueueAdminOutboxEvent(
  executor: Executor,
  input: AdminOutboxEventInput,
): Promise<string> {
  const r = await executor.query(
    `INSERT INTO admin_outbox (tenant_id, event_type, payload)
     VALUES ($1, $2, $3) RETURNING event_id`,
    [input.tenantId, input.eventType, JSON.stringify(input.payload)],
  );
  return String((r.rows[0] as Row).event_id);
}

export interface AdminOutboxDelivery {
  readonly eventId: string;
  readonly tenantId: string;
  readonly eventType: string;
  readonly payload: Record<string, unknown>;
  /** hydrated for admin.staff_invitation.created events */
  readonly invitation: {
    readonly invitationId: string;
    readonly email: string;
    readonly displayName: string | null;
    readonly invitedRole: string;
    readonly status: string;
  } | null;
}

export interface AdminOutboxDeliveryPort {
  /** Where deliveries go, recorded in the dedupe ledger (e.g. 'log', 'smtp'). */
  readonly sink: string;
  deliver(event: AdminOutboxDelivery): Promise<void>;
}

/**
 * The default sink: a structured log line carrying IDS ONLY (never the
 * address), which is what "leaving the service" means until a real mail
 * provider is configured. Tests substitute their own port.
 */
export const loggingDeliveryPort: AdminOutboxDeliveryPort = {
  sink: 'log',
  async deliver(event) {
    logger.info(
      {
        component: 'admin.outbox',
        event: 'outbox_event_delivered',
        event_id: event.eventId,
        tenant_id: event.tenantId,
        event_type: event.eventType,
        invitation_id: event.invitation?.invitationId ?? null,
      },
      'Administration outbox event delivered',
    );
  },
};

export interface OutboxDispatchResult {
  readonly delivered: number;
  readonly deduplicated: number;
  readonly failed: number;
}

/**
 * Dispatches due events, one claim-transaction each, until the batch limit or
 * the queue runs dry. Returns counts; failures are recorded on the event row
 * (attempts, backoff, last_error) and never abort the batch.
 */
export async function dispatchDueAdminOutboxEvents(options?: {
  limit?: number;
  port?: AdminOutboxDeliveryPort;
}): Promise<OutboxDispatchResult> {
  const limit = options?.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new RangeError('outbox dispatch limit must be an integer in 1..500');
  }
  const port = options?.port ?? loggingDeliveryPort;
  let delivered = 0;
  let deduplicated = 0;
  let failed = 0;

  for (let i = 0; i < limit; i += 1) {
    let claimedEventId: string | null = null;
    try {
      const outcome = await withTransaction(async (tx) => {
        // RELEASE TRAIN 2: THIS DISPATCHER CLAIMS ONLY ITS OWN EVENT TYPES.
        //
        // `admin_outbox` is domain-neutral and Release Train 2 enqueues its
        // listing deliveries on the same table. Without this predicate the two
        // dispatchers race for every row, and whichever won would mark the
        // OTHER domain's event delivered without delivering it — a silently
        // lost publication. The `admin.` prefix is the namespace this file has
        // always written, so the filter narrows nothing that existed before it.
        const claimed = await tx.query(
          `SELECT * FROM admin_outbox
            WHERE delivered_at IS NULL AND available_at <= NOW()
              AND event_type LIKE 'admin.%'
            ORDER BY occurred_at
            FOR UPDATE SKIP LOCKED
            LIMIT 1`,
        );
        if (claimed.rows.length === 0) return 'drained' as const;
        const row = claimed.rows[0] as Row;
        const eventId = String(row.event_id);
        const tenantId = String(row.tenant_id);
        claimedEventId = eventId;

        // The ledger insert IS the business-effect dedupe: at-least-once
        // delivery, exactly-once effect.
        const ledger = await tx.query(
          `INSERT INTO admin_outbox_deliveries (event_id, sink)
           VALUES ($1, $2) ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
          [eventId, port.sink],
        );
        const firstDelivery = ledger.rows.length > 0;

        if (firstDelivery) {
          // Hydrate under the EVENT'S tenant context (row-secured read); the
          // tenant comes from the outbox row the server wrote, never a caller.
          await setTenantContext(tx, tenantId);
          let invitation: AdminOutboxDelivery['invitation'] = null;
          const payload = (row.payload ?? {}) as Record<string, unknown>;
          if (
            String(row.event_type) === 'admin.staff_invitation.created' &&
            typeof payload.invitation_id === 'string'
          ) {
            const inv = await tx.query(
              `SELECT invitation_id, email, display_name, invited_role, status
                 FROM staff_invitations WHERE tenant_id = $1 AND invitation_id = $2`,
              [tenantId, payload.invitation_id],
            );
            if (inv.rows.length > 0) {
              const r = inv.rows[0] as Row;
              invitation = {
                invitationId: String(r.invitation_id),
                email: String(r.email),
                displayName: r.display_name === null ? null : String(r.display_name),
                invitedRole: String(r.invited_role),
                status: String(r.status),
              };
            }
          }
          await port.deliver({
            eventId,
            tenantId,
            eventType: String(row.event_type),
            payload,
            invitation,
          });
        }

        await tx.query(
          `UPDATE admin_outbox
              SET delivered_at = NOW(), attempts = attempts + 1, last_error = NULL
            WHERE event_id = $1`,
          [eventId],
        );
        return firstDelivery ? ('delivered' as const) : ('deduplicated' as const);
      });
      if (outcome === 'drained') break;
      if (outcome === 'delivered') delivered += 1;
      else deduplicated += 1;
    } catch (err) {
      failed += 1;
      const eventId = claimedEventId;
      if (eventId !== null) {
        // The failed attempt's transaction rolled back entirely; record the
        // failure and the backoff in its own small transaction.
        await withTransaction(async (tx) => {
          await tx.query(
            `UPDATE admin_outbox
                SET attempts = attempts + 1,
                    last_error = left($2, 2000),
                    available_at = NOW() + make_interval(mins => LEAST(attempts + 1, 8) * 5)
              WHERE event_id = $1 AND delivered_at IS NULL`,
            [eventId, err instanceof Error ? err.message : String(err)],
          );
        }).catch(() => undefined);
      }
      logger.error(
        { component: 'admin.outbox', event: 'outbox_dispatch_failed', err, event_id: eventId },
        'Administration outbox dispatch failed; the event will retry with backoff',
      );
    }
  }
  return { delivered, deduplicated, failed };
}
