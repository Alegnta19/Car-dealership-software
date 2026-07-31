# ADR-007 — Organization Hierarchy and Policy Context

Status: Accepted (FBL-020) · Owner: architect · Date: 2026-07-31

## Context

The platform's only organization concepts were an opaque `tenant_id` and a
`location_id` column. Dealer groups own legal entities, entities own rooftops,
rooftops own departments — and authorization must scope to any of those levels. Role
checks lived as per-route role arrays with no evidence trail.

## Decision

A canonical five-level hierarchy — Tenant → DealerGroup → LegalEntity → Rooftop →
Department — owned by @dealer/organization, with tenant-qualified uniqueness and
referential checks from the first migration (055), effective-status windows
(status + effective_from/effective_to), and no hard deletes. Authorization moves to a
central policy API in @dealer/identity-access: deny by default; RoleBindings are
database-authoritative and loaded per decision; scope covers descendants (tenant ⊃
group ⊃ entity ⊃ rooftop ⊃ department ⊃ exact resource); cross-tenant is always
denied; `platform_admin` becomes a platform-control role with no implicit dealership
access. Every decision writes an append-only PolicyDecision evidence row (ids, codes,
versions — never PII). Fixed Ops publishes one action catalog; routes declare actions,
not role arrays; resource-scope resolution stays in Fixed Ops behind a scope-resolver
port composed in the API. Legacy `location_id` is the compatibility rooftop id:
backfilled Rooftops preserve rooftop_id = location_id, and existing Fixed Ops columns
are not renamed. For resource-scoped requests, unauthorized and nonexistent resources
are externally indistinguishable (the existing not-found envelope).

## Consequences

Authorization becomes auditable, revocation-immediate, and hierarchy-aware. RLS and
program-wide key retrofits remain FBL-030's; the new tables simply arrive ready.

## Rejected alternatives

Flat tenant+location forever (cannot express group/entity operations); provider-side
authorization (tokens cannot be revoked mid-life and provider claims are unauditable
here); embedding policy in each route (the drift this order exists to end).

## Migration effect

055 backfills pending-configuration tenants and minimal ancestors from retained data;
nothing activates automatically; every retained business row must survive.

## Rollback implications

Additive; application rollback to `7cb1044` ignores the hierarchy.
