/**
 * FBL-020-R5 §0.1 — THE PERSISTENT-ENVIRONMENT CENSUS, AS A RUNNABLE SCRIPT.
 *
 *   npx tsx scripts/migration-census.ts [--out <json>] [--log <txt>]
 *
 * ── WHAT THIS FILE IS, AND WHAT IT IS NOT ───────────────────────────────────
 *
 * It enumerates every persistent environment reachable from the machine it runs on,
 * inspects each one by the cheapest READ-ONLY means available, and REPORTS whether any
 * form of migration `057` has been applied there. It writes evidence and a conclusion.
 *
 * THE CONCLUSION IN THIS FILE IS THE IMPLEMENTER'S, AND ONLY THE IMPLEMENTER'S. It has
 * not been reviewed, ratified or accepted by anyone. FBL-020-R4 shipped prose asserting
 * that "the architect's §0 census established …" and that the census "IS ALREADY
 * DISCHARGED"; no such acceptance had been given, and the review said so. So every
 * verdict below is emitted with its evidence, its method AND the things that method
 * cannot rule out, and the artifact carries an explicit `acceptance` field whose value
 * is `NOT_REVIEWED`. A reader decides; this script reports.
 *
 * ── HOW AN ENVIRONMENT IS JUDGED ────────────────────────────────────────────
 *
 * Three verdicts, and the third is used rather than avoided:
 *
 *   `no`            — positive evidence that no form of 057 is present.
 *   `yes`           — positive evidence that some form of 057 IS present.
 *   `indeterminate` — the probe could not run, or ran into its budget. NEVER read as
 *                     `no`: an environment nobody could inspect is an environment
 *                     nobody knows about, and §0.2's branch turns on that difference.
 *
 * ── THE MARKER SCAN, AND WHY IT IS SOUND IN ONE DIRECTION ONLY ──────────────
 *
 * For a cluster whose data directory can be read but whose password is unknown, the
 * decisive probe is a byte scan of `base/` and `global/` for the migration's FILENAME.
 * `scripts/migrate.ts` records every applied migration as a row in `schema_migrations`
 * whose `filename` column holds that exact text, and a 38-character value is stored
 * inline and uncompressed in the heap page, so if the row exists the bytes are there.
 *
 * The scan is therefore CONCLUSIVE WHEN IT HITS and STRONG-BUT-NOT-ABSOLUTE WHEN IT
 * MISSES: a row that was inserted, deleted, vacuumed and then had its page truncated
 * away would leave no trace. That residue is stated in every finding's `limits` rather
 * than rounded off, and it is why each cluster is ALSO judged on independent evidence —
 * the `base/` OID census, directory timestamps against the date 057 first existed, and
 * the absence of the identity tables 057 creates.
 *
 * IT IS CONFINED TO THE CLUSTER'S OWN DIRECTORIES, deliberately. An early draft of this
 * probe was pointed at a whole filesystem and "found" the marker in an agent transcript
 * and in this repository's own source — a scan whose scope includes documents ABOUT the
 * migration cannot distinguish those from a database that has applied it.
 */
import { spawnSync } from 'child_process';
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { basename, join } from 'path';

const ROOT = join(__dirname, '..');

/** Verdicts. `indeterminate` is a real answer, not a placeholder. */
export type Verdict = 'no' | 'yes' | 'indeterminate';

/**
 * How long an environment keeps state, which is the axis §0.2 turns on.
 *
 *   `ephemeral`     — destroyed at the end of the run that created it, by construction.
 *   `disposable`    — lives on this machine but is created, dropped and recreated at will
 *                     by the drills, holds nothing anybody depends on, and is not a
 *                     deployment target.
 *   `persistent`    — keeps state across restarts and is not routinely recreated.
 *   `indeterminate` — the evidence needed to place a cluster in one of the three above
 *                     could not be established. `summarize` counts it WITH the persistent
 *                     ones, so an unclassifiable cluster BLOCKS the §0.2 branch instead of
 *                     being waved through as a drill cluster.
 */
export type Persistence = 'ephemeral' | 'disposable' | 'persistent' | 'indeterminate';

export interface Evidence {
  /** What was checked. */
  check: string;
  /** What was observed, verbatim enough to be re-checked by hand. */
  observed: string;
}

