/**
 * FBL-020-R4 §5 — THE ORIGIN OF TRUST, AS AN ATTRIBUTED SERVICE.
 *
 * WHY THIS MODULE EXISTS. `scripts/bootstrap-identity.ts` used to hold six raw
 * writes of its own — a tenant, a provider connection, a user link, a role binding
 * — outside the owned mutation boundary entirely. Every one of them wrote
 * authorization state with no acting user on the row, no advancing
 * `authorization_version`, and (except for one summary event) no audit trail; and
 * because the script decided what to write from reads it had taken BEFORE its
 * transaction, two concurrent runs could each see "nothing here yet" and both
 * proceed. The order's instruction is exact: route bootstrap writes through
 * explicit attributed services. This is that service, and the script is now a CLI
 * around it.
 *
 * THE ONE HONEST DIFFICULTY, STATED RATHER THAN PAPERED OVER. Every other mutation
 * in this package demands an EXISTING acting user link, because a change nobody
 * performed is exactly what the attribution rules exist to forbid. At bootstrap
 * there is by definition nobody: the administrator being minted IS the first actor.
 * So this service does the only thing that is true — it mints that link FIRST and
 * attributes every row in the same transaction, including the tenant and the
 * connection, to it. The administrator link is SELF-attributed
 * (`created_by_user_link_id` = its own id), which is the literal fact: it was
 * created by the act of establishing this tenant's trust, and every later change
 * goes through the ordinary attributed services.
 *
 * WHAT IT REFUSES, all before any write and now inside ONE transaction so a
 * concurrent second run cannot slip between the check and the write:
 *   - a provider organization already mapped to a DIFFERENT internal home;
 *   - an existing mapping whose ISSUER disagrees with the one named (issuer drift
 *     moves a live tenant's trust anchor — an operator does that deliberately, not
 *     as a side effect of a re-run);
 *   - a mapped organization whose connection is disabled;
 *   - a tenant that already has an active connection to another organization;
 *   - an administrator link bound to a different connection, or deactivated.
 *
 * DRY-RUN IS REAL. With `apply: false` the transaction is rolled back, so the plan
 * is computed against the same locked state an apply would use and nothing is
 * written. Prints and returns identifiers only — never a credential, key or cookie.
 */
import { randomUUID } from 'node:crypto';
import { withTransaction, type Executor } from '@dealer/database';
import { TENANT_ADMIN_ROLE } from './contracts';

