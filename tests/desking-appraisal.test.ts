import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';

import { closePool, query } from '@dealer/database';
import {
  addAppraisalAttachment,
  openDeskingCase,
  recordAppraisal,
  recordSourceQuotation,
  reviseAppraisal,
  caseHeader,
} from '@dealer/desking';
import {
  resetDatabase,
  skipIntegration,
  startIdentityTestEnv,
  type IdentityTestEnv,
} from '@dealer/test-kit';

import { show, seedDeskWorld, resetVins, tradeEvidence, type DeskWorld } from './desking-world';

/**
 * ROW 2 — APPRAISAL EVIDENCE.
 *
 * "Record structured trade identity, ownership/relationship, odometer,
 * condition, equipment, damage, inspection observations, attachments, source
 * quotations, timestamps, and provenance. Changes are versioned and
 * attributable; unavailable external valuation data is explicit rather than
 * fabricated."
 *
 * THE TWO CLAIMS WORTH PROVING ARE BOTH ABOUT WHAT CANNOT HAPPEN: a version
 * cannot be edited after the fact, and a valuation cannot be both absent and
 * numeric. Neither is enforced by the service alone — the first is a trigger
 * and the second a CHECK — so both probes step ROUND the service and go at the
 * table directly, because a guarantee only the service enforces is a habit.
 */
