/**
 * FBL-020-R3 — the OWNED, ATTRIBUTABLE mutation services.
 *
 * Every write that can change what an actor is allowed to do lives here, and
 * every one of them obeys the same three-part contract:
 *
 *   1. an EXPLICIT acting user link id — the true actor. It is never optional,
 *      never nullable, and never inferred: the row is looked up before the
 *      mutation runs, so an unknown or fabricated actor refuses the write
 *      instead of landing an unattributable change;
 *   2. the applicable `authorization_version` ADVANCES. A create establishes
 *      version 1; every later change increments. Policy evidence records the
 *      versions it matched at, so a change that did not move the version would
 *      leave the evidence trail claiming a decision was made against state
 *      that no longer exists;
 *   3. exactly ONE `audit_events` row is written IN THE SAME TRANSACTION as the
 *      mutation. Not after it, not best-effort: if the audit row cannot be
 *      written the mutation does not happen.
 *
 * Nothing here logs, stores or returns a token, refresh token, nonce, cookie,
 * authorization code, provider profile or PII. Audit details carry identifiers,
 * classifications and versions only — the support-access REASON text, in
 * particular, stays in its own row and is never copied into an audit event.
 *
 * The origin of trust is deliberately NOT here: `scripts/bootstrap-identity.ts`
 * mints the first administrator, because before it runs there is no actor to
 * attribute anything to. Every subsequent change comes through this file.
 */
import { randomUUID } from 'node:crypto';
import { withTransaction, type Executor } from '@dealer/database';
// Types only. The organization package owns the hierarchy's vocabulary; this module
// owns the WRITES to it (see the organization-unit section below), and taking the
// level and status types from their owner keeps one definition of each.
import type { OrganizationLevel, OrgUnitStatus } from '@dealer/organization';
import {
  DEFAULT_MFA_CERTIFICATION_VALIDITY_SECONDS,
  IDENTITY_PROVIDER_WORKOS,
  MAX_MFA_CERTIFICATION_VALIDITY_SECONDS,
  type ActorScope,
  type IdentityProviderKind,
  type SupportAccessRequest,
  type SupportAccessSession,
  type UserLink,
  type UserLinkStatus,
} from './contracts';
import { createIdentityActionCatalog } from './actions';
import {
  ACTIVE_EFFECTIVE_TENANT_SQL,
  EFFECTIVE_ROLE_BINDING_SQL,
  actionPlane,
  coversTenantWide,
  type ActionDefinition,
} from './policy';
import { consumeReauthenticationGrantReturningId } from './reauthentication';

interface Row {
  [key: string]: unknown;
}

/**
 * `audit_events.tenant_id` is NOT NULL, so platform-scope identity events are
 * recorded under the nil tenant. The row is still written transactionally and
 * still names its true actor.
 */
const NIL_TENANT = '00000000-0000-0000-0000-000000000000';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Raised when a mutation is asked to run without a usable true actor. */
export class UnattributableMutationError extends Error {}

/**
 * Raised when a role binding would be recorded at a scope that role may not be
 * bound at (FBL-020-R3 correction B3).
 */
export class RoleScopeMismatchError extends Error {}

/**
 * FBL-020-R4 §3 — raised when the acting person EXISTS but holds no authority
 * for the mutation they asked for.
 *
 * Distinct from `UnattributableMutationError` on purpose: "nobody performed
 * this" and "this person may not perform this" are different facts, and the
 * second one is the one that must never quietly succeed. It carries no detail
 * about which binding was missing — the caller learns only that it was refused.
 */
export class MutationAuthorityError extends Error {}

/**
 * The catalog THIS package publishes — the very data the policy engine decides
 * identity actions from. The authority gates below read their allowed roles out
 * of it rather than naming roles inline, so adding a role to an action cannot
 * leave a hand-written gate behind.
 */
const IDENTITY_CATALOG = createIdentityActionCatalog();

/** What every attributable mutation reports back about itself. */
export interface MutationResult {
  readonly entityType: string;
  readonly entityId: string;
  readonly eventType: string;
  /** The TRUE actor this mutation is attributed to. */
  readonly actingUserLinkId: string;
  /** The version the mutated row now carries (1 for a create). */
  readonly authorizationVersion: number;
  /** The single audit row written in the mutation's own transaction. */
  readonly auditEventId: string;
}

// ── shared plumbing ────────────────────────────────────────────────────────

/**
 * The true actor must EXIST. A caller that passes an id belonging to nothing is
 * not attributing the change to anybody, and a mutation nobody performed is
 * exactly the shape this revision exists to make impossible.
 */
async function requireActor(executor: Executor, actingUserLinkId: unknown): Promise<string> {
  if (typeof actingUserLinkId !== 'string' || !UUID_RE.test(actingUserLinkId)) {
    throw new UnattributableMutationError(
      'an attributable mutation requires the acting user link id',
    );
  }
  const found = await executor.query(`SELECT 1 FROM user_links WHERE user_link_id = $1`, [
    actingUserLinkId,
  ]);
  if (found.rows.length === 0) {
    throw new UnattributableMutationError(
      'the acting user link does not exist — refusing an unattributable mutation',
    );
  }
  return actingUserLinkId;
}

async function recordMutation(
  executor: Executor,
  input: {
    tenantId: string | null;
    entityType: string;
    entityId: string;
    eventType: string;
    actingUserLinkId: string;
    authorizationVersion: number;
    details?: Record<string, unknown>;
  },
): Promise<MutationResult> {
  const written = await executor.query(
    `INSERT INTO audit_events (tenant_id, event_type, entity_type, entity_id, actor_user_id, details)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING event_id`,
    [
      input.tenantId ?? NIL_TENANT,
      input.eventType,
      input.entityType,
      input.entityId,
      input.actingUserLinkId,
      JSON.stringify({
        ...(input.details ?? {}),
        authorization_version: input.authorizationVersion,
      }),
    ],
  );
  return {
    entityType: input.entityType,
    entityId: input.entityId,
    eventType: input.eventType,
    actingUserLinkId: input.actingUserLinkId,
    authorizationVersion: input.authorizationVersion,
    auditEventId: String((written.rows[0] as Row).event_id),
  };
}

function version(row: Row): number {
  return Number(row.authorization_version);
}

// ── row mappers (shared with the reading modules; defined here so the write
//    owner has no runtime dependency on them) ───────────────────────────────

export function mapUserLink(r: Row): UserLink {
  return {
    userLinkId: String(r.user_link_id),
    actorScope: String(r.actor_scope) as ActorScope,
    tenantId: r.tenant_id === null ? null : String(r.tenant_id),
    provider: String(r.provider) as IdentityProviderKind,
    providerUserId: String(r.provider_user_id),
    email: r.email === null ? null : String(r.email),
    displayName: r.display_name === null ? null : String(r.display_name),
    status: String(r.status) as UserLinkStatus,
    activatedAt:
      r.activated_at === null || r.activated_at === undefined
        ? null
        : r.activated_at instanceof Date
          ? r.activated_at
          : new Date(String(r.activated_at)),
  };
}

function ts(v: unknown): Date {
  return v instanceof Date ? v : new Date(String(v));
}

export function mapSupportAccessRequest(r: Row): SupportAccessRequest {
  return {
    requestId: String(r.request_id),
    tenantId: String(r.tenant_id),
    requesterUserLinkId: String(r.requester_user_link_id),
    requestedActions: (r.requested_actions as string[]) ?? [],
    scopeLevel: String(r.scope_level),
    scopeId: r.scope_id === null ? null : String(r.scope_id),
    requestedDurationMinutes: Number(r.requested_duration_minutes),
    status: String(r.status) as SupportAccessRequest['status'],
  };
}

export function mapSupportAccessSession(r: Row): SupportAccessSession {
  return {
    supportSessionId: String(r.support_session_id),
    requestId: String(r.request_id),
    tenantId: String(r.tenant_id),
    actorUserLinkId: String(r.actor_user_link_id),
    grantedAt: ts(r.granted_at),
    expiresAt: ts(r.expires_at),
    revokedAt: r.revoked_at === null || r.revoked_at === undefined ? null : ts(r.revoked_at),
  };
}

// ── ORGANIZATION (tenant) ──────────────────────────────────────────────────

export type OrganizationStatus = 'pending_configuration' | 'active' | 'suspended' | 'archived';

export interface OrganizationMutation extends MutationResult {
  readonly tenantId: string;
  readonly status: OrganizationStatus;
}

/** Creates an organization. Version 1 is established, never assumed. */
export async function createOrganization(input: {
  actingUserLinkId: string;
  tenantId?: string;
  name: string;
  status?: OrganizationStatus;
}): Promise<OrganizationMutation> {
  return withTransaction(async (executor) => {
    const actor = await requireActor(executor, input.actingUserLinkId);
    const status: OrganizationStatus = input.status ?? 'pending_configuration';
    const created = await executor.query(
      `INSERT INTO tenants
         (tenant_id, name, status, created_by_user_link_id, updated_by_user_link_id,
          authorization_version)
       VALUES ($1, $2, $3, $4, $4, 1)
       RETURNING tenant_id, status, authorization_version`,
      [input.tenantId ?? randomUUID(), input.name, status, actor],
    );
    const row = created.rows[0] as Row;
    const tenantId = String(row.tenant_id);
    const result = await recordMutation(executor, {
      tenantId,
      entityType: 'tenant',
      entityId: tenantId,
      eventType: 'identity.organization.created',
      actingUserLinkId: actor,
      authorizationVersion: version(row),
      details: { status },
    });
    return { ...result, tenantId, status: String(row.status) as OrganizationStatus };
  });
}

/**
 * Changes an organization's status. Suspension and archival are authorization
 * facts — the policy engine refuses every dealership-targeted decision for a
 * tenant that is not effective — so the version advances with them.
 */
