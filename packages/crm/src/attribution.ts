/**
 * RELEASE TRAIN 3, ROW 5 — ATTRIBUTION, AND THE REVENUE IT WILL NOT INVENT.
 *
 * DETERMINISM IS THE REQUIREMENT. The same window, the same model and the same
 * touches must produce the same credit every time it is run — otherwise
 * "attribution changed" is indistinguishable from "the business changed", and
 * nobody can act on either. Three things make it so:
 *
 *   * the input is the IMMUTABLE touch ledger, ordered by a sequence the
 *     database assigns, never by a timestamp that can tie;
 *   * the weights are BASIS POINTS, integers that sum to exactly 10000 — a
 *     float split three ways does not, and the difference shows up as a penny
 *     that moves between quarters;
 *   * a re-run SUPERSEDES rather than mutates, so a past run stays readable and
 *     two runs can be compared instead of one being lost.
 *
 * AND THE REVENUE IS NOT AVAILABLE. There is no sale in this platform: Release
 * Train 3 stops at the sales handoff and FBL-100 has not been built. So the
 * run carries the shape a revenue consumer will need — a model, a window, a
 * credited touch, a weight — and reports `revenue_status: NOT_YET_AVAILABLE`
 * with no amount beside it. Migration 063 CHECK-constrains that pairing, so the
 * schema refuses a row that claims the status and carries a number anyway.
 *
 * ZERO WOULD BE A LIE. A zero is a measurement — "we attributed nothing" — and
 * what is true here is an absence: nothing has been measured yet. Reporting the
 * absence is the only honest option, and it is the one the order asked for.
 */
import { withTenantTransaction } from '@dealer/database';
import { recordMutation, requireActor, type MutationResult } from '@dealer/identity-access';

interface Row {
  [key: string]: unknown;
}

export type AttributionModel = 'first_touch' | 'last_touch' | 'linear';

export const ATTRIBUTION_MODELS: readonly AttributionModel[] = [
  'first_touch',
  'last_touch',
  'linear',
];

/** The only revenue answer this train can honestly give. */
export const REVENUE_NOT_YET_AVAILABLE = 'NOT_YET_AVAILABLE' as const;

export interface AttributionRunView {
  readonly attributionRunId: string;
  readonly rooftopId: string;
  readonly model: AttributionModel;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly state: 'computed' | 'superseded';
  readonly leadsConsidered: number;
  readonly touchesCredited: number;
  readonly revenueStatus: 'NOT_YET_AVAILABLE' | 'AVAILABLE';
  readonly attributedRevenueCents: number | null;
  readonly authorizationVersion: number;
}

const RUN_COLUMNS = `attribution_run_id, rooftop_id, model, window_start, window_end, state,
       leads_considered, touches_credited, revenue_status, attributed_revenue_cents,
       authorization_version`;

function mapRun(row: Row): AttributionRunView {
  return {
    attributionRunId: String(row.attribution_run_id),
    rooftopId: String(row.rooftop_id),
    model: String(row.model) as AttributionModel,
    windowStart: new Date(row.window_start as string).toISOString(),
    windowEnd: new Date(row.window_end as string).toISOString(),
    state: String(row.state) as 'computed' | 'superseded',
    leadsConsidered: Number(row.leads_considered),
    touchesCredited: Number(row.touches_credited),
    revenueStatus: String(row.revenue_status) as 'NOT_YET_AVAILABLE' | 'AVAILABLE',
    attributedRevenueCents:
      row.attributed_revenue_cents === null ? null : Number(row.attributed_revenue_cents),
    authorizationVersion: Number(row.authorization_version),
  };
}

/**
 * THE SPLIT, AS PURE ARITHMETIC.
 *
 * Exported and separately testable because this is the part that must be
 * provably deterministic. The remainder of a linear split goes to the EARLIEST
 * touches, one basis point each, so 3 touches give 3334/3333/3333 rather than
 * 3333/3333/3333 and a lost point. Any rule would do; having one written down
 * is what matters, because "whatever the float produced" is not a rule.
 */
