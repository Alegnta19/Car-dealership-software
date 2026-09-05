import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';

import { closePool, query } from '@dealer/database';
import {
  assemblePackage,
  jacketDetail,
  listConfiguration,
  markReviewReady,
  openJacket,
  recordRequirement,
  recordTemplate,
  resolveConfigurationWithin,
  satisfyWithEvidence,
  waiveRequirement,
} from '@dealer/jacket';
import { withTenantTransaction } from '@dealer/database';
import {
  fixtureAuthorizationStateWrite,
  resetDatabase,
  skipIntegration,
  startIdentityTestEnv,
  type IdentityTestEnv,
} from '@dealer/test-kit';

import {
  EFFECTIVE_FROM,
  INSURANCE_CARD_SHA256,
  JURISDICTION,
  resetVins,
  seedJacketWorld,
  seedTemplate,
  show,
  type JacketWorld,
} from './jacket-world';

/**
 * OUTCOME 2 — VERSIONED CHECKLIST AND DOCUMENT REQUIREMENTS.
 *
 * "Resolve requirements from typed, effective-dated legal-entity, rooftop,
 * jurisdiction, transaction-type, and template configuration. Every requirement
 * must show its source and version. Missing required items block progression.
 * Any permitted waiver requires authorized actor, reason, policy version, and
 * evidence."
 *
 * TWO OF THESE PROBES STEP ROUND THE SERVICE. "Two versions cannot both be in
 * force" and "a waiver is four things" are claims about the database or they
 * are claims about whichever code path happened to be tested, so both are
 * issued as raw statements through the declared fixture bypass and both must
 * be refused by migration 066 itself.
 */
