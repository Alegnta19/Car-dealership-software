/**
 * Identity test scaffolding (FBL-020): a complete WorkOS-shaped environment
 * with NO live credential — the deterministic local issuer plays the
 * provider, and helpers seed the organization chain, connections, user
 * links, role bindings and reauthentication grants the new auth stack needs.
 */
import { randomUUID } from 'node:crypto';
import { query, withTransaction } from '@dealer/database';
import { resetConfigForTests } from '@dealer/platform';
import {
  DEFAULT_MFA_CERTIFICATION_VALIDITY_SECONDS,
  activateUserLink,
  changeOrganizationStatus,
  changeOrganizationUnitStatus,
  claimReauthentication,
  completeReauthentication,
  createOrganization,
  createOrganizationUnit,
  createSession,
  grantRole,
  observeUserLinkOnLogin,
  oidcNonceDigest,
  startReauthentication,
  type OrganizationStatus,
  type PolicyEngine,
} from '@dealer/identity-access';
import type { OrgUnitStatus } from '@dealer/organization';
import { startLocalIssuer, type LocalIssuer } from './local-issuer';
import { fixtureAuthorizationStateWrite } from './fixture-primitives';
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
  // FBL-020-R3 correction D1: the harness bounds a provider refresh far tighter
  // than production's 10s, so a suite can prove what a HANGING provider costs
  // without waiting ten seconds to find out. It changes nothing for a provider
  // that answers, and every fake port in the battery answers immediately.
  process.env.WORKOS_REFRESH_TIMEOUT_MS = '1500';
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
  // FBL-020-R4 §5 — THE ORDER BELOW IS THE FIXTURE'S HONEST ANSWER TO A REAL PROBLEM.
  //
  // The attributed services demand an EXISTING acting user link, and the first link of
  // a tenant cannot exist before the tenant and its provider connection do. So this
  // fixture does what the production bootstrap does: the ORIGIN (tenant, connection,
  // first administrator) goes through the declared fixture primitive, and everything
  // after it — including the organization units — goes through the attributed service,
  // leaving the same trail a real administrator would.
  const existing = await query(`SELECT status FROM tenants WHERE tenant_id = $1`, [tenantId]);
  if (existing.rows.length === 0) {
    await fixtureAuthorizationStateWrite(
      'seed-authorization-state',
      `INSERT INTO tenants (tenant_id, name, status) VALUES ($1, $2, 'active')`,
      [tenantId, name ?? 'Test Tenant ' + tenantId.slice(0, 8)],
    );
  } else {
    await fixtureAuthorizationStateWrite(
      'seed-authorization-state',
      `UPDATE tenants SET status = 'active' WHERE tenant_id = $1`,
      [tenantId],
    );
  }
  await fixtureAuthorizationStateWrite(
    'seed-authorization-state',
    `INSERT INTO identity_provider_connections
       (connection_scope, tenant_id, provider, provider_organization_id, status, issuer)
     SELECT 'dealership', $1, 'workos', $2, 'active', $3
      WHERE NOT EXISTS (
        SELECT 1 FROM identity_provider_connections WHERE provider = 'workos' AND provider_organization_id = $2
      )`,
    [tenantId, testOrganizationId(tenantId), testIssuer()],
  );
  // The PLATFORM origin administrator, not this tenant's — see `originActor`. Minting a
  // tenant-scoped administrator here would leave every seeded tenant with an activated
  // link BOUND to its connection, and several suites are about what happens when that
  // connection drifts; the fixture must not decide that for them.
  const actor = await originActor();
  const existingGroup = await query(
    `SELECT dealer_group_id FROM dealer_groups WHERE tenant_id = $1 ORDER BY created_at LIMIT 1`,
    [tenantId],
  );
  const groupId =
    existingGroup.rows.length > 0
      ? String((existingGroup.rows[0] as { dealer_group_id: unknown }).dealer_group_id)
      : (
          await createOrganizationUnit({
            actingUserLinkId: actor,
            tenantId,
            level: 'dealer_group',
            parentId: tenantId,
            name: 'Test Group',
            status: 'active',
          })
        ).unitId;
  const existingEntity = await query(
    `SELECT legal_entity_id FROM legal_entities WHERE tenant_id = $1 LIMIT 1`,
    [tenantId],
  );
  if (existingEntity.rows.length === 0) {
    await createOrganizationUnit({
      actingUserLinkId: actor,
      tenantId,
      level: 'legal_entity',
      parentId: groupId,
      name: 'Test Entity',
      status: 'active',
    });
  }
}

