import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
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
import { BRANCH_SENTENCE, type CensusPosition } from '../scripts/migration-census';
import {
  FIGURES,
  GOVERNED,
  HISTORICAL_START,
  REPORT as REPORT_PATH,
  UNCHECKABLE,
  figureProblems,
  isArtifactSourced,
  readFigures,
  unreadableProblems,
} from '../scripts/check-published-figures';
import {
  FORBIDDEN,
  ALSO_SCANNED as FINAL_STATE_ALSO_SCANNED,
  GOVERNED as FINAL_STATE_GOVERNED,
  HISTORY_DEPENDENT_CHECKS,
  RECORD as FINAL_STATE_RECORD,
  WITHDRAWN_END,
  WITHDRAWN_START,
  finalStateProblems,
  maskDocument,
  normalize as normalizeFinalState,
  readDocuments as readFinalStateDocuments,
  readFinalState,
  readGitFacts,
  requiredStatements,
  type FinalState,
  type GitFacts,
} from '../scripts/check-final-state';

/**
 * FBL-020-R5 §3 — THE DOCUMENTATION TESTS INSPECT THE DELIVERY DOCUMENTS, AND BOTH
 * BLUEPRINT DOCUMENTS, FROM THEIR OWN BYTES.
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
 * So §3.4 requires the anchor to be the document itself. `docs/orders/` holds BOTH
 * blueprints, and the first two tests below read the BYTES of each: digest, byte length,
 * title lines, version line and §14 headings. THIS PARAGRAPH USED TO SAY THE GOVERNING
 * VERSION 2.0 DOCUMENT WAS NOT IN THIS REPOSITORY and that the test verified it "the moment
 * a file appears at its declared path"; the operator committed those bytes under
 * FBL-020-R6, the conditional limb became the ordinary path, and the sentence was left
 * standing over a file in the tree. Both documents are verified unconditionally, so
 * attaching the wrong file fails rather than passing.
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

/**
 * The two mutually exclusive statements the report may make about the CI gate.
 *
 * FBL-020-R6 §4.4 REPLACED THE OLD PAIR, AND THE REASON IS THE REJECTION ITSELF. The pair
 * used to be "NO CI RUN EXISTS FOR THIS TREE" against "THE R5 CI GATE IS DISCHARGED", which
 * treated one tree as the only subject a CI claim could have. That is what made the stale
 * state expressible: at `174c789` a green exact-SHA run existed AND the corrections on top
 * of it were unrun, and the report could satisfy the old dichotomy while being wrong about
 * both. The subjects are now separated — a COMMIT is measured by a run, a WORKING TREE is
 * not — and `scripts/check-final-state.ts` requires the R6 working-tree sentence
 * unconditionally, because it is true whichever way this dichotomy falls.
 */
const CI_NO_RUN = 'NO EXACT-SHA CI RUN EXISTS FOR ANY CODE-BEARING COMMIT';
const CI_DISCHARGED = /THE R5 CI GATE IS DISCHARGED/;

/** The two mutually exclusive statements the report may make about the commit. */
const COMMIT_NONE = 'NOTHING IS COMMITTED AND NOTHING IS PUSHED';
const COMMIT_MADE = /THE FINAL CODE-BEARING COMMIT IS `[0-9a-f]{40}`/;

/**
 * The census is a report, not a ratification, and the report must keep saying so.
 *
 * FBL-020-R6 §1.3 dropped the "R5 §0" qualifier: the census that governs is the R6 operator
 * one, and the sentence has to be about THAT census rather than about a superseded artifact.
 * What the phrase is FOR is unchanged — no revision may quietly upgrade a finding into an
 * acceptance — and it is still required verbatim.
 */
const CENSUS_PHRASE = 'THE CENSUS IS REPORTED, NOT ACCEPTED';

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

