/**
 * FBL-020-R4 §5 — THE OWNED MUTATION BOUNDARY, ENFORCED BEYOND `apps`.
 *
 *   npx tsx scripts/check-owned-mutations.ts [root-or-file...]
 *   (default roots: apps packages scripts tests)
 *
 * WHY THIS EXISTS. Every authorization-state write is supposed to name its true
 * actor, advance the row's `authorization_version` and leave exactly one audit event
 * in the same transaction. Three revisions running, that rule was kept by convention
 * and broken by convention: `@dealer/organization`'s repository exported six
 * unattributed writes to the organization hierarchy (archiving a rooftop revokes
 * every binding beneath it — a mass revocation nobody performed), the bootstrap
 * script held six more of its own, and the suite wrote authorization state raw in
 * about a hundred places. `check-app-sql.ts` could not see any of it, because it only
 * ever looked at `apps/`. This guard looks at the packages, the scripts and the
 * tests.
 *
 * WHAT COUNTS AS AUTHORIZATION STATE — DERIVED, NOT LISTED. The owned tables are
 * exactly the tables that carry an `authorization_version` column, and this file
 * READS THE MIGRATIONS to find them rather than hard-coding a list. A future
 * migration that versions a new table therefore brings it under this boundary
 * automatically, and a list nobody remembered to update cannot be the reason a hole
 * opens. The derived set is printed on every run so it is visible rather than
 * assumed.
 *
 * THE FIVE RULES.
 *
 *   1. owned-mutation-write-outside-owner — in PRODUCTION code (apps, packages
 *      except test-kit, scripts) a write to an owned table may appear ONLY in a
 *      DECLARED OWNER file. The declarations are below, each with the reason it is
 *      the owner; there is no wildcard and no per-site opt-out.
 *
 *   2. fixture-authorization-write-must-be-declared — in TEST code (tests/, and
 *      @dealer/test-kit, which is test-only) such a write must be an ARGUMENT TO
 *      `fixtureAuthorizationStateWrite`. Fixtures legitimately need states the
 *      production services refuse to create (an expired window, a revoked binding, a
 *      link outside its effective window), so the requirement is not "never" — it is
 *      that every one of them is named, typed with a reason, counted, and unable to
 *      run outside a disposable test database.
 *
 *   3. owned-mutation-target-not-statically-resolvable — a write whose TABLE comes
 *      from an interpolation (`UPDATE ${table} SET …`) is refused wherever it
 *      appears. This is not hypothetical: the `setUnitStatus` this order deletes was
 *      exactly that shape, and it is the one construction that would let a write to
 *      an owned table hide from every rule above.
 *
 *   4. owned-mutation-owner-declaration-is-stale — a declared owner that contains no
 *      owned write any more. An exemption whose reason has gone is an exemption
 *      waiting to be reused for something nobody argued for.
 *
 *   5. test-kit-must-not-be-imported-by-production — the fixture primitive's
 *      unreachability from production rests on this, so it is checked here rather
 *      than assumed from the dependency manifest.
 *
 * HOW IT READS CODE. TypeScript AST, not grep: comments and prose cannot trigger it
 * (only string and template literals are inspected), and the write must name an
 * owned table immediately after INSERT INTO / UPDATE / DELETE FROM, so `-- UPDATE
 * user_links …` in a comment and the word "update" in a sentence are both invisible.
 * Template literals are rendered with their interpolations replaced by a marker, so a
 * statement assembled across lines is still judged as one statement.
 *
 * WHAT IT DOES NOT SEE, stated plainly: SQL built by string concatenation or
 * assembled through a helper's parameters, and SQL read from a file at run time.
 * Rule 3 removes the only such shape this repository has (an interpolated table
 * position), and rules 1 and 2 are anchored on the OWNER FILE rather than on the call
 * site, so hiding a statement's text does not move the file it lives in.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import * as ts from 'typescript';

const ROOT = join(__dirname, '..');
const DEFAULT_ROOTS = ['apps', 'packages', 'scripts', 'tests'];

/** The one function a test-side authorization-state write may travel through. */
const FIXTURE_PRIMITIVE = 'fixtureAuthorizationStateWrite';

/** Where that function lives — the only test file allowed to hold the executor. */
const FIXTURE_PRIMITIVE_FILE = 'packages/test-kit/src/fixture-primitives.ts';

/**
 * THE DECLARED OWNERS, each with the reason it owns what it owns.
 *
 * A file is listed here only if the writes in it satisfy the attribution contract or
 * are the documented origin of trust. Adding a file to this list is a decision a
 * reviewer sees in the diff of THIS file, which is the point of keeping the list here
 * rather than in a comment beside the write.
 */
