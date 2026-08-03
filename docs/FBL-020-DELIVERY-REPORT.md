# FBL-020 — Identity and Organization v1: Delivery Report

**Status: CODE COMPLETE — LIVE CERTIFICATION PENDING.**
Gate A (code + deterministic CI) is closed. Gate B (live WorkOS certification)
is **not** attempted: no live WorkOS credentials exist in this environment.
FBL-030 has not been started.

|                              |                                                                                                                         |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Base (FBL-010 accepted head) | `7cb1044`                                                                                                               |
| Delivered head               | see §9 (FBL-020-R0 correction wave)                                                                                     |
| Commits                      | 11                                                                                                                      |
| Diff                         | 102 files, +13,543 / −2,814                                                                                             |
| CI run                       | [30823396770](https://github.com/Alegnta19/Car-dealership-software/actions/runs/30823396770) — **conclusion `success`** |

## 1. CI evidence (the run's own conclusion, per job)

| Job                                              | Conclusion |
| ------------------------------------------------ | ---------- |
| typecheck, lint ratchet, build, all tests, scans | success    |
| upgrade from earliest retained schema fixture    | success    |
| container build (digest-pinned base)             | success    |
| secret scan (genuine full history)               | success    |

From the run's own artifacts:

- **Tests in CI: 204 passed / 0 failed / 0 skipped / 0 cancelled** (22 suites).
- **Schema fingerprint equality, measured in CI** (the only authoritative
  comparison):
  `fresh = upgraded = c43ff9bfbdbdcd730bc63b89ac669dc38f1dbf3cb8be5c36cfcfc823c8fe1859`,
  `equal=true`, 40 tables (26 pre-existing + 14 new).
  **This supersedes the previous authoritative fingerprint
  `40420288…`**, which described the pre-055 schema.
- **Backfill reconciliation in CI**: legacy tenant parity complete, every
  tenant `pending_configuration`, rooftop parity complete
  (`rooftop_id = legacy location_id`), ancestry intact, and all nine identity
  tables (`user_links`, `identity_sessions`, `role_bindings`,
  `identity_provider_connections`, `policy_decisions`,
  `reauthentication_transactions`, `reauthentication_grants`,
  `support_access_requests`, `support_access_sessions`) **empty** — the
  migration invented no identities.
- Legacy seed rows survived the upgrade; both NOT VALID constraints remain
  NOT VALID.
- Migration idempotence: second run `applied=0`.
- `npm audit`: 0 vulnerabilities at every severity.
- Toolchain: node `v20.20.2`, npm `10.8.2`, tsc `5.9.3`, eslint `10.8.0`,
  prettier `3.9.6`, postgres image digest-pinned.

## 2. Independent verification outside CI

| Gate                                                            | Windows   | Linux / Node 20.20.2 (WSL parity, real PostgreSQL 16) |
| --------------------------------------------------------------- | --------- | ----------------------------------------------------- |
| Full battery (after FBL-020-R0)                                 | 216 / 216 | **216 / 216**                                         |
| Build (`tsc -b`)                                                | 0         | 0                                                     |
| Architecture checks (dependency, app-SQL, manifest, env-access) | 4 / 4 OK  | 4 / 4 OK                                              |
| Quality ratchet                                                 | OK        | OK                                                    |

Local fresh-vs-upgraded fingerprints also matched (`cda982e3…` on the local
Windows PostgreSQL build) — recorded as corroboration only; catalog text
differs across PostgreSQL builds, so **only the in-CI comparison is
authoritative**.

## 3. Quality baselines — TIGHTENED at closure

| Dimension  | Ceiling (order) | Before | Now     |
| ---------- | --------------- | ------ | ------- |
| tsc-strict | ≤ 59            | 59     | **53**  |
| eslint     | ≤ 136           | 136    | **125** |
| format     | ≤ 23            | 23     | **1**   |

Never raised. The reduction comes from deleting `platform/src/jwt.ts`,
`fixed-ops/src/security/step-up.ts` and `tests/step-up.test.ts`, plus
formatting the new code to zero debt.

## 4. What was built (by order requirement)

1. **OIDC verification** (`packages/identity-access/src/oidc/token-verifier.ts`,
   jose): configured issuer/audience/JWKS only; asymmetric allowlist that
   **refuses to construct** with `HS*` or `none`; `kid` resolved solely through
   the configured JWKS; `exp`/`iat`/`sub`/`sid`/`auth_time` required; bounded
   skew; cached JWKS with cooldown-bounded single refresh on unknown `kid` and
   concurrent-refresh dedup; rotation without restart; fail closed on outage.
2. **Provider roles are display hints only.** `VerifiedAccessToken` exposes
   `roleHints` and nothing authorization reads. The policy engine has no
   parameter through which token content could reach a decision.
3. **Central policy engine** (`policy.ts`): deny by default; RoleBindings read
   from the database on **every** decision (revocation effective on the next
   request); scope covers descendants; cross-tenant denied before any lookup;
   `platform_admin` has no implicit dealership access; **every** decision writes
   an append-only `policy_decisions` row (ids/codes/versions, `details` always
   `{}`).
4. **Routes declare actions, not roles.** All 44 `/api/service` routes now use
   `requireAction('<catalog action>')`. Fixed Ops publishes the 44-action
   service catalog; identity-access publishes the 10-action administration
   catalog; the scope-resolver port is implemented in Fixed Ops and composed in
   the API. The reverse dependency (identity-access → fixed-ops) remains
   prohibited and is enforced by dependency-cruiser.
5. **Non-enumeration**: resource-scoped denials render the existing not-found
   envelope. Cross-tenant and nonexistent are asserted to produce the identical
   response.
6. **Reauthentication replaces local step-up**: `max_age=0`, single-use
   transactions, `auth_time`-after-start proof with bounded skew (a stale
   `auth_time` marks the transaction failed and mints nothing), grants stored
   only as SHA-256 digests, bound to tenant + user + action + resource, atomic
   consumption on the caller's transaction (rollback releases the grant, replay
   fails closed). `platform/src/jwt.ts` and `fixed-ops/src/security/step-up.ts`
   are **deleted**; the external error code `step_up_required` is preserved.
