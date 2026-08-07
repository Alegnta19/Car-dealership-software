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

-- Constraints are installed ONLY after the rows above are reconciled. R2
-- added them first, which would abort this migration on any populated
-- database that still held an unbound activated link.
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


-- ──────────────────────────────────────────────────────────────
-- Section 2 — locally revocable sessions with NO nullable-connection bypass
--
-- R1 checked the connection only when the session named one, so a session
-- with a NULL connection skipped the check entirely. R2 removes the bypass:
-- the columns become mandatory, and every session that cannot prove its
-- provenance is revoked rather than grandfathered.
--
-- R3 extends the same object to the BEARER credential path, which previously
-- had no local session at all and therefore nothing a local logout could
-- revoke. See `credential_kind` / `bearer_key_hash` below.
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
  -- Replay detection ONLY: the digest proves which refresh token a rotation
  -- was keyed on. It can never be exchanged with the provider.
  ADD COLUMN refresh_token_hash TEXT,
  ADD COLUMN refresh_rotation_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN last_refreshed_at TIMESTAMPTZ,
  -- FBL-020-R3: RECOVERABLE refresh state. A real refresh exchange has to
  -- present the token itself, which a one-way digest cannot do, so the token
  -- is kept as AES-256-GCM SEALED CIPHERTEXT (the same primitive the OAuth
  -- transaction cookie uses) under the configured cookie password. The KEY
  -- VERSION is recorded beside it: rotating the password then makes the old
  -- state provably unopenable instead of silently corrupt, and a session with
  -- an unreadable state degrades to "cannot refresh" rather than being
  -- destroyed. A database read still yields no usable credential without the
  -- password, which never lives in the database.
  ADD COLUMN refresh_state_sealed TEXT,
  ADD COLUMN refresh_state_key_version INTEGER,
  -- FBL-020-R3 correction D1: the REFRESH LEASE.
  --
  -- A refresh spends a SINGLE-USE credential at the provider, so exactly one
  -- attempt per session may be in flight. R3 enforced that by holding the
  -- session row's FOR UPDATE lock across the provider HTTP call — which made a
  -- provider that HANGS rather than errors pin one shared pool connection, in an
  -- open transaction, for as long as it hung. Ten due sessions exhausted the
  -- pool the whole API shares, for every tenant.
  --
  -- The lease replaces the lock. An attempt CLAIMS the refresh in a short
  -- transaction that commits and releases its connection; the provider call then
  -- happens with NO transaction open; a second short transaction persists the
  -- result only if the lease is still the claimant's. `refresh_lease_id` is the
  -- claim (an opaque server-minted identifier, never a credential and never sent
  -- anywhere), and `refresh_lease_expires_at` is what makes a crashed or hung
  -- attempt RECLAIMABLE instead of wedging the session forever: a lease whose
  -- expiry has passed is not a lease, and the next request may take it.
  ADD COLUMN refresh_lease_id UUID,
  ADD COLUMN refresh_lease_expires_at TIMESTAMPTZ,
  -- FBL-020-R3 correction C1: WHEN the provider access token this session last
  -- obtained stops being valid. An INSTANT, never a credential — the access
  -- token itself is never stored on the cookie path (the browser holds an
  -- opaque session value and authorization is decided from local role
  -- bindings), so the only thing kept is the `exp` the verifier already proved.
  --
  -- It exists because the sealed refresh state above needs a SPENDER. Without
  -- a stored expiry, "this session is at or near provider expiry" could only be
  -- guessed from a constant lifetime the provider never promised; with it, the
  -- request path reads a fact and refreshes exactly when it is due. NULL means
  -- the platform never learned the expiry, and a refresh is therefore never
  -- scheduled — the closed value, in the direction that spends nothing.
  ADD COLUMN provider_access_token_expires_at TIMESTAMPTZ,
  -- FBL-020-R3: WHICH CREDENTIAL this session belongs to.
  --
  -- Until now only the cookie path had a local session, so a bearer request
  -- had no locally revocable object at all: a local logout could not deny a
  -- provider access token that was still inside its validity window. A bearer
  -- credential now resolves a session row of its own.
  --
  -- `bearer_key_hash` is the SHA-256 of a domain-separated, length-prefixed
  -- join of the SEVEN facts that identify such a session — issuer, provider
  -- session id (sid), provider organization, provider subject, tenant, user
  -- link and connection. It is an INDEX KEY, never a credential: it is derived
  -- from identifiers the server already holds, it is never sent to a client,
  -- and it is deliberately a different column from session_token_hash so a
  -- value from one path can never be presented on the other.
  ADD COLUMN credential_kind TEXT NOT NULL DEFAULT 'cookie'
                             CHECK (credential_kind IN ('cookie', 'bearer')),
  ADD COLUMN bearer_key_hash TEXT;

