/**
 * OUTCOME 6 — THE LIFECYCLE, AND THE THREE MOVES A PERSON MAKES IN IT.
 *
 * "Support coherent states equivalent to draft, review-ready, sent, partially
 * signed, signed-complete, voided, expired, and superseded. Terminal states are
 * absorbing except through explicit versioned supersession."
 *
 *   draft ──► review_ready ──► sent ──► partially_signed ──► signed_complete
 *     │            │            │              │                    │
 *     └────────────┴────────────┴──────────────┴──► voided          └──► superseded
 *                               └──────────────┴──► expired
 *   any live state ──► superseded   (by the NEXT version, in assembly.ts)
 *
 * THREE MOVES LIVE HERE. Marking a package review-ready is the salesperson's
 * act and is BLOCKED by any required checklist item still missing — that is
 * the sentence "missing required items block progression" made into a
 * refusal that names the items. Reviewing is a manager's stamp. Voiding is a
 * manager's decision and takes the ceremony down with it. Sending and signing
 * have their own modules because they carry evidence of their own.
 *
 * The moves not made by a person — expiry by the clock, supersession by the
 * next version — are in `reconcile.ts` and `assembly.ts`.
 */
import { withTenantTransaction, type Executor } from '@dealer/database';
import {
  enqueueAdminOutboxEvent,
  recordMutation,
  requireActor,
  type MutationResult,
} from '@dealer/identity-access';

import {
  PACKAGE_COLUMNS,
  mapPackage,
  requirePackageWithin,
  type PackageState,
  type PackageView,
} from './assembly';
import {
  blockingItems,
  checklistWithin,
  isEligibleManager,
  type ChecklistItemView,
} from './checklist';
import { requireJacketWithin, type JacketView } from './intake';

interface Row {
  [key: string]: unknown;
}

export type MoveOutcome =
  | { outcome: 'moved'; package: PackageView; mutation: MutationResult }
  | { outcome: 'already_there'; package: PackageView }
  | { outcome: 'blocked'; items: readonly ChecklistItemView[] }
  | { outcome: 'version_conflict'; currentVersion: number }
  | { outcome: 'invalid'; error: string }
  | { outcome: 'not_found' };

export async function movePackageWithin(
  executor: Executor,
  input: {
    tenantId: string;
    packageId: string;
    fromStates: readonly PackageState[];
    toState: PackageState;
    reason: string | null;
    expectedVersion: number;
  },
): Promise<{ package: PackageView } | { conflict: true }> {
  const moved = await executor.query(
    `UPDATE jacket_packages
        SET state = $3, state_reason = COALESCE($4, state_reason), updated_at = NOW(),
            authorization_version = authorization_version + 1
      WHERE tenant_id = $1 AND package_id = $2 AND state = ANY($5::text[])
        AND authorization_version = $6
      RETURNING ${PACKAGE_COLUMNS}`,
    [
      input.tenantId,
      input.packageId,
      input.toState,
      input.reason,
      [...input.fromStates],
      input.expectedVersion,
    ],
  );
  if (moved.rows.length === 0) return { conflict: true };
  return { package: mapPackage(moved.rows[0] as Row) };
}

async function recordMove(
  executor: Executor,
  tenantId: string,
  actor: string,
  pkg: PackageView,
  eventType: string,
  details: Record<string, unknown>,
): Promise<MutationResult> {
  const mutation = await recordMutation(executor, {
    tenantId,
    entityType: 'jacket_package',
    entityId: pkg.packageId,
    eventType,
    actingUserLinkId: actor,
    authorizationVersion: pkg.authorizationVersion,
    details: { jacket_id: pkg.jacketId, version_no: pkg.versionNo, state: pkg.state, ...details },
  });
  await enqueueAdminOutboxEvent(executor, {
    tenantId,
    eventType,
    payload: { jacket_id: pkg.jacketId, package_id: pkg.packageId, state: pkg.state },
  });
  return mutation;
}

/** The salesperson says the paperwork is complete. The checklist decides whether it is. */
export async function markReviewReady(input: {
  actingUserLinkId: string;
  tenantId: string;
  packageId: string;
  expectedVersion: number;
}): Promise<MoveOutcome> {
  return withTenantTransaction(input.tenantId, async (tx) => {
    const actor = await requireActor(tx, input.actingUserLinkId);
    const held = await requirePackageWithin(tx, input.tenantId, actor, input.packageId);
    if (held === null) return { outcome: 'not_found' };
    const pkg = held.package;
    if (pkg.state === 'review_ready') return { outcome: 'already_there', package: pkg };
    if (pkg.state !== 'draft') {
      return { outcome: 'invalid', error: `a ${pkg.state} package is not a draft` };
    }
    if (pkg.documentCount === 0 || pkg.packageSha256 === null) {
      return { outcome: 'invalid', error: 'nothing has been rendered into this package' };
    }
    const blocking = blockingItems(await checklistWithin(tx, input.tenantId, pkg.jacketId));
    if (blocking.length > 0) return { outcome: 'blocked', items: blocking };
    if (pkg.authorizationVersion !== input.expectedVersion) {
      return { outcome: 'version_conflict', currentVersion: pkg.authorizationVersion };
    }
    const moved = await movePackageWithin(tx, {
      tenantId: input.tenantId,
      packageId: pkg.packageId,
      fromStates: ['draft'],
      toState: 'review_ready',
      reason: null,
      expectedVersion: input.expectedVersion,
    });
    if ('conflict' in moved)
      return { outcome: 'version_conflict', currentVersion: pkg.authorizationVersion + 1 };
    const mutation = await recordMove(
      tx,
      input.tenantId,
      actor,
      moved.package,
      'jacket.package.review_ready',
      {},
    );
    return { outcome: 'moved', package: moved.package, mutation };
  });
}

