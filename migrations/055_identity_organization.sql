-- ============================================================
-- 055_identity_organization.sql — FBL-020 Identity and Organization v1
--
-- One forward-only, additive migration: 14 tables in five sections
-- (organization hierarchy, identity provider + users + sessions,
-- authorization, reauthentication, support access), the append-only
-- guard on policy evidence, updated_at maintenance, and the backfill.
--
-- Deliberate deviations from the 049-054 house style, both rooted in
-- the documented bundle hazards (docs/PLATFORM-CONTEXT.md §5):
--   * plain CREATE TABLE, not IF NOT EXISTS. These are brand-new
--     namespaces; a name collision here means something is genuinely
--     wrong and must fail loudly, not silently keep a foreign shape.
--   * every uniqueness guarantee is tenant-qualified from this first
--     migration — there is no global-name era to migrate away from.
--
-- Rollback story: additive only. Rolling the APPLICATION back to the
-- FBL-010 head ignores every object here; no existing table, column,
-- index or constraint is touched. The backfill inserts rows only into
-- the new tables, derived exclusively from retained business data.
-- No users, credentials, role bindings or provider connections are
-- invented; backfilled organization rows carry
-- status = 'pending_configuration' and activate only through the
-- bootstrap/administration path.
-- ============================================================

-- ──────────────────────────────────────────────────────────────
-- Section 1 — organization hierarchy
-- Tenant -> DealerGroup -> LegalEntity -> Rooftop -> Department.
-- The internal Tenant row is the authoritative business boundary;
-- WorkOS Organizations are only an external mapping (section 2).
-- Composite foreign keys carry tenant_id down every edge so a child
-- can never attach to a parent in another tenant.
-- No hard deletes anywhere: retirement is status = 'archived' plus
-- the effective window.
-- ──────────────────────────────────────────────────────────────

CREATE TABLE tenants (
  tenant_id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                    TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  status                  TEXT NOT NULL DEFAULT 'pending_configuration'
                          CHECK (status IN ('pending_configuration','active','suspended','archived')),
  effective_from          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  effective_to            TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);

CREATE TABLE dealer_groups (
  dealer_group_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants (tenant_id),
  name                    TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  status                  TEXT NOT NULL DEFAULT 'pending_configuration'
                          CHECK (status IN ('pending_configuration','active','inactive','archived')),
  effective_from          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  effective_to            TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (effective_to IS NULL OR effective_to > effective_from),
  -- FK target for tenant-carrying composite edges out of children.
  UNIQUE (tenant_id, dealer_group_id)
);
CREATE UNIQUE INDEX uq_dg_tenant_name ON dealer_groups (tenant_id, lower(name))
  WHERE status <> 'archived';

CREATE TABLE legal_entities (
  legal_entity_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants (tenant_id),
  dealer_group_id         UUID NOT NULL,
  name                    TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  status                  TEXT NOT NULL DEFAULT 'pending_configuration'
                          CHECK (status IN ('pending_configuration','active','inactive','archived')),
  effective_from          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  effective_to            TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (effective_to IS NULL OR effective_to > effective_from),
  UNIQUE (tenant_id, legal_entity_id),
  -- same-tenant parentage, enforced structurally
  FOREIGN KEY (tenant_id, dealer_group_id) REFERENCES dealer_groups (tenant_id, dealer_group_id)
);
CREATE UNIQUE INDEX uq_le_tenant_name ON legal_entities (tenant_id, lower(name))
  WHERE status <> 'archived';
CREATE INDEX idx_le_group ON legal_entities (tenant_id, dealer_group_id, status);