-- A bearer session has NO cookie value, so it has no session_token_hash to
-- store. Fabricating one would put an unusable 64-hex digest in a column whose
-- entire meaning is "the digest of a credential a client can present"; the
-- honest shape is NULL, paired with the CHECK below that makes exactly one of
-- the two keys present. Relaxing NOT NULL is a WIDENING — no existing row can
-- violate it — so it is safe ahead of the reconciliation that follows.
ALTER TABLE identity_sessions ALTER COLUMN session_token_hash DROP NOT NULL;

-- Reconciliation before constraints, as everywhere in this file. Every session
-- that exists when this migration runs was minted by /auth/callback and is
-- therefore a COOKIE session; the column default already states that, so this
-- UPDATE matches ZERO rows on a database that migrates in order. It is written
-- anyway, ahead of the CHECKs that depend on it, because the ordering is the
-- property under review and because a later edit that drops the default must
-- not silently turn legacy rows into unclassified ones.
UPDATE identity_sessions
   SET credential_kind = 'cookie'
 WHERE credential_kind IS DISTINCT FROM 'cookie';

UPDATE identity_sessions
   SET bearer_key_hash = NULL
 WHERE credential_kind = 'cookie'
   AND bearer_key_hash IS NOT NULL;

-- A BEARER session takes custody of no provider credential: the caller presents
-- its own access token on every request and it is verified every time, so this
-- platform holds neither the token nor its expiry and has nothing to refresh.
-- Reconciliation before the CHECK that follows, as everywhere in this file; the
-- column is created NULL in the statement above, so this matches ZERO rows on a
-- database that migrates in order.
UPDATE identity_sessions
   SET provider_access_token_expires_at = NULL
 WHERE credential_kind = 'bearer'
   AND provider_access_token_expires_at IS NOT NULL;

-- ── R3 correction: the SUBJECT and ORGANIZATION reconciliation that was
-- missing entirely.
--
-- `is_live_session_fully_bound` below demands that a non-revoked session name
-- its connection, issuer, provider_subject AND provider_organization_id. The
-- last two columns are created by the statement above, so on ANY populated
-- database every existing live session held NULL for both and the constraint
-- aborted the whole migration. Reproduced before this fix on a populated
-- fixture: `check constraint "is_live_session_fully_bound" ... is violated by
-- some row`. Revoking on connection/issuer alone was never enough.
--
-- Nothing is guessed. The two facts are DERIVED from relationships the
-- database already holds:
--   * the subject is the provider_user_id of the user link the session was
--     issued to (the FK guarantees exactly one);
--   * the organization is the one carried by the session's OWN connection,
--     and only when that connection's issuer still agrees with the session's.
-- A session whose link is no longer bound to that same connection — including
-- every link section 1 just deactivated as ambiguous — matches nothing here.
UPDATE identity_sessions s
   SET provider_subject = ul.provider_user_id,
       provider_organization_id = c.provider_organization_id
  FROM user_links ul
  JOIN identity_provider_connections c ON c.connection_id = ul.connection_id
 WHERE ul.user_link_id = s.user_link_id
   AND s.revoked_at IS NULL
   AND s.connection_id = c.connection_id
   AND s.issuer = c.issuer
   AND (s.provider_subject IS NULL OR s.provider_organization_id IS NULL);

