/**
 * Organization repositories over the migration-055 tables. All reads and
 * writes are tenant-scoped; parent edges are validated structurally by the
 * composite (tenant_id, parent_id) foreign keys, so a cross-tenant parent is a
 * database error, not a code-review hope. There is no delete anywhere —
 * retirement is a status transition.
 */
import { query } from '@dealer/database';
import type {
  DealerGroup,
  Department,
  LegalEntity,
  OrganizationLevel,
  OrganizationNodeRef,
  OrgUnitStatus,
  Rooftop,
  Tenant,
  TenantStatus,
} from './model';

interface Row {
  [key: string]: unknown;
}

function ts(v: unknown): Date {
  return v instanceof Date ? v : new Date(String(v));
}

function tsOrNull(v: unknown): Date | null {
  return v === null || v === undefined ? null : ts(v);
}

function mapTenant(r: Row): Tenant {
  return {
    tenantId: String(r.tenant_id),
    name: String(r.name),
    status: String(r.status) as TenantStatus,
    effectiveFrom: ts(r.effective_from),
    effectiveTo: tsOrNull(r.effective_to),
    createdAt: ts(r.created_at),
    updatedAt: ts(r.updated_at),
  };
}

function mapDealerGroup(r: Row): DealerGroup {
  return {
    dealerGroupId: String(r.dealer_group_id),
    tenantId: String(r.tenant_id),
    name: String(r.name),
    status: String(r.status) as OrgUnitStatus,
    effectiveFrom: ts(r.effective_from),
    effectiveTo: tsOrNull(r.effective_to),
    createdAt: ts(r.created_at),
    updatedAt: ts(r.updated_at),
  };
}

function mapLegalEntity(r: Row): LegalEntity {
  return {
    legalEntityId: String(r.legal_entity_id),
    tenantId: String(r.tenant_id),
    dealerGroupId: String(r.dealer_group_id),
    name: String(r.name),
    status: String(r.status) as OrgUnitStatus,
    effectiveFrom: ts(r.effective_from),
    effectiveTo: tsOrNull(r.effective_to),
    createdAt: ts(r.created_at),
    updatedAt: ts(r.updated_at),
  };
}

function mapRooftop(r: Row): Rooftop {
  return {
    rooftopId: String(r.rooftop_id),
    tenantId: String(r.tenant_id),
    legalEntityId: String(r.legal_entity_id),
    name: String(r.name),
    status: String(r.status) as OrgUnitStatus,
    effectiveFrom: ts(r.effective_from),
    effectiveTo: tsOrNull(r.effective_to),
    createdAt: ts(r.created_at),
    updatedAt: ts(r.updated_at),
  };
}

function mapDepartment(r: Row): Department {
  return {
    departmentId: String(r.department_id),
    tenantId: String(r.tenant_id),
    rooftopId: String(r.rooftop_id),
    code: String(r.code),
    name: String(r.name),
    status: String(r.status) as OrgUnitStatus,
    effectiveFrom: ts(r.effective_from),
    effectiveTo: tsOrNull(r.effective_to),
    createdAt: ts(r.created_at),
    updatedAt: ts(r.updated_at),
  };
}