-- The compatibility bridge to everything that already exists: for
-- backfilled rows rooftop_id IS the legacy location_id, so every
-- location_id column in the fixed-ops tables resolves to a Rooftop
-- without renaming a single legacy column.
CREATE TABLE rooftops (
  rooftop_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants (tenant_id),
  legal_entity_id         UUID NOT NULL,
  name                    TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  status                  TEXT NOT NULL DEFAULT 'pending_configuration'
                          CHECK (status IN ('pending_configuration','active','inactive','archived')),
  effective_from          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  effective_to            TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (effective_to IS NULL OR effective_to > effective_from),
  UNIQUE (tenant_id, rooftop_id),
  FOREIGN KEY (tenant_id, legal_entity_id) REFERENCES legal_entities (tenant_id, legal_entity_id)
);
CREATE UNIQUE INDEX uq_rt_tenant_name ON rooftops (tenant_id, lower(name))
  WHERE status <> 'archived';
CREATE INDEX idx_rt_entity ON rooftops (tenant_id, legal_entity_id, status);

CREATE TABLE departments (
  department_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants (tenant_id),
  rooftop_id              UUID NOT NULL,
  code                    TEXT NOT NULL CHECK (code ~ '^[a-z][a-z0-9_]{0,63}$'),
  name                    TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  status                  TEXT NOT NULL DEFAULT 'pending_configuration'
                          CHECK (status IN ('pending_configuration','active','inactive','archived')),
  effective_from          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  effective_to            TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (effective_to IS NULL OR effective_to > effective_from),
  UNIQUE (tenant_id, department_id),
  FOREIGN KEY (tenant_id, rooftop_id) REFERENCES rooftops (tenant_id, rooftop_id)
);
CREATE UNIQUE INDEX uq_dept_rooftop_code ON departments (tenant_id, rooftop_id, code)
  WHERE status <> 'archived';

-- ──────────────────────────────────────────────────────────────
-- Section 2 — identity provider mapping, user links, sessions
-- The provider CHECK admits only 'workos': SAML/SCIM stay
-- interface-only in this order and are not enableable, at the
-- database layer included.
-- actor_scope separates dealership identities (tenant-bound) from
-- platform identities (tenant_id IS NULL) with the pairing enforced
-- by CHECK. A platform identity NEVER implies dealership access —
-- that is the role/policy layer's job (sections 3 and 5).
-- ──────────────────────────────────────────────────────────────

CREATE TABLE identity_provider_connections (
  connection_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_scope        TEXT NOT NULL CHECK (connection_scope IN ('dealership','platform')),
  tenant_id               UUID REFERENCES tenants (tenant_id),
  provider                TEXT NOT NULL CHECK (provider IN ('workos')),
  provider_organization_id TEXT NOT NULL CHECK (length(provider_organization_id) BETWEEN 1 AND 200),
  status                  TEXT NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active','disabled')),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((connection_scope = 'dealership') = (tenant_id IS NOT NULL)),
  -- one internal home per external organization
  UNIQUE (provider, provider_organization_id)
);
-- at most one ACTIVE connection per provider per tenant (and one
-- platform-scope connection, via NULLS NOT DISTINCT)
CREATE UNIQUE INDEX uq_ipc_active ON identity_provider_connections (provider, tenant_id)
  NULLS NOT DISTINCT WHERE status = 'active';

CREATE TABLE user_links (
  user_link_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_scope             TEXT NOT NULL CHECK (actor_scope IN ('dealership','platform')),
  tenant_id               UUID REFERENCES tenants (tenant_id),
  provider                TEXT NOT NULL CHECK (provider IN ('workos')),
  provider_user_id        TEXT NOT NULL CHECK (length(provider_user_id) BETWEEN 1 AND 200),
  email                   TEXT CHECK (email IS NULL OR length(email) BETWEEN 3 AND 320),
  display_name            TEXT CHECK (display_name IS NULL OR length(display_name) BETWEEN 1 AND 200),
  status                  TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','activated','deactivated')),
  activated_at            TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((actor_scope = 'dealership') = (tenant_id IS NOT NULL)),
  -- one-way: activation stamps a time; later deactivation keeps the history
  CHECK (status <> 'activated' OR activated_at IS NOT NULL),
  -- one link per provider identity per tenant (platform identities
  -- occupy the NULL-tenant slot exactly once, NULLS NOT DISTINCT)
  UNIQUE NULLS NOT DISTINCT (tenant_id, provider, provider_user_id),
  -- FK target for tenant-carrying composite edges
  UNIQUE NULLS NOT DISTINCT (tenant_id, user_link_id)
);
CREATE INDEX idx_ul_tenant_status ON user_links (tenant_id, status);

