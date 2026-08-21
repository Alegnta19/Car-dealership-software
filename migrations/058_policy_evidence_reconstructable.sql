-- ============================================================
-- 058_policy_evidence_reconstructable.sql — FBL-020-R6 §3.
--
-- Governing document: ARCHITECT ORDER FBL-020-R6, section 3 —
-- "database-reconstructable evidence". The order text is checked in at
-- `docs/orders/FBL-020-R6.md`.
--
-- WHY THIS IS AN 058 AND NOT AN EDIT TO 057. R6 §1.3 permits editing 057 in
-- place ONLY where a COMPLETE census proves that no persistent environment has
-- applied any form of it. The operator-machine census
-- (`docs/evidence/FBL-020-R6-operator-environment-census.json`) could not
-- establish the DISPOSABILITY of most of the clusters it enumerated, and it
-- counts every one of those with the persistent environments rather than
-- assuming they are somebody's scratch directories. That is what makes the
-- census INCOMPLETE, and an incomplete census cannot prove a negative.
-- `conclusion.position` is `FREEZE_057_AND_ADD_058`, and the artifact's
-- `permits_editing_057_in_place` is false while `requires_058` is true.
--
-- NO COUNT IS QUOTED HERE, AND THAT IS DELIBERATE (R6-R6 finding D8). The
-- artifact says so itself, in `counts_are_point_in_time`: this machine creates
-- and destroys scratch PostgreSQL clusters as a matter of course, so the number
-- of directories the sweep enumerates changes between runs and is not a
-- measurement of anything. The DURABLE claim is `conclusion.position`, and the
-- figure that supports it is `totals.persistence_indeterminate` — the count of
-- clusters whose DISPOSABILITY could not be established, which is NOT the same
-- thing as environments found to hold 057. A migration header that retyped
-- either number would go stale the next time anybody ran the suite, and a stale
-- number beside a committed artifact is a figure published at two values. The
-- delivery report publishes both inside marked spans, where
-- `scripts/check-published-figures.ts` derives them from the artifact.
--
-- WHAT THE CENSUS SAYS ABOUT POSITIVE HITS, STATED EXACTLY, BECAUSE TWO EARLIER
-- DRAFTS OF THIS HEADER GOT IT WRONG IN OPPOSITE DIRECTIONS.
-- `conclusion.persistent_environments_with_057` is NOT empty. It names ONE
-- environment: `local-disposable-cluster-55434`, this machine's own drill
-- cluster on 127.0.0.1:55434, which the classifier records as
-- `persistence: indeterminate` and therefore counts with the persistent ones.
-- IT COULD NOT BE CLASSIFIED FOR THE REASON THE ARTIFACT RECORDS AS
-- `disposability.basis`, AND AN EARLIER DRAFT OF THIS SENTENCE ATTRIBUTED THE
-- VERDICT TO SOMETHING ELSE. That draft said a STALE postmaster.pid under an
-- earlier wave's data directory still named that port, so the recorded launch
-- and the running server disagreed about which directory was authoritative. THE
-- CORRECTION TO THAT DRAFT SAID THE ARTIFACT "SAYS NOTHING OF THE KIND", AND
-- THAT WAS FALSE. The artifact records the disagreement in this environment's
-- own evidence rows: `data directory (the postmaster.pid of a RUNNING server on
-- this port)` reads C:\Users\alegn\AppData\Local\Temp\fbl020r5-pg, `data
-- directory as the RUNNING server reports it (SHOW data_directory)` reads
-- C:/Users/alegn/AppData/Local/Temp/fbl020r6-pg-main, and `postmaster.pid and
-- the running server agree on the data directory` reads false. What the
-- withdrawn draft got wrong is narrower: that disagreement is not what the
-- verdict rests on. The recorded `disposability.basis` is that ONE database in
-- that cluster, `cockpit_upgrade_test`, matches no pattern this repository
-- declares disposable, and that the recorded launch does not disable durability
-- either, so neither content proof holds. The disagreement is how the cluster
-- was located; the content is what decides the verdict.
-- `architecture/disposable-cluster-policy.json` is fail-closed: an input it
-- cannot resolve is `indeterminate`, never `disposable`.
--
-- A PREVIOUS REVISION OF THIS PARAGRAPH SAID THAT SET WAS EMPTY and that the
-- branch turned only on the census's INCOMPLETENESS. That was true of the
-- artifact as it then stood and is FALSE of the one committed beside this file,
-- which was re-taken because its provenance no longer described the tree citing
-- it (the R6-R6 gate's finding D8). Two further clusters — earlier waves' drill
-- directories — are listed under `conclusion.disposable_or_ephemeral_with_057`
-- and are classified `disposable` on their own evidence.
--
-- NEITHER READING PERMITS EDITING 057. The incompleteness alone already forbade
-- it; a positive hit in a cluster counted as persistent forbids it more
-- directly. This file exists under both.
--
-- MIGRATION 057 IS FROZEN, as are 000 and 049–056: nothing here edits, renames,
-- reorders or recomputes any of them. Every R6 §3 schema change lands in this
-- file.
--
-- WHAT R5 LEFT STANDING, MEASURED RATHER THAN ARGUED. Section 11 of 057 made
-- policy evidence RELATIONAL: ids must resolve, and they must resolve TOGETHER.
-- R6 §3 says what that still did not reach, and each of the four is a case where
-- a row can be written that is internally consistent and describes an
-- authorization that never happened:
--
--   * §3.1 `auth_time` was merely non-null. It is a free-standing timestamp: any
--     instant at all could be recorded beside a real, live, correctly cross-wired
--     session, and nothing compared the two. The evidence then says "this actor
--     had authenticated at 04:00" about a session that authenticated at 11:20.
--   * §3.2 the normalized matched-binding rows were said to have "exactly one
--     writer". They did not. A direct INSERT by the SAME actor satisfied both
--     composite keys, so the child rows could carry an EXTRA binding the parent
--     array never claimed, or repeat an ordinality, and the two records of one
--     fact could disagree.
--   * §3.3 the version rule was one-sided (`> reached` refused, everything else
--     accepted), so ANY historical version was admissible — including version 1
--     of a binding that has since been revoked and re-scoped. And the binding's
--     own EFFECTIVENESS was not consulted at all: a revoked binding, a binding
--     outside its effective window, a binding belonging to another tenant, a
--     binding whose scope cannot reach the decision and — the R6 gate's finding
--     C7 — a binding at a SIBLING organization node or BENEATH the node the
--     decision records were all accepted as authority.
--   * §3.4 a platform-support ALLOW into a tenant could omit delegated-support
--     evidence entirely and satisfy `pd_v2_allow_has_authority_evidence` with a
--     role binding. Where support evidence WAS supplied, 057 tied its session,
--     request, tenant, actor and window together — but tied none of them to the
--     APPROVAL: an unapproved request, an action nobody approved, a scope nobody
--     granted, a revoked session and a decision taken outside the window were all
--     representable.
--
-- ── WHAT THIS FILE DOES TO ROWS THAT ALREADY EXIST ──────────────────────────
--
-- An earlier draft of this header claimed that "no existing row can reach" any
-- new rule here. That was FALSE, and the R6 gate's finding C8 said so. The
-- truthful statement is this list, and it is exhaustive:
--
--   1. SECTION 0 WRITES ROWS. It derives the normalized child rows that 057
--      never backfilled, from the arrays the retained decisions already carry.
--      That is an INSERT into a table whose append-only trigger forbids UPDATE
--      and DELETE, so it adds the missing record of a fact rather than altering
--      one. NOTHING in this file edits or deletes an evidence row, here or
--      anywhere else.
--   2. `uq_pdmb_ordinality` is a UNIQUE INDEX and is therefore BUILT OVER THE
--      EXISTING ROWS. A pre-check counts the duplicates first so the failure is
--      a named refusal rather than an index build error.
--   3. `pd_v2_support_tenant_allow_is_delegated` is a CHECK and is therefore
--      VALIDATED AGAINST THE EXISTING ROWS. It is written `evidence_version < 2
--      OR …` so version-1 history is exempt by construction, and a pre-check
--      counts the version-2 violations first for the same reason.
--   4. `pd_evidence_version_known` is DROPPED AND RE-ADDED as `IN (1, 2, 3)`, so
--      the new CHECK is VALIDATED AGAINST THE EXISTING ROWS. It cannot fail: the
--      constraint it replaces already restricted the column to 1 or 2, and the
--      replacement admits both. Section 1 says why the third version exists and
--      why 057's constraint has to be replaced rather than added to.
--   5. The five TRIGGERS this file creates are BEFORE or AFTER INSERT, and so are
--      the two 057 trigger FUNCTIONS it replaces in place (the matched-binding
--      normalizer and the evidence-version floor). Those, and only those, cannot
--      reach a row that is already stored. `ALTER COLUMN … SET DEFAULT` is a
--      catalog change and rewrites nothing.
--
-- ── RECONCILIATION PRECEDES CONSTRAINTS, AND IN THIS FILE IT IS A REAL
--    RECONCILIATION ───────────────────────────────────────────────────────────
--
-- The R6 gate's finding C1: 057 installed the normalizer as an AFTER INSERT
-- trigger and never backfilled, so on any database that had recorded a real
-- ALLOW — an ALLOW carries a NON-EMPTY `matched_role_binding_ids` — the
-- normalized table was EMPTY for every historic decision. The §3.2 equivalence
-- pre-check therefore RAISED on the first real ALLOW it met, and told the
-- operator to "adjudicate" rows that two append-only triggers forbid them to
-- touch. That is reconciliation-before-constraints violated, in the migration
-- written to enforce reconstructability.
--
-- Section 0 fixes it the way 055–057 fix this class: it DERIVES the missing
-- rows, in ordinality order, from the arrays the decisions already carry, so
-- equivalence becomes TRUE rather than asserted. Where an array genuinely
-- cannot be normalized — it names a binding that no longer exists, or one held
-- by somebody other than the decision's own actor, or a version the binding has
-- never reached — the rows are left EXACTLY as written, at `evidence_version` 1,
-- and the equivalence rule exempts them BY VERSION. That discriminator is 057
-- §6's own tool for exactly this: history stays legal at the version whose
-- requirements it actually met.
-- ============================================================

-- ──────────────────────────────────────────────────────────────
-- Section 0 — R6 §3.2, FIRST HALF: THE NORMALIZED ROWS THE HISTORY NEVER GOT
--
-- 057 §11e derives `policy_decision_matched_bindings` from
-- `policy_decisions.matched_role_binding_ids` in an AFTER INSERT trigger. A
-- trigger reaches the rows written after it exists and no others, so every
-- decision recorded before 057 has a matched-binding array and NO normalized
-- rows. Both records are append-only; the array cannot be emptied and the child
-- rows cannot be edited into place later. The only honest repair is to WRITE THE
-- DERIVED ROWS, which is what this section does, and it must happen before any
-- rule in this file compares the two.
--
-- ALL-OR-NOTHING PER DECISION, and that is the point. A decision whose array
-- names three bindings and whose second binding no longer exists cannot be
-- half-normalized: two child rows would read as "two bindings matched", which is
-- a DIFFERENT and FALSE claim. So a decision is reconciled completely or not at
-- all.
--
-- THE FOUR CONDITIONS A HISTORIC ARRAY MUST MEET, each of them a rule the child
-- table already enforces and none of them invented here:
--
--   * the decision names an actor (`actor_user_link_id` is NOT NULL on the child
--     table, and `pdmb_decision_names_this_actor` keys the pair);
--   * every binding it names EXISTS and is held by THAT actor
--     (`pdmb_binding_belongs_to_the_actor`);
--   * every recorded version is at least 1 (`pdmb_version_positive`) and is a
--     version the binding has actually reached (057's
--     `trg_pdmb_version_reachable`, which is live while this runs);
--   * no binding is named twice (the primary key).
--
-- WHICH OF THOSE CAN ACTUALLY FAIL BY THE TIME THIS RUNS, because saying "the
-- residue" without saying what is in it is how a branch goes untested. ALL FOUR
-- CAN, AND AN EARLIER DRAFT OF THIS PARAGRAPH SAID OTHERWISE — the R6-R6 gate's
-- finding D3. What it said was that 057 §11a already refuses to migrate a
-- database whose arrays name an absent binding, so "a binding it names no longer
-- exists" is a case 058 will never meet. The first half is true and the
-- conclusion does not follow, because 057 §11a is a statement about the instant
-- 057 RAN and 058 runs later:
--
--   * `role_bindings` is NOT append-only — only `policy_decisions` and
--     `policy_decision_matched_bindings` are — so a binding row can be deleted
--     after 057 has finished.
--   * The composite foreign key `pdmb_binding_belongs_to_the_actor` protects a
--     binding a NORMALIZED row names. It cannot protect one that is named only by
--     a pre-057 ARRAY, because that is precisely the row 057 never backfilled:
--     the C1 defect is what leaves those bindings unreferenced and deletable.
--
-- SO THE CASE REACHES THIS SECTION, and the code below handles it: the LEFT
-- JOIN's `rb.role_binding_id IS NULL` puts such a decision in the residue rather
-- than half-normalizing it, and the disclosure below names WHICH residue class
-- each decision fell into, so an operator is told "the binding is gone" rather
-- than being left to infer it from a total.
--
-- HOW FAR THAT IS PROVED, STATED EXACTLY, BECAUSE AN EARLIER DRAFT OVERSTATED IT
-- (the R6-R6 gate's finding D9). This paragraph used to read "MEASURED, NOT
-- ARGUED" and cite a one-off experiment on a drill database — deleting the
-- binding named by a retained decision and observing three residue decisions
-- instead of two. NOTHING IN THIS REPOSITORY RE-RUNS THAT, so it was a
-- measurement no reader could reproduce and no gate would notice going stale,
-- which is the same fabricated-citation shape this chain has been rejected for.
-- The citation is withdrawn rather than restated.
--
-- WHAT IS ACTUALLY PROVED, and by what: the RESIDUE PATH itself is exercised on
-- every drill run, because the retained fixture carries the VERSION shape and
-- `scripts/verify-upgrade-state.ts --phase=post-057` asserts the derived set and
-- the residue exactly — which decisions were normalized, at which ordinality,
-- from which binding at which version, and that the unreconciled rows survived
-- byte-for-byte at `evidence_version` 1. The absent-binding shape takes the SAME
-- branch by construction (one LEFT JOIN, one `IS NULL` test, no separate code),
-- and that shape is NOT separately covered by a committed control. It is recorded
-- as such in `docs/identity/KNOWN-LIMITATIONS.md` rather than presented as a
-- measurement.
--
-- So the residue has three shapes, not one: an array naming a binding that no
-- longer exists or was never the decision's actor's; a recorded VERSION the
-- binding has never reached or that is below 1; and the same binding named twice
-- in one array. The retained fixture carries the version case.
--
-- WHAT IS DELIBERATELY *NOT* A CONDITION. Whether the binding is still active,
-- still inside its window, or still able to reach the decision's scope is NOT
-- asked here. Those are §3.3's rules for what may be WRITTEN NOW, and applying
-- them to history would be re-judging a decision by a rule that did not exist
-- when it was taken — which is the falsification this whole chain refuses. The
-- new §3.3 trigger is created AFTER this section for that reason, so the
-- backfill is not subject to it.
--
-- THE RESIDUE IS DISCLOSED, NOT HIDDEN, AND BY CLASS. A version-1 decision that
-- could not be normalized keeps its array, holds no child rows, and is
-- identifiable by exactly that: `evidence_version < 2 AND
-- cardinality(matched_role_binding_ids) > 0 AND no rows in
-- policy_decision_matched_bindings`. That is the discriminator the §3.2
-- equivalence pre-check exempts, and `scripts/verify-upgrade-state.ts
-- --phase=post-057` asserts the exact count of it on the populated drill. The
-- NOTICE below additionally splits the residue into the three shapes above, so
-- "two decisions could not be normalized" is never all an operator is told.
-- ──────────────────────────────────────────────────────────────

DO $$
DECLARE unnormalized_v2 INTEGER;
BEGIN
  -- A decision at version 2 OR ABOVE is normalized BY CONSTRUCTION: the
  -- normalizer runs in the same statement that writes it, inside the same
  -- transaction, so a rejected child row takes the whole decision with it. One
  -- that carries an array and no child rows is therefore not history — it is
  -- damage, and this migration may not paper over it by backfilling something
  -- that should already have been there. `>= 2` rather than `= 2` so the rule
  -- keeps holding as the version advances; Section 1 introduces version 3.
  SELECT COUNT(*) INTO unnormalized_v2
    FROM policy_decisions d
   WHERE d.evidence_version >= 2
     AND cardinality(d.matched_role_binding_ids) > 0
     AND NOT EXISTS (SELECT 1 FROM policy_decision_matched_bindings c
                      WHERE c.decision_id = d.decision_id);
  IF unnormalized_v2 > 0 THEN
    RAISE EXCEPTION 'FBL-020-R6 §3.2 refused: % decision(s) at evidence_version 2 or above carry '
                    'a matched-binding array with NO normalized rows beside it. Evidence at those '
                    'versions is normalized in the statement that writes it, so this is not '
                    'retained history and this migration will not manufacture the missing rows '
                    'for it', unnormalized_v2;
  END IF;
END $$;

-- The backfill itself, as a PLAIN STATEMENT rather than inside a `DO` block, and
-- that is not a formatting choice. `scripts/check-owned-mutations.ts` derives the
-- set of version-carrying tables from the migrations, and it resolves an
-- unqualified mention of the version column inside an INSERT's own column list to
-- the table that INSERT names — which is exact. Inside a `DO` block it can only
-- resolve table names quoted in an `ARRAY[…]` literal (migration 056's shape), so
-- the same statement there would be a mention the guard cannot attribute, and the
-- guard FAILS CLOSED on those rather than skipping them. Written here, the write
-- is attributed to `policy_decision_matched_bindings` by the parser and by a
-- reader alike.
WITH reconcilable AS (
  SELECT d.decision_id
    FROM policy_decisions d
   WHERE cardinality(d.matched_role_binding_ids) > 0
     AND d.actor_user_link_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM policy_decision_matched_bindings c
                      WHERE c.decision_id = d.decision_id)
     AND cardinality(d.matched_authorization_versions)
           = cardinality(d.matched_role_binding_ids)
     AND (SELECT COUNT(DISTINCT e) FROM unnest(d.matched_role_binding_ids) AS e)
           = cardinality(d.matched_role_binding_ids)
     AND NOT EXISTS (
           SELECT 1
             FROM unnest(d.matched_role_binding_ids) WITH ORDINALITY AS m(id, ord)
             LEFT JOIN role_bindings rb
               ON rb.role_binding_id = m.id
              AND rb.user_link_id = d.actor_user_link_id
            WHERE rb.role_binding_id IS NULL
               OR d.matched_authorization_versions[m.ord] IS NULL
               OR d.matched_authorization_versions[m.ord] < 1
               OR d.matched_authorization_versions[m.ord] > rb.authorization_version)
)
INSERT INTO policy_decision_matched_bindings
  (decision_id, role_binding_id, actor_user_link_id, authorization_version, match_ordinality)
SELECT d.decision_id, m.id, d.actor_user_link_id,
       d.matched_authorization_versions[m.ord], m.ord
  FROM reconcilable r
  JOIN policy_decisions d ON d.decision_id = r.decision_id
  CROSS JOIN LATERAL unnest(d.matched_role_binding_ids) WITH ORDINALITY AS m(id, ord);

DO $$
DECLARE reconciled INTEGER;
        residue    INTEGER;
        absent     INTEGER;
        unreached  INTEGER;
        repeated   INTEGER;
BEGIN
  SELECT COUNT(*) INTO reconciled FROM policy_decision_matched_bindings;
  SELECT COUNT(*) INTO residue
    FROM policy_decisions d
   WHERE cardinality(d.matched_role_binding_ids) > 0
     AND NOT EXISTS (SELECT 1 FROM policy_decision_matched_bindings c
                      WHERE c.decision_id = d.decision_id);

  -- THE RESIDUE, BY CLASS (R6-R6 finding D3). A single total leaves the operator
  -- to guess which of three different problems they have, and one of the three —
  -- "the binding is simply gone" — was the case this file used to say could never
  -- arrive. The classes are counted with the SAME predicates the CTE above
  -- filtered on, so a decision counted here is a decision that really was left
  -- out for that reason. They are not disjoint by construction (one array can
  -- carry two faults), so the classes are reported as counts of decisions
  -- EXHIBITING each shape rather than as a partition summing to the total.
  SELECT COUNT(*) INTO absent
    FROM policy_decisions d
   WHERE cardinality(d.matched_role_binding_ids) > 0
     AND NOT EXISTS (SELECT 1 FROM policy_decision_matched_bindings c
                      WHERE c.decision_id = d.decision_id)
     AND (d.actor_user_link_id IS NULL
          OR EXISTS (SELECT 1 FROM unnest(d.matched_role_binding_ids) AS m(id)
                      WHERE NOT EXISTS (SELECT 1 FROM role_bindings rb
                                         WHERE rb.role_binding_id = m.id
                                           AND rb.user_link_id = d.actor_user_link_id)));
  SELECT COUNT(*) INTO unreached
    FROM policy_decisions d
   WHERE cardinality(d.matched_role_binding_ids) > 0
     AND NOT EXISTS (SELECT 1 FROM policy_decision_matched_bindings c
                      WHERE c.decision_id = d.decision_id)
     AND (cardinality(d.matched_authorization_versions)
            <> cardinality(d.matched_role_binding_ids)
          OR EXISTS (
               SELECT 1
                 FROM unnest(d.matched_role_binding_ids) WITH ORDINALITY AS m(id, ord)
                 JOIN role_bindings rb ON rb.role_binding_id = m.id
                WHERE d.matched_authorization_versions[m.ord] IS NULL
                   OR d.matched_authorization_versions[m.ord] < 1
                   OR d.matched_authorization_versions[m.ord] > rb.authorization_version));
  SELECT COUNT(*) INTO repeated
    FROM policy_decisions d
   WHERE cardinality(d.matched_role_binding_ids) > 0
     AND NOT EXISTS (SELECT 1 FROM policy_decision_matched_bindings c
                      WHERE c.decision_id = d.decision_id)
     AND (SELECT COUNT(DISTINCT e) FROM unnest(d.matched_role_binding_ids) AS e)
           <> cardinality(d.matched_role_binding_ids);

  RAISE NOTICE 'FBL-020-R6 §3.2 reconciliation: % normalized authority row(s) now stand beside '
               'the retained decision arrays; % retained decision(s) name authority that can no '
               'longer be normalized and are left exactly as written at evidence_version 1 '
               '(% name a binding that no longer exists or was never the decision actor''s, '
               '% record a version the binding has never reached or below 1, '
               '% name one binding twice)',
               reconciled, residue, absent, unreached, repeated;
END $$;

-- ──────────────────────────────────────────────────────────────
-- Section 1 — R6 §3.1: THE RECORDED AUTHENTICATION TIME IS THE NAMED
-- SESSION'S AUTHENTICATION TIME
--
-- 057 §6 required `auth_time` to be PRESENT on a version-2 credential group and
-- §11d required the session, actor, connection and provider subject to describe
-- ONE session. `auth_time` was left out of that key, so it stayed exactly what
-- R6 §3.1 calls it: an arbitrary instant sitting next to a coherent credential.
--
-- WHY IT IS NOT ADDED TO THE COMPOSITE KEY. `pd_credential_identity_tuple` could
-- carry a fifth column, and it must not: PostgreSQL keeps `timestamptz` to the
-- microsecond and a JavaScript `Date` keeps milliseconds, so a value that had
-- round-tripped through the application would be a DIFFERENT instant and the key
-- would refuse every genuine allow. This is the same problem 057 §11 solved for
-- the support window, and it is solved the same way, for the same reason: the
-- rule is an exact comparison against the row the decision itself names, and
-- `record()` in `packages/identity-access/src/policy.ts` now reads the value out
-- of that session INSIDE the INSERT rather than sending one back. The comparison
-- is therefore between the column and itself, and it closes the read-then-write
-- race as a side effect — a refresh that advances a session's `auth_time`
-- between the credential read and the evidence write can no longer make the
-- evidence disagree with the session.
--
-- ── WHY THIS RULE IS A NEW EVIDENCE VERSION AND NOT A PRE-CHECK OVER HISTORY ──
--
-- An earlier draft of this section asserted: "No code path in this repository
-- ever UPDATEs `identity_sessions.auth_time`, so a version-2 row cannot drift
-- away from its session either; a non-zero count here means a session's
-- authentication instant was edited by hand." THAT WAS FALSE, and it is the R6-R6
-- gate's finding D1 — the third appearance of one defect class in this chain: a
-- rule that RAISES on rows written before the rule existed.
--
-- THE MEASUREMENT THAT REPLACES IT. `packages/identity-access/src/session.ts`
-- advances `identity_sessions.auth_time` BY DESIGN, on provider
-- re-authentication:
--
--   * the private rotation write (`rotateRefreshStateRow`) carries `auth_time =
--     $4` in its SET list;
--   * `refreshProviderSession` computes that argument as the LATER of the stored
--     instant and a verified token's own `auth_time`, so a genuinely newer
--     authentication moves the column forward;
--   * and the documented contract above it says exactly that — "only a verified
--     token carrying a genuinely newer auth_time moves it forward".
--
-- One ordinary version-2 ALLOW plus one provider re-authentication is therefore
-- enough to make the old pre-check refuse, and `UPDATE` and `DELETE` on
-- `policy_decisions` are both refused as append-only, so the operator was told to
-- "adjudicate" rows nothing could touch. Reproduced from shipped code alone; the
-- drill now performs it (`scripts/upgrade-post-057-activity.ts`).
--
-- A DECISION WHOSE SESSION HAS SINCE RE-AUTHENTICATED IS NOT CORRUPT EVIDENCE. It
-- correctly records the instant that WAS true when the decision was made, which
-- is precisely what an audit trail is for. The session moved on afterwards; the
-- evidence did not, and must not. So the rule attaches to NEW decisions only, and
-- the instrument is the one 057 §6 already built for exactly this — the
-- evidence-version discriminator:
--
--   * 058 introduces `evidence_version` 3, which means "complete evidence,
--     INCLUDING an authentication instant bound exactly to the named session".
--   * The pre-check below counts only version-3 rows. Before this migration,
--     `pd_evidence_version_known CHECK (evidence_version IN (1, 2))` makes a
--     version-3 row UNREPRESENTABLE, so the count is zero by a CHECK CONSTRAINT
--     rather than by anybody's reasoning about code. It is retained rather than
--     deleted because it is the guard that fires if that constraint was dropped
--     by hand before 058 ran.
--   * The floor trigger 057 installed is REPLACED, not supplemented, so the floor
--     becomes 3. Without that a writer could keep claiming version 2 and inherit
--     the historic exemption for ever — 057's own words about version 1, and the
--     same reasoning one version up. It is the FUNCTION that is replaced and not
--     the trigger, so `scripts/upgrade-negative-controls.ts`'s
--     `pd_evidence_version_floor` control still removes the floor entirely by
--     deleting 057's `CREATE TRIGGER`, and still fails the job if it does not.
--   * 057's `pd_evidence_version_known` has to be DROPPED and re-added because it
--     enumerates the legal versions and 3 is not among them. 057 is FROZEN as a
--     FILE; a later migration replacing a constraint it created is ordinary
--     forward migration, and this file already replaces two of 057's trigger
--     functions the same way.
--
-- WHAT IS EXEMPT, AND WHAT IS NOT. Version-1 and version-2 decisions keep their
-- recorded `auth_time` exactly as written and are never compared against their
-- session's current one. Every version-3 decision is compared, on the way in, by
-- the trigger below — and since the floor is 3, every NEW decision is a version-3
-- decision. The trigger itself is NOT version-gated: it fires on INSERT, so it
-- cannot reach a stored row at all, and gating it as well would add a predicate
-- no test could kill.
--
-- THE EXEMPTION IS DISCLOSED, NOT SILENT. The NOTICE below reports how many
-- retained decisions record an authentication time that is no longer their
-- session's — the exact population the old pre-check would have aborted on — so
-- an operator applying this file with `psql` is told the size of the history the
-- migration is choosing to leave alone.
--
-- WHAT THE NOTICE DOES NOT REACH, said here rather than left to be discovered:
-- `scripts/migrate.ts` does not install a `notice` handler, so a run through the
-- MIGRATION RUNNER does not print it. The figure is therefore also ASSERTED
-- rather than merely printed: `scripts/verify-upgrade-state.ts --phase=post-058`
-- recomputes it, publishes it as `auth_time_exempt_decisions`, and FAILS if it is
-- zero — because a zero there means 058 was applied to a database on which §3.1
-- had nothing to tolerate, which is the "green for nothing" shape this whole
-- finding is about. On the drill it reads 2.
-- ──────────────────────────────────────────────────────────────

DO $$
DECLARE bad     INTEGER;
        exempt  INTEGER;
BEGIN
  SELECT COUNT(*) INTO bad
    FROM policy_decisions d
   WHERE d.evidence_version >= 3
     AND d.session_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM identity_sessions s WHERE s.session_id = d.session_id)
     AND NOT EXISTS (
       SELECT 1 FROM identity_sessions s
        WHERE s.session_id = d.session_id AND s.auth_time = d.auth_time);
  IF bad > 0 THEN
    RAISE EXCEPTION 'FBL-020-R6 §3.1 refused: % stored decision(s) already claim evidence_version '
                    '3 — the version this migration introduces — and record an authentication '
                    'time that is not the authentication time of the session they name. Version 3 '
                    'is unrepresentable until this migration runs, so the version constraint was '
                    'removed by hand; this ledger is append-only and there is no honest repair, so '
                    'the rows must be adjudicated before this migration runs', bad;
  END IF;

  -- The population the FALSE pre-check used to abort on, now disclosed instead.
  SELECT COUNT(*) INTO exempt
    FROM policy_decisions d
   WHERE d.evidence_version < 3
     AND d.session_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM identity_sessions s WHERE s.session_id = d.session_id)
     AND NOT EXISTS (
       SELECT 1 FROM identity_sessions s
        WHERE s.session_id = d.session_id AND s.auth_time = d.auth_time);
  RAISE NOTICE 'FBL-020-R6 §3.1 exemption: % retained decision(s) record an authentication time '
               'that is no longer their named session''s CURRENT one — a session that has since '
               're-authenticated. They are correct evidence of the instant that was true when the '
               'decision was taken, they are left exactly as written below evidence_version 3, and '
               'the exact-binding rule applies from version 3 onward', exempt;
