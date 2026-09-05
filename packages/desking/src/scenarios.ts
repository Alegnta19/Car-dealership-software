/**
 * ROWS 3, 5 AND 6 — DETERMINISTIC SCENARIOS, APPROVAL AND FREEZE, LIFECYCLE.
 *
 * A SCENARIO IS BUILT, NEVER EDITED. `buildScenario` resolves the rule book at
 * one instant, hands the inputs and that book to the pure calculator, and
 * writes the answer with the rules it was computed under beside it. Revising a
 * deal builds the NEXT version carrying `supersedes_scenario_id`; migration
 * 065's trigger refuses an edit to any figure on any version, so "versioned"
 * is a property of the database rather than a discipline of this file.
 *
 * THE REPLAY ANSWER COMES BEFORE THE VERSION CHECK, exactly as it does in the
 * sales train, and for the same reason: holding a stale version is the
 * CONSEQUENCE of a first call having succeeded, so answering `already_decided`
 * to the retry is the honest outcome and refusing it as a conflict is not.
 *
 * APPROVAL BINDS THE EXACT VERSION REVIEWED. The caller passes back the
 * `output_fingerprint` they were looking at; the database trigger compares it
 * with the row's own and refuses the decision when they differ. A manager who
 * approves a screen that has since been rebuilt gets a refusal naming both
 * digests rather than an approval of figures nobody read.
 *
 * ONE CURRENT APPROVED VERSION PER OPPORTUNITY is a partial unique index, so
 * approving a successor supersedes its predecessor IN THE SAME TRANSACTION —
 * and supersession changes the predecessor's STATE and nothing else. Its
 * figures, its fingerprints and its own decision row are exactly as they were,
 * which is what "without changing approved history" means.
 */
import { withTenantTransaction, type Executor } from '@dealer/database';
import {
  EFFECTIVE_ROLE_BINDING_SQL,
  recordMutation,
  requireActor,
  type MutationResult,
} from '@dealer/identity-access';
import { ROLES } from '@dealer/contracts';

import { computeScenario, type ComputedScenario, type ScenarioInputs } from './calculator';
import { requireCaseWithin } from './intake';
import { toCents } from './money';
import { resolveRuleBookWithin } from './rules';

interface Row {
  [key: string]: unknown;
}

export type ScenarioState =
  'draft' | 'submitted' | 'approved' | 'rejected' | 'expired' | 'superseded';

export const TERMINAL_SCENARIO_STATES: readonly ScenarioState[] = [
  'rejected',
  'expired',
  'superseded',
];

export interface ScenarioView {
  readonly scenarioId: string;
  readonly deskingCaseId: string;
  readonly rooftopId: string;
  readonly versionNo: number;
  readonly supersedesScenarioId: string | null;
  readonly label: string;
  readonly state: ScenarioState;
  readonly vehiclePriceCents: bigint;
  readonly tradeAllowanceCents: bigint;
  readonly tradePayoffCents: bigint;
  readonly cashDownCents: bigint;
  readonly termMonths: number | null;
  readonly aprPpm: bigint | null;
  readonly currency: string;
  readonly jurisdiction: string;
  readonly pricedAt: string;
  readonly tradeEquityCents: bigint;
  readonly taxableAmountCents: bigint;
  readonly taxTotalCents: bigint;
  readonly feeTotalCents: bigint;
  readonly incentiveTotalCents: bigint;
  readonly amountFinancedCents: bigint;
  readonly monthlyPaymentCents: bigint | null;
  readonly inputFingerprint: string;
  readonly outputFingerprint: string;
  readonly expiresAt: string | null;
  readonly authorizationVersion: number;
}

const SCENARIO_COLUMNS = `scenario_id, desking_case_id, rooftop_id, version_no,
  supersedes_scenario_id, label, state, vehicle_price_cents, trade_allowance_cents,
  trade_payoff_cents, cash_down_cents, term_months, apr_ppm, currency, jurisdiction, priced_at,
  trade_equity_cents, taxable_amount_cents, tax_total_cents, fee_total_cents,
  incentive_total_cents, amount_financed_cents, monthly_payment_cents, input_fingerprint,
  output_fingerprint, expires_at, authorization_version`;

