# Identity and Organization — Data Dictionary (migration 055)

Fourteen tables, five sections. Every table is tenant-qualified where it holds
dealership data; parent edges carry `tenant_id` in a composite foreign key, so
cross-tenant parentage is a database error rather than a review question.
Nothing here is ever hard-deleted: retirement is a status transition plus an
effective window.

## 1. Organization hierarchy

### `tenants`

The authoritative business/data-ownership boundary. A WorkOS Organization is
only an external authentication mapping onto this row.

| Column                           | Type        | Notes                                                                            |
| -------------------------------- | ----------- | -------------------------------------------------------------------------------- |
| `tenant_id`                      | UUID PK     | Also the value legacy fixed-ops rows already carry                               |
| `name`                           | TEXT        | 1–200 chars                                                                      |
| `status`                         | TEXT        | `pending_configuration` (backfill default) / `active` / `suspended` / `archived` |
| `effective_from`, `effective_to` | TIMESTAMPTZ | Half-open window; `to > from` enforced                                           |

Only an `active` tenant inside its window can act — the policy engine denies
`TENANT_INACTIVE` otherwise.

### `dealer_groups`, `legal_entities`, `rooftops`, `departments`

The chain Tenant → DealerGroup → LegalEntity → Rooftop → Department.

| Column                           | Type              | Notes                                                                  |
| -------------------------------- | ----------------- | ---------------------------------------------------------------------- |
| `<level>_id`                     | UUID PK           | For backfilled rooftops this IS the legacy `location_id`               |
| `tenant_id`                      | UUID FK → tenants | Present at every level, never derived at read time                     |
| parent id                        | UUID              | FK is composite `(tenant_id, parent_id)` — same-tenant by construction |
| `code` (departments only)        | TEXT              | `^[a-z][a-z0-9_]{0,63}$`, unique per rooftop                           |
| `name`                           | TEXT              | Unique per tenant, case-insensitive, among non-archived rows           |
| `status`                         | TEXT              | `pending_configuration` / `active` / `inactive` / `archived`           |
| `effective_from`, `effective_to` | TIMESTAMPTZ       | As above                                                               |

**Compatibility rule.** `rooftop_id = location_id` for every backfilled
rooftop. No legacy column was renamed; the Fixed Ops scope resolver reads
`location_id` and returns a rooftop reference.

## 2. Identity provider mapping, users, sessions

### `identity_provider_connections`

| Column                     | Type | Notes                                                                  |
| -------------------------- | ---- | ---------------------------------------------------------------------- |
| `connection_scope`         | TEXT | `dealership` (tenant set) / `platform` (tenant NULL) — paired by CHECK |
| `provider`                 | TEXT | **`workos` only** — SAML/SCIM cannot be inserted (§Federation)         |
| `provider_organization_id` | TEXT | Globally unique: one external org has one internal home                |
| `status`                   | TEXT | `active` / `disabled`; at most one ACTIVE per (provider, tenant)       |

### `user_links`

| Column                  | Type | Notes                                                                                                                                                                                                                          |
| ----------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `actor_scope`           | TEXT | `dealership` / `platform`, paired with `tenant_id` by CHECK                                                                                                                                                                    |
| `provider_user_id`      | TEXT | Unique per (tenant, provider) — `NULLS NOT DISTINCT`, so the platform slot is unique too                                                                                                                                       |
| `status`                | TEXT | `pending` → `activated` → `deactivated`; activation stamps `activated_at`                                                                                                                                                      |
| `email`, `display_name` | TEXT | Refreshed at login; never authorization inputs. A rewrite is audited as `email_changed` / `display_name_changed` — never the values — and does NOT advance `authorization_version`, because it changes nothing an actor may do |

A link carries **no privilege**. A freshly activated user has zero role
bindings and deny-by-default applies.

### `identity_sessions`

| Column                                       | Type        | Notes                                                                                       |
| -------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------- |
| `session_token_hash`                         | TEXT        | `^[0-9a-f]{64}$` — the SHA-256 of the opaque cookie value; the value itself is never stored |
| `provider_session_id`                        | TEXT        | Carried into the provider logout URL                                                        |
| `auth_time`                                  | TIMESTAMPTZ | From the verified token                                                                     |
| `expires_at`, `revoked_at`, `revoked_reason` |             | Validation requires unexpired, unrevoked, and an `activated` link                           |

