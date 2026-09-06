/**
 * OUTCOME 5 — SIGNING: FOUR INSTANTS, IN ORDER, AGAINST EXACTLY ONE HASH.
 *
 * "A signer cannot sign a superseded or modified package."
 *
 * A signature here is FOUR recorded instants — viewed, consented, intent
 * confirmed, signed — and each is refused unless the one before it happened.
 * The signature itself is a digest over the bound package hash, the signer, the
 * role, the consent version, the instant and the words of intent, so it is a
 * fact about exactly those bytes and nothing else.
 *
 * TWO LANES, ONE FUNCTION. The customer arrives through a token this module
 * resolves to a signer row by digest; the dealer's representative arrives
 * through their staff session and is matched to the signer row that names
 * THEIR user link. Both end in `signWithin`, which never asks which lane it is
 * on: the row already says who may sign it, and a session that does not match
 * the row is not found — not forbidden, not found.
 *
 * THE HASH THE SIGNER SAW IS THE HASH THEY SIGN. The signing page sends back
 * the package digest it displayed; a digest that is not the ceremony's bound
 * digest is refused before the database is asked, and the database refuses
 * again if the package has moved on since (`trg_ceremony_signers_bind_signature`).
 *
 * COMPLETION IS A DOCUMENT. When the last signer signs, the certificate — every
 * signer, every instant, every digest, in canonical form — is rendered into a
 * content-addressed blob and its digest is written onto the ceremony. Anyone
 * with the certificate bytes can re-hash them against the ceremony's record.
 */
import { withTenantTransaction, type Executor } from '@dealer/database';
import { enqueueAdminOutboxEvent, recordMutation, requireActor } from '@dealer/identity-access';

import {
  PACKAGE_COLUMNS,
  documentsOfPackageWithin,
  fieldsOfPackageWithin,
  mapPackage,
  type DocumentView,
  type PackageView,
} from './assembly';
import {
  CEREMONY_COLUMNS,
  CONSENT_TEXT,
  CONSENT_TEXT_VERSION,
  SIGNER_COLUMNS,
  mapCeremony,
  mapSigner,
  recordCeremonyEventWithin,
  requireCeremonyWithin,
  signersOfCeremonyWithin,
  type CeremonyView,
  type SignerView,
} from './ceremony';
import { digestOf, digestsEqual, sha256Hex, splitLaneToken, tokenDigest } from './hashing';
import { type JacketView, JACKET_COLUMNS, mapJacket } from './intake';
import { type AssembledField } from './render';

interface Row {
  [key: string]: unknown;
}

/** The words a signer confirms before signing. Versioned with the consent. */
export const INTENT_STATEMENT = 'I intend to sign every document in this package electronically.';

export interface SignerSession {
  readonly signer: SignerView;
  readonly ceremony: CeremonyView;
  readonly package: PackageView;
  readonly jacket: JacketView;
  readonly signers: readonly SignerView[];
  readonly documents: readonly DocumentView[];
  /** The figures and identifiers the signer is entitled to see, never the provenance ids. */
  readonly fields: readonly Pick<
    AssembledField,
    'fieldCode' | 'valueKind' | 'valueText' | 'valueCents' | 'valueInteger' | 'currency'
  >[];
  readonly consentText: string;
  readonly consentTextVersion: string;
  readonly intentStatement: string;
  /** What this signer may do next, so the page never guesses. */
  readonly nextStep: 'consent' | 'sign' | 'wait_for_turn' | 'done' | 'closed';
}

export type SignerLaneOutcome<T> =
  | { outcome: 'ok'; value: T }
  | { outcome: 'not_found' }
  | { outcome: 'expired' }
  | { outcome: 'closed'; state: string }
  | { outcome: 'invalid'; error: string };