-- Whatever remains unprovable is REVOKED, exactly as the unbound sessions
-- above were. Inventing a subject or an organization is the one thing this
-- migration must never do.
UPDATE identity_sessions
   SET revoked_at = NOW(),
       revoked_reason = COALESCE(revoked_reason, 'fbl_020_r3_unprovable_subject_or_org')
 WHERE revoked_at IS NULL
   AND (provider_subject IS NULL OR provider_organization_id IS NULL);

-- Reconciliation FIRST, constraints after — the rule this migration exists to
-- respect. The UPDATE below discharges the new invariant "a REVOKED session
-- carries no refresh state": revocation must destroy the provider credential,
-- not merely stop honouring it, so a later bug can never exchange the refresh
-- token of a session that was already killed. It runs AFTER the revocations
-- above so it also covers anything they just closed.
--
-- Stated plainly: on a database that migrates in order this UPDATE matches
-- ZERO rows, because the refresh columns were created NULL in the statement
-- above. It is written anyway, ahead of the CHECK that depends on it, because
-- the ordering is the property under review.
UPDATE identity_sessions
   SET refresh_token_hash = NULL,
       refresh_state_sealed = NULL,
       refresh_state_key_version = NULL
 WHERE revoked_at IS NOT NULL
   AND (refresh_token_hash IS NOT NULL
        OR refresh_state_sealed IS NOT NULL
        OR refresh_state_key_version IS NOT NULL);

-- ── R3 correction D1: the LEASE reconciliation, ahead of its CHECKs ────────
--
-- A lease is a claim on a refresh attempt that is happening RIGHT NOW. No such
-- attempt can survive a migration, and a session that cannot be refreshed at all
-- must not carry one, so every lease is released here. Nothing is invented: the
-- closed value is "no attempt in flight", which spends nothing.
--
-- Stated plainly, as everywhere in this file: the two columns are created NULL in
-- the statement above, so on a database that migrates in order this matches ZERO
-- rows. It is written anyway, ahead of the CHECKs that depend on it, because the
-- ORDERING is the property under review — installing `is_refresh_lease_paired`
-- and `is_refresh_lease_needs_state` before this statement would abort the whole
-- migration on any database that had ever held a half-written lease.
UPDATE identity_sessions
   SET refresh_lease_id = NULL,
       refresh_lease_expires_at = NULL
 WHERE refresh_lease_id IS NOT NULL
    OR refresh_lease_expires_at IS NOT NULL;

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
  ADD CONSTRAINT is_refresh_state_shape CHECK (
    refresh_state_sealed IS NULL OR length(refresh_state_sealed) BETWEEN 1 AND 8000
  ),
  -- Sealed state and the key that opens it are ONE fact: either both or
  -- neither. A sealed blob with no key version is unopenable by construction.
  ADD CONSTRAINT is_refresh_state_versioned CHECK (
    (refresh_state_sealed IS NULL) = (refresh_state_key_version IS NULL)
  ),
  ADD CONSTRAINT is_refresh_key_version_positive CHECK (
    refresh_state_key_version IS NULL OR refresh_state_key_version >= 1
  ),
  -- Refresh state without its replay digest would be an exchangeable
  -- credential with NO replay detection. Refuse the shape outright.
  ADD CONSTRAINT is_refresh_state_has_digest CHECK (
    refresh_state_sealed IS NULL OR refresh_token_hash IS NOT NULL
  ),
  -- R3 correction D1 — THE LEASE, as two invariants rather than a convention.
  --
  -- A claim and its expiry are ONE fact: a lease with no expiry could never be
  -- reclaimed, which is exactly the wedged session the expiry exists to prevent.
  ADD CONSTRAINT is_refresh_lease_paired CHECK (
    (refresh_lease_id IS NULL) = (refresh_lease_expires_at IS NULL)
  ),
  -- …and a lease is a claim on SOMETHING. With no sealed state there is nothing
  -- to spend, so the claim would be meaningless. Note what this makes
  -- unrepresentable, transitively with the two CHECKs below it: a REVOKED session
  -- carries no refresh state, therefore no lease — so revocation releases the
  -- claim in the same statement that kills the session, and no code path can
  -- leave a dead session holding a live claim. A BEARER session likewise holds no
  -- refresh state, therefore no lease, on a path where a refresh is impossible.
  ADD CONSTRAINT is_refresh_lease_needs_state CHECK (
    refresh_lease_id IS NULL OR refresh_state_sealed IS NOT NULL
  ),
  -- REVOCATION DESTROYS THE CREDENTIAL. A revoked session keeps its audit
  -- trail (revoked_at, revoked_reason) and loses its refresh state, so no
  -- code path can ever refresh a session that was already killed.
  ADD CONSTRAINT is_revoked_holds_no_refresh_state CHECK (
    revoked_at IS NULL OR (refresh_token_hash IS NULL AND refresh_state_sealed IS NULL)
  ),
  -- EXACTLY ONE credential key per session. A cookie session is found by the
  -- digest of the opaque value the browser holds; a bearer session is found by
  -- the derived key over its seven identity facts. Neither shape can carry the
  -- other's key, so no lookup can ever cross the two paths.
  ADD CONSTRAINT is_cookie_key_iff_cookie CHECK (
    (credential_kind = 'cookie') = (session_token_hash IS NOT NULL)
  ),
  ADD CONSTRAINT is_bearer_key_iff_bearer CHECK (
    (credential_kind = 'bearer') = (bearer_key_hash IS NOT NULL)
  ),
  ADD CONSTRAINT is_bearer_key_shape CHECK (
    bearer_key_hash IS NULL OR bearer_key_hash ~ '^[0-9a-f]{64}$'
  ),
  -- A bearer session holds no refresh state: the provider access token is
  -- presented by the caller on every request, so this platform never takes
  -- custody of a refresh credential on that path and must not be able to.
  ADD CONSTRAINT is_bearer_holds_no_refresh_state CHECK (
    credential_kind <> 'bearer'
    OR (refresh_token_hash IS NULL AND refresh_state_sealed IS NULL)
  ),
  -- …and therefore holds no provider access-token expiry either. Recording one
  -- would assert a custody this platform does not have on that path, and would
  -- make a bearer session look schedulable for a refresh that can never happen.
  ADD CONSTRAINT is_bearer_holds_no_access_expiry CHECK (
    credential_kind <> 'bearer' OR provider_access_token_expires_at IS NULL
  ),
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

