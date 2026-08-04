/**
 * UserLink lifecycle (FBL-020): the internal record binding a provider
 * identity to a tenant (or to platform scope). A link NEVER carries
 * privilege by itself — a freshly activated link has zero role bindings and
 * deny-by-default applies everywhere. Every lifecycle change writes a
 * transactional audit_events row (the durable outbox is FBL-040 scope; no
 * delivery guarantee is claimed here).
 */
import { randomUUID } from 'node:crypto';
import { withTransaction, type Executor } from '@dealer/database';
import { IDENTITY_PROVIDER_WORKOS, type IdentityProviderKind } from './contracts';

export type ActorScope = 'dealership' | 'platform';
export type UserLinkStatus = 'pending' | 'activated' | 'deactivated';

export interface UserLink {
  readonly userLinkId: string;
  readonly actorScope: ActorScope;
  readonly tenantId: string | null;
  readonly provider: IdentityProviderKind;
  readonly providerUserId: string;
  readonly email: string | null;
  readonly displayName: string | null;
  readonly status: UserLinkStatus;
  readonly activatedAt: Date | null;
}

interface Row {
  [key: string]: unknown;
}

function mapUserLink(r: Row): UserLink {
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

async function writeAudit(
  executor: Executor,
  input: {
    tenantId: string | null;
    eventType: string;
    entityId: string;
    actorUserId: string | null;
    details: Record<string, unknown>;
  },
): Promise<void> {
  // audit_events.tenant_id is NOT NULL; platform-scope identity events are
  // recorded under the nil tenant so the row is still written transactionally.
  await executor.query(
    `INSERT INTO audit_events (tenant_id, event_type, entity_type, entity_id, actor_user_id, details)
     VALUES ($1, $2, 'user_link', $3, $4, $5)`,
    [
      input.tenantId ?? '00000000-0000-0000-0000-000000000000',
      input.eventType,
      input.entityId,
      input.actorUserId,
      JSON.stringify(input.details),
    ],
  );
}

/**
 * Resolves which internal home — a tenant, or platform scope — an external
 * provider organization maps to. Only ACTIVE connections resolve; an unknown
 * organization resolves to nothing and the login fails closed.
 */
export async function resolveConnectionByOrganization(
  executor: Executor,
  provider: IdentityProviderKind,
  providerOrganizationId: string,
): Promise<{ connectionScope: ActorScope; tenantId: string | null } | null> {
  const result = await executor.query(
    `SELECT connection_scope, tenant_id FROM identity_provider_connections
      WHERE provider = $1 AND provider_organization_id = $2 AND status = 'active'`,
    [provider, providerOrganizationId],
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0] as Row;
  return {
    connectionScope: String(row.connection_scope) as ActorScope,
    tenantId: row.tenant_id === null ? null : String(row.tenant_id),
  };
}

export async function findUserLink(
  executor: Executor,
  provider: IdentityProviderKind,
  tenantId: string | null,
  providerUserId: string,
): Promise<UserLink | null> {
  const result = await executor.query(
    `SELECT * FROM user_links
      WHERE provider = $1 AND tenant_id IS NOT DISTINCT FROM $2 AND provider_user_id = $3`,
    [provider, tenantId, providerUserId],
  );
  return result.rows.length > 0 ? mapUserLink(result.rows[0] as Row) : null;
}

/**
 * First-login path: ensures an ACTIVATED link exists for this provider
 * identity in this home, granting NO role. A pre-provisioned pending link is
 * activated; a missing link is created activated (membership in the provider
 * organization is what admitted the person; privilege still requires explicit
 * RoleBindings). A deactivated link stays deactivated — reactivation is an
 * explicit administrative act, not a side effect of logging in.
 */
/**
 * FBL-020-R1 (section B): the LOGIN path. It never activates anything.
 *
 * A first login may create ONE idempotent PENDING link so an administrator
 * has something to activate; a subsequent login may refresh bounded provider
 * identifiers on that pending record. Neither grants access: the caller must
 * check `status === 'activated'` before minting a session, and a pending,
 * deactivated or ineffective link yields no session and no dealership access.
 *
 * Activation is an explicit, attributable administrative act
 * (`activateUserLink`) or the auditable bootstrap command — never a side
 * effect of presenting a valid token.
 */
export async function observeUserLinkOnLogin(input: {
  tenantId: string | null;
  provider?: IdentityProviderKind;
  providerUserId: string;
  email: string | null;
  displayName: string | null;
}): Promise<UserLink | null> {
  const provider = input.provider ?? IDENTITY_PROVIDER_WORKOS;
  return withTransaction((executor) => observeWithinTransaction(executor, provider, input, 0));
}

async function observeWithinTransaction(
  executor: Executor,
  provider: IdentityProviderKind,
  input: {
    tenantId: string | null;
    providerUserId: string;
    email: string | null;
    displayName: string | null;
  },
  attempt: number,
): Promise<UserLink | null> {
  const existing = await findUserLink(executor, provider, input.tenantId, input.providerUserId);

  if (existing !== null) {
    if (existing.status === 'deactivated') {
      // A deactivated identity is refused outright; login never resurrects it.
      await writeAudit(executor, {
        tenantId: existing.tenantId,
        eventType: 'identity.user_link.login_refused',
        entityId: existing.userLinkId,
        actorUserId: existing.userLinkId,
        details: { provider, reason: 'deactivated' },
      });
      return null;
    }
    if (existing.status === 'pending') {
      // Bounded identifier refresh ONLY. Status is untouched.
      const refreshed = await executor.query(
        `UPDATE user_links SET email = $2, display_name = $3
          WHERE user_link_id = $1 AND status = 'pending' RETURNING *`,
        [existing.userLinkId, input.email, input.displayName],
      );
      if (refreshed.rows.length === 0) return null;
      await writeAudit(executor, {
        tenantId: existing.tenantId,
        eventType: 'identity.user_link.pending_login_refused',
        entityId: existing.userLinkId,
        actorUserId: existing.userLinkId,
        details: { provider, status: 'pending' },
      });
      return mapUserLink(refreshed.rows[0] as Row);
    }
    // activated: refresh display metadata only; privilege is untouched
    const updated = await executor.query(
      `UPDATE user_links SET email = $2, display_name = $3
        WHERE user_link_id = $1 RETURNING *`,
      [existing.userLinkId, input.email, input.displayName],
    );
    return mapUserLink(updated.rows[0] as Row);
  }

  // Unknown provider identity: record it as PENDING so an administrator can
  // act on it. Concurrent first logins race on the unique claim; DO NOTHING
  // plus one bounded re-read keeps the loser correct.
  const created = await executor.query(
    `INSERT INTO user_links
       (user_link_id, actor_scope, tenant_id, provider, provider_user_id, email, display_name, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
     ON CONFLICT DO NOTHING
     RETURNING *`,
    [
      randomUUID(),
      input.tenantId === null ? 'platform' : 'dealership',
      input.tenantId,
      provider,
      input.providerUserId,
      input.email,
      input.displayName,
    ],
  );
  if (created.rows.length === 0) {
    if (attempt >= 1) throw new Error('user link claim raced twice — refusing to loop');
    return observeWithinTransaction(executor, provider, input, attempt + 1);
  }
  const link = mapUserLink(created.rows[0] as Row);
  await writeAudit(executor, {
    tenantId: link.tenantId,
    eventType: 'identity.user_link.pending_created',
    entityId: link.userLinkId,
    actorUserId: link.userLinkId,
    details: { provider, status: 'pending', granted_roles: 0 },
  });
  return link;
}

/**
 * The EXPLICIT activation path (section B.4). Requires an attributable
 * administrator, activates only a pending link, and creates NO RoleBinding —
 * an activated identity with no bindings can still do nothing.
 */
export async function activateUserLink(input: {
  userLinkId: string;
  activatedByUserLinkId: string;
}): Promise<UserLink | null> {
  return withTransaction(async (executor) => {
    // FBL-020-R2: activation BINDS the link to exactly one active provider
    // connection. The join supplies connection, issuer and organization; if
    // the tenant has zero or more than one active connection the join yields
    // nothing and activation is refused, because guessing which organization
    // a person belongs to is precisely what R2 forbids.
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
      [input.userLinkId, input.activatedByUserLinkId],
    );
    if (activated.rows.length === 0) return null;
    const link = mapUserLink(activated.rows[0] as Row);
    await writeAudit(executor, {
      tenantId: link.tenantId,
      eventType: 'identity.user_link.activated',
      entityId: link.userLinkId,
      actorUserId: input.activatedByUserLinkId,
      details: { transition: 'pending->activated', granted_roles: 0 },
    });
    return link;
  });
}