async function loadCeremonyContext(
  executor: Executor,
  tenantId: string,
  signer: SignerView,
): Promise<{ ceremony: CeremonyView; package: PackageView; jacket: JacketView } | null> {
  const ceremony = await requireCeremonyWithin(executor, tenantId, signer.ceremonyId);
  if (ceremony === null) return null;
  const pkgRow = await executor.query(
    `SELECT ${PACKAGE_COLUMNS} FROM jacket_packages WHERE tenant_id = $1 AND package_id = $2 FOR UPDATE`,
    [tenantId, ceremony.packageId],
  );
  const jacketRow = await executor.query(
    `SELECT ${JACKET_COLUMNS} FROM deal_jackets WHERE tenant_id = $1 AND jacket_id = $2 FOR UPDATE`,
    [tenantId, ceremony.jacketId],
  );
  if (pkgRow.rows.length === 0 || jacketRow.rows.length === 0) return null;
  return {
    ceremony,
    package: mapPackage(pkgRow.rows[0] as Row),
    jacket: mapJacket(jacketRow.rows[0] as Row),
  };
}

function nextStepFor(
  signer: SignerView,
  signers: readonly SignerView[],
  ceremony: CeremonyView,
): SignerSession['nextStep'] {
  // What THIS signer did outlives the ceremony's state: a signer who signed
  // sees "done" on a completed ceremony, not "closed".
  if (signer.state === 'signed' || signer.state === 'declined') return 'done';
  if (!['sent', 'in_progress'].includes(ceremony.state)) return 'closed';
  if (signer.consentedAt === null) return 'consent';
  const earlierUnsigned = signers.some(
    (s) => s.signingOrder < signer.signingOrder && s.state !== 'signed',
  );
  return earlierUnsigned ? 'wait_for_turn' : 'sign';
}

async function sessionOf(
  executor: Executor,
  tenantId: string,
  signer: SignerView,
): Promise<SignerSession | null> {
  const ctx = await loadCeremonyContext(executor, tenantId, signer);
  if (ctx === null) return null;
  const signers = await signersOfCeremonyWithin(executor, tenantId, ctx.ceremony.ceremonyId);
  const documents = await documentsOfPackageWithin(executor, tenantId, ctx.package.packageId);
  const fields = (await fieldsOfPackageWithin(executor, tenantId, ctx.package.packageId)).map(
    (f) => ({
      fieldCode: f.fieldCode,
      valueKind: f.valueKind,
      valueText: f.valueText,
      valueCents: f.valueCents,
      valueInteger: f.valueInteger,
      currency: f.currency,
    }),
  );
  return {
    signer,
    ceremony: ctx.ceremony,
    package: ctx.package,
    jacket: ctx.jacket,
    signers,
    documents,
    fields,
    consentText: CONSENT_TEXT,
    consentTextVersion: CONSENT_TEXT_VERSION,
    intentStatement: INTENT_STATEMENT,
    nextStep: nextStepFor(signer, signers, ctx.ceremony),
  };
}

/**
 * Resolve a lane token to its signer row, locked. Expiry is decided here on
 * every call — a link that has run out answers `expired` whatever the row says.
 */
async function signerByTokenWithin(
  executor: Executor,
  tenantId: string,
  token: string,
): Promise<SignerView | null> {
  const found = await executor.query(
    `SELECT ${SIGNER_COLUMNS} FROM ceremony_signers
      WHERE tenant_id = $1 AND token_sha256 = $2 AND lane = 'signer_token' FOR UPDATE`,
    [tenantId, tokenDigest(token)],
  );
  return found.rows.length === 0 ? null : mapSigner(found.rows[0] as Row);
}

function tokenExpired(signer: SignerView, now: string): boolean {
  return signer.tokenExpiresAt !== null && signer.tokenExpiresAt <= now;
}

