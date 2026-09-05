/**
 * OUTCOME 7 — RETENTION, EXPORT AND LEGAL HOLD: THE SUPPORT LANE.
 *
 * "…retention, export, and legal holds. Sales staff, managers, customer
 * signers, support actors, and system/provider callbacks must use distinct
 * authority lanes."
 *
 * THE LANE. A salesperson sells and a manager approves; neither decides how
 * long the dealership keeps a signed contract or hands the whole file to
 * counsel. Those are the dealership administrator's acts here — the
 * `tenant_admin` role, and only that role, holds `jacket.hold.write` and
 * `jacket.export.read` — which is what makes the support lane DISTINCT rather
 * than a manager with an extra button.
 *
 * A HOLD IS HISTORY. `legal_hold_events` is append-only: a hold is PLACED and
 * LIFTED as two facts with two reasons and two people, and the boolean on each
 * document is the current answer those facts add up to. Lifting a hold does
 * not erase that it was placed.
 *
 * RETENTION IS COMPUTED, NOT DECIDED HERE. Every document names the policy
 * version it was rendered under; the retention view adds the days and says
 * when each document's retention runs out and whether a hold stops the clock.
 * NOTHING HERE DISPOSES OF ANYTHING: disposal is a later phase's act, and this
 * one says so rather than pretending a countdown deletes files.
 *
 * AN EXPORT IS THE WHOLE FILE, PII INCLUDED, and it is recorded as a mutation
 * against the jacket so the export itself is in the audit trail.
 */
import { withTenantTransaction, type Executor } from '@dealer/database';
import { recordMutation, requireActor, type MutationResult } from '@dealer/identity-access';

import {
  documentsOfPackageWithin,
  fieldsOfPackageWithin,
  PACKAGE_COLUMNS,
  mapPackage,
  type DocumentView,
  type PackageView,
} from './assembly';
import { checklistWithin } from './checklist';
import {
  ceremonyOfPackageWithin,
  signersOfCeremonyWithin,
  type CeremonyView,
  type SignerView,
} from './ceremony';
import {
  requireJacketWithin,
  sourceBindingsWithin,
  type JacketView,
  type SourceBinding,
} from './intake';

interface Row {
  [key: string]: unknown;
}

export interface LegalHoldEvent {
  readonly holdEventId: string;
  readonly action: 'placed' | 'lifted';
  readonly reason: string;
  readonly reference: string | null;
  readonly actedByUserLinkId: string;
  readonly occurredAt: string;
}

export async function legalHoldEventsWithin(
  executor: Executor,
  tenantId: string,
  jacketId: string,
): Promise<LegalHoldEvent[]> {
  const found = await executor.query(
    `SELECT hold_event_id, action, reason, reference, acted_by_user_link_id, occurred_at
       FROM legal_hold_events WHERE tenant_id = $1 AND jacket_id = $2 ORDER BY occurred_at, hold_event_id`,
    [tenantId, jacketId],
  );
  return found.rows.map((x) => {
    const r = x as Row;
    return {
      holdEventId: String(r.hold_event_id),
      action: String(r.action) as 'placed' | 'lifted',
      reason: String(r.reason),
      reference: r.reference === null ? null : String(r.reference),
      actedByUserLinkId: String(r.acted_by_user_link_id),
      occurredAt: new Date(String(r.occurred_at)).toISOString(),
    };
  });
}

export type HoldOutcome =
  | { outcome: 'recorded'; jacket: JacketView; documentsAffected: number; mutation: MutationResult }
  | { outcome: 'already_there'; jacket: JacketView }
  | { outcome: 'version_conflict'; currentVersion: number }
  | { outcome: 'invalid'; error: string }
  | { outcome: 'not_found' };

async function currentlyHeld(
  executor: Executor,
  tenantId: string,
  jacketId: string,
): Promise<boolean> {
  const last = await executor.query(
    `SELECT action FROM legal_hold_events WHERE tenant_id = $1 AND jacket_id = $2
      ORDER BY occurred_at DESC, hold_event_id DESC LIMIT 1`,
    [tenantId, jacketId],
  );
  return last.rows.length > 0 && String((last.rows[0] as Row).action) === 'placed';
}

