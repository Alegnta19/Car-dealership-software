/**
 * THE WORLD THE DESKING BATTERIES RUN IN.
 *
 * Not a test file — the runner globs `tests/*.test.ts` — but the fixture every
 * FBL-120 battery starts from, written once so six files cannot drift into six
 * slightly different dealerships.
 *
 * EVERY ROW IS MADE BY THE SERVICE THAT OWNS IT. The customer and the car come
 * from Release Train 2, the lead and its handoff from Release Train 3, and the
 * opportunity and its desking-ready fact from Release Train 4 — so the fact
 * FBL-120 consumes is a REAL one, written by the code that writes it in
 * production, rather than an INSERT this file guessed at. A fixture that plants
 * its own rows proves the desk works on rows the desk wrote.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { ROLES } from '@dealer/contracts';
import { createParty, acquireStock } from '@dealer/inventory';
import { captureLead, defineLeadSource, handOffLead, transitionLead } from '@dealer/crm';
import {
  moveOpportunityStage,
  receiveHandoff,
  setVehicleStatus,
  shortlistVehicle,
} from '@dealer/sales';
import { query } from '@dealer/database';
import {
  seedActor,
  seedDealerGroup,
  seedLegalEntity,
  seedRooftop,
  seedTenantIdentity,
  type IdentityTestEnv,
} from '@dealer/test-kit';

/**
 * JSON.stringify refuses a bigint, and every figure in this phase is one. This
 * is the one place that knows it, so an assertion message never becomes the
 * reason a test fails.
 */
export function show(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    typeof v === 'bigint' ? `${v.toString()}n` : v,
  );
}

export interface DeskWorld {
  tenantId: string;
  rooftopId: string;
  otherRooftopId: string;
  manager: string;
  seller: string;
  otherSeller: string;
  /** A salesperson bound to the OTHER rooftop, and to nothing here. */
  foreignSeller: string;
  partyId: string;
  stockItemId: string;
  opportunityId: string;
  deskingHandoffId: string;
  /** Bearer tokens for the same people, for the batteries that drive HTTP. */
  tokens: {
    manager: string;
    seller: string;
    otherSeller: string;
    foreignSeller: string;
  };
}

/** VINs handed out one at a time so two worlds never collide on one car. */
const VINS = [
  '1HGCM82633A104352',
  '2HGCM82633A104353',
  '3HGCM82633A104354',
  '5HGCM82633A104356',
  '6HGCM82633A104357',
  '7HGCM82633A104358',
  '8HGCM82633A104359',
  '9HGCM82633A104360',
  '1JGCM82633A104361',
  '2JGCM82633A104362',
  '3JGCM82633A104363',
  '4JGCM82633A104364',
  '5JGCM82633A104365',
  '6JGCM82633A104366',
];
let vinCursor = 0;
export function nextVin(): string {
  const vin = VINS[vinCursor % VINS.length] as string;
  vinCursor += 1;
  return vin;
}
export function resetVins(): void {
  vinCursor = 0;
}

/**
 * A dealership with two rooftops, a manager, two salespeople who work the first
 * rooftop and one who works only the second, one customer, one car, and ONE
 * opportunity carried all the way to its desking-ready fact.
 */
