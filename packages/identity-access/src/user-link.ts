/**
 * UserLink LOOKUPS and login OBSERVATION (FBL-020): the internal record binding
 * a provider identity to a tenant (or to platform scope). A link NEVER carries
 * privilege by itself — a freshly activated link has zero role bindings and
 * deny-by-default applies everywhere.
 *
 * FBL-020-R3: the lifecycle MUTATIONS (provision, activate, deactivate, relink)
 * moved to ./mutations.ts, which owns every write that can change what an actor
 * may do. What remains here reads, or observes a login — and a login grants
 * nothing: it may create or refresh a PENDING claim and nothing more.
 *
 * EVERY branch of that observation writes its transactional audit_events row —
 * refused, pending AND activated. (R3 correction C2: the activated branch, the
 * only one that goes on to mint a session, used to write nothing, so the trail
 * recorded precisely the logins that did NOT get in.) The durable outbox is
 * FBL-040 scope; no delivery guarantee is claimed here.
 *
 * What an observation does NOT do is advance `authorization_version`. It cannot
 * change what an actor may do: the only fields it may rewrite are `email` and
 * `display_name`, and neither is an authorization input. Advancing the version
 * for a cosmetic profile edit would invalidate cached authorization while
 * asserting a privilege change that never happened. Every write that CAN change
 * privilege lives in ./mutations.ts, and every one of those does advance it.
 */
import { randomUUID } from 'node:crypto';
import { withTransaction, type Executor } from '@dealer/database';
import {
  IDENTITY_PROVIDER_WORKOS,
  type ActorScope,
  type IdentityProviderKind,
  type UserLink,
} from './contracts';
import { mapUserLink } from './mutations';

interface Row {
  [key: string]: unknown;
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

/**
 * FBL-020-R3 — the SIX facts that identify a provider identity.
 *
 * R2 looked links up by (provider, tenant, subject) alone. That is not an
 * identity: two provider organizations can map to the same tenant, and a
 * remapped or replaced connection leaves the old link sitting there with the
 * old subject. A three-fact lookup happily returns it, and the person inherits
 * an account that was never issued to them under the new organization.
 *
 * Every lookup therefore requires and COMPARES connection, issuer and provider
 * organization as well. There is no three-fact overload to fall back to.
 */
export interface ProviderIdentityFacts {
  readonly provider: IdentityProviderKind;
  readonly tenantId: string | null;
  readonly providerUserId: string;
  readonly connectionId: string;
  readonly issuer: string;
  readonly providerOrganizationId: string;
}

function identityParams(facts: ProviderIdentityFacts): unknown[] {
  return [
    facts.provider,
    facts.tenantId,
    facts.providerUserId,
    facts.connectionId,
    facts.issuer,
    facts.providerOrganizationId,
  ];
}

/**
 * The AUTHENTICATION lookup: a link is returned only when all six facts match
 * the stored row. A link bound to any other connection, issuer or organization
 * is not this identity and is never returned.
 *
 * Status is deliberately NOT filtered — callers report a pending link
 * distinctly from a missing one without ever treating it as access.
 */
export async function findBoundUserLink(
  executor: Executor,
  facts: ProviderIdentityFacts,
): Promise<UserLink | null> {
  const result = await executor.query(
    `SELECT * FROM user_links
      WHERE provider = $1
        AND tenant_id IS NOT DISTINCT FROM $2::uuid
        AND provider_user_id = $3
        AND connection_id = $4::uuid
        AND issuer = $5
        AND provider_organization_id = $6`,
    identityParams(facts),
  );
  return result.rows.length > 0 ? mapUserLink(result.rows[0] as Row) : null;
}

/**
 * The LOGIN-OBSERVATION lookup. Same six facts, with ONE deliberate widening:
 * a PENDING claim that has not been bound to a connection yet also matches,
 * because the schema (migration 057, `ul_activated_is_bound`) only demands a
 * binding once a link is ACTIVATED. Nothing else is widened — a link already
 * bound to a different connection stays invisible here too, so a login can
 * never re-home an identity into an organization it does not belong to.
 */
async function findUserLinkClaim(
  executor: Executor,
  facts: ProviderIdentityFacts,
): Promise<UserLink | null> {
  const result = await executor.query(
    `SELECT * FROM user_links
      WHERE provider = $1
        AND tenant_id IS NOT DISTINCT FROM $2::uuid
        AND provider_user_id = $3
        AND (
          (connection_id = $4::uuid AND issuer = $5 AND provider_organization_id = $6)
          OR (status = 'pending' AND connection_id IS NULL)
        )`,
    identityParams(facts),
  );
  return result.rows.length > 0 ? mapUserLink(result.rows[0] as Row) : null;
}

/**
 * The links that already claim (provider, tenant, subject) but are bound
 * ELSEWHERE. Returns ids only — never a UserLink — so it can never be pressed
 * into service as the three-fact lookup this revision removed.
 *
 * It exists because the unique claim is (tenant, provider, provider_user_id):
 * without this probe, a login after an organization remap would find no claim,
 * attempt an insert, lose the unique constraint and look like a lost race.
 */
async function foreignBoundClaimIds(
  executor: Executor,
  facts: ProviderIdentityFacts,
): Promise<string[]> {
  const result = await executor.query(
    `SELECT user_link_id FROM user_links
      WHERE provider = $1
        AND tenant_id IS NOT DISTINCT FROM $2::uuid
        AND provider_user_id = $3
        AND (
          connection_id IS DISTINCT FROM $4::uuid
          OR issuer IS DISTINCT FROM $5
          OR provider_organization_id IS DISTINCT FROM $6
        )`,
    identityParams(facts),
  );
  return (result.rows as Row[]).map((r) => String(r.user_link_id));
}

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
  /**
   * R3: the connection the login actually came through. The caller has just
   * resolved it from the verified organization, so there is nothing to guess —
   * and passing it is what stops a login re-homing an identity that belongs to
   * another organization.
   */
  connectionId: string;
  issuer: string;
  providerOrganizationId: string;
}): Promise<UserLink | null> {
  return withTransaction((executor) => observeUserLinkOnLoginWithin(executor, input));
}

