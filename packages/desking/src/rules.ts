/**
 * ROW 4 — RULE AND SOURCE TRUTH.
 *
 * "Every tax, fee, incentive, valuation, and policy input names its source,
 * jurisdiction or rooftop scope, effective interval, and version. Expired,
 * overlapping, missing, or inapplicable rules refuse or remain
 * NOT_YET_AVAILABLE; deterministic simulators may stand in for uncertified
 * providers without pretending to be live data."
 *
 * WHAT IS ENFORCED WHERE. Overlap is the DATABASE's answer: migration 065's
 * `uq_desking_rules_no_overlap` is a GiST exclusion constraint, so two rules of
 * the same kind, code, jurisdiction and rooftop scope whose intervals overlap
 * cannot both exist, whatever the service believes. This module translates that
 * refusal into a business outcome rather than letting a 23P01 escape as a 500.
 *
 * EXPIRED AND MISSING ARE DIFFERENT ANSWERS, and saying so is the point. A rule
 * book with nothing in it for a jurisdiction is not the same as one whose tax
 * schedule ran out last month: the first is a rooftop nobody has configured,
 * the second is a rooftop whose configuration has gone stale, and a desk
 * manager needs to know which. `resolveRuleBook` returns both, and the pricing
 * command refuses on either rather than quietly pricing a deal at zero tax.
 *
 * A JURISDICTION WITH NO SALES TAX STILL WRITES A RULE — a `tax` rule at zero
 * ppm, naming the statute that makes it zero. Silence and zero look identical
 * in a total and mean opposite things in an audit.
 */
import { withTenantTransaction, type Executor } from '@dealer/database';
import { recordMutation, requireActor, type MutationResult } from '@dealer/identity-access';

import type { ResolvedRule, RuleBasis, RuleKind, RuleTarget } from './calculator';
import { reaches } from './intake';
import { toCents } from './money';

interface Row {
  [key: string]: unknown;
}

const RULE_KINDS: readonly RuleKind[] = ['tax', 'fee', 'incentive', 'valuation', 'policy'];
const RULE_BASES: readonly RuleBasis[] = ['rate_ppm', 'flat_amount'];
const RULE_TARGETS: readonly RuleTarget[] = ['vehicle_price', 'taxable_amount', 'total'];

const RULE_COLUMNS = `rule_id, rule_kind, rule_code, label, source, jurisdiction, rooftop_id,
  version, effective_from, effective_to, basis, rate_ppm, amount_cents, currency, applies_to`;

function mapRule(row: Row): ResolvedRule {
  return {
    ruleId: String(row.rule_id),
    ruleKind: String(row.rule_kind) as RuleKind,
    ruleCode: String(row.rule_code),
    label: String(row.label),
    source: String(row.source),
    jurisdiction: String(row.jurisdiction),
    rooftopScoped: row.rooftop_id !== null,
    version: Number(row.version),
    effectiveFrom: new Date(String(row.effective_from)).toISOString(),
    effectiveTo:
      row.effective_to === null ? null : new Date(String(row.effective_to)).toISOString(),
    basis: String(row.basis) as RuleBasis,
    ratePpm: row.rate_ppm === null ? null : toCents(row.rate_ppm),
    amountCents: row.amount_cents === null ? null : toCents(row.amount_cents),
    appliesTo: String(row.applies_to) as RuleTarget,
  };
}

export type RecordRuleOutcome =
  | { outcome: 'recorded'; rule: ResolvedRule; mutation: MutationResult }
  | { outcome: 'overlaps'; error: string }
  | { outcome: 'invalid'; error: string };

