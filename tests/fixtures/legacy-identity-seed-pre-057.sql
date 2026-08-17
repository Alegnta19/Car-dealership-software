-- ============================================================
-- legacy-identity-seed-pre-057.sql — FBL-020-R4 §6
--
-- NONEMPTY legacy identity data, written against the schema as it stands AFTER
-- migration 056 and BEFORE migration 057.
--
-- WHY THIS FILE EXISTS. Until R4 the CI upgrade job seeded Fixed Ops rows only,
-- and `verify-upgrade-state.ts` REQUIRED every identity table to be empty. So
-- migration 057 — a file whose entire subject is reconciling retained identity
-- rows before it constrains them — was only ever exercised against zero rows.
-- Every "reconciliation precedes the constraint" claim in it was therefore
-- unproven by the gate that was supposed to prove it. This fixture is the
-- populated pre-057 database that claim needs.
--
-- WHAT IT IS NOT. It is not a functional fixture and nothing in it is a
-- credential. Every digest is a literal 64-hex string chosen to be obviously
-- synthetic; no value here can be presented to anything. The free-text support
-- reason is deliberately generic — the reason text is never logged, returned or
-- asserted on.
--
-- EVERY ROW HERE IS DELIBERATE. Each one is the input to a named reconciliation
-- in 057, and `verify-upgrade-state.ts --phase=post-057` asserts the exact state
-- that reconciliation must leave it in. The pairing is what makes the drill a
-- gate instead of a smoke test:
--
--   tenant A  (aaaa0001…) has EXACTLY ONE ACTIVE connection, so its activated
--             link is unambiguous and 057 §1 must BIND it.
--   tenant B  (bbbb0002…) has only a DISABLED connection, so its activated link
--             is AMBIGUOUS and 057 §1 must DEACTIVATE it. (`uq_ipc_active` makes
--             "two active connections in one tenant" unrepresentable, so zero
--             active connections is the only reachable ambiguity — the fixture
--             models the shape that can actually occur.)
--
-- ALL IDENTIFIERS ARE FIXED, so the assertions downstream are exact rather than
-- approximate. The prefixes are mnemonic: 1… user links, 5… identity sessions,
-- 7… reauthentication transactions, 8… grants, 9… role bindings, b… support
-- requests, c… provider connections, d… policy decisions, e… support sessions.
-- ============================================================

-- ── organizations ────────────────────────────────────────────────────────────
-- Both tenants are 'active': a legacy database that had identities in it had
-- tenants that were in service. Note that migration 055's own no-activation
-- property is asserted BEFORE this file runs (verify-upgrade-state.ts
-- --phase=backfill), against the tenants 055 itself created from Fixed Ops
-- data, so seeding an active tenant here cannot launder that check.
INSERT INTO tenants (tenant_id, name, status) VALUES
  ('aaaa0001-0000-4000-8000-000000000001', 'FBL-020-R4 legacy tenant A', 'active'),
  ('bbbb0002-0000-4000-8000-000000000002', 'FBL-020-R4 legacy tenant B', 'active');

INSERT INTO dealer_groups (dealer_group_id, tenant_id, name, status) VALUES
  ('a1000001-0000-4000-8000-000000000001', 'aaaa0001-0000-4000-8000-000000000001',
   'legacy group A', 'active');

INSERT INTO legal_entities (legal_entity_id, tenant_id, dealer_group_id, name, status) VALUES
  ('a2000001-0000-4000-8000-000000000001', 'aaaa0001-0000-4000-8000-000000000001',
   'a1000001-0000-4000-8000-000000000001', 'legacy entity A', 'active');

INSERT INTO rooftops (rooftop_id, tenant_id, legal_entity_id, name, status) VALUES
  ('a3000001-0000-4000-8000-000000000001', 'aaaa0001-0000-4000-8000-000000000001',
   'a2000001-0000-4000-8000-000000000001', 'legacy rooftop A', 'active');

