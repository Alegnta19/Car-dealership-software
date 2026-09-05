/**
 * OUTCOME 5 — SENDING: THE CEREMONY IS CREATED, BOUND, AND DELIVERED.
 *
 * "Capture electronic-record consent, signer identity and role, signing
 * authority, authentication assurance, intent, exact package version/hash,
 * timestamps, provider delivery records, signature results, and completion
 * certificate."
 *
 * A CEREMONY BINDS ONE PACKAGE VERSION BY HASH. `bound_package_sha256` is copied
 * from the package at creation; every signature later names it and migration
 * 066's trigger refuses a signature against a package whose digest or state has
 * moved. `(tenant_id, package_id)` is unique: one ceremony per version, so a
 * "second send" of the same version is the first one, answered again.
 *
 * SIGNERS HAVE LANES, AND THE LANE IS FIXED AT CREATION. The customer signs
 * through a random token this table stores only as a digest; the dealer's
 * representative — the manager who sent the package — signs through their
 * staff session. The customer's raw token is handed to the PROVIDER for
 * delivery and to nobody else: not the response, not the outbox, not a log. A
 * salesperson cannot read it, so a salesperson cannot sign as the customer,
 * which is what "distinct authority lanes" costs and buys.
 *
 * SENDING IS A MANAGER'S ACT. The route names a manager-only action and
 * `isEligibleManager` re-checks it at the write; a package that asked for a
 * review must carry the stamp before it goes.
 */
import { withTenantTransaction, type Executor } from '@dealer/database';
import {
  enqueueAdminOutboxEvent,
  recordMutation,
  requireActor,
  type MutationResult,
} from '@dealer/identity-access';

import { documentsOfPackageWithin, requirePackageWithin, type PackageView } from './assembly';
import { isEligibleManager } from './checklist';
import type { SignerRole } from './configuration';
import { composeLaneToken, randomToken, tokenDigest } from './hashing';
import { movePackageWithin } from './lifecycle';
import { esignProvider } from './provider';

interface Row {
  [key: string]: unknown;
}

/** How long a signer's link answers, and how long the whole ceremony stays open. */
export const SIGNER_TOKEN_TTL_HOURS = 72;
export const CEREMONY_TTL_DAYS = 14;

/**
 * The consent a signer gives before anything else, versioned so a later
 * dispute can read exactly what was agreed to. Changing these words is a new
 * version, never an edit.
 */
export const CONSENT_TEXT_VERSION = 'ESIGN-CONSENT-2026-09';
export const CONSENT_TEXT =
  'I agree to receive, review and sign the documents in this package electronically, and I ' +
  'understand that my electronic signature has the same effect as a handwritten one. I can ' +
  'ask the dealership for paper copies at any time. This consent is recorded with the exact ' +
  'package I am shown, identified by its content hash.';

export type CeremonyState =
  'created' | 'sent' | 'in_progress' | 'completed' | 'declined' | 'expired' | 'voided';

export interface CeremonyView {
  readonly ceremonyId: string;
  readonly jacketId: string;
  readonly packageId: string;
  readonly rooftopId: string;
  readonly providerCode: string;
  readonly providerKind: string;
  readonly providerEnvelopeRef: string | null;
  readonly boundPackageSha256: string;
  readonly state: CeremonyState;
  readonly consentTextVersion: string;
  readonly sentAt: string | null;
  readonly completedAt: string | null;
  readonly expiresAt: string;
  readonly completionCertificateSha256: string | null;
  readonly createdByUserLinkId: string;
  readonly createdAt: string;
  readonly authorizationVersion: number;
}

export const CEREMONY_COLUMNS = `ceremony_id, jacket_id, package_id, rooftop_id, provider_code,
  provider_kind, provider_envelope_ref, bound_package_sha256, state, consent_text_version, sent_at,
  completed_at, expires_at, completion_certificate_sha256, created_by_user_link_id, created_at,
  authorization_version`;

function iso(value: unknown): string {
  return new Date(String(value)).toISOString();
}

