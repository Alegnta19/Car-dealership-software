/**
 * FBL-020-R6 §4.5 — THE FINAL STATE IS ONE RECORD, AND THE DOCUMENTS RESTATE IT.
 *
 *   npx tsx scripts/check-final-state.ts          # the gate
 *   npx tsx scripts/check-final-state.ts --list   # what it checks, and against what
 *
 * ── THE CLASS THIS EXISTS TO CLOSE ──────────────────────────────────────────
 *
 * FBL-020-R5 was rejected for a MATERIALLY STALE CHECKED-IN FINAL STATE. Every one of
 * these sentences was in the tree, and every one of them was false of it:
 *
 *   * the delivery report said `HEAD` was `0e99ecd`, RED, with the corrections
 *     uncommitted and NO CI RUN EXISTS FOR THIS TREE — while `HEAD` was `174c789` and
 *     its exact-SHA run had completed with every job successful;
 *   * `docs/identity/KNOWN-LIMITATIONS.md` repeated that no CI run existed;
 *   * `docs/FBL-020-R5-REQUIREMENT-MAP.json` still said three of its rows were
 *     "STILL UNVERIFIED UNTIL A CI RUN AT THE FINAL HEAD PROVES IT" after that run had
 *     happened, and that the policy-evidence constraints had no mutation coverage after
 *     `scripts/database-control-mutations.ts` had been added to gate exactly them;
 *   * and NO FILE IN THE REPOSITORY recorded the final commit or the run at all.
 *
 * `scripts/check-published-figures.ts` was green the whole time. It had to be: it
 * compares NUMBERS with the artifacts that produce them, and not one of the sentences
 * above is a number. A gate that reads only figures cannot see a stale paragraph.
 *
 * ── WHAT THIS GATE CHECKS, AND WHAT MAKES EACH CHECK SATISFIABLE ────────────
 *
 * `docs/evidence/FBL-020-FINAL-STATE.json` is the single authority. This file checks it
 * against GIT and against the delivery documents, in four groups:
 *
 *  1. THE SHAs. Every commit named in the record must EXIST in this repository, its
 *     recorded subject must equal its real subject, and it must be an ancestor of — or
 *     equal to — `HEAD`. The listed code-bearing commits must be EXACTLY the commits in
 *     `git rev-list <r5_baseline>..<evidence_commit>`, in both directions. That range is
 *     closed at both ends and never moves, so the check is stable; and it is the check an
 *     undercount cannot survive, which is the R5 defect (a report publishing TWO commits
 *     over a range that held THREE).
 *
 *  2. THE EXACT-SHA RUN. Each run's `head_sha` must equal the commit it is attributed to
 *     — that is what makes it an EXACT-SHA run rather than a run of the branch. The
 *     per-job list must be as long as `jobs_total`, and `jobs_non_success` must equal the
 *     number of jobs whose conclusion is not `success`, and the run-level `conclusion`
 *     must agree with the per-job list. A run recorded as `success` with a failed job in
 *     it fails here.
 *
 *  3. THE HEAD RELATION, which is the one fact about the TIP. The record declares either
 *     `HEAD_IS_THE_EVIDENCE_COMMIT` or `HEAD_IS_AHEAD_OF_THE_EVIDENCE_COMMIT`, and the
 *     gate decides which is true from `git rev-list <evidence>..HEAD`. THIS IS
 *     DELIBERATELY AN ENUM RATHER THAN A SHA. A record that had to name the SHA of the
 *     commit CONTAINING it could never be written — no file can know its own commit — so
 *     such a check would be a gate nobody can pass, and a gate nobody can pass gets
 *     deleted. Flipping an enum needs no unknown value, so this one is both satisfiable
 *     and strict: once a commit lands on top of the evidence commit, the declaration is
 *     measurably wrong and the run goes red. That is precisely what would have caught R5
 *     the moment `174c789` was pushed with a report still naming `0e99ecd`.
 *
 *  4. THE PROSE. `requiredStatements()` DERIVES its sentences from the record, so a
 *     required sentence can never disagree with the recorded facts; each must appear
 *     verbatim in each document that owns it. `FORBIDDEN` lists the stale sentences by
 *     their exact text; none may appear in any governed document except inside an
 *     explicitly marked withdrawal region, because withdrawing a claim means quoting it.
 *
 * ── ARTIFACTS ARE NOT READ, AND THAT IS ON PURPOSE ──────────────────────────
 *
 * `artifacts/` is gitignored: a developer tree has it and a fresh CI checkout does not.
 * Four separate failures in this order came out of that one asymmetry. This gate reads
 * COMMITTED FILES AND GIT ONLY — there is no artifact input, conditional or otherwise —
 * so it checks the same thing on both, and `tests/delivery-documentation.test.ts` asserts
 * that by running it with `artifacts/` absent and by refusing an artifact-shaped path in
 * this source.
 *
 * ── …AND THE FIFTH FORM OF THE SAME ASYMMETRY: A SHALLOW CLONE ──────────────
 *
 * The R6 gate's finding C2. `actions/checkout` without `fetch-depth` produces a `--depth 1`
 * checkout: `.git` is present, `HEAD` resolves, and NOTHING ELSE DOES. Every history limb
 * of this gate — the recorded subjects, the ancestry, `rev-list <baseline>..<evidence>` —
 * asked git for objects that checkout had not fetched, so the gate exited 1 in the very job
 * it was written for, and took the in-suite test that drives the same code down with it.
 *
 * Both halves of the fix are here, because either one alone is fragile:
 *
 *   1. THE WORKFLOW FETCHES WHAT THE GATE NEEDS. `.github/workflows/ci.yml`'s verify job
 *      now checks out with `fetch-depth: 0`, so in CI every limb below really runs. That is
 *      stated in the workflow beside the setting, so a future edit that removes it is
 *      removing something the comment says is load-bearing.
 *   2. THE GATE IS CORRECT WITHOUT IT ANYWAY. `readGitFacts` asks git whether the
 *      repository is shallow (`git rev-parse --is-shallow-repository`) and, when it is,
 *      asks for nothing it cannot have. The limbs that need history are then REPORTED AS
 *      UNRUN, by name, on stdout and in `--list` — never dropped silently, because a gate
 *      that goes quiet is the failure this whole order keeps finding.
 *
 * One history fact survives a shallow clone and is DERIVED rather than skipped: the head
 * relation. `git rev-parse HEAD` works everywhere, so `HEAD == evidence_commit_sha` decides
 * `HEAD_IS_THE_EVIDENCE_COMMIT` against `HEAD_IS_AHEAD_OF_THE_EVIDENCE_COMMIT` without any
 * ancestry at all — and that is the limb R5 could not survive. So the check R5 was rejected
 * for is the one that keeps running on a `--depth 1` checkout.
 */
import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');

export const RECORD = 'docs/evidence/FBL-020-FINAL-STATE.json';
export const REPORT = 'docs/FBL-020-DELIVERY-REPORT.md';
export const MAP = 'docs/FBL-020-R5-REQUIREMENT-MAP.json';
export const PROVENANCE = 'docs/orders/BLUEPRINT-PROVENANCE.md';
export const LIMITS = 'docs/identity/KNOWN-LIMITATIONS.md';
export const README = 'README.md';

/** The documents that speak about the final state and must therefore agree about it. */
export const GOVERNED = [REPORT, MAP, PROVENANCE, LIMITS, README] as const;

/**
 * FBL-020-R6: THE FORBIDDEN SCAN SURFACE IS WIDER THAN `GOVERNED`, AND IT HAD TO BE.
 *
 * The withdrawn sentences were swept out of all five governed documents and then found
 * alive in five more places — twice in `check-published-figures.ts`, once in
 * `check-requirement-map.ts`, once in the checked-in R5 order text, once in a report row
 * outside every withdrawal marker. None of them was reachable: this scan iterated
 * `GOVERNED`, and `tests/delivery-documentation.test.ts` reconciles ten documents, none of
 * which is a script or an order file. A rule enforced over five files and violated in the
 * sixth is not enforced.
 *
 * These files carry no withdrawal markers and are not meant to: a script has no business
 * quoting a withdrawn claim, so an occurrence in one is always an assertion. They are
 * scanned unmasked.
 */