export function attributionWeights(model: AttributionModel, touchCount: number): number[] {
  if (touchCount <= 0) return [];
  if (model === 'first_touch') {
    return [10000, ...Array<number>(touchCount - 1).fill(0)];
  }
  if (model === 'last_touch') {
    return [...Array<number>(touchCount - 1).fill(0), 10000];
  }
  const base = Math.floor(10000 / touchCount);
  const remainder = 10000 - base * touchCount;
  return Array.from({ length: touchCount }, (_, i) => base + (i < remainder ? 1 : 0));
}

export type AttributionOutcome =
  | { outcome: 'computed'; run: AttributionRunView; mutation: MutationResult }
  | { outcome: 'invalid'; error: string };

/**
 * Computes one run and supersedes any previous run for the same rooftop, model
 * and window. Superseding rather than deleting keeps the comparison possible:
 * "the numbers changed" is a question about two runs, and a platform that keeps
 * only the newest cannot answer it.
 */
export async function computeAttribution(input: {
  actingUserLinkId: string;
  tenantId: string;
  rooftopId: string;
  model: AttributionModel;
  windowStart: string;
  windowEnd: string;
}): Promise<AttributionOutcome> {
  if (!ATTRIBUTION_MODELS.includes(input.model)) {
    return { outcome: 'invalid', error: `unknown attribution model ${input.model}` };
  }
  const start = new Date(input.windowStart);
  const end = new Date(input.windowEnd);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
    return { outcome: 'invalid', error: 'a window ends after it starts' };
  }

  return withTenantTransaction(input.tenantId, async (tx) => {
    const actor = await requireActor(tx, input.actingUserLinkId);

    await tx.query(
      `UPDATE attribution_runs
          SET state = 'superseded', updated_by_user_link_id = $6, updated_at = NOW(),
              authorization_version = authorization_version + 1
        WHERE tenant_id = $1 AND rooftop_id = $2 AND model = $3
          AND window_start = $4 AND window_end = $5 AND state = 'computed'`,
      [input.tenantId, input.rooftopId, input.model, start.toISOString(), end.toISOString(), actor],
    );

    const run = await tx.query(
      `INSERT INTO attribution_runs
         (tenant_id, rooftop_id, model, window_start, window_end,
          computed_by_user_link_id, updated_by_user_link_id)
       VALUES ($1, $2, $3, $4, $5, $6, $6)
       RETURNING ${RUN_COLUMNS}`,
      [input.tenantId, input.rooftopId, input.model, start.toISOString(), end.toISOString(), actor],
    );
    const runId = String((run.rows[0] as Row).attribution_run_id);

    // The leads in scope, and their touches IN SEQUENCE. `touch_seq` is
    // database-assigned, so the ordering cannot be influenced by a caller and
    // cannot tie the way equal timestamps can.
    const leads = await tx.query(
      `SELECT l.lead_id FROM leads l
        WHERE l.tenant_id = $1 AND l.rooftop_id = $2
          AND l.created_at >= $3 AND l.created_at < $4
        ORDER BY l.lead_id`,
      [input.tenantId, input.rooftopId, start.toISOString(), end.toISOString()],
    );

    let credited = 0;
    for (const leadRow of leads.rows as Row[]) {
      const leadId = String(leadRow.lead_id);
      const touches = await tx.query(
        `SELECT touch_id, lead_source_id, campaign_version_id FROM lead_source_touches
          WHERE tenant_id = $1 AND lead_id = $2 ORDER BY touch_seq`,
        [input.tenantId, leadId],
      );
      const rows = touches.rows as Row[];
      const weights = attributionWeights(input.model, rows.length);
      for (let i = 0; i < rows.length; i += 1) {
        const weight = weights[i] ?? 0;
        if (weight === 0) continue;
        const touch = rows[i] as Row;
        await tx.query(
          `INSERT INTO lead_attributions
             (tenant_id, attribution_run_id, lead_id, touch_id, lead_source_id,
              campaign_version_id, weight_bp)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            input.tenantId,
            runId,
            leadId,
            String(touch.touch_id),
            String(touch.lead_source_id),
            touch.campaign_version_id === null ? null : String(touch.campaign_version_id),
            weight,
          ],
        );
        credited += 1;
      }
    }

    const finished = await tx.query(
      `UPDATE attribution_runs
          SET leads_considered = $3, touches_credited = $4, updated_at = NOW()
        WHERE tenant_id = $1 AND attribution_run_id = $2
        RETURNING ${RUN_COLUMNS}`,
      [input.tenantId, runId, leads.rows.length, credited],
    );
    const view = mapRun(finished.rows[0] as Row);
    const mutation = await recordMutation(tx, {
      tenantId: input.tenantId,
      entityType: 'attribution_run',
      entityId: runId,
      eventType: 'crm.attribution.computed',
      actingUserLinkId: actor,
      authorizationVersion: view.authorizationVersion,
      details: {
        model: input.model,
        rooftop_id: input.rooftopId,
        leads_considered: view.leadsConsidered,
        touches_credited: view.touchesCredited,
        revenue_status: view.revenueStatus,
      },
    });
    return { outcome: 'computed' as const, run: view, mutation };
  });
}

export interface SourceCredit {
  readonly leadSourceId: string;
  readonly sourceCode: string;
  readonly displayName: string;
  readonly creditedLeads: number;
  readonly weightBp: number;
}

export interface AttributionReport {
  readonly run: AttributionRunView | null;
  readonly bySource: SourceCredit[];
  /** Always NOT_YET_AVAILABLE in this train, and stated rather than omitted. */
  readonly revenueStatus: 'NOT_YET_AVAILABLE' | 'AVAILABLE';
  readonly roiStatus: 'NOT_YET_AVAILABLE' | 'AVAILABLE';
  readonly revenueNote: string;
}

/**
 * The manager's view of one run. `revenueStatus` and `roiStatus` are part of
 * the RESULT rather than absent from it: a report that simply omits revenue
 * invites the reader to assume the number is zero, and a field that says
 * NOT_YET_AVAILABLE cannot be misread that way.
 */
export async function attributionReport(input: {
  tenantId: string;
  rooftopId: string;
  model: AttributionModel;
}): Promise<AttributionReport> {
  return withTenantTransaction(input.tenantId, async (tx) => {
    const run = await tx.query(
      `SELECT ${RUN_COLUMNS} FROM attribution_runs
        WHERE tenant_id = $1 AND rooftop_id = $2 AND model = $3 AND state = 'computed'
        ORDER BY window_end DESC LIMIT 1`,
      [input.tenantId, input.rooftopId, input.model],
    );
    if (run.rows.length === 0) {
      return {
        run: null,
        bySource: [],
        revenueStatus: REVENUE_NOT_YET_AVAILABLE,
        roiStatus: REVENUE_NOT_YET_AVAILABLE,
        revenueNote: NO_REVENUE_NOTE,
      };
    }
    const view = mapRun(run.rows[0] as Row);
    const bySource = await tx.query(
      `SELECT a.lead_source_id, s.source_code, s.display_name,
              COUNT(DISTINCT a.lead_id)::int AS credited_leads,
              SUM(a.weight_bp)::int AS weight_bp
         FROM lead_attributions a
         JOIN lead_sources s
           ON s.tenant_id = a.tenant_id AND s.lead_source_id = a.lead_source_id
        WHERE a.tenant_id = $1 AND a.attribution_run_id = $2
        GROUP BY a.lead_source_id, s.source_code, s.display_name
        ORDER BY SUM(a.weight_bp) DESC, s.source_code`,
      [input.tenantId, view.attributionRunId],
    );
    return {
      run: view,
      bySource: (bySource.rows as Row[]).map((r) => ({
        leadSourceId: String(r.lead_source_id),
        sourceCode: String(r.source_code),
        displayName: String(r.display_name),
        creditedLeads: Number(r.credited_leads),
        weightBp: Number(r.weight_bp),
      })),
      revenueStatus: view.revenueStatus,
      roiStatus: view.revenueStatus,
      revenueNote: NO_REVENUE_NOTE,
    };
  });
}

const NO_REVENUE_NOTE =
  'Revenue and ROI are NOT_YET_AVAILABLE: this platform records no sale yet, so there is ' +
  'nothing to attribute money to. The contract is in place and the figure will populate ' +
  'when Sales exists. It is reported as unavailable rather than as zero, because zero is a ' +
  'measurement and this is an absence.';