## 3. Authorization

### `role_bindings` — the ONLY source of privilege

| Column        | Type | Notes                                                                                      |
| ------------- | ---- | ------------------------------------------------------------------------------------------ |
| `scope_level` | TEXT | `platform` / `tenant` / `dealer_group` / `legal_entity` / `rooftop` / `department`         |
| `scope_id`    | UUID | NULL exactly when `scope_level = 'platform'` (CHECK)                                       |
| `tenant_id`   | UUID | NULL exactly when `scope_level = 'platform'` (CHECK)                                       |
| `status`      | TEXT | `active` / `revoked`; uniqueness applies to ACTIVE rows only, so revoke-then-regrant works |

### `policy_decisions` — append-only evidence

UPDATE and DELETE raise `P0001` via trigger. Columns are ids, codes and
versions: `action`, `resource_type`, `resource_id`, `scope_level`, `scope_id`,
`decision`, `reason_code`, `policy_version`, `request_id`,
`support_session_id`. **No PII, no free text** — `details` stays `{}`.

## 4. Reauthentication

### `reauthentication_transactions`

`nonce_hash` (SHA-256 hex) unique; `state` `started` → `completed`/`failed`/
`expired`; bound to tenant, user, action and optional resource; `expires_at >
started_at`.

### `reauthentication_grants`

One per transaction (`reauth_txn_id` UNIQUE). `grant_hash` SHA-256 hex,
unique. Consumption is `UPDATE ... WHERE consumed_at IS NULL AND expires_at >
NOW()` executed inside the business transaction, so a rollback releases it.

## 5. Support access

### `support_access_requests`

`requested_actions TEXT[]` (1–50), `scope_level`/`scope_id`,
`requested_duration_minutes` **1–60 by CHECK**, `reason` (1–2000 chars, stored
here and nowhere else), `status`, `decided_by_user_link_id`.
`decided_by <> requester` is a CHECK: self-approval is impossible.

### `support_access_sessions`

One per request. `expires_at <= granted_at + INTERVAL '60 minutes'` is a
CHECK — the ceiling is structural, not a habit. `revoked_at` ends access on
the next policy decision.

## Backfill (additive, inert)

Catalog-driven: every `tenant_id UUID` column outside the new tables produces a
`pending_configuration` tenant; each gets one pending dealer group and legal
entity; every `(tenant_id, location_id)` pair becomes a rooftop with
`rooftop_id = location_id`. A `location_id` seen under two tenants aborts the
migration loudly. **No user link, role binding, session, provider connection or
policy decision is ever invented** — proven by `verify-upgrade-state.ts`.

---

# Migration 056 — FBL-020-R1 contract completion

Forward-only and additive. Migrations 000 and 049–055 are byte-identical to
the accepted head (`git diff 1b1a1bc..HEAD -- migrations/` is empty); 056 only
adds columns, constraints and indexes.

## 1. `identity_provider_connections` — the trust anchor

| Column                                                | Type                           | Notes                                                                                                                                                                                         |
| ----------------------------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `issuer`                                              | TEXT NOT NULL                  | The token issuer this connection trusts. Every request is refused unless the VERIFIED token issuer agrees with it. Provider identifiers are mapping inputs; this is the authorization anchor. |
| `mfa_policy_certified`                                | BOOLEAN NOT NULL DEFAULT FALSE | Operator certification that the mapped WorkOS organization is configured MFA-required. Separate from freshness by design (ADR-006-R1). Uncertified fails closed.                              |
| `mfa_policy_certified_at` / `_by_user_link_id`        |                                | A certification is dated and attributable or it is not a certification (CHECK).                                                                                                               |
| `effective_from` / `effective_to`                     | TIMESTAMPTZ                    | Expiring the window denies the next request.                                                                                                                                                  |
| `created_by` / `updated_by` / `authorization_version` |                                | Audit pair + observable version.                                                                                                                                                              |

