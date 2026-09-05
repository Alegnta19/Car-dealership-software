/**
 * OUTCOMES 3 AND 4 — DETERMINISTIC ASSEMBLY, IMMUTABLE RENDERING.
 *
 * "Assemble fields from canonical records without operator rekeying or copied
 * shadow truth. Every financial figure must exactly match the approved FBL-120
 * version and preserve currency and fixed-decimal semantics. Record field
 * provenance and source versions." — "A changed input creates a new
 * superseding version; it never mutates a rendered or signed package."
 *
 * NOBODY TYPES A FIGURE. Every field below is read from the row that owns it
 * — the approved scenario, the appraisal's current version, the party, the
 * vehicle, the stock item, the legal entity, the rooftop — at assembly time,
 * through the same seam the jacket was opened through. A money field is the
 * scenario's own `BIGINT` cents with its own currency, copied as an integer;
 * nothing is recomputed, rounded or re-typed.
 *
 * THE FIELDS ARE THE PACKAGE'S IDENTITY. `fields_sha256` is the digest of the
 * assembled fields in canonical form, so the same inputs produce the same
 * digest on any machine, and a second assembly that changes nothing is
 * recognised as such and writes no version.
 *
 * A VERSION IS WRITTEN, NEVER EDITED. When an input HAS changed, the next
 * version is written carrying `supersedes_package_id`; the earlier one keeps
 * every field, every rendered byte and every signature it collected, and moves
 * to `superseded` — the only column on it that moves at all, which migration
 * 066's trigger holds for every role.
 *
 * STALE IS A REFUSAL. The jacket is bound to ONE approved version. If the desk
 * has since approved a successor, or the bound version is no longer approved,
 * the assembler refuses with `stale_source` and names the current version: the
 * paperwork for a deal whose figures moved is not quietly rebuilt on the new
 * figures under the old jacket — it is voided and reopened, on the record.
 */
import { withTenantTransaction, type Executor } from '@dealer/database';
import {
  currentApprovedFingerprintWithin,
  getApprovedDeskingVersionWithin,
  type ApprovedDeskingVersion,
} from '@dealer/desking';
import {
  enqueueAdminOutboxEvent,
  recordMutation,
  requireActor,
  type MutationResult,
} from '@dealer/identity-access';

import { checklistWithin, type ChecklistItemView } from './checklist';
import {
  resolveConfigurationWithin,
  type ResolvedConfiguration,
  type TemplateView,
} from './configuration';
import { digestOf, packageHashOf, sha256Hex } from './hashing';
import { requireJacketWithin, type JacketView } from './intake';
import { RENDERED_MIME, renderDocument, type AssembledField } from './render';

interface Row {
  [key: string]: unknown;
}

export type PackageState =
  | 'draft'
  | 'review_ready'
  | 'sent'
  | 'partially_signed'
  | 'signed_complete'
  | 'voided'
  | 'expired'
  | 'superseded';

/** States a package can still move out of by its own lifecycle. */
export const LIVE_PACKAGE_STATES: readonly PackageState[] = [
  'draft',
  'review_ready',
  'sent',
  'partially_signed',
];

export interface PackageView {
  readonly packageId: string;
  readonly jacketId: string;
  readonly rooftopId: string;
  readonly versionNo: number;
  readonly supersedesPackageId: string | null;
  readonly state: PackageState;
  readonly fieldsSha256: string;
  readonly packageSha256: string | null;
  readonly documentCount: number;
  readonly carriesUnapprovedTemplates: boolean;
  readonly reviewRequired: boolean;
  readonly reviewedByUserLinkId: string | null;
  readonly reviewedAt: string | null;
  readonly assembledByUserLinkId: string;
  readonly assembledAt: string;
  readonly expiresAt: string | null;
  readonly stateReason: string | null;
  readonly authorizationVersion: number;
}

export const PACKAGE_COLUMNS = `package_id, jacket_id, rooftop_id, version_no, supersedes_package_id,
  state, fields_sha256, package_sha256, document_count, carries_unapproved_templates,
  review_required, reviewed_by_user_link_id, reviewed_at, assembled_by_user_link_id, assembled_at,
  expires_at, state_reason, authorization_version`;

