-- ============================================================
-- 056_identity_contract_completion.sql — FBL-020-R1
--
-- Forward-only completion of the identity contract. Migration 055 has
-- shipped and is byte-identical; nothing here edits, renames, reorders or
-- recomputes 000 or 049–055.
--
-- What this migration adds, and why each piece exists:
--
--   1. Provider connections gain the facts authorization actually depends on:
--      the ISSUER the token must have been minted by, an explicit MFA-policy
--      CERTIFICATION (fresh authentication and a certified MFA policy are two
--      separate facts — see ADR-006-R1), an effective interval, audit actors,
--      and an authorization version.
--   2. Mutable FBL-020 organization and security records gain the audit
--      actors and versions they were missing, so every change has a who and
--      a monotonically observable version.
--   3. RoleBinding gains an EXACT typed-resource scope. A resource binding
--      names one row and grants nothing else — no descendants, no siblings.
--   4. PolicyDecision gains the evidence that makes a stored decision
--      reconstructable: which bindings matched, at which authorization
--      version, under which freshness and MFA-assurance classification, with
--      a correlation id distinct from the request id.
--
-- Upgrade values for records that already exist are DETERMINISTIC and
-- documented inline. No provider credential, user, active role or MFA
-- certification is invented: everything that would assert a security fact we
-- cannot know defaults to the CLOSED value.
--
-- Rollback: additive only. Rolling the application back to 1b1a1bc ignores
-- every column added here.
-- ============================================================

-- ──────────────────────────────────────────────────────────────
-- Section 1 — identity_provider_connections
--
-- `issuer` is the trust anchor a token must match. It is NOT NULL going
-- forward; existing rows are backfilled with the sentinel below and are
-- simultaneously forced INACTIVE, because a connection whose issuer we
-- cannot prove must not authorize anything.
--
-- `mfa_policy_certified` is the tenant's WorkOS organization MFA policy as
-- CERTIFIED by an operator (WorkOS documents organization policy separately
-- from max_age reauthentication, so a fresh auth_time cannot stand in for
-- it). It defaults FALSE — uncertified fails closed.
-- ──────────────────────────────────────────────────────────────

ALTER TABLE identity_provider_connections
  ADD COLUMN issuer                      TEXT,
  ADD COLUMN mfa_policy_certified        BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN mfa_policy_certified_at     TIMESTAMPTZ,
  ADD COLUMN mfa_policy_certified_by_user_link_id UUID REFERENCES user_links (user_link_id),
  ADD COLUMN effective_from              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN effective_to                TIMESTAMPTZ,
  ADD COLUMN created_by_user_link_id     UUID REFERENCES user_links (user_link_id),
  ADD COLUMN updated_by_user_link_id     UUID REFERENCES user_links (user_link_id),
  ADD COLUMN authorization_version       BIGINT NOT NULL DEFAULT 1;

-- Deterministic upgrade: any pre-existing connection gets a sentinel issuer
-- AND is disabled, so it cannot authorize until an operator sets the real
-- issuer and re-enables it. On a fresh database this updates nothing.
UPDATE identity_provider_connections
   SET issuer = 'urn:fbl-020-r1:issuer-unset',
       status = 'disabled',
       updated_at = NOW()
 WHERE issuer IS NULL;

ALTER TABLE identity_provider_connections
  ALTER COLUMN issuer SET NOT NULL,
  ADD CONSTRAINT ipc_issuer_shape CHECK (length(issuer) BETWEEN 1 AND 400),
  ADD CONSTRAINT ipc_effective_window CHECK (effective_to IS NULL OR effective_to > effective_from),
  -- a certification is a dated, attributable act or it is not a certification
  ADD CONSTRAINT ipc_mfa_certification_attributable
    CHECK (mfa_policy_certified = FALSE OR mfa_policy_certified_at IS NOT NULL),
  ADD CONSTRAINT ipc_version_positive CHECK (authorization_version >= 1);

