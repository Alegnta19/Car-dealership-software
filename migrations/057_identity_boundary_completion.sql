-- ============================================================
-- 057_identity_boundary_completion.sql — ORIGINATED IN FBL-020-R2,
-- CORRECTED IN PLACE BY FBL-020-R3 AND FBL-020-R4.
--
-- Governing document: Master Blueprint v2.0 §14.3. That citation belongs to
-- this file's ORIGIN and is unchanged: v2.0 §14.3 is genuinely the FBL-020-R2
-- order. What follows it is the file's revision history.
--
-- WHY THIS FILE IS CORRECTED IN PLACE RATHER THAN SUPERSEDED BY AN `058`, AND
-- WHO SAYS SO. Editing an applied migration is only safe where no environment
-- has applied it. `scripts/migration-census.ts` enumerates every persistent
-- environment reachable from the implementer's machine and reports, with its
-- evidence and the limits of each probe, that none has applied any form of
-- `057`; the single environment that has is the disposable local cluster the
-- drills run against. THAT FINDING IS THE IMPLEMENTER'S REPORT, NOT AN
-- ACCEPTANCE BY THE ARCHITECT. An earlier revision of this header cited it as
-- "the architect's §0 census", which asserted a ratification that had not been
-- given; the review said so, and the claim is withdrawn here.
--
-- The consequence is stated rather than left to be discovered: THE CHECKSUM OF
-- THIS FILE HAS MOVED WITH EVERY REVISION. That is not a loose end —
-- `scripts/migrate.ts` REFUSES to migrate any database whose ledger records a
-- different digest for this file, so a stale environment fails loudly instead
-- of silently skipping the revision it has not got.
--
--   * R2 wrote sections 1–13: exact external-identity binding, provable
--     session provenance, the server-side login transaction, delegated
--     support access and the policy evidence ledger.
--   * R3 corrected sections in place, each marked `FBL-020-R3` where it sits —
--     recoverable refresh state and the refresh lease, provider-token expiry,
--     the credential a session belongs to, the explicit terminal state on a
--     login transaction, the local session a step-up starts from, and the
--     removal of the `approver_assurance` column that asserted a fact nothing
--     proved.
--   * R4 added the five sections marked `FBL-020-R4`: §2.1's identity tuple
--     foreign keys, §2.2's `auth_time` and assurance provenance, the nil-UUID
--     tenant refusal, the support-session tenant check and the grant-backed
--     approval check. Those five, plus the R3 corrections above, are why line
--     2 no longer names R2 alone.
--   * R5 added section 11, marked `FBL-020-R5 §2`: the policy evidence ledger
--     becomes RELATIONAL. R4's completeness rules were measured against the
--     shipped schema and found to admit eighteen of twenty fabricated or
--     cross-wired "complete" version-2 allows; section 11 refuses all of them,
--     and normalizes the matched-binding array so it can carry a foreign key
--     at all.
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
-- Section 6 — policy evidence: auth_time, the true actor, and an
-- EVIDENCE VERSION that makes an incomplete new decision unrepresentable
--
-- FBL-020-R4 §2.2 — WHAT WAS WRONG HERE. R3 added `auth_time`,
-- `connection_id`, `session_id` and `actor_provider_subject` as four
-- nullable columns with NO completeness rule and NO referential integrity.
-- Every one of them could therefore be NULL on an ALLOW, which is the only
-- direction that matters: a decision that let somebody into a tenant's data
-- was permitted to record nothing about the credential that was presented,
-- and nothing anywhere would notice. Evidence that MAY be absent is evidence
-- that will be absent on the day it is needed.
--
-- The mechanism is a VERSION DISCRIMINATOR plus constraints CONDITIONAL on
-- it, so history stays legal and the present cannot be written incomplete:
--
--   * every row that exists when this migration runs is version 1. Those
--     rows are append-only evidence of decisions that were genuinely made
--     with less recorded — rewriting or deleting them would be the real
--     falsification, so they stay exactly as they are and stay READABLE;
--   * the column DEFAULT then becomes 2, and version-2 rows must carry the
--     complete set below;
--   * and a BEFORE INSERT trigger refuses any NEW row below the current
--     version. Without it the version would be a self-certification: a
--     writer could keep claiming version 1 forever and inherit the historic
--     exemption. INSERT-only, so no existing row is touched.
-- ──────────────────────────────────────────────────────────────

ALTER TABLE policy_decisions
  ADD COLUMN auth_time            TIMESTAMPTZ,
  -- REFERENTIAL, not merely shaped: an evidence row that names a connection
  -- or a session names one that EXISTS. A digit-string that resolves to
  -- nothing is not evidence of a credential, and an operator who cannot
  -- follow the id to the object cannot revoke it.
  ADD COLUMN connection_id        UUID REFERENCES identity_provider_connections (connection_id),
  ADD COLUMN session_id           UUID REFERENCES identity_sessions (session_id),
  ADD COLUMN actor_provider_subject TEXT,
  -- The applicable support session's EXPIRY, recorded on the decision that
  -- relied on it. Without it a stored support allow could not be re-judged
  -- later against the window it was supposed to fall inside.
  ADD COLUMN support_session_expires_at TIMESTAMPTZ,
  ADD COLUMN evidence_version     SMALLINT NOT NULL DEFAULT 1;

-- RECONCILIATION BEFORE CONSTRAINTS, as everywhere in this file. Existing
-- rows are declared version 1 — the version whose requirements they actually
-- met. Stated plainly: the column is created with DEFAULT 1 in the statement
-- above, so this matches ZERO rows on a database that migrates in order. It
-- is written anyway because the ORDERING is the property under review, and
-- because a later edit to the default must not silently promote historic rows
-- into a completeness class they were never written to satisfy.
UPDATE policy_decisions
   SET evidence_version = 1
 WHERE evidence_version IS DISTINCT FROM 1;

-- From here on, a decision is written at version 2 unless a writer names a
-- version explicitly — and the trigger below refuses anything lower.
ALTER TABLE policy_decisions ALTER COLUMN evidence_version SET DEFAULT 2;

