import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, beforeEach, describe, test } from 'node:test';
import {
  bootstrapAdministrator,
  fixtureAuthorizationStateWrite,
  resetDatabase,
  seedActor,
  seedDealerGroup,
  seedLegalEntity,
  seedRooftop,
  seedTenantIdentity,
  skipIntegration,
  startIdentityTestEnv,
  type IdentityTestEnv,
} from '@dealer/test-kit';
import { closePool, query } from '@dealer/database';
import { ROLES } from '@dealer/contracts';
import { createParty, mergeParties } from '@dealer/inventory';
import {
  captureLead,
  createCampaign,
  createQueue,
  defineLeadSource,
  dispatchDueSends,
  draftCampaignVersion,
  setPurposeConsent,
} from '@dealer/crm';
import { createApp, resetAuthRoutesForTests, resetIdentityCompositionForTests } from '@dealer/api';

/**
 * RT3-C1 — EXACT AUTHORITY, AND THE MONEY THAT CANNOT BE CLAIMED.
 *
 * Four things the earlier submission got wrong, each proved here on the real
 * HTTP stack or against the real schema:
 *
 *   * EXACT PARENT. The policy engine authorizes a RESOURCE. A child addressed
 *     beside a parent it does not belong to is a caller reaching past the grant
 *     they were given, and the platform used to let them: an activity had no
 *     parent in its route at all, and a campaign version or send was taken from
 *     the path without ever being tied to the campaign the engine decided.
 *   * ROOFTOP AND ASSIGNMENT. A lead may only be handed to somebody who can
 *     reach its rooftop, and may only wait in a queue at that rooftop.
 *   * TERMINAL STATE. A handed-off lead belongs to sales; the CRM stops.
 *   * REVENUE. Money is not merely unwritten before Sales exists — it is
 *     unrepresentable.
 */
