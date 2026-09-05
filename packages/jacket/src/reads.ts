/**
 * THE READS: the board, one jacket, the discovery list, and a short-lived door
 * to an artifact.
 *
 * THE BOARD IS QUEUES, NOT DECORATION. Outcome 6 names the queues a person has
 * to act on — missing documents, render failure, rejected or expired
 * signatures, provider failure, stale approved-desking inputs — and every row
 * on the board carries exactly those as `exceptions`, computed in one read in
 * one transaction across exactly the rooftops this person works. Nothing here
 * is a gross, a commission, a delivery or a sale; the board says so in as many
 * words rather than leaving a blank column to be read as a zero.
 *
 * STALE IS MEASURED, NOT REMEMBERED. Every row asks the desk, through the seam,
 * which version it stands behind NOW and compares it with what the jacket
 * bound; the answer is a fact about this instant.
 *
 * ARTIFACT ACCESS IS A GRANT WITH A CLOCK. Staff never fetch bytes by document
 * id: they ask for a grant, receive a random token this table keeps only as a
 * digest, and the door shuts fifteen minutes later — `ck_grant_short_lived`
 * refuses anything past twenty-four hours whatever the code asks for. Every
 * read through it is counted on the grant.
 */
import { withTenantTransaction, type Executor } from '@dealer/database';
import {
  approvedDeskingCasesWithin,
  currentApprovedFingerprintWithin,
  type ApprovedCaseSummary,
} from '@dealer/desking';
import { permittedRooftopIds, requireActor } from '@dealer/identity-access';

import {
  PACKAGE_COLUMNS,
  documentsOfPackageWithin,
  fieldsOfPackageWithin,
  mapDocument,
  mapPackage,
  requirePackageWithin,
  type DocumentView,
  type PackageView,
} from './assembly';
import { checklistWithin, blockingItems, type ChecklistItemView } from './checklist';
import {
  ceremonyOfPackageWithin,
  signersOfCeremonyWithin,
  type CeremonyView,
  type SignerView,
} from './ceremony';
import { composeLaneToken, randomToken, splitLaneToken, tokenDigest } from './hashing';
import {
  requireJacketWithin,
  sourceBindingsWithin,
  type JacketView,
  type SourceBinding,
} from './intake';
import {
  legalHoldEventsWithin,
  retentionLinesWithin,
  type LegalHoldEvent,
  type RetentionLine,
} from './holds';
import { certificateContentWithin } from './signing';
import type { AssembledField } from './render';

interface Row {
  [key: string]: unknown;
}

/** What this phase does not know, said rather than left blank. */
export const JACKET_NOT_YET_AVAILABLE = {
  sale: 'NOT_YET_AVAILABLE',
  funding: 'NOT_YET_AVAILABLE',
  delivery: 'NOT_YET_AVAILABLE',
  sold_inventory: 'NOT_YET_AVAILABLE',
  accounting_posting: 'NOT_YET_AVAILABLE',
  gross: 'NOT_YET_AVAILABLE',
  commission: 'NOT_YET_AVAILABLE',
  revenue: 'NOT_YET_AVAILABLE',
  credit_application: 'NOT_YET_AVAILABLE',
  title_registration: 'NOT_YET_AVAILABLE',
  document_disposal: 'NOT_YET_AVAILABLE',
} as const;

// ── discovery ───────────────────────────────────────────────────────────────

/** Approved desk files at the rooftops this person works that have no active jacket yet. */
export async function openableDeskingCases(
  tenantId: string,
  actingUserLinkId: string,
): Promise<ApprovedCaseSummary[]> {
  return withTenantTransaction(tenantId, async (tx) => {
    const actor = await requireActor(tx, actingUserLinkId);
    const rooftopIds = await permittedRooftopIds(tenantId, actor);
    const approved = await approvedDeskingCasesWithin(tx, { tenantId, rooftopIds });
    if (approved.length === 0) return [];
    const taken = await tx.query(
      `SELECT desking_case_id FROM deal_jackets
        WHERE tenant_id = $1 AND state <> 'voided' AND desking_case_id = ANY($2::uuid[])`,
      [tenantId, approved.map((a) => a.deskingCaseId)],
    );
    const held = new Set(taken.rows.map((r) => String((r as Row).desking_case_id)));
    return approved.filter((a) => !held.has(a.deskingCaseId));
  });
}

