/**
 * RELEASE TRAIN 1 — DEALERSHIP ADMINISTRATION SERVICES.
 *
 * The owner-facing configuration domain migration 061 adds: dealership
 * settings (branding, timezone), weekly business hours, a BOUNDED set of
 * dealership policies, and staff invitations. Every write here follows the
 * FBL-020 mutation contract — a real acting user link, one transaction, an
 * advanced `authorization_version`, exactly one audit row — and every
 * transaction carries the SERVER-CONTROLLED tenant context, because the whole
 * domain sits under migration 061's deny-by-default row security.
 *
 * Two safe-command mechanics live here too, because they are transactional
 * facts rather than HTTP conveniences:
 *
 *   * OPTIMISTIC CONCURRENCY — settings updates carry the version the caller
 *     last saw; a mismatch returns 'version_conflict' and changes nothing, so
 *     two administrators cannot silently overwrite each other;
 *   * IDEMPOTENT COMMANDS — `runIdempotentAdminCommand` records a command's
 *     outcome under (tenant, actor, key) in the SAME transaction as its
 *     effect, so a retried command replays the recorded outcome instead of
 *     repeating the effect, and the same key presented with a DIFFERENT
 *     request is a refusable conflict.
 */
import { createHash } from 'node:crypto';
import { withTenantTransaction, type Executor } from '@dealer/database';
import { ROLES } from '@dealer/contracts';
import { TENANT_ADMIN_ROLE } from './contracts';
import { recordMutation, requireActor, type MutationResult } from './mutations';
import { enqueueAdminOutboxEvent } from './admin-outbox';

interface Row {
  [key: string]: unknown;
}

function ts(v: unknown): Date {
  return v instanceof Date ? v : new Date(String(v));
}

function version(row: Row): number {
  return Number(row.authorization_version);
}

// ── views ───────────────────────────────────────────────────────────────────

export interface DealershipSettingsView {
  readonly tenantId: string;
  readonly displayName: string;
  readonly legalName: string | null;
  readonly brandPrimaryColor: string | null;
  readonly logoUrl: string | null;
  readonly timezone: string;
  readonly locale: string | null;
  readonly authorizationVersion: number;
  readonly updatedAt: Date;
}

export interface BusinessHoursDay {
  readonly dayOfWeek: number;
  readonly closed: boolean;
  /** 'HH:MM' 24h, null when closed */
  readonly openTime: string | null;
  readonly closeTime: string | null;
}

export interface DealershipPolicyView {
  readonly policyKey: string;
  readonly policyValue: unknown;
  readonly authorizationVersion: number;
  readonly updatedAt: Date;
}

export interface StaffInvitationView {
  readonly invitationId: string;
  readonly tenantId: string;
  readonly email: string;
  readonly displayName: string | null;
  readonly invitedRole: string;
  readonly scopeLevel: string;
  readonly scopeId: string | null;
  readonly status: 'pending' | 'accepted' | 'revoked' | 'expired';
  readonly invitedByUserLinkId: string;
  readonly expiresAt: Date;
  readonly createdAt: Date;
}

function mapSettings(r: Row): DealershipSettingsView {
  return {
    tenantId: String(r.tenant_id),
    displayName: String(r.display_name),
    legalName: r.legal_name === null ? null : String(r.legal_name),
    brandPrimaryColor: r.brand_primary_color === null ? null : String(r.brand_primary_color),
    logoUrl: r.logo_url === null ? null : String(r.logo_url),
    timezone: String(r.timezone),
    locale: r.locale === null ? null : String(r.locale),
    authorizationVersion: version(r),
    updatedAt: ts(r.updated_at),
  };
}

function mapInvitation(r: Row): StaffInvitationView {
  return {
    invitationId: String(r.invitation_id),
    tenantId: String(r.tenant_id),
    email: String(r.email),
    displayName: r.display_name === null ? null : String(r.display_name),
    invitedRole: String(r.invited_role),
    scopeLevel: String(r.scope_level),
    scopeId: r.scope_id === null ? null : String(r.scope_id),
    status: String(r.status) as StaffInvitationView['status'],
    invitedByUserLinkId: String(r.invited_by_user_link_id),
    expiresAt: ts(r.expires_at),
    createdAt: ts(r.created_at),
  };
}

