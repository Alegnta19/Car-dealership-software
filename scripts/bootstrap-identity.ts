/**
 * FBL-020 tenant identity bootstrap — the ONLY sanctioned way to mint the
 * first tenant administrator.
 *
 *   DATABASE_URL=... npx tsx scripts/bootstrap-identity.ts \
 *     --tenant-id <uuid> --tenant-name "Delta Motors Group" \
 *     --provider-org org_... --admin-user user_... [--admin-email a@b.c] [--apply]
 *
 * DRY-RUN BY DEFAULT: without --apply it prints the plan and writes nothing.
 * Idempotent: re-running against an already-bootstrapped tenant changes
 * nothing and says so. Ambiguity refuses loudly: a provider organization
 * already mapped to a DIFFERENT tenant, or a tenant already carrying a
 * different active organization, aborts before any write. Prints identifiers
 * only — never a credential, an API key or a cookie value.
 *
 * Every applied step lands in audit_events inside the same transaction
 * (durable outbox delivery is FBL-040 scope and is not claimed here).
 */
import { randomUUID } from 'node:crypto';
import { closePool, withTransaction, type Executor } from '@dealer/database';
import { TENANT_ADMIN_ROLE } from '@dealer/identity-access';

export interface BootstrapOptions {
  tenantId: string;
  tenantName: string;
  providerOrganizationId: string;
  adminProviderUserId: string;
  adminEmail: string | null;
  apply: boolean;
}

export interface BootstrapStep {
  step: string;
  action: 'create' | 'update' | 'exists' | 'refused';
  detail: string;
}

export class BootstrapRefused extends Error {}