export interface Finding {
  id: string;
  what_it_is: string;
  persistence: Persistence;
  /** Whether the environment could be inspected at all. */
  inspected: boolean;
  /** The read-only means used, or why none was available. */
  inspection_method: string;
  evidence: Evidence[];
  migration_057_applied: Verdict;
  /** The implementer's reading of the evidence above. */
  basis: string;
  /** What this evidence does NOT rule out. */
  limits: string[];
  /**
   * How `persistence` was arrived at, for the host clusters where it is a judgement
   * rather than a definition. Absent on CI, Docker and WSL findings, which are what
   * they are by construction.
   */
  disposability?: DisposabilityAssessment;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Bounded, read-only primitives.
 * ────────────────────────────────────────────────────────────────────────── */

interface Exec {
  ok: boolean;
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * A bounded child process. Never throws: a missing binary and a hung probe both come
 * back as `ok: false`, so one unavailable tool downgrades ONE finding to
 * `indeterminate` instead of aborting the census.
 */
function exec(command: string, args: string[], timeoutMs = 60_000): Exec {
  try {
    const r = spawnSync(command, args, {
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    return {
      ok: r.error === undefined && r.status === 0,
      status: r.status,
      stdout: (r.stdout ?? '').replace(/\0/g, ''),
      stderr: (r.stderr ?? '').replace(/\0/g, ''),
    };
  } catch {
    return { ok: false, status: null, stdout: '', stderr: 'spawn failed' };
  }
}

/** Total bytes any single cluster scan may read before it gives up and says so. */
export const MARKER_SCAN_BUDGET_BYTES = 6 * 1024 * 1024 * 1024;

export interface MarkerScan {
  /** False when the budget ran out — the result is then unusable as a negative. */
  complete: boolean;
  bytes_scanned: number;
  files_scanned: number;
  /** Relative paths of files containing the needle, capped for readability. */
  hits: string[];
}

/** Every file under `dir`, depth-first, with sizes. Missing directories are skipped. */
function filesUnder(dir: string): Array<{ path: string; size: number }> {
  if (!existsSync(dir)) return [];
  const out: Array<{ path: string; size: number }> = [];
  const walk = (d: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(d, entry);
      try {
        const st = statSync(full);
        if (st.isDirectory()) walk(full);
        else if (st.isFile()) out.push({ path: full, size: st.size });
      } catch {
        /* a file that vanished mid-walk is not evidence of anything */
      }
    }
  };
  walk(dir);
  return out;
}

/**
 * Searches the given files for a literal byte string, streaming in overlapping chunks so
 * a match that straddles a chunk boundary is still found.
 */
export function scanForMarker(
  roots: string[],
  needle: string,
  budgetBytes = MARKER_SCAN_BUDGET_BYTES,
): MarkerScan {
  const pattern = Buffer.from(needle, 'utf8');
  const CHUNK = 1 << 20;
  const overlap = pattern.length - 1;
  const buffer = Buffer.allocUnsafe(CHUNK + overlap);
  let bytes = 0;
  let files = 0;
  const hits: string[] = [];

  for (const root of roots) {
    for (const file of filesUnder(root)) {
      if (bytes >= budgetBytes)
        return { complete: false, bytes_scanned: bytes, files_scanned: files, hits };
      let fd: number;
      try {
        fd = openSync(file.path, 'r');
      } catch {
        continue;
      }
      files += 1;
      let carried = 0;
      let found = false;
      try {
        for (;;) {
          const read = readSync(fd, buffer, carried, CHUNK, null);
          if (read <= 0) break;
          bytes += read;
          const view = buffer.subarray(0, carried + read);
          if (view.includes(pattern)) {
            found = true;
            break;
          }
          carried = Math.min(overlap, view.length);
          view.subarray(view.length - carried).copy(buffer, 0);
          if (bytes >= budgetBytes) break;
        }
      } catch {
        /* an unreadable page is reported by the byte count, not by a throw */
      } finally {
        closeSync(fd);
      }
      if (found && hits.length < 8) hits.push(file.path);
      if (found && hits.length >= 8) break;
    }
  }
  return { complete: bytes < budgetBytes, bytes_scanned: bytes, files_scanned: files, hits };
}

/* ─────────────────────────────────────────────────────────────────────────────
 * What "any form of 057" means, derived from the repository rather than typed in.
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * The ledger `filename` value of every migration numbered 057 or above. Derived from
 * `migrations/` so that a future `058` is covered without this file being remembered.
 */
export function migration057Markers(migrationsDir = join(ROOT, 'migrations')): string[] {
  return readdirSync(migrationsDir)
    .filter((f) => /^0*(?:5[7-9]|[6-9][0-9])_.*\.sql$/.test(f))
    .sort();
}

/** Tables `057` CREATEs, whose mere presence in a cluster is independent evidence. */
export const TABLES_CREATED_BY_057 = ['login_transactions'] as const;

/** The ledger table every environment of this repository would carry. */
export const LEDGER_TABLE = 'schema_migrations';

/* ─────────────────────────────────────────────────────────────────────────────
 * A PostgreSQL data directory, inspected without connecting to it.
 * ────────────────────────────────────────────────────────────────────────── */

export interface ClusterInspection {
  data_directory: string;
  readable: boolean;
  pg_version: string;
  /** `base/` subdirectory names: one per database, including the three defaults. */
  base_oids: string[];
  /** `base/<oid>` modification times, so they can be compared against a date. */
  base_mtimes: Record<string, string>;
  configured_port: string;
  host_based_auth: string[];
  server_log_files: Array<{ file: string; bytes: number; modified: string }>;
  marker_057: MarkerScan;
  marker_ledger: MarkerScan;
  marker_tables_057: MarkerScan;
}

/**
 * Reads a cluster's data directory. NOTHING here opens a connection: the Windows service
 * cluster uses `scram-sha-256` with a password this project does not hold, and guessing at
 * a credential — or changing `pg_hba.conf` to get in — would be a modification of a
 * production-shaped environment to satisfy a read. The filesystem answers the question.
 */
export function inspectDataDirectory(dataDir: string, markers: string[]): ClusterInspection {
  const readable = existsSync(join(dataDir, 'PG_VERSION'));
  const conf = join(dataDir, 'postgresql.conf');
  const hba = join(dataDir, 'pg_hba.conf');
  const base = join(dataDir, 'base');
  const global = join(dataDir, 'global');
  const logDir = join(dataDir, 'log');

  const baseOids = existsSync(base)
    ? readdirSync(base)
        .filter((e) => {
          try {
            return statSync(join(base, e)).isDirectory();
          } catch {
            return false;
          }
        })
        .sort()
    : [];
  const baseMtimes: Record<string, string> = {};
  for (const oid of baseOids) {
    try {
      baseMtimes[oid] = statSync(join(base, oid)).mtime.toISOString();
    } catch {
      baseMtimes[oid] = 'unreadable';
    }
  }

  let port = 'not stated in postgresql.conf (server default)';
  if (existsSync(conf)) {
    const line = readFileSync(conf, 'utf8')
      .split(/\r?\n/)
      .find((l) => /^\s*port\s*=/.test(l));
    if (line !== undefined) port = line.trim();
  }

  const hostAuth = existsSync(hba)
    ? readFileSync(hba, 'utf8')
        .split(/\r?\n/)
        .filter((l) => /^\s*(host|local)\s/.test(l))
        .map((l) => l.trim().replace(/\s+/g, ' '))
    : [];

  const logs = existsSync(logDir)
    ? readdirSync(logDir)
        .map((f) => {
          const st = statSync(join(logDir, f));
          return { file: f, bytes: st.size, modified: st.mtime.toISOString() };
        })
        .sort((a, b) => (a.modified < b.modified ? 1 : -1))
        .slice(0, 6)
    : [];

  const roots = [base, global];
  // The marker scan runs once per needle so a hit can be attributed to a specific one.
  const scanAll = (needles: string[]): MarkerScan => {
    const merged: MarkerScan = { complete: true, bytes_scanned: 0, files_scanned: 0, hits: [] };
    for (const needle of needles) {
      const r = scanForMarker(roots, needle);
      merged.complete = merged.complete && r.complete;
      merged.bytes_scanned += r.bytes_scanned;
      merged.files_scanned += r.files_scanned;
      merged.hits.push(...r.hits.map((h) => `${needle} @ ${h}`));
    }
    return merged;
  };

  return {
    data_directory: dataDir,
    readable,
    pg_version: readable ? readFileSync(join(dataDir, 'PG_VERSION'), 'utf8').trim() : 'unreadable',
    base_oids: baseOids,
    base_mtimes: baseMtimes,
    configured_port: port,
    host_based_auth: hostAuth,
    server_log_files: logs,
    marker_057: readable
      ? scanAll(markers)
      : { complete: false, bytes_scanned: 0, files_scanned: 0, hits: [] },
    marker_ledger: readable
      ? scanAll([LEDGER_TABLE])
      : { complete: false, bytes_scanned: 0, files_scanned: 0, hits: [] },
    marker_tables_057: readable
      ? scanAll([...TABLES_CREATED_BY_057])
      : { complete: false, bytes_scanned: 0, files_scanned: 0, hits: [] },
  };
}

/**
 * Turns a data-directory inspection into a verdict. Separated from the I/O so the suite
 * can drive every branch — including the two that must NOT be reported as `no`.
 */
export function verdictFromInspection(c: ClusterInspection): { verdict: Verdict; basis: string } {
  if (!c.readable)
    return {
      verdict: 'indeterminate',
      basis: 'the data directory could not be read, so nothing was established either way',
    };
  if (c.marker_057.hits.length > 0)
    return {
      verdict: 'yes',
      basis:
        'the ledger filename of a migration numbered 057 or above is present in the ' +
        "cluster's own heap files",
    };
  if (!c.marker_057.complete)
    return {
      verdict: 'indeterminate',
      basis: 'the marker scan hit its byte budget before finishing, so a miss proves nothing',
    };
  const ledgerPresent = c.marker_ledger.hits.length > 0;
  return {
    verdict: 'no',
    basis: ledgerPresent
      ? `the cluster carries a '${LEDGER_TABLE}' relation but no 057-or-later filename appears ` +
        'anywhere in its heap files'
      : `no '${LEDGER_TABLE}' relation and no 057-or-later filename appear anywhere in the ` +
        "cluster's heap files, so this repository's migration runner has never written here",
  };
}

/** The residue a filesystem marker scan cannot exclude. Attached to every such finding. */
export const MARKER_SCAN_LIMITS: string[] = [
  'a ledger row that was inserted, then deleted, then vacuumed, and whose heap page was ' +
    'afterwards truncated away would leave no bytes to find; the scan cannot exclude that ' +
    'sequence',
  'the scan reads the cluster on disk, so a row still only in an unflushed buffer of a ' +
    'RUNNING server would be missed',
];

/* ─────────────────────────────────────────────────────────────────────────────
 * DISPOSABILITY — decided by PROVENANCE AND CONTENT, never by a path prefix.
 *
 * ── THE DEFECT THIS REPLACES ────────────────────────────────────────────────
 *
 * The R5 census decided disposability with one expression:
 *
 *     const underTemp = dir.toLowerCase().startsWith(tmpdir().toLowerCase());
 *     otherClusterFinding(dir, markers, underTemp ? 'disposable' : 'persistent');
 *
 * A wave of that same run created its own scratch cluster at
 * `C:/Users/alegn/pgdata-fbl020r5` — under the user profile rather than under `%TEMP%`,
 * because the cluster the drills normally use was damaged. The expression above saw a
 * path that did not begin with the temporary directory and called this project's own
 * throwaway cluster A PERSISTENT ENVIRONMENT. That cluster carried 057, so
 * `conclusion.implementer_reading` ordered migration 057 FROZEN — on the strength of a
 * string comparison against a directory name.
 *
 * A path prefix is not evidence about a cluster. The facts below are, and every one of
 * them is read from the cluster itself.
 *
 * ── WHAT IS REQUIRED, AND WHY EACH CONDITION IS NECESSARY ───────────────────
 *
 * PROVENANCE — all three necessary:
 *
 *   1. NOT REGISTERED AS A SERVICE. A cluster the machine starts on boot is somebody's
 *      environment. This is checked first and is disqualifying on its own.
 *
 *   2. LOOPBACK ONLY. A cluster reachable from off-box is a shared target.
 *      `listen_addresses` is resolved from the recorded postmaster arguments, then
 *      `postgresql.conf`, then PostgreSQL's own default of `localhost`.
 *
 *   3. THIS PROJECT WROTE HERE. The cluster's own heap must carry this repository's
 *      ledger table or one of its migration filenames. Without that, the cluster may
 *      well be somebody's throwaway — but it is not THIS project's, and this project
 *      will not certify a stranger's cluster as disposable. This is what keeps the 137
 *      embedded-PostgreSQL clusters another project leaves in `%TEMP%` out of the
 *      `disposable` column, where the path-prefix test happily put them.
 *
 * CONTENT — the inventory must be readable and reconciled, must hold no database this
 * repository designates as depended-upon, and must then carry ONE of two positive proofs
 * that everything in the cluster is expendable:
 *
 *   4a. EVERY DATABASE IS ONE THIS REPOSITORY DECLARES. The names are matched against
 *       `architecture/disposable-cluster-policy.json`, whose every entry the suite pins
 *       to a literal that really occurs in the file it names.
 *
 *   4b. OR DURABILITY IS DELIBERATELY DISABLED (`fsync=off`). PostgreSQL documents that
 *       with fsync off a crash can leave the cluster irrecoverably corrupt. Launching a
 *       cluster that way IS the operator's recorded declaration that NOTHING it holds is
 *       depended upon — a statement about the cluster's entire content, readable from
 *       the cluster itself, and one no genuinely persistent environment can make.
 *
 *   Neither proof ⇒ `indeterminate`, with the unattributed names published. Both are
 *   statements about content; neither is a statement about where the directory sits.
 *
 * ── FAIL-CLOSED ─────────────────────────────────────────────────────────────
 *
 * When an input cannot be read the verdict is `indeterminate`, and an `indeterminate`
 * cluster is counted with the persistent ones in `summarize`. A false `disposable` is
 * far worse than a false `indeterminate`: the first waves an environment through, the
 * second stops the delivery.
 * ────────────────────────────────────────────────────────────────────────── */

/** Databases every cluster has from `initdb`; their presence says nothing. */
export const DEFAULT_DATABASES = ['postgres', 'template0', 'template1'] as const;

export interface DisposableClusterPolicy {
  durability_settings_that_must_be_off: { settings: string[] };
  loopback_addresses: string[];
  disposable_database_patterns: Array<{ pattern: string; declared_by: string; literal: string }>;
  non_disposable_database_names: string[];
}

/** Reads the checked-in policy. A missing or malformed file is fatal, never a default. */
export function loadDisposableClusterPolicy(
  file = join(ROOT, 'architecture', 'disposable-cluster-policy.json'),
): DisposableClusterPolicy {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as DisposableClusterPolicy;
  const settings = raw.durability_settings_that_must_be_off?.settings;
  if (!Array.isArray(settings) || settings.length === 0)
    throw new Error(`${file}: durability_settings_that_must_be_off.settings is empty`);
  if (!Array.isArray(raw.loopback_addresses) || raw.loopback_addresses.length === 0)
    throw new Error(`${file}: loopback_addresses is empty`);
  if (!Array.isArray(raw.disposable_database_patterns))
    throw new Error(`${file}: disposable_database_patterns is missing`);
  if (!Array.isArray(raw.non_disposable_database_names))
    throw new Error(`${file}: non_disposable_database_names is missing`);
  return raw;
}

/** What the cluster records about how it was launched. */
export interface LaunchDeclaration {
  readable: boolean;
  /** The verbatim `postmaster.opts` line, or why there is none. */
  postmaster_opts: string;
  /** Resolved `<setting>` → value, with where the value came from. */
  settings: Record<string, { value: string; source: string }>;
}

/**
 * Resolves a handful of settings the way the server would: the recorded command line
 * wins, then `postgresql.conf`, then the documented default. Kept separate from the
 * judgement so the suite can drive it with staged directories.
 */
export function readLaunchDeclaration(
  dataDir: string,
  wanted: string[],
  defaults: Record<string, string> = { listen_addresses: 'localhost', fsync: 'on' },
): LaunchDeclaration {
  const optsFile = join(dataDir, 'postmaster.opts');
  const confFile = join(dataDir, 'postgresql.conf');
  const hasOpts = existsSync(optsFile);
  const hasConf = existsSync(confFile);
  const opts = hasOpts ? readFileSync(optsFile, 'utf8').trim() : '';
  const conf = hasConf ? readFileSync(confFile, 'utf8') : '';
  const settings: Record<string, { value: string; source: string }> = {};
  for (const name of wanted) {
    // `-c name=value`, with or without the quoting `pg_ctl` writes.
    const fromOpts = new RegExp(`-c"?\\s+"?${name}\\s*=\\s*"?([^"\\s]+)`, 'i').exec(opts)?.[1];
    if (fromOpts !== undefined) {
      settings[name] = { value: fromOpts, source: 'postmaster.opts' };
      continue;
    }
    const fromConf = conf
      .split(/\r?\n/)
      .map((l) => new RegExp(`^\\s*${name}\\s*=\\s*'?([^'#\\s]+)`, 'i').exec(l)?.[1])
      .filter((v): v is string => v !== undefined)
      .pop();
    if (fromConf !== undefined) {
      settings[name] = { value: fromConf, source: 'postgresql.conf' };
      continue;
    }
    const fallback = defaults[name];
    if (fallback !== undefined) settings[name] = { value: fallback, source: 'PostgreSQL default' };
  }
  return {
    readable: hasOpts || hasConf,
    postmaster_opts: hasOpts ? opts : 'no postmaster.opts in the data directory',
    settings,
  };
}

/** The database inventory, and whether it can be trusted to be complete. */
export interface ClusterContent {
  readable: boolean;
  /** How the names were obtained — a live catalogue read, or the on-disk heap. */
  source: string;
  names: string[];
  /** `base/` OIDs other than the three `initdb` creates. */
  nondefault_base_oids: string[];
  /**
   * False when `base/` shows more databases than names could be recovered for. A
   * cluster whose content cannot be fully accounted for is not a cluster whose content
   * has been established.
   */
  reconciled: boolean;
  detail: string;
}

/** OIDs `initdb` always creates: template1, template0, postgres. */
const DEFAULT_BASE_OIDS = new Set(['1', '4', '5']);

/**
 * Recovers database names from `global/1262` (`pg_database`) without connecting.
 *
 * `datname` is a fixed-width `NAME`, stored inline and NUL-padded, so the names are
 * literally present as ASCII runs. `datcollate`/`datctype` are `NAME` too, which is why
 * only lower-case SQL identifiers are accepted — `English_United States.1252` is not one,
 * and neither is the binary noise either side of a tuple. A name that this filter would
 * reject (an upper-case or quoted database name) is exactly why the OID reconciliation
 * below exists: it would show up as an unaccounted-for `base/` directory.
 */
export function databaseNamesFromDisk(dataDir: string): ClusterContent {
  const heap = join(dataDir, 'global', '1262');
  const base = join(dataDir, 'base');
  let oids: string[];
  try {
    oids = readdirSync(base).filter((e) => !DEFAULT_BASE_OIDS.has(e));
  } catch {
    return {
      readable: false,
      source: 'global/1262 (pg_database heap)',
      names: [],
      nondefault_base_oids: [],
      reconciled: false,
      detail: 'base/ could not be listed',
    };
  }
  if (!existsSync(heap))
    return {
      readable: false,
      source: 'global/1262 (pg_database heap)',
      names: [],
      nondefault_base_oids: oids,
      reconciled: false,
      detail: 'global/1262 is absent, so pg_database could not be read from disk',
    };
  let bytes: Buffer;
  try {
    bytes = readFileSync(heap);
  } catch (err) {
    return {
      readable: false,
      source: 'global/1262 (pg_database heap)',
      names: [],
      nondefault_base_oids: oids,
      reconciled: false,
      detail: `global/1262 could not be read: ${(err as Error).message.split('\n')[0] ?? ''}`,
    };
  }
  const found = new Set<string>();
  let run: number[] = [];
  const flush = (): void => {
    if (run.length >= 3 && run.length <= 63) {
      const text = Buffer.from(run).toString('latin1');
      if (/^[a-z_][a-z0-9_$]*$/.test(text)) found.add(text);
    }
    run = [];
  };
  for (const byte of bytes) {
    if (byte >= 0x21 && byte <= 0x7e) run.push(byte);
    else flush();
  }
  flush();
  const names = [...found].sort();
  const nondefault = names.filter((n) => !DEFAULT_DATABASES.includes(n as never));
  return {
    readable: true,
    source: 'global/1262 (pg_database heap), read without connecting',
    names,
    nondefault_base_oids: oids,
    reconciled: oids.length <= nondefault.length,
    detail:
      `${nondefault.length} non-default name(s) recovered for ${oids.length} non-default ` +
      `base/ director${oids.length === 1 ? 'y' : 'ies'}`,
  };
}

export type Disposability = 'disposable' | 'not_disposable' | 'indeterminate';

export interface DisposabilityAssessment {
  verdict: Disposability;
  basis: string;
  evidence: Evidence[];
  /** Names present that match no declared disposable pattern. Reported, not ignored. */
  unattributed_databases: string[];
}

export interface DisposabilityInput {
  data_directory: string;
  /** Set when the machine starts this cluster on boot; `undefined` when it does not. */
  service?: { service: string; state: string } | undefined;
  launch: LaunchDeclaration;
  content: ClusterContent;
  /** Marker scans already performed against this cluster's own heap. */
  markers: { migration: MarkerScan; ledger: MarkerScan };
  policy: DisposableClusterPolicy;
}

/**
 * The judgement, as a pure function so the suite can drive EVERY branch — including the
 * two that must never be reached by accident, and the one the R5 census got wrong.
 */
export function assessDisposability(input: DisposabilityInput): DisposabilityAssessment {
  const { policy } = input;
  const evidence: Evidence[] = [];
  const unattributed: string[] = [];

  evidence.push({
    check: 'registered to start with the machine',
    observed:
      input.service === undefined
        ? 'no — this data directory is not the target of any PostgreSQL service on this host'
        : `YES — service '${input.service.service}' (${input.service.state})`,
  });
  if (input.service !== undefined)
    return {
      verdict: 'not_disposable',
      basis:
        `the machine starts this cluster: it is registered as service '${input.service.service}'. ` +
        'A cluster somebody arranged to come up on boot is somebody’s environment.',
      evidence,
      unattributed_databases: [],
    };

  evidence.push({
    check: 'recorded launch (postmaster.opts)',
    observed: input.launch.postmaster_opts,
  });
  if (!input.launch.readable)
    return {
      verdict: 'indeterminate',
      basis:
        'neither postmaster.opts nor postgresql.conf could be read, so how this cluster was ' +
        'launched — and therefore whether it is reachable from off-box — is unknown. An ' +
        'unestablished provenance is INDETERMINATE, never disposable.',
      evidence,
      unattributed_databases: [],
    };

  const listen = input.launch.settings['listen_addresses'];
  evidence.push({
    check: 'listen_addresses (reachability)',
    observed: listen === undefined ? 'unresolved' : `${listen.value} — from ${listen.source}`,
  });
  if (listen === undefined)
    return {
      verdict: 'indeterminate',
      basis: 'listen_addresses could not be resolved, so reachability is unknown.',
      evidence,
      unattributed_databases: [],
    };
  const addresses = listen.value
    .split(',')
    .map((a) => a.trim().toLowerCase())
    .filter((a) => a !== '');
  const offBox = addresses.filter((a) => !policy.loopback_addresses.includes(a));
  if (offBox.length > 0)
    return {
      verdict: 'not_disposable',
      basis:
        `this cluster accepts connections on ${offBox.join(', ')}, which is not loopback. A ` +
        'cluster reachable from off-box is a shared target.',
      evidence,
      unattributed_databases: [],
    };

  const wroteHere = input.markers.migration.hits.length > 0 || input.markers.ledger.hits.length > 0;
  evidence.push({
    check: "this repository's migration runner wrote here",
    observed: wroteHere
      ? `yes — ${input.markers.migration.hits.length} migration-filename hit(s) and ` +
        `${input.markers.ledger.hits.length} '${LEDGER_TABLE}' hit(s) in the cluster's own heap`
      : `no — neither a '${LEDGER_TABLE}' relation nor any migration filename of this ` +
        'repository appears in this cluster',
  });
  if (!input.markers.migration.complete || !input.markers.ledger.complete)
    return {
      verdict: 'indeterminate',
      basis:
        'the marker scan hit its byte budget, so whether this project ever wrote here was ' +
        'not established.',
      evidence,
      unattributed_databases: [],
    };
  if (!wroteHere)
    return {
      verdict: 'indeterminate',
      basis:
        'this repository never wrote to this cluster, so it is not one this project created ' +
        'for its own testing. It may well be somebody else’s throwaway — but this project ' +
        'cannot establish that, and an unestablished provenance is INDETERMINATE.',
      evidence,
      unattributed_databases: [],
    };

  evidence.push({
    check: 'database inventory',
    observed: `${input.content.source}; ${input.content.detail}`,
  });
  if (!input.content.readable)
    return {
      verdict: 'indeterminate',
      basis: `the database inventory could not be read: ${input.content.detail}`,
      evidence,
      unattributed_databases: [],
    };
  evidence.push({ check: 'databases present', observed: input.content.names.join(', ') || 'none' });
  if (!input.content.reconciled)
    return {
      verdict: 'indeterminate',
      basis:
        `the content does not add up — ${input.content.detail}. A database whose name could ` +
        'not be recovered is a database nobody has accounted for.',
      evidence,
      unattributed_databases: [],
    };

  const nondefault = input.content.names.filter((n) => !DEFAULT_DATABASES.includes(n as never));
  const real = nondefault.filter((n) => policy.non_disposable_database_names.includes(n));
  evidence.push({
    check: 'databases this repository designates as depended-upon',
    observed: real.join(', ') || 'none present',
  });
  if (real.length > 0)
    return {
      verdict: 'not_disposable',
      basis:
        `this cluster holds ${real.join(', ')}, which this repository designates as a database ` +
        'somebody depends on.',
      evidence,
      unattributed_databases: [],
    };

  const patterns = policy.disposable_database_patterns.map((p) => new RegExp(p.pattern));
  for (const name of nondefault) if (!patterns.some((p) => p.test(name))) unattributed.push(name);
  evidence.push({
    check: 'databases matching no declared disposable pattern',
    observed:
      unattributed.join(', ') || 'none — every database present is one this repository declares',
  });

  /*
   * The second content proof. `fsync=off` is SUFFICIENT and not necessary: the upgrade
   * drills launch this project's cluster that way, but a cluster started by hand for the
   * suite is not, and a rule that demanded it would classify the very cluster the tests run
   * against as an environment. A rule that accepted it ALONE would be no better — which is
   * why it is reached only after provenance, reachability and the depended-upon-name check
   * have each been satisfied on their own evidence.
   */
  const durability = policy.durability_settings_that_must_be_off.settings.map((setting) => {
    const resolved = input.launch.settings[setting];
    evidence.push({
      check: `${setting} (durability)`,
      observed:
        resolved === undefined
          ? 'not stated in the recorded launch, in postgresql.conf, or by a documented default'
          : `${resolved.value} — from ${resolved.source}`,
    });
    return resolved !== undefined && resolved.value.toLowerCase() === 'off';
  });
  const durabilityOff = durability.length > 0 && durability.every(Boolean);

  if (unattributed.length > 0 && !durabilityOff)
    return {
      verdict: 'indeterminate',
      basis:
        `${unattributed.length} database(s) here match no pattern this repository declares — ` +
        `${unattributed.join(', ')} — and the cluster's recorded launch does not disable ` +
        'durability either, so neither content proof holds. What those databases are has not ' +
        'been established, and an unestablished content is INDETERMINATE, never disposable.',
      evidence,
      unattributed_databases: unattributed,
    };

  return {
    verdict: 'disposable',
    basis:
      'this cluster is not machine-started, accepts connections on loopback only, and carries ' +
      'this repository’s own migration ledger — so this project created it for its own ' +
      'testing. It holds no database this repository designates as depended-upon, and ' +
      (unattributed.length === 0
        ? 'every database it holds is one this repository declares for throwaway use.'
        : 'its recorded launch disables durability (fsync=off), which declares everything it ' +
          `holds expendable; the ${unattributed.length} database name(s) matching no declared ` +
          'pattern are listed above rather than passed over.'),
    evidence,
    unattributed_databases: unattributed,
  };
}

/** `indeterminate` disposability is carried into `persistence` unchanged, by design. */
export function persistenceFrom(verdict: Disposability): Persistence {
  if (verdict === 'disposable') return 'disposable';
  if (verdict === 'not_disposable') return 'persistent';
  return 'indeterminate';
}

/* ─────────────────────────────────────────────────────────────────────────────
 * (A) GitHub Actions CI — a document question, answered from the document.
 * ────────────────────────────────────────────────────────────────────────── */

export interface WorkflowAnalysis {
  file: string;
  triggers: string[];
  /** Every job that declares `services:`, with the images it names. */
  service_jobs: Array<{ job: string; services: Array<{ name: string; image: string }> }>;
  /** Any `volumes:` key inside a service definition — a service container's only way
   *  to outlive the job. Non-empty means the ephemerality claim is FALSE. */
  service_volume_keys: string[];
  /** Any `-v`/`--mount` smuggled through a service's `options:` string. */
  service_option_mounts: string[];
  /** Steps whose command looks like a deployment to a long-lived environment. */
  deploy_indicators: string[];
}

const DEPLOY_INDICATORS =
  /\b(?:kubectl|helm|flyctl|render-deploy|eb\s+deploy|serverless\s+deploy|terraform\s+apply|ssh\s|scp\s|rsync\s|aws\s+ecs|az\s+webapp|gcloud\s+run\s+deploy|docker\s+compose\s+up|docker\s+stack\s+deploy)\b/;

/**
 * Reads one workflow with an INDENTATION-AWARE scan rather than a substring search.
 *
 * The claim being tested is structural — "no service container declares a volume" — and a
 * plain `includes('volumes:')` cannot state it: this repository's `docker-compose.yml`
 * legitimately declares volumes, a workflow could carry the word in a comment, and a
 * `volumes:` key belonging to a step rather than to a service would be counted either
 * way. Tracking indentation makes the finding say what it claims to say.
 *
 * No YAML dependency is added for this. The workflow is machine-generated-shaped, plain
 * block YAML with two-space indents, and `tests/migration-census.test.ts` drives the
 * scanner against hostile fixtures — a service WITH a volume, a mount hidden in
 * `options:`, and a `volumes:` key that belongs to a step — so the parser's limits are
 * exercised rather than assumed.
 */
export function analyzeWorkflow(file: string, text: string): WorkflowAnalysis {
  const lines = text.split(/\r?\n/);
  const indentOf = (l: string): number => (/^(\s*)/.exec(l)?.[1] ?? '').length;
  const isBlank = (l: string): boolean => /^\s*(#.*)?$/.test(l);

  const triggers: string[] = [];
  const serviceJobs: WorkflowAnalysis['service_jobs'] = [];
  const serviceVolumeKeys: string[] = [];
  const serviceOptionMounts: string[] = [];
  const deployIndicators: string[] = [];

  let inOn = false;
  let inJobs = false;
  let job: string | undefined;
  let jobIndent = -1;
  let servicesIndent = -1;
  let service: string | undefined;
  let serviceIndent = -1;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;
    if (isBlank(line)) continue;
    const indent = indentOf(line);
    const trimmed = line.trim();

    if (indent === 0) {
      inOn = /^on:/.test(trimmed);
      inJobs = /^jobs:/.test(trimmed);
      job = undefined;
      servicesIndent = -1;
      service = undefined;
      if (inOn && /^on:\s*\S/.test(trimmed)) triggers.push(trimmed.slice(3).trim());
      continue;
    }

    if (inOn && indent === 2) {
      triggers.push(trimmed.replace(/:.*$/, ''));
      continue;
    }

    if (inJobs) {
      if (indent === 2 && /^[A-Za-z0-9_-]+:\s*$/.test(trimmed)) {
        job = trimmed.replace(/:$/, '');
        jobIndent = indent;
        servicesIndent = -1;
        service = undefined;
        continue;
      }
      if (job !== undefined && indent === jobIndent + 2 && /^services:\s*$/.test(trimmed)) {
        servicesIndent = indent;
        serviceJobs.push({ job, services: [] });
        continue;
      }
      // Leaving the services block: any key back at or above its own indentation.
      if (servicesIndent >= 0 && indent <= servicesIndent) {
        servicesIndent = -1;
        service = undefined;
      }
      if (servicesIndent >= 0) {
        if (indent === servicesIndent + 2 && /^[A-Za-z0-9_-]+:\s*$/.test(trimmed)) {
          service = trimmed.replace(/:$/, '');
          serviceIndent = indent;
          serviceJobs[serviceJobs.length - 1]?.services.push({ name: service, image: '(none)' });
          continue;
        }
        if (service !== undefined && indent > serviceIndent) {
          const entry = serviceJobs[serviceJobs.length - 1]?.services.find(
            (s) => s.name === service,
          );
          if (/^image:/.test(trimmed) && entry) entry.image = trimmed.slice('image:'.length).trim();
          if (indent === serviceIndent + 2 && /^volumes:/.test(trimmed))
            serviceVolumeKeys.push(`${file}:${i + 1} ${job}/${service} ${trimmed}`);
          if (/^options:/.test(trimmed)) {
            // `options:` is passed straight to `docker create`, so a bind mount can hide
            // in it. Its block scalar continues while the indentation stays deeper.
            let block = trimmed;
            for (let k = i + 1; k < lines.length; k += 1) {
              const next = lines[k] as string;
              if (isBlank(next)) continue;
              if (indentOf(next) <= indent) break;
              block += ' ' + next.trim();
            }
            if (/(?:^|\s)(?:-v|--volume|--mount|--tmpfs)(?:[=\s]|$)/.test(block))
              serviceOptionMounts.push(`${file}:${i + 1} ${job}/${service} ${block.slice(0, 200)}`);
          }
        }
      }
      if (/^(?:-\s+)?run:/.test(trimmed) || /^(?:-\s+)?uses:/.test(trimmed)) {
        if (DEPLOY_INDICATORS.test(trimmed))
          deployIndicators.push(`${file}:${i + 1} ${trimmed.slice(0, 160)}`);
      } else if (DEPLOY_INDICATORS.test(line)) {
        deployIndicators.push(`${file}:${i + 1} ${trimmed.slice(0, 160)}`);
      }
    }
  }

  return {
    file,
    triggers,
    service_jobs: serviceJobs,
    service_volume_keys: serviceVolumeKeys,
    service_option_mounts: serviceOptionMounts,
    deploy_indicators: deployIndicators,
  };
}

/** Every workflow in the repository, analyzed. */
export function analyzeAllWorkflows(dir = join(ROOT, '.github', 'workflows')): WorkflowAnalysis[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .sort()
    .map((f) => analyzeWorkflow(f, readFileSync(join(dir, f), 'utf8')));
}

/**
 * The CI verdict, from the analyses alone. `no` requires ALL of: at least one workflow
 * present (so an empty directory cannot be read as a pass), no service volume, no mount
 * in a service's options, and no deployment step anywhere.
 */
export function ciFinding(analyses: WorkflowAnalysis[]): Finding {
  const volumes = analyses.flatMap((a) => a.service_volume_keys);
  const mounts = analyses.flatMap((a) => a.service_option_mounts);
  const deploys = analyses.flatMap((a) => a.deploy_indicators);
  const serviceJobs = analyses.flatMap((a) =>
    a.service_jobs.map((j) => `${a.file}:${j.job} → ${j.services.map((s) => s.name).join(', ')}`),
  );
  const images = analyses.flatMap((a) =>
    a.service_jobs.flatMap((j) => j.services.map((s) => `${j.job}/${s.name} ${s.image}`)),
  );

  const clean =
    analyses.length > 0 && volumes.length === 0 && mounts.length === 0 && deploys.length === 0;

  return {
    id: 'github-actions-ci',
    what_it_is:
      'the GitHub Actions runners that execute .github/workflows. The database-backed jobs ' +
      'get PostgreSQL from a `services:` container that Actions creates before the job and ' +
      'destroys after it.',
    persistence: 'ephemeral',
    inspected: analyses.length > 0,
    inspection_method:
      'indentation-aware read of every workflow file in .github/workflows: the `services:` ' +
      'blocks, any `volumes:` key inside one, any bind mount smuggled through `options:`, ' +
      'and any step that deploys to a long-lived environment',
    evidence: [
      {
        check: 'workflow files present',
        observed: analyses.map((a) => a.file).join(', ') || 'none',
      },
      {
        check: 'triggers',
        observed: analyses.map((a) => `${a.file}: ${a.triggers.join('|')}`).join(' ; '),
      },
      { check: 'jobs declaring service containers', observed: serviceJobs.join(' ; ') || 'none' },
      { check: 'service images', observed: images.join(' ; ') || 'none' },
      {
        check: 'volumes: keys inside a service definition',
        observed: volumes.length === 0 ? 'none' : volumes.join(' ; '),
      },
      {
        check: 'bind mounts inside a service options: string',
        observed: mounts.length === 0 ? 'none' : mounts.join(' ; '),
      },
      {
        check: 'steps that deploy to a long-lived environment',
        observed: deploys.length === 0 ? 'none' : deploys.join(' ; '),
      },
    ],
    migration_057_applied: clean ? 'no' : 'indeterminate',
    basis: clean
      ? 'every database in CI lives in a service container with no volume and no bind mount, ' +
        'so its filesystem is destroyed with the job; and no workflow deploys to anywhere ' +
        'that would keep a schema. Each run migrates a database that did not exist before it.'
      : 'the workflows do not support the ephemerality claim: see the volumes, mounts or ' +
        'deployment steps listed above',
    limits: [
      'this is a claim about the workflows AS COMMITTED. A workflow_dispatch run of a ' +
        'different revision, or a job on a self-hosted runner with pre-existing state, is ' +
        'outside what this file can see',
      'it says nothing about GitHub-side caches; the actions/setup-node cache holds npm ' +
        'packages, not a database directory',
    ],
  };
}

/* ─────────────────────────────────────────────────────────────────────────────
 * (C) The docker-compose named volume.
 * ────────────────────────────────────────────────────────────────────────── */

/** The named volumes a compose file declares at top level, and the services using them. */
export function composeNamedVolumes(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let inTop = false;
  for (const line of lines) {
    if (/^\s*(#.*)?$/.test(line)) continue;
    const indent = (/^(\s*)/.exec(line)?.[1] ?? '').length;
    if (indent === 0) {
      inTop = /^volumes:/.test(line.trim());
      continue;
    }
    if (inTop && indent === 2) out.push(line.trim().replace(/:.*$/, ''));
  }
  return out.sort();
}

/**
 * The volume names Docker Compose would actually create. The project name defaults to the
 * directory's basename normalised the way Compose normalises it, and both separators are
 * offered because the exact form has changed between Compose releases — a check that
 * guessed one and missed would report "absent" about a name that was never looked for.
 */
export function composeVolumeCandidates(projectDir: string, declared: string[]): string[] {
  const project = basename(projectDir)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '');
  return declared.flatMap((v) => [`${project}_${v}`, `${project}-${v}`]);
}

/* ─────────────────────────────────────────────────────────────────────────────
 * The census run.
 * ────────────────────────────────────────────────────────────────────────── */

function gitAddDate(path: string): string {
  const r = exec('git', ['log', '--diff-filter=A', '--format=%aI', '--', path], 30_000);
  const first = r.stdout.trim().split(/\r?\n/).filter(Boolean).pop();
  return first ?? 'unknown';
}

/** Data directories of clusters on this host, found rather than assumed. */
export function discoverWindowsDataDirectories(): string[] {
  const roots = [
    'C:/Program Files/PostgreSQL',
    'C:/Program Files (x86)/PostgreSQL',
    process.env.USERPROFILE ?? '',
    tmpdir(),
  ].filter((r) => r !== '' && existsSync(r));
  const found = new Set<string>();
  for (const root of roots) {
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(root, entry);
      try {
        if (!statSync(full).isDirectory()) continue;
      } catch {
        continue;
      }
      if (existsSync(join(full, 'PG_VERSION'))) found.add(full);
      // One level deeper covers the installer layout `PostgreSQL/<major>/data`.
      let inner: string[];
      try {
        inner = readdirSync(full);
      } catch {
        continue;
      }
      for (const sub of inner) {
        const subFull = join(full, sub);
        try {
          if (statSync(subFull).isDirectory() && existsSync(join(subFull, 'PG_VERSION')))
            found.add(subFull);
        } catch {
          /* ignore */
        }
      }
    }
  }
  return [...found].sort();
}

/**
 * The read-only shell probe run inside a WSL distribution. Kept as a FILE rather than a
 * `-c` payload: `wsl.exe` re-quotes its arguments on the way in, which silently emptied a
 * `$VAR` in an earlier version of this probe and made it scan the current directory
 * instead of the cluster — a scan that then "found" the marker in unrelated files.
 */
function wslProbeScript(needles: string[]): string {
  const quoted = [...needles, LEDGER_TABLE, ...TABLES_CREATED_BY_057]
    .map((n) => `"${n}"`)
    .join(' ');
  return [
    '#!/bin/sh',
    'D=/var/lib/postgresql/16/main',
    'if [ ! -f "$D/PG_VERSION" ]; then D=$(find /var/lib/postgresql -maxdepth 3 -name PG_VERSION 2>/dev/null | head -1 | xargs -r dirname); fi',
    'echo "PGDATA=$D"',
    '[ -n "$D" ] && echo "PG_VERSION=$(cat "$D/PG_VERSION" 2>/dev/null)"',
    'echo "BASE_OIDS=$(ls -1 "$D/base" 2>/dev/null | tr "\\n" "," )"',
    `for n in ${quoted}; do`,
    '  echo "MARKER $n=$(grep -rlaF "$n" "$D/base" "$D/global" 2>/dev/null | head -3 | tr "\\n" ";")"',
    'done',
    'echo "DBNAMES=$(strings -a "$D/global"/1262 2>/dev/null | grep -aoE \'^[a-z][a-z0-9_-]{2,40}$\' | sort -u | tr "\\n" "," )"',
    'echo PROBE_DONE',
    '',
  ].join('\n');
}

/** `C:\\x\\y` → `/mnt/c/x/y`, the path a WSL distribution sees. */
export function toWslPath(windowsPath: string): string {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(windowsPath);
  if (!m) return windowsPath.split('\\').join('/');
  return `/mnt/${(m[1] as string).toLowerCase()}/${(m[2] as string).split('\\').join('/')}`;
}

function wslDistributions(): string[] {
  const r = exec('wsl.exe', ['-l', '-q'], 60_000);
  if (!r.ok) return [];
  // `wsl -l -q` emits UTF-16LE, which arrives here as NUL-separated ASCII once the NULs
  // are stripped; splitting on whitespace recovers the names either way.
  return r.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '');
}

function wslFinding(distro: string, needles: string[]): Finding {
  const staging = mkdtempSync(join(tmpdir(), 'fbl020-census-'));
  const script = join(staging, 'wsl-cluster-probe.sh');
  writeFileSync(script, wslProbeScript(needles), 'utf8');
  const evidence: Evidence[] = [];
  let verdict: Verdict = 'indeterminate';
  let basis: string;
  let inspected: boolean;
  try {
    const r = exec('wsl.exe', ['-d', distro, '-u', 'root', '--', 'sh', toWslPath(script)], 300_000);
    const out = r.stdout;
    inspected = out.includes('PROBE_DONE');
    for (const line of out.split(/\r?\n/).filter((l) => l.trim() !== '' && l !== 'PROBE_DONE')) {
      const [check, ...rest] = line.split('=');
      evidence.push({ check: (check ?? '').trim(), observed: rest.join('=').trim() });
    }
    if (!inspected) {
      evidence.push({ check: 'probe', observed: `did not complete: ${r.stderr.slice(0, 300)}` });
      basis = 'the distribution could not be probed, so nothing was established either way';
    } else {
      /*
       * ONLY THE 057 NEEDLES DECIDE THE VERDICT. The probe also searches for
       * `schema_migrations` and for the table 057 creates, and those are genuinely
       * expected to hit in a distribution that runs some OTHER project's migrations
       * against its own ledger table of the same name — the afroride cluster does. A
       * check over "any marker line that is non-empty" would read that as 057 being
       * present, which is the exact false positive this narrowing removes.
       */
      const hit057 = needles.some(
        (n) => evidence.find((e) => e.check === `MARKER ${n}`)?.observed !== '',
      );
      const hasCluster = evidence.some((e) => e.check === 'PG_VERSION' && e.observed !== '');
      const ledgerHit = evidence.find((e) => e.check === `MARKER ${LEDGER_TABLE}`)?.observed !== '';
      if (!hasCluster) {
        verdict = 'no';
        basis = 'the distribution holds no PostgreSQL data directory at all';
      } else if (hit057) {
        verdict = 'yes';
        basis = 'a 057-or-later ledger filename is present in the cluster’s heap files';
      } else {
        verdict = 'no';
        basis =
          'the distribution holds a PostgreSQL cluster and no 057-or-later ledger filename ' +
          'appears anywhere in its heap files' +
          (ledgerHit
            ? `. It DOES carry a '${LEDGER_TABLE}' relation — another project's ledger, under ` +
              'the same conventional name — and none of its rows names a migration of this ' +
              'repository numbered 057 or above'
            : `, and it carries no '${LEDGER_TABLE}' relation at all`);
      }
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return {
    id: `wsl-${distro}`,
    what_it_is: `the PostgreSQL cluster inside the WSL distribution '${distro}'`,
    persistence: 'persistent',
    inspected,
    inspection_method:
      'a read-only shell script run in the distribution as root: PG_VERSION, the base/ OID ' +
      'census, a byte scan of base/ and global/ for each 057-or-later ledger filename, and ' +
      'the database names readable from the shared catalog file',
    evidence,
    migration_057_applied: verdict,
    basis,
    limits: [...MARKER_SCAN_LIMITS],
  };
}

function dockerFinding(needles: string[]): Finding {
  const compose = join(ROOT, 'docker-compose.yml');
  const declared = existsSync(compose) ? composeNamedVolumes(readFileSync(compose, 'utf8')) : [];
  const candidates = composeVolumeCandidates(ROOT, declared);
  const evidence: Evidence[] = [
    {
      check: 'named volumes declared by docker-compose.yml',
      observed: declared.join(', ') || 'none',
    },
    { check: 'volume names Compose would create', observed: candidates.join(', ') || 'none' },
    {
      check: 'date docker-compose.yml entered the repository',
      observed: gitAddDate('docker-compose.yml'),
    },
  ];

  // The vhdx timestamp, recorded because the order asked for it — and reported with the
  // reason it turned out NOT to be load-bearing here.
  const vhdx = join(process.env.LOCALAPPDATA ?? '', 'Docker', 'wsl', 'disk', 'docker_data.vhdx');
  if (existsSync(vhdx)) {
    const st = statSync(vhdx);
    evidence.push({
      check: 'docker_data.vhdx last modified / size',
      observed: `${st.mtime.toISOString()} / ${st.size} bytes`,
    });
  } else {
    evidence.push({ check: 'docker_data.vhdx', observed: 'not present at the expected path' });
  }

  const ls = exec('docker', ['volume', 'ls', '--format', '{{.Name}}'], 90_000);
  let verdict: Verdict = 'indeterminate';
  let basis: string;
  const limits: string[] = [];

  if (!ls.ok) {
    evidence.push({
      check: 'docker volume ls',
      observed: `unavailable: ${(ls.stderr || ls.stdout).slice(0, 300)}`,
    });
    basis =
      'the Docker daemon did not answer, so the volume could not be inspected directly. The ' +
      'vhdx timestamp above is NOT offered as a substitute: the file is rewritten by any ' +
      'Docker activity whatsoever, so a timestamp later than the compose file proves nothing ' +
      'about whether this stack ever ran.';
    limits.push('a daemon that cannot be reached leaves this environment uninspected');
  } else {
    const volumes = ls.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const present = candidates.filter((c) => volumes.includes(c));
    evidence.push({ check: 'volumes on the daemon', observed: String(volumes.length) });
    evidence.push({
      check: "this project's compose volume present",
      observed:
        present.length === 0 ? 'NO — none of the candidate names exists' : present.join(', '),
    });
    const projects = exec('docker', ['compose', 'ls', '-a', '--format', 'json'], 90_000);
    evidence.push({
      check: 'docker compose projects known to the daemon',
      observed: projects.ok ? projects.stdout.slice(0, 600).replace(/\s+/g, ' ') : 'unavailable',
    });

    if (present.length > 0) {
      // The volume exists, so the only honest next step is to look inside it.
      const sweep = dockerVolumeSweep(needles);
      evidence.push({
        check: 'marker sweep of PostgreSQL clusters in docker volumes',
        observed: sweep.observed,
      });
      verdict = sweep.hits ? 'yes' : sweep.complete ? 'no' : 'indeterminate';
      basis = sweep.hits
        ? 'the compose volume exists and a 057-or-later ledger filename was found in a ' +
          'PostgreSQL cluster held in a docker volume'
        : sweep.complete
          ? 'the compose volume exists but no 057-or-later ledger filename appears in any ' +
            'PostgreSQL cluster held in a docker volume'
          : 'the compose volume exists and the sweep could not complete';
      limits.push(...MARKER_SCAN_LIMITS);
    } else {
      const sweep = dockerVolumeSweep(needles);
      evidence.push({
        check: 'marker sweep of PostgreSQL clusters in docker volumes',
        observed: sweep.observed,
      });
      verdict = sweep.hits ? 'yes' : 'no';
      basis =
        'Compose creates its named volume the first time the stack is brought up, and none of ' +
        'the names it would use exists on this daemon — so this stack has never run here and ' +
        'the volume holds nothing. Independently, every PostgreSQL cluster that IS held in a ' +
        'docker volume on this daemon was swept for the marker: ' +
        (sweep.hits ? 'a hit was found.' : 'none holds it.');
      limits.push(
        'this is a statement about THIS daemon. A volume removed with `docker volume rm`, or ' +
          'a stack brought up on another machine, is outside what can be observed here',
      );
    }
  }

  return {
    id: 'docker-compose-postgres-volume',
    what_it_is:
      "the named volume backing docker-compose.yml's postgres service, which is the only " +
      'part of that stack that survives `docker compose down`',
    persistence: 'persistent',
    inspected: ls.ok,
    inspection_method: ls.ok
      ? 'the Docker daemon was asked directly which volumes exist, which compose projects it ' +
        'knows, and every PostgreSQL cluster inside a volume was byte-scanned for the marker ' +
        'from a read-only container'
      : 'the daemon was unreachable; only file timestamps and the compose file could be read',
    evidence,
    migration_057_applied: verdict,
    basis,
    limits,
  };
}

/**
 * One read-only container, mounting the daemon's volume root, that scans every PostgreSQL
 * cluster it finds. Read-only, and confined to `base/` and `global/` for the same reason
 * the host-side scan is.
 */
function dockerVolumeSweep(needles: string[]): {
  hits: boolean;
  complete: boolean;
  observed: string;
} {
  const image = exec(
    'docker',
    ['image', 'inspect', 'postgres:16-alpine', '--format', '{{.Id}}'],
    60_000,
  );
  if (!image.ok)
    return {
      hits: false,
      complete: false,
      observed: 'skipped: no local postgres:16-alpine image, and the census pulls nothing',
    };
  const script =
    'n=0; h=0; for v in /vols/*/_data/PG_VERSION; do [ -f "$v" ] || continue; ' +
    'd=$(dirname "$v"); n=$((n+1)); ' +
    needles
      .map(
        (x) =>
          `if grep -rlaqF "${x}" "$d/base" "$d/global" 2>/dev/null; then h=$((h+1)); echo "HIT $d ${x}"; fi; `,
      )
      .join('') +
    'done; echo "clusters_scanned=$n hits=$h"';
  const r = exec(
    'docker',
    [
      'run',
      '--rm',
      '-v',
      '/var/lib/docker/volumes:/vols:ro',
      'postgres:16-alpine',
      'sh',
      '-c',
      script,
    ],
    900_000,
  );
  const summary = r.stdout.split(/\r?\n/).find((l) => l.startsWith('clusters_scanned=')) ?? '';
  return {
    hits: r.stdout.includes('HIT '),
    complete: summary !== '',
    observed:
      summary === ''
        ? `sweep did not complete: ${(r.stderr || r.stdout).slice(0, 300)}`
        : `${summary} ${r.stdout.match(/HIT .*/g)?.join(' ; ') ?? ''}`.trim(),
  };
}

/**
 * Which data directory currently HAS a postmaster listening on `port`.
 *
 * ── WHY `postmaster.opts` ALONE WAS WRONG ───────────────────────────────────
 *
 * The R5 census matched the local cluster by searching every data directory for one
 * whose `postmaster.opts` mentioned the port, and took the first hit in sorted order.
 * `postmaster.opts` is written at launch and left behind for ever, so a STOPPED cluster
 * from a superseded revision — `…/Temp/fbl020r4-pg`, launched on the same port months
 * earlier — matched first and won. Two things went wrong at once, and both were silent:
 * the live cluster's findings were filed under the dead cluster's path, and the dead
 * cluster was EXCLUDED from the per-directory sweep as "already covered". It holds 057.
 * A census that drops an environment carrying the migration is worse than no census.
 *
 * `postmaster.pid` is written by a RUNNING postmaster and removed on clean shutdown: its
 * second line is the data directory and its fourth is the port. That is the authority
 * here, and the live connection's own `SHOW data_directory` confirms it.
 */
export function runningDataDirectoryForPort(dirs: string[], port: string): string | undefined {
  for (const dir of dirs) {
    const pid = join(dir, 'postmaster.pid');
    if (!existsSync(pid)) continue;
    try {
      const lines = readFileSync(pid, 'utf8').split(/\r?\n/);
      if ((lines[3] ?? '').trim() === port) return dir;
    } catch {
      /* an unreadable pid file is simply not a match */
    }
  }
  return undefined;
}

/** The local drill cluster: it answers SQL, so it is asked. */
async function localClusterFinding(
  port: string,
  needles: string[],
  policy: DisposableClusterPolicy,
  services: Array<{ service: string; state: string; data_directory: string }>,
): Promise<Finding> {
  const { Client } = await import('pg');
  const url = `postgresql://postgres@127.0.0.1:${port}/postgres`;
  const evidence: Evidence[] = [];
  let verdict: Verdict = 'indeterminate';
  let basis: string;
  let inspected = false;

  const dirs = discoverWindowsDataDirectories();
  const running = runningDataDirectoryForPort(dirs, port);
  const alsoRecordPort = dirs.filter((d) => {
    const opts = join(d, 'postmaster.opts');
    return existsSync(opts) && readFileSync(opts, 'utf8').includes(`"${port}"`);
  });
  const dataDir = running;
  evidence.push({
    check: 'data directory (the postmaster.pid of a RUNNING server on this port)',
    observed: dataDir ?? 'no running postmaster on this port',
  });
  evidence.push({
    check: 'other data directories whose recorded launch names this port',
    observed:
      alsoRecordPort.filter((d) => d !== dataDir).join(' ; ') ||
      'none — no stopped cluster claims this port',
  });

  /** Filled from the live catalogue when the server answers; from disk when it does not. */
  let content: ClusterContent = {
    readable: false,
    source: 'not read',
    names: [],
    nondefault_base_oids: [],
    reconciled: false,
    detail: 'the cluster was neither reachable nor locatable on disk',
  };

  const client = new Client({ connectionString: url, connectionTimeoutMillis: 10_000 });
  try {
    await client.connect();
    inspected = true;
    const all = (
      await client.query<{ datname: string }>(`SELECT datname FROM pg_database ORDER BY datname`)
    ).rows.map((r) => r.datname);
    const dbs = (
      await client.query<{ datname: string }>(
        `SELECT datname FROM pg_database WHERE datistemplate = FALSE ORDER BY datname`,
      )
    ).rows.map((r) => r.datname);
    /*
     * The column `SHOW` returns is named after the setting, so this reads
     * `data_directory` and NOT some alias of the implementer's choosing. The first
     * version of this line destructured `dir` and therefore recorded "not reported" for
     * a value the server had in fact reported \u2014 an evidence line that quietly withheld
     * the very confirmation `inspection_method` claims it carries.
     */
    const live = (await client.query<{ data_directory: string }>(`SHOW data_directory`)).rows[0]
      ?.data_directory;
    evidence.push({
      check: 'data directory as the RUNNING server reports it (SHOW data_directory)',
      observed: live ?? 'not reported',
    });
    if (live !== undefined && dataDir !== undefined)
      evidence.push({
        check: 'postmaster.pid and the running server agree on the data directory',
        observed: String(
          live.split('\\').join('/').toLowerCase() === dataDir.split('\\').join('/').toLowerCase(),
        ),
      });
    evidence.push({ check: 'databases', observed: dbs.join(', ') });
    content = {
      readable: true,
      source: 'the running server’s own pg_database catalogue',
      names: all,
      nondefault_base_oids: [],
      reconciled: true,
      detail: `${all.length} database(s) read from the live catalogue`,
    };
    await client.end();

    const withMarker: string[] = [];
    for (const db of dbs) {
      const c = new Client({
        connectionString: `postgresql://postgres@127.0.0.1:${port}/${db}`,
        connectionTimeoutMillis: 10_000,
      });
      try {
        await c.connect();
        const rows = (
          await c.query<{ filename: string; checksum_algorithm: string | null }>(
            `SELECT filename, checksum_algorithm FROM schema_migrations ORDER BY filename`,
          )
        ).rows;
        const hit = rows.filter((r) => needles.includes(r.filename));
        evidence.push({
          check: `ledger of ${db}`,
          observed:
            `${rows.length} row(s); 057-or-later: ` +
            (hit.length === 0
              ? 'none'
              : hit
                  .map((h) => `${h.filename} [${h.checksum_algorithm ?? 'NULL ALGORITHM'}]`)
                  .join(', ')),
        });
        if (hit.length > 0) withMarker.push(db);
      } catch (err) {
        evidence.push({
          check: `ledger of ${db}`,
          observed: `no readable ${LEDGER_TABLE}: ${(err as Error).message.split('\n')[0] ?? ''}`,
        });
      } finally {
        await c.end().catch(() => undefined);
      }
    }
    verdict = withMarker.length > 0 ? 'yes' : 'no';
    basis =
      withMarker.length > 0
        ? `the ledger of ${withMarker.join(', ')} records a 057-or-later migration. This is the ` +
          'cluster the drills run against, so the finding is expected — it is reported because ' +
          'a census that omitted the one environment holding the migration would be worthless.'
        : 'no database on this cluster records a 057-or-later migration';
  } catch (err) {
    evidence.push({
      check: 'connection',
      observed: `refused: ${(err as Error).message.split('\n')[0] ?? ''}`,
    });
    if (dataDir !== undefined) {
      const insp = inspectDataDirectory(dataDir, needles);
      inspected = insp.readable;
      evidence.push({
        check: 'base/ OIDs (server not running)',
        observed: insp.base_oids.join(', '),
      });
      evidence.push({ check: 'marker hits', observed: insp.marker_057.hits.join(' ; ') || 'none' });
      content = databaseNamesFromDisk(dataDir);
      const v = verdictFromInspection(insp);
      verdict = v.verdict;
      basis = `${v.basis} (the server was not accepting connections, so the data directory was read instead)`;
    } else {
      basis = 'the server was not running and no data directory recording that port was found';
    }
  }

  /*
   * THE CLASSIFICATION IS EARNED, NOT ASSERTED. This finding used to be hard-coded
   * `persistence: 'disposable'` with one supporting line of evidence — "lives under the
   * OS temporary directory: true". That is the same path-prefix reasoning that misfiled
   * this project's other scratch cluster as an environment, so the same provenance-and-
   * content assessment every other host cluster now gets is applied here too, on the
   * strongest content evidence available: the live catalogue.
   */
  const disposability =
    dataDir === undefined
      ? {
          verdict: 'indeterminate' as const,
          basis:
            'no running postmaster on this port and no data directory to read, so nothing ' +
            'about this cluster could be established.',
          evidence: [],
          unattributed_databases: [],
        }
      : assessDisposability({
          data_directory: dataDir,
          service: services.find(
            (s) => s.data_directory.toLowerCase() === dataDir.split('/').join('\\').toLowerCase(),
          ),
          launch: readLaunchDeclaration(dataDir, [
            ...policy.durability_settings_that_must_be_off.settings,
            'listen_addresses',
          ]),
          content,
          markers: (() => {
            const insp = inspectDataDirectory(dataDir, needles);
            return { migration: insp.marker_057, ledger: insp.marker_ledger };
          })(),
          policy,
        });

  return {
    id: `local-disposable-cluster-${port}`,
    what_it_is:
      `the PostgreSQL cluster on 127.0.0.1:${port} that the local test suite and the upgrade ` +
      'drills run against',
    persistence: persistenceFrom(disposability.verdict),
    inspected,
    inspection_method:
      'connected as the local superuser and read pg_database and every database’s ' +
      LEDGER_TABLE +
      ' directly; the data directory is the one a RUNNING postmaster records in ' +
      'postmaster.pid, confirmed by the server’s own SHOW data_directory',
    evidence: [...evidence, ...disposability.evidence],
    migration_057_applied: verdict,
    disposability,
    basis,
    limits: [
      'a disposable cluster is not a persistent environment, and this finding does not claim ' +
        'it is; the classification is stated in `persistence` so a reader can disagree with it',
    ],
  };
}

/**
 * Windows services whose name looks like a PostgreSQL server, with the data directory read
 * out of the registered command line. This is what makes "the Windows PostgreSQL service on
 * port 5433" an IDENTIFIED environment in the artifact, rather than one entry among many
 * anonymous data directories that a reader has to match up by hand.
 */
export function discoverWindowsServiceClusters(): Array<{
  service: string;
  state: string;
  data_directory: string;
}> {
  if (process.platform !== 'win32') return [];
  const q = exec('sc', ['query', 'state=', 'all'], 60_000);
  if (!q.ok) return [];
  const names = q.stdout
    .split(/\r?\n/)
    .filter((l) => /^SERVICE_NAME:/.test(l.trim()))
    .map((l) => l.split(':').slice(1).join(':').trim())
    .filter((n) => /postgres/i.test(n));
  const out: Array<{ service: string; state: string; data_directory: string }> = [];
  for (const service of names) {
    const state =
      exec('sc', ['query', service], 30_000)
        .stdout.split(/\r?\n/)
        .find((l) => l.includes('STATE'))
        ?.trim() ?? 'unknown';
    const reg = exec(
      'reg',
      ['query', `HKLM\\SYSTEM\\CurrentControlSet\\Services\\${service}`, '/v', 'ImagePath'],
      30_000,
    );
    const dir = /-D\s+"?([^"]+?)"?(?:\s+-|\s*$)/.exec(reg.stdout)?.[1] ?? '';
    out.push({ service, state, data_directory: dir.split('/').join('\\') });
  }
  return out;
}

/** A PostgreSQL cluster found on this host, read from its data directory alone. */
function otherClusterFinding(
  dataDir: string,
  needles: string[],
  policy: DisposableClusterPolicy,
  service?: { service: string; state: string },
): Finding {
  const insp = inspectDataDirectory(dataDir, needles);
  const v = verdictFromInspection(insp);
  const disposability = assessDisposability({
    data_directory: dataDir,
    service,
    launch: readLaunchDeclaration(dataDir, [
      ...policy.durability_settings_that_must_be_off.settings,
      'listen_addresses',
    ]),
    content: databaseNamesFromDisk(dataDir),
    markers: { migration: insp.marker_057, ledger: insp.marker_ledger },
    policy,
  });
  const persistence = persistenceFrom(disposability.verdict);
  const newestBase =
    Object.values(insp.base_mtimes)
      .filter((m) => m !== 'unreadable')
      .sort()
      .pop() ?? 'none';
  const added = needles[0] === undefined ? 'unknown' : gitAddDate(`migrations/${needles[0]}`);
  const scram = insp.host_based_auth.some((l) => /scram-sha-256/.test(l));
  return {
    id:
      service === undefined
        ? `host-cluster:${dataDir.split('\\').join('/')}`
        : `windows-service:${service.service}`,
    what_it_is:
      service === undefined
        ? `a PostgreSQL ${insp.pg_version} data directory found on this host`
        : `the Windows service '${service.service}' — a PostgreSQL ${insp.pg_version} server ` +
          `registered to start with the machine (${insp.configured_port})`,
    persistence,
    inspected: insp.readable,
    inspection_method:
      'filesystem only — PG_VERSION, the base/ OID census with modification times, the ' +
      'configured port, the host-based authentication methods, the server log listing, and a ' +
      'byte scan of base/ and global/. NO CONNECTION IS ATTEMPTED and NOTHING IS MODIFIED.',
    evidence: [
      ...(service === undefined
        ? []
        : [{ check: 'Windows service state', observed: `${service.service} — ${service.state}` }]),
      { check: 'PG_VERSION', observed: insp.pg_version },
      { check: 'configured port', observed: insp.configured_port },
      {
        // The reason this census never authenticates, recorded as a fact rather than as
        // an aside: the credential is not held, and altering pg_hba.conf to get in would
        // be a modification of the environment made in order to read it.
        check: 'authentication attempted',
        observed: scram
          ? 'NO — this cluster requires scram-sha-256 and the password is not held by this ' +
            'project. No credential was guessed and no configuration was changed.'
          : 'NO — the census answers the question from the filesystem in every case',
      },
      {
        check: 'newest base/ modification time vs the date 057 entered the repository',
        observed:
          `newest base/ write ${newestBase}; ${needles[0] ?? '057'} first committed ${added}` +
          (newestBase !== 'none' && added !== 'unknown' && newestBase < added
            ? ' — every database directory here was last written BEFORE 057 existed'
            : ''),
      },
      { check: 'base/ OIDs (one per database)', observed: insp.base_oids.join(', ') || 'none' },
      { check: 'base/ modification times', observed: JSON.stringify(insp.base_mtimes) },
      { check: 'host-based authentication', observed: insp.host_based_auth.join(' | ') || 'none' },
      {
        check: 'most recent server logs',
        observed:
          insp.server_log_files.map((l) => `${l.file} ${l.bytes}B ${l.modified}`).join(' ; ') ||
          'none',
      },
      {
        check: `bytes scanned for a 057-or-later ledger filename`,
        observed: `${insp.marker_057.bytes_scanned} across ${insp.marker_057.files_scanned} file(s), complete=${insp.marker_057.complete}`,
      },
      { check: '057-or-later marker hits', observed: insp.marker_057.hits.join(' ; ') || 'none' },
      {
        check: `'${LEDGER_TABLE}' marker hits`,
        observed: insp.marker_ledger.hits.join(' ; ') || 'none',
      },
      {
        check: `tables 057 creates (${TABLES_CREATED_BY_057.join(', ')}) marker hits`,
        observed: insp.marker_tables_057.hits.join(' ; ') || 'none',
      },
      ...disposability.evidence,
    ],
    migration_057_applied: v.verdict,
    basis: v.basis,
    disposability,
    limits: [...MARKER_SCAN_LIMITS],
  };
}

interface Census {
  order: string;
  acceptance: string;
  disclaimer: string;
  generated_at: string;
  host: { platform: string; node: string };
  repository: { head: string; markers_searched_for: string[] };
  environments: Finding[];
  totals: Record<string, number>;
  conclusion: CensusConclusion;
}

/**
 * The §0.2 position this evidence supports, as a token rather than as a sentence.
 *
 * Prose about the census is what R5 got wrong: the artifact said FREEZE and the report
 * and the requirement map said the opposite, and nothing compared them. A token makes
 * the comparison mechanical — `scripts/check-census-prose.ts` reads it and refuses any
 * delivery document that asserts a different one.
 */
export type CensusPosition =
  'FREEZE_057_AND_ADD_058' | 'EDIT_057_IN_PLACE' | 'BLOCKED_INDETERMINATE';

/**
 * The one sentence that states the branch, WITHOUT any count that varies by host, so
 * the same branch reads identically here and on a CI runner. The delivery documents
 * quote this verbatim; anything host-specific stays in `implementer_reading`.
 */
export const BRANCH_SENTENCE: Record<CensusPosition, string> = {
  FREEZE_057_AND_ADD_058:
    'AT LEAST ONE PERSISTENT ENVIRONMENT HAS APPLIED A FORM OF 057. Under §0.2 that freezes ' +
    '057 and sends every further schema correction to 058.',
  BLOCKED_INDETERMINATE:
    'NO PERSISTENT ENVIRONMENT WAS SHOWN TO HAVE APPLIED 057, BUT ONE OR MORE COULD NOT BE ' +
    'INSPECTED. An uninspected environment is not a clean one; the §0.2 branch cannot be ' +
    'taken on this evidence.',
  EDIT_057_IN_PLACE:
    'NO PERSISTENT ENVIRONMENT HAS APPLIED ANY FORM OF 057, on the evidence above. Every ' +
    'environment reachable from this machine was inspected and reported `no`, except the ' +
    'disposable and ephemeral ones listed separately. Under §0.2 that leaves migration 057 ' +
    'editable in place and requires no 058.',
};

export interface CensusConclusion {
  persistent_environments_with_057: string[];
  persistent_environments_indeterminate: string[];
  disposability_indeterminate: string[];
  disposable_or_ephemeral_with_057: string[];
  position: CensusPosition;
  branch_sentence: string;
  implementer_reading: string;
}

/**
 * The §0.2 question, answered from the findings.
 *
 * A cluster whose DISPOSABILITY could not be established is counted here WITH the
 * persistent ones. That is the whole point of the third value: the §0.2 branch may be
 * taken only when every environment that could be an environment has been shown clean,
 * and a cluster nobody could classify is not one that has been shown anything.
 */
export function summarize(environments: Finding[]): CensusConclusion {
  const treatedAsPersistent = environments.filter(
    (e) => e.persistence === 'persistent' || e.persistence === 'indeterminate',
  );
  const withIt = treatedAsPersistent
    .filter((e) => e.migration_057_applied === 'yes')
    .map((e) => e.id);
  const unknown = treatedAsPersistent
    .filter((e) => e.migration_057_applied === 'indeterminate')
    .map((e) => e.id);
  const unclassifiable = environments
    .filter((e) => e.persistence === 'indeterminate')
    .map((e) => e.id);
  const elsewhere = environments
    .filter(
      (e) =>
        e.persistence !== 'persistent' &&
        e.persistence !== 'indeterminate' &&
        e.migration_057_applied === 'yes',
    )
    .map((e) => e.id);

  const conservative =
    unclassifiable.length === 0
      ? ''
      : ` ${unclassifiable.length} cluster(s) whose disposability could not be established are ` +
        'COUNTED WITH THE PERSISTENT ONES above rather than assumed to be drill clusters.';

  const position: CensusPosition =
    withIt.length > 0
      ? 'FREEZE_057_AND_ADD_058'
      : unknown.length > 0
        ? 'BLOCKED_INDETERMINATE'
        : 'EDIT_057_IN_PLACE';

  const closing =
    position === 'EDIT_057_IN_PLACE'
      ? " This is the implementer's reading of the evidence, offered for review — not a " +
        'decision, and not an acceptance by anyone.'
      : '';

  return {
    persistent_environments_with_057: withIt,
    persistent_environments_indeterminate: unknown,
    disposability_indeterminate: unclassifiable,
    disposable_or_ephemeral_with_057: elsewhere,
    position,
    branch_sentence: BRANCH_SENTENCE[position],
    implementer_reading: BRANCH_SENTENCE[position] + closing + conservative,
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let out: string | undefined;
  let log: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === '--out') out = argv[(i += 1)];
    else if (arg === '--log') log = argv[(i += 1)];
    else {
      console.error(`Unrecognized argument: ${arg}`);
      process.exit(2);
    }
  }

