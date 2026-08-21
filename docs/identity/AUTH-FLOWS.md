# Authentication, Reauthentication and Support Flows (FBL-020)

**Current as of FBL-020-R5.** One document, one implementation. Every claim below is
either enforced by code in `packages/identity-access` / `apps/api/src/middleware/auth.ts` /
`apps/api/src/routes/auth.ts`, or by a CHECK constraint in migrations 055–057.
Anything that is **not** proven by deterministic tests is labelled as such in
[KNOWN-LIMITATIONS.md](KNOWN-LIMITATIONS.md).

**Governing authority.** The active order is FBL-020-R5, checked in at
[`docs/orders/FBL-020-R5.md`](../orders/FBL-020-R5.md), canonical-LF SHA-256
`83b7bcd961bd36e1ba06ed79bebe524a8d1a6b40c65797ad2b4c37cc0ce47f44`. Per its Appendix A,
**every R5 clause is UNVERIFIED until the final package proves it**; this document describes
behaviour and closes no clause.

The flows that changed under FBL-020-R5, described here in their changed form. An earlier
revision opened with "Two flows changed under FBL-020-R5" and listed the first two bullets
only — an understatement of the revision, corrected here rather than left:

- **Revocation destroys the provider refresh credential in the same statement that sets
  `revoked_at`** (§1.1/§1.2), on every path that revokes — cookie logout included, which is
  the path that had been forgetting it. `tests/identity-revocation.test.ts` drives the
  cookie logout of a session the real callback created and asserts that no trace of the
  sealed refresh state survives.
- **Admission and custody are ONE call** (§1.3/§1.4): no route establishes a session of its
  own, and a concurrent administrative change is either seen by the admission query or
  serialized behind it. `tests/login-admission-concurrency.test.ts` proves that
  deterministically rather than by timing, with a CONTROL leg that must admit.
- **Every callback carrying a valid sealed handle is claimed and terminalized** (§1.5),
  including the two endings the failure vocabulary previously had no word for: a provider
  `error` callback and a callback carrying no authorization code (§1 below).
- **The deployed worker ages login transactions and step-ups**, not only support windows
  (§1.6). Both sweeps were written and audited, and nothing that shipped called them.
- **Definitive refresh revocation and its audit are one transaction** (§1.7), and the
  exported refresh/rotation boundary REQUIRES access-token verification while the unsafe
  lower-level primitive is module-private (§1.8) — §6 below.
- **MFA certification requires a currently active and effective tenant** (§1.9); a support
  session whose expiry instant has passed receives the expiry transition, and a later human
  revocation cannot steal or relabel that ending (§1.10) — §7 below; and the successful
  login audit names the ADMITTED tenant and user link (§1.11).
- **Policy evidence is relationally enforced** (§2): a version-2 `policy_decisions` row's
  matched bindings are normalized into `policy_decision_matched_bindings`, whose composite
  foreign keys refuse a fabricated or cross-wired binding (§3 below).

Two redirect URIs are registered with the provider and both are load-bearing:

| Leg              | Configured as                | Route                   |
| ---------------- | ---------------------------- | ----------------------- |
| Login            | `WORKOS_REDIRECT_URI`        | `/auth/callback`        |
| Reauthentication | `WORKOS_REAUTH_REDIRECT_URI` | `/auth/reauth/callback` |

Registering only the login one strands every `max_age=0` leg at a route that
reads a different transaction cookie, and no grant can ever be minted.

## 1. Login (browser)