export function mapPackage(row: Row): PackageView {
  return {
    packageId: String(row.package_id),
    jacketId: String(row.jacket_id),
    rooftopId: String(row.rooftop_id),
    versionNo: Number(row.version_no),
    supersedesPackageId:
      row.supersedes_package_id === null ? null : String(row.supersedes_package_id),
    state: String(row.state) as PackageState,
    fieldsSha256: String(row.fields_sha256),
    packageSha256: row.package_sha256 === null ? null : String(row.package_sha256),
    documentCount: Number(row.document_count),
    carriesUnapprovedTemplates: row.carries_unapproved_templates === true,
    reviewRequired: row.review_required === true,
    reviewedByUserLinkId:
      row.reviewed_by_user_link_id === null ? null : String(row.reviewed_by_user_link_id),
    reviewedAt: row.reviewed_at === null ? null : new Date(String(row.reviewed_at)).toISOString(),
    assembledByUserLinkId: String(row.assembled_by_user_link_id),
    assembledAt: new Date(String(row.assembled_at)).toISOString(),
    expiresAt: row.expires_at === null ? null : new Date(String(row.expires_at)).toISOString(),
    stateReason: row.state_reason === null ? null : String(row.state_reason),
    authorizationVersion: Number(row.authorization_version),
  };
}

export interface DocumentView {
  readonly documentId: string;
  readonly packageId: string;
  readonly sequenceNo: number;
  readonly documentKind: string;
  readonly title: string;
  readonly templateId: string | null;
  readonly templateCode: string | null;
  readonly templateVersion: number | null;
  readonly templateSha256: string | null;
  readonly templateApprovalStatus: string | null;
  readonly contentSha256: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly classification: string;
  readonly malwareScanResult: string;
  readonly malwareScanner: string | null;
  readonly retentionPolicyId: string;
  readonly retentionPolicyCode: string;
  readonly retentionPolicyVersion: number;
  readonly legalHold: boolean;
  readonly renderedAt: string;
}

export const DOCUMENT_COLUMNS = `document_id, package_id, sequence_no, document_kind, title, template_id,
  template_code, template_version, template_sha256, template_approval_status, content_sha256,
  mime_type, byte_size, classification, malware_scan_result, malware_scanner, retention_policy_id,
  retention_policy_code, retention_policy_version, legal_hold, rendered_at`;

export function mapDocument(row: Row): DocumentView {
  return {
    documentId: String(row.document_id),
    packageId: String(row.package_id),
    sequenceNo: Number(row.sequence_no),
    documentKind: String(row.document_kind),
    title: String(row.title),
    templateId: row.template_id === null ? null : String(row.template_id),
    templateCode: row.template_code === null ? null : String(row.template_code),
    templateVersion: row.template_version === null ? null : Number(row.template_version),
    templateSha256: row.template_sha256 === null ? null : String(row.template_sha256),
    templateApprovalStatus:
      row.template_approval_status === null ? null : String(row.template_approval_status),
    contentSha256: String(row.content_sha256),
    mimeType: String(row.mime_type),
    byteSize: Number(row.byte_size),
    classification: String(row.classification),
    malwareScanResult: String(row.malware_scan_result),
    malwareScanner: row.malware_scanner === null ? null : String(row.malware_scanner),
    retentionPolicyId: String(row.retention_policy_id),
    retentionPolicyCode: String(row.retention_policy_code),
    retentionPolicyVersion: Number(row.retention_policy_version),
    legalHold: row.legal_hold === true,
    renderedAt: new Date(String(row.rendered_at)).toISOString(),
  };
}

export async function documentsOfPackageWithin(
  executor: Executor,
  tenantId: string,
  packageId: string,
): Promise<DocumentView[]> {
  const found = await executor.query(
    `SELECT ${DOCUMENT_COLUMNS} FROM package_documents
      WHERE tenant_id = $1 AND package_id = $2 ORDER BY sequence_no`,
    [tenantId, packageId],
  );
  return found.rows.map((r) => mapDocument(r as Row));
}

export async function fieldsOfPackageWithin(
  executor: Executor,
  tenantId: string,
  packageId: string,
): Promise<AssembledField[]> {
  const found = await executor.query(
    `SELECT field_code, value_kind, value_text, value_cents, value_integer, currency, source_kind,
            source_id, source_version
       FROM package_fields WHERE tenant_id = $1 AND package_id = $2 ORDER BY field_code`,
    [tenantId, packageId],
  );
  return found.rows.map((x) => {
    const r = x as Row;
    return {
      fieldCode: String(r.field_code),
      valueKind: String(r.value_kind) as AssembledField['valueKind'],
      valueText: r.value_text === null ? null : String(r.value_text),
      valueCents: r.value_cents === null ? null : BigInt(String(r.value_cents)),
      valueInteger: r.value_integer === null ? null : BigInt(String(r.value_integer)),
      currency: r.currency === null ? null : String(r.currency),
      sourceKind: String(r.source_kind),
      sourceId: r.source_id === null ? null : String(r.source_id),
      sourceVersion: String(r.source_version),
    };
  });
}