  const markers = migration057Markers();
  const environments: Finding[] = [];

  // (A) CI.
  environments.push(ciFinding(analyzeAllWorkflows()));

  /*
   * (B) The registered Windows services FIRST, so the one the order names is an
   * identified environment; then every other cluster whose data directory is on this
   * host. The wider sweep is not padding: a census that inspected only the five
   * environments it was told about could not notice a sixth, and there are 39 more
   * clusters on this machine.
   */
  const policy = loadDisposableClusterPolicy();
  const dataDirs = discoverWindowsDataDirectories();
  const localPort = '55434';
  /*
   * ONLY the directory a RUNNING postmaster claims is skipped here, and only because
   * `localClusterFinding` reports it in full below. The R5 census skipped whichever
   * directory merely MENTIONED the port in its long-dead `postmaster.opts`, which
   * dropped a stopped cluster carrying 057 out of the artifact entirely.
   */
  const localDataDir = runningDataDirectoryForPort(dataDirs, localPort);
  const services = discoverWindowsServiceClusters().filter(
    (s) => s.data_directory !== '' && existsSync(join(s.data_directory, 'PG_VERSION')),
  );
  const serviceDirs = new Set(services.map((s) => s.data_directory.toLowerCase()));
  for (const s of services) {
    environments.push(otherClusterFinding(s.data_directory, markers, policy, s));
  }
  for (const dir of dataDirs) {
    if (dir === localDataDir || serviceDirs.has(dir.toLowerCase())) continue;
    environments.push(otherClusterFinding(dir, markers, policy));
  }

