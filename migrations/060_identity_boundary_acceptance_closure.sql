-- ============================================================================
-- Migration 060 — FBL-020-R7-C1 IDENTITY-BOUNDARY ACCEPTANCE CLOSURE
--
-- The architect returned FBL-020-R7 for one bounded correction (order text at
-- docs/orders/FBL-020-R7-C1.md). Migrations 000 and 049-059 are byte-immutable;
-- every schema correction is here. This migration closes six database findings
-- WITHOUT editing any prior migration — each control is a NEW trigger, CHECK,
-- role or precheck layered over what 059 already installed:
--
--   §2  a real, non-owner LOGIN role the application authenticates as, so the
--       runtime posture is a connection identity and not a reversible SET ROLE;
--   §4  a support ALLOW's platform authority must still be LIVE at the write
--       instant, not merely at policy-evaluation time;
--   §5  a support ALLOW's approved SCOPE must cover the resource it names,
--       related through the one database resource-ancestry authority;
--   §6  actor_type='system' is no longer a caller-selectable escape from
--       tenant, resource, actor and credential validation;
--   §7  the COMPLETE approval invariant is re-validated whenever a request is
--       approved, closing the staged pending/denied -> approved bypass;
--   §8  the retained-state prechecks judge ALL retained rows (not only live
--       delegations) and the 059 tuple key is VALIDATED rather than left
--       NOT VALID.
--
-- The prechecks (§0) run first, refuse before anything lands, and name bounded
-- actionable identifiers; then the constraints are added and validated.
-- ============================================================================

