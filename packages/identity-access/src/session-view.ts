/**
 * FBL-020-R3 — the BOUNDED description of an authenticated session.
 *
 * `GET /auth/session` used to answer with whatever the request identity
 * happened to carry, which meant the endpoint's contract was "everything we
 * know". This module states the contract instead, as a closed set of eight
 * facts, and the route can return nothing else because nothing else is here:
 *
 *   1. the INTERNAL user id           — the user_link_id, never the provider's
 *                                       subject and never an email
 *   2. the tenant                     — the internal boundary, or null for a
 *                                       platform actor
 *   3. the effective organization-scope summary
 *   4. the active role summary
 *   5. computed freshness             — the same classification the next policy
 *                                       decision would record
 *   6. the MFA classification        — likewise
 *   7. local-session expiry          — of the LOCAL session, which is the
 *                                       thing an operator can revoke
 *   8. active support state + expiry — non-suppressible
 *
 * What is deliberately ABSENT, and must stay absent: email, display name, any
 * provider profile field, the provider subject, the provider session id, the
 * access or refresh token, refresh state, and the reason text on a support
 * request. None of them is an authorization input, so publishing them buys a
 * client nothing and costs the tenant a disclosure.
 */
import { query } from '@dealer/database';
import { EFFECTIVE_ROLE_BINDING_SQL, classifyActorAssurance } from './policy';
import { listActiveSupportSessions } from './support-access';
import type { ActorScope } from './contracts';
import type { FreshnessClassification, MfaAssuranceClassification } from './policy';

interface Row {
  [key: string]: unknown;
}

/**
 * One scope an EFFECTIVE role binding reaches, and whether the organization
 * node it names is effective RIGHT NOW. Archiving a rooftop revokes every
 * binding beneath it without touching a `role_bindings` row, so a summary that
 * only listed the bindings would over-report the actor's reach.
 *
 * `effective` therefore answers ONE question — is the organization NODE live —
 * and it is only ever asked about a binding that already passed
 * `EFFECTIVE_ROLE_BINDING_SQL`. A binding outside its own window is absent from
 * this list entirely rather than present with `effective: false`, because the
 * page must not offer authority the engine denies in any form.
 */
export interface EffectiveScope {
  readonly level: string;
  /** The organization node, or null at platform and resource level. */
  readonly id: string | null;
  readonly effective: boolean;
}

export interface OrganizationScopeSummary {
  readonly actorScope: ActorScope;
  /** The acting tenant is active and inside its effective window. */
  readonly tenantEffective: boolean;
  readonly scopes: readonly EffectiveScope[];
}

export interface ActiveSupportState {
  readonly supportSessionId: string;
  readonly actorUserLinkId: string;
  readonly grantedAt: Date;
  readonly expiresAt: Date;
}

export interface AuthenticatedSessionView {
  readonly userLinkId: string;
  readonly tenantId: string | null;
  readonly organizationScope: OrganizationScopeSummary;
  readonly roles: readonly string[];
  readonly freshness: FreshnessClassification;
  readonly mfaAssurance: MfaAssuranceClassification;
  /** The LOCAL session's expiry, or null when this credential has no session. */
  readonly localSessionExpiresAt: Date | null;
  readonly supportAccess: readonly ActiveSupportState[];
}

/**
 * Whether the node a binding names is an ACTIVE, EFFECTIVE organization node,
 * evaluated per level. `platform` has no node — a platform binding is scoped
 * to the platform itself — and `resource` names a business row rather than an
 * organization node, so neither can be resolved through this chain and both
 * report their level honestly instead of inventing an effectiveness.
 */
const SCOPE_EFFECTIVE_SQL = `
      CASE b.scope_level
        WHEN 'platform' THEN TRUE
        WHEN 'tenant' THEN EXISTS (
          SELECT 1 FROM tenants t
           WHERE t.tenant_id = b.scope_id AND t.status = 'active'
             AND t.effective_from <= NOW()
             AND (t.effective_to IS NULL OR t.effective_to > NOW()))
        WHEN 'dealer_group' THEN EXISTS (
          SELECT 1 FROM dealer_groups g
           WHERE g.dealer_group_id = b.scope_id AND g.status = 'active'
             AND g.effective_from <= NOW()
             AND (g.effective_to IS NULL OR g.effective_to > NOW()))
        WHEN 'legal_entity' THEN EXISTS (
          SELECT 1 FROM legal_entities le
           WHERE le.legal_entity_id = b.scope_id AND le.status = 'active'
             AND le.effective_from <= NOW()
             AND (le.effective_to IS NULL OR le.effective_to > NOW()))
        WHEN 'rooftop' THEN EXISTS (
          SELECT 1 FROM rooftops r
           WHERE r.rooftop_id = b.scope_id AND r.status = 'active'
             AND r.effective_from <= NOW()
             AND (r.effective_to IS NULL OR r.effective_to > NOW()))
        WHEN 'department' THEN EXISTS (
          SELECT 1 FROM departments d
           WHERE d.department_id = b.scope_id AND d.status = 'active'
             AND d.effective_from <= NOW()
             AND (d.effective_to IS NULL OR d.effective_to > NOW()))
        ELSE FALSE
      END`;