export const ALSO_SCANNED = [
  'scripts/check-published-figures.ts',
  'scripts/check-requirement-map.ts',
  'scripts/check-census-prose.ts',
  // NOT this file: it DECLARES every forbidden sentence in `FORBIDDEN` below, so the
  // declaration site necessarily contains all of them. That is a definition, not an
  // assertion — the same exemption `check-role-binding-effectiveness.ts` grants the
  // predicate it is built around, and the only self-reference in this list.
  'scripts/migration-census.ts',
  'docs/orders/FBL-020-R5.md',
  'docs/orders/FBL-020-R6.md',
  'docs/evidence/FBL-020-R6-MIGRATION-PREFLIGHT.md',
] as const;

/**
 * The withdrawal markers. A document withdrawing a false sentence has to QUOTE it, so the
 * forbidden scan masks these regions first. They are the only exemption, they are named,
 * and `tests/delivery-documentation.test.ts` bounds how many exist.
 */
export const WITHDRAWN_START = '<!--final-state:withdrawn-->';
export const WITHDRAWN_END = '<!--/final-state-->';

/**
 * The JSON documents cannot carry HTML comments, so their withdrawal region is a declared
 * key instead: `withdrawn_claims` at the top level of the record, and `final_state`'s
 * `withdrawn_claims` in the requirement map. Nothing else in a JSON document is exempt.
 */
export const JSON_WITHDRAWAL_KEY = 'withdrawn_claims';

export interface RunJob {
  name: string;
  conclusion: string;
}

export interface WorkflowRun {
  workflow_path: string;
  run_id: number;
  run_number: number;
  run_attempt: number;
  head_sha: string;
  conclusion: string;
  jobs_total: number;
  jobs_non_success: number;
  jobs: RunJob[];
}

/**
 * FBL-020-R6: ONE COMMIT IN THE MEASURED RANGE, declaring whether it is CODE-BEARING.
 *
 * The interface and the field it types were both named `RangeCommit` /
 * `code_bearing_commits`, and that was true for exactly as long as every commit in
 * `r5_baseline..evidence_commit` happened to carry code. `d0b9924` ended it: a
 * DOCUMENTATION-ONLY closeout, which the orders explicitly allow, landing inside the range.
 *
 * The choice was to call a documentation commit code-bearing — overstating a budget breach
 * the architect has already ruled on, and a budget figure wrong in the direction of severity
 * is still wrong — or to say what the field actually holds. The gate checks the list against
 * `git rev-list --first-parent`, so it must hold EVERY commit in the range; `code_bearing`
 * then decides which ones the budget counts.
 */
export interface RangeCommit {
  sha: string;
  short: string;
  subject: string;
  code_bearing: boolean;
  run: WorkflowRun;
}

export type HeadRelation = 'HEAD_IS_THE_EVIDENCE_COMMIT' | 'HEAD_IS_AHEAD_OF_THE_EVIDENCE_COMMIT';

export type SubmissionStatus = 'NOT SUBMITTABLE AS COMPLETE' | 'SUBMITTABLE AS COMPLETE';

export interface FinalState {
  order: string;
  acceptance: string;
  r5_baseline: { sha: string; subject: string };
  commits_in_the_measured_range: RangeCommit[];
  evidence_commit_sha: string;
  /**
   * FBL-020-R6: THE COMMITS THAT SIT ON TOP OF THE EVIDENCE COMMIT, recorded rather than
   * left out — and this field exists because leaving them out was reproducing the exact
   * defect FBL-020-R5 was rejected for.
   *
   * `commits_in_the_measured_range` is checked to be EXACTLY the range `r5_baseline..evidence_commit`.
   * That is the right range for "which commits did the reported run measure", and it is the
   * wrong range for "how many code-bearing commits does this delivery contain": every commit
   * made AFTER the last green run falls outside it and was therefore counted nowhere. Two
   * did — `0fe4ae7` and `242e24a`, both red — so the budget the record published understated
   * the breach, which is precisely the "record lists fewer commits than the history holds"
   * shape the gate refuses one field over.
   *
   * A commit here may have NO run yet (`run: null`). That is the honest state of a commit
   * whose own CI has not finished, and it is a different fact from a run that failed — the
   * budget counts the commit either way, and only a recorded FAILURE counts toward
   * `failed_ci`.
   */
  /**
   * FBL-020-R6: WHAT THE COMMIT THIS RECORD LIVES IN IS, declared, because its SHA cannot be.
   *
   * `is_code_bearing` is the only part of the self-commit a record can state, and stating it
   * is what makes the budget arithmetic environment-independent. Deriving the same fact from
   * git — "HEAD is above the evidence commit and is not in the list, so add one" — worked in
   * a checkout and silently produced a DIFFERENT number in a tree with no `.git`, where
   * `scripts/mutation-kill.ts` runs whole batteries. That is the identical trap, one level
   * up from the one that broke run 32452596992: a fact read from an environment rather than
   * from the record, in a gate whose whole purpose is that the record is the authority.
   */
  this_commit: {
    is_code_bearing: boolean;
    why_it_has_no_sha_here: string;
  };
  commits_ahead_of_the_evidence_commit: Array<{
    sha: string;
    short: string;
    subject: string;
    code_bearing: boolean;
    run: WorkflowRun | null;
  }>;
  repository_head_relation: HeadRelation;
  working_tree: {
    state: string;
    ci_run_for_this_working_tree: number | null;
  };
  commit_budget: {
    allowed: number;
    used: number;
    failed_ci: number;
    verdict: string;
    disclosure_does_not_cure_the_violation: boolean;
  };
  submission: { status: SubmissionStatus; blocking: string[] };
  blueprint_section_3_1: {
    status: string;
    what_must_be_verified_on_arrival: string[];
    what_this_repository_cannot_do: string;
  };
  withdrawn_claims: string[];
}

export function readFinalState(root = ROOT): FinalState {
  return JSON.parse(readFileSync(join(root, RECORD), 'utf8')) as FinalState;
}

// ── the git facts ──────────────────────────────────────────────────────────────────

export interface GitFacts {
  head: string;
  /**
   * TRUE when this repository was cloned with `--depth`, which is what
   * `actions/checkout` produces without `fetch-depth`. Every field below that needs an
   * object other than `HEAD` is then unknowable HERE, and the checks that read them are
   * reported as unrun rather than failed. See the header.
   */
  shallow: boolean;
  /**
   * FBL-020-R6: the tree is NOT A GIT REPOSITORY AT ALL — no `.git`, and no enclosing one.
   *
   * This is a THIRD environment, not a harsher shallow clone, and conflating the two is the
   * absence-vs-silence mistake this delivery has already had to correct twice in the census.
   * A shallow clone ANSWERS `git rev-parse HEAD`; it holds one commit object and knows which.
   * A non-repository answers NOTHING — and `readGitFacts` used to call `git rev-parse HEAD`
   * unguarded, so it THREW there rather than reporting an environment.
   *
   * `scripts/mutation-kill.ts` builds exactly that environment: `isolatedCopy()` excludes
   * `.git` deliberately, then runs whole batteries inside the copy. Every gate test that
   * drives this file was therefore red in the copy BEFORE any mutation was applied, which
   * the runner reported honestly as INCONCLUSIVE rather than crediting a kill — and one
   * inconclusive result fails the step. `head` is the empty string when this is true.
   */
  absent: boolean;
  /**
   * FBL-020-R6: THE PATHS `HEAD` CHANGED, so `this_commit.is_code_bearing` can be CHECKED
   * instead of believed.
   *
   * That field is a declaration about the commit the record lives in — the one commit no
   * record can name — and it decides the commit budget. It was introduced precisely because
   * the fact cannot be derived in every environment, and the consequence went unnoticed: a
   * closeout was authored, declared documentation-only, and committed carrying changes to
   * `scripts/` and `tests/`. The record said one thing, the commit was another, and nothing
   * looked. That is the "header asserting a property nobody measured" shape this delivery has
   * already had to correct three times, in the field built to keep the budget honest.
   *
   * Empty where git cannot answer — a shallow clone holds no parent to diff against and a
   * non-repository holds nothing at all — so the check below is a CROSS-CHECK that runs where
   * it can, never a second source of truth. `undefined` means "not asked"; an empty array
   * means "asked, and the commit changed nothing".
   */
  headPaths: string[] | undefined;
  /** sha → subject, or `undefined` when the object is not a commit in this repository. */
  subject: Record<string, string | undefined>;
  /** sha → is it an ancestor of HEAD, or HEAD itself. */
  ancestorOfHead: Record<string, boolean>;
  /** `git rev-list <r5_baseline>..<evidence_commit>`, newest first. Empty when shallow. */
  baselineToEvidence: string[];
  /**
   * `git rev-list <evidence_commit>..HEAD` — empty means the evidence commit is the tip.
   * Not asked for when shallow; the head relation is derived from `head` instead.
   */
  aheadOfEvidence: string[];
}

