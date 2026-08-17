/**
 * The central policy API (FBL-020, ADR-007). ONE code path answers "may this
 * actor perform this action on this resource":
 *
 *   - deny by default; every path out of here is an explicit rule;
 *   - RoleBindings are read from the DATABASE on EVERY decision — revocation
 *     denies the very next request; nothing from a token is consulted;
 *   - scope covers descendants: a binding at tenant/group/entity/rooftop
 *     level covers every resource under that node (ancestry from
 *     @dealer/organization);
 *   - cross-tenant is denied unconditionally;
 *   - a platform binding NEVER grants dealership data access — the only
 *     platform path into a tenant is an approved, live support-access
 *     session restricted to its approved action set and scope;
 *   - and the CONVERSE, which this comment used to leave unsaid: a `platform.*`
 *     action is authorized ONLY by a PLATFORM-SCOPE binding. `role_bindings.role`
 *     is a free text column constrained by a regex, so a tenant-scope binding
 *     can carry a platform role NAME; it still authorizes no platform action.
 *     Scope decides reach, the role column never widens it;
 *   - EVERY decision — allow and deny — writes one append-only
 *     policy_decisions evidence row (ids, codes, versions; never PII).
 *     Evidence is not optional: if the row cannot be written the decision
 *     fails closed with it.
 *
 * The engine owns no action semantics: catalogs are DATA published by their
 * owning modules (Fixed Ops publishes the service catalog; identity-access
 * publishes the identity/organization administration catalog) and composed
 * at the application root, exactly like the resource-scope resolver port —
 * this package never queries a fixed-ops table.
 */
import { randomUUID } from 'node:crypto';
import { query, withTransaction } from '@dealer/database';
import { getRequestContext, type SupportAccessFacts } from '@dealer/platform';
import { resolveAncestry, type OrganizationNodeRef } from '@dealer/organization';
// Role NAMES only, from the package's dependency-free contract module — the
// engine still owns no action semantics and reads no catalog. R3 correction F1
// needs the platform-support role list to re-judge a live support session's
// actor, and that list has exactly one home.
import { EFFECTIVE_MFA_CERTIFICATION_SQL, PLATFORM_SUPPORT_AUTHORITY_ROLES } from './contracts';

export const POLICY_VERSION = 'fbl-020.1';

/**
 * FBL-020-R4 §2.2 — the evidence contract every NEW decision is written under.
 *
 * Migration 057 versions `policy_decisions`: version-1 rows are the historic
 * ones and stay legal and readable exactly as written; version-2 rows must
 * carry the complete evidence set, and a BEFORE INSERT trigger refuses
 * anything below the current version, so the number cannot be used to opt back
 * into the weaker class. It is stated here, once, and interpolated into the one
 * INSERT that writes evidence — there is no second place for it to drift to.
 */
export const CURRENT_EVIDENCE_VERSION = 2;

/**
 * FBL-020-R3 — how long a provider authentication counts as FRESH for the
 * purposes of decision evidence. This classifies; it never authorizes. A
 * sensitive action still demands a reauthentication GRANT, which is proved
 * separately and consumed atomically.
 */
export const AUTHENTICATION_FRESHNESS_WINDOW_SECONDS = 900;

const ACTION_NAME = /^[a-z][a-z0-9_.]{0,127}$/;

export interface ActionDefinition {
  readonly action: string;
  readonly description: string;
  /** null: a tenant-context action with no single resource to resolve */
  readonly resourceType: string | null;
  readonly allowedRoles: readonly string[];
  /** may demand a reauthentication grant on top of an allow */
  readonly sensitive?: boolean;
}

export interface ActionCatalog {
  get(action: string): ActionDefinition | undefined;
  list(): readonly ActionDefinition[];
}

/** Validates names and uniqueness at CONSTRUCTION — a bad catalog never runs. */
export function createActionCatalog(definitions: readonly ActionDefinition[]): ActionCatalog {
  const byName = new Map<string, ActionDefinition>();
  for (const def of definitions) {
    if (!ACTION_NAME.test(def.action)) {
      throw new Error(`invalid action name in catalog: ${def.action}`);
    }
    if (byName.has(def.action)) {
      throw new Error(`duplicate action in catalog: ${def.action}`);
    }
    if (def.allowedRoles.length === 0) {
      throw new Error(`action ${def.action} allows no role — unreachable actions are catalog bugs`);
    }
    byName.set(def.action, def);
  }
  return {
    get: (action) => byName.get(action),
    list: () => [...byName.values()],
  };
}

/** Merges module catalogs at the composition root; collisions are fatal. */
export function mergeActionCatalogs(...catalogs: readonly ActionCatalog[]): ActionCatalog {
  return createActionCatalog(catalogs.flatMap((c) => c.list()));
}

/**
 * Resolves a resource to the organization node it lives under (usually its
 * rooftop). Implemented by the module that OWNS the resource tables (Fixed
 * Ops), composed in the API — identity-access stays out of those tables.
 * Returns null for "no such resource IN THIS TENANT", which is deliberately
 * indistinguishable from cross-tenant.
 */
export type ResourceScopeResolver = (
  tenantId: string,
  resourceType: string,
  resourceId: string,
) => Promise<OrganizationNodeRef | null>;

export type { OrganizationNodeRef };

export interface PolicyActor {
  readonly userLinkId: string;
  readonly actorScope: 'dealership' | 'platform';
  /** dealership actors carry their tenant; platform actors carry null */
  readonly tenantId: string | null;
}

