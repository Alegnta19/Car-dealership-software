/**
 * FBL-020-R4 §3 correction F1a — THE ONE STATIC STRING RESOLVER, shared by every
 * gate that has to read a string the source assembles rather than spells.
 *
 * WHY THIS FILE EXISTS. `scripts/check-role-binding-effectiveness.ts` already owned
 * a static evaluator that resolves `+`, `+=`/`n = n + …` accumulation, `.join`,
 * `.concat`, `.toString`, `String()`, `String.raw`, indexed fragments, `.reduce`
 * accumulation, template tags, object and array literals, `for … of` element
 * bindings, `?:`/`??`/`||` alternatives and named, aliased, namespaced and
 * re-exported imports across files. `scripts/check-audit-inventory.ts` then shipped
 * a THIRD hand-written string analysis of its own — `node.head.text` and one regular
 * expression — and was defeated by `'identity.support' + '.quarantined'` and by
 * `` `${NS}.quarantined` ``, both of which the sibling guard's evaluator already
 * resolved. Three of R3's seventeen defects were duplicate hand-written predicates
 * drifting from a shared one; this file is why there is not a fourth.
 *
 * WHAT IS PARAMETERISED, and nothing else is: the repository root, the mark an
 * unresolvable piece renders as, the depth and breadth limits, and a PIN — a hook
 * letting a caller declare that one particular reference must render as an opaque
 * mark instead of being expanded (the role-bindings guard pins its shared
 * predicate, so its three conditions never appear as typed text). The RULES stay in
 * the gates: this file decides what a string says, never whether that is allowed.
 *
 * WHAT IT CANNOT SEE. Stated exactly, because a resolver that overstates its reach
 * is worse than one that states a narrow reach truthfully. Every caller inherits
 * these limits and each records them in its own header:
 *
 *   - VALUES CROSSING A FUNCTION BOUNDARY. Arguments are not followed into a helper
 *     and results are not followed back out, so `format('… %s …', TABLE)` is not
 *     resolved at the call site. The helper's OWN body is still in scope.
 *   - ARRAY MUTATION OTHER THAN `push` — `unshift`, `splice`, `parts[0] = …`.
 *   - OBJECT KEYS. `Object.values` of an object literal is resolved; the KEYS of one
 *     are not, so `Object.keys(FRAGMENTS).join('')` is not resolved.
 *   - STRINGS PRODUCED AT RUN TIME — `JSON.parse`, `Buffer.toString`, `eval`,
 *     `new Function`, or text read from a file or a database.
 *   - OPERATIONS THAT REWRITE RATHER THAN ASSEMBLE — `.replace`, `.slice`,
 *     `.split`, a case fold, a `.map`/`.filter`/`.sort` feeding a join, a template
 *     tag that is not `String.raw`. Their INPUT is rendered, so the statement is
 *     still recognisable, and the operation itself is reported as unresolvable:
 *     `Rendered.unresolved` names it. Treating them as identities would be a hole;
 *     skipping them would be silence.
 *   - DEPTH AND BREADTH LIMITS. Resolution stops at `resolveDepth` links and
 *     `variantCap` possibilities; an overflow renders as unresolvable.
 *   - SCOPE. There is no scope analysis: two locals of the same name in different
 *     functions are one name here and their values are merged. That is an
 *     over-approximation — every combination is produced — so a caller can report
 *     more than the code does, never less.
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { dirname, join, relative, resolve as resolvePath } from 'path';
import * as ts from 'typescript';

/** What an interpolation whose value cannot be determined renders as. */
export const UNRESOLVABLE_MARK = 'UNRESOLVABLE_FRAGMENT';

/**
 * A table/name position filled by something unresolvable, as the mark renders it:
 * `UNRESOLVABLE_FRAGMENT_1`, numbered so a statement with two blind pieces names
 * both.
 */
export const UNRESOLVABLE_MARK_PATTERN = String.raw`UNRESOLVABLE_FRAGMENT_\d+`;