ALTER TABLE policy_decisions
  ADD CONSTRAINT pd_actor_subject_shape CHECK (
    actor_provider_subject IS NULL OR length(actor_provider_subject) BETWEEN 1 AND 200
  ),
  ADD CONSTRAINT pd_evidence_version_known CHECK (evidence_version IN (1, 2)),
  -- THE PRESENTED CREDENTIAL IS ONE FACT, NOT FOUR. Either the decision names
  -- the session it was made for AND everything derived from that session, or
  -- it names none of them. A half-populated group is how "we recorded the
  -- session id" quietly coexists with "we never recorded which connection or
  -- subject it belonged to".
  ADD CONSTRAINT pd_credential_group_is_atomic CHECK (
    evidence_version < 2
    OR (session_id IS NOT NULL)
       = (auth_time IS NOT NULL AND connection_id IS NOT NULL
          AND actor_provider_subject IS NOT NULL)
  ),
  -- The identified-actor completeness rule. `system` decisions are excluded
  -- BY NAME rather than by omission: a scheduler or a migration acts with no
  -- actor, no tenant and no credential, and forcing it to invent them would
  -- put fiction in the audit trail.
  --
  -- On the tenant clause: a `platform.*` action targets the control plane and
  -- has no tenant to name, and a DENY may be the very decision that no target
  -- tenant could be resolved — for those two cases the ABSENCE is the recorded
  -- fact. Every other row, and every ALLOW into tenant data, must name its
  -- target tenant.
  ADD CONSTRAINT pd_v2_identified_actor_is_complete CHECK (
    evidence_version < 2
    OR actor_type = 'system'
    OR (
      actor_user_link_id IS NOT NULL
      AND request_id IS NOT NULL
      AND correlation_id IS NOT NULL
      AND (resource_type IS NULL) = (resource_id IS NULL)
      AND (tenant_id IS NOT NULL OR decision = 'deny' OR action ~ '^platform\.')
    )
  ),
  -- AN ALLOW MUST NAME THE CREDENTIAL IT BELIEVED. This is the clause the
  -- whole section exists for: a decision that granted access to an identified
  -- actor cannot be recorded without the presented session, its authentication
  -- instant, its connection and its provider subject. A deny is allowed to
  -- record "nothing was presented", because that is frequently the reason.
  ADD CONSTRAINT pd_v2_allow_names_presented_credential CHECK (
    evidence_version < 2
    OR actor_type = 'system'
    OR decision = 'deny'
    OR session_id IS NOT NULL
  ),
  -- …and it must name the AUTHORITY it relied on: matched role bindings, or a
  -- support session. An allow that can name neither is unreconstructable.
  ADD CONSTRAINT pd_v2_allow_names_its_authority CHECK (
    evidence_version < 2
    OR actor_type = 'system'
    OR decision = 'deny'
    OR scope_level IS NOT NULL
  ),
  ADD CONSTRAINT pd_v2_allow_has_authority_evidence CHECK (
    evidence_version < 2
    OR actor_type = 'system'
    OR decision = 'deny'
    OR cardinality(matched_role_binding_ids) > 0
    OR support_session_id IS NOT NULL
  ),
  -- SUPPORT ACCESS EVIDENCE IS ALL THREE FACTS OR NONE. A decision taken
  -- under delegated support access must name the session, the approved
  -- request it derives from and the window it fell inside; and only a
  -- platform-support actor can be inside one.
  ADD CONSTRAINT pd_support_evidence_is_complete CHECK (
    support_session_id IS NULL
    OR (
      support_request_id IS NOT NULL
      AND actor_type = 'platform_support'
      AND (evidence_version < 2 OR support_session_expires_at IS NOT NULL)
    )
  ),
  ADD CONSTRAINT pd_support_expiry_needs_a_session CHECK (
    support_session_expires_at IS NULL OR support_session_id IS NOT NULL
  );

-- The version floor. A CHECK cannot express "new rows only", so the floor is
-- a BEFORE INSERT trigger: historic rows are untouched and remain readable,
-- and no future writer can opt back into the weaker class.
CREATE OR REPLACE FUNCTION policy_decisions_require_current_evidence() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.evidence_version < 2 THEN
    RAISE EXCEPTION
      'policy_decisions INSERT refused: evidence_version % is below the current minimum 2 '
      '(historic rows keep their version; new decisions must carry complete evidence)',
      NEW.evidence_version;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_policy_decisions_current_evidence ON policy_decisions;
CREATE TRIGGER trg_policy_decisions_current_evidence
  BEFORE INSERT ON policy_decisions
  FOR EACH ROW EXECUTE FUNCTION policy_decisions_require_current_evidence();

-- ──────────────────────────────────────────────────────────────
-- Section 7 — THE IDENTITY TUPLE, ENFORCED BY THE DATABASE
--
-- FBL-020-R4 §2.1. Up to here every one of these relationships was checked
-- by application SQL: `createBearerSession` re-verifies the seven facts in
-- its INSERT ... WHERE EXISTS, `startReauthentication` derives its binding
-- from the session, and the migration above reconciles what it can. All of
-- that is correct and none of it is a GUARANTEE — a new code path, a fixture,
-- a repair script or a psql session can still write a row whose tenant,
-- connection, issuer, organization, subject and UserLink do not belong
-- together, and every reader downstream would then trust it.
--
-- This section moves the relationship into the schema, as composite foreign
-- keys, so a partial or cross-tenant identity tuple is REFUSED BY POSTGRES.
--
-- THE `tenant_key` PROBLEM, AND WHY IT IS SOLVED THIS WAY. A composite
-- foreign key uses MATCH SIMPLE: if ANY referencing column is NULL the
-- constraint is satisfied without a lookup. `tenant_id` is legitimately NULL
-- for PLATFORM-scope connections, links and sessions, so a foreign key
-- carrying `tenant_id` would be silently unenforced on exactly the rows that
-- reach across the platform/dealership boundary — a platform-scope link could
-- name a dealership connection and nothing would object. Each table therefore
-- carries a GENERATED, always-present `tenant_key`: the tenant id, or the nil
-- UUID for platform scope. It is derived by the database from `tenant_id` in
-- the same row, so it cannot drift, cannot be written by application code and
-- cannot be forgotten.
--
-- The nil UUID is not a tenant, and the CHECK below makes that permanent
-- rather than a convention.
-- ──────────────────────────────────────────────────────────────

DO $$
DECLARE nil_tenants INTEGER;
BEGIN
  SELECT COUNT(*) INTO nil_tenants
    FROM tenants WHERE tenant_id = '00000000-0000-0000-0000-000000000000';
  IF nil_tenants > 0 THEN
    RAISE EXCEPTION
      'FBL-020-R4 refused: the nil UUID is used as a tenant id, so it cannot also stand '
      'for "platform scope" in the identity tuple keys';
  END IF;
END $$;

ALTER TABLE tenants
  ADD CONSTRAINT tenants_id_is_not_the_platform_key CHECK (
    tenant_id <> '00000000-0000-0000-0000-000000000000'
  );

ALTER TABLE identity_provider_connections
  ADD COLUMN tenant_key UUID GENERATED ALWAYS AS (
    COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid)
  ) STORED;
ALTER TABLE user_links
  ADD COLUMN tenant_key UUID GENERATED ALWAYS AS (
    COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid)
  ) STORED;
ALTER TABLE identity_sessions
  ADD COLUMN tenant_key UUID GENERATED ALWAYS AS (
    COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid)
  ) STORED;