export async function changeOrganizationStatus(input: {
  actingUserLinkId: string;
  tenantId: string;
  status: OrganizationStatus;
}): Promise<OrganizationMutation | null> {
  return withTransaction(async (executor) => {
    const actor = await requireActor(executor, input.actingUserLinkId);
    const updated = await executor.query(
      `UPDATE tenants
          SET status = $2,
              updated_by_user_link_id = $3,
              authorization_version = authorization_version + 1
        WHERE tenant_id = $1 AND status IS DISTINCT FROM $2
        RETURNING tenant_id, status, authorization_version`,
      [input.tenantId, input.status, actor],
    );
    if (updated.rows.length === 0) return null;
    const row = updated.rows[0] as Row;
    const result = await recordMutation(executor, {
      tenantId: input.tenantId,
      entityType: 'tenant',
      entityId: input.tenantId,
      eventType: 'identity.organization.status_changed',
      actingUserLinkId: actor,
      authorizationVersion: version(row),
      details: { status: input.status },
    });
    return {
      ...result,
      tenantId: input.tenantId,
      status: String(row.status) as OrganizationStatus,
    };
  });
}

// ── ORGANIZATION UNITS (group / entity / rooftop / department) ─────────────

/**
 * FBL-020-R4 §5 — THE ORGANIZATION UNITS BECOME OWNED MUTATIONS, AND THIS IS THE
 * WHOLE POINT OF THE SECTION.
 *
 * `@dealer/organization`'s repository exported `createDealerGroup`,
 * `createLegalEntity`, `createRooftop`, `createDepartment` and `setUnitStatus`:
 * production exports that wrote authorization state with NO acting actor, NO
 * audit row and NO version advance. That these tables ARE authorization state is
 * not a matter of opinion — the policy engine's `resolveAncestry` denies every
 * decision whose ancestry chain contains one ineffective node, so archiving a
 * rooftop revokes every binding scoped beneath it. `setUnitStatus('archived')`
 * was therefore a mass revocation that nobody performed, nothing recorded and no
 * version moved for; and creating a node with `status: 'active'` was the reverse.
 *
 * They now obey the same three-part contract as every other mutation in this
 * file: an existing true actor, an advancing `authorization_version`, and exactly
 * one `audit_events` row in the same transaction.
 *
 * WHY HERE AND NOT IN `@dealer/organization`. The contract needs `requireActor`
 * and `recordMutation`, which live in this module, and `@dealer/organization` may
 * not depend on this package — identity-access depends on IT (the policy engine
 * reads `resolveAncestry`), so the reverse edge would be a cycle the architecture
 * gate is right to refuse. `createOrganization` (the tenant) has been here since
 * R3 for exactly this reason; its four children now join it.
 *
 * The SQL is written out per level rather than assembled from a table map. Four
 * literal statements are longer than one interpolated one and they are worth it:
 * every write to these tables is then greppable, and the owned-mutation guard
 * (scripts/check-owned-mutations.ts) can see each statement as written instead of
 * having to resolve a lookup.
 */
export type OrganizationUnitLevel = Exclude<OrganizationLevel, 'tenant'>;

export interface OrganizationUnitMutation extends MutationResult {
  readonly tenantId: string;
  readonly level: OrganizationUnitLevel;
  readonly unitId: string;
  readonly status: OrgUnitStatus;
}

/** Which parent a level requires, so a missing one is refused before the write. */
const UNIT_PARENT: Record<OrganizationUnitLevel, OrganizationUnitLevel | 'tenant'> = {
  dealer_group: 'tenant',
  legal_entity: 'dealer_group',
  rooftop: 'legal_entity',
  department: 'rooftop',
};

/**
 * Creates one organization unit, attributed and versioned.
 *
 * `parentId` is the id of the node one level up (the tenant's own id at
 * dealer_group level). It is REQUIRED: migration 055's composite
 * `(tenant_id, parent_id)` foreign keys make a cross-tenant parent a database
 * error, and this signature makes a MISSING one a refusal rather than a NULL that
 * some column default might paper over.
 */
export async function createOrganizationUnit(input: {
  actingUserLinkId: string;
  tenantId: string;
  level: OrganizationUnitLevel;
  parentId: string;
  name: string;
  /** Departments carry a code; every other level must not name one. */
  code?: string | null;
  unitId?: string;
  status?: OrgUnitStatus;
}): Promise<OrganizationUnitMutation> {
  const status: OrgUnitStatus = input.status ?? 'pending_configuration';
  if (input.level === 'department') {
    if (typeof input.code !== 'string' || input.code.length === 0) {
      throw new Error('a department requires a code');
    }
  } else if (input.code !== undefined && input.code !== null) {
    throw new Error(`a ${input.level} has no code column — refusing to discard the value`);
  }
  if (input.level === 'dealer_group' && input.parentId !== input.tenantId) {
    throw new Error('a dealer group hangs off its own tenant; parentId must be the tenant id');
  }
  return withTransaction(async (executor) => {
    const actor = await requireActor(executor, input.actingUserLinkId);
    const unitId = input.unitId ?? randomUUID();
    let created;
    switch (input.level) {
      case 'dealer_group':
        created = await executor.query(
          `INSERT INTO dealer_groups
             (dealer_group_id, tenant_id, name, status, created_by_user_link_id,
              updated_by_user_link_id, authorization_version)
           VALUES ($1, $2, $3, $4, $5, $5, 1)
           RETURNING dealer_group_id AS unit_id, status, authorization_version`,
          [unitId, input.tenantId, input.name, status, actor],
        );
        break;
      case 'legal_entity':
        created = await executor.query(
          `INSERT INTO legal_entities
             (legal_entity_id, tenant_id, dealer_group_id, name, status,
              created_by_user_link_id, updated_by_user_link_id, authorization_version)
           VALUES ($1, $2, $3, $4, $5, $6, $6, 1)
           RETURNING legal_entity_id AS unit_id, status, authorization_version`,
          [unitId, input.tenantId, input.parentId, input.name, status, actor],
        );
        break;
      case 'rooftop':
        created = await executor.query(
          `INSERT INTO rooftops
             (rooftop_id, tenant_id, legal_entity_id, name, status,
              created_by_user_link_id, updated_by_user_link_id, authorization_version)
           VALUES ($1, $2, $3, $4, $5, $6, $6, 1)
           RETURNING rooftop_id AS unit_id, status, authorization_version`,
          [unitId, input.tenantId, input.parentId, input.name, status, actor],
        );
        break;
      case 'department':
        created = await executor.query(
          `INSERT INTO departments
             (department_id, tenant_id, rooftop_id, code, name, status,
              created_by_user_link_id, updated_by_user_link_id, authorization_version)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $7, 1)
           RETURNING department_id AS unit_id, status, authorization_version`,
          [unitId, input.tenantId, input.parentId, input.code, input.name, status, actor],
        );
        break;
    }
    const row = created.rows[0] as Row;
    const result = await recordMutation(executor, {
      tenantId: input.tenantId,
      entityType: input.level,
      entityId: String(row.unit_id),
      eventType: 'identity.organization_unit.created',
      actingUserLinkId: actor,
      authorizationVersion: version(row),
      details: {
        level: input.level,
        status,
        parent_level: UNIT_PARENT[input.level],
        parent_id: input.parentId,
      },
    });
    return {
      ...result,
      tenantId: input.tenantId,
      level: input.level,
      unitId: String(row.unit_id),
      status: String(row.status) as OrgUnitStatus,
    };
  });
}

/**
 * Transitions one organization unit's status. There is no delete anywhere in the
 * hierarchy — retirement IS this transition — and because an ineffective node
 * breaks the ancestry chain the policy engine walks, this call revokes or restores
 * the reach of every binding scoped at or beneath the node. That is exactly why it
 * advances the version and writes an audit row.
 *
 * Returns null when no row changed: unknown id, wrong tenant, or the status it
 * already had. "Nothing happened" must not be recorded as a change.
 */
export async function changeOrganizationUnitStatus(input: {
  actingUserLinkId: string;
  tenantId: string;
  level: OrganizationUnitLevel;
  unitId: string;
  status: OrgUnitStatus;
}): Promise<OrganizationUnitMutation | null> {
  return withTransaction(async (executor) => {
    const actor = await requireActor(executor, input.actingUserLinkId);
    let updated;
    switch (input.level) {
      case 'dealer_group':
        updated = await executor.query(
          `UPDATE dealer_groups
              SET status = $3, updated_by_user_link_id = $4,
                  authorization_version = authorization_version + 1
            WHERE tenant_id = $1 AND dealer_group_id = $2 AND status IS DISTINCT FROM $3
            RETURNING dealer_group_id AS unit_id, status, authorization_version`,
          [input.tenantId, input.unitId, input.status, actor],
        );
        break;
      case 'legal_entity':
        updated = await executor.query(
          `UPDATE legal_entities
              SET status = $3, updated_by_user_link_id = $4,
                  authorization_version = authorization_version + 1
            WHERE tenant_id = $1 AND legal_entity_id = $2 AND status IS DISTINCT FROM $3
            RETURNING legal_entity_id AS unit_id, status, authorization_version`,
          [input.tenantId, input.unitId, input.status, actor],
        );
        break;
      case 'rooftop':
        updated = await executor.query(
          `UPDATE rooftops
              SET status = $3, updated_by_user_link_id = $4,
                  authorization_version = authorization_version + 1
            WHERE tenant_id = $1 AND rooftop_id = $2 AND status IS DISTINCT FROM $3
            RETURNING rooftop_id AS unit_id, status, authorization_version`,
          [input.tenantId, input.unitId, input.status, actor],
        );
        break;
      case 'department':
        updated = await executor.query(
          `UPDATE departments
              SET status = $3, updated_by_user_link_id = $4,
                  authorization_version = authorization_version + 1
            WHERE tenant_id = $1 AND department_id = $2 AND status IS DISTINCT FROM $3
            RETURNING department_id AS unit_id, status, authorization_version`,
          [input.tenantId, input.unitId, input.status, actor],
        );
        break;
    }
    if (updated.rows.length === 0) return null;
    const row = updated.rows[0] as Row;
    const result = await recordMutation(executor, {
      tenantId: input.tenantId,
      entityType: input.level,
      entityId: String(row.unit_id),
      eventType: 'identity.organization_unit.status_changed',
      actingUserLinkId: actor,
      authorizationVersion: version(row),
      details: { level: input.level, status: input.status },
    });
    return {
      ...result,
      tenantId: input.tenantId,
      level: input.level,
      unitId: String(row.unit_id),
      status: String(row.status) as OrgUnitStatus,
    };
  });
}

// ── PROVIDER MAPPING / ISSUER / MFA CERTIFICATION ──────────────────────────

export interface ProviderConnectionMutation extends MutationResult {
  readonly connectionId: string;
  readonly tenantId: string | null;
}