export interface PolicyInput {
  readonly actor: PolicyActor;
  readonly action: string;
  /** the tenant the request TARGETS (defaults to the actor's own tenant) */
  readonly targetTenantId?: string | null;
  readonly resource?: { readonly type: string; readonly id: string } | null;
  /**
   * Where a RESOURCE-LESS action lands in the organization. Creating an
   * appointment names no existing resource, but it does plant one at a
   * rooftop — the caller passes that rooftop here so scope is still enforced.
   * Omitted means the action is genuinely tenant-wide, and only a
   * tenant-scope binding can cover it.
   */
  readonly scopeHint?: OrganizationNodeRef | null;
  /**
   * FBL-020-R3: there is deliberately NO `requestId`, `correlationId`,
   * `freshness` or `mfaAssurance` on this input.
   *
   * The first two used to be caller-supplied, and the caller was the HTTP layer
   * reading `x-request-id` / `x-correlation-id` — so the evidence trail recorded
   * whatever a client chose to send, and recorded NOTHING when it sent nothing.
   * The engine now takes both from the GENERATED request context (or generates
   * them itself off-request), which is the same pair the logs carry.
   *
   * The last two used to default to 'not_applicable' when a caller omitted
   * them, which made an unproven assurance indistinguishable from an
   * inapplicable one. They are now COMPUTED here from the actor's own session
   * and grant state, and no caller can assert them.
   */
  readonly supportRequestId?: string | null;
  /**
   * The LOCAL session this request PRESENTED — the one the authenticate
   * middleware resolved from the cookie or the bearer credential, and the one
   * an operator can revoke.
   *
   * FBL-020-R4 §2: `authTime`, `connectionId` and `actorProviderSubject` are
   * GONE from this input, and their absence is the correction. They used to be
   * caller-asserted identity facts: a route passed whatever it believed, the
   * engine wrote it to append-only evidence unexamined, and a route that
   * believed nothing (`POST /auth/reauth/start` passed none of them) produced
   * an evidence row that named no credential at all. They are now DERIVED here
   * from the presented session row, so the evidence describes the credential
   * the database can see rather than the one a caller described.
   */
  readonly sessionId?: string | null;
}

export interface PolicyDecisionResult {
  readonly decision: 'allow' | 'deny';
  readonly reasonCode: string;
  readonly decisionId: string;
  /** Every binding that matched, with the version it matched at. */
  readonly matchedBindings: ReadonlyArray<{ roleBindingId: string; authorizationVersion: number }>;
  /**
   * false: a resource-scoped denial where unauthorized and nonexistent must
   * stay externally indistinguishable — render the existing not-found
   * envelope, never a 403.
   */
  readonly resourceVisible: boolean;
  readonly supportSessionId: string | null;
  /**
   * FBL-020-R4 §4 — the WHOLE delegated-access fact set when this decision was
   * allowed under a support session, null otherwise.
   *
   * `supportSessionId` above stays because a great deal of existing evidence and
   * test code asks exactly that one question, but it is not enough to propagate:
   * a caller holding only an id cannot put the expiry in a response header, bind
   * the approved scope to the request context, or say in a log line what the
   * session was approved to do. Those were R3's omissions, and an id alone is
   * what caused them — so the facts travel as one object that cannot be
   * assembled with pieces missing.
   */
  readonly support: SupportAccessFacts | null;
  readonly sensitive: boolean;
}

export interface PolicyEngine {
  decide(input: PolicyInput): Promise<PolicyDecisionResult>;
}

/**
 * FBL-020-R3 correction — the EFFECTIVENESS predicate every reader of
 * `role_bindings` must apply, written ONCE, with `rb` as the table alias.
 *
 * A binding authorizes nothing unless it is `active` AND inside its effective
 * window. That is three conditions, and the R3 adversarial review found a
 * second, hand-written copy of them elsewhere in this package that had silently
 * dropped the window — so a binding whose `effective_to` was a day in the past
 * still passed one gate while the engine, asked the same question, refused. The
 * text now lives here and is interpolated; there is nothing left to restate and
 * therefore nothing left to drift.
 */
export const EFFECTIVE_ROLE_BINDING_SQL = `rb.status = 'active'
        AND rb.effective_from <= NOW()
        AND (rb.effective_to IS NULL OR rb.effective_to > NOW())`;

/** The two binding columns the shared scope rule reads. */
export interface ScopedBinding {
  readonly scope_level: string;
  readonly scope_id: string | null;
}

/**
 * FBL-020-R3 correction — the scope rule for a TENANT-CONTEXT action: one whose
 * catalog definition names no `resourceType`, whose caller names no `scopeHint`
 * and no resource. Such an action reaches the WHOLE tenant, so ONLY a
 * tenant-scope binding of that very tenant may authorize it — a rooftop,
 * department or resource binding must never widen to tenant-wide reach.
 *
 * This IS the branch `covers()` takes when `ancestry === null`: the engine calls
 * this function instead of stating the rule inline, and so does every other
 * authority gate in this package. One rule, one implementation.
 */
export function coversTenantWide(binding: ScopedBinding, targetTenantId: string | null): boolean {
  if (binding.scope_level === 'platform') return false; // never covers tenant data
  if (binding.scope_level === 'resource') return false; // names one row, not a tenant
  return binding.scope_level === 'tenant' && binding.scope_id === targetTenantId;
}

