import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, beforeEach, describe, test } from 'node:test';
import {
  certifyMfaPolicy,
  ensureActiveConnection,
  resetDatabase,
  seedLocalSession,
  skipIntegration,
  fixtureAuthorizationStateWrite,
  seedTenantViaService,
} from '@dealer/test-kit';
import { closePool, query } from '@dealer/database';

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

    /** A complete, coherent identity chain: tenant → connection → link → live session. */
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
      return {
        tenantId: tenant.tenantId,
        otherTenantId: other.tenantId,
        connectionId: String(bound.connection_id),
        issuer: String(bound.issuer),
        organizationId: String(bound.provider_organization_id),
        linkId,
        subject,
        sessionId: session.sessionId,
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
     * exactly one fact removed, written out in full rather than generated, so the
     * reader can see what is missing and the failure is attributable to that alone.
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
        auth_time: new Date(),
        connection_id: f.connectionId,
        actor_provider_subject: f.subject,
        ...overrides,
      };
      // The matched-binding arrays are appended as literals below, so the pseudo-key
      // `matched_role_binding_ids` must not also appear in the column list.
      const emptyAuthority = row.matched_role_binding_ids === null;
      delete row.matched_role_binding_ids;
      const columns = Object.keys(row);
      const placeholders = columns.map((_, i) => `$${i + 1}`);
      const matched = emptyAuthority
        ? `'{}'::uuid[], '{}'::bigint[]`
        : `ARRAY['${randomUUID()}']::uuid[], ARRAY[1]::bigint[]`;
      await query(
        `INSERT INTO policy_decisions (${columns.join(', ')},
            matched_role_binding_ids, matched_authorization_versions)
         VALUES (${placeholders.join(', ')}, ${matched})`,
        columns.map((c) => row[c]),
      );
    }

    test('the COMPLETE version-2 allow is accepted, and lands at the current version', async () => {
      await insertAllow();
      const row = (await query(`SELECT evidence_version, session_id FROM policy_decisions`))
        .rows[0] as Record<string, unknown>;
      assert.equal(Number(row.evidence_version), 2, 'the default is the CURRENT version');
      assert.equal(String(row.session_id), f.sessionId);
    });

    test('a NEW decision missing ANY required evidence is refused', async () => {
      for (const missing of [
        { label: 'the true actor', override: { actor_user_link_id: null } },
        { label: 'the server-generated request id', override: { request_id: null } },
        { label: 'the server-generated correlation id', override: { correlation_id: null } },
        { label: 'the presented session', override: { session_id: null } },
        { label: 'the authentication time', override: { auth_time: null } },
        { label: 'the connection', override: { connection_id: null } },
        { label: 'the provider subject', override: { actor_provider_subject: null } },
        { label: 'the matched scope', override: { scope_level: null, scope_id: null } },
        { label: 'the matched authority', override: { matched_role_binding_ids: null } },
        { label: 'the target tenant', override: { tenant_id: null } },
      ]) {
        await assertSqlState(
          insertAllow(missing.override),
          CHECK_VIOLATION,
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

      await assertSqlState(
        insertAllow({
          decision: 'deny',
          reason_code: 'NO_MATCHING_BINDING',
          scope_level: null,
          scope_id: null,
          matched_role_binding_ids: null,
          auth_time: null,
        }),
        CHECK_VIOLATION,
        'a partial credential group on a deny',
      );
      assert.equal(await countEvidence(), 1);
    });

    test('a new decision cannot opt back into the WEAKER historic version', async () => {
      // Without the version floor the discriminator would be a self-certification: a
      // writer could keep claiming version 1 and inherit the historic exemption forever.
      await assertSqlState(
        query(
          `INSERT INTO policy_decisions
             (tenant_id, actor_type, action, decision, reason_code, policy_version,
              evidence_version)
           VALUES ($1, 'user', 'service.ro.view', 'allow', 'ALLOW_ROLE_BINDING',
                   'fbl-020.1', 1)`,
          [f.tenantId],
        ),
        RAISED,
        'a version-1 INSERT must be refused by the version floor',
      );
      assert.equal(await countEvidence(), 0);
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
      // does to a version-2 one.
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

      // And a NEW complete row lands beside it: history and the present coexist.
      await insertAllow();
      const versions = (
        await query(`SELECT evidence_version FROM policy_decisions ORDER BY evidence_version`)
      ).rows.map((r) => Number((r as { evidence_version: unknown }).evidence_version));
      assert.deepEqual(versions, [1, 2]);
    });

    test('support-access evidence is all three facts or none', async () => {
      const requestId = String(
        (
          await fixtureAuthorizationStateWrite(
            'seed-authorization-state',
            `INSERT INTO support_access_requests
               (tenant_id, requester_user_link_id, requested_actions, reason,
                requested_duration_minutes)
             VALUES ($1, $2, ARRAY['service.ro.view'], 'ticket 2', 30)
             RETURNING request_id`,
            [f.tenantId, f.linkId],
          )
        ).rows[0]?.request_id,
      );
      const s = (
        await fixtureAuthorizationStateWrite(
          'seed-authorization-state',
          `INSERT INTO support_access_sessions
             (request_id, tenant_id, actor_user_link_id, expires_at)
           VALUES ($1, $2, $3, NOW() + INTERVAL '30 minutes')
           RETURNING support_session_id, expires_at`,
          [requestId, f.tenantId, f.linkId],
        )
      ).rows[0] as Record<string, unknown>;

      const supportAllow = {
        actor_type: 'platform_support',
        reason_code: 'ALLOW_SUPPORT_SESSION',
        matched_role_binding_ids: null,
        support_session_id: String(s.support_session_id),
        support_request_id: requestId,
        support_session_expires_at: s.expires_at,
      };

      await assertSqlState(
        insertAllow({ ...supportAllow, support_request_id: null }),
        CHECK_VIOLATION,
        'a support allow that names no approved request',
      );
      await assertSqlState(
        insertAllow({ ...supportAllow, support_session_expires_at: null }),
        CHECK_VIOLATION,
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
  },
);
