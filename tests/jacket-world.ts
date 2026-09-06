/**
 * THE WORLD THE FBL-140 BATTERIES RUN IN.
 *
 * Not a test file — the runner globs `tests/*.test.ts` — but the fixture every
 * jacket battery starts from, written once so eight files cannot drift into
 * eight slightly different dealerships.
 *
 * EVERY ROW IS MADE BY THE SERVICE THAT OWNS IT. The dealership, the customer,
 * the car and the desking-ready fact come from `tests/desking-world.ts`
 * exactly as FBL-120's batteries built them; the desk file, the trade, the
 * priced version, its submission and the manager's approval are written by
 * `@dealer/desking`'s own services — so the approved version the jacket
 * consumes is a REAL one, written by the code that writes it in production,
 * rather than an INSERT this file guessed at.
 *
 * THE CONFIGURATION IS HONEST. The templates this world records are UNAPPROVED
 * SAMPLES, say so in their source, default to that status, and are rendered
 * with that sentence on every page. One battery approves one of them, with an
 * approval reference, to prove the other branch.
 */
import assert from 'node:assert/strict';

import { ROLES } from '@dealer/contracts';
import { TENANT_ADMIN_ROLE } from '@dealer/identity-access';
import {
  buildScenario,
  decideScenario,
  openDeskingCase,
  recordAppraisal,
  recordSourceQuotation,
  submitScenario,
} from '@dealer/desking';
import {
  DEAL_DOCUMENT_RETENTION_CODE,
  recordRequirement,
  recordRetentionPolicy,
  recordTemplate,
  type TemplateApprovalStatus,
} from '@dealer/jacket';
import { seedActor, type IdentityTestEnv } from '@dealer/test-kit';

import {
  JURISDICTION,
  seedDeskWorld,
  seedRuleBook,
  show,
  tradeEvidence,
  type DeskWorld,
} from './desking-world';

export { JURISDICTION, resetVins, show } from './desking-world';

export interface JacketWorld extends DeskWorld {
  /** The dealership administrator: the support lane, and nobody below it. */
  admin: string;
  caseId: string;
  appraisalId: string;
  approvedScenarioId: string;
  approvedVersionNo: number;
  approvedFingerprint: string;
  tokens: DeskWorld['tokens'] & { admin: string };
}

export const EFFECTIVE_FROM = '2026-01-01T00:00:00.000Z';

/** The sample templates, with placeholders the assembler fills. */
export const SAMPLE_TEMPLATES = {
  retail_agreement: {
    title: 'Retail purchase agreement (sample)',
    documentKind: 'contract' as const,
    body:
      'RETAIL PURCHASE AGREEMENT between {{dealer.legal_entity}} ({{dealer.rooftop}}) and {{customer.name}}.\n\n' +
      'Vehicle: model year {{vehicle.year}}, VIN {{vehicle.vin}}, stock {{vehicle.stock_number}}.\n\n' +
      'Vehicle price {{deal.vehicle_price}}. Trade allowance {{deal.trade_allowance}}. Trade payoff {{deal.trade_payoff}}. ' +
      'Cash down {{deal.cash_down}}. Taxable amount {{deal.taxable_amount}}. Taxes {{deal.tax_total}}. Fees {{deal.fee_total}}. ' +
      'Amount financed {{deal.amount_financed}}.\n\n' +
      'Priced under desk version {{deal.desking_version}}, fingerprint {{deal.output_fingerprint}}, approved {{deal.approved_at}}.',
    signers: ['customer', 'dealer_representative'] as const,
  },
  odometer_disclosure: {
    title: 'Odometer disclosure (sample)',
    documentKind: 'disclosure' as const,
    body:
      'ODOMETER DISCLOSURE for the trade-in {{trade.year}} {{trade.make}} {{trade.model}}, VIN {{trade.vin}}: ' +
      '{{trade.odometer_miles}} miles, odometer status {{trade.odometer_status}}, condition {{trade.condition_grade}}, ' +
      'ownership {{trade.ownership}}. Declared by {{customer.name}}.',
    signers: ['customer'] as const,
  },
  privacy_notice: {
    title: 'Privacy notice acknowledgement (sample)',
    documentKind: 'acknowledgement' as const,
    body: 'PRIVACY NOTICE. {{customer.name}} acknowledges receipt of the dealership privacy notice from {{dealer.legal_entity}}.',
    signers: ['customer'] as const,
  },
} as const;

/**
 * A dealership whose desk has approved ONE version of ONE deal, with the trade
 * appraised, plus an administrator, plus the document configuration a jacket
 * needs: three sample templates, three requirements (two documents, one piece
 * of evidence), and the retention policy every rendered document is kept under.
 */
