/**
 * FBL-020-R5 §3.5 — THE REQUIREMENT MAP CANNOT NAME A TEST THAT DOES NOT EXIST, AND
 * CANNOT LEAVE A CLAUSE OF THE ORDER UNMAPPED.
 *
 *   npx tsx scripts/check-requirement-map.ts [--out <file>]
 *
 * A requirement-to-test table written by hand is a claim, and a claim about tests decays
 * the moment one is renamed. R4's checker turned the table's PATHS and TEST NAMES into
 * something mechanically true. What it did not check is the direction the R5 review named:
 * the map validated what it happened to contain, and said nothing about whether the order
 * had clauses the map never mentioned, nor whether two requirements shared an id.
 *
 * So this checker enforces four things, and the last two are new:
 *
 *   * every named test file exists, and every named test NAME appears verbatim in it as a
 *     `test('…')` declaration; every named code path, fixture and script exists on disk;
 *     every named CI step exists as a step `name:` in `.github/workflows/ci.yml`; every
 *     named artifact is produced by that workflow; and every mapped battery is claimed by
 *     at least one requirement, so a test file cannot exist outside the map;
 *   * ID SHAPE AND UNIQUENESS — `R<4|5>-§<clause>-<slug>`, the revision matching the
 *     prefix, the clause matching the `clause` field, no id used twice;
 *   * CLAUSE COVERAGE — every clause in the map's `clause_inventory` is covered by at
 *     least one R5 requirement, and no requirement cites a clause the inventory does not
 *     declare. Omitting a requirement is therefore a FAILURE and not a silent gap;
 *   * THE INVENTORY AGREES WITH THE CHECKED-IN ORDER TEXT (§3.2). The clause register in
 *     `docs/orders/FBL-020-R5.md` and the inventory here must list the same clauses, and a
 *     clause the inventory marks as held verbatim must really be a clause heading in that
 *     file. The order text is an external anchor: the inventory cannot invent a clause.
 *
 * WHAT THIS CHECKER ESTABLISHES ABOUT COMPLETENESS, AND WHAT IT DOES NOT. The full R5
 * order text IS checked in at `docs/orders/FBL-020-R5.md` (§3.2), and its Part 3 register
 * lists every clause, so the inventory is held to that register in BOTH directions: a
 * clause the inventory invents is reported, and a clause the register carries that the
 * inventory omits is reported. An earlier revision of this comment said the repository did
 * not hold the order text and scoped the inventory to "the clauses this tree attests to";
 * that was an artefact of the order having been routed to the implementation waves one
 * section at a time, not a fact about the order, and it is withdrawn.
 *
 * What it still cannot decide is whether the checked-in order text has been SUPERSEDED
 * since it was issued. That is stated in the order file itself, under "What this repository
 * cannot establish", and a reviewer holding the live order is the authority on it.
 *
 * `tests/ci-gates.test.ts` runs this inside the suite, and the CI job runs it as its own
 * step so the artifact records the result independently of the suite.
 */
import { createHash } from 'crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
// The two mutation registries, imported so the R7 map's cited ids are checked
// against what the runners actually declare. Both modules guard their main()
// behind require.main, so importing them runs nothing.
import { MUTATIONS } from './mutation-kill';
import { CONTROLS as DB_CONTROLS, PREDICATES as DB_PREDICATES } from './database-control-mutations';

const ROOT = join(__dirname, '..');
const MAP_PATH = join(ROOT, 'docs', 'FBL-020-R5-REQUIREMENT-MAP.json');
const WORKFLOW_PATH = join(ROOT, '.github', 'workflows', 'ci.yml');
const ORDER_PATH = join(ROOT, 'docs', 'orders', 'FBL-020-R5.md');

/** The order this map is the map OF. */
export const MAP_ORDER = 'FBL-020-R5';

/**
 * Every battery the map must claim. Declared here rather than inferred from git so the
 * check works in a clean archive with no history, and so ADDING a battery without mapping
 * it is a failure rather than a silent omission.
 */
export const MAPPED_TEST_FILES = [
  'tests/audit-inventory-rules.test.ts',
  'tests/ci-gates.test.ts',
  'tests/delivery-documentation.test.ts',
  'tests/identity-evidence.test.ts',
  'tests/identity-lifecycle-audit.test.ts',
  'tests/identity-revocation.test.ts',
  'tests/login-admission-concurrency.test.ts',
  'tests/login-admission.test.ts',
  'tests/migration-census.test.ts',
  'tests/migration-ledger.test.ts',
  'tests/owned-mutations.test.ts',
  'tests/support-context.test.ts',
  'tests/support-expiry.test.ts',
] as const;

