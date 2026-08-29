/**
 * RELEASE TRAIN 3, ROW 4 — DELIVERY, AND THE SECOND PERMISSION CHECK.
 *
 * THE SAFETY PROPERTY OF THIS WHOLE TRAIN LIVES IN ONE PLACE: `dispatchDueSends`
 * re-asks `sendEligibility` immediately before it hands anything to a provider,
 * inside the same transaction as the send. Building the audience checked
 * permission too, but that check is stale by the time the message goes — and
 * the opt-out that arrives in between is precisely the one a customer will be
 * angry about. A platform that only filters at audience time WILL send to
 * someone who unsubscribed while it was thinking.
 *
 * FOUR MORE PROPERTIES:
 *
 *   * DELIVERY IS AT LEAST ONCE; THE EFFECT IS EXACTLY ONCE. One outcome per
 *     (send, event type, attempt) is a UNIQUE constraint, so a replayed
 *     delivery writing a second 'sent' for attempt 1 is refused by the database
 *     and recognised as the replay it is.
 *   * A TRANSIENT FAILURE IS RETRIED; A PERMANENT ONE IS NOT. Retrying a dead
 *     address for ever is not persistence, it is a loop, and the provider is
 *     asked to say which kind of failure it was.
 *   * QUIET HOURS DEFER, THEY DO NOT FAIL. A message held until morning is a
 *     message with a later time, not an error, and it carries the instant it
 *     becomes sendable so nothing has to guess.
 *   * A REPLY IS RECONCILED INTO A LEAD. That is the point of the section: a
 *     campaign that produces activity but no pipeline has produced nothing.
 */
import { withTenantTransaction, type Executor } from '@dealer/database';
import { recordMutation, requireActor, type MutationResult } from '@dealer/identity-access';
import {
  insideQuietHours,
  quietHoursEndAfter,
  sendEligibility,
  type ConsentPurpose,
} from './consent';
import { suppressContactWithin } from './consent-records';
import { captureLeadWithin } from './leads';
import { simulatedMessageProvider, type MessageProvider } from './providers';
import { CAMPAIGN_DISPATCH_EVENT } from './campaigns';

interface Row {
  [key: string]: unknown;
}

export interface DispatchResult {
  readonly claimed: number;
  readonly sent: number;
  readonly deferred: number;
  readonly suppressed: number;
  readonly retrying: number;
  readonly failed: number;
}

/** How long a transient failure waits before the next attempt. */
const RETRY_BACKOFF_SECONDS = [60, 300, 900] as const;
/** After this many attempts a transient failure is treated as permanent. */
const MAX_ATTEMPTS = 4;

/**
 * ONE DISPATCH PASS. Claims due sends with `FOR UPDATE SKIP LOCKED`, so two
 * workers running at once share the queue instead of fighting over it.
 */
