/**
 * Proves the upgraded database is in the intended state.
 *
 *   DATABASE_URL=... npx tsx scripts/verify-upgrade-state.ts --phase=<phase> [options]
 *
 *     --phase=backfill   at migration 056, BEFORE the identity fixture is seeded
 *     --phase=pre-057    after the identity fixture is seeded, BEFORE 057
 *     --phase=post-057   after 057 has been applied on top of that fixture
 *     --out <file>       write this phase's machine-readable census as JSON
 *     --before <file>    (post-057 only) the pre-057 census to compare against
 *
 * ── FBL-020-R4 §6: WHY THIS FILE WAS REWRITTEN ──────────────────────────────
 *
 * The previous version had exactly one mode, and it REQUIRED all nine identity
 * tables to be EMPTY. Paired with a CI job that seeded Fixed Ops rows only, that
 * made the upgrade drill structurally incapable of exercising migration 057 —
 * a file whose entire subject is reconciling RETAINED IDENTITY ROWS before it
 * constrains them. Every "reconciliation precedes the constraint" claim in 057
 * was therefore unproven by the gate that existed to prove it, and the R3 report's
 * claim of a populated upgrade rested on a local, prose-only exercise.
 *
 * The empty-table assertion was not wrong, it was mis-timed: "migration 055
 * invented no identities and no evidence" is a true and valuable property, and it
 * is true precisely at 056, before anything is seeded. So it is KEPT, in the
 * `backfill` phase, where it means what it says — and the populated drill runs
 * after it in the two phases that follow.
 *
 * WHAT EACH PHASE IS FOR:
 *   backfill  — the retained Fixed Ops seed survived; 050's two CHECKs are still
 *               NOT VALID; 055's tenant/rooftop/ancestry backfill is complete; and
 *               nothing in the identity tables was invented on the way here.
 *   pre-057   — the legacy identity fixture is actually PRESENT, at exact counts.
 *               An empty or partial seed can no longer be mistaken for a pass:
 *               this phase fails if any census table is empty.
 *   post-057  — every reconciliation in 057 left its rows in the ONE state it is
 *               designed to leave them in, no row was deleted, the Fixed Ops and
 *               055 properties still hold, and the policy-evidence version floor
 *               refuses a new incomplete decision.
 *
 * The post-057 expectations are EXACT, not existential. That is deliberate: a
 * count-only assertion passes when a reconciliation acts on the wrong rows, and
 * the two revocation branches in 057 §2 are distinguishable ONLY by the reason
 * they record. `scripts/upgrade-negative-controls.ts` removes each load-bearing
 * reconciliation on an isolated copy and requires this phase (or Postgres) to
 * refuse the result.
 */
import { writeFileSync } from 'fs';
import { closePool, query, withTransaction } from '@dealer/database';

type Phase = 'backfill' | 'pre-057' | 'post-057';

const PHASES: readonly Phase[] = ['backfill', 'pre-057', 'post-057'];

/** The nine identity tables whose population is the subject of the §6 drill. */
const CENSUS_TABLES = [
  'identity_provider_connections',
  'user_links',
  'identity_sessions',
  'role_bindings',
  'policy_decisions',
  'reauthentication_transactions',
  'reauthentication_grants',
  'support_access_requests',
  'support_access_sessions',
] as const;

/**
 * The row counts `tests/fixtures/legacy-identity-seed-pre-057.sql` produces. Stated
 * here so a fixture that silently stops inserting — a renamed column, a swallowed
 * error, a truncated file — fails the gate instead of quietly shrinking it.
 */
const EXPECTED_FIXTURE_COUNTS: Record<(typeof CENSUS_TABLES)[number], number> = {
  identity_provider_connections: 3,
  user_links: 4,
  identity_sessions: 3,
  role_bindings: 4,
  policy_decisions: 2,
  reauthentication_transactions: 3,
  reauthentication_grants: 1,
  support_access_requests: 2,
  support_access_sessions: 1,
};

