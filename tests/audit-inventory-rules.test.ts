import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
  DECLARED,
  type AuditInventoryDeclaration,
  type Violation,
  checkAccounting,
  checkInventoryShape,
  checkMigrationText,
  checkStaleness,
  checkUndeclaredWriters,
  namespacePatterns,
} from '../scripts/check-audit-inventory';
import type {
  IdentityAuditInventoryEntry,
  IdentityAuditWriter,
  IdentityNonAuditNamespaceLiteral,
} from '@dealer/identity-access';

/**
 * FBL-020-R4 §3 correction F2 — THE GATE'S OWN RULES ARE TESTED.
 *
 * The finding was measured, not argued: `checkInventoryShape()` was DELETED WHOLESALE
 * from `scripts/check-audit-inventory.ts` and `tests/architecture.test.ts` stayed 13/13
 * while `tests/ci-gates.test.ts` stayed 14/14. Ten of the gate's thirteen shape rules —
 * duplicate transitions, duplicate event types, namespace shape, undeclared family,
 * family mismatch, the `provenIn`/`provenBy` verification that the delivery report
 * singles out as F1's own fix, entry completeness, required-transition coverage,
 * declared-writer existence, and the non-audit-literal reasons — were decoration. So
 * were all three staleness rules and the migration rule.
 *
 * A fixture cannot reach those rules: they judge the DECLARATION, not a scanned file.
 * So the rule functions are exported and driven here directly, one test per rule, each
 * one perturbing a BASELINE declaration that is proved clean first. Every test in this
 * file fails if the rule it names is removed and nothing else changes — which is the
 * property the finding says was missing, stated as tests rather than as a claim.
 *
 * The scanning rules (`audit-event-type-missing-from-inventory`,
 * `…-assembled-at-run-time`, `…-namespace-root-assembled-at-run-time`,
 * `audit-write-outside-declared-writer`) are pinned by the fixture corpora and asserted
 * in `tests/architecture.test.ts`; the three that only a whole-tree run can raise
 * (staleness) are pinned here.
 */

const ROOT = join(__dirname, '..');
const DECLARATION_FILE = 'packages/identity-access/src/audit-inventory.ts';

/** A proof citation that really exists, so the baseline is clean for the right reason. */
const REAL_PROOF_FILE = 'tests/identity-boundary.test.ts';
const REAL_PROOF_NAME = 'every mutation advances its version, names the TRUE actor, audits once';

const ENTRY: IdentityAuditInventoryEntry = {
  transition: 'support.request',
  family: 'support',
  eventType: 'identity.support.requested',
  entityType: 'support_access_request',
  writtenBy: 'requestSupportAccess',
  provenIn: REAL_PROOF_FILE,
  provenBy: REAL_PROOF_NAME,
};

const NON_AUDIT: IdentityNonAuditNamespaceLiteral = {
  literal: 'identity.support.approve',
  role: 'policy ACTION key',
  because: 'an action is the thing a policy decision is about, not a row in audit_events',
};

const WRITER: IdentityAuditWriter = {
  file: 'packages/identity-access/src/mutations.ts',
  namespace: 'identity.',
  enumerable: true,
  because: 'the owned mutation services',
};

/**
 * The baseline every test below perturbs. It is deliberately MINIMAL — one entry, one
 * declared non-audit literal, one writer — so that exactly one thing is wrong in each
 * perturbation and the rule that fires is unambiguous.
 */
const BASELINE: AuditInventoryDeclaration = {
  root: ROOT,
  declarationFile: DECLARATION_FILE,
  namespace: 'identity.',
  families: ['support'],
  inventory: [ENTRY],
  nonAudit: [NON_AUDIT],
  writers: [WRITER],
  required: ['support.request'],
};

function withDecl(patch: Partial<AuditInventoryDeclaration>): AuditInventoryDeclaration {
  return { ...BASELINE, ...patch };
}

/** The rule names raised, sorted and de-duplicated — what each test asserts against. */
function rulesOf(violations: readonly Violation[]): string[] {
  return [...new Set(violations.map((v) => v.rule))].sort();
}

