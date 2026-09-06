/**
 * OUTCOME 2 — THE CHECKLIST, AND WHAT IT TAKES TO WAIVE A LINE OF IT.
 *
 * "Missing required items block progression. Any permitted waiver requires
 * authorized actor, reason, policy version, and evidence."
 *
 * A checklist item is resolved from configuration when the jacket opens
 * (`intake.ts`) and copies the requirement's code, version and source, so the
 * jacket can always say what it was measured against. An item satisfied by a
 * DOCUMENT is marked by the assembler when it renders that document; an item
 * satisfied by EVIDENCE is marked here, by the person who holds the evidence.
 *
 * A WAIVER IS FOUR THINGS OR IT IS NOTHING. `ck_checklist_waiver_complete`
 * refuses a waived row that lacks any of who, why, under which policy version,
 * and with what evidence — and refuses a waiver on a requirement that was not
 * configured as waivable in the first place. The service checks the same four
 * things first, with better words; the constraint is what holds when the
 * service is stepped round.
 *
 * ONLY A MANAGER WAIVES. A salesperson who could waive the odometer disclosure
 * on their own deal could sell a car without one. The route names a
 * manager-only action; `isEligibleManager` re-checks it at the write.
 */
import { ROLES } from '@dealer/contracts';
import { withTenantTransaction, type Executor } from '@dealer/database';
import {
  EFFECTIVE_ROLE_BINDING_SQL,
  recordMutation,
  requireActor,
  type MutationResult,
} from '@dealer/identity-access';

import { isSha256Hex } from './hashing';
import { requireJacketWithin } from './intake';

interface Row {
  [key: string]: unknown;
}

export type ChecklistState = 'missing' | 'satisfied' | 'waived';

export interface ChecklistItemView {
  readonly itemId: string;
  readonly jacketId: string;
  readonly requirementId: string;
  readonly requirementCode: string;
  readonly requirementVersion: number;
  readonly requirementSource: string;
  readonly required: boolean;
  readonly waivable: boolean;
  readonly satisfiedBy: 'template' | 'evidence';
  readonly templateCode: string | null;
  readonly evidenceKind: string | null;
  readonly state: ChecklistState;
  readonly satisfiedDocumentId: string | null;
  readonly evidenceUri: string | null;
  readonly evidenceSha256: string | null;
  readonly waivedByUserLinkId: string | null;
  readonly waiverReason: string | null;
  readonly waiverPolicyVersion: number | null;
  readonly waiverEvidenceUri: string | null;
  readonly waivedAt: string | null;
  readonly authorizationVersion: number;
}

export const CHECKLIST_COLUMNS = `item_id, jacket_id, requirement_id, requirement_code,
  requirement_version, requirement_source, required, waivable, satisfied_by, template_code,
  evidence_kind, state, satisfied_document_id, evidence_uri, evidence_sha256,
  waived_by_user_link_id, waiver_reason, waiver_policy_version, waiver_evidence_uri, waived_at,
  authorization_version`;

export function mapChecklistItem(row: Row): ChecklistItemView {
  return {
    itemId: String(row.item_id),
    jacketId: String(row.jacket_id),
    requirementId: String(row.requirement_id),
    requirementCode: String(row.requirement_code),
    requirementVersion: Number(row.requirement_version),
    requirementSource: String(row.requirement_source),
    required: row.required === true,
    waivable: row.waivable === true,
    satisfiedBy: String(row.satisfied_by) as 'template' | 'evidence',
    templateCode: row.template_code === null ? null : String(row.template_code),
    evidenceKind: row.evidence_kind === null ? null : String(row.evidence_kind),
    state: String(row.state) as ChecklistState,
    satisfiedDocumentId:
      row.satisfied_document_id === null ? null : String(row.satisfied_document_id),
    evidenceUri: row.evidence_uri === null ? null : String(row.evidence_uri),
    evidenceSha256: row.evidence_sha256 === null ? null : String(row.evidence_sha256),
    waivedByUserLinkId:
      row.waived_by_user_link_id === null ? null : String(row.waived_by_user_link_id),
    waiverReason: row.waiver_reason === null ? null : String(row.waiver_reason),
    waiverPolicyVersion:
      row.waiver_policy_version === null ? null : Number(row.waiver_policy_version),
    waiverEvidenceUri: row.waiver_evidence_uri === null ? null : String(row.waiver_evidence_uri),
    waivedAt: row.waived_at === null ? null : new Date(String(row.waived_at)).toISOString(),
    authorizationVersion: Number(row.authorization_version),
  };
}

