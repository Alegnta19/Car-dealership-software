import { query } from './pool';

/**
 * FBL-020-R7-C1 §2 + FBL-020-R7-C2 §1 — THE RUNTIME CONNECTION PROVES IT IS NOT
 * PRIVILEGED, AT BOOT, ABOUT BOTH OF ITS IDENTITIES.
 *
 * Migration 060 gives the application a real, non-owner LOGIN role
 * (`dealership_app`, a member of `dealership_runtime` and nothing else). This
 * function is the FAIL-CLOSED check the API and worker run before serving: it
 * opens a connection through the very pool the application will use and refuses
 * to continue unless that connection is genuinely restricted. It does not trust
 * configuration to have wired the right credential — it asks the database who it
 * actually is.
 *
 * C2 §1 hardened WHAT IS ASKED, in the order's own words:
 *
 *   1. `session_user` AND `current_user` are both read and both judged, and
 *      they must be the SAME identity. `current_user` alone is what a
 *      `-c role=` startup switch (now removed from the pool, and its variable
 *      refused by the configuration) used to satisfy while `session_user`
 *      remained the owner — the concealment this check exists to expose. Every
 *      privilege question below is asked about BOTH.
 *   2. NOT A SUPERUSER — a superuser bypasses every check below.
 *   3. CANNOT ASSUME ANY ACTUAL OWNER — OR ANY SUPERUSER. The owners are
 *      ENUMERATED FROM THE DATABASE — the database's own owner, the `public`
 *      schema's owner, and every distinct owner of every table in it (the
 *      migration ledger and the evidence tables included), plus the
 *      evidence-owner role by name, PLUS every superuser role in the cluster —
 *      and `pg_has_role(…, 'MEMBER')` must be false for each. Membership is
 *      what `SET ROLE` requires, and `pg_has_role(x, x, 'MEMBER')` is true, so
 *      "cannot assume" covers "is not" as well. The superuser arm exists
 *      because SUPERUSER is an attribute, not an inheritable privilege: a
 *      login granted membership in a nothing-owning superuser role would show
 *      no owned table, no ACL privilege and rolsuper=false on both of its own
 *      identities, while one SET ROLE away from total bypass — so superuser
 *      roles are treated as owners of everything, which is what they are.
 *      DDL and trigger control need ownership (or a TRIGGER grant nothing
 *      here holds), so "cannot disable triggers or perform unauthorized DDL"
 *      follows from this and superuser being false.
 *   4. CANNOT WRITE THE MIGRATION LEDGER — INSERT, UPDATE, DELETE and TRUNCATE
 *      on `schema_migrations` are each individually false.
 *   5. CANNOT DIRECTLY INSERT NORMALIZED CHILD EVIDENCE — INSERT on
 *      `policy_decision_matched_bindings` is false (059 revoked it); a forged
 *      GUC changes nothing because the privilege, not a marker, is the gate.
 *   6. CAN INSERT AN AUTHORIZED PARENT DECISION — INSERT on `policy_decisions`
 *      is true, so the database-owned SECURITY DEFINER normalizer still runs.
 *
 * The migration runner and the test harness do OWNER work (creating roles,
 * truncating between cases) and never call this — they are supposed to be the
 * owner. Only the API and worker, which serve requests, assert the posture.
 */