-- Server-side session records behind the HttpOnly cookie. The cookie
-- carries an opaque value; only its SHA-256 hex digest is stored, so a
-- database read can never be replayed as a session.
CREATE TABLE identity_sessions (
  session_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID REFERENCES tenants (tenant_id),
  user_link_id            UUID NOT NULL REFERENCES user_links (user_link_id),
  session_token_hash      TEXT NOT NULL UNIQUE CHECK (session_token_hash ~ '^[0-9a-f]{64}$'),
  provider_session_id     TEXT CHECK (provider_session_id IS NULL OR length(provider_session_id) BETWEEN 1 AND 200),
  auth_time               TIMESTAMPTZ NOT NULL,
  issued_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at              TIMESTAMPTZ NOT NULL,
  last_seen_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at              TIMESTAMPTZ,
  revoked_reason          TEXT CHECK (revoked_reason IS NULL OR length(revoked_reason) BETWEEN 1 AND 200),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (expires_at > issued_at),
  FOREIGN KEY (tenant_id, user_link_id) REFERENCES user_links (tenant_id, user_link_id)
);
CREATE INDEX idx_is_user ON identity_sessions (user_link_id, expires_at DESC);
CREATE INDEX idx_is_live ON identity_sessions (expires_at) WHERE revoked_at IS NULL;

-- ──────────────────────────────────────────────────────────────
-- Section 3 — authorization: role bindings + decision evidence
-- RoleBindings are the DATABASE-AUTHORITATIVE source of privilege;
-- provider claims are display hints. scope_level 'platform' is the
-- only tenant-less binding shape (platform control roles carry no
-- implicit dealership access).
-- policy_decisions is APPEND-ONLY EVIDENCE — ids, codes and versions
-- only, never PII, never free text; the trigger in section 6 makes
-- UPDATE/DELETE impossible.
-- ──────────────────────────────────────────────────────────────

CREATE TABLE role_bindings (
  role_binding_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID REFERENCES tenants (tenant_id),
  user_link_id            UUID NOT NULL REFERENCES user_links (user_link_id),
  role                    TEXT NOT NULL CHECK (role ~ '^[a-z][a-z0-9_]{0,63}$'),
  scope_level             TEXT NOT NULL
                          CHECK (scope_level IN ('platform','tenant','dealer_group','legal_entity','rooftop','department')),
  scope_id                UUID,
  status                  TEXT NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active','revoked')),
  granted_by_user_link_id UUID REFERENCES user_links (user_link_id),
  granted_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at              TIMESTAMPTZ,
  revoked_by_user_link_id UUID REFERENCES user_links (user_link_id),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- platform bindings and only platform bindings are tenant-less and scope-less
  CHECK ((scope_level = 'platform') = (scope_id IS NULL)),
  CHECK ((scope_level = 'platform') = (tenant_id IS NULL)),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
  FOREIGN KEY (tenant_id, user_link_id) REFERENCES user_links (tenant_id, user_link_id)
);
CREATE UNIQUE INDEX uq_rb_active ON role_bindings (tenant_id, user_link_id, role, scope_level, scope_id)
  NULLS NOT DISTINCT WHERE status = 'active';
CREATE INDEX idx_rb_user_active ON role_bindings (user_link_id) WHERE status = 'active';

