# Migration 055 — Notes and Rollback (FBL-020)

## What it does

One forward-only, **additive** migration: 14 new tables, their indexes, one
append-only trigger on `policy_decisions`, 13 `updated_at` triggers, and a
catalog-driven backfill. It touches **no existing table, column, index or
constraint**.

The migration runner wraps each file in a single transaction, so 055 is
all-or-nothing.

## Deliberate deviations from the 049–054 house style

- **Plain `CREATE TABLE`, not `IF NOT EXISTS`.** These are new namespaces; a
  name collision means something is genuinely wrong and must fail loudly. The
  origin platform's systemic `IF NOT EXISTS` no-ops (PLATFORM-CONTEXT §5.3)
  are exactly what this avoids.
- **Tenant-qualified uniqueness from the first migration.** There is no
  global-name era to migrate away from later.
- **Composite `(tenant_id, parent_id)` foreign keys** at every level, so
  cross-tenant parentage is impossible rather than merely discouraged.

## Backfill behaviour

Sources are enumerated from `information_schema` rather than a hand-kept list,
so no tenant-bearing table can be missed:

1. every `tenant_id` in retained data → a `pending_configuration` tenant;
2. one pending dealer group and legal entity per tenant;
3. every `(tenant_id, location_id)` pair → a rooftop with
   `rooftop_id = location_id`.

**Refusal case:** if one `location_id` appears under more than one tenant, the
migration raises and rolls back. That would mean the legacy data is already
corrupt, and silently attaching the rooftop to whichever tenant inserted first
would bake the corruption in.

On a fresh database every backfill statement is a no-op.

## What the backfill never does

No user link, session, role binding, provider connection, policy decision,
reauthentication row or support-access row is created. Nothing is activated.
`scripts/verify-upgrade-state.ts` asserts all nine of those tables are empty
after an upgrade, plus tenant/rooftop parity and ancestry integrity — and CI
runs it on the upgrade path from the frozen `f76a27a` fixture.

## Rollback

**Application rollback needs no database change.** Deploying the previous
application version against a 055 database works: the old code never reads the
new tables. That is the intended rollback path.

If the schema itself must be reverted (it should not be), the objects are
self-contained:

```sql
DROP TABLE IF EXISTS support_access_sessions, support_access_requests,
  reauthentication_grants, reauthentication_transactions, policy_decisions,
  role_bindings, identity_sessions, user_links, identity_provider_connections,
  departments, rooftops, legal_entities, dealer_groups, tenants CASCADE;
DROP FUNCTION IF EXISTS identity_append_only();
DELETE FROM schema_migrations WHERE filename = '055_identity_organization.sql';
```

`set_updated_at()` is shared with migration 050 — do **not** drop it.

**Consequence of a schema rollback:** every identity, role binding and policy
evidence row is destroyed, and reverting the application restores HS256 bearer
acceptance. That is a deliberate security downgrade requiring its own decision,
not an operational convenience.

## Verification performed

| Check                                                          | Result                                                               |
| -------------------------------------------------------------- | -------------------------------------------------------------------- |
| Fresh chain (000 → 055)                                        | applies clean                                                        |
| CI-shaped upgrade (f76a27a fixture + legacy seed → full chain) | applies clean; legacy rows survive                                   |
| Fresh vs upgraded schema fingerprint                           | identical (in-CI comparison is the authoritative one)                |
| `verify-upgrade-state.ts`                                      | tenant parity, rooftop parity, ancestry integrity, nine tables empty |
| Constraint behaviour                                           | 12-test suite in `tests/organization.test.ts`                        |