/**
 * The checks that a shallow clone cannot run, by name and with what each needs. `main()`
 * prints this when the repository is shallow and `--list` always names it, so "the gate
 * was green" on a `--depth 1` checkout can never be read as "every limb ran".
 */
export const HISTORY_DEPENDENT_CHECKS: ReadonlyArray<{ id: string; needs: string }> = [
  { id: 'recorded_subjects', needs: 'the commit object of every commit named in the record' },
  { id: 'ancestry_of_head', needs: 'git merge-base --is-ancestor <sha> HEAD' },
  {
    id: 'range_is_exactly_the_recorded_list',
    needs: 'git rev-list --first-parent <r5_baseline>..<evidence_commit>',
  },
  { id: 'commit_budget_used', needs: 'the length of that same range' },
];

function git(args: string[], root: string): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function gitOrUndefined(args: string[], root: string): string | undefined {
  try {
    /*
     * `stderr: 'pipe'` so git's own diagnostics do not leak to the console. Outside a
     * repository `rev-parse` prints "fatal: not a git repository" before failing, and this
     * gate would print that line and then exit 0 — a reader scanning a green run would see
     * the word "fatal" and reasonably conclude something had gone wrong. The failure IS the
     * answer here, and it is reported in the gate's own words instead.
     */
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return undefined;
  }
}

export function readGitFacts(state: FinalState, root = ROOT): GitFacts {
  /*
   * ASKED, NOT ASSUMED. `git rev-parse HEAD` throws outside a repository, and letting it
   * throw turned "this tree has no history" into a stack trace in the middle of a battery.
   * The absence is a FACT ABOUT THE ENVIRONMENT and is returned as one, exactly as `shallow`
   * is, so `finalStateProblems` can skip the limbs that need history and `main()` can name
   * them instead of the gate dying or — far worse — inventing findings from a missing HEAD.
   */
  const head = gitOrUndefined(['rev-parse', 'HEAD'], root);
  if (head === undefined)
    return {
      head: '',
      shallow: false,
      absent: true,
      headPaths: undefined,
      subject: {},
      ancestorOfHead: {},
      baselineToEvidence: [],
      aheadOfEvidence: [],
    };
  const shallow = gitOrUndefined(['rev-parse', '--is-shallow-repository'], root) === 'true';
  const shas = [state.r5_baseline.sha, ...state.commits_in_the_measured_range.map((c) => c.sha)];

  const subject: Record<string, string | undefined> = {};
  const ancestorOfHead: Record<string, boolean> = {};
  for (const sha of shas) {
    /*
     * ON A SHALLOW CLONE, `HEAD` IS THE ONLY COMMIT THERE IS. Asking for any other object
     * fails, and reading that failure as "this commit is not in the repository" would turn
     * a fetch depth into a finding about the delivery. So the loop asks only about `HEAD`,
     * whose subject and ancestry ARE knowable, and leaves the rest unmeasured for
     * `finalStateProblems` to report as unrun.
     */
    if (shallow && sha !== head) continue;
    subject[sha] = gitOrUndefined(['log', '-1', '--format=%s', `${sha}^{commit}`], root);
    ancestorOfHead[sha] =
      subject[sha] !== undefined &&
      gitOrUndefined(['merge-base', '--is-ancestor', sha, 'HEAD'], root) !== undefined;
  }

  if (shallow) {
    return {
      head,
      shallow,
      absent: false,
      // A --depth 1 clone holds no parent commit, so there is nothing to diff HEAD against.
      headPaths: undefined,
      subject,
      ancestorOfHead,
      baselineToEvidence: [],
      aheadOfEvidence: [],
    };
  }

  /*
   * A FAILED range and an EMPTY range are not the same answer, and collapsing them is how a
   * gate goes quiet. `git rev-list A..B` fails when A or B does not resolve, and returning
   * `[]` there would read as "no commits between them" — which would satisfy the
   * head-relation check on a record naming a commit this repository does not have.
   *
   * So the range is only asked for when BOTH endpoints resolved to commits, and it is then
   * asked for WITHOUT swallowing the error: at that point a failure is a real fault the
   * operator has to see, not a fact about the history. When an endpoint did not resolve the
   * range is skipped, and the unresolved commit is reported loudly by its own check.
   */
  const range = (from: string, to: string): string[] => {
    if (subject[from] === undefined) return [];
    if (to !== 'HEAD' && subject[to] === undefined) return [];
    const out = git(['rev-list', '--first-parent', `${from}..${to}`], root);
    return out === '' ? [] : out.split(/\r?\n/);
  };

  const headDiff = gitOrUndefined(['diff-tree', '--no-commit-id', '--name-only', '-r', head], root);
  return {
    head,
    shallow,
    absent: false,
    headPaths: headDiff === undefined ? undefined : headDiff === '' ? [] : headDiff.split(/\r?\n/),
    subject,
    ancestorOfHead,
    baselineToEvidence: range(state.r5_baseline.sha, state.evidence_commit_sha),
    aheadOfEvidence: range(state.evidence_commit_sha, 'HEAD'),
  };
}

// ── the prose ──────────────────────────────────────────────────────────────────────

export interface Statement {
  id: string;
  /** What the sentence is FOR, printed by `--list`. */
  what: string;
  sentence: string;
  documents: string[];
}

export interface ForbiddenStatement {
  id: string;
  sentence: string;
  /** Why it may not be asserted any more. */
  why: string;
}

/** The green run: the one attributed to the evidence commit. */
export function evidenceRun(state: FinalState): WorkflowRun | undefined {
  return state.commits_in_the_measured_range.find((c) => c.sha === state.evidence_commit_sha)?.run;
}

/**
 * The sentences every governed document must carry, DERIVED from the record so that a
 * document restating one of them is restating the recorded facts and not a parallel
 * memory of them. Change the record and every document must move with it.
 */
