/**
 * OUTCOME 2 — THE CONFIGURATION A CHECKLIST IS RESOLVED FROM.
 *
 * "Resolve requirements from typed, effective-dated legal-entity, rooftop,
 * jurisdiction, transaction-type, and template configuration. Every requirement
 * must show its source and version."
 *
 * Three kinds of configuration, one shape. A TEMPLATE is the text a document is
 * rendered from; a REQUIREMENT says the deal needs a document or a piece of
 * evidence; a RETENTION POLICY says how long what was rendered is kept. Each is
 * a (code) versioned by a NEW ROW, bounded by an effective interval, scoped by
 * jurisdiction and optionally by legal entity and rooftop, and refused by a
 * GiST exclusion constraint when two versions would be in force over one
 * instant — the construction migration 065 gave the desking rule book, for the
 * same reason: a checklist that could resolve two answers cannot say what the
 * deal needs.
 *
 * THE HONEST TEMPLATE. A template row carries where its text came from and
 * whether anybody accountable APPROVED it for the jurisdiction it claims. The
 * default is `unapproved_sample`, an approval names who and when or the
 * database refuses it, and a package rendered from an unapproved template says
 * so on every document. Nothing here can turn a sample into a statutory form
 * by relabelling it.
 *
 * SPECIFICITY is decided here, once: a rooftop's own row beats its legal
 * entity's, which beats the tenant's; an exact transaction type beats `any`.
 */
import { withTenantTransaction, type Executor } from '@dealer/database';
import { reaches } from '@dealer/desking';
import {
  permittedRooftopIds,
  recordMutation,
  requireActor,
  type MutationResult,
} from '@dealer/identity-access';

import { sha256Hex } from './hashing';

interface Row {
  [key: string]: unknown;
}

export type DocumentKind = 'contract' | 'disclosure' | 'acknowledgement' | 'supporting';
export type TransactionType = 'retail_cash' | 'retail_finance';
export type ConfiguredTransactionType = TransactionType | 'any';
export type TemplateApprovalStatus = 'unapproved_sample' | 'approved' | 'withdrawn';
export type SignerRole = 'customer' | 'co_buyer' | 'dealer_representative';

export const DOCUMENT_KINDS: readonly DocumentKind[] = [
  'contract',
  'disclosure',
  'acknowledgement',
  'supporting',
];
export const SIGNER_ROLES: readonly SignerRole[] = [
  'customer',
  'co_buyer',
  'dealer_representative',
];
const TRANSACTION_TYPES: readonly ConfiguredTransactionType[] = [
  'retail_cash',
  'retail_finance',
  'any',
];
const CODE_RE = /^[a-z0-9_]{2,40}$/;
const JURISDICTION_RE = /^[A-Z0-9-]{2,40}$/;

// ── templates ───────────────────────────────────────────────────────────────

export interface TemplateView {
  readonly templateId: string;
  readonly templateCode: string;
  readonly version: number;
  readonly title: string;
  readonly documentKind: DocumentKind;
  readonly jurisdiction: string;
  readonly legalEntityId: string | null;
  readonly rooftopId: string | null;
  readonly transactionType: ConfiguredTransactionType;
  readonly source: string;
  readonly approvalStatus: TemplateApprovalStatus;
  readonly approvedByUserLinkId: string | null;
  readonly approvedAt: string | null;
  readonly approvalReference: string | null;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly bodyTemplate: string;
  readonly bodySha256: string;
  readonly requiredSignerRoles: readonly SignerRole[];
  readonly recordedByUserLinkId: string;
  readonly recordedAt: string;
}

/** A template as it is listed and returned: everything but the body, which the renderer fetches. */
export type TemplateSummary = Omit<TemplateView, 'bodyTemplate'>;

export function templateSummary(template: TemplateView): TemplateSummary {
  const summary: Record<string, unknown> = { ...template };
  delete summary.bodyTemplate;
  return summary as TemplateSummary;
}

const TEMPLATE_COLUMNS = `template_id, template_code, version, title, document_kind, jurisdiction,
  legal_entity_id, rooftop_id, transaction_type, source, approval_status, approved_by_user_link_id,
  approved_at, approval_reference, effective_from, effective_to, body_template, body_sha256,
  required_signer_roles, recorded_by_user_link_id, recorded_at`;