/**
 * FBL-020-R4 section 1 — the SAME observation on a caller's executor.
 *
 * Login ADMISSION has to observe the identity and then judge the resulting link
 * against the connection, the tenant and the effective windows. Doing that
 * across two transactions means the link can be observed into existence against
 * one picture and admitted against another; sharing one transaction is what
 * makes the admission a single decision. The public wrapper above owns its own
 * transaction for callers that need nothing else.
 */
export async function observeUserLinkOnLoginWithin(
  executor: Executor,
  input: {
    tenantId: string | null;
    provider?: IdentityProviderKind;
    providerUserId: string;
    email: string | null;
    displayName: string | null;
    connectionId: string;
    issuer: string;
    providerOrganizationId: string;
  },
): Promise<UserLink | null> {
  const facts: ProviderIdentityFacts = {
    provider: input.provider ?? IDENTITY_PROVIDER_WORKOS,
    tenantId: input.tenantId,
    providerUserId: input.providerUserId,
    connectionId: input.connectionId,
    issuer: input.issuer,
    providerOrganizationId: input.providerOrganizationId,
  };
  return observeWithinTransaction(executor, facts, input, 0);
}

async function observeWithinTransaction(
  executor: Executor,
  facts: ProviderIdentityFacts,
  input: {
    tenantId: string | null;
    providerUserId: string;
    email: string | null;
    displayName: string | null;
  },
  attempt: number,
): Promise<UserLink | null> {
  const provider = facts.provider;
  const existing = await findUserLinkClaim(executor, facts);

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
    // FBL-020-R3 correction C2: the SUCCESSFUL login is audited too.
    //
    // The refused and pending branches above each wrote their row, and this one
    // — the only branch that goes on to mint a session — wrote nothing, so the
    // trail recorded every login that was turned away and none that got in.
    //
    // The details say WHICH stored fields the provider profile rewrote and never
    // what they were rewritten to: an email or a display name in an audit row is
    // PII in a table read for security purposes, and neither value is an
    // authorization input. `authorization_version` is deliberately NOT advanced —
    // a display-name change grants and revokes nothing, and inflating the version
    // would invalidate cached authorization for a cosmetic edit.
    const link = mapUserLink(updated.rows[0] as Row);
    await writeAudit(executor, {
      tenantId: link.tenantId,
      eventType: 'identity.user_link.login_observed',
      entityId: link.userLinkId,
      actorUserId: link.userLinkId,
      details: {
        provider,
        status: 'activated',
        email_changed: existing.email !== link.email,
        display_name_changed: existing.displayName !== link.displayName,
      },
    });
    return link;
  }

  // R3: the identity claims (tenant, provider, subject), but is bound to a
  // DIFFERENT connection, issuer or organization. That is not this person's
  // account and a login must not adopt it — nor may it insert a second row,
  // because the unique claim would refuse one anyway. Refused, and audited
  // against the link that actually holds the claim.
  const foreign = await foreignBoundClaimIds(executor, facts);
  if (foreign.length > 0) {
    for (const userLinkId of foreign) {
      await writeAudit(executor, {
        tenantId: input.tenantId,
        eventType: 'identity.user_link.login_refused',
        entityId: userLinkId,
        actorUserId: null,
        details: { provider, reason: 'bound_to_another_connection' },
      });
    }
    return null;
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
    return observeWithinTransaction(executor, facts, input, attempt + 1);
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
 * The lifecycle MUTATIONS — provision, activate, deactivate, relink — are NOT
 * here. They live in ./mutations.ts, which owns every write that can change
 * what an actor may do: an explicit true actor, an advancing
 * authorization_version, and one audit row in the same transaction. This module
 * keeps the LOOKUPS and the login OBSERVATION, which grant nothing.
 */
