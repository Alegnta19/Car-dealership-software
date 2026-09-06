/**
 * FBL-140 — THE DEAL JACKET ACTION CATALOG, AND THE LANES IT DRAWS.
 *
 * Every staff route on this surface names one of these, and the policy engine
 * decides it from database-authoritative role bindings. Two lanes are NOT here,
 * because they are not staff: the CUSTOMER SIGNER arrives through a lane token
 * (`/sign`), and the PROVIDER arrives through a signed callback
 * (`/api/jacket/provider/esign/callback`). Neither holds a user link, so
 * neither can hold an action, which is the point — a lane that cannot be
 * granted a role cannot be granted the wrong one.
 *
 * AN ACTION WITH A `resourceType` IS ROOFTOP-SCOPED, and the route that names
 * it carries that type's parameter — `jacketId`, `packageId` or `ceremonyId` —
 * or the middleware resolves no resource and the decision silently widens to
 * the whole dealership. Everything hanging off a jacket — its checklist, its
 * bindings, its packages' fields and documents, its ceremony's signers and
 * events — is authorized THROUGH its parent.
 *
 * FOUR STAFF AUTHORITIES, NOT ONE ROLE WITH FLAGS:
 *   * A SALESPERSON opens the jacket, records evidence, assembles the package
 *     and says when the paperwork is ready.
 *   * A SALES MANAGER additionally waives a requirement, reviews, sends, voids,
 *     and signs as the dealership's representative. `isEligibleManager`
 *     re-checks every one of those at the write.
 *   * The DEALERSHIP ADMINISTRATOR — and nobody below — writes retention
 *     policy, places and lifts legal holds, and exports the file. That is the
 *     support lane, and a manager does not have it.
 *   * SYSTEM writes — expiry by the clock — come through the worker with no
 *     user at all and are recorded as such.
 */
import { ROLES } from '@dealer/contracts';
import {
  TENANT_ADMIN_ROLE,
  createActionCatalog,
  type ActionCatalog,
} from '@dealer/identity-access';

/** Anyone who works a deal's paperwork. */
const JACKET_ANY: readonly string[] = [TENANT_ADMIN_ROLE, ROLES.SALES_MANAGER, ROLES.SALESPERSON];

/** Decisions on the paperwork: waive, review, send, void, sign for the dealership. */
const JACKET_MANAGER_UP: readonly string[] = [TENANT_ADMIN_ROLE, ROLES.SALES_MANAGER];

/** The support lane: retention, legal hold, export. */
const JACKET_ADMIN_ONLY: readonly string[] = [TENANT_ADMIN_ROLE];

export const JACKET_ACTION_DEFINITIONS = [
  // ── discovery and reading ───────────────────────────────────────────────
  {
    action: 'jacket.discovery.read',
    description:
      'Find the approved desk files a jacket may be opened from, at the rooftops this person works',
    resourceType: null,
    allowedRoles: JACKET_ANY,
  },
  {
    action: 'jacket.board.view',
    description: 'Read the jacket board and its queues across permitted rooftops',
    resourceType: null,
    allowedRoles: JACKET_ANY,
  },
  {
    action: 'jacket.read',
    description: 'Read one jacket: its bindings, checklist, packages, ceremony and timeline',
    resourceType: 'deal_jacket',
    allowedRoles: JACKET_ANY,
  },
  {
    action: 'jacket.package.read',
    description: 'Read one package version, its fields, documents and ceremony',
    resourceType: 'jacket_package',
    allowedRoles: JACKET_ANY,
  },
  {
    action: 'jacket.ceremony.read',
    description: 'Read one signing ceremony and its completion certificate',
    resourceType: 'signing_ceremony',
    allowedRoles: JACKET_ANY,
  },
  // ── the jacket ──────────────────────────────────────────────────────────
  {
    action: 'jacket.open',
    description: 'Open a deal jacket from the desk’s approved version',
    resourceType: null,
    allowedRoles: JACKET_ANY,
  },
  {
    action: 'jacket.checklist.evidence',
    description: 'Record evidence that satisfies an evidence-kind requirement',
    resourceType: 'deal_jacket',
    allowedRoles: JACKET_ANY,
  },
  {
    action: 'jacket.checklist.waive',
    description:
      'Waive a waivable requirement, as an eligible manager, with reason, policy version and evidence',
    resourceType: 'deal_jacket',
    allowedRoles: JACKET_MANAGER_UP,
  },
  {
    action: 'jacket.void',
    description: 'Void a jacket so a new one may open from the desk’s current approval',
    resourceType: 'deal_jacket',
    allowedRoles: JACKET_MANAGER_UP,
  },
  // ── the package ─────────────────────────────────────────────────────────
  {
    action: 'jacket.package.assemble',
    description: 'Assemble and render the next package version from canonical records',
    resourceType: 'deal_jacket',
    allowedRoles: JACKET_ANY,
  },
  {
    action: 'jacket.package.review_ready',
    description: 'Say the paperwork is complete; blocked by any missing required item',
    resourceType: 'jacket_package',
    allowedRoles: JACKET_ANY,
  },
  {
    action: 'jacket.package.review',
    description: 'Stamp a manager’s review on a package that requires one',
    resourceType: 'jacket_package',
    allowedRoles: JACKET_MANAGER_UP,
  },
  {
    action: 'jacket.package.send',
    description: 'Send a review-ready package to its signers, as an eligible manager',
    resourceType: 'jacket_package',
    allowedRoles: JACKET_MANAGER_UP,
  },
  {
    action: 'jacket.package.void',
    description: 'Void a package version and the ceremony on it',
    resourceType: 'jacket_package',
    allowedRoles: JACKET_MANAGER_UP,
  },
  {
    action: 'jacket.artifact.access',
    description: 'Issue a short-lived grant to read one rendered document',
    resourceType: 'jacket_package',
    allowedRoles: JACKET_ANY,
  },
  // ── the ceremony ────────────────────────────────────────────────────────
  {
    action: 'jacket.ceremony.sign_as_dealer',
    description: 'Sign as the dealership’s representative, through a staff session',
    resourceType: 'signing_ceremony',
    allowedRoles: JACKET_MANAGER_UP,
  },
  // ── configuration ───────────────────────────────────────────────────────
  {
    action: 'jacket.configuration.read',
    description: 'Read the document templates, requirements and retention policies in force',
    resourceType: null,
    allowedRoles: JACKET_ANY,
  },
  {
    action: 'jacket.configuration.write',
    description: 'Record a version of a document template or requirement',
    resourceType: null,
    allowedRoles: JACKET_MANAGER_UP,
  },
  // ── the support lane ────────────────────────────────────────────────────
  {
    action: 'jacket.retention.write',
    description: 'Record a version of a retention policy',
    resourceType: null,
    allowedRoles: JACKET_ADMIN_ONLY,
  },
  {
    action: 'jacket.hold.write',
    description: 'Place or lift a legal hold on a jacket’s documents',
    resourceType: 'deal_jacket',
    allowedRoles: JACKET_ADMIN_ONLY,
  },
  {
    action: 'jacket.export.read',
    description: 'Export the whole jacket, PII included, as the dealership administrator',
    resourceType: 'deal_jacket',
    allowedRoles: JACKET_ADMIN_ONLY,
  },
] as const;

export function createJacketActionCatalog(): ActionCatalog {
  return createActionCatalog(JACKET_ACTION_DEFINITIONS.map((d) => ({ ...d })));
}