export function mapScenario(row: Row): ScenarioView {
  return {
    scenarioId: String(row.scenario_id),
    deskingCaseId: String(row.desking_case_id),
    rooftopId: String(row.rooftop_id),
    versionNo: Number(row.version_no),
    supersedesScenarioId:
      row.supersedes_scenario_id === null ? null : String(row.supersedes_scenario_id),
    label: String(row.label),
    state: String(row.state) as ScenarioState,
    vehiclePriceCents: toCents(row.vehicle_price_cents),
    tradeAllowanceCents: toCents(row.trade_allowance_cents),
    tradePayoffCents: toCents(row.trade_payoff_cents),
    cashDownCents: toCents(row.cash_down_cents),
    termMonths: row.term_months === null ? null : Number(row.term_months),
    aprPpm: row.apr_ppm === null ? null : toCents(row.apr_ppm),
    currency: String(row.currency),
    jurisdiction: String(row.jurisdiction),
    pricedAt: new Date(String(row.priced_at)).toISOString(),
    tradeEquityCents: toCents(row.trade_equity_cents),
    taxableAmountCents: toCents(row.taxable_amount_cents),
    taxTotalCents: toCents(row.tax_total_cents),
    feeTotalCents: toCents(row.fee_total_cents),
    incentiveTotalCents: toCents(row.incentive_total_cents),
    amountFinancedCents: toCents(row.amount_financed_cents),
    monthlyPaymentCents:
      row.monthly_payment_cents === null ? null : toCents(row.monthly_payment_cents),
    inputFingerprint: String(row.input_fingerprint),
    outputFingerprint: String(row.output_fingerprint),
    expiresAt: row.expires_at === null ? null : new Date(String(row.expires_at)).toISOString(),
    authorizationVersion: Number(row.authorization_version),
  };
}

export type BuildOutcome =
  | {
      outcome: 'built';
      scenario: ScenarioView;
      computed: ComputedScenario;
      mutation: MutationResult;
    }
  | { outcome: 'not_found' }
  | { outcome: 'rules_unavailable'; missing: readonly string[]; expired: readonly string[] }
  | { outcome: 'invalid'; error: string };

export interface BuildScenarioInput {
  actingUserLinkId: string;
  tenantId: string;
  deskingCaseId: string;
  label: string;
  jurisdiction: string;
  vehiclePriceCents: bigint;
  tradeAllowanceCents?: bigint;
  tradePayoffCents?: bigint;
  cashDownCents?: bigint;
  termMonths?: number | null;
  aprPpm?: bigint | null;
  /** The instant the rule book is read at; defaults to now, and is recorded. */
  pricedAt?: string;
  expiresAt?: string | null;
  supersedesScenarioId?: string | null;
}