```
GET /auth/login?return_to=/somewhere
   ├─ INSERT login_transactions: state, nonce and PKCE verifier stored as
   │  SHA-256 digests only; status 'pending'; its own expiry; the allowlisted
   │  return location stored ON THE ROW
   ├─ seal an OPAQUE POINTER into dealer_auth_txn (HttpOnly, /auth, 10 min):
   │  purpose + the plaintext the server must compare against. The return
   │  location is NOT in the cookie.
   └─ 302 → WorkOS AuthKit (Authorization Code + PKCE S256, nonce)

GET /auth/callback?code&state
   ├─ open the sealed cookie; exact state match, else neutral 401
   ├─ CLAIM the server row atomically: pending → consuming, conditional on
   │  state_hash + nonce_hash + code_verifier_hash + not expired.
   │  A replay at ANY stage loses the UPDATE.
   ├─ exchange code + verifier at the provider
   ├─ REFUSE an impersonated exchange result (ADR-008)
   ├─ VERIFY the access token: configured issuer, audience, allowlisted
   │  asymmetric alg, kid from the configured JWKS, required claims
   │  (exp/iat/sub/sid/auth_time/org_id), bounded clock tolerance, the nonce
   │  claim, and impossible times (future iat, future auth_time, exp before iat)
   ├─ REFUSE impersonation asserted by the TOKEN as well
   ├─ org_id → identity_provider_connections (ACTIVE + effective) → internal home
   ├─ OBSERVE the UserLink: a first login creates or refreshes a PENDING link
   │  and NOTHING else. **Login never activates a UserLink and never grants a
   │  role.** A pending, deactivated, ineffective or foreign-bound link yields
   │  no session.
   ├─ create identity_session (opaque cookie value; only its SHA-256 stored;
   │  the refresh token sealed, plus its replay digest)
   ├─ succeedLoginTransaction — reachable ONLY from 'consuming', and only now
   │  that identity validation AND local-session establishment have finished.
   │  If it fails, the session just created is REVOKED and the login fails.
   └─ 302 → the return location read back FROM THE ROW, re-allowlisted
```

Every exit after the claim is terminal: the row reaches `succeeded`, or `failed` with a
reason from a closed server-written vocabulary. That vocabulary is **nine** reasons, and it
is listed here in full because an earlier revision of this paragraph listed six and silently
omitted the three the later revisions added:

| Reason                         | The fact it records                                                                          |
| ------------------------------ | -------------------------------------------------------------------------------------------- |
| `provider_exchange_failed`     | the provider refused or could not complete the code exchange                                 |
| `token_verification_failed`    | the returned access token did not verify                                                     |
| `exchange_token_mismatch`      | the exchange response and the verified token described different identities (FBL-020-R4)     |
| `impersonation_detected`       | any of the three impersonation carriers was present                                          |
| `identity_not_admitted`        | the six-fact chain refused this identity here                                                |
| `session_establishment_failed` | the local session could not be established after a good exchange                             |
| `provider_error_callback`      | the provider redirected to the callback with `error` and no code (FBL-020-R5 §1.5)           |
| `authorization_code_missing`   | a valid sealed handle and matching state, and no authorization code at all (FBL-020-R5 §1.5) |
| `expired`                      | the transaction's own expiry passed, including during a slow exchange                        |

The provider's own `error` / `error_description` strings are deliberately NOT recorded: the
vocabulary is server-written, and a provider message is caller-influenced text that must
never reach the table or a log. The answer outward is always the same neutral 401 — an
unknown organization, an unknown identity, a pending identity and a deactivated identity are
externally indistinguishable.

**All nine reach a test.** The last one to do so was `session_establishment_failed`, closed
by FBL-020-R6 §4.2: _a login whose LOCAL SESSION cannot be established is terminal, with ONE
audit event_ in `tests/login-admission.test.ts` drives a real `GET /auth/callback` against a
valid provider exchange while a `BEFORE INSERT` trigger on `identity_sessions` makes the
local session write impossible, then asserts the terminal state, the single
`identity.login.failed` event, and that no session, sealed credential or success event
survives. `scripts/mutation-kill.ts` registers the control as
`session_establishment_failure_left_pending`, so removing the route's terminalizing call
takes that named test from pass to fail in CI. Until R6 this line read "one of the nine
reaches no test", and `docs/identity/KNOWN-LIMITATIONS.md` carried the gap as an open item;
both are now closed rather than restated.

## 2. Request authentication

Exactly one credential per request. **Both kinds resolve a LOCAL, revocable
session**, which is what makes local revocation beat a provider token that has
not expired yet.