-- ONE session per bearer identity, for the whole life of the database — not
-- one per live session. That is deliberate: a revoked bearer session must stay
-- in the way of the credential that produced it, so re-presenting the SAME
-- provider token after a local logout finds the revoked row and is refused
-- instead of quietly establishing a fresh session. A genuinely new provider
-- authentication carries a new `sid`, which is a different key.
CREATE UNIQUE INDEX uq_is_bearer_identity ON identity_sessions (bearer_key_hash)
  WHERE bearer_key_hash IS NOT NULL;

-- ──────────────────────────────────────────────────────────────
-- Section 3 — authoritative server-side login transactions
--
-- The sealed cookie is now only a POINTER. The authority for state, nonce,
-- PKCE and redirect lives here, expires here, and is consumed here exactly
-- once — so a replayed callback is refused by a conditional UPDATE, not by
-- trusting a value the client still holds.
--
-- FBL-020-R3: the transaction also carries an EXPLICIT, TERMINAL state
-- machine. R2 recorded `consumed_outcome = 'succeeded'` at CLAIM time, which
-- said "this login succeeded" before the token had been verified, before the
-- identity had been admitted and before any local session existed — so a
-- login that fell over at any later step was recorded as a success. The
-- states are now:
--
--     pending ──claim──▶ consuming ──▶ succeeded
--        │                   │
--        └───────────────────┴──────▶ failed   (with a REASON, always)
--
-- `succeeded` is reachable ONLY from `consuming`, and only after identity
-- validation AND local-session establishment have both finished. `failed` is
-- reachable from either non-terminal state, because an unclaimed transaction
-- can still expire. Both terminal states are absorbing: the claim is
-- conditional on `pending`, so a replay at ANY stage loses.
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
  -- THE RETURN LOCATION LIVES HERE, not in the browser's cookie. It is
  -- allowlisted to a same-origin relative path when the transaction opens and
  -- read back from this row at the end of the round trip, so the destination
  -- of a successful login is a server fact the client cannot restate.
  return_to               TEXT CHECK (return_to IS NULL OR length(return_to) BETWEEN 1 AND 2000),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at              TIMESTAMPTZ NOT NULL,
  -- R3 state machine. `status` is the authority; claimed_at/consumed_at are
  -- the instants of its two transitions, and consumed_outcome is retained so
  -- the R2 shape of this table is still readable.
  status                  TEXT NOT NULL DEFAULT 'pending',
  claimed_at              TIMESTAMPTZ,
  -- WHY a transaction failed. Bounded, closed-vocabulary text written by the
  -- server; never a provider message, a token, a nonce or anything a caller
  -- supplied.
  failure_reason          TEXT,
  -- Correlation for operators. Both are SANITIZED before they arrive (the
  -- CHECKs below are the second line, not the first): a hostile header value
  -- must never reach this table.
  request_id              TEXT,
  correlation_id          TEXT,
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