/**
 * Maps an external provider organization onto an internal home. This is the
 * single fact that decides which tenant a login lands in, so it is versioned
 * and attributed like any other authorization change.
 */
export async function createProviderMapping(input: {
  actingUserLinkId: string;
  tenantId: string | null;
  providerOrganizationId: string;
  issuer: string;
  provider?: IdentityProviderKind;
}): Promise<ProviderConnectionMutation> {
  return withTransaction(async (executor) => {
    const actor = await requireActor(executor, input.actingUserLinkId);
    const created = await executor.query(
      `INSERT INTO identity_provider_connections
         (connection_scope, tenant_id, provider, provider_organization_id, status, issuer,
          created_by_user_link_id, updated_by_user_link_id)
       VALUES ($1, $2, $3, $4, 'active', $5, $6, $6)
       RETURNING connection_id, authorization_version`,
      [
        input.tenantId === null ? 'platform' : 'dealership',
        input.tenantId,
        input.provider ?? IDENTITY_PROVIDER_WORKOS,
        input.providerOrganizationId,
        input.issuer,
        actor,
      ],
    );
    const row = created.rows[0] as Row;
    const connectionId = String(row.connection_id);
    const result = await recordMutation(executor, {
      tenantId: input.tenantId,
      entityType: 'identity_provider_connection',
      entityId: connectionId,
      eventType: 'identity.provider_connection.created',
      actingUserLinkId: actor,
      authorizationVersion: version(row),
      details: { scope: input.tenantId === null ? 'platform' : 'dealership' },
    });
    return { ...result, connectionId, tenantId: input.tenantId };
  });
}

/**
 * Re-points or disables an existing mapping. Disabling one denies every request
 * resolved through it on the very next call, which is precisely why it must be
 * attributable rather than an ad-hoc UPDATE.
 */
export async function remapProviderConnection(input: {
  actingUserLinkId: string;
  connectionId: string;
  providerOrganizationId?: string;
  status?: 'active' | 'disabled';
}): Promise<ProviderConnectionMutation | null> {
  return withTransaction(async (executor) => {
    const actor = await requireActor(executor, input.actingUserLinkId);
    const updated = await executor.query(
      `UPDATE identity_provider_connections
          SET provider_organization_id = COALESCE($2, provider_organization_id),
              status = COALESCE($3, status),
              updated_by_user_link_id = $4,
              authorization_version = authorization_version + 1
        WHERE connection_id = $1
        RETURNING connection_id, tenant_id, status, authorization_version`,
      [input.connectionId, input.providerOrganizationId ?? null, input.status ?? null, actor],
    );
    if (updated.rows.length === 0) return null;
    const row = updated.rows[0] as Row;
    const tenantId = row.tenant_id === null ? null : String(row.tenant_id);
    const result = await recordMutation(executor, {
      tenantId,
      entityType: 'identity_provider_connection',
      entityId: input.connectionId,
      eventType: 'identity.provider_connection.remapped',
      actingUserLinkId: actor,
      authorizationVersion: version(row),
      details: {
        status: String(row.status),
        organization_changed: input.providerOrganizationId !== undefined,
      },
    });
    return { ...result, connectionId: input.connectionId, tenantId };
  });
}

/**
 * Changes the issuer a connection trusts. Authentication refuses every token
 * whose verified issuer disagrees with this value, so it is an authorization
 * fact and moves the version.
 */
export async function changeProviderIssuer(input: {
  actingUserLinkId: string;
  connectionId: string;
  issuer: string;
}): Promise<ProviderConnectionMutation | null> {
  return withTransaction(async (executor) => {
    const actor = await requireActor(executor, input.actingUserLinkId);
    const updated = await executor.query(
      `UPDATE identity_provider_connections
          SET issuer = $2,
              updated_by_user_link_id = $3,
              authorization_version = authorization_version + 1
        WHERE connection_id = $1 AND issuer IS DISTINCT FROM $2
        RETURNING connection_id, tenant_id, authorization_version`,
      [input.connectionId, input.issuer, actor],
    );
    if (updated.rows.length === 0) return null;
    const row = updated.rows[0] as Row;
    const tenantId = row.tenant_id === null ? null : String(row.tenant_id);
    const result = await recordMutation(executor, {
      tenantId,
      entityType: 'identity_provider_connection',
      entityId: input.connectionId,
      eventType: 'identity.provider_connection.issuer_changed',
      actingUserLinkId: actor,
      authorizationVersion: version(row),
      // the issuer is a configured URL, not a credential; it is recorded as the
      // fact that changed, never with any token or key material beside it
      details: { issuer_changed: true },
    });
    return { ...result, connectionId: input.connectionId, tenantId };
  });
}

/**
 * The MFA-certification authority actions, by the SCOPE of the connection being
 * certified. Both are published catalog entries, so the gate below reads its
 * allowed roles from the same data the policy engine decides from.
 */
const MFA_CERTIFY_TENANT_ACTION = 'identity.connection.certify_mfa_policy';
const MFA_CERTIFY_PLATFORM_ACTION = 'platform.connection.certify_mfa_policy';

/**
 * FBL-020-R4 section 3 — PLATFORM-WIDE authority for a published `platform.*`
 * action, asked the way the policy engine asks it: a PLATFORM-SCOPE binding in
 * one of the action's allowed roles, held by an activated, effective platform
 * link.
 *
 * `holdsPlatformSupportAuthority` below is this same shape hard-wired to one
 * action; this is the general form, and both read `allowedRoles` from the
 * published definition rather than naming roles inline.
 */
async function mayActPlatformWide(
  executor: Executor,
  action: string,
  userLinkId: string,
): Promise<boolean> {
  const def = publishedAction(action, true);
  const r = await executor.query(
    `SELECT 1
       FROM role_bindings rb
       JOIN user_links ul ON ul.user_link_id = rb.user_link_id
      WHERE rb.user_link_id = $1
        AND rb.scope_level = 'platform'
        AND rb.role = ANY($2::text[])
        AND ${EFFECTIVE_ROLE_BINDING_SQL}
        AND ul.actor_scope = 'platform'
        AND ul.status = 'activated'
        AND ul.effective_from <= NOW()
        AND (ul.effective_to IS NULL OR ul.effective_to > NOW())
      LIMIT 1`,
    [userLinkId, [...def.allowedRoles]],
  );
  return r.rows.length > 0;
}

/**
 * The connection row an MFA-certification mutation is about to change, LOCKED so
 * the authority decision and the write cannot straddle a remap.
 */
async function lockConnectionForCertification(
  executor: Executor,
  connectionId: string,
): Promise<{ tenantId: string | null } | null> {
  const found = await executor.query(
    `SELECT tenant_id FROM identity_provider_connections
      WHERE connection_id = $1 FOR UPDATE`,
    [connectionId],
  );
  if (found.rows.length === 0) return null;
  const row = found.rows[0] as Row;
  return { tenantId: row.tenant_id === null ? null : String(row.tenant_id) };
}

/**
 * FBL-020-R4 section 3 — WHO may certify. R3 required only that the acting link
 * EXIST.
 *
 * `requireActor` proves somebody is named; it proves nothing about whether that
 * somebody is allowed. Certification is the single fact every high-assurance
 * step-up in the platform rests on, so under R3 any existing user link — the
 * link of a freshly observed pending identity included — could assert that a
 * customer's organization enforces MFA. It is now an authorized administrative
 * act: tenant-wide `tenant_admin` authority in the connection's own tenant, or
 * platform `platform_admin` authority; a PLATFORM-scope connection admits the
 * platform authority only, because no tenant administrator owns it.
 */
async function requireCertificationAuthority(
  executor: Executor,
  actor: string,
  tenantId: string | null,
): Promise<void> {
  // ── FBL-020-R5 §1.9: THE TENANT ITSELF, FIRST ────────────────────────────
  //
  // A TENANT-SCOPED certification is an act inside a tenant, so it is subject to
  // the same authority rule as every other decision about that tenant: the policy
  // engine denies TENANT_INACTIVE for any non-platform action unless the tenant is
  // `active` AND inside its effective window, and this gate applied NO tenant rule
  // whatsoever. A suspended dealership — or one whose effective window had closed —
  // could therefore have the fact its whole high-assurance step-up path rests on
  // re-asserted or withdrawn, by a tenant administrator whose own bindings were
  // still nominally live or by a platform administrator.
  //
  // It is checked BEFORE either authority path on purpose. `TENANT_INACTIVE` is not
  // a permission the platform holds more of; it is a statement that there is no
  // live tenant to certify for, and a platform administrator escaping it would be
  // the second authority path this codebase has already been corrected for once.
  //
  // The predicate is the engine's own SQL, interpolated. There is no second copy.
  //
  // ── FBL-020-R6 §2.6: THE TENANT STATE IS HELD, NOT MERELY READ ───────────
  //
  // R5 asked this question with a plain `SELECT`. Under READ COMMITTED that reads a
  // snapshot and claims nothing, so an administrator suspending the tenant — or
  // closing its effective window — a microsecond later committed freely, and the
  // certification went on to write `mfa_policy_certified = TRUE` for a tenant that
  // no longer admits any decision at all. The certification is the single fact every
  // high-assurance step-up in the platform rests on, and it was being granted
  // against a tenant state nobody was holding.
  //
  // `FOR SHARE` is the claim, and it is the same mode and the same argument as the
  // login admission's: share locks do not conflict with each other, so two
  // certifications are not queued behind one another, while an administrator's
  // EXCLUSIVE write to the tenant row is. The lock is held to COMMIT, which now
  // happens only after the certification UPDATE and its audit row exist, so the two
  // orderings are the only two:
  //
  //   * the suspension commits FIRST — this lock request waits, is granted against
  //     the NEW row version, the predicate is re-evaluated against it, no row
  //     qualifies, and the certification is REFUSED. Nothing is written.
  //   * this transaction commits first — the administrator waits for it, and the
  //     suspension lands on a system where the certification exists and is subject
  //     to the ordinary revocation and expiry paths.
  //
  // THE LOCK ORDER IS CONNECTION, THEN TENANT — the same order
  // `login-admission.ts` takes — so a certification and a login cannot deadlock
  // against each other.
  if (tenantId !== null) {
    const tenant = await executor.query(
      `SELECT 1 FROM tenants t WHERE t.tenant_id = $1 AND ${ACTIVE_EFFECTIVE_TENANT_SQL}
        FOR SHARE`,
      [tenantId],
    );
    if (tenant.rows.length === 0) {
      throw new MutationAuthorityError(
        'certifying an organization MFA policy requires a currently active and effective tenant',
      );
    }
  }
  if (await mayActPlatformWide(executor, MFA_CERTIFY_PLATFORM_ACTION, actor)) return;
  if (
    tenantId !== null &&
    (await mayActTenantWide(executor, MFA_CERTIFY_TENANT_ACTION, tenantId, actor))
  ) {
    return;
  }
  throw new MutationAuthorityError(
    'certifying an organization MFA policy requires administrative authority',
  );
}

