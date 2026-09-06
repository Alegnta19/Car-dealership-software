/**
 * OUTCOME 5 — THE PROVIDER'S CALLBACKS: SIGNED, IDEMPOTENT, REPLAY-SAFE, RECONCILABLE.
 *
 * A callback is a claim from outside about a ceremony inside. Four things are
 * true of every one before it changes anything:
 *
 *   SIGNED. The raw request body carries an HMAC-SHA256 under a shared secret
 *   the deployment configures; a body whose signature does not verify — or a
 *   deployment with no secret configured — is refused before it is parsed for
 *   meaning, and the refusal records nothing, because nothing about an
 *   unverified body can be trusted, including the tenant it names.
 *
 *   IDEMPOTENT AND REPLAY-SAFE. The provider's own event reference is the
 *   second half of `UNIQUE (tenant_id, provider_event_ref)` on the event
 *   ledger. The second delivery of one callback lands on `ON CONFLICT DO
 *   NOTHING`, is answered `replayed`, and leaves exactly one row.
 *
 *   RECONCILABLE. The claim is recorded beside what this platform itself
 *   holds. With the deterministic simulator behind the ceremony, signatures
 *   are captured in-process and this ledger is authoritative; a callback that
 *   says the envelope is completed while our signers are not all signed is
 *   recorded as a DISAGREEMENT, changes no state, and surfaces on the board's
 *   provider-failure queue for a person to look at. An integrated provider
 *   would carry the signature result in on this same path and be applied by
 *   the same replay-safe write — which is why the ledger exists before the
 *   provider does.
 *
 *   BOUND. The callback names the tenant and ceremony in the metadata this
 *   platform set when it created the envelope, and the envelope reference must
 *   match the one the ceremony recorded. A callback about an envelope this
 *   ceremony never had is unknown, not applied.
 */
import { withTenantTransaction } from '@dealer/database';

import {
  CEREMONY_COLUMNS,
  mapCeremony,
  signersOfCeremonyWithin,
  type CeremonyView,
} from './ceremony';
import { digestsEqual, hmacSha256Hex } from './hashing';

interface Row {
  [key: string]: unknown;
}

export const PROVIDER_SIGNATURE_HEADER = 'x-esign-signature';
export const PROVIDER_EVENT_HEADER = 'x-esign-event-id';

/** `sha256=<hex>` over the raw body. Anything else is not a signature. */
export function verifyProviderSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string | null,
): 'valid' | 'invalid' | 'unconfigured' {
  if (secret === null || secret.length === 0) return 'unconfigured';
  if (signatureHeader === undefined) return 'invalid';
  const m = /^sha256=([0-9a-f]{64})$/i.exec(signatureHeader.trim());
  if (m === null) return 'invalid';
  return digestsEqual(hmacSha256Hex(secret, rawBody), m[1]!.toLowerCase()) ? 'valid' : 'invalid';
}

/** For a caller (a test, a simulator) that must SIGN a body the way the provider would. */
export function signProviderBody(secret: string, rawBody: Buffer | string): string {
  return `sha256=${hmacSha256Hex(secret, rawBody)}`;
}

export type ProviderClaimedState =
  'sent' | 'viewed' | 'in_progress' | 'completed' | 'declined' | 'expired';

const CLAIMED_STATES: readonly ProviderClaimedState[] = [
  'sent',
  'viewed',
  'in_progress',
  'completed',
  'declined',
  'expired',
];