7. **Support access, never impersonation**: the platform-support person remains
   the actor everywhere; requester ≠ approver is a database CHECK; ≤ 60 minutes
   is a database CHECK; revocation is effective on the next decision; the
   indicator surfaces via `x-support-access` on every response served under it,
   via `GET /auth/session`, and via the `support_session_id` on each policy
   decision; reason text never leaves the request row.
8. **Six `/auth` routes** outside `/api/service` with Code+PKCE, single-use
   state, sealed AES-256-GCM transaction cookies, relative-path return
   allowlist, HttpOnly/SameSite=Lax/host-only cookies (Secure in production),
   CSRF on every non-safe method for cookie auth, and **bearer + cookie
   rejected as ambiguous**.
9. **UserLink** activates with zero roles; the bootstrap command is dry-run by
   default, idempotent, audited, refuses ambiguous mappings, prints no
   credentials.
10. **Migration 055**: one forward-only migration, 14 tables, tenant-qualified
    uniqueness from the first migration, composite `(tenant_id, parent_id)`
    foreign keys, append-only trigger on policy evidence, catalog-driven
    additive backfill that fails loudly if one `location_id` spans two tenants.
11. **Configuration**: `IDENTITY_PROVIDER=workos|disabled`; every `WORKOS_*` /
    `OIDC_*` variable required and validated when workos is selected; HTTPS
    enforced in production; **no WorkOS credential is needed for CI** (the
    deterministic local issuer stands in); `JWT_SECRET`/`STEP_UP_SECRET` removed
    from the config surface, `.env.example`, compose and CI.
12. **Preserved**: 44 `/api/service` routes, envelopes, error codes. The only
    changes are the two authorized ones (HS256 removal, documented
    non-enumeration) plus one new code `csrf_required`, documented in the §14
    appendix.
