/**
 * Identity test scaffolding (FBL-020): a complete WorkOS-shaped environment
 * with NO live credential — the deterministic local issuer plays the
 * provider, and helpers seed the organization chain, connections, user
 * links, role bindings and reauthentication grants the new auth stack needs.
 */
import { randomUUID } from 'node:crypto';
import { query } from '@dealer/database';
import { resetConfigForTests } from '@dealer/platform';
import {
  activateUserLink,
  completeReauthentication,
  observeUserLinkOnLogin,
  startReauthentication,
} from '@dealer/identity-access';
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
  // FBL-020-R3 section J: the harness runs a plain-http LOOPBACK issuer. It
  // qualifies only because NODE_ENV is explicitly 'test' AND every identity
  // URL is 127.0.0.1 — there is no longer an override that would let a
  // remote or staging host use http.
  process.env.NODE_ENV = 'test';
  process.env.IDENTITY_PROVIDER = 'workos';
  process.env.WORKOS_CLIENT_ID = 'client_test_local';
  process.env.WORKOS_API_KEY = 'sk_test_local_0123456789abcdef0123456789abcdef';
  process.env.WORKOS_ISSUER = issuer.issuer;
  process.env.WORKOS_JWKS_URI = issuer.jwksUri;
  process.env.WORKOS_REDIRECT_URI = 'http://127.0.0.1:3000/auth/callback';
  process.env.WORKOS_REAUTH_REDIRECT_URI = 'http://127.0.0.1:3000/auth/reauth/callback';
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
 * The issuer a seeded connection records. Migration 056 requires a non-empty
 * issuer and the middleware requires it to AGREE with the configured one, so
 * suites that start the local issuer get its value and suites that never
 * authenticate get an obviously-fake placeholder.
 */
