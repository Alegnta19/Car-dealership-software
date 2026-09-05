/**
 * OUTCOME 1 — CANONICAL INTAKE AND IDENTITY.
 *
 * "Consume the exact approved desking version through FBL-120's public
 * interface or published fact. Bind tenant, legal entity, rooftop, opportunity,
 * party, selected stock, trade/appraisal context, approved scenario version,
 * and rule versions. Retry and concurrency must converge without duplicate
 * active jackets."
 *
 * OPENED FROM ONE APPROVED VERSION, EXACTLY ONCE. The fact is read through the
 * seam `@dealer/desking` exposes and nowhere else. `(tenant_id,
 * approved_scenario_id)` is unique and the desk already holds one approved
 * version per file, so "one active jacket per deal" is two keys deep; a partial
 * unique index refuses a second active jacket on the same file whatever
 * version it names.
 *
 * CONVERGENCE IS BUILT THREE TIMES, each guard alone giving the right answer —
 * the construction Release Train 4 and FBL-120 both arrived at, for the same
 * reason. An advisory lock keyed on the desk file serialises two callers who
 * arrive together; `ON CONFLICT DO NOTHING` catches the pair the lock cannot
 * (two connections, one committed between the pre-check and the insert); and
 * the raced re-select turns the empty RETURNING into the jacket the other
 * caller just wrote.
 *
 * WHAT IS BOUND IS RECORDED WITH ITS VERSION. `jacket_source_bindings` names
 * every canonical row the package will be assembled from and the version it
 * carried at the instant of binding, so "what was this built from" is answered
 * with versions rather than with a join to whatever those rows say today.
 *
 * FOREIGN REFERENCES REFUSE WITHOUT DISCLOSURE. A desk file at a rooftop the
 * caller does not work answers `not_found` — the same words a file that was
 * never opened gets.
 */
import { withTenantTransaction, type Executor } from '@dealer/database';
import {
  getApprovedDeskingVersionWithin,
  reaches,
  type ApprovedDeskingVersion,
} from '@dealer/desking';
import {
  enqueueAdminOutboxEvent,
  recordMutation,
  requireActor,
  type MutationResult,
} from '@dealer/identity-access';

import { resolveConfigurationWithin, type TransactionType } from './configuration';

interface Row {
  [key: string]: unknown;
}

export type JacketState = 'open' | 'signed_complete' | 'voided';

export interface JacketView {
  readonly jacketId: string;
  readonly legalEntityId: string;
  readonly rooftopId: string;
  readonly deskingCaseId: string;
  readonly opportunityId: string;
  readonly partyId: string;
  readonly stockItemId: string | null;
  readonly appraisalId: string | null;
  readonly appraisalVersionNo: number | null;
  readonly approvedScenarioId: string;
  readonly scenarioVersionNo: number;
  readonly approvedOutputFingerprint: string;
  readonly approvalId: string;
  readonly jurisdiction: string;
  readonly transactionType: TransactionType;
  readonly state: JacketState;
  readonly openedByUserLinkId: string;
  readonly openedAt: string;
  readonly authorizationVersion: number;
  readonly updatedAt: string;
}

export const JACKET_COLUMNS = `jacket_id, legal_entity_id, rooftop_id, desking_case_id, opportunity_id,
  party_id, stock_item_id, appraisal_id, appraisal_version_no, approved_scenario_id,
  scenario_version_no, approved_output_fingerprint, approval_id, jurisdiction, transaction_type,
  state, opened_by_user_link_id, opened_at, authorization_version, updated_at`;

