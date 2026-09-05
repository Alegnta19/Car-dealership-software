/**
 * ROW 2 — APPRAISAL EVIDENCE.
 *
 * "Record structured trade identity, ownership/relationship, odometer,
 * condition, equipment, damage, inspection observations, attachments, source
 * quotations, timestamps, and provenance. Changes are versioned and
 * attributable; unavailable external valuation data is explicit rather than
 * fabricated."
 *
 * IDENTITY IS ONE ROW, EVIDENCE IS MANY VERSIONS. The VIN, year, make, model
 * and trim are the car; if they change it is a different car and a different
 * appraisal. Everything a walk-around finds changes twice before lunch, and
 * each change is a whole new version with a recorder, an instant and a reason.
 * `appraisal_versions` carries no UPDATE grant and a trigger that refuses one
 * anyway, so "versioned and attributable" is a property of the schema rather
 * than a habit of this file.
 *
 * WHY REVISING AN APPRAISAL AFTER AN APPROVAL IS ALLOWED. A scenario carries
 * its own inputs — the trade allowance it was priced with is a column on the
 * scenario, not a join to the appraisal — so new evidence about the car cannot
 * reach back and change a figure a manager approved. What it can do is make the
 * next scenario better, which is the entire reason a desk keeps looking at the
 * trade after the first pencil.
 */
import { withTenantTransaction, type Executor } from '@dealer/database';
import { recordMutation, requireActor, type MutationResult } from '@dealer/identity-access';

import { requireCaseWithin } from './intake';

interface Row {
  [key: string]: unknown;
}

export type Ownership = 'owned_outright' | 'financed' | 'leased';
export type Relationship = 'customer_owned' | 'co_owned' | 'third_party';
export type OdometerStatus = 'actual' | 'not_actual' | 'exceeds_limits';
export type ConditionGrade = 'rough' | 'average' | 'clean' | 'extra_clean';
export type Provenance = 'walk_around' | 'third_party_inspection' | 'customer_declared';
export type DamageSeverity = 'light' | 'moderate' | 'severe';
export type AttachmentKind = 'photo' | 'document' | 'report';
export type ProviderKind = 'deterministic_simulator' | 'certified_provider';
export type QuotationAvailability = 'quoted' | 'NOT_YET_AVAILABLE';

export interface DamageInput {
  area: string;
  severity: DamageSeverity;
  note?: string | null;
  estimatedRepairCents?: bigint | null;
}

export interface EquipmentInput {
  code: string;
  label: string;
  present: boolean;
}

export interface AppraisalEvidence {
  ownership: Ownership;
  relationship: Relationship;
  odometerMiles: number;
  odometerStatus: OdometerStatus;
  conditionGrade: ConditionGrade;
  provenance: Provenance;
  inspectionNotes?: string | null;
  changeReason?: string | null;
  damage?: readonly DamageInput[];
  equipment?: readonly EquipmentInput[];
  observations?: readonly string[];
}

export interface AppraisalView {
  readonly appraisalId: string;
  readonly deskingCaseId: string;
  readonly rooftopId: string;
  readonly vin: string;
  readonly modelYear: number;
  readonly make: string;
  readonly model: string;
  readonly trimLevel: string | null;
  readonly currentVersionNo: number;
  readonly authorizationVersion: number;
}

const APPRAISAL_COLUMNS = `appraisal_id, desking_case_id, rooftop_id, vin, model_year, make, model,
  trim_level, current_version_no, authorization_version`;

function mapAppraisal(row: Row): AppraisalView {
  return {
    appraisalId: String(row.appraisal_id),
    deskingCaseId: String(row.desking_case_id),
    rooftopId: String(row.rooftop_id),
    vin: String(row.vin),
    modelYear: Number(row.model_year),
    make: String(row.make),
    model: String(row.model),
    trimLevel: row.trim_level === null ? null : String(row.trim_level),
    currentVersionNo: Number(row.current_version_no),
    authorizationVersion: Number(row.authorization_version),
  };
}

export type AppraisalOutcome =
  | { outcome: 'recorded'; appraisal: AppraisalView; versionNo: number; mutation: MutationResult }
  | { outcome: 'already_recorded'; appraisal: AppraisalView }
  | { outcome: 'not_found' }
  | { outcome: 'version_conflict'; currentVersion: number }
  | { outcome: 'invalid'; error: string };