// ── the fields ──────────────────────────────────────────────────────────────

function text(
  code: string,
  value: string | null,
  source: { kind: string; id: string | null; version: string },
): AssembledField | null {
  if (value === null || value.length === 0) return null;
  return {
    fieldCode: code,
    valueKind: 'text',
    valueText: value,
    valueCents: null,
    valueInteger: null,
    currency: null,
    sourceKind: source.kind,
    sourceId: source.id,
    sourceVersion: source.version,
  };
}

function money(
  code: string,
  cents: bigint,
  currency: string,
  source: { kind: string; id: string | null; version: string },
): AssembledField {
  return {
    fieldCode: code,
    valueKind: 'money',
    valueText: null,
    valueCents: cents,
    valueInteger: null,
    currency,
    sourceKind: source.kind,
    sourceId: source.id,
    sourceVersion: source.version,
  };
}

function integer(
  code: string,
  value: bigint,
  kind: 'integer' | 'rate_ppm',
  source: { kind: string; id: string | null; version: string },
): AssembledField {
  return {
    fieldCode: code,
    valueKind: kind,
    valueText: null,
    valueCents: null,
    valueInteger: value,
    currency: null,
    sourceKind: source.kind,
    sourceId: source.id,
    sourceVersion: source.version,
  };
}

/**
 * Every field a document may name, read from the rows that own them. The list
 * is sorted by code before it is digested and stored, so its digest does not
 * depend on the order this function happens to build it in.
 */