export function mapJacket(row: Row): JacketView {
  return {
    jacketId: String(row.jacket_id),
    legalEntityId: String(row.legal_entity_id),
    rooftopId: String(row.rooftop_id),
    deskingCaseId: String(row.desking_case_id),
    opportunityId: String(row.opportunity_id),
    partyId: String(row.party_id),
    stockItemId: row.stock_item_id === null ? null : String(row.stock_item_id),
    appraisalId: row.appraisal_id === null ? null : String(row.appraisal_id),
    appraisalVersionNo: row.appraisal_version_no === null ? null : Number(row.appraisal_version_no),
    approvedScenarioId: String(row.approved_scenario_id),
    scenarioVersionNo: Number(row.scenario_version_no),
    approvedOutputFingerprint: String(row.approved_output_fingerprint),
    approvalId: String(row.approval_id),
    jurisdiction: String(row.jurisdiction),
    transactionType: String(row.transaction_type) as TransactionType,
    state: String(row.state) as JacketState,
    openedByUserLinkId: String(row.opened_by_user_link_id),
    openedAt: new Date(String(row.opened_at)).toISOString(),
    authorizationVersion: Number(row.authorization_version),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
  };
}

/** A finance deal has a term; a cash deal does not. Nothing else decides it. */
export function transactionTypeOf(scenario: { termMonths: number | null }): TransactionType {
  return scenario.termMonths === null ? 'retail_cash' : 'retail_finance';
}

export type OpenJacketOutcome =
  | { outcome: 'opened'; jacket: JacketView; mutation: MutationResult }
  | { outcome: 'already_open'; jacket: JacketView }
  | { outcome: 'not_approved'; error: string }
  | { outcome: 'not_found' };

function intakeKey(tenantId: string, deskingCaseId: string): string {
  return `fbl140:jacket:${tenantId}:${deskingCaseId}`;
}

async function bind(
  executor: Executor,
  tenantId: string,
  jacketId: string,
  binding: {
    kind: string;
    id: string;
    version: string;
    fingerprint?: string | null;
  },
): Promise<void> {
  await executor.query(
    `INSERT INTO jacket_source_bindings
       (tenant_id, jacket_id, source_kind, source_id, source_version, source_fingerprint)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (tenant_id, jacket_id, source_kind, source_id) DO NOTHING`,
    [tenantId, jacketId, binding.kind, binding.id, binding.version, binding.fingerprint ?? null],
  );
}

/**
 * The version a canonical row carries right now. One literal statement per
 * table rather than an interpolated name, so the static SQL guards can read
 * every statement this package issues.
 */
async function versionOf(
  executor: Executor,
  table: 'parties' | 'stock_items' | 'vehicles' | 'legal_entities' | 'rooftops',
  tenantId: string,
  id: string,
): Promise<string> {
  let found;
  switch (table) {
    case 'parties':
      found = await executor.query(
        `SELECT authorization_version FROM parties WHERE tenant_id = $1 AND party_id = $2`,
        [tenantId, id],
      );
      break;
    case 'stock_items':
      found = await executor.query(
        `SELECT authorization_version FROM stock_items WHERE tenant_id = $1 AND stock_item_id = $2`,
        [tenantId, id],
      );
      break;
    case 'vehicles':
      found = await executor.query(
        `SELECT authorization_version FROM vehicles WHERE tenant_id = $1 AND vehicle_id = $2`,
        [tenantId, id],
      );
      break;
    case 'legal_entities':
      found = await executor.query(
        `SELECT authorization_version FROM legal_entities WHERE tenant_id = $1 AND legal_entity_id = $2`,
        [tenantId, id],
      );
      break;
    case 'rooftops':
    default:
      found = await executor.query(
        `SELECT authorization_version FROM rooftops WHERE tenant_id = $1 AND rooftop_id = $2`,
        [tenantId, id],
      );
      break;
  }
  return found.rows.length === 0 ? '0' : String((found.rows[0] as Row).authorization_version);
}

/**
 * Record every canonical row the jacket rests on, with the version it carried
 * at this instant. Idempotent: a converged caller writing the same bindings
 * again lands on `DO NOTHING`.
 */
