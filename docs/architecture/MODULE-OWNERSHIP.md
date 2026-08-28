# Module Ownership

Human-readable companion to `architecture/modules.json` (the machine-read source the
dependency-cruiser rules are generated from; `scripts/check-architecture-manifest.ts`
keeps the two and the real workspace manifests consistent, in CI).

**Governing authority.** The active order is FBL-020-R5, checked in at
[`docs/orders/FBL-020-R5.md`](../orders/FBL-020-R5.md), canonical-LF SHA-256
`83b7bcd961bd36e1ba06ed79bebe524a8d1a6b40c65797ad2b4c37cc0ce47f44`. Per its Appendix A,
**every R5 clause is UNVERIFIED until the final package proves it**. This document records
ownership and the gates that enforce it; it closes no clause.

| Module            | Owner                 | Purpose                                                                                                                                                                             | May depend on                                                                      | Never                                         |
| ----------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------- |
| @dealer/contracts | platform-architecture | Shared contract types: roles, tenant context, envelopes, Problem Details                                                                                                            | —                                                                                  | Frameworks, drivers, business rules           |
| @dealer/platform  | platform-architecture | Config boundary, request context, logging, error primitives, JWT verify                                                                                                             | contracts                                                                          | Express, pg, business rules                   |
| @dealer/database  | platform-architecture | Pool, query, transactions                                                                                                                                                           | platform (logging)                                                                 | Business rules, schema definitions            |
| @dealer/fixed-ops | fixed-operations      | Service-cockpit domain + application behavior (legacy/ unsplit until FBL-060)                                                                                                       | contracts, platform, database                                                      | Express, other modules' persistence internals |
| @dealer/test-kit  | platform-architecture | Test guards, world builders                                                                                                                                                         | contracts, platform, database, fixed-ops                                           | Being imported by production code             |
| @dealer/ui        | web-experience        | UI primitives (shell)                                                                                                                                                               | contracts                                                                          | Business rules, server dependencies           |
| @dealer/api       | fixed-operations      | HTTP composition root: middleware order, routes, envelopes, lifecycle                                                                                                               | contracts, platform, database, fixed-ops                                           | Business rules, SQL, direct pg                |
| @dealer/worker    | platform-architecture | Background process (deployed): the three identity expiry sweeps (support windows, login transactions, step-ups) and the two outbox dispatchers (administration, inventory listings) | contracts, platform, database, fixed-ops, organization, identity-access, inventory | Queues/outbox/schedulers until FBL-040; SQL   |
| @dealer/web       | web-experience        | Web shell (no product UI; not deployed)                                                                                                                                             | contracts, ui                                                                      | Server-side logic, database access            |

Layer rules inside business packages: domain imports no transport/database/metrics/env;
application depends on domain and declared ports; adapters implement ports; composition
roots wire. Packages are consumed through `src/index.ts` only — deep imports are
rejected statically (dependency-cruiser) and at runtime (`exports` maps).
`process.env` is read only in `packages/platform/src/config.ts` and the app composition
roots. Apps carry no business SQL and no database query primitives: the executable
app-SQL guard (`scripts/check-app-sql.ts`, part of `npm run architecture:check`) rejects
imports of `query`/`getPool`/`withTransaction` from @dealer/database, direct `pg`
imports, calls to those primitives, and SQL statement literals in app production code —
proven in both directions by `architecture/fixtures/forbidden-app-sql`. The composition
root may import `closePool` for lifecycle shutdown only.

Authorization state has ONE set of writers (introduced by FBL-020-R4 section 5, unchanged
through FBL-020-R5). A table that carries
`authorization_version` — tenants, the four organization levels, user links, role
bindings, provider connections, identity sessions and the two support-access tables — may
be written only by the attributed mutation services in @dealer/identity-access (plus the
origin-of-trust bootstrap service, the session lifecycle owner and the login-observation
path, each declared by name). The owned-mutation guard
(`scripts/check-owned-mutations.ts`, part of `npm run architecture:check`) derives that
table set from the migrations, refuses a write anywhere else in apps/packages/scripts,
refuses a write whose table comes from an interpolation, and requires every test-side
authorization-state write to travel through the declared fixture-only primitive in
@dealer/test-kit — proven in both directions by
`architecture/fixtures/owned-mutation-bypass` and `owned-mutation-correct`.

The audit trail those writers leave has ONE inventory.
`packages/identity-access/src/audit-inventory.ts` maps every identity lifecycle transition
to the `audit_events.event_type` it writes and to the file and test name that prove it, and
the audit-inventory gate (`scripts/check-audit-inventory.ts`, part of
`npm run architecture:check`) holds that list complete over the `identity.` namespace **as
far as a static resolver can read the event type**: an event type in production code that
is neither inventoried nor declared a non-audit literal fails the build, as does an
`INSERT INTO audit_events` in a file that is not a declared writer. Proven in both
directions by `architecture/fixtures/audit-inventory-gap` and `audit-inventory-declared`.

An event type **assembled** at run time is refused only when the shared resolver
(`scripts/static-string-resolver.ts`) can either render it or identify the unreadable
piece. It resolves concatenation, `.join`, `.concat`, `String.raw`, indexed and spread
fragments, lookup maps, enum and class-static members, and cross-file imports; it names
the unreadable piece for a `.reduce` fold, a non-`String.raw` template tag and a
call-result fragment. **It does not see** a value crossing a function boundary with an
unreadable root, array mutation other than `push`, or a name formed from object KEYS —
those pass unlisted. That residue is not a footnote to this paragraph; it is stated in
`docs/identity/KNOWN-LIMITATIONS.md`, in both gate headers, and demonstrated by
`architecture/fixtures/audit-inventory-residue`, whose fixtures the gate is asserted to
ACCEPT. Earlier revisions of this sentence claimed run-time assembly failed the build
without qualification; that was false, and a false absolute here went unnoticed because
no test read this file. One does now.

Databases: the phase-248 schema (root `migrations/`) is owned by @dealer/fixed-ops's
orders; @dealer/database owns connections, never schema.
