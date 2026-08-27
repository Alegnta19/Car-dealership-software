-- ============================================================================
-- 059 — POLICY-EVIDENCE INTEGRITY CLOSURE (FBL-020-R7 §3)
--
-- Migrations 000 and 049–058 are FROZEN. Every R7 schema correction lives here.
--
-- WHAT THIS MIGRATION CLOSES, clause by clause:
--
--   §3.1  A support session could name ANY platform actor, not the approved
--         requester: the runtime always wrote the requester, but nothing in the
--         database refused a session that substituted a different real platform
--         person. The request/session/actor/tenant tuple is now ONE tuple,
--         enforced by a composite foreign key, and both the requester and the
--         session actor must be REAL `user_links` rows with
--         `actor_scope = 'platform'`. `policy_decisions.actor_type` was a
--         caller-supplied label; for current evidence it is now bound to the
--         actor's REAL scope.
--
--   §3.2  A session could exceed or precede its approval: `expires_at` was
--         bounded only by the fixed one-hour cap, never by the duration the
--         request actually asked for, and `granted_at` was never compared to
--         `decided_at`. The approval grant's own action, resource, assurance
--         and MFA certification were enforced by the consuming CODE and by
--         nothing in the schema. All of it is now judged where the rows are
--         written, and the authority fields of both rows are immutable.
--
--   §3.3  `action ~ '^platform\.'` decided whether a platform-support ALLOW
--         over a customer tenant needed delegated evidence — a NAME deciding
--         an AUTHORITY question. For current evidence the rule is structural:
--         a platform-support ALLOW naming an authorization tenant requires
--         delegated-support evidence regardless of what the action is called,
--         and a control-plane decision is one that IS platform-scoped, names
--         NO authorization tenant and carries NO customer-resource payload.
--         Operational target-tenant metadata gets its own column, separate
--         from the authorization-bound tenant.
--
--   §3.4  Resource-scope decisions were exempt from hierarchy adjudication,
--         because mapping a resource to its organization node lived only in
--         TypeScript. The mapping is now a DATABASE function — the one
--         authority both the runtime resolver and the evidence validator
--         call — the database-validated leaf is persisted on the decision,
--         and every matched organization binding on a resource decision is
--         validated against that resource's real ancestry.
--
--   §3.5  Effective ancestry is now ONE database authority
--         (`org_ancestry_all` + `org_chain_defect`), used by the runtime
--         engine and by the evidence validators: the tenant, the leaf and
--         every ancestor must be active and inside their effective windows.
--
--   §3.6  Liveness was judged with `NOW()` — the TRANSACTION-START clock — so
--         a transaction opened before an authority expired could write
--         evidence after it had. For current evidence, liveness is judged at
--         `clock_timestamp()`, the actual write instant; `occurred_at` is
--         checked for consistency but can never substitute for the live check.
--
--   §3.7  `policy_evidence.normalizing_decision` was a GUC any caller could
--         set, presented as writer authorization. It is GONE as authorization:
--         normalization now runs as a `SECURITY DEFINER` function owned by a
--         role the runtime role cannot assume, and the runtime role holds no
--         direct DML on the child table at all — the privilege system, not a
--         forgeable setting, is the writer guard.
--
-- EVIDENCE VERSIONING. Versions 1–3 are HISTORY and are not rewritten: every
-- new rule here is conditional on `evidence_version >= 4` where it could
-- otherwise reach a retained row. Version 4 becomes the default and the floor
-- for NEW decisions, exactly as 058 did for version 3.
--
-- PRECHECKS. Where a new constraint must hold over RETAINED rows (the support
-- tuple and duration bounds), a precheck runs FIRST and refuses with a bounded
-- list of row identifiers and an ACTION THE OPERATOR CAN ACTUALLY TAKE —
-- revoking the offending live session or superseding the approval through the
-- documented paths. No message instructs anyone to edit append-only evidence.
--
-- ROLES. This migration creates two NOLOGIN roles and must therefore run as a
-- user with CREATEROLE (CI and the drills run it as the database superuser).
-- `dealership_runtime` is the role the API and worker assume; it is what
-- "the application" means to the privilege system. `dealership_evidence_owner`
-- owns the normalization function and is the only non-superuser writer of
-- `policy_decision_matched_bindings`; the runtime role is not a member of it
-- and cannot SET ROLE to it.
-- ============================================================================

-- ────────────────────────────────────────────────────────────────────────────
-- Section 0 — PRECHECKS OVER RETAINED SUPPORT ROWS (§3.1, §3.2)
--
-- Each raises BEFORE any constraint is added, so the operator meets one
-- bounded, truthful message rather than a constraint-violation stack. The row
-- lists are capped at twenty identifiers; the count is always exact.
--
-- ONLY ROWS THAT STILL ASSERT A DELEGATION ARE JUDGED. A session that has been
-- revoked, administratively expired, or whose window the clock has already
-- closed delegates nothing, and a request that is not pending or approved
-- requests nothing — 057 §5's own documented outcome (a grantless approval
-- SUPERSEDED with `decided_at` cleared, its session REVOKED by 057 itself) is
-- exactly such history, and a precheck that refused the migration over it
-- would be demanding an action that is already taken. The instructions below
-- are actionable precisely because every listed row is still live: it CAN be
-- revoked or superseded. Ended history that would not satisfy the new tuple
-- key is tolerated by declaring that key NOT VALID (Section 1), which
-- PostgreSQL enforces in full for every future write while leaving retained
-- rows exactly as written.
-- ────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE bad_count bigint;
        bad_ids   text;
