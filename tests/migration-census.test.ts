import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
  MARKER_SCAN_LIMITS,
  OUT_OF_SCOPE,
  RUNNER_ENV_MARKERS,
  analyzeAllWorkflows,
  analyzeWorkflow,
  assessDisposability,
  censusAuthority,
  censusScope,
  ciFinding,
  composeNamedVolumes,
  composeVolumeCandidates,
  databaseNamesFromDisk,
  discoverWindowsDataDirectories,
  inspectDataDirectory,
  loadDisposableClusterPolicy,
  migration057Markers,
  persistenceFrom,
  provenanceFrom,
  readLaunchDeclaration,
  runningDataDirectoryForPort,
  scanForMarker,
  sourceHeadProvenance,
  summarize,
  toWslPath,
  verdictFromInspection,
  type ClusterContent,
  type ClusterInspection,
  type DisposabilityInput,
  type Finding,
  type MarkerScan,
} from '../scripts/migration-census';

/**
 * FBL-020-R5 §0.1 — THE CENSUS IS TESTED, NOT TRUSTED.
 *
 * The census reaches out to a Docker daemon, a WSL distribution and several data
 * directories, none of which exist on a CI runner — so its VERDICT LOGIC is what this
 * battery drives, directly and against hostile inputs. Two of those inputs matter most:
 *
 *   * a workflow that DOES give a service container a volume, or hides a bind mount in the
 *     `options:` string. If the analyzer cannot see either, the ephemerality finding is
 *     worthless and would have been reported as `no` regardless of the truth.
 *   * an environment nobody could inspect. It must come back `indeterminate`, because §0.2
 *     branches on the difference between "we looked and found nothing" and "we could not
 *     look", and rounding the second to the first is how a census stops being evidence.
 */

const ROOT = join(__dirname, '..');