const TIME_RE = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

// ── the bounded policy catalog ──────────────────────────────────────────────

/**
 * The dealership policies this journey administers. The KEY set is closed: an
 * unknown key is refused at the service boundary (and the key grammar is a
 * database CHECK besides). Each entry validates its value's SHAPE, so the
 * stored JSONB is always the declared type.
 */
export const DEALERSHIP_POLICY_CATALOG: ReadonlyArray<{
  key: string;
  description: string;
  validate: (value: unknown) => string | null;
}> = [
  {
    key: 'appointments.lead_time_minutes',
    description: 'Minimum lead time before a service appointment may be booked',
    validate: (v) =>
      Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 10080
        ? null
        : 'must be an integer between 0 and 10080 (minutes in a week)',
  },
  {
    key: 'appointments.cancellation_window_hours',
    description: 'Hours before an appointment during which cancellation is free',
    validate: (v) =>
      Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 720
        ? null
        : 'must be an integer between 0 and 720',
  },
  {
    key: 'service.walk_ins_accepted',
    description: 'Whether the service drive accepts walk-in customers',
    validate: (v) => (typeof v === 'boolean' ? null : 'must be true or false'),
  },
  {
    key: 'general.contact_phone',
    description: 'The dealership contact phone shown to staff',
    validate: (v) =>
      typeof v === 'string' && /^[0-9+()\-\s]{5,32}$/.test(v)
        ? null
        : 'must be a phone-shaped string (5-32 digits and separators)',
  },
];

const POLICY_BY_KEY = new Map(DEALERSHIP_POLICY_CATALOG.map((p) => [p.key, p]));

/** Roles a dealership owner may invite with. Platform roles are not invitable. */
export const INVITABLE_ROLES: readonly string[] = [
  TENANT_ADMIN_ROLE,
  ROLES.SERVICE_MANAGER,
  ROLES.SERVICE_ADVISOR,
  ROLES.TECHNICIAN,
  ROLES.PARTS_CLERK,
  ROLES.WARRANTY_ADMIN,
  ROLES.VIEWER,
];

// ── reads (tenant-context transactions over row-secured tables) ─────────────

export async function getDealershipSettings(
  tenantId: string,
): Promise<DealershipSettingsView | null> {
  const r = await withTenantTransaction(tenantId, (tx) =>
    tx.query(`SELECT * FROM dealership_settings WHERE tenant_id = $1`, [tenantId]),
  );
  return r.rows.length > 0 ? mapSettings(r.rows[0] as Row) : null;
}

export async function listBusinessHours(tenantId: string): Promise<BusinessHoursDay[]> {
  const r = await withTenantTransaction(tenantId, (tx) =>
    tx.query(
      `SELECT day_of_week, closed, open_time, close_time
         FROM dealership_business_hours WHERE tenant_id = $1 ORDER BY day_of_week`,
      [tenantId],
    ),
  );
  return (r.rows as Row[]).map((row) => ({
    dayOfWeek: Number(row.day_of_week),
    closed: row.closed === true,
    openTime: row.open_time === null ? null : String(row.open_time).slice(0, 5),
    closeTime: row.close_time === null ? null : String(row.close_time).slice(0, 5),
  }));
}

export async function listDealershipPolicies(tenantId: string): Promise<DealershipPolicyView[]> {
  const r = await withTenantTransaction(tenantId, (tx) =>
    tx.query(
      `SELECT policy_key, policy_value, authorization_version, updated_at
         FROM dealership_policies WHERE tenant_id = $1 ORDER BY policy_key`,
      [tenantId],
    ),
  );
  return (r.rows as Row[]).map((row) => ({
    policyKey: String(row.policy_key),
    policyValue: row.policy_value,
    authorizationVersion: version(row),
    updatedAt: ts(row.updated_at),
  }));
}

