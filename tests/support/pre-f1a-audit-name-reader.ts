/**
 * FBL-020-R4 §3 correction G5 — THE PRE-F1a NAME READER, RECONSTRUCTED SO THE NUMBER
 * CAN BE MEASURED RATHER THAN REMEMBERED.
 *
 * Four sites published how many of the twelve spellings in
 * `architecture/fixtures/audit-inventory-assembly/` the FIRST version of
 * `scripts/check-audit-inventory.ts` let through. Two said ELEVEN and two said TEN.
 * Neither number came from a run: the pre-F1a gate was rewritten in place and never
 * committed, so by the time the sentences were written there was nothing left to
 * re-run and both numbers were recollection. This file removes the recollection. It
 * rebuilds the pre-F1a NAME READER — and only the name reader, because the name reader
 * is the whole of what F1a changed — from the two properties the finding and the
 * gate's own header recorded about it:
 *
 *   1. ONE REGULAR EXPRESSION OVER `node.text`. A name had to appear COMPLETE inside
 *      one literal. That is why `'identity.support' + '.quarantined'` was invisible:
 *      the left fragment carries one segment after the root, the right fragment
 *      carries no root, and neither is a name.
 *   2. ONE LOOK AT `node.head.text`. A template whose HEAD already ran into the
 *      namespace and then interpolated (`` `identity.support.${x}` ``) was refused as
 *      `audit-event-type-assembled-at-run-time`. A template that interpolates FIRST
 *      has an EMPTY head, so that look saw nothing — the second half of the finding.
 *
 * WHERE THE RECORD IS SILENT THE RECONSTRUCTION IS GENEROUS, so that the measurement
 * cannot understate the old reader and then be dismissed for it:
 *
 *   - the regular expression runs over the text of template HEADS, MIDDLES and TAILS
 *     as well as string literals, not only over `ts.isStringLiteralLike` nodes;
 *   - the head look accepts a head that merely reaches the namespace root
 *     (`identity.`), not just one that reaches a family (`identity.support.`).
 *
 * Both choices can only make the old reader catch MORE. No spelling in the corpus puts
 * a complete name inside a template piece, so the first changes no verdict; the second
 * is the one that decides the answer, and the run below reports which fixture turns on
 * it.
 *
 * EVERYTHING DOWNSTREAM OF THE READER IS THE LIVE GATE. The reconstructed names go
 * into the real `checkAccounting` and the reconstructed writer set into the real
 * `checkUndeclaredWriters`, both imported from `scripts/check-audit-inventory.ts` and
 * both judged against the live `DECLARED` inventory. A difference in verdict is
 * therefore a difference in READING, which is the thing being measured.
 *
 * It lives under `tests/` deliberately: `scripts/` is inside the audit gate's own
 * production scan, and a second file there holding the namespace patterns would need a
 * second scan exclusion to buy nothing.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import * as ts from 'typescript';
import {
  DECLARED,
  type Violation,
  checkAccounting,
  checkUndeclaredWriters,
  scan,
} from '../../scripts/check-audit-inventory';

const ROOT = join(__dirname, '..', '..');

/** Pre-F1a rule 1: a COMPLETE `identity.<family>.<name>` inside ONE literal. */
const PRE_F1A_NAME = /\bidentity\.[a-z0-9_]+(?:\.[a-z0-9_]+)+/g;

/** Pre-F1a rule 2: the template head runs into the namespace, then interpolates. */
const PRE_F1A_HEAD_INSIDE_NAMESPACE = /identity\.[a-z0-9_.]*$/;

/** Unchanged by F1a: an audit write is a text match, not a resolved name. */
const PRE_F1A_AUDIT_WRITE = /INSERT\s+INTO\s+audit_events\b/i;

const RULE_ASSEMBLED = 'audit-event-type-assembled-at-run-time';

/** One reader's verdict on one file: what it read, and what that cost. */
export interface ReaderVerdict {
  /** 0 when the reader found nothing to report — the `exit 0` the claim is about. */
  readonly exitCode: number;
  readonly violations: number;
  /** Rule names raised, de-duplicated and sorted. */
  readonly rules: readonly string[];
  /** The `identity.`-namespaced names the reader managed to READ, sorted. */
  readonly names: readonly string[];
}

function verdict(violations: readonly Violation[], names: Iterable<string>): ReaderVerdict {
  return {
    exitCode: violations.length > 0 ? 1 : 0,
    violations: violations.length,
    rules: [...new Set(violations.map((v) => v.rule))].sort(),
    names: [...names].sort(),
  };
}

/** The reconstructed pre-F1a reader over one or more repository-relative files. */
export function preF1aRead(files: readonly string[]): {
  sites: Map<string, string[]>;
  writers: Set<string>;
  violations: Violation[];
} {
  const sites = new Map<string, string[]>();
  const writers = new Set<string>();
  const violations: Violation[] = [];

  for (const file of files) {
    const source = readFileSync(join(ROOT, file), 'utf8');
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const lineOf = (node: ts.Node): number =>
      sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

    const visit = (node: ts.Node): void => {
      const carriesText =
        ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node);
      if (carriesText) {
        for (const m of node.text.matchAll(PRE_F1A_NAME)) {
          const name = String(m[0]);
          const at = `${file}:${lineOf(node)}`;
          const list = sites.get(name) ?? [];
          if (!list.includes(at)) list.push(at);
          sites.set(name, list);
        }
        if (PRE_F1A_AUDIT_WRITE.test(node.text)) writers.add(file);
      }
      if (ts.isTemplateExpression(node) && PRE_F1A_HEAD_INSIDE_NAMESPACE.test(node.head.text)) {
        violations.push({
          file,
          line: lineOf(node),
          rule: RULE_ASSEMBLED,
          detail: 'the template head already runs into the namespace and then interpolates',
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  return { sites, writers, violations };
}

/** What the pre-F1a gate would have said about ONE file. */
export function preF1aVerdict(file: string): ReaderVerdict {
  const read = preF1aRead([file]);
  return verdict(
    [
      ...read.violations,
      ...checkAccounting(DECLARED, read.sites),
      ...checkUndeclaredWriters(DECLARED, read.writers),
    ],
    read.sites.keys(),
  );
}

/** What the gate in this tree says about the SAME file, through the shared resolver. */
export function currentVerdict(file: string): ReaderVerdict {
  const read = scan([file], DECLARED);
  return verdict(
    [
      ...read.violations,
      ...checkAccounting(DECLARED, read.sites),
      ...checkUndeclaredWriters(DECLARED, read.writers),
    ],
    read.sites.keys(),
  );
}
