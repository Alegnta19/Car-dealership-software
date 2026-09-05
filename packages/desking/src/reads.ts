/**
 * WHAT THE DESK AND THE MANAGER READ.
 *
 * ROW 6: "The manager view reconciles appraisal variance, scenario versions,
 * pending approvals, exceptions, and source freshness across permitted rooftops
 * without inventing gross or sale facts."
 *
 * ONE READ, ONE MOMENT. `deskBoard` is a single transaction, exactly as the
 * sales board is, because a screen stitched together from six endpoints shows
 * six different instants and a manager reconciling them is reconciling noise.
 *
 * WHAT THIS PHASE STILL DOES NOT KNOW, and says so rather than computing
 * something that looks like it: gross, revenue, commission, close rate, ROI and
 * the deal record. A desking scenario is a PRICED PROPOSAL a manager approved.
 * No money has moved, no contract exists, and a gross figure derived from an
 * approved pencil is a forecast wearing an accounting record's clothes. Pricing
 * itself is NOT on that list any more — this is the phase that provides it,
 * which is why the board carries figures where Release Train 4's carried a
 * placeholder.
 *
 * DISCOVERY REPLACES TYPED IDENTIFIERS, as it does everywhere else in this
 * repository: `awaitingDesk` is the list a desk picks from, filtered to the
 * rooftops the reader works, so no screen ever asks anybody for a UUID.
 */
import { withTenantTransaction } from '@dealer/database';
import { permittedRooftopIds, requireActor } from '@dealer/identity-access';
import { pendingDeskingHandoffs, type DeskingHandoffFact } from '@dealer/sales';

import { mapCase, reaches, type DeskingCaseView } from './intake';
import { formatCents, toCents } from './money';
import { mapScenario, type ScenarioView } from './scenarios';

interface Row {
  [key: string]: unknown;
}

/**
 * The figures this phase deliberately does not have. Stated once, so a screen
 * cannot quietly stop saying it.
 */
export const NOT_YET_AVAILABLE = {
  gross: 'NOT_YET_AVAILABLE',
  revenue: 'NOT_YET_AVAILABLE',
  commission: 'NOT_YET_AVAILABLE',
  close: 'NOT_YET_AVAILABLE',
  roi: 'NOT_YET_AVAILABLE',
  deal: 'NOT_YET_AVAILABLE',
  sold_inventory: 'NOT_YET_AVAILABLE',
  delivery: 'NOT_YET_AVAILABLE',
} as const;

/** The desking-ready facts this person could still open a file from. */
export async function awaitingDesk(
  tenantId: string,
  actingUserLinkId: string,
): Promise<DeskingHandoffFact[]> {
  const facts = await pendingDeskingHandoffs(tenantId, actingUserLinkId);
  return facts.filter((f) => f.deskingStatus === 'NOT_YET_AVAILABLE');
}

export interface AppraisalSummary {
  readonly appraisalId: string;
  readonly vin: string;
  readonly description: string;
  readonly currentVersionNo: number;
  readonly conditionGrade: string;
  readonly odometerMiles: number;
  readonly quotations: ReadonlyArray<{
    readonly providerCode: string;
    readonly providerKind: string;
    readonly availability: string;
    readonly quotedValueCents: bigint | null;
    readonly unavailableReason: string | null;
    readonly recordedAt: string;
  }>;
}

export interface CaseHeader {
  readonly deskingCase: DeskingCaseView;
  readonly customerName: string;
  readonly vehicleDescription: string | null;
  readonly appraisal: AppraisalSummary | null;
  readonly scenarios: readonly ScenarioView[];
  readonly approvedScenarioId: string | null;
  readonly notYetAvailable: typeof NOT_YET_AVAILABLE;
}

