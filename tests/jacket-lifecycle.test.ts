import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';

import { closePool, query } from '@dealer/database';
import {
  assemblePackage,
  CONSENT_TEXT_VERSION,
  consentToElectronicRecords,
  INTENT_STATEMENT,
  jacketBoard,
  jacketDetail,
  markReviewReady,
  openJacket,
  openSignerSession,
  resetSimulatedEsignProviderForTests,
  reviewPackage,
  runCeremonyExpiryPass,
  sendPackage,
  signAsCustomer,
  simulatedDeliveries,
  voidPackage,
  waiveRequirement,
} from '@dealer/jacket';
import { runAllJobsOnce } from '@dealer/worker';
import {
  fixtureAuthorizationStateWrite,
  resetDatabase,
  skipIntegration,
  startIdentityTestEnv,
  type IdentityTestEnv,
} from '@dealer/test-kit';

import { resetVins, seedJacketWorld, show, type JacketWorld } from './jacket-world';

/**
 * OUTCOME 6 — LIFECYCLE AND OPERATIONAL EXCEPTIONS.
 *
 * "Support coherent states equivalent to draft, review-ready, sent, partially
 * signed, signed-complete, voided, expired, and superseded. Terminal states are
 * absorbing except through explicit versioned supersession. Expose actionable
 * queues for missing documents, render failure, rejected or expired signatures,
 * provider failure, and stale approved-desking inputs."
 *
 * THE ABSORBING STATES ARE PROVED AT THE TABLE. A voided package that a raw
 * UPDATE tries to put back into draft, and a signed package a raw UPDATE tries
 * to void, are refused by migration 066's trigger for every role.
 *
 * THE CLOCK IS THE WORKER. Expiry is driven through `runAllJobsOnce` — the
 * exact function `--once` calls — so the pass that ships is the pass that is
 * proved, and it is run twice to show it finds nothing the second time.
 */