-- FK targets. These are plain unique indexes over columns that are already
-- unique by construction (each begins with the table's primary key), so they
-- constrain nothing new — they exist to give the composite foreign keys below
-- something to point at.
CREATE UNIQUE INDEX uq_ipc_identity_tuple
  ON identity_provider_connections
     (connection_id, tenant_key, provider, provider_organization_id, issuer);
CREATE UNIQUE INDEX uq_ul_identity_tuple
  ON user_links
     (user_link_id, tenant_key, connection_id, provider_organization_id, issuer, provider_user_id);
CREATE UNIQUE INDEX uq_is_identity_tuple
  ON identity_sessions
     (session_id, tenant_key, user_link_id, connection_id, provider_organization_id, issuer,
      provider_subject);
CREATE UNIQUE INDEX uq_rat_identity_tuple
  ON reauthentication_transactions
     (reauth_txn_id, tenant_id, user_link_id, action, connection_id);

-- ── 7a. ACTIVATED UserLinks ───────────────────────────────────────────────
--
-- RECONCILIATION FIRST. A link whose five-column binding does not resolve to
-- a real connection is closed the same way section 1 closes an ambiguous one:
-- deactivated, and its binding cleared so the constraint below skips it
-- rather than being satisfied by a fiction.
--
-- Stated plainly: section 1 SET this binding from the connection row it read,
-- so on a database that migrates in order this matches ZERO rows. It is
-- written anyway because the ORDERING is the property under review — the
-- foreign key installed ahead of it would abort the whole migration on any
-- database holding a link whose connection had been re-pointed.
UPDATE user_links ul
   SET status = 'deactivated',
       deactivated_at = COALESCE(ul.deactivated_at, NOW()),
       connection_id = NULL,
       provider_organization_id = NULL,
       issuer = NULL,
       authorization_version = ul.authorization_version + 1,
       updated_at = NOW()
 WHERE ul.connection_id IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM identity_provider_connections c
      WHERE c.connection_id = ul.connection_id
        AND c.tenant_key = ul.tenant_key
        AND c.provider = ul.provider
        AND c.provider_organization_id = ul.provider_organization_id
        AND c.issuer = ul.issuer
   );

-- A link's external identity is now ONE composite fact. Because
-- `ul_activated_is_bound` (section 1) already forbids an activated link with
-- any of these NULL, MATCH SIMPLE bites on every activated link: the tuple
-- must resolve to a real connection in the SAME tenant, of the same provider,
-- with the same configured issuer and the same provider organization. A
-- PENDING link that is not bound yet keeps NULLs and is not yet constrained,
-- which is the only state that legitimately has nothing to check.
ALTER TABLE user_links
  ADD CONSTRAINT ul_connection_identity_tuple
    FOREIGN KEY (connection_id, tenant_key, provider, provider_organization_id, issuer)
    REFERENCES identity_provider_connections
      (connection_id, tenant_key, provider, provider_organization_id, issuer);

-- ── 7b. LIVE identity_sessions ────────────────────────────────────────────
--
-- RECONCILIATION FIRST, in two statements that between them leave nothing the
-- foreign key can abort on:
--   * a session that is not revoked and whose tuple does not resolve to its
--     own UserLink is REVOKED, exactly as section 2 revokes an unprovable one;
--   * a session that is ALREADY revoked and still carries a tuple that does
--     not resolve keeps its audit trail and loses the two values THIS
--     MIGRATION wrote (subject and organization, created in section 2). That
--     is not erasing history: those columns did not exist before this file
--     ran, so the only writer that could have filled them is section 2's own
--     derivation.
--
-- Stated plainly: both match ZERO rows on a database that migrates in order,
-- because section 2 derived the tuple from the link's own connection or
-- revoked the session with the columns left NULL.
UPDATE identity_sessions s
   SET revoked_at = NOW(),
       revoked_reason = COALESCE(s.revoked_reason, 'fbl_020_r4_tuple_unprovable')
 WHERE s.revoked_at IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM user_links ul
      WHERE ul.user_link_id = s.user_link_id
        AND ul.tenant_key = s.tenant_key
        AND ul.connection_id = s.connection_id
        AND ul.provider_organization_id = s.provider_organization_id
        AND ul.issuer = s.issuer
        AND ul.provider_user_id = s.provider_subject
   );

UPDATE identity_sessions s
   SET provider_subject = NULL,
       provider_organization_id = NULL
 WHERE s.revoked_at IS NOT NULL
   AND s.provider_subject IS NOT NULL
   AND s.provider_organization_id IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM user_links ul
      WHERE ul.user_link_id = s.user_link_id
        AND ul.tenant_key = s.tenant_key
        AND ul.connection_id = s.connection_id
        AND ul.provider_organization_id = s.provider_organization_id
        AND ul.issuer = s.issuer
        AND ul.provider_user_id = s.provider_subject
   );

-- `is_live_session_fully_bound` (section 2) forbids a live session with any of
-- connection, issuer, organization or subject NULL, so for every live session
-- this foreign key is fully enforced: the session's tenant, connection,
-- issuer, organization and provider subject must all belong to the very
-- UserLink it was issued to. A session cannot be issued to a link in another
-- tenant, cannot claim a subject its link does not have, and cannot name a
-- connection its link is not bound to.
ALTER TABLE identity_sessions
  ADD CONSTRAINT is_link_identity_tuple
    FOREIGN KEY (user_link_id, tenant_key, connection_id, provider_organization_id, issuer,
                 provider_subject)
    REFERENCES user_links
      (user_link_id, tenant_key, connection_id, provider_organization_id, issuer,
       provider_user_id);

-- ── 7c. ACTIVE reauthentication rows ──────────────────────────────────────
--
-- RECONCILIATION FIRST. A step-up that is still 'started' and whose tuple
-- does not resolve to its session is EXPIRED — the same closed state section 4
-- uses — and its binding cleared so nothing partial is left to check.
--
-- Stated plainly: the binding columns are created in section 4 of this file
-- and set only by `startReauthentication`, which DERIVES them from the
-- session, so this matches ZERO rows on a database that migrates in order.
UPDATE reauthentication_transactions r
   SET state = 'expired',
       connection_id = NULL,
       issuer = NULL,
       provider_organization_id = NULL,
       provider_subject = NULL,
       session_id = NULL,
       updated_at = NOW()
 WHERE r.state = 'started'
   AND NOT EXISTS (
     SELECT 1 FROM identity_sessions s
      WHERE s.session_id = r.session_id
        AND s.tenant_key = r.tenant_id
        AND s.user_link_id = r.user_link_id
        AND s.connection_id = r.connection_id
        AND s.provider_organization_id = r.provider_organization_id
        AND s.issuer = r.issuer
        AND s.provider_subject = r.provider_subject
   );

-- A step-up names the exact live session it steps up FROM, and inherits that
-- session's whole identity tuple. `rat_started_is_bound` (section 4) forbids a
-- 'started' transaction with any of these NULL, so every active step-up is
-- fully enforced; a terminal one (completed, failed, expired) that predates
-- these columns keeps its NULLs and its history.
ALTER TABLE reauthentication_transactions
  ADD CONSTRAINT rat_session_identity_tuple
    FOREIGN KEY (session_id, tenant_id, user_link_id, connection_id,
                 provider_organization_id, issuer, provider_subject)
    REFERENCES identity_sessions
      (session_id, tenant_key, user_link_id, connection_id,
       provider_organization_id, issuer, provider_subject);