function iso(value: unknown): string {
  return new Date(String(value)).toISOString();
}

function mapTemplate(row: Row): TemplateView {
  return {
    templateId: String(row.template_id),
    templateCode: String(row.template_code),
    version: Number(row.version),
    title: String(row.title),
    documentKind: String(row.document_kind) as DocumentKind,
    jurisdiction: String(row.jurisdiction),
    legalEntityId: row.legal_entity_id === null ? null : String(row.legal_entity_id),
    rooftopId: row.rooftop_id === null ? null : String(row.rooftop_id),
    transactionType: String(row.transaction_type) as ConfiguredTransactionType,
    source: String(row.source),
    approvalStatus: String(row.approval_status) as TemplateApprovalStatus,
    approvedByUserLinkId:
      row.approved_by_user_link_id === null ? null : String(row.approved_by_user_link_id),
    approvedAt: row.approved_at === null ? null : iso(row.approved_at),
    approvalReference: row.approval_reference === null ? null : String(row.approval_reference),
    effectiveFrom: iso(row.effective_from),
    effectiveTo: row.effective_to === null ? null : iso(row.effective_to),
    bodyTemplate: String(row.body_template),
    bodySha256: String(row.body_sha256),
    requiredSignerRoles: (row.required_signer_roles as string[]).map((r) => r as SignerRole),
    recordedByUserLinkId: String(row.recorded_by_user_link_id),
    recordedAt: iso(row.recorded_at),
  };
}

export interface RecordTemplateInput {
  actingUserLinkId: string;
  tenantId: string;
  templateCode: string;
  title: string;
  documentKind: DocumentKind;
  jurisdiction: string;
  legalEntityId: string | null;
  rooftopId: string | null;
  transactionType: ConfiguredTransactionType;
  source: string;
  /**
   * `approved` requires an approval reference and is attributed to the acting
   * manager as the accountable approver. Anything else is an unapproved sample,
   * and is rendered as one.
   */
  approvalStatus: TemplateApprovalStatus;
  approvalReference: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  bodyTemplate: string;
  requiredSignerRoles: readonly SignerRole[];
  /**
   * End the version currently in force at THIS version's effective_from, so
   * the two meet without overlapping. Refused when the one in force started at
   * or after the new start — a version cannot be ended before it began.
   */
  closesPredecessor?: boolean;
}

export type RecordConfigurationOutcome<T> =
  | { outcome: 'recorded'; record: T; mutation: MutationResult }
  | { outcome: 'overlaps'; error: string }
  | { outcome: 'invalid'; error: string };

/**
 * End the open-ended version in force at `at`, for one (code, scope). One
 * literal statement per table so the static SQL guards can read both. Refuses
 * when the version in force started at or after `at`: a version is ended after
 * it began or not at all, and a caller who wants to replace one that has not
 * started yet records theirs with an explicit interval instead.
 */
