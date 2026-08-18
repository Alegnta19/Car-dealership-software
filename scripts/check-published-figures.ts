/**
 * FBL-020-R5 §3.3/§3.6 — A PUBLISHED FIGURE MUST DERIVE FROM ITS ARTIFACT.
 *
 *   npx tsx scripts/check-published-figures.ts            # the gate
 *   npx tsx scripts/check-published-figures.ts --write    # regenerate the spans
 *   npx tsx scripts/check-published-figures.ts --list     # the derivation table
 *
 * ── THE CLASS THIS EXISTS TO CLOSE ──────────────────────────────────────────
 *
 * Three consecutive revisions were rejected, in part, for the same defect wearing a
 * different number each time. The delivery report and the requirement map were written
 * by hand while the runs that produce their figures were still moving, so a figure was
 * true when it was typed and false when it was read:
 *
 *   * the suite total was published as 567/58 in the report and as 554/58 in the map;
 *   * the mutation registry was published as "44 declared, 44 killed, 0 survived" in
 *     `artifacts/mutation-kill.json` and as "the last complete run covered 34" in the
 *     report and the map — a report UNDERSTATING a mandatory §4 gate;
 *   * `MINIMUM_TESTS` was published at 554 in the map and held 567 in the source;
 *   * the documentation battery was published at 18 tests and declared 20.
 *
 * Every individual gate was green each time. Nothing compared a number in a document
 * with the run or the constant that produced it. `scripts/check-census-prose.ts` does
 * exactly that comparison for ONE figure — the census position — and this file is that
 * pattern generalised to every volatile figure in the delivery documents.
 *
 * ── HOW A FIGURE IS BOUND TO ITS SOURCE ─────────────────────────────────────
 *
 * 1. THE REGISTRY. `FIGURES` names every figure the delivery documents publish that a
 *    run or a script produces, and says where its authoritative value is read from: a
 *    checked-in constant, a JSON artifact a CI step writes, a count over a file on
 *    disk, or a digest. Nothing in the registry is retyped — every value is READ.
 *
 * 2. SPANS. Each occurrence in a Markdown document is wrapped:
 *
 *        <!--fig:suite_tests-->567<!--/fig-->
 *
 *    The comment is invisible in rendered Markdown, the gate compares the span's text
 *    with the source value, and `--write` rewrites every span from its source. That is
 *    the "quote it from the artifact at generation time" limb of the order.
 *
 * 3. RESTATEMENTS. A span only binds the text inside it, and the four figures that sank
 *    three revisions were all published in PROSE, outside any marked region. So each
 *    `RESTATEMENTS` entry is a shape the documents actually use — `44 mutations
 *    declared`, `MINIMUM_TESTS = 554`, `floors 567 / 58` — and EVERY match of that
 *    shape, anywhere in a governed document, span or no span, must carry the
 *    authoritative value. This is the limb that closes the class rather than the
 *    instances: a stale figure written in a new sentence still fails.
 *
 * 4. THE HISTORICAL EXEMPTION, DECLARED AND COUNTED. §9 of the delivery report records
 *    R3's and R4's in-CI figures on purpose, and those numbers describe other trees.
 *    Restatement scanning skips text between `<!--fig:historical:start-->` and
 *    `<!--fig:historical:end-->`, and a single superseded value quoted inline is written
 *    `<!--fig:quoted-->34<!--/fig-->`. Both are REPORTED by this gate — see
 *    `exemptions` — and `tests/delivery-documentation.test.ts` pins how many there may
 *    be, so the escape hatch cannot quietly widen.
 *
 * 5. WHAT NO GATE CAN CHECK IS LABELLED. `UNCHECKABLE` holds the figures this repository
 *    publishes but cannot derive — the Version 2.0 blueprint's byte size and the three
 *    quality ceilings, which are readable only in a document that is not in this
 *    repository, and the working-tree changed-path counts, which depend on a git history
 *    the gate is not given. Each declares the exact label that must appear beside it,
 *    and the gate FAILS if the document publishes the figure without the label.
 *
 * ── ARTIFACTS ARE NOT COMMITTED ─────────────────────────────────────────────
 *
 * `artifacts/` is gitignored, so an artifact-sourced figure is unreadable on a clean
 * checkout. Those figures are reported as `unreadable` and skipped rather than failed;
 * the CI step that runs this gate is ordered AFTER the steps that write the artifacts,
 * so in CI they are always read. `tests/delivery-documentation.test.ts` drives the pure
 * comparison against staged values in both directions, which is what proves the gate can
 * fail without depending on an artifact being present.
 */
