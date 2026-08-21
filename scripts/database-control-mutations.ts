/**
 * FBL-020-R6 §4.1 — MUTATION-KILL FOR THE SECTION 3 DATABASE CONTROLS.
 *
 *   TEST_DATABASE_URL=… npx tsx scripts/database-control-mutations.ts \
 *     --out artifacts/database-control-mutations.json \
 *     --log artifacts/database-control-mutations.txt
 *
 * ── WHY THIS RUNNER EXISTS SEPARATELY ──────────────────────────────────────
 *
 * `scripts/mutation-kill.ts` weakens a control in a TYPESCRIPT SOURCE and re-runs the
 * battery. `scripts/upgrade-negative-controls.ts` deletes a RECONCILIATION from a
 * migration and re-runs the upgrade. Neither can reach the controls FBL-020-R6 §3
 * adds, and the reason is structural: a §3 control is a CHECK, an INDEX or a TRIGGER
 * that exists in an ALREADY-MIGRATED database. Editing 058 proves nothing, because the
 * suite runs against a database where 058 has already been applied; and a reconciliation
 * negative control proves nothing either, because these rules are enforced at INSERT
 * time rather than at upgrade time.
 *
 * So this runner does the thing the order asks for in its own words: it DROPS the
 * control from a database and requires a SPECIFICALLY NAMED test to die.
 *
 * For each control it:
 *   1. copies the migrated test database (CREATE DATABASE … TEMPLATE) so the original is
 *      untouched and the controls cannot contaminate each other;
 *   2. runs the DECLARED TEST, by name, against the copy and requires it to PASS — a
 *      battery that is already broken cannot kill anything;
 *   3. executes the DROP, which is one statement removing exactly one control;
 *   4. re-runs the SAME named test and requires it to FAIL;
 *   5. restores the control on the copy and requires the test to PASS again, so the
 *      failure is attributable to the drop rather than to anything the mutated run did
 *      to the data;
 *   6. drops the copy.
 *
 * A control that SURVIVES — the named test still green with the control gone — is a
 * FAILED CHECK and this runner exits non-zero. Zero survivors is the bar R6 §4.1 sets.
 *
 * ── WHY THE RESTORE STEP IS NOT OPTIONAL ───────────────────────────────────
 *
 * Without it, "the test failed after we dropped the control" is compatible with "the
 * test fails on the second run for any reason at all". The restore-and-pass run costs
 * one more execution and turns a correlation into a controlled comparison.
 */
import { spawnSync } from 'child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { Client } from 'pg';

export interface DatabaseControl {
  /** Stable id; also the copy database's suffix. */
  id: string;
  /** The section of migration 058 the control belongs to. */
  section: string;
  /** What is lost if the control is dropped, in one sentence. */
  intent: string;
  /** ONE statement that removes the control. */
  drop: string;
  /** ONE statement that puts it back, so the kill is a controlled comparison. */
  restore: string;
  /** The battery the named test lives in. */
  testFile: string;
  /** The test that must die, by its exact name. */
  testName: string;
}

/**
 * The four §3 controls, one entry per rule that can be dropped on its own.
 *
 * `restore` re-creates the control exactly as 058 declares it. The bodies are repeated
 * here rather than re-read out of the migration on purpose: a runner that re-applied the
 * migration file to restore would also re-apply everything else in it, and could not
 * then claim the copy differs from the template in exactly one rule.
 */
