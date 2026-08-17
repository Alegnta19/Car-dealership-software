/**
 * FBL-020-R4 §6.5 — PROVES EACH RECONCILIATION IN MIGRATION 057 IS LOAD-BEARING.
 *
 *   DATABASE_URL=postgres://…/<pre-057 seeded database> \
 *     npx tsx scripts/upgrade-negative-controls.ts \
 *       --before artifacts/identity-pre-057.json \
 *       --out artifacts/negative-controls.json
 *
 * Run by the CI migration-upgrade job at the point where the database holds the
 * retained Fixed Ops seed AND the populated legacy identity fixture, and 057 has
 * NOT yet been applied. `DATABASE_URL` names that database; it is used as a
 * TEMPLATE and is never written to.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * Migration 057 reconciles retained rows and then constrains them. Every claim of
 * the form "the constraint would abort on a populated database if it preceded this
 * statement" is a claim about a FAILURE that nobody had ever observed: the drill ran
 * on empty tables, so removing any reconciliation would have changed nothing and the
 * gate would still have been green. A control whose removal changes no outcome is
 * not a control.
 *
 * For each load-bearing reconciliation this runner therefore:
 *   1. copies the pre-057 database (CREATE DATABASE … TEMPLATE) so the original is
 *      untouched and the controls cannot contaminate each other;
 *   2. writes a full copy of `migrations/` with that ONE statement DELETED from 057;
 *   3. runs the REAL migration runner against the copy;
 *   4. if the migration survives, runs the REAL post-057 verifier against the copy;
 *   5. requires the intended failure — a Postgres constraint refusing the data, or
 *      the verifier refusing the reconciled state — and requires it at the DECLARED
 *      STAGE with the DECLARED SIGNATURE.
 *
 * A control that PASSES both stages is reported as a FAILED CONTROL and this runner
 * exits non-zero: it means the statement 057 claims is protecting the upgrade is
 * doing nothing on the fixture that is supposed to exercise it.
 *
 * ── THE STAGE AND SIGNATURE ARE DECLARED, NOT DISCOVERED ────────────────────
 *
 * Each control states where it must fail and what the failure must mention. That is
 * stricter than "something went wrong" on purpose, and two of the controls show why:
 *
 *   * `is_unprovable_provenance_revoked` removes the FIRST of 057 §2's two
 *     revocations. The migration still succeeds, because the SECOND revocation
 *     catches the same row — with a DIFFERENT reason. Only an exact-state assertion
 *     can see that, which is precisely why the verifier asserts revocation reasons
 *     rather than revocation counts.
 *   * `ul_deterministic_binding` removes the derivation that BINDS an unambiguous
 *     link. Nothing violates a constraint; the link is quietly deactivated instead,
 *     so a whole tenant's staff lose access on upgrade. That is a DATA failure with
 *     no error message anywhere, and it is caught only by asserting the state the
 *     row was supposed to be left in.
 *
 * ── ZERO-ROW RECONCILIATIONS ARE NOT SILENTLY OMITTED ───────────────────────
 *
 * Several statements in 057 operate on columns 057 itself creates, so on ANY
 * pre-057 database they match zero rows by construction and CANNOT be shown to be
 * load-bearing by this fixture. Pretending otherwise would be the same kind of
 * false claim this section exists to remove. They are enumerated in
 * `NOT_LOAD_BEARING` with the reason, and published in the artifact.
 */
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Client } from 'pg';

/**
 * One reconciliation. Its METADATA lives here; its ANCHOR TEXT lives in
 * `architecture/negative-control-anchors-057.json`, keyed by `id`.
 *
 * WHY THE ANCHORS ARE NOT IN THIS FILE. An anchor is a verbatim excerpt of `057` —
 * `UPDATE user_links …`, `UPDATE identity_sessions …` — and this file sits under
 * `scripts/`, which `scripts/check-owned-mutations.ts` reads as production code. That
 * guard refuses a write to an authorization-state table outside a declared owner, and it
 * is RIGHT to refuse: it inspects string and template literals precisely so a write
 * cannot hide in one, and it deliberately has no per-site opt-out. An excerpt used to
 * LOCATE a statement is indistinguishable, to any static reader, from a statement meant
 * to RUN. Rather than weaken a real guard for a diagnostic harness, the excerpts live in
 * a data file the guard does not — and should not — treat as code.
 * `tests/ci-gates.test.ts` asserts every anchor still resolves to exactly one statement
 * in `057`, so moving them out of TypeScript costs no verification.
 */