/** Legacy identity shapes the fixture must contain BEFORE 057 runs. */
const EXPECTED_FIXTURE_SHAPES: Array<[string, string, number]> = [
  [
    'activated user links',
    `SELECT COUNT(*)::int AS n FROM user_links WHERE status = 'activated'`,
    3,
  ],
  [
    // The AMBIGUOUS set, expressed in columns that exist before 057: an activated
    // link whose tenant has no active connection has nothing it can honestly be
    // bound to, and 057 §1 must close it rather than guess.
    'activated user links whose tenant has no active connection (ambiguous)',
    `SELECT COUNT(*)::int AS n FROM user_links ul
      WHERE ul.status = 'activated'
        AND NOT EXISTS (
          SELECT 1 FROM identity_provider_connections c
           WHERE c.tenant_id IS NOT DISTINCT FROM ul.tenant_id
             AND c.provider = ul.provider AND c.status = 'active'
        )`,
    1,
  ],
  [
    'live identity sessions',
    `SELECT COUNT(*)::int AS n FROM identity_sessions WHERE revoked_at IS NULL`,
    3,
  ],
  [
    'sessions with no provable provenance',
    `SELECT COUNT(*)::int AS n FROM identity_sessions
      WHERE revoked_at IS NULL AND (connection_id IS NULL OR issuer IS NULL)`,
    1,
  ],
  [
    'reauthentication transactions still started',
    `SELECT COUNT(*)::int AS n FROM reauthentication_transactions WHERE state = 'started'`,
    1,
  ],
  [
    'terminal reauthentication transactions',
    `SELECT COUNT(*)::int AS n FROM reauthentication_transactions
      WHERE state IN ('completed', 'failed', 'expired')`,
    2,
  ],
  [
    'effective role bindings',
    // role-binding-effectiveness-opt-out(all-bindings-including-ineffective): this
    // measures the FIXTURE, not authority. It has to see both classes of binding and
    // report how many are in each, because the property under test is that migration
    // 057 leaves an ineffective binding ineffective — a query that resolved the shared
    // predicate would count only the effective ones and could not tell the difference
    // between an ineffective binding surviving and one being quietly promoted, which is
    // precisely the fabrication this assertion exists to catch. It authorizes nothing.
    `SELECT COUNT(*)::int AS n FROM role_bindings
      WHERE status = 'active' AND effective_from <= NOW()
        AND (effective_to IS NULL OR effective_to > NOW())`,
    1,
  ],
  [
    'ineffective role bindings (future-dated, aged out or revoked)',
    // role-binding-effectiveness-opt-out(all-bindings-including-ineffective): the exact
    // complement of the query above, and the same reasoning applies — counting the
    // bindings the engine would REFUSE to match is the whole point of the assertion, so
    // the shared predicate is the one thing that cannot express it. It authorizes nothing
    // and grants nothing; it counts rows in a disposable drill database.
    `SELECT COUNT(*)::int AS n FROM role_bindings
      WHERE status = 'revoked' OR effective_from > NOW()
         OR (effective_to IS NOT NULL AND effective_to <= NOW())`,
    3,
  ],
  [
    'incomplete historical policy decisions (an allow naming no request or session)',
    `SELECT COUNT(*)::int AS n FROM policy_decisions
      WHERE decision = 'allow' AND request_id IS NULL AND correlation_id IS NULL
        AND scope_level IS NULL AND cardinality(matched_role_binding_ids) = 0`,
    1,
  ],
  [
    'pending support access requests',
    `SELECT COUNT(*)::int AS n FROM support_access_requests WHERE status = 'pending'`,
    1,
  ],
  [
    'approved support access requests with no approving grant',
    `SELECT COUNT(*)::int AS n FROM support_access_requests WHERE status = 'approved'`,
    1,
  ],
  [
    'MFA-policy certifications with no validity deadline',
    `SELECT COUNT(*)::int AS n FROM identity_provider_connections WHERE mfa_policy_certified = TRUE`,
    1,
  ],
];

/**
 * THE POST-057 RECONCILED STATE, ROW BY ROW.
 *
 * Each entry names the reconciliation under test, the single fixture row it acts
 * on, and the EXACT state that row must be in afterwards. The values come from
 * observing 057 run on this fixture; they are asserted rather than described so a
 * future edit that changes an outcome has to change this file too.
 */