-- ────────────────────────────────────────────────────────────────────────────
-- Section 0 — FULL-SCOPE PRECHECKS OVER RETAINED SUPPORT ROWS (§8)
--
-- 059's prechecks were scoped to rows that still ASSERT a live delegation, so a
-- revoked or expired incoherent row could survive and the 059 tuple key was
-- installed NOT VALID to tolerate it. FBL-020-R7-C1 §8 requires the ACTOR and
-- TENANT tuple invariants to hold over EVERY retained row and the standing
-- approved SCOPES to be effective, so this migration re-judges them at full
-- scope and refuses before landing if any retained row is incoherent. What
-- stays scoped to live/standing rows is only the timing shape (a revoked
-- session's window is moot), because 057 §5's own documented supersession
-- outcome — a grantless approval superseded with decided_at cleared and its
-- session revoked — is retained history whose ACTOR still equals its requester
-- and whose tuple is therefore coherent.
-- ────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE bad_count bigint;
        bad_ids   text;
BEGIN
  -- §8: EVERY session's actor is its request's approved requester — retained,
  -- revoked and expired rows included, because the tuple key must VALIDATE over
  -- all of them.
  SELECT COUNT(*),
         string_agg(bad.id, ', ' ORDER BY bad.id) FILTER (WHERE bad.rn <= 20)
    INTO bad_count, bad_ids
    FROM (SELECT s.support_session_id::text AS id,
                 row_number() OVER (ORDER BY s.support_session_id) AS rn
            FROM support_access_sessions s
            JOIN support_access_requests r ON r.request_id = s.request_id
           WHERE s.actor_user_link_id IS DISTINCT FROM r.requester_user_link_id) bad;
  IF bad_count > 0 THEN
    RAISE EXCEPTION USING MESSAGE = format(
      'migration 060 refused: %s retained support session(s) name an actor who is not the '
      'approved requester of their own request (first ids: %s). This is the tuple the 059 '
      'key binds and it must hold over every retained row. REVOKE and supersede each listed '
      'session and its request through the documented support-access paths, then re-run this '
      'migration; historical evidence stays exactly as written.',
      bad_count, bad_ids);
  END IF;

  -- §8: EVERY retained support requester and session actor is a platform link.
  SELECT COUNT(*), string_agg(x.id, ', ') FILTER (WHERE x.rn <= 20)
    INTO bad_count, bad_ids
    FROM (SELECT ('request ' || r.request_id::text) AS id,
                 row_number() OVER (ORDER BY r.request_id) AS rn
            FROM support_access_requests r
            JOIN user_links ul ON ul.user_link_id = r.requester_user_link_id
           WHERE ul.actor_scope <> 'platform'
          UNION ALL
          SELECT ('session ' || s.support_session_id::text),
                 row_number() OVER (ORDER BY s.support_session_id) + 1000000
            FROM support_access_sessions s
            JOIN user_links ul ON ul.user_link_id = s.actor_user_link_id
           WHERE ul.actor_scope <> 'platform') x;
  IF bad_count > 0 THEN
    RAISE EXCEPTION USING MESSAGE = format(
      'migration 060 refused: %s retained support request(s)/session(s) name a requester or '
      'actor whose user_link is not actor_scope=platform (first: %s). Support access is a '
      'PLATFORM delegation. Supersede each listed approval and revoke each listed session '
      'through the documented paths, then re-run this migration.',
      bad_count, bad_ids);
  END IF;

  -- §8: EVERY STANDING approved request delegates an effective scope. A request
  -- that is currently `approved` and names a non-tenant scope must resolve to an
  -- active, in-window organization node of its own tenant; a standing approval
  -- of a scope that resolves to nothing is an incoherent constraint the upgrade
  -- must not silently validate.
  SELECT COUNT(*),
         string_agg(bad.id, ', ' ORDER BY bad.id) FILTER (WHERE bad.rn <= 20)
    INTO bad_count, bad_ids
    FROM (SELECT r.request_id::text AS id,
                 row_number() OVER (ORDER BY r.request_id) AS rn
            FROM support_access_requests r
           WHERE r.status = 'approved' AND r.scope_level <> 'tenant'
             AND org_chain_defect(r.tenant_id, r.scope_level, r.scope_id,
                                  clock_timestamp()) IS NOT NULL) bad;
  IF bad_count > 0 THEN
    RAISE EXCEPTION USING MESSAGE = format(
      'migration 060 refused: %s standing approved support request(s) delegate a scope that '
      'is not an effective node of their own tenant (first ids: %s). An approval cannot '
      'stand on a scope that resolves to nothing. SUPERSEDE each listed approval through the '
      'documented support-access supersession path and re-run this migration.',
      bad_count, bad_ids);
  END IF;
END $$;

-- The 059 tuple key was installed NOT VALID; §0 has now proven every retained
-- session's actor is its request's requester, so it is VALIDATED here. VALIDATE
-- CONSTRAINT scans the existing rows and would itself refuse an incoherent one,
-- but §0 runs first so the operator meets a bounded, actionable message rather
-- than a bare constraint-violation.
ALTER TABLE support_access_sessions
  VALIDATE CONSTRAINT sas_actor_is_the_approved_requester;

-- ────────────────────────────────────────────────────────────────────────────
-- Section 1 — THE APPLICATION LOGIN ROLE (§2)
--
-- 059 created dealership_runtime (NOLOGIN, table DML except the normalized
-- child) and dealership_evidence_owner (NOLOGIN, owns the SECURITY DEFINER
-- normalizer). The application connected as the database owner and OPTIONALLY
-- assumed the runtime role through a startup option — reversible with
-- RESET ROLE and defeated entirely when the option is absent. This creates the
-- CONNECTION IDENTITY the application must authenticate as: a LOGIN role that IS
-- exactly the runtime role's privileges and nothing more.
--
--   * a member of dealership_runtime, INHERITing its grants (SELECT/INSERT/
--     UPDATE/DELETE on the application tables, SELECT-only on the normalized
--     child), so an authorized parent INSERT still fires the database-owned
--     SECURITY DEFINER normalizer;
--   * NOT a member of dealership_evidence_owner and NOT the owner of anything,
--     so it cannot SET ROLE to migration-owner authority and RESET ROLE returns
--     it to itself — still runtime-only;
--   * NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS, explicitly.
--
-- NO PASSWORD IS SET HERE. A password in a migration would be a disclosed
-- credential; the operator provisions authentication out of band (the drill
-- sets an ephemeral one on its throwaway cluster). The role is idempotent so a
-- re-run neither fails nor resets an operator-provisioned secret.
-- ────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dealership_app') THEN
    CREATE ROLE dealership_app LOGIN INHERIT
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS
      IN ROLE dealership_runtime;
  END IF;
END $$;

-- Idempotent posture assertion: whatever a prior run or operator did, the role
-- ends this migration with exactly the intended, least-privilege shape.
ALTER ROLE dealership_app
  LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
GRANT dealership_runtime TO dealership_app;
GRANT USAGE ON SCHEMA public TO dealership_app;

-- §2: the runtime role may READ the migration ledger but never WRITE it. 059's
-- blanket `GRANT ... ON ALL TABLES` reached schema_migrations too, which would
-- have let the runtime connection rewrite the record of what schema is in force.
-- Only the migration owner writes the ledger; the runtime keeps SELECT so the
-- application can report its own migration state.
REVOKE INSERT, UPDATE, DELETE ON schema_migrations FROM dealership_runtime;

-- ────────────────────────────────────────────────────────────────────────────
-- Section 2 — SUPPORT AUTHORITY MUST BE LIVE AT THE WRITE INSTANT (§4)
--
-- 059 proved the support SESSION is unexpired at the write instant. It did NOT
-- re-check that the support ACTOR still holds an effective PLATFORM role
-- binding — the authority the engine read at evaluation to decide the actor may
-- act as platform support. A binding revoked, disabled or aged out between
-- evaluation and the evidence write could still produce an ALLOW. This trigger
-- closes that race: a delegated ALLOW requires the actor to hold an effective
-- platform-scope binding at the ACTUAL write instant.
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION policy_decisions_support_authority_is_live() RETURNS TRIGGER AS $$
DECLARE write_instant timestamptz;
BEGIN
  IF NEW.evidence_version < 4 OR NEW.support_session_id IS NULL
     OR NEW.actor_user_link_id IS NULL THEN
    RETURN NEW;
  END IF;
  write_instant := clock_timestamp();
  IF NOT EXISTS (
    SELECT 1 FROM role_bindings rb
     WHERE rb.user_link_id = NEW.actor_user_link_id
       AND rb.scope_level = 'platform'
       AND rb.status = 'active'
       AND rb.effective_from <= write_instant
       AND (rb.effective_to IS NULL OR rb.effective_to > write_instant)
  ) THEN
    RAISE EXCEPTION
      'policy_decisions INSERT refused: support actor % holds no effective platform-scope '
      'role binding at the write instant % — a delegation whose platform authority was '
      'revoked or aged out between evaluation and the write records nothing',
      NEW.actor_user_link_id, write_instant;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_policy_decisions_zz_support_authority_live
  BEFORE INSERT ON policy_decisions
  FOR EACH ROW EXECUTE FUNCTION policy_decisions_support_authority_is_live();

-- ────────────────────────────────────────────────────────────────────────────
-- Section 3 — THE APPROVED SCOPE MUST COVER THE RESOURCE (§5)
--
-- 059 validated a support ALLOW's resource ancestry and its approved-request
-- tuple INDEPENDENTLY. Nothing related the two: a session approved for rooftop A
-- could be recorded against a rooftop-B resource, because the resource chain was
-- effective and the tuple was coherent — separately. This trigger relates them
-- through the ONE resource-ancestry authority: on a delegated ALLOW naming a
-- resource, the approving request's scope node must be on the resource's own
-- effective ancestor chain (a tenant-scope approval covers every node).
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION policy_decisions_support_scope_reaches_resource()
RETURNS TRIGGER AS $$
DECLARE r support_access_requests%ROWTYPE;
        leaf uuid;
        write_instant timestamptz;
BEGIN
  IF NEW.evidence_version < 4 OR NEW.decision <> 'allow'
     OR NEW.support_session_id IS NULL OR NEW.resource_type IS NULL
     OR NEW.tenant_id IS NULL OR NEW.support_request_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT * INTO r FROM support_access_requests WHERE request_id = NEW.support_request_id;
  IF NOT FOUND THEN RETURN NEW; END IF; -- 058/059 own the tuple existence checks
  -- A tenant-scope approval reaches every resource in its tenant.
  IF r.scope_level = 'tenant' THEN RETURN NEW; END IF;

  write_instant := clock_timestamp();
  leaf := resource_org_leaf(NEW.tenant_id, NEW.resource_type, NEW.resource_id);
  IF leaf IS NULL THEN
    -- 059's structural validity refuses an unresolvable resource under its own
    -- message; nothing to add here.
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM org_ancestry_effective(NEW.tenant_id, 'rooftop', leaf, write_instant) chain
     WHERE chain.level = r.scope_level AND chain.node_id = r.scope_id
  ) THEN
    RAISE EXCEPTION
      'policy_decisions INSERT refused: support request % was approved for scope %:%, and '
      'resource %:% resolves to rooftop % which is NOT under that approved scope — a '
      'delegation for one node never authorizes a sibling''s resources',
      NEW.support_request_id, r.scope_level, COALESCE(r.scope_id::text, '<none>'),
      NEW.resource_type, NEW.resource_id, leaf;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_policy_decisions_zz_support_scope_reaches_resource
  BEFORE INSERT ON policy_decisions
  FOR EACH ROW EXECUTE FUNCTION policy_decisions_support_scope_reaches_resource();