async function closeOpenEndedPredecessor(
  executor: Executor,
  table: 'document_templates' | 'document_requirements',
  scope: {
    tenantId: string;
    code: string;
    jurisdiction: string;
    transactionType: ConfiguredTransactionType;
    legalEntityId: string | null;
    rooftopId: string | null;
    at: string;
  },
): Promise<{ version: number | null } | { error: string }> {
  const key = [
    scope.tenantId,
    scope.code,
    scope.jurisdiction,
    scope.transactionType,
    scope.legalEntityId,
    scope.rooftopId,
  ];
  const inForce =
    table === 'document_templates'
      ? await executor.query(
          `SELECT version, effective_from FROM document_templates
            WHERE tenant_id = $1 AND template_code = $2 AND jurisdiction = $3 AND transaction_type = $4
              AND legal_entity_id IS NOT DISTINCT FROM $5::uuid AND rooftop_id IS NOT DISTINCT FROM $6::uuid
              AND effective_to IS NULL
            FOR UPDATE`,
          key,
        )
      : await executor.query(
          `SELECT version, effective_from FROM document_requirements
            WHERE tenant_id = $1 AND requirement_code = $2 AND jurisdiction = $3 AND transaction_type = $4
              AND legal_entity_id IS NOT DISTINCT FROM $5::uuid AND rooftop_id IS NOT DISTINCT FROM $6::uuid
              AND effective_to IS NULL
            FOR UPDATE`,
          key,
        );
  if (inForce.rows.length === 0) return { version: null };
  const row = inForce.rows[0] as Row;
  if (Date.parse(String(row.effective_from)) >= Date.parse(scope.at)) {
    return {
      error: `version ${String(row.version)} starts at or after the new version, so it cannot be ended there — give the new version an explicit interval instead`,
    };
  }
  if (table === 'document_templates') {
    await executor.query(
      `UPDATE document_templates SET effective_to = $7::timestamptz
        WHERE tenant_id = $1 AND template_code = $2 AND jurisdiction = $3 AND transaction_type = $4
          AND legal_entity_id IS NOT DISTINCT FROM $5::uuid AND rooftop_id IS NOT DISTINCT FROM $6::uuid
          AND effective_to IS NULL`,
      [...key, scope.at],
    );
  } else {
    await executor.query(
      `UPDATE document_requirements SET effective_to = $7::timestamptz
        WHERE tenant_id = $1 AND requirement_code = $2 AND jurisdiction = $3 AND transaction_type = $4
          AND legal_entity_id IS NOT DISTINCT FROM $5::uuid AND rooftop_id IS NOT DISTINCT FROM $6::uuid
          AND effective_to IS NULL`,
      [...key, scope.at],
    );
  }
  return { version: Number(row.version) };
}

/** Postgres says 23P01 for an exclusion violation, and nothing else does. */
function isExclusionViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23P01'
  );
}

async function scopeIsReachable(
  tenantId: string,
  actor: string,
  rooftopId: string | null,
): Promise<boolean> {
  if (rooftopId === null) return true;
  return reaches(tenantId, actor, rooftopId);
}

function intervalProblem(from: string, to: string | null): string | null {
  if (Number.isNaN(Date.parse(from))) return 'effective_from is an instant';
  if (to !== null && (Number.isNaN(Date.parse(to)) || Date.parse(to) <= Date.parse(from))) {
    return 'a configured row stops after it starts';
  }
  return null;
}

