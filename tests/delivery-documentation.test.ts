import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { loadRequirementMap, type BlueprintFacts } from '../scripts/check-requirement-map';
import { docxHeadings, docxLines, fileBytes, fileSha256 } from '../scripts/docx-text';
import {
  BLOCK_END,
  BLOCK_START,
  CENSUS,
  POSITION_BEARING_ROWS,
  positionBlock,
  proseProblems,
  readCensusClaim,
  type CensusClaim,
  type MapRow,
} from '../scripts/check-census-prose';
import { BRANCH_SENTENCE } from '../scripts/migration-census';
import {
  FIGURES,
  GOVERNED,
  HISTORICAL_START,
  REPORT as REPORT_PATH,
  UNCHECKABLE,
  figureProblems,
  readFigures,
} from '../scripts/check-published-figures';

/**
 * FBL-020-R5 §3 — THE DOCUMENTATION TESTS INSPECT THE DELIVERY DOCUMENTS, AND THE
 * DOCUMENT THE REVIEWER ACTUALLY HOLDS.
 *
 * `tests/docs.test.ts` compares the PHASE-248 architecture reference against the code it
 * describes, which is worth having and is kept. It is not a check on the DELIVERY
 * documents, and R3 shipped with that gap: the report cited a governing document section
 * nobody had opened, claimed a local prose exercise as a CI gate, said "no test invokes" an
 * adapter that a test does invoke, and filed a mandatory undischarged gate under "residual
 * risk".
 *
 * R4 answered that with a battery that read the report — but it checked the report's
 * citation against a FACT SET IN ANOTHER FILE WE WROTE (the requirement map). Two of our
 * own documents can be wrong together, and they were: the recorded citation was ambiguous
 * between two blueprints whose §14.3 are DIFFERENT ORDERS — Version 1.0 reads FBL-000
 * there, Version 2.0 reads FBL-020-R2 — and nothing could see it.
 *
 * So §3.4 requires the anchor to be the document itself. `docs/orders/` holds the
 * blueprint a reviewer of this project actually has — the Version 1.0 document — and the
 * first two tests below read its BYTES: digest, byte length, title lines, version line and
 * §14 headings. The governing Version 2.0 document is NOT in this repository and is not
 * part of the project record; the record says so, and the test verifies it the moment a
 * file appears at its declared path, so attaching the wrong file fails rather than passing.
 *
 * The remaining tests hold the delivery documents to ONE current state (§3.3), to the
 * checked-in order text (§3.2), to the requirement map's clause inventory (§3.5), and to
 * each other (§3.6).
 */

const ROOT = join(__dirname, '..');
const read = (...p: string[]): string => readFileSync(join(ROOT, ...p), 'utf8');

const REPORT = read('docs', 'FBL-020-DELIVERY-REPORT.md');
const PROVENANCE = read('docs', 'orders', 'BLUEPRINT-PROVENANCE.md');
const ORDER = read('docs', 'orders', 'FBL-020-R5.md');
const LIMITS = read('docs', 'identity', 'KNOWN-LIMITATIONS.md');
const README = read('README.md');
const WORKOS_RUNBOOK = read('docs', 'runbooks', 'WORKOS-OPERATOR-RUNBOOK.md');
const TENANT_RUNBOOK = read('docs', 'runbooks', 'TENANT-BOOTSTRAP-RUNBOOK.md');
const WORKFLOW = read('.github', 'workflows', 'ci.yml');

/** The one phrase every delivery document must use for the undischarged live gate. */
const LIVE_GATE_PHRASE = 'LIVE WORKOS CERTIFICATION IS NOT DISCHARGED';

/** The two mutually exclusive statements the report may make about CI. */
const CI_NO_RUN = 'NO CI RUN EXISTS FOR THIS TREE';
const CI_DISCHARGED = /THE R5 CI GATE IS DISCHARGED/;

/** The two mutually exclusive statements the report may make about the commit. */
const COMMIT_NONE = 'NOTHING IS COMMITTED AND NOTHING IS PUSHED';
const COMMIT_MADE = /R5 CODE-BEARING COMMIT: `[0-9a-f]{40}`/;

/** The census is a report, not a ratification, and the report must keep saying so. */
const CENSUS_PHRASE = 'THE R5 §0 CENSUS IS REPORTED, NOT ACCEPTED';

/**
 * Sentences R4 shipped that were not true of the repository. They are BANNED outright
 * rather than permitted-with-a-correction-nearby: the corrections are described in the
 * report in different words, so no delivery document needs to carry the false sentence in
 * order to withdraw it, and a future revision cannot reintroduce one by writing the word
 * "corrected" beside it.
 */
const BANNED_CLAIMS = [
  'IN HAND AND VERIFIED',
  'The R4 CI gate is DISCHARGED',
  'NOW DISCHARGED',
  "the architect's §0 census",
  'R4 is an uncommitted working tree',
] as const;