describe(
  'desking: the trade, versioned and attributable (FBL-120 Row 2)',
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

    async function openFile(w: DeskWorld): Promise<string> {
      const opened = await openDeskingCase({
        actingUserLinkId: w.seller,
        tenantId: w.tenantId,
        deskingHandoffId: w.deskingHandoffId,
      });
      assert.equal(opened.outcome, 'opened', show(opened));
      return (opened as { deskingCase: { deskingCaseId: string } }).deskingCase.deskingCaseId;
    }

    async function appraise(
      w: DeskWorld,
      caseId: string,
    ): Promise<{ appraisalId: string; version: number }> {
      const recorded = await recordAppraisal({
        actingUserLinkId: w.seller,
        tenantId: w.tenantId,
        deskingCaseId: caseId,
        vin: '2T1BURHE0JC014729',
        modelYear: 2018,
        make: 'Toyota',
        model: 'Corolla',
        trimLevel: 'LE',
        evidence: tradeEvidence() as never,
      });
      assert.equal(recorded.outcome, 'recorded', show(recorded));
      const a = (recorded as { appraisal: { appraisalId: string; authorizationVersion: number } })
        .appraisal;
      return { appraisalId: a.appraisalId, version: a.authorizationVersion };
    }

    test('one appraisal carries identity once and evidence as a version', async () => {
      const w = await seedDeskWorld(env);
      const caseId = await openFile(w);
      const { appraisalId } = await appraise(w, caseId);

      const version = await query(
        `SELECT version_no, ownership, relationship, odometer_miles, odometer_status,
                condition_grade, provenance, inspection_notes, recorded_by_user_link_id
           FROM appraisal_versions WHERE tenant_id = $1 AND appraisal_id = $2`,
        [w.tenantId, appraisalId],
      );
      assert.equal(version.rows.length, 1);
      const v = version.rows[0] as Record<string, unknown>;
      assert.equal(Number(v.version_no), 1);
      assert.equal(String(v.ownership), 'financed');
      assert.equal(String(v.relationship), 'customer_owned');
      assert.equal(Number(v.odometer_miles), 68_420);
      assert.equal(String(v.odometer_status), 'actual');
      assert.equal(String(v.condition_grade), 'clean');
      assert.equal(String(v.provenance), 'walk_around');
      assert.equal(String(v.recorded_by_user_link_id), w.seller, 'attributable to a person');

      // …and the structured children the order names, each hanging off THAT version.
      const damage = await query(
        `SELECT area, severity, estimated_repair_cents FROM appraisal_damage_items
          WHERE tenant_id = $1`,
        [w.tenantId],
      );
      assert.equal(damage.rows.length, 1);
      assert.equal(String((damage.rows[0] as Record<string, unknown>).area), 'front bumper');
      const equipment = await query(
        `SELECT code, present FROM appraisal_equipment WHERE tenant_id = $1 ORDER BY code`,
        [w.tenantId],
      );
      assert.deepEqual(
        equipment.rows.map((r) => String((r as Record<string, unknown>).code)),
        ['sunroof', 'tow_pkg'],
      );
      const observations = await query(
        `SELECT observation FROM appraisal_observations WHERE tenant_id = $1`,
        [w.tenantId],
      );
      assert.equal(observations.rows.length, 1);
    });

    test('a revision is a new version, and the old one is exactly as it was', async () => {
      const w = await seedDeskWorld(env);
      const caseId = await openFile(w);
      const { appraisalId, version } = await appraise(w, caseId);

      const revised = await reviseAppraisal({
        actingUserLinkId: w.otherSeller,
        tenantId: w.tenantId,
        appraisalId,
        expectedVersion: version,
        evidence: tradeEvidence({
          conditionGrade: 'average',
          odometerMiles: 68_430,
          changeReason: 'Second walk-around found hail damage on the roof.',
          damage: [{ area: 'roof', severity: 'moderate', note: 'hail' }],
        }) as never,
      });
      assert.equal(revised.outcome, 'recorded', show(revised));
      assert.equal((revised as { versionNo: number }).versionNo, 2);

      const versions = await query(
        `SELECT version_no, condition_grade, odometer_miles, recorded_by_user_link_id, change_reason
           FROM appraisal_versions WHERE tenant_id = $1 AND appraisal_id = $2
          ORDER BY version_no`,
        [w.tenantId, appraisalId],
      );
      assert.equal(versions.rows.length, 2);
      const [first, second] = versions.rows as Record<string, unknown>[];
      assert.equal(String(first?.condition_grade), 'clean', 'version 1 did not move');
      assert.equal(Number(first?.odometer_miles), 68_420);
      assert.equal(String(first?.recorded_by_user_link_id), w.seller);
      assert.equal(String(second?.condition_grade), 'average');
      assert.equal(String(second?.recorded_by_user_link_id), w.otherSeller, 'a different person');
      assert.match(String(second?.change_reason), /hail/);

      // A stale writer is refused rather than silently winning.
      const stale = await reviseAppraisal({
        actingUserLinkId: w.seller,
        tenantId: w.tenantId,
        appraisalId,
        expectedVersion: version,
        evidence: tradeEvidence() as never,
      });
      assert.equal(stale.outcome, 'version_conflict', show(stale));
    });

    test('the database refuses to edit or delete a recorded version, with the service stepped round', async () => {
      const w = await seedDeskWorld(env);
      const caseId = await openFile(w);
      const { appraisalId } = await appraise(w, caseId);

      await assert.rejects(
        () =>
          query(
            `UPDATE appraisal_versions SET condition_grade = 'rough'
              WHERE tenant_id = $1 AND appraisal_id = $2`,
            [w.tenantId, appraisalId],
          ),
        /evidence recorded at an instant/,
        'an UPDATE issued directly at the table is refused by the trigger, not by the service',
      );
      await assert.rejects(
        () =>
          query(`DELETE FROM appraisal_versions WHERE tenant_id = $1 AND appraisal_id = $2`, [
            w.tenantId,
            appraisalId,
          ]),
        /evidence recorded at an instant/,
      );
    });

    test('a valuation is a number or an honest absence, and never both', async () => {
      const w = await seedDeskWorld(env);
      const caseId = await openFile(w);
      const { appraisalId } = await appraise(w, caseId);

      const quoted = await recordSourceQuotation({
        actingUserLinkId: w.seller,
        tenantId: w.tenantId,
        appraisalId,
        providerCode: 'book_sim',
        providerKind: 'deterministic_simulator',
        availability: 'quoted',
        quotedValueCents: 1_185_000n,
        currency: 'USD',
        reference: 'sim-2026-09-01',
      });
      assert.equal(quoted.outcome, 'recorded', show(quoted));

      const absent = await recordSourceQuotation({
        actingUserLinkId: w.seller,
        tenantId: w.tenantId,
        appraisalId,
        providerCode: 'auction_feed',
        providerKind: 'deterministic_simulator',
        availability: 'NOT_YET_AVAILABLE',
        unavailableReason: 'No auction comparables for this trim in the last 90 days.',
      });
      assert.equal(absent.outcome, 'recorded', show(absent));

      // A CERTIFIED PROVIDER IS REFUSED, because none is integrated and a
      // simulator wearing that label is the fabrication the row forbids.
      const pretending = await recordSourceQuotation({
        actingUserLinkId: w.seller,
        tenantId: w.tenantId,
        appraisalId,
        providerCode: 'book_sim',
        providerKind: 'certified_provider',
        availability: 'quoted',
        quotedValueCents: 1_400_000n,
      });
      assert.equal(pretending.outcome, 'invalid', show(pretending));
      assert.match(String((pretending as { error: string }).error), /no certified valuation/);

      // …and an absence with no reason is refused too.
      const silent = await recordSourceQuotation({
        actingUserLinkId: w.seller,
        tenantId: w.tenantId,
        appraisalId,
        providerCode: 'auction_feed',
        providerKind: 'deterministic_simulator',
        availability: 'NOT_YET_AVAILABLE',
      });
      assert.equal(silent.outcome, 'invalid', show(silent));

      // THE DATABASE HOLDS THE SAME LINE with the service stepped round.
      await assert.rejects(
        () =>
          query(
            `INSERT INTO appraisal_source_quotations
               (tenant_id, appraisal_id, added_in_version_no, provider_code, provider_kind,
                availability, quoted_value_cents, currency, quoted_at, recorded_by_user_link_id)
             VALUES ($1, $2, 1, 'sneaky', 'deterministic_simulator', 'NOT_YET_AVAILABLE',
                     999900, 'USD', NOW(), $3)`,
            [w.tenantId, appraisalId, w.seller],
          ),
        /ck_quotation_value_iff_quoted/,
        'a row cannot say NOT_YET_AVAILABLE and carry a figure',
      );
    });

    test('an attachment records which version it arrived in, and the header reads it all back', async () => {
      const w = await seedDeskWorld(env);
      const caseId = await openFile(w);
      const { appraisalId } = await appraise(w, caseId);
      const added = await addAppraisalAttachment({
        actingUserLinkId: w.seller,
        tenantId: w.tenantId,
        appraisalId,
        kind: 'photo',
        label: 'Front three-quarter',
        uri: 'https://files.example.test/appraisals/front.jpg',
        contentSha256: 'a'.repeat(64),
      });
      assert.equal(added.outcome, 'recorded', show(added));

      await recordSourceQuotation({
        actingUserLinkId: w.seller,
        tenantId: w.tenantId,
        appraisalId,
        providerCode: 'book_sim',
        providerKind: 'deterministic_simulator',
        availability: 'quoted',
        quotedValueCents: 1_185_000n,
        currency: 'USD',
      });

      const header = await caseHeader(w.tenantId, w.seller, caseId);
      assert.ok(header !== null);
      assert.equal(header.appraisal?.vin, '2T1BURHE0JC014729');
      assert.equal(header.appraisal?.description, '2018 Toyota Corolla LE');
      // The SELECTED car is a different vehicle, and migration 062 leaves its make
      // and model NULL until a decoder runs — so the header names it by what is
      // known and by its stock number, rather than printing "null null".
      assert.match(String(header.vehicleDescription), /^\d{4} \(stock [A-Z0-9-]+\)$/);
      assert.equal(header.appraisal?.currentVersionNo, 1);
      assert.equal(header.appraisal?.quotations.length, 1);
      assert.equal(header.appraisal?.quotations[0]?.quotedValueCents, 1_185_000n);
    });

    test('a second appraisal on the same file converges rather than opening a rival', async () => {
      const w = await seedDeskWorld(env);
      const caseId = await openFile(w);
      const first = await appraise(w, caseId);
      const again = await recordAppraisal({
        actingUserLinkId: w.otherSeller,
        tenantId: w.tenantId,
        deskingCaseId: caseId,
        vin: '1FTFW1ET5DFA12345',
        modelYear: 2013,
        make: 'Ford',
        model: 'F-150',
        evidence: tradeEvidence() as never,
      });
      assert.equal(again.outcome, 'already_recorded', show(again));
      assert.equal(
        (again as { appraisal: { appraisalId: string } }).appraisal.appraisalId,
        first.appraisalId,
      );
      const count = await query(
        `SELECT COUNT(*)::int AS n FROM appraisals WHERE tenant_id = $1 AND desking_case_id = $2`,
        [w.tenantId, caseId],
      );
      assert.equal(Number((count.rows[0] as { n: number }).n), 1);
    });
  },
);
