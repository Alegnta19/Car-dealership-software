# Authentication, Reauthentication and Support Flows (FBL-020)

## 1. Login (browser)

```
GET /auth/login?return_to=/somewhere
   ├─ mint state + PKCE verifier, seal both in dealer_auth_txn (HttpOnly, /auth, 10 min)
   └─ 302 → WorkOS AuthKit (Code + PKCE, S256)

GET /auth/callback?code&state
   ├─ open sealed cookie; state must match exactly, else 401 (cookie cleared)
   ├─ exchange code + verifier at the provider
   ├─ VERIFY the access token: configured issuer, audience, asymmetric alg,
   │  kid from the configured JWKS, exp/iat/auth_time, bounded skew
   ├─ org_id → identity_provider_connections (ACTIVE only) → internal home
   ├─ UserLink: pending → activated, or created activated — with ZERO roles
   ├─ create identity_session (opaque value; only its SHA-256 is stored)
   └─ 302 → return_to (relative-path allowlist; anything else → "/")
```

Failures are a neutral 401: an unknown organization, an unknown identity and a
deactivated identity are externally indistinguishable.

## 2. Request authentication

Exactly one credential per request:

| Credential                               | Verified by                                     | CSRF                                               |
| ---------------------------------------- | ----------------------------------------------- | -------------------------------------------------- |
| `Authorization: Bearer <provider token>` | OIDC verifier (configured issuer/audience/JWKS) | n/a                                                |
| `dealer_session` cookie                  | Server-side session store                       | required on every non-safe method (`x-csrf-token`) |

Both together → 401 (ambiguous). Neither → 401.

The CSRF token is an HMAC over the session id keyed by
`WORKOS_COOKIE_PASSWORD`, served by `GET /auth/session`.

## 3. Authorization

```
route declares requireAction('service.ro.transition')
   ↓
policy engine  ── catalog lookup ── resource id from the route param
   ↓            ── resolve resource → rooftop (Fixed Ops port)
   ↓            ── resolve ancestry (organization)
   ↓            ── load ACTIVE RoleBindings for this user (per decision)
   ↓
allow / deny  → append-only policy_decisions row (always)
```

Revocation takes effect on the next request: bindings are read per decision
and no token carries privilege.

## 4. Reauthentication (replaces local step-up)

```
POST /auth/reauth/start { action, qualifier?, resource? }
   ├─ policy must ALLOW the action first (otherwise reauth cannot help)
   ├─ open reauthentication_transaction (nonce hashed at rest, 5 min)
   ├─ seal state + PKCE + nonce in dealer_reauth_txn
   └─ → authorization_url with max_age=0 (forces a fresh provider auth event)

GET /auth/reauth/callback?code&state
   ├─ open sealed cookie; exact state match
   ├─ exchange + VERIFY the token
   ├─ require auth_time ≥ transaction start − bounded skew
   │     (a stale auth_time marks the transaction failed and mints nothing)
   └─ mint ONE grant → { grant, expires_at }   ← returned once, stored hashed

… the caller then performs the sensitive action, passing the grant.
Consumption is atomic and INSIDE the business transaction:
   spend  ⇔ the action commits.  Rollback releases the grant.
   Replay, wrong action, wrong resource, wrong user, wrong tenant → refused.
```

Error code on refusal stays `step_up_required` (HTTP 403) — the external
contract survived the mechanism change.

## 5. Support access (never impersonation)

```
platform_support files a request  → tenant, actions, scope, reason, ≤60 min
tenant_admin (a DIFFERENT user)   → approve → session (≤60 min, structural)
policy decisions for that actor   → ALLOW_SUPPORT_SESSION, evidence carries
                                     support_session_id
every response under it           → x-support-access header
GET /auth/session                 → support_access[] for the tenant
revoke                            → denied on the next decision
```

The support person stays the actor in context, logs, evidence and audit. The
reason text lives in the request row and never enters ordinary logs.

## 6. Logout

`POST /auth/logout` revokes the server-side session, clears the cookie
(`Max-Age=0`) and returns the provider logout URL for the browser to visit.