/** A manager's stamp on a package that asked for one. It does not move the state. */
export async function reviewPackage(input: {
  actingUserLinkId: string;
  tenantId: string;
  packageId: string;
  expectedVersion: number;
}): Promise<MoveOutcome> {
  return withTenantTransaction(input.tenantId, async (tx) => {
    const actor = await requireActor(tx, input.actingUserLinkId);
    const held = await requirePackageWithin(tx, input.tenantId, actor, input.packageId);
    if (held === null) return { outcome: 'not_found' };
    if (!(await isEligibleManager(tx, input.tenantId, actor, held.jacket.rooftopId))) {
      return { outcome: 'not_found' };
    }
    const pkg = held.package;
    if (pkg.reviewedAt !== null) return { outcome: 'already_there', package: pkg };
    if (pkg.state !== 'draft' && pkg.state !== 'review_ready') {
      return { outcome: 'invalid', error: `a ${pkg.state} package is past review` };
    }
    if (pkg.authorizationVersion !== input.expectedVersion) {
      return { outcome: 'version_conflict', currentVersion: pkg.authorizationVersion };
    }
    const stamped = await tx.query(
      `UPDATE jacket_packages
          SET reviewed_by_user_link_id = $3, reviewed_at = NOW(), updated_at = NOW(),
              authorization_version = authorization_version + 1
        WHERE tenant_id = $1 AND package_id = $2 AND authorization_version = $4
        RETURNING ${PACKAGE_COLUMNS}`,
      [input.tenantId, pkg.packageId, actor, input.expectedVersion],
    );
    if (stamped.rows.length === 0) {
      return { outcome: 'version_conflict', currentVersion: pkg.authorizationVersion + 1 };
    }
    const view = mapPackage(stamped.rows[0] as Row);
    const mutation = await recordMove(tx, input.tenantId, actor, view, 'jacket.package.reviewed', {
      carries_unapproved_templates: view.carriesUnapprovedTemplates,
    });
    return { outcome: 'moved', package: view, mutation };
  });
}

/**
 * Void the ceremony a package carries, if it has one that is still open. The
 * signers' links stop answering; what was signed stays signed.
 */
export async function voidCeremonyOfPackageWithin(
  executor: Executor,
  tenantId: string,
  packageId: string,
  reason: string,
): Promise<string | null> {
  const voided = await executor.query(
    `UPDATE signing_ceremonies
        SET state = 'voided', updated_at = NOW(), authorization_version = authorization_version + 1
      WHERE tenant_id = $1 AND package_id = $2 AND state IN ('created', 'sent', 'in_progress')
      RETURNING ceremony_id`,
    [tenantId, packageId],
  );
  if (voided.rows.length === 0) return null;
  const ceremonyId = String((voided.rows[0] as Row).ceremony_id);
  await executor.query(
    `INSERT INTO ceremony_events (tenant_id, ceremony_id, event_type, lane, payload)
     VALUES ($1, $2, 'ceremony.voided', 'staff', $3::jsonb)`,
    [tenantId, ceremonyId, JSON.stringify({ reason })],
  );
  return ceremonyId;
}