INSERT INTO departments (department_id, tenant_id, rooftop_id, code, name, status) VALUES
  ('a4000001-0000-4000-8000-000000000001', 'aaaa0001-0000-4000-8000-000000000001',
   'a3000001-0000-4000-8000-000000000001', 'service', 'legacy service department A', 'active');

-- ── provider connections ─────────────────────────────────────────────────────
-- Connection A is ACTIVE and carries an MFA-policy certification with NO
-- validity deadline — the only shape migration 056 could express. 057 §8 must
-- WITHDRAW it rather than invent an expiry for it, and must advance the
-- connection's authorization_version because what it authorizes has changed.
INSERT INTO identity_provider_connections
  (connection_id, connection_scope, tenant_id, provider, provider_organization_id, issuer,
   status, mfa_policy_certified, mfa_policy_certified_at)
VALUES
  ('c0000001-0000-4000-8000-000000000001', 'dealership',
   'aaaa0001-0000-4000-8000-000000000001', 'workos', 'org_legacy_a',
   'https://legacy-a.authkit.test', 'active', TRUE, '2026-07-01T00:00:00Z'),
  -- Connection B is DISABLED, so tenant B has no active connection at all.
  ('c0000002-0000-4000-8000-000000000002', 'dealership',
   'bbbb0002-0000-4000-8000-000000000002', 'workos', 'org_legacy_b',
   'https://legacy-b.authkit.test', 'disabled', FALSE, NULL),
  -- The PLATFORM-scope connection the platform-support person belongs to.
  ('c0000003-0000-4000-8000-000000000003', 'platform', NULL, 'workos',
   'org_legacy_platform', 'https://legacy-platform.authkit.test', 'active', FALSE, NULL);

-- ── user links ───────────────────────────────────────────────────────────────
INSERT INTO user_links
  (user_link_id, actor_scope, tenant_id, provider, provider_user_id, email, display_name,
   status, activated_at)
VALUES
  -- A1: ACTIVATED and UNAMBIGUOUS — tenant A has exactly one active connection,
  -- so 057 §1 must bind it to connection A and leave it activated.
  ('10000001-0000-4000-8000-000000000001', 'dealership',
   'aaaa0001-0000-4000-8000-000000000001', 'workos', 'user_legacy_a1',
   'a1@legacy.invalid', 'Legacy A One', 'activated', '2026-07-02T00:00:00Z'),
  -- A2: PENDING — never activated, so it is legitimately unbound and 057 must
  -- leave it exactly as it is. The row that proves the constraint is CONDITIONAL
  -- on activation rather than universal.
  ('10000002-0000-4000-8000-000000000002', 'dealership',
   'aaaa0001-0000-4000-8000-000000000001', 'workos', 'user_legacy_a2',
   'a2@legacy.invalid', 'Legacy A Two', 'pending', NULL),
  -- B1: ACTIVATED and AMBIGUOUS — tenant B's only connection is disabled, so
  -- there is nothing this link can honestly be bound to. 057 §1 must DEACTIVATE
  -- it and advance its authorization_version.
  ('10000003-0000-4000-8000-000000000003', 'dealership',
   'bbbb0002-0000-4000-8000-000000000002', 'workos', 'user_legacy_b1',
   'b1@legacy.invalid', 'Legacy B One', 'activated', '2026-07-03T00:00:00Z'),
  -- P1: the PLATFORM-support person, activated against the platform connection.
  ('10000004-0000-4000-8000-000000000004', 'platform', NULL, 'workos',
   'user_legacy_platform_1', 'p1@legacy.invalid', 'Legacy Platform One',
   'activated', '2026-07-04T00:00:00Z');

-- ── identity sessions ────────────────────────────────────────────────────────
-- Three live sessions, each the input to a DIFFERENT branch of 057 §2. The two
-- that must be revoked carry DIFFERENT reasons, so the drill can tell which
-- reconciliation acted rather than merely observing that something did.
INSERT INTO identity_sessions
  (session_id, tenant_id, user_link_id, session_token_hash, provider_session_id,
   auth_time, issued_at, expires_at, last_seen_at, connection_id, issuer)
