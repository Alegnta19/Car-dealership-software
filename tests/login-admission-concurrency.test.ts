import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, beforeEach, describe, test } from 'node:test';
import {
  fixtureAuthorizationStateWrite,
  resetDatabase,
  seedActor,
  seedRooftopIdentity,
  seedTenantIdentity,
  skipIntegration,
  startIdentityTestEnv,
  testOrganizationId,
  type IdentityTestEnv,
} from '@dealer/test-kit';
import { closePool, getPool, query, type Executor } from '@dealer/database';
import { ROLES } from '@dealer/contracts';
import {
  NOT_IMPERSONATED,
  openCookiePayload,
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
 * FBL-020-R5 §1.4 — ADMISSION CANNOT BE RACED, PROVEN DETERMINISTICALLY.
 *
 * ── the defect ─────────────────────────────────────────────────────────────
 *
 * R4 decided login admission in one transaction, COMMITTED it, and then inserted
 * the session — with the provider refresh credential sealed into it — in a second
 * transaction. An administrator's suspension, disablement or archival landing
 * between those two commits produced a session anyway. Worse, the admission read
 * nothing under a lock, so under READ COMMITTED even a change committed while the
 * admission was still running was invisible to it.
 *
 * ── how this battery pins the interleaving ─────────────────────────────────
 *
 * NOT WITH SLEEPS, AND NOT WITH TIMING LUCK. Every scenario below:
 *
 *   1. opens a DEDICATED database connection, `BEGIN`s, and issues the
 *      administrator's write — leaving it UNCOMMITTED, which holds a row-exclusive
 *      lock on exactly the row the admission must read;
 *   2. fires the real `GET /auth/callback` WITHOUT awaiting it;
 *   3. WAITS UNTIL POSTGRES ITSELF REPORTS A LOCK REQUEST THAT IS NOT GRANTED
 *      (`pg_locks.granted = false`). That is the ordering being pinned: the test
 *      does not continue until the database says the login is queued behind the
 *      administrator. A login that never blocks fails the assertion rather than
 *      racing past it;
 *   4. COMMITs the administrator's write, releasing the login;
 *   5. asserts the login is REFUSED and that nothing at all was taken into
 *      custody — no session row, no sealed refresh state, no session cookie.
 *
 * ── what each scenario does and does not distinguish ───────────────────────
 *
 * Stated exactly, because "these prove the fix" would be too strong for some of
 * them. The TENANT, CONNECTION and HIERARCHY scenarios are the discriminating
 * ones: without the `FOR SHARE` claims R5 §1.3 added, the login does not block at
 * all, reads a stale snapshot, and creates a session — which is measured in this
 * order's revert-proof. The LINK scenarios (deactivation, relink, window closure)
 * are REGRESSION coverage: they were already refused before this order, because
 * the observation's own `UPDATE` serialises them and the link admission then
 * re-reads. They are here because §1.4 names them and because the property must
 * stay true, not because they fail against the previous revision.
 */
describe(
  'login admission cannot be raced (FBL-020-R5 §1.4)',
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

    interface TxnCookie {
      readonly header: string;
      readonly state: string;
      readonly oidcNonce: string;
      readonly loginTxnId: string;
    }

    async function beginLogin(): Promise<TxnCookie> {
      const res = await fetch(`${base}/auth/login`, { redirect: 'manual' });
      assert.equal(res.status, 302);
      const match = /dealer_auth_txn=([^;,]+)/.exec(res.headers.get('set-cookie') ?? '');
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

    const PROVIDER_REFRESH_TOKEN = 'provider-refresh-race';

    function fakeExchange(subject: string, oidcNonce: string): IdentityProviderPort {
      const unused = (): never => {
        throw new Error('the concurrency tests use only exchangeCode');
      };
      return {
        buildAuthorizationUrl: () => 'http://127.0.0.1:1/authorize',
        buildLogoutUrl: () => 'http://127.0.0.1:1/logout',
        refreshSession: unused,
        async exchangeCode(): Promise<CodeExchangeResult> {
          const sid = 'sid_race_' + randomUUID().slice(0, 8);
          return {
            accessToken: await env.issuer.signAccessToken({
              sub: subject,
              sid,
              org_id: testOrganizationId(tenant),
              nonce: oidcNonce,
            }),
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

    function callback(txn: TxnCookie): Promise<{ status: number; setCookie: string | null }> {
      return fetch(`${base}/auth/callback?code=any-code&state=${txn.state}`, {
        headers: { cookie: txn.header },
        redirect: 'manual',
      }).then(async (res) => {
        await res.text();
        return { status: res.status, setCookie: res.headers.get('set-cookie') };
      });
    }

    /**
     * Blocks until PostgreSQL reports an UNGRANTED lock request IN THIS DATABASE,
     * which is the login queued behind the administrator's uncommitted write.
     * Returns false if none appears within the bound — which means the login did NOT
     * queue, and every scenario treats that as a failure rather than as a reason to
     * hurry on.
     *
     * SCOPED TO THIS DATABASE, not to this exact row. It is an observation that the
     * login serialised, not a proof of which lock it serialised on; the refusal
     * assertions in each scenario are what carry the security property, and they
     * cannot be satisfied by an unrelated lock. Naming the row as well would mean
     * resolving relation and tuple identifiers from `pg_locks`, which buys precision
     * this battery does not depend on.
     */
    /** How many lock requests PostgreSQL currently reports as NOT granted, in this database. */
    async function blockedLockRequests(): Promise<number> {
      const r = await query(
        `SELECT COUNT(*)::int AS n
           FROM pg_locks
          WHERE NOT granted
            AND pid <> pg_backend_pid()
            AND (database IS NULL
                 OR database = (SELECT oid FROM pg_database WHERE datname = current_database()))`,
      );
      return Number((r.rows[0] as { n: number }).n);
    }

    async function waitForBlockedLockRequest(timeoutMs = 5_000): Promise<boolean> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if ((await blockedLockRequests()) > 0) return true;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return false;
    }

    /**
     * THE OTHER DIRECTION OF THE SAME BARRIER, and the one the lock-MODE claim needs.
     *
     * Resolves as soon as the database can say which of two things happened to a login
     * leg that is already in flight: it SETTLED, or PostgreSQL reports an UNGRANTED lock
     * request — the leg queued. Both are events the database reports, not elapsed time,
     * so a caller can assert on the answer instead of on a sleep. `neither` is returned
     * only if the bound expires with the leg neither settled nor queued, and every caller
     * treats that as a failure rather than as a pass.
     */
    async function completesOrQueues(
      pending: Promise<unknown>,
      timeoutMs = 5_000,
    ): Promise<'completed' | 'queued' | 'neither'> {
      let settled = false;
      const mark = (): void => {
        settled = true;
      };
      void pending.then(mark, mark);
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (settled) return 'completed';
        if ((await blockedLockRequests()) > 0) return 'queued';
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return settled ? 'completed' : 'neither';
    }

    async function liveSessionCount(): Promise<number> {
      const r = await query(`SELECT COUNT(*)::int AS n FROM identity_sessions`);
      return Number((r.rows[0] as { n: number }).n);
    }

    async function custodyCount(): Promise<number> {
      const r = await query(
        `SELECT COUNT(*)::int AS n FROM identity_sessions
          WHERE refresh_state_sealed IS NOT NULL OR refresh_token_hash IS NOT NULL`,
      );
      return Number((r.rows[0] as { n: number }).n);
    }

    async function txnStatus(loginTxnId: string): Promise<{ status: string; reason: unknown }> {
      const r = await query(
        `SELECT status, failure_reason FROM login_transactions WHERE login_txn_id = $1`,
        [loginTxnId],
      );
      const row = r.rows[0] as { status: string; failure_reason: unknown };
      return { status: row.status, reason: row.failure_reason };
    }

    /**
     * THE CONTROL. The identical leg, with NO concurrent writer, admits the login
     * and takes the provider credential into custody. Without this, every refusal
     * below could be a login that was broken for some entirely unrelated reason.
     */
    test('CONTROL — with no concurrent administrator, the same leg admits the login and takes custody', async () => {
      const advisor = await seedActor(env.issuer, {
        tenantId: tenant,
        roles: [ROLES.SERVICE_ADVISOR],
      });
      const txn = await beginLogin();
      useIdentityProviderForTests(fakeExchange(advisor.providerUserId, txn.oidcNonce));
      const res = await callback(txn);
      assert.equal(res.status, 302, 'the unraced leg must admit');
      assert.match(res.setCookie ?? '', /dealer_session=/);
      assert.equal(await liveSessionCount(), 1);
      assert.equal(await custodyCount(), 1, 'and the provider credential is in custody');
      assert.equal((await txnStatus(txn.loginTxnId)).status, 'succeeded');
    });

    /**
     * Each race is ONE administrative write, held uncommitted while the login queues
     * behind it. `relink` needs a second connection to move the link ONTO, which the
     * schema only permits in the `disabled` state (`uq_ipc_active` allows one active
     * connection per tenant) — which is exactly right: relinking a person onto a
     * connection that no longer admits logins is the shape this must refuse.
     */
    const races: Array<{
      readonly label: string;
      /**
       * The FULL test name, written out rather than composed, so
       * `scripts/mutation-kill.ts` can name this scenario as the test a mutation
       * must kill. A name assembled from a template literal appears nowhere in
       * the file, and the mutation runner refuses an anchor it cannot find.
       */
      readonly title: string;
      readonly discriminating: boolean;
      /** Runs before the login begins. Returns anything the write needs. */
      readonly arrange?: (subject: string) => Promise<void>;
      /**
       * The administrator's write: ISSUED ON THE CALLER'S CLIENT AND LEFT
       * UNCOMMITTED. It goes through `fixtureAuthorizationStateWrite` at each site
       * rather than returning SQL for the runner to execute, because
       * `scripts/check-owned-mutations.ts` requires an authorization-state
       * statement to be a syntactic ARGUMENT to that primitive — a rule worth
       * keeping, and one this battery has no reason to route around.
       */
      readonly write: (input: {
        writer: Executor;
        userLinkId: string;
      }) => Promise<{ rowCount: number | null }>;
    }> = [
      {
        label: 'TENANT SUSPENSION',
        title: 'TENANT SUSPENSION cannot race admission into a session or into credential custody',
        discriminating: true,
        write: ({ writer }) =>
          fixtureAuthorizationStateWrite(
            'simulate-authorization-drift',
            `UPDATE tenants SET status = 'suspended' WHERE tenant_id = $1`,
            [tenant],
            { executor: writer },
          ),
      },
      {
        label: 'TENANT EFFECTIVE-WINDOW CLOSURE',
        title:
          'TENANT EFFECTIVE-WINDOW CLOSURE cannot race admission into a session or into credential custody',
        discriminating: true,
        write: ({ writer }) =>
          fixtureAuthorizationStateWrite(
            'simulate-authorization-drift',
            `UPDATE tenants
                SET effective_from = NOW() - INTERVAL '2 days',
                    effective_to = NOW() - INTERVAL '1 day'
              WHERE tenant_id = $1`,
            [tenant],
            { executor: writer },
          ),
      },
      {
        label: 'CONNECTION DISABLEMENT',
        title:
          'CONNECTION DISABLEMENT cannot race admission into a session or into credential custody',
        discriminating: true,
        write: ({ writer }) =>
          fixtureAuthorizationStateWrite(
            'simulate-authorization-drift',
            `UPDATE identity_provider_connections SET status = 'disabled' WHERE tenant_id = $1`,
            [tenant],
            { executor: writer },
          ),
      },
      {
        label: 'ORGANIZATION HIERARCHY ARCHIVAL',
        title:
          'ORGANIZATION HIERARCHY ARCHIVAL cannot race admission into a session or into credential custody',
        discriminating: true,
        write: ({ writer }) =>
          fixtureAuthorizationStateWrite(
            'simulate-authorization-drift',
            `UPDATE legal_entities SET status = 'archived' WHERE tenant_id = $1`,
            [tenant],
            { executor: writer },
          ),
      },
      {
        label: 'LINK DEACTIVATION',
        title: 'LINK DEACTIVATION cannot race admission into a session or into credential custody',
        discriminating: false,
        write: ({ writer, userLinkId }) =>
          fixtureAuthorizationStateWrite(
            'simulate-authorization-drift',
            `UPDATE user_links SET status = 'deactivated', deactivated_at = NOW()
              WHERE user_link_id = $1`,
            [userLinkId],
            { executor: writer },
          ),
      },
      {
        label: 'LINK EFFECTIVE-WINDOW CLOSURE',
        title:
          'LINK EFFECTIVE-WINDOW CLOSURE cannot race admission into a session or into credential custody',
        discriminating: false,
        write: ({ writer, userLinkId }) =>
          fixtureAuthorizationStateWrite(
            'simulate-authorization-drift',
            `UPDATE user_links
                SET effective_from = NOW() - INTERVAL '2 days',
                    effective_to = NOW() - INTERVAL '1 day'
              WHERE user_link_id = $1`,
            [userLinkId],
            { executor: writer },
          ),
      },
      {
        label: 'LINK RELINKING ONTO ANOTHER CONNECTION',
        title:
          'LINK RELINKING ONTO ANOTHER CONNECTION cannot race admission into a session or into credential custody',
        discriminating: false,
        arrange: async () => {
          await fixtureAuthorizationStateWrite(
            'seed-authorization-state',
            `INSERT INTO identity_provider_connections
               (connection_scope, tenant_id, provider, provider_organization_id, status, issuer)
             VALUES ('dealership', $1, 'workos', $2, 'disabled', $3)`,
            [tenant, `${testOrganizationId(tenant)}_relink`, `${env.issuer.issuer}/relinked`],
          );
        },
        write: ({ writer, userLinkId }) =>
          fixtureAuthorizationStateWrite(
            'simulate-authorization-drift',
            `UPDATE user_links ul
                SET connection_id = c.connection_id,
                    issuer = c.issuer,
                    provider_organization_id = c.provider_organization_id
               FROM identity_provider_connections c
              WHERE ul.user_link_id = $1
                AND c.tenant_id = $2
                AND c.status = 'disabled'`,
            [userLinkId, tenant],
            { executor: writer },
          ),
      },
    ];

    for (const race of races) {
      test(race.title, async () => {
        const advisor = await seedActor(env.issuer, {
          tenantId: tenant,
          roles: [ROLES.SERVICE_ADVISOR],
        });
        if (race.arrange !== undefined) await race.arrange(advisor.providerUserId);
        const link = (
          await query(`SELECT user_link_id FROM user_links WHERE provider_user_id = $1`, [
            advisor.providerUserId,
          ])
        ).rows[0] as { user_link_id: string };
        const txn = await beginLogin();
        useIdentityProviderForTests(fakeExchange(advisor.providerUserId, txn.oidcNonce));

        const writer = await getPool().connect();
        let response: { status: number; setCookie: string | null };
        let blocked: boolean;
        try {
          await writer.query('BEGIN');
          // The administrator's transaction is deliberately idle while the login
          // queues behind it, so the server-side idle bound is lifted for it alone.
          // `SET LOCAL` expires with this transaction and affects nothing else.
          await writer.query('SET LOCAL idle_in_transaction_session_timeout = 0');
          // The administrator's write, on THIS client, through the declared fixture
          // primitive — named, reasoned and counted exactly as every other fixture
          // bypass is — and left UNCOMMITTED, which is the whole point.
          const changed = await race.write({
            writer,
            userLinkId: String(link.user_link_id),
          });
          assert.ok(
            (changed.rowCount ?? 0) > 0,
            `${race.label}: the administrator's write must actually change a row`,
          );

          // FIRE, DO NOT AWAIT. The leg runs until it needs a row this uncommitted
          // transaction holds.
          const pending = callback(txn);

          // THE ORDERING, PINNED BY THE DATABASE ITSELF. Recorded rather than
          // asserted here on purpose: when the admission is NOT holding its row the
          // login sails past, and the first thing worth reporting is what it did —
          // which is the outcome assertions below — not that no lock was seen.
          blocked = await waitForBlockedLockRequest();

          await writer.query('COMMIT');
          response = await pending;
        } finally {
          writer.release();
        }

        // ── the login lost the race, and lost it completely ─────────────────
        assert.equal(response.status, 401, `${race.label}: the raced login must be refused`);
        assert.ok(
          !/dealer_session=[^;,]/.test(response.setCookie ?? ''),
          `${race.label}: a refused login must set no session cookie`,
        );
        assert.equal(await liveSessionCount(), 0, `${race.label}: no session may exist`);
        assert.equal(
          await custodyCount(),
          0,
          `${race.label}: no provider refresh credential may be in custody`,
        );
        const row = await txnStatus(txn.loginTxnId);
        assert.equal(row.status, 'failed', `${race.label}: the transaction is terminal`);
        assert.equal(
          row.reason,
          'identity_not_admitted',
          `${race.label}: recorded as an admission refusal, not as a fault`,
        );
        // …and it lost it BY QUEUING, not by luck. A refusal that never queued would
        // mean this scenario had proved nothing about concurrency at all.
        assert.ok(
          blocked,
          `${race.label}: the login never queued behind the administrator, so no ` +
            'interleaving was observed — the admission is not holding the row it decided on',
        );
      });
    }

    /**
     * THE STRUCTURAL HALF OF §1.3, and the part no race can measure.
     *
     * The scenarios above prove the admission HOLDS the rows it decided on. They
     * cannot prove the OTHER half — that there is no interval between the decision
     * and the custody — because in the fixed code that interval does not exist, and
     * a test cannot pin an ordering inside a window that is not there. R4's window
     * lay between two commits, and it is gone by construction: one `withTransaction`.
     *
     * What CAN be held is the shape that made it possible. R4's route called an
     * admission and then called `createSession` itself, so the route owned the gap.
     * A route may no longer establish a session at all: `apps/**` must contain no
     * call to either session-creation function, which leaves
     * `admitLoginAndEstablishSession` as the only way a login session comes into
     * existence — and that function has no code path that admits without inserting.
     *
     * This is a lexical guard over `apps/`, stated as narrowly as it is true.
     */
    test('no route may establish a session on its own — admission and custody are ONE call', () => {
      const appsRoot = join(__dirname, '..', 'apps');
      const sources: string[] = [];
      const walk = (dir: string): void => {
        for (const entry of readdirSync(dir)) {
          if (entry === 'node_modules' || entry === 'dist') continue;
          const full = join(dir, entry);
          if (statSync(full).isDirectory()) walk(full);
          else if (full.endsWith('.ts') && !full.endsWith('.d.ts')) sources.push(full);
        }
      };
      walk(appsRoot);
      assert.ok(sources.length > 10, 'the walk must actually have found the app sources');

      const offenders: string[] = [];
      for (const file of sources) {
        const text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
        const code = text
          .split('\n')
          .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
          .join('\n');
        if (/\bcreateSession(Within)?\s*\(/.test(code)) {
          offenders.push(file.slice(appsRoot.length + 1).replace(/\\/g, '/'));
        }
      }
      assert.deepEqual(
        offenders,
        [],
        'an app that can create a session by itself can separate admission from custody; ' +
          'the login callback must use admitLoginAndEstablishSession',
      );
    });

    /**
     * TWO LOGINS THROUGH ONE CONNECTION, SEQUENTIALLY. Stated as narrowly as it is
     * true, because it previously was not: this test's own comment used to say "both
     * logins are started before either is awaited", and the code below awaits the
     * first before opening the second. It measures nothing about concurrency and
     * nothing about lock MODE — with `FOR UPDATE` at every admission site it passes
     * unchanged, which is exactly why the paragraph it used to carry was withdrawn.
     *
     * What it does hold is worth holding: the admission's locks are released at
     * COMMIT, so a connection that has just admitted one login still admits the next,
     * and each login gets its OWN session and its own custody rather than joining or
     * replacing the first. The lock-MODE claim is pinned by the barrier-controlled
     * test below instead.
     */
    test('two sequential logins through the SAME connection each get their own session', async () => {
      const one = await seedActor(env.issuer, { tenantId: tenant, roles: [ROLES.SERVICE_ADVISOR] });
      const two = await seedActor(env.issuer, { tenantId: tenant, roles: [ROLES.SERVICE_ADVISOR] });
      const txnOne = await beginLogin();
      useIdentityProviderForTests(fakeExchange(one.providerUserId, txnOne.oidcNonce));
      const first = await callback(txnOne);
      assert.equal(first.status, 302);

      const txnTwo = await beginLogin();
      useIdentityProviderForTests(fakeExchange(two.providerUserId, txnTwo.oidcNonce));
      const second = await callback(txnTwo);
      assert.equal(second.status, 302, 'a second login through the same connection must admit');
      assert.equal(await liveSessionCount(), 2);
      assert.equal(await custodyCount(), 2);
    });

    /**
     * THE LOCK MODE ITSELF, PINNED — FBL-020-R5 Appendix A item 4.
     *
     * The module argues for `FOR SHARE` rather than `FOR UPDATE`, and until this test
     * existed nothing in the tree could tell the two apart: `FOR UPDATE` is STRICTLY
     * STRONGER, so substituting it cannot enable any race, every scenario above stays
     * green, and the whole battery was blind to the substitution. A design choice no
     * test can distinguish is a comment, not a control.
     *
     * The barrier here is the mirror image of the ones above. Instead of an
     * administrator's EXCLUSIVE write, a second connection holds a SHARE lock on the
     * connection row the login must read, and leaves it held. Then:
     *
     *   * with the admission's `FOR SHARE`, the two share locks are compatible: the
     *     login is never queued, it finishes while the other lock is still held, and
     *     it takes its credential into custody;
     *   * with `FOR UPDATE` — or `FOR NO KEY UPDATE` — the admission's request
     *     conflicts with the held share lock, PostgreSQL reports the request as
     *     ungranted, and `completesOrQueues` returns `queued` rather than `completed`.
     *
     * Both outcomes are read from the database (`pg_locks.granted`, and the leg's own
     * settlement), so this is a barrier and not a timing measurement. It says nothing
     * about parallel THROUGHPUT, and it is not offered as saying anything: what it
     * pins is that a writer's-lock mode is not what the admission takes.
     */
    test('the admission claims its rows in a SHARED mode: a login is not queued behind another share lock on its connection', async () => {
      const advisor = await seedActor(env.issuer, {
        tenantId: tenant,
        roles: [ROLES.SERVICE_ADVISOR],
      });
      const txn = await beginLogin();
      useIdentityProviderForTests(fakeExchange(advisor.providerUserId, txn.oidcNonce));

      const holder = await getPool().connect();
      let outcome: 'completed' | 'queued' | 'neither';
      let response: { status: number; setCookie: string | null };
      try {
        await holder.query('BEGIN');
        await holder.query('SET LOCAL idle_in_transaction_session_timeout = 0');
        // A SHARE lock, not an exclusive one — the same mode the admission takes.
        const held = await holder.query(
          `SELECT connection_id FROM identity_provider_connections
            WHERE tenant_id = $1 FOR SHARE`,
          [tenant],
        );
        assert.ok(
          held.rows.length > 0,
          'the barrier must actually hold a share lock on the connection row',
        );

        // FIRE, DO NOT AWAIT — then let the database decide what happened to it.
        const pending = callback(txn);
        outcome = await completesOrQueues(pending);

        await holder.query('ROLLBACK');
        response = await pending;
      } finally {
        holder.release();
      }

      assert.equal(
        outcome,
        'completed',
        'the login queued behind a SHARE lock, so the admission is taking a writer’s ' +
          'lock (FOR UPDATE / FOR NO KEY UPDATE) rather than the shared claim the module argues for',
      );
      assert.equal(response.status, 302, 'and the unblocked login admits');
      assert.match(response.setCookie ?? '', /dealer_session=/);
      assert.equal(await liveSessionCount(), 1);
      assert.equal(await custodyCount(), 1);
    });
  },
);
