# Threat-Model Delta — FBL-020 Identity and Organization

What changes in the attack surface, what each change defends, and what remains open.

## New surfaces introduced

| Surface            | Threats                                                                | Controls                                                                                                                                                                                    |
| ------------------ | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| /auth/* routes (6) | CSRF on login/logout, open-redirect, code interception, state fixation | Authorization Code + PKCE, cryptographically random single-use state/nonce, exact redirect-URI validation, return-location allowlist, single-use expiring auth transactions                 |
| Session cookies    | Theft, fixation, cross-site request forgery                            | HttpOnly, Secure (outside explicit localhost dev), SameSite=Lax+, host-only, bounded lifetime, CSRF required for cookie-authenticated unsafe requests, immediate local revocation on logout |
| JWKS fetching      | SSRF via token-derived URLs, stampede, poisoned keys, availability     | JWKS URL from configuration only (never token content), cached with one bounded unknown-kid refresh, concurrent-refresh guard, fail closed on timeout/malformed keys                        |
| WorkOS SDK         | Supply-chain / type leakage across boundaries                          | Pinned major (^8, Node-20-compatible), confined to the adapter directory by an architecture rule with a negative fixture                                                                    |
| Bootstrap command  | Privilege escalation at first-run                                      | Idempotent, dry-run capable, refuses ambiguous mappings, audited, prints no credentials                                                                                                     |

## Threats retired

- **Algorithm confusion / forged HS256 tokens**: production acceptance of locally
  signed HS256 is removed entirely; only the allowlisted asymmetric algorithm with
  configured issuer/audience/JWKS verifies. `none` and HS256 are rejected by test.
- **Permanent credentials**: exp/iat/auth_time required; bounded clock skew.
- **Forged step-up**: locally signed step-up trust is replaced by provider-backed
  `max_age=0` reauthentication with auth_time-after-start proof, MFA-required org
  policy, and single-use SHA-256-hash-stored grants consumed atomically.
- **Stale authorization**: RoleBindings are read per decision; revocation denies the
  very next request even under a still-valid token.
- **Token-claim privilege**: WorkOS roles/permissions are display hints; forging or
  enlarging them grants nothing (tested).
- **Cross-tenant reach via platform roles**: platform_admin loses implicit dealership
  access; support access requires separate approval, is bounded to 60 minutes, scope-
  restricted, visible, and fully audited with the true actor.
- **Resource enumeration**: unauthorized vs nonexistent resources are externally
  indistinguishable for resource-scoped requests.

## Accepted residual risks (explicit)

- Provider availability: WorkOS outage blocks login/reauth (sessions continue until
  expiry). Accepted; no local fallback authenticator by design.
- Audit durability: audit rows are transactional but the durable outbox and
  tamper-evident envelope remain FBL-040 scope.
- RLS: database-level tenant enforcement remains FBL-030 scope; the new tables ship
  tenant-qualified constraints, the legacy tables keep query-layer discipline.
- SAML/SCIM: interfaces only; enabling them is a future order with its own review.
- Live-provider behavior: deterministic CI proves the verifier against a local issuer;
  WorkOS-specific behavior is covered by the live certification gate.
