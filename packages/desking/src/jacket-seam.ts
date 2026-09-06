/**
 * THE ONE SEAM FBL-140 REACHES THROUGH, AND NOTHING ELSE.
 *
 * FBL-120 ends by freezing exactly one manager-approved priced version of a deal.
 * FBL-140 has to READ that fact to open a deal jacket, and it has to be able to
 * ask, later, whether the version it bound is still the one the desk stands
 * behind. This module is that pair of reads, and it is deliberately the whole
 * of the desking package's public surface to the jacket: documents and
 * signatures never touch a scenario, an appraisal or a rule, and nothing here
 * lets them write one.
 *
 * WHY IT IS HERE RATHER THAN A QUERY IN THE OTHER PACKAGE. `desking_scenarios`,
 * `scenario_approvals`, `appraisals` and `scenario_rule_applications` are
 * migration 065's tables and this package owns them. A reader in the jacket
 * package would be a second place that knows their column names, and the first
 * time one changed the two would disagree — the same argument this package made
 * when it consumed Release Train 4's fact through `@dealer/sales` rather than by
 * selecting from `desking_handoffs`.
 *
 * WHAT THE FACT CARRIES. Everything the jacket's Outcome 1 binds: the desk
 * file, the approved version with every figure in integer cents, the decision
 * that froze it, the trade and its CURRENT evidence version, and the exact
 * `(rule id, version)` list the version was priced under — copied at
 * application time by FBL-120, so a rule superseded tomorrow cannot change what
 * the jacket was assembled from.
 */
import type { Executor } from '@dealer/database';

import { CASE_COLUMNS, mapCase, type DeskingCaseView } from './intake';
import { toCents } from './money';
import { mapScenario, type ScenarioView } from './scenarios';

interface Row {
  [key: string]: unknown;
}

export interface ApprovalFact {
  readonly approvalId: string;
  readonly scenarioVersionNo: number;
  readonly reviewedOutputFingerprint: string;
  readonly decidedByUserLinkId: string;
  readonly decidedAt: string;
}

export interface TradeFact {
  readonly appraisalId: string;
  readonly currentVersionNo: number;
  readonly vin: string;
  readonly modelYear: number;
  readonly make: string;
  readonly model: string;
  readonly trimLevel: string | null;
  readonly odometerMiles: number;
  readonly odometerStatus: string;
  readonly conditionGrade: string;
  readonly ownership: string;
  readonly authorizationVersion: number;
}

export interface RuleApplicationFact {
  readonly ruleId: string;
  readonly ruleKind: string;
  readonly ruleCode: string;
  readonly ruleVersion: number;
  readonly source: string;
  readonly jurisdiction: string;
  readonly resolvedAmountCents: bigint;
}

/** The fact FBL-120 hands on: one approved version and everything it rests on. */
export interface ApprovedDeskingVersion {
  readonly deskingCase: DeskingCaseView;
  readonly scenario: ScenarioView;
  readonly approval: ApprovalFact;
  readonly trade: TradeFact | null;
  readonly ruleApplications: readonly RuleApplicationFact[];
}

const SCENARIO_COLUMNS = `scenario_id, desking_case_id, rooftop_id, version_no,
  supersedes_scenario_id, label, state, vehicle_price_cents, trade_allowance_cents,
  trade_payoff_cents, cash_down_cents, term_months, apr_ppm, currency, jurisdiction, priced_at,
  trade_equity_cents, taxable_amount_cents, tax_total_cents, fee_total_cents,
  incentive_total_cents, amount_financed_cents, monthly_payment_cents, input_fingerprint,
  output_fingerprint, expires_at, authorization_version`;

/**
 * The approved version of one desk file, locked for the caller's transaction,
 * or null when the file does not exist or nothing on it is approved. The two
 * are the same answer on purpose: the caller decides what to disclose.
 *
 * `FOR UPDATE` on the scenario row, because the caller is about to bind to it
 * and a manager approving a successor at the same instant is exactly the race
 * the jacket's Outcome 1 names.
 */
