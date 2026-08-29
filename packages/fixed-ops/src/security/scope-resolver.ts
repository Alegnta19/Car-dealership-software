/**
 * Fixed Ops' implementation of the policy engine's ResourceScopeResolver
 * port (FBL-020). Resolves a service resource to the organization node it
 * lives under — its rooftop, via the legacy location_id column, which IS the
 * rooftop id after the migration-055 backfill.
 *
 * FBL-020-R7 §3.4 — THE MAPPING ITSELF NOW LIVES IN THE DATABASE. This module
 * used to own two TypeScript tables of resource types and joins, and migration
 * 059's evidence validator needed the same mapping — which would have been a
 * second authority with nothing holding the two together. `resource_org_leaf`
 * (migration 059) is now the ONE registry; this resolver calls it, the
 * evidence trigger calls it, and neither can disagree with the other about
 * where a resource lives.
 *
 * Every lookup is tenant-scoped inside the function, so a resource from
 * another tenant resolves to null exactly like a resource that does not exist
 * — non-enumeration starts here — and an unknown resource type resolves to
 * nothing: deny, never guess.
 *
 * RT2-C2 §A — THE ENGINE CALLS THE ORDINARY LOOKUP, NOT THE PRIVILEGED ONE.
 *
 * `resource_org_leaf` reads past row security, and this module used to call it
 * on a bare pooled connection with the tenant as an argument — so any holder of
 * the runtime login could name another dealership beside a known resource id
 * and be told which rooftop owned it. RT2-C1 made the function trust
 * `app_tenant_ctx()` instead, which only moved the vector: that GUC is set by
 * the client. EXECUTE on it is now revoked from PUBLIC and held by the evidence
 * owner alone, and the engine resolves through `resource_org_leaf_visible` —
 * SECURITY INVOKER, no tenant argument, bound by the same row security as the
 * session it serves.
 *
 * The transaction still carries the server's tenant context, because that is
 * what row security reads and what the Fixed Ops branches filter on. What
 * changed is that the context is no longer AUTHORITY over a bypass — it is
 * simply the session the lookup happens in, and the lookup can return nothing
 * the session could not already select for itself.
 */
import { withTenantTransaction } from '@dealer/database';
import type { OrganizationNodeRef, ResourceScopeResolver } from '@dealer/identity-access';

interface Row {
  [key: string]: unknown;
}

export const resolveServiceResourceScope: ResourceScopeResolver = async (
  tenantId: string,
  resourceType: string,
  resourceId: string,
): Promise<OrganizationNodeRef | null> => {
  const result = await withTenantTransaction(tenantId, (tx) =>
    tx.query(`SELECT resource_org_leaf_visible($1, $2) AS leaf`, [resourceType, resourceId]),
  );
  const leaf = (result.rows[0] as Row | undefined)?.leaf;
  if (leaf === null || leaf === undefined) return null;
  return { level: 'rooftop', id: String(leaf) };
};
