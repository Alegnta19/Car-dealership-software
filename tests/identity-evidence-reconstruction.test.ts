import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, beforeEach, describe, test } from 'node:test';
import {
  bootstrapAdministrator,
  ensureActiveConnection,
  fixtureAuthorizationStateWrite,
  mintReauthGrant,
  resetDatabase,
  seedDealerGroup,
  seedDepartment,
  seedLegalEntity,
  seedLocalSession,
  seedRooftop,
  seedTenantViaService,
  skipIntegration,
} from '@dealer/test-kit';
import { closePool, query, withTransaction, type Executor } from '@dealer/database';
import { changeRole, grantRole, revokeRole } from '@dealer/identity-access';

/**
 * FBL-020-R6 §3.5 — DIRECT-SQL ADVERSARIAL TESTS FOR DATABASE-RECONSTRUCTABLE
 * EVIDENCE.
 *
 * Every assertion here goes through raw SQL, for the reason `identity-evidence.test.ts`
 * gives and R6 restates: the claim under test is that a piece of evidence is
 * UNREPRESENTABLE, not that the service which normally writes it behaves well. The
 * interesting adversary is the next code path, a repair script or a psql session, and
 * that adversary writes SQL.
 *
 * §3.5 ALSO SAYS WHICH ROWS THE ADVERSARY MUST USE, and it is the point of the file:
 * "Cross-wired REAL rows matter more than random UUIDs — a plain foreign key catches
 * the latter and misses the former." So the fixture below builds FOUR complete, real
 * identity chains — a tenant actor, a second actor in the same tenant, an actor in
 * another tenant, and a platform person — each with its own live session and its own
 * genuinely granted role bindings. Every negative case is assembled out of those real
 * rows, and each one is a row every foreign key in the schema accepts.
 *
 * The eight shapes §3.5 enumerates, and where each is proved:
 *
 *   1. an arbitrary authentication time ............... §3.1 tests, below
 *   2. a lower historical binding version ............. §3.3
 *   3. revoked / expired / wrong-scope same-actor
 *      bindings ....................................... §3.3
 *   4. extra child rows ............................... §3.2
 *   5. duplicated ordinality .......................... §3.2
 *   6. missing support delegation ..................... §3.4
 *   7. expired support evidence ....................... §3.4
 *   8. revoked support evidence ....................... §3.4
 */