async function appraisalSummary(
  tx: { query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }> },
  tenantId: string,
  deskingCaseId: string,
): Promise<AppraisalSummary | null> {
  const found = await tx.query(
    `SELECT a.appraisal_id, a.vin, a.model_year, a.make, a.model, a.trim_level,
            a.current_version_no, v.condition_grade, v.odometer_miles
       FROM appraisals a
       JOIN appraisal_versions v
         ON v.tenant_id = a.tenant_id AND v.appraisal_id = a.appraisal_id
        AND v.version_no = a.current_version_no
      WHERE a.tenant_id = $1 AND a.desking_case_id = $2`,
    [tenantId, deskingCaseId],
  );
  if (found.rows.length === 0) return null;
  const row = found.rows[0] as Row;
  const quotes = await tx.query(
    `SELECT provider_code, provider_kind, availability, quoted_value_cents, unavailable_reason,
            recorded_at
       FROM appraisal_source_quotations
      WHERE tenant_id = $1 AND appraisal_id = $2
      ORDER BY recorded_at DESC`,
    [tenantId, String(row.appraisal_id)],
  );
  return {
    appraisalId: String(row.appraisal_id),
    vin: String(row.vin),
    description: `${String(row.model_year)} ${String(row.make)} ${String(row.model)}${
      row.trim_level === null ? '' : ` ${String(row.trim_level)}`
    }`,
    currentVersionNo: Number(row.current_version_no),
    conditionGrade: String(row.condition_grade),
    odometerMiles: Number(row.odometer_miles),
    quotations: quotes.rows.map((q) => {
      const r = q as Row;
      return {
        providerCode: String(r.provider_code),
        providerKind: String(r.provider_kind),
        availability: String(r.availability),
        quotedValueCents: r.quoted_value_cents === null ? null : toCents(r.quoted_value_cents),
        unavailableReason: r.unavailable_reason === null ? null : String(r.unavailable_reason),
        recordedAt: new Date(String(r.recorded_at)).toISOString(),
      };
    }),
  };
}

/**
 * The selected car, in the words the platform can actually say.
 *
 * `vehicles.make` and `vehicles.model` are NULLABLE — migration 062 creates a
 * vehicle from a VIN whose tenth character gives the model year and nothing
 * else, and a decoder may never have run. Printing those columns blind puts
 * "2003 null null" on a desk manager's screen, which reads as a rendering
 * fault rather than as a fact about the car. What is known is printed, the
 * stock number identifies the unit when the description cannot, and a case
 * with no car settled on says nothing at all.
 */
function describeStock(row: Row): string | null {
  if (row.stock_number === null || row.stock_number === undefined) return null;
  const parts = [row.stock_year, row.stock_make, row.stock_model]
    .filter((p) => p !== null && p !== undefined && String(p).length > 0)
    .map((p) => String(p));
  const stockNumber = `stock ${String(row.stock_number)}`;
  return parts.length === 0 ? stockNumber : `${parts.join(' ')} (${stockNumber})`;
}

/** Everything one desk file is, in one transaction. */
export async function caseHeader(
  tenantId: string,
  actingUserLinkId: string,
  deskingCaseId: string,
): Promise<CaseHeader | null> {
  return withTenantTransaction(tenantId, async (tx) => {
    const actor = await requireActor(tx, actingUserLinkId);
    const found = await tx.query(
      `SELECT c.desking_case_id, c.rooftop_id, c.opportunity_id, c.party_id, c.stock_item_id,
              c.desking_handoff_id, c.state, c.opened_by_user_link_id, c.approved_at,
              c.authorization_version, c.created_at,
              p.display_name,
              si.stock_number,
              v.model_year AS stock_year, v.make AS stock_make, v.model AS stock_model
         FROM desking_cases c
         JOIN parties p ON p.tenant_id = c.tenant_id AND p.party_id = c.party_id
         LEFT JOIN stock_items si
                ON si.tenant_id = c.tenant_id AND si.stock_item_id = c.stock_item_id
         LEFT JOIN vehicles v
                ON v.tenant_id = si.tenant_id AND v.vehicle_id = si.vehicle_id
        WHERE c.tenant_id = $1 AND c.desking_case_id = $2`,
      [tenantId, deskingCaseId],
    );
    if (found.rows.length === 0) return null;
    const row = found.rows[0] as Row;
    const deskingCase = mapCase(row);
    if (!(await reaches(tenantId, actor, deskingCase.rooftopId))) return null;

    const scenarios = await tx.query(
      `SELECT scenario_id, desking_case_id, rooftop_id, version_no, supersedes_scenario_id, label,
              state, vehicle_price_cents, trade_allowance_cents, trade_payoff_cents,
              cash_down_cents, term_months, apr_ppm, currency, jurisdiction, priced_at,
              trade_equity_cents, taxable_amount_cents, tax_total_cents, fee_total_cents,
              incentive_total_cents, amount_financed_cents, monthly_payment_cents,
              input_fingerprint, output_fingerprint, expires_at, authorization_version
         FROM desking_scenarios
        WHERE tenant_id = $1 AND desking_case_id = $2
        ORDER BY version_no DESC`,
      [tenantId, deskingCaseId],
    );
    const versions = scenarios.rows.map((s) => mapScenario(s as Row));
    return {
      deskingCase,
      customerName: String(row.display_name),
      vehicleDescription: describeStock(row),
      appraisal: await appraisalSummary(tx, tenantId, deskingCaseId),
      scenarios: versions,
      approvedScenarioId: versions.find((v) => v.state === 'approved')?.scenarioId ?? null,
      notYetAvailable: NOT_YET_AVAILABLE,
    };
  });
}

