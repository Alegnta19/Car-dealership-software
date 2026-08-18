import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, beforeEach, describe, test } from 'node:test';
import {
  bootstrapAdministrator,
  resetDatabase,
  seedActor,
  seedRooftopIdentity,
  seedTenantIdentity,
  skipIntegration,
  startIdentityTestEnv,
  testOrganizationId,
  type IdentityTestEnv,
  fixtureAuthorizationStateWrite,
} from '@dealer/test-kit';
import { closePool, query } from '@dealer/database';
import { ROLES } from '@dealer/contracts';
import {
  NOT_IMPERSONATED,
  admitLoginAndEstablishSession,
  exchangeMatchesVerifiedToken,
  expireStaleLoginTransactions,
  openCookiePayload,
  type CodeExchangeResult,
  type IdentityProviderPort,
  type VerifiedAccessToken,
} from '@dealer/identity-access';
import {
  createApp,
  resetAuthRoutesForTests,
  resetIdentityCompositionForTests,
  useIdentityProviderForTests,
} from '@dealer/api';

/**
 * FBL-020-R4 §1 — LOGIN ADMISSION AT THE WIRE.
 *
 * The R3 callback checked an incomplete set of facts and never compared the two
 * carriers of the identity with each other. This suite drives the REAL route —
 * `GET /auth/login` then `GET /auth/callback` against a substituted provider
 * port — and asserts:
 *
 *   * the SUCCESSFUL leg end to end: a session cookie that authenticates a
 *     subsequent API request, a `succeeded` transaction, and the return location
 *     read back from the server row;
 *   * and then EVERY refusal: inactive tenant, closed tenant window, archived
 *     organization hierarchy, future and expired UserLink windows,
 *     disabled/future/expired connection, issuer drift, all four exchange↔token
 *     mismatches and both impersonation branches — fifteen scenarios. Each one
 *     produces the SAME neutral 401 and leaves no session, no cookie and no
 *     stored provider refresh credential behind;
 *   * and — FBL-020-R4 closeout F3 — that the fifteen answers are BYTE-IDENTICAL
 *     to one another, not merely equal after `JSON.parse`. The R4 version of that
 *     test sampled the first six and compared parsed objects.
 */