export interface Control {
  /** Stable id; also the copy database's suffix and the anchor file's key. */
  id: string;
  /** Which section of 057 the statement lives in, for the artifact. */
  section: string;
  /** What is lost if the statement is removed. */
  intent: string;
  /** Where the removal must be caught. */
  expectStage: 'migration' | 'verifier';
  /** A substring the failure output must contain — the constraint or assertion name. */
  expectSignature: string;
}

/** The `from`/`to` excerpt pair that locates one control's statement inside 057. */
export interface ControlAnchor {
  /** Exact, globally unique text that begins the statement. */
  from: string;
  /** Exact text that ends it; matched after `from`. */
  to: string;
}

const ANCHORS_FILE = join(__dirname, '..', 'architecture', 'negative-control-anchors-057.json');

/**
 * The anchors, with completeness checked in both directions. A control with no anchor
 * cannot run, and a silently skipped control proves nothing — so it throws rather than
 * continuing. An anchor with no control is dead weight and also throws, because the next
 * reader would assume it was in force.
 */
export function loadAnchors(): Record<string, ControlAnchor> {
  const anchors = JSON.parse(readFileSync(ANCHORS_FILE, 'utf8')) as Record<string, ControlAnchor>;
  const missing = CONTROLS.filter((c) => anchors[c.id] === undefined).map((c) => c.id);
  if (missing.length > 0)
    throw new Error(
      `negative-control-anchors-057.json has no anchor for: ${missing.join(', ')} — a control ` +
        'without an anchor cannot be run, and a silently skipped control proves nothing',
    );
  const orphans = Object.keys(anchors).filter((id) => !CONTROLS.some((c) => c.id === id));
  if (orphans.length > 0)
    throw new Error(
      `negative-control-anchors-057.json holds anchors no control uses: ${orphans.join(', ')}`,
    );
  return anchors;
}

export const CONTROLS: Control[] = [
  {
    id: 'ul_deterministic_binding',
    section: '§1 — exact external-identity binding on UserLink',
    intent:
      'binds an activated link to the one active connection its tenant has. Removed, ' +
      'the link is instead closed as ambiguous: every member of staff in a correctly ' +
      'configured tenant loses access on upgrade, with no error anywhere.',
    expectStage: 'verifier',
    expectSignature: 'ul_a1_bound_to_its_only_active_connection',
  },
  {
    id: 'ul_ambiguous_deactivation',
    section: '§1 — exact external-identity binding on UserLink',
    intent:
      'closes an activated link that cannot be bound to exactly one active connection. ' +
      'Removed, the link stays activated and unbound and `ul_activated_is_bound` aborts ' +
      'the whole migration.',
    expectStage: 'migration',
    expectSignature: 'ul_activated_is_bound',
  },
  {
    id: 'is_unprovable_provenance_revoked',
    section: '§2 — locally revocable sessions with no nullable-connection bypass',
    intent:
      'revokes a live session that names neither a connection nor an issuer — the ' +
      'nullable-connection bypass. Removed, the session is still revoked, by the LATER ' +
      'statement and for a DIFFERENT recorded reason, so the audit trail misattributes ' +
      'why access stopped.',
    expectStage: 'verifier',
    expectSignature: 'is_s2_unprovable_provenance_revoked',
  },
  {
    id: 'is_subject_and_org_derived',
    section: '§2 — locally revocable sessions',
    intent:
      "derives a live session's provider subject and organization from its own link and " +
      'connection. Removed, every provable live session in the estate is revoked on ' +
      'upgrade — a total, silent logout.',
    expectStage: 'verifier',
    expectSignature: 'is_s1_provable_session_survives_with_derived_identity',
  },
  {
    id: 'is_unprovable_identity_revoked',
    section: '§2 — locally revocable sessions',
    intent:
      'revokes a live session whose subject or organization could not be derived. ' +
      'Removed, `is_live_session_fully_bound` aborts the whole migration.',
    expectStage: 'migration',
    expectSignature: 'is_live_session_fully_bound',
  },
  {
    id: 'rat_started_expired',
    section: '§4 — exact reauthentication binding',
    intent:
      'expires a step-up still in flight that cannot satisfy the new binding rules. ' +
      'Removed, `rat_started_is_bound` aborts the whole migration.',
    expectStage: 'migration',
    expectSignature: 'rat_started_is_bound',
  },
  {
    id: 'sar_approval_without_grant_superseded',
    section: '§5 — support access authority and high-assurance approval',
    intent:
      'moves an approved support request that cannot name an approving high-assurance ' +
      'grant to an auditable terminal state, preserving its prior decision. Removed, ' +
      '`sar_approval_is_high_assurance` aborts the whole migration.',
    expectStage: 'migration',
    expectSignature: 'sar_approval_is_high_assurance',
  },
  {
    id: 'ipc_unbounded_certification_withdrawn',
    section: '§8 — MFA-policy certification gets a validity and a revocation',
    intent:
      'withdraws an MFA-policy certification that carries no validity deadline. ' +
      'Removed, `ipc_mfa_certification_is_bounded` aborts the whole migration.',
    expectStage: 'migration',
    expectSignature: 'ipc_mfa_certification_is_bounded',
  },
  {
    id: 'rat_terminal_explained',
    section: '§9 — the reauthentication row becomes the authority on its callback',
    intent:
      'explains every already-terminal step-up with a reason and an instant derived from ' +
      "the row's own history. Removed, `rat_terminal_is_explained` aborts the whole migration.",
    expectStage: 'migration',
    expectSignature: 'rat_terminal_is_explained',
  },
  {
    id: 'pd_evidence_version_floor',
    section: '§6 — policy evidence version discriminator',
    intent:
      'installs the BEFORE INSERT floor that stops a new decision from claiming the ' +
      'historic evidence_version 1 and inheriting its exemption. Removed, the version ' +
      'becomes a self-certification and an incomplete allow can be written for ever.',
    expectStage: 'verifier',
    expectSignature: 'evidence_version 1',
  },
];