  // (C) The compose volume.
  environments.push(dockerFinding(markers));

  // (D) WSL.
  const distros = process.platform === 'win32' ? wslDistributions() : [];
  if (process.platform !== 'win32') {
    /*
     * NOT `indeterminate`. WSL is a Windows feature, so on any other host there is no
     * environment here to inspect and saying "could not be inspected" would put a phantom
     * unknown into the artifact — which under §0.2 is enough to block the branch. An
     * environment that cannot exist is different from one nobody looked at.
     */
    environments.push({
      id: 'wsl',
      what_it_is: 'WSL distributions on this host',
      persistence: 'persistent',
      inspected: true,
      inspection_method: 'the host platform was read',
      evidence: [{ check: 'process.platform', observed: process.platform }],
      migration_057_applied: 'no',
      basis: 'WSL is a Windows feature and this host is not Windows, so no such cluster exists',
      limits: [],
    });
  } else if (distros.length === 0) {
    environments.push({
      id: 'wsl',
      what_it_is: 'WSL distributions on this host',
      persistence: 'persistent',
      inspected: false,
      inspection_method: '`wsl.exe -l -q` did not answer',
      evidence: [{ check: 'wsl -l -q', observed: 'unavailable' }],
      migration_057_applied: 'indeterminate',
      basis: 'WSL could not be enumerated, so its clusters were not inspected',
      limits: ['an uninspected environment is not a clean one'],
    });
  } else {
    for (const distro of distros) {
      // Docker Desktop's own distribution is covered by the docker finding above, which
      // inspects the volumes it holds from inside the daemon.
      if (distro === 'docker-desktop' || distro === 'docker-desktop-data') continue;
      environments.push(wslFinding(distro, markers));
    }
  }