// ── the board ───────────────────────────────────────────────────────────────

export interface JacketBoardRow {
  readonly jacketId: string;
  readonly rooftopId: string;
  readonly customerName: string;
  readonly vehicleDescription: string | null;
  readonly state: string;
  readonly boundVersionNo: number;
  readonly stale: boolean;
  readonly currentApprovedVersionNo: number | null;
  readonly latestPackage: {
    readonly packageId: string;
    readonly versionNo: number;
    readonly state: string;
    readonly documentCount: number;
    readonly carriesUnapprovedTemplates: boolean;
    readonly reviewRequired: boolean;
    readonly reviewed: boolean;
    readonly stateReason: string | null;
  } | null;
  readonly ceremony: {
    readonly state: string;
    readonly signed: number;
    readonly total: number;
  } | null;
  readonly missingRequired: number;
  readonly legalHold: boolean;
  readonly exceptions: readonly string[];
  readonly openedAt: string;
}

export interface JacketBoard {
  readonly rooftopIds: readonly string[];
  readonly rows: readonly JacketBoardRow[];
  readonly open: number;
  readonly awaitingReview: number;
  readonly awaitingSignature: number;
  readonly signedComplete: number;
  readonly queues: {
    readonly missing_documents: number;
    readonly render_failure: number;
    readonly rejected_or_expired: number;
    readonly provider_failure: number;
    readonly stale_inputs: number;
  };
  readonly notYetAvailable: typeof JACKET_NOT_YET_AVAILABLE;
}

function describeStock(row: Row): string | null {
  if (row.stock_number === null || row.stock_number === undefined) return null;
  const parts = [row.stock_year, row.stock_make, row.stock_model]
    .filter((p) => p !== null && p !== undefined && String(p).length > 0)
    .map((p) => String(p));
  const stockNumber = `stock ${String(row.stock_number)}`;
  return parts.length === 0 ? stockNumber : `${parts.join(' ')} (${stockNumber})`;
}