-- The GRANT the step-up mints inherits the transaction's identity: same
-- transaction, same tenant, same person, same action. Before this, a grant was
-- tied to its transaction by `reauth_txn_id` alone, so a writer could mint one
-- naming a different tenant, a different user or a different action than the
-- transaction that authorized it — and `consumeReauthenticationGrant` matches
-- on the GRANT's copies of those values, so the substitution would have been
-- honoured.
--
-- RECONCILIATION FIRST for the connection: a grant's connection is its
-- transaction's connection, by definition, so it is DERIVED here rather than
-- trusted. A legacy transaction that predates section 4's `connection_id`
-- carries NULL, and its grant honestly becomes NULL too — such a transaction
-- is terminal and can never be started again, so no future grant can inherit
-- the gap. Stated plainly: `completeReauthentication` already writes the
-- transaction's own connection, so this matches ZERO rows in order.
UPDATE reauthentication_grants g
   SET connection_id = t.connection_id,
       updated_at = NOW()
  FROM reauthentication_transactions t
 WHERE t.reauth_txn_id = g.reauth_txn_id
   AND g.connection_id IS DISTINCT FROM t.connection_id;

ALTER TABLE reauthentication_grants
  ADD CONSTRAINT rag_transaction_identity_tuple
    FOREIGN KEY (reauth_txn_id, tenant_id, user_link_id, action, connection_id)
    REFERENCES reauthentication_transactions
      (reauth_txn_id, tenant_id, user_link_id, action, connection_id);

-- ── 7d. support access cannot cross a tenant ──────────────────────────────
--
-- A support SESSION belongs to its request's tenant, and an APPROVING GRANT
-- belongs to the approver, in that same tenant. Neither was enforced: the
-- session carried its own `tenant_id` column and the grant was referenced by
-- id alone, so a grant minted in tenant B could approve access into tenant A.
--
-- A mismatch here would mean the retained rows are already inconsistent, and
-- there is no honest repair — inventing which tenant was meant is exactly the
-- guess this file refuses to make. It fails LOUDLY instead, the way migration
-- 055's location backfill does. Zero rows on a database that migrates in order.
DO $$
DECLARE bad INTEGER;
BEGIN
  SELECT COUNT(*) INTO bad
    FROM support_access_sessions s
    JOIN support_access_requests r ON r.request_id = s.request_id
   WHERE r.tenant_id <> s.tenant_id;
  IF bad > 0 THEN
    RAISE EXCEPTION 'FBL-020-R4 refused: % support session(s) name a different tenant than '
                    'the request they were granted under', bad;
  END IF;

  SELECT COUNT(*) INTO bad
    FROM support_access_requests r
    JOIN reauthentication_grants g ON g.grant_id = r.approval_grant_id
   WHERE g.tenant_id <> r.tenant_id
      OR (r.decided_by_user_link_id IS NOT NULL AND g.user_link_id <> r.decided_by_user_link_id);
  IF bad > 0 THEN
    RAISE EXCEPTION 'FBL-020-R4 refused: % approved support request(s) are backed by a grant '
                    'from another tenant or another person', bad;
  END IF;
END $$;

CREATE UNIQUE INDEX uq_sar_tenant_scoped ON support_access_requests (request_id, tenant_id);
CREATE UNIQUE INDEX uq_rag_tenant_scoped ON reauthentication_grants (grant_id, tenant_id);
CREATE UNIQUE INDEX uq_rag_actor_scoped ON reauthentication_grants (grant_id, user_link_id);

ALTER TABLE support_access_sessions
  ADD CONSTRAINT sas_request_same_tenant
    FOREIGN KEY (request_id, tenant_id) REFERENCES support_access_requests (request_id, tenant_id);

ALTER TABLE support_access_requests
  ADD CONSTRAINT sar_approval_grant_same_tenant
    FOREIGN KEY (approval_grant_id, tenant_id)
    REFERENCES reauthentication_grants (grant_id, tenant_id),
  -- …and the grant that approved it belongs to the person who approved it.
  -- Enforced whenever both are named; `sar_approval_is_high_assurance` above
  -- already forbids an approved row with no grant.
  ADD CONSTRAINT sar_approval_grant_is_the_decider
    FOREIGN KEY (approval_grant_id, decided_by_user_link_id)
    REFERENCES reauthentication_grants (grant_id, user_link_id);

-- ──────────────────────────────────────────────────────────────
-- Section 8 — MFA-POLICY CERTIFICATION GETS A VALIDITY AND A REVOCATION
--
-- Migration 056 recorded the organization's MFA policy as a bare boolean plus
-- the instant and the person that set it. Nothing bounded it. A certification
-- made once was therefore true for ever, and the only way to withdraw it was to
-- flip the same boolean back — so "this organization still requires MFA", an
-- external fact that goes stale without announcing itself, was the permanent
-- foundation of every high-assurance step-up in the system.
--
-- Two facts are added, and both make the CLOSED answer reachable:
--   * a VALIDITY DEADLINE, after which the certification counts for nothing
--     until an authorized administrator re-confirms it;
--   * an explicit REVOCATION, attributable to the person who withdrew it, so a
--     withdrawal is a recorded act rather than the absence of one.
--
-- Missing, false, revoked and expired become ONE answer: not certified. The
-- application-side predicate lives in ONE place
-- (`EFFECTIVE_MFA_CERTIFICATION_SQL`) and is interpolated by every reader.
-- ──────────────────────────────────────────────────────────────

ALTER TABLE identity_provider_connections
  ADD COLUMN mfa_policy_certification_expires_at TIMESTAMPTZ,
  ADD COLUMN mfa_policy_certification_revoked_at TIMESTAMPTZ,
  ADD COLUMN mfa_policy_certification_revoked_by_user_link_id
    UUID REFERENCES user_links (user_link_id);

-- RECONCILIATION FIRST, and it FAILS CLOSED. A certification carrying no
-- deadline was never a bounded certification, and inventing a deadline for it
-- would be fabricating the very fact under review — so it is WITHDRAWN. The
-- authorization version advances because what the connection authorizes has
-- just changed, which is precisely what a version exists to announce.
--
-- Stated plainly: on a database that migrates in order this matches ZERO rows,
-- because the column is created three statements above. It is written anyway,
-- ahead of the CHECKs that depend on it, because the ORDERING is the property
-- under review.
UPDATE identity_provider_connections
   SET mfa_policy_certified = FALSE,
       mfa_policy_certified_at = NULL,
       mfa_policy_certified_by_user_link_id = NULL,
       authorization_version = authorization_version + 1,
       updated_at = NOW()
 WHERE mfa_policy_certified = TRUE
   AND mfa_policy_certification_expires_at IS NULL;

-- Now, and only now, the invariants.
ALTER TABLE identity_provider_connections
  -- A certification that cannot say WHEN it stops counting is unrepresentable.
  ADD CONSTRAINT ipc_mfa_certification_is_bounded CHECK (
    mfa_policy_certified = FALSE
    OR (mfa_policy_certified_at IS NOT NULL
        AND mfa_policy_certification_expires_at IS NOT NULL
        AND mfa_policy_certification_expires_at > mfa_policy_certified_at)
  ),
  -- A withdrawal nobody performed is not a withdrawal.
  ADD CONSTRAINT ipc_mfa_revocation_is_attributable CHECK (
    (mfa_policy_certification_revoked_at IS NULL)
    = (mfa_policy_certification_revoked_by_user_link_id IS NULL)
  ),
  -- …and a revoked certification can never simultaneously be in force.
  ADD CONSTRAINT ipc_mfa_revoked_is_not_certified CHECK (
    mfa_policy_certification_revoked_at IS NULL OR mfa_policy_certified = FALSE
  );

