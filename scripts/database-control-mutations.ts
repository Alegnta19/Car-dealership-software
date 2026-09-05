/**
 * FBL-020-R6 §4.1 + FBL-020-R7 §5 — MUTATION-KILL FOR THE DATABASE CONTROLS.
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

const MIGRATION_058 = '058_policy_evidence_reconstructable.sql';
const MIGRATION_059 = '059_policy_evidence_integrity_closure.sql';

export interface DatabaseControl {
  /** Stable id; also the copy database's suffix. */
  id: string;
  /** The section of migration 058 or 059 the control belongs to. */
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
    /*
     * FBL-020-R7 §3.7 REPLACED the R6-era GUC guard this control used to drop:
     * migration 059 removes `trg_pdmb_authorized_writer` (any session could set
     * the GUC it compared against and walk through) and makes the privilege
     * system itself the writer rule — the runtime role simply cannot INSERT the
     * child table. So the control weakens THAT rule now: granting the runtime
     * role direct DML is exactly the hole the GUC guard pretended to close.
     */
    id: 'child_rows_have_no_authorized_writer',
    section: '059 §7 — R7 §3.7',
    intent:
      'normalized authority evidence is DERIVED from the decision’s array. With direct ' +
      'DML granted to the runtime role, any application-path writer may add one by hand.',
    drop: 'GRANT INSERT, UPDATE, DELETE ON policy_decision_matched_bindings TO dealership_runtime',
    restore:
      'REVOKE INSERT, UPDATE, DELETE ON policy_decision_matched_bindings FROM dealership_runtime',
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

  // ── FBL-020-R7 §3.1/§3.2 — the support tuple and its approval bounds ──────
  //
  // `uq_sar_request_tenant_requester` carries no entry of its own on purpose:
  // `request_id` is the table's primary key, so the three-column unique can
  // never be violated by data — it exists solely as the composite target the
  // FK below rides on, and PostgreSQL refuses to drop it while that FK stands.
  // Dropping the FK is the one honest mutation of the pair.
  {
    id: 'support_session_actor_substitutable',
    section: '059 §1 — R7 §3.1',
    intent:
      'a session’s actor IS the approved requester of its own request, as one referential ' +
      'fact. Dropped, any real platform person may hold a delegation approved for another.',
    drop: 'ALTER TABLE support_access_sessions DROP CONSTRAINT sas_actor_is_the_approved_requester',
    restore:
      'ALTER TABLE support_access_sessions ADD CONSTRAINT sas_actor_is_the_approved_requester ' +
      'FOREIGN KEY (request_id, tenant_id, actor_user_link_id) ' +
      'REFERENCES support_access_requests (request_id, tenant_id, requester_user_link_id) ' +
      'NOT VALID',
    testFile: 'tests/identity-evidence-integrity.test.ts',
    testName:
      'a support session cannot substitute another REAL platform actor for the approved requester',
  },
  {
    id: 'support_requester_scope_unchecked',
    section: '059 §1 — R7 §3.1',
    intent:
      'support access is a PLATFORM delegation; the requester must really be one. Dropped, ' +
      'a dealership link may file (and so eventually hold) a support delegation.',
    drop: 'DROP TRIGGER trg_sar_requester_is_platform ON support_access_requests',
    restore:
      'CREATE TRIGGER trg_sar_requester_is_platform BEFORE INSERT OR UPDATE ON ' +
      'support_access_requests FOR EACH ROW EXECUTE FUNCTION support_request_requester_is_platform()',
    testFile: 'tests/identity-evidence-integrity.test.ts',
    testName: 'a dealership link can neither file nor hold a support delegation',
  },
  {
    id: 'support_session_actor_scope_unchecked',
    section: '059 §1 — R7 §3.1',
    intent:
      'the session actor must be a real platform link INDEPENDENTLY of the tuple FK — the ' +
      'named test pins this rule’s own refusal, which the FK’s different SQLSTATE cannot fake.',
    drop: 'DROP TRIGGER trg_sas_actor_is_platform ON support_access_sessions',
    restore:
      'CREATE TRIGGER trg_sas_actor_is_platform BEFORE INSERT OR UPDATE ON ' +
      'support_access_sessions FOR EACH ROW EXECUTE FUNCTION support_session_actor_is_platform()',
    testFile: 'tests/identity-evidence-integrity.test.ts',
    testName: 'a dealership link can neither file nor hold a support delegation',
  },
  {
    id: 'support_request_authority_rewritable',
    section: '059 §2 — R7 §3.2',
    intent:
      'what a delegation is FOR is fixed at filing. Dropped, an approved request can be ' +
      'widened after the fact and the approval silently covers what nobody approved.',
    drop: 'DROP TRIGGER trg_sar_authority_immutable ON support_access_requests',
    restore:
      'CREATE TRIGGER trg_sar_authority_immutable BEFORE UPDATE ON support_access_requests ' +
      'FOR EACH ROW EXECUTE FUNCTION support_request_authority_is_immutable()',
    testFile: 'tests/identity-evidence-integrity.test.ts',
    testName: 'request and session authority fields are immutable once written',
  },
  {
    id: 'support_session_window_rewritable',
    section: '059 §2 — R7 §3.2',
    intent:
      'which delegation, which actor, and the exact window are a session’s authority. ' +
      'Dropped, a live session’s window can be extended after the fact.',
    drop: 'DROP TRIGGER trg_sas_authority_immutable ON support_access_sessions',
    restore:
      'CREATE TRIGGER trg_sas_authority_immutable BEFORE UPDATE ON support_access_sessions ' +
      'FOR EACH ROW EXECUTE FUNCTION support_session_authority_is_immutable()',
    testFile: 'tests/identity-evidence-integrity.test.ts',
    testName: 'request and session authority fields are immutable once written',
  },
  {
    id: 'support_session_unbounded_by_approval',
    section: '059 §2 — R7 §3.2',
    intent:
      'a session exists only under a decided approval, starts no earlier and lasts no ' +
      'longer than it. Dropped, an approval of one minute can produce an afternoon.',
    drop: 'DROP TRIGGER trg_sas_bounded_by_approval ON support_access_sessions',
    restore:
      'CREATE TRIGGER trg_sas_bounded_by_approval BEFORE INSERT ON support_access_sessions ' +
      'FOR EACH ROW EXECUTE FUNCTION support_session_is_bounded_by_its_approval()',
    testFile: 'tests/identity-evidence-integrity.test.ts',
    testName: 'a one-minute approval cannot produce a longer session',
  },
  {
    id: 'support_approval_grant_unjudged',
    section: '059 §2 — R7 §3.2',
    intent:
      'the approval grant IS the approval — right action, this exact request, required ' +
      'assurance, certified MFA, an effective approved scope. Dropped, any consumed grant ' +
      'of the decider’s approves anything.',
    drop: 'DROP TRIGGER trg_sar_grant_is_the_approval ON support_access_requests',
    restore:
      'CREATE TRIGGER trg_sar_grant_is_the_approval BEFORE INSERT OR UPDATE ON ' +
      'support_access_requests FOR EACH ROW EXECUTE FUNCTION support_approval_grant_is_the_approval()',
    testFile: 'tests/identity-evidence-integrity.test.ts',
    testName: 'a wrong-action or wrong-resource REAL grant cannot approve a support request',
  },

  // ── FBL-020-R7 §3.3/§3.4 — the version-4 structural rules ─────────────────
  {
    id: 'resource_snapshot_escapes_the_tenant',
    section: '059 §4 — R7 §3.4',
    intent:
      'the persisted resource-rooftop snapshot is a rooftop OF THE DECISION’S OWN TENANT, ' +
      'referentially. Dropped, evidence may carry another tenant’s rooftop as its leaf.',
    drop: 'ALTER TABLE policy_decisions DROP CONSTRAINT pd_resource_rooftop_in_tenant',
    restore:
      'ALTER TABLE policy_decisions ADD CONSTRAINT pd_resource_rooftop_in_tenant ' +
      'FOREIGN KEY (tenant_id, resource_rooftop_id) REFERENCES rooftops (tenant_id, rooftop_id) ' +
      'NOT VALID',
    testFile: 'tests/identity-evidence-integrity.test.ts',
    testName: 'a resource-rooftop snapshot cannot name another tenant’s rooftop',
  },
  {
    id: 'support_tenant_allow_v4_needs_no_delegation',
    section: '059 §5 — R7 §3.3',
    intent:
      'the v2 delegation rule exempted rows by ACTION NAME (`platform.*`); the v4 rule is ' +
      'structural. Dropped, a platform-named allow reaches into a tenant undelegated again.',
    drop: 'ALTER TABLE policy_decisions DROP CONSTRAINT pd_v4_support_tenant_allow_is_delegated',
    restore:
      'ALTER TABLE policy_decisions ADD CONSTRAINT pd_v4_support_tenant_allow_is_delegated ' +
      "CHECK (evidence_version < 4 OR decision = 'deny' OR actor_type <> 'platform_support' " +
      'OR tenant_id IS NULL OR support_session_id IS NOT NULL)',
    testFile: 'tests/identity-evidence-integrity.test.ts',
    testName:
      'a platform-prefixed action cannot carry customer resource evidence without delegation',
  },
  {
    id: 'control_plane_carries_customer_payload',
    section: '059 §5 — R7 §3.3',
    intent:
      'a control-plane decision is structurally platform-scoped: no authorization tenant, ' +
      'no customer-resource payload. Dropped, platform rows may smuggle customer evidence.',
    drop: 'ALTER TABLE policy_decisions DROP CONSTRAINT pd_v4_control_plane_is_structural',
    restore:
      'ALTER TABLE policy_decisions ADD CONSTRAINT pd_v4_control_plane_is_structural ' +
      "CHECK (evidence_version < 4 OR scope_level IS DISTINCT FROM 'platform' " +
      'OR (tenant_id IS NULL AND resource_type IS NULL AND resource_id IS NULL)) NOT VALID',
    testFile: 'tests/identity-evidence-integrity.test.ts',
    testName: 'a control-plane decision cannot smuggle a customer-resource payload',
  },
  {
    id: 'target_tenant_rides_authorization_rows',
    section: '059 §5 — R7 §3.3',
    intent:
      'the operational target of a control-plane action is METADATA, present only on ' +
      'platform-scoped rows. Dropped, it doubles as a second tenant column on any row.',
    drop: 'ALTER TABLE policy_decisions DROP CONSTRAINT pd_v4_target_tenant_is_metadata',
    restore:
      'ALTER TABLE policy_decisions ADD CONSTRAINT pd_v4_target_tenant_is_metadata ' +
      "CHECK (control_plane_target_tenant_id IS NULL OR scope_level = 'platform') NOT VALID",
    testFile: 'tests/identity-evidence-integrity.test.ts',
    testName: 'the control-plane target tenant cannot ride on a tenant-scoped decision',
  },
  {
    id: 'identified_actor_tenantless_by_name',
    section: '059 §5 — R7 §3.3',
    intent:
      'an identified actor’s allow names a tenant unless the decision is structurally ' +
      'platform-scoped — the v2 rule’s `platform.*` NAME bypass is what this replaces.',
    drop: 'ALTER TABLE policy_decisions DROP CONSTRAINT pd_v4_identified_actor_names_a_tenant',
    restore:
      'ALTER TABLE policy_decisions ADD CONSTRAINT pd_v4_identified_actor_names_a_tenant ' +
      "CHECK (evidence_version < 4 OR actor_type = 'system' OR decision = 'deny' " +
      "OR tenant_id IS NOT NULL OR scope_level = 'platform')",
    testFile: 'tests/identity-evidence-integrity.test.ts',
    testName: 'a platform-NAMED action cannot free an identified actor from naming a tenant',
  },
  /*
   * `resource_allow_snapshotless` — 059's `pd_v4_resource_allow_names_its_rooftop`
   * CHECK — is RETIRED here for the same reason binding_tenant_ignored is: §6 makes
   * it unkillable, not uncovered.
   *
   * That CHECK requires a version-4 resource ALLOW to carry a resource_rooftop_id.
   * Whenever a resource ALLOW names a TENANT, 059's structural trigger
   * (policy_decisions_v4_structural_validity) resolves the leaf from the database and
   * ASSIGNS `NEW.resource_rooftop_id := resolved_leaf` before the CHECK is evaluated —
   * so the column is never null when the trigger runs, and the CHECK is inert. The
   * CHECK could therefore only ever be the operative refusal on the ONE lane the
   * trigger skips: a null-tenant row (the trigger is guarded by tenant IS NOT NULL).
   * FBL-020-R7-C1 §6 (`pd_resource_allow_names_a_tenant`) now forbids exactly that
   * null-tenant resource ALLOW, so dropping 059's CHECK changes no observable
   * outcome and a mutation over it is an un-killable survivor.
   *
   * The PROTECTION — a resource ALLOW carries a database-validated leaf — is unchanged
   * and STILL mutation-covered: leaf resolution/validation is covered by
   * `v4_structural_judge_absent` below (the whole trigger), and the null-tenant lane
   * by `system_resource_allow_needs_no_tenant`. 059's CHECK stays in the migration as
   * immutable defense in depth. See docs/FBL-020-R7-C1-REQUIREMENT-MAP.json §6.
   */
  {
    id: 'v4_structural_judge_absent',
    section: '059 §5 — R7 §3.1/§3.4/§3.5/§3.6',
    intent:
      'the BEFORE INSERT judge for version-4 rows: real actor scope behind the label, the ' +
      'resolved and validated resource leaf, effective chains at the actual write instant, ' +
      'a consistent occurred_at. Dropped, the label forgery every earlier support ' +
      'adversary was built on is representable again.',
    drop: 'DROP TRIGGER trg_policy_decisions_v4_structure ON policy_decisions',
    restore:
      'CREATE TRIGGER trg_policy_decisions_v4_structure BEFORE INSERT ON policy_decisions ' +
      'FOR EACH ROW EXECUTE FUNCTION policy_decisions_v4_structural_validity()',
    testFile: 'tests/identity-evidence-integrity.test.ts',
    testName: 'a dealership link cannot be recorded as a platform-support actor',
  },
  {
    id: 'binding_liveness_stops_at_transaction_start',
    section: '059 §5 — R7 §3.6',
    intent:
      'a matched binding must be live at the ACTUAL WRITE INSTANT; 058’s (era-correct) ' +
      'checks read the transaction-start clock. Dropped, a custody transaction that ' +
      'outlives its authority records evidence anyway.',
    drop: 'DROP TRIGGER trg_pdmb_live_and_reaches_the_resource ON policy_decision_matched_bindings',
    restore:
      'CREATE TRIGGER trg_pdmb_live_and_reaches_the_resource BEFORE INSERT ON ' +
      'policy_decision_matched_bindings FOR EACH ROW EXECUTE FUNCTION ' +
      'policy_decision_binding_is_live_and_reaches_the_resource()',
    testFile: 'tests/identity-evidence-integrity.test.ts',
    testName: 'a transaction started before a binding expired and completed after it is refused',
  },
  {
    id: 'support_expiry_stops_at_occurred_at',
    section: '059 §5 — R7 §3.6',
    intent:
      'the delegated window is judged against the wall clock at the write, not against ' +
      'the row’s own occurred_at claim. Dropped, a backdated occurrence revives an ' +
      'expired delegation.',
    drop: 'DROP TRIGGER trg_policy_decisions_support_live ON policy_decisions',
    restore:
      'CREATE TRIGGER trg_policy_decisions_support_live BEFORE INSERT ON policy_decisions ' +
      'FOR EACH ROW EXECUTE FUNCTION policy_decisions_support_session_is_live()',
    testFile: 'tests/identity-evidence-integrity.test.ts',
    testName: 'an expired support session combined with a backdated occurred_at is refused',
  },

  // ── FBL-020-R7 §3.7 — the privilege model around normalization ────────────
  {
    id: 'normalizer_stripped_of_its_own_authority',
    section: '059 §7 — R7 §3.7',
    intent:
      'the SECURITY DEFINER normalizer is the ONE writer of the child table because its ' +
      'owner is the one role granted INSERT. Revoked, the production write path itself ' +
      'stops producing evidence — which the positive leg of the named test refuses.',
    drop: 'REVOKE INSERT ON policy_decision_matched_bindings FROM dealership_evidence_owner',
    restore: 'GRANT INSERT ON policy_decision_matched_bindings TO dealership_evidence_owner',
    testFile: 'tests/identity-evidence-reconstruction.test.ts',
    testName: 'a child row written with no normalizer behind it is refused',
  },
  {
    id: 'normalization_runs_with_caller_rights',
    section: '059 §7 — R7 §3.7',
    intent:
      'normalization is DATABASE-OWNED: it runs with the evidence owner’s rights, not the ' +
      'caller’s. As SECURITY INVOKER the runtime role could never normalize its own ' +
      'parent inserts — and anything that could would also write children directly.',
    drop: 'ALTER FUNCTION policy_decisions_normalize_matched_bindings() SECURITY INVOKER',
    restore: 'ALTER FUNCTION policy_decisions_normalize_matched_bindings() SECURITY DEFINER',
    testFile: 'tests/identity-evidence-reconstruction.test.ts',
    testName: 'a child row written with no normalizer behind it is refused',
  },
  {
    id: 'owner_role_assumable_by_the_runtime',
    section: '059 §7 — R7 §3.7',
    intent:
      'the runtime role must NOT be a member of the evidence owner — membership would let ' +
      'it inherit the child-table INSERT and the whole separation collapses. This grant is ' +
      'CLUSTER-VISIBLE, which is why the runner always restores after a successful drop.',
    drop: 'GRANT dealership_evidence_owner TO dealership_runtime',
    restore: 'REVOKE dealership_evidence_owner FROM dealership_runtime',
    testFile: 'tests/identity-evidence-reconstruction.test.ts',
    testName: 'a child row written with no normalizer behind it is refused',
  },

  // ── FBL-020-R7-C1 (migration 060) — THE ACCEPTANCE-CORRECTION CONTROLS ────
  {
    id: 'runtime_can_write_the_ledger',
    section: '060 §1 — R7-C1 §2',
    intent:
      'the runtime role must not be able to rewrite the migration ledger. Granted INSERT ' +
      'on schema_migrations, the app login (which inherits the runtime role) can, and the ' +
      'posture gate stops refusing it.',
    drop: 'GRANT INSERT ON schema_migrations TO dealership_runtime',
    restore: 'REVOKE INSERT ON schema_migrations FROM dealership_runtime',
    testFile: 'tests/runtime-posture.test.ts',
    testName: 'the app login is non-owner, non-superuser, and least-privilege',
  },
  {
    id: 'support_authority_not_live_at_write',
    section: '060 §2 — R7-C1 §4',
    intent:
      'a support ALLOW must be refused when the actor’s platform authority is revoked or ' +
      'aged out at the write instant. Dropped, the evaluation-to-write race reopens.',
    drop: 'DROP TRIGGER trg_policy_decisions_zz_support_authority_live ON policy_decisions',
    restore:
      'CREATE TRIGGER trg_policy_decisions_zz_support_authority_live BEFORE INSERT ON ' +
      'policy_decisions FOR EACH ROW EXECUTE FUNCTION policy_decisions_support_authority_is_live()',
    testFile: 'tests/identity-evidence-integrity.test.ts',
    testName:
      'a support ALLOW is refused when the actor’s platform binding is revoked before the write',
  },
  {
    id: 'support_scope_ignores_the_resource',
    section: '060 §3 — R7-C1 §5',
    intent:
      'a support ALLOW’s approved scope must cover the resource it names. Dropped, a ' +
      'rooftop-A approval authorizes a rooftop-B resource.',
    drop: 'DROP TRIGGER trg_policy_decisions_zz_support_scope_reaches_resource ON policy_decisions',
    restore:
      'CREATE TRIGGER trg_policy_decisions_zz_support_scope_reaches_resource BEFORE INSERT ON ' +
      'policy_decisions FOR EACH ROW EXECUTE FUNCTION ' +
      'policy_decisions_support_scope_reaches_resource()',
    testFile: 'tests/identity-evidence-integrity.test.ts',
    testName: 'a rooftop-A support approval cannot authorize a rooftop-B resource',
  },
  {
    id: 'system_resource_allow_needs_no_tenant',
    section: '060 §4 — R7-C1 §6',
    intent:
      'a resource ALLOW must name a tenant so 059’s resolution validates its snapshot. ' +
      'Dropped, a system row with a null tenant and a fabricated snapshot bypasses ' +
      'resolution.',
    drop: 'ALTER TABLE policy_decisions DROP CONSTRAINT pd_resource_allow_names_a_tenant',
    restore:
      'ALTER TABLE policy_decisions ADD CONSTRAINT pd_resource_allow_names_a_tenant ' +
      "CHECK (decision = 'deny' OR resource_type IS NULL OR tenant_id IS NOT NULL " +
      "OR scope_level IS NOT DISTINCT FROM 'platform') NOT VALID",
    testFile: 'tests/identity-evidence-integrity.test.ts',
    testName:
      'a system resource ALLOW cannot carry a null tenant and a fabricated rooftop snapshot',
  },
  {
    id: 'system_row_carries_human_evidence',
    section: '060 §4 — R7-C1 §6',
    intent:
      'a system row is not a costume an ordinary decision wears to shed validation. ' +
      'Dropped, a system row may carry a real human actor.',
    drop: 'ALTER TABLE policy_decisions DROP CONSTRAINT pd_system_row_carries_no_human_evidence',
    restore:
      'ALTER TABLE policy_decisions ADD CONSTRAINT pd_system_row_carries_no_human_evidence ' +
      "CHECK (actor_type <> 'system' OR (actor_user_link_id IS NULL AND session_id IS NULL " +
      'AND connection_id IS NULL AND actor_provider_subject IS NULL ' +
      'AND support_session_id IS NULL AND support_request_id IS NULL)) NOT VALID',
    testFile: 'tests/identity-evidence-integrity.test.ts',
    testName: 'a system row cannot carry human, credential or support evidence',
  },
  {
    id: 'staged_approval_skips_validation',
    section: '060 §5 — R7-C1 §7',
    intent:
      'the complete approval invariant must be re-validated whenever a request is approved, ' +
      'not only when the grant id changes. Dropped, a staged pending-then-approved ' +
      'transition bypasses scope/grant validation.',
    drop: 'DROP TRIGGER trg_sar_zz_approval_is_complete ON support_access_requests',
    restore:
      'CREATE TRIGGER trg_sar_zz_approval_is_complete BEFORE INSERT OR UPDATE ON ' +
      'support_access_requests FOR EACH ROW EXECUTE FUNCTION ' +
      'support_request_approval_is_complete()',
    testFile: 'tests/identity-evidence-integrity.test.ts',
    testName: 'a staged pending-then-approved transition cannot bypass scope validation',
  },
  // ── RELEASE TRAIN 4 (migration 064) — the structural prohibitions ─────────
  //
  // These belong in THIS runner rather than in `mutation-kill.ts` for the same
  // structural reason the §3 controls do: each is a CHECK or a UNIQUE INDEX in
  // an already-migrated database, so editing 064 proves nothing — the suite
  // runs against a database where 064 was applied long before the edit.
  //
  // The first two are the promise that this train carries no money. RT3 made
  // the same promise with `ck_attribution_pre_sale_revenue`, and the reason to
  // register it here is that a constraint nobody has ever seen fail is
  // indistinguishable from a constraint that was quietly dropped.
  //
  // WHY THESE THREE RESTORES CLEAN BEFORE THEY REBUILD, and the other sixty-nine
  // do not. Every §3 control is a TRIGGER: with it dropped, the declared test's
  // write SUCCEEDS but the runner's copy is left holding one extra row that
  // nothing later reads, so `CREATE TRIGGER` puts it straight back. These three
  // are DATA INVARIANTS. With one dropped, the test's write succeeds and leaves
  // behind exactly the row the invariant forbids — and `ADD CONSTRAINT` then
  // refuses, because the table no longer satisfies the rule being restored. The
  // restore is written as a DO block (still one statement) that first undoes the
  // damage the missing control permitted and then rebuilds the control itself.
  // That is what restoring a data invariant MEANS; it is not a weakening, and
  // the rebuilt constraint is validated against the whole table exactly as 064
  // declares it.
  // ── RT4-C1 (migration 064, as corrected) ─────────────────────────────────
  //
  // Four more invariants that live in the DATABASE and nowhere a source edit can
  // reach: one active visit per customer, one active drive per driver, one per
  // accompanying salesperson, and exactly one desking handoff per opportunity.
  // Each is checked by its service too, so the caller gets a sentence — but the
  // service is one caller, and these are the invariant.
  {
    id: 'one_customer_may_have_two_open_visits',
    section: '064 §2 — FBL-100 / RT4-C1',
    intent:
      'a person is in the building or they are not. Dropped, one customer can hold two ' +
      'open visits — a board that double-counts them, a wait timer measuring the wrong ' +
      'arrival, and two salespeople each believing they have them.',
    drop: 'DROP INDEX uq_showroom_visits_one_active',
    restore:
      'DO $$ BEGIN ' +
      'CREATE TEMP TABLE dup_visits AS' +
      ' SELECT v.tenant_id, v.visit_id FROM showroom_visits v, showroom_visits w' +
      '  WHERE v.tenant_id = w.tenant_id AND v.party_id = w.party_id' +
      "    AND v.state <> 'departed' AND w.state <> 'departed'" +
      '    AND v.visit_id > w.visit_id; ' +
      'DELETE FROM demonstration_events de USING demonstrations d, dup_visits x' +
      ' WHERE de.tenant_id = d.tenant_id AND de.demonstration_id = d.demonstration_id' +
      '   AND d.tenant_id = x.tenant_id AND d.visit_id = x.visit_id; ' +
      'DELETE FROM demonstrations d USING dup_visits x' +
      ' WHERE d.tenant_id = x.tenant_id AND d.visit_id = x.visit_id; ' +
      'DELETE FROM visit_events e USING dup_visits x' +
      ' WHERE e.tenant_id = x.tenant_id AND e.visit_id = x.visit_id; ' +
      'DELETE FROM showroom_visits v USING dup_visits x' +
      ' WHERE v.tenant_id = x.tenant_id AND v.visit_id = x.visit_id; ' +
      'DROP TABLE dup_visits; ' +
      'CREATE UNIQUE INDEX uq_showroom_visits_one_active ON showroom_visits ' +
      "(tenant_id, party_id) WHERE state <> 'departed'; END $$",
    testFile: 'tests/sales-floor.test.ts',
    testName: 'the backstop keys refuse duplicates with every service stepped round',
  },
  {
    id: 'one_driver_may_drive_two_cars',
    section: '064 §3 — FBL-100 / RT4-C1',
    intent:
      'one person cannot be driving two cars. Dropped, two active drives for one ' +
      'customer means somebody typed the wrong car and nobody can tell afterwards ' +
      'which record was the real one.',
    drop: 'DROP INDEX uq_demonstrations_driver_out',
    restore:
      'DO $$ BEGIN ' +
      'DELETE FROM demonstration_events de USING demonstrations d, demonstrations e' +
      ' WHERE de.tenant_id = d.tenant_id AND de.demonstration_id = d.demonstration_id' +
      '   AND d.tenant_id = e.tenant_id AND d.driver_party_id = e.driver_party_id' +
      "   AND d.state IN ('issued', 'in_progress')" +
      "   AND e.state IN ('issued', 'in_progress')" +
      '   AND d.demonstration_id > e.demonstration_id; ' +
      'DELETE FROM demonstrations d USING demonstrations e' +
      ' WHERE d.tenant_id = e.tenant_id AND d.driver_party_id = e.driver_party_id' +
      "   AND d.state IN ('issued', 'in_progress')" +
      "   AND e.state IN ('issued', 'in_progress')" +
      '   AND d.demonstration_id > e.demonstration_id; ' +
      'CREATE UNIQUE INDEX uq_demonstrations_driver_out ON demonstrations ' +
      "(tenant_id, driver_party_id) WHERE state IN ('issued', 'in_progress'); END $$",
    testFile: 'tests/sales-floor.test.ts',
    testName: 'the backstop keys refuse duplicates with every service stepped round',
  },
  {
    id: 'one_salesperson_may_accompany_two_drives',
    section: '064 §3 — FBL-100 / RT4-C1',
    intent:
      'one employee cannot ride along on two drives. An unaccompanied drive is a ' +
      'deliberate decision; being recorded on two at once is a mistake.',
    drop: 'DROP INDEX uq_demonstrations_escort_out',
    restore:
      'DO $$ BEGIN ' +
      'DELETE FROM demonstration_events de USING demonstrations d, demonstrations e' +
      ' WHERE de.tenant_id = d.tenant_id AND de.demonstration_id = d.demonstration_id' +
      '   AND d.tenant_id = e.tenant_id AND d.accompanied_by_user_link_id = e.accompanied_by_user_link_id' +
      "   AND d.state IN ('issued', 'in_progress')" +
      "   AND e.state IN ('issued', 'in_progress')" +
      '   AND d.demonstration_id > e.demonstration_id; ' +
      'DELETE FROM demonstrations d USING demonstrations e' +
      ' WHERE d.tenant_id = e.tenant_id AND d.accompanied_by_user_link_id = e.accompanied_by_user_link_id' +
      "   AND d.state IN ('issued', 'in_progress')" +
      "   AND e.state IN ('issued', 'in_progress')" +
      '   AND d.demonstration_id > e.demonstration_id; ' +
      'CREATE UNIQUE INDEX uq_demonstrations_escort_out ON demonstrations ' +
      "(tenant_id, accompanied_by_user_link_id) WHERE state IN ('issued', 'in_progress'); END $$",
    testFile: 'tests/sales-floor.test.ts',
    testName: 'the backstop keys refuse duplicates with every service stepped round',
  },
  {
    id: 'desking_may_be_handed_twice',
    section: '064 §5 — FBL-100 / RT4-C1',
    intent:
      'EXACTLY ONE desking handoff per opportunity — the whole idempotence guarantee ' +
      'for the one fact this train hands on. Dropped, a replay opens a second file on ' +
      'the desk for a customer who committed once.',
    drop: 'ALTER TABLE desking_handoffs DROP CONSTRAINT desking_handoffs_tenant_id_opportunity_id_key',
    restore:
      'DO $$ BEGIN ' +
      'DELETE FROM desking_handoffs d USING desking_handoffs e ' +
      ' WHERE d.tenant_id = e.tenant_id AND d.opportunity_id = e.opportunity_id ' +
      '   AND d.desking_handoff_id > e.desking_handoff_id; ' +
      'ALTER TABLE desking_handoffs ' +
      'ADD CONSTRAINT desking_handoffs_tenant_id_opportunity_id_key ' +
      'UNIQUE (tenant_id, opportunity_id); END $$',
    testFile: 'tests/sales-floor.test.ts',
    testName: 'the database itself refuses a second desking handoff, service stepped round',
  },
  {
    id: 'opportunity_may_claim_a_deal',
    section: '064 §1 — FBL-100',
    intent:
      'an opportunity cannot declare a deal AVAILABLE before desking exists to make one. ' +
      'Dropped, a pipeline row can claim a sale this platform has no record of.',
    drop: 'ALTER TABLE opportunities DROP CONSTRAINT ck_opportunity_pre_deal',
    restore:
      'DO $$ BEGIN ' +
      "UPDATE opportunities SET deal_status = 'NOT_YET_AVAILABLE' " +
      "WHERE deal_status <> 'NOT_YET_AVAILABLE'; " +
      'ALTER TABLE opportunities ADD CONSTRAINT ck_opportunity_pre_deal ' +
      "CHECK (deal_status = 'NOT_YET_AVAILABLE'); END $$",
    testFile: 'tests/sales-authority.test.ts',
    testName: 'pre-sale money is unrepresentable — the database refuses it, by name',
  },
  {
    id: 'negotiation_may_carry_a_price',
    section: '064 §8 — FBL-100',
    intent:
      'a negotiation round records what was SAID and never a figure. Dropped, a round can ' +
      'declare pricing AVAILABLE while no desking exists to have produced it.',
    drop: 'ALTER TABLE negotiation_rounds DROP CONSTRAINT ck_negotiation_pre_desking',
    restore:
      'DO $$ BEGIN ' +
      "UPDATE negotiation_rounds SET pricing_status = 'NOT_YET_AVAILABLE' " +
      "WHERE pricing_status <> 'NOT_YET_AVAILABLE'; " +
      'ALTER TABLE negotiation_rounds ADD CONSTRAINT ck_negotiation_pre_desking ' +
      "CHECK (pricing_status = 'NOT_YET_AVAILABLE'); END $$",
    testFile: 'tests/sales-authority.test.ts',
    testName: 'pre-sale money is unrepresentable — the database refuses it, by name',
  },
  {
    id: 'one_car_may_go_out_twice',
    section: '064 §5 — FBL-100',
    intent:
      'a stock item cannot be on two test drives at once. The service also serializes on ' +
      'the car, so this index is the BACKSTOP for any writer that does not — dropped, a ' +
      'caller reaching the table by another route puts one car in two places.',
    drop: 'DROP INDEX uq_demonstrations_vehicle_out',
    restore:
      'DO $$ BEGIN ' +
      'DELETE FROM demonstration_events de USING demonstrations d, demonstrations e' +
      ' WHERE de.tenant_id = d.tenant_id AND de.demonstration_id = d.demonstration_id' +
      '   AND d.tenant_id = e.tenant_id AND d.stock_item_id = e.stock_item_id' +
      "   AND d.state IN ('issued', 'in_progress')" +
      "   AND e.state IN ('issued', 'in_progress')" +
      '   AND d.demonstration_id > e.demonstration_id; ' +
      'DELETE FROM demonstrations d USING demonstrations e' +
      ' WHERE d.tenant_id = e.tenant_id AND d.stock_item_id = e.stock_item_id' +
      "   AND d.state IN ('issued', 'in_progress')" +
      "   AND e.state IN ('issued', 'in_progress')" +
      '   AND d.demonstration_id > e.demonstration_id; ' +
      'CREATE UNIQUE INDEX uq_demonstrations_vehicle_out ON demonstrations ' +
      "(tenant_id, stock_item_id) WHERE state IN ('issued', 'in_progress'); END $$",
    testFile: 'tests/sales-floor.test.ts',
    testName: 'the backstop keys refuse duplicates with every service stepped round',
  },

  // ── FBL-120: the keys, checks and triggers migration 065 adds ───────────
  {
    id: 'desk_file_may_be_opened_twice',
    section: '065 §1 — FBL-120 Row 1',
    intent:
      "a desk file is unique per handed-on fact AND per opportunity. Dropped, one customer's conversation can be desked twice and two managers can approve two different deals on the same car.",
    drop: 'ALTER TABLE desking_cases DROP CONSTRAINT desking_cases_tenant_id_desking_handoff_id_key, DROP CONSTRAINT desking_cases_tenant_id_opportunity_id_key',
    restore:
      'DO $$ BEGIN DELETE FROM desking_cases a USING desking_cases b WHERE a.ctid > b.ctid AND a.tenant_id = b.tenant_id AND a.desking_handoff_id = b.desking_handoff_id; ALTER TABLE desking_cases ADD CONSTRAINT desking_cases_tenant_id_desking_handoff_id_key UNIQUE (tenant_id, desking_handoff_id), ADD CONSTRAINT desking_cases_tenant_id_opportunity_id_key UNIQUE (tenant_id, opportunity_id); END $$',
    testFile: 'tests/desking-approval.test.ts',
    testName: 'the backstop keys refuse duplicates with every service stepped round',
  },
  {
    id: 'two_trades_on_one_file',
    section: '065 §2 — FBL-120 Row 2',
    intent:
      'one trade unit per desk file. Dropped, a second appraisal can sit beside the first and no reader can say which one a version was priced against.',
    drop: 'ALTER TABLE appraisals DROP CONSTRAINT appraisals_tenant_id_desking_case_id_key',
    restore:
      'DO $$ BEGIN DELETE FROM appraisals a USING appraisals b WHERE a.ctid > b.ctid AND a.tenant_id = b.tenant_id AND a.desking_case_id = b.desking_case_id; ALTER TABLE appraisals ADD CONSTRAINT appraisals_tenant_id_desking_case_id_key UNIQUE (tenant_id, desking_case_id); END $$',
    testFile: 'tests/desking-approval.test.ts',
    testName: 'the backstop keys refuse duplicates with every service stepped round',
  },
  {
    id: 'two_approved_versions_on_one_file',
    section: '065 §4 — FBL-120 Rows 5 and 6',
    intent:
      'ONE current approved version per opportunity. Dropped, two frozen versions of the same deal are both approved and the deal jacket has no single answer to read.',
    drop: 'DROP INDEX uq_scenario_one_approved_per_case',
    restore:
      "DO $$ BEGIN DELETE FROM desking_scenarios WHERE version_no > 50; CREATE UNIQUE INDEX uq_scenario_one_approved_per_case ON desking_scenarios (tenant_id, desking_case_id) WHERE state = 'approved'; END $$",
    testFile: 'tests/desking-approval.test.ts',
    testName: 'the backstop keys refuse duplicates with every service stepped round',
  },
  {
    id: 'one_version_decided_twice',
    section: '065 §5 — FBL-120 Row 5',
    intent:
      'one decision per version. Dropped, the same version carries an approval and a rejection and the history says both.',
    drop: 'ALTER TABLE scenario_approvals DROP CONSTRAINT scenario_approvals_tenant_id_scenario_id_key',
    restore:
      'DO $$ BEGIN DELETE FROM scenario_approvals a USING scenario_approvals b WHERE a.ctid > b.ctid AND a.tenant_id = b.tenant_id AND a.scenario_id = b.scenario_id; ALTER TABLE scenario_approvals ADD CONSTRAINT scenario_approvals_tenant_id_scenario_id_key UNIQUE (tenant_id, scenario_id); END $$',
    testFile: 'tests/desking-approval.test.ts',
    testName: 'the backstop keys refuse duplicates with every service stepped round',
  },
  {
    id: 'rule_intervals_may_overlap',
    section: '065 §3 — FBL-120 Row 4',
    intent:
      'two rules of one kind and code cannot both be in force over one instant. Dropped, the rule book answers twice and cannot say what the tax is.',
    drop: 'ALTER TABLE desking_rules DROP CONSTRAINT uq_desking_rules_no_overlap',
    restore:
      "DO $$ BEGIN DELETE FROM desking_rules a USING desking_rules b WHERE a.ctid > b.ctid AND a.tenant_id = b.tenant_id AND a.rule_kind = b.rule_kind AND a.rule_code = b.rule_code AND a.jurisdiction = b.jurisdiction AND COALESCE(a.rooftop_id, '00000000-0000-0000-0000-000000000000'::uuid) = COALESCE(b.rooftop_id, '00000000-0000-0000-0000-000000000000'::uuid) AND tstzrange(a.effective_from, a.effective_to) && tstzrange(b.effective_from, b.effective_to); ALTER TABLE desking_rules ADD CONSTRAINT uq_desking_rules_no_overlap EXCLUDE USING gist (tenant_id WITH =, rule_kind WITH =, rule_code WITH =, jurisdiction WITH =, (COALESCE(rooftop_id, '00000000-0000-0000-0000-000000000000'::uuid)) WITH =, tstzrange(effective_from, effective_to) WITH &&); END $$",
    testFile: 'tests/desking-rules.test.ts',
    testName: 'two rules of the same kind and code cannot both be in force over one instant',
  },
  {
    id: 'quotation_absence_may_carry_a_number',
    section: '065 §2 — FBL-120 Row 2',
    intent:
      'a valuation row says a number or says NOT_YET_AVAILABLE, never both and never neither. Dropped, an absence carries a figure and a fabrication reads as a quote.',
    drop: 'ALTER TABLE appraisal_source_quotations DROP CONSTRAINT ck_quotation_value_iff_quoted',
    restore:
      "DO $$ BEGIN DELETE FROM appraisal_source_quotations WHERE provider_code = 'sneaky'; ALTER TABLE appraisal_source_quotations ADD CONSTRAINT ck_quotation_value_iff_quoted CHECK ((availability = 'quoted' AND quoted_value_cents IS NOT NULL AND currency IS NOT NULL AND quoted_at IS NOT NULL) OR (availability = 'NOT_YET_AVAILABLE' AND quoted_value_cents IS NULL AND currency IS NULL AND quoted_at IS NULL AND unavailable_reason IS NOT NULL)); END $$",
    testFile: 'tests/desking-appraisal.test.ts',
    testName: 'a valuation is a number or an honest absence, and never both',
  },
  {
    id: 'appraisal_evidence_editable',
    section: '065 §10 — FBL-120 Row 2',
    intent:
      'a recorded appraisal version is evidence. Dropped, the walk-around can be rewritten after the fact and the version history means nothing.',
    drop: 'DROP TRIGGER trg_appraisal_versions_append_only ON appraisal_versions',
    restore:
      'CREATE TRIGGER trg_appraisal_versions_append_only BEFORE UPDATE OR DELETE ON appraisal_versions FOR EACH ROW EXECUTE FUNCTION appraisal_versions_append_only()',
    testFile: 'tests/desking-appraisal.test.ts',
    testName:
      'the database refuses to edit or delete a recorded version, with the service stepped round',
  },
  {
    id: 'approved_figures_editable',
    section: '065 §10 — FBL-120 Row 5',
    intent:
      "a version's figures are written once and an approved one may only be superseded. Dropped, the numbers a manager approved can be edited underneath the decision.",
    drop: 'DROP TRIGGER trg_desking_scenarios_freeze ON desking_scenarios',
    restore:
      'CREATE TRIGGER trg_desking_scenarios_freeze BEFORE UPDATE ON desking_scenarios FOR EACH ROW EXECUTE FUNCTION desking_scenarios_freeze()',
    testFile: 'tests/desking-approval.test.ts',
    testName: 'an approved version cannot be edited, and only supersession moves it',
  },
  {
    id: 'approval_unbound_from_the_reviewed_version',
    section: '065 §10 — FBL-120 Row 5',
    intent:
      'a decision names the exact figures reviewed. Dropped, an approval can be recorded against a version that has since been rebuilt, and nobody can say what was signed.',
    drop: 'DROP TRIGGER trg_scenario_approvals_bind_reviewed_version ON scenario_approvals',
    restore:
      'CREATE TRIGGER trg_scenario_approvals_bind_reviewed_version BEFORE INSERT ON scenario_approvals FOR EACH ROW EXECUTE FUNCTION scenario_approvals_bind_reviewed_version()',
    testFile: 'tests/desking-approval.test.ts',
    testName:
      'the database refuses a decision that names the wrong figures, with the service stepped round',
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
 * THE BODIES ARE READ OUT OF THE DECLARING MIGRATION (058, or 059 for the R7
 * §3 functions), NOT COPIED HERE. An anchored excerpt locates
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
  /** The migration file whose text declares that function; 058 when omitted. */
  migration?: string;
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
    /*
     * 059 §6 REPLACES this function (the floor moves to 4 exactly as 058 moved
     * it to 3), so the clause is read out of — and restored from — 059's text:
     * a restore from 058 would resurrect the superseded floor.
     */
    id: 'evidence_version_floor_never_moved',
    section: '059 §6 — R6-R6 §D1, R7 §4',
    intent:
      'the version exemptions are keyed on evidence_version, so they are only safe while ' +
      'nothing NEW can be written below version 4. Removed, a writer claims an older ' +
      'version and inherits its exemptions — a fresh way to record an authentication ' +
      'that never happened',
    functionName: 'policy_decisions_require_current_evidence',
    migration: MIGRATION_059,
    from: '  IF NEW.evidence_version < 4 THEN',
    to: '      NEW.evidence_version;\n  END IF;',
    testFile: 'tests/identity-evidence.test.ts',
    testName: 'a new decision cannot opt back into ANY weaker historic version',
  },
  // ── 058 §2 — the matched binding must be exact, in force and applicable ───
  {
    /*
     * FBL-020-R7 §3.5 moved the load: the PARENT trigger now resolves the
     * decision's scope through the ONE ancestry authority before any child row
     * is judged, so 058's child-side existence check — kept byte-for-byte in
     * its frozen migration — is no longer the predicate that answers, and
     * removing it kills nothing. What is removed instead is the authority's own
     * existence question: with it gone the parent waves the row through and
     * 058's child-side wording (a DIFFERENT message) is what the pinned test
     * meets — so the named test still dies, for the right reason.
     */
    id: 'decision_scope_node_need_not_exist',
    section: '059 §3 — R6-R6 §D4, R7 §3.5',
    intent:
      'the organization node a decision records must EXIST, in the decision’s own tenant. ' +
      'Removed from the one ancestry authority, an ALLOW may name a rooftop that is a ' +
      'rooftop nowhere, and the trail an operator follows after an incident ends at an ' +
      'identifier that resolves to nothing',
    functionName: 'org_chain_defect',
    migration: MIGRATION_059,
    from: '  IF chain_len < expected THEN',
    to: "                  p_level, COALESCE(p_id::text, '<none>'), p_tenant);\n  END IF;",
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
  /*
   * `binding_tenant_ignored` — 058's `IF rb.tenant_id IS DISTINCT FROM d.tenant_id`
   * clause — is RETIRED here, and the retirement is deliberate, not a coverage loss.
   *
   * That clause was reachable by exactly ONE lane: a system decision recorded in
   * tenant A naming a cross-tenant actor via `actor_user_link_id` and citing that
   * actor's binding (a user decision is pinned into its own tenant by the
   * actor-tenancy key, so its binding is same-tenant by construction). FBL-020-R7-C1
   * §6 closes the system evidence bypass by forbidding a system row from carrying
   * ANY human-actor / credential / support evidence
   * (`pd_system_row_carries_no_human_evidence`), which makes that one lane's very
   * row unconstructable — so dropping 058's clause now changes no observable
   * outcome, and a mutation over it would be an un-killable survivor.
   *
   * The PROTECTION it verified — a cross-tenant binding cannot be recorded as
   * authority — is unchanged and STILL mutation-covered: its coverage moves to
   * `system_row_carries_human_evidence` below, which the same reconstruction test
   * ('an ALLOW cannot claim a role binding that lives in another tenant', now
   * asserting the §6 CHECK) kills alongside the integrity suite. 058's clause stays
   * in the migration as defense in depth (migrations ≤059 are byte-immutable and
   * cannot be edited regardless). See docs/FBL-020-R7-C1-REQUIREMENT-MAP.json §6.
   */
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
  // ── 059 §2 — a session may not exceed or precede its approval (R7 §3.2) ───
  {
    id: 'request_authority_fields_rewritable',
    section: '059 §2 — R7 §3.2',
    intent: 'what an approved delegation is FOR may be rewritten after the approval',
    functionName: 'support_request_authority_is_immutable',
    migration: MIGRATION_059,
    from: '  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id',
    to: "file a new request instead',\n      OLD.request_id;\n  END IF;",
    testFile: 'tests/identity-evidence-integrity.test.ts',
    testName: 'request and session authority fields are immutable once written',
  },
  {
    id: 'approval_identity_repointable',
    section: '059 §2 — R7 §3.2',
    intent: 'the decider, the instant and the grant of an approval may be moved after the decision',
    functionName: 'support_request_authority_is_immutable',
    migration: MIGRATION_059,
    from: '  IF (OLD.decided_at IS NOT NULL AND NEW.decided_at IS DISTINCT FROM OLD.decided_at)',
    to: "documented path instead',\n      OLD.request_id;\n  END IF;",
    testFile: 'tests/identity-evidence-integrity.test.ts',
    testName: 'request and session authority fields are immutable once written',
  },
  {
    id: 'session_under_an_undecided_request',
    section: '059 §2 — R7 §3.2',
    intent: 'a session may be created under a request nobody approved',
    functionName: 'support_session_is_bounded_by_its_approval',
    migration: MIGRATION_059,
    from: "  IF r.status <> 'approved' OR r.decided_at IS NULL THEN",
    to: '      NEW.request_id, r.status;\n  END IF;',
    testFile: 'tests/identity-evidence-integrity.test.ts',
    testName: 'a session cannot exist under a request nobody approved',
  },
  {
    id: 'session_precedes_its_approval',
    section: '059 §2 — R7 §3.2',
    intent: 'a session may be granted before the decision that authorizes it',
    functionName: 'support_session_is_bounded_by_its_approval',
    migration: MIGRATION_059,
    from: '  IF NEW.granted_at < r.decided_at THEN',
    to: '      NEW.granted_at, r.decided_at;\n  END IF;',
    testFile: 'tests/identity-evidence-integrity.test.ts',
    testName: 'a session cannot begin before its approval was decided',
  },
  {
    id: 'session_outlives_the_approved_duration',
    section: '059 §2 — R7 §3.2',
    intent: 'an approval of N minutes may produce a session longer than N minutes',
    functionName: 'support_session_is_bounded_by_its_approval',
    migration: MIGRATION_059,
    from: '  IF NEW.expires_at > NEW.granted_at + make_interval(mins => r.requested_duration_minutes) THEN',
    to: '      NEW.expires_at, r.requested_duration_minutes, NEW.granted_at;\n  END IF;',
    testFile: 'tests/identity-evidence-integrity.test.ts',
    testName: 'a one-minute approval cannot produce a longer session',
  },
  {
    id: 'approval_grant_action_unchecked',
    section: '059 §2 — R7 §3.2',
    intent: 'a grant minted for any action at all may approve a support request',
    functionName: 'support_approval_grant_is_the_approval',
    migration: MIGRATION_059,
    from: "  IF g.action <> 'identity.support.approve' THEN",
    to: '      NEW.approval_grant_id, g.action;\n  END IF;',
    testFile: 'tests/identity-evidence-integrity.test.ts',
    testName: 'a wrong-action or wrong-resource REAL grant cannot approve a support request',
  },
  {
    id: 'approval_grant_names_another_request',
    section: '059 §2 — R7 §3.2',
    intent: 'a grant approving one request may be recorded as the approval of another',
    functionName: 'support_approval_grant_is_the_approval',
    migration: MIGRATION_059,
    from: "  IF g.resource_type IS DISTINCT FROM 'support_access_request'",
    to: "      COALESCE(g.resource_id::text, '<none>'), NEW.request_id;\n  END IF;",
    testFile: 'tests/identity-evidence-integrity.test.ts',
    testName: 'a wrong-action or wrong-resource REAL grant cannot approve a support request',
  },
  {
    id: 'approval_grant_assurance_unchecked',
    section: '059 §2 — R7 §3.2',
    intent: 'a lower-assurance grant may approve a support request',
    functionName: 'support_approval_grant_is_the_approval',
    migration: MIGRATION_059,
    from: "  IF g.assurance_level <> 'fresh_and_mfa_policy' THEN",
    to: '      NEW.approval_grant_id, g.assurance_level;\n  END IF;',
    testFile: 'tests/identity-evidence-integrity.test.ts',
    testName: 'an approval cannot cite a grant at the wrong assurance or without MFA certification',
  },
  {
    id: 'approval_grant_mfa_certification_unchecked',
    section: '059 §2 — R7 §3.2',
    intent: 'a grant issued without MFA-policy certification may approve a support request',
    functionName: 'support_approval_grant_is_the_approval',
    migration: MIGRATION_059,
    from: '  IF g.mfa_policy_certified_at_issue IS DISTINCT FROM true THEN',
    to: '      NEW.approval_grant_id;\n  END IF;',
    testFile: 'tests/identity-evidence-integrity.test.ts',
    testName: 'an approval cannot cite a grant at the wrong assurance or without MFA certification',
  },
  {
    id: 'approved_scope_need_not_be_effective',
    section: '059 §2 — R7 §3.2',
    intent:
      'an approval may delegate a scope that is not an effective node of the request’s ' +
      'tenant — foreign, archived, or under an aged-out ancestor',
    functionName: 'support_approval_grant_is_the_approval',
    migration: MIGRATION_059,
    from: "  IF NEW.status = 'approved' AND NEW.scope_level <> 'tenant' THEN",
    to: '      END IF;\n    END;\n  END IF;',
    testFile: 'tests/identity-evidence-integrity.test.ts',
    testName: 'an approved scope must be a real, effective node of the request tenant',
  },
  // ── 059 §3 — the one ancestry authority (R7 §3.5) ─────────────────────────
  {
    id: 'chain_defects_invisible_to_the_authority',
    section: '059 §3 — R7 §3.5',
    intent:
      'the ONE ancestry authority stops seeing inactive and out-of-window nodes, so every ' +
      'caller — evidence validators and runtime alike — accepts a dead chain',
    functionName: 'org_chain_defect',
    migration: MIGRATION_059,
    from: '  SELECT a.level, a.node_id, a.status, a.effective_from, a.effective_to INTO bad',
    to: "COALESCE(bad.effective_to::text, 'open'), p_at);\n  END IF;",
    testFile: 'tests/identity-evidence-integrity.test.ts',
    testName: 'an approved scope must be a real, effective node of the request tenant',
  },
  // ── 059 §5 — the version-4 structural judge, clause by clause ─────────────
  {
    id: 'occurred_at_may_lead_the_write_instant',
    section: '059 §5 — R7 §3.6',
    intent: 'evidence may be dated in the future of the instant it was actually written',
    functionName: 'policy_decisions_v4_structural_validity',
    migration: MIGRATION_059,
    from: "  IF NEW.occurred_at > write_instant + INTERVAL '5 seconds' THEN",
    to: "cannot predate itself',\n      NEW.occurred_at, write_instant;\n  END IF;",
    testFile: 'tests/identity-evidence-integrity.test.ts',
    testName: 'occurred_at is checked for consistency and can never BE the authority clock',
  },
  {
    id: 'occurred_at_may_trail_by_hours',
    section: '059 §5 — R7 §3.6',
    intent: 'evidence may be backdated arbitrarily, standing in for authority long dead',
    functionName: 'policy_decisions_v4_structural_validity',
    migration: MIGRATION_059,
    from: "  IF NEW.occurred_at < write_instant - INTERVAL '1 hour' THEN",
    to: "must be live at insertion',\n      NEW.occurred_at, write_instant;\n  END IF;",
    testFile: 'tests/identity-evidence-integrity.test.ts',
    testName: 'occurred_at is checked for consistency and can never BE the authority clock',
  },
  {
    id: 'platform_support_label_unbound',
    section: '059 §5 — R7 §3.1',
    intent:
      'a dealership link may wear the platform-support label — the forgery every R6-era ' +
      'support adversary was built on',
    functionName: 'policy_decisions_v4_structural_validity',
    migration: MIGRATION_059,
    from: "      IF NEW.actor_type = 'platform_support' AND actor_scope <> 'platform' THEN",
    to:
      "as a platform-support actor — the label is bound to the real scope',\n" +
      '          NEW.actor_user_link_id, actor_scope;\n      END IF;',
    testFile: 'tests/identity-evidence-integrity.test.ts',
    testName: 'a dealership link cannot be recorded as a platform-support actor',
  },
  {
    id: 'user_label_unbound',
    section: '059 §5 — R7 §3.1',
    intent: 'a platform link may be recorded as an ordinary dealership user',
    functionName: 'policy_decisions_v4_structural_validity',
    migration: MIGRATION_059,
    from: "      IF NEW.actor_type = 'user' AND actor_scope <> 'dealership' THEN",
    to:
      "as a dealership user — the label is bound to the real scope',\n" +
      '          NEW.actor_user_link_id, actor_scope;\n      END IF;',
    testFile: 'tests/identity-evidence.test.ts',
    testName: 'support-access evidence is all three facts or none',
  },
  {
    id: 'nonexistent_resource_authorizes',
    section: '059 §5 — R7 §3.4',
    intent: 'a nonexistent or foreign resource may be recorded as what an allow authorized',
    functionName: 'policy_decisions_v4_structural_validity',
    migration: MIGRATION_059,
    from: '    IF resolved_leaf IS NULL THEN',
    to: '        NEW.resource_type, NEW.resource_id, NEW.tenant_id;\n    END IF;',
    testFile: 'tests/identity-evidence-integrity.test.ts',
    testName:
      'nonexistent and foreign-tenant resources are rejected, and a supplied snapshot is validated',
  },
  {
    id: 'caller_snapshot_trusted',
    section: '059 §5 — R7 §3.4',
    intent:
      'a caller-supplied resource-rooftop column is believed (silently corrected, here) ' +
      'rather than validated against the database’s own resolution',
    functionName: 'policy_decisions_v4_structural_validity',
    migration: MIGRATION_059,
    from: '    IF NEW.resource_rooftop_id IS NOT NULL AND NEW.resource_rooftop_id <> resolved_leaf THEN',
    to: '        NEW.resource_rooftop_id, resolved_leaf, NEW.resource_type, NEW.resource_id;\n    END IF;',
    testFile: 'tests/identity-evidence-integrity.test.ts',
    testName:
      'nonexistent and foreign-tenant resources are rejected, and a supplied snapshot is validated',
  },
  {
    id: 'resource_chain_effectiveness_unchecked',
    section: '059 §5 — R7 §3.4',
    intent: 'a resource allow may stand on a dead organization chain above its own resource',
    functionName: 'policy_decisions_v4_structural_validity',
    migration: MIGRATION_059,
    from: "    chain_defect := org_chain_defect(NEW.tenant_id, 'rooftop', resolved_leaf, write_instant);",
    to: '        NEW.resource_type, NEW.resource_id, chain_defect;\n    END IF;',
    testFile: 'tests/identity-evidence-integrity.test.ts',
    testName: 'a resource ALLOW cannot stand on a dead chain above its own resource',
  },
  {
    id: 'decision_scope_chain_unjudged',
    section: '059 §5 — R7 §3.5',
    intent:
      'an ALLOW recorded at an organization scope need not stand on an active, in-window ' +
      'chain — tenant included — at the actual write instant',
    functionName: 'policy_decisions_v4_structural_validity',
    migration: MIGRATION_059,
    from:
      "  IF NEW.decision = 'allow' AND NEW.tenant_id IS NOT NULL\n" +
      "     AND NEW.scope_level IN ('tenant', 'dealer_group', 'legal_entity', 'rooftop', 'department') THEN",
    to:
      "        NEW.scope_level, COALESCE(NEW.scope_id::text, '<tenant>'), chain_defect;\n" +
      '    END IF;\n  END IF;',
    testFile: 'tests/identity-evidence-integrity.test.ts',
    testName: 'an ALLOW cannot stand on an inactive or out-of-window chain — six ways',
  },
  // ── 059 §5 — the child-side write-instant and reach rules ─────────────────
  {
    id: 'binding_dead_at_the_write_instant',
    section: '059 §5 — R7 §3.6',
    intent:
      'a binding whose window closed while the transaction was open may still be recorded ' +
      'as the authority — the transaction-start clock says it is alive',
    functionName: 'policy_decision_binding_is_live_and_reaches_the_resource',
    migration: MIGRATION_059,
    from:
      '  IF rb.effective_from > write_instant\n' +
      '     OR (rb.effective_to IS NOT NULL AND rb.effective_to <= write_instant) THEN',
    to: '      NEW.role_binding_id, write_instant;\n  END IF;',
    testFile: 'tests/identity-evidence-integrity.test.ts',
    testName: 'a transaction started before a binding expired and completed after it is refused',
  },
  {
    id: 'binding_reaches_a_sibling_resource',
    section: '059 §5 — R7 §3.4',
    intent:
      'an organization-scope binding off the resource’s own ancestor chain may be recorded ' +
      'as the authority for that resource — rooftop A authorizing rooftop B’s repair order',
    functionName: 'policy_decision_binding_is_live_and_reaches_the_resource',
    migration: MIGRATION_059,
    from: '  IF d.resource_type IS NOT NULL AND d.resource_rooftop_id IS NOT NULL',
    to: '        d.resource_type, d.resource_id, d.resource_rooftop_id;\n    END IF;\n  END IF;',
    testFile: 'tests/identity-evidence-integrity.test.ts',
    testName: 'a rooftop-A binding cannot authorize a real rooftop-B resource',
  },
];