/**
 * FBL-020-R3 correction B3 — the scope rule for a `platform.*` action: ONLY a
 * PLATFORM-scope binding reaches the control plane.
 *
 * `role_bindings.role` is a free text column whose only constraint is a name
 * regex (migration 055), so nothing in the schema stops a platform role NAME
 * from being written at tenant scope. Before this rule the engine's remaining
 * test for a dealership actor was `def.allowedRoles.includes(b.role)` against a
 * binding that covered the tenant — so a dealership actor holding
 * `{role: 'platform_admin', scopeLevel: 'tenant'}` was ALLOWED
 * `platform.tenant.provision`, the whole control plane, from inside a tenant.
 *
 * Scope decides reach; the role column never widens it. Both actor branches
 * call this through `covers()`, so a platform action has exactly one scope rule
 * and the dealership path cannot acquire a second one.
 */
export function coversPlatformAction(binding: ScopedBinding): boolean {
  return binding.scope_level === 'platform';
}

interface Row {
  [key: string]: unknown;
}

interface BindingRow {
  role_binding_id: string;
  role: string;
  scope_level: string;
  scope_id: string | null;
  resource_type: string | null;
  resource_id: string | null;
  authorization_version: string | number;
}

/** FBL-020-R1 section E/G: assurance facts recorded on every decision. */
export type FreshnessClassification = 'not_applicable' | 'stale' | 'fresh';
export type MfaAssuranceClassification = 'not_applicable' | 'uncertified' | 'certified';

export interface AssuranceClassification {
  readonly freshness: FreshnessClassification;
  readonly mfaAssurance: MfaAssuranceClassification;
}

/**
 * The GENERATED evidence ids. Inside a request they are the very pair the
 * outermost middleware minted and the logs already carry, so a decision row
 * joins to its log lines. Outside a request — a scheduler, a CLI, a test — one
 * is generated here rather than left null, because "no id" is not a fact a
 * decision may record about itself.
 *
 * Caller-supplied header values never reach this function.
 */
function evidenceIds(): { requestId: string; correlationId: string } {
  const context = getRequestContext();
  if (context !== undefined) {
    return { requestId: context.requestId, correlationId: context.correlationId };
  }
  const generated = randomUUID();
  return { requestId: generated, correlationId: generated };
}

/**
 * FBL-020-R4 §2 — the PRESENTED CREDENTIAL, read once from the database.
 *
 * Everything a decision records about the credential behind it comes from this
 * one row: the authentication instant, the connection it was established
 * through, the provider subject it belongs to, and whether that connection
 * certifies the organization's MFA policy. `null` means no live session was
 * presented — revoked, expired, belonging to someone else, or simply absent.
 *
 * It is deliberately keyed on BOTH the session id and the user link: a session
 * id that belongs to another person proves nothing about this actor, and
 * resolving it anyway is how a decision ends up recording somebody else's
 * authentication as its own.
 */
export interface PresentedCredential {
  readonly sessionId: string;
  readonly authTime: Date;
  readonly connectionId: string;
  readonly providerSubject: string;
  readonly mfaPolicyCertified: boolean;
}

export async function readPresentedCredential(
  userLinkId: string,
  sessionId: string | null,
): Promise<PresentedCredential | null> {
  if (sessionId === null) return null;
  const result = await query(
    `SELECT s.session_id, s.auth_time, s.connection_id, s.provider_subject,
            COALESCE(${EFFECTIVE_MFA_CERTIFICATION_SQL}, FALSE) AS mfa_policy_certified
       FROM identity_sessions s
       LEFT JOIN identity_provider_connections c ON c.connection_id = s.connection_id
      WHERE s.session_id = $2::uuid AND s.user_link_id = $1
        AND s.revoked_at IS NULL AND s.expires_at > NOW()`,
    [userLinkId, sessionId],
  );
  const row = result.rows[0] as Row | undefined;
  if (row === undefined) return null;
  // A live session cannot hold NULL in any of these — `is_live_session_fully_bound`
  // (migration 057) forbids it — so the narrowing below is a type boundary, not a
  // fallback that could quietly produce a half-populated credential.
  if (row.auth_time === null || row.connection_id === null || row.provider_subject === null) {
    return null;
  }
  return {
    sessionId: String(row.session_id),
    authTime: row.auth_time instanceof Date ? row.auth_time : new Date(String(row.auth_time)),
    connectionId: String(row.connection_id),
    providerSubject: String(row.provider_subject),
    mfaPolicyCertified: row.mfa_policy_certified === true,
  };
}