-- ──────────────────────────────────────────────────────────────
-- Section 9 — THE REAUTHENTICATION ROW BECOMES THE AUTHORITY ON ITS CALLBACK
--
-- R3 generated the reauthentication leg's `state` and PKCE verifier inside the
-- HTTP route and put them in a sealed cookie. The server stored NEITHER. So the
-- only record of what the callback was supposed to present was the copy held by
-- the browser: the round-trip state was CLIENT-AUTHORITATIVE, the seal was the
-- whole of the defence, and a client that kept a copy could present the same
-- state again because no server row said "this one is spent". The login leg had
-- been corrected in R2 for exactly this; the step-up leg had not.
--
-- Everything the callback must satisfy now lives on this row:
--   * `state_hash` / `code_verifier_hash` — the round-trip digests, UNIQUE on
--     state so the claim is structurally single-use;
--   * `callback_uri` — the exact redirect this leg was issued for, so a leg
--     issued for one callback cannot be completed at another;
--   * `request_id` / `correlation_id` — the same generated pair the logs carry,
--     screened before arrival (the CHECKs are the second line, not the first);
--   * `claimed_at` — the instant the round trip was spent, exactly once;
--   * `terminal_reason` / `terminal_at` — WHY the transaction ended and WHEN.
--     R3 could reach 'failed' with no reason and no instant, and several
--     provider-side failures reached no terminal state at all, so a row left at
--     'started' was indistinguishable from one still legitimately in flight.
-- ──────────────────────────────────────────────────────────────

ALTER TABLE reauthentication_transactions
  ADD COLUMN state_hash          TEXT,
  ADD COLUMN code_verifier_hash  TEXT,
  ADD COLUMN callback_uri        TEXT,
  ADD COLUMN request_id          TEXT,
  ADD COLUMN correlation_id      TEXT,
  ADD COLUMN claimed_at          TIMESTAMPTZ,
  ADD COLUMN terminal_reason     TEXT,
  ADD COLUMN terminal_at         TIMESTAMPTZ;

-- RECONCILIATION FIRST, in five statements.
--
-- A transaction still 'started' that cannot name the callback state its
-- completion has to compare against could only ever be completed by SKIPPING
-- the comparison. It is expired instead — the same closed treatment section 4
-- gives a transaction that cannot name its nonce digest.
UPDATE reauthentication_transactions
   SET state = 'expired',
       terminal_reason = 'fbl_020_r4_callback_state_unbound',
       terminal_at = NOW(),
       updated_at = NOW()
 WHERE state = 'started'
   AND (state_hash IS NULL OR code_verifier_hash IS NULL OR callback_uri IS NULL);

-- Rows that were ALREADY terminal keep their history and gain the two facts
-- this migration introduces. The instant is DERIVED, never invented: a
-- completed transaction has `completed_at`, and anything else can only honestly
-- claim the last time the row was touched.
UPDATE reauthentication_transactions
   SET terminal_at = COALESCE(terminal_at, completed_at, updated_at, started_at),
       terminal_reason = COALESCE(
         terminal_reason,
         CASE state
           WHEN 'completed' THEN 'granted'
           WHEN 'expired'   THEN 'expired'
           ELSE 'fbl_020_r4_unclassified'
         END
       ),
       updated_at = NOW()
 WHERE state IN ('completed', 'failed', 'expired');

-- …and a NON-terminal row carrying either fact is a contradiction, so it loses
-- them rather than being admitted by a constraint that reads only one direction.
UPDATE reauthentication_transactions
   SET terminal_reason = NULL, terminal_at = NULL
 WHERE state = 'started' AND (terminal_reason IS NOT NULL OR terminal_at IS NOT NULL);

-- Correlation values that do not satisfy the shape are DROPPED, never truncated
-- into something that looks like a different request.
UPDATE reauthentication_transactions
   SET request_id = NULL
 WHERE request_id IS NOT NULL AND request_id !~ '^[A-Za-z0-9._-]{8,128}$';

UPDATE reauthentication_transactions
   SET correlation_id = NULL
 WHERE correlation_id IS NOT NULL AND correlation_id !~ '^[A-Za-z0-9._-]{8,128}$';

-- Constraints follow reconciliation, never precede it.
ALTER TABLE reauthentication_transactions
  ADD CONSTRAINT rat_state_hash_shape CHECK (
    state_hash IS NULL OR state_hash ~ '^[0-9a-f]{64}$'
  ),
  ADD CONSTRAINT rat_code_verifier_hash_shape CHECK (
    code_verifier_hash IS NULL OR code_verifier_hash ~ '^[0-9a-f]{64}$'
  ),
  ADD CONSTRAINT rat_callback_uri_shape CHECK (
    callback_uri IS NULL OR length(callback_uri) BETWEEN 1 AND 2000
  ),
  ADD CONSTRAINT rat_request_id_shape CHECK (
    request_id IS NULL OR request_id ~ '^[A-Za-z0-9._-]{8,128}$'
  ),
  ADD CONSTRAINT rat_correlation_id_shape CHECK (
    correlation_id IS NULL OR correlation_id ~ '^[A-Za-z0-9._-]{8,128}$'
  ),
  ADD CONSTRAINT rat_terminal_reason_shape CHECK (
    terminal_reason IS NULL OR length(terminal_reason) BETWEEN 1 AND 100
  ),
  -- A STARTED transaction must be able to judge its own callback before it can
  -- complete. The unbound state is made unrepresentable rather than tolerated.
  ADD CONSTRAINT rat_started_is_callback_bound CHECK (
    state <> 'started'
    OR (state_hash IS NOT NULL AND code_verifier_hash IS NOT NULL AND callback_uri IS NOT NULL)
  ),
  -- EVERY terminal state says why and when; no non-terminal state pretends to.
  -- This is what makes "stuck at started" a DETECTABLE condition rather than an
  -- ambiguity: a row with no terminal facts is, by construction, still in flight.
  ADD CONSTRAINT rat_terminal_is_explained CHECK (
    (state IN ('completed', 'failed', 'expired'))
    = (terminal_at IS NOT NULL AND terminal_reason IS NOT NULL)
  ),
  ADD CONSTRAINT rat_terminal_follows_claim CHECK (
    claimed_at IS NULL OR terminal_at IS NULL OR terminal_at >= claimed_at
  );

-- The round trip is SINGLE-USE by construction: one row may own a given state.
CREATE UNIQUE INDEX uq_rat_state_hash ON reauthentication_transactions (state_hash);