| Credential                               | Verified by                                                             | Local session                              | CSRF                              |
| ---------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------ | --------------------------------- |
| `Authorization: Bearer <provider token>` | OIDC verifier (configured issuer/audience/JWKS) + impersonation refusal | established on first use, then revalidated | n/a                               |
| `dealer_session` cookie                  | server-side session store                                               | the session itself                         | required on every non-safe method |

Both together → 401 (ambiguous). Neither → 401.

Every accepted request re-reads the whole chain from the database — never from
the token — and each fact is checked inside its effective window:

1. **tenant** — active and effective (a platform actor has none);
2. **connection** — active, effective, and still the session's connection;
3. **issuer** — the connection's, the link's, the session's and the
   **configured** value must all be the same string;
4. **organization** — the connection's and the link's must equal the session's;
5. **UserLink** — activated, effective, tenant-coherent, and carrying the
   session's provider subject;
6. **local session** — not revoked, not expired.

The UserLink lookup takes **all six identity facts** (provider, tenant,
subject, connection, issuer, provider organization). A link bound to a
different organization is invisible, so remapping an organization never hands
the new organization the old organization's account.

The CSRF token is an HMAC over the local session id keyed by
`WORKOS_COOKIE_PASSWORD`. It is delivered in the **`x-csrf-token` response
header of `GET /auth/session`** — not in the response body, which carries
identity facts only (§4) — and is required in the `x-csrf-token` request header
on every non-safe method of a cookie-authenticated request.

Finally, a cookie-authenticated request **maintains the provider session** before
it is served: when the provider access token that session last obtained is at or
near expiry, it is refreshed first (§6). The ordering is deliberate — maintenance
runs **after** the CSRF check, so a forged unsafe request cannot spend a
single-use refresh token on its way to being refused.

## 3. Authorization

```
route declares requireAction('service.ro.transition')
   ↓
policy engine  ── catalog lookup
   ↓            ── resource action?  resource id from the route param
   ↓                                 → resolve resource → rooftop (Fixed Ops port)
   ↓            ── resource-less?    location_id from body/query, if any
   ↓                                 → that rooftop IS the scope
   ↓            ── resolve ancestry — EVERY level must be active and effective
   ↓            ── load ACTIVE RoleBindings for this user (per decision)
   ↓
allow / deny  → append-only policy_decisions row (always)
```

Revocation takes effect on the next request: bindings are read per decision and
no token carries privilege. A resource-less action that names no location
reaches the whole tenant, so only a **tenant-scope** binding covers it; and
archiving any node in the chain revokes every binding scoped beneath it without
touching a `role_bindings` row.

Evidence carries ids, codes and versions only — including the **generated**
`request_id`/`correlation_id` pair the outermost middleware minted (the pair
every log line already carries), never a caller-supplied header — plus the
matched bindings with their authorization versions and the computed freshness
and MFA classifications.

## 4. `GET /auth/session` — a BOUNDED response

The body is exactly eight facts, produced by
`describeAuthenticatedSession` in `@dealer/identity-access`:

| Field                      | Meaning                                                                           |
| -------------------------- | --------------------------------------------------------------------------------- |
| `user_link_id`             | the INTERNAL user id                                                              |
| `tenant_id`                | the internal boundary, or null for a platform actor                               |
| `organization_scope`       | `actor_scope`, `tenant_effective`, each EFFECTIVE binding's scope + node liveness |
| `roles`                    | EFFECTIVE role names — the bindings the policy engine itself would match          |
| `freshness`                | `not_applicable` / `stale` / `fresh` — computed, identical to the next decision's |
| `mfa_assurance`            | `not_applicable` / `uncertified` / `certified` — likewise                         |
| `local_session_expires_at` | the LOCAL session's expiry, because that is what an operator can revoke           |
| `support_access[]`         | live support sessions for the tenant, with `granted_at` and `expires_at`          |

Nothing else. No email, no display name, no provider profile, no provider
subject, no provider session id, no access or refresh token, no refresh state,
no support reason text. The key set is asserted by test, so a field added by
accident fails CI rather than shipping a disclosure.

