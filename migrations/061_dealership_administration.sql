-- ============================================================================
-- Migration 061 — RELEASE TRAIN 1: DEALERSHIP ADMINISTRATION
--
-- The first migration after the accepted FBL-020 boundary (000-060 immutable).
-- It carries the administration journey's persistence and the train's
-- database-enforced tenant isolation:
--
--   §1  the SERVER-CONTROLLED TENANT CONTEXT: one STABLE reader function over a
--       transaction-scoped GUC that only server code sets, from the
--       AUTHENTICATED actor, inside the transaction doing the work;
--   §2  the administration tables — dealership settings (branding, timezone),
--       business hours, bounded dealership policies, staff invitations — each
--       tenant-qualified, attributed and versioned like every FBL-020 table;
--   §3  the safe-command infrastructure THIS journey uses: idempotency keys
--       (retryable commands replay their recorded outcome) and the
--       transactional outbox with its consumer-side delivery ledger;
--   §4  DENY-BY-DEFAULT ROW SECURITY on the administration domain — the four
--       organization tables and the five tenant-scoped administration tables —
--       bound to the runtime role. Without a context nothing is visible and
--       nothing is writable; with a context, exactly one tenant is. The
--       migration owner and the test harness are unaffected (no FORCE), the
--       runtime login is what production runs as, and composite tenant keys
--       continue to make cross-tenant REFERENCES unrepresentable everywhere.
--
-- What is deliberately NOT under row security in this train, and why:
--   * tenants — the policy engine's effectiveness check reads it before any
--     tenant context can exist, and the row itself carries no per-tenant data
--     beyond its own identity;
--   * identity/auth plumbing (user_links, identity_sessions, role_bindings,
--     provider connections, evidence tables) — authentication resolves these
--     BEFORE a context exists; they remain guarded by the FBL-020 composite
--     tenant keys, triggers and the policy engine (accepted foundations);
--   * admin_outbox / admin_outbox_deliveries — the dispatcher legitimately
--     works across tenants; rows are tenant-stamped and carry ids only.
-- ============================================================================

-- ────────────────────────────────────────────────────────────────────────────
-- Section 1 — THE SERVER-CONTROLLED TENANT CONTEXT
--
-- `app.tenant_id` is set with set_config(..., true) — TRANSACTION-scoped, so
-- it cannot leak across pooled connections — by server code that has already
-- authenticated the actor and authorized the action. Clients never touch it:
-- it is not a header, not a parameter, and unset it reads as NULL, which
-- matches no row (deny by default).
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION app_tenant_ctx() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;

-- ────────────────────────────────────────────────────────────────────────────
-- Section 2 — ADMINISTRATION TABLES
-- ────────────────────────────────────────────────────────────────────────────

-- One settings row per tenant: branding and locale facts an owner configures.
CREATE TABLE dealership_settings (
  tenant_id               UUID PRIMARY KEY REFERENCES tenants (tenant_id),
  display_name            TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  legal_name              TEXT CHECK (legal_name IS NULL OR length(legal_name) BETWEEN 1 AND 200),
  brand_primary_color     TEXT CHECK (brand_primary_color IS NULL
                                      OR brand_primary_color ~ '^#[0-9a-fA-F]{6}$'),
  logo_url                TEXT CHECK (logo_url IS NULL
                                      OR (length(logo_url) <= 2048 AND logo_url ~ '^(https://|/)')),
  timezone                TEXT NOT NULL DEFAULT 'UTC' CHECK (length(timezone) BETWEEN 1 AND 64),
  locale                  TEXT CHECK (locale IS NULL OR locale ~ '^[a-z]{2}(-[A-Z]{2})?$'),
  created_by_user_link_id UUID NOT NULL,
  updated_by_user_link_id UUID NOT NULL,
  authorization_version   BIGINT NOT NULL DEFAULT 1,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- attribution is same-tenant by construction, exactly like every 055 table
  FOREIGN KEY (tenant_id, created_by_user_link_id) REFERENCES user_links (tenant_id, user_link_id),
  FOREIGN KEY (tenant_id, updated_by_user_link_id) REFERENCES user_links (tenant_id, user_link_id)
);

-- Seven rows at most per tenant: the weekly operating hours. A closed day
-- carries no times; an open day carries a coherent window.
CREATE TABLE dealership_business_hours (
  tenant_id               UUID NOT NULL REFERENCES tenants (tenant_id),
  day_of_week             SMALLINT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  closed                  BOOLEAN NOT NULL DEFAULT FALSE,
  open_time               TIME,
  close_time              TIME,
  updated_by_user_link_id UUID NOT NULL,
  authorization_version   BIGINT NOT NULL DEFAULT 1,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, day_of_week),
  FOREIGN KEY (tenant_id, updated_by_user_link_id) REFERENCES user_links (tenant_id, user_link_id),
  CHECK ((closed AND open_time IS NULL AND close_time IS NULL)
         OR (NOT closed AND open_time IS NOT NULL AND close_time IS NOT NULL
             AND close_time > open_time))
);

