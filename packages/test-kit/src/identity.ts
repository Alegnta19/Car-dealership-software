/**
 * Identity test scaffolding (FBL-020): a complete WorkOS-shaped environment
 * with NO live credential — the deterministic local issuer plays the
 * provider, and helpers seed the organization chain, connections, user
 * links, role bindings and reauthentication grants the new auth stack needs.
 */
import { randomUUID } from 'node:crypto';
import { query } from '@dealer/database';
import { resetConfigForTests } from '@dealer/platform';
import { completeReauthentication, startReauthentication } from '@dealer/identity-access';
import { startLocalIssuer, type LocalIssuer } from './local-issuer';
import type { TestWorld } from './db';

export interface IdentityTestEnv {
  issuer: LocalIssuer;
  cookiePassword: string;
  stop(): Promise<void>;
}

/**
 * Points the identity configuration at a fresh local issuer and resets the
 * cached config so the next getConfig() sees it. Call BEFORE createApp().
 */
export async function startIdentityTestEnv(): Promise<IdentityTestEnv> {
  const issuer = await startLocalIssuer();
  const cookiePassword = 'test-cookie-password-0123456789abcdef!!';
  process.env.IDENTITY_PROVIDER = 'workos';
  process.env.WORKOS_CLIENT_ID = 'client_test_local';
  process.env.WORKOS_API_KEY = 'sk_test_local_0123456789abcdef0123456789abcdef';
  process.env.WORKOS_ISSUER = issuer.issuer;
  process.env.WORKOS_JWKS_URI = issuer.jwksUri;
  process.env.WORKOS_REDIRECT_URI = 'http://127.0.0.1:3000/auth/callback';
  process.env.WORKOS_LOGOUT_REDIRECT_URI = 'http://127.0.0.1:3000/';
  process.env.WORKOS_COOKIE_PASSWORD = cookiePassword;
  process.env.OIDC_AUDIENCE = issuer.audience;
  resetConfigForTests();
  return { issuer, cookiePassword, stop: () => issuer.stop() };
}

export function testOrganizationId(tenantId: string): string {
  return `org_test_${tenantId}`;
}

/**
 * Seeds an ACTIVE tenant with its minimal chain (group -> legal entity) and
 * an active provider connection. Idempotent per tenant.
 */
export async function seedTenantIdentity(tenantId: string, name?: string): Promise<void> {
  const existing = await query(`SELECT status FROM tenants WHERE tenant_id = $1`, [tenantId]);
  if (existing.rows.length === 0) {
    await query(`INSERT INTO tenants (tenant_id, name, status) VALUES ($1, $2, 'active')`, [
      tenantId,
      name ?? 'Test Tenant ' + tenantId.slice(0, 8),
    ]);
  } else {
    await query(`UPDATE tenants SET status = 'active' WHERE tenant_id = $1`, [tenantId]);
  }
  const group = await query(
    `INSERT INTO dealer_groups (tenant_id, name, status)
     SELECT $1, 'Test Group', 'active'
      WHERE NOT EXISTS (SELECT 1 FROM dealer_groups WHERE tenant_id = $1)
     RETURNING dealer_group_id`,
    [tenantId],
  );
  const groupId =
    group.rows.length > 0
      ? String((group.rows[0] as { dealer_group_id: unknown }).dealer_group_id)
      : String(
          (
            (
              await query(
                `SELECT dealer_group_id FROM dealer_groups WHERE tenant_id = $1 LIMIT 1`,
                [tenantId],
              )
            ).rows[0] as { dealer_group_id: unknown }
          ).dealer_group_id,
        );
  await query(
    `INSERT INTO legal_entities (tenant_id, dealer_group_id, name, status)
     SELECT $1, $2, 'Test Entity', 'active'
      WHERE NOT EXISTS (SELECT 1 FROM legal_entities WHERE tenant_id = $1)`,
    [tenantId, groupId],
  );
  await query(
    `INSERT INTO identity_provider_connections (connection_scope, tenant_id, provider, provider_organization_id, status)
     SELECT 'dealership', $1, 'workos', $2, 'active'
      WHERE NOT EXISTS (
        SELECT 1 FROM identity_provider_connections WHERE provider = 'workos' AND provider_organization_id = $2
      )`,
    [tenantId, testOrganizationId(tenantId)],
  );
}

