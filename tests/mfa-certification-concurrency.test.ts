import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, beforeEach, describe, test } from 'node:test';
import {
  bootstrapAdministrator,
  ensureActiveConnection,
  fixtureAuthorizationStateWrite,
  resetDatabase,
  seedTenantIdentity,
  skipIntegration,
} from '@dealer/test-kit';
import { closePool, getPool, query, type Executor } from '@dealer/database';
import {
  MutationAuthorityError,
  certifyProviderMfaPolicy,
  findActiveConnectionById,
  grantRole,
} from '@dealer/identity-access';

/**
 * FBL-020-R6 §2.6 — THE MFA-CERTIFICATION TENANT CHECK CANNOT BE RACED.
 *
 * ── the defect ─────────────────────────────────────────────────────────────
 *
 * R5 §1.9 added the right PREDICATE — a tenant-scoped certification requires a
 * currently active and effective tenant — and asked it with a plain `SELECT`. Under
 * READ COMMITTED that reads a snapshot and CLAIMS NOTHING, so an administrator
 * suspending the tenant (or closing its effective window) a microsecond later
 * committed freely while the certification, having already decided, went on to write
 * `mfa_policy_certified = TRUE`. MFA certification is the single fact every
 * high-assurance step-up in the platform rests on, and it was being granted against a
 * tenant state nobody was holding.
 *
 * `tests/identity-lifecycle-audit.test.ts` proves the predicate SEQUENTIALLY —
 * suspend, then certify, then be refused. That is a different claim, and it stayed
 * green throughout the defect. This battery proves the CONCURRENT one.
 *
 * ── how the interleaving is pinned ─────────────────────────────────────────
 *
 * NOT WITH SLEEPS, AND NOT WITH TIMING LUCK — the same barrier
 * `tests/login-admission-concurrency.test.ts` uses, for the same reason. Each
 * scenario:
 *
 *   1. opens a DEDICATED database connection, `BEGIN`s, and issues the
 *      administrator's write to the tenant row, leaving it UNCOMMITTED — which holds
 *      a row-exclusive lock on exactly the row the certification must claim;
 *   2. fires the real `certifyProviderMfaPolicy` WITHOUT awaiting it;
 *   3. WAITS UNTIL POSTGRES ITSELF REPORTS A LOCK REQUEST THAT IS NOT GRANTED. That
 *      is the ordering being pinned: the test does not continue until the database
 *      says the certification is queued behind the administrator. A certification
 *      that never blocks fails the assertion rather than racing past it;
 *   4. COMMITs the administrator's write, releasing it;
 *   5. asserts the certification was REFUSED and that NOTHING was written — the
 *      connection is still uncertified, and no certification audit event exists.
 *
 * THE ACTOR IS A TENANT ADMINISTRATOR WITH A REAL ROLE BINDING, so the refusal is
 * the tenant rule and not a missing authority: the CONTROL below certifies
 * successfully with the very same actor and the very same call.
 */