const RECONCILED_STATE: Array<{ id: string; sql: string; expect: Record<string, unknown> }> = [
  {
    // 057 §1 — tenant A has exactly one active connection, so the link BINDS.
    id: 'ul_a1_bound_to_its_only_active_connection',
    sql: `SELECT status, connection_id::text AS connection_id, provider_organization_id, issuer,
                 authorization_version::int AS authorization_version
            FROM user_links WHERE user_link_id = '10000001-0000-4000-8000-000000000001'`,
    expect: {
      status: 'activated',
      connection_id: 'c0000001-0000-4000-8000-000000000001',
      provider_organization_id: 'org_legacy_a',
      issuer: 'https://legacy-a.authkit.test',
      authorization_version: 1,
    },
  },
  {
    // 057 §1 — a PENDING link is bound by the same deterministic derivation but
    // stays pending: binding is a statement about provenance, not about access.
    id: 'ul_a2_pending_link_stays_pending',
    sql: `SELECT status, connection_id::text AS connection_id,
                 authorization_version::int AS authorization_version
            FROM user_links WHERE user_link_id = '10000002-0000-4000-8000-000000000002'`,
    expect: {
      status: 'pending',
      connection_id: 'c0000001-0000-4000-8000-000000000001',
      authorization_version: 1,
    },
  },
  {
    // 057 §1 — tenant B has NO active connection, so the link is AMBIGUOUS and is
    // closed with its binding cleared. The version advances because what this link
    // authorizes has changed, which is what a version exists to announce.
    id: 'ul_b1_ambiguous_link_deactivated_and_unbound',
    sql: `SELECT status, connection_id::text AS connection_id, provider_organization_id, issuer,
                 (deactivated_at IS NOT NULL) AS deactivated,
                 authorization_version::int AS authorization_version
            FROM user_links WHERE user_link_id = '10000003-0000-4000-8000-000000000003'`,
    expect: {
      status: 'deactivated',
      connection_id: null,
      provider_organization_id: null,
      issuer: null,
      deactivated: true,
      authorization_version: 2,
    },
  },
  {
    // 057 §2 — provable provenance: subject and organization are DERIVED from the
    // link and its own connection, and the session stays LIVE. This is the row
    // that dies if the derivation is removed: it would be revoked instead.
    id: 'is_s1_provable_session_survives_with_derived_identity',
    sql: `SELECT (revoked_at IS NULL) AS live, revoked_reason, provider_subject,
                 provider_organization_id, credential_kind
            FROM identity_sessions WHERE session_id = '50000001-0000-4000-8000-000000000001'`,
    expect: {
      live: true,
      revoked_reason: null,
      provider_subject: 'user_legacy_a1',
      provider_organization_id: 'org_legacy_a',
      credential_kind: 'cookie',
    },
  },
  {
    // 057 §2 — the nullable-connection bypass, closed. The REASON is the evidence
    // of which branch acted, so it is asserted exactly.
    id: 'is_s2_unprovable_provenance_revoked',
    sql: `SELECT (revoked_at IS NULL) AS live, revoked_reason, provider_subject
            FROM identity_sessions WHERE session_id = '50000002-0000-4000-8000-000000000002'`,
    expect: {
      live: false,
      revoked_reason: 'fbl_020_r2_unprovable_binding',
      provider_subject: null,
    },
  },
  {
    // 057 §2 — names a connection, so the first revocation does not reach it; its
    // link is the one §1 just deactivated, so nothing can be derived. A DIFFERENT
    // reason, from a DIFFERENT statement.
    id: 'is_s3_unprovable_identity_revoked',
    sql: `SELECT (revoked_at IS NULL) AS live, revoked_reason, provider_subject,
                 provider_organization_id
            FROM identity_sessions WHERE session_id = '50000003-0000-4000-8000-000000000003'`,
    expect: {
      live: false,
      revoked_reason: 'fbl_020_r3_unprovable_subject_or_org',
      provider_subject: null,
      provider_organization_id: null,
    },
  },
  {
    // 057 §4 then §9 — a transaction that cannot satisfy the new binding rules is
    // expired, and §9 then explains every terminal row.
    id: 'rat_t1_started_transaction_expired_and_explained',
    sql: `SELECT state, terminal_reason, (terminal_at IS NOT NULL) AS terminal_dated,
                 connection_id::text AS connection_id
            FROM reauthentication_transactions
           WHERE reauth_txn_id = '70000001-0000-4000-8000-000000000001'`,
    expect: {
      state: 'expired',
      terminal_reason: 'expired',
      terminal_dated: true,
      connection_id: null,
    },
  },
  {
    // 057 §9 — a completed transaction's terminal instant is DERIVED from its own
    // completed_at. An invented instant would be the failure mode here.
    id: 'rat_t2_completed_transaction_explained_from_its_own_instant',
    sql: `SELECT state, terminal_reason, (terminal_at = completed_at) AS terminal_is_completed_at
            FROM reauthentication_transactions
           WHERE reauth_txn_id = '70000002-0000-4000-8000-000000000002'`,
    expect: { state: 'completed', terminal_reason: 'granted', terminal_is_completed_at: true },
  },
  {
    // 057 §9 — a failure with no recorded cause is classified as unclassified
    // rather than assigned a plausible one.
    id: 'rat_t3_failed_transaction_classified_honestly',
    sql: `SELECT state, terminal_reason, (terminal_at IS NOT NULL) AS terminal_dated
            FROM reauthentication_transactions
           WHERE reauth_txn_id = '70000003-0000-4000-8000-000000000003'`,
    expect: {
      state: 'failed',
      terminal_reason: 'fbl_020_r4_unclassified',
      terminal_dated: true,
    },
  },
  {
    // 057 §7c — a grant's connection is its transaction's connection. The legacy
    // transaction has none, so the grant honestly has none.
    id: 'rag_grant_connection_derived_from_its_transaction',
    sql: `SELECT connection_id::text AS connection_id, assurance_level
            FROM reauthentication_grants WHERE grant_id = '80000001-0000-4000-8000-000000000001'`,
    expect: { connection_id: null, assurance_level: 'fresh_and_mfa_policy' },
  },
  {
    // 057 §5 — the prior decision is PRESERVED, authority is not. The row moves to
    // a terminal state, its decision moves to the superseded_* columns, and its
    // authorization_version advances.
    id: 'sar_r2_approval_without_a_grant_superseded',
    sql: `SELECT status, superseded_reason,
                 superseded_decided_by_user_link_id::text AS superseded_decided_by,
                 (superseded_decided_at IS NOT NULL) AS superseded_dated,
                 (decided_at IS NULL) AS live_decision_cleared,
                 (decided_by_user_link_id IS NULL) AS live_decider_cleared,
                 approval_grant_id::text AS approval_grant_id,
                 authorization_version::int AS authorization_version
            FROM support_access_requests
           WHERE request_id = 'b0000002-0000-4000-8000-000000000002'`,
    expect: {
      status: 'expired',
      superseded_reason: 'fbl_020_r3_no_approving_grant',
      superseded_decided_by: '10000001-0000-4000-8000-000000000001',
      superseded_dated: true,
      live_decision_cleared: true,
      live_decider_cleared: true,
      approval_grant_id: null,
      authorization_version: 2,
    },
  },
  {
    // 057 §5 — delegated access into a tenant does not outlive the approval that
    // justified it. No person performed this, so no person is named.
    id: 'sas_session_of_superseded_approval_ended',
    sql: `SELECT (revoked_at IS NOT NULL) AS revoked,
                 (revoked_by_user_link_id IS NULL) AS no_human_revoker,
                 (expired_at IS NULL) AS expiry_not_backdated
            FROM support_access_sessions
           WHERE support_session_id = 'e0000001-0000-4000-8000-000000000001'`,
    expect: { revoked: true, no_human_revoker: true, expiry_not_backdated: true },
  },
  {
    // 057 §5 — an UNDECIDED request has nothing to reconcile. Manufacturing an
    // approval here would be the worst available failure on this table.
    id: 'sar_r1_pending_request_untouched',
    sql: `SELECT status, superseded_reason, approval_grant_id::text AS approval_grant_id,
                 authorization_version::int AS authorization_version
            FROM support_access_requests
           WHERE request_id = 'b0000001-0000-4000-8000-000000000001'`,
    expect: {
      status: 'pending',
      superseded_reason: null,
      approval_grant_id: null,
      authorization_version: 1,
    },
  },
  {
    // 057 §8 — a certification that cannot say when it stops counting is WITHDRAWN,
    // not given an invented deadline. The version advances.
    id: 'ipc_unbounded_mfa_certification_withdrawn',
    sql: `SELECT mfa_policy_certified,
                 (mfa_policy_certified_at IS NULL) AS certified_at_cleared,
                 (mfa_policy_certification_expires_at IS NULL) AS no_invented_deadline,
                 (mfa_policy_certification_revoked_at IS NULL) AS not_falsely_attributed,
                 authorization_version::int AS authorization_version
            FROM identity_provider_connections
           WHERE connection_id = 'c0000001-0000-4000-8000-000000000001'`,
    expect: {
      mfa_policy_certified: false,
      certified_at_cleared: true,
      no_invented_deadline: true,
      not_falsely_attributed: true,
      authorization_version: 2,
    },
  },
  {
    // 057 §6 — history stays exactly as it was written, at the version whose
    // requirements it actually met, and stays READABLE.
    id: 'pd_incomplete_history_preserved_at_version_1',
    sql: `SELECT evidence_version::int AS evidence_version, decision, reason_code,
                 (session_id IS NULL) AS no_invented_session,
                 (auth_time IS NULL) AS no_invented_auth_time
            FROM policy_decisions WHERE decision_id = 'd0000001-0000-4000-8000-000000000001'`,
    expect: {
      evidence_version: 1,
      decision: 'allow',
      reason_code: 'ROLE_BINDING_MATCH',
      no_invented_session: true,
      no_invented_auth_time: true,
    },
  },
  {
    // 057 touches role_bindings NOWHERE. All four windows come through unchanged,
    // at version 1: an ineffective binding quietly becoming effective, or a version
    // advancing, would be inventing standing authority.
    id: 'rb_all_four_windows_survive_unchanged',
    // role-binding-effectiveness-opt-out(all-bindings-including-ineffective): this reads
    // EVERY binding and classifies each one, which is the only way to state the property.
    // Resolving the shared predicate would return the effective bindings alone, so a
    // migration that had PROMOTED a future-dated or revoked binding into an effective one
    // would satisfy the query and the fabrication would pass unseen. It decides nothing
    // about what any row authorizes; it counts rows and compares against the fixture.
    sql: `SELECT COUNT(*)::int AS total,
                 SUM(CASE WHEN authorization_version = 1 THEN 1 ELSE 0 END)::int AS at_version_1,
                 SUM(CASE WHEN status = 'active' AND effective_from <= NOW()
                            AND (effective_to IS NULL OR effective_to > NOW())
                          THEN 1 ELSE 0 END)::int AS effective,
                 SUM(CASE WHEN status = 'revoked' OR effective_from > NOW()
                            OR (effective_to IS NOT NULL AND effective_to <= NOW())
                          THEN 1 ELSE 0 END)::int AS ineffective
            FROM role_bindings`,
    expect: { total: 4, at_version_1: 4, effective: 1, ineffective: 3 },
  },
  {
    // 057 §5 — the supersession is an AUDITED act, not a silent one.
    id: 'audit_supersession_is_recorded',
    sql: `SELECT COUNT(*)::int AS n FROM audit_events
           WHERE event_type = 'identity.support.approval_superseded'`,
    expect: { n: 1 },
  },
];

