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
   granted by logging in, and a login never activates a link**. FBL-020 ships
   the `identity.*` actions and the engine that decides them but **no HTTP
   administration route** — further grants are made by calling the owned
   mutation services in `@dealer/identity-access` (`provisionUserLink`,
   `activateUserLink`, `grantRole`, …), never by raw SQL, until a later order
   adds that surface. See the tenant bootstrap runbook §4 and its R3 section.

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
| `WORKOS_REFRESH_TIMEOUT_MS`        | optional, default 10000 (500–60000)                                    |

The process refuses to start if any of these is missing while
`IDENTITY_PROVIDER=workos`, and refuses plain http URLs when
`NODE_ENV=production`.

`WORKOS_REFRESH_TIMEOUT_MS` (R3 correction D1) is the **hard bound on a provider
refresh exchange**, which happens on the live request path. Expiry is classified
TRANSIENT: the local session survives untouched and the request is still served,
so lowering it trades refresh opportunities for latency — never logouts. Because
the SDK offers no per-call deadline, the value also configures the client, so it
bounds the login code exchange too (the SDK's own default is 60s).

Two database bounds back it up, and they are **not** identity-specific — they
apply to every pooled connection in the process:

| Variable                            | Value                                                                                 |
| ----------------------------------- | ------------------------------------------------------------------------------------- |
| `PG_STATEMENT_TIMEOUT_MS`           | optional, default 30000; 0 disables. Caps ANY single statement, lock waits included   |
| `PG_IDLE_IN_TRANSACTION_TIMEOUT_MS` | optional, default 15000; 0 disables. Caps an OPEN transaction that is running nothing |

The second one is the floor under exactly the defect D1 fixed: a transaction left
idle around an untimed network call, holding one of `PGPOOL_MAX` shared
connections. The migration runner exempts itself per-transaction
(`SET LOCAL … = 0`), so DDL and long backfills are never interrupted.

**What you will see when either bound fires (R3-G1).** They fail differently, and
both cost one request and nothing more:

| Bound                               | Postgres answer                             | What the caller gets                                                                 |
| ----------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------ |
| `PG_STATEMENT_TIMEOUT_MS`           | ERROR `57014`, connection stays open        | The operation's own error; the connection is reused                                  |
| `PG_IDLE_IN_TRANSACTION_TIMEOUT_MS` | FATAL `25P03`, server closes the connection | `503 database_connection_lost`, retryable; that connection is discarded and replaced |

Log line to look for: `connection_lost_in_transaction` from `database.pool`, with
`err.code` `25P03`. It is transient infrastructure, **not** an authentication or
authorization event — it never revokes a session, never consumes a step-up grant,
and never appears as a denied policy decision. If you see it repeatedly, a caller
is holding a transaction open across non-database work; find that caller rather
than raising the bound.

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

Find them, then set the value through the owned mutation service so the change
has a true actor, an advancing `authorization_version` and an audit row:

```sql
SELECT connection_id, tenant_id, status FROM identity_provider_connections
 WHERE issuer = 'urn:fbl-020-r1:issuer-unset';
```

```ts
import { changeProviderIssuer } from '@dealer/identity-access';

await changeProviderIssuer({
  actingUserLinkId: '<the operator’s user_link_id>',
  connectionId: '<connection_id>',
  issuer: 'https://<your-env>.authkit.app',
});
```

Do **not** `UPDATE identity_provider_connections` by hand: a raw update relocates
the trust anchor with no actor, no version bump and no audit row.

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
is **not** implied by a fresh `auth_time`. Record it through
`certifyProviderMfaPolicy` — see the R3 section below for the exact call and for
how to verify the real WorkOS policy first. Raw SQL is not a sanctioned path.

Withdrawing it (`certified: false`) immediately stops new high-assurance grants:
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

---

## R3 corrections (FBL-020-R3) — the operator procedures, restated once

This section supersedes the R2 section above wherever they differ. Everything
here describes the implementation as it stands; nothing is aspirational.

### Both redirect URIs, exactly as deployed

| Leg              | Variable                     | URI                                   |
| ---------------- | ---------------------------- | ------------------------------------- |
| Login            | `WORKOS_REDIRECT_URI`        | `https://<host>/auth/callback`        |
| Reauthentication | `WORKOS_REAUTH_REDIRECT_URI` | `https://<host>/auth/reauth/callback` |

WorkOS matches exactly — no wildcards, no trailing-slash drift. Registering only
the login one strands every `max_age=0` leg at a route that reads a different
transaction cookie, and no grant can be minted. Register the logout return URL
(`WORKOS_LOGOUT_REDIRECT_URI`) too.

To verify: start a step-up and read the `authorization_url` in the response. It
must carry `max_age=0`, a `nonce`, and a `redirect_uri` pointing at
`/auth/reauth/callback`.

### Verifying the REAL organization MFA policy

The platform cannot observe WorkOS policy on its own, so the live gate has to
look. For the organization under test:

1. In the WorkOS dashboard, open the Organization and confirm that MFA is
   **required** for it (not merely available, and not merely enabled for the
   environment).
2. Confirm it applies to the authentication method the dealership's staff
   actually use — a policy that only covers a method nobody uses proves nothing.
3. Take the evidence as **identifiers and settings**, never a session transcript:
   the `org_...` id, the policy state, the date, and who checked. See
   "Sanitized Gate B evidence" below.

Only after that observation is the local certification honest.

### Recording, renewing, revoking and expiring local certification

`mfa_policy_certified` is an **operator assertion** that the mapped WorkOS
organization is configured MFA-required. It is dated and attributable, and it is
**not** implied by a fresh `auth_time`.

Record or renew it through the owned mutation service, so the change has a true
actor, an advancing `authorization_version` and an audit row in the same
transaction:

```ts
import { certifyProviderMfaPolicy } from '@dealer/identity-access';

await certifyProviderMfaPolicy({
  actingUserLinkId: '<the operator’s user_link_id>',
  connectionId: '<connection_id>',
  certified: true, // false withdraws it
});
```

Do **not** `UPDATE identity_provider_connections` by hand. A raw update sets the
flag with no actor, no version bump and no audit row — the three things that make
a certification a certification rather than a boolean somebody flipped.

| Act    | How                                           | Effect                                                                                           |
| ------ | --------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Record | `certifyProviderMfaPolicy(… certified: true)` | High-assurance grants become mintable; the date and the certifying operator are stored           |
| Renew  | the same call again                           | Re-stamps the date and the actor. **Re-certify whenever the WorkOS organization policy changes** |
| Revoke | `… certified: false`                          | Clears the date; new high-assurance grants stop immediately                                      |
| Expire | close the connection's effective window       | The connection stops resolving at all, which denies the next request on that connection          |

Withdrawal is immediate for **new** grants: money-affecting Fixed Ops operations
and support approvals both require `fresh_and_mfa_policy`, and the completion
re-reads the certification from the connection row at that instant. A grant
already minted records `mfa_policy_certified_at_issue` and remains spendable
until it expires or is consumed — its assurance is a fact about when it was
issued, and rewriting history is not on offer.

To verify: with the certification withdrawn, a `fresh_and_mfa_policy` step-up
completes to **nothing** (no grant row appears); with it recorded, exactly one
grant appears. `POST /auth/reauth/start` also echoes `mfa_policy_certified` so an
operator can see the current state without a database query.

### Nonce-bound login and reauthentication

Both legs mint a cryptographically random OIDC nonce, send it on the
authorization request, and require the corresponding claim back:

- **Login** stores the nonce as a digest on the `login_transactions` row, and the
  claim that moves the row `pending → consuming` is conditional on that digest —
  so a replay, a tampered cookie and an unknown state are one indistinguishable
  failure decided by the database.
- **Reauthentication** stores the nonce as `oidc_nonce_hash`, generated by the
  server inside the same statement, and the completion compares the digest of the
  returned claim against **that stored digest**. A token carrying no nonce
  presents nothing, which matches nothing.

The raw nonce is never logged, never returned and never stored. To verify: a
completion whose stored digest has been altered mints nothing and leaves the
transaction terminally `failed` (`tests/reauthentication.test.ts` asserts
exactly this).

### Provider refresh and rotation

The refresh token is stored as AES-256-GCM ciphertext plus a separate replay
digest, and a refresh spends it and persists its replacement keyed on the old
digest — so a replayed refresh token changes nothing and rotates nothing.
`auth_time` is preserved: a refresh is not an authentication event and cannot
manufacture freshness.

| Outcome       | Operator reading                                                                                                                          |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `refreshed`   | normal; `refresh_rotation_count` incremented                                                                                              |
| `revoked`     | a security fact — identity mismatch, definitive refusal, replay, or impersonation. The session is gone and its refresh credential with it |
| `transient`   | the provider hiccuped; **nothing changed**. Do not escalate to a mass logout                                                              |
| `unavailable` | not refreshable (no sealed state, or the cookie password was rotated). The session still works until it expires                           |

Rotating `WORKOS_COOKIE_PASSWORD` invalidates every live cookie session, every
outstanding sealed transaction, and makes existing sealed refresh state
unreadable — reported as `unavailable`, never as a breach. Announce it; users
re-login.

### Local and provider logout, and logout denial

`POST /auth/logout` is a LOCAL act and works on **both** credential kinds:

- a cookie session is revoked and the cookie is cleared with the same attributes
  it was set with (dropping `Secure` on the clearing cookie would make the clear
  a no-op);
- a bearer credential's local session is revoked, so the very next request with
  the same, still-provider-valid access token is refused.

The response returns the provider logout URL built from the **provider's** `sid`.
Local revocation is authoritative and needs no provider round trip.

To verify logout denial: authenticate with a bearer token, call
`POST /auth/logout`, then repeat the original request with the **same** token —
it must be 401 without waiting for the token to expire.
`tests/auth.test.ts` proves this deterministically.

### Impersonation: disabling it, and verifying that it is off

1. In the WorkOS dashboard, ensure impersonation is **disabled** for the
   environment and that no staff member has it available.
2. Do not rely on step 1. The platform refuses an impersonated authentication on
   every credential path — bearer, login callback, reauthentication callback —
   and a refresh that returns one revokes the local session immediately. Three
   carriers are recognised: the RFC 8693 `act` claim, a provider `impersonator`
   object, and `authentication_method = 'Impersonation'`.
3. To verify, present a token carrying any of those three and confirm a neutral
   401 whose body names no impersonator. The impersonator's email is classified
   and dropped inside the verifier, so it cannot appear in a log, a response or
   the database.

Support staff enter a tenant through **support access** (ADR-008) and stay
themselves throughout. There is no sanctioned impersonation path.

### Administration has no HTTP surface yet

FBL-020 ships the `identity.*` / `org.unit.*` actions and the engine that decides
them, but no route declares them. Provisioning, activation, grants, revocations,
certifications and support decisions are performed by calling the owned mutation
services in `@dealer/identity-access` — `provisionUserLink`, `activateUserLink`,
`deactivateUserLink`, `relinkUserLink`, `grantRole`, `changeRole`, `revokeRole`,
`certifyProviderMfaPolicy`, `changeProviderIssuer`, `remapProviderConnection`,
`decideSupportAccess`, `revokeSupportSession` — each of which requires an
existing acting user link, advances the applicable `authorization_version`, and
writes its audit row in the same transaction. **Raw SQL against `role_bindings`
or `identity_provider_connections` is not a sanctioned path**, because it
bypasses all three.

### Issuer binding, and issuer drift

Every provider connection records the issuer its tokens must carry, and every
request compares the verified token issuer against it. Migration 057 disabled
any connection whose issuer could not be stated and stamped a sentinel, so it
authorizes nothing until an operator sets the real value and re-enables it — do
that through `changeProviderIssuer`, not by hand.

`scripts/bootstrap-identity.ts` requires `--issuer` and **refuses issuer drift**:
re-running it against an existing mapping with a different issuer aborts before
any write, in dry-run and in `--apply` alike. Relocating a live tenant's trust
anchor is a deliberate decision, not a side effect of a re-run.

### Sanitized Gate B evidence

Live-gate evidence is a report about identifiers and outcomes, not a transcript.
**Never** paste an access token, a refresh token, an authorization code, a
nonce, a cookie value, a session token, a grant, an API key, a provider profile
or an end-user email into a ticket, a log, a screenshot or an evidence bundle.

Quote instead: `user_link_id`, `connection_id`, `provider_organization_id`,
`reauth_txn_id`, `login_txn_id`, `support_session_id`, the
`request_id`/`correlation_id` pair, the HTTP status, and the row states you
observed. Those reconstruct any flow from the platform's own evidence tables and
disclose nothing if the bundle leaks. Support **reason text** stays in its
request row and belongs in no report.