async function recordBindings(
  executor: Executor,
  tenantId: string,
  jacketId: string,
  fact: ApprovedDeskingVersion,
  legalEntityId: string,
): Promise<void> {
  const c = fact.deskingCase;
  await bind(executor, tenantId, jacketId, {
    kind: 'legal_entity',
    id: legalEntityId,
    version: await versionOf(executor, 'legal_entities', tenantId, legalEntityId),
  });
  await bind(executor, tenantId, jacketId, {
    kind: 'rooftop',
    id: c.rooftopId,
    version: await versionOf(executor, 'rooftops', tenantId, c.rooftopId),
  });
  await bind(executor, tenantId, jacketId, {
    kind: 'party',
    id: c.partyId,
    version: await versionOf(executor, 'parties', tenantId, c.partyId),
  });
  if (c.stockItemId !== null) {
    await bind(executor, tenantId, jacketId, {
      kind: 'stock_item',
      id: c.stockItemId,
      version: await versionOf(executor, 'stock_items', tenantId, c.stockItemId),
    });
    const vehicle = await executor.query(
      `SELECT v.vehicle_id, v.authorization_version FROM stock_items si
         JOIN vehicles v ON v.tenant_id = si.tenant_id AND v.vehicle_id = si.vehicle_id
        WHERE si.tenant_id = $1 AND si.stock_item_id = $2`,
      [tenantId, c.stockItemId],
    );
    if (vehicle.rows.length > 0) {
      const v = vehicle.rows[0] as Row;
      await bind(executor, tenantId, jacketId, {
        kind: 'vehicle',
        id: String(v.vehicle_id),
        version: String(v.authorization_version),
      });
    }
  }
  if (fact.trade !== null) {
    await bind(executor, tenantId, jacketId, {
      kind: 'appraisal_version',
      id: fact.trade.appraisalId,
      version: String(fact.trade.currentVersionNo),
    });
  }
  await bind(executor, tenantId, jacketId, {
    kind: 'desking_scenario',
    id: fact.scenario.scenarioId,
    version: String(fact.scenario.versionNo),
    fingerprint: fact.scenario.outputFingerprint,
  });
  await bind(executor, tenantId, jacketId, {
    kind: 'scenario_approval',
    id: fact.approval.approvalId,
    version: fact.approval.decidedAt,
    fingerprint: fact.approval.reviewedOutputFingerprint,
  });
  for (const rule of fact.ruleApplications) {
    await bind(executor, tenantId, jacketId, {
      kind: 'desking_rule',
      id: rule.ruleId,
      version: String(rule.ruleVersion),
    });
  }
}

/**
 * The checklist, resolved from configuration at the instant the jacket opens.
 * Each item copies the requirement's code, version and source, so the jacket
 * can say what it was measured against even after the requirement moves on.
 */
async function resolveChecklist(
  executor: Executor,
  tenantId: string,
  jacket: JacketView,
  at: string,
): Promise<number> {
  const configuration = await resolveConfigurationWithin(executor, {
    tenantId,
    jurisdiction: jacket.jurisdiction,
    legalEntityId: jacket.legalEntityId,
    rooftopId: jacket.rooftopId,
    transactionType: jacket.transactionType,
    at,
  });
  for (const requirement of configuration.requirements) {
    await executor.query(
      `INSERT INTO jacket_checklist_items
         (tenant_id, jacket_id, requirement_id, requirement_code, requirement_version,
          requirement_source, required, waivable, satisfied_by, template_code, evidence_kind)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (tenant_id, jacket_id, requirement_code) DO NOTHING`,
      [
        tenantId,
        jacket.jacketId,
        requirement.requirementId,
        requirement.requirementCode,
        requirement.version,
        requirement.source,
        requirement.required,
        requirement.waivable,
        requirement.satisfiedBy,
        requirement.templateCode,
        requirement.evidenceKind,
      ],
    );
  }
  return configuration.requirements.length;
}

