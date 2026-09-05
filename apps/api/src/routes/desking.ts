/**
 * FBL-120 — THE DESKING SURFACE (/api/desking).
 *
 * The conventions the earlier trains established, because they are the ones
 * this repository's gates and reviewers expect: `authenticate` + `requireAction`,
 * problem+json errors, `Idempotency-Key` on creating commands with the outcome
 * recorded in the same transaction as the effect, and `expected_version`
 * optimistic concurrency.
 *
 * EVERY CHILD IS ADDRESSED THROUGH ITS AUTHORIZED PARENT. A route whose action
 * declares `resourceType: 'desking_case'` carries `:deskingCaseId`, one that
 * declares `appraisal` carries `:appraisalId`, and one that declares
 * `desking_scenario` carries `:scenarioId` — so a row belonging to a different
 * parent is NOT FOUND rather than acted on.
 *
 * MONEY CROSSES THIS BOUNDARY AS A STRING OF MINOR UNITS. `bigint` has no JSON
 * form and `number` loses cents above nine quadrillion, so every amount is sent
 * and received as a decimal string of CENTS: "4550000" is $45,500.00. The one
 * place that parses it is `centsField`, and the one place that writes it is
 * `serialise` — a screen that sees a float never got it from here.
 *
 * NOTHING HERE ASKS ANYBODY TO TYPE AN IDENTIFIER. `/find/handoffs` is the list
 * the console opens a file from, and every other id comes from a record the
 * caller already has on screen.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import {
  addAppraisalAttachment,
  awaitingDesk,
  buildScenarioWithin,
  caseHeader,
  decideScenario,
  deskBoard,
  expireScenario,
  listRules,
  openDeskingCaseWithin,
  recordAppraisalWithin,
  recordRuleWithin,
  recordSourceQuotation,
  reviseAppraisal,
  scenarioDetail,
  submitScenario,
  type AppraisalEvidence,
  type ProviderKind,
  type QuotationAvailability,
} from '@dealer/desking';
import { requestFingerprint, runIdempotentAdminCommand } from '@dealer/identity-access';
import type { Executor } from '@dealer/database';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnprocessableError,
  ValidationError,
} from '@dealer/platform';
import {
  authenticate,
  rejectTenantOverride,
  requireAction,
  requireContext,
} from '../middleware/auth';

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INTEGER_RE = /^-?\d{1,18}$/;

interface Body {
  [key: string]: unknown;
}

function handler(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      rejectTenantOverride(req);
    } catch (err) {
      next(err);
      return;
    }
    fn(req, res).catch(next);
  };
}

function tenantOf(req: Request): string {
  const ctx = requireContext(req);
  if (ctx.tenantId === null || ctx.tenantId === undefined) {
    throw new ForbiddenError('The desking surface is tenant-scoped', { code: 'tenant_required' });
  }
  return ctx.tenantId;
}

function actorOf(req: Request): string {
  return requireContext(req).userId;
}

function body(req: Request): Body {
  return (req.body ?? {}) as Body;
}

function requireUuidParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string' || !UUID_RE.test(value))
    throw new NotFoundError('Resource not found');
  return value;
}

function requireUuidField(b: Body, name: string): string {
  const value = b[name];
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new ValidationError(`${name} must name a record you selected`, {
      code: 'selection_required',
    });
  }
  return value;
}

function optionalUuidField(b: Body, name: string): string | null {
  const value = b[name];
  if (value === undefined || value === null || value === '') return null;
  return requireUuidField(b, name);
}

/** Cents arrive as an integer string, and nothing else is accepted. */
function centsField(b: Body, name: string, required: boolean): bigint | null {
  const value = b[name];
  if (value === undefined || value === null || value === '') {
    if (required) {
      throw new ValidationError(`${name} is required, in whole cents`, { code: 'amount_required' });
    }
    return null;
  }
  const text = typeof value === 'number' ? String(value) : String(value);
  if (!INTEGER_RE.test(text)) {
    throw new ValidationError(`${name} is a whole number of cents, written as a string`, {
      code: 'amount_invalid',
    });
  }
  return BigInt(text);
}

function intField(b: Body, name: string): number | null {
  const value = b[name];
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n)) {
    throw new ValidationError(`${name} is a whole number`, { code: 'invalid_request' });
  }
  return n;
}

function stringField(b: Body, name: string, required: boolean): string | null {
  const value = b[name];
  if (typeof value === 'string' && value.trim().length > 0) return value;
  if (required) {
    throw new ValidationError(`${name} is required`, { code: 'invalid_request' });
  }
  return null;
}

