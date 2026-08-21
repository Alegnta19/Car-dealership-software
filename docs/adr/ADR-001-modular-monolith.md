# ADR-001 — Modular Monolith and Evolutionary Replacement

Status: Accepted (FBL-010) · Owner: architect · Date: 2026-07-30

## Context

The service-cockpit application is a proven, five-times-reviewed fixed-ops slice inside a
single package. The blueprint's direction is a multi-domain dealership platform; the
failure mode to avoid is the origin platform's: ~64 generated modules with no enforced
boundaries, no tests, and code that provably never ran. A second failure mode to avoid is
the premature-microservices tax: network partitions, distributed transactions and
per-service infrastructure before any measured need.

## Decision

One deployable modular monolith (apps/api, plus apps/worker — deployed since FBL-020-R4,
which registered the support-access expiry sweep **alone**; FBL-020-R5 registered the
login-transaction and reauthentication expiry sweeps beside it, so the deployed worker now
runs **three** identity expiry sweeps on an interval. DURABLE jobs, meaning a queue or
outbox, still wait for FBL-040), composed of workspace packages with machine-enforced boundaries
(dependency-cruiser + the ownership manifest). Existing behavior is preserved and
migrated in characterization-tested slices; no big-bang rewrites. Microservice extraction
requires a measured scaling or isolation need recorded in a future ADR.

## Consequences

One process to operate, one transaction boundary (PostgreSQL), boundaries enforced at
build time instead of network time. Module discipline depends on CI gates, not distance.

## Rejected alternatives

Microservices now (unjustified operational cost); staying single-package (boundaries
would keep eroding; FBL-060's decomposition needs somewhere to decompose INTO); a full
rewrite (discards five review rounds of hardened behavior).

## Migration effect

FBL-010 moved code without changing behavior (HTTP contract snapshot + 139 tests).
Later orders add capability inside these boundaries.

## Rollback implications

Plain git revert restores the prior layout; no data or schema is involved.

## Effect of FBL-020 through R5

The identity and organization boundary added packages inside these boundaries and changed
none of them: `@dealer/identity-access` and `@dealer/organization` are workspace packages
under the same dependency-cruiser rules and the same ownership manifest, `apps/**` still
holds no SQL and imports no query primitive, and no service was extracted. The decision
above is therefore unchanged by FBL-020-R5; what R5 added is enforcement and reachability,
not topology — one owner per authorization-state table
(`scripts/check-owned-mutations.ts`), one implementation of the shared effectiveness
predicate (`scripts/check-role-binding-effectiveness.ts`), both wired into
`npm run architecture:check`, and the worker registration recorded under "Decision" above,
which made two already-written sweeps reachable in the deployed process without moving a
boundary.

## Governing authority, and the status of this statement

The active order is **FBL-020-R5**, checked in at
[`docs/orders/FBL-020-R5.md`](../orders/FBL-020-R5.md), canonical-LF SHA-256
`83b7bcd961bd36e1ba06ed79bebe524a8d1a6b40c65797ad2b4c37cc0ce47f44`. Per its Appendix A,
**every R5 clause is UNVERIFIED until the final package proves it**. This ADR records an
architectural decision and its effect; it closes no clause and asserts no gate.