/** Pre-provisioning path used by administrators: creates a PENDING link. */
export async function createPendingUserLink(input: {
  tenantId: string | null;
  provider?: IdentityProviderKind;
  providerUserId: string;
  email: string | null;
  createdByUserLinkId: string | null;
}): Promise<UserLink> {
  const provider = input.provider ?? IDENTITY_PROVIDER_WORKOS;
  return withTransaction(async (executor) => {
    const created = await executor.query(
      `INSERT INTO user_links
         (user_link_id, actor_scope, tenant_id, provider, provider_user_id, email, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending')
       RETURNING *`,
      [
        randomUUID(),
        input.tenantId === null ? 'platform' : 'dealership',
        input.tenantId,
        provider,
        input.providerUserId,
        input.email,
      ],
    );
    const link = mapUserLink(created.rows[0] as Row);
    await writeAudit(executor, {
      tenantId: link.tenantId,
      eventType: 'identity.user_link.provisioned',
      entityId: link.userLinkId,
      actorUserId: input.createdByUserLinkId,
      details: { provider, status: 'pending' },
    });
    return link;
  });
}

/** Administrative deactivation: sessions die with it (enforced at read time). */
export async function deactivateUserLink(input: {
  userLinkId: string;
  deactivatedByUserLinkId: string | null;
}): Promise<boolean> {
  return withTransaction(async (executor) => {
    const updated = await executor.query(
      `UPDATE user_links
          SET status = 'deactivated',
              deactivated_at = NOW(),
              deactivated_by_user_link_id = $2,
              updated_by_user_link_id = $2,
              authorization_version = authorization_version + 1
        WHERE user_link_id = $1 AND status <> 'deactivated' RETURNING tenant_id`,
      [input.userLinkId, input.deactivatedByUserLinkId],
    );
    if (updated.rows.length === 0) return false;
    const row = updated.rows[0] as Row;
    await writeAudit(executor, {
      tenantId: row.tenant_id === null ? null : String(row.tenant_id),
      eventType: 'identity.user_link.deactivated',
      entityId: input.userLinkId,
      actorUserId: input.deactivatedByUserLinkId,
      details: { transition: '->deactivated' },
    });
    return true;
  });
}