export async function getApprovedDeskingVersionWithin(
  executor: Executor,
  input: { tenantId: string; deskingCaseId: string },
): Promise<ApprovedDeskingVersion | null> {
  const caseRow = await executor.query(
    `SELECT ${CASE_COLUMNS} FROM desking_cases WHERE tenant_id = $1 AND desking_case_id = $2`,
    [input.tenantId, input.deskingCaseId],
  );
  if (caseRow.rows.length === 0) return null;
  const deskingCase = mapCase(caseRow.rows[0] as Row);

  const approved = await executor.query(
    `SELECT ${SCENARIO_COLUMNS} FROM desking_scenarios
      WHERE tenant_id = $1 AND desking_case_id = $2 AND state = 'approved'
      FOR UPDATE`,
    [input.tenantId, input.deskingCaseId],
  );
  if (approved.rows.length === 0) return null;
  const scenario = mapScenario(approved.rows[0] as Row);

  const decision = await executor.query(
    `SELECT approval_id, scenario_version_no, reviewed_output_fingerprint,
            decided_by_user_link_id, decided_at
       FROM scenario_approvals
      WHERE tenant_id = $1 AND scenario_id = $2 AND decision = 'approved'`,
    [input.tenantId, scenario.scenarioId],
  );
  if (decision.rows.length === 0) return null;
  const d = decision.rows[0] as Row;
  const approval: ApprovalFact = {
    approvalId: String(d.approval_id),
    scenarioVersionNo: Number(d.scenario_version_no),
    reviewedOutputFingerprint: String(d.reviewed_output_fingerprint),
    decidedByUserLinkId: String(d.decided_by_user_link_id),
    decidedAt: new Date(String(d.decided_at)).toISOString(),
  };

  const tradeRow = await executor.query(
    `SELECT a.appraisal_id, a.current_version_no, a.vin, a.model_year, a.make, a.model,
            a.trim_level, a.authorization_version,
            v.odometer_miles, v.odometer_status, v.condition_grade, v.ownership
       FROM appraisals a
       JOIN appraisal_versions v
         ON v.tenant_id = a.tenant_id AND v.appraisal_id = a.appraisal_id
        AND v.version_no = a.current_version_no
      WHERE a.tenant_id = $1 AND a.desking_case_id = $2`,
    [input.tenantId, input.deskingCaseId],
  );
  let trade: TradeFact | null = null;
  if (tradeRow.rows.length > 0) {
    const t = tradeRow.rows[0] as Row;
    trade = {
      appraisalId: String(t.appraisal_id),
      currentVersionNo: Number(t.current_version_no),
      vin: String(t.vin),
      modelYear: Number(t.model_year),
      make: String(t.make),
      model: String(t.model),
      trimLevel: t.trim_level === null ? null : String(t.trim_level),
      odometerMiles: Number(t.odometer_miles),
      odometerStatus: String(t.odometer_status),
      conditionGrade: String(t.condition_grade),
      ownership: String(t.ownership),
      authorizationVersion: Number(t.authorization_version),
    };
  }

  const applied = await executor.query(
    `SELECT rule_id, rule_kind, rule_code, rule_version, source, jurisdiction, resolved_amount_cents
       FROM scenario_rule_applications
      WHERE tenant_id = $1 AND scenario_id = $2
      ORDER BY rule_kind, rule_code`,
    [input.tenantId, scenario.scenarioId],
  );
  const ruleApplications: RuleApplicationFact[] = applied.rows.map((x) => {
    const r = x as Row;
    return {
      ruleId: String(r.rule_id),
      ruleKind: String(r.rule_kind),
      ruleCode: String(r.rule_code),
      ruleVersion: Number(r.rule_version),
      source: String(r.source),
      jurisdiction: String(r.jurisdiction),
      resolvedAmountCents: toCents(r.resolved_amount_cents),
    };
  });

  return { deskingCase, scenario, approval, trade, ruleApplications };
}

/**
 * Which version, if any, the desk CURRENTLY stands behind for a file — the
 * question the jacket asks to decide whether what it bound has gone stale.
 * A read, not a lock: the board asks it for every row.
 */
export async function currentApprovedFingerprintWithin(
  executor: Executor,
  input: { tenantId: string; deskingCaseId: string },
): Promise<{ scenarioId: string; versionNo: number; outputFingerprint: string } | null> {
  const found = await executor.query(
    `SELECT scenario_id, version_no, output_fingerprint FROM desking_scenarios
      WHERE tenant_id = $1 AND desking_case_id = $2 AND state = 'approved'`,
    [input.tenantId, input.deskingCaseId],
  );
  if (found.rows.length === 0) return null;
  const r = found.rows[0] as Row;
  return {
    scenarioId: String(r.scenario_id),
    versionNo: Number(r.version_no),
    outputFingerprint: String(r.output_fingerprint),
  };
}

/** A desk file the jacket may be opened from, in the words the console shows. */
export interface ApprovedCaseSummary {
  readonly deskingCaseId: string;
  readonly rooftopId: string;
  readonly partyId: string;
  readonly customerName: string;
  readonly approvedScenarioId: string;
  readonly versionNo: number;
  readonly approvedAt: string;
  readonly amountFinancedCents: bigint;
  readonly monthlyPaymentCents: bigint | null;
  readonly currency: string;
}

/**
 * Every desk file with an approved version at the given rooftops, newest
 * decision first. The jacket's discovery list — the caller drops the ones that
 * already have a jacket, because that is the jacket's fact and not the desk's.
 */
export async function approvedDeskingCasesWithin(
  executor: Executor,
  input: { tenantId: string; rooftopIds: readonly string[] },
): Promise<ApprovedCaseSummary[]> {
  if (input.rooftopIds.length === 0) return [];
  const found = await executor.query(
    `SELECT c.desking_case_id, c.rooftop_id, c.party_id, p.display_name,
            s.scenario_id, s.version_no, s.amount_financed_cents, s.monthly_payment_cents,
            s.currency, a.decided_at
       FROM desking_cases c
       JOIN parties p ON p.tenant_id = c.tenant_id AND p.party_id = c.party_id
       JOIN desking_scenarios s
         ON s.tenant_id = c.tenant_id AND s.desking_case_id = c.desking_case_id
        AND s.state = 'approved'
       JOIN scenario_approvals a
         ON a.tenant_id = s.tenant_id AND a.scenario_id = s.scenario_id AND a.decision = 'approved'
      WHERE c.tenant_id = $1 AND c.rooftop_id = ANY($2::uuid[])
      ORDER BY a.decided_at DESC
      LIMIT 200`,
    [input.tenantId, input.rooftopIds],
  );
  return found.rows.map((x) => {
    const r = x as Row;
    return {
      deskingCaseId: String(r.desking_case_id),
      rooftopId: String(r.rooftop_id),
      partyId: String(r.party_id),
      customerName: String(r.display_name),
      approvedScenarioId: String(r.scenario_id),
      versionNo: Number(r.version_no),
      approvedAt: new Date(String(r.decided_at)).toISOString(),
      amountFinancedCents: toCents(r.amount_financed_cents),
      monthlyPaymentCents:
        r.monthly_payment_cents === null ? null : toCents(r.monthly_payment_cents),
      currency: String(r.currency),
    };
  });
}