export async function jacketBoard(
  tenantId: string,
  actingUserLinkId: string,
): Promise<JacketBoard> {
  return withTenantTransaction(tenantId, async (tx) => {
    const actor = await requireActor(tx, actingUserLinkId);
    const rooftopIds = await permittedRooftopIds(tenantId, actor);
    const empty: JacketBoard = {
      rooftopIds,
      rows: [],
      open: 0,
      awaitingReview: 0,
      awaitingSignature: 0,
      signedComplete: 0,
      queues: {
        missing_documents: 0,
        render_failure: 0,
        rejected_or_expired: 0,
        provider_failure: 0,
        stale_inputs: 0,
      },
      notYetAvailable: JACKET_NOT_YET_AVAILABLE,
    };
    if (rooftopIds.length === 0) return empty;

    const found = await tx.query(
      `WITH latest AS (
         SELECT DISTINCT ON (jacket_id)
                jacket_id, package_id, version_no, state, document_count, carries_unapproved_templates,
                review_required, reviewed_at, state_reason
           FROM jacket_packages WHERE tenant_id = $1
          ORDER BY jacket_id, version_no DESC
       ),
       missing AS (
         SELECT jacket_id, COUNT(*)::int AS n FROM jacket_checklist_items
          WHERE tenant_id = $1 AND required AND state = 'missing' GROUP BY jacket_id
       ),
       held AS (
         SELECT DISTINCT p.jacket_id FROM package_documents d
           JOIN jacket_packages p ON p.tenant_id = d.tenant_id AND p.package_id = d.package_id
          WHERE d.tenant_id = $1 AND d.legal_hold
       ),
       disagreement AS (
         SELECT DISTINCT c.jacket_id FROM ceremony_events e
           JOIN signing_ceremonies c ON c.tenant_id = e.tenant_id AND c.ceremony_id = e.ceremony_id
          WHERE e.tenant_id = $1 AND e.lane = 'provider' AND e.payload->>'reconciliation' = 'disagrees'
       ),
       failed_delivery AS (
         SELECT DISTINCT c.jacket_id FROM ceremony_events e
           JOIN signing_ceremonies c ON c.tenant_id = e.tenant_id AND c.ceremony_id = e.ceremony_id
          WHERE e.tenant_id = $1 AND e.event_type = 'signer.invitation_failed'
       )
       SELECT j.jacket_id, j.rooftop_id, j.state, j.desking_case_id, j.scenario_version_no, j.opened_at,
              p.display_name,
              si.stock_number, v.model_year AS stock_year, v.make AS stock_make, v.model AS stock_model,
              l.package_id, l.version_no AS package_version_no, l.state AS package_state,
              l.document_count, l.carries_unapproved_templates, l.review_required, l.reviewed_at,
              l.state_reason,
              c.state AS ceremony_state,
              (SELECT COUNT(*)::int FROM ceremony_signers s WHERE s.tenant_id = c.tenant_id AND s.ceremony_id = c.ceremony_id) AS signers_total,
              (SELECT COUNT(*)::int FROM ceremony_signers s WHERE s.tenant_id = c.tenant_id AND s.ceremony_id = c.ceremony_id AND s.state = 'signed') AS signers_signed,
              COALESCE(m.n, 0) AS missing_required,
              (h.jacket_id IS NOT NULL) AS legal_hold,
              (dg.jacket_id IS NOT NULL) AS provider_disagreement,
              (fd.jacket_id IS NOT NULL) AS delivery_failed
         FROM deal_jackets j
         JOIN parties p ON p.tenant_id = j.tenant_id AND p.party_id = j.party_id
         LEFT JOIN stock_items si ON si.tenant_id = j.tenant_id AND si.stock_item_id = j.stock_item_id
         LEFT JOIN vehicles v ON v.tenant_id = si.tenant_id AND v.vehicle_id = si.vehicle_id
         LEFT JOIN latest l ON l.jacket_id = j.jacket_id
         LEFT JOIN signing_ceremonies c ON c.tenant_id = j.tenant_id AND c.package_id = l.package_id
         LEFT JOIN missing m ON m.jacket_id = j.jacket_id
         LEFT JOIN held h ON h.jacket_id = j.jacket_id
         LEFT JOIN disagreement dg ON dg.jacket_id = j.jacket_id
         LEFT JOIN failed_delivery fd ON fd.jacket_id = j.jacket_id
        WHERE j.tenant_id = $1 AND j.rooftop_id = ANY($2::uuid[])
        ORDER BY j.opened_at DESC
        LIMIT 500`,
      [tenantId, rooftopIds],
    );

    const rows: JacketBoardRow[] = [];
    const queues = {
      missing_documents: 0,
      render_failure: 0,
      rejected_or_expired: 0,
      provider_failure: 0,
      stale_inputs: 0,
    };
    let open = 0;
    let awaitingReview = 0;
    let awaitingSignature = 0;
    let signedComplete = 0;
    for (const x of found.rows) {
      const r = x as Row;
      const jacketId = String(r.jacket_id);
      const state = String(r.state);
      const current = await currentApprovedFingerprintWithin(tx, {
        tenantId,
        deskingCaseId: String(r.desking_case_id),
      });
      const boundVersionNo = Number(r.scenario_version_no);
      const stale =
        state !== 'voided' && (current === null || current.versionNo !== boundVersionNo);
      const packageState = r.package_state === null ? null : String(r.package_state);
      const stateReason =
        r.state_reason === null || r.state_reason === undefined ? null : String(r.state_reason);
      const missingRequired = Number(r.missing_required);
      const exceptions: string[] = [];
      if (state === 'open' && packageState === null) exceptions.push('no package assembled');
      if (state === 'open' && missingRequired > 0) {
        exceptions.push('missing documents');
        queues.missing_documents += 1;
      }
      if (
        packageState === 'voided' &&
        stateReason !== null &&
        stateReason.startsWith('render failure')
      ) {
        exceptions.push('render failure');
        queues.render_failure += 1;
      }
      if (
        packageState === 'expired' ||
        (packageState === 'voided' && stateReason === 'declined by signer')
      ) {
        exceptions.push(packageState === 'expired' ? 'signing expired' : 'signing declined');
        queues.rejected_or_expired += 1;
      }
      if (r.provider_disagreement === true || r.delivery_failed === true) {
        exceptions.push(
          r.delivery_failed === true ? 'invitation not delivered' : 'provider disagrees',
        );
        queues.provider_failure += 1;
      }
      if (stale) {
        exceptions.push('desk approval moved');
        queues.stale_inputs += 1;
      }
      if (packageState === 'review_ready' && r.review_required === true && r.reviewed_at === null) {
        exceptions.push('manager review needed');
      }
      if (
        r.carries_unapproved_templates === true &&
        packageState !== null &&
        !['voided', 'superseded', 'expired'].includes(packageState)
      ) {
        exceptions.push('unapproved sample templates');
      }
      if (state === 'open') open += 1;
      if (packageState === 'review_ready') awaitingReview += 1;
      if (packageState === 'sent' || packageState === 'partially_signed') awaitingSignature += 1;
      if (state === 'signed_complete') signedComplete += 1;
      rows.push({
        jacketId,
        rooftopId: String(r.rooftop_id),
        customerName: String(r.display_name),
        vehicleDescription: describeStock(r),
        state,
        boundVersionNo,
        stale,
        currentApprovedVersionNo: current === null ? null : current.versionNo,
        latestPackage:
          packageState === null
            ? null
            : {
                packageId: String(r.package_id),
                versionNo: Number(r.package_version_no),
                state: packageState,
                documentCount: Number(r.document_count),
                carriesUnapprovedTemplates: r.carries_unapproved_templates === true,
                reviewRequired: r.review_required === true,
                reviewed: r.reviewed_at !== null,
                stateReason,
              },
        ceremony:
          r.ceremony_state === null || r.ceremony_state === undefined
            ? null
            : {
                state: String(r.ceremony_state),
                signed: Number(r.signers_signed),
                total: Number(r.signers_total),
              },
        missingRequired,
        legalHold: r.legal_hold === true,
        exceptions,
        openedAt: new Date(String(r.opened_at)).toISOString(),
      });
    }
    return {
      rooftopIds,
      rows,
      open,
      awaitingReview,
      awaitingSignature,
      signedComplete,
      queues,
      notYetAvailable: JACKET_NOT_YET_AVAILABLE,
    };
  });
}