/** The customer opens their link. The first look is recorded as an instant. */
export async function openSignerSession(
  laneToken: string,
  now: string = new Date().toISOString(),
): Promise<SignerLaneOutcome<SignerSession>> {
  const parts = splitLaneToken(laneToken);
  if (parts === null) return { outcome: 'not_found' };
  return withTenantTransaction(parts.tenantId, async (tx) => {
    const signer = await signerByTokenWithin(tx, parts.tenantId, parts.token);
    if (signer === null) return { outcome: 'not_found' };
    if (tokenExpired(signer, now)) return { outcome: 'expired' };
    let current = signer;
    if (signer.viewedAt === null && (signer.state === 'pending' || signer.state === 'invited')) {
      const viewed = await tx.query(
        `UPDATE ceremony_signers
            SET state = 'viewed', viewed_at = NOW(), updated_at = NOW(),
                authorization_version = authorization_version + 1
          WHERE tenant_id = $1 AND signer_id = $2 RETURNING ${SIGNER_COLUMNS}`,
        [parts.tenantId, signer.signerId],
      );
      current = mapSigner(viewed.rows[0] as Row);
      await recordCeremonyEventWithin(tx, {
        tenantId: parts.tenantId,
        ceremonyId: current.ceremonyId,
        signerId: current.signerId,
        eventType: 'signer.viewed',
        lane: 'signer',
        actorUserLinkId: null,
        payload: { signer_role: current.signerRole },
      });
    }
    const session = await sessionOf(tx, parts.tenantId, current);
    if (session === null) return { outcome: 'not_found' };
    return { outcome: 'ok', value: session };
  });
}

/** A document's bytes, for the signer who is entitled to read this package. */
export async function signerDocumentContent(
  laneToken: string,
  documentId: string,
  now: string = new Date().toISOString(),
): Promise<SignerLaneOutcome<{ document: DocumentView; content: Buffer }>> {
  const parts = splitLaneToken(laneToken);
  if (parts === null) return { outcome: 'not_found' };
  return withTenantTransaction(parts.tenantId, async (tx) => {
    const signer = await signerByTokenWithin(tx, parts.tenantId, parts.token);
    if (signer === null) return { outcome: 'not_found' };
    if (tokenExpired(signer, now)) return { outcome: 'expired' };
    const ctx = await loadCeremonyContext(tx, parts.tenantId, signer);
    if (ctx === null) return { outcome: 'not_found' };
    const docs = await documentsOfPackageWithin(tx, parts.tenantId, ctx.package.packageId);
    const document = docs.find((d) => d.documentId === documentId);
    if (document === undefined) return { outcome: 'not_found' };
    const blob = await tx.query(`SELECT content FROM document_blobs WHERE content_sha256 = $1`, [
      document.contentSha256,
    ]);
    if (blob.rows.length === 0) return { outcome: 'not_found' };
    return { outcome: 'ok', value: { document, content: (blob.rows[0] as Row).content as Buffer } };
  });
}

async function consentWithin(
  executor: Executor,
  tenantId: string,
  signer: SignerView,
  consentTextVersion: string,
  lane: 'signer' | 'staff',
  actorUserLinkId: string | null,
): Promise<SignerLaneOutcome<SignerView>> {
  if (consentTextVersion !== CONSENT_TEXT_VERSION) {
    return {
      outcome: 'invalid',
      error: `the consent shown was version ${CONSENT_TEXT_VERSION}; ${consentTextVersion} is not it`,
    };
  }
  if (signer.consentedAt !== null) return { outcome: 'ok', value: signer };
  if (signer.state === 'declined' || signer.state === 'expired') {
    return { outcome: 'closed', state: signer.state };
  }
  const ceremony = await requireCeremonyWithin(executor, tenantId, signer.ceremonyId);
  if (ceremony === null) return { outcome: 'not_found' };
  if (!['sent', 'in_progress'].includes(ceremony.state))
    return { outcome: 'closed', state: ceremony.state };
  const updated = await executor.query(
    `UPDATE ceremony_signers
        SET state = 'consented', consented_at = NOW(), consent_text_version = $3,
            viewed_at = COALESCE(viewed_at, NOW()), updated_at = NOW(),
            authorization_version = authorization_version + 1
      WHERE tenant_id = $1 AND signer_id = $2 RETURNING ${SIGNER_COLUMNS}`,
    [tenantId, signer.signerId, consentTextVersion],
  );
  const view = mapSigner(updated.rows[0] as Row);
  await recordCeremonyEventWithin(executor, {
    tenantId,
    ceremonyId: view.ceremonyId,
    signerId: view.signerId,
    eventType: 'signer.consented',
    lane,
    actorUserLinkId,
    payload: { signer_role: view.signerRole, consent_text_version: consentTextVersion },
  });
  return { outcome: 'ok', value: view };
}