export const CONTROLS: DatabaseControl[] = [
  {
    id: 'auth_time_unbound_from_the_session',
    section: '058 §1 — R6 §3.1',
    intent:
      'the recorded authentication time must BE the named session’s. Dropped, any instant ' +
      'at all may sit beside a real, live, correctly cross-wired credential.',
    drop: 'DROP TRIGGER trg_policy_decisions_auth_time ON policy_decisions',
    restore:
      'CREATE TRIGGER trg_policy_decisions_auth_time BEFORE INSERT ON policy_decisions ' +
      'FOR EACH ROW EXECUTE FUNCTION policy_decisions_auth_time_is_the_sessions()',
    testFile: 'tests/identity-evidence-reconstruction.test.ts',
    testName: 'an ALLOW cannot borrow another REAL session’s authentication time',
  },
  {
    id: 'matched_binding_applicability_unchecked',
    section: '058 §2 — R6 §3.3',
    intent:
      'a matched binding must be the EXACT version observed, in force, in the decision’s ' +
      'tenant and able to reach it. Dropped, a superseded version, a revoked binding, a ' +
      'windowed-out binding, another tenant’s binding and a platform binding over tenant ' +
      'data are all admissible authority.',
    drop: 'DROP TRIGGER trg_pdmb_binding_is_applicable ON policy_decision_matched_bindings',
    restore:
      'CREATE TRIGGER trg_pdmb_binding_is_applicable BEFORE INSERT ON ' +
      'policy_decision_matched_bindings FOR EACH ROW EXECUTE FUNCTION ' +
      'policy_decision_binding_is_applicable()',
    testFile: 'tests/identity-evidence-reconstruction.test.ts',
    testName: 'an ALLOW cannot claim authority from a REVOKED role binding',
  },
  {
    id: 'normalized_evidence_may_diverge_from_the_array',
    section: '058 §3 — R6 §3.2',
    intent:
      'the normalized authority rows must equal the array they normalize. Dropped, a child ' +
      'row may claim a binding the parent array never named.',
    drop: 'DROP TRIGGER trg_pdmb_equals_its_decision ON policy_decision_matched_bindings',
    restore:
      'CREATE TRIGGER trg_pdmb_equals_its_decision AFTER INSERT ON ' +
      'policy_decision_matched_bindings REFERENCING NEW TABLE AS inserted ' +
      'FOR EACH STATEMENT EXECUTE FUNCTION policy_decision_matched_bindings_equal_the_array()',
    testFile: 'tests/identity-evidence-reconstruction.test.ts',
    testName: 'an EXTRA normalized row cannot be attached to a decision, marker or no marker',
  },
  {
    id: 'normalized_ordinality_may_repeat',
    section: '058 §3 — R6 §3.2',
    intent:
      'ordinality is what makes the child rows and the array positionally comparable. ' +
      'Dropped, two bindings may share a position and “which version went with which ' +
      'binding” stops being answerable.',
    drop: 'DROP INDEX uq_pdmb_ordinality',
    restore:
      'CREATE UNIQUE INDEX uq_pdmb_ordinality ON policy_decision_matched_bindings ' +
      '(decision_id, match_ordinality)',
    testFile: 'tests/identity-evidence-reconstruction.test.ts',
    testName: 'a normalized row cannot repeat an ordinality the decision already used',
  },
  {
    id: 'child_rows_have_no_authorized_writer',
    section: '058 §3 — R6 §3.2',
    intent:
      'normalized authority evidence is DERIVED from the decision’s array. Dropped, any ' +
      'writer may add one by hand.',
    drop: 'DROP TRIGGER trg_pdmb_authorized_writer ON policy_decision_matched_bindings',
    restore:
      'CREATE TRIGGER trg_pdmb_authorized_writer BEFORE INSERT ON ' +
      'policy_decision_matched_bindings FOR EACH ROW EXECUTE FUNCTION ' +
      'policy_decision_matched_bindings_have_one_writer()',
    testFile: 'tests/identity-evidence-reconstruction.test.ts',
    testName: 'a child row written with no normalizer behind it is refused',
  },
  {
    id: 'support_tenant_allow_needs_no_delegation',
    section: '058 §4 — R6 §3.4',
    intent:
      'a platform-support ALLOW into a tenant must carry delegated-support evidence. ' +
      'Dropped, a platform person may be recorded inside a customer’s data with a role ' +
      'binding and no approved delegation anywhere.',
    drop: 'ALTER TABLE policy_decisions DROP CONSTRAINT pd_v2_support_tenant_allow_is_delegated',
    restore:
      'ALTER TABLE policy_decisions ADD CONSTRAINT pd_v2_support_tenant_allow_is_delegated ' +
      "CHECK (evidence_version < 2 OR decision = 'deny' OR actor_type <> 'platform_support' " +
      "OR tenant_id IS NULL OR action ~ '^platform\\.' OR support_session_id IS NOT NULL)",
    testFile: 'tests/identity-evidence-reconstruction.test.ts',
    testName: 'a platform-support ALLOW into a tenant cannot omit its delegated-support evidence',
  },
  {
    id: 'support_evidence_is_not_the_approval',
    section: '058 §4 — R6 §3.4',
    intent:
      'supplied support evidence must BE the approval it claims — the approved request, ' +
      'the approved action, the approved scope, the unrevoked session and the live window. ' +
      'Dropped, an unapproved, over-broad, revoked or lapsed delegation is admissible.',
    drop: 'DROP TRIGGER trg_policy_decisions_support_delegation ON policy_decisions',
    restore:
      'CREATE TRIGGER trg_policy_decisions_support_delegation BEFORE INSERT ON ' +
      'policy_decisions FOR EACH ROW EXECUTE FUNCTION ' +
      'policy_decisions_support_evidence_is_the_approval()',
    testFile: 'tests/identity-evidence-reconstruction.test.ts',
    testName: 'a support ALLOW cannot be recorded against a REVOKED delegation',
  },
];

