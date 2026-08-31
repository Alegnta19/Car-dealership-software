import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, beforeEach, describe, test } from 'node:test';
import {
  resetDatabase,
  seedActor,
  seedDealerGroup,
  seedLegalEntity,
  seedRooftop,
  fixtureAuthorizationStateWrite,
  seedTenantIdentity,
  skipIntegration,
  startIdentityTestEnv,
  type IdentityTestEnv,
} from '@dealer/test-kit';
import { closePool, query } from '@dealer/database';
import { ROLES } from '@dealer/contracts';
import { createParty } from '@dealer/inventory';
import {
  dispatchDueSends,
  drainMarketingOutbox,
  insideQuietHours,
  quietHoursEndAfter,
  runCampaignDispatchPass,
  simulatedProviderRef,
} from '@dealer/crm';
import { createApp, resetAuthRoutesForTests, resetIdentityCompositionForTests } from '@dealer/api';

/**
 * RELEASE TRAIN 3, ROW 4 — CONSENT-SAFE CAMPAIGNS.
 *
 * The row this battery exists for is the one a customer would sue over. It
 * proves, separately:
 *
 *   * permission gates the audience, per channel AND purpose;
 *   * a version cannot be approved without a message, an audience and a way to
 *     opt out of it;
 *   * SUPPRESSION IS RE-CHECKED AT SEND TIME — the opt-out that lands between
 *     approval and delivery is the one that matters, and audience-time
 *     filtering cannot see it;
 *   * quiet hours defer rather than fail;
 *   * a transient provider failure is retried and a permanent one is not;
 *   * delivery is at least once and the effect is exactly once;
 *   * a reply becomes pipeline and an opt-out becomes silence, both idempotently.
 */