const OWNERS: ReadonlyArray<{ file: string; because: string }> = [
  {
    file: 'packages/identity-access/src/mutations.ts',
    because:
      'the owned mutation services: every write takes an existing acting user link, ' +
      'advances authorization_version, and writes one audit row in the same transaction',
  },
  {
    file: 'packages/identity-access/src/bootstrap.ts',
    because:
      'the ORIGIN OF TRUST: it mints the first administrator link and attributes the ' +
      'tenant, connection and first role binding to it, in one transaction',
  },
  {
    file: 'packages/identity-access/src/session.ts',
    because:
      'the session lifecycle owner — identity_sessions rows are credential state, ' +
      'created, rotated and revoked here with an audit row for each transition',
  },
  {
    file: 'packages/identity-access/src/user-link.ts',
    because:
      'the LOGIN OBSERVATION path: it refreshes bounded provider identifiers and ' +
      'records a pending link, each audited, and deliberately advances no version ' +
      'because neither grants anything (the lifecycle mutations are in mutations.ts)',
  },
];

// FIXTURE_PRIMITIVE_FILE is deliberately NOT an owner: it holds no SQL of its own (the
// statement is its caller's argument), so declaring it here would immediately be a
// stale exemption under rule 4. Rule 2 exempts it by name instead.

/** Roots whose files are TEST code: rule 2 applies instead of rule 1. */
function isTestFile(rel: string): boolean {
  return rel.startsWith('tests/') || rel.startsWith('packages/test-kit/');
}

interface Violation {
  file: string;
  line: number;
  rule: string;
  detail: string;
}

function sources(target: string): string[] {
  const full = join(ROOT, target);
  if (!existsSync(full)) return [];
  if (statSync(full).isFile()) {
    return full.endsWith('.ts') && !full.endsWith('.d.ts') ? [full] : [];
  }
  return readdirSync(full).flatMap((entry) => {
    const child = join(full, entry);
    if (statSync(child).isDirectory()) {
      return entry === 'node_modules' || entry === 'dist'
        ? []
        : sources(relative(ROOT, child).split('\\').join('/'));
    }
    return child.endsWith('.ts') && !child.endsWith('.d.ts') ? [child] : [];
  });
}

// ── the owned table set, derived from the migrations ───────────────────────

const TABLE_DECL =
  /\b(?:CREATE\s+TABLE|ALTER\s+TABLE)\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)/gi;

/**
 * THE DECLARED EXPECTATION, cross-checked against the derivation below.
 *
 * The derivation is what keeps the guard current; this list is what makes a CHANGE in
 * the derivation visible. If a migration versions a new table the run FAILS with both
 * sets printed, and whoever added the table decides — deliberately, in a diff — that
 * it is owned authorization state. Derivation alone could quietly start covering less
 * (a migration written in a shape the parser cannot read); a list alone would quietly
 * go stale. Both, disagreeing loudly, is the only combination that cannot rot.
 */
const EXPECTED_OWNED_TABLES = [
  'dealer_groups',
  'departments',
  'identity_provider_connections',
  'identity_sessions',
  'legal_entities',
  'role_bindings',
  'rooftops',
  'support_access_requests',
  'support_access_sessions',
  'tenants',
  'user_links',
] as const;

/**
 * Every table that carries `authorization_version`, read out of the migrations.
 *
 * Two shapes appear in this repository and both are handled:
 *
 *   - the ordinary one, `ALTER TABLE x ADD COLUMN authorization_version …` (or a
 *     CREATE TABLE that declares it), attributed to the nearest preceding
 *     CREATE/ALTER TABLE;
 *   - migration 056's `DO $$ … FOREACH t IN ARRAY ARRAY['tenants','dealer_groups',…]
 *     … EXECUTE format('ALTER TABLE %I ADD COLUMN authorization_version …', t) … $$`,
 *     where the table names exist only as an array of literals. A DO block that
 *     mentions the column contributes EVERY table name quoted inside its array
 *     literals. Missing this shape is not a hypothetical: the five organization
 *     tables — the very ones this order's §5 is about — are versioned only there.
 *
 * A mention that can be attributed to neither is a hard failure, never a skipped line:
 * a guard that silently narrows its own scope is worse than no guard.
 */