/** Attaches a rooftop with a SPECIFIC id (the legacy location_id) to the tenant. */
export async function seedRooftopIdentity(
  tenantId: string,
  rooftopId: string,
  name?: string,
): Promise<void> {
  await query(
    `INSERT INTO rooftops (rooftop_id, tenant_id, legal_entity_id, name, status)
     SELECT $1, $2, le.legal_entity_id, $3, 'active'
       FROM legal_entities le WHERE le.tenant_id = $2
      ORDER BY le.created_at LIMIT 1
     ON CONFLICT (rooftop_id) DO NOTHING`,
    [rooftopId, tenantId, name ?? 'Rooftop ' + rooftopId.slice(0, 8)],
  );
}

/** Creates an activated user link with a SPECIFIC user_link_id. */
export async function seedUserLinkRow(tenantId: string | null, userLinkId: string): Promise<void> {
  await query(
    `INSERT INTO user_links (user_link_id, actor_scope, tenant_id, provider, provider_user_id, status, activated_at)
     VALUES ($1, $2, $3, 'workos', $4, 'activated', NOW())
     ON CONFLICT (user_link_id) DO NOTHING`,
    [
      userLinkId,
      tenantId === null ? 'platform' : 'dealership',
      tenantId,
      'user_seed_' + userLinkId.slice(0, 8),
    ],
  );
}

/**
 * Seeds the identity rows for an already-built TestWorld: both tenants
 * active with connections, every actor's user link present, rooftops for the
 * world's two locations under tenant A.
 */
export async function seedTestWorldIdentity(world: TestWorld): Promise<void> {
  await seedTenantIdentity(world.tenantA.tenantId, 'World Tenant A');
  await seedTenantIdentity(world.tenantB.tenantId, 'World Tenant B');
  await seedRooftopIdentity(world.tenantA.tenantId, world.locationA);
  await seedRooftopIdentity(world.tenantA.tenantId, world.locationB);
  await seedUserLinkRow(world.tenantA.tenantId, world.tenantA.userId);
  await seedUserLinkRow(world.tenantB.tenantId, world.tenantB.userId);
  await seedUserLinkRow(world.tenantA.tenantId, world.technician.userId);
}

export interface SeededActor {
  userLinkId: string;
  tenantId: string;
  token: string;
}

/**
 * Creates an activated user link with the given roles bound at tenant scope
 * and signs a local-issuer access token for it — the drop-in replacement for
 * the retired HS256 test JWT.
 */
export async function seedActor(
  issuer: LocalIssuer,
  input: { tenantId: string; roles: readonly string[]; scope?: { level: string; id: string } },
): Promise<SeededActor> {
  const userLinkId = randomUUID();
  const providerUserId = 'user_actor_' + userLinkId.slice(0, 12);
  await query(
    `INSERT INTO user_links (user_link_id, actor_scope, tenant_id, provider, provider_user_id, status, activated_at)
     VALUES ($1, 'dealership', $2, 'workos', $3, 'activated', NOW())`,
    [userLinkId, input.tenantId, providerUserId],
  );
  for (const role of input.roles) {
    await query(
      `INSERT INTO role_bindings (tenant_id, user_link_id, role, scope_level, scope_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        input.tenantId,
        userLinkId,
        role,
        input.scope?.level ?? 'tenant',
        input.scope?.id ?? input.tenantId,
      ],
    );
  }
  const token = await issuer.signAccessToken({
    sub: providerUserId,
    org_id: testOrganizationId(input.tenantId),
  });
  return { userLinkId, tenantId: input.tenantId, token };
}

/**
 * Mints a REAL reauthentication grant through the production services (no
 * provider round trip needed: the completion proof only needs a verified
 * auth_time, and the harness supplies "now").
 */
export async function mintReauthGrant(input: {
  tenantId: string;
  userLinkId: string;
  action: string;
  resourceId: string;
  resourceType?: string;
}): Promise<string> {
  const started = await startReauthentication({
    tenantId: input.tenantId,
    userLinkId: input.userLinkId,
    action: input.action,
    resourceType: input.resourceType ?? 'repair_order',
    resourceId: input.resourceId,
  });
  const completed = await completeReauthentication({
    nonce: started.nonce,
    userLinkId: input.userLinkId,
    verifiedAuthTime: new Date(),
  });
  if (completed === null) throw new Error('test grant minting failed');
  return completed.grant;
}