export function requiredStatements(state: FinalState): Statement[] {
  const run = evidenceRun(state);
  const total = run?.jobs_total ?? 0;
  const out: Statement[] = [
    {
      id: 'final_head_and_run',
      what: 'the final code-bearing commit and the exact-SHA run that measured it',
      sentence:
        `THE FINAL CODE-BEARING COMMIT IS ${state.evidence_commit_sha} AND ITS EXACT-SHA ` +
        `${run?.workflow_path ?? '?'} RUN ${run?.run_id ?? '?'} COMPLETED WITH ${total} OF ` +
        `${total} JOBS SUCCESSFUL`,
      documents: [REPORT, MAP, LIMITS, README],
    },
    {
      /*
       * FBL-020-R6, AND THIS ENTRY REPLACES ONE THAT REQUIRED THE OPPOSITE — the second time
       * this registry has had to, and for the same reason both times.
       *
       * It used to require every governed document to assert "NO CI RUN COVERS THE FBL-020-R6
       * WORKING TREE, WHICH IS UNCOMMITTED ON TOP OF THAT COMMIT". That was true while the R6
       * work sat uncommitted. The operator authorised committing, the work was committed, and
       * a run measured it — at which point THE GATE BUILT TO STOP R5's STALE SENTENCES WAS
       * MANDATING ONE. A registry that hard-codes one branch of a fact the tree can change is
       * not a gate; it is a second place for the fact to go stale.
       *
       * The old sentence is now in `FORBIDDEN`, exactly as `blueprint_not_materialized` was,
       * so the two directions cannot disagree. There is deliberately NO conditional branch
       * back to it: the R6 work cannot become uncommitted again, and a branch for a state
       * that cannot recur is an absolute without a fixture.
       */
      id: 'working_tree_not_covered',
      what:
        state.working_tree.state === 'COMMITTED_AHEAD_OF_THE_EVIDENCE_COMMIT'
          ? 'that the R6 work is committed, and that the run named above did NOT measure it'
          : 'that the R6 work is committed, and that the exact-SHA run above measured it',
      /*
       * TWO BRANCHES, AND BOTH ARE LIVE — which is why this one IS conditional where the
       * paragraph above refuses to be. "Uncommitted" cannot recur, so no branch leads back
       * to it. "Committed but not yet measured" recurs on every single code-bearing commit,
       * because a run cannot exist for a commit before the commit does; the delivery passes
       * through this state every time and then leaves it when the run lands. A registry that
       * could only describe the second half of that would force a false sentence for the
       * hours in between, which is the defect this whole gate answers.
       */
      sentence:
        state.working_tree.state === 'COMMITTED_AHEAD_OF_THE_EVIDENCE_COMMIT'
          ? 'THE FBL-020-R6 WORK IS COMMITTED, AND THE EXACT-SHA RUN NAMED ABOVE MEASURED AN ' +
            'EARLIER COMMIT AND NOT IT'
          : 'THE FBL-020-R6 WORK IS COMMITTED AND THE EXACT-SHA RUN NAMED ABOVE MEASURED IT, ' +
            'AND NO UNCOMMITTED WORK SITS ON TOP OF IT',
      documents: [REPORT, MAP, LIMITS],
    },
    {
      id: 'commit_budget_violated',
      what: 'the one-commit budget, recorded as a violation rather than a footnote',
      sentence:
        `THE ONE-COMMIT BUDGET WAS VIOLATED: ${state.commit_budget.used} CODE-BEARING ` +
        `COMMITS EXIST WHERE THE ORDER ALLOWED ${state.commit_budget.allowed}, ` +
        `${state.commit_budget.failed_ci} OF THEM FAILED CI, AND DISCLOSURE DOES NOT CURE ` +
        'THE VIOLATION',
      documents: [REPORT, MAP, LIMITS],
    },
    {
      id: 'submission_status',
      what: 'the submission status, in the record’s own closed vocabulary',
      sentence: `FBL-020-R6 IS ${state.submission.status} WHILE §3.1 IS OPEN`,
      documents: [REPORT, MAP, PROVENANCE, README],
    },
    {
      /*
       * FBL-020-R6, AND THIS ENTRY REPLACES ONE THAT REQUIRED THE OPPOSITE.
       *
       * Until now this registry REQUIRED every governed document to assert "THE VERSION 2.0
       * BLUEPRINT BYTES WERE NOT MATERIALIZED IN THE REVIEW WORKSPACE, AND THE ONLY
       * ACCESSIBLE PROJECT COPIES REMAIN THE VERSION 1.0 FILE" — a statement about a record
       * this repository cannot read, mandated by a gate that runs inside it. When the
       * operator committed the Version 2.0 bytes here, that sentence became both unverifiable
       * AND misleading, and a gate demanding it would have forced every document to reassert
       * it. It is now in `FORBIDDEN` instead, so the two directions cannot disagree.
       *
       * WHAT REPLACES IT IS DELIBERATELY TWO CLAUSES. The first is measurable in this tree
       * and is measured — `tests/delivery-documentation.test.ts` reads the digest, the byte
       * length, both title lines, the version line and every 14.x heading out of the file.
       * The second is the boundary: the reviewer's own two project copies are not observable
       * from here, so the record says that rather than guessing in either direction. §3.1
       * stays OPEN on the second clause, which is why `submission_status` above is unchanged.
       */
      id: 'blueprint_committed_here',
      what: 'where the governing blueprint is, and what this repository cannot see',
      sentence:
        'THE GOVERNING VERSION 2.0 BLUEPRINT IS COMMITTED IN THIS REPOSITORY AND EVERY ' +
        'RECORDED FACT ABOUT IT IS MEASURED FROM ITS OWN BYTES, AND WHETHER THE TWO REVIEWER ' +
        'PROJECT COPIES HOLD IT IS NOT OBSERVABLE FROM HERE',
      documents: [REPORT, MAP, PROVENANCE],
    },
  ];
  return out;
}

/**
 * The stale sentences, by their exact text. Each one was IN THIS REPOSITORY and false of
 * it; none may be asserted again. They are banned rather than permitted-with-a-correction-
 * nearby for the reason the documentation battery already gives for R4's claims: a
 * correction written beside a false sentence still leaves the false sentence readable.
 */
export const FORBIDDEN: ForbiddenStatement[] = [
  {
    id: 'no_ci_run_exists_for_this_tree',
    sentence: 'NO CI RUN EXISTS FOR THIS TREE',
    why: 'a run exists for the final code-bearing commit and it was green in every job. What is true, and is required instead, is that no run covers the UNCOMMITTED R6 work.',
  },
  {
    id: 'no_ci_run_exists_for_it',
    sentence: 'no CI run exists for it',
    why: 'the same claim in KNOWN-LIMITATIONS, in lower case.',
  },
  {
    id: 'head_is_the_red_0e99ecd',
    sentence:
      'R5 CODE-BEARING COMMIT: 0e99ecd0cde3591a6ebafa66a94b23e9b7d954ee. It is the current HEAD and it is a RED head, not a submission.',
    why: '0e99ecd has not been HEAD since 174c789 was pushed, and 174c789 is green.',
  },
  {
    id: 'two_pushed_commits',
    sentence: 'TWO CODE-BEARING COMMITS HAVE BEEN PUSHED AND BOTH FAILED THEIR EXACT-SHA CI RUN',
    why: 'THREE code-bearing commits exist. Publishing two of three understates the budget breach the architect ruled on.',
  },
  {
    id: 'r5_ci_run_not_discharged',
    sentence: 'THE R5 CI RUN IS NOT DISCHARGED',
    why: 'the exact-SHA run at the final code-bearing commit completed with every job successful.',
  },
  {
    id: 'unverified_until_a_final_run',
    sentence: 'STILL UNVERIFIED UNTIL A CI RUN AT THE FINAL HEAD PROVES IT',
    why: 'the run at the final head has happened. What is still unverified is the uncommitted R6 work, and the map must say THAT.',
  },
  {
    id: 'no_commit_exists_to_measure',
    sentence: 'The order forbids committing, so no commit exists to measure',
    why: 'three code-bearing commits exist and are measurable; the map row must measure them.',
  },
  {
    id: 'policy_evidence_has_no_mutation_coverage',
    sentence:
      'that runner carries no mutation against migration 057 or any policy-evidence constraint',
    why: 'scripts/database-control-mutations.ts mutates the policy-evidence controls in the database and gates CI on zero survivors.',
  },
  {
    id: 'no_ci_run_covers_the_r6_working_tree',
    sentence:
      'NO CI RUN COVERS THE FBL-020-R6 WORKING TREE, WHICH IS UNCOMMITTED ON TOP OF THAT COMMIT',
    why: 'this was a REQUIRED statement until the operator authorised committing the R6 work. It is committed, and an exact-SHA run measured it. Requiring it a moment longer would have made this gate the author of the sentence class it was built to refuse.',
  },
  {
    id: 'r6_order_forbids_committing',
    sentence: 'The R6 order forbids committing and pushing',
    why: 'the operator authorised a different transfer path and the work was committed and pushed. A prohibition that has been lifted may not be cited as the reason a document has nothing to measure.',
  },
  {
    id: 'no_ci_run_covers_this_working_tree',
    sentence: 'No CI run covers this working tree',
    why: 'the same claim as the rule above, in sentence case, in the R6 order document. It escaped the register once by being REWORDED rather than repeated — "covers" where the banned sentence said "exists for" — which is why it is listed by its own text instead of trusted to a near neighbour.',
  },
  {
    id: 'unverified_for_the_uncommitted_r6_work',
    sentence: 'UNVERIFIED FOR THE UNCOMMITTED FBL-020-R6 WORK ON TOP OF IT',
    why: 'the requirement map closed several verdicts with this clause. The R6 work is committed and measured, so the clause understates what has been verified — a verdict stale in the direction of pessimism is still a stale verdict.',
  },
  {
    id: 'blueprint_not_materialized',
    sentence:
      'THE VERSION 2.0 BLUEPRINT BYTES WERE NOT MATERIALIZED IN THE REVIEW WORKSPACE, AND ' +
      'THE ONLY ACCESSIBLE PROJECT COPIES REMAIN THE VERSION 1.0 FILE',
    why: 'this was a REQUIRED statement until FBL-020-R6, and it is now refused for two reasons at once. The operator committed the Version 2.0 bytes into this repository, so the governing document IS in the project record a reader of this tree can open. And the second half was always a claim about the reviewer own workspace, which nothing here can observe — so it may not be asserted, in either direction, by a document this repository publishes.',
  },
  {
    id: 'blueprint_supplied_twice',
    sentence: 'The operator has supplied the Version 2.0 bytes to the reviewer twice',
    why: 'it characterises an attempted supply as a completed one. Whether those bytes reached the reviewer project record is not observable from this repository, which may therefore call the supply neither completed nor uncompleted.',
  },
];

/**
 * Markdown wraps lines, decorates with backticks and asterisks, and puts thousands
 * separators in numbers. None of that changes what a sentence says, and all of it would
 * break a literal `includes`. Everything else must match character for character.
 */
