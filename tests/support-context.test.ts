import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  bootstrapAdministrator,
  certifyMfaPolicy,
  ensureActiveConnection,
  fixtureAuthorizationStateWrite,
  mintReauthGrant,
  resetDatabase,
  seedRooftopIdentity,
  seedTenantIdentity,
  sessionBindingFor,
  skipIntegration,
  startIdentityTestEnv,
  testOrganizationId,
  type IdentityTestEnv,
} from '@dealer/test-kit';
import { closePool, query } from '@dealer/database';
import {
  activateUserLink,
  decideSupportAccess,
  grantRole,
  observeUserLinkOnLogin,
  requestSupportAccess,
  supportAccessHeaderValue,
} from '@dealer/identity-access';
import {
  SupportContextConflictError,
  bindSupportContext,
  generateRequestId,
  getRequestContext,
  logger,
  runWithRequestContext,
} from '@dealer/platform';
import { createApp, resetAuthRoutesForTests, resetIdentityCompositionForTests } from '@dealer/api';

/**
 * FBL-020-R4 §4 — NON-SUPPRESSIBLE SUPPORT CONTEXT, END TO END.
 *
 * A platform person acting inside a customer's data is the most sensitive thing this
 * platform permits, and R3 propagated a fraction of the fact: the response header named
 * the session id and nothing else (no expiry — the one fact that decides whether a tenant
 * waits or revokes), the request context and every log line named none of it, the
 * transactional audit row could not say what the access was approved to DO, and a
 * platform actor's own live grants were reported nowhere at all.
 *
 * Seven carriers are asserted here, on ONE live grant: the response header on an ordinary
 * API response, the response header on /auth/session, the request context, the structured
 * logs, the policy evidence row, the transactional audit row, and the session views on
 * both sides (the tenant's and the platform actor's own).
 *
 * And the boundary is asserted too, because "carry more" must not become "carry
 * anything": no email, no display name, no provider subject or session id, no token, and
 * never the free-text support reason.
 */