CREATE TABLE policy_decisions (
  decision_id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  tenant_id               UUID,
  actor_user_link_id      UUID,
  actor_type              TEXT NOT NULL CHECK (actor_type IN ('user','platform_support','system')),
  action                  TEXT NOT NULL CHECK (action ~ '^[a-z][a-z0-9_.:]{0,127}$'),
  resource_type           TEXT CHECK (resource_type IS NULL OR resource_type ~ '^[a-z][a-z0-9_]{0,63}$'),
  resource_id             UUID,
  scope_level             TEXT CHECK (scope_level IS NULL OR
                                      scope_level IN ('platform','tenant','dealer_group','legal_entity','rooftop','department')),
  scope_id                UUID,
  decision                TEXT NOT NULL CHECK (decision IN ('allow','deny')),
  reason_code             TEXT NOT NULL CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  policy_version          TEXT NOT NULL CHECK (length(policy_version) BETWEEN 1 AND 40),
  request_id              TEXT CHECK (request_id IS NULL OR length(request_id) BETWEEN 8 AND 128),
  support_session_id      UUID,
  details                 JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_pd_tenant_time ON policy_decisions (tenant_id, occurred_at DESC);
CREATE INDEX idx_pd_actor      ON policy_decisions (actor_user_link_id, occurred_at DESC)
  WHERE actor_user_link_id IS NOT NULL;
CREATE INDEX idx_pd_request    ON policy_decisions (request_id) WHERE request_id IS NOT NULL;

-- ──────────────────────────────────────────────────────────────
-- Section 4 — reauthentication (provider-backed step-up)
-- A sensitive action opens a TRANSACTION, the user re-authenticates
-- at the provider with max_age=0, and the callback — proven by an
-- auth_time after the transaction start — mints a single-use GRANT.
-- Only SHA-256 digests of the opaque values are stored; consumption
-- is atomic (UPDATE ... WHERE consumed_at IS NULL) and replays fail
-- closed.
-- ──────────────────────────────────────────────────────────────

CREATE TABLE reauthentication_transactions (
  reauth_txn_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants (tenant_id),
  user_link_id            UUID NOT NULL REFERENCES user_links (user_link_id),
  action                  TEXT NOT NULL CHECK (action ~ '^[a-z][a-z0-9_.:]{0,127}$'),
  resource_type           TEXT CHECK (resource_type IS NULL OR resource_type ~ '^[a-z][a-z0-9_]{0,63}$'),
  resource_id             UUID,
  nonce_hash              TEXT NOT NULL UNIQUE CHECK (nonce_hash ~ '^[0-9a-f]{64}$'),
  state                   TEXT NOT NULL DEFAULT 'started'
                          CHECK (state IN ('started','completed','failed','expired')),
  started_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at              TIMESTAMPTZ NOT NULL,
  completed_at            TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (expires_at > started_at),
  CHECK ((state = 'completed') = (completed_at IS NOT NULL)),
  FOREIGN KEY (tenant_id, user_link_id) REFERENCES user_links (tenant_id, user_link_id)
);
CREATE INDEX idx_rat_user ON reauthentication_transactions (user_link_id, started_at DESC);

CREATE TABLE reauthentication_grants (
  grant_id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- exactly one grant per completed transaction
  reauth_txn_id           UUID NOT NULL UNIQUE REFERENCES reauthentication_transactions (reauth_txn_id),
  tenant_id               UUID NOT NULL REFERENCES tenants (tenant_id),
  user_link_id            UUID NOT NULL REFERENCES user_links (user_link_id),
  action                  TEXT NOT NULL CHECK (action ~ '^[a-z][a-z0-9_.:]{0,127}$'),
  resource_type           TEXT CHECK (resource_type IS NULL OR resource_type ~ '^[a-z][a-z0-9_]{0,63}$'),
  resource_id             UUID,
  grant_hash              TEXT NOT NULL UNIQUE CHECK (grant_hash ~ '^[0-9a-f]{64}$'),
  issued_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at              TIMESTAMPTZ NOT NULL,
  consumed_at             TIMESTAMPTZ,
  consumed_request_id     TEXT CHECK (consumed_request_id IS NULL OR length(consumed_request_id) BETWEEN 8 AND 128),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (expires_at > issued_at),
  FOREIGN KEY (tenant_id, user_link_id) REFERENCES user_links (tenant_id, user_link_id)
);
CREATE INDEX idx_rag_user ON reauthentication_grants (user_link_id, issued_at DESC);

-- ──────────────────────────────────────────────────────────────
-- Section 5 — delegated support access (never impersonation)
-- The platform-support actor stays the actor everywhere. Approval
-- must come from a DIFFERENT user (CHECK below); sessions are capped
-- at 60 minutes STRUCTURALLY and are revocable at any time.
-- reason lives here and only here — it never enters ordinary logs.
-- ──────────────────────────────────────────────────────────────

CREATE TABLE support_access_requests (
  request_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants (tenant_id),
  requester_user_link_id  UUID NOT NULL REFERENCES user_links (user_link_id),
  requested_actions       TEXT[] NOT NULL CHECK (cardinality(requested_actions) BETWEEN 1 AND 50),
  scope_level             TEXT NOT NULL DEFAULT 'tenant'
                          CHECK (scope_level IN ('tenant','dealer_group','legal_entity','rooftop','department')),
  scope_id                UUID,
  reason                  TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 2000),
  requested_duration_minutes INTEGER NOT NULL CHECK (requested_duration_minutes BETWEEN 1 AND 60),
  status                  TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','approved','denied','cancelled','expired')),
  decided_by_user_link_id UUID REFERENCES user_links (user_link_id),
  decided_at              TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((scope_level = 'tenant') = (scope_id IS NULL)),
  -- requester/approver separation is the control: structurally enforced
  CHECK (decided_by_user_link_id IS NULL OR decided_by_user_link_id <> requester_user_link_id),
  CHECK ((status IN ('approved','denied')) = (decided_at IS NOT NULL))
);
CREATE INDEX idx_sar_tenant ON support_access_requests (tenant_id, status, created_at DESC);