interface Row {
  [key: string]: unknown;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface BootstrapOptions {
  tenantId: string;
  tenantName: string;
  providerOrganizationId: string;
  /**
   * The token issuer this connection trusts (R1 section C). Every request is
   * refused unless the verified token issuer agrees with it, so bootstrap must
   * record it explicitly rather than leave it to be guessed.
   */
  issuer: string;
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

/** Rolls the transaction back after a dry run without reporting a failure. */
class DryRunRollback extends Error {
  readonly steps: BootstrapStep[];

  constructor(steps: BootstrapStep[]) {
    super('dry run');
    this.steps = steps;
  }
}

/**
 * Establishes (or confirms) one tenant's identity origin. Idempotent: re-running
 * against an already-bootstrapped tenant writes nothing and says so.
 */
export async function bootstrapIdentityOrigin(options: BootstrapOptions): Promise<BootstrapStep[]> {
  if (!UUID_RE.test(options.tenantId)) {
    throw new BootstrapRefused('--tenant-id must be a UUID');
  }
  try {
    return await withTransaction(async (executor) => {
      const steps: BootstrapStep[] = [];
      // THE ADMINISTRATOR LINK IS RESOLVED FIRST, because it is the actor every row
      // below is attributed to. Its id is generated here even on a dry run, so the
      // plan describes exactly the writes an apply would perform.
      const actor = await resolveAdministratorId(executor, options);
      await planTenant(executor, options, steps, actor);
      await planConnection(executor, options, steps, actor);
      const userLinkId = await planUserLink(executor, options, steps, actor);
      await planRoleBinding(executor, options, steps, userLinkId);
      if (!options.apply) throw new DryRunRollback(steps);
      return steps;
    });
  } catch (err) {
    if (err instanceof DryRunRollback) return err.steps;
    throw err;
  }
}

/**
 * The id the administrator link has, or will have. An existing link keeps its id;
 * otherwise one is generated now so the tenant and the connection created below can
 * name their creator instead of leaving the column NULL.
 */
async function resolveAdministratorId(
  executor: Executor,
  options: BootstrapOptions,
): Promise<string> {
  const existing = await executor.query(
    `SELECT user_link_id FROM user_links
      WHERE provider = 'workos' AND tenant_id = $1 AND provider_user_id = $2`,
    [options.tenantId, options.adminProviderUserId],
  );
  return existing.rows.length > 0 ? String((existing.rows[0] as Row).user_link_id) : randomUUID();
}

/**
 * One audit row per applied step, in the bootstrap's own transaction, attributed to
 * the administrator link. R3's script wrote a single summary event at the end and
 * nothing per step, so "who created this tenant" had no answer at all.
 */
async function audit(
  executor: Executor,
  input: {
    tenantId: string;
    eventType: string;
    entityType: string;
    entityId: string;
    actorUserLinkId: string;
    details: Record<string, unknown>;
  },
): Promise<void> {
  await executor.query(
    `INSERT INTO audit_events (tenant_id, event_type, entity_type, entity_id, actor_user_id, details)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      input.tenantId,
      input.eventType,
      input.entityType,
      input.entityId,
      input.actorUserLinkId,
      JSON.stringify({ ...input.details, origin: 'bootstrap' }),
    ],
  );
}

async function planTenant(
  executor: Executor,
  options: BootstrapOptions,
  steps: BootstrapStep[],
  actor: string,
): Promise<void> {
  const existing = await executor.query(
    `SELECT name, status FROM tenants WHERE tenant_id = $1 FOR UPDATE`,
    [options.tenantId],
  );
  if (existing.rows.length === 0) {
    steps.push({
      step: 'tenant',
      action: 'create',
      detail: `create active tenant ${options.tenantId}`,
    });
    await executor.query(
      `INSERT INTO tenants
         (tenant_id, name, status, created_by_user_link_id, updated_by_user_link_id,
          authorization_version)
       VALUES ($1, $2, 'active', NULL, NULL, 1)`,
      [options.tenantId, options.tenantName],
    );
    // The attribution lands in a second statement, not the INSERT: the composite
    // foreign key `(tenant_id, user_link_id)` on user_links means the administrator
    // link cannot exist until its tenant does, so the tenant row is written first
    // and then names the actor once that link exists. Same transaction either way —
    // an unattributed tenant is not a state anything outside this function can see.
    await deferredTenantAttribution(executor, options.tenantId, actor);
    await audit(executor, {
      tenantId: options.tenantId,
      eventType: 'identity.organization.created',
      entityType: 'tenant',
      entityId: options.tenantId,
      actorUserLinkId: actor,
      details: { status: 'active', authorization_version: 1 },
    });
    return;
  }
  const row = existing.rows[0] as Row;
  if (String(row.status) === 'pending_configuration') {
    steps.push({
      step: 'tenant',
      action: 'update',
      detail: 'activate pending_configuration tenant and set its name',
    });
    // THE ATTRIBUTION IS DEFERRED, and the foreign key is why. `tenants` references
    // `user_links(user_link_id)` on both attribution columns, and the administrator link
    // this run is attributed to may not exist yet — it is created below, because a link
    // cannot exist before its tenant does. Naming it here would abort the whole
    // bootstrap with a foreign-key violation on any tenant that arrived
    // `pending_configuration` from migration 055's backfill, which is the single most
    // common real path into this command. The version advance is NOT deferred: the
    // status change happens now.
    const updated = await executor.query(
      `UPDATE tenants
          SET name = $2, status = 'active',
              authorization_version = authorization_version + 1
        WHERE tenant_id = $1
        RETURNING authorization_version`,
      [options.tenantId, options.tenantName],
    );
    await audit(executor, {
      tenantId: options.tenantId,
      eventType: 'identity.organization.status_changed',
      entityType: 'tenant',
      entityId: options.tenantId,
      actorUserLinkId: actor,
      details: {
        status: 'active',
        authorization_version: Number((updated.rows[0] as Row).authorization_version),
      },
    });
    await deferredTenantAttribution(executor, options.tenantId, actor);
    return;
  }
  steps.push({ step: 'tenant', action: 'exists', detail: `tenant already ${String(row.status)}` });
}

/**
 * Names the administrator on the rows created above, once that link exists.
 *
 * Deliberately NOT a version advance: creating a tenant establishes version 1, and
 * recording who created it is part of that same creation rather than a later change.
 */
async function deferredTenantAttribution(
  executor: Executor,
  tenantId: string,
  actor: string,
): Promise<void> {
  await executor.query(
    `UPDATE tenants
        SET created_by_user_link_id = COALESCE(created_by_user_link_id, $2),
            updated_by_user_link_id = COALESCE(updated_by_user_link_id, $2)
      WHERE tenant_id = $1
        AND EXISTS (SELECT 1 FROM user_links WHERE user_link_id = $2)`,
    [tenantId, actor],
  );
}

async function planConnection(
  executor: Executor,
  options: BootstrapOptions,
  steps: BootstrapStep[],
  actor: string,
): Promise<void> {
  const byOrg = await executor.query(
    `SELECT connection_id, tenant_id, status, issuer FROM identity_provider_connections
      WHERE provider = 'workos' AND provider_organization_id = $1
      FOR UPDATE`,
    [options.providerOrganizationId],
  );
  if (byOrg.rows.length > 0) {
    const row = byOrg.rows[0] as Row;
    if (row.tenant_id === null || String(row.tenant_id) !== options.tenantId) {
      throw new BootstrapRefused(
        'provider organization is already mapped to a different internal home — refusing an ambiguous mapping',
      );
    }
    // R3: ISSUER DRIFT. The issuer is the trust anchor, so re-running the bootstrap
    // with a different one is either a typo or an attempt to move a live tenant's
    // trust to another environment. Either way it is a decision an operator makes
    // deliberately (and audibly), never a side effect of a re-run.
    if (String(row.issuer) !== options.issuer) {
      throw new BootstrapRefused(
        'the existing mapping records a DIFFERENT issuer than --issuer — refusing issuer drift; change it deliberately, not via bootstrap',
      );
    }
    if (String(row.status) === 'active') {
      steps.push({
        step: 'connection',
        action: 'exists',
        detail: 'active connection already maps this organization at the named issuer',
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
  const created = await executor.query(
    `INSERT INTO identity_provider_connections
       (connection_scope, tenant_id, provider, provider_organization_id, status, issuer,
        created_by_user_link_id, updated_by_user_link_id, authorization_version)
     VALUES ('dealership', $1, 'workos', $2, 'active', $3, NULL, NULL, 1)
     RETURNING connection_id`,
    [options.tenantId, options.providerOrganizationId, options.issuer],
  );
  const connectionId = String((created.rows[0] as Row).connection_id);
  await audit(executor, {
    tenantId: options.tenantId,
    eventType: 'identity.provider_connection.created',
    entityType: 'identity_provider_connection',
    entityId: connectionId,
    actorUserLinkId: actor,
    details: { scope: 'dealership', authorization_version: 1 },
  });
}

async function planUserLink(
  executor: Executor,
  options: BootstrapOptions,
  steps: BootstrapStep[],
  actor: string,
): Promise<string> {
  // R3: (provider, tenant, subject) is not an identity. The lookup also reads whether
  // the existing link's BINDING — connection, issuer, organization — still agrees with
  // the tenant's active connection, so a link belonging to a different provider
  // organization is refused rather than adopted. An as-yet-unbound PENDING link agrees
  // by definition; the schema only demands a binding once a link is activated.
  const existing = await executor.query(
    `SELECT ul.user_link_id,
            ul.status,
            COALESCE(
              ul.connection_id IS NULL
              OR (ul.connection_id = c.connection_id
                  AND ul.issuer = c.issuer
                  AND ul.provider_organization_id = c.provider_organization_id),
              FALSE
            ) AS binding_agrees
       FROM user_links ul
       LEFT JOIN identity_provider_connections c
              ON c.tenant_id = ul.tenant_id
             AND c.provider = ul.provider
             AND c.status = 'active'
      WHERE ul.provider = 'workos' AND ul.tenant_id = $1 AND ul.provider_user_id = $2
      FOR UPDATE OF ul`,
    [options.tenantId, options.adminProviderUserId],
  );
  if (existing.rows.length > 0) {
    const row = existing.rows[0] as Row;
    const id = String(row.user_link_id);
    if (row.binding_agrees !== true) {
      throw new BootstrapRefused(
        'the named administrator link is bound to a different provider connection — re-home it explicitly, not via bootstrap',
      );
    }
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
      const activated = await executor.query(
        `UPDATE user_links ul
            SET status = 'activated', activated_at = NOW(),
                activated_by_user_link_id = ul.user_link_id,
                email = COALESCE($2, ul.email),
                connection_id = c.connection_id,
                issuer = c.issuer,
                provider_organization_id = c.provider_organization_id,
                updated_by_user_link_id = ul.user_link_id,
                authorization_version = ul.authorization_version + 1
           FROM identity_provider_connections c
          WHERE ul.user_link_id = $1
            AND c.tenant_id IS NOT DISTINCT FROM ul.tenant_id
            AND c.provider = ul.provider AND c.status = 'active'
          RETURNING ul.authorization_version`,
        [id, options.adminEmail],
      );
      if (activated.rows.length === 0) {
        throw new BootstrapRefused(
          'no active provider connection to bind the administrator link to',
        );
      }
      await audit(executor, {
        tenantId: options.tenantId,
        eventType: 'identity.user_link.activated',
        entityType: 'user_link',
        entityId: id,
        actorUserLinkId: id,
        details: {
          authorization_version: Number((activated.rows[0] as Row).authorization_version),
        },
      });
      return id;
    }
    steps.push({
      step: 'user_link',
      action: 'exists',
      detail: 'administrator link already activated',
    });
    return id;
  }
  steps.push({
    step: 'user_link',
    action: 'create',
    detail: 'create activated administrator link (no roles yet)',
  });
  // R2: the administrator link is bound to the exact connection this bootstrap
  // mapped — an activated link that cannot name its connection, issuer and
  // organization is refused by the schema. SELF-ATTRIBUTED: this link is the origin
  // of trust, so the only true answer to "who created it" is itself.
  const created = await executor.query(
    `INSERT INTO user_links
       (user_link_id, actor_scope, tenant_id, provider, provider_user_id, email, status,
        activated_at, activated_by_user_link_id, connection_id, issuer,
        provider_organization_id, created_by_user_link_id, updated_by_user_link_id,
        authorization_version)
     SELECT $1, 'dealership', $2, 'workos', $3, $4, 'activated', NOW(), $1,
            c.connection_id, c.issuer, c.provider_organization_id, $1, $1, 1
       FROM identity_provider_connections c
      WHERE c.tenant_id = $2 AND c.provider = 'workos' AND c.status = 'active'
      LIMIT 1
     RETURNING user_link_id`,
    [actor, options.tenantId, options.adminProviderUserId, options.adminEmail],
  );
  if (created.rows.length === 0) {
    throw new BootstrapRefused(
      'no active provider connection to bootstrap an administrator against',
    );
  }
  await audit(executor, {
    tenantId: options.tenantId,
    eventType: 'identity.user_link.provisioned',
    entityType: 'user_link',
    entityId: actor,
    actorUserLinkId: actor,
    details: { status: 'activated', origin_of_trust: true, authorization_version: 1 },
  });
  // Now that the origin actor exists, the tenant row can name it.
  await deferredTenantAttribution(executor, options.tenantId, actor);
  await executor.query(
    `UPDATE identity_provider_connections
        SET created_by_user_link_id = COALESCE(created_by_user_link_id, $2),
            updated_by_user_link_id = COALESCE(updated_by_user_link_id, $2)
      WHERE tenant_id = $1 AND provider = 'workos' AND status = 'active'`,
    [options.tenantId, actor],
  );
  return actor;
}

async function planRoleBinding(
  executor: Executor,
  options: BootstrapOptions,
  steps: BootstrapStep[],
  userLinkId: string,
): Promise<void> {
  // role-binding-effectiveness-opt-out(all-bindings-including-ineffective): an
  // IDEMPOTENCY probe against the unrevoked-binding uniqueness rule, not an
  // authorization read. It must see a binding whose window has not opened or has
  // already closed — those rows still occupy the unique slot, so an
  // effectiveness-filtered probe would report "absent", insert a second grant and
  // fail on the index. This decides whether a row EXISTS; it never decides what a
  // row authorizes.
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
  // The bootstrap is the ORIGIN of trust: before it runs there is no actor to
  // attribute anything to, so this one grant is attributed to the administrator link
  // it just minted. Every LATER authorization change comes through `grantRole` and
  // the rest of the owned mutation services.
  const granted = await executor.query(
    `INSERT INTO role_bindings
       (tenant_id, user_link_id, role, scope_level, scope_id,
        granted_by_user_link_id, created_by_user_link_id, updated_by_user_link_id)
     VALUES ($1, $2, $3, 'tenant', $1, $2, $2, $2)
     RETURNING role_binding_id, authorization_version`,
    [options.tenantId, userLinkId, TENANT_ADMIN_ROLE],
  );
  const row = granted.rows[0] as Row;
  await audit(executor, {
    tenantId: options.tenantId,
    eventType: 'identity.role_binding.granted',
    entityType: 'role_binding',
    entityId: String(row.role_binding_id),
    actorUserLinkId: userLinkId,
    details: {
      role: TENANT_ADMIN_ROLE,
      scope_level: 'tenant',
      subject_user_link_id: userLinkId,
      authorization_version: Number(row.authorization_version),
    },
  });
}