export function normalize(text: string): string {
  return text
    .replace(/[`*_]/g, '')
    .replace(/\\(?=[|_*`])/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Masks the withdrawal regions of a Markdown document, so a quoted claim is not an assertion. */
export function maskWithdrawn(markdown: string): { masked: string; regions: number } {
  let masked = '';
  let rest = markdown;
  let regions = 0;
  for (;;) {
    const start = rest.indexOf(WITHDRAWN_START);
    if (start === -1) break;
    const end = rest.indexOf(WITHDRAWN_END, start);
    if (end === -1) break;
    masked += rest.slice(0, start);
    rest = rest.slice(end + WITHDRAWN_END.length);
    regions += 1;
  }
  return { masked: masked + rest, regions };
}

/**
 * Masks a JSON document's declared withdrawal arrays. Every OTHER string in the document
 * is scanned, so a stale claim cannot hide in a verdict, a note or a requirement.
 */
export function maskWithdrawnJson(text: string): { masked: string; regions: number } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { masked: text, regions: 0 };
  }
  let regions = 0;
  const strip = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(strip);
    if (node !== null && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (key === JSON_WITHDRAWAL_KEY) {
          regions += 1;
          continue;
        }
        out[key] = strip(value);
      }
      return out;
    }
    return node;
  };
  return { masked: JSON.stringify(strip(parsed)), regions };
}

export function maskDocument(file: string, text: string): { masked: string; regions: number } {
  return file.endsWith('.json') ? maskWithdrawnJson(text) : maskWithdrawn(text);
}

// ── the comparison ─────────────────────────────────────────────────────────────────

const HEX40 = /^[0-9a-f]{40}$/;

function runProblems(label: string, sha: string, run: WorkflowRun): string[] {
  const problems: string[] = [];
  if (!HEX40.test(run.head_sha))
    problems.push(`${label}: run ${run.run_id} records a head_sha that is not a full SHA`);
  if (run.head_sha !== sha)
    problems.push(
      `${label}: run ${run.run_id} has head_sha ${run.head_sha}, which is NOT the commit it is ` +
        `attributed to (${sha}). A run of a different tree is not an exact-SHA run.`,
    );
  if (!Number.isInteger(run.run_id) || run.run_id <= 0)
    problems.push(`${label}: run_id ${String(run.run_id)} is not a run identifier`);
  if (run.workflow_path !== '.github/workflows/ci.yml')
    problems.push(`${label}: run ${run.run_id} names workflow ${run.workflow_path}`);
  if (run.jobs.length !== run.jobs_total)
    problems.push(
      `${label}: run ${run.run_id} declares ${run.jobs_total} jobs and lists ${run.jobs.length}. ` +
        'A run-level conclusion without every per-job conclusion beside it is what this order ' +
        'forbids being offered as evidence.',
    );
  const nonSuccess = run.jobs.filter((j) => j.conclusion !== 'success').length;
  if (nonSuccess !== run.jobs_non_success)
    problems.push(
      `${label}: run ${run.run_id} declares ${run.jobs_non_success} non-success jobs and lists ` +
        `${nonSuccess}`,
    );
  const allGreen = nonSuccess === 0 && run.jobs.length > 0;
  if (allGreen && run.conclusion !== 'success')
    problems.push(
      `${label}: run ${run.run_id} lists only successful jobs but concludes ` + run.conclusion,
    );
  if (!allGreen && run.conclusion === 'success')
    problems.push(
      `${label}: run ${run.run_id} concludes success while ${nonSuccess} of its jobs did not`,
    );
  return problems;
}