/**
 * ONE PREDICATE INSIDE A TRIGGER FUNCTION.
 *
 * Dropping a whole trigger proves the trigger. It does NOT prove the five separate
 * questions `policy_decisions_support_evidence_is_the_approval` asks, or the six that
 * `policy_decision_binding_is_applicable` asks — with the trigger gone, ONE named test
 * dies and the other four or five never get a chance to. R6 §4.1 asks for every new
 * mandatory predicate, so each clause is also removed ON ITS OWN, and its own named test
 * must die.
 *
 * THE BODIES ARE READ OUT OF MIGRATION 058, NOT COPIED HERE. An anchored excerpt locates
 * the clause; the runner asserts it resolves EXACTLY ONCE, deletes it, and re-declares the
 * function. Restoring re-declares the function from the migration's own text, so the
 * "restored" state is 058's state by construction and this registry cannot drift away from
 * the file it mutates.
 */
export interface PredicateMutation {
  id: string;
  section: string;
  /** What is lost if the clause is removed. */
  intent: string;
  /** The function whose body carries the clause. */
  functionName: string;
  /** Exact text that BEGINS the clause; must occur exactly once in the function. */
  from: string;
  /** Exact text that ENDS it, matched after `from`. */
  to: string;
  testFile: string;
  testName: string;
}