-- ────────────────────────────────────────────────────────────────────────────
-- Section 4 — CLOSE THE system EVIDENCE BYPASS (§6)
--
-- 059's version-4 rules exempt actor_type='system' from the actor-label check,
-- and its resource-resolution block is guarded by `tenant_id IS NOT NULL`. A
-- caller writing a system row with a NULL tenant and a fabricated
-- resource_rooftop_id therefore skipped resolution entirely while satisfying
-- `pd_v4_resource_allow_names_its_rooftop` with the fabricated value. Two
-- structural CHECKs close it, keeping a legitimate tenant-scoped system lane:
--
--   * a resource ALLOW — system or not — MUST name a tenant, so 059's
--     resolution trigger always fires and validates the snapshot against the
--     database's own resolution (a fabricated rooftop cannot survive);
--   * a system row carries NO human actor, credential, or support evidence —
--     the system lane is for unattended platform activity, not a costume an
--     ordinary decision can wear to shed its validation.
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE policy_decisions
  ADD CONSTRAINT pd_resource_allow_names_a_tenant
  CHECK (decision = 'deny' OR resource_type IS NULL OR tenant_id IS NOT NULL
         -- a platform-scoped row is judged by 059's pd_v4_control_plane_is_structural,
         -- which refuses ANY control-plane resource payload; this CHECK owns the
         -- system/tenant lanes, where a resource ALLOW must name its tenant so 059's
         -- resolution trigger fires and validates the snapshot.
         OR scope_level IS NOT DISTINCT FROM 'platform');