/**
 * Certifies the organization's MFA policy for a BOUNDED period. The
 * high-assurance reauthentication path reads this and fails closed without it,
 * so the certification is attributable to a named, AUTHORIZED person, versioned,
 * and dated at both ends.
 *
 * FBL-020-R4 section 3: `certified: false` is no longer the only way back. It
 * withdraws the flag exactly as before;
 * `revokeProviderMfaPolicyCertification` records an explicit, attributable
 * REVOCATION, which is the state migration 057 makes distinguishable from "was
 * never certified".
 */
export async function certifyProviderMfaPolicy(input: {
  actingUserLinkId: string;
  connectionId: string;
  certified: boolean;
  /** How long this certification is good for. Bounded; defaults to 90 days. */
  validForSeconds?: number;
}): Promise<ProviderConnectionMutation | null> {
  const validForSeconds = input.validForSeconds ?? DEFAULT_MFA_CERTIFICATION_VALIDITY_SECONDS;
  if (
    !Number.isFinite(validForSeconds) ||
    validForSeconds <= 0 ||
    validForSeconds > MAX_MFA_CERTIFICATION_VALIDITY_SECONDS
  ) {
    throw new RangeError('an MFA certification validity window must be positive and bounded');
  }
  return withTransaction(async (executor) => {
    const actor = await requireActor(executor, input.actingUserLinkId);
    const connection = await lockConnectionForCertification(executor, input.connectionId);
    if (connection === null) return null;
    await requireCertificationAuthority(executor, actor, connection.tenantId);
    const updated = await executor.query(
      `UPDATE identity_provider_connections
          SET mfa_policy_certified = $2,
              mfa_policy_certified_at = CASE WHEN $2 THEN NOW() ELSE NULL END,
              mfa_policy_certified_by_user_link_id = CASE WHEN $2 THEN $3::uuid ELSE NULL END,
              mfa_policy_certification_expires_at =
                CASE WHEN $2 THEN NOW() + make_interval(secs => $4) ELSE NULL END,
              -- A fresh certification CLEARS a previous revocation: the schema
              -- refuses a row that is simultaneously certified and revoked, and
              -- re-certifying is exactly the act that supersedes a withdrawal.
              mfa_policy_certification_revoked_at =
                CASE WHEN $2 THEN NULL ELSE mfa_policy_certification_revoked_at END,
              mfa_policy_certification_revoked_by_user_link_id =
                CASE WHEN $2 THEN NULL
                     ELSE mfa_policy_certification_revoked_by_user_link_id END,
              updated_by_user_link_id = $3,
              authorization_version = authorization_version + 1
        WHERE connection_id = $1
        RETURNING connection_id, tenant_id, authorization_version,
                  mfa_policy_certification_expires_at`,
      [input.connectionId, input.certified, actor, validForSeconds],
    );
    if (updated.rows.length === 0) return null;
    const row = updated.rows[0] as Row;
    const tenantId = row.tenant_id === null ? null : String(row.tenant_id);
    const result = await recordMutation(executor, {
      tenantId,
      entityType: 'identity_provider_connection',
      entityId: input.connectionId,
      eventType: 'identity.provider_connection.mfa_policy_certified',
      actingUserLinkId: actor,
      authorizationVersion: version(row),
      details: {
        mfa_policy_certified: input.certified,
        // The DEADLINE is part of the record: a certification whose expiry is
        // not in the trail cannot be audited for staleness afterwards.
        certification_expires_at:
          row.mfa_policy_certification_expires_at === null
            ? null
            : ts(row.mfa_policy_certification_expires_at).toISOString(),
      },
    });
    return { ...result, connectionId: input.connectionId, tenantId };
  });
}

/**
 * FBL-020-R4 section 3 — an explicit, attributable WITHDRAWAL of the
 * certification.
 *
 * R3 had no such act. The only way back was to set the same boolean to false,
 * which is indistinguishable from a connection that was never certified — so
 * "somebody looked and decided this organization no longer enforces MFA" was
 * unrecordable. It is a state of its own now, and the schema forbids a revoked
 * certification from also being in force.
 */
export async function revokeProviderMfaPolicyCertification(input: {
  actingUserLinkId: string;
  connectionId: string;
}): Promise<ProviderConnectionMutation | null> {
  return withTransaction(async (executor) => {
    const actor = await requireActor(executor, input.actingUserLinkId);
    const connection = await lockConnectionForCertification(executor, input.connectionId);
    if (connection === null) return null;
    await requireCertificationAuthority(executor, actor, connection.tenantId);
    const updated = await executor.query(
      `UPDATE identity_provider_connections
          SET mfa_policy_certified = FALSE,
              mfa_policy_certified_at = NULL,
              mfa_policy_certified_by_user_link_id = NULL,
              mfa_policy_certification_expires_at = NULL,
              mfa_policy_certification_revoked_at = NOW(),
              mfa_policy_certification_revoked_by_user_link_id = $2::uuid,
              updated_by_user_link_id = $2,
              authorization_version = authorization_version + 1
        WHERE connection_id = $1
        RETURNING connection_id, tenant_id, authorization_version`,
      [input.connectionId, actor],
    );
    if (updated.rows.length === 0) return null;
    const row = updated.rows[0] as Row;
    const tenantId = row.tenant_id === null ? null : String(row.tenant_id);
    const result = await recordMutation(executor, {
      tenantId,
      entityType: 'identity_provider_connection',
      entityId: input.connectionId,
      eventType: 'identity.provider_connection.mfa_policy_certification_revoked',
      actingUserLinkId: actor,
      authorizationVersion: version(row),
      details: { mfa_policy_certified: false, certification_revoked: true },
    });
    return { ...result, connectionId: input.connectionId, tenantId };
  });
}

// ── USER LINK lifecycle ────────────────────────────────────────────────────

/**
 * Pre-provisioning: creates a PENDING link so an administrator has something to
 * activate. A pending link carries no privilege whatsoever, and this path
 * creates no RoleBinding.
 */
export async function provisionUserLink(input: {
  tenantId: string | null;
  provider?: IdentityProviderKind;
  providerUserId: string;
  email: string | null;
  /** The administrator provisioning this identity. Never null. */
  provisionedByUserLinkId: string;
}): Promise<UserLink> {
  const provider = input.provider ?? IDENTITY_PROVIDER_WORKOS;
  return withTransaction(async (executor) => {
    const actor = await requireActor(executor, input.provisionedByUserLinkId);
    const created = await executor.query(
      `INSERT INTO user_links
         (user_link_id, actor_scope, tenant_id, provider, provider_user_id, email, status,
          created_by_user_link_id, updated_by_user_link_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $7)
       RETURNING *`,
      [
        randomUUID(),
        input.tenantId === null ? 'platform' : 'dealership',
        input.tenantId,
        provider,
        input.providerUserId,
        input.email,
        actor,
      ],
    );
    const row = created.rows[0] as Row;
    const link = mapUserLink(row);
    await recordMutation(executor, {
      tenantId: link.tenantId,
      entityType: 'user_link',
      entityId: link.userLinkId,
      eventType: 'identity.user_link.provisioned',
      actingUserLinkId: actor,
      authorizationVersion: version(row),
      details: { provider, status: 'pending' },
    });
    return link;
  });
}

/**
 * The EXPLICIT activation path. Activation BINDS the link to exactly one active
 * provider connection: if the home has zero or more than one active connection
 * the join yields nothing and activation is refused, because guessing which
 * organization a person belongs to is exactly what must not happen. Activation
 * creates NO RoleBinding — an activated identity with no bindings can still do
 * nothing.
 */
export async function activateUserLink(input: {
  userLinkId: string;
  activatedByUserLinkId: string;
}): Promise<UserLink | null> {
  return withTransaction(async (executor) => {
    const actor = await requireActor(executor, input.activatedByUserLinkId);
    const activated = await executor.query(
      `UPDATE user_links ul
          SET status = 'activated',
              activated_at = NOW(),
              activated_by_user_link_id = $2,
              updated_by_user_link_id = $2,
              authorization_version = ul.authorization_version + 1,
              connection_id = c.connection_id,
              issuer = c.issuer,
              provider_organization_id = c.provider_organization_id
         FROM identity_provider_connections c
        WHERE ul.user_link_id = $1
          AND ul.status = 'pending'
          AND c.tenant_id IS NOT DISTINCT FROM ul.tenant_id
          AND c.provider = ul.provider
          AND c.status = 'active'
          AND c.effective_from <= NOW()
          AND (c.effective_to IS NULL OR c.effective_to > NOW())
          AND (
            SELECT COUNT(*) FROM identity_provider_connections c2
             WHERE c2.tenant_id IS NOT DISTINCT FROM ul.tenant_id
               AND c2.provider = ul.provider
               AND c2.status = 'active'
          ) = 1
        RETURNING ul.*`,
      [input.userLinkId, actor],
    );
    if (activated.rows.length === 0) return null;
    const row = activated.rows[0] as Row;
    const link = mapUserLink(row);
    await recordMutation(executor, {
      tenantId: link.tenantId,
      entityType: 'user_link',
      entityId: link.userLinkId,
      eventType: 'identity.user_link.activated',
      actingUserLinkId: actor,
      authorizationVersion: version(row),
      details: { transition: 'pending->activated', granted_roles: 0 },
    });
    return link;
  });
}