/**
 * FBL-020-R3 correction B2 — assurance is COMPUTED, and it is computed about
 * the CREDENTIAL THIS REQUEST PRESENTED.
 *
 * `sessionId` is the local session the request actually resolved — the same id
 * the evidence row records and the same object an operator can revoke. It is
 * NOT optional and it is NOT "the actor's freshest session": R3 made both
 * credential kinds mint local sessions, so one user routinely holds several,
 * and the predicate this replaces (`WHERE user_link_id = $1 ORDER BY auth_time
 * DESC LIMIT 1`) recorded a request made on a six-hour-old cookie as 'fresh'
 * because a bearer session had authenticated a minute earlier. The evidence row
 * then claimed an assurance the presented credential did not have.
 *
 * Facts are read in one statement so a decision costs one extra round trip and
 * cannot see a half-updated picture:
 *
 *   - the PRESENTED session is not live (revoked, expired, someone else's, or
 *     none was presented at all) and no live grant is held → 'not_applicable'
 *     for both. That is the truth for a system actor, an off-request decision
 *     and a credential that proves nothing, and it is the ONLY way
 *     'not_applicable' can be reached;
 *   - a live UNSPENT grant, or the presented session authenticated inside the
 *     freshness window → 'fresh'; a presented session older than the window →
 *     'stale';
 *   - 'certified' only when the connection backing THE PRESENTED session
 *     certifies the organization's MFA policy, or a live unspent grant was
 *     minted at fresh_and_mfa_policy against a connection that certified it at
 *     issue. Anything else is 'uncertified' — never silently inapplicable.
 *
 * A CONSUMED grant proves nothing about the next request: it was spent, once,
 * atomically, on the action it was minted for. It is excluded here for the same
 * reason the spend predicate excludes it.
 *
 * FBL-020-R4 §2.4 — AND NEITHER DOES AN UNRELATED UNSPENT ONE, WHICH IS THE
 * CORRECTION. R3 read "the actor's most recent live unconsumed grant" and let
 * it raise this classification to `fresh` / `certified`. A grant is minted for
 * ONE action on ONE resource; holding a live grant for
 * `service.ro.void_line:9` said nothing whatever about the request being judged
 * — yet the evidence row for that unrelated request recorded a strengthened
 * assurance, and `GET /auth/session` showed the operator `fresh` while the
 * presented cookie was hours old. Assurance now derives from the PRESENTED
 * SESSION, or from the EXACT grant being evaluated when there is one, and from
 * nothing else. `grant` is therefore not "a grant the actor has" but "the grant
 * THIS decision is about": the caller must name it, and the id is verified to
 * belong to this actor and to still be live and unspent before it counts.
 *
 * Exported because `GET /auth/session` reports the SAME two classifications it
 * would get on its next decision, for the SAME presented session. Two
 * definitions of "fresh" — one for the evidence row, one for the page — would
 * eventually disagree, and the page would then be telling the operator
 * something the audit trail denies.
 */
export async function classifyActorAssurance(
  userLinkId: string,
  sessionId: string | null,
  /** The EXACT grant being evaluated, when a grant is what is being evaluated. */
  evaluatedGrantId: string | null = null,
): Promise<AssuranceClassification> {
  const result = await query(
    `SELECT
       (SELECT s.auth_time
          FROM identity_sessions s
         WHERE s.session_id = $2::uuid AND s.user_link_id = $1
           AND s.revoked_at IS NULL AND s.expires_at > NOW()) AS session_auth_time,
       (SELECT COALESCE(${EFFECTIVE_MFA_CERTIFICATION_SQL}, FALSE)
          FROM identity_sessions s
          LEFT JOIN identity_provider_connections c ON c.connection_id = s.connection_id
         WHERE s.session_id = $2::uuid AND s.user_link_id = $1
           AND s.revoked_at IS NULL AND s.expires_at > NOW()) AS session_mfa_certified,
       (SELECT g.grant_id
          FROM reauthentication_grants g
         WHERE g.grant_id = $3::uuid AND g.user_link_id = $1
           AND g.expires_at > NOW() AND g.consumed_at IS NULL) AS evaluated_grant_id,
       (SELECT (g.assurance_level = 'fresh_and_mfa_policy' AND g.mfa_policy_certified_at_issue)
          FROM reauthentication_grants g
         WHERE g.grant_id = $3::uuid AND g.user_link_id = $1
           AND g.expires_at > NOW() AND g.consumed_at IS NULL) AS grant_mfa_certified`,
    [userLinkId, sessionId, evaluatedGrantId],
  );
  const row = (result.rows[0] ?? {}) as Row;
  const sessionAuthTime =
    row.session_auth_time === null || row.session_auth_time === undefined
      ? null
      : row.session_auth_time instanceof Date
        ? row.session_auth_time
        : new Date(String(row.session_auth_time));
  const hasEvaluatedGrant = row.evaluated_grant_id !== null && row.evaluated_grant_id !== undefined;

  if (sessionAuthTime === null && !hasEvaluatedGrant) {
    return { freshness: 'not_applicable', mfaAssurance: 'not_applicable' };
  }
  const withinWindow =
    sessionAuthTime !== null &&
    Date.now() - sessionAuthTime.getTime() <= AUTHENTICATION_FRESHNESS_WINDOW_SECONDS * 1000;
  const certified = row.session_mfa_certified === true || row.grant_mfa_certified === true;
  return {
    freshness: hasEvaluatedGrant || withinWindow ? 'fresh' : 'stale',
    mfaAssurance: certified ? 'certified' : 'uncertified',
  };
}