export async function recordTemplateWithin(
  executor: Executor,
  input: RecordTemplateInput,
): Promise<RecordConfigurationOutcome<TemplateView>> {
  const actor = await requireActor(executor, input.actingUserLinkId);
  if (!CODE_RE.test(input.templateCode)) {
    return { outcome: 'invalid', error: 'a template code is 2–40 lower-case letters, digits or _' };
  }
  if (!DOCUMENT_KINDS.includes(input.documentKind)) {
    return { outcome: 'invalid', error: `a document is one of ${DOCUMENT_KINDS.join(', ')}` };
  }
  if (!JURISDICTION_RE.test(input.jurisdiction)) {
    return { outcome: 'invalid', error: 'a jurisdiction is an upper-case code such as US-CO' };
  }
  if (!TRANSACTION_TYPES.includes(input.transactionType)) {
    return {
      outcome: 'invalid',
      error: `a transaction type is one of ${TRANSACTION_TYPES.join(', ')}`,
    };
  }
  if (input.source.trim().length === 0) {
    return { outcome: 'invalid', error: 'a template names where its text came from' };
  }
  if (input.bodyTemplate.trim().length === 0) {
    return { outcome: 'invalid', error: 'a template has a body' };
  }
  if (
    input.requiredSignerRoles.length === 0 ||
    input.requiredSignerRoles.some((r) => !SIGNER_ROLES.includes(r))
  ) {
    return {
      outcome: 'invalid',
      error: `a template names who signs it, from ${SIGNER_ROLES.join(', ')}`,
    };
  }
  if (input.approvalStatus === 'approved' && (input.approvalReference ?? '').trim().length === 0) {
    return {
      outcome: 'invalid',
      error:
        'an approved template names the approval it rests on — a counsel memo, a regulator ' +
        'filing, a publisher licence — because "approved" with nothing behind it is the claim ' +
        'this table exists to refuse',
    };
  }
  const interval = intervalProblem(input.effectiveFrom, input.effectiveTo);
  if (interval !== null) return { outcome: 'invalid', error: interval };
  if (!(await scopeIsReachable(input.tenantId, actor, input.rooftopId))) {
    return { outcome: 'invalid', error: 'you do not configure documents at that rooftop' };
  }

  let closedPredecessorVersion: number | null = null;
  if (input.closesPredecessor === true) {
    const closed = await closeOpenEndedPredecessor(executor, 'document_templates', {
      tenantId: input.tenantId,
      code: input.templateCode,
      jurisdiction: input.jurisdiction,
      transactionType: input.transactionType,
      legalEntityId: input.legalEntityId,
      rooftopId: input.rooftopId,
      at: input.effectiveFrom,
    });
    if ('error' in closed) return { outcome: 'invalid', error: closed.error };
    closedPredecessorVersion = closed.version;
  }

  const next = await executor.query(
    `SELECT COALESCE(MAX(version), 0) + 1 AS next FROM document_templates
      WHERE tenant_id = $1 AND template_code = $2`,
    [input.tenantId, input.templateCode],
  );
  const version = Number((next.rows[0] as Row).next);
  const approved = input.approvalStatus === 'approved';

  let written;
  try {
    written = await executor.query(
      `INSERT INTO document_templates
         (tenant_id, template_code, version, title, document_kind, jurisdiction, legal_entity_id,
          rooftop_id, transaction_type, source, approval_status, approved_by_user_link_id,
          approved_at, approval_reference, effective_from, effective_to, body_template,
          body_sha256, required_signer_roles, recorded_by_user_link_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
               CASE WHEN $12::uuid IS NULL THEN NULL ELSE NOW() END, $13, $14, $15, $16, $17,
               $18::text[], $19)
       RETURNING ${TEMPLATE_COLUMNS}`,
      [
        input.tenantId,
        input.templateCode,
        version,
        input.title,
        input.documentKind,
        input.jurisdiction,
        input.legalEntityId,
        input.rooftopId,
        input.transactionType,
        input.source,
        input.approvalStatus,
        approved ? actor : null,
        approved ? input.approvalReference : null,
        input.effectiveFrom,
        input.effectiveTo,
        input.bodyTemplate,
        sha256Hex(input.bodyTemplate),
        [...input.requiredSignerRoles],
        actor,
      ],
    );
  } catch (error) {
    if (isExclusionViolation(error)) {
      return {
        outcome: 'overlaps',
        error:
          `template ${input.templateCode} for ${input.jurisdiction} is already in force over part ` +
          'of that interval at that scope — end the one in force before starting the next',
      };
    }
    throw error;
  }
  const record = mapTemplate(written.rows[0] as Row);
  const mutation = await recordMutation(executor, {
    tenantId: input.tenantId,
    entityType: 'document_template',
    entityId: record.templateId,
    eventType: 'jacket.template.recorded',
    actingUserLinkId: actor,
    authorizationVersion: record.version,
    details: {
      template_code: record.templateCode,
      version: record.version,
      jurisdiction: record.jurisdiction,
      approval_status: record.approvalStatus,
      source: record.source,
      body_sha256: record.bodySha256,
      closed_predecessor_version: closedPredecessorVersion,
    },
  });
  return { outcome: 'recorded', record, mutation };
}

export async function recordTemplate(
  input: RecordTemplateInput,
): Promise<RecordConfigurationOutcome<TemplateView>> {
  return withTenantTransaction(input.tenantId, async (tx) => recordTemplateWithin(tx, input));
}

// ── requirements ────────────────────────────────────────────────────────────

export interface RequirementView {
  readonly requirementId: string;
  readonly requirementCode: string;
  readonly version: number;
  readonly label: string;
  readonly jurisdiction: string;
  readonly legalEntityId: string | null;
  readonly rooftopId: string | null;
  readonly transactionType: ConfiguredTransactionType;
  readonly satisfiedBy: 'template' | 'evidence';
  readonly templateCode: string | null;
  readonly evidenceKind: string | null;
  readonly required: boolean;
  readonly waivable: boolean;
  readonly source: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly recordedByUserLinkId: string;
  readonly recordedAt: string;
}

