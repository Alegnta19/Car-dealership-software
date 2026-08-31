/**
 * RELEASE TRAIN 3, ROW 4 — THE CAMPAIGN, AND WHY IT IS VERSIONED.
 *
 * A campaign is an ongoing idea; a VERSION is a frozen decision — this
 * audience, this message, approved by this person, at this moment. Everything
 * that actually goes out belongs to a version, and nothing about a version
 * changes after it is approved. That separation is what makes a complaint
 * answerable: "what did you send me, and who said you could" has an answer that
 * editing the campaign afterwards cannot alter.
 *
 * THE APPROVAL GATE. A version may only be approved when it has a template, an
 * audience, and — for anything marketing — an opt-out affordance in the body.
 * The checks live here rather than in the UI because the UI is not the thing
 * that must be true.
 *
 * ELIGIBILITY IS CHECKED TWICE, AND THIS IS THE FIRST TIME. Building the
 * audience filters out people the dealership may not contact, so staff see a
 * realistic reach before they approve. It is NOT the safety property: the
 * second check, at send time, is (see `sends.ts`). An opt-out that arrives
 * between approval and execution is exactly the one that matters, and only the
 * second check can see it.
 */
import { withTenantTransaction, type Executor } from '@dealer/database';
import { recordMutation, requireActor, type MutationResult } from '@dealer/identity-access';
import { sendEligibility, type ConsentPurpose } from './consent';

interface Row {
  [key: string]: unknown;
}

export type CampaignChannel = 'email' | 'sms';
export type CampaignPurpose = 'sales_marketing' | 'service_reminder' | 'research';
export type CampaignVersionState = 'draft' | 'approved' | 'executing' | 'completed' | 'cancelled';
export type AudienceRule =
  'all_active_customers' | 'open_leads' | 'prior_buyers' | 'manual_selection';

/** The outbox event a launched version raises. Consumed by the worker. */
export const CAMPAIGN_DISPATCH_EVENT = 'marketing.campaign.dispatch';

export interface CampaignView {
  readonly campaignId: string;
  readonly rooftopId: string;
  readonly name: string;
  readonly channel: CampaignChannel;
  readonly purpose: CampaignPurpose;
  readonly leadSourceId: string;
  readonly quietHoursStartMinute: number;
  readonly quietHoursEndMinute: number;
  readonly timeZone: string;
  readonly status: 'draft' | 'active' | 'archived';
  readonly authorizationVersion: number;
}

const CAMPAIGN_COLUMNS = `campaign_id, rooftop_id, name, channel, purpose, lead_source_id,
       quiet_hours_start_minute, quiet_hours_end_minute, time_zone, status,
       authorization_version`;

export function mapCampaign(row: Row): CampaignView {
  return {
    campaignId: String(row.campaign_id),
    rooftopId: String(row.rooftop_id),
    name: String(row.name),
    channel: String(row.channel) as CampaignChannel,
    purpose: String(row.purpose) as CampaignPurpose,
    leadSourceId: String(row.lead_source_id),
    quietHoursStartMinute: Number(row.quiet_hours_start_minute),
    quietHoursEndMinute: Number(row.quiet_hours_end_minute),
    timeZone: String(row.time_zone),
    status: String(row.status) as 'draft' | 'active' | 'archived',
    authorizationVersion: Number(row.authorization_version),
  };
}

export interface CampaignVersionView {
  readonly campaignVersionId: string;
  readonly campaignId: string;
  readonly versionNumber: number;
  readonly state: CampaignVersionState;
  readonly approvedByUserLinkId: string | null;
  readonly approvedAt: string | null;
  readonly authorizationVersion: number;
}

const VERSION_COLUMNS = `campaign_version_id, campaign_id, version_number, state,
       approved_by_user_link_id, approved_at, authorization_version`;

export function mapVersion(row: Row): CampaignVersionView {
  return {
    campaignVersionId: String(row.campaign_version_id),
    campaignId: String(row.campaign_id),
    versionNumber: Number(row.version_number),
    state: String(row.state) as CampaignVersionState,
    approvedByUserLinkId:
      row.approved_by_user_link_id === null ? null : String(row.approved_by_user_link_id),
    approvedAt: row.approved_at === null ? null : new Date(row.approved_at as string).toISOString(),
    authorizationVersion: Number(row.authorization_version),
  };
}

