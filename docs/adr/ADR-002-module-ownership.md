# ADR-002 — Module Ownership and Dependency Direction

Status: Accepted (FBL-010) · Owner: architect · Date: 2026-07-30

## Context

Boundaries only hold when a machine checks them. The origin platform demonstrated the
alternative: every module reaching into every other, caller-supplied tenant ids, and
cross-module SQL.

## Decision

`architecture/modules.json` is the single source of ownership and allowed-dependency
truth; the dependency-cruiser rules are generated from it, and
`scripts/check-architecture-manifest.ts` fails CI when the manifest and the real
workspace manifests drift. Dependency direction: contracts ← platform ← database ←
fixed-ops ← apps; ui ← web; test-kit is imported by nothing in production. Packages are
consumed only through their public entry point (`src/index.ts`, enforced statically by
rule and at runtime by `exports` maps). Domain code imports no transport, driver,
metrics, filesystem or network modules. `process.env` is confined to the configuration
boundary and composition roots (`scripts/check-env-access.ts`).

## Consequences

Adding a dependency edge is an explicit, reviewed change in two places that must agree.
A negative fixture proves the checker rejects persistence deep-imports.

## Rejected alternatives

Convention-only boundaries (this repo's own history says no); duplicating the dependency
rules by hand in the checker config (drifts silently — the generated rules make the
manifest load-bearing).

## Migration effect

None at runtime; CI gains `architecture:check`.

## Rollback implications

Reverting removes the gates but breaks nothing at runtime.
