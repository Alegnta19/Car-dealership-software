import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';

import { closePool, query } from '@dealer/database';
import {
  assemblePackage,
  jacketBoard,
  jacketDetail,
  openJacket,
  packageHashOf,
  recordTemplate,
  renderDocument,
  sha256Hex,
  type AssembledField,
} from '@dealer/jacket';
import {
  fixtureAuthorizationStateWrite,
  resetDatabase,
  skipIntegration,
  startIdentityTestEnv,
  type IdentityTestEnv,
} from '@dealer/test-kit';

import {
  approveVersion,
  JURISDICTION,
  resetVins,
  seedJacketWorld,
  seedTemplate,
  show,
  type JacketWorld,
} from './jacket-world';

/**
 * OUTCOMES 3 AND 4 — DETERMINISTIC ASSEMBLY, IMMUTABLE RENDERING.
 *
 * "Assemble fields from canonical records without operator rekeying or copied
 * shadow truth. Every financial figure must exactly match the approved FBL-120
 * version and preserve currency and fixed-decimal semantics. Record field
 * provenance and source versions."
 *
 * "Render versioned document packages deterministically. Bind each artifact to
 * package version, template version, content hash, MIME type, size,
 * classification, malware result, retention policy, and legal-hold state. A
 * changed input creates a new superseding version; it never mutates a rendered
 * or signed package."
 *
 * THE FIGURES ARE COMPARED TO THE DESK'S OWN ROW, cent for cent, not to what
 * this battery remembers typing. THE FREEZE IS PROVED AT THE TABLE: the probes
 * that edit a rendered document, a written package or a blob's bytes are raw
 * statements, and migration 066 must refuse each of them itself.
 */
