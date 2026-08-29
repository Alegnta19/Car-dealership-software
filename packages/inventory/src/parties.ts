/**
 * RELEASE TRAIN 2, ROW 1 — THE ACQUISITION PARTY.
 *
 * The person or organization a vehicle is acquired from. This is the minimum
 * customer identity an acquisition needs, and the order is explicit that it
 * stops there: no lead, no campaign, no follow-up, no sales workflow.
 *
 * FOUR PROPERTIES THIS FILE IS RESPONSIBLE FOR:
 *
 *   * CONSENT IS OPT-IN EVIDENCE. A channel with no row is UNKNOWN, and
 *     unknown is not permission. `contactableOn` answers the only question a
 *     caller should ask, so no caller has to remember that rule.
 *   * DUPLICATES ARE DECIDED, NOT GUESSED AT. The decision is made under a
 *     transaction-scoped advisory lock on the normalized contact values, taken
 *     in a stable order, so two requests carrying the same email cannot both
 *     look, both find nothing, and both write. One creates and the other is
 *     told it is a duplicate, and the refusal names who it collided with.
 *     Migration 062's `uq_parties_unshared_*` indexes are the backstop
 *     underneath that — unique across the active parties nobody overrode — and
 *     a 23505 from them is translated back into the same 'duplicate' answer
 *     rather than escaping as a database error.
 *   * SHARING CONTACT DETAILS IS A DECISION SOMEONE MAKES, not a thing that
 *     merely happens. A household shares an inbox and a landline, so the
 *     second record is creatable — but only when a human passes the explicit
 *     override, and the override is written into `audit_events` naming the
 *     parties it concerns and which field is shared. Never the values.
 *   * A MERGE PRESERVES BOTH RECORDS. The absorbed party is not deleted: it
 *     keeps its row, its identifiers and its history, and gains a pointer to
 *     the survivor. Relationships are repointed, the survivor adopts consents
 *     it did not have, and a `party_merges` row records what moved. That is
 *     what makes the merge reversible in evidence even though the platform
 *     offers no un-merge.
 *   * EVERY WRITE IS ATTRIBUTED AND VERSIONED, through the same
 *     requireActor / recordMutation / authorization_version envelope every
 *     other owned mutation in this repository uses.
 */
import { withTenantTransaction, type Executor } from '@dealer/database';
import { recordMutation, requireActor, type MutationResult } from '@dealer/identity-access';

interface Row {
  [key: string]: unknown;
}

// ── views ───────────────────────────────────────────────────────────────────

export type PartyType = 'person' | 'organization';
export type PartyStatus = 'active' | 'merged' | 'archived';
export type ConsentChannel = 'email' | 'sms' | 'phone' | 'postal';
export type ConsentState = 'granted' | 'withdrawn' | 'unknown';

export const CONSENT_CHANNELS: readonly ConsentChannel[] = ['email', 'sms', 'phone', 'postal'];

export interface PartyView {
  readonly partyId: string;
  readonly partyType: PartyType;
  readonly displayName: string;
  readonly givenName: string | null;
  readonly familyName: string | null;
  readonly organizationName: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly addressLine1: string | null;
  readonly addressCity: string | null;
  readonly addressRegion: string | null;
  readonly addressPostalCode: string | null;
  readonly addressCountry: string | null;
  readonly status: PartyStatus;
  readonly mergedIntoPartyId: string | null;
  /** A human decided this record may share contact details with another. */
  readonly contactSharingOverride: boolean;
  readonly authorizationVersion: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ConsentView {
  readonly channel: ConsentChannel;
  readonly state: ConsentState;
  readonly source: string;
  readonly capturedAt: string;
  readonly note: string | null;
}

export interface PartyDetails {
  readonly displayName?: string | undefined;
  readonly givenName?: string | null | undefined;
  readonly familyName?: string | null | undefined;
  readonly organizationName?: string | null | undefined;
  readonly email?: string | null | undefined;
  readonly phone?: string | null | undefined;
  readonly addressLine1?: string | null | undefined;
  readonly addressCity?: string | null | undefined;
  readonly addressRegion?: string | null | undefined;
  readonly addressPostalCode?: string | null | undefined;
  readonly addressCountry?: string | null | undefined;
}

// ── normalization ───────────────────────────────────────────────────────────

/** Digits, with an optional leading '+'. Everything else a human types is noise. */
export function normalizePhone(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const plus = trimmed.startsWith('+');
  const digits = trimmed.replace(/[^0-9]/g, '');
  if (digits.length < 7 || digits.length > 15) return null;
  return (plus ? '+' : '') + digits;
}

/** Lower-cased and trimmed. Comparison and storage use the same form. */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.length < 3 || trimmed.length > 320 || !trimmed.includes('@')) return null;
  return trimmed;
}

/**
 * The name shown to staff: an organization is its organization name, a person
 * is their given and family names, and a party with neither is refused before
 * it reaches the database.
 */