/** `R5-§3.5-requirement-map` — revision, clause, then a kebab slug. */
const ID_SHAPE = /^R([45])-§(\d+(?:\.\d+)?)-[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** `§0.1`, `§3`, `§5` — a clause id and nothing else. */
const CLAUSE_SHAPE = /^§\d+(?:\.\d+)?$/;

export interface BlueprintFacts {
  role: string;
  file: string;
  repository_path: string;
  present_in_repository: boolean;
  verification: string;
  bytes: number;
  file_sha256: string;
  title_line_1: string;
  title_line_2: string;
  version_line: string;
  version_label: string;
  section_governing_fbl_020: string;
  section_14_headings: Record<string, string>;
  attested_by?: string;
}

export interface GoverningDocumentRecord {
  citation_rule: string;
  provenance_record: string;
  reviewer_project_copies: string;
  consequence: string;
  requirement_not_readable_in_reviewer_copy: Record<string, string>;
  bare_blueprint_citation_residue: string[];
  governing: BlueprintFacts;
  superseded: BlueprintFacts;
  /**
   * The order the CURRENT phase is built under — Version 3.1, whose §14.3 is a third
   * thing again. Optional in the type because every record written before FBL-120 was
   * a two-document record, and a reader of one of those is not wrong, only earlier.
   */
  current_order?: BlueprintFacts;
}

export interface ClauseEntry {
  clause: string;
  title: string;
  text_held_verbatim: boolean;
  evidence: string;
}

export interface MappedRequirement {
  id: string;
  revision: string;
  clause: string;
  requirement: string;
  verdict?: string;
  proof_kind?: string;
  code?: string[];
  ci_steps?: string[];
  artifacts?: string[];
  tests: Array<{ file: string; name: string }>;
}

export interface RequirementMap {
  order: string;
  purpose: string;
  authority: {
    order_text: string;
    /** The canonical-LF SHA-256 of `order_text`, so the map names the authority it was built against. */
    order_text_sha256_canonical_lf: string;
    clause_inventory_scope: string;
    note: string;
    verdict_vocabulary: string;
  };
  governing_document: GoverningDocumentRecord;
  clause_inventory: ClauseEntry[];
  requirements: MappedRequirement[];
}

export function loadRequirementMap(): RequirementMap {
  return JSON.parse(readFileSync(MAP_PATH, 'utf8')) as RequirementMap;
}

/** Every `test('…')` name declared in a test file. */
export function declaredTestNames(file: string): Set<string> {
  const source = readFileSync(join(ROOT, file), 'utf8');
  const names = new Set<string>();
  // Both declaration shapes: a direct `test('name', …)` call, and a table-driven
  // suite whose rows carry `title: 'name'` and are fed to test() in a loop —
  // tests/login-admission.test.ts declares several of its R7 §2.2 cases that way,
  // and a scanner blind to the second shape would refuse a map that cites them.
  for (const m of source.matchAll(/\b(?:test\(\s*|title:\s*)'((?:[^'\\]|\\.)*)'/g)) {
    names.add((m[1] as string).replace(/\\'/g, "'").replace(/\\\\/g, '\\'));
  }
  /*
   * …and the same two shapes written with DOUBLE quotes, which is what a name
   * containing an apostrophe has to use. A scanner blind to that shape reports
   * a test as undeclared when the only thing wrong with it is English
   * punctuation, and a gate reading this would refuse a row that is genuinely
   * proven — which is how a checker teaches people to name tests badly.
   */
  for (const m of source.matchAll(/\b(?:test\(\s*|title:\s*)"((?:[^"\\]|\\.)*)"/g)) {
    names.add((m[1] as string).replace(/\\"/g, '"').replace(/\\\\/g, '\\'));
  }
  return names;
}

/** Every step `name:` in the CI workflow. */
export function workflowStepNames(): Set<string> {
  const yaml = readFileSync(WORKFLOW_PATH, 'utf8');
  const names = new Set<string>();
  for (const m of yaml.matchAll(/^\s+-\s+name:\s*(?:'([^']*)'|"([^"]*)"|(.*))$/gm)) {
    const raw = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (raw !== '') names.add(raw);
  }
  return names;
}

/**
 * The clauses the checked-in order text declares in its own register, `| §3.1 | … |`.
 * This is the external anchor for the inventory: the order document is the authority on
 * which clauses exist, not the map.
 */
export function orderTextClauses(): Set<string> {
  const order = readFileSync(ORDER_PATH, 'utf8');
  const clauses = new Set<string>();
  for (const m of order.matchAll(/^\|\s*(§\d+(?:\.\d+)?)\s*\|/gm)) clauses.add(m[1] as string);
  return clauses;
}

/** True when the order text carries this clause's own heading, e.g. `**§3.4 — replace…`. */
export function orderTextHoldsClauseHeading(clause: string): boolean {
  const order = readFileSync(ORDER_PATH, 'utf8');
  return order.includes(`**${clause} —`);
}

/**
 * The CANONICAL-LF SHA-256 of the checked-in order text — the same digest the operator's
 * `sed 's/\r$//' … | sha256sum` produces, so it is identical on Windows and in CI.
 *
 * Line endings are normalised because the working tree carries CRLF on Windows and LF in
 * CI; without that the digest would say the authority had moved every time the file was
 * checked out on the other platform, which is the opposite of what it is for.
 */
export function orderTextDigest(): string {
  const bytes = readFileSync(ORDER_PATH, 'utf8').replace(/\r\n/g, '\n');
  return createHash('sha256').update(bytes, 'utf8').digest('hex');
}

/** Source, test, script and migration files — everything that is not a delivery document. */
function nonDocumentFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry !== 'dist' && entry !== 'node_modules') walk(full);
      } else if (full.endsWith('.ts') || full.endsWith('.sql')) {
        files.push(full);
      }
    }
  };
  for (const tree of ['packages', 'apps']) {
    const base = join(ROOT, tree);
    if (!existsSync(base)) continue;
    for (const module of readdirSync(base)) walk(join(base, module, 'src'));
  }
  walk(join(ROOT, 'scripts'));
  walk(join(ROOT, 'tests'));
  walk(join(ROOT, 'migrations'));
  return files;
}

