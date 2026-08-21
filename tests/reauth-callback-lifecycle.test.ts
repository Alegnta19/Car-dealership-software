import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, beforeEach, describe, test } from 'node:test';
import {
  certifyMfaPolicy,
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
import {
  NOT_IMPERSONATED,
  TENANT_ADMIN_ROLE,
  expireStaleReauthenticationTransactions,
  openCookiePayload,
  sealCookiePayload,
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
 * FBL-020-R6 §2.4 — THE STEP-UP CALLBACK, AT THE WIRE, WHEN IT DOES NOT GO WELL.
 *
 * ── the defect ─────────────────────────────────────────────────────────────
 *
 * `completeReauthentication` used to SELECT the transaction with four conditions in
 * the predicate:
 *
 *     WHERE nonce_hash = $1 AND user_link_id = $2 AND state = 'started'
 *       AND claimed_at IS NOT NULL AND expires_at > NOW()
 *
 * so a step-up that failed any of them selected NOTHING and the function returned
 * `null` — no terminalization, no audit event, no state change. Two of those four
 * are the cases an operator most needs to see:
 *
 *   * WRONG SUBJECT. The provider round trip came back as a DIFFERENT person in the
 *     same organization. That is either a browser that switched accounts mid-flight
 *     or somebody trying to finish another person's step-up, and it was completely
 *     silent: the transaction stayed `started` with its nonce still claimable.
 *   * EXPIRY DURING THE EXCHANGE. A leg claimed just before `expires_at` and
 *     completed after it fell out of the predicate the same way. The step-up sat
 *     `started` until a SWEEP eventually noticed — minutes later on a real
 *     deployment, under a reason and at a time that had nothing to do with what
 *     happened.
 *
 * ── what this battery drives ───────────────────────────────────────────────
 *
 * The REAL routes: `POST /auth/reauth/start` (authenticated, policy-checked, sealing
 * its own transaction cookie) and then `GET /auth/reauth/callback` with that cookie
 * and a substituted provider port. Nothing reaches past the HTTP surface to arrange
 * an outcome; the only thing the fake provider decides is WHO the round trip comes
 * back as, which is exactly what a provider decides in production.
 *
 * `identity.role.grant` is the action under step-up: it is `sensitive`, it needs no
 * resource, and `tenant_admin` may perform it — so the pre-check that guards
 * `/auth/reauth/start` is satisfied by a real role binding rather than bypassed.
 */
describe(
  'the step-up callback lifecycle (FBL-020-R6 §2.4)',
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
      // The step-up demands `fresh_and_mfa_policy`, so the connection is certified.
      // Without this every case below would refuse for `assurance_not_certified` and
      // prove nothing about the classification under test.
      await certifyMfaPolicy(tenant);
    });

    interface StartedLeg {
      readonly cookie: string;
      readonly state: string;
      readonly oidcNonce: string;
      readonly reauthTxnId: string;
      /** FBL-020-R7 §2.2: the plaintexts needed to RESEAL a cookie with a key removed. */
      readonly nonce: string;
      readonly codeVerifier: string;
    }

    /** Drives the REAL `POST /auth/reauth/start` and opens the cookie it sealed. */
    async function startStepUp(token: string): Promise<StartedLeg> {
      const res = await fetch(`${base}/auth/reauth/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: 'identity.role.grant' }),
      });
      const text = await res.text();
      assert.equal(res.status, 200, `the step-up must start: ${text}`);
      const body = JSON.parse(text) as { data: { reauth_txn_id: string } };
      const match = /dealer_reauth_txn=([^;,]+)/.exec(res.headers.get('set-cookie') ?? '');
      assert.ok(match, 'the start leg must seal a transaction cookie');
      const sealed = decodeURIComponent(match[1]!);
      const payload = openCookiePayload(sealed, env.cookiePassword, { maxAgeSeconds: 600 });
      assert.ok(payload, 'the sealed cookie must open');
      return {
        cookie: `dealer_reauth_txn=${encodeURIComponent(sealed)}`,
        state: String(payload.state),
        oidcNonce: String(payload.oidc_nonce),
        reauthTxnId: body.data.reauth_txn_id,
        nonce: String(payload.nonce),
        codeVerifier: String(payload.code_verifier),
      };
    }

    /**
     * A provider that answers the step-up exchange as `subject`, with a real
     * locally-signed token carrying this leg's OIDC nonce. `beforeReturning` runs
     * INSIDE the exchange — after the claim, before the completion — which is the
     * only place a test can put something without a sleep and without guessing.
     */
    function fakeExchange(input: {
      subject: string;
      oidcNonce: string;
      beforeReturning?: () => Promise<void>;
    }): IdentityProviderPort {
      const unused = (): never => {
        throw new Error('this battery uses only exchangeCode');
      };
      return {
        buildAuthorizationUrl: () => 'http://127.0.0.1:1/authorize',
        buildLogoutUrl: () => 'http://127.0.0.1:1/logout',
        refreshSession: unused,
        async exchangeCode(): Promise<CodeExchangeResult> {
          if (input.beforeReturning !== undefined) await input.beforeReturning();
          const sid = 'sid_stepup_' + randomUUID().slice(0, 8);
          return {
            accessToken: await env.issuer.signAccessToken({
              sub: input.subject,
              sid,
              org_id: testOrganizationId(tenant),
              nonce: input.oidcNonce,
            }),
            refreshToken: 'provider-refresh-stepup',
            providerUserId: input.subject,
            providerSessionId: sid,
            organizationId: testOrganizationId(tenant),
            email: 'person@example.test',
            displayName: 'Test Person',
            impersonation: NOT_IMPERSONATED,
          };
        },
      };
    }

    async function completeLeg(leg: StartedLeg) {
      const res = await fetch(`${base}/auth/reauth/callback?code=any-code&state=${leg.state}`, {
        headers: { cookie: leg.cookie },
        redirect: 'manual',
      });
      const text = await res.text();
      return {
        status: res.status,
        body: text ? (JSON.parse(text) as Record<string, unknown>) : null,
      };
    }

    async function stepUpRow(reauthTxnId: string) {
      const r = await query(
        `SELECT state, terminal_reason, terminal_at, claimed_at, user_link_id
           FROM reauthentication_transactions WHERE reauth_txn_id = $1`,
        [reauthTxnId],
      );
      return r.rows[0] as Record<string, unknown>;
    }

    async function stepUpEvents(reauthTxnId: string): Promise<string[]> {
      const r = await query(
        `SELECT event_type FROM audit_events
          WHERE entity_type = 'reauth_transaction' AND entity_id = $1
          ORDER BY created_at, event_id`,
        [reauthTxnId],
      );
      return (r.rows as Array<{ event_type: string }>).map((x) => x.event_type);
    }

    async function grantCount(): Promise<number> {
      const r = await query(`SELECT COUNT(*)::int AS n FROM reauthentication_grants`);
      return Number((r.rows[0] as { n: number }).n);
    }

    async function seedAdmin() {
      return seedActor(env.issuer, { tenantId: tenant, roles: [TENANT_ADMIN_ROLE] });
    }

    /**
     * THE CONTROL. Without it, each refusal below could be a step-up that was broken
     * for some entirely unrelated reason — a missing certification, a policy denial,
     * a token the verifier would not accept.
     */
    test('CONTROL — the same two legs, with the right person and time, mint exactly one grant', async () => {
      const admin = await seedAdmin();
      const leg = await startStepUp(admin.token);
      useIdentityProviderForTests(
        fakeExchange({ subject: admin.providerUserId, oidcNonce: leg.oidcNonce }),
      );

      const res = await completeLeg(leg);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(await grantCount(), 1, 'the unraced, correctly-attributed leg mints its grant');
      const row = await stepUpRow(leg.reauthTxnId);
      assert.equal(row.state, 'completed');
      assert.equal(row.terminal_reason, 'granted');
      assert.deepEqual(await stepUpEvents(leg.reauthTxnId), [
        'identity.reauthentication.started',
        'identity.reauthentication.claimed',
        'identity.reauthentication.granted',
      ]);
    });

    /**
     * FBL-020-R6 §2.1, THE STEP-UP LEG — a callback with NO `state` at all.
     *
     * R5 refused this IN THE ROUTE, before `claimReauthentication`, with a valid
     * sealed cookie naming a live `started` transaction in hand. The answer was a 401
     * and nothing else: the transaction was not terminalized, its nonce stayed
     * claimable, and no audit event was written. The row's stored digest is the
     * authority for what a callback presented, so the row is what judges it.
     */
    test('a step-up callback with NO state ends its transaction rather than leaving it claimable', async () => {
      const admin = await seedAdmin();
      const leg = await startStepUp(admin.token);
      // A provider that WOULD succeed, so the refusal cannot be an accident.
      useIdentityProviderForTests(
        fakeExchange({ subject: admin.providerUserId, oidcNonce: leg.oidcNonce }),
      );

      const res = await fetch(`${base}/auth/reauth/callback?code=any-code`, {
        headers: { cookie: leg.cookie },
        redirect: 'manual',
      });
      const text = await res.text();
      assert.equal(res.status, 401);
      assert.equal(
        (JSON.parse(text) as { error?: { code?: string } }).error?.code,
        'unauthorized',
        'the neutral answer',
      );
      assert.equal(await grantCount(), 0);

      const row = await stepUpRow(leg.reauthTxnId);
      assert.equal(row.state, 'failed', 'the transaction the callback named must END');
      assert.equal(row.terminal_reason, 'callback_state_mismatch');
      assert.deepEqual(await stepUpEvents(leg.reauthTxnId), [
        'identity.reauthentication.started',
        'identity.reauthentication.failed',
      ]);

      // …and the CORRECT callback afterwards loses, which is what burning it buys.
      const late = await completeLeg(leg);
      assert.equal(late.status, 401, 'the correct callback arriving afterwards must lose');
      assert.equal(await grantCount(), 0);
      const after = await stepUpRow(leg.reauthTxnId);
      assert.equal(after.state, 'failed');
      assert.equal(
        after.terminal_reason,
        'callback_state_mismatch',
        'the FIRST terminal fact wins; nothing overwrites it',
      );
    });

    /**
     * ── FBL-020-R7 §2.2, THE STEP-UP LEG: A SEALED COOKIE WITH NO PURPOSE AT ALL ──
     *
     * R6 read an omitted purpose as "the cookie said `reauth`", so this exact cookie
     * satisfied the purpose comparison without ever making it. Absence is now a
     * `callback_purpose_mismatch` of its own: the ROUTE forwards the valid handle
     * and a `null` presented purpose — it does not pre-screen the defect — and the
     * LIFECYCLE SERVICE terminalizes the row it names, with one audit event.
     */
    test('a step-up callback whose sealed cookie carries NO PURPOSE ends its transaction', async () => {
      const admin = await seedAdmin();
      const leg = await startStepUp(admin.token);
      // A provider that WOULD succeed, so the refusal cannot be an accident.
      useIdentityProviderForTests(
        fakeExchange({ subject: admin.providerUserId, oidcNonce: leg.oidcNonce }),
      );

      // The leg's OWN handle, state, verifier and nonce, resealed under the server
      // key with the `purpose` key OMITTED ENTIRELY. Only the server can mint such a
      // cookie, which is exactly why the row — not the route — has to judge it.
      const resealed = sealCookiePayload(
        {
          state: leg.state,
          code_verifier: leg.codeVerifier,
          nonce: leg.nonce,
          oidc_nonce: leg.oidcNonce,
        },
        env.cookiePassword,
      );
      const res = await fetch(`${base}/auth/reauth/callback?code=any-code&state=${leg.state}`, {
        headers: { cookie: `dealer_reauth_txn=${encodeURIComponent(resealed)}` },
        redirect: 'manual',
      });
      const text = await res.text();
      assert.equal(res.status, 401);
      assert.equal(
        (JSON.parse(text) as { error?: { code?: string } }).error?.code,
        'unauthorized',
        'the neutral answer',
      );
      assert.equal(await grantCount(), 0);

      const row = await stepUpRow(leg.reauthTxnId);
      assert.equal(row.state, 'failed', 'the transaction the callback named must END');
      assert.equal(row.terminal_reason, 'callback_purpose_mismatch');
      assert.deepEqual(
        await stepUpEvents(leg.reauthTxnId),
        ['identity.reauthentication.started', 'identity.reauthentication.failed'],
        'exactly one terminal audit event',
      );

      // …and the CORRECT callback afterwards — the original, complete cookie —
      // loses as the replay it now is.
      const late = await completeLeg(leg);
      assert.equal(late.status, 401, 'the correct callback arriving afterwards must lose');
      assert.equal(await grantCount(), 0);
      const after = await stepUpRow(leg.reauthTxnId);
      assert.equal(after.state, 'failed');
      assert.equal(
        after.terminal_reason,
        'callback_purpose_mismatch',
        'the FIRST terminal fact wins; nothing overwrites it',
      );
    });

    /**
     * WRONG ACTIVE USER — the round trip comes back as somebody else.
     *
     * Both people are real, activated, bound members of the SAME tenant and the SAME
     * connection, so every check before the subject comparison passes: the connection
     * resolves, the issuer is the configured one, the link is found and activated. The
     * ONLY thing wrong is that the person who re-authenticated is not the person the
     * step-up was opened for — which is the case R5 answered with a bare `null`.
     */
    test('a step-up completed by the WRONG ACTIVE USER is terminal, audited, and mints nothing', async () => {
      const admin = await seedAdmin();
      const someoneElse = await seedAdmin();
      assert.notEqual(admin.userLinkId, someoneElse.userLinkId, 'two distinct people');
      const leg = await startStepUp(admin.token);
      // The transaction was opened for `admin`…
      assert.equal(String((await stepUpRow(leg.reauthTxnId)).user_link_id), admin.userLinkId);
      // …and the provider hands back `someoneElse`.
      useIdentityProviderForTests(
        fakeExchange({ subject: someoneElse.providerUserId, oidcNonce: leg.oidcNonce }),
      );

      const res = await completeLeg(leg);
      assert.equal(res.status, 401, 'the neutral answer');
      assert.equal(
        (res.body as { error?: { code?: string } } | null)?.error?.code,
        'unauthorized',
        'and it says nothing about whose step-up it was',
      );
      assert.equal(await grantCount(), 0, 'no grant is minted for the wrong person');

      const row = await stepUpRow(leg.reauthTxnId);
      assert.equal(row.state, 'failed', 'the transaction ENDS rather than staying claimable');
      assert.equal(row.terminal_reason, 'wrong_subject');
      assert.notEqual(row.terminal_at, null, 'and it records WHEN');
      assert.equal(
        String(row.user_link_id),
        admin.userLinkId,
        'the row still names the person it was opened for; a refusal does not rewrite it',
      );

      const events = await stepUpEvents(leg.reauthTxnId);
      assert.deepEqual(events, [
        'identity.reauthentication.started',
        'identity.reauthentication.claimed',
        'identity.reauthentication.failed',
      ]);
      // The audit row is attributed to the TRUE OWNER of the step-up, not to the
      // person who turned up: the event is a fact about this transaction.
      const failed = await query(
        `SELECT actor_user_id FROM audit_events
          WHERE entity_type = 'reauth_transaction' AND entity_id = $1
            AND event_type = 'identity.reauthentication.failed'`,
        [leg.reauthTxnId],
      );
      assert.equal(failed.rows.length, 1, 'exactly one terminal audit event');
      assert.equal(
        String((failed.rows[0] as { actor_user_id: unknown }).actor_user_id),
        admin.userLinkId,
      );
    });

    /**
     * EXPIRY DURING THE EXCHANGE, WITH NO SWEEP ANYWHERE.
     *
     * The claim happens, the provider takes longer than the transaction's remaining
     * life, and the completion arrives after the deadline. Only the CLOCK moves — no
     * sweep is invoked, nothing else terminalizes the row — so what refuses is the
     * completion's own expiry classification and nothing else. The sweep runs at the
     * END as a control and must find nothing left to age, which is what makes "no
     * sweep was involved" measured rather than promised.
     */
    test('a step-up that EXPIRES during the exchange is terminal and audited WITHOUT any sweep', async () => {
      const admin = await seedAdmin();
      const leg = await startStepUp(admin.token);

      let clockMoved = 0;
      useIdentityProviderForTests(
        fakeExchange({
          subject: admin.providerUserId,
          oidcNonce: leg.oidcNonce,
          beforeReturning: async () => {
            // The row is `started` AND claimed at this point — the route claims before
            // it exchanges — so this is exactly the interleaving §2.4 names.
            const moved = await query(
              `UPDATE reauthentication_transactions
                  SET started_at = NOW() - INTERVAL '2 hours',
                      expires_at = NOW() - INTERVAL '1 hour'
                WHERE reauth_txn_id = $1 AND state = 'started' AND claimed_at IS NOT NULL`,
              [leg.reauthTxnId],
            );
            clockMoved = moved.rowCount ?? 0;
          },
        }),
      );

      const res = await completeLeg(leg);
      assert.equal(clockMoved, 1, 'the deadline must have moved on a CLAIMED, STARTED row');
      assert.equal(res.status, 401, 'the neutral answer');
      assert.equal(await grantCount(), 0, 'an expired step-up mints nothing');

      const row = await stepUpRow(leg.reauthTxnId);
      assert.equal(row.state, 'expired', 'expiry is its own state, not a generic failure');
      assert.equal(row.terminal_reason, 'expired');
      assert.notEqual(row.terminal_at, null);

      const events = await stepUpEvents(leg.reauthTxnId);
      assert.deepEqual(events, [
        'identity.reauthentication.started',
        'identity.reauthentication.claimed',
        'identity.reauthentication.expired',
      ]);

      // THE CONTROL: the sweep, run for the first time, has nothing to do.
      assert.equal(
        await expireStaleReauthenticationTransactions(),
        0,
        'the completion path enforced the expiry itself — the sweep was not the mechanism',
      );
      assert.deepEqual(
        await stepUpEvents(leg.reauthTxnId),
        events,
        'and it wrote no second expiry event',
      );
    });
  },
);