-- Reconciliation BEFORE constraints, exactly as everywhere else in this file.
-- The table is created empty three statements above, so on a database that
-- migrates in order every UPDATE below matches ZERO rows. They are written
-- anyway, ahead of the CHECKs that depend on them, because the ORDERING is the
-- property under review and because an edit that later moves this table into
-- an earlier migration must not turn existing rows into unclassified ones.
--
-- Nothing is invented: the state is DERIVED from the R2 columns that already
-- recorded it. A row that was consumed with no outcome recorded is not
-- evidence of a success, so it reconciles to `failed`, not to `succeeded`.
UPDATE login_transactions
   SET status = CASE
                  WHEN consumed_outcome = 'succeeded' THEN 'succeeded'
                  WHEN consumed_at IS NOT NULL        THEN 'failed'
                  ELSE 'pending'
                END
 WHERE status NOT IN ('pending', 'consuming', 'succeeded', 'failed')
    OR (consumed_at IS NOT NULL AND status IN ('pending', 'consuming'))
    OR (consumed_at IS NULL AND status IN ('succeeded', 'failed'));

-- A `succeeded` transaction must name the instant it was claimed; the only
-- honest value for a row that predates the state machine is the instant it was
-- consumed. `failed` deliberately does NOT require a claim — an unclaimed
-- transaction can expire, and pretending it was claimed would be a fabrication.
UPDATE login_transactions
   SET claimed_at = consumed_at
 WHERE status = 'succeeded' AND claimed_at IS NULL;

UPDATE login_transactions
   SET failure_reason = 'fbl_020_r3_unclassified'
 WHERE status = 'failed' AND failure_reason IS NULL;

UPDATE login_transactions
   SET failure_reason = NULL
 WHERE status <> 'failed' AND failure_reason IS NOT NULL;

-- Correlation values that do not satisfy the shape are DROPPED, never
-- truncated into something that looks like a different request.
UPDATE login_transactions
   SET request_id = NULL
 WHERE request_id IS NOT NULL AND request_id !~ '^[A-Za-z0-9._-]{8,128}$';

UPDATE login_transactions
   SET correlation_id = NULL
 WHERE correlation_id IS NOT NULL AND correlation_id !~ '^[A-Za-z0-9._-]{8,128}$';