END $$;

-- ── THE VERSION TRANSITION ────────────────────────────────────────────────────
ALTER TABLE policy_decisions DROP CONSTRAINT pd_evidence_version_known;
ALTER TABLE policy_decisions
  ADD CONSTRAINT pd_evidence_version_known CHECK (evidence_version IN (1, 2, 3));
ALTER TABLE policy_decisions ALTER COLUMN evidence_version SET DEFAULT 3;

-- The floor, one version up. 057's message shape is kept — the negative control
-- matches on the version it reports — and the minimum it names is now 3.
CREATE OR REPLACE FUNCTION policy_decisions_require_current_evidence() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.evidence_version < 3 THEN
    RAISE EXCEPTION
      'policy_decisions INSERT refused: evidence_version % is below the current minimum 3 '
      '(historic rows keep their version; new decisions must carry complete evidence, '
      'including an authentication instant bound exactly to the session they name)',
      NEW.evidence_version;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION policy_decisions_auth_time_is_the_sessions() RETURNS TRIGGER AS $$
DECLARE actual TIMESTAMPTZ;
BEGIN
  IF NEW.session_id IS NULL THEN RETURN NEW; END IF;
  SELECT s.auth_time INTO actual
    FROM identity_sessions s WHERE s.session_id = NEW.session_id;
  -- EXISTENCE IS THE FOREIGN KEY'S JOB, not this trigger's. `auth_time` is
  -- NOT NULL on `identity_sessions`, so a NULL here means the session is absent;
  -- returning quietly lets `pd_credential_identity_tuple` name the rule the row
  -- actually broke, exactly as `policy_decision_binding_version_is_reachable`
  -- does for a missing binding.
  IF actual IS NULL THEN RETURN NEW; END IF;
  IF NEW.auth_time IS DISTINCT FROM actual THEN
    RAISE EXCEPTION
      'policy_decisions INSERT refused: the recorded authentication time % is not the '
      'authentication time of session % (%)',
      NEW.auth_time, NEW.session_id, actual;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_policy_decisions_auth_time ON policy_decisions;