export function finalStateProblems(
  state: FinalState,
  git_: GitFacts,
  documents: Record<string, string>,
): string[] {
  const problems: string[] = [];
  /*
   * Hoisted: the budget arithmetic among the SHA checks below needs the count of commits
   * sitting on top of the evidence commit, and it runs first. The list itself is VALIDATED
   * further down, beside the run checks it belongs with.
   */
  const ahead = state.commits_ahead_of_the_evidence_commit ?? [];
  /*
   * ── A RECORD CANNOT NAME THE COMMIT IT LIVES IN ─────────────────────────────
   *
   * The list above is checked to be EXACTLY `git rev-list <evidence>..HEAD`, which is right
   * for every commit except one: the commit that CONTAINS this record. Its SHA does not
   * exist until the commit is written, so a record inside it can never list it, and a gate
   * demanding otherwise is a gate nobody can pass — the same reasoning that made
   * `repository_head_relation` an ENUM rather than a SHA.
   *
   * So EXACTLY ONE omission is tolerated, HEAD's, and it is tolerated rather than ignored:
   * the budget below ADDS it back, so the count is not understated by the allowance, and
   * `main()` prints the allowance whenever it is in play. Any other missing commit is a
   * real omission and is reported.
   *
   * Both shapes are legitimate and both occur. A record edited in the working tree describes
   * a HEAD that already exists and lists it. The same record, once committed, sits one
   * commit behind itself. Accepting only the first would fail every commit at the moment it
   * is made; accepting any omission at all would reopen the undercount this field exists to
   * close.
   */
  const recordedAhead = ahead.map((c) => c.sha);
  const selfCommitCounted = state.this_commit?.is_code_bearing === true;
  const aheadCodeBearing = ahead.filter((c) => c.code_bearing).length + (selfCommitCounted ? 1 : 0);
  /*
   * DOCUMENTATION IS A PATH RULE, WRITTEN OUT RATHER THAN LEFT TO INTUITION. Anything under
   * `docs/` and any Markdown file at the repository root is documentation. A migration is
   * code. A test is code. A script is code. If a commit touches ANY path outside that set it
   * is code-bearing, whatever the commit message calls it.
   */
  const isDocumentationPath = (path: string): boolean =>
    path.startsWith('docs/') || /^[^/]+\.md$/.test(path);
  if (git_.headPaths !== undefined && git_.headPaths.length > 0) {
    const codePaths = git_.headPaths.filter((f) => !isDocumentationPath(f));
    const declared = state.this_commit?.is_code_bearing;
    if (declared === false && codePaths.length > 0)
      problems.push(
        `this_commit declares is_code_bearing FALSE, but HEAD changes ${codePaths.length} ` +
          `path(s) outside docs/: ${codePaths.slice(0, 6).join(', ')}` +
          (codePaths.length > 6 ? ', …' : '') +
          '. A commit that carries code is code-bearing however it is described, and the ' +
          'commit budget counts it.',
      );
    if (declared === true && codePaths.length === 0)
      problems.push(
        'this_commit declares is_code_bearing TRUE, but HEAD changes nothing outside docs/. ' +
          'Counting a documentation commit against the budget overstates a breach, which is ' +
          'as wrong as understating it.',
      );
  }
  if (state.this_commit === undefined)
    problems.push(
      'the record does not declare this_commit. A record that cannot say whether the commit ' +
        'containing it is code-bearing cannot publish a commit budget, because that commit is ' +
        'the one SHA it can never name.',
    );
  else if (
    typeof state.this_commit.why_it_has_no_sha_here !== 'string' ||
    state.this_commit.why_it_has_no_sha_here.trim() === ''
  )
    problems.push(
      'this_commit.why_it_has_no_sha_here must say why the SHA is absent, so a reader meets ' +
        'the reason rather than an unexplained gap in the list',
    );

  // ── 1. the SHAs, against git ────────────────────────────────────────────────
  const named: Array<[string, string, string]> = [
    ['the R5 baseline', state.r5_baseline.sha, state.r5_baseline.subject],
    ...state.commits_in_the_measured_range.map(
      (c) => [`code-bearing commit ${c.short}`, c.sha, c.subject] as [string, string, string],
    ),
  ];
  for (const [label, sha, subject] of named) {
    if (!HEX40.test(sha)) {
      problems.push(`${label}: ${sha} is not a full 40-character commit SHA`);
      continue;
    }
    // A shallow clone holds one commit object. Anything else is UNMEASURED here, not
    // absent from the repository; `main()` names the limbs that did not run. Where there is
    // no repository at all, NO commit is measurable and every one of them is unmeasured —
    // reporting "is not a commit in this repository" would be a finding about the delivery
    // derived from the absence of a `.git` directory.
    if (git_.absent) continue;
    if (git_.shallow && sha !== git_.head) continue;
    const real = git_.subject[sha];
    if (real === undefined) {
      problems.push(`${label}: ${sha} is not a commit in this repository`);
      continue;
    }
    if (real !== subject)
      problems.push(
        `${label}: recorded subject ${JSON.stringify(subject)} but git says ` +
          `${JSON.stringify(real)}`,
      );
    if (!git_.ancestorOfHead[sha])
      problems.push(`${label}: ${sha} is not an ancestor of HEAD (${git_.head})`);
  }

  for (const c of state.commits_in_the_measured_range)
    if (!c.sha.startsWith(c.short))
      problems.push(`code-bearing commit: short form ${c.short} does not abbreviate ${c.sha}`);

  const listed = state.commits_in_the_measured_range.map((c) => c.sha);
  /*
   * COUNTED BY DECLARATION, NOT BY LIST LENGTH. `listed.length` is the size of the RANGE and
   * the budget is about CODE-BEARING commits, which stopped being the same number the moment
   * a documentation-only closeout landed inside the range. Using the length would have
   * overstated the breach by one — and a budget figure that is wrong in the direction of
   * severity is still a wrong budget figure.
   */
  const rangeCodeBearing = state.commits_in_the_measured_range.filter((c) => c.code_bearing).length;
  for (const c of state.commits_in_the_measured_range)
    if (typeof c.code_bearing !== 'boolean')
      problems.push(
        `commit ${c.short} in the measured range does not declare code_bearing. Every commit ` +
          'in the range must say which it is, because the budget counts one kind and the ' +
          'range holds both.',
      );
  if (!git_.shallow && !git_.absent) {
    const inRange = git_.baselineToEvidence;
    const missing = inRange.filter((sha) => !listed.includes(sha));
    const invented = listed.filter((sha) => !inRange.includes(sha));
    if (missing.length > 0)
      problems.push(
        `${missing.length} commit(s) in ${state.r5_baseline.sha.slice(0, 7)}..` +
          `${state.evidence_commit_sha.slice(0, 7)} are NOT recorded: ${missing.join(', ')}. ` +
          'A final state that lists fewer commits than the history holds is the R5 defect.',
      );
    if (invented.length > 0)
      problems.push(
        `${invented.length} recorded commit(s) are not in that range: ${invented.join(', ')}`,
      );
    /*
     * DERIVED FROM GIT'S RANGE, NOT FROM THE RECORD'S LIST — and this limb is the one the R5
     * undercount died on, so it may not quietly become a restatement of the record.
     *
     * Counting the record's own `code_bearing` flags would make the budget self-consistent at
     * whatever number the record chose: drop a commit from the list, drop it from the count,
     * and the arithmetic agrees with itself. That is EXACTLY the shape R5 shipped. So the
     * count starts from `git rev-list` and subtracts only the commits the record has
     * explicitly flagged NOT code-bearing AND that git actually holds in the range. A commit
     * the record omits is therefore counted as code-bearing — the conservative direction —
     * and the mismatch is reported here as well as by the missing-commit check above.
     */
    const excusedInRange = state.commits_in_the_measured_range.filter(
      (c) => !c.code_bearing && inRange.includes(c.sha),
    ).length;
    const expectedInRange = inRange.length - excusedInRange;
    if (state.commit_budget.used !== expectedInRange + aheadCodeBearing)
      problems.push(
        `commit_budget.used is ${state.commit_budget.used} and git counts ${inRange.length} ` +
          `commit(s) in the recorded range, of which the record flags ${excusedInRange} as not ` +
          `code-bearing, plus ${aheadCodeBearing} on top of the evidence commit — ` +
          `${expectedInRange + aheadCodeBearing} in total`,
      );
  } else if (state.commit_budget.used !== rangeCodeBearing + aheadCodeBearing) {
    // Reached on a shallow clone AND on a tree with no repository: neither can recompute
    // the range, and both can still check the record's own arithmetic.
    /*
     * The range cannot be recomputed here, but the record must still be internally
     * consistent: the budget it publishes is the number of commits it lists. That is the
     * ARITHMETIC half of the R5 defect and it needs no history at all, so a shallow
     * checkout still refuses a record that publishes two while listing three.
     */
    problems.push(
      `commit_budget.used is ${state.commit_budget.used} and the record declares ` +
        `${rangeCodeBearing} code-bearing commit(s) in the range plus ${aheadCodeBearing} on ` +
        'top of the evidence commit (no history here, so only the record’s own arithmetic ' +
        'was checked)',
    );
  }
  /*
   * ── THE COMMITS ON TOP OF THE EVIDENCE COMMIT ───────────────────────────────
   *
   * Checked against git in BOTH directions, exactly as the range below the evidence commit
   * is: a commit git holds and the record omits is the understatement defect, and a commit
   * the record invents is the opposite one.
   */
  for (const c of ahead) {
    if (!HEX40.test(c.sha)) {
      problems.push(
        `commit ahead of the evidence commit: ${c.sha} is not a full 40-character commit SHA`,
      );
      continue;
    }
    if (!c.sha.startsWith(c.short))
      problems.push(
        `commit ahead of the evidence commit: short form ${c.short} does not abbreviate ${c.sha}`,
      );
    if (c.run !== null) {
      problems.push(...runProblems(`commit ahead of the evidence commit ${c.short}`, c.sha, c.run));
      if (c.run.head_sha !== c.sha)
        problems.push(
          `commit ahead of the evidence commit ${c.short}: run ${c.run.run_id} names head_sha ` +
            `${c.run.head_sha}, which is a different commit`,
        );
    }
  }
  if (!git_.shallow && !git_.absent) {
    const inAhead = git_.aheadOfEvidence;
    /*
     * HEAD is exempt from the LIST for the same reason it is added to the COUNT by
     * declaration: a record cannot name the commit that contains it. The exemption is
     * git-derived because it is a question about the list ("is the unlisted one HEAD?"),
     * which only git can answer; the COUNT is declaration-derived because it must come out
     * the same in a tree with no repository at all.
     */
    const missingAhead = inAhead.filter((sha) => !recordedAhead.includes(sha) && sha !== git_.head);
    const inventedAhead = recordedAhead.filter((sha) => !inAhead.includes(sha));
    if (missingAhead.length > 0)
      problems.push(
        `${missingAhead.length} commit(s) sit on top of the evidence commit and are NOT ` +
          `recorded: ${missingAhead.join(', ')}. A commit made after the last measured run is ` +
          'still a commit, and omitting it understates the delivery. (HEAD itself is exempt — ' +
          'a record cannot name the commit it lives in — and these are not HEAD.)',
      );
    if (inventedAhead.length > 0)
      problems.push(
        `${inventedAhead.length} recorded commit(s) are not on top of the evidence commit: ` +
          inventedAhead.join(', '),
      );
    for (const c of ahead) {
      const real = git_.subject[c.sha];
      if (real !== undefined && real !== c.subject)
        problems.push(
          `commit ahead of the evidence commit ${c.short}: recorded subject ` +
            `${JSON.stringify(c.subject)} but git says ${JSON.stringify(real)}`,
        );
    }
  }

  /*
   * `failed_ci` is a fact about the BUDGET, so it counts the failures of commits the budget
   * counts. `d0b9924`'s run was red and `d0b9924` is documentation-only: it is recorded in
   * full, with its per-job conclusions and its cause, and it is not charged to a budget it
   * never spent from.
   */
  const reallyFailed =
    state.commits_in_the_measured_range.filter(
      (c) => c.code_bearing && c.run.conclusion !== 'success',
    ).length +
    ahead.filter((c) => c.code_bearing && c.run !== null && c.run.conclusion !== 'success').length;
  if (state.commit_budget.failed_ci !== reallyFailed)
    problems.push(
      `commit_budget.failed_ci is ${state.commit_budget.failed_ci} and ${reallyFailed} recorded ` +
        'runs did not conclude success',
    );
  if (state.commit_budget.used > state.commit_budget.allowed) {
    if (state.commit_budget.verdict !== 'VIOLATED')
      problems.push(
        `${state.commit_budget.used} code-bearing commits against a budget of ` +
          `${state.commit_budget.allowed} is a VIOLATION; the record says ` +
          `${JSON.stringify(state.commit_budget.verdict)}`,
      );
    if (!state.commit_budget.disclosure_does_not_cure_the_violation)
      problems.push(
        'the record must state that disclosure does not cure the violation, because the ' +
          'architect ruled exactly that',
      );
  }

  // ── 2. the runs ─────────────────────────────────────────────────────────────
  for (const c of state.commits_in_the_measured_range)
    problems.push(...runProblems(`code-bearing commit ${c.short}`, c.sha, c.run));

  const run = evidenceRun(state);
  if (run === undefined)
    problems.push(
      `evidence_commit_sha ${state.evidence_commit_sha} names no recorded code-bearing commit`,
    );
  else if (run.conclusion !== 'success')
    problems.push(
      `the evidence commit's run ${run.run_id} concluded ${run.conclusion}; a red run is not ` +
        'evidence of a green head',
    );
  if (state.commits_in_the_measured_range.at(-1)?.sha !== state.evidence_commit_sha)
    problems.push('the evidence commit must be the LAST code-bearing commit in the record');

  // ── 3. the head relation, and the working tree ──────────────────────────────
  //
  // DERIVED, NOT SKIPPED, WHEN THE CLONE IS SHALLOW. `git rev-parse HEAD` resolves on a
  // `--depth 1` checkout, so "is the tip the evidence commit?" is answerable there by
  // comparing two SHAs — no ancestry, no rev-list. This is the limb FBL-020-R5 was
  // rejected over, and it is therefore the one limb that must not depend on fetch depth.
  const headIsEvidence = git_.shallow
    ? git_.head === state.evidence_commit_sha
    : git_.aheadOfEvidence.length === 0;
  const declared = state.repository_head_relation;
  // THE MESSAGE NAMES THE COMMAND THAT ACTUALLY RAN — R6-R6 finding D7. This used to
  // report `git rev-list <evidence>..HEAD is empty` unconditionally, and on a shallow
  // clone that rev-list is never run: `readGit` returns early with an EMPTY
  // `aheadOfEvidence` and the relation is derived by comparing two SHAs. So a reader
  // debugging a shallow CI failure was pointed at a range the gate had not measured, and
  // could have "confirmed" the message by running it themselves on a full clone.
  /*
   * AND NOT DECIDED AT ALL WHERE THERE IS NO REPOSITORY. The comment above is careful that
   * the head relation SURVIVES a shallow clone; it does not survive the ABSENCE of one,
   * because there is no HEAD to compare against. `headIsEvidence` would be computed from
   * `head: ''` and would report a contradiction between the record and a repository that is
   * not there. So the two checks below are skipped and NAMED as unrun — the same treatment
   * the history limbs get, for the same reason: a gate must not manufacture a finding out of
   * an environment. Everything after them still runs, because the document checks need no
   * git at all and are exactly what a tree copy is being used to exercise.
   */
  if (!git_.absent && headIsEvidence && declared !== 'HEAD_IS_THE_EVIDENCE_COMMIT')
    problems.push(
      `the record declares ${declared}, but ` +
        (git_.shallow
          ? `git rev-parse HEAD is ${git_.head}, which IS the recorded evidence commit ` +
            '(shallow clone: the relation was derived by comparing the two SHAs, and no ' +
            'rev-list was run)'
          : `git rev-list ${state.evidence_commit_sha}..HEAD is empty`) +
        ' — the evidence commit IS the tip',
    );
  if (!git_.absent && !headIsEvidence && declared !== 'HEAD_IS_AHEAD_OF_THE_EVIDENCE_COMMIT')
    problems.push(
      `the record declares ${declared}, but HEAD is ${git_.head} and the evidence commit is ` +
        `${state.evidence_commit_sha}` +
        (git_.shallow
          ? ' — they are different commits, so the exact-SHA run does NOT measure this head'
          : `; ${git_.aheadOfEvidence.length} commit(s) sit on top of the evidence commit ` +
            `(${git_.aheadOfEvidence.join(', ')}). The exact-SHA run does NOT measure this ` +
            'head, and the delivery documents may not say it does.'),
    );
  /*
   * FBL-020-R6: `UNCOMMITTED_ON_TOP_OF_THE_EVIDENCE_COMMIT` is GONE rather than retained as a
   * still-legal value. The R6 work is committed; a record declaring it uncommitted would now
   * be false, and leaving the value admissible would leave the stale required sentence one
   * edit away from being satisfiable again.
   *
   * `COMMITTED_AS_THE_EVIDENCE_COMMIT` is the value that fits what is actually true, and it
   * is not a synonym for `COMMITTED`. `COMMITTED` asserts the delivery IS the tip. That
   * cannot be declared by a record while a documentation closeout naming the run sits on top
   * of the commit the run measured — a run cannot exist for a commit before the commit does.
   * The new value asserts the narrower, checkable thing: the R6 work is the evidence commit,
   * the recorded run measured THAT, and whatever sits above it is described by
   * `repository_head_relation` rather than waved at here.
   */
  const treeStates = [
    'COMMITTED_AHEAD_OF_THE_EVIDENCE_COMMIT',
    'COMMITTED_AS_THE_EVIDENCE_COMMIT',
    'COMMITTED',
  ];
  if (!treeStates.includes(state.working_tree.state))
    problems.push(
      `working_tree.state is ${JSON.stringify(state.working_tree.state)}, which is not one of ` +
        treeStates.join(' / '),
    );
  if (!git_.absent && state.working_tree.state === 'COMMITTED' && !headIsEvidence)
    problems.push(
      'working_tree.state says COMMITTED, but commits sit on top of the evidence commit and no ' +
        'run measures them — the delivery is not the commit the run measured',
    );
  if (state.working_tree.state === 'COMMITTED_AHEAD_OF_THE_EVIDENCE_COMMIT') {
    /*
     * The value CLAIMS that committed work sits above the measured commit, so git is asked
     * whether anything is up there. Declaring it over a tip that IS the evidence commit
     * would understate what the run covered in the one direction nobody checks for.
     */
    if (!git_.absent && !git_.shallow && git_.aheadOfEvidence.length === 0)
      problems.push(
        'working_tree.state says COMMITTED_AHEAD_OF_THE_EVIDENCE_COMMIT, but no commit sits ' +
          'on top of the evidence commit — the run named in the record measures this tip',
      );
    if (state.repository_head_relation !== 'HEAD_IS_AHEAD_OF_THE_EVIDENCE_COMMIT')
      problems.push(
        'working_tree.state says COMMITTED_AHEAD_OF_THE_EVIDENCE_COMMIT while ' +
          `repository_head_relation says ${state.repository_head_relation}. The two fields ` +
          'describe the same geometry and may not disagree.',
      );
  }
  if (state.working_tree.state === 'COMMITTED_AS_THE_EVIDENCE_COMMIT') {
    /*
     * The value is a CLAIM that a run measured the work, so it is checked against the run
     * rather than accepted. Declaring it over a red or missing run would republish the R5
     * defect in the one field built to record that defect's correction.
     */
    const run = evidenceRun(state);
    if (run === undefined)
      problems.push(
        'working_tree.state says COMMITTED_AS_THE_EVIDENCE_COMMIT, but the evidence commit is ' +
          'not among commits_in_the_measured_range, so no run is recorded as having measured it',
      );
    else if (run.conclusion !== 'success')
      problems.push(
        'working_tree.state says COMMITTED_AS_THE_EVIDENCE_COMMIT, but the run recorded for ' +
          `the evidence commit concluded ${run.conclusion} — a red run measures the commit ` +
          'without discharging it',
      );
  }
  if (state.working_tree.ci_run_for_this_working_tree !== null)
    problems.push(
      'working_tree.ci_run_for_this_working_tree must be null: a run measures a COMMIT, never ' +
        'a working tree. (This message used to add "while nothing is committed". The guard was ' +
        'never conditional on that, and the clause stopped being true once the work was ' +
        'committed — a false premise inside a correct check is still a false premise.)',
    );

  // ── 4. the submission status ────────────────────────────────────────────────
  const statuses: SubmissionStatus[] = ['NOT SUBMITTABLE AS COMPLETE', 'SUBMITTABLE AS COMPLETE'];
  if (!statuses.includes(state.submission.status))
    problems.push(
      `submission.status is ${JSON.stringify(state.submission.status)}, which is not one of ` +
        statuses.join(' / '),
    );
  if (
    state.submission.status === 'NOT SUBMITTABLE AS COMPLETE' &&
    state.submission.blocking.length === 0
  )
    problems.push('a NOT SUBMITTABLE status must name what blocks it');
  if (state.submission.status === 'SUBMITTABLE AS COMPLETE' && state.submission.blocking.length > 0)
    problems.push('a SUBMITTABLE status cannot also list blocking items');
  if (
    state.blueprint_section_3_1.status === 'OPEN' &&
    state.submission.status !== 'NOT SUBMITTABLE AS COMPLETE'
  )
    problems.push(
      'FBL-020-R6 §4.6: while §3.1 is OPEN the revision MAY NOT be submitted as complete',
    );

  // ── 5. the prose ────────────────────────────────────────────────────────────
  for (const statement of requiredStatements(state)) {
    const want = normalize(statement.sentence);
    for (const file of statement.documents) {
      const text = documents[file];
      if (text === undefined) {
        problems.push(`${file}: not readable, so it cannot state the final state`);
        continue;
      }
      if (!normalize(text).includes(want))
        problems.push(
          `${file} does not carry the required statement "${statement.id}": ${statement.sentence}`,
        );
    }
  }

  for (const file of GOVERNED) {
    const text = documents[file];
    if (text === undefined) continue;
    const { masked } = maskDocument(file, text);
    const scanned = normalize(masked);
    for (const forbidden of FORBIDDEN)
      if (scanned.includes(normalize(forbidden.sentence)))
        problems.push(
          `${file} still asserts the withdrawn claim "${forbidden.id}": ` +
            `"${forbidden.sentence}" — ${forbidden.why}`,
        );
  }

  /*
   * The wider surface — see ALSO_SCANNED. Unmasked, because these files have no withdrawal
   * regions and an occurrence in one is therefore an assertion, never a quotation.
   */
  for (const file of ALSO_SCANNED) {
    /*
     * From `documents`, never from disk. `finalStateProblems` is PURE over the map it is
     * handed — that is what lets the suite stage a document, and what lets the gate run
     * against a `--depth 1` clone by reading that clone's files. An earlier revision of this
     * loop called readFileSync(join(ROOT, …)) and broke both at once: it scanned the working
     * repository while the caller was asking about somewhere else.
     */
    const text = documents[file];
    if (text === undefined) continue;
    const scanned = normalize(text);
    for (const forbidden of FORBIDDEN)
      if (scanned.includes(normalize(forbidden.sentence)))
        problems.push(
          `${file} asserts the withdrawn claim "${forbidden.id}": "${forbidden.sentence}" — ` +
            `${forbidden.why}. This file carries no withdrawal markers, so the occurrence is ` +
            'an assertion, not a quotation.',
        );
  }

  /*
   * ── 6. THE RECORD'S OWN WITHDRAWAL LIST IS LOAD-BEARING ─────────────────────
   *
   * `withdrawn_claims` is where the record keeps the false sentences verbatim, so a reader
   * can see what was corrected rather than a diff nobody will run. A list that drifted away
   * from what the gate actually refuses would be decoration, so it is held to `FORBIDDEN`
   * in BOTH directions: every refused sentence must be recorded as withdrawn, and the record
   * may not claim to have withdrawn a sentence nothing stops a document reasserting.
   */
  const recorded = (state.withdrawn_claims ?? []).map(normalize);
  for (const forbidden of FORBIDDEN)
    if (!recorded.some((claim) => claim.includes(normalize(forbidden.sentence))))
      problems.push(
        `the record does not list "${forbidden.id}" among withdrawn_claims, so the sentence ` +
          'the gate refuses is nowhere quoted for a reader',
      );
  for (const claim of state.withdrawn_claims ?? [])
    if (!FORBIDDEN.some((f) => normalize(claim).includes(normalize(f.sentence))))
      problems.push(
        `withdrawn_claims records "${claim.slice(0, 60)}…", which no FORBIDDEN rule refuses — ` +
          'a withdrawal nothing enforces is a withdrawal a later revision can undo',
      );

  return problems;
}