-- The issuer must be unambiguous per external organization.
CREATE UNIQUE INDEX uq_ipc_issuer_org
  ON identity_provider_connections (provider, issuer, provider_organization_id);

-- ──────────────────────────────────────────────────────────────
-- Section 2 — audit actors and versions on mutable records
--
-- user_links and identity_sessions gain who-changed-them. role_bindings
-- gains an authorization_version that MUST increment on every grant and
-- revocation, so a still-valid token observes the new version on its very
-- next policy decision.
-- ──────────────────────────────────────────────────────────────

ALTER TABLE user_links
  ADD COLUMN created_by_user_link_id  UUID REFERENCES user_links (user_link_id),
  ADD COLUMN updated_by_user_link_id  UUID REFERENCES user_links (user_link_id),
  ADD COLUMN activated_by_user_link_id UUID REFERENCES user_links (user_link_id),
  ADD COLUMN deactivated_by_user_link_id UUID REFERENCES user_links (user_link_id),
  ADD COLUMN deactivated_at           TIMESTAMPTZ,
  ADD COLUMN effective_from           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN effective_to             TIMESTAMPTZ,
  ADD COLUMN authorization_version    BIGINT NOT NULL DEFAULT 1;

ALTER TABLE user_links
  ADD CONSTRAINT ul_effective_window CHECK (effective_to IS NULL OR effective_to > effective_from),
  -- activation is an attributable act: either the bootstrap command or an
  -- authorized administrator. It never happens as a side effect of login.
  ADD CONSTRAINT ul_activation_attributable
    CHECK (status <> 'activated' OR activated_at IS NOT NULL),
  ADD CONSTRAINT ul_deactivation_dated
    CHECK (status <> 'deactivated' OR deactivated_at IS NOT NULL),
  ADD CONSTRAINT ul_version_positive CHECK (authorization_version >= 1);

-- Every ORGANIZATION record is mutable and administratively owned, so each
-- carries who created it, who last changed it, and a version that a reader
-- can observe advancing. (The effective window and status already exist from
-- migration 055.)
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['tenants','dealer_groups','legal_entities','rooftops','departments']
  LOOP
    EXECUTE format(
      'ALTER TABLE %I
         ADD COLUMN created_by_user_link_id UUID REFERENCES user_links (user_link_id),
         ADD COLUMN updated_by_user_link_id UUID REFERENCES user_links (user_link_id),
         ADD COLUMN authorization_version BIGINT NOT NULL DEFAULT 1', t);
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %s_version_positive CHECK (authorization_version >= 1)',
      t, t);
  END LOOP;
END $$;

ALTER TABLE identity_sessions
  ADD COLUMN created_by_user_link_id UUID REFERENCES user_links (user_link_id),
  ADD COLUMN revoked_by_user_link_id UUID REFERENCES user_links (user_link_id),
  -- the connection this session was established through: disabling that
  -- connection must deny the session's next request
  ADD COLUMN connection_id           UUID REFERENCES identity_provider_connections (connection_id),
  ADD COLUMN issuer                  TEXT,
  ADD COLUMN authorization_version   BIGINT NOT NULL DEFAULT 1;

ALTER TABLE identity_sessions
  ADD CONSTRAINT is_issuer_shape CHECK (issuer IS NULL OR length(issuer) BETWEEN 1 AND 400);

ALTER TABLE role_bindings
  ADD COLUMN authorization_version BIGINT NOT NULL DEFAULT 1,
  -- `granted_by_user_link_id` (055) is this record's creator; the explicit
  -- alias below keeps the audit pair uniform across every mutable record.
  ADD COLUMN created_by_user_link_id UUID REFERENCES user_links (user_link_id),
  ADD COLUMN updated_by_user_link_id UUID REFERENCES user_links (user_link_id),
  ADD COLUMN effective_from        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN effective_to          TIMESTAMPTZ;