export type CampaignOutcome =
  | { outcome: 'created'; campaign: CampaignView; mutation: MutationResult }
  | { outcome: 'duplicate'; campaign: CampaignView }
  | { outcome: 'invalid'; error: string };

export async function createCampaignWithin(
  executor: Executor,
  input: {
    actingUserLinkId: string;
    tenantId: string;
    rooftopId: string;
    name: string;
    channel: CampaignChannel;
    purpose: CampaignPurpose;
    sourceCode: string;
    quietHoursStartMinute?: number | undefined;
    quietHoursEndMinute?: number | undefined;
    timeZone?: string | undefined;
  },
): Promise<CampaignOutcome> {
  const name = (input.name ?? '').trim();
  if (name.length === 0 || name.length > 160) {
    return { outcome: 'invalid', error: 'a campaign needs a name' };
  }
  if (input.channel !== 'email' && input.channel !== 'sms') {
    return { outcome: 'invalid', error: 'a campaign sends by email or sms' };
  }
  const actor = await requireActor(executor, input.actingUserLinkId);

  const source = await executor.query(
    `SELECT lead_source_id FROM lead_sources
      WHERE tenant_id = $1 AND source_code = $2 AND status = 'active'`,
    [input.tenantId, input.sourceCode],
  );
  if (source.rows.length === 0) {
    return { outcome: 'invalid', error: `no active lead source named ${input.sourceCode}` };
  }

  const existing = await executor.query(
    `SELECT ${CAMPAIGN_COLUMNS} FROM campaigns
      WHERE tenant_id = $1 AND rooftop_id = $2 AND lower(name) = lower($3) AND status <> 'archived'`,
    [input.tenantId, input.rooftopId, name],
  );
  if (existing.rows.length > 0) {
    return { outcome: 'duplicate', campaign: mapCampaign(existing.rows[0] as Row) };
  }

  const written = await executor.query(
    `INSERT INTO campaigns
       (tenant_id, rooftop_id, name, channel, purpose, lead_source_id,
        quiet_hours_start_minute, quiet_hours_end_minute, time_zone,
        created_by_user_link_id, updated_by_user_link_id)
     VALUES ($1, $2, $3, $4, $5, $6,
             COALESCE($7::int, 1260), COALESCE($8::int, 480), COALESCE($9, 'UTC'), $10, $10)
     RETURNING ${CAMPAIGN_COLUMNS}`,
    [
      input.tenantId,
      input.rooftopId,
      name,
      input.channel,
      input.purpose,
      String((source.rows[0] as Row).lead_source_id),
      input.quietHoursStartMinute ?? null,
      input.quietHoursEndMinute ?? null,
      input.timeZone ?? null,
      actor,
    ],
  );
  const campaign = mapCampaign(written.rows[0] as Row);
  const mutation = await recordMutation(executor, {
    tenantId: input.tenantId,
    entityType: 'campaign',
    entityId: campaign.campaignId,
    eventType: 'crm.campaign.created',
    actingUserLinkId: actor,
    authorizationVersion: campaign.authorizationVersion,
    details: { channel: input.channel, purpose: input.purpose, rooftop_id: input.rooftopId },
  });
  return { outcome: 'created', campaign, mutation };
}

export async function createCampaign(input: {
  actingUserLinkId: string;
  tenantId: string;
  rooftopId: string;
  name: string;
  channel: CampaignChannel;
  purpose: CampaignPurpose;
  sourceCode: string;
  quietHoursStartMinute?: number | undefined;
  quietHoursEndMinute?: number | undefined;
  timeZone?: string | undefined;
}): Promise<CampaignOutcome> {
  return withTenantTransaction(input.tenantId, (tx) => createCampaignWithin(tx, input));
}

export type VersionOutcome =
  | { outcome: 'drafted'; version: CampaignVersionView; mutation: MutationResult }
  | { outcome: 'not_found' }
  | { outcome: 'invalid'; error: string };

/**
 * Starts a new version and freezes its message into `campaign_templates`. The
 * template is append-only and one per version, so the body that went out can
 * always be produced.
 */