/** A manager sets a package aside. Anything signed on it stays signed and stays readable. */
export async function voidPackage(input: {
  actingUserLinkId: string;
  tenantId: string;
  packageId: string;
  reason: string;
  expectedVersion: number;
}): Promise<MoveOutcome> {
  return withTenantTransaction(input.tenantId, async (tx) => {
    const actor = await requireActor(tx, input.actingUserLinkId);
    const held = await requirePackageWithin(tx, input.tenantId, actor, input.packageId);
    if (held === null) return { outcome: 'not_found' };
    if (!(await isEligibleManager(tx, input.tenantId, actor, held.jacket.rooftopId))) {
      return { outcome: 'not_found' };
    }
    const pkg = held.package;
    if (pkg.state === 'voided') return { outcome: 'already_there', package: pkg };
    if (!['draft', 'review_ready', 'sent', 'partially_signed'].includes(pkg.state)) {
      return { outcome: 'invalid', error: `a ${pkg.state} package is final and is not voided` };
    }
    if (input.reason.trim().length === 0) return { outcome: 'invalid', error: 'voiding says why' };
    if (pkg.authorizationVersion !== input.expectedVersion) {
      return { outcome: 'version_conflict', currentVersion: pkg.authorizationVersion };
    }
    const moved = await movePackageWithin(tx, {
      tenantId: input.tenantId,
      packageId: pkg.packageId,
      fromStates: ['draft', 'review_ready', 'sent', 'partially_signed'],
      toState: 'voided',
      reason: `voided: ${input.reason}`.slice(0, 400),
      expectedVersion: input.expectedVersion,
    });
    if ('conflict' in moved)
      return { outcome: 'version_conflict', currentVersion: pkg.authorizationVersion + 1 };
    const ceremonyId = await voidCeremonyOfPackageWithin(
      tx,
      input.tenantId,
      pkg.packageId,
      input.reason,
    );
    const mutation = await recordMove(
      tx,
      input.tenantId,
      actor,
      moved.package,
      'jacket.package.voided',
      {
        ceremony_id: ceremonyId,
      },
    );
    return { outcome: 'moved', package: moved.package, mutation };
  });
}

export type JacketMoveOutcome =
  | { outcome: 'moved'; jacket: JacketView; mutation: MutationResult }
  | { outcome: 'already_there'; jacket: JacketView }
  | { outcome: 'version_conflict'; currentVersion: number }
  | { outcome: 'invalid'; error: string }
  | { outcome: 'not_found' };

/**
 * A manager voids the whole jacket — the move that lets a NEW jacket open from
 * the desk's current approval when the bound version has gone stale. The live
 * package and its ceremony are voided with it; nothing is deleted.
 */
export async function voidJacket(input: {
  actingUserLinkId: string;
  tenantId: string;
  jacketId: string;
  reason: string;
  expectedVersion: number;
}): Promise<JacketMoveOutcome> {
  return withTenantTransaction(input.tenantId, async (tx) => {
    const actor = await requireActor(tx, input.actingUserLinkId);
    const jacket = await requireJacketWithin(tx, input.tenantId, actor, input.jacketId);
    if (jacket === null) return { outcome: 'not_found' };
    if (!(await isEligibleManager(tx, input.tenantId, actor, jacket.rooftopId))) {
      return { outcome: 'not_found' };
    }
    if (jacket.state === 'voided') return { outcome: 'already_there', jacket };
    if (input.reason.trim().length === 0) return { outcome: 'invalid', error: 'voiding says why' };
    if (jacket.authorizationVersion !== input.expectedVersion) {
      return { outcome: 'version_conflict', currentVersion: jacket.authorizationVersion };
    }
    const live = await tx.query(
      `SELECT package_id, authorization_version FROM jacket_packages
        WHERE tenant_id = $1 AND jacket_id = $2
          AND state IN ('draft', 'review_ready', 'sent', 'partially_signed')
        FOR UPDATE`,
      [input.tenantId, jacket.jacketId],
    );
    for (const row of live.rows) {
      const packageId = String((row as Row).package_id);
      await movePackageWithin(tx, {
        tenantId: input.tenantId,
        packageId,
        fromStates: ['draft', 'review_ready', 'sent', 'partially_signed'],
        toState: 'voided',
        reason: `voided with the jacket: ${input.reason}`.slice(0, 400),
        expectedVersion: Number((row as Row).authorization_version),
      });
      await voidCeremonyOfPackageWithin(tx, input.tenantId, packageId, input.reason);
    }
    const moved = await tx.query(
      `UPDATE deal_jackets
          SET state = 'voided', updated_at = NOW(), authorization_version = authorization_version + 1
        WHERE tenant_id = $1 AND jacket_id = $2 AND authorization_version = $3
        RETURNING jacket_id`,
      [input.tenantId, jacket.jacketId, input.expectedVersion],
    );
    if (moved.rows.length === 0) {
      return { outcome: 'version_conflict', currentVersion: jacket.authorizationVersion + 1 };
    }
    const view: JacketView = {
      ...jacket,
      state: 'voided',
      authorizationVersion: jacket.authorizationVersion + 1,
    };
    const mutation = await recordMutation(tx, {
      tenantId: input.tenantId,
      entityType: 'deal_jacket',
      entityId: view.jacketId,
      eventType: 'jacket.voided',
      actingUserLinkId: actor,
      authorizationVersion: view.authorizationVersion,
      details: { desking_case_id: view.deskingCaseId, reason: input.reason.slice(0, 400) },
    });
    await enqueueAdminOutboxEvent(tx, {
      tenantId: input.tenantId,
      eventType: 'jacket.voided',
      payload: { jacket_id: view.jacketId, desking_case_id: view.deskingCaseId },
    });
    return { outcome: 'moved', jacket: view, mutation };
  });
}