import { createHash } from 'crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { bareCitationFiles, loadRequirementMap } from './check-requirement-map';

const ROOT = join(__dirname, '..');

/** Where an authoritative value is read from. */
export type FigureSource =
  /** `export const NAME = 123;` in a checked-in TypeScript module. */
  | { kind: 'constant'; file: string; name: string }
  /** A path into a JSON document. `artifact: true` marks it as gitignored evidence. */
  | { kind: 'json'; file: string; path: string[]; artifact?: boolean }
  /** How many times a pattern occurs in a file — a declaration count. */
  | { kind: 'count'; file: string; pattern: string }
  /** The first capture group of a pattern in a file. */
  | { kind: 'capture'; file: string; pattern: string }
  /** How many keys a JSON object has. */
  | { kind: 'keys'; file: string; path: string[] }
  /** The file's byte length. */
  | { kind: 'bytes'; file: string }
  /** SHA-256 of the file, optionally of its canonical-LF bytes. */
  | { kind: 'sha256'; file: string; canonicalLf?: boolean }
  /** A value computed by a named reader below, so the gate cannot drift from the tool. */
  | { kind: 'computed'; name: 'map_requirements' | 'map_clauses' | 'map_tests' | 'map_residue' };

export interface Figure {
  id: string;
  /** What the figure is, in the words the derivation table prints. */
  what: string;
  source: FigureSource;
}

/** A figure that is published but that no gate in this repository can derive. */
export interface UncheckableFigure {
  id: string;
  what: string;
  /** Why no gate can check it. Printed by `--list`. */
  why: string;
  /** The exact label that must appear in each document that publishes it. */
  label: string;
  files: string[];
}

/**
 * A sentence shape the documents use to state a figure. Every match in every governed
 * document must carry the authoritative value, whether or not it sits inside a span.
 */
export interface Restatement {
  id: string;
  what: string;
  /** Source of a global regular expression; one capture group per entry in `figures`. */
  pattern: string;
  figures: string[];
}

export const REPORT = 'docs/FBL-020-DELIVERY-REPORT.md';
export const MAP = 'docs/FBL-020-R5-REQUIREMENT-MAP.json';
export const PROVENANCE = 'docs/orders/BLUEPRINT-PROVENANCE.md';
export const LIMITS = 'docs/identity/KNOWN-LIMITATIONS.md';
export const README = 'README.md';
export const PARSER = 'scripts/parse-test-summary.ts';
export const ORDER = 'docs/orders/FBL-020-R5.md';

/** The documents this gate governs. A figure outside them is nobody's published figure. */
export const GOVERNED = [REPORT, MAP, PROVENANCE, LIMITS, README] as const;

