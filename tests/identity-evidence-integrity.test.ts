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
  seedLegalEntity,
  seedLocalSession,
  seedRooftop,
  seedTenantViaService,
  shiftSupportWindowIntoThePast,
  skipIntegration,
} from '@dealer/test-kit';
import { closePool, query, withTransaction, type Executor } from '@dealer/database';
import { grantRole } from '@dealer/identity-access';

/**
 * FBL-020-R7 §3 — DIRECT-SQL ADVERSARIAL TESTS FOR THE INTEGRITY CLOSURE.
 *
 * The same discipline as `identity-evidence-reconstruction.test.ts`, for the same
 * reason: every claim here is that a piece of evidence is UNREPRESENTABLE, and the
 * adversary that matters writes SQL. Every negative case is built from REAL,
 * CROSS-WIRED rows — a real second platform person, a real sibling rooftop, a real
 * binding whose window really closes while a transaction is really open — and every
 * rule under test carries a control leg proving the honest shape is still accepted.
 *
 * What migration 059 closes, clause by clause, is in its own header; this battery is
 * the §3 evidence for it: the support tuple (§3.1), the approval bounds (§3.2), the
 * structural control-plane rule (§3.3), the resource-ancestry rule (§3.4), the
 * effective-chain rule (§3.5) and write-instant liveness (§3.6). §3.7's runtime-role
 * tests live beside the writer-guard history in the reconstruction battery.
 */
