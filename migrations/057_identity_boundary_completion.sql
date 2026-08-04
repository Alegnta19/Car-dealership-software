-- ============================================================
-- 057_identity_boundary_completion.sql — FBL-020-R2
--
-- Governing document: Master Blueprint v2.0 §14.3.
--
-- Forward-only. Migrations 000 and 049–056 remain byte-identical; nothing
-- here edits, renames, reorders or recomputes them.
--
-- The theme of this migration is that an identity relationship must be
-- PROVABLE, never inferred. Where R1 left a relationship nullable or
-- ambiguous, R2 either binds it exactly or closes it:
--
--   * a local session that cannot name the connection, issuer and provider
--     subject it was established through is UNPROVABLE and is revoked;
--   * a UserLink that cannot be bound to exactly one active connection is
--     AMBIGUOUS and is disabled;
--   * a login is no longer trusted from a cookie alone: an authoritative,
--     expiring, atomically consumed server transaction owns state, nonce,
--     PKCE and redirect, so a replay is refused by the database rather than
--     by a sealed blob the client holds.
--
-- Nothing guesses. No identity relationship is invented, no credential is
-- fabricated, and every value that would assert a security fact we cannot
-- prove is written as its CLOSED value.
-- ============================================================

-- ──────────────────────────────────────────────────────────────
-- Section 1 — exact external-identity binding on UserLink
--
-- R1 bound a link to (tenant, provider, provider_user_id). R2 additionally
-- binds the provider ORGANIZATION and the exact CONNECTION, so a link can
-- never be satisfied by a token from a different organization that happens
-- to map to the same tenant.
-- ──────────────────────────────────────────────────────────────

ALTER TABLE user_links
  ADD COLUMN connection_id            UUID REFERENCES identity_provider_connections (connection_id),
  ADD COLUMN provider_organization_id TEXT,
  ADD COLUMN issuer                   TEXT;

ALTER TABLE user_links
  ADD CONSTRAINT ul_org_shape CHECK (
    provider_organization_id IS NULL OR length(provider_organization_id) BETWEEN 1 AND 200
  ),
  ADD CONSTRAINT ul_issuer_shape CHECK (issuer IS NULL OR length(issuer) BETWEEN 1 AND 400),
  -- an ACTIVATED link must be fully bound; a pending one need not be yet
  ADD CONSTRAINT ul_activated_is_bound CHECK (
    status <> 'activated'
    OR (connection_id IS NOT NULL AND provider_organization_id IS NOT NULL AND issuer IS NOT NULL)
  );

-- Deterministic binding of EXISTING links: a link binds only when its tenant
-- has EXACTLY ONE active connection. Anything else is ambiguous.
UPDATE user_links ul
   SET connection_id = c.connection_id,
       provider_organization_id = c.provider_organization_id,
       issuer = c.issuer
  FROM identity_provider_connections c
 WHERE c.tenant_id IS NOT DISTINCT FROM ul.tenant_id
   AND c.provider = ul.provider
   AND c.status = 'active'
   AND ul.connection_id IS NULL
   AND (
     SELECT COUNT(*) FROM identity_provider_connections c2
      WHERE c2.tenant_id IS NOT DISTINCT FROM ul.tenant_id
        AND c2.provider = ul.provider
        AND c2.status = 'active'
   ) = 1;

-- AMBIGUOUS links — no active connection, or more than one — are DISABLED.
-- Guessing which organization a person belongs to is exactly the thing this
-- migration exists to stop.
UPDATE user_links
   SET status = 'deactivated',
       deactivated_at = COALESCE(deactivated_at, NOW()),
       authorization_version = authorization_version + 1,
       updated_at = NOW()
 WHERE status = 'activated'
   AND (connection_id IS NULL OR provider_organization_id IS NULL OR issuer IS NULL);