export interface ScenarioDetail {
  readonly scenario: ScenarioView;
  readonly lines: ReadonlyArray<{
    readonly sequenceNo: number;
    readonly kind: string;
    readonly lineCode: string;
    readonly label: string;
    readonly amountCents: bigint;
    readonly amount: string;
    readonly ruleId: string | null;
    readonly ruleVersion: number | null;
  }>;
  readonly rules: ReadonlyArray<{
    readonly ruleId: string;
    readonly ruleKind: string;
    readonly ruleCode: string;
    readonly ruleVersion: number;
    readonly source: string;
    readonly jurisdiction: string;
    readonly rooftopScoped: boolean;
    readonly effectiveFrom: string;
    readonly effectiveTo: string | null;
    readonly resolvedAmountCents: bigint;
  }>;
  readonly decision: {
    readonly approvalId: string;
    readonly decision: string;
    readonly decidedAt: string;
    readonly decidedByUserLinkId: string;
    readonly reviewedOutputFingerprint: string;
    readonly overrideReason: string | null;
    readonly limitReason: string | null;
  } | null;
  readonly history: ReadonlyArray<{
    readonly fromState: string;
    readonly toState: string;
    readonly reason: string | null;
    readonly occurredAt: string;
  }>;
}

export async function scenarioDetail(
  tenantId: string,
  actingUserLinkId: string,
  scenarioId: string,
): Promise<ScenarioDetail | null> {
  return withTenantTransaction(tenantId, async (tx) => {
    const actor = await requireActor(tx, actingUserLinkId);
    const found = await tx.query(
      `SELECT scenario_id, desking_case_id, rooftop_id, version_no, supersedes_scenario_id, label,
              state, vehicle_price_cents, trade_allowance_cents, trade_payoff_cents,
              cash_down_cents, term_months, apr_ppm, currency, jurisdiction, priced_at,
              trade_equity_cents, taxable_amount_cents, tax_total_cents, fee_total_cents,
              incentive_total_cents, amount_financed_cents, monthly_payment_cents,
              input_fingerprint, output_fingerprint, expires_at, authorization_version
         FROM desking_scenarios WHERE tenant_id = $1 AND scenario_id = $2`,
      [tenantId, scenarioId],
    );
    if (found.rows.length === 0) return null;
    const scenario = mapScenario(found.rows[0] as Row);
    if (!(await reaches(tenantId, actor, scenario.rooftopId))) return null;

    const lines = await tx.query(
      `SELECT sequence_no, kind, code, label, amount_cents, rule_id, rule_version
         FROM scenario_line_items WHERE tenant_id = $1 AND scenario_id = $2
        ORDER BY sequence_no`,
      [tenantId, scenarioId],
    );
    const rules = await tx.query(
      `SELECT rule_id, rule_kind, rule_code, rule_version, source, jurisdiction, rooftop_scoped,
              effective_from, effective_to, resolved_amount_cents
         FROM scenario_rule_applications WHERE tenant_id = $1 AND scenario_id = $2
        ORDER BY rule_kind, rule_code`,
      [tenantId, scenarioId],
    );
    const decision = await tx.query(
      `SELECT approval_id, decision, decided_at, decided_by_user_link_id,
              reviewed_output_fingerprint, override_reason, limit_reason
         FROM scenario_approvals WHERE tenant_id = $1 AND scenario_id = $2`,
      [tenantId, scenarioId],
    );
    const history = await tx.query(
      `SELECT from_state, to_state, reason, occurred_at
         FROM scenario_state_events WHERE tenant_id = $1 AND scenario_id = $2
        ORDER BY occurred_at`,
      [tenantId, scenarioId],
    );

    return {
      scenario,
      lines: lines.rows.map((l) => {
        const r = l as Row;
        const amountCents = toCents(r.amount_cents);
        return {
          sequenceNo: Number(r.sequence_no),
          kind: String(r.kind),
          lineCode: String(r.code),
          label: String(r.label),
          amountCents,
          amount: formatCents(amountCents),
          ruleId: r.rule_id === null ? null : String(r.rule_id),
          ruleVersion: r.rule_version === null ? null : Number(r.rule_version),
        };
      }),
      rules: rules.rows.map((x) => {
        const r = x as Row;
        return {
          ruleId: String(r.rule_id),
          ruleKind: String(r.rule_kind),
          ruleCode: String(r.rule_code),
          ruleVersion: Number(r.rule_version),
          source: String(r.source),
          jurisdiction: String(r.jurisdiction),
          rooftopScoped: r.rooftop_scoped === true,
          effectiveFrom: new Date(String(r.effective_from)).toISOString(),
          effectiveTo:
            r.effective_to === null ? null : new Date(String(r.effective_to)).toISOString(),
          resolvedAmountCents: toCents(r.resolved_amount_cents),
        };
      }),
      decision:
        decision.rows.length === 0
          ? null
          : (() => {
              const r = decision.rows[0] as Row;
              return {
                approvalId: String(r.approval_id),
                decision: String(r.decision),
                decidedAt: new Date(String(r.decided_at)).toISOString(),
                decidedByUserLinkId: String(r.decided_by_user_link_id),
                reviewedOutputFingerprint: String(r.reviewed_output_fingerprint),
                overrideReason: r.override_reason === null ? null : String(r.override_reason),
                limitReason: r.limit_reason === null ? null : String(r.limit_reason),
              };
            })(),
      history: history.rows.map((h) => {
        const r = h as Row;
        return {
          fromState: String(r.from_state),
          toState: String(r.to_state),
          reason: r.reason === null ? null : String(r.reason),
          occurredAt: new Date(String(r.occurred_at)).toISOString(),
        };
      }),
    };
  });
}