Response headers: `x-support-access` whenever a live support session exists
(non-suppressible), and `x-csrf-token` for a cookie-authenticated request.

## 5. Reauthentication (replaces local step-up)

```
POST /auth/reauth/start { action, qualifier?, resource? }
   ├─ policy must ALLOW the action first (otherwise reauth cannot help)
   ├─ DERIVE the starting identity SERVER-SIDE from the LIVE LOCAL SESSION:
   │  the session names its connection, the connection names the issuer and the
   │  provider organization, the UserLink names the provider subject. The route
   │  supplies no binding; what it passes is an EXPECTATION, and a disagreement
   │  REFUSES the start (nothing is written).
   ├─ GENERATE the OIDC nonce inside the same statement that stores its digest
   ├─ INSERT reauthentication_transactions (5 min): internal nonce and OIDC
   │  nonce as digests, action, resource, required assurance, and the
   │  connection / issuer / organization / subject / SESSION it started from
   ├─ seal state + PKCE + both nonces in dealer_reauth_txn
   └─ → authorization_url with max_age=0 and the nonce, redirecting to
      WORKOS_REAUTH_REDIRECT_URI

GET /auth/reauth/callback?code&state
   ├─ open the sealed cookie; exact state match
   ├─ exchange, REFUSE impersonation, VERIFY the token (nonce, times, claims)
   ├─ resolve the connection and the six-fact UserLink again
   └─ completeReauthentication, which fails closed on ANY of:
        · the internal nonce does not name a live 'started' transaction for
          this user
        · auth_time predates the transaction start beyond the configured skew
        · the digest of the returned OIDC nonce ≠ the STORED oidc_nonce_hash
          (a token that carried no nonce presents null, which matches nothing)
        · issuer, provider organization, provider subject or connection is
          MISSING or disagrees with what the transaction started from —
          absence is a failure, not a skipped comparison
        · the chain no longer holds: tenant, connection, UserLink, or the
          LOCAL SESSION the step-up started from
        · the required assurance is fresh_and_mfa_policy and the connection
          row does not certify the organization's MFA policy AT THIS INSTANT
      and otherwise mints ONE grant → { grant, expires_at }  (returned once,
      stored hashed, recording the assurance level and the certification fact)

… the caller then performs the sensitive action, passing the grant.
Consumption is atomic and INSIDE the business transaction:
   spend  ⇔ the action commits.  Rollback releases the grant.
   Replay, wrong action, wrong resource, wrong user, wrong tenant → refused.
   ASSURANCE FLOOR: a fresh_only grant can never pay for a
   fresh_and_mfa_policy operation, and a refused consumption leaves the grant
   UNSPENT.
```

A `started` transaction that cannot name its connection, issuer, organization,
subject, session **and** OIDC nonce digest is refused by CHECK
`rat_started_is_bound` — the unbound state is unrepresentable, so the nonce
comparison cannot be reached with nothing to compare.

Error code on refusal stays `step_up_required` (HTTP 403) — the external
contract survived the mechanism change.

## 6. Provider refresh and rotation

### When it happens (R3 correction C1)

`/auth/callback` takes the provider refresh token into custody on every login —
AES-256-GCM sealed ciphertext plus its replay digest — and records the `exp` of
the access token it just verified in
`identity_sessions.provider_access_token_expires_at`. That instant is what makes
the custody useful: **request authentication maintains the session before serving
it**, so the credential is actually spent instead of sitting at rest for the life
of the session.

```
cookie request  → six-fact revalidation (§2) → CSRF (unsafe methods)
                → maintainProviderSession(session)
                      refreshable?  no  → nothing happens
                      expiry known? no  → nothing happens
                      within 60s of the provider token's exp?
                          no  → nothing happens
                          yes → refreshProviderSession  (below)
                → request served on the session that survived
```