  // (E) The local drill cluster.
  environments.push(await localClusterFinding(localPort, markers, policy, services));

  const head = exec('git', ['rev-parse', 'HEAD'], 20_000).stdout.trim();
  const census: Census = {
    order: 'FBL-020-R5 §0.1',
    acceptance: 'NOT_REVIEWED',
    disclaimer:
      'This document REPORTS a finding and states the implementer’s reading of it. It is NOT ' +
      'an acceptance, ratification or discharge by the architect or by anyone else, and it ' +
      'must not be cited as one.',
    generated_at: new Date().toISOString(),
    host: { platform: process.platform, node: process.version },
    repository: { head: head === '' ? 'unknown' : head, markers_searched_for: markers },
    environments,
    totals: {
      environments: environments.length,
      persistent: environments.filter((e) => e.persistence === 'persistent').length,
      disposable: environments.filter((e) => e.persistence === 'disposable').length,
      ephemeral: environments.filter((e) => e.persistence === 'ephemeral').length,
      persistence_indeterminate: environments.filter((e) => e.persistence === 'indeterminate')
        .length,
      inspected: environments.filter((e) => e.inspected).length,
      verdict_no: environments.filter((e) => e.migration_057_applied === 'no').length,
      verdict_yes: environments.filter((e) => e.migration_057_applied === 'yes').length,
      verdict_indeterminate: environments.filter((e) => e.migration_057_applied === 'indeterminate')
        .length,
    },
    conclusion: summarize(environments),
  };