CREATE TRIGGER trg_policy_decisions_auth_time
  BEFORE INSERT ON policy_decisions
  FOR EACH ROW EXECUTE FUNCTION policy_decisions_auth_time_is_the_sessions();

-- ──────────────────────────────────────────────────────────────
-- Section 2 — R6 §3.3: A MATCHED BINDING MUST BE THE EXACT VERSION OBSERVED,
-- IN FORCE, IN THE DECISION'S TENANT, AND CAPABLE OF REACHING IT
--
-- 057 §11e installed `trg_pdmb_version_reachable`, which refuses a version the
-- binding has NEVER REACHED. That closes the future and leaves the past open:
-- version 1 of a binding now at version 7 was accepted, and versions 1–6 are
-- precisely the states the binding was moved OUT of — a re-scoped grant, a role
-- correction, a revocation. Evidence naming one of them claims authority from a
-- binding that no longer said what the evidence says it said.
--
-- THE TWO HALVES ARE IN TWO FILES ON PURPOSE. 057's trigger owns "not from the
-- future" and keeps its message; this one owns "not from the past", plus the
-- questions 057 never asked — effectiveness, tenant, resource identity, the
-- scope hierarchy, and (R6-R6 finding D4) whether the organization node the
-- decision records exists at all. Together they require the EXACT version. They
-- are separate triggers rather than a replaced function so that 057's control
-- stays intact and independently droppable, and so each half can be
-- mutation-killed on its own.
--
-- FIRING ORDER IS BY TRIGGER NAME, and it is chosen rather than inherited:
-- `trg_pdmb_authorized_writer` (§3.2 below) < `trg_pdmb_binding_is_applicable`
-- (here) < `trg_pdmb_version_reachable` (057).
--
-- WHY THE PRE-CHECK BELOW IS THE `>` HALF AND NOT THE `<` HALF. An earlier draft
-- counted stored rows whose version is BELOW the binding's current version and
-- refused the migration on any of them. That is the same defect as C1 one table
-- over: a decision records the version in force WHEN IT WAS TAKEN, and the
-- binding advances afterwards every time somebody is re-granted or revoked, so
-- the count is non-zero on any database that has been used. "Not from the past"
-- is a rule about what may be WRITTEN NOW and lives in the trigger, where no
-- existing row can reach it. What IS true of all history — versions only ever
-- advance, so nothing can name one the binding has never reached — is what the
-- pre-check asserts.
--
-- WHAT THIS TRIGGER DELIBERATELY DOES NOT DECIDE. When the binding does not
-- exist, does not belong to the decision's actor, or the decision does not name
-- that actor, it returns quietly: those are the composite foreign keys' rules
-- (`pdmb_binding_belongs_to_the_actor`, `pdmb_decision_names_this_actor`) and an
-- operator reading the error must learn which rule the row really broke. A
-- BEFORE trigger runs ahead of every foreign key, so a trigger that answered
-- those questions itself would silently take them over.
--
-- THE RACE, STATED. `decide()` reads its bindings, then `record()` opens a
-- transaction and writes. If a binding is revoked or re-versioned in between,
-- this refuses the evidence and the request fails. That is the correct
-- direction: the alternative is a stored ALLOW asserting a version and an
-- effectiveness the binding did not have when the row was written, which is the
-- exact class of unreconstructable evidence R6 §3 exists to remove.
-- ──────────────────────────────────────────────────────────────

