/**
 * FBL-020-R4 §3 — THE AUDIT-INVENTORY COMPLETENESS GATE.
 *
 *   npx tsx scripts/check-audit-inventory.ts [extra-root-or-file...]
 *   (always scans apps packages scripts migrations; extra targets are ADDED)
 *
 * WHY THIS EXISTS. `packages/identity-access/src/audit-inventory.ts` asserted in its
 * own header that "a transition added to the platform without an entry fails the
 * completeness assertion". No such assertion existed. The inventory listed 19 entries
 * against the 46 audit event types production code actually writes, and one of the
 * missing ones was `identity.support.expired` — inside the inventory's OWN declared
 * `support` family, written by §4's own expiry processor. The suite stayed green
 * throughout, because nothing anywhere compared the list to the code. This file is
 * that comparison.
 *
 * WHY IT WAS REWRITTEN (R4 correction F1a). The first version read names with ONE
 * regular expression over `node.text` and one look at `node.head.text`. Both were
 * defeated in twelve lines: `'identity.support' + '.quarantined'` put no complete
 * name in any single literal, and `` `${NS}.quarantined` `` has an EMPTY head, so the
 * template rule saw nothing. Either one produced a brand-new audit event type with a
 * declared family, a declared writer, a real `INSERT INTO audit_events` — and an
 * `exit 0`. The sibling guard `scripts/check-role-binding-effectiveness.ts` already
 * resolved both spellings, because it owns a static evaluator that resolves
 * concatenation, `.join`, `.concat`, accumulation, indexed fragments, `String.raw`
 * and template tags. Writing a THIRD string analysis here was the defect. The
 * evaluator now lives in `scripts/static-string-resolver.ts` and BOTH gates import
 * it, which is the same "one implementation" rule the role-bindings guard enforces
 * for SQL, applied to the guards themselves.
 *
 * THE COMPLETENESS ARGUMENT, in three steps, because "we scanned for event types" is
 * not by itself an argument:
 *
 *   1. AN AUDIT EVENT TYPE HAS TO EXIST AS A NAME. Every `identity.`-namespaced name
 *      the shared resolver can READ out of production code — whether it is spelled in
 *      one literal or assembled out of fragments — must be either an `eventType` in
 *      the inventory or a declared entry of `IDENTITY_NON_AUDIT_NAMESPACE_LITERALS` (a
 *      policy action key, a worker job name) carrying the reason it is not an event.
 *      There is no third bucket and no per-site opt-out.
 *
 *   2. …AND THAT NAME HAS TO BE READABLE. Where the resolver reads the namespace root
 *      and then cannot resolve the rest (`identity.support.${x}`), the name is REFUSED
 *      outright: `audit-event-type-assembled-at-run-time`. Where it cannot resolve the
 *      ROOT but the next segment is a DECLARED FAMILY (`${ns}.support.quarantined`),
 *      the name is refused as well:
 *      `audit-event-type-namespace-root-assembled-at-run-time`. Silence is a failure
 *      wherever there is something to be silent about.
 *
 *   3. …AND IT HAS TO BE WRITTEN FROM A DECLARED WRITER. Steps 1 and 2 reason about
 *      the `identity.` namespace; a brand-new namespace would sit outside it. So every
 *      production file holding an `INSERT INTO audit_events` must appear in
 *      `AUDIT_EVENT_WRITERS`, which states the namespace each one writes and whether
 *      its event types are statically enumerable. Exactly one writer is declared
 *      NON-enumerable — the pre-existing Phase-248 `service.${action}` cockpit audit,
 *      outside the identity boundary — and that declaration is the recorded residue.
 *
 * The reverse direction is checked too, because a list that is complete and STALE is
 * still a lie: an inventory entry whose event type appears nowhere in production, a
 * declared non-audit literal that has gone, a declared writer that no longer writes,
 * an entry whose family does not match its own event type, and an entry whose
 * `provenIn` file does not contain its `provenBy` string verbatim, are each failures.
 * That last one is why the citations cannot go back to being prose: R3's `provenBy`
 * values named no test in any file.
 *
 * EVERY RULE IN THIS FILE IS TESTED, not merely written (R4 correction F2). Deleting
 * `checkInventoryShape` wholesale once left `tests/architecture.test.ts` 13/13 and
 * `tests/ci-gates.test.ts` 14/14 green, which means ten of the thirteen rules inside
 * it were decoration. The rule functions are therefore EXPORTED and driven directly,
 * one test per rule, from `tests/audit-inventory-rules.test.ts`; the scanning rules
 * are additionally pinned by the fixture corpora under `architecture/fixtures/`.
 *
 * HOW IT READS CODE. TypeScript AST for `.ts`, so a comment or a sentence mentioning
 * an event type cannot trigger it — only string- and template-valued expressions are
 * inspected, through the shared resolver. Migrations are read as text with `--` and
 * block comments stripped first, for the same reason. Two production files are
 * EXCLUDED from the name scan and the run prints both: the inventory itself (it is the
 * declaration — scanning it would make every entry self-satisfying and the staleness
 * rules vacuous) and this file (it holds the patterns, not any event type or audit
 * write).
 *
 * WHAT IT DOES NOT SEE, stated plainly, each residue named in
 * `docs/identity/KNOWN-LIMITATIONS.md` and each one demonstrated by a fixture in
 * `architecture/fixtures/audit-inventory-residue/` that this gate ACCEPTS:
 *
 *   - AN EVENT TYPE WHOSE ROOT *AND* FAMILY ARE BOTH ASSEMBLED — `${a}${b}.renamed`,
 *     `${root}.${family}.renamed`. Step 2 needs one of the two to be readable; where
 *     NEITHER THE ROOT NOR A DECLARED FAMILY can be read, nothing identifies the string
 *     as an event type at all, and reporting every unresolvable string in the repository
 *     would make the gate unusable. Such a write is still confined to a declared writer
 *     file by step 3.
 *   - AN AUDIT EVENT TYPE OUTSIDE THE `identity.` NAMESPACE, which is reached only
 *     through the declared-writer rule — a rule about FILES rather than names.
 *   - A MIGRATION THAT ASSEMBLED AN EVENT TYPE IN PL/pgSQL `format()`, caught only by
 *     the "no static event type in this insert" rule, which is position-free and
 *     therefore coarse.
 *   - EVERYTHING THE SHARED RESOLVER CANNOT SEE — values crossing a function
 *     boundary, array mutation other than `push`, object KEYS, strings produced at run
 *     time, and its depth and breadth limits. `scripts/static-string-resolver.ts`
 *     states that list; this gate inherits it.
 */
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join, relative } from 'path';
import * as ts from 'typescript';
import {
  UNRESOLVABLE_MARK_PATTERN,
  createStaticStringResolver,
  typeScriptSources,
} from './static-string-resolver';
import {
  AUDIT_EVENT_WRITERS,
  IDENTITY_AUDIT_FAMILIES,
  IDENTITY_AUDIT_INVENTORY,
  IDENTITY_AUDIT_NAMESPACE,
  IDENTITY_NON_AUDIT_NAMESPACE_LITERALS,
  REQUIRED_IDENTITY_AUDIT_TRANSITIONS,
  type IdentityAuditInventoryEntry,
  type IdentityAuditWriter,
  type IdentityNonAuditNamespaceLiteral,
} from '@dealer/identity-access';