-- Now, and only now, the invariants.
ALTER TABLE login_transactions
  ADD CONSTRAINT lt_status_known CHECK (
    status IN ('pending', 'consuming', 'succeeded', 'failed')
  ),
  ADD CONSTRAINT lt_failure_reason_shape CHECK (
    failure_reason IS NULL OR length(failure_reason) BETWEEN 1 AND 100
  ),
  -- A failure that cannot say WHY is not evidence of anything, and a
  -- non-failure carrying a reason is a contradiction. Both are refused.
  ADD CONSTRAINT lt_failure_reason_iff_failed CHECK (
    (status = 'failed') = (failure_reason IS NOT NULL)
  ),
  ADD CONSTRAINT lt_request_id_shape CHECK (
    request_id IS NULL OR request_id ~ '^[A-Za-z0-9._-]{8,128}$'
  ),
  ADD CONSTRAINT lt_correlation_id_shape CHECK (
    correlation_id IS NULL OR correlation_id ~ '^[A-Za-z0-9._-]{8,128}$'
  ),
  -- THE STATE MACHINE ITSELF, as a database invariant rather than a
  -- convention in application code. Note what it makes UNREPRESENTABLE: a
  -- `succeeded` transaction that was never claimed, a terminal transaction
  -- with no consumption instant, and a status that disagrees with the R2
  -- outcome column.
  ADD CONSTRAINT lt_state_machine CHECK (
    (status = 'pending'
       AND claimed_at IS NULL AND consumed_at IS NULL AND consumed_outcome IS NULL)
    OR (status = 'consuming'
       AND claimed_at IS NOT NULL AND consumed_at IS NULL AND consumed_outcome IS NULL)
    OR (status = 'succeeded'
       AND claimed_at IS NOT NULL AND consumed_at IS NOT NULL
       AND consumed_outcome = 'succeeded')
    OR (status = 'failed'
       AND consumed_at IS NOT NULL AND consumed_outcome = 'failed')
  );

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
  ADD COLUMN provider_subject         TEXT,
  -- FBL-020-R3: the LOCAL SESSION the step-up starts from. A step-up is a
  -- statement about the person behind a live, locally revocable session; if
  -- that session is gone by the time the provider round trip returns, the
  -- grant has nothing left to be a step-up OF. Naming it here is what lets
  -- the completion revalidate it instead of assuming it.
  ADD COLUMN session_id               UUID REFERENCES identity_sessions (session_id);

-- Any transaction still 'started' from before R2/R3 cannot satisfy the new
-- binding rules; expire it rather than leave it usable. RECONCILIATION FIRST:
-- the CHECK constraints below would abort the migration on a populated
-- database if they preceded this statement.
UPDATE reauthentication_transactions
   SET state = 'expired'
 WHERE state = 'started'
   AND (connection_id IS NULL OR issuer IS NULL
        OR provider_organization_id IS NULL OR provider_subject IS NULL
        OR session_id IS NULL OR oidc_nonce_hash IS NULL);

-- Constraints follow reconciliation, never precede it.
ALTER TABLE reauthentication_transactions
  ADD CONSTRAINT rat_issuer_shape CHECK (issuer IS NULL OR length(issuer) BETWEEN 1 AND 400),
  ADD CONSTRAINT rat_org_shape CHECK (
    provider_organization_id IS NULL OR length(provider_organization_id) BETWEEN 1 AND 200
  ),
  ADD CONSTRAINT rat_subject_shape CHECK (
    provider_subject IS NULL OR length(provider_subject) BETWEEN 1 AND 200
  ),
  -- a STARTED transaction must be fully bound before it can complete: the
  -- identity it belongs to, the local session it steps up FROM, and the OIDC
  -- nonce the completion has to be handed back. A transaction that cannot
  -- name its nonce digest could only ever be completed by skipping the
  -- comparison, so the unbound state is made unrepresentable instead.
  ADD CONSTRAINT rat_started_is_bound CHECK (
    state <> 'started'
    OR (connection_id IS NOT NULL AND issuer IS NOT NULL
        AND provider_organization_id IS NOT NULL AND provider_subject IS NOT NULL
        AND session_id IS NOT NULL AND oidc_nonce_hash IS NOT NULL)
  );


-- ──────────────────────────────────────────────────────────────
-- Section 5 — support access authority and high-assurance approval
-- ──────────────────────────────────────────────────────────────