export interface BoardRow {
  readonly deskingCaseId: string;
  readonly rooftopId: string;
  readonly customerName: string;
  readonly state: string;
  readonly versions: number;
  readonly latestVersionNo: number | null;
  readonly latestState: string | null;
  readonly pendingApproval: boolean;
  readonly approvedVersionNo: number | null;
  readonly amountFinancedCents: bigint | null;
  readonly monthlyPaymentCents: bigint | null;
  /** Trade allowance priced, less the best quotation held. Null when either is absent. */
  readonly appraisalVarianceCents: bigint | null;
  readonly oldestSourceAt: string | null;
  readonly exceptions: readonly string[];
}

export interface DeskBoard {
  readonly rooftopIds: readonly string[];
  readonly rows: readonly BoardRow[];
  readonly openCases: number;
  readonly awaitingApproval: number;
  readonly approvedCases: number;
  readonly notYetAvailable: typeof NOT_YET_AVAILABLE;
}

/**
 * THE MANAGER'S BOARD — one read, one instant, across exactly the rooftops this
 * person works.
 *
 * EXCEPTIONS ARE THINGS SOMEBODY MUST DO, not decorations: a file with no
 * appraisal, a file with no version, a version waiting on a decision, a version
 * whose expiry has passed while it waited, a trade priced with no outside
 * quotation behind it, and a quotation the provider could not give.
 */