// ── one jacket ──────────────────────────────────────────────────────────────

export interface TimelineEvent {
  readonly eventId: string;
  readonly ceremonyId: string;
  readonly signerId: string | null;
  readonly eventType: string;
  readonly lane: string;
  readonly actorUserLinkId: string | null;
  readonly payload: Record<string, unknown>;
  readonly providerEventRef: string | null;
  readonly providerSignatureValid: boolean | null;
  readonly occurredAt: string;
}

export interface PackageDetail {
  readonly package: PackageView;
  readonly fields: readonly AssembledField[];
  readonly documents: readonly DocumentView[];
  readonly ceremony: CeremonyView | null;
  readonly signers: readonly SignerView[];
  readonly events: readonly TimelineEvent[];
}

export interface JacketDetail {
  readonly jacket: JacketView;
  readonly customerName: string;
  readonly vehicleDescription: string | null;
  readonly stale: boolean;
  readonly currentApprovedVersionNo: number | null;
  readonly bindings: readonly SourceBinding[];
  readonly checklist: readonly ChecklistItemView[];
  readonly blocking: readonly ChecklistItemView[];
  readonly packages: readonly PackageDetail[];
  readonly legalHolds: readonly LegalHoldEvent[];
  readonly legalHold: boolean;
  readonly retention: readonly RetentionLine[];
  readonly notYetAvailable: typeof JACKET_NOT_YET_AVAILABLE;
}

