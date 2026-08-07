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
2. Pre-provision a **pending** link, or let their first login record one. A
   first login records or refreshes a PENDING link and **never activates it**.
3. Activate the link explicitly — that is the act that admits the person.
4. Grant roles explicitly, at the narrowest scope that fits: a rooftop manager
   gets a `rooftop`-scope binding, not a tenant one.

> **No HTTP administration surface exists yet.** FBL-020 delivers the
> `identity.*` / `org.unit.*` actions in the catalog and the policy engine that
> decides them, but no route declares them. Steps 2–4 are performed by calling
> the owned mutation services in `@dealer/identity-access`, never by raw SQL —
> the R3 section at the end of this runbook has the exact calls. A raw
> `INSERT INTO role_bindings` creates privilege with no acting actor, no
> version bump and no audit row.

**A login never activates a link and never grants a role.** A person who logs
in with no bindings can see nothing, and a person whose link is still pending
gets no session at all.

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
-- who can do what (IDS ONLY — an email in a report is a disclosure)
SELECT rb.user_link_id, rb.role, rb.scope_level, rb.scope_id
  FROM role_bindings rb
 WHERE rb.tenant_id = :t AND rb.status = 'active'
 ORDER BY rb.role, rb.scope_level;
```

Then have the administrator log in through `/auth/login` and confirm
`GET /auth/session` reports the expected roles.

## 6. Decommissioning

Set the tenant `suspended` (denies everything immediately) or `archived`.
Never delete: the hierarchy, the links, the bindings and the policy evidence
are the record of who could do what, and when.

---

## R2 changes (FBL-020-R2)

`scripts/bootstrap-identity.ts` now requires `--issuer` and binds the
administrator link to the connection it maps:

```bash
DATABASE_URL=... npx tsx scripts/bootstrap-identity.ts   --tenant-id <uuid> --tenant-name "Delta Motors"   --provider-org org_... --issuer https://<env>.authkit.app   --admin-user user_... --admin-email admin@dealer.com
```

Still dry-run by default; still refuses ambiguous mappings; still prints no
credentials.

**Ordering now matters.** A provider connection must exist and be active
_before_ any identity in that tenant can be activated, because activation
binds the link to exactly one connection. The bootstrap does this in the
right order; a manual sequence must too.

**Support approvals need high assurance.** A tenant administrator approving
platform-support access must have freshly re-authenticated under a certified
MFA policy, and the approval records the grant that backed it. Separation of
duty alone no longer approves.

---

## R3 corrections (FBL-020-R3) — the ordering and the sanctioned calls

This section supersedes the R2 section above wherever they differ.

### The bootstrap command

```bash
DATABASE_URL=... npx tsx scripts/bootstrap-identity.ts \
  --tenant-id <uuid> --tenant-name "Delta Motors" \
  --provider-org org_... --issuer https://<env>.authkit.app \
  --admin-user user_... [--admin-email admin@dealer.com] [--apply]
```

`--issuer` is **required**: the issuer is the trust anchor every request is
checked against, so a connection whose issuer the command cannot state would
authorize nothing. Still dry-run by default; still prints no credentials.

It **refuses** rather than guess when:

- the provider organization already belongs to another internal home;
- the tenant already has an active connection to a different organization;
- the mapping exists but its connection is disabled (re-enable it deliberately);
- the named administrator's link is deactivated;
- the named administrator's link is bound to a **different** provider connection;
- **the existing mapping records a different issuer than `--issuer`** — issuer
  drift aborts before any write, in dry-run and in `--apply` alike.

### Ordering matters

A provider connection must exist and be **active before** any identity in that
tenant can be activated, because activation binds the link to exactly one active
connection. The bootstrap does this in the right order; a manual sequence must
too.

### A login never activates, and never grants

**Remove any expectation that a first login creates a usable account.** A first
login records or refreshes a **PENDING** UserLink and issues no session. An
administrator activates it explicitly, and activation binds the link to exactly
one active connection — if the tenant has zero or more than one, activation is
refused rather than guessing. A person who logs in with no bindings can see
nothing, and a person whose link is still pending gets no session at all.

### Adding people — the sanctioned calls

There is still **no HTTP administration surface**: FBL-020 ships the `identity.*`
and `org.unit.*` actions and the engine that decides them, but no route declares
them. Administration is performed by calling the owned mutation services in
`@dealer/identity-access`, each of which requires an existing acting user link,
advances the applicable `authorization_version` and writes its `audit_events` row
in the same transaction:

```ts
import { provisionUserLink, activateUserLink, grantRole } from '@dealer/identity-access';

// 1. invite the person into the WorkOS organization (dashboard)

// 2. pre-provision a PENDING link — or let their first login create one
const link = await provisionUserLink({
  tenantId,
  providerUserId: 'user_...',
  email: null, // display metadata only; never an authorization input
  provisionedByUserLinkId: adminLinkId,
});

// 3. activate it explicitly — this is the act that admits them
await activateUserLink({ userLinkId: link.userLinkId, activatedByUserLinkId: adminLinkId });

// 4. grant roles at the NARROWEST scope that fits
await grantRole({
  actingUserLinkId: adminLinkId,
  tenantId,
  userLinkId: link.userLinkId,
  role: 'service_advisor',
  scopeLevel: 'rooftop',
  scopeId: rooftopId,
});
```

**Do not `INSERT INTO role_bindings` by hand.** A raw insert creates privilege
with no acting actor, no version bump and no audit row — the three things that
make a grant reviewable. The same applies to `identity_provider_connections`
(use `changeProviderIssuer`, `remapProviderConnection`,
`certifyProviderMfaPolicy`) and to the user-link lifecycle
(`deactivateUserLink`, `relinkUserLink`, `revokeRole`, `revokeRolesForUserLink`).

The bootstrap command is the single exception, and only because it is the ORIGIN
of trust: before it runs there is no actor to attribute anything to, so the one
`tenant_admin` grant it creates is attributed to the administrator link it just
minted, and the whole run is audited as `identity.bootstrap.applied`.

### Verify before going live

```sql
-- the tenant is active and effective
SELECT status, effective_from, effective_to FROM tenants WHERE tenant_id = :t;
-- exactly one active connection, with the REAL issuer and its certification state
SELECT provider_organization_id, status, issuer,
       mfa_policy_certified, mfa_policy_certified_at
  FROM identity_provider_connections WHERE tenant_id = :t;
-- every rooftop id still matches a legacy location
SELECT r.rooftop_id FROM rooftops r WHERE r.tenant_id = :t
EXCEPT SELECT DISTINCT location_id FROM repair_orders WHERE tenant_id = :t;
-- who can do what (IDS ONLY — do not select email into a report)
SELECT rb.user_link_id, rb.role, rb.scope_level, rb.scope_id
  FROM role_bindings rb
 WHERE rb.tenant_id = :t AND rb.status = 'active'
 ORDER BY rb.role, rb.scope_level;
```

Then have the administrator log in through `/auth/login` and confirm
`GET /auth/session` reports the expected `roles`, an effective
`organization_scope`, and a `local_session_expires_at` in the future. That
response carries **no** email or provider profile by design, so it is safe to
paste into a ticket; the query above is likewise written to select ids rather
than people.

### Support approvals need high assurance AND authority

A tenant administrator approving platform-support access must be a **current,
effective `tenant_admin` of that tenant** (checked before anything else, and
required for a denial too) and must have freshly re-authenticated under a
certified MFA policy — the approval records the consumed grant that backed it.
Separation of duty alone no longer approves.