ALTER TABLE policy_decisions
  ADD CONSTRAINT pd_system_row_carries_no_human_evidence
  CHECK (actor_type <> 'system'
         OR (actor_user_link_id IS NULL AND session_id IS NULL
             AND connection_id IS NULL AND actor_provider_subject IS NULL
             AND support_session_id IS NULL AND support_request_id IS NULL));

-- ────────────────────────────────────────────────────────────────────────────
-- Section 5 — VALIDATE THE COMPLETE APPROVAL TRANSITION (§7)
--
-- 059's grant trigger has an unchanged-grant early return: on an UPDATE that
-- does not move approval_grant_id it returns without re-litigating the grant.
-- A grant attached while a request was `pending`, then a later UPDATE flipping
-- status to `approved` WITHOUT touching approval_grant_id, therefore skipped the
-- grant/scope validation. This trigger re-validates the COMPLETE approval
-- invariant whenever a row IS approved, regardless of which column changed, and
-- refuses an approved row that reaches a terminal status other than through a
-- pending-or-approved predecessor.
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION support_request_approval_is_complete() RETURNS TRIGGER AS $$
DECLARE g reauthentication_grants%ROWTYPE;
        defect text;
BEGIN
  -- A terminal decided state may not be reached from another terminal state:
  -- approval must come from pending (or an INSERT), and a decided row may only
  -- move on to the documented supersession terminals. This makes the staged
  -- transition observable rather than silent.
  IF TG_OP = 'UPDATE' AND NEW.status = 'approved'
     AND OLD.status NOT IN ('pending', 'approved') THEN
    RAISE EXCEPTION
      'support_access_requests refused: request % cannot become approved from status % — '
      'an approval is decided once, from a pending request',
      OLD.request_id, OLD.status;
  END IF;

  IF NEW.status <> 'approved' THEN RETURN NEW; END IF;

  -- The complete approval invariant, re-checked on EVERY approved state (not
  -- only when the grant id moves): decider present, grant present and the
  -- approval it claims, timing coherent, scope effective.
  IF NEW.decided_at IS NULL OR NEW.decided_by_user_link_id IS NULL THEN
    RAISE EXCEPTION
      'support_access_requests refused: approved request % must name its decider and the '
      'instant it was decided',
      NEW.request_id;
  END IF;
  IF NEW.approval_grant_id IS NULL THEN
    RAISE EXCEPTION
      'support_access_requests refused: approved request % must cite the high-assurance '
      'grant that backed the approval',
      NEW.request_id;
  END IF;
  SELECT * INTO g FROM reauthentication_grants WHERE grant_id = NEW.approval_grant_id;
  IF NOT FOUND THEN RETURN NEW; END IF; -- the composite FK owns existence
  IF g.action <> 'identity.support.approve'
     OR g.resource_type IS DISTINCT FROM 'support_access_request'
     OR g.resource_id IS DISTINCT FROM NEW.request_id
     OR g.assurance_level <> 'fresh_and_mfa_policy'
     OR g.mfa_policy_certified_at_issue IS DISTINCT FROM true THEN
    RAISE EXCEPTION
      'support_access_requests refused: approved request % cites grant %, which is not an '
      'identity.support.approve grant for that exact request at fresh_and_mfa_policy '
      'assurance with MFA policy certified — the complete approval invariant is re-checked '
      'whenever a request is approved, not only when the grant id changes',
      NEW.request_id, NEW.approval_grant_id;
  END IF;
  IF NEW.scope_level <> 'tenant' THEN
    defect := org_chain_defect(NEW.tenant_id, NEW.scope_level, NEW.scope_id, clock_timestamp());
    IF defect IS NOT NULL THEN
      -- The wording deliberately DIFFERS from 059's identically-shaped scope
      -- clause in support_approval_grant_is_the_approval(): 059's trigger
      -- (trg_sar_grant_is_the_approval) fires BEFORE this one and owns the
      -- single-step approval path, so a test pinning 059's phrase still sees
      -- 059's message at baseline. Dropping 059's clause hands the same defect
      -- to THIS trigger, and a distinct message is what lets that mutation be
      -- KILLED rather than silently masked. This clause still enforces the
      -- SAME invariant on the staged pending->approved path 059's early return
      -- skipped — the reason §7 exists.
      RAISE EXCEPTION
        'support_access_requests refused: approved scope %:% of request % resolves to no '
        'effective node of tenant % (%) — the complete-approval re-check runs on every '
        'approved state, and this scope does not effectively exist',
        NEW.scope_level, COALESCE(NEW.scope_id::text, '<none>'), NEW.request_id,
        NEW.tenant_id, defect;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_sar_zz_approval_is_complete
  BEFORE INSERT OR UPDATE ON support_access_requests
  FOR EACH ROW EXECUTE FUNCTION support_request_approval_is_complete();