export async function dispatchDueSends(input: {
  tenantId: string;
  provider?: MessageProvider | undefined;
  limit?: number | undefined;
  now?: Date | undefined;
}): Promise<DispatchResult> {
  const provider = input.provider ?? simulatedMessageProvider;
  const limit = Math.min(Math.max(input.limit ?? 25, 1), 200);

  let claimed = 0;
  let sent = 0;
  let deferred = 0;
  let suppressed = 0;
  let retrying = 0;
  let failed = 0;

  // ONE TRANSACTION PER MESSAGE, AND THAT IS THE WHOLE POINT (RT3-C1 §3).
  //
  // A batch-wide transaction is wrong in a way that only shows up in
  // production: the provider is a side effect the database cannot roll back.
  // Twenty messages sent and a failure on the twenty-first would undo the
  // twenty `sent` rows and their event ledger while the customers still had
  // the mail — so the next pass would send them all again, and the platform
  // would have no record that it had ever sent them at all. Claiming and
  // committing one send at a time bounds the damage to the message actually in
  // flight, which is the most any at-least-once delivery can promise.
  for (let i = 0; i < limit; i += 1) {
    const step = await withTenantTransaction(input.tenantId, async (tx) => {
      // ONE CLOCK, AND IT IS THE DATABASE'S.
      //
      // `available_at` is written by the database — `NOW()` on insert, `NOW() +
      // backoff` on retry — so comparing it against the process's own clock
      // means two clocks decide one question. They do not have to be far apart
      // to be wrong: a send made due at the database's NOW() is NOT due to a
      // process whose clock is a millisecond behind, and the message silently
      // waits for the next pass. Reading the instant here, on the connection
      // that does the comparison, removes the second clock — and the
      // quiet-hours arithmetic below uses that same instant, so a message is
      // never judged due by one clock and asleep by another.
      const clock = await tx.query(`SELECT NOW() AS now`);
      const now = input.now ?? new Date((clock.rows[0] as Row).now as string);

      const due = await tx.query(
        `SELECT s.send_id, s.campaign_version_id, s.party_id, s.channel, s.contact_value,
                s.state, s.attempts,
                c.purpose, c.quiet_hours_start_minute, c.quiet_hours_end_minute, c.time_zone,
                t.subject, t.body
           FROM campaign_sends s
           JOIN campaign_versions v
             ON v.tenant_id = s.tenant_id AND v.campaign_version_id = s.campaign_version_id
           JOIN campaigns c ON c.tenant_id = v.tenant_id AND c.campaign_id = v.campaign_id
           JOIN campaign_templates t
             ON t.tenant_id = v.tenant_id AND t.campaign_version_id = v.campaign_version_id
          WHERE s.tenant_id = $1
            AND s.state IN ('pending', 'deferred_quiet_hours')
            AND s.available_at <= $2
            AND v.state = 'executing'
          ORDER BY s.available_at
          LIMIT 1
          FOR UPDATE OF s SKIP LOCKED`,
        [input.tenantId, now.toISOString()],
      );
      if (due.rows.length === 0) return 'drained' as const;

      const row = due.rows[0] as Row;
      const sendId = String(row.send_id);
      const channel = String(row.channel) as 'email' | 'sms';
      const attempts = Number(row.attempts);

      // ── THE SECOND CHECK. This is the one that matters. ──────────────────
      const eligible = await sendEligibility(tx, {
        tenantId: input.tenantId,
        partyId: String(row.party_id),
        channel,
        purpose: String(row.purpose) as ConsentPurpose,
      });
      if (!eligible.eligible) {
        await tx.query(
          `UPDATE campaign_sends
              SET state = 'suppressed', withheld_reason = $3, updated_at = NOW(),
                  authorization_version = authorization_version + 1
            WHERE tenant_id = $1 AND send_id = $2`,
          [input.tenantId, sendId, eligible.reason],
        );
        await writeSendEvent(tx, input.tenantId, sendId, 'suppressed', attempts, eligible.reason);
        return 'suppressed' as const;
      }

      // ── QUIET HOURS. Deferred, with the instant it may go. ───────────────
      const quiet = {
        startMinute: Number(row.quiet_hours_start_minute),
        endMinute: Number(row.quiet_hours_end_minute),
        timeZone: String(row.time_zone),
      };
      if (insideQuietHours(now, quiet)) {
        const openAt = quietHoursEndAfter(now, quiet);
        await tx.query(
          `UPDATE campaign_sends
              SET state = 'deferred_quiet_hours', withheld_reason = 'quiet_hours',
                  available_at = $3, updated_at = NOW(),
                  authorization_version = authorization_version + 1
            WHERE tenant_id = $1 AND send_id = $2`,
          [input.tenantId, sendId, openAt.toISOString()],
        );
        await writeSendEvent(
          tx,
          input.tenantId,
          sendId,
          'deferred',
          attempts,
          `quiet hours until ${openAt.toISOString()}`,
        );
        return 'deferred' as const;
      }

      const attempt = attempts + 1;
      await writeSendEvent(tx, input.tenantId, sendId, 'requested', attempt, null);
      const answer = await provider.send({
        sendId,
        channel,
        contactValue: eligible.contactValue,
        attempt,
        subject: row.subject === null ? null : String(row.subject),
        body: String(row.body),
      });

      if (answer.outcome === 'sent') {
        await tx.query(
          `UPDATE campaign_sends
              SET state = 'sent', sent_at = NOW(), attempts = $3, external_ref = $4,
                  last_error = NULL, withheld_reason = NULL, updated_at = NOW(),
                  authorization_version = authorization_version + 1
            WHERE tenant_id = $1 AND send_id = $2`,
          [input.tenantId, sendId, attempt, answer.externalRef],
        );
        await writeSendEvent(tx, input.tenantId, sendId, 'sent', attempt, null, answer.externalRef);
        return 'sent' as const;
      }

      const giveUp = answer.permanent || attempt >= MAX_ATTEMPTS;
      const backoff =
        RETRY_BACKOFF_SECONDS[Math.min(attempt - 1, RETRY_BACKOFF_SECONDS.length - 1)] ?? 900;
      await tx.query(
        `UPDATE campaign_sends
            SET state = CASE WHEN $5 THEN 'failed' ELSE 'pending' END,
                attempts = $3, last_error = $4,
                available_at = CASE WHEN $5 THEN available_at
                                    ELSE NOW() + ($6::int * INTERVAL '1 second') END,
                updated_at = NOW(),
                authorization_version = authorization_version + 1
          WHERE tenant_id = $1 AND send_id = $2`,
        [input.tenantId, sendId, attempt, answer.detail.slice(0, 500), giveUp, backoff],
      );
      await writeSendEvent(tx, input.tenantId, sendId, 'failed', attempt, answer.detail);
      return giveUp ? ('failed' as const) : ('retrying' as const);
    });

    if (step === 'drained') break;
    claimed += 1;
    if (step === 'sent') sent += 1;
    else if (step === 'deferred') deferred += 1;
    else if (step === 'suppressed') suppressed += 1;
    else if (step === 'retrying') retrying += 1;
    else failed += 1;
  }

  // A version with nothing left to do is complete. Its own transaction, so it
  // cannot roll back a delivery that already happened.
  await withTenantTransaction(input.tenantId, (tx) => completeFinishedVersions(tx, input.tenantId));

  return { claimed, sent, deferred, suppressed, retrying, failed };
}