describe('the migration census (FBL-020-R5 §0.1)', () => {
  test('the census REPORTS a finding and does not claim it was accepted', () => {
    /*
     * R4 shipped documents asserting "the architect's §0 census established …" and
     * "§0 CENSUS IS ALREADY DISCHARGED". No such acceptance had been given, and the review
     * called it out. So the script's own words are asserted here: it must state that the
     * conclusion is the implementer's, and it must not use the language of ratification.
     */
    const source = readFileSync(join(ROOT, 'scripts', 'migration-census.ts'), 'utf8');
    assert.match(source, /acceptance: 'NOT_REVIEWED'/, 'the artifact must declare its status');
    assert.match(source, /THE IMPLEMENTER'S/, 'and say whose conclusion it is');

    const clean: Finding[] = [
      {
        id: 'x',
        what_it_is: 'a persistent environment',
        persistence: 'persistent',
        inspected: true,
        inspection_method: 'filesystem',
        evidence: [],
        migration_057_applied: 'no',
        basis: 'nothing found',
        limits: [],
      },
    ];
    const reading = summarize(clean).implementer_reading;
    assert.match(reading, /implementer's reading/i);
    assert.match(reading, /not an acceptance by anyone/i);
    // The words that would re-introduce the false claim must not appear.
    for (const forbidden of [/discharged/i, /accepted by the architect/i, /ratified/i])
      assert.doesNotMatch(reading, forbidden, `the reading must not say ${String(forbidden)}`);
  });

  test('an uninspectable environment is `indeterminate`, never `no`', () => {
    // The distinction §0.2 turns on. An unreadable data directory establishes nothing, and a
    // scan that ran out of budget establishes nothing either — a MISS is only evidence when
    // the scan finished.
    const unreadable: ClusterInspection = {
      data_directory: 'D:/nowhere',
      // PRESENT and unreadable — the case that stays `indeterminate`. The absent case is
      // pinned separately by 'a data directory that VANISHED …' below.
      exists: true,
      readable: false,
      pg_version: 'unreadable',
      base_oids: [],
      base_mtimes: {},
      configured_port: 'unknown',
      host_based_auth: [],
      server_log_files: [],
      marker_057: { complete: false, bytes_scanned: 0, files_scanned: 0, hits: [] },
      marker_ledger: { complete: false, bytes_scanned: 0, files_scanned: 0, hits: [] },
      marker_tables_057: { complete: false, bytes_scanned: 0, files_scanned: 0, hits: [] },
    };
    assert.equal(verdictFromInspection(unreadable).verdict, 'indeterminate');

    const scan = (over: Partial<MarkerScan>): MarkerScan => ({
      complete: true,
      bytes_scanned: 10,
      files_scanned: 1,
      hits: [],
      ...over,
    });
    const readable = {
      ...unreadable,
      readable: true,
      marker_057: scan({}),
      marker_ledger: scan({}),
    };
    assert.equal(verdictFromInspection(readable).verdict, 'no');
    assert.equal(
      verdictFromInspection({ ...readable, marker_057: scan({ complete: false }) }).verdict,
      'indeterminate',
      'a scan that hit its budget cannot support a negative',
    );
    assert.equal(
      verdictFromInspection({ ...readable, marker_057: scan({ hits: ['base/5/1259'] }) }).verdict,
      'yes',
    );

    // …and an uninspected PERSISTENT environment must stop the §0.2 branch being taken.
    const unknown: Finding[] = [
      {
        id: 'u',
        what_it_is: 'something nobody could look at',
        persistence: 'persistent',
        inspected: false,
        inspection_method: 'none available',
        evidence: [],
        migration_057_applied: 'indeterminate',
        basis: 'could not be probed',
        limits: [],
      },
    ];
    const reading = summarize(unknown).implementer_reading;
    assert.match(reading, /COULD NOT\s+BE INSPECTED|COULD NOT BE INSPECTED/);
    assert.match(reading, /cannot\s+be taken on this evidence|cannot be taken/);
    assert.deepEqual(summarize(unknown).persistent_environments_indeterminate, ['u']);
  });

  test('a data directory that VANISHED between enumeration and inspection is `no`, while a PRESENT unreadable one stays `indeterminate`', () => {
    /*
     * FBL-020-R5 — the third appearance of the absence-is-not-silence class, pinned in
     * BOTH directions so it cannot come back a fourth time.
     *
     * The host sweep ENUMERATES data directories and the inspection reads them afterwards.
     * On a machine running this project's own drills, scratch clusters under the OS temp
     * directory are created and destroyed continuously, so a directory can be enumerated
     * and be gone by the time the inspection reaches it. `inspectDataDirectory` used to
     * return the same `readable: false` shape for that as for a directory that is sitting
     * right there and cannot be read, and `verdictFromInspection` mapped both to
     * `indeterminate` — which `summarize` counts WITH the persistent environments, so a few
     * disappearing temp clusters were enough to take the whole census to
     * BLOCKED_INDETERMINATE and `scripts/check-census-prose.ts` RED. A §0.2 position that
     * depends on how busy the host is is not evidence.
     *
     * Both halves are driven through the REAL filesystem, not a hand-built literal, because
     * the defect was in what the filesystem read produced, not in the mapping alone.
     */
    const scratch = mkdtempSync(join(tmpdir(), 'census-vanish-'));
    try {
      // ── DIRECTION 1: PRESENT and unreadable ⇒ indeterminate, and it still blocks §0.2.
      const present = join(scratch, 'present-but-unreadable');
      mkdirSync(present);
      const p = inspectDataDirectory(present, ['057_identity_boundary_completion.sql']);
      assert.equal(p.exists, true, 'the directory is there');
      assert.equal(p.readable, false, 'no PG_VERSION, so it cannot be read as a cluster');
      const pv = verdictFromInspection(p);
      assert.equal(pv.verdict, 'indeterminate');
      assert.match(pv.basis, /PRESENT/);

      const blocked = summarize([
        {
          id: 'present-but-unreadable',
          what_it_is: 'a directory that is there and could not be read',
          persistence: 'persistent',
          inspected: false,
          inspection_method: 'filesystem only',
          evidence: [],
          migration_057_applied: pv.verdict,
          basis: pv.basis,
          limits: [],
        },
      ]);
      assert.equal(
        blocked.position,
        'BLOCKED_INDETERMINATE',
        'a present-but-unreadable persistent environment must still stop the §0.2 branch',
      );

      // ── DIRECTION 2: enumerated, then GONE ⇒ `no`, with the vanishing as the basis.
      const doomed = join(scratch, 'vanishes');
      mkdirSync(doomed);
      writeFileSync(join(doomed, 'PG_VERSION'), '16\n');
      // Enumeration sees it…
      assert.ok(existsSync(doomed), 'enumerated while it existed');
      // …and it is gone before the inspection, exactly as a churning host does it.
      rmSync(doomed, { recursive: true, force: true });

      const g = inspectDataDirectory(doomed, ['057_identity_boundary_completion.sql']);
      assert.equal(g.exists, false, 'the directory is not there any more');
      assert.equal(g.readable, false);
      assert.match(g.pg_version, /gone/, 'the shape must say which of the two states it is in');
      const gv = verdictFromInspection(g);
      assert.equal(gv.verdict, 'no', 'a directory that no longer exists holds no migration');
      assert.match(gv.basis, /did not exist at inspection time|vanished/);

      const notBlocked = summarize([
        {
          id: 'vanished',
          what_it_is: 'a directory enumerated and gone before inspection',
          // Worst case for this test: even classified as PERSISTENT it must not block.
          persistence: 'persistent',
          inspected: true,
          inspection_method: 'filesystem only',
          evidence: [],
          migration_057_applied: gv.verdict,
          basis: gv.basis,
          limits: [],
        },
      ]);
      assert.equal(
        notBlocked.position,
        'EDIT_057_IN_PLACE',
        'absence must not be counted as an uninspected environment',
      );
      assert.deepEqual(notBlocked.persistent_environments_indeterminate, []);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test('a persistent environment holding 057 forces the 058 branch, and is reported separately from a disposable one', () => {
    const hit = (persistence: Finding['persistence']): Finding => ({
      id: `env-${persistence}`,
      what_it_is: 'an environment holding 057',
      persistence,
      inspected: true,
      inspection_method: 'sql',
      evidence: [],
      migration_057_applied: 'yes',
      basis: 'the ledger records it',
      limits: [],
    });

    const persistent = summarize([hit('persistent')]);
    assert.deepEqual(persistent.persistent_environments_with_057, ['env-persistent']);
    assert.match(persistent.implementer_reading, /freezes 057 and sends every further schema/);

    // A disposable cluster holding 057 is the ACTUAL state of this machine, and it must not
    // be laundered into the persistent bucket nor omitted from the artifact.
    const disposable = summarize([hit('disposable')]);
    assert.deepEqual(disposable.persistent_environments_with_057, []);
    assert.deepEqual(disposable.disposable_or_ephemeral_with_057, ['env-disposable']);
    assert.match(disposable.implementer_reading, /NO PERSISTENT ENVIRONMENT HAS APPLIED/);
  });

  /*
   * ── FBL-020-R5 gate finding G1 ─────────────────────────────────────────────────
   *
   * The delivered R5 census concluded FREEZE 057 because ONE line decided disposability:
   *
   *     const underTemp = dir.toLowerCase().startsWith(tmpdir().toLowerCase());
   *
   * A wave of that run put its own scratch cluster at `C:/Users/alegn/pgdata-fbl020r5`,
   * outside `%TEMP%` because the usual drill cluster was damaged. The expression saw a
   * path and called this project's throwaway cluster a persistent environment. These
   * tests drive the replacement — which reads the cluster, not the path — and they drive
   * BOTH directions: what must be `disposable`, and what must never be.
   */
  const POLICY = loadDisposableClusterPolicy();

  function content(names: string[], over: Partial<ClusterContent> = {}): ClusterContent {
    return {
      readable: true,
      source: 'test fixture',
      names: ['postgres', 'template0', 'template1', ...names],
      nondefault_base_oids: names.map((_, i) => String(20000 + i)),
      reconciled: true,
      detail: 'fixture',
      ...over,
    };
  }

  function scan(hits: string[], complete = true): MarkerScan {
    return { complete, bytes_scanned: 1, files_scanned: 1, hits };
  }

  function input(over: Partial<DisposabilityInput> = {}): DisposabilityInput {
    return {
      data_directory: 'C:/Users/alegn/pgdata-fbl020r5',
      launch: {
        readable: true,
        postmaster_opts: 'postgres.exe "-D" "C:/Users/alegn/pgdata-fbl020r5" "-p" "55434"',
        settings: {
          listen_addresses: { value: 'localhost', source: 'PostgreSQL default' },
          fsync: { value: 'on', source: 'PostgreSQL default' },
        },
      },
      content: content(['dealership_test']),
      markers: { migration: scan(['057_x.sql @ base/1/2']), ledger: scan(['schema_migrations']) },
      policy: POLICY,
      ...over,
    };
  }

  test('disposability is decided by PROVENANCE AND CONTENT, never by a path prefix', () => {
    /*
     * THE EXACT CLUSTER THE R5 CENSUS MISFILED. Nothing about it is under `%TEMP%`, and it
     * is nonetheless this project's own drill cluster: not machine-started, loopback only,
     * carrying this repository's ledger, holding only a database this repository declares.
     */
    const misfiled = assessDisposability(input());
    assert.equal(misfiled.verdict, 'disposable', misfiled.basis);
    assert.equal(persistenceFrom(misfiled.verdict), 'disposable');

    // And a cluster UNDER %TEMP% is not disposable for that reason: another project's
    // scratch directory, which this repository never wrote to, is not this project's.
    const strangers = assessDisposability(
      input({
        data_directory: 'C:/Users/alegn/AppData/Local/Temp/auth71-pg-04XE7N',
        markers: { migration: scan([]), ledger: scan([]) },
        content: content([]),
      }),
    );
    assert.equal(strangers.verdict, 'indeterminate', strangers.basis);
    assert.equal(persistenceFrom(strangers.verdict), 'indeterminate');
    assert.match(strangers.basis, /never wrote to this cluster/);
  });

  test('a cluster whose provenance cannot be established is INDETERMINATE, and counts as persistent', () => {
    // Each necessary input, withheld one at a time. None may produce `disposable`.
    const withheld: Array<[string, DisposabilityInput, 'indeterminate' | 'not_disposable']> = [
      [
        'the launch declaration is unreadable',
        input({
          launch: { readable: false, postmaster_opts: 'none', settings: {} },
        }),
        'indeterminate',
      ],
      [
        'the marker scan ran out of budget',
        input({ markers: { migration: scan([], false), ledger: scan([]) } }),
        'indeterminate',
      ],
      [
        'the database inventory could not be read',
        input({ content: content([], { readable: false }) }),
        'indeterminate',
      ],
      [
        'base/ holds a database no name could be recovered for',
        input({ content: content(['dealership_test'], { reconciled: false }) }),
        'indeterminate',
      ],
      [
        'an undeclared database is present and durability is ON',
        input({ content: content(['dealership_test', 'tmpl0_probe']) }),
        'indeterminate',
      ],
      [
        'the machine starts this cluster',
        input({ service: { service: 'postgresql-x64-16', state: 'RUNNING' } }),
        'not_disposable',
      ],
      [
        'it listens beyond loopback',
        input({
          launch: {
            readable: true,
            postmaster_opts: 'postgres.exe "-c" "listen_addresses=0.0.0.0"',
            settings: {
              listen_addresses: { value: '0.0.0.0', source: 'postmaster.opts' },
              fsync: { value: 'on', source: 'PostgreSQL default' },
            },
          },
        }),
        'not_disposable',
      ],
      [
        'it holds a database this repository designates as depended-upon',
        input({ content: content(['dealership']) }),
        'not_disposable',
      ],
    ];
    for (const [why, withoutIt, expected] of withheld) {
      const verdict = assessDisposability(withoutIt).verdict;
      assert.equal(verdict, expected, `${why}: expected ${expected}, got ${verdict}`);
      assert.notEqual(verdict, 'disposable', `${why} must never yield 'disposable'`);
    }

    /*
     * AND THE CONSEQUENCE, which is the whole point of the third value: an unclassifiable
     * cluster is counted with the persistent ones, so it BLOCKS the §0.2 branch exactly as
     * a persistent one would.
     */
    const unclassifiable: Finding = {
      id: 'env-unclassifiable',
      what_it_is: 'a cluster nobody could classify',
      persistence: 'indeterminate',
      inspected: true,
      inspection_method: 'filesystem',
      evidence: [],
      migration_057_applied: 'yes',
      basis: 'the ledger records it',
      limits: [],
    };
    const blocked = summarize([unclassifiable]);
    assert.deepEqual(blocked.persistent_environments_with_057, ['env-unclassifiable']);
    assert.equal(blocked.position, 'FREEZE_057_AND_ADD_058');
    assert.match(blocked.implementer_reading, /COUNTED WITH THE PERSISTENT ONES/);

    /*
     * FBL-020-R6 §1.3 CHANGED THIS ANSWER, AND THE OLD ONE IS RECORDED SO THE CHANGE IS
     * VISIBLE. R5 concluded EDIT_057_IN_PLACE here: the cluster reported `no`, so nothing
     * had been shown to hold 057. But §1.3 permits editing 057 only on a COMPLETE census
     * that PROVES no persistent environment has applied it, and a cluster nobody could
     * classify is not an environment that has been shown anything — it is one that was not
     * enumerated. So the census is incomplete, the negative is unproven, and the branch is
     * 058.
     */
    const clean = summarize([{ ...unclassifiable, migration_057_applied: 'no' }]);
    assert.equal(clean.position, 'INCOMPLETE_CENSUS_REQUIRES_058');
    assert.equal(clean.census_is_complete, false);
    assert.equal(clean.permits_editing_057_in_place, false);
    assert.equal(clean.requires_058, true);
    assert.deepEqual(clean.disposability_indeterminate, ['env-unclassifiable']);
    // …and it must NOT borrow the FREEZE sentence, which asserts something this evidence
    // does not support: that a persistent environment HAS applied 057.
    assert.match(clean.branch_sentence, /THIS CENSUS IS NOT COMPLETE/);
    assert.doesNotMatch(clean.branch_sentence, /AT LEAST ONE PERSISTENT ENVIRONMENT/);
  });

  test('only a COMPLETE census permits editing 057 in place', () => {
    /*
     * FBL-020-R6 §1.3, as a truth table over the three things that can be wrong. The
     * clause is "unless a complete census proves the negative", so three distinct failures
     * all land on 058 and exactly one shape does not.
     */
    const env = (over: Partial<Finding>): Finding => ({
      id: 'env',
      what_it_is: 'an environment',
      persistence: 'persistent',
      inspected: true,
      inspection_method: 'filesystem',
      evidence: [],
      migration_057_applied: 'no',
      basis: 'inspected',
      limits: [],
      ...over,
    });

    const clean = summarize([env({})]);
    assert.equal(clean.position, 'EDIT_057_IN_PLACE');
    assert.equal(clean.census_is_complete, true);
    assert.equal(clean.permits_editing_057_in_place, true);
    assert.equal(clean.requires_058, false);

    // 1. a positive hit.
    const hit = summarize([env({ migration_057_applied: 'yes' })]);
    assert.equal(hit.position, 'FREEZE_057_AND_ADD_058');
    assert.equal(hit.requires_058, true);

    // 2. a probe that could not answer.
    const unanswered = summarize([env({ migration_057_applied: 'indeterminate' })]);
    assert.equal(unanswered.position, 'BLOCKED_INDETERMINATE');
    assert.equal(unanswered.census_is_complete, false);
    assert.equal(unanswered.requires_058, true);

    // 3. an environment that could not be CLASSIFIED, though its probe answered.
    const unclassified = summarize([env({ persistence: 'indeterminate' })]);
    assert.equal(unclassified.position, 'INCOMPLETE_CENSUS_REQUIRES_058');
    assert.equal(unclassified.census_is_complete, false);
    assert.equal(unclassified.requires_058, true);

    // Exactly one of the four positions permits the in-place branch.
    const permitting = (
      [clean, hit, unanswered, unclassified] as Array<ReturnType<typeof summarize>>
    ).filter((c) => c.permits_editing_057_in_place);
    assert.equal(permitting.length, 1);
  });

  test('a census taken on a CI runner declares that it MAY NOT decide the 057/058 branch', () => {
    /*
     * FBL-020-R6 §1.2. R5 offered the runner census where the order asked for the
     * operator-controlled environments. A runner cannot observe them, so the artifact now
     * says so in a field — and `scripts/check-census-prose.ts` refuses such an artifact
     * rather than reading a position out of it.
     *
     * The detection is fail-closed, so every marker is driven individually: a future runner
     * that sets only one of them must still be recognised.
     */
    const operator = censusAuthority({});
    assert.equal(operator.role, 'OPERATOR_CONTROLLED_HOST');
    assert.equal(operator.may_decide_the_057_058_branch, true);
    assert.deepEqual(operator.detected_from, []);

    for (const marker of RUNNER_ENV_MARKERS) {
      const runner = censusAuthority({ [marker]: 'true' });
      assert.equal(runner.role, 'CI_RUNNER', `${marker} must be recognised`);
      assert.equal(runner.may_decide_the_057_058_branch, false);
      assert.deepEqual(runner.detected_from, [marker]);
      assert.match(runner.statement, /MUST\s+NOT be used to decide|MUST NOT be used to decide/);
    }

    // An UNSET or empty marker is not a runner: a variable that is present and empty is how
    // a shell exports "no value", and reading it as a runner would make every local census
    // undecidable for no reason.
    assert.equal(censusAuthority({ CI: '' }).role, 'OPERATOR_CONTROLLED_HOST');
    assert.equal(censusAuthority({ CI: 'false' }).role, 'OPERATOR_CONTROLLED_HOST');
  });

  test('the census states its host scope, what it did not cover, and the head it was taken at', () => {
    /*
     * FBL-020-R6 §1.1. "No environment holds 057" means nothing until a reader knows which
     * environments were looked at, and a bare commit id is not provenance when the markers
     * are derived from a directory the working tree can change.
     */
    const scope = censusScope();
    assert.equal(scope.host.platform, process.platform);
    assert.ok(scope.enumerated_classes.length >= 6, 'every class of target is named');
    assert.deepEqual(scope.out_of_scope, [...OUT_OF_SCOPE]);
    assert.ok(
      scope.out_of_scope.some((o) => /not reachable from this host/.test(o)),
      'the census must say it is evidence about ONE host',
    );

    /*
     * THE GIT COMPARISONS ARE GUARDED, AND THE GUARD IS ASSERTED ABOUT.
     * `scripts/mutation-kill.ts` runs this battery inside an isolated copy of the tree with
     * no `.git`, where every git call throws; a test that called git unconditionally would
     * go red there and turn a killed mutation into a reported survivor. So the comparisons
     * run wherever git can answer, and where it cannot the test requires the tree to really
     * be such a copy rather than silently skipping.
     */
    const gitAnswers = existsSync(join(ROOT, '.git'));
    const git = (...args: string[]): string =>
      execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });

    const provenance = sourceHeadProvenance();
    if (!gitAnswers) {
      assert.equal(
        provenance.head,
        'unknown',
        'with no git, provenance says so rather than guessing',
      );
      assert.ok(provenance.statement.length > 0);
      return;
    }
    assert.equal(provenance.head, git('rev-parse', 'HEAD').trim(), 'the commit it was taken at');
    assert.match(provenance.head, /^[0-9a-f]{40}$/);

    /*
     * `migrations_match_head` is computed here INDEPENDENTLY rather than asserted against
     * itself. It is the field that decides whether this census asked the question the
     * commit would have asked — the markers are derived from migrations/ — so a version
     * that hard-coded it would describe a tree nobody had looked at.
     */
    const migrationsDirty = git('status', '--porcelain', '--', 'migrations')
      .split(/\r?\n/)
      .filter((l) => l.trim() !== '').length;
    assert.equal(
      provenance.migrations_match_head,
      migrationsDirty === 0,
      'migrations_match_head must describe the tree this census actually ran from',
    );

    const dirty = git('status', '--porcelain')
      .split(/\r?\n/)
      .filter((l) => l.trim() !== '').length;
    assert.equal(provenance.modified_paths, dirty, 'and so must the changed-path count');
    assert.equal(
      provenance.tree_state,
      dirty === 0 ? 'clean' : 'modified',
      'the state and the count must agree',
    );
    assert.ok(provenance.statement.length > 0);
  });

  test('provenance reports a MODIFIED migrations directory, and says so in its statement', () => {
    /*
     * FBL-020-R6 §1.1 — THE BRANCH THIS TREE CANNOT REACH.
     *
     * `migrations_match_head` is the field that decides whether a census asked the question
     * its commit would have asked: the markers are derived from `migrations/`, so a tree
     * with an edited migration searches for a different set of names. This repository's
     * migrations are byte-immutable, so the FALSE branch can never occur in the tree a test
     * runs in — and a version of the reading that hard-coded `true` would satisfy every
     * assertion made about the live tree while describing something nobody had inspected.
     *
     * `provenanceFrom` is therefore a pure function of the three counts git reports, and
     * both branches are driven here.
     */
    const clean = provenanceFrom('a'.repeat(40), 0, 0);
    assert.equal(clean.tree_state, 'clean');
    assert.equal(clean.migrations_match_head, true);
    assert.match(clean.statement, /identical to the commit above/);

    // A modified tree whose migrations are untouched: the census still asked the commit's
    // question, and the statement says how many paths moved.
    const elsewhere = provenanceFrom('b'.repeat(40), 7, 0);
    assert.equal(elsewhere.tree_state, 'modified');
    assert.equal(elsewhere.migrations_match_head, true);
    assert.match(elsewhere.statement, /carrying 7 changed path/);
    assert.match(elsewhere.statement, /migrations\/ carries 0 of them/);

    // A tree with EDITED MIGRATIONS: the field must say so, and the statement must carry
    // the count. This is the case the live tree cannot produce.
    const edited = provenanceFrom('c'.repeat(40), 9, 2);
    assert.equal(edited.tree_state, 'modified');
    assert.equal(
      edited.migrations_match_head,
      false,
      'a tree with edited migrations did NOT ask the question its commit would have asked',
    );
    assert.match(edited.statement, /migrations\/ carries 2 of them/);

    // git could not answer at all: reported as modified and unmatched, never as clean.
    const blind = provenanceFrom('', -1, -1);
    assert.equal(blind.head, 'unknown');
    assert.equal(blind.tree_state, 'modified');
    assert.equal(blind.migrations_match_head, false);
  });

  test('the fsync=off declaration carries an unattributed database, and nothing else does', () => {
    /*
     * The second content proof, and its limits. `fsync=off` is the operator's recorded
     * statement that the cluster's whole content is expendable, so it admits a database no
     * declared pattern matches — but ONLY after provenance, reachability and the
     * depended-upon-name check have each passed on their own evidence.
     */
    const durabilityOff = {
      readable: true,
      postmaster_opts: 'postgres.exe "-c" "fsync=off"',
      settings: {
        listen_addresses: { value: 'localhost', source: 'PostgreSQL default' },
        fsync: { value: 'off', source: 'postmaster.opts' },
      },
    };
    const admitted = assessDisposability(
      input({ launch: durabilityOff, content: content(['dealership_test', 'probe_t0']) }),
    );
    assert.equal(admitted.verdict, 'disposable', admitted.basis);
    assert.deepEqual(admitted.unattributed_databases, ['probe_t0']);
    assert.match(admitted.basis, /disables durability/);

    // It does not rescue a cluster this project never wrote to…
    assert.equal(
      assessDisposability(
        input({
          launch: durabilityOff,
          markers: { migration: scan([]), ledger: scan([]) },
        }),
      ).verdict,
      'indeterminate',
    );
    // …nor one holding a database this repository depends on.
    assert.equal(
      assessDisposability(input({ launch: durabilityOff, content: content(['dealership']) }))
        .verdict,
      'not_disposable',
    );
  });

  test('the local cluster is the one a RUNNING postmaster claims, not one that merely recorded the port', () => {
    /*
     * The second defect in the same code. `postmaster.opts` survives shutdown, so a
     * STOPPED cluster launched on 55434 during R4 matched before the live one: its path
     * was reported as the live cluster's, and it was then skipped by the sweep as already
     * covered — while holding 057. `postmaster.pid` exists only while a postmaster runs.
     */
    const stopped = mkdtempSync(join(tmpdir(), 'fbl020-census-stopped-'));
    const running = mkdtempSync(join(tmpdir(), 'fbl020-census-running-'));
    try {
      const opts = 'postgres.exe "-D" "x" "-p" "55434" "-c" "fsync=off"\n';
      writeFileSync(join(stopped, 'postmaster.opts'), opts, 'utf8');
      writeFileSync(join(running, 'postmaster.opts'), opts, 'utf8');
      // pid, data directory, start time, port — the port is the fourth line.
      writeFileSync(join(running, 'postmaster.pid'), `4242\n${running}\n1787\n55434\n`, 'utf8');

      assert.equal(
        runningDataDirectoryForPort([stopped, running], '55434'),
        running,
        'the directory with a live postmaster.pid must win over one that only recorded the port',
      );
      assert.equal(
        runningDataDirectoryForPort([stopped], '55434'),
        undefined,
        'a stopped cluster is not a running one, whatever its postmaster.opts says',
      );
      assert.equal(runningDataDirectoryForPort([stopped, running], '5432'), undefined);
    } finally {
      rmSync(stopped, { recursive: true, force: true });
      rmSync(running, { recursive: true, force: true });
    }
  });

  test('the launch declaration is resolved from the command line, then the file, then the default', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fbl020-census-launch-'));
    try {
      writeFileSync(
        join(dir, 'postgresql.conf'),
        "#listen_addresses = 'localhost'\nfsync = off\n",
        'utf8',
      );
      const fromConf = readLaunchDeclaration(dir, ['fsync', 'listen_addresses']);
      assert.equal(fromConf.settings['fsync']?.value, 'off');
      assert.equal(fromConf.settings['fsync']?.source, 'postgresql.conf');
      assert.equal(fromConf.settings['listen_addresses']?.source, 'PostgreSQL default');

      writeFileSync(
        join(dir, 'postmaster.opts'),
        'postgres.exe "-D" "x" "-c" "fsync=on" "-c" "listen_addresses=127.0.0.1"\n',
        'utf8',
      );
      const fromOpts = readLaunchDeclaration(dir, ['fsync', 'listen_addresses']);
      assert.equal(fromOpts.settings['fsync']?.value, 'on', 'the command line overrides the file');
      assert.equal(fromOpts.settings['fsync']?.source, 'postmaster.opts');
      assert.equal(fromOpts.settings['listen_addresses']?.value, '127.0.0.1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('every declared disposable-database pattern is one this repository really uses', () => {
    /*
     * The allowlist cannot be padded. Every entry must name a file that exists and carry a
     * literal that really occurs in it, so a pattern admitting a database this project does
     * NOT create cannot be added without also adding the code that creates it.
     */
    const policy = loadDisposableClusterPolicy();
    assert.ok(policy.disposable_database_patterns.length > 0);
    for (const entry of policy.disposable_database_patterns) {
      const file = join(ROOT, entry.declared_by);
      assert.ok(
        existsSync(file),
        `${entry.pattern} names ${entry.declared_by}, which does not exist`,
      );
      assert.ok(
        readFileSync(file, 'utf8').includes(entry.literal),
        `${entry.declared_by} does not contain ${JSON.stringify(entry.literal)}, so the pattern ` +
          `${entry.pattern} is not one this repository actually uses`,
      );
      assert.doesNotThrow(() => new RegExp(entry.pattern));
    }
    for (const name of policy.non_disposable_database_names)
      assert.ok(
        !policy.disposable_database_patterns.some((p) => new RegExp(p.pattern).test(name)),
        `${name} is declared depended-upon AND matched by a disposable pattern`,
      );
  });

  test('the database inventory is read from the heap, and an unaccounted-for database is caught', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fbl020-census-content-'));
    try {
      mkdirSync(join(dir, 'global'), { recursive: true });
      mkdirSync(join(dir, 'base', '1'), { recursive: true });
      mkdirSync(join(dir, 'base', '4'), { recursive: true });
      mkdirSync(join(dir, 'base', '5'), { recursive: true });
      const pad = (text: string): Buffer =>
        Buffer.concat([Buffer.from(text, 'latin1'), Buffer.alloc(8)]);
      writeFileSync(
        join(dir, 'global', '1262'),
        Buffer.concat([
          pad('postgres'),
          pad('template0'),
          pad('template1'),
          // The collation columns of the same catalogue, which must NOT be read as names.
          pad('English_United States.1252'),
          pad('dealership_test'),
        ]),
      );
      const both = databaseNamesFromDisk(dir);
      assert.equal(both.readable, true);
      assert.deepEqual(both.names.sort(), [
        'dealership_test',
        'postgres',
        'template0',
        'template1',
      ]);
      assert.equal(both.reconciled, true, 'no non-default base/ directory, so nothing is missing');

      // A user database exists on disk whose name the heap does not yield: unaccounted for.
      mkdirSync(join(dir, 'base', '16384'), { recursive: true });
      mkdirSync(join(dir, 'base', '16385'), { recursive: true });
      const short = databaseNamesFromDisk(dir);
      assert.deepEqual(short.nondefault_base_oids.sort(), ['16384', '16385']);
      assert.equal(
        short.reconciled,
        false,
        'two databases, one name — the content does not add up',
      );
      assert.equal(
        assessDisposability(input({ content: short })).verdict,
        'indeterminate',
        'and an unreconciled inventory can never be disposable',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a service container with a volume, or a bind mount hidden in options, is DETECTED', () => {
    /*
     * THE CENTRAL CLAIM about CI is "the database is destroyed with the job". A `volumes:`
     * key inside a service definition, or a `-v` inside the `options:` string that Actions
     * hands straight to `docker create`, both falsify it. An analyzer that could not see
     * them would report `no` for a workflow that keeps its database — so both hostile shapes
     * are fed in here, and a plain substring search over the file would fail this test twice
     * over: once because a `volumes:` key belonging to a STEP is not a service volume, and
     * once because the mount is not spelled `volumes:` at all.
     */
    const hostile = [
      'name: bad',
      'on:',
      '  push:',
      'jobs:',
      '  keeper:',
      '    runs-on: ubuntu-latest',
      '    services:',
      '      postgres:',
      '        image: postgres:16',
      '        volumes:',
      '          - pgdata:/var/lib/postgresql/data',
      '    steps:',
      '      - run: echo hi',
      '  sneaky:',
      '    runs-on: ubuntu-latest',
      '    services:',
      '      postgres:',
      '        image: postgres:16',
      '        options: >-',
      '          --health-cmd "pg_isready"',
      '          -v /mnt/keep:/var/lib/postgresql/data',
      '    steps:',
      '      - run: echo hi',
      '',
    ].join('\n');

    const bad = analyzeWorkflow('bad.yml', hostile);
    assert.equal(bad.service_jobs.length, 2);
    assert.equal(bad.service_volume_keys.length, 1, 'the declared volume must be found');
    assert.match(bad.service_volume_keys[0] as string, /keeper\/postgres/);
    assert.equal(bad.service_option_mounts.length, 1, 'the mount inside options: must be found');
    assert.match(bad.service_option_mounts[0] as string, /sneaky\/postgres/);
    assert.equal(
      ciFinding([bad]).migration_057_applied,
      'indeterminate',
      'the ephemerality verdict must be WITHHELD, not asserted',
    );

    // A `volumes:` key belonging to a STEP is not a service volume, and must not be
    // miscounted as one — otherwise the check would be unfalsifiable in the other direction.
    const stepVolume = [
      'name: ok',
      'on:',
      '  push:',
      'jobs:',
      '  fine:',
      '    runs-on: ubuntu-latest',
      '    services:',
      '      postgres:',
      '        image: postgres:16',
      '    steps:',
      '      - uses: some/action',
      '        with:',
      '          volumes:',
      '            - a:b',
      '',
    ].join('\n');
    const fine = analyzeWorkflow('ok.yml', stepVolume);
    assert.deepEqual(fine.service_volume_keys, []);
    assert.equal(ciFinding([fine]).migration_057_applied, 'no');
  });

  test('a deploy step anywhere in a workflow withholds the ephemerality verdict', () => {
    // An ephemeral CI database proves nothing if the same pipeline also migrates a long-lived
    // one. The indicators are matched inside `run:`/`uses:` values, not in prose.
    const deploying = [
      'name: deploy',
      'on:',
      '  push:',
      'jobs:',
      '  ship:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - run: kubectl apply -f k8s/',
      '',
    ].join('\n');
    const analysis = analyzeWorkflow('deploy.yml', deploying);
    assert.equal(analysis.deploy_indicators.length, 1);
    assert.equal(ciFinding([analysis]).migration_057_applied, 'indeterminate');

    // An EMPTY workflow directory is also not a pass: nothing was established.
    assert.equal(ciFinding([]).migration_057_applied, 'indeterminate');
    assert.equal(ciFinding([]).inspected, false);
  });

  test("this repository's own workflows support the ephemerality finding", () => {
    // The finding the census actually reports for this repository, asserted from the
    // committed workflows so that adding a volume, a mount or a deploy step to ci.yml breaks
    // the suite rather than quietly changing what the census concludes.
    const analyses = analyzeAllWorkflows();
    assert.ok(analyses.length >= 1, 'there must be at least one workflow');
    const finding = ciFinding(analyses);
    assert.equal(finding.migration_057_applied, 'no', finding.basis);
    assert.deepEqual(
      analyses.flatMap((a) => a.service_volume_keys),
      [],
    );
    assert.deepEqual(
      analyses.flatMap((a) => a.service_option_mounts),
      [],
    );
    assert.deepEqual(
      analyses.flatMap((a) => a.deploy_indicators),
      [],
    );
    // Both database-backed jobs must still be SEEN to declare service containers, or the
    // finding above would be vacuously clean.
    const jobs = analyses.flatMap((a) => a.service_jobs.map((j) => j.job));
    assert.ok(jobs.includes('verify'), jobs.join(', '));
    assert.ok(jobs.includes('migration-upgrade'), jobs.join(', '));
    assert.equal(finding.persistence, 'ephemeral');
  });

  test('the compose volume names Compose would create are derived, not guessed', () => {
    const declared = composeNamedVolumes(readFileSync(join(ROOT, 'docker-compose.yml'), 'utf8'));
    assert.deepEqual(declared, ['postgres_data']);
    const candidates = composeVolumeCandidates(ROOT, declared);
    assert.ok(candidates.includes('car-dealership-software_postgres_data'), candidates.join(', '));
    // Both separators are offered because the exact form has changed between Compose
    // releases: a check that guessed one and missed would report "absent" about a name it
    // never looked for.
    assert.ok(candidates.includes('car-dealership-software-postgres_data'));

    // Only TOP-LEVEL volume declarations count. A service's own `volumes:` list holds
    // mount specifications, not names, and treating those as names would produce candidates
    // that could never exist.
    const compose = [
      'services:',
      '  db:',
      '    volumes:',
      '      - a:/b',
      'volumes:',
      '  real:',
      '',
    ];
    assert.deepEqual(composeNamedVolumes(compose.join('\n')), ['real']);
  });

  test('the marker scan finds a needle that straddles a chunk boundary', () => {
    /*
     * The scan reads in 1 MiB chunks and carries `needle.length - 1` bytes across. Without
     * that carry a ledger row whose filename happened to land on a boundary would be missed,
     * and a miss is what the census reports as `no` — the single most consequential
     * false negative this file could produce.
     */
    const dir = mkdtempSync(join(tmpdir(), 'fbl020-census-scan-'));
    try {
      const needle = '057_identity_boundary_completion.sql';
      const chunk = 1 << 20;
      const split = Math.floor(needle.length / 2);
      const buf = Buffer.concat([
        Buffer.alloc(chunk - split, 0x20),
        Buffer.from(needle, 'utf8'),
        Buffer.alloc(1024, 0x20),
      ]);
      writeFileSync(join(dir, 'heap'), buf);
      const hit = scanForMarker([dir], needle);
      assert.equal(hit.hits.length, 1, 'a needle across the boundary must still be found');
      assert.equal(hit.complete, true);
      assert.ok(hit.bytes_scanned > chunk);

      // A clean file is a clean miss, and the scan says it finished.
      writeFileSync(join(dir, 'heap'), Buffer.alloc(4096, 0x20));
      const miss = scanForMarker([dir], needle);
      assert.deepEqual(miss.hits, []);
      assert.equal(miss.complete, true);

      // A budget that runs out reports `complete: false`, so the caller cannot read the
      // absence of hits as evidence.
      writeFileSync(join(dir, 'heap'), Buffer.alloc(4096, 0x20));
      const starved = scanForMarker([dir], needle, 16);
      assert.equal(starved.complete, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the markers are derived from migrations/, so a future 058 is covered without editing this file', () => {
    const markers = migration057Markers();
    assert.ok(markers.includes('057_identity_boundary_completion.sql'), markers.join(', '));
    // 056 and below are NOT markers: they are byte-immutable and applied everywhere, so
    // finding one says nothing about whether this order's migration reached an environment.
    assert.equal(
      markers.some((m) => m.startsWith('056_') || m.startsWith('000_')),
      false,
      markers.join(', '),
    );

    const staged = mkdtempSync(join(tmpdir(), 'fbl020-census-markers-'));
    try {
      for (const f of ['056_x.sql', '057_y.sql', '058_z.sql', '099_w.sql', 'notes.md'])
        writeFileSync(join(staged, f), '');
      assert.deepEqual(migration057Markers(staged), ['057_y.sql', '058_z.sql', '099_w.sql']);
    } finally {
      rmSync(staged, { recursive: true, force: true });
    }
  });

  test('every environment the order names is covered by a probe', () => {
    /*
     * §0.1 names five environments at minimum. This asserts the census has a probe for each,
     * by reading its own source for the call sites — a census that quietly stopped covering
     * one would otherwise still produce a confident-looking artifact.
     */
    const source = readFileSync(join(ROOT, 'scripts', 'migration-census.ts'), 'utf8');
    for (const [what, marker] of [
      ['GitHub Actions CI', 'ciFinding(analyzeAllWorkflows())'],
      ['the registered Windows PostgreSQL service', 'discoverWindowsServiceClusters()'],
      ['the docker-compose named volume', 'dockerFinding(markers)'],
      ['WSL distributions', 'wslDistributions()'],
      ['the disposable local cluster', 'localClusterFinding(localPort'],
    ] as const)
      assert.ok(source.includes(marker), `${what} must be probed (looked for ${marker})`);

    // The Windows service cluster is inspected WITHOUT authenticating: it uses
    // scram-sha-256 and the password is not held, and changing pg_hba.conf to get in would
    // be modifying a production-shaped environment in order to read it.
    assert.match(source, /NO CONNECTION IS ATTEMPTED and NOTHING IS MODIFIED/);
    /*
     * No connection string anywhere may name 5433 — the port the order forbids
     * authenticating to. Asserted against connection SYNTAX rather than the bare number: the
     * number legitimately appears in the prose that explains the prohibition, and a test that
     * banned the digits would have been satisfied by deleting the explanation.
     */
    assert.equal(
      /(?:127\.0\.0\.1|localhost|\/\/[^\s'"`]*):5433\b/.test(source),
      false,
      'the census must not construct a connection to 5433',
    );
    // …and every connection URL it builds takes its port from the `port` parameter rather
    // than naming one, so the only cluster it can reach is the one it was asked about.
    const urls = source.match(/postgresql:\/\/[^\s'"`]*/g) ?? [];
    assert.ok(urls.length > 0, 'the census does connect to the disposable cluster');
    for (const url of urls)
      assert.ok(url.includes('${port}'), `${url} must take its port from the parameter`);

    // The vhdx timestamp is recorded because the order asked for it, AND the reason it is
    // not load-bearing is recorded with it rather than left implied.
    assert.match(source, /docker_data\.vhdx/);
    assert.match(source, /NOT offered as a substitute/);
    assert.match(source, /timestamp later than the compose file proves nothing/);

    // Every marker-scan finding must carry the residue its method cannot exclude.
    assert.equal(MARKER_SCAN_LIMITS.length >= 2, true);
    for (const limit of MARKER_SCAN_LIMITS) assert.ok(limit.length > 40, limit);
  });

  test('the WSL path translation and the host discovery behave on this machine', () => {
    assert.equal(toWslPath('C:\\Users\\x\\y.sh'), '/mnt/c/Users/x/y.sh');
    assert.equal(toWslPath('D:/a/b'), '/mnt/d/a/b');
    // Not a Windows path: returned with separators normalized rather than mangled.
    assert.equal(toWslPath('/already/posix'), '/already/posix');

    // Discovery must be tolerant: it runs on machines with no PostgreSQL installed at all,
    // and an empty result is a legitimate answer rather than a crash.
    const dirs = discoverWindowsDataDirectories();
    assert.ok(Array.isArray(dirs));
  });
});