-- FBL-020-R3 correction F2 — THERE IS NO `approver_assurance` COLUMN, AND THAT
-- IS THE CORRECTION.
--
-- An earlier draft of this section added
--   approver_assurance TEXT NOT NULL DEFAULT 'fresh_and_mfa_policy'
--     CHECK (approver_assurance IN ('fresh_only', 'fresh_and_mfa_policy'))
-- and nothing ever read it. `decideSupportAccess` states the bar in code —
-- `requiredAssurance: 'fresh_and_mfa_policy'` — so an operator who set a row to
-- 'fresh_only' got no change, and a later edit to the DEFAULT would have
-- silently done nothing. Schema that looks authoritative and is not is a trap
-- for the next reader, which is why it is gone rather than wired up.
--
-- WHY NOT MAKE IT AUTHORITATIVE INSTEAD. Reading it would have created a
-- capability this system does not want: a PER-REQUEST downgrade of the approval
-- bar to `fresh_only`, on the one gate that lets a platform person into a
-- tenant's data. Nothing decides when a lower bar is appropriate, no writer sets
-- one, and no operator procedure asks for one — so honouring the column would
-- have added a weakening knob whose only current value is the strong one. The
-- approval bar is a platform-wide policy about a platform-wide risk, and it
-- belongs in code where it is reviewed, not in per-row data where it is not.
--
-- If a per-request bar is ever genuinely wanted, it arrives with the writer, the
-- authority to set it and the reader that honours it, in one change.
ALTER TABLE support_access_requests
  ADD COLUMN approval_grant_id UUID REFERENCES reauthentication_grants (grant_id);

-- Historical support evidence is PRESERVED; only LIVE approvals that cannot
-- name an approving grant are converted to an auditable terminal state, and
-- their sessions ended. No approval is invented and no row is deleted.
UPDATE support_access_sessions s
   SET revoked_at = COALESCE(s.revoked_at, NOW()),
       revoked_by_user_link_id = NULL
  FROM support_access_requests r
 WHERE r.request_id = s.request_id
   AND s.revoked_at IS NULL
   AND r.status = 'approved'
   AND r.approval_grant_id IS NULL;

-- Migration 055 ties decided_at to the approved/denied statuses, so the
-- terminal conversion cannot simply overwrite status and strand the original
-- decision. The prior decision is PRESERVED in dedicated columns (and in an
-- audit row below) before the live fields are cleared — history is retained,
-- authority is not.
ALTER TABLE support_access_requests
  ADD COLUMN superseded_decided_by_user_link_id UUID REFERENCES user_links (user_link_id),
  ADD COLUMN superseded_decided_at              TIMESTAMPTZ,
  ADD COLUMN superseded_reason                  TEXT
    CHECK (superseded_reason IS NULL OR length(superseded_reason) BETWEEN 1 AND 100);

INSERT INTO audit_events (tenant_id, event_type, entity_type, entity_id, actor_user_id, details)
SELECT tenant_id,
       'identity.support.approval_superseded',
       'support_access_request',
       request_id,
       decided_by_user_link_id,
       jsonb_build_object(
         'reason', 'fbl_020_r3_no_approving_grant',
         'previous_status', status,
         'previous_decided_at', decided_at
       )
  FROM support_access_requests
 WHERE status = 'approved' AND approval_grant_id IS NULL;

UPDATE support_access_requests
   SET superseded_decided_by_user_link_id = decided_by_user_link_id,
       superseded_decided_at = decided_at,
       superseded_reason = 'fbl_020_r3_no_approving_grant',
       status = 'expired',
       decided_by_user_link_id = NULL,
       decided_at = NULL,
       authorization_version = authorization_version + 1,
       updated_at = NOW()
 WHERE status = 'approved'
   AND approval_grant_id IS NULL;

-- Now the constraint can land: every remaining approved row names its grant.
ALTER TABLE support_access_requests
  ADD CONSTRAINT sar_approval_is_high_assurance CHECK (
    status <> 'approved' OR approval_grant_id IS NOT NULL
  );