export const FIGURES: Figure[] = [
  // ── the battery, as the summary gate itself recorded it ────────────────────────
  {
    id: 'suite_tests',
    what: 'tests executed by the full battery',
    source: { kind: 'json', file: 'artifacts/test-summary.json', path: ['tests'], artifact: true },
  },
  {
    id: 'suite_suites',
    what: 'suites executed by the full battery',
    source: { kind: 'json', file: 'artifacts/test-summary.json', path: ['suites'], artifact: true },
  },
  {
    id: 'suite_passed',
    what: 'tests that passed',
    source: { kind: 'json', file: 'artifacts/test-summary.json', path: ['passed'], artifact: true },
  },
  {
    id: 'observed_ok',
    what: 'anchored `ok` assertion lines the parser counted in the raw log',
    source: {
      kind: 'json',
      file: 'artifacts/test-summary.json',
      path: ['observed_ok_lines'],
      artifact: true,
    },
  },
  {
    id: 'observed_not_ok',
    what: 'anchored `not ok` assertion lines the parser counted in the raw log',
    source: {
      kind: 'json',
      file: 'artifacts/test-summary.json',
      path: ['observed_not_ok_lines'],
      artifact: true,
    },
  },

  // ── the declared floors, read out of the constants they live in ────────────────
  {
    id: 'floor_tests',
    what: 'MINIMUM_TESTS, the declared test floor',
    source: { kind: 'constant', file: PARSER, name: 'MINIMUM_TESTS' },
  },
  {
    id: 'floor_suites',
    what: 'MINIMUM_SUITES, the declared suite floor',
    source: { kind: 'constant', file: PARSER, name: 'MINIMUM_SUITES' },
  },
  {
    id: 'order_floor_tests',
    what: "ORDER_MINIMUM_TESTS, the order's own test floor as the constant holds it",
    source: { kind: 'constant', file: PARSER, name: 'ORDER_MINIMUM_TESTS' },
  },
  {
    id: 'order_floor_suites',
    what: "ORDER_MINIMUM_SUITES, the order's own suite floor as the constant holds it",
    source: { kind: 'constant', file: PARSER, name: 'ORDER_MINIMUM_SUITES' },
  },

  // ── the two floor statements the ORDER TEXT itself makes ───────────────────────
  {
    id: 'order_text_floor_tests',
    what: 'the test floor §4 of the order fixes, read out of the order file',
    source: { kind: 'capture', file: ORDER, pattern: 'existing (\\d+)-test/\\d+-suite floor' },
  },
  {
    id: 'order_text_floor_suites',
    what: 'the suite floor §4 of the order fixes, read out of the order file',
    source: { kind: 'capture', file: ORDER, pattern: 'existing \\d+-test/(\\d+)-suite floor' },
  },
  {
    id: 'order_appendix_tests',
    what: 'the test count Appendix A item 9 of the order restates',
    source: { kind: 'capture', file: ORDER, pattern: 'reported (\\d+) tests/\\d+ suites' },
  },
  {
    id: 'order_appendix_suites',
    what: 'the suite count Appendix A item 9 of the order restates',
    source: { kind: 'capture', file: ORDER, pattern: 'reported \\d+ tests/(\\d+) suites' },
  },
  {
    id: 'order_clauses',
    what: 'clauses the order register holds verbatim',
    source: { kind: 'count', file: ORDER, pattern: '\\n\\*\\*§[0-9.]+ — ' },
  },
  {
    id: 'order_sha256',
    what: "the order file's canonical-LF SHA-256",
    source: { kind: 'sha256', file: ORDER, canonicalLf: true },
  },

  // ── the mutation registry, and the run that exercised it ───────────────────────
  {
    id: 'mutations_declared',
    what: 'mutations the runner registered for the run',
    source: {
      kind: 'json',
      file: 'artifacts/mutation-kill.json',
      path: ['mutations_total'],
      artifact: true,
    },
  },
  {
    id: 'mutations_killed',
    what: 'mutations killed',
    source: {
      kind: 'json',
      file: 'artifacts/mutation-kill.json',
      path: ['mutations_killed'],
      artifact: true,
    },
  },
  {
    id: 'mutations_survived',
    what: 'mutations that survived',
    source: {
      kind: 'json',
      file: 'artifacts/mutation-kill.json',
      path: ['mutations_survived'],
      artifact: true,
    },
  },
  {
    id: 'mutations_registered',
    what: 'mutation ids declared in the runner source',
    source: { kind: 'count', file: 'scripts/mutation-kill.ts', pattern: "\\n    id: '" },
  },

  // ── the requirement map, counted the way its own checker counts ────────────────
  {
    id: 'map_requirements',
    what: 'requirement rows in the map',
    source: { kind: 'computed', name: 'map_requirements' },
  },
  {
    id: 'map_clauses',
    what: 'clauses in the map inventory',
    source: { kind: 'computed', name: 'map_clauses' },
  },
  {
    id: 'map_tests',
    what: 'test citations the map makes',
    source: { kind: 'computed', name: 'map_tests' },
  },
  {
    id: 'map_residue',
    what: 'source files carrying a bare blueprint §14 citation',
    source: { kind: 'computed', name: 'map_residue' },
  },

  // ── the 057 reconciliation inventory ───────────────────────────────────────────
  {
    id: 'inventory_statements',
    what: 'statements the inventory found in 057',
    source: {
      kind: 'json',
      file: 'artifacts/reconciliation-inventory-057.json',
      path: ['totals', 'statements_in_057'],
      artifact: true,
    },
  },
  {
    id: 'inventory_reconciliations',
    what: 'reconciliations in 057',
    source: {
      kind: 'json',
      file: 'artifacts/reconciliation-inventory-057.json',
      path: ['totals', 'reconciliations'],
      artifact: true,
    },
  },
  {
    id: 'inventory_controlled',
    what: 'reconciliations covered by a negative control',
    source: {
      kind: 'json',
      file: 'artifacts/reconciliation-inventory-057.json',
      path: ['totals', 'reconciliations_covered_by_a_negative_control'],
      artifact: true,
    },
  },
  {
    id: 'inventory_not_load_bearing',
    what: 'reconciliations declared not load-bearing on a pre-057 fixture',
    source: {
      kind: 'json',
      file: 'artifacts/reconciliation-inventory-057.json',
      path: ['totals', 'reconciliations_declared_not_load_bearing'],
      artifact: true,
    },
  },
  {
    id: 'inventory_refusal_guards',
    what: 'reconciliations that are refusal guards',
    source: {
      kind: 'json',
      file: 'artifacts/reconciliation-inventory-057.json',
      path: ['totals', 'reconciliations_that_are_refusal_guards'],
      artifact: true,
    },
  },
  {
    id: 'inventory_unaccounted',
    what: 'reconciliations nothing accounts for',
    source: {
      kind: 'json',
      file: 'artifacts/reconciliation-inventory-057.json',
      path: ['totals', 'reconciliations_unaccounted'],
      artifact: true,
    },
  },
  {
    id: 'negative_controls',
    what: 'negative controls declared by their checked-in anchors',
    source: { kind: 'keys', file: 'architecture/negative-control-anchors-057.json', path: [] },
  },

  // ── the quality ratchet baselines ──────────────────────────────────────────────
  {
    id: 'ratchet_tsc',
    what: 'tsc-strict findings the ratchet baseline holds',
    source: { kind: 'json', file: 'quality-baselines.json', path: ['tsc-strict', 'total'] },
  },
  {
    id: 'ratchet_eslint',
    what: 'eslint findings the ratchet baseline holds',
    source: { kind: 'json', file: 'quality-baselines.json', path: ['eslint', 'total'] },
  },
  {
    id: 'ratchet_format',
    what: 'format findings the ratchet baseline holds',
    source: { kind: 'json', file: 'quality-baselines.json', path: ['format', 'total'] },
  },

  // ── the documentation battery's own size ───────────────────────────────────────
  {
    id: 'doc_battery_tests',
    what: 'tests declared by tests/delivery-documentation.test.ts',
    source: {
      kind: 'count',
      file: 'tests/delivery-documentation.test.ts',
      pattern: "\\n  test\\('",
    },
  },

  // ── the two blueprints ─────────────────────────────────────────────────────────
  {
    id: 'blueprint_v1_bytes',
    what: 'byte length of the Version 1.0 blueprint checked in here',
    source: { kind: 'bytes', file: 'docs/orders/Car_Dealership_SaaS_Architecture_Blueprint.docx' },
  },
  {
    id: 'blueprint_v1_sha256',
    what: 'SHA-256 of the Version 1.0 blueprint checked in here',
    source: { kind: 'sha256', file: 'docs/orders/Car_Dealership_SaaS_Architecture_Blueprint.docx' },
  },
  {
    id: 'blueprint_v2_sha256',
    what: "the Version 2.0 blueprint's SHA-256 as the order text states it",
    source: {
      kind: 'capture',
      file: ORDER,
      pattern: 'claimed SHA-256\\s*\\n?\\s*([0-9a-f]{64})',
    },
  },
];