const REQUIREMENT_COLUMNS = `requirement_id, requirement_code, version, label, jurisdiction,
  legal_entity_id, rooftop_id, transaction_type, satisfied_by, template_code, evidence_kind,
  required, waivable, source, effective_from, effective_to, recorded_by_user_link_id, recorded_at`;

function mapRequirement(row: Row): RequirementView {
  return {
    requirementId: String(row.requirement_id),
    requirementCode: String(row.requirement_code),
    version: Number(row.version),
    label: String(row.label),
    jurisdiction: String(row.jurisdiction),
    legalEntityId: row.legal_entity_id === null ? null : String(row.legal_entity_id),
    rooftopId: row.rooftop_id === null ? null : String(row.rooftop_id),
    transactionType: String(row.transaction_type) as ConfiguredTransactionType,
    satisfiedBy: String(row.satisfied_by) as 'template' | 'evidence',
    templateCode: row.template_code === null ? null : String(row.template_code),
    evidenceKind: row.evidence_kind === null ? null : String(row.evidence_kind),
    required: row.required === true,
    waivable: row.waivable === true,
    source: String(row.source),
    effectiveFrom: iso(row.effective_from),
    effectiveTo: row.effective_to === null ? null : iso(row.effective_to),
    recordedByUserLinkId: String(row.recorded_by_user_link_id),
    recordedAt: iso(row.recorded_at),
  };
}

export interface RecordRequirementInput {
  actingUserLinkId: string;
  tenantId: string;
  requirementCode: string;
  label: string;
  jurisdiction: string;
  legalEntityId: string | null;
  rooftopId: string | null;
  transactionType: ConfiguredTransactionType;
  satisfiedBy: 'template' | 'evidence';
  templateCode: string | null;
  evidenceKind: string | null;
  required: boolean;
  waivable: boolean;
  source: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  /** End the version in force at this version's start; see RecordTemplateInput. */
  closesPredecessor?: boolean;
}

export async function recordRequirementWithin(
  executor: Executor,
  input: RecordRequirementInput,
): Promise<RecordConfigurationOutcome<RequirementView>> {
  const actor = await requireActor(executor, input.actingUserLinkId);
  if (!CODE_RE.test(input.requirementCode)) {
    return {
      outcome: 'invalid',
      error: 'a requirement code is 2–40 lower-case letters, digits or _',
    };
  }
  if (!JURISDICTION_RE.test(input.jurisdiction)) {
    return { outcome: 'invalid', error: 'a jurisdiction is an upper-case code such as US-CO' };
  }
  if (!TRANSACTION_TYPES.includes(input.transactionType)) {
    return {
      outcome: 'invalid',
      error: `a transaction type is one of ${TRANSACTION_TYPES.join(', ')}`,
    };
  }
  if (
    input.satisfiedBy === 'template' &&
    (input.templateCode === null || !CODE_RE.test(input.templateCode))
  ) {
    return {
      outcome: 'invalid',
      error: 'a requirement satisfied by a document names the template code',
    };
  }
  if (
    input.satisfiedBy === 'evidence' &&
    (input.evidenceKind === null || !CODE_RE.test(input.evidenceKind))
  ) {
    return {
      outcome: 'invalid',
      error: 'a requirement satisfied by evidence names the kind of evidence',
    };
  }
  if (input.source.trim().length === 0) {
    return { outcome: 'invalid', error: 'a requirement names its source' };
  }
  const interval = intervalProblem(input.effectiveFrom, input.effectiveTo);
  if (interval !== null) return { outcome: 'invalid', error: interval };
  if (!(await scopeIsReachable(input.tenantId, actor, input.rooftopId))) {
    return { outcome: 'invalid', error: 'you do not configure documents at that rooftop' };
  }

  let closedPredecessorVersion: number | null = null;
  if (input.closesPredecessor === true) {
    const closed = await closeOpenEndedPredecessor(executor, 'document_requirements', {
      tenantId: input.tenantId,
      code: input.requirementCode,
      jurisdiction: input.jurisdiction,
      transactionType: input.transactionType,
      legalEntityId: input.legalEntityId,
      rooftopId: input.rooftopId,
      at: input.effectiveFrom,
    });
    if ('error' in closed) return { outcome: 'invalid', error: closed.error };
    closedPredecessorVersion = closed.version;
  }

  const next = await executor.query(
    `SELECT COALESCE(MAX(version), 0) + 1 AS next FROM document_requirements
      WHERE tenant_id = $1 AND requirement_code = $2`,
    [input.tenantId, input.requirementCode],
  );
  const version = Number((next.rows[0] as Row).next);
  let written;
  try {
    written = await executor.query(
      `INSERT INTO document_requirements
         (tenant_id, requirement_code, version, label, jurisdiction, legal_entity_id, rooftop_id,
          transaction_type, satisfied_by, template_code, evidence_kind, required, waivable, source,
          effective_from, effective_to, recorded_by_user_link_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
       RETURNING ${REQUIREMENT_COLUMNS}`,
      [
        input.tenantId,
        input.requirementCode,
        version,
        input.label,
        input.jurisdiction,
        input.legalEntityId,
        input.rooftopId,
        input.transactionType,
        input.satisfiedBy,
        input.satisfiedBy === 'template' ? input.templateCode : null,
        input.satisfiedBy === 'evidence' ? input.evidenceKind : null,
        input.required,
        input.waivable,
        input.source,
        input.effectiveFrom,
        input.effectiveTo,
        actor,
      ],
    );
  } catch (error) {
    if (isExclusionViolation(error)) {
      return {
        outcome: 'overlaps',
        error:
          `requirement ${input.requirementCode} for ${input.jurisdiction} is already in force over ` +
          'part of that interval at that scope — end the one in force before starting the next',
      };
    }
    throw error;
  }
  const record = mapRequirement(written.rows[0] as Row);
  const mutation = await recordMutation(executor, {
    tenantId: input.tenantId,
    entityType: 'document_requirement',
    entityId: record.requirementId,
    eventType: 'jacket.requirement.recorded',
    actingUserLinkId: actor,
    authorizationVersion: record.version,
    details: {
      requirement_code: record.requirementCode,
      version: record.version,
      jurisdiction: record.jurisdiction,
      satisfied_by: record.satisfiedBy,
      required: record.required,
      waivable: record.waivable,
      source: record.source,
      closed_predecessor_version: closedPredecessorVersion,
    },
  });
  return { outcome: 'recorded', record, mutation };
}

