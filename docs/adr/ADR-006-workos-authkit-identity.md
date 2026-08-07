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

---

## R1 amendment (FBL-020-R1) — assurance, nonce, and the trust anchor

Three decisions are restated because the first implementation conflated facts
the provider keeps separate.

**Freshness is not MFA.** WorkOS documents organization MFA policy separately
from `max_age` reauthentication. `max_age=0` plus an `auth_time` after the
transaction start proves ONE thing: a fresh authentication event happened. It
says nothing about which factors were used or what the organization requires.
The two are therefore modelled separately:

| Assurance              | Requires                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------ |
| `fresh_only`           | a fresh provider authentication event                                                |
| `fresh_and_mfa_policy` | that **and** an active connection certifying the mapped organization as MFA-required |

An uncertified, false, expired or inactive certification **fails closed**. We
do not fabricate an AMR value and do not claim a specific authentication
method, because WorkOS does not supply evidence this verifier can validate.
Certification is an operator act, dated and attributable; the live gate must
prove the actual development/staging organization has MFA required.

**The issuer is the trust anchor, not the organization id.** A provider
organization identifier is a MAPPING input: it says which internal home a
token belongs to. Authorization additionally requires that the connection's
configured issuer agrees with the verified token issuer, checked on every
request. A token whose issuer disagrees is refused even when its organization
maps cleanly.

**Every authorization leg carries an OIDC nonce.** Login and reauthentication
each mint a cryptographically random nonce, seal it in the transaction cookie,
send it on the authorization request, and require the corresponding claim back
— compared against that same single-use transaction. It is distinct from
`state`, from the PKCE verifier and from any internal grant identifier, and it
is never logged. Missing, mismatched, expired and replayed all fail closed.

`org_id` itself is required **in the verifier**, not in a later check a new
caller could forget: this platform admits organization members only.

---

## R3 amendment (FBL-020-R3) — server-derived facts, and digests that are read

R1 named the decisions; R2 stored the columns; R3 makes the platform the
authority for the values those columns are compared against.

**Starting facts are DERIVED, not accepted.** A reauthentication used to accept
the connection, issuer, provider organization and provider subject it would
later be checked against, falling back to the database only when they were
absent. A caller that supplies both sides of an equality proves nothing by
satisfying it. Every starting fact is now derived in one statement from the
**live local session** the step-up is requested from: the session names its
connection, the connection names the issuer and the organization, the UserLink
names the subject. A caller may state what it believes those values are, and a
disagreement **refuses the start** — belief is checked, never authoritative.
The transaction additionally records the local session, and the completion
revalidates tenant, connection, UserLink, session and MFA certification before
any grant is minted.

**A stored digest that nothing compares is decoration.** `oidc_nonce_hash` was
written at start from R1 onward and never read, so the only nonce check that
ever ran compared the token's claim against the value the client's own
transaction cookie carried. The completion now compares the digest of the
returned nonce against the **stored** digest, and migration 057 forbids a
`started` transaction that cannot name one — so the comparison can never be
reached with nothing to compare. The raw nonce never leaves the verifier: only
its digest travels, which is why it cannot reach a log line, a response, an
error or the database.

**A missing verified value is a FAILURE.** R2 compared identity facts only when
the caller had supplied them, so supplying nothing passed every check. Absence
and disagreement are now the same closed answer.

**Both credentials are locally revocable.** A bearer token used to be
authenticated against the provider alone, which left the provider as the only
authority on whether the caller was still logged in — a local logout could not
deny an unexpired access token. A verified bearer now establishes a local
session, every later request revalidates it, and revoking it denies the very
next request.

**Impersonation is refused, not merely unused.** ADR-008 rejected WorkOS
impersonation; R3 stops relying on the dashboard for that. Three carriers (the
RFC 8693 `act` claim, a provider `impersonator` object, and
`authentication_method = 'Impersonation'`) are recognised, and any one refuses
the credential on every path — bearer, login callback, reauthentication
callback, and provider refresh, which additionally revokes the session. The
impersonator's email is classified and dropped; the value never crosses the
verifier boundary.

**Assurance is COMPUTED.** Freshness and MFA certification are read from the
actor's own live session and grants — one function, used both by the policy
evidence row and by `GET /auth/session`, so the page can never tell an operator
something the audit trail denies.

**The authenticated-session response is BOUNDED.** `GET /auth/session` answers
with eight identity facts and nothing else: internal user id, tenant, effective
organization-scope summary, active role summary, computed freshness, MFA
classification, local-session expiry, and active support state with expiry. No
email, provider profile, provider subject, provider session id, token or
refresh state. The CSRF token, which is not an identity fact, travels in the
`x-csrf-token` response header instead.

**HTTP is a loopback-only development affordance.** Plain http is accepted only
when `NODE_ENV` is explicitly `development` or `test` **and** the URL host is
loopback. The R2 `ALLOW_INSECURE_LOCAL_IDENTITY` override — which permitted
http on any host, staging included — is gone.