DO $$
DECLARE bad INTEGER;
BEGIN
  SELECT COUNT(*) INTO bad
    FROM policy_decision_matched_bindings m
    JOIN role_bindings rb ON rb.role_binding_id = m.role_binding_id
   WHERE m.authorization_version > rb.authorization_version;
  IF bad > 0 THEN
    RAISE EXCEPTION 'FBL-020-R6 §3.3 refused: % retained authority claim(s) name a role-binding '
                    'version that binding has NEVER reached. Authorization versions only advance, '
                    'so this is fabricated rather than historic, and normalized evidence is '
                    'append-only — the rows must be adjudicated before this migration runs', bad;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION policy_decision_binding_is_applicable() RETURNS TRIGGER AS $$
DECLARE rb role_bindings%ROWTYPE;
        d  policy_decisions%ROWTYPE;
        dec_dealer_group UUID;
        dec_legal_entity UUID;
        dec_rooftop      UUID;
        dec_department   UUID;
BEGIN
  SELECT * INTO rb FROM role_bindings WHERE role_binding_id = NEW.role_binding_id;
  IF NOT FOUND OR rb.user_link_id IS DISTINCT FROM NEW.actor_user_link_id THEN
    RETURN NEW; -- pdmb_binding_belongs_to_the_actor
  END IF;
  SELECT * INTO d FROM policy_decisions
   WHERE decision_id = NEW.decision_id
     AND actor_user_link_id IS NOT DISTINCT FROM NEW.actor_user_link_id;
  IF NOT FOUND THEN
    RETURN NEW; -- pdmb_decision_names_this_actor
  END IF;

  -- (a) THE EXACT VERSION OBSERVED AT INSERTION.
  IF NEW.authorization_version < rb.authorization_version THEN
    RAISE EXCEPTION
      'policy evidence refused: matched binding % is recorded at authorization version %, '
      'but that binding is at version % — evidence must name the EXACT version the decision '
      'observed, and an older one describes a state the binding has been moved out of',
      NEW.role_binding_id, NEW.authorization_version, rb.authorization_version;
  END IF;

  -- (b) IN FORCE. `EFFECTIVE_ROLE_BINDING_SQL` in
  -- `packages/identity-access/src/policy.ts` is the predicate the engine loads
  -- bindings under; this is the same rule, applied where the evidence is
  -- written, so a revoked or windowed-out binding cannot be recorded as the
  -- authority for anything.
  IF rb.status <> 'active' THEN
    RAISE EXCEPTION
      'policy evidence refused: matched binding % is %, so it authorized nothing',
      NEW.role_binding_id, rb.status;
  END IF;
  IF rb.effective_from > NOW() OR (rb.effective_to IS NOT NULL AND rb.effective_to <= NOW()) THEN
    RAISE EXCEPTION
      'policy evidence refused: matched binding % is outside its effective window (% to %), '
      'so it authorized nothing at this instant',
      NEW.role_binding_id, rb.effective_from, rb.effective_to;
  END IF;

  -- (c) APPLICABLE TO WHAT THE DECISION RECORDS. `covers()` in the engine
  -- decides reach; these are the rules of it that can be re-checked from the
  -- stored row alone, and each of them is a rule the engine really applies.
  IF rb.scope_level = 'platform' THEN
    IF d.scope_level IS DISTINCT FROM 'platform' THEN
      RAISE EXCEPTION
        'policy evidence refused: matched binding % is platform-scope and never covers tenant '
        'data, but the decision it authorizes records scope %',
        NEW.role_binding_id, COALESCE(d.scope_level, '<none>');
    END IF;
  ELSE
    IF d.scope_level = 'platform' THEN
      RAISE EXCEPTION
        'policy evidence refused: matched binding % is %-scope and never reaches the control '
        'plane, but the decision it authorizes records platform scope',
        NEW.role_binding_id, rb.scope_level;
    END IF;
    IF rb.tenant_id IS DISTINCT FROM d.tenant_id THEN
      RAISE EXCEPTION
        'policy evidence refused: matched binding % belongs to tenant %, and the decision it '
        'authorizes was recorded in tenant %',
        NEW.role_binding_id, COALESCE(rb.tenant_id::text, '<none>'),
        COALESCE(d.tenant_id::text, '<none>');
    END IF;
    IF rb.scope_level = 'resource'
       AND (rb.resource_type IS DISTINCT FROM d.resource_type
            OR rb.resource_id IS DISTINCT FROM d.resource_id) THEN
      RAISE EXCEPTION
        'policy evidence refused: matched binding % names resource %:%, and the decision it '
        'authorizes acted on %:%',
        NEW.role_binding_id, COALESCE(rb.resource_type, '<none>'),
        COALESCE(rb.resource_id::text, '<none>'), COALESCE(d.resource_type, '<none>'),
        COALESCE(d.resource_id::text, '<none>');
    END IF;
    -- (c2) THE SCOPE HIERARCHY — the R6 gate's finding C7.
    --
    -- Being in the tenant was the whole of the reach test until this clause, so
    -- a binding scoped at ONE rooftop was accepted as the recorded authority for
    -- a SIBLING rooftop and for the WHOLE TENANT above it. Neither is something
    -- that binding ever authorized: `covers()` matches a binding only against
    -- nodes on the acted-on node's OWN ancestor chain, and `coversTenantWide`
    -- refuses a sub-tenant binding tenant-wide reach outright.
    --
    -- The chain in migration 055 is strict and single-parent — tenant →
    -- dealer_group → legal_entity → rooftop → department, each child carrying a
    -- composite (tenant_id, parent_id) foreign key — so "the decision's node, or
    -- something beneath it" is a bounded walk up that chain and not a second
    -- ancestry definition. EFFECTIVENESS is deliberately not re-derived here:
    -- `resolveAncestry` also requires every node in the chain to be inside its
    -- own window, and that IS a second authority definition. Existence and
    -- parentage are structural facts; effectiveness stays the engine's.
    --
    -- A DECISION RECORDING `resource` SCOPE IS NOT ADJUDICATED, and the reason is
    -- named rather than left to be discovered: mapping a resource id to an
    -- organization node is `resolveResourceScope`, which knows the Fixed Ops
    -- tables, and re-deriving it in this trigger is exactly the duplicate
    -- authority definition the paragraph above refuses. `rb.scope_level =
    -- 'resource'` is still checked exactly, above.
    -- (c2a) THE NODE THE DECISION RECORDS MUST EXIST AT ALL — the R6-R6 gate's
    -- finding D4, and the reason this resolution is HOISTED OUT of the branch
    -- below.
    --
    -- Until now the decision's own organization node was resolved only when the
    -- BINDING was organization-scoped, because only then was anything compared
    -- against it. So an ALLOW whose matched binding was TENANT-scope took the
    -- first branch, the resolution never ran, and the decision's `scope_level` /
    -- `scope_id` were never looked at: a version-2 ALLOW could record
    -- `rooftop:<a uuid that is a rooftop nowhere>` — not a sibling, not the tenant
    -- above, simply a node that does not exist — and every rule accepted it. A
    -- tenant binding really does cover every node in its tenant, so the C7
    -- hierarchy has nothing to object to; what was missing is that the recorded
    -- node be a NODE. `policy_decisions.scope_id` is polymorphic and can carry no
    -- foreign key (057 §11 says so and declines to pretend otherwise), which is
    -- exactly why the check has to be here.
    --
    -- The resolution is one query either way, so hoisting it costs nothing and the
    -- hierarchy comparison below now reads values that are already known to exist.
    -- A `resource`-scope decision is still NOT adjudicated, for the reason given
    -- above: mapping a resource id to an organization node is
    -- `resolveResourceScope`, and re-deriving it here would be the duplicate
    -- authority definition this trigger refuses to become.
    IF d.scope_level IN ('dealer_group', 'legal_entity', 'rooftop', 'department') THEN
      IF d.scope_level = 'dealer_group' THEN
        SELECT dg.dealer_group_id INTO dec_dealer_group
          FROM dealer_groups dg
         WHERE dg.tenant_id = d.tenant_id AND dg.dealer_group_id = d.scope_id;
      ELSIF d.scope_level = 'legal_entity' THEN
        SELECT le.legal_entity_id, le.dealer_group_id
          INTO dec_legal_entity, dec_dealer_group
          FROM legal_entities le
         WHERE le.tenant_id = d.tenant_id AND le.legal_entity_id = d.scope_id;
      ELSIF d.scope_level = 'rooftop' THEN
        SELECT rt.rooftop_id, rt.legal_entity_id, le.dealer_group_id
          INTO dec_rooftop, dec_legal_entity, dec_dealer_group
          FROM rooftops rt
          JOIN legal_entities le
            ON le.tenant_id = rt.tenant_id AND le.legal_entity_id = rt.legal_entity_id
         WHERE rt.tenant_id = d.tenant_id AND rt.rooftop_id = d.scope_id;
      ELSIF d.scope_level = 'department' THEN
        SELECT dp.department_id, dp.rooftop_id, rt.legal_entity_id, le.dealer_group_id
          INTO dec_department, dec_rooftop, dec_legal_entity, dec_dealer_group
          FROM departments dp
          JOIN rooftops rt ON rt.tenant_id = dp.tenant_id AND rt.rooftop_id = dp.rooftop_id
          JOIN legal_entities le
            ON le.tenant_id = rt.tenant_id AND le.legal_entity_id = rt.legal_entity_id
         WHERE dp.tenant_id = d.tenant_id AND dp.department_id = d.scope_id;
      END IF;
      IF (d.scope_level = 'dealer_group' AND dec_dealer_group IS NULL)
         OR (d.scope_level = 'legal_entity' AND dec_legal_entity IS NULL)
         OR (d.scope_level = 'rooftop' AND dec_rooftop IS NULL)
         OR (d.scope_level = 'department' AND dec_department IS NULL) THEN
        RAISE EXCEPTION
          'policy evidence refused: the decision this authority is claimed for records '
          'organization node %:%, and no such node exists in tenant % — evidence must name a '
          'node an operator can follow, not an identifier that resolves to nothing',
          d.scope_level, COALESCE(d.scope_id::text, '<none>'),
          COALESCE(d.tenant_id::text, '<none>');
      END IF;
    ELSIF d.scope_level = 'tenant' AND d.scope_id IS DISTINCT FROM d.tenant_id THEN
      -- The same defect one level up: `tenant` scope names the tenant, and a
      -- tenant-scope decision recording some OTHER id — or none — is recording a
      -- node it did not act in. The tenant itself is a foreign key on this table,
      -- so existence is already guaranteed; what is checked here is that the
      -- recorded scope IS that tenant.
      RAISE EXCEPTION
        'policy evidence refused: the decision this authority is claimed for records tenant '
        'scope over %, and the decision was recorded in tenant % — a tenant-scope decision '
        'names its own tenant and nothing else',
        COALESCE(d.scope_id::text, '<none>'), COALESCE(d.tenant_id::text, '<none>');
    END IF;

    -- (c2b) THE SCOPE HIERARCHY ITSELF.
    IF rb.scope_level = 'tenant' THEN
      IF rb.scope_id IS DISTINCT FROM d.tenant_id THEN
        RAISE EXCEPTION
          'policy evidence refused: matched binding % is tenant-scope over tenant %, and the '
          'decision it authorizes was recorded in tenant % — a tenant binding covers its own '
          'tenant and no other',
          NEW.role_binding_id, COALESCE(rb.scope_id::text, '<none>'),
          COALESCE(d.tenant_id::text, '<none>');
      END IF;
    ELSIF rb.scope_level IN ('dealer_group', 'legal_entity', 'rooftop', 'department')
          AND d.scope_level IS DISTINCT FROM 'resource' THEN
      IF (rb.scope_level = 'dealer_group' AND dec_dealer_group IS DISTINCT FROM rb.scope_id)
         OR (rb.scope_level = 'legal_entity' AND dec_legal_entity IS DISTINCT FROM rb.scope_id)
         OR (rb.scope_level = 'rooftop' AND dec_rooftop IS DISTINCT FROM rb.scope_id)
         OR (rb.scope_level = 'department' AND dec_department IS DISTINCT FROM rb.scope_id) THEN
        RAISE EXCEPTION
          'policy evidence refused: matched binding % is scoped at %:%, and the decision it '
          'authorizes records %:% — a binding covers its own organization node and what sits '
          'BENEATH it, never a sibling and never the tenant above it',
          NEW.role_binding_id, rb.scope_level, COALESCE(rb.scope_id::text, '<none>'),
          COALESCE(d.scope_level, '<none>'), COALESCE(d.scope_id::text, '<none>');
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_pdmb_binding_is_applicable ON policy_decision_matched_bindings;
CREATE TRIGGER trg_pdmb_binding_is_applicable
  BEFORE INSERT ON policy_decision_matched_bindings
  FOR EACH ROW EXECUTE FUNCTION policy_decision_binding_is_applicable();

