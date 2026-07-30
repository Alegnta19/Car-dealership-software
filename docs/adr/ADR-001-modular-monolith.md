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

One deployable modular monolith (apps/api today; apps/worker when FBL-040 introduces
durable jobs), composed of workspace packages with machine-enforced boundaries
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
