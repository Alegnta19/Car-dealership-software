/**
 * FBL-020-R3 correction E3 (hardened by H1) — the role-bindings effectiveness
 * rule may be WRITTEN in exactly one place, and this guard makes a second copy,
 * a neutralised copy, or SQL it cannot read fail the build.
 *
 *   npx tsx scripts/check-role-binding-effectiveness.ts [root-or-file...]
 *   (default roots: packages apps scripts)
 *
 * WHY THIS EXISTS. A role binding authorizes nothing unless it is `active` AND
 * inside its effective window — three conditions. Three separate defects in this
 * revision were the same shape: a second, hand-written copy of those conditions
 * that had silently dropped the window, so a binding left `active` with an
 * `effective_to` a day in the past passed one gate while the policy engine,
 * asked the same question about the same actor, refused. Wave 2 answered by
 * exporting the predicate ONCE, as `EFFECTIVE_ROLE_BINDING_SQL`; wave 2 then
 * shipped two more readers that restated it anyway. Review is evidently not a
 * reliable guard against this class, so the build is.
 *
 * HOW IT LOOKS AT CODE. TypeScript AST, plus THE SHARED STATIC STRING RESOLVER
 * in `scripts/static-string-resolver.ts` — the one implementation, imported by
 * `scripts/check-audit-inventory.ts` as well, because a second hand-written
 * string analysis is the drift shape this guard itself exists to refuse, one
 * level up. Every SQL literal is rendered by RESOLVING what its interpolations
 * actually refer to; that module's header states exactly which assembly forms
 * are resolved exactly, which are resolved as far as their input and then
 * reported, and what it cannot see. Two consequences matter here:
 *
 *   - a reference to the shared predicate is recognised by WHAT IT RESOLVES TO,
 *     so `${EFFECTIVE_ROLE_BINDING_SQL}`, `${policy.EFFECTIVE_ROLE_BINDING_SQL}`
 *     and `${EFFECTIVE}` from an aliased import are all the same thing, and none
 *     of them is a textual pattern this file matches;
 *   - a table name or a predicate fragment held in a constant is substituted
 *     before judging, so assembling the SQL out of pieces hides nothing.
 *
 * The shared predicate is the ONE thing deliberately NOT expanded: this file
 * PINS it, so it renders as an opaque mark. Its three conditions therefore never
 * appear as typed text, which is exactly the distinction the rules below turn on.
 *
 * WHAT IT CANNOT SEE, in the terms of THIS guard. The resolver's limits are its
 * own header's business; what they cost here is:
 *
 *   - VALUES CROSSING A FUNCTION BOUNDARY. `format('… FROM %s …',
 *     BINDINGS_TABLE)` is not recognised as SQL at the call site. What limits the
 *     damage is that the helper's OWN body is in scope: when it interpolates its
 *     parameter into a table position, rule 4 reports it there — PROVIDED the
 *     statement identifies itself as SQL by a second structural mark, because
 *     one mark alone would make `update ${label}` in prose a violation. Two
 *     marks qualify: a clause keyword (WHERE, SET, VALUES, JOIN, ON, ORDER BY,
 *     GROUP BY, RETURNING, LIMIT), or a SELECT LIST standing immediately before
 *     the blind `FROM`. A blind table position carrying NEITHER — `DELETE FROM
 *     ${table}` on its own, or `INSERT INTO ${table} SELECT … FROM audit_events`
 *     — is still not reported, and `docs/identity/KNOWN-LIMITATIONS.md` records
 *     that residue.
 *   - A DEPTH OR BREADTH OVERFLOW that touches the table is reported under rule
 *     4; a chain deeper than the limit renders as unresolvable.
 *   - SCOPE. The resolver merges same-named locals across functions, an
 *     over-approximation, so this guard can report more than the code does,
 *     never less.
 *
 * One consequence of the resolver resolving `String.raw` rather than skipping it:
 * the regular expressions in this repository that quote SQL keywords and name the
 * role-bindings table — including the ones in this file — are now INSPECTED, and
 * counted in the run's summary alongside real SQL. They pass, because a pattern
 * that spells backslash-s-plus contains no whitespace and therefore contains no
 * `FROM role_bindings` in the sense the rules mean.
 * `architecture/fixtures/role-binding-correct/raw-regex-is-not-sql.ts` is what
 * fails if that stops being true.
 *
 * WHAT IT ENFORCES.
 *
 *   1. role-binding-read-must-use-shared-predicate — a SQL literal that READS
 *      the role-bindings table (FROM/JOIN) must resolve the shared predicate
 *      into every one of those reads. Not "should filter somehow": the shared
 *      constant, so there is one text to change and one text to review. A use is
 *      BOUND TO THE READ IT FOLLOWS — the nearest read before it, or the first
 *      read when it precedes them all — and every read needs one bound to it. A
 *      GLOBAL count of uses against reads was a hole: interpolating the
 *      predicate twice into ONE read paid for a second, entirely unguarded read
 *      of the same table, which is the shape control 4 exists to refuse. The
 *      binding is positional and that is enough, because the shared predicate
 *      names the table by its canonical alias `rb`: at most one read in a
 *      statement can be the read it constrains, so a statement that reaches the
 *      table twice needs a declared exception rather than a second
 *      interpolation. A use sitting in a SELECT LIST is not counted at all — it
 *      filters nothing — and is reported under rule 3.
 *   2. role-binding-effectiveness-must-not-be-restated — no SQL literal
 *      touching the role-bindings table may compare that table's own `status`,
 *      `effective_from` or `effective_to`. This is the drift itself, and it is
 *      banned in reads and writes alike. Projections are untouched: only a
 *      COMPARISON counts, and the SET list of an UPDATE (an assignment, not a
 *      filter) is removed before matching.
 *   3. role-binding-effectiveness-must-not-be-weakened — the resolved predicate
 *      must be CONJOINED, and this rule enforces that by reading the TEXT around
 *      the resolved mark, not by reasoning about boolean algebra. SQL comments
 *      are stripped first, so none of the four spellings below can be carried
 *      past the rule by a `--` or a `/* … *\/` between the predicate and the
 *      operator. What is enforced, exactly:
 *        (i)   an OR ADJACENT on either side (`(${…} OR TRUE)`,
 *              `(${…} OR rb.is_system)`);
 *        (ii)  a NOT directly in front of it, or a NOT introducing ANY
 *              parenthesised group that encloses it — so De Morgan's
 *              `NOT (rb.is_system AND ${…})` is a negation too;
 *        (iii) a comparison applied to it instead of a conjunction — exactly
 *              `IS NOT TRUE`, `IS [NOT] FALSE`, `IS [NOT] NULL`,
 *              `IS [NOT] UNKNOWN`, `IS [NOT] DISTINCT FROM`, `= FALSE`,
 *              `<> TRUE`, `!= TRUE`. `IS TRUE` is absent on purpose: it changes
 *              nothing and is not a weakening;
 *        (iv)  the predicate placed in a SELECT LIST, where it is computed as a
 *              returned column and filters nothing.
 *      What is NOT enforced: a rewrite that leaves the predicate conjoined-
 *      LOOKING while discarding its result — a CASE arm
 *      (`CASE WHEN ${…} THEN TRUE ELSE TRUE END`), a wrapper function, a
 *      subquery whose value is thrown away. This rule reads text; it does not
 *      evaluate SQL, and `docs/identity/KNOWN-LIMITATIONS.md` records that.
 *      No opt-out excuses what it does catch: no reason code lists this rule.
 *   4. role-binding-sql-not-statically-resolvable — SILENCE IS A FAILURE WHERE
 *      THERE IS SOMETHING TO BE SILENT ABOUT. Precisely: a rendered statement is
 *      reported when part of it could not be resolved AND either one of its
 *      possible renderings reaches the role-bindings table, or its TABLE POSITION
 *      is filled by something this file cannot resolve — so it cannot tell
 *      whether the statement reads role_bindings at all. "I could not tell" used
 *      to render as "0 statements inspected, OK"; it is now a violation that
 *      requires a declared, reviewed exception. Note the conjunction: a string
 *      this guard cannot resolve AT ALL, with nothing in it that names the table
 *      and nothing occupying a table position, is NOT reported — it is not
 *      recognisable as SQL, and reporting every unresolvable string in the
 *      repository would make the rule unusable. WHAT IT CANNOT SEE, above, says
 *      where that lands.
 *   5. role-binding-predicate-must-be-declared-once — `EFFECTIVE_ROLE_BINDING_SQL`
 *      may be declared only in its home file. A second declaration of that name
 *      is a second copy of the rule, and it would also let a shadowed local
 *      constant pose as the shared one.
 *   6. role-binding-effectiveness-canonical — the shared constant still exists,
 *      is exported, and still names all three conditions. A guard that only
 *      forbade copies would be satisfied by gutting the original.
 *
 * THE DEFINITION SITE is exempt from 1 and 2 by construction: the initializer of
 * the `EFFECTIVE_ROLE_BINDING_SQL` declaration is skipped, because that IS the
 * one permitted copy and rule 6 audits its content instead.
 *
 * EXCEPTIONS ARE STRUCTURED, CLOSED AND VALIDATED. Write, in a comment on the
 * SQL literal or on the statement that issues it:
 *
 *     // role-binding-effectiveness-opt-out(<reason-code>): <justification>
 *
 * The reason code must be one of a CLOSED set (`OPT_OUT_CODES` below); prose
 * alone is not an exception. Each code excuses only the rules it can excuse and
 * only in the files where it can apply, and each still requires a justification
 * of real length. Every opt-out in force is printed, with its code, on every
 * run, so one more of them is visible in review.
 *
 * SCOPE. TypeScript under `packages`, `apps` and `scripts` — the code that
 * decides and the code that operates. Two things sit outside, both on purpose:
 *
 *   - `tests`, because the suite is this guard's counter-party and must be free
 *     to construct ineffective bindings and observe them directly, which is how
 *     the fixes this guard protects are proved;
 *   - `migrations/*.sql`, because a migration reconciles rows as they are — it
 *     necessarily reads bindings the engine would not match, and it cannot
 *     interpolate a TypeScript constant in the first place.
 *
 * `String.raw` used to be a third exemption, on the reasoning that raw templates
 * build regular expressions here. It was also an undeclared, unvalidated,
 * one-token off switch for real SQL, needing no reason code and no justification
 * — the opposite of what the structured opt-out is for. It is gone.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import * as ts from 'typescript';
import {
  UNRESOLVABLE_MARK,
  createStaticStringResolver,
  isFile,
  typeScriptSources,
} from './static-string-resolver';

const ROOT = join(__dirname, '..');
const DEFAULT_ROOTS = ['packages', 'apps', 'scripts'];

/** The one permitted copy of the rule, and where it must live. */
const SHARED_PREDICATE = 'EFFECTIVE_ROLE_BINDING_SQL';
const SHARED_PREDICATE_FILE = 'packages/identity-access/src/policy.ts';