BEGIN
  -- §3.1: a session whose actor is not its request's approved requester.
  SELECT COUNT(*),
         string_agg(bad.id, ', ' ORDER BY bad.id) FILTER (WHERE bad.rn <= 20)
    INTO bad_count, bad_ids
    FROM (SELECT s.support_session_id::text AS id,
                 row_number() OVER (ORDER BY s.support_session_id) AS rn
            FROM support_access_sessions s
            JOIN support_access_requests r ON r.request_id = s.request_id
           WHERE s.revoked_at IS NULL AND s.expired_at IS NULL
             AND s.expires_at > clock_timestamp()
             AND s.actor_user_link_id IS DISTINCT FROM r.requester_user_link_id) bad;
  IF bad_count > 0 THEN
    RAISE EXCEPTION USING MESSAGE = format(
      'migration 059 refused: %s LIVE support session(s) name an actor who is not the '
      'approved requester of their own request (first ids: %s). These sessions assert a '
      'delegation their approval never made. REVOKE each listed session through the '
      'support-access revocation path (revokeSupportSession / the operator runbook) and '
      're-run this migration; the sessions and their requests stay exactly as written.',
      bad_count, bad_ids);
  END IF;

  -- §3.1: a requester or session actor that is not a platform-scope link.
  SELECT COUNT(*), string_agg(x.id, ', ') FILTER (WHERE x.rn <= 20)
    INTO bad_count, bad_ids
    FROM (SELECT ('request ' || r.request_id::text) AS id,
                 row_number() OVER (ORDER BY r.request_id) AS rn
            FROM support_access_requests r
            JOIN user_links ul ON ul.user_link_id = r.requester_user_link_id
           WHERE r.status IN ('pending', 'approved')
             AND ul.actor_scope <> 'platform'
          UNION ALL
          SELECT ('session ' || s.support_session_id::text),
                 row_number() OVER (ORDER BY s.support_session_id) + 1000000
            FROM support_access_sessions s
            JOIN user_links ul ON ul.user_link_id = s.actor_user_link_id
           WHERE s.revoked_at IS NULL AND s.expired_at IS NULL
             AND s.expires_at > clock_timestamp()
             AND ul.actor_scope <> 'platform') x;
  IF bad_count > 0 THEN
    RAISE EXCEPTION USING MESSAGE = format(
      'migration 059 refused: %s LIVE support request(s)/session(s) name a requester or '
      'actor whose user_link is not actor_scope=platform (first: %s). Support access is a '
      'PLATFORM delegation and a dealership link cannot hold it. Revoke each listed '
      'session and supersede each listed approval through the documented support-access '
      'paths, then re-run this migration.',
      bad_count, bad_ids);
  END IF;

  -- §3.2: a session that began before its approval was decided.
  SELECT COUNT(*),
         string_agg(bad.id, ', ' ORDER BY bad.id) FILTER (WHERE bad.rn <= 20)
    INTO bad_count, bad_ids
    FROM (SELECT s.support_session_id::text AS id,
                 row_number() OVER (ORDER BY s.support_session_id) AS rn
            FROM support_access_sessions s
            JOIN support_access_requests r ON r.request_id = s.request_id
           WHERE s.revoked_at IS NULL AND s.expired_at IS NULL
             AND s.expires_at > clock_timestamp()
             AND (r.decided_at IS NULL OR s.granted_at < r.decided_at)) bad;
  IF bad_count > 0 THEN
    RAISE EXCEPTION USING MESSAGE = format(
      'migration 059 refused: %s LIVE support session(s) were granted before their request '
      'was decided, or against an undecided request (first ids: %s). A session cannot '
      'precede its own approval. REVOKE each listed session through the support-access '
      'revocation path and re-run this migration.',
      bad_count, bad_ids);
  END IF;

  -- §3.2: a session that outlives the duration its request actually asked for.
  SELECT COUNT(*),
         string_agg(bad.id, ', ' ORDER BY bad.id) FILTER (WHERE bad.rn <= 20)
    INTO bad_count, bad_ids
    FROM (SELECT s.support_session_id::text AS id,
                 row_number() OVER (ORDER BY s.support_session_id) AS rn
            FROM support_access_sessions s
            JOIN support_access_requests r ON r.request_id = s.request_id
           WHERE s.revoked_at IS NULL AND s.expired_at IS NULL
             AND s.expires_at > clock_timestamp()
             AND s.expires_at
                 > s.granted_at + make_interval(mins => r.requested_duration_minutes)) bad;
  IF bad_count > 0 THEN
    RAISE EXCEPTION USING MESSAGE = format(
      'migration 059 refused: %s LIVE support session(s) expire later than the duration '
      'their own request asked for (first ids: %s). An approval of N minutes cannot '
      'produce a longer session. REVOKE each listed session through the support-access '
      'revocation path and re-run this migration.',
      bad_count, bad_ids);
  END IF;

  -- §3.2: an approval whose grant is not an approval OF THIS REQUEST at the
  -- required assurance. The grant's tenant and decider are already pinned by
  -- 057's composite foreign keys; action, resource, assurance and MFA
  -- certification were enforced only by the consuming code until now.
  SELECT COUNT(*),
         string_agg(bad.id, ', ' ORDER BY bad.id) FILTER (WHERE bad.rn <= 20)
    INTO bad_count, bad_ids
    FROM (SELECT r.request_id::text AS id,
                 row_number() OVER (ORDER BY r.request_id) AS rn
            FROM support_access_requests r
            JOIN reauthentication_grants g ON g.grant_id = r.approval_grant_id
           WHERE r.status = 'approved'
             AND r.approval_grant_id IS NOT NULL
             AND (g.action <> 'identity.support.approve'
                  OR g.resource_type IS DISTINCT FROM 'support_access_request'
                  OR g.resource_id IS DISTINCT FROM r.request_id
                  OR g.assurance_level <> 'fresh_and_mfa_policy'
                  OR g.mfa_policy_certified_at_issue IS DISTINCT FROM true)) bad;
  IF bad_count > 0 THEN
    RAISE EXCEPTION USING MESSAGE = format(
      'migration 059 refused: %s STANDING support approval(s) cite a reauthentication grant '
      'that is not an identity.support.approve grant for that exact request at '
      'fresh_and_mfa_policy assurance with MFA policy certified (first request ids: %s). '
      'SUPERSEDE each listed approval through the documented support-access supersession '
      'path (which records who superseded it and why, exactly as migration 057 §5 does) '
      'and re-run this migration.',
      bad_count, bad_ids);
  END IF;
END $$;

-- ────────────────────────────────────────────────────────────────────────────
-- Section 1 — THE SUPPORT TUPLE (§3.1)
-- ────────────────────────────────────────────────────────────────────────────

-- The unique target: one row per (request, tenant, requester) so a composite
-- foreign key can bind a session to the exact approved delegation.
ALTER TABLE support_access_requests
  ADD CONSTRAINT uq_sar_request_tenant_requester
  UNIQUE (request_id, tenant_id, requester_user_link_id);

-- The binding itself: a support session's actor IS the approved requester of
-- its own request, in its own tenant — as one referential fact, not three
-- separately-checked columns.
--
-- NOT VALID, deliberately. PostgreSQL then enforces the key IN FULL for every
-- INSERT and UPDATE from this instant on — which is the whole of §3.1's demand
-- on new evidence — while declining to validate retained rows. Retained
-- sessions that still DELEGATE were proven clean by Section 0's live-scoped
-- precheck (a live violator is revocable, so that refusal is actionable);
-- retained sessions that have already ENDED are append-only history this
-- migration may neither rewrite nor demand impossible action on, and a
-- validated constraint would refuse the upgrade over rows nothing can lawfully
-- change. The write-time triggers below judge every new row independently of
-- this key, so the two do not lean on each other.
ALTER TABLE support_access_sessions
  ADD CONSTRAINT sas_actor_is_the_approved_requester
  FOREIGN KEY (request_id, tenant_id, actor_user_link_id)
  REFERENCES support_access_requests (request_id, tenant_id, requester_user_link_id)
  NOT VALID;