export const PREDICATES: PredicateMutation[] = [
  // ── 058 §1 — the evidence version, and the floor that stops self-certification ──
  {
    id: 'evidence_version_floor_never_moved',
    section: '058 §1 — R6-R6 §D1',
    intent:
      'the §3.1 exemption is keyed on evidence_version, so it is only safe while nothing ' +
      'NEW can be written below version 3. Removed, a writer claims version 2 and inherits ' +
      'the historic exemption — a fresh way to record an authentication that never happened',
    functionName: 'policy_decisions_require_current_evidence',
    from: '  IF NEW.evidence_version < 3 THEN',
    to: '      NEW.evidence_version;\n  END IF;',
    testFile: 'tests/identity-evidence.test.ts',
    testName: 'a new decision cannot opt back into ANY weaker historic version',
  },
  // ── 058 §2 — the matched binding must be exact, in force and applicable ───
  {
    id: 'decision_scope_node_need_not_exist',
    section: '058 §2 — R6-R6 §D4',
    intent:
      'the organization node a decision records must EXIST, in the decision’s own tenant. ' +
      'Removed, a version-3 ALLOW whose matched binding is tenant-scope may name a rooftop ' +
      'that is a rooftop nowhere, and the trail an operator follows after an incident ends ' +
      'at an identifier that resolves to nothing',
    functionName: 'policy_decision_binding_is_applicable',
    from: "    IF d.scope_level IN ('dealer_group', 'legal_entity', 'rooftop', 'department') THEN",
    to: "        COALESCE(d.scope_id::text, '<none>'), COALESCE(d.tenant_id::text, '<none>');\n    END IF;",
    testFile: 'tests/identity-evidence-reconstruction.test.ts',
    testName: 'an ALLOW cannot record an organization node that exists NOWHERE',
  },
  {
    id: 'binding_version_may_be_older',
    section: '058 §2 — R6 §3.3',
    intent: 'evidence may name a version the binding has already been moved out of',
    functionName: 'policy_decision_binding_is_applicable',
    from: '  IF NEW.authorization_version < rb.authorization_version THEN',
    to: "observed, and an older one describes a state the binding has been moved out of',\n      NEW.role_binding_id, NEW.authorization_version, rb.authorization_version;\n  END IF;",
    testFile: 'tests/identity-evidence-reconstruction.test.ts',
    testName: 'an ALLOW cannot claim a role binding at a version it has already left',
  },
  {
    id: 'revoked_binding_may_be_authority',
    section: '058 §2 — R6 §3.3',
    intent: 'a revoked binding may be recorded as the authority for an allow',
    functionName: 'policy_decision_binding_is_applicable',
    from: "  IF rb.status <> 'active' THEN",
    to: '      NEW.role_binding_id, rb.status;\n  END IF;',
    testFile: 'tests/identity-evidence-reconstruction.test.ts',
    testName: 'an ALLOW cannot claim authority from a REVOKED role binding',
  },
  {
    id: 'binding_window_ignored',
    section: '058 §2 — R6 §3.3',
    intent: 'a binding outside its effective window may be recorded as authority',
    functionName: 'policy_decision_binding_is_applicable',
    from: '  IF rb.effective_from > NOW() OR (rb.effective_to IS NOT NULL AND rb.effective_to <= NOW()) THEN',
    to: '      NEW.role_binding_id, rb.effective_from, rb.effective_to;\n  END IF;',
    testFile: 'tests/identity-evidence-reconstruction.test.ts',
    testName: 'an ALLOW cannot claim a role binding outside its effective window',
  },
  {
    id: 'platform_binding_may_cover_tenant_data',
    section: '058 §2 — R6 §3.3',
    intent: 'a platform-scope binding may be recorded as authority over tenant data',
    functionName: 'policy_decision_binding_is_applicable',
    from: "    IF d.scope_level IS DISTINCT FROM 'platform' THEN",
    to: "        NEW.role_binding_id, COALESCE(d.scope_level, '<none>');\n    END IF;",
    testFile: 'tests/identity-evidence-reconstruction.test.ts',
    testName: 'a tenant ALLOW cannot claim authority from a PLATFORM-scope binding',
  },
  {
    id: 'binding_tenant_ignored',
    section: '058 §2 — R6 §3.3',
    intent: 'a binding from another tenant may be recorded as authority here',
    functionName: 'policy_decision_binding_is_applicable',
    from: '    IF rb.tenant_id IS DISTINCT FROM d.tenant_id THEN',
    to: "        COALESCE(d.tenant_id::text, '<none>');\n    END IF;",
    testFile: 'tests/identity-evidence-reconstruction.test.ts',
    testName: 'an ALLOW cannot claim a role binding that lives in another tenant',
  },
  {
    id: 'scope_hierarchy_ignored',
    section: '058 §2 — R6 §3.3, gate finding C7',
    intent:
      'a binding at one organization node may be recorded as the authority for a SIBLING ' +
      'node or for the tenant ABOVE it, and a tenant-scope binding may name a tenant other ' +
      'than the decision’s',
    functionName: 'policy_decision_binding_is_applicable',
    from: "    IF rb.scope_level = 'tenant' THEN",
    to:
      "          COALESCE(d.scope_level, '<none>'), COALESCE(d.scope_id::text, '<none>');\n" +
      '      END IF;\n    END IF;',
    testFile: 'tests/identity-evidence-reconstruction.test.ts',
    testName: 'an ALLOW cannot claim a rooftop binding as the authority for a SIBLING rooftop',
  },
  /*
   * ── C7's RULE IS FIVE COMPARISONS, AND THREE OF THEM HAD NO NAMED TEST ────────
   *
   * The entry above removes the WHOLE hierarchy block and one named test dies — which
   * proves the block, not the five separate questions inside it. Its `IF` is a
   * four-way disjunction over the organization levels plus a tenant-scope branch, and
   * only `rooftop` and `tenant` were driven by anything: `dealer_group`,
   * `legal_entity` and `department` could each have been deleted with the battery
   * still green. Each of the three is therefore removed ON ITS OWN below, against its
   * own named adversarial test, exactly as R6 §4.1 requires of every mandatory
   * predicate.
   *
   * The anchors take the disjunct AND the `OR` that joins it, so what is left is
   * still a well-formed condition: the first two carry the `OR` that FOLLOWS them and
   * the last carries the one that PRECEDES it.
   */
  {
    id: 'dealer_group_binding_reaches_a_sibling_group',
    section: '058 §2 — R6 §3.3, gate finding C7',
    intent:
      'a DEALER-GROUP binding may be recorded as the authority for a node hanging off a ' +
      'SIBLING dealer group — authority the binding never granted, in a decision every ' +
      'foreign key accepts',
    functionName: 'policy_decision_binding_is_applicable',
    from: "(rb.scope_level = 'dealer_group' AND dec_dealer_group IS DISTINCT FROM rb.scope_id)",
    to: '\n         OR ',
    testFile: 'tests/identity-evidence-reconstruction.test.ts',
    testName: 'an ALLOW cannot claim a DEALER-GROUP binding as the authority for a SIBLING group',
  },
  {
    id: 'legal_entity_binding_reaches_another_entity',
    section: '058 §2 — R6 §3.3, gate finding C7',
    intent:
      'a LEGAL-ENTITY binding may be recorded as the authority for a rooftop beneath a ' +
      'DIFFERENT legal entity in the same tenant',
    functionName: 'policy_decision_binding_is_applicable',
    from: "(rb.scope_level = 'legal_entity' AND dec_legal_entity IS DISTINCT FROM rb.scope_id)",
    to: '\n         OR ',
    testFile: 'tests/identity-evidence-reconstruction.test.ts',
    testName:
      'an ALLOW cannot claim a LEGAL-ENTITY binding as the authority for a rooftop in ANOTHER entity',
  },
  {
    id: 'department_binding_reaches_upward',
    section: '058 §2 — R6 §3.3, gate finding C7',
    intent:
      'a DEPARTMENT binding — the narrowest grant there is — may be recorded as the ' +
      'authority for the ROOFTOP above it, which is every department in that rooftop',
    functionName: 'policy_decision_binding_is_applicable',
    from: "\n         OR (rb.scope_level = 'department'",
    to: 'IS DISTINCT FROM rb.scope_id)',
    testFile: 'tests/identity-evidence-reconstruction.test.ts',
    testName:
      'an ALLOW cannot claim a DEPARTMENT binding as the authority for the rooftop ABOVE it',
  },
  {
    id: 'resource_binding_reaches_any_resource',
    section: '058 §2 — R6 §3.3',
    intent: 'a resource binding may be recorded as authority over a different resource',
    functionName: 'policy_decision_binding_is_applicable',
    from: "    IF rb.scope_level = 'resource'",
    to: "        COALESCE(d.resource_id::text, '<none>');\n    END IF;",
    testFile: 'tests/identity-evidence-reconstruction.test.ts',
    testName: 'an ALLOW cannot claim a RESOURCE binding for a resource it does not name',
  },
  // ── 058 §4 — the support evidence must be the approval it claims ──────────
  {
    id: 'support_request_need_not_be_approved',
    section: '058 §4 — R6 §3.4',
    intent: 'a delegation nobody approved may authorize a support allow',
    functionName: 'policy_decisions_support_evidence_is_the_approval',
    from: "  IF r.status <> 'approved' OR r.decided_at IS NULL OR r.decided_by_user_link_id IS NULL THEN",
    to: '      r.request_id, r.status;\n  END IF;',
    testFile: 'tests/identity-evidence-reconstruction.test.ts',
    testName: 'a support ALLOW cannot cite a delegation nobody approved',
  },
  {
    id: 'support_action_set_ignored',
    section: '058 §4 — R6 §3.4',
    intent: 'a support allow may record an action the approval never covered',
    functionName: 'policy_decisions_support_evidence_is_the_approval',
    from: '  IF NOT (NEW.action = ANY (r.requested_actions)) THEN',
    to: '      r.request_id, NEW.action;\n  END IF;',
    testFile: 'tests/identity-evidence-reconstruction.test.ts',
    testName: 'a support ALLOW cannot exceed the approved ACTION set',
  },
  {
    id: 'support_scope_ignored',
    section: '058 §4 — R6 §3.4',
    intent: 'a narrow delegation may be recorded as wider reach than it granted',
    functionName: 'policy_decisions_support_evidence_is_the_approval',
    from: "  IF r.scope_level <> 'tenant'",
    to: "      COALESCE(NEW.scope_level, '<none>'), COALESCE(NEW.scope_id::text, '<none>');\n  END IF;",
    testFile: 'tests/identity-evidence-reconstruction.test.ts',
    testName: 'a support ALLOW cannot exceed the approved SCOPE',
  },
  {
    id: 'support_revocation_ignored',
    section: '058 §4 — R6 §3.4',
    intent: 'a revoked delegation may authorize a support allow',
    functionName: 'policy_decisions_support_evidence_is_the_approval',
    from: '  IF s.revoked_at IS NOT NULL THEN',
    to: '      s.support_session_id, s.revoked_at;\n  END IF;',
    testFile: 'tests/identity-evidence-reconstruction.test.ts',
    testName: 'a support ALLOW cannot be recorded against a REVOKED delegation',
  },
  {
    id: 'support_window_ignored',
    section: '058 §4 — R6 §3.4',
    intent: 'a support allow may be timed outside the window it was delegated for',
    functionName: 'policy_decisions_support_evidence_is_the_approval',
    from: '  IF NEW.occurred_at < s.granted_at OR NEW.occurred_at >= s.expires_at THEN',
    to: '      NEW.occurred_at, s.support_session_id, s.granted_at, s.expires_at;\n  END IF;',
    testFile: 'tests/identity-evidence-reconstruction.test.ts',
    testName: 'a support ALLOW cannot be recorded outside the delegated WINDOW',
  },
  // ── 058 §3 — the normalized rows equal the array ─────────────────────────
  {
    id: 'array_equivalence_not_compared',
    section: '058 §3 — R6 §3.2',
    intent: 'the normalized rows may diverge from the array they normalize',
    functionName: 'policy_decision_matched_bindings_equal_the_array',
    from: '    IF recorded IS DISTINCT FROM COALESCE(claimed, ARRAY[]::text[]) THEN',
    to: '        target, COALESCE(cardinality(recorded), 0), COALESCE(cardinality(claimed), 0);\n    END IF;',
    testFile: 'tests/identity-evidence-reconstruction.test.ts',
    testName: 'an EXTRA normalized row cannot be attached to a decision, marker or no marker',
  },
];