/**
 * Reconciliations in 057 that operate on columns 057 ITSELF creates. On any pre-057
 * database they match zero rows by construction, so this fixture cannot prove them
 * load-bearing and no such claim is made. They are kept in 057 because the ORDERING
 * is the property under review: a later edit that re-points a column, or an operator
 * repair between migrations, brings the rows they guard into existence.
 */
export const NOT_LOAD_BEARING: Array<{ statement: string; reason: string }> = [
  {
    statement: '§2 credential_kind / bearer_key_hash / provider_access_token_expires_at cleanup',
    reason: 'the columns are created by 057 with the values these statements assert',
  },
  {
    statement: '§2 revoked-session refresh-state clearing, and the refresh-lease release',
    reason: 'refresh_token_hash, refresh_state_sealed and the lease columns are created by 057',
  },
  {
    statement: '§3 login_transactions reconciliation',
    reason: 'login_transactions is CREATED by 057, so it holds no retained rows',
  },
  {
    statement: '§5 duplicate-approval-grant supersession (three statements)',
    reason: 'approval_grant_id is created by 057, so no retained row can name a grant twice',
  },
  {
    statement: '§6 policy_decisions evidence_version = 1 restatement',
    reason: 'the column is created with DEFAULT 1, so every retained row already reads 1',
  },
  {
    statement: '§7a/§7b/§7c identity-tuple reconciliations',
    reason: 'the tuple columns are written earlier in 057 from the rows they are checked against',
  },
  {
    statement: '§9 started-transaction callback-state expiry',
    reason:
      '§4 has already expired every retained started transaction by the time it runs, ' +
      'because the binding columns §4 requires are also new in 057',
  },
  {
    statement: '§10 support-session expired_at',
    reason: 'the column arrives NULL on every retained row and NULL satisfies all three CHECKs',
  },
];

const IS_WINDOWS = process.platform === 'win32';

function parseArgs(): { before: string; out: string; log: string | undefined } {
  const argv = process.argv.slice(2);
  let before: string | undefined;
  let out: string | undefined;
  let log: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === '--before') before = argv[(i += 1)];
    else if (arg === '--out') out = argv[(i += 1)];
    else if (arg === '--log') log = argv[(i += 1)];
    else {
      console.error(`Unrecognized argument: ${arg}`);
      process.exit(2);
    }
  }
  if (before === undefined || out === undefined) {
    console.error(
      'Usage: upgrade-negative-controls.ts --before <pre-057 census json> --out <json> [--log <txt>]',
    );
    process.exit(2);
  }
  return { before, out, log };
}

const MIGRATION_057 = '057_identity_boundary_completion.sql';

/** The migration text exactly as the runner will execute it: canonical LF. */
export function canonical057(): string {
  return readFileSync(join(__dirname, '..', 'migrations', MIGRATION_057), 'utf8').replace(
    /\r\n/g,
    '\n',
  );
}

/**
 * Deletes exactly one statement. Fails loudly rather than mutating approximately: if
 * the anchor is missing, ambiguous, or the span does not look like a single statement,
 * the control cannot be trusted and the runner refuses to report a result for it.
 */