const failures: string[] = [];
const evidence: Record<string, unknown> = {};

function fail(message: string): void {
  failures.push(message);
}

async function scalar(sql: string): Promise<number> {
  return Number((await query(sql)).rows[0]?.n ?? -1);
}

/** 050's two CHECKs over the legacy free-text columns must stay NOT VALID. */
async function assertNotValidConstraints(): Promise<void> {
  const constraints = (
    await query(
      `SELECT conname, convalidated FROM pg_constraint
        WHERE conname IN ('service_queue_items_queue_type_check','comeback_cases_root_cause_check')
        ORDER BY conname`,
    )
  ).rows as Array<{ conname: string; convalidated: boolean }>;

  for (const expected of [
    'comeback_cases_root_cause_check',
    'service_queue_items_queue_type_check',
  ]) {
    const row = constraints.find((c) => c.conname === expected);
    if (!row) fail(`constraint ${expected} is MISSING`);
    else if (row.convalidated !== false)
      fail(`constraint ${expected} is validated — expected NOT VALID`);
    else console.log(`constraint=${expected} convalidated=false (expected)`);
  }
}

/** The retained Fixed Ops seed survived the upgrade. */
async function assertFixedOpsSeedSurvived(): Promise<void> {
  const seedChecks: Array<[string, string]> = [
    [
      'legacy free-text queue item',
      `SELECT COUNT(*)::int AS n FROM service_queue_items WHERE queue_type = 'legacy express lane'`,
    ],
    [
      'legacy free-text comeback case',
      `SELECT COUNT(*)::int AS n FROM comeback_cases WHERE root_cause_category = 'came back - misc'`,
    ],
    [
      'legacy non-numeric price_ref line',
      `SELECT COUNT(*)::int AS n FROM ro_line_items WHERE price_ref->>'amount_cents' = 'call for price'`,
    ],
    [
      'legacy repair orders',
      `SELECT COUNT(*)::int AS n FROM repair_orders WHERE tenant_id = '99999999-9999-4999-8999-999999999999'`,
    ],
  ];
  for (const [label, sql] of seedChecks) {
    const n = await scalar(sql);
    if (n < 1) fail(`${label}: expected >= 1 surviving row, found ${n}`);
    else console.log(`seed-survived=${JSON.stringify(label)} rows=${n}`);
  }
}