**Deterministic upgrade:** every pre-existing connection received
`issuer = 'urn:fbl-020-r1:issuer-unset'` **and `status = 'disabled'`**. A
connection whose issuer we cannot prove authorizes nothing until an operator
sets the real value and re-enables it. No credential was invented.

## 2. Audit actors and versions

`tenants`, `dealer_groups`, `legal_entities`, `rooftops`, `departments`,
`user_links`, `identity_sessions`, `role_bindings`, `support_access_requests`,
`support_access_sessions`, `reauthentication_transactions` and
`reauthentication_grants` all gained `created_by_user_link_id`,
`updated_by_user_link_id` and/or `authorization_version` as applicable.

`user_links` additionally gained `activated_by_user_link_id`,
`deactivated_by_user_link_id`, `deactivated_at` and an effective window, so
activation is attributable and a deactivation is dated (CHECK).

## 3. Exact typed-resource RoleBinding scope

`scope_level = 'resource'` names exactly one row via `resource_type` +
`resource_id`. Four CHECK constraints make the shape unambiguous:

| Constraint                   | Refuses                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------- |
| `rb_resource_scope_complete` | a resource level without both fields, or either field at another level          |
| `rb_resource_type_shape`     | an unbounded/malformed resource type                                            |
| `rb_resource_not_ambiguous`  | a resource binding that ALSO claims an organization node, or one with no tenant |
| `rb_scope_id_presence`       | a `scope_id` at the platform/resource levels, or its absence elsewhere          |

Policy evaluation requires an exact match on tenant, type and id. A resource
binding grants no descendant, no sibling, and never satisfies a tenant-wide
action.

## 4. Complete policy evidence

| Column                                                        | Notes                                                                                                        |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `matched_role_binding_ids` / `matched_authorization_versions` | Parallel arrays; aligned cardinality (CHECK). A DENY may never claim a match (CHECK `pd_deny_has_no_match`). |
| `freshness_classification`                                    | `not_applicable` / `stale` / `fresh`                                                                         |
| `mfa_assurance_classification`                                | `not_applicable` / `uncertified` / `certified`                                                               |
| `correlation_id`                                              | Distinct from `request_id`: one ties a flow, the other one call.                                             |
| `support_request_id`                                          | The approved request behind a support-authorized decision.                                                   |

`scope_level` was widened to admit `resource` so evidence can name the level
it actually matched.

## 5. Fields deliberately NOT added, and why

The order requires an explanation rather than a silent omission.

| Record                          | Omitted                                                           | Why it is inapplicable                                                                                                                                                                                                                              |
| ------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `identity_sessions`             | `status`, `effective_from/to`, `updated_by`                       | Its lifecycle IS `issued_at` → `expires_at` with `revoked_at`/`revoked_reason`; that pair is the effective window under different names. A session is never administratively edited, so there is no updater — only `revoked_by_user_link_id`.       |
| `policy_decisions`              | every mutable-record field                                        | It is **append-only immutable evidence** (trigger `identity_append_only`). A decision is a fact that occurred at `occurred_at`; it has no status to change, no window to expire, no updater and no version, because it can never be updated at all. |
| `reauthentication_transactions` | `status`, effective window, `updated_by`, `authorization_version` | `state` (`started`/`completed`/`failed`/`expired`) is its status under its domain name, and `started_at` → `expires_at` is its window. It is machine-driven and single-use; no administrator edits it.                                              |
| `reauthentication_grants`       | same                                                              | `consumed_at` plus `issued_at` → `expires_at` is the whole lifecycle. Single-use by construction.                                                                                                                                                   |
| `support_access_requests`       | effective window                                                  | `status` plus `decided_at` and `requested_duration_minutes` define its life; the window belongs to the SESSION the approval mints.                                                                                                                  |
| `support_access_sessions`       | `status`, effective window                                        | `granted_at` → `expires_at` with `revoked_at` IS the window, capped at 60 minutes by CHECK.                                                                                                                                                         |

## 6. No hard deletion

Nothing in migrations 055 or 056 deletes an organization, identity, role,
session, reauthentication, policy or support-access record. Retirement is a
status transition or an effective-window close, and policy evidence cannot be
deleted at all.
---