export async function recordRequirement(
  input: RecordRequirementInput,
): Promise<RecordConfigurationOutcome<RequirementView>> {
  return withTenantTransaction(input.tenantId, async (tx) => recordRequirementWithin(tx, input));
}

// ── retention policies ──────────────────────────────────────────────────────

export interface RetentionPolicyView {
  readonly retentionPolicyId: string;
  readonly policyCode: string;
  readonly version: number;
  readonly label: string;
  readonly retainForDays: number;
  readonly source: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly recordedByUserLinkId: string;
  readonly recordedAt: string;
}

const RETENTION_COLUMNS = `retention_policy_id, policy_code, version, label, retain_for_days, source,
  effective_from, effective_to, recorded_by_user_link_id, recorded_at`;

function mapRetention(row: Row): RetentionPolicyView {
  return {
    retentionPolicyId: String(row.retention_policy_id),
    policyCode: String(row.policy_code),
    version: Number(row.version),
    label: String(row.label),
    retainForDays: Number(row.retain_for_days),
    source: String(row.source),
    effectiveFrom: iso(row.effective_from),
    effectiveTo: row.effective_to === null ? null : iso(row.effective_to),
    recordedByUserLinkId: String(row.recorded_by_user_link_id),
    recordedAt: iso(row.recorded_at),
  };
}

/** The one policy code every rendered deal document is retained under. */
export const DEAL_DOCUMENT_RETENTION_CODE = 'deal_jacket_documents';

export interface RecordRetentionPolicyInput {
  actingUserLinkId: string;
  tenantId: string;
  policyCode: string;
  label: string;
  retainForDays: number;
  source: string;
  effectiveFrom: string;
  effectiveTo: string | null;
}