export function removeStatement(sql: string, control: Control, anchor: ControlAnchor): string {
  const first = sql.indexOf(anchor.from);
  if (first === -1) throw new Error(`${control.id}: start anchor not found in ${MIGRATION_057}`);
  if (sql.indexOf(anchor.from, first + 1) !== -1)
    throw new Error(`${control.id}: start anchor is AMBIGUOUS in ${MIGRATION_057}`);

  const endAt = sql.indexOf(anchor.to, first);
  if (endAt === -1) throw new Error(`${control.id}: end anchor not found after the start anchor`);
  const end = endAt + anchor.to.length;
  const span = sql.slice(first, end);
  const semicolons = (span.match(/;/g) ?? []).length;
  if (semicolons !== 1)
    throw new Error(
      `${control.id}: the span between the anchors holds ${semicolons} statement terminators, ` +
        `so it is not exactly one statement (${span.length} characters)`,
    );
  return sql.slice(0, first) + sql.slice(end);
}

interface RunResult {
  status: number;
  output: string;
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv): RunResult {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env,
    shell: IS_WINDOWS,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: result.status ?? 1,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

/**
 * WHY THE CONSTRAINT NAME IS RECOVERED SEPARATELY.
 *
 * The migration runner's exit code is the authoritative evidence that the upgrade
 * REFUSES to proceed, and it is what this runner gates on. But the runner's log
 * deliberately does NOT carry the error's message — FBL-010-R1 redaction, because an
 * arbitrary driver message can contain a connection string or a row payload — so the
 * name of the constraint that fired is not, and must not be, in that output.
 *
 * So the mutated statement is REPLAYED here, in an explicit transaction that is always
 * rolled back, and the structured fields Postgres attaches to the error are read
 * directly: `constraint`, `code`, and `table`. Those are SCHEMA IDENTIFIERS chosen by
 * this repository, not data — nothing from a row is copied into the artifact. The
 * replay changes nothing: the migration is transactional, so the copy is byte-identical
 * to the template both before and after.
 */
async function constraintThatRefused(
  connectionString: string,
  sql: string,
): Promise<{ constraint: string; code: string; table: string }> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query('BEGIN');
    try {
      await client.query(sql);
      return { constraint: '', code: '', table: '' };
    } catch (err) {
      const pgErr = err as { constraint?: string; code?: string; table?: string };
      return {
        constraint: pgErr.constraint ?? '',
        code: pgErr.code ?? '',
        table: pgErr.table ?? '',
      };
    } finally {
      await client.query('ROLLBACK');
    }
  } finally {
    await client.end();
  }
}

/** The maintenance connection string: the same server, database `postgres`. */
function maintenanceUrl(databaseUrl: string): { admin: string; database: string } {
  const url = new URL(databaseUrl);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  url.pathname = '/postgres';
  return { admin: url.toString(), database };
}