export async function assembleFieldsWithin(
  executor: Executor,
  tenantId: string,
  jacket: JacketView,
  fact: ApprovedDeskingVersion,
): Promise<AssembledField[]> {
  const fields: (AssembledField | null)[] = [];
  const s = fact.scenario;
  const scenarioSource = {
    kind: 'desking_scenario',
    id: s.scenarioId,
    version: String(s.versionNo),
  };

  // THE FIGURES — the approved version's own integers, with its currency.
  fields.push(money('deal.vehicle_price', s.vehiclePriceCents, s.currency, scenarioSource));
  fields.push(money('deal.trade_allowance', s.tradeAllowanceCents, s.currency, scenarioSource));
  fields.push(money('deal.trade_payoff', s.tradePayoffCents, s.currency, scenarioSource));
  fields.push(money('deal.trade_equity', s.tradeEquityCents, s.currency, scenarioSource));
  fields.push(money('deal.cash_down', s.cashDownCents, s.currency, scenarioSource));
  fields.push(money('deal.taxable_amount', s.taxableAmountCents, s.currency, scenarioSource));
  fields.push(money('deal.tax_total', s.taxTotalCents, s.currency, scenarioSource));
  fields.push(money('deal.fee_total', s.feeTotalCents, s.currency, scenarioSource));
  fields.push(money('deal.incentive_total', s.incentiveTotalCents, s.currency, scenarioSource));
  fields.push(money('deal.amount_financed', s.amountFinancedCents, s.currency, scenarioSource));
  if (s.monthlyPaymentCents !== null) {
    fields.push(money('deal.monthly_payment', s.monthlyPaymentCents, s.currency, scenarioSource));
  }
  if (s.termMonths !== null) {
    fields.push(integer('deal.term_months', BigInt(s.termMonths), 'integer', scenarioSource));
  }
  if (s.aprPpm !== null) fields.push(integer('deal.apr', s.aprPpm, 'rate_ppm', scenarioSource));
  fields.push(text('deal.currency', s.currency, scenarioSource));
  fields.push(text('deal.jurisdiction', s.jurisdiction, scenarioSource));
  fields.push(text('deal.transaction_type', jacket.transactionType, scenarioSource));
  fields.push(text('deal.desking_version', `v${s.versionNo}`, scenarioSource));
  fields.push(text('deal.output_fingerprint', s.outputFingerprint, scenarioSource));
  fields.push(
    text('deal.approved_at', fact.approval.decidedAt, {
      kind: 'scenario_approval',
      id: fact.approval.approvalId,
      version: fact.approval.decidedAt,
    }),
  );

  // THE PARTIES TO IT.
  const party = await executor.query(
    `SELECT display_name, email, phone, address_line1, address_city, address_region,
            address_postal_code, address_country, authorization_version
       FROM parties WHERE tenant_id = $1 AND party_id = $2`,
    [tenantId, jacket.partyId],
  );
  const p = party.rows[0] as Row;
  const partySource = {
    kind: 'party',
    id: jacket.partyId,
    version: String(p.authorization_version),
  };
  fields.push(text('customer.name', String(p.display_name), partySource));
  fields.push(text('customer.email', p.email === null ? null : String(p.email), partySource));
  fields.push(text('customer.phone', p.phone === null ? null : String(p.phone), partySource));
  const address = [
    p.address_line1,
    p.address_city,
    p.address_region,
    p.address_postal_code,
    p.address_country,
  ]
    .filter((x) => x !== null && x !== undefined && String(x).length > 0)
    .map((x) => String(x))
    .join(', ');
  fields.push(text('customer.address', address.length === 0 ? null : address, partySource));

  const entity = await executor.query(
    `SELECT le.name AS entity_name, le.authorization_version AS entity_version,
            r.name AS rooftop_name, r.authorization_version AS rooftop_version
       FROM rooftops r
       JOIN legal_entities le ON le.tenant_id = r.tenant_id AND le.legal_entity_id = r.legal_entity_id
      WHERE r.tenant_id = $1 AND r.rooftop_id = $2`,
    [tenantId, jacket.rooftopId],
  );
  const e = entity.rows[0] as Row;
  fields.push(
    text('dealer.legal_entity', String(e.entity_name), {
      kind: 'legal_entity',
      id: jacket.legalEntityId,
      version: String(e.entity_version),
    }),
  );
  fields.push(
    text('dealer.rooftop', String(e.rooftop_name), {
      kind: 'rooftop',
      id: jacket.rooftopId,
      version: String(e.rooftop_version),
    }),
  );

  // THE CAR.
  if (jacket.stockItemId !== null) {
    const stock = await executor.query(
      `SELECT si.stock_number, si.authorization_version AS stock_version, si.odometer, si.odometer_unit,
              v.vehicle_id, v.vin, v.model_year, v.make, v.model, v.trim_level,
              v.authorization_version AS vehicle_version
         FROM stock_items si
         JOIN vehicles v ON v.tenant_id = si.tenant_id AND v.vehicle_id = si.vehicle_id
        WHERE si.tenant_id = $1 AND si.stock_item_id = $2`,
      [tenantId, jacket.stockItemId],
    );
    if (stock.rows.length > 0) {
      const v = stock.rows[0] as Row;
      const stockSource = {
        kind: 'stock_item',
        id: jacket.stockItemId,
        version: String(v.stock_version),
      };
      const vehicleSource = {
        kind: 'vehicle',
        id: String(v.vehicle_id),
        version: String(v.vehicle_version),
      };
      fields.push(text('vehicle.stock_number', String(v.stock_number), stockSource));
      fields.push(text('vehicle.vin', String(v.vin), vehicleSource));
      fields.push(
        text('vehicle.year', v.model_year === null ? null : String(v.model_year), vehicleSource),
      );
      fields.push(text('vehicle.make', v.make === null ? null : String(v.make), vehicleSource));
      fields.push(text('vehicle.model', v.model === null ? null : String(v.model), vehicleSource));
      fields.push(
        text('vehicle.trim', v.trim_level === null ? null : String(v.trim_level), vehicleSource),
      );
      if (v.odometer !== null) {
        fields.push(
          text('vehicle.odometer', `${String(v.odometer)} ${String(v.odometer_unit)}`, stockSource),
        );
      }
    }
  }

  // THE TRADE, at the evidence version the jacket bound.
  if (fact.trade !== null) {
    const t = fact.trade;
    const tradeSource = {
      kind: 'appraisal_version',
      id: t.appraisalId,
      version: String(t.currentVersionNo),
    };
    fields.push(text('trade.vin', t.vin, tradeSource));
    fields.push(text('trade.year', String(t.modelYear), tradeSource));
    fields.push(text('trade.make', t.make, tradeSource));
    fields.push(text('trade.model', t.model, tradeSource));
    fields.push(text('trade.trim', t.trimLevel, tradeSource));
    fields.push(integer('trade.odometer_miles', BigInt(t.odometerMiles), 'integer', tradeSource));
    fields.push(text('trade.odometer_status', t.odometerStatus, tradeSource));
    fields.push(text('trade.condition_grade', t.conditionGrade, tradeSource));
    fields.push(text('trade.ownership', t.ownership, tradeSource));
  }

  // THE RULES IT WAS PRICED UNDER, each as its own line.
  for (const rule of fact.ruleApplications) {
    fields.push(
      money(`rule.${rule.ruleKind}.${rule.ruleCode}`, rule.resolvedAmountCents, s.currency, {
        kind: 'desking_rule',
        id: rule.ruleId,
        version: String(rule.ruleVersion),
      }),
    );
    fields.push(
      text(
        `rule.${rule.ruleKind}.${rule.ruleCode}.source`,
        `${rule.source} (v${rule.ruleVersion})`,
        {
          kind: 'desking_rule',
          id: rule.ruleId,
          version: String(rule.ruleVersion),
        },
      ),
    );
  }

  return fields
    .filter((f): f is AssembledField => f !== null)
    .sort((a, b) => a.fieldCode.localeCompare(b.fieldCode));
}