-- ──────────────────────────────────────────────────────────────
-- Section 10 — A SUPPORT WINDOW CLOSING IS A RECORDED TRANSITION
--
-- R3 expressed a support session's end in exactly one way that anybody ever
-- observed: `revoked_at`, set by a person. Expiry was expressed only as
-- `expires_at` being in the past, and NOTHING watched it go by. Access does stop
-- on time — every reader filters `expires_at > NOW()` — but no row changes, no
-- authorization version advances, and no audit event is written, so the trail an
-- operator reads for "what happened to this platform person's access" shows a
-- session granted and then silence. "Its hour ran out" and "it is still open"
-- are the same evidence, which is precisely the shape of gap this revision keeps
-- closing elsewhere.
--
-- `expired_at` is that transition, and the three constraints below are what make
-- it a transition rather than a hopeful timestamp:
--
--   * IT CANNOT BE RECORDED EARLY. `expired_at >= expires_at` means the row can
--     only say "this window closed" once the window has actually closed. A
--     processor bug, a clock-skewed host or a hand-written UPDATE cannot retire a
--     live session by claiming it expired — that act is revocation, it has its
--     own columns, and it names the person who did it.
--   * A SESSION ENDS ONCE, ONE WAY. `revoked_at` and `expired_at` are mutually
--     exclusive: a revoked session's end is attributed to the revoker for ever,
--     and an expired one's to the clock. Allowing both would make the audit
--     trail's answer to "who ended this" depend on which write landed last.
--   * IT IS ONLY EVER SET, NEVER MOVED. Ordinary readers do not consult
--     `expired_at` at all: it is redundant with `expires_at <= NOW()` BY
--     CONSTRUCTION (the first constraint), so this column adds evidence and
--     changes no authorization answer. That is deliberate — an expiry processor
--     that fell behind must never widen access, and one that ran twice must never
--     narrow it.
--
-- Together with the partial index, "the sessions whose expiry has not been
-- recorded yet" is a cheap, exact, self-draining set: the claim is
-- `expired_at IS NULL`, so a transition is idempotent under repetition and under
-- concurrency without a queue, a lease table or an outbox.
--
-- NO RECONCILIATION IS NEEDED OR PERFORMED, and that is a statement about the
-- data rather than an omission: the column arrives NULL on every existing row,
-- NULL satisfies all three constraints, and the processor picks up any already
-- lapsed session on its next pass and records the transition then. Nothing is
-- back-dated, because an instant nobody observed cannot be invented.
-- ──────────────────────────────────────────────────────────────

ALTER TABLE support_access_sessions
  ADD COLUMN expired_at TIMESTAMPTZ;

ALTER TABLE support_access_sessions
  ADD CONSTRAINT sas_expiry_is_not_early CHECK (
    expired_at IS NULL OR expired_at >= expires_at
  ),
  ADD CONSTRAINT sas_ends_once_and_one_way CHECK (
    revoked_at IS NULL OR expired_at IS NULL
  );

-- The processor's claim set, and nothing else: due, unrevoked, unrecorded.
CREATE INDEX idx_sas_expiry_due ON support_access_sessions (expires_at)
  WHERE revoked_at IS NULL AND expired_at IS NULL;

-- ──────────────────────────────────────────────────────────────
-- Section 11 — POLICY EVIDENCE BECOMES RELATIONAL
--   FBL-020-R5 §2.1, §2.2, §2.3
--
-- WHAT WAS STILL WRONG AFTER SECTION 6. Section 6 made a version-2 decision
-- COMPLETE — every required column non-null — and stopped there. Completeness
-- is a statement about NULLs, and R5 §2.1 says in terms that it is not enough:
-- "Version-2 PolicyDecision evidence must be relationally coherent, not merely
-- non-null."
--
-- Measured against the shipped schema rather than argued about, twenty direct
-- SQL inserts of a "complete" version-2 ALLOW were attempted before this
-- section was written. EIGHTEEN WERE ACCEPTED. Only two were refused, both by
-- the single-column foreign keys section 6 added on `connection_id` and
-- `session_id`. PostgreSQL accepted, among others:
--
--   * a decision naming a tenant that does not exist, and an actor that does
--     not exist;
--   * an ALLOW into tenant A attributed to a real actor belonging to tenant B;
--   * a real session belonging to actor A recorded beside a real connection
--     belonging to tenant B, or beside a different real actor's provider
--     subject — every id resolving, no two of them describing one credential;
--   * matched role-binding authority that is a random UUID, or a real binding
--     belonging to somebody else in another tenant, at any version number;
--   * a support ALLOW naming a real support session together with a different
--     real request, another tenant's session, or a window the session never
--     had.
--
-- A PLAIN FOREIGN KEY IS WHY. It answers "does this id resolve", which is the
-- easy half. The half that matters is "do these ids resolve TOGETHER" — the
-- cross-wired case, where every column passes on its own and the row as a
-- whole describes a credential that never existed. That is precisely the shape
-- section 7 closed for `user_links`, `identity_sessions` and the step-up
-- tables with COMPOSITE foreign keys, and it is closed here the same way, for
-- the same reason: an operator reading this ledger after an incident must be
-- able to follow it back to real objects, and a ledger that can be written
-- self-consistently out of fabricated parts is not evidence.
--
-- THE ARRAY (R5 §2.3). `matched_role_binding_ids UUID[]` cannot carry a
-- foreign key at all — PostgreSQL has no element-wise referential integrity —
-- so no constraint on `policy_decisions` can make its contents mean anything.
-- The array is therefore NORMALIZED: a child row per matched binding, written
-- by the database itself from the array in the same statement, carrying the
-- foreign keys and the version rule the array could not. The array column
-- stays, unchanged, as the read surface every existing reader already uses;
-- it is no longer the only record of what it claims, and the two cannot drift
-- because `policy_decisions` is append-only and the child rows have exactly
-- one writer, which is this trigger.
--
-- WHAT IS DELIBERATELY NOT CONSTRAINED, stated so its absence is a decision
-- rather than an oversight:
--
--   * `scope_id` is polymorphic — it names a tenant, dealer group, legal
--     entity, rooftop or department depending on `scope_level` — so no single
--     foreign key can address it. It is left as recorded, and this file does
--     not pretend otherwise.
--   * A DENY may name an actor from a different tenant, and that is the whole
--     content of a `CROSS_TENANT` denial: the person really was outside. The
--     cross-tenant rule therefore binds ALLOWs, which are the rows that
--     granted something. `tests/fixtures/legacy-identity-seed-pre-057.sql`
--     carries exactly such a deny (D2, actor `10000003…` in tenant `bbbb0002…`
--     recorded against tenant `aaaa0001…`), and it must survive this upgrade
--     unchanged — a constraint that made a truthful denial unrepresentable
--     would be a worse defect than the one it fixed.
--
-- RECONCILIATION IS IMPOSSIBLE HERE, AND THAT IS THE POINT. `policy_decisions`
-- is append-only under `trg_policy_decisions_append_only`: this migration
-- CANNOT rewrite a historic evidence row, and must not — rewriting the audit
-- trail to fit a new constraint is the falsification every other section of
-- this file refuses. So the pre-check below FAILS LOUDLY instead, exactly as
-- section 7d does, naming what it found. On a database that migrates in order
-- it counts zero rows, and on the retained pre-057 fixture it counts zero rows.
-- ──────────────────────────────────────────────────────────────