export function partyDisplayName(input: {
  partyType: PartyType;
  givenName?: string | null | undefined;
  familyName?: string | null | undefined;
  organizationName?: string | null | undefined;
  displayName?: string | null | undefined;
}): string | null {
  if (typeof input.displayName === 'string' && input.displayName.trim().length > 0) {
    return input.displayName.trim().slice(0, 200);
  }
  if (input.partyType === 'organization') {
    const name = (input.organizationName ?? '').trim();
    return name.length > 0 ? name.slice(0, 200) : null;
  }
  const person = [input.givenName ?? '', input.familyName ?? '']
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .join(' ');
  return person.length > 0 ? person.slice(0, 200) : null;
}

function mapParty(row: Row): PartyView {
  return {
    partyId: String(row.party_id),
    partyType: String(row.party_type) as PartyType,
    displayName: String(row.display_name),
    givenName: row.given_name === null ? null : String(row.given_name),
    familyName: row.family_name === null ? null : String(row.family_name),
    organizationName: row.organization_name === null ? null : String(row.organization_name),
    email: row.email === null ? null : String(row.email),
    phone: row.phone === null ? null : String(row.phone),
    addressLine1: row.address_line1 === null ? null : String(row.address_line1),
    addressCity: row.address_city === null ? null : String(row.address_city),
    addressRegion: row.address_region === null ? null : String(row.address_region),
    addressPostalCode: row.address_postal_code === null ? null : String(row.address_postal_code),
    addressCountry: row.address_country === null ? null : String(row.address_country),
    status: String(row.status) as PartyStatus,
    mergedIntoPartyId: row.merged_into_party_id === null ? null : String(row.merged_into_party_id),
    contactSharingOverride: row.contact_sharing_override === true,
    authorizationVersion: Number(row.authorization_version),
    createdAt: new Date(row.created_at as string).toISOString(),
    updatedAt: new Date(row.updated_at as string).toISOString(),
  };
}

const PARTY_COLUMNS = `party_id, party_type, display_name, given_name, family_name,
       organization_name, email, phone, address_line1, address_city, address_region,
       address_postal_code, address_country, status, merged_into_party_id,
       contact_sharing_override, authorization_version, created_at, updated_at`;

// ── duplicate detection ─────────────────────────────────────────────────────

export interface DuplicateCandidate {
  readonly party: PartyView;
  /** Which identifying fact matched — what a human needs to judge the answer. */
  readonly matchedOn: 'email' | 'phone';
}

// THE UNLOCKED SEARCH THAT USED TO LIVE HERE IS GONE (RT2-C1 §1).
//
// `findDuplicateCandidates` read the same rows as `identifyingCollisions`
// below, but without the advisory lock — it was the read half of the
// read-then-write that let two concurrent creates both find nothing. Once the
// decision moved under the lock, nothing called it, and an exported helper
// named "find duplicate candidates" sitting beside the real gate is a trap: it
// looks like the duplicate check, and calling it instead reintroduces exactly
// the defect this correction removed.
//
// Its one distinguishing feature was a NAME arm — same display name, offered
// as a suggestion rather than a collision. Nothing ever saw it: both call
// sites filtered name matches out before returning, so it was computed and
// discarded on every request. Staff search for people through
// `searchParties`, which is what the customers screen actually calls.

// ── the collision decision ──────────────────────────────────────────────────

/**
 * SERIALIZE THE DECISION, IN A STABLE ORDER.
 *
 * A duplicate check that reads and then writes is not a decision — it is a
 * guess, and two requests carrying the same email can both make it, both find
 * nothing, and both write. Every path that decides whether a contact value is
 * already taken takes a TRANSACTION-SCOPED ADVISORY LOCK on that value first,
 * so competing decisions queue instead of racing: the loser's re-read happens
 * after the winner has committed, and sees it.
 *
 * The keys are SORTED before they are taken. A create naming both an email and
 * a phone needs two locks, and two such creates that took them in opposite
 * orders would deadlock. Sorting the fully-qualified key strings gives every
 * caller in the cluster one order, so they queue rather than collide.
 *
 * The lock is advisory rather than a row lock because the row being protected
 * is the one that does NOT exist yet — there is nothing to lock but the value.
 * It is transaction-scoped, so it is released by COMMIT or ROLLBACK and a
 * failed request cannot strand it.
 */
async function lockContactDecision(
  executor: Executor,
  tenantId: string,
  email: string | null,
  phone: string | null,
): Promise<void> {
  const keys: string[] = [];
  if (email !== null) keys.push(`party-contact:${tenantId}:email:${email}`);
  if (phone !== null) keys.push(`party-contact:${tenantId}:phone:${phone}`);
  keys.sort();
  for (const key of keys) {
    await executor.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
  }
}

/**
 * The ACTIVE parties whose identifying contact details this write would
 * collide with — email and phone only, never a name, and never the party
 * being written itself. Call it holding `lockContactDecision`.
 */
