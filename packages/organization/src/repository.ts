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

export async function createTenant(input: {
  name: string;
  tenantId?: string;
  status?: TenantStatus;
}): Promise<Tenant> {
  const result = await query(
    `INSERT INTO tenants (tenant_id, name, status)
     VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, COALESCE($3, 'pending_configuration'))
     RETURNING *`,
    [input.tenantId ?? null, input.name, input.status ?? null],
  );
  return mapTenant(result.rows[0] as Row);
}

export async function getTenant(tenantId: string): Promise<Tenant | null> {
  const result = await query(`SELECT * FROM tenants WHERE tenant_id = $1`, [tenantId]);
  return result.rows.length > 0 ? mapTenant(result.rows[0] as Row) : null;
}

export async function setTenantStatus(
  tenantId: string,
  status: TenantStatus,
): Promise<Tenant | null> {
  const result = await query(`UPDATE tenants SET status = $2 WHERE tenant_id = $1 RETURNING *`, [
    tenantId,
    status,
  ]);
  return result.rows.length > 0 ? mapTenant(result.rows[0] as Row) : null;
}

export async function createDealerGroup(input: {
  tenantId: string;
  name: string;
  status?: OrgUnitStatus;
}): Promise<DealerGroup> {
  const result = await query(
    `INSERT INTO dealer_groups (tenant_id, name, status)
     VALUES ($1, $2, COALESCE($3, 'pending_configuration')) RETURNING *`,
    [input.tenantId, input.name, input.status ?? null],
  );
  return mapDealerGroup(result.rows[0] as Row);
}

export async function createLegalEntity(input: {
  tenantId: string;
  dealerGroupId: string;
  name: string;
  status?: OrgUnitStatus;
}): Promise<LegalEntity> {
  const result = await query(
    `INSERT INTO legal_entities (tenant_id, dealer_group_id, name, status)
     VALUES ($1, $2, $3, COALESCE($4, 'pending_configuration')) RETURNING *`,
    [input.tenantId, input.dealerGroupId, input.name, input.status ?? null],
  );
  return mapLegalEntity(result.rows[0] as Row);
}

export async function createRooftop(input: {
  tenantId: string;
  legalEntityId: string;
  name: string;
  rooftopId?: string;
  status?: OrgUnitStatus;
}): Promise<Rooftop> {
  const result = await query(
    `INSERT INTO rooftops (rooftop_id, tenant_id, legal_entity_id, name, status)
     VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, COALESCE($5, 'pending_configuration'))
     RETURNING *`,
    [
      input.rooftopId ?? null,
      input.tenantId,
      input.legalEntityId,
      input.name,
      input.status ?? null,
    ],
  );
  return mapRooftop(result.rows[0] as Row);
}

export async function createDepartment(input: {
  tenantId: string;
  rooftopId: string;
  code: string;
  name: string;
  status?: OrgUnitStatus;
}): Promise<Department> {
  const result = await query(
    `INSERT INTO departments (tenant_id, rooftop_id, code, name, status)
     VALUES ($1, $2, $3, $4, COALESCE($5, 'pending_configuration')) RETURNING *`,
    [input.tenantId, input.rooftopId, input.code, input.name, input.status ?? null],
  );
  return mapDepartment(result.rows[0] as Row);
}

export async function listRooftops(tenantId: string): Promise<Rooftop[]> {
  const result = await query(
    `SELECT * FROM rooftops WHERE tenant_id = $1 ORDER BY created_at, rooftop_id`,
    [tenantId],
  );
  return (result.rows as Row[]).map(mapRooftop);
}

const UNIT_TABLES: Record<Exclude<OrganizationLevel, 'tenant'>, { table: string; pk: string }> = {
  dealer_group: { table: 'dealer_groups', pk: 'dealer_group_id' },
  legal_entity: { table: 'legal_entities', pk: 'legal_entity_id' },
  rooftop: { table: 'rooftops', pk: 'rooftop_id' },
  department: { table: 'departments', pk: 'department_id' },
};

/** Status transition for any non-tenant node. There is no delete. */
export async function setUnitStatus(
  level: Exclude<OrganizationLevel, 'tenant'>,
  tenantId: string,
  id: string,
  status: OrgUnitStatus,
): Promise<boolean> {
  const { table, pk } = UNIT_TABLES[level];
  const result = await query(
    `UPDATE ${table} SET status = $3 WHERE tenant_id = $1 AND ${pk} = $2`,
    [tenantId, id, status],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Resolves the full ancestor chain of a node, tenant first, node last —
 * the shape the policy engine consumes for descendant-covering scope checks.
 * Returns null when the node does not exist IN THIS TENANT (a cross-tenant id
 * is indistinguishable from a nonexistent one, by design).
 */
export async function resolveAncestry(
  tenantId: string,
  ref: OrganizationNodeRef,
): Promise<OrganizationNodeRef[] | null> {
  switch (ref.level) {
    case 'tenant': {
      if (ref.id !== tenantId) return null;
      const t = await query(`SELECT tenant_id FROM tenants WHERE tenant_id = $1`, [tenantId]);
      return t.rows.length > 0 ? [{ level: 'tenant', id: tenantId }] : null;
    }
    case 'dealer_group': {
      const r = await query(
        `SELECT dealer_group_id FROM dealer_groups WHERE tenant_id = $1 AND dealer_group_id = $2`,
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
        `SELECT dealer_group_id FROM legal_entities WHERE tenant_id = $1 AND legal_entity_id = $2`,
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
          WHERE rt.tenant_id = $1 AND rt.rooftop_id = $2`,
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
          WHERE d.tenant_id = $1 AND d.department_id = $2`,
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