-- Bounded key/value dealership policies. The KEY GRAMMAR is enforced here; the
-- allowed key SET and each value's shape are enforced by the administration
-- service (a bounded list the API refuses to exceed), so an unknown key can
-- never be written through the application and a hand-written row still cannot
-- carry an ungrammatical key.
CREATE TABLE dealership_policies (
  tenant_id               UUID NOT NULL REFERENCES tenants (tenant_id),
  policy_key              TEXT NOT NULL CHECK (policy_key ~ '^[a-z][a-z0-9_.]{0,63}$'),
  policy_value            JSONB NOT NULL,
  updated_by_user_link_id UUID NOT NULL,
  authorization_version   BIGINT NOT NULL DEFAULT 1,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, policy_key),
  FOREIGN KEY (tenant_id, updated_by_user_link_id) REFERENCES user_links (tenant_id, user_link_id)
);

-- A staff invitation: the owner's intent that a person join the dealership
-- with a starting role at a scope. Provisioning the PENDING user_link happens
-- in the same transaction (the FBL-020 activation path then binds the link on
-- first login); the outbox event drives the email leaving the service.
CREATE TABLE staff_invitations (
  invitation_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants (tenant_id),
  email                   TEXT NOT NULL CHECK (length(email) BETWEEN 3 AND 320 AND email ~ '@'),
  display_name            TEXT CHECK (display_name IS NULL OR length(display_name) BETWEEN 1 AND 200),
  invited_role            TEXT NOT NULL CHECK (invited_role ~ '^[a-z][a-z0-9_]{0,63}$'),
  scope_level             TEXT NOT NULL DEFAULT 'tenant'
                          CHECK (scope_level IN ('tenant','dealer_group','legal_entity',
                                                 'rooftop','department')),
  scope_id                UUID,
  user_link_id            UUID,
  status                  TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','accepted','revoked','expired')),
  invited_by_user_link_id UUID NOT NULL,
  expires_at              TIMESTAMPTZ NOT NULL,
  authorization_version   BIGINT NOT NULL DEFAULT 1,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((scope_level = 'tenant') = (scope_id IS NULL)),
  CHECK (expires_at > created_at),
  FOREIGN KEY (tenant_id, invited_by_user_link_id) REFERENCES user_links (tenant_id, user_link_id),
  FOREIGN KEY (tenant_id, user_link_id) REFERENCES user_links (tenant_id, user_link_id)
);
-- one live invitation per address per tenant
CREATE UNIQUE INDEX uq_staff_invitations_pending_email
  ON staff_invitations (tenant_id, lower(email)) WHERE status = 'pending';
CREATE INDEX idx_staff_invitations_tenant ON staff_invitations (tenant_id, created_at DESC);

-- ────────────────────────────────────────────────────────────────────────────
-- Section 3 — SAFE-COMMAND INFRASTRUCTURE THE JOURNEY USES
-- ────────────────────────────────────────────────────────────────────────────

-- Idempotency: a retried command replays its recorded outcome. The key is
-- scoped to (tenant, actor, key); the fingerprint binds it to the request that
-- first used it, so the SAME key with a DIFFERENT request is a refusable
-- conflict rather than a silent replay of something else.
CREATE TABLE idempotency_keys (
  tenant_id               UUID NOT NULL REFERENCES tenants (tenant_id),
  actor_user_link_id      UUID NOT NULL,
  idempotency_key         TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  request_fingerprint     TEXT NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  response_status         INTEGER NOT NULL CHECK (response_status BETWEEN 200 AND 599),
  response_body           JSONB NOT NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at              TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, actor_user_link_id, idempotency_key),
  FOREIGN KEY (tenant_id, actor_user_link_id) REFERENCES user_links (tenant_id, user_link_id),
  CHECK (expires_at > created_at)
);

