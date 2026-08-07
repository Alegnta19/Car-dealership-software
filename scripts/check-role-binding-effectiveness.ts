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
 * HOW IT LOOKS AT CODE. TypeScript AST, plus a small STATIC EVALUATOR. Every
 * SQL literal is rendered by RESOLVING what its interpolations actually refer
 * to — through local `const`s, object and array literals, array indexing,
 * destructuring, `for … of` element bindings, `?:`/`??`/`||` alternatives, and
 * named, aliased, namespaced and re-exported imports across files. An
 * expression may resolve to SEVERAL possible strings (a table name taken from a
 * lookup map, or a loop over a list of table names); every possibility is
 * rendered and every possibility is judged. Two consequences matter:
 *
 *   - a reference to the shared predicate is recognised by WHAT IT RESOLVES TO,
 *     so `${EFFECTIVE_ROLE_BINDING_SQL}`, `${policy.EFFECTIVE_ROLE_BINDING_SQL}`
 *     and `${EFFECTIVE}` from an aliased import are all the same thing, and none
 *     of them is a textual pattern this file matches;
 *   - a table name or a predicate fragment held in a constant is substituted
 *     before judging, so assembling the SQL out of pieces hides nothing.
 *
 * The shared predicate is the ONE thing deliberately NOT expanded: it renders as
 * an opaque mark. Its three conditions therefore never appear as typed text,
 * which is exactly the distinction the rules below turn on.
 *
 * WHERE A STATEMENT IS JUDGED. Not "at every string literal" — at every point a
 * string is ASSEMBLED, because the drift shape this guard exists to catch splits
 * the SQL until no single literal both says SELECT and names the table. These are
 * the assembly forms, and what each one gets:
 *
 *   RESOLVED EXACTLY — the statement is rendered and judged as written:
 *     `${…}` interpolation; `+`; `+=` and `n = n + …` accumulation, read at the
 *     last append; `Array.prototype.join`; `String.prototype.concat`; `.toString`
 *     on a string or an array; `.trim`/`.trimStart`/`.trimEnd`; `String(x)`;
 *     `String.raw` (its RAW text, which is a raw template's only difference from
 *     a cooked one); and, for the array a `.join` or `.reduce` is given, array
 *     literals, spreads, `push`, `Array.from`, `Object.values`,
 *     `Array.prototype.concat`, `.slice` with literal bounds, `[i]` and `.at(i)`.
 *
 *   RESOLVED AS FAR AS THEIR INPUT, THEN REPORTED — the operation itself is not
 *     modelled, so its input is rendered (which is how the statement is still
 *     recognised as a role-bindings read) and the operation is marked
 *     unresolvable under rule 4: `.replace`/`.replaceAll`,
 *     `.slice`/`.substring`/`.substr` on a string, `.padStart`/`.padEnd`,
 *     `.repeat`, `.normalize`, `.split`, `.toUpperCase`/`.toLowerCase`,
 *     `.reduce`'s fold, `.map`/`.filter`/`.flat`/`.flatMap`/`.sort`/`.reverse`
 *     feeding a join, and any template tag that is not `String.raw`. These can
 *     DELETE the shared predicate or truncate the statement, so treating them as
 *     identities would be a hole — and skipping them would be the silence rule 4
 *     abolishes.
 *
 * WHAT IT CANNOT SEE. Stated exactly, because a guard that overstates its reach
 * is worse than one that states a narrow reach truthfully:
 *
 *   - VALUES CROSSING A FUNCTION BOUNDARY. Arguments are not followed into a
 *     helper and results are not followed back out, so `format('… FROM %s …',
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
 *   - ARRAY MUTATION OTHER THAN `push` — `unshift`, `splice`, `parts[0] = …`.
 *   - OBJECT KEYS. `Object.values` of an object literal is resolved; the KEYS of
 *     one are not, so `Object.keys(FRAGMENTS).join('')` is not resolved.
 *   - STRINGS PRODUCED AT RUN TIME — `JSON.parse`, `Buffer.toString`, `eval`,
 *     `new Function`, or text read from a file or a database. The literal that
 *     FEEDS such a facility is still judged where it is written.
 *   - DEPTH AND BREADTH LIMITS. Resolution stops at `RESOLVE_DEPTH` links and
 *     `VARIANT_CAP` possibilities; an overflow that touches the table is reported
 *     under rule 4, and a chain deeper than the limit renders as unresolvable.
 *   - SCOPE. There is no scope analysis: two locals of the same name in different
 *     functions are one name here and their values are merged. That is an
 *     over-approximation — every combination is judged — so it can report more
 *     than the code does, never less.
 *
 * One consequence of resolving `String.raw` rather than skipping it: the regular
 * expressions in this repository that quote SQL keywords and name the
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
import { readFileSync, readdirSync, statSync } from 'fs';
import { dirname, join, relative, resolve as resolvePath } from 'path';
import * as ts from 'typescript';

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
const UNKNOWN_MARK = 'UNRESOLVABLE_FRAGMENT';
/**
 * An expression that resolves to many possible strings makes many possible
 * statements, and all of them are judged. Beyond this many the statement is
 * treated as unresolvable and reported, rather than silently sampled.
 */
const VARIANT_CAP = 64;
/** Depth limit for the static evaluator, so a pathological file cannot hang it. */
const RESOLVE_DEPTH = 16;

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

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function sources(target: string): string[] {
  let stat;
  try {
    stat = statSync(target);
  } catch {
    return [];
  }
  if (stat.isFile()) {
    return target.endsWith('.ts') && !target.endsWith('.d.ts') ? [target] : [];
  }
  return readdirSync(target).flatMap((entry) => {
    const full = join(target, entry);
    if (entry === 'node_modules' || entry === 'dist') return [];
    return sources(full);
  });
}

// ── the module graph the static evaluator walks ────────────────────────────

type Binding =
  | { readonly kind: 'value'; readonly expr: ts.Expression }
  | { readonly kind: 'element-of'; readonly expr: ts.Expression }
  | { readonly kind: 'property-of'; readonly expr: ts.Expression; readonly property: string };

interface ModuleInfo {
  readonly abs: string;
  readonly rel: string;
  readonly sf: ts.SourceFile;
  /** Every name bound in the file, and how its value is obtained. */
  readonly bindings: Map<string, Binding[]>;
  /**
   * `name.push(x)`, in source order: an array assembled by appending is still an
   * ordered list of fragments, and `.join` on it still produces a statement.
   */
  readonly appends: Map<string, Array<{ expr: ts.Expression; spread: boolean }>>;
  /**
   * `name += x` and `name = name + x`, in source order: a statement accumulated
   * across several assignments is still one statement.
   */
  readonly accumulations: Map<string, ts.Expression[]>;
  /** Where each accumulator was last appended to — the point it is complete. */
  readonly lastAccumulation: Map<string, number>;
  readonly namedImports: Map<string, { spec: string; exported: string }>;
  readonly namespaceImports: Map<string, string>;
  readonly namedReExports: Map<string, { spec: string; exported: string }>;
  readonly starReExports: string[];
}

const MODULES = new Map<string, ModuleInfo | null>();

function loadModule(abs: string): ModuleInfo | null {
  const cached = MODULES.get(abs);
  if (cached !== undefined) return cached;
  if (!isFile(abs)) {
    MODULES.set(abs, null);
    return null;
  }
  const rel = relative(ROOT, abs).split('\\').join('/');
  const sf = ts.createSourceFile(rel, readFileSync(abs, 'utf8'), ts.ScriptTarget.ES2022, true);
  const mod: ModuleInfo = {
    abs,
    rel,
    sf,
    bindings: new Map(),
    appends: new Map(),
    accumulations: new Map(),
    lastAccumulation: new Map(),
    namedImports: new Map(),
    namespaceImports: new Map(),
    namedReExports: new Map(),
    starReExports: [],
  };
  const push = (name: string, binding: Binding): void => {
    const list = mod.bindings.get(name);
    if (list === undefined) mod.bindings.set(name, [binding]);
    else list.push(binding);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
      const init = node.initializer;
      if (ts.isIdentifier(node.name)) {
        push(node.name.text, { kind: 'value', expr: init });
      } else if (ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          if (!ts.isIdentifier(element.name)) continue;
          const source =
            element.propertyName !== undefined && ts.isIdentifier(element.propertyName)
              ? element.propertyName.text
              : element.name.text;
          push(element.name.text, { kind: 'property-of', expr: init, property: source });
        }
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'push' &&
      ts.isIdentifier(node.expression.expression)
    ) {
      const name = node.expression.expression.text;
      const list = mod.appends.get(name) ?? [];
      for (const arg of node.arguments) {
        if (ts.isSpreadElement(arg)) list.push({ expr: arg.expression, spread: true });
        else list.push({ expr: arg, spread: false });
      }
      mod.appends.set(name, list);
    }
    if (ts.isBinaryExpression(node) && ts.isIdentifier(node.left)) {
      const name = node.left.text;
      const appended: ts.Expression[] = [];
      if (node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken) {
        appended.push(node.right);
      } else if (node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        // `n = n + a + b` says exactly what `n += a; n += b` says.
        const chain: ts.Expression[] = [];
        let current: ts.Node = unwrap(node.right);
        while (
          ts.isBinaryExpression(current) &&
          current.operatorToken.kind === ts.SyntaxKind.PlusToken
        ) {
          chain.unshift(current.right);
          current = unwrap(current.left);
        }
        if (chain.length > 0 && ts.isIdentifier(current) && current.text === name) {
          appended.push(...chain);
        }
      }
      if (appended.length > 0) {
        const list = mod.accumulations.get(name) ?? [];
        list.push(...appended);
        mod.accumulations.set(name, list);
        mod.lastAccumulation.set(name, node.pos);
      }
    }
    if (ts.isForOfStatement(node) && ts.isVariableDeclarationList(node.initializer)) {
      const declared = node.initializer.declarations[0];
      if (declared !== undefined && ts.isIdentifier(declared.name)) {
        push(declared.name.text, { kind: 'element-of', expr: node.expression });
      }
    }
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const spec = node.moduleSpecifier.text;
      const named = node.importClause?.namedBindings;
      if (named !== undefined && ts.isNamespaceImport(named)) {
        mod.namespaceImports.set(named.name.text, spec);
      } else if (named !== undefined && ts.isNamedImports(named)) {
        for (const element of named.elements) {
          const exported = element.propertyName?.text ?? element.name.text;
          mod.namedImports.set(element.name.text, { spec, exported });
        }
      }
    }
    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const spec = node.moduleSpecifier.text;
      const clause = node.exportClause;
      if (clause === undefined) mod.starReExports.push(spec);
      else if (ts.isNamedExports(clause)) {
        for (const element of clause.elements) {
          const exported = element.propertyName?.text ?? element.name.text;
          mod.namedReExports.set(element.name.text, { spec, exported });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  MODULES.set(abs, mod);
  return mod;
}

/**
 * A module specifier to a file in this repository. Relative paths resolve
 * directly; `@dealer/<name>` is the workspace convention and resolves to that
 * package's public entry point, which is how a cross-package reader reaches the
 * shared predicate.
 */
function resolveSpecifier(fromAbs: string, spec: string): ModuleInfo | null {
  if (spec.startsWith('.')) {
    const base = resolvePath(dirname(fromAbs), spec);
    for (const candidate of [`${base}.ts`, join(base, 'index.ts'), base]) {
      if (isFile(candidate)) return loadModule(candidate);
    }
    return null;
  }
  const workspace = /^@dealer\/([a-z0-9-]+)$/.exec(spec);
  if (workspace !== null && workspace[1] !== undefined) {
    for (const area of ['packages', 'apps']) {
      const candidate = join(ROOT, area, workspace[1], 'src', 'index.ts');
      if (isFile(candidate)) return loadModule(candidate);
    }
  }
  return null;
}

interface Decl {
  readonly mod: ModuleInfo;
  readonly name: string;
  readonly expr: ts.Expression;
}

function unwrap(node: ts.Node): ts.Node {
  let current = node;
  for (;;) {
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isTypeAssertionExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    return current;
  }
}

/** The declaration a module exports under `name`, following re-exports. */
function resolveExport(mod: ModuleInfo, name: string, seen: Set<string>): Decl | undefined {
  const key = `${mod.rel}#${name}`;
  if (seen.has(key)) return undefined;
  seen.add(key);
  const local = mod.bindings.get(name)?.find((b) => b.kind === 'value');
  if (local !== undefined) return { mod, name, expr: local.expr };
  const imported = mod.namedImports.get(name) ?? mod.namedReExports.get(name);
  if (imported !== undefined) {
    const target = resolveSpecifier(mod.abs, imported.spec);
    return target === null ? undefined : resolveExport(target, imported.exported, seen);
  }
  for (const spec of mod.starReExports) {
    const target = resolveSpecifier(mod.abs, spec);
    if (target === null) continue;
    const found = resolveExport(target, name, seen);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * The declaration a bare reference names — a local `const`, a named or aliased
 * import, or a member of a namespace import. This is what makes "is this the
 * shared predicate?" a question about identity rather than about text.
 */
function resolveReference(node: ts.Node, mod: ModuleInfo): Decl | undefined {
  const inner = unwrap(node);
  if (ts.isIdentifier(inner)) {
    const local = mod.bindings.get(inner.text)?.find((b) => b.kind === 'value');
    if (local !== undefined) return { mod, name: inner.text, expr: local.expr };
    const imported = mod.namedImports.get(inner.text);
    if (imported === undefined) return undefined;
    const target = resolveSpecifier(mod.abs, imported.spec);
    return target === null ? undefined : resolveExport(target, imported.exported, new Set());
  }
  if (ts.isPropertyAccessExpression(inner) && ts.isIdentifier(inner.expression)) {
    const spec = mod.namespaceImports.get(inner.expression.text);
    if (spec === undefined) return undefined;
    const target = resolveSpecifier(mod.abs, spec);
    return target === null ? undefined : resolveExport(target, inner.name.text, new Set());
  }
  return undefined;
}

function isSharedPredicateRef(node: ts.Node, mod: ModuleInfo): boolean {
  const decl = resolveReference(node, mod);
  return (
    decl !== undefined && decl.mod.rel === SHARED_PREDICATE_FILE && decl.name === SHARED_PREDICATE
  );
}

// ── the static evaluator ───────────────────────────────────────────────────

interface Site {
  readonly node: ts.Node;
  readonly mod: ModuleInfo;
}

interface Ctx {
  readonly seen: Set<string>;
  readonly depth: number;
}

function deeper(ctx: Ctx): Ctx {
  return { seen: ctx.seen, depth: ctx.depth + 1 };
}

/** Every expression this expression could evaluate to, when that is knowable. */
function sites(node: ts.Node, mod: ModuleInfo, ctx: Ctx): Site[] | undefined {
  if (ctx.depth > RESOLVE_DEPTH) return undefined;
  const inner = unwrap(node);

  if (ts.isIdentifier(inner) || ts.isPropertyAccessExpression(inner)) {
    const bound = ts.isIdentifier(inner) ? mod.bindings.get(inner.text) : undefined;
    if (bound !== undefined && bound.length > 0) {
      const out: Site[] = [];
      for (const binding of bound) {
        const key = `${mod.rel}#${binding.expr.pos}#${binding.kind}`;
        if (ctx.seen.has(key)) return undefined;
        ctx.seen.add(key);
        const got =
          binding.kind === 'value'
            ? sites(binding.expr, mod, deeper(ctx))
            : binding.kind === 'element-of'
              ? elementSites(binding.expr, mod, deeper(ctx))
              : propertySites(binding.expr, binding.property, mod, deeper(ctx));
        ctx.seen.delete(key);
        if (got === undefined) return undefined;
        out.push(...got);
      }
      return out;
    }
    const decl = resolveReference(inner, mod);
    if (decl !== undefined) return sites(decl.expr, decl.mod, deeper(ctx));
    if (ts.isPropertyAccessExpression(inner)) {
      return propertySites(inner.expression, inner.name.text, mod, deeper(ctx));
    }
    return undefined;
  }

  if (ts.isElementAccessExpression(inner)) {
    const keys = textValues(inner.argumentExpression, mod, deeper(ctx));
    // `PARTS[0]` indexes an ARRAY, which `propertySites` — written for object
    // literals — cannot answer. A resolvable index takes that element; an index
    // this file cannot resolve takes EVERY element, the same over-approximation
    // an unresolvable object key gets.
    const array = arrayShapes(inner.expression, mod, deeper(ctx));
    if (array !== undefined) {
      const out: Site[] = [];
      for (const elements of array.shapes) {
        const chosen =
          keys === undefined
            ? elements
            : elements.filter((_, index) => keys.includes(String(index)));
        for (const element of chosen) {
          const got = sites(element.expr, element.mod, deeper(ctx));
          if (got === undefined) return undefined;
          out.push(...got);
        }
      }
      return out.length === 0 ? undefined : out;
    }
    return propertySites(inner.expression, keys, mod, deeper(ctx));
  }

  if (ts.isConditionalExpression(inner)) {
    return union(sites(inner.whenTrue, mod, deeper(ctx)), sites(inner.whenFalse, mod, deeper(ctx)));
  }

  if (
    ts.isBinaryExpression(inner) &&
    (inner.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      inner.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    return union(sites(inner.left, mod, deeper(ctx)), sites(inner.right, mod, deeper(ctx)));
  }

  return [{ node: inner, mod }];
}

function union(a: Site[] | undefined, b: Site[] | undefined): Site[] | undefined {
  return a === undefined || b === undefined ? undefined : [...a, ...b];
}

/** The elements of every array literal the expression could be. */
function elementSites(node: ts.Node, mod: ModuleInfo, ctx: Ctx): Site[] | undefined {
  const holders = sites(node, mod, ctx);
  if (holders === undefined) return undefined;
  const out: Site[] = [];
  for (const holder of holders) {
    if (!ts.isArrayLiteralExpression(holder.node)) return undefined;
    for (const element of holder.node.elements) {
      if (ts.isSpreadElement(element)) return undefined;
      const got = sites(element, holder.mod, deeper(ctx));
      if (got === undefined) return undefined;
      out.push(...got);
    }
  }
  return out;
}

/**
 * The named properties of every object literal the expression could be. A key
 * this file cannot resolve (`MAP[whateverTheCallerSaid]`) yields EVERY property
 * — an over-approximation, so a table name chosen at run time is judged in all
 * of the shapes it could take.
 */
function propertySites(
  node: ts.Node,
  property: string | string[] | undefined,
  mod: ModuleInfo,
  ctx: Ctx,
): Site[] | undefined {
  const holders = sites(node, mod, ctx);
  if (holders === undefined) return undefined;
  const wanted =
    property === undefined
      ? undefined
      : new Set(typeof property === 'string' ? [property] : property);
  const out: Site[] = [];
  for (const holder of holders) {
    if (!ts.isObjectLiteralExpression(holder.node)) return undefined;
    for (const member of holder.node.properties) {
      if (!ts.isPropertyAssignment(member)) return undefined;
      const name = ts.isIdentifier(member.name)
        ? member.name.text
        : ts.isStringLiteral(member.name)
          ? member.name.text
          : undefined;
      if (name === undefined) return undefined;
      if (wanted !== undefined && !wanted.has(name)) continue;
      const got = sites(member.initializer, holder.mod, deeper(ctx));
      if (got === undefined) return undefined;
      out.push(...got);
    }
  }
  return out;
}

// ── template text, raw and cooked ─────────────────────────────────────────

/** Is this the tag of a `String.raw` tagged template? */
function isStringRawTag(tag: ts.Expression): boolean {
  const inner = unwrap(tag);
  return (
    ts.isPropertyAccessExpression(inner) &&
    ts.isIdentifier(inner.expression) &&
    inner.expression.text === 'String' &&
    inner.name.text === 'raw'
  );
}

/** Is this node the template of a `String.raw` tag? */
function isRawTemplate(node: ts.Node): boolean {
  const parent = node.parent;
  return (
    parent !== undefined &&
    ts.isTaggedTemplateExpression(parent) &&
    parent.template === node &&
    isStringRawTag(parent.tag)
  );
}

/** The template a head/middle/tail piece belongs to. */
function enclosingTemplate(node: ts.Node): ts.Node {
  if (ts.isTemplateHead(node)) return node.parent;
  if (ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) return node.parent.parent;
  return node;
}

/**
 * The text a template piece contributes. `String.raw` receives the RAW text — the
 * source between the delimiters, with backslashes untouched — where an untagged
 * template receives the cooked text. That is the ONLY difference between the two,
 * and resolving it is why a raw template is judged like any other literal rather
 * than skipped: a skip would be an undeclared exception that no reviewer sees.
 */
function pieceText(node: ts.TemplateLiteralLikeNode, sf: ts.SourceFile): string {
  if (!isRawTemplate(enclosingTemplate(node))) return node.text;
  const text = node.getText(sf);
  const start = text.startsWith('`') || text.startsWith('}') ? 1 : 0;
  const end = text.endsWith('${')
    ? text.length - 2
    : text.endsWith('`')
      ? text.length - 1
      : text.length;
  return text.slice(start, end);
}

/** How an expression is named in a violation message. */
function label(node: ts.Node, sf: ts.SourceFile): string {
  const text = node.getText(sf).replace(/\s+/g, ' ').trim();
  return text.length > 72 ? `${text.slice(0, 71)}…` : text;
}

function cross(prefixes: string[], values: string[], tail: string): string[] | undefined {
  if (prefixes.length * values.length > VARIANT_CAP) return undefined;
  const out: string[] = [];
  for (const prefix of prefixes) for (const value of values) out.push(`${prefix}${value}${tail}`);
  return out;
}

/** Every string the expression could be. `undefined` means "cannot tell". */
function textValues(node: ts.Node, mod: ModuleInfo, ctx: Ctx): string[] | undefined {
  if (ctx.depth > RESOLVE_DEPTH) return undefined;
  if (isSharedPredicateRef(node, mod)) return [GUARD_MARK];
  // An accumulator's value is what it was declared as, followed by everything
  // appended to it. `let sql = HEAD; sql += TABLE; sql += TAIL;` is one statement
  // written across three, and reading only the declaration loses two thirds of it.
  const named = unwrap(node);
  if (ts.isIdentifier(named)) {
    const appended = mod.accumulations.get(named.text);
    if (appended !== undefined) {
      let variants = declaredTextValues(named, mod, ctx);
      if (variants === undefined) return undefined;
      for (const piece of appended) {
        const values = textValues(piece, mod, deeper(ctx));
        if (values === undefined) return undefined;
        const next = cross(variants, values, '');
        if (next === undefined) return undefined;
        variants = next;
      }
      return variants;
    }
  }
  return declaredTextValues(node, mod, ctx);
}

/** Every string the expression's DECLARED value could be. */
function declaredTextValues(node: ts.Node, mod: ModuleInfo, ctx: Ctx): string[] | undefined {
  const found = sites(node, mod, ctx);
  if (found === undefined) return undefined;
  const out: string[] = [];
  for (const site of found) {
    const literal = literalTexts(site.node, site.mod, deeper(ctx));
    if (literal === undefined) return undefined;
    out.push(...literal);
    if (out.length > VARIANT_CAP) return undefined;
  }
  return out.length === 0 ? undefined : out;
}

function literalTexts(node: ts.Node, mod: ModuleInfo, ctx: Ctx): string[] | undefined {
  if (ctx.depth > RESOLVE_DEPTH) return undefined;
  if (ts.isStringLiteral(node)) return [node.text];
  // A number is a string too — an index, a limit — and it can hold neither a
  // table name nor a predicate, so resolving it removes noise rather than adding
  // reach.
  if (ts.isNumericLiteral(node)) return [node.text];
  if (
    ts.isPrefixUnaryExpression(node) &&
    node.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(node.operand)
  ) {
    return [`-${node.operand.text}`];
  }
  if (ts.isNoSubstitutionTemplateLiteral(node)) return [pieceText(node, mod.sf)];
  if (ts.isTemplateExpression(node)) {
    let variants: string[] = [pieceText(node.head, mod.sf)];
    for (const span of node.templateSpans) {
      const values = textValues(span.expression, mod, deeper(ctx));
      if (values === undefined) return undefined;
      const next = cross(variants, values, pieceText(span.literal, mod.sf));
      if (next === undefined) return undefined;
      variants = next;
    }
    return variants;
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left =
      literalTexts(node.left, mod, deeper(ctx)) ?? textValues(node.left, mod, deeper(ctx));
    const right =
      literalTexts(node.right, mod, deeper(ctx)) ?? textValues(node.right, mod, deeper(ctx));
    if (left === undefined || right === undefined) return undefined;
    return cross(left, right, '');
  }
  // A statement assembled by a method call is a statement. Only a FULLY resolved
  // assembly yields a value here: a shape carrying an opaque piece has no single
  // text, which is exactly what `undefined` tells every caller.
  const assembled = assembly(node, mod, deeper(ctx));
  if (assembled === undefined) return undefined;
  const out: string[] = [];
  for (const parts of assembled) {
    let variants: string[] = [''];
    for (const part of parts) {
      if (part.kind === 'opaque') return undefined;
      const values =
        part.kind === 'text' ? [part.text] : textValues(part.expr, part.mod ?? mod, deeper(ctx));
      if (values === undefined) return undefined;
      const next = cross(variants, values, '');
      if (next === undefined) return undefined;
      variants = next;
    }
    out.push(...variants);
    if (out.length > VARIANT_CAP) return undefined;
  }
  return out.length === 0 ? undefined : out;
}

// ── rendering one candidate statement ─────────────────────────────────────

type Part =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'expr'; readonly expr: ts.Expression; readonly mod?: ModuleInfo }
  /**
   * A piece whose value this guard does not model. It is KEPT rather than dropped,
   * so the statement around it is still recognised as a role-bindings read and is
   * still reported under rule 4 — dropping it is the silence rule 4 abolishes.
   */
  | { readonly kind: 'opaque'; readonly label: string };

/** One expression may be assembled several ways; each way is a sequence of parts. */
type Shapes = Part[][];

/**
 * THE CLOSED SET OF STRING-ASSEMBLY CALLS. A call outside it is not treated as
 * string building at all, which is what keeps `executor.query(…)` — and every
 * other ordinary call — from being rendered as though it were SQL.
 *
 * The first group is resolved EXACTLY. The second cannot be modelled: `.replace`
 * can delete the shared predicate, `.slice` can truncate the statement, a case
 * fold changes what the rules match. Those keep their receiver and add an opaque
 * mark, which makes the statement UNRESOLVABLE rather than assumed innocent.
 */
const ASSEMBLY_RESOLVED = ['join', 'concat', 'toString', 'trim', 'trimStart', 'trimEnd'] as const;
const ASSEMBLY_OPAQUE = [
  'replace',
  'replaceAll',
  'slice',
  'substring',
  'substr',
  'padStart',
  'padEnd',
  'repeat',
  'normalize',
  'split',
  'reduce',
  'at',
  'charAt',
  'toUpperCase',
  'toLowerCase',
] as const;
const ASSEMBLY_METHODS = new Set<string>([...ASSEMBLY_RESOLVED, ...ASSEMBLY_OPAQUE]);

/** Which assembly form this call is, if it is one at all. */
function assemblyMethod(call: ts.CallExpression): string | undefined {
  const callee = unwrap(call.expression);
  if (ts.isIdentifier(callee)) return callee.text === 'String' ? 'String' : undefined;
  if (!ts.isPropertyAccessExpression(callee)) return undefined;
  const name = callee.name.text;
  return ASSEMBLY_METHODS.has(name) ? name : undefined;
}

interface ElementRef {
  readonly expr: ts.Expression;
  readonly mod: ModuleInfo;
}

interface ArrayValue {
  /** Every ordered element list the expression could be. */
  readonly shapes: ElementRef[][];
  /**
   * False when the array is those elements REARRANGED OR REWRITTEN by something
   * this guard does not model — `.map`, `.filter`, `.sort`. The elements are
   * still rendered, because they are still what the statement is made of, but the
   * result is marked unresolvable rather than presented as the statement.
   */
  readonly exact: boolean;
}

/** Array operations that keep the elements but change them or their order. */
const ARRAY_INEXACT = new Set(['map', 'filter', 'flat', 'flatMap', 'sort', 'reverse']);

/** A non-negative index or bound written as a literal. */
function boundValue(node: ts.Expression, mod: ModuleInfo, ctx: Ctx): number | undefined {
  const values = textValues(node, mod, ctx);
  if (values === undefined || values.length !== 1) return undefined;
  const only = Number(values[0]);
  return Number.isInteger(only) && only >= 0 ? only : undefined;
}

/** `Object.values` of an object literal, in declaration order. */
function objectValues(node: ts.Node, mod: ModuleInfo, ctx: Ctx): ArrayValue | undefined {
  const holders = sites(node, mod, ctx);
  if (holders === undefined || holders.length === 0) return undefined;
  const shapes: ElementRef[][] = [];
  for (const holder of holders) {
    if (!ts.isObjectLiteralExpression(holder.node)) return undefined;
    const elements: ElementRef[] = [];
    for (const member of holder.node.properties) {
      if (!ts.isPropertyAssignment(member)) return undefined;
      elements.push({ expr: member.initializer, mod: holder.mod });
    }
    shapes.push(elements);
  }
  return { shapes, exact: true };
}

/**
 * The ORDERED elements of every array the expression could be — array literals,
 * spreads of them, the arguments of every `push` onto that name, `Array.from`,
 * `Object.values`, `.slice`, `.concat`, and the transforms above. Order matters
 * here in a way it does not elsewhere in this file: a joined array is a
 * statement, and a statement is its pieces in sequence.
 */
function arrayShapes(node: ts.Node, mod: ModuleInfo, ctx: Ctx): ArrayValue | undefined {
  if (ctx.depth > RESOLVE_DEPTH) return undefined;
  const inner = unwrap(node);
  if (ts.isCallExpression(inner)) {
    const callee = unwrap(inner.expression);
    if (!ts.isPropertyAccessExpression(callee)) return undefined;
    const method = callee.name.text;
    const owner = callee.expression;
    const first = inner.arguments[0];
    const single =
      inner.arguments.length === 1 && first !== undefined && !ts.isSpreadElement(first)
        ? first
        : undefined;
    if (ts.isIdentifier(owner) && owner.text === 'Array') {
      return method === 'from' && single !== undefined
        ? arrayShapes(single, mod, deeper(ctx))
        : undefined;
    }
    if (ts.isIdentifier(owner) && owner.text === 'Object') {
      return method === 'values' && single !== undefined
        ? objectValues(single, mod, deeper(ctx))
        : undefined;
    }
    if (ARRAY_INEXACT.has(method)) {
      const base = arrayShapes(owner, mod, deeper(ctx));
      return base === undefined ? undefined : { shapes: base.shapes, exact: false };
    }
    if (method === 'slice') {
      const base = arrayShapes(owner, mod, deeper(ctx));
      if (base === undefined) return undefined;
      const bounds = inner.arguments.map((a) =>
        ts.isSpreadElement(a) ? undefined : boundValue(a, mod, deeper(ctx)),
      );
      if (bounds.some((b) => b === undefined)) return { shapes: base.shapes, exact: false };
      const from = bounds[0] ?? 0;
      const to = bounds[1];
      return { shapes: base.shapes.map((e) => e.slice(from, to)), exact: base.exact };
    }
    if (method === 'concat') {
      const base = arrayShapes(owner, mod, deeper(ctx));
      if (base === undefined) return undefined;
      let shapes = base.shapes;
      let exact = base.exact;
      for (const arg of inner.arguments) {
        if (ts.isSpreadElement(arg)) return { shapes, exact: false };
        const piece = arrayShapes(arg, mod, deeper(ctx));
        if (piece === undefined) {
          shapes = shapes.map((e) => [...e, { expr: arg, mod }]);
          continue;
        }
        exact = exact && piece.exact;
        const combined: ElementRef[][] = [];
        for (const a of shapes) for (const b of piece.shapes) combined.push([...a, ...b]);
        if (combined.length > VARIANT_CAP) return undefined;
        shapes = combined;
      }
      return { shapes, exact };
    }
    return undefined;
  }
  const holders = sites(inner, mod, ctx);
  if (holders === undefined || holders.length === 0) return undefined;
  const appended = ts.isIdentifier(inner) ? (mod.appends.get(inner.text) ?? []) : [];
  const shapes: ElementRef[][] = [];
  for (const holder of holders) {
    if (!ts.isArrayLiteralExpression(holder.node)) return undefined;
    const elements: ElementRef[] = [];
    const take = (expr: ts.Expression, spread: boolean, owner: ModuleInfo): boolean => {
      if (!spread) {
        elements.push({ expr, mod: owner });
        return true;
      }
      const nested = arrayShapes(expr, owner, deeper(ctx));
      const only =
        nested !== undefined && nested.shapes.length === 1 ? nested.shapes[0] : undefined;
      if (only === undefined || nested?.exact !== true) return false;
      elements.push(...only);
      return true;
    };
    for (const element of holder.node.elements) {
      if (ts.isOmittedExpression(element)) return undefined;
      const spread = ts.isSpreadElement(element);
      if (!take(spread ? element.expression : element, spread, holder.mod)) return undefined;
    }
    for (const push of appended) {
      if (!take(push.expr, push.spread, mod)) return undefined;
    }
    shapes.push(elements);
    if (shapes.length > VARIANT_CAP) return undefined;
  }
  return { shapes, exact: true };
}

/**
 * A string assembled by a CALL or by a TEMPLATE TAG, broken into the same parts a
 * template produces. `${a}${b}`, `a + b`, `[a, b].join('')` and `a.concat(b)` are
 * one idea in four spellings, and a guard that read only the first two is
 * defeated by choosing either of the others.
 */
function assembly(node: ts.Node, mod: ModuleInfo, ctx: Ctx): Shapes | undefined {
  const inner = unwrap(node);

  if (ts.isTaggedTemplateExpression(inner)) {
    const inside = flatten(inner.template, mod, deeper(ctx));
    // `String.raw` returns its template's RAW text, which `pieceText` has already
    // supplied. Any OTHER tag is a function, and may return anything at all.
    if (isStringRawTag(inner.tag)) return inside;
    const mark: Part = { kind: 'opaque', label: label(inner.tag, mod.sf) };
    return inside === undefined ? [[mark]] : inside.map((seq) => [...seq, mark]);
  }

  if (!ts.isCallExpression(inner)) return undefined;
  const method = assemblyMethod(inner);
  if (method === undefined) return undefined;
  const unmodelled: Shapes = [[{ kind: 'opaque', label: label(inner, mod.sf) }]];

  if (method === 'String') {
    const arg = inner.arguments[0];
    if (inner.arguments.length !== 1 || arg === undefined || ts.isSpreadElement(arg)) {
      return unmodelled;
    }
    return [[{ kind: 'expr', expr: arg, mod }]];
  }

  const callee = unwrap(inner.expression);
  if (!ts.isPropertyAccessExpression(callee)) return unmodelled;
  const receiver = callee.expression;

  if (method === 'join' || method === 'toString') {
    const array =
      method === 'toString' && inner.arguments.length > 0
        ? undefined
        : arrayShapes(receiver, mod, deeper(ctx));
    if (array === undefined) {
      // `s.toString()` on something that is not an array is the string itself.
      return method === 'toString' && inner.arguments.length === 0
        ? [[{ kind: 'expr', expr: receiver, mod }]]
        : unmodelled;
    }
    const first = inner.arguments[0];
    const separator: Part =
      method === 'join' && first !== undefined && !ts.isSpreadElement(first)
        ? { kind: 'expr', expr: first, mod }
        : { kind: 'text', text: ',' };
    return array.shapes.map((elements) => {
      const seq: Part[] = [];
      elements.forEach((element, index) => {
        if (index > 0) seq.push(separator);
        seq.push({ kind: 'expr', expr: element.expr, mod: element.mod });
      });
      if (!array.exact) seq.push({ kind: 'opaque', label: label(inner, mod.sf) });
      return seq;
    });
  }

  if (method === 'at' || method === 'charAt') {
    // Indexing an array of fragments by a resolvable index is exact; anything
    // else keeps the receiver and reports.
    const array = arrayShapes(receiver, mod, deeper(ctx));
    const index = inner.arguments[0];
    const keys =
      index === undefined || ts.isSpreadElement(index)
        ? undefined
        : textValues(index, mod, deeper(ctx));
    if (array !== undefined && array.exact && keys !== undefined) {
      const picked: Shapes = [];
      for (const elements of array.shapes) {
        for (const key of keys) {
          const offset = Number(key);
          const element = elements[offset < 0 ? elements.length + offset : offset];
          if (element !== undefined) {
            picked.push([{ kind: 'expr', expr: element.expr, mod: element.mod }]);
          }
        }
      }
      if (picked.length > 0) return picked;
    }
  }

  if (method === 'concat') {
    const seq: Part[] = [{ kind: 'expr', expr: receiver, mod }];
    for (const arg of inner.arguments) {
      if (ts.isSpreadElement(arg)) return unmodelled;
      seq.push({ kind: 'expr', expr: arg, mod });
    }
    return [seq];
  }

  if (method === 'trim' || method === 'trimStart' || method === 'trimEnd') {
    // Trimming removes whitespace from the ends. It cannot remove a table name, a
    // column comparison or the shared predicate, so it is an exact identity here.
    return [[{ kind: 'expr', expr: receiver, mod }]];
  }

  if (method === 'reduce') {
    // The fold is not modelled, but its ELEMENTS are, in order — so a statement
    // accumulated out of fragments is still seen, and the mark still reports it.
    const array = arrayShapes(receiver, mod, deeper(ctx));
    if (array === undefined) return unmodelled;
    const mark: Part = { kind: 'opaque', label: label(inner, mod.sf) };
    return array.shapes.map((elements) => [
      ...elements.map((element): Part => ({ kind: 'expr', expr: element.expr, mod: element.mod })),
      mark,
    ]);
  }

  return [
    [
      { kind: 'expr', expr: receiver, mod },
      { kind: 'opaque', label: label(inner, mod.sf) },
    ],
  ];
}

/** The literal pieces and the interpolations of a string-building expression. */
function flatten(node: ts.Node, mod: ModuleInfo, ctx: Ctx): Shapes | undefined {
  if (ctx.depth > RESOLVE_DEPTH) return undefined;
  const inner = unwrap(node);
  if (ts.isStringLiteral(inner)) return [[{ kind: 'text', text: inner.text }]];
  if (ts.isNoSubstitutionTemplateLiteral(inner)) {
    return [[{ kind: 'text', text: pieceText(inner, mod.sf) }]];
  }
  if (ts.isTemplateExpression(inner)) {
    const seq: Part[] = [{ kind: 'text', text: pieceText(inner.head, mod.sf) }];
    for (const span of inner.templateSpans) {
      seq.push({ kind: 'expr', expr: span.expression, mod });
      seq.push({ kind: 'text', text: pieceText(span.literal, mod.sf) });
    }
    return [seq];
  }
  if (ts.isBinaryExpression(inner) && inner.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = flatten(inner.left, mod, deeper(ctx));
    const right = flatten(inner.right, mod, deeper(ctx));
    if (left === undefined || right === undefined) return undefined;
    if (left.length * right.length > VARIANT_CAP) return undefined;
    const out: Shapes = [];
    for (const l of left) for (const r of right) out.push([...l, ...r]);
    return out;
  }
  if (
    ts.isBinaryExpression(inner) &&
    ts.isIdentifier(inner.left) &&
    (inner.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken ||
      inner.operatorToken.kind === ts.SyntaxKind.EqualsToken)
  ) {
    // The value of an accumulator, which `textValues` reads as its declaration
    // followed by every append to it.
    return [[{ kind: 'expr', expr: inner.left, mod }]];
  }
  const assembled = assembly(inner, mod, ctx);
  if (assembled !== undefined) return assembled;
  // Anything else contributes its VALUE, which the evaluator will try to resolve:
  // `PREFIX + BINDINGS_TABLE + SUFFIX` is one statement assembled from three
  // references, and treating the references as opaque would lose the statement.
  return ts.isExpression(inner) ? [[{ kind: 'expr', expr: inner, mod }]] : undefined;
}

interface Rendered {
  /** Every statement this literal could be, with the shared predicate marked. */
  readonly variants: string[];
  /** How each piece that could not be resolved is named. */
  readonly unresolved: string[];
  /** True when the statement had to be abandoned (too many possibilities). */
  readonly overflowed: boolean;
}

function render(node: ts.Node, mod: ModuleInfo): Rendered | undefined {
  const shapes = flatten(node, mod, { seen: new Set(), depth: 0 });
  if (shapes === undefined) return undefined;
  const variants: string[] = [];
  const unresolved: string[] = [];
  let overflowed = false;
  for (const parts of shapes) {
    let built: string[] = [''];
    for (const part of parts) {
      if (part.kind === 'text') {
        built = built.map((v) => `${v}${part.text}`);
        continue;
      }
      const owner = part.kind === 'expr' ? (part.mod ?? mod) : mod;
      let values =
        part.kind === 'opaque'
          ? undefined
          : textValues(part.expr, owner, { seen: new Set(), depth: 0 });
      if (values === undefined) {
        unresolved.push(part.kind === 'opaque' ? part.label : label(part.expr, owner.sf));
        values = [`${UNKNOWN_MARK}_${unresolved.length}`];
      }
      const next = cross(built, values, '');
      if (next === undefined) {
        overflowed = true;
        break;
      }
      built = next;
    }
    variants.push(...built);
    if (variants.length > VARIANT_CAP) {
      overflowed = true;
      break;
    }
  }
  return { variants, unresolved, overflowed };
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
  const mod = loadModule(abs);
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

    // A statement is judged WHERE IT IS ASSEMBLED. A literal is one assembly
    // point; so are `+`, a tagged template, and a call from the closed set of
    // string-assembly methods — because `[HEAD, TABLE, TAIL].join('')` names the
    // table in one piece and says SELECT in another, and no piece of it is SQL.
    const isCandidateNode =
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateExpression(node) ||
      ts.isTaggedTemplateExpression(node) ||
      (ts.isCallExpression(node) && assemblyMethod(node) !== undefined) ||
      (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) ||
      // The point an accumulator is COMPLETE: its last append. Judging it there
      // judges the whole statement once, rather than a prefix of it three times.
      (ts.isBinaryExpression(node) &&
        ts.isIdentifier(node.left) &&
        mod.lastAccumulation.get(node.left.text) === node.pos);
    if (!isCandidateNode || isDefinitionSite(node)) {
      ts.forEachChild(node, visit);
      return;
    }
    const rendered = render(node, mod);
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
    for (const file of sources(join(ROOT, root))) {
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