-- The requester must be a REAL platform-scope link. A trigger rather than a
-- CHECK because it reads another table, and BEFORE INSERT OR UPDATE because an
-- update that re-points the requester must be judged the same way (the
-- immutability trigger in Section 2 refuses such an update anyway; this rule
-- must hold even if that one is dropped — controls do not lean on each other).
CREATE OR REPLACE FUNCTION support_request_requester_is_platform() RETURNS TRIGGER AS $$
DECLARE scope text;
BEGIN
  SELECT ul.actor_scope INTO scope FROM user_links ul
   WHERE ul.user_link_id = NEW.requester_user_link_id;
  -- Existence is the foreign key's job; this trigger judges only the scope.
  IF scope IS NULL THEN RETURN NEW; END IF;
  IF scope <> 'platform' THEN
    RAISE EXCEPTION
      'support_access_requests refused: requester % is a %-scope link, and support access '
      'is a PLATFORM delegation — a dealership link cannot request it',
      NEW.requester_user_link_id, scope;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_sar_requester_is_platform
  BEFORE INSERT OR UPDATE ON support_access_requests
  FOR EACH ROW EXECUTE FUNCTION support_request_requester_is_platform();

-- The session actor must be a REAL platform-scope link, independently: the
-- composite FK ties the actor to the requester, but this rule must refuse a
-- dealership actor even if that FK is dropped.
CREATE OR REPLACE FUNCTION support_session_actor_is_platform() RETURNS TRIGGER AS $$
DECLARE scope text;
BEGIN
  SELECT ul.actor_scope INTO scope FROM user_links ul
   WHERE ul.user_link_id = NEW.actor_user_link_id;
  IF scope IS NULL THEN RETURN NEW; END IF;
  IF scope <> 'platform' THEN
    RAISE EXCEPTION
      'support_access_sessions refused: actor % is a %-scope link, and a support session '
      'is a PLATFORM delegation — a dealership link cannot hold one',
      NEW.actor_user_link_id, scope;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_sas_actor_is_platform
  BEFORE INSERT OR UPDATE ON support_access_sessions
  FOR EACH ROW EXECUTE FUNCTION support_session_actor_is_platform();

-- ────────────────────────────────────────────────────────────────────────────
-- Section 2 — A SESSION MAY NOT EXCEED OR PRECEDE ITS APPROVAL (§3.2)
-- ────────────────────────────────────────────────────────────────────────────

-- Request authority fields are IMMUTABLE. What a delegation is FOR — its
-- tenant, requester, actions, scope and duration — is fixed at filing, and the
-- approval identity is fixed at decision. Status transitions, supersession
-- bookkeeping and attribution columns stay mutable: they record what HAPPENED
-- to the request, not what it asked for.
CREATE OR REPLACE FUNCTION support_request_authority_is_immutable() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.requester_user_link_id IS DISTINCT FROM OLD.requester_user_link_id
     OR NEW.requested_actions IS DISTINCT FROM OLD.requested_actions
     OR NEW.scope_level IS DISTINCT FROM OLD.scope_level
     OR NEW.scope_id IS DISTINCT FROM OLD.scope_id
     OR NEW.requested_duration_minutes IS DISTINCT FROM OLD.requested_duration_minutes THEN
    RAISE EXCEPTION
      'support_access_requests refused: tenant, requester, actions, scope and duration are '
      'the AUTHORITY of request % and are immutable — file a new request instead',
      OLD.request_id;
  END IF;
  -- The approval identity may be SET once (the decision) and never moved.
  IF (OLD.decided_at IS NOT NULL AND NEW.decided_at IS DISTINCT FROM OLD.decided_at)
     OR (OLD.decided_by_user_link_id IS NOT NULL
         AND NEW.decided_by_user_link_id IS DISTINCT FROM OLD.decided_by_user_link_id)
     OR (OLD.approval_grant_id IS NOT NULL
         AND NEW.approval_grant_id IS DISTINCT FROM OLD.approval_grant_id) THEN
    RAISE EXCEPTION
      'support_access_requests refused: the approval identity of request % (decider, '
      'instant, grant) is written once by the decision and is immutable — supersede the '
      'approval through the documented path instead',
      OLD.request_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_sar_authority_immutable
  BEFORE UPDATE ON support_access_requests
  FOR EACH ROW EXECUTE FUNCTION support_request_authority_is_immutable();

-- Session authority fields are IMMUTABLE: which delegation, which tenant,
-- which actor, and the exact window. The lifecycle columns (revoked_at,
-- expired_at, their attributions) remain the mutable part — they END access,
-- they never widen it.
CREATE OR REPLACE FUNCTION support_session_authority_is_immutable() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.request_id IS DISTINCT FROM OLD.request_id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.actor_user_link_id IS DISTINCT FROM OLD.actor_user_link_id
     OR NEW.granted_at IS DISTINCT FROM OLD.granted_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION
      'support_access_sessions refused: request, tenant, actor and window are the '
      'AUTHORITY of session % and are immutable — revoke it and start another',
      OLD.support_session_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_sas_authority_immutable
  BEFORE UPDATE ON support_access_sessions
  FOR EACH ROW EXECUTE FUNCTION support_session_authority_is_immutable();

-- The window is BOUNDED BY THE APPROVAL, judged where the session is written.
CREATE OR REPLACE FUNCTION support_session_is_bounded_by_its_approval() RETURNS TRIGGER AS $$
DECLARE r support_access_requests%ROWTYPE;
BEGIN
  SELECT * INTO r FROM support_access_requests WHERE request_id = NEW.request_id;
  -- Existence is the foreign key's job.
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF r.status <> 'approved' OR r.decided_at IS NULL THEN
    RAISE EXCEPTION
      'support_access_sessions refused: request % is %, and a session exists only under an '
      'approved, decided request',
      NEW.request_id, r.status;
  END IF;
  IF NEW.granted_at < r.decided_at THEN
    RAISE EXCEPTION
      'support_access_sessions refused: session granted at % precedes the approval decided '
      'at % — a session cannot begin before its approval',
      NEW.granted_at, r.decided_at;
  END IF;
  IF NEW.expires_at > NEW.granted_at + make_interval(mins => r.requested_duration_minutes) THEN
    RAISE EXCEPTION
      'support_access_sessions refused: session expiring at % exceeds the % minute(s) the '
      'request actually asked for (granted at %) — an approval of one minute cannot '
      'produce a longer session',
      NEW.expires_at, r.requested_duration_minutes, NEW.granted_at;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_sas_bounded_by_approval
  BEFORE INSERT ON support_access_sessions
  FOR EACH ROW EXECUTE FUNCTION support_session_is_bounded_by_its_approval();

