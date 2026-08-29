/**
 * RELEASE TRAIN 3, ROW 4 — RECORDING PERMISSION AND ITS WITHDRAWAL.
 *
 * `consent.ts` answers "may we contact this person"; this file is how the
 * answer gets there. It is a separate module because the gate is read on every
 * send and the writes are rare, and because the gate must stay small enough to
 * be obviously correct.
 *
 * TWO SHAPES, AND THEY ARE NOT THE SAME SHAPE:
 *
 *   * CONSENT is about a PERSON and is upserted per (channel, purpose) — the
 *     current standing of a relationship, whose history lives in the audit
 *     trail.
 *   * SUPPRESSION is about a CONTACT VALUE and is appended. It deliberately
 *     outlives the record it was made against: merging, archiving or
 *     re-creating a customer must not quietly restore contact to an address
 *     somebody asked to be left alone.
 */
import { withTenantTransaction, type Executor } from '@dealer/database';
import { recordMutation, requireActor, type MutationResult } from '@dealer/identity-access';
import {
  CONSENT_PURPOSES,
  normalizeContact,
  type ConsentChannel,
  type ConsentPurpose,
  type ConsentState,
  type SuppressionKind,
  type SuppressionReason,
} from './consent';

interface Row {
  [key: string]: unknown;
}

export interface ConsentRecord {
  readonly channel: ConsentChannel;
  readonly purpose: ConsentPurpose;
  readonly state: ConsentState;
  readonly source: string;
  readonly capturedAt: string;
}

export type ConsentOutcome =
  | { outcome: 'saved'; consents: ConsentRecord[]; mutation: MutationResult }
  | { outcome: 'not_found' }
  | { outcome: 'invalid'; error: string };

async function readConsents(
  executor: Executor,
  tenantId: string,
  partyId: string,
): Promise<ConsentRecord[]> {
  const found = await executor.query(
    `SELECT channel, purpose, state, source, captured_at FROM party_purpose_consents
      WHERE tenant_id = $1 AND party_id = $2 ORDER BY channel, purpose`,
    [tenantId, partyId],
  );
  return (found.rows as Row[]).map((r) => ({
    channel: String(r.channel) as ConsentChannel,
    purpose: String(r.purpose) as ConsentPurpose,
    state: String(r.state) as ConsentState,
    source: String(r.source),
    capturedAt: new Date(r.captured_at as string).toISOString(),
  }));
}

export async function listPurposeConsents(
  tenantId: string,
  partyId: string,
): Promise<ConsentRecord[]> {
  return withTenantTransaction(tenantId, (tx) => readConsents(tx, tenantId, partyId));
}

/**
 * Records consent for one channel and one purpose. Upsert rather than insert:
 * a customer who withdraws and later re-grants has one row per pair showing
 * where they stand now, and the audit trail carries how they got there.
 */
export async function setPurposeConsent(input: {
  actingUserLinkId: string;
  tenantId: string;
  partyId: string;
  channel: ConsentChannel;
  purpose: ConsentPurpose;
  state: ConsentState;
  source: string;
}): Promise<ConsentOutcome> {
  if (!['email', 'sms', 'phone', 'postal'].includes(input.channel)) {
    return { outcome: 'invalid', error: `unknown channel ${input.channel}` };
  }
  if (!CONSENT_PURPOSES.includes(input.purpose)) {
    return { outcome: 'invalid', error: `unknown purpose ${input.purpose}` };
  }
  if (!['granted', 'withdrawn', 'unknown'].includes(input.state)) {
    return { outcome: 'invalid', error: `unknown consent state ${input.state}` };
  }
  const source = (input.source ?? '').trim();
  if (source.length === 0 || source.length > 100) {
    return { outcome: 'invalid', error: 'consent must record where it came from' };
  }
  return withTenantTransaction(input.tenantId, async (tx) => {
    const actor = await requireActor(tx, input.actingUserLinkId);
    const party = await tx.query(
      `SELECT status FROM parties WHERE tenant_id = $1 AND party_id = $2`,
      [input.tenantId, input.partyId],
    );
    if (party.rows.length === 0) return { outcome: 'not_found' as const };
    if (String((party.rows[0] as Row).status) !== 'active') {
      return { outcome: 'invalid' as const, error: 'consent belongs to a live customer' };
    }
    const written = await tx.query(
      `INSERT INTO party_purpose_consents
         (tenant_id, party_id, channel, purpose, state, source, updated_by_user_link_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (tenant_id, party_id, channel, purpose) DO UPDATE
         SET state = EXCLUDED.state, source = EXCLUDED.source, captured_at = NOW(),
             updated_at = NOW(), updated_by_user_link_id = EXCLUDED.updated_by_user_link_id,
             authorization_version = party_purpose_consents.authorization_version + 1
       RETURNING authorization_version`,
      [input.tenantId, input.partyId, input.channel, input.purpose, input.state, source, actor],
    );
    const mutation = await recordMutation(tx, {
      tenantId: input.tenantId,
      entityType: 'party_purpose_consent',
      entityId: input.partyId,
      eventType: 'crm.consent.recorded',
      actingUserLinkId: actor,
      authorizationVersion: Number((written.rows[0] as Row).authorization_version),
      // The administrative facts only. What the customer said, and the address
      // they said it about, stay out of the audit trail.
      details: { channel: input.channel, purpose: input.purpose, state: input.state },
    });
    return {
      outcome: 'saved' as const,
      consents: await readConsents(tx, input.tenantId, input.partyId),
      mutation,
    };
  });
}