describe(
  'support context propagation (FBL-020-R4 §4)',
  { skip: skipIntegration ? 'set TEST_DATABASE_URL to run' : false },
  () => {
    let server: Server;
    let base: string;
    let env: IdentityTestEnv;

    before(async () => {
      env = await startIdentityTestEnv();
      resetIdentityCompositionForTests();
      resetAuthRoutesForTests();
      server = createApp().listen(0);
      await new Promise<void>((resolve) => server.once('listening', () => resolve()));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    after(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await env.stop();
      await closePool();
    });

    let tenantId: string;
    let rooftopId: string;
    let roId: string;

    beforeEach(async () => {
      await resetDatabase();
      tenantId = randomUUID();
      rooftopId = randomUUID();
      roId = randomUUID();
      await seedTenantIdentity(tenantId);
      await seedRooftopIdentity(tenantId, rooftopId);
      await certifyMfaPolicy(tenantId);
      await query(
        `INSERT INTO repair_orders (ro_id, tenant_id, location_id, mdm_customer_id, mdm_vehicle_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [roId, tenantId, rooftopId, randomUUID(), randomUUID()],
      );
    });

    async function call(
      token: string | null,
      method: string,
      path: string,
      extraHeaders: Record<string, string> = {},
    ) {
      const res = await fetch(base + path, {
        method,
        headers: {
          'content-type': 'application/json',
          ...(token === null ? {} : { authorization: `Bearer ${token}` }),
          ...extraHeaders,
        },
      });
      const text = await res.text();
      return {
        status: res.status,
        body: text ? (JSON.parse(text) as { data: Record<string, unknown> }) : null,
        headers: res.headers,
      };
    }

    async function tenantAdministrator(): Promise<{ userLinkId: string; token: string }> {
      const binding = await sessionBindingFor(tenantId);
      const observed = await observeUserLinkOnLogin({
        tenantId,
        providerUserId: 'user_tenant_admin',
        email: 'admin@tenant.example',
        displayName: 'Tina Admin',
        connectionId: binding.connectionId,
        issuer: binding.issuer,
        providerOrganizationId: binding.providerOrganizationId,
      });
      assert.ok(observed);
      const activated = await activateUserLink({
        userLinkId: observed.userLinkId,
        activatedByUserLinkId: await bootstrapAdministrator(tenantId),
      });
      assert.ok(activated);
      await grantRole({
        actingUserLinkId: await bootstrapAdministrator(tenantId),
        tenantId,
        userLinkId: activated.userLinkId,
        role: 'tenant_admin',
        scopeLevel: 'tenant',
        scopeId: tenantId,
      });
      return {
        userLinkId: activated.userLinkId,
        token: await env.issuer.signAccessToken({
          sub: 'user_tenant_admin',
          org_id: testOrganizationId(tenantId),
        }),
      };
    }

    async function platformSupportPerson(): Promise<{ userLinkId: string; token: string }> {
      await ensureActiveConnection(null);
      const binding = await sessionBindingFor(null);
      const observed = await observeUserLinkOnLogin({
        tenantId: null,
        providerUserId: 'user_support',
        email: 'sam@platform.example',
        displayName: 'Sam Support',
        connectionId: binding.connectionId,
        issuer: binding.issuer,
        providerOrganizationId: binding.providerOrganizationId,
      });
      assert.ok(observed);
      const activated = await activateUserLink({
        userLinkId: observed.userLinkId,
        activatedByUserLinkId: await bootstrapAdministrator(null),
      });
      assert.ok(activated);
      await grantRole({
        actingUserLinkId: await bootstrapAdministrator(null),
        tenantId: null,
        userLinkId: activated.userLinkId,
        role: 'platform_support',
        scopeLevel: 'platform',
        scopeId: null,
      });
      return {
        userLinkId: activated.userLinkId,
        token: await env.issuer.signAccessToken({
          sub: 'user_support',
          org_id: binding.providerOrganizationId,
        }),
      };
    }

    /** The free-text reason — it must appear in exactly one place: its own row. */
    const REASON = 'ticket 9317 the customer disputes the authorized total on this order';

    async function approvedSupport(): Promise<{
      supportSessionId: string;
      requestId: string;
      expiresAt: Date;
      support: { userLinkId: string; token: string };
      admin: { userLinkId: string; token: string };
    }> {
      const admin = await tenantAdministrator();
      const support = await platformSupportPerson();
      const request = await requestSupportAccess({
        tenantId,
        requesterUserLinkId: support.userLinkId,
        requestedActions: ['service.ro.view'],
        scopeLevel: 'rooftop',
        scopeId: rooftopId,
        reason: REASON,
        requestedDurationMinutes: 25,
      });
      const approvalGrant = await mintReauthGrant({
        tenantId,
        userLinkId: admin.userLinkId,
        action: 'identity.support.approve',
        resourceType: 'support_access_request',
        resourceId: request.requestId,
      });
      const session = await decideSupportAccess({
        requestId: request.requestId,
        decidedByUserLinkId: admin.userLinkId,
        approve: true,
        approvalGrant,
      });
      assert.ok(session, 'the support session must have started');
      return {
        supportSessionId: session.supportSessionId,
        requestId: session.requestId,
        expiresAt: session.expiresAt,
        support,
        admin,
      };
    }

    test('EVERY supported response header carries the session AND the expiry', async () => {
      const live = await approvedSupport();

      // 1. an ordinary API response served under support access
      const served = await call(live.support.token, 'GET', `/api/service/ros/${roId}`, {
        'x-target-tenant': tenantId,
      });
      assert.equal(served.status, 200);
      const header = served.headers.get('x-support-access') ?? '';
      assert.match(header, new RegExp(`support_session=${live.supportSessionId}`));
      assert.match(header, new RegExp(`support_request=${live.requestId}`));
      assert.match(
        header,
        new RegExp(`expires_at=${live.expiresAt.toISOString()}`),
        'R3 omitted the expiry — the one fact that tells a tenant whether to wait or revoke',
      );
      assert.ok(!header.includes('ticket 9317'), 'the reason never travels in a header');

      // 2. /auth/session, for the TENANT — the same format, from the same formatter
      const tenantSession = await call(live.admin.token, 'GET', '/auth/session');
      const tenantHeader = tenantSession.headers.get('x-support-access') ?? '';
      assert.match(tenantHeader, new RegExp(`support_session=${live.supportSessionId}`));
      assert.match(tenantHeader, new RegExp(`expires_at=${live.expiresAt.toISOString()}`));

      // 3. /auth/session, for the PLATFORM actor — their own live grant is declared too
      const platformSession = await call(live.support.token, 'GET', '/auth/session');
      const platformHeader = platformSession.headers.get('x-support-access') ?? '';
      assert.match(platformHeader, new RegExp(`support_session=${live.supportSessionId}`));
      assert.match(platformHeader, new RegExp(`expires_at=${live.expiresAt.toISOString()}`));
    });

    test('the request context and every log line carry the whole fact set', async () => {
      const live = await approvedSupport();
      const lines: string[] = [];
      const original = process.stdout.write.bind(process.stdout);
      (process.stdout as unknown as { write: unknown }).write = ((chunk: unknown) => {
        lines.push(String(chunk));
        return true;
      }) as unknown as typeof process.stdout.write;
      try {
        const served = await call(live.support.token, 'GET', `/api/service/ros/${roId}`, {
          'x-target-tenant': tenantId,
        });
        assert.equal(served.status, 200);
      } finally {
        (process.stdout as unknown as { write: unknown }).write = original;
      }

      const supportLines = lines
        .join('')
        .split('\n')
        .filter((l) => l.includes('"support_session_id"'))
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      assert.ok(
        supportLines.length > 0,
        'at least one log line inside a support-served request must declare it',
      );
      for (const line of supportLines) {
        assert.equal(line.support_access, 'active');
        assert.equal(line.support_session_id, live.supportSessionId);
        assert.equal(line.support_request_id, live.requestId);
        assert.equal(line.support_actor_user_link_id, live.support.userLinkId);
        assert.equal(line.support_target_tenant_id, tenantId);
        assert.equal(line.support_approved_scope_level, 'rooftop');
        assert.equal(line.support_approved_scope_id, rooftopId);
        assert.deepEqual(line.support_approved_actions, ['service.ro.view']);
        assert.equal(line.support_session_expires_at, live.expiresAt.toISOString());
        const rendered = JSON.stringify(line);
        assert.ok(!rendered.includes('ticket 9317'), 'the reason never reaches a log line');
        assert.ok(!rendered.includes('sam@platform.example'), 'no PII in a log line');
      }
    });

    test('the bound context is NOT suppressible and refuses a second session', () => {
      const facts = {
        supportSessionId: randomUUID(),
        supportRequestId: randomUUID(),
        supportActorUserLinkId: randomUUID(),
        targetTenantId: randomUUID(),
        approvedScopeLevel: 'tenant',
        approvedScopeId: null,
        approvedActions: ['service.ro.view'],
        expiresAt: new Date(Date.now() + 60_000),
      };
      const requestId = generateRequestId();
      runWithRequestContext({ requestId, correlationId: requestId, startTime: Date.now() }, () => {
        bindSupportContext(facts);
        const ctx = getRequestContext()!;
        assert.equal(ctx.support?.supportSessionId, facts.supportSessionId);

        // Blanking it out must not work. The property is non-writable and
        // non-configurable, so an assignment throws in strict mode and a delete fails —
        // either way the facts survive, which is what "non-suppressible" has to mean.
        assert.throws(() => {
          (ctx as unknown as { support: unknown }).support = undefined;
        });
        assert.throws(() => {
          delete (ctx as unknown as { support?: unknown }).support;
        });
        assert.equal(ctx.support?.supportSessionId, facts.supportSessionId);

        // Re-binding the SAME session is harmless…
        bindSupportContext(facts);
        assert.equal(ctx.support?.supportSessionId, facts.supportSessionId);
        // …and a DIFFERENT one is a confusion of two requests, so it fails loudly.
        assert.throws(
          () => bindSupportContext({ ...facts, supportSessionId: randomUUID() }),
          SupportContextConflictError,
        );

        // The caller cannot mutate the bound facts after the fact either.
        assert.throws(() => {
          (ctx.support!.approvedActions as string[]).push('service.ro.transition');
        });
      });
      // Outside a request it is a no-op rather than a crash.
      bindSupportContext(facts);
    });

    test('the evidence row and the transactional audit row carry scope, actions and expiry', async () => {
      const live = await approvedSupport();
      const served = await call(live.support.token, 'GET', `/api/service/ros/${roId}`, {
        'x-target-tenant': tenantId,
      });
      assert.equal(served.status, 200);

      const decision = await query(
        `SELECT support_session_id, support_request_id, support_session_expires_at,
                actor_type, scope_level, scope_id, decision, reason_code
           FROM policy_decisions
          WHERE support_session_id IS NOT NULL AND decision = 'allow'
          ORDER BY occurred_at DESC LIMIT 1`,
        [],
      );
      const evidence = decision.rows[0] as Record<string, unknown>;
      assert.equal(String(evidence.support_session_id), live.supportSessionId);
      assert.equal(String(evidence.support_request_id), live.requestId);
      assert.equal(String(evidence.actor_type), 'platform_support');
      assert.equal(String(evidence.scope_level), 'rooftop');
      assert.equal(String(evidence.scope_id), rooftopId);
      assert.equal(
        (evidence.support_session_expires_at as Date).toISOString(),
        live.expiresAt.toISOString(),
      );

      const used = await query(
        `SELECT actor_user_id, details FROM audit_events
          WHERE event_type = 'identity.support.used' ORDER BY created_at DESC LIMIT 1`,
        [],
      );
      const row = used.rows[0] as { actor_user_id: string; details: Record<string, unknown> };
      assert.equal(row.actor_user_id, live.support.userLinkId);
      assert.equal(row.details.support_request_id, live.requestId);
      assert.equal(row.details.support_actor_user_link_id, live.support.userLinkId);
      assert.equal(row.details.support_target_tenant_id, tenantId);
      assert.equal(row.details.support_approved_scope_level, 'rooftop');
      assert.equal(row.details.support_approved_scope_id, rooftopId);
      assert.deepEqual(row.details.support_approved_actions, ['service.ro.view']);
      assert.equal(row.details.support_session_expires_at, live.expiresAt.toISOString());
      assert.ok(
        !JSON.stringify(row.details).includes('ticket 9317'),
        'the reason never reaches the audit trail',
      );
    });

    test('/auth/session declares the grant to the tenant AND to the platform actor', async () => {
      const live = await approvedSupport();

      const tenantView = await call(live.admin.token, 'GET', '/auth/session');
      assert.equal(tenantView.status, 200);
      const tenantGrants = tenantView.body!.data.support_access as Array<Record<string, unknown>>;
      assert.equal(tenantGrants.length, 1);
      assert.equal(tenantGrants[0]!.relationship, 'into_this_tenant');
      assert.equal(tenantGrants[0]!.support_session_id, live.supportSessionId);
      assert.equal(tenantGrants[0]!.support_request_id, live.requestId);
      assert.equal(tenantGrants[0]!.actor_user_link_id, live.support.userLinkId);
      assert.equal(tenantGrants[0]!.target_tenant_id, tenantId);
      assert.equal(tenantGrants[0]!.approved_scope_level, 'rooftop');
      assert.equal(tenantGrants[0]!.approved_scope_id, rooftopId);
      assert.deepEqual(tenantGrants[0]!.approved_actions, ['service.ro.view']);
      assert.equal(tenantGrants[0]!.expires_at, live.expiresAt.toISOString());

      // THE HALF R3 REPORTED NOWHERE: the platform actor's OWN active grants. The read
      // was keyed by tenant and a platform actor has none, so this list was always empty
      // for the one person who can end the access instantly.
      const platformView = await call(live.support.token, 'GET', '/auth/session');
      assert.equal(platformView.status, 200);
      assert.equal(platformView.body!.data.tenant_id, null);
      const own = platformView.body!.data.support_access as Array<Record<string, unknown>>;
      assert.equal(own.length, 1);
      assert.equal(own[0]!.relationship, 'held_by_me');
      assert.equal(own[0]!.support_session_id, live.supportSessionId);
      assert.equal(own[0]!.target_tenant_id, tenantId, 'which customer they can reach into');
      assert.equal(own[0]!.expires_at, live.expiresAt.toISOString(), 'and until when');
      assert.deepEqual(own[0]!.approved_actions, ['service.ro.view']);
    });

    test('/auth/session stays BOUNDED: support facts add no email, profile or token field', async () => {
      const live = await approvedSupport();
      for (const token of [live.admin.token, live.support.token]) {
        const view = await call(token, 'GET', '/auth/session');
        assert.equal(view.status, 200);
        const data = view.body!.data as Record<string, unknown>;
        assert.deepEqual(
          Object.keys(data).sort(),
          [
            'freshness',
            'local_session_expires_at',
            'mfa_assurance',
            'organization_scope',
            'roles',
            'support_access',
            'tenant_id',
            'user_link_id',
          ],
          'the response is a CLOSED set of facts; adding support detail must not widen it',
        );
        const rendered = JSON.stringify(view.body);
        for (const forbidden of [
          'ticket 9317',
          'sam@platform.example',
          'admin@tenant.example',
          'Sam Support',
          'Tina Admin',
          'user_support',
          'user_tenant_admin',
        ]) {
          assert.ok(!rendered.includes(forbidden), `/auth/session must not publish ${forbidden}`);
        }
      }
    });

    test('the support REASON lives in exactly one place: its own row', async () => {
      const live = await approvedSupport();
      await call(live.support.token, 'GET', `/api/service/ros/${roId}`, {
        'x-target-tenant': tenantId,
      });
      const stored = await query(
        `SELECT reason FROM support_access_requests WHERE request_id = $1`,
        [live.requestId],
      );
      assert.equal(String((stored.rows[0] as { reason: string }).reason), REASON);
      // …and nowhere else: not in the decision evidence, not in any audit row.
      const leaks = await query(
        `SELECT
           (SELECT COUNT(*)::int FROM policy_decisions
             WHERE reason_code ILIKE '%ticket%') AS in_evidence,
           (SELECT COUNT(*)::int FROM audit_events
             WHERE details::text ILIKE '%ticket 9317%') AS in_audit`,
        [],
      );
      const counts = leaks.rows[0] as { in_evidence: number; in_audit: number };
      assert.equal(Number(counts.in_evidence), 0);
      assert.equal(Number(counts.in_audit), 0);
    });

    test('the header format has ONE writer, and it cannot omit the expiry', () => {
      // The formatter itself: every entry carries both facts.
      const value = supportAccessHeaderValue([
        {
          supportSessionId: 'session-a',
          supportRequestId: 'request-a',
          expiresAt: new Date('2026-01-01T00:00:00.000Z'),
        },
        {
          supportSessionId: 'session-b',
          supportRequestId: 'request-b',
          expiresAt: new Date('2026-01-02T00:00:00.000Z'),
        },
      ]);
      assert.equal(
        value,
        'active; support_session=session-a; support_request=request-a; ' +
          'expires_at=2026-01-01T00:00:00.000Z, ' +
          'active; support_session=session-b; support_request=request-b; ' +
          'expires_at=2026-01-02T00:00:00.000Z',
      );
      assert.equal(supportAccessHeaderValue([]), null, 'nothing to declare sets no header');

      // AND no second writer exists. R3's two hand-written formats both omitted the
      // expiry, and two formats can always drift apart again — so every app site that
      // sets this header must go through the formatter. A source scan is the only way to
      // assert "nobody else writes it".
      const root = join(__dirname, '..', 'apps');
      const files: string[] = [];
      const walk = (dir: string): void => {
        for (const entry of readdirSync(dir)) {
          const full = join(dir, entry);
          if (statSync(full).isDirectory()) {
            if (entry !== 'node_modules' && entry !== 'dist') walk(full);
          } else if (full.endsWith('.ts')) files.push(full);
        }
      };
      walk(root);
      let sites = 0;
      for (const file of files) {
        const text = readFileSync(file, 'utf8');
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i += 1) {
          if (!/setHeader\(\s*(SUPPORT_ACCESS_HEADER|['"]x-support-access['"])/i.test(lines[i]!)) {
            continue;
          }
          sites += 1;
          const window = lines.slice(Math.max(0, i - 6), i + 6).join('\n');
          assert.match(
            window,
            /supportAccessHeaderValue/,
            `${file}:${i + 1} sets the support header without the shared formatter`,
          );
        }
      }
      assert.ok(sites >= 2, `expected the two known header sites, found ${sites}`);
    });

    test('a request NOT under support access declares nothing', async () => {
      const live = await approvedSupport();
      // The administrator also holds the ordinary read role for this comparison: the
      // point is that a request authorized by the tenant's OWN binding must not carry a
      // delegated-access declaration, and to compare it has to be allowed.
      await grantRole({
        actingUserLinkId: await bootstrapAdministrator(tenantId),
        tenantId,
        userLinkId: live.admin.userLinkId,
        role: 'service_advisor',
        scopeLevel: 'tenant',
        scopeId: tenantId,
      });
      const ordinary = await call(live.admin.token, 'GET', `/api/service/ros/${roId}`);
      assert.equal(ordinary.status, 200);
      assert.equal(
        ordinary.headers.get('x-support-access'),
        null,
        'an ordinary request must not claim delegated access',
      );

      // …and the tenant's own indicator is a TENANT-WIDE fact, so it still shows the live
      // grant on /auth/session. The two are different questions and must stay different.
      const view = await call(live.admin.token, 'GET', '/auth/session');
      assert.equal((view.body!.data.support_access as unknown[]).length, 1);
    });

    test('a revoked grant disappears from both views immediately', async () => {
      const live = await approvedSupport();
      await fixtureAuthorizationStateWrite(
        'simulate-authorization-drift',
        `UPDATE support_access_sessions SET revoked_at = NOW() WHERE support_session_id = $1`,
        [live.supportSessionId],
      );
      const tenantView = await call(live.admin.token, 'GET', '/auth/session');
      assert.equal((tenantView.body!.data.support_access as unknown[]).length, 0);
      const platformView = await call(live.support.token, 'GET', '/auth/session');
      assert.equal((platformView.body!.data.support_access as unknown[]).length, 0);
      const served = await call(live.support.token, 'GET', `/api/service/ros/${roId}`, {
        'x-target-tenant': tenantId,
      });
      assert.equal(served.status, 404, 'revocation denies the very next request');
      assert.equal(served.headers.get('x-support-access'), null);
    });

    test('the logger cannot be talked out of the support facts', () => {
      const facts = {
        supportSessionId: 'the-real-session',
        supportRequestId: 'the-real-request',
        supportActorUserLinkId: randomUUID(),
        targetTenantId: randomUUID(),
        approvedScopeLevel: 'tenant',
        approvedScopeId: null,
        approvedActions: ['service.ro.view'],
        expiresAt: new Date('2026-03-04T05:06:07.000Z'),
      };
      const captured: string[] = [];
      const original = process.stdout.write.bind(process.stdout);
      (process.stdout as unknown as { write: unknown }).write = ((chunk: unknown) => {
        captured.push(String(chunk));
        return true;
      }) as unknown as typeof process.stdout.write;
      const requestId = generateRequestId();
      try {
        runWithRequestContext(
          { requestId, correlationId: requestId, startTime: Date.now() },
          () => {
            bindSupportContext(facts);
            // A caller passing its OWN support fields must not be able to shadow the
            // bound ones: the fields are written after the caller's context, not before.
            logger.info(
              { support_session_id: 'a-lie', support_session_expires_at: 'never' },
              'served',
            );
          },
        );
      } finally {
        (process.stdout as unknown as { write: unknown }).write = original;
      }
      const line = JSON.parse(captured.join('').trim()) as Record<string, unknown>;
      assert.equal(line.support_session_id, 'the-real-session');
      assert.equal(line.support_session_expires_at, '2026-03-04T05:06:07.000Z');
    });
  },
);