/**
 * What a resolved reference to the shared predicate renders as. It must contain
 * neither the table name nor any guarded column name, so that substituting it
 * cannot trip the rules that look for those.
 */
const GUARD_MARK = 'SHARED_EFFECTIVENESS_PREDICATE';
/** What an interpolation whose value cannot be determined renders as. */
const UNKNOWN_MARK = UNRESOLVABLE_MARK;

/**
 * THE SHARED RESOLVER, configured for this guard: the shared predicate is PINNED,
 * so it renders as `GUARD_MARK` instead of being expanded into its three
 * conditions. Identity, not text — `${EFFECTIVE}` from an aliased import is the
 * same pin as `${policy.EFFECTIVE_ROLE_BINDING_SQL}`.
 */
const RESOLVER = createStaticStringResolver({
  root: ROOT,
  pinned: (node, mod, api) => {
    const decl = api.resolveReference(node, mod);
    return decl !== undefined &&
      decl.mod.rel === SHARED_PREDICATE_FILE &&
      decl.name === SHARED_PREDICATE
      ? GUARD_MARK
      : undefined;
  },
});

const RULE_READ = 'role-binding-read-must-use-shared-predicate';
const RULE_RESTATED = 'role-binding-effectiveness-must-not-be-restated';
const RULE_WEAKENED = 'role-binding-effectiveness-must-not-be-weakened';
const RULE_UNRESOLVABLE = 'role-binding-sql-not-statically-resolvable';
const RULE_DECLARED_ONCE = 'role-binding-predicate-must-be-declared-once';
const RULE_CANONICAL = 'role-binding-effectiveness-canonical';

