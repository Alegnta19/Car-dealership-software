/**
 * FBL-020-R5 §0.6 — AN AUTHORITATIVE INVENTORY OF EVERY RECONCILIATION IN 057.
 *
 *   npx tsx scripts/reconciliation-inventory.ts [--out <json>] [--log <txt>]
 *
 * ── WHY AN INVENTORY, RATHER THAN A LIST SOMEBODY MAINTAINS ─────────────────
 *
 * `scripts/upgrade-negative-controls.ts` proves individual reconciliations load-bearing,
 * and `NOT_LOAD_BEARING` in that file names the ones a pre-057 fixture cannot reach. Both
 * are HAND-WRITTEN, and neither could answer the question that matters: is that all of
 * them? R4's report said the ten controls covered the load-bearing reconciliations. That
 * was not checkable from anything, and it was wrong — the grantless-approval
 * reconciliation is three statements and only one had a control.
 *
 * So the inventory is DERIVED FROM THE MIGRATION. This file parses `057`, extracts every
 * statement that changes retained data or refuses to proceed, and requires each one to be
 * accounted for in exactly one of three ways:
 *
 *   `control`        — a negative control deletes precisely this statement. NOT declared:
 *                      COMPUTED, by taking the span each control's anchors remove and
 *                      matching its digest. A control whose anchors drift onto a different
 *                      statement therefore re-classifies that statement and leaves the old
 *                      one unaccounted for, which fails.
 *   `not-load-bearing` — declared in `architecture/reconciliation-inventory-057.json` with
 *                      the reason it cannot be exercised by a pre-057 fixture.
 *   `refusal-guard`  — a `DO` block that counts inconsistent rows and RAISEs. It
 *                      reconciles nothing by design: there is no honest repair, so it
 *                      fails loudly. Declared, with its reason.
 *
 * A statement in none of the three FAILS THE RUN, and so does a declaration that matches
 * no statement. Adding a reconciliation to 057 without either a control or a written
 * reason is therefore not possible in silence, which is the property R4 lacked.
 *
 * ── WHAT COUNTS AS A RECONCILIATION ─────────────────────────────────────────
 *
 * A statement that changes retained rows — `INSERT`, `UPDATE`, `DELETE` — or a `DO` block
 * that RAISEs. Pure DDL (`ALTER TABLE … ADD CONSTRAINT`, `CREATE INDEX`) is not a
 * reconciliation: it constrains data rather than reconciling it, and it either succeeds or
 * aborts the migration on its own. `CREATE TRIGGER` and `CREATE FUNCTION` are DDL too, and
 * one of them (`pd_evidence_version_floor`) is nonetheless covered by a control — coverage
 * is reported for every statement, while COMPLETENESS is required only over the
 * reconciliation set.
 *
 * ── THE KEY IS A WHITESPACE-NORMALIZED DIGEST ───────────────────────────────
 *
 * Not a line number, which moves whenever anything above it is edited, and not the raw
 * text, which would churn on a reindent. Runs of whitespace collapse to one space and the
 * result is hashed, so a statement can be moved or re-wrapped without a false alarm while
 * any change to what it DOES produces a new key and demands reclassification.
 */
import { createHash } from 'crypto';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { CONTROLS, canonical057, loadAnchors, removeStatement } from './upgrade-negative-controls';
import type { Control, ControlAnchor } from './upgrade-negative-controls';

const INVENTORY_FILE = join(__dirname, '..', 'architecture', 'reconciliation-inventory-057.json');

export interface Statement {
  /** 1-based position among all statements in the file. */
  ordinal: number;
  /** 1-based line the statement starts on, for a human reading the migration. */
  line: number;
  /** The leading keyword, uppercased: UPDATE, INSERT, DELETE, ALTER, CREATE, DO, … */
  verb: string;
  /** For DML, the table named immediately after the verb. */
  target: string;
  /** True for a `DO` block whose body RAISEs rather than writing. */
  raises: boolean;
  /** Whitespace-normalized text. */
  normalized: string;
  /**
   * The inventory key, as `inventoryKey` builds it: `stmt-<8 hex>-<8 hex>`, from the first
   * 64 bits of the sha256 of `normalized`. It is NOT the sha256 itself. That is what it
   * used to be, and a bare 64-character hex run is what gitleaks reads as a credential —
   * see the comment on `inventoryKey`.
   */
  key: string;
  /** First non-blank, non-comment line, for readability in the artifact. */
  excerpt: string;
}

