import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, beforeEach, describe, test } from 'node:test';
import {
  bootstrapAdministrator,
  certifyMfaPolicy,
  mintReauthGrant,
  ensureActiveConnection,
  resetDatabase,
  seedLocalSession,
  skipIntegration,
  fixtureAuthorizationStateWrite,
  seedTenantViaService,
} from '@dealer/test-kit';
import { closePool, query, withTransaction, type Executor } from '@dealer/database';
import { CURRENT_EVIDENCE_VERSION, grantRole } from '@dealer/identity-access';

/**
 * FBL-020-R4 §2 — THE CONTROLS PROVED AGAINST THE DATABASE ITSELF.
 *
 * Every assertion in this file goes through raw SQL on purpose. The point of §2 is that
 * an incomplete identity tuple and an incomplete piece of policy evidence must be
 * UNREPRESENTABLE — not "rejected by the service that normally writes them". A test that
 * proved the control by calling the well-behaved writer would prove only that the
 * well-behaved writer behaves well; the interesting adversary is the next code path, a
 * repair script or a psql session, and that adversary writes SQL.
 */
describe(
  'identity tuple and policy evidence, enforced by the database (FBL-020-R4 §2)',
  { skip: skipIntegration ? 'set TEST_DATABASE_URL to run' : false },
  () => {
    after(async () => {
      await closePool();
    });

    const CHECK_VIOLATION = '23514';
    const FK_VIOLATION = '23503';
    const RAISED = 'P0001';
    const HEX64 = (): string => randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');

    async function assertSqlState(
      op: Promise<unknown>,
      state: string,
      what: string,
    ): Promise<void> {
      await assert.rejects(
        op,
        (err: unknown) => {
          const code = (err as { code?: unknown }).code;
          assert.equal(code, state, `${what}: expected SQLSTATE ${state}, got ${String(code)}`);
          return true;
        },
        what,
      );
    }

    async function countEvidence(): Promise<number> {
      const r = await query(`SELECT COUNT(*)::int AS n FROM policy_decisions`);
      return Number((r.rows[0] as { n: number }).n);
    }

    interface Fixture {
      tenantId: string;
      otherTenantId: string;
      connectionId: string;
      issuer: string;
      organizationId: string;
      linkId: string;
      subject: string;
      sessionId: string;
      /** A REAL, granted role binding held by this fixture's actor. */
      roleBindingId: string;
      roleBindingVersion: number;
      /**
       * FBL-020-R5 §2 — the SECOND, equally real identity chain in the other
       * tenant. Every cross-wiring test below is built from these: the point of
       * the class is that each id resolves to something that genuinely exists,
       * so a fixture made of random UUIDs could not express it at all.
       */
      otherConnectionId: string;
      otherLinkId: string;
      otherSubject: string;
      otherSessionId: string;
      otherRoleBindingId: string;
    }

    /** An activated, fully bound link in the named tenant. */
    async function activatedLink(tenantId: string): Promise<{ linkId: string; subject: string }> {
      const subject = 'user_' + randomUUID();
      const r = await fixtureAuthorizationStateWrite(
        'seed-authorization-state',
        `INSERT INTO user_links
           (actor_scope, tenant_id, provider, provider_user_id, status, activated_at,
            connection_id, issuer, provider_organization_id)
         SELECT 'dealership', $1, 'workos', $2, 'activated', NOW(),
                c.connection_id, c.issuer, c.provider_organization_id
           FROM identity_provider_connections c
          WHERE c.tenant_id = $1 AND c.status = 'active' LIMIT 1
         RETURNING user_link_id`,
        [tenantId, subject],
      );
      return { linkId: String((r.rows[0] as Record<string, unknown>).user_link_id), subject };
    }

    /** An ATTRIBUTED role grant, through the owned mutation service, never raw SQL. */
    async function grant(tenantId: string, userLinkId: string): Promise<string> {
      const granted = await grantRole({
        actingUserLinkId: await bootstrapAdministrator(tenantId),
        tenantId,
        userLinkId,
        role: 'service_advisor',
        scopeLevel: 'tenant',
        scopeId: tenantId,
      });
      return granted.roleBindingId;
    }

    /**
     * TWO complete, coherent identity chains — tenant → connection → link →
     * live session → granted role binding — one in each tenant.
     *
     * FBL-020-R5 §2 requires the negative tests to use "both random nonexistent
     * identifiers AND cross-wired real rows". The second chain is what makes the
     * second half expressible: a test that can only reach for a random UUID
     * proves a foreign key and nothing more, and a foreign key is exactly the
     * control that misses cross-wiring.
     */
    async function fixture(): Promise<Fixture> {
      const tenant = await seedTenantViaService({ name: 'Evidence Motors', status: 'active' });
      const other = await seedTenantViaService({ name: 'Other Motors', status: 'active' });
      await ensureActiveConnection(tenant.tenantId);
      await ensureActiveConnection(other.tenantId);
      await ensureActiveConnection(null);
      const { linkId, subject } = await activatedLink(tenant.tenantId);
      const bound = (
        await query(
          `SELECT connection_id, issuer, provider_organization_id FROM user_links
            WHERE user_link_id = $1`,
          [linkId],
        )
      ).rows[0] as Record<string, unknown>;
      const session = await seedLocalSession(linkId);
      const roleBindingId = await grant(tenant.tenantId, linkId);
      const version = Number(
        (
          (
            await query(
              `SELECT authorization_version FROM role_bindings WHERE role_binding_id = $1`,
              [roleBindingId],
            )
          ).rows[0] as Record<string, unknown>
        ).authorization_version,
      );

      const otherPerson = await activatedLink(other.tenantId);
      const otherBound = (
        await query(`SELECT connection_id FROM user_links WHERE user_link_id = $1`, [
          otherPerson.linkId,
        ])
      ).rows[0] as Record<string, unknown>;
      const otherSession = await seedLocalSession(otherPerson.linkId);

      return {
        tenantId: tenant.tenantId,
        otherTenantId: other.tenantId,
        connectionId: String(bound.connection_id),
        issuer: String(bound.issuer),
        organizationId: String(bound.provider_organization_id),
        linkId,
        subject,
        sessionId: session.sessionId,
        roleBindingId,
        roleBindingVersion: version,
        otherConnectionId: String(otherBound.connection_id),
        otherLinkId: otherPerson.linkId,
        otherSubject: otherPerson.subject,
        otherSessionId: otherSession.sessionId,
        otherRoleBindingId: await grant(other.tenantId, otherPerson.linkId),
      };
    }

    let f: Fixture;
    beforeEach(async () => {
      await resetDatabase();
      f = await fixture();
    });

    // ══ the identity tuple ══════════════════════════════════════════════════

    test('an ACTIVATED user link cannot be bound to another tenant’s connection', async () => {
      const c = (
        await query(
          `SELECT connection_id, issuer, provider_organization_id
             FROM identity_provider_connections WHERE tenant_id = $1`,
          [f.otherTenantId],
        )
      ).rows[0] as Record<string, unknown>;
      // Every column is individually valid: a real connection, a real issuer, a real
      // organization. Only the RELATIONSHIP is wrong — the connection belongs to
      // another tenant — and that is exactly what the composite key exists to see.
      await assertSqlState(
        fixtureAuthorizationStateWrite(
          'seed-authorization-state',
          `INSERT INTO user_links
             (actor_scope, tenant_id, provider, provider_user_id, status, activated_at,
              connection_id, issuer, provider_organization_id)
           VALUES ('dealership', $1, 'workos', $2, 'activated', NOW(), $3, $4, $5)`,
          [
            f.tenantId,
            'user_' + randomUUID(),
            String(c.connection_id),
            String(c.issuer),
            String(c.provider_organization_id),
          ],
        ),
        FK_VIOLATION,
        'cross-tenant connection binding',
      );
    });

    test('a PLATFORM-scope link cannot bind to a dealership connection', async () => {
      // THIS IS WHY `tenant_key` EXISTS. A foreign key carrying `tenant_id` is
      // MATCH SIMPLE, so a NULL tenant would satisfy it with no lookup at all — and a
      // platform identity resolving through a customer's WorkOS organization is the
      // single worst tuple in this schema. The generated key is never NULL, so the
      // lookup always happens.
      await assertSqlState(
        fixtureAuthorizationStateWrite(
          'seed-authorization-state',
          `INSERT INTO user_links
             (actor_scope, tenant_id, provider, provider_user_id, status, activated_at,
              connection_id, issuer, provider_organization_id)
           VALUES ('platform', NULL, 'workos', $1, 'activated', NOW(), $2, $3, $4)`,
          ['user_' + randomUUID(), f.connectionId, f.issuer, f.organizationId],
        ),
        FK_VIOLATION,
        'platform link on a dealership connection',
      );
    });

    test('an ACTIVATED link cannot claim an issuer or organization its connection lacks', async () => {
      for (const wrong of [
        { label: 'issuer', issuer: 'https://not-the-anchor.example', org: f.organizationId },
        { label: 'organization', issuer: f.issuer, org: 'org_not_this_one' },
      ]) {
        await assertSqlState(
          fixtureAuthorizationStateWrite(
            'seed-authorization-state',
            `INSERT INTO user_links
               (actor_scope, tenant_id, provider, provider_user_id, status, activated_at,
                connection_id, issuer, provider_organization_id)
             VALUES ('dealership', $1, 'workos', $2, 'activated', NOW(), $3, $4, $5)`,
            [f.tenantId, 'user_' + randomUUID(), f.connectionId, wrong.issuer, wrong.org],
          ),
          FK_VIOLATION,
          `activated link with a foreign ${wrong.label}`,
        );
      }
    });

    test('an ACTIVATED link cannot be PARTIALLY bound', async () => {
      // `ul_activated_is_bound` is what makes the composite key bite: with any of the
      // three NULL, MATCH SIMPLE would skip the lookup entirely, so the incomplete
      // shape has to be refused or the tuple could be evaded by omission.
      for (const partial of [
        { label: 'no connection', conn: null, issuer: f.issuer, org: f.organizationId },
        { label: 'no issuer', conn: f.connectionId, issuer: null, org: f.organizationId },
        { label: 'no organization', conn: f.connectionId, issuer: f.issuer, org: null },
      ]) {
        await assertSqlState(
          fixtureAuthorizationStateWrite(
            'seed-authorization-state',
            `INSERT INTO user_links
               (actor_scope, tenant_id, provider, provider_user_id, status, activated_at,
                connection_id, issuer, provider_organization_id)
             VALUES ('dealership', $1, 'workos', $2, 'activated', NOW(), $3, $4, $5)`,
            [f.tenantId, 'user_' + randomUUID(), partial.conn, partial.issuer, partial.org],
          ),
          CHECK_VIOLATION,
          `activated link with ${partial.label}`,
        );
      }
    });

    test('a LIVE session cannot claim a provider subject its link does not have', async () => {
      await assertSqlState(
        fixtureAuthorizationStateWrite(
          'seed-authorization-state',
          `INSERT INTO identity_sessions
             (tenant_id, user_link_id, session_token_hash, auth_time, expires_at,
              connection_id, issuer, provider_subject, provider_organization_id)
           VALUES ($1, $2, $3, NOW(), NOW() + INTERVAL '1 hour', $4, $5, 'user_somebody_else', $6)`,
          [f.tenantId, f.linkId, HEX64(), f.connectionId, f.issuer, f.organizationId],
        ),
        FK_VIOLATION,
        'session claiming a foreign subject',
      );
    });

    test('a LIVE session cannot claim a tenant, issuer or organization off its link', async () => {
      for (const wrong of [
        {
          label: 'another tenant',
          tenant: f.otherTenantId,
          issuer: f.issuer,
          org: f.organizationId,
        },
        {
          label: 'a foreign issuer',
          tenant: f.tenantId,
          issuer: 'https://not-the-anchor.example',
          org: f.organizationId,
        },
        {
          label: 'a foreign organization',
          tenant: f.tenantId,
          issuer: f.issuer,
          org: 'org_not_this_one',
        },
      ]) {
        await assertSqlState(
          fixtureAuthorizationStateWrite(
            'seed-authorization-state',
            `INSERT INTO identity_sessions
               (tenant_id, user_link_id, session_token_hash, auth_time, expires_at,
                connection_id, issuer, provider_subject, provider_organization_id)
             VALUES ($1, $2, $3, NOW(), NOW() + INTERVAL '1 hour', $4, $5, $6, $7)`,
            [wrong.tenant, f.linkId, HEX64(), f.connectionId, wrong.issuer, f.subject, wrong.org],
          ),
          FK_VIOLATION,
          `session with ${wrong.label}`,
        );
      }
    });

    test('a STARTED reauthentication cannot name a session that is not its own identity', async () => {
      const other = await activatedLink(f.tenantId);
      // The step-up names a real live session and a real activated link — but not the
      // link that session belongs to. A grant minted from it would be a step-up of
      // somebody else's authentication.
      await assertSqlState(
        query(
          `INSERT INTO reauthentication_transactions
             (tenant_id, user_link_id, session_id, action, nonce_hash, expires_at,
              oidc_nonce_hash, connection_id, issuer, provider_organization_id, provider_subject,
              -- R4 section 3: a STARTED transaction must also be able to judge its
              -- own callback (rat_started_is_callback_bound).
              state_hash, code_verifier_hash, callback_uri)
           VALUES ($1, $2, $3, 'service.ro.void', $4, NOW() + INTERVAL '5 minutes', $5,
                   $6, $7, $8, $9, $10, $11, 'http://127.0.0.1:3000/auth/reauth/callback')`,
          [
            f.tenantId,
            other.linkId,
            f.sessionId,
            HEX64(),
            HEX64(),
            f.connectionId,
            f.issuer,
            f.organizationId,
            other.subject,
            HEX64(),
            HEX64(),
          ],
        ),
        FK_VIOLATION,
        'step-up bound to another identity’s session',
      );
    });

    test('a GRANT cannot claim a different tenant, person or action than its transaction', async () => {
      const txn = await query(
        `INSERT INTO reauthentication_transactions
           (tenant_id, user_link_id, session_id, action, nonce_hash, expires_at, state,
            completed_at, terminal_reason, terminal_at,
            oidc_nonce_hash, connection_id, issuer, provider_organization_id,
            provider_subject)
         VALUES ($1, $2, $3, 'service.ro.void', $4, NOW() + INTERVAL '5 minutes', 'completed',
                 NOW(), 'granted', NOW(), $5, $6, $7, $8, $9)
         RETURNING reauth_txn_id`,
        [
          f.tenantId,
          f.linkId,
          f.sessionId,
          HEX64(),
          HEX64(),
          f.connectionId,
          f.issuer,
          f.organizationId,
          f.subject,
        ],
      );
      const txnId = String((txn.rows[0] as Record<string, unknown>).reauth_txn_id);
      const otherPerson = await activatedLink(f.tenantId);

      // `consumeReauthenticationGrant` matches on the GRANT's own copies of tenant,
      // user and action, so a grant that copied them wrongly would be spendable for
      // something its transaction never authorized.
      for (const forged of [
        {
          label: 'another action',
          action: 'service.ro.close',
          tenant: f.tenantId,
          user: f.linkId,
        },
        {
          label: 'another tenant',
          action: 'service.ro.void',
          tenant: f.otherTenantId,
          user: f.linkId,
        },
        {
          label: 'another person',
          action: 'service.ro.void',
          tenant: f.tenantId,
          user: otherPerson.linkId,
        },
      ]) {
        await assertSqlState(
          query(
            `INSERT INTO reauthentication_grants
               (reauth_txn_id, tenant_id, user_link_id, action, grant_hash, expires_at,
                connection_id)
             VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '2 minutes', $6)`,
            [txnId, forged.tenant, forged.user, forged.action, HEX64(), f.connectionId],
          ),
          FK_VIOLATION,
          `grant claiming ${forged.label}`,
        );
      }

      // The faithful grant is accepted, so the constraint refuses forgery rather than
      // grants in general.
      await query(
        `INSERT INTO reauthentication_grants
           (reauth_txn_id, tenant_id, user_link_id, action, grant_hash, expires_at, connection_id)
         VALUES ($1, $2, $3, 'service.ro.void', $4, NOW() + INTERVAL '2 minutes', $5)`,
        [txnId, f.tenantId, f.linkId, HEX64(), f.connectionId],
      );
    });

    test('the nil UUID can never be a tenant id, so it can stand for platform scope', async () => {
      await assertSqlState(
        fixtureAuthorizationStateWrite(
          'seed-authorization-state',
          `INSERT INTO tenants (tenant_id, name) VALUES ($1, 'Nil Tenant')`,
          ['00000000-0000-0000-0000-000000000000'],
        ),
        CHECK_VIOLATION,
        'the platform key is not an available tenant id',
      );
    });

    test('support access cannot cross a tenant: the session, and the approving grant', async () => {
      const requestId = String(
        (
          await fixtureAuthorizationStateWrite(
            'seed-authorization-state',
            `INSERT INTO support_access_requests
               (tenant_id, requester_user_link_id, requested_actions, reason,
                requested_duration_minutes)
             VALUES ($1, $2, ARRAY['service.ro.view'], 'ticket 1', 30)
             RETURNING request_id`,
            [f.tenantId, f.linkId],
          )
        ).rows[0]?.request_id,
      );

      await assertSqlState(
        fixtureAuthorizationStateWrite(
          'seed-authorization-state',
          `INSERT INTO support_access_sessions
             (request_id, tenant_id, actor_user_link_id, expires_at)
           VALUES ($1, $2, $3, NOW() + INTERVAL '30 minutes')`,
          [requestId, f.otherTenantId, f.linkId],
        ),
        FK_VIOLATION,
        'support session in a different tenant than its request',
      );

      // An approving grant minted in ANOTHER tenant cannot approve access into this one.
      await certifyMfaPolicy(f.otherTenantId);
      const foreignPerson = await activatedLink(f.otherTenantId);
      const foreignSession = await seedLocalSession(foreignPerson.linkId);
      const foreignBinding = (
        await query(
          `SELECT connection_id, issuer, provider_organization_id FROM user_links
            WHERE user_link_id = $1`,
          [foreignPerson.linkId],
        )
      ).rows[0] as Record<string, unknown>;
      const foreignTxn = String(
        (
          await query(
            `INSERT INTO reauthentication_transactions
               (tenant_id, user_link_id, session_id, action, nonce_hash, expires_at, state,
                completed_at, terminal_reason, terminal_at,
                oidc_nonce_hash, connection_id, issuer, provider_organization_id,
                provider_subject)
             VALUES ($1, $2, $3, 'identity.support.approve', $4, NOW() + INTERVAL '5 minutes',
                     'completed', NOW(), 'granted', NOW(), $5, $6, $7, $8, $9)
             RETURNING reauth_txn_id`,
            [
              f.otherTenantId,
              foreignPerson.linkId,
              foreignSession.sessionId,
              HEX64(),
              HEX64(),
              String(foreignBinding.connection_id),
              String(foreignBinding.issuer),
              String(foreignBinding.provider_organization_id),
              foreignPerson.subject,
            ],
          )
        ).rows[0]?.reauth_txn_id,
      );
      const foreignGrantId = String(
        (
          await query(
            `INSERT INTO reauthentication_grants
               (reauth_txn_id, tenant_id, user_link_id, action, grant_hash, expires_at,
                assurance_level, mfa_policy_certified_at_issue, connection_id)
             VALUES ($1, $2, $3, 'identity.support.approve', $4, NOW() + INTERVAL '2 minutes',
                     'fresh_and_mfa_policy', TRUE, $5)
             RETURNING grant_id`,
            [
              foreignTxn,
              f.otherTenantId,
              foreignPerson.linkId,
              HEX64(),
              String(foreignBinding.connection_id),
            ],
          )
        ).rows[0]?.grant_id,
      );

      await assertSqlState(
        fixtureAuthorizationStateWrite(
          'simulate-authorization-drift',
          `UPDATE support_access_requests
              SET status = 'approved', decided_at = NOW(), decided_by_user_link_id = $3,
                  approval_grant_id = $2
            WHERE request_id = $1`,
          [requestId, foreignGrantId, foreignPerson.linkId],
        ),
        FK_VIOLATION,
        'an approving grant from another tenant',
      );
    });

    // ══ policy evidence completeness ════════════════════════════════════════

    /**
     * ONE complete version-2 ALLOW. Each negative case below is the same row with
     * exactly one fact removed or cross-wired, written out in full rather than
     * generated, so the reader can see what changed and the failure is
     * attributable to that alone.
     *
     * TWO PSEUDO-KEYS, neither of which is a column:
     *
     *   - `matched_role_binding_ids` / `matched_authorization_versions` are
     *     interpolated as array literals. The DEFAULT is the fixture actor's own
     *     REAL, granted binding at its real version. Before FBL-020-R5 §2 this
     *     helper defaulted to `ARRAY['<random uuid>']`, and every test in this
     *     file passed — which is itself the finding: the schema accepted
     *     authority evidence that named a binding nobody had ever granted.
     *     `null` means "truthfully empty authority".
     *   - `support_window_from` names the support session whose `expires_at` is
     *     read, BY THE DATABASE, inside this INSERT. It is not sent as a
     *     parameter because it cannot be: PostgreSQL keeps microseconds and a
     *     JavaScript `Date` keeps milliseconds, so a value read out and sent
     *     back is a DIFFERENT instant, and migration 057 §11's window check —
     *     correctly — refuses it. Defaults to the session being claimed; point
     *     it at another session to test the mismatch.
     *   - `auth_time_from` is the FBL-020-R6 §3.1 counterpart, and it exists for
     *     the same reason. This helper used to write `auth_time: new Date()`, and
     *     every test here passed — which was itself the finding R6 §3.1 names:
     *     the schema accepted a coherent, live, correctly cross-wired credential
     *     beside an authentication instant that belonged to nothing. The
     *     authentication time is now read, BY THE DATABASE, out of the session the
     *     row itself names, exactly as `record()` reads it. Point `auth_time_from`
     *     at another session to test the mismatch, or pass `auth_time` directly to
     *     write an arbitrary instant.
     */
    async function insertAllow(overrides: Record<string, unknown> = {}): Promise<void> {
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

      // An explicit `auth_time` override wins — that is how an adversarial test
      // writes an arbitrary instant, and how the completeness cases write NULL.
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
      await query(
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

    test('the COMPLETE allow is accepted, and lands at the CURRENT evidence version', async () => {
      // FBL-020-R6-R6 §D1: the current version is 3, not 2. Migration 058 introduced it
      // because §3.1's exact-auth_time rule cannot be applied to rows already stored —
      // `identity_sessions.auth_time` legitimately advances on provider re-authentication
      // — so version 3 is the name of "complete, INCLUDING an authentication instant bound
      // exactly to the named session", and 058 raises the floor to it. The number is read
      // from the exported constant rather than retyped, so this test cannot drift from the
      // writer it describes.
      await insertAllow();
      const row = (await query(`SELECT evidence_version, session_id FROM policy_decisions`))
        .rows[0] as Record<string, unknown>;
      assert.equal(
        Number(row.evidence_version),
        CURRENT_EVIDENCE_VERSION,
        'the default is the CURRENT version',
      );
      assert.equal(Number(row.evidence_version), 3, 'and the current version is 3 (R6-R6 §D1)');
      assert.equal(String(row.session_id), f.sessionId);
    });

    test('a NEW decision missing ANY required evidence is refused', async () => {
      for (const missing of [
        { label: 'the true actor', override: { actor_user_link_id: null } },
        { label: 'the server-generated request id', override: { request_id: null } },
        { label: 'the server-generated correlation id', override: { correlation_id: null } },
        { label: 'the presented session', override: { session_id: null } },
        // FBL-020-R6 §3.1 moved this one to a MORE specific rule, and the expected
        // SQLSTATE says so rather than hiding it: the row names a live session, so
        // the binding trigger compares the omitted instant against that session's
        // own and refuses it BEFORE `pd_credential_group_is_atomic` is evaluated —
        // a BEFORE trigger runs ahead of every CHECK. The refusal is stricter, not
        // weaker, and the message names the session.
        { label: 'the authentication time', override: { auth_time: null }, state: RAISED },
        { label: 'the connection', override: { connection_id: null } },
        { label: 'the provider subject', override: { actor_provider_subject: null } },
        { label: 'the matched scope', override: { scope_level: null, scope_id: null } },
        { label: 'the matched authority', override: { matched_role_binding_ids: null } },
        { label: 'the target tenant', override: { tenant_id: null } },
      ]) {
        await assertSqlState(
          insertAllow(missing.override),
          missing.state ?? CHECK_VIOLATION,
          `a new allow without ${missing.label} must be refused`,
        );
        assert.equal(await countEvidence(), 0, `${missing.label}: nothing was written`);
      }
    });

    test('an ALLOW cannot omit the credential group ENTIRELY', async () => {
      // Distinct from the atomicity rule above: here NOTHING about the presented
      // credential is claimed, so a per-column pairing rule is satisfied and the row
      // would be perfectly consistent — and perfectly useless. An allow that granted an
      // identified actor access must name the credential it believed.
      await assertSqlState(
        insertAllow({
          session_id: null,
          auth_time: null,
          connection_id: null,
          actor_provider_subject: null,
        }),
        CHECK_VIOLATION,
        'an allow with no presented credential at all',
      );
      assert.equal(await countEvidence(), 0);
    });

    test('a DENY may record that no credential was presented — and still not half of one', async () => {
      // The asymmetry is deliberate: "nothing was presented" is frequently the very
      // reason for a denial, so a deny may omit the whole credential group. What it may
      // NOT do is name a session and then fall silent about the rest.
      await insertAllow({
        decision: 'deny',
        reason_code: 'NO_MATCHING_BINDING',
        scope_level: null,
        scope_id: null,
        matched_role_binding_ids: null,
        session_id: null,
        auth_time: null,
        connection_id: null,
        actor_provider_subject: null,
      });
      assert.equal(await countEvidence(), 1);

      const partialDeny = {
        decision: 'deny',
        reason_code: 'NO_MATCHING_BINDING',
        scope_level: null,
        scope_id: null,
        matched_role_binding_ids: null,
      };
      await assertSqlState(
        insertAllow({ ...partialDeny, connection_id: null }),
        CHECK_VIOLATION,
        'a partial credential group on a deny',
      );
      assert.equal(await countEvidence(), 1);

      // FBL-020-R6 §3.1: and a deny that names a session may not go quiet about
      // WHEN that session authenticated either. The rule reaches denies because
      // the trigger is conditional on the session being named, not on the verdict.
      await assertSqlState(
        insertAllow({ ...partialDeny, auth_time: null }),
        RAISED,
        'a deny naming a session but no authentication time',
      );
      assert.equal(await countEvidence(), 1);
    });

    test('a new decision cannot opt back into ANY weaker historic version', async () => {
      /*
       * Without the version floor the discriminator would be a self-certification: a
       * writer could keep claiming an older version and inherit its exemption forever.
       *
       * FBL-020-R6-R6 §D1 — BOTH weaker versions are now probed, and version 2 is the one
       * that matters. 058 exempts version-1 and version-2 decisions from the exact
       * `auth_time` rule, because a session that has since re-authenticated does not
       * falsify the instant a decision was taken at. That exemption is only safe while
       * NOTHING NEW can be written at version 2 — otherwise the fix would have created a
       * fresh way to record an authentication that never happened, which is the hole §3.1
       * was opened over. A version-1 probe alone cannot see that: 057's floor already
       * refused version 1, so the test would pass unchanged against a floor that never
       * moved.
       */
      for (const weaker of [1, 2]) {
        await assertSqlState(
          query(
            `INSERT INTO policy_decisions
               (tenant_id, actor_type, action, decision, reason_code, policy_version,
                evidence_version)
             VALUES ($1, 'user', 'service.ro.view', 'allow', 'ALLOW_ROLE_BINDING',
                     'fbl-020.1', $2)`,
            [f.tenantId, weaker],
          ),
          RAISED,
          `a version-${weaker} INSERT must be refused by the version floor`,
        );
        assert.equal(await countEvidence(), 0);
      }
    });

    test('a HISTORIC version-1 row stays legal, readable, and append-only', async () => {
      // The pre-migration shape, created the only honest way a test can create one: the
      // version floor is a trigger, and disabling it for one statement IS "this row was
      // written before the floor existed". Everything else — the completeness CHECKs,
      // the append-only trigger — stays armed throughout.
      await query(
        `ALTER TABLE policy_decisions DISABLE TRIGGER trg_policy_decisions_current_evidence`,
      );
      try {
        await query(
          `INSERT INTO policy_decisions
             (tenant_id, actor_type, action, decision, reason_code, policy_version,
              evidence_version)
           VALUES ($1, 'user', 'service.ro.view', 'allow', 'ALLOW_ROLE_BINDING',
                   'fbl-020.1', 1)`,
          [f.tenantId],
        );
      } finally {
        await query(
          `ALTER TABLE policy_decisions ENABLE TRIGGER trg_policy_decisions_current_evidence`,
        );
      }

      // IT IS STILL THERE AND STILL READABLE: an allow with no actor, no request id and
      // no presented session — a decision genuinely made with less recorded. Rewriting
      // it would be the real falsification.
      const rows = await query(
        `SELECT decision_id, evidence_version, decision, action, actor_user_link_id,
                request_id, session_id
           FROM policy_decisions`,
      );
      assert.equal(rows.rows.length, 1);
      const row = rows.rows[0] as Record<string, unknown>;
      assert.equal(Number(row.evidence_version), 1);
      assert.equal(String(row.decision), 'allow');
      assert.equal(String(row.action), 'service.ro.view');
      assert.equal(row.actor_user_link_id, null, 'incomplete, and legally so');
      assert.equal(row.request_id, null);
      assert.equal(row.session_id, null);

      // …and it is still EVIDENCE: append-only applies to a version-1 row exactly as it
      // does to a current one.
      await assertSqlState(
        query(`UPDATE policy_decisions SET decision = 'deny' WHERE decision_id = $1`, [
          row.decision_id,
        ]),
        RAISED,
        'a historic row cannot be rewritten',
      );
      await assertSqlState(
        query(`DELETE FROM policy_decisions WHERE decision_id = $1`, [row.decision_id]),
        RAISED,
        'a historic row cannot be deleted',
      );

      // And a NEW complete row lands beside it: history and the present coexist. The
      // present is version 3 (R6-R6 §D1), so this pair also states that the floor moved.
      await insertAllow();
      const versions = (
        await query(`SELECT evidence_version FROM policy_decisions ORDER BY evidence_version`)
      ).rows.map((r) => Number((r as { evidence_version: unknown }).evidence_version));
      assert.deepEqual(versions, [1, 3]);
    });

    test('a HISTORIC version-2 row survives a session that has since re-authenticated', async () => {
      /*
       * FBL-020-R6-R6 §D1 — THE EXEMPTION MIGRATION 058 APPLIES, PROVED FROM BOTH SIDES.
       *
       * §3.1 requires a decision's recorded `auth_time` to BE its named session's. That
       * rule cannot reach backwards: `identity_sessions.auth_time` advances BY DESIGN when
       * a session re-authenticates with the provider (`refreshProviderSession` in
       * `packages/identity-access/src/session.ts`), so a decision written before the
       * re-authentication correctly records an instant the session no longer carries. It is
       * not corrupt evidence; it is what an audit trail is FOR.
       *
       * So 058 keys the rule on evidence_version 3 and leaves versions 1 and 2 alone. This
       * test builds exactly that state — a complete version-2 ALLOW, written the only honest
       * way (the floor disabled for one statement, which IS "written before the floor
       * existed"), and then the session's `auth_time` moved on — and asserts that the row is
       * still there, still readable, still append-only, and STILL DISAGREES with its
       * session. If a future edit re-applied §3.1 to stored rows, or "repaired" them, this
       * test dies.
       */
      await query(
        `ALTER TABLE policy_decisions DISABLE TRIGGER trg_policy_decisions_current_evidence`,
      );
      try {
        await insertAllow({ evidence_version: 2 });
      } finally {
        await query(
          `ALTER TABLE policy_decisions ENABLE TRIGGER trg_policy_decisions_current_evidence`,
        );
      }
      const before = (
        await query(`SELECT decision_id, evidence_version, auth_time FROM policy_decisions`)
      ).rows[0] as Record<string, unknown>;
      assert.equal(Number(before.evidence_version), 2);

      // The provider re-authentication, as its effect on the row the decision names.
      await fixtureAuthorizationStateWrite(
        'simulate-authorization-drift',
        `UPDATE identity_sessions SET auth_time = auth_time + INTERVAL '20 minutes'
          WHERE session_id = $1`,
        [f.sessionId],
      );

      const after = (
        await query(
          `SELECT d.evidence_version, d.auth_time = $2::timestamptz AS auth_time_unchanged,
                  (d.auth_time = s.auth_time) AS agrees_with_its_session
             FROM policy_decisions d JOIN identity_sessions s USING (session_id)
            WHERE d.decision_id = $1`,
          [before.decision_id, before.auth_time],
        )
      ).rows[0] as Record<string, unknown>;
      assert.equal(
        Number(after.evidence_version),
        2,
        'the row keeps the version it was written at',
      );
      assert.equal(after.auth_time_unchanged, true, 'and nothing rewrote its recorded instant');
      assert.equal(
        after.agrees_with_its_session,
        false,
        'the session moved on and the evidence did not — which is the exempt state 058 tolerates',
      );

      // Append-only still applies, so there is no "repair" path for an operator either.
      await assertSqlState(
        query(`UPDATE policy_decisions SET auth_time = NOW() WHERE decision_id = $1`, [
          before.decision_id,
        ]),
        RAISED,
        'the exempt row cannot be rewritten into agreement',
      );

      // …and the CURRENT version is still bound exactly, on the very same session.
      await insertAllow();
      const current = (
        await query(
          `SELECT d.evidence_version, (d.auth_time = s.auth_time) AS agrees_with_its_session
             FROM policy_decisions d JOIN identity_sessions s USING (session_id)
            WHERE d.decision_id <> $1`,
          [before.decision_id],
        )
      ).rows[0] as Record<string, unknown>;
      assert.equal(Number(current.evidence_version), 3);
      assert.equal(
        current.agrees_with_its_session,
        true,
        'a new decision records the session’s CURRENT instant, exactly',
      );
    });

    test('support-access evidence is all three facts or none', async () => {
      const delegated = await supportSessionFor(f.tenantId, f.linkId);
      const supportAllow = {
        actor_type: 'platform_support',
        reason_code: 'ALLOW_SUPPORT_SESSION',
        matched_role_binding_ids: null,
        support_session_id: delegated.sessionId,
        support_request_id: delegated.requestId,
      };

      await assertSqlState(
        insertAllow({ ...supportAllow, support_request_id: null }),
        CHECK_VIOLATION,
        'a support allow that names no approved request',
      );
      // FBL-020-R5 §2 moved this refusal one step earlier and made it more
      // specific. `pd_support_evidence_is_complete` still forbids a version-2
      // support allow with no window at all, but it is no longer what fires:
      // migration 057 §11's BEFORE INSERT trigger compares the recorded window
      // against the session's own, and a missing window is a mismatch, so the
      // error now names the session instead of a column list.
      await assertSqlState(
        insertAllow({ ...supportAllow, support_window_from: null }),
        RAISED,
        'a support allow that names no window',
      );
      await assertSqlState(
        insertAllow({ ...supportAllow, actor_type: 'user' }),
        CHECK_VIOLATION,
        'a support allow attributed to an ordinary user',
      );
      assert.equal(await countEvidence(), 0);

      // the complete shape is accepted — the authority evidence is the support session
      // itself, so the matched-binding list is truthfully empty
      await insertAllow(supportAllow);
      assert.equal(await countEvidence(), 1);
    });

    // ══ FBL-020-R5 §2 — RELATIONAL COHERENCE ════════════════════════════════
    //
    // §2.1: "Version-2 PolicyDecision evidence must be relationally coherent,
    // not merely non-null." Everything above this line tests NON-NULLNESS. The
    // tests below test COHERENCE, and they are separated because before this
    // revision every one of them would have PASSED THE INSERT: measured against
    // the shipped schema, twenty fabricated or cross-wired "complete" version-2
    // allows were attempted and eighteen were accepted.
    //
    // §2.4 requires "both random nonexistent identifiers and cross-wired real
    // rows". The distinction is the whole point: a plain foreign key answers the
    // first and is blind to the second, so a suite that only used random UUIDs
    // would report a control that is not there.

    /**
     * A support request + session in the named tenant, held by the named actor —
     * and, since FBL-020-R6 §3.4, a genuinely APPROVED one.
     *
     * The request used to be left `pending`, and every support test in this file
     * passed anyway. That is the §3.4 finding in miniature: a decision could cite
     * a delegation nobody had approved. Migration 058 asks the request, so the
     * fixture has to build one — separation of duty (a decider who is not the
     * requester) and the approving grant included, because both are schema rules
     * and neither may be faked.
     */
    async function supportSessionFor(
      tenantId: string,
      actorLinkId: string,
      approved: {
        actions?: readonly string[];
        scopeLevel?: string;
        scopeId?: string | null;
        durationMinutes?: number;
        expiresAt?: string;
      } = {},
    ): Promise<{ sessionId: string; requestId: string }> {
      const actions = approved.actions ?? ['service.ro.view'];
      const requestId = String(
        (
          await fixtureAuthorizationStateWrite(
            'seed-authorization-state',
            `INSERT INTO support_access_requests
               (tenant_id, requester_user_link_id, requested_actions, reason,
                requested_duration_minutes, scope_level, scope_id)
             VALUES ($1, $2, $3::text[], 'relational coherence', $4, $5, $6)
             RETURNING request_id`,
            [
              tenantId,
              actorLinkId,
              [...actions],
              approved.durationMinutes ?? 30,
              approved.scopeLevel ?? 'tenant',
              approved.scopeId ?? null,
            ],
          )
        ).rows[0]?.request_id,
      );
      // The approver is a real, separate administrator of this tenant, holding a
      // real single-use grant minted for THIS request — `sar_approval_is_high_assurance`
      // and the two grant tuple keys (057 §7d) all have to resolve.
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
        `UPDATE support_access_requests
            SET status = 'approved', decided_at = NOW(), decided_by_user_link_id = $2,
                approval_grant_id = (
                  SELECT g.grant_id FROM reauthentication_grants g
                   WHERE g.user_link_id = $2
                     AND g.action = 'identity.support.approve'
                     AND g.resource_id = $1)
          WHERE request_id = $1`,
        [requestId, decider],
      );
      const sessionId = String(
        (
          await fixtureAuthorizationStateWrite(
            'seed-authorization-state',
            `INSERT INTO support_access_sessions
               (request_id, tenant_id, actor_user_link_id, expires_at)
             VALUES ($1, $2, $3, ${approved.expiresAt ?? `NOW() + INTERVAL '30 minutes'`})
             RETURNING support_session_id`,
            [requestId, tenantId, actorLinkId],
          )
        ).rows[0]?.support_session_id,
      );
      return { sessionId, requestId };
    }

    /**
     * FBL-020-R6 §3.2 — runs a direct child write with the normalizer's
     * transaction-local marker SET, so the writer guard lets it through and the
     * rule underneath is the one that answers.
     *
     * Migration 058 says in terms that the marker is a guard and not a proof:
     * anyone who can run SQL can also run `set_config`. This helper is that
     * sentence, executed. Every test that uses it is therefore testing the control
     * that survives a forged marker — the equivalence rule, the composite keys,
     * the ordinality index — rather than the guard that merely inconveniences a
     * casual writer.
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

    /**
     * Refusal, attributed to the NAMED control. Asserting only "it threw" would
     * let an unrelated constraint stand in for the one under test — which is
     * exactly how a control can appear to exist and not.
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
          assert.equal(e.code, by.state, `${what}: SQLSTATE`);
          if (by.constraint !== undefined) {
            assert.equal(e.constraint, by.constraint, `${what}: constraint`);
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
      assert.equal(await countEvidence(), 0, `${what}: nothing was written`);
    }

    // ── class (a): identifiers that resolve to nothing ──────────────────────

    test('a decision cannot name a tenant, an actor, a connection or a session that does not exist', async () => {
      await assertRefusedBy(
        insertAllow({ tenant_id: randomUUID(), scope_id: f.tenantId }),
        { state: FK_VIOLATION, constraint: 'pd_tenant_exists' },
        'a decision naming a tenant nobody created',
      );
      await assertRefusedBy(
        insertAllow({ actor_user_link_id: randomUUID() }),
        { state: FK_VIOLATION, constraint: 'pd_actor_exists' },
        'a decision naming an actor nobody created',
      );
      await assertRefusedBy(
        insertAllow({ connection_id: randomUUID() }),
        { state: FK_VIOLATION },
        'a decision naming a connection nobody created',
      );
      await assertRefusedBy(
        // The authentication instant is taken from the REAL session, so the row is
        // otherwise complete and coherent: FBL-020-R6 §3.1's trigger returns quietly
        // for a session that does not exist (`auth_time` is NOT NULL on
        // `identity_sessions`, so an absent session yields no instant to compare
        // against), leaving the composite key as the only rule that can refuse it.
        insertAllow({ session_id: randomUUID(), auth_time_from: f.sessionId }),
        { state: FK_VIOLATION },
        'a decision naming a session nobody created',
      );
    });

    test('a decision cannot claim authority from a role binding that does not exist', async () => {
      // The array could not carry a foreign key, so before §2.3 normalized it
      // this INSERT was the one the fixture itself performed on every test in
      // this file, and it was accepted.
      await assertRefusedBy(
        insertAllow({
          matched_role_binding_ids: [randomUUID()],
          matched_authorization_versions: [1],
        }),
        { state: FK_VIOLATION, constraint: 'pdmb_binding_belongs_to_the_actor' },
        'authority evidence naming a binding nobody granted',
      );
    });

    // ── class (b): cross-tenant actors ──────────────────────────────────────

    test('an ALLOW cannot attribute access in one tenant to a real actor from another', async () => {
      // A REAL person, with a real activated link, a real session and a real
      // granted binding — in the other tenant. Every id resolves; the row is a
      // lie about who was let in.
      await assertRefusedBy(
        insertAllow({
          actor_user_link_id: f.otherLinkId,
          session_id: f.otherSessionId,
          connection_id: f.otherConnectionId,
          actor_provider_subject: f.otherSubject,
          matched_role_binding_ids: [f.otherRoleBindingId],
          matched_authorization_versions: [1],
        }),
        { state: FK_VIOLATION, constraint: 'pd_allow_actor_is_in_its_tenant' },
        'an allow into tenant A attributed to tenant B’s person',
      );
    });

    test('a cross-tenant DENY may still name the foreign actor — that is what it records', async () => {
      // The counterpart, and it is not a leniency: `CROSS_TENANT` is a real
      // reason code and the person really was outside. A constraint that made
      // this row unrepresentable would delete the evidence of the very attempt
      // it is supposed to catch. The retained pre-057 fixture carries one of
      // these (`d0000002-…`), and the upgrade must not abort on it.
      await insertAllow({
        decision: 'deny',
        reason_code: 'CROSS_TENANT',
        scope_level: null,
        scope_id: null,
        matched_role_binding_ids: null,
        actor_user_link_id: f.otherLinkId,
        session_id: f.otherSessionId,
        connection_id: f.otherConnectionId,
        actor_provider_subject: f.otherSubject,
      });
      const row = (
        await query(`SELECT tenant_id, actor_user_link_id, allowed_actor_tenant_id
                       FROM policy_decisions`)
      ).rows[0] as Record<string, unknown>;
      assert.equal(String(row.tenant_id), f.tenantId);
      assert.equal(String(row.actor_user_link_id), f.otherLinkId);
      assert.equal(row.allowed_actor_tenant_id, null, 'the ALLOW-only key stays silent on a deny');
    });

    // ── class (c): cross-wired REAL session / connection / subject / actor ───

    test('a decision cannot cross-wire a real session with another real credential fact', async () => {
      // THE CLASS THAT MATTERS MOST, and the one a plain foreign key misses
      // entirely: in each case below every single column resolves to a real row,
      // and no two of them describe the same credential.
      await assertRefusedBy(
        insertAllow({ connection_id: f.otherConnectionId }),
        { state: FK_VIOLATION, constraint: 'pd_credential_identity_tuple' },
        'this actor’s real session, beside the other tenant’s real connection',
      );
      await assertRefusedBy(
        insertAllow({ actor_provider_subject: f.otherSubject }),
        { state: FK_VIOLATION, constraint: 'pd_credential_identity_tuple' },
        'this actor’s real session, beside another real person’s provider subject',
      );
      await assertRefusedBy(
        insertAllow({ session_id: f.otherSessionId }),
        { state: FK_VIOLATION, constraint: 'pd_credential_identity_tuple' },
        'another real person’s real session, attributed to this actor',
      );
      await assertRefusedBy(
        insertAllow({
          session_id: f.otherSessionId,
          connection_id: f.otherConnectionId,
          actor_provider_subject: f.otherSubject,
        }),
        { state: FK_VIOLATION, constraint: 'pd_credential_identity_tuple' },
        'the other person’s whole real credential, attributed to this actor',
      );
    });

    test('a decision that names a session must name the actor the session belongs to', async () => {
      // Without this the composite key above would be MATCH SIMPLE-silent: one
      // NULL in the referencing list satisfies a composite foreign key without
      // a lookup, so "name the session, forget the actor" would have turned the
      // whole control off.
      await assertRefusedBy(
        insertAllow({ actor_user_link_id: null, actor_type: 'system' }),
        { state: CHECK_VIOLATION, constraint: 'pd_credential_names_its_actor' },
        'a credential recorded against nobody',
      );
    });

    // ── class (d): role-binding authority evidence ──────────────────────────

    test('a decision cannot claim a real role binding that belongs to somebody else', async () => {
      await assertRefusedBy(
        insertAllow({
          matched_role_binding_ids: [f.otherRoleBindingId],
          matched_authorization_versions: [1],
        }),
        { state: FK_VIOLATION, constraint: 'pdmb_binding_belongs_to_the_actor' },
        'authority borrowed from another tenant’s person',
      );
    });

    test('a decision cannot record a role-binding version the binding has never reached', async () => {
      await assertRefusedBy(
        insertAllow({
          matched_role_binding_ids: [f.roleBindingId],
          matched_authorization_versions: [f.roleBindingVersion + 9000],
        }),
        { state: RAISED, message: 'has never reached' },
        'authority claimed at a version from the future',
      );
    });

    test('a decision cannot claim the same role binding twice', async () => {
      await assertRefusedBy(
        insertAllow({
          matched_role_binding_ids: [f.roleBindingId, f.roleBindingId],
          matched_authorization_versions: [f.roleBindingVersion, f.roleBindingVersion],
        }),
        { state: '23505' },
        'the same binding counted twice to inflate what matched',
      );
    });

    test('the matched-binding array is NORMALIZED into rows a foreign key can reach', async () => {
      // §2.3. This is what makes the four tests above possible at all: a UUID[]
      // cannot carry referential integrity, so the array is expanded by the
      // database, in the same statement, into a child row per claim.
      await insertAllow();
      const decisionId = String(
        (
          (await query(`SELECT decision_id FROM policy_decisions`)).rows[0] as Record<
            string,
            unknown
          >
        ).decision_id,
      );
      const rows = (
        await query(
          `SELECT role_binding_id, actor_user_link_id, authorization_version, match_ordinality
             FROM policy_decision_matched_bindings WHERE decision_id = $1`,
          [decisionId],
        )
      ).rows as Array<Record<string, unknown>>;
      assert.equal(rows.length, 1, 'one child row per claimed binding');
      assert.equal(String(rows[0]?.role_binding_id), f.roleBindingId);
      assert.equal(String(rows[0]?.actor_user_link_id), f.linkId);
      assert.equal(Number(rows[0]?.authorization_version), f.roleBindingVersion);
      assert.equal(Number(rows[0]?.match_ordinality), 1);

      // …and the normalized evidence is evidence: append-only, like its parent. Both
      // attempts go through the fixture primitive because the guard classifies this
      // table as authorization state — which is the correct reading, and makes these
      // two writes exactly what `adversarial-bypass-attempt` is for.
      await assertSqlState(
        fixtureAuthorizationStateWrite(
          'adversarial-bypass-attempt',
          `UPDATE policy_decision_matched_bindings SET authorization_version = 99`,
        ),
        RAISED,
        'a normalized authority claim cannot be rewritten',
      );
      await assertSqlState(
        fixtureAuthorizationStateWrite(
          'adversarial-bypass-attempt',
          `DELETE FROM policy_decision_matched_bindings`,
        ),
        RAISED,
        'a normalized authority claim cannot be deleted',
      );
    });

    test('the normalized evidence cannot be written DIRECTLY against another actor', async () => {
      // The expansion trigger copies the decision's own actor into every child row, so
      // through that path the decision↔child agreement is tautological — and a control
      // that only one well-behaved writer can reach is not a control. This is the
      // adversary the trigger does not mediate: somebody writing the child table by
      // hand. The row below names a REAL decision, a REAL other person and the binding
      // that person REALLY holds, so `pdmb_binding_belongs_to_the_actor` is satisfied
      // and the only rule left to refuse it is the one under test.
      await insertAllow();
      const decisionId = String(
        (
          (await query(`SELECT decision_id FROM policy_decisions`)).rows[0] as Record<
            string,
            unknown
          >
        ).decision_id,
      );
      // FBL-020-R6 §3.2 added a writer guard AHEAD of this key, and it now answers
      // first: a BEFORE INSERT trigger precedes every foreign key. That is a
      // stricter refusal, so the original rule is exercised with the guard's marker
      // FORGED — which is also the honest demonstration that the guard is a guard
      // and not a proof, and that the key underneath it is doing the work.
      //
      // The statement is written out at BOTH sites rather than hoisted into a
      // variable, because `scripts/check-owned-mutations.ts` reads the SQL where it
      // is passed: a write to authorization state that reaches the primitive through
      // a variable is invisible to the guard, and being visible to the guard is the
      // whole point of routing it through the primitive.
      await assertSqlState(
        fixtureAuthorizationStateWrite(
          'adversarial-bypass-attempt',
          `INSERT INTO policy_decision_matched_bindings
             (decision_id, role_binding_id, actor_user_link_id, authorization_version,
              match_ordinality)
           VALUES ($1, $2, $3, 1, 2)`,
          [decisionId, f.otherRoleBindingId, f.otherLinkId],
        ),
        RAISED,
        'a child row written directly, with no normalizer behind it',
      );
      await assertSqlState(
        forgingTheNormalizerMarker(decisionId, (executor) =>
          fixtureAuthorizationStateWrite(
            'adversarial-bypass-attempt',
            `INSERT INTO policy_decision_matched_bindings
               (decision_id, role_binding_id, actor_user_link_id, authorization_version,
                match_ordinality)
             VALUES ($1, $2, $3, 1, 2)`,
            [decisionId, f.otherRoleBindingId, f.otherLinkId],
            { executor },
          ),
        ),
        FK_VIOLATION,
        'authority attached to a decision that names a different actor',
      );
      const rows = await query(
        `SELECT actor_user_link_id FROM policy_decision_matched_bindings WHERE decision_id = $1`,
        [decisionId],
      );
      assert.equal(rows.rows.length, 1, 'the smuggled claim was not recorded');
      assert.equal(String((rows.rows[0] as Record<string, unknown>).actor_user_link_id), f.linkId);
    });

    // ── class (e): support session / request / actor tuples ─────────────────

    test('support evidence cannot cross-wire a real session with another real request, tenant or actor', async () => {
      const mine = await supportSessionFor(f.tenantId, f.linkId);
      const theirs = await supportSessionFor(f.otherTenantId, f.otherLinkId);
      const supportAllow = {
        actor_type: 'platform_support',
        reason_code: 'ALLOW_SUPPORT_SESSION',
        matched_role_binding_ids: null,
      };

      await assertRefusedBy(
        insertAllow({
          ...supportAllow,
          support_session_id: mine.sessionId,
          support_request_id: theirs.requestId,
        }),
        { state: FK_VIOLATION, constraint: 'pd_support_evidence_tuple' },
        'a real support session beside a different real approved request',
      );
      await assertRefusedBy(
        insertAllow({
          ...supportAllow,
          support_session_id: theirs.sessionId,
          support_request_id: theirs.requestId,
        }),
        { state: FK_VIOLATION, constraint: 'pd_support_evidence_tuple' },
        'the other tenant’s real support session cited on this tenant’s decision',
      );
      await assertRefusedBy(
        insertAllow({
          ...supportAllow,
          actor_user_link_id: f.otherLinkId,
          session_id: f.otherSessionId,
          connection_id: f.otherConnectionId,
          actor_provider_subject: f.otherSubject,
          support_session_id: mine.sessionId,
          support_request_id: mine.requestId,
        }),
        { state: FK_VIOLATION, constraint: 'pd_support_evidence_tuple' },
        'a real support session attributed to somebody who does not hold it',
      );
      await assertRefusedBy(
        insertAllow({
          ...supportAllow,
          support_session_id: mine.sessionId,
          support_request_id: randomUUID(),
        }),
        { state: FK_VIOLATION, constraint: 'pd_support_evidence_tuple' },
        'a support decision naming an approved request nobody filed',
      );
    });

    test('a support decision cannot record a window its session never had', async () => {
      const mine = await supportSessionFor(f.tenantId, f.linkId);
      const other = await supportSessionFor(f.tenantId, f.linkId);
      const supportAllow = {
        actor_type: 'platform_support',
        reason_code: 'ALLOW_SUPPORT_SESSION',
        matched_role_binding_ids: null,
        support_session_id: mine.sessionId,
        support_request_id: mine.requestId,
      };

      // A REAL instant, taken from a REAL support session — the other one. The
      // window is not a foreign key because PostgreSQL keeps microseconds and a
      // JavaScript Date keeps milliseconds; it is an exact comparison instead.
      await assertRefusedBy(
        insertAllow({ ...supportAllow, support_window_from: other.sessionId }),
        { state: RAISED, message: 'is not the window of support session' },
        'a support allow claiming another session’s window',
      );

      // A support session that does not exist can produce no window at all, so
      // the completeness rule refuses it before the tuple key is reached.
      await assertRefusedBy(
        insertAllow({ ...supportAllow, support_session_id: randomUUID() }),
        { state: CHECK_VIOLATION, constraint: 'pd_support_evidence_is_complete' },
        'a support allow naming a session nobody granted',
      );

      // …and the truthful row, with the window read from the session it names,
      // is accepted.
      await insertAllow(supportAllow);
      assert.equal(await countEvidence(), 1);
    });

    test('a decision that names a support session must name its tenant and its actor', async () => {
      // The MATCH SIMPLE counterpart of `pd_credential_names_its_actor`: a NULL
      // in the referencing list would satisfy `pd_support_evidence_tuple`
      // without a lookup, so support evidence that goes quiet about the tenant
      // it reached into is refused outright.
      const mine = await supportSessionFor(f.tenantId, f.linkId);
      await assertRefusedBy(
        insertAllow({
          actor_type: 'platform_support',
          reason_code: 'ALLOW_SUPPORT_SESSION',
          matched_role_binding_ids: null,
          decision: 'deny',
          tenant_id: null,
          scope_level: null,
          scope_id: null,
          support_session_id: mine.sessionId,
          support_request_id: mine.requestId,
        }),
        { state: CHECK_VIOLATION, constraint: 'pd_support_evidence_is_attributable' },
        'support evidence that names no tenant',
      );
    });
  },
);