/** An expression that resolves to many possible strings, beyond which we give up. */
const DEFAULT_VARIANT_CAP = 64;
/** Depth limit for the static evaluator, so a pathological file cannot hang it. */
const DEFAULT_RESOLVE_DEPTH = 16;

export function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Every `.ts` file (not `.d.ts`) under an absolute path, file or directory. */
export function typeScriptSources(target: string): string[] {
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
    return typeScriptSources(full);
  });
}

// ── the module graph the static evaluator walks ────────────────────────────

type Binding =
  | { readonly kind: 'value'; readonly expr: ts.Expression }
  | { readonly kind: 'element-of'; readonly expr: ts.Expression }
  | { readonly kind: 'property-of'; readonly expr: ts.Expression; readonly property: string };

export interface ModuleInfo {
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

export interface Decl {
  readonly mod: ModuleInfo;
  readonly name: string;
  readonly expr: ts.Expression;
}

export interface Site {
  readonly node: ts.Node;
  readonly mod: ModuleInfo;
}

export interface Rendered {
  /** Every string this expression could be, with pinned references marked. */
  readonly variants: string[];
  /** How each piece that could not be resolved is named. */
  readonly unresolved: string[];
  /** True when the expression had to be abandoned (too many possibilities). */
  readonly overflowed: boolean;
}

/** What a `pinned` hook is given so it can decide by IDENTITY rather than by text. */
export interface PinApi {
  resolveReference(node: ts.Node, mod: ModuleInfo): Decl | undefined;
}

export interface ResolverOptions {
  /** The repository root every module path is relative to. */
  readonly root: string;
  readonly unknownMark?: string;
  readonly variantCap?: number;
  readonly resolveDepth?: number;
  /**
   * A reference this caller does NOT want expanded, and the mark it renders as
   * instead. Returning `undefined` means "resolve it normally".
   */
  readonly pinned?: (node: ts.Node, mod: ModuleInfo, api: PinApi) => string | undefined;
}

export interface StaticStringResolver {
  readonly root: string;
  readonly unknownMark: string;
  /** Parse and index a file, cached. `null` when it is not a file. */
  loadModule(abs: string): ModuleInfo | null;
  /** The declaration a bare reference names, across imports and re-exports. */
  resolveReference(node: ts.Node, mod: ModuleInfo): Decl | undefined;
  /** Every string the expression could be. `undefined` means "cannot tell". */
  textValues(node: ts.Node, mod: ModuleInfo): string[] | undefined;
  /** Every string it could be, WITH the pieces that could not be resolved named. */
  render(node: ts.Node, mod: ModuleInfo): Rendered | undefined;
  /** Which string-assembly form a call is, if it is one at all. */
  assemblyMethod(call: ts.CallExpression): string | undefined;
  /**
   * Is this node a point at which a string is ASSEMBLED — the place a whole
   * string exists, rather than one fragment of it?
   */
  isAssemblyPoint(node: ts.Node, mod: ModuleInfo): boolean;
  /** How an expression is named in a message. */
  label(node: ts.Node, sf: ts.SourceFile): string;
}

/**
 * THE CLOSED SET OF STRING-ASSEMBLY CALLS. A call outside it is not treated as
 * string building at all, which is what keeps `executor.query(…)` — and every
 * other ordinary call — from being rendered as though it were a string.
 *
 * The first group is resolved EXACTLY. The second cannot be modelled: `.replace`
 * can delete any part of the result, `.slice` can truncate it, a case fold changes
 * what every rule matches. Those keep their receiver and add an opaque mark, which
 * makes the result UNRESOLVABLE rather than assumed innocent.
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

/** Array operations that keep the elements but change them or their order. */
const ARRAY_INEXACT = new Set(['map', 'filter', 'flat', 'flatMap', 'sort', 'reverse']);

type Part =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'expr'; readonly expr: ts.Expression; readonly mod?: ModuleInfo }
  /**
   * A piece whose value this resolver does not model. It is KEPT rather than
   * dropped, so the string around it is still recognisable and is still reported as
   * unresolvable — dropping it would be silence.
   */
  | { readonly kind: 'opaque'; readonly label: string };