export async function recordRetentionPolicyWithin(
  executor: Executor,
  input: RecordRetentionPolicyInput,
): Promise<RecordConfigurationOutcome<RetentionPolicyView>> {
  const actor = await requireActor(executor, input.actingUserLinkId);
  if (!CODE_RE.test(input.policyCode)) {
    return { outcome: 'invalid', error: 'a policy code is 2–40 lower-case letters, digits or _' };
  }
  if (
    !Number.isInteger(input.retainForDays) ||
    input.retainForDays < 1 ||
    input.retainForDays > 36500
  ) {
    return {
      outcome: 'invalid',
      error: 'a retention period is a whole number of days, at least one',
    };
  }
  if (input.source.trim().length === 0) {
    return { outcome: 'invalid', error: 'a retention policy names its source' };
  }
  const interval = intervalProblem(input.effectiveFrom, input.effectiveTo);
  if (interval !== null) return { outcome: 'invalid', error: interval };

  const next = await executor.query(
    `SELECT COALESCE(MAX(version), 0) + 1 AS next FROM retention_policies
      WHERE tenant_id = $1 AND policy_code = $2`,
    [input.tenantId, input.policyCode],
  );
  const version = Number((next.rows[0] as Row).next);
  let written;
  try {
    written = await executor.query(
      `INSERT INTO retention_policies
         (tenant_id, policy_code, version, label, retain_for_days, source, effective_from,
          effective_to, recorded_by_user_link_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING ${RETENTION_COLUMNS}`,
      [
        input.tenantId,
        input.policyCode,
        version,
        input.label,
        input.retainForDays,
        input.source,
        input.effectiveFrom,
        input.effectiveTo,
        actor,
      ],
    );
  } catch (error) {
    if (isExclusionViolation(error)) {
      return {
        outcome: 'overlaps',
        error: `retention policy ${input.policyCode} is already in force over part of that interval`,
      };
    }
    throw error;
  }
  const record = mapRetention(written.rows[0] as Row);
  const mutation = await recordMutation(executor, {
    tenantId: input.tenantId,
    entityType: 'retention_policy',
    entityId: record.retentionPolicyId,
    eventType: 'jacket.retention_policy.recorded',
    actingUserLinkId: actor,
    authorizationVersion: record.version,
    details: {
      policy_code: record.policyCode,
      version: record.version,
      retain_for_days: record.retainForDays,
      source: record.source,
    },
  });
  return { outcome: 'recorded', record, mutation };
}

export async function recordRetentionPolicy(
  input: RecordRetentionPolicyInput,
): Promise<RecordConfigurationOutcome<RetentionPolicyView>> {
  return withTenantTransaction(input.tenantId, async (tx) =>
    recordRetentionPolicyWithin(tx, input),
  );
}

// ── resolution ──────────────────────────────────────────────────────────────

export interface ResolutionScope {
  readonly tenantId: string;
  readonly jurisdiction: string;
  readonly legalEntityId: string;
  readonly rooftopId: string;
  readonly transactionType: TransactionType;
  /** The instant the configuration is resolved AT, as an ISO string. */
  readonly at: string;
}

/** How exactly a configured row fits the deal: higher wins. */
function specificity(row: {
  rooftopId: string | null;
  legalEntityId: string | null;
  transactionType: ConfiguredTransactionType;
}): number {
  let score = 0;
  if (row.rooftopId !== null) score += 4;
  else if (row.legalEntityId !== null) score += 2;
  if (row.transactionType !== 'any') score += 1;
  return score;
}

function pickMostSpecific<
  T extends {
    rooftopId: string | null;
    legalEntityId: string | null;
    transactionType: ConfiguredTransactionType;
  },
>(rows: readonly T[], keyOf: (row: T) => string): Map<string, T> {
  const chosen = new Map<string, T>();
  for (const row of rows) {
    const key = keyOf(row);
    const held = chosen.get(key);
    if (held === undefined || specificity(row) > specificity(held)) chosen.set(key, row);
  }
  return chosen;
}

export interface ResolvedConfiguration {
  /** The requirements in force, one per code, most specific scope chosen. */
  readonly requirements: readonly RequirementView[];
  /** The templates in force, by code, most specific scope chosen. */
  readonly templatesByCode: ReadonlyMap<string, TemplateView>;
  /** The retention policy every rendered document is kept under, or null. */
  readonly retention: RetentionPolicyView | null;
}