/** The customer agrees to electronic records, naming the version they read. */
export async function consentToElectronicRecords(
  laneToken: string,
  consentTextVersion: string,
  now: string = new Date().toISOString(),
): Promise<SignerLaneOutcome<SignerSession>> {
  const parts = splitLaneToken(laneToken);
  if (parts === null) return { outcome: 'not_found' };
  return withTenantTransaction(parts.tenantId, async (tx) => {
    const signer = await signerByTokenWithin(tx, parts.tenantId, parts.token);
    if (signer === null) return { outcome: 'not_found' };
    if (tokenExpired(signer, now)) return { outcome: 'expired' };
    const consented = await consentWithin(
      tx,
      parts.tenantId,
      signer,
      consentTextVersion,
      'signer',
      null,
    );
    if (consented.outcome !== 'ok') return consented;
    const session = await sessionOf(tx, parts.tenantId, consented.value);
    return session === null ? { outcome: 'not_found' } : { outcome: 'ok', value: session };
  });
}

/** The certificate: everything that happened, in canonical form, as bytes anyone can re-hash. */
function certificateBytes(
  ceremony: CeremonyView,
  pkg: PackageView,
  documents: readonly DocumentView[],
  signers: readonly SignerView[],
): Buffer {
  const record = {
    certificate: 'FBL-140 e-sign completion certificate',
    ceremony_id: ceremony.ceremonyId,
    jacket_id: ceremony.jacketId,
    package_id: pkg.packageId,
    package_version_no: pkg.versionNo,
    bound_package_sha256: ceremony.boundPackageSha256,
    provider_code: ceremony.providerCode,
    provider_kind: ceremony.providerKind,
    provider_envelope_ref: ceremony.providerEnvelopeRef,
    consent_text_version: ceremony.consentTextVersion,
    documents: documents.map((d) => ({
      sequence_no: d.sequenceNo,
      title: d.title,
      template_code: d.templateCode,
      template_version: d.templateVersion,
      template_approval_status: d.templateApprovalStatus,
      content_sha256: d.contentSha256,
      byte_size: d.byteSize,
    })),
    signers: signers.map((s) => ({
      signer_id: s.signerId,
      role: s.signerRole,
      lane: s.lane,
      display_name: s.displayName,
      signing_authority: s.signingAuthority,
      identity_assurance: s.identityAssurance,
      viewed_at: s.viewedAt,
      consented_at: s.consentedAt,
      consent_text_version: s.consentTextVersion,
      intent_confirmed_at: s.intentConfirmedAt,
      signed_at: s.signedAt,
      signature_sha256: s.signatureSha256,
    })),
  };
  return Buffer.from(JSON.stringify(record, null, 2) + '\n', 'utf8');
}

export type SignOutcome =
  | {
      outcome: 'signed';
      signer: SignerView;
      ceremony: CeremonyView;
      package: PackageView;
      completed: boolean;
    }
  | { outcome: 'already_signed'; signer: SignerView }
  | { outcome: 'out_of_order'; waitingOn: readonly SignerView[] }
  | { outcome: 'hash_mismatch'; boundPackageSha256: string }
  | { outcome: 'consent_required' }
  | { outcome: 'closed'; state: string }
  | { outcome: 'expired' }
  | { outcome: 'invalid'; error: string }
  | { outcome: 'not_found' };