# Migration 057 — FBL-020-R2/R3 boundary completion

Forward-only and additive. Migrations 000 and 049–056 are **byte-identical** to
the accepted head; 057 creates one table (`login_transactions`), adds columns,
constraints and indexes, and deletes no row.

**Reconciliation always precedes constraints.** Adding a CHECK before the
UPDATE that fixes existing rows would abort the migration on a populated
database, so every section in 057 is ordered: add the column, reconcile the
rows that cannot satisfy the new rule, _then_ add the constraint. Where a
reconciliation would otherwise erase a fact, the fact is preserved instead — a
superseded support decision is copied into `superseded_*` columns and audited
rather than overwritten.

## 1. `login_transactions` — the server-side login authority

State, nonce and PKCE verifier as SHA-256 digests; the allowlisted return
location; its own `expires_at`; the screened `request_id` / `correlation_id`
pair. Status walks

```
pending ──claim──▶ consuming ──▶ succeeded
   │                   │
   └───────────────────┴──────▶ failed  (always with a reason)
```

`lt_state_machine` makes the illegal shapes unrepresentable: a `succeeded` row
that was never claimed, a terminal row with no consumption instant, and a
status disagreeing with the outcome column. Both terminal states absorb, and
the claim is conditional on `pending`, so a replay at any stage loses.

`failure_reason` is a closed, server-written vocabulary. It never contains a
provider message, a token, a nonce or an authorization code.

## 2. `identity_sessions` — bound, revocable, refreshable

| Column                                                                    | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `credential_kind`                                                         | `cookie` / `bearer` — R3 gives BOTH credential kinds a locally revocable session                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `connection_id`, `issuer`, `provider_subject`, `provider_organization_id` | A LIVE session must name all four (CHECK). The unbound state is unrepresentable, so there is no bypass                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `refresh_state_sealed`, `refresh_state_key_version`                       | AES-256-GCM ciphertext of the refresh token plus the key version that sealed it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `refresh_token_hash`                                                      | the replay digest; rotation is keyed on it, so a replayed token changes nothing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `provider_access_token_expires_at`                                        | R3 correction C1: the VERIFIED `exp` of the provider access token this session last obtained — an instant, never a credential. It is what schedules the refresh, so the sealed state above has a runtime spender instead of sitting at rest unused. NULL means the expiry was never learned, and nothing is ever scheduled. `is_bearer_holds_no_access_expiry` keeps it NULL on the bearer path, which takes custody of no provider credential                                                                                                                                                                                                                                                                                                |
| `refresh_rotation_count`                                                  | increments only on a genuine rotation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `refresh_lease_id`, `refresh_lease_expires_at`                            | R3 correction D1: the CLAIM on an in-flight refresh attempt, and when it stops being one. It replaced holding the row's `FOR UPDATE` lock across the provider HTTP call — which pinned a shared pool connection inside an idle open transaction for as long as a hung provider hung. The lease keeps single-spend (a second request sees it and does nothing) without anyone waiting on someone else's network call. An EXPIRED lease is reclaimable, so a crashed attempt cannot wedge a session. `is_refresh_lease_paired` (claim and expiry are one fact) and `is_refresh_lease_needs_state` (a claim on nothing is meaningless) are CHECKs; with the two below/above, a revoked or bearer session holding a live claim is unrepresentable |
| `revoked_at`, `revoked_reason`                                            | `is_revoked_holds_no_refresh_state`: a revoked session holds NO sealed state and no replay digest (CHECK) — and therefore, via `is_refresh_lease_needs_state`, no lease either                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

## 3. `reauthentication_transactions` — exact binding, and the nonce that is read

| Column                                                                    | Notes                                                                                                         |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `connection_id`, `issuer`, `provider_organization_id`, `provider_subject` | The identity the step-up started from, derived server-side from the live session — never supplied by a caller |
| `session_id`                                                              | The LOCAL session the step-up steps up FROM. The completion revalidates it                                    |
| `oidc_nonce_hash`                                                         | The digest of the OIDC nonce this leg demands back. **Read at completion**, not merely written                |