function copyUrl(databaseUrl: string, copyName: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${copyName}`;
  return url.toString();
}

async function main(): Promise<void> {
  const { before, out, log } = parseArgs();
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl === '') {
    console.error('DATABASE_URL must name the pre-057 seeded database used as the template.');
    process.exit(2);
  }
  const { admin, database: template } = maintenanceUrl(databaseUrl);

  const baseSql = canonical057();
  const anchors = loadAnchors();
  const lines: string[] = [];
  const results: Array<Record<string, unknown>> = [];
  let failedControls = 0;

  const staging = mkdtempSync(join(tmpdir(), 'fbl020-nc-'));
  const client = new Client({ connectionString: admin });
  await client.connect();

  try {
    for (const [index, control] of CONTROLS.entries()) {
      const copy = `${template}_nc${index}`.slice(0, 63);
      const dir = join(staging, control.id);
      mkdirSync(dir, { recursive: true });
      cpSync(join(__dirname, '..', 'migrations'), dir, { recursive: true });
      const anchor = anchors[control.id] as ControlAnchor;
      const mutated = removeStatement(baseSql, control, anchor);
      writeFileSync(join(dir, MIGRATION_057), mutated, 'utf8');

      await client.query(`DROP DATABASE IF EXISTS "${copy}"`);
      await client.query(`CREATE DATABASE "${copy}" TEMPLATE "${template}"`);

      const env: NodeJS.ProcessEnv = {
        ...process.env,
        DATABASE_URL: copyUrl(databaseUrl, copy),
        MIGRATIONS_DIR: dir,
      };

      const migration = run('npx', ['tsx', 'scripts/migrate.ts'], env);
      let stage: 'migration' | 'verifier' | 'none' = 'none';
      let observedSignature = '';
      let detail = '';
      if (migration.status !== 0) {
        stage = 'migration';
        const refusal = await constraintThatRefused(copyUrl(databaseUrl, copy), mutated);
        observedSignature = refusal.constraint;
        detail = `sqlstate=${refusal.code} table=${refusal.table} constraint=${refusal.constraint}`;
      } else {
        // The migration survived, so the removal broke no invariant. It may still have
        // left the DATA in the wrong state, which is what the verifier is for.
        const verifier = run(
          'npx',
          ['tsx', 'scripts/verify-upgrade-state.ts', '--phase=post-057', '--before', before],
          env,
        );
        if (verifier.status !== 0) {
          stage = 'verifier';
          /*
           * ONLY LINES THAT REPORT A FAILURE COUNT. The verifier prints the same
           * assertion id on its pass line (`post-057-reconciled=<id>`) and inside its
           * failure (`FAIL: post-057: <id>: …`), so a naive substring search over the
           * whole log matches a PASSING run and would report every control satisfied.
           * That is exactly the class of false green this section exists to remove.
           */
          const failLines = verifier.output
            .split(/\r?\n/)
            .filter((l) => l.startsWith('FAIL:'))
            .map((l) => l.trim());
          observedSignature =
            failLines.find((l) => l.includes(control.expectSignature)) ?? failLines[0] ?? '';
          detail = failLines.slice(0, 3).join(' | ').slice(0, 600);
        }
      }

      const signatureSeen =
        observedSignature !== '' && observedSignature.includes(control.expectSignature);
      const ok = stage === control.expectStage && signatureSeen;
      if (!ok) failedControls += 1;

      const verdict = ok
        ? 'CONTROL SATISFIED'
        : stage === 'none'
          ? 'CONTROL FAILED — removing this reconciliation changed NOTHING'
          : `CONTROL FAILED — expected ${control.expectStage} failure mentioning ` +
            `"${control.expectSignature}", observed ${stage}: ${observedSignature || '(no signature)'}`;

      lines.push(
        `control=${control.id}`,
        `  section=${control.section}`,
        `  removed_statement_anchor=${JSON.stringify(anchor.from.split('\n')[0])}`,
        `  expected_stage=${control.expectStage} signature=${control.expectSignature}`,
        `  observed_stage=${stage} signature_matched=${signatureSeen}`,
        `  detail=${JSON.stringify(detail)}`,
        `  verdict=${verdict}`,
        '',
      );
      results.push({
        id: control.id,
        section: control.section,
        intent: control.intent,
        expected_stage: control.expectStage,
        expected_signature: control.expectSignature,
        observed_stage: stage,
        observed_signature: observedSignature,
        signature_matched: signatureSeen,
        detail,
        satisfied: ok,
      });

      await client.query(`DROP DATABASE IF EXISTS "${copy}"`);
      rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    await client.end();
    rmSync(staging, { recursive: true, force: true });
  }

  const summary = {
    migration: MIGRATION_057,
    migration_sha256_canonical_lf: sha256(baseSql),
    template_database: template,
    controls_total: CONTROLS.length,
    controls_satisfied: CONTROLS.length - failedControls,
    controls_failed: failedControls,
    controls: results,
    not_load_bearing_on_a_pre_057_fixture: NOT_LOAD_BEARING,
  };
  writeFileSync(out, JSON.stringify(summary, null, 2) + '\n');

  lines.push(
    'RECONCILIATIONS THAT CANNOT BE LOAD-BEARING ON A PRE-057 DATABASE',
    '(enumerated rather than omitted; each operates on a column 057 itself creates)',
    ...NOT_LOAD_BEARING.map((n) => `  ${n.statement} — ${n.reason}`),
    '',
    `controls_total=${CONTROLS.length} satisfied=${CONTROLS.length - failedControls} ` +
      `failed=${failedControls}`,
  );
  const text = lines.join('\n') + '\n';
  process.stdout.write(text);
  if (log !== undefined) writeFileSync(log, text);

  if (failedControls > 0) {
    console.error(
      `${failedControls} negative control(s) FAILED: a reconciliation 057 claims protects the ` +
        'upgrade did not change the outcome when it was removed.',
    );
    process.exitCode = 1;
  }
}

/**
 * The digest of the canonical-LF migration the controls were derived from — the same
 * value the migration ledger records — so the artifact says WHICH 057 was tested.
 */
function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