13. **SAML/SCIM are interfaces only**: every operation throws
    `FederationNotEnabled`, the SCIM port exposes no role-granting operation,
    and migration 055's provider CHECK refuses `saml`/`scim`/`okta` rows —
    there is no configuration or code path that enables them.

## 5. Defects we found in our own delivery, and fixed (FBL-020-R0)

The first pass was pushed and CI-green, then put through a seven-dimension
adversarial review in which each finding had to survive an independent skeptic.
**28 findings were raised, 10 were refuted, 18 were confirmed** (13 distinct
defects after deduplication). All are fixed here. They are listed in full
because a green CI run did not catch a single one of them, and that is the
useful thing to know.

### Found by the end-to-end journey while writing it

- `service.ro.transition` demanded a reauthentication grant for the
  `authorized` / `canceled` transitions while the action catalog did not mark
  it `sensitive`, so `POST /auth/reauth/start` refused to open a transaction
  for the very action that needed one — a dead end reachable by any advisor.

### Found by the adversarial review

| #   | Severity | Defect                                                                                                                                                                                                                                                                                                                                                                                                                       | Fix                                                                                                                                                                                                                                                                              |
| --- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **HIGH** | **Privilege escalation.** `covers()` ignored binding scope entirely for every resource-less action, so a binding scoped to ONE rooftop authorized 13 of the 44 service actions across the WHOLE tenant (create appointments/ROs anywhere, dispatch onto any rooftop's work, read every queue). The same file already applied the correct, narrower rule to support sessions.                                                 | Resource-less actions now carry a **scope hint** (the request's `location_id`, which migration 055 made the rooftop id). A hint is resolved and must be covered like a resource; with no hint the action is genuinely tenant-wide and **only a tenant-scope binding covers it**. |
| 2   | **HIGH** | **Reauthentication could never complete in production.** The `max_age=0` authorization URL carried the LOGIN `redirect_uri`, so the provider returned the browser to `/auth/callback`, which reads a different transaction cookie and 401s. `GET /auth/reauth/callback` had no reachable caller, no grant could ever be minted, and every gated transition and staff-attested authorization would have been permanently 403. | The port takes a per-flow `redirectUri`; a new required `WORKOS_REAUTH_REDIRECT_URI` is configured, documented and registered separately in WorkOS.                                                                                                                              |
| 3   | **HIGH** | **Archived organization nodes still authorized.** `resolveAncestry` filtered on ids only — no status, no effective window — so archiving a rooftop revoked nothing, and a still-`pending_configuration` backfilled node authorized immediately, contradicting migration 055's own header. `isEffectiveAt()` had zero production callers.                                                                                     | Every level of the chain must now be `active` and inside its effective window; one retired ancestor breaks the chain and the engine denies.                                                                                                                                      |
| 4   | **HIGH** | The journey's "callback-equivalent" helper opened a **second** reauthentication transaction and completed that, so it proved nothing about the transaction the route actually opened.                                                                                                                                                                                                                                        | The journey now opens the **sealed cookie the route set**, extracts the real nonce, completes THAT transaction, and asserts exactly one transaction and one grant exist.                                                                                                         |
| 5   | MEDIUM   | `platform_admin` was still an implicit superuser inside the legacy Fixed Ops guards (`hasAnyRole` short-circuited on it), and `rolesForUserLink` handed platform-scope roles into the dealership domain.                                                                                                                                                                                                                     | The short-circuit is removed and role lookup is tenant-scoped.                                                                                                                                                                                                                   |
| 6   | MEDIUM   | A raw `x-request-id` header went straight into `policy_decisions`, whose CHECK requires 8–128 chars — a one-character header **500'd every gated request**, and arbitrary text (including PII) could be written into an append-only table.                                                                                                                                                                                   | The correlation id is screened with the same `SAFE_ID` pattern request-context uses; anything else is dropped.                                                                                                                                                                   |
| 7   | MEDIUM   | `readCookie` called `decodeURIComponent` unguarded: `Cookie: dealer_session=%` produced an **unauthenticated 500 with a full stack log**, repeatable at will.                                                                                                                                                                                                                                                                | Malformed encoding is treated as a malformed credential — a neutral 401.                                                                                                                                                                                                         |
| 8   | MEDIUM   | An empty-string `IDENTITY_PROVIDER` was a fatal config error, and `docker-compose.yml` always sets it to empty — the documented `docker compose up` quick start would **crash-loop**.                                                                                                                                                                                                                                        | `''` is treated as absent, exactly as every other variable in the file treats it.                                                                                                                                                                                                |
| 9   | MEDIUM   | `README.md` still documented the deleted HS256 / `JWT_SECRET` model as current.                                                                                                                                                                                                                                                                                                                                              | Rewritten to the WorkOS model.                                                                                                                                                                                                                                                   |
| 10  | MEDIUM   | Both runbooks instructed operators to grant roles through an administration path **that does not exist** — no route declares the `identity.*` actions.                                                                                                                                                                                                                                                                       | Both now state plainly that FBL-020 ships the actions and the engine but no HTTP admin surface, and give the direct SQL.                                                                                                                                                         |
| 11  | LOW      | Three of the six `/auth` routes and the whole sealed-cookie primitive had **zero executable coverage** — deleting the state check or the AEAD tag would not have failed a test.                                                                                                                                                                                                                                              | New `tests/auth-surface.test.ts`: 8 tests covering login/callback/reauth-callback, open-redirect refusal, purpose separation, wrong-key and byte-flip tamper detection, malformed cookies, hostile request ids.                                                                  |
| 12  | LOW      | The two HTTP tests that claimed to prove single-use grants were **vacuous** — one "replayed" onto an ungated transition and asserted success.                                                                                                                                                                                                                                                                                | Replaced with a real replay proof on the authorization-record path (the one gated path that repeats on the same resource).                                                                                                                                                       |
| 13  | LOW      | `docker-compose.yml`'s header asserted a secrets model that no longer exists.                                                                                                                                                                                                                                                                                                                                                | Corrected.                                                                                                                                                                                                                                                                       |