async function identifyingCollisions(
  executor: Executor,
  tenantId: string,
  email: string | null,
  phone: string | null,
  excludePartyId: string | null,
): Promise<DuplicateCandidate[]> {
  if (email === null && phone === null) return [];
  const found = await executor.query(
    `SELECT ${PARTY_COLUMNS},
            CASE WHEN $2::text IS NOT NULL AND lower(email) = $2 THEN 'email' ELSE 'phone' END
              AS matched_on
       FROM parties
      WHERE tenant_id = $1
        AND status = 'active'
        AND ($4::uuid IS NULL OR party_id <> $4)
        AND ( ($2::text IS NOT NULL AND lower(email) = $2)
           OR ($3::text IS NOT NULL AND phone = $3) )
      ORDER BY party_id
      LIMIT 25`,
    [tenantId, email, phone, excludePartyId],
  );
  return (found.rows as Row[]).map((r) => ({
    party: mapParty(r),
    matchedOn: String(r.matched_on) as 'email' | 'phone',
  }));
}

/**
 * What the audit trail records when staff deliberately let two records share
 * contact details. BOUNDED IDENTIFIERS AND FIELD NAMES ONLY: which parties,
 * and which of email/phone is shared. The customer's actual address and number
 * stay in the row where they belong — an override is a fact about a decision,
 * not an excuse to copy contact details into the audit trail.
 */
function overrideEvidence(
  collisions: DuplicateCandidate[],
  email: string | null,
  phone: string | null,
): Record<string, unknown> {
  // The fields are compared rather than read off `matchedOn`. That label
  // carries ONE reason per candidate because it exists to tell staff why a
  // record was suggested; a record that shares both an inbox and a landline
  // would be reported as sharing only the inbox, and an audit entry that
  // understates what was overridden is worse than none.
  const fields = new Set<string>();
  for (const c of collisions) {
    if (email !== null && c.party.email !== null && c.party.email.toLowerCase() === email) {
      fields.add('email');
    }
    if (phone !== null && c.party.phone === phone) fields.add('phone');
  }
  return {
    contact_sharing_override: true,
    shared_contact_fields: [...fields].sort(),
    shared_contact_with_party_ids: collisions.map((c) => c.party.partyId).slice(0, 10),
    shared_contact_party_count: collisions.length,
  };
}

// ── reads ───────────────────────────────────────────────────────────────────

export async function getParty(tenantId: string, partyId: string): Promise<PartyView | null> {
  return withTenantTransaction(tenantId, async (tx) => {
    const found = await tx.query(
      `SELECT ${PARTY_COLUMNS} FROM parties WHERE tenant_id = $1 AND party_id = $2`,
      [tenantId, partyId],
    );
    return found.rows.length === 0 ? null : mapParty(found.rows[0] as Row);
  });
}

export async function listPartyConsents(tenantId: string, partyId: string): Promise<ConsentView[]> {
  return withTenantTransaction(tenantId, async (tx) => {
    const found = await tx.query(
      `SELECT channel, state, source, captured_at, note FROM party_consents
        WHERE tenant_id = $1 AND party_id = $2 ORDER BY channel`,
      [tenantId, partyId],
    );
    return (found.rows as Row[]).map((r) => ({
      channel: String(r.channel) as ConsentChannel,
      state: String(r.state) as ConsentState,
      source: String(r.source),
      capturedAt: new Date(r.captured_at as string).toISOString(),
      note: r.note === null ? null : String(r.note),
    }));
  });
}

/**
 * Whether this party may be contacted on this channel. A missing row is
 * UNKNOWN and UNKNOWN IS NOT PERMISSION — the whole point of asking here
 * rather than inspecting the rows at each call site.
 */
export async function contactableOn(
  tenantId: string,
  partyId: string,
  channel: ConsentChannel,
): Promise<boolean> {
  const consents = await listPartyConsents(tenantId, partyId);
  return consents.some((c) => c.channel === channel && c.state === 'granted');
}

export interface PartySearchResult {
  readonly parties: PartyView[];
  readonly total: number;
}

/**
 * Staff search. Matches a name fragment, an email or a phone; merged and
 * archived parties are excluded unless asked for, because a merged record is
 * history rather than a person to transact with.
 */
export async function searchParties(
  tenantId: string,
  input: {
    query?: string | null | undefined;
    includeInactive?: boolean | undefined;
    limit?: number | undefined;
  },
): Promise<PartySearchResult> {
  const limit = Math.min(Math.max(input.limit ?? 25, 1), 100);
  const raw = (input.query ?? '').trim();
  const like = raw.length > 0 ? `%${raw.toLowerCase()}%` : null;
  const phone = normalizePhone(raw);
  return withTenantTransaction(tenantId, async (tx) => {
    const predicate = `tenant_id = $1
        AND ($2::boolean OR status = 'active')
        AND ( $3::text IS NULL
           OR lower(display_name) LIKE $3
           OR lower(email) LIKE $3
           OR ($4::text IS NOT NULL AND phone = $4) )`;
    const [rows, count] = await Promise.all([
      tx.query(
        `SELECT ${PARTY_COLUMNS} FROM parties WHERE ${predicate}
          ORDER BY lower(display_name) LIMIT $5`,
        [tenantId, input.includeInactive === true, like, phone, limit],
      ),
      tx.query(`SELECT COUNT(*)::int AS n FROM parties WHERE ${predicate}`, [
        tenantId,
        input.includeInactive === true,
        like,
        phone,
      ]),
    ]);
    return {
      parties: (rows.rows as Row[]).map(mapParty),
      total: Number((count.rows[0] as Row).n),
    };
  });
}