const ROOT = join(__dirname, '..');
const PRODUCTION_ROOTS = ['apps', 'packages', 'scripts'];

/** The audit table this gate is about. */
const AUDIT_TABLE = 'audit_events';

/**
 * The phrase used in this file's own MESSAGES, spelled out rather than assembled.
 *
 * `scripts/check-owned-mutations.ts` rule 3 refuses any statement whose table position is
 * an interpolation, because an interpolated table is the one construction that can hide a
 * write from every other rule. A message template that interpolated the table name is
 * indistinguishable from that construction to an AST reader, and weakening the guard so it
 * could tell prose from SQL would be the wrong trade. `audit_events` carries no
 * `authorization_version`, so it is not an owned table and the spelled-out literal is
 * invisible to that guard.
 */
const AUDIT_WRITE_PHRASE = 'INSERT INTO audit_events';

/**
 * TEST-ONLY code, excluded from the PRODUCTION scan: a test naming an event type is
 * asserting on it, not writing it, and `resetDatabase` truncates the table.
 */
const TEST_ONLY_PREFIXES = ['packages/test-kit/', 'tests/'];

/**
 * The two files excluded from the name scan, each with the reason. Printed on
 * every run: an exclusion nobody can see is the shape of the defect this gate closes.
 */
export const SCAN_EXCLUSIONS: ReadonlyArray<{ file: string; because: string }> = [
  {
    file: 'packages/identity-access/src/audit-inventory.ts',
    because:
      'it IS the declaration — scanning it would make every entry self-satisfying and ' +
      'the staleness rules vacuous',
  },
  {
    file: 'scripts/check-audit-inventory.ts',
    because: 'it holds the patterns, and no event type and no audit write of its own',
  },
];