export async function seedJacketWorld(
  env: IdentityTestEnv,
  options: {
    withSelectedVehicle?: boolean;
    withTrade?: boolean;
    withConfiguration?: boolean;
    termMonths?: number | null;
  } = {},
): Promise<JacketWorld> {
  const desk = await seedDeskWorld(
    env,
    options.withSelectedVehicle === undefined
      ? {}
      : { withSelectedVehicle: options.withSelectedVehicle },
  );
  await seedRuleBook(desk);
  const admin = await seedActor(env.issuer, {
    tenantId: desk.tenantId,
    roles: [TENANT_ADMIN_ROLE],
    scope: { level: 'tenant', id: desk.tenantId },
  });

  const opened = await openDeskingCase({
    actingUserLinkId: desk.seller,
    tenantId: desk.tenantId,
    deskingHandoffId: desk.deskingHandoffId,
  });
  assert.equal(opened.outcome, 'opened', show(opened));
  const caseId = (opened as { deskingCase: { deskingCaseId: string } }).deskingCase.deskingCaseId;

  let appraisalId = '';
  if (options.withTrade !== false) {
    const appraised = await recordAppraisal({
      actingUserLinkId: desk.seller,
      tenantId: desk.tenantId,
      deskingCaseId: caseId,
      vin: '2T1BURHE0JC014729',
      modelYear: 2018,
      make: 'Toyota',
      model: 'Corolla',
      evidence: tradeEvidence() as never,
    });
    assert.equal(appraised.outcome, 'recorded', show(appraised));
    appraisalId = (appraised as { appraisal: { appraisalId: string } }).appraisal.appraisalId;
    const quoted = await recordSourceQuotation({
      actingUserLinkId: desk.seller,
      tenantId: desk.tenantId,
      appraisalId,
      providerCode: 'sim_book',
      providerKind: 'deterministic_simulator',
      availability: 'quoted',
      quotedValueCents: 1_150_000n,
      unavailableReason: null,
    } as never);
    assert.equal(quoted.outcome, 'recorded', show(quoted));
  }

  const approved = await approveVersion(desk, caseId, {
    termMonths: options.termMonths === undefined ? 72 : options.termMonths,
  });

  if (options.withConfiguration !== false)
    await seedJacketConfiguration({ ...desk, admin: admin.userLinkId });

  return {
    ...desk,
    admin: admin.userLinkId,
    caseId,
    appraisalId,
    approvedScenarioId: approved.scenarioId,
    approvedVersionNo: approved.versionNo,
    approvedFingerprint: approved.fingerprint,
    tokens: { ...desk.tokens, admin: admin.token },
  };
}

/** Build, submit and approve one more version of the deal — the desk moving on. */
export async function approveVersion(
  w: DeskWorld,
  caseId: string,
  overrides: Record<string, unknown> = {},
): Promise<{ scenarioId: string; versionNo: number; fingerprint: string }> {
  const built = await buildScenario({
    actingUserLinkId: w.seller,
    tenantId: w.tenantId,
    deskingCaseId: caseId,
    label: 'Pencil',
    jurisdiction: JURISDICTION,
    vehiclePriceCents: 4_550_000n,
    tradeAllowanceCents: 1_200_000n,
    tradePayoffCents: 1_450_000n,
    cashDownCents: 300_000n,
    termMonths: 72,
    aprPpm: 74_900n,
    ...overrides,
  } as never);
  assert.equal(built.outcome, 'built', show(built));
  const s = (
    built as {
      scenario: {
        scenarioId: string;
        versionNo: number;
        authorizationVersion: number;
        outputFingerprint: string;
      };
    }
  ).scenario;
  const moved = await submitScenario({
    actingUserLinkId: w.seller,
    tenantId: w.tenantId,
    scenarioId: s.scenarioId,
    expectedVersion: s.authorizationVersion,
  });
  assert.equal(moved.outcome, 'moved', show(moved));
  const submittedVersion = (moved as { scenario: { authorizationVersion: number } }).scenario
    .authorizationVersion;
  const decided = await decideScenario({
    actingUserLinkId: w.manager,
    tenantId: w.tenantId,
    scenarioId: s.scenarioId,
    decision: 'approved',
    reviewedOutputFingerprint: s.outputFingerprint,
    expectedVersion: submittedVersion,
  });
  assert.equal(decided.outcome, 'decided', show(decided));
  return { scenarioId: s.scenarioId, versionNo: s.versionNo, fingerprint: s.outputFingerprint };
}

