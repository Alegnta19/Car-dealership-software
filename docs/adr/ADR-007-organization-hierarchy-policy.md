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

---

## R3 amendment (FBL-020-R3) — what the evidence names, and what the actor is told

**Evidence ids are GENERATED, never accepted.** R2 read `x-request-id` and
`x-correlation-id` off the request, so a client decided what the append-only
evidence row recorded — and recorded nothing at all when it sent nothing. The
engine now reads the pair the outermost middleware minted, which is the pair
every log line already carries, so a decision joins to its logs on ids no caller
chose. Off-request decisions (a scheduler, a CLI, a test) generate a pair rather
than leaving it null, because "no id" is not a fact a decision may record about
itself.

**Assurance on the evidence row is computed, not asserted.** `freshness` and
`mfa_assurance` are derived from the actor's own live local session and live
grants by one shared function; a caller cannot state either, and
`not_applicable` is now reachable only when there genuinely is no live session
and no live grant.

**A resource-less action still has a scope.** Restated because it is the rule
most easily lost: a named `location_id` is resolved exactly like a resource and
a binding must cover that rooftop's chain; with no location named, the action
reaches the whole tenant and **only a tenant-scope binding authorizes it**.

**Every authorization-changing write goes through an owned mutation service.**
`packages/identity-access/src/mutations.ts` owns organization status,
provider mapping/issuer/MFA certification, user-link lifecycle, role bindings
and support access. Each service resolves a non-null acting user link **before**
the write (an unattributable mutation is refused), advances the applicable
`authorization_version`, and writes its `audit_events` row in the SAME
transaction. Raw `INSERT`/`UPDATE` against `role_bindings` or
`identity_provider_connections` bypasses all three and is not a sanctioned
path — including from fixtures.

**The actor is told the EFFECTIVE scope.** `GET /auth/session` reports, for each
EFFECTIVE binding, its scope level, its node, and whether that node is active and
inside its effective window right now. Listing bindings alone would over-report
reach, because archiving a node revokes everything beneath it without touching a
`role_bindings` row. `platform` has no node, and a `resource`-level binding
names a business row rather than an organization node; both report their level
honestly instead of inventing an effectiveness.

**The binding-effectiveness rule is WRITTEN ONCE, and the build enforces that.**
A binding authorizes nothing unless it is `active` AND inside its own effective
window — three conditions, exported from `policy.ts` as the single interpolated
predicate `EFFECTIVE_ROLE_BINDING_SQL`. Three separate FBL-020-R3 defects were
one shape: a second, hand-written copy of those conditions that had dropped the
window, so a binding left `active` with an `effective_to` in the past passed one
gate while the engine, asked the same question, refused. Two of the three
survived the wave that introduced the shared constant, which is why the rule is
no longer a convention: `scripts/check-role-binding-effectiveness.ts`, part of
`npm run architecture:check`, fails the build when SQL reads `role_bindings`
without resolving the constant into every read, or hand-writes a filter on that
table's `status`, `effective_from` or `effective_to`, or interpolates the constant
and then ORs or negates it away, or declares the constant a second time, or guts
the constant itself.

The guard does not match text (FBL-020-R3 §H1): it resolves what an interpolation
REFERS TO, so `${EFFECTIVE_ROLE_BINDING_SQL}`,
`${policy.EFFECTIVE_ROLE_BINDING_SQL}` and an alias bound at the import are the
same predicate, while a table name or a filter fragment held in a constant is
substituted before the SQL is judged. When it cannot resolve a statement it says so
and fails, because "0 statements inspected, OK" and "there is no such SQL here"
must not read the same in the output.

The narrow, genuine exceptions — an administrative lifecycle write addressing one
row by id, a revocation sweep that must reach an already-expired binding, an
idempotency probe, a post-upgrade row count — all say the same thing: the SQL must
address bindings the engine would not match. They declare themselves in a
`role-binding-effectiveness-opt-out(<reason-code>):` comment beside the SQL, naming
one of a CLOSED set of categories and justifying it. A code excuses only the rules
that category can excuse, only in the files where it can apply, and nothing
excuses neutralising the predicate. Every opt-out in force is printed with its
category on each run.

This is why `rolesForUserLink` matters as much as the session page: the API
middleware writes its result into `req.tenantContext.roles`, and the Fixed Ops
cockpit reads those roles to decide supervisor reach over another technician's
inspection and work ticket. A roles list that disagreed with the engine was not
informational — it widened access.