describe(
  'crm: consent-safe campaigns (RT3 row 4)',
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

    interface World {
      tenantId: string;
      rooftopId: string;
      manager: { userLinkId: string; token: string };
    }

    async function seedWorld(): Promise<World> {
      const tenantId = randomUUID();
      await seedTenantIdentity(tenantId, 'Aurora Auto Group');
      const group = await seedDealerGroup({ tenantId, name: 'Aurora Group', status: 'active' });
      const entity = await seedLegalEntity({
        tenantId,
        dealerGroupId: group.dealerGroupId,
        name: 'Aurora LLC',
        status: 'active',
      });
      const rooftop = await seedRooftop({
        tenantId,
        legalEntityId: entity.legalEntityId,
        name: 'Downtown',
        status: 'active',
      });
      const manager = await seedActor(env.issuer, {
        tenantId,
        roles: [ROLES.MARKETING_MANAGER],
      });
      const w = {
        tenantId,
        rooftopId: rooftop.rooftopId,
        manager: { userLinkId: manager.userLinkId, token: manager.token },
      };
      const source = await call(w.manager.token, 'POST', '/api/crm/sources', {
        source_code: 'newsletter',
        display_name: 'Newsletter',
        channel: 'campaign',
        medium: 'owned',
      });
      assert.equal(source.status, 201);
      return w;
    }

    /** A customer with an email address, and optionally permission to use it. */
    async function seedCustomer(
      w: World,
      given: string,
      email: string,
      consent: 'granted' | 'withdrawn' | 'none' = 'granted',
    ): Promise<string> {
      const made = await createParty({
        actingUserLinkId: w.manager.userLinkId,
        tenantId: w.tenantId,
        partyType: 'person',
        details: { givenName: given, familyName: 'Reader', email },
      });
      assert.equal(made.outcome, 'created', `${given}: ${JSON.stringify(made)}`);
      const partyId = (made as { party: { partyId: string } }).party.partyId;
      if (consent !== 'none') {
        const set = await call(w.manager.token, 'PUT', `/api/crm/parties/${partyId}/consents`, {
          channel: 'email',
          purpose: 'sales_marketing',
          state: consent,
          source: 'web form',
        });
        assert.equal(set.status, 200, JSON.stringify(set.body));
      }
      return partyId;
    }

    /** A campaign whose quiet hours are wide open, so timing is not in play. */
    async function seedCampaign(w: World, quiet?: { start: number; end: number }) {
      const created = await call(w.manager.token, 'POST', '/api/crm/campaigns', {
        location_id: w.rooftopId,
        name: `Spring ${randomUUID().slice(0, 8)}`,
        channel: 'email',
        purpose: 'sales_marketing',
        source_code: 'newsletter',
        quiet_hours_start_minute: quiet?.start ?? 0,
        quiet_hours_end_minute: quiet?.end ?? 0,
        time_zone: 'UTC',
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      return String(created.body!.campaign.campaignId);
    }

    async function draftVersion(w: World, campaignId: string, optOut = true) {
      const drafted = await call(
        w.manager.token,
        'POST',
        `/api/crm/campaigns/${campaignId}/versions`,
        {
          subject: 'Our spring event',
          body: 'Come and see us. Reply STOP to unsubscribe.',
          includes_opt_out: optOut,
        },
      );
      assert.equal(drafted.status, 201, JSON.stringify(drafted.body));
      return drafted.body!.version as { campaignVersionId: string; authorizationVersion: number };
    }

    async function sendsOf(tenantId: string, versionId: string) {
      const found = await query(
        `SELECT s.send_id::text, s.state, s.withheld_reason, s.attempts, s.external_ref,
                p.email
           FROM campaign_sends s
           JOIN parties p ON p.tenant_id = s.tenant_id AND p.party_id = s.party_id
          WHERE s.tenant_id = $1 AND s.campaign_version_id = $2
          ORDER BY p.email`,
        [tenantId, versionId],
      );
      return found.rows as Array<{
        send_id: string;
        state: string;
        withheld_reason: string | null;
        attempts: number;
        external_ref: string | null;
        email: string;
      }>;
    }

    test('permission gates the audience, per channel and per purpose', async () => {
      const w = await seedWorld();
      await seedCustomer(w, 'Yes', 'yes@example.com', 'granted');
      await seedCustomer(w, 'No', 'no@example.com', 'withdrawn');
      await seedCustomer(w, 'Silent', 'silent@example.com', 'none');
      const partyWrongPurpose = await seedCustomer(w, 'Service', 'service@example.com', 'none');
      const other = await call(
        w.manager.token,
        'PUT',
        `/api/crm/parties/${partyWrongPurpose}/consents`,
        { channel: 'email', purpose: 'service_reminder', state: 'granted', source: 'counter' },
      );
      assert.equal(other.status, 200);

      const campaignId = await seedCampaign(w);
      const version = await draftVersion(w, campaignId);
      const built = await call(
        w.manager.token,
        'POST',
        `/api/crm/campaigns/${campaignId}/versions/${version.campaignVersionId}/audience`,
        { rule: 'all_active_customers' },
      );
      assert.equal(built.status, 200, JSON.stringify(built.body));

      // FOUR CUSTOMERS, ONE PERMISSION. Absence is not permission, a withdrawal
      // is not permission, and permission for service reminders is not
      // permission for marketing.
      assert.equal(built.body!.audience.considered, 4);
      assert.equal(built.body!.audience.included, 1);
      assert.equal(built.body!.audience.excludedNoConsent, 3);

      const members = await query(
        `SELECT p.email FROM campaign_audience_members m
           JOIN parties p ON p.tenant_id = m.tenant_id AND p.party_id = m.party_id
          WHERE m.tenant_id = $1 AND m.campaign_version_id = $2`,
        [w.tenantId, version.campaignVersionId],
      );
      assert.deepEqual(
        (members.rows as Array<{ email: string }>).map((r) => r.email),
        ['yes@example.com'],
      );
    });

    test('a version cannot be approved without a message, an audience and a way out', async () => {
      const w = await seedWorld();
      await seedCustomer(w, 'Reader', 'reader@example.com', 'granted');
      const campaignId = await seedCampaign(w);

      // No audience yet.
      const version = await draftVersion(w, campaignId);
      const early = await call(
        w.manager.token,
        'POST',
        `/api/crm/campaigns/${campaignId}/versions/${version.campaignVersionId}/approve`,
        { expected_version: version.authorizationVersion },
      );
      assert.equal(early.status, 422);
      assert.match(String(early.body!.detail), /nobody to send to/);

      // A marketing message with no opt-out is refused even with an audience.
      const noOptOut = await draftVersion(w, campaignId, false);
      const built = await call(
        w.manager.token,
        'POST',
        `/api/crm/campaigns/${campaignId}/versions/${noOptOut.campaignVersionId}/audience`,
        { rule: 'all_active_customers' },
      );
      assert.equal(built.status, 200);
      assert.equal(built.body!.audience.included, 1);
      const refused = await call(
        w.manager.token,
        'POST',
        `/api/crm/campaigns/${campaignId}/versions/${noOptOut.campaignVersionId}/approve`,
        { expected_version: noOptOut.authorizationVersion },
      );
      assert.equal(refused.status, 422);
      assert.match(String(refused.body!.detail), /opt out/);

      // And an unapproved version cannot be launched.
      const launched = await call(
        w.manager.token,
        'POST',
        `/api/crm/campaigns/${campaignId}/versions/${noOptOut.campaignVersionId}/execute`,
        { expected_version: noOptOut.authorizationVersion },
      );
      assert.equal(launched.status, 422);
    });

    test('an opt-out between approval and delivery still stops the message', async () => {
      const w = await seedWorld();
      await seedCustomer(w, 'Stays', 'stays@example.com', 'granted');
      await seedCustomer(w, 'Leaves', 'leaves@example.com', 'granted');

      const campaignId = await seedCampaign(w);
      const version = await draftVersion(w, campaignId);
      const built = await call(
        w.manager.token,
        'POST',
        `/api/crm/campaigns/${campaignId}/versions/${version.campaignVersionId}/audience`,
        { rule: 'all_active_customers' },
      );
      assert.equal(built.body!.audience.included, 2, 'BOTH were reachable when it was approved');

      const approved = await call(
        w.manager.token,
        'POST',
        `/api/crm/campaigns/${campaignId}/versions/${version.campaignVersionId}/approve`,
        { expected_version: version.authorizationVersion },
      );
      assert.equal(approved.status, 200, JSON.stringify(approved.body));
      const executed = await call(
        w.manager.token,
        'POST',
        `/api/crm/campaigns/${campaignId}/versions/${version.campaignVersionId}/execute`,
        { expected_version: approved.body!.version.authorizationVersion },
      );
      assert.equal(executed.status, 202, JSON.stringify(executed.body));
      assert.equal(executed.body!.prepared.prepared, 2, 'two messages are queued');

      // ── THE OPT-OUT LANDS HERE. After approval, after preparation, before
      // anything has been handed to a provider. Audience-time filtering has
      // already happened and cannot see this.
      const stopped = await call(w.manager.token, 'POST', '/api/crm/suppressions', {
        contact_kind: 'email',
        contact_value: 'leaves@example.com',
        reason: 'unsubscribe',
      });
      assert.equal(stopped.status, 201, JSON.stringify(stopped.body));

      const pass = await dispatchDueSends({ tenantId: w.tenantId });
      assert.equal(pass.sent, 1, 'one message goes');
      assert.equal(pass.suppressed, 1, 'and one does not');

      const sends = await sendsOf(w.tenantId, version.campaignVersionId);
      const leaves = sends.find((s) => s.email === 'leaves@example.com')!;
      const stays = sends.find((s) => s.email === 'stays@example.com')!;
      assert.equal(leaves.state, 'suppressed');
      assert.equal(leaves.withheld_reason, 'suppressed_contact');
      assert.equal(leaves.external_ref, null, 'nothing was handed to a provider');
      assert.equal(stays.state, 'sent');
      assert.equal(stays.external_ref, simulatedProviderRef(stays.send_id));

      // A WITHDRAWN CONSENT between approval and delivery does the same thing,
      // by the other half of the gate.
      const second = await draftVersion(w, campaignId);
      const rebuilt = await call(
        w.manager.token,
        'POST',
        `/api/crm/campaigns/${campaignId}/versions/${second.campaignVersionId}/audience`,
        { rule: 'all_active_customers' },
      );
      // The person who unsubscribed is gone from the audience ENTIRELY this
      // time — the first check does its job once it can see the opt-out, and
      // the send-time check is what catches the ones it cannot.
      assert.equal(rebuilt.body!.audience.included, 1);
      assert.equal(rebuilt.body!.audience.excludedSuppressed, 1);
      const okApprove = await call(
        w.manager.token,
        'POST',
        `/api/crm/campaigns/${campaignId}/versions/${second.campaignVersionId}/approve`,
        { expected_version: second.authorizationVersion },
      );
      assert.equal(okApprove.status, 200);
      const ran = await call(
        w.manager.token,
        'POST',
        `/api/crm/campaigns/${campaignId}/versions/${second.campaignVersionId}/execute`,
        { expected_version: okApprove.body!.version.authorizationVersion },
      );
      assert.equal(ran.status, 202);
      const staysParty = await query(
        `SELECT party_id::text FROM parties WHERE tenant_id = $1 AND email = 'stays@example.com'`,
        [w.tenantId],
      );
      const withdrawn = await call(
        w.manager.token,
        'PUT',
        `/api/crm/parties/${String((staysParty.rows[0] as { party_id: string }).party_id)}/consents`,
        { channel: 'email', purpose: 'sales_marketing', state: 'withdrawn', source: 'phone' },
      );
      assert.equal(withdrawn.status, 200);

      const secondPass = await dispatchDueSends({ tenantId: w.tenantId });
      assert.equal(secondPass.sent, 0, 'nothing goes to anybody');
      const secondSends = await sendsOf(w.tenantId, second.campaignVersionId);
      assert.deepEqual(
        secondSends.map((s) => `${s.email}:${s.state}:${s.withheld_reason}`),
        ['stays@example.com:suppressed:consent_not_granted'],
        'the withdrawal landed after approval, so only the send-time check could catch it',
      );
    });

    test('quiet hours defer the message rather than failing it', async () => {
      const w = await seedWorld();
      await seedCustomer(w, 'Sleeper', 'sleeper@example.com', 'granted');

      // A window that is open all day except now: the whole day is quiet.
      const campaignId = await seedCampaign(w, { start: 0, end: 1439 });
      const version = await draftVersion(w, campaignId);
      await call(
        w.manager.token,
        'POST',
        `/api/crm/campaigns/${campaignId}/versions/${version.campaignVersionId}/audience`,
        { rule: 'all_active_customers' },
      );
      const approved = await call(
        w.manager.token,
        'POST',
        `/api/crm/campaigns/${campaignId}/versions/${version.campaignVersionId}/approve`,
        { expected_version: version.authorizationVersion },
      );
      const executed = await call(
        w.manager.token,
        'POST',
        `/api/crm/campaigns/${campaignId}/versions/${version.campaignVersionId}/execute`,
        { expected_version: approved.body!.version.authorizationVersion },
      );
      assert.equal(executed.status, 202);

      const held = await dispatchDueSends({ tenantId: w.tenantId });
      assert.equal(held.deferred, 1, 'held, not failed');
      assert.equal(held.sent, 0);
      const deferred = (await sendsOf(w.tenantId, version.campaignVersionId))[0]!;
      assert.equal(deferred.state, 'deferred_quiet_hours');
      assert.equal(deferred.withheld_reason, 'quiet_hours');
      assert.equal(deferred.attempts, 0, 'a deferral is not an attempt');

      // The deferral carries WHEN it may go, and it is in the future.
      const availability = await query(
        `SELECT available_at > NOW() AS later FROM campaign_sends
          WHERE tenant_id = $1 AND send_id = $2`,
        [w.tenantId, deferred.send_id],
      );
      assert.equal((availability.rows[0] as { later: boolean }).later, true);

      // …and once the window is open, the same send goes.
      // The window is opened by moving the CLOCK's boundary, not by pretending
      // the send was never held: the same row, now sendable.
      await fixtureAuthorizationStateWrite(
        'simulate-authorization-drift',
        `UPDATE campaigns SET quiet_hours_start_minute = 0, quiet_hours_end_minute = 0
          WHERE tenant_id = $1 AND campaign_id = $2`,
        [w.tenantId, campaignId],
      );
      await fixtureAuthorizationStateWrite(
        'simulate-authorization-drift',
        `UPDATE campaign_sends SET available_at = NOW() - INTERVAL '1 minute'
          WHERE tenant_id = $1 AND send_id = $2`,
        [w.tenantId, deferred.send_id],
      );
      const morning = await dispatchDueSends({ tenantId: w.tenantId });
      assert.equal(morning.sent, 1, 'the held message is still a message');
    });

    test('quiet hours are computed in the campaign’s own zone, across midnight', () => {
      // Pure arithmetic, asserted directly, because a window that wraps
      // midnight is the ORDINARY setting and getting it wrong means messages
      // at three in the morning.
      const quiet = { startMinute: 21 * 60, endMinute: 8 * 60, timeZone: 'UTC' };
      const at = (iso: string) => new Date(iso);
      assert.equal(insideQuietHours(at('2026-03-01T22:30:00Z'), quiet), true, 'late evening');
      assert.equal(insideQuietHours(at('2026-03-01T03:00:00Z'), quiet), true, 'small hours');
      assert.equal(insideQuietHours(at('2026-03-01T12:00:00Z'), quiet), false, 'midday');
      assert.equal(
        insideQuietHours(at('2026-03-01T08:00:00Z'), quiet),
        false,
        'the moment it ends',
      );

      // A window whose ends are equal is NO quiet hours, not a permanent one.
      assert.equal(
        insideQuietHours(at('2026-03-01T03:00:00Z'), { ...quiet, startMinute: 0, endMinute: 0 }),
        false,
      );

      // The zone is the campaign's, not the server's.
      const tokyo = { startMinute: 21 * 60, endMinute: 8 * 60, timeZone: 'Asia/Tokyo' };
      assert.equal(insideQuietHours(at('2026-03-01T12:00:00Z'), tokyo), true, '21:00 in Tokyo');

      const opensAt = quietHoursEndAfter(at('2026-03-01T22:30:00Z'), quiet);
      assert.equal(opensAt.toISOString(), '2026-03-02T08:00:00.000Z', 'it opens next morning');
    });

    test('a transient failure retries into success; a permanent one stops', async () => {
      const w = await seedWorld();
      await seedCustomer(w, 'Flaky', 'flaky@example.com', 'granted');
      await seedCustomer(w, 'Dead', 'bounce@example.com', 'granted');

      const campaignId = await seedCampaign(w);
      const version = await draftVersion(w, campaignId);
      await call(
        w.manager.token,
        'POST',
        `/api/crm/campaigns/${campaignId}/versions/${version.campaignVersionId}/audience`,
        { rule: 'all_active_customers' },
      );
      const approved = await call(
        w.manager.token,
        'POST',
        `/api/crm/campaigns/${campaignId}/versions/${version.campaignVersionId}/approve`,
        { expected_version: version.authorizationVersion },
      );
      await call(
        w.manager.token,
        'POST',
        `/api/crm/campaigns/${campaignId}/versions/${version.campaignVersionId}/execute`,
        { expected_version: approved.body!.version.authorizationVersion },
      );

      const first = await dispatchDueSends({ tenantId: w.tenantId });
      assert.equal(first.sent, 0);
      assert.equal(first.retrying, 1, 'the flaky one will be tried again');
      assert.equal(first.failed, 1, 'the dead address will not');

      const afterFirst = await sendsOf(w.tenantId, version.campaignVersionId);
      const dead = afterFirst.find((s) => s.email === 'bounce@example.com')!;
      assert.equal(dead.state, 'failed');
      const flaky = afterFirst.find((s) => s.email === 'flaky@example.com')!;
      assert.equal(flaky.state, 'pending', 'still queued');

      // The backoff is real: nothing is due yet.
      const tooSoon = await dispatchDueSends({ tenantId: w.tenantId });
      assert.equal(tooSoon.claimed, 0, 'a retry waits');

      // The backoff has elapsed. Moving the clock is the only honest way to
      // say that in a test; the send itself is untouched.
      await fixtureAuthorizationStateWrite(
        'simulate-authorization-drift',
        `UPDATE campaign_sends SET available_at = NOW() - INTERVAL '1 minute'
          WHERE tenant_id = $1 AND send_id = $2`,
        [w.tenantId, flaky.send_id],
      );
      const second = await dispatchDueSends({ tenantId: w.tenantId });
      assert.equal(second.sent, 1, 'the second attempt succeeds');

      const events = await query(
        `SELECT event_type, attempt FROM campaign_send_events
          WHERE tenant_id = $1 AND send_id = $2 ORDER BY attempt, event_type`,
        [w.tenantId, flaky.send_id],
      );
      assert.deepEqual(
        (events.rows as Array<{ event_type: string; attempt: number }>).map(
          (r) => `${r.event_type}@${r.attempt}`,
        ),
        ['requested@1', 'failed@1', 'requested@2', 'sent@2'].sort(),
        'every attempt is recorded with its own outcome',
      );
      // A dead address is not retried for ever.
      const deadAgain = await dispatchDueSends({ tenantId: w.tenantId });
      assert.equal(deadAgain.claimed, 0);
    });

    test('delivery is at least once and the effect is exactly once', async () => {
      const w = await seedWorld();
      await seedCustomer(w, 'One', 'one@example.com', 'granted');
      const campaignId = await seedCampaign(w);
      const version = await draftVersion(w, campaignId);
      await call(
        w.manager.token,
        'POST',
        `/api/crm/campaigns/${campaignId}/versions/${version.campaignVersionId}/audience`,
        { rule: 'all_active_customers' },
      );
      const approved = await call(
        w.manager.token,
        'POST',
        `/api/crm/campaigns/${campaignId}/versions/${version.campaignVersionId}/approve`,
        { expected_version: version.authorizationVersion },
      );
      const executed = await call(
        w.manager.token,
        'POST',
        `/api/crm/campaigns/${campaignId}/versions/${version.campaignVersionId}/execute`,
        { expected_version: approved.body!.version.authorizationVersion },
      );
      assert.equal(executed.status, 202);

      // A CAMPAIGN BECOMES ACTIVE BY SENDING SOMETHING. Before the launch it is
      // a draft; the manager's "active campaigns" count is a real number only
      // because this transition exists, and it exists only because something
      // asserts it.
      const status = await query(
        `SELECT status FROM campaigns WHERE tenant_id = $1 AND campaign_id = $2`,
        [w.tenantId, campaignId],
      );
      assert.equal(String((status.rows[0] as { status: string }).status), 'active');

      // Launching twice does not queue a second copy.
      const again = await call(
        w.manager.token,
        'POST',
        `/api/crm/campaigns/${campaignId}/versions/${version.campaignVersionId}/execute`,
        { expected_version: executed.body!.version.authorizationVersion },
      );
      assert.equal(again.status, 200);
      assert.equal(again.body!.outcome, 'already_executing');

      // The outbox event is delivered once, and a redelivery says so.
      const drained = await drainMarketingOutbox({ tenantId: w.tenantId });
      assert.equal(drained.delivered, 1);
      await query(
        `UPDATE admin_outbox SET delivered_at = NULL WHERE tenant_id = $1 AND event_type LIKE 'marketing.%'`,
        [w.tenantId],
      );
      const replayed = await drainMarketingOutbox({ tenantId: w.tenantId });
      assert.equal(replayed.claimed, 1, 'the event was claimed again');
      assert.equal(replayed.delivered, 0, 'and did nothing again');
      assert.equal(replayed.replayed, 1);

      await dispatchDueSends({ tenantId: w.tenantId });
      const sends = await sendsOf(w.tenantId, version.campaignVersionId);
      assert.equal(sends[0]!.state, 'sent');
      const ref = sends[0]!.external_ref;

      // A second dispatch pass finds nothing due — one message, one send.
      const secondPass = await dispatchDueSends({ tenantId: w.tenantId });
      assert.equal(secondPass.claimed, 0);
      const sentEvents = await query(
        `SELECT COUNT(*)::int AS n FROM campaign_send_events
          WHERE tenant_id = $1 AND send_id = $2 AND event_type = 'sent'`,
        [w.tenantId, sends[0]!.send_id],
      );
      assert.equal(Number((sentEvents.rows[0] as { n: number }).n), 1, 'one sent event, ever');
      assert.equal(ref, simulatedProviderRef(sends[0]!.send_id), 'the reference is derivable');

      // The version completes when nothing is left to do.
      const state = await query(
        `SELECT state FROM campaign_versions WHERE tenant_id = $1 AND campaign_version_id = $2`,
        [w.tenantId, version.campaignVersionId],
      );
      assert.equal(String((state.rows[0] as { state: string }).state), 'completed');
    });

    test('a reply becomes pipeline; an opt-out becomes silence, once', async () => {
      const w = await seedWorld();
      await seedCustomer(w, 'Replier', 'replier@example.com', 'granted');
      await seedCustomer(w, 'Quitter', 'quitter@example.com', 'granted');
      const campaignId = await seedCampaign(w);
      const version = await draftVersion(w, campaignId);
      await call(
        w.manager.token,
        'POST',
        `/api/crm/campaigns/${campaignId}/versions/${version.campaignVersionId}/audience`,
        { rule: 'all_active_customers' },
      );
      const approved = await call(
        w.manager.token,
        'POST',
        `/api/crm/campaigns/${campaignId}/versions/${version.campaignVersionId}/approve`,
        { expected_version: version.authorizationVersion },
      );
      await call(
        w.manager.token,
        'POST',
        `/api/crm/campaigns/${campaignId}/versions/${version.campaignVersionId}/execute`,
        { expected_version: approved.body!.version.authorizationVersion },
      );
      await runCampaignDispatchPass();
      const sends = await sendsOf(w.tenantId, version.campaignVersionId);
      const replier = sends.find((s) => s.email === 'replier@example.com')!;
      const quitter = sends.find((s) => s.email === 'quitter@example.com')!;
      assert.equal(replier.state, 'sent');

      // A REPLY IS PIPELINE.
      const reply = await call(
        w.manager.token,
        'POST',
        `/api/crm/campaigns/${campaignId}/sends/${replier.send_id}/response`,
        { response_type: 'reply', detail: 'Interested' },
      );
      assert.equal(reply.status, 201, JSON.stringify(reply.body));
      assert.ok(reply.body!.leadId !== null, 'the reply produced a lead');
      const leadId = String(reply.body!.leadId);

      // A REDELIVERED REPLY IS THE SAME REPLY.
      const twice = await call(
        w.manager.token,
        'POST',
        `/api/crm/campaigns/${campaignId}/sends/${replier.send_id}/response`,
        { response_type: 'reply' },
      );
      assert.equal(twice.status, 200);
      assert.equal(twice.body!.outcome, 'already_recorded');
      const leads = await query(`SELECT COUNT(*)::int AS n FROM leads WHERE tenant_id = $1`, [
        w.tenantId,
      ]);
      assert.equal(Number((leads.rows[0] as { n: number }).n), 1, 'one lead, not two');

      // The lead carries the campaign as a touch, so attribution can see it.
      const touches = await query(
        `SELECT campaign_version_id::text FROM lead_source_touches
          WHERE tenant_id = $1 AND lead_id = $2`,
        [w.tenantId, leadId],
      );
      assert.equal(
        String((touches.rows[0] as { campaign_version_id: string }).campaign_version_id),
        version.campaignVersionId,
      );

      // AN OPT-OUT IS SILENCE, and the suppression is written with it.
      const out = await call(
        w.manager.token,
        'POST',
        `/api/crm/campaigns/${campaignId}/sends/${quitter.send_id}/response`,
        { response_type: 'opt_out' },
      );
      assert.equal(out.status, 201);
      assert.equal(out.body!.leadId, null, 'an opt-out is not a lead');
      const suppressed = await query(
        `SELECT reason FROM contact_suppressions
          WHERE tenant_id = $1 AND contact_value = 'quitter@example.com' AND state = 'active'`,
        [w.tenantId],
      );
      assert.equal(suppressed.rows.length, 1);
      assert.equal(String((suppressed.rows[0] as { reason: string }).reason), 'unsubscribe');

      // A redelivered opt-out does not opt them out twice.
      const outAgain = await call(
        w.manager.token,
        'POST',
        `/api/crm/campaigns/${campaignId}/sends/${quitter.send_id}/response`,
        { response_type: 'opt_out' },
      );
      assert.equal(outAgain.status, 200);
      const stillOne = await query(
        `SELECT COUNT(*)::int AS n FROM contact_suppressions WHERE tenant_id = $1`,
        [w.tenantId],
      );
      assert.equal(Number((stillOne.rows[0] as { n: number }).n), 1);

      // …and the next campaign will not reach them.
      const next = await draftVersion(w, campaignId);
      const built = await call(
        w.manager.token,
        'POST',
        `/api/crm/campaigns/${campaignId}/versions/${next.campaignVersionId}/audience`,
        { rule: 'all_active_customers' },
      );
      assert.equal(built.body!.audience.excludedSuppressed, 1, 'the opt-out is honoured next time');
    });

    test('reconciliation corrects the platform when the provider disagrees', async () => {
      const w = await seedWorld();
      await seedCustomer(w, 'Subject', 'subject@example.com', 'granted');
      const campaignId = await seedCampaign(w);
      const version = await draftVersion(w, campaignId);
      await call(
        w.manager.token,
        'POST',
        `/api/crm/campaigns/${campaignId}/versions/${version.campaignVersionId}/audience`,
        { rule: 'all_active_customers' },
      );
      const approved = await call(
        w.manager.token,
        'POST',
        `/api/crm/campaigns/${campaignId}/versions/${version.campaignVersionId}/approve`,
        { expected_version: version.authorizationVersion },
      );
      await call(
        w.manager.token,
        'POST',
        `/api/crm/campaigns/${campaignId}/versions/${version.campaignVersionId}/execute`,
        { expected_version: approved.body!.version.authorizationVersion },
      );
      await dispatchDueSends({ tenantId: w.tenantId });
      const send = (await sendsOf(w.tenantId, version.campaignVersionId))[0]!;
      assert.equal(send.state, 'sent');

      // CONTROL: agreement changes nothing but is still recorded.
      const agrees = await call(
        w.manager.token,
        'POST',
        `/api/crm/campaigns/${campaignId}/sends/${send.send_id}/reconcile`,
        { provider_state: 'sent' },
      );
      assert.equal(agrees.status, 200);
      assert.equal(agrees.body!.outcome, 'agreed');

      // …and disagreement corrects the platform, in a further row.
      const disagrees = await call(
        w.manager.token,
        'POST',
        `/api/crm/campaigns/${campaignId}/sends/${send.send_id}/reconcile`,
        { provider_state: 'failed', detail: 'rejected downstream' },
      );
      assert.equal(disagrees.status, 200);
      assert.equal(disagrees.body!.outcome, 'corrected');
      const after = (await sendsOf(w.tenantId, version.campaignVersionId))[0]!;
      assert.equal(after.state, 'failed');
      assert.equal(after.external_ref, null, 'a message that did not go has no reference');

      const reconciled = await query(
        `SELECT COUNT(*)::int AS n FROM campaign_send_events
          WHERE tenant_id = $1 AND send_id = $2 AND event_type = 'reconciled'`,
        [w.tenantId, send.send_id],
      );
      assert.equal(
        Number((reconciled.rows[0] as { n: number }).n),
        1,
        'the history is appended to',
      );
    });
  },
);