/**
 * Migration 055's backfill reconciliation. Every legacy tenant_id must have become
 * a tenant; every legacy (tenant, location) pair must resolve to a rooftop whose id
 * IS the location_id, with an intact chain up to its tenant.
 */
async function assertOrganizationBackfill(): Promise<void> {
  const orphanTenants = await scalar(
    `SELECT COUNT(*)::int AS n FROM (
       SELECT tenant_id FROM service_appointments UNION
       SELECT tenant_id FROM repair_orders UNION
       SELECT tenant_id FROM mpi_templates UNION
       SELECT tenant_id FROM service_queue_items UNION
       SELECT tenant_id FROM comeback_cases UNION
       SELECT tenant_id FROM service_waitlist_entries UNION
       SELECT tenant_id FROM first_service_offers UNION
       SELECT tenant_id FROM audit_events
     ) legacy WHERE tenant_id NOT IN (SELECT tenant_id FROM tenants)`,
  );
  if (orphanTenants !== 0)
    fail(`backfill: ${orphanTenants} legacy tenant_id(s) missing from tenants`);
  else console.log('backfill-tenants=complete');

  /*
   * 055 ACTIVATES NOTHING, and this is now scoped to the tenants 055 itself
   * created rather than to every row in the table. The previous form —
   * `tenants WHERE status <> 'pending_configuration'` — was correct only while the
   * database held no other tenants, so it could not coexist with a populated
   * identity fixture whose tenants are legitimately in service. Restricting it to
   * the tenant ids that appear in legacy Fixed Ops data asserts exactly the
   * property 055 is responsible for, and asserts it in every phase.
   */
  const activatedByBackfill = await scalar(
    `SELECT COUNT(*)::int AS n FROM tenants t
      WHERE t.status <> 'pending_configuration'
        AND t.tenant_id IN (
          SELECT tenant_id FROM service_appointments UNION
          SELECT tenant_id FROM repair_orders UNION
          SELECT tenant_id FROM mpi_templates UNION
          SELECT tenant_id FROM service_queue_items UNION
          SELECT tenant_id FROM comeback_cases UNION
          SELECT tenant_id FROM service_waitlist_entries UNION
          SELECT tenant_id FROM first_service_offers
        )`,
  );
  if (activatedByBackfill !== 0)
    fail(
      `backfill: ${activatedByBackfill} legacy Fixed Ops tenant(s) are not ` +
        `pending_configuration — 055 must not activate anything`,
    );
  else console.log('backfill-legacy-tenants-status=pending_configuration');

  const orphanRooftops = await scalar(
    `SELECT COUNT(*)::int AS n FROM (
       SELECT tenant_id, location_id FROM service_appointments WHERE location_id IS NOT NULL UNION
       SELECT tenant_id, location_id FROM repair_orders WHERE location_id IS NOT NULL UNION
       SELECT tenant_id, location_id FROM mpi_templates WHERE location_id IS NOT NULL UNION
       SELECT tenant_id, location_id FROM tech_profiles WHERE location_id IS NOT NULL UNION
       SELECT tenant_id, location_id FROM service_queue_items WHERE location_id IS NOT NULL UNION
       SELECT tenant_id, location_id FROM first_service_offers WHERE location_id IS NOT NULL UNION
       SELECT tenant_id, location_id FROM service_waitlist_entries WHERE location_id IS NOT NULL
     ) legacy
     WHERE NOT EXISTS (
       SELECT 1 FROM rooftops r
        WHERE r.rooftop_id = legacy.location_id AND r.tenant_id = legacy.tenant_id
     )`,
  );
  if (orphanRooftops !== 0)
    fail(
      `backfill: ${orphanRooftops} legacy (tenant, location) pair(s) without a matching rooftop`,
    );
  else console.log('backfill-rooftops=complete (rooftop_id = legacy location_id)');

  const brokenChains = await scalar(
    `SELECT COUNT(*)::int AS n FROM rooftops r
      WHERE NOT EXISTS (
        SELECT 1 FROM legal_entities le
        JOIN dealer_groups g
          ON g.tenant_id = le.tenant_id AND g.dealer_group_id = le.dealer_group_id
        JOIN tenants t ON t.tenant_id = le.tenant_id
        WHERE le.tenant_id = r.tenant_id AND le.legal_entity_id = r.legal_entity_id
      )`,
  );
  if (brokenChains !== 0) fail(`backfill: ${brokenChains} rooftop(s) with a broken ancestor chain`);
  else console.log('backfill-ancestry=intact');
}

