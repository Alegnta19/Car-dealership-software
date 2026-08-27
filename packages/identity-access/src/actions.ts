/**
 * The identity/organization administration catalog (FBL-020) — actions this
 * package itself owns. Fixed Ops publishes its own service catalog; the two
 * are merged at the application composition root.
 */
import {
  PLATFORM_ADMIN_ROLE,
  PLATFORM_SUPPORT_AUTHORITY_ROLES,
  TENANT_ADMIN_ROLE,
} from './contracts';
import { createActionCatalog, type ActionCatalog } from './policy';

export const IDENTITY_ACTION_DEFINITIONS = [
  {
    action: 'identity.user.provision',
    description: 'Pre-provision a pending user link in the tenant',
    resourceType: null,
    allowedRoles: [TENANT_ADMIN_ROLE],
  },
  {
    action: 'identity.user.deactivate',
    description: 'Deactivate a user link (sessions die at read time)',
    resourceType: null,
    allowedRoles: [TENANT_ADMIN_ROLE],
    sensitive: true,
  },
  {
    action: 'identity.role.grant',
    description: 'Grant a role binding at a scope',
    resourceType: null,
    allowedRoles: [TENANT_ADMIN_ROLE],
    sensitive: true,
  },
  {
    action: 'identity.role.revoke',
    description: 'Revoke a role binding (effective on the next decision)',
    resourceType: null,
    allowedRoles: [TENANT_ADMIN_ROLE],
    sensitive: true,
  },
  {
    action: 'identity.connection.certify_mfa_policy',
    description: "Certify (or withdraw) the organization's MFA policy on a provider connection",
    resourceType: null,
    allowedRoles: [TENANT_ADMIN_ROLE],
    sensitive: true,
  },
  {
    action: 'platform.connection.certify_mfa_policy',
    description: 'Certify a PLATFORM-scope provider connection MFA policy',
    resourceType: null,
    allowedRoles: [PLATFORM_ADMIN_ROLE],
    sensitive: true,
    plane: 'control_plane',
  },
  {
    action: 'identity.support.approve',
    description: 'Approve or deny a pending support-access request',
    resourceType: null,
    allowedRoles: [TENANT_ADMIN_ROLE],
    sensitive: true,
  },
  {
    action: 'identity.support.revoke',
    description: 'Revoke a live support-access session immediately',
    resourceType: null,
    allowedRoles: [TENANT_ADMIN_ROLE],
  },
  {
    action: 'org.unit.create',
    description: 'Create a dealer group, legal entity, rooftop or department',
    resourceType: null,
    allowedRoles: [TENANT_ADMIN_ROLE],
  },
  {
    action: 'org.unit.update_status',
    description: 'Transition an organization unit status (no hard deletes exist)',
    resourceType: null,
    allowedRoles: [TENANT_ADMIN_ROLE],
  },
  {
    action: 'platform.tenant.provision',
    description: 'Provision or activate a tenant (platform control plane)',
    resourceType: null,
    allowedRoles: [PLATFORM_ADMIN_ROLE],
    plane: 'control_plane',
  },
  {
    action: 'platform.support.request',
    description: 'File a support-access request against a tenant',
    resourceType: null,
    // R3 correction F1: the SAME list the mutation gate and the engine's
    // support branch read, so the three cannot disagree about who holds
    // platform-support authority.
    allowedRoles: PLATFORM_SUPPORT_AUTHORITY_ROLES,
    plane: 'control_plane',
  },
] as const;

export function createIdentityActionCatalog(): ActionCatalog {
  return createActionCatalog(IDENTITY_ACTION_DEFINITIONS.map((d) => ({ ...d })));
}
