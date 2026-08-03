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

| Column                  | Type | Notes                                                                                    |
| ----------------------- | ---- | ---------------------------------------------------------------------------------------- |
| `actor_scope`           | TEXT | `dealership` / `platform`, paired with `tenant_id` by CHECK                              |
| `provider_user_id`      | TEXT | Unique per (tenant, provider) — `NULLS NOT DISTINCT`, so the platform slot is unique too |
| `status`                | TEXT | `pending` → `activated` → `deactivated`; activation stamps `activated_at`                |
| `email`, `display_name` | TEXT | Refreshed at login; never authorization inputs                                           |

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