/** Administrative deactivation: live sessions die with it (at read time). */
export async function deactivateUserLink(input: {
  userLinkId: string;
  /** The administrator deactivating this identity. Never null. */
  deactivatedByUserLinkId: string;
}): Promise<boolean> {
  return withTransaction(async (executor) => {
    const actor = await requireActor(executor, input.deactivatedByUserLinkId);
    const updated = await executor.query(
      `UPDATE user_links
          SET status = 'deactivated',
              deactivated_at = NOW(),
              deactivated_by_user_link_id = $2,
              updated_by_user_link_id = $2,
              authorization_version = authorization_version + 1
        WHERE user_link_id = $1 AND status <> 'deactivated'
        RETURNING tenant_id, authorization_version`,
      [input.userLinkId, actor],
    );
    if (updated.rows.length === 0) return false;
    const row = updated.rows[0] as Row;
    await recordMutation(executor, {
      tenantId: row.tenant_id === null ? null : String(row.tenant_id),
      entityType: 'user_link',
      entityId: input.userLinkId,
      eventType: 'identity.user_link.deactivated',
      actingUserLinkId: actor,
      authorizationVersion: version(row),
      details: { transition: '->deactivated' },
    });
    return true;
  });
}

/**
 * RELINK: re-binds an existing link to a DIFFERENT active connection of the
 * same home — the sanctioned answer to an organization migration, and the only
 * one, because a login must never silently adopt a link bound elsewhere.
 *
 * Sessions established through the previous connection do not survive: session
 * revalidation compares the session's connection against the link's on every
 * request, so they are refused from the next call onward.
 */
export async function relinkUserLink(input: {
  userLinkId: string;
  connectionId: string;
  relinkedByUserLinkId: string;
}): Promise<UserLink | null> {
  return withTransaction(async (executor) => {
    const actor = await requireActor(executor, input.relinkedByUserLinkId);
    const before = await executor.query(
      `SELECT connection_id FROM user_links WHERE user_link_id = $1 FOR UPDATE`,
      [input.userLinkId],
    );
    if (before.rows.length === 0) return null;
    const previousConnectionId = (before.rows[0] as Row).connection_id;
    const updated = await executor.query(
      `UPDATE user_links ul
          SET connection_id = c.connection_id,
              issuer = c.issuer,
              provider_organization_id = c.provider_organization_id,
              updated_by_user_link_id = $3,
              authorization_version = ul.authorization_version + 1
         FROM identity_provider_connections c
        WHERE ul.user_link_id = $1
          AND c.connection_id = $2
          AND c.status = 'active'
          AND c.effective_from <= NOW()
          AND (c.effective_to IS NULL OR c.effective_to > NOW())
          AND c.tenant_id IS NOT DISTINCT FROM ul.tenant_id
          AND c.provider = ul.provider
          AND ul.status <> 'deactivated'
          AND c.connection_id IS DISTINCT FROM ul.connection_id
        RETURNING ul.*`,
      [input.userLinkId, input.connectionId, actor],
    );
    if (updated.rows.length === 0) return null;
    const row = updated.rows[0] as Row;
    const link = mapUserLink(row);
    await recordMutation(executor, {
      tenantId: link.tenantId,
      entityType: 'user_link',
      entityId: link.userLinkId,
      eventType: 'identity.user_link.relinked',
      actingUserLinkId: actor,
      authorizationVersion: version(row),
      details: {
        connection_id: input.connectionId,
        previous_connection_id: previousConnectionId === null ? null : String(previousConnectionId),
      },
    });
    return link;
  });
}

// ── ROLE BINDINGS ──────────────────────────────────────────────────────────

export interface RoleBindingMutation extends MutationResult {
  readonly roleBindingId: string;
  readonly tenantId: string | null;
  readonly role: string;
}

/**
 * FBL-020-R3 correction B3 — the PLATFORM control-plane roles, DERIVED from the
 * published catalog rather than listed by hand: exactly the roles some
 * `platform.*` action admits. A catalog edit moves this set with it.
 */
const PLATFORM_ROLES: ReadonlySet<string> = new Set(
  IDENTITY_CATALOG.list()
    .filter((d) => actionPlane(d) === 'control_plane')
    .flatMap((d) => [...d.allowedRoles]),
);

/**
 * The roles some NON-platform action admits. A role in both sets would make the
 * scope rule below ambiguous, so the overlap is checked at MODULE LOAD — the
 * same discipline `createActionCatalog` applies to names and duplicates. A
 * catalog that cannot be enforced must not be loadable.
 */
{
  const dealershipRoles = new Set(
    IDENTITY_CATALOG.list()
      .filter((d) => actionPlane(d) !== 'control_plane')
      .flatMap((d) => [...d.allowedRoles]),
  );
  for (const role of PLATFORM_ROLES) {
    if (dealershipRoles.has(role)) {
      throw new Error(
        `${role} authorizes both a platform and a dealership action — the scope a role may be bound at would be ambiguous`,
      );
    }
  }
}

/**
 * FBL-020-R3 correction B3, the WRITE side — a misgrant is refused before it
 * can be recorded.
 *
 * `role_bindings.role` is free text constrained only by a name regex (migration
 * 055), and this service validated nothing about it, so
 * `{role: 'platform_admin', scopeLevel: 'tenant'}` was a perfectly storable row.
 * The policy engine now refuses to honour such a row (`coversPlatformAction`),
 * but defence at one layer only leaves the misgrant sitting in the table,
 * visible on the session page and in every role listing, waiting for the next
 * reader that is less careful than the engine.
 *
 * Both directions are closed:
 *   - a PLATFORM role may be bound ONLY at platform scope. Anywhere else it
 *     names authority the engine will never honour;
 *   - platform scope admits ONLY a platform role. A tenant, rooftop or
 *     department role at platform scope is a tenant-less binding of a role that
 *     only means something inside a tenant — including roles this package has
 *     never heard of, which is the fail-closed direction for a catalog it does
 *     not own.
 */
function assertRoleScope(role: string, scopeLevel: string): void {
  const isPlatformScope = scopeLevel === 'platform';
  const isPlatformRole = PLATFORM_ROLES.has(role);
  if (isPlatformRole && !isPlatformScope) {
    throw new RoleScopeMismatchError(
      `${role} is a platform control-plane role and may be bound only at platform scope`,
    );
  }
  if (isPlatformScope && !isPlatformRole) {
    throw new RoleScopeMismatchError(
      `${role} is not a platform control-plane role and may not be bound at platform scope`,
    );
  }
}

async function grantRoleWithin(
  executor: Executor,
  actor: string,
  input: {
    tenantId: string | null;
    userLinkId: string;
    role: string;
    scopeLevel?: string;
    scopeId?: string | null;
    resourceType?: string | null;
    resourceId?: string | null;
  },
): Promise<RoleBindingMutation> {
  const scopeLevel = input.scopeLevel ?? (input.tenantId === null ? 'platform' : 'tenant');
  const scopeId =
    input.scopeId !== undefined
      ? input.scopeId
      : scopeLevel === 'platform' || scopeLevel === 'resource'
        ? null
        : scopeLevel === 'tenant'
          ? input.tenantId
          : null;
  // R3 correction B3: refuse the misgrant rather than record it.
  assertRoleScope(input.role, scopeLevel);
  const created = await executor.query(
    `INSERT INTO role_bindings
       (tenant_id, user_link_id, role, scope_level, scope_id, resource_type, resource_id,
        granted_by_user_link_id, created_by_user_link_id, updated_by_user_link_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $8)
     RETURNING role_binding_id, authorization_version`,
    [
      input.tenantId,
      input.userLinkId,
      input.role,
      scopeLevel,
      scopeId,
      input.resourceType ?? null,
      input.resourceId ?? null,
      actor,
    ],
  );
  const row = created.rows[0] as Row;
  const roleBindingId = String(row.role_binding_id);
  const result = await recordMutation(executor, {
    tenantId: input.tenantId,
    entityType: 'role_binding',
    entityId: roleBindingId,
    eventType: 'identity.role_binding.granted',
    actingUserLinkId: actor,
    authorizationVersion: version(row),
    details: {
      role: input.role,
      scope_level: scopeLevel,
      subject_user_link_id: input.userLinkId,
    },
  });
  return { ...result, roleBindingId, tenantId: input.tenantId, role: input.role };
}

/** Grants a role. The ONLY sanctioned way authorization is created. */
export async function grantRole(input: {
  actingUserLinkId: string;
  tenantId: string | null;
  userLinkId: string;
  role: string;
  scopeLevel?: string;
  scopeId?: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
}): Promise<RoleBindingMutation> {
  return withTransaction(async (executor) => {
    const actor = await requireActor(executor, input.actingUserLinkId);
    return grantRoleWithin(executor, actor, input);
  });
}

/**
 * Changes the role an existing ACTIVE binding carries. The version advances, so
 * evidence written against the old role is not silently re-attributed to the
 * new one.
 *
 * R3 correction B3: this is the OTHER way a role name reaches a scope, and it
 * gets the same rule. Validating only `grantRole` would leave "grant
 * tenant_admin at tenant scope, then change its role to platform_admin" as an
 * open path to the very binding shape the engine refuses to honour. The binding's
 * own `scope_level` comes back from the UPDATE, so the rule is applied to the row
 * that actually exists; the refusal aborts the transaction, and the mutation and
 * its audit row are rolled back together.
 */
export async function changeRole(input: {
  actingUserLinkId: string;
  roleBindingId: string;
  role: string;
}): Promise<RoleBindingMutation | null> {
  return withTransaction(async (executor) => {
    const actor = await requireActor(executor, input.actingUserLinkId);
    // role-binding-effectiveness-opt-out(all-bindings-including-ineffective): an
    // administrative LIFECYCLE write on
    // ONE row named by id, not an authorization read. `status = 'active'` here
    // means "not already revoked" — a revoked binding is finished and must not
    // be edited back into service. The effective WINDOW is deliberately not
    // consulted: correcting the role on a binding that starts next Monday, or
    // one whose window closed yesterday, is exactly what an administrator is
    // for, and interpolating the engine's predicate would make those rows
    // uneditable while leaving them in the table.
    const updated = await executor.query(
      `UPDATE role_bindings
          SET role = $2,
              updated_by_user_link_id = $3,
              authorization_version = authorization_version + 1
        WHERE role_binding_id = $1 AND status = 'active' AND role IS DISTINCT FROM $2
        RETURNING role_binding_id, tenant_id, user_link_id, role, scope_level,
                  authorization_version`,
      [input.roleBindingId, input.role, actor],
    );
    if (updated.rows.length === 0) return null;
    const row = updated.rows[0] as Row;
    assertRoleScope(input.role, String(row.scope_level));
    const tenantId = row.tenant_id === null ? null : String(row.tenant_id);
    const result = await recordMutation(executor, {
      tenantId,
      entityType: 'role_binding',
      entityId: input.roleBindingId,
      eventType: 'identity.role_binding.changed',
      actingUserLinkId: actor,
      authorizationVersion: version(row),
      details: { role: input.role, subject_user_link_id: String(row.user_link_id) },
    });
    return { ...result, roleBindingId: input.roleBindingId, tenantId, role: input.role };
  });
}

