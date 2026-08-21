/**
 * Proves the upgraded database is in the intended state.
 *
 *   DATABASE_URL=... npx tsx scripts/verify-upgrade-state.ts --phase=<phase> [options]
 *
 *     --phase=backfill   at migration 056, BEFORE the identity fixture is seeded
 *     --phase=pre-057    after the identity fixture is seeded, BEFORE 057
 *     --phase=post-057   after 057 has been applied on top of that fixture, and
 *                        BEFORE 058
 *     --phase=post-058   after realistic post-057 activity and then 058
 *     --out <file>       write this phase's machine-readable census as JSON
 *     --before <file>    (post-057 and post-058) the census to compare against
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
 *               refuses a new incomplete decision while still ACCEPTING the
 *               version 057 made current.
 *   post-058  — everything post-057 asserted still holds (retained rows do not
 *               move), 058's own reconciliation landed, and the §3.1 exemption is
 *               real: the drill's realistic activity left decisions whose recorded
 *               authentication time is no longer their session's, 058 applied
 *               anyway, those rows are UNCHANGED, and the exact-binding rule is in
 *               force from evidence_version 3 onward. §3.3's history-tolerance case
 *               is asserted the same way: stored authority naming a binding version
 *               that binding has since advanced past SURVIVED 058, and none of it
 *               sits at evidence_version 3.
 *
 * ── FBL-020-R6-R6 §D1b: WHY post-058 IS A SEPARATE PHASE ────────────────────
 *
 * Until this revision the drill applied 057 and 058 in ONE `npm run migrate`, and
 * `--phase=post-057` ran afterwards. That made the drill structurally incapable of
 * putting a row in front of 058's pre-checks: the fixture it seeds is PRE-057 by
 * construction — it predates `policy_decisions.session_id` — so no decision in it
 * could name a session, and 058 §3.1's rule about decisions that name sessions was
 * measured against zero rows. 058 shipped a pre-check that ABORTED on one ordinary
 * version-2 ALLOW plus one provider re-authentication, and no gate could see it.
 *
 * So the two migrations are now applied separately, with
 * `scripts/upgrade-post-057-activity.ts` between them generating that activity
 * through the production code paths. `post-057` runs on the 057-only database and
 * `post-058` runs after 058, and the count comparison changes shape accordingly:
 * EXACT at post-057 (057 deletes nothing and adds nothing), and MONOTONE at
 * post-058, where the activity stage has deliberately added rows.
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

type Phase = 'backfill' | 'pre-057' | 'post-057' | 'post-058' | 'post-059';

const PHASES: readonly Phase[] = ['backfill', 'pre-057', 'post-057', 'post-058', 'post-059'];

/** The phases at which the drill has deliberately ADDED rows between censuses. */
const GROWTH_PHASES: readonly Phase[] = ['post-058', 'post-059'];

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
  policy_decisions: 6,
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
    // FBL-020-R6 gate finding C1. Migration 058 §0 reconciles the normalized
    // authority rows 057 never backfilled, and it can only be exercised by a
    // decision that RECORDS authority. A fixture whose allows all carry `{}` — which
    // is what this one carried for four revisions — derives nothing, so the drill
    // ran green over a migration that aborts on the first real ALLOW in production.
    // This floor is what stops that fixture coming back.
    'ordinary ALLOWs carrying a NON-EMPTY matched-binding array',
    `SELECT COUNT(*)::int AS n FROM policy_decisions
      WHERE decision = 'allow' AND cardinality(matched_role_binding_ids) > 0`,
    4,
  ],
  [
    // …and one of them claims a version the binding has never reached, so the
    // UNRECONCILABLE branch of 058 §0 is exercised too rather than only described.
    // This is the shape that survives 057 — §11a already refuses a database whose
    // arrays name an absent or somebody-else's binding, so 058 never meets that one.
    'ALLOWs claiming an authorization version the binding has never reached',
    // role-binding-effectiveness-opt-out(all-bindings-including-ineffective): this counts
    // retained EVIDENCE against EVERY binding, the ineffective ones included, because the
    // property under test is whether a stored authority claim can be normalized at all —
    // which turns on the binding EXISTING and on the version it has reached, never on
    // whether the engine would match it today. Resolving the shared predicate would hide
    // the fixture's aged-out and revoked bindings and the count would silently become
    // zero, so the migration branch this floor exists to exercise would go unexercised.
    // It authorizes nothing and grants nothing; it counts rows in a disposable drill
    // database.
    `SELECT COUNT(*)::int AS n FROM policy_decisions d
      WHERE cardinality(d.matched_role_binding_ids) > 0
        AND EXISTS (
          SELECT 1 FROM unnest(d.matched_role_binding_ids) WITH ORDINALITY AS m(id, ord)
            JOIN role_bindings rb ON rb.role_binding_id = m.id
           WHERE d.matched_authorization_versions[m.ord] > rb.authorization_version)`,
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
 * THE RECONCILED STATE, ROW BY ROW.
 *
 * Each entry names the reconciliation under test, the single fixture row it acts
 * on, and the EXACT state that row must be in afterwards. The values come from
 * observing the migration run on this fixture; they are asserted rather than
 * described so a future edit that changes an outcome has to change this file too.
 *
 * `from` says which migration produced the state, and therefore the EARLIEST phase
 * at which the entry can be asserted: a `058` entry cannot be checked on a database
 * that carries 057 only. Every `057` entry is ALSO asserted at post-058, because
 * "058 did not disturb what 057 reconciled" is exactly the property that matters
 * once the two are applied separately.
 */
const RECONCILED_STATE: Array<{
  id: string;
  from: '057' | '058';
  sql: string;
  expect: Record<string, unknown>;
}> = [
  {
    // 057 §1 — tenant A has exactly one active connection, so the link BINDS.
    id: 'ul_a1_bound_to_its_only_active_connection',
    from: '057',
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
    from: '057',
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
    from: '057',
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
    from: '057',
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
    from: '057',
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
    from: '057',
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
    from: '057',
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
    from: '057',
    sql: `SELECT state, terminal_reason, (terminal_at = completed_at) AS terminal_is_completed_at
            FROM reauthentication_transactions
           WHERE reauth_txn_id = '70000002-0000-4000-8000-000000000002'`,
    expect: { state: 'completed', terminal_reason: 'granted', terminal_is_completed_at: true },
  },
  {
    // 057 §9 — a failure with no recorded cause is classified as unclassified
    // rather than assigned a plausible one.
    id: 'rat_t3_failed_transaction_classified_honestly',
    from: '057',
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
    from: '057',
    sql: `SELECT connection_id::text AS connection_id, assurance_level
            FROM reauthentication_grants WHERE grant_id = '80000001-0000-4000-8000-000000000001'`,
    expect: { connection_id: null, assurance_level: 'fresh_and_mfa_policy' },
  },
  {
    // 057 §5 — the prior decision is PRESERVED, authority is not. The row moves to
    // a terminal state, its decision moves to the superseded_* columns, and its
    // authorization_version advances.
    id: 'sar_r2_approval_without_a_grant_superseded',
    from: '057',
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
    from: '057',
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
    from: '057',
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
    from: '057',
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
    from: '057',
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
    /*
     * 058 §0 — THE RECONCILIATION FBL-020-R6's GATE FINDING C1 REQUIRES, MEASURED.
     *
     * 057 installed the matched-binding normalizer as an AFTER INSERT trigger and never
     * backfilled, so on this fixture every retained ALLOW arrives with an array and no
     * normalized rows. 058 §0 derives them. This asserts the derived set EXACTLY — three
     * decisions, four rows, each row's binding, version and ORDINALITY — because a
     * reconciliation that dropped a row, sorted the array, or re-judged a historic
     * binding by today's effectiveness rules would still leave "some rows" behind.
     *
     * D4 is the one that pins ORDER: its array is `{90000003, 90000001}`, so ordinality 1
     * must be `90000003`. Both of D4's bindings are INEFFECTIVE today and one of D6's is
     * REVOKED; they are normalized anyway, because 058 §0 records what the decision said
     * rather than re-deciding it.
     *
     * SCOPED TO THE RETAINED FIXTURE (R6-R6 §D1b). The drill now runs realistic activity
     * between 057 and 058, and that activity legitimately writes normalized rows of its
     * own, so a whole-table count would fail for the right reason and prove the wrong
     * thing. The `d00000%` family is exactly the fixture's decisions. Nothing is lost by
     * narrowing it: `assertNormalizedEvidenceIsEquivalent` below checks EVERY decision in
     * the database against its own array, which is a stronger statement about
     * over-derivation than a total ever was.
     */
    id: 'pdmb_reconciled_from_the_retained_arrays_in_order',
    from: '058',
    sql: `SELECT COUNT(*)::int AS rows_derived,
                 COUNT(DISTINCT decision_id)::int AS decisions_normalized,
                 string_agg(
                   substr(decision_id::text, 1, 8) || ':' || match_ordinality || ':' ||
                     substr(role_binding_id::text, 1, 8) || '@' || authorization_version,
                   ' ' ORDER BY decision_id, match_ordinality) AS normalized
            FROM policy_decision_matched_bindings
           WHERE decision_id::text LIKE 'd00000%'`,
    expect: {
      rows_derived: 4,
      decisions_normalized: 3,
      normalized:
        'd0000003:1:90000001@1 ' +
        'd0000004:1:90000003@1 d0000004:2:90000001@1 ' +
        'd0000006:1:90000004@1',
    },
  },
  {
    /*
     * …and the RESIDUE, which is the other half of C1: a retained ALLOW claiming a
     * binding at a version that binding has never reached cannot be normalized without
     * writing a child row 057's own `trg_pdmb_version_reachable` refuses, and
     * `policy_decisions` is append-only so the array cannot be corrected either. 058 §0
     * therefore leaves it EXACTLY as written, at evidence_version 1, and the §3.2
     * equivalence rule exempts it by that version. This asserts that the row survived
     * unedited, that it holds no normalized rows at all (never a partial set), and that
     * it is the ONLY such row.
     */
    id: 'pd_unreconcilable_authority_survives_at_version_1',
    from: '058',
    sql: `SELECT (SELECT COUNT(*)::int FROM policy_decisions d
                   WHERE cardinality(d.matched_role_binding_ids) > 0
                     AND NOT EXISTS (SELECT 1 FROM policy_decision_matched_bindings c
                                      WHERE c.decision_id = d.decision_id)) AS unnormalized,
                 (SELECT evidence_version::int FROM policy_decisions
                   WHERE decision_id = 'd0000005-0000-4000-8000-000000000005') AS evidence_version,
                 (SELECT array_to_string(matched_role_binding_ids, ',')
                         || '@' || array_to_string(matched_authorization_versions, ',')
                    FROM policy_decisions
                   WHERE decision_id = 'd0000005-0000-4000-8000-000000000005') AS array_intact,
                 (SELECT COUNT(*)::int FROM policy_decisions d
                   WHERE d.evidence_version >= 2
                     AND cardinality(d.matched_role_binding_ids) > 0
                     AND NOT EXISTS (SELECT 1 FROM policy_decision_matched_bindings c
                                      WHERE c.decision_id = d.decision_id)) AS unnormalized_v2`,
    expect: {
      unnormalized: 1,
      evidence_version: 1,
      array_intact: '90000001-0000-4000-8000-000000000001@7',
      unnormalized_v2: 0,
    },
  },
  {
    // 057 touches role_bindings NOWHERE. All four windows come through unchanged,
    // at version 1: an ineffective binding quietly becoming effective, or a version
    // advancing, would be inventing standing authority.
    id: 'rb_all_four_windows_survive_unchanged',
    from: '057',
    // role-binding-effectiveness-opt-out(all-bindings-including-ineffective): this reads
    // EVERY binding and classifies each one, which is the only way to state the property.
    // Resolving the shared predicate would return the effective bindings alone, so a
    // migration that had PROMOTED a future-dated or revoked binding into an effective one
    // would satisfy the query and the fabrication would pass unseen. It decides nothing
    // about what any row authorizes; it counts rows and compares against the fixture.
    //
    // SCOPED TO THE RETAINED FIXTURE (R6-R6 §D1b): the `90000%` family is exactly the four
    // bindings the pre-057 seed inserts. The drill's post-057 activity stage grants,
    // revokes and re-grants bindings of its own on purpose, and the property under test
    // here is about the RETAINED four — "057 touches role_bindings nowhere", which a
    // whole-table count can no longer express once other rows legitimately exist.
    sql: `SELECT COUNT(*)::int AS total,
                 SUM(CASE WHEN authorization_version = 1 THEN 1 ELSE 0 END)::int AS at_version_1,
                 SUM(CASE WHEN status = 'active' AND effective_from <= NOW()
                            AND (effective_to IS NULL OR effective_to > NOW())
                          THEN 1 ELSE 0 END)::int AS effective,
                 SUM(CASE WHEN status = 'revoked' OR effective_from > NOW()
                            OR (effective_to IS NOT NULL AND effective_to <= NOW())
                          THEN 1 ELSE 0 END)::int AS ineffective
            FROM role_bindings
           WHERE role_binding_id::text LIKE '90000%'`,
    expect: { total: 4, at_version_1: 4, effective: 1, ineffective: 3 },
  },
  {
    /*
     * 057 §5 — the supersession is an AUDITED act, not a silent one.
     *
     * FBL-020-R5 §0.6: the REASON is part of the assertion now. 057 §5 contains TWO
     * statements that write `identity.support.approval_superseded` — the grantless-approval
     * one, and the duplicate-grant one that matches zero rows on a pre-057 fixture — and
     * they are distinguishable only by the reason they record. Counting the event type
     * alone would be satisfied by either, so it could not tell "the grantless supersession
     * was audited" from "some supersession was audited", and the negative control that
     * removes the grantless audit insert needs exactly that distinction to fail on.
     */
    id: 'audit_grantless_supersession_is_recorded_with_its_reason',
    from: '057',
    sql: `SELECT COUNT(*)::int AS n FROM audit_events
           WHERE event_type = 'identity.support.approval_superseded'
             AND entity_type = 'support_access_request'
             AND details->>'reason' = 'fbl_020_r3_no_approving_grant'
             AND details->>'previous_status' = 'approved'`,
    expect: { n: 1 },
  },
  {
    // …and the OTHER supersession reason must appear NOWHERE. 057 §5's duplicate-grant
    // statements match zero rows on this fixture by construction (`approval_grant_id` is
    // created by 057, so no retained row can name a grant twice), so an event carrying
    // their reason would mean a reconciliation acted on rows nobody put there. Asserted
    // separately from the count above so the two fail for different reasons.
    id: 'audit_no_duplicate_grant_supersession_invented',
    from: '057',
    sql: `SELECT COUNT(*)::int AS n FROM audit_events
           WHERE event_type = 'identity.support.approval_superseded'
             AND details->>'reason' = 'fbl_020_r3_duplicate_approval_grant'`,
    expect: { n: 0 },
  },
];

const failures: string[] = [];
const evidence: Record<string, unknown> = {};

function fail(message: string): void {
  failures.push(message);
}

async function scalar(sql: string, params: readonly unknown[] = []): Promise<number> {
  return Number((await query(sql, [...params])).rows[0]?.n ?? -1);
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

/**
 * Every reconciliation left its rows in the ONE intended state.
 *
 * At `post-057` only the 057 expectations can be asserted, because 058 has not run.
 * At `post-058` ALL of them are asserted: 058's own reconciliation AND every 057
 * outcome, because "058 disturbed nothing 057 had already settled" is the property
 * that separating the two migrations exists to check.
 */
async function assertReconciledState(phase: Phase): Promise<void> {
  const applicable = RECONCILED_STATE.filter(
    (entry) => GROWTH_PHASES.includes(phase) || entry.from === '057',
  );
  if (applicable.length === 0) {
    fail(`${phase}: no reconciliation expectations are applicable — the filter cannot be empty`);
    return;
  }
  for (const { id, sql, expect } of applicable) {
    const rows = (await query(sql)).rows as Array<Record<string, unknown>>;
    if (rows.length !== 1) {
      fail(`${phase}: ${id}: expected exactly 1 row, got ${rows.length}`);
      continue;
    }
    const row = rows[0] as Record<string, unknown>;
    const wrong: string[] = [];
    for (const [column, want] of Object.entries(expect)) {
      const got = row[column];
      if (got !== want)
        wrong.push(`${column}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
    }
    if (wrong.length > 0) fail(`${phase}: ${id}: ${wrong.join('; ')}`);
    else console.log(`${phase}-reconciled=${id}`);
  }
}

/**
 * NOTHING WAS DELETED, and the counts on both sides are NONZERO.
 *
 * 057 reconciles by CHANGING STATE, never by removing rows — a migration that
 * closed a problem by deleting the evidence of it would satisfy every constraint
 * in the file and destroy the audit trail. Comparing the two censuses is what
 * makes that distinguishable from a clean pass.
 *
 * TWO SHAPES, AND THE DIFFERENCE IS NOT A RELAXATION. At `post-057` the comparison
 * is EXACT: 057 neither adds nor removes a row, so any change is a defect. At
 * `post-058` the drill has deliberately run realistic activity between the two
 * migrations, so rows were ADDED on purpose — the rule there is that no table
 * shrank, and additionally that `policy_decisions` really did GROW, because a
 * post-058 phase that passed on an unchanged census would mean the activity stage
 * wrote nothing and 058 was once again measured against the pre-057 fixture alone.
 */
function assertCountsPreserved(
  phase: Phase,
  before: Record<string, number>,
  after: Record<string, number>,
): void {
  for (const table of CENSUS_TABLES) {
    const b = before[table] ?? -1;
    const a = after[table] ?? -1;
    if (b <= 0) fail(`${phase}: before-count for ${table} is ${b} — the drill ran on no data`);
    else if (a <= 0) fail(`${phase}: after-count for ${table} is ${a} — rows disappeared`);
    else if (GROWTH_PHASES.includes(phase) ? a < b : a !== b)
      // Worded so no interpolation follows the word "from": a message shaped like
      // `… from ${x} …` is indistinguishable from a table position to a static reader,
      // and check-role-binding-effectiveness.ts correctly refuses what it cannot resolve.
      fail(`${phase}: ${table} held ${b} row(s) before and ${a} after — nothing may be deleted`);
    else console.log(`${phase}-count=${table} before=${b} after=${a}`);
  }
  if (GROWTH_PHASES.includes(phase)) {
    const b = before.policy_decisions ?? -1;
    const a = after.policy_decisions ?? -1;
    if (a <= b)
      fail(
        `${phase}: policy_decisions held ${b} row(s) before and ${a} after — the activity ` +
          'stage this phase follows wrote no evidence, so the migration was once again ' +
          'measured against rows its rules cannot reach',
      );
    else console.log(`${phase}-activity-added-decisions=${a - b}`);
  }
}

const ROLLBACK = new Error('verify-upgrade-state: intentional rollback');

/**
 * Runs one probe INSERT inside a transaction that is ALWAYS rolled back, and reports
 * whether the database refused it. The drill database is left exactly as it was
 * found either way, so a probe can be as adversarial as the rule it is testing.
 */
async function probeRefusal(sql: string, params: readonly unknown[] = []): Promise<string | null> {
  let detail: string | null = null;
  try {
    await withTransaction(async (tx) => {
      try {
        await tx.query(sql, params as unknown[]);
      } catch (err) {
        detail = (err as Error).message.split('\n')[0] ?? '';
      }
      throw ROLLBACK;
    });
  } catch (err) {
    if (err !== ROLLBACK) throw err;
  }
  return detail;
}

/**
 * The policy-evidence VERSION FLOOR is live, AT THE VERSION THIS PHASE EXPECTS.
 *
 * Historic rows keep the version they were written at and stay readable; no NEW
 * decision may claim one below the current minimum. Without the trigger the version
 * would be a self-certification — a writer could keep claiming the weaker class for
 * ever and inherit its exemption — so the floor is probed directly rather than
 * inferred from the trigger's existence.
 *
 * TWO-SIDED, WHICH THE ONE-SIDED PROBE WAS NOT. It also requires the version the
 * phase considers CURRENT to be ACCEPTED. A one-sided probe passes just as happily
 * against a floor that refuses everything, and at post-058 the interesting question
 * is precisely whether the floor moved from 2 to 3 — which "version 1 is refused"
 * cannot distinguish.
 */
async function assertEvidenceVersionFloor(phase: Phase, minimum: 2 | 3 | 4): Promise<void> {
  const insert = (version: number): [string, unknown[]] => [
    `INSERT INTO policy_decisions
       (actor_type, action, decision, reason_code, policy_version, evidence_version)
     VALUES ('system', 'platform.probe', 'deny', 'PROBE', 'v1', $1)`,
    [version],
  ];
  for (const below of [1, 2, 3].filter((v) => v < minimum)) {
    const [sql, params] = insert(below);
    const detail = await probeRefusal(sql, params);
    if (detail === null)
      fail(
        `${phase}: policy_decisions accepted a NEW row at evidence_version ${below} — the ` +
          'version floor trigger is not in force at the current minimum, so a writer can opt ' +
          'back into a weaker evidence class',
      );
    else
      console.log(
        `${phase}-evidence-floor=refused version=${below} detail=${JSON.stringify(detail)}`,
      );
  }
  const [currentSql, currentParams] = insert(minimum);
  const accepted = await probeRefusal(currentSql, currentParams);
  if (accepted !== null)
    fail(
      `${phase}: policy_decisions REFUSED a new row at evidence_version ${minimum}, which this ` +
        `phase expects to be the current version: ${accepted}`,
    );
  else console.log(`${phase}-evidence-floor=accepts-current version=${minimum}`);
}

/**
 * `post-058` phase: EVERY DECISION'S NORMALIZED EVIDENCE EQUALS ITS OWN ARRAY.
 *
 * This is what replaces the whole-table totals the two fixture-scoped expectations
 * above used to carry, and it is a stronger statement than either: it compares each
 * decision against ITSELF rather than against a number, so it catches an
 * over-derived row, an under-derived row, a re-ordered array and a wrong recorded
 * version, on retained history AND on everything the activity stages wrote.
 *
 * The single exemption is 058 §0's disclosed residue — a decision below
 * evidence_version 2 that holds NO child rows at all, because its array names
 * authority the database can no longer resolve. It is the same discriminator 058's
 * own §3.2 pre-check uses, written the same way, so this cannot pass while that
 * would have failed.
 */
async function assertNormalizedEvidenceIsEquivalent(phase: Phase): Promise<void> {
  const diverged = await scalar(
    `SELECT COUNT(*)::int AS n FROM (
       SELECT d.decision_id
         FROM policy_decisions d
        WHERE NOT (
          d.evidence_version < 2
          AND NOT EXISTS (SELECT 1 FROM policy_decision_matched_bindings c
                           WHERE c.decision_id = d.decision_id)
        )
          AND (
            SELECT COALESCE(array_agg(
                     ROW(c.role_binding_id, c.authorization_version, c.match_ordinality)::text
                     ORDER BY c.match_ordinality, c.role_binding_id), ARRAY[]::text[])
              FROM policy_decision_matched_bindings c WHERE c.decision_id = d.decision_id
          ) IS DISTINCT FROM (
            SELECT COALESCE(array_agg(
                     ROW(m.id, d.matched_authorization_versions[m.ord], m.ord)::text
                     ORDER BY m.ord, m.id), ARRAY[]::text[])
              FROM unnest(d.matched_role_binding_ids) WITH ORDINALITY AS m(id, ord)
          )
     ) x`,
  );
  if (diverged !== 0)
    fail(
      `${phase}: ${diverged} decision(s) hold normalized authority evidence that is not ` +
        'equivalent to their own matched-binding array — 058 §0 either over-derived, ' +
        'under-derived or re-ordered, or a later write diverged from the array beside it',
    );
  else console.log(`${phase}-normalized-equivalence=every-decision-matches-its-own-array`);
}

/**
 * `post-058` phase: 058 §3.3'S HISTORY-TOLERANCE CASE IS PRESENT AND SURVIVED.
 *
 * §3.3's trigger refuses a NEW authority row that names a version its binding has
 * already been moved out of, and its pre-check deliberately asserts only the other
 * direction — a version the binding has NEVER reached. The difference is the whole of
 * the tolerance: a decision records the version in force when it was taken, and every
 * later revocation or re-grant advances the binding past it, so every used database
 * carries such rows and 058 must apply straight over them.
 *
 * `scripts/upgrade-post-057-activity.ts` produces the shape on purpose — an ordinary
 * version-2 ALLOW recorded against a binding that is then revoked — and FAILS its own
 * stage unless the shape is in the database before 058 is applied. This asserts it is
 * still there afterwards, and that every such row is retained history rather than
 * something written under the new rule. That is what makes "058 tolerated it" a
 * measurement instead of an absence of complaints: a 058 that had quietly deleted or
 * rewritten those rows would otherwise leave the drill just as green.
 *
 * The evidence-version leg matters as much as the count. §3.3's trigger fires on every
 * INSERT regardless of version, so a row at evidence_version 3 naming a superseded
 * version would mean the rule was BYPASSED rather than that history was tolerated.
 */
async function assertSupersededVersionHistorySurvived(phase: Phase): Promise<void> {
  // role-binding-effectiveness-opt-out(all-bindings-including-ineffective): this counts stored
  // EVIDENCE rows and joins each to its binding by PRIMARY KEY to read the version that binding
  // now carries. The interesting half is precisely the REVOKED bindings — a revocation is what
  // advances the version past the one the decision recorded — so the shared effectiveness
  // predicate would hide exactly the rows this assertion exists to find. It counts rows and
  // decides nothing about what any binding authorizes.
  const row = (
    await query(
      `SELECT COUNT(*)::int AS rows_below,
            SUM(CASE WHEN d.evidence_version >= 3 THEN 1 ELSE 0 END)::int AS at_version_3
       FROM policy_decision_matched_bindings m
       JOIN role_bindings rb ON rb.role_binding_id = m.role_binding_id
       JOIN policy_decisions d ON d.decision_id = m.decision_id
      WHERE m.authorization_version < rb.authorization_version`,
    )
  ).rows[0] as { rows_below: number; at_version_3: number };
  const rows = Number(row.rows_below);
  evidence.superseded_binding_version_rows = rows;
  if (rows < 1) {
    fail(
      `${phase}: NO stored authority row names a binding version below the one that binding ` +
        'now carries, so 058 was applied to a database on which §3.3 had no history to ' +
        'tolerate — the case this phase exists to prove is untested',
    );
    return;
  }
  if (Number(row.at_version_3) !== 0) {
    fail(
      `${phase}: ${row.at_version_3} authority row(s) at evidence_version 3 or above name a superseded ` +
        'binding version — version 3 is written under the exact-version rule, so this is a ' +
        'bypassed control rather than tolerated history',
    );
    return;
  }
  console.log(`${phase}-superseded-binding-version-rows=${rows}`);
}

/**
 * `post-058` phase: THE §3.1 EXEMPTION IS REAL, AND THE NEW RULE IS IN FORCE.
 *
 * This is the assertion whose absence let 058 ship with a pre-check that aborted on
 * an ordinary post-057 database (R6-R6 finding D1). It states four things, and each
 * one fails separately:
 *
 *   1. The drill's realistic activity really did leave decisions whose recorded
 *      authentication time is no longer their session's CURRENT one. If this is
 *      zero, 058 was applied to a database on which §3.1 had nothing to tolerate
 *      and this phase proves nothing — the same "green for nothing" shape as C1.
 *   2. Every one of those rows is BELOW evidence_version 3. That is what the
 *      exemption is keyed on, so a row at version 3 in that set would mean the
 *      exact-binding rule had been violated rather than exempted.
 *   3. Those rows still carry the version they were written at, and 058 rewrote
 *      nothing: `policy_decisions` is append-only, and this is the check that the
 *      migration did not find some other way round it.
 *   4. A NEW version-3 decision naming a live session must record THAT session's
 *      authentication instant: an arbitrary one is refused, and the session's own is
 *      accepted. Both halves, because a rule that refused everything would satisfy
 *      the first alone.
 */
async function assertAuthTimeExemptionAndBinding(phase: Phase): Promise<void> {
  const drift = (
    await query(
      `SELECT COUNT(*)::int AS total,
            SUM(CASE WHEN d.evidence_version >= 3 THEN 1 ELSE 0 END)::int AS at_version_3
       FROM policy_decisions d
      WHERE d.session_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM identity_sessions s WHERE s.session_id = d.session_id)
        AND NOT EXISTS (SELECT 1 FROM identity_sessions s
                         WHERE s.session_id = d.session_id AND s.auth_time = d.auth_time)`,
    )
  ).rows[0] as { total: number; at_version_3: number };
  evidence.auth_time_exempt_decisions = Number(drift.total);
  if (Number(drift.total) < 1)
    fail(
      `${phase}: NO stored decision records an authentication time that differs from its ` +
        "session's current one, so 058 was applied to a database on which §3.1 had nothing to " +
        'tolerate — the exemption this phase exists to prove is untested',
    );
  else console.log(`${phase}-auth-time-exempt=${drift.total}`);
  if (Number(drift.at_version_3) !== 0)
    fail(
      `${phase}: ${drift.at_version_3} decision(s) at evidence_version 3 or above record an authentication ` +
        'time that is not their session’s — version 3 is the version that binds it exactly, so ' +
        'this is a violated rule rather than an exempted history',
    );

  // (4) THE RULE ITSELF, BOTH WAYS, on a real live session belonging to a real
  // activated link. The probe is rolled back, so the drill database is unchanged.
  const live = (
    await query(
      `SELECT s.session_id::text AS session_id, s.tenant_id::text AS tenant_id,
            s.user_link_id::text AS user_link_id, s.connection_id::text AS connection_id,
            s.provider_subject
       FROM identity_sessions s
      WHERE s.revoked_at IS NULL AND s.expires_at > NOW() AND s.connection_id IS NOT NULL
        AND s.tenant_id IS NOT NULL AND s.provider_subject IS NOT NULL
      ORDER BY s.session_id LIMIT 1`,
    )
  ).rows as Array<Record<string, string>>;
  if (live.length !== 1) {
    fail(`${phase}: the drill left no live, fully bound session to probe the §3.1 rule with`);
    return;
  }
  const s = live[0] as Record<string, string>;
  const columns = `(tenant_id, actor_user_link_id, actor_type, action, decision, reason_code,
       policy_version, request_id, correlation_id, scope_level, scope_id, session_id,
       connection_id, actor_provider_subject, auth_time)`;
  const values = `($1, $2, 'user', 'service.ro.view', 'deny', 'NO_MATCHING_BINDING', 'v1',
       'req_probe', 'corr_probe', NULL, NULL, $3, $4, $5, `;
  const params = [s.tenant_id, s.user_link_id, s.session_id, s.connection_id, s.provider_subject];
  const wrong = await probeRefusal(
    `INSERT INTO policy_decisions ${columns} VALUES ${values} NOW() + INTERVAL '17 minutes')`,
    params,
  );
  if (wrong === null)
    fail(
      `${phase}: policy_decisions accepted a NEW decision recording an authentication time the ` +
        'session it names never had — the §3.1 binding trigger is not in force',
    );
  else console.log(`${phase}-auth-time-bound=refused detail=${JSON.stringify(wrong)}`);
  const right = await probeRefusal(
    `INSERT INTO policy_decisions ${columns} VALUES ${values}
       (SELECT s2.auth_time FROM identity_sessions s2 WHERE s2.session_id = $3))`,
    params,
  );
  if (right !== null)
    fail(
      `${phase}: policy_decisions REFUSED a NEW decision that recorded its named session’s OWN ` +
        `authentication time — the rule refuses everything rather than binding: ${right}`,
    );
  else console.log(`${phase}-auth-time-bound=accepts-the-session-own-instant`);
}

/**
 * `post-059` phase: MIGRATION 059'S INTEGRITY CLOSURE IS IN FORCE, ON THIS DATABASE.
 *
 * Four legs, each failing separately:
 *
 *   1. OBJECTS — every trigger, constraint, column, function and role 059 declares
 *      exists, and the R6-era GUC writer guard is GONE (059 §7 replaces it with the
 *      privilege system, so its survival would mean two writers disagree about who
 *      guards the child table).
 *   2. PRIVILEGES — the runtime role holds no DML on the normalized child table,
 *      cannot assume the evidence owner, and the SECURITY DEFINER normalizer is
 *      owned by that owner. `scripts/upgrade-precheck-refusals.ts` proves the §0
 *      prechecks FIRE; this proves what they protect stands afterwards.
 *   3. RETAINED ROWS — the five §0 precheck queries, re-asked here, find zero
 *      violations: the invariants hold on everything the drill retained.
 *   4. THE WRITTEN RECORD — versions 2, 3 and 4 are all present (history preserved,
 *      the current writer current), nothing outside 1–4 exists, the column DEFAULT
 *      is 4, and one live probe confirms a dealership link still cannot file a
 *      support delegation on this very database.
 */
async function assertIntegrityClosureState(phase: Phase): Promise<void> {
  const expectTriggers = [
    'trg_sar_requester_is_platform',
    'trg_sas_actor_is_platform',
    'trg_sar_authority_immutable',
    'trg_sas_authority_immutable',
    'trg_sas_bounded_by_approval',
    'trg_sar_grant_is_the_approval',
    'trg_policy_decisions_v4_structure',
    'trg_pdmb_live_and_reaches_the_resource',
    'trg_policy_decisions_support_live',
  ];
  for (const trigger of expectTriggers) {
    const n = await scalar(
      `SELECT COUNT(*)::int AS n FROM pg_trigger WHERE NOT tgisinternal AND tgname = $1`,
      [trigger],
    );
    if (n !== 1) fail(`${phase}: trigger ${trigger} is not in force (found ${n})`);
    else console.log(`${phase}-trigger=${trigger}`);
  }
  const goneTrigger = await scalar(
    `SELECT COUNT(*)::int AS n FROM pg_trigger
      WHERE NOT tgisinternal AND tgname = 'trg_pdmb_authorized_writer'`,
  );
  if (goneTrigger !== 0)
    fail(
      `${phase}: trg_pdmb_authorized_writer still exists — 059 §7 replaces the forgeable GUC ` +
        'guard with the privilege system, and a surviving copy would be a second, weaker writer rule',
    );
  else console.log(`${phase}-guc-guard=gone`);

  // [name, validated] — the tuple key is deliberately NOT VALID (059 §1: it is
  // enforced in full for every new write while tolerating append-only ended
  // history nothing can lawfully change); everything else validates cleanly.
  const expectConstraints: ReadonlyArray<[string, boolean]> = [
    ['uq_sar_request_tenant_requester', true],
    ['sas_actor_is_the_approved_requester', false],
    ['pd_resource_rooftop_in_tenant', true],
    ['pd_v4_support_tenant_allow_is_delegated', true],
    ['pd_v4_control_plane_is_structural', true],
    ['pd_v4_target_tenant_is_metadata', true],
    ['pd_v4_identified_actor_names_a_tenant', true],
    ['pd_v4_resource_allow_names_its_rooftop', true],
  ];
  for (const [constraint, validated] of expectConstraints) {
    const n = await scalar(
      `SELECT COUNT(*)::int AS n FROM pg_constraint WHERE conname = $1 AND convalidated = $2`,
      [constraint, validated],
    );
    if (n !== 1)
      fail(
        `${phase}: constraint ${constraint} is not in force ` +
          `(expected convalidated=${validated})`,
      );
    else console.log(`${phase}-constraint=${constraint} validated=${validated}`);
  }
  for (const fn of [
    'org_ancestry_all',
    'org_chain_defect',
    'org_ancestry_effective',
    'resource_org_leaf',
  ]) {
    const n = await scalar(`SELECT COUNT(*)::int AS n FROM pg_proc WHERE proname = $1`, [fn]);
    if (n !== 1) fail(`${phase}: authority function ${fn}() is missing (found ${n})`);
    else console.log(`${phase}-authority-function=${fn}`);
  }
  const goneFn = await scalar(
    `SELECT COUNT(*)::int AS n FROM pg_proc
      WHERE proname = 'policy_decision_matched_bindings_have_one_writer'`,
  );
  if (goneFn !== 0) fail(`${phase}: the GUC guard function still exists`);

  // (2) THE PRIVILEGE MODEL.
  const roleModel = (
    await query(
      `SELECT
         (SELECT NOT rolcanlogin FROM pg_roles WHERE rolname = 'dealership_runtime') AS runtime_nologin,
         (SELECT NOT rolcanlogin FROM pg_roles WHERE rolname = 'dealership_evidence_owner') AS owner_nologin,
         pg_has_role('dealership_runtime', 'dealership_evidence_owner', 'member') AS runtime_is_member,
         has_table_privilege('dealership_runtime', 'policy_decision_matched_bindings', 'INSERT') AS runtime_can_insert,
         has_table_privilege('dealership_evidence_owner', 'policy_decision_matched_bindings', 'INSERT') AS owner_can_insert,
         (SELECT p.prosecdef FROM pg_proc p
           WHERE p.proname = 'policy_decisions_normalize_matched_bindings') AS normalizer_secdef,
         (SELECT r.rolname FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
           WHERE p.proname = 'policy_decisions_normalize_matched_bindings') AS normalizer_owner`,
    )
  ).rows[0] as Record<string, unknown>;
  if (roleModel.runtime_nologin !== true) fail(`${phase}: dealership_runtime must exist NOLOGIN`);
  if (roleModel.owner_nologin !== true)
    fail(`${phase}: dealership_evidence_owner must exist NOLOGIN`);
  if (roleModel.runtime_is_member !== false)
    fail(`${phase}: the runtime role can assume the evidence owner — §3.7's separation is gone`);
  if (roleModel.runtime_can_insert !== false)
    fail(`${phase}: the runtime role holds INSERT on the normalized child table`);
  if (roleModel.owner_can_insert !== true)
    fail(`${phase}: the evidence owner holds no INSERT, so nothing can normalize`);
  if (roleModel.normalizer_secdef !== true)
    fail(`${phase}: the normalizer is not SECURITY DEFINER, so it writes with caller rights`);
  if (String(roleModel.normalizer_owner) !== 'dealership_evidence_owner')
    fail(
      `${phase}: the normalizer is owned by ${String(roleModel.normalizer_owner)}, not the ` +
        'evidence owner',
    );
  console.log(`${phase}-role-model=runtime-without-child-DML, owner-normalizes, no-membership`);

  // (3) THE FIVE §0 INVARIANTS, RE-ASKED, over everything this database retains.
  // The same LIVE scoping the §0 prechecks use: rows that no longer assert a
  // delegation are append-only history the migration tolerates by design (the
  // tuple key is NOT VALID over them), so counting them here would fail the
  // drill over 057 §5's own documented supersession outcome.
  const invariants: ReadonlyArray<[string, string]> = [
    [
      'every LIVE session actor is the approved requester',
      `SELECT COUNT(*)::int AS n FROM support_access_sessions s
        JOIN support_access_requests r ON r.request_id = s.request_id
       WHERE s.revoked_at IS NULL AND s.expired_at IS NULL
         AND s.expires_at > clock_timestamp()
         AND s.actor_user_link_id IS DISTINCT FROM r.requester_user_link_id`,
    ],
    [
      'every LIVE support requester and actor is a platform link',
      `SELECT COUNT(*)::int AS n FROM (
         SELECT 1 FROM support_access_requests r
           JOIN user_links ul ON ul.user_link_id = r.requester_user_link_id
          WHERE r.status IN ('pending', 'approved') AND ul.actor_scope <> 'platform'
         UNION ALL
         SELECT 1 FROM support_access_sessions s
           JOIN user_links ul ON ul.user_link_id = s.actor_user_link_id
          WHERE s.revoked_at IS NULL AND s.expired_at IS NULL
            AND s.expires_at > clock_timestamp()
            AND ul.actor_scope <> 'platform') x`,
    ],
    [
      'no LIVE session precedes its decision',
      `SELECT COUNT(*)::int AS n FROM support_access_sessions s
        JOIN support_access_requests r ON r.request_id = s.request_id
       WHERE s.revoked_at IS NULL AND s.expired_at IS NULL
         AND s.expires_at > clock_timestamp()
         AND (r.decided_at IS NULL OR s.granted_at < r.decided_at)`,
    ],
    [
      'no LIVE session outlives its requested duration',
      `SELECT COUNT(*)::int AS n FROM support_access_sessions s
        JOIN support_access_requests r ON r.request_id = s.request_id
       WHERE s.revoked_at IS NULL AND s.expired_at IS NULL
         AND s.expires_at > clock_timestamp()
         AND s.expires_at > s.granted_at + make_interval(mins => r.requested_duration_minutes)`,
    ],
    [
      'every STANDING approval grant is the approval it claims',
      `SELECT COUNT(*)::int AS n FROM support_access_requests r
        JOIN reauthentication_grants g ON g.grant_id = r.approval_grant_id
       WHERE r.status = 'approved' AND r.approval_grant_id IS NOT NULL
         AND (g.action <> 'identity.support.approve'
              OR g.resource_type IS DISTINCT FROM 'support_access_request'
              OR g.resource_id IS DISTINCT FROM r.request_id
              OR g.assurance_level <> 'fresh_and_mfa_policy'
              OR g.mfa_policy_certified_at_issue IS DISTINCT FROM true)`,
    ],
  ];
  for (const [label, sql] of invariants) {
    const n = await scalar(sql);
    if (n !== 0) fail(`${phase}: ${n} retained row(s) violate: ${label}`);
    else console.log(`${phase}-invariant-holds=${JSON.stringify(label)}`);
  }

  // (4) THE WRITTEN RECORD.
  const versions = (
    await query(
      `SELECT evidence_version::int AS v, COUNT(*)::int AS n
         FROM policy_decisions GROUP BY evidence_version ORDER BY evidence_version`,
    )
  ).rows as Array<{ v: number; n: number }>;
  const byVersion = new Map(versions.map((r) => [Number(r.v), Number(r.n)]));
  evidence.decisions_by_evidence_version = Object.fromEntries(byVersion);
  for (const wanted of [2, 3, 4]) {
    if ((byVersion.get(wanted) ?? 0) < 1)
      fail(
        `${phase}: no decision at evidence_version ${wanted} — the drill must retain each ` +
          'era’s rows and the current writer must have written the current version',
      );
  }
  for (const [v] of byVersion) {
    if (v < 1 || v > 4) fail(`${phase}: a decision claims unknown evidence_version ${v}`);
  }
  console.log(`${phase}-versions=${JSON.stringify(Object.fromEntries(byVersion))}`);

  const columnDefault = (
    await query(
      `SELECT pg_get_expr(ad.adbin, ad.adrelid) AS d
         FROM pg_attrdef ad
         JOIN pg_attribute a ON a.attrelid = ad.adrelid AND a.attnum = ad.adnum
        WHERE ad.adrelid = 'policy_decisions'::regclass AND a.attname = 'evidence_version'`,
    )
  ).rows[0] as { d: string } | undefined;
  if (columnDefault?.d !== '4')
    fail(
      `${phase}: evidence_version DEFAULT is ${JSON.stringify(columnDefault?.d)}, not 4 — the ` +
        'schema, not the writer, owns what "current" means',
    );
  else console.log(`${phase}-evidence-default=4`);

  // One live refusal, on THIS database: a dealership link filing a delegation.
  const dealershipLink = (
    await query(
      `SELECT user_link_id::text AS id, tenant_id::text AS tenant FROM user_links
        WHERE actor_scope = 'dealership' AND status = 'activated' AND tenant_id IS NOT NULL
        ORDER BY user_link_id LIMIT 1`,
    )
  ).rows[0] as { id: string; tenant: string } | undefined;
  if (dealershipLink === undefined) {
    fail(`${phase}: no activated dealership link to probe the §3.1 requester rule with`);
    return;
  }
  const refused = await probeRefusal(
    `INSERT INTO support_access_requests
       (tenant_id, requester_user_link_id, requested_actions, scope_level, scope_id,
        reason, requested_duration_minutes)
     VALUES ($1, $2, ARRAY['service.ro.view'], 'tenant', NULL, 'post-059 phase probe', 30)`,
    [dealershipLink.tenant, dealershipLink.id],
  );
  if (refused === null)
    fail(
      `${phase}: this database ACCEPTED a support request filed by a dealership link — ` +
        'the §3.1 requester rule is not in force where the drill ends',
    );
  else if (!refused.includes('a dealership link cannot request it'))
    fail(`${phase}: the requester-rule refusal carries the wrong words: ${refused}`);
  else console.log(`${phase}-requester-rule=refuses-dealership-links`);
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
      fail(`${phase}: --before <earlier census json> is required so counts can be compared`);
    } else {
      const { readFileSync } = await import('fs');
      const parsed = JSON.parse(readFileSync(before, 'utf8')) as {
        identity_counts?: Record<string, number>;
      };
      const beforeCounts = parsed.identity_counts;
      if (beforeCounts === undefined) fail(`${phase}: ${before} carries no identity_counts`);
      else {
        evidence.identity_counts_before = beforeCounts;
        assertCountsPreserved(phase, beforeCounts, counts);
      }
    }
    await assertReconciledState(phase);
    // The floor 057 installs is 2; 058 raises it to 3 (R6-R6 §D1); 059 raises it
    // to 4 (R7 §4). The phase says which one this database is supposed to be at,
    // so a floor that failed to move and a floor that moved too early are both
    // failures rather than both passes.
    await assertEvidenceVersionFloor(
      phase,
      phase === 'post-059' ? 4 : phase === 'post-058' ? 3 : 2,
    );
    if (GROWTH_PHASES.includes(phase)) {
      await assertNormalizedEvidenceIsEquivalent(phase);
      await assertAuthTimeExemptionAndBinding(phase);
      await assertSupersededVersionHistorySurvived(phase);
    }
    if (phase === 'post-059') {
      await assertIntegrityClosureState(phase);
    }
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