/**
 * The identity census: one count per table, recorded for the artifact.
 *
 * ONE STATIC STATEMENT, not a loop interpolating a table name. That is deliberate:
 * `scripts/check-role-binding-effectiveness.ts` cannot statically decide what a query
 * built from `${table}` addresses, and it is right to refuse — a guard that cannot read
 * a statement must not assume the statement is safe. Written out, every table this
 * census touches is visible to the guard and to a reader.
 *
 */
async function census(): Promise<Record<string, number>> {
  const row = (
    await query(
      // role-binding-effectiveness-opt-out(all-bindings-including-ineffective): this
      // counts EVERY row in each identity table, `role_bindings` among them, because the
      // property is "nothing was invented and nothing was deleted". A count that filtered
      // by effectiveness would report zero for a table holding a future-dated or aged-out
      // binding, so it would pass while an upgrade had in fact fabricated a standing
      // grant — the precise thing this census exists to catch. It reads the tables as they
      // are and decides nothing about what any row authorizes.
      `SELECT (SELECT COUNT(*) FROM identity_provider_connections)::int
                AS identity_provider_connections,
              (SELECT COUNT(*) FROM user_links)::int              AS user_links,
              (SELECT COUNT(*) FROM identity_sessions)::int       AS identity_sessions,
              (SELECT COUNT(*) FROM role_bindings)::int           AS role_bindings,
              (SELECT COUNT(*) FROM policy_decisions)::int        AS policy_decisions,
              (SELECT COUNT(*) FROM reauthentication_transactions)::int
                AS reauthentication_transactions,
              (SELECT COUNT(*) FROM reauthentication_grants)::int AS reauthentication_grants,
              (SELECT COUNT(*) FROM support_access_requests)::int AS support_access_requests,
              (SELECT COUNT(*) FROM support_access_sessions)::int AS support_access_sessions`,
    )
  ).rows[0] as Record<string, number>;
  const counts: Record<string, number> = {};
  for (const table of CENSUS_TABLES) counts[table] = Number(row[table] ?? -1);
  return counts;
}