export async function draftCampaignVersionWithin(
  executor: Executor,
  input: {
    actingUserLinkId: string;
    tenantId: string;
    campaignId: string;
    subject?: string | null | undefined;
    body: string;
    includesOptOut?: boolean | undefined;
  },
): Promise<VersionOutcome> {
  const body = (input.body ?? '').trim();
  if (body.length === 0 || body.length > 20000) {
    return { outcome: 'invalid', error: 'a version needs a message body' };
  }
  const actor = await requireActor(executor, input.actingUserLinkId);
  const campaign = await executor.query(
    `SELECT ${CAMPAIGN_COLUMNS} FROM campaigns WHERE tenant_id = $1 AND campaign_id = $2`,
    [input.tenantId, input.campaignId],
  );
  if (campaign.rows.length === 0) return { outcome: 'not_found' };
  const parent = mapCampaign(campaign.rows[0] as Row);
  if (parent.status === 'archived') {
    return { outcome: 'invalid', error: 'an archived campaign takes no new versions' };
  }
  if (parent.channel === 'email' && (input.subject ?? '').trim().length === 0) {
    return { outcome: 'invalid', error: 'an email version needs a subject' };
  }

  const next = await executor.query(
    `SELECT COALESCE(MAX(version_number), 0) + 1 AS n FROM campaign_versions
      WHERE tenant_id = $1 AND campaign_id = $2`,
    [input.tenantId, input.campaignId],
  );
  const written = await executor.query(
    `INSERT INTO campaign_versions
       (tenant_id, campaign_id, version_number, created_by_user_link_id, updated_by_user_link_id)
     VALUES ($1, $2, $3, $4, $4) RETURNING ${VERSION_COLUMNS}`,
    [input.tenantId, input.campaignId, Number((next.rows[0] as Row).n), actor],
  );
  const version = mapVersion(written.rows[0] as Row);
  await executor.query(
    `INSERT INTO campaign_templates
       (tenant_id, campaign_version_id, subject, body, includes_opt_out, created_by_user_link_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      input.tenantId,
      version.campaignVersionId,
      (input.subject ?? '').trim() || null,
      body,
      input.includesOptOut ?? true,
      actor,
    ],
  );
  const mutation = await recordMutation(executor, {
    tenantId: input.tenantId,
    entityType: 'campaign_version',
    entityId: version.campaignVersionId,
    eventType: 'crm.campaign_version.drafted',
    actingUserLinkId: actor,
    authorizationVersion: version.authorizationVersion,
    details: { campaign_id: input.campaignId, version_number: version.versionNumber },
  });
  return { outcome: 'drafted', version, mutation };
}

export async function draftCampaignVersion(input: {
  actingUserLinkId: string;
  tenantId: string;
  campaignId: string;
  subject?: string | null | undefined;
  body: string;
  includesOptOut?: boolean | undefined;
}): Promise<VersionOutcome> {
  return withTenantTransaction(input.tenantId, (tx) => draftCampaignVersionWithin(tx, input));
}

export interface AudienceResult {
  readonly considered: number;
  readonly included: number;
  readonly excludedNoContact: number;
  readonly excludedNoConsent: number;
  readonly excludedSuppressed: number;
}

/**
 * EXACT PARENT AUTHORITY (RT3-C1 §2).
 *
 * The policy engine authorized the caller against a CAMPAIGN — that is the
 * resource the route names and the rooftop the engine resolved. The version in
 * the path is a separate identifier, and nothing tied the two together: a
 * marketing manager authorized on their own campaign could approve, re-audience
 * or LAUNCH a version belonging to a campaign at a rooftop they cannot reach,
 * simply by putting their campaign in the path and someone else's version
 * beside it.
 *
 * A child is reachable through its parent or not at all. Reporting the mismatch
 * as NOT FOUND rather than as a refusal keeps the non-enumeration promise: a
 * caller learns nothing about a version they were never entitled to name.
 */
async function versionBelongsTo(
  executor: Executor,
  tenantId: string,
  campaignId: string,
  campaignVersionId: string,
): Promise<boolean> {
  const found = await executor.query(
    `SELECT 1 FROM campaign_versions
      WHERE tenant_id = $1 AND campaign_version_id = $2 AND campaign_id = $3`,
    [tenantId, campaignVersionId, campaignId],
  );
  return found.rows.length > 0;
}

export type AudienceOutcome =
  | { outcome: 'built'; result: AudienceResult; mutation: MutationResult }
  | { outcome: 'not_found' }
  | { outcome: 'invalid'; error: string };

/**
 * Resolves the audience and FREEZES IT into rows. Replaced as a whole set while
 * the version is a draft — which is why `campaign_audience_members` is the one
 * table in this train the runtime may DELETE from — and untouchable afterwards.
 *
 * The exclusion counts are returned rather than hidden. A marketer who asks for
 * "all active customers" and gets four hundred of nine hundred needs to know
 * that five hundred people have not agreed to be contacted; a screen that shows
 * only the four hundred teaches them the list is small when it is the
 * permission that is small.
 */
export async function buildAudience(input: {
  actingUserLinkId: string;
  tenantId: string;
  /** The campaign the CALLER was authorized against. See `assertVersionBelongsTo`. */
  campaignId: string;
  campaignVersionId: string;
  rule: AudienceRule;
  partyIds?: readonly string[] | undefined;
}): Promise<AudienceOutcome> {
  return withTenantTransaction(input.tenantId, async (tx) => {
    const actor = await requireActor(tx, input.actingUserLinkId);
    if (!(await versionBelongsTo(tx, input.tenantId, input.campaignId, input.campaignVersionId))) {
      return { outcome: 'not_found' as const };
    }
    const found = await tx.query(
      `SELECT v.campaign_version_id, v.state, c.channel, c.purpose, c.rooftop_id
         FROM campaign_versions v
         JOIN campaigns c ON c.tenant_id = v.tenant_id AND c.campaign_id = v.campaign_id
        WHERE v.tenant_id = $1 AND v.campaign_version_id = $2
        FOR UPDATE OF v`,
      [input.tenantId, input.campaignVersionId],
    );
    if (found.rows.length === 0) return { outcome: 'not_found' as const };
    const row = found.rows[0] as Row;
    if (String(row.state) !== 'draft') {
      return {
        outcome: 'invalid' as const,
        error: 'only a draft version may have its audience set',
      };
    }
    const channel = String(row.channel) as CampaignChannel;
    const purpose = String(row.purpose) as ConsentPurpose;

    const candidates = await resolveAudienceCandidates(tx, {
      tenantId: input.tenantId,
      rooftopId: String(row.rooftop_id),
      rule: input.rule,
      partyIds: input.partyIds ?? [],
    });

    await tx.query(
      `DELETE FROM campaign_audience_members WHERE tenant_id = $1 AND campaign_version_id = $2`,
      [input.tenantId, input.campaignVersionId],
    );

    let included = 0;
    let noContact = 0;
    let noConsent = 0;
    let suppressed = 0;
    for (const partyId of candidates) {
      const eligible = await sendEligibility(tx, {
        tenantId: input.tenantId,
        partyId,
        channel,
        purpose,
      });
      if (!eligible.eligible) {
        if (eligible.reason === 'no_contact_value') noContact += 1;
        else if (eligible.reason === 'consent_not_granted') noConsent += 1;
        else suppressed += 1;
        continue;
      }
      await tx.query(
        `INSERT INTO campaign_audience_members
           (tenant_id, campaign_version_id, party_id, included_because)
         VALUES ($1, $2, $3, $4)`,
        [input.tenantId, input.campaignVersionId, partyId, input.rule],
      );
      included += 1;
    }

    const result: AudienceResult = {
      considered: candidates.length,
      included,
      excludedNoContact: noContact,
      excludedNoConsent: noConsent,
      excludedSuppressed: suppressed,
    };
    const mutation = await recordMutation(tx, {
      tenantId: input.tenantId,
      entityType: 'campaign_version',
      entityId: input.campaignVersionId,
      eventType: 'crm.campaign_version.audience_built',
      actingUserLinkId: actor,
      authorizationVersion: Number(
        (
          (
            await tx.query(
              `SELECT authorization_version FROM campaign_versions
                WHERE tenant_id = $1 AND campaign_version_id = $2`,
              [input.tenantId, input.campaignVersionId],
            )
          ).rows[0] as Row
        ).authorization_version,
      ),
      details: { rule: input.rule, ...result },
    });
    return { outcome: 'built' as const, result, mutation };
  });
}

async function resolveAudienceCandidates(
  executor: Executor,
  input: { tenantId: string; rooftopId: string; rule: AudienceRule; partyIds: readonly string[] },
): Promise<string[]> {
  if (input.rule === 'manual_selection') {
    if (input.partyIds.length === 0) return [];
    const found = await executor.query(
      `SELECT party_id FROM parties
        WHERE tenant_id = $1 AND status = 'active' AND party_id = ANY($2::uuid[])
        ORDER BY party_id`,
      [input.tenantId, [...input.partyIds]],
    );
    return (found.rows as Row[]).map((r) => String(r.party_id));
  }
  if (input.rule === 'open_leads') {
    const found = await executor.query(
      `SELECT DISTINCT l.party_id FROM leads l
        WHERE l.tenant_id = $1 AND l.rooftop_id = $2
          AND l.lifecycle_state NOT IN ('handed_off', 'closed')
        ORDER BY l.party_id`,
      [input.tenantId, input.rooftopId],
    );
    return (found.rows as Row[]).map((r) => String(r.party_id));
  }
  if (input.rule === 'prior_buyers') {
    // A prior buyer is somebody a vehicle was acquired FROM or for at this
    // rooftop. Release Train 4 will have a better answer; this one is honest
    // about what the platform can actually see today.
    const found = await executor.query(
      `SELECT DISTINCT s.acquisition_party_id AS party_id
         FROM stock_items s
        WHERE s.tenant_id = $1 AND s.rooftop_id = $2 AND s.acquisition_party_id IS NOT NULL
        ORDER BY 1`,
      [input.tenantId, input.rooftopId],
    );
    return (found.rows as Row[]).map((r) => String(r.party_id));
  }
  const found = await executor.query(
    `SELECT party_id FROM parties WHERE tenant_id = $1 AND status = 'active' ORDER BY party_id`,
    [input.tenantId],
  );
  return (found.rows as Row[]).map((r) => String(r.party_id));
}

export type ApprovalOutcome =
  | { outcome: 'approved'; version: CampaignVersionView; mutation: MutationResult }
  | { outcome: 'version_conflict'; currentVersion: number }
  | { outcome: 'not_found' }
  | { outcome: 'invalid'; error: string };

/**
 * THE GATE. A version may be approved only when it can actually be sent
 * responsibly: a frozen template, a non-empty audience, and an opt-out
 * affordance for anything that is marketing rather than a service reminder.
 */
export async function approveCampaignVersion(input: {
  actingUserLinkId: string;
  tenantId: string;
  campaignId: string;
  campaignVersionId: string;
  expectedVersion: number;
}): Promise<ApprovalOutcome> {
  return withTenantTransaction(input.tenantId, async (tx) => {
    const actor = await requireActor(tx, input.actingUserLinkId);
    if (!(await versionBelongsTo(tx, input.tenantId, input.campaignId, input.campaignVersionId))) {
      return { outcome: 'not_found' as const };
    }
    const found = await tx.query(
      `SELECT v.campaign_version_id, v.campaign_id, v.version_number, v.state,
              v.approved_by_user_link_id, v.approved_at, v.authorization_version,
              c.purpose
         FROM campaign_versions v
         JOIN campaigns c ON c.tenant_id = v.tenant_id AND c.campaign_id = v.campaign_id
        WHERE v.tenant_id = $1 AND v.campaign_version_id = $2
        FOR UPDATE OF v`,
      [input.tenantId, input.campaignVersionId],
    );
    if (found.rows.length === 0) return { outcome: 'not_found' as const };
    const row = found.rows[0] as Row;
    const current = mapVersion(row);
    if (current.state !== 'draft') {
      return {
        outcome: 'invalid' as const,
        error: `a ${current.state} version cannot be approved`,
      };
    }
    if (current.authorizationVersion !== input.expectedVersion) {
      return { outcome: 'version_conflict' as const, currentVersion: current.authorizationVersion };
    }
    const template = await tx.query(
      `SELECT includes_opt_out FROM campaign_templates
        WHERE tenant_id = $1 AND campaign_version_id = $2`,
      [input.tenantId, input.campaignVersionId],
    );
    if (template.rows.length === 0) {
      return { outcome: 'invalid' as const, error: 'a version needs its message before approval' };
    }
    const purpose = String(row.purpose);
    if (purpose !== 'service_reminder' && (template.rows[0] as Row).includes_opt_out !== true) {
      return {
        outcome: 'invalid' as const,
        error: 'a marketing message carries a way to opt out of it',
      };
    }
    const audience = await tx.query(
      `SELECT COUNT(*)::int AS n FROM campaign_audience_members
        WHERE tenant_id = $1 AND campaign_version_id = $2`,
      [input.tenantId, input.campaignVersionId],
    );
    if (Number((audience.rows[0] as Row).n) === 0) {
      return {
        outcome: 'invalid' as const,
        error: 'a version with nobody to send to is not ready',
      };
    }

    const written = await tx.query(
      `UPDATE campaign_versions
          SET state = 'approved', approved_by_user_link_id = $3, approved_at = NOW(),
              updated_by_user_link_id = $3, updated_at = NOW(),
              authorization_version = authorization_version + 1
        WHERE tenant_id = $1 AND campaign_version_id = $2 AND authorization_version = $4
        RETURNING ${VERSION_COLUMNS}`,
      [input.tenantId, input.campaignVersionId, actor, input.expectedVersion],
    );
    if (written.rows.length === 0) {
      return { outcome: 'version_conflict' as const, currentVersion: current.authorizationVersion };
    }
    const version = mapVersion(written.rows[0] as Row);
    const mutation = await recordMutation(tx, {
      tenantId: input.tenantId,
      entityType: 'campaign_version',
      entityId: version.campaignVersionId,
      eventType: 'crm.campaign_version.approved',
      actingUserLinkId: actor,
      authorizationVersion: version.authorizationVersion,
      details: {
        campaign_id: version.campaignId,
        version_number: version.versionNumber,
        audience_size: Number((audience.rows[0] as Row).n),
      },
    });
    return { outcome: 'approved' as const, version, mutation };
  });
}

export interface ExecutionResult {
  readonly prepared: number;
  readonly withheld: number;
}

export type ExecutionOutcome =
  | {
      outcome: 'executing';
      version: CampaignVersionView;
      result: ExecutionResult;
      mutation: MutationResult;
    }
  | { outcome: 'already_executing'; version: CampaignVersionView }
  | { outcome: 'version_conflict'; currentVersion: number }
  | { outcome: 'not_found' }
  | { outcome: 'invalid'; error: string };

/**
 * LAUNCHES a version: turns the frozen audience into pending sends, moves the
 * version to `executing`, and raises ONE outbox event in the same transaction —
 * so a launched campaign can never be a campaign with nothing to deliver it,
 * nor a delivery for a campaign nobody launched.
 *
 * Preparation ALSO checks eligibility, and records the people it will not
 * contact as withheld sends rather than dropping them. A silent drop is
 * indistinguishable from a bug; a `suppressed` send with a reason is an answer.
 */
export async function executeCampaignVersion(input: {
  actingUserLinkId: string;
  tenantId: string;
  campaignId: string;
  campaignVersionId: string;
  expectedVersion: number;
}): Promise<ExecutionOutcome> {
  return withTenantTransaction(input.tenantId, async (tx) => {
    const actor = await requireActor(tx, input.actingUserLinkId);
    if (!(await versionBelongsTo(tx, input.tenantId, input.campaignId, input.campaignVersionId))) {
      return { outcome: 'not_found' as const };
    }
    const found = await tx.query(
      `SELECT v.campaign_version_id, v.campaign_id, v.version_number, v.state,
              v.approved_by_user_link_id, v.approved_at, v.authorization_version,
              c.channel, c.purpose
         FROM campaign_versions v
         JOIN campaigns c ON c.tenant_id = v.tenant_id AND c.campaign_id = v.campaign_id
        WHERE v.tenant_id = $1 AND v.campaign_version_id = $2
        FOR UPDATE OF v`,
      [input.tenantId, input.campaignVersionId],
    );
    if (found.rows.length === 0) return { outcome: 'not_found' as const };
    const row = found.rows[0] as Row;
    const current = mapVersion(row);
    if (current.state === 'executing') {
      return { outcome: 'already_executing' as const, version: current };
    }
    if (current.state !== 'approved') {
      return { outcome: 'invalid' as const, error: 'only an approved version may be launched' };
    }
    if (current.authorizationVersion !== input.expectedVersion) {
      return { outcome: 'version_conflict' as const, currentVersion: current.authorizationVersion };
    }
    const channel = String(row.channel) as CampaignChannel;
    const purpose = String(row.purpose) as ConsentPurpose;

    const members = await tx.query(
      `SELECT party_id FROM campaign_audience_members
        WHERE tenant_id = $1 AND campaign_version_id = $2 ORDER BY party_id`,
      [input.tenantId, input.campaignVersionId],
    );
    let prepared = 0;
    let withheld = 0;
    for (const member of members.rows as Row[]) {
      const partyId = String(member.party_id);
      const eligible = await sendEligibility(tx, {
        tenantId: input.tenantId,
        partyId,
        channel,
        purpose,
      });
      if (eligible.eligible) {
        await tx.query(
          `INSERT INTO campaign_sends
             (tenant_id, campaign_version_id, party_id, channel, contact_value,
              created_by_user_link_id, updated_by_user_link_id)
           VALUES ($1, $2, $3, $4, $5, $6, $6)
           ON CONFLICT (tenant_id, campaign_version_id, party_id) DO NOTHING`,
          [input.tenantId, input.campaignVersionId, partyId, channel, eligible.contactValue, actor],
        );
        prepared += 1;
      } else {
        await tx.query(
          `INSERT INTO campaign_sends
             (tenant_id, campaign_version_id, party_id, channel, contact_value, state,
              withheld_reason, created_by_user_link_id, updated_by_user_link_id)
           VALUES ($1, $2, $3, $4, '(withheld)', 'suppressed', $5, $6, $6)
           ON CONFLICT (tenant_id, campaign_version_id, party_id) DO NOTHING`,
          [input.tenantId, input.campaignVersionId, partyId, channel, eligible.reason, actor],
        );
        withheld += 1;
      }
    }

    const written = await tx.query(
      `UPDATE campaign_versions
          SET state = 'executing', execution_started_at = NOW(),
              updated_by_user_link_id = $3, updated_at = NOW(),
              authorization_version = authorization_version + 1
        WHERE tenant_id = $1 AND campaign_version_id = $2 AND authorization_version = $4
        RETURNING ${VERSION_COLUMNS}`,
      [input.tenantId, input.campaignVersionId, actor, input.expectedVersion],
    );
    if (written.rows.length === 0) {
      return { outcome: 'version_conflict' as const, currentVersion: current.authorizationVersion };
    }
    const version = mapVersion(written.rows[0] as Row);

    // A CAMPAIGN BECOMES ACTIVE BY SENDING SOMETHING. Nothing else moved this
    // status, which made the "active campaigns" count on the manager's screen a
    // number that could only ever be zero — a dashboard figure with no path to
    // any other value is worse than an absent one, because it reads as an
    // answer. Launching a version is the event that means it, so it is where
    // the transition belongs, in the same transaction as the launch.
    await tx.query(
      `UPDATE campaigns
          SET status = 'active', updated_by_user_link_id = $3, updated_at = NOW(),
              authorization_version = authorization_version + 1
        WHERE tenant_id = $1 AND campaign_id = $2 AND status = 'draft'`,
      [input.tenantId, version.campaignId, actor],
    );

    await tx.query(
      `INSERT INTO admin_outbox (tenant_id, event_type, payload) VALUES ($1, $2, $3)`,
      [
        input.tenantId,
        CAMPAIGN_DISPATCH_EVENT,
        JSON.stringify({ campaign_version_id: version.campaignVersionId }),
      ],
    );

    const mutation = await recordMutation(tx, {
      tenantId: input.tenantId,
      entityType: 'campaign_version',
      entityId: version.campaignVersionId,
      eventType: 'crm.campaign_version.executing',
      actingUserLinkId: actor,
      authorizationVersion: version.authorizationVersion,
      details: { campaign_id: version.campaignId, prepared, withheld },
    });
    return {
      outcome: 'executing' as const,
      version,
      result: { prepared, withheld },
      mutation,
    };
  });
}