interface Row {
  [key: string]: unknown;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function bootstrapIdentity(options: BootstrapOptions): Promise<BootstrapStep[]> {
  if (!UUID_RE.test(options.tenantId)) {
    throw new BootstrapRefused('--tenant-id must be a UUID');
  }
  const steps: BootstrapStep[] = [];
  await withTransaction(async (executor) => {
    await planTenant(executor, options, steps);
    await planConnection(executor, options, steps);
    const userLinkId = await planUserLink(executor, options, steps);
    await planRoleBinding(executor, options, steps, userLinkId);

    if (options.apply) {
      await executor.query(
        `INSERT INTO audit_events (tenant_id, event_type, entity_type, entity_id, actor_user_id, details)
         VALUES ($1, 'identity.bootstrap.applied', 'tenant', $1, NULL, $2)`,
        [
          options.tenantId,
          JSON.stringify({
            steps: steps.map((s) => `${s.step}:${s.action}`),
            provider: 'workos',
          }),
        ],
      );
    }
  });
  return steps;
}

async function planTenant(
  executor: Executor,
  options: BootstrapOptions,
  steps: BootstrapStep[],
): Promise<void> {
  const existing = await executor.query(`SELECT name, status FROM tenants WHERE tenant_id = $1`, [
    options.tenantId,
  ]);
  if (existing.rows.length === 0) {
    steps.push({
      step: 'tenant',
      action: 'create',
      detail: `create active tenant ${options.tenantId}`,
    });
    if (options.apply) {
      await executor.query(
        `INSERT INTO tenants (tenant_id, name, status) VALUES ($1, $2, 'active')`,
        [options.tenantId, options.tenantName],
      );
    }
    return;
  }
  const row = existing.rows[0] as Row;
  if (String(row.status) === 'pending_configuration') {
    steps.push({
      step: 'tenant',
      action: 'update',
      detail: 'activate pending_configuration tenant and set its name',
    });
    if (options.apply) {
      await executor.query(`UPDATE tenants SET name = $2, status = 'active' WHERE tenant_id = $1`, [
        options.tenantId,
        options.tenantName,
      ]);
    }
    return;
  }
  steps.push({ step: 'tenant', action: 'exists', detail: `tenant already ${String(row.status)}` });
}

async function planConnection(
  executor: Executor,
  options: BootstrapOptions,
  steps: BootstrapStep[],
): Promise<void> {
  const byOrg = await executor.query(
    `SELECT tenant_id, status FROM identity_provider_connections
      WHERE provider = 'workos' AND provider_organization_id = $1`,
    [options.providerOrganizationId],
  );
  if (byOrg.rows.length > 0) {
    const row = byOrg.rows[0] as Row;
    if (row.tenant_id === null || String(row.tenant_id) !== options.tenantId) {
      throw new BootstrapRefused(
        'provider organization is already mapped to a different internal home — refusing an ambiguous mapping',
      );
    }
    if (String(row.status) === 'active') {
      steps.push({
        step: 'connection',
        action: 'exists',
        detail: 'active connection already maps this organization',
      });
      return;
    }
    throw new BootstrapRefused(
      'provider organization is mapped but the connection is disabled — re-enable it explicitly, not via bootstrap',
    );
  }
  const activeForTenant = await executor.query(
    `SELECT provider_organization_id FROM identity_provider_connections
      WHERE provider = 'workos' AND tenant_id = $1 AND status = 'active'`,
    [options.tenantId],
  );
  if (activeForTenant.rows.length > 0) {
    throw new BootstrapRefused(
      'tenant already has an active connection to a different provider organization — refusing an ambiguous mapping',
    );
  }
  steps.push({
    step: 'connection',
    action: 'create',
    detail: 'map provider organization to this tenant',
  });
  if (options.apply) {
    await executor.query(
      `INSERT INTO identity_provider_connections (connection_scope, tenant_id, provider, provider_organization_id, status)
       VALUES ('dealership', $1, 'workos', $2, 'active')`,
      [options.tenantId, options.providerOrganizationId],
    );
  }
}

async function planUserLink(
  executor: Executor,
  options: BootstrapOptions,
  steps: BootstrapStep[],
): Promise<string | null> {
  const existing = await executor.query(
    `SELECT user_link_id, status FROM user_links
      WHERE provider = 'workos' AND tenant_id = $1 AND provider_user_id = $2`,
    [options.tenantId, options.adminProviderUserId],
  );
  if (existing.rows.length > 0) {
    const row = existing.rows[0] as Row;
    const id = String(row.user_link_id);
    if (String(row.status) === 'deactivated') {
      throw new BootstrapRefused(
        'the named administrator link is deactivated — refusing to resurrect it here',
      );
    }
    if (String(row.status) === 'pending') {
      steps.push({
        step: 'user_link',
        action: 'update',
        detail: 'activate pending administrator link',
      });
      if (options.apply) {
        await executor.query(
          `UPDATE user_links SET status = 'activated', activated_at = NOW(), email = COALESCE($2, email)
            WHERE user_link_id = $1`,
          [id, options.adminEmail],
        );
      }
      return id;
    }
    steps.push({
      step: 'user_link',
      action: 'exists',
      detail: 'administrator link already activated',
    });
    return id;
  }
  const id = randomUUID();
  steps.push({
    step: 'user_link',
    action: 'create',
    detail: 'create activated administrator link (no roles yet)',
  });
  if (options.apply) {
    await executor.query(
      `INSERT INTO user_links
         (user_link_id, actor_scope, tenant_id, provider, provider_user_id, email, status, activated_at)
       VALUES ($1, 'dealership', $2, 'workos', $3, $4, 'activated', NOW())`,
      [id, options.tenantId, options.adminProviderUserId, options.adminEmail],
    );
    return id;
  }
  return null;
}

async function planRoleBinding(
  executor: Executor,
  options: BootstrapOptions,
  steps: BootstrapStep[],
  userLinkId: string | null,
): Promise<void> {
  if (userLinkId === null) {
    // dry-run for a link that does not exist yet
    steps.push({
      step: 'role_binding',
      action: 'create',
      detail: `grant ${TENANT_ADMIN_ROLE} at tenant scope`,
    });
    return;
  }
  const existing = await executor.query(
    `SELECT role_binding_id FROM role_bindings
      WHERE tenant_id = $1 AND user_link_id = $2 AND role = $3
        AND scope_level = 'tenant' AND scope_id = $1 AND status = 'active'`,
    [options.tenantId, userLinkId, TENANT_ADMIN_ROLE],
  );
  if (existing.rows.length > 0) {
    steps.push({
      step: 'role_binding',
      action: 'exists',
      detail: `${TENANT_ADMIN_ROLE} already granted`,
    });
    return;
  }
  steps.push({
    step: 'role_binding',
    action: 'create',
    detail: `grant ${TENANT_ADMIN_ROLE} at tenant scope`,
  });
  if (options.apply) {
    await executor.query(
      `INSERT INTO role_bindings (tenant_id, user_link_id, role, scope_level, scope_id)
       VALUES ($1, $2, $3, 'tenant', $1)`,
      [options.tenantId, userLinkId, TENANT_ADMIN_ROLE],
    );
  }
}

function parseArgs(argv: readonly string[]): BootstrapOptions {
  const get = (flag: string): string | undefined => {
    const idx = argv.indexOf(flag);
    return idx >= 0 && idx + 1 < argv.length ? argv[idx + 1] : undefined;
  };
  const tenantId = get('--tenant-id');
  const tenantName = get('--tenant-name');
  const providerOrganizationId = get('--provider-org');
  const adminProviderUserId = get('--admin-user');
  if (!tenantId || !tenantName || !providerOrganizationId || !adminProviderUserId) {
    console.error(
      'usage: bootstrap-identity.ts --tenant-id <uuid> --tenant-name <name> --provider-org <org> --admin-user <user> [--admin-email <email>] [--apply]',
    );
    process.exit(2);
  }
  return {
    tenantId,
    tenantName,
    providerOrganizationId,
    adminProviderUserId,
    adminEmail: get('--admin-email') ?? null,
    apply: argv.includes('--apply'),
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const steps = await bootstrapIdentity(options);
  const mode = options.apply ? 'APPLIED' : 'DRY-RUN (nothing written; pass --apply to execute)';
  console.log(`bootstrap ${mode}`);
  for (const step of steps) {
    console.log(`  ${step.step}: ${step.action} — ${step.detail}`);
  }
}

// Only run as a CLI, never on import (tests import bootstrapIdentity directly).
if (process.argv[1] !== undefined && /bootstrap-identity\.ts$/.test(process.argv[1])) {
  main()
    .catch((err) => {
      if (err instanceof BootstrapRefused) {
        console.error('REFUSED: ' + err.message);
      } else {
        console.error(err);
      }
      process.exitCode = 1;
    })
    .finally(() => closePool());
}
