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
import { query } from '@dealer/database';
import { resolveAncestry, type OrganizationNodeRef } from '@dealer/organization';

export const POLICY_VERSION = 'fbl-020.1';

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
  readonly requestId?: string | null;
}

export interface PolicyDecisionResult {
  readonly decision: 'allow' | 'deny';
  readonly reasonCode: string;
  readonly decisionId: string;
  /**
   * false: a resource-scoped denial where unauthorized and nonexistent must
   * stay externally indistinguishable — render the existing not-found
   * envelope, never a 403.
   */
  readonly resourceVisible: boolean;
  readonly supportSessionId: string | null;
  readonly sensitive: boolean;
}

export interface PolicyEngine {
  decide(input: PolicyInput): Promise<PolicyDecisionResult>;
}

interface Row {
  [key: string]: unknown;
}

interface BindingRow {
  role: string;
  scope_level: string;
  scope_id: string | null;
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
    requestId: string | null;
    supportSessionId: string | null;
  }): Promise<string> {
    const result = await query(
      `INSERT INTO policy_decisions
         (tenant_id, actor_user_link_id, actor_type, action, resource_type, resource_id,
          scope_level, scope_id, decision, reason_code, policy_version, request_id, support_session_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
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
      ],
    );
    return String((result.rows[0] as Row).decision_id);
  }

  return {
    async decide(input: PolicyInput): Promise<PolicyDecisionResult> {
      const requestId = input.requestId ?? null;
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
        });
        return {
          decision: 'deny',
          reasonCode,
          decisionId,
          resourceVisible: detail?.resourceVisible ?? true,
          supportSessionId: null,
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
          `SELECT role, scope_level, scope_id FROM role_bindings
            WHERE user_link_id = $1 AND status = 'active'
              AND tenant_id IS NOT DISTINCT FROM $2`,
          [actor.userLinkId, actor.actorScope === 'platform' ? null : actor.tenantId],
        )
      ).rows as unknown as BindingRow[];

      const covers = (binding: BindingRow): boolean => {
        if (binding.scope_level === 'platform') return false; // never covers tenant data
        if (ancestry === null) {
          // Nothing narrower was named, so the action reaches the whole
          // tenant. Only a tenant-scope binding may authorize that: a
          // rooftop or department binding must NEVER widen to tenant-wide
          // reach (the same rule sessionCovers applies to support sessions).
          return binding.scope_level === 'tenant' && binding.scope_id === targetTenantId;
        }
        return ancestry.some(
          (node) => node.level === binding.scope_level && node.id === binding.scope_id,
        );
      };

      if (actor.actorScope === 'dealership') {
        const match = bindings.find((b) => def.allowedRoles.includes(b.role) && covers(b));
        if (match !== undefined) {
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
          });
          return {
            decision: 'allow',
            reasonCode: 'ALLOW_ROLE_BINDING',
            decisionId,
            resourceVisible: true,
            supportSessionId: null,
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
      if (isPlatformAction) {
        const match = bindings.find(
          (b) => b.scope_level === 'platform' && def.allowedRoles.includes(b.role),
        );
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
          });
          return {
            decision: 'allow',
            reasonCode: 'ALLOW_PLATFORM_ROLE',
            decisionId,
            resourceVisible: true,
            supportSessionId: null,
            sensitive,
          };
        }
        return deny('NO_MATCHING_BINDING', { sensitive });
      }

      // …7. and dealership data ONLY through a live approved support session
      // whose request covers this action and whose scope covers the resource.
      const sessions = (
        await query(
          `SELECT s.support_session_id, r.requested_actions, r.scope_level, r.scope_id
             FROM support_access_sessions s
             JOIN support_access_requests r ON r.request_id = s.request_id
            WHERE s.actor_user_link_id = $1 AND s.tenant_id = $2
              AND s.revoked_at IS NULL AND s.expires_at > NOW()
              AND r.status = 'approved'`,
          [actor.userLinkId, targetTenantId],
        )
      ).rows as unknown as Array<{
        support_session_id: string;
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
          supportSessionId: live.support_session_id,
        });
        return {
          decision: 'allow',
          reasonCode: 'ALLOW_SUPPORT_SESSION',
          decisionId,
          resourceVisible: true,
          supportSessionId: live.support_session_id,
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