export async function listStaffInvitations(tenantId: string): Promise<StaffInvitationView[]> {
  const r = await withTenantTransaction(tenantId, (tx) =>
    tx.query(`SELECT * FROM staff_invitations WHERE tenant_id = $1 ORDER BY created_at DESC`, [
      tenantId,
    ]),
  );
  return (r.rows as Row[]).map(mapInvitation);
}

// ── writes ──────────────────────────────────────────────────────────────────

export interface SettingsPatch {
  readonly displayName: string;
  readonly legalName?: string | null;
  readonly brandPrimaryColor?: string | null;
  readonly logoUrl?: string | null;
  readonly timezone?: string;
  readonly locale?: string | null;
}

/**
 * Creates or updates the tenant's settings row. `expectedVersion` is the
 * OPTIMISTIC CONCURRENCY handle: null means "create only" (refused as a
 * conflict when the row already exists), a number means "update exactly the
 * version I last read". A mismatch changes nothing and reports it.
 */
export async function upsertDealershipSettings(input: {
  actingUserLinkId: string;
  tenantId: string;
  expectedVersion: number | null;
  settings: SettingsPatch;
}): Promise<
  | { outcome: 'saved'; settings: DealershipSettingsView; mutation: MutationResult }
  | { outcome: 'version_conflict'; currentVersion: number | null }
> {
  return withTenantTransaction(input.tenantId, async (executor) => {
    const actor = await requireActor(executor, input.actingUserLinkId);
    const existing = await executor.query(
      `SELECT authorization_version FROM dealership_settings WHERE tenant_id = $1 FOR UPDATE`,
      [input.tenantId],
    );
    const current = existing.rows.length > 0 ? version(existing.rows[0] as Row) : null;
    if (input.expectedVersion !== current) {
      return { outcome: 'version_conflict' as const, currentVersion: current };
    }
    const s = input.settings;
    const written =
      current === null
        ? await executor.query(
            `INSERT INTO dealership_settings
               (tenant_id, display_name, legal_name, brand_primary_color, logo_url,
                timezone, locale, created_by_user_link_id, updated_by_user_link_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
             RETURNING *`,
            [
              input.tenantId,
              s.displayName,
              s.legalName ?? null,
              s.brandPrimaryColor ?? null,
              s.logoUrl ?? null,
              s.timezone ?? 'UTC',
              s.locale ?? null,
              actor,
            ],
          )
        : await executor.query(
            `UPDATE dealership_settings
                SET display_name = $2, legal_name = $3, brand_primary_color = $4,
                    logo_url = $5, timezone = $6, locale = $7,
                    updated_by_user_link_id = $8, updated_at = NOW(),
                    authorization_version = authorization_version + 1
              WHERE tenant_id = $1 AND authorization_version = $9
              RETURNING *`,
            [
              input.tenantId,
              s.displayName,
              s.legalName ?? null,
              s.brandPrimaryColor ?? null,
              s.logoUrl ?? null,
              s.timezone ?? 'UTC',
              s.locale ?? null,
              actor,
              input.expectedVersion,
            ],
          );
    if (written.rows.length === 0) {
      return { outcome: 'version_conflict' as const, currentVersion: current };
    }
    const row = written.rows[0] as Row;
    const mutation = await recordMutation(executor, {
      tenantId: input.tenantId,
      entityType: 'dealership_settings',
      entityId: input.tenantId,
      eventType: current === null ? 'admin.settings.created' : 'admin.settings.updated',
      actingUserLinkId: actor,
      authorizationVersion: version(row),
      details: { transition: current === null ? 'created' : 'updated' },
    });
    return { outcome: 'saved' as const, settings: mapSettings(row), mutation };
  });
}

/**
 * Replaces the whole weekly schedule in one transaction — the PUT model, so a
 * retried save converges on the same state. Each day is validated for shape
 * before anything is written; one audit row records the replacement.
 */