export function readDocuments(root = ROOT): Record<string, string> {
  const documents: Record<string, string> = {};
  for (const file of GOVERNED) documents[file] = readFileSync(join(root, file), 'utf8');
  // The wider forbidden-scan surface. Optional: a shallow clone or a staged fixture may
  // not carry every one, and a file that is absent is simply not scanned.
  for (const file of ALSO_SCANNED) {
    const full = join(root, file);
    if (existsSync(full)) documents[file] = readFileSync(full, 'utf8');
  }
  return documents;
}

function list(state: FinalState): void {
  console.log('id\tkind\twhat\tdocuments');
  for (const s of requiredStatements(state))
    console.log(`${s.id}\trequired\t${s.what}\t${s.documents.join(' ')}`);
  for (const f of FORBIDDEN) console.log(`${f.id}\tforbidden\t${f.why}\t(every governed document)`);
  for (const h of HISTORY_DEPENDENT_CHECKS)
    console.log(`${h.id}\thistory\tneeds ${h.needs}\t(skipped on a shallow clone, and reported)`);
}

/**
 * `--root <dir>` runs the gate against ANOTHER checkout. It exists for the shallow-clone
 * proof in `tests/delivery-documentation.test.ts`, which makes a real `git clone --depth 1`
 * and points this gate at it: proving the shallow path by REASONING about git is exactly
 * how this order got bitten four times before.
 */