export async function seedDeskWorld(
  env: IdentityTestEnv,
  options: { withSelectedVehicle?: boolean } = {},
): Promise<DeskWorld> {
  const tenantId = randomUUID();
  await seedTenantIdentity(tenantId, 'Meridian Motors');
  const group = await seedDealerGroup({ tenantId, name: 'Meridian Group', status: 'active' });
  const entity = await seedLegalEntity({
    tenantId,
    dealerGroupId: group.dealerGroupId,
    name: 'Meridian LLC',
    status: 'active',
  });
  const rooftop = await seedRooftop({
    tenantId,
    legalEntityId: entity.legalEntityId,
    name: 'Riverside',
    status: 'active',
  });
  const otherRooftop = await seedRooftop({
    tenantId,
    legalEntityId: entity.legalEntityId,
    name: 'Northgate',
    status: 'active',
  });

  const manager = await seedActor(env.issuer, {
    tenantId,
    roles: [ROLES.SALES_MANAGER],
    scope: { level: 'rooftop', id: rooftop.rooftopId },
  });
  const seller = await seedActor(env.issuer, {
    tenantId,
    roles: [ROLES.SALESPERSON],
    scope: { level: 'rooftop', id: rooftop.rooftopId },
  });
  const otherSeller = await seedActor(env.issuer, {
    tenantId,
    roles: [ROLES.SALESPERSON],
    scope: { level: 'rooftop', id: rooftop.rooftopId },
  });
  const foreignSeller = await seedActor(env.issuer, {
    tenantId,
    roles: [ROLES.SALESPERSON],
    scope: { level: 'rooftop', id: otherRooftop.rooftopId },
  });

  const party = await createParty({
    actingUserLinkId: manager.userLinkId,
    tenantId,
    partyType: 'person',
    details: { givenName: 'Dana', familyName: 'Ortiz', email: `dana.${vinCursor}@example.com` },
  });
  assert.equal(party.outcome, 'created', show(party));
  const partyId = (party as { party: { partyId: string } }).party.partyId;

  const vin = nextVin();
  const stock = await acquireStock({
    actingUserLinkId: manager.userLinkId,
    tenantId,
    rooftopId: rooftop.rooftopId,
    vin,
    stockNumber: `M${vin.slice(-6)}`,
    acquisitionSource: 'auction',
    acquiredOn: '2026-08-01',
    // The model year the VIN's tenth character is read against. Without it the
    // decoder has no century to resolve into and the vehicle row is refused.
    referenceYear: 2022,
  });
  assert.equal(stock.outcome, 'acquired', show(stock));
  const stockItemId = (stock as { stockItem: { stockItemId: string } }).stockItem.stockItemId;

  const source = await defineLeadSource({
    actingUserLinkId: manager.userLinkId,
    tenantId,
    sourceCode: 'walk_in',
    displayName: 'Walk in',
    channel: 'walk_in',
    medium: 'direct',
  });
  assert.ok(source.outcome === 'saved' || source.outcome === 'duplicate', show(source));

  const captured = await captureLead({
    actingUserLinkId: manager.userLinkId,
    tenantId,
    rooftopId: rooftop.rooftopId,
    intakeKey: `desk-${vin}`,
    channel: 'manual',
    sourceCode: 'walk_in',
    partyId,
  });
  assert.equal(captured.outcome, 'created', show(captured));
  const lead = (captured as { lead: { leadId: string; authorizationVersion: number } }).lead;
  let version = lead.authorizationVersion;
  for (const state of ['working', 'qualified'] as const) {
    const moved = await transitionLead({
      actingUserLinkId: manager.userLinkId,
      tenantId,
      leadId: lead.leadId,
      toState: state,
      expectedVersion: version,
    });
    assert.equal(moved.outcome, 'moved', show(moved));
    version = (moved as { lead: { authorizationVersion: number } }).lead.authorizationVersion;
  }
  const handed = await handOffLead({
    actingUserLinkId: manager.userLinkId,
    tenantId,
    leadId: lead.leadId,
    expectedVersion: version,
    handedToUserLinkId: seller.userLinkId,
  });
  assert.equal(handed.outcome, 'handed_off', show(handed));
  const handoffId = (handed as { handoffId: string }).handoffId;

  const received = await receiveHandoff({
    actingUserLinkId: seller.userLinkId,
    tenantId,
    handoffId,
  });
  assert.equal(received.outcome, 'received', show(received));
  const opportunity = (
    received as { opportunity: { opportunityId: string; authorizationVersion: number } }
  ).opportunity;
  let opportunityVersion = opportunity.authorizationVersion;

  if (options.withSelectedVehicle !== false) {
    // Shortlisting adds the car as one they are CONSIDERING; settling on it is
    // a second act, and the sales train models them separately on purpose.
    const shortlisted = await shortlistVehicle({
      actingUserLinkId: seller.userLinkId,
      tenantId,
      opportunityId: opportunity.opportunityId,
      stockItemId,
    });
    assert.equal(shortlisted.outcome, 'added', show(shortlisted));
    const shortlistRow = (
      shortlisted as {
        vehicle: { opportunityVehicleId: string; authorizationVersion: number };
      }
    ).vehicle;
    const selected = await setVehicleStatus({
      actingUserLinkId: seller.userLinkId,
      tenantId,
      opportunityId: opportunity.opportunityId,
      opportunityVehicleId: shortlistRow.opportunityVehicleId,
      expectedVersion: shortlistRow.authorizationVersion,
      status: 'selected',
    });
    assert.equal(selected.outcome, 'updated', show(selected));
  }

  // The opportunity walks to its conclusion through the sales train's own
  // machine — received → in_showroom → ready_for_desking — so the fact this
  // world hands the desk is written by `moveOpportunityStage` and nothing else.
  for (const step of ['in_showroom', 'ready_for_desking'] as const) {
    const moved = await moveOpportunityStage({
      actingUserLinkId: seller.userLinkId,
      tenantId,
      opportunityId: opportunity.opportunityId,
      toStage: step,
      expectedVersion: opportunityVersion,
      disposition: step === 'ready_for_desking' ? 'committed_to_purchase' : null,
    });
    assert.equal(moved.outcome, 'moved', show(moved));
    opportunityVersion = (moved as { opportunity: { authorizationVersion: number } }).opportunity
      .authorizationVersion;
  }

  const fact = await query(
    `SELECT desking_handoff_id FROM desking_handoffs WHERE tenant_id = $1 AND opportunity_id = $2`,
    [tenantId, opportunity.opportunityId],
  );
  assert.equal(fact.rows.length, 1, 'the sales train writes exactly one desking-ready fact');

  return {
    tenantId,
    rooftopId: rooftop.rooftopId,
    otherRooftopId: otherRooftop.rooftopId,
    manager: manager.userLinkId,
    seller: seller.userLinkId,
    otherSeller: otherSeller.userLinkId,
    foreignSeller: foreignSeller.userLinkId,
    partyId,
    stockItemId,
    opportunityId: opportunity.opportunityId,
    deskingHandoffId: String((fact.rows[0] as { desking_handoff_id: string }).desking_handoff_id),
    tokens: {
      manager: manager.token,
      seller: seller.token,
      otherSeller: otherSeller.token,
      foreignSeller: foreignSeller.token,
    },
  };
}

