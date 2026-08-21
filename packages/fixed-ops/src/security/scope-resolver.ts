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
 */
import { query } from '@dealer/database';
import type { OrganizationNodeRef, ResourceScopeResolver } from '@dealer/identity-access';

interface Row {
  [key: string]: unknown;
}

export const resolveServiceResourceScope: ResourceScopeResolver = async (
  tenantId: string,
  resourceType: string,
  resourceId: string,
): Promise<OrganizationNodeRef | null> => {
  const result = await query(`SELECT resource_org_leaf($1, $2, $3) AS leaf`, [
    tenantId,
    resourceType,
    resourceId,
  ]);
  const leaf = (result.rows[0] as Row | undefined)?.leaf;
  if (leaf === null || leaf === undefined) return null;
  return { level: 'rooftop', id: String(leaf) };
};