function parseRoot(argv: readonly string[]): string {
  const flag = argv.indexOf('--root');
  if (flag >= 0) {
    const value = argv[flag + 1];
    if (value === undefined) {
      console.error('--root needs a directory');
      process.exit(2);
    }
    return value;
  }
  return ROOT;
}

function main(): void {
  const argv = process.argv.slice(2);
  const root = parseRoot(argv);
  const state = readFinalState(root);
  if (argv.includes('--list')) {
    list(state);
    return;
  }

  const facts = readGitFacts(state, root);
  const problems = finalStateProblems(state, facts, readDocuments(root));

  const run = evidenceRun(state);
  console.log(`record: ${RECORD}`);
  console.log(`repository HEAD: ${facts.head}`);
  console.log(`evidence commit: ${state.evidence_commit_sha} (${state.repository_head_relation})`);
  console.log(
    `exact-SHA run: ${run?.run_id ?? '?'} ${run?.conclusion ?? '?'} ` +
      `${(run?.jobs_total ?? 0) - (run?.jobs_non_success ?? 0)}/${run?.jobs_total ?? 0} jobs`,
  );
  console.log(
    `code-bearing commits: ${state.commit_budget.used} (budget ${state.commit_budget.allowed}, verdict ${state.commit_budget.verdict})`,
  );
  console.log(`submission: ${state.submission.status}`);
  if (state.this_commit?.is_code_bearing)
    console.log(
      '  note: the commit this record lives in is code-bearing and is COUNTED in the budget ' +
        'above, but cannot be listed by SHA — a record cannot name the commit that contains ' +
        'it. The count is taken from the record’s own declaration, so it is the same number ' +
        'in a checkout and in a tree with no .git.',
    );
  console.log(
    `git history: ${facts.absent ? 'ABSENT (this tree is not a git repository)' : facts.shallow ? 'SHALLOW' : 'complete'}`,
  );
  if (facts.absent) {
    /*
     * SAID OUT LOUD, EVERY TIME — and it says MORE than the shallow branch, because more was
     * skipped. A shallow clone still decides the head relation from `HEAD` alone; a tree with
     * no repository decides nothing about git, so the head relation joins the history limbs
     * in the not-run list. What DOES run here is the whole document half of the gate, which
     * is precisely what a tree copy exists to exercise.
     */
    console.log(
      `  there is no .git here, so the head relation and ${HISTORY_DEPENDENT_CHECKS.length} ` +
        'history check(s) below did NOT run. The document checks, the run-data checks and the ' +
        "record's own arithmetic all did. scripts/mutation-kill.ts builds exactly this " +
        'environment on purpose; ci.yml checks out the verify job with fetch-depth: 0, where ' +
        'the git limbs run.',
    );
    console.log('  - not run: head_relation (needs git rev-parse HEAD)');
    for (const h of HISTORY_DEPENDENT_CHECKS)
      console.log(`  - not run: ${h.id} (needs ${h.needs})`);
  }
  if (facts.shallow) {
    /*
     * SAID OUT LOUD, EVERY TIME. A shallow checkout cannot run the history limbs, and a
     * green line with no explanation would read as though it had. The head relation is
     * NOT in this list: it is derived from HEAD alone and still runs here.
     */
    console.log(
      `  this clone holds one commit object, so ${HISTORY_DEPENDENT_CHECKS.length} check(s) ` +
        'below did NOT run here. ci.yml checks out the verify job with fetch-depth: 0, ' +
        'where they do.',
    );
    for (const h of HISTORY_DEPENDENT_CHECKS)
      console.log(`  - not run: ${h.id} (needs ${h.needs})`);
  }

  if (problems.length > 0) {
    console.error('The checked-in final state does not describe this repository:');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log('The delivery documents state ONE final state, and it is this repository’s.');
}

if (require.main === module) main();