// ── writes ──────────────────────────────────────────────────────────────────

export type PartyCreateOutcome =
  | { outcome: 'created'; party: PartyView; mutation: MutationResult }
  | { outcome: 'duplicate'; candidates: DuplicateCandidate[] }
  | { outcome: 'invalid'; error: string };

interface PartyCreateInput {
  actingUserLinkId: string;
  tenantId: string;
  partyType: PartyType;
  details: PartyDetails;
  /** Create even though an identifying duplicate exists — a deliberate staff decision. */
  allowDuplicate?: boolean | undefined;
}

/** UNIQUE VIOLATION — the database's answer when the pre-check was skipped or raced. */
function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === '23505';
}

/**
 * Creates a party inside the CALLER'S transaction, so an acquisition can
 * create its seller and its stock record atomically.
 */
export async function createPartyWithin(
  executor: Executor,
  input: PartyCreateInput,
): Promise<PartyCreateOutcome> {
  const d = input.details;
  if (input.partyType !== 'person' && input.partyType !== 'organization') {
    return { outcome: 'invalid', error: 'party_type must be person or organization' };
  }
  const displayName = partyDisplayName({ partyType: input.partyType, ...d });
  if (displayName === null) {
    return {
      outcome: 'invalid',
      error:
        input.partyType === 'organization'
          ? 'an organization needs a name'
          : 'a person needs a given or family name',
    };
  }
  const email = normalizeEmail(d.email);
  const phone = normalizePhone(d.phone);
  if (
    d.email !== null &&
    d.email !== undefined &&
    String(d.email).trim() !== '' &&
    email === null
  ) {
    return { outcome: 'invalid', error: 'the email address is not usable' };
  }
  if (
    d.phone !== null &&
    d.phone !== undefined &&
    String(d.phone).trim() !== '' &&
    phone === null
  ) {
    return { outcome: 'invalid', error: 'the phone number is not usable' };
  }

  const actor = await requireActor(executor, input.actingUserLinkId);

  // THE DECISION, TAKEN UNDER A LOCK. Everything from here to the INSERT is
  // one indivisible judgement: a competing create carrying the same email
  // waits at `lockContactDecision` and reads the outcome of this one.
  await lockContactDecision(executor, input.tenantId, email, phone);
  const collisions = await identifyingCollisions(executor, input.tenantId, email, phone, null);
  // A NAME-ONLY match is a suggestion, not a collision: two customers may
  // genuinely share a name, and refusing that would make the platform
  // unusable. Only an identifying match stops the create — and only an
  // explicit staff override lets it through anyway.
  if (collisions.length > 0 && input.allowDuplicate !== true) {
    return { outcome: 'duplicate', candidates: collisions };
  }
  const sharing = collisions.length > 0;

  // The INSERT runs inside a SAVEPOINT so that a backstop violation — which
  // should now be unreachable through this function, and is kept handled
  // because "should be unreachable" is not a guarantee — leaves a transaction
  // the recovery read below can still run in. Without it a 23505 would poison
  // the caller's whole acquisition.
  await executor.query('SAVEPOINT party_insert');
  try {
    const written = await executor.query(
      `INSERT INTO parties
         (tenant_id, party_type, display_name, given_name, family_name, organization_name,
          email, phone, address_line1, address_city, address_region, address_postal_code,
          address_country, contact_sharing_override,
          created_by_user_link_id, updated_by_user_link_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $15)
       RETURNING ${PARTY_COLUMNS}`,
      [
        input.tenantId,
        input.partyType,
        displayName,
        d.givenName ?? null,
        d.familyName ?? null,
        input.partyType === 'organization' ? (d.organizationName ?? displayName) : null,
        email,
        phone,
        d.addressLine1 ?? null,
        d.addressCity ?? null,
        d.addressRegion ?? null,
        d.addressPostalCode ?? null,
        d.addressCountry ?? null,
        sharing,
        actor,
      ],
    );
    await executor.query('RELEASE SAVEPOINT party_insert');
    const party = mapParty(written.rows[0] as Row);
    const mutation = await recordMutation(executor, {
      tenantId: input.tenantId,
      entityType: 'party',
      entityId: party.partyId,
      eventType: 'inventory.party.created',
      actingUserLinkId: actor,
      authorizationVersion: party.authorizationVersion,
      // The party's NAME and CONTACT DETAILS are not written to the audit
      // trail: the row carries them, and an audit detail is not the place for
      // a customer's address. An OVERRIDE is different — that is a decision a
      // person made, and it is recorded as identifiers and field names.
      details: sharing
        ? { party_type: party.partyType, ...overrideEvidence(collisions, email, phone) }
        : { party_type: party.partyType },
    });
    return { outcome: 'created', party, mutation };
  } catch (err) {
    await executor.query('ROLLBACK TO SAVEPOINT party_insert');
    if (!isUniqueViolation(err)) throw err;
    // The backstop fired: something reached the table without this decision.
    // The database has just told us what the decision would have.
    return {
      outcome: 'duplicate',
      candidates: await identifyingCollisions(executor, input.tenantId, email, phone, null),
    };
  }
}

