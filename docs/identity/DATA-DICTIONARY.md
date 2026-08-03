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
