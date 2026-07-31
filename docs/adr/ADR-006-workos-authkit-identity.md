# ADR-006 — WorkOS AuthKit Managed Identity

Status: Accepted (FBL-020) · Owner: architect · Date: 2026-07-31

## Context

Production trust rested on a locally signed HS256 JWT and a locally signed step-up
token — no issuer, no audience, no key rotation, no MFA assurance, no federation path.
The blueprint requires a managed identity provider; the architect selected WorkOS
AuthKit for the B2B organization model, organization-aware sessions, verifiable
`auth_time` + `max_age` reauthentication, organization-level MFA policy, and a later
path to enterprise SSO and Directory Sync.

## Decision

WorkOS AuthKit is the production identity provider. Access tokens are verified with
configured issuer, configured audience, an allowlisted asymmetric algorithm, and `kid`
resolution through the configured WorkOS JWKS (cached; one bounded refresh on unknown
kid; rotation without restart; fail closed). `auth_time` is required; sensitive actions
use `max_age=0` reauthentication that mints internal single-use, hash-stored grants.
The official WorkOS Node SDK (`@workos-inc/node@^8`, the newest major supporting the
pinned Node 20) is confined to `packages/identity-access/src/provider/workos/` by an
architecture rule; `jose@^6` performs standards-based JWT/JWKS verification.
WorkOS role/permission claims are display hints only: authorization is decided from
database-authoritative RoleBindings, never token content. Each active internal Tenant
maps one-to-one to a WorkOS Organization via an identity_provider_connection record;
the internal Tenant remains the authoritative business boundary.

## Consequences

Staff authentication, MFA, and reauthentication proof become provider responsibilities;
organization scope, authorization, support access, and policy evidence stay internal.
Production acceptance of the old HS256 bearer is removed (the authorized security
change); JWT_SECRET/STEP_UP_SECRET leave the production configuration surface.

## Rejected alternatives

Auth0/Okta/Cognito (viable, but WorkOS was selected for org-first B2B semantics and
AuthKit's reauthentication contract); keeping the custom JWT (no rotation, no MFA
assurance, unauditable trust); building password auth in-house (out of the question).

## Migration effect

Migration 055 adds identity/organization tables; a bootstrap command provisions the
first tenant administrator; token acceptance switches provider at deploy time.

## Rollback implications

Additive schema — rolling the application back to `7cb1044` ignores the new tables.
Reverting the code restores HS256 acceptance (a deliberate security downgrade that
requires its own decision).