-- ──────────────────────────────────────────────────────────────
-- Section 3 — R6 §3.2, SECOND HALF: THE NORMALIZED EVIDENCE IS EXACTLY THE ARRAY
--
-- 057 §11e claimed the child rows "have exactly one writer, which is this
-- trigger". Measured against the shipped schema that claim is FALSE, and R6 §3.2
-- says so: the two composite keys ask whether the binding belongs to the actor
-- and whether the decision names that actor, and a direct INSERT naming the
-- decision's OWN actor and one of that actor's OWN bindings satisfies both. The
-- primary key `(decision_id, role_binding_id)` stops the same binding being
-- claimed twice and stops nothing else, so the child rows could carry an EXTRA
-- binding the array never mentioned, a DUPLICATED ordinality, or a version the
-- array does not record — two records of one fact, free to disagree.
--
-- TWO CONTROLS, AND THEY ARE NOT THE SAME CONTROL:
--
--   * THE WRITER GUARD refuses a child row that did not come from the
--     normalizer, using a transaction-local marker the normalizer sets around
--     its own INSERT and clears immediately afterwards. It is stated plainly
--     that this is a GUARD AND NOT A PROOF: anyone who can run SQL can also run
--     `set_config`, so a determined direct writer can step past it. It earns its
--     place by refusing the ORDINARY direct insert — a repair script, a fixture,
--     a new code path — at the point of the write, with an error that says where
--     the row was supposed to come from.
--   * THE EQUIVALENCE RULE is the one that makes divergence UNREPRESENTABLE, and
--     it holds whether or not the marker was forged. At the end of any statement
--     that inserts child rows, the full child set of each affected decision must
--     equal the parent's arrays exactly — same bindings, same versions, same
--     ordinalities. Because the parent side is generated by
--     `unnest(...) WITH ORDINALITY`, ordinality is 1..n by construction, so
--     UNIQUE and CONTIGUOUS ordinality are consequences of the equivalence rather
--     than separate hopes. The UNIQUE INDEX below states the uniqueness half in
--     the schema as well, so a duplicate ordinality is refused by the index even
--     if the statement trigger were dropped.
--
-- `policy_decisions` is append-only, so a parent array cannot move after the
-- fact; equivalence checked once is equivalence for ever.
--
-- THE PRE-CHECK'S ONE EXEMPTION, AND WHY IT IS BY VERSION. Section 0 has already
-- derived every child row that CAN be derived, so a decision that still holds an
-- array and no child rows is one whose array names authority the database can no
-- longer resolve. Those rows are version-1 history: 057's evidence-version floor
-- refuses any new decision below version 2, and version-2 decisions are
-- normalized in the statement that writes them. So the exemption is exactly
-- "version-1, and holding no normalized rows at all" — never "version-1", and
-- never "some rows are missing". A version-1 decision that holds SOME child rows
-- is held to full equivalence like everything else.
-- ──────────────────────────────────────────────────────────────

