import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { loadRequirementMap } from '../scripts/check-requirement-map';

/**
 * FBL-020-R4 §7 — THE DOCUMENTATION TESTS INSPECT THE DELIVERY DOCUMENTS.
 *
 * `tests/docs.test.ts` compares the PHASE-248 architecture reference against the code
 * it describes, which is worth having and is kept. But it is not a check on the
 * DELIVERY documents, and R3 shipped with that gap: the report cited a governing
 * document section nobody had opened, claimed a local prose exercise as a CI gate, said
 * "no test invokes" an adapter that a test does invoke, and filed a mandatory gate that
 * had NOT been discharged under "residual risk". None of those is the kind of mistake a
 * reader catches by reading; every one of them is mechanically checkable.
 *
 * So this battery reads the delivery report, the runbooks, the README and the
 * known-limitations register, and holds them to the code, the workflow and the
 * requirement map. Where a document makes a claim about a test or an artifact, the claim
 * is checked against the test file or `ci.yml` — so the documents cannot drift into
 * describing a repository that no longer exists.
 */

const ROOT = join(__dirname, '..');
const read = (...p: string[]): string => readFileSync(join(ROOT, ...p), 'utf8');

const REPORT = read('docs', 'FBL-020-DELIVERY-REPORT.md');
const LIMITS = read('docs', 'identity', 'KNOWN-LIMITATIONS.md');
const README = read('README.md');
const WORKOS_RUNBOOK = read('docs', 'runbooks', 'WORKOS-OPERATOR-RUNBOOK.md');
const TENANT_RUNBOOK = read('docs', 'runbooks', 'TENANT-BOOTSTRAP-RUNBOOK.md');
const WORKFLOW = read('.github', 'workflows', 'ci.yml');

/** The one phrase every delivery document must use for the undischarged live gate. */
const LIVE_GATE_PHRASE = 'LIVE WORKOS CERTIFICATION IS NOT DISCHARGED';