/** The table this guard is about, and the marks of SQL rather than prose. */
const TABLE = /\brole_bindings\b/i;
const SQL_SHAPE = /\b(?:SELECT|INSERT|UPDATE|DELETE|WITH|FROM|JOIN)\b/i;

/**
 * How the table is addressed: a write names it, a read reaches it. A schema
 * qualifier is tolerated — `public.role_bindings` is the same table, and a
 * pattern that only matched the bare name would let the qualified spelling
 * carry a hand-written predicate straight past this guard.
 */
const QUALIFIED = String.raw`(?:[a-z_][a-z0-9_]*\.)?role_bindings\b`;
const WRITE_TARGET = new RegExp(
  String.raw`\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+${QUALIFIED}`,
  'i',
);
const READ_SOURCE = new RegExp(String.raw`\b(?:FROM|JOIN)\s+${QUALIFIED}`, 'gi');

/** The alias bound to the table, if the SQL gives it one. */
const ALIAS = new RegExp(
  String.raw`\b(?:FROM|JOIN|UPDATE|INTO)\s+${QUALIFIED}\s+(?:AS\s+)?([a-z_][a-z0-9_]*)`,
  'i',
);
const NOT_AN_ALIAS = new Set([
  'where',
  'set',
  'values',
  'on',
  'using',
  'join',
  'inner',
  'left',
  'right',
  'full',
  'cross',
  'order',
  'group',
  'having',
  'limit',
  'offset',
  'returning',
  'and',
  'or',
  'select',
  'as',
]);

/** The three columns the effectiveness rule is written in terms of. */
const GUARDED_COLUMNS = 'status|effective_from|effective_to';
/** A cast is allowed to sit between the column and the operator. */
const COMPARISON = String.raw`(?:::[a-z_]+)?\s*(?:=|!=|<>|<=|>=|<|>|\bIS\b|\bIN\b|\bNOT\b|\bBETWEEN\b|\bLIKE\b)`;

/**
 * A table position filled by something unresolvable: the guard cannot tell which
 * table this statement touches.
 */
const UNKNOWN_TABLE_POSITION = new RegExp(
  String.raw`\b(?:FROM|JOIN|INSERT\s+INTO|INTO|UPDATE|DELETE\s+FROM)\s+\(?\s*${UNKNOWN_MARK}_\d+`,
  'i',
);
/**
 * Two structural marks, required before an unresolvable table position is
 * reported: prose ("update ${name}") must not be mistaken for a statement. The
 * second mark is EITHER a clause only SQL writes, OR a SELECT LIST standing
 * immediately before the blind `FROM`. The second form is not decoration: a
 * helper's `SELECT id, role, user_link_id, tenant_id FROM ${table}` is an
 * unguarded full-table read that carries no clause at all, and requiring one
 * used to report it nowhere.
 */