function expectedVersionOf(req: Request): number {
  const raw = body(req).expected_version;
  if (!Number.isInteger(Number(raw))) {
    throw new ValidationError('expected_version is required', {
      code: 'expected_version_required',
    });
  }
  return Number(raw);
}

function idempotencyKeyOf(req: Request): string | null {
  const raw = req.header('idempotency-key');
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed.length < 1 || trimmed.length > 128) {
    throw new ValidationError('Idempotency-Key must be 1-128 characters', {
      code: 'idempotency_key_invalid',
    });
  }
  return trimmed;
}

/**
 * Every bigint becomes a decimal string; everything else passes through.
 *
 * IT RUNS INSIDE THE IDEMPOTENT WORK, not after it. The idempotency layer
 * PERSISTS the body it is handed so a replay can return the same answer, and
 * JSON has no bigint — so a figure that reached that layer unconverted would
 * fail the first call rather than the replay, which is the confusing half of
 * the two ways to get this wrong.
 */
function serialise(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(serialise);
  if (value !== null && typeof value === 'object') {
    if (value instanceof Date) return value.toISOString();
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = serialise(v);
    return out;
  }
  return value;
}

function send(res: Response, status: number, payload: Record<string, unknown>): void {
  res.status(status).json(serialise(payload) as Record<string, unknown>);
}

async function idempotent(
  req: Request,
  res: Response,
  work: (tx: Executor) => Promise<{ status: number; body: unknown }>,
): Promise<void> {
  const outcome = await runIdempotentAdminCommand({
    tenantId: tenantOf(req),
    actorUserLinkId: actorOf(req),
    idempotencyKey: idempotencyKeyOf(req),
    fingerprint: requestFingerprint(
      req.method,
      req.originalUrl.split('?')[0] ?? req.path,
      req.body,
    ),
    work,
  });
  if (outcome.conflict === true) {
    throw new UnprocessableError('This Idempotency-Key was already used for a different request', {
      code: 'idempotency_key_conflict',
    });
  }
  if (outcome.replayed) res.setHeader('Idempotency-Replayed', 'true');
  res.status(outcome.status).json(serialise(outcome.body) as Record<string, unknown>);
}

/** A service's refusal, turned into the problem the caller should see. */
function refuse(outcome: { outcome: string } & Record<string, unknown>): never {
  switch (outcome.outcome) {
    case 'not_found':
      throw new NotFoundError('Resource not found');
    case 'version_conflict':
      throw new ConflictError('This record changed since you loaded it — reload and retry', {
        code: 'version_conflict',
        details: { current_version: outcome.currentVersion as number },
      });
    case 'stale_view':
      // The manager was looking at figures this version no longer carries.
      // The refusal names the digest they must re-read, and nothing else.
      throw new ConflictError(
        'These figures were rebuilt since you opened them — reload and decide again',
        {
          code: 'stale_view',
          details: { current_fingerprint: outcome.currentFingerprint as string },
        },
      );
    case 'rules_unavailable':
      throw new UnprocessableError('the rule book cannot price this deal at that rooftop yet', {
        code: 'rules_unavailable',
        details: {
          missing: outcome.missing as string[],
          expired: outcome.expired as string[],
        },
      });
    case 'overlaps':
      throw new ConflictError(String(outcome.error), { code: 'rule_overlap' });
    case 'invalid':
      throw new UnprocessableError(String(outcome.error), { code: 'invalid_request' });
    default:
      throw new UnprocessableError('the command was refused', { code: 'refused' });
  }
}

function evidenceOf(b: Body): AppraisalEvidence {
  const damageRaw = Array.isArray(b.damage) ? (b.damage as Body[]) : [];
  const equipmentRaw = Array.isArray(b.equipment) ? (b.equipment as Body[]) : [];
  const observationsRaw = Array.isArray(b.observations) ? (b.observations as unknown[]) : [];
  return {
    ownership: String(stringField(b, 'ownership', true)) as AppraisalEvidence['ownership'],
    relationship: String(stringField(b, 'relationship', true)) as AppraisalEvidence['relationship'],
    odometerMiles: intField(b, 'odometer_miles') ?? -1,
    odometerStatus: String(
      stringField(b, 'odometer_status', true),
    ) as AppraisalEvidence['odometerStatus'],
    conditionGrade: String(
      stringField(b, 'condition_grade', true),
    ) as AppraisalEvidence['conditionGrade'],
    provenance: String(stringField(b, 'provenance', true)) as AppraisalEvidence['provenance'],
    inspectionNotes: stringField(b, 'inspection_notes', false),
    changeReason: stringField(b, 'change_reason', false),
    damage: damageRaw.map((d) => ({
      area: String(d.area ?? ''),
      severity: String(d.severity ?? 'light') as 'light' | 'moderate' | 'severe',
      note: typeof d.note === 'string' ? d.note : null,
      estimatedRepairCents: centsField(d, 'estimated_repair_cents', false),
    })),
    equipment: equipmentRaw.map((e) => ({
      code: String(e.code ?? ''),
      label: String(e.label ?? ''),
      present: e.present === true,
    })),
    observations: observationsRaw.filter((o): o is string => typeof o === 'string'),
  };
}