export async function createParty(input: PartyCreateInput): Promise<PartyCreateOutcome> {
  return withTenantTransaction(input.tenantId, (tx) => createPartyWithin(tx, input));
}

export type PartyUpdateOutcome =
  | { outcome: 'saved'; party: PartyView; mutation: MutationResult }
  | { outcome: 'version_conflict'; currentVersion: number }
  | { outcome: 'not_found' }
  | { outcome: 'duplicate'; candidates: DuplicateCandidate[] }
  | { outcome: 'invalid'; error: string };

/**
 * Updates a party under OPTIMISTIC CONCURRENCY: the caller states the version
 * it read, and a disagreement changes nothing and says so. A merged or
 * archived party is not editable — its record is history.
 *
 * RT2-C1 §1 — AN EDIT IS A WAY TO CREATE A DUPLICATE, and this path used to
 * have no opinion about that: it wrote, and relied on a database constraint
 * that had been removed, so retyping one customer's email onto another's
 * record silently produced two active parties sharing it. The same locked
 * collision decision the create path makes is made here, against the values
 * the row would END UP with, excluding the row itself. A refusal changes
 * nothing at all — the version is not consumed and the row is not touched.
 */
export async function updateParty(input: {
  actingUserLinkId: string;
  tenantId: string;
  partyId: string;
  expectedVersion: number;
  details: PartyDetails;
  /** Share contact details with another active party — a deliberate staff decision. */
  allowDuplicate?: boolean | undefined;
}): Promise<PartyUpdateOutcome> {
  return withTenantTransaction(input.tenantId, async (executor) => {
    const actor = await requireActor(executor, input.actingUserLinkId);
    const existing = await executor.query(
      `SELECT ${PARTY_COLUMNS} FROM parties
        WHERE tenant_id = $1 AND party_id = $2 FOR UPDATE`,
      [input.tenantId, input.partyId],
    );
    if (existing.rows.length === 0) return { outcome: 'not_found' as const };
    const current = mapParty(existing.rows[0] as Row);
    if (current.status !== 'active') {
      return { outcome: 'invalid' as const, error: `a ${current.status} party cannot be edited` };
    }
    if (current.authorizationVersion !== input.expectedVersion) {
      return {
        outcome: 'version_conflict' as const,
        currentVersion: current.authorizationVersion,
      };
    }

    const d = input.details;
    const displayName = partyDisplayName({
      partyType: current.partyType,
      givenName: d.givenName ?? current.givenName,
      familyName: d.familyName ?? current.familyName,
      organizationName: d.organizationName ?? current.organizationName,
      displayName: d.displayName ?? null,
    });
    if (displayName === null) return { outcome: 'invalid' as const, error: 'a party needs a name' };
    const email = d.email === undefined ? current.email : normalizeEmail(d.email);
    const phone = d.phone === undefined ? current.phone : normalizePhone(d.phone);

    // The same locked decision the create path makes, on the values this row
    // would end up carrying, and never against itself. The row is already held
    // by the FOR UPDATE above; the advisory lock is what serializes this
    // against a CREATE racing for the same contact value, which holds no row.
    await lockContactDecision(executor, input.tenantId, email, phone);
    const collisions = await identifyingCollisions(
      executor,
      input.tenantId,
      email,
      phone,
      input.partyId,
    );
    if (collisions.length > 0 && input.allowDuplicate !== true) {
      // NOTHING IS WRITTEN. The refusal is the whole outcome.
      return { outcome: 'duplicate' as const, candidates: collisions };
    }
    const sharing = collisions.length > 0;

    try {
      const written = await executor.query(
        `UPDATE parties
            SET display_name = $3, given_name = $4, family_name = $5, organization_name = $6,
                email = $7, phone = $8, address_line1 = $9, address_city = $10,
                address_region = $11, address_postal_code = $12, address_country = $13,
                contact_sharing_override = $16,
                updated_by_user_link_id = $14, updated_at = NOW(),
                authorization_version = authorization_version + 1
          WHERE tenant_id = $1 AND party_id = $2 AND authorization_version = $15
          RETURNING ${PARTY_COLUMNS}`,
        [
          input.tenantId,
          input.partyId,
          displayName,
          d.givenName === undefined ? current.givenName : d.givenName,
          d.familyName === undefined ? current.familyName : d.familyName,
          current.partyType === 'organization'
            ? (d.organizationName ?? current.organizationName ?? displayName)
            : null,
          email,
          phone,
          d.addressLine1 === undefined ? current.addressLine1 : d.addressLine1,
          d.addressCity === undefined ? current.addressCity : d.addressCity,
          d.addressRegion === undefined ? current.addressRegion : d.addressRegion,
          d.addressPostalCode === undefined ? current.addressPostalCode : d.addressPostalCode,
          d.addressCountry === undefined ? current.addressCountry : d.addressCountry,
          actor,
          input.expectedVersion,
          sharing,
        ],
      );
      if (written.rows.length === 0) {
        return {
          outcome: 'version_conflict' as const,
          currentVersion: current.authorizationVersion,
        };
      }
      const party = mapParty(written.rows[0] as Row);
      const mutation = await recordMutation(executor, {
        tenantId: input.tenantId,
        entityType: 'party',
        entityId: party.partyId,
        eventType: 'inventory.party.updated',
        actingUserLinkId: actor,
        authorizationVersion: party.authorizationVersion,
        details: sharing ? overrideEvidence(collisions, email, phone) : {},
      });
      return { outcome: 'saved' as const, party, mutation };
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      return {
        outcome: 'duplicate' as const,
        candidates: await identifyingCollisions(
          executor,
          input.tenantId,
          email,
          phone,
          input.partyId,
        ),
      };
    }
  });
}