const MIGRATION_058 = '058_policy_evidence_reconstructable.sql';

/** The migration body, canonical LF, so anchors match on Windows and on CI alike. */
function canonical058(): string {
  return readFileSync(join(__dirname, '..', 'migrations', MIGRATION_058), 'utf8').replace(
    /\r\n/g,
    '\n',
  );
}

/**
 * The `CREATE OR REPLACE FUNCTION <name>() … $$ LANGUAGE plpgsql;` statement, verbatim.
 *
 * Located by its header and terminated at the first `$$ LANGUAGE plpgsql;` after it, which
 * is unambiguous because every function in 058 is dollar-quoted with `$$` and closes the
 * same way. A name that does not resolve, or resolves twice, throws: a predicate mutation
 * that silently found nothing would report itself killed.
 */
export function functionStatement(sql: string, name: string): string {
  const header = `CREATE OR REPLACE FUNCTION ${name}() RETURNS TRIGGER AS $$`;
  const first = sql.indexOf(header);
  if (first < 0) throw new Error(`migration ${MIGRATION_058} declares no function ${name}`);
  if (sql.indexOf(header, first + 1) >= 0) {
    throw new Error(`migration ${MIGRATION_058} declares ${name} more than once`);
  }
  const terminator = '$$ LANGUAGE plpgsql;';
  const end = sql.indexOf(terminator, first + header.length);
  if (end < 0) throw new Error(`function ${name} in ${MIGRATION_058} is not terminated`);
  return sql.slice(first, end + terminator.length);
}