async function revokeRoleWithin(
  executor: Executor,
  actor: string,
  roleBindingId: string,
): Promise<RoleBindingMutation | null> {
  // role-binding-effectiveness-opt-out(all-bindings-including-ineffective): a
  // REVOCATION must reach the bindings the
  // engine already refuses. A binding whose window has closed, or has not opened
  // yet, is still a standing grant in the table and an operator revoking access
  // must be able to retire it; interpolating the engine's predicate would leave
  // exactly those rows un-revokable. `status = 'active'` is the idempotence
  // guard — revoking twice returns null rather than rewriting a settled row.
  const updated = await executor.query(
    `UPDATE role_bindings
        SET status = 'revoked',
            revoked_at = NOW(),
            revoked_by_user_link_id = $2,
            updated_by_user_link_id = $2,
            authorization_version = authorization_version + 1
      WHERE role_binding_id = $1 AND status = 'active'
      RETURNING role_binding_id, tenant_id, user_link_id, role, authorization_version`,
    [roleBindingId, actor],
  );
  if (updated.rows.length === 0) return null;
  const row = updated.rows[0] as Row;
  const tenantId = row.tenant_id === null ? null : String(row.tenant_id);
  const result = await recordMutation(executor, {
    tenantId,
    entityType: 'role_binding',
    entityId: roleBindingId,
    eventType: 'identity.role_binding.revoked',
    actingUserLinkId: actor,
    authorizationVersion: version(row),
    details: { role: String(row.role), subject_user_link_id: String(row.user_link_id) },
  });
  return { ...result, roleBindingId, tenantId, role: String(row.role) };
}

/**
 * Revokes a role binding. The version ADVANCES: a revocation that left the
 * version alone would be invisible to every consumer of policy evidence, which
 * is exactly the defect this service exists to make unrepresentable.
 */
export async function revokeRole(input: {
  actingUserLinkId: string;
  roleBindingId: string;
}): Promise<RoleBindingMutation | null> {
  return withTransaction(async (executor) => {
    const actor = await requireActor(executor, input.actingUserLinkId);
    return revokeRoleWithin(executor, actor, input.roleBindingId);
  });
}

/**
 * Revokes EVERY active binding a user link holds (optionally within one
 * tenant). Each revocation is its own attributed, versioned, audited mutation —
 * a sweep is not an excuse to lose the individual evidence.
 */
export async function revokeRolesForUserLink(input: {
  actingUserLinkId: string;
  userLinkId: string;
  tenantId?: string | null;
}): Promise<RoleBindingMutation[]> {
  return withTransaction(async (executor) => {
    const actor = await requireActor(executor, input.actingUserLinkId);
    // role-binding-effectiveness-opt-out(all-bindings-including-ineffective): the
    // sweep enumerates EVERY unrevoked
    // binding, including the ineffective ones, on purpose. "Revoke everything
    // this link holds" that quietly skipped a future-dated or aged-out binding
    // would leave a standing grant behind — the precise failure this sweep
    // exists to prevent — so it reads by lifecycle status and never by
    // effectiveness. Each row it finds is revoked through the audited path below.
    const active = await executor.query(
      `SELECT role_binding_id FROM role_bindings
        WHERE user_link_id = $1 AND status = 'active'
          AND ($2::uuid IS NULL OR tenant_id = $2::uuid)
        ORDER BY granted_at`,
      [input.userLinkId, input.tenantId ?? null],
    );
    const results: RoleBindingMutation[] = [];
    for (const row of active.rows as Row[]) {
      const revoked = await revokeRoleWithin(executor, actor, String(row.role_binding_id));
      if (revoked !== null) results.push(revoked);
    }
    return results;
  });
}

// ── SUPPORT ACCESS ─────────────────────────────────────────────────────────

/** Approving, denying and starting are all the one approval authority. */
const SUPPORT_APPROVE_ACTION = 'identity.support.approve';
/** Ending a live support session early. */
const SUPPORT_REVOKE_ACTION = 'identity.support.revoke';
/** Filing a request — a PLATFORM action, so a platform binding decides it. */
const SUPPORT_REQUEST_ACTION = 'platform.support.request';

/**
 * The resource a support-approval reauthentication is minted against: the very
 * request being decided. A grant is therefore spendable on THAT request and
 * nothing else.
 */
const SUPPORT_REQUEST_RESOURCE_TYPE = 'support_access_request';

/** The published definition, or a loud refusal — an unknown action is a bug. */
function publishedAction(action: string, expectTenantContext: boolean): ActionDefinition {
  const def = IDENTITY_CATALOG.get(action);
  if (def === undefined) {
    throw new Error(`${action} is not a published identity action — refusing to guess authority`);
  }
  if (expectTenantContext && def.resourceType !== null) {
    // coversTenantWide is only equivalent to the engine for a resource-LESS
    // action; a catalog edit that gave this action a resource type must fail
    // here rather than silently change what the gate means.
    throw new Error(`${action} names a resource type — the tenant-wide gate does not apply`);
  }
  return def;
}

/**
 * FBL-020-R3 correction A1 — the authority gate for a TENANT-CONTEXT identity
 * action, derived from the same catalog data and the SAME two rules the policy
 * engine decides from.
 *
 * The predicate this replaces matched any `tenant_admin` binding of the tenant
 * and never looked at `scope_level` or `scope_id`, so a tenant_admin bound to
 * ONE rooftop held tenant-WIDE authority to approve, deny and revoke platform
 * support access — while the engine, asked the same question about the same
 * actor, answered `deny NO_MATCHING_BINDING`. Two authority paths, one of them
 * wrong, is the root cause; there is now one.
 *
 *   - the allowed roles come from the PUBLISHED action definition;
 *   - the effectiveness window is the engine's own SQL;
 *   - the scope decision is the engine's own predicate, applied to the very
 *     columns it reads. For an action with `resourceType: null` invoked with no
 *     scope hint and no resource — which is exactly how these mutations act —
 *     `covers()` reduces to this call, so the two cannot disagree.
 *
 * The user-link conditions are the pre-existing, STRICTER ones (the link must
 * also be activated and effective); nothing here widens what the engine allows.
 */
async function mayActTenantWide(
  executor: Executor,
  action: string,
  tenantId: string,
  userLinkId: string,
): Promise<boolean> {
  const def = publishedAction(action, true);
  const candidates = await executor.query(
    `SELECT rb.scope_level, rb.scope_id
       FROM role_bindings rb
       JOIN user_links ul ON ul.user_link_id = rb.user_link_id
      WHERE rb.user_link_id = $1
        AND rb.tenant_id = $2
        AND rb.role = ANY($3::text[])
        AND ${EFFECTIVE_ROLE_BINDING_SQL}
        AND ul.tenant_id = $2
        AND ul.status = 'activated'
        AND ul.effective_from <= NOW()
        AND (ul.effective_to IS NULL OR ul.effective_to > NOW())`,
    [userLinkId, tenantId, [...def.allowedRoles]],
  );
  return (candidates.rows as Row[]).some((row) =>
    coversTenantWide(
      {
        scope_level: String(row.scope_level),
        scope_id: row.scope_id === null || row.scope_id === undefined ? null : String(row.scope_id),
      },
      tenantId,
    ),
  );
}

/**
 * FBL-020-R3 corrections A3 and F1 — does this person hold PLATFORM-SUPPORT
 * AUTHORITY *right now*?
 *
 * A3 fixed the predicate: it used to check `rb.status = 'active'` and the user
 * LINK's effective window but omitted the BINDING's — the window the gate
 * twenty lines above and the policy engine both enforce. A binding whose
 * `effective_to` was a day in the past therefore filed support requests that
 * the engine's own effectiveness predicate returned zero rows for. It now
 * interpolates the engine's SQL, so there is no second window to forget.
 *
 * F1 fixed WHERE it is asked. A3 wired it into the FILING gate only, and filing
 * is the one step that does not extend anybody's reach: the request sits inert
 * until a tenant administrator approves it. Approval mints a fresh 60-minute
 * window into tenant data, and starting a session does the same — so revoking a
 * platform actor's binding, the natural offboarding action, left a pending
 * request still approvable into live access hours or days later. Every step that
 * EXTENDS the requester's reach now asks this same question of the requester,
 * and the policy engine asks it of a LIVE session's actor on every decision.
 *
 * The allowed roles come from the PUBLISHED `platform.support.request`
 * definition, whose `allowedRoles` is `PLATFORM_SUPPORT_AUTHORITY_ROLES` — the
 * one list the engine reads too.
 */
async function holdsPlatformSupportAuthority(
  executor: Executor,
  userLinkId: string,
): Promise<boolean> {
  const def = publishedAction(SUPPORT_REQUEST_ACTION, true);
  const r = await executor.query(
    `SELECT 1
       FROM role_bindings rb
       JOIN user_links ul ON ul.user_link_id = rb.user_link_id
      WHERE rb.user_link_id = $1
        AND rb.scope_level = 'platform'
        AND rb.role = ANY($2::text[])
        AND ${EFFECTIVE_ROLE_BINDING_SQL}
        AND ul.actor_scope = 'platform'
        AND ul.status = 'activated'
        AND ul.effective_from <= NOW()
        AND (ul.effective_to IS NULL OR ul.effective_to > NOW())
      LIMIT 1`,
    [userLinkId, [...def.allowedRoles]],
  );
  return r.rows.length > 0;
}

