import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, beforeEach, describe, test } from 'node:test';
import {
  resetDatabase,
  seedActor,
  seedRooftopIdentity,
  seedTenantIdentity,
  skipIntegration,
  startIdentityTestEnv,
  testOrganizationId,
  type IdentityTestEnv,
} from '@dealer/test-kit';
import { closePool, query } from '@dealer/database';
import { ROLES } from '@dealer/contracts';
import {
  NOT_IMPERSONATED,
  openCookiePayload,
  revokeForIdentityBreach,
  revokeSessionById,
  revokeSessionByToken,
  revokeSessionsForUserLink,
  type CodeExchangeResult,
  type IdentityProviderPort,
} from '@dealer/identity-access';
import {
  createApp,
  resetAuthRoutesForTests,
  resetIdentityCompositionForTests,
  useIdentityProviderForTests,
} from '@dealer/api';

/**
 * FBL-020-R5 §1.1/§1.2 — REVOCATION DESTROYS THE PROVIDER CREDENTIAL, ON EVERY PATH.
 *
 * ── the defect ─────────────────────────────────────────────────────────────
 *
 * `packages/identity-access/src/session.ts` interpolated a shared clearing clause
 * into four hand-written revocation UPDATEs. Three carried it. The fourth was
 * `revokeSessionByToken` — the COOKIE LOGOUT path, `POST /auth/logout` for a
 * session established by `GET /auth/callback`.
 *
 * `/auth/callback` ALWAYS stores refresh state, so that omission was not
 * theoretical: logging out of any callback-created cookie session tried to leave
 * `refresh_token_hash` and `refresh_state_sealed` set on a row whose `revoked_at`
 * had just been written, which migration 057's `is_revoked_holds_no_refresh_state`
 * refuses. The statement aborted, `withTransaction` rolled the whole thing back,
 * and the session the person had just logged out of REMAINED LIVE with its
 * provider refresh credential intact.
 *
 * ── why the existing suite could not see it ────────────────────────────────
 *
 * `tests/auth.test.ts` logs out of sessions built by its own `sessionFor` helper,
 * which passes no refresh token unless a test asks for one — so the rows it
 * revokes hold no refresh state and the missing clause changes nothing about them.
 * The defect is reachable ONLY through a session that carries refresh state, and
 * the only production path that creates one is the login callback. This battery
 * therefore drives the REAL leg: `/auth/login`, `/auth/callback` against a
 * substituted provider port, then `/auth/logout` with the cookie the browser got.
 */
