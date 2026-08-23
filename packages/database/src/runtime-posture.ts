import { query } from './pool';

/**
 * FBL-020-R7-C1 §2 — THE RUNTIME CONNECTION PROVES IT IS NOT PRIVILEGED, AT BOOT.
 *
 * Migration 060 gives the application a real, non-owner LOGIN role
 * (`dealership_app`, a member of `dealership_runtime` and nothing else). This
 * function is the FAIL-CLOSED check the API and worker run before serving: it
 * opens a connection through the very pool the application will use and refuses
 * to continue unless that connection is genuinely restricted. It does not trust
 * configuration to have wired the right credential — it asks the database who it
 * actually is.
 *
 * The five properties, exactly as the order names them, are observable from a
 * single connection because Postgres answers them about `current_user`:
 *
 *   1. NOT A SUPERUSER — a superuser bypasses every check below;
 *   2. CANNOT ASSUME THE EVIDENCE OWNER OR MIGRATION OWNER — `pg_has_role(…,
 *      'MEMBER')` is false, so no `SET ROLE` reaches migration-owner authority,
 *      and `RESET ROLE` returns the session to this same non-owner login;
 *   3. CANNOT WRITE THE MIGRATION LEDGER — `has_table_privilege` INSERT on
 *      `schema_migrations` is false (060 revoked it from the runtime role);
 *   4. CANNOT DIRECTLY INSERT NORMALIZED CHILD EVIDENCE — INSERT on
 *      `policy_decision_matched_bindings` is false (059 revoked it); a forged
 *      GUC changes nothing because the privilege, not a marker, is the gate;
 *   5. CAN INSERT AN AUTHORIZED PARENT DECISION — INSERT on `policy_decisions`
 *      is true, so the database-owned SECURITY DEFINER normalizer still runs.
 *
 * DDL and trigger control need table ownership, which a non-owner, non-superuser
 * simply does not have, so "cannot disable triggers or perform unauthorized DDL"
 * is covered by properties 1 and 2 together rather than probed destructively.
 *
 * The migration runner and the test harness do OWNER work (creating roles,
 * truncating between cases) and never call this — they are supposed to be the
 * owner. Only the API and worker, which serve requests, assert the posture.
 */
export interface RuntimePosture {
  readonly currentUser: string;
  readonly isSuperuser: boolean;
  readonly canAssumeEvidenceOwner: boolean;
  readonly canWriteLedger: boolean;
  readonly canInsertChildEvidence: boolean;
  readonly canInsertParentDecision: boolean;
}

export class RuntimePostureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimePostureError';
  }
}

/** Reads the posture of the actual pooled connection. Pure observation. */
export async function readRuntimePosture(): Promise<RuntimePosture> {
  const r = (
    await query(
      `SELECT
         current_user AS current_user,
         (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_superuser,
         pg_has_role(current_user, 'dealership_evidence_owner', 'MEMBER') AS can_assume_evidence_owner,
         has_table_privilege(current_user, 'schema_migrations', 'INSERT') AS can_write_ledger,
         has_table_privilege(current_user, 'policy_decision_matched_bindings', 'INSERT') AS can_insert_child,
         has_table_privilege(current_user, 'policy_decisions', 'INSERT') AS can_insert_parent`,
    )
  ).rows[0] as Record<string, unknown>;
  return {
    currentUser: String(r.current_user),
    isSuperuser: r.is_superuser === true,
    canAssumeEvidenceOwner: r.can_assume_evidence_owner === true,
    canWriteLedger: r.can_write_ledger === true,
    canInsertChildEvidence: r.can_insert_child === true,
    canInsertParentDecision: r.can_insert_parent === true,
  };
}

/** The posture violations, in the order's own words. Empty means compliant. */
export function runtimePostureViolations(p: RuntimePosture): string[] {
  const problems: string[] = [];
  if (p.isSuperuser) {
    problems.push(
      `connected as ${p.currentUser}, which is a SUPERUSER — a superuser bypasses every ` +
        'authorization boundary the schema installs',
    );
  }
  if (p.canAssumeEvidenceOwner) {
    problems.push(
      `${p.currentUser} can assume the evidence/migration owner (pg_has_role MEMBER) — it ` +
        'could SET ROLE to migration-owner authority, and RESET ROLE would still land on a ' +
        'privileged login',
    );
  }
  if (p.canWriteLedger) {
    problems.push(
      `${p.currentUser} can write schema_migrations — a runtime connection must not be able ` +
        'to rewrite the record of what schema is in force',
    );
  }
  if (p.canInsertChildEvidence) {
    problems.push(
      `${p.currentUser} can directly INSERT policy_decision_matched_bindings — normalized ` +
        'evidence must be written only by the database-owned SECURITY DEFINER path',
    );
  }
  if (!p.canInsertParentDecision) {
    problems.push(
      `${p.currentUser} cannot INSERT policy_decisions — the application cannot record its ` +
        'own authorization decisions, so it is not the runtime role either',
    );
  }
  return problems;
}

/**
 * FAIL CLOSED. Reads the posture and throws `RuntimePostureError` if the
 * connection is privileged or under-privileged. The API and worker call this at
 * boot, before serving or running a job, so a deployment mis-wired to the owner
 * or superuser credential — or to a role that cannot even record decisions —
 * refuses to start rather than run with the wrong authority.
 */
export async function assertRuntimePosture(): Promise<RuntimePosture> {
  const posture = await readRuntimePosture();
  const problems = runtimePostureViolations(posture);
  if (problems.length > 0) {
    throw new RuntimePostureError(
      'runtime database posture is not the least-privilege runtime role:\n  ' +
        problems.join('\n  ') +
        '\nConfigure the application with the non-owner runtime login (migration 060 ' +
        'creates dealership_app); the migration runner keeps the owner credential.',
    );
  }
  return posture;
}