async function signWithin(
  executor: Executor,
  tenantId: string,
  signer: SignerView,
  input: {
    packageSha256: string;
    intentStatement: string;
    lane: 'signer' | 'staff';
    actorUserLinkId: string | null;
  },
  now: string,
): Promise<SignOutcome> {
  if (signer.state === 'signed') return { outcome: 'already_signed', signer };
  if (signer.state === 'declined' || signer.state === 'expired')
    return { outcome: 'closed', state: signer.state };
  const ctx = await loadCeremonyContext(executor, tenantId, signer);
  if (ctx === null) return { outcome: 'not_found' };
  const { ceremony, package: pkg } = ctx;
  if (!['sent', 'in_progress'].includes(ceremony.state))
    return { outcome: 'closed', state: ceremony.state };
  if (!['sent', 'partially_signed'].includes(pkg.state))
    return { outcome: 'closed', state: pkg.state };
  if (signer.consentedAt === null) return { outcome: 'consent_required' };
  // ONE CLOCK. The instant of signing is the DATABASE's now, never earlier than
  // the consent it recorded, so the ordering the table enforces cannot lose to
  // skew between the application host and the database host. The caller's
  // `now` is honoured only when it is later still — a test moving time forward.
  // Read back as text at the database's own microsecond precision: a JS Date
  // would truncate to milliseconds and could land a microsecond BEFORE consent.
  const clock = await executor.query(
    `SELECT to_char(GREATEST(NOW(), consented_at, $3::timestamptz) AT TIME ZONE 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at
       FROM ceremony_signers WHERE tenant_id = $1 AND signer_id = $2`,
    [tenantId, signer.signerId, now],
  );
  const signedAt = String((clock.rows[0] as Row).at);
  if (ceremony.expiresAt <= signedAt) return { outcome: 'expired' };
  if (input.intentStatement !== INTENT_STATEMENT) {
    return { outcome: 'invalid', error: 'the statement of intent is confirmed in its own words' };
  }
  // THE HASH THEY SAW IS THE HASH THEY SIGN.
  if (
    !digestsEqual(input.packageSha256, ceremony.boundPackageSha256) ||
    pkg.packageSha256 !== ceremony.boundPackageSha256
  ) {
    return { outcome: 'hash_mismatch', boundPackageSha256: ceremony.boundPackageSha256 };
  }
  const signers = await signersOfCeremonyWithin(executor, tenantId, ceremony.ceremonyId);
  const waitingOn = signers.filter(
    (s) => s.signingOrder < signer.signingOrder && s.state !== 'signed',
  );
  if (waitingOn.length > 0) return { outcome: 'out_of_order', waitingOn };

  const signatureSha256 = digestOf({
    bound_package_sha256: ceremony.boundPackageSha256,
    signer_id: signer.signerId,
    role: signer.signerRole,
    lane: signer.lane,
    consent_text_version: signer.consentTextVersion,
    intent_statement: input.intentStatement,
    signed_at: signedAt,
  });
  // intent_confirmed_at and signed_at are the same instant here: the page's
  // "sign" is the confirmation of intent, and the trigger requires
  // consented <= intent <= signed, which this satisfies.
  const updated = await executor.query(
    `UPDATE ceremony_signers
        SET state = 'signed', intent_confirmed_at = $3::timestamptz, signed_at = $3::timestamptz,
            signature_sha256 = $4, updated_at = NOW(), authorization_version = authorization_version + 1
      WHERE tenant_id = $1 AND signer_id = $2 RETURNING ${SIGNER_COLUMNS}`,
    [tenantId, signer.signerId, signedAt, signatureSha256],
  );
  const signed = mapSigner(updated.rows[0] as Row);
  await recordCeremonyEventWithin(executor, {
    tenantId,
    ceremonyId: ceremony.ceremonyId,
    signerId: signed.signerId,
    eventType: 'signer.signed',
    lane: input.lane,
    actorUserLinkId: input.actorUserLinkId,
    payload: {
      signer_role: signed.signerRole,
      bound_package_sha256: ceremony.boundPackageSha256,
      signature_sha256: signatureSha256,
      signed_at: signedAt,
    },
  });

  const all = await signersOfCeremonyWithin(executor, tenantId, ceremony.ceremonyId);
  const complete = all.every((s) => s.state === 'signed');
  let ceremonyView: CeremonyView;
  let packageView = pkg;
  if (!complete) {
    const c = await executor.query(
      `UPDATE signing_ceremonies SET state = 'in_progress', updated_at = NOW(),
              authorization_version = authorization_version + 1
        WHERE tenant_id = $1 AND ceremony_id = $2 RETURNING ${CEREMONY_COLUMNS}`,
      [tenantId, ceremony.ceremonyId],
    );
    ceremonyView = mapCeremony(c.rows[0] as Row);
    const p = await executor.query(
      `UPDATE jacket_packages SET state = 'partially_signed', updated_at = NOW(),
              authorization_version = authorization_version + 1
        WHERE tenant_id = $1 AND package_id = $2 AND state = 'sent' RETURNING ${PACKAGE_COLUMNS}`,
      [tenantId, pkg.packageId],
    );
    if (p.rows.length > 0) packageView = mapPackage(p.rows[0] as Row);
  } else {
    const documents = await documentsOfPackageWithin(executor, tenantId, pkg.packageId);
    const bytes = certificateBytes(ceremony, pkg, documents, all);
    const certificateSha256 = sha256Hex(bytes);
    await executor.query(
      `INSERT INTO document_blobs (content_sha256, mime_type, byte_size, content)
       VALUES ($1, 'application/json', $2, $3) ON CONFLICT (content_sha256) DO NOTHING`,
      [certificateSha256, bytes.byteLength, bytes],
    );
    const c = await executor.query(
      `UPDATE signing_ceremonies
          SET state = 'completed', completed_at = $3::timestamptz, completion_certificate_sha256 = $4,
              updated_at = NOW(), authorization_version = authorization_version + 1
        WHERE tenant_id = $1 AND ceremony_id = $2 RETURNING ${CEREMONY_COLUMNS}`,
      [tenantId, ceremony.ceremonyId, signedAt, certificateSha256],
    );
    ceremonyView = mapCeremony(c.rows[0] as Row);
    const p = await executor.query(
      `UPDATE jacket_packages SET state = 'signed_complete', updated_at = NOW(),
              authorization_version = authorization_version + 1
        WHERE tenant_id = $1 AND package_id = $2 RETURNING ${PACKAGE_COLUMNS}`,
      [tenantId, pkg.packageId],
    );
    packageView = mapPackage(p.rows[0] as Row);
    await executor.query(
      `UPDATE deal_jackets SET state = 'signed_complete', updated_at = NOW(),
              authorization_version = authorization_version + 1
        WHERE tenant_id = $1 AND jacket_id = $2`,
      [tenantId, ceremony.jacketId],
    );
    await recordCeremonyEventWithin(executor, {
      tenantId,
      ceremonyId: ceremony.ceremonyId,
      signerId: null,
      eventType: 'ceremony.completed',
      lane: 'system',
      actorUserLinkId: null,
      payload: {
        bound_package_sha256: ceremony.boundPackageSha256,
        completion_certificate_sha256: certificateSha256,
        signers: all.map((s) => ({
          signer_id: s.signerId,
          role: s.signerRole,
          signature_sha256: s.signatureSha256,
        })),
      },
    });
    await enqueueAdminOutboxEvent(executor, {
      tenantId,
      eventType: 'jacket.ceremony.completed',
      payload: {
        jacket_id: ceremony.jacketId,
        package_id: pkg.packageId,
        ceremony_id: ceremony.ceremonyId,
        completion_certificate_sha256: certificateSha256,
      },
    });
  }
  return {
    outcome: 'signed',
    signer: signed,
    ceremony: ceremonyView,
    package: packageView,
    completed: complete,
  };
}

