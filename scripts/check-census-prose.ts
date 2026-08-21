/**
 * FBL-020-R5 gate finding G5 — THE ARTIFACT AND THE PROSE ABOUT IT MUST AGREE.
 *
 *   npx tsx scripts/check-census-prose.ts [--census <json>]
 *
 * ── WHAT WENT WRONG ─────────────────────────────────────────────────────────
 *
 * `artifacts/migration-census.json` concluded
 *
 *     "AT LEAST ONE PERSISTENT ENVIRONMENT HAS APPLIED A FORM OF 057. Under §0.2 that
 *      freezes 057 and sends every further schema correction to 058."
 *
 * while `docs/FBL-020-DELIVERY-REPORT.md` and `docs/FBL-020-R5-REQUIREMENT-MAP.json`
 * both said the opposite — that no persistent environment held 057 and 057 was
 * therefore editable in place — and migration 057 was in fact edited in place, with no
 * 058 anywhere. Three documents, two incompatible positions, and NOTHING COMPARED THEM.
 * Every individual gate was green: the census ran, the map validated, the report's own
 * tests passed. The contradiction lived in the space between them.
 *
 * ── WHAT THIS GATE DOES ─────────────────────────────────────────────────────
 *
 * It reads the census artifact, takes `conclusion.position` — a token the census emits,
 * not a phrase anybody has to interpret — and requires every delivery document to
 * assert THAT position and no other:
 *
 *   * the delivery report must carry one `census-position` block naming the token, and
 *     must quote the artifact's `branch_sentence` verbatim inside it;
 *   * the requirement map's §0.1 and §0.2 rows must each carry `census_position` equal
 *     to the token.
 *
 * `branch_sentence` deliberately excludes anything host-specific, so the same branch
 * reads identically here and on a CI runner taking its own census. Counts that vary by
 * host stay in `implementer_reading`, which this gate does not require to be quoted.
 *
 * The documents are free to DISCUSS the branch not taken — R5's §0.2 row explains what a
 * reviewer reading the evidence differently would conclude, and that is honest. What
 * they may not do is ASSERT it. Assertion is confined to the marked block and to the
 * declared field, which is what makes the comparison mechanical instead of a guess about
 * what a paragraph meant.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import type { CensusPosition } from './migration-census';
import { BRANCH_SENTENCE } from './migration-census';

const ROOT = join(__dirname, '..');

export const REPORT = join(ROOT, 'docs', 'FBL-020-DELIVERY-REPORT.md');
export const MAP = join(ROOT, 'docs', 'FBL-020-R5-REQUIREMENT-MAP.json');

/**
 * FBL-020-R6 §1.1/§1.2 — THE CENSUS THIS GATE READS IS THE COMMITTED OPERATOR ONE.
 *
 * Two defects are closed by this one line.
 *
 *   * R5 pointed this gate at `artifacts/migration-census.json`. In CI that file is written
 *     by the census step a few lines earlier — the RUNNER census — so the runner decided
 *     what the delivery documents were required to say. §1.2 forbids exactly that.
 *   * `artifacts/` is GITIGNORED. A developer tree has it and a fresh checkout does not, so
 *     the same gate silently checked a different thing depending on where it ran, and the
 *     suite had to guard the comparison with `existsSync` — which means the shipped
 *     documents could go uncompared on any machine that had never taken a census.
 *
 * The operator census is therefore COMMITTED, at the path below, and this gate reads that.
 * It exists in every checkout, it is the same bytes for every reader, and it carries the
 * `authority` block — so a runner census substituted for it is refused rather than obeyed.
 */
export const CENSUS = join(ROOT, 'docs', 'evidence', 'FBL-020-R6-operator-environment-census.json');

/** The map rows that state a §0.2 position and must therefore carry the token. */
export const POSITION_BEARING_ROWS = ['R5-§0.1-census', 'R5-§0.2-in-place-branch'] as const;

export const BLOCK_START = '<!-- census-position:start -->';
export const BLOCK_END = '<!-- census-position:end -->';

export interface CensusClaim {
  position: CensusPosition;
  branch_sentence: string;
  /** Which host the census inspected, carried through so a reader sees what decided. */
  role: string;
}

/**
 * Reads the artifact's position. A census that states none is itself a failure — and so is
 * a census that is not entitled to state one.
 *
 * FBL-020-R6 §1.2: a census taken on a CI runner reports a runner, and a runner is not an
 * operator-controlled persistent environment. Such an artifact carries
 * `authority.may_decide_the_057_058_branch: false` and is REFUSED here, so it cannot be
 * substituted for the operator census by a wrong path, a copied file or a CI step that
 * writes over it.
 */