describe(
  'jacket: lifecycle, the clock and the queues (FBL-140 Outcome 6)',
  { skip: skipIntegration ? 'set TEST_DATABASE_URL to run' : false },
  () => {
    let env: IdentityTestEnv;

    before(async () => {
      env = await startIdentityTestEnv();
    });

    after(async () => {
      await env.stop();
      await closePool();
    });

    beforeEach(async () => {
      await resetDatabase();
      resetVins();
      resetSimulatedEsignProviderForTests();
    });

    interface Live {
      w: JacketWorld;
      jacketId: string;
      packageId: string;
      packageVersion: number;
      packageSha256: string;
    }

    async function assembled(): Promise<Live> {
      const w = await seedJacketWorld(env);
      const out = await openJacket({
        actingUserLinkId: w.seller,
        tenantId: w.tenantId,
        deskingCaseId: w.caseId,
      });
      const jacket = (out as { jacket: { jacketId: string; authorizationVersion: number } }).jacket;
      const a = await assemblePackage({
        actingUserLinkId: w.seller,
        tenantId: w.tenantId,
        jacketId: jacket.jacketId,
        expectedVersion: jacket.authorizationVersion,
      });
      assert.equal(a.outcome, 'assembled', show(a));
      const pkg = (
        a as { package: { packageId: string; authorizationVersion: number; packageSha256: string } }
      ).package;
      return {
        w,
        jacketId: jacket.jacketId,
        packageId: pkg.packageId,
        packageVersion: pkg.authorizationVersion,
        packageSha256: pkg.packageSha256,
      };
    }

    async function waiveInsurance(l: Live): Promise<void> {
      const detail = await jacketDetail(l.w.tenantId, l.w.seller, l.jacketId);
      const item = detail!.checklist.find((i) => i.requirementCode === 'proof_of_insurance')!;
      const waived = await waiveRequirement({
        actingUserLinkId: l.w.manager,
        tenantId: l.w.tenantId,
        jacketId: l.jacketId,
        itemId: item.itemId,
        reason: 'binder to follow',
        policyVersion: 3,
        evidenceUri: 'file://note.txt',
        expectedVersion: item.authorizationVersion,
      });
      assert.equal(waived.outcome, 'updated', show(waived));
    }

    async function toSent(
      l: Live,
    ): Promise<{ ceremonyId: string; token: string; packageVersion: number }> {
      await waiveInsurance(l);
      const ready = await markReviewReady({
        actingUserLinkId: l.w.seller,
        tenantId: l.w.tenantId,
        packageId: l.packageId,
        expectedVersion: l.packageVersion,
      });
      assert.equal(ready.outcome, 'moved', show(ready));
      let v = (ready as { package: { authorizationVersion: number } }).package.authorizationVersion;
      const reviewed = await reviewPackage({
        actingUserLinkId: l.w.manager,
        tenantId: l.w.tenantId,
        packageId: l.packageId,
        expectedVersion: v,
      });
      assert.equal(reviewed.outcome, 'moved', show(reviewed));
      v = (reviewed as { package: { authorizationVersion: number } }).package.authorizationVersion;
      const s = await sendPackage({
        actingUserLinkId: l.w.manager,
        tenantId: l.w.tenantId,
        packageId: l.packageId,
        expectedVersion: v,
      });
      assert.equal(s.outcome, 'sent', show(s));
      return {
        ceremonyId: (s as { ceremony: { ceremonyId: string } }).ceremony.ceremonyId,
        token: simulatedDeliveries().at(-1)!.signingUrl.split('#/')[1]!,
        packageVersion: (s as { package: { authorizationVersion: number } }).package
          .authorizationVersion,
      };
    }

    async function packageState(l: Live): Promise<string> {
      const r = await query(
        `SELECT state FROM jacket_packages WHERE tenant_id = $1 AND package_id = $2`,
        [l.w.tenantId, l.packageId],
      );
      return String((r.rows[0] as { state: string }).state);
    }

    test('draft → review-ready → sent → partially signed → signed-complete, each move attributed and versioned', async () => {
      const l = await assembled();
      assert.equal(await packageState(l), 'draft');

      const unreviewed = await (async () => {
        await waiveInsurance(l);
        const ready = await markReviewReady({
          actingUserLinkId: l.w.seller,
          tenantId: l.w.tenantId,
          packageId: l.packageId,
          expectedVersion: l.packageVersion,
        });
        assert.equal(ready.outcome, 'moved', show(ready));
        const v = (ready as { package: { authorizationVersion: number } }).package
          .authorizationVersion;
        return sendPackage({
          actingUserLinkId: l.w.manager,
          tenantId: l.w.tenantId,
          packageId: l.packageId,
          expectedVersion: v,
        });
      })();
      assert.equal(
        unreviewed.outcome,
        'invalid',
        'a package of samples with a waiver is not sent unreviewed',
      );
      assert.match((unreviewed as { error: string }).error, /reviewed by a manager/);
      assert.equal(await packageState(l), 'review_ready');

      const detail = await jacketDetail(l.w.tenantId, l.w.seller, l.jacketId);
      const v = detail!.packages[0]!.package.authorizationVersion;
      const bySeller = await reviewPackage({
        actingUserLinkId: l.w.seller,
        tenantId: l.w.tenantId,
        packageId: l.packageId,
        expectedVersion: v,
      });
      assert.equal(bySeller.outcome, 'not_found', 'a salesperson does not review');
      const stale = await reviewPackage({
        actingUserLinkId: l.w.manager,
        tenantId: l.w.tenantId,
        packageId: l.packageId,
        expectedVersion: v - 1,
      });
      assert.equal(stale.outcome, 'version_conflict');
      const reviewed = await reviewPackage({
        actingUserLinkId: l.w.manager,
        tenantId: l.w.tenantId,
        packageId: l.packageId,
        expectedVersion: v,
      });
      assert.equal(reviewed.outcome, 'moved', show(reviewed));
      const r = (
        reviewed as {
          package: {
            reviewedByUserLinkId: string;
            reviewedAt: string;
            authorizationVersion: number;
          };
        }
      ).package;
      assert.equal(r.reviewedByUserLinkId, l.w.manager);
      const s = await sendPackage({
        actingUserLinkId: l.w.manager,
        tenantId: l.w.tenantId,
        packageId: l.packageId,
        expectedVersion: r.authorizationVersion,
      });
      assert.equal(s.outcome, 'sent', show(s));
      assert.equal(await packageState(l), 'sent');

      const token = simulatedDeliveries().at(-1)!.signingUrl.split('#/')[1]!;
      await openSignerSession(token);
      await consentToElectronicRecords(token, CONSENT_TEXT_VERSION);
      const signed = await signAsCustomer(token, {
        packageSha256: l.packageSha256,
        intentStatement: INTENT_STATEMENT,
      });
      assert.equal(signed.outcome, 'signed');
      assert.equal(await packageState(l), 'partially_signed');

      const board = await jacketBoard(l.w.tenantId, l.w.manager);
      assert.equal(board.awaitingSignature, 1);
      assert.equal(board.rows[0]!.ceremony?.signed, 1);
      assert.equal(board.rows[0]!.ceremony?.total, 2);

      // Every move left an audit row against the package.
      const audit = await query(
        `SELECT event_type FROM audit_events WHERE tenant_id = $1 AND entity_id = $2 ORDER BY event_type`,
        [l.w.tenantId, l.packageId],
      );
      const types = audit.rows.map((x) => String((x as { event_type: string }).event_type));
      for (const expected of [
        'jacket.package.assembled',
        'jacket.package.review_ready',
        'jacket.package.reviewed',
      ]) {
        assert.ok(types.includes(expected), `${expected} in ${types.join(', ')}`);
      }
    });

    test('a manager voids a sent package and its ceremony; the signer’s link stops answering; nothing is deleted', async () => {
      const l = await assembled();
      const s = await toSent(l);
      const bySeller = await voidPackage({
        actingUserLinkId: l.w.seller,
        tenantId: l.w.tenantId,
        packageId: l.packageId,
        reason: 'oops',
        expectedVersion: s.packageVersion,
      });
      assert.equal(bySeller.outcome, 'not_found');
      const noReason = await voidPackage({
        actingUserLinkId: l.w.manager,
        tenantId: l.w.tenantId,
        packageId: l.packageId,
        reason: '  ',
        expectedVersion: s.packageVersion,
      });
      assert.equal(noReason.outcome, 'invalid');
      const voided = await voidPackage({
        actingUserLinkId: l.w.manager,
        tenantId: l.w.tenantId,
        packageId: l.packageId,
        reason: 'customer changed their mind on the term',
        expectedVersion: s.packageVersion,
      });
      assert.equal(voided.outcome, 'moved', show(voided));
      assert.equal(await packageState(l), 'voided');
      const ceremony = await query(
        `SELECT state FROM signing_ceremonies WHERE tenant_id = $1 AND ceremony_id = $2`,
        [l.w.tenantId, s.ceremonyId],
      );
      assert.equal(String((ceremony.rows[0] as { state: string }).state), 'voided');
      const link = await openSignerSession(s.token);
      assert.equal(link.outcome, 'ok', 'the link still resolves…');
      assert.equal(
        (link as { value: { nextStep: string } }).value.nextStep,
        'closed',
        '…and says the ceremony is closed',
      );
      const signed = await signAsCustomer(s.token, {
        packageSha256: l.packageSha256,
        intentStatement: INTENT_STATEMENT,
      });
      assert.equal(signed.outcome, 'closed');
      const again = await voidPackage({
        actingUserLinkId: l.w.manager,
        tenantId: l.w.tenantId,
        packageId: l.packageId,
        reason: 'again',
        expectedVersion: 99,
      });
      assert.equal(again.outcome, 'already_there');
      const rows = await query(
        `SELECT COUNT(*)::int AS n FROM package_documents WHERE tenant_id = $1 AND package_id = $2`,
        [l.w.tenantId, l.packageId],
      );
      assert.equal(
        Number((rows.rows[0] as { n: number }).n),
        3,
        'the rendered documents are still there',
      );
    });

    test('terminal states are absorbing: the database refuses to revive a voided package or void a signed one', async () => {
      const l = await assembled();
      const s = await toSent(l);
      await voidPackage({
        actingUserLinkId: l.w.manager,
        tenantId: l.w.tenantId,
        packageId: l.packageId,
        reason: 'set aside',
        expectedVersion: s.packageVersion,
      });
      await assert.rejects(
        fixtureAuthorizationStateWrite(
          'adversarial-bypass-attempt',
          `UPDATE jacket_packages SET state = 'draft' WHERE tenant_id = $1 AND package_id = $2`,
          [l.w.tenantId, l.packageId],
        ),
        /voided is a final state and draft is not reachable from it/,
      );
      await assert.rejects(
        fixtureAuthorizationStateWrite(
          'adversarial-bypass-attempt',
          `UPDATE jacket_packages SET state = 'sent' WHERE tenant_id = $1 AND package_id = $2`,
          [l.w.tenantId, l.packageId],
        ),
        /final state/,
      );
      // A signed package goes nowhere but superseded: a second deal, signed through.
      const second = await assembled();
      const s2 = await toSent(second);
      await openSignerSession(s2.token);
      await consentToElectronicRecords(s2.token, CONSENT_TEXT_VERSION);
      await signAsCustomer(s2.token, {
        packageSha256: second.packageSha256,
        intentStatement: INTENT_STATEMENT,
      });
      const { signAsDealerRepresentative } = await import('@dealer/jacket');
      const done = await signAsDealerRepresentative({
        actingUserLinkId: second.w.manager,
        tenantId: second.w.tenantId,
        ceremonyId: s2.ceremonyId,
        packageSha256: second.packageSha256,
        intentStatement: INTENT_STATEMENT,
        consentTextVersion: CONSENT_TEXT_VERSION,
      });
      assert.equal(done.outcome, 'signed', show(done));
      assert.equal(await packageState(second), 'signed_complete');
      await assert.rejects(
        fixtureAuthorizationStateWrite(
          'adversarial-bypass-attempt',
          `UPDATE jacket_packages SET state = 'voided' WHERE tenant_id = $1 AND package_id = $2`,
          [second.w.tenantId, second.packageId],
        ),
        /a signed package may only be superseded/,
      );
      const stillSigned = await voidPackage({
        actingUserLinkId: second.w.manager,
        tenantId: second.w.tenantId,
        packageId: second.packageId,
        reason: 'x',
        expectedVersion: 1,
      });
      assert.equal(stillSigned.outcome, 'invalid', 'the service agrees');
    });

    test('the clock expires a ceremony nobody finished — through the worker’s own pass, once — and the board queues it', async () => {
      const l = await assembled();
      const s = await toSent(l);
      await openSignerSession(s.token);
      await consentToElectronicRecords(s.token, CONSENT_TEXT_VERSION);

      const early = await runCeremonyExpiryPass();
      assert.equal(early.ceremoniesExpired, 0, 'nothing is due yet');

      // The ceremony's clock, run out — as the database would see it a fortnight from now.
      await fixtureAuthorizationStateWrite(
        'adversarial-bypass-attempt',
        `UPDATE signing_ceremonies SET expires_at = NOW() - interval '1 minute' WHERE tenant_id = $1 AND ceremony_id = $2`,
        [l.w.tenantId, s.ceremonyId],
      );

      const failed = await runAllJobsOnce();
      assert.deepEqual(failed, [], 'every registered job passed, this one among them');
      assert.equal(await packageState(l), 'expired');
      const ceremony = await query(
        `SELECT state FROM signing_ceremonies WHERE tenant_id = $1 AND ceremony_id = $2`,
        [l.w.tenantId, s.ceremonyId],
      );
      assert.equal(String((ceremony.rows[0] as { state: string }).state), 'expired');
      const signers = await query(
        `SELECT signer_role, state FROM ceremony_signers WHERE tenant_id = $1 AND ceremony_id = $2 ORDER BY signing_order`,
        [l.w.tenantId, s.ceremonyId],
      );
      assert.deepEqual(
        signers.rows.map((r) => [
          (r as { signer_role: string }).signer_role,
          (r as { state: string }).state,
        ]),
        [
          ['customer', 'expired'],
          ['dealer_representative', 'expired'],
        ],
      );
      const link = await openSignerSession(s.token);
      assert.equal((link as { value: { nextStep: string } }).value.nextStep, 'closed');

      const events = await query(
        `SELECT event_type, lane, actor_user_link_id FROM ceremony_events WHERE tenant_id = $1 AND ceremony_id = $2 AND event_type = 'ceremony.expired'`,
        [l.w.tenantId, s.ceremonyId],
      );
      assert.equal(events.rows.length, 1);
      assert.equal(String((events.rows[0] as { lane: string }).lane), 'system');
      assert.equal(
        (events.rows[0] as { actor_user_link_id: string | null }).actor_user_link_id,
        null,
        'the clock has no user',
      );

      const second = await runCeremonyExpiryPass();
      assert.equal(second.ceremoniesExpired, 0, 'the second pass finds nothing to move');

      const board = await jacketBoard(l.w.tenantId, l.w.manager);
      assert.equal(board.queues.rejected_or_expired, 1);
      assert.ok(
        board.rows[0]!.exceptions.includes('signing expired'),
        show(board.rows[0]!.exceptions),
      );
      // The jacket itself is still open: somebody re-assembles and re-sends.
      assert.equal(board.rows[0]!.state, 'open');
    });

    test('the board carries every queue the order names, and says what it does not know', async () => {
      const l = await assembled();
      const board = await jacketBoard(l.w.tenantId, l.w.manager);
      assert.deepEqual(Object.keys(board.queues).sort(), [
        'missing_documents',
        'provider_failure',
        'rejected_or_expired',
        'render_failure',
        'stale_inputs',
      ]);
      assert.equal(board.queues.missing_documents, 1, 'proof of insurance is still missing');
      assert.ok(board.rows[0]!.exceptions.includes('missing documents'));
      assert.ok(board.rows[0]!.exceptions.includes('unapproved sample templates'));
      for (const key of [
        'sale',
        'funding',
        'delivery',
        'sold_inventory',
        'accounting_posting',
        'gross',
        'commission',
        'revenue',
        'credit_application',
        'title_registration',
        'document_disposal',
      ]) {
        assert.equal(
          (board.notYetAvailable as Record<string, string>)[key],
          'NOT_YET_AVAILABLE',
          key,
        );
      }
      // A foreign salesperson's board is empty, not filtered-looking.
      const foreign = await jacketBoard(l.w.tenantId, l.w.foreignSeller);
      assert.deepEqual(foreign.rows, []);
      assert.equal(foreign.open, 0);
    });
  },
);