  if (out !== undefined) {
    writeFileSync(out, JSON.stringify(census, null, 2) + '\n');
    console.log(`census-written=${out}`);
  }

  const lines: string[] = [
    `order=${census.order} acceptance=${census.acceptance}`,
    census.disclaimer,
    '',
    `markers=${markers.join(', ')}`,
    '',
  ];
  for (const e of census.environments) {
    lines.push(
      `environment=${e.id}`,
      `  persistence=${e.persistence} inspected=${e.inspected}` +
        (e.disposability === undefined ? '' : ` disposability=${e.disposability.verdict}`),
      `  migration_057_applied=${e.migration_057_applied}`,
      `  method=${e.inspection_method}`,
      ...e.evidence.map((v) => `    ${v.check}: ${v.observed}`),
      `  basis=${e.basis}`,
      ...e.limits.map((l) => `  limit: ${l}`),
      '',
    );
  }
  lines.push(
    `totals=${JSON.stringify(census.totals)}`,
    '',
    `persistent_with_057=${census.conclusion.persistent_environments_with_057.join(', ') || 'none'}`,
    `persistent_indeterminate=${census.conclusion.persistent_environments_indeterminate.join(', ') || 'none'}`,
    `disposability_indeterminate=${census.conclusion.disposability_indeterminate.join(', ') || 'none'}`,
    `position=${census.conclusion.position}`,
    `disposable_or_ephemeral_with_057=${census.conclusion.disposable_or_ephemeral_with_057.join(', ') || 'none'}`,
    '',
    census.conclusion.implementer_reading,
  );
  const text = lines.join('\n') + '\n';
  process.stdout.write(text);
  if (log !== undefined) writeFileSync(log, text);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