/** Files a support-access request. The reason text never leaves its own row. */
export async function requestSupportAccess(input: {
  tenantId: string;
  requesterUserLinkId: string;
  requestedActions: readonly string[];
  scopeLevel?: string;
  scopeId?: string | null;
  reason: string;
  requestedDurationMinutes: number;
}): Promise<SupportAccessRequest> {
  return withTransaction(async (executor) => {
    const actor = await requireActor(executor, input.requesterUserLinkId);
    // R3 section I: only a current, EFFECTIVE platform-support actor may file.
    if (!(await holdsPlatformSupportAuthority(executor, actor))) {
      throw new Error('support access may only be requested by an active platform-support actor');
    }
    const result = await executor.query(
      `INSERT INTO support_access_requests
         (tenant_id, requester_user_link_id, requested_actions, scope_level, scope_id, reason,
          requested_duration_minutes, created_by_user_link_id, updated_by_user_link_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $2, $2)
       RETURNING *`,
      [
        input.tenantId,
        actor,
        [...input.requestedActions],
        input.scopeLevel ?? 'tenant',
        input.scopeId ?? null,
        input.reason,
        input.requestedDurationMinutes,
      ],
    );
    const row = result.rows[0] as Row;
    const request = mapSupportAccessRequest(row);
    // the audit row records THAT a request exists — never its reason text
    await recordMutation(executor, {
      tenantId: request.tenantId,
      entityType: 'support_access_request',
      entityId: request.requestId,
      eventType: 'identity.support.requested',
      actingUserLinkId: actor,
      authorizationVersion: version(row),
      details: {
        requested_actions: request.requestedActions,
        scope_level: request.scopeLevel,
        duration_minutes: request.requestedDurationMinutes,
      },
    });
    return request;
  });
}

/**
 * FBL-020-R3 correction F1 — starting the bounded session is the act that
 * actually hands a platform person tenant data, so the REQUESTER's authority is
 * re-judged here, immediately before the row is written, in the caller's
 * transaction. Both entry points that start a session go through this function,
 * so neither can acquire its own version of the rule.
 *
 * Returns null when the requester no longer holds platform-support authority.
 */
async function startSupportSessionWithin(
  executor: Executor,
  actor: string,
  request: SupportAccessRequest,
): Promise<SupportAccessSession | null> {
  if (!(await holdsPlatformSupportAuthority(executor, request.requesterUserLinkId))) {
    return null;
  }
  const created = await executor.query(
    `INSERT INTO support_access_sessions
       (request_id, tenant_id, actor_user_link_id, expires_at, created_by_user_link_id,
        updated_by_user_link_id)
     VALUES ($1, $2, $3, NOW() + make_interval(mins => $4), $5, $5)
     RETURNING *`,
    [
      request.requestId,
      request.tenantId,
      request.requesterUserLinkId,
      request.requestedDurationMinutes,
      actor,
    ],
  );
  const row = created.rows[0] as Row;
  const session = mapSupportAccessSession(row);
  await recordMutation(executor, {
    tenantId: session.tenantId,
    entityType: 'support_access_session',
    entityId: session.supportSessionId,
    eventType: 'identity.support.session_started',
    actingUserLinkId: actor,
    authorizationVersion: version(row),
    details: {
      request_id: session.requestId,
      actor_user_link_id: session.actorUserLinkId,
      duration_minutes: request.requestedDurationMinutes,
    },
  });
  return session;
}

/**
 * Starts the bounded session an APPROVED request authorizes, as its own
 * attributable mutation. Refuses anything that is not an approved request of
 * this tenant decided by a current tenant administrator, and refuses a second
 * session for the same request (the unique constraint would too).
 *
 * R3 correction F1: it also refuses when the REQUESTER's platform-support
 * authority has lapsed since the approval — see `startSupportSessionWithin`.
 */
export async function startSupportSession(input: {
  requestId: string;
  startedByUserLinkId: string;
}): Promise<SupportAccessSession | null> {
  return withTransaction(async (executor) => {
    const actor = await requireActor(executor, input.startedByUserLinkId);
    const found = await executor.query(
      `SELECT * FROM support_access_requests WHERE request_id = $1 AND status = 'approved'`,
      [input.requestId],
    );
    if (found.rows.length === 0) return null;
    const request = mapSupportAccessRequest(found.rows[0] as Row);
    // Starting the session an approval authorized IS the approval authority,
    // so it is gated by the same published action at the same tenant scope.
    if (!(await mayActTenantWide(executor, SUPPORT_APPROVE_ACTION, request.tenantId, actor))) {
      return null;
    }
    const existing = await executor.query(
      `SELECT 1 FROM support_access_sessions WHERE request_id = $1`,
      [input.requestId],
    );
    if (existing.rows.length > 0) return null;
    return startSupportSessionWithin(executor, actor, request);
  });
}

/**
 * Approval (or denial) by a DIFFERENT authorized administrator — requester and
 * approver separation is also a table CHECK. Approval starts the bounded
 * session in the same transaction.
 */
export async function decideSupportAccess(input: {
  requestId: string;
  decidedByUserLinkId: string;
  approve: boolean;
  /**
   * An APPROVAL must be backed by the approver's OWN single-use,
   * high-assurance reauthentication grant, minted for
   * `identity.support.approve` against THIS request. Separation of duty alone
   * is not enough. Denials need no grant.
   *
   * FBL-020-R3: this is the opaque grant VALUE that `completeReauthentication`
   * returned exactly once — never a grant id. R2 took an id and then hand-wrote
   * its own acceptance predicate, which checked neither the grant's action nor
   * its resource nor its expiry, and required `consumed_at IS NOT NULL` — the
   * INVERSE of single-use, so one grant approved without limit, forever. The
   * value is now spent through the sanctioned primitive, inside this
   * transaction, exactly once.
   */
  approvalGrant?: string | null;
}): Promise<SupportAccessSession | null> {
  return withTransaction(async (executor) => {
    const actor = await requireActor(executor, input.decidedByUserLinkId);
    // R3 section I: AUTHORITY first. The approver must be a current, effective
    // tenant administrator of the TARGET tenant — checked before any grant is
    // considered, and required for a denial too, so an outsider cannot dispose
    // of a tenant's pending request either.
    //
    // FOR UPDATE: the decision and the grant spend must be one indivisible act.
    // Holding the pending row means a concurrent decision cannot slip between
    // the spend and the status change, so a spent grant always has the approval
    // it paid for.
    const pending = await executor.query(
      `SELECT tenant_id, requester_user_link_id FROM support_access_requests
        WHERE request_id = $1 AND status = 'pending'
        FOR UPDATE`,
      [input.requestId],
    );
    if (pending.rows.length === 0) return null;
    const targetTenantId = String((pending.rows[0] as Row).tenant_id);
    const requesterUserLinkId = String((pending.rows[0] as Row).requester_user_link_id);
    if (requesterUserLinkId === actor) {
      return null; // requester/approver separation, enforced before anything else
    }
    if (!(await mayActTenantWide(executor, SUPPORT_APPROVE_ACTION, targetTenantId, actor))) {
      return null;
    }

    // R3 correction F1 — THE REQUESTER'S AUTHORITY MUST STILL BE CURRENT.
    //
    // An approval mints a fresh window into this tenant's data for the
    // REQUESTER, so their authority is the approver's business, not merely a
    // fact about the day the request was filed. Revoking a platform actor's
    // binding — offboarding — must make a pending request unapprovable, and it
    // does now.
    //
    // POSITION IS DELIBERATE: before the spend, so a refusal costs the approver
    // nothing. Their grant is single-use and expensive to mint; spending it on a
    // decision that cannot be made would punish the approver for somebody
    // else's lapsed binding. The request also stays `pending`, so the same
    // grant still approves it if the requester's authority is restored.
    //
    // A DENIAL is deliberately NOT gated: denying disposes of a stale request
    // and extends nobody's reach, so an administrator can always clear one.
    if (input.approve && !(await holdsPlatformSupportAuthority(executor, requesterUserLinkId))) {
      return null;
    }

    // The grant is SPENT here, by the one primitive that knows how: it binds
    // tenant, user, action and resource, refuses an already-consumed or expired
    // grant, and refuses anything below fresh_and_mfa_policy — all in the single
    // atomic UPDATE that consumes it. The id it returns is the evidence written
    // to the request below (UNIQUE, so the database agrees a grant approves once).
    let approvalGrantId: string | null = null;
    if (input.approve) {
      approvalGrantId = await consumeReauthenticationGrantReturningId(executor, {
        grant: input.approvalGrant ?? '',
        tenantId: targetTenantId,
        userLinkId: actor,
        action: SUPPORT_APPROVE_ACTION,
        resourceType: SUPPORT_REQUEST_RESOURCE_TYPE,
        resourceId: input.requestId,
        requiredAssurance: 'fresh_and_mfa_policy',
      });
      if (approvalGrantId === null) return null;
    }
    const updated = await executor.query(
      `UPDATE support_access_requests
          SET status = $3,
              decided_by_user_link_id = $2,
              decided_at = NOW(),
              approval_grant_id = $4,
              updated_by_user_link_id = $2,
              authorization_version = authorization_version + 1
        WHERE request_id = $1 AND status = 'pending'
        RETURNING *`,
      [input.requestId, actor, input.approve ? 'approved' : 'denied', approvalGrantId],
    );
    if (updated.rows.length === 0) return null;
    const row = updated.rows[0] as Row;
    const request = mapSupportAccessRequest(row);

    await recordMutation(executor, {
      tenantId: request.tenantId,
      entityType: 'support_access_request',
      entityId: request.requestId,
      eventType: input.approve ? 'identity.support.approved' : 'identity.support.denied',
      actingUserLinkId: actor,
      authorizationVersion: version(row),
      details: { requester_user_link_id: request.requesterUserLinkId },
    });
    if (!input.approve) return null;
    return startSupportSessionWithin(executor, actor, request);
  });
}

/**
 * Revocation ends access on the very next policy decision — for a window that is
 * still RUNNING.
 *
 * ── FBL-020-R5 §1.10: EXPIRY TAKES PRECEDENCE OVER A LATE REVOCATION ───────
 *
 * A support window that has passed its `expires_at` has already ended, and it ended
 * BY THE CLOCK. §1.10 requires that such a window receive the expiry transition and
 * that a later human revocation must not steal or relabel that ending.
 *
 * Migration 057 closes half of this already: `sas_ends_once_and_one_way` refuses a
 * row carrying both endings, so once the sweep has recorded an expiry a revocation
 * fails loudly. The half it did NOT close is the window between the expiry INSTANT
 * passing and the sweep running — typically the whole interval between two worker
 * passes. In that window this statement's only predicate was `revoked_at IS NULL`,
 * so a revocation landed, `sas_ends_once_and_one_way` then made the row
 * unexpirable, and the trail recorded `identity.support.revoked` — naming a person
 * as the author of an ending that a clock had already made. The operator's answer
 * to "who ended this access" was wrong, and the `identity.support.expired` event
 * the audit inventory promises was never written.
 *
 * Both predicates below are therefore load-bearing, and they are different facts:
 * `expired_at IS NULL` refuses to relabel an ending the sweep has already recorded,
 * and `expires_at > NOW()` refuses to steal one it has not recorded yet.
 *
 * The answer is `false` — the same answer this function already gives for a window
 * that is gone, unknown, or one the caller has no authority over. A revocation that
 * changed nothing must not report that it did.
 */