-- The approval grant IS the approval — judged where the approval is written,
-- not only where the grant is consumed. 057's composite foreign keys already
-- pin the grant to this tenant and this decider; the four facts below were
-- enforced only by `consumeReauthenticationGrantReturningId` until now, and a
-- schema whose rule lives only in one calling function is a schema that trusts
-- every other caller.
CREATE OR REPLACE FUNCTION support_approval_grant_is_the_approval() RETURNS TRIGGER AS $$
DECLARE g reauthentication_grants%ROWTYPE;
BEGIN
  IF NEW.approval_grant_id IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND NEW.approval_grant_id IS NOT DISTINCT FROM OLD.approval_grant_id THEN
    -- Already judged when it was set; later status transitions re-fire this
    -- trigger without re-litigating a grant that has not moved.
    RETURN NEW;
  END IF;
  SELECT * INTO g FROM reauthentication_grants WHERE grant_id = NEW.approval_grant_id;
  -- Existence is the foreign key's job.
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF g.action <> 'identity.support.approve' THEN
    RAISE EXCEPTION
      'support_access_requests refused: grant % was minted for action %, and only an '
      'identity.support.approve grant approves a support request',
      NEW.approval_grant_id, g.action;
  END IF;
  IF g.resource_type IS DISTINCT FROM 'support_access_request'
     OR g.resource_id IS DISTINCT FROM NEW.request_id THEN
    RAISE EXCEPTION
      'support_access_requests refused: grant % names resource %:%, and this approval is '
      'of support_access_request % — a grant approves exactly the request it names',
      NEW.approval_grant_id, COALESCE(g.resource_type, '<none>'),
      COALESCE(g.resource_id::text, '<none>'), NEW.request_id;
  END IF;
  IF g.assurance_level <> 'fresh_and_mfa_policy' THEN
    RAISE EXCEPTION
      'support_access_requests refused: grant % was issued at assurance %, and approving '
      'support access requires fresh_and_mfa_policy',
      NEW.approval_grant_id, g.assurance_level;
  END IF;
  IF g.mfa_policy_certified_at_issue IS DISTINCT FROM true THEN
    RAISE EXCEPTION
      'support_access_requests refused: grant % was issued without MFA policy certification, '
      'and approving support access requires it',
      NEW.approval_grant_id;
  END IF;
  -- §3.2's scope clause: a non-tenant approved scope must exist, belong to this
  -- request's tenant, and stand on a fully active, in-window ancestor chain at
  -- the instant of approval.
  IF NEW.status = 'approved' AND NEW.scope_level <> 'tenant' THEN
    DECLARE defect text;
    BEGIN
      defect := org_chain_defect(NEW.tenant_id, NEW.scope_level, NEW.scope_id,
                                 clock_timestamp());
      IF defect IS NOT NULL THEN
        RAISE EXCEPTION
          'support_access_requests refused: approved scope %:% of request % is not an '
          'effective node of tenant % (%) — an approval cannot delegate a scope that does '
          'not effectively exist',
          NEW.scope_level, COALESCE(NEW.scope_id::text, '<none>'), NEW.request_id,
          NEW.tenant_id, defect;
      END IF;
    END;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_sar_grant_is_the_approval
  BEFORE INSERT OR UPDATE ON support_access_requests
  FOR EACH ROW EXECUTE FUNCTION support_approval_grant_is_the_approval();

-- ────────────────────────────────────────────────────────────────────────────
-- Section 3 — ONE DATABASE AUTHORITY FOR EFFECTIVE ANCESTRY (§3.5)
--
-- `org_ancestry_all` answers STRUCTURE: the node's chain, tenant first, leaf
-- last, with each node's status and window — or no rows when the node does not
-- exist in that tenant (parentage included; a chain with a missing ancestor is
-- no chain). It makes NO time judgment.
--
-- `org_chain_defect` answers EFFECTIVENESS at an instant, over that structure:
-- NULL when the whole chain (tenant included) is active and in-window at
-- `p_at`, else one short reason naming the first defective node.
--
-- `org_ancestry_effective` is the runtime's shape: the chain when it is fully
-- effective, no rows otherwise. `packages/organization/src/repository.ts`
-- resolves through it, and every evidence validator below judges through
-- `org_chain_defect` — one authority, several callers, zero restatements.
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION org_ancestry_all(p_tenant uuid, p_level text, p_id uuid)
RETURNS TABLE(depth int, level text, node_id uuid, status text,
              effective_from timestamptz, effective_to timestamptz) AS $$
BEGIN
  IF p_level = 'tenant' THEN
    -- The tenant names itself; a non-null id must BE the tenant.
    IF p_id IS NOT NULL AND p_id <> p_tenant THEN RETURN; END IF;
    RETURN QUERY
      SELECT 1, 'tenant'::text, t.tenant_id, t.status, t.effective_from, t.effective_to
        FROM tenants t WHERE t.tenant_id = p_tenant;
  ELSIF p_level = 'dealer_group' THEN
    RETURN QUERY
      SELECT x.d, x.l, x.i, x.s, x.f, x.e FROM (
        SELECT 1 AS d, 'tenant'::text AS l, t.tenant_id AS i, t.status AS s,
               t.effective_from AS f, t.effective_to AS e
          FROM tenants t
          JOIN dealer_groups dg ON dg.tenant_id = t.tenant_id
         WHERE t.tenant_id = p_tenant AND dg.dealer_group_id = p_id
        UNION ALL
        SELECT 2, 'dealer_group', dg.dealer_group_id, dg.status,
               dg.effective_from, dg.effective_to
          FROM dealer_groups dg
         WHERE dg.tenant_id = p_tenant AND dg.dealer_group_id = p_id
      ) x ORDER BY x.d;
  ELSIF p_level = 'legal_entity' THEN
    RETURN QUERY
      SELECT x.d, x.l, x.i, x.s, x.f, x.e FROM (
        SELECT 1 AS d, 'tenant'::text AS l, t.tenant_id AS i, t.status AS s,
               t.effective_from AS f, t.effective_to AS e
          FROM tenants t
          JOIN legal_entities le ON le.tenant_id = t.tenant_id
         WHERE t.tenant_id = p_tenant AND le.legal_entity_id = p_id
        UNION ALL
        SELECT 2, 'dealer_group', dg.dealer_group_id, dg.status,
               dg.effective_from, dg.effective_to
          FROM legal_entities le
          JOIN dealer_groups dg
            ON dg.tenant_id = le.tenant_id AND dg.dealer_group_id = le.dealer_group_id
         WHERE le.tenant_id = p_tenant AND le.legal_entity_id = p_id
        UNION ALL
        SELECT 3, 'legal_entity', le.legal_entity_id, le.status,
               le.effective_from, le.effective_to
          FROM legal_entities le
         WHERE le.tenant_id = p_tenant AND le.legal_entity_id = p_id
      ) x ORDER BY x.d;
  ELSIF p_level = 'rooftop' THEN
    RETURN QUERY
      SELECT x.d, x.l, x.i, x.s, x.f, x.e FROM (
        SELECT 1 AS d, 'tenant'::text AS l, t.tenant_id AS i, t.status AS s,
               t.effective_from AS f, t.effective_to AS e
          FROM tenants t
          JOIN rooftops rt ON rt.tenant_id = t.tenant_id
         WHERE t.tenant_id = p_tenant AND rt.rooftop_id = p_id
        UNION ALL
        SELECT 2, 'dealer_group', dg.dealer_group_id, dg.status,
               dg.effective_from, dg.effective_to
          FROM rooftops rt
          JOIN legal_entities le
            ON le.tenant_id = rt.tenant_id AND le.legal_entity_id = rt.legal_entity_id
          JOIN dealer_groups dg
            ON dg.tenant_id = le.tenant_id AND dg.dealer_group_id = le.dealer_group_id
         WHERE rt.tenant_id = p_tenant AND rt.rooftop_id = p_id
        UNION ALL
        SELECT 3, 'legal_entity', le.legal_entity_id, le.status,
               le.effective_from, le.effective_to
          FROM rooftops rt
          JOIN legal_entities le
            ON le.tenant_id = rt.tenant_id AND le.legal_entity_id = rt.legal_entity_id
         WHERE rt.tenant_id = p_tenant AND rt.rooftop_id = p_id
        UNION ALL
        SELECT 4, 'rooftop', rt.rooftop_id, rt.status, rt.effective_from, rt.effective_to
          FROM rooftops rt
         WHERE rt.tenant_id = p_tenant AND rt.rooftop_id = p_id
      ) x ORDER BY x.d;
  ELSIF p_level = 'department' THEN
    RETURN QUERY
      SELECT x.d, x.l, x.i, x.s, x.f, x.e FROM (
        SELECT 1 AS d, 'tenant'::text AS l, t.tenant_id AS i, t.status AS s,
               t.effective_from AS f, t.effective_to AS e
          FROM tenants t
          JOIN departments dp ON dp.tenant_id = t.tenant_id
         WHERE t.tenant_id = p_tenant AND dp.department_id = p_id
        UNION ALL
        SELECT 2, 'dealer_group', dg.dealer_group_id, dg.status,
               dg.effective_from, dg.effective_to
          FROM departments dp
          JOIN rooftops rt ON rt.tenant_id = dp.tenant_id AND rt.rooftop_id = dp.rooftop_id
          JOIN legal_entities le
            ON le.tenant_id = rt.tenant_id AND le.legal_entity_id = rt.legal_entity_id
          JOIN dealer_groups dg
            ON dg.tenant_id = le.tenant_id AND dg.dealer_group_id = le.dealer_group_id
         WHERE dp.tenant_id = p_tenant AND dp.department_id = p_id
        UNION ALL
        SELECT 3, 'legal_entity', le.legal_entity_id, le.status,
               le.effective_from, le.effective_to
          FROM departments dp
          JOIN rooftops rt ON rt.tenant_id = dp.tenant_id AND rt.rooftop_id = dp.rooftop_id
          JOIN legal_entities le
            ON le.tenant_id = rt.tenant_id AND le.legal_entity_id = rt.legal_entity_id
         WHERE dp.tenant_id = p_tenant AND dp.department_id = p_id
        UNION ALL
        SELECT 4, 'rooftop', rt.rooftop_id, rt.status, rt.effective_from, rt.effective_to
          FROM departments dp
          JOIN rooftops rt ON rt.tenant_id = dp.tenant_id AND rt.rooftop_id = dp.rooftop_id
         WHERE dp.tenant_id = p_tenant AND dp.department_id = p_id
        UNION ALL
        SELECT 5, 'department', dp.department_id, dp.status,
               dp.effective_from, dp.effective_to
          FROM departments dp
         WHERE dp.tenant_id = p_tenant AND dp.department_id = p_id
      ) x ORDER BY x.d;
  END IF;
  -- An unknown level yields no rows: deny, never guess.
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION org_chain_defect(p_tenant uuid, p_level text, p_id uuid,
                                            p_at timestamptz)