async function eventsOfCeremonyWithin(
  executor: Executor,
  tenantId: string,
  ceremonyId: string,
): Promise<TimelineEvent[]> {
  const found = await executor.query(
    `SELECT event_id, ceremony_id, signer_id, event_type, lane, actor_user_link_id, payload,
            provider_event_ref, provider_signature_valid, occurred_at
       FROM ceremony_events WHERE tenant_id = $1 AND ceremony_id = $2
      ORDER BY occurred_at, event_id`,
    [tenantId, ceremonyId],
  );
  return found.rows.map((x) => {
    const r = x as Row;
    return {
      eventId: String(r.event_id),
      ceremonyId: String(r.ceremony_id),
      signerId: r.signer_id === null ? null : String(r.signer_id),
      eventType: String(r.event_type),
      lane: String(r.lane),
      actorUserLinkId: r.actor_user_link_id === null ? null : String(r.actor_user_link_id),
      payload: (r.payload ?? {}) as Record<string, unknown>,
      providerEventRef: r.provider_event_ref === null ? null : String(r.provider_event_ref),
      providerSignatureValid:
        r.provider_signature_valid === null ? null : r.provider_signature_valid === true,
      occurredAt: new Date(String(r.occurred_at)).toISOString(),
    };
  });
}

export async function packageDetailWithin(
  executor: Executor,
  tenantId: string,
  pkg: PackageView,
): Promise<PackageDetail> {
  const ceremony = await ceremonyOfPackageWithin(executor, tenantId, pkg.packageId);
  return {
    package: pkg,
    fields: await fieldsOfPackageWithin(executor, tenantId, pkg.packageId),
    documents: await documentsOfPackageWithin(executor, tenantId, pkg.packageId),
    ceremony,
    signers:
      ceremony === null
        ? []
        : await signersOfCeremonyWithin(executor, tenantId, ceremony.ceremonyId),
    events:
      ceremony === null
        ? []
        : await eventsOfCeremonyWithin(executor, tenantId, ceremony.ceremonyId),
  };
}