export const UNCHECKABLE: UncheckableFigure[] = [
  {
    id: 'blueprint_v2_bytes',
    what: "the Version 2.0 blueprint's byte length, 95,325",
    why:
      'the file is not in this repository and the order text does not state its size — only ' +
      'its SHA-256. The size is the operator\u2019s attestation from a copy this project record ' +
      'does not contain.',
    label: 'NOT GATE-CHECKED: attested, and not derivable in this repository',
    files: [REPORT, PROVENANCE],
  },
  {
    id: 'quality_ceilings',
    what: 'the quality ceilings tsc-strict <=59, eslint <=136, format <=23',
    why:
      'that sentence occurs once, in Version 2.0 §14.3, and the Version 2.0 document is not in ' +
      'this repository. FBL-020-R5 sets no ceiling and restates none, and no script in this ' +
      'tree has a ceiling concept.',
    label: 'NOT GATE-CHECKED: readable only in the Version 2.0 blueprint',
    files: [REPORT, PROVENANCE, LIMITS],
  },
  {
    id: 'changed_paths',
    what: 'the changed-path totals against the cumulative acceptance base',
    why:
      'they are git measurements over a history this gate is not given, and they move with ' +
      'every edit to the working tree. The report prints each command with its literal output ' +
      'instead, so a reader reproduces them rather than trusting them.',
    label: 'NOT GATE-CHECKED: reproduce with the commands printed above',
    files: [REPORT],
  },
];

