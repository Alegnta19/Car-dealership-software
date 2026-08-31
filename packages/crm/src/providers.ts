/**
 * RELEASE TRAIN 3 — THE PROVIDERS, SIMULATED DETERMINISTICALLY.
 *
 * There is no email gateway, no SMS carrier and no lead marketplace behind
 * this platform, and the order is explicit that there must not be one yet: no
 * live provider certification. What there IS is the seam a real provider would
 * plug into, and a simulator that behaves like an awkward one.
 *
 * DETERMINISM IS THE POINT. Every answer below is a pure function of its input,
 * so a test that asserts a deferral is asserting a rule rather than catching a
 * coin landing. The awkward behaviours are chosen because they are the ones
 * that break naive senders:
 *
 *   * an address the provider will not accept at all (permanent failure —
 *     retrying is pointless and must not be attempted for ever);
 *   * a channel that is briefly unavailable (transient failure — retrying is
 *     the correct response, and the send must survive to be retried);
 *   * a provider that accepts and hands back a reference (the normal case),
 *     where the reference is DERIVED FROM THE SEND so a replayed delivery
 *     produces the same one and can be recognised as a replay.
 */
import { createHash } from 'node:crypto';

export type SendChannel = 'email' | 'sms';

export interface ProviderRequest {
  readonly sendId: string;
  readonly channel: SendChannel;
  readonly contactValue: string;
  readonly attempt: number;
  readonly subject: string | null;
  readonly body: string;
}

export type ProviderOutcome =
  | { outcome: 'sent'; externalRef: string }
  | { outcome: 'failed'; permanent: boolean; detail: string };

export interface MessageProvider {
  readonly name: string;
  send(request: ProviderRequest): Promise<ProviderOutcome>;
}

/**
 * The reference a provider hands back, derived from the send it answered. A
 * redelivery of the same send produces the same reference, which is what lets
 * the platform say "this is the message we already sent" rather than "this is a
 * message that looks like one we sent".
 */
export function simulatedProviderRef(sendId: string): string {
  return 'MSG-' + createHash('sha256').update(sendId).digest('hex').slice(0, 12).toUpperCase();
}

/** Addresses the simulator refuses permanently, so a bounce can be exercised. */
const UNDELIVERABLE = /^(bounce|invalid|no-such-mailbox)@/i;

/**
 * A channel that is briefly unavailable. Chosen by the CONTACT VALUE rather
 * than randomly, so the same address is always the flaky one and a retry test
 * can prove the retry succeeded rather than that a different draw came up.
 */
const TRANSIENTLY_UNAVAILABLE = /^flaky@/i;

export const simulatedMessageProvider: MessageProvider = {
  name: 'simulated',
  async send(request: ProviderRequest): Promise<ProviderOutcome> {
    const value = request.contactValue.trim();
    if (value.length === 0) {
      return { outcome: 'failed', permanent: true, detail: 'no contact value' };
    }
    if (request.channel === 'email' && !value.includes('@')) {
      return { outcome: 'failed', permanent: true, detail: 'not an email address' };
    }
    if (request.channel === 'sms' && !/^\+?[0-9]{7,15}$/.test(value)) {
      return { outcome: 'failed', permanent: true, detail: 'not a phone number' };
    }
    if (UNDELIVERABLE.test(value)) {
      return { outcome: 'failed', permanent: true, detail: 'undeliverable address' };
    }
    // Unavailable on the FIRST attempt only: the second attempt is the proof
    // that a transient failure is retried rather than abandoned.
    if (TRANSIENTLY_UNAVAILABLE.test(value) && request.attempt <= 1) {
      return { outcome: 'failed', permanent: false, detail: 'channel temporarily unavailable' };
    }
    if (request.body.trim().length === 0) {
      return { outcome: 'failed', permanent: true, detail: 'empty message body' };
    }
    return { outcome: 'sent', externalRef: simulatedProviderRef(request.sendId) };
  },
};

/**
 * A LEAD ARRIVING FROM OUTSIDE. The marketplace/website shape: a payload the
 * platform did not write, which must be normalized before it can become a lead.
 */
export interface ProviderLeadPayload {
  readonly externalId?: string | undefined;
  readonly givenName?: string | undefined;
  readonly familyName?: string | undefined;
  readonly email?: string | undefined;
  readonly phone?: string | undefined;
  readonly comment?: string | undefined;
  readonly vin?: string | undefined;
}

/**
 * The fingerprint an intake records instead of the payload. A person's contact
 * details and free-text comment do not belong in an intake ledger; the shape
 * does, because that is what recognises a redelivery.
 */
export function payloadFingerprint(payload: ProviderLeadPayload): string {
  const canonical = JSON.stringify({
    externalId: payload.externalId ?? null,
    givenName: payload.givenName ?? null,
    familyName: payload.familyName ?? null,
    email: (payload.email ?? '').trim().toLowerCase() || null,
    phone: (payload.phone ?? '').replace(/[^0-9+]/g, '') || null,
    vin: (payload.vin ?? '').trim().toUpperCase() || null,
    comment: payload.comment ?? null,
  });
  return createHash('sha256').update(canonical).digest('hex');
}