export async function openJacketWithin(
  executor: Executor,
  input: { actingUserLinkId: string; tenantId: string; deskingCaseId: string; now?: string },
): Promise<OpenJacketOutcome> {
  const actor = await requireActor(executor, input.actingUserLinkId);
  const now = input.now ?? new Date().toISOString();

  await executor.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
    intakeKey(input.tenantId, input.deskingCaseId),
  ]);

  // GUARD ONE — an active jacket may already exist for this file. Answered
  // before the fact is even read, so a replay costs one index lookup.
  const existing = await executor.query(
    `SELECT ${JACKET_COLUMNS} FROM deal_jackets
      WHERE tenant_id = $1 AND desking_case_id = $2 AND state <> 'voided'`,
    [input.tenantId, input.deskingCaseId],
  );
  if (existing.rows.length > 0) {
    const already = mapJacket(existing.rows[0] as Row);
    if (!(await reaches(input.tenantId, actor, already.rooftopId))) return { outcome: 'not_found' };
    return { outcome: 'already_open', jacket: already };
  }

  const fact = await getApprovedDeskingVersionWithin(executor, {
    tenantId: input.tenantId,
    deskingCaseId: input.deskingCaseId,
  });
  if (fact === null) {
    // A file that does not exist, a file at somebody else's rooftop, and a file
    // with nothing approved on it: the first two are one answer. The third is
    // told apart only AFTER the caller is known to work the rooftop.
    const file = await executor.query(
      `SELECT rooftop_id FROM desking_cases WHERE tenant_id = $1 AND desking_case_id = $2`,
      [input.tenantId, input.deskingCaseId],
    );
    if (file.rows.length === 0) return { outcome: 'not_found' };
    const rooftopId = String((file.rows[0] as Row).rooftop_id);
    if (!(await reaches(input.tenantId, actor, rooftopId))) return { outcome: 'not_found' };
    return {
      outcome: 'not_approved',
      error:
        'no version of this deal is approved — the jacket opens from the desk’s decision, not before it',
    };
  }
  if (!(await reaches(input.tenantId, actor, fact.deskingCase.rooftopId))) {
    return { outcome: 'not_found' };
  }

  const entity = await executor.query(
    `SELECT legal_entity_id FROM rooftops WHERE tenant_id = $1 AND rooftop_id = $2`,
    [input.tenantId, fact.deskingCase.rooftopId],
  );
  const legalEntityId = String((entity.rows[0] as Row).legal_entity_id);

  // GUARD TWO — the unique key on (tenant_id, approved_scenario_id) decides it.
  const written = await executor.query(
    `INSERT INTO deal_jackets
       (tenant_id, legal_entity_id, rooftop_id, desking_case_id, opportunity_id, party_id,
        stock_item_id, appraisal_id, appraisal_version_no, approved_scenario_id,
        scenario_version_no, approved_output_fingerprint, approval_id, jurisdiction,
        transaction_type, opened_by_user_link_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     ON CONFLICT (tenant_id, approved_scenario_id) DO NOTHING
     RETURNING ${JACKET_COLUMNS}`,
    [
      input.tenantId,
      legalEntityId,
      fact.deskingCase.rooftopId,
      fact.deskingCase.deskingCaseId,
      fact.deskingCase.opportunityId,
      fact.deskingCase.partyId,
      fact.deskingCase.stockItemId,
      fact.trade === null ? null : fact.trade.appraisalId,
      fact.trade === null ? null : fact.trade.currentVersionNo,
      fact.scenario.scenarioId,
      fact.scenario.versionNo,
      fact.scenario.outputFingerprint,
      fact.approval.approvalId,
      fact.scenario.jurisdiction,
      transactionTypeOf(fact.scenario),
      actor,
    ],
  );

  // GUARD THREE — the raced re-select. An empty RETURNING means the other
  // caller committed first; their jacket is the answer.
  if (written.rows.length === 0) {
    const raced = await executor.query(
      `SELECT ${JACKET_COLUMNS} FROM deal_jackets
        WHERE tenant_id = $1 AND approved_scenario_id = $2`,
      [input.tenantId, fact.scenario.scenarioId],
    );
    return { outcome: 'already_open', jacket: mapJacket(raced.rows[0] as Row) };
  }

  const jacket = mapJacket(written.rows[0] as Row);
  await recordBindings(executor, input.tenantId, jacket.jacketId, fact, legalEntityId);
  const requirements = await resolveChecklist(executor, input.tenantId, jacket, now);

  const mutation = await recordMutation(executor, {
    tenantId: input.tenantId,
    entityType: 'deal_jacket',
    entityId: jacket.jacketId,
    eventType: 'jacket.opened',
    actingUserLinkId: actor,
    authorizationVersion: jacket.authorizationVersion,
    details: {
      desking_case_id: jacket.deskingCaseId,
      approved_scenario_id: jacket.approvedScenarioId,
      scenario_version_no: jacket.scenarioVersionNo,
      approved_output_fingerprint: jacket.approvedOutputFingerprint,
      jurisdiction: jacket.jurisdiction,
      transaction_type: jacket.transactionType,
      requirements_resolved: requirements,
    },
  });
  // IDS ONLY — the dispatcher hydrates what it needs at delivery time.
  await enqueueAdminOutboxEvent(executor, {
    tenantId: input.tenantId,
    eventType: 'jacket.opened',
    payload: {
      jacket_id: jacket.jacketId,
      desking_case_id: jacket.deskingCaseId,
      approved_scenario_id: jacket.approvedScenarioId,
      rooftop_id: jacket.rooftopId,
    },
  });
  return { outcome: 'opened', jacket, mutation };
}

