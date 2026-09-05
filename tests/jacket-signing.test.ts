import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';

import { closePool, query } from '@dealer/database';
import {
  assemblePackage,
  CONSENT_TEXT_VERSION,
  consentToElectronicRecords,
  declineAsCustomer,
  INTENT_STATEMENT,
  jacketDetail,
  markReviewReady,
  openJacket,
  openSignerSession,
  parseProviderCallback,
  type SignerSession,
  recordProviderCallback,
  resetSimulatedEsignProviderForTests,
  reviewPackage,
  sendPackage,
  signAsCustomer,
  signAsDealerRepresentative,
  signerDocumentContent,
  signProviderBody,
  simulatedDeliveries,
  verifyProviderSignature,
  waiveRequirement,
} from '@dealer/jacket';
import {
  fixtureAuthorizationStateWrite,
  resetDatabase,
  skipIntegration,
  startIdentityTestEnv,
  type IdentityTestEnv,
} from '@dealer/test-kit';

import { resetVins, seedJacketWorld, seedTemplate, show, type JacketWorld } from './jacket-world';

/**
 * OUTCOME 5 — E-SIGN CEREMONY AND EVIDENCE.
 *
 * "Capture electronic-record consent, signer identity and role, signing
 * authority, authentication assurance, intent, exact package version/hash,
 * timestamps, provider delivery records, signature results, and completion
 * certificate. Provider callbacks must be signed, idempotent, replay-safe, and
 * reconcilable. A signer cannot sign a superseded or modified package."
 *
 * THE CUSTOMER IS PLAYED FROM THE PROVIDER'S SIDE. The signing link is read out
 * of the simulated provider's deliveries — the position a real mailbox would be
 * in — and from nowhere else, because nowhere else in the platform holds it.
 * The staff response that sent the package is checked for its absence.
 */