// ── suppression ─────────────────────────────────────────────────────────────

const SUPPRESSION_COLUMNS = `suppression_id, contact_kind, contact_value, reason, party_id,
       state, created_at, authorization_version`;

export interface SuppressionView {
  readonly suppressionId: string;
  readonly contactKind: SuppressionKind;
  readonly contactValue: string;
  readonly reason: SuppressionReason;
  readonly state: 'active' | 'lifted';
  readonly partyId: string | null;
  readonly createdAt: string;
  readonly authorizationVersion: number;
}

function mapSuppression(row: Row): SuppressionView {
  return {
    suppressionId: String(row.suppression_id),
    contactKind: String(row.contact_kind) as SuppressionKind,
    contactValue: String(row.contact_value),
    reason: String(row.reason) as SuppressionReason,
    state: String(row.state) as 'active' | 'lifted',
    partyId: row.party_id === null ? null : String(row.party_id),
    createdAt: new Date(row.created_at as string).toISOString(),
    authorizationVersion: Number(row.authorization_version),
  };
}

export type SuppressOutcome =
  | { outcome: 'suppressed'; suppression: SuppressionView; mutation: MutationResult }
  | { outcome: 'already_suppressed'; suppression: SuppressionView }
  | { outcome: 'invalid'; error: string };

/**
 * Adds a contact value to the suppression list INSIDE the caller's transaction,
 * so an opt-out recorded while reconciling a campaign reply is part of the same
 * commit as the reply that carried it.
 *
 * A repeat opt-out is not an error. Someone who unsubscribes twice has said the
 * same true thing twice; the second converges on the first rather than failing,
 * which is what makes a redelivered provider webhook safe.
 */
export async function suppressContactWithin(
  executor: Executor,
  input: {
    actingUserLinkId: string;
    tenantId: string;
    contactKind: SuppressionKind;
    contactValue: string;
    reason: SuppressionReason;
    partyId?: string | null | undefined;
  },
): Promise<SuppressOutcome> {
  const value = normalizeContact(input.contactKind, input.contactValue);
  if (value === null) return { outcome: 'invalid', error: 'that contact value is not usable' };
  const actor = await requireActor(executor, input.actingUserLinkId);

  const existing = await executor.query(
    `SELECT ${SUPPRESSION_COLUMNS} FROM contact_suppressions
      WHERE tenant_id = $1 AND contact_kind = $2 AND contact_value = $3 AND state = 'active'`,
    [input.tenantId, input.contactKind, value],
  );
  if (existing.rows.length > 0) {
    return { outcome: 'already_suppressed', suppression: mapSuppression(existing.rows[0] as Row) };
  }

  const written = await executor.query(
    `INSERT INTO contact_suppressions
       (tenant_id, contact_kind, contact_value, reason, party_id,
        created_by_user_link_id, updated_by_user_link_id)
     VALUES ($1, $2, $3, $4, $5, $6, $6)
     RETURNING ${SUPPRESSION_COLUMNS}`,
    [input.tenantId, input.contactKind, value, input.reason, input.partyId ?? null, actor],
  );
  const suppression = mapSuppression(written.rows[0] as Row);
  const mutation = await recordMutation(executor, {
    tenantId: input.tenantId,
    entityType: 'contact_suppression',
    entityId: suppression.suppressionId,
    eventType: 'crm.contact.suppressed',
    actingUserLinkId: actor,
    authorizationVersion: suppression.authorizationVersion,
    // The KIND and the REASON, never the address. An audit trail that records
    // what somebody unsubscribed is an audit trail holding the very contact
    // detail the unsubscribe was about.
    details: { contact_kind: input.contactKind, reason: input.reason },
  });
  return { outcome: 'suppressed', suppression, mutation };
}

export async function suppressContact(input: {
  actingUserLinkId: string;
  tenantId: string;
  contactKind: SuppressionKind;
  contactValue: string;
  reason: SuppressionReason;
  partyId?: string | null | undefined;
}): Promise<SuppressOutcome> {
  return withTenantTransaction(input.tenantId, (tx) => suppressContactWithin(tx, input));
}

export async function listSuppressions(tenantId: string, limit = 100): Promise<SuppressionView[]> {
  const bounded = Math.min(Math.max(limit, 1), 500);
  return withTenantTransaction(tenantId, async (tx) => {
    const found = await tx.query(
      `SELECT ${SUPPRESSION_COLUMNS} FROM contact_suppressions
        WHERE tenant_id = $1 AND state = 'active'
        ORDER BY created_at DESC LIMIT $2`,
      [tenantId, bounded],
    );
    return (found.rows as Row[]).map(mapSuppression);
  });
}