async function stateEvent(
  executor: Executor,
  input: {
    tenantId: string;
    scenarioId: string;
    fromState: string;
    toState: string;
    reason: string | null;
    actor: string;
  },
): Promise<void> {
  await executor.query(
    `INSERT INTO scenario_state_events
       (tenant_id, scenario_id, from_state, to_state, reason, changed_by_user_link_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [input.tenantId, input.scenarioId, input.fromState, input.toState, input.reason, input.actor],
  );
}

export async function buildScenarioWithin(
  executor: Executor,
  input: BuildScenarioInput,
): Promise<BuildOutcome> {
  const actor = await requireActor(executor, input.actingUserLinkId);
  const deskingCase = await requireCaseWithin(executor, input.tenantId, actor, input.deskingCaseId);
  if (deskingCase === null) return { outcome: 'not_found' };

  if (input.vehiclePriceCents < 0n) {
    return { outcome: 'invalid', error: 'a vehicle price is not negative' };
  }
  const termMonths = input.termMonths ?? null;
  const aprPpm = input.aprPpm ?? null;
  if ((termMonths === null) !== (aprPpm === null)) {
    return {
      outcome: 'invalid',
      error: 'a monthly figure needs both a term and a rate, or neither',
    };
  }
  if (termMonths !== null && (termMonths < 1 || termMonths > 120)) {
    return { outcome: 'invalid', error: 'a term is between 1 and 120 months' };
  }

  const pricedAt = input.pricedAt ?? new Date().toISOString();
  const book = await resolveRuleBookWithin(executor, {
    tenantId: input.tenantId,
    jurisdiction: input.jurisdiction,
    rooftopId: deskingCase.rooftopId,
    at: pricedAt,
  });
  // MISSING AND EXPIRED BOTH REFUSE. Pricing a deal at zero tax because nobody
  // configured the jurisdiction is a figure invented by an absence.
  if (book.missing.length > 0 || book.expired.length > 0) {
    return { outcome: 'rules_unavailable', missing: book.missing, expired: book.expired };
  }

  const inputs: ScenarioInputs = {
    vehiclePriceCents: input.vehiclePriceCents,
    tradeAllowanceCents: input.tradeAllowanceCents ?? 0n,
    tradePayoffCents: input.tradePayoffCents ?? 0n,
    cashDownCents: input.cashDownCents ?? 0n,
    termMonths,
    aprPpm,
    currency: 'USD',
    jurisdiction: input.jurisdiction,
    pricedAt,
  };
  const computed = computeScenario(inputs, book.rules);

  const next = await executor.query(
    `SELECT COALESCE(MAX(version_no), 0) + 1 AS next FROM desking_scenarios
      WHERE tenant_id = $1 AND desking_case_id = $2`,
    [input.tenantId, input.deskingCaseId],
  );
  const versionNo = Number((next.rows[0] as Row).next);

  const written = await executor.query(
    `INSERT INTO desking_scenarios
       (tenant_id, rooftop_id, desking_case_id, version_no, supersedes_scenario_id, label,
        vehicle_price_cents, trade_allowance_cents, trade_payoff_cents, cash_down_cents,
        term_months, apr_ppm, currency, jurisdiction, priced_at,
        trade_equity_cents, taxable_amount_cents, tax_total_cents, fee_total_cents,
        incentive_total_cents, amount_financed_cents, monthly_payment_cents,
        input_fingerprint, output_fingerprint, expires_at, built_by_user_link_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::timestamptz,
             $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26)
     RETURNING ${SCENARIO_COLUMNS}`,
    [
      input.tenantId,
      deskingCase.rooftopId,
      input.deskingCaseId,
      versionNo,
      input.supersedesScenarioId ?? null,
      input.label,
      inputs.vehiclePriceCents.toString(),
      inputs.tradeAllowanceCents.toString(),
      inputs.tradePayoffCents.toString(),
      inputs.cashDownCents.toString(),
      termMonths,
      aprPpm === null ? null : aprPpm.toString(),
      inputs.currency,
      inputs.jurisdiction,
      pricedAt,
      computed.tradeEquityCents.toString(),
      computed.taxableAmountCents.toString(),
      computed.taxTotalCents.toString(),
      computed.feeTotalCents.toString(),
      computed.incentiveTotalCents.toString(),
      computed.amountFinancedCents.toString(),
      computed.monthlyPaymentCents === null ? null : computed.monthlyPaymentCents.toString(),
      computed.inputFingerprint,
      computed.outputFingerprint,
      input.expiresAt ?? null,
      actor,
    ],
  );
  const scenario = mapScenario(written.rows[0] as Row);

  for (const line of computed.lines) {
    await executor.query(
      `INSERT INTO scenario_line_items
         (tenant_id, scenario_id, sequence_no, kind, code, label, amount_cents, rule_id,
          rule_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        input.tenantId,
        scenario.scenarioId,
        line.sequenceNo,
        line.kind,
        line.lineCode,
        line.label,
        line.amountCents.toString(),
        line.ruleId,
        line.ruleVersion,
      ],
    );
  }
  for (const application of computed.applications) {
    await executor.query(
      `INSERT INTO scenario_rule_applications
         (tenant_id, scenario_id, rule_id, rule_kind, rule_code, rule_version, source,
          jurisdiction, rooftop_scoped, effective_from, effective_to, resolved_amount_cents)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        input.tenantId,
        scenario.scenarioId,
        application.ruleId,
        application.ruleKind,
        application.ruleCode,
        application.ruleVersion,
        application.source,
        application.jurisdiction,
        application.rooftopScoped,
        application.effectiveFrom,
        application.effectiveTo,
        application.resolvedAmountCents.toString(),
      ],
    );
  }
  await stateEvent(executor, {
    tenantId: input.tenantId,
    scenarioId: scenario.scenarioId,
    fromState: 'none',
    toState: 'draft',
    reason: input.supersedesScenarioId == null ? null : 'revision',
    actor,
  });

  const mutation = await recordMutation(executor, {
    tenantId: input.tenantId,
    entityType: 'desking_scenario',
    entityId: scenario.scenarioId,
    eventType: 'desking.scenario.built',
    actingUserLinkId: actor,
    authorizationVersion: scenario.authorizationVersion,
    details: {
      desking_case_id: scenario.deskingCaseId,
      version_no: scenario.versionNo,
      input_fingerprint: scenario.inputFingerprint,
      output_fingerprint: scenario.outputFingerprint,
      rules_applied: computed.applications.length,
    },
  });
  return { outcome: 'built', scenario, computed, mutation };
}

export async function buildScenario(input: BuildScenarioInput): Promise<BuildOutcome> {
  return withTenantTransaction(input.tenantId, async (tx) => buildScenarioWithin(tx, input));
}

export type MoveOutcome =
  | { outcome: 'moved'; scenario: ScenarioView; mutation: MutationResult }
  | { outcome: 'already_there'; scenario: ScenarioView }
  | { outcome: 'not_found' }
  | { outcome: 'version_conflict'; currentVersion: number }
  | { outcome: 'invalid'; error: string };

async function loadScenarioForUpdate(
  executor: Executor,
  tenantId: string,
  actor: string,
  scenarioId: string,
): Promise<ScenarioView | null> {
  const found = await executor.query(
    `SELECT ${SCENARIO_COLUMNS} FROM desking_scenarios
      WHERE tenant_id = $1 AND scenario_id = $2 FOR UPDATE`,
    [tenantId, scenarioId],
  );
  if (found.rows.length === 0) return null;
  const scenario = mapScenario(found.rows[0] as Row);
  const deskingCase = await requireCaseWithin(executor, tenantId, actor, scenario.deskingCaseId);
  return deskingCase === null ? null : scenario;
}

/** Draft → submitted: the desk is asking a manager to look. */
export async function submitScenario(input: {
  actingUserLinkId: string;
  tenantId: string;
  scenarioId: string;
  expectedVersion: number;
}): Promise<MoveOutcome> {
  return withTenantTransaction(input.tenantId, async (tx) => {
    const actor = await requireActor(tx, input.actingUserLinkId);
    const scenario = await loadScenarioForUpdate(tx, input.tenantId, actor, input.scenarioId);
    if (scenario === null) return { outcome: 'not_found' };
    if (scenario.state === 'submitted') return { outcome: 'already_there', scenario };
    if (scenario.state !== 'draft') {
      return {
        outcome: 'invalid',
        error: `a ${scenario.state} version is not waiting to be submitted`,
      };
    }
    if (scenario.authorizationVersion !== input.expectedVersion) {
      return { outcome: 'version_conflict', currentVersion: scenario.authorizationVersion };
    }
    const moved = await tx.query(
      `UPDATE desking_scenarios
          SET state = 'submitted', updated_at = NOW(),
              authorization_version = authorization_version + 1
        WHERE tenant_id = $1 AND scenario_id = $2 AND authorization_version = $3
        RETURNING ${SCENARIO_COLUMNS}`,
      [input.tenantId, input.scenarioId, input.expectedVersion],
    );
    if (moved.rows.length === 0) {
      return { outcome: 'version_conflict', currentVersion: scenario.authorizationVersion };
    }
    const after = mapScenario(moved.rows[0] as Row);
    await stateEvent(tx, {
      tenantId: input.tenantId,
      scenarioId: after.scenarioId,
      fromState: 'draft',
      toState: 'submitted',
      reason: null,
      actor,
    });
    const mutation = await recordMutation(tx, {
      tenantId: input.tenantId,
      entityType: 'desking_scenario',
      entityId: after.scenarioId,
      eventType: 'desking.scenario.submitted',
      actingUserLinkId: actor,
      authorizationVersion: after.authorizationVersion,
      details: { version_no: after.versionNo },
    });
    return { outcome: 'moved', scenario: after, mutation };
  });
}

/** Is this person a manager at the rooftop that owns the case? */
async function isEligibleManager(
  executor: Executor,
  tenantId: string,
  userLinkId: string,
  rooftopId: string,
): Promise<boolean> {
  const found = await executor.query(
    `SELECT 1
       FROM rooftops r
       JOIN role_bindings rb
         ON rb.tenant_id = r.tenant_id
        AND ${EFFECTIVE_ROLE_BINDING_SQL}
      WHERE r.tenant_id = $1
        AND r.rooftop_id = $2
        AND r.status = 'active'
        AND rb.user_link_id = $3
        AND rb.role = ANY($4::text[])
        AND (
          rb.scope_level = 'tenant'
          OR (rb.scope_level = 'rooftop' AND rb.scope_id = r.rooftop_id)
          OR EXISTS (
            SELECT 1 FROM org_ancestry_all($1, 'rooftop', r.rooftop_id) chain
             WHERE chain.level = rb.scope_level AND chain.node_id = rb.scope_id
          )
        )
      LIMIT 1`,
    [tenantId, rooftopId, userLinkId, [ROLES.SALES_MANAGER, 'tenant_admin']],
  );
  return found.rows.length > 0;
}

export type DecisionOutcome =
  | { outcome: 'decided'; scenario: ScenarioView; approvalId: string; mutation: MutationResult }
  | { outcome: 'already_decided'; scenario: ScenarioView; approvalId: string }
  | { outcome: 'not_found' }
  | { outcome: 'stale_view'; currentFingerprint: string }
  | { outcome: 'version_conflict'; currentVersion: number }
  | { outcome: 'invalid'; error: string };

/**
 * THE DECISION. A manager approves or rejects ONE version, naming the figures
 * they were looking at.
 */
export async function decideScenario(input: {
  actingUserLinkId: string;
  tenantId: string;
  scenarioId: string;
  decision: 'approved' | 'rejected';
  reviewedOutputFingerprint: string;
  expectedVersion: number;
  overrideReason?: string | null;
  limitReason?: string | null;
  now?: string;
}): Promise<DecisionOutcome> {
  return withTenantTransaction(input.tenantId, async (tx) => {
    const actor = await requireActor(tx, input.actingUserLinkId);
    const scenario = await loadScenarioForUpdate(tx, input.tenantId, actor, input.scenarioId);
    if (scenario === null) return { outcome: 'not_found' };

    // THE REPLAY ANSWER, before the version check.
    const decided = await tx.query(
      `SELECT approval_id, decision FROM scenario_approvals
        WHERE tenant_id = $1 AND scenario_id = $2`,
      [input.tenantId, input.scenarioId],
    );
    if (decided.rows.length > 0) {
      const row = decided.rows[0] as Row;
      if (String(row.decision) === input.decision) {
        return {
          outcome: 'already_decided',
          scenario,
          approvalId: String(row.approval_id),
        };
      }
      return {
        outcome: 'invalid',
        error: `version ${scenario.versionNo} was already ${String(row.decision)}, and a decision is made once`,
      };
    }

    if (scenario.state !== 'submitted') {
      return {
        outcome: 'invalid',
        error: `a ${scenario.state} version is not in front of a manager`,
      };
    }
    if (!(await isEligibleManager(tx, input.tenantId, actor, scenario.rooftopId))) {
      // Not an explanation of what they lack — the same answer a scenario they
      // cannot see would give.
      return { outcome: 'not_found' };
    }
    const now = input.now ?? new Date().toISOString();
    if (scenario.expiresAt !== null && scenario.expiresAt <= now) {
      return {
        outcome: 'invalid',
        error: 'that version expired before it was decided — rebuild it at today’s rule book',
      };
    }
    if (scenario.outputFingerprint !== input.reviewedOutputFingerprint) {
      return { outcome: 'stale_view', currentFingerprint: scenario.outputFingerprint };
    }
    if (scenario.authorizationVersion !== input.expectedVersion) {
      return { outcome: 'version_conflict', currentVersion: scenario.authorizationVersion };
    }
    if (input.decision === 'rejected' && (input.limitReason ?? '').trim().length === 0) {
      return { outcome: 'invalid', error: 'a rejection says what it was rejected against' };
    }

    // THE PREDECESSOR IS SUPERSEDED, NOT REWRITTEN. Its figures, fingerprints
    // and decision row are untouched; only its state moves, and the state
    // event records who moved it and why.
    if (input.decision === 'approved') {
      const standing = await tx.query(
        `SELECT scenario_id FROM desking_scenarios
          WHERE tenant_id = $1 AND desking_case_id = $2 AND state = 'approved'
          FOR UPDATE`,
        [input.tenantId, scenario.deskingCaseId],
      );
      for (const row of standing.rows) {
        const previousId = String((row as Row).scenario_id);
        await tx.query(
          `UPDATE desking_scenarios
              SET state = 'superseded', updated_at = NOW(),
                  authorization_version = authorization_version + 1
            WHERE tenant_id = $1 AND scenario_id = $2`,
          [input.tenantId, previousId],
        );
        await stateEvent(tx, {
          tenantId: input.tenantId,
          scenarioId: previousId,
          fromState: 'approved',
          toState: 'superseded',
          reason: `superseded by version ${scenario.versionNo}`,
          actor,
        });
      }
    }

    const approval = await tx.query(
      `INSERT INTO scenario_approvals
         (tenant_id, desking_case_id, scenario_id, scenario_version_no, decision,
          reviewed_output_fingerprint, decided_by_user_link_id, override_reason, limit_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING approval_id`,
      [
        input.tenantId,
        scenario.deskingCaseId,
        scenario.scenarioId,
        scenario.versionNo,
        input.decision,
        input.reviewedOutputFingerprint,
        actor,
        input.overrideReason ?? null,
        input.limitReason ?? null,
      ],
    );
    const approvalId = String((approval.rows[0] as Row).approval_id);

    const moved = await tx.query(
      `UPDATE desking_scenarios
          SET state = $3, updated_at = NOW(),
              authorization_version = authorization_version + 1
        WHERE tenant_id = $1 AND scenario_id = $2 AND authorization_version = $4
        RETURNING ${SCENARIO_COLUMNS}`,
      [input.tenantId, input.scenarioId, input.decision, input.expectedVersion],
    );
    if (moved.rows.length === 0) {
      return { outcome: 'version_conflict', currentVersion: scenario.authorizationVersion };
    }
    const after = mapScenario(moved.rows[0] as Row);
    await stateEvent(tx, {
      tenantId: input.tenantId,
      scenarioId: after.scenarioId,
      fromState: 'submitted',
      toState: input.decision,
      reason: input.limitReason ?? input.overrideReason ?? null,
      actor,
    });

    if (input.decision === 'approved') {
      await tx.query(
        `UPDATE desking_cases
            SET state = 'approved', approved_at = NOW(), updated_at = NOW(),
                authorization_version = authorization_version + 1
          WHERE tenant_id = $1 AND desking_case_id = $2`,
        [input.tenantId, after.deskingCaseId],
      );
    }

    const mutation = await recordMutation(tx, {
      tenantId: input.tenantId,
      entityType: 'desking_scenario',
      entityId: after.scenarioId,
      eventType: `desking.scenario.${input.decision}`,
      actingUserLinkId: actor,
      authorizationVersion: after.authorizationVersion,
      details: {
        version_no: after.versionNo,
        approval_id: approvalId,
        reviewed_output_fingerprint: input.reviewedOutputFingerprint,
      },
    });
    return { outcome: 'decided', scenario: after, approvalId, mutation };
  });
}

/** Draft or submitted → expired. A quote nobody acted on stops being a quote. */
export async function expireScenario(input: {
  actingUserLinkId: string;
  tenantId: string;
  scenarioId: string;
  expectedVersion: number;
  reason?: string | null;
}): Promise<MoveOutcome> {
  return withTenantTransaction(input.tenantId, async (tx) => {
    const actor = await requireActor(tx, input.actingUserLinkId);
    const scenario = await loadScenarioForUpdate(tx, input.tenantId, actor, input.scenarioId);
    if (scenario === null) return { outcome: 'not_found' };
    if (scenario.state === 'expired') return { outcome: 'already_there', scenario };
    if (scenario.state !== 'draft' && scenario.state !== 'submitted') {
      return { outcome: 'invalid', error: `a ${scenario.state} version cannot expire` };
    }
    if (scenario.authorizationVersion !== input.expectedVersion) {
      return { outcome: 'version_conflict', currentVersion: scenario.authorizationVersion };
    }
    const moved = await tx.query(
      `UPDATE desking_scenarios
          SET state = 'expired', updated_at = NOW(),
              authorization_version = authorization_version + 1
        WHERE tenant_id = $1 AND scenario_id = $2 AND authorization_version = $3
        RETURNING ${SCENARIO_COLUMNS}`,
      [input.tenantId, input.scenarioId, input.expectedVersion],
    );
    if (moved.rows.length === 0) {
      return { outcome: 'version_conflict', currentVersion: scenario.authorizationVersion };
    }
    const after = mapScenario(moved.rows[0] as Row);
    await stateEvent(tx, {
      tenantId: input.tenantId,
      scenarioId: after.scenarioId,
      fromState: scenario.state,
      toState: 'expired',
      reason: input.reason ?? null,
      actor,
    });
    const mutation = await recordMutation(tx, {
      tenantId: input.tenantId,
      entityType: 'desking_scenario',
      entityId: after.scenarioId,
      eventType: 'desking.scenario.expired',
      actingUserLinkId: actor,
      authorizationVersion: after.authorizationVersion,
      details: { version_no: after.versionNo, reason: input.reason ?? null },
    });
    return { outcome: 'moved', scenario: after, mutation };
  });
}