describe(
  'crm: exact authority and the revenue prohibition (RT3-C1)',
  { skip: skipIntegration ? 'set TEST_DATABASE_URL to run' : false },
  () => {
    let server: Server;
    let base: string;
    let env: IdentityTestEnv;

    before(async () => {
      env = await startIdentityTestEnv();
      resetIdentityCompositionForTests();
      resetAuthRoutesForTests();
      server = createApp().listen(0);
      await new Promise<void>((resolve) => server.once('listening', () => resolve()));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    after(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await env.stop();
      await closePool();
    });

    beforeEach(async () => {
      await resetDatabase();
    });

    type ParsedJson = ReturnType<typeof JSON.parse>;

    async function call(token: string, method: string, path: string, payload?: unknown) {
      const res = await fetch(base + path, {
        method,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          'idempotency-key': randomUUID(),
        },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      });
      const text = await res.text();
      return { status: res.status, body: text ? (JSON.parse(text) as ParsedJson) : null };
    }

    interface House {
      tenantId: string;
      north: string;
      south: string;
      admin: string;
    }

    async function seedHouse(name: string): Promise<House> {
      const tenantId = randomUUID();
      await seedTenantIdentity(tenantId, name);
      const group = await seedDealerGroup({ tenantId, name: `${name} Group`, status: 'active' });
      const entity = await seedLegalEntity({
        tenantId,
        dealerGroupId: group.dealerGroupId,
        name: `${name} LLC`,
        status: 'active',
      });
      const north = await seedRooftop({
        tenantId,
        legalEntityId: entity.legalEntityId,
        name: `${name} North`,
        status: 'active',
      });
      const south = await seedRooftop({
        tenantId,
        legalEntityId: entity.legalEntityId,
        name: `${name} South`,
        status: 'active',
      });
      const admin = await bootstrapAdministrator(tenantId);
      const source = await defineLeadSource({
        actingUserLinkId: admin,
        tenantId,
        sourceCode: 'website',
        displayName: 'Website',
        channel: 'web',
        medium: 'organic',
      });
      assert.equal(source.outcome, 'saved');
      return { tenantId, north: north.rooftopId, south: south.rooftopId, admin };
    }

    async function seedLead(house: House, rooftopId: string, who: string): Promise<string> {
      const captured = await captureLead({
        actingUserLinkId: house.admin,
        tenantId: house.tenantId,
        rooftopId,
        intakeKey: `${who}-${randomUUID().slice(0, 8)}`,
        channel: 'manual',
        sourceCode: 'website',
        party: { givenName: who, familyName: 'Customer', email: `${who}@example.com` },
      });
      assert.equal(captured.outcome, 'created', JSON.stringify(captured));
      return (captured as { lead: { leadId: string } }).lead.leadId;
    }

    // ── exact parent ────────────────────────────────────────────────────────

    test('an activity is reachable only through the lead that authorizes it', async () => {
      const house = await seedHouse('Aurora');
      const northLead = await seedLead(house, house.north, 'north');
      const southLead = await seedLead(house, house.south, 'south');

      const northAgent = await seedActor(env.issuer, {
        tenantId: house.tenantId,
        roles: [ROLES.BDC_AGENT],
        scope: { level: 'rooftop', id: house.north },
      });

      // An activity on the SOUTH lead, created by somebody who may.
      const southActivity = await call(
        (await seedActor(env.issuer, { tenantId: house.tenantId, roles: [ROLES.BDC_AGENT] })).token,
        'POST',
        `/api/crm/leads/${southLead}/activities`,
        { kind: 'task', subject: 'Call back on Tuesday' },
      );
      assert.equal(southActivity.status, 201, JSON.stringify(southActivity.body));
      const southActivityId = String(southActivity.body!.activity.activityId);
      const version = Number(southActivity.body!.activity.authorizationVersion);

      // CONTROL: the north agent can close an activity on their OWN lead.
      const own = await call(northAgent.token, 'POST', `/api/crm/leads/${northLead}/activities`, {
        kind: 'task',
        subject: 'Send the brochure',
      });
      assert.equal(own.status, 201);
      const closedOwn = await call(
        northAgent.token,
        'POST',
        `/api/crm/leads/${northLead}/activities/${String(own.body!.activity.activityId)}/close`,
        { expected_version: Number(own.body!.activity.authorizationVersion), state: 'completed' },
      );
      assert.equal(closedOwn.status, 200, 'CONTROL: their own lead’s activity closes');

      // …and cannot reach the south lead's activity by naming their own lead.
      const smuggled = await call(
        northAgent.token,
        `POST`,
        `/api/crm/leads/${northLead}/activities/${southActivityId}/close`,
        { expected_version: version, state: 'completed' },
      );
      assert.equal(smuggled.status, 404, 'a child of another lead is not found under this one');

      // …nor by naming the south lead, which they cannot reach at all.
      const direct = await call(
        northAgent.token,
        'POST',
        `/api/crm/leads/${southLead}/activities/${southActivityId}/close`,
        { expected_version: version, state: 'completed' },
      );
      assert.equal(direct.status, 404, 'and the south lead does not exist for them');

      // The activity is untouched by either attempt.
      const still = await query(
        `SELECT state FROM lead_activities WHERE tenant_id = $1 AND activity_id = $2`,
        [house.tenantId, southActivityId],
      );
      assert.equal(String((still.rows[0] as { state: string }).state), 'open');
    });

    test('a campaign version is reachable only through the campaign that authorizes it', async () => {
      const house = await seedHouse('Aurora');
      const manager = await seedActor(env.issuer, {
        tenantId: house.tenantId,
        roles: [ROLES.MARKETING_MANAGER],
        scope: { level: 'rooftop', id: house.north },
      });

      // Two campaigns at two rooftops, each with a draft version.
      const mine = await createCampaign({
        actingUserLinkId: house.admin,
        tenantId: house.tenantId,
        rooftopId: house.north,
        name: 'North spring',
        channel: 'email',
        purpose: 'sales_marketing',
        sourceCode: 'website',
      });
      const theirs = await createCampaign({
        actingUserLinkId: house.admin,
        tenantId: house.tenantId,
        rooftopId: house.south,
        name: 'South spring',
        channel: 'email',
        purpose: 'sales_marketing',
        sourceCode: 'website',
      });
      assert.equal(mine.outcome, 'created');
      assert.equal(theirs.outcome, 'created');
      const mineId = (mine as { campaign: { campaignId: string } }).campaign.campaignId;
      const theirsId = (theirs as { campaign: { campaignId: string } }).campaign.campaignId;

      const theirVersion = await draftCampaignVersion({
        actingUserLinkId: house.admin,
        tenantId: house.tenantId,
        campaignId: theirsId,
        subject: 'South',
        body: 'South only. Reply STOP to unsubscribe.',
      });
      assert.equal(theirVersion.outcome, 'drafted');
      const theirVersionId = (theirVersion as { version: { campaignVersionId: string } }).version
        .campaignVersionId;
      const theirVersionNo = (theirVersion as { version: { authorizationVersion: number } }).version
        .authorizationVersion;

      // CONTROL: the manager may draft on their OWN campaign.
      const ownDraft = await call(manager.token, 'POST', `/api/crm/campaigns/${mineId}/versions`, {
        subject: 'North',
        body: 'North only. Reply STOP to unsubscribe.',
      });
      assert.equal(ownDraft.status, 201, JSON.stringify(ownDraft.body));

      // …and cannot touch the OTHER campaign's version by naming their own
      // campaign beside it. Audience, approval and launch, each refused.
      for (const [label, path, payload] of [
        [
          'audience',
          `/api/crm/campaigns/${mineId}/versions/${theirVersionId}/audience`,
          { rule: 'all_active_customers' },
        ],
        [
          'approve',
          `/api/crm/campaigns/${mineId}/versions/${theirVersionId}/approve`,
          { expected_version: theirVersionNo },
        ],
        [
          'execute',
          `/api/crm/campaigns/${mineId}/versions/${theirVersionId}/execute`,
          { expected_version: theirVersionNo },
        ],
      ] as Array<[string, string, unknown]>) {
        const refused = await call(manager.token, 'POST', path, payload);
        assert.equal(refused.status, 404, `${label}: a foreign version is not found under mine`);
      }

      // …and naming the other campaign directly is refused at the rooftop.
      const direct = await call(
        manager.token,
        'POST',
        `/api/crm/campaigns/${theirsId}/versions/${theirVersionId}/approve`,
        { expected_version: theirVersionNo },
      );
      assert.equal(direct.status, 404, 'the south campaign does not exist for a north manager');

      // Nothing moved.
      const state = await query(
        `SELECT state FROM campaign_versions WHERE tenant_id = $1 AND campaign_version_id = $2`,
        [house.tenantId, theirVersionId],
      );
      assert.equal(String((state.rows[0] as { state: string }).state), 'draft');
    });

    // ── rooftop and assignment authority ────────────────────────────────────

    test('a lead is assignable only to somebody who works its rooftop', async () => {
      const house = await seedHouse('Aurora');
      const northLead = await seedLead(house, house.north, 'ivy');
      const manager = await seedActor(env.issuer, {
        tenantId: house.tenantId,
        roles: [ROLES.MARKETING_MANAGER],
      });
      const northAgent = await seedActor(env.issuer, {
        tenantId: house.tenantId,
        roles: [ROLES.BDC_AGENT],
        scope: { level: 'rooftop', id: house.north },
      });
      const southAgent = await seedActor(env.issuer, {
        tenantId: house.tenantId,
        roles: [ROLES.BDC_AGENT],
        scope: { level: 'rooftop', id: house.south },
      });

      const lead = await call(manager.token, 'GET', `/api/crm/leads/${northLead}`);
      const v = Number(lead.body!.lead.authorizationVersion);

      // A lead nobody could work is not an assignment the platform should take.
      const wrong = await call(manager.token, 'POST', `/api/crm/leads/${northLead}/assignment`, {
        expected_version: v,
        to_user_link_id: southAgent.userLinkId,
        reason: 'manual_assignment',
      });
      assert.equal(wrong.status, 422, JSON.stringify(wrong.body));
      assert.match(String(wrong.body!.detail), /does not work the rooftop/);

      // CONTROL: the north agent takes it.
      const right = await call(manager.token, 'POST', `/api/crm/leads/${northLead}/assignment`, {
        expected_version: v,
        to_user_link_id: northAgent.userLinkId,
        reason: 'manual_assignment',
      });
      assert.equal(right.status, 200, JSON.stringify(right.body));
      assert.equal(right.body!.lead.ownerUserLinkId, northAgent.userLinkId);

      // A QUEUE AT THE WRONG ROOFTOP is refused on the same reasoning.
      const southQueue = await createQueue({
        actingUserLinkId: house.admin,
        tenantId: house.tenantId,
        rooftopId: house.south,
        name: 'South overflow',
      });
      assert.equal(southQueue.outcome, 'saved');
      const parked = await call(manager.token, 'POST', `/api/crm/leads/${northLead}/assignment`, {
        expected_version: Number(right.body!.lead.authorizationVersion),
        queue_id: (southQueue as { queue: { queueId: string } }).queue.queueId,
        reason: 'queue_return',
      });
      assert.equal(parked.status, 422);
      assert.match(String(parked.body!.detail), /different rooftop/);
    });

    // ── terminal-state authority ────────────────────────────────────────────

    test('a handed-off lead takes no further CRM work', async () => {
      const house = await seedHouse('Aurora');
      const leadId = await seedLead(house, house.north, 'noor');
      const agent = await seedActor(env.issuer, {
        tenantId: house.tenantId,
        roles: [ROLES.BDC_AGENT, ROLES.MARKETING_MANAGER],
      });

      // An open task, created before the handoff.
      const task = await call(agent.token, 'POST', `/api/crm/leads/${leadId}/activities`, {
        kind: 'task',
        subject: 'Follow up Friday',
      });
      assert.equal(task.status, 201);
      const taskId = String(task.body!.activity.activityId);
      const taskVersion = Number(task.body!.activity.authorizationVersion);

      const lead = (await call(agent.token, 'GET', `/api/crm/leads/${leadId}`)).body!.lead;
      const working = await call(agent.token, 'POST', `/api/crm/leads/${leadId}/assignment`, {
        expected_version: lead.authorizationVersion,
        to_user_link_id: agent.userLinkId,
        reason: 'initial_routing',
      });
      assert.equal(working.status, 200);
      const qualified = await call(agent.token, 'POST', `/api/crm/leads/${leadId}/transition`, {
        expected_version: working.body!.lead.authorizationVersion,
        to_state: 'qualified',
      });
      assert.equal(qualified.status, 200);
      const handed = await call(agent.token, 'POST', `/api/crm/leads/${leadId}/handoff`, {
        expected_version: qualified.body!.lead.authorizationVersion,
        handed_to_user_link_id: agent.userLinkId,
      });
      assert.equal(handed.status, 201);

      // EVERY door is closed, and each says which state closed it.
      const logged = await call(agent.token, 'POST', `/api/crm/leads/${leadId}/activities`, {
        kind: 'note',
        subject: 'One more thought',
      });
      assert.equal(logged.status, 422, 'no new activity');
      assert.match(String(logged.body!.detail), /handed_off/);

      const closedTask = await call(
        agent.token,
        'POST',
        `/api/crm/leads/${leadId}/activities/${taskId}/close`,
        { expected_version: taskVersion, state: 'completed' },
      );
      assert.equal(closedTask.status, 422, 'not even finishing an existing task');

      const booked = await call(agent.token, 'POST', `/api/crm/leads/${leadId}/appointments`, {
        purpose: 'test_drive',
        starts_at: new Date(Date.now() + 86_400_000).toISOString(),
        ends_at: new Date(Date.now() + 90_000_000).toISOString(),
      });
      assert.equal(booked.status, 422, 'no new appointment');

      // The task is exactly as it was — refusals changed nothing.
      const untouched = await query(
        `SELECT state, authorization_version FROM lead_activities
          WHERE tenant_id = $1 AND activity_id = $2`,
        [house.tenantId, taskId],
      );
      const row = untouched.rows[0] as { state: string; authorization_version: number };
      assert.equal(row.state, 'open');
      assert.equal(Number(row.authorization_version), taskVersion);
    });

    // ── the revenue prohibition ─────────────────────────────────────────────

    test('pre-sale revenue and ROI are unrepresentable, not merely unwritten', async () => {
      const house = await seedHouse('Aurora');

      // The honest row is accepted.
      const ok = await fixtureAuthorizationStateWrite(
        'seed-authorization-state',
        `INSERT INTO attribution_runs
           (tenant_id, rooftop_id, model, window_start, window_end,
            computed_by_user_link_id, updated_by_user_link_id)
         VALUES ($1, $2, 'linear', NOW() - INTERVAL '30 days', NOW(), $3, $3)
         RETURNING attribution_run_id, revenue_status`,
        [house.tenantId, house.north, house.admin],
      );
      assert.equal(ok.rows.length, 1, 'CONTROL: a run with no money claim is fine');
      assert.equal(
        String((ok.rows[0] as { revenue_status: string }).revenue_status),
        'NOT_YET_AVAILABLE',
      );

      // …and every way of claiming money before a sale exists is refused BY THE
      // DATABASE. A convention would hold until somebody wrote the row; this
      // holds because the row cannot exist.
      for (const [label, columns, values] of [
        ['a revenue amount', 'attributed_revenue_cents', '250000'],
        ['a campaign cost', 'campaign_cost_cents', '5000'],
      ] as Array<[string, string, string]>) {
        await assert.rejects(
          fixtureAuthorizationStateWrite(
            'adversarial-bypass-attempt',
            `INSERT INTO attribution_runs
               (tenant_id, rooftop_id, model, window_start, window_end,
                computed_by_user_link_id, updated_by_user_link_id, ${columns})
             VALUES ($1, $2, 'linear', NOW() - INTERVAL '30 days', NOW(), $3, $3, ${values})`,
            [house.tenantId, house.north, house.admin],
          ),
          /ck_attribution_pre_sale_revenue/,
          `${label} is refused`,
        );
      }

      await assert.rejects(
        fixtureAuthorizationStateWrite(
          'adversarial-bypass-attempt',
          `INSERT INTO attribution_runs
             (tenant_id, rooftop_id, model, window_start, window_end,
              computed_by_user_link_id, updated_by_user_link_id, revenue_status)
           VALUES ($1, $2, 'linear', NOW() - INTERVAL '30 days', NOW(), $3, $3, 'AVAILABLE')`,
          [house.tenantId, house.north, house.admin],
        ),
        /ck_attribution_pre_sale_revenue/,
        'and so is declaring revenue AVAILABLE with no amount at all',
      );

      // …including by editing a row that was written honestly.
      await assert.rejects(
        fixtureAuthorizationStateWrite(
          'adversarial-bypass-attempt',
          `UPDATE attribution_runs
              SET revenue_status = 'AVAILABLE', attributed_revenue_cents = 999
            WHERE tenant_id = $1`,
          [house.tenantId],
        ),
        /ck_attribution_pre_sale_revenue/,
        'an existing run cannot be edited into claiming money either',
      );

      // The constraint is on the table, by name, so this is not a coincidence
      // of the statements above.
      const constraint = await query(
        `SELECT pg_get_constraintdef(c.oid) AS def
           FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
          WHERE t.relname = 'attribution_runs' AND c.conname = 'ck_attribution_pre_sale_revenue'`,
      );
      assert.equal(constraint.rows.length, 1, 'the prohibition is a named constraint');
      const def = String((constraint.rows[0] as { def: string }).def);
      assert.match(def, /NOT_YET_AVAILABLE/);
    });

    test('a customer archived after approval is withheld as inactive, not as unreachable', async () => {
      const house = await seedHouse('Aurora');
      const party = await createParty({
        actingUserLinkId: house.admin,
        tenantId: house.tenantId,
        partyType: 'person',
        details: { givenName: 'Merged', familyName: 'Away', email: 'merged.away@example.com' },
      });
      assert.equal(party.outcome, 'created');
      const partyId = (party as { party: { partyId: string } }).party.partyId;
      const consent = await setPurposeConsent({
        actingUserLinkId: house.admin,
        tenantId: house.tenantId,
        partyId,
        channel: 'email',
        purpose: 'sales_marketing',
        state: 'granted',
        source: 'counter',
      });
      assert.equal(consent.outcome, 'saved');

      const campaign = await createCampaign({
        actingUserLinkId: house.admin,
        tenantId: house.tenantId,
        rooftopId: house.north,
        name: 'Aurora spring',
        channel: 'email',
        purpose: 'sales_marketing',
        sourceCode: 'website',
        quietHoursStartMinute: 0,
        quietHoursEndMinute: 0,
      });
      assert.equal(campaign.outcome, 'created');
      const campaignId = (campaign as { campaign: { campaignId: string } }).campaign.campaignId;
      const version = await draftCampaignVersion({
        actingUserLinkId: house.admin,
        tenantId: house.tenantId,
        campaignId,
        subject: 'Spring',
        body: 'Come along. Reply STOP to unsubscribe.',
      });
      assert.equal(version.outcome, 'drafted');
      const versionId = (version as { version: { campaignVersionId: string } }).version
        .campaignVersionId;

      const manager = await seedActor(env.issuer, {
        tenantId: house.tenantId,
        roles: [ROLES.MARKETING_MANAGER],
      });
      const built = await call(
        manager.token,
        'POST',
        `/api/crm/campaigns/${campaignId}/versions/${versionId}/audience`,
        { rule: 'all_active_customers' },
      );
      assert.equal(built.status, 200, JSON.stringify(built.body));
      assert.equal(built.body!.audience.included, 1, 'CONTROL: reachable when the audience is set');

      const approved = await call(
        manager.token,
        'POST',
        `/api/crm/campaigns/${campaignId}/versions/${versionId}/approve`,
        { expected_version: Number(built.body!.audience ? 1 : 1) },
      );
      assert.equal(approved.status, 200, JSON.stringify(approved.body));
      const launched = await call(
        manager.token,
        'POST',
        `/api/crm/campaigns/${campaignId}/versions/${versionId}/execute`,
        { expected_version: Number(approved.body!.version.authorizationVersion) },
      );
      assert.equal(launched.status, 202, JSON.stringify(launched.body));

      // THE RECORD IS MERGED AWAY AFTER THE MESSAGE IS QUEUED — through Release
      // Train 2's real merge, because that is how a customer record actually
      // stops being current. It still has an address and still has permission;
      // what it no longer is, is the record for that person. Only the send-time
      // check can see it, and this is the ordinary reason it happens.
      const survivor = await createParty({
        actingUserLinkId: house.admin,
        tenantId: house.tenantId,
        partyType: 'person',
        details: { givenName: 'Merged', familyName: 'Survivor', email: 'survivor@example.com' },
      });
      assert.equal(survivor.outcome, 'created');
      const merged = await mergeParties({
        actingUserLinkId: house.admin,
        tenantId: house.tenantId,
        survivingPartyId: (survivor as { party: { partyId: string } }).party.partyId,
        mergedPartyId: partyId,
        reason: 'duplicate record found after the campaign was approved',
      });
      assert.equal(merged.outcome, 'merged', JSON.stringify(merged));

      const pass = await dispatchDueSends({ tenantId: house.tenantId });
      assert.equal(pass.sent, 0, 'nothing goes to a record that is no longer a customer');
      assert.equal(pass.suppressed, 1);

      const withheld = await query(
        `SELECT state, withheld_reason FROM campaign_sends WHERE tenant_id = $1`,
        [house.tenantId],
      );
      const row = withheld.rows[0] as { state: string; withheld_reason: string };
      assert.equal(row.state, 'suppressed');
      // THE REASON IS THE REAL ONE. Reporting this as `no_contact_value` would
      // send a marketer hunting a data-quality problem that does not exist —
      // the address is fine, the customer record is not current.
      assert.equal(row.withheld_reason, 'party_inactive');
    });
  },
);