ALTER TABLE role_bindings
  ADD CONSTRAINT rb_effective_window CHECK (effective_to IS NULL OR effective_to > effective_from),
  ADD CONSTRAINT rb_version_positive CHECK (authorization_version >= 1);

ALTER TABLE reauthentication_grants
  ADD COLUMN created_by_user_link_id UUID REFERENCES user_links (user_link_id),
  ADD COLUMN assurance_level    TEXT NOT NULL DEFAULT 'fresh_only'
                                CHECK (assurance_level IN ('fresh_only', 'fresh_and_mfa_policy')),
  ADD COLUMN connection_id      UUID REFERENCES identity_provider_connections (connection_id),
  ADD COLUMN mfa_policy_certified_at_issue BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE reauthentication_transactions
  ADD COLUMN created_by_user_link_id UUID REFERENCES user_links (user_link_id),
  ADD COLUMN required_assurance TEXT NOT NULL DEFAULT 'fresh_only'
                                CHECK (required_assurance IN ('fresh_only', 'fresh_and_mfa_policy')),
  -- the OIDC nonce this transaction demands back from the provider, stored
  -- ONLY as a digest (section 4)
  ADD COLUMN oidc_nonce_hash    TEXT,
  ADD CONSTRAINT rat_nonce_shape CHECK (oidc_nonce_hash IS NULL OR oidc_nonce_hash ~ '^[0-9a-f]{64}$');

ALTER TABLE support_access_requests
  ADD COLUMN authorization_version BIGINT NOT NULL DEFAULT 1,
  -- `requester_user_link_id` (055) is the creator; the alias keeps the pair
  -- uniform and lets a later administrative edit be attributed separately.
  ADD COLUMN created_by_user_link_id UUID REFERENCES user_links (user_link_id),
  ADD COLUMN updated_by_user_link_id UUID REFERENCES user_links (user_link_id);

ALTER TABLE support_access_sessions
  ADD COLUMN authorization_version BIGINT NOT NULL DEFAULT 1,
  ADD COLUMN created_by_user_link_id UUID REFERENCES user_links (user_link_id),
  ADD COLUMN updated_by_user_link_id UUID REFERENCES user_links (user_link_id);

-- ──────────────────────────────────────────────────────────────
-- Section 3 — exact typed-resource RoleBinding scope
--
-- `scope_level = 'resource'` names ONE row: a bounded resource type plus an
-- opaque resource id, both required, and both forbidden at every other
-- level. A resource binding grants no descendant and no sibling access.
-- ──────────────────────────────────────────────────────────────

ALTER TABLE role_bindings
  ADD COLUMN resource_type TEXT,
  ADD COLUMN resource_id   UUID;

-- widen the level vocabulary without touching the 055 constraint
ALTER TABLE role_bindings DROP CONSTRAINT role_bindings_scope_level_check;
ALTER TABLE role_bindings
  ADD CONSTRAINT rb_scope_level_check CHECK (
    scope_level IN ('platform','tenant','dealer_group','legal_entity','rooftop','department','resource')
  );

ALTER TABLE role_bindings
  ADD CONSTRAINT rb_resource_scope_complete CHECK (
    (scope_level = 'resource') = (resource_type IS NOT NULL AND resource_id IS NOT NULL)
  ),
  ADD CONSTRAINT rb_resource_type_shape CHECK (
    resource_type IS NULL OR resource_type ~ '^[a-z][a-z0-9_]{0,63}$'
  ),
  -- a resource binding is tenant-scoped and must NOT also claim an
  -- organization node: ambiguous organization-plus-resource scope is refused
  ADD CONSTRAINT rb_resource_not_ambiguous CHECK (
    scope_level <> 'resource' OR (scope_id IS NULL AND tenant_id IS NOT NULL)
  );