/**
 * The strings that make a blueprint citation unambiguous: a version label, either file
 * name, or either digest. Shared with `tests/delivery-documentation.test.ts` so the
 * documents and the source tree are judged by the same rule.
 */
export function citationQualifiers(map: RequirementMap = loadRequirementMap()): string[] {
  const { governing, superseded, current_order: current } = map.governing_document;
  return [
    'Version 1.0',
    'Version 2.0',
    'v1.0',
    'v2.0',
    governing.file,
    superseded.file,
    governing.file_sha256.slice(0, 8),
    superseded.file_sha256.slice(0, 8),
    // The third document qualifies exactly as the other two do, and only once the
    // record names it: a version label nobody has committed bytes for would let an
    // unqualified citation through on the strength of a string.
    ...(current === undefined
      ? []
      : [current.version_label, 'v3.1', current.file, current.file_sha256.slice(0, 8)]),
  ];
}

/** True when a citation's neighbourhood says WHICH document is meant. */
export function citationIsQualified(neighbourhood: string, qualifiers: string[]): boolean {
  return qualifiers.some((q) => neighbourhood.includes(q));
}

/**
 * Files outside the delivery documents that cite a blueprint section by number WITHOUT
 * saying which document. `§14.3` names FBL-000 in the superseded Version 1.0 document
 * and FBL-020-R2 in the governing Version 2.0 one — both committed here, so an unqualified citation is
 * ambiguous by construction.
 * The documents are required to disambiguate every citation
 * (`tests/delivery-documentation.test.ts`); source comments and the migration header cannot
 * all be edited safely — migration `057`'s digest is pinned in several places — so each
 * such FILE must instead be DECLARED as residue, and the declaration is checked in both
 * directions here.
 */
export function bareCitationFiles(map: RequirementMap = loadRequirementMap()): string[] {
  const qualifiers = citationQualifiers(map);
  const found = new Set<string>();
  for (const file of nonDocumentFiles()) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/§14\.\d/g)) {
      const at = m.index ?? 0;
      const around = text.slice(Math.max(0, at - 400), at + 400);
      if (!citationIsQualified(around, qualifiers)) {
        found.add(
          file
            .slice(ROOT.length + 1)
            .split('\\')
            .join('/'),
        );
      }
    }
  }
  return [...found].sort();
}