/**
 * Splits SQL into statements at top-level semicolons.
 *
 * A `split(';')` cannot do this and the difference is not academic: `057` contains `DO $$
 * … END $$;` blocks whose bodies hold several semicolons, a `CREATE FUNCTION` with the
 * same shape, and string literals containing punctuation. The scanner therefore tracks
 * line comments, block comments, single-quoted strings (with `''` escapes) and
 * dollar-quoted bodies with arbitrary tags, and only a semicolon outside all of those ends
 * a statement.
 */
export function splitStatements(sql: string): Array<{ text: string; offset: number }> {
  const out: Array<{ text: string; offset: number }> = [];
  let start = 0;
  let i = 0;
  const n = sql.length;

  const push = (end: number): void => {
    const text = sql.slice(start, end);
    if (text.trim() !== '') out.push({ text, offset: start });
    start = end;
  };

  while (i < n) {
    const ch = sql[i] as string;
    const next = sql[i + 1];

    /*
     * NO LINE COUNTING HAPPENS HERE. The scanner only needs to find the offsets at which
     * statements begin; `parseStatements` converts an offset to a line number afterwards by
     * counting newlines in the text before it. Tracking a running line here as well meant
     * maintaining the same fact in two places — and the version that did got every reported
     * line wrong, because it recorded the line of the PREVIOUS statement's terminator.
     */
    if (ch === '-' && next === '-') {
      while (i < n && sql[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (ch === "'") {
      i += 1;
      while (i < n) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (ch === '$') {
      const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
      if (tag !== null) {
        const marker = tag[0];
        const close = sql.indexOf(marker, i + marker.length);
        i = close === -1 ? n : close + marker.length;
        continue;
      }
    }
    if (ch === ';') {
      i += 1;
      push(i);
      continue;
    }
    i += 1;
  }
  push(n);
  return out;
}

/** Comments and blank runs removed, whitespace collapsed: the digest input. */
export function normalizeStatement(text: string): string {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/--.*$/, ''))
    .join(' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function digest(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * FBL-020-R5, after ci.yml run 32162114699 went RED: THE INVENTORY KEY MUST NOT LOOK LIKE
 * A CREDENTIAL.
 *
 * The key was `digest(normalized)` — a bare 64-character hex sha256. gitleaks'
 * `generic-api-key` rule flags long hex runs, so committing this inventory produced 27
 * findings and failed the full-history secret scan. The values were never secrets; they
 * are content-addressed identifiers derived from the statement text.
 *
 * THE FORWARD FIX IS THE FORMAT. The key is now a readable prefix plus a hyphen-separated,
 * truncated digest: no run of 32 or more hex characters survives, and the value is still a
 * pure function of the statement. A suppression could not have been the forward fix —
 * every gitleaks fingerprint embeds a commit and a line, so a fingerprint written for the
 * LIVE file would rot the moment the inventory regenerated.
 *
 * HISTORY STILL NEEDED SUPPRESSING, AND THAT IS A DIFFERENT ARGUMENT. The bare digests were
 * pushed in 52e1567 and replaced in 0e99ecd, and `--log-opts=--all` scans every commit —
 * including the removal patch, which still contains the literal it removes. Run 32168154239
 * therefore reported 54 findings that no forward edit can reach, because this order forbids
 * rewriting history. `.gitleaksignore` carries all 54 as exact finding fingerprints, and a
 * fingerprint over a frozen commit cannot rot. Nothing about the scan was narrowed.
 *
 * TRUNCATION IS GUARDED, NOT ASSUMED. 64 bits over a few dozen statements makes collision
 * vanishingly unlikely but not impossible, and a silent collision would merge two
 * reconciliations in the inventory and in the negative-control anchors that key off it.
 * `assertUniqueKeys` below fails the generator instead.
 */
export function inventoryKey(text: string): string {
  const hex = digest(text);
  return `stmt-${hex.slice(0, 8)}-${hex.slice(8, 16)}`;
}

/** Fails loudly rather than letting a truncated key silently merge two statements. */
export function assertUniqueKeys(keys: readonly string[]): void {
  const seen = new Map<string, number>();
  const collisions: string[] = [];
  keys.forEach((k, i) => {
    const first = seen.get(k);
    if (first === undefined) seen.set(k, i);
    else collisions.push(`${k} (statements ${first + 1} and ${i + 1})`);
  });
  if (collisions.length > 0) {
    throw new Error(
      `inventory key collision — truncation is too short for this corpus: ${collisions.join('; ')}`,
    );
  }
}

const DML = new Set(['INSERT', 'UPDATE', 'DELETE']);

export function parseStatements(sql: string): Statement[] {
  const parsed = splitStatements(sql).map((raw, index) => {
    const normalized = normalizeStatement(raw.text);
    const verb = (/^([A-Za-z]+)/.exec(normalized)?.[1] ?? '').toUpperCase();
    let target = '';
    const m = /^(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(
      normalized,
    );
    if (m) target = (m[1] as string).toLowerCase();
    /*
     * THE LINE REPORTED IS THE FIRST LINE OF SQL, NOT THE FIRST LINE OF TEXT. A statement's
     * text begins immediately after the previous semicolon, so it opens with whatever
     * comment block precedes it — 057 has twelve-line explanations in front of most of
     * these. Reporting that offset put every line number in the artifact ten to twenty
     * lines above the statement it named, which is worse than useless to somebody trying
     * to find it.
     */
    const lines = raw.text.split(/\r?\n/);
    const excerptIndex = lines.findIndex((l) => l.trim() !== '' && !l.trim().startsWith('--'));
    const excerpt = excerptIndex === -1 ? '' : (lines[excerptIndex] as string).trim();
    const before = sql.slice(0, raw.offset);
    const line = (before.match(/\n/g) ?? []).length + 1 + (excerptIndex === -1 ? 0 : excerptIndex);
    return {
      ordinal: index + 1,
      line,
      verb,
      target,
      raises: verb === 'DO' && /RAISE\s+EXCEPTION/i.test(normalized),
      normalized,
      key: inventoryKey(normalized),
      excerpt: excerpt.slice(0, 120),
    };
  });
  // The guard runs on every parse, so a collision cannot reach an artifact.
  assertUniqueKeys(parsed.map((s) => s.key));
  return parsed;
}

/** A reconciliation: it changes retained rows, or it refuses to proceed. */
export function isReconciliation(s: Statement): boolean {
  return DML.has(s.verb) || s.raises;
}

/**
 * The statement each control removes, COMPUTED from its anchors rather than declared. This
 * is what makes control coverage impossible to overstate: the mapping is whatever the
 * runner will actually delete.
 */
export function controlCoverage(
  sql: string,
  controls: Control[] = CONTROLS,
  anchors: Record<string, ControlAnchor> = loadAnchors(),
): Map<string, string> {
  const byKey = new Map<string, string>();
  for (const control of controls) {
    const anchor = anchors[control.id];
    if (anchor === undefined) continue; // loadAnchors() already refuses this case
    const mutated = removeStatement(sql, control, anchor);
    // The removed span is the difference between the two texts, recovered the same way
    // the fixture-chain admission rule recovers it: one contiguous deletion.
    let prefix = 0;
    while (prefix < mutated.length && sql[prefix] === mutated[prefix]) prefix += 1;
    let suffix = 0;
    while (
      suffix < mutated.length - prefix &&
      sql[sql.length - 1 - suffix] === mutated[mutated.length - 1 - suffix]
    )
      suffix += 1;
    const removed = sql.slice(prefix, sql.length - suffix);
    byKey.set(inventoryKey(normalizeStatement(removed)), control.id);
  }
  return byKey;
}

export interface DeclaredEntry {
  key: string;
  classification: 'not-load-bearing' | 'refusal-guard';
  section: string;
  statement: string;
  reason: string;
}

interface InventoryFile {
  declared: DeclaredEntry[];
}

export function loadDeclarations(file = INVENTORY_FILE): DeclaredEntry[] {
  return (JSON.parse(readFileSync(file, 'utf8')) as InventoryFile).declared;
}

export interface InventoryRow {
  ordinal: number;
  line: number;
  verb: string;
  target: string;
  key: string;
  excerpt: string;
  classification: 'control' | 'not-load-bearing' | 'refusal-guard' | 'UNACCOUNTED';
  control_id?: string;
  section?: string;
  reason?: string;
}

/**
 * The published counts, as an EXACT shape rather than a string-keyed bag. That is not
 * fussiness: the delivery report quotes these numbers, `tests/ci-gates.test.ts` asserts the
 * buckets partition the reconciliations exactly, and a `Record<string, number>` makes every
 * one of those reads possibly-undefined — so the assertions would have had to be written
 * around the type instead of against the facts.
 */
export interface InventoryTotals {
  statements_in_057: number;
  reconciliations: number;
  reconciliations_covered_by_a_negative_control: number;
  reconciliations_declared_not_load_bearing: number;
  reconciliations_that_are_refusal_guards: number;
  reconciliations_unaccounted: number;
  ddl_statements_covered_by_a_negative_control: number;
  negative_controls_declared: number;
}

export interface InventoryResult {
  rows: InventoryRow[];
  problems: string[];
  totals: InventoryTotals;
}

/**
 * Builds the inventory and every problem with it. Pure, so the suite drives it without a
 * database and without a subprocess.
 */
export function buildInventory(
  sql: string = canonical057(),
  declarations: DeclaredEntry[] = loadDeclarations(),
  controls: Control[] = CONTROLS,
  anchors?: Record<string, ControlAnchor>,
): InventoryResult {
  const statements = parseStatements(sql);
  const coverage = controlCoverage(sql, controls, anchors);
  const declaredByKey = new Map(declarations.map((d) => [d.key, d]));
  const problems: string[] = [];
  const rows: InventoryRow[] = [];
  const usedDeclarations = new Set<string>();

  for (const s of statements) {
    const controlId = coverage.get(s.key);
    const declared = declaredByKey.get(s.key);
    if (controlId !== undefined && declared !== undefined) {
      problems.push(
        `statement ${s.ordinal} (line ${s.line}, ${s.excerpt}) is BOTH covered by control ` +
          `${controlId} and declared not-load-bearing. One of the two is wrong, and a reader ` +
          'would have to guess which.',
      );
    }
    if (declared !== undefined) usedDeclarations.add(s.key);

    if (!isReconciliation(s)) {
      // Reported for completeness; not required to be accounted for.
      if (controlId !== undefined)
        rows.push({
          ordinal: s.ordinal,
          line: s.line,
          verb: s.verb,
          target: s.target,
          key: s.key,
          excerpt: s.excerpt,
          classification: 'control',
          control_id: controlId,
        });
      continue;
    }

    if (controlId !== undefined) {
      rows.push({
        ordinal: s.ordinal,
        line: s.line,
        verb: s.verb,
        target: s.target,
        key: s.key,
        excerpt: s.excerpt,
        classification: 'control',
        control_id: controlId,
      });
    } else if (declared !== undefined) {
      rows.push({
        ordinal: s.ordinal,
        line: s.line,
        verb: s.verb,
        target: s.target,
        key: s.key,
        excerpt: s.excerpt,
        classification: declared.classification,
        section: declared.section,
        reason: declared.reason,
      });
      if (declared.classification === 'refusal-guard' && !s.raises)
        problems.push(
          `statement ${s.ordinal} (line ${s.line}) is declared a refusal-guard but does not ` +
            'RAISE — a guard that cannot refuse is not a guard',
        );
    } else {
      rows.push({
        ordinal: s.ordinal,
        line: s.line,
        verb: s.verb,
        target: s.target,
        key: s.key,
        excerpt: s.excerpt,
        classification: 'UNACCOUNTED',
      });
      problems.push(
        `statement ${s.ordinal} (line ${s.line}) is a reconciliation that nothing accounts ` +
          `for: ${s.verb}${s.target === '' ? '' : ' ' + s.target} — ${s.excerpt}. Give it a ` +
          'negative control, or declare it in architecture/reconciliation-inventory-057.json ' +
          `with the reason it cannot be exercised. Its key is ${s.key}.`,
      );
    }
  }

  for (const d of declarations)
    if (!usedDeclarations.has(d.key))
      problems.push(
        `the inventory declares ${d.statement} (key ${d.key}) but no statement in 057 has ` +
          'that key any more. A declaration that matches nothing would be read by the next ' +
          'reader as still in force.',
      );

  /*
   * THE TOTALS ARE SPLIT SO NO NUMBER CAN BE MISREAD AS A BIGGER CLAIM.
   *
   * `pd_evidence_version_floor` deletes a `CREATE TRIGGER`, which is DDL, not a
   * reconciliation. Counting it in one bucket labelled "covered by a control" made the
   * coverage number one higher than the number of RECONCILIATIONS covered, and a report
   * quoting it would have overstated exactly the thing §0.6 exists to correct. The
   * reconciliation buckets below sum to `reconciliations`; the DDL control is counted
   * separately and named.
   */
  const reconciliationRows = rows.filter(
    (r) =>
      statements[r.ordinal - 1] !== undefined &&
      isReconciliation(statements[r.ordinal - 1] as Statement),
  );
  const totals: InventoryTotals = {
    statements_in_057: statements.length,
    reconciliations: statements.filter(isReconciliation).length,
    reconciliations_covered_by_a_negative_control: reconciliationRows.filter(
      (r) => r.classification === 'control',
    ).length,
    reconciliations_declared_not_load_bearing: reconciliationRows.filter(
      (r) => r.classification === 'not-load-bearing',
    ).length,
    reconciliations_that_are_refusal_guards: reconciliationRows.filter(
      (r) => r.classification === 'refusal-guard',
    ).length,
    reconciliations_unaccounted: reconciliationRows.filter(
      (r) => r.classification === 'UNACCOUNTED',
    ).length,
    ddl_statements_covered_by_a_negative_control: rows.length - reconciliationRows.length,
    negative_controls_declared: controls.length,
  };

  return { rows, problems, totals };
}

function main(): void {
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

  const sql = canonical057();
  const result = buildInventory(sql);
  const artifact = {
    migration: '057_identity_boundary_completion.sql',
    migration_sha256_canonical_lf: digest(sql),
    key:
      '`stmt-<8 hex>-<8 hex>`: the literal prefix `stmt-` followed by the first and second ' +
      '8-hex-character groups of the sha256 of the whitespace-normalized statement text. ' +
      'The key is NOT that sha256 — an earlier revision of this artifact used the bare ' +
      '64-character digest, which gitleaks reads as a credential; see `inventoryKey` in ' +
      'scripts/reconciliation-inventory.ts.',
    totals: result.totals,
    inventory: result.rows,
    problems: result.problems,
  };
  if (out !== undefined) {
    writeFileSync(out, JSON.stringify(artifact, null, 2) + '\n');
    console.log(`inventory-written=${out}`);
  }

  const lines = [
    `migration=057_identity_boundary_completion.sql sha256=${artifact.migration_sha256_canonical_lf}`,
    '',
    ...result.rows.map(
      (r) =>
        `line=${String(r.line).padStart(4)} ${r.classification.padEnd(17)} ` +
        `${r.control_id ?? r.reason ?? ''}`.trim() +
        `\n              ${r.excerpt}`,
    ),
    '',
    `totals=${JSON.stringify(result.totals)}`,
  ];
  if (result.problems.length > 0) lines.push('', ...result.problems.map((p) => `PROBLEM: ${p}`));
  const text = lines.join('\n') + '\n';
  process.stdout.write(text);
  if (log !== undefined) writeFileSync(log, text);

  if (result.problems.length > 0) {
    console.error(
      `${result.problems.length} problem(s): the reconciliation inventory of 057 is not complete.`,
    );
    process.exitCode = 1;
  }
}

if (require.main === module) main();