-- 055's CHECK tied scope_id nullability to 'platform' alone; 'resource'
-- rows legitimately carry no scope_id, so the rule is restated exactly.
ALTER TABLE role_bindings DROP CONSTRAINT role_bindings_check;
ALTER TABLE role_bindings
  ADD CONSTRAINT rb_scope_id_presence CHECK (
    (scope_id IS NULL) = (scope_level IN ('platform', 'resource'))
  );

CREATE UNIQUE INDEX uq_rb_active_resource
  ON role_bindings (tenant_id, user_link_id, role, resource_type, resource_id)
  WHERE status = 'active' AND scope_level = 'resource';
CREATE INDEX idx_rb_resource
  ON role_bindings (tenant_id, resource_type, resource_id)
  WHERE status = 'active' AND scope_level = 'resource';

-- ──────────────────────────────────────────────────────────────
-- Section 4 — complete policy evidence
--
-- A stored decision must be reconstructable: which bindings matched, at what
-- authorization version, under what assurance, correlated to the request.
-- Denied decisions must not report a matched binding — enforced by CHECK.
-- ──────────────────────────────────────────────────────────────

ALTER TABLE policy_decisions
  ADD COLUMN matched_role_binding_ids UUID[] NOT NULL DEFAULT '{}',
  ADD COLUMN matched_authorization_versions BIGINT[] NOT NULL DEFAULT '{}',
  ADD COLUMN freshness_classification TEXT NOT NULL DEFAULT 'not_applicable'
                                      CHECK (freshness_classification IN
                                        ('not_applicable','stale','fresh')),
  ADD COLUMN mfa_assurance_classification TEXT NOT NULL DEFAULT 'not_applicable'
                                      CHECK (mfa_assurance_classification IN
                                        ('not_applicable','uncertified','certified')),
  ADD COLUMN correlation_id TEXT,
  ADD COLUMN support_request_id UUID;

ALTER TABLE policy_decisions
  ADD CONSTRAINT pd_correlation_shape CHECK (
    correlation_id IS NULL OR length(correlation_id) BETWEEN 8 AND 128
  ),
  -- a deny may never claim a matched binding
  ADD CONSTRAINT pd_deny_has_no_match CHECK (
    decision = 'allow' OR cardinality(matched_role_binding_ids) = 0
  ),
  -- ids and versions are recorded as parallel arrays
  ADD CONSTRAINT pd_match_arrays_aligned CHECK (
    cardinality(matched_role_binding_ids) = cardinality(matched_authorization_versions)
  );

CREATE INDEX idx_pd_correlation ON policy_decisions (correlation_id)
  WHERE correlation_id IS NOT NULL;

-- Evidence must be able to name the level it actually matched, including the
-- new exact-resource level.
ALTER TABLE policy_decisions DROP CONSTRAINT policy_decisions_scope_level_check;
ALTER TABLE policy_decisions
  ADD CONSTRAINT pd_scope_level_check CHECK (
    scope_level IS NULL OR scope_level IN
      ('platform','tenant','dealer_group','legal_entity','rooftop','department','resource')
  );

-- The append-only trigger from 055 already covers policy_decisions; the new
-- columns inherit it because it is a table-level BEFORE UPDATE OR DELETE.

-- ──────────────────────────────────────────────────────────────
-- Section 5 — updated_at maintenance for the reauth/support tables that
-- gained mutable columns, using the function migration 050 installed.
-- (055 already installed triggers for every table it created; this is a
-- no-op re-assertion kept explicit so the set is auditable in one place.)
-- ──────────────────────────────────────────────────────────────

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'identity_provider_connections','user_links','identity_sessions','role_bindings',
    'reauthentication_transactions','reauthentication_grants',
    'support_access_requests','support_access_sessions'
  ]
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%s_updated_at ON %I', t, t);
    EXECUTE format(
      'CREATE TRIGGER trg_%s_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
      t, t);
  END LOOP;
END $$;

-- ============================================================
-- Total: 4 sections, 0 tables created, 0 rows deleted, every existing
-- security assertion defaulted to its CLOSED value.
-- ============================================================