VALUES
  -- S1: PROVABLE. Names its connection and issuer, and its link is bound to the
  -- same connection, so §2 must DERIVE subject and organization and leave the
  -- session LIVE. This is the row that fails if the derivation is removed.
  ('50000001-0000-4000-8000-000000000001', 'aaaa0001-0000-4000-8000-000000000001',
   '10000001-0000-4000-8000-000000000001',
   '1111111111111111111111111111111111111111111111111111111111111111',
   'prov_sess_legacy_a1', '2026-08-09T00:00:00Z', '2026-08-09T00:00:00Z',
   '2036-08-09T00:00:00Z', '2026-08-09T00:00:00Z',
   'c0000001-0000-4000-8000-000000000001', 'https://legacy-a.authkit.test'),
  -- S2: UNPROVABLE PROVENANCE. No connection and no issuer at all — the exact
  -- nullable-connection bypass 057 §2 exists to close. Must be revoked with
  -- reason 'fbl_020_r2_unprovable_binding'.
  ('50000002-0000-4000-8000-000000000002', 'aaaa0001-0000-4000-8000-000000000001',
   '10000001-0000-4000-8000-000000000001',
   '2222222222222222222222222222222222222222222222222222222222222222',
   NULL, '2026-08-09T01:00:00Z', '2026-08-09T01:00:00Z',
   '2036-08-09T01:00:00Z', '2026-08-09T01:00:00Z', NULL, NULL),
  -- S3: UNPROVABLE IDENTITY. Names a connection and an issuer, so the first
  -- revocation does not reach it — but its link is the ambiguous one §1 just
  -- deactivated, so no subject or organization can be derived. Must be revoked
  -- with reason 'fbl_020_r3_unprovable_subject_or_org'.
  ('50000003-0000-4000-8000-000000000003', 'bbbb0002-0000-4000-8000-000000000002',
   '10000003-0000-4000-8000-000000000003',
   '3333333333333333333333333333333333333333333333333333333333333333',
   'prov_sess_legacy_b1', '2026-08-09T02:00:00Z', '2026-08-09T02:00:00Z',
   '2036-08-09T02:00:00Z', '2026-08-09T02:00:00Z',
   'c0000002-0000-4000-8000-000000000002', 'https://legacy-b.authkit.test');

-- ── role bindings ────────────────────────────────────────────────────────────
-- 057 touches role_bindings NOWHERE, and that is the property under test: four
-- bindings spanning EFFECTIVE, NOT-YET-EFFECTIVE, AGED-OUT and REVOKED must all
-- come through byte-for-byte, at authorization_version 1. A migration that
-- "tidied" an ineffective binding into an effective one, or advanced a version,
-- would be inventing standing authority.
INSERT INTO role_bindings
  (role_binding_id, tenant_id, user_link_id, role, scope_level, scope_id, status,
   granted_at, revoked_at, effective_from, effective_to)
VALUES
  -- EFFECTIVE: open window, active.
  ('90000001-0000-4000-8000-000000000001', 'aaaa0001-0000-4000-8000-000000000001',
   '10000001-0000-4000-8000-000000000001', 'service_manager', 'tenant',
   'aaaa0001-0000-4000-8000-000000000001', 'active',
   '2026-07-05T00:00:00Z', NULL, '2026-07-05T00:00:00Z', NULL),
  -- INEFFECTIVE (not yet): a future effective_from. Active in status, powerless
  -- in fact — the distinction the role-binding effectiveness rule exists for.
  ('90000002-0000-4000-8000-000000000002', 'aaaa0001-0000-4000-8000-000000000001',
   '10000001-0000-4000-8000-000000000001', 'technician', 'rooftop',
   'a3000001-0000-4000-8000-000000000001', 'active',
   '2026-07-05T00:00:00Z', NULL, '2099-01-01T00:00:00Z', NULL),
  -- INEFFECTIVE (aged out): the window closed in the past.
  ('90000003-0000-4000-8000-000000000003', 'aaaa0001-0000-4000-8000-000000000001',
   '10000001-0000-4000-8000-000000000001', 'advisor', 'department',
   'a4000001-0000-4000-8000-000000000001', 'active',
   '2026-07-05T00:00:00Z', NULL, '2026-07-05T00:00:00Z', '2026-07-06T00:00:00Z'),
  -- REVOKED, and belonging to the link 057 §1 DEACTIVATES: the binding of a
  -- deactivated person must not be resurrected either.
  ('90000004-0000-4000-8000-000000000004', 'bbbb0002-0000-4000-8000-000000000002',
   '10000003-0000-4000-8000-000000000003', 'parts_clerk', 'tenant',
   'bbbb0002-0000-4000-8000-000000000002', 'revoked',
   '2026-07-05T00:00:00Z', '2026-07-07T00:00:00Z', '2026-07-05T00:00:00Z', NULL);