export async function checklistWithin(
  executor: Executor,
  tenantId: string,
  jacketId: string,
): Promise<ChecklistItemView[]> {
  const found = await executor.query(
    `SELECT ${CHECKLIST_COLUMNS} FROM jacket_checklist_items
      WHERE tenant_id = $1 AND jacket_id = $2 ORDER BY requirement_code`,
    [tenantId, jacketId],
  );
  return found.rows.map((r) => mapChecklistItem(r as Row));
}

/** The items that stop a package from moving forward: required, and not yet met. */
export function blockingItems(items: readonly ChecklistItemView[]): ChecklistItemView[] {
  return items.filter((i) => i.required && i.state === 'missing');
}

export async function isEligibleManager(
  executor: Executor,
  tenantId: string,
  userLinkId: string,
  rooftopId: string,
): Promise<boolean> {
  const found = await executor.query(
    `SELECT 1
       FROM rooftops r
       JOIN role_bindings rb
         ON rb.tenant_id = r.tenant_id
        AND ${EFFECTIVE_ROLE_BINDING_SQL}
      WHERE r.tenant_id = $1
        AND r.rooftop_id = $2
        AND r.status = 'active'
        AND rb.user_link_id = $3
        AND rb.role = ANY($4::text[])
        AND (
          rb.scope_level = 'tenant'
          OR (rb.scope_level = 'rooftop' AND rb.scope_id = r.rooftop_id)
          OR EXISTS (
            SELECT 1 FROM org_ancestry_all($1, 'rooftop', r.rooftop_id) chain
             WHERE chain.level = rb.scope_level AND chain.node_id = rb.scope_id
          )
        )
      LIMIT 1`,
    [tenantId, rooftopId, userLinkId, [ROLES.SALES_MANAGER, 'tenant_admin']],
  );
  return found.rows.length > 0;
}

export type ChecklistOutcome =
  | { outcome: 'updated'; item: ChecklistItemView; mutation: MutationResult }
  | { outcome: 'already_there'; item: ChecklistItemView }
  | { outcome: 'version_conflict'; currentVersion: number }
  | { outcome: 'invalid'; error: string }
  | { outcome: 'not_found' };

async function loadItemForUpdate(
  executor: Executor,
  tenantId: string,
  jacketId: string,
  itemId: string,
): Promise<ChecklistItemView | null> {
  const found = await executor.query(
    `SELECT ${CHECKLIST_COLUMNS} FROM jacket_checklist_items
      WHERE tenant_id = $1 AND jacket_id = $2 AND item_id = $3 FOR UPDATE`,
    [tenantId, jacketId, itemId],
  );
  return found.rows.length === 0 ? null : mapChecklistItem(found.rows[0] as Row);
}

/**
 * Evidence supplied for an evidence-kind requirement: where it is and what its
 * bytes digest to, so a later reader can check the file has not been swapped.
 */
export async function satisfyWithEvidence(input: {
  actingUserLinkId: string;
  tenantId: string;
  jacketId: string;
  itemId: string;
  evidenceUri: string;
  evidenceSha256: string;
  expectedVersion: number;
}): Promise<ChecklistOutcome> {
  return withTenantTransaction(input.tenantId, async (tx) => {
    const actor = await requireActor(tx, input.actingUserLinkId);
    const jacket = await requireJacketWithin(tx, input.tenantId, actor, input.jacketId);
    if (jacket === null) return { outcome: 'not_found' };
    const item = await loadItemForUpdate(tx, input.tenantId, input.jacketId, input.itemId);
    if (item === null) return { outcome: 'not_found' };
    if (item.satisfiedBy !== 'evidence') {
      return {
        outcome: 'invalid',
        error: 'this requirement is met by a rendered document, not by evidence',
      };
    }
    if (item.state === 'satisfied' && item.evidenceSha256 === input.evidenceSha256) {
      return { outcome: 'already_there', item };
    }
    if (item.state === 'waived') {
      return { outcome: 'invalid', error: 'this requirement was waived; the waiver stands' };
    }
    if (input.evidenceUri.trim().length === 0 || input.evidenceUri.length > 500) {
      return { outcome: 'invalid', error: 'evidence names where it is' };
    }
    if (!isSha256Hex(input.evidenceSha256)) {
      return { outcome: 'invalid', error: 'evidence names the sha256 of its bytes' };
    }
    if (item.authorizationVersion !== input.expectedVersion) {
      return { outcome: 'version_conflict', currentVersion: item.authorizationVersion };
    }
    const updated = await tx.query(
      `UPDATE jacket_checklist_items
          SET state = 'satisfied', evidence_uri = $4, evidence_sha256 = $5, updated_at = NOW(),
              authorization_version = authorization_version + 1
        WHERE tenant_id = $1 AND jacket_id = $2 AND item_id = $3 AND authorization_version = $6
        RETURNING ${CHECKLIST_COLUMNS}`,
      [
        input.tenantId,
        input.jacketId,
        input.itemId,
        input.evidenceUri,
        input.evidenceSha256,
        input.expectedVersion,
      ],
    );
    if (updated.rows.length === 0) {
      return { outcome: 'version_conflict', currentVersion: item.authorizationVersion + 1 };
    }
    const view = mapChecklistItem(updated.rows[0] as Row);
    const mutation = await recordMutation(tx, {
      tenantId: input.tenantId,
      entityType: 'jacket_checklist_item',
      entityId: view.itemId,
      eventType: 'jacket.checklist.evidence_recorded',
      actingUserLinkId: actor,
      authorizationVersion: view.authorizationVersion,
      details: {
        jacket_id: view.jacketId,
        requirement_code: view.requirementCode,
        requirement_version: view.requirementVersion,
        evidence_sha256: view.evidenceSha256,
      },
    });
    return { outcome: 'updated', item: view, mutation };
  });
}