/** The customer signs, through their link. */
export async function signAsCustomer(
  laneToken: string,
  input: { packageSha256: string; intentStatement: string },
  now: string = new Date().toISOString(),
): Promise<SignOutcome> {
  const parts = splitLaneToken(laneToken);
  if (parts === null) return { outcome: 'not_found' };
  return withTenantTransaction(parts.tenantId, async (tx) => {
    const signer = await signerByTokenWithin(tx, parts.tenantId, parts.token);
    if (signer === null) return { outcome: 'not_found' };
    if (tokenExpired(signer, now)) return { outcome: 'expired' };
    return signWithin(
      tx,
      parts.tenantId,
      signer,
      { ...input, lane: 'signer', actorUserLinkId: null },
      now,
    );
  });
}

export type DeclineOutcome =
  | { outcome: 'declined'; signer: SignerView; ceremony: CeremonyView; package: PackageView }
  | { outcome: 'already_declined'; signer: SignerView }
  | { outcome: 'closed'; state: string }
  | { outcome: 'expired' }
  | { outcome: 'invalid'; error: string }
  | { outcome: 'not_found' };

/** The customer declines. The ceremony ends; the package is voided; nothing signed is touched. */
export async function declineAsCustomer(
  laneToken: string,
  reason: string,
  now: string = new Date().toISOString(),
): Promise<DeclineOutcome> {
  const parts = splitLaneToken(laneToken);
  if (parts === null) return { outcome: 'not_found' };
  return withTenantTransaction(parts.tenantId, async (tx) => {
    const signer = await signerByTokenWithin(tx, parts.tenantId, parts.token);
    if (signer === null) return { outcome: 'not_found' };
    if (tokenExpired(signer, now)) return { outcome: 'expired' };
    if (signer.state === 'declined') return { outcome: 'already_declined', signer };
    if (signer.state === 'signed') return { outcome: 'closed', state: 'signed' };
    if (reason.trim().length === 0) return { outcome: 'invalid', error: 'declining says why' };
    const ctx = await loadCeremonyContext(tx, parts.tenantId, signer);
    if (ctx === null) return { outcome: 'not_found' };
    if (!['sent', 'in_progress'].includes(ctx.ceremony.state))
      return { outcome: 'closed', state: ctx.ceremony.state };
    const updated = await tx.query(
      `UPDATE ceremony_signers
          SET state = 'declined', declined_at = NOW(), decline_reason = $3, updated_at = NOW(),
              authorization_version = authorization_version + 1
        WHERE tenant_id = $1 AND signer_id = $2 RETURNING ${SIGNER_COLUMNS}`,
      [parts.tenantId, signer.signerId, reason.slice(0, 400)],
    );
    const declined = mapSigner(updated.rows[0] as Row);
    const c = await tx.query(
      `UPDATE signing_ceremonies SET state = 'declined', updated_at = NOW(),
              authorization_version = authorization_version + 1
        WHERE tenant_id = $1 AND ceremony_id = $2 RETURNING ${CEREMONY_COLUMNS}`,
      [parts.tenantId, ctx.ceremony.ceremonyId],
    );
    const p = await tx.query(
      `UPDATE jacket_packages
          SET state = 'voided', state_reason = 'declined by signer', updated_at = NOW(),
              authorization_version = authorization_version + 1
        WHERE tenant_id = $1 AND package_id = $2 AND state IN ('sent', 'partially_signed')
        RETURNING ${PACKAGE_COLUMNS}`,
      [parts.tenantId, ctx.package.packageId],
    );
    await recordCeremonyEventWithin(tx, {
      tenantId: parts.tenantId,
      ceremonyId: ctx.ceremony.ceremonyId,
      signerId: declined.signerId,
      eventType: 'signer.declined',
      lane: 'signer',
      actorUserLinkId: null,
      // The reason is the signer's words and may name people; it lives on the
      // signer row, not in the event stream.
      payload: { signer_role: declined.signerRole },
    });
    await enqueueAdminOutboxEvent(tx, {
      tenantId: parts.tenantId,
      eventType: 'jacket.ceremony.declined',
      payload: {
        jacket_id: ctx.ceremony.jacketId,
        package_id: ctx.package.packageId,
        ceremony_id: ctx.ceremony.ceremonyId,
      },
    });
    return {
      outcome: 'declined',
      signer: declined,
      ceremony: mapCeremony(c.rows[0] as Row),
      package: p.rows.length > 0 ? mapPackage(p.rows[0] as Row) : ctx.package,
    };
  });
}