Regression tests were added for defects 1, 2, 3, 4, 6, 7, 11 and 12, so each
would now fail loudly rather than silently.

**Why this matters for the review:** three of these (1, 2, 3) are the kind of
defect that a passing test suite actively conceals — the tests asserted the
right things about the wrong paths. The suite that shipped the first pass was
204/204 green.

## 6. Documentation delivered

- `docs/adr/ADR-006-workos-authkit-identity.md`, `ADR-007-organization-hierarchy-policy.md`, `ADR-008-support-access.md`
- `docs/architecture/THREAT-MODEL-DELTA-FBL-020.md`
- `docs/identity/DATA-DICTIONARY.md`, `ROLE-ACTION-SCOPE-MATRIX.md`, `AUTH-FLOWS.md`, `MIGRATION-055-NOTES.md`, `KNOWN-LIMITATIONS.md`
- `docs/runbooks/WORKOS-OPERATOR-RUNBOOK.md`, `TENANT-BOOTSTRAP-RUNBOOK.md`

## 7. What this delivery does NOT prove

Stated plainly, and expanded in `docs/identity/KNOWN-LIMITATIONS.md`:

- **No live WorkOS behaviour is exercised.** Every verifier property is proven
  against a deterministic local RSA issuer with a counted JWKS endpoint. Real
  AuthKit redirect parameters, real token claim shapes, real `max_age=0`
  semantics and real organization membership are untested. That is Gate B.
- The WorkOS SDK adapter compiles and is architecture-tested for confinement,
  but no test invokes the real SDK.
- Audit rows are transactional; **durable delivery is not claimed** (outbox is
  FBL-040).
- RLS remains FBL-030. `step_up_token_uses` (migration 050) is now dead weight;
  dropping it is a future migration.

## 8. Position

FBL-000 closed → FBL-010 closed → **FBL-020 code complete, awaiting review and
live certification** → FBL-030 blocked, not started.