`rat_started_is_bound` requires all six of those on any `started` row, so the
nonce comparison can never be reached with nothing to compare. Reconciliation
expired every pre-R3 `started` row that could not satisfy it; no row was
deleted and no value was invented.

## 4. Support access — authority and high assurance

| Column                   | Notes                                                                                                                                                                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `approval_grant_id`      | The approver's own grant, SPENT BY the approval: minted for `identity.support.approve` against THIS request and consumed inside the approving transaction. UNIQUE (partial index), so one single-use grant can approve at most one request |
| `superseded_*` (+ audit) | **HISTORY, NOT AUTHORITY.** A live approval that could not name a grant was ended and its decision PRESERVED here. Write-only audit fields: no gate, engine branch or mutation reads them, so setting one authorizes nothing               |

**The approval assurance bar is NOT a column.** `decideSupportAccess` demands
`fresh_and_mfa_policy` for every approval, stated once in code. R3 removed a
`support_access_requests.approver_assurance` column that presented that bar as a
per-request fact while nothing read it — an operator setting a row to
`fresh_only` would have seen no change, and a later edit to the column DEFAULT
would silently have done nothing. Making it authoritative was rejected because
it would have introduced a per-request DOWNGRADE of the one gate that admits a
platform person to tenant data; the bar is a platform-wide policy and belongs
where it is reviewed. See migration 057, section 5.

**Requester authority is re-judged, never remembered.** Filing, approval and
session start each require the requester to hold a current, effective
platform-support binding, and the policy engine re-checks the same binding on
every decision made through a live support session. Revoking the binding is
therefore sufficient offboarding: a pending request becomes unapprovable and a
live session stops authorizing on its very next decision, with no operator
obliged to remember `revokeSupportSession`.

## Migration checksums (canonical values)

**All migration checksums in this repository are canonical LF / git-blob
values**, computed as

```bash
git show HEAD:migrations/<file>.sql | sha256sum
```

They are **not** Windows working-tree values: a working copy checked out with
CRLF line endings hashes differently for every file, and a checksum taken there
will disagree with CI and with every other machine. When a checksum is quoted
in a report, in a ticket or in a review, it is this value.

| Migration                                    | sha256 (canonical, LF/git-blob)                                    |
| -------------------------------------------- | ------------------------------------------------------------------ |
| `000_platform_core.sql`                      | `a3e0f4ca4990a313cabdefa8b26ca762977e95d2c8cfafbedf64f3ecb4fda94d` |
| `049_phase248_service_cockpit.sql`           | `523ee2e236b427e55fdd06037f350ac4729865581b5772d8078cf473e5984242` |
| `050_phase248_hardening.sql`                 | `009d464da812459168b341b112dd4972edb39c406b0e5ebf33fb11798d35a522` |
| `051_phase248_metrics_support.sql`           | `e79d9a9fd56b76134ab6823fd8f7c83a653a4caecb5a1f243d46a5a8d36427d4` |
| `052_phase248_authorization_binding.sql`     | `94179a31e1f96185af52ecc37bc93bb9a3bd58f55a8ea46ec642300f68b04d41` |
| `053_phase248_estimate_line_association.sql` | `a2e125e122ec455ee19d1c18ffd6f08af5cd9fc46100de0ba424d5630e3b783a` |
| `054_phase248_waitlist.sql`                  | `8382d8efda1769de0828fd0de74cb8f8303e8f5aca1decf9b07e22dcf8baea58` |
| `055_identity_organization.sql`              | `52a56f414725adc5751c88bc256c9fe5f00bbeaf4b5ad909a3ecc13c86120a5d` |
| `056_identity_contract_completion.sql`       | `ff2d0307d374efba41b4ff79268ace9b03b32376d5e60ae678d840936448713d` |

`057_identity_boundary_completion.sql` is **not** pinned here: it is unaccepted
and still being edited in place, so any value quoted for it would be stale
before it was read. It gets its checksum when it is accepted.

## No hard deletion

Nothing in migrations 055, 056 or 057 deletes an organization, identity, role,
session, reauthentication, policy or support-access record. Retirement is a
status transition or an effective-window close, and policy evidence cannot be
updated or deleted at all.