describe(
  'MFA-policy certification cannot be raced (FBL-020-R6 §2.6)',
  { skip: skipIntegration ? 'set TEST_DATABASE_URL to run' : false },
  () => {
    let tenantId: string;
    let connectionId: string;
    let tenantAdmin: string;

    after(async () => {
      await closePool();
    });

    beforeEach(async () => {
      await resetDatabase();
      tenantId = randomUUID();
      await seedTenantIdentity(tenantId);
      await ensureActiveConnection(tenantId);
      const r = await query(
        `SELECT connection_id FROM identity_provider_connections
          WHERE tenant_id = $1 AND status = 'active' LIMIT 1`,
        [tenantId],
      );
      connectionId = String((r.rows[0] as { connection_id: unknown }).connection_id);
      const created = await fixtureAuthorizationStateWrite(
        'seed-authorization-state',
        `INSERT INTO user_links
           (actor_scope, tenant_id, provider, provider_user_id, status, activated_at,
            connection_id, issuer, provider_organization_id)
         SELECT 'dealership', $1, 'workos', $2, 'activated', NOW(),
                c.connection_id, c.issuer, c.provider_organization_id
           FROM identity_provider_connections c
          WHERE c.tenant_id = $1 AND c.provider = 'workos' AND c.status = 'active'
          LIMIT 1
         RETURNING user_link_id`,
        [tenantId, 'user_mfa_race_admin_' + randomUUID().slice(0, 8)],
      );
      tenantAdmin = String((created.rows[0] as { user_link_id: unknown }).user_link_id);
      await grantRole({
        actingUserLinkId: await bootstrapAdministrator(tenantId),
        tenantId,
        userLinkId: tenantAdmin,
        role: 'tenant_admin',
        scopeLevel: 'tenant',
        scopeId: tenantId,
      });
    });

    /** How many lock requests PostgreSQL currently reports as NOT granted, here. */
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

    /**
     * Blocks until PostgreSQL reports an ungranted lock request in this database —
     * the certification queued behind the administrator's uncommitted write. Returns
     * false if none appears within the bound, and every scenario treats that as a
     * failure rather than as a reason to hurry on.
     *
     * Scoped to this DATABASE, not to this exact row: it is an observation that the
     * certification serialised, not a proof of which lock it serialised on. The
     * refusal assertions carry the security property and cannot be satisfied by an
     * unrelated lock.
     */
    async function waitForBlockedLockRequest(timeoutMs = 5_000): Promise<boolean> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if ((await blockedLockRequests()) > 0) return true;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return false;
    }

    async function certified(): Promise<boolean> {
      return (await findActiveConnectionById(connectionId))?.mfaPolicyCertified === true;
    }

    async function certificationEvents(): Promise<number> {
      const r = await query(
        `SELECT COUNT(*)::int AS n FROM audit_events
          WHERE event_type = 'identity.provider_connection.mfa_policy_certified'
            AND entity_id = $1`,
        [connectionId],
      );
      return Number((r.rows[0] as { n: number }).n);
    }

    /**
     * THE CONTROL. The identical call, with NO concurrent administrator, certifies —
     * so every refusal below is the race and not a broken fixture.
     */
    test('CONTROL — with no concurrent administrator, the same actor certifies the MFA policy', async () => {
      const result = await certifyProviderMfaPolicy({
        actingUserLinkId: tenantAdmin,
        connectionId,
        certified: true,
      });
      assert.ok(result, 'the unraced certification succeeds');
      assert.equal(await certified(), true);
      assert.equal(await certificationEvents(), 1, 'and audits itself exactly once');
    });

    const races: ReadonlyArray<{
      readonly label: string;
      readonly title: string;
      readonly write: (writer: Executor) => Promise<{ rowCount: number | null }>;
    }> = [
      {
        label: 'TENANT SUSPENSION',
        title:
          'TENANT SUSPENSION cannot race MFA certification into a certified connection (R6 §2.6)',
        write: (writer) =>
          fixtureAuthorizationStateWrite(
            'simulate-authorization-drift',
            `UPDATE tenants SET status = 'suspended' WHERE tenant_id = $1`,
            [tenantId],
            { executor: writer },
          ),
      },
      {
        label: 'TENANT EFFECTIVE-WINDOW CLOSURE',
        title:
          'TENANT EFFECTIVE-WINDOW CLOSURE cannot race MFA certification into a certified connection (R6 §2.6)',
        write: (writer) =>
          fixtureAuthorizationStateWrite(
            'simulate-authorization-drift',
            `UPDATE tenants
                SET effective_from = NOW() - INTERVAL '2 days',
                    effective_to = NOW() - INTERVAL '1 day'
              WHERE tenant_id = $1`,
            [tenantId],
            { executor: writer },
          ),
      },
    ];

    for (const race of races) {
      test(race.title, async () => {
        const writer = await getPool().connect();
        let outcome: 'refused' | 'certified' | 'other-error';
        let blocked: boolean;
        try {
          await writer.query('BEGIN');
          // The administrator's transaction is deliberately idle while the
          // certification queues behind it, so the server-side idle bound is lifted
          // for it alone. `SET LOCAL` expires with this transaction.
          await writer.query('SET LOCAL idle_in_transaction_session_timeout = 0');
          const changed = await race.write(writer);
          assert.ok(
            (changed.rowCount ?? 0) > 0,
            `${race.label}: the administrator's write must actually change a row`,
          );

          // FIRE, DO NOT AWAIT. The certification runs until it needs the tenant row
          // this uncommitted transaction holds.
          const pending = certifyProviderMfaPolicy({
            actingUserLinkId: tenantAdmin,
            connectionId,
            certified: true,
          }).then(
            () => 'certified' as const,
            (err: unknown) =>
              err instanceof MutationAuthorityError
                ? ('refused' as const)
                : ('other-error' as const),
          );

          // THE ORDERING, PINNED BY THE DATABASE ITSELF.
          blocked = await waitForBlockedLockRequest();

          await writer.query('COMMIT');
          outcome = await pending;
        } finally {
          writer.release();
        }

        assert.equal(
          outcome,
          'refused',
          `${race.label}: the raced certification must be refused as an authority failure`,
        );
        assert.equal(
          await certified(),
          false,
          `${race.label}: the connection must NOT be left certified`,
        );
        assert.equal(
          await certificationEvents(),
          0,
          `${race.label}: and no certification audit event may exist`,
        );
        // …and it lost BY QUEUING, not by luck. A refusal that never queued would mean
        // this scenario proved nothing about concurrency at all — which is exactly the
        // state the sequential test was already in.
        assert.ok(
          blocked,
          `${race.label}: the certification never queued behind the administrator, so no ` +
            'interleaving was observed — the tenant check is not holding the row it decided on',
        );
      });
    }
  },
);