export async function replaceBusinessHours(input: {
  actingUserLinkId: string;
  tenantId: string;
  days: readonly BusinessHoursDay[];
}): Promise<{ days: BusinessHoursDay[]; mutation: MutationResult } | { error: string }> {
  const seen = new Set<number>();
  for (const d of input.days) {
    if (!Number.isInteger(d.dayOfWeek) || d.dayOfWeek < 0 || d.dayOfWeek > 6) {
      return { error: `day_of_week ${String(d.dayOfWeek)} is not 0-6` };
    }
    if (seen.has(d.dayOfWeek)) return { error: `day_of_week ${d.dayOfWeek} appears twice` };
    seen.add(d.dayOfWeek);
    if (d.closed) {
      if (d.openTime !== null || d.closeTime !== null) {
        return { error: `closed day ${d.dayOfWeek} must carry no times` };
      }
    } else {
      if (
        d.openTime === null ||
        d.closeTime === null ||
        !TIME_RE.test(d.openTime) ||
        !TIME_RE.test(d.closeTime)
      ) {
        return { error: `open day ${d.dayOfWeek} needs HH:MM open and close times` };
      }
      if (d.closeTime <= d.openTime) {
        return { error: `day ${d.dayOfWeek} must close after it opens` };
      }
    }
  }
  return withTenantTransaction(input.tenantId, async (executor) => {
    const actor = await requireActor(executor, input.actingUserLinkId);
    await executor.query(`DELETE FROM dealership_business_hours WHERE tenant_id = $1`, [
      input.tenantId,
    ]);
    for (const d of [...input.days].sort((a, b) => a.dayOfWeek - b.dayOfWeek)) {
      await executor.query(
        `INSERT INTO dealership_business_hours
           (tenant_id, day_of_week, closed, open_time, close_time, updated_by_user_link_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [input.tenantId, d.dayOfWeek, d.closed, d.openTime, d.closeTime, actor],
      );
    }
    const mutation = await recordMutation(executor, {
      tenantId: input.tenantId,
      entityType: 'dealership_business_hours',
      entityId: input.tenantId,
      eventType: 'admin.business_hours.replaced',
      actingUserLinkId: actor,
      authorizationVersion: 1,
      details: { days_configured: input.days.length },
    });
    return { days: [...input.days].sort((a, b) => a.dayOfWeek - b.dayOfWeek), mutation };
  });
}

/**
 * Sets one policy from the BOUNDED catalog. Unknown keys and mis-shaped values
 * refuse before the transaction opens.
 */
export async function setDealershipPolicy(input: {
  actingUserLinkId: string;
  tenantId: string;
  policyKey: string;
  policyValue: unknown;
}): Promise<{ policy: DealershipPolicyView; mutation: MutationResult } | { error: string }> {
  const entry = POLICY_BY_KEY.get(input.policyKey);
  if (entry === undefined) {
    return { error: `unknown policy key ${input.policyKey}` };
  }
  const invalid = entry.validate(input.policyValue);
  if (invalid !== null) {
    return { error: `${input.policyKey} ${invalid}` };
  }
  return withTenantTransaction(input.tenantId, async (executor) => {
    const actor = await requireActor(executor, input.actingUserLinkId);
    const written = await executor.query(
      `INSERT INTO dealership_policies
         (tenant_id, policy_key, policy_value, updated_by_user_link_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, policy_key) DO UPDATE
         SET policy_value = EXCLUDED.policy_value,
             updated_by_user_link_id = EXCLUDED.updated_by_user_link_id,
             updated_at = NOW(),
             authorization_version = dealership_policies.authorization_version + 1
       RETURNING *`,
      [input.tenantId, input.policyKey, JSON.stringify(input.policyValue), actor],
    );
    const row = written.rows[0] as Row;
    const mutation = await recordMutation(executor, {
      tenantId: input.tenantId,
      entityType: 'dealership_policy',
      entityId: input.tenantId,
      eventType: 'admin.policy.updated',
      actingUserLinkId: actor,
      authorizationVersion: version(row),
      details: { policy_key: input.policyKey },
    });
    return {
      policy: {
        policyKey: String(row.policy_key),
        policyValue: row.policy_value,
        authorizationVersion: version(row),
        updatedAt: ts(row.updated_at),
      },
      mutation,
    };
  });
}

/**
 * Creates a staff invitation and, in the SAME transaction, the outbox event
 * that carries the email out of the service. The invited role comes from the
 * bounded invitable set (platform roles are not invitable); a non-tenant scope
 * must be a real node of this tenant (a row-secured read, so a cross-tenant id
 * simply does not exist here).
 */
export async function createStaffInvitation(input: {
  actingUserLinkId: string;
  tenantId: string;
  email: string;
  displayName?: string | null;
  invitedRole: string;
  scopeLevel?: string;
  scopeId?: string | null;
  expiresInDays?: number;
}): Promise<{ invitation: StaffInvitationView; mutation: MutationResult } | { error: string }> {
  if (!INVITABLE_ROLES.includes(input.invitedRole)) {
    return { error: `role ${input.invitedRole} is not invitable` };
  }
  const scopeLevel = input.scopeLevel ?? 'tenant';
  const scopeId = scopeLevel === 'tenant' ? null : (input.scopeId ?? null);
  if (scopeLevel !== 'tenant' && scopeId === null) {
    return { error: `${scopeLevel} scope needs a scope_id` };
  }
  const days = input.expiresInDays ?? 7;
  if (!Number.isInteger(days) || days < 1 || days > 30) {
    return { error: 'expires_in_days must be an integer between 1 and 30' };
  }
  return withTenantTransaction(input.tenantId, async (executor) => {
    const actor = await requireActor(executor, input.actingUserLinkId);
    if (scopeLevel !== 'tenant') {
      const table = {
        dealer_group: ['dealer_groups', 'dealer_group_id'],
        legal_entity: ['legal_entities', 'legal_entity_id'],
        rooftop: ['rooftops', 'rooftop_id'],
        department: ['departments', 'department_id'],
      }[scopeLevel as 'dealer_group' | 'legal_entity' | 'rooftop' | 'department'];
      if (table === undefined) return { error: `unknown scope level ${scopeLevel}` };
      const node = await executor.query(
        `SELECT 1 FROM ${table[0]} WHERE tenant_id = $1 AND ${table[1]} = $2`,
        [input.tenantId, scopeId],
      );
      if (node.rows.length === 0) return { error: 'scope node not found in this dealership' };
    }
    const dup = await executor.query(
      `SELECT 1 FROM staff_invitations
        WHERE tenant_id = $1 AND lower(email) = lower($2) AND status = 'pending'`,
      [input.tenantId, input.email],
    );
    if (dup.rows.length > 0) {
      return { error: 'a pending invitation for this address already exists' };
    }
    const written = await executor.query(
      `INSERT INTO staff_invitations
         (tenant_id, email, display_name, invited_role, scope_level, scope_id,
          invited_by_user_link_id, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW() + make_interval(days => $8))
       RETURNING *`,
      [
        input.tenantId,
        input.email,
        input.displayName ?? null,
        input.invitedRole,
        scopeLevel,
        scopeId,
        actor,
        days,
      ],
    );
    const row = written.rows[0] as Row;
    const invitation = mapInvitation(row);
    await enqueueAdminOutboxEvent(executor, {
      tenantId: input.tenantId,
      eventType: 'admin.staff_invitation.created',
      payload: { invitation_id: invitation.invitationId },
    });
    const mutation = await recordMutation(executor, {
      tenantId: input.tenantId,
      entityType: 'staff_invitation',
      entityId: invitation.invitationId,
      eventType: 'admin.invitation.created',
      actingUserLinkId: actor,
      authorizationVersion: version(row),
      // the ROLE and SCOPE are administrative facts; the address is not logged
      details: { invited_role: invitation.invitedRole, scope_level: invitation.scopeLevel },
    });
    return { invitation, mutation };
  });
}

export async function revokeStaffInvitation(input: {
  actingUserLinkId: string;
  tenantId: string;
  invitationId: string;
}): Promise<{ invitation: StaffInvitationView; mutation: MutationResult } | null> {
  return withTenantTransaction(input.tenantId, async (executor) => {
    const actor = await requireActor(executor, input.actingUserLinkId);
    const written = await executor.query(
      `UPDATE staff_invitations
          SET status = 'revoked', updated_at = NOW(),
              authorization_version = authorization_version + 1
        WHERE tenant_id = $1 AND invitation_id = $2 AND status = 'pending'
        RETURNING *`,
      [input.tenantId, input.invitationId],
    );
    if (written.rows.length === 0) return null;
    const row = written.rows[0] as Row;
    const mutation = await recordMutation(executor, {
      tenantId: input.tenantId,
      entityType: 'staff_invitation',
      entityId: input.invitationId,
      eventType: 'admin.invitation.revoked',
      actingUserLinkId: actor,
      authorizationVersion: version(row),
      details: {},
    });
    return { invitation: mapInvitation(row), mutation };
  });
}

// ── idempotent commands ─────────────────────────────────────────────────────

export interface IdempotentOutcome {
  readonly status: number;
  readonly body: unknown;
}

export function requestFingerprint(method: string, path: string, body: unknown): string {
  return createHash('sha256')
    .update(`${method.toUpperCase()} ${path}\n${JSON.stringify(body ?? null)}`)
    .digest('hex');
}

/**
 * Runs `work` exactly once per (tenant, actor, key). The recorded outcome is
 * written in the SAME transaction as the work's effects, so a crash between
 * "effect" and "record" is impossible; a retry replays the stored outcome; the
 * same key on a DIFFERENT request (fingerprint mismatch) is a conflict; two
 * concurrent first attempts race on the primary key, the loser's transaction —
 * effects included — rolls back, and it then replays the winner's outcome.
 */
export async function runIdempotentAdminCommand(input: {
  tenantId: string;
  actorUserLinkId: string;
  idempotencyKey: string | null;
  fingerprint: string;
  ttlHours?: number;
  work: (tx: Executor) => Promise<IdempotentOutcome>;
}): Promise<IdempotentOutcome & { replayed: boolean; conflict?: boolean }> {
  if (input.idempotencyKey === null) {
    const fresh = await withTenantTransaction(input.tenantId, input.work);
    return { ...fresh, replayed: false };
  }
  const attempt = async (): Promise<
    IdempotentOutcome & { replayed: boolean; conflict?: boolean }
  > =>
    withTenantTransaction(input.tenantId, async (tx) => {
      const prior = await tx.query(
        `SELECT request_fingerprint, response_status, response_body
           FROM idempotency_keys
          WHERE tenant_id = $1 AND actor_user_link_id = $2 AND idempotency_key = $3
          FOR UPDATE`,
        [input.tenantId, input.actorUserLinkId, input.idempotencyKey],
      );
      if (prior.rows.length > 0) {
        const row = prior.rows[0] as Row;
        if (String(row.request_fingerprint) !== input.fingerprint) {
          return { status: 422, body: null, replayed: false, conflict: true };
        }
        return {
          status: Number(row.response_status),
          body: row.response_body,
          replayed: true,
        };
      }
      const outcome = await input.work(tx);
      await tx.query(
        `INSERT INTO idempotency_keys
           (tenant_id, actor_user_link_id, idempotency_key, request_fingerprint,
            response_status, response_body, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW() + make_interval(hours => $7))`,
        [
          input.tenantId,
          input.actorUserLinkId,
          input.idempotencyKey,
          input.fingerprint,
          outcome.status,
          JSON.stringify(outcome.body ?? null),
          input.ttlHours ?? 24,
        ],
      );
      return { ...outcome, replayed: false };
    });
  try {
    return await attempt();
  } catch (err) {
    // Two concurrent first attempts: the loser hits the primary key at its
    // INSERT, its whole transaction (the duplicated effect included) rolls
    // back, and the retry below finds — and replays — the winner's outcome.
    if ((err as { code?: string }).code === '23505') {
      return attempt();
    }
    throw err;
  }
}