export function mapCeremony(row: Row): CeremonyView {
  return {
    ceremonyId: String(row.ceremony_id),
    jacketId: String(row.jacket_id),
    packageId: String(row.package_id),
    rooftopId: String(row.rooftop_id),
    providerCode: String(row.provider_code),
    providerKind: String(row.provider_kind),
    providerEnvelopeRef:
      row.provider_envelope_ref === null ? null : String(row.provider_envelope_ref),
    boundPackageSha256: String(row.bound_package_sha256),
    state: String(row.state) as CeremonyState,
    consentTextVersion: String(row.consent_text_version),
    sentAt: row.sent_at === null ? null : iso(row.sent_at),
    completedAt: row.completed_at === null ? null : iso(row.completed_at),
    expiresAt: iso(row.expires_at),
    completionCertificateSha256:
      row.completion_certificate_sha256 === null ? null : String(row.completion_certificate_sha256),
    createdByUserLinkId: String(row.created_by_user_link_id),
    createdAt: iso(row.created_at),
    authorizationVersion: Number(row.authorization_version),
  };
}

export type SignerState =
  'pending' | 'invited' | 'viewed' | 'consented' | 'signed' | 'declined' | 'expired';

export interface SignerView {
  readonly signerId: string;
  readonly ceremonyId: string;
  readonly signingOrder: number;
  readonly signerRole: SignerRole;
  readonly lane: 'signer_token' | 'staff_session';
  readonly partyId: string | null;
  readonly userLinkId: string | null;
  readonly displayName: string;
  /** Masked for every reader but the export: `d***@example.com`. */
  readonly contactMasked: string | null;
  readonly signingAuthority: string;
  readonly identityAssurance: string;
  readonly state: SignerState;
  readonly tokenExpiresAt: string | null;
  readonly invitedAt: string | null;
  readonly viewedAt: string | null;
  readonly consentedAt: string | null;
  readonly consentTextVersion: string | null;
  readonly intentConfirmedAt: string | null;
  readonly signedAt: string | null;
  readonly signatureSha256: string | null;
  readonly declinedAt: string | null;
  readonly declineReason: string | null;
  readonly authorizationVersion: number;
}

export const SIGNER_COLUMNS = `signer_id, ceremony_id, signing_order, signer_role, lane, party_id,
  user_link_id, display_name, contact_value, signing_authority, identity_assurance, state,
  token_expires_at, invited_at, viewed_at, consented_at, consent_text_version, intent_confirmed_at,
  signed_at, signature_sha256, declined_at, decline_reason, authorization_version`;

export function maskContact(value: string | null): string | null {
  if (value === null) return null;
  const at = value.indexOf('@');
  if (at > 0) return `${value.slice(0, 1)}***${value.slice(at)}`;
  return `***${value.slice(-2)}`;
}

export function mapSigner(row: Row): SignerView {
  return {
    signerId: String(row.signer_id),
    ceremonyId: String(row.ceremony_id),
    signingOrder: Number(row.signing_order),
    signerRole: String(row.signer_role) as SignerRole,
    lane: String(row.lane) as 'signer_token' | 'staff_session',
    partyId: row.party_id === null ? null : String(row.party_id),
    userLinkId: row.user_link_id === null ? null : String(row.user_link_id),
    displayName: String(row.display_name),
    contactMasked: maskContact(row.contact_value === null ? null : String(row.contact_value)),
    signingAuthority: String(row.signing_authority),
    identityAssurance: String(row.identity_assurance),
    state: String(row.state) as SignerState,
    tokenExpiresAt: row.token_expires_at === null ? null : iso(row.token_expires_at),
    invitedAt: row.invited_at === null ? null : iso(row.invited_at),
    viewedAt: row.viewed_at === null ? null : iso(row.viewed_at),
    consentedAt: row.consented_at === null ? null : iso(row.consented_at),
    consentTextVersion: row.consent_text_version === null ? null : String(row.consent_text_version),
    intentConfirmedAt: row.intent_confirmed_at === null ? null : iso(row.intent_confirmed_at),
    signedAt: row.signed_at === null ? null : iso(row.signed_at),
    signatureSha256: row.signature_sha256 === null ? null : String(row.signature_sha256),
    declinedAt: row.declined_at === null ? null : iso(row.declined_at),
    declineReason: row.decline_reason === null ? null : String(row.decline_reason),
    authorizationVersion: Number(row.authorization_version),
  };
}

export async function signersOfCeremonyWithin(
  executor: Executor,
  tenantId: string,
  ceremonyId: string,
): Promise<SignerView[]> {
  const found = await executor.query(
    `SELECT ${SIGNER_COLUMNS} FROM ceremony_signers
      WHERE tenant_id = $1 AND ceremony_id = $2 ORDER BY signing_order`,
    [tenantId, ceremonyId],
  );
  return found.rows.map((r) => mapSigner(r as Row));
}