/** The same statement with ONE anchored clause removed. */
export function removeClause(statement: string, mutation: PredicateMutation): string {
  const from = statement.indexOf(mutation.from);
  if (from < 0) {
    throw new Error(`${mutation.id}: the opening anchor is not in ${mutation.functionName}`);
  }
  if (statement.indexOf(mutation.from, from + 1) >= 0) {
    throw new Error(`${mutation.id}: the opening anchor occurs more than once`);
  }
  const to = statement.indexOf(mutation.to, from + mutation.from.length);
  if (to < 0) {
    throw new Error(`${mutation.id}: the closing anchor is not after the opening one`);
  }
  return statement.slice(0, from) + statement.slice(to + mutation.to.length);
}

interface Args {
  out: string | undefined;
  log: string | undefined;
  only: string | undefined;
}

/**
 * `--out path`, the same spelling `scripts/upgrade-negative-controls.ts` takes and the
 * one `ci.yml` uses. An earlier version of this function accepted only `--out=path` and
 * SILENTLY IGNORED the space-separated form: the run printed a perfect log and wrote no
 * artifact, and the CI grep would then have failed on a file that was never created.
 * An unrecognized argument is refused rather than dropped.
 */
function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let out: string | undefined;
  let log: string | undefined;
  let only: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === '--out') out = argv[(i += 1)];
    else if (arg === '--log') log = argv[(i += 1)];
    else if (arg === '--only') only = argv[(i += 1)];
    else if (arg.startsWith('--out=')) out = arg.slice('--out='.length);
    else if (arg.startsWith('--log=')) log = arg.slice('--log='.length);
    else if (arg.startsWith('--only=')) only = arg.slice('--only='.length);
    else {
      console.error(`Unrecognized argument: ${arg}`);
      process.exit(2);
    }
  }
  return { out, log, only };
}