-- ──────────────────────────────────────────────────────────────
-- Section 2 — locally revocable sessions with NO nullable-connection bypass
--
-- R1 checked the connection only when the session named one, so a session
-- with a NULL connection skipped the check entirely. R2 removes the bypass:
-- the columns become mandatory, and every session that cannot prove its
-- provenance is revoked rather than grandfathered.
-- ──────────────────────────────────────────────────────────────

-- Revoke unprovable legacy sessions FIRST, then tighten.
UPDATE identity_sessions
   SET revoked_at = COALESCE(revoked_at, NOW()),
       revoked_reason = COALESCE(revoked_reason, 'fbl_020_r2_unprovable_binding')
 WHERE revoked_at IS NULL
   AND (connection_id IS NULL OR issuer IS NULL);

ALTER TABLE identity_sessions
  ADD COLUMN provider_subject TEXT,
  ADD COLUMN provider_organization_id TEXT,
  -- sealed, ROTATING refresh state: only a digest is ever stored
  ADD COLUMN refresh_token_hash TEXT,
  ADD COLUMN refresh_rotation_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN last_refreshed_at TIMESTAMPTZ;

ALTER TABLE identity_sessions
  ADD CONSTRAINT is_subject_shape CHECK (
    provider_subject IS NULL OR length(provider_subject) BETWEEN 1 AND 200
  ),
  ADD CONSTRAINT is_org_shape CHECK (
    provider_organization_id IS NULL OR length(provider_organization_id) BETWEEN 1 AND 200
  ),
  ADD CONSTRAINT is_refresh_hash_shape CHECK (
    refresh_token_hash IS NULL OR refresh_token_hash ~ '^[0-9a-f]{64}$'
  ),
  ADD CONSTRAINT is_rotation_nonnegative CHECK (refresh_rotation_count >= 0),
  -- THE BYPASS REMOVAL: a session that is not revoked must name the exact
  -- connection, issuer, organization and subject it was established through.
  ADD CONSTRAINT is_live_session_fully_bound CHECK (
    revoked_at IS NOT NULL
    OR (
      connection_id IS NOT NULL
      AND issuer IS NOT NULL
      AND provider_subject IS NOT NULL
      AND provider_organization_id IS NOT NULL
    )
  );

CREATE INDEX idx_is_connection ON identity_sessions (connection_id) WHERE revoked_at IS NULL;

-- ──────────────────────────────────────────────────────────────
-- Section 3 — authoritative server-side login transactions
--
-- The sealed cookie is now only a POINTER. The authority for state, nonce,
-- PKCE and redirect lives here, expires here, and is consumed here exactly
-- once — so a replayed callback is refused by a conditional UPDATE, not by
-- trusting a value the client still holds.
-- ──────────────────────────────────────────────────────────────

CREATE TABLE login_transactions (
  login_txn_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purpose                 TEXT NOT NULL CHECK (purpose IN ('login', 'reauth')),
  -- every secret is stored ONLY as a SHA-256 digest
  state_hash              TEXT NOT NULL UNIQUE CHECK (state_hash ~ '^[0-9a-f]{64}$'),
  nonce_hash              TEXT NOT NULL CHECK (nonce_hash ~ '^[0-9a-f]{64}$'),
  code_verifier_hash      TEXT NOT NULL CHECK (code_verifier_hash ~ '^[0-9a-f]{64}$'),
  redirect_uri            TEXT NOT NULL CHECK (length(redirect_uri) BETWEEN 1 AND 2000),
  -- bindings known when the transaction opens (a login knows none of the
  -- identity yet; a reauth knows all of it)
  tenant_id               UUID REFERENCES tenants (tenant_id),
  connection_id           UUID REFERENCES identity_provider_connections (connection_id),
  user_link_id            UUID REFERENCES user_links (user_link_id),
  reauth_txn_id           UUID REFERENCES reauthentication_transactions (reauth_txn_id),
  return_to               TEXT CHECK (return_to IS NULL OR length(return_to) BETWEEN 1 AND 2000),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at              TIMESTAMPTZ NOT NULL,
  consumed_at             TIMESTAMPTZ,
  consumed_outcome        TEXT CHECK (consumed_outcome IS NULL OR
                                      consumed_outcome IN ('succeeded', 'failed')),
  CHECK (expires_at > created_at),
  CHECK ((consumed_at IS NULL) = (consumed_outcome IS NULL)),
  -- a reauth transaction must name what it is re-authenticating
  CHECK (purpose <> 'reauth' OR (reauth_txn_id IS NOT NULL AND user_link_id IS NOT NULL))
);
CREATE INDEX idx_lt_live ON login_transactions (expires_at) WHERE consumed_at IS NULL;