function evidenceProblem(evidence: AppraisalEvidence): string | null {
  if (!Number.isInteger(evidence.odometerMiles) || evidence.odometerMiles < 0) {
    return 'an odometer reading is a whole number of miles';
  }
  for (const item of evidence.damage ?? []) {
    if (item.area.trim().length === 0) return 'a damage note says where';
  }
  const codes = new Set<string>();
  for (const item of evidence.equipment ?? []) {
    if (codes.has(item.code)) return `equipment ${item.code} is listed twice`;
    codes.add(item.code);
  }
  return null;
}

/** One version's evidence, written as the append-only rows it is. */
async function writeVersion(
  executor: Executor,
  input: {
    tenantId: string;
    appraisalId: string;
    versionNo: number;
    actor: string;
    evidence: AppraisalEvidence;
  },
): Promise<string> {
  const { evidence } = input;
  const written = await executor.query(
    `INSERT INTO appraisal_versions
       (tenant_id, appraisal_id, version_no, ownership, relationship, odometer_miles,
        odometer_status, condition_grade, provenance, inspection_notes, change_reason,
        recorded_by_user_link_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING appraisal_version_id`,
    [
      input.tenantId,
      input.appraisalId,
      input.versionNo,
      evidence.ownership,
      evidence.relationship,
      evidence.odometerMiles,
      evidence.odometerStatus,
      evidence.conditionGrade,
      evidence.provenance,
      evidence.inspectionNotes ?? null,
      evidence.changeReason ?? null,
      input.actor,
    ],
  );
  const versionId = String((written.rows[0] as Row).appraisal_version_id);

  for (const item of evidence.damage ?? []) {
    await executor.query(
      `INSERT INTO appraisal_damage_items
         (tenant_id, appraisal_version_id, area, severity, note, estimated_repair_cents)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        input.tenantId,
        versionId,
        item.area,
        item.severity,
        item.note ?? null,
        item.estimatedRepairCents === undefined || item.estimatedRepairCents === null
          ? null
          : item.estimatedRepairCents.toString(),
      ],
    );
  }
  for (const item of evidence.equipment ?? []) {
    await executor.query(
      `INSERT INTO appraisal_equipment (tenant_id, appraisal_version_id, code, label, present)
       VALUES ($1, $2, $3, $4, $5)`,
      [input.tenantId, versionId, item.code, item.label, item.present],
    );
  }
  for (const observation of evidence.observations ?? []) {
    await executor.query(
      `INSERT INTO appraisal_observations
         (tenant_id, appraisal_version_id, observation, observed_by_user_link_id)
       VALUES ($1, $2, $3, $4)`,
      [input.tenantId, versionId, observation, input.actor],
    );
  }
  return versionId;
}

export async function recordAppraisalWithin(
  executor: Executor,
  input: {
    actingUserLinkId: string;
    tenantId: string;
    deskingCaseId: string;
    vin: string;
    modelYear: number;
    make: string;
    model: string;
    trimLevel?: string | null;
    evidence: AppraisalEvidence;
  },
): Promise<AppraisalOutcome> {
  const actor = await requireActor(executor, input.actingUserLinkId);
  const problem = evidenceProblem(input.evidence);
  if (problem !== null) return { outcome: 'invalid', error: problem };

  const deskingCase = await requireCaseWithin(executor, input.tenantId, actor, input.deskingCaseId);
  if (deskingCase === null) return { outcome: 'not_found' };

  const existing = await executor.query(
    `SELECT ${APPRAISAL_COLUMNS} FROM appraisals
      WHERE tenant_id = $1 AND desking_case_id = $2`,
    [input.tenantId, input.deskingCaseId],
  );
  if (existing.rows.length > 0) {
    return { outcome: 'already_recorded', appraisal: mapAppraisal(existing.rows[0] as Row) };
  }

  const written = await executor.query(
    `INSERT INTO appraisals
       (tenant_id, rooftop_id, desking_case_id, vin, model_year, make, model, trim_level,
        created_by_user_link_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (tenant_id, desking_case_id) DO NOTHING
     RETURNING ${APPRAISAL_COLUMNS}`,
    [
      input.tenantId,
      deskingCase.rooftopId,
      input.deskingCaseId,
      input.vin.toUpperCase(),
      input.modelYear,
      input.make,
      input.model,
      input.trimLevel ?? null,
      actor,
    ],
  );
  if (written.rows.length === 0) {
    const raced = await executor.query(
      `SELECT ${APPRAISAL_COLUMNS} FROM appraisals WHERE tenant_id = $1 AND desking_case_id = $2`,
      [input.tenantId, input.deskingCaseId],
    );
    return { outcome: 'already_recorded', appraisal: mapAppraisal(raced.rows[0] as Row) };
  }

  const appraisal = mapAppraisal(written.rows[0] as Row);
  await writeVersion(executor, {
    tenantId: input.tenantId,
    appraisalId: appraisal.appraisalId,
    versionNo: 1,
    actor,
    evidence: input.evidence,
  });
  const mutation = await recordMutation(executor, {
    tenantId: input.tenantId,
    entityType: 'appraisal',
    entityId: appraisal.appraisalId,
    eventType: 'desking.appraisal.recorded',
    actingUserLinkId: actor,
    authorizationVersion: appraisal.authorizationVersion,
    details: { desking_case_id: appraisal.deskingCaseId, vin: appraisal.vin, version_no: 1 },
  });
  return { outcome: 'recorded', appraisal, versionNo: 1, mutation };
}

export async function recordAppraisal(input: {
  actingUserLinkId: string;
  tenantId: string;
  deskingCaseId: string;
  vin: string;
  modelYear: number;
  make: string;
  model: string;
  trimLevel?: string | null;
  evidence: AppraisalEvidence;
}): Promise<AppraisalOutcome> {
  return withTenantTransaction(input.tenantId, async (tx) => recordAppraisalWithin(tx, input));
}

/** A new version of the evidence. The old one stays exactly as it was. */
export async function reviseAppraisal(input: {
  actingUserLinkId: string;
  tenantId: string;
  appraisalId: string;
  expectedVersion: number;
  evidence: AppraisalEvidence;
}): Promise<AppraisalOutcome> {
  return withTenantTransaction(input.tenantId, async (tx) => {
    const actor = await requireActor(tx, input.actingUserLinkId);
    const problem = evidenceProblem(input.evidence);
    if (problem !== null) return { outcome: 'invalid', error: problem };

    const found = await tx.query(
      `SELECT ${APPRAISAL_COLUMNS} FROM appraisals
        WHERE tenant_id = $1 AND appraisal_id = $2 FOR UPDATE`,
      [input.tenantId, input.appraisalId],
    );
    if (found.rows.length === 0) return { outcome: 'not_found' };
    const current = mapAppraisal(found.rows[0] as Row);
    const deskingCase = await requireCaseWithin(tx, input.tenantId, actor, current.deskingCaseId);
    if (deskingCase === null) return { outcome: 'not_found' };
    if (current.authorizationVersion !== input.expectedVersion) {
      return { outcome: 'version_conflict', currentVersion: current.authorizationVersion };
    }

    const nextVersionNo = current.currentVersionNo + 1;
    await writeVersion(tx, {
      tenantId: input.tenantId,
      appraisalId: current.appraisalId,
      versionNo: nextVersionNo,
      actor,
      evidence: input.evidence,
    });
    const bumped = await tx.query(
      `UPDATE appraisals
          SET current_version_no = $3, updated_at = NOW(),
              authorization_version = authorization_version + 1
        WHERE tenant_id = $1 AND appraisal_id = $2 AND authorization_version = $4
        RETURNING ${APPRAISAL_COLUMNS}`,
      [input.tenantId, input.appraisalId, nextVersionNo, input.expectedVersion],
    );
    if (bumped.rows.length === 0) {
      return { outcome: 'version_conflict', currentVersion: current.authorizationVersion };
    }
    const appraisal = mapAppraisal(bumped.rows[0] as Row);
    const mutation = await recordMutation(tx, {
      tenantId: input.tenantId,
      entityType: 'appraisal',
      entityId: appraisal.appraisalId,
      eventType: 'desking.appraisal.revised',
      actingUserLinkId: actor,
      authorizationVersion: appraisal.authorizationVersion,
      details: { version_no: nextVersionNo, change_reason: input.evidence.changeReason ?? null },
    });
    return { outcome: 'recorded', appraisal, versionNo: nextVersionNo, mutation };
  });
}

export type QuotationOutcome =
  | { outcome: 'recorded'; quotationId: string; mutation: MutationResult }
  | { outcome: 'not_found' }
  | { outcome: 'invalid'; error: string };

/**
 * AN OUTSIDE VALUATION, OR AN HONEST ABSENCE.
 *
 * The database will not let a row say NOT_YET_AVAILABLE and carry a number, or
 * say `quoted` without one. This function will not let a caller reach for a
 * `certified_provider` either: none is integrated, and a simulator wearing that
 * label is the exact fabrication Row 2 forbids.
 */
export async function recordSourceQuotation(input: {
  actingUserLinkId: string;
  tenantId: string;
  appraisalId: string;
  providerCode: string;
  providerKind: ProviderKind;
  availability: QuotationAvailability;
  quotedValueCents?: bigint | null;
  currency?: string | null;
  reference?: string | null;
  unavailableReason?: string | null;
}): Promise<QuotationOutcome> {
  return withTenantTransaction(input.tenantId, async (tx) => {
    const actor = await requireActor(tx, input.actingUserLinkId);
    const found = await tx.query(
      `SELECT ${APPRAISAL_COLUMNS} FROM appraisals WHERE tenant_id = $1 AND appraisal_id = $2`,
      [input.tenantId, input.appraisalId],
    );
    if (found.rows.length === 0) return { outcome: 'not_found' };
    const appraisal = mapAppraisal(found.rows[0] as Row);
    const deskingCase = await requireCaseWithin(tx, input.tenantId, actor, appraisal.deskingCaseId);
    if (deskingCase === null) return { outcome: 'not_found' };

    if (input.providerKind === 'certified_provider') {
      return {
        outcome: 'invalid',
        error:
          'no certified valuation provider is integrated in this phase — record the ' +
          'deterministic simulator as what it is, or record the absence',
      };
    }
    if (input.availability === 'quoted') {
      if (input.quotedValueCents === undefined || input.quotedValueCents === null) {
        return { outcome: 'invalid', error: 'a quotation carries the value that was quoted' };
      }
    } else if (
      input.unavailableReason === undefined ||
      input.unavailableReason === null ||
      input.unavailableReason.trim().length === 0
    ) {
      return { outcome: 'invalid', error: 'an unavailable valuation says why it is unavailable' };
    }

    const written = await tx.query(
      `INSERT INTO appraisal_source_quotations
         (tenant_id, appraisal_id, added_in_version_no, provider_code, provider_kind,
          availability, quoted_value_cents, currency, quoted_at, reference, unavailable_reason,
          recorded_by_user_link_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
               CASE WHEN $6 = 'quoted' THEN NOW() ELSE NULL END, $9, $10, $11)
       RETURNING quotation_id`,
      [
        input.tenantId,
        input.appraisalId,
        appraisal.currentVersionNo,
        input.providerCode,
        input.providerKind,
        input.availability,
        input.availability === 'quoted' && input.quotedValueCents !== undefined
          ? (input.quotedValueCents ?? 0n).toString()
          : null,
        input.availability === 'quoted' ? (input.currency ?? 'USD') : null,
        input.reference ?? null,
        input.availability === 'quoted' ? null : (input.unavailableReason ?? null),
        actor,
      ],
    );
    const quotationId = String((written.rows[0] as Row).quotation_id);
    const mutation = await recordMutation(tx, {
      tenantId: input.tenantId,
      entityType: 'appraisal',
      entityId: input.appraisalId,
      eventType: 'desking.appraisal.quotation_recorded',
      actingUserLinkId: actor,
      authorizationVersion: appraisal.authorizationVersion,
      details: {
        provider_code: input.providerCode,
        provider_kind: input.providerKind,
        availability: input.availability,
      },
    });
    return { outcome: 'recorded', quotationId, mutation };
  });
}

export type AttachmentOutcome =
  { outcome: 'recorded'; attachmentId: string } | { outcome: 'not_found' };

export async function addAppraisalAttachment(input: {
  actingUserLinkId: string;
  tenantId: string;
  appraisalId: string;
  kind: AttachmentKind;
  label: string;
  uri: string;
  contentSha256?: string | null;
}): Promise<AttachmentOutcome> {
  return withTenantTransaction(input.tenantId, async (tx) => {
    const actor = await requireActor(tx, input.actingUserLinkId);
    const found = await tx.query(
      `SELECT ${APPRAISAL_COLUMNS} FROM appraisals WHERE tenant_id = $1 AND appraisal_id = $2`,
      [input.tenantId, input.appraisalId],
    );
    if (found.rows.length === 0) return { outcome: 'not_found' };
    const appraisal = mapAppraisal(found.rows[0] as Row);
    if ((await requireCaseWithin(tx, input.tenantId, actor, appraisal.deskingCaseId)) === null) {
      return { outcome: 'not_found' };
    }
    const written = await tx.query(
      `INSERT INTO appraisal_attachments
         (tenant_id, appraisal_id, added_in_version_no, kind, label, uri, content_sha256,
          added_by_user_link_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING attachment_id`,
      [
        input.tenantId,
        input.appraisalId,
        appraisal.currentVersionNo,
        input.kind,
        input.label,
        input.uri,
        input.contentSha256 ?? null,
        actor,
      ],
    );
    return { outcome: 'recorded', attachmentId: String((written.rows[0] as Row).attachment_id) };
  });
}