export interface Violation {
  file: string;
  line: number;
  rule: string;
  detail: string;
}

/**
 * EVERYTHING THE RULES ARE JUDGED AGAINST, as a value rather than as a set of
 * imports. The real declaration is `DECLARED` below; a test supplies a synthetic one,
 * which is how each rule is driven in isolation and how "this rule has a test that
 * dies when the rule is removed" became demonstrable instead of asserted.
 */
export interface AuditInventoryDeclaration {
  readonly root: string;
  /** Where a violation about the declaration itself is filed. */
  readonly declarationFile: string;
  readonly namespace: string;
  readonly families: readonly string[];
  readonly inventory: readonly IdentityAuditInventoryEntry[];
  readonly nonAudit: readonly IdentityNonAuditNamespaceLiteral[];
  readonly writers: readonly IdentityAuditWriter[];
  readonly required: readonly string[];
}

export const DECLARED: AuditInventoryDeclaration = {
  root: ROOT,
  declarationFile: SCAN_EXCLUSIONS[0]!.file,
  namespace: IDENTITY_AUDIT_NAMESPACE,
  families: IDENTITY_AUDIT_FAMILIES,
  inventory: IDENTITY_AUDIT_INVENTORY,
  nonAudit: IDENTITY_NON_AUDIT_NAMESPACE_LITERALS,
  writers: AUDIT_EVENT_WRITERS,
  required: REQUIRED_IDENTITY_AUDIT_TRANSITIONS,
};

// ── the patterns, derived from the declaration ─────────────────────────────

/**
 * `identity.<family>.<name>`, at least two segments after the root, built from the
 * namespace constant the inventory exports so the two cannot drift apart.
 *
 * The segments are LOWERCASE, which is also what keeps a rendered unresolvable mark
 * (`UNRESOLVABLE_FRAGMENT_1`) from being mistaken for a segment: `identity.support.`
 * followed by the mark is an assembled name, not a readable one, and it is judged as
 * such by `assembledTail` rather than recorded as a literal.
 */
export function namespacePatterns(decl: AuditInventoryDeclaration): {
  namespaced: RegExp;
  assembledTail: RegExp;
  assembledRoot: RegExp;
  auditWrite: RegExp;
} {
  const root = decl.namespace.replace(/[.]/g, '\\.');
  return {
    namespaced: new RegExp(`\\b${root}[a-z0-9_]+(?:\\.[a-z0-9_]+)+`, 'g'),
    // The root is readable; what follows it is not.
    assembledTail: new RegExp(`${root}[a-z0-9_.]*${UNRESOLVABLE_MARK_PATTERN}`),
    // The root is NOT readable, but a DECLARED FAMILY and a name follow it — which
    // is enough to know this string is an event type in the inventoried namespace.
    assembledRoot: new RegExp(
      `${UNRESOLVABLE_MARK_PATTERN}\\.(?:${decl.families.join('|')})\\.[a-z0-9_]+`,
    ),
    auditWrite: new RegExp(`INSERT\\s+INTO\\s+${AUDIT_TABLE}\\b`, 'i'),
  };
}

const RULE_MISSING = 'audit-event-type-missing-from-inventory';
const RULE_ASSEMBLED = 'audit-event-type-assembled-at-run-time';
const RULE_ASSEMBLED_ROOT = 'audit-event-type-namespace-root-assembled-at-run-time';
const RULE_UNDECLARED_WRITER = 'audit-write-outside-declared-writer';
const RULE_MIGRATION_DYNAMIC = 'migration-audit-write-has-no-static-event-type';
const RULE_ENTRY_UNWRITTEN = 'inventory-entry-has-no-production-writer';
const RULE_NON_AUDIT_STALE = 'non-audit-literal-declaration-is-stale';
const RULE_WRITER_STALE = 'audit-writer-declaration-is-stale';

// ── file discovery ─────────────────────────────────────────────────────────