-- The transactional outbox: an event that must leave the service is written in
-- the SAME transaction as the state it describes, then delivered by the worker
-- at least once. The payload carries IDS ONLY — the dispatcher re-reads the
-- current row (e.g. the invitation's address) at delivery time.
CREATE TABLE admin_outbox (
  event_id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants (tenant_id),
  event_type              TEXT NOT NULL CHECK (event_type ~ '^[a-z][a-z0-9_.]{0,127}$'),
  payload                 JSONB NOT NULL DEFAULT '{}',
  occurred_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  available_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  attempts                INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  delivered_at            TIMESTAMPTZ,
  last_error              TEXT CHECK (last_error IS NULL OR length(last_error) <= 2000)
);
CREATE INDEX idx_admin_outbox_due ON admin_outbox (available_at) WHERE delivered_at IS NULL;

-- The consumer-side dedupe ledger: delivery is AT LEAST once, so the business
-- effect (one email dispatched per event) is made exactly-once by this primary
-- key — a redelivered event finds its row and does nothing again.
CREATE TABLE admin_outbox_deliveries (
  event_id                UUID PRIMARY KEY REFERENCES admin_outbox (event_id),
  sink                    TEXT NOT NULL CHECK (length(sink) BETWEEN 1 AND 200),
  delivered_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The runtime role works these tables; 059's blanket grant predates them.
GRANT SELECT, INSERT, UPDATE ON dealership_settings, dealership_business_hours,
  dealership_policies, staff_invitations, idempotency_keys,
  admin_outbox, admin_outbox_deliveries TO dealership_runtime;
-- Business hours are replaced as a whole week (the PUT model): the service
-- deletes the tenant's rows and re-inserts the set in one transaction, so this
-- one table also needs DELETE. Row security still scopes it to the context
-- tenant — a DELETE can only ever clear the caller's own week.
GRANT DELETE ON dealership_business_hours TO dealership_runtime;

-- ────────────────────────────────────────────────────────────────────────────
-- Section 4 — DENY-BY-DEFAULT ROW SECURITY ON THE ADMINISTRATION DOMAIN
--
-- Row security binds the RUNTIME role (what production connects as). The
-- migration owner and the test harness connect as the owner/superuser and are
-- unaffected — deliberately: fixtures and reconciliations are owner work, and
-- FORCE would bind the owner too. Each policy is the same one sentence: a row
-- is visible and writable exactly when its tenant IS the transaction's
-- server-set tenant context. No context, no rows — deny by default.
--
-- The organization tables' production READERS set the context transactionally:
-- the ancestry repository, the session view, login admission, the policy
-- engine's evidence transaction and the organization mutations each derive the
-- tenant from authenticated state and set it inside their own transaction.
-- ────────────────────────────────────────────────────────────────────────────

-- The DATABASE-OWNED normalizer (migration 059's SECURITY DEFINER function,
-- owned by dealership_evidence_owner) validates child evidence through the
-- one ancestry authority. Its role is unreachable by the application — the
-- runtime posture gate proves dealership_app holds no membership in it — so
-- it is the database's own trusted writer, and it BYPASSES row security the
-- way the migration owner does. Row security binds the RUNTIME identity.
ALTER ROLE dealership_evidence_owner BYPASSRLS;

ALTER TABLE dealer_groups             ENABLE ROW LEVEL SECURITY;
ALTER TABLE legal_entities            ENABLE ROW LEVEL SECURITY;
ALTER TABLE rooftops                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE departments               ENABLE ROW LEVEL SECURITY;
ALTER TABLE dealership_settings       ENABLE ROW LEVEL SECURITY;
ALTER TABLE dealership_business_hours ENABLE ROW LEVEL SECURITY;
ALTER TABLE dealership_policies      ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_invitations         ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys          ENABLE ROW LEVEL SECURITY;

CREATE POLICY rls_dealer_groups_tenant ON dealer_groups
  FOR ALL TO dealership_runtime
  USING (tenant_id = app_tenant_ctx()) WITH CHECK (tenant_id = app_tenant_ctx());
CREATE POLICY rls_legal_entities_tenant ON legal_entities
  FOR ALL TO dealership_runtime
  USING (tenant_id = app_tenant_ctx()) WITH CHECK (tenant_id = app_tenant_ctx());
CREATE POLICY rls_rooftops_tenant ON rooftops
  FOR ALL TO dealership_runtime
  USING (tenant_id = app_tenant_ctx()) WITH CHECK (tenant_id = app_tenant_ctx());
CREATE POLICY rls_departments_tenant ON departments
  FOR ALL TO dealership_runtime
  USING (tenant_id = app_tenant_ctx()) WITH CHECK (tenant_id = app_tenant_ctx());
CREATE POLICY rls_dealership_settings_tenant ON dealership_settings
  FOR ALL TO dealership_runtime
  USING (tenant_id = app_tenant_ctx()) WITH CHECK (tenant_id = app_tenant_ctx());
CREATE POLICY rls_dealership_business_hours_tenant ON dealership_business_hours
  FOR ALL TO dealership_runtime
  USING (tenant_id = app_tenant_ctx()) WITH CHECK (tenant_id = app_tenant_ctx());
CREATE POLICY rls_dealership_policies_tenant ON dealership_policies
  FOR ALL TO dealership_runtime
  USING (tenant_id = app_tenant_ctx()) WITH CHECK (tenant_id = app_tenant_ctx());
CREATE POLICY rls_staff_invitations_tenant ON staff_invitations
  FOR ALL TO dealership_runtime
  USING (tenant_id = app_tenant_ctx()) WITH CHECK (tenant_id = app_tenant_ctx());
CREATE POLICY rls_idempotency_keys_tenant ON idempotency_keys
  FOR ALL TO dealership_runtime
  USING (tenant_id = app_tenant_ctx()) WITH CHECK (tenant_id = app_tenant_ctx());