export function createPolicyEngine(options: {
  catalog: ActionCatalog;
  resolveResourceScope: ResourceScopeResolver;
}): PolicyEngine {
  const { catalog, resolveResourceScope } = options;

  async function record(input: {
    tenantId: string | null;
    actorUserLinkId: string | null;
    actorType: 'user' | 'platform_support' | 'system';
    action: string;
    resourceType: string | null;
    resourceId: string | null;
    scopeLevel: string | null;
    scopeId: string | null;
    decision: 'allow' | 'deny';
    reasonCode: string;
    /** GENERATED, never a header value, never null for an identified actor. */
    requestId: string;
    supportSessionId: string | null;
    matched?: ReadonlyArray<{ roleBindingId: string; authorizationVersion: number }> | undefined;
    correlationId: string;
    freshness: FreshnessClassification;
    mfaAssurance: MfaAssuranceClassification;
    supportRequestId?: string | null | undefined;
    supportSessionExpiresAt?: Date | null | undefined;
    /**
     * FBL-020-R4 §4 — the whole delegated-access fact set, present on exactly the
     * decisions that were allowed under one. The `policy_decisions` COLUMNS carry
     * the session, request and expiry (they are authorization evidence); the
     * approved SCOPE and ACTION SET go into the audit row's details, because the
     * request row they come from can be superseded later and an operator reading
     * the trail must still be able to see what this access was approved for.
     */
    support?: SupportAccessFacts | null | undefined;
    /**
     * The presented credential, or null when none was presented. It arrives as
     * ONE object precisely so that no caller can supply three of its four
     * facts: the database's `pd_credential_group_is_atomic` refuses that shape,
     * and this signature makes it unreachable before the database has to.
     */
    credential: PresentedCredential | null;
  }): Promise<string> {
    // Fail closed rather than write evidence that cannot be correlated: an
    // identified actor's decision MUST carry both generated ids.
    if (
      (input.actorType === 'user' || input.actorType === 'platform_support') &&
      (input.requestId.length === 0 || input.correlationId.length === 0)
    ) {
      throw new Error('policy evidence requires generated request and correlation ids');
    }
    // A deny never claims a matched binding (also a database CHECK).
    const matched = input.decision === 'allow' ? (input.matched ?? []) : [];
    // FBL-020-R4 §3 — SUPPORT USE IS AN AUDITED TRANSITION.
    //
    // A request SERVED under delegated support access is a platform person
    // reaching into a customer's data. The evidence row already recorded it, but
    // `policy_decisions` is the authorization ledger — the audit trail an
    // operator reads for "who touched this tenant" is `audit_events`, and support
    // use appeared in it nowhere. It is written in the SAME transaction as the
    // evidence row, so a served support request cannot exist without its audit
    // row and an audit row cannot exist for a decision that was never recorded.
    const auditsSupportUse = input.decision === 'allow' && input.supportSessionId !== null;
    return withTransaction(async (executor) => {
      const result = await executor.query(
        `INSERT INTO policy_decisions
         (tenant_id, actor_user_link_id, actor_type, action, resource_type, resource_id,
          scope_level, scope_id, decision, reason_code, policy_version, request_id,
          support_session_id, matched_role_binding_ids, matched_authorization_versions,
          freshness_classification, mfa_assurance_classification, correlation_id,
          support_request_id, auth_time, connection_id, session_id, actor_provider_subject,
          support_session_expires_at, evidence_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,
               $24, ${CURRENT_EVIDENCE_VERSION})
       RETURNING decision_id`,
        [
          input.tenantId,
          input.actorUserLinkId,
          input.actorType,
          input.action,
          input.resourceType,
          input.resourceId,
          input.scopeLevel,
          input.scopeId,
          input.decision,
          input.reasonCode,
          POLICY_VERSION,
          input.requestId,
          input.supportSessionId,
          matched.map((m) => m.roleBindingId),
          matched.map((m) => m.authorizationVersion),
          input.freshness,
          input.mfaAssurance,
          input.correlationId,
          input.supportRequestId ?? null,
          input.credential?.authTime ?? null,
          input.credential?.connectionId ?? null,
          input.credential?.sessionId ?? null,
          input.credential?.providerSubject ?? null,
          input.supportSessionExpiresAt ?? null,
        ],
      );
      const decisionId = String((result.rows[0] as Row).decision_id);
      if (auditsSupportUse) {
        await executor.query(
          `INSERT INTO audit_events
           (tenant_id, event_type, entity_type, entity_id, actor_user_id, details)
         VALUES ($1, 'identity.support.used', 'support_access_session', $2, $3, $4)`,
          [
            input.tenantId,
            input.supportSessionId,
            input.actorUserLinkId,
            // Ids, codes, classifications and instants only — never the free-text
            // support reason, never a resource payload, never a provider profile.
            //
            // FBL-020-R4 §4: the approved SCOPE, the approved ACTION SET, the true
            // support actor and the EXPIRY are recorded here. R3 wrote the action
            // and the request id, so the trail said a platform person did one thing
            // under some request and left "how far did that request reach, and how
            // long for" answerable only by joining to a row that can later be
            // superseded — i.e. not answerable at all after the fact.
            JSON.stringify({
              action: input.action,
              resource_type: input.resourceType,
              decision_id: decisionId,
              support_request_id: input.supportRequestId ?? null,
              reason_code: input.reasonCode,
              support_actor_user_link_id: input.support?.supportActorUserLinkId ?? null,
              support_target_tenant_id: input.support?.targetTenantId ?? null,
              support_approved_scope_level: input.support?.approvedScopeLevel ?? null,
              support_approved_scope_id: input.support?.approvedScopeId ?? null,
              support_approved_actions: input.support?.approvedActions ?? null,
              support_session_expires_at:
                input.supportSessionExpiresAt?.toISOString() ??
                input.support?.expiresAt.toISOString() ??
                null,
            }),
          ],
        );
      }
      return decisionId;
    });
  }

  return {
    async decide(input: PolicyInput): Promise<PolicyDecisionResult> {
      // GENERATED evidence ids and COMPUTED assurance — resolved once, before
      // any rule runs, so every path out of this function records the same
      // facts and no path can quietly omit them.
      const { requestId, correlationId } = evidenceIds();
      // FBL-020-R4 §2: the presented credential is READ from the database once,
      // here, and every evidence row this call writes describes THAT row. No
      // caller asserts an auth_time, a connection or a provider subject any
      // more, so no route can record a credential fact it merely believed.
      const credential = await readPresentedCredential(
        input.actor.userLinkId,
        input.sessionId ?? null,
      );
      // R3 correction B2: the assurance recorded is the assurance of the
      // session THIS request presented — the very id written to the evidence
      // row below — not of whichever session the actor authenticated most
      // recently on some other credential. R4 §2.4: and no unrelated grant can
      // raise it, because `decide` evaluates no grant and names none.
      const assurance = await classifyActorAssurance(
        input.actor.userLinkId,
        credential?.sessionId ?? null,
      );
      const actor = input.actor;
      const targetTenantId = input.targetTenantId ?? actor.tenantId;
      const actorType: 'user' | 'platform_support' =
        actor.actorScope === 'platform' ? 'platform_support' : 'user';

      const deny = async (
        reasonCode: string,
        detail?: {
          resourceVisible?: boolean;
          scope?: OrganizationNodeRef | null;
          sensitive?: boolean;
        },
      ): Promise<PolicyDecisionResult> => {
        const decisionId = await record({
          tenantId: targetTenantId,
          actorUserLinkId: actor.userLinkId,
          actorType,
          action: input.action,
          resourceType: input.resource?.type ?? null,
          resourceId: input.resource?.id ?? null,
          scopeLevel: detail?.scope?.level ?? null,
          scopeId: detail?.scope?.id ?? null,
          decision: 'deny',
          reasonCode,
          requestId,
          supportSessionId: null,
          correlationId,
          freshness: assurance.freshness,
          mfaAssurance: assurance.mfaAssurance,
          supportRequestId: input.supportRequestId ?? null,
          credential,
        });
        return {
          decision: 'deny',
          reasonCode,
          decisionId,
          matchedBindings: [],
          resourceVisible: detail?.resourceVisible ?? true,
          supportSessionId: null,
          support: null,
          sensitive: detail?.sensitive ?? false,
        };
      };

      // 1. the action must exist in a published catalog
      const def = catalog.get(input.action);
      if (def === undefined) {
        // no lookup was performed, so a 403 here reveals nothing about data
        return deny('ACTION_UNKNOWN');
      }
      const sensitive = def.sensitive === true;
      const isPlatformAction = def.action.startsWith('platform.');

      // 2. cross-tenant is never reachable: a dealership actor's target is
      //    always their own tenant
      if (actor.actorScope === 'dealership') {
        if (actor.tenantId === null) return deny('ACTOR_TENANT_MISSING', { sensitive });
        if (targetTenantId !== actor.tenantId) {
          return deny('CROSS_TENANT', { resourceVisible: false, sensitive });
        }
      }

      // 3. dealership-targeted decisions require an EFFECTIVE tenant
      if (!isPlatformAction) {
        if (targetTenantId === null) return deny('TARGET_TENANT_MISSING', { sensitive });
        const tenant = await query(
          `SELECT 1 FROM tenants
            WHERE tenant_id = $1 AND status = 'active'
              AND effective_from <= NOW()
              AND (effective_to IS NULL OR effective_to > NOW())`,
          [targetTenantId],
        );
        if (tenant.rows.length === 0) return deny('TENANT_INACTIVE', { sensitive });
      }

      // 4. resolve the acted-on node to its organization ancestry.
      //    `ancestry === null` means "no organization node was named", which
      //    is treated as TENANT-WIDE below — never as "anything covers it".
      //
      //    Non-enumeration attaches to RESOURCES: an existing row must not be
      //    distinguishable from a missing one. A scope hint is different — the
      //    caller supplied a location in their own tenant, so a plain 403 is
      //    honest and leaks nothing they did not already state.
      const namedResource = def.resourceType !== null;
      let ancestry: OrganizationNodeRef[] | null = null;
      if (def.resourceType === null && input.scopeHint !== undefined && input.scopeHint !== null) {
        // A resource-less action that names where it lands: the hint must
        // resolve inside this tenant, exactly like a resource would.
        ancestry = await resolveAncestry(targetTenantId as string, input.scopeHint);
        if (ancestry === null) {
          return deny('SCOPE_NOT_FOUND', {
            resourceVisible: false,
            scope: input.scopeHint,
            sensitive,
          });
        }
      }
      if (def.resourceType !== null) {
        if (input.resource === undefined || input.resource === null) {
          // the route forgot to name its resource — a programming error, not
          // a data decision; refuse rather than widen
          return deny('RESOURCE_REQUIRED', { sensitive });
        }
        if (input.resource.type !== def.resourceType) {
          return deny('RESOURCE_TYPE_MISMATCH', { resourceVisible: false, sensitive });
        }
        const leaf = await resolveResourceScope(
          targetTenantId as string,
          input.resource.type,
          input.resource.id,
        );
        if (leaf === null) {
          return deny('RESOURCE_NOT_FOUND', { resourceVisible: false, sensitive });
        }
        ancestry = await resolveAncestry(targetTenantId as string, leaf);
        if (ancestry === null) {
          return deny('RESOURCE_SCOPE_UNRESOLVED', {
            resourceVisible: false,
            scope: leaf,
            sensitive,
          });
        }
      }

      // 5. DATABASE-authoritative bindings, loaded per decision
      const bindings = (
        await query(
          `SELECT rb.role_binding_id, rb.role, rb.scope_level, rb.scope_id,
                  rb.resource_type, rb.resource_id, rb.authorization_version
             FROM role_bindings rb
            WHERE rb.user_link_id = $1
              AND ${EFFECTIVE_ROLE_BINDING_SQL}
              AND rb.tenant_id IS NOT DISTINCT FROM $2`,
          [actor.userLinkId, actor.actorScope === 'platform' ? null : actor.tenantId],
        )
      ).rows as unknown as BindingRow[];

      const covers = (binding: BindingRow): boolean => {
        if (isPlatformAction) {
          // R3 correction B3: a control-plane action is reached ONLY from
          // platform scope — for EVERY actor, on both branches below. A
          // tenant-scope binding carrying a platform role name is a misgrant,
          // and a misgrant authorizes nothing.
          return coversPlatformAction(binding);
        }
        if (binding.scope_level === 'platform') return false; // never covers tenant data
        if (binding.scope_level === 'resource') {
          // EXACT match on tenant, resource type and resource id. A resource
          // binding grants no descendant and no sibling access, and cannot
          // satisfy a tenant-wide or organization-scoped request.
          if (input.resource === undefined || input.resource === null) return false;
          return (
            binding.resource_type === input.resource.type &&
            binding.resource_id === input.resource.id
          );
        }
        if (ancestry === null) {
          // Nothing narrower was named, so the action reaches the whole
          // tenant. Only a tenant-scope binding may authorize that: a
          // rooftop or department binding must NEVER widen to tenant-wide
          // reach (the same rule sessionCovers applies to support sessions).
          //
          // The rule is `coversTenantWide` and it is called, not restated —
          // every other authority gate in this package calls the same
          // function, so none of them can disagree with this decision.
          return coversTenantWide(binding, targetTenantId);
        }
        return ancestry.some(
          (node) => node.level === binding.scope_level && node.id === binding.scope_id,
        );
      };

      if (actor.actorScope === 'dealership') {
        const match = bindings.find((b) => def.allowedRoles.includes(b.role) && covers(b));
        if (match !== undefined) {
          // EVERY matching binding is evidence, not just the first one found.
          const matched = bindings
            .filter((b) => def.allowedRoles.includes(b.role) && covers(b))
            .map((b) => ({
              roleBindingId: b.role_binding_id,
              authorizationVersion: Number(b.authorization_version),
            }));
          const decisionId = await record({
            tenantId: targetTenantId,
            actorUserLinkId: actor.userLinkId,
            actorType,
            action: def.action,
            resourceType: input.resource?.type ?? null,
            resourceId: input.resource?.id ?? null,
            scopeLevel: match.scope_level,
            scopeId: match.scope_id,
            decision: 'allow',
            reasonCode: 'ALLOW_ROLE_BINDING',
            requestId,
            supportSessionId: null,
            matched,
            correlationId,
            freshness: assurance.freshness,
            mfaAssurance: assurance.mfaAssurance,
            supportRequestId: input.supportRequestId ?? null,
            credential,
          });
          return {
            decision: 'allow',
            reasonCode: 'ALLOW_ROLE_BINDING',
            decisionId,
            matchedBindings: matched,
            resourceVisible: true,
            supportSessionId: null,
            support: null,
            sensitive,
          };
        }
        return deny('NO_MATCHING_BINDING', {
          // Only a RESOURCE denial hides behind the not-found envelope.
          resourceVisible: !namedResource,
          sensitive,
        });
      }

      // 6. platform actors: platform.* actions via platform bindings…
      //    `covers` is the SAME predicate the dealership branch above applied,
      //    and for a platform action it is `coversPlatformAction` — so the two
      //    branches cannot disagree about what reaches the control plane.
      if (isPlatformAction) {
        const match = bindings.find((b) => def.allowedRoles.includes(b.role) && covers(b));
        if (match !== undefined) {
          const decisionId = await record({
            tenantId: targetTenantId,
            actorUserLinkId: actor.userLinkId,
            actorType,
            action: def.action,
            resourceType: null,
            resourceId: null,
            scopeLevel: 'platform',
            scopeId: null,
            decision: 'allow',
            reasonCode: 'ALLOW_PLATFORM_ROLE',
            requestId,
            supportSessionId: null,
            matched: [
              {
                roleBindingId: match.role_binding_id,
                authorizationVersion: Number(match.authorization_version),
              },
            ],
            correlationId,
            freshness: assurance.freshness,
            mfaAssurance: assurance.mfaAssurance,
            credential,
          });
          return {
            decision: 'allow',
            reasonCode: 'ALLOW_PLATFORM_ROLE',
            decisionId,
            matchedBindings: [
              {
                roleBindingId: match.role_binding_id,
                authorizationVersion: Number(match.authorization_version),
              },
            ],
            resourceVisible: true,
            supportSessionId: null,
            support: null,
            sensitive,
          };
        }
        return deny('NO_MATCHING_BINDING', { sensitive });
      }

      // …7. and dealership data ONLY through a live approved support session
      // whose request covers this action, whose scope covers the resource, AND
      // whose actor STILL holds platform-support authority.
      //
      // FBL-020-R3 correction F1 — THE LAST CLAUSE IS NEW, AND IT IS THE POINT.
      // Before it, this branch consulted the support session and the approved
      // request and no role binding at all, so revoking a platform actor's
      // binding — the natural offboarding action — took no effect on a live
      // session: access continued until the session expired or an operator
      // remembered to call `revokeSupportSession`. Offboarding must not depend
      // on anybody remembering a second step.
      //
      // The authority is re-judged HERE, on EVERY decision, from the `bindings`
      // rows already loaded above — a set the engine read under
      // `EFFECTIVE_ROLE_BINDING_SQL`, so a revoked or windowed-out binding is
      // simply not in it, no new query is issued, and there is no second
      // predicate to drift.
      //
      // ON `coversPlatformAction`: today it can only be true here. `bindings` is
      // this platform actor's own set (`rb.tenant_id IS NOT DISTINCT FROM NULL`
      // on this branch) and migration 055 CHECKs that `tenant_id` is NULL
      // exactly when `scope_level = 'platform'`, so the schema already implies
      // it. It is STATED rather than inferred because the rule this branch
      // enforces is "a PLATFORM-SCOPE binding in a support role", and a rule
      // that silently rested on a CHECK in another file is how the drift this
      // revision keeps finding gets in. It is the same function the
      // control-plane branch calls, so the two cannot diverge.
      const holdsSupportAuthority = bindings.some(
        (b) =>
          coversPlatformAction(b) &&
          (PLATFORM_SUPPORT_AUTHORITY_ROLES as readonly string[]).includes(b.role),
      );
      if (!holdsSupportAuthority) {
        // A resource denial still hides behind the not-found envelope: losing
        // authority must not turn into an existence oracle.
        return deny('SUPPORT_ACTOR_UNAUTHORIZED', {
          resourceVisible: !namedResource,
          sensitive,
        });
      }

      const sessions = (
        await query(
          `SELECT s.support_session_id, s.expires_at, r.request_id, r.requested_actions,
                  r.scope_level, r.scope_id
             FROM support_access_sessions s
             JOIN support_access_requests r ON r.request_id = s.request_id
            WHERE s.actor_user_link_id = $1 AND s.tenant_id = $2
              AND s.revoked_at IS NULL AND s.expires_at > NOW()
              AND r.status = 'approved'`,
          [actor.userLinkId, targetTenantId],
        )
      ).rows as unknown as Array<{
        support_session_id: string;
        expires_at: Date | string;
        request_id: string;
        requested_actions: string[];
        scope_level: string;
        scope_id: string | null;
      }>;

      const sessionCovers = (s: (typeof sessions)[number]): boolean => {
        if (!s.requested_actions.includes(def.action)) return false;
        if (s.scope_level === 'tenant') return true;
        if (ancestry === null) return false; // sub-tenant grant cannot cover tenant-wide actions
        return ancestry.some((node) => node.level === s.scope_level && node.id === s.scope_id);
      };

      const live = sessions.find(sessionCovers);
      if (live !== undefined) {
        // FBL-020-R4 §4 — THE FACTS ARE ASSEMBLED ONCE, HERE, AND EVERY CARRIER
        // GETS THE SAME OBJECT.
        //
        // The evidence row, the transactional audit row, the response header, the
        // request context and every log line inside this request all describe this
        // one delegated grant, so there is no path on which one of them names the
        // session and another names its expiry. R3's omissions were exactly that
        // shape: each carrier decided for itself which fields it happened to have.
        const support: SupportAccessFacts = {
          supportSessionId: live.support_session_id,
          supportRequestId: live.request_id,
          supportActorUserLinkId: actor.userLinkId,
          targetTenantId: targetTenantId as string,
          approvedScopeLevel: live.scope_level,
          approvedScopeId: live.scope_id,
          approvedActions: [...live.requested_actions],
          expiresAt:
            live.expires_at instanceof Date ? live.expires_at : new Date(String(live.expires_at)),
        };
        const decisionId = await record({
          tenantId: targetTenantId,
          actorUserLinkId: actor.userLinkId,
          actorType: 'platform_support',
          action: def.action,
          resourceType: input.resource?.type ?? null,
          resourceId: input.resource?.id ?? null,
          scopeLevel: live.scope_level,
          scopeId: live.scope_id,
          decision: 'allow',
          reasonCode: 'ALLOW_SUPPORT_SESSION',
          requestId,
          supportSessionId: support.supportSessionId,
          // Support access is authorized by an approved REQUEST, not by a
          // role binding — so the matched-binding list is truthfully empty
          // and the request/session ids carry the evidence instead.
          matched: [],
          correlationId,
          freshness: assurance.freshness,
          mfaAssurance: assurance.mfaAssurance,
          supportRequestId: support.supportRequestId,
          // R4 §2.2: the WINDOW the support allow fell inside, recorded on the
          // decision itself so a stored allow can be re-judged against it later.
          supportSessionExpiresAt: support.expiresAt,
          // R4 §4: the approved SCOPE and ACTION SET reach the audit row too — an
          // operator asking "what was this platform person allowed to do" must not
          // have to re-derive it from a request row that may since have been
          // superseded.
          support,
          credential,
        });
        return {
          decision: 'allow',
          reasonCode: 'ALLOW_SUPPORT_SESSION',
          decisionId,
          matchedBindings: [],
          resourceVisible: true,
          supportSessionId: support.supportSessionId,
          support,
          sensitive,
        };
      }
      return deny('NO_MATCHING_BINDING', {
        resourceVisible: !namedResource,
        sensitive,
      });
    },
  };
}