/** `backfill` phase only: 055 and 056 invented no identities and no evidence. */
async function assertIdentityTablesEmpty(counts: Record<string, number>): Promise<void> {
  for (const table of CENSUS_TABLES) {
    const n = counts[table] ?? -1;
    if (n !== 0)
      fail(`backfill: ${table} has ${n} row(s) — 055/056 must invent no identities or evidence`);
    else console.log(`backfill-empty=${table}`);
  }
  return Promise.resolve();
}

/** `pre-057` phase: the fixture is genuinely present, at exact counts. */
async function assertFixturePresent(counts: Record<string, number>): Promise<void> {
  for (const table of CENSUS_TABLES) {
    const actual = counts[table] ?? -1;
    const expected = EXPECTED_FIXTURE_COUNTS[table];
    if (actual === 0) {
      fail(
        `pre-057: ${table} is EMPTY — the populated identity fixture did not apply, and an ` +
          `empty pre-057 database cannot exercise a single reconciliation in 057`,
      );
    } else if (actual !== expected) {
      fail(`pre-057: ${table} holds ${actual} row(s), fixture declares ${expected}`);
    } else {
      console.log(`pre-057-seeded=${table} rows=${actual}`);
    }
  }

  for (const [label, sql, expected] of EXPECTED_FIXTURE_SHAPES) {
    const n = await scalar(sql);
    if (n !== expected) fail(`pre-057: ${label}: expected ${expected}, found ${n}`);
    else console.log(`pre-057-shape=${JSON.stringify(label)} rows=${n}`);
  }
}