export async function seedTemplate(
  w: { tenantId: string; manager: string },
  code: keyof typeof SAMPLE_TEMPLATES,
  overrides: {
    approvalStatus?: TemplateApprovalStatus;
    approvalReference?: string | null;
    rooftopId?: string | null;
    effectiveFrom?: string;
    effectiveTo?: string | null;
    body?: string;
    transactionType?: 'retail_cash' | 'retail_finance' | 'any';
    closesPredecessor?: boolean;
  } = {},
): Promise<string> {
  const t = SAMPLE_TEMPLATES[code];
  const recorded = await recordTemplate({
    actingUserLinkId: w.manager,
    tenantId: w.tenantId,
    templateCode: code,
    title: t.title,
    documentKind: t.documentKind,
    jurisdiction: JURISDICTION,
    legalEntityId: null,
    rooftopId: overrides.rooftopId ?? null,
    transactionType: overrides.transactionType ?? 'any',
    source:
      'FBL-140 sample text written for this repository’s tests — NOT a jurisdictionally approved form',
    approvalStatus: overrides.approvalStatus ?? 'unapproved_sample',
    approvalReference: overrides.approvalReference ?? null,
    effectiveFrom: overrides.effectiveFrom ?? EFFECTIVE_FROM,
    effectiveTo: overrides.effectiveTo ?? null,
    bodyTemplate: overrides.body ?? t.body,
    requiredSignerRoles: [...t.signers],
    closesPredecessor: overrides.closesPredecessor ?? false,
  });
  assert.equal(recorded.outcome, 'recorded', show(recorded));
  return (recorded as { record: { templateId: string } }).record.templateId;
}

/** Three templates, three requirements, one retention policy. */
export async function seedJacketConfiguration(w: {
  tenantId: string;
  manager: string;
  admin: string;
}): Promise<void> {
  await seedTemplate(w, 'retail_agreement');
  await seedTemplate(w, 'odometer_disclosure');
  await seedTemplate(w, 'privacy_notice');

  const requirements: Array<{
    code: string;
    label: string;
    satisfiedBy: 'template' | 'evidence';
    templateCode: string | null;
    evidenceKind: string | null;
    required: boolean;
    waivable: boolean;
    transactionType: 'retail_cash' | 'retail_finance' | 'any';
  }> = [
    {
      code: 'retail_agreement',
      label: 'Retail purchase agreement',
      satisfiedBy: 'template',
      templateCode: 'retail_agreement',
      evidenceKind: null,
      required: true,
      waivable: false,
      transactionType: 'any',
    },
    {
      code: 'odometer_disclosure',
      label: 'Odometer disclosure on the trade',
      satisfiedBy: 'template',
      templateCode: 'odometer_disclosure',
      evidenceKind: null,
      required: true,
      waivable: true,
      transactionType: 'any',
    },
    {
      code: 'privacy_notice',
      label: 'Privacy notice acknowledgement',
      satisfiedBy: 'template',
      templateCode: 'privacy_notice',
      evidenceKind: null,
      required: false,
      waivable: false,
      transactionType: 'any',
    },
    {
      code: 'proof_of_insurance',
      label: 'Proof of insurance',
      satisfiedBy: 'evidence',
      templateCode: null,
      evidenceKind: 'insurance_card',
      required: true,
      waivable: true,
      transactionType: 'any',
    },
  ];
  for (const r of requirements) {
    const recorded = await recordRequirement({
      actingUserLinkId: w.manager,
      tenantId: w.tenantId,
      requirementCode: r.code,
      label: r.label,
      jurisdiction: JURISDICTION,
      legalEntityId: null,
      rooftopId: null,
      transactionType: r.transactionType,
      satisfiedBy: r.satisfiedBy,
      templateCode: r.templateCode,
      evidenceKind: r.evidenceKind,
      required: r.required,
      waivable: r.waivable,
      source: 'Rooftop document policy 2026-01 (test fixture)',
      effectiveFrom: EFFECTIVE_FROM,
      effectiveTo: null,
    });
    assert.equal(recorded.outcome, 'recorded', show(recorded));
  }

  const retention = await recordRetentionPolicy({
    actingUserLinkId: w.admin,
    tenantId: w.tenantId,
    policyCode: DEAL_DOCUMENT_RETENTION_CODE,
    label: 'Deal jacket documents',
    retainForDays: 2555,
    source: 'Dealership records-retention schedule 2026 (test fixture)',
    effectiveFrom: EFFECTIVE_FROM,
    effectiveTo: null,
  });
  assert.equal(retention.outcome, 'recorded', show(retention));
}

/** The sha256 of a piece of evidence a test pretends to hold. */
export const INSURANCE_CARD_SHA256 = 'a'.repeat(64);

export const ROLE_NAMES = {
  manager: ROLES.SALES_MANAGER,
  seller: ROLES.SALESPERSON,
  admin: TENANT_ADMIN_ROLE,
};