// ── discovery and reading ───────────────────────────────────────────────────

router.get(
  '/find/handoffs',
  authenticate,
  requireAction('desking.discovery.read'),
  handler(async (req, res) => {
    send(res, 200, { handoffs: await awaitingDesk(tenantOf(req), actorOf(req)) });
  }),
);

router.get(
  '/board',
  authenticate,
  requireAction('desking.case.view'),
  handler(async (req, res) => {
    send(res, 200, { board: await deskBoard(tenantOf(req), actorOf(req)) });
  }),
);

router.get(
  '/cases/:deskingCaseId',
  authenticate,
  requireAction('desking.case.read'),
  handler(async (req, res) => {
    const header = await caseHeader(
      tenantOf(req),
      actorOf(req),
      requireUuidParam(req, 'deskingCaseId'),
    );
    if (header === null) throw new NotFoundError('Resource not found');
    send(res, 200, { case: header });
  }),
);

router.get(
  '/scenarios/:scenarioId',
  authenticate,
  requireAction('desking.scenario.read'),
  handler(async (req, res) => {
    const detail = await scenarioDetail(
      tenantOf(req),
      actorOf(req),
      requireUuidParam(req, 'scenarioId'),
    );
    if (detail === null) throw new NotFoundError('Resource not found');
    send(res, 200, { scenario: detail });
  }),
);

router.get(
  '/rules',
  authenticate,
  requireAction('desking.rules.read'),
  handler(async (req, res) => {
    const q = req.query as Record<string, unknown>;
    send(res, 200, {
      rules: await listRules(tenantOf(req), actorOf(req), {
        jurisdiction: typeof q.jurisdiction === 'string' ? q.jurisdiction : undefined,
        rooftopId:
          typeof q.location_id === 'string' && UUID_RE.test(q.location_id)
            ? q.location_id
            : undefined,
      }),
    });
  }),
);

// ── the file ────────────────────────────────────────────────────────────────

router.post(
  '/cases',
  authenticate,
  requireAction('desking.case.open'),
  handler(async (req, res) => {
    const deskingHandoffId = requireUuidField(body(req), 'desking_handoff_id');
    await idempotent(req, res, async (tx) => {
      const opened = await openDeskingCaseWithin(tx, {
        actingUserLinkId: actorOf(req),
        tenantId: tenantOf(req),
        deskingHandoffId,
      });
      if (opened.outcome === 'not_found') throw new NotFoundError('Resource not found');
      if (opened.outcome === 'already_open') {
        return {
          status: 200,
          body: serialise({ case: opened.deskingCase, outcome: 'already_open' }),
        };
      }
      return { status: 201, body: serialise({ case: opened.deskingCase }) };
    });
  }),
);

// ── the trade ───────────────────────────────────────────────────────────────

router.post(
  '/cases/:deskingCaseId/appraisal',
  authenticate,
  requireAction('desking.appraisal.record'),
  handler(async (req, res) => {
    const deskingCaseId = requireUuidParam(req, 'deskingCaseId');
    const b = body(req);
    const vin = String(stringField(b, 'vin', true));
    const modelYear = intField(b, 'model_year');
    if (modelYear === null)
      throw new ValidationError('model_year is required', { code: 'invalid_request' });
    const make = String(stringField(b, 'make', true));
    const model = String(stringField(b, 'model', true));
    const trimLevel = stringField(b, 'trim_level', false);
    const evidence = evidenceOf(b);
    await idempotent(req, res, async (tx) => {
      const recorded = await recordAppraisalWithin(tx, {
        actingUserLinkId: actorOf(req),
        tenantId: tenantOf(req),
        deskingCaseId,
        vin,
        modelYear,
        make,
        model,
        trimLevel,
        evidence,
      });
      if (recorded.outcome === 'already_recorded') {
        return {
          status: 200,
          body: serialise({ appraisal: recorded.appraisal, outcome: 'already_recorded' }),
        };
      }
      if (recorded.outcome !== 'recorded') refuse(recorded);
      return {
        status: 201,
        body: serialise({ appraisal: recorded.appraisal, version_no: recorded.versionNo }),
      };
    });
  }),
);