/**
 * One perturbation, one expected rule set. Asserting the WHOLE set (not "includes")
 * is what stops a test from passing because some other rule happened to fire: if the
 * named rule is deleted, this assertion fails rather than being satisfied by a
 * neighbour.
 */
function assertShapeRaises(
  patch: Partial<AuditInventoryDeclaration>,
  expected: string[],
  because: string,
): Violation[] {
  const violations = checkInventoryShape(withDecl(patch));
  assert.deepEqual(
    rulesOf(violations),
    [...expected].sort(),
    `${because}\n${JSON.stringify(violations, null, 2)}`,
  );
  return violations;
}

describe('the audit-inventory gate rules are each pinned (FBL-020-R4 §3 / F2)', () => {
  test('the BASELINE declaration is clean, so every perturbation below is the cause', () => {
    assert.deepEqual(checkInventoryShape(BASELINE), []);
  });

  test('the REAL declaration is clean — the same rules, on the shipped inventory', () => {
    // The gate run asserts this too; asserting it here as well means a shape rule
    // cannot be "green" merely because nobody imports it.
    assert.deepEqual(checkInventoryShape(DECLARED), []);
    assert.ok(DECLARED.inventory.length >= 46, 'sanity: the shipped inventory is the long one');
    assert.equal(DECLARED.declarationFile, DECLARATION_FILE);
  });

  test('rule: duplicate-inventory-transition', () => {
    assertShapeRaises(
      {
        inventory: [ENTRY, { ...ENTRY, eventType: 'identity.support.requested_again' }],
      },
      ['duplicate-inventory-transition'],
      'one transition listed twice would let a second event type hide behind the first',
    );
  });

  test('rule: duplicate-inventory-event-type', () => {
    assertShapeRaises(
      { inventory: [ENTRY, { ...ENTRY, transition: 'support.request_again' }] },
      ['duplicate-inventory-event-type'],
      'one event type listed twice makes the transition mapping ambiguous',
    );
  });

  test('rule: inventory-event-type-outside-the-namespace', () => {
    assertShapeRaises(
      { inventory: [{ ...ENTRY, eventType: 'support.requested' }] },
      ['inventory-event-type-outside-the-namespace'],
      'an entry outside identity.<family>.<name> is not a name this gate accounts for',
    );
    // …and the other half of the same rule: inside the root but too few segments.
    assertShapeRaises(
      { inventory: [{ ...ENTRY, eventType: 'identity.requested' }] },
      ['inventory-event-type-outside-the-namespace'],
      'identity.<name> has no family segment',
    );
  });

  test('rule: inventory-entry-family-undeclared', () => {
    assertShapeRaises(
      {
        inventory: [{ ...ENTRY, family: 'session', eventType: 'identity.session.requested' }],
      },
      ['inventory-entry-family-undeclared'],
      'a family nobody declared would grow the namespace without a decision',
    );
  });

  test('rule: inventory-entry-family-mismatch', () => {
    assertShapeRaises(
      {
        families: ['support', 'session'],
        inventory: [{ ...ENTRY, eventType: 'identity.session.requested' }],
      },
      ['inventory-entry-family-mismatch'],
      'an entry whose own event type contradicts its declared family is filed under a family it does not belong to',
    );
  });

  test('rule: inventory-proof-citation-is-not-verifiable — the FILE must exist', () => {
    const violations = assertShapeRaises(
      { inventory: [{ ...ENTRY, provenIn: 'tests/no-such-battery.test.ts' }] },
      ['inventory-proof-citation-is-not-verifiable'],
      'a citation pointing at nothing is the R3 defect this rule closes',
    );
    assert.match(String(violations[0]?.detail), /which does not exist/);
  });

  test('rule: inventory-proof-citation-is-not-verifiable — the NAME must be in that file', () => {
    const violations = assertShapeRaises(
      { inventory: [{ ...ENTRY, provenBy: 'a test name that no file contains' }] },
      ['inventory-proof-citation-is-not-verifiable'],
      "R3's provenBy values were prose matching no test name in any file",
    );
    assert.match(String(violations[0]?.detail), /which does not contain that string/);
  });

  test('rule: inventory-entry-incomplete', () => {
    assertShapeRaises(
      { inventory: [{ ...ENTRY, writtenBy: '' }] },
      ['inventory-entry-incomplete'],
      'an entry naming no writer proves nothing about who writes it',
    );
    assertShapeRaises(
      { inventory: [{ ...ENTRY, entityType: '' }] },
      ['inventory-entry-incomplete'],
      'an entry naming no entity type cannot be found in the audit table',
    );
  });

  test('rule: required-transition-missing-from-inventory', () => {
    assertShapeRaises(
      { required: ['support.request', 'support.revocation'] },
      ['required-transition-missing-from-inventory'],
      'a DELETED entry must be a failure rather than a shorter list',
    );
  });

  test('rule: declared-writer-does-not-exist', () => {
    assertShapeRaises(
      { writers: [{ ...WRITER, file: 'packages/identity-access/src/no-such-writer.ts' }] },
      ['declared-writer-does-not-exist'],
      'a writer declaration pointing at nothing closes no hole',
    );
  });

  test('rule: declared-writer-has-no-reason', () => {
    assertShapeRaises(
      { writers: [{ ...WRITER, because: '' }] },
      ['declared-writer-has-no-reason'],
      'a writer permitted for no stated reason is an undocumented exception',
    );
  });

  test('rule: non-enumerable-writer-inside-the-inventoried-namespace', () => {
    assertShapeRaises(
      { writers: [{ ...WRITER, namespace: 'identity.support.', enumerable: false }] },
      ['non-enumerable-writer-inside-the-inventoried-namespace'],
      'a non-enumerable writer INSIDE the namespace is a hole, not a residue outside it',
    );
  });

  test('rule: literal-declared-both-audit-and-non-audit', () => {
    assertShapeRaises(
      { nonAudit: [{ ...NON_AUDIT, literal: ENTRY.eventType }] },
      ['literal-declared-both-audit-and-non-audit'],
      'a name cannot be an audit event and a declared non-event at the same time',
    );
  });

  test('rule: non-audit-literal-has-no-reason', () => {
    assertShapeRaises(
      { nonAudit: [{ ...NON_AUDIT, role: '' }] },
      ['non-audit-literal-has-no-reason'],
      'an exception with no role stated is an inference, and inference is the hole',
    );
    assertShapeRaises(
      { nonAudit: [{ ...NON_AUDIT, because: '' }] },
      ['non-audit-literal-has-no-reason'],
      'an exception with no reason stated is the same hole',
    );
  });

  describe('the forward direction: every name found is accounted for', () => {
    test('rule: audit-event-type-missing-from-inventory', () => {
      const clean = checkAccounting(
        BASELINE,
        new Map([
          [ENTRY.eventType, ['packages/identity-access/src/mutations.ts:10']],
          [NON_AUDIT.literal, ['packages/identity-access/src/actions.ts:20']],
        ]),
      );
      assert.deepEqual(rulesOf(clean), [], 'an inventoried name and a declared literal are clean');

      const dirty = checkAccounting(
        BASELINE,
        new Map([
          ['identity.support.quarantined', ['packages/identity-access/src/mutations.ts:99']],
        ]),
      );
      assert.deepEqual(rulesOf(dirty), ['audit-event-type-missing-from-inventory']);
      assert.match(
        String(dirty[0]?.detail),
        /sites: packages\/identity-access\/src\/mutations\.ts:99/,
      );
      assert.equal(dirty[0]?.line, 99, 'the violation must point at the site, not at line 0');
    });
  });

  describe('the writer direction: every audit write sits in a declared writer', () => {
    test('rule: audit-write-outside-declared-writer', () => {
      assert.deepEqual(rulesOf(checkUndeclaredWriters(BASELINE, [WRITER.file])), []);
      const dirty = checkUndeclaredWriters(BASELINE, ['packages/organization/src/repository.ts']);
      assert.deepEqual(rulesOf(dirty), ['audit-write-outside-declared-writer']);
    });
  });

  describe('the reverse direction: a complete list that is STALE is still a lie', () => {
    const writtenSites = new Map<string, readonly string[]>([
      [ENTRY.eventType, ['packages/identity-access/src/mutations.ts:10']],
      [NON_AUDIT.literal, ['packages/identity-access/src/actions.ts:20']],
    ]);

    test('the reverse rules are all clean when the tree matches the declaration', () => {
      assert.deepEqual(
        rulesOf(checkStaleness(BASELINE, writtenSites, new Set([WRITER.file]))),
        [],
        'sanity: nothing is stale, so every perturbation below is the cause',
      );
    });

    test('rule: inventory-entry-has-no-production-writer', () => {
      const sites = new Map(writtenSites);
      sites.delete(ENTRY.eventType);
      assert.deepEqual(rulesOf(checkStaleness(BASELINE, sites, new Set([WRITER.file]))), [
        'inventory-entry-has-no-production-writer',
      ]);
    });

    test('rule: non-audit-literal-declaration-is-stale', () => {
      const sites = new Map(writtenSites);
      sites.delete(NON_AUDIT.literal);
      assert.deepEqual(rulesOf(checkStaleness(BASELINE, sites, new Set([WRITER.file]))), [
        'non-audit-literal-declaration-is-stale',
      ]);
    });

    test('rule: audit-writer-declaration-is-stale', () => {
      assert.deepEqual(rulesOf(checkStaleness(BASELINE, writtenSites, new Set())), [
        'audit-writer-declaration-is-stale',
      ]);
    });
  });

  describe('the migrations, which are production audit writers too', () => {
    test('rule: migration-audit-write-has-no-static-event-type', () => {
      const staticWrite = checkMigrationText(
        'migrations/999_probe.sql',
        "INSERT INTO audit_events (event_type) SELECT 'identity.support.requested';",
        BASELINE,
      );
      assert.deepEqual(rulesOf(staticWrite.violations), [], 'a static event type is readable');
      assert.deepEqual([...staticWrite.sites.keys()], ['identity.support.requested']);

      const assembled = checkMigrationText(
        'migrations/999_probe.sql',
        "EXECUTE format('INSERT INTO audit_events (event_type) SELECT %L', v_event);",
        BASELINE,
      );
      assert.deepEqual(rulesOf(assembled.violations), [
        'migration-audit-write-has-no-static-event-type',
      ]);
      // The coarseness is stated in KNOWN-LIMITATIONS rather than implied away: the
      // rule proves a literal is PRESENT in the statement, not that it occupies the
      // event_type column. This is that limit, demonstrated.
      const coarse = checkMigrationText(
        'migrations/999_probe.sql',
        "INSERT INTO audit_events (event_type, details) SELECT v_event, 'identity.support.requested';",
        BASELINE,
      );
      assert.deepEqual(
        rulesOf(coarse.violations),
        [],
        'position-free: a literal anywhere in the statement satisfies the rule',
      );
    });

    test('a commented-out audit write is not an audit write', () => {
      const commented = checkMigrationText(
        'migrations/999_probe.sql',
        '-- INSERT INTO audit_events (event_type) SELECT v_event;\n/* INSERT INTO audit_events */\n',
        BASELINE,
      );
      assert.deepEqual(rulesOf(commented.violations), []);
    });
  });

  test('the patterns are DERIVED from the declaration, not typed twice', () => {
    // The namespace root, the family list and the unresolvable mark all come from one
    // place each. A pattern hard-coded here would drift from the constant the inventory
    // exports, which is the defect class this whole wave is about.
    const patterns = namespacePatterns(withDecl({ namespace: 'probe.', families: ['widget'] }));
    assert.ok(patterns.namespaced.test('probe.widget.made'));
    assert.ok(!patterns.namespaced.test('identity.support.requested'));
    assert.ok(patterns.assembledTail.test('probe.widget.UNRESOLVABLE_FRAGMENT_1'));
    assert.ok(patterns.assembledRoot.test('UNRESOLVABLE_FRAGMENT_2.widget.made'));
    assert.ok(
      !patterns.assembledRoot.test('UNRESOLVABLE_FRAGMENT_2.d.ts'),
      'only a DECLARED family after an unresolvable root marks a name — otherwise every ' +
        'interpolated path would be an audit event type',
    );
    assert.ok(patterns.auditWrite.test('insert   into audit_events (event_type)'));
  });
});