/** `post-057` phase: every reconciliation left its rows in the ONE intended state. */
async function assertReconciledState(): Promise<void> {
  for (const { id, sql, expect } of RECONCILED_STATE) {
    const rows = (await query(sql)).rows as Array<Record<string, unknown>>;
    if (rows.length !== 1) {
      fail(`post-057: ${id}: expected exactly 1 row, got ${rows.length}`);
      continue;
    }
    const row = rows[0] as Record<string, unknown>;
    const wrong: string[] = [];
    for (const [column, want] of Object.entries(expect)) {
      const got = row[column];
      if (got !== want)
        wrong.push(`${column}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
    }
    if (wrong.length > 0) fail(`post-057: ${id}: ${wrong.join('; ')}`);
    else console.log(`post-057-reconciled=${id}`);
  }
}

/**
 * `post-057` phase: NOTHING WAS DELETED, and the counts on both sides are NONZERO.
 *
 * 057 reconciles by CHANGING STATE, never by removing rows — a migration that
 * closed a problem by deleting the evidence of it would satisfy every constraint
 * in the file and destroy the audit trail. Comparing the two censuses is what
 * makes that distinguishable from a clean pass.
 */
function assertCountsPreserved(
  before: Record<string, number>,
  after: Record<string, number>,
): void {
  for (const table of CENSUS_TABLES) {
    const b = before[table] ?? -1;
    const a = after[table] ?? -1;
    if (b <= 0) fail(`post-057: before-count for ${table} is ${b} — the drill ran on no data`);
    else if (a <= 0) fail(`post-057: after-count for ${table} is ${a} — rows disappeared`);
    else if (a !== b)
      // Worded so no interpolation follows the word "from": a message shaped like
      // `… from ${x} …` is indistinguishable from a table position to a static reader,
      // and check-role-binding-effectiveness.ts correctly refuses what it cannot resolve.
      fail(`post-057: ${table} held ${b} row(s) before and ${a} after — 057 deletes nothing`);
    else console.log(`post-057-count=${table} before=${b} after=${a}`);
  }
}

/**
 * `post-057` phase: the policy-evidence VERSION FLOOR is live.
 *
 * Historic rows keep version 1 and stay readable; no NEW decision may claim it.
 * Without the trigger the version would be a self-certification — a writer could
 * keep claiming version 1 for ever and inherit the historic exemption — so the
 * floor is probed directly rather than inferred from the trigger's existence.
 * The probe runs inside a transaction that is ALWAYS rolled back, so the drill
 * database is left exactly as it was found.
 */
async function assertEvidenceVersionFloor(): Promise<void> {
  const ROLLBACK = new Error('verify-upgrade-state: intentional rollback');
  let refused = false;
  let detail = '';
  try {
    await withTransaction(async (tx) => {
      try {
        await tx.query(
          `INSERT INTO policy_decisions
             (actor_type, action, decision, reason_code, policy_version, evidence_version)
           VALUES ('system', 'platform.probe', 'deny', 'PROBE', 'v1', 1)`,
        );
      } catch (err) {
        refused = true;
        detail = (err as Error).message.split('\n')[0] ?? '';
      }
      throw ROLLBACK;
    });
  } catch (err) {
    if (err !== ROLLBACK) throw err;
  }
  if (!refused)
    fail(
      'post-057: policy_decisions accepted a NEW row at evidence_version 1 — the version ' +
        'floor trigger is not in force, so a writer can opt back into the incomplete class',
    );
  else console.log(`post-057-evidence-floor=refused detail=${JSON.stringify(detail)}`);
}

function parseArgs(): { phase: Phase; out: string | undefined; before: string | undefined } {
  const argv = process.argv.slice(2);
  let phase: string | undefined;
  let out: string | undefined;
  let before: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg.startsWith('--phase=')) phase = arg.slice('--phase='.length);
    else if (arg === '--phase') phase = argv[(i += 1)];
    else if (arg === '--out') out = argv[(i += 1)];
    else if (arg === '--before') before = argv[(i += 1)];
    else {
      console.error(`Unrecognized argument: ${arg}`);
      process.exit(2);
    }
  }
  // FAIL CLOSED on the phase. A default would let a mis-typed flag silently run the
  // weakest set of assertions and report a pass.
  if (phase === undefined || !PHASES.includes(phase as Phase)) {
    console.error(
      `Usage: verify-upgrade-state.ts --phase=<${PHASES.join('|')}> [--out <json>] [--before <json>]`,
    );
    process.exit(2);
  }
  return { phase: phase as Phase, out, before };
}

async function main(): Promise<void> {
  const { phase, out, before } = parseArgs();
  console.log(`phase=${phase}`);
  evidence.phase = phase;

  if (phase === 'backfill') {
    await assertNotValidConstraints();
    await assertFixedOpsSeedSurvived();
    await assertOrganizationBackfill();
    const counts = await census();
    evidence.identity_counts = counts;
    await assertIdentityTablesEmpty(counts);
  } else if (phase === 'pre-057') {
    const counts = await census();
    evidence.identity_counts = counts;
    await assertFixturePresent(counts);
  } else {
    await assertNotValidConstraints();
    await assertFixedOpsSeedSurvived();
    await assertOrganizationBackfill();
    const counts = await census();
    evidence.identity_counts = counts;
    if (before === undefined) {
      fail('post-057: --before <pre-057 census json> is required so counts can be compared');
    } else {
      const { readFileSync } = await import('fs');
      const parsed = JSON.parse(readFileSync(before, 'utf8')) as {
        identity_counts?: Record<string, number>;
      };
      const beforeCounts = parsed.identity_counts;
      if (beforeCounts === undefined) fail(`post-057: ${before} carries no identity_counts`);
      else {
        evidence.identity_counts_before = beforeCounts;
        assertCountsPreserved(beforeCounts, counts);
      }
    }
    await assertReconciledState();
    await assertEvidenceVersionFloor();
  }

  evidence.failures = failures;
  evidence.result = failures.length === 0 ? 'OK' : 'FAILED';
  if (out !== undefined) {
    writeFileSync(out, JSON.stringify(evidence, null, 2) + '\n');
    console.log(`census-written=${out}`);
  }

  if (failures.length > 0) {
    for (const f of failures) console.error('FAIL: ' + f);
    process.exitCode = 1;
    return;
  }
  console.log(`Upgrade-state verification OK (phase=${phase}).`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