router.post(
  '/appraisals/:appraisalId/versions',
  authenticate,
  requireAction('desking.appraisal.revise'),
  handler(async (req, res) => {
    const revised = await reviseAppraisal({
      actingUserLinkId: actorOf(req),
      tenantId: tenantOf(req),
      appraisalId: requireUuidParam(req, 'appraisalId'),
      expectedVersion: expectedVersionOf(req),
      evidence: evidenceOf(body(req)),
    });
    if (revised.outcome !== 'recorded') refuse(revised);
    send(res, 201, { appraisal: revised.appraisal, version_no: revised.versionNo });
  }),
);

router.post(
  '/appraisals/:appraisalId/quotations',
  authenticate,
  requireAction('desking.appraisal.revise'),
  handler(async (req, res) => {
    const b = body(req);
    const recorded = await recordSourceQuotation({
      actingUserLinkId: actorOf(req),
      tenantId: tenantOf(req),
      appraisalId: requireUuidParam(req, 'appraisalId'),
      providerCode: String(stringField(b, 'provider_code', true)),
      providerKind: String(stringField(b, 'provider_kind', true)) as ProviderKind,
      availability: String(stringField(b, 'availability', true)) as QuotationAvailability,
      quotedValueCents: centsField(b, 'quoted_value_cents', false),
      currency: stringField(b, 'currency', false),
      reference: stringField(b, 'reference', false),
      unavailableReason: stringField(b, 'unavailable_reason', false),
    });
    if (recorded.outcome !== 'recorded') refuse(recorded);
    send(res, 201, { quotation_id: recorded.quotationId });
  }),
);

router.post(
  '/appraisals/:appraisalId/attachments',
  authenticate,
  requireAction('desking.appraisal.revise'),
  handler(async (req, res) => {
    const b = body(req);
    const added = await addAppraisalAttachment({
      actingUserLinkId: actorOf(req),
      tenantId: tenantOf(req),
      appraisalId: requireUuidParam(req, 'appraisalId'),
      kind: String(stringField(b, 'kind', true)) as 'photo' | 'document' | 'report',
      label: String(stringField(b, 'label', true)),
      uri: String(stringField(b, 'uri', true)),
      contentSha256: stringField(b, 'content_sha256', false),
    });
    if (added.outcome !== 'recorded') refuse(added);
    send(res, 201, { attachment_id: added.attachmentId });
  }),
);

// ── the figures ─────────────────────────────────────────────────────────────

router.post(
  '/cases/:deskingCaseId/scenarios',
  authenticate,
  requireAction('desking.scenario.build'),
  handler(async (req, res) => {
    const deskingCaseId = requireUuidParam(req, 'deskingCaseId');
    const b = body(req);
    const label = String(stringField(b, 'label', true));
    const jurisdiction = String(stringField(b, 'jurisdiction', true));
    const vehiclePriceCents = centsField(b, 'vehicle_price_cents', true) ?? 0n;
    const tradeAllowanceCents = centsField(b, 'trade_allowance_cents', false) ?? 0n;
    const tradePayoffCents = centsField(b, 'trade_payoff_cents', false) ?? 0n;
    const cashDownCents = centsField(b, 'cash_down_cents', false) ?? 0n;
    const termMonths = intField(b, 'term_months');
    const aprPpm = centsField(b, 'apr_ppm', false);
    const supersedesScenarioId = optionalUuidField(b, 'supersedes_scenario_id');
    const expiresAt = stringField(b, 'expires_at', false);
    await idempotent(req, res, async (tx) => {
      const built = await buildScenarioWithin(tx, {
        actingUserLinkId: actorOf(req),
        tenantId: tenantOf(req),
        deskingCaseId,
        label,
        jurisdiction,
        vehiclePriceCents,
        tradeAllowanceCents,
        tradePayoffCents,
        cashDownCents,
        termMonths,
        aprPpm,
        supersedesScenarioId,
        expiresAt,
      });
      if (built.outcome !== 'built') refuse(built);
      return {
        status: 201,
        body: serialise({
          scenario: built.scenario,
          lines: built.computed.lines,
          rules_applied: built.computed.applications.length,
        }),
      };
    });
  }),
);