/**
 * Writes one outcome per attempt. A redelivery that tries to write the same
 * (send, type, attempt) twice is refused by the unique index and swallowed
 * here — the refusal IS the recognition, and the caller has nothing to add.
 */
async function writeSendEvent(
  executor: Executor,
  tenantId: string,
  sendId: string,
  eventType: 'requested' | 'sent' | 'failed' | 'suppressed' | 'deferred' | 'reconciled',
  attempt: number,
  detail: string | null,
  externalRef?: string | undefined,
): Promise<boolean> {
  const written = await executor.query(
    `INSERT INTO campaign_send_events
       (tenant_id, send_id, event_type, attempt, detail, external_ref)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (tenant_id, send_id, event_type, attempt) DO NOTHING
     RETURNING send_event_id`,
    [
      tenantId,
      sendId,
      eventType,
      attempt,
      detail === null ? null : detail.slice(0, 500),
      externalRef ?? null,
    ],
  );
  return written.rows.length > 0;
}

/** A version with nothing left to do is complete. */
async function completeFinishedVersions(executor: Executor, tenantId: string): Promise<void> {
  await executor.query(
    `UPDATE campaign_versions v
        SET state = 'completed', completed_at = NOW(), updated_at = NOW(),
            authorization_version = v.authorization_version + 1
      WHERE v.tenant_id = $1 AND v.state = 'executing'
        AND NOT EXISTS (
          SELECT 1 FROM campaign_sends s
           WHERE s.tenant_id = v.tenant_id
             AND s.campaign_version_id = v.campaign_version_id
             AND s.state IN ('pending', 'deferred_quiet_hours'))`,
    [tenantId],
  );
}

// ── the outbox leg ──────────────────────────────────────────────────────────

export interface OutboxDrainResult {
  readonly claimed: number;
  readonly delivered: number;
  readonly replayed: number;
}

/**
 * Consumes the marketing outbox. The event says "a version was launched"; the
 * effect is made EXACTLY ONCE by `admin_outbox_deliveries`, whose primary key
 * is the dedupe ledger — a redelivered event finds its row and does nothing
 * again.
 *
 * The filter is `marketing.%`, so this dispatcher and Release Train 1's
 * administration dispatcher and Release Train 2's listing dispatcher share one
 * outbox table without consuming each other's work.
 */