/**
 * FBL-020-R5 §1.10 — "this window is still RUNNING", written ONCE.
 *
 * Three facts, and each one is load-bearing for a different reason: `revoked_at IS
 * NULL` (nobody has ended it already), `expired_at IS NULL` (the sweep has not
 * recorded its ending) and `expires_at > NOW()` (the clock has not ended it yet,
 * whether or not the sweep has noticed).
 *
 * It is a constant rather than two hand-written copies because the revocation below
 * asks the question TWICE — once to authorize and once to write — and a guard that
 * only one of them carried would be no guard at all: whichever copy was dropped, the
 * other would still refuse, and no test could tell the two apart.
 */
const SUPPORT_SESSION_STILL_RUNNING_SQL = `revoked_at IS NULL
          AND expired_at IS NULL AND expires_at > NOW()`;

export async function revokeSupportSession(input: {
  supportSessionId: string;
  revokedByUserLinkId: string;
}): Promise<boolean> {
  return withTransaction(async (executor) => {
    const actor = await requireActor(executor, input.revokedByUserLinkId);
    // R3 section I: revocation is an authorized, scoped, attributable act.
    const target = await executor.query(
      `SELECT tenant_id, actor_user_link_id FROM support_access_sessions
        WHERE support_session_id = $1 AND ${SUPPORT_SESSION_STILL_RUNNING_SQL}`,
      [input.supportSessionId],
    );
    if (target.rows.length === 0) return false;
    const sessionTenantId = String((target.rows[0] as Row).tenant_id);
    const isAdmin = await mayActTenantWide(executor, SUPPORT_REVOKE_ACTION, sessionTenantId, actor);
    // the support actor may always end their OWN session early
    const isOwnActor = String((target.rows[0] as Row).actor_user_link_id) === actor;
    if (!isAdmin && !isOwnActor) return false;

    const updated = await executor.query(
      `UPDATE support_access_sessions
          SET revoked_at = NOW(),
              revoked_by_user_link_id = $2,
              updated_by_user_link_id = $2,
              authorization_version = authorization_version + 1
        -- §1.10 again, on the WRITE, and the SAME text. The read above can be
        -- overtaken: the sweep may claim and expire this row between the authority
        -- check and here, and the loser of that race must change nothing rather
        -- than relabel the ending.
        WHERE support_session_id = $1 AND ${SUPPORT_SESSION_STILL_RUNNING_SQL}
        RETURNING tenant_id, actor_user_link_id, authorization_version`,
      [input.supportSessionId, actor],
    );
    if (updated.rows.length === 0) return false;
    const row = updated.rows[0] as Row;
    await recordMutation(executor, {
      tenantId: String(row.tenant_id),
      entityType: 'support_access_session',
      entityId: input.supportSessionId,
      eventType: 'identity.support.revoked',
      actingUserLinkId: actor,
      authorizationVersion: version(row),
      details: { actor_user_link_id: String(row.actor_user_link_id) },
    });
    return true;
  });
}

// ── SUPPORT ACCESS EXPIRY (the transition nobody was making) ───────────────

/**
 * FBL-020-R4 §4 — the event type an EXPIRED support window is recorded under.
 *
 * Deliberately distinct from `identity.support.revoked`: a revocation names the
 * person who ended the access early, an expiry names nobody because nobody acted.
 * Collapsing them would make the trail claim a decision where there was only a
 * clock.
 */
export const SUPPORT_SESSION_EXPIRED_EVENT = 'identity.support.expired';

/** How many lapsed sessions ONE pass will transition. Bounded on purpose. */
export const SUPPORT_EXPIRY_DEFAULT_BATCH = 200;
const SUPPORT_EXPIRY_MAX_BATCH = 1000;

/** What the processor reports about ONE recorded expiry. */
export interface SupportSessionExpiry {
  readonly supportSessionId: string;
  readonly requestId: string;
  readonly tenantId: string;
  /** The platform-support person whose window closed. */
  readonly actorUserLinkId: string;
  readonly expiresAt: Date;
  readonly expiredAt: Date;
  /** The version the row now carries — always exactly one more than before. */
  readonly authorizationVersion: number;
  /** The single audit row written in the transition's own transaction. */
  readonly auditEventId: string;
}

/**
 * FBL-020-R4 §4 — RECORDS THE EXPIRY OF EVERY LAPSED SUPPORT SESSION, EXACTLY
 * ONCE, WITH NO QUEUE AND NO OUTBOX.
 *
 * WHAT WAS MISSING. `support-access.ts` FILTERED expired sessions out of its
 * reads and the policy engine did the same, so access stopped at the right
 * instant — and that was the whole of it. No row changed, no authorization
 * version advanced, and no audit event was written, so `audit_events` recorded
 * every support window that a person ended and none that simply ran out. This is
 * the transition, and it is the only writer of `expired_at`.
 *
 * HOW EXACTLY-ONCE IS OBTAINED WITHOUT A QUEUE. The claim and the transition are
 * ONE statement: `expired_at IS NULL` is both the predicate that selects the work
 * and the predicate the write invalidates, so the row leaves the claim set by
 * being processed, under the row lock the UPDATE itself holds until it commits.
 * Two things follow, and they are the two properties the order demands:
 *
 *   - REPETITION is idempotent: a second pass finds `expired_at IS NOT NULL` and
 *     matches nothing, so it writes no second audit row and advances no version.
 *   - CONCURRENCY is safe for THE SAME REASON, not a different one: the loser of a
 *     race re-checks `expired_at IS NULL` against the row as the winner left it and
 *     matches zero rows.
 *
 * `FOR UPDATE SKIP LOCKED` sits on top of that as a LIVENESS choice, and it is
 * worth being exact about what it does and does not buy — it stops N workers from
 * convoying behind one row, and nothing more. Removing it was MEASURED: every
 * assertion in `tests/support-expiry.test.ts` still passes without it, including the
 * concurrent one, because READ COMMITTED re-evaluates the predicate after a lock
 * wait. Removing the `expired_at IS NULL` predicate instead fails both the
 * idempotency test and the concurrency test. That is the honest statement of where
 * the correctness lives, and it is written here so the next reader does not mistake
 * the throughput hint for the guarantee.
 *
 * WHY THE AUDIT ROW NAMES NO ACTOR. `actor_user_id` is NULL and the details say
 * `actor_type: 'system'`. Attributing a clock to a person would be a lie of
 * exactly the kind the attribution rules exist to prevent, and the platform actor
 * whose window closed is recorded as the SUBJECT of the event (`actor_user_link_id`
 * in the details), not as its author. The row is still written in the SAME
 * transaction as the transition, so a recorded expiry without its audit event —
 * or an audit event for a transition that rolled back — is not a reachable state.
 *
 * The free-text support reason is not read, not joined and not recorded.
 */
export async function expireDueSupportSessions(options?: {
  limit?: number;
}): Promise<SupportSessionExpiry[]> {
  const requested = options?.limit ?? SUPPORT_EXPIRY_DEFAULT_BATCH;
  if (!Number.isInteger(requested) || requested < 1 || requested > SUPPORT_EXPIRY_MAX_BATCH) {
    throw new RangeError(
      `support expiry batch limit must be an integer in 1..${SUPPORT_EXPIRY_MAX_BATCH}`,
    );
  }
  const recorded: SupportSessionExpiry[] = [];
  for (let i = 0; i < requested; i += 1) {
    const one = await withTransaction<SupportSessionExpiry | null>(async (executor) => {
      // ONE statement claims and transitions. The subquery's SKIP LOCKED is what
      // makes a second worker take a different row instead of waiting for this
      // one, and `expired_at IS NULL` is what makes it take no row at all once
      // there are none left to record.
      const claimed = await executor.query(
        `UPDATE support_access_sessions
            SET expired_at = NOW(),
                authorization_version = authorization_version + 1
          WHERE support_session_id = (
            SELECT s.support_session_id
              FROM support_access_sessions s
             WHERE s.revoked_at IS NULL
               AND s.expired_at IS NULL
               AND s.expires_at <= NOW()
             ORDER BY s.expires_at
             FOR UPDATE SKIP LOCKED
             LIMIT 1
          )
          RETURNING support_session_id, request_id, tenant_id, actor_user_link_id,
                    expires_at, expired_at, authorization_version`,
        [],
      );
      if (claimed.rows.length === 0) return null;
      const row = claimed.rows[0] as Row;
      const supportSessionId = String(row.support_session_id);
      const tenantId = String(row.tenant_id);
      const actorUserLinkId = String(row.actor_user_link_id);
      const requestId = String(row.request_id);
      const authorizationVersion = version(row);
      // The audit row is written HERE, in the transition's transaction, and it
      // names no author because none exists. `recordMutation` is deliberately not
      // reused: its contract is an attributable human actor, and pretending to
      // have one is the failure this comment exists to refuse.
      const written = await executor.query(
        `INSERT INTO audit_events
           (tenant_id, event_type, entity_type, entity_id, actor_user_id, details)
         VALUES ($1, $2, 'support_access_session', $3, NULL, $4)
         RETURNING event_id`,
        [
          tenantId,
          SUPPORT_SESSION_EXPIRED_EVENT,
          supportSessionId,
          JSON.stringify({
            actor_type: 'system',
            processor: 'support_access_expiry',
            request_id: requestId,
            actor_user_link_id: actorUserLinkId,
            expires_at: ts(row.expires_at).toISOString(),
            authorization_version: authorizationVersion,
          }),
        ],
      );
      return {
        supportSessionId,
        requestId,
        tenantId,
        actorUserLinkId,
        expiresAt: ts(row.expires_at),
        expiredAt: ts(row.expired_at),
        authorizationVersion,
        auditEventId: String((written.rows[0] as Row).event_id),
      };
    });
    if (one === null) break;
    recorded.push(one);
  }
  return recorded;
}