function rel(absolute: string): string {
  return relative(ROOT, absolute).split('\\').join('/');
}

// ── the shared resolver, configured for this gate ──────────────────────────

/**
 * No pin: this gate wants every reference EXPANDED. The role-bindings guard pins its
 * shared predicate because the absence of its three conditions as typed text is what
 * its rules turn on; here, a constant holding half a name is exactly the thing that
 * must be substituted before the name is judged.
 */
const RESOLVER = createStaticStringResolver({ root: ROOT });

/** Strips `--` line comments and block comments, preserving offsets with spaces. */
export function withoutSqlComments(sql: string): string {
  let out = sql;
  const blank = (from: number, length: number): void => {
    out = out.slice(0, from) + ' '.repeat(length) + out.slice(from + length);
  };
  for (const m of sql.matchAll(/--[^\n]*/g)) blank(m.index ?? 0, m[0].length);
  for (const m of sql.matchAll(/\/\*[\s\S]*?\*\//g)) blank(m.index ?? 0, m[0].length);
  return out;
}

function lineAt(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

// ── the scan ───────────────────────────────────────────────────────────────

export interface Scan {
  /** name → the `file:line` sites it appears at. */
  readonly sites: Map<string, string[]>;
  /** repository-relative files holding an `INSERT INTO audit_events`. */
  readonly writers: Set<string>;
  readonly violations: Violation[];
  readonly filesScanned: number;
}

export function scan(targets: readonly string[], decl: AuditInventoryDeclaration): Scan {
  const { namespaced, assembledTail, assembledRoot, auditWrite } = namespacePatterns(decl);
  const sites = new Map<string, string[]>();
  const writers = new Set<string>();
  const violations: Violation[] = [];
  const excluded = new Set(SCAN_EXCLUSIONS.map((e) => e.file));
  const seen = new Set<string>();
  let filesScanned = 0;

  const record = (name: string, at: string): void => {
    const list = sites.get(name) ?? [];
    if (!list.includes(at)) list.push(at);
    sites.set(name, list);
  };

  for (const target of targets) {
    for (const file of typeScriptSources(join(ROOT, target))) {
      const path = rel(file);
      if (seen.has(path)) continue;
      seen.add(path);
      if (excluded.has(path)) continue;
      if (TEST_ONLY_PREFIXES.some((p) => path.startsWith(p))) continue;
      filesScanned += 1;
      const mod = RESOLVER.loadModule(file);
      if (mod === null) continue;
      const sf = mod.sf;

      const visit = (node: ts.Node): void => {
        // A NAME IS JUDGED WHERE IT IS ASSEMBLED — the shared resolver's own
        // definition of an assembly point, so `NS + '.quarantined'` and
        // `` `${NS}.quarantined` `` are each one name here rather than two
        // fragments neither of which is a name.
        if (!RESOLVER.isAssemblyPoint(node, mod)) {
          ts.forEachChild(node, visit);
          return;
        }
        const rendered = RESOLVER.render(node, mod);
        if (rendered === undefined) {
          ts.forEachChild(node, visit);
          return;
        }
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        const at = `${path}:${line}`;
        let judged = false;
        for (const variant of rendered.variants) {
          for (const m of variant.matchAll(namespaced)) {
            record(m[0], at);
            judged = true;
          }
          if (auditWrite.test(variant)) {
            writers.add(path);
            judged = true;
          }
        }
        const unreadable = [...new Set(rendered.unresolved)].map((u) => `\`${u}\``).join(', ');
        if (rendered.variants.some((v) => assembledTail.test(v))) {
          violations.push({
            file: path,
            line,
            rule: RULE_ASSEMBLED,
            detail:
              `a name inside the ${decl.namespace} namespace is assembled from ` +
              `${unreadable === '' ? 'a value this gate cannot resolve' : unreadable} — it ` +
              'cannot be read statically and so cannot be inventoried',
          });
          judged = true;
        }
        if (rendered.variants.some((v) => assembledRoot.test(v))) {
          violations.push({
            file: path,
            line,
            rule: RULE_ASSEMBLED_ROOT,
            detail:
              `a declared family follows ${unreadable === '' ? 'an unresolvable value' : unreadable}, ` +
              `so this is a name in the ${decl.namespace} namespace whose ROOT is assembled — ` +
              'it cannot be read statically and so cannot be inventoried',
          });
          judged = true;
        }
        if (
          rendered.overflowed &&
          rendered.variants.some((v) => v.includes(decl.namespace)) &&
          !rendered.variants.some((v) => assembledTail.test(v) || assembledRoot.test(v))
        ) {
          violations.push({
            file: path,
            line,
            rule: RULE_ASSEMBLED,
            detail:
              `too many possible strings to read them all, and one of them names the ` +
              `${decl.namespace} namespace — this gate cannot enumerate the event types here`,
          });
          judged = true;
        }
        // A name is judged once, whole: its own fragments are not re-judged.
        if (!judged) ts.forEachChild(node, visit);
      };
      visit(sf);
    }
  }

  return { sites, writers, violations, filesScanned };
}

/**
 * ONE MIGRATION, read as text: migrations are production audit writers too, and they
 * cannot interpolate a TypeScript constant, so the shared resolver has nothing to
 * resolve here.
 */
export function checkMigrationText(
  path: string,
  raw: string,
  decl: AuditInventoryDeclaration,
): { sites: Map<string, string[]>; violations: Violation[] } {
  const { namespaced } = namespacePatterns(decl);
  const sites = new Map<string, string[]>();
  const violations: Violation[] = [];
  const sql = withoutSqlComments(raw);
  for (const m of sql.matchAll(new RegExp(`'(${namespaced.source})'`, 'g'))) {
    const list = sites.get(m[1]!) ?? [];
    list.push(`${path}:${lineAt(sql, m.index ?? 0)}`);
    sites.set(m[1]!, list);
  }
  // Every audit write in a migration must carry a STATIC event type: an event
  // type assembled in PL/pgSQL would be invisible to the name scan.
  for (const m of sql.matchAll(new RegExp(`INSERT\\s+INTO\\s+${AUDIT_TABLE}\\b`, 'gi'))) {
    const from = m.index ?? 0;
    const semicolon = sql.indexOf(';', from);
    const statement = sql.slice(from, semicolon === -1 ? sql.length : semicolon);
    if (!new RegExp(`'${namespaced.source}'`).test(statement)) {
      violations.push({
        file: path,
        line: lineAt(sql, from),
        rule: RULE_MIGRATION_DYNAMIC,
        detail:
          `an ${AUDIT_WRITE_PHRASE} whose statement carries no ` +
          `'${decl.namespace}…' literal — the event type cannot be inventoried`,
      });
    }
  }
  return { sites, violations };
}

function scanMigrations(decl: AuditInventoryDeclaration): {
  sites: Map<string, string[]>;
  violations: Violation[];
  files: number;
} {
  const sites = new Map<string, string[]>();
  const violations: Violation[] = [];
  const dir = join(ROOT, 'migrations');
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    const path = `migrations/${file}`;
    const one = checkMigrationText(path, readFileSync(join(dir, file), 'utf8'), decl);
    for (const [name, at] of one.sites) sites.set(name, [...(sites.get(name) ?? []), ...at]);
    violations.push(...one.violations);
  }
  return { sites, violations, files: files.length };
}

// ── the inventory's own consistency ────────────────────────────────────────

/**
 * THE DECLARATION IS CHECKED AGAINST ITSELF. Thirteen rules, each with a test in
 * `tests/audit-inventory-rules.test.ts` that fails when that rule alone is deleted.
 */
export function checkInventoryShape(decl: AuditInventoryDeclaration): Violation[] {
  const violations: Violation[] = [];
  const at = (rule: string, detail: string): void => {
    violations.push({ file: decl.declarationFile, line: 0, rule, detail });
  };
  const families = new Set<string>(decl.families);
  const transitions = new Set<string>();
  const eventTypes = new Set<string>();
  const rootSegment = decl.namespace.replace('.', '');

  for (const entry of decl.inventory) {
    if (transitions.has(entry.transition)) {
      at('duplicate-inventory-transition', `${entry.transition} is listed twice`);
    }
    transitions.add(entry.transition);
    if (eventTypes.has(entry.eventType)) {
      at('duplicate-inventory-event-type', `${entry.eventType} is listed twice`);
    }
    eventTypes.add(entry.eventType);

    const segments = entry.eventType.split('.');
    if (segments[0] !== rootSegment || segments.length < 3) {
      at(
        'inventory-event-type-outside-the-namespace',
        `${entry.eventType} is not of the form ${decl.namespace}<family>.<name>`,
      );
      continue;
    }
    if (!families.has(entry.family)) {
      at('inventory-entry-family-undeclared', `${entry.family} is not a declared family`);
    }
    if (segments[1] !== entry.family) {
      at(
        'inventory-entry-family-mismatch',
        `${entry.eventType} sits in family '${segments[1]!}' but the entry declares ` +
          `'${entry.family}'`,
      );
    }
    // The proof citation must be verifiable, not prose.
    const proof = join(decl.root, entry.provenIn);
    if (!existsSync(proof)) {
      at(
        'inventory-proof-citation-is-not-verifiable',
        `${entry.transition} cites ${entry.provenIn}, which does not exist`,
      );
    } else if (!readFileSync(proof, 'utf8').includes(entry.provenBy)) {
      at(
        'inventory-proof-citation-is-not-verifiable',
        `${entry.transition} cites "${entry.provenBy}" in ${entry.provenIn}, ` +
          'which does not contain that string',
      );
    }
    if (entry.writtenBy.length === 0 || entry.entityType.length === 0) {
      at('inventory-entry-incomplete', `${entry.transition} must name its writer and entity type`);
    }
  }

  for (const required of decl.required) {
    if (!transitions.has(required)) {
      at(
        'required-transition-missing-from-inventory',
        `${required} is enumerated by the order and has no entry`,
      );
    }
  }

  for (const writer of decl.writers) {
    if (!existsSync(join(decl.root, writer.file))) {
      at('declared-writer-does-not-exist', writer.file);
    }
    if (writer.because.length === 0) {
      at('declared-writer-has-no-reason', writer.file);
    }
    if (!writer.enumerable && writer.namespace.startsWith(decl.namespace)) {
      at(
        'non-enumerable-writer-inside-the-inventoried-namespace',
        `${writer.file} writes ${writer.namespace} and declares itself non-enumerable — ` +
          'that would be a hole in the inventory, not a residue outside it',
      );
    }
  }
  for (const declared of decl.nonAudit) {
    if (eventTypes.has(declared.literal)) {
      at(
        'literal-declared-both-audit-and-non-audit',
        `${declared.literal} is an inventory event type AND declared a non-audit literal`,
      );
    }
    if (declared.role.length === 0 || declared.because.length === 0) {
      at('non-audit-literal-has-no-reason', declared.literal);
    }
  }
  return violations;
}

// ── the forward, writer and reverse directions ─────────────────────────────

/** FORWARD: every name found is accounted for. */
export function checkAccounting(
  decl: AuditInventoryDeclaration,
  sites: ReadonlyMap<string, readonly string[]>,
): Violation[] {
  const inventoried = new Set(decl.inventory.map((e) => e.eventType));
  const nonAudit = new Set(decl.nonAudit.map((d) => d.literal));
  const violations: Violation[] = [];
  for (const [name, at] of [...sites].sort()) {
    if (inventoried.has(name) || nonAudit.has(name)) continue;
    const first = at[0] ?? ':0';
    violations.push({
      file: first.split(':')[0]!,
      line: Number(first.split(':')[1] ?? 0),
      rule: RULE_MISSING,
      detail:
        `'${name}' appears in production code and is neither an inventory entry nor a ` +
        `declared non-audit literal (sites: ${at.join(', ')})`,
    });
  }
  return violations;
}

/** WRITERS: every audit write sits in a declared writer file. */
export function checkUndeclaredWriters(
  decl: AuditInventoryDeclaration,
  writers: Iterable<string>,
): Violation[] {
  const declared = new Set(decl.writers.map((w) => w.file));
  const violations: Violation[] = [];
  for (const writer of [...writers].sort()) {
    if (declared.has(writer)) continue;
    violations.push({
      file: writer,
      line: 0,
      rule: RULE_UNDECLARED_WRITER,
      detail:
        `holds an ${AUDIT_WRITE_PHRASE} and is not in AUDIT_EVENT_WRITERS — a new ` +
        'audit namespace must be a decision visible in the inventory, not a new file',
    });
  }
  return violations;
}

/**
 * REVERSE. A list that is complete and STALE is still a lie. Whole-tree runs only:
 * with extra targets the scan is not the full tree, so "found nowhere" would be an
 * artefact of the narrowed scope rather than a fact.
 */
export function checkStaleness(
  decl: AuditInventoryDeclaration,
  sites: ReadonlyMap<string, readonly string[]>,
  writers: ReadonlySet<string>,
): Violation[] {
  const violations: Violation[] = [];
  for (const entry of decl.inventory) {
    if (sites.has(entry.eventType)) continue;
    violations.push({
      file: decl.declarationFile,
      line: 0,
      rule: RULE_ENTRY_UNWRITTEN,
      detail: `${entry.transition} claims to write '${entry.eventType}', which appears in no production source`,
    });
  }
  for (const declared of decl.nonAudit) {
    if (sites.has(declared.literal)) continue;
    violations.push({
      file: decl.declarationFile,
      line: 0,
      rule: RULE_NON_AUDIT_STALE,
      detail: `'${declared.literal}' is declared a non-audit literal and appears nowhere`,
    });
  }
  for (const writer of decl.writers) {
    if (writers.has(writer.file)) continue;
    violations.push({
      file: writer.file,
      line: 0,
      rule: RULE_WRITER_STALE,
      detail: `declared an audit writer and holds no ${AUDIT_WRITE_PHRASE} any more`,
    });
  }
  return violations;
}

// ── the run ────────────────────────────────────────────────────────────────

function main(): void {
  const extra = process.argv.slice(2);
  const wholeTree = extra.length === 0;
  const decl = DECLARED;
  const code = scan([...PRODUCTION_ROOTS, ...extra], decl);
  const migrations = scanMigrations(decl);
  const violations: Violation[] = [
    ...checkInventoryShape(decl),
    ...code.violations,
    ...migrations.violations,
  ];

  // one merged site map: production TypeScript + the migrations
  const sites = new Map<string, string[]>(code.sites);
  for (const [name, at] of migrations.sites) {
    sites.set(name, [...(sites.get(name) ?? []), ...at]);
  }

  const inventoried = new Map(decl.inventory.map((e) => [e.eventType, e]));
  const nonAudit = new Map(decl.nonAudit.map((d) => [d.literal, d]));

  violations.push(...checkAccounting(decl, sites));
  violations.push(...checkUndeclaredWriters(decl, code.writers));
  if (wholeTree) violations.push(...checkStaleness(decl, sites, code.writers));

  // ── the report: what was found, and what became of it ──────────────────
  console.log(
    `audit inventory: ${decl.inventory.length} entries over ` +
      `${decl.families.length} declared families ` +
      `(${decl.families.join(', ')})`,
  );
  console.log(
    `scanned ${code.filesScanned} production TypeScript file(s) and ` +
      `${migrations.files} migration(s); ${sites.size} distinct ` +
      `${decl.namespace}* name(s) found`,
  );
  for (const exclusion of SCAN_EXCLUSIONS) {
    console.log(`  excluded from the name scan: ${exclusion.file} — ${exclusion.because}`);
  }
  for (const [name, at] of [...sites].sort()) {
    const entry = inventoried.get(name);
    const declared = nonAudit.get(name);
    const disposition = entry
      ? `INVENTORY ${entry.family}/${entry.transition}`
      : declared
        ? `NOT AN EVENT: ${declared.role}`
        : 'UNACCOUNTED FOR';
    console.log(`  ${name} → ${disposition} [${at.length} site(s)]`);
  }
  for (const writer of decl.writers) {
    console.log(
      `  writer ${writer.file} → ${writer.namespace}` +
        `${writer.enumerable ? ' (enumerable)' : ' (NOT statically enumerable — declared residue)'}`,
    );
  }

  if (violations.length > 0) {
    console.error('');
    for (const v of violations.sort((a, b) =>
      a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file),
    )) {
      console.error(`  error ${v.rule}: ${v.file}:${v.line} — ${v.detail}`);
    }
    console.error(
      `\naudit-inventory gate FAILED with ${violations.length} violation(s). Either add the ` +
        'event type to IDENTITY_AUDIT_INVENTORY with the transition and the test that proves ' +
        'it, or declare it in IDENTITY_NON_AUDIT_NAMESPACE_LITERALS with the reason it is not ' +
        'an audit event.',
    );
    process.exit(1);
  }
  console.log('\naudit-inventory gate PASSED: every production audit event type is accounted for');
}

// Importable by the suite without running the CLI: every rule is TESTED, not assumed.
if (require.main === module) main();
