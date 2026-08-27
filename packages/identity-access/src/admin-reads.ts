/**
 * RELEASE TRAIN 1 — read models for the dealership administration surface.
 *
 * The API layer holds no SQL (check-app-sql.ts enforces that boundary); every
 * read the /api/admin routes render lives here, each one running inside a
 * tenant-context transaction so the row-secured tables answer for exactly the
 * caller's dealership. The user/role tables are not row-secured (they are the
 * authorization plumbing itself), but their queries are tenant-predicated and
 * ride the same transaction.
 */
import { withTenantTransaction, type Executor } from '@dealer/database';

interface Row {
  [key: string]: unknown;
}

export interface AdminOverviewCounts {
  readonly tenantName: string | null;
  readonly rooftops: number;
  readonly departments: number;
  readonly activeUsers: number;
  readonly pendingUsers: number;
}

export async function getAdminOverviewCounts(tenantId: string): Promise<AdminOverviewCounts> {
  return withTenantTransaction(tenantId, async (tx) => {
    const r = await tx.query(
      `SELECT
         (SELECT COUNT(*)::int FROM rooftops WHERE tenant_id = $1) AS rooftops,
         (SELECT COUNT(*)::int FROM departments WHERE tenant_id = $1) AS departments,
         (SELECT COUNT(*)::int FROM user_links
           WHERE tenant_id = $1 AND status = 'activated') AS active_users,
         (SELECT COUNT(*)::int FROM user_links
           WHERE tenant_id = $1 AND status = 'pending') AS pending_users,
         (SELECT name FROM tenants WHERE tenant_id = $1) AS tenant_name`,
      [tenantId],
    );
    const row = r.rows[0] as Row;
    return {
      tenantName: row.tenant_name === null ? null : String(row.tenant_name),
      rooftops: Number(row.rooftops),
      departments: Number(row.departments),
      activeUsers: Number(row.active_users),
      pendingUsers: Number(row.pending_users),
    };
  });
}

export interface OrganizationTree {
  readonly dealerGroups: ReadonlyArray<Record<string, unknown>>;
  readonly legalEntities: ReadonlyArray<Record<string, unknown>>;
  readonly rooftops: ReadonlyArray<Record<string, unknown>>;
  readonly departments: ReadonlyArray<Record<string, unknown>>;
}

export async function listOrganizationTree(tenantId: string): Promise<OrganizationTree> {
  return withTenantTransaction(tenantId, async (tx) => {
    const [groups, entities, rooftops, departments] = await Promise.all([
      tx.query(
        `SELECT dealer_group_id, name, status FROM dealer_groups
          WHERE tenant_id = $1 ORDER BY created_at`,
        [tenantId],
      ),
      tx.query(
        `SELECT legal_entity_id, dealer_group_id, name, status FROM legal_entities
          WHERE tenant_id = $1 ORDER BY created_at`,
        [tenantId],
      ),
      tx.query(
        `SELECT rooftop_id, legal_entity_id, name, status FROM rooftops
          WHERE tenant_id = $1 ORDER BY created_at`,
        [tenantId],
      ),
      tx.query(
        `SELECT department_id, rooftop_id, code, name, status FROM departments
          WHERE tenant_id = $1 ORDER BY created_at`,
        [tenantId],
      ),
    ]);
    return {
      dealerGroups: groups.rows as Row[],
      legalEntities: entities.rows as Row[],
      rooftops: rooftops.rows as Row[],
      departments: departments.rows as Row[],
    };
  });
}