RETURNS text AS $$
-- The chain-length variable is deliberately NOT named `found`: a variable of
-- that name would SHADOW PL/pgSQL's own FOUND automatic, and the test below
-- would then be reading a row count where it meant to read "did the last
-- query return anything" — which is exactly the bug the first draft of this
-- function had.
DECLARE expected  int;
        chain_len int;
        bad       record;
BEGIN
  expected := CASE p_level
    WHEN 'tenant' THEN 1 WHEN 'dealer_group' THEN 2 WHEN 'legal_entity' THEN 3
    WHEN 'rooftop' THEN 4 WHEN 'department' THEN 5 ELSE NULL END;
  IF expected IS NULL THEN RETURN 'unknown organization level ' || COALESCE(p_level, '<null>'); END IF;
  SELECT COUNT(*) INTO chain_len FROM org_ancestry_all(p_tenant, p_level, p_id);
  IF chain_len < expected THEN
    RETURN format('node %s:%s does not exist in tenant %s (or its parent chain is broken)',
                  p_level, COALESCE(p_id::text, '<none>'), p_tenant);
  END IF;
  SELECT a.level, a.node_id, a.status, a.effective_from, a.effective_to INTO bad
    FROM org_ancestry_all(p_tenant, p_level, p_id) a
   WHERE a.status <> 'active'
      OR a.effective_from > p_at
      OR (a.effective_to IS NOT NULL AND a.effective_to <= p_at)
   ORDER BY a.depth
   LIMIT 1;
  IF FOUND THEN
    RETURN format('%s %s is %s with window [%s, %s) at %s',
                  bad.level, bad.node_id, bad.status, bad.effective_from,
                  COALESCE(bad.effective_to::text, 'open'), p_at);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION org_ancestry_effective(p_tenant uuid, p_level text, p_id uuid,
                                                  p_at timestamptz DEFAULT clock_timestamp())
RETURNS TABLE(level text, node_id uuid) AS $$
BEGIN
  IF org_chain_defect(p_tenant, p_level, p_id, p_at) IS NOT NULL THEN RETURN; END IF;
  RETURN QUERY SELECT a.level, a.node_id
    FROM org_ancestry_all(p_tenant, p_level, p_id) a ORDER BY a.depth;
END;
$$ LANGUAGE plpgsql STABLE;