/**
 * Builds the bounded view. Three reads: the bindings-and-scopes summary, the
 * live local session, and the actor's assurance classification (plus the
 * tenant's live support sessions, which are a tenant-wide fact rather than an
 * actor one). Nothing is taken from the caller except the identity the
 * middleware already proved.
 */
export async function describeAuthenticatedSession(input: {
  userLinkId: string;
  tenantId: string | null;
  actorScope: ActorScope;
  /** The LOCAL session this request resolved; null only if it has none. */
  sessionId: string | null;
}): Promise<AuthenticatedSessionView> {
  // FBL-020-R3 correction E1: the bindings this page summarises are the ones
  // the ENGINE would match, by interpolating the engine's own effectiveness
  // predicate. The hand-written `rb.status = 'active'` this replaces was the
  // wave-2 drift the shared constant exists to prevent: a binding left
  // `active` with an `effective_to` a day in the past was reported as a held
  // role, and its scope was reported `effective: true` (the CASE below asks
  // only whether the organization NODE is live), while the policy engine denied
  // every action that binding named. The page now cannot claim authority the
  // engine refuses, because both read the same three conditions.
  const scopeResult = await query(
    `WITH bindings AS (
       SELECT DISTINCT rb.role, rb.scope_level, rb.scope_id
         FROM role_bindings rb
        WHERE rb.user_link_id = $1
          AND ${EFFECTIVE_ROLE_BINDING_SQL}
     )
     SELECT b.role, b.scope_level, b.scope_id, ${SCOPE_EFFECTIVE_SQL} AS scope_effective
       FROM bindings b
      ORDER BY b.scope_level, b.scope_id NULLS FIRST, b.role`,
    [input.userLinkId],
  );

  const roles = new Set<string>();
  const scopes = new Map<string, EffectiveScope>();
  for (const raw of scopeResult.rows) {
    const row = raw as Row;
    roles.add(String(row.role));
    const level = String(row.scope_level);
    const id = row.scope_id === null || row.scope_id === undefined ? null : String(row.scope_id);
    scopes.set(`${level}:${id ?? ''}`, {
      level,
      id,
      effective: row.scope_effective === true,
    });
  }

  const sessionResult =
    input.sessionId === null
      ? null
      : await query(
          `SELECT expires_at FROM identity_sessions
            WHERE session_id = $1 AND revoked_at IS NULL AND expires_at > NOW()`,
          [input.sessionId],
        );
  const sessionRow = sessionResult?.rows[0] as Row | undefined;
  const localSessionExpiresAt =
    sessionRow === undefined
      ? null
      : sessionRow.expires_at instanceof Date
        ? sessionRow.expires_at
        : new Date(String(sessionRow.expires_at));

  const tenantEffective =
    input.tenantId === null
      ? false
      : (
          await query(
            `SELECT 1 FROM tenants
              WHERE tenant_id = $1 AND status = 'active'
                AND effective_from <= NOW()
                AND (effective_to IS NULL OR effective_to > NOW())`,
            [input.tenantId],
          )
        ).rows.length > 0;

  // R3 correction B2: the page reports the assurance of the session THIS
  // request presented — the same session whose expiry it prints just above,
  // and the same classification the next policy decision on this credential
  // will record. Reporting the actor's freshest OTHER session would let the
  // page claim a freshness the presented credential does not have while the
  // audit row (correctly) said otherwise.
  const assurance = await classifyActorAssurance(input.userLinkId, input.sessionId);
  // The NON-SUPPRESSIBLE support indicator: a live support session for this
  // tenant is visible to every session of the tenant, every time.
  const support = input.tenantId === null ? [] : await listActiveSupportSessions(input.tenantId);

  return {
    userLinkId: input.userLinkId,
    tenantId: input.tenantId,
    organizationScope: {
      actorScope: input.actorScope,
      tenantEffective,
      scopes: [...scopes.values()],
    },
    roles: [...roles].sort(),
    freshness: assurance.freshness,
    mfaAssurance: assurance.mfaAssurance,
    localSessionExpiresAt,
    supportAccess: support.map((s) => ({
      supportSessionId: s.supportSessionId,
      actorUserLinkId: s.actorUserLinkId,
      grantedAt: s.grantedAt,
      expiresAt: s.expiresAt,
    })),
  };
}