const SQL_VERB = /\b(?:SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|WITH)\b/i;
const SQL_CLAUSE = /\b(?:WHERE|SET|VALUES|JOIN|ON|ORDER\s+BY|GROUP\s+BY|RETURNING|LIMIT)\b/i;
/**
 * A projection item: `*`, or a name, optionally called, cast and aliased.
 * Deliberately intolerant of the spaces English puts between words, so that
 * `SELECT COUNT(*)::int AS cnt FROM ${table}` is a statement and "Select a
 * vehicle from ${dealership}" is a sentence.
 */
const PROJECTION_ITEM = String.raw`(?:\*|[a-z_][a-z0-9_."]*(?:\s*\([^()]*\))?(?:\s*::\s*[a-z_][a-z0-9_]*(?:\[\])?)?(?:\s+AS\s+[a-z_][a-z0-9_]*)?)`;
const SELECT_LIST_THEN_UNKNOWN_TABLE = new RegExp(
  String.raw`\bSELECT\s+(?:DISTINCT\s+)?${PROJECTION_ITEM}(?:\s*,\s*${PROJECTION_ITEM})*\s+FROM\s+\(?\s*${UNKNOWN_MARK}_\d+`,
  'i',
);

/** A structured opt-out: a code from the closed set, then a justification. */
const OPT_OUT = /role-binding-effectiveness-opt-out\s*(?:\(\s*([a-z][a-z0-9-]*)\s*\))?\s*:/i;
const OPT_OUT_MIN_REASON = 40;
const OPT_OUT_MIN_WORDS = 8;

interface ReasonCode {
  /** What the category IS — printed when a code is rejected. */
  readonly summary: string;
  /** The rules this category can excuse, and no others. */
  readonly excuses: readonly string[];
  /** Where the category can apply, when it is inherently local. */
  readonly onlyIn: RegExp | null;
}

/**
 * THE CLOSED SET. Legitimate exceptions are narrow and all of one kind: SQL that
 * deliberately reaches bindings the engine would NOT match, or SQL this file
 * cannot read. "Effective" is never a legitimate reason; that is what the
 * constant is for, and there is no code for it.
 */
const OPT_OUT_CODES: Record<string, ReasonCode> = {
  'predicate-definition': {
    summary:
      'the shared predicate’s own definition site, where the rule is legitimately written out',
    excuses: [RULE_READ, RULE_RESTATED],
    onlyIn: new RegExp(`^${SHARED_PREDICATE_FILE.replace(/[.]/g, '[.]')}$`),
  },
  'migration-reconciliation': {
    summary:
      'reconciliation SQL that reads rows AS THEY ARE, because it is repairing them rather than authorizing anything',
    excuses: [RULE_READ, RULE_RESTATED],
    onlyIn: /(^|\/)migrat/i,
  },
  'all-bindings-including-ineffective': {
    summary:
      'SQL that must address EVERY binding including the ineffective ones — an administrative listing, a revocation or a revocation sweep, a lifecycle write naming one row by id, an existence probe — because skipping an ineffective row would leave a standing grant behind or duplicate a unique one',
    excuses: [RULE_READ, RULE_RESTATED],
    onlyIn: null,
  },
  'unresolvable-sql-hand-reviewed': {
    summary:
      'SQL whose table or predicate is supplied by a caller, so no static reading of this file can decide what it addresses; a reviewer has confirmed what it can be pointed at',
    excuses: [RULE_UNRESOLVABLE],
    onlyIn: null,
  },
};

interface Violation {
  file: string;
  line: number;
  rule: string;
  detail: string;
}

interface OptOutRecord {
  file: string;
  line: number;
  code: string;
  reason: string;
}

// ── the rules ─────────────────────────────────────────────────────────────

/**
 * SQL comments, removed before anything is judged. Nothing inside one executes,
 * so nothing inside one is a read, a restatement or a conjunction — and a
 * comment sitting between the resolved predicate and an `OR` would otherwise
 * carry that `OR` past rule 3, which looks at what is ADJACENT to the predicate.
 */
function withoutSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\r\n]*/g, ' ');
}

/** The SET list of an UPDATE assigns; it does not filter. */
function withoutAssignments(sql: string): string {
  if (!/^\s*UPDATE\b/i.test(sql)) return sql;
  return sql.replace(/\bSET\b[\s\S]*?(?=\bWHERE\b|\bRETURNING\b|$)/i, ' ');
}

/** Is this literal the one permitted copy of the rule? */
function isDefinitionSite(node: ts.Node): boolean {
  const parent = node.parent;
  return (
    parent !== undefined &&
    ts.isVariableDeclaration(parent) &&
    ts.isIdentifier(parent.name) &&
    parent.name.text === SHARED_PREDICATE
  );
}