function ownedTables(): { tables: Set<string>; failures: string[] } {
  const tables = new Set<string>();
  const failures: string[] = [];
  const dir = join(ROOT, 'migrations');
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    const original = readFileSync(join(dir, file), 'utf8');
    // 1. DO blocks first, then MASKED OUT (replaced by spaces so every remaining
    //    offset still matches the original file) before the ordinary pass runs.
    let sql = original;
    const doBlock = /DO\s+\$\$[\s\S]*?\$\$/gi;
    for (let m = doBlock.exec(original); m !== null; m = doBlock.exec(original)) {
      const block = m[0];
      if (/\bauthorization_version\b/i.test(block)) {
        const arrays = /ARRAY\s*\[([^\]]*)\]/gi;
        let named = 0;
        for (let a = arrays.exec(block); a !== null; a = arrays.exec(block)) {
          for (const quoted of a[1]!.matchAll(/'([a-z_][a-z0-9_]*)'/gi)) {
            tables.add(quoted[1]!.toLowerCase());
            named += 1;
          }
        }
        if (named === 0) {
          failures.push(
            `${file}: a DO block at offset ${m.index} versions tables this parser cannot name`,
          );
        }
      }
      sql = sql.slice(0, m.index) + ' '.repeat(block.length) + sql.slice(m.index + block.length);
    }
    // 2. the ordinary CREATE/ALTER attribution, over everything outside those blocks
    const declarations: Array<{ index: number; table: string }> = [];
    TABLE_DECL.lastIndex = 0;
    for (let m = TABLE_DECL.exec(sql); m !== null; m = TABLE_DECL.exec(sql)) {
      declarations.push({ index: m.index, table: m[1]!.toLowerCase() });
    }
    const column = /\bauthorization_version\b/gi;
    for (let m = column.exec(sql); m !== null; m = column.exec(sql)) {
      const at = m.index;
      const owner = [...declarations].reverse().find((d) => d.index < at);
      if (owner === undefined) {
        failures.push(
          `${file}: authorization_version at offset ${at} has no preceding CREATE/ALTER TABLE`,
        );
        continue;
      }
      tables.add(owner.table);
    }
  }
  return { tables, failures };
}

// ── statement inspection ──────────────────────────────────────────────────

const INTERPOLATION = '\u0001UNKNOWN\u0001';

/** Renders a string or template literal, with interpolations replaced by a marker. */
function rendered(node: ts.Node, sf: ts.SourceFile): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    let text = node.head.text;
    for (const span of node.templateSpans) {
      text += INTERPOLATION + span.literal.text;
    }
    return text;
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = rendered(node.left, sf);
    const right = rendered(node.right, sf);
    if (left === undefined && right === undefined) return undefined;
    return (left ?? INTERPOLATION) + (right ?? INTERPOLATION);
  }
  return undefined;
}

const WRITE_VERB = String.raw`(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)`;

function writeTargets(sql: string, tables: ReadonlySet<string>): string[] {
  const names = [...tables].sort();
  if (names.length === 0) return [];
  const re = new RegExp(
    String.raw`\b${WRITE_VERB}\s+(?:[a-z_][a-z0-9_]*\.)?(${names.join('|')})\b`,
    'gi',
  );
  const hits = new Set<string>();
  for (let m = re.exec(sql); m !== null; m = re.exec(sql)) hits.add(m[1]!.toLowerCase());
  return [...hits];
}

/** True when the table position of a write is an interpolation (rule 3). */
function hasUnresolvableTarget(sql: string): boolean {
  return new RegExp(String.raw`\b${WRITE_VERB}\s+${INTERPOLATION}`, 'i').test(sql);
}

/**
 * Walks up from a literal to see whether it is an argument to the fixture primitive.
 * The literal may be nested (a parenthesised expression, a concatenation), so the walk
 * continues until it reaches a call whose callee names the primitive.
 */
function insideFixturePrimitive(node: ts.Node): boolean {
  for (let cur: ts.Node | undefined = node; cur !== undefined; cur = cur.parent) {
    if (ts.isCallExpression(cur)) {
      const callee = cur.expression;
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : undefined;
      if (name === FIXTURE_PRIMITIVE) return true;
    }
  }
  return false;
}