/** One expression may be assembled several ways; each way is a sequence of parts. */
type Shapes = Part[][];

interface ElementRef {
  readonly expr: ts.Expression;
  readonly mod: ModuleInfo;
}

interface ArrayValue {
  /** Every ordered element list the expression could be. */
  readonly shapes: ElementRef[][];
  /**
   * False when the array is those elements REARRANGED OR REWRITTEN by something
   * this resolver does not model — `.map`, `.filter`, `.sort`. The elements are
   * still rendered, because they are still what the string is made of, but the
   * result is marked unresolvable rather than presented as the string.
   */
  readonly exact: boolean;
}

interface Ctx {
  readonly seen: Set<string>;
  readonly depth: number;
}

export function createStaticStringResolver(options: ResolverOptions): StaticStringResolver {
  const ROOT = options.root;
  const UNKNOWN_MARK = options.unknownMark ?? UNRESOLVABLE_MARK;
  const VARIANT_CAP = options.variantCap ?? DEFAULT_VARIANT_CAP;
  const RESOLVE_DEPTH = options.resolveDepth ?? DEFAULT_RESOLVE_DEPTH;
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
   * package's public entry point, which is how a cross-package reader reaches a
   * shared constant.
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
   * shared constant?" a question about identity rather than about text.
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

  const pinApi: PinApi = { resolveReference };

  function pinnedMark(node: ts.Node, mod: ModuleInfo): string | undefined {
    return options.pinned?.(node, mod, pinApi);
  }

  // ── the static evaluator ─────────────────────────────────────────────────

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
      const keys = textValuesIn(inner.argumentExpression, mod, deeper(ctx));
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
      return union(
        sites(inner.whenTrue, mod, deeper(ctx)),
        sites(inner.whenFalse, mod, deeper(ctx)),
      );
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
   * — an over-approximation, so a name chosen at run time is judged in all of the
   * shapes it could take.
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

  function cross(prefixes: string[], values: string[], tail: string): string[] | undefined {
    if (prefixes.length * values.length > VARIANT_CAP) return undefined;
    const out: string[] = [];
    for (const prefix of prefixes) for (const value of values) out.push(`${prefix}${value}${tail}`);
    return out;
  }

  /** Every string the expression could be. `undefined` means "cannot tell". */
  function textValuesIn(node: ts.Node, mod: ModuleInfo, ctx: Ctx): string[] | undefined {
    if (ctx.depth > RESOLVE_DEPTH) return undefined;
    const pin = pinnedMark(node, mod);
    if (pin !== undefined) return [pin];
    // An accumulator's value is what it was declared as, followed by everything
    // appended to it. `let sql = HEAD; sql += TABLE; sql += TAIL;` is one string
    // written across three, and reading only the declaration loses two thirds of it.
    const named = unwrap(node);
    if (ts.isIdentifier(named)) {
      const appended = mod.accumulations.get(named.text);
      if (appended !== undefined) {
        let variants = declaredTextValues(named, mod, ctx);
        if (variants === undefined) return undefined;
        for (const piece of appended) {
          const values = textValuesIn(piece, mod, deeper(ctx));
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
    // name nor a predicate, so resolving it removes noise rather than adding reach.
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
        const values = textValuesIn(span.expression, mod, deeper(ctx));
        if (values === undefined) return undefined;
        const next = cross(variants, values, pieceText(span.literal, mod.sf));
        if (next === undefined) return undefined;
        variants = next;
      }
      return variants;
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left =
        literalTexts(node.left, mod, deeper(ctx)) ?? textValuesIn(node.left, mod, deeper(ctx));
      const right =
        literalTexts(node.right, mod, deeper(ctx)) ?? textValuesIn(node.right, mod, deeper(ctx));
      if (left === undefined || right === undefined) return undefined;
      return cross(left, right, '');
    }
    // A string assembled by a method call is a string. Only a FULLY resolved
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
          part.kind === 'text'
            ? [part.text]
            : textValuesIn(part.expr, part.mod ?? mod, deeper(ctx));
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

  /** Which assembly form this call is, if it is one at all. */
  function assemblyMethod(call: ts.CallExpression): string | undefined {
    const callee = unwrap(call.expression);
    if (ts.isIdentifier(callee)) return callee.text === 'String' ? 'String' : undefined;
    if (!ts.isPropertyAccessExpression(callee)) return undefined;
    const name = callee.name.text;
    return ASSEMBLY_METHODS.has(name) ? name : undefined;
  }

  /** A non-negative index or bound written as a literal. */
  function boundValue(node: ts.Expression, mod: ModuleInfo, ctx: Ctx): number | undefined {
    const values = textValuesIn(node, mod, ctx);
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
   * here in a way it does not elsewhere in this file: a joined array is one string,
   * and a string is its pieces in sequence.
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
   * one idea in four spellings, and a reader that handled only the first two is
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
          : textValuesIn(index, mod, deeper(ctx));
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
      // Trimming removes whitespace from the ends. It cannot remove a name, a
      // column comparison or a pinned constant, so it is an exact identity here.
      return [[{ kind: 'expr', expr: receiver, mod }]];
    }

    if (method === 'reduce') {
      // The fold is not modelled, but its ELEMENTS are, in order — so a string
      // accumulated out of fragments is still seen, and the mark still reports it.
      const array = arrayShapes(receiver, mod, deeper(ctx));
      if (array === undefined) return unmodelled;
      const mark: Part = { kind: 'opaque', label: label(inner, mod.sf) };
      return array.shapes.map((elements) => [
        ...elements.map((element): Part => ({
          kind: 'expr',
          expr: element.expr,
          mod: element.mod,
        })),
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
    // `PREFIX + TABLE + SUFFIX` is one string assembled from three references, and
    // treating the references as opaque would lose the string.
    return ts.isExpression(inner) ? [[{ kind: 'expr', expr: inner, mod }]] : undefined;
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
            : textValuesIn(part.expr, owner, { seen: new Set(), depth: 0 });
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

  /**
   * WHERE A STRING IS JUDGED. Not "at every string literal" — at every point a
   * string is ASSEMBLED, because the evasion shape both gates exist to catch splits
   * the text until no single literal carries the whole of it.
   */
  function isAssemblyPoint(node: ts.Node, mod: ModuleInfo): boolean {
    return (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateExpression(node) ||
      ts.isTaggedTemplateExpression(node) ||
      (ts.isCallExpression(node) && assemblyMethod(node) !== undefined) ||
      (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) ||
      // The point an accumulator is COMPLETE: its last append. Judging it there
      // judges the whole string once, rather than a prefix of it three times.
      (ts.isBinaryExpression(node) &&
        ts.isIdentifier(node.left) &&
        mod.lastAccumulation.get(node.left.text) === node.pos)
    );
  }

  return {
    root: ROOT,
    unknownMark: UNKNOWN_MARK,
    loadModule,
    resolveReference,
    textValues: (node, mod) => textValuesIn(node, mod, { seen: new Set(), depth: 0 }),
    render,
    assemblyMethod,
    isAssemblyPoint,
    label,
  };
}

// ── syntax helpers, independent of any one resolver ────────────────────────

export function unwrap(node: ts.Node): ts.Node {
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

/** Is this the tag of a `String.raw` tagged template? */
export function isStringRawTag(tag: ts.Expression): boolean {
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
export function pieceText(node: ts.TemplateLiteralLikeNode, sf: ts.SourceFile): string {
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

/** How an expression is named in a message. */
export function label(node: ts.Node, sf: ts.SourceFile): string {
  const text = node.getText(sf).replace(/\s+/g, ' ').trim();
  return text.length > 72 ? `${text.slice(0, 71)}…` : text;
}