/**
 * Attaches a rooftop with a SPECIFIC id (the legacy location_id) to the tenant.
 *
 * FBL-020-R4 §5: through the attributed service, so the fixture leaves an actor, a
 * version and an audit row exactly as an administrator would. Idempotent by looking
 * first rather than by `ON CONFLICT DO NOTHING`, because a create that silently does
 * nothing has no honest audit row to write.
 */
export async function seedRooftopIdentity(
  tenantId: string,
  rooftopId: string,
  name?: string,
): Promise<void> {
  const existing = await query(`SELECT 1 FROM rooftops WHERE rooftop_id = $1`, [rooftopId]);
  if (existing.rows.length > 0) return;
  const entity = await query(
    `SELECT legal_entity_id FROM legal_entities WHERE tenant_id = $1 ORDER BY created_at LIMIT 1`,
    [tenantId],
  );
  if (entity.rows.length === 0) throw new Error('seed the tenant chain before seeding a rooftop');
  await createOrganizationUnit({
    actingUserLinkId: await originActor(),
    tenantId,
    level: 'rooftop',
    parentId: String((entity.rows[0] as { legal_entity_id: unknown }).legal_entity_id),
    unitId: rooftopId,
    name: name ?? 'Rooftop ' + rooftopId.slice(0, 8),
    status: 'active',
  });
}

/**
 * FBL-020-R4 §5 — THE ATTRIBUTED, VERSION-AWARE ORGANIZATION FIXTURES.
 *
 * These replace `createTenant` / `createDealerGroup` / `createLegalEntity` /
 * `createRooftop` / `createDepartment` / `setUnitStatus`, the six unattributed
 * production writes this order removed from `@dealer/organization`. Every one of them
 * now goes through the owned mutation service, so a suite that builds an organization
 * leaves precisely the trail a real administrator would: a true actor on the row, an
 * `authorization_version` that starts at 1 and advances on every change, and one audit
 * event per mutation.
 *
 * THE ACTOR FOR A BRAND-NEW TENANT IS A PLATFORM ONE, deliberately. A tenant cannot be
 * attributed to one of its own users before it has any, and inventing an actor would be
 * the very fiction these services exist to prevent — so the fixture uses the PLATFORM
 * origin administrator, which is who provisions a tenant in the real control plane too.
 * Units below it are attributed to the tenant's own origin administrator.
 *
 * The return shapes match the removed repository functions field for field, so a test
 * that used to read `.dealerGroupId` still does; what changed is that the row now knows
 * who made it.
 */
export async function seedTenantViaService(input: {
  name: string;
  status?: OrganizationStatus;
  tenantId?: string;
}): Promise<{ tenantId: string; status: OrganizationStatus; provisionedBy: string }> {
  const provisioner = await bootstrapAdministrator(null);
  const created = await createOrganization({
    actingUserLinkId: provisioner,
    ...(input.tenantId === undefined ? {} : { tenantId: input.tenantId }),
    name: input.name,
    ...(input.status === undefined ? {} : { status: input.status }),
  });
  return { tenantId: created.tenantId, status: created.status, provisionedBy: provisioner };
}

/**
 * The PLATFORM origin administrator — the actor every organization fixture attributes
 * to.
 *
 * Deliberately platform-scope rather than the tenant's own administrator, for a reason
 * that matters to the suite's honesty: minting a tenant-scoped administrator would
 * require an active provider connection FOR THAT TENANT, so merely creating a rooftop
 * would silently manufacture a connection — and several suites assert exactly how many
 * active connections a tenant may have. A platform link needs only the platform
 * connection (tenant_id NULL), which no tenant-scoped assertion is about, and it is
 * also who provisions organizations in the real control plane.
 */
async function originActor(): Promise<string> {
  return bootstrapAdministrator(null);
}

export async function seedDealerGroup(input: {
  tenantId: string;
  name: string;
  status?: OrgUnitStatus;
}): Promise<{ dealerGroupId: string; tenantId: string; status: OrgUnitStatus }> {
  const created = await createOrganizationUnit({
    actingUserLinkId: await originActor(),
    tenantId: input.tenantId,
    level: 'dealer_group',
    parentId: input.tenantId,
    name: input.name,
    ...(input.status === undefined ? {} : { status: input.status }),
  });
  return { dealerGroupId: created.unitId, tenantId: input.tenantId, status: created.status };
}