-- ────────────────────────────────────────────────────────────────────────────
-- Section 4 — THE RESOURCE-SCOPE REGISTRY (§3.4)
--
-- The ONE mapping from a Fixed Ops resource to the rooftop it lives under.
-- `packages/fixed-ops/src/security/scope-resolver.ts` now CALLS this function
-- rather than owning a TypeScript copy of the same table list, so the runtime
-- resolver and the evidence validator cannot disagree. Tenant-scoped
-- throughout: a foreign tenant's resource and a nonexistent one are the same
-- NULL, and an unknown resource type resolves to nothing — deny, never guess.
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION resource_org_leaf(p_tenant uuid, p_type text, p_id uuid)
RETURNS uuid AS $$
DECLARE leaf uuid;
BEGIN
  IF p_type = 'service_appointment' THEN
    SELECT t.location_id INTO leaf FROM service_appointments t
     WHERE t.tenant_id = p_tenant AND t.appointment_id = p_id;
  ELSIF p_type = 'repair_order' THEN
    SELECT t.location_id INTO leaf FROM repair_orders t
     WHERE t.tenant_id = p_tenant AND t.ro_id = p_id;
  ELSIF p_type = 'service_queue_item' THEN
    SELECT t.location_id INTO leaf FROM service_queue_items t
     WHERE t.tenant_id = p_tenant AND t.queue_item_id = p_id;
  ELSIF p_type = 'service_waitlist_entry' THEN
    SELECT t.location_id INTO leaf FROM service_waitlist_entries t
     WHERE t.tenant_id = p_tenant AND t.waitlist_entry_id = p_id;
  ELSIF p_type = 'mpi_session' THEN
    SELECT ro.location_id INTO leaf FROM mpi_sessions t
      JOIN repair_orders ro ON ro.tenant_id = t.tenant_id AND ro.ro_id = t.ro_id
     WHERE t.tenant_id = p_tenant AND t.mpi_session_id = p_id;
  ELSIF p_type = 'ro_line_item' THEN
    SELECT ro.location_id INTO leaf FROM ro_line_items t
      JOIN repair_orders ro ON ro.tenant_id = t.tenant_id AND ro.ro_id = t.ro_id
     WHERE t.tenant_id = p_tenant AND t.line_item_id = p_id;
  ELSIF p_type = 'ro_parts_line' THEN
    SELECT ro.location_id INTO leaf FROM ro_parts_lines t
      JOIN repair_orders ro ON ro.tenant_id = t.tenant_id AND ro.ro_id = t.ro_id
     WHERE t.tenant_id = p_tenant AND t.part_line_id = p_id;
  ELSIF p_type = 'ro_sublet_job' THEN
    SELECT ro.location_id INTO leaf FROM ro_sublet_jobs t
      JOIN repair_orders ro ON ro.tenant_id = t.tenant_id AND ro.ro_id = t.ro_id
     WHERE t.tenant_id = p_tenant AND t.sublet_job_id = p_id;
  ELSIF p_type = 'service_portal_task' THEN
    SELECT ro.location_id INTO leaf FROM service_portal_tasks t
      JOIN repair_orders ro ON ro.tenant_id = t.tenant_id AND ro.ro_id = t.ro_id
     WHERE t.tenant_id = p_tenant AND t.portal_task_id = p_id;
  ELSIF p_type = 'tech_work_ticket' THEN
    SELECT ro.location_id INTO leaf FROM tech_work_tickets t
      JOIN repair_orders ro ON ro.tenant_id = t.tenant_id AND ro.ro_id = t.ro_id
     WHERE t.tenant_id = p_tenant AND t.ticket_id = p_id;
  ELSIF p_type = 'warranty_claim' THEN
    SELECT ro.location_id INTO leaf FROM warranty_claims t
      JOIN repair_orders ro ON ro.tenant_id = t.tenant_id AND ro.ro_id = t.ro_id
     WHERE t.tenant_id = p_tenant AND t.claim_id = p_id;
  ELSIF p_type = 'comeback_case' THEN
    SELECT ro.location_id INTO leaf FROM comeback_cases t
      JOIN repair_orders ro ON ro.tenant_id = t.tenant_id AND ro.ro_id = t.original_ro_id
     WHERE t.tenant_id = p_tenant AND t.comeback_id = p_id;
  END IF;
  RETURN leaf;
END;
$$ LANGUAGE plpgsql STABLE;

-- The persisted, database-validated leaf snapshot (filled by the Section 5
-- trigger for version-4 allows on resources), and the separated control-plane
-- target-tenant metadata (§3.3): both new columns are NULL across all history.
ALTER TABLE policy_decisions
  ADD COLUMN resource_rooftop_id uuid,
  ADD COLUMN control_plane_target_tenant_id uuid REFERENCES tenants(tenant_id);

-- The snapshot is a rooftop OF THE DECISION'S OWN TENANT, referentially.
ALTER TABLE policy_decisions
  ADD CONSTRAINT pd_resource_rooftop_in_tenant
  FOREIGN KEY (tenant_id, resource_rooftop_id)
  REFERENCES rooftops (tenant_id, rooftop_id);

-- ────────────────────────────────────────────────────────────────────────────
-- Section 5 — VERSION-4 EVIDENCE RULES (§3.1, §3.3, §3.4, §3.5, §3.6)
-- ────────────────────────────────────────────────────────────────────────────

-- §3.3, structural, no action names anywhere:
--   * a platform-support ALLOW naming an authorization tenant is DELEGATED or
--     refused, whatever the action is called;
ALTER TABLE policy_decisions
  ADD CONSTRAINT pd_v4_support_tenant_allow_is_delegated
  CHECK (evidence_version < 4 OR decision = 'deny' OR actor_type <> 'platform_support'
         OR tenant_id IS NULL OR support_session_id IS NOT NULL);

--   * a control-plane decision IS platform-scoped, names NO authorization
--     tenant and carries NO customer-resource payload;
ALTER TABLE policy_decisions
  ADD CONSTRAINT pd_v4_control_plane_is_structural
  CHECK (evidence_version < 4 OR scope_level IS DISTINCT FROM 'platform'
         OR (tenant_id IS NULL AND resource_type IS NULL AND resource_id IS NULL));

--   * the operational target tenant of a control-plane action is METADATA,
--     stored apart from the authorization-bound tenant and only there;
ALTER TABLE policy_decisions
  ADD CONSTRAINT pd_v4_target_tenant_is_metadata
  CHECK (control_plane_target_tenant_id IS NULL OR scope_level = 'platform');

--   * and the v2 completeness rule's name-based branch is replaced by the
--     structural one for current evidence: an identified actor's decision
--     names a tenant unless it is a deny or a platform-scoped decision.
ALTER TABLE policy_decisions
  ADD CONSTRAINT pd_v4_identified_actor_names_a_tenant
  CHECK (evidence_version < 4 OR actor_type = 'system' OR decision = 'deny'
         OR tenant_id IS NOT NULL OR scope_level = 'platform');

-- §3.4: a version-4 resource ALLOW carries its database-validated leaf.
ALTER TABLE policy_decisions
  ADD CONSTRAINT pd_v4_resource_allow_names_its_rooftop
  CHECK (evidence_version < 4 OR decision = 'deny' OR resource_type IS NULL
         OR resource_rooftop_id IS NOT NULL);

-- The BEFORE INSERT judge for version-4 rows: real actor scope, resolved and
-- validated resource leaf, an effective organization chain at the actual write
-- instant, and an `occurred_at` that is consistent with that instant.
CREATE OR REPLACE FUNCTION policy_decisions_v4_structural_validity() RETURNS TRIGGER AS $$
DECLARE actor_scope text;
        resolved_leaf uuid;
        chain_defect text;
        write_instant timestamptz;
