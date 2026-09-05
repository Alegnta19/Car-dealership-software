/**
 * FBL-120 — THE DESKING ACTION CATALOG.
 *
 * Every route on this surface names one of these, and the policy engine decides
 * it from database-authoritative role bindings.
 *
 * AN ACTION WITH A `resourceType` IS ROOFTOP-SCOPED, and the route that names
 * it MUST carry that type's parameter or the middleware resolves no resource
 * and the decision silently widens to the whole dealership. Everything hanging
 * off a desk file — its appraisal evidence, its quotations, its scenarios — is
 * authorized THROUGH its own parent, which is why `deskingCaseId`,
 * `appraisalId` and `scenarioId` are in the paths.
 *
 * AN ACTION WITH NO `resourceType` STILL BELONGS TO A ROOFTOP. Opening a desk
 * file and writing a rooftop rule create rows the engine has nothing to resolve
 * yet, so their rooftop arrives as a field the SERVICE checks against the same
 * effective bindings — `reaches()` in `intake.ts`, called by both. Over HTTP
 * the engine's scope hint usually refuses first; the service check is what
 * holds for a worker or a seeding script that never came through a request.
 *
 * THE TWO ROLES ARE NOT INTERCHANGEABLE, and this is the phase where that
 * matters most. A salesperson opens the file, appraises the trade and builds
 * and submits figures. ONLY a sales manager decides one — `desking.scenario.decide`
 * is the single action a salesperson cannot hold, and `isEligibleManager` in
 * `scenarios.ts` re-checks it at the write rather than trusting the route.
 * Writing the rule book is a manager's job too: a salesperson who could edit
 * the tax table could approve their own deal by another route.
 */
import { ROLES } from '@dealer/contracts';
import {
  TENANT_ADMIN_ROLE,
  createActionCatalog,
  type ActionCatalog,
} from '@dealer/identity-access';

/** Anyone who works a deal. */
const DESK_ANY: readonly string[] = [TENANT_ADMIN_ROLE, ROLES.SALES_MANAGER, ROLES.SALESPERSON];

/** Deciding, and the rule book the decision is measured against. */
const DESK_MANAGER_UP: readonly string[] = [TENANT_ADMIN_ROLE, ROLES.SALES_MANAGER];

export const DESKING_ACTION_DEFINITIONS = [
  // ── discovery and reading ───────────────────────────────────────────────
  {
    action: 'desking.discovery.read',
    description:
      'Find the desking-ready handoffs and desk files this person may act on, at the ' +
      'rooftops they work',
    resourceType: null,
    allowedRoles: DESK_ANY,
  },
  {
    action: 'desking.case.view',
    description: 'Read the desk board across permitted rooftops',
    resourceType: null,
    allowedRoles: DESK_ANY,
  },
  {
    action: 'desking.case.read',
    description: 'Read one desk file, its appraisal and its versions',
    resourceType: 'desking_case',
    allowedRoles: DESK_ANY,
  },
  // ── the file ────────────────────────────────────────────────────────────
  {
    action: 'desking.case.open',
    description: 'Open a desk file from a desking-ready handoff',
    resourceType: null,
    allowedRoles: DESK_ANY,
  },
  // ── the trade ───────────────────────────────────────────────────────────
  {
    action: 'desking.appraisal.record',
    description: 'Record the trade unit and the first version of its evidence',
    resourceType: 'desking_case',
    allowedRoles: DESK_ANY,
  },
  {
    action: 'desking.appraisal.revise',
    description: 'Record the next version of a trade appraisal',
    resourceType: 'appraisal',
    allowedRoles: DESK_ANY,
  },
  {
    action: 'desking.appraisal.read',
    description: 'Read a trade appraisal and its version history',
    resourceType: 'appraisal',
    allowedRoles: DESK_ANY,
  },
  // ── the figures ─────────────────────────────────────────────────────────
  {
    action: 'desking.scenario.build',
    description: 'Build a priced version of the deal from the rule book',
    resourceType: 'desking_case',
    allowedRoles: DESK_ANY,
  },
  {
    action: 'desking.scenario.read',
    description: 'Read one priced version, its lines and the rules it was priced under',
    resourceType: 'desking_scenario',
    allowedRoles: DESK_ANY,
  },
  {
    action: 'desking.scenario.submit',
    description: 'Put a priced version in front of a manager',
    resourceType: 'desking_scenario',
    allowedRoles: DESK_ANY,
  },
  {
    action: 'desking.scenario.expire',
    description: 'Retire a priced version nobody acted on',
    resourceType: 'desking_scenario',
    allowedRoles: DESK_ANY,
  },
  // ── the decision, and the rule book it is measured against ──────────────
  {
    action: 'desking.scenario.decide',
    description: 'Approve or reject one exact priced version, as an eligible manager',
    resourceType: 'desking_scenario',
    allowedRoles: DESK_MANAGER_UP,
  },
  {
    action: 'desking.rules.read',
    description: 'Read the tax, fee, incentive, valuation and policy rules in force',
    resourceType: null,
    allowedRoles: DESK_ANY,
  },
  {
    action: 'desking.rules.write',
    description: 'Record a version of a tax, fee, incentive, valuation or policy rule',
    resourceType: null,
    allowedRoles: DESK_MANAGER_UP,
  },
] as const;

export function createDeskingActionCatalog(): ActionCatalog {
  return createActionCatalog(DESKING_ACTION_DEFINITIONS.map((d) => ({ ...d })));
}

/** The roles a dealership may put on desking work, for the invitation UI. */
export const DESKING_ROLES: readonly string[] = [ROLES.SALES_MANAGER, ROLES.SALESPERSON];