/**
 * The map is a PARAMETER, not a file read, so `tests/ci-gates.test.ts` can drive the
 * refusals: a check that has never been shown to fail is not known to be a check. R4's
 * version read the file directly, which is why nothing exercised the paths that report a
 * duplicate id or an uncovered clause — those paths did not exist yet, and could not have
 * been tested if they had.
 */
export function checkRequirementMap(map: RequirementMap = loadRequirementMap()): string[] {
  const problems: string[] = [];
  if (map.order !== MAP_ORDER) {
    problems.push(`the map declares order ${map.order}, not ${MAP_ORDER}`);
  }

  // ── the order text is the anchor ────────────────────────────────────────────────
  if (!existsSync(join(ROOT, map.authority.order_text))) {
    problems.push(`the order text ${map.authority.order_text} is not in the repository`);
  } else {
    // The map names the digest of the authority it was built against. If the order file
    // is edited, this map is no longer known to be a map OF it, and saying so loudly is
    // the whole point of checking one file with one checksum.
    const actual = orderTextDigest();
    if (map.authority.order_text_sha256_canonical_lf !== actual) {
      problems.push(
        `the map was built against order text ${map.authority.order_text_sha256_canonical_lf}, ` +
          `but ${map.authority.order_text} now hashes to ${actual} — the authority has moved`,
      );
    }
  }
  const declaredClauses = new Set(map.clause_inventory.map((c) => c.clause));
  const inOrderText = orderTextClauses();
  for (const clause of declaredClauses) {
    if (!CLAUSE_SHAPE.test(clause)) problems.push(`clause id ${clause} is not of the form §N.N`);
    if (!inOrderText.has(clause)) {
      problems.push(`clause ${clause} is in the inventory but not in the order text's register`);
    }
  }
  for (const clause of inOrderText) {
    if (!declaredClauses.has(clause)) {
      problems.push(`clause ${clause} is in the order text's register but not in the inventory`);
    }
  }
  if (map.clause_inventory.length !== declaredClauses.size) {
    problems.push('the clause inventory lists the same clause twice');
  }
  for (const entry of map.clause_inventory) {
    if (entry.text_held_verbatim && !orderTextHoldsClauseHeading(entry.clause)) {
      problems.push(
        `${entry.clause} is declared as held verbatim, but ${map.authority.order_text} carries no "${entry.clause} —" heading`,
      );
    }
    if (entry.title.trim() === '' || entry.evidence.trim() === '') {
      problems.push(`${entry.clause}: the inventory entry must state a title and its evidence`);
    }
  }

  // ── the requirements ───────────────────────────────────────────────────────────
  const stepNames = workflowStepNames();
  const workflow = readFileSync(WORKFLOW_PATH, 'utf8');
  const namesByFile = new Map<string, Set<string>>();
  const claimedFiles = new Set<string>();
  const seenIds = new Set<string>();
  const coveredClauses = new Set<string>();
  let mappedTests = 0;

  for (const req of map.requirements) {
    const shape = ID_SHAPE.exec(req.id);
    if (shape === null) {
      problems.push(`${req.id}: the id must read R<4|5>-§<clause>-<kebab-slug>`);
    } else {
      if (req.revision !== `FBL-020-R${shape[1] as string}`) {
        problems.push(`${req.id}: declares revision ${req.revision}, which its id contradicts`);
      }
      if (req.clause !== `§${shape[2] as string}`) {
        problems.push(`${req.id}: declares clause ${req.clause}, which its id contradicts`);
      }
    }
    if (seenIds.has(req.id)) problems.push(`${req.id}: duplicate requirement id`);
    seenIds.add(req.id);

    if (req.revision === MAP_ORDER) {
      if (!declaredClauses.has(req.clause)) {
        problems.push(
          `${req.id}: cites clause ${req.clause}, which the inventory does not declare`,
        );
      }
      coveredClauses.add(req.clause);
    }

    if (req.tests.length === 0 && req.verdict === undefined && (req.ci_steps ?? []).length === 0) {
      problems.push(`${req.id}: names no test, no CI step and no verdict — it proves nothing`);
    }
    for (const path of req.code ?? []) {
      if (!existsSync(join(ROOT, path)))
        problems.push(`${req.id}: code path ${path} does not exist`);
    }
    for (const step of req.ci_steps ?? []) {
      if (!stepNames.has(step)) problems.push(`${req.id}: CI step "${step}" is not in ci.yml`);
    }
    for (const artifact of req.artifacts ?? []) {
      if (!workflow.includes(artifact))
        problems.push(`${req.id}: artifact ${artifact} is never produced by ci.yml`);
    }
    for (const t of req.tests) {
      claimedFiles.add(t.file);
      if (!existsSync(join(ROOT, t.file))) {
        problems.push(`${req.id}: test file ${t.file} does not exist`);
        continue;
      }
      let names = namesByFile.get(t.file);
      if (names === undefined) {
        names = declaredTestNames(t.file);
        namesByFile.set(t.file, names);
      }
      if (!names.has(t.name)) {
        problems.push(`${req.id}: ${t.file} declares no test named ${JSON.stringify(t.name)}`);
      }
      mappedTests += 1;
    }
  }

  // ── completeness: a clause with no requirement is a FAILURE ─────────────────────
  for (const clause of declaredClauses) {
    if (!coveredClauses.has(clause)) {
      problems.push(
        `clause ${clause} is declared in the inventory but NO ${MAP_ORDER} requirement covers it`,
      );
    }
  }

  for (const file of MAPPED_TEST_FILES) {
    if (!existsSync(join(ROOT, file))) {
      problems.push(`mapped test file ${file} is missing from the tree`);
    } else if (!claimedFiles.has(file)) {
      problems.push(`test file ${file} is not claimed by any requirement in the map`);
    }
  }

  // Every test file on disk must be a real file the suite runs — a guard against a
  // map that cites a helper module as though it were a battery.
  const onDisk = new Set(readdirSync(join(ROOT, 'tests')).filter((f) => f.endsWith('.test.ts')));
  for (const file of claimedFiles) {
    if (!onDisk.has(file.replace(/^tests\//, '')))
      problems.push(`${file} is cited by the map but is not a tests/*.test.ts battery`);
  }

  // ── the ambiguous-citation residue, declared in both directions ────────────────
  const declaredResidue = new Set(map.governing_document.bare_blueprint_citation_residue);
  const actualResidue = bareCitationFiles(map);
  for (const file of actualResidue) {
    if (!declaredResidue.has(file)) {
      problems.push(
        `${file} cites a blueprint §14 section but is not declared in bare_blueprint_citation_residue`,
      );
    }
  }
  for (const file of declaredResidue) {
    if (!actualResidue.includes(file)) {
      problems.push(`bare_blueprint_citation_residue names ${file}, which cites no §14 section`);
    }
  }

  console.log(
    `order=${map.order} requirements=${map.requirements.length} clauses=${declaredClauses.size} ` +
      `mapped_tests=${mappedTests} test_files_claimed=${claimedFiles.size} ` +
      `mapped_test_files=${MAPPED_TEST_FILES.length} citation_residue=${actualResidue.length}`,
  );
  return problems;
}

/**
 * ── THE FBL-020-R7 MAP, CHECKED WITH THE SAME DISCIPLINE ──────────────────────
 *
 * `docs/FBL-020-R7-REQUIREMENT-MAP.json` maps the R7 order — as amended by
 * FBL-020-R7-A1 — to its implementations, named tests, mutations and gates. It is
 * validated here rather than in a second script so one CI step and one artifact
 * cover both maps, and so the two cannot drift onto different rules:
 *
 *   1. AUTHORITY — both digests must equal the canonical-LF SHA-256 of the
 *      checked-in order texts, so a map built against different words is refused.
 *   2. IDS — well formed (`R7-§…` / `R7A1-§…`), unique, and each naming a clause
 *      the inventory declares.
 *   3. COVERAGE — every clause in the inventory is cited by at least one
 *      requirement; an omitted requirement is a failure, not a gap.
 *   4. EXISTENCE — every implementation file exists; every named test exists
 *      VERBATIM in the file that claims it (the same `test('…')` scan the R5
 *      checker uses, so a renamed test breaks the map rather than orphaning it).
 *   5. MUTATIONS — every named runtime-mutation id exists in
 *      `scripts/mutation-kill.ts`, and every named database-control id exists in
 *      `scripts/database-control-mutations.ts` (whole controls and predicates
 *      alike). A mutation the registry no longer declares cannot be cited as
 *      proof of anything.
 */
const R7_MAP_PATH = join(ROOT, 'docs', 'FBL-020-R7-REQUIREMENT-MAP.json');
const R7_ORDER_PATH = join(ROOT, 'docs', 'orders', 'FBL-020-R7.md');
const R7_AMENDMENT_PATH = join(ROOT, 'docs', 'orders', 'FBL-020-R7-A1.md');
const R7_ID_SHAPE = /^R7(?:A1)?-§\d+(?:\.\d+)?-[a-z0-9]+(?:-[a-z0-9]+)*$/;

interface R7Requirement {
  id: string;
  clause: string;
  requirement: string;
  implementation: string[];
  tests: Array<{ file: string; name: string }>;
  runtime_mutations: string[];
  database_controls: string[];
  gates: string[];
  verdict: string;
}

interface R7RequirementMap {
  order: string;
  amended_by: string;
  authority: {
    order_text: string;
    order_text_sha256_canonical_lf: string;
    amendment_text: string;
    amendment_text_sha256_canonical_lf: string;
  };
  clause_inventory: Array<{ clause: string; text: string }>;
  requirements: R7Requirement[];
}

export function loadR7RequirementMap(): R7RequirementMap {
  return JSON.parse(readFileSync(R7_MAP_PATH, 'utf8')) as R7RequirementMap;
}

function canonicalLfDigest(path: string): string {
  return createHash('sha256')
    .update(readFileSync(path, 'utf8').replace(/\r\n/g, '\n'))
    .digest('hex');
}

export function checkR7RequirementMap(map: R7RequirementMap = loadR7RequirementMap()): string[] {
  const problems: string[] = [];

  // 1. authority
  for (const [label, path, expected] of [
    ['order_text', R7_ORDER_PATH, map.authority.order_text_sha256_canonical_lf],
    ['amendment_text', R7_AMENDMENT_PATH, map.authority.amendment_text_sha256_canonical_lf],
  ] as const) {
    if (!existsSync(path)) {
      problems.push(`R7 map: ${label} ${path} does not exist`);
      continue;
    }
    const actual = canonicalLfDigest(path);
    if (actual !== expected)
      problems.push(
        `R7 map: ${label} digest is ${actual} on disk and ${expected} in the map — the map ` +
          'was built against different order words',
      );
  }

  // 2/3. ids and coverage
  const declaredClauses = new Set(map.clause_inventory.map((c) => c.clause));
  const covered = new Set<string>();
  const seenIds = new Set<string>();
  for (const req of map.requirements) {
    if (!R7_ID_SHAPE.test(req.id)) problems.push(`R7 map: malformed requirement id ${req.id}`);
    if (seenIds.has(req.id)) problems.push(`R7 map: duplicate requirement id ${req.id}`);
    seenIds.add(req.id);
    if (!declaredClauses.has(req.clause))
      problems.push(
        `R7 map: ${req.id} cites clause ${req.clause}, which the inventory does not declare`,
      );
    covered.add(req.clause);
    if (req.verdict.trim() === '') problems.push(`R7 map: ${req.id} has an empty verdict`);
  }
  for (const clause of declaredClauses) {
    if (!covered.has(clause))
      problems.push(`R7 map: clause ${clause} is in the inventory and NO requirement covers it`);
  }

  // 4. existence — files and verbatim tests
  for (const req of map.requirements) {
    for (const file of req.implementation) {
      if (!existsSync(join(ROOT, file)))
        problems.push(`R7 map: ${req.id} names implementation ${file}, which does not exist`);
    }
    for (const t of req.tests) {
      if (!existsSync(join(ROOT, t.file))) {
        problems.push(`R7 map: ${req.id} names test file ${t.file}, which does not exist`);
        continue;
      }
      if (!declaredTestNames(t.file).has(t.name))
        problems.push(
          `R7 map: ${req.id} claims test ${JSON.stringify(t.name)} in ${t.file}, and no test ` +
            'of that exact name is declared there',
        );
    }
  }

  // 5. mutation ids resolve in their registries
  const runtimeIds = new Set(MUTATIONS.map((m) => m.id));
  const databaseIds = new Set([...DB_CONTROLS.map((c) => c.id), ...DB_PREDICATES.map((p) => p.id)]);
  for (const req of map.requirements) {
    for (const id of req.runtime_mutations) {
      if (!runtimeIds.has(id))
        problems.push(
          `R7 map: ${req.id} cites runtime mutation ${id}, which scripts/mutation-kill.ts does not declare`,
        );
    }
    for (const id of req.database_controls) {
      if (!databaseIds.has(id))
        problems.push(
          `R7 map: ${req.id} cites database control ${id}, which scripts/database-control-mutations.ts does not declare`,
        );
    }
  }

  return problems;
}

const C1_MAP_PATH = join(ROOT, 'docs', 'FBL-020-R7-C1-REQUIREMENT-MAP.json');
const C1_ORDER_PATH = join(ROOT, 'docs', 'orders', 'FBL-020-R7-C1.md');
const C1_ID_SHAPE = /^C1-(?:§\d+|final)-[a-z0-9]+(?:-[a-z0-9]+)*$/;

interface C1RequirementMap {
  order: string;
  authority: { order_text: string; order_text_sha256_canonical_lf: string };
  clause_inventory: Array<{ clause: string; text: string }>;
  requirements: R7Requirement[];
}

export function loadC1RequirementMap(): C1RequirementMap {
  return JSON.parse(readFileSync(C1_MAP_PATH, 'utf8')) as C1RequirementMap;
}

/**
 * FBL-020-R7-C1's map is validated with the same discipline as the R7 map: one
 * authority digest, C1-shaped ids, full clause coverage, verbatim test names,
 * and cited database-control ids that the runner actually declares.
 */
export function checkC1RequirementMap(map: C1RequirementMap = loadC1RequirementMap()): string[] {
  const problems: string[] = [];
  if (!existsSync(C1_ORDER_PATH)) {
    problems.push(`C1 map: order text ${C1_ORDER_PATH} does not exist`);
  } else {
    const actual = canonicalLfDigest(C1_ORDER_PATH);
    if (actual !== map.authority.order_text_sha256_canonical_lf)
      problems.push(
        `C1 map: order_text digest is ${actual} on disk and ` +
          `${map.authority.order_text_sha256_canonical_lf} in the map`,
      );
  }
  const declaredClauses = new Set(map.clause_inventory.map((c) => c.clause));
  const covered = new Set<string>();
  const seenIds = new Set<string>();
  for (const req of map.requirements) {
    if (!C1_ID_SHAPE.test(req.id)) problems.push(`C1 map: malformed requirement id ${req.id}`);
    if (seenIds.has(req.id)) problems.push(`C1 map: duplicate requirement id ${req.id}`);
    seenIds.add(req.id);
    if (!declaredClauses.has(req.clause))
      problems.push(`C1 map: ${req.id} cites clause ${req.clause}, not in the inventory`);
    covered.add(req.clause);
    if (req.verdict.trim() === '') problems.push(`C1 map: ${req.id} has an empty verdict`);
  }
  for (const clause of declaredClauses)
    if (!covered.has(clause))
      problems.push(`C1 map: clause ${clause} is covered by no requirement`);
  const databaseIds = new Set([...DB_CONTROLS.map((c) => c.id), ...DB_PREDICATES.map((p) => p.id)]);
  for (const req of map.requirements) {
    for (const file of req.implementation)
      if (!existsSync(join(ROOT, file)))
        problems.push(`C1 map: ${req.id} names implementation ${file}, which does not exist`);
    for (const t of req.tests) {
      if (!existsSync(join(ROOT, t.file))) {
        problems.push(`C1 map: ${req.id} names test file ${t.file}, which does not exist`);
        continue;
      }
      if (!declaredTestNames(t.file).has(t.name))
        problems.push(
          `C1 map: ${req.id} claims test ${JSON.stringify(t.name)} in ${t.file}, absent there`,
        );
    }
    for (const id of req.database_controls)
      if (!databaseIds.has(id))
        problems.push(`C1 map: ${req.id} cites database control ${id}, not declared by the runner`);
  }
  return problems;
}

function main(): void {
  let out: string | undefined;
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') out = argv[(i += 1)];
    else {
      console.error(`Unrecognized argument: ${argv[i]}`);
      process.exit(2);
    }
  }

  const problems = [
    ...checkRequirementMap(),
    ...checkR7RequirementMap(),
    ...checkC1RequirementMap(),
  ];
  const report =
    problems.length === 0
      ? 'requirement maps OK (R5 and R7): every clause is covered, every id is well formed ' +
        'and unique, and every requirement resolves to tests, code, mutations, steps and ' +
        'artifacts that exist\n'
      : problems.map((p) => `FAIL: ${p}`).join('\n') + '\n';
  process.stdout.write(report);
  if (out !== undefined) writeFileSync(out, report);
  if (problems.length > 0) process.exit(1);
}

if (require.main === module) main();
