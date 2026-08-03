/**
 * Application-facing actor resolution (FBL-020). The API layer composes
 * these instead of running SQL — the app-SQL guard keeps query primitives
 * out of apps entirely.
 */
import { query } from '@dealer/database';
import { IDENTITY_PROVIDER_WORKOS, type IdentityProviderKind } from './contracts';
import {
  resolveConnectionByOrganization,
  type ActorScope,
  type UserLink,
  findUserLink,
} from './user-link';

/** Resolves which internal home an external organization maps to (active only). */
export async function resolveActiveConnection(
  providerOrganizationId: string,
  provider: IdentityProviderKind = IDENTITY_PROVIDER_WORKOS,
): Promise<{ connectionScope: ActorScope; tenantId: string | null } | null> {
  return resolveConnectionByOrganization({ query }, provider, providerOrganizationId);
}

/** Looks up a user link by provider identity within one home. */
export async function findUserLinkByProviderIdentity(
  tenantId: string | null,
  providerUserId: string,
  provider: IdentityProviderKind = IDENTITY_PROVIDER_WORKOS,
): Promise<UserLink | null> {
  return findUserLink({ query }, provider, tenantId, providerUserId);
}

/**
 * The actor's ACTIVE role names — informational context for legacy service
 * visibility rules (e.g. technician-vs-supervisor result shaping). Every
 * authorization decision still goes through the policy engine, which reads
 * the bindings itself.
 */
export async function rolesForUserLink(
  userLinkId: string,
  tenantId?: string | null,
): Promise<string[]> {
  // Scoped to ONE tenant when the caller names it: a platform-scope binding
  // (tenant_id IS NULL) must never surface as a dealership role, or the
  // legacy domain guards would treat a platform actor as staff.
  const result =
    tenantId === undefined
      ? await query(
          `SELECT DISTINCT role FROM role_bindings
            WHERE user_link_id = $1 AND status = 'active' ORDER BY role`,
          [userLinkId],
        )
      : await query(
          `SELECT DISTINCT role FROM role_bindings
            WHERE user_link_id = $1 AND status = 'active'
              AND tenant_id IS NOT DISTINCT FROM $2 ORDER BY role`,
          [userLinkId, tenantId],
        );
  return (result.rows as Array<{ role: string }>).map((r) => r.role);
}