const SCOPE_PREDICATE = `tenant_id = $1
        AND jurisdiction = $2
        AND (legal_entity_id IS NULL OR legal_entity_id = $3)
        AND (rooftop_id IS NULL OR rooftop_id = $4)
        AND transaction_type IN ($5, 'any')
        AND effective_from <= $6::timestamptz
        AND (effective_to IS NULL OR effective_to > $6::timestamptz)`;

/**
 * Everything in force for one deal at one instant. A read, so a resolution
 * can be repeated and compared — the jacket records what it resolved, and the
 * board asks again to see whether the answer has moved.
 */
export async function resolveConfigurationWithin(
  executor: Executor,
  scope: ResolutionScope,
): Promise<ResolvedConfiguration> {
  const params = [
    scope.tenantId,
    scope.jurisdiction,
    scope.legalEntityId,
    scope.rooftopId,
    scope.transactionType,
    scope.at,
  ];
  const requirementRows = await executor.query(
    `SELECT ${REQUIREMENT_COLUMNS} FROM document_requirements WHERE ${SCOPE_PREDICATE}`,
    params,
  );
  const requirements = pickMostSpecific(
    requirementRows.rows.map((r) => mapRequirement(r as Row)),
    (r) => r.requirementCode,
  );
  const templateRows = await executor.query(
    `SELECT ${TEMPLATE_COLUMNS} FROM document_templates WHERE ${SCOPE_PREDICATE}`,
    params,
  );
  const templatesByCode = pickMostSpecific(
    templateRows.rows.map((r) => mapTemplate(r as Row)),
    (t) => t.templateCode,
  );
  const retentionRows = await executor.query(
    `SELECT ${RETENTION_COLUMNS} FROM retention_policies
      WHERE tenant_id = $1 AND policy_code = $2
        AND effective_from <= $3::timestamptz
        AND (effective_to IS NULL OR effective_to > $3::timestamptz)`,
    [scope.tenantId, DEAL_DOCUMENT_RETENTION_CODE, scope.at],
  );
  const retention =
    retentionRows.rows.length === 0 ? null : mapRetention(retentionRows.rows[0] as Row);
  return {
    requirements: [...requirements.values()].sort((a, b) =>
      a.requirementCode.localeCompare(b.requirementCode),
    ),
    templatesByCode,
    retention,
  };
}

// ── listing ─────────────────────────────────────────────────────────────────

export interface ConfigurationListing {
  readonly templates: readonly TemplateSummary[];
  readonly requirements: readonly RequirementView[];
  readonly retentionPolicies: readonly RetentionPolicyView[];
}

/**
 * Every configured row this person may see: tenant-wide rows, and rooftop rows
 * at the rooftops they work. Template bodies are left out of the listing — a
 * body is fetched by the renderer, not browsed.
 */
export async function listConfiguration(
  tenantId: string,
  actingUserLinkId: string,
): Promise<ConfigurationListing> {
  return withTenantTransaction(tenantId, async (tx) => {
    const actor = await requireActor(tx, actingUserLinkId);
    const rooftops = await permittedRooftopIds(tenantId, actor);
    const scopeSql = `tenant_id = $1 AND (rooftop_id IS NULL OR rooftop_id = ANY($2::uuid[]))`;
    const templates = await tx.query(
      `SELECT ${TEMPLATE_COLUMNS} FROM document_templates WHERE ${scopeSql}
        ORDER BY template_code, version DESC LIMIT 500`,
      [tenantId, rooftops],
    );
    const requirements = await tx.query(
      `SELECT ${REQUIREMENT_COLUMNS} FROM document_requirements WHERE ${scopeSql}
        ORDER BY requirement_code, version DESC LIMIT 500`,
      [tenantId, rooftops],
    );
    const retention = await tx.query(
      `SELECT ${RETENTION_COLUMNS} FROM retention_policies WHERE tenant_id = $1
        ORDER BY policy_code, version DESC LIMIT 100`,
      [tenantId],
    );
    return {
      templates: templates.rows.map((r) => templateSummary(mapTemplate(r as Row))),
      requirements: requirements.rows.map((r) => mapRequirement(r as Row)),
      retentionPolicies: retention.rows.map((r) => mapRetention(r as Row)),
    };
  });
}
