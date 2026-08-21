# Threat-Model Delta — FBL-020 Identity and Organization

What changes in the attack surface, what each change defends, and what remains
open. Current as of FBL-020-R5; every control below is in code, and the ones
without deterministic coverage are named in
[KNOWN-LIMITATIONS.md](../identity/KNOWN-LIMITATIONS.md).

**Governing authority.** The active order is FBL-020-R5, checked in at
[`docs/orders/FBL-020-R5.md`](../orders/FBL-020-R5.md), canonical-LF SHA-256
`83b7bcd961bd36e1ba06ed79bebe524a8d1a6b40c65797ad2b4c37cc0ce47f44`. Per its Appendix A,
**every R5 clause is UNVERIFIED until the final package proves it**. This model states which
threats a control addresses; it closes no clause and discharges no gate.

**What FBL-020-R5 changed in this model.** The refresh credential is destroyed in the same
statement that revokes a session, on every revoking path including cookie logout; admission
and credential custody are one atomic database decision that a concurrent administrative
change cannot race; every callback with a valid sealed handle is claimed and terminalized,
with a provider `error` callback and a missing authorization code now carrying their own
reasons; the deployed worker ages login transactions and step-ups as well as support
windows, so an abandoned transaction is no longer left pending indefinitely; and version-2
policy evidence is normalized into `policy_decision_matched_bindings`, whose composite
foreign keys make a fabricated or cross-wired authority claim unrepresentable rather than
merely unwritten.

## New surfaces introduced