export const RESTATEMENTS: Restatement[] = [
  {
    id: 'suite-totals',
    what: '"567 tests, 58 suites" — the battery total in prose',
    pattern: '(\\d+) tests?, (\\d+) suites?',
    figures: ['suite_tests', 'suite_suites'],
  },
  {
    id: 'suite-log',
    what: '"the real 599-test log"',
    pattern: 'the real (\\d+)-test log',
    figures: ['suite_tests'],
  },
  {
    id: 'suite-passed',
    what: '"599 passed, 0 failed"',
    pattern: '(\\d+) passed, 0 failed',
    figures: ['suite_passed'],
  },
  {
    id: 'observed-lines',
    what: "the parser's own observation counts, quoted from a run",
    pattern: 'observed_ok=(\\d+) observed_not_ok=(\\d+)',
    figures: ['observed_ok', 'observed_not_ok'],
  },
  {
    id: 'order-section-4-floor',
    what: 'the order’s §4 floor clause quoted in a document',
    pattern: 'existing (\\d+)-test/(\\d+)-suite floor',
    figures: ['order_text_floor_tests', 'order_text_floor_suites'],
  },
  {
    id: 'declared-floors',
    what: '"declared floors 567 / 58" in any of its spellings',
    pattern: 'floors?\\s+(?:of\\s+)?\\*{0,2}(\\d+)\\s*/\\s*(\\d+)\\*{0,2}',
    figures: ['floor_tests', 'floor_suites'],
  },
  {
    id: 'floor-constant-tests',
    what: 'MINIMUM_TESTS restated in a document',
    pattern: '(?<!ORDER_)MINIMUM_TESTS\\s*=\\s*(\\d+)',
    figures: ['floor_tests'],
  },
  {
    id: 'floor-constant-suites',
    what: 'MINIMUM_SUITES restated in a document',
    pattern: '(?<!ORDER_)MINIMUM_SUITES\\s*=\\s*(\\d+)',
    figures: ['floor_suites'],
  },
  {
    id: 'order-floor-constant-tests',
    what: 'ORDER_MINIMUM_TESTS restated in a document',
    pattern: 'ORDER_MINIMUM_TESTS\\s*=\\s*(\\d+)',
    figures: ['order_floor_tests'],
  },
  {
    id: 'order-floor-constant-suites',
    what: 'ORDER_MINIMUM_SUITES restated in a document',
    pattern: 'ORDER_MINIMUM_SUITES\\s*=\\s*(\\d+)',
    figures: ['order_floor_suites'],
  },
  {
    id: 'mutations-registry',
    what: '"44 mutations declared" / "44 mutations registered"',
    pattern: '(\\d+) mutations? (?:declared|registered)',
    figures: ['mutations_declared'],
  },
  {
    id: 'mutations-run',
    what: '"44 declared / 44 killed / 0 survived"',
    pattern: '(\\d+) declared / (\\d+) killed / (\\d+) survived',
    figures: ['mutations_declared', 'mutations_killed', 'mutations_survived'],
  },
  {
    id: 'map-counts',
    what: '"44 requirements, 29 clauses, 272 mapped test names"',
    pattern: '(\\d+) requirements, (\\d+) clauses, \\*{0,2}(\\d+)\\*{0,2} mapped test names',
    figures: ['map_requirements', 'map_clauses', 'map_tests'],
  },
  {
    id: 'map-checker-line',
    what: "the requirement-map checker's own printed key/values",
    pattern: 'requirements=(\\d+) clauses=(\\d+) mapped_tests=(\\d+)',
    figures: ['map_requirements', 'map_clauses', 'map_tests'],
  },
  {
    id: 'map-residue',
    what: 'citation_residue=3',
    pattern: 'citation_residue=(\\d+)',
    figures: ['map_residue'],
  },
  {
    id: 'inventory-line',
    what: '"107 statements in 057" and the reconciliation split',
    pattern:
      '\\*{0,2}(\\d+)\\*{0,2} statements in `057`; \\*{0,2}(\\d+)\\*{0,2} reconciliations = ' +
      '(\\d+) control-covered \\+ (\\d+) declared not-load-bearing \\+ \\*{0,2}(\\d+)\\*{0,2} refusal guards',
    figures: [
      'inventory_statements',
      'inventory_reconciliations',
      'inventory_controlled',
      'inventory_not_load_bearing',
      'inventory_refusal_guards',
    ],
  },
  {
    id: 'ratchet-line',
    what: '"tsc-strict 53 / eslint 123 / format 1"',
    pattern: 'tsc-strict (\\d+) / eslint (\\d+) / format (\\d+)',
    figures: ['ratchet_tsc', 'ratchet_eslint', 'ratchet_format'],
  },
  {
    id: 'doc-battery',
    what: '"returned tests/delivery-documentation.test.ts to 20 / 20 green"',
    pattern: 'tests/delivery-documentation\\.test\\.ts` to \\*{0,2}(\\d+) / (\\d+)\\*{0,2}',
    figures: ['doc_battery_tests', 'doc_battery_tests'],
  },
  {
    id: 'order-digest-citation',
    what: 'a SHA-256 quoted as the order file’s digest',
    pattern: 'docs/orders/FBL-020-R5\\.md[\\s\\S]{0,240}?`([0-9a-f]{64})`',
    figures: ['order_sha256'],
  },
];