export type ConsentOutcome =
  | { outcome: 'saved'; consents: ConsentView[]; mutation: MutationResult }
  | { outcome: 'not_found' }
  | { outcome: 'invalid'; error: string };

/**
 * Records consent for one channel. Upsert rather than insert: a customer who
 * withdraws and later re-grants has one row per channel showing where they
 * stand now, and the audit trail carries the history.
 */
export async function setPartyConsent(input: {
  actingUserLinkId: string;
  tenantId: string;
  partyId: string;
  channel: ConsentChannel;
  state: ConsentState;
  source: string;
  note?: string | null | undefined;
}): Promise<ConsentOutcome> {
  if (!CONSENT_CHANNELS.includes(input.channel)) {
    return { outcome: 'invalid', error: `unknown consent channel ${input.channel}` };
  }
  if (!['granted', 'withdrawn', 'unknown'].includes(input.state)) {
    return { outcome: 'invalid', error: `unknown consent state ${input.state}` };
  }
  const source = (input.source ?? '').trim();
  if (source.length === 0 || source.length > 100) {
    return { outcome: 'invalid', error: 'consent must record where it came from' };
  }
  return withTenantTransaction(input.tenantId, async (executor) => {
    const actor = await requireActor(executor, input.actingUserLinkId);
    const party = await executor.query(
      `SELECT status FROM parties WHERE tenant_id = $1 AND party_id = $2`,
      [input.tenantId, input.partyId],
    );
    if (party.rows.length === 0) return { outcome: 'not_found' as const };
    if (String((party.rows[0] as Row).status) !== 'active') {
      return { outcome: 'invalid' as const, error: 'consent belongs to a live party' };
    }
    await executor.query(
      `INSERT INTO party_consents
         (tenant_id, party_id, channel, state, source, note, updated_by_user_link_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (tenant_id, party_id, channel) DO UPDATE
         SET state = EXCLUDED.state, source = EXCLUDED.source, note = EXCLUDED.note,
             captured_at = NOW(), updated_at = NOW(),
             updated_by_user_link_id = EXCLUDED.updated_by_user_link_id,
             authorization_version = party_consents.authorization_version + 1`,
      [
        input.tenantId,
        input.partyId,
        input.channel,
        input.state,
        source,
        input.note ?? null,
        actor,
      ],
    );
    const version = await executor.query(
      `SELECT authorization_version FROM party_consents
        WHERE tenant_id = $1 AND party_id = $2 AND channel = $3`,
      [input.tenantId, input.partyId, input.channel],
    );
    const mutation = await recordMutation(executor, {
      tenantId: input.tenantId,
      entityType: 'party_consent',
      entityId: input.partyId,
      eventType: 'inventory.party.consent_recorded',
      actingUserLinkId: actor,
      authorizationVersion: Number((version.rows[0] as Row).authorization_version),
      // The CHANNEL and STATE are the administrative facts; the note may carry
      // whatever the customer said and is deliberately not audited.
      details: { channel: input.channel, state: input.state },
    });
    const consents = await executor.query(
      `SELECT channel, state, source, captured_at, note FROM party_consents
        WHERE tenant_id = $1 AND party_id = $2 ORDER BY channel`,
      [input.tenantId, input.partyId],
    );
    return {
      outcome: 'saved' as const,
      consents: (consents.rows as Row[]).map((r) => ({
        channel: String(r.channel) as ConsentChannel,
        state: String(r.state) as ConsentState,
        source: String(r.source),
        capturedAt: new Date(r.captured_at as string).toISOString(),
        note: r.note === null ? null : String(r.note),
      })),
      mutation,
    };
  });
}

// ── merge ───────────────────────────────────────────────────────────────────

export interface MergeSummary {
  readonly stockItemsRepointed: number;
  readonly consentsAdopted: number;
}

export type PartyMergeOutcome =
  | {
      outcome: 'merged';
      surviving: PartyView;
      merged: PartyView;
      summary: MergeSummary;
      mutation: MutationResult;
    }
  | { outcome: 'not_found' }
  | { outcome: 'invalid'; error: string };

