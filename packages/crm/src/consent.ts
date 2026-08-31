/**
 * RELEASE TRAIN 3, ROW 4 — PERMISSION, AND THE GATE THAT ENFORCES IT.
 *
 * THREE THINGS HAVE TO BE TRUE before a marketing message may be sent, and this
 * module is where all three are asked in one place so no caller has to remember
 * the list:
 *
 *   1. THERE IS A CONTACT VALUE, and it is usable on this channel.
 *   2. CONSENT IS GRANTED for this channel AND THIS PURPOSE. Absence is not
 *      permission — a party with no row is UNKNOWN, and unknown is a refusal.
 *      Migration 062 recorded consent per channel; a customer who agreed to
 *      service reminders has not agreed to sales promotions, so the purpose
 *      dimension lives in `party_purpose_consents` beside it.
 *   3. THE CONTACT VALUE IS NOT SUPPRESSED. Suppression is keyed on the VALUE,
 *      not the person, so an unsubscribe survives a merge, an archive, or a
 *      second record for the same human being.
 *
 * AND THE GATE IS ASKED TWICE. Once when the audience is built, so staff see
 * who a campaign would reach; and AGAIN AT SEND TIME, in the same transaction
 * as the send, because the opt-out that matters is the one that arrives between
 * those two moments. A platform that only checks at audience time will send to
 * someone who unsubscribed while it was thinking.
 */
import { type Executor } from '@dealer/database';
import { normalizeEmail, normalizePhone } from '@dealer/inventory';

interface Row {
  [key: string]: unknown;
}

export type ConsentChannel = 'email' | 'sms' | 'phone' | 'postal';
export type ConsentPurpose = 'sales_marketing' | 'service_reminder' | 'transactional' | 'research';
export type ConsentState = 'granted' | 'withdrawn' | 'unknown';
export type SuppressionKind = 'email' | 'phone';
export type SuppressionReason =
  'unsubscribe' | 'complaint' | 'bounce' | 'do_not_contact' | 'manual';

export const CONSENT_PURPOSES: readonly ConsentPurpose[] = [
  'sales_marketing',
  'service_reminder',
  'transactional',
  'research',
];

/** The channel a campaign sends on, mapped to the contact column it uses. */
export function contactKindForChannel(channel: 'email' | 'sms'): SuppressionKind {
  return channel === 'email' ? 'email' : 'phone';
}

/**
 * The same normalization `parties` applies, so a suppression written from an
 * unsubscribe form matches a send addressed from a customer record. A value
 * that will not normalize is not a contact value at all.
 */
export function normalizeContact(kind: SuppressionKind, raw: unknown): string | null {
  return kind === 'email' ? normalizeEmail(raw) : normalizePhone(raw);
}

export type SendEligibility =
  | { eligible: true; contactValue: string }
  | {
      eligible: false;
      reason: 'no_contact_value' | 'consent_not_granted' | 'suppressed_contact' | 'party_inactive';
    };

/**
 * MAY WE CONTACT THIS PERSON, ON THIS CHANNEL, FOR THIS PURPOSE, RIGHT NOW?
 *
 * Runs inside the caller's transaction so the answer and the write that acts on
 * it are one decision. The order of the checks is deliberate: a missing address
 * is reported as a missing address rather than as a consent failure, because
 * "we have no email for them" and "they said no" are different facts and a
 * marketer needs to be able to tell them apart.
 */
export async function sendEligibility(
  executor: Executor,
  input: {
    tenantId: string;
    partyId: string;
    channel: 'email' | 'sms';
    purpose: ConsentPurpose;
  },
): Promise<SendEligibility> {
  const kind = contactKindForChannel(input.channel);
  const party = await executor.query(
    `SELECT email, phone, status FROM parties WHERE tenant_id = $1 AND party_id = $2`,
    [input.tenantId, input.partyId],
  );
  if (party.rows.length === 0) return { eligible: false, reason: 'no_contact_value' };
  const row = party.rows[0] as Row;
  // A merged or archived record is history, and history does not receive
  // marketing. Asked FIRST, and reported as itself: calling it a missing
  // address sends a marketer hunting a data-quality problem that is not there,
  // and the two facts need different fixes.
  if (String(row.status) !== 'active') return { eligible: false, reason: 'party_inactive' };
  const raw = kind === 'email' ? row.email : row.phone;
  const contactValue = normalizeContact(kind, raw);
  if (contactValue === null) return { eligible: false, reason: 'no_contact_value' };

  const consent = await executor.query(
    `SELECT state FROM party_purpose_consents
      WHERE tenant_id = $1 AND party_id = $2 AND channel = $3 AND purpose = $4`,
    [input.tenantId, input.partyId, input.channel, input.purpose],
  );
  const state = consent.rows.length === 0 ? 'unknown' : String((consent.rows[0] as Row).state);
  if (state !== 'granted') return { eligible: false, reason: 'consent_not_granted' };

  const suppressed = await executor.query(
    `SELECT 1 FROM contact_suppressions
      WHERE tenant_id = $1 AND contact_kind = $2 AND contact_value = $3 AND state = 'active'`,
    [input.tenantId, kind, contactValue],
  );
  if (suppressed.rows.length > 0) return { eligible: false, reason: 'suppressed_contact' };

  return { eligible: true, contactValue };
}

// ── quiet hours ─────────────────────────────────────────────────────────────

export interface QuietHours {
  readonly startMinute: number;
  readonly endMinute: number;
  readonly timeZone: string;
}

/**
 * The local wall-clock minute at an instant, in a named zone. `Intl` is the
 * only correct way to do this — adding an offset to a UTC instant gets daylight
 * saving wrong twice a year, and "wrong twice a year" for a quiet-hours rule
 * means messages at three in the morning twice a year.
 */
export function localMinuteOfDay(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(at);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return hour * 60 + minute;
}

/**
 * IS THIS INSTANT INSIDE THE QUIET WINDOW?
 *
 * The window WRAPS MIDNIGHT in the normal case — 21:00 to 08:00 is the ordinary
 * setting — so the comparison is a union, not a range. A window whose ends are
 * equal is treated as no quiet hours at all rather than as "always quiet",
 * because the second reading would silently stop a dealership's marketing
 * entirely and look like a bug in the sender.
 */
export function insideQuietHours(at: Date, quiet: QuietHours): boolean {
  if (quiet.startMinute === quiet.endMinute) return false;
  const minute = localMinuteOfDay(at, quiet.timeZone);
  if (quiet.startMinute < quiet.endMinute) {
    return minute >= quiet.startMinute && minute < quiet.endMinute;
  }
  return minute >= quiet.startMinute || minute < quiet.endMinute;
}

/**
 * The next instant at which the window is open. Used to defer a send rather
 * than fail it: a message held for quiet hours is not an error, it is a message
 * with a later time.
 */
export function quietHoursEndAfter(at: Date, quiet: QuietHours): Date {
  if (!insideQuietHours(at, quiet)) return at;
  const minute = localMinuteOfDay(at, quiet.timeZone);
  const until =
    quiet.endMinute > minute ? quiet.endMinute - minute : 1440 - minute + quiet.endMinute;
  return new Date(at.getTime() + until * 60_000);
}