export async function jacketDetail(
  tenantId: string,
  actingUserLinkId: string,
  jacketId: string,
): Promise<JacketDetail | null> {
  return withTenantTransaction(tenantId, async (tx) => {
    const actor = await requireActor(tx, actingUserLinkId);
    const jacket = await requireJacketWithin(tx, tenantId, actor, jacketId);
    if (jacket === null) return null;
    const header = await tx.query(
      `SELECT p.display_name, si.stock_number, v.model_year AS stock_year, v.make AS stock_make,
              v.model AS stock_model
         FROM deal_jackets j
         JOIN parties p ON p.tenant_id = j.tenant_id AND p.party_id = j.party_id
         LEFT JOIN stock_items si ON si.tenant_id = j.tenant_id AND si.stock_item_id = j.stock_item_id
         LEFT JOIN vehicles v ON v.tenant_id = si.tenant_id AND v.vehicle_id = si.vehicle_id
        WHERE j.tenant_id = $1 AND j.jacket_id = $2`,
      [tenantId, jacketId],
    );
    const h = header.rows[0] as Row;
    const current = await currentApprovedFingerprintWithin(tx, {
      tenantId,
      deskingCaseId: jacket.deskingCaseId,
    });
    const checklist = await checklistWithin(tx, tenantId, jacket.jacketId);
    const packageRows = await tx.query(
      `SELECT ${PACKAGE_COLUMNS} FROM jacket_packages WHERE tenant_id = $1 AND jacket_id = $2 ORDER BY version_no DESC`,
      [tenantId, jacket.jacketId],
    );
    const packages: PackageDetail[] = [];
    for (const row of packageRows.rows) {
      packages.push(await packageDetailWithin(tx, tenantId, mapPackage(row as Row)));
    }
    const legalHolds = await legalHoldEventsWithin(tx, tenantId, jacket.jacketId);
    const last = legalHolds[legalHolds.length - 1];
    return {
      jacket,
      customerName: String(h.display_name),
      vehicleDescription: describeStock(h),
      stale:
        jacket.state !== 'voided' &&
        (current === null || current.versionNo !== jacket.scenarioVersionNo),
      currentApprovedVersionNo: current === null ? null : current.versionNo,
      bindings: await sourceBindingsWithin(tx, tenantId, jacket.jacketId),
      checklist,
      blocking: blockingItems(checklist),
      packages,
      legalHolds,
      legalHold: last !== undefined && last.action === 'placed',
      retention: await retentionLinesWithin(tx, tenantId, jacket.jacketId),
      notYetAvailable: JACKET_NOT_YET_AVAILABLE,
    };
  });
}

export async function packageDetail(
  tenantId: string,
  actingUserLinkId: string,
  packageId: string,
): Promise<PackageDetail | null> {
  return withTenantTransaction(tenantId, async (tx) => {
    const actor = await requireActor(tx, actingUserLinkId);
    const held = await requirePackageWithin(tx, tenantId, actor, packageId);
    if (held === null) return null;
    return packageDetailWithin(tx, tenantId, held.package);
  });
}

// ── short-lived artifact access ─────────────────────────────────────────────

/** How long a staff grant answers. Well inside the 24-hour ceiling the table enforces. */
export const ARTIFACT_GRANT_TTL_MINUTES = 15;

export interface ArtifactGrant {
  readonly grantId: string;
  readonly documentId: string;
  readonly expiresAt: string;
  /** The URL path a client fetches; the raw token appears here once. */
  readonly path: string;
}

export type GrantOutcome = { outcome: 'granted'; grant: ArtifactGrant } | { outcome: 'not_found' };

/**
 * A staff member asks for a door to one document of one package they may
 * read. What they get back works for fifteen minutes and is recorded.
 */
export async function issueArtifactGrant(input: {
  actingUserLinkId: string;
  tenantId: string;
  packageId: string;
  documentId: string;
  now?: string;
}): Promise<GrantOutcome> {
  return withTenantTransaction(input.tenantId, async (tx) => {
    const actor = await requireActor(tx, input.actingUserLinkId);
    const held = await requirePackageWithin(tx, input.tenantId, actor, input.packageId);
    if (held === null) return { outcome: 'not_found' };
    const docs = await documentsOfPackageWithin(tx, input.tenantId, held.package.packageId);
    const document = docs.find((d) => d.documentId === input.documentId);
    if (document === undefined) return { outcome: 'not_found' };
    const raw = randomToken();
    const now = input.now ?? new Date().toISOString();
    const expiresAt = new Date(Date.parse(now) + ARTIFACT_GRANT_TTL_MINUTES * 60_000).toISOString();
    const written = await tx.query(
      `INSERT INTO artifact_access_grants
         (tenant_id, document_id, issued_to_lane, issued_to_user_link_id, token_sha256, issued_at, expires_at)
       VALUES ($1, $2, 'staff', $3, $4, $5::timestamptz, $6::timestamptz)
       RETURNING grant_id`,
      [input.tenantId, document.documentId, actor, tokenDigest(raw), now, expiresAt],
    );
    return {
      outcome: 'granted',
      grant: {
        grantId: String((written.rows[0] as Row).grant_id),
        documentId: document.documentId,
        expiresAt,
        path: `/api/jacket/artifacts/${composeLaneToken(input.tenantId, raw)}`,
      },
    };
  });
}