const TAUTOLOGIES: Array<{ label: string; re: RegExp }> = [
  { label: 'TRUE', re: /\bTRUE\b/i },
  { label: 'NOT FALSE', re: /\bNOT\s+FALSE\b/i },
  { label: 'a numeric identity (1=1)', re: /\b(\d+)\s*=\s*\1\b/ },
  { label: 'a string identity', re: /('[^']*')\s*=\s*\1/ },
];

/**
 * A predicate applied to the whole of a parenthesised group rather than to the
 * mark itself: `NOT (rb.is_system AND ${…})` is De Morgan's spelling of
 * `NOT rb.is_system OR NOT ${…}`, and nothing adjacent to the mark says so. One
 * backward pass through the groups that ENCLOSE the mark closes that spelling.
 */
function negatedByEnclosingGroup(sql: string, at: number): boolean {
  let depth = 0;
  for (let i = at - 1; i >= 0; i -= 1) {
    const ch = sql.charAt(i);
    if (ch === ')') depth += 1;
    else if (ch === '(') {
      if (depth > 0) depth -= 1;
      else if (/\bNOT\s*$/i.test(sql.slice(Math.max(0, i - 40), i))) return true;
    }
  }
  return false;
}

/**
 * The predicate COMPARED rather than conjoined. `(${…}) IS NOT TRUE` selects
 * precisely the bindings the predicate exists to withhold, and `IS NULL`,
 * `IS DISTINCT FROM` and `= FALSE` are the same move in other spellings. `IS
 * TRUE` is absent on purpose: it changes nothing and is not a weakening.
 */
const COMPARED_AWAY =
  /^\s*\)*\s*(IS\s+NOT\s+TRUE|IS\s+(?:NOT\s+)?FALSE|IS\s+(?:NOT\s+)?NULL|IS\s+(?:NOT\s+)?UNKNOWN|IS\s+(?:NOT\s+)?DISTINCT\s+FROM|=\s*FALSE|<>\s*TRUE|!=\s*TRUE)/i;

/**
 * Rule 3. The resolved predicate must be CONJOINED. An OR beside it, a NOT over
 * it, or a comparison applied to it hands back the authority it exists to
 * withhold — and a count of reads against uses would otherwise call that
 * compliant.
 */