export async function seedLegalEntity(input: {
  tenantId: string;
  dealerGroupId: string;
  name: string;
  status?: OrgUnitStatus;
}): Promise<{ legalEntityId: string; tenantId: string; status: OrgUnitStatus }> {
  const created = await createOrganizationUnit({
    actingUserLinkId: await originActor(),
    tenantId: input.tenantId,
    level: 'legal_entity',
    parentId: input.dealerGroupId,
    name: input.name,
    ...(input.status === undefined ? {} : { status: input.status }),
  });
  return { legalEntityId: created.unitId, tenantId: input.tenantId, status: created.status };
}

export async function seedRooftop(input: {
  tenantId: string;
  legalEntityId: string;
  name: string;
  rooftopId?: string;
  status?: OrgUnitStatus;
}): Promise<{ rooftopId: string; tenantId: string; status: OrgUnitStatus }> {
  const created = await createOrganizationUnit({
    actingUserLinkId: await originActor(),
    tenantId: input.tenantId,
    level: 'rooftop',
    parentId: input.legalEntityId,
    name: input.name,
    ...(input.rooftopId === undefined ? {} : { unitId: input.rooftopId }),
    ...(input.status === undefined ? {} : { status: input.status }),
  });
  return { rooftopId: created.unitId, tenantId: input.tenantId, status: created.status };
}

export async function seedDepartment(input: {
  tenantId: string;
  rooftopId: string;
  code: string;
  name: string;
  status?: OrgUnitStatus;
}): Promise<{ departmentId: string; tenantId: string; status: OrgUnitStatus }> {
  const created = await createOrganizationUnit({
    actingUserLinkId: await originActor(),
    tenantId: input.tenantId,
    level: 'department',
    parentId: input.rooftopId,
    code: input.code,
    name: input.name,
    ...(input.status === undefined ? {} : { status: input.status }),
  });
  return { departmentId: created.unitId, tenantId: input.tenantId, status: created.status };
}

/**
 * The attributed replacement for `setUnitStatus`. Returns whether a row changed, which
 * is what the old boolean meant — but a `true` now also means an audit row was written
 * and the version advanced, which is the whole difference.
 */
export async function setUnitStatusViaService(
  level: 'dealer_group' | 'legal_entity' | 'rooftop' | 'department',
  tenantId: string,
  unitId: string,
  status: OrgUnitStatus,
): Promise<boolean> {
  const changed = await changeOrganizationUnitStatus({
    actingUserLinkId: await originActor(),
    tenantId,
    level,
    unitId,
    status,
  });
  return changed !== null;
}

/** The attributed replacement for `setTenantStatus`. */
export async function setTenantStatusViaService(
  tenantId: string,
  status: OrganizationStatus,
): Promise<boolean> {
  const changed = await changeOrganizationStatus({
    actingUserLinkId: await bootstrapAdministrator(null),
    tenantId,
    status,
  });
  return changed !== null;
}