describe(
  'login admission (FBL-020-R4 §1)',
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

    /** What the transaction cookie carries: the handle plus the round-trip plaintext. */
    interface TxnCookie {
      readonly header: string;
      readonly state: string;
      readonly oidcNonce: string;
      readonly loginTxnId: string;
    }

    async function beginLogin(returnTo = '/ros/7'): Promise<TxnCookie> {
      const res = await fetch(`${base}/auth/login?return_to=${encodeURIComponent(returnTo)}`, {
        redirect: 'manual',
      });
      assert.equal(res.status, 302);
      const setCookie = res.headers.get('set-cookie') ?? '';
      const match = /dealer_auth_txn=([^;,]+)/.exec(setCookie);
      assert.ok(match, 'the login leg must seal a transaction cookie');
      const sealed = decodeURIComponent(match[1]!);
      const payload = openCookiePayload(sealed, env.cookiePassword, { maxAgeSeconds: 600 });
      assert.ok(payload, 'the sealed cookie must open');
      return {
        header: `dealer_auth_txn=${encodeURIComponent(sealed)}`,
        state: String(payload.state),
        oidcNonce: String(payload.oidc_nonce),
        loginTxnId: String(payload.login_txn_id),
      };
    }

    /**
     * A provider port that answers `exchangeCode` with a REAL locally-signed
     * access token plus a matching exchange response. Overrides let one carrier
     * be perturbed at a time, which is the only way to prove the two are
     * compared against each other rather than each read in isolation.
     */
    function fakeExchange(input: {
      subject: string;
      oidcNonce: string;
      sid?: string;
      tokenSid?: string;
      organizationId?: string | null;
      tokenOrganizationId?: string;
      exchangeSubject?: string;
      refreshToken?: string | null;
      exchangeImpersonated?: boolean;
      tokenImpersonated?: boolean;
      throwOnExchange?: boolean;
    }): IdentityProviderPort {
      const unused = (): never => {
        throw new Error('the admission tests use only exchangeCode');
      };
      return {
        buildAuthorizationUrl: () => 'http://127.0.0.1:1/authorize',
        buildLogoutUrl: () => 'http://127.0.0.1:1/logout',
        refreshSession: unused,
        async exchangeCode(): Promise<CodeExchangeResult> {
          if (input.throwOnExchange === true) throw new Error('provider refused the exchange');
          const sid = input.sid ?? 'sid_login_' + randomUUID().slice(0, 8);
          const accessToken = await env.issuer.signAccessToken({
            sub: input.subject,
            sid: input.tokenSid ?? sid,
            org_id: input.tokenOrganizationId ?? testOrganizationId(tenant),
            nonce: input.oidcNonce,
            ...(input.tokenImpersonated === true
              ? { act: { sub: 'workos_staff' }, impersonator: { email: 'staff@workos.test' } }
              : {}),
          });
          return {
            accessToken,
            refreshToken:
              input.refreshToken === undefined ? 'provider-refresh-login' : input.refreshToken,
            providerUserId: input.exchangeSubject ?? input.subject,
            providerSessionId: sid,
            organizationId:
              input.organizationId === undefined
                ? testOrganizationId(tenant)
                : input.organizationId,
            email: 'person@example.test',
            displayName: 'Test Person',
            impersonation:
              input.exchangeImpersonated === true
                ? { impersonated: true, impersonatorEmailPresent: true }
                : NOT_IMPERSONATED,
          };
        },
      };
    }

    async function callback(txn: TxnCookie, state = txn.state) {
      const res = await fetch(`${base}/auth/callback?code=any-code&state=${state}`, {
        headers: { cookie: txn.header },
        redirect: 'manual',
      });
      const text = await res.text();
      /*
       * FBL-020-R4 §1 — the RAW bytes, kept alongside the parsed shape.
       *
       * The indistinguishability test compares refusals to each other, and comparing
       * `JSON.parse` results would let two responses that differ in key order,
       * whitespace or length count as identical. What a caller actually observes is the
       * byte stream and the headers that describe it, so those are what get compared.
       */
      const shape = [
        `status=${res.status}`,
        `content-type=${res.headers.get('content-type') ?? ''}`,
        `content-length=${res.headers.get('content-length') ?? ''}`,
        `set-cookie=${res.headers.get('set-cookie') ?? ''}`,
        `location=${res.headers.get('location') ?? ''}`,
        `body=${text}`,
      ].join('\n');
      // A 302 carries Express's plain-text redirect body, so the parse is
      // attempted rather than assumed — the point of the assertions below is the
      // ERROR shape, and a redirect has none.
      let body: { error?: { code?: string } } | null = null;
      if (text.length > 0) {
        try {
          body = JSON.parse(text) as { error?: { code?: string } };
        } catch {
          body = null;
        }
      }
      return {
        status: res.status,
        setCookie: res.headers.get('set-cookie'),
        location: res.headers.get('location'),
        body,
        rawBody: text,
        shape,
      };
    }

    async function txnRow(loginTxnId: string) {
      const r = await query(
        `SELECT status, failure_reason FROM login_transactions WHERE login_txn_id = $1`,
        [loginTxnId],
      );
      return r.rows[0] as { status: string; failure_reason: unknown };
    }

    async function liveSessionCount(): Promise<number> {
      const r = await query(`SELECT COUNT(*)::int AS n FROM identity_sessions`);
      return Number((r.rows[0] as { n: number }).n);
    }

    /** Any stored provider refresh credential at all, sealed or digested. */
    async function refreshStateCount(): Promise<number> {
      const r = await query(
        `SELECT COUNT(*)::int AS n FROM identity_sessions
          WHERE refresh_state_sealed IS NOT NULL OR refresh_token_hash IS NOT NULL`,
      );
      return Number((r.rows[0] as { n: number }).n);
    }

    // ── the SUCCESSFUL leg, end to end ────────────────────────────────────
    test('a successful callback establishes a session that authenticates the next request', async () => {
      const advisor = await seedActor(env.issuer, {
        tenantId: tenant,
        roles: [ROLES.SERVICE_ADVISOR],
      });
      const txn = await beginLogin('/ros/7');
      useIdentityProviderForTests(
        fakeExchange({ subject: advisor.providerUserId, oidcNonce: txn.oidcNonce }),
      );

      const res = await callback(txn);
      assert.equal(res.status, 302, 'the admitted login redirects');
      assert.equal(res.location, '/ros/7', 'the return location comes from the SERVER row');
      const session = /dealer_session=([^;,]+)/.exec(res.setCookie ?? '');
      assert.ok(session, 'an admitted login sets the session cookie');
      const cookie = `dealer_session=${session[1]!}`;

      assert.equal((await txnRow(txn.loginTxnId)).status, 'succeeded');

      // THE POINT: the cookie authenticates a real API request.
      const served = await fetch(`${base}/api/service/home`, { headers: { cookie } });
      assert.equal(served.status, 200, 'the established session is usable');

      // …and the session is fully bound, with the provider credential in custody
      // exactly once, sealed, with no raw token anywhere in the row.
      const row = (
        await query(
          `SELECT connection_id, issuer, provider_subject, provider_organization_id,
                  provider_session_id, refresh_state_sealed, refresh_token_hash
             FROM identity_sessions`,
        )
      ).rows[0] as Record<string, unknown>;
      for (const column of [
        'connection_id',
        'issuer',
        'provider_subject',
        'provider_organization_id',
        'provider_session_id',
        'refresh_state_sealed',
      ]) {
        assert.notEqual(row[column], null, `a live session must name ${column}`);
      }
      assert.ok(!JSON.stringify(row).includes('provider-refresh-login'), 'no raw refresh token');
    });

    test('the login transaction claim requires the OPAQUE HANDLE and the exact redirect', async () => {
      const advisor = await seedActor(env.issuer, {
        tenantId: tenant,
        roles: [ROLES.SERVICE_ADVISOR],
      });
      const txn = await beginLogin();
      useIdentityProviderForTests(
        fakeExchange({ subject: advisor.providerUserId, oidcNonce: txn.oidcNonce }),
      );
      assert.equal((await callback(txn)).status, 302);

      // A REPLAY of the whole leg: the transaction is terminal, so the claim
      // loses, and the replay is RECORDED rather than silently dropped.
      const replay = await callback(txn);
      assert.equal(replay.status, 401);
      assert.equal(replay.body?.error?.code, 'unauthorized');
      const replayed = await query(
        `SELECT COUNT(*)::int AS n FROM audit_events
          WHERE entity_id = $1 AND event_type = 'identity.login.replayed'`,
        [txn.loginTxnId],
      );
      assert.ok(Number((replayed.rows[0] as { n: number }).n) >= 1, 'the replay is audited');
      assert.equal(await liveSessionCount(), 1, 'the replay minted no second session');
    });

    // ── EVERY refusal ─────────────────────────────────────────────────────
    //
    // Each case perturbs ONE fact, drives the same leg, and asserts the same
    // neutral answer plus the absence of every artefact a login would create.
    const refusals: Array<{
      readonly label: string;
      readonly reason: string;
      /** Applied AFTER the actor is seeded and BEFORE the callback runs. */
      readonly arrange: (subject: string) => Promise<void>;
      /**
       * Applied BEFORE any identity is bound to the connection. Issuer drift needs
       * it: migration 057's `ul_connection_identity_tuple` makes a link and its
       * connection ONE composite fact, so the drift has to exist before the link
       * is bound rather than be introduced underneath it.
       */
      readonly arrangeFirst?: () => Promise<void>;
      /** Perturbs the provider carriers instead of the database, when needed. */
      readonly exchange?: Partial<Parameters<typeof fakeExchange>[0]>;
    }> = [
      {
        label: 'an INACTIVE tenant',
        reason: 'identity_not_admitted',
        arrange: async () => {
          await fixtureAuthorizationStateWrite(
            'simulate-authorization-drift',
            `UPDATE tenants SET status = 'suspended' WHERE tenant_id = $1`,
            [tenant],
          );
        },
      },
      {
        label: 'a tenant whose effective window has CLOSED',
        reason: 'identity_not_admitted',
        arrange: async () => {
          await fixtureAuthorizationStateWrite(
            'simulate-authorization-drift',
            `UPDATE tenants
                SET effective_from = NOW() - INTERVAL '2 days',
                    effective_to = NOW() - INTERVAL '1 day'
              WHERE tenant_id = $1`,
            [tenant],
          );
        },
      },
      {
        label: 'an ARCHIVED organization hierarchy beneath an active tenant',
        reason: 'identity_not_admitted',
        arrange: async () => {
          await fixtureAuthorizationStateWrite(
            'simulate-authorization-drift',
            `UPDATE legal_entities SET status = 'archived' WHERE tenant_id = $1`,
            [tenant],
          );
        },
      },
      {
        /*
         * FBL-020-R4 correction F5. The admission SQL used to carry a SEPARATE
         * `EXISTS` for the dealer group, and the module header presented the
         * hierarchy as two load-bearing facts. It was one: the legal-entity clause
         * joins the entity to a dealer group of the SAME tenant under the same three
         * conditions, so it subsumes the dealer-group clause and no state could ever
         * fail only on the removed one. This scenario is what makes the subsumption
         * a tested property rather than an argument in a comment — the dealer groups
         * are archived, the legal entities are left ACTIVE, and the login must still
         * be refused, through the join inside the surviving clause.
         */
        label: 'an ARCHIVED DEALER GROUP with the legal entities left active',
        reason: 'identity_not_admitted',
        arrange: async () => {
          await fixtureAuthorizationStateWrite(
            'simulate-authorization-drift',
            `UPDATE dealer_groups SET status = 'archived' WHERE tenant_id = $1`,
            [tenant],
          );
        },
      },
      {
        label: 'a UserLink whose window has not OPENED yet',
        reason: 'identity_not_admitted',
        arrange: async (subject) => {
          await fixtureAuthorizationStateWrite(
            'simulate-authorization-drift',
            `UPDATE user_links SET effective_from = NOW() + INTERVAL '1 day'
              WHERE provider_user_id = $1`,
            [subject],
          );
        },
      },
      {
        label: 'a UserLink whose window has CLOSED (the offboarding shape)',
        reason: 'identity_not_admitted',
        arrange: async (subject) => {
          await fixtureAuthorizationStateWrite(
            'simulate-authorization-drift',
            `UPDATE user_links
                SET effective_from = NOW() - INTERVAL '2 days',
                    effective_to = NOW() - INTERVAL '1 day'
              WHERE provider_user_id = $1`,
            [subject],
          );
        },
      },
      {
        label: 'a DISABLED connection',
        reason: 'identity_not_admitted',
        arrange: async () => {
          await fixtureAuthorizationStateWrite(
            'simulate-authorization-drift',
            `UPDATE identity_provider_connections SET status = 'disabled' WHERE tenant_id = $1`,
            [tenant],
          );
        },
      },
      {
        label: 'a connection whose window has not OPENED yet',
        reason: 'identity_not_admitted',
        arrange: async () => {
          await fixtureAuthorizationStateWrite(
            'simulate-authorization-drift',
            `UPDATE identity_provider_connections
                SET effective_from = NOW() + INTERVAL '1 day'
              WHERE tenant_id = $1`,
            [tenant],
          );
        },
      },
      {
        label: 'a connection whose window has CLOSED',
        reason: 'identity_not_admitted',
        arrange: async () => {
          await fixtureAuthorizationStateWrite(
            'simulate-authorization-drift',
            `UPDATE identity_provider_connections
                SET effective_from = NOW() - INTERVAL '2 days',
                    effective_to = NOW() - INTERVAL '1 day'
              WHERE tenant_id = $1`,
            [tenant],
          );
        },
      },
      {
        label: 'ISSUER DRIFT — the connection does not name the CONFIGURED issuer',
        reason: 'identity_not_admitted',
        arrangeFirst: async () => {
          await fixtureAuthorizationStateWrite(
            'simulate-authorization-drift',
            `UPDATE identity_provider_connections SET issuer = issuer || '/drifted'
              WHERE tenant_id = $1`,
            [tenant],
          );
        },
        arrange: async () => undefined,
      },
      {
        label: 'the exchange naming a DIFFERENT provider user than the token',
        reason: 'exchange_token_mismatch',
        arrange: async () => undefined,
        exchange: { exchangeSubject: 'user_somebody_else' },
      },
      {
        label: 'the exchange naming a DIFFERENT organization than the token',
        reason: 'exchange_token_mismatch',
        arrange: async () => undefined,
        exchange: { organizationId: 'org_another_customer' },
      },
      {
        label: 'the exchange naming a DIFFERENT provider session than the token',
        reason: 'exchange_token_mismatch',
        arrange: async () => undefined,
        exchange: { sid: 'sid_exchange_one', tokenSid: 'sid_token_two' },
      },
      {
        label: 'the exchange volunteering NO organization at all',
        reason: 'exchange_token_mismatch',
        arrange: async () => undefined,
        exchange: { organizationId: null },
      },
      {
        label: 'IMPERSONATION asserted by the exchange alone',
        reason: 'impersonation_detected',
        arrange: async () => undefined,
        exchange: { exchangeImpersonated: true },
      },
      {
        label: 'IMPERSONATION asserted by the TOKEN alone',
        reason: 'impersonation_detected',
        arrange: async () => undefined,
        exchange: { tokenImpersonated: true },
      },
    ];

    for (const scenario of refusals) {
      test(`refused, neutrally and with nothing in custody: ${scenario.label}`, async () => {
        if (scenario.arrangeFirst !== undefined) await scenario.arrangeFirst();
        const advisor = await seedActor(env.issuer, {
          tenantId: tenant,
          roles: [ROLES.SERVICE_ADVISOR],
        });
        const txn = await beginLogin();
        await scenario.arrange(advisor.providerUserId);
        useIdentityProviderForTests(
          fakeExchange({
            subject: advisor.providerUserId,
            oidcNonce: txn.oidcNonce,
            ...(scenario.exchange ?? {}),
          }),
        );

        const res = await callback(txn);
        // ONE neutral answer for every condition above.
        assert.equal(res.status, 401, scenario.label);
        assert.equal(res.body?.error?.code, 'unauthorized', scenario.label);
        assert.ok(
          !/dealer_session=[^;,]+/.test((res.setCookie ?? '').replace(/dealer_session=;/, '')),
          'a refused login must set NO session cookie',
        );
        // NOTHING was taken into custody: no session row at all, and therefore no
        // sealed provider refresh credential and no replay digest.
        assert.equal(await liveSessionCount(), 0, 'a refused login creates no session');
        assert.equal(await refreshStateCount(), 0, 'and stores no provider credential');
        // The reason is recorded on the row — where an operator can see it — and
        // nowhere a caller can read it.
        const row = await txnRow(txn.loginTxnId);
        assert.equal(row.status, 'failed');
        assert.equal(row.failure_reason, scenario.reason, scenario.label);
        const rendered = JSON.stringify(res.body ?? {});
        assert.ok(!rendered.includes(scenario.reason), 'the reason never reaches the response');
      });
    }

    /**
     * FBL-020-R4 §1 — EVERY refusal, BYTE-IDENTICAL, with nothing in custody.
     *
     * §1 requires every refusal to be neutral and INDISTINGUISHABLE. The R4 version of
     * this test sampled `refusals.slice(0, 6)` and compared `JSON.parse` results — so it
     * left nine scenarios unmeasured (every connection-window case, issuer drift, all
     * four carrier mismatches and both impersonation branches), and it would have called
     * two responses identical that differed in key order, whitespace or length. Neither
     * of those is what a caller observes.
     *
     * This drives EVERY scenario in the table and compares the RAW BYTES plus the headers
     * that describe them: status, content type, content length, `Set-Cookie`, `Location`
     * and the body verbatim. It also asserts, per scenario, that nothing was taken into
     * custody — no session row, no session cookie, no stored provider credential — because
     * a refusal that answered neutrally and still kept the refresh token would satisfy an
     * indistinguishability test and fail the requirement behind it.
     *
     * NOTHING IS SKIPPED as unreachable AMONG THE ADMISSION REFUSALS. The scenarios the
     * order enumerates are held against the table by label below, so deleting one is a
     * failure rather than a shorter loop.
     *
     * THE THREE INTERNAL REASONS, STATED ACCURATELY. The callback can also reach
     * `provider_exchange_failed`, `token_verification_failed` and
     * `session_establishment_failed`. None of them is a refusal of an admission decision —
     * they are two provider faults and a local write failure — so none belongs in the
     * indistinguishability table above. What this comment used to claim about their
     * coverage was WRONG IN TWO WAYS, and both are corrected here rather than left:
     *
     *   · it cited `tests/identity-lifecycle-audit.test.ts` ("every provider-side failure
     *     reaches exactly ONE terminal state and ONE audit event") as covering all three.
     *     That test drives REAUTHENTICATION transactions — `startStepUp`,
     *     `failReauthentication`, `identity.reauthentication.failed` — which is a DIFFERENT
     *     TRANSACTION KIND from the login transactions this file is about; and
     *   · that test's reason list is provider_exchange_failed, impersonation_detected,
     *     token_verification_failed, identity_not_admitted, binding_mismatch. It does not
     *     contain `session_establishment_failed` at all.
     *
     * What is actually true on the LOGIN leg:
     *   · `token_verification_failed` — terminal WITH ITS REASON, and unable to become
     *     succeeded afterwards, by "a claimed transaction that fails is terminal WITH A
     *     REASON and can never become succeeded" in `tests/identity-boundary.test.ts`; and
     *     exactly one `identity.login.failed` event by "the audit inventory is complete,
     *     and every transition in it writes its event" in
     *     `tests/identity-lifecycle-audit.test.ts`.
     *   · `provider_exchange_failed` — driven on the login leg only as a REFUSED
     *     re-termination of an already-succeeded transaction (same
     *     `tests/identity-boundary.test.ts` battery), which proves absorption, not
     *     terminalization.
     *   · `session_establishment_failed` — NOT COVERED BY ANY TEST. The route writes it
     *     (`apps/api/src/routes/auth.ts`); no assertion anywhere reads it. That residue is
     *     declared in `docs/identity/KNOWN-LIMITATIONS.md` under "Open at FBL-020-R5
     *     submission" rather than hidden behind this comment.
     */
    test('the refusals are INDISTINGUISHABLE from one another at the wire — every one of them', async () => {
      // The order's enumeration, held against the table. A scenario removed from
      // `refusals` fails HERE rather than quietly reducing the coverage.
      const enumeratedByTheOrder = [
        'an INACTIVE tenant',
        'a UserLink whose window has not OPENED yet',
        'a UserLink whose window has CLOSED (the offboarding shape)',
        'a DISABLED connection',
        'a connection whose window has not OPENED yet',
        'a connection whose window has CLOSED',
        'ISSUER DRIFT — the connection does not name the CONFIGURED issuer',
        'the exchange naming a DIFFERENT provider user than the token',
        'the exchange naming a DIFFERENT organization than the token',
        'the exchange naming a DIFFERENT provider session than the token',
        'IMPERSONATION asserted by the exchange alone',
        'IMPERSONATION asserted by the TOKEN alone',
      ];
      const labels = refusals.map((r) => r.label);
      for (const label of enumeratedByTheOrder) {
        assert.ok(labels.includes(label), `§1 requires the refusal "${label}" to be covered`);
      }
      assert.equal(new Set(labels).size, labels.length, 'no scenario is listed twice');
      // All three internal reason codes an admission refusal can produce are present, so
      // "identical at the wire" is being asserted across genuinely different causes.
      assert.deepEqual([...new Set(refusals.map((r) => r.reason))].sort(), [
        'exchange_token_mismatch',
        'identity_not_admitted',
        'impersonation_detected',
      ]);

      const shapes = new Map<string, string[]>();
      for (const scenario of refusals) {
        await resetDatabase();
        tenant = randomUUID();
        await seedTenantIdentity(tenant);
        await seedRooftopIdentity(tenant, randomUUID());
        if (scenario.arrangeFirst !== undefined) await scenario.arrangeFirst();
        const advisor = await seedActor(env.issuer, {
          tenantId: tenant,
          roles: [ROLES.SERVICE_ADVISOR],
        });
        const txn = await beginLogin();
        await scenario.arrange(advisor.providerUserId);
        useIdentityProviderForTests(
          fakeExchange({
            subject: advisor.providerUserId,
            oidcNonce: txn.oidcNonce,
            ...(scenario.exchange ?? {}),
          }),
        );
        const res = await callback(txn);

        // NOTHING IN CUSTODY, per scenario — checked here and not only in aggregate,
        // so the message names the scenario that broke it.
        assert.equal(await liveSessionCount(), 0, `${scenario.label}: created a session`);
        assert.equal(
          await refreshStateCount(),
          0,
          `${scenario.label}: stored a provider credential`,
        );
        assert.ok(
          !/dealer_session=[^;,]/.test(res.setCookie ?? ''),
          `${scenario.label}: set a session cookie`,
        );
        // …and the row still records the true reason, which is what makes the wire
        // neutrality a property of the RESPONSE rather than of the system forgetting.
        const row = await txnRow(txn.loginTxnId);
        assert.equal(row.status, 'failed', scenario.label);
        assert.equal(row.failure_reason, scenario.reason, scenario.label);

        const sharing = shapes.get(res.shape) ?? [];
        sharing.push(scenario.label);
        shapes.set(res.shape, sharing);
      }

      assert.equal(
        shapes.size,
        1,
        'every refusal must answer with the SAME bytes; distinct answers observed:\n' +
          [...shapes].map(([shape, who]) => `${who.join(' + ')} =>\n${shape}`).join('\n---\n'),
      );
      const only = [...shapes.keys()][0] as string;
      // …and the one shape they share is genuinely a neutral refusal, not an
      // accidentally uniform success.
      assert.match(only, /^status=401\n/, `the shared answer must be a 401:\n${only}`);
      assert.ok(!/dealer_session=/.test(only), 'the shared answer must carry no session cookie');
      assert.ok(!/location=\/[^\n]/.test(only), 'the shared answer must not redirect anywhere');
      for (const reason of new Set(refusals.map((r) => r.reason))) {
        assert.ok(!only.includes(reason), `the shared answer leaks the reason ${reason}`);
      }
      assert.equal(
        (shapes.get(only) ?? []).length,
        refusals.length,
        'every scenario in the table must have been driven',
      );
    });

    // ── the carrier comparison, as a pure function ────────────────────────
    test('exchangeMatchesVerifiedToken treats ABSENCE as disagreement, never as agreement', () => {
      const token: VerifiedAccessToken = {
        providerUserId: 'user_1',
        providerSessionId: 'sid_1',
        organizationId: 'org_1',
        authTime: new Date(),
        issuedAt: new Date(),
        expiresAt: new Date(Date.now() + 300_000),
        roleHints: [],
        nonceDigest: null,
        impersonation: NOT_IMPERSONATED,
      };
      const agreeing = {
        providerUserId: 'user_1',
        providerSessionId: 'sid_1' as string | null,
        organizationId: 'org_1' as string | null,
        impersonation: NOT_IMPERSONATED,
      };
      assert.equal(exchangeMatchesVerifiedToken(agreeing, token), true);
      assert.equal(
        exchangeMatchesVerifiedToken({ ...agreeing, providerSessionId: null }, token),
        false,
        'no provider session id cannot corroborate one',
      );
      assert.equal(
        exchangeMatchesVerifiedToken({ ...agreeing, organizationId: null }, token),
        false,
        'no organization cannot corroborate one',
      );
      assert.equal(
        exchangeMatchesVerifiedToken(
          {
            ...agreeing,
            impersonation: { impersonated: false, impersonatorEmailPresent: true },
          },
          token,
        ),
        false,
        'one carrier classifying an impersonator while the other does not is a mismatch',
      );
    });

    // ── the admission service itself, called directly ─────────────────────
    test('admitLoginAndEstablishSession refuses a PENDING link and creates no privilege', async () => {
      // A first login of an unknown identity: the observation creates a PENDING
      // claim, and admission refuses it. Nothing about that is a session.
      const subject = 'user_pending_' + randomUUID().slice(0, 8);
      const verified: VerifiedAccessToken = {
        providerUserId: subject,
        providerSessionId: 'sid_pending',
        organizationId: testOrganizationId(tenant),
        authTime: new Date(),
        issuedAt: new Date(),
        expiresAt: new Date(Date.now() + 300_000),
        roleHints: [],
        nonceDigest: null,
        impersonation: NOT_IMPERSONATED,
      };
      const admission = await admitLoginAndEstablishSession({
        session: { ttlSeconds: 3600, cookiePassword: env.cookiePassword },
        trustedIssuer: env.issuer.issuer,
        exchanged: {
          accessToken: 'unused',
          refreshToken: 'provider-refresh-pending',
          providerUserId: subject,
          providerSessionId: 'sid_pending',
          organizationId: testOrganizationId(tenant),
          email: null,
          displayName: null,
          impersonation: NOT_IMPERSONATED,
        },
        verified,
      });
      assert.equal(admission.admitted, false);
      assert.equal(await liveSessionCount(), 0);
      const link = (
        await query(`SELECT status FROM user_links WHERE provider_user_id = $1`, [subject])
      ).rows[0] as { status: string };
      assert.equal(link.status, 'pending', 'the observation left a PENDING claim, nothing more');
      const bindings = await query(
        `SELECT COUNT(*)::int AS n FROM role_bindings rb
           JOIN user_links ul ON ul.user_link_id = rb.user_link_id
          WHERE ul.provider_user_id = $1`,
        [subject],
      );
      assert.equal(Number((bindings.rows[0] as { n: number }).n), 0);
      await bootstrapAdministrator(tenant); // the activation path exists; login never takes it
    });

    /**
     * FBL-020-R4 §7 — THE GAP THE MUTATION-KILL RUN FOUND.
     *
     * The test above proves the FIRST login of an unknown identity is refused, but it
     * cannot prove WHICH clause refused it: the observation creates the pending claim
     * UNBOUND, so `admitUserLink`'s binding clause turns it away whatever its status.
     * Widening `ul.status = 'activated'` to admit `'pending'` therefore changed nothing,
     * and `scripts/mutation-kill.ts` reported that mutation as SURVIVING — a control
     * with no test behind it, which is the exact defect class R4 §7 exists to remove.
     *
     * A BOUND PENDING LINK IS NOT HYPOTHETICAL. Migration 057 §1 binds a link from its
     * tenant's single active connection WITHOUT regard to status — deliberately, because
     * binding is a statement about PROVENANCE and activation is a statement about
     * AUTHORITY — so after any upgrade a pending link carries a complete tuple. The
     * populated pre-057 fixture asserts precisely that shape, in
     * `ul_a2_pending_link_stays_pending`, with its connection set.
     *
     * So this is the row the status predicate actually protects against, and it is the
     * one the suite was missing: an identity no administrator ever activated, fully
     * bound, presenting a valid token.
     */
    test('a BOUND but PENDING link is refused — binding is provenance, not authority', async () => {
      const subject = 'user_bound_pending_' + randomUUID().slice(0, 8);
      const userLinkId = randomUUID();
      // The post-057 shape, written through the declared fixture primitive: pending,
      // never activated, and bound to its tenant's one active connection.
      await fixtureAuthorizationStateWrite(
        'seed-authorization-state',
        `INSERT INTO user_links
           (user_link_id, actor_scope, tenant_id, provider, provider_user_id, status,
            connection_id, issuer, provider_organization_id)
         SELECT $1, 'dealership', $2, 'workos', $3, 'pending',
                c.connection_id, c.issuer, c.provider_organization_id
           FROM identity_provider_connections c
          WHERE c.tenant_id = $2 AND c.provider = 'workos' AND c.status = 'active'
          LIMIT 1`,
        [userLinkId, tenant, subject],
      );
      const seeded = (
        await query(
          `SELECT status, connection_id IS NOT NULL AS bound FROM user_links
            WHERE user_link_id = $1`,
          [userLinkId],
        )
      ).rows[0] as { status: string; bound: boolean };
      assert.equal(seeded.status, 'pending');
      assert.equal(
        seeded.bound,
        true,
        'the fixture must be the BOUND pending shape, or this test proves nothing',
      );

      const verified: VerifiedAccessToken = {
        providerUserId: subject,
        providerSessionId: 'sid_bound_pending',
        organizationId: testOrganizationId(tenant),
        authTime: new Date(),
        issuedAt: new Date(),
        expiresAt: new Date(Date.now() + 300_000),
        roleHints: [],
        nonceDigest: null,
        impersonation: NOT_IMPERSONATED,
      };
      const admission = await admitLoginAndEstablishSession({
        session: { ttlSeconds: 3600, cookiePassword: env.cookiePassword },
        trustedIssuer: env.issuer.issuer,
        exchanged: {
          accessToken: 'unused',
          refreshToken: 'provider-refresh-bound-pending',
          providerUserId: subject,
          providerSessionId: 'sid_bound_pending',
          organizationId: testOrganizationId(tenant),
          email: null,
          displayName: null,
          impersonation: NOT_IMPERSONATED,
        },
        verified,
      });

      assert.equal(admission.admitted, false, 'a link nobody activated must not log in');
      assert.equal(await liveSessionCount(), 0);
      assert.equal(
        await refreshStateCount(),
        0,
        'and no provider credential is taken into custody',
      );
      const after = (
        await query(`SELECT status, activated_at FROM user_links WHERE user_link_id = $1`, [
          userLinkId,
        ])
      ).rows[0] as { status: string; activated_at: Date | null };
      assert.equal(after.status, 'pending', 'the refusal does not activate what it refused');
      assert.equal(after.activated_at, null);
    });

    // ── FBL-020-R5 §1.5: THE THREE ENDINGS THAT USED TO LEAVE A ROW IN FLIGHT ──
    //
    // §1.5 requires EVERY callback carrying a valid sealed transaction handle to go
    // through the server-authoritative claim path, and every real transaction to
    // finish with ONE explained terminal state and ONE terminal audit event. Three
    // shapes did not, and each is driven below over real HTTP:
    //
    //   (a) a provider `error` callback — an authorization server that refuses
    //       redirects here with the original `state` and no `code`;
    //   (b) a callback with no authorization code at all;
    //   (c) a transaction that runs out of time WHILE the provider exchange is in
    //       flight, which is the one case where the leg does everything right and
    //       still must hand out nothing.
    //
    // (a) and (b) were refused by the pre-claim guard, so their transactions sat at
    // `pending` until a sweep eventually aged them — the wrong reason, hours late,
    // and `identity.login.expired` where the truth was "the provider said no".

    /** Every audit row written against one login transaction, oldest first. */
    async function loginEvents(loginTxnId: string): Promise<string[]> {
      const r = await query(
        `SELECT event_type FROM audit_events
          WHERE entity_type = 'login_transaction' AND entity_id = $1
          ORDER BY created_at, event_id`,
        [loginTxnId],
      );
      return (r.rows as Array<{ event_type: string }>).map((x) => x.event_type);
    }

    /** The whole transaction row, so a test can assert what was NOT written too. */
    async function fullTxnRow(loginTxnId: string) {
      const r = await query(`SELECT * FROM login_transactions WHERE login_txn_id = $1`, [
        loginTxnId,
      ]);
      return r.rows[0] as Record<string, unknown>;
    }

    test('a provider ERROR callback reaches its own terminal state, and the provider message never lands', async () => {
      await seedActor(env.issuer, { tenantId: tenant, roles: [ROLES.SERVICE_ADVISOR] });
      const txn = await beginLogin();
      // No provider port is installed on purpose: an error callback must never
      // reach an exchange, and a fake that threw would hide that.

      const res = await fetch(
        `${base}/auth/callback?error=access_denied&error_description=${encodeURIComponent(
          'The user denied the request',
        )}&state=${txn.state}`,
        { headers: { cookie: txn.header }, redirect: 'manual' },
      );
      const text = await res.text();
      assert.equal(res.status, 401);
      assert.equal(
        (JSON.parse(text) as { error?: { code?: string } }).error?.code,
        'unauthorized',
        'the answer outward is the same neutral refusal as every other one',
      );
      assert.equal(await liveSessionCount(), 0, 'and nothing was established');

      const row = await fullTxnRow(txn.loginTxnId);
      assert.equal(row.status, 'failed');
      assert.equal(
        row.failure_reason,
        'provider_error_callback',
        'the transaction says WHY, in the server vocabulary',
      );
      assert.notEqual(row.consumed_at, null, 'and it is terminal, not merely annotated');
      assert.notEqual(row.claimed_at, null, 'it went through the CLAIM path, not around it');

      // EXACTLY ONE terminal audit event, and it is not an expiry.
      const events = await loginEvents(txn.loginTxnId);
      assert.deepEqual(events, [
        'identity.login.started',
        'identity.login.claimed',
        'identity.login.failed',
      ]);

      // The provider's own strings are caller-influenced text: they may not reach
      // the row, the audit trail or the response.
      const details = await query(
        `SELECT details::text AS d FROM audit_events
          WHERE entity_type = 'login_transaction' AND entity_id = $1`,
        [txn.loginTxnId],
      );
      const written = JSON.stringify(row) + JSON.stringify(details.rows) + text;
      assert.ok(!written.includes('access_denied'), 'the provider error code is not stored');
      assert.ok(!written.includes('denied the request'), 'nor its description');
    });

    test('a callback carrying NO authorization code is terminal, and distinct from a provider error', async () => {
      await seedActor(env.issuer, { tenantId: tenant, roles: [ROLES.SERVICE_ADVISOR] });
      const txn = await beginLogin();

      const res = await fetch(`${base}/auth/callback?state=${txn.state}`, {
        headers: { cookie: txn.header },
        redirect: 'manual',
      });
      assert.equal(res.status, 401);
      assert.equal(await liveSessionCount(), 0);

      const row = await fullTxnRow(txn.loginTxnId);
      assert.equal(row.status, 'failed');
      assert.equal(
        row.failure_reason,
        'authorization_code_missing',
        'a malformed callback and a refused one are different operational facts',
      );
      assert.deepEqual(await loginEvents(txn.loginTxnId), [
        'identity.login.started',
        'identity.login.claimed',
        'identity.login.failed',
      ]);
    });

    test('a transaction that EXPIRES during a slow provider exchange ends terminally and hands out nothing', async () => {
      const advisor = await seedActor(env.issuer, {
        tenantId: tenant,
        roles: [ROLES.SERVICE_ADVISOR],
      });
      const txn = await beginLogin();

      /*
       * THE INTERLEAVING, MADE DETERMINISTIC.
       *
       * The race this proves is a real one — a provider exchange that takes longer
       * than the transaction's remaining life, with the worker's expiry sweep
       * landing in between — and a test that arranged it with a sleep would prove
       * only that the sleep was long enough. So the sweep is run INSIDE the fake
       * exchange: the transaction is already `consuming`, the exchange has begun and
       * has not returned, and the sweep ages the row from underneath the leg. There
       * is no window in which this can accidentally not happen.
       */
      let sweptDuringExchange = 0;
      const honest = fakeExchange({ subject: advisor.providerUserId, oidcNonce: txn.oidcNonce });
      useIdentityProviderForTests({
        ...honest,
        async exchangeCode(input) {
          await query(
            `UPDATE login_transactions
                SET created_at = NOW() - INTERVAL '2 hours', expires_at = NOW() - INTERVAL '1 hour'
              WHERE login_txn_id = $1`,
            [txn.loginTxnId],
          );
          sweptDuringExchange = await expireStaleLoginTransactions();
          return honest.exchangeCode(input);
        },
      });

      const res = await callback(txn);
      assert.ok(sweptDuringExchange >= 1, 'the sweep must actually have aged the transaction');

      // The login FAILS CLOSED: no session cookie, and the same neutral answer.
      assert.equal(res.status, 401);
      assert.equal(res.body?.error?.code, 'unauthorized');
      assert.ok(
        !/dealer_session=[^;,]+/.test((res.setCookie ?? '').replace(/dealer_session=;/, '')),
        'an expired transaction may not hand out a session cookie',
      );

      // ONE explained terminal state — the expiry, which happened first — and the
      // success transition did NOT overwrite it.
      const row = await fullTxnRow(txn.loginTxnId);
      assert.equal(row.status, 'failed');
      assert.equal(row.failure_reason, 'expired');

      // ONE terminal audit event, and it is the expiry.
      const events = await loginEvents(txn.loginTxnId);
      assert.deepEqual(events, [
        'identity.login.started',
        'identity.login.claimed',
        'identity.login.expired',
      ]);
      assert.equal(
        events.filter((e) => e === 'identity.login.succeeded').length,
        0,
        'a login that handed out nothing was not a success',
      );

      /*
       * …and the session the admission had ALREADY established — the exchange
       * succeeded, so it exists — is revoked rather than left live. This is the half
       * that matters most: the row was created before the leg discovered it had run
       * out of time, so "fail closed" has to mean destroying it, not just answering
       * 401.
       */
      const session = (
        await query(
          `SELECT revoked_at, revoked_reason, refresh_state_sealed, refresh_token_hash
             FROM identity_sessions`,
        )
      ).rows[0] as Record<string, unknown> | undefined;
      assert.ok(session !== undefined, 'the admission did establish a session to revoke');
      assert.notEqual(session.revoked_at, null, 'and it must not be left live');
      assert.equal(session.revoked_reason, 'login_transaction_not_consuming');
      assert.equal(session.refresh_state_sealed, null, 'its provider credential is destroyed');
      assert.equal(session.refresh_token_hash, null);
      assert.equal(await refreshStateCount(), 0);
    });

    /**
     * FBL-020-R5 §1.11 — THE SUCCESS NAMES WHO GOT IN.
     *
     * `GET /auth/login` opens the transaction knowing a purpose, a redirect, a return
     * location and a TTL — no tenant and no user, because a browser login has not
     * identified anybody yet. The success transition RETURNed those NULLs straight to
     * the audit writer, so every successful browser login was recorded against the NIL
     * tenant with `actor_user_id = NULL`: the one lifecycle event that answers "who was
     * admitted" answered nobody, and could not be found by filtering a tenant's trail.
     */
    test('the successful-login audit event names the ADMITTED tenant and user', async () => {
      const advisor = await seedActor(env.issuer, {
        tenantId: tenant,
        roles: [ROLES.SERVICE_ADVISOR],
      });
      const txn = await beginLogin('/ros/11');
      useIdentityProviderForTests(
        fakeExchange({ subject: advisor.providerUserId, oidcNonce: txn.oidcNonce }),
      );
      assert.equal((await callback(txn)).status, 302);

      const session = (
        await query(`SELECT tenant_id, user_link_id, connection_id FROM identity_sessions`)
      ).rows[0] as Record<string, unknown>;

      // (1) the transaction row itself now carries the admitted identity
      const row = await fullTxnRow(txn.loginTxnId);
      assert.equal(row.status, 'succeeded');
      assert.equal(String(row.tenant_id), tenant);
      assert.equal(String(row.user_link_id), String(session.user_link_id));
      assert.equal(String(row.connection_id), String(session.connection_id));

      // (2) …and so does the audit event, which is what an operator actually reads
      const succeeded = await query(
        `SELECT tenant_id, actor_user_id FROM audit_events
          WHERE entity_type = 'login_transaction' AND entity_id = $1
            AND event_type = 'identity.login.succeeded'`,
        [txn.loginTxnId],
      );
      assert.equal(succeeded.rows.length, 1, 'exactly one success event');
      const event = succeeded.rows[0] as { tenant_id: unknown; actor_user_id: unknown };
      assert.equal(
        String(event.tenant_id),
        tenant,
        'the success lands in the ADMITTED tenant trail, not under the nil tenant',
      );
      assert.equal(
        String(event.actor_user_id),
        String(session.user_link_id),
        'and it names the user link that was admitted',
      );
      assert.notEqual(
        String(event.tenant_id),
        '00000000-0000-0000-0000-000000000000',
        'the nil tenant is what this clause exists to stop',
      );
    });
  },
);