describe(
  'jacket: the ceremony, its signatures and its evidence (FBL-140 Outcome 5)',
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

    interface Sent {
      w: JacketWorld;
      jacketId: string;
      packageId: string;
      packageSha256: string;
      ceremonyId: string;
      customerToken: string;
      signers: readonly {
        signerId: string;
        signerRole: string;
        lane: string;
        userLinkId: string | null;
      }[];
    }

    /** Open, assemble, waive the insurance line, mark ready, review and send — through the services that own each step. */
    async function sent(options: Parameters<typeof seedJacketWorld>[1] = {}): Promise<Sent> {
      const w = await seedJacketWorld(env, options);
      const out = await openJacket({
        actingUserLinkId: w.seller,
        tenantId: w.tenantId,
        deskingCaseId: w.caseId,
      });
      assert.equal(out.outcome, 'opened', show(out));
      const jacket = (out as { jacket: { jacketId: string; authorizationVersion: number } }).jacket;
      const assembled = await assemblePackage({
        actingUserLinkId: w.seller,
        tenantId: w.tenantId,
        jacketId: jacket.jacketId,
        expectedVersion: jacket.authorizationVersion,
      });
      assert.equal(assembled.outcome, 'assembled', show(assembled));
      let pkg = (
        assembled as {
          package: { packageId: string; authorizationVersion: number; packageSha256: string };
        }
      ).package;

      const detail = await jacketDetail(w.tenantId, w.seller, jacket.jacketId);
      const insurance = detail!.checklist.find((i) => i.requirementCode === 'proof_of_insurance')!;
      const waived = await waiveRequirement({
        actingUserLinkId: w.manager,
        tenantId: w.tenantId,
        jacketId: jacket.jacketId,
        itemId: insurance.itemId,
        reason: 'binder to follow at delivery',
        policyVersion: 3,
        evidenceUri: 'file://manager-note.txt',
        expectedVersion: insurance.authorizationVersion,
      });
      assert.equal(waived.outcome, 'updated', show(waived));

      const ready = await markReviewReady({
        actingUserLinkId: w.seller,
        tenantId: w.tenantId,
        packageId: pkg.packageId,
        expectedVersion: pkg.authorizationVersion,
      });
      assert.equal(ready.outcome, 'moved', show(ready));
      pkg = (ready as { package: typeof pkg }).package;
      const reviewed = await reviewPackage({
        actingUserLinkId: w.manager,
        tenantId: w.tenantId,
        packageId: pkg.packageId,
        expectedVersion: pkg.authorizationVersion,
      });
      assert.equal(reviewed.outcome, 'moved', show(reviewed));
      pkg = (reviewed as { package: typeof pkg }).package;
      const s = await sendPackage({
        actingUserLinkId: w.manager,
        tenantId: w.tenantId,
        packageId: pkg.packageId,
        expectedVersion: pkg.authorizationVersion,
      });
      assert.equal(s.outcome, 'sent', show(s));
      const sentOut = s as { ceremony: { ceremonyId: string }; signers: Sent['signers'] };

      const deliveries = simulatedDeliveries();
      assert.equal(deliveries.length, 1, 'one invitation, to the customer, through the provider');
      const url = deliveries[0]!.signingUrl;
      assert.match(url, /^\/sign\/#\/[0-9a-f-]{36}\.[A-Za-z0-9_-]{32,64}$/);
      return {
        w,
        jacketId: jacket.jacketId,
        packageId: pkg.packageId,
        packageSha256: pkg.packageSha256,
        ceremonyId: sentOut.ceremony.ceremonyId,
        customerToken: url.split('#/')[1]!,
        signers: sentOut.signers,
      };
    }

    test('sending is a manager’s act that binds the package hash, seats the signers in their lanes, and shows staff no link', async () => {
      const w = await seedJacketWorld(env);
      const out = await openJacket({
        actingUserLinkId: w.seller,
        tenantId: w.tenantId,
        deskingCaseId: w.caseId,
      });
      const jacket = (out as { jacket: { jacketId: string; authorizationVersion: number } }).jacket;
      const assembled = await assemblePackage({
        actingUserLinkId: w.seller,
        tenantId: w.tenantId,
        jacketId: jacket.jacketId,
        expectedVersion: jacket.authorizationVersion,
      });
      const pkg = (assembled as { package: { packageId: string; authorizationVersion: number } })
        .package;

      // Not ready: a draft cannot be sent, and a salesperson cannot send anything.
      const draft = await sendPackage({
        actingUserLinkId: w.manager,
        tenantId: w.tenantId,
        packageId: pkg.packageId,
        expectedVersion: pkg.authorizationVersion,
      });
      assert.equal(draft.outcome, 'invalid', show(draft));
      const bySeller = await sendPackage({
        actingUserLinkId: w.seller,
        tenantId: w.tenantId,
        packageId: pkg.packageId,
        expectedVersion: pkg.authorizationVersion,
      });
      assert.equal(bySeller.outcome, 'not_found', 'the refusal explains nothing');

      const s = await sent();
      const raw = JSON.stringify(s.signers);
      assert.doesNotMatch(
        raw,
        new RegExp(s.customerToken.split('.')[1]!),
        'the staff response never carries the customer’s token',
      );
      assert.deepEqual(
        s.signers.map((x) => [x.signerRole, x.lane]),
        [
          ['customer', 'signer_token'],
          ['dealer_representative', 'staff_session'],
        ],
      );
      assert.equal(
        s.signers[1]!.userLinkId,
        s.w.manager,
        'the dealer’s representative is the manager who sent it',
      );

      const detail = await jacketDetail(s.w.tenantId, s.w.seller, s.jacketId);
      const p = detail!.packages[0]!;
      assert.equal(p.package.state, 'sent');
      assert.equal(
        p.ceremony!.boundPackageSha256,
        s.packageSha256,
        'the ceremony binds the package hash',
      );
      assert.equal(p.ceremony!.providerKind, 'deterministic_simulator', 'named for what it is');
      assert.match(p.ceremony!.providerEnvelopeRef!, /^ENV-[0-9A-F]{16}$/);
      assert.equal(p.ceremony!.consentTextVersion, CONSENT_TEXT_VERSION);
      const customer = p.signers.find((x) => x.signerRole === 'customer')!;
      assert.equal(customer.identityAssurance, 'email_link');
      assert.equal(customer.signingAuthority, 'self');
      assert.equal(customer.contactMasked, 'd***@example.com', 'staff see the channel masked');
      assert.equal(customer.state, 'invited');
      const dealer = p.signers.find((x) => x.signerRole === 'dealer_representative')!;
      assert.equal(dealer.identityAssurance, 'staff_session');
      assert.equal(dealer.signingAuthority, 'authorised_representative');
      // The provider's delivery is a recorded fact, PII-free.
      const delivered = p.events.find(
        (e) => e.eventType === 'signer.invited' && e.payload.lane === 'signer_token',
      );
      assert.ok(delivered, show(p.events.map((e) => e.eventType)));
      assert.match(String(delivered!.payload.delivery_ref), /^DLV-/);
      for (const e of p.events) {
        const text = JSON.stringify(e.payload);
        assert.doesNotMatch(text, /example\.com|Dana|Ortiz/, `event ${e.eventType} carries no PII`);
      }

      // A second send of the same version is the first one, answered again.
      const again = await sendPackage({
        actingUserLinkId: s.w.manager,
        tenantId: s.w.tenantId,
        packageId: s.packageId,
        expectedVersion: 99,
      });
      assert.equal(again.outcome, 'already_sent');
      assert.equal(simulatedDeliveries().length, 1, 'and nothing was delivered twice');
    });

    test('the customer views, consents, and signs exactly the hash they were shown — in that order and no other', async () => {
      const s = await sent();
      const opened = await openSignerSession(s.customerToken);
      assert.equal(opened.outcome, 'ok', show(opened));
      const session = (opened as { value: SignerSession }).value;
      assert.equal(session.signer.state, 'viewed', 'the first look is an instant');
      assert.equal(session.nextStep, 'consent');
      assert.equal(session.documents.length, 3);
      assert.equal(session.package.packageSha256, s.packageSha256);
      assert.ok(
        session.fields.every((f) => !('sourceId' in f)),
        'the signer sees values, not provenance ids',
      );

      const early = await signAsCustomer(s.customerToken, {
        packageSha256: s.packageSha256,
        intentStatement: INTENT_STATEMENT,
      });
      assert.equal(early.outcome, 'consent_required');

      const wrongVersion = await consentToElectronicRecords(s.customerToken, 'ESIGN-CONSENT-1999');
      assert.equal(wrongVersion.outcome, 'invalid');
      const consented = await consentToElectronicRecords(s.customerToken, CONSENT_TEXT_VERSION);
      assert.equal(consented.outcome, 'ok', show(consented));
      assert.equal((consented as { value: { nextStep: string } }).value.nextStep, 'sign');

      const doc = session.documents[0]!;
      const content = await signerDocumentContent(s.customerToken, doc.documentId);
      assert.equal(content.outcome, 'ok');
      const bytes = (content as { value: { content: Buffer } }).value.content;
      assert.equal(
        createHash('sha256').update(bytes).digest('hex'),
        doc.contentSha256,
        'the bytes the signer reads are the bytes the hash names',
      );

      const wrongHash = await signAsCustomer(s.customerToken, {
        packageSha256: 'f'.repeat(64),
        intentStatement: INTENT_STATEMENT,
      });
      assert.equal(wrongHash.outcome, 'hash_mismatch');
      const wrongWords = await signAsCustomer(s.customerToken, {
        packageSha256: s.packageSha256,
        intentStatement: 'sure',
      });
      assert.equal(wrongWords.outcome, 'invalid');

      const signed = await signAsCustomer(s.customerToken, {
        packageSha256: s.packageSha256,
        intentStatement: INTENT_STATEMENT,
      });
      assert.equal(signed.outcome, 'signed', show(signed));
      const out = signed as {
        signer: {
          signerId: string;
          signatureSha256: string;
          consentedAt: string;
          intentConfirmedAt: string;
          signedAt: string;
        };
        ceremony: { state: string };
        package: { state: string };
        completed: boolean;
      };
      assert.equal(out.completed, false, 'the dealer has not signed yet');
      assert.equal(out.ceremony.state, 'in_progress');
      assert.equal(out.package.state, 'partially_signed');
      assert.match(out.signer.signatureSha256, /^[0-9a-f]{64}$/);
      assert.ok(
        out.signer.consentedAt <= out.signer.intentConfirmedAt &&
          out.signer.intentConfirmedAt <= out.signer.signedAt,
      );

      const twice = await signAsCustomer(s.customerToken, {
        packageSha256: s.packageSha256,
        intentStatement: INTENT_STATEMENT,
      });
      assert.equal(twice.outcome, 'already_signed');

      // THE SIGNATURE IS NEVER REWRITTEN: the database refuses with the service stepped round.
      await assert.rejects(
        fixtureAuthorizationStateWrite(
          'adversarial-bypass-attempt',
          `UPDATE ceremony_signers SET signature_sha256 = repeat('0', 64) WHERE tenant_id = $1 AND signer_id = $2`,
          [s.w.tenantId, out.signer.signerId],
        ),
        /has signed, and a signature is not rewritten/,
      );
      await assert.rejects(
        fixtureAuthorizationStateWrite(
          'adversarial-bypass-attempt',
          `UPDATE ceremony_signers SET lane = 'staff_session', party_id = NULL, user_link_id = $3 WHERE tenant_id = $1 AND signer_id = $2`,
          [s.w.tenantId, out.signer.signerId, s.w.manager],
        ),
        /who a signer is, and which lane they sign through, is fixed|ck_signer_lane_identity|not rewritten/,
      );
    });

    test('the dealer signs last, through the staff session the ceremony names, and completion is a document anyone can re-hash', async () => {
      const s = await sent();
      const terms = {
        packageSha256: s.packageSha256,
        intentStatement: INTENT_STATEMENT,
        consentTextVersion: CONSENT_TEXT_VERSION,
      };

      const tooSoon = await signAsDealerRepresentative({
        actingUserLinkId: s.w.manager,
        tenantId: s.w.tenantId,
        ceremonyId: s.ceremonyId,
        ...terms,
      });
      assert.equal(tooSoon.outcome, 'out_of_order', 'the customer signs first');

      await openSignerSession(s.customerToken);
      await consentToElectronicRecords(s.customerToken, CONSENT_TEXT_VERSION);
      const customer = await signAsCustomer(s.customerToken, {
        packageSha256: s.packageSha256,
        intentStatement: INTENT_STATEMENT,
      });
      assert.equal(customer.outcome, 'signed');

      // NOBODY ELSE CAN SIGN FOR THE DEALER: a salesperson, or a manager who is not the named representative.
      const bySeller = await signAsDealerRepresentative({
        actingUserLinkId: s.w.seller,
        tenantId: s.w.tenantId,
        ceremonyId: s.ceremonyId,
        ...terms,
      });
      assert.equal(bySeller.outcome, 'not_found');
      const { seedActor } = await import('@dealer/test-kit');
      const { ROLES } = await import('@dealer/contracts');
      const otherManager = await seedActor(env.issuer, {
        tenantId: s.w.tenantId,
        roles: [ROLES.SALES_MANAGER],
        scope: { level: 'rooftop', id: s.w.rooftopId },
      });
      const byOther = await signAsDealerRepresentative({
        actingUserLinkId: otherManager.userLinkId,
        tenantId: s.w.tenantId,
        ceremonyId: s.ceremonyId,
        ...terms,
      });
      assert.equal(
        byOther.outcome,
        'not_found',
        'another manager is not the representative this ceremony names',
      );

      const dealer = await signAsDealerRepresentative({
        actingUserLinkId: s.w.manager,
        tenantId: s.w.tenantId,
        ceremonyId: s.ceremonyId,
        ...terms,
      });
      assert.equal(dealer.outcome, 'signed', show(dealer));
      const d = dealer as {
        completed: boolean;
        ceremony: { state: string; completionCertificateSha256: string; completedAt: string };
        package: { state: string };
      };
      assert.equal(d.completed, true);
      assert.equal(d.ceremony.state, 'completed');
      assert.equal(d.package.state, 'signed_complete');
      assert.match(d.ceremony.completionCertificateSha256, /^[0-9a-f]{64}$/);

      const jacket = await query(
        `SELECT state FROM deal_jackets WHERE tenant_id = $1 AND jacket_id = $2`,
        [s.w.tenantId, s.jacketId],
      );
      assert.equal(String((jacket.rows[0] as { state: string }).state), 'signed_complete');

      // THE CERTIFICATE: bytes whose digest is the one the ceremony recorded, naming every signer and every instant.
      const blob = await query(`SELECT content FROM document_blobs WHERE content_sha256 = $1`, [
        d.ceremony.completionCertificateSha256,
      ]);
      const bytes = (blob.rows[0] as { content: Buffer }).content;
      assert.equal(
        createHash('sha256').update(bytes).digest('hex'),
        d.ceremony.completionCertificateSha256,
      );
      const certificate = JSON.parse(bytes.toString('utf8')) as {
        bound_package_sha256: string;
        signers: Record<string, unknown>[];
        documents: unknown[];
        provider_kind: string;
      };
      assert.equal(certificate.bound_package_sha256, s.packageSha256);
      assert.equal(certificate.signers.length, 2);
      for (const signer of certificate.signers) {
        assert.ok(
          signer.consented_at &&
            signer.intent_confirmed_at &&
            signer.signed_at &&
            signer.signature_sha256,
          show(signer),
        );
      }
      assert.equal(certificate.documents.length, 3);
      assert.equal(certificate.provider_kind, 'deterministic_simulator');

      // The timeline says all of it, PII-free, in order.
      const detail = await jacketDetail(s.w.tenantId, s.w.seller, s.jacketId);
      const types = detail!.packages[0]!.events.map((e) => e.eventType);
      for (const expected of [
        'ceremony.created',
        'signer.invited',
        'signer.viewed',
        'signer.consented',
        'signer.signed',
        'ceremony.completed',
      ]) {
        assert.ok(types.includes(expected), `${expected} in ${types.join(', ')}`);
      }
      assert.equal(types.indexOf('signer.consented') < types.indexOf('signer.signed'), true);

      // NOTHING HERE IS A SALE. The jacket signed; no sale, funding or delivery row exists anywhere to write.
      const tables = await query(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('sales', 'deals', 'deliveries', 'sold_inventory', 'fundings', 'payments')`,
        [],
      );
      assert.deepEqual(tables.rows, []);
    });

    test('a superseded or modified package takes no signature — the service and the database both refuse', async () => {
      const s = await sent();
      await consentToElectronicRecords(s.customerToken, CONSENT_TEXT_VERSION);

      // THE INPUT MOVES: a revised template supersedes the sent package before anybody signs it.
      const cutover = new Date().toISOString();
      await query(
        `UPDATE document_templates SET effective_to = $2::timestamptz WHERE tenant_id = $1 AND template_code = 'privacy_notice' AND version = 1`,
        [s.w.tenantId, cutover],
      );
      await seedTemplate(s.w, 'privacy_notice', {
        body: 'PRIVACY NOTICE, REVISED, for {{customer.name}}.',
        effectiveFrom: cutover,
      });
      const jacketVersion = (await jacketDetail(s.w.tenantId, s.w.seller, s.jacketId))!.jacket
        .authorizationVersion;
      const next = await assemblePackage({
        actingUserLinkId: s.w.seller,
        tenantId: s.w.tenantId,
        jacketId: s.jacketId,
        expectedVersion: jacketVersion,
      });
      assert.equal(next.outcome, 'assembled', show(next));

      const late = await signAsCustomer(s.customerToken, {
        packageSha256: s.packageSha256,
        intentStatement: INTENT_STATEMENT,
      });
      assert.equal(late.outcome, 'closed', show(late));
      assert.equal(
        (late as { state: string }).state,
        'voided',
        'the ceremony on a superseded package is voided',
      );

      // THE DATABASE, STEPPED ROUND: a signature written straight onto the superseded package's signer is refused.
      const signer = await query(
        `SELECT signer_id FROM ceremony_signers WHERE tenant_id = $1 AND ceremony_id = $2 AND signer_role = 'customer'`,
        [s.w.tenantId, s.ceremonyId],
      );
      await assert.rejects(
        fixtureAuthorizationStateWrite(
          'adversarial-bypass-attempt',
          `UPDATE ceremony_signers SET intent_confirmed_at = NOW(), signed_at = NOW(), signature_sha256 = repeat('a', 64), state = 'signed'
            WHERE tenant_id = $1 AND signer_id = $2`,
          [s.w.tenantId, String((signer.rows[0] as { signer_id: string }).signer_id)],
        ),
        /does not admit signatures|cannot be signed|binds exactly the bytes/,
      );

      // The earlier package keeps what it had; the new version has its own ceremony to run.
      const detail = await jacketDetail(s.w.tenantId, s.w.seller, s.jacketId);
      const old = detail!.packages.find((p) => p.package.packageId === s.packageId)!;
      assert.equal(old.package.state, 'superseded');
      assert.equal(old.ceremony!.state, 'voided');
      assert.equal(old.package.packageSha256, s.packageSha256);
      const fresh = detail!.packages.find((p) => p.package.packageId !== s.packageId)!;
      assert.equal(fresh.package.state, 'draft');
      assert.equal(fresh.ceremony, null);
    });

    test('declining ends the ceremony, voids the package and touches nothing that was signed', async () => {
      const s = await sent();
      const declined = await declineAsCustomer(
        s.customerToken,
        'the figures are not what we agreed',
      );
      assert.equal(declined.outcome, 'declined', show(declined));
      const d = declined as {
        ceremony: { state: string };
        package: { state: string; stateReason: string | null };
      };
      assert.equal(d.ceremony.state, 'declined');
      assert.equal(d.package.state, 'voided');
      assert.equal(d.package.stateReason, 'declined by signer');
      const again = await declineAsCustomer(s.customerToken, 'still no');
      assert.equal(again.outcome, 'already_declined');
      const detail = await jacketDetail(s.w.tenantId, s.w.manager, s.jacketId);
      const event = detail!.packages[0]!.events.find((e) => e.eventType === 'signer.declined')!;
      assert.doesNotMatch(
        JSON.stringify(event.payload),
        /figures/,
        'the signer’s words stay on the signer row, out of the ledger',
      );
    });

    test('a provider callback is signed, recorded once, replayed harmlessly, and reconciled against our own evidence', async () => {
      const s = await sent();
      // Assembled from its parts so the full-history secret scan cannot read a fixture as a credential.
      const secret = ['esign', 'webhook', 'for', 'tests', '0123456789abcdef'].join('-');
      const body = Buffer.from(
        JSON.stringify({
          event_id: 'evt_0001',
          event_type: 'envelope.viewed',
          envelope_ref: (
            await query(
              `SELECT provider_envelope_ref FROM signing_ceremonies WHERE tenant_id = $1 AND ceremony_id = $2`,
              [s.w.tenantId, s.ceremonyId],
            )
          ).rows[0]!.provider_envelope_ref,
          envelope_status: 'sent',
          occurred_at: new Date().toISOString(),
          metadata: { tenant_id: s.w.tenantId, ceremony_id: s.ceremonyId },
        }),
      );
      assert.equal(verifyProviderSignature(body, signProviderBody(secret, body), secret), 'valid');
      assert.equal(
        verifyProviderSignature(
          body,
          signProviderBody(['another', 'key', '0123456789abcdef0123456789'].join('-'), body),
          secret,
        ),
        'invalid',
      );
      assert.equal(verifyProviderSignature(body, undefined, secret), 'invalid');
      assert.equal(verifyProviderSignature(body, 'sha256=nothex', secret), 'invalid');
      assert.equal(
        verifyProviderSignature(body, signProviderBody(secret, body), null),
        'unconfigured',
      );
      assert.equal(
        verifyProviderSignature(
          Buffer.concat([body, Buffer.from(' ')]),
          signProviderBody(secret, body),
          secret,
        ),
        'invalid',
        'one changed byte, no signature',
      );

      const callback = parseProviderCallback(JSON.parse(body.toString('utf8')));
      assert.ok(!('error' in callback), show(callback));
      const first = await recordProviderCallback(
        callback as Exclude<typeof callback, { error: string }>,
      );
      assert.equal(first.outcome, 'recorded', show(first));
      assert.equal(
        (first as { reconciliation: string }).reconciliation,
        'agrees',
        'sent is what we hold',
      );
      const replay = await recordProviderCallback(
        callback as Exclude<typeof callback, { error: string }>,
      );
      assert.equal(replay.outcome, 'replayed');
      const rows = await query(
        `SELECT COUNT(*)::int AS n FROM ceremony_events WHERE tenant_id = $1 AND provider_event_ref = 'evt_0001'`,
        [s.w.tenantId],
      );
      assert.equal(
        Number((rows.rows[0] as { n: number }).n),
        1,
        'one delivery, one row, however many times it arrives',
      );

      // A claim our evidence contradicts is recorded as a disagreement and changes nothing.
      const claim = parseProviderCallback({
        ...JSON.parse(body.toString('utf8')),
        event_id: 'evt_0002',
        event_type: 'envelope.completed',
        envelope_status: 'completed',
      });
      const disputed = await recordProviderCallback(
        claim as Exclude<typeof claim, { error: string }>,
      );
      assert.equal(disputed.outcome, 'recorded');
      assert.equal((disputed as { reconciliation: string }).reconciliation, 'disagrees');
      const ceremony = await query(
        `SELECT state FROM signing_ceremonies WHERE tenant_id = $1 AND ceremony_id = $2`,
        [s.w.tenantId, s.ceremonyId],
      );
      assert.equal(
        String((ceremony.rows[0] as { state: string }).state),
        'sent',
        'the provider’s word does not complete our ceremony',
      );
      const { jacketBoard } = await import('@dealer/jacket');
      const board = await jacketBoard(s.w.tenantId, s.w.manager);
      assert.equal(board.queues.provider_failure, 1);
      assert.ok(board.rows[0]!.exceptions.includes('provider disagrees'));

      // A callback about an envelope this ceremony never had is unknown, and a malformed one is refused before it is trusted.
      const stranger = await recordProviderCallback({
        ...(callback as Exclude<typeof callback, { error: string }>),
        providerEventRef: 'evt_0003',
        envelopeRef: 'ENV-NOTOURS',
      });
      assert.equal(stranger.outcome, 'unknown_envelope');
      assert.ok('error' in parseProviderCallback({ event_id: 'x' }));
      // The provider ledger is append-only for every role.
      await assert.rejects(
        fixtureAuthorizationStateWrite(
          'adversarial-bypass-attempt',
          `UPDATE ceremony_events SET payload = '{}'::jsonb WHERE tenant_id = $1 AND provider_event_ref = 'evt_0001'`,
          [s.w.tenantId],
        ),
        /append-only ledger/,
      );
    });

    test('a signing link is a digest in the database and a clock in the hand — expired, foreign and invented tokens all fail closed', async () => {
      const s = await sent();
      const stored = await query(
        `SELECT token_sha256, token_expires_at FROM ceremony_signers WHERE tenant_id = $1 AND ceremony_id = $2 AND lane = 'signer_token'`,
        [s.w.tenantId, s.ceremonyId],
      );
      const row = stored.rows[0] as { token_sha256: string; token_expires_at: Date };
      const raw = s.customerToken.split('.')[1]!;
      assert.equal(
        row.token_sha256,
        createHash('sha256').update(raw).digest('hex'),
        'the database holds the digest, never the token',
      );
      assert.notEqual(row.token_sha256, raw);

      const invented = await openSignerSession(`${s.w.tenantId}.${'A'.repeat(43)}`);
      assert.equal(invented.outcome, 'not_found');
      const foreign = await openSignerSession(`00000000-0000-4000-8000-000000000000.${raw}`);
      assert.equal(
        foreign.outcome,
        'not_found',
        'the right token under the wrong dealership is nothing',
      );
      const expired = await openSignerSession(
        s.customerToken,
        new Date(row.token_expires_at.getTime() + 1).toISOString(),
      );
      assert.equal(expired.outcome, 'expired');
      const stillGood = await openSignerSession(s.customerToken);
      assert.equal(stillGood.outcome, 'ok');
    });
  },
);