export function readCensusClaim(file = CENSUS): CensusClaim {
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
    authority?: { role?: string; may_decide_the_057_058_branch?: boolean };
    conclusion?: { position?: string; branch_sentence?: string };
  };
  const authority = parsed.authority;
  if (authority === undefined || typeof authority.may_decide_the_057_058_branch !== 'boolean')
    throw new Error(
      `${file} carries no authority.may_decide_the_057_058_branch. A census that does not ` +
        'say which host it inspected, and whether that host may decide anything, cannot be ' +
        'the census a schema branch rests on.',
    );
  if (!authority.may_decide_the_057_058_branch)
    throw new Error(
      `${file} declares role ${JSON.stringify(authority.role)} and ` +
        'may_decide_the_057_058_branch=false, so it MAY NOT DECIDE THE 057/058 BRANCH. It is ' +
        'evidence about the machine it ran on and nothing else. FBL-020-R6 §1.2: the branch ' +
        'rests on a census of the ACTUAL OPERATOR-CONTROLLED PERSISTENT ENVIRONMENTS, and a ' +
        'runner census is not one.',
    );
  const position = parsed.conclusion?.position;
  const sentence = parsed.conclusion?.branch_sentence;
  if (position === undefined || sentence === undefined)
    throw new Error(
      `${file} states no conclusion.position/branch_sentence. An artifact that does not say ` +
        'what it concluded cannot be compared with the prose that interprets it.',
    );
  if (!(position in BRANCH_SENTENCE))
    throw new Error(
      `${file}: conclusion.position is ${JSON.stringify(position)}, which is not a position`,
    );
  return {
    position: position as CensusPosition,
    branch_sentence: sentence,
    role: authority.role ?? 'unstated',
  };
}

/** The `census-position` block of a Markdown document, or undefined when there is none. */
export function positionBlock(markdown: string): string | undefined {
  const start = markdown.indexOf(BLOCK_START);
  const end = markdown.indexOf(BLOCK_END);
  if (start === -1 || end === -1 || end < start) return undefined;
  return markdown.slice(start + BLOCK_START.length, end);
}

export interface MapRow {
  id?: string;
  census_position?: string;
}

/**
 * The comparison, as a pure function over the three texts so the suite can flip any one
 * of them and watch the gate fail.
 */
export function proseProblems(
  claim: CensusClaim,
  report: string,
  map: { requirements?: MapRow[] },
): string[] {
  const problems: string[] = [];

  const block = positionBlock(report);
  if (block === undefined) {
    problems.push(
      `the delivery report carries no ${BLOCK_START} … ${BLOCK_END} block, so it states no ` +
        'census position a gate can check',
    );
  } else {
    if (!block.includes(claim.position))
      problems.push(
        `the delivery report's census-position block does not name ${claim.position}, which is ` +
          'what the census artifact concluded',
      );
    for (const other of Object.keys(BRANCH_SENTENCE) as CensusPosition[])
      if (other !== claim.position && block.includes(other))
        problems.push(
          `the delivery report's census-position block asserts ${other}, but the census ` +
            `artifact concluded ${claim.position}`,
        );
    /*
     * Only the two things Markdown does to a quoted sentence are normalized away: the
     * line wrapping, and the `>` that makes it a blockquote. Every other character has to
     * match, which is what makes this a quotation rather than a paraphrase.
     */
    const flat = block
      .split(/\r?\n/)
      .map((line) => line.replace(/^\s*>\s?/, ''))
      .join(' ')
      .replace(/\s+/g, ' ');
    if (!flat.includes(claim.branch_sentence.replace(/\s+/g, ' ')))
      problems.push(
        "the delivery report does not quote the census artifact's own branch sentence " +
          'verbatim, so it is not stating what the artifact says',
      );
  }

  const rows = map.requirements ?? [];
  for (const id of POSITION_BEARING_ROWS) {
    const row = rows.find((r) => r.id === id);
    if (row === undefined) {
      problems.push(`the requirement map has no row ${id}`);
      continue;
    }
    if (row.census_position === undefined)
      problems.push(
        `requirement-map row ${id} declares no census_position; a row that states a 057/058 ` +
          'position must say which one, in a field a gate can read',
      );
    else if (row.census_position !== claim.position)
      problems.push(
        `requirement-map row ${id} declares census_position ${row.census_position}, but the ` +
          `census artifact concluded ${claim.position}`,
      );
  }

  return problems;
}

function main(): void {
  const argv = process.argv.slice(2);
  let census = CENSUS;
  for (let i = 0; i < argv.length; i += 1)
    if (argv[i] === '--census') census = argv[(i += 1)] as string;

  const claim = readCensusClaim(census);
  const problems = proseProblems(
    claim,
    readFileSync(REPORT, 'utf8'),
    JSON.parse(readFileSync(MAP, 'utf8')) as { requirements?: MapRow[] },
  );
  console.log(`census: ${census}`);
  console.log(`census role: ${claim.role}`);
  console.log(`census position: ${claim.position}`);
  if (problems.length > 0) {
    console.error('The delivery documents do not state what the census artifact concluded:');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log('Census artifact and delivery prose agree.');
}

if (require.main === module) main();
