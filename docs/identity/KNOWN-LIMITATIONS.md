# FBL-020 — Known Limitations

Stated plainly so the next order starts from facts.

## Not proven by deterministic CI

- **Live WorkOS behaviour.** Every verifier property — issuer/audience pinning,
  algorithm allowlist, JWKS caching and bounded refresh, rotation without
  restart, fail-closed outage, `auth_time` proof — is proven against a
  deterministic local RSA issuer. WorkOS-specific behaviour (real AuthKit
  redirect parameters, real token claim shapes, real `max_age=0` semantics,
  real organization membership) is **not** exercised. That is the live
  certification gate.
- **The provider adapter's SDK calls.** `createWorkosProvider` compiles and is
  architecture-tested for confinement, but no test invokes the real SDK.

## Deliberately out of scope (named owners)

| Gap                                                                                                             | Owner                       |
| --------------------------------------------------------------------------------------------------------------- | --------------------------- |
| Durable audit outbox and tamper-evident envelope — audit rows are transactional, delivery is not guaranteed     | FBL-040                     |
| Row-level security; the new tables ship tenant-qualified constraints, legacy tables keep query-layer discipline | FBL-030                     |
| SAML SSO and SCIM — interfaces only, unenableable (database CHECK)                                              | future order                |
| Provider webhooks (organization/user lifecycle push)                                                            | future order                |
| Break-glass access without an approver                                                                          | refused by design (ADR-008) |
| OpenAPI v1 surface for /auth                                                                                    | FBL-030+                    |
| Splitting the 3,300-line legacy service                                                                         | FBL-060                     |

## Accepted operational consequences

- **Provider outage blocks login and reauthentication.** Existing sessions keep
  working until they expire. There is no local fallback authenticator by design.
- **Support access stalls without an available approver.** Requester ≠ approver
  is a structural CHECK; there is no self-approval path.
- **Rotating `WORKOS_COOKIE_PASSWORD` logs everyone out** and invalidates
  outstanding OAuth transactions.
- **`step_up_token_uses` (migration 050) is now dead weight.** It is no longer
  written or read; dropping it is a future migration, not this one.
- **`platform_admin` no longer implies dealership access.** Any operational
  procedure that relied on that must go through support access.

## Sharp edges for the next implementer

- The policy engine writes an evidence row for **every** decision. High-volume
  read endpoints therefore write one row per request; if that becomes a load
  problem, the fix is batching or sampling _denials-plus-sensitive-allows_,
  never dropping evidence silently.
- `rooftop_id = location_id` is load-bearing. Renaming or regenerating rooftop
  ids breaks scope resolution for every historical row.
- Resource-scoped denials must keep rendering the not-found envelope. A
  well-meaning "clearer" 403 would reintroduce resource enumeration.