/** One line of the ceremony's append-only history. PII-safe by construction. */
export async function recordCeremonyEventWithin(
  executor: Executor,
  input: {
    tenantId: string;
    ceremonyId: string;
    signerId: string | null;
    eventType: string;
    lane: 'staff' | 'signer' | 'provider' | 'system';
    actorUserLinkId: string | null;
    payload: Record<string, unknown>;
    providerEventRef?: string | null;
    providerSignatureValid?: boolean | null;
  },
): Promise<string> {
  const written = await executor.query(
    `INSERT INTO ceremony_events
       (tenant_id, ceremony_id, signer_id, event_type, lane, actor_user_link_id, payload,
        provider_event_ref, provider_signature_valid, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, clock_timestamp())
     RETURNING event_id`,
    [
      input.tenantId,
      input.ceremonyId,
      input.signerId,
      input.eventType,
      input.lane,
      input.actorUserLinkId,
      JSON.stringify(input.payload),
      input.providerEventRef ?? null,
      input.providerSignatureValid ?? null,
    ],
  );
  return String((written.rows[0] as Row).event_id);
}

export type SendOutcome =
  | {
      outcome: 'sent';
      package: PackageView;
      ceremony: CeremonyView;
      signers: readonly SignerView[];
      mutation: MutationResult;
    }
  | {
      outcome: 'already_sent';
      package: PackageView;
      ceremony: CeremonyView;
      signers: readonly SignerView[];
    }
  | { outcome: 'version_conflict'; currentVersion: number }
  | { outcome: 'invalid'; error: string }
  | { outcome: 'not_found' };

/** Signing order: the customer first, a co-buyer next, the dealer last. */
const ROLE_ORDER: Record<SignerRole, number> = {
  customer: 1,
  co_buyer: 2,
  dealer_representative: 3,
};