/** The TEN reconciled documents: the nine §3.6 names, plus the requirement map (R6 §4.4). */
const RECONCILED_DOCUMENTS: Array<[string, string]> = [
  ['README.md', 'README.md'],
  ['ADR-001', join('docs', 'adr', 'ADR-001-modular-monolith.md')],
  ['AUTH-FLOWS', join('docs', 'identity', 'AUTH-FLOWS.md')],
  ['KNOWN-LIMITATIONS', join('docs', 'identity', 'KNOWN-LIMITATIONS.md')],
  ['DATA-DICTIONARY', join('docs', 'identity', 'DATA-DICTIONARY.md')],
  ['the threat model', join('docs', 'architecture', 'THREAT-MODEL-DELTA-FBL-020.md')],
  ['MODULE-OWNERSHIP', join('docs', 'architecture', 'MODULE-OWNERSHIP.md')],
  ['the delivery report', join('docs', 'FBL-020-DELIVERY-REPORT.md')],
  // FBL-020-R6 §4.4 added the map: it was one of the four documents rejected for a stale
  // final state, so leaving it out of the reconciliation list was itself part of the gap.
  ['the requirement map', join('docs', 'FBL-020-R5-REQUIREMENT-MAP.json')],
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

/**
 * The value a delivery DOCUMENT publishes for a figure, read from its `<!--fig:id-->` span.
 *
 * FBL-020-R5, after ci.yml run 32168154239: the two self-tests below built their fixtures
 * from `values`, which includes figures sourced from `artifacts/`. That directory is
 * gitignored, and in CI the battery runs BEFORE `parse-test-summary.ts` writes the artifact
 * — so `Number(values.suite_tests)` was NaN on a runner, the fixture could not be built,
 * and both tests failed there while passing locally. That is the third time this order has
 * been bitten by one asymmetry: a local tree has artifacts, a fresh checkout does not.
 *
 * A self-test of the GATE'S REPORTING LOGIC must not depend on a file that may be absent.
 * The documents are committed, so what they publish is always readable, and staging a
 * contradiction against that is exactly as strong a fixture. The gate's behaviour on the
 * real tree is asserted separately, by the test that compares each figure with its source
 * and correctly skips what it cannot read.
 */
function publishedFigureValue(documents: Record<string, string>, id: string): number {
  const span = new RegExp(`<!--fig:${id}-->(.*?)<!--/fig-->`, 'gs');
  for (const text of Object.values(documents)) {
    for (const m of text.matchAll(span)) {
      const n = Number((m[1] ?? '').replace(/[^0-9]/g, ''));
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return Number.NaN;
}

describe('both blueprints, each verified from its own bytes (FBL-020-R5 §3.1/§3.4)', () => {
  test('the SUPPLIED blueprint in this repository is the document the record describes', () => {
    const facts: BlueprintFacts = loadRequirementMap().governing_document.superseded;
    assert.equal(
      facts.present_in_repository,
      true,
      'the superseded document is the second anchor that makes the §14 ambiguity visible; it must be in the repository',
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
      'the Version 1.0 §14.3 is FBL-000 — which is why a bare section number is ambiguous',
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
      'the provenance record must say the ceilings are not readable in the Version 1.0 document',
    );
  });

  test('the GOVERNING blueprint is IN the repository, and every recorded fact is read from its bytes', () => {
    /*
     * FBL-020-R6. This test used to assert the OPPOSITE — that the governing document was
     * absent and its facts were an attestation — with a conditional limb that would verify it
     * "the moment it is attached". That moment arrived: three sends through the attachment
     * channel left nothing this repository could observe, so the operator committed the
     * bytes into the repository instead. The conditional limb is now unconditional, which is
     * the whole point of having written it that way: attaching the WRONG file fails here
     * rather than passing quietly.
     *
     * What this closes is narrow and worth stating exactly. The repository can now be READ to
     * confirm which document governs and what Version 2.0 §14.3 says in it. It still cannot
     * write to, or observe, the reviewer's own project copies — so whether those two copies
     * have been replaced is not something this or any other gate here can assert.
     */
    const facts: BlueprintFacts = loadRequirementMap().governing_document.governing;
    assert.equal(
      facts.present_in_repository,
      true,
      'the governing document is committed here and the record must say so',
    );
    assert.equal(
      facts.verification,
      'verified-from-repository-bytes',
      'its facts are measured from the file, not transcribed from the order text',
    );
    assert.ok(
      facts.attested_by === undefined,
      'an attestation field must not survive alongside a measurement — one or the other is the truth',
    );

    const path = join(ROOT, facts.repository_path);
    assert.ok(existsSync(path), `${facts.repository_path} must be committed`);
    assert.equal(fileSha256(path), facts.file_sha256, 'the governing document digest');
    assert.equal(fileBytes(path), facts.bytes, 'the governing document byte length');

    const lines = docxLines(path);
    for (const [label, value] of [
      ['title, first line', facts.title_line_1],
      ['title, second line', facts.title_line_2],
      ['version line', facts.version_line],
    ] as const) {
      assert.ok(lines.includes(value), `${label}: ${value}`);
    }

    const headings = docxHeadings(path).map((h) => h.text);
    for (const expected of Object.values(facts.section_14_headings)) {
      assert.ok(headings.includes(expected), `§14 heading: ${expected}`);
    }

    /*
     * The requirement a Version 1.0 reader could NOT check from anything in this repository —
     * now checkable, because these are the bytes that carry it. It occurs exactly once.
     */
    const ceilings = lines.filter((l) => /ceiling/i.test(l));
    assert.equal(
      ceilings.length,
      1,
      'the ceilings sentence occurs exactly once in the governing document',
    );
    assert.match(
      ceilings[0] as string,
      /tsc-strict <=\s*59.*eslint <=\s*136.*format <=\s*23/,
      'and it states 59 / 136 / 23',
    );
  });

  test('every blueprint citation in the delivery documents names its version, file or digest', () => {
    /*
     * The R3 defect, made mechanical. "§14.3" alone names FBL-000 in the superseded
     * Version 1.0 document and FBL-020-R2 in the governing Version 2.0 one. A citation is only a citation if
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
    if (committed) {
      /*
       * FBL-020-R6 §4.4. The commit the report names must be the commit the committed
       * record names — one final state, in one place, restated everywhere else. Naming a
       * 40-character SHA is no longer enough on its own: R5 named one, and it was the
       * wrong one.
       */
      const named = /THE FINAL CODE-BEARING COMMIT IS `([0-9a-f]{40})`/.exec(REPORT);
      assert.ok(named, 'the report must name its final code-bearing commit');
      assert.equal(
        named[1],
        readFinalState().evidence_commit_sha,
        'the report must name the commit docs/evidence/FBL-020-FINAL-STATE.json records',
      );
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

    /*
     * 1. As shipped, against the real artifact.
     *
     * FBL-020-R6 §1.1: this comparison used to be wrapped in `if (existsSync(CENSUS))`,
     * because the census lived under the GITIGNORED `artifacts/`. So the gate ran on a
     * developer machine that had taken a census and silently did nothing on a fresh
     * checkout — which is where the delivery documents are actually read. The operator
     * census is committed now, and the comparison is unconditional.
     */
    assert.ok(existsSync(CENSUS), `the operator census must be COMMITTED, at ${CENSUS}`);
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

    /*
     * 2. THE REVERT PROOF. Flip the artifact's verdict and leave the prose alone: the gate
     *    must fail, naming the disagreement. This is the exact R5 situation.
     *
     *    THE FLIP IS DERIVED FROM THE REAL POSITION, NOT TYPED. FBL-020-R6: this control
     *    used to hard-code `FREEZE_057_AND_ADD_058` as "the other one", which was true only
     *    while the committed artifact concluded something else. When the census was re-taken
     *    and landed on FREEZE, the "flip" became the position the prose already stated, the
     *    gate correctly reported no disagreement, and the control failed — having proved
     *    nothing about the rule for as long as the two happened to differ. Picking any
     *    position OTHER than the real one keeps the control a control whatever the artifact
     *    concludes.
     */
    const otherPosition = (Object.keys(BRANCH_SENTENCE) as CensusPosition[]).find(
      (position) => position !== real.position,
    );
    assert.ok(otherPosition !== undefined, 'there must be more than one census position');
    const flipped: CensusClaim = {
      position: otherPosition,
      branch_sentence: BRANCH_SENTENCE[otherPosition],
      role: 'OPERATOR_CONTROLLED_HOST',
    };
    const whenArtifactSaysFreeze = proseProblems(flipped, REPORT, mapDoc);
    assert.ok(
      whenArtifactSaysFreeze.some((p) => p.includes(`does not name ${otherPosition}`)),
      `a census concluding ${otherPosition} against prose saying otherwise must fail: ${whenArtifactSaysFreeze.join('; ')}`,
    );
    for (const id of POSITION_BEARING_ROWS)
      assert.ok(
        whenArtifactSaysFreeze.some((p) => p.includes(id) && p.includes('census_position')),
        `${id} must be reported as disagreeing with the artifact`,
      );

    /*
     * 3. And the other direction: flip the PROSE and leave the artifact alone.
     *
     *    Both halves are DERIVED from the shipped position for the reason above — this
     *    replacement named `INCOMPLETE_CENSUS_REQUIRES_058` literally, so when the re-taken
     *    census moved the token the string was no longer in the report, the `replace` was a
     *    no-op, and the control asserted nothing.
     */
    const shipped: CensusClaim = {
      position: real.position,
      branch_sentence: BRANCH_SENTENCE[real.position],
      role: 'OPERATOR_CONTROLLED_HOST',
    };
    const flippedReport = REPORT.replace(`**${real.position}.**`, '**EDIT_057_IN_PLACE.**');
    assert.notEqual(flippedReport, REPORT, 'the report must state its position in one place');
    assert.ok(
      proseProblems(shipped, flippedReport, mapDoc).some((p) =>
        p.includes('asserts EDIT_057_IN_PLACE'),
      ),
      'a report asserting the branch the artifact did not take must fail',
    );

    const flippedMap = {
      requirements: (mapDoc.requirements ?? []).map((r) =>
        POSITION_BEARING_ROWS.includes(r.id as (typeof POSITION_BEARING_ROWS)[number])
          ? { ...r, census_position: 'EDIT_057_IN_PLACE' }
          : r,
      ),
    };
    assert.ok(
      proseProblems(shipped, REPORT, flippedMap).some((p) =>
        p.includes('declares census_position EDIT_057_IN_PLACE'),
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

    /*
     * 6. The block must QUOTE the artifact, not merely agree with its token. The sentence
     *    to damage is taken from the SHIPPED position for the same reason as controls 2
     *    and 3: naming one position's opening words literally made this a no-op the moment
     *    the census landed on another.
     */
    const opening = (BRANCH_SENTENCE[real.position] as string).split(/(?<=\.)\s/)[0] as string;
    const unquoted = REPORT.replace(opening, 'This census is roughly complete, give or take.');
    assert.notEqual(unquoted, REPORT, `the report must quote ${JSON.stringify(opening)}`);
    assert.ok(
      proseProblems(shipped, unquoted, mapDoc).some((p) => p.includes('branch sentence')),
      "a paraphrase is not the artifact's own words",
    );
  });

  test('a CI-RUNNER census is REFUSED as the census the branch rests on', () => {
    /*
     * FBL-020-R6 §1.2. R5 substituted the CI-runner census for the census of the operator's
     * actual persistent environments, and the review rejected it. A runner is created for
     * one job and destroyed after it: it can observe none of the environments the order
     * asks about, so an artifact taken there declares
     * `authority.may_decide_the_057_058_branch: false` and this gate refuses to read a
     * position out of it — rather than comparing the delivery prose against a machine that
     * knows nothing.
     */
    const dir = mkdtempSync(join(tmpdir(), 'census-authority-'));
    try {
      const operator = JSON.parse(readFileSync(CENSUS, 'utf8')) as {
        authority: { role: string; may_decide_the_057_058_branch: boolean };
        conclusion: { position: string };
      };
      assert.equal(
        operator.authority.role,
        'OPERATOR_CONTROLLED_HOST',
        'the committed census must be the operator one',
      );
      assert.equal(operator.authority.may_decide_the_057_058_branch, true);

      // The same artifact, relabelled as a runner census, is refused.
      const runner = join(dir, 'runner-census.json');
      writeFileSync(
        runner,
        JSON.stringify({
          ...operator,
          authority: {
            role: 'CI_RUNNER',
            may_decide_the_057_058_branch: false,
            statement: 'evidence about this runner and nothing else',
            detected_from: ['GITHUB_ACTIONS'],
          },
        }),
        'utf8',
      );
      assert.throws(
        () => readCensusClaim(runner),
        /MAY NOT DECIDE THE 057\/058 BRANCH/,
        'a runner census must not be readable as the census the branch rests on',
      );

      // …and one that states no authority at all is refused too, so silence is not consent.
      const silent = join(dir, 'silent-census.json');
      const withoutAuthority: Record<string, unknown> = { ...operator };
      delete withoutAuthority.authority;
      writeFileSync(silent, JSON.stringify(withoutAuthority), 'utf8');
      assert.throws(
        () => readCensusClaim(silent),
        /carries no authority\.may_decide_the_057_058_branch/,
      );

      // The committed operator census IS readable, so the checks above are not simply
      // refusing everything.
      assert.equal(readCensusClaim(CENSUS).role, 'OPERATOR_CONTROLLED_HOST');
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });

  test('the census the gate reads is COMMITTED, so a fresh checkout compares the same bytes', () => {
    /*
     * FBL-020-R6 §1.1, and the asymmetry that has now caused four separate failures:
     * `artifacts/` is gitignored, so a developer tree carries it and a CI checkout does
     * not. A gate that reads its evidence from there checks a different thing depending on
     * where it runs — and in CI it read the RUNNER census, which §1.2 forbids from deciding
     * anything.
     */
    assert.ok(
      !CENSUS.split('\\').join('/').includes('/artifacts/'),
      `the census this gate reads must not live under the gitignored artifacts/: ${CENSUS}`,
    );
    assert.ok(existsSync(CENSUS), 'and it must be present in the checkout');

    /*
     * IGNORED, not TRACKED, is the property that matters and the only one that can be
     * checked before the delivery is committed. `git ls-files` would answer "no" for a file
     * that is about to be committed and for a file that can never be, which is the
     * distinction this test exists to make.
     *
     * The git call is guarded for the same reason the uncommitted-migrations test above
     * guards its own: `scripts/mutation-kill.ts` runs this battery inside an isolated copy
     * of the tree with no `.git`, and a test that threw there would turn a killed mutation
     * into a reported survivor. The path assertion above is unconditional; this one runs
     * wherever git can answer, and the branch taken is asserted rather than passed over.
     */
    let ignored: boolean | undefined;
    try {
      execFileSync('git', ['check-ignore', '--quiet', CENSUS], { cwd: join(__dirname, '..') });
      ignored = true;
    } catch (err) {
      // `check-ignore` exits 1 for a path that is NOT ignored. Any other failure means git
      // could not answer at all.
      ignored = (err as { status?: number }).status === 1 ? false : undefined;
    }
    assert.ok(
      ignored === false || ignored === undefined,
      'the operator census must not be gitignored: a gate cannot read evidence a checkout ' +
        'does not carry',
    );
    if (ignored === undefined)
      assert.ok(
        !existsSync(join(__dirname, '..', '.git')),
        'git declined to answer in a tree that HAS a .git directory, which is not a copy ' +
          'this guard is meant to excuse',
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

  test('the ten reconciled documents exist and all speak of this revision', () => {
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

  test('no §3.6 document claims the migrations are an uncommitted working tree, because git says they are not', () => {
    /*
     * FBL-020-R5 — THE CLASS, NOT THE INSTANCE.
     *
     * `docs/identity/DATA-DICTIONARY.md` justified refusing to quote a `HEAD` digest with
     * "the delivery is an uncommitted working tree, so a digest taken from `HEAD` would
     * describe a different body". Both halves stopped being true at commit `52e1567`, and
     * the second half was never true in the way it mattered: the `HEAD` blob and the
     * working tree canonicalise to the SAME digest. A correction pass fixed the identical
     * claim in the report and in KNOWN-LIMITATIONS and missed this one, because nothing
     * checked the claim against git.
     *
     * This test checks it against git. The premise is measured first — so the test fails
     * loudly if the repository ever genuinely does carry uncommitted migrations, rather
     * than silently enforcing a stale rule — and only then are the ten documents scanned.
     *
     * WHY THE PREMISE IS CONDITIONAL AND THE DOCUMENT SCAN IS NOT. `scripts/mutation-kill.ts`
     * runs this battery inside an ISOLATED COPY of the tree, and that copy deliberately
     * excludes `.git`. The first version of this test called git unconditionally, so inside
     * the copy every git call threw and the battery went red — which took the BASELINE of
     * mutation `blueprint_digest_recorded_wrong` red with it and turned a killed mutation
     * into a reported survivor. The runner was right to refuse it: a battery that is already
     * broken cannot kill anything.
     *
     * So the git premise runs only where git can answer, and the ASSERTION — no §3.6
     * document may claim the migrations are uncommitted — runs everywhere, unconditionally.
     * That is the safe split: the premise is a GUARD that can only ever stop this test from
     * enforcing the rule against a repository where the rule is genuinely false, and a
     * detached copy of the tree is not such a repository. The branch that was taken is
     * asserted about, not passed over in silence.
     */
    const git = (...args: string[]): string =>
      execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const canonical = (buf: string): string =>
      createHash('sha256').update(buf.replace(/\r\n/g, '\n'), 'utf8').digest('hex');

    let insideWorkTree: boolean;
    try {
      insideWorkTree = git('rev-parse', '--is-inside-work-tree').trim() === 'true';
    } catch {
      // git is absent, or this directory is not a checkout — e.g. the mutation runner's copy.
      insideWorkTree = false;
    }

    if (insideWorkTree) {
      /*
       * FBL-020-R6 §3 — THE PREMISE NAMES THE PROPERTY IT ALWAYS MEANT.
       *
       * It used to require `git status --porcelain -- migrations` to be EMPTY, which
       * says two things at once: no migration HEAD carries has been edited here, and
       * no new migration is being authored. Only the first is the property the false
       * sentence was about, and only the first is a rule this repository can keep —
       * the second is false for the whole of any order that adds a migration, which
       * FBL-020-R6 §3 does (`058_policy_evidence_reconstructable.sql`, uncommitted by
       * instruction while it is under review).
       *
       * So the premise now refuses exactly the shape that matters — a MODIFIED,
       * DELETED or RENAMED migration — and admits an ADDED one, whose body cannot
       * disagree with a HEAD blob because there is no HEAD blob to disagree with. The
       * byte-immutability of the frozen chain is checked BELOW, file by file, against
       * HEAD, and `057` is still named outright. Nothing that could catch an edited
       * migration was given up.
       */
      const status = git('status', '--porcelain', '--', 'migrations').trim();
      const entries = status === '' ? [] : status.split(/\r?\n/);
      const notNew = entries.filter((line) => !/^(\?\?|A[ M]|[ ]A)/.test(line));
      assert.deepEqual(
        notNew,
        [],
        'PREMISE: no migration that HEAD carries may be modified, deleted or renamed in ' +
          'this tree; only a NEW file may be uncommitted. If this fails the documents are ' +
          'not the problem.',
      );

      const migrations = readdirSync(join(ROOT, 'migrations'))
        .filter((f) => f.endsWith('.sql'))
        .sort();
      assert.ok(migrations.length >= 10, 'sanity: the migration chain was found');
      const inHead = new Set(
        git('ls-tree', '--name-only', 'HEAD', 'migrations/')
          .split(/\r?\n/)
          .filter((p) => p.endsWith('.sql'))
          .map((p) => p.slice('migrations/'.length)),
      );
      // The added file is asserted about rather than passed over: a premise that
      // admits new files must show which ones it admitted.
      const added = migrations.filter((f) => !inHead.has(f));
      assert.deepEqual(
        added.filter((f) => !entries.some((line) => line.includes(f))),
        [],
        `a migration absent from HEAD must appear in git status as a new file: ${added.join(', ')}`,
      );
      const differing = migrations.filter(
        (f) =>
          inHead.has(f) &&
          canonical(git('show', `HEAD:migrations/${f}`)) !==
            canonical(readFileSync(join(ROOT, 'migrations', f), 'utf8')),
      );
      assert.deepEqual(
        differing,
        [],
        `a digest taken from HEAD describes exactly the body in this tree; these differ: ${differing.join(', ')}`,
      );
      // Named outright, because it is the file the false sentence was written about.
      assert.equal(
        canonical(git('show', 'HEAD:migrations/057_identity_boundary_completion.sql')),
        canonical(
          readFileSync(join(ROOT, 'migrations', '057_identity_boundary_completion.sql'), 'utf8'),
        ),
        '057 in HEAD and 057 in this tree are the same body',
      );
    } else {
      // Not a skip: the assertion below still runs. What is recorded is WHY the premise
      // could not be measured, so a reader of a passing run knows which half executed.
      assert.ok(
        !existsSync(join(ROOT, '.git')),
        'the premise was skipped, so this must genuinely not be a git checkout — otherwise ' +
          'git failed for a reason that needs investigating rather than tolerating',
      );
      assert.ok(
        existsSync(join(ROOT, 'migrations')),
        'sanity: this is still a copy of this repository',
      );
    }

    /*
     * The sentence may appear ONLY where a document is withdrawing it. Deleting the
     * history of a corrected claim is its own dishonesty — a reviewer holding the old
     * document needs to find the correction — so the allowance is the same one this file
     * already grants the "no test invokes" claim: a withdrawal word must be nearby.
     */
    const offenders: string[] = [];
    for (const [name, path] of RECONCILED_DOCUMENTS) {
      /*
       * FBL-020-R6 §4.4 added the requirement map to this list, and the map CITES TEST
       * NAMES — including this test's own name, which contains the very phrase. A citation
       * of a test is not a claim about the tree, so `"name": "…"` values are blanked before
       * the scan. Nothing else in a JSON document is exempt, and the Markdown documents are
       * scanned whole.
       */
      const doc = readFileSync(join(ROOT, path), 'utf8').replace(
        path.endsWith('.json') ? /"name": "[^"]*"/g : /(?!)/g,
        '"name": ""',
      );
      for (const m of doc.matchAll(
        /uncommitted working tree|digest taken from `?HEAD`? would describe a different body/gi,
      ) as IterableIterator<RegExpMatchArray>) {
        const at = m.index ?? 0;
        const around = doc.slice(Math.max(0, at - 400), at + 400);
        if (!/\bfalse\b|\bwrong\b|withdraw|no longer true|not true/i.test(around))
          offenders.push(`${name}: ${m[0]}`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `documents asserting the migrations are uncommitted, which git contradicts:\n${offenders.join('\n')}`,
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
    const declaredFromArtifact = Number(values.mutations_declared);
    const mutationsDeclared = Number.isFinite(declaredFromArtifact)
      ? declaredFromArtifact
      : publishedFigureValue(docs, 'mutations_declared');
    assert.ok(
      Number.isFinite(mutationsDeclared),
      'mutations_declared must be readable from the artifact OR a published span',
    );
    const invented =
      `${docs[REPORT_PATH] as string}\n\nA later paragraph nobody gated says the runner ` +
      `declared ${mutationsDeclared - 10} mutations declared.\n`;
    /*
     * The SOURCE is supplied, not assumed present. This limb is the source comparison, so
     * it only speaks when the source is readable; passing `values` made the assertion pass
     * locally (artifact on disk) and, when `artifacts/` was absent, pass only by accident —
     * the mutual-consistency limb's message also quotes `restatement rule
     * mutations-registry`, because it names the rule each occurrence came through. Staging
     * the value makes the limb under test the limb asserted, in either condition.
     */
    const provenSource = { ...values, mutations_declared: String(mutationsDeclared) };
    const whenProseInvents = figureProblems(provenSource, {
      ...docs,
      [REPORT_PATH]: invented,
    }).problems;
    assert.ok(
      whenProseInvents.some(
        (p) => p.includes('restatement rule mutations-registry') && p.includes('its source reads'),
      ),
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
    //
    //    FBL-020-R6: THIS LIMB USED TO ITERATE `UNCHECKABLE`, AND THAT IS NOW A BUG SHAPE
    //    RATHER THAN A TEST. The registry became EMPTY when the governing Version 2.0
    //    blueprint was committed — its byte length and the three quality ceilings are read
    //    from that file's own bytes now, so neither may carry a "no gate can check this"
    //    label any more. A `for` loop over an empty array asserts nothing and reports
    //    green, which is precisely the failure this order was opened over. So the rule is
    //    driven with a STAGED entry, and the registry's emptiness is asserted separately.
    assert.deepEqual(
      UNCHECKABLE,
      [],
      'both former entries derive from the committed blueprint now; re-adding one is a ' +
        'claim that this repository cannot derive a figure it publishes',
    );

    const staged = {
      id: 'staged_uncheckable_figure',
      what: 'a figure no gate in this repository can derive',
      why: 'staged by this test so the missing-label refusal is exercised on an empty registry',
      label: 'NOT GATE-CHECKED: staged by tests/delivery-documentation.test.ts',
      files: [REPORT_PATH],
    };
    // The label is absent from the real report, so the rule must fire on the document as
    // it stands — no mutation of the text needed to make the refusal true.
    assert.ok(
      !(docs[REPORT_PATH] as string).includes(staged.label),
      'the staged label must not already appear, or this limb would prove nothing',
    );
    assert.ok(
      figureProblems(values, docs, [staged]).problems.some(
        (p) => p.includes(staged.id) && p.includes('does not carry the label'),
      ),
      'a figure declared uncheckable and published without its label must be reported',
    );
    // …and the same call with the label present must NOT report it, so the rule is keyed to
    // the label rather than to the entry merely existing.
    const labelled = `${docs[REPORT_PATH] as string}\n\n${staged.label}\n`;
    assert.ok(
      !figureProblems(values, { ...docs, [REPORT_PATH]: labelled }, [staged]).problems.some((p) =>
        p.includes(staged.id),
      ),
      'and carrying the label must clear it',
    );
  });

  test('an unreadable COMMITTED source fails, while an unreadable ARTIFACT is skipped', () => {
    /*
     * FBL-020-R6, and this hole was found by staging the defect rather than by reading the
     * code. `readFigures` reports what it cannot read as `unreadable`, and the gate skips
     * those because `artifacts/` is gitignored and absent on a clean checkout. When the
     * governing Version 2.0 blueprint was committed, three figures — the quality ceilings —
     * started deriving from a `.docx` IN THIS TREE. Copying the Version 1.0 document over
     * that path then made all three unreadable, and the gate still printed "Every published
     * figure agrees with its source": the wrong document was caught only incidentally, by
     * the byte-length figure.
     *
     * A committed source is readable on any checkout. Failing to read one is a defect, not
     * an excuse, and the two cases are now separated.
     */
    const ceilings = FIGURES.filter((f) => f.id.startsWith('ceiling_'));
    assert.equal(ceilings.length, 3, 'the three ceiling figures must be registered');
    for (const figure of ceilings)
      assert.equal(
        isArtifactSourced(figure),
        false,
        `${figure.id} derives from a committed document, not from artifacts/`,
      );

    // THE COMMITTED SOURCE: unreadable must be REPORTED, and the message must say why.
    const committed = unreadableProblems({
      ceiling_tsc_strict: 'docs/orders/…docx states no /tsc-strict <=\\s*(\\d+)/',
    });
    assert.equal(committed.length, 1, 'an unreadable committed source must be reported');
    assert.match(committed[0] as string, /ceiling_tsc_strict/);
    assert.match(committed[0] as string, /COMMITTED, not a gitignored artifact/);

    // THE ARTIFACT SOURCE: unreadable is the ordinary clean-checkout state and must be silent.
    const fromArtifact = FIGURES.find((f) => isArtifactSourced(f));
    assert.ok(fromArtifact !== undefined, 'at least one figure must be artifact-sourced');
    assert.deepEqual(
      unreadableProblems({ [fromArtifact.id]: 'artifacts/… does not exist' }),
      [],
      'a gitignored artifact that has not been produced yet is skipped, not failed',
    );

    // …and an id that names no registered figure is not invented into a problem.
    assert.deepEqual(unreadableProblems({ not_a_figure: 'whatever' }), []);
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
    /*
     * FBL-020-R5, after ci.yml run 32168154239: this asserted that DELETING the
     * artifact-sourced figures shrank the map, which is only true when the artifacts were
     * readable in the first place. In CI they are not — the battery runs before
     * `parse-test-summary.ts` writes them — so the premise failed on a runner and passed
     * locally. The property that actually matters is about the REGISTRY, which is committed
     * and therefore identical in both places: some figures must be artifact-sourced, or this
     * test proves nothing about the no-artifact path.
     */
    assert.ok(
      FIGURES.some((f) => f.source.kind === 'json' && f.source.artifact === true),
      'the registry must declare artifact-sourced figures for this test to mean anything',
    );
    assert.deepEqual(
      figureProblems(noArtifacts, docs).problems,
      [],
      'the delivery documents must agree with each other with no artifact present at all',
    );

    // Stage the defect that shipped: one more sentence stating the suite total at a value
    // the rest of the documents do not use, with nothing readable to arbitrate.
    const statedFromArtifact = Number(values.suite_tests);
    const stated = Number.isFinite(statedFromArtifact)
      ? statedFromArtifact
      : publishedFigureValue(docs, 'suite_tests');
    assert.ok(
      Number.isFinite(stated),
      'suite_tests must be readable from the artifact OR a published span to build this fixture',
    );
    const suitesFromArtifact = Number(values.suite_suites);
    const statedSuites = Number.isFinite(suitesFromArtifact)
      ? suitesFromArtifact
      : publishedFigureValue(docs, 'suite_suites');
    assert.ok(
      Number.isFinite(statedSuites),
      'suite_suites must be readable from the artifact OR a published span',
    );
    const contradicted =
      `${docs[REPORT_PATH] as string}\n\nA later paragraph nobody reconciled: the battery ` +
      `ran ${stated + 27} tests, ${statedSuites} suites.\n`;
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

    /*
     * And the limb must not fire when the source IS readable — there the stronger source
     * comparison already speaks, and two messages for one defect is noise.
     *
     * FBL-020-R5, after ci.yml run 32168154239: this condition used to be staged by handing
     * the gate `values` and TRUSTING that `artifacts/test-summary.json` was on disk. It is
     * gitignored, and in CI the battery runs before `parse-test-summary.ts` writes it, so on
     * a runner `suite_tests` was unreadable, the source could NOT arbitrate, the limb
     * correctly fired, and the assertion that it stays silent failed — while passing locally
     * on a tree that had artifacts. Third instance of one asymmetry in this order.
     *
     * The arbitrating source is now SUPPLIED at the value the documents publish, so BOTH
     * directions of the property — fires with no source, silent with one — are exercised
     * with or without `artifacts/` present. The gate's behaviour against the REAL sources is
     * asserted by the first test in this suite, which reads them and skips what it cannot.
     */
    const arbitrated = {
      ...values,
      suite_tests: String(stated),
      suite_suites: String(statedSuites),
    };
    const withSource = figureProblems(arbitrated, {
      ...docs,
      [REPORT_PATH]: contradicted,
    }).problems;
    assert.ok(
      withSource.some((p) => p.includes('restatement rule suite-totals')),
      `with the source readable the source comparison must catch it: ${withSource.join('; ')}`,
    );
    assert.ok(
      !withSource.some((p) => p.includes('different values and its source is not readable')),
      `the mutual-consistency limb must stay silent when the source can arbitrate: ${withSource.join('; ')}`,
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

/**
 * FBL-020-R6 §4.5 — THE FINAL STATE, INCLUDING ITS PROSE.
 *
 * The battery above proves the FIGURE gate can fail. It cannot prove anything about the
 * sentences, and the sentences are what FBL-020-R5 was rejected for: a delivery report
 * naming a red `HEAD` that was no longer `HEAD`, a KNOWN-LIMITATIONS repeating that no CI
 * run existed, a requirement map still awaiting a run that had already happened, and no
 * file anywhere recording the final commit or the run at all. Every figure gate was green
 * throughout, necessarily — none of those claims is a number.
 *
 * These tests drive `scripts/check-final-state.ts` in both directions: as shipped against
 * the real record, the real git history and the real documents; and against staged inputs
 * in which each class of defect is reintroduced one at a time, so every limb is shown able
 * to fail. The stale-sentence test is the one the order asks for by name.
 */
describe('the final state is ONE record, and the documents restate it (FBL-020-R6 §4.5)', () => {
  /**
   * WHY THIS IS CONDITIONAL, AND WHAT STAYS UNCONDITIONAL.
   *
   * `scripts/mutation-kill.ts` runs this battery inside an ISOLATED COPY of the tree, and
   * that copy deliberately excludes `.git`. A gate that shells out to git unconditionally
   * would therefore throw at collection time there, take the whole battery down, and be
   * reported as a SURVIVING mutation — the same trap the "uncommitted working tree" test
   * above already documents.
   *
   * So the GIT limbs are measured only in a real checkout. Everything else — the prose,
   * the record's internal arithmetic, the run data, the head-relation logic — runs in both
   * places against facts SYNTHESISED from the record, and the two tests that can only be
   * meaningful against a real history say so out loud rather than passing quietly.
   */
  const IN_GIT_CHECKOUT = existsSync(join(ROOT, '.git'));

  const state = readFinalState();
  const asRecorded = (s: FinalState): GitFacts => {
    const subject: Record<string, string | undefined> = {};
    const ancestorOfHead: Record<string, boolean> = {};
    const above = s.commits_ahead_of_the_evidence_commit ?? [];
    for (const c of [s.r5_baseline, ...s.code_bearing_commits, ...above]) {
      subject[c.sha] = c.subject;
      ancestorOfHead[c.sha] = true;
    }
    /*
     * THE STAND-IN IS DERIVED FROM THE RECORD, NOT PINNED TO ONE SHAPE OF IT.
     *
     * It used to hard-code `head: s.evidence_commit_sha` and `aheadOfEvidence: []` — a tree
     * whose tip IS the evidence commit. That was true of every record this fixture had ever
     * been handed, and it stopped being true the moment a commit was made after the last
     * green run: the fixture then contradicted the very record it was standing in for, and
     * reported three findings about a repository that does not exist. It failed only in a
     * tree with no `.git` — the mutation runner's copy — because a real checkout takes the
     * `readGitFacts` branch instead, so the whole battery went red exactly where nobody
     * looked, and the runner reported the mutation INCONCLUSIVE rather than killed.
     *
     * A stand-in for git must AGREE with the record on the geometry the record declares, or
     * it is testing a disagreement it invented itself.
     */
    /*
     * AND IT MODELS THE COMMIT THE RECORD LIVES IN, because where this stand-in runs that
     * commit always exists.
     *
     * `asRecorded` is used only when there is no `.git` — the tree copy
     * `scripts/mutation-kill.ts` builds. A tree copy is a copy of a CHECKOUT, and in any
     * checkout of a committed record HEAD is STRICTLY ABOVE the evidence commit: the record
     * NAMES the evidence commit, so the commit containing the record cannot be it.
     * `HEAD_IS_THE_EVIDENCE_COMMIT` is reachable only in a working tree edited after that
     * commit, and never here.
     *
     * The previous revision modelled exactly that unreachable state — head = the evidence
     * commit with nothing above it — so it contradicted every record that correctly declared
     * AHEAD, and it did so ONLY in the copy, where no one looks. It cost run 32462910851.
     * `SELF` stands for the unnamed commit the record lives in; the gate exempts HEAD from
     * the ahead-LIST for precisely the reason the record cannot name it.
     */
    // A deliberately unmistakable 40-hex stand-in: no real commit will collide with it, and
    // a reader who sees it in a failure message knows at once it is the modelled self-commit.
    const SELF = 'se1f'.replace('s', '5').padEnd(40, '0');
    return {
      head: SELF,
      shallow: false,
      // This fixture stands in for a COMPLETE checkout — it hands the gate every fact a full
      // clone would have — so it is not the no-repository case, which has its own test.
      absent: false,
      subject,
      ancestorOfHead,
      baselineToEvidence: s.code_bearing_commits.map((c) => c.sha).reverse(),
      aheadOfEvidence: [SELF, ...above.map((c) => c.sha)],
    };
  };
  const factsFor = (s: FinalState): GitFacts => (IN_GIT_CHECKOUT ? readGitFacts(s) : asRecorded(s));

  const facts = factsFor(state);
  const docs = readFinalStateDocuments();

  /** A deep copy, so a staged defect cannot leak into the next test. */
  const clone = (): FinalState => JSON.parse(JSON.stringify(state)) as FinalState;
  const cloneFacts = (): GitFacts => JSON.parse(JSON.stringify(facts)) as GitFacts;

  test('as shipped: the record describes this repository and every document restates it', () => {
    assert.ok(
      existsSync(join(ROOT, FINAL_STATE_RECORD)),
      `${FINAL_STATE_RECORD} must be COMMITTED`,
    );
    assert.deepEqual(
      finalStateProblems(state, facts, docs),
      [],
      'the delivery documents must state ONE final state, and it must be this repository’s',
    );
  });

  test('a STALE SENTENCE reintroduced into a delivery document is REPORTED', () => {
    /*
     * THE PROOF THE ORDER ASKS FOR BY NAME. Each withdrawn sentence is put back into each
     * governed document, one at a time, OUTSIDE any withdrawal region — which is exactly
     * how it lived in the tree that was rejected — and the gate must name it every time.
     */
    for (const forbidden of FORBIDDEN) {
      for (const file of FINAL_STATE_GOVERNED) {
        const staged = { ...docs, [file]: `${docs[file] as string}\n\n${forbidden.sentence}\n` };
        const problems = finalStateProblems(state, facts, staged);
        assert.ok(
          problems.some((p) => p.includes(forbidden.id) && p.includes(file)),
          `reintroducing "${forbidden.id}" into ${file} must be reported`,
        );
      }
    }
  });

  test('a withdrawn sentence is permitted INSIDE a marked withdrawal region, and nowhere else', () => {
    const first = FORBIDDEN[0];
    assert.ok(first);
    const quoted = `${docs[REPORT_PATH] as string}\n\n${WITHDRAWN_START}\n${first.sentence}\n${WITHDRAWN_END}\n`;
    assert.deepEqual(
      finalStateProblems(state, facts, { ...docs, [REPORT_PATH]: quoted }),
      [],
      'withdrawing a claim means quoting it; a quotation inside the marker is not an assertion',
    );

    const bare = `${docs[REPORT_PATH] as string}\n\n${first.sentence}\n`;
    assert.ok(
      finalStateProblems(state, facts, { ...docs, [REPORT_PATH]: bare }).some((p) =>
        p.includes(first.id),
      ),
      'and the same sentence without the marker is an assertion, and is refused',
    );
  });

  test('the exemption is BOUNDED: every withdrawal region in every governed document is counted', () => {
    /*
     * An exemption nobody counts is an exemption that grows. The regions are few, they are
     * counted here, and a document that started masking half of itself would fail this.
     */
    let total = 0;
    for (const file of FINAL_STATE_GOVERNED) {
      const { regions } = maskDocument(file, docs[file] as string);
      total += regions;
      assert.ok(regions <= 4, `${file} declares ${regions} withdrawal regions, which is too many`);
    }
    assert.ok(total > 0, 'the corrections must be recorded by quotation, not by deletion');
    assert.ok(total <= 12, `${total} withdrawal regions across five documents is too many`);
  });

  test('a REQUIRED statement missing from a document is REPORTED, document by document', () => {
    /*
     * The staging is done on the NORMALIZED text, because that is the form the gate
     * compares: Markdown wraps a required sentence across lines and decorates it with
     * backticks and asterisks, so removing the raw string would remove nothing at all and
     * the test would pass without having staged anything. Handing the gate normalized text
     * is legitimate — normalizing is idempotent — and it is the only way to be sure the
     * sentence really left the document.
     */
    for (const statement of requiredStatements(state)) {
      for (const file of statement.documents) {
        const flat = normalizeFinalState(docs[file] as string);
        const stripped = flat.split(normalizeFinalState(statement.sentence)).join('[removed]');
        assert.notEqual(stripped, flat, `${file} must really carry ${statement.id}`);
        assert.ok(
          finalStateProblems(state, facts, { ...docs, [file]: stripped }).some(
            (p) => p.includes(statement.id) && p.includes(file),
          ),
          `removing ${statement.id} from ${file} must be reported`,
        );
      }
    }
  });

  test('the required sentences are DERIVED from the record, so the record cannot drift from them', () => {
    const moved = clone();
    const green = moved.code_bearing_commits[moved.code_bearing_commits.length - 1];
    assert.ok(green);
    green.run.run_id = 99999999999;
    const sentence = requiredStatements(moved).find((s) => s.id === 'final_head_and_run')?.sentence;
    assert.ok(sentence?.includes('99999999999'), 'the sentence must follow the record');
    assert.ok(
      finalStateProblems(moved, facts, docs).some((p) => p.includes('final_head_and_run')),
      'so changing the record without changing the documents fails, in every document',
    );
  });

  test('a commit MISSING from the recorded range is REPORTED — the R5 undercount', () => {
    /*
     * This is the defect itself. The report published TWO code-bearing commits over a
     * range that held THREE, and no gate compared the list with the history.
     */
    const undercount = clone();
    const dropped = undercount.code_bearing_commits.shift();
    assert.ok(dropped);
    // The R5 shape exactly: the record's own arithmetic is made self-consistent at the
    // WRONG number, which is what let the published count stay green.
    undercount.commit_budget.used = undercount.code_bearing_commits.length;
    undercount.commit_budget.failed_ci = undercount.code_bearing_commits.filter(
      (c) => c.run.conclusion !== 'success',
    ).length;
    const problems = finalStateProblems(undercount, facts, docs);
    assert.ok(
      problems.some((p) => p.includes('are NOT recorded') && p.includes(dropped.sha)),
      'a commit in the range that the record does not list must be named',
    );
    assert.ok(
      problems.some((p) => p.includes('commit_budget.used')),
      'and git — not the record — decides how many code-bearing commits there are',
    );
  });

  test('a commit the repository does not have, or a subject it does not carry, is REPORTED', () => {
    if (!IN_GIT_CHECKOUT) {
      // Not a silent skip: what is recorded is WHY this limb could not be measured.
      assert.ok(
        !existsSync(join(ROOT, '.git')),
        'the git limbs were skipped, so this must genuinely not be a checkout',
      );
      assert.ok(existsSync(join(ROOT, FINAL_STATE_RECORD)), 'sanity: the record is still here');
      return;
    }
    const invented = clone();
    const first = invented.code_bearing_commits[0];
    assert.ok(first);
    first.sha = 'f'.repeat(40);
    first.short = 'fffffff';
    assert.ok(
      finalStateProblems(invented, readGitFacts(invented), docs).some((p) =>
        p.includes('is not a commit in this repository'),
      ),
      'the record may not name a commit that does not exist',
    );

    const relabelled = clone();
    const head = relabelled.code_bearing_commits[0];
    assert.ok(head);
    head.subject = 'FBL-020-R5: something else entirely';
    assert.ok(
      finalStateProblems(relabelled, facts, docs).some((p) => p.includes('but git says')),
      'nor may it record a subject the commit does not carry',
    );
  });

  test('a run whose head_sha is not the commit it is attributed to is REPORTED', () => {
    const branchRun = clone();
    const green = branchRun.code_bearing_commits[branchRun.code_bearing_commits.length - 1];
    const first = branchRun.code_bearing_commits[0];
    assert.ok(green && first);
    green.run.head_sha = first.sha;
    assert.ok(
      finalStateProblems(branchRun, facts, docs).some((p) =>
        p.includes('is NOT the commit it is attributed to'),
      ),
      'a run of a different tree is not an exact-SHA run, and may not be published as one',
    );
  });

  test('a run published as success with a non-success job in it is REPORTED', () => {
    const painted = clone();
    const green = painted.code_bearing_commits[painted.code_bearing_commits.length - 1];
    assert.ok(green);
    const job = green.run.jobs[1];
    assert.ok(job);
    job.conclusion = 'failure';
    const problems = finalStateProblems(painted, facts, docs);
    assert.ok(
      problems.some((p) => p.includes('concludes success while')),
      'the run-level conclusion must agree with the per-job conclusions',
    );
    assert.ok(
      problems.some((p) => p.includes('non-success jobs and lists')),
      'and the declared non-success count must agree with the list',
    );
  });

  test('the HEAD relation is decided by git, not by the record', () => {
    /*
     * The check that would have caught R5 the moment `174c789` was pushed. The record is
     * left declaring that the evidence commit is the tip; git is told that a commit sits
     * on top of it; and the gate must refuse the declaration rather than the history.
     */
    const ahead = cloneFacts();
    ahead.aheadOfEvidence = ['a'.repeat(40)];
    /*
     * FBL-020-R6: the record itself now declares HEAD_IS_AHEAD_OF_THE_EVIDENCE_COMMIT,
     * because the R6 commit sits on top of the commit the recorded run measured. The
     * property under test is unchanged — git decides, not the record — so the CLAIM is
     * staged here rather than read from a record that happens to agree with git today.
     */
    const claimsTip = {
      ...state,
      repository_head_relation: 'HEAD_IS_THE_EVIDENCE_COMMIT' as const,
    };
    assert.ok(
      finalStateProblems(claimsTip, ahead, docs).some((p) =>
        p.includes('commit(s) sit on top of the evidence commit'),
      ),
      'a record claiming the evidence commit is the tip must fail once it is not',
    );

    /*
     * The reverse direction. Both sides are STAGED for the same reason as above: the real
     * git facts now genuinely have HEAD ahead of the evidence commit, so a record declaring
     * AHEAD agrees with them and raises nothing. The property is that the gate refuses a
     * declaration git contradicts — in either direction — not that today's tree happens to
     * contradict one of them.
     */
    const atTip = cloneFacts();
    atTip.aheadOfEvidence = [];
    const behind = clone();
    behind.repository_head_relation = 'HEAD_IS_AHEAD_OF_THE_EVIDENCE_COMMIT';
    assert.ok(
      finalStateProblems(behind, atTip, docs).some((p) =>
        p.includes('is empty — the evidence commit IS the tip'),
      ),
      'and the declaration is checked in BOTH directions',
    );
  });

  test('the gate SURVIVES a real --depth 1 clone, and says which limbs did not run', (t) => {
    /*
     * FBL-020-R6 gate finding C2, proved rather than reasoned about.
     *
     * `actions/checkout` without `fetch-depth` produces a `--depth 1` checkout, and this
     * gate exited 1 on one: every history limb asked git for an object the checkout had
     * not fetched. Four earlier failures in this order came from the same shape of
     * assumption about what a CI checkout has, so this test does not simulate shallowness
     * — it makes a REAL shallow clone with git and runs the REAL gate against it.
     *
     * The clone carries the commit's tree, and the FBL-020-R6 documents are uncommitted by
     * order, so the working tree's governed documents are staged into the clone. That is
     * the CI condition once this work is committed: a shallow checkout whose files are the
     * ones under test.
     */
    if (!IN_GIT_CHECKOUT) {
      t.skip('no .git here — mutation-kill copies the tree without it');
      return;
    }
    const branch = execFileSync('git', ['branch', '--show-current'], {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim();
    assert.notEqual(branch, '', 'a detached HEAD cannot be cloned by branch name');

    const scratch = mkdtempSync(join(tmpdir(), 'fbl020-shallow-'));
    const clone_ = join(scratch, 'checkout');
    try {
      execFileSync(
        'git',
        ['clone', '--quiet', '--depth', '1', '--branch', branch, `file://${ROOT}`, clone_],
        { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' },
      );

      // The premise, asserted rather than assumed: git really did make this shallow, and
      // it really does hold ONE commit. A test that ran against a full clone by accident
      // would prove nothing at all.
      assert.equal(
        execFileSync('git', ['rev-parse', '--is-shallow-repository'], {
          cwd: clone_,
          encoding: 'utf8',
        }).trim(),
        'true',
        'the clone must be shallow',
      );
      assert.equal(
        execFileSync('git', ['rev-list', '--count', 'HEAD'], {
          cwd: clone_,
          encoding: 'utf8',
        }).trim(),
        '1',
        'a --depth 1 clone holds exactly one commit',
      );

      /*
       * THE CLONE IS SEEDED WITH THE TREE UNDER TEST, NOT LEFT AT THE LAST COMMIT — and
       * `ALSO_SCANNED` belongs in that seed for the same reason `GOVERNED` always did.
       *
       * The clone is made from `file://ROOT`, so without this it holds whatever was last
       * COMMITTED. That makes the test measure the previous commit while the author is
       * asking about the tree they are about to ship: it can fail on a tree that is correct
       * and — far worse — pass on one that is not. `GOVERNED` and the record were already
       * copied for that reason. When FBL-020-R6 widened the forbidden-sentence scan to
       * `ALSO_SCANNED`, those files were left out of the seed, and the omission surfaced the
       * moment a withdrawn sentence was removed from one of them: the gate went green against
       * the working tree and red against the clone, over a file the tree had already fixed.
       *
       * `existsSync` because the surface is deliberately optional — a fixture or a narrower
       * checkout may not carry every one of these files, which is exactly why the gate's own
       * loader skips the ones it cannot read.
       */
      for (const file of [
        ...FINAL_STATE_GOVERNED,
        FINAL_STATE_RECORD,
        ...FINAL_STATE_ALSO_SCANNED,
      ]) {
        if (!existsSync(join(ROOT, file))) continue;
        mkdirSync(join(clone_, file, '..'), { recursive: true });
        copyFileSync(join(ROOT, file), join(clone_, file));
      }

      const output = execFileSync(
        'npx',
        ['tsx', join(ROOT, 'scripts', 'check-final-state.ts'), '--root', clone_],
        { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32' },
      );

      assert.ok(
        output.includes('git history: SHALLOW'),
        `the gate must SAY the clone is shallow, got:\n${output}`,
      );
      for (const check of HISTORY_DEPENDENT_CHECKS) {
        assert.ok(
          output.includes(`not run: ${check.id}`),
          `a limb that could not run must be named, not dropped: ${check.id}`,
        );
      }
      assert.ok(
        output.includes('The delivery documents state ONE final state'),
        'and the gate must PASS: a fetch depth is not a finding about the delivery',
      );
      /*
       * The limb R5 was rejected over is DERIVED from HEAD alone, so it still runs here.
       * Assert that a relation is DECIDED, not which one: the record legitimately reads
       * HEAD_IS_AHEAD_OF_THE_EVIDENCE_COMMIT between a code-bearing commit and its own run,
       * and pinning the other value made this test a statement about today rather than
       * about the property.
       */
      assert.ok(
        output.includes('HEAD_IS_THE_EVIDENCE_COMMIT') ||
          output.includes('HEAD_IS_AHEAD_OF_THE_EVIDENCE_COMMIT'),
        'the head relation must still be decided on a shallow clone',
      );
      assert.ok(
        !HISTORY_DEPENDENT_CHECKS.some((c) => c.id === 'head_relation'),
        'the head relation must never be listed as a limb a shallow clone cannot run',
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  /*
   * FBL-020-R6 — THE SAME TRAP, ITS SIXTH APPEARANCE, AND A THIRD ENVIRONMENT.
   *
   * "What a developer tree has and another checkout does not" has been gitignored artifacts
   * four times and a shallow clone once. This is the sixth: a tree copy that is NOT A GIT
   * REPOSITORY. `scripts/mutation-kill.ts` builds one on every run — `isolatedCopy()`
   * excludes `.git` deliberately — and then runs whole batteries inside it. `readGitFacts`
   * called `git rev-parse HEAD` unguarded, so every test that drives the final-state gate
   * was red in that copy BEFORE any mutation was applied. The runner reported the affected
   * mutation INCONCLUSIVE rather than crediting a kill, which is the correct behaviour and
   * which fails the step; run 32452596992 died there with a battery that was otherwise 652
   * for 652.
   *
   * A NON-REPOSITORY IS NOT A HARSHER SHALLOW CLONE. A shallow clone ANSWERS
   * `git rev-parse HEAD` and can still decide the head relation from that one commit. A
   * non-repository answers nothing, so the head relation joins the history limbs in the
   * not-run list. Collapsing the two would be the absence-vs-silence mistake this delivery
   * has already had to correct twice in the census, and it is asserted apart here.
   *
   * Built the way the runner builds it, and NOT by reasoning about it — the order says so
   * in as many words, and C2 was found exactly because a shallow clone had been reasoned
   * about rather than made.
   */
  test('the gate SURVIVES a tree copy with NO .git, and says the head relation did not run', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'fbl020-nogit-'));
    const copy = join(scratch, 'tree');
    try {
      cpSync(ROOT, copy, {
        recursive: true,
        filter: (src: string) => {
          const rel = src.slice(ROOT.length).replace(/\\/g, '/').replace(/^\//, '');
          if (rel === '') return true;
          const first = rel.split('/')[0] as string;
          // The same exclusions scripts/mutation-kill.ts applies, `.git` among them.
          if (['node_modules', '.git', 'artifacts', 'dist'].includes(first)) return false;
          return !rel.endsWith('.tsbuildinfo');
        },
      });

      // The premise, asserted rather than assumed — as with the shallow clone above. A copy
      // that turned out to be inside a repository would prove nothing at all.
      assert.ok(!existsSync(join(copy, '.git')), 'the copy must not carry a .git directory');
      assert.throws(
        () =>
          execFileSync('git', ['rev-parse', 'HEAD'], {
            cwd: copy,
            encoding: 'utf8',
            stdio: 'pipe',
          }),
        'git must not resolve a HEAD here, or this tests the wrong thing',
      );

      const output = execFileSync(
        'npx',
        ['tsx', join(ROOT, 'scripts', 'check-final-state.ts'), '--root', copy],
        { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32' },
      );

      assert.ok(
        output.includes('git history: ABSENT'),
        `the gate must SAY there is no repository, got:\n${output}`,
      );
      assert.ok(
        output.includes('not run: head_relation'),
        'the head relation cannot be decided without a HEAD, and must be NAMED as unrun ' +
          'rather than silently skipped — the whole point of the shallow-clone limb list',
      );
      for (const check of HISTORY_DEPENDENT_CHECKS) {
        assert.ok(
          output.includes(`not run: ${check.id}`),
          `a limb that could not run must be named, not dropped: ${check.id}`,
        );
      }
      assert.ok(
        output.includes('The delivery documents state ONE final state'),
        'and the gate must PASS: a missing .git is not a finding about the delivery',
      );
      assert.ok(
        !output.includes('fatal:'),
        'git\'s own "fatal: not a git repository" must not leak into a PASSING gate\'s ' +
          'output, where a reader would read it as a failure',
      );
      /*
       * The half that must NOT be skipped. A non-repository can still read every document,
       * so the document checks — which are the entire reason a battery runs inside a tree
       * copy — have to keep running. A gate that answered "no git, nothing to say" would
       * pass on a tree whose delivery documents contradicted the record.
       */
      const broken = JSON.parse(readFileSync(join(copy, FINAL_STATE_RECORD), 'utf8'));
      broken.submission.status = 'SUBMITTABLE AS COMPLETE';
      writeFileSync(join(copy, FINAL_STATE_RECORD), JSON.stringify(broken, null, 2));
      assert.throws(
        () =>
          execFileSync(
            'npx',
            ['tsx', join(ROOT, 'scripts', 'check-final-state.ts'), '--root', copy],
            { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32', stdio: 'pipe' },
          ),
        'the DOCUMENT half must still bite where there is no repository, or a tree copy ' +
          'would be a place delivery documents go unchecked',
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test('a budget breach cannot be recorded as anything but a VIOLATION', () => {
    const softened = clone();
    softened.commit_budget.verdict = 'DISCLOSED';
    assert.ok(
      finalStateProblems(softened, facts, docs).some((p) =>
        p.includes('is a VIOLATION; the record says'),
      ),
      'three commits against a budget of one is a violation, whatever the record calls it',
    );

    const cured = clone();
    cured.commit_budget.disclosure_does_not_cure_the_violation = false;
    assert.ok(
      finalStateProblems(cured, facts, docs).some((p) => p.includes('disclosure does not cure')),
      'and the record must carry the ruling that disclosure does not cure it',
    );
  });

  test('§3.1 being OPEN forces the submission status, and the status vocabulary is closed', () => {
    const claimed = clone();
    claimed.submission.status = 'SUBMITTABLE AS COMPLETE';
    claimed.submission.blocking = [];
    assert.ok(
      finalStateProblems(claimed, facts, docs).some((p) =>
        p.includes('while §3.1 is OPEN the revision MAY NOT be submitted as complete'),
      ),
      'FBL-020-R6 §4.6: an OPEN §3.1 forbids a complete submission',
    );

    const invented = clone();
    invented.submission.status = 'MOSTLY DONE' as FinalState['submission']['status'];
    assert.ok(
      finalStateProblems(invented, facts, docs).some((p) => p.includes('which is not one of')),
      'the status vocabulary is closed',
    );

    const silent = clone();
    silent.submission.blocking = [];
    assert.ok(
      finalStateProblems(silent, facts, docs).some((p) => p.includes('must name what blocks it')),
      'a NOT SUBMITTABLE status must say what blocks it',
    );
  });

  test('the record must QUOTE every sentence the gate refuses, and refuse every one it quotes', () => {
    /*
     * withdrawn_claims is where the corrections stay legible: deleting a false sentence
     * leaves a reviewer holding the old document with nothing to match. The list is held
     * to FORBIDDEN in both directions, so it can neither go quiet nor claim a withdrawal
     * that nothing enforces.
     */
    const dropped = clone();
    dropped.withdrawn_claims = dropped.withdrawn_claims.slice(1);
    assert.ok(
      finalStateProblems(dropped, facts, docs).some((p) => p.includes('among withdrawn_claims')),
      'a refused sentence that is nowhere quoted must be reported',
    );

    const invented = clone();
    invented.withdrawn_claims = [
      ...invented.withdrawn_claims,
      'a claim nothing in the gate refuses',
    ];
    assert.ok(
      finalStateProblems(invented, facts, docs).some((p) =>
        p.includes('which no FORBIDDEN rule refuses'),
      ),
      'and a recorded withdrawal with no rule behind it must be reported',
    );
  });
  test('the gate reads NO artifact, and runs correctly with artifacts/ ABSENT', () => {
    /*
     * THE ASYMMETRY THAT HAS NOW COST THIS ORDER FOUR FAILURES. `artifacts/` is gitignored,
     * so a developer tree has it and a fresh CI checkout does not. Anything reading it
     * checks a different thing depending on where it runs.
     *
     * Two independent assertions, because either alone is weak: the SOURCE names no path
     * under `artifacts/`, and the whole pipeline — record, git facts and documents — is
     * re-read and re-checked with the directory MOVED ASIDE and restored afterwards.
     */
    const source = readFileSync(join(ROOT, 'scripts', 'check-final-state.ts'), 'utf8');
    const reads = source
      .split('\n')
      .filter((line) => /artifacts\//.test(line) && !line.trimStart().startsWith('*'));
    assert.deepEqual(reads, [], 'the final-state gate must name no path under artifacts/');

    const live = join(ROOT, 'artifacts');
    const parked = join(ROOT, `artifacts-parked-${process.pid}`);
    const wasPresent = existsSync(live);
    if (wasPresent) renameSync(live, parked);
    try {
      assert.equal(existsSync(live), false, 'the directory must really be absent for this check');
      const reread = readFinalState();
      assert.deepEqual(
        finalStateProblems(reread, factsFor(reread), readFinalStateDocuments()),
        [],
        'the gate must reach the same verdict with artifacts/ absent',
      );
    } finally {
      if (wasPresent) renameSync(parked, live);
    }
    assert.equal(existsSync(live), wasPresent, 'and the directory must be put back');
  });
});