| Surface               | Threats                                                                        | Controls                                                                                                                                                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/auth/*` routes (6)  | CSRF on login/logout, open redirect, code interception, state fixation, replay | Authorization Code + PKCE S256; state, nonce and PKCE verifier held as digests on a SERVER row claimed by one atomic conditional UPDATE; exact redirect-URI registration per leg; return location read from the row, re-allowlisted on the way out  |
| `login_transactions`  | A failed login recorded as a success; a mid-flight row reused                  | Explicit terminal state machine (`pending → consuming → succeeded/failed`) with `lt_state_machine` making illegal shapes unrepresentable; `succeeded` reachable only after a local session exists; every failure carries a closed-vocabulary reason |
| Session cookies       | Theft, fixation, cross-site request forgery, downgrade                         | HttpOnly, Secure outside explicit loopback development, SameSite=Lax, host-only, bounded lifetime; CSRF required on every non-safe cookie-authenticated request; the clearing cookie carries the SAME attributes it replaces                        |
| Bearer credentials    | A provider token outliving local revocation                                    | A verified bearer resolves a LOCAL session, revalidated on every request; local revocation denies the very next request without waiting for token expiry                                                                                            |
| Refresh state at rest | Database read replayed as a credential; refresh replay                         | AES-256-GCM sealed ciphertext plus a separate replay digest; rotation keyed on the old digest; a revoked session provably holds neither (CHECK)                                                                                                     |
| `GET /auth/session`   | Over-disclosure by accretion                                                   | A bounded eight-fact contract owned by the identity package, with a test asserting the exact key set; the CSRF token moved to its own response header                                                                                               |
| JWKS fetching         | SSRF via token-derived URLs, stampede, poisoned keys, availability             | JWKS URL from configuration only (never token content), cached with one bounded unknown-kid refresh, concurrent-refresh guard, fail closed on timeout/malformed keys                                                                                |
| WorkOS SDK            | Supply-chain / type leakage across boundaries                                  | Pinned major (^8, Node-20-compatible), confined to the adapter directory by an architecture rule with a negative fixture                                                                                                                            |
| Bootstrap command     | Privilege escalation at first run; silent trust relocation                     | Idempotent, dry-run by default, refuses ambiguous mappings AND issuer drift, audited, prints no credentials                                                                                                                                         |

## Threats retired

- **Algorithm confusion / forged HS256 tokens.** Production acceptance of
  locally signed HS256 is removed entirely; only the allowlisted asymmetric
  algorithm with configured issuer/audience/JWKS verifies. `none` and HS256 are
  rejected by test.
- **Permanent and impossible credentials.** `exp`/`iat`/`sub`/`sid`/`auth_time`/
  `org_id` are required in the verifier; a future `iat`, a future `auth_time`,
  and an `exp` preceding the `iat` are refused, with the configured clock
  tolerance as the only allowance.
- **Forged step-up.** Locally signed step-up trust is replaced by
  provider-backed `max_age=0` reauthentication with an auth_time-after-start
  proof, an organization MFA-policy requirement, and single-use hash-stored
  grants consumed atomically.
- **Nonce theatre.** The OIDC nonce is generated server-side, stored only as a
  digest, and the STORED digest is what the completion compares the returned
  claim against. A `started` transaction that cannot name a nonce digest is
  forbidden by CHECK, so the check cannot be reached with nothing to compare.
- **Optional comparisons.** A verified value that is absent is treated exactly
  like one that disagrees. There is no path where supplying nothing passes.
- **Caller-chosen starting facts.** A reauthentication's connection, issuer,
  organization and subject are derived from the live local session; a caller may
  state a belief, and a disagreement refuses the start.
- **Client-chosen evidence identity.** `request_id` and `correlation_id` on the
  append-only evidence row are the generated pair the middleware minted, not
  headers a caller supplied — and never null.
- **Stale authorization.** RoleBindings are read per decision; revocation denies
  the very next request even under a still-valid token.
- **Token-claim privilege.** WorkOS roles/permissions are display hints;
  forging or enlarging them grants nothing (tested).
- **Provider-token survival of local logout.** Both credential kinds resolve a
  locally revocable session; logout revokes it.
- **Impersonation.** Refused on every credential path, and a refresh that
  returns an impersonated identity revokes the session. The impersonator's email
  never crosses the verifier boundary.
- **Cross-tenant reach via platform roles.** `platform_admin` loses implicit
  dealership access; support access requires a tenant administrator of the
  target tenant, that administrator's own high-assurance grant, is bounded to 60
  minutes, scope-restricted, visible, and audited with the true actor.
- **Organization-remap account inheritance.** UserLink lookup takes all six
  identity facts, so a link bound to another organization is invisible.
- **Insecure transport by override.** http is accepted only for a loopback host
  under an explicitly non-production `NODE_ENV`; the R2 override that permitted
  http on any host is gone.
- **Resource enumeration.** Unauthorized and nonexistent resources are
  externally indistinguishable for resource-scoped requests.

## Accepted residual risks (explicit)

- **Provider availability.** A WorkOS outage blocks login and reauthentication;
  existing sessions continue until expiry and a transient refresh failure
  changes nothing. Accepted — no local fallback authenticator by design.
- **Audit durability.** Audit rows are transactional; the durable outbox and
  tamper-evident envelope remain FBL-040 scope.
- **RLS.** Database-level tenant enforcement remains FBL-030 scope; the new
  tables ship tenant-qualified constraints, the legacy tables keep query-layer
  discipline.
- **SAML/SCIM.** Interfaces only; enabling them is a future order with its own
  review, and the database refuses any provider other than `workos`.
- **No HTTP administration surface.** Provisioning, grants, certifications and
  support decisions are performed by calling the owned mutation services. The
  operator running them is trusted to be the right operator; a route with its
  own `requireAction` gate is a later order.

## NOT DISCHARGED — not a residual risk

**A mandatory gate that has not been discharged is not a risk somebody may accept; it is
work that is not done.** FBL-020-R3 was rejected for filing one under residual risk, and
until FBL-020-R5 this document repeated that mistake: live-provider behaviour was listed
above as an "accepted residual risk". It is moved here, and the wording is the one every
other delivery document uses.

- **LIVE WORKOS CERTIFICATION IS NOT DISCHARGED.** Deterministic CI proves the verifier and
  the platform side of the provider port against a local RSA issuer and a provider-neutral
  fake, and the adapter itself is invoked in process over a mocked transport
  (`tests/identity-config.test.ts`). WorkOS-specific behaviour — real AuthKit redirect
  parameters, real token claim shapes, real `max_age=0` semantics, real organization
  membership, and **the actual MFA-required organization policy** — is not exercised at all.
  It cannot be discharged from this environment: it needs credentials and an operator. The
  substitution point is `useIdentityProviderForTests`. This gate was previously referred to
  as "Gate B"; that label is retained only in the evidence-hygiene rules below, which are
  the operator's instructions for running it.

## Live-certification evidence hygiene (the gate above)

Evidence from the live certification run is a report about identifiers and outcomes, not a
transcript.
Never paste an access token, a refresh token, an authorization code, a nonce, a
cookie value, a session token, a grant, an API key, a provider profile or an
end-user email into a ticket, a log, a screenshot or a bundle. Quote the
`user_link_id`, the `connection_id`, the `reauth_txn_id`, the
`support_session_id`, the `request_id`/`correlation_id` pair and the HTTP status
— those are sufficient to reconstruct any flow from the platform's own evidence
tables, and they disclose nothing if the bundle leaks.
