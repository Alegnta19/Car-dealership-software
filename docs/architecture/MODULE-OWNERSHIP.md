# Module Ownership

Human-readable companion to `architecture/modules.json` (the machine-read source the
dependency-cruiser rules are generated from; `scripts/check-architecture-manifest.ts`
keeps the two and the real workspace manifests consistent, in CI).

| Module            | Owner                 | Purpose                                                                       | May depend on                            | Never                                         |
| ----------------- | --------------------- | ----------------------------------------------------------------------------- | ---------------------------------------- | --------------------------------------------- |
| @dealer/contracts | platform-architecture | Shared contract types: roles, tenant context, envelopes, Problem Details      | —                                        | Frameworks, drivers, business rules           |
| @dealer/platform  | platform-architecture | Config boundary, request context, logging, error primitives, JWT verify       | contracts                                | Express, pg, business rules                   |
| @dealer/database  | platform-architecture | Pool, query, transactions                                                     | platform (logging)                       | Business rules, schema definitions            |
| @dealer/fixed-ops | fixed-operations      | Service-cockpit domain + application behavior (legacy/ unsplit until FBL-060) | contracts, platform, database            | Express, other modules' persistence internals |
| @dealer/test-kit  | platform-architecture | Test guards, world builders                                                   | contracts, platform, database, fixed-ops | Being imported by production code             |
| @dealer/ui        | web-experience        | UI primitives (shell)                                                         | contracts                                | Business rules, server dependencies           |
| @dealer/api       | fixed-operations      | HTTP composition root: middleware order, routes, envelopes, lifecycle         | contracts, platform, database, fixed-ops | Business rules, SQL, direct pg                |
| @dealer/worker    | platform-architecture | Worker shell (no jobs until FBL-040; not deployed)                            | contracts, platform, database, fixed-ops | Business workflows in FBL-010                 |
| @dealer/web       | web-experience        | Web shell (no product UI; not deployed)                                       | contracts, ui                            | Server-side logic, database access            |

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

Databases: the phase-248 schema (root `migrations/`) is owned by @dealer/fixed-ops's
orders; @dealer/database owns connections, never schema.