export interface RecordRuleInput {
  actingUserLinkId: string;
  tenantId: string;
  ruleKind: RuleKind;
  ruleCode: string;
  label: string;
  source: string;
  jurisdiction: string;
  /** null writes the tenant-wide default; a rooftop writes that rooftop's override. */
  rooftopId: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  basis: RuleBasis;
  ratePpm: bigint | null;
  amountCents: bigint | null;
  appliesTo: RuleTarget;
  currency?: string;
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

export async function recordRuleWithin(
  executor: Executor,
  input: RecordRuleInput,
): Promise<RecordRuleOutcome> {
  const actor = await requireActor(executor, input.actingUserLinkId);

  if (!RULE_KINDS.includes(input.ruleKind)) {
    return { outcome: 'invalid', error: `a rule is one of ${RULE_KINDS.join(', ')}` };
  }
  if (!RULE_BASES.includes(input.basis)) {
    return { outcome: 'invalid', error: `a rule is written as ${RULE_BASES.join(' or ')}` };
  }
  if (!RULE_TARGETS.includes(input.appliesTo)) {
    return { outcome: 'invalid', error: `a rule applies to ${RULE_TARGETS.join(', ')}` };
  }
  if (input.basis === 'rate_ppm' && (input.ratePpm === null || input.amountCents !== null)) {
    return { outcome: 'invalid', error: 'a rate rule carries a rate and no amount' };
  }
  if (input.basis === 'flat_amount' && (input.amountCents === null || input.ratePpm !== null)) {
    return { outcome: 'invalid', error: 'a flat rule carries an amount and no rate' };
  }
  if (input.effectiveTo !== null && input.effectiveTo <= input.effectiveFrom) {
    return { outcome: 'invalid', error: 'a rule stops after it starts' };
  }
  // A ROOFTOP RULE IS WRITTEN BY SOMEBODY WHO WORKS THAT ROOFTOP. The engine's
  // scope hint refuses first over HTTP; this is what holds for a worker or a
  // seeding script that never came through a request.
  if (input.rooftopId !== null && !(await reaches(input.tenantId, actor, input.rooftopId))) {
    return { outcome: 'invalid', error: 'you do not set the rule book at that rooftop' };
  }

  const nextVersion = await executor.query(
    `SELECT COALESCE(MAX(version), 0) + 1 AS next FROM desking_rules
      WHERE tenant_id = $1 AND rule_kind = $2 AND rule_code = $3`,
    [input.tenantId, input.ruleKind, input.ruleCode],
  );
  const version = Number((nextVersion.rows[0] as Row).next);

  let written;
  try {
    written = await executor.query(
      `INSERT INTO desking_rules
         (tenant_id, rule_kind, rule_code, label, source, jurisdiction, rooftop_id, version,
          effective_from, effective_to, basis, rate_ppm, amount_cents, currency, applies_to,
          recorded_by_user_link_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       RETURNING ${RULE_COLUMNS}`,
      [
        input.tenantId,
        input.ruleKind,
        input.ruleCode,
        input.label,
        input.source,
        input.jurisdiction,
        input.rooftopId,
        version,
        input.effectiveFrom,
        input.effectiveTo,
        input.basis,
        input.ratePpm === null ? null : input.ratePpm.toString(),
        input.amountCents === null ? null : input.amountCents.toString(),
        input.currency ?? 'USD',
        input.appliesTo,
        actor,
      ],
    );
  } catch (error) {
    if (isExclusionViolation(error)) {
      return {
        outcome: 'overlaps',
        error:
          `a ${input.ruleKind} rule ${input.ruleCode} for ${input.jurisdiction} is already in ` +
          'force over part of that interval — end the one in force before starting the next, ' +
          'because a rule book that answers twice cannot say what the figure is',
      };
    }
    throw error;
  }

  const rule = mapRule(written.rows[0] as Row);
  const mutation = await recordMutation(executor, {
    tenantId: input.tenantId,
    entityType: 'desking_rule',
    entityId: rule.ruleId,
    eventType: 'desking.rule.recorded',
    actingUserLinkId: actor,
    authorizationVersion: rule.version,
    details: {
      rule_kind: rule.ruleKind,
      rule_code: rule.ruleCode,
      jurisdiction: rule.jurisdiction,
      rooftop_scoped: rule.rooftopScoped,
      version: rule.version,
      source: rule.source,
    },
  });
  return { outcome: 'recorded', rule, mutation };
}

export async function recordRule(input: RecordRuleInput): Promise<RecordRuleOutcome> {
  return withTenantTransaction(input.tenantId, async (tx) => recordRuleWithin(tx, input));
}

export interface RuleBook {
  readonly rules: readonly ResolvedRule[];
  /** Kinds the jurisdiction has never had a rule for. */
  readonly missing: readonly RuleKind[];
  /** Kinds whose only rules stopped being in force before the pricing instant. */
  readonly expired: readonly RuleKind[];
}

/**
 * THE RULE BOOK AT AN INSTANT, for one jurisdiction and one rooftop.
 *
 * SPECIFICITY: a rooftop's own rule replaces the tenant-wide rule of the same
 * kind and code. They cannot collide in the database — the rooftop is part of
 * the exclusion key — so the choice is made here, once, and the chosen rule
 * carries `rooftopScoped` into the audit so a reader can see which won.
 *
 * A `tax` book that is empty or entirely expired is reported rather than
 * silently priced at zero: `missing` and `expired` are what the pricing command
 * refuses on.
 */
export async function resolveRuleBookWithin(
  executor: Executor,
  input: { tenantId: string; jurisdiction: string; rooftopId: string; at: string },
): Promise<RuleBook> {
  const found = await executor.query(
    `SELECT ${RULE_COLUMNS} FROM desking_rules
      WHERE tenant_id = $1
        AND jurisdiction = $2
        AND (rooftop_id IS NULL OR rooftop_id = $3)
        AND effective_from <= $4::timestamptz
        AND (effective_to IS NULL OR effective_to > $4::timestamptz)`,
    [input.tenantId, input.jurisdiction, input.rooftopId, input.at],
  );
  const inForce = found.rows.map((r) => mapRule(r as Row));

  const chosen = new Map<string, ResolvedRule>();
  for (const rule of inForce) {
    const key = `${rule.ruleKind}:${rule.ruleCode}`;
    const held = chosen.get(key);
    if (held === undefined || (rule.rooftopScoped && !held.rooftopScoped)) chosen.set(key, rule);
  }

  // What the jurisdiction has EVER had, so "never configured" and "went stale"
  // are different answers.
  const known = await executor.query(
    `SELECT DISTINCT rule_kind,
            bool_or(effective_to IS NULL OR effective_to > $4::timestamptz) AS any_in_force
       FROM desking_rules
      WHERE tenant_id = $1 AND jurisdiction = $2 AND (rooftop_id IS NULL OR rooftop_id = $3)
      GROUP BY rule_kind`,
    [input.tenantId, input.jurisdiction, input.rooftopId, input.at],
  );
  const everKinds = new Set(known.rows.map((r) => String((r as Row).rule_kind) as RuleKind));
  const staleKinds = new Set(
    known.rows
      .filter((r) => (r as Row).any_in_force === false)
      .map((r) => String((r as Row).rule_kind) as RuleKind),
  );

  const priceable: readonly RuleKind[] = ['tax'];
  const missing = priceable.filter((k) => !everKinds.has(k));
  const expired = priceable.filter((k) => everKinds.has(k) && staleKinds.has(k));

  return { rules: [...chosen.values()], missing, expired };
}

export async function resolveRuleBook(input: {
  tenantId: string;
  jurisdiction: string;
  rooftopId: string;
  at: string;
}): Promise<RuleBook> {
  return withTenantTransaction(input.tenantId, async (tx) => resolveRuleBookWithin(tx, input));
}

/** Every version of every rule this person may read, newest interval first. */
export async function listRules(
  tenantId: string,
  actingUserLinkId: string,
  filter: { jurisdiction?: string | undefined; rooftopId?: string | undefined },
): Promise<ResolvedRule[]> {
  return withTenantTransaction(tenantId, async (tx) => {
    const actor = await requireActor(tx, actingUserLinkId);
    if (filter.rooftopId !== undefined && !(await reaches(tenantId, actor, filter.rooftopId))) {
      return [];
    }
    const found = await tx.query(
      `SELECT ${RULE_COLUMNS} FROM desking_rules
        WHERE tenant_id = $1
          AND ($2::text IS NULL OR jurisdiction = $2)
          AND ($3::uuid IS NULL OR rooftop_id = $3 OR rooftop_id IS NULL)
        ORDER BY rule_kind, rule_code, version DESC
        LIMIT 500`,
      [tenantId, filter.jurisdiction ?? null, filter.rooftopId ?? null],
    );
    return found.rows.map((r) => mapRule(r as Row));
  });
}