CREATE TABLE support_access_sessions (
  support_session_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id              UUID NOT NULL UNIQUE REFERENCES support_access_requests (request_id),
  tenant_id               UUID NOT NULL REFERENCES tenants (tenant_id),
  actor_user_link_id      UUID NOT NULL REFERENCES user_links (user_link_id),
  granted_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at              TIMESTAMPTZ NOT NULL,
  revoked_at              TIMESTAMPTZ,
  revoked_by_user_link_id UUID REFERENCES user_links (user_link_id),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (expires_at > granted_at),
  -- the 60-minute ceiling is a table constraint, not an application habit
  CHECK (expires_at <= granted_at + INTERVAL '60 minutes')
);
CREATE INDEX idx_sas_tenant_live ON support_access_sessions (tenant_id, expires_at DESC)
  WHERE revoked_at IS NULL;

-- ──────────────────────────────────────────────────────────────
-- Section 6 — triggers
-- ──────────────────────────────────────────────────────────────

-- policy evidence is append-only: no row, once written, can change
CREATE OR REPLACE FUNCTION identity_append_only() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION '% on % is not permitted: append-only evidence', TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_policy_decisions_append_only ON policy_decisions;
CREATE TRIGGER trg_policy_decisions_append_only
  BEFORE UPDATE OR DELETE ON policy_decisions
  FOR EACH ROW EXECUTE FUNCTION identity_append_only();

-- updated_at maintenance, same mechanism migration 050 installed
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'tenants','dealer_groups','legal_entities','rooftops','departments',
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

-- ──────────────────────────────────────────────────────────────
-- Section 7 — backfill (additive, derived, inert)
-- Sources are enumerated from the catalog rather than a hand-kept
-- list so no tenant-bearing table can be missed. Everything lands as
-- 'pending_configuration'; nothing activates, nothing is deleted,
-- and NO user, role binding, session or provider connection is
-- created. On a fresh database every statement here is a no-op.
-- ──────────────────────────────────────────────────────────────

-- 7a. every tenant_id that owns retained data becomes a pending tenant
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT DISTINCT c.table_name
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name
     WHERE c.table_schema = 'public'
       AND c.column_name = 'tenant_id'
       AND c.data_type = 'uuid'
       AND t.table_type = 'BASE TABLE'
       AND c.table_name NOT IN (
         'tenants','dealer_groups','legal_entities','rooftops','departments',
         'identity_provider_connections','user_links','identity_sessions',
         'role_bindings','policy_decisions','reauthentication_transactions',
         'reauthentication_grants','support_access_requests','support_access_sessions')
  LOOP
    EXECUTE format(
      $ins$INSERT INTO tenants (tenant_id, name, status)
             SELECT DISTINCT tenant_id, 'Pending configuration', 'pending_configuration'
               FROM %I WHERE tenant_id IS NOT NULL
           ON CONFLICT (tenant_id) DO NOTHING$ins$, r.table_name);
  END LOOP;
