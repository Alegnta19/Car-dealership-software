/**
 * Application-facing actor and connection resolution (FBL-020, R1 sections
 * C and E). The API layer composes these instead of running SQL — the
 * app-SQL guard keeps query primitives out of apps entirely.
 */
import { query } from '@dealer/database';
import { IDENTITY_PROVIDER_WORKOS, type IdentityProviderKind } from './contracts';
import { findUserLink, type ActorScope, type UserLink } from './user-link';

/**
 * An ACTIVE, EFFECTIVE provider connection, with the facts authorization
 * depends on. `issuer` is the trust anchor the verified token must match;
 * `mfaPolicyCertified` is the separately certified organization MFA policy
 * (a fresh auth_time does not imply it — ADR-006-R1).
 */
export interface ActiveConnection {
  readonly connectionId: string;
  readonly connectionScope: ActorScope;
  readonly tenantId: string | null;
  readonly issuer: string;
  readonly providerOrganizationId: string;
  readonly mfaPolicyCertified: boolean;
  readonly authorizationVersion: number;
}

interface Row {
  [key: string]: unknown;
}

function mapConnection(r: Row): ActiveConnection {
  return {
    connectionId: String(r.connection_id),
    connectionScope: String(r.connection_scope) as ActorScope,
    tenantId: r.tenant_id === null ? null : String(r.tenant_id),
    issuer: String(r.issuer),
    providerOrganizationId: String(r.provider_organization_id),
    mfaPolicyCertified: r.mfa_policy_certified === true,
    authorizationVersion: Number(r.authorization_version),
  };
}

/**
 * Resolves an external organization to its internal home. ACTIVE and
 * EFFECTIVE only — disabling or expiring the connection denies the next
 * request made with an otherwise-valid token, with no restart and no waiting
 * for the token to expire.
 */
export async function resolveActiveConnection(
  providerOrganizationId: string,
  provider: IdentityProviderKind = IDENTITY_PROVIDER_WORKOS,
): Promise<ActiveConnection | null> {
  const result = await query(
    `SELECT * FROM identity_provider_connections
      WHERE provider = $1 AND provider_organization_id = $2
        AND status = 'active'
        AND effective_from <= NOW()
        AND (effective_to IS NULL OR effective_to > NOW())`,
    [provider, providerOrganizationId],
  );
  return result.rows.length > 0 ? mapConnection(result.rows[0] as Row) : null;
}

/** The same resolution by connection id, for a session re-check. */
export async function findActiveConnectionById(
  connectionId: string,
): Promise<ActiveConnection | null> {
  const result = await query(
    `SELECT * FROM identity_provider_connections
      WHERE connection_id = $1 AND status = 'active'
        AND effective_from <= NOW()
        AND (effective_to IS NULL OR effective_to > NOW())`,
    [connectionId],
  );
  return result.rows.length > 0 ? mapConnection(result.rows[0] as Row) : null;
}

/** A tenant authorizes only while active and inside its effective window. */
export async function isTenantEffective(tenantId: string): Promise<boolean> {
  const result = await query(
    `SELECT 1 FROM tenants
      WHERE tenant_id = $1 AND status = 'active'
        AND effective_from <= NOW()
        AND (effective_to IS NULL OR effective_to > NOW())`,
    [tenantId],
  );
  return result.rows.length > 0;
}

/**
 * Looks up a user link by provider identity. Returns it in ANY status —
 * callers decide, so a pending link can be reported distinctly from a
 * missing one without ever being treated as access.
 */
export async function findUserLinkByProviderIdentity(
  tenantId: string | null,
  providerUserId: string,
  provider: IdentityProviderKind = IDENTITY_PROVIDER_WORKOS,
): Promise<UserLink | null> {
  return findUserLink({ query }, provider, tenantId, providerUserId);
}

/** True only for an ACTIVATED link inside its effective window. */
export async function isUserLinkUsable(userLinkId: string): Promise<boolean> {
  const result = await query(
    `SELECT 1 FROM user_links
      WHERE user_link_id = $1 AND status = 'activated'
        AND effective_from <= NOW()
        AND (effective_to IS NULL OR effective_to > NOW())`,
    [userLinkId],
  );
  return result.rows.length > 0;
}

/**
 * The actor's ACTIVE role names in ONE tenant — informational context for
 * legacy service visibility rules. Every authorization decision still goes
 * through the policy engine, which reads the bindings itself.
 */
export async function rolesForUserLink(
  userLinkId: string,
  tenantId?: string | null,
): Promise<string[]> {
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