/** Everything between one `## ` heading and the next. */
function section(markdown: string, headingContains: string): string {
  const lines = markdown.split('\n');
  const start = lines.findIndex((l) => l.startsWith('## ') && l.includes(headingContains));
  assert.notEqual(start, -1, `the document must carry a "## …${headingContains}…" section`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith('## '));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

describe('the delivery documentation describes this delivery (FBL-020-R4 §7)', () => {
  test('the delivery report cites a governing document this repository can verify', () => {
    const cited = loadRequirementMap().governing_document as Record<string, string> & {
      superseded_document: Record<string, string>;
    };

    /*
     * The citation is one fact set, held in the requirement map, and the report must
     * carry it verbatim: the version STRING, the file, its digest and the heading of the
     * section that governs FBL-020. A citation that names only "v2.0 §14.3" is exactly
     * what was wrong before — unverifiable by the reader, and in fact AMBIGUOUS between
     * two documents whose §14.3 are different orders.
     *
     * The SUPERSEDED document's facts are required too, because its §14.5 is where
     * FBL-020 lives and confusing the two is the mistake that produced the citation R3
     * was rejected for.
     */
    const required: Array<[string, string | undefined]> = [
      ['governing version line', cited.version_line],
      ['governing file name', cited.file],
      ['governing file sha256', cited.file_sha256],
      ['governing §14.3 heading', cited.section_14_3_heading],
      ['superseded version line', cited.superseded_document.version_line],
      ['superseded §14.5 heading', cited.superseded_document.section_14_5_heading],
    ];
    for (const [label, fact] of required) {
      assert.ok(
        typeof fact === 'string' && fact.length > 0,
        `the requirement map must record the ${label}`,
      );
      assert.ok(
        REPORT.includes(fact as string),
        `the report must cite the ${label} verbatim so a reader can verify it: ` +
          JSON.stringify((fact as string).slice(0, 60)),
      );
    }
    // The honest limit of the citation: neither DOCX contains R4.
    assert.ok(
      /neither document contains the word R4|not a section of either DOCX/i.test(REPORT),
      'the report must state plainly that R3/R4 are order text, not DOCX sections',
    );
  });

  test('the report is about the revision being delivered, and does not claim an unmeasured CI run', () => {
    assert.ok(/^# FBL-020 .*R4/m.test(REPORT), 'the report heading must name the revision R4');
    assert.ok(
      REPORT.includes('NO CI RUN EXISTS FOR THIS TREE'),
      'with nothing pushed, the report must say so rather than filling in a stale run',
    );
    // Every workflow run id the report mentions must be attributed to the revision it
    // belongs to. R3's report is where a run id for one tree was presented as evidence
    // for another; an unqualified id is the shape of that mistake.
    for (const m of REPORT.matchAll(/run `(\d+)`/g)) {
      const at = m.index ?? 0;
      const around = REPORT.slice(Math.max(0, at - 300), at + 300);
      assert.ok(
        /\bR2\b|\bR3\b|superseded/.test(around),
        `run ${m[1]} is cited without saying which revision it measured`,
      );
    }
  });

  test('a NOT DISCHARGED gate is never filed as residual risk', () => {
    // Two DIFFERENT things, and R3 was rejected for conflating them: a mandatory gate
    // that has not been discharged is not a risk somebody may accept, it is work that
    // has not been done.
    const undischarged = section(REPORT, 'NOT DISCHARGED');
    assert.ok(
      undischarged.includes(LIVE_GATE_PHRASE),
      'the undischarged-gate section must name the live certification gate',
    );

    const residual = section(REPORT, 'Residual risk');
    const offenders = [...residual.matchAll(/NOT DISCHARGED|BLOCKED|Gate B\b/g)].map((m) => m[0]);
    assert.deepEqual(
      offenders,
      [],
      `the residual-risk section must not file undischarged gates: ${offenders.join(', ')}`,
    );
  });

  test('the adapter claim is precise: mocked invocation exists, LIVE WorkOS behaviour does not', () => {
    /*
     * The FALSE claim, in both documents that carried it. The phrase is permitted ONLY
     * where the document is quoting it in order to correct it — checked by requiring
     * "wrong" nearby — because deleting the history of a corrected claim is its own kind
     * of dishonesty, and a reader holding the R3 document needs to find the correction.
     */
    for (const [name, doc] of [
      ['the delivery report', REPORT],
      ['known-limitations', LIMITS],
    ] as const) {
      for (const m of doc.matchAll(/no test invokes/gi) as IterableIterator<RegExpMatchArray>) {
        const at = m.index ?? 0;
        const around = doc.slice(Math.max(0, at - 200), at + 300);
        assert.ok(
          /\bwrong\b/i.test(around),
          `${name} asserts "no test invokes" without correcting it, and that is not true`,
        );
      }
    }

    // The TRUE claim, checked against the test that makes it true — so the sentence
    // cannot outlive the test it describes.
    const adapterTest = read('tests', 'identity-config.test.ts');
    assert.ok(
      adapterTest.includes('createWorkosProvider('),
      'sanity: the adapter really is constructed in tests/identity-config.test.ts',
    );
    assert.ok(
      adapterTest.includes('provider.refreshSession('),
      'sanity: and a real adapter method really is called',
    );
    for (const [name, doc] of [
      ['the delivery report', REPORT],
      ['known-limitations', LIMITS],
    ] as const) {
      assert.ok(
        doc.includes('tests/identity-config.test.ts'),
        `${name} must name the battery that invokes the adapter`,
      );
      assert.ok(
        /MOCKED transport|substituted `fetch`|mocked transport/i.test(doc),
        `${name} must say the invocation is over a mocked transport`,
      );
      assert.ok(
        doc.includes(LIVE_GATE_PHRASE),
        `${name} must state what remains untested in the agreed words`,
      );
    }
  });

  test('every figure the report pins is pinned to a named CI artifact', () => {
    // Any artifact filename the report cites must be one the workflow actually
    // produces. A report that pins a figure to an artifact nobody uploads is pinned to
    // nothing. Repository files that happen to end in .json — `package.json`,
    // `quality-baselines.json` — are excluded by checking the tree, not by a hand-kept
    // allowlist that would itself go stale.
    const cited = new Set(
      [...REPORT.matchAll(/`([a-z0-9][a-z0-9._-]*\.(?:json|txt|log|sarif))`/g)]
        .map((m) => m[1] as string)
        .filter((f) => !existsSync(join(ROOT, f))),
    );
    assert.ok(cited.size >= 8, `the report must pin its figures to artifacts, found ${cited.size}`);
    const missing = [...cited].filter((f) => !WORKFLOW.includes(f)).sort();
    assert.deepEqual(
      missing,
      [],
      `artifacts cited by the report that ci.yml never produces: ${missing.join(', ')}`,
    );
  });

  test('the report names every migration on disk and every R4 test file', () => {
    const migrations = readdirSync(join(ROOT, 'migrations')).filter((f) => f.endsWith('.sql'));
    assert.ok(migrations.length >= 10, 'sanity: the migration chain is not empty');
    const unnamed = migrations.filter((m) => !REPORT.includes(m)).sort();
    assert.deepEqual(unnamed, [], `migrations absent from the report: ${unnamed.join(', ')}`);

    // Every battery the requirement map claims must also be visible in the report, so
    // the two documents cannot describe different deliveries.
    const claimed = new Set(
      loadRequirementMap().requirements.flatMap((r) => r.tests.map((t) => t.file)),
    );
    const absent = [...claimed].filter((f) => !REPORT.includes(f)).sort();
    assert.deepEqual(
      absent,
      [],
      `test files in the map but not in the report: ${absent.join(', ')}`,
    );
  });

  test('known-limitations, the runbooks and the README agree that live certification is BLOCKED', () => {
    for (const [name, doc] of [
      ['the delivery report', REPORT],
      ['known-limitations', LIMITS],
      ['the WorkOS operator runbook', WORKOS_RUNBOOK],
      ['the tenant bootstrap runbook', TENANT_RUNBOOK],
      ['the README', README],
    ] as const) {
      assert.ok(
        doc.includes(LIVE_GATE_PHRASE),
        `${name} must carry the exact phrase "${LIVE_GATE_PHRASE}" — one wording, five documents`,
      );
    }
  });

  test('the runbooks document the operator steps R4 changed', () => {
    // Each of these is a procedure an operator would get WRONG from the R3 runbooks,
    // because the behaviour changed under them.
    for (const required of [
      'mfa_policy_certification_expires_at',
      'mfa_policy_certification_revoked_at',
      'checksum_sha256',
      'expired_at',
    ]) {
      assert.ok(
        WORKOS_RUNBOOK.includes(required),
        `the WorkOS runbook must tell the operator about ${required}`,
      );
    }
    for (const required of ['activated', 'pending']) {
      assert.ok(
        TENANT_RUNBOOK.includes(required),
        `the bootstrap runbook must explain link ${required} status`,
      );
    }
    // The R4 correction an operator most needs: a bound link is not an activated one.
    assert.ok(
      /binding is provenance|bound.*not.*activated|provenance, not authority/i.test(TENANT_RUNBOOK),
      'the bootstrap runbook must warn that a BOUND link is not an authorized one',
    );
  });

  test('the README points at the populated upgrade drill and the requirement map', () => {
    for (const path of [
      'docs/FBL-020-R4-REQUIREMENT-MAP.json',
      'tests/fixtures/legacy-identity-seed-pre-057.sql',
      'scripts/upgrade-negative-controls.ts',
      'scripts/mutation-kill.ts',
      'scripts/verify-upgrade-state.ts',
    ]) {
      assert.ok(README.includes(path), `the README must point a newcomer at ${path}`);
    }
  });
});