BEGIN
  IF NEW.evidence_version < 4 THEN RETURN NEW; END IF;
  write_instant := clock_timestamp();

  -- §3.6: `occurred_at` is CHECKED FOR CONSISTENCY with the actual write
  -- instant — it may trail it by the length of a long transaction, never lead
  -- it, and never sit further back than an hour. It is deliberately NOT used
  -- by any liveness judgment below or in the other validators: a recorded
  -- instant is a claim, and claims do not get to date-stamp authority.
  IF NEW.occurred_at > write_instant + INTERVAL '5 seconds' THEN
    RAISE EXCEPTION
      'policy_decisions INSERT refused: occurred_at % is in the future of the actual write '
      'instant % — evidence cannot predate itself',
      NEW.occurred_at, write_instant;
  END IF;
  IF NEW.occurred_at < write_instant - INTERVAL '1 hour' THEN
    RAISE EXCEPTION
      'policy_decisions INSERT refused: occurred_at % is more than an hour before the '
      'actual write instant % — a backdated occurrence cannot stand in for authority that '
      'must be live at insertion',
      NEW.occurred_at, write_instant;
  END IF;

  -- §3.1: the actor-type LABEL must be the actor's REAL scope.
  IF NEW.actor_user_link_id IS NOT NULL AND NEW.actor_type <> 'system' THEN
    SELECT ul.actor_scope INTO actor_scope FROM user_links ul
     WHERE ul.user_link_id = NEW.actor_user_link_id;
    IF actor_scope IS NOT NULL THEN
      IF NEW.actor_type = 'platform_support' AND actor_scope <> 'platform' THEN
        RAISE EXCEPTION
          'policy_decisions INSERT refused: actor % is a %-scope link and cannot be '
          'recorded as a platform-support actor — the label is bound to the real scope',
          NEW.actor_user_link_id, actor_scope;
      END IF;
      IF NEW.actor_type = 'user' AND actor_scope <> 'dealership' THEN
        RAISE EXCEPTION
          'policy_decisions INSERT refused: actor % is a %-scope link and cannot be '
          'recorded as a dealership user — the label is bound to the real scope',
          NEW.actor_user_link_id, actor_scope;
      END IF;
    END IF;
  END IF;

  -- §3.4: an ALLOW on a resource resolves that resource through the registry,
  -- in this tenant, at this instant — and the persisted snapshot is the
  -- DATABASE'S resolution, never an unvalidated caller value.
  IF NEW.decision = 'allow' AND NEW.resource_type IS NOT NULL AND NEW.tenant_id IS NOT NULL THEN
    resolved_leaf := resource_org_leaf(NEW.tenant_id, NEW.resource_type, NEW.resource_id);
    IF resolved_leaf IS NULL THEN
      RAISE EXCEPTION
        'policy_decisions INSERT refused: resource %:% does not resolve to an organization '
        'node in tenant % — a nonexistent or foreign resource authorizes nothing',
        NEW.resource_type, NEW.resource_id, NEW.tenant_id;
    END IF;
    IF NEW.resource_rooftop_id IS NOT NULL AND NEW.resource_rooftop_id <> resolved_leaf THEN
      RAISE EXCEPTION
        'policy_decisions INSERT refused: the supplied resource rooftop % is not the '
        'database''s own resolution % for resource %:% — a caller-supplied scope column '
        'is validated, never trusted',
        NEW.resource_rooftop_id, resolved_leaf, NEW.resource_type, NEW.resource_id;
    END IF;
    NEW.resource_rooftop_id := resolved_leaf;
    -- The resource's own chain must be effective at the write instant.
    chain_defect := org_chain_defect(NEW.tenant_id, 'rooftop', resolved_leaf, write_instant);
    IF chain_defect IS NOT NULL THEN
      RAISE EXCEPTION
        'policy_decisions INSERT refused: the organization chain above resource %:% is not '
        'effective at the write instant (%) — authority must stand on an active chain',
        NEW.resource_type, NEW.resource_id, chain_defect;
    END IF;
  END IF;

  -- §3.5: an ALLOW recorded at an organization scope must stand on a fully
  -- active, in-window chain — tenant included — at the actual write instant.
  IF NEW.decision = 'allow' AND NEW.tenant_id IS NOT NULL
     AND NEW.scope_level IN ('tenant', 'dealer_group', 'legal_entity', 'rooftop', 'department') THEN
    chain_defect := org_chain_defect(
      NEW.tenant_id, NEW.scope_level,
      CASE WHEN NEW.scope_level = 'tenant' THEN NEW.tenant_id ELSE NEW.scope_id END,
      write_instant);
    IF chain_defect IS NOT NULL THEN
      RAISE EXCEPTION
        'policy_decisions INSERT refused: the decision''s organization scope %:% is not '
        'effective at the write instant (%) — authority must stand on an active chain',
        NEW.scope_level, COALESCE(NEW.scope_id::text, '<tenant>'), chain_defect;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_policy_decisions_v4_structure
  BEFORE INSERT ON policy_decisions
  FOR EACH ROW EXECUTE FUNCTION policy_decisions_v4_structural_validity();

-- The version-4 additions to the CHILD applicability judgment. The 058
-- function `policy_decision_binding_is_applicable` stays exactly as 058 wrote
-- it — every one of its predicates is pinned by its own database-control
-- mutation, and this migration neither edits its file nor replaces its body.
-- The new rules are a SECOND trigger on the same table, judged independently:
--
--   * §3.6 — the binding must be live at the ACTUAL WRITE INSTANT, not at the
--     transaction start the 058 checks (correctly, for their era) used;
--   * §3.4 — on a resource decision, an organization-scope binding must sit on
--     the RESOURCE'S OWN ancestor chain, which the parent row now carries as
--     its database-validated rooftop snapshot.
CREATE OR REPLACE FUNCTION policy_decision_binding_is_live_and_reaches_the_resource()
RETURNS TRIGGER AS $$
DECLARE rb role_bindings%ROWTYPE;
        d  policy_decisions%ROWTYPE;
        write_instant timestamptz;
BEGIN
  SELECT * INTO rb FROM role_bindings WHERE role_binding_id = NEW.role_binding_id;
  IF NOT FOUND THEN RETURN NEW; END IF; -- pdmb_binding_belongs_to_the_actor
  SELECT * INTO d FROM policy_decisions WHERE decision_id = NEW.decision_id;
  IF NOT FOUND THEN RETURN NEW; END IF; -- pdmb_decision_names_this_actor
  IF d.evidence_version < 4 THEN RETURN NEW; END IF;
  write_instant := clock_timestamp();

  -- §3.6: LIVE AT THE WRITE INSTANT. `NOW()` is the transaction-start clock; a
  -- custody transaction opened one second before a binding's window closed
  -- could write evidence after it had. The wall clock, read here, cannot.
  IF rb.effective_from > write_instant
     OR (rb.effective_to IS NOT NULL AND rb.effective_to <= write_instant) THEN
    RAISE EXCEPTION
      'policy evidence refused: matched binding % is outside its effective window at the '
      'actual write instant % — a transaction that outlived its authority records nothing',
      NEW.role_binding_id, write_instant;
  END IF;

  -- §3.4: ON A RESOURCE DECISION, THE BINDING REACHES THE RESOURCE'S CHAIN.
  -- The parent row's rooftop snapshot is the database's own resolution (the
  -- Section 5 parent trigger wrote it); an organization-scope binding is
  -- admissible only if its node is ON that resource's effective chain. A
  -- resource-scope binding is judged by 058's exact-match rule and a platform
  -- binding by 058's platform rule; neither is re-judged here.
  IF d.resource_type IS NOT NULL AND d.resource_rooftop_id IS NOT NULL
     AND rb.scope_level IN ('tenant', 'dealer_group', 'legal_entity', 'rooftop', 'department') THEN
    IF NOT EXISTS (
      SELECT 1 FROM org_ancestry_effective(d.tenant_id, 'rooftop', d.resource_rooftop_id,
                                           write_instant) chain
       WHERE chain.level = rb.scope_level
         AND chain.node_id = CASE WHEN rb.scope_level = 'tenant' THEN d.tenant_id
                                  ELSE rb.scope_id END
    ) THEN
      RAISE EXCEPTION
        'policy evidence refused: matched binding % at %:% is not on the ancestor chain of '
        'resource %:% (rooftop %) — a binding at one node never authorizes a sibling''s '
        'resources',
        NEW.role_binding_id, rb.scope_level, COALESCE(rb.scope_id::text, '<tenant>'),
        d.resource_type, d.resource_id, d.resource_rooftop_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_pdmb_live_and_reaches_the_resource
  BEFORE INSERT ON policy_decision_matched_bindings
  FOR EACH ROW EXECUTE FUNCTION policy_decision_binding_is_live_and_reaches_the_resource();

