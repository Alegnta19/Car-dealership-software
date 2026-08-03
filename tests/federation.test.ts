import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, beforeEach, describe, test } from 'node:test';
import { resetDatabase, skipIntegration } from '@dealer/test-kit';
import { closePool, query } from '@dealer/database';
import { FederationNotEnabled, createSamlPort, createScimPort } from '@dealer/identity-access';

/**
 * SAML/SCIM are INTERFACES ONLY in FBL-020. These tests are the executable
 * statement of that boundary: the shapes compile and are reachable, every
 * operation refuses, and the database itself cannot hold a non-WorkOS
 * connection — so no configuration flag or code path can quietly enable
 * federation before the order that reviews it.
 */
describe('enterprise federation is interface-only', () => {
  test('every SAML operation refuses with FederationNotEnabled', async () => {
    const saml = createSamlPort();
    await assert.rejects(() => saml.describeConnection(randomUUID()), FederationNotEnabled);
    await assert.rejects(
      () => saml.consumeAssertion({ tenantId: randomUUID(), samlResponse: 'x', relayState: null }),
      FederationNotEnabled,
    );
  });

  test('every SCIM operation refuses with FederationNotEnabled', async () => {
    const scim = createScimPort();
    const tenantId = randomUUID();
    await assert.rejects(
      () =>
        scim.provisionUser(tenantId, {
          externalId: 'ext-1',
          userName: 'someone',
          active: true,
          emails: [{ value: 'a@b.c', primary: true }],
          displayName: null,
        }),
      FederationNotEnabled,
    );
    await assert.rejects(() => scim.deprovisionUser(tenantId, 'ext-1'), FederationNotEnabled);
    await assert.rejects(
      () => scim.syncGroup(tenantId, { externalId: 'g-1', displayName: 'Advisors', memberExternalIds: [] }),
      FederationNotEnabled,
    );
  });

  test('the SCIM port exposes NO role-granting operation — privilege stays an internal act', () => {
    const scim = createScimPort() as unknown as Record<string, unknown>;
    for (const forbidden of ['grantRole', 'assignRole', 'syncRoles', 'provisionRoleBinding']) {
      assert.equal(scim[forbidden], undefined, `${forbidden} must not exist on the SCIM port`);
    }
  });
});

describe('federation cannot be enabled at the database layer', { skip: skipIntegration ? 'set TEST_DATABASE_URL to run' : false }, () => {
  after(async () => {
    await closePool();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  test('a saml or scim provider connection is rejected by migration 055', async () => {
    const tenant = await query(
      `INSERT INTO tenants (name, status) VALUES ('Federation Tenant', 'active') RETURNING tenant_id`,
    );
    const tenantId = String((tenant.rows[0] as { tenant_id: unknown }).tenant_id);
    for (const provider of ['saml', 'scim', 'okta']) {
      await assert.rejects(
        () =>
          query(
            `INSERT INTO identity_provider_connections (connection_scope, tenant_id, provider, provider_organization_id)
             VALUES ('dealership', $1, $2, 'org_x')`,
            [tenantId, provider],
          ),
        (err: unknown) => (err as { code?: string }).code === '23514',
        `provider ${provider} must be refused by the CHECK constraint`,
      );
    }
  });
});