/** The digest of the fields, in canonical form. */
export function fieldsDigest(fields: readonly AssembledField[]): string {
  return digestOf(
    fields.map((f) => ({
      code: f.fieldCode,
      kind: f.valueKind,
      text: f.valueText,
      cents: f.valueCents,
      integer: f.valueInteger,
      currency: f.currency,
      source: `${f.sourceKind}:${f.sourceId ?? ''}:${f.sourceVersion}`,
    })),
  );
}

// ── assembly ────────────────────────────────────────────────────────────────

export type AssembleOutcome =
  | {
      outcome: 'assembled';
      package: PackageView;
      documents: readonly DocumentView[];
      supersededPackageId: string | null;
      mutation: MutationResult;
    }
  | { outcome: 'already_current'; package: PackageView; documents: readonly DocumentView[] }
  | {
      outcome: 'render_failed';
      package: PackageView;
      failures: readonly { templateCode: string; reason: string }[];
    }
  | { outcome: 'stale_source'; boundVersionNo: number; currentVersionNo: number | null }
  | { outcome: 'version_conflict'; currentVersion: number }
  | { outcome: 'invalid'; error: string }
  | { outcome: 'not_found' };

interface PlannedDocument {
  readonly item: ChecklistItemView;
  readonly template: TemplateView;
}

/** The templates the checklist asks for, in force now; and the ones it cannot find. */
function planDocuments(
  items: readonly ChecklistItemView[],
  configuration: ResolvedConfiguration,
): { planned: PlannedDocument[]; failures: { templateCode: string; reason: string }[] } {
  const planned: PlannedDocument[] = [];
  const failures: { templateCode: string; reason: string }[] = [];
  for (const item of items) {
    if (item.satisfiedBy !== 'template' || item.templateCode === null) continue;
    if (item.state === 'waived') continue;
    const template = configuration.templatesByCode.get(item.templateCode);
    if (template === undefined) {
      failures.push({
        templateCode: item.templateCode,
        reason: `no version of template ${item.templateCode} is in force for this jurisdiction, scope and transaction type`,
      });
      continue;
    }
    if (template.approvalStatus === 'withdrawn') {
      failures.push({
        templateCode: item.templateCode,
        reason: `template ${item.templateCode} version ${template.version} is withdrawn`,
      });
      continue;
    }
    planned.push({ item, template });
  }
  return { planned, failures };
}

/**
 * The version the next one supersedes: the live package if there is one, else
 * the completed package — the one move out of `signed_complete` the trigger
 * permits, because redoing the paperwork after it was signed is exactly
 * "explicit versioned supersession". Voided, expired and superseded versions
 * are final and are not superseded again.
 */
async function predecessorPackageWithin(
  executor: Executor,
  tenantId: string,
  jacketId: string,
): Promise<PackageView | null> {
  const found = await executor.query(
    `SELECT ${PACKAGE_COLUMNS} FROM jacket_packages
      WHERE tenant_id = $1 AND jacket_id = $2
        AND state IN ('draft', 'review_ready', 'sent', 'partially_signed', 'signed_complete')
      ORDER BY version_no DESC
      LIMIT 1
      FOR UPDATE`,
    [tenantId, jacketId],
  );
  return found.rows.length === 0 ? null : mapPackage(found.rows[0] as Row);
}

/** Whether the jacket is under a legal hold right now: the last hold event says. */
async function jacketHeldWithin(
  executor: Executor,
  tenantId: string,
  jacketId: string,
): Promise<boolean> {
  const last = await executor.query(
    `SELECT action FROM legal_hold_events WHERE tenant_id = $1 AND jacket_id = $2
      ORDER BY occurred_at DESC, hold_event_id DESC LIMIT 1`,
    [tenantId, jacketId],
  );
  return last.rows.length > 0 && String((last.rows[0] as Row).action) === 'placed';
}

/** The template versions a package was rendered from, as a digest. */
function templatesDigest(planned: readonly PlannedDocument[]): string {
  return digestOf(
    planned.map((p) => `${p.template.templateCode}:${p.template.version}:${p.template.bodySha256}`),
  );
}

async function templatesDigestOfPackage(
  executor: Executor,
  tenantId: string,
  packageId: string,
): Promise<string> {
  const docs = await documentsOfPackageWithin(executor, tenantId, packageId);
  return digestOf(
    docs
      .filter((d) => d.templateCode !== null)
      .map((d) => `${d.templateCode}:${d.templateVersion}:${d.templateSha256}`),
  );
}