/**
 * FBL-020-R4 §5 — THE WRITES ARE GONE FROM THIS MODULE, AND THEIR ABSENCE IS THE
 * CORRECTION.
 *
 * Until this revision it exported seven production writes — `createTenant`,
 * `setTenantStatus`, `createDealerGroup`, `createLegalEntity`, `createRooftop`,
 * `createDepartment` and `setUnitStatus` — and not one of them named an acting
 * user, advanced `authorization_version`, or wrote an audit row.
 *
 * They were not incidental bookkeeping. `resolveAncestry` below denies any decision
 * whose chain contains an ineffective node, so `setUnitStatus(..., 'archived')`
 * revoked the reach of every role binding scoped at or beneath that node: a mass
 * revocation performed by nobody, recorded nowhere, and invisible to the
 * `authorization_version` that policy evidence is written against. Creating a node
 * `active` was the same act in reverse.
 *
 * The attributed replacements live in `@dealer/identity-access`:
 *
 *     createTenant / setTenantStatus       ->  createOrganization /
 *                                              changeOrganizationStatus
 *     create{DealerGroup,LegalEntity,
 *            Rooftop,Department}           ->  createOrganizationUnit
 *     setUnitStatus                        ->  changeOrganizationUnitStatus
 *
 * They cannot live HERE, for a structural reason rather than a stylistic one: the
 * attribution contract needs `requireActor` and the transactional audit writer, both
 * of which live in identity-access, and identity-access already depends on this
 * package (the policy engine calls `resolveAncestry`). An edge back would be a
 * cycle. So this module keeps what it can honestly own — the row shapes, the
 * effectiveness rule and the READS — and the writes sit beside the actor contract
 * they have to satisfy. `scripts/check-owned-mutations.ts` fails the build if one
 * ever reappears here.
 */
export async function getTenant(tenantId: string): Promise<Tenant | null> {
  const result = await query(`SELECT * FROM tenants WHERE tenant_id = $1`, [tenantId]);
  return result.rows.length > 0 ? mapTenant(result.rows[0] as Row) : null;
}

export async function listRooftops(tenantId: string): Promise<Rooftop[]> {
  const result = await query(
    `SELECT * FROM rooftops WHERE tenant_id = $1 ORDER BY created_at, rooftop_id`,
    [tenantId],
  );
  return (result.rows as Row[]).map(mapRooftop);
}

/**
 * One organization unit as stored, or null when this tenant has no such node.
 *
 * A READ, and it exists because the writes left: a caller that used to learn a
 * node's status from the row a write returned now asks for it. Per-level statements
 * rather than an interpolated table name, so every reference to these tables is
 * greppable and statically visible.
 */
export async function getUnit(
  level: Exclude<OrganizationLevel, 'tenant'>,
  tenantId: string,
  id: string,
): Promise<DealerGroup | LegalEntity | Rooftop | Department | null> {
  switch (level) {
    case 'dealer_group': {
      const r = await query(
        `SELECT * FROM dealer_groups WHERE tenant_id = $1 AND dealer_group_id = $2`,
        [tenantId, id],
      );
      return r.rows.length > 0 ? mapDealerGroup(r.rows[0] as Row) : null;
    }
    case 'legal_entity': {
      const r = await query(
        `SELECT * FROM legal_entities WHERE tenant_id = $1 AND legal_entity_id = $2`,
        [tenantId, id],
      );
      return r.rows.length > 0 ? mapLegalEntity(r.rows[0] as Row) : null;
    }
    case 'rooftop': {
      const r = await query(`SELECT * FROM rooftops WHERE tenant_id = $1 AND rooftop_id = $2`, [
        tenantId,
        id,
      ]);
      return r.rows.length > 0 ? mapRooftop(r.rows[0] as Row) : null;
    }
    case 'department': {
      const r = await query(
        `SELECT * FROM departments WHERE tenant_id = $1 AND department_id = $2`,
        [tenantId, id],
      );
      return r.rows.length > 0 ? mapDepartment(r.rows[0] as Row) : null;
    }
  }
}

/**
 * A node authorizes only while it is EFFECTIVE: status 'active' and now
 * inside [effective_from, effective_to). Archiving a rooftop therefore
 * revokes every binding scoped to it, and a backfilled
 * 'pending_configuration' node authorizes nothing until it is deliberately
 * activated — which is exactly what migration 055's header promises.
 */
const EFFECTIVE = (alias: string): string =>
  `${alias}.status = 'active' AND ${alias}.effective_from <= NOW() ` +
  `AND (${alias}.effective_to IS NULL OR ${alias}.effective_to > NOW())`;

/**
 * Resolves the full ancestor chain of a node, tenant first, node last —
 * the shape the policy engine consumes for descendant-covering scope checks.
 * EVERY level of the chain must be effective; one archived ancestor breaks
 * the chain and the policy engine denies.
 *
 * Returns null when the node does not exist IN THIS TENANT, or is not
 * effective (a cross-tenant id, a nonexistent one and a retired one are
 * deliberately indistinguishable).
 */