describe(
  'policy evidence must reconstruct from the database it names (FBL-020-R6 §3)',
  { skip: skipIntegration ? 'set TEST_DATABASE_URL to run' : false },
  () => {
    after(async () => {
      await closePool();
    });

    const CHECK_VIOLATION = '23514';
    const UNIQUE_VIOLATION = '23505';
    const RAISED = 'P0001';

    /**
     * Refusal, attributed to the NAMED rule. Asserting only "it threw" would let an
     * unrelated constraint stand in for the control under test, which is how a
     * control comes to look present and be absent.
     */
    async function assertRefusedBy(
      op: Promise<unknown>,
      by: { state: string; constraint?: string; message?: string },
      what: string,
    ): Promise<void> {
      await assert.rejects(
        op,
        (err: unknown) => {
          const e = err as { code?: unknown; constraint?: unknown; message?: string };
          assert.equal(
            e.code,
            by.state,
            `${what}: expected SQLSTATE ${by.state}, got ${String(e.code)}`,
          );
          if (by.constraint !== undefined) {
            assert.equal(
              e.constraint,
              by.constraint,
              `${what}: expected constraint ${by.constraint}, got ${String(e.constraint)}`,
            );
          }
          if (by.message !== undefined) {
            assert.ok(
              (e.message ?? '').includes(by.message),
              `${what}: expected message containing ${JSON.stringify(by.message)}, got ${JSON.stringify(e.message)}`,
            );
          }
          return true;
        },
        what,
      );
    }

    async function countEvidence(): Promise<number> {
      const r = await query(`SELECT COUNT(*)::int AS n FROM policy_decisions`);
      return Number((r.rows[0] as { n: number }).n);
    }

    async function bindingVersion(roleBindingId: string): Promise<number> {
      const r = await query(
        `SELECT authorization_version FROM role_bindings WHERE role_binding_id = $1`,
        [roleBindingId],
      );
      return Number((r.rows[0] as { authorization_version: unknown }).authorization_version);
    }

    /** An activated, fully bound link in the named tenant (`null` = platform scope). */
    async function activatedLink(
      tenantId: string | null,
    ): Promise<{ linkId: string; subject: string; connectionId: string }> {
      const subject = 'user_' + randomUUID();
      const r = await fixtureAuthorizationStateWrite(
        'seed-authorization-state',
        `INSERT INTO user_links
           (actor_scope, tenant_id, provider, provider_user_id, status, activated_at,
            connection_id, issuer, provider_organization_id)
         SELECT $3, $1, 'workos', $2, 'activated', NOW(),
                c.connection_id, c.issuer, c.provider_organization_id
           FROM identity_provider_connections c
          WHERE c.tenant_id IS NOT DISTINCT FROM $1 AND c.status = 'active' LIMIT 1
         RETURNING user_link_id, connection_id`,
        [tenantId, subject, tenantId === null ? 'platform' : 'dealership'],
      );
      const row = r.rows[0] as Record<string, unknown>;
      return {
        linkId: String(row.user_link_id),
        subject,
        connectionId: String(row.connection_id),
      };
    }

    /** An ATTRIBUTED role grant, through the owned mutation service, never raw SQL. */
    async function grant(
      tenantId: string | null,
      userLinkId: string,
      options: {
        role?: string;
        scopeLevel?: string;
        scopeId?: string | null;
        resourceType?: string | null;
        resourceId?: string | null;
      } = {},
    ): Promise<string> {
      const granted = await grantRole({
        actingUserLinkId: await bootstrapAdministrator(tenantId),
        tenantId,
        userLinkId,
        role: options.role ?? 'service_advisor',
        scopeLevel: options.scopeLevel ?? 'tenant',
        scopeId: options.scopeId === undefined ? tenantId : options.scopeId,
        resourceType: options.resourceType ?? null,
        resourceId: options.resourceId ?? null,
      });
      return granted.roleBindingId;
    }

    interface Fixture {
      tenantId: string;
      otherTenantId: string;
      /** The tenant actor: link, live session, connection, subject, granted binding. */
      linkId: string;
      subject: string;
      connectionId: string;
      sessionId: string;
      roleBindingId: string;
      roleBindingVersion: number;
      /** A SECOND real binding the SAME actor really holds — the extra-child adversary. */
      secondRoleBindingId: string;
      secondRoleBindingVersion: number;
      /**
       * A REAL organization chain in the tenant, and a REAL rooftop-scope binding the
       * same actor holds at rooftop A. The C7 adversary is built entirely out of these:
       * rooftop B is a genuine sibling and the tenant is the genuine node above.
       *
       * TWO PARALLEL BRANCHES, because C7's rule is enforced by FIVE separate comparisons
       * — one per scope level a binding can sit at — and only the `rooftop` and `tenant`
       * ones had a named adversarial test. Group B carries its own legal entity and its
       * own rooftop, so "a sibling dealer group" and "a rooftop in the other legal
       * entity" are real nodes on a real chain rather than nodes a foreign key would
       * have caught.
       */
      dealerGroupA: string;
      dealerGroupB: string;
      legalEntityA: string;
      legalEntityB: string;
      rooftopA: string;
      rooftopB: string;
      /** A rooftop beneath legal entity B — the reach a legal-entity-A binding lacks. */
      rooftopC: string;
      departmentA: string;
      /**
       * A REAL rooftop in the OTHER tenant. R6-R6 §D4's adversary needs a node that
       * genuinely EXISTS and is genuinely out of reach, because "no such node" and "not in
       * this tenant" are two different refusals and a random UUID only exercises the first.
       */
      foreignRooftop: string;
      rooftopRoleBindingId: string;
      rooftopRoleBindingVersion: number;
      /** The same actor's REAL bindings at the three levels C7 left untested. */
      dealerGroupRoleBindingId: string;
      dealerGroupRoleBindingVersion: number;
      legalEntityRoleBindingId: string;
      legalEntityRoleBindingVersion: number;
      departmentRoleBindingId: string;
      departmentRoleBindingVersion: number;
      /** A SECOND real live session for the same actor, at a DIFFERENT auth_time. */
      staleSessionId: string;
      /** A real actor in the OTHER tenant, with a real binding of their own. */
      otherLinkId: string;
      otherSubject: string;
      otherConnectionId: string;
      otherSessionId: string;
      otherRoleBindingId: string;
      otherRoleBindingVersion: number;
      /** A real PLATFORM person, holding a real PLATFORM-scope binding. */
      platformLinkId: string;
      platformSubject: string;
      platformConnectionId: string;
      platformSessionId: string;
      platformRoleBindingId: string;
      platformRoleBindingVersion: number;
    }

    let f: Fixture;

    beforeEach(async () => {
      await resetDatabase();
      const tenant = await seedTenantViaService({
        name: 'Reconstruction Motors',
        status: 'active',
      });
      const other = await seedTenantViaService({ name: 'Elsewhere Motors', status: 'active' });
      await ensureActiveConnection(tenant.tenantId);
      await ensureActiveConnection(other.tenantId);
      await ensureActiveConnection(null);

      // A REAL organization chain: one group, one entity, TWO sibling rooftops and a
      // department beneath the first. Every C7 case below is assembled out of these
      // rows, so the sibling really is a sibling and the tenant really is the node
      // above — not a random UUID a foreign key would have caught anyway.
      const group = await seedDealerGroup({
        tenantId: tenant.tenantId,
        name: 'Reconstruction Group',
        status: 'active',
      });
      const entity = await seedLegalEntity({
        tenantId: tenant.tenantId,
        dealerGroupId: group.dealerGroupId,
        name: 'Reconstruction Entity LLC',
        status: 'active',
      });
      const rooftopA = await seedRooftop({
        tenantId: tenant.tenantId,
        legalEntityId: entity.legalEntityId,
        name: 'Reconstruction North',
        status: 'active',
      });
      const rooftopB = await seedRooftop({
        tenantId: tenant.tenantId,
        legalEntityId: entity.legalEntityId,
        name: 'Reconstruction South',
        status: 'active',
      });
      const departmentA = await seedDepartment({
        tenantId: tenant.tenantId,
        rooftopId: rooftopA.rooftopId,
        code: 'service',
        name: 'Reconstruction Service',
        status: 'active',
      });

      // A SECOND branch of the same tenant's chain: a sibling dealer group, its own
      // legal entity, and a rooftop beneath that entity. These are what make the
      // dealer-group and legal-entity halves of C7's rule expressible with REAL rows —
      // a node that exists, sits in the right tenant, and is simply not beneath the
      // binding claiming authority over it.
      const groupB = await seedDealerGroup({
        tenantId: tenant.tenantId,
        name: 'Reconstruction Group East',
        status: 'active',
      });
      const entityB = await seedLegalEntity({
        tenantId: tenant.tenantId,
        dealerGroupId: groupB.dealerGroupId,
        name: 'Reconstruction East Entity LLC',
        status: 'active',
      });
      const rooftopC = await seedRooftop({
        tenantId: tenant.tenantId,
        legalEntityId: entityB.legalEntityId,
        name: 'Reconstruction East',
        status: 'active',
      });

      // A real organization chain in the OTHER tenant, so "a node that exists but is not
      // yours" is expressible (R6-R6 §D4).
      const foreignGroup = await seedDealerGroup({
        tenantId: other.tenantId,
        name: 'Elsewhere Group',
        status: 'active',
      });
      const foreignEntity = await seedLegalEntity({
        tenantId: other.tenantId,
        dealerGroupId: foreignGroup.dealerGroupId,
        name: 'Elsewhere Entity LLC',
        status: 'active',
      });
      const foreignRooftop = await seedRooftop({
        tenantId: other.tenantId,
        legalEntityId: foreignEntity.legalEntityId,
        name: 'Elsewhere Central',
        status: 'active',
      });

      const person = await activatedLink(tenant.tenantId);
      const session = await seedLocalSession(person.linkId);
      const roleBindingId = await grant(tenant.tenantId, person.linkId);
      const secondRoleBindingId = await grant(tenant.tenantId, person.linkId, {
        role: 'service_manager',
      });
      const rooftopRoleBindingId = await grant(tenant.tenantId, person.linkId, {
        role: 'technician',
        scopeLevel: 'rooftop',
        scopeId: rooftopA.rooftopId,
      });
      // One REAL binding at each of the three levels C7's rule adjudicates and no named
      // test reached, all held by the SAME actor the decisions name.
      const dealerGroupRoleBindingId = await grant(tenant.tenantId, person.linkId, {
        role: 'service_manager',
        scopeLevel: 'dealer_group',
        scopeId: group.dealerGroupId,
      });
      const legalEntityRoleBindingId = await grant(tenant.tenantId, person.linkId, {
        role: 'service_advisor',
        scopeLevel: 'legal_entity',
        scopeId: entity.legalEntityId,
      });
      const departmentRoleBindingId = await grant(tenant.tenantId, person.linkId, {
        role: 'technician',
        scopeLevel: 'department',
        scopeId: departmentA.departmentId,
      });
      // A SECOND live session for the SAME actor, deliberately authenticated
      // earlier. It is what makes "another REAL session's authentication time" an
      // expressible adversary rather than a random timestamp.
      const stale = await seedLocalSession(person.linkId);
      await fixtureAuthorizationStateWrite(
        'simulate-authorization-drift',
        `UPDATE identity_sessions SET auth_time = NOW() - INTERVAL '6 hours'
          WHERE session_id = $1`,
        [stale.sessionId],
      );

      const foreign = await activatedLink(other.tenantId);
      const foreignSession = await seedLocalSession(foreign.linkId);
      const foreignBinding = await grant(other.tenantId, foreign.linkId);

      const platform = await activatedLink(null);
      const platformSession = await seedLocalSession(platform.linkId);
      const platformBinding = await grant(null, platform.linkId, {
        role: 'platform_support',
        scopeLevel: 'platform',
        scopeId: null,
      });

      f = {
        tenantId: tenant.tenantId,
        otherTenantId: other.tenantId,
        linkId: person.linkId,
        subject: person.subject,
        connectionId: person.connectionId,
        sessionId: session.sessionId,
        roleBindingId,
        roleBindingVersion: await bindingVersion(roleBindingId),
        secondRoleBindingId,
        secondRoleBindingVersion: await bindingVersion(secondRoleBindingId),
        dealerGroupA: group.dealerGroupId,
        dealerGroupB: groupB.dealerGroupId,
        legalEntityA: entity.legalEntityId,
        legalEntityB: entityB.legalEntityId,
        rooftopA: rooftopA.rooftopId,
        rooftopB: rooftopB.rooftopId,
        rooftopC: rooftopC.rooftopId,
        departmentA: departmentA.departmentId,
        foreignRooftop: foreignRooftop.rooftopId,
        rooftopRoleBindingId,
        rooftopRoleBindingVersion: await bindingVersion(rooftopRoleBindingId),
        dealerGroupRoleBindingId,
        dealerGroupRoleBindingVersion: await bindingVersion(dealerGroupRoleBindingId),
        legalEntityRoleBindingId,
        legalEntityRoleBindingVersion: await bindingVersion(legalEntityRoleBindingId),
        departmentRoleBindingId,
        departmentRoleBindingVersion: await bindingVersion(departmentRoleBindingId),
        staleSessionId: stale.sessionId,
        otherLinkId: foreign.linkId,
        otherSubject: foreign.subject,
        otherConnectionId: foreign.connectionId,
        otherSessionId: foreignSession.sessionId,
        otherRoleBindingId: foreignBinding,
        otherRoleBindingVersion: await bindingVersion(foreignBinding),
        platformLinkId: platform.linkId,
        platformSubject: platform.subject,
        platformConnectionId: platform.connectionId,
        platformSessionId: platformSession.sessionId,
        platformRoleBindingId: platformBinding,
        platformRoleBindingVersion: await bindingVersion(platformBinding),
      };
    });

    /**
     * ONE complete version-2 ALLOW, written by hand. The pseudo-keys work exactly as
     * they do in `identity-evidence.test.ts`:
     *
     *   - `matched_role_binding_ids` / `matched_authorization_versions` are array
     *     literals; the default is the fixture actor's own REAL binding at its REAL
     *     current version, and `null` means "truthfully empty authority";
     *   - `support_window_from` and `auth_time_from` name the rows whose `expires_at`
     *     and `auth_time` the DATABASE reads inside this INSERT. Neither can be sent
     *     as a parameter: PostgreSQL keeps microseconds and a JavaScript `Date` keeps
     *     milliseconds, so a value read out and sent back is a different instant.
     *     Pass `auth_time` directly to write an arbitrary one — which is the §3.1
     *     adversary.
     */
    async function insertAllow(
      overrides: Record<string, unknown> = {},
      executor?: Executor,
    ): Promise<void> {
      const row: Record<string, unknown> = {
        tenant_id: f.tenantId,
        actor_user_link_id: f.linkId,
        actor_type: 'user',
        action: 'service.ro.view',
        decision: 'allow',
        reason_code: 'ALLOW_ROLE_BINDING',
        policy_version: 'fbl-020.1',
        request_id: 'req_' + randomUUID(),
        correlation_id: 'corr_' + randomUUID(),
        scope_level: 'tenant',
        scope_id: f.tenantId,
        session_id: f.sessionId,
        connection_id: f.connectionId,
        actor_provider_subject: f.subject,
        ...overrides,
      };
      const emptyAuthority = row.matched_role_binding_ids === null;
      const bindingIds = Array.isArray(row.matched_role_binding_ids)
        ? (row.matched_role_binding_ids as readonly string[])
        : [f.roleBindingId];
      const bindingVersions = Array.isArray(row.matched_authorization_versions)
        ? (row.matched_authorization_versions as readonly number[])
        : [f.roleBindingVersion];
      delete row.matched_role_binding_ids;
      delete row.matched_authorization_versions;

      const windowFrom =
        'support_window_from' in row
          ? (row.support_window_from as string | null)
          : ((row.support_session_id as string | undefined) ?? null);
      delete row.support_window_from;
      delete row.support_session_expires_at;

      const authTimeSupplied = 'auth_time' in row;
      const authTimeValue = row.auth_time;
      const authTimeFrom =
        'auth_time_from' in row
          ? (row.auth_time_from as string | null)
          : ((row.session_id as string | null | undefined) ?? null);
      delete row.auth_time;
      delete row.auth_time_from;

      const columns = Object.keys(row);
      const placeholders = columns.map((_, i) => `$${i + 1}`);
      const matched = emptyAuthority
        ? `'{}'::uuid[], '{}'::bigint[]`
        : `ARRAY[${bindingIds.map((b) => `'${b}'`).join(',')}]::uuid[], ` +
          `ARRAY[${bindingVersions.join(',')}]::bigint[]`;
      const windowExpression =
        windowFrom === null
          ? `NULL::timestamptz`
          : `(SELECT s.expires_at FROM support_access_sessions s
                WHERE s.support_session_id = '${windowFrom}')`;
      const authTimeExpression = authTimeSupplied
        ? `$${columns.length + 1}::timestamptz`
        : authTimeFrom === null
          ? `NULL::timestamptz`
          : `(SELECT s.auth_time FROM identity_sessions s
                WHERE s.session_id = '${authTimeFrom}')`;
      // FBL-020-R7 §3.7: an executor lets a caller run this INSERT under
      // `SET LOCAL ROLE dealership_runtime`, proving the runtime role's parent
      // write still normalizes through the database-owned path.
      const run = executor ?? { query };
      await run.query(
        `INSERT INTO policy_decisions (${columns.join(', ')},
            matched_role_binding_ids, matched_authorization_versions,
            support_session_expires_at, auth_time)
         VALUES (${placeholders.join(', ')}, ${matched}, ${windowExpression},
                 ${authTimeExpression})`,
        authTimeSupplied
          ? [...columns.map((c) => row[c]), authTimeValue]
          : columns.map((c) => row[c]),
      );
    }

    async function onlyDecisionId(): Promise<string> {
      const r = await query(`SELECT decision_id FROM policy_decisions`);
      assert.equal(r.rows.length, 1, 'the fixture wrote exactly one decision');
      return String((r.rows[0] as Record<string, unknown>).decision_id);
    }

    /**
     * Runs a direct child write with the normalizer's transaction-local marker SET.
     *
     * Migration 058 states that the marker is a GUARD AND NOT A PROOF: whoever can
     * run SQL can also run `set_config`. This helper is that sentence executed, and
     * every test using it is therefore testing the rule that survives a forged
     * marker — the equivalence trigger, the ordinality index, the composite keys —
     * rather than the guard in front of it.
     */
    async function forgingTheNormalizerMarker(
      decisionId: string,
      write: (executor: Executor) => Promise<unknown>,
    ): Promise<void> {
      await withTransaction(async (executor) => {
        await executor.query(
          `SELECT set_config('policy_evidence.normalizing_decision', $1, true)`,
          [decisionId],
        );
        await write(executor);
      });
    }

    function childInsert(
      decisionId: string,
      claim: {
        roleBindingId: string;
        actorUserLinkId: string;
        version: number;
        ordinality: number;
      },
    ): (executor: Executor) => Promise<unknown> {
      return (executor) =>
        fixtureAuthorizationStateWrite(
          'adversarial-bypass-attempt',
          `INSERT INTO policy_decision_matched_bindings
             (decision_id, role_binding_id, actor_user_link_id, authorization_version,
              match_ordinality)
           VALUES ($1, $2, $3, $4, $5)`,
          [decisionId, claim.roleBindingId, claim.actorUserLinkId, claim.version, claim.ordinality],
          { executor },
        );
    }

    /**
     * A support request + session in the named tenant, held by the named actor, and
     * APPROVED for real unless the caller asks otherwise — separation of duty and the
     * approving grant included, because both are schema rules that may not be faked.
     */
    async function supportSessionFor(
      tenantId: string,
      actorLinkId: string,
      options: {
        approve?: boolean;
        actions?: readonly string[];
        scopeLevel?: string;
        scopeId?: string | null;
        grantedAt?: string;
        expiresAt?: string;
        /**
         * FBL-020-R7 §3.2 — the session window is bounded by the REQUESTED
         * duration now, so a fixture that backdates a window must ask for a
         * duration that actually covers it.
         */
        durationMinutes?: number;
        /**
         * FBL-020-R7 §3.2 — a session cannot precede its approval, so a fixture
         * that backdates `granted_at` must backdate `decided_at` with it. The
         * scenario being staged is "the window has since closed", never "the
         * session predates the approval" — that one is now impossible to stage,
         * which is the point of the rule.
         */
        supersededAfterGrant?: boolean;
      } = {},
    ): Promise<{ sessionId: string; requestId: string }> {
      const requestId = String(
        (
          await fixtureAuthorizationStateWrite(
            'seed-authorization-state',
            `INSERT INTO support_access_requests
               (tenant_id, requester_user_link_id, requested_actions, reason,
                requested_duration_minutes, scope_level, scope_id)
             VALUES ($1, $2, $3::text[], 'FBL-020-R6 §3.4 delegation fixture', $6, $4, $5)
             RETURNING request_id`,
            [
              tenantId,
              actorLinkId,
              [...(options.actions ?? ['service.ro.view'])],
              options.scopeLevel ?? 'tenant',
              options.scopeId ?? null,
              options.durationMinutes ?? 30,
            ],
          )
        ).rows[0]?.request_id,
      );
      {
        const decider = await bootstrapAdministrator(tenantId);
        await mintReauthGrant({
          tenantId,
          userLinkId: decider,
          action: 'identity.support.approve',
          resourceType: 'support_access_request',
          resourceId: requestId,
        });
        await fixtureAuthorizationStateWrite(
          'seed-authorization-state',
          // The decision instant tracks the (possibly backdated) grant instant:
          // §3.2's schema rule is `granted_at >= decided_at`, and this fixture
          // stages windows, never premature sessions.
          `UPDATE support_access_requests
              SET status = 'approved', decided_at = ${options.grantedAt ?? 'NOW()'},
                  decided_by_user_link_id = $2,
                  approval_grant_id = (
                    SELECT g.grant_id FROM reauthentication_grants g
                     WHERE g.user_link_id = $2
                       AND g.action = 'identity.support.approve'
                       AND g.resource_id = $1)
            WHERE request_id = $1`,
          [requestId, decider],
        );
      }
      const sessionId = String(
        (
          await fixtureAuthorizationStateWrite(
            'seed-authorization-state',
            `INSERT INTO support_access_sessions
               (request_id, tenant_id, actor_user_link_id, granted_at, expires_at)
             VALUES ($1, $2, $3, ${options.grantedAt ?? 'NOW()'},
                     ${options.expiresAt ?? `NOW() + INTERVAL '30 minutes'`})
             RETURNING support_session_id`,
            [requestId, tenantId, actorLinkId],
          )
        ).rows[0]?.support_session_id,
      );
      /*
       * FBL-020-R7 §3.2 — "a delegation nobody approved" can no longer be STAGED
       * as a session under a pending request: the schema refuses that session at
       * its own INSERT now, which is the correction. What remains reachable — and
       * is exactly what 058's decision-time rule guards — is a delegation whose
       * approval has since been SUPERSEDED: the request's status moves on (the
       * documented supersession outcome), the session row survives, and a
       * decision citing it must still be refused.
       */
      if (options.supersededAfterGrant === true) {
        // `support_access_requests_check2` ties a non-null decided_at to a DECIDED
        // terminal state, and R7's immutability trigger (correctly) refuses to move
        // the decision instant — so the one reachable "approval no longer stands"
        // staging is the decided terminal state that is not an approval.
        await fixtureAuthorizationStateWrite(
          'simulate-authorization-drift',
          `UPDATE support_access_requests
              SET status = 'denied', superseded_reason = 'r7-fixture-supersession'
            WHERE request_id = $1`,
          [requestId],
        );
      }
      return { sessionId, requestId };
    }

    /** The evidence shape a platform person's support allow has to take. */
    function supportAllowBy(
      actor: { linkId: string; sessionId: string; connectionId: string; subject: string },
      delegated: { sessionId: string; requestId: string },
      overrides: Record<string, unknown> = {},
    ): Record<string, unknown> {
      return {
        actor_type: 'platform_support',
        reason_code: 'ALLOW_SUPPORT_SESSION',
        matched_role_binding_ids: null,
        actor_user_link_id: actor.linkId,
        session_id: actor.sessionId,
        connection_id: actor.connectionId,
        actor_provider_subject: actor.subject,
        support_session_id: delegated.sessionId,
        support_request_id: delegated.requestId,
        scope_level: 'tenant',
        scope_id: null,
        ...overrides,
      };
    }

    // ══ §3.1 — the recorded authentication time is the named session's ══════

    test('an ALLOW cannot record an authentication time the named session never had', async () => {
      // Every other column is real, live and correctly cross-wired: this row passes
      // `pd_credential_group_is_atomic`, `pd_credential_identity_tuple` and every
      // foreign key in the schema. Before FBL-020-R6 §3.1 it was accepted, and the
      // stored evidence then asserted an authentication that never happened.
      await assertRefusedBy(
        insertAllow({ auth_time: new Date(Date.now() - 3 * 60 * 60 * 1000) }),
        { state: RAISED, message: 'is not the authentication time of session' },
        'an allow carrying an invented authentication instant',
      );
      assert.equal(await countEvidence(), 0);
    });

    test('an ALLOW cannot borrow another REAL session’s authentication time', async () => {
      // The cross-wired case §3.5 says matters more: the instant is not fabricated at
      // all — it is the genuine `auth_time` of another genuine live session belonging
      // to THIS VERY ACTOR. Nothing about it is out of range, nothing fails a foreign
      // key, and it still describes a different authentication.
      await assertRefusedBy(
        insertAllow({ auth_time_from: f.staleSessionId }),
        { state: RAISED, message: 'is not the authentication time of session' },
        'an allow carrying a different real session’s authentication instant',
      );
      assert.equal(await countEvidence(), 0);
    });

    test('the accepted ALLOW records the session’s own authentication instant, exactly', async () => {
      await insertAllow();
      const r = await query(
        `SELECT (d.auth_time = s.auth_time) AS exact
           FROM policy_decisions d
           JOIN identity_sessions s ON s.session_id = d.session_id`,
      );
      assert.equal(r.rows.length, 1);
      assert.equal(
        (r.rows[0] as { exact: unknown }).exact,
        true,
        'the stored instant is the session’s own, compared in the database rather than in JavaScript',
      );
    });

    // ══ §3.3 — the exact version, in force, in the tenant, applicable ═══════

    test('an ALLOW cannot claim a role binding at a version it has already left', async () => {
      // The binding is real, the actor really holds it, and version 1 was REAL — it is
      // simply not the version the binding is at now. 057 refused only versions from
      // the future, so this row was accepted and the evidence claimed authority from a
      // state the binding had been moved out of.
      const before = f.roleBindingVersion;
      await changeRole({
        actingUserLinkId: await bootstrapAdministrator(f.tenantId),
        roleBindingId: f.roleBindingId,
        // A role no other binding in this fixture holds: `uq_rb_active` keys active
        // bindings by (tenant, person, role, scope), so reusing one would collide
        // with the second binding rather than advance this one.
        role: 'warranty_administrator',
      });
      const now = await bindingVersion(f.roleBindingId);
      assert.ok(now > before, 'the fixture really advanced the binding');
      await assertRefusedBy(
        insertAllow({ matched_authorization_versions: [before] }),
        { state: RAISED, message: 'must name the EXACT version' },
        'authority claimed at a superseded version',
      );
      assert.equal(await countEvidence(), 0);

      // …and the CURRENT version is accepted, so the rule is exact rather than
      // merely restrictive.
      await insertAllow({ matched_authorization_versions: [now] });
      assert.equal(await countEvidence(), 1);
    });

    test('an ALLOW cannot claim authority from a REVOKED role binding', async () => {
      await revokeRole({
        actingUserLinkId: await bootstrapAdministrator(f.tenantId),
        roleBindingId: f.roleBindingId,
      });
      await assertRefusedBy(
        insertAllow({ matched_authorization_versions: [await bindingVersion(f.roleBindingId)] }),
        { state: RAISED, message: 'is revoked, so it authorized nothing' },
        'authority claimed from a binding that had been revoked',
      );
      assert.equal(await countEvidence(), 0);
    });

    test('an ALLOW cannot claim a role binding outside its effective window', async () => {
      for (const drift of [
        {
          label: 'already expired',
          sql: `effective_from = NOW() - INTERVAL '2 hours', effective_to = NOW() - INTERVAL '1 hour'`,
        },
        {
          label: 'not yet in force',
          sql: `effective_from = NOW() + INTERVAL '1 hour', effective_to = NULL`,
        },
      ]) {
        await fixtureAuthorizationStateWrite(
          'simulate-authorization-drift',
          `UPDATE role_bindings SET ${drift.sql} WHERE role_binding_id = $1`,
          [f.roleBindingId],
        );
        // The pinned words are 058's OWN tail. R7 §3.6 added a second,
        // write-instant window judge behind this one, and both rules begin
        // 'is outside its effective window' — a pin on the shared prefix would
        // stay green with 058's clause deleted, because the 059 trigger still
        // refuses the row. The tail is what only 058's clause says.
        await assertRefusedBy(
          insertAllow({ matched_authorization_versions: [await bindingVersion(f.roleBindingId)] }),
          { state: RAISED, message: 'so it authorized nothing at this instant' },
          `authority claimed from a binding that is ${drift.label}`,
        );
        assert.equal(await countEvidence(), 0, `${drift.label}: nothing was written`);
      }
    });

    test('an ALLOW cannot claim a RESOURCE binding for a resource it does not name', async () => {
      // Wrong SCOPE, same actor, real binding: `covers()` grants a resource binding
      // no sibling and no descendant reach, and this is that rule where the evidence
      // lands.
      //
      // FBL-020-R7 §3.4: both repair orders are REAL rows of this tenant now — a
      // random UUID is refused earlier, by the registry resolution itself, and this
      // test is about the BINDING mismatch, not about nonexistence.
      const mine = randomUUID();
      const theirs = randomUUID();
      for (const ro of [mine, theirs]) {
        await query(
          `INSERT INTO repair_orders (ro_id, tenant_id, location_id, mdm_customer_id, mdm_vehicle_id)
           VALUES ($1, $2, $3, $4, $5)`,
          [ro, f.tenantId, f.rooftopA, randomUUID(), randomUUID()],
        );
      }
      const resourceBinding = await grant(f.tenantId, f.linkId, {
        role: 'service_advisor',
        scopeLevel: 'resource',
        scopeId: null,
        resourceType: 'repair_order',
        resourceId: mine,
      });
      await assertRefusedBy(
        insertAllow({
          scope_level: 'resource',
          scope_id: null,
          resource_type: 'repair_order',
          resource_id: theirs,
          matched_role_binding_ids: [resourceBinding],
          matched_authorization_versions: [await bindingVersion(resourceBinding)],
        }),
        { state: RAISED, message: 'names resource' },
        'a resource binding cited for a different resource',
      );
      assert.equal(await countEvidence(), 0);

      // The SAME row, naming the resource the binding really covers, is accepted.
      await insertAllow({
        scope_level: 'resource',
        scope_id: null,
        resource_type: 'repair_order',
        resource_id: mine,
        matched_role_binding_ids: [resourceBinding],
        matched_authorization_versions: [await bindingVersion(resourceBinding)],
      });
      assert.equal(await countEvidence(), 1);
    });

    test('a tenant ALLOW cannot claim authority from a PLATFORM-scope binding', async () => {
      // A platform binding never covers tenant data — the engine's `covers()` says so
      // in one line, and until now the evidence ledger did not. The row is otherwise
      // impeccable: a real platform person, their real live session, their real
      // platform binding, and a real approved delegation into this tenant.
      const delegated = await supportSessionFor(f.tenantId, f.platformLinkId);
      await assertRefusedBy(
        insertAllow(
          supportAllowBy(
            {
              linkId: f.platformLinkId,
              sessionId: f.platformSessionId,
              connectionId: f.platformConnectionId,
              subject: f.platformSubject,
            },
            delegated,
            {
              matched_role_binding_ids: [f.platformRoleBindingId],
              matched_authorization_versions: [f.platformRoleBindingVersion],
            },
          ),
        ),
        { state: RAISED, message: 'never covers tenant data' },
        'a platform-scope binding cited as authority over tenant data',
      );
      assert.equal(await countEvidence(), 0);
    });

    test('an ALLOW cannot claim a role binding that lives in another tenant', async () => {
      /*
       * The R6 staging of this scenario is GONE, and its disappearance is R7 §3.1
       * working: it dressed a dealership person of the other tenant as a
       * platform-support actor — a caller-supplied label — and that forgery is now
       * refused at three earlier gates (the platform-scope requirement on the
       * delegation itself, and the actor-type/actor-scope binding on the decision).
       *
       * What KEEPS the binding-tenant clause reachable, and therefore honest, is
       * the SYSTEM lane: a system decision names no presented credential and is
       * exempt from the actor-tenancy key by construction (its
       * `allowed_actor_tenant_id` is NULL), so a system row recorded in THIS
       * tenant can still cite the other-tenant actor's own real binding — both
       * composite keys resolve, and the ONLY objection left is the binding's
       * tenant. That is precisely the clause under test.
       */
      await assertRefusedBy(
        insertAllow({
          actor_type: 'system',
          reason_code: 'ALLOW_SYSTEM',
          session_id: null,
          connection_id: null,
          actor_provider_subject: null,
          auth_time: null,
          actor_user_link_id: f.otherLinkId,
          matched_role_binding_ids: [f.otherRoleBindingId],
          matched_authorization_versions: [f.otherRoleBindingVersion],
        }),
        { state: RAISED, message: 'belongs to tenant' },
        'a binding from another tenant cited as authority here',
      );
      assert.equal(await countEvidence(), 0);
    });

    test('an ALLOW cannot claim a rooftop binding as the authority for a SIBLING rooftop', async () => {
      // FBL-020-R6 gate finding C7. Being in the tenant was the whole of the reach
      // test, so this row passed: a REAL rooftop-A binding, held by the decision's own
      // actor, at its exact current version, recorded as the authority for rooftop B.
      // `covers()` matches a binding only against nodes on the acted-on node's OWN
      // ancestor chain, and a sibling rooftop is not on it.
      await assertRefusedBy(
        insertAllow({
          scope_level: 'rooftop',
          scope_id: f.rooftopB,
          matched_role_binding_ids: [f.rooftopRoleBindingId],
          matched_authorization_versions: [f.rooftopRoleBindingVersion],
        }),
        { state: RAISED, message: 'never a sibling and never the tenant above it' },
        'a rooftop binding cited as authority for its sibling rooftop',
      );
      assert.equal(await countEvidence(), 0, 'nothing was written');

      // The SAME binding, recorded against ITS OWN rooftop, is accepted — so the rule
      // refuses the sibling rather than refusing rooftop evidence.
      await insertAllow({
        scope_level: 'rooftop',
        scope_id: f.rooftopA,
        matched_role_binding_ids: [f.rooftopRoleBindingId],
        matched_authorization_versions: [f.rooftopRoleBindingVersion],
      });
      assert.equal(await countEvidence(), 1);
    });

    test('an ALLOW cannot claim a rooftop binding as the authority for the WHOLE TENANT', async () => {
      // The other half of C7, and the escalation `coversTenantWide` exists to refuse:
      // a sub-tenant binding NEVER widens to tenant-wide reach. The decision records
      // tenant scope; the binding names one rooftop inside it.
      await assertRefusedBy(
        insertAllow({
          scope_level: 'tenant',
          scope_id: f.tenantId,
          matched_role_binding_ids: [f.rooftopRoleBindingId],
          matched_authorization_versions: [f.rooftopRoleBindingVersion],
        }),
        { state: RAISED, message: 'never a sibling and never the tenant above it' },
        'a rooftop binding cited as authority for the whole tenant',
      );
      assert.equal(await countEvidence(), 0, 'nothing was written');

      // …and a DEPARTMENT beneath that rooftop IS covered, because a binding covers
      // its own node and what sits beneath it. Without this the test above would pass
      // against a rule that simply refused every organization-scoped binding.
      await insertAllow({
        scope_level: 'department',
        scope_id: f.departmentA,
        matched_role_binding_ids: [f.rooftopRoleBindingId],
        matched_authorization_versions: [f.rooftopRoleBindingVersion],
      });
      assert.equal(await countEvidence(), 1);
    });

    /*
     * THE THREE LEVELS C7 CLOSED IN THE MIGRATION AND NO NAMED TEST REACHED.
     *
     * C7's rule is ONE `RAISE` guarded by FIVE comparisons — one for a tenant-scope
     * binding and one for each organization level a binding can sit at. The two tests
     * above exercise the `rooftop` comparison and the one below the `tenant` one, so
     * `dealer_group`, `legal_entity` and `department` were credited to C7 while nothing
     * named drove them: dropping any one of those three left every test green, which is
     * the definition of an unproven control.
     *
     * Each gets its own named test and its own mutation entry in
     * `scripts/database-control-mutations.ts`, and each carries an ACCEPTED leg, because
     * a refusal test alone passes just as happily against a rule that refuses every
     * organization-scoped binding.
     */
    test('an ALLOW cannot claim a DEALER-GROUP binding as the authority for a SIBLING group', async () => {
      // A real dealer-group-A binding, held by the decision's own actor, at its exact
      // current version — recorded as the authority for a legal entity that hangs off
      // dealer group B. Group B is a genuine sibling in the same tenant, so every
      // foreign key and the tenant test above it are satisfied.
      await assertRefusedBy(
        insertAllow({
          scope_level: 'legal_entity',
          scope_id: f.legalEntityB,
          matched_role_binding_ids: [f.dealerGroupRoleBindingId],
          matched_authorization_versions: [f.dealerGroupRoleBindingVersion],
        }),
        { state: RAISED, message: 'never a sibling and never the tenant above it' },
        'a dealer-group binding cited as authority under its sibling group',
      );
      assert.equal(await countEvidence(), 0, 'nothing was written');

      // The SAME binding, against the legal entity that IS beneath it, is accepted.
      await insertAllow({
        scope_level: 'legal_entity',
        scope_id: f.legalEntityA,
        matched_role_binding_ids: [f.dealerGroupRoleBindingId],
        matched_authorization_versions: [f.dealerGroupRoleBindingVersion],
      });
      assert.equal(await countEvidence(), 1);
    });

    test('an ALLOW cannot claim a LEGAL-ENTITY binding as the authority for a rooftop in ANOTHER entity', async () => {
      // Rooftop C is a real rooftop in the same tenant, beneath legal entity B. A
      // legal-entity-A binding never reached it: `covers()` matches only nodes on the
      // acted-on node's own ancestor chain, and entity A is not on rooftop C's.
      await assertRefusedBy(
        insertAllow({
          scope_level: 'rooftop',
          scope_id: f.rooftopC,
          matched_role_binding_ids: [f.legalEntityRoleBindingId],
          matched_authorization_versions: [f.legalEntityRoleBindingVersion],
        }),
        { state: RAISED, message: 'never a sibling and never the tenant above it' },
        'a legal-entity binding cited as authority for a rooftop in another entity',
      );
      assert.equal(await countEvidence(), 0, 'nothing was written');

      // …and rooftop A, which IS beneath legal entity A, is accepted.
      await insertAllow({
        scope_level: 'rooftop',
        scope_id: f.rooftopA,
        matched_role_binding_ids: [f.legalEntityRoleBindingId],
        matched_authorization_versions: [f.legalEntityRoleBindingVersion],
      });
      assert.equal(await countEvidence(), 1);
    });

    test('an ALLOW cannot claim a DEPARTMENT binding as the authority for the rooftop ABOVE it', async () => {
      // The narrowest level, and the one where "upward" is the whole error: the
      // department sits beneath rooftop A, so a decision recorded at rooftop A is
      // strictly wider than anything that binding ever granted.
      await assertRefusedBy(
        insertAllow({
          scope_level: 'rooftop',
          scope_id: f.rooftopA,
          matched_role_binding_ids: [f.departmentRoleBindingId],
          matched_authorization_versions: [f.departmentRoleBindingVersion],
        }),
        { state: RAISED, message: 'never a sibling and never the tenant above it' },
        'a department binding cited as authority for the rooftop above it',
      );
      assert.equal(await countEvidence(), 0, 'nothing was written');

      // The SAME binding, against its OWN department, is accepted.
      await insertAllow({
        scope_level: 'department',
        scope_id: f.departmentA,
        matched_role_binding_ids: [f.departmentRoleBindingId],
        matched_authorization_versions: [f.departmentRoleBindingVersion],
      });
      assert.equal(await countEvidence(), 1);
    });

    test('an ALLOW cannot record an organization node that exists NOWHERE', async () => {
      /*
       * FBL-020-R6-R6 gate finding D4, and the reason it survived C7.
       *
       * The scope hierarchy resolved the DECISION's organization node only when the matched
       * BINDING was organization-scoped, because only then was anything compared against it.
       * A TENANT-scope binding took the other branch — and a tenant binding really does
       * cover every node in its tenant, so the hierarchy had nothing to object to. What
       * nothing asked was whether the node the decision recorded IS A NODE.
       *
       * So this row was accepted: the fixture actor's own REAL tenant-scope binding at its
       * REAL current version, the actor's own live session, every foreign key satisfied —
       * and `rooftop:<a uuid that is a rooftop nowhere>` as the scope acted in. It is not a
       * sibling and not the tenant above; it resolves to nothing at all, and an operator
       * following the trail after an incident reaches a dead end.
       *
       * `policy_decisions.scope_id` is polymorphic and can carry no foreign key (057 §11
       * says so and declines to pretend otherwise), which is why the check has to be a
       * trigger.
       */
      const nowhere = randomUUID();
      // FBL-020-R7 §3.5 moved the load: the PARENT trigger now judges the
      // decision's own scope node against the one ancestry authority, at the
      // actual write instant, so the refusal fires there and carries its wording.
      // 058's child-side existence check remains beneath it as defense in depth.
      await assertRefusedBy(
        insertAllow({ scope_level: 'rooftop', scope_id: nowhere }),
        { state: RAISED, message: 'does not exist in tenant' },
        'an ALLOW recording a rooftop that is a rooftop nowhere',
      );
      assert.equal(await countEvidence(), 0, 'nothing was written');

      // The SAME shape naming a node in ANOTHER tenant is refused too — existence alone is
      // not enough, the node must be in the tenant the decision was recorded in.
      await assertRefusedBy(
        insertAllow({ scope_level: 'rooftop', scope_id: f.foreignRooftop }),
        { state: RAISED, message: 'does not exist in tenant' },
        'an ALLOW recording a REAL rooftop belonging to another tenant',
      );
      assert.equal(await countEvidence(), 0);

      // …and a tenant-scope decision must name ITS OWN tenant, not some other id.
      await assertRefusedBy(
        insertAllow({ scope_level: 'tenant', scope_id: f.otherTenantId }),
        { state: RAISED, message: 'names its own tenant and nothing else' },
        'a tenant-scope ALLOW recording a different tenant as the scope acted in',
      );
      assert.equal(await countEvidence(), 0);

      // The rule refuses a node that does not exist, NOT organization-scoped evidence: the
      // same binding, recording a REAL rooftop in its own tenant, is accepted. Without this
      // leg the three above would pass against a rule that refused everything.
      await insertAllow({ scope_level: 'rooftop', scope_id: f.rooftopA });
      assert.equal(await countEvidence(), 1);
    });

    test('an ALLOW cannot claim a tenant-scope binding that names a DIFFERENT tenant', async () => {
      // `coversTenantWide` requires the binding's own `scope_id` to BE the target
      // tenant. `role_bindings` only requires a tenant-scope binding to carry some
      // scope id, so a binding sitting in this tenant while naming another one is a
      // storable row — and it authorized nothing.
      const misScoped = await grant(f.tenantId, f.linkId, {
        role: 'service_advisor',
        scopeLevel: 'tenant',
        scopeId: f.otherTenantId,
      });
      await assertRefusedBy(
        insertAllow({
          matched_role_binding_ids: [misScoped],
          matched_authorization_versions: [await bindingVersion(misScoped)],
        }),
        { state: RAISED, message: 'covers its own tenant and no other' },
        'a tenant-scope binding naming another tenant cited as authority',
      );
      assert.equal(await countEvidence(), 0);
    });

    // ══ §3.2 — the normalized evidence is exactly the array ═════════════════

    test('the normalized rows of an accepted ALLOW are exactly its array, in order', async () => {
      await insertAllow({
        matched_role_binding_ids: [f.roleBindingId, f.secondRoleBindingId],
        matched_authorization_versions: [f.roleBindingVersion, f.secondRoleBindingVersion],
      });
      const rows = (
        await query(
          `SELECT role_binding_id, authorization_version, match_ordinality
             FROM policy_decision_matched_bindings ORDER BY match_ordinality`,
        )
      ).rows as Array<Record<string, unknown>>;
      assert.deepEqual(
        rows.map((r) => [
          String(r.role_binding_id),
          Number(r.authorization_version),
          Number(r.match_ordinality),
        ]),
        [
          [f.roleBindingId, f.roleBindingVersion, 1],
          [f.secondRoleBindingId, f.secondRoleBindingVersion, 2],
        ],
        'one child row per claim, at contiguous ordinality, at the array’s own versions',
      );
    });

    test('a child row written with no normalizer behind it is refused', async () => {
      /*
       * FBL-020-R7 §3.7 — THE WRITER GUARD IS THE PRIVILEGE SYSTEM, NOT A GUC.
       *
       * 058 guarded this table with `policy_evidence.normalizing_decision`, a
       * setting ANY session could set — the forged marker below proves it is not
       * authorization. The guard now is that the runtime role simply holds no
       * INSERT on this table: the same hand-written row, attempted AS THE ACTUAL
       * RUNTIME ROLE with the GUC forged to exactly the right value, dies with
       * SQLSTATE 42501 before any trigger runs. The role model is asserted too:
       * the runtime role is NOT a member of the evidence owner and cannot assume
       * it. (The test connects as the superuser and SET ROLEs down, exactly as
       * the pooled application connections assume the role at startup.)
       */
      await insertAllow();
      const decisionId = await onlyDecisionId();
      const membership = await query(
        `SELECT pg_has_role('dealership_runtime', 'dealership_evidence_owner', 'member') AS m`,
      );
      assert.equal(
        (membership.rows[0] as { m: boolean }).m,
        false,
        'the runtime role must not be able to assume the evidence owner',
      );
      // The refusal is CAPTURED inside the transaction and JUDGED outside it:
      // the trailing catch exists to absorb the transaction abort the refusal
      // causes, and an assertion placed inside would be absorbed with it — a
      // dead assertion, which is exactly what the §4.1 runner's grant-back
      // mutation flushed out of this test's first draft.
      let refused: { code?: string } | null = null;
      await withTransaction(async (executor) => {
        await executor.query(`SET LOCAL ROLE dealership_runtime`);
        await executor.query(
          `SELECT set_config('policy_evidence.normalizing_decision', $1, true)`,
          [decisionId],
        );
        try {
          await fixtureAuthorizationStateWrite(
            'adversarial-bypass-attempt',
            `INSERT INTO policy_decision_matched_bindings
               (decision_id, role_binding_id, actor_user_link_id, authorization_version,
                match_ordinality)
             VALUES ($1, $2, $3, $4, 2)`,
            [decisionId, f.secondRoleBindingId, f.linkId, f.secondRoleBindingVersion],
            { executor },
          );
        } catch (err) {
          refused = err as { code?: string };
        }
        // the transaction is aborted by the refusal; nothing after it would run
      }).catch(() => undefined);
      assert.ok(refused, 'the direct insert as the runtime role must be refused');
      assert.equal(
        (refused as { code?: string }).code,
        '42501',
        'and refused by the PRIVILEGE SYSTEM (insufficient_privilege), not by a forgeable marker',
      );
      const rows = await query(`SELECT 1 FROM policy_decision_matched_bindings`);
      assert.equal(rows.rows.length, 1, 'the smuggled claim was not recorded');

      // …and the POSITIVE half of §3.7: the runtime role inserting the PARENT
      // still causes database-owned normalization, because the SECURITY DEFINER
      // path — not the caller's own privilege — writes the child rows.
      await withTransaction(async (executor) => {
        await executor.query(`SET LOCAL ROLE dealership_runtime`);
        await insertAllow({ request_id: 'req_' + randomUUID() }, executor);
      });
      const normalized = await query(`SELECT decision_id FROM policy_decision_matched_bindings`);
      assert.equal(
        normalized.rows.length,
        2,
        'the parent insert as the runtime role still normalizes, through the database-owned path',
      );
    });

    test('an EXTRA normalized row cannot be attached to a decision, marker or no marker', async () => {
      // THE ROW THE OLD SCHEMA ACCEPTED. It names the decision's OWN actor and a
      // SECOND binding that actor REALLY holds, at that binding's REAL current
      // version, at a fresh ordinality — so both composite keys, the primary key, the
      // version rule and the applicability rule are all satisfied. The only thing
      // wrong with it is that the parent array never claimed it, which is precisely
      // the divergence R6 §3.2 says the "one writer" claim did not prevent.
      await insertAllow();
      const decisionId = await onlyDecisionId();
      await assertRefusedBy(
        forgingTheNormalizerMarker(
          decisionId,
          childInsert(decisionId, {
            roleBindingId: f.secondRoleBindingId,
            actorUserLinkId: f.linkId,
            version: f.secondRoleBindingVersion,
            ordinality: 2,
          }),
        ),
        { state: RAISED, message: 'not equivalent to the matched-binding array' },
        'an extra authority claim the decision’s array never made',
      );
      const rows = await query(
        `SELECT role_binding_id FROM policy_decision_matched_bindings WHERE decision_id = $1`,
        [decisionId],
      );
      assert.equal(rows.rows.length, 1, 'the extra claim was not recorded');
      assert.equal(
        String((rows.rows[0] as Record<string, unknown>).role_binding_id),
        f.roleBindingId,
      );
    });

    test('a normalized row cannot repeat an ordinality the decision already used', async () => {
      // The primary key is (decision_id, role_binding_id), so a SECOND binding at the
      // SAME ordinality slipped past it. Ordinality is what makes the child rows and
      // the array positionally comparable; duplicated, it makes "which version went
      // with which binding" unanswerable.
      await insertAllow();
      const decisionId = await onlyDecisionId();
      await assertRefusedBy(
        forgingTheNormalizerMarker(
          decisionId,
          childInsert(decisionId, {
            roleBindingId: f.secondRoleBindingId,
            actorUserLinkId: f.linkId,
            version: f.secondRoleBindingVersion,
            ordinality: 1,
          }),
        ),
        { state: UNIQUE_VIOLATION, constraint: 'uq_pdmb_ordinality' },
        'a second authority claim at an ordinality already taken',
      );
    });

    // ══ §3.4 — delegated support evidence, required and validated ═══════════

    test('a platform-support ALLOW into a tenant cannot omit its delegated-support evidence', async () => {
      // The row claims authority from a real platform binding and names no support
      // session at all — a platform person inside a customer's data with no approved
      // delegation recorded anywhere. `pd_v2_allow_has_authority_evidence` accepted it
      // because a matched binding satisfies that rule on its own.
      await assertRefusedBy(
        insertAllow({
          actor_type: 'platform_support',
          reason_code: 'ALLOW_PLATFORM_ROLE',
          actor_user_link_id: f.platformLinkId,
          session_id: f.platformSessionId,
          connection_id: f.platformConnectionId,
          actor_provider_subject: f.platformSubject,
          matched_role_binding_ids: [f.platformRoleBindingId],
          matched_authorization_versions: [f.platformRoleBindingVersion],
        }),
        { state: CHECK_VIOLATION, constraint: 'pd_v2_support_tenant_allow_is_delegated' },
        'a platform-support allow into a tenant with no delegation',
      );
      assert.equal(await countEvidence(), 0);
    });

    test('a support ALLOW cannot cite a delegation nobody approved', async () => {
      // FBL-020-R7 §3.2 restaged this scenario, and the restaging IS evidence:
      // the session-under-a-pending-request this test used to build is refused at
      // the session's own INSERT now, so the only reachable shape of "no live
      // approval behind the delegation" is an approval that has since been
      // SUPERSEDED — which 058's decision-time rule must still refuse.
      const superseded = await supportSessionFor(f.tenantId, f.platformLinkId, {
        supersededAfterGrant: true,
      });
      await assertRefusedBy(
        insertAllow(
          supportAllowBy(
            {
              linkId: f.platformLinkId,
              sessionId: f.platformSessionId,
              connectionId: f.platformConnectionId,
              subject: f.platformSubject,
            },
            superseded,
          ),
        ),
        { state: RAISED, message: 'so it delegates nothing' },
        'a support allow citing a request whose approval was superseded',
      );
      assert.equal(await countEvidence(), 0);
    });

    test('a support ALLOW cannot exceed the approved ACTION set', async () => {
      const delegated = await supportSessionFor(f.tenantId, f.platformLinkId, {
        actions: ['service.ro.view'],
      });
      await assertRefusedBy(
        insertAllow(
          supportAllowBy(
            {
              linkId: f.platformLinkId,
              sessionId: f.platformSessionId,
              connectionId: f.platformConnectionId,
              subject: f.platformSubject,
            },
            delegated,
            { action: 'service.ro.void_line' },
          ),
        ),
        { state: RAISED, message: 'does not approve action' },
        'a support allow for an action the approval never covered',
      );
      assert.equal(await countEvidence(), 0);
    });

    test('a support ALLOW cannot exceed the approved SCOPE', async () => {
      // FBL-020-R7 §3.2: the approved scope must be a REAL, effective node of the
      // request's tenant — a random UUID is refused at the approval itself now —
      // so the delegation is approved for the fixture's real rooftop A.
      const rooftop = f.rooftopA;
      const delegated = await supportSessionFor(f.tenantId, f.platformLinkId, {
        scopeLevel: 'rooftop',
        scopeId: rooftop,
      });
      const actor = {
        linkId: f.platformLinkId,
        sessionId: f.platformSessionId,
        connectionId: f.platformConnectionId,
        subject: f.platformSubject,
      };
      await assertRefusedBy(
        insertAllow(supportAllowBy(actor, delegated, { scope_level: 'tenant', scope_id: null })),
        { state: RAISED, message: 'approves scope' },
        'a rooftop delegation recorded as tenant-wide reach',
      );
      assert.equal(await countEvidence(), 0);

      // The same delegation, recorded at the scope it really approved, is accepted.
      await insertAllow(
        insertScope(supportAllowBy(actor, delegated), { level: 'rooftop', id: rooftop }),
      );
      assert.equal(await countEvidence(), 1);
    });

    test('a support ALLOW cannot be recorded against a REVOKED delegation', async () => {
      const delegated = await supportSessionFor(f.tenantId, f.platformLinkId);
      await fixtureAuthorizationStateWrite(
        'simulate-authorization-drift',
        `UPDATE support_access_sessions SET revoked_at = NOW() WHERE support_session_id = $1`,
        [delegated.sessionId],
      );
      await assertRefusedBy(
        insertAllow(
          supportAllowBy(
            {
              linkId: f.platformLinkId,
              sessionId: f.platformSessionId,
              connectionId: f.platformConnectionId,
              subject: f.platformSubject,
            },
            delegated,
          ),
        ),
        { state: RAISED, message: 'was revoked at' },
        'a support allow recorded after the delegation was revoked',
      );
      assert.equal(await countEvidence(), 0);
    });

    test('a support ALLOW cannot be recorded outside the delegated WINDOW', async () => {
      // The window closed half an hour ago. Nothing else about the row changes: the
      // session, the request, the tenant, the actor and the recorded expiry all still
      // agree, which is exactly why 057's tuple key and window trigger both pass it.
      const delegated = await supportSessionFor(f.tenantId, f.platformLinkId, {
        grantedAt: `NOW() - INTERVAL '90 minutes'`,
        expiresAt: `NOW() - INTERVAL '30 minutes'`,
        // §3.2 bounds the window by the REQUESTED duration; this sixty-minute
        // window needs a sixty-minute request, and the fixture asks for exactly
        // that rather than leaning on the old unbounded default.
        durationMinutes: 60,
      });
      await assertRefusedBy(
        insertAllow(
          supportAllowBy(
            {
              linkId: f.platformLinkId,
              sessionId: f.platformSessionId,
              connectionId: f.platformConnectionId,
              subject: f.platformSubject,
            },
            delegated,
          ),
        ),
        { state: RAISED, message: 'and support session' },
        'a support allow timed outside the delegated window',
      );
      assert.equal(await countEvidence(), 0);
    });

    /** Applies a scope to a prepared support-allow shape, keeping the rest intact. */
    function insertScope(
      shape: Record<string, unknown>,
      scope: { level: string; id: string | null },
    ): Record<string, unknown> {
      return { ...shape, scope_level: scope.level, scope_id: scope.id };
    }
  },
);
