/**
 * The canonical organization hierarchy (FBL-020, migration 055).
 *
 * Tenant -> DealerGroup -> LegalEntity -> Rooftop -> Department. The internal
 * Tenant is the authoritative business/data-ownership boundary; the WorkOS
 * Organization is only an external authentication mapping owned by
 * @dealer/identity-access. Nothing here is ever hard-deleted: retirement is
 * status = 'archived' plus the effective window.
 */

export const ORGANIZATION_LEVELS = [
  'tenant',
  'dealer_group',
  'legal_entity',
  'rooftop',
  'department',
] as const;
export type OrganizationLevel = (typeof ORGANIZATION_LEVELS)[number];

export type TenantStatus = 'pending_configuration' | 'active' | 'suspended' | 'archived';
export type OrgUnitStatus = 'pending_configuration' | 'active' | 'inactive' | 'archived';

interface EffectiveWindow {
  status: string;
  effectiveFrom: Date;
  effectiveTo: Date | null;
}

export interface Tenant extends EffectiveWindow {
  tenantId: string;
  name: string;
  status: TenantStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface DealerGroup extends EffectiveWindow {
  dealerGroupId: string;
  tenantId: string;
  name: string;
  status: OrgUnitStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface LegalEntity extends EffectiveWindow {
  legalEntityId: string;
  tenantId: string;
  dealerGroupId: string;
  name: string;
  status: OrgUnitStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface Rooftop extends EffectiveWindow {
  rooftopId: string;
  tenantId: string;
  legalEntityId: string;
  name: string;
  status: OrgUnitStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface Department extends EffectiveWindow {
  departmentId: string;
  tenantId: string;
  rooftopId: string;
  code: string;
  name: string;
  status: OrgUnitStatus;
  createdAt: Date;
  updatedAt: Date;
}

/** A (level, id) reference to one node in the hierarchy. */
export interface OrganizationNodeRef {
  level: OrganizationLevel;
  id: string;
}

/** tenant -> null; department -> rooftop; etc. */
export function parentLevel(level: OrganizationLevel): OrganizationLevel | null {
  const idx = ORGANIZATION_LEVELS.indexOf(level);
  return idx > 0 ? ORGANIZATION_LEVELS[idx - 1]! : null;
}

/** tenant -> dealer_group; department -> null; etc. */
export function childLevel(level: OrganizationLevel): OrganizationLevel | null {
  const idx = ORGANIZATION_LEVELS.indexOf(level);
  return idx >= 0 && idx < ORGANIZATION_LEVELS.length - 1 ? ORGANIZATION_LEVELS[idx + 1]! : null;
}

/** True when `maybeAncestor` is at or above `level` in the hierarchy. */
export function isAtOrAbove(maybeAncestor: OrganizationLevel, level: OrganizationLevel): boolean {
  return ORGANIZATION_LEVELS.indexOf(maybeAncestor) <= ORGANIZATION_LEVELS.indexOf(level);
}

/**
 * Effective-status resolution: a node counts only while its status is 'active'
 * AND `at` falls inside [effective_from, effective_to). Pending, inactive,
 * suspended and archived nodes are all ineffective — deny-by-default extends
 * to organization state.
 */
export function isEffectiveAt(node: EffectiveWindow, at: Date): boolean {
  if (node.status !== 'active') return false;
  if (at < node.effectiveFrom) return false;
  if (node.effectiveTo !== null && at >= node.effectiveTo) return false;
  return true;
}