export async function assemblePackageWithin(
  executor: Executor,
  input: {
    actingUserLinkId: string;
    tenantId: string;
    jacketId: string;
    expectedVersion: number;
    now?: string;
  },
): Promise<AssembleOutcome> {
  const actor = await requireActor(executor, input.actingUserLinkId);
  const now = input.now ?? new Date().toISOString();
  const jacket = await requireJacketWithin(executor, input.tenantId, actor, input.jacketId);
  if (jacket === null) return { outcome: 'not_found' };
  if (jacket.state === 'voided') {
    return {
      outcome: 'invalid',
      error: 'this jacket was voided; open a new one from the desk’s current approval',
    };
  }

  // THE BOUND VERSION MUST STILL BE THE ONE THE DESK STANDS BEHIND.
  const current = await currentApprovedFingerprintWithin(executor, {
    tenantId: input.tenantId,
    deskingCaseId: jacket.deskingCaseId,
  });
  const stale =
    current === null ||
    current.scenarioId !== jacket.approvedScenarioId ||
    current.outputFingerprint !== jacket.approvedOutputFingerprint;
  if (stale) {
    return {
      outcome: 'stale_source',
      boundVersionNo: jacket.scenarioVersionNo,
      currentVersionNo: current === null ? null : current.versionNo,
    };
  }
  const fact = await getApprovedDeskingVersionWithin(executor, {
    tenantId: input.tenantId,
    deskingCaseId: jacket.deskingCaseId,
  });
  if (fact === null) {
    return {
      outcome: 'stale_source',
      boundVersionNo: jacket.scenarioVersionNo,
      currentVersionNo: null,
    };
  }
  if (jacket.authorizationVersion !== input.expectedVersion) {
    return { outcome: 'version_conflict', currentVersion: jacket.authorizationVersion };
  }

  const fields = await assembleFieldsWithin(executor, input.tenantId, jacket, fact);
  const fieldsSha256 = fieldsDigest(fields);
  const items = await checklistWithin(executor, input.tenantId, jacket.jacketId);
  const configuration = await resolveConfigurationWithin(executor, {
    tenantId: input.tenantId,
    jurisdiction: jacket.jurisdiction,
    legalEntityId: jacket.legalEntityId,
    rooftopId: jacket.rooftopId,
    transactionType: jacket.transactionType,
    at: now,
  });
  const { planned, failures } = planDocuments(items, configuration);
  if (planned.length === 0 && failures.length === 0) {
    return {
      outcome: 'invalid',
      error:
        'no document requirement is configured for this jurisdiction, legal entity, rooftop and ' +
        'transaction type — a package with nothing in it is not a package',
    };
  }
  if (configuration.retention === null) {
    return {
      outcome: 'invalid',
      error: `no retention policy ${'deal_jacket_documents'} is in force — a rendered document must know how long it is kept before it is rendered`,
    };
  }

  // SAME INPUTS, SAME TEMPLATES: nothing to write.
  const live = await predecessorPackageWithin(executor, input.tenantId, jacket.jacketId);
  if (
    live !== null &&
    live.fieldsSha256 === fieldsSha256 &&
    live.documentCount > 0 &&
    failures.length === 0 &&
    (await templatesDigestOfPackage(executor, input.tenantId, live.packageId)) ===
      templatesDigest(planned)
  ) {
    return {
      outcome: 'already_current',
      package: live,
      documents: await documentsOfPackageWithin(executor, input.tenantId, live.packageId),
    };
  }

  // Render everything BEFORE writing anything, so a failure writes a failure
  // and not half a package.
  const rendered: { plan: PlannedDocument; html: string }[] = [];
  const renderFailures = [...failures];
  const nextVersionRow = await executor.query(
    `SELECT COALESCE(MAX(version_no), 0) + 1 AS next FROM jacket_packages
      WHERE tenant_id = $1 AND jacket_id = $2`,
    [input.tenantId, jacket.jacketId],
  );
  const versionNo = Number((nextVersionRow.rows[0] as Row).next);
  for (const plan of planned) {
    const out = renderDocument({
      title: plan.template.title,
      templateCode: plan.template.templateCode,
      templateVersion: plan.template.version,
      bodyTemplate: plan.template.bodyTemplate,
      approvalStatus: plan.template.approvalStatus,
      source: plan.template.source,
      jurisdiction: plan.template.jurisdiction,
      fields,
      packageVersionNo: versionNo,
    });
    if (out.outcome === 'unresolved') {
      renderFailures.push({
        templateCode: plan.template.templateCode,
        reason: `template ${plan.template.templateCode} version ${plan.template.version} names fields this deal does not carry: ${out.missing.join(', ')}`,
      });
      continue;
    }
    rendered.push({ plan, html: out.html });
  }

  // The predecessor steps aside either way — a failed render is still the
  // newest fact about this jacket's paperwork.
  let supersededPackageId: string | null = null;
  if (live !== null) {
    await executor.query(
      `UPDATE jacket_packages
          SET state = 'superseded', state_reason = $3, updated_at = NOW(),
              authorization_version = authorization_version + 1
        WHERE tenant_id = $1 AND package_id = $2`,
      [input.tenantId, live.packageId, `superseded by version ${versionNo}`],
    );
    // A ceremony on the superseded package can take no further signature: the
    // trigger refuses one against a superseded package, and the ceremony itself
    // is voided so its signers' links stop working.
    await executor.query(
      `UPDATE signing_ceremonies
          SET state = 'voided', updated_at = NOW(), authorization_version = authorization_version + 1
        WHERE tenant_id = $1 AND package_id = $2 AND state IN ('created', 'sent', 'in_progress')`,
      [input.tenantId, live.packageId],
    );
    supersededPackageId = live.packageId;
  }

  const held = await jacketHeldWithin(executor, input.tenantId, jacket.jacketId);
  const carriesUnapproved = rendered.some((r) => r.plan.template.approvalStatus !== 'approved');
  const hasWaivers = items.some((i) => i.state === 'waived');
  const failed = renderFailures.length > 0;
  const inserted = await executor.query(
    `INSERT INTO jacket_packages
       (tenant_id, jacket_id, rooftop_id, version_no, supersedes_package_id, state, fields_sha256,
        carries_unapproved_templates, review_required, assembled_by_user_link_id, state_reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING ${PACKAGE_COLUMNS}`,
    [
      input.tenantId,
      jacket.jacketId,
      jacket.rooftopId,
      versionNo,
      supersededPackageId,
      failed ? 'voided' : 'draft',
      fieldsSha256,
      carriesUnapproved,
      carriesUnapproved || hasWaivers,
      actor,
      failed
        ? `render failure: ${renderFailures.map((f) => f.reason).join('; ')}`.slice(0, 400)
        : null,
    ],
  );
  const pkg = mapPackage(inserted.rows[0] as Row);

  for (const f of fields) {
    await executor.query(
      `INSERT INTO package_fields
         (tenant_id, package_id, field_code, value_kind, value_text, value_cents, value_integer,
          currency, source_kind, source_id, source_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        input.tenantId,
        pkg.packageId,
        f.fieldCode,
        f.valueKind,
        f.valueText,
        f.valueCents === null ? null : f.valueCents.toString(),
        f.valueInteger === null ? null : f.valueInteger.toString(),
        f.currency,
        f.sourceKind,
        f.sourceId,
        f.sourceVersion,
      ],
    );
  }

  if (failed) {
    // Every jacket version bumps once per assembly attempt, so a stale screen
    // learns it is stale even when nothing rendered.
    await executor.query(
      `UPDATE deal_jackets SET updated_at = NOW(), authorization_version = authorization_version + 1
        WHERE tenant_id = $1 AND jacket_id = $2`,
      [input.tenantId, jacket.jacketId],
    );
    await recordMutation(executor, {
      tenantId: input.tenantId,
      entityType: 'jacket_package',
      entityId: pkg.packageId,
      eventType: 'jacket.package.render_failed',
      actingUserLinkId: actor,
      authorizationVersion: pkg.authorizationVersion,
      details: {
        jacket_id: jacket.jacketId,
        version_no: versionNo,
        failures: renderFailures.map((f) => f.templateCode),
      },
    });
    return { outcome: 'render_failed', package: pkg, failures: renderFailures };
  }

  const documents: DocumentView[] = [];
  const digests: string[] = [];
  let sequence = 0;
  for (const r of rendered) {
    sequence += 1;
    const bytes = Buffer.from(r.html, 'utf8');
    const contentSha256 = sha256Hex(bytes);
    // CONTENT-ADDRESSED: the same bytes are one blob however many packages name them.
    await executor.query(
      `INSERT INTO document_blobs (content_sha256, mime_type, byte_size, content)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (content_sha256) DO NOTHING`,
      [contentSha256, RENDERED_MIME, bytes.byteLength, bytes],
    );
    const doc = await executor.query(
      `INSERT INTO package_documents
         (tenant_id, package_id, sequence_no, document_kind, title, template_id, template_code,
          template_version, template_sha256, template_approval_status, content_sha256, mime_type,
          byte_size, classification, malware_scan_result, malware_scanner, retention_policy_id,
          retention_policy_code, retention_policy_version, legal_hold)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'customer_confidential',
               'not_scanned', NULL, $14, $15, $16, $17)
       RETURNING ${DOCUMENT_COLUMNS}`,
      [
        input.tenantId,
        pkg.packageId,
        sequence,
        r.plan.template.documentKind,
        r.plan.template.title,
        r.plan.template.templateId,
        r.plan.template.templateCode,
        r.plan.template.version,
        r.plan.template.bodySha256,
        r.plan.template.approvalStatus,
        contentSha256,
        RENDERED_MIME,
        bytes.byteLength,
        configuration.retention.retentionPolicyId,
        configuration.retention.policyCode,
        configuration.retention.version,
        held,
      ],
    );
    const view = mapDocument(doc.rows[0] as Row);
    documents.push(view);
    digests.push(contentSha256);
    // The checklist line this document satisfies now points at THIS version's document.
    await executor.query(
      `UPDATE jacket_checklist_items
          SET state = 'satisfied', satisfied_document_id = $4, updated_at = NOW(),
              authorization_version = authorization_version + 1
        WHERE tenant_id = $1 AND jacket_id = $2 AND item_id = $3 AND state <> 'waived'`,
      [input.tenantId, jacket.jacketId, r.plan.item.itemId, view.documentId],
    );
  }

  const packageSha256 = packageHashOf(digests);
  const sealed = await executor.query(
    `UPDATE jacket_packages
        SET package_sha256 = $3, document_count = $4, updated_at = NOW(),
            authorization_version = authorization_version + 1
      WHERE tenant_id = $1 AND package_id = $2
      RETURNING ${PACKAGE_COLUMNS}`,
    [input.tenantId, pkg.packageId, packageSha256, documents.length],
  );
  const finalPackage = mapPackage(sealed.rows[0] as Row);

  // A jacket that had finished signing and is re-assembled is open paperwork again.
  const reopened = await executor.query(
    `UPDATE deal_jackets
        SET state = 'open', updated_at = NOW(), authorization_version = authorization_version + 1
      WHERE tenant_id = $1 AND jacket_id = $2
      RETURNING authorization_version`,
    [input.tenantId, jacket.jacketId],
  );
  const mutation = await recordMutation(executor, {
    tenantId: input.tenantId,
    entityType: 'jacket_package',
    entityId: finalPackage.packageId,
    eventType: 'jacket.package.assembled',
    actingUserLinkId: actor,
    authorizationVersion: finalPackage.authorizationVersion,
    details: {
      jacket_id: jacket.jacketId,
      version_no: finalPackage.versionNo,
      supersedes_package_id: supersededPackageId,
      fields_sha256: finalPackage.fieldsSha256,
      package_sha256: finalPackage.packageSha256,
      document_count: finalPackage.documentCount,
      carries_unapproved_templates: finalPackage.carriesUnapprovedTemplates,
      jacket_authorization_version: Number((reopened.rows[0] as Row).authorization_version),
    },
  });
  await enqueueAdminOutboxEvent(executor, {
    tenantId: input.tenantId,
    eventType: 'jacket.package.assembled',
    payload: {
      jacket_id: jacket.jacketId,
      package_id: finalPackage.packageId,
      version_no: finalPackage.versionNo,
      package_sha256: finalPackage.packageSha256,
      rooftop_id: jacket.rooftopId,
    },
  });
  return { outcome: 'assembled', package: finalPackage, documents, supersededPackageId, mutation };
}

export async function assemblePackage(input: {
  actingUserLinkId: string;
  tenantId: string;
  jacketId: string;
  expectedVersion: number;
}): Promise<AssembleOutcome> {
  return withTenantTransaction(input.tenantId, async (tx) => assemblePackageWithin(tx, input));
}

/** One package by id, locked, or null when unreachable — same null, on purpose. */
export async function requirePackageWithin(
  executor: Executor,
  tenantId: string,
  actor: string,
  packageId: string,
): Promise<{ package: PackageView; jacket: JacketView } | null> {
  const found = await executor.query(
    `SELECT ${PACKAGE_COLUMNS} FROM jacket_packages WHERE tenant_id = $1 AND package_id = $2 FOR UPDATE`,
    [tenantId, packageId],
  );
  if (found.rows.length === 0) return null;
  const pkg = mapPackage(found.rows[0] as Row);
  const jacket = await requireJacketWithin(executor, tenantId, actor, pkg.jacketId);
  if (jacket === null) return null;
  return { package: pkg, jacket };
}