export type RedeemOutcome =
  | { outcome: 'ok'; document: DocumentView; content: Buffer }
  | { outcome: 'expired' }
  | { outcome: 'not_found' };

/** The door, opened with the token. Counted; refused after its clock. */
export async function redeemArtifactGrant(
  laneToken: string,
  now: string = new Date().toISOString(),
): Promise<RedeemOutcome> {
  const parts = splitLaneToken(laneToken);
  if (parts === null) return { outcome: 'not_found' };
  return withTenantTransaction(parts.tenantId, async (tx) => {
    const found = await tx.query(
      `SELECT grant_id, document_id, expires_at FROM artifact_access_grants
        WHERE tenant_id = $1 AND token_sha256 = $2 FOR UPDATE`,
      [parts.tenantId, tokenDigest(parts.token)],
    );
    if (found.rows.length === 0) return { outcome: 'not_found' };
    const g = found.rows[0] as Row;
    if (new Date(String(g.expires_at)).toISOString() <= now) return { outcome: 'expired' };
    const doc = await tx.query(
      `SELECT d.document_id, d.package_id, d.sequence_no, d.document_kind, d.title, d.template_id,
              d.template_code, d.template_version, d.template_sha256, d.template_approval_status,
              d.content_sha256, d.mime_type, d.byte_size, d.classification, d.malware_scan_result,
              d.malware_scanner, d.retention_policy_id, d.retention_policy_code,
              d.retention_policy_version, d.legal_hold, d.rendered_at, b.content
         FROM package_documents d
         JOIN document_blobs b ON b.content_sha256 = d.content_sha256
        WHERE d.tenant_id = $1 AND d.document_id = $2`,
      [parts.tenantId, String(g.document_id)],
    );
    if (doc.rows.length === 0) return { outcome: 'not_found' };
    await tx.query(
      `UPDATE artifact_access_grants SET used_count = used_count + 1, last_used_at = NOW()
        WHERE tenant_id = $1 AND grant_id = $2`,
      [parts.tenantId, String(g.grant_id)],
    );
    const row = doc.rows[0] as Row;
    const { content, ...rest } = row;
    return { outcome: 'ok', document: mapDocument(rest), content: content as Buffer };
  });
}

/** The completion certificate of a ceremony this person may read, as bytes. */
export async function certificateForStaff(input: {
  actingUserLinkId: string;
  tenantId: string;
  ceremonyId: string;
}): Promise<
  | { outcome: 'ok'; ceremony: CeremonyView; content: Buffer }
  | { outcome: 'not_found' }
  | { outcome: 'not_complete'; ceremony: CeremonyView }
> {
  return withTenantTransaction(input.tenantId, async (tx) => {
    const actor = await requireActor(tx, input.actingUserLinkId);
    const found = await tx.query(
      `SELECT package_id FROM signing_ceremonies WHERE tenant_id = $1 AND ceremony_id = $2`,
      [input.tenantId, input.ceremonyId],
    );
    if (found.rows.length === 0) return { outcome: 'not_found' };
    const held = await requirePackageWithin(
      tx,
      input.tenantId,
      actor,
      String((found.rows[0] as Row).package_id),
    );
    if (held === null) return { outcome: 'not_found' };
    const ceremony = await ceremonyOfPackageWithin(tx, input.tenantId, held.package.packageId);
    if (ceremony === null) return { outcome: 'not_found' };
    const content = await certificateContentWithin(tx, input.tenantId, ceremony);
    if (content === null) return { outcome: 'not_complete', ceremony };
    return { outcome: 'ok', ceremony, content };
  });
}
