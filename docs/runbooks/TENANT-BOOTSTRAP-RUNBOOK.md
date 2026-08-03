# Tenant Bootstrap Runbook (FBL-020)

How a dealership goes from "rows exist in the database" to "people can log in
and work". Applies both to a tenant backfilled by migration 055 and to a
brand-new one.

## 0. Where backfilled tenants start

Migration 055 created, for every tenant_id already present in fixed-ops data:

- a `tenants` row with status **`pending_configuration`**,
- one pending dealer group and one pending legal entity,
- one rooftop per legacy `location_id`, with `rooftop_id = location_id`.

Nothing is active, and **no user, role, session or provider connection was
invented**. A pending tenant cannot act: every policy decision denies
`TENANT_INACTIVE`.

## 1. Create the WorkOS organization

See the [WorkOS operator runbook](WORKOS-OPERATOR-RUNBOOK.md) §2. Note the
`org_...` id and the first administrator's `user_...` id.

## 2. Bootstrap (dry-run, review, apply)

```bash
DATABASE_URL=... npx tsx scripts/bootstrap-identity.ts \
  --tenant-id <uuid> --tenant-name "Delta Motors" \
  --provider-org org_... --admin-user user_...
```

The plan prints one line per step: `tenant`, `connection`, `user_link`,
`role_binding` with `create` / `update` / `exists`. Re-run with `--apply`.

What it does:

| Step         | Effect                                                                   |
| ------------ | ------------------------------------------------------------------------ |
| tenant       | Creates it, or activates a `pending_configuration` one and sets its name |
| connection   | Maps the WorkOS organization to this tenant (active)                     |
| user_link    | Creates or activates the administrator's link                            |
| role_binding | Grants `tenant_admin` at tenant scope                                    |

It **refuses** rather than guess when the organization already belongs to
another tenant, when the tenant already has a different active connection, or
when the named administrator's link is deactivated.

## 3. Name the organization properly

The backfilled group/entity/rooftops are placeholders ("Pending
configuration", "Rooftop 1a2b3c4d"). Rename them and set them `active` through
the administration path (`org.unit.create`, `org.unit.update_status`).
Rooftop **ids must not change** — they are the legacy `location_id` values that
every appointment, repair order and queue item already references.

## 4. Add people

The tenant administrator provisions each person:

1. Invite them into the WorkOS organization.
2. `identity.user.provision` creates a **pending** link (optional — a first
   login also creates an activated link).
3. Grant roles explicitly with `identity.role.grant`, at the narrowest scope
   that fits: a rooftop manager gets a `rooftop`-scope binding, not a tenant one.

**A login never grants a role.** A person who logs in with no bindings can see
nothing.

## 5. Verify before going live

```sql
-- the tenant is active and effective
SELECT status, effective_from, effective_to FROM tenants WHERE tenant_id = :t;
-- exactly one active connection
SELECT provider_organization_id, status FROM identity_provider_connections
 WHERE tenant_id = :t;
-- every rooftop id still matches a legacy location
SELECT r.rooftop_id FROM rooftops r WHERE r.tenant_id = :t
EXCEPT SELECT DISTINCT location_id FROM repair_orders WHERE tenant_id = :t;
-- who can do what
SELECT ul.email, rb.role, rb.scope_level, rb.scope_id
  FROM role_bindings rb JOIN user_links ul USING (user_link_id)
 WHERE rb.tenant_id = :t AND rb.status = 'active' ORDER BY ul.email;
```

Then have the administrator log in through `/auth/login` and confirm
`GET /auth/session` reports the expected roles.

## 6. Decommissioning

Set the tenant `suspended` (denies everything immediately) or `archived`.
Never delete: the hierarchy, the links, the bindings and the policy evidence
are the record of who could do what, and when.