DO $$
DECLARE bad INTEGER;
BEGIN
  SELECT COUNT(*) INTO bad FROM (
    SELECT decision_id, match_ordinality
      FROM policy_decision_matched_bindings
     GROUP BY decision_id, match_ordinality HAVING COUNT(*) > 1
  ) duplicated;
  IF bad > 0 THEN
    RAISE EXCEPTION 'FBL-020-R6 §3.2 refused: % retained decision/ordinality pair(s) are claimed '
                    'more than once in the normalized authority evidence', bad;
  END IF;

  SELECT COUNT(*) INTO bad FROM (
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
  ) diverged;
  IF bad > 0 THEN
    RAISE EXCEPTION 'FBL-020-R6 §3.2 refused: % retained decision(s) hold normalized authority '
                    'evidence that is not equivalent to the matched-binding array recorded '
                    'beside it. Both records are append-only, so neither can be edited into '
                    'agreement — they must be adjudicated before this migration runs', bad;
  END IF;
END $$;

CREATE UNIQUE INDEX uq_pdmb_ordinality
  ON policy_decision_matched_bindings (decision_id, match_ordinality);

CREATE OR REPLACE FUNCTION policy_decision_matched_bindings_have_one_writer() RETURNS TRIGGER AS $$
BEGIN
  IF COALESCE(current_setting('policy_evidence.normalizing_decision', true), '')
       IS DISTINCT FROM NEW.decision_id::text THEN
    RAISE EXCEPTION
      'policy_decision_matched_bindings INSERT refused: normalized authority evidence is '
      'DERIVED from policy_decisions.matched_role_binding_ids by '
      'trg_policy_decisions_normalize_matches, and this row was written directly';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_pdmb_authorized_writer ON policy_decision_matched_bindings;