/** Creates an activated user link with a SPECIFIC user_link_id. */
export async function seedUserLinkRow(tenantId: string | null, userLinkId: string): Promise<void> {
  await fixtureAuthorizationStateWrite(
    'seed-authorization-state',
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

/**
 * The ORIGIN-OF-TRUST fixture: the harness analogue of
 * `scripts/bootstrap-identity.ts`. Before it exists there is no actor to
 * attribute anything to, so this ONE link is inserted directly — it holds no
 * role binding and therefore grants nothing by existing. Every authorization
 * change a suite makes afterwards is attributed to it through the owned
 * mutation services. Idempotent per home.
 */
export async function bootstrapAdministrator(tenantId: string | null): Promise<string> {
  const subject = 'user_bootstrap_admin';
  const existing = await query(
    `SELECT user_link_id FROM user_links
      WHERE tenant_id IS NOT DISTINCT FROM $1 AND provider = 'workos' AND provider_user_id = $2`,
    [tenantId, subject],
  );
  if (existing.rows.length > 0) {
    return String((existing.rows[0] as { user_link_id: unknown }).user_link_id);
  }
  await ensureActiveConnection(tenantId);
  const created = await fixtureAuthorizationStateWrite(
    'seed-authorization-state',
    `INSERT INTO user_links
       (actor_scope, tenant_id, provider, provider_user_id, status, activated_at,
        connection_id, issuer, provider_organization_id)
     SELECT $1, $2, 'workos', $3, 'activated', NOW(),
            c.connection_id, c.issuer, c.provider_organization_id
       FROM identity_provider_connections c
      WHERE c.tenant_id IS NOT DISTINCT FROM $2 AND c.provider = 'workos' AND c.status = 'active'
      LIMIT 1
     RETURNING user_link_id`,
    [tenantId === null ? 'platform' : 'dealership', tenantId, subject],
  );
  if (created.rows.length === 0) {
    throw new Error('no active provider connection to bootstrap an administrator against');
  }
  return String((created.rows[0] as { user_link_id: unknown }).user_link_id);
}

export interface SeededActor {
  userLinkId: string;
  tenantId: string;
  /** The provider subject the link is bound to — needed to re-sign tokens. */
  providerUserId: string;
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
  await fixtureAuthorizationStateWrite(
    'seed-authorization-state',
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
  // FBL-020-R3: role bindings are NEVER inserted by raw SQL any more, not even
  // from a fixture. Every grant goes through the owned mutation service, so the
  // seeded actor's authorization has a true actor, a version and an audit row —
  // the same trail production grants leave.
  const grantedBy = await bootstrapAdministrator(input.tenantId);
  for (const role of input.roles) {
    await grantRole({
      actingUserLinkId: grantedBy,
      tenantId: input.tenantId,
      userLinkId,
      role,
      scopeLevel: input.scope?.level ?? 'tenant',
      scopeId: input.scope?.id ?? input.tenantId,
    });
  }
  const token = await issuer.signAccessToken({
    sub: providerUserId,
    org_id: testOrganizationId(input.tenantId),
  });
  return { userLinkId, tenantId: input.tenantId, providerUserId, token };
}

/**
 * The LOCAL session an activated link would have after a real login, built from
 * the link's own binding so the identity chain the platform revalidates on every
 * request actually holds. FBL-020-R3 made a live local session a precondition of
 * a step-up (a grant that outlives the session it steps up from proves nothing),
 * so anything minting a grant needs one of these first.
 */
export async function seedLocalSession(
  userLinkId: string,
  ttlSeconds = 3600,
): Promise<{
  sessionId: string;
  sessionToken: string;
  tenantId: string | null;
  connectionId: string;
  issuer: string;
  providerOrganizationId: string;
  providerSubject: string;
}> {
  const r = await query(
    `SELECT tenant_id, provider_user_id, connection_id, issuer, provider_organization_id
       FROM user_links WHERE user_link_id = $1 AND status = 'activated'`,
    [userLinkId],
  );
  if (r.rows.length === 0) {
    throw new Error('no activated user link to seed a local session for');
  }
  const row = r.rows[0] as Record<string, unknown>;
  if (row.connection_id === null || row.issuer === null || row.provider_organization_id === null) {
    throw new Error('an activated user link must be bound before it can hold a session');
  }
  const tenantId = row.tenant_id === null ? null : String(row.tenant_id);
  const binding = {
    connectionId: String(row.connection_id),
    issuer: String(row.issuer),
    providerOrganizationId: String(row.provider_organization_id),
    providerSubject: String(row.provider_user_id),
  };
  const created = await createSession({
    ...binding,
    tenantId,
    userLinkId,
    providerSessionId: 'sid_seed_' + userLinkId.slice(0, 8),
    authTime: new Date(),
    ttlSeconds,
  });
  return {
    sessionId: created.session.sessionId,
    sessionToken: created.sessionToken,
    tenantId,
    ...binding,
  };
}

/**
 * Mints a REAL reauthentication grant through the production services. No
 * provider round trip is needed — the completion's proofs are a verified
 * auth_time, the OIDC nonce digest and the verified identity, and the harness
 * supplies exactly what a real callback would: "now", the digest of the nonce
 * the START generated, and the binding the START derived from the session.
 */
export async function mintReauthGrant(input: {
  tenantId: string;
  userLinkId: string;
  action: string;
  /** null mints a RESOURCE-FREE grant (RT1's admin surface consumes those). */
  resourceId: string | null;
  resourceType?: string | null;
  /** Defaults to the HIGH assurance Fixed Ops operations now demand (R2). */
  assurance?: 'fresh_only' | 'fresh_and_mfa_policy';
}): Promise<string> {
  const assurance = input.assurance ?? 'fresh_and_mfa_policy';
  if (assurance === 'fresh_and_mfa_policy') await certifyMfaPolicy(input.tenantId);
  const session = await seedLocalSession(input.userLinkId);
  const started = await startReauthentication({
    tenantId: input.tenantId,
    userLinkId: input.userLinkId,
    sessionId: session.sessionId,
    action: input.action,
    // A null resourceId is a resource-FREE grant: both facets stay null so the
    // spend's IS NOT DISTINCT FROM comparison matches a resource-free consume.
    resourceType: input.resourceId === null ? null : (input.resourceType ?? 'repair_order'),
    resourceId: input.resourceId,
    requiredAssurance: assurance,
    callbackUri: TEST_REAUTH_CALLBACK_URI,
  });
  if (started === null) throw new Error('test grant minting refused the starting identity');
  // FBL-020-R4 section 3: a completion requires the transaction to have CLAIMED
  // its own callback state. The harness performs the claim exactly as the real
  // /auth/reauth/callback does — with the state and PKCE verifier the START
  // generated — rather than reaching past it.
  const claimed = await claimReauthentication({
    presentedPurpose: 'reauth',
    nonce: started.nonce,
    state: started.state,
    codeVerifier: started.codeVerifier,
    callbackUri: TEST_REAUTH_CALLBACK_URI,
  });
  if (claimed === null) throw new Error('test grant minting could not claim the round trip');
  const completed = await completeReauthentication({
    nonce: started.nonce,
    userLinkId: input.userLinkId,
    verifiedAuthTime: new Date(),
    verifiedNonceDigest: oidcNonceDigest(started.oidcNonce),
    verifiedConnectionId: started.binding.connectionId,
    verifiedIssuer: started.binding.issuer,
    verifiedOrganizationId: started.binding.providerOrganizationId,
    verifiedProviderSubject: started.binding.providerSubject,
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
  // R3: a login now carries the connection it came through. The harness reads
  // the tenant's real active connection rather than inventing one.
  const binding = await sessionBindingFor(input.tenantId);
  const pending = await observeUserLinkOnLogin({
    tenantId: input.tenantId,
    providerUserId: input.providerUserId,
    email: input.email ?? null,
    displayName: input.displayName ?? null,
    connectionId: binding.connectionId,
    issuer: binding.issuer,
    providerOrganizationId: binding.providerOrganizationId,
  });
  if (pending === null) throw new Error('login observation refused the identity');
  const activated = await activateUserLink({
    userLinkId: pending.userLinkId,
    activatedByUserLinkId: input.activatedByUserLinkId,
  });
  if (activated === null) throw new Error('activation refused');
  return { userLinkId: activated.userLinkId };
}

/**
 * The reauthentication callback the harness's step-ups are issued for. It is the
 * value the START stores and the CLAIM re-compares, so it must be one constant
 * rather than two hopeful copies.
 */
export const TEST_REAUTH_CALLBACK_URI = 'http://127.0.0.1:3000/auth/reauth/callback';

/**
 * Certifies the tenant's provider connection as MFA-required (R1 §E).
 *
 * FBL-020-R4 §3: a certification now has a VALIDITY DEADLINE, and the schema
 * refuses a certified connection without one (`ipc_mfa_certification_is_bounded`).
 * The fixture stands in for an administrator having certified the policy, so it
 * writes a real, bounded certification — a stale or unbounded one would be
 * treated as uncertified everywhere, which is the point of the control.
 */
export async function certifyMfaPolicy(
  tenantId: string,
  certified = true,
  options?: { validForSeconds?: number },
): Promise<void> {
  await fixtureAuthorizationStateWrite(
    'simulate-authorization-drift',
    `UPDATE identity_provider_connections
        SET mfa_policy_certified = $2,
            mfa_policy_certified_at = CASE WHEN $2 THEN NOW() ELSE NULL END,
            mfa_policy_certification_expires_at =
              CASE WHEN $2 THEN NOW() + make_interval(secs => $3) ELSE NULL END,
            mfa_policy_certification_revoked_at =
              CASE WHEN $2 THEN NULL ELSE mfa_policy_certification_revoked_at END,
            mfa_policy_certification_revoked_by_user_link_id =
              CASE WHEN $2 THEN NULL
                   ELSE mfa_policy_certification_revoked_by_user_link_id END
      WHERE tenant_id = $1`,
    [tenantId, certified, options?.validForSeconds ?? DEFAULT_MFA_CERTIFICATION_VALIDITY_SECONDS],
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
/**
 * FBL-020-R7 §3.2 — MOVES A LIVE SUPPORT WINDOW INTO THE PAST, the only way left.
 *
 * The expiry suites used to stage "the clock has passed this window" with an
 * UPDATE that pulled `granted_at`/`expires_at` backwards. Migration 059 makes a
 * session's window IMMUTABLE — an approval's window may never be edited after
 * the fact — so the staging is now a REBUILD: the production-created request and
 * session rows are re-recorded VERBATIM, with only their instants shifted, and
 * every write travels through the declared fixture primitive. The reborn rows
 * satisfy every R7 rule on their own terms: the decision instant moves with the
 * grant instant, and the shifted window still spans exactly the duration the
 * request asked for.
 *
 * The shifted window is `[now-61m, now-31m)` against a decision at `now-61m`, so
 * a 30-minute approval stays a 30-minute approval — just one that ended half an
 * hour ago.
 */
/**
 * FBL-020-R7-C2 §5 — approves a support request DIRECTLY, coherently.
 *
 * Migration 060 §5 requires the cited grant to have been CONSUMED, unexpired,
 * AT the approval instant — the atomic path's own shape. A fixture that stages
 * an approved request outside `decideSupportAccess` (a state that path never
 * leaves behind, e.g. "approved but session not started") must therefore spend
 * the decider's `identity.support.approve` grant under the SAME transaction
 * clock it decides with, or the staging is a shape no real history has and the
 * schema rightly refuses it. Two statements, one transaction: NOW() is
 * transaction-stable, and a data-modifying CTE's effect would be invisible to
 * the triggers firing in the same statement.
 */
export async function approveSupportRequestDirectly(input: {
  requestId: string;
  deciderUserLinkId: string;
}): Promise<void> {
  await withTransaction(async (executor) => {
    await fixtureAuthorizationStateWrite(
      'seed-authorization-state',
      `UPDATE reauthentication_grants g SET consumed_at = NOW()
        WHERE g.user_link_id = $2 AND g.action = 'identity.support.approve'
          AND g.resource_id = $1 AND g.consumed_at IS NULL`,
      [input.requestId, input.deciderUserLinkId],
      { executor },
    );
    await fixtureAuthorizationStateWrite(
      'seed-authorization-state',
      `UPDATE support_access_requests
          SET status = 'approved', decided_at = NOW(), decided_by_user_link_id = $2,
              approval_grant_id = (
                SELECT g.grant_id FROM reauthentication_grants g
                 WHERE g.user_link_id = $2
                   AND g.action = 'identity.support.approve'
                   AND g.resource_id = $1)
        WHERE request_id = $1`,
      [input.requestId, input.deciderUserLinkId],
      { executor },
    );
  });
}

export async function shiftSupportWindowIntoThePast(supportSessionId: string): Promise<void> {
  await withTransaction(async (executor) => {
    await executor.query(
      `CREATE TEMP TABLE _shift_session ON COMMIT DROP AS
         SELECT * FROM support_access_sessions WHERE support_session_id = $1`,
      [supportSessionId],
    );
    await executor.query(
      `CREATE TEMP TABLE _shift_request ON COMMIT DROP AS
         SELECT r.* FROM support_access_requests r
           JOIN _shift_session s ON s.request_id = r.request_id`,
    );
    await fixtureAuthorizationStateWrite(
      'simulate-authorization-drift',
      `DELETE FROM support_access_sessions WHERE support_session_id = $1`,
      [supportSessionId],
      { executor },
    );
    await fixtureAuthorizationStateWrite(
      'simulate-authorization-drift',
      `DELETE FROM support_access_requests
        WHERE request_id IN (SELECT request_id FROM _shift_request)`,
      [],
      { executor },
    );
    await executor.query(`UPDATE _shift_request SET decided_at = NOW() - INTERVAL '61 minutes'`);
    // FBL-020-R7-C2 §5 — the approval's grant is consumed AT the approval
    // instant, and the re-insert below re-fires the complete-approval check;
    // a shifted decision therefore shifts its grant's consumption with it, or
    // the shifted history would be incoherent in a way no real history is.
    await fixtureAuthorizationStateWrite(
      'simulate-authorization-drift',
      `UPDATE reauthentication_grants gr
          SET consumed_at = NOW() - INTERVAL '61 minutes'
        WHERE gr.grant_id IN (SELECT approval_grant_id FROM _shift_request
                               WHERE approval_grant_id IS NOT NULL)`,
      [],
      { executor },
    );
    await executor.query(
      `UPDATE _shift_session
          SET granted_at = NOW() - INTERVAL '61 minutes',
              expires_at = NOW() - INTERVAL '61 minutes'
                           + make_interval(mins => (SELECT requested_duration_minutes
                                                      FROM _shift_request))`,
    );
    await fixtureAuthorizationStateWrite(
      'simulate-authorization-drift',
      `INSERT INTO support_access_requests SELECT * FROM _shift_request`,
      [],
      { executor },
    );
    await fixtureAuthorizationStateWrite(
      'simulate-authorization-drift',
      `INSERT INTO support_access_sessions SELECT * FROM _shift_session`,
      [],
      { executor },
    );
  });
}

export async function ensureActiveConnection(tenantId: string | null): Promise<void> {
  await fixtureAuthorizationStateWrite(
    'seed-authorization-state',
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

/**
 * FBL-020-R4 §2 — THE SESSION A FIXTURE PRESENTS.
 *
 * Migration 057 makes an ALLOW that names no presented session unrepresentable, and
 * the policy engine derives the credential facts it records from that session's row.
 * A fixture that authorizes somebody therefore has to authenticate them too, which is
 * the point: the old fixtures asserted allows for actors who had never presented a
 * credential, so the suite could not have noticed evidence going missing.
 *
 * Idempotent against `resetDatabase`: it looks for a live session first and seeds one
 * only when there is none, so the helper holds no state that a truncation invalidates.
 * Returns null when the link cannot hold a session at all (not activated, or not
 * bound) — a deliberate ghost actor stays a ghost.
 */
export async function presentedSessionFor(userLinkId: string): Promise<string | null> {
  const live = await query(
    `SELECT session_id FROM identity_sessions
      WHERE user_link_id = $1 AND revoked_at IS NULL AND expires_at > NOW()
      ORDER BY auth_time DESC LIMIT 1`,
    [userLinkId],
  );
  if (live.rows.length > 0) return String((live.rows[0] as Record<string, unknown>).session_id);
  try {
    return (await seedLocalSession(userLinkId)).sessionId;
  } catch {
    return null;
  }
}

/**
 * Wraps a policy engine so a fixture that does not name a session presents the actor's
 * own live one. It NEVER overrides an explicit `sessionId` (including an explicit
 * null), so a test that is about the presented credential still controls it exactly.
 */
export function withPresentedSession(engine: PolicyEngine): PolicyEngine {
  return {
    async decide(input) {
      if (input.sessionId !== undefined) return engine.decide(input);
      return engine.decide({
        ...input,
        sessionId: await presentedSessionFor(input.actor.userLinkId),
      });
    },
  };
}

/**
 * FBL-020-R4 §2.1 — the binding of an EXISTING link, read from the link itself.
 *
 * `sessionBindingFor(tenantId, subject)` returns the tenant's connection plus whatever
 * subject the caller names, which was fine while nothing checked the two against each
 * other. Migration 057's `is_link_identity_tuple` now does: a session's connection,
 * issuer, organization and provider subject must all belong to the very link it is
 * issued to. A fixture that wants a session for a link therefore has to read that
 * link's own facts rather than restate them, which is exactly what this does.
 */
export async function sessionBindingForLink(userLinkId: string): Promise<{
  connectionId: string;
  issuer: string;
  providerOrganizationId: string;
  providerSubject: string;
}> {
  const r = await query(
    `SELECT connection_id, issuer, provider_organization_id, provider_user_id
       FROM user_links WHERE user_link_id = $1`,
    [userLinkId],
  );
  if (r.rows.length === 0) throw new Error('no such user link to bind a session to');
  const row = r.rows[0] as Record<string, unknown>;
  if (row.connection_id === null || row.issuer === null || row.provider_organization_id === null) {
    throw new Error('the user link is not bound to a connection yet');
  }
  return {
    connectionId: String(row.connection_id),
    issuer: String(row.issuer),
    providerOrganizationId: String(row.provider_organization_id),
    providerSubject: String(row.provider_user_id),
  };
}
