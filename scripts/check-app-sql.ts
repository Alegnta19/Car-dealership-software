/**
 * FBL-010-R1 section E: apps are composition roots — no business SQL, no database
 * query primitives.
 *
 *   npx tsx scripts/check-app-sql.ts [rootDir...]      (default: apps)
 *
 * TypeScript AST inspection (compiler API already in the toolchain — no new
 * dependency), not a text grep: comments cannot trigger it, and aliased imports are
 * followed. For production TypeScript under the target roots it rejects:
 *
 *   1. importing `query`, `getPool` or `withTransaction` from @dealer/database
 *      (aliases included), or importing it as a namespace (which exposes them all);
 *   2. importing `pg` directly (the dependency-cruiser rule, mirrored here);
 *   3. calling a binding obtained from a forbidden @dealer/database import;
 *   4. SQL statement literals or templates (SELECT/INSERT/UPDATE/DELETE/CREATE/
 *      ALTER/DROP/WITH ...) anywhere in app production code, including as arguments
 *      to any `.query(...)`-shaped call.
 *
 * `closePool` (and type-only imports) stay allowed: the API composition root owns
 * process lifecycle shutdown.
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import * as ts from 'typescript';

const ROOT = join(__dirname, '..');
const FORBIDDEN_DB_IMPORTS = new Set(['query', 'getPool', 'withTransaction']);
const SQL_HEAD = /^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|WITH)\b/i;

interface Violation {
  file: string;
  line: number;
  rule: string;
  detail: string;
}

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      return entry === 'node_modules' || entry === 'dist' ? [] : sources(full);
    }
    return full.endsWith('.ts') && !full.endsWith('.d.ts') ? [full] : [];
  });
}

function checkFile(file: string): Violation[] {
  const rel = relative(ROOT, file).split('\\').join('/');
  const text = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.ES2022, true);
  const violations: Violation[] = [];
  const forbiddenLocals = new Set<string>();

  const lineOf = (node: ts.Node): number =>
    sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const flag = (node: ts.Node, rule: string, detail: string): void => {
    violations.push({ file: rel, line: lineOf(node), rule, detail });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const spec = node.moduleSpecifier.text;
      if (spec === 'pg' || spec.startsWith('pg/')) {
        flag(node, 'app-no-direct-pg', `imports '${spec}'`);
      }
      if (spec === '@dealer/database' && node.importClause && !node.importClause.isTypeOnly) {
        const bindings = node.importClause.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) {
          flag(
            node,
            'app-no-db-query-primitives',
            'namespace import of @dealer/database exposes query primitives',
          );
          forbiddenLocals.add(bindings.name.text);
        } else if (bindings && ts.isNamedImports(bindings)) {
          for (const el of bindings.elements) {
            if (el.isTypeOnly) continue;
            const imported = (el.propertyName ?? el.name).text;
            if (FORBIDDEN_DB_IMPORTS.has(imported)) {
              flag(el, 'app-no-db-query-primitives', `imports '${imported}' from @dealer/database`);
              forbiddenLocals.add(el.name.text);
            }
          }
        }
      }
    }

    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee) && forbiddenLocals.has(callee.text)) {
        flag(node, 'app-no-db-query-calls', `calls '${callee.text}(...)'`);
      }
      if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        forbiddenLocals.has(callee.expression.text)
      ) {
        flag(
          node,
          'app-no-db-query-calls',
          `calls '${callee.expression.text}.${callee.name.text}(...)'`,
        );
      }
    }

    let literalText: string | undefined;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      literalText = node.text;
    } else if (ts.isTemplateExpression(node)) {
      literalText = node.head.text;
    }
    if (literalText !== undefined && SQL_HEAD.test(literalText)) {
      flag(
        node,
        'app-no-sql-literals',
        `SQL statement literal: ${JSON.stringify(literalText.trim().slice(0, 60))}`,
      );
    }

    ts.forEachChild(node, visit);
  };
  visit(sf);
  return violations;
}

function main(): void {
  const roots = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ['apps'];
  const violations: Violation[] = [];
  for (const root of roots) {
    const full = join(ROOT, root);
    for (const file of sources(full)) {
      violations.push(...checkFile(file));
    }
  }
  if (violations.length > 0) {
    for (const v of violations) {
      console.error(`  error ${v.rule}: ${v.file}:${v.line} ${v.detail}`);
    }
    console.error(`app-SQL guard FAILED: ${violations.length} violation(s)`);
    process.exit(1);
  }
  console.log(
    `app-SQL guard OK (${roots.join(' ')}): no query primitives or SQL literals in app code`,
  );
}

main();