-- §3.6 for DELEGATED evidence: the support session must be UNEXPIRED at the
-- actual write instant. 057/058 proved the recorded window IS the session's
-- window, but the window was judged against `occurred_at` — a claim — so a
-- backdated occurrence could stand inside a window the wall clock had left.
-- A second trigger, not an edit to 058's.
--
-- REVOCATION is deliberately NOT re-checked here. 058's
-- `policy_decisions_support_evidence_is_the_approval` already refuses a
-- revoked session, that predicate involves no clock (`revoked_at IS NOT NULL`
-- is the same fact at transaction start and at the write instant), and its
-- trigger fires before this one — a second copy of the same question would be
-- a predicate no test could ever isolate, which §5's mutation bar rightly
-- refuses to carry.
CREATE OR REPLACE FUNCTION policy_decisions_support_session_is_live() RETURNS TRIGGER AS $$
DECLARE s support_access_sessions%ROWTYPE;
        write_instant timestamptz;
BEGIN
  IF NEW.evidence_version < 4 OR NEW.support_session_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO s FROM support_access_sessions
   WHERE support_session_id = NEW.support_session_id;
  IF NOT FOUND THEN RETURN NEW; END IF; -- pd_support_evidence_tuple
  write_instant := clock_timestamp();
  IF s.expires_at <= write_instant THEN
    RAISE EXCEPTION
      'policy_decisions INSERT refused: support session % expired at % and the actual '
      'write instant is % — a backdated occurred_at cannot revive it',
      NEW.support_session_id, s.expires_at, write_instant;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_policy_decisions_support_live
  BEFORE INSERT ON policy_decisions
  FOR EACH ROW EXECUTE FUNCTION policy_decisions_support_session_is_live();

-- ────────────────────────────────────────────────────────────────────────────
-- Section 6 — EVIDENCE VERSION 4 (§4)
-- ────────────────────────────────────────────────────────────────────────────

-- The known-version set grows; nothing else about history moves.
ALTER TABLE policy_decisions DROP CONSTRAINT pd_evidence_version_known;
ALTER TABLE policy_decisions
  ADD CONSTRAINT pd_evidence_version_known CHECK (evidence_version IN (1, 2, 3, 4));

-- New decisions carry the current version BY DEFAULT — the schema is the one
-- authority on what "current" means, and the engine's INSERT deliberately
-- omits the column so it cannot disagree.
ALTER TABLE policy_decisions ALTER COLUMN evidence_version SET DEFAULT 4;

-- …and the floor for NEW decisions moves to 4, exactly as 058 moved it to 3.
CREATE OR REPLACE FUNCTION policy_decisions_require_current_evidence() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.evidence_version < 4 THEN
    RAISE EXCEPTION
      'policy_decisions INSERT refused: evidence_version % is below the current minimum 4 '
      '(historic rows keep their version; new decisions must carry complete evidence, '
      'including the database-validated resource scope and structurally-judged authority '
      'this version adds)',
      NEW.evidence_version;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ────────────────────────────────────────────────────────────────────────────
-- Section 7 — DATABASE-OWNED NORMALIZATION AND THE RUNTIME ROLE (§3.7)
-- ────────────────────────────────────────────────────────────────────────────

-- The two roles. NOLOGIN: connections are made by a login user that is granted
-- `dealership_runtime` and assumes it (`SET ROLE`); nothing can log in AS the
-- evidence owner, and the runtime role is not a member of it.
DO $$
BEGIN
  BEGIN
    CREATE ROLE dealership_evidence_owner NOLOGIN;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
  BEGIN
    CREATE ROLE dealership_runtime NOLOGIN;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
END $$;

-- The runtime role's working surface: every application table except the
-- normalized-evidence child, plus sequences and function execution. The child
-- table gets NO direct DML — reading evidence is fine, writing it is the
-- database's own act.
GRANT USAGE ON SCHEMA public TO dealership_runtime, dealership_evidence_owner;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO dealership_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO dealership_runtime;
REVOKE INSERT, UPDATE, DELETE ON policy_decision_matched_bindings FROM dealership_runtime;
REVOKE ALL ON policy_decision_matched_bindings FROM PUBLIC;
GRANT SELECT ON policy_decision_matched_bindings TO dealership_runtime;

-- The evidence owner reads what its validators need and writes exactly the
-- child table.
GRANT SELECT ON ALL TABLES IN SCHEMA public TO dealership_evidence_owner;
GRANT INSERT ON policy_decision_matched_bindings TO dealership_evidence_owner;

-- THE GUC IS GONE AS AUTHORIZATION. 058's writer guard compared a
-- caller-settable setting to the inserted row — any session could
-- `set_config('policy_evidence.normalizing_decision', …)` and walk through.
-- The guard trigger and its function are dropped; what replaces them is not a
-- cleverer check but the privilege system itself: the runtime role simply
-- cannot INSERT this table, and the only non-superuser that can is the owner
-- of the normalization function below.
DROP TRIGGER trg_pdmb_authorized_writer ON policy_decision_matched_bindings;
DROP FUNCTION policy_decision_matched_bindings_have_one_writer();

-- Normalization becomes DATABASE-OWNED: SECURITY DEFINER, owned by the
-- evidence owner, with a fixed search_path so nothing on a caller's path can
-- shadow the tables it writes. The body no longer touches the GUC at all.
-- Every child-side validator (applicability, version reachability, ordinality,
-- array equivalence, and the new Section 5 trigger) still fires on these
-- inserts — ownership changes who MAY write, never what a write must satisfy.
CREATE OR REPLACE FUNCTION policy_decisions_normalize_matched_bindings() RETURNS TRIGGER AS $$
BEGIN
  IF cardinality(NEW.matched_role_binding_ids) = 0 THEN RETURN NULL; END IF;
  INSERT INTO policy_decision_matched_bindings
    (decision_id, role_binding_id, actor_user_link_id, authorization_version, match_ordinality)
  SELECT NEW.decision_id, m.id, NEW.actor_user_link_id,
         NEW.matched_authorization_versions[m.ord], m.ord
    FROM unnest(NEW.matched_role_binding_ids) WITH ORDINALITY AS m(id, ord);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public;

ALTER FUNCTION policy_decisions_normalize_matched_bindings() OWNER TO dealership_evidence_owner;