/** The four things a waiver is, from the person allowed to make one. */
export async function waiveRequirement(input: {
  actingUserLinkId: string;
  tenantId: string;
  jacketId: string;
  itemId: string;
  reason: string;
  policyVersion: number;
  evidenceUri: string;
  expectedVersion: number;
}): Promise<ChecklistOutcome> {
  return withTenantTransaction(input.tenantId, async (tx) => {
    const actor = await requireActor(tx, input.actingUserLinkId);
    const jacket = await requireJacketWithin(tx, input.tenantId, actor, input.jacketId);
    if (jacket === null) return { outcome: 'not_found' };
    // Not an explanation of what they lack — the same answer a jacket they
    // cannot see would give.
    if (!(await isEligibleManager(tx, input.tenantId, actor, jacket.rooftopId))) {
      return { outcome: 'not_found' };
    }
    const item = await loadItemForUpdate(tx, input.tenantId, input.jacketId, input.itemId);
    if (item === null) return { outcome: 'not_found' };
    if (item.state === 'waived') return { outcome: 'already_there', item };
    if (!item.waivable) {
      return {
        outcome: 'invalid',
        error: `${item.requirementCode} (version ${item.requirementVersion}, ${item.requirementSource}) is not a requirement anybody may waive`,
      };
    }
    if (input.reason.trim().length === 0) {
      return { outcome: 'invalid', error: 'a waiver says why' };
    }
    if (!Number.isInteger(input.policyVersion) || input.policyVersion < 1) {
      return {
        outcome: 'invalid',
        error: 'a waiver names the version of the policy that permits it',
      };
    }
    if (input.evidenceUri.trim().length === 0) {
      return { outcome: 'invalid', error: 'a waiver names the evidence it rests on' };
    }
    if (item.authorizationVersion !== input.expectedVersion) {
      return { outcome: 'version_conflict', currentVersion: item.authorizationVersion };
    }
    const updated = await tx.query(
      `UPDATE jacket_checklist_items
          SET state = 'waived', waived_by_user_link_id = $4, waiver_reason = $5,
              waiver_policy_version = $6, waiver_evidence_uri = $7, waived_at = NOW(),
              updated_at = NOW(), authorization_version = authorization_version + 1
        WHERE tenant_id = $1 AND jacket_id = $2 AND item_id = $3 AND authorization_version = $8
        RETURNING ${CHECKLIST_COLUMNS}`,
      [
        input.tenantId,
        input.jacketId,
        input.itemId,
        actor,
        input.reason,
        input.policyVersion,
        input.evidenceUri,
        input.expectedVersion,
      ],
    );
    if (updated.rows.length === 0) {
      return { outcome: 'version_conflict', currentVersion: item.authorizationVersion + 1 };
    }
    const view = mapChecklistItem(updated.rows[0] as Row);
    const mutation = await recordMutation(tx, {
      tenantId: input.tenantId,
      entityType: 'jacket_checklist_item',
      entityId: view.itemId,
      eventType: 'jacket.checklist.waived',
      actingUserLinkId: actor,
      authorizationVersion: view.authorizationVersion,
      details: {
        jacket_id: view.jacketId,
        requirement_code: view.requirementCode,
        requirement_version: view.requirementVersion,
        waiver_policy_version: view.waiverPolicyVersion,
      },
    });
    return { outcome: 'updated', item: view, mutation };
  });
}
