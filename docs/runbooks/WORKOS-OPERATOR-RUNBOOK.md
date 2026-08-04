# WorkOS Operator Runbook (FBL-020)

Everything an operator does in the WorkOS dashboard and in this repository to
put a real login in front of the platform. Nothing here is required for CI,
local development, migrations or the test suite: with `IDENTITY_PROVIDER`
unset the /auth surface simply does not serve.

## 1. One-time platform setup

1. Create the WorkOS environment (staging first). Note the **Client ID** and
   **API key**.
2. Enable AuthKit. Under authentication methods choose what staff will use;
   enable MFA for organizations that need high-assurance actions
   (reauthentication with `max_age=0` is only as strong as the factor behind it).
3. Configure **both redirect URIs** exactly as deployed:
   `https://<host>/auth/callback` (login) **and**
   `https://<host>/auth/reauth/callback` (reauthentication). WorkOS matches
   exactly — no wildcards, no trailing-slash drift. Registering only the login
   one strands every `max_age=0` reauthentication leg at the wrong route, and
   no grant can be minted. Add the logout return URL too.
4. Record the issuer and JWKS URL for the environment. These become
   `WORKOS_ISSUER` and `WORKOS_JWKS_URI` and are the **only** trust anchors —
   this platform never derives them from a token.
5. Decide the audience value and set `OIDC_AUDIENCE`; configure WorkOS to
   issue it.

## 2. Per-tenant onboarding

1. Create a WorkOS **Organization** for the dealership. Note its `org_...` id.
2. Invite the first administrator into that organization.
3. Run the bootstrap (dry-run first — it writes nothing without `--apply`):

```bash
DATABASE_URL=... npx tsx scripts/bootstrap-identity.ts \
  --tenant-id <uuid> --tenant-name "Delta Motors" \
  --provider-org org_... --admin-user user_... --admin-email admin@dealer.com
```

Review the printed plan, then re-run with `--apply`. It is idempotent, it
refuses ambiguous mappings (an organization already bound to another tenant, or
a tenant already bound to another organization), and it prints no credentials.

4. The bootstrapped administrator holds `tenant_admin` at tenant scope. Every
   further person is provisioned by that administrator; **no role is ever
   granted by logging in**. Note that FBL-020 ships the `identity.*` actions
   and the engine that decides them but **no HTTP administration route** —
   further grants are made directly against `role_bindings` until a later
   order adds that surface. See the tenant bootstrap runbook §4.

## 3. Configuration checklist

| Variable                           | Value                                                                  |
| ---------------------------------- | ---------------------------------------------------------------------- |
| `IDENTITY_PROVIDER`                | `workos`                                                               |
| `WORKOS_CLIENT_ID`                 | from the dashboard                                                     |
| `WORKOS_API_KEY`                   | from the dashboard (≥32 chars)                                         |
| `WORKOS_ISSUER`, `WORKOS_JWKS_URI` | environment issuer + key set (https in production)                     |
| `WORKOS_REDIRECT_URI`              | exactly the registered LOGIN callback (https in production)            |
| `WORKOS_REAUTH_REDIRECT_URI`       | exactly the registered REAUTHENTICATION callback (https in production) |
| `WORKOS_LOGOUT_REDIRECT_URI`       | where logout returns (https in production)                             |
| `WORKOS_COOKIE_PASSWORD`           | ≥32 random chars — seals cookies AND derives CSRF tokens               |
| `OIDC_AUDIENCE`                    | the audience WorkOS issues                                             |
| `OIDC_CLOCK_SKEW_SECONDS`          | optional, default 60, max 300                                          |

The process refuses to start if any of these is missing while
`IDENTITY_PROVIDER=workos`, and refuses plain http URLs when
`NODE_ENV=production`.

## 4. Key rotation

WorkOS rotates signing keys on its own schedule. Nothing to do: the verifier
caches the JWKS, refetches once (cooldown-bounded) when it sees an unknown
`kid`, and picks up new keys without a restart. A JWKS outage fails **closed** —
requests are refused, never waved through.