CREATE TRIGGER trg_pdmb_authorized_writer
  BEFORE INSERT ON policy_decision_matched_bindings
  FOR EACH ROW EXECUTE FUNCTION policy_decision_matched_bindings_have_one_writer();

CREATE OR REPLACE FUNCTION policy_decision_matched_bindings_equal_the_array() RETURNS TRIGGER AS $$
DECLARE target UUID;
        recorded TEXT[];
        claimed  TEXT[];
BEGIN
  FOR target IN SELECT DISTINCT decision_id FROM inserted LOOP
    SELECT COALESCE(array_agg(
             ROW(c.role_binding_id, c.authorization_version, c.match_ordinality)::text
             ORDER BY c.match_ordinality, c.role_binding_id), ARRAY[]::text[])
      INTO recorded
      FROM policy_decision_matched_bindings c WHERE c.decision_id = target;
    SELECT COALESCE(array_agg(
             ROW(m.id, d.matched_authorization_versions[m.ord], m.ord)::text
             ORDER BY m.ord, m.id), ARRAY[]::text[])
      INTO claimed
      FROM policy_decisions d
      CROSS JOIN LATERAL unnest(d.matched_role_binding_ids) WITH ORDINALITY AS m(id, ord)
     WHERE d.decision_id = target;
    IF recorded IS DISTINCT FROM COALESCE(claimed, ARRAY[]::text[]) THEN
      RAISE EXCEPTION
        'policy evidence refused: the normalized authority rows for decision % are not '
        'equivalent to the matched-binding array recorded on it (% recorded, % claimed)',
        target, COALESCE(cardinality(recorded), 0), COALESCE(cardinality(claimed), 0);
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_pdmb_equals_its_decision ON policy_decision_matched_bindings;
CREATE TRIGGER trg_pdmb_equals_its_decision
  AFTER INSERT ON policy_decision_matched_bindings
  REFERENCING NEW TABLE AS inserted
  FOR EACH STATEMENT EXECUTE FUNCTION policy_decision_matched_bindings_equal_the_array();

-- The normalizer, re-declared so it can announce itself to the writer guard.
-- The body is 057's, unchanged, with the marker set immediately before its
-- INSERT and cleared immediately after — so the window in which a child row may
-- be written is exactly this one statement, for exactly this one decision.
-- Replacing the FUNCTION leaves 057's trigger wiring untouched.
CREATE OR REPLACE FUNCTION policy_decisions_normalize_matched_bindings() RETURNS TRIGGER AS $$
BEGIN
  IF cardinality(NEW.matched_role_binding_ids) = 0 THEN RETURN NULL; END IF;
  PERFORM set_config('policy_evidence.normalizing_decision', NEW.decision_id::text, true);
  INSERT INTO policy_decision_matched_bindings
    (decision_id, role_binding_id, actor_user_link_id, authorization_version, match_ordinality)
  SELECT NEW.decision_id, m.id, NEW.actor_user_link_id,
         NEW.matched_authorization_versions[m.ord], m.ord
    FROM unnest(NEW.matched_role_binding_ids) WITH ORDINALITY AS m(id, ord);
  PERFORM set_config('policy_evidence.normalizing_decision', '', true);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- ──────────────────────────────────────────────────────────────
-- Section 4 — R6 §3.4: A PLATFORM-SUPPORT TENANT ALLOW CARRIES DELEGATED-SUPPORT
-- EVIDENCE, AND THAT EVIDENCE IS THE APPROVAL IT CLAIMS
--
-- TWO SEPARATE HOLES, CLOSED SEPARATELY BECAUSE THEY FAIL DIFFERENTLY.
--
-- (a) THE EVIDENCE COULD BE ABSENT. `pd_v2_allow_has_authority_evidence` (057
--     §6) accepts EITHER a matched role binding OR a support session, and it does
--     not care which kind of actor is presenting which. So a `platform_support`
--     ALLOW into a customer tenant could name a role binding and no support
--     session at all — a platform person reaching into tenant data with no
--     approved delegation recorded anywhere. The engine never writes that row;
--     nothing stopped anything else from writing it. `platform.*` actions are
--     exempt BY NAME, exactly as `pd_v2_identified_actor_is_complete` exempts
--     them: a control-plane action targets no tenant's data and is authorized by
--     a platform binding, which is the whole point of the platform/dealership
--     split.
--
-- (b) THE EVIDENCE COULD BE UNRELATED TO THE APPROVAL. 057 §11d's
--     `pd_support_evidence_tuple` binds the session, the request, the tenant and
--     the actor to one another, and the window trigger binds the recorded expiry
--     to the session's own. Not one of those asks whether the request was ever
--     APPROVED, whether the approval covered THIS ACTION, whether it covered THIS
--     SCOPE, whether the session had been REVOKED, or whether the decision was
--     taken INSIDE the delegated window. The trigger below asks all five, against
--     the rows the decision itself names, at the moment the evidence is written.
--     The predicates are `sessionCovers` and the live-session query in
--     `decide()`, applied where the row lands.
--
-- WHAT IT REFUSES TO ADJUDICATE, and why that is not a gap: when the named
-- session does not exist, or its request/tenant/actor disagree with the columns
-- beside it, this returns quietly and lets `pd_support_evidence_tuple` and
-- `pd_support_evidence_is_complete` refuse the row under their own names. A
-- BEFORE trigger precedes every CHECK and every foreign key, so answering their
-- questions here would hide which rule was actually broken.
--
-- ON THE PRE-CHECK: the CHECK constraint below is VALIDATED against the stored
-- rows, so the count runs first and names what it found. `evidence_version < 2`
-- is the first disjunct of the constraint, so version-1 history satisfies it
-- unconditionally and only version-2 rows can be counted here.
--
-- ── THIS IS THE ONE REFUSAL IN THIS FILE THAT THE SHIPPED 057 SCHEMA ACCEPTS,
--    AND ITS MESSAGE SAYS SO RATHER THAN ISSUING AN INSTRUCTION NOBODY CAN
--    FOLLOW ─────────────────────────────────────────────────────────────────
--
-- Every other pre-check here fires only on a database somebody has already
-- tampered with — a dropped constraint, a hand-written version, a fabricated
-- authority version. This one does not: 057 accepts a `platform_support` ALLOW
-- into a tenant with no `support_session_id`, so the row is representable in a
-- database nobody has touched. An earlier draft ended by telling the operator to
-- "adjudicate" those rows, which is the third appearance in this file of a
-- refusal whose instruction cannot be carried out: `policy_decisions` is
-- append-only, so nothing an operator can run inside this migration will correct
-- or remove the row.
--
-- SO THE MESSAGE STATES A MEASUREMENT INSTEAD, and this is the measurement, taken
-- against the shipped code rather than reasoned about:
--
--   * `packages/identity-access/src/policy.ts` holds the ONLY production
--     `INSERT INTO policy_decisions` in this repository;
--   * all four of its `record()` call sites are inside `decide()`;
--   * the `deny` closure — one of those four — always writes `decision = 'deny'`,
--     and this pre-check counts only ALLOWs;
--   * the dealership ALLOW is reached only under `actor.actorScope === 'dealership'`,
--     and `actorType` is `'platform_support'` only under `actorScope === 'platform'`,
--     so that row's `actor_type` is `'user'`;
--   * the platform ALLOW is reached only when `def.action.startsWith('platform.')`,
--     which is exactly the `action !~ '^platform\.'` exemption below;
--   * the support ALLOW always carries `support.supportSessionId`, read from the
--     live `support_access_sessions` row the decision matched, on a NOT NULL column.
--
-- A row counted here therefore was NOT written by this codebase, and the message
-- says that in those words, names the rows, and tells the operator where to look
-- for the writer — because "who wrote this" is the only question an operator can
-- actually act on once the ledger refuses to be edited.
-- ──────────────────────────────────────────────────────────────