-- ── reauthentication transactions and one grant ───────────────────────────────
INSERT INTO reauthentication_transactions
  (reauth_txn_id, tenant_id, user_link_id, action, nonce_hash, oidc_nonce_hash, state,
   started_at, expires_at, completed_at, required_assurance)
VALUES
  -- T1: STILL 'started'. Under 057 it cannot name the connection, issuer,
  -- organization, subject or local session the new binding rules demand — those
  -- columns do not exist yet — so §4 must EXPIRE it. Left 'started', it violates
  -- `rat_started_is_bound` and aborts the migration.
  ('70000001-0000-4000-8000-000000000001', 'aaaa0001-0000-4000-8000-000000000001',
   '10000001-0000-4000-8000-000000000001', 'fixedops.repair_order.approve',
   '4444444444444444444444444444444444444444444444444444444444444444',
   '5555555555555555555555555555555555555555555555555555555555555555', 'started',
   '2026-08-09T03:00:00Z', '2036-08-09T03:00:00Z', NULL, 'fresh_and_mfa_policy'),
  -- T2: COMPLETED. Terminal before 057, so §9 must EXPLAIN it: terminal_reason
  -- 'granted' and terminal_at derived from its own completed_at. Nothing invented.
  ('70000002-0000-4000-8000-000000000002', 'aaaa0001-0000-4000-8000-000000000001',
   '10000001-0000-4000-8000-000000000001', 'fixedops.repair_order.approve',
   '6666666666666666666666666666666666666666666666666666666666666666',
   '7777777777777777777777777777777777777777777777777777777777777777', 'completed',
   '2026-08-08T03:00:00Z', '2036-08-08T03:00:00Z', '2026-08-08T03:05:00Z',
   'fresh_and_mfa_policy'),
  -- T3: FAILED, with no recorded reason — the shape 057 §9 classifies honestly
  -- as 'fbl_020_r4_unclassified' rather than guessing a cause.
  ('70000003-0000-4000-8000-000000000003', 'aaaa0001-0000-4000-8000-000000000001',
   '10000001-0000-4000-8000-000000000001', 'fixedops.repair_order.approve',
   '8888888888888888888888888888888888888888888888888888888888888888',
   NULL, 'failed',
   '2026-08-07T03:00:00Z', '2036-08-07T03:00:00Z', NULL, 'fresh_only');

-- The grant T2 minted. Its connection is NULL because its transaction's
-- connection is NULL: 057 §7c DERIVES the grant's connection from the
-- transaction rather than trusting it, and a legacy transaction that predates
-- the column honestly yields NULL. A grant that acquired a connection out of
-- nowhere here would be the fabrication.
INSERT INTO reauthentication_grants
  (grant_id, reauth_txn_id, tenant_id, user_link_id, action, grant_hash,
   issued_at, expires_at, consumed_at, assurance_level, mfa_policy_certified_at_issue)
VALUES
  ('80000001-0000-4000-8000-000000000001', '70000002-0000-4000-8000-000000000002',
   'aaaa0001-0000-4000-8000-000000000001', '10000001-0000-4000-8000-000000000001',
   'fixedops.repair_order.approve',
   '9999999999999999999999999999999999999999999999999999999999999999',
   '2026-08-08T03:05:00Z', '2026-08-08T03:10:00Z', '2026-08-08T03:06:00Z',
   'fresh_and_mfa_policy', TRUE);