/** A migration body, canonical LF, so anchors match on Windows and on CI alike. */
const migrationBodies = new Map<string, string>();
function canonicalMigration(filename: string): string {
  const cached = migrationBodies.get(filename);
  if (cached !== undefined) return cached;
  const body = readFileSync(join(__dirname, '..', 'migrations', filename), 'utf8').replace(
    /\r\n/g,
    '\n',
  );
  migrationBodies.set(filename, body);
  return body;
}

/**
 * The `CREATE OR REPLACE FUNCTION <name>(…) … $$ LANGUAGE plpgsql…;` statement, verbatim.
 *
 * Located by its header and terminated at the first `$$ LANGUAGE plpgsql` after it plus
 * the statement's own semicolon — which admits both 058's trigger functions and 059's
 * parameterized STABLE authorities (`org_chain_defect` and friends), because every
 * function in both migrations is dollar-quoted with `$$` and closes the same way. A name
 * that does not resolve, or resolves twice, throws: a predicate mutation that silently
 * found nothing would report itself killed.
 */
export function functionStatement(sql: string, name: string): string {
  const header = `CREATE OR REPLACE FUNCTION ${name}(`;
  const first = sql.indexOf(header);
  if (first < 0) throw new Error(`the migration declares no function ${name}`);
  if (sql.indexOf(header, first + 1) >= 0) {
    throw new Error(`the migration declares ${name} more than once`);
  }
  const terminator = '$$ LANGUAGE plpgsql';
  const end = sql.indexOf(terminator, first + header.length);
  if (end < 0) throw new Error(`function ${name} is not terminated`);
  const semicolon = sql.indexOf(';', end + terminator.length);
  if (semicolon < 0) throw new Error(`function ${name} is not terminated`);
  return sql.slice(first, semicolon + 1);
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

  // THE TEMPLATE MUST CARRY 058 AND 059, checked rather than assumed: on a database
  // without them every DROP fails and every control reports a false result.
  {
    const probe = new Client({ connectionString: databaseUrl });
    await probe.connect();
    try {
      const applied = (
        await probe.query<{ filename: string }>(
          `SELECT filename FROM schema_migrations
            WHERE filename LIKE '058%' OR filename LIKE '059%'`,
        )
      ).rows;
      if (applied.length < 2) {
        console.error(
          `The template database '${template}' has not applied migrations 058 and 059, ` +
            'so the controls this runner drops are not there to drop. Migrate it first.',
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
          // The R7 §3.7 controls mutate CLUSTER-VISIBLE state (role privileges
          // and membership), which dropping the copy database cannot undo — so
          // once the drop has run, the restore ALWAYS runs, kill run or no.
          try {
            const killed = runNamedTest(control.testFile, control.testName, copied);
            if (!killed.ranTheNamedTest) {
              problems.push('the declared test did not run in the mutated database');
            } else if (killed.passed) {
              problems.push('SURVIVED: the declared test still passes with the control dropped');
            }
          } finally {
            const restorer = new Client({ connectionString: copied });
            await restorer.connect();
            try {
              await restorer.query(control.restore);
            } catch (err) {
              // A restore that refuses (for example, an ADD CONSTRAINT meeting
              // rows the killed run committed) breaks attributability for THIS
              // control; it must be reported as this control's failure, not
              // crash the runner and discard every other result.
              problems.push(`the restore statement failed: ${String((err as Error).message)}`);
            } finally {
              await restorer.end();
            }
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

    // ── one clause at a time, inside the migration-declared functions ──────
    for (const [index, predicate] of PREDICATES.entries()) {
      if (only !== undefined && predicate.id !== only) continue;
      const original = functionStatement(
        canonicalMigration(predicate.migration ?? MIGRATION_058),
        predicate.functionName,
      );
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
    order: 'FBL-020-R6 §4.1 + FBL-020-R7 §5',
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