DO $$
DECLARE bad       INTEGER;
        offenders TEXT;
BEGIN
  SELECT COUNT(*) INTO bad
    FROM policy_decisions d
   WHERE d.evidence_version >= 2
     AND d.decision = 'allow'
     AND d.actor_type = 'platform_support'
     AND d.tenant_id IS NOT NULL
     AND d.action !~ '^platform\.'
     AND d.support_session_id IS NULL;
  IF bad > 0 THEN
    -- The ids, so the refusal hands over rows rather than a total. Bounded, because
    -- a message is not a dump; the predicate above is the query that lists the rest.
    SELECT string_agg(sample.decision_id::text, ', ' ORDER BY sample.occurred_at)
      INTO offenders
      FROM (SELECT d.decision_id, d.occurred_at
              FROM policy_decisions d
             WHERE d.evidence_version >= 2
               AND d.decision = 'allow'
               AND d.actor_type = 'platform_support'
               AND d.tenant_id IS NOT NULL
               AND d.action !~ '^platform\.'
               AND d.support_session_id IS NULL
             ORDER BY d.occurred_at
             LIMIT 10) sample;
    RAISE EXCEPTION 'FBL-020-R6 §3.4 refused: % retained platform-support ALLOW(s) into a '
                    'tenant carry no delegated-support evidence (first up to 10 by time: %). '
                    'NO SHIPPED WRITER IN THIS REPOSITORY CAN PRODUCE SUCH A ROW, and that is '
                    'measured rather than assumed: packages/identity-access/src/policy.ts holds '
                    'the only production INSERT INTO policy_decisions; all four of its record() '
                    'call sites are inside decide(); the deny path always writes decision=deny; '
                    'the dealership ALLOW is reached only for an actorScope of dealership and so '
                    'records actor_type=user; the platform ALLOW writes an action beginning '
                    '"platform.", which this check exempts by name; and the support ALLOW always '
                    'carries the id of the live support session it matched. So these rows were '
                    'written by something OUTSIDE this codebase — a repair script, a restore, or '
                    'a direct SQL session. THERE IS NO REPAIR INSIDE THIS MIGRATION and none is '
                    'offered: policy_decisions is append-only, so the rows can be neither '
                    'corrected nor removed here, and manufacturing a delegation record for them '
                    'would invent the approval they lack. What can be done is find the writer: '
                    'each row carries its own request_id, correlation_id and occurred_at, and '
                    'the delegation it should have named would be in support_access_sessions for '
                    'that actor and tenant at that instant. Until that is settled outside this '
                    'migration, pd_v2_support_tenant_allow_is_delegated cannot be added',
                    bad, COALESCE(offenders, '<none>');
  END IF;
END $$;

ALTER TABLE policy_decisions
  ADD CONSTRAINT pd_v2_support_tenant_allow_is_delegated CHECK (
    evidence_version < 2
    OR decision = 'deny'
    OR actor_type <> 'platform_support'
    OR tenant_id IS NULL
    OR action ~ '^platform\.'
    OR support_session_id IS NOT NULL
  );

CREATE OR REPLACE FUNCTION policy_decisions_support_evidence_is_the_approval() RETURNS TRIGGER AS $$
DECLARE s support_access_sessions%ROWTYPE;
        r support_access_requests%ROWTYPE;
BEGIN
  IF NEW.support_session_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO s FROM support_access_sessions
   WHERE support_session_id = NEW.support_session_id;
  IF NOT FOUND
     OR s.request_id IS DISTINCT FROM NEW.support_request_id
     OR s.tenant_id IS DISTINCT FROM NEW.tenant_id
     OR s.actor_user_link_id IS DISTINCT FROM NEW.actor_user_link_id THEN
    RETURN NEW; -- pd_support_evidence_tuple / pd_support_evidence_is_complete
  END IF;

  SELECT * INTO r FROM support_access_requests WHERE request_id = s.request_id;

  -- (1) THE APPROVED REQUEST. A session may outlive the decision that created
  -- it — 057 §5 supersedes a grantless approval and leaves the request
  -- `expired` — so the status is read now, not assumed from the session's
  -- existence.
  IF r.status <> 'approved' OR r.decided_at IS NULL OR r.decided_by_user_link_id IS NULL THEN
    RAISE EXCEPTION
      'policy_decisions INSERT refused: support request % is %, so it delegates nothing',
      r.request_id, r.status;
  END IF;

  -- (2) THE APPROVED ACTION SET.
  IF NOT (NEW.action = ANY (r.requested_actions)) THEN
    RAISE EXCEPTION
      'policy_decisions INSERT refused: support request % does not approve action %',
      r.request_id, NEW.action;
  END IF;

  -- (3) THE APPROVED SCOPE. A tenant-scope approval covers the tenant, and the
  -- tenant is already pinned by `pd_support_evidence_tuple`; a narrower approval
  -- covers exactly what it names, which is what `sessionCovers` decides and what
  -- `decide()` records on the row.
  IF r.scope_level <> 'tenant'
     AND (NEW.scope_level IS DISTINCT FROM r.scope_level
          OR NEW.scope_id IS DISTINCT FROM r.scope_id) THEN
    RAISE EXCEPTION
      'policy_decisions INSERT refused: support request % approves scope %:%, and this '
      'decision records %:%',
      r.request_id, r.scope_level, COALESCE(r.scope_id::text, '<none>'),
      COALESCE(NEW.scope_level, '<none>'), COALESCE(NEW.scope_id::text, '<none>');
  END IF;

  -- (4) THE REVOCATION STATE.
  IF s.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION
      'policy_decisions INSERT refused: support session % was revoked at %',
      s.support_session_id, s.revoked_at;
  END IF;

  -- (5) THE LIVE WINDOW, AGAINST THE DECISION'S OWN TIMESTAMP. `occurred_at`
  -- defaults to NOW() and is already populated when a BEFORE INSERT trigger
  -- runs, so a back-dated or forward-dated support allow is refused with the
  -- same rule as a late one.
  IF NEW.occurred_at < s.granted_at OR NEW.occurred_at >= s.expires_at THEN
    RAISE EXCEPTION
      'policy_decisions INSERT refused: the decision is timed % and support session % ran '
      'from % to %',
      NEW.occurred_at, s.support_session_id, s.granted_at, s.expires_at;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_policy_decisions_support_delegation ON policy_decisions;
CREATE TRIGGER trg_policy_decisions_support_delegation
  BEFORE INSERT ON policy_decisions
  FOR EACH ROW EXECUTE FUNCTION policy_decisions_support_evidence_is_the_approval();

-- ============================================================
-- Total: 0 tables created, 0 rows deleted, 0 rows rewritten; the normalized
-- authority rows that migration 057 never backfilled are DERIVED from the arrays
-- the retained decisions already carry, and the arrays that can no longer be
-- normalized are left exactly as written at evidence_version 1 — with the residue
-- disclosed BY CLASS, an absent binding among them.
-- `evidence_version` 3 is introduced and becomes both the default and the floor:
-- from version 3 the recorded authentication time must BE the named session's,
-- compared inside the INSERT, while versions 1 and 2 keep theirs exactly as
-- written because a session that has since re-authenticated does not falsify the
-- instant a decision was taken at. A matched binding must be the exact version
-- observed, in force, in the decision's tenant, able to reach it, and at or above
-- the organization node the decision records — never a sibling, never the tenant
-- above it, and never a node that exists nowhere; the normalized authority rows
-- are exactly the array they normalize, with unique contiguous ordinality and
-- one authorized writer; and a platform-support allow into a tenant must carry
-- delegated-support evidence that really is the approval, the action, the scope,
-- the unrevoked session and the live window it claims.
-- ============================================================