DROP TRIGGER IF EXISTS trg_login_transactions_updated_at ON login_transactions;

-- ──────────────────────────────────────────────────────────────
-- Section 4 — exact reauthentication binding
--
-- A reauthentication must come back through the SAME connection, issuer,
-- organization and subject it started from. R1 checked the nonce and the
-- auth_time; R2 checks the identity it belongs to.
-- ──────────────────────────────────────────────────────────────

ALTER TABLE reauthentication_transactions
  ADD COLUMN connection_id            UUID REFERENCES identity_provider_connections (connection_id),
  ADD COLUMN issuer                   TEXT,
  ADD COLUMN provider_organization_id TEXT,
  ADD COLUMN provider_subject         TEXT;

ALTER TABLE reauthentication_transactions
  ADD CONSTRAINT rat_issuer_shape CHECK (issuer IS NULL OR length(issuer) BETWEEN 1 AND 400),
  ADD CONSTRAINT rat_org_shape CHECK (
    provider_organization_id IS NULL OR length(provider_organization_id) BETWEEN 1 AND 200
  ),
  ADD CONSTRAINT rat_subject_shape CHECK (
    provider_subject IS NULL OR length(provider_subject) BETWEEN 1 AND 200
  ),
  -- a STARTED transaction must be fully bound before it can complete
  ADD CONSTRAINT rat_started_is_bound CHECK (
    state <> 'started'
    OR (connection_id IS NOT NULL AND issuer IS NOT NULL
        AND provider_organization_id IS NOT NULL AND provider_subject IS NOT NULL)
  );

-- Any transaction still 'started' from before R2 cannot satisfy the new
-- binding rule; expire it rather than leave it usable.
UPDATE reauthentication_transactions
   SET state = 'expired'
 WHERE state = 'started'
   AND (connection_id IS NULL OR issuer IS NULL
        OR provider_organization_id IS NULL OR provider_subject IS NULL);

-- ──────────────────────────────────────────────────────────────
-- Section 5 — support access authority and high-assurance approval
-- ──────────────────────────────────────────────────────────────

ALTER TABLE support_access_requests
  ADD COLUMN approver_assurance TEXT NOT NULL DEFAULT 'fresh_and_mfa_policy'
                                CHECK (approver_assurance IN ('fresh_only', 'fresh_and_mfa_policy')),
  ADD COLUMN approval_grant_id  UUID REFERENCES reauthentication_grants (grant_id),
  -- an APPROVED request must record the high-assurance grant that approved it
  ADD CONSTRAINT sar_approval_is_high_assurance CHECK (
    status <> 'approved' OR approval_grant_id IS NOT NULL
  );

-- ──────────────────────────────────────────────────────────────
-- Section 6 — policy evidence: auth_time and the true actor
-- ──────────────────────────────────────────────────────────────

ALTER TABLE policy_decisions
  ADD COLUMN auth_time            TIMESTAMPTZ,
  ADD COLUMN connection_id        UUID,
  ADD COLUMN session_id           UUID,
  ADD COLUMN actor_provider_subject TEXT;

ALTER TABLE policy_decisions
  ADD CONSTRAINT pd_actor_subject_shape CHECK (
    actor_provider_subject IS NULL OR length(actor_provider_subject) BETWEEN 1 AND 200
  );

-- ============================================================
-- Total: 1 table created (login_transactions), 0 rows deleted.
-- Unprovable sessions revoked; ambiguous links disabled; every new
-- security assertion defaults CLOSED.
-- ============================================================
