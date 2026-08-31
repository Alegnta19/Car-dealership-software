/**
 * RELEASE TRAIN 3 — THE SOURCE CATALOG.
 *
 * A lead's source is a REFERENCE to a row the dealership owns, not a string the
 * caller types. That is the whole reason this table exists: attribution that
 * groups by free text silently splits "Autotrader", "AutoTrader" and
 * "autotrader " into three sources, and the report looks plausible while being
 * wrong. A code that must already exist cannot be misspelled into a new bucket.
 *
 * Sources RETIRE rather than delete. A retired source stops appearing in the
 * pickers and keeps every touch that ever named it, because deleting it would
 * rewrite the history those touches are evidence for.
 */
import { withTenantTransaction, type Executor } from '@dealer/database';
import { recordMutation, requireActor, type MutationResult } from '@dealer/identity-access';

interface Row {
  [key: string]: unknown;
}

export type SourceChannel =
  | 'web'
  | 'phone'
  | 'walk_in'
  | 'email'
  | 'sms'
  | 'chat'
  | 'marketplace'
  | 'referral'
  | 'campaign'
  | 'import'
  | 'manual';

export type SourceMedium = 'organic' | 'paid' | 'owned' | 'referral' | 'direct' | 'unknown';

export interface LeadSourceView {
  readonly leadSourceId: string;
  readonly sourceCode: string;
  readonly displayName: string;
  readonly channel: SourceChannel;
  readonly medium: SourceMedium;
  readonly status: 'active' | 'retired';
  readonly authorizationVersion: number;
}

const SOURCE_COLUMNS = `lead_source_id, source_code, display_name, channel, medium, status,
       authorization_version`;

function mapSource(row: Row): LeadSourceView {
  return {
    leadSourceId: String(row.lead_source_id),
    sourceCode: String(row.source_code),
    displayName: String(row.display_name),
    channel: String(row.channel) as SourceChannel,
    medium: String(row.medium) as SourceMedium,
    status: String(row.status) as 'active' | 'retired',
    authorizationVersion: Number(row.authorization_version),
  };
}

export type SourceOutcome =
  | { outcome: 'saved'; source: LeadSourceView; mutation: MutationResult }
  | { outcome: 'duplicate'; source: LeadSourceView }
  | { outcome: 'invalid'; error: string };

export async function defineLeadSourceWithin(
  executor: Executor,
  input: {
    actingUserLinkId: string;
    tenantId: string;
    sourceCode: string;
    displayName: string;
    channel: SourceChannel;
    medium: SourceMedium;
  },
): Promise<SourceOutcome> {
  const code = (input.sourceCode ?? '').trim().toLowerCase();
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(code)) {
    return { outcome: 'invalid', error: 'a source code is lower-case letters, digits and _' };
  }
  const name = (input.displayName ?? '').trim();
  if (name.length === 0 || name.length > 120) {
    return { outcome: 'invalid', error: 'a source needs a name' };
  }
  const actor = await requireActor(executor, input.actingUserLinkId);

  const existing = await executor.query(
    `SELECT ${SOURCE_COLUMNS} FROM lead_sources WHERE tenant_id = $1 AND source_code = $2`,
    [input.tenantId, code],
  );
  if (existing.rows.length > 0) {
    return { outcome: 'duplicate', source: mapSource(existing.rows[0] as Row) };
  }
  const written = await executor.query(
    `INSERT INTO lead_sources
       (tenant_id, source_code, display_name, channel, medium,
        created_by_user_link_id, updated_by_user_link_id)
     VALUES ($1, $2, $3, $4, $5, $6, $6)
     RETURNING ${SOURCE_COLUMNS}`,
    [input.tenantId, code, name, input.channel, input.medium, actor],
  );
  const source = mapSource(written.rows[0] as Row);
  const mutation = await recordMutation(executor, {
    tenantId: input.tenantId,
    entityType: 'lead_source',
    entityId: source.leadSourceId,
    eventType: 'crm.lead_source.defined',
    actingUserLinkId: actor,
    authorizationVersion: source.authorizationVersion,
    details: { source_code: code, channel: input.channel, medium: input.medium },
  });
  return { outcome: 'saved', source, mutation };
}

export async function defineLeadSource(input: {
  actingUserLinkId: string;
  tenantId: string;
  sourceCode: string;
  displayName: string;
  channel: SourceChannel;
  medium: SourceMedium;
}): Promise<SourceOutcome> {
  return withTenantTransaction(input.tenantId, (tx) => defineLeadSourceWithin(tx, input));
}

export async function listLeadSources(
  tenantId: string,
  includeRetired = false,
): Promise<LeadSourceView[]> {
  return withTenantTransaction(tenantId, async (tx) => {
    const found = await tx.query(
      `SELECT ${SOURCE_COLUMNS} FROM lead_sources
        WHERE tenant_id = $1 AND ($2::boolean OR status = 'active')
        ORDER BY display_name`,
      [tenantId, includeRetired],
    );
    return (found.rows as Row[]).map(mapSource);
  });
}

export type RetireOutcome =
  | { outcome: 'retired'; source: LeadSourceView; mutation: MutationResult }
  | { outcome: 'version_conflict'; currentVersion: number }
  | { outcome: 'not_found' };

export async function retireLeadSource(input: {
  actingUserLinkId: string;
  tenantId: string;
  leadSourceId: string;
  expectedVersion: number;
}): Promise<RetireOutcome> {
  return withTenantTransaction(input.tenantId, async (tx) => {
    const actor = await requireActor(tx, input.actingUserLinkId);
    const existing = await tx.query(
      `SELECT ${SOURCE_COLUMNS} FROM lead_sources
        WHERE tenant_id = $1 AND lead_source_id = $2 FOR UPDATE`,
      [input.tenantId, input.leadSourceId],
    );
    if (existing.rows.length === 0) return { outcome: 'not_found' as const };
    const current = mapSource(existing.rows[0] as Row);
    if (current.authorizationVersion !== input.expectedVersion) {
      return { outcome: 'version_conflict' as const, currentVersion: current.authorizationVersion };
    }
    const written = await tx.query(
      `UPDATE lead_sources
          SET status = 'retired', updated_by_user_link_id = $3, updated_at = NOW(),
              authorization_version = authorization_version + 1
        WHERE tenant_id = $1 AND lead_source_id = $2 AND authorization_version = $4
        RETURNING ${SOURCE_COLUMNS}`,
      [input.tenantId, input.leadSourceId, actor, input.expectedVersion],
    );
    if (written.rows.length === 0) {
      return { outcome: 'version_conflict' as const, currentVersion: current.authorizationVersion };
    }
    const source = mapSource(written.rows[0] as Row);
    const mutation = await recordMutation(tx, {
      tenantId: input.tenantId,
      entityType: 'lead_source',
      entityId: source.leadSourceId,
      eventType: 'crm.lead_source.retired',
      actingUserLinkId: actor,
      authorizationVersion: source.authorizationVersion,
      details: { source_code: source.sourceCode },
    });
    return { outcome: 'retired' as const, source, mutation };
  });
}