function maintenanceUrl(databaseUrl: string): { admin: string; database: string } {
  const url = new URL(databaseUrl);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  url.pathname = '/postgres';
  return { admin: url.toString(), database };
}

function copyUrl(databaseUrl: string, copyName: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${copyName}`;
  return url.toString();
}

interface RunResult {
  passed: boolean;
  ranTheNamedTest: boolean;
  output: string;
}

/**
 * Runs ONE named test against ONE database.
 *
 * `--test-name-pattern` is an anchored, escaped literal, and the result asserts the test
 * REALLY RAN: node's runner exits 0 when a pattern matches nothing, so "no failures"
 * would otherwise be indistinguishable from "the test name in this registry is a typo",
 * and a mutation whose declared test does not exist would report itself killed.
 */
function runNamedTest(testFile: string, testName: string, databaseUrl: string): RunResult {
  const pattern = `^${testName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
  const proc = spawnSync(
    process.execPath,
    [
      join(__dirname, '..', 'node_modules', 'tsx', 'dist', 'cli.mjs'),
      '--test',
      '--test-concurrency=1',
      '--test-reporter=tap',
      `--test-name-pattern=${pattern}`,
      testFile,
    ],
    {
      cwd: join(__dirname, '..'),
      encoding: 'utf8',
      env: { ...process.env, TEST_DATABASE_URL: databaseUrl },
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  const output = `${proc.stdout ?? ''}${proc.stderr ?? ''}`;
  const ran = output.includes(`- ${testName}`);
  return { passed: proc.status === 0, ranTheNamedTest: ran, output };
}

async function main(): Promise<void> {
  const { out, log, only } = parseArgs();
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl === '') {
    console.error(
      'TEST_DATABASE_URL must name the MIGRATED test database. Copies of it are made, ' +
        'mutated and dropped; the named database itself is never written to.',
    );
    process.exit(2);
  }
  const { admin, database: template } = maintenanceUrl(databaseUrl);

  // THE TEMPLATE MUST CARRY 058, checked rather than assumed: on a database without it
  // every DROP fails and every control reports a false result.
  {
    const probe = new Client({ connectionString: databaseUrl });
    await probe.connect();
    try {
      const applied = (
        await probe.query<{ filename: string }>(
          `SELECT filename FROM schema_migrations WHERE filename LIKE '058%'`,
        )
      ).rows;
      if (applied.length === 0) {
        console.error(
          `The template database '${template}' has not applied migration 058, so the ` +
            'controls this runner drops are not there to drop. Migrate it first.',
        );
        process.exitCode = 2;
        return;
      }
    } finally {
      await probe.end();
    }
  }

  const lines: string[] = [];
  const results: Array<Record<string, unknown>> = [];
  let failed = 0;
  const client = new Client({ connectionString: admin });
  await client.connect();

  try {
    for (const [index, control] of CONTROLS.entries()) {
      if (only !== undefined && control.id !== only) continue;
      const copy = `${template}_dc${index}`.slice(0, 63);
      lines.push(`── ${control.id} (${control.section})`);
      await client.query(`DROP DATABASE IF EXISTS "${copy}"`);
      await client.query(`CREATE DATABASE "${copy}" TEMPLATE "${template}"`);
      const copied = copyUrl(databaseUrl, copy);

      const problems: string[] = [];
      try {
        const baseline = runNamedTest(control.testFile, control.testName, copied);
        if (!baseline.ranTheNamedTest) {
          problems.push(`the declared test never ran — no TAP line named "${control.testName}"`);
        }
        if (!baseline.passed) {
          problems.push('the declared test FAILS before the control is dropped');
        }

        if (problems.length === 0) {
          const mutant = new Client({ connectionString: copied });
          await mutant.connect();
          try {
            await mutant.query(control.drop);
          } finally {
            await mutant.end();
          }
          const killed = runNamedTest(control.testFile, control.testName, copied);
          if (!killed.ranTheNamedTest) {
            problems.push('the declared test did not run in the mutated database');
          } else if (killed.passed) {
            problems.push('SURVIVED: the declared test still passes with the control dropped');
          }

          const restorer = new Client({ connectionString: copied });
          await restorer.connect();
          try {
            await restorer.query(control.restore);
          } finally {
            await restorer.end();
          }
          const restored = runNamedTest(control.testFile, control.testName, copied);
          if (!restored.passed) {
            problems.push(
              'the declared test still fails after the control is restored, so the failure ' +
                'above is not attributable to the drop',
            );
          }
        }
      } finally {
        await client.query(`DROP DATABASE IF EXISTS "${copy}"`);
      }

      const ok = problems.length === 0;
      if (!ok) failed += 1;
      for (const p of problems) lines.push(`   ${p}`);
      lines.push(`   ${ok ? 'KILLED' : 'FAILED CHECK'}: ${control.testName}`);
      results.push({
        id: control.id,
        section: control.section,
        intent: control.intent,
        drop: control.drop,
        test_file: control.testFile,
        test_name: control.testName,
        result: ok ? 'killed' : 'failed',
        problems,
      });
    }

    // ── one clause at a time, inside the trigger functions ─────────────────
    const migration = canonical058();
    for (const [index, predicate] of PREDICATES.entries()) {
      if (only !== undefined && predicate.id !== only) continue;
      const original = functionStatement(migration, predicate.functionName);
      const mutated = removeClause(original, predicate);
      const copy = `${template}_dp${index}`.slice(0, 63);
      lines.push(`── ${predicate.id} (${predicate.section})`);
      await client.query(`DROP DATABASE IF EXISTS "${copy}"`);
      await client.query(`CREATE DATABASE "${copy}" TEMPLATE "${template}"`);
      const copied = copyUrl(databaseUrl, copy);

      const problems: string[] = [];
      if (mutated.length >= original.length) {
        problems.push('the anchored clause removed nothing');
      }
      try {
        if (problems.length === 0) {
          const baseline = runNamedTest(predicate.testFile, predicate.testName, copied);
          if (!baseline.ranTheNamedTest) {
            problems.push(
              `the declared test never ran — no TAP line named "${predicate.testName}"`,
            );
          }
          if (!baseline.passed) {
            problems.push('the declared test FAILS before the clause is removed');
          }
        }

        if (problems.length === 0) {
          const mutant = new Client({ connectionString: copied });
          await mutant.connect();
          try {
            await mutant.query(mutated);
          } finally {
            await mutant.end();
          }
          const killed = runNamedTest(predicate.testFile, predicate.testName, copied);
          if (!killed.ranTheNamedTest) {
            problems.push('the declared test did not run against the weakened function');
          } else if (killed.passed) {
            problems.push('SURVIVED: the declared test still passes with the clause removed');
          }

          const restorer = new Client({ connectionString: copied });
          await restorer.connect();
          try {
            await restorer.query(original);
          } finally {
            await restorer.end();
          }
          const restored = runNamedTest(predicate.testFile, predicate.testName, copied);
          if (!restored.passed) {
            problems.push(
              'the declared test still fails after the clause is restored, so the failure ' +
                'above is not attributable to the removal',
            );
          }
        }
      } finally {
        await client.query(`DROP DATABASE IF EXISTS "${copy}"`);
      }

      const ok = problems.length === 0;
      if (!ok) failed += 1;
      for (const p of problems) lines.push(`   ${p}`);
      lines.push(`   ${ok ? 'KILLED' : 'FAILED CHECK'}: ${predicate.testName}`);
      results.push({
        id: predicate.id,
        section: predicate.section,
        intent: predicate.intent,
        drop: `one clause removed from ${predicate.functionName}()`,
        test_file: predicate.testFile,
        test_name: predicate.testName,
        result: ok ? 'killed' : 'failed',
        problems,
      });
    }
  } finally {
    await client.end();
  }

  const summary = {
    tool: 'scripts/database-control-mutations.ts',
    order: 'FBL-020-R6 §4.1',
    taken_at: new Date().toISOString(),
    controls_declared: CONTROLS.length + PREDICATES.length,
    whole_controls_declared: CONTROLS.length,
    predicates_declared: PREDICATES.length,
    controls_run: results.length,
    controls_filtered: only !== undefined,
    killed: results.filter((r) => r.result === 'killed').length,
    survivors: failed,
    controls: results,
  };
  const text = lines.join('\n') + '\n';
  if (out !== undefined) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(summary, null, 2) + '\n', 'utf8');
  }
  if (log !== undefined) {
    mkdirSync(dirname(log), { recursive: true });
    writeFileSync(log, text, 'utf8');
  }
  process.stdout.write(text);
  process.stdout.write(
    `database-control mutations: ${summary.killed} killed, ${summary.survivors} survivor(s), ` +
      `${summary.controls_run}/${summary.controls_declared} run\n`,
  );
  if (failed > 0) process.exitCode = 1;
}

if (require.main === module) {
  void main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
