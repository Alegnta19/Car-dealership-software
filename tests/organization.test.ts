import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, beforeEach, describe, test } from 'node:test';
import { resetDatabase, skipIntegration } from '@dealer/test-kit';
import { closePool, query } from '@dealer/database';
import {
  ORGANIZATION_LEVELS,
  childLevel,
  createDealerGroup,
  createDepartment,
  createLegalEntity,
  createRooftop,
  createTenant,
  getTenant,
  isAtOrAbove,
  isEffectiveAt,
  listRooftops,
  parentLevel,
  resolveAncestry,
  setUnitStatus,
} from '@dealer/organization';

function sha256hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Error code helper: asserts the promise rejects with the given SQLSTATE. */
async function assertSqlState(
  promise: Promise<unknown>,
  code: string,
  label: string,
): Promise<void> {
  try {
    await promise;
    assert.fail(`${label}: expected SQLSTATE ${code}, but the statement succeeded`);
  } catch (err) {
    const actual = (err as { code?: string }).code;
    assert.equal(
      actual,
      code,
      `${label}: expected SQLSTATE ${code}, got ${String(actual)}: ${String(err)}`,
    );
  }
}

const FK_VIOLATION = '23503';
const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';
const RAISED = 'P0001';

// ── pure model helpers: no database required ────────────────────────────────

describe('organization model (pure)', () => {
  test('hierarchy order and navigation', () => {
    assert.deepEqual(ORGANIZATION_LEVELS, [
      'tenant',
      'dealer_group',
      'legal_entity',
      'rooftop',
      'department',
    ]);
    assert.equal(parentLevel('tenant'), null);
    assert.equal(parentLevel('department'), 'rooftop');
    assert.equal(childLevel('tenant'), 'dealer_group');
    assert.equal(childLevel('department'), null);
    assert.ok(isAtOrAbove('tenant', 'department'));
    assert.ok(isAtOrAbove('rooftop', 'rooftop'));
    assert.ok(!isAtOrAbove('department', 'rooftop'));
  });

  test('effective-status resolution denies every non-active status', () => {
    const now = new Date('2026-07-01T12:00:00Z');
    const base = { effectiveFrom: new Date('2026-01-01T00:00:00Z'), effectiveTo: null };
    assert.ok(isEffectiveAt({ ...base, status: 'active' }, now));
    for (const status of ['pending_configuration', 'inactive', 'suspended', 'archived']) {
      assert.ok(!isEffectiveAt({ ...base, status }, now), `${status} must not be effective`);
    }
    // window edges: [from, to)
    const windowed = {
      status: 'active',
      effectiveFrom: new Date('2026-07-01T00:00:00Z'),
      effectiveTo: new Date('2026-08-01T00:00:00Z'),
    };
    assert.ok(isEffectiveAt(windowed, new Date('2026-07-01T00:00:00Z')));
    assert.ok(!isEffectiveAt(windowed, new Date('2026-08-01T00:00:00Z')));
    assert.ok(!isEffectiveAt(windowed, new Date('2026-06-30T23:59:59Z')));
  });
});

// ── migration-055 invariants: real database required ───────────────────────