export async function deskBoard(tenantId: string, actingUserLinkId: string): Promise<DeskBoard> {
  return withTenantTransaction(tenantId, async (tx) => {
    const actor = await requireActor(tx, actingUserLinkId);
    const rooftopIds = await permittedRooftopIds(tenantId, actor);
    if (rooftopIds.length === 0) {
      return {
        rooftopIds: [],
        rows: [],
        openCases: 0,
        awaitingApproval: 0,
        approvedCases: 0,
        notYetAvailable: NOT_YET_AVAILABLE,
      };
    }

    const found = await tx.query(
      `WITH latest AS (
         SELECT DISTINCT ON (desking_case_id)
                desking_case_id, version_no, state, amount_financed_cents, monthly_payment_cents,
                trade_allowance_cents, expires_at
           FROM desking_scenarios
          WHERE tenant_id = $1
          ORDER BY desking_case_id, version_no DESC
       ),
       approved AS (
         SELECT desking_case_id, version_no FROM desking_scenarios
          WHERE tenant_id = $1 AND state = 'approved'
       ),
       counted AS (
         SELECT desking_case_id, COUNT(*)::int AS versions FROM desking_scenarios
          WHERE tenant_id = $1 GROUP BY desking_case_id
       ),
       best_quote AS (
         SELECT a.desking_case_id, MAX(q.quoted_value_cents) AS best_cents,
                MIN(q.recorded_at) AS oldest_source_at,
                bool_or(q.availability = 'NOT_YET_AVAILABLE') AS any_unavailable,
                COUNT(*)::int AS quotations
           FROM appraisals a
           JOIN appraisal_source_quotations q
             ON q.tenant_id = a.tenant_id AND q.appraisal_id = a.appraisal_id
          WHERE a.tenant_id = $1
          GROUP BY a.desking_case_id
       )
       SELECT c.desking_case_id, c.rooftop_id, c.state, p.display_name,
              l.version_no AS latest_version_no, l.state AS latest_state,
              l.amount_financed_cents, l.monthly_payment_cents, l.trade_allowance_cents,
              l.expires_at,
              ap.version_no AS approved_version_no,
              COALESCE(ct.versions, 0) AS versions,
              (a.appraisal_id IS NOT NULL) AS has_appraisal,
              bq.best_cents, bq.oldest_source_at, bq.any_unavailable,
              COALESCE(bq.quotations, 0) AS quotations
         FROM desking_cases c
         JOIN parties p ON p.tenant_id = c.tenant_id AND p.party_id = c.party_id
         LEFT JOIN latest l ON l.desking_case_id = c.desking_case_id
         LEFT JOIN approved ap ON ap.desking_case_id = c.desking_case_id
         LEFT JOIN counted ct ON ct.desking_case_id = c.desking_case_id
         LEFT JOIN appraisals a
                ON a.tenant_id = c.tenant_id AND a.desking_case_id = c.desking_case_id
         LEFT JOIN best_quote bq ON bq.desking_case_id = c.desking_case_id
        WHERE c.tenant_id = $1 AND c.rooftop_id = ANY($2::uuid[])
        ORDER BY c.created_at DESC
        LIMIT 500`,
      [tenantId, rooftopIds],
    );

    const now = new Date().toISOString();
    const rows: BoardRow[] = found.rows.map((x) => {
      const r = x as Row;
      const latestState = r.latest_state === null ? null : String(r.latest_state);
      const allowance = r.trade_allowance_cents === null ? null : toCents(r.trade_allowance_cents);
      const best = r.best_cents === null ? null : toCents(r.best_cents);
      const expiresAt = r.expires_at === null ? null : new Date(String(r.expires_at)).toISOString();
      const exceptions: string[] = [];
      if (r.has_appraisal !== true) exceptions.push('no appraisal recorded');
      if (latestState === null) exceptions.push('no scenario built');
      if (latestState === 'submitted') exceptions.push('waiting on a decision');
      if (latestState === 'submitted' && expiresAt !== null && expiresAt <= now) {
        exceptions.push('expired while it waited');
      }
      if (allowance !== null && allowance > 0n && Number(r.quotations) === 0) {
        exceptions.push('trade priced with no outside quotation');
      }
      if (r.any_unavailable === true) exceptions.push('a valuation source had nothing to give');
      return {
        deskingCaseId: String(r.desking_case_id),
        rooftopId: String(r.rooftop_id),
        customerName: String(r.display_name),
        state: String(r.state),
        versions: Number(r.versions),
        latestVersionNo: r.latest_version_no === null ? null : Number(r.latest_version_no),
        latestState,
        pendingApproval: latestState === 'submitted',
        approvedVersionNo: r.approved_version_no === null ? null : Number(r.approved_version_no),
        amountFinancedCents:
          r.amount_financed_cents === null ? null : toCents(r.amount_financed_cents),
        monthlyPaymentCents:
          r.monthly_payment_cents === null ? null : toCents(r.monthly_payment_cents),
        appraisalVarianceCents: allowance === null || best === null ? null : allowance - best,
        oldestSourceAt:
          r.oldest_source_at === null ? null : new Date(String(r.oldest_source_at)).toISOString(),
        exceptions,
      };
    });

    return {
      rooftopIds,
      rows,
      openCases: rows.filter((r) => r.state === 'open').length,
      awaitingApproval: rows.filter((r) => r.pendingApproval).length,
      approvedCases: rows.filter((r) => r.state === 'approved').length,
      notYetAvailable: NOT_YET_AVAILABLE,
    };
  });
}