/**
 * The dealer's representative signs through their staff session. The signer
 * row that names THEIR user link is the only one this can reach; a manager who
 * is not the representative on this ceremony — or a salesperson, or anybody
 * trying to sign in the customer's place — is not found.
 */
export async function signAsDealerRepresentative(input: {
  actingUserLinkId: string;
  tenantId: string;
  ceremonyId: string;
  packageSha256: string;
  intentStatement: string;
  consentTextVersion: string;
  now?: string;
}): Promise<SignOutcome> {
  return withTenantTransaction(input.tenantId, async (tx) => {
    const actor = await requireActor(tx, input.actingUserLinkId);
    const now = input.now ?? new Date().toISOString();
    const found = await tx.query(
      `SELECT ${SIGNER_COLUMNS} FROM ceremony_signers
        WHERE tenant_id = $1 AND ceremony_id = $2 AND lane = 'staff_session' AND user_link_id = $3
        FOR UPDATE`,
      [input.tenantId, input.ceremonyId, actor],
    );
    if (found.rows.length === 0) return { outcome: 'not_found' };
    let signer = mapSigner(found.rows[0] as Row);
    const consented = await consentWithin(
      tx,
      input.tenantId,
      signer,
      input.consentTextVersion,
      'staff',
      actor,
    );
    if (consented.outcome === 'invalid') return { outcome: 'invalid', error: consented.error };
    if (consented.outcome === 'closed') return { outcome: 'closed', state: consented.state };
    if (consented.outcome !== 'ok') return { outcome: 'not_found' };
    signer = consented.value;
    const signed = await signWithin(
      tx,
      input.tenantId,
      signer,
      {
        packageSha256: input.packageSha256,
        intentStatement: input.intentStatement,
        lane: 'staff',
        actorUserLinkId: actor,
      },
      now,
    );
    if (signed.outcome === 'signed') {
      await recordMutation(tx, {
        tenantId: input.tenantId,
        entityType: 'signing_ceremony',
        entityId: signed.ceremony.ceremonyId,
        eventType: 'jacket.ceremony.dealer_signed',
        actingUserLinkId: actor,
        authorizationVersion: signed.ceremony.authorizationVersion,
        details: {
          signer_id: signed.signer.signerId,
          signature_sha256: signed.signer.signatureSha256,
          completed: signed.completed,
        },
      });
    }
    return signed;
  });
}

/** The completion certificate's bytes, for staff who may read the ceremony. */
export async function certificateContentWithin(
  executor: Executor,
  tenantId: string,
  ceremony: CeremonyView,
): Promise<Buffer | null> {
  if (ceremony.completionCertificateSha256 === null) return null;
  const blob = await executor.query(
    `SELECT content FROM document_blobs WHERE content_sha256 = $1`,
    [ceremony.completionCertificateSha256],
  );
  return blob.rows.length === 0 ? null : ((blob.rows[0] as Row).content as Buffer);
}