/**
 * THE CONTROLLED MERGE.
 *
 * Both parties are locked, both must be live, and neither is deleted. What
 * moves is stated rather than implied:
 *
 *   1. every stock item acquired from the absorbed party is repointed at the
 *      survivor, so the acquisition history follows the customer;
 *   2. the survivor ADOPTS consent for any channel it has no answer for —
 *      never overwriting an answer it already has, because a newer 'withdrawn'
 *      must not be replaced by an older 'granted';
 *   3. the absorbed party becomes `merged`, keeps its identifiers and its
 *      contact values, and points at the survivor;
 *   4. a `party_merges` row records the pair, the actor and the counts.
 *
 * The absorbed party's contact values free their backstop slot because
 * `uq_parties_unshared_email` and `uq_parties_unshared_phone` are partial on
 * `status = 'active'` — which is what lets two records that duplicate an email
 * be merged at all.
 *
 * A merge deliberately does NOT recompute the survivor's
 * `contact_sharing_override`. If absorbing the other record leaves the
 * survivor as the only holder of that email, its flag may stay `true` and its
 * row simply remains outside the backstop index. Nothing weakens: the refusal
 * a duplicate meets is the LOCKED DECISION above, which reads every active
 * party regardless of the flag; the index only ever narrows what could reach
 * the table without that decision.
 */