Rotating `WORKOS_COOKIE_PASSWORD` invalidates every live cookie session and
every outstanding sealed transaction. Announce it; users re-login.

## 5. Incident actions

| Situation              | Action                                                                                                         |
| ---------------------- | -------------------------------------------------------------------------------------------------------------- |
| One person compromised | Deactivate the user link — sessions die at the next request, and login is refused                              |
| Role granted in error  | Revoke the binding — the very next decision denies                                                             |
| Tenant compromised     | Set the tenant `suspended`; every decision denies `TENANT_INACTIVE`                                            |
| Support session misuse | Revoke the support session; check `policy_decisions` filtered by its id                                        |
| Suspected token issue  | Nothing to revoke locally — tokens are provider-issued and short-lived; suspend at WorkOS and deactivate links |

## 6. What is NOT enabled

SAML SSO and SCIM directory sync are **interfaces only** (ADR-006, §Federation).
The database refuses any provider other than `workos`, so there is no
configuration that turns them on. Enabling them is a separate order.

---

## R2 corrections (FBL-020-R2, Blueprint §14.3)

### Issuer binding is mandatory

Every provider connection records the **issuer** its tokens must carry, and
every request compares the verified token issuer against it. A connection
whose issuer you cannot state is not a connection — migration 057 disabled
any that existed and stamped a sentinel issuer, so they authorize nothing
until an operator sets the real value and re-enables them.

```sql
UPDATE identity_provider_connections
   SET issuer = 'https://<your-env>.authkit.app', status = 'active'
 WHERE tenant_id = :tenant AND issuer = 'urn:fbl-020-r1:issuer-unset';
```

### Both redirect URIs

Register **both**, exactly as deployed:

| Leg              | URI                                   |
| ---------------- | ------------------------------------- |
| Login            | `https://<host>/auth/callback`        |
| Reauthentication | `https://<host>/auth/reauth/callback` |

Registering only the first strands every `max_age=0` leg at the wrong route.

### Explicit link activation

Login **never** activates an identity. A first login records a PENDING link
and issues no session. An administrator activates it explicitly, and
activation binds the link to exactly one active connection — if the tenant
has zero or more than one, activation is refused rather than guessing.

### MFA certification lifecycle

`mfa_policy_certified` is an operator assertion that the mapped WorkOS
organization is configured MFA-required. It is dated and attributable, and it
is **not** implied by a fresh `auth_time`.

```sql
UPDATE identity_provider_connections
   SET mfa_policy_certified = TRUE,
       mfa_policy_certified_at = NOW(),
       mfa_policy_certified_by_user_link_id = :operator
 WHERE tenant_id = :tenant;
```

Withdrawing it (`FALSE`) immediately stops new high-assurance grants:
money-affecting Fixed Ops operations and support approvals both require
`fresh_and_mfa_policy`, and a `fresh_only` grant is refused at consumption.

**Re-certify whenever the WorkOS organization policy changes.** The platform
cannot observe that change on its own.

### Impersonation is disabled by design

WorkOS impersonation is not used and must stay off. If a refresh or token
verification ever returns a different subject, organization or issuer than
the session was established with, the local session is revoked immediately —
there is no degraded mode.

### Refresh rotation

Refresh state is stored only as a digest and rotates on every successful
refresh. A replayed refresh token changes nothing. Rotating
`WORKOS_COOKIE_PASSWORD` still invalidates live cookie sessions and
outstanding transactions.

### Logout and revocation

`POST /auth/logout` revokes the server-side session and returns the provider
logout URL. Local revocation is authoritative: disabling the tenant, the
connection, or the user link denies the very next request with the same
credential — no restart, no waiting for expiry.

### Sanitized evidence

Policy evidence carries ids, codes and versions only. Support reason text
lives in the request row and never enters ordinary logs. Do not paste tokens,
nonces, cookies or authorization codes into tickets when reporting an issue.