export interface RuntimePosture {
  /** The authenticated login — what the credential actually is. */
  readonly sessionUser: string;
  /** The effective identity — equals sessionUser on an unswitched connection. */
  readonly currentUser: string;
  readonly isSuperuser: boolean;
  /**
   * The ACTUAL owners this connection can assume (empty when compliant):
   * every enumerated owner — database, schema, tables, evidence owner — for
   * which pg_has_role(session_user or current_user, owner, 'MEMBER') is true.
   */
  readonly assumableOwners: readonly string[];
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
      `WITH actual_owners AS (
         SELECT pg_get_userbyid(d.datdba)::text AS owner
           FROM pg_database d WHERE d.datname = current_database()
         UNION
         SELECT pg_get_userbyid(n.nspowner)::text
           FROM pg_namespace n WHERE n.nspname = 'public'
         UNION
         SELECT DISTINCT c.relowner::regrole::text
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
         UNION
         SELECT 'dealership_evidence_owner'
          WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dealership_evidence_owner')
         UNION
         SELECT r.rolname::text FROM pg_roles r WHERE r.rolsuper
       )
       SELECT
         session_user AS session_user,
         current_user AS current_user,
         (SELECT rolsuper FROM pg_roles WHERE rolname = session_user)
           OR (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_superuser,
         COALESCE(
           (SELECT array_agg(DISTINCT o.owner ORDER BY o.owner)
              FROM actual_owners o
             WHERE pg_has_role(session_user, o.owner, 'MEMBER')
                OR pg_has_role(current_user, o.owner, 'MEMBER')),
           ARRAY[]::text[]) AS assumable_owners,
         has_table_privilege(session_user, 'schema_migrations', 'INSERT')
           OR has_table_privilege(session_user, 'schema_migrations', 'UPDATE')
           OR has_table_privilege(session_user, 'schema_migrations', 'DELETE')
           OR has_table_privilege(session_user, 'schema_migrations', 'TRUNCATE')
           OR has_table_privilege(current_user, 'schema_migrations', 'INSERT')
           OR has_table_privilege(current_user, 'schema_migrations', 'UPDATE')
           OR has_table_privilege(current_user, 'schema_migrations', 'DELETE')
           OR has_table_privilege(current_user, 'schema_migrations', 'TRUNCATE') AS can_write_ledger,
         has_table_privilege(session_user, 'policy_decision_matched_bindings', 'INSERT')
           OR has_table_privilege(current_user, 'policy_decision_matched_bindings', 'INSERT')
           AS can_insert_child,
         has_table_privilege(current_user, 'policy_decisions', 'INSERT') AS can_insert_parent`,
    )
  ).rows[0] as Record<string, unknown>;
  return {
    sessionUser: String(r.session_user),
    currentUser: String(r.current_user),
    isSuperuser: r.is_superuser === true,
    assumableOwners: Array.isArray(r.assumable_owners) ? r.assumable_owners.map(String) : [],
    canWriteLedger: r.can_write_ledger === true,
    canInsertChildEvidence: r.can_insert_child === true,
    canInsertParentDecision: r.can_insert_parent === true,
  };
}

/** The posture violations, in the order's own words. Empty means compliant. */
export function runtimePostureViolations(p: RuntimePosture): string[] {
  const problems: string[] = [];
  if (p.sessionUser !== p.currentUser) {
    problems.push(
      `authenticated as ${p.sessionUser} but effectively ${p.currentUser} — a switched role ` +
        'conceals the real login, and the posture is judged about the connection identity, ' +
        'not about a costume it can RESET ROLE out of',
    );
  }
  if (p.isSuperuser) {
    problems.push(
      `connected as ${p.sessionUser} (effectively ${p.currentUser}), which is a SUPERUSER — ` +
        'a superuser bypasses every authorization boundary the schema installs',
    );
  }
  if (p.assumableOwners.length > 0) {
    problems.push(
      `${p.sessionUser} can assume actual owner role(s) ${p.assumableOwners.join(', ')} ` +
        '(pg_has_role MEMBER over the enumerated database, schema, table and evidence ' +
        'owners) — it could SET ROLE to owner authority, and owner authority is DDL, ' +
        'trigger control and the migration ledger',
    );
  }
  if (p.canWriteLedger) {
    problems.push(
      `${p.sessionUser} can INSERT, UPDATE, DELETE or TRUNCATE schema_migrations — a ` +
        'runtime connection must not be able to rewrite the record of what schema is in force',
    );
  }
  if (p.canInsertChildEvidence) {
    problems.push(
      `${p.sessionUser} can directly INSERT policy_decision_matched_bindings — normalized ` +
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