-- ── 11a. the loud pre-check ───────────────────────────────────────────────
DO $$
DECLARE bad INTEGER;
BEGIN
  SELECT COUNT(*) INTO bad
    FROM policy_decisions d
   WHERE (d.tenant_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM tenants t WHERE t.tenant_id = d.tenant_id))
      OR (d.actor_user_link_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM user_links u
                           WHERE u.user_link_id = d.actor_user_link_id));
  IF bad > 0 THEN
    RAISE EXCEPTION 'FBL-020-R5 §2 refused: % retained policy decision(s) name a tenant or an '
                    'actor that does not exist. This ledger is append-only, so there is no '
                    'honest repair — the rows must be adjudicated before this migration runs', bad;
  END IF;

  SELECT COUNT(*) INTO bad
    FROM policy_decisions d
   WHERE d.decision = 'allow' AND d.actor_type = 'user' AND d.tenant_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM user_links u
                      WHERE u.user_link_id = d.actor_user_link_id
                        AND u.tenant_id = d.tenant_id);
  IF bad > 0 THEN
    RAISE EXCEPTION 'FBL-020-R5 §2 refused: % retained ALLOW decision(s) attribute access in one '
                    'tenant to an actor belonging to another', bad;
  END IF;

  SELECT COUNT(*) INTO bad
    FROM policy_decisions d
   WHERE d.session_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM identity_sessions s
                      WHERE s.session_id = d.session_id
                        AND s.user_link_id = d.actor_user_link_id
                        AND s.connection_id = d.connection_id
                        AND s.provider_subject = d.actor_provider_subject);
  IF bad > 0 THEN
    RAISE EXCEPTION 'FBL-020-R5 §2 refused: % retained decision(s) record a credential whose '
                    'session, actor, connection and provider subject do not belong together', bad;
  END IF;

  SELECT COUNT(*) INTO bad
    FROM policy_decisions d
   WHERE d.support_session_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM support_access_sessions s
                      WHERE s.support_session_id = d.support_session_id
                        AND s.request_id = d.support_request_id
                        AND s.tenant_id = d.tenant_id
                        AND s.actor_user_link_id = d.actor_user_link_id);
  IF bad > 0 THEN
    RAISE EXCEPTION 'FBL-020-R5 §2 refused: % retained decision(s) cite a support session that '
                    'does not match the request, tenant and actor recorded beside it', bad;
  END IF;

  SELECT COUNT(*) INTO bad
    FROM policy_decisions d
    CROSS JOIN LATERAL unnest(d.matched_role_binding_ids) AS m(id)
   WHERE NOT EXISTS (SELECT 1 FROM role_bindings rb
                      WHERE rb.role_binding_id = m.id
                        AND rb.user_link_id = d.actor_user_link_id);
  IF bad > 0 THEN
    RAISE EXCEPTION 'FBL-020-R5 §2 refused: % retained matched-binding claim(s) name a binding '
                    'that does not exist or does not belong to the decision''s actor', bad;
  END IF;
END $$;

-- ── 11b. the two facts MATCH SIMPLE needs ─────────────────────────────────
--
-- A composite foreign key is MATCH SIMPLE: if ANY referencing column is NULL
-- it is satisfied without a lookup. Section 7 solved that for the identity
-- tables by making the nullable column always present (`tenant_key`); here the
-- honest answer is different, because a decision that names NO credential and
-- NO support session is a legitimate row. What must not happen is a row that
-- names one of them and then goes quiet about the actor or tenant the foreign
-- key would have checked it against — that is how a NULL turns a constraint
-- off. These two CHECKs make that shape unrepresentable, so both composite
-- keys below BITE on every row that reaches them.
ALTER TABLE policy_decisions
  ADD CONSTRAINT pd_credential_names_its_actor CHECK (
    session_id IS NULL OR actor_user_link_id IS NOT NULL
  ),
  ADD CONSTRAINT pd_support_evidence_is_attributable CHECK (
    support_session_id IS NULL
    OR (tenant_id IS NOT NULL AND actor_user_link_id IS NOT NULL)
  );

-- The ALLOW-only cross-tenant key, derived by the database so no writer can
-- choose whether it applies. NULL on every deny and on every non-`user` actor
-- — the two cases where naming a foreign actor is the recorded fact — and the
-- decision's own tenant on every `user` ALLOW, which is the row that granted
-- somebody access to a tenant's data.
ALTER TABLE policy_decisions
  ADD COLUMN allowed_actor_tenant_id UUID GENERATED ALWAYS AS (
    CASE WHEN decision = 'allow' AND actor_type = 'user' THEN tenant_id END
  ) STORED;

-- ── 11c. FK targets ───────────────────────────────────────────────────────
--
-- Plain unique indexes over columns that are already unique by construction
-- (each begins with the table's primary key). They constrain nothing new; they
-- exist so the composite foreign keys below have something to point at.
CREATE UNIQUE INDEX uq_is_credential_tuple
  ON identity_sessions (session_id, user_link_id, connection_id, provider_subject);
CREATE UNIQUE INDEX uq_sas_evidence_tuple
  ON support_access_sessions (support_session_id, request_id, tenant_id, actor_user_link_id);
CREATE UNIQUE INDEX uq_rb_actor_scoped
  ON role_bindings (role_binding_id, user_link_id);
CREATE UNIQUE INDEX uq_pd_actor_scoped
  ON policy_decisions (decision_id, actor_user_link_id);

-- ── 11d. the four relational rules ────────────────────────────────────────
ALTER TABLE policy_decisions
  -- (a) NONEXISTENT IDENTIFIERS. `connection_id` and `session_id` already had
  -- this from section 6; the tenant and the actor did not, so a decision could
  -- name a tenant nobody has ever created and a person who does not exist.
  ADD CONSTRAINT pd_tenant_exists
    FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id),
  ADD CONSTRAINT pd_actor_exists
    FOREIGN KEY (actor_user_link_id) REFERENCES user_links (user_link_id),
  -- (b) CROSS-TENANT ACTORS. An ALLOW into a tenant's data must be attributed
  -- to somebody who belongs to that tenant. `user_links` is keyed
  -- NULLS NOT DISTINCT on (tenant_id, user_link_id), so this resolves for a
  -- platform link too — but `allowed_actor_tenant_id` is NULL for those, and
  -- for every deny, so the key is silent exactly where a foreign actor is the
  -- truth being recorded.
  ADD CONSTRAINT pd_allow_actor_is_in_its_tenant
    FOREIGN KEY (allowed_actor_tenant_id, actor_user_link_id)
    REFERENCES user_links (tenant_id, user_link_id),
  -- (c) THE CROSS-WIRED CREDENTIAL — the class a plain foreign key misses
  -- entirely, and the reason this section exists. The session named, the actor
  -- it is attributed to, the connection it came through and the provider
  -- subject it carried are ONE fact about ONE credential. Section 6 forced all
  -- four to be present together (`pd_credential_group_is_atomic`); this forces
  -- them to be present together ABOUT THE SAME SESSION. `readPresentedCredential`
  -- in `packages/identity-access/src/policy.ts` already reads all four from the
  -- one session row it selected `WHERE s.user_link_id = $1`, so no production
  -- write changes — what changes is that the guarantee no longer depends on
  -- that function remaining correct.
  ADD CONSTRAINT pd_credential_identity_tuple
    FOREIGN KEY (session_id, actor_user_link_id, connection_id, actor_provider_subject)
    REFERENCES identity_sessions
      (session_id, user_link_id, connection_id, provider_subject),
  -- (e) SUPPORT EVIDENCE IS ONE TUPLE. The session, the approved request it
  -- derives from, the tenant it reached into and the platform person who held
  -- it must all be the support session's own facts. Section 6 required all
  -- four to be PRESENT; this requires them to agree.
  ADD CONSTRAINT pd_support_evidence_tuple
    FOREIGN KEY (support_session_id, support_request_id, tenant_id, actor_user_link_id)
    REFERENCES support_access_sessions
      (support_session_id, request_id, tenant_id, actor_user_link_id);