export async function openJacket(input: {
  actingUserLinkId: string;
  tenantId: string;
  deskingCaseId: string;
}): Promise<OpenJacketOutcome> {
  return withTenantTransaction(input.tenantId, async (tx) => openJacketWithin(tx, input));
}

/**
 * One jacket by its id, locked for the caller's transaction, or null when it
 * does not exist or sits at a rooftop this person does not work — the same
 * null, on purpose.
 */
export async function requireJacketWithin(
  executor: Executor,
  tenantId: string,
  actor: string,
  jacketId: string,
): Promise<JacketView | null> {
  const found = await executor.query(
    `SELECT ${JACKET_COLUMNS} FROM deal_jackets WHERE tenant_id = $1 AND jacket_id = $2 FOR UPDATE`,
    [tenantId, jacketId],
  );
  if (found.rows.length === 0) return null;
  const view = mapJacket(found.rows[0] as Row);
  return (await reaches(tenantId, actor, view.rooftopId)) ? view : null;
}

/** The recorded provenance of one jacket, in binding order. */
export interface SourceBinding {
  readonly sourceKind: string;
  readonly sourceId: string;
  readonly sourceVersion: string;
  readonly sourceFingerprint: string | null;
  readonly boundAt: string;
}

export async function sourceBindingsWithin(
  executor: Executor,
  tenantId: string,
  jacketId: string,
): Promise<SourceBinding[]> {
  const found = await executor.query(
    `SELECT source_kind, source_id, source_version, source_fingerprint, bound_at
       FROM jacket_source_bindings WHERE tenant_id = $1 AND jacket_id = $2
      ORDER BY source_kind, source_id`,
    [tenantId, jacketId],
  );
  return found.rows.map((x) => {
    const r = x as Row;
    return {
      sourceKind: String(r.source_kind),
      sourceId: String(r.source_id),
      sourceVersion: String(r.source_version),
      sourceFingerprint: r.source_fingerprint === null ? null : String(r.source_fingerprint),
      boundAt: new Date(String(r.bound_at)).toISOString(),
    };
  });
}