export async function drainMarketingOutbox(input: {
  tenantId: string;
  limit?: number | undefined;
}): Promise<OutboxDrainResult> {
  const limit = Math.min(Math.max(input.limit ?? 10, 1), 100);
  return withTenantTransaction(input.tenantId, async (tx) => {
    const claimed = await tx.query(
      `SELECT event_id, payload FROM admin_outbox
        WHERE tenant_id = $1 AND delivered_at IS NULL AND available_at <= NOW()
          AND event_type LIKE 'marketing.%'
        ORDER BY available_at
        LIMIT $2
        FOR UPDATE SKIP LOCKED`,
      [input.tenantId, limit],
    );
    let delivered = 0;
    let replayed = 0;
    for (const row of claimed.rows as Row[]) {
      const eventId = String(row.event_id);
      const ledger = await tx.query(
        `INSERT INTO admin_outbox_deliveries (event_id, sink)
         VALUES ($1, $2) ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
        [eventId, CAMPAIGN_DISPATCH_EVENT],
      );
      if (ledger.rows.length === 0) {
        replayed += 1;
      } else {
        delivered += 1;
      }
      await tx.query(
        `UPDATE admin_outbox SET delivered_at = NOW(), attempts = attempts + 1
          WHERE event_id = $1`,
        [eventId],
      );
    }
    return { claimed: claimed.rows.length, delivered, replayed };
  });
}

// ── reconciliation and replies ──────────────────────────────────────────────

export type ReconcileOutcome =
  | { outcome: 'corrected'; state: string }
  | { outcome: 'agreed'; state: string }
  | { outcome: 'not_found' };

/**
 * THE PROVIDER IS THE AUTHORITY ON WHETHER IT SENT SOMETHING. When a later
 * reconciliation says a message the platform recorded as sent was in fact
 * rejected, the platform is wrong and says so — in a further row, never by
 * editing the history.
 */
export async function reconcileSend(input: {
  tenantId: string;
  /** The campaign the CALLER was authorized against; the send must be its own. */
  campaignId: string;
  sendId: string;
  providerState: 'sent' | 'failed';
  detail?: string | null | undefined;
  externalRef?: string | null | undefined;
}): Promise<ReconcileOutcome> {
  return withTenantTransaction(input.tenantId, async (tx) => {
    // EXACT PARENT (RT3-C1 §2): the engine authorized a campaign, so the send
    // must hang off that campaign. Joining rather than trusting the path is
    // what makes the authorization decision and the row it acts on the same
    // decision.
    const found = await tx.query(
      `SELECT s.send_id, s.state, s.attempts FROM campaign_sends s
         JOIN campaign_versions v
           ON v.tenant_id = s.tenant_id AND v.campaign_version_id = s.campaign_version_id
        WHERE s.tenant_id = $1 AND s.send_id = $2 AND v.campaign_id = $3
        FOR UPDATE OF s`,
      [input.tenantId, input.sendId, input.campaignId],
    );
    if (found.rows.length === 0) return { outcome: 'not_found' as const };
    const row = found.rows[0] as Row;
    const state = String(row.state);
    const attempts = Number(row.attempts);
    if (state === input.providerState) {
      await writeSendEvent(
        tx,
        input.tenantId,
        input.sendId,
        'reconciled',
        attempts,
        'provider agrees',
      );
      return { outcome: 'agreed' as const, state };
    }
    await tx.query(
      `UPDATE campaign_sends
          SET state = $3,
              sent_at = CASE WHEN $3 = 'sent' THEN COALESCE(sent_at, NOW()) ELSE NULL END,
              external_ref = CASE WHEN $3 = 'sent' THEN COALESCE($4, external_ref) ELSE NULL END,
              last_error = CASE WHEN $3 = 'failed' THEN $5 ELSE NULL END,
              withheld_reason = NULL,
              updated_at = NOW(), authorization_version = authorization_version + 1
        WHERE tenant_id = $1 AND send_id = $2`,
      [
        input.tenantId,
        input.sendId,
        input.providerState,
        input.externalRef ?? null,
        (input.detail ?? 'reconciled as failed').slice(0, 500),
      ],
    );
    await writeSendEvent(
      tx,
      input.tenantId,
      input.sendId,
      'reconciled',
      attempts,
      `platform said ${state}, provider says ${input.providerState}`,
    );
    return { outcome: 'corrected' as const, state: input.providerState };
  });
}

export type ResponseType = 'reply' | 'click' | 'opt_out' | 'bounce';

export type ResponseOutcome =
  | { outcome: 'recorded'; responseId: string; leadId: string | null; mutation: MutationResult }
  | { outcome: 'already_recorded'; responseId: string; leadId: string | null }
  | { outcome: 'not_found' }
  | { outcome: 'invalid'; error: string };

/**
 * A REPLY BECOMES PIPELINE; AN OPT-OUT BECOMES SILENCE.
 *
 * Both are recorded against the send that produced them, and both are
 * idempotent: one response of each kind per send, so a provider redelivering
 * "opted out" does not opt the customer out twice or create a second lead.
 *
 * An opt-out writes the suppression IN THE SAME TRANSACTION as the response.
 * There is no window in which the platform knows somebody unsubscribed and has
 * not yet stopped being able to contact them.
 */
export async function recordCampaignResponse(input: {
  actingUserLinkId: string;
  tenantId: string;
  campaignId: string;
  sendId: string;
  responseType: ResponseType;
  detail?: string | null | undefined;
}): Promise<ResponseOutcome> {
  return withTenantTransaction(input.tenantId, async (tx) => {
    const actor = await requireActor(tx, input.actingUserLinkId);
    const found = await tx.query(
      `SELECT s.send_id, s.party_id, s.channel, s.contact_value, s.campaign_version_id,
              c.rooftop_id, c.lead_source_id, ls.source_code
         FROM campaign_sends s
         JOIN campaign_versions v
           ON v.tenant_id = s.tenant_id AND v.campaign_version_id = s.campaign_version_id
         JOIN campaigns c ON c.tenant_id = v.tenant_id AND c.campaign_id = v.campaign_id
         JOIN lead_sources ls
           ON ls.tenant_id = c.tenant_id AND ls.lead_source_id = c.lead_source_id
        WHERE s.tenant_id = $1 AND s.send_id = $2 AND c.campaign_id = $3
        FOR UPDATE OF s`,
      [input.tenantId, input.sendId, input.campaignId],
    );
    if (found.rows.length === 0) return { outcome: 'not_found' as const };
    const send = found.rows[0] as Row;

    const prior = await tx.query(
      `SELECT response_id, lead_id FROM campaign_responses
        WHERE tenant_id = $1 AND send_id = $2 AND response_type = $3`,
      [input.tenantId, input.sendId, input.responseType],
    );
    if (prior.rows.length > 0) {
      const row = prior.rows[0] as Row;
      return {
        outcome: 'already_recorded' as const,
        responseId: String(row.response_id),
        leadId: row.lead_id === null ? null : String(row.lead_id),
      };
    }

    let leadId: string | null = null;
    if (input.responseType === 'reply' || input.responseType === 'click') {
      const captured = await captureLeadWithin(tx, {
        actingUserLinkId: actor,
        tenantId: input.tenantId,
        rooftopId: String(send.rooftop_id),
        // The send is the natural idempotency handle: one response of a kind
        // per send means one capture per (send, kind).
        intakeKey: `campaign-response:${input.sendId}:${input.responseType}`,
        channel: 'campaign',
        sourceCode: String(send.source_code),
        partyId: String(send.party_id),
        campaignVersionId: String(send.campaign_version_id),
      });
      if (captured.outcome === 'invalid') {
        return { outcome: 'invalid' as const, error: captured.error };
      }
      leadId = captured.lead.leadId;
    }

    if (input.responseType === 'opt_out' || input.responseType === 'bounce') {
      const suppressed = await suppressContactWithin(tx, {
        actingUserLinkId: actor,
        tenantId: input.tenantId,
        contactKind: String(send.channel) === 'email' ? 'email' : 'phone',
        contactValue: String(send.contact_value),
        reason: input.responseType === 'opt_out' ? 'unsubscribe' : 'bounce',
        partyId: String(send.party_id),
      });
      if (suppressed.outcome === 'invalid') {
        return { outcome: 'invalid' as const, error: suppressed.error };
      }
    }

    const written = await tx.query(
      `INSERT INTO campaign_responses (tenant_id, send_id, response_type, lead_id, detail)
       VALUES ($1, $2, $3, $4, $5) RETURNING response_id`,
      [
        input.tenantId,
        input.sendId,
        input.responseType,
        leadId,
        (input.detail ?? '').slice(0, 500) || null,
      ],
    );
    const responseId = String((written.rows[0] as Row).response_id);
    const mutation = await recordMutation(tx, {
      tenantId: input.tenantId,
      entityType: 'campaign_send',
      entityId: input.sendId,
      eventType: 'crm.campaign_response.recorded',
      actingUserLinkId: actor,
      authorizationVersion: 1,
      details: { response_type: input.responseType, lead_id: leadId },
    });
    return { outcome: 'recorded' as const, responseId, leadId, mutation };
  });
}