export interface ProviderCallback {
  readonly tenantId: string;
  readonly ceremonyId: string;
  readonly envelopeRef: string;
  readonly providerEventRef: string;
  readonly eventType: string;
  readonly claimedState: ProviderClaimedState;
  readonly occurredAt: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The body, read for what it names and refused for anything it does not. */
export function parseProviderCallback(body: unknown): ProviderCallback | { error: string } {
  if (typeof body !== 'object' || body === null) return { error: 'a callback is a JSON object' };
  const b = body as Row;
  const metadata = (typeof b.metadata === 'object' && b.metadata !== null ? b.metadata : {}) as Row;
  const tenantId = String(metadata.tenant_id ?? '');
  const ceremonyId = String(metadata.ceremony_id ?? '');
  if (!UUID_RE.test(tenantId) || !UUID_RE.test(ceremonyId)) {
    return { error: 'a callback carries the metadata this platform set on the envelope' };
  }
  const envelopeRef = String(b.envelope_ref ?? '');
  const providerEventRef = String(b.event_id ?? '');
  const eventType = String(b.event_type ?? '');
  const claimedState = String(b.envelope_status ?? '') as ProviderClaimedState;
  if (envelopeRef.length === 0 || envelopeRef.length > 200)
    return { error: 'a callback names its envelope' };
  if (providerEventRef.length === 0 || providerEventRef.length > 200)
    return { error: 'a callback carries the provider’s own event id' };
  if (!/^[a-z0-9_.]{2,60}$/.test(eventType)) return { error: 'a callback names its event type' };
  if (!CLAIMED_STATES.includes(claimedState)) {
    return { error: `envelope_status is one of ${CLAIMED_STATES.join(', ')}` };
  }
  const occurredAt = String(b.occurred_at ?? '');
  if (Number.isNaN(Date.parse(occurredAt))) return { error: 'a callback says when it happened' };
  return {
    tenantId: tenantId.toLowerCase(),
    ceremonyId: ceremonyId.toLowerCase(),
    envelopeRef,
    providerEventRef,
    eventType,
    claimedState,
    occurredAt: new Date(occurredAt).toISOString(),
  };
}

export type CallbackOutcome =
  | {
      outcome: 'recorded';
      ceremony: CeremonyView;
      reconciliation: 'agrees' | 'disagrees';
      eventId: string;
    }
  | { outcome: 'replayed'; ceremony: CeremonyView }
  | { outcome: 'unknown_envelope' };

/** What our own ledger says, in the provider's vocabulary, so the two can be compared. */
function ourStateAsClaimed(
  ceremony: CeremonyView,
  signers: readonly { state: string }[],
): ProviderClaimedState {
  switch (ceremony.state) {
    case 'completed':
      return 'completed';
    case 'declined':
      return 'declined';
    case 'expired':
      return 'expired';
    case 'voided':
      return 'expired';
    case 'in_progress':
      return 'in_progress';
    case 'sent':
    case 'created':
    default:
      return signers.some((s) => s.state === 'viewed' || s.state === 'consented')
        ? 'viewed'
        : 'sent';
  }
}

/**
 * Record one verified callback. Writes at most one ledger row; changes no
 * ceremony state, because the simulator's signatures are captured in-process
 * and the ledger is what the board reconciles against.
 */
export async function recordProviderCallback(callback: ProviderCallback): Promise<CallbackOutcome> {
  return withTenantTransaction(callback.tenantId, async (tx) => {
    const found = await tx.query(
      `SELECT ${CEREMONY_COLUMNS} FROM signing_ceremonies
        WHERE tenant_id = $1 AND ceremony_id = $2 FOR UPDATE`,
      [callback.tenantId, callback.ceremonyId],
    );
    if (found.rows.length === 0) return { outcome: 'unknown_envelope' };
    const ceremony = mapCeremony(found.rows[0] as Row);
    if (ceremony.providerEnvelopeRef !== callback.envelopeRef)
      return { outcome: 'unknown_envelope' };

    const signers = await signersOfCeremonyWithin(tx, callback.tenantId, ceremony.ceremonyId);
    const ours = ourStateAsClaimed(ceremony, signers);
    const reconciliation: 'agrees' | 'disagrees' =
      ours === callback.claimedState ? 'agrees' : 'disagrees';

    // THE REPLAY GUARD IS THE UNIQUE KEY. Nothing here pre-checks it: a
    // pre-check is exactly the window a second delivery slips through.
    const written = await tx.query(
      `INSERT INTO ceremony_events
         (tenant_id, ceremony_id, signer_id, event_type, lane, actor_user_link_id, payload,
          provider_event_ref, provider_signature_valid, occurred_at)
       VALUES ($1, $2, NULL, $3, 'provider', NULL, $4::jsonb, $5, TRUE, $6::timestamptz)
       ON CONFLICT (tenant_id, provider_event_ref) DO NOTHING
       RETURNING event_id`,
      [
        callback.tenantId,
        ceremony.ceremonyId,
        `provider.${callback.eventType}`,
        JSON.stringify({
          envelope_ref: callback.envelopeRef,
          claimed_state: callback.claimedState,
          our_state: ours,
          reconciliation,
        }),
        callback.providerEventRef,
        callback.occurredAt,
      ],
    );
    if (written.rows.length === 0) return { outcome: 'replayed', ceremony };
    return {
      outcome: 'recorded',
      ceremony,
      reconciliation,
      eventId: String((written.rows[0] as Row).event_id),
    };
  });
}