router.post(
  '/scenarios/:scenarioId/submission',
  authenticate,
  requireAction('desking.scenario.submit'),
  handler(async (req, res) => {
    const moved = await submitScenario({
      actingUserLinkId: actorOf(req),
      tenantId: tenantOf(req),
      scenarioId: requireUuidParam(req, 'scenarioId'),
      expectedVersion: expectedVersionOf(req),
    });
    if (moved.outcome === 'already_there') {
      send(res, 200, { scenario: moved.scenario, outcome: 'already_there' });
      return;
    }
    if (moved.outcome !== 'moved') refuse(moved);
    send(res, 200, { scenario: moved.scenario });
  }),
);

/**
 * THE DECISION.
 *
 * `reviewed_output_fingerprint` is what makes this a decision about the figures
 * on the manager's screen rather than about whatever the row happens to hold at
 * commit time. The service compares it, the database trigger compares it again,
 * and a screen that has gone stale is refused with the digest it must re-read.
 */
router.post(
  '/scenarios/:scenarioId/decision',
  authenticate,
  requireAction('desking.scenario.decide'),
  handler(async (req, res) => {
    const b = body(req);
    const decision = String(stringField(b, 'decision', true));
    if (decision !== 'approved' && decision !== 'rejected') {
      throw new ValidationError('a decision is approved or rejected', { code: 'invalid_request' });
    }
    const decided = await decideScenario({
      actingUserLinkId: actorOf(req),
      tenantId: tenantOf(req),
      scenarioId: requireUuidParam(req, 'scenarioId'),
      decision,
      reviewedOutputFingerprint: String(stringField(b, 'reviewed_output_fingerprint', true)),
      expectedVersion: expectedVersionOf(req),
      overrideReason: stringField(b, 'override_reason', false),
      limitReason: stringField(b, 'limit_reason', false),
    });
    if (decided.outcome === 'already_decided') {
      send(res, 200, {
        scenario: decided.scenario,
        approval_id: decided.approvalId,
        outcome: 'already_decided',
      });
      return;
    }
    if (decided.outcome !== 'decided') refuse(decided);
    send(res, 200, { scenario: decided.scenario, approval_id: decided.approvalId });
  }),
);

router.post(
  '/scenarios/:scenarioId/expiry',
  authenticate,
  requireAction('desking.scenario.expire'),
  handler(async (req, res) => {
    const expired = await expireScenario({
      actingUserLinkId: actorOf(req),
      tenantId: tenantOf(req),
      scenarioId: requireUuidParam(req, 'scenarioId'),
      expectedVersion: expectedVersionOf(req),
      reason: stringField(body(req), 'reason', false),
    });
    if (expired.outcome === 'already_there') {
      send(res, 200, { scenario: expired.scenario, outcome: 'already_there' });
      return;
    }
    if (expired.outcome !== 'moved') refuse(expired);
    send(res, 200, { scenario: expired.scenario });
  }),
);

// ── the rule book ───────────────────────────────────────────────────────────

router.post(
  '/rules',
  authenticate,
  requireAction('desking.rules.write'),
  handler(async (req, res) => {
    const b = body(req);
    await idempotent(req, res, async (tx) => {
      const recorded = await recordRuleWithin(tx, {
        actingUserLinkId: actorOf(req),
        tenantId: tenantOf(req),
        ruleKind: String(stringField(b, 'rule_kind', true)) as 'tax',
        ruleCode: String(stringField(b, 'rule_code', true)),
        label: String(stringField(b, 'label', true)),
        source: String(stringField(b, 'source', true)),
        jurisdiction: String(stringField(b, 'jurisdiction', true)),
        rooftopId: optionalUuidField(b, 'location_id'),
        effectiveFrom: String(stringField(b, 'effective_from', true)),
        effectiveTo: stringField(b, 'effective_to', false),
        basis: String(stringField(b, 'basis', true)) as 'rate_ppm',
        ratePpm: centsField(b, 'rate_ppm', false),
        amountCents: centsField(b, 'amount_cents', false),
        appliesTo: String(stringField(b, 'applies_to', true)) as 'taxable_amount',
        currency: stringField(b, 'currency', false) ?? 'USD',
      });
      if (recorded.outcome !== 'recorded') refuse(recorded);
      return { status: 201, body: serialise({ rule: recorded.rule }) };
    });
  }),
);

export default router;