function checkFile(
  file: string,
  tables: ReadonlySet<string>,
): {
  violations: Violation[];
  wrote: boolean;
} {
  const rel = relative(ROOT, file).split('\\').join('/');
  const text = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.ES2022, true);
  const violations: Violation[] = [];
  let wrote = false;
  const owner = OWNERS.find((o) => o.file === rel);
  const test = isTestFile(rel);

  const lineOf = (node: ts.Node): number =>
    sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

  const visit = (node: ts.Node): void => {
    // rule 5: production code may not reach the test kit at all
    if (!test && ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const spec = node.moduleSpecifier.text;
      if (spec === '@dealer/test-kit' || spec.startsWith('@dealer/test-kit/')) {
        violations.push({
          file: rel,
          line: lineOf(node),
          rule: 'test-kit-must-not-be-imported-by-production',
          detail: `production code imports '${spec}', which holds the fixture-only write primitive`,
        });
      }
    }

    // Only judge the OUTERMOST assembled expression: a template inside a `+` chain is
    // reached through its parent, so judging both would report one statement twice.
    const isInnerPiece =
      node.parent !== undefined &&
      ((ts.isBinaryExpression(node.parent) &&
        node.parent.operatorToken.kind === ts.SyntaxKind.PlusToken) ||
        ts.isTemplateSpan(node.parent) ||
        ts.isTemplateExpression(node.parent));
    if (!isInnerPiece) {
      const sql = rendered(node, sf);
      if (sql !== undefined) {
        if (hasUnresolvableTarget(sql)) {
          wrote = true;
          violations.push({
            file: rel,
            line: lineOf(node),
            rule: 'owned-mutation-target-not-statically-resolvable',
            detail: 'the table a write targets comes from an interpolation',
          });
        }
        const targets = writeTargets(sql, tables);
        if (targets.length > 0) {
          wrote = true;
          if (test) {
            if (rel !== FIXTURE_PRIMITIVE_FILE && !insideFixturePrimitive(node)) {
              violations.push({
                file: rel,
                line: lineOf(node),
                rule: 'fixture-authorization-write-must-be-declared',
                detail:
                  `writes ${targets.join(', ')} outside ${FIXTURE_PRIMITIVE}() — a fixture ` +
                  'that changes authorization state must be a declared, reasoned bypass',
              });
            }
          } else if (owner === undefined) {
            violations.push({
              file: rel,
              line: lineOf(node),
              rule: 'owned-mutation-write-outside-owner',
              detail:
                `writes ${targets.join(', ')}, which is authorization state owned by the ` +
                'attributed mutation services in @dealer/identity-access',
            });
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { violations, wrote };
}

function main(): void {
  const args = process.argv.slice(2);
  const roots = args.length > 0 ? args : DEFAULT_ROOTS;
  const derived = ownedTables();
  const violations: Violation[] = [];
  const wroteByFile = new Set<string>();

  if (derived.failures.length > 0) {
    for (const f of derived.failures) console.error(`  error owned-table-derivation: ${f}`);
    console.error('owned-mutation guard FAILED: the owned table set could not be derived');
    process.exit(1);
  }
  if (derived.tables.size === 0) {
    console.error(
      'owned-mutation guard FAILED: no table in migrations/ carries authorization_version, ' +
        'so this guard would enforce nothing',
    );
    process.exit(1);
  }
  const derivedList = [...derived.tables].sort();
  const expected = [...EXPECTED_OWNED_TABLES].sort();
  if (derivedList.join(',') !== expected.join(',')) {
    console.error(
      'owned-mutation guard FAILED: the authorization-state tables derived from migrations ' +
        'do not match the declared set.\n' +
        `  derived : ${derivedList.join(', ')}\n` +
        `  declared: ${expected.join(', ')}\n` +
        '  If a migration versioned a new table, add it to EXPECTED_OWNED_TABLES ' +
        'deliberately — that is the decision this mismatch exists to force.',
    );
    process.exit(1);
  }

  for (const root of roots) {
    for (const file of sources(root)) {
      const result = checkFile(file, derived.tables);
      violations.push(...result.violations);
      if (result.wrote) wroteByFile.add(relative(ROOT, file).split('\\').join('/'));
    }
  }

  // rule 4: only meaningful on a full run — a targeted run over one fixture file has
  // no opinion about whether some other declared owner still writes.
  if (args.length === 0) {
    for (const owner of OWNERS) {
      if (!wroteByFile.has(owner.file)) {
        violations.push({
          file: owner.file,
          line: 1,
          rule: 'owned-mutation-owner-declaration-is-stale',
          detail:
            'declared as an owner of authorization-state writes but contains none — ' +
            'remove the declaration rather than leaving an unused exemption',
        });
      }
    }
  }

  console.log(
    `owned-mutation guard: ${derived.tables.size} authorization-state table(s) derived from ` +
      `migrations: ${[...derived.tables].sort().join(', ')}`,
  );
  if (violations.length > 0) {
    for (const v of violations) {
      console.error(`  error ${v.rule}: ${v.file}:${v.line} ${v.detail}`);
    }
    console.error(`owned-mutation guard FAILED: ${violations.length} violation(s)`);
    process.exit(1);
  }
  console.log(
    `owned-mutation guard OK (${roots.join(' ')}): every authorization-state write is in a ` +
      `declared owner or a reasoned fixture bypass`,
  );
}

main();