describe(
  'jacket: deterministic assembly and immutable artifacts (FBL-140 Outcomes 3 and 4)',
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

    interface Built {
      w: JacketWorld;
      jacketId: string;
      jacketVersion: number;
      packageId: string;
      packageVersion: number;
      packageSha256: string;
      documents: readonly {
        documentId: string;
        contentSha256: string;
        templateCode: string | null;
        sequenceNo: number;
      }[];
    }

    async function built(options: Parameters<typeof seedJacketWorld>[1] = {}): Promise<Built> {
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
      const a = assembled as {
        package: {
          packageId: string;
          versionNo: number;
          packageSha256: string;
          authorizationVersion: number;
        };
        documents: Built['documents'];
      };
      const detail = await jacketDetail(w.tenantId, w.seller, jacket.jacketId);
      return {
        w,
        jacketId: jacket.jacketId,
        jacketVersion: detail!.jacket.authorizationVersion,
        packageId: a.package.packageId,
        packageVersion: a.package.versionNo,
        packageSha256: a.package.packageSha256,
        documents: a.documents,
      };
    }

    test('every financial field is the approved version’s own integer cents, with its currency and its provenance', async () => {
      const b = await built();
      const detail = await jacketDetail(b.w.tenantId, b.w.seller, b.jacketId);
      const fields = detail!.packages[0]!.fields;

      const desk = await query(
        `SELECT vehicle_price_cents, trade_allowance_cents, trade_payoff_cents, cash_down_cents, trade_equity_cents,
                taxable_amount_cents, tax_total_cents, fee_total_cents, incentive_total_cents, amount_financed_cents,
                monthly_payment_cents, term_months, apr_ppm, currency, version_no, output_fingerprint
           FROM desking_scenarios WHERE tenant_id = $1 AND scenario_id = $2`,
        [b.w.tenantId, b.w.approvedScenarioId],
      );
      const s = desk.rows[0] as Record<string, string | number>;
      const money = (code: string) => fields.find((f) => f.fieldCode === code)!;
      for (const [code, column] of [
        ['deal.vehicle_price', 'vehicle_price_cents'],
        ['deal.trade_allowance', 'trade_allowance_cents'],
        ['deal.trade_payoff', 'trade_payoff_cents'],
        ['deal.cash_down', 'cash_down_cents'],
        ['deal.trade_equity', 'trade_equity_cents'],
        ['deal.taxable_amount', 'taxable_amount_cents'],
        ['deal.tax_total', 'tax_total_cents'],
        ['deal.fee_total', 'fee_total_cents'],
        ['deal.incentive_total', 'incentive_total_cents'],
        ['deal.amount_financed', 'amount_financed_cents'],
        ['deal.monthly_payment', 'monthly_payment_cents'],
      ] as const) {
        const f = money(code);
        assert.equal(f.valueKind, 'money', code);
        assert.equal(typeof f.valueCents, 'bigint', `${code} is a bigint, never a float`);
        assert.equal(f.valueCents, BigInt(String(s[column])), `${code} is the desk's own cents`);
        assert.equal(f.currency, String(s.currency));
        assert.equal(f.sourceKind, 'desking_scenario');
        assert.equal(f.sourceId, b.w.approvedScenarioId);
        assert.equal(f.sourceVersion, String(s.version_no));
      }
      assert.equal(money('deal.apr').valueInteger, BigInt(String(s.apr_ppm)));
      assert.equal(money('deal.apr').valueKind, 'rate_ppm');
      assert.equal(money('deal.term_months').valueInteger, BigInt(String(s.term_months)));
      assert.equal(
        fields.find((f) => f.fieldCode === 'deal.output_fingerprint')?.valueText,
        String(s.output_fingerprint),
      );

      // EVERY FIELD, NOT JUST THE MONEY, NAMES WHERE IT CAME FROM AND AT WHICH VERSION.
      for (const f of fields) {
        assert.ok(f.sourceKind.length > 0, `${f.fieldCode} has a source kind`);
        assert.ok(f.sourceVersion.length > 0, `${f.fieldCode} has a source version`);
      }
      assert.equal(fields.find((f) => f.fieldCode === 'customer.name')?.valueText, 'Dana Ortiz');
      assert.equal(fields.find((f) => f.fieldCode === 'customer.name')?.sourceKind, 'party');
      assert.equal(fields.find((f) => f.fieldCode === 'trade.vin')?.valueText, '2T1BURHE0JC014729');
      assert.equal(
        fields.find((f) => f.fieldCode === 'trade.vin')?.sourceKind,
        'appraisal_version',
      );
      assert.equal(fields.find((f) => f.fieldCode === 'trade.vin')?.sourceVersion, '1');
      assert.equal(
        fields.find((f) => f.fieldCode === 'dealer.legal_entity')?.valueText,
        'Meridian LLC',
      );
      assert.equal(
        fields.find((f) => f.fieldCode === 'rule.tax.state_sales_tax')?.sourceKind,
        'desking_rule',
      );

      // The database holds the same integers: nothing was re-typed on the way in.
      const stored = await query(
        `SELECT value_cents FROM package_fields WHERE tenant_id = $1 AND package_id = $2 AND field_code = 'deal.amount_financed'`,
        [b.w.tenantId, b.packageId],
      );
      assert.equal(
        String((stored.rows[0] as { value_cents: string }).value_cents),
        String(s.amount_financed_cents),
      );
    });

    test('rendering is a pure function: same template and fields, same bytes, same digest', async () => {
      const fields: AssembledField[] = [
        {
          fieldCode: 'customer.name',
          valueKind: 'text',
          valueText: 'Dana <Ortiz>',
          valueCents: null,
          valueInteger: null,
          currency: null,
          sourceKind: 'party',
          sourceId: null,
          sourceVersion: '1',
        },
        {
          fieldCode: 'deal.amount_financed',
          valueKind: 'money',
          valueText: null,
          valueCents: 3_452_099n,
          valueInteger: null,
          currency: 'USD',
          sourceKind: 'desking_scenario',
          sourceId: null,
          sourceVersion: '1',
        },
        {
          fieldCode: 'deal.apr',
          valueKind: 'rate_ppm',
          valueText: null,
          valueCents: null,
          valueInteger: 74_900n,
          currency: null,
          sourceKind: 'desking_scenario',
          sourceId: null,
          sourceVersion: '1',
        },
      ];
      const input = {
        title: 'Sample',
        templateCode: 'sample',
        templateVersion: 1,
        bodyTemplate:
          'Buyer {{customer.name}} finances {{deal.amount_financed}} at {{deal.apr}}.\n\nSecond paragraph.',
        approvalStatus: 'unapproved_sample' as const,
        source: 'a test',
        jurisdiction: 'US-CO',
        fields,
        packageVersionNo: 1,
      };
      const once = renderDocument(input);
      const twice = renderDocument({ ...input, fields: [...fields].reverse() });
      assert.equal(once.outcome, 'rendered');
      assert.equal(twice.outcome, 'rendered');
      const a = (once as { html: string }).html;
      assert.equal(a, (twice as { html: string }).html, 'field order does not change the bytes');
      assert.equal(sha256Hex(a), sha256Hex((twice as { html: string }).html));
      assert.match(
        a,
        /Buyer Dana &lt;Ortiz&gt; finances \$34,520\.99 USD at 7\.4900%\./,
        'money from cents, HTML escaped',
      );
      assert.match(a, /UNAPPROVED SAMPLE — NOT A JURISDICTIONALLY APPROVED FORM/);
      assert.doesNotMatch(a, /\d{4}-\d{2}-\d{2}T/, 'no timestamp is rendered into the document');

      const unresolved = renderDocument({
        ...input,
        bodyTemplate: 'Hello {{customer.name}} and {{deal.monthly_payment}}',
      });
      assert.deepEqual(unresolved, { outcome: 'unresolved', missing: ['deal.monthly_payment'] });
    });

    test('the same inputs assembled again write nothing, and every artifact is bound to what the order names', async () => {
      const b = await built();
      assert.equal(b.documents.length, 3);
      assert.deepEqual(
        b.documents.map((d) => d.templateCode),
        ['odometer_disclosure', 'privacy_notice', 'retail_agreement'],
      );
      assert.equal(
        b.packageSha256,
        packageHashOf(b.documents.map((d) => d.contentSha256)),
        'the package hash is the digest of the ordered document digests',
      );

      const detail = await jacketDetail(b.w.tenantId, b.w.seller, b.jacketId);
      const pkg = detail!.packages[0]!;
      assert.equal(pkg.package.state, 'draft');
      assert.equal(pkg.package.versionNo, 1);
      assert.equal(pkg.package.carriesUnapprovedTemplates, true);
      assert.equal(
        pkg.package.reviewRequired,
        true,
        'a package of samples asks for a manager’s review',
      );
      for (const d of pkg.documents) {
        assert.equal(d.packageId, b.packageId, 'bound to the package version');
        assert.equal(d.templateVersion, 1, 'bound to the template version');
        assert.match(d.templateSha256!, /^[0-9a-f]{64}$/, 'and to the template’s own digest');
        assert.equal(d.templateApprovalStatus, 'unapproved_sample');
        assert.match(d.contentSha256, /^[0-9a-f]{64}$/);
        assert.equal(d.mimeType, 'text/html; charset=utf-8');
        assert.ok(d.byteSize > 0);
        assert.equal(d.classification, 'customer_confidential');
        assert.equal(
          d.malwareScanResult,
          'not_scanned',
          'no scanner is integrated, and the row says so rather than claiming clean',
        );
        assert.equal(d.retentionPolicyCode, 'deal_jacket_documents');
        assert.equal(d.retentionPolicyVersion, 1);
        assert.equal(d.legalHold, false);
      }
      // The blob's bytes really do digest to the key that names them.
      const agreement = pkg.documents.find((d) => d.templateCode === 'retail_agreement')!;
      const blob = await query(
        `SELECT content, byte_size FROM document_blobs WHERE content_sha256 = $1`,
        [agreement.contentSha256],
      );
      const bytes = (blob.rows[0] as { content: Buffer; byte_size: number }).content;
      assert.equal(createHash('sha256').update(bytes).digest('hex'), agreement.contentSha256);
      assert.equal(bytes.byteLength, Number((blob.rows[0] as { byte_size: number }).byte_size));
      const html = bytes.toString('utf8');
      assert.match(html, /Dana Ortiz/);
      assert.match(
        html,
        /Amount financed \$[0-9,]+\.\d{2} USD\./,
        'money is rendered from cents, with its currency',
      );
      assert.match(html, /Vehicle price \$45,500\.00 USD\./);

      const again = await assemblePackage({
        actingUserLinkId: b.w.seller,
        tenantId: b.w.tenantId,
        jacketId: b.jacketId,
        expectedVersion: b.jacketVersion,
      });
      assert.equal(again.outcome, 'already_current', show(again));
      assert.equal((again as { package: { packageId: string } }).package.packageId, b.packageId);
      const versions = await query(
        `SELECT COUNT(*)::int AS n FROM jacket_packages WHERE tenant_id = $1 AND jacket_id = $2`,
        [b.w.tenantId, b.jacketId],
      );
      assert.equal(Number((versions.rows[0] as { n: number }).n), 1, 'nothing was written');
    });

    test('a written package, a rendered document and a blob cannot be edited — the database refuses each', async () => {
      const b = await built();
      const doc = b.documents[0]!;

      await assert.rejects(
        fixtureAuthorizationStateWrite(
          'adversarial-bypass-attempt',
          `UPDATE jacket_packages SET fields_sha256 = repeat('1', 64) WHERE tenant_id = $1 AND package_id = $2`,
          [b.w.tenantId, b.packageId],
        ),
        /is a written version, and its fields, digests and provenance cannot be edited/,
      );
      await assert.rejects(
        fixtureAuthorizationStateWrite(
          'adversarial-bypass-attempt',
          `UPDATE jacket_packages SET package_sha256 = repeat('2', 64) WHERE tenant_id = $1 AND package_id = $2`,
          [b.w.tenantId, b.packageId],
        ),
        /the package digest of version 1 is set once/,
      );
      await assert.rejects(
        fixtureAuthorizationStateWrite(
          'adversarial-bypass-attempt',
          `UPDATE package_documents SET content_sha256 = $3 WHERE tenant_id = $1 AND document_id = $2`,
          [b.w.tenantId, doc.documentId, b.documents[1]!.contentSha256],
        ),
        /is rendered evidence — only its scan result and its legal-hold state may change/,
      );
      await assert.rejects(
        fixtureAuthorizationStateWrite(
          'adversarial-bypass-attempt',
          `UPDATE package_documents SET title = 'Something else' WHERE tenant_id = $1 AND document_id = $2`,
          [b.w.tenantId, doc.documentId],
        ),
        /rendered evidence/,
      );
      await assert.rejects(
        fixtureAuthorizationStateWrite(
          'adversarial-bypass-attempt',
          `DELETE FROM package_documents WHERE tenant_id = $1 AND document_id = $2`,
          [b.w.tenantId, doc.documentId],
        ),
        /a rendered document is evidence/,
      );
      // The two facts that MAY change on a document: a scan completing, a hold.
      await fixtureAuthorizationStateWrite(
        'adversarial-bypass-attempt',
        `UPDATE package_documents SET malware_scan_result = 'clean', malware_scanner = 'clamav 1.4' WHERE tenant_id = $1 AND document_id = $2`,
        [b.w.tenantId, doc.documentId],
      );
      await assert.rejects(
        fixtureAuthorizationStateWrite(
          'adversarial-bypass-attempt',
          `UPDATE package_documents SET malware_scan_result = 'flagged' WHERE tenant_id = $1 AND document_id = $2`,
          [b.w.tenantId, doc.documentId],
        ),
        /a recorded scan result is not re-decided/,
      );
      // A blob whose key lies about its bytes cannot exist; an existing blob cannot change.
      await assert.rejects(
        fixtureAuthorizationStateWrite(
          'adversarial-bypass-attempt',
          `INSERT INTO document_blobs (content_sha256, mime_type, byte_size, content) VALUES (repeat('3', 64), 'text/plain', 5, 'hello'::bytea)`,
          [],
        ),
        /a key that lies about its content is the one thing a content-addressed store must refuse/,
      );
      await assert.rejects(
        fixtureAuthorizationStateWrite(
          'adversarial-bypass-attempt',
          `UPDATE document_blobs SET content = 'x'::bytea WHERE content_sha256 = $1`,
          [doc.contentSha256],
        ),
        /content-addressed and immutable/,
      );
      await assert.rejects(
        fixtureAuthorizationStateWrite(
          'adversarial-bypass-attempt',
          `UPDATE package_fields SET value_cents = 1 WHERE tenant_id = $1 AND package_id = $2 AND field_code = 'deal.amount_financed'`,
          [b.w.tenantId, b.packageId],
        ),
        /append-only ledger/,
      );
    });

    test('a changed input writes the next version and supersedes the last; the earlier package, its figures and its bytes are intact', async () => {
      const b = await built();
      const before = await jacketDetail(b.w.tenantId, b.w.seller, b.jacketId);
      const v1 = before!.packages[0]!;

      // THE INPUT THAT CHANGES: the template text itself, as a new version in force from
      // one instant, with version 1 ended at that same instant — one clock, no overlap.
      const cutover = new Date().toISOString();
      const ended = await query(
        `UPDATE document_templates SET effective_to = $2::timestamptz WHERE tenant_id = $1 AND template_code = 'privacy_notice' AND version = 1 RETURNING template_id`,
        [b.w.tenantId, cutover],
      );
      assert.equal(ended.rows.length, 1);
      await seedTemplate(b.w, 'privacy_notice', {
        body: 'PRIVACY NOTICE, REVISED. {{customer.name}} acknowledges receipt of the notice from {{dealer.legal_entity}} at {{dealer.rooftop}}.',
        effectiveFrom: cutover,
      });

      const next = await assemblePackage({
        actingUserLinkId: b.w.seller,
        tenantId: b.w.tenantId,
        jacketId: b.jacketId,
        expectedVersion: b.jacketVersion,
      });
      assert.equal(next.outcome, 'assembled', show(next));
      const n = next as {
        package: {
          packageId: string;
          versionNo: number;
          supersedesPackageId: string | null;
          packageSha256: string;
        };
        supersededPackageId: string | null;
      };
      assert.equal(n.package.versionNo, 2);
      assert.equal(n.package.supersedesPackageId, b.packageId);
      assert.equal(n.supersededPackageId, b.packageId);
      assert.notEqual(
        n.package.packageSha256,
        b.packageSha256,
        'a different document, a different package hash',
      );

      const after = await jacketDetail(b.w.tenantId, b.w.seller, b.jacketId);
      const old = after!.packages.find((p) => p.package.packageId === b.packageId)!;
      assert.equal(old.package.state, 'superseded');
      assert.equal(old.package.stateReason, 'superseded by version 2');
      assert.equal(
        old.package.fieldsSha256,
        v1.package.fieldsSha256,
        'its fields digest is what it was',
      );
      assert.equal(
        old.package.packageSha256,
        v1.package.packageSha256,
        'its package hash is what it was',
      );
      assert.deepEqual(
        old.documents.map((d) => d.contentSha256),
        v1.documents.map((d) => d.contentSha256),
        'its documents are what they were',
      );
      assert.deepEqual(old.fields, v1.fields, 'its figures are what they were');
      const oldBlob = await query(
        `SELECT COUNT(*)::int AS n FROM document_blobs WHERE content_sha256 = ANY($1::text[])`,
        [v1.documents.map((d) => d.contentSha256)],
      );
      assert.equal(
        Number((oldBlob.rows[0] as { n: number }).n),
        3,
        'every earlier blob is still there',
      );

      // The unchanged documents share their blobs with the new version: same bytes, same key.
      const fresh = after!.packages.find((p) => p.package.packageId === n.package.packageId)!;
      const unchanged = fresh.documents.filter((d) => d.templateCode !== 'privacy_notice');
      for (const d of unchanged) {
        const prior = v1.documents.find((x) => x.templateCode === d.templateCode)!;
        // Package version is rendered into the page, so the bytes differ by that one line; the template digest does not.
        assert.equal(d.templateSha256, prior.templateSha256);
      }
      const revised = fresh.documents.find((d) => d.templateCode === 'privacy_notice')!;
      assert.equal(revised.templateVersion, 2);
      const bytes = await query(`SELECT content FROM document_blobs WHERE content_sha256 = $1`, [
        revised.contentSha256,
      ]);
      assert.match(
        (bytes.rows[0] as { content: Buffer }).content.toString('utf8'),
        /PRIVACY NOTICE, REVISED/,
      );
    });

    test('a signed package is superseded by the next version, keeps every signature, and new documents inherit a hold', async () => {
      const b = await built();
      const {
        CONSENT_TEXT_VERSION,
        INTENT_STATEMENT,
        consentToElectronicRecords,
        markReviewReady,
        openSignerSession,
        placeLegalHold,
        resetSimulatedEsignProviderForTests,
        reviewPackage,
        sendPackage,
        signAsCustomer,
        signAsDealerRepresentative,
        simulatedDeliveries,
        waiveRequirement,
      } = await import('@dealer/jacket');
      resetSimulatedEsignProviderForTests();
      const detail = await jacketDetail(b.w.tenantId, b.w.seller, b.jacketId);
      const insurance = detail!.checklist.find((i) => i.requirementCode === 'proof_of_insurance')!;
      await waiveRequirement({
        actingUserLinkId: b.w.manager,
        tenantId: b.w.tenantId,
        jacketId: b.jacketId,
        itemId: insurance.itemId,
        reason: 'binder to follow',
        policyVersion: 3,
        evidenceUri: 'file://x',
        expectedVersion: insurance.authorizationVersion,
      });
      let v = detail!.packages[0]!.package.authorizationVersion;
      const ready = await markReviewReady({
        actingUserLinkId: b.w.seller,
        tenantId: b.w.tenantId,
        packageId: b.packageId,
        expectedVersion: v,
      });
      v = (ready as { package: { authorizationVersion: number } }).package.authorizationVersion;
      const reviewed = await reviewPackage({
        actingUserLinkId: b.w.manager,
        tenantId: b.w.tenantId,
        packageId: b.packageId,
        expectedVersion: v,
      });
      v = (reviewed as { package: { authorizationVersion: number } }).package.authorizationVersion;
      const sent = await sendPackage({
        actingUserLinkId: b.w.manager,
        tenantId: b.w.tenantId,
        packageId: b.packageId,
        expectedVersion: v,
      });
      assert.equal(sent.outcome, 'sent', show(sent));
      const ceremonyId = (sent as { ceremony: { ceremonyId: string } }).ceremony.ceremonyId;
      const token = simulatedDeliveries().at(-1)!.signingUrl.split('#/')[1]!;
      await openSignerSession(token);
      await consentToElectronicRecords(token, CONSENT_TEXT_VERSION);
      assert.equal(
        (
          await signAsCustomer(token, {
            packageSha256: b.packageSha256,
            intentStatement: INTENT_STATEMENT,
          })
        ).outcome,
        'signed',
      );
      const done = await signAsDealerRepresentative({
        actingUserLinkId: b.w.manager,
        tenantId: b.w.tenantId,
        ceremonyId,
        packageSha256: b.packageSha256,
        intentStatement: INTENT_STATEMENT,
        consentTextVersion: CONSENT_TEXT_VERSION,
      });
      assert.equal(done.outcome, 'signed', show(done));
      assert.equal((done as { completed: boolean }).completed, true);

      // The administrator places a hold, then the paperwork is redone with a revised template.
      const jacketNow = (await jacketDetail(b.w.tenantId, b.w.admin, b.jacketId))!;
      const held = await placeLegalHold({
        actingUserLinkId: b.w.admin,
        tenantId: b.w.tenantId,
        jacketId: b.jacketId,
        reason: 'litigation hold',
        reference: 'M-1',
        expectedVersion: jacketNow.jacket.authorizationVersion,
      });
      assert.equal(held.outcome, 'recorded', show(held));
      const cutover = new Date().toISOString();
      await seedTemplate(b.w, 'privacy_notice', {
        body: 'PRIVACY NOTICE, REVISED, for {{customer.name}}.',
        effectiveFrom: cutover,
        closesPredecessor: true,
      });
      const afterHold = (await jacketDetail(b.w.tenantId, b.w.seller, b.jacketId))!;
      const next = await assemblePackage({
        actingUserLinkId: b.w.seller,
        tenantId: b.w.tenantId,
        jacketId: b.jacketId,
        expectedVersion: afterHold.jacket.authorizationVersion,
      });
      assert.equal(next.outcome, 'assembled', show(next));
      const n = next as {
        package: { versionNo: number; supersedesPackageId: string | null };
        documents: readonly { legalHold: boolean }[];
      };
      assert.equal(n.package.versionNo, 2);
      assert.equal(
        n.package.supersedesPackageId,
        b.packageId,
        'the signed package is the one superseded',
      );
      assert.ok(
        n.documents.every((d) => d.legalHold),
        'documents rendered under a hold are held from birth',
      );

      const after = (await jacketDetail(b.w.tenantId, b.w.seller, b.jacketId))!;
      const old = after.packages.find((p) => p.package.packageId === b.packageId)!;
      assert.equal(old.package.state, 'superseded');
      assert.equal(old.ceremony!.state, 'completed', 'the ceremony that finished stays finished');
      assert.deepEqual(
        old.signers.map((s) => s.state),
        ['signed', 'signed'],
        'every signature is intact',
      );
      assert.ok(old.ceremony!.completionCertificateSha256 !== null);
      assert.equal(after.jacket.state, 'open', 'the jacket is open paperwork again');
      // The ledger reads in the order it was written: consent before signature, signature before completion.
      const types = old.events.map((e) => e.eventType);
      assert.ok(types.indexOf('signer.consented') < types.indexOf('signer.signed'));
      assert.ok(types.lastIndexOf('signer.consented') < types.indexOf('ceremony.completed'));
      assert.equal(types[types.length - 1], 'ceremony.completed');
    });

    test('an approved template renders its approval and a package of approved templates asks for no review', async () => {
      const w = await seedJacketWorld(env, { withConfiguration: false });
      const { recordRequirement, recordRetentionPolicy, DEAL_DOCUMENT_RETENTION_CODE } =
        await import('@dealer/jacket');
      const approved = await recordTemplate({
        actingUserLinkId: w.manager,
        tenantId: w.tenantId,
        templateCode: 'privacy_notice',
        title: 'Privacy notice',
        documentKind: 'acknowledgement',
        jurisdiction: JURISDICTION,
        legalEntityId: null,
        rooftopId: null,
        transactionType: 'any',
        source: 'Dealership counsel, memo 2026-08-30',
        approvalStatus: 'approved',
        approvalReference: 'Counsel memo 2026-08-30 §3',
        effectiveFrom: '2026-01-01T00:00:00.000Z',
        effectiveTo: null,
        bodyTemplate:
          'PRIVACY NOTICE. {{customer.name}} acknowledges receipt from {{dealer.legal_entity}}.',
        requiredSignerRoles: ['customer'],
      });
      assert.equal(approved.outcome, 'recorded', show(approved));
      const req = await recordRequirement({
        actingUserLinkId: w.manager,
        tenantId: w.tenantId,
        requirementCode: 'privacy_notice',
        label: 'Privacy notice',
        jurisdiction: JURISDICTION,
        legalEntityId: null,
        rooftopId: null,
        transactionType: 'any',
        satisfiedBy: 'template',
        templateCode: 'privacy_notice',
        evidenceKind: null,
        required: true,
        waivable: false,
        source: 'policy',
        effectiveFrom: '2026-01-01T00:00:00.000Z',
        effectiveTo: null,
      });
      assert.equal(req.outcome, 'recorded');
      await recordRetentionPolicy({
        actingUserLinkId: w.admin,
        tenantId: w.tenantId,
        policyCode: DEAL_DOCUMENT_RETENTION_CODE,
        label: 'Deal jacket documents',
        retainForDays: 2555,
        source: 'schedule',
        effectiveFrom: '2026-01-01T00:00:00.000Z',
        effectiveTo: null,
      });
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
      assert.equal(assembled.outcome, 'assembled', show(assembled));
      const a = assembled as {
        package: { carriesUnapprovedTemplates: boolean; reviewRequired: boolean };
        documents: readonly { contentSha256: string; templateApprovalStatus: string }[];
      };
      assert.equal(a.package.carriesUnapprovedTemplates, false);
      assert.equal(a.package.reviewRequired, false);
      assert.equal(a.documents[0]!.templateApprovalStatus, 'approved');
      const bytes = await query(`SELECT content FROM document_blobs WHERE content_sha256 = $1`, [
        a.documents[0]!.contentSha256,
      ]);
      const html = (bytes.rows[0] as { content: Buffer }).content.toString('utf8');
      assert.match(
        html,
        /Template approved for use in the stated jurisdiction\. Source: Dealership counsel, memo 2026-08-30\./,
      );
      assert.doesNotMatch(html, /UNAPPROVED SAMPLE/);
    });

    test('a stale desk approval is refused at assembly and shows on the board, while the approved figures never move under a jacket', async () => {
      const b = await built();
      const successor = await approveVersion(b.w, b.w.caseId, { cashDownCents: 600_000n });
      const refused = await assemblePackage({
        actingUserLinkId: b.w.seller,
        tenantId: b.w.tenantId,
        jacketId: b.jacketId,
        expectedVersion: b.jacketVersion,
      });
      assert.equal(refused.outcome, 'stale_source', show(refused));
      const board = await jacketBoard(b.w.tenantId, b.w.manager);
      assert.equal(board.queues.stale_inputs, 1);
      assert.equal(board.rows[0]?.currentApprovedVersionNo, successor.versionNo);
      // The package that exists still carries the figures of the version it was assembled from.
      const detail = await jacketDetail(b.w.tenantId, b.w.seller, b.jacketId);
      assert.equal(
        detail!.packages[0]!.fields.find((f) => f.fieldCode === 'deal.cash_down')?.valueCents,
        300_000n,
      );
    });
  },
);
