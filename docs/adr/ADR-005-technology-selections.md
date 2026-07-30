# ADR-005 — Technology Selections

Status: Accepted (FBL-010) · Owner: architect · Date: 2026-07-30

## Context

The blueprint requires an explicit, evidence-anchored baseline and forbids framework
rewrites for fashion.

## Decision (approved baseline)

- Node 20.20.2 (`.nvmrc`; engines >=20 <25) — the version CI and the container run.
- TypeScript (full strict; remaining flags ratcheted at 59 with growth blocked).
- Express, retained for the existing API.
- PostgreSQL 16 with `pg`; PostgreSQL is the transactional source of truth.
- npm workspaces, ONE root package-lock.json; private packages, never published.
- Modular monolith plus worker processes (ADR-001).
- dependency-cruiser (locked in the root lockfile) for architecture checking in CI.
- Prettier + ESLint + tsc-strict ratchets with per-file baselines (59/136/29 ceilings).
- Container: digest-pinned node:20-alpine, non-root, healthchecked.

## Deferred, deliberately (recorded, not implemented)

- Managed OIDC and the organization model → FBL-020.
- RLS and tenant-qualified foreign keys → FBL-030.
- Public OpenAPI v1, idempotency kernel, transactional outbox, public Problem Details
  adoption → FBL-040.
- Service use-case decomposition (and F-01/F-02/F-03) → FBL-060.
- No Fastify/framework rewrite; no microservice extraction without measured need.

## Consequences

Boring, reproducible, already-proven components; every deviation needs a superseding ADR
with evidence.

## Rejected alternatives

Fastify/Nest rewrite (churn without measured need); pnpm/yarn (npm workspaces suffice and
keep one lockfile format); Prisma/ORM (the SQL is where this platform's tenancy
invariants are enforced and reviewed).

## Migration effect

None; this records what is already running.

## Rollback implications

None; superseding decisions require a new ADR.