/** The nine documents §3.6 requires to be reconciled with one another. */
const RECONCILED_DOCUMENTS: Array<[string, string]> = [
  ['README.md', 'README.md'],
  ['ADR-001', join('docs', 'adr', 'ADR-001-modular-monolith.md')],
  ['AUTH-FLOWS', join('docs', 'identity', 'AUTH-FLOWS.md')],
  ['KNOWN-LIMITATIONS', join('docs', 'identity', 'KNOWN-LIMITATIONS.md')],
  ['DATA-DICTIONARY', join('docs', 'identity', 'DATA-DICTIONARY.md')],
  ['the threat model', join('docs', 'architecture', 'THREAT-MODEL-DELTA-FBL-020.md')],
  ['MODULE-OWNERSHIP', join('docs', 'architecture', 'MODULE-OWNERSHIP.md')],
  ['the delivery report', join('docs', 'FBL-020-DELIVERY-REPORT.md')],
  ['the project-copy provenance record', join('docs', 'orders', 'BLUEPRINT-PROVENANCE.md')],
];

/** Everything between one `## ` heading and the next. */
function section(markdown: string, headingContains: string): string {
  const lines = markdown.split('\n');
  const start = lines.findIndex((l) => l.startsWith('## ') && l.includes(headingContains));
  assert.notEqual(start, -1, `the document must carry a "## …${headingContains}…" section`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith('## '));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

/** Every `## ` section of a document, as `[heading, body]`. */
function sections(markdown: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  let heading = '(preamble)';
  let body: string[] = [];
  for (const line of markdown.split('\n')) {
    if (line.startsWith('## ')) {
      out.push([heading, body.join('\n')]);
      heading = line;
      body = [];
    } else {
      body.push(line);
    }
  }
  out.push([heading, body.join('\n')]);
  return out;
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** Every markdown document that could cite the blueprint. */
function deliveryDocuments(): Array<[string, string]> {
  const docs: Array<[string, string]> = [['README.md', README]];
  const walk = (...rel: string[]): void => {
    for (const entry of readdirSync(join(ROOT, ...rel))) {
      if (entry.endsWith('.md')) docs.push([[...rel, entry].join('/'), read(...rel, entry)]);
      else if (!entry.includes('.')) walk(...rel, entry);
    }
  };
  walk('docs');
  return docs;
}

describe('the supplied blueprint, and the one that is absent (FBL-020-R5 §3.1/§3.4)', () => {
  test('the SUPPLIED blueprint in this repository is the document the record describes', () => {
    const facts: BlueprintFacts = loadRequirementMap().governing_document.superseded;
    assert.equal(
      facts.present_in_repository,
      true,
      'the superseded document is the one a reviewer holds; it must be in the repository',
    );
    const path = join(ROOT, facts.repository_path);
    assert.ok(existsSync(path), `${facts.repository_path} must be committed`);

    /*
     * THE ANCHOR. Every one of these comes from the file's own bytes, so the recorded fact
     * set cannot drift from the document — which is exactly what R4's self-referential
     * version could not catch.
     */
    assert.equal(fileSha256(path), facts.file_sha256, 'the digest of the supplied document');
    assert.equal(fileBytes(path), facts.bytes, 'the byte length of the supplied document');

    const lines = docxLines(path);
    for (const [label, value] of [
      ['title, first line', facts.title_line_1],
      ['title, second line', facts.title_line_2],
      ['version line', facts.version_line],
    ] as const) {
      assert.ok(
        lines.includes(value),
        `the ${label} recorded for the supplied document is not a paragraph of it: ${JSON.stringify(value)}`,
      );
    }

    // …and the §14 headings, which are the whole point: this Version 1.0 document's
    // §14.3 is FBL-000.
    const headings = new Map<string, string>();
    for (const h of docxHeadings(path)) {
      const number = /^(\d+\.\d+)\s/.exec(h.text)?.[1];
      if (number !== undefined) headings.set(number, h.text);
    }
    assert.ok(headings.size > 20, `sanity: only ${headings.size} numbered headings were read`);
    for (const [number, expected] of Object.entries(facts.section_14_headings)) {
      assert.equal(headings.get(number), expected, `§${number} of the supplied document`);
    }
    assert.match(
      facts.section_14_headings['14.3'] ?? '',
      /FBL-000/,
      'the Version 1.0 §14.3 a reviewer holds is FBL-000 — which is why a bare section number is ambiguous',
    );
    assert.match(
      facts.section_14_headings[facts.section_governing_fbl_020] ?? '',
      /FBL-020/,
      'and FBL-020 is at the section this record names',
    );

    /*
     * The quality ceilings are the one requirement this delivery is held to that a reader
     * of THIS document cannot verify: the word never appears in it. The provenance record
     * says so, and this is the assertion that keeps that statement honest.
     */
    assert.equal(
      lines.some((l) => /ceiling/i.test(l)),
      false,
      'the supplied document mentions no ceiling — if that changes, BLUEPRINT-PROVENANCE.md must change with it',
    );
    assert.ok(
      /Version 1\.0[\s\S]{0,4000}?quality ceilings|ceilings[\s\S]{0,600}?not readable in Version 1\.0/i.test(
        PROVENANCE,
      ),
      'the provenance record must say the ceilings are not readable in the reviewer copy',
    );
  });

  test('the GOVERNING blueprint is recorded as ABSENT, and is verified the moment it is attached', () => {
    const facts: BlueprintFacts = loadRequirementMap().governing_document.governing;
    assert.equal(
      facts.present_in_repository,
      false,
      'the governing document is not part of the project record and must not be recorded as if it were',
    );
    assert.equal(
      facts.verification,
      'attested-not-in-repository',
      'its facts are an attestation transcribed from the order, and must be labelled as one',
    );
    assert.ok(
      typeof facts.attested_by === 'string' && facts.attested_by.includes('FBL-020-R5.md'),
      'the attestation must name where it comes from',
    );
    for (const [name, doc] of [
      ['the provenance record', PROVENANCE],
      ['the delivery report', REPORT],
    ] as const) {
      assert.ok(
        /NOT in this repository|not in the project record|is NOT in this repository/i.test(doc),
        `${name} must state plainly that the governing document is not in the project record`,
      );
    }

    // If it is ever attached, it is verified — the record cannot describe a different file.
    const path = join(ROOT, facts.repository_path);
    if (!existsSync(path)) return;
    assert.equal(fileSha256(path), facts.file_sha256, 'the attached governing document');
    assert.equal(fileBytes(path), facts.bytes, 'the attached governing document byte length');
    const lines = docxLines(path);
    assert.ok(lines.includes(facts.version_line), 'its version line');
    const headings = docxHeadings(path).map((h) => h.text);
    for (const expected of Object.values(facts.section_14_headings)) {
      assert.ok(headings.includes(expected), `§14 heading: ${expected}`);
    }
  });

  test('every blueprint citation in the delivery documents names its version, file or digest', () => {
    /*
     * The R3 defect, made mechanical. "§14.3" alone names FBL-000 in the Version 1.0
     * document the reviewer holds and FBL-020-R2 in the Version 2.0 governing one. A citation is only a citation if
     * the reader can tell which document it means, so every occurrence must carry a version
     * label, a file name or a digest within the same neighbourhood.
     */
    const facts = loadRequirementMap().governing_document;
    const qualifiers = [
      'Version 1.0',
      'Version 2.0',
      'v1.0',
      'v2.0',
      facts.governing.file,
      facts.superseded.file,
      facts.governing.file_sha256.slice(0, 8),
      facts.superseded.file_sha256.slice(0, 8),
    ];
    const unqualified: string[] = [];
    for (const [name, doc] of deliveryDocuments()) {
      for (const m of doc.matchAll(/§14\.\d/g)) {
        const at = m.index ?? 0;
        const around = doc.slice(Math.max(0, at - 400), at + 400);
        if (!qualifiers.some((q) => around.includes(q))) {
          unqualified.push(`${name}: ${m[0]} at offset ${at}`);
        }
      }
    }
    assert.deepEqual(
      unqualified,
      [],
      `blueprint sections cited without saying WHICH document:\n${unqualified.join('\n')}`,
    );
  });

  test('the ambiguous citations left in source are DECLARED, in both directions', () => {
    // The documents are held to the rule above. Source comments and the migration header
    // are not editable at no cost — `057`'s digest is pinned in several places — so those
    // files are declared instead, and `scripts/check-requirement-map.ts` fails if a file
    // appears that is not declared or a declaration names a file that no longer cites one.
    const declared = loadRequirementMap().governing_document.bare_blueprint_citation_residue;
    assert.ok(declared.length > 0, 'the residue must be enumerated, not implied');
    for (const file of declared) {
      assert.ok(existsSync(join(ROOT, file)), `${file} is declared but does not exist`);
      assert.match(read(...file.split('/')), /§14\.\d/, `${file} is declared but cites no section`);
      assert.ok(
        LIMITS.includes(file),
        `${file} is declared in the map but not disclosed in KNOWN-LIMITATIONS.md`,
      );
    }
  });
});

describe('the delivery documentation describes THIS delivery (FBL-020-R5 §3.2/§3.3/§3.5/§3.6)', () => {
  test('the R5 order text is checked in, and the report and the map point at it', () => {
    const map = loadRequirementMap();
    assert.equal(map.authority.order_text, 'docs/orders/FBL-020-R5.md');
    /*
     * The order text is transcribed, not summarised: these are the ORDER'S own words, one
     * from each part of it, so a file carrying only some of the order would fail here.
     *
     * WHAT THIS LIST USED TO BE, AND WHY IT CHANGED. It previously required the phrases
     * `ARCHITECT ORDER FBL-020-R5`, `*** THE STANDARD ON CLAIMS ***`,
     * `The 459-test / 47-suite floor MAY NOT SHRINK`,
     * `Ceilings are 59/136/23 per the governing blueprint` and `DO NOT COMMIT. DO NOT PUSH.`
     * — every one of which is a phrase from the IMPLEMENTATION PROMPT, not from the order.
     * The wave that first wrote `docs/orders/FBL-020-R5.md` had been handed the prompt and
     * recorded it as the verbatim order, so this battery pinned the order file to the wrong
     * document and would have gone on passing on that mistake. The order file now holds the
     * order, and the phrases below are drawn from its §0, §1, §2, §4, §5 and Appendix A.
     */
    for (const verbatim of [
      'FBL-020-R5 is the only active implementation order. FBL-030 remains unauthorized.',
      'Repeat the persistent-environment census and return its machine-readable evidence.',
      'Route every callback carrying a valid sealed transaction handle through the',
      'Version-2 PolicyDecision evidence must be relationally coherent, not merely non-null.',
      'The existing 459-test/47-suite floor may not shrink.',
      'Use at most one code-bearing commit and one optional documentation-only closeout commit.',
      'Stop at the gate.',
      'FBL-020-R5: ACTIVE — IN PROGRESS — RED — NOT SUBMITTED',
    ]) {
      assert.ok(ORDER.includes(verbatim), `the order text must carry, verbatim: ${verbatim}`);
    }
    // …and it states its own limits rather than implying it is beyond question.
    assert.ok(
      ORDER.includes('What this repository cannot establish'),
      'the order file must state what it cannot settle about its own authority',
    );
    /*
     * And no clause may still be REGISTERED as text this repository does not hold. That
     * marking was the artefact of routing the order to the waves one section at a time; a
     * battery that did not check for its removal would let it come back.
     *
     * The check reads the register's own rows — `| §1.5 | … | yes |` — rather than
     * searching the prose, because the file's provenance note quotes the withdrawn claim
     * in order to withdraw it, and a prose search would fire on the correction itself.
     */
    const registerRows = [...ORDER.matchAll(/^\|\s*(§\d+(?:\.\d+)?)\s*\|.*\|\s*(\S+)\s*\|\s*$/gm)];
    assert.ok(
      registerRows.length >= 20,
      `the order's clause register lists ${registerRows.length}`,
    );
    const unheld = registerRows.filter((m) => (m[2] as string).toLowerCase() !== 'yes');
    assert.deepEqual(
      unheld.map((m) => m[1]),
      [],
      'every clause of the order file must be registered as held verbatim',
    );
    for (const [name, doc] of [
      ['the delivery report', REPORT],
      ['the README', README],
      ['known-limitations', LIMITS],
    ] as const) {
      assert.ok(doc.includes('docs/orders/FBL-020-R5.md'), `${name} must point at the order text`);
    }
  });

  test('the report declares ONE state for CI, for the commit, and for the census', () => {
    assert.ok(/^# FBL-020 .*R5/m.test(REPORT), 'the report heading must name the revision R5');

    /*
     * §3.3. The R4 report claimed the CI gate DISCHARGED in its opening paragraph and "no
     * CI run exists for this tree" in §0.7, and listed the run as both struck-through-and-
     * discharged and NOT DISCHARGED. Both individual states are legal; holding two at once
     * is not, and neither is holding neither.
     */
    const noRun = REPORT.includes(CI_NO_RUN);
    const discharged = CI_DISCHARGED.test(REPORT);
    assert.ok(
      noRun !== discharged,
      `the report must declare either "${CI_NO_RUN}" or that the R5 CI gate is discharged — exactly one`,
    );
    if (noRun) assert.equal(occurrences(REPORT, CI_NO_RUN), 1, 'and it must say so exactly once');
    if (discharged) {
      assert.match(
        REPORT,
        /head_sha` equals commit\?\s*\|\s*\*\*YES\*\*/,
        'a discharged CI gate must state that head_sha equals the code-bearing commit',
      );
      assert.match(
        REPORT,
        /\.github\/workflows\/ci\.yml/,
        'a discharged CI gate must name the workflow it was measured on',
      );
      assert.match(
        REPORT,
        /Jobs \/ non-success\s*\|\s*\*\*\d+ \/ 0\*\*/,
        'a discharged CI gate must report per-job conclusions, not only the run-level one',
      );
    }

    const uncommitted = REPORT.includes(COMMIT_NONE);
    const committed = COMMIT_MADE.test(REPORT);
    assert.ok(
      uncommitted !== committed,
      `the report must declare either "${COMMIT_NONE}" or name a 40-character code-bearing commit — exactly one`,
    );
    if (uncommitted) {
      assert.equal(occurrences(REPORT, COMMIT_NONE), 1, 'the commit state is stated exactly once');
      assert.equal(noRun, true, 'a tree with nothing pushed cannot also have a CI run of its own');
    }

    assert.ok(REPORT.includes(CENSUS_PHRASE), `the report must carry: ${CENSUS_PHRASE}`);
  });

  /*
   * ── FBL-020-R5 gate finding G5 ─────────────────────────────────────────────────
   *
   * `artifacts/migration-census.json` concluded FREEZE 057; this report and the
   * requirement map both asserted the opposite; and 057 was edited in place with no 058.
   * Every gate was green, because no gate compared the artifact with the prose about it.
   *
   * This is that gate. It runs against the REAL artifact when one is present — CI takes
   * its own census before the suite, so there always is one there — and it drives the
   * comparison against staged texts in both directions, which is what proves it can fail.
   */
  test('the delivery documents assert the census position the ARTIFACT carries, and no other', () => {
    const mapDoc = JSON.parse(read('docs', 'FBL-020-R5-REQUIREMENT-MAP.json')) as {
      requirements?: MapRow[];
    };

    // 1. As shipped, against the real artifact, when the census has been taken.
    if (existsSync(CENSUS)) {
      const real = readCensusClaim();
      assert.deepEqual(
        proseProblems(real, REPORT, mapDoc),
        [],
        'the report and the map must state exactly what the census artifact concluded',
      );
      assert.equal(
        real.branch_sentence,
        BRANCH_SENTENCE[real.position],
        "the artifact's branch sentence must be the one its own position defines",
      );
    }

    // 2. THE REVERT PROOF. Flip the artifact's verdict and leave the prose alone: the
    //    gate must fail, naming the disagreement. This is the exact R5 situation.
    const flipped: CensusClaim = {
      position: 'FREEZE_057_AND_ADD_058',
      branch_sentence: BRANCH_SENTENCE.FREEZE_057_AND_ADD_058,
    };
    const whenArtifactSaysFreeze = proseProblems(flipped, REPORT, mapDoc);
    assert.ok(
      whenArtifactSaysFreeze.some((p) => p.includes('does not name FREEZE_057_AND_ADD_058')),
      `a census concluding FREEZE against prose saying otherwise must fail: ${whenArtifactSaysFreeze.join('; ')}`,
    );
    for (const id of POSITION_BEARING_ROWS)
      assert.ok(
        whenArtifactSaysFreeze.some((p) => p.includes(id) && p.includes('census_position')),
        `${id} must be reported as disagreeing with the artifact`,
      );

    // 3. And the other direction: flip the PROSE and leave the artifact alone.
    const shipped: CensusClaim = {
      position: 'EDIT_057_IN_PLACE',
      branch_sentence: BRANCH_SENTENCE.EDIT_057_IN_PLACE,
    };
    const flippedReport = REPORT.replace('**EDIT_057_IN_PLACE.**', '**FREEZE_057_AND_ADD_058.**');
    assert.notEqual(flippedReport, REPORT, 'the report must state its position in one place');
    assert.ok(
      proseProblems(shipped, flippedReport, mapDoc).some((p) =>
        p.includes('asserts FREEZE_057_AND_ADD_058'),
      ),
      'a report asserting the branch the artifact did not take must fail',
    );

    const flippedMap = {
      requirements: (mapDoc.requirements ?? []).map((r) =>
        POSITION_BEARING_ROWS.includes(r.id as (typeof POSITION_BEARING_ROWS)[number])
          ? { ...r, census_position: 'FREEZE_057_AND_ADD_058' }
          : r,
      ),
    };
    assert.ok(
      proseProblems(shipped, REPORT, flippedMap).some((p) =>
        p.includes('declares census_position FREEZE_057_AND_ADD_058'),
      ),
      'a requirement-map row asserting the other branch must fail',
    );

    // 4. A report that states no position at all is refused — silence is not agreement.
    const silent = REPORT.replace(BLOCK_START, '').replace(BLOCK_END, '');
    assert.ok(
      proseProblems(shipped, silent, mapDoc).some((p) => p.includes('carries no')),
      'a report with no census-position block must fail',
    );
    assert.notEqual(positionBlock(REPORT), undefined, 'the shipped report has the block');
    assert.equal(positionBlock(silent), undefined);

    // 5. A row that declares no position is refused for the same reason.
    const undeclared = {
      requirements: (mapDoc.requirements ?? []).map((r) => {
        const rest: MapRow = { ...r };
        delete rest.census_position;
        return rest;
      }),
    };
    assert.ok(
      proseProblems(shipped, REPORT, undeclared).some((p) =>
        p.includes('declares no census_position'),
      ),
    );

    // 6. The block must QUOTE the artifact, not merely agree with its token.
    const unquoted = REPORT.replace(
      'NO PERSISTENT ENVIRONMENT HAS APPLIED ANY FORM OF 057, on the evidence above.',
      'No persistent environment has applied 057, roughly speaking.',
    );
    assert.notEqual(unquoted, REPORT);
    assert.ok(
      proseProblems(shipped, unquoted, mapDoc).some((p) => p.includes('branch sentence')),
      "a paraphrase is not the artifact's own words",
    );
  });

  test('the census-prose gate is wired into CI', () => {
    assert.match(
      WORKFLOW,
      /scripts\/check-census-prose\.ts/,
      'the gate that compares the census artifact with the prose must run in CI',
    );
  });

  test('CI evidence for a superseded revision is labelled HISTORICAL, in its own heading', () => {
    /*
     * The R4 report kept two CI sections, one per revision, and a reader had to work out
     * from the prose which tree each described. Artifact digests are the sharpest case: a
     * zip digest is a fact about one run, and the R4 packet published digests belonging to
     * an earlier commit as though they were the final head's. So any section carrying one
     * must say HISTORICAL in its heading.
     */
    const offenders: string[] = [];
    for (const [heading, body] of sections(REPORT)) {
      const carriesRunEvidence = /downloaded zip|CI run id/i.test(body);
      if (carriesRunEvidence && !heading.includes('HISTORICAL')) offenders.push(heading);
    }
    assert.deepEqual(
      offenders,
      [],
      `sections carrying another revision's run evidence without a HISTORICAL heading: ${offenders.join(' | ')}`,
    );

    // Every workflow run id must still say which revision it measured.
    for (const m of REPORT.matchAll(/run `(\d+)`/g)) {
      const at = m.index ?? 0;
      const around = REPORT.slice(Math.max(0, at - 300), at + 300);
      assert.ok(
        /\bR2\b|\bR3\b|\bR4\b|superseded|HISTORICAL|Dependabot/.test(around),
        `run ${m[1]} is cited without saying which revision it measured`,
      );
    }
  });

  test('no withdrawn R4 claim survives anywhere in the delivery documents', () => {
    const offenders: string[] = [];
    for (const [name, doc] of deliveryDocuments()) {
      for (const claim of BANNED_CLAIMS) {
        // The order text is a verbatim transcription of the order and is exempt by
        // construction; it quotes nothing from the R4 report.
        if (name.endsWith('FBL-020-R5.md')) continue;
        if (doc.includes(claim)) offenders.push(`${name}: ${claim}`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `claims R4 was rejected for, still present:\n${offenders.join('\n')}`,
    );
  });

  test('a NOT DISCHARGED gate is never filed as residual risk', () => {
    // Two DIFFERENT things, and R3 was rejected for conflating them: a mandatory gate that
    // has not been discharged is not a risk somebody may accept, it is work not done.
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

  test('the report accounts for every clause the requirement map declares', () => {
    /*
     * §3.5 in the other direction. The map's inventory is checked against the order text by
     * `scripts/check-requirement-map.ts`; here the REPORT is checked against the inventory,
     * so a clause cannot be delivered, mapped and then left out of the document a reviewer
     * reads.
     */
    const map = loadRequirementMap();
    assert.ok(map.clause_inventory.length >= 10, 'the inventory must be more than a token');
    const missing = map.clause_inventory
      .filter((c) => !REPORT.includes(c.clause))
      .map((c) => c.clause);
    assert.deepEqual(missing, [], `clauses in the map but absent from the report: ${missing}`);

    const ids = map.requirements.filter((r) => r.revision === 'FBL-020-R5').map((r) => r.id);
    assert.ok(ids.length >= 10, `only ${ids.length} R5 requirements are mapped`);
    const unnamed = ids.filter((id) => !REPORT.includes(id));
    assert.deepEqual(unnamed, [], `R5 requirement ids absent from the report: ${unnamed}`);
  });

  test('the commit discipline is recorded, and the report states what evidence it may quote', () => {
    // §5: one code-bearing commit, an OPTIONAL documentation-only closeout, and any test,
    // script, workflow, requirement-map or source change belongs in the code-bearing one.
    const discipline = section(REPORT, 'Delivery discipline');
    for (const required of [
      'ONE code-bearing commit',
      'documentation-only closeout',
      'requirement map',
    ]) {
      assert.ok(
        discipline.includes(required),
        `the delivery-discipline section must state: ${required}`,
      );
    }
    assert.match(
      discipline,
      /final head|final-head/i,
      'and must say that the evidence it may quote is the final head',
    );
  });

  test('every figure the report pins is pinned to a named CI artifact', () => {
    // Any artifact filename the report cites must be one the workflow actually produces. A
    // report that pins a figure to an artifact nobody uploads is pinned to nothing.
    // Repository files that happen to end in .json are excluded by checking the tree.
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

  test('the report names every migration on disk and every mapped battery', () => {
    const migrations = readdirSync(join(ROOT, 'migrations')).filter((f) => f.endsWith('.sql'));
    assert.ok(migrations.length >= 10, 'sanity: the migration chain is not empty');
    const unnamed = migrations.filter((m) => !REPORT.includes(m)).sort();
    assert.deepEqual(unnamed, [], `migrations absent from the report: ${unnamed.join(', ')}`);

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

  test('the nine documents §3.6 names exist and all speak of this revision', () => {
    for (const [name, path] of RECONCILED_DOCUMENTS) {
      const full = join(ROOT, path);
      assert.ok(existsSync(full), `${name} (${path}) must exist`);
      const doc = readFileSync(full, 'utf8');
      assert.ok(
        doc.includes('FBL-020-R5'),
        `${name} must have been brought forward to FBL-020-R5 rather than left describing an earlier revision`,
      );
    }
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

  test('the adapter claim is precise: mocked invocation exists, LIVE WorkOS behaviour does not', () => {
    /*
     * The FALSE claim, in both documents that carried it. The phrase is permitted ONLY where
     * the document is quoting it in order to correct it — checked by requiring "wrong"
     * nearby — because deleting the history of a corrected claim is its own kind of
     * dishonesty, and a reader holding the R3 document needs to find the correction.
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

    // The TRUE claim, checked against the test that makes it true.
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

  test('the runbooks document the operator steps this delivery changed', () => {
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
    assert.ok(
      /binding is provenance|bound.*not.*activated|provenance, not authority/i.test(TENANT_RUNBOOK),
      'the bootstrap runbook must warn that a BOUND link is not an authorized one',
    );
  });

  test('the README points a newcomer at the order, the map and the upgrade drill', () => {
    for (const path of [
      'docs/orders/FBL-020-R5.md',
      'docs/orders/BLUEPRINT-PROVENANCE.md',
      'docs/FBL-020-R5-REQUIREMENT-MAP.json',
      'tests/fixtures/legacy-identity-seed-pre-057.sql',
      'scripts/upgrade-negative-controls.ts',
      'scripts/mutation-kill.ts',
      'scripts/verify-upgrade-state.ts',
    ]) {
      assert.ok(README.includes(path), `the README must point a newcomer at ${path}`);
    }
  });
});

/**
 * FBL-020-R5 §3.3 — THE STALE-FIGURE CLASS, CLOSED RATHER THAN THE INSTANCES.
 *
 * Four figures shipped at two values each, because the prose was written by hand while
 * the runs that produce those numbers were still moving: the suite total (567 in the
 * report, 554 in the map), the mutation registry (44 declared / 44 killed / 0 survived in
 * the artifact, "the last complete run covered 34" in both documents), `MINIMUM_TESTS`
 * (554 in the map, 567 in the source), and the size of THIS battery (18 in the report,
 * 20 on disk). Every gate was green each time; nothing compared a published number with
 * the thing that produced it.
 *
 * `scripts/check-published-figures.ts` is that comparison, generalised from the census
 * position `scripts/check-census-prose.ts` already pins. The tests below drive it against
 * the real sources AND against staged texts in both directions, because a check that has
 * never been shown to fail is not known to be a check.
 */
describe('published figures derive from their sources (FBL-020-R5 §3.3/§3.6)', () => {
  const documents = (): Record<string, string> => {
    const docs: Record<string, string> = {};
    for (const file of GOVERNED) docs[file] = readFileSync(join(ROOT, file), 'utf8');
    return docs;
  };

  test('every published figure agrees with the artifact or constant that produces it', () => {
    const { values, unreadable } = readFigures();
    const { problems } = figureProblems(values, documents());
    assert.deepEqual(
      problems,
      [],
      `published figures disagree with their sources:\n${problems.join('\n')}`,
    );

    // Every figure whose source is IN THE TREE must always be readable — a registry
    // entry pointing at a constant that no longer exists would silently stop checking.
    for (const figure of FIGURES) {
      const artifactSourced = figure.source.kind === 'json' && figure.source.artifact === true;
      if (artifactSourced) continue;
      assert.equal(
        unreadable[figure.id],
        undefined,
        `${figure.id} is sourced from the tree and must always be readable: ${String(unreadable[figure.id])}`,
      );
    }
  });

  test('a published figure that disagrees with its source is REPORTED, in both directions', () => {
    const docs = documents();
    const { values } = readFigures();

    // 1. THE SOURCE MOVES AND THE PROSE DOES NOT. This is the R5 situation exactly: the
    //    mutation artifact said 44 killed while both documents said the last complete run
    //    covered 34.
    const movedSource = { ...values, mutations_declared: '99' };
    const whenSourceMoves = figureProblems(movedSource, docs).problems;
    assert.ok(
      whenSourceMoves.some((p) => p.includes('mutations_declared') && p.includes('"99"')),
      `a moved mutation figure must be reported: ${whenSourceMoves.join('; ')}`,
    );

    // 2. THE PROSE MOVES AND THE SOURCE DOES NOT — a restatement in a NEW sentence, which
    //    is what makes this a check on the class rather than on the four known instances.
    const invented =
      `${docs[REPORT_PATH] as string}\n\nA later paragraph nobody gated says the runner ` +
      `declared ${Number(values.mutations_declared) - 10} mutations declared.\n`;
    const whenProseInvents = figureProblems(values, { ...docs, [REPORT_PATH]: invented }).problems;
    assert.ok(
      whenProseInvents.some((p) => p.includes('restatement rule mutations-registry')),
      `a restated figure outside any span must be reported: ${whenProseInvents.join('; ')}`,
    );

    // 3. A SPAN THAT PUBLISHES THE WRONG VALUE.
    const wrongSpan = (docs[REPORT_PATH] as string).replace(
      `<!--fig:floor_tests-->${values.floor_tests as string}<!--/fig-->`,
      '<!--fig:floor_tests-->1<!--/fig-->',
    );
    assert.notEqual(wrongSpan, docs[REPORT_PATH], 'the report must publish floor_tests in a span');
    assert.ok(
      figureProblems(values, { ...docs, [REPORT_PATH]: wrongSpan }).problems.some(
        (p) => p.includes('<!--fig:floor_tests-->') && p.includes('publishes "1"'),
      ),
      'a span carrying the wrong value must be reported',
    );

    // 4. A SPAN NAMING NO REGISTERED FIGURE — so the marker cannot be used to launder a
    //    number past the registry.
    const unknownSpan = `${docs[REPORT_PATH] as string}\n<!--fig:not_a_figure-->7<!--/fig-->\n`;
    assert.ok(
      figureProblems(values, { ...docs, [REPORT_PATH]: unknownSpan }).problems.some((p) =>
        p.includes('names no registered figure'),
      ),
    );

    // 5. AN UNCHECKABLE FIGURE PUBLISHED WITHOUT ITS LABEL. The order requires a figure no
    //    gate can check to be labelled as such WHERE IT APPEARS.
    for (const figure of UNCHECKABLE) {
      const file = figure.files[0] as string;
      // Every occurrence, not the first: a document may carry the label in two places and
      // stripping one of them would leave the gate satisfied and prove nothing.
      const unlabelled = (docs[file] as string).split(figure.label).join('x');
      assert.notEqual(unlabelled, docs[file], `${file} must carry the ${figure.id} label`);
      assert.ok(
        figureProblems(values, { ...docs, [file]: unlabelled }).problems.some(
          (p) => p.includes(figure.id) && p.includes('does not carry the label'),
        ),
        `${figure.id} published without its label must be reported`,
      );
    }
  });

  test('two documents cannot publish one figure at two values, artifact or no artifact', () => {
    /*
     * THE HOLE THIS CLOSES WAS THE SHAPE OF THE DEFECT THE GATE WAS BUILT FOR.
     *
     * `artifacts/` is gitignored, so on any tree where the battery has not just been run
     * the five suite figures read as `unreadable`, and the source-comparison limbs SKIP an
     * unreadable figure. While that was true this gate printed "Every published figure
     * agrees with its source" over a delivery report that published the battery total as
     * "572 tests, 59 suites" in its §5 gate table and as 599 in the §5.4 derivation table,
     * the passed count as 572 and 599, and the parser's observed `ok` lines as 631 and 655.
     * Three figures at two values each — the exact class the order sent this wave to close
     * — sitting inside the gate written to close it.
     *
     * Agreement WITH the source and agreement AMONG the publications are therefore separate
     * requirements, and the second needs no artifact: whatever the true value later turns
     * out to be, two documents cannot be stating two different ones now.
     */
    const docs = documents();
    const { values } = readFigures();

    // The real tree must be self-consistent even with every artifact-sourced value removed.
    const noArtifacts = { ...values };
    for (const figure of FIGURES)
      if (figure.source.kind === 'json' && figure.source.artifact === true)
        delete noArtifacts[figure.id];
    assert.ok(
      Object.keys(noArtifacts).length < Object.keys(values).length,
      'the registry must contain artifact-sourced figures for this test to mean anything',
    );
    assert.deepEqual(
      figureProblems(noArtifacts, docs).problems,
      [],
      'the delivery documents must agree with each other with no artifact present at all',
    );

    // Stage the defect that shipped: one more sentence stating the suite total at a value
    // the rest of the documents do not use, with nothing readable to arbitrate.
    const stated = Number(values.suite_tests);
    assert.ok(Number.isFinite(stated), 'suite_tests must be readable to build this fixture');
    const contradicted =
      `${docs[REPORT_PATH] as string}\n\nA later paragraph nobody reconciled: the battery ` +
      `ran ${stated + 27} tests, ${values.suite_suites as string} suites.\n`;
    const problems = figureProblems(noArtifacts, {
      ...docs,
      [REPORT_PATH]: contradicted,
    }).problems;
    assert.ok(
      problems.some(
        (p) =>
          p.includes('suite_tests is published at 2 different values') &&
          p.includes('source is not readable here'),
      ),
      `a figure published at two values with no readable source must be reported: ${problems.join('; ')}`,
    );

    // And the limb must not fire when the source IS readable — there the stronger
    // source comparison already speaks, and two messages for one defect is noise.
    const withSource = figureProblems(values, { ...docs, [REPORT_PATH]: contradicted }).problems;
    assert.ok(
      withSource.some((p) => p.includes('restatement rule suite-totals')),
      'with the artifact present the source comparison must catch it',
    );
    assert.ok(
      !withSource.some((p) => p.includes('different values and its source is not readable')),
      'the mutual-consistency limb must stay silent when the source can arbitrate',
    );
  });

  test('the exemptions the gate allows are declared, bounded and named', () => {
    /*
     * Restatement scanning skips two things, and both are escape hatches, so both are
     * counted here rather than left to grow: the ONE historical block — §9, whose figures
     * belong to R3's and R4's trees on purpose — and the inline `quoted` spans that carry
     * a superseded figure in §10's "claim as it stood" column.
     */
    const { exemptions } = figureProblems(readFigures().values, documents());
    assert.equal(
      exemptions.historical[REPORT_PATH],
      1,
      'the delivery report declares exactly one historical region',
    );
    for (const file of GOVERNED)
      if (file !== REPORT_PATH)
        assert.equal(exemptions.historical[file], 0, `${file} declares no historical region`);

    const report = readFileSync(join(ROOT, REPORT_PATH), 'utf8');
    const blockStart = report.indexOf(HISTORICAL_START);
    assert.ok(blockStart > 0, 'the historical region must exist');
    assert.match(
      report.slice(blockStart, blockStart + 200),
      /## 9\. HISTORICAL RECORD/,
      'the historical region must open at the HISTORICAL RECORD heading and nowhere else',
    );

    const quoted = Object.values(exemptions.quoted).reduce((a, b) => a + b, 0);
    assert.ok(
      quoted <= 12,
      `${quoted} inline quoted figures exist; the withdrawal table is the only place for them`,
    );
  });

  test('the stale-figure gate is wired into CI, after the runs that produce its artifacts', () => {
    assert.match(
      WORKFLOW,
      /scripts\/check-published-figures\.ts/,
      'the gate that compares published figures with their sources must run in CI',
    );
    const gate = WORKFLOW.indexOf('scripts/check-published-figures.ts');
    for (const earlier of ['scripts/parse-test-summary.ts', 'scripts/mutation-kill.ts']) {
      const at = WORKFLOW.indexOf(earlier);
      assert.ok(
        at !== -1 && at < gate,
        `${earlier} must run BEFORE the figure gate, or its artifact is not there to read`,
      );
    }
  });

  test('the mutation registry is published as the runner recorded it, not as prose remembers', () => {
    /*
     * The specific §4 understatement this wave corrects. The report and the map said the
     * registry had never been run complete while the artifact beside them recorded a
     * complete run. Whatever the run says, the documents must say — including a run that
     * left a survivor, which must never be publishable as zero.
     */
    const { values } = readFigures();
    const docs = documents();
    if (values.mutations_declared !== undefined) {
      assert.equal(values.mutations_declared, values.mutations_killed);
      assert.equal(values.mutations_survived, '0');
      assert.ok(
        (docs[REPORT_PATH] as string).includes(
          `${values.mutations_declared} declared / ${values.mutations_killed} killed / ${values.mutations_survived} survived`,
        ),
        'the report must state the registry in the three-figure form the runner writes',
      );
    }
    const survivorSlipped = { ...values, mutations_survived: '1' };
    assert.ok(
      figureProblems(survivorSlipped, docs).problems.some((p) => p.includes('mutations_survived')),
      'a surviving mutation published as zero must be reported',
    );
  });
});