describe(
  'identity/organization schema (migration 055)',
  { skip: skipIntegration ? 'set TEST_DATABASE_URL to run' : false },
  () => {
    after(async () => {
      await closePool();
    });

    beforeEach(async () => {
      await resetDatabase();
    });

    async function seedChain() {
      const tenant = await createTenant({ name: 'Delta Motors Group', status: 'active' });
      const group = await createDealerGroup({
        tenantId: tenant.tenantId,
        name: 'Metro Group',
        status: 'active',
      });
      const entity = await createLegalEntity({
        tenantId: tenant.tenantId,
        dealerGroupId: group.dealerGroupId,
        name: 'Delta Motors LLC',
        status: 'active',
      });
      const rooftop = await createRooftop({
        tenantId: tenant.tenantId,
        legalEntityId: entity.legalEntityId,
        name: 'Main Street Store',
        status: 'active',
      });
      const department = await createDepartment({
        tenantId: tenant.tenantId,
        rooftopId: rooftop.rooftopId,
        code: 'service',
        name: 'Service Department',
        status: 'active',
      });
      return { tenant, group, entity, rooftop, department };
    }

    async function seedUserLink(tenantId: string | null): Promise<string> {
      const result = await query(
        `INSERT INTO user_links (actor_scope, tenant_id, provider, provider_user_id, status, activated_at)
       VALUES ($1, $2, 'workos', $3, 'activated', NOW()) RETURNING user_link_id`,
        [tenantId === null ? 'platform' : 'dealership', tenantId, 'user_' + randomUUID()],
      );
      return String((result.rows[0] as { user_link_id: unknown }).user_link_id);
    }

    test('full hierarchy chain persists and resolves, tenant first', async () => {
      const { tenant, group, entity, rooftop, department } = await seedChain();
      assert.equal((await getTenant(tenant.tenantId))?.name, 'Delta Motors Group');

      const ancestry = await resolveAncestry(tenant.tenantId, {
        level: 'department',
        id: department.departmentId,
      });
      assert.deepEqual(ancestry, [
        { level: 'tenant', id: tenant.tenantId },
        { level: 'dealer_group', id: group.dealerGroupId },
        { level: 'legal_entity', id: entity.legalEntityId },
        { level: 'rooftop', id: rooftop.rooftopId },
        { level: 'department', id: department.departmentId },
      ]);
      assert.equal((await listRooftops(tenant.tenantId)).length, 1);
    });

    test('cross-tenant parentage is a database error, and cross-tenant lookups resolve to null', async () => {
      const a = await seedChain();
      const b = await createTenant({ name: 'Rival Group', status: 'active' });

      // legal entity in tenant B pointing at tenant A's dealer group
      await assertSqlState(
        createLegalEntity({
          tenantId: b.tenantId,
          dealerGroupId: a.group.dealerGroupId,
          name: 'Impostor LLC',
        }),
        FK_VIOLATION,
        'cross-tenant dealer_group parent',
      );
      // rooftop in tenant B pointing at tenant A's legal entity
      await assertSqlState(
        createRooftop({
          tenantId: b.tenantId,
          legalEntityId: a.entity.legalEntityId,
          name: 'Impostor Store',
        }),
        FK_VIOLATION,
        'cross-tenant legal_entity parent',
      );
      // a node id from another tenant is indistinguishable from a nonexistent one
      assert.equal(
        await resolveAncestry(b.tenantId, { level: 'rooftop', id: a.rooftop.rooftopId }),
        null,
      );
      assert.equal(
        await resolveAncestry(b.tenantId, { level: 'department', id: randomUUID() }),
        null,
      );
    });

    test('name uniqueness is tenant-qualified, case-insensitive, and archives free the name', async () => {
      const a = await seedChain();
      const b = await createTenant({ name: 'Second Tenant', status: 'active' });

      // the same name in ANOTHER tenant is fine
      await createDealerGroup({ tenantId: b.tenantId, name: 'Metro Group' });
      // duplicate (case-insensitive) in the SAME tenant is not
      await assertSqlState(
        createDealerGroup({ tenantId: a.tenant.tenantId, name: 'METRO GROUP' }),
        UNIQUE_VIOLATION,
        'same-tenant duplicate group name',
      );
      // archiving is the only retirement — and it releases the name
      assert.ok(
        await setUnitStatus('dealer_group', a.tenant.tenantId, a.group.dealerGroupId, 'archived'),
      );
      const again = await createDealerGroup({ tenantId: a.tenant.tenantId, name: 'Metro Group' });
      assert.notEqual(again.dealerGroupId, a.group.dealerGroupId);
    });

    test('policy_decisions is append-only: INSERT works, UPDATE and DELETE are impossible', async () => {
      const { tenant } = await seedChain();
      const inserted = await query(
        `INSERT INTO policy_decisions (tenant_id, actor_type, action, decision, reason_code, policy_version)
       VALUES ($1, 'user', 'service.ro.close', 'deny', 'NO_MATCHING_BINDING', 'fbl-020.1')
       RETURNING decision_id`,
        [tenant.tenantId],
      );
      const id = String((inserted.rows[0] as { decision_id: unknown }).decision_id);

      await assertSqlState(
        query(`UPDATE policy_decisions SET decision = 'allow' WHERE decision_id = $1`, [id]),
        RAISED,
        'UPDATE on policy evidence',
      );
      await assertSqlState(
        query(`DELETE FROM policy_decisions WHERE decision_id = $1`, [id]),
        RAISED,
        'DELETE on policy evidence',
      );
      // the row is untouched
      const still = await query(`SELECT decision FROM policy_decisions WHERE decision_id = $1`, [
        id,
      ]);
      assert.equal((still.rows[0] as { decision: string }).decision, 'deny');
    });

    test('user_links: actor scope pairing and NULLS NOT DISTINCT uniqueness', async () => {
      const { tenant } = await seedChain();

      // dealership scope REQUIRES a tenant; platform scope FORBIDS one
      await assertSqlState(
        query(
          `INSERT INTO user_links (actor_scope, tenant_id, provider, provider_user_id)
         VALUES ('dealership', NULL, 'workos', 'user_x1')`,
        ),
        CHECK_VIOLATION,
        'dealership link without tenant',
      );
      await assertSqlState(
        query(
          `INSERT INTO user_links (actor_scope, tenant_id, provider, provider_user_id)
         VALUES ('platform', $1, 'workos', 'user_x2')`,
          [tenant.tenantId],
        ),
        CHECK_VIOLATION,
        'platform link with tenant',
      );

      // duplicate provider identity within one tenant
      await query(
        `INSERT INTO user_links (actor_scope, tenant_id, provider, provider_user_id)
       VALUES ('dealership', $1, 'workos', 'user_dup')`,
        [tenant.tenantId],
      );
      await assertSqlState(
        query(
          `INSERT INTO user_links (actor_scope, tenant_id, provider, provider_user_id)
         VALUES ('dealership', $1, 'workos', 'user_dup')`,
          [tenant.tenantId],
        ),
        UNIQUE_VIOLATION,
        'duplicate dealership provider identity',
      );
      // the platform (NULL-tenant) slot is also unique — NULLS NOT DISTINCT
      await query(
        `INSERT INTO user_links (actor_scope, tenant_id, provider, provider_user_id)
       VALUES ('platform', NULL, 'workos', 'user_platform_dup')`,
      );
      await assertSqlState(
        query(
          `INSERT INTO user_links (actor_scope, tenant_id, provider, provider_user_id)
         VALUES ('platform', NULL, 'workos', 'user_platform_dup')`,
        ),
        UNIQUE_VIOLATION,
        'duplicate platform provider identity (NULL tenant must not bypass uniqueness)',
      );
      // no invented provider: only workos is enableable at the database layer
      await assertSqlState(
        query(
          `INSERT INTO user_links (actor_scope, tenant_id, provider, provider_user_id)
         VALUES ('dealership', $1, 'saml', 'user_x3')`,
          [tenant.tenantId],
        ),
        CHECK_VIOLATION,
        'non-workos provider',
      );
    });

    test('identity_sessions: digest-only storage and tenant-coherent user link', async () => {
      const { tenant } = await seedChain();
      const other = await createTenant({ name: 'Other Tenant', status: 'active' });
      const link = await seedUserLink(tenant.tenantId);

      // raw (non-64-hex) token storage is rejected structurally
      await assertSqlState(
        query(
          `INSERT INTO identity_sessions (tenant_id, user_link_id, session_token_hash, auth_time, expires_at)
         VALUES ($1, $2, 'raw-session-token-value', NOW(), NOW() + INTERVAL '8 hours')`,
          [tenant.tenantId, link],
        ),
        CHECK_VIOLATION,
        'non-digest session token',
      );
      // a session cannot claim tenant B over tenant A's user link
      await assertSqlState(
        query(
          `INSERT INTO identity_sessions (tenant_id, user_link_id, session_token_hash, auth_time, expires_at)
         VALUES ($1, $2, $3, NOW(), NOW() + INTERVAL '8 hours')`,
          [other.tenantId, link, sha256hex('session-a')],
        ),
        FK_VIOLATION,
        'cross-tenant session over user link',
      );
      // the digest of the opaque value is what a session stores
      await query(
        `INSERT INTO identity_sessions (tenant_id, user_link_id, session_token_hash, auth_time, expires_at)
       VALUES ($1, $2, $3, NOW(), NOW() + INTERVAL '8 hours')`,
        [tenant.tenantId, link, sha256hex('session-a')],
      );
    });

    test('role_bindings: platform shape, active-binding uniqueness, revoke-then-regrant', async () => {
      const { tenant, rooftop } = await seedChain();
      const link = await seedUserLink(tenant.tenantId);
      const platformLink = await seedUserLink(null);

      // platform bindings are tenant-less and scope-less — no other combination
      await assertSqlState(
        query(
          `INSERT INTO role_bindings (tenant_id, user_link_id, role, scope_level, scope_id)
         VALUES ($1, $2, 'platform_admin', 'platform', $3)`,
          [tenant.tenantId, link, rooftop.rooftopId],
        ),
        CHECK_VIOLATION,
        'platform binding with tenant/scope',
      );
      await query(
        `INSERT INTO role_bindings (tenant_id, user_link_id, role, scope_level, scope_id)
       VALUES (NULL, $1, 'platform_admin', 'platform', NULL)`,
        [platformLink],
      );

      // duplicate ACTIVE binding is rejected — including the NULL-bearing platform shape
      await assertSqlState(
        query(
          `INSERT INTO role_bindings (tenant_id, user_link_id, role, scope_level, scope_id)
         VALUES (NULL, $1, 'platform_admin', 'platform', NULL)`,
          [platformLink],
        ),
        UNIQUE_VIOLATION,
        'duplicate active platform binding',
      );

      // dealership binding, revoke, re-grant: allowed (uniqueness is on ACTIVE only)
      await query(
        `INSERT INTO role_bindings (tenant_id, user_link_id, role, scope_level, scope_id)
       VALUES ($1, $2, 'service_manager', 'rooftop', $3)`,
        [tenant.tenantId, link, rooftop.rooftopId],
      );
      await query(
        `UPDATE role_bindings SET status = 'revoked', revoked_at = NOW()
        WHERE user_link_id = $1 AND status = 'active' AND scope_level = 'rooftop'`,
        [link],
      );
      await query(
        `INSERT INTO role_bindings (tenant_id, user_link_id, role, scope_level, scope_id)
       VALUES ($1, $2, 'service_manager', 'rooftop', $3)`,
        [tenant.tenantId, link, rooftop.rooftopId],
      );
    });

    test('reauthentication: hash-only storage, one grant per transaction, atomic single consumption', async () => {
      const { tenant } = await seedChain();
      const link = await seedUserLink(tenant.tenantId);

      const txn = await query(
        `INSERT INTO reauthentication_transactions (tenant_id, user_link_id, action, nonce_hash, expires_at)
       VALUES ($1, $2, 'service.estimate.approve', $3, NOW() + INTERVAL '5 minutes')
       RETURNING reauth_txn_id`,
        [tenant.tenantId, link, sha256hex('nonce-1')],
      );
      const txnId = String((txn.rows[0] as { reauth_txn_id: unknown }).reauth_txn_id);

      // a raw grant value cannot be stored
      await assertSqlState(
        query(
          `INSERT INTO reauthentication_grants (reauth_txn_id, tenant_id, user_link_id, action, grant_hash, expires_at)
         VALUES ($1, $2, $3, 'service.estimate.approve', 'plainly-not-a-digest', NOW() + INTERVAL '2 minutes')`,
          [txnId, tenant.tenantId, link],
        ),
        CHECK_VIOLATION,
        'raw grant storage',
      );
      await query(
        `INSERT INTO reauthentication_grants (reauth_txn_id, tenant_id, user_link_id, action, grant_hash, expires_at)
       VALUES ($1, $2, $3, 'service.estimate.approve', $4, NOW() + INTERVAL '2 minutes')`,
        [txnId, tenant.tenantId, link, sha256hex('grant-1')],
      );
      // a second grant for the same transaction is impossible
      await assertSqlState(
        query(
          `INSERT INTO reauthentication_grants (reauth_txn_id, tenant_id, user_link_id, action, grant_hash, expires_at)
         VALUES ($1, $2, $3, 'service.estimate.approve', $4, NOW() + INTERVAL '2 minutes')`,
          [txnId, tenant.tenantId, link, sha256hex('grant-2')],
        ),
        UNIQUE_VIOLATION,
        'second grant per transaction',
      );

      // atomic consumption: exactly one of two racing consumers wins
      const consume = () =>
        query(
          `UPDATE reauthentication_grants
            SET consumed_at = NOW(), consumed_request_id = $2
          WHERE grant_hash = $1 AND consumed_at IS NULL AND expires_at > NOW()`,
          [sha256hex('grant-1'), 'req_' + randomUUID()],
        );
      const [first, second] = await Promise.all([consume(), consume()]);
      const wins = (first.rowCount ?? 0) + (second.rowCount ?? 0);
      assert.equal(wins, 1, 'exactly one consumption must win');
      // and a replay after the fact touches nothing
      assert.equal((await consume()).rowCount ?? 0, 0);
    });

    test('support access: different-user approval and the structural 60-minute ceiling', async () => {
      const { tenant } = await seedChain();
      const requester = await seedUserLink(null);
      const approver = await seedUserLink(tenant.tenantId);

      // duration beyond 60 minutes cannot even be REQUESTED
      await assertSqlState(
        query(
          `INSERT INTO support_access_requests (tenant_id, requester_user_link_id, requested_actions, reason, requested_duration_minutes)
         VALUES ($1, $2, ARRAY['service.ro.read'], 'ticket 4821: verify RO totals', 61)`,
          [tenant.tenantId, requester],
        ),
        CHECK_VIOLATION,
        'over-60-minute request',
      );

      const req = await query(
        `INSERT INTO support_access_requests (tenant_id, requester_user_link_id, requested_actions, reason, requested_duration_minutes)
       VALUES ($1, $2, ARRAY['service.ro.read'], 'ticket 4821: verify RO totals', 30)
       RETURNING request_id`,
        [tenant.tenantId, requester],
      );
      const requestId = String((req.rows[0] as { request_id: unknown }).request_id);

      // self-approval is structurally impossible
      await assertSqlState(
        query(
          `UPDATE support_access_requests
            SET status = 'approved', decided_by_user_link_id = $2, decided_at = NOW()
          WHERE request_id = $1`,
          [requestId, requester],
        ),
        CHECK_VIOLATION,
        'self-approval',
      );
      // a different user approves
      await query(
        `UPDATE support_access_requests
          SET status = 'approved', decided_by_user_link_id = $2, decided_at = NOW()
        WHERE request_id = $1`,
        [requestId, approver],
      );

      // a session longer than 60 minutes cannot exist
      await assertSqlState(
        query(
          `INSERT INTO support_access_sessions (request_id, tenant_id, actor_user_link_id, expires_at)
         VALUES ($1, $2, $3, NOW() + INTERVAL '61 minutes')`,
          [requestId, tenant.tenantId, requester],
        ),
        CHECK_VIOLATION,
        'over-60-minute session',
      );
      await query(
        `INSERT INTO support_access_sessions (request_id, tenant_id, actor_user_link_id, expires_at)
       VALUES ($1, $2, $3, NOW() + INTERVAL '30 minutes')`,
        [requestId, tenant.tenantId, requester],
      );
      // one session per request
      await assertSqlState(
        query(
          `INSERT INTO support_access_sessions (request_id, tenant_id, actor_user_link_id, expires_at)
         VALUES ($1, $2, $3, NOW() + INTERVAL '10 minutes')`,
          [requestId, tenant.tenantId, requester],
        ),
        UNIQUE_VIOLATION,
        'second session for one request',
      );
    });

    test('identity_provider_connections: one active connection per tenant, one home per external org', async () => {
      const { tenant } = await seedChain();
      const other = await createTenant({ name: 'Other Group', status: 'active' });

      await query(
        `INSERT INTO identity_provider_connections
         (connection_scope, tenant_id, provider, provider_organization_id, issuer)
       VALUES ('dealership', $1, 'workos', 'org_alpha', 'https://issuer.test.local')`,
        [tenant.tenantId],
      );
      // an external organization maps to exactly one internal home
      await assertSqlState(
        query(
          `INSERT INTO identity_provider_connections
           (connection_scope, tenant_id, provider, provider_organization_id, issuer)
         VALUES ('dealership', $1, 'workos', 'org_alpha', 'https://issuer.test.local')`,
          [other.tenantId],
        ),
        UNIQUE_VIOLATION,
        'external org claimed by second tenant',
      );
      // a second ACTIVE connection for the same tenant is rejected
      await assertSqlState(
        query(
          `INSERT INTO identity_provider_connections
           (connection_scope, tenant_id, provider, provider_organization_id, issuer)
         VALUES ('dealership', $1, 'workos', 'org_beta', 'https://issuer.test.local')`,
          [tenant.tenantId],
        ),
        UNIQUE_VIOLATION,
        'second active connection per tenant',
      );
      // ...but a DISABLED one can coexist (history preserved, no hard delete)
      await query(
        `INSERT INTO identity_provider_connections
         (connection_scope, tenant_id, provider, provider_organization_id, status, issuer)
       VALUES ('dealership', $1, 'workos', 'org_beta', 'disabled', 'https://issuer.test.local')`,
        [tenant.tenantId],
      );
    });
  },
);