export async function mergeParties(input: {
  actingUserLinkId: string;
  tenantId: string;
  survivingPartyId: string;
  mergedPartyId: string;
  reason?: string | null | undefined;
}): Promise<PartyMergeOutcome> {
  if (input.survivingPartyId === input.mergedPartyId) {
    return { outcome: 'invalid', error: 'a party cannot be merged into itself' };
  }
  return withTenantTransaction(input.tenantId, async (executor) => {
    const actor = await requireActor(executor, input.actingUserLinkId);
    // Locked in a STABLE ORDER so two merges naming the same pair in opposite
    // directions cannot deadlock.
    const ids = [input.survivingPartyId, input.mergedPartyId].sort();
    const locked = await executor.query(
      `SELECT ${PARTY_COLUMNS} FROM parties
        WHERE tenant_id = $1 AND party_id = ANY($2::uuid[])
        ORDER BY party_id FOR UPDATE`,
      [input.tenantId, ids],
    );
    if (locked.rows.length !== 2) return { outcome: 'not_found' as const };
    const rows = (locked.rows as Row[]).map(mapParty);
    const surviving = rows.find((p) => p.partyId === input.survivingPartyId);
    const merged = rows.find((p) => p.partyId === input.mergedPartyId);
    if (surviving === undefined || merged === undefined) return { outcome: 'not_found' as const };
    if (surviving.status !== 'active' || merged.status !== 'active') {
      return { outcome: 'invalid' as const, error: 'both parties must be active to merge' };
    }

    const repointed = await executor.query(
      `UPDATE stock_items
          SET acquisition_party_id = $2, updated_by_user_link_id = $4, updated_at = NOW(),
              authorization_version = authorization_version + 1
        WHERE tenant_id = $1 AND acquisition_party_id = $3
        RETURNING stock_item_id`,
      [input.tenantId, surviving.partyId, merged.partyId, actor],
    );

    const adopted = await executor.query(
      `INSERT INTO party_consents
         (tenant_id, party_id, channel, state, source, note, updated_by_user_link_id, captured_at)
       SELECT $1, $2, m.channel, m.state, m.source, m.note, $4, m.captured_at
         FROM party_consents m
        WHERE m.tenant_id = $1 AND m.party_id = $3
       ON CONFLICT (tenant_id, party_id, channel) DO NOTHING
       RETURNING channel`,
      [input.tenantId, surviving.partyId, merged.partyId, actor],
    );

    const absorbed = await executor.query(
      `UPDATE parties
          SET status = 'merged', merged_into_party_id = $2,
              updated_by_user_link_id = $4, updated_at = NOW(),
              authorization_version = authorization_version + 1
        WHERE tenant_id = $1 AND party_id = $3 AND status = 'active'
        RETURNING ${PARTY_COLUMNS}`,
      [input.tenantId, surviving.partyId, merged.partyId, actor],
    );
    if (absorbed.rows.length === 0) {
      return { outcome: 'invalid' as const, error: 'the absorbed party changed during the merge' };
    }

    const survivorAfter = await executor.query(
      `UPDATE parties
          SET updated_by_user_link_id = $3, updated_at = NOW(),
              authorization_version = authorization_version + 1
        WHERE tenant_id = $1 AND party_id = $2
        RETURNING ${PARTY_COLUMNS}`,
      [input.tenantId, surviving.partyId, actor],
    );

    const summary: MergeSummary = {
      stockItemsRepointed: repointed.rows.length,
      consentsAdopted: adopted.rows.length,
    };
    await executor.query(
      `INSERT INTO party_merges
         (tenant_id, surviving_party_id, merged_party_id, moved, reason, merged_by_user_link_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        input.tenantId,
        surviving.partyId,
        merged.partyId,
        JSON.stringify(summary),
        input.reason ?? null,
        actor,
      ],
    );

    const survivingView = mapParty(survivorAfter.rows[0] as Row);
    const mutation = await recordMutation(executor, {
      tenantId: input.tenantId,
      entityType: 'party',
      entityId: surviving.partyId,
      eventType: 'inventory.party.merged',
      actingUserLinkId: actor,
      authorizationVersion: survivingView.authorizationVersion,
      details: {
        merged_party_id: merged.partyId,
        stock_items_repointed: summary.stockItemsRepointed,
        consents_adopted: summary.consentsAdopted,
      },
    });
    return {
      outcome: 'merged' as const,
      surviving: survivingView,
      merged: mapParty(absorbed.rows[0] as Row),
      summary,
      mutation,
    };
  });
}

// ── import ──────────────────────────────────────────────────────────────────

export interface PartyImportRow {
  readonly partyType?: string | undefined;
  readonly displayName?: string | undefined;
  readonly givenName?: string | undefined;
  readonly familyName?: string | undefined;
  readonly organizationName?: string | undefined;
  readonly email?: string | undefined;
  readonly phone?: string | undefined;
}

export interface PartyImportOutcome {
  readonly index: number;
  readonly result: 'created' | 'duplicate' | 'invalid';
  readonly partyId: string | null;
  readonly detail: string | null;
}

export interface PartyImportSummary {
  readonly created: number;
  readonly duplicates: number;
  readonly invalid: number;
  readonly rows: PartyImportOutcome[];
}

/** How many rows one import may carry. Bounded so a paste cannot become a job. */
export const PARTY_IMPORT_LIMIT = 200;

/**
 * Bounded import.
 *
 * EVERY ROW IS JUDGED AND REPORTED, and the import as a whole never fails
 * because one row was a duplicate — that is the normal case when re-importing
 * a list. Rows are applied in ONE transaction so a caller that retries after
 * an infrastructure failure does not find half a list loaded; within it, a
 * duplicate is an outcome rather than an abort.
 */
export async function importParties(input: {
  actingUserLinkId: string;
  tenantId: string;
  rows: readonly PartyImportRow[];
}): Promise<PartyImportSummary | { error: string }> {
  if (!Array.isArray(input.rows) || input.rows.length === 0) {
    return { error: 'an import needs at least one row' };
  }
  if (input.rows.length > PARTY_IMPORT_LIMIT) {
    return { error: `an import carries at most ${PARTY_IMPORT_LIMIT} rows` };
  }
  return withTenantTransaction(input.tenantId, async (executor) => {
    // EVERY CONTACT VALUE IN THE BATCH IS LOCKED UP FRONT, in the one global
    // order `lockContactDecision` uses. Taking them row by row would let an
    // import holding row 3's phone wait on row 7's email while a concurrent
    // create held that email and waited on the phone — a genuine deadlock
    // between two callers that were each individually well-ordered. Locking
    // the whole batch first collapses the import to a single ordered acquirer.
    const batchEmails = new Set<string>();
    const batchPhones = new Set<string>();
    for (const row of input.rows) {
      const e = normalizeEmail(row.email);
      const p = normalizePhone(row.phone);
      if (e !== null) batchEmails.add(e);
      if (p !== null) batchPhones.add(p);
    }
    const batchKeys = [
      ...[...batchEmails].map((e) => `party-contact:${input.tenantId}:email:${e}`),
      ...[...batchPhones].map((p) => `party-contact:${input.tenantId}:phone:${p}`),
    ].sort();
    for (const key of batchKeys) {
      await executor.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
    }

    const outcomes: PartyImportOutcome[] = [];
    for (let index = 0; index < input.rows.length; index += 1) {
      const row = input.rows[index] as PartyImportRow;
      const partyType = (row.partyType ?? 'person') as PartyType;
      // Each row runs inside a SAVEPOINT: a unique-violation from one row
      // must not poison the transaction the remaining rows are written in.
      await executor.query('SAVEPOINT import_row');
      let created: PartyCreateOutcome;
      try {
        created = await createPartyWithin(executor, {
          actingUserLinkId: input.actingUserLinkId,
          tenantId: input.tenantId,
          partyType,
          details: {
            displayName: row.displayName,
            givenName: row.givenName,
            familyName: row.familyName,
            organizationName: row.organizationName,
            email: row.email,
            phone: row.phone,
          },
        });
      } catch (err) {
        await executor.query('ROLLBACK TO SAVEPOINT import_row');
        outcomes.push({
          index,
          result: 'invalid',
          partyId: null,
          detail: err instanceof Error ? err.message.slice(0, 200) : 'row refused',
        });
        continue;
      }
      if (created.outcome === 'created') {
        await executor.query('RELEASE SAVEPOINT import_row');
        outcomes.push({ index, result: 'created', partyId: created.party.partyId, detail: null });
      } else if (created.outcome === 'duplicate') {
        await executor.query('ROLLBACK TO SAVEPOINT import_row');
        outcomes.push({
          index,
          result: 'duplicate',
          partyId: created.candidates[0]?.party.partyId ?? null,
          detail: `matches an existing party on ${created.candidates[0]?.matchedOn ?? 'contact details'}`,
        });
      } else {
        await executor.query('ROLLBACK TO SAVEPOINT import_row');
        outcomes.push({ index, result: 'invalid', partyId: null, detail: created.error });
      }
    }
    return {
      created: outcomes.filter((o) => o.result === 'created').length,
      duplicates: outcomes.filter((o) => o.result === 'duplicate').length,
      invalid: outcomes.filter((o) => o.result === 'invalid').length,
      rows: outcomes,
    };
  });
}