-- ── R3 correction A2: ONE approval per grant, enforced by the DATABASE ────
--
-- A reauthentication grant is SINGLE-USE. The application spends it through
-- `consumeReauthenticationGrant`, whose atomic UPDATE is conditional on
-- `consumed_at IS NULL`; this index is the independent second line, so a future
-- code path that reintroduced its own grant predicate could not quietly let one
-- grant approve two support requests.
--
-- RECONCILIATION PRECEDES THE CONSTRAINT, as everywhere in this file. Nothing is
-- invented: where two rows name the SAME grant the earliest decision keeps it
-- and every later one is moved to the same auditable terminal state section 5
-- uses, with its prior decision preserved in the superseded_* columns. Live
-- sessions belonging to those superseded approvals are ended first.
--
-- Stated plainly: `approval_grant_id` is created earlier in THIS migration, so
-- every value is NULL and all three statements match ZERO rows on a database
-- that migrates in order. They are written anyway because the ORDERING is the
-- property under review — a unique index installed ahead of its reconciliation
-- would abort the whole migration on any database that had ever recorded two
-- approvals against one grant.
-- The set being reconciled is "a request that names a grant some EARLIER
-- decision already named", under one total order: decision instant, then
-- request id as the tie-break (an undecided row sorts last, at 'infinity', so
-- it can never displace a real decision). The same predicate is restated by
-- each of the three statements below rather than materialized, because the
-- first two do not touch support_access_requests and the third is the one that
-- resolves the duplication — so every statement computes the identical set.
UPDATE support_access_sessions s
   SET revoked_at = COALESCE(s.revoked_at, NOW()),
       revoked_by_user_link_id = NULL
  FROM support_access_requests r
 WHERE r.request_id = s.request_id
   AND s.revoked_at IS NULL
   AND r.approval_grant_id IS NOT NULL
   AND EXISTS (
     SELECT 1 FROM support_access_requests earlier
      WHERE earlier.approval_grant_id = r.approval_grant_id
        AND (COALESCE(earlier.decided_at, 'infinity'::timestamptz), earlier.request_id)
          < (COALESCE(r.decided_at, 'infinity'::timestamptz), r.request_id)
   );

INSERT INTO audit_events (tenant_id, event_type, entity_type, entity_id, actor_user_id, details)
SELECT r.tenant_id,
       'identity.support.approval_superseded',
       'support_access_request',
       r.request_id,
       r.decided_by_user_link_id,
       jsonb_build_object(
         'reason', 'fbl_020_r3_duplicate_approval_grant',
         'previous_status', r.status,
         'previous_decided_at', r.decided_at
       )
  FROM support_access_requests r
 WHERE r.approval_grant_id IS NOT NULL
   AND EXISTS (
     SELECT 1 FROM support_access_requests earlier
      WHERE earlier.approval_grant_id = r.approval_grant_id
        AND (COALESCE(earlier.decided_at, 'infinity'::timestamptz), earlier.request_id)
          < (COALESCE(r.decided_at, 'infinity'::timestamptz), r.request_id)
   );

UPDATE support_access_requests r
   SET superseded_decided_by_user_link_id = r.decided_by_user_link_id,
       superseded_decided_at = r.decided_at,
       superseded_reason = 'fbl_020_r3_duplicate_approval_grant',
       status = 'expired',
       decided_by_user_link_id = NULL,
       decided_at = NULL,
       approval_grant_id = NULL,
       authorization_version = r.authorization_version + 1,
       updated_at = NOW()
 WHERE r.approval_grant_id IS NOT NULL
   AND EXISTS (
     SELECT 1 FROM support_access_requests earlier
      WHERE earlier.approval_grant_id = r.approval_grant_id
        AND (COALESCE(earlier.decided_at, 'infinity'::timestamptz), earlier.request_id)
          < (COALESCE(r.decided_at, 'infinity'::timestamptz), r.request_id)
   );

-- A PARTIAL unique index: `approval_grant_id` is legitimately NULL on every
-- pending, denied, cancelled and expired request, and multiple NULLs must stay
-- permitted. The index constrains only the rows that actually name a grant.
CREATE UNIQUE INDEX uq_sar_approval_grant ON support_access_requests (approval_grant_id)
  WHERE approval_grant_id IS NOT NULL;

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