export async function resolveAncestry(
  tenantId: string,
  ref: OrganizationNodeRef,
): Promise<OrganizationNodeRef[] | null> {
  switch (ref.level) {
    case 'tenant': {
      if (ref.id !== tenantId) return null;
      const t = await query(
        `SELECT tenant_id FROM tenants WHERE tenant_id = $1 AND ${EFFECTIVE('tenants')}`,
        [tenantId],
      );
      return t.rows.length > 0 ? [{ level: 'tenant', id: tenantId }] : null;
    }
    case 'dealer_group': {
      const r = await query(
        `SELECT dealer_group_id FROM dealer_groups
          WHERE tenant_id = $1 AND dealer_group_id = $2 AND ${EFFECTIVE('dealer_groups')}`,
        [tenantId, ref.id],
      );
      if (r.rows.length === 0) return null;
      return [
        { level: 'tenant', id: tenantId },
        { level: 'dealer_group', id: ref.id },
      ];
    }
    case 'legal_entity': {
      const r = await query(
        `SELECT le.dealer_group_id FROM legal_entities le
           JOIN dealer_groups g
             ON g.tenant_id = le.tenant_id AND g.dealer_group_id = le.dealer_group_id
          WHERE le.tenant_id = $1 AND le.legal_entity_id = $2
            AND ${EFFECTIVE('le')} AND ${EFFECTIVE('g')}`,
        [tenantId, ref.id],
      );
      if (r.rows.length === 0) return null;
      return [
        { level: 'tenant', id: tenantId },
        { level: 'dealer_group', id: String((r.rows[0] as Row).dealer_group_id) },
        { level: 'legal_entity', id: ref.id },
      ];
    }
    case 'rooftop': {
      const r = await query(
        `SELECT rt.legal_entity_id, le.dealer_group_id
           FROM rooftops rt
           JOIN legal_entities le
             ON le.tenant_id = rt.tenant_id AND le.legal_entity_id = rt.legal_entity_id
           JOIN dealer_groups g
             ON g.tenant_id = le.tenant_id AND g.dealer_group_id = le.dealer_group_id
          WHERE rt.tenant_id = $1 AND rt.rooftop_id = $2
            AND ${EFFECTIVE('rt')} AND ${EFFECTIVE('le')} AND ${EFFECTIVE('g')}`,
        [tenantId, ref.id],
      );
      if (r.rows.length === 0) return null;
      const row = r.rows[0] as Row;
      return [
        { level: 'tenant', id: tenantId },
        { level: 'dealer_group', id: String(row.dealer_group_id) },
        { level: 'legal_entity', id: String(row.legal_entity_id) },
        { level: 'rooftop', id: ref.id },
      ];
    }
    case 'department': {
      const r = await query(
        `SELECT d.rooftop_id, rt.legal_entity_id, le.dealer_group_id
           FROM departments d
           JOIN rooftops rt ON rt.tenant_id = d.tenant_id AND rt.rooftop_id = d.rooftop_id
           JOIN legal_entities le
             ON le.tenant_id = rt.tenant_id AND le.legal_entity_id = rt.legal_entity_id
           JOIN dealer_groups g
             ON g.tenant_id = le.tenant_id AND g.dealer_group_id = le.dealer_group_id
          WHERE d.tenant_id = $1 AND d.department_id = $2
            AND ${EFFECTIVE('d')} AND ${EFFECTIVE('rt')} AND ${EFFECTIVE('le')} AND ${EFFECTIVE('g')}`,
        [tenantId, ref.id],
      );
      if (r.rows.length === 0) return null;
      const row = r.rows[0] as Row;
      return [
        { level: 'tenant', id: tenantId },
        { level: 'dealer_group', id: String(row.dealer_group_id) },
        { level: 'legal_entity', id: String(row.legal_entity_id) },
        { level: 'rooftop', id: String(row.rooftop_id) },
        { level: 'department', id: ref.id },
      ];
    }
  }
}