// ── reading the sources ────────────────────────────────────────────────────────────

const readFile = (root: string, file: string): string => readFileSync(join(root, file), 'utf8');

function jsonAt(doc: unknown, path: string[]): unknown {
  let cursor: unknown = doc;
  for (const key of path) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

export interface FigureReading {
  values: Record<string, string>;
  /** id → why it could not be read. Artifact-sourced figures on a clean checkout. */
  unreadable: Record<string, string>;
}

/** Reads every registered figure's authoritative value from its own source. */
export function readFigures(root = ROOT): FigureReading {
  const values: Record<string, string> = {};
  const unreadable: Record<string, string> = {};

  for (const figure of FIGURES) {
    const s = figure.source;
    try {
      if (s.kind === 'computed') {
        const map = loadRequirementMap();
        if (s.name === 'map_requirements') values[figure.id] = String(map.requirements.length);
        else if (s.name === 'map_clauses') values[figure.id] = String(map.clause_inventory.length);
        else if (s.name === 'map_tests')
          values[figure.id] = String(
            map.requirements.reduce((n, r) => n + (r.tests ?? []).length, 0),
          );
        else values[figure.id] = String(bareCitationFiles(map).length);
        continue;
      }

      const path = join(root, s.file);
      if (!existsSync(path)) {
        unreadable[figure.id] = `${s.file} does not exist`;
        continue;
      }

      if (s.kind === 'bytes') {
        values[figure.id] = String(statSync(path).size);
      } else if (s.kind === 'sha256') {
        const bytes = readFileSync(path);
        const body = s.canonicalLf
          ? Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n'))
          : bytes;
        values[figure.id] = createHash('sha256').update(body).digest('hex');
      } else if (s.kind === 'json' || s.kind === 'keys') {
        const doc = JSON.parse(readFileSync(path, 'utf8')) as unknown;
        const at = jsonAt(doc, s.path);
        if (s.kind === 'keys') {
          if (at === null || typeof at !== 'object') {
            unreadable[figure.id] = `${s.file} has no object at ${s.path.join('.') || '<root>'}`;
            continue;
          }
          values[figure.id] = String(Object.keys(at as Record<string, unknown>).length);
        } else {
          if (at === undefined) {
            unreadable[figure.id] = `${s.file} has no value at ${s.path.join('.')}`;
            continue;
          }
          values[figure.id] = String(at);
        }
      } else if (s.kind === 'constant') {
        const text = readFileSync(path, 'utf8');
        const m = new RegExp(`export const ${s.name}\\s*=\\s*(\\d+)`).exec(text);
        if (m === null) {
          unreadable[figure.id] = `${s.file} declares no ${s.name}`;
          continue;
        }
        values[figure.id] = m[1] as string;
      } else if (s.kind === 'count') {
        const text = readFileSync(path, 'utf8');
        values[figure.id] = String(text.match(new RegExp(s.pattern, 'g'))?.length ?? 0);
      } else {
        const text = readFileSync(path, 'utf8');
        const m = new RegExp(s.pattern).exec(text);
        if (m === null || m[1] === undefined) {
          unreadable[figure.id] = `${s.file} does not match /${s.pattern}/`;
          continue;
        }
        values[figure.id] = m[1];
      }
    } catch (error) {
      unreadable[figure.id] = `${s.kind === 'computed' ? 'computed' : s.file}: ${String(error)}`;
    }
  }

  return { values, unreadable };
}

// ── the comparison ─────────────────────────────────────────────────────────────────

export const SPAN = /<!--fig:([a-z0-9_]+)-->([\s\S]*?)<!--\/fig-->/g;
export const QUOTED = /<!--fig:quoted-->([\s\S]*?)<!--\/fig-->/g;
export const HISTORICAL_START = '<!--fig:historical:start-->';
export const HISTORICAL_END = '<!--fig:historical:end-->';

/** Digits compare by value, so `88,931` and `88931` are the same figure. */
const normalize = (text: string): string => text.replace(/[,\s*_`]/g, '');

/**
 * Blanks the regions restatement scanning must not read — the declared historical block
 * and each inline quoted figure — preserving offsets so a reported index still lands.
 */
export function maskExempt(text: string): { masked: string; regions: number; quoted: number } {
  let masked = text;
  let regions = 0;
  for (;;) {
    const start = masked.indexOf(HISTORICAL_START);
    if (start === -1) break;
    const end = masked.indexOf(HISTORICAL_END, start);
    if (end === -1) break;
    const stop = end + HISTORICAL_END.length;
    masked = masked.slice(0, start) + ' '.repeat(stop - start) + masked.slice(stop);
    regions += 1;
  }
  let quoted = 0;
  masked = masked.replace(QUOTED, (whole) => {
    quoted += 1;
    return ' '.repeat(whole.length);
  });
  return { masked, regions, quoted };
}

export interface Exemptions {
  /** file → number of declared historical regions */
  historical: Record<string, number>;
  /** file → number of inline quoted figures */
  quoted: Record<string, number>;
}

/** One place a figure is published, with enough context for a message to name it. */
export interface Occurrence {
  file: string;
  /** The value as that place publishes it, before normalization. */
  shown: string;
  /** How it was published: the span marker, or the restatement rule that matched. */
  via: string;
  /** The surrounding text the message quotes. */
  context: string;
}

export interface FigureReport {
  problems: string[];
  exemptions: Exemptions;
  /** file → figure ids that appear as a span there */
  published: Record<string, string[]>;
  /** figure id → every place it is published, span or prose */
  occurrences: Record<string, Occurrence[]>;
}

/**
 * The comparison, as a pure function over the texts, so the suite can stage any value or
 * any document and watch the gate fail.
 */
export function figureProblems(
  values: Record<string, string>,
  documents: Record<string, string>,
): FigureReport {
  const problems: string[] = [];
  const exemptions: Exemptions = { historical: {}, quoted: {} };
  const published: Record<string, string[]> = {};
  const occurrences: Record<string, Occurrence[]> = {};
  const known = new Set(FIGURES.map((f) => f.id));

  const record = (id: string, o: Occurrence): void => {
    (occurrences[id] ??= []).push(o);
  };

  for (const [file, text] of Object.entries(documents)) {
    const { masked, regions, quoted } = maskExempt(text);
    exemptions.historical[file] = regions;
    exemptions.quoted[file] = quoted;
    published[file] = [];

    // 1. Every span names a registered figure and carries that figure's value.
    for (const match of text.matchAll(SPAN)) {
      const [, id, shown] = match as unknown as [string, string, string];
      if (id === 'quoted' || id === 'historical') continue;
      published[file].push(id);
      if (!known.has(id)) {
        problems.push(`${file}: <!--fig:${id}--> names no registered figure`);
        continue;
      }
      record(id, { file, shown, via: `span <!--fig:${id}-->`, context: match[0].slice(0, 90) });
      const expected = values[id];
      if (expected === undefined) continue; // unreadable source; the mutual check below still binds it
      if (normalize(shown) !== normalize(expected))
        problems.push(
          `${file}: <!--fig:${id}--> publishes ${JSON.stringify(shown)}, but ${id} reads ` +
            `${JSON.stringify(expected)} from its source`,
        );
    }

    // 2. Every restatement of a governed shape carries the authoritative value, whether
    //    or not anybody remembered to mark it.
    for (const rule of RESTATEMENTS) {
      const re = new RegExp(rule.pattern, 'g');
      for (const match of masked.matchAll(re)) {
        rule.figures.forEach((id, index) => {
          const shown = match[index + 1];
          if (shown === undefined) return;
          record(id, {
            file,
            shown,
            via: `restatement rule ${rule.id}`,
            context: match[0].slice(0, 90),
          });
          const expected = values[id];
          if (expected === undefined) return;
          if (normalize(shown) !== normalize(expected))
            problems.push(
              `${file}: ${JSON.stringify(match[0].slice(0, 90))} states ${id} as ` +
                `${JSON.stringify(shown)}, but its source reads ${JSON.stringify(expected)} ` +
                `(restatement rule ${rule.id})`,
            );
        });
      }
    }
  }

  /*
   * 3. TWO PLACES MAY NOT PUBLISH ONE FIGURE AT TWO VALUES — EVEN WHEN NO SOURCE IS
   *    READABLE.
   *
   * This limb exists because the gate had a hole exactly the shape of the defect it was
   * built to close. `artifacts/` is gitignored, so on any tree where the battery has not
   * been re-run the suite figures are `unreadable`, and limbs 1 and 2 SKIP an unreadable
   * figure. While that was true, the delivery report published the battery total as
   * "572 tests, 59 suites" in its §5 gate table and as 599 in the §5.4 derivation table,
   * and this gate printed "Every published figure agrees with its source." Four figures
   * published at two values is the class the order names; a gate that goes quiet whenever
   * its artifact is absent does not close it.
   *
   * So agreement WITH the source and agreement AMONG the publications are separate
   * requirements. The second needs no artifact: whatever the true value turns out to be,
   * the documents cannot be stating two different ones. When the source IS readable,
   * limbs 1 and 2 have already compared every occurrence against it — strictly stronger —
   * so this limb only speaks when it has something new to say.
   */
  for (const [id, seen] of Object.entries(occurrences)) {
    if (values[id] !== undefined) continue; // already compared against the source itself
    const distinct = [...new Set(seen.map((o) => normalize(o.shown)))];
    if (distinct.length <= 1) continue;
    const where = seen
      .map((o) => `${o.file} publishes ${JSON.stringify(o.shown)} (${o.via})`)
      .join('; ');
    problems.push(
      `${id} is published at ${distinct.length} different values and its source is not ` +
        `readable here, so nothing can say which is right — but they cannot all be: ${where}`,
    );
  }

  // 4. A figure no gate can derive must be labelled where it is published.
  for (const figure of UNCHECKABLE)
    for (const file of figure.files) {
      const text = documents[file];
      if (text === undefined) continue;
      if (!text.includes(figure.label))
        problems.push(
          `${file} publishes ${figure.id} but does not carry the label ` +
            `${JSON.stringify(figure.label)}; a figure no gate can check must say so where it appears`,
        );
    }

  return { problems, exemptions, published, occurrences };
}

/** Rewrites every span in a Markdown document from its source value. */
export function rewriteSpans(text: string, values: Record<string, string>): string {
  return text.replace(SPAN, (whole, id: string, shown: string) => {
    if (id === 'quoted' || id === 'historical') return whole;
    const value = values[id];
    if (value === undefined) return whole;
    // A figure published with thousands separators keeps them.
    const rendered =
      /^\d+$/.test(value) && /,/.test(shown) ? Number(value).toLocaleString('en-US') : value;
    return `<!--fig:${id}-->${rendered}<!--/fig-->`;
  });
}

function main(): void {
  const argv = process.argv.slice(2);
  const { values, unreadable } = readFigures();

  if (argv.includes('--list')) {
    console.log('id\tvalue\tsource\twhat');
    for (const f of FIGURES) {
      const where =
        f.source.kind === 'computed'
          ? `computed:${f.source.name}`
          : `${f.source.file}${'path' in f.source && f.source.path.length > 0 ? `#${f.source.path.join('.')}` : ''}`;
      console.log(
        `${f.id}\t${values[f.id] ?? `UNREADABLE (${unreadable[f.id] ?? ''})`}\t${where}\t${f.what}`,
      );
    }
    for (const f of UNCHECKABLE) console.log(`${f.id}\tNOT GATE-CHECKED\t—\t${f.what}: ${f.why}`);
    return;
  }

  const documents: Record<string, string> = {};
  for (const file of GOVERNED) documents[file] = readFile(ROOT, file);

  if (argv.includes('--write')) {
    for (const file of GOVERNED) {
      if (!file.endsWith('.md')) continue;
      const next = rewriteSpans(documents[file] as string, values);
      if (next !== documents[file]) {
        writeFileSync(join(ROOT, file), next);
        console.log(`rewrote spans in ${file}`);
      }
    }
    return;
  }

  const { problems, exemptions, published } = figureProblems(values, documents);
  const spans = Object.values(published).reduce((n, ids) => n + ids.length, 0);
  console.log(
    `figures=${FIGURES.length} readable=${Object.keys(values).length} ` +
      `unreadable=${Object.keys(unreadable).length} spans=${spans} ` +
      `historical_regions=${Object.values(exemptions.historical).reduce((a, b) => a + b, 0)} ` +
      `quoted_spans=${Object.values(exemptions.quoted).reduce((a, b) => a + b, 0)}`,
  );
  for (const [id, why] of Object.entries(unreadable))
    console.log(`  unreadable ${id}: ${why} (artifact-sourced figures need a run first)`);

  if (problems.length > 0) {
    console.error('Published figures disagree with the sources they are supposed to derive from:');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log('Every published figure agrees with its source.');
}

if (require.main === module) main();