describe(
  'session revocation destroys the provider credential (FBL-020-R5 §1.1)',
  { skip: skipIntegration ? 'set TEST_DATABASE_URL to run' : false },
  () => {
    let server: Server;
    let base: string;
    let env: IdentityTestEnv;
    let tenant: string;

    before(async () => {
      env = await startIdentityTestEnv();
      resetIdentityCompositionForTests();
      resetAuthRoutesForTests();
      server = createApp().listen(0);
      await new Promise<void>((resolve) => server.once('listening', () => resolve()));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    after(async () => {
      useIdentityProviderForTests(undefined);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await env.stop();
      await closePool();
    });

    beforeEach(async () => {
      useIdentityProviderForTests(undefined);
      await resetDatabase();
      tenant = randomUUID();
      await seedTenantIdentity(tenant);
      await seedRooftopIdentity(tenant, randomUUID());
    });

    /** The provider refresh token every login in this battery takes into custody. */
    const PROVIDER_REFRESH_TOKEN = 'provider-refresh-logout-battery';

    /**
     * A provider port whose `exchangeCode` answers with a real locally-signed
     * access token, a matching exchange response, and a refresh token — which is
     * what makes the session it establishes REFRESHABLE, and therefore what makes
     * the defect reachable at all.
     */
    function fakeExchange(subject: string, oidcNonce: string): IdentityProviderPort {
      const unused = (): never => {
        throw new Error('this battery uses only exchangeCode and buildLogoutUrl');
      };
      return {
        buildAuthorizationUrl: () => 'http://127.0.0.1:1/authorize',
        buildLogoutUrl: () => 'http://127.0.0.1:1/logout',
        refreshSession: unused,
        async exchangeCode(): Promise<CodeExchangeResult> {
          const sid = 'sid_logout_' + randomUUID().slice(0, 8);
          const accessToken = await env.issuer.signAccessToken({
            sub: subject,
            sid,
            org_id: testOrganizationId(tenant),
            nonce: oidcNonce,
          });
          return {
            accessToken,
            refreshToken: PROVIDER_REFRESH_TOKEN,
            providerUserId: subject,
            providerSessionId: sid,
            organizationId: testOrganizationId(tenant),
            email: 'person@example.test',
            displayName: 'Test Person',
            impersonation: NOT_IMPERSONATED,
          };
        },
      };
    }

    /**
     * Drives `GET /auth/login` then `GET /auth/callback` and returns the SESSION
     * COOKIE a browser would hold. Nothing here fabricates a session row: the
     * session is whatever the production route created.
     */
    async function loginThroughCallback(subject: string): Promise<string> {
      const login = await fetch(`${base}/auth/login`, { redirect: 'manual' });
      assert.equal(login.status, 302);
      const txnMatch = /dealer_auth_txn=([^;,]+)/.exec(login.headers.get('set-cookie') ?? '');
      assert.ok(txnMatch, 'the login leg must seal a transaction cookie');
      const sealed = decodeURIComponent(txnMatch[1]!);
      const payload = openCookiePayload(sealed, env.cookiePassword, { maxAgeSeconds: 600 });
      assert.ok(payload, 'the sealed transaction cookie must open');

      useIdentityProviderForTests(fakeExchange(subject, String(payload.oidc_nonce)));
      const callback = await fetch(
        `${base}/auth/callback?code=any-code&state=${String(payload.state)}`,
        {
          headers: { cookie: `dealer_auth_txn=${encodeURIComponent(sealed)}` },
          redirect: 'manual',
        },
      );
      assert.equal(callback.status, 302, 'the admitted login must redirect');
      const session = /dealer_session=([^;,]+)/.exec(callback.headers.get('set-cookie') ?? '');
      assert.ok(session, 'the callback must set a session cookie');
      return decodeURIComponent(session[1]!);
    }

    /** The whole session row, read back without interpreting it. */
    async function sessionRow(): Promise<Record<string, unknown>> {
      const r = await query(`SELECT * FROM identity_sessions`);
      assert.equal(r.rows.length, 1, 'this battery works with exactly one session at a time');
      return r.rows[0] as Record<string, unknown>;
    }

    async function sessionLifecycleEvents(
      sessionId: string,
    ): Promise<Array<{ event_type: string; actor_user_id: unknown }>> {
      const r = await query(
        `SELECT event_type, actor_user_id FROM audit_events
          WHERE entity_type = 'identity_session' AND entity_id = $1
          ORDER BY created_at, event_id`,
        [sessionId],
      );
      return r.rows as Array<{ event_type: string; actor_user_id: unknown }>;
    }

    /**
     * THE §1.2 TEST.
     *
     * Every clause below is one of the order's requirements, in order: logout
     * returns success, clears the cookie, revokes the row, destroys ALL FIVE
     * refresh-state columns, writes EXACTLY ONE logout audit event, and leaves the
     * original cookie unusable on the next request.
     *
     * WITHOUT THE FIX this test does not merely miss an assertion — the logout
     * request fails outright, because the CHECK constraint aborts the revocation
     * and the transaction rolls back. Both halves of the consequence are asserted:
     * the request's own outcome AND the session still being usable afterwards.
     */
    test('cookie LOGOUT of a callback-created REFRESHABLE session revokes it and destroys every trace of the provider credential', async () => {
      const advisor = await seedActor(env.issuer, {
        tenantId: tenant,
        roles: [ROLES.SERVICE_ADVISOR],
      });
      const sessionToken = await loginThroughCallback(advisor.providerUserId);
      const cookie = `dealer_session=${encodeURIComponent(sessionToken)}`;

      // The precondition that makes this test mean anything: the session the real
      // callback created is REFRESHABLE. If this ever stops holding, the test is
      // exercising the shape the old suite already covered and proves nothing.
      const before = await sessionRow();
      assert.notEqual(before.refresh_state_sealed, null, 'the callback must seal refresh state');
      assert.notEqual(before.refresh_token_hash, null, 'and store its replay digest');
      assert.equal(before.revoked_at, null);
      const sessionId = String(before.session_id);
      const versionBefore = Number(before.authorization_version);

      // The cookie works before the logout — otherwise "unusable afterwards"
      // would be satisfied by a session that never worked.
      assert.equal(
        (await fetch(`${base}/api/service/home`, { headers: { cookie } })).status,
        200,
        'the callback-created session must authenticate before logout',
      );
      const sessionView = await fetch(`${base}/auth/session`, { headers: { cookie } });
      assert.equal(sessionView.status, 200);
      const csrf = sessionView.headers.get('x-csrf-token') ?? '';
      assert.notEqual(csrf, '', 'a cookie session must be handed a CSRF token');

      // ── the logout ────────────────────────────────────────────────────────
      const out = await fetch(`${base}/auth/logout`, {
        method: 'POST',
        headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' },
        body: '{}',
      });
      const outBody = (await out.json()) as { data?: { logged_out?: boolean } };
      assert.equal(out.status, 200, `logout must succeed: ${JSON.stringify(outBody)}`);
      assert.equal(outBody.data?.logged_out, true);
      assert.match(
        out.headers.get('set-cookie') ?? '',
        /dealer_session=;/,
        'logout must clear the session cookie',
      );

      // ── the row: revoked, version advanced, ALL refresh state destroyed ───
      const after = await sessionRow();
      assert.notEqual(after.revoked_at, null, 'the row must be revoked');
      assert.equal(after.revoked_reason, 'logout');
      assert.equal(
        Number(after.authorization_version),
        versionBefore + 1,
        'a revocation advances the authorization version',
      );
      for (const column of [
        'refresh_token_hash',
        'refresh_state_sealed',
        'refresh_state_key_version',
        'refresh_lease_id',
        'refresh_lease_expires_at',
      ]) {
        assert.equal(after[column], null, `revocation must destroy ${column}`);
      }
      assert.ok(
        !JSON.stringify(after).includes(PROVIDER_REFRESH_TOKEN),
        'and no raw refresh token may survive anywhere in the row',
      );

      // ── EXACTLY ONE audit event for the logout ────────────────────────────
      const events = await sessionLifecycleEvents(sessionId);
      const loggedOut = events.filter((e) => e.event_type === 'identity.session.logged_out');
      assert.equal(
        loggedOut.length,
        1,
        `exactly one logout event, observed: ${JSON.stringify(events)}`,
      );
      assert.equal(
        String(loggedOut[0]!.actor_user_id),
        String(after.user_link_id),
        'a logout is the session owner’s own act',
      );
      assert.equal(
        events.filter((e) => e.event_type === 'identity.session.revoked').length,
        0,
        'a logout is not additionally recorded as a platform revocation',
      );

      // ── the original cookie is unusable on the NEXT request ───────────────
      assert.equal(
        (await fetch(`${base}/api/service/home`, { headers: { cookie } })).status,
        401,
        'the cookie the browser still holds must no longer authenticate',
      );
    });

    /**
     * §1.1's "every other exported revocation entry point". Each of the four is
     * driven against a session carrying REAL refresh state, so a path that dropped
     * the clearing clause would fail here the way the cookie path failed above.
     *
     * The sessions are still created by the real callback: a fixture-built session
     * would let this battery pass against a login that had stopped taking the
     * provider credential into custody at all.
     */
    const entryPoints: Array<{
      readonly name: string;
      readonly reason: string;
      readonly expectedEvent: string;
      readonly revoke: (input: {
        sessionToken: string;
        sessionId: string;
        userLinkId: string;
      }) => Promise<unknown>;
    }> = [
      {
        name: 'revokeSessionByToken',
        reason: 'logout',
        expectedEvent: 'identity.session.logged_out',
        revoke: ({ sessionToken }) => revokeSessionByToken(sessionToken, 'logout'),
      },
      {
        name: 'revokeSessionById',
        reason: 'logout',
        expectedEvent: 'identity.session.logged_out',
        revoke: ({ sessionId }) => revokeSessionById(sessionId, 'logout'),
      },
      {
        name: 'revokeSessionsForUserLink',
        reason: 'security_event',
        expectedEvent: 'identity.session.revoked',
        revoke: ({ userLinkId }) => revokeSessionsForUserLink(userLinkId, 'security_event'),
      },
      {
        name: 'revokeForIdentityBreach',
        reason: 'identity_mismatch',
        expectedEvent: 'identity.session.revoked',
        revoke: ({ sessionId }) => revokeForIdentityBreach(sessionId, 'identity_mismatch'),
      },
    ];

    for (const entry of entryPoints) {
      test(`${entry.name} destroys the refresh credential of a REFRESHABLE session and audits it once`, async () => {
        const advisor = await seedActor(env.issuer, {
          tenantId: tenant,
          roles: [ROLES.SERVICE_ADVISOR],
        });
        const sessionToken = await loginThroughCallback(advisor.providerUserId);
        const before = await sessionRow();
        assert.notEqual(
          before.refresh_state_sealed,
          null,
          'the session under test must actually hold refresh state',
        );
        const sessionId = String(before.session_id);
        const userLinkId = String(before.user_link_id);

        await entry.revoke({ sessionToken, sessionId, userLinkId });

        const after = await sessionRow();
        assert.notEqual(after.revoked_at, null, `${entry.name} must revoke the row`);
        assert.equal(after.revoked_reason, entry.reason);
        assert.equal(
          Number(after.authorization_version),
          Number(before.authorization_version) + 1,
          `${entry.name} must advance the authorization version`,
        );
        for (const column of [
          'refresh_token_hash',
          'refresh_state_sealed',
          'refresh_state_key_version',
          'refresh_lease_id',
          'refresh_lease_expires_at',
        ]) {
          assert.equal(after[column], null, `${entry.name} must destroy ${column}`);
        }
        const events = await sessionLifecycleEvents(sessionId);
        assert.equal(
          events.filter((e) => e.event_type === entry.expectedEvent).length,
          1,
          `${entry.name} must write exactly one ${entry.expectedEvent}: ${JSON.stringify(events)}`,
        );
      });
    }

    /**
     * FBL-020-R5 §1.7 — ATOMICITY, MEASURED UNDER A REAL FAULT.
     *
     * "Make definitive refresh revocation and its audit one transaction."
     *
     * Every test above proves the two things HAPPEN. None of them could distinguish
     * "one transaction" from "two that both succeeded", because nothing made the
     * second one fail — which is the only observation that separates the claim from
     * its appearance. R4's `revokeForIdentityBreach` ran on the bare pool, so the
     * revocation and the audit row it owed were two independent implicit
     * transactions: a failure between them left a destroyed session with no trail,
     * and no passing test would have noticed.
     *
     * So the audit INSERT is made to fail, at the database, for real. A BEFORE INSERT
     * trigger on `audit_events` raises on the one event type this revocation must
     * write. If the revocation and the audit share a transaction, the raise takes the
     * revocation down with it and the session is left exactly as it was. If they do
     * not, the session is destroyed and the trail is silent.
     *
     * The trigger is dropped in `finally` and the CONTROL leg then runs the same call
     * successfully, so this test cannot pass because the revocation was impossible for
     * some unrelated reason.
     */
    test('a failing audit insert takes the revocation down with it — they are ONE transaction', async () => {
      const advisor = await seedActor(env.issuer, {
        tenantId: tenant,
        roles: [ROLES.SERVICE_ADVISOR],
      });
      await loginThroughCallback(advisor.providerUserId);
      const before = await sessionRow();
      assert.notEqual(
        before.refresh_state_sealed,
        null,
        'the session under test holds credentials',
      );
      const sessionId = String(before.session_id);

      await query(`
        CREATE OR REPLACE FUNCTION fbl020r5_refuse_revocation_audit() RETURNS trigger AS $$
        BEGIN
          IF NEW.event_type = 'identity.session.revoked' THEN
            RAISE EXCEPTION 'FBL-020-R5 §1.7 injected audit failure';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql`);
      try {
        await query(`
          CREATE TRIGGER fbl020r5_refuse_revocation_audit
            BEFORE INSERT ON audit_events
            FOR EACH ROW EXECUTE FUNCTION fbl020r5_refuse_revocation_audit()`);

        await assert.rejects(
          () => revokeForIdentityBreach(sessionId, 'identity_mismatch'),
          /injected audit failure/,
          'the audit failure must surface, not be swallowed',
        );

        // THE POINT: the revocation did not commit alone.
        const after = await sessionRow();
        assert.equal(after.revoked_at, null, 'the session must NOT be revoked without its trail');
        assert.equal(after.revoked_reason, null);
        assert.equal(
          Number(after.authorization_version),
          Number(before.authorization_version),
          'and the authorization version did not advance either',
        );
        assert.equal(
          after.refresh_state_sealed,
          before.refresh_state_sealed,
          'the provider credential is exactly as it was — nothing half-happened',
        );
        assert.equal(after.refresh_token_hash, before.refresh_token_hash);
        assert.equal(
          (await sessionLifecycleEvents(sessionId)).filter(
            (e) => e.event_type === 'identity.session.revoked',
          ).length,
          0,
          'and no audit row survived the rollback',
        );
      } finally {
        await query(`DROP TRIGGER IF EXISTS fbl020r5_refuse_revocation_audit ON audit_events`);
        await query(`DROP FUNCTION IF EXISTS fbl020r5_refuse_revocation_audit()`);
      }

      // CONTROL — with the fault removed, the very same call revokes and audits.
      assert.equal(await revokeForIdentityBreach(sessionId, 'identity_mismatch'), true);
      const control = await sessionRow();
      assert.notEqual(control.revoked_at, null);
      assert.equal(control.refresh_state_sealed, null);
      assert.equal(
        (await sessionLifecycleEvents(sessionId)).filter(
          (e) => e.event_type === 'identity.session.revoked',
        ).length,
        1,
        'CONTROL: exactly one revocation event when nothing is injected',
      );
    });

    /**
     * THE STRUCTURAL HALF, and the reason a fifth copy cannot be added quietly.
     *
     * The behavioural tests above prove the four entry points that exist today are
     * correct. They cannot prove anything about a FIFTH one somebody writes next
     * quarter — which is exactly how this defect arrived, since three of four
     * copies were right. So the source itself is held to the rule: the text that
     * revokes a session may appear in ONE place in the whole of `apps/` and
     * `packages/`, and that place must carry all five clearing assignments.
     *
     * Stated precisely, because an inaccurate absolute is worse than a narrow
     * truth: this walks every `.ts` source under `apps/` and `packages/`, extracts
     * every template literal, and looks for the ones that both `UPDATE
     * identity_sessions` and assign `revoked_at`. Other tables have their own
     * `revoked_at` (role bindings, support-access sessions, MFA certifications) and
     * are none of this rule's business. It is a LEXICAL guard over the SQL this
     * codebase actually writes — not a proof that no statement could revoke a
     * session by some other spelling, and not a claim about SQL issued from
     * anywhere but these two trees.
     */
    test('the revocation statement is written ONCE, and it cannot be written without destroying refresh state', () => {
      const root = join(__dirname, '..');
      const sources: string[] = [];
      const walk = (dir: string): void => {
        for (const entry of readdirSync(dir)) {
          if (entry === 'node_modules' || entry === 'dist') continue;
          const full = join(dir, entry);
          if (statSync(full).isDirectory()) walk(full);
          else if (full.endsWith('.ts') && !full.endsWith('.d.ts')) sources.push(full);
        }
      };
      walk(join(root, 'apps'));
      walk(join(root, 'packages'));
      assert.ok(sources.length > 50, 'the walk must actually have found the source trees');

      /** Every template literal in a source, with the SQL comment lines stripped. */
      function sqlLiterals(text: string): string[] {
        const literals: string[] = [];
        let index = text.indexOf('`');
        while (index !== -1) {
          const close = text.indexOf('`', index + 1);
          if (close === -1) break;
          literals.push(
            text
              .slice(index + 1, close)
              .split('\n')
              .filter((line) => !/^\s*--/.test(line))
              .join('\n'),
          );
          index = text.indexOf('`', close + 1);
        }
        return literals;
      }

      const occurrences: Array<{ file: string; statement: string }> = [];
      for (const file of sources) {
        const text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
        for (const literal of sqlLiterals(text)) {
          if (!/UPDATE\s+identity_sessions/.test(literal)) continue;
          if (!/(^|[\s,])revoked_at\s*=/.test(literal)) continue;
          occurrences.push({
            file: file.slice(root.length + 1).replace(/\\/g, '/'),
            statement: literal,
          });
        }
      }

      assert.equal(
        occurrences.length,
        1,
        'a session may be revoked in exactly ONE statement; found: ' +
          JSON.stringify(occurrences.map((o) => o.file)),
      );
      assert.equal(
        occurrences[0]!.file,
        'packages/identity-access/src/session.ts',
        'and that statement lives in the identity package',
      );
      for (const clause of [
        'refresh_token_hash = NULL',
        'refresh_state_sealed = NULL',
        'refresh_state_key_version = NULL',
        'refresh_lease_id = NULL',
        'refresh_lease_expires_at = NULL',
      ]) {
        assert.ok(
          occurrences[0]!.statement.includes(clause),
          `the one revocation statement must carry "${clause}"`,
        );
      }
      assert.ok(
        occurrences[0]!.statement.includes('authorization_version = authorization_version + 1'),
        'and it must advance the authorization version',
      );
    });
  },
);