END $$;

-- 7b. minimal ancestors: one pending dealer group and one pending
--     legal entity per backfilled tenant
INSERT INTO dealer_groups (tenant_id, name, status)
SELECT t.tenant_id, 'Pending configuration', 'pending_configuration'
  FROM tenants t
 WHERE NOT EXISTS (SELECT 1 FROM dealer_groups g WHERE g.tenant_id = t.tenant_id);

INSERT INTO legal_entities (tenant_id, dealer_group_id, name, status)
SELECT g.tenant_id, g.dealer_group_id, 'Pending configuration', 'pending_configuration'
  FROM dealer_groups g
 WHERE NOT EXISTS (SELECT 1 FROM legal_entities le WHERE le.tenant_id = g.tenant_id);

-- 7c. a location_id shared by two tenants would mean the legacy data
--     is already corrupt — fail LOUDLY rather than attach the rooftop
--     to whichever tenant happened to insert first
DO $$
DECLARE r RECORD; bad INTEGER := 0; n INTEGER;
BEGIN
  CREATE TEMP TABLE _fbl020_locations (tenant_id UUID NOT NULL, location_id UUID NOT NULL) ON COMMIT DROP;
  FOR r IN
    SELECT DISTINCT a.table_name
      FROM information_schema.columns a
      JOIN information_schema.columns b
        ON b.table_schema = a.table_schema AND b.table_name = a.table_name
      JOIN information_schema.tables t
        ON t.table_schema = a.table_schema AND t.table_name = a.table_name
     WHERE a.table_schema = 'public' AND t.table_type = 'BASE TABLE'
       AND a.column_name = 'tenant_id'   AND a.data_type = 'uuid'
       AND b.column_name = 'location_id' AND b.data_type = 'uuid'
       AND a.table_name NOT IN ('rooftops')
  LOOP
    EXECUTE format(
      $ins$INSERT INTO _fbl020_locations (tenant_id, location_id)
             SELECT DISTINCT tenant_id, location_id FROM %I
              WHERE tenant_id IS NOT NULL AND location_id IS NOT NULL$ins$, r.table_name);
  END LOOP;

  SELECT COUNT(*) INTO bad FROM (
    SELECT location_id FROM _fbl020_locations GROUP BY location_id
    HAVING COUNT(DISTINCT tenant_id) > 1
  ) conflicted;
  IF bad > 0 THEN
    RAISE EXCEPTION 'FBL-020 backfill refused: % location_id value(s) appear under more than one tenant', bad;
  END IF;

  -- 7d. every retained (tenant, location) pair becomes a rooftop whose
  --     id IS the legacy location_id, attached to the tenant's single
  --     backfilled legal entity (deterministically chosen)
  INSERT INTO rooftops (rooftop_id, tenant_id, legal_entity_id, name, status)
  SELECT DISTINCT
         l.location_id,
         l.tenant_id,
         (SELECT le.legal_entity_id FROM legal_entities le
           WHERE le.tenant_id = l.tenant_id
           ORDER BY le.created_at, le.legal_entity_id LIMIT 1),
         'Rooftop ' || left(l.location_id::text, 8),
         'pending_configuration'
    FROM _fbl020_locations l
  ON CONFLICT (rooftop_id) DO NOTHING;

  SELECT COUNT(*) INTO n FROM rooftops;
  RAISE NOTICE 'FBL-020 backfill: % rooftop rows present after backfill', n;
END $$;

-- ============================================================
-- Total: 14 tables, their indexes, 1 append-only trigger,
-- 13 updated_at triggers, catalog-driven backfill.
-- ============================================================