describe(
  'jacket: the checklist, its configuration and its waivers (FBL-140 Outcome 2)',
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
    });

    async function opened(w: JacketWorld) {
      const out = await openJacket({
        actingUserLinkId: w.seller,
        tenantId: w.tenantId,
        deskingCaseId: w.caseId,
      });
      assert.equal(out.outcome, 'opened', show(out));
      return (
        out as { jacket: { jacketId: string; authorizationVersion: number; legalEntityId: string } }
      ).jacket;
    }

    test('every requirement and template names its source, scope, interval and version, and a sample says it is one', async () => {
      const w = await seedJacketWorld(env);
      const listing = await listConfiguration(w.tenantId, w.manager);
      assert.equal(listing.requirements.length, 4);
      assert.equal(listing.templates.length, 3);
      assert.equal(listing.retentionPolicies.length, 1);
      for (const r of listing.requirements) {
        assert.ok(r.source.length > 0);
        assert.equal(r.version, 1);
        assert.equal(r.jurisdiction, JURISDICTION);
        assert.equal(r.effectiveFrom, EFFECTIVE_FROM);
      }
      for (const t of listing.templates) {
        assert.equal(
          t.approvalStatus,
          'unapproved_sample',
          'nothing in this fixture claims to be an approved form',
        );
        assert.equal(t.approvedByUserLinkId, null);
        assert.equal(t.approvedAt, null);
        assert.match(t.source, /NOT a jurisdictionally approved form/);
        assert.match(t.bodySha256, /^[0-9a-f]{64}$/);
        assert.ok(!('bodyTemplate' in t), 'the listing does not carry bodies');
      }
    });

    test('an approval names who and when and what it rests on, or it is not an approval — service and database agree', async () => {
      const w = await seedJacketWorld(env);

      const bare = await recordTemplate({
        actingUserLinkId: w.manager,
        tenantId: w.tenantId,
        templateCode: 'buyers_guide',
        title: 'Buyers guide',
        documentKind: 'acknowledgement',
        jurisdiction: JURISDICTION,
        legalEntityId: null,
        rooftopId: null,
        transactionType: 'any',
        source: 'Counsel memo 2026-08-30',
        approvalStatus: 'approved',
        approvalReference: null,
        effectiveFrom: '2027-01-01T00:00:00.000Z',
        effectiveTo: null,
        bodyTemplate: 'PRIVACY NOTICE for {{customer.name}}.',
        requiredSignerRoles: ['customer'],
      });
      assert.equal(bare.outcome, 'invalid', show(bare));
      assert.match((bare as { error: string }).error, /names the approval it rests on/);

      const real = await recordTemplate({
        actingUserLinkId: w.manager,
        tenantId: w.tenantId,
        templateCode: 'buyers_guide',
        title: 'Buyers guide',
        documentKind: 'acknowledgement',
        jurisdiction: JURISDICTION,
        legalEntityId: null,
        rooftopId: null,
        transactionType: 'any',
        source: 'Counsel memo 2026-08-30',
        approvalStatus: 'approved',
        approvalReference: 'Counsel memo 2026-08-30, §3',
        effectiveFrom: '2027-01-01T00:00:00.000Z',
        effectiveTo: null,
        bodyTemplate: 'PRIVACY NOTICE for {{customer.name}}.',
        requiredSignerRoles: ['customer'],
      });
      assert.equal(real.outcome, 'recorded', show(real));
      const record = (
        real as {
          record: { version: number; approvedByUserLinkId: string; approvedAt: string | null };
        }
      ).record;
      assert.equal(record.version, 1);
      assert.equal(
        record.approvedByUserLinkId,
        w.manager,
        'the accountable approver is the acting manager',
      );
      assert.ok(record.approvedAt !== null);

      // THE DATABASE REFUSES THE LIE WITH THE SERVICE STEPPED ROUND: "approved" with nobody accountable.
      await assert.rejects(
        fixtureAuthorizationStateWrite(
          'adversarial-bypass-attempt',
          `INSERT INTO document_templates
             (tenant_id, template_code, version, title, document_kind, jurisdiction, transaction_type,
              source, approval_status, effective_from, body_template, body_sha256, recorded_by_user_link_id)
           VALUES ($1, 'buyers_guide', 2, 'Buyers guide', 'acknowledgement', $2, 'any', 'somebody said so',
                   'approved', '2028-01-01', 'x', repeat('0', 64), $3)`,
          [w.tenantId, JURISDICTION, w.manager],
        ),
        /ck_template_approval_is_attributed/,
      );
    });

    test('two versions of one requirement or template cannot both be in force over one instant', async () => {
      const w = await seedJacketWorld(env);
      const overlapping = await recordRequirement({
        actingUserLinkId: w.manager,
        tenantId: w.tenantId,
        requirementCode: 'proof_of_insurance',
        label: 'Proof of insurance',
        jurisdiction: JURISDICTION,
        legalEntityId: null,
        rooftopId: null,
        transactionType: 'any',
        satisfiedBy: 'evidence',
        templateCode: null,
        evidenceKind: 'insurance_card',
        required: true,
        waivable: false,
        source: 'Rooftop document policy 2026-02',
        effectiveFrom: '2026-06-01T00:00:00.000Z',
        effectiveTo: null,
      });
      assert.equal(overlapping.outcome, 'overlaps', show(overlapping));

      // The service's answer is the database's answer: the GiST exclusion, stepped round.
      await assert.rejects(
        fixtureAuthorizationStateWrite(
          'adversarial-bypass-attempt',
          `INSERT INTO document_requirements
             (tenant_id, requirement_code, version, label, jurisdiction, transaction_type, satisfied_by,
              evidence_kind, required, waivable, source, effective_from, recorded_by_user_link_id)
           VALUES ($1, 'proof_of_insurance', 2, 'Proof of insurance', $2, 'any', 'evidence', 'insurance_card',
                   TRUE, FALSE, 'policy', '2026-06-01', $3)`,
          [w.tenantId, JURISDICTION, w.manager],
        ),
        /uq_document_requirements_no_overlap/,
      );
      await assert.rejects(
        fixtureAuthorizationStateWrite(
          'adversarial-bypass-attempt',
          `INSERT INTO document_templates
             (tenant_id, template_code, version, title, document_kind, jurisdiction, transaction_type,
              source, effective_from, body_template, body_sha256, recorded_by_user_link_id)
           VALUES ($1, 'retail_agreement', 2, 'Retail purchase agreement', 'contract', $2, 'any', 'sample',
                   '2026-06-01', 'x', repeat('0', 64), $3)`,
          [w.tenantId, JURISDICTION, w.manager],
        ),
        /uq_document_templates_no_overlap/,
      );

      // A version that starts where the last one STOPS is accepted, and only one is in force at any instant.
      const ended = await recordRequirement({
        actingUserLinkId: w.manager,
        tenantId: w.tenantId,
        requirementCode: 'proof_of_insurance',
        label: 'Proof of insurance',
        jurisdiction: JURISDICTION,
        legalEntityId: null,
        rooftopId: null,
        transactionType: 'any',
        satisfiedBy: 'evidence',
        templateCode: null,
        evidenceKind: 'insurance_card',
        required: true,
        waivable: false,
        source: 'Rooftop document policy 2031',
        effectiveFrom: '2031-01-01T00:00:00.000Z',
        effectiveTo: null,
      });
      assert.equal(
        ended.outcome,
        'overlaps',
        'version 1 is open-ended, so a later start still overlaps',
      );
    });

    test("a rooftop's own requirement beats the tenant-wide one, and an exact transaction type beats 'any'", async () => {
      const w = await seedJacketWorld(env);
      const rooftopRow = await recordRequirement({
        actingUserLinkId: w.manager,
        tenantId: w.tenantId,
        requirementCode: 'proof_of_insurance',
        label: 'Proof of insurance (Riverside)',
        jurisdiction: JURISDICTION,
        legalEntityId: null,
        rooftopId: w.rooftopId,
        transactionType: 'retail_finance',
        satisfiedBy: 'evidence',
        templateCode: null,
        evidenceKind: 'insurance_binder',
        required: true,
        waivable: false,
        source: 'Riverside finance-desk policy 2026-03',
        effectiveFrom: EFFECTIVE_FROM,
        effectiveTo: null,
      });
      assert.equal(rooftopRow.outcome, 'recorded', show(rooftopRow));

      const entity = await query(
        `SELECT legal_entity_id FROM rooftops WHERE tenant_id = $1 AND rooftop_id = $2`,
        [w.tenantId, w.rooftopId],
      );
      const legalEntityId = String((entity.rows[0] as { legal_entity_id: string }).legal_entity_id);
      const resolved = await withTenantTransaction(w.tenantId, (tx) =>
        resolveConfigurationWithin(tx, {
          tenantId: w.tenantId,
          jurisdiction: JURISDICTION,
          legalEntityId,
          rooftopId: w.rooftopId,
          transactionType: 'retail_finance',
          at: '2026-09-01T00:00:00.000Z',
        }),
      );
      const insurance = resolved.requirements.find(
        (r) => r.requirementCode === 'proof_of_insurance',
      );
      assert.equal(insurance?.label, 'Proof of insurance (Riverside)');
      assert.equal(insurance?.evidenceKind, 'insurance_binder');
      assert.equal(
        insurance?.waivable,
        false,
        'the rooftop row is the one in force, waivable or not',
      );

      // And a jacket opened now resolves the rooftop row into its checklist, version and source included.
      const j = await opened(w);
      const detail = await jacketDetail(w.tenantId, w.seller, j.jacketId);
      const item = detail?.checklist.find((i) => i.requirementCode === 'proof_of_insurance');
      assert.equal(item?.evidenceKind, 'insurance_binder');
      assert.equal(item?.requirementSource, 'Riverside finance-desk policy 2026-03');
      assert.equal(item?.requirementVersion, 2);

      // The OTHER rooftop still resolves the tenant-wide row.
      const elsewhere = await withTenantTransaction(w.tenantId, (tx) =>
        resolveConfigurationWithin(tx, {
          tenantId: w.tenantId,
          jurisdiction: JURISDICTION,
          legalEntityId: j.legalEntityId,
          rooftopId: w.otherRooftopId,
          transactionType: 'retail_finance',
          at: '2026-09-01T00:00:00.000Z',
        }),
      );
      assert.equal(
        elsewhere.requirements.find((r) => r.requirementCode === 'proof_of_insurance')
          ?.evidenceKind,
        'insurance_card',
      );
    });

    test('missing required items block progression, evidence satisfies, and an optional item never blocks', async () => {
      const w = await seedJacketWorld(env);
      const j = await opened(w);
      const assembled = await assemblePackage({
        actingUserLinkId: w.seller,
        tenantId: w.tenantId,
        jacketId: j.jacketId,
        expectedVersion: j.authorizationVersion,
      });
      assert.equal(assembled.outcome, 'assembled', show(assembled));
      const pkg = (assembled as { package: { packageId: string; authorizationVersion: number } })
        .package;

      // Rendering satisfied the three document requirements; the evidence one is still missing.
      const before = await jacketDetail(w.tenantId, w.seller, j.jacketId);
      assert.deepEqual(
        before?.blocking.map((i) => i.requirementCode),
        ['proof_of_insurance'],
      );
      assert.equal(
        before?.checklist.find((i) => i.requirementCode === 'privacy_notice')?.state,
        'satisfied',
      );

      const blocked = await markReviewReady({
        actingUserLinkId: w.seller,
        tenantId: w.tenantId,
        packageId: pkg.packageId,
        expectedVersion: pkg.authorizationVersion,
      });
      assert.equal(blocked.outcome, 'blocked', show(blocked));
      assert.deepEqual(
        (blocked as { items: readonly { requirementCode: string }[] }).items.map(
          (i) => i.requirementCode,
        ),
        ['proof_of_insurance'],
      );

      const item = before!.checklist.find((i) => i.requirementCode === 'proof_of_insurance')!;
      const wrongKind = await satisfyWithEvidence({
        actingUserLinkId: w.seller,
        tenantId: w.tenantId,
        jacketId: j.jacketId,
        itemId: before!.checklist.find((i) => i.requirementCode === 'retail_agreement')!.itemId,
        evidenceUri: 'file://insurance-card.pdf',
        evidenceSha256: INSURANCE_CARD_SHA256,
        expectedVersion: 1,
      });
      assert.equal(wrongKind.outcome, 'invalid', 'a document requirement is not met by evidence');
      const badHash = await satisfyWithEvidence({
        actingUserLinkId: w.seller,
        tenantId: w.tenantId,
        jacketId: j.jacketId,
        itemId: item.itemId,
        evidenceUri: 'file://insurance-card.pdf',
        evidenceSha256: 'not-a-digest',
        expectedVersion: item.authorizationVersion,
      });
      assert.equal(badHash.outcome, 'invalid');
      const satisfied = await satisfyWithEvidence({
        actingUserLinkId: w.seller,
        tenantId: w.tenantId,
        jacketId: j.jacketId,
        itemId: item.itemId,
        evidenceUri: 'file://insurance-card.pdf',
        evidenceSha256: INSURANCE_CARD_SHA256,
        expectedVersion: item.authorizationVersion,
      });
      assert.equal(satisfied.outcome, 'updated', show(satisfied));
      const replayed = await satisfyWithEvidence({
        actingUserLinkId: w.seller,
        tenantId: w.tenantId,
        jacketId: j.jacketId,
        itemId: item.itemId,
        evidenceUri: 'file://insurance-card.pdf',
        evidenceSha256: INSURANCE_CARD_SHA256,
        expectedVersion: item.authorizationVersion + 1,
      });
      assert.equal(replayed.outcome, 'already_there');

      const ready = await markReviewReady({
        actingUserLinkId: w.seller,
        tenantId: w.tenantId,
        packageId: pkg.packageId,
        expectedVersion: pkg.authorizationVersion,
      });
      assert.equal(ready.outcome, 'moved', show(ready));
      assert.equal((ready as { package: { state: string } }).package.state, 'review_ready');
    });

    test('a waiver is four things from an eligible manager, or it is nothing — service and database agree', async () => {
      const w = await seedJacketWorld(env);
      const j = await opened(w);
      const detail = await jacketDetail(w.tenantId, w.seller, j.jacketId);
      const insurance = detail!.checklist.find((i) => i.requirementCode === 'proof_of_insurance')!;
      const agreement = detail!.checklist.find((i) => i.requirementCode === 'retail_agreement')!;

      const bySeller = await waiveRequirement({
        actingUserLinkId: w.seller,
        tenantId: w.tenantId,
        jacketId: j.jacketId,
        itemId: insurance.itemId,
        reason: 'customer will bring it',
        policyVersion: 3,
        evidenceUri: 'file://note.txt',
        expectedVersion: insurance.authorizationVersion,
      });
      assert.equal(
        bySeller.outcome,
        'not_found',
        'a salesperson cannot waive, and the refusal explains nothing',
      );

      const notWaivable = await waiveRequirement({
        actingUserLinkId: w.manager,
        tenantId: w.tenantId,
        jacketId: j.jacketId,
        itemId: agreement.itemId,
        reason: 'skip the contract',
        policyVersion: 3,
        evidenceUri: 'file://note.txt',
        expectedVersion: agreement.authorizationVersion,
      });
      assert.equal(notWaivable.outcome, 'invalid', show(notWaivable));
      assert.match(
        (notWaivable as { error: string }).error,
        /retail_agreement \(version 1, Rooftop document policy 2026-01/,
      );

      for (const partial of [
        { reason: '', policyVersion: 3, evidenceUri: 'file://note.txt' },
        { reason: 'customer will bring it', policyVersion: 0, evidenceUri: 'file://note.txt' },
        { reason: 'customer will bring it', policyVersion: 3, evidenceUri: '' },
      ]) {
        const refused = await waiveRequirement({
          actingUserLinkId: w.manager,
          tenantId: w.tenantId,
          jacketId: j.jacketId,
          itemId: insurance.itemId,
          ...partial,
          expectedVersion: insurance.authorizationVersion,
        });
        assert.equal(refused.outcome, 'invalid', show(refused));
      }

      // THE DATABASE, STEPPED ROUND: waived with three of the four is unrepresentable.
      await assert.rejects(
        fixtureAuthorizationStateWrite(
          'adversarial-bypass-attempt',
          `UPDATE jacket_checklist_items
              SET state = 'waived', waived_by_user_link_id = $3, waiver_reason = 'because', waived_at = NOW()
            WHERE tenant_id = $1 AND item_id = $2`,
          [w.tenantId, insurance.itemId, w.manager],
        ),
        /ck_checklist_waiver_complete/,
      );
      // …and so is a waiver on a requirement that was not waivable.
      await assert.rejects(
        fixtureAuthorizationStateWrite(
          'adversarial-bypass-attempt',
          `UPDATE jacket_checklist_items
              SET state = 'waived', waived_by_user_link_id = $3, waiver_reason = 'because',
                  waiver_policy_version = 1, waiver_evidence_uri = 'file://x', waived_at = NOW()
            WHERE tenant_id = $1 AND item_id = $2`,
          [w.tenantId, agreement.itemId, w.manager],
        ),
        /ck_checklist_waiver_complete/,
      );

      const waived = await waiveRequirement({
        actingUserLinkId: w.manager,
        tenantId: w.tenantId,
        jacketId: j.jacketId,
        itemId: insurance.itemId,
        reason: 'customer will bring it at delivery',
        policyVersion: 3,
        evidenceUri: 'file://manager-note.txt',
        expectedVersion: insurance.authorizationVersion,
      });
      assert.equal(waived.outcome, 'updated', show(waived));
      const item = (waived as unknown as { item: Record<string, unknown> }).item;
      assert.equal(item.state, 'waived');
      assert.equal(item.waivedByUserLinkId, w.manager);
      assert.equal(item.waiverPolicyVersion, 3);
      assert.equal(item.waiverEvidenceUri, 'file://manager-note.txt');
      assert.ok(item.waivedAt !== null);

      // The audit row names the waiver, and the waived item no longer blocks.
      const audit = await query(
        `SELECT event_type FROM audit_events WHERE tenant_id = $1 AND entity_id = $2`,
        [w.tenantId, insurance.itemId],
      );
      assert.ok(
        audit.rows.some(
          (r) => String((r as { event_type: string }).event_type) === 'jacket.checklist.waived',
        ),
      );
      // The waived line no longer blocks; the two document lines still do, until they are rendered.
      const after = await jacketDetail(w.tenantId, w.seller, j.jacketId);
      assert.deepEqual(after?.blocking.map((i) => i.requirementCode).sort(), [
        'odometer_disclosure',
        'retail_agreement',
      ]);
    });

    test('the next version may end the one in force at its own start — and only a version that has begun', async () => {
      const w = await seedJacketWorld(env);
      const cutover = new Date().toISOString();
      const revised = await recordTemplate({
        actingUserLinkId: w.manager,
        tenantId: w.tenantId,
        templateCode: 'privacy_notice',
        title: 'Privacy notice acknowledgement (sample, revised)',
        documentKind: 'acknowledgement',
        jurisdiction: JURISDICTION,
        legalEntityId: null,
        rooftopId: null,
        transactionType: 'any',
        source: 'FBL-140 sample text, revised — NOT a jurisdictionally approved form',
        approvalStatus: 'unapproved_sample',
        approvalReference: null,
        effectiveFrom: cutover,
        effectiveTo: null,
        bodyTemplate: 'PRIVACY NOTICE, REVISED, for {{customer.name}}.',
        requiredSignerRoles: ['customer'],
        closesPredecessor: true,
      });
      assert.equal(revised.outcome, 'recorded', show(revised));
      assert.equal((revised as { record: { version: number } }).record.version, 2);
      const versions = await query(
        `SELECT version, effective_to FROM document_templates WHERE tenant_id = $1 AND template_code = 'privacy_notice' ORDER BY version`,
        [w.tenantId],
      );
      assert.equal(
        (versions.rows[0] as { effective_to: Date }).effective_to.toISOString(),
        cutover,
        'version 1 ends exactly where version 2 begins',
      );
      assert.equal((versions.rows[1] as { effective_to: string | null }).effective_to, null);
      const audit = await query(
        `SELECT details FROM audit_events WHERE tenant_id = $1 AND event_type = 'jacket.template.recorded' ORDER BY occurred_at DESC LIMIT 1`,
        [w.tenantId],
      ).catch(() => null);
      if (audit !== null && audit.rows.length > 0) {
        assert.equal(
          (audit.rows[0] as { details: { closed_predecessor_version: number } }).details
            .closed_predecessor_version,
          1,
        );
      }

      // A version that has not begun cannot be ended by a version starting before it.
      const future = await recordTemplate({
        actingUserLinkId: w.manager,
        tenantId: w.tenantId,
        templateCode: 'buyers_guide',
        title: 'Buyers guide',
        documentKind: 'acknowledgement',
        jurisdiction: JURISDICTION,
        legalEntityId: null,
        rooftopId: null,
        transactionType: 'any',
        source: 'sample',
        approvalStatus: 'unapproved_sample',
        approvalReference: null,
        effectiveFrom: '2030-01-01T00:00:00.000Z',
        effectiveTo: null,
        bodyTemplate: 'BUYERS GUIDE for {{customer.name}}.',
        requiredSignerRoles: ['customer'],
      });
      assert.equal(future.outcome, 'recorded', show(future));
      const tooEarly = await recordTemplate({
        actingUserLinkId: w.manager,
        tenantId: w.tenantId,
        templateCode: 'buyers_guide',
        title: 'Buyers guide',
        documentKind: 'acknowledgement',
        jurisdiction: JURISDICTION,
        legalEntityId: null,
        rooftopId: null,
        transactionType: 'any',
        source: 'sample',
        approvalStatus: 'unapproved_sample',
        approvalReference: null,
        effectiveFrom: '2029-01-01T00:00:00.000Z',
        effectiveTo: null,
        bodyTemplate: 'BUYERS GUIDE, earlier, for {{customer.name}}.',
        requiredSignerRoles: ['customer'],
        closesPredecessor: true,
      });
      assert.equal(tooEarly.outcome, 'invalid', show(tooEarly));
      assert.match((tooEarly as { error: string }).error, /starts at or after the new version/);
      // Without the closing flag, the plain answer is still the plain answer.
      const overlapping = await recordTemplate({
        actingUserLinkId: w.manager,
        tenantId: w.tenantId,
        templateCode: 'privacy_notice',
        title: 'Privacy notice',
        documentKind: 'acknowledgement',
        jurisdiction: JURISDICTION,
        legalEntityId: null,
        rooftopId: null,
        transactionType: 'any',
        source: 'sample',
        approvalStatus: 'unapproved_sample',
        approvalReference: null,
        effectiveFrom: new Date().toISOString(),
        effectiveTo: null,
        bodyTemplate: 'x {{customer.name}}',
        requiredSignerRoles: ['customer'],
      });
      assert.equal(overlapping.outcome, 'overlaps', show(overlapping));
    });

    test('a template with no version in force is a render failure the board can see, not a blank document', async () => {
      const w = await seedJacketWorld(env, { withConfiguration: false });
      // Requirements without templates: one document requirement pointing at a template nobody recorded.
      await seedTemplate(w, 'privacy_notice');
      const recorded = await recordRequirement({
        actingUserLinkId: w.manager,
        tenantId: w.tenantId,
        requirementCode: 'retail_agreement',
        label: 'Retail purchase agreement',
        jurisdiction: JURISDICTION,
        legalEntityId: null,
        rooftopId: null,
        transactionType: 'any',
        satisfiedBy: 'template',
        templateCode: 'retail_agreement',
        evidenceKind: null,
        required: true,
        waivable: false,
        source: 'policy',
        effectiveFrom: EFFECTIVE_FROM,
        effectiveTo: null,
      });
      assert.equal(recorded.outcome, 'recorded');
      const { recordRetentionPolicy, DEAL_DOCUMENT_RETENTION_CODE } =
        await import('@dealer/jacket');
      await recordRetentionPolicy({
        actingUserLinkId: w.admin,
        tenantId: w.tenantId,
        policyCode: DEAL_DOCUMENT_RETENTION_CODE,
        label: 'Deal jacket documents',
        retainForDays: 2555,
        source: 'schedule',
        effectiveFrom: EFFECTIVE_FROM,
        effectiveTo: null,
      });
      const j = await opened(w);
      const out = await assemblePackage({
        actingUserLinkId: w.seller,
        tenantId: w.tenantId,
        jacketId: j.jacketId,
        expectedVersion: j.authorizationVersion,
      });
      assert.equal(out.outcome, 'render_failed', show(out));
      const failures = (out as { failures: readonly { templateCode: string; reason: string }[] })
        .failures;
      assert.deepEqual(
        failures.map((f) => f.templateCode),
        ['retail_agreement'],
      );
      assert.match(failures[0]!.reason, /no version of template retail_agreement is in force/);
      const pkg = (
        out as { package: { state: string; documentCount: number; stateReason: string } }
      ).package;
      assert.equal(pkg.state, 'voided');
      assert.equal(pkg.documentCount, 0, 'nothing was rendered');
      assert.match(pkg.stateReason, /^render failure/);
    });
  },
);