The leeway is `DEFAULT_PROVIDER_REFRESH_LEEWAY_SECONDS` (60s): a session that
only refreshed _after_ its provider credential died would have no way to consult
the provider at all. Dueness is judged twice — once before the claim, and again
**inside the claim transaction on the locked row**, because several simultaneous
requests all read "due" before any of them writes, and every one of them would
otherwise spend another single-use refresh token. A request that finds the expiry
already moved reports `not_due`, carrying back the current row.

A refresh renews the **provider** credential, not the person's local session: the
rotation is given the session's _remaining_ life, so `expires_at` never slides
forward. The local bound is the point, exactly as for a bearer session's TTL.

### What it does — three phases (R3 correction D1)

**No database transaction is held across the provider call.** R3 shipped the
opposite: `BEGIN`, `SELECT ... FOR UPDATE` on the session row, and only then
`await provider.refreshSession(...)`. The lock enforced single-spend and also
meant that a provider which **hangs** rather than errors pinned one connection of
the shared pool, inside an idle open transaction, for as long as it hung — ten due
sessions exhausted a pool of ten, and that pool serves all Fixed Ops traffic for
every tenant. Reproduced before the fix: with ten due sessions and a provider that
never answered, an unrelated `SELECT 1` failed with
`timeout exceeded when trying to connect`.

A **lease** replaces the lock:

```
1  CLAIM    short transaction: lock the row, re-judge dueness, open the sealed
            state, prove it matches the replay digest, write refresh_lease_id +
            refresh_lease_expires_at.  COMMIT — the connection goes back.
2  EXCHANGE no transaction at all: spend the refresh token at the provider under a
            HARD DEADLINE (WORKOS_REFRESH_TIMEOUT_MS, default 10s), then verify
            the replacement access token.
3  PERSIST  short transaction: lock the row, prove the lease is STILL OURS,
            re-verify the identity from the database, rotate the sealed state
            keyed on the old digest — or revoke, or release the lease.  COMMIT.
```

- **single-spend** — a second request that arrives mid-exchange sees an unexpired
  lease and does nothing (`refresh_in_flight`); it does **not** wait for the other
  request's network call, which is the whole point.
- **no wedged session** — a crashed or hung attempt leaves an **expired** lease,
  and an expired lease is not a lease: the next request reclaims it. The lease is
  derived from the attempt's own bound (`providerTimeoutMs` + the verifier's 5s
  JWKS bound + slack), so a legitimately slow attempt cannot outlive its claim.
- `auth_time` is **preserved** unless the verified token carries a genuinely newer
  one: a refresh is not an authentication event and can never fabricate freshness.
  The new `provider_access_token_expires_at` comes from that verified token and
  from nowhere else.

Two CHECK constraints in migration 057 keep the lease honest: it must carry its
expiry (`is_refresh_lease_paired`) and it must claim actual refresh state
(`is_refresh_lease_needs_state`) — which, with the revoked- and bearer-hold-no-
refresh-state constraints, makes a dead session holding a live claim
unrepresentable.

Distinguishable outcomes, because collapsing them is how a network blip becomes a
fleet-wide logout:

| Outcome             | When                                                            | Effect                    | The request               |
| ------------------- | --------------------------------------------------------------- | ------------------------- | ------------------------- |
| `refreshed`         | provider answered, identity still matches, token verified       | new sealed state, rotated | served on the new row     |
| `revoked`           | identity mismatch, definitive refusal, replay, or impersonation | session dies immediately  | **401**                   |
| `transient`         | 429, any 5xx, DNS/socket error, anything unrecognised           | **nothing changes**       | served normally           |
| `transient`         | the provider **HANGS** — the bound elapsed with no answer       | **nothing changes**       | served after the bound    |
| `unavailable`       | no sealed state, key-version mismatch, unreadable seal          | nothing changes           | served normally           |
| `unavailable`       | no live session (revoked or expired underneath the request)     | nothing to change         | **401**                   |
| `not_due`           | the locked row says another caller just refreshed               | nothing changes           | served on the current row |
| `refresh_in_flight` | another request holds an unexpired lease                        | nothing changes           | served immediately        |