/**
 * A minimal rule book that can price a deal: one sales tax, one flat doc fee,
 * and the policy that a trade allowance reduces the taxable base in full.
 * Every one names a source, because Row 4 requires it and because a figure
 * nobody can attribute is a figure nobody can approve.
 */
export const JURISDICTION = 'US-CO';

export async function seedRuleBook(
  world: DeskWorld,
  overrides: { taxRatePpm?: bigint; docFeeCents?: bigint; tradeCreditPpm?: bigint | null } = {},
): Promise<void> {
  const { recordRule } = await import('@dealer/desking');
  const from = '2026-01-01T00:00:00.000Z';
  const tax = await recordRule({
    actingUserLinkId: world.manager,
    tenantId: world.tenantId,
    ruleKind: 'tax',
    ruleCode: 'state_sales_tax',
    label: 'State sales tax',
    source: 'Colorado Revised Statutes §39-26-104',
    jurisdiction: JURISDICTION,
    rooftopId: null,
    effectiveFrom: from,
    effectiveTo: null,
    basis: 'rate_ppm',
    ratePpm: overrides.taxRatePpm ?? 29000n,
    amountCents: null,
    appliesTo: 'taxable_amount',
  });
  assert.equal(tax.outcome, 'recorded', show(tax));

  const fee = await recordRule({
    actingUserLinkId: world.manager,
    tenantId: world.tenantId,
    ruleKind: 'fee',
    ruleCode: 'documentation_fee',
    label: 'Documentation fee',
    source: 'Rooftop pricing policy 2026-01',
    jurisdiction: JURISDICTION,
    rooftopId: null,
    effectiveFrom: from,
    effectiveTo: null,
    basis: 'flat_amount',
    ratePpm: null,
    amountCents: overrides.docFeeCents ?? 69900n,
    appliesTo: 'vehicle_price',
  });
  assert.equal(fee.outcome, 'recorded', show(fee));

  const creditPpm = overrides.tradeCreditPpm === undefined ? 1000000n : overrides.tradeCreditPpm;
  if (creditPpm !== null) {
    const policy = await recordRule({
      actingUserLinkId: world.manager,
      tenantId: world.tenantId,
      ruleKind: 'policy',
      ruleCode: 'trade_tax_credit',
      label: 'Trade allowance reduces the taxable base',
      source: 'Colorado Revised Statutes §39-26-113(5)',
      jurisdiction: JURISDICTION,
      rooftopId: null,
      effectiveFrom: from,
      effectiveTo: null,
      basis: 'rate_ppm',
      ratePpm: creditPpm,
      amountCents: null,
      appliesTo: 'taxable_amount',
    });
    assert.equal(policy.outcome, 'recorded', show(policy));
  }
}

/** The evidence a walk-around produces, with everything Row 2 names. */
export function tradeEvidence(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ownership: 'financed',
    relationship: 'customer_owned',
    odometerMiles: 68_420,
    odometerStatus: 'actual',
    conditionGrade: 'clean',
    provenance: 'walk_around',
    inspectionNotes: 'Tyres at 5mm, service history complete, one key.',
    damage: [
      { area: 'front bumper', severity: 'light', note: 'scuff', estimatedRepairCents: 24000n },
    ],
    equipment: [
      { code: 'sunroof', label: 'Sunroof', present: true },
      { code: 'tow_pkg', label: 'Tow package', present: false },
    ],
    observations: ['Second key not present at appraisal.'],
    ...overrides,
  };
}