async function moveHold(
  input: {
    actingUserLinkId: string;
    tenantId: string;
    jacketId: string;
    reason: string;
    reference: string | null;
    expectedVersion: number;
  },
  action: 'placed' | 'lifted',
): Promise<HoldOutcome> {
  return withTenantTransaction(input.tenantId, async (tx) => {
    const actor = await requireActor(tx, input.actingUserLinkId);
    const jacket = await requireJacketWithin(tx, input.tenantId, actor, input.jacketId);
    if (jacket === null) return { outcome: 'not_found' };
    const held = await currentlyHeld(tx, input.tenantId, jacket.jacketId);
    if ((action === 'placed') === held) return { outcome: 'already_there', jacket };
    if (input.reason.trim().length === 0) {
      return { outcome: 'invalid', error: `a hold is ${action} for a stated reason` };
    }
    if (jacket.authorizationVersion !== input.expectedVersion) {
      return { outcome: 'version_conflict', currentVersion: jacket.authorizationVersion };
    }
    await tx.query(
      `INSERT INTO legal_hold_events (tenant_id, jacket_id, action, reason, reference, acted_by_user_link_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [input.tenantId, jacket.jacketId, action, input.reason.slice(0, 500), input.reference, actor],
    );
    const flagged = await tx.query(
      `UPDATE package_documents d SET legal_hold = $3
         FROM jacket_packages p
        WHERE d.tenant_id = $1 AND p.tenant_id = d.tenant_id AND p.package_id = d.package_id
          AND p.jacket_id = $2`,
      [input.tenantId, jacket.jacketId, action === 'placed'],
    );
    const bumped = await tx.query(
      `UPDATE deal_jackets SET updated_at = NOW(), authorization_version = authorization_version + 1
        WHERE tenant_id = $1 AND jacket_id = $2 AND authorization_version = $3
        RETURNING authorization_version`,
      [input.tenantId, jacket.jacketId, input.expectedVersion],
    );
    if (bumped.rows.length === 0) {
      return { outcome: 'version_conflict', currentVersion: jacket.authorizationVersion + 1 };
    }
    const view: JacketView = {
      ...jacket,
      authorizationVersion: Number((bumped.rows[0] as Row).authorization_version),
    };
    const mutation = await recordMutation(tx, {
      tenantId: input.tenantId,
      entityType: 'deal_jacket',
      entityId: view.jacketId,
      eventType: action === 'placed' ? 'jacket.legal_hold.placed' : 'jacket.legal_hold.lifted',
      actingUserLinkId: actor,
      authorizationVersion: view.authorizationVersion,
      details: { documents_affected: flagged.rowCount ?? 0, reference: input.reference },
    });
    return {
      outcome: 'recorded',
      jacket: view,
      documentsAffected: flagged.rowCount ?? 0,
      mutation,
    };
  });
}

export async function placeLegalHold(input: {
  actingUserLinkId: string;
  tenantId: string;
  jacketId: string;
  reason: string;
  reference: string | null;
  expectedVersion: number;
}): Promise<HoldOutcome> {
  return moveHold(input, 'placed');
}

export async function liftLegalHold(input: {
  actingUserLinkId: string;
  tenantId: string;
  jacketId: string;
  reason: string;
  reference: string | null;
  expectedVersion: number;
}): Promise<HoldOutcome> {
  return moveHold(input, 'lifted');
}

export interface RetentionLine {
  readonly documentId: string;
  readonly packageVersionNo: number;
  readonly title: string;
  readonly retentionPolicyCode: string;
  readonly retentionPolicyVersion: number;
  readonly retainForDays: number;
  readonly renderedAt: string;
  readonly retainUntil: string;
  readonly legalHold: boolean;
  /** What happens when retention runs out: in this phase, nothing yet. */
  readonly disposal: 'NOT_YET_AVAILABLE';
}

export async function retentionLinesWithin(
  executor: Executor,
  tenantId: string,
  jacketId: string,
): Promise<RetentionLine[]> {
  const found = await executor.query(
    `SELECT d.document_id, p.version_no, d.title, d.retention_policy_code, d.retention_policy_version,
            rp.retain_for_days, d.rendered_at, d.legal_hold
       FROM package_documents d
       JOIN jacket_packages p ON p.tenant_id = d.tenant_id AND p.package_id = d.package_id
       JOIN retention_policies rp
         ON rp.tenant_id = d.tenant_id AND rp.retention_policy_id = d.retention_policy_id
      WHERE d.tenant_id = $1 AND p.jacket_id = $2
      ORDER BY p.version_no, d.sequence_no`,
    [tenantId, jacketId],
  );
  return found.rows.map((x) => {
    const r = x as Row;
    const renderedAt = new Date(String(r.rendered_at));
    const days = Number(r.retain_for_days);
    return {
      documentId: String(r.document_id),
      packageVersionNo: Number(r.version_no),
      title: String(r.title),
      retentionPolicyCode: String(r.retention_policy_code),
      retentionPolicyVersion: Number(r.retention_policy_version),
      retainForDays: days,
      renderedAt: renderedAt.toISOString(),
      retainUntil: new Date(renderedAt.getTime() + days * 86_400_000).toISOString(),
      legalHold: r.legal_hold === true,
      disposal: 'NOT_YET_AVAILABLE',
    };
  });
}

export interface JacketExport {
  readonly exported_at: string;
  readonly exported_by_user_link_id: string;
  readonly jacket: JacketView;
  readonly bindings: readonly SourceBinding[];
  readonly checklist: unknown;
  readonly packages: readonly {
    readonly package: PackageView;
    readonly fields: unknown;
    readonly documents: readonly DocumentView[];
    readonly ceremony: CeremonyView | null;
    readonly signers: readonly SignerView[];
  }[];
  readonly legal_holds: readonly LegalHoldEvent[];
  readonly retention: readonly RetentionLine[];
}

export type ExportOutcome =
  | { outcome: 'exported'; export: JacketExport; mutation: MutationResult }
  | { outcome: 'not_found' };

/** The whole file, for the administrator who is entitled to hand it over. */
export async function exportJacket(input: {
  actingUserLinkId: string;
  tenantId: string;
  jacketId: string;
}): Promise<ExportOutcome> {
  return withTenantTransaction(input.tenantId, async (tx) => {
    const actor = await requireActor(tx, input.actingUserLinkId);
    const jacket = await requireJacketWithin(tx, input.tenantId, actor, input.jacketId);
    if (jacket === null) return { outcome: 'not_found' };
    const packagesRows = await tx.query(
      `SELECT ${PACKAGE_COLUMNS} FROM jacket_packages WHERE tenant_id = $1 AND jacket_id = $2 ORDER BY version_no`,
      [input.tenantId, jacket.jacketId],
    );
    const packages = [];
    for (const row of packagesRows.rows) {
      const pkg = mapPackage(row as Row);
      const ceremony = await ceremonyOfPackageWithin(tx, input.tenantId, pkg.packageId);
      packages.push({
        package: pkg,
        fields: await fieldsOfPackageWithin(tx, input.tenantId, pkg.packageId),
        documents: await documentsOfPackageWithin(tx, input.tenantId, pkg.packageId),
        ceremony,
        signers:
          ceremony === null
            ? []
            : await signersOfCeremonyWithin(tx, input.tenantId, ceremony.ceremonyId),
      });
    }
    const exportedAt = new Date().toISOString();
    const mutation = await recordMutation(tx, {
      tenantId: input.tenantId,
      entityType: 'deal_jacket',
      entityId: jacket.jacketId,
      eventType: 'jacket.exported',
      actingUserLinkId: actor,
      authorizationVersion: jacket.authorizationVersion,
      details: { packages: packages.length, exported_at: exportedAt },
    });
    return {
      outcome: 'exported',
      export: {
        exported_at: exportedAt,
        exported_by_user_link_id: actor,
        jacket,
        bindings: await sourceBindingsWithin(tx, input.tenantId, jacket.jacketId),
        checklist: await checklistWithin(tx, input.tenantId, jacket.jacketId),
        packages,
        legal_holds: await legalHoldEventsWithin(tx, input.tenantId, jacket.jacketId),
        retention: await retentionLinesWithin(tx, input.tenantId, jacket.jacketId),
      },
      mutation,
    };
  });
}