export async function sendPackage(input: {
  actingUserLinkId: string;
  tenantId: string;
  packageId: string;
  expectedVersion: number;
  now?: string;
}): Promise<SendOutcome> {
  return withTenantTransaction(input.tenantId, async (tx) => {
    const actor = await requireActor(tx, input.actingUserLinkId);
    const held = await requirePackageWithin(tx, input.tenantId, actor, input.packageId);
    if (held === null) return { outcome: 'not_found' };
    const { package: pkg, jacket } = held;
    if (!(await isEligibleManager(tx, input.tenantId, actor, jacket.rooftopId))) {
      return { outcome: 'not_found' };
    }

    // THE REPLAY ANSWER, before anything else: one ceremony per version.
    const existing = await tx.query(
      `SELECT ${CEREMONY_COLUMNS} FROM signing_ceremonies WHERE tenant_id = $1 AND package_id = $2`,
      [input.tenantId, pkg.packageId],
    );
    if (existing.rows.length > 0) {
      const ceremony = mapCeremony(existing.rows[0] as Row);
      return {
        outcome: 'already_sent',
        package: pkg,
        ceremony,
        signers: await signersOfCeremonyWithin(tx, input.tenantId, ceremony.ceremonyId),
      };
    }
    if (pkg.state !== 'review_ready') {
      return { outcome: 'invalid', error: `a ${pkg.state} package is not ready to send` };
    }
    if (pkg.reviewRequired && pkg.reviewedAt === null) {
      return {
        outcome: 'invalid',
        error: pkg.carriesUnapprovedTemplates
          ? 'this package carries unapproved sample templates and must be reviewed by a manager before it is sent'
          : 'this package carries a waived requirement and must be reviewed by a manager before it is sent',
      };
    }
    if (pkg.packageSha256 === null) {
      return { outcome: 'invalid', error: 'nothing has been rendered into this package' };
    }
    if (pkg.authorizationVersion !== input.expectedVersion) {
      return { outcome: 'version_conflict', currentVersion: pkg.authorizationVersion };
    }

    // WHO SIGNS: the union of every rendered template's required roles.
    const documents = await documentsOfPackageWithin(tx, input.tenantId, pkg.packageId);
    const templateIds = documents.map((d) => d.templateId).filter((x): x is string => x !== null);
    const roleRows = await tx.query(
      `SELECT DISTINCT unnest(required_signer_roles) AS role FROM document_templates
        WHERE tenant_id = $1 AND template_id = ANY($2::uuid[])`,
      [input.tenantId, templateIds],
    );
    const roles = roleRows.rows
      .map((r) => String((r as Row).role) as SignerRole)
      .sort((a, b) => ROLE_ORDER[a] - ROLE_ORDER[b]);
    if (roles.length === 0) {
      return { outcome: 'invalid', error: 'no document in this package names a signer' };
    }
    if (roles.includes('co_buyer')) {
      return {
        outcome: 'invalid',
        error:
          'a document in this package requires a co-buyer, and this phase models no co-buyer on a deal',
      };
    }

    const party = await tx.query(
      `SELECT display_name, email, phone FROM parties WHERE tenant_id = $1 AND party_id = $2`,
      [input.tenantId, jacket.partyId],
    );
    const p = party.rows[0] as Row;
    const manager = await tx.query(
      `SELECT display_name FROM user_links WHERE tenant_id = $1 AND user_link_id = $2`,
      [input.tenantId, actor],
    );
    const managerName =
      manager.rows.length > 0 && (manager.rows[0] as Row).display_name !== null
        ? String((manager.rows[0] as Row).display_name)
        : 'Dealer representative';

    const provider = esignProvider();
    const now = input.now ?? new Date().toISOString();
    const expiresAt = new Date(Date.parse(now) + CEREMONY_TTL_DAYS * 86_400_000).toISOString();
    const created = await tx.query(
      `INSERT INTO signing_ceremonies
         (tenant_id, jacket_id, package_id, rooftop_id, provider_code, provider_kind,
          bound_package_sha256, state, consent_text_version, sent_at, expires_at,
          created_by_user_link_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'sent', $8, NOW(), $9, $10)
       RETURNING ${CEREMONY_COLUMNS}`,
      [
        input.tenantId,
        jacket.jacketId,
        pkg.packageId,
        jacket.rooftopId,
        provider.providerCode,
        provider.kind,
        pkg.packageSha256,
        CONSENT_TEXT_VERSION,
        expiresAt,
        actor,
      ],
    );
    let ceremony = mapCeremony(created.rows[0] as Row);
    const envelopeRef = provider.envelopeRef(input.tenantId, ceremony.ceremonyId);
    const withEnvelope = await tx.query(
      `UPDATE signing_ceremonies SET provider_envelope_ref = $3, updated_at = NOW()
        WHERE tenant_id = $1 AND ceremony_id = $2 RETURNING ${CEREMONY_COLUMNS}`,
      [input.tenantId, ceremony.ceremonyId, envelopeRef],
    );
    ceremony = mapCeremony(withEnvelope.rows[0] as Row);

    await recordCeremonyEventWithin(tx, {
      tenantId: input.tenantId,
      ceremonyId: ceremony.ceremonyId,
      signerId: null,
      eventType: 'ceremony.created',
      lane: 'staff',
      actorUserLinkId: actor,
      payload: {
        package_id: pkg.packageId,
        package_version_no: pkg.versionNo,
        bound_package_sha256: pkg.packageSha256,
        provider_code: provider.providerCode,
        provider_kind: provider.kind,
        provider_envelope_ref: envelopeRef,
        signer_roles: roles,
      },
    });

    const signers: SignerView[] = [];
    const tokenExpiresAt = new Date(
      Date.parse(now) + SIGNER_TOKEN_TTL_HOURS * 3_600_000,
    ).toISOString();
    for (const role of roles) {
      if (role === 'customer') {
        const raw = randomToken();
        const row = await tx.query(
          `INSERT INTO ceremony_signers
             (tenant_id, ceremony_id, signing_order, signer_role, lane, party_id, display_name,
              contact_value, signing_authority, token_sha256, token_expires_at, identity_assurance,
              state, invited_at)
           VALUES ($1, $2, $3, 'customer', 'signer_token', $4, $5, $6, 'self', $7, $8, 'email_link',
                   'invited', NOW())
           RETURNING ${SIGNER_COLUMNS}`,
          [
            input.tenantId,
            ceremony.ceremonyId,
            ROLE_ORDER.customer,
            jacket.partyId,
            String(p.display_name),
            p.email === null ? (p.phone === null ? null : String(p.phone)) : String(p.email),
            tokenDigest(raw),
            tokenExpiresAt,
          ],
        );
        const signer = mapSigner(row.rows[0] as Row);
        signers.push(signer);
        // THE ONE PLACE THE RAW TOKEN GOES: to the provider, for delivery.
        const delivery = await provider.deliverInvitation({
          tenantId: input.tenantId,
          ceremonyId: ceremony.ceremonyId,
          signerId: signer.signerId,
          signerRole: 'customer',
          contactValue:
            p.email === null ? (p.phone === null ? null : String(p.phone)) : String(p.email),
          signingUrl: `/sign/#/${composeLaneToken(input.tenantId, raw)}`,
        });
        await recordCeremonyEventWithin(tx, {
          tenantId: input.tenantId,
          ceremonyId: ceremony.ceremonyId,
          signerId: signer.signerId,
          eventType:
            delivery.outcome === 'delivered' ? 'signer.invited' : 'signer.invitation_failed',
          lane: 'system',
          actorUserLinkId: null,
          payload: {
            signer_role: 'customer',
            lane: 'signer_token',
            delivery_ref: delivery.deliveryRef,
            delivery_outcome: delivery.outcome,
            detail: delivery.detail,
            token_expires_at: tokenExpiresAt,
          },
        });
      } else {
        const row = await tx.query(
          `INSERT INTO ceremony_signers
             (tenant_id, ceremony_id, signing_order, signer_role, lane, user_link_id, display_name,
              signing_authority, identity_assurance, state, invited_at)
           VALUES ($1, $2, $3, 'dealer_representative', 'staff_session', $4, $5,
                   'authorised_representative', 'staff_session', 'invited', NOW())
           RETURNING ${SIGNER_COLUMNS}`,
          [
            input.tenantId,
            ceremony.ceremonyId,
            ROLE_ORDER.dealer_representative,
            actor,
            managerName,
          ],
        );
        const signer = mapSigner(row.rows[0] as Row);
        signers.push(signer);
        await recordCeremonyEventWithin(tx, {
          tenantId: input.tenantId,
          ceremonyId: ceremony.ceremonyId,
          signerId: signer.signerId,
          eventType: 'signer.invited',
          lane: 'system',
          actorUserLinkId: null,
          payload: { signer_role: 'dealer_representative', lane: 'staff_session' },
        });
      }
    }

    const moved = await movePackageWithin(tx, {
      tenantId: input.tenantId,
      packageId: pkg.packageId,
      fromStates: ['review_ready'],
      toState: 'sent',
      reason: null,
      expectedVersion: input.expectedVersion,
    });
    if ('conflict' in moved)
      return { outcome: 'version_conflict', currentVersion: pkg.authorizationVersion + 1 };

    const mutation = await recordMutation(tx, {
      tenantId: input.tenantId,
      entityType: 'signing_ceremony',
      entityId: ceremony.ceremonyId,
      eventType: 'jacket.ceremony.sent',
      actingUserLinkId: actor,
      authorizationVersion: ceremony.authorizationVersion,
      details: {
        jacket_id: jacket.jacketId,
        package_id: pkg.packageId,
        bound_package_sha256: ceremony.boundPackageSha256,
        provider_envelope_ref: envelopeRef,
        signers: signers.map((s) => ({ signer_id: s.signerId, role: s.signerRole, lane: s.lane })),
      },
    });
    await enqueueAdminOutboxEvent(tx, {
      tenantId: input.tenantId,
      eventType: 'jacket.ceremony.sent',
      payload: {
        jacket_id: jacket.jacketId,
        package_id: pkg.packageId,
        ceremony_id: ceremony.ceremonyId,
        rooftop_id: jacket.rooftopId,
      },
    });
    return { outcome: 'sent', package: moved.package, ceremony, signers, mutation };
  });
}

export async function requireCeremonyWithin(
  executor: Executor,
  tenantId: string,
  ceremonyId: string,
): Promise<CeremonyView | null> {
  const found = await executor.query(
    `SELECT ${CEREMONY_COLUMNS} FROM signing_ceremonies
      WHERE tenant_id = $1 AND ceremony_id = $2 FOR UPDATE`,
    [tenantId, ceremonyId],
  );
  return found.rows.length === 0 ? null : mapCeremony(found.rows[0] as Row);
}

export async function ceremonyOfPackageWithin(
  executor: Executor,
  tenantId: string,
  packageId: string,
): Promise<CeremonyView | null> {
  const found = await executor.query(
    `SELECT ${CEREMONY_COLUMNS} FROM signing_ceremonies WHERE tenant_id = $1 AND package_id = $2`,
    [tenantId, packageId],
  );
  return found.rows.length === 0 ? null : mapCeremony(found.rows[0] as Row);
}