function weakenings(sql: string): string[] {
  const flaws: string[] = [];
  for (let at = sql.indexOf(GUARD_MARK); at !== -1; at = sql.indexOf(GUARD_MARK, at + 1)) {
    const before = sql.slice(Math.max(0, at - 160), at);
    const after = sql.slice(at + GUARD_MARK.length, at + GUARD_MARK.length + 160);
    const named = (side: string): string => {
      const hit = TAUTOLOGIES.find((t) => t.re.test(side.slice(0, 40)));
      return hit === undefined ? '' : ` with ${hit.label}`;
    };
    if (/^\s*\)*\s*OR\b/i.test(after)) {
      flaws.push(`the shared predicate is the LEFT operand of an OR${named(after)}`);
    }
    if (/\bOR\s*\(*\s*$/i.test(before)) {
      flaws.push(`the shared predicate is the RIGHT operand of an OR${named(before.slice(-40))}`);
    }
    if (/\bNOT\s*\(*\s*$/i.test(before) || negatedByEnclosingGroup(sql, at)) {
      flaws.push('the shared predicate is NEGATED');
    }
    const compared = COMPARED_AWAY.exec(after);
    if (compared !== null) {
      const spelling = String(compared[1] ?? compared[0])
        .replace(/\s+/g, ' ')
        .toUpperCase();
      flaws.push(`the shared predicate is COMPARED rather than conjoined (${spelling})`);
    }
  }
  return [...new Set(flaws)];
}

/**
 * The SELECT lists of a statement — from each `SELECT` to the `FROM` that
 * follows it. A resolved predicate inside one is a returned COLUMN: it is
 * computed for every row and filters none of them. A `SELECT` with no `FROM`
 * after it opens no range, because it reads no table and so guards nothing.
 */
function projectionRanges(sql: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const selects = /\bSELECT\b/gi;
  for (let m = selects.exec(sql); m !== null; m = selects.exec(sql)) {
    const start = m.index + m[0].length;
    const from = /\bFROM\b/i.exec(sql.slice(start));
    if (from !== null) ranges.push([start, start + from.index]);
  }
  return ranges;
}

interface Placement {
  /** Reads of the role-bindings table. */
  readonly reads: number;
  /** Resolved uses of the shared predicate that are in a position to filter. */
  readonly filtering: number;
  /** Resolved uses sitting in a SELECT list, which filter nothing. */
  readonly projected: number;
  /** Reads with no filtering use bound to them. */
  readonly unguarded: number;
}

/**
 * Rule 1's arithmetic. A use is BOUND TO THE READ IT FOLLOWS — the nearest read
 * before it, or the first read when it precedes them all — and every read needs
 * one bound to it.
 *
 * Counting uses globally instead was a hole with a fixture already pointed at
 * it: interpolating the predicate TWICE into one read paid for a second,
 * entirely unguarded read of the same table, which is exactly what control 4
 * (`guardedOnceReadTwice`) exists to refuse. Binding is positional, and it can
 * be: the shared predicate names the table by its canonical alias `rb`, so at
 * most one read in a statement can be the one it constrains, and a statement
 * that reaches the table twice needs a declared exception rather than a second
 * interpolation.
 */
function placeGuards(sql: string): Placement {
  const reads = [...sql.matchAll(READ_SOURCE)].map((m) => m.index ?? 0);
  const projection = projectionRanges(sql);
  const filtering: number[] = [];
  let projected = 0;
  for (let at = sql.indexOf(GUARD_MARK); at !== -1; at = sql.indexOf(GUARD_MARK, at + 1)) {
    if (projection.some(([from, to]) => at >= from && at < to)) projected += 1;
    else filtering.push(at);
  }
  const covered = new Set<number>();
  for (const guard of filtering) {
    let owner: number | undefined;
    for (const read of reads) {
      if (read < guard) owner = read;
      else break;
    }
    if (owner === undefined) owner = reads[0];
    if (owner !== undefined) covered.add(owner);
  }
  return {
    reads: reads.length,
    filtering: filtering.length,
    projected,
    unguarded: reads.filter((r) => !covered.has(r)).length,
  };
}

/** Rules 1, 2 and 3, judged on ONE of the statements this literal could be. */
function judgeVariant(raw: string, file: string, line: number): Violation[] {
  const found: Violation[] = [];
  const sql = withoutSqlComments(raw);
  const filters = withoutAssignments(sql);
  const isWrite = WRITE_TARGET.test(sql);
  // Bound, not merely counted: a statement that reaches the table TWICE and
  // resolves the predicate twice into ONE of those reads still has an unguarded
  // read in it, and "as many uses as reads" would have called that compliant.
  const placed = placeGuards(filters);
  if (!isWrite && placed.unguarded > 0) {
    found.push({
      file,
      line,
      rule: RULE_READ,
      detail:
        `${placed.reads} read(s) of the role-bindings table, ` +
        `${placed.filtering} resolved use(s) of ${SHARED_PREDICATE} — every read needs one` +
        (placed.unguarded === placed.reads
          ? ''
          : `, and ${placed.unguarded} of them has none bound to it: a use is bound to the read it follows`) +
        (placed.projected > 0
          ? ` (a further ${placed.projected} use(s) sit in a SELECT list, where they filter nothing)`
          : ''),
    });
  }
  if (placed.projected > 0) {
    found.push({
      file,
      line,
      rule: RULE_WEAKENED,
      detail:
        'the shared predicate sits in a SELECT LIST — it is computed as a returned column for every row and filters none of them',
    });
  }

  const alias = ALIAS.exec(sql)?.[1];
  const restated: string[] = [];
  if (alias !== undefined && !NOT_AN_ALIAS.has(alias.toLowerCase())) {
    const qualified = new RegExp(String.raw`\b${alias}\.(${GUARDED_COLUMNS})${COMPARISON}`, 'gi');
    for (const m of filters.matchAll(qualified)) restated.push(`${alias}.${String(m[1])}`);
  }
  const unqualified = new RegExp(String.raw`(?<![\w.$])(${GUARDED_COLUMNS})${COMPARISON}`, 'gi');
  for (const m of filters.matchAll(unqualified)) restated.push(String(m[1]));
  if (restated.length > 0) {
    found.push({
      file,
      line,
      rule: RULE_RESTATED,
      detail: `hand-written role-bindings effectiveness filter on ${[...new Set(restated)].join(
        ', ',
      )} — resolve ${SHARED_PREDICATE} instead`,
    });
  }

  for (const flaw of weakenings(filters)) {
    found.push({ file, line, rule: RULE_WEAKENED, detail: flaw });
  }
  return found;
}

// ── opt-outs ──────────────────────────────────────────────────────────────

interface OptOut {
  readonly code: string | null;
  readonly reason: string;
  readonly line: number;
}

/**
 * The opt-out declaration, if one is attached to this SQL or to the statement
 * that issues it. Nothing further out counts: an exception has to be written
 * where the exceptional SQL is, not somewhere up the file where a reader would
 * miss it.
 */
function optOutDeclaration(node: ts.Node, sf: ts.SourceFile): OptOut | null {
  const full = sf.getFullText();
  for (let current: ts.Node | undefined = node; current !== undefined; current = current.parent) {
    const ranges = ts.getLeadingCommentRanges(full, current.getFullStart()) ?? [];
    for (let i = 0; i < ranges.length; i += 1) {
      const first = ranges[i];
      if (first === undefined) continue;
      const match = OPT_OUT.exec(full.slice(first.pos, first.end));
      if (match === null) continue;
      // The justification is everything the comment says after the marker. `//`
      // lines arrive as one range each, so the rest of the block is joined back
      // together — a multi-line justification is read whole and reproduced whole
      // in the run's output, where a reviewer will see it.
      const body = ranges
        .slice(i)
        .map((r) => full.slice(r.pos, r.end))
        .join('\n');
      const reason = body
        .slice(match.index + match[0].length)
        .replace(/\*\/\s*$/, '')
        .split(/\r?\n/)
        .map((l) => l.replace(/^\s*(?:\/\/|\*)?\s?/, ''))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      return {
        code: match[1] === undefined ? null : match[1].toLowerCase(),
        reason,
        line: sf.getLineAndCharacterOfPosition(first.pos).line + 1,
      };
    }
    if (ts.isStatement(current)) break;
  }
  return null;
}

const CODE_LIST = Object.keys(OPT_OUT_CODES).join(', ');

/**
 * Splits what the opt-out excuses from what it does not, and reports the
 * declaration itself when it is not a valid one. An opt-out that names no
 * recognised category excuses nothing.
 */
function applyOptOut(
  found: Violation[],
  optOut: OptOut | null,
  file: string,
): { violations: Violation[]; record: OptOutRecord | null } {
  if (optOut === null) return { violations: found, record: null };
  const at = { file, line: optOut.line };
  if (optOut.code === null) {
    return {
      violations: [
        {
          ...at,
          rule: 'role-binding-effectiveness-opt-out-must-name-a-reason-code',
          detail: `write role-binding-effectiveness-opt-out(<code>): … with one of: ${CODE_LIST}`,
        },
      ],
      record: null,
    };
  }
  const code = OPT_OUT_CODES[optOut.code];
  if (code === undefined) {
    return {
      violations: [
        {
          ...at,
          rule: 'role-binding-effectiveness-opt-out-reason-code-unrecognised',
          detail: `"${optOut.code}" is not an exception category; the closed set is: ${CODE_LIST}`,
        },
      ],
      record: null,
    };
  }
  if (code.onlyIn !== null && !code.onlyIn.test(file)) {
    return {
      violations: [
        {
          ...at,
          rule: 'role-binding-effectiveness-opt-out-reason-code-not-applicable-here',
          detail: `"${optOut.code}" is ${code.summary}, which this file is not`,
        },
      ],
      record: null,
    };
  }
  const words = optOut.reason.split(/\s+/).filter((w) => /[a-z]/i.test(w)).length;
  if (optOut.reason.length < OPT_OUT_MIN_REASON || words < OPT_OUT_MIN_WORDS) {
    return {
      violations: [
        {
          ...at,
          rule: 'role-binding-effectiveness-opt-out-unjustified',
          detail: `${optOut.reason.length} character(s), ${words} word(s); state WHY this SQL must reach bindings the engine would not match (min ${OPT_OUT_MIN_REASON} characters, ${OPT_OUT_MIN_WORDS} words)`,
        },
      ],
      record: null,
    };
  }
  const excused = found.filter((v) => code.excuses.includes(v.rule));
  const remaining = found.filter((v) => !code.excuses.includes(v.rule));
  if (excused.length === 0) {
    return {
      violations: [
        ...remaining,
        {
          ...at,
          rule: 'role-binding-effectiveness-opt-out-excuses-nothing',
          detail: `"${optOut.code}" can excuse ${code.excuses.join(', ')}; this SQL raises ${
            found.length === 0 ? 'nothing' : [...new Set(found.map((v) => v.rule))].join(', ')
          }`,
        },
      ],
      record: null,
    };
  }
  return {
    violations: remaining,
    record: { file, line: optOut.line, code: optOut.code, reason: optOut.reason },
  };
}

// ── one file ──────────────────────────────────────────────────────────────

interface FileResult {
  violations: Violation[];
  inspected: number;
  optOuts: OptOutRecord[];
}

function checkFile(abs: string): FileResult {
  const mod = RESOLVER.loadModule(abs);
  const result: FileResult = { violations: [], inspected: 0, optOuts: [] };
  if (mod === null) return result;
  const rel = mod.rel;
  const sf = mod.sf;

  const visit = (node: ts.Node): void => {
    // Rule 5: the shared predicate is declared in exactly one file.
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === SHARED_PREDICATE &&
      rel !== SHARED_PREDICATE_FILE
    ) {
      result.violations.push({
        file: rel,
        line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
        rule: RULE_DECLARED_ONCE,
        detail: `a second declaration of ${SHARED_PREDICATE} — it belongs only in ${SHARED_PREDICATE_FILE}, and a local one is a second copy of the rule rather than a use of it`,
      });
    }

    // A statement is judged WHERE IT IS ASSEMBLED — the shared resolver's own
    // definition of an assembly point, so `[HEAD, TABLE, TAIL].join('')` (which
    // names the table in one piece and says SELECT in another, and no piece of
    // which is SQL) is one statement here rather than three fragments.
    if (!RESOLVER.isAssemblyPoint(node, mod) || isDefinitionSite(node)) {
      ts.forEachChild(node, visit);
      return;
    }
    const rendered = RESOLVER.render(node, mod);
    if (rendered === undefined) {
      ts.forEachChild(node, visit);
      return;
    }

    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    const shaped = rendered.variants.filter((v) => SQL_SHAPE.test(v));
    const touching = shaped.filter((v) => TABLE.test(v));
    // "I could not tell" is a failure, not a pass: either the statement reaches
    // the table and part of it is opaque, or its TABLE POSITION itself is opaque
    // so this file cannot say which table it reaches.
    const blindTable = shaped.some(
      (v) =>
        UNKNOWN_TABLE_POSITION.test(v) &&
        SQL_VERB.test(v) &&
        (SQL_CLAUSE.test(v) || SELECT_LIST_THEN_UNKNOWN_TABLE.test(v)),
    );
    const opaque =
      (rendered.overflowed || rendered.unresolved.length > 0) &&
      (touching.length > 0 || blindTable);

    if (touching.length === 0 && !opaque) {
      ts.forEachChild(node, visit);
      return;
    }

    result.inspected += 1;
    const found: Violation[] = [];
    const seenDetail = new Set<string>();
    for (const variant of touching) {
      for (const violation of judgeVariant(variant, rel, line)) {
        const key = `${violation.rule}|${violation.detail}`;
        if (seenDetail.has(key)) continue;
        seenDetail.add(key);
        found.push(violation);
      }
    }
    if (opaque) {
      found.push({
        file: rel,
        line,
        rule: RULE_UNRESOLVABLE,
        detail: rendered.overflowed
          ? 'too many possible statements to judge them all — this guard cannot decide whether every read is guarded'
          : `cannot resolve ${[...new Set(rendered.unresolved)]
              .map((u) => `\`${u}\``)
              .join(
                ', ',
              )} — this guard cannot decide whether this statement reads role_bindings unguarded`,
      });
    }

    if (found.length > 0) {
      const applied = applyOptOut(found, optOutDeclaration(node, sf), rel);
      result.violations.push(...applied.violations);
      if (applied.record !== null) result.optOuts.push(applied.record);
    }
    // A statement is judged once, whole: its own pieces are not re-judged.
  };
  visit(sf);
  return result;
}

/** Rule 6: the one permitted copy still exists, is exported, and says all three things. */
function checkCanonicalPredicate(): Violation[] {
  const abs = join(ROOT, SHARED_PREDICATE_FILE);
  const rel = SHARED_PREDICATE_FILE;
  if (!isFile(abs)) {
    return [
      {
        file: rel,
        line: 0,
        rule: RULE_CANONICAL,
        detail: `the shared predicate's home file is missing — ${SHARED_PREDICATE} must be defined here`,
      },
    ];
  }
  const text = readFileSync(abs, 'utf8');
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.ES2022, true);
  let body: string | undefined;
  let exported = false;
  let line = 0;
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === SHARED_PREDICATE &&
      node.initializer !== undefined
    ) {
      const literal = node.initializer;
      body =
        ts.isNoSubstitutionTemplateLiteral(literal) || ts.isStringLiteral(literal)
          ? literal.text
          : literal.getText(sf);
      line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      const statement = node.parent.parent;
      exported =
        ts.isVariableStatement(statement) &&
        (statement.modifiers ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (body === undefined) {
    return [
      {
        file: rel,
        line: 0,
        rule: RULE_CANONICAL,
        detail: `${SHARED_PREDICATE} is not declared here any more — every reader resolves it from this file`,
      },
    ];
  }
  if (!exported) {
    return [
      {
        file: rel,
        line,
        rule: RULE_CANONICAL,
        detail: `${SHARED_PREDICATE} is no longer exported — a predicate no reader can reach is a predicate every reader will restate`,
      },
    ];
  }
  const missing = (['status', 'effective_from', 'effective_to'] as const).filter(
    (column) => !new RegExp(String.raw`\.${column}\b`).test(body as string),
  );
  if (missing.length > 0 || !/NOW\(\)/i.test(body)) {
    return [
      {
        file: rel,
        line,
        rule: RULE_CANONICAL,
        detail: `${SHARED_PREDICATE} no longer states ${
          missing.length > 0 ? missing.join(', ') : 'a NOW() bound'
        } — a binding authorizes nothing unless it is active AND inside its window`,
      },
    ];
  }
  return [];
}

function main(): void {
  const args = process.argv.slice(2);
  const roots = args.length > 0 ? args : DEFAULT_ROOTS;
  const violations: Violation[] = [...checkCanonicalPredicate()];
  const optOuts: OptOutRecord[] = [];
  let inspected = 0;
  for (const root of roots) {
    for (const file of typeScriptSources(join(ROOT, root))) {
      const r = checkFile(file);
      violations.push(...r.violations);
      optOuts.push(...r.optOuts);
      inspected += r.inspected;
    }
  }
  if (violations.length > 0) {
    for (const v of violations) {
      console.error(`  error ${v.rule}: ${v.file}:${v.line} ${v.detail}`);
    }
    console.error(`role-bindings effectiveness guard FAILED: ${violations.length} violation(s)`);
    process.exit(1);
  }
  for (const o of optOuts) {
    console.log(`  opt-out ${o.file}:${o.line} [${o.code}] — ${o.reason}`);
  }
  console.log(
    `role-bindings effectiveness guard OK (${roots.join(' ')}): ${inspected} statement(s) inspected, ${optOuts.length} declared opt-out(s), one shared predicate`,
  );
}

main();