describe(
  'policy-evidence integrity closure (FBL-020-R7 §3)',
  { skip: skipIntegration ? 'set TEST_DATABASE_URL to run' : false },
  () => {
    const CHECK_VIOLATION = '23514';
    const FK_VIOLATION = '23503';
    const RAISED = 'P0001';

    after(async () => {
      await closePool();
    });

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
            `${what}: expected SQLSTATE ${by.state}, got ${String(e.code)}: ${String(e.message)}`,
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
      return { linkId: String(row.user_link_id), subject, connectionId: String(row.connection_id) };
    }

    async function grant(
      tenantId: string | null,
      userLinkId: string,
      options: { role?: string; scopeLevel?: string; scopeId?: string | null } = {},
    ): Promise<string> {
      const granted = await grantRole({
        actingUserLinkId: await bootstrapAdministrator(tenantId),
        tenantId,
        userLinkId,
        role: options.role ?? 'service_advisor',
        scopeLevel: options.scopeLevel ?? 'tenant',
        scopeId: options.scopeId === undefined ? tenantId : options.scopeId,
        resourceType: null,
        resourceId: null,
      });
      return granted.roleBindingId;
    }

    async function bindingVersion(roleBindingId: string): Promise<number> {
      const r = await query(
        `SELECT authorization_version FROM role_bindings WHERE role_binding_id = $1`,
        [roleBindingId],
      );
      return Number((r.rows[0] as Record<string, unknown>).authorization_version);
    }

    interface Fixture {
      tenantId: string;
      otherTenantId: string;
      /** dealership actor of the tenant, live session, tenant-scope binding */
      linkId: string;
      subject: string;
      connectionId: string;
      sessionId: string;
      roleBindingId: string;
      roleBindingVersion: number;
      /** the same actor's rooftop-A and legal-entity bindings */
      rooftopABindingId: string;
      rooftopABindingVersion: number;
      entityBindingId: string;
      entityBindingVersion: number;
      /** the chain */
      dealerGroupA: string;
      legalEntityA: string;
      rooftopA: string;
      rooftopB: string;
      foreignRooftop: string;
      /** two REAL platform people, each with a live session */
      platformLinkId: string;
      platformSubject: string;
      platformConnectionId: string;
      platformSessionId: string;
      platformBindingId: string;
      platformBindingVersion: number;
      platformTwoLinkId: string;
      /** real repair orders */
      roAtRooftopA: string;
      roAtRooftopB: string;
      foreignRo: string;
    }

    let f: Fixture;

    beforeEach(async () => {
      await resetDatabase();
      const tenant = await seedTenantViaService({ name: 'Integrity Motors', status: 'active' });
      const other = await seedTenantViaService({ name: 'Elsewhere Motors', status: 'active' });
      await ensureActiveConnection(tenant.tenantId);
      await ensureActiveConnection(other.tenantId);
      await ensureActiveConnection(null);

      const group = await seedDealerGroup({
        tenantId: tenant.tenantId,
        name: 'Integrity Group',
        status: 'active',
      });
      const entity = await seedLegalEntity({
        tenantId: tenant.tenantId,
        dealerGroupId: group.dealerGroupId,
        name: 'Integrity Entity LLC',
        status: 'active',
      });
      const rooftopA = await seedRooftop({
        tenantId: tenant.tenantId,
        legalEntityId: entity.legalEntityId,
        name: 'Integrity North',
        status: 'active',
      });
      const rooftopB = await seedRooftop({
        tenantId: tenant.tenantId,
        legalEntityId: entity.legalEntityId,
        name: 'Integrity South',
        status: 'active',
      });
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
      const rooftopABindingId = await grant(tenant.tenantId, person.linkId, {
        role: 'technician',
        scopeLevel: 'rooftop',
        scopeId: rooftopA.rooftopId,
      });
      const entityBindingId = await grant(tenant.tenantId, person.linkId, {
        role: 'service_manager',
        scopeLevel: 'legal_entity',
        scopeId: entity.legalEntityId,
      });

      const platform = await activatedLink(null);
      const platformSession = await seedLocalSession(platform.linkId);
      const platformBindingId = await grant(null, platform.linkId, {
        role: 'platform_support',
        scopeLevel: 'platform',
        scopeId: null,
      });
      const platformTwo = await activatedLink(null);

      // real Fixed Ops resources, one per rooftop plus one in the other tenant
      const roAtRooftopA = randomUUID();
      const roAtRooftopB = randomUUID();
      const foreignRo = randomUUID();
      for (const [ro, tid, loc] of [
        [roAtRooftopA, tenant.tenantId, rooftopA.rooftopId],
        [roAtRooftopB, tenant.tenantId, rooftopB.rooftopId],
        [foreignRo, other.tenantId, foreignRooftop.rooftopId],
      ] as const) {
        await query(
          `INSERT INTO repair_orders (ro_id, tenant_id, location_id, mdm_customer_id, mdm_vehicle_id)
           VALUES ($1, $2, $3, $4, $5)`,
          [ro, tid, loc, randomUUID(), randomUUID()],
        );
      }

      f = {
        tenantId: tenant.tenantId,
        otherTenantId: other.tenantId,
        linkId: person.linkId,
        subject: person.subject,
        connectionId: person.connectionId,
        sessionId: session.sessionId,
        roleBindingId,
        roleBindingVersion: await bindingVersion(roleBindingId),
        rooftopABindingId,
        rooftopABindingVersion: await bindingVersion(rooftopABindingId),
        entityBindingId,
        entityBindingVersion: await bindingVersion(entityBindingId),
        dealerGroupA: group.dealerGroupId,
        legalEntityA: entity.legalEntityId,
        rooftopA: rooftopA.rooftopId,
        rooftopB: rooftopB.rooftopId,
        foreignRooftop: foreignRooftop.rooftopId,
        platformLinkId: platform.linkId,
        platformSubject: platform.subject,
        platformConnectionId: platform.connectionId,
        platformSessionId: platformSession.sessionId,
        platformBindingId,
        platformBindingVersion: await bindingVersion(platformBindingId),
        platformTwoLinkId: platformTwo.linkId,
        roAtRooftopA,
        roAtRooftopB,
        foreignRo,
      };
    });

    /**
     * ONE complete current-version ALLOW, written by hand — the same pseudo-keys as
     * the sibling batteries: array literals for the matched bindings, and the window
     * and authentication instants read from the rows they must equal INSIDE the
     * INSERT (a value that round-trips through a JavaScript `Date` is a different
     * instant). An optional executor lets a case run inside its own transaction —
     * which is exactly what the write-instant tests need.
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
      const windowFrom = (row.support_session_id as string | undefined) ?? null;
      const authTimeFrom = (row.session_id as string | null | undefined) ?? null;
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
      const authTimeExpression =
        authTimeFrom === null
          ? `NULL::timestamptz`
          : `(SELECT s.auth_time FROM identity_sessions s
                WHERE s.session_id = '${authTimeFrom}')`;
      const run = executor ?? { query };
      await run.query(
        `INSERT INTO policy_decisions (${columns.join(', ')},
            matched_role_binding_ids, matched_authorization_versions,
            support_session_expires_at, auth_time)
         VALUES (${placeholders.join(', ')}, ${matched}, ${windowExpression},
                 ${authTimeExpression})`,
        columns.map((c) => row[c]),
      );
    }

    async function countEvidence(): Promise<number> {
      const r = await query(`SELECT COUNT(*)::int AS n FROM policy_decisions`);
      return Number((r.rows[0] as { n: number }).n);
    }

    /** Files a support request for the platform actor; approves it unless told not to. */
    async function supportRequest(options: {
      requester?: string;
      approve?: boolean;
      durationMinutes?: number;
      scopeLevel?: string;
      scopeId?: string | null;
      grantAction?: string;
      grantResourceId?: string | null;
    }): Promise<{ requestId: string; deciderId: string }> {
      const requester = options.requester ?? f.platformLinkId;
      const requestId = String(
        (
          await fixtureAuthorizationStateWrite(
            'seed-authorization-state',
            `INSERT INTO support_access_requests
               (tenant_id, requester_user_link_id, requested_actions, reason,
                requested_duration_minutes, scope_level, scope_id)
             VALUES ($1, $2, ARRAY['service.ro.view'], 'r7 integrity fixture', $3, $4, $5)
             RETURNING request_id`,
            [
              f.tenantId,
              requester,
              options.durationMinutes ?? 30,
              options.scopeLevel ?? 'tenant',
              options.scopeId ?? null,
            ],
          )
        ).rows[0]?.request_id,
      );
      const deciderId = await bootstrapAdministrator(f.tenantId);
      if (options.approve !== false) {
        await mintReauthGrant({
          tenantId: f.tenantId,
          userLinkId: deciderId,
          action: options.grantAction ?? 'identity.support.approve',
          resourceType: 'support_access_request',
          resourceId:
            options.grantResourceId === undefined
              ? requestId
              : (options.grantResourceId ?? requestId),
        });
        await fixtureAuthorizationStateWrite(
          'seed-authorization-state',
          `UPDATE support_access_requests
              SET status = 'approved', decided_at = NOW(), decided_by_user_link_id = $2,
                  approval_grant_id = (
                    SELECT g.grant_id FROM reauthentication_grants g
                     WHERE g.user_link_id = $2 ORDER BY g.created_at DESC LIMIT 1)
            WHERE request_id = $1`,
          [requestId, deciderId],
        );
      }
      return { requestId, deciderId };
    }

    // ══ §3.1 — the support tuple ═══════════════════════════════════════════

    test('a support session cannot substitute another REAL platform actor for the approved requester', async () => {
      const { requestId } = await supportRequest({});
      // The substitute is REAL, platform-scope, activated — everything a support
      // actor must be, except the one thing that matters: not the person this
      // approval delegated to. Before R7 nothing referential refused this row.
      await assertRefusedBy(
        fixtureAuthorizationStateWrite(
          'adversarial-bypass-attempt',
          `INSERT INTO support_access_sessions
             (request_id, tenant_id, actor_user_link_id, expires_at)
           VALUES ($1, $2, $3, NOW() + INTERVAL '30 minutes')`,
          [requestId, f.tenantId, f.platformTwoLinkId],
        ),
        { state: FK_VIOLATION, constraint: 'sas_actor_is_the_approved_requester' },
        'a session naming a platform person the approval never delegated to',
      );
      // THE CONTROL LEG: the approved requester's own session is accepted.
      await fixtureAuthorizationStateWrite(
        'seed-authorization-state',
        `INSERT INTO support_access_sessions
           (request_id, tenant_id, actor_user_link_id, expires_at)
         VALUES ($1, $2, $3, NOW() + INTERVAL '30 minutes')`,
        [requestId, f.tenantId, f.platformLinkId],
      );
      const rows = await query(`SELECT 1 FROM support_access_sessions`);
      assert.equal(rows.rows.length, 1, 'the honest tuple is accepted');
    });

    test('a dealership link cannot be recorded as a platform-support actor', async () => {
      const { requestId } = await supportRequest({});
      const sessions = await query(
        `SELECT support_session_id FROM support_access_sessions WHERE request_id = $1`,
        [requestId],
      );
      // Create the legitimate session so every OTHER fact of the row can be real.
      const sessionId =
        sessions.rows.length > 0
          ? String((sessions.rows[0] as Record<string, unknown>).support_session_id)
          : String(
              (
                await fixtureAuthorizationStateWrite(
                  'seed-authorization-state',
                  `INSERT INTO support_access_sessions
                     (request_id, tenant_id, actor_user_link_id, expires_at)
                   VALUES ($1, $2, $3, NOW() + INTERVAL '30 minutes')
                   RETURNING support_session_id`,
                  [requestId, f.tenantId, f.platformLinkId],
                )
              ).rows[0]?.support_session_id,
            );
      // The DEALERSHIP actor of this very tenant, wearing the platform-support
      // label — the R6-era forgery every earlier support adversary was built on.
      // The label is now bound to the actor's REAL scope.
      await assertRefusedBy(
        insertAllow({
          actor_type: 'platform_support',
          reason_code: 'ALLOW_SUPPORT_SESSION',
          matched_role_binding_ids: null,
          support_session_id: sessionId,
          support_request_id: requestId,
        }),
        { state: RAISED, message: 'cannot be recorded as a platform-support actor' },
        'a dealership link wearing the platform-support label',
      );
      assert.equal(await countEvidence(), 0);
      // THE CONTROL LEG: the real platform person, same session, is accepted.
      await insertAllow({
        actor_type: 'platform_support',
        reason_code: 'ALLOW_SUPPORT_SESSION',
        matched_role_binding_ids: null,
        actor_user_link_id: f.platformLinkId,
        session_id: f.platformSessionId,
        connection_id: f.platformConnectionId,
        actor_provider_subject: f.platformSubject,
        support_session_id: sessionId,
        support_request_id: requestId,
      });
      assert.equal(await countEvidence(), 1);
    });

    // ══ §3.2 — a session may not exceed or precede its approval ════════════

    test('a one-minute approval cannot produce a longer session', async () => {
      const { requestId } = await supportRequest({ durationMinutes: 1 });
      await assertRefusedBy(
        fixtureAuthorizationStateWrite(
          'adversarial-bypass-attempt',
          `INSERT INTO support_access_sessions
             (request_id, tenant_id, actor_user_link_id, expires_at)
           VALUES ($1, $2, $3, NOW() + INTERVAL '2 minutes')`,
          [requestId, f.tenantId, f.platformLinkId],
        ),
        { state: RAISED, message: 'cannot produce a longer session' },
        'a two-minute session under a one-minute approval',
      );
      // THE CONTROL LEG: exactly the requested minute is accepted.
      await fixtureAuthorizationStateWrite(
        'seed-authorization-state',
        `INSERT INTO support_access_sessions
           (request_id, tenant_id, actor_user_link_id, expires_at)
         VALUES ($1, $2, $3, NOW() + INTERVAL '1 minute')`,
        [requestId, f.tenantId, f.platformLinkId],
      );
    });

    test('a session cannot begin before its approval was decided', async () => {
      const { requestId } = await supportRequest({});
      await assertRefusedBy(
        fixtureAuthorizationStateWrite(
          'adversarial-bypass-attempt',
          `INSERT INTO support_access_sessions
             (request_id, tenant_id, actor_user_link_id, granted_at, expires_at)
           VALUES ($1, $2, $3, NOW() - INTERVAL '5 minutes', NOW() + INTERVAL '10 minutes')`,
          [requestId, f.tenantId, f.platformLinkId],
        ),
        { state: RAISED, message: 'cannot begin before its approval' },
        'a session granted before the decision that authorizes it',
      );
    });

    test('a wrong-action or wrong-resource REAL grant cannot approve a support request', async () => {
      // Both grants are REAL, high-assurance, MFA-certified and unexpired. One was
      // minted for a different ACTION; the other for a different REQUEST. Before R7
      // only the consuming code judged either fact.
      const wrongAction = await supportRequest({ approve: false });
      const decider = await bootstrapAdministrator(f.tenantId);
      await mintReauthGrant({
        tenantId: f.tenantId,
        userLinkId: decider,
        action: 'service.ro.void',
        resourceType: 'support_access_request',
        resourceId: wrongAction.requestId,
      });
      await assertRefusedBy(
        fixtureAuthorizationStateWrite(
          'adversarial-bypass-attempt',
          `UPDATE support_access_requests
              SET status = 'approved', decided_at = NOW(), decided_by_user_link_id = $2,
                  approval_grant_id = (
                    SELECT g.grant_id FROM reauthentication_grants g
                     WHERE g.user_link_id = $2 ORDER BY g.created_at DESC LIMIT 1)
            WHERE request_id = $1`,
          [wrongAction.requestId, decider],
        ),
        { state: RAISED, message: 'only an identity.support.approve grant approves' },
        'an approval citing a grant minted for a different action',
      );

      const wrongResource = await supportRequest({ approve: false });
      const otherRequest = await supportRequest({ approve: false });
      const decider2 = await bootstrapAdministrator(f.tenantId);
      await mintReauthGrant({
        tenantId: f.tenantId,
        userLinkId: decider2,
        action: 'identity.support.approve',
        resourceType: 'support_access_request',
        resourceId: otherRequest.requestId,
      });
      await assertRefusedBy(
        fixtureAuthorizationStateWrite(
          'adversarial-bypass-attempt',
          `UPDATE support_access_requests
              SET status = 'approved', decided_at = NOW(), decided_by_user_link_id = $2,
                  approval_grant_id = (
                    SELECT g.grant_id FROM reauthentication_grants g
                     WHERE g.user_link_id = $2 ORDER BY g.created_at DESC LIMIT 1)
            WHERE request_id = $1`,
          [wrongResource.requestId, decider2],
        ),
        { state: RAISED, message: 'a grant approves exactly the request it names' },
        'an approval citing a grant minted for a different request',
      );
    });

    test('an approved scope must be a real, effective node of the request tenant', async () => {
      // nonexistent
      await assertRefusedBy(
        supportRequest({ scopeLevel: 'rooftop', scopeId: randomUUID() }),
        { state: RAISED, message: 'cannot delegate a scope that does not effectively exist' },
        'an approval of a rooftop nobody built',
      );
      // foreign-tenant: a REAL rooftop of the other tenant
      await assertRefusedBy(
        supportRequest({ scopeLevel: 'rooftop', scopeId: f.foreignRooftop }),
        { state: RAISED, message: 'cannot delegate a scope that does not effectively exist' },
        'an approval of another tenant’s real rooftop',
      );
      // inactive scope
      await fixtureAuthorizationStateWrite(
        'simulate-authorization-drift',
        `UPDATE rooftops SET status = 'archived' WHERE rooftop_id = $1`,
        [f.rooftopB],
      );
      await assertRefusedBy(
        supportRequest({ scopeLevel: 'rooftop', scopeId: f.rooftopB }),
        { state: RAISED, message: 'cannot delegate a scope that does not effectively exist' },
        'an approval of an archived rooftop',
      );
      // out-of-window ancestor: the legal entity above rooftop A ages out
      await fixtureAuthorizationStateWrite(
        'simulate-authorization-drift',
        `UPDATE legal_entities
            SET effective_from = NOW() - INTERVAL '2 days',
                effective_to = NOW() - INTERVAL '1 minute'
          WHERE legal_entity_id = $1`,
        [f.legalEntityA],
      );
      await assertRefusedBy(
        supportRequest({ scopeLevel: 'rooftop', scopeId: f.rooftopA }),
        { state: RAISED, message: 'cannot delegate a scope that does not effectively exist' },
        'an approval whose scope stands under an aged-out ancestor',
      );
      // THE CONTROL LEG: restore the chain; the same scope approves.
      await fixtureAuthorizationStateWrite(
        'simulate-authorization-drift',
        `UPDATE legal_entities SET effective_to = NULL WHERE legal_entity_id = $1`,
        [f.legalEntityA],
      );
      const ok = await supportRequest({ scopeLevel: 'rooftop', scopeId: f.rooftopA });
      const status = await query(
        `SELECT status FROM support_access_requests WHERE request_id = $1`,
        [ok.requestId],
      );
      assert.equal(String((status.rows[0] as Record<string, unknown>).status), 'approved');
    });

    test('request and session authority fields are immutable once written', async () => {
      const { requestId } = await supportRequest({});
      const sessionId = String(
        (
          await fixtureAuthorizationStateWrite(
            'seed-authorization-state',
            `INSERT INTO support_access_sessions
               (request_id, tenant_id, actor_user_link_id, expires_at)
             VALUES ($1, $2, $3, NOW() + INTERVAL '30 minutes')
             RETURNING support_session_id`,
            [requestId, f.tenantId, f.platformLinkId],
          )
        ).rows[0]?.support_session_id,
      );
      await assertRefusedBy(
        fixtureAuthorizationStateWrite(
          'adversarial-bypass-attempt',
          `UPDATE support_access_requests SET requested_duration_minutes = 60
            WHERE request_id = $1`,
          [requestId],
        ),
        { state: RAISED, message: 'are the AUTHORITY of request' },
        'widening an approved request’s duration after the fact',
      );
      await assertRefusedBy(
        fixtureAuthorizationStateWrite(
          'adversarial-bypass-attempt',
          `UPDATE support_access_sessions SET expires_at = NOW() + INTERVAL '2 hours'
            WHERE support_session_id = $1`,
          [sessionId],
        ),
        { state: RAISED, message: 'are the AUTHORITY of session' },
        'extending a live session’s window after the fact',
      );
      // The approval identity — decider, instant, grant — is SET ONCE by the
      // decision and never moved afterwards.
      await assertRefusedBy(
        fixtureAuthorizationStateWrite(
          'adversarial-bypass-attempt',
          `UPDATE support_access_requests SET decided_at = NOW() - INTERVAL '1 hour'
            WHERE request_id = $1`,
          [requestId],
        ),
        { state: RAISED, message: 'is written once by the decision' },
        're-dating an approval after the fact',
      );
    });

    // ══ §3.3 — no action name decides delegation ═══════════════════════════

    test('a platform-prefixed action cannot carry customer resource evidence without delegation', async () => {
      // The R6-era shape, verbatim: a platform person, their REAL platform binding
      // as authority, an action whose NAME starts with `platform.` — and a customer
      // tenant plus a customer resource in the evidence, with no delegated-support
      // session anywhere. The v2 rule exempted this row BECAUSE OF ITS NAME.
      await assertRefusedBy(
        insertAllow({
          actor_type: 'platform_support',
          reason_code: 'ALLOW_PLATFORM_ROLE',
          action: 'platform.tenant.inspect',
          actor_user_link_id: f.platformLinkId,
          session_id: f.platformSessionId,
          connection_id: f.platformConnectionId,
          actor_provider_subject: f.platformSubject,
          resource_type: 'repair_order',
          resource_id: f.roAtRooftopA,
          matched_role_binding_ids: [f.platformBindingId],
          matched_authorization_versions: [f.platformBindingVersion],
        }),
        { state: CHECK_VIOLATION, constraint: 'pd_v4_support_tenant_allow_is_delegated' },
        'a platform-named allow reaching into a tenant with no delegation',
      );
      assert.equal(await countEvidence(), 0);

      // THE CONTROL LEG — a GENUINE control-plane decision: structurally platform-
      // scoped, NO authorization tenant, NO customer-resource payload, real platform
      // authority; the tenant it operated ON travels as metadata in its own column.
      await insertAllow({
        actor_type: 'platform_support',
        reason_code: 'ALLOW_PLATFORM_ROLE',
        action: 'platform.tenant.inspect',
        tenant_id: null,
        scope_level: 'platform',
        scope_id: null,
        control_plane_target_tenant_id: f.tenantId,
        actor_user_link_id: f.platformLinkId,
        session_id: f.platformSessionId,
        connection_id: f.platformConnectionId,
        actor_provider_subject: f.platformSubject,
        matched_role_binding_ids: [f.platformBindingId],
        matched_authorization_versions: [f.platformBindingVersion],
      });
      const stored = await query(
        `SELECT tenant_id, control_plane_target_tenant_id FROM policy_decisions`,
      );
      const row = stored.rows[0] as Record<string, unknown>;
      assert.equal(row.tenant_id, null, 'the authorization tenant is structurally NULL');
      assert.equal(
        String(row.control_plane_target_tenant_id),
        f.tenantId,
        'and the operational target lives in its own metadata column',
      );
    });

    // ══ §3.4 — resource decisions tied to their organization ancestry ═══════

    test('a rooftop-A binding cannot authorize a real rooftop-B resource', async () => {
      await assertRefusedBy(
        insertAllow({
          resource_type: 'repair_order',
          resource_id: f.roAtRooftopB,
          scope_level: 'rooftop',
          scope_id: f.rooftopA,
          matched_role_binding_ids: [f.rooftopABindingId],
          matched_authorization_versions: [f.rooftopABindingVersion],
        }),
        { state: RAISED, message: 'never authorizes a sibling' },
        'a rooftop-A binding recorded as authority over a rooftop-B repair order',
      );
      assert.equal(await countEvidence(), 0);
      // THE CONTROL LEG: the SAME binding over ITS OWN rooftop's resource.
      await insertAllow({
        resource_type: 'repair_order',
        resource_id: f.roAtRooftopA,
        scope_level: 'rooftop',
        scope_id: f.rooftopA,
        matched_role_binding_ids: [f.rooftopABindingId],
        matched_authorization_versions: [f.rooftopABindingVersion],
      });
      const snap = await query(`SELECT resource_rooftop_id FROM policy_decisions`);
      assert.equal(
        String((snap.rows[0] as Record<string, unknown>).resource_rooftop_id),
        f.rooftopA,
        'and the decision carries the DATABASE-validated leaf snapshot',
      );
    });

    test('an ancestor binding can authorize a real descendant resource', async () => {
      await insertAllow({
        resource_type: 'repair_order',
        resource_id: f.roAtRooftopA,
        scope_level: 'legal_entity',
        scope_id: f.legalEntityA,
        matched_role_binding_ids: [f.entityBindingId],
        matched_authorization_versions: [f.entityBindingVersion],
      });
      assert.equal(await countEvidence(), 1, 'the legal-entity binding reaches its own rooftop');
    });

    test('nonexistent and foreign-tenant resources are rejected, and a supplied snapshot is validated', async () => {
      await assertRefusedBy(
        insertAllow({ resource_type: 'repair_order', resource_id: randomUUID() }),
        { state: RAISED, message: 'does not resolve to an organization node' },
        'a repair order nobody created',
      );
      await assertRefusedBy(
        insertAllow({ resource_type: 'repair_order', resource_id: f.foreignRo }),
        { state: RAISED, message: 'does not resolve to an organization node' },
        'another tenant’s real repair order',
      );
      // The caller-supplied snapshot is VALIDATED, never trusted: a real resource
      // with somebody else's rooftop written into the snapshot column.
      await assertRefusedBy(
        insertAllow({
          resource_type: 'repair_order',
          resource_id: f.roAtRooftopA,
          resource_rooftop_id: f.rooftopB,
        }),
        { state: RAISED, message: 'is validated, never trusted' },
        'a caller-supplied resource snapshot that disagrees with the database',
      );
      assert.equal(await countEvidence(), 0);
    });

    // ══ §3.5 — the whole chain, tenant included, at evidence-write time ═════

    test('an ALLOW cannot stand on an inactive or out-of-window chain — six ways', async () => {
      const rooftopAllow = {
        scope_level: 'rooftop',
        scope_id: f.rooftopA,
        matched_role_binding_ids: [f.rooftopABindingId],
        matched_authorization_versions: [f.rooftopABindingVersion],
      };
      // Each perturbation is a CLOSURE whose SQL literal sits DIRECTLY inside a
      // `fixtureAuthorizationStateWrite(...)` call, which is where the
      // owned-mutation guard requires a fixture's authorization-state write to be
      // declared — SQL held as loose data, or routed through a local wrapper,
      // would be lexically invisible to it.
      const cases: ReadonlyArray<[string, string, () => Promise<unknown>]> = [
        [
          'inactive tenant',
          'tenant',
          () =>
            fixtureAuthorizationStateWrite(
              'simulate-authorization-drift',
              `UPDATE tenants SET status = 'suspended' WHERE tenant_id = $1`,
              [f.tenantId],
            ),
        ],
        [
          'expired tenant window',
          'tenant',
          () =>
            fixtureAuthorizationStateWrite(
              'simulate-authorization-drift',
              `UPDATE tenants
                  SET effective_from = NOW() - INTERVAL '2 days',
                      effective_to = NOW() - INTERVAL '1 minute'
                WHERE tenant_id = $1`,
              [f.tenantId],
            ),
        ],
        [
          'inactive leaf',
          'rooftop',
          () =>
            fixtureAuthorizationStateWrite(
              'simulate-authorization-drift',
              `UPDATE rooftops SET status = 'archived' WHERE rooftop_id = $1`,
              [f.rooftopA],
            ),
        ],
        [
          'future-effective leaf',
          'rooftop',
          () =>
            fixtureAuthorizationStateWrite(
              'simulate-authorization-drift',
              `UPDATE rooftops SET effective_from = NOW() + INTERVAL '1 hour' WHERE rooftop_id = $1`,
              [f.rooftopA],
            ),
        ],
        [
          'inactive ancestor',
          'legal_entity',
          () =>
            fixtureAuthorizationStateWrite(
              'simulate-authorization-drift',
              `UPDATE legal_entities SET status = 'archived' WHERE legal_entity_id = $1`,
              [f.legalEntityA],
            ),
        ],
        [
          'expired ancestor window',
          'legal_entity',
          () =>
            fixtureAuthorizationStateWrite(
              'simulate-authorization-drift',
              `UPDATE legal_entities
                  SET effective_from = NOW() - INTERVAL '2 days',
                      effective_to = NOW() - INTERVAL '1 minute'
                WHERE legal_entity_id = $1`,
              [f.legalEntityA],
            ),
        ],
      ];
      const restoreChain = async (): Promise<void> => {
        await fixtureAuthorizationStateWrite(
          'simulate-authorization-drift',
          `UPDATE tenants SET status = 'active', effective_to = NULL WHERE tenant_id = $1`,
          [f.tenantId],
        );
        await fixtureAuthorizationStateWrite(
          'simulate-authorization-drift',
          `UPDATE rooftops
              SET status = 'active', effective_from = NOW() - INTERVAL '1 day'
            WHERE rooftop_id = $1`,
          [f.rooftopA],
        );
        await fixtureAuthorizationStateWrite(
          'simulate-authorization-drift',
          `UPDATE legal_entities SET status = 'active', effective_to = NULL WHERE legal_entity_id = $1`,
          [f.legalEntityA],
        );
      };
      for (const [label, offendingLevel, perturb] of cases) {
        await perturb();
        await assertRefusedBy(
          insertAllow(rooftopAllow),
          { state: RAISED, message: offendingLevel },
          `${label}: the chain judge must name the defective node`,
        );
        await restoreChain();
      }
      assert.equal(await countEvidence(), 0, 'none of the six wrote evidence');
      // THE CONTROL LEG: the restored, fully active chain is accepted.
      await insertAllow(rooftopAllow);
      assert.equal(await countEvidence(), 1);
    });

    // ══ §3.6 — liveness at the ACTUAL write instant ═════════════════════════

    test('a transaction started before a binding expired and completed after it is refused', async () => {
      // A holder object rather than three `let`s: assignments made inside the
      // transaction callback are invisible to control-flow narrowing, which
      // would otherwise type the captured values as `never` at the judgment
      // site below.
      const seen: {
        facts: { alive_by_txn_clock: boolean; expired_by_wall_clock: boolean } | null;
        refusal: { code?: string; message?: string } | null;
        completed: boolean;
      } = { facts: null, refusal: null, completed: false };
      await withTransaction(async (executor) => {
        // Inside this transaction NOW() is frozen. Close the binding's window a few
        // hundred milliseconds ahead of the LIVE clock, then let the wall cross it
        // while the transaction stays open — the exact custody-transaction shape.
        await fixtureAuthorizationStateWrite(
          'simulate-authorization-drift',
          `UPDATE role_bindings
              SET effective_to = clock_timestamp() + INTERVAL '350 milliseconds'
            WHERE role_binding_id = $1`,
          [f.roleBindingId],
          { executor },
        );
        await executor.query(`SELECT pg_sleep(0.7)`);
        const probe = await executor.query(
          `SELECT (effective_to > NOW()) AS alive_by_txn_clock,
                  (effective_to <= clock_timestamp()) AS expired_by_wall_clock
             FROM role_bindings WHERE role_binding_id = $1`,
          [f.roleBindingId],
        );
        // CAPTURED inside the transaction, JUDGED outside it: the trailing
        // catch absorbs the abort the refusal causes, and any assertion placed
        // in here would be absorbed with it — a dead assertion no mutation
        // could ever fail.
        seen.facts = probe.rows[0] as {
          alive_by_txn_clock: boolean;
          expired_by_wall_clock: boolean;
        };
        try {
          await insertAllow({}, executor);
          seen.completed = true;
        } catch (err) {
          seen.refusal = err as { code?: string; message?: string };
        }
        // Roll back either way, so a wrongly-accepted row can never commit.
        throw new Error('probe transaction always rolls back');
      }).catch(() => undefined);
      const facts = seen.facts;
      const refusal = seen.refusal;
      assert.ok(facts, 'the premise probe ran');
      assert.equal(facts.alive_by_txn_clock, true, 'premise: NOW() has not reached the window');
      assert.equal(facts.expired_by_wall_clock, true, 'premise: clock_timestamp() has crossed it');
      assert.equal(seen.completed, false, 'the straddling write must not complete');
      assert.ok(refusal, 'it must be refused');
      assert.equal(String(refusal.code), 'P0001', 'by the write-instant rule itself');
      assert.ok(
        String(refusal.message).includes('at the actual write instant'),
        `the refusal names the write instant, got: ${String(refusal.message)}`,
      );
      assert.equal(await countEvidence(), 0);
    });

    test('an expired support session combined with a backdated occurred_at is refused', async () => {
      const { requestId } = await supportRequest({});
      const sessionId = String(
        (
          await fixtureAuthorizationStateWrite(
            'seed-authorization-state',
            `INSERT INTO support_access_sessions
               (request_id, tenant_id, actor_user_link_id, expires_at)
             VALUES ($1, $2, $3, NOW() + INTERVAL '30 minutes')
             RETURNING support_session_id`,
            [requestId, f.tenantId, f.platformLinkId],
          )
        ).rows[0]?.support_session_id,
      );
      await shiftSupportWindowIntoThePast(sessionId);
      // `occurred_at` is backdated INSIDE the shifted window, so every recorded
      // instant is self-consistent — and the row is still refused, because
      // liveness is judged at the actual write instant, which no recorded
      // timestamp can stand in for.
      await assertRefusedBy(
        insertAllow({
          actor_type: 'platform_support',
          reason_code: 'ALLOW_SUPPORT_SESSION',
          matched_role_binding_ids: null,
          actor_user_link_id: f.platformLinkId,
          session_id: f.platformSessionId,
          connection_id: f.platformConnectionId,
          actor_provider_subject: f.platformSubject,
          support_session_id: sessionId,
          support_request_id: requestId,
          occurred_at: new Date(Date.now() - 45 * 60 * 1000),
        }),
        { state: RAISED, message: 'support session' },
        'a support allow backdated into a window that has since closed',
      );
      assert.equal(await countEvidence(), 0);
    });

    // ══ §3.1/§3.2 — the clauses the tests above leave unnamed ══════════════

    test('a dealership link can neither file nor hold a support delegation', async () => {
      // FILING: the requester-scope trigger answers before anything referential.
      await assertRefusedBy(
        fixtureAuthorizationStateWrite(
          'adversarial-bypass-attempt',
          `INSERT INTO support_access_requests
             (tenant_id, requester_user_link_id, requested_actions, reason,
              requested_duration_minutes, scope_level, scope_id)
           VALUES ($1, $2, ARRAY['service.ro.view'], 'r7 integrity fixture', 30, 'tenant', NULL)`,
          [f.tenantId, f.linkId],
        ),
        { state: RAISED, message: 'a dealership link cannot request it' },
        'a support request filed by a dealership link',
      );
      // HOLDING: under a REAL approved delegation, the dealership actor dies at
      // the scope rule ITSELF — pinned as a raise with its own words, so this
      // test still names the defect even where the composite tuple FK (which
      // would refuse the same row for a different reason) is out of the picture.
      const { requestId } = await supportRequest({});
      await assertRefusedBy(
        fixtureAuthorizationStateWrite(
          'adversarial-bypass-attempt',
          `INSERT INTO support_access_sessions
             (request_id, tenant_id, actor_user_link_id, expires_at)
           VALUES ($1, $2, $3, NOW() + INTERVAL '30 minutes')`,
          [requestId, f.tenantId, f.linkId],
        ),
        { state: RAISED, message: 'a dealership link cannot hold one' },
        'a support session held by a dealership link',
      );
      // THE CONTROL LEG: the platform requester holds the same shape.
      await fixtureAuthorizationStateWrite(
        'seed-authorization-state',
        `INSERT INTO support_access_sessions
           (request_id, tenant_id, actor_user_link_id, expires_at)
         VALUES ($1, $2, $3, NOW() + INTERVAL '30 minutes')`,
        [requestId, f.tenantId, f.platformLinkId],
      );
    });

    test('a session cannot exist under a request nobody approved', async () => {
      const { requestId } = await supportRequest({ approve: false });
      await assertRefusedBy(
        fixtureAuthorizationStateWrite(
          'adversarial-bypass-attempt',
          `INSERT INTO support_access_sessions
             (request_id, tenant_id, actor_user_link_id, expires_at)
           VALUES ($1, $2, $3, NOW() + INTERVAL '30 minutes')`,
          [requestId, f.tenantId, f.platformLinkId],
        ),
        { state: RAISED, message: 'a session exists only under an approved, decided request' },
        'a session under a pending request',
      );
      // THE CONTROL LEG: the same tuple under a decided approval is accepted.
      const approved = await supportRequest({});
      await fixtureAuthorizationStateWrite(
        'seed-authorization-state',
        `INSERT INTO support_access_sessions
           (request_id, tenant_id, actor_user_link_id, expires_at)
         VALUES ($1, $2, $3, NOW() + INTERVAL '30 minutes')`,
        [approved.requestId, f.tenantId, f.platformLinkId],
      );
    });

    test('an approval cannot cite a grant at the wrong assurance or without MFA certification', async () => {
      const { requestId, deciderId } = await supportRequest({ approve: false });
      await mintReauthGrant({
        tenantId: f.tenantId,
        userLinkId: deciderId,
        action: 'identity.support.approve',
        resourceType: 'support_access_request',
        resourceId: requestId,
      });
      const approve = () =>
        fixtureAuthorizationStateWrite(
          'seed-authorization-state',
          `UPDATE support_access_requests
              SET status = 'approved', decided_at = NOW(), decided_by_user_link_id = $2,
                  approval_grant_id = (
                    SELECT g.grant_id FROM reauthentication_grants g
                     WHERE g.user_link_id = $2 ORDER BY g.created_at DESC LIMIT 1)
            WHERE request_id = $1`,
          [requestId, deciderId],
        );
      // The REAL grant, demoted to the lower assurance the grants table still
      // legally carries — just never for approving support access.
      await fixtureAuthorizationStateWrite(
        'simulate-authorization-drift',
        `UPDATE reauthentication_grants SET assurance_level = 'fresh_only'
          WHERE user_link_id = $1`,
        [deciderId],
      );
      await assertRefusedBy(
        approve(),
        { state: RAISED, message: 'requires fresh_and_mfa_policy' },
        'an approval citing a fresh_only grant',
      );
      // The right assurance, stripped of its MFA-policy certification.
      await fixtureAuthorizationStateWrite(
        'simulate-authorization-drift',
        `UPDATE reauthentication_grants
            SET assurance_level = 'fresh_and_mfa_policy', mfa_policy_certified_at_issue = FALSE
          WHERE user_link_id = $1`,
        [deciderId],
      );
      await assertRefusedBy(
        approve(),
        { state: RAISED, message: 'without MFA policy certification' },
        'an approval citing an uncertified grant',
      );
      // THE CONTROL LEG: restored to what the production path mints, it approves.
      await fixtureAuthorizationStateWrite(
        'simulate-authorization-drift',
        `UPDATE reauthentication_grants SET mfa_policy_certified_at_issue = TRUE
          WHERE user_link_id = $1`,
        [deciderId],
      );
      await approve();
      const status = await query(
        `SELECT status FROM support_access_requests WHERE request_id = $1`,
        [requestId],
      );
      assert.equal(String((status.rows[0] as Record<string, unknown>).status), 'approved');
    });

    // ══ §3.3/§3.4 — the version-4 CHECKs and the snapshot key, one by one ═══

    test('a resource ALLOW cannot stand on a dead chain above its own resource', async () => {
      await fixtureAuthorizationStateWrite(
        'simulate-authorization-drift',
        `UPDATE rooftops SET status = 'archived' WHERE rooftop_id = $1`,
        [f.rooftopA],
      );
      await assertRefusedBy(
        insertAllow({ resource_type: 'repair_order', resource_id: f.roAtRooftopA }),
        { state: RAISED, message: 'chain above resource' },
        'a resource allow whose own rooftop has been archived',
      );
      assert.equal(await countEvidence(), 0);
      // THE CONTROL LEG: restore the chain; the same evidence is accepted.
      await fixtureAuthorizationStateWrite(
        'simulate-authorization-drift',
        `UPDATE rooftops SET status = 'active' WHERE rooftop_id = $1`,
        [f.rooftopA],
      );
      await insertAllow({ resource_type: 'repair_order', resource_id: f.roAtRooftopA });
      assert.equal(await countEvidence(), 1);
    });

    test('a resource-rooftop snapshot cannot name another tenant’s rooftop', async () => {
      await assertRefusedBy(
        insertAllow({ resource_rooftop_id: f.foreignRooftop }),
        { state: FK_VIOLATION, constraint: 'pd_resource_rooftop_in_tenant' },
        'a snapshot naming a rooftop outside the decision’s tenant',
      );
      assert.equal(await countEvidence(), 0);
      // THE CONTROL LEG: the tenant’s own rooftop satisfies the key.
      await insertAllow({ resource_rooftop_id: f.rooftopA });
      assert.equal(await countEvidence(), 1);
    });

    test('a control-plane decision cannot smuggle a customer-resource payload', async () => {
      // The genuine control-plane shape (proved by the delegation test’s control
      // leg) with ONE change: a customer resource in the evidence columns.
      await assertRefusedBy(
        insertAllow({
          actor_type: 'platform_support',
          reason_code: 'ALLOW_PLATFORM_ROLE',
          action: 'platform.tenant.inspect',
          tenant_id: null,
          scope_level: 'platform',
          scope_id: null,
          actor_user_link_id: f.platformLinkId,
          session_id: f.platformSessionId,
          connection_id: f.platformConnectionId,
          actor_provider_subject: f.platformSubject,
          resource_type: 'repair_order',
          resource_id: f.roAtRooftopA,
          resource_rooftop_id: f.rooftopA,
          matched_role_binding_ids: [f.platformBindingId],
          matched_authorization_versions: [f.platformBindingVersion],
        }),
        { state: CHECK_VIOLATION, constraint: 'pd_v4_control_plane_is_structural' },
        'a structurally platform-scoped row carrying a customer resource',
      );
      assert.equal(await countEvidence(), 0);
    });

    test('the control-plane target tenant cannot ride on a tenant-scoped decision', async () => {
      await assertRefusedBy(
        insertAllow({ control_plane_target_tenant_id: f.otherTenantId }),
        { state: CHECK_VIOLATION, constraint: 'pd_v4_target_tenant_is_metadata' },
        'target-tenant metadata on an ordinary tenant decision',
      );
      assert.equal(await countEvidence(), 0);
    });

    test('a platform-NAMED action cannot free an identified actor from naming a tenant', async () => {
      // The v2 completeness rule exempted this row BY NAME (`platform.*`); the
      // v4 rule is structural and the name buys nothing.
      await assertRefusedBy(
        insertAllow({ action: 'platform.tenant.inspect', tenant_id: null, scope_id: null }),
        { state: CHECK_VIOLATION, constraint: 'pd_v4_identified_actor_names_a_tenant' },
        'an identified dealership actor with no tenant under a platform-named action',
      );
      assert.equal(await countEvidence(), 0);
    });

    test('a version-4 resource ALLOW cannot omit its validated rooftop snapshot', async () => {
      // The system lane is the one lane where the parent trigger has no tenant
      // to resolve the leaf in; the CHECK is what still refuses the row.
      await assertRefusedBy(
        insertAllow({
          actor_type: 'system',
          actor_user_link_id: null,
          session_id: null,
          connection_id: null,
          actor_provider_subject: null,
          tenant_id: null,
          scope_level: null,
          scope_id: null,
          action: 'system.retention.sweep',
          reason_code: 'ALLOW_SYSTEM_POLICY',
          matched_role_binding_ids: null,
          resource_type: 'repair_order',
          resource_id: f.roAtRooftopA,
        }),
        { state: CHECK_VIOLATION, constraint: 'pd_v4_resource_allow_names_its_rooftop' },
        'a system resource allow with no database-validated leaf',
      );
      assert.equal(await countEvidence(), 0);
    });

    test('occurred_at is checked for consistency and can never BE the authority clock', async () => {
      await assertRefusedBy(
        insertAllow({ occurred_at: new Date(Date.now() + 60_000) }),
        { state: RAISED, message: 'cannot predate itself' },
        'evidence dated in the future of its own write',
      );
      await assertRefusedBy(
        insertAllow({ occurred_at: new Date(Date.now() - 2 * 60 * 60 * 1000) }),
        { state: RAISED, message: 'cannot stand in for authority' },
        'evidence backdated by hours',
      );
      assert.equal(await countEvidence(), 0);
    });
  },
);