-- ── policy decisions: historical and INCOMPLETE ──────────────────────────────
-- These are the rows 057 §6's version discriminator exists for. Both are
-- decisions that were genuinely made with less recorded than version 2 demands:
-- D1 is an ALLOW that names no request id, no correlation id, no scope, no
-- matched binding and no presented session — it would violate four separate
-- version-2 clauses. Rewriting or deleting it would be the real falsification,
-- so 057 must leave it EXACTLY as it is, at evidence_version 1, and readable.
INSERT INTO policy_decisions
  (decision_id, occurred_at, tenant_id, actor_user_link_id, actor_type, action,
   decision, reason_code, policy_version, request_id, correlation_id, scope_level,
   matched_role_binding_ids, matched_authorization_versions,
   freshness_classification, mfa_assurance_classification, details)
VALUES
  ('d0000001-0000-4000-8000-000000000001', '2026-08-06T04:00:00Z',
   'aaaa0001-0000-4000-8000-000000000001', '10000001-0000-4000-8000-000000000001',
   'user', 'fixedops.repair_order.read', 'allow', 'ROLE_BINDING_MATCH', 'v1',
   NULL, NULL, NULL, '{}', '{}', 'not_applicable', 'not_applicable', '{}'),
  ('d0000002-0000-4000-8000-000000000002', '2026-08-06T04:01:00Z',
   'aaaa0001-0000-4000-8000-000000000001', '10000003-0000-4000-8000-000000000003',
   'user', 'fixedops.repair_order.approve', 'deny', 'NO_MATCHING_ROLE_BINDING', 'v1',
   NULL, NULL, NULL, '{}', '{}', 'not_applicable', 'not_applicable', '{}');

-- ── support access: one PENDING request, and one APPROVED without a grant ────
INSERT INTO support_access_requests
  (request_id, tenant_id, requester_user_link_id, requested_actions, scope_level,
   scope_id, reason, requested_duration_minutes, status, decided_by_user_link_id, decided_at)
VALUES
  -- R1: PENDING. It has no decision and therefore nothing to reconcile; 057 must
  -- leave it pending. A migration that "completed" an undecided request would be
  -- manufacturing an approval, which is the worst available failure on this table.
  ('b0000001-0000-4000-8000-000000000001', 'aaaa0001-0000-4000-8000-000000000001',
   '10000004-0000-4000-8000-000000000004', '{fixedops.repair_order.read}', 'tenant',
   NULL, 'legacy pending support request', 30, 'pending', NULL, NULL),
  -- R2: APPROVED, and it cannot name an approving high-assurance grant, because
  -- `approval_grant_id` does not exist before 057. Every approved row in every
  -- retained database has this shape. 057 §5 must PRESERVE the prior decision in
  -- the superseded_* columns, move the row to the auditable terminal state,
  -- advance its authorization_version and end its live session — and must not
  -- invent a grant. Left alone, it violates `sar_approval_is_high_assurance` and
  -- aborts the migration.
  ('b0000002-0000-4000-8000-000000000002', 'aaaa0001-0000-4000-8000-000000000001',
   '10000004-0000-4000-8000-000000000004', '{fixedops.repair_order.read}', 'tenant',
   NULL, 'legacy approved support request', 60, 'approved',
   '10000001-0000-4000-8000-000000000001', '2026-08-05T05:00:00Z');

-- The live support session R2 granted. 057 §5 must END it (revoked_at set,
-- revoked_by_user_link_id left NULL because no person performed this) rather
-- than let delegated access into a tenant outlive the approval that justified it.
INSERT INTO support_access_sessions
  (support_session_id, request_id, tenant_id, actor_user_link_id, granted_at, expires_at)
VALUES
  ('e0000001-0000-4000-8000-000000000001', 'b0000002-0000-4000-8000-000000000002',
   'aaaa0001-0000-4000-8000-000000000001', '10000004-0000-4000-8000-000000000004',
   '2026-08-05T05:00:00Z', '2026-08-05T06:00:00Z');