-- The recorded WINDOW is the fifth support fact, and it cannot join the key
-- above: `expires_at` has microsecond precision in PostgreSQL and millisecond
-- precision in JavaScript, so a foreign key over it would refuse every genuine
-- support allow that had round-tripped through the application. It is enforced
-- as an exact comparison instead, against the session the row itself names —
-- and `record()` now takes the value from that row inside the INSERT rather
-- than sending one back, so the comparison is between the column and itself.
CREATE OR REPLACE FUNCTION policy_decisions_support_window_is_the_sessions() RETURNS TRIGGER AS $$
DECLARE actual TIMESTAMPTZ;
BEGIN
  IF NEW.support_session_id IS NULL THEN RETURN NEW; END IF;
  SELECT s.expires_at INTO actual
    FROM support_access_sessions s
   WHERE s.support_session_id = NEW.support_session_id;
  IF NEW.support_session_expires_at IS DISTINCT FROM actual THEN
    RAISE EXCEPTION
      'policy_decisions INSERT refused: the recorded support window % is not the window of '
      'support session % (%)',
      NEW.support_session_expires_at, NEW.support_session_id, actual;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_policy_decisions_support_window ON policy_decisions;
CREATE TRIGGER trg_policy_decisions_support_window
  BEFORE INSERT ON policy_decisions
  FOR EACH ROW EXECUTE FUNCTION policy_decisions_support_window_is_the_sessions();

-- ── 11e. (d) THE MATCHED-BINDING ARRAY, NORMALIZED ────────────────────────
--
-- One row per binding a decision claims matched. Two composite foreign keys,
-- and between them they say the whole rule: the binding EXISTS, it belongs to
-- the DECISION'S OWN ACTOR, and the decision it is attached to names that same
-- actor. A decision therefore cannot claim authority from a binding held by
-- anybody else — which, because `role_bindings` is itself keyed
-- (tenant_id, user_link_id) into `user_links`, makes a cross-tenant authority
-- claim unrepresentable without naming a cross-tenant actor first.
--
-- The primary key is (decision_id, role_binding_id), so a decision also cannot
-- claim the same binding twice and inflate what matched.
CREATE TABLE policy_decision_matched_bindings (
  decision_id           UUID    NOT NULL,
  role_binding_id       UUID    NOT NULL,
  actor_user_link_id    UUID    NOT NULL,
  authorization_version BIGINT  NOT NULL,
  match_ordinality      INTEGER NOT NULL,
  PRIMARY KEY (decision_id, role_binding_id),
  CONSTRAINT pdmb_version_positive CHECK (authorization_version >= 1),
  CONSTRAINT pdmb_ordinality_positive CHECK (match_ordinality >= 1),
  CONSTRAINT pdmb_decision_names_this_actor
    FOREIGN KEY (decision_id, actor_user_link_id)
    REFERENCES policy_decisions (decision_id, actor_user_link_id),
  CONSTRAINT pdmb_binding_belongs_to_the_actor
    FOREIGN KEY (role_binding_id, actor_user_link_id)
    REFERENCES role_bindings (role_binding_id, user_link_id)
);

CREATE INDEX idx_pdmb_binding ON policy_decision_matched_bindings (role_binding_id);

-- THE AUTHORIZATION-VERSION RELATIONSHIP (R5 §2.3). `role_bindings` keeps one
-- CURRENT `authorization_version` and no history table, so "the version this
-- decision saw" cannot be a foreign key — the binding legitimately moves on
-- afterwards, and a key over it would retroactively invalidate true evidence
-- the next time the binding changed. What IS enforceable, and is enforced, is
-- the direction: a decision may record a version the binding has already
-- reached, never one from the future. A fabricated version number is refused
-- for the same reason a fabricated id is.
CREATE OR REPLACE FUNCTION policy_decision_binding_version_is_reachable() RETURNS TRIGGER AS $$
DECLARE reached BIGINT;
BEGIN
  SELECT rb.authorization_version INTO reached
    FROM role_bindings rb WHERE rb.role_binding_id = NEW.role_binding_id;
  -- EXISTENCE IS THE FOREIGN KEY'S JOB, not this trigger's. When the binding is
  -- absent `reached` is NULL and this returns quietly, so the refusal is
  -- attributed to `pdmb_binding_belongs_to_the_actor` and an operator reading
  -- the error learns which rule the row actually broke.
  IF reached IS NOT NULL AND NEW.authorization_version > reached THEN
    RAISE EXCEPTION
      'policy evidence refused: matched binding % is recorded at authorization version %, '
      'which that binding has never reached (it is at %)',
      NEW.role_binding_id, NEW.authorization_version, reached;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_pdmb_version_reachable ON policy_decision_matched_bindings;
CREATE TRIGGER trg_pdmb_version_reachable
  BEFORE INSERT ON policy_decision_matched_bindings
  FOR EACH ROW EXECUTE FUNCTION policy_decision_binding_version_is_reachable();

-- Normalized evidence is still evidence: append-only, by the same function
-- migration 055 installed for every other identity ledger.
DROP TRIGGER IF EXISTS trg_pdmb_append_only ON policy_decision_matched_bindings;
CREATE TRIGGER trg_pdmb_append_only
  BEFORE UPDATE OR DELETE ON policy_decision_matched_bindings
  FOR EACH ROW EXECUTE FUNCTION identity_append_only();

-- THE ONE WRITER. The child rows are derived by the database from the array in
-- the same statement that writes the decision, so there is no code path — not
-- the policy engine, not a fixture, not a repair script, not psql — that can
-- write the array without also submitting it to the keys above. The INSERT
-- runs inside the caller's transaction, so a rejected element takes the whole
-- decision with it and no half-recorded evidence survives.
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
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_policy_decisions_normalize_matches ON policy_decisions;
CREATE TRIGGER trg_policy_decisions_normalize_matches
  AFTER INSERT ON policy_decisions
  FOR EACH ROW EXECUTE FUNCTION policy_decisions_normalize_matched_bindings();

-- ============================================================
-- Total: 2 tables created (login_transactions,
-- policy_decision_matched_bindings), 0 rows deleted.
-- Unprovable sessions revoked; ambiguous links disabled; the identity
-- tuple enforced by composite foreign keys rather than by convention;
-- policy evidence versioned so a new decision cannot be incomplete,
-- and RELATIONAL so a complete one cannot be fabricated or cross-wired;
-- MFA certification bounded and revocable; the step-up callback made
-- server-authoritative and every terminal state explained; a support
-- window's expiry made a recorded, once-only transition;
-- every new security assertion defaults CLOSED.
-- ============================================================