The HANG row is the one R3 stated untruthfully. It was folded into "transient",
and it **is** classified transient — a bound that elapsed is not evidence that a
refresh token was revoked, so a timeout must never revoke — but the cost was not
one request waiting: it was one shared pool connection per hung exchange, held in
an open transaction. The bound makes the row true; the three-phase split makes it
cheap. `refresh_in_flight` and `not_due` both surface to the request path as
`unchanged`, because a request can do exactly one thing about either.

So a provider that cannot be reached never logs anybody out, and a provider that
says "this session is over" is believed at once. Revocation of any kind clears the
sealed state, its replay digest **and any lease** in the same statement that sets
`revoked_at` — migration 057 makes the alternative unrepresentable.

A **bearer** session never enters any of this: the caller presents its own access
token on every request, so the platform takes custody of no provider credential
there and holds neither refresh state nor an access-token expiry (two CHECK
constraints in migration 057 make both unrepresentable).

## 7. Support access (never impersonation)

```
platform_support files a request  → tenant, actions, scope, reason, ≤60 min
   · the requester must be a CURRENT active platform-support (or platform_admin)
     actor at platform scope; nobody else can file
tenant_admin of the TARGET tenant → approve or deny
   · authority is checked BEFORE anything else, and is required for a denial too
   · requester ≠ approver (also a table CHECK)
   · an APPROVAL additionally requires the approver's OWN consumed grant minted
     at fresh_and_mfa_policy against a certified connection
   · an APPROVAL also re-checks that the REQUESTER still holds that
     platform-support binding. If not, it is refused, the request stays pending,
     and the approver's single-use grant is NOT spent. A DENIAL is not gated
     this way — disposing of a stale request extends nobody's reach
approve → session (≤60 min by CHECK, no renewal)
   · starting the session re-checks the requester's binding once more
policy decisions for that actor   → ALLOW_SUPPORT_SESSION, evidence carries
                                     support_session_id and support_request_id
   · EVERY decision re-reads the actor's platform-support binding. Revoked or
     out of window → deny SUPPORT_ACTOR_UNAUTHORIZED, so revoking the binding
     is sufficient offboarding on its own
every response under it           → x-support-access header
GET /auth/session                 → support_access[] for the tenant
revoke                            → by a tenant admin of that tenant, or by the
                                     support actor ending their own session;
                                     denied on the next decision
```

The support person stays the actor in context, logs, evidence and audit. The
reason text lives in the request row and never enters ordinary logs or audit
details.

## 8. Logout and revocation

`POST /auth/logout` is a **local** act on both credential kinds:

- cookie: the server-side session is revoked and the cookie is cleared with the
  same attributes it was set with (`Max-Age=0`, Path, HttpOnly, SameSite, and
  Secure whenever Secure was set — a clearing cookie that drops Secure is a
  no-op for the cookie it is meant to replace);
- bearer: the local session resolved for that token is revoked, so the very
  next request with the same still-provider-valid token is refused.

The response carries the provider logout URL built from the **provider's**
session id (`sid`), never the local session id — handing the provider our own
identifier would produce a URL that ends nothing.

Local revocation is authoritative and needs no provider round trip: suspending
the tenant, disabling the connection, changing its issuer, deactivating the
link or revoking the session each denies the very next request.

## 9. Impersonation is refused, not merely unused

WorkOS impersonation must stay OFF in the dashboard, and the platform does not
depend on that being true. Three carriers are recognised — the RFC 8693 `act`
claim, a provider `impersonator` object, and `authentication_method =
'Impersonation'` — and any one of them refuses the credential on every path:
bearer authentication, login callback, reauthentication callback, and provider
refresh (which additionally revokes the session). The impersonator's email is
examined only to record that one existed; the value never crosses the verifier
boundary, so it cannot reach a log, a response or the database.

To verify: present a token carrying any of the three carriers and confirm a
neutral 401 with no impersonator identity in the body. `tests/auth.test.ts`
does exactly that on the bearer path, and `tests/identity-boundary.test.ts`
covers the refresh path and the verifier's classification.