export function testIssuer(): string {
  const configured = process.env.WORKOS_ISSUER;
  return configured !== undefined && configured.length > 0
    ? configured
    : 'https://issuer.invalid.test';
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
    `INSERT INTO identity_provider_connections
       (connection_scope, tenant_id, provider, provider_organization_id, status, issuer)
     SELECT 'dealership', $1, 'workos', $2, 'active', $3
      WHERE NOT EXISTS (
        SELECT 1 FROM identity_provider_connections WHERE provider = 'workos' AND provider_organization_id = $2
      )`,
    [tenantId, testOrganizationId(tenantId), testIssuer()],
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
    `INSERT INTO user_links
       (user_link_id, actor_scope, tenant_id, provider, provider_user_id, status, activated_at,
        connection_id, issuer, provider_organization_id)
     SELECT $1, $2, $3, 'workos', $4, 'activated', NOW(),
            c.connection_id, c.issuer, c.provider_organization_id
       FROM identity_provider_connections c
      WHERE c.tenant_id IS NOT DISTINCT FROM $3 AND c.provider = 'workos' AND c.status = 'active'
      LIMIT 1
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
  // Direct insert of an ALREADY-ACTIVATED link: this is the fixture standing
  // in for an administrator having activated it, never a login side effect.
  // R2: an ACTIVATED link must be exactly bound to its connection, issuer and
  // organization — the schema refuses anything less.
  await query(
    `INSERT INTO user_links
       (user_link_id, actor_scope, tenant_id, provider, provider_user_id, status, activated_at,
        connection_id, issuer, provider_organization_id)
     SELECT $1, 'dealership', $2, 'workos', $3, 'activated', NOW(),
            c.connection_id, c.issuer, c.provider_organization_id
       FROM identity_provider_connections c
      WHERE c.tenant_id = $2 AND c.provider = 'workos' AND c.status = 'active'
      LIMIT 1`,
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
  /** Defaults to the HIGH assurance Fixed Ops operations now demand (R2). */
  assurance?: 'fresh_only' | 'fresh_and_mfa_policy';
}): Promise<string> {
  const assurance = input.assurance ?? 'fresh_and_mfa_policy';
  const binding = await sessionBindingFor(input.tenantId);
  if (assurance === 'fresh_and_mfa_policy') await certifyMfaPolicy(input.tenantId);
  const started = await startReauthentication({
    tenantId: input.tenantId,
    userLinkId: input.userLinkId,
    action: input.action,
    resourceType: input.resourceType ?? 'repair_order',
    resourceId: input.resourceId,
    requiredAssurance: assurance,
    connectionId: binding.connectionId,
    issuer: binding.issuer,
    providerOrganizationId: binding.providerOrganizationId,
    providerSubject: binding.providerSubject,
  });
  const completed = await completeReauthentication({
    nonce: started.nonce,
    userLinkId: input.userLinkId,
    verifiedAuthTime: new Date(),
    connection: {
      connectionId: binding.connectionId,
      mfaPolicyCertified: assurance === 'fresh_and_mfa_policy',
    },
  });
  if (completed === null) throw new Error('test grant minting failed');
  return completed.grant;
}

/**
 * FBL-020-R1: the explicit two-step a test must now perform, because login
 * no longer activates anything. Observing creates/keeps a PENDING link; an
 * administrator then activates it. Returns the ACTIVATED link.
 */
export async function observeThenActivate(input: {
  tenantId: string | null;
  providerUserId: string;
  email?: string | null;
  displayName?: string | null;
  activatedByUserLinkId: string;
}): Promise<{ userLinkId: string }> {
  const pending = await observeUserLinkOnLogin({
    tenantId: input.tenantId,
    providerUserId: input.providerUserId,
    email: input.email ?? null,
    displayName: input.displayName ?? null,
  });
  if (pending === null) throw new Error('login observation refused the identity');
  const activated = await activateUserLink({
    userLinkId: pending.userLinkId,
    activatedByUserLinkId: input.activatedByUserLinkId,
  });
  if (activated === null) throw new Error('activation refused');
  return { userLinkId: activated.userLinkId };
}

/** Certifies the tenant's provider connection as MFA-required (R1 §E). */
export async function certifyMfaPolicy(tenantId: string, certified = true): Promise<void> {
  await query(
    `UPDATE identity_provider_connections
        SET mfa_policy_certified = $2,
            mfa_policy_certified_at = CASE WHEN $2 THEN NOW() ELSE NULL END
      WHERE tenant_id = $1`,
    [tenantId, certified],
  );
}

/**
 * FBL-020-R2: the binding every LIVE session must carry. The schema refuses a
 * live session that cannot name its connection, issuer, organization and
 * subject, so tests fetch the real values rather than inventing them.
 */
export async function sessionBindingFor(
  tenantId: string | null,
  providerSubject = 'user_test_subject',
): Promise<{
  connectionId: string;
  issuer: string;
  providerOrganizationId: string;
  providerSubject: string;
}> {
  const r = await query(
    `SELECT connection_id, issuer, provider_organization_id
       FROM identity_provider_connections
      WHERE tenant_id IS NOT DISTINCT FROM $1 AND provider = 'workos' AND status = 'active'
      LIMIT 1`,
    [tenantId],
  );
  if (r.rows.length === 0) throw new Error('no active connection to bind a session to');
  const row = r.rows[0] as Record<string, unknown>;
  return {
    connectionId: String(row.connection_id),
    issuer: String(row.issuer),
    providerOrganizationId: String(row.provider_organization_id),
    providerSubject,
  };
}

/**
 * R2: an ACTIVATED user link must name its connection, so a suite that builds
 * tenants directly (rather than through seedTenantIdentity) still needs one.
 * Idempotent, and safe for the NULL-tenant platform scope.
 */
export async function ensureActiveConnection(tenantId: string | null): Promise<void> {
  await query(
    `INSERT INTO identity_provider_connections
       (connection_scope, tenant_id, provider, provider_organization_id, status, issuer)
     SELECT $1, $2, 'workos', $3, 'active', $4
      WHERE NOT EXISTS (
        SELECT 1 FROM identity_provider_connections
         WHERE tenant_id IS NOT DISTINCT FROM $2 AND provider = 'workos' AND status = 'active'
      )`,
    [
      tenantId === null ? 'platform' : 'dealership',
      tenantId,
      tenantId === null ? 'org_platform_fixture' : testOrganizationId(tenantId),
      testIssuer(),
    ],
  );
}