/** The status one unit currently carries under this tenant's context, or null. */
export async function getOrganizationUnitStatus(
  tenantId: string,
  level: 'dealer_group' | 'legal_entity' | 'rooftop' | 'department',
  unitId: string,
): Promise<string | null> {
  return withTenantTransaction(tenantId, async (tx) => {
    let r;
    switch (level) {
      case 'dealer_group':
        r = await tx.query(
          `SELECT status FROM dealer_groups WHERE tenant_id = $1 AND dealer_group_id = $2`,
          [tenantId, unitId],
        );
        break;
      case 'legal_entity':
        r = await tx.query(
          `SELECT status FROM legal_entities WHERE tenant_id = $1 AND legal_entity_id = $2`,
          [tenantId, unitId],
        );
        break;
      case 'rooftop':
        r = await tx.query(`SELECT status FROM rooftops WHERE tenant_id = $1 AND rooftop_id = $2`, [
          tenantId,
          unitId,
        ]);
        break;
      case 'department':
        r = await tx.query(
          `SELECT status FROM departments WHERE tenant_id = $1 AND department_id = $2`,
          [tenantId, unitId],
        );
        break;
    }
    return r.rows.length === 0 ? null : String((r.rows[0] as Row).status);
  });
}

export interface TenantUserView {
  readonly userLinkId: string;
  readonly email: string | null;
  readonly displayName: string | null;
  readonly status: string;
  readonly bindings: unknown;
}

export async function listTenantUsers(tenantId: string): Promise<TenantUserView[]> {
  return withTenantTransaction(tenantId, async (tx) => {
    // role-binding-effectiveness-opt-out(all-bindings-including-ineffective):
    // the ADMINISTRATIVE listing must show every STANDING grant — including a
    // binding whose effective window has closed or not yet opened — because
    // those are exactly the rows an administrator needs to see to retire them.
    // `status = 'active'` here means "not revoked" (standing), not "effective";
    // the engine's predicate would hide precisely the rows this roster manages.
    const users = await tx.query(
      `SELECT ul.user_link_id, ul.email, ul.display_name, ul.status,
              COALESCE(
                (SELECT json_agg(json_build_object(
                          'roleBindingId', rb.role_binding_id,
                          'role', rb.role,
                          'scopeLevel', rb.scope_level,
                          'scopeId', rb.scope_id,
                          'status', rb.status)
                        ORDER BY rb.created_at)
                   FROM role_bindings rb
                  WHERE rb.user_link_id = ul.user_link_id
                    AND rb.tenant_id = ul.tenant_id
                    AND rb.status = 'active'),
                '[]'::json) AS bindings
         FROM user_links ul
        WHERE ul.tenant_id = $1
        ORDER BY ul.created_at`,
      [tenantId],
    );
    return (users.rows as Row[]).map((u) => ({
      userLinkId: String(u.user_link_id),
      email: u.email === null ? null : String(u.email),
      displayName: u.display_name === null ? null : String(u.display_name),
      status: String(u.status),
      bindings: u.bindings,
    }));
  });
}

/**
 * Whether this tenant holds this user link — the router's cross-tenant screen.
 * Executor-taking on purpose: the check belongs INSIDE the same transaction as
 * the sensitive command it guards.
 */
export async function tenantHoldsUserLink(
  executor: Executor,
  tenantId: string,
  userLinkId: string,
): Promise<boolean> {
  const r = await executor.query(
    `SELECT 1 FROM user_links WHERE tenant_id = $1 AND user_link_id = $2`,
    [tenantId, userLinkId],
  );
  return r.rows.length > 0;
}

/** Whether this tenant holds this (user, binding) pair, whatever its status. */
export async function tenantHoldsRoleBinding(
  executor: Executor,
  tenantId: string,
  userLinkId: string,
  roleBindingId: string,
): Promise<boolean> {
  // role-binding-effectiveness-opt-out(all-bindings-including-ineffective): an
  // EXISTENCE probe naming one row by id, screening a revocation's target for
  // cross-tenant reach — a revocation must reach bindings the engine already
  // refuses, so filtering by effectiveness here would leave exactly those
  // standing grants unrevokable.
  const r = await executor.query(
    `SELECT 1 FROM role_bindings
      WHERE role_binding_id = $1 AND user_link_id = $2 AND tenant_id = $3`,
    [roleBindingId, userLinkId, tenantId],
  );
  return r.rows.length > 0;
}
