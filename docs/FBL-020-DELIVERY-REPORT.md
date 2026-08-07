# FBL-020 — Identity Boundary: Delivery Report (R3)

Governing document: **Master Blueprint v2.0, §14.3**. This report supersedes the
R2 report in full. Every number below was measured on the tree being submitted,
not carried forward from an earlier revision.

§12 was written as an explicit, unmistakable placeholder and shipped that way in
the code-bearing commit `f816642`, because no CI run for a commit can exist
before that commit does. It has since been filled in from run `31223131820`,
whose `head_sha` was compared against `f816642` and found equal, and this
documentation closeout is the commit that carries it. That ordering is
deliberate: it is the discipline whose absence produced the R2 defect described
in §2, and an earlier false-green report in FBL-000.

## 1. Status

**FBL-020-R3 delivers the identity boundary in code, with its fourteen R3 gates
discharged and seventeen adversarial-review defects closed.**

What that does and does not mean:

- **Live WorkOS certification is NOT claimed and is NOT attempted.** No live
  WorkOS credentials exist in this environment. Every provider property is proven
  against a deterministic local issuer and a provider-neutral fake. That gate
  remains **BLOCKED**.
- **FBL-030 has not been started.** Nothing in this order touches it.
- **FBL-000 and FBL-010 are not reopened.** Their baselines and boundaries are
  unchanged except where this order's own ratchet tightened (§7).
- No vehicle, inventory, CRM, BDC, marketing, sales, UI or repair functionality
  was added. Fixed Ops behaviour is unchanged except the narrowly authorized
  assurance correction carried forward from R2 and the supervisor-reach
  correction described in defect **E2** below, which _narrows_ reach that was
  wrongly widened.

## 2. Where R2 went wrong, and what changed in this document

The R2 report claimed **"Status: FBL-020 CODE COMPLETE"** against code-bearing
head `ff31370`, CI run `30929301450`, four artifact digests, and a migration-057
checksum. Every one of those values described a tree that this delivery is two
checkpoint commits and 94 working-tree paths past. Migration 057 itself has
been edited (+573 / −27 lines against `cac9b21`), so its checksum moved. Nothing
in the repository pinned the report, so no gate caught the drift. That is the
same defect class this order exists to eliminate — a document claiming more than
the code delivers — and it is corrected here by rewriting the report from
measurements taken on the final tree and by marking the CI block as **NOT YET
MEASURED** rather than filling it with stale values (§12).

## 3. Delivery discipline — the two WIP checkpoints, disclosed

R3 permits one code-bearing commit. Two WIP commits exist on the current branch:

| Commit    | Subject                                                   |
| --------- | --------------------------------------------------------- |
| `cf9774b` | `WIP FBL-020-R3 CHECKPOINT — INCOMPLETE, NOT SUBMITTED`   |
| `bb79ef4` | `WIP FBL-020-R3 CHECKPOINT 2 — INCOMPLETE, NOT SUBMITTED` |

Both were made at the repository owner's explicit instruction, to preserve work
across a session boundary, and both carry a header saying they are not a
delivery. They are disclosed here rather than hidden. The submission is the
single squashed code-bearing commit the operator will create from this tree; the
base for every diff in this report is **`cac9b21`**, the last architect-accepted
head.

## 4. The fourteen R3 gates

Each row names the code that discharges the gate and the deterministic test that
fails if the property is removed. Every test named here ran green in all four
batteries of §7.

| #      | Gate                                                                                                                                                                                                                                                                                                                                  | Code                                                                                                             | Proof                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **1**  | **Support-access authority.** Requesting requires a current, effective platform-support actor; approving, denying, revoking and starting a session each require a current, effective `tenant_admin` **of the target tenant**, evaluated against the policy engine's own scope and effectiveness rules.                                | `packages/identity-access/src/mutations.ts`                                                                      | `tests/identity-boundary.test.ts`: _a ROOFTOP-scoped tenant_admin holds NO tenant-wide support authority_; _only a current tenant admin of the TARGET tenant may approve support access_; _support revocation is authorized, scoped and attributable_; _a REVOKED requester binding blocks approval, keeps the request pending and spends no grant_; _a WINDOWED-OUT requester binding blocks approval_; _startSupportSession refuses an approved request whose requester was offboarded after the approval_ |
| **2**  | **Migration 057 reconciles BEFORE it constrains**, and applies to a populated pre-057 database without aborting.                                                                                                                                                                                                                      | `migrations/057_identity_boundary_completion.sql`                                                                | The populated drill of §8, including the negative control that reproduces the abort when the reconciliation is removed. Also the CI `migration-upgrade` job. **Not** covered by an in-suite unit test — stated plainly.                                                                                                                                                                                                                                                                                      |
| **3**  | **Local-only insecure HTTP, and cookie clearing that matches the cookie it replaces.** `Secure` may be dropped only when `NODE_ENV` is explicitly `development`/`test` **and** every identity URL is a loopback host. Clearing preserves `Secure`, path, `SameSite` and `HttpOnly`.                                                   | `packages/platform/src/config.ts`, `apps/api/src/routes/auth.ts`                                                 | `tests/identity-config.test.ts`: _a REMOTE deployment keeps Secure cookies even at NODE_ENV=development_; _ONLY development\|test with EVERY identity URL on loopback drops Secure_; _production demands https on every identity URL_                                                                                                                                                                                                                                                                        |
| **4**  | **Exact six-fact identity binding** — provider, configured issuer, provider organization, provider subject, tenant and connection — on UserLink, local session and reauthentication transaction, with the unbound state unrepresentable in the schema.                                                                                | migration 057 §§1–2, 4; `packages/identity-access/src/session.ts`, `apps/api/src/middleware/auth.ts`             | `tests/identity-boundary.test.ts`: _the schema makes an unbound LIVE session unrepresentable_; _a session bound to a DISABLED connection stops validating_. `tests/auth.test.ts`: _R3: a cookie session dies when any ONE fact stops agreeing_; _R3: an issuer mismatch is refused at EVERY layer that carries one_; _R3: an organization remap does NOT inherit the old UserLink_                                                                                                                           |
| **5**  | **Bearer credentials resolve a LOCAL, revocable session.** A verified bearer establishes one local session and reuses it; local logout, revocation and expiry each deny the very next request carrying the same still-valid provider token.                                                                                           | migration 057 §2 (`credential_kind`, `bearer_key_hash`); `apps/api/src/middleware/auth.ts`                       | `tests/auth.test.ts`: _R3: a verified bearer establishes ONE local session and reuses it_; _R3: local logout denies the very next request with the SAME bearer token_; _R3: revoking the local session denies the next bearer request_; _R3: an EXPIRED local session refuses a still-valid bearer token_; _R3: a NEW provider authentication is a new local session, not a lockout_                                                                                                                         |
| **6**  | **The login state machine.** `login_transactions` owns state, nonce, PKCE and redirect as digests, expires on its own clock, and is claimed by an atomic conditional UPDATE: `pending → consuming → succeeded\|failed`, replay loses at every stage, failure is terminal with a reason.                                               | migration 057 §3; `packages/identity-access/src/login-transaction.ts`                                            | `tests/identity-boundary.test.ts`: _a login transaction is consumed exactly once; the replay loses_; _the login transaction walks pending -> consuming -> succeeded, and the replay loses at EVERY stage_; _a claimed transaction that fails is terminal WITH A REASON and can never become succeeded_; _an UNCLAIMED transaction expires into the failed terminal state, never into success_; _the schema itself refuses the states the machine forbids_                                                    |
| **7**  | **A real provider refresh exchange over sealed, rotating state** — reachable from the request path, bounded, leased so exactly one attempt is in flight, and never holding a transaction across the network call.                                                                                                                     | `packages/identity-access/src/session.ts`, `.../provider/workos/adapter.ts`, `apps/api/src/identity/provider.ts` | `tests/identity-boundary.test.ts`: _a real refresh presents the SEALED token and rotates the state_; _a replayed old refresh token changes nothing_; _R3: maintenance refreshes only when DUE, and parallel callers spend the token once_; _D1: a provider that NEVER ANSWERS does not starve the shared connection pool_; _D1: the LEASE enforces single-spend_; _D1: an EXPIRED lease is reclaimable_. `tests/auth.test.ts`: the seven `C1:` tests                                                         |
| **8**  | **Impersonation is rejected wherever it can arrive** — in a bearer token, in a refresh reply — and revokes rather than being adopted. No email or provider profile escapes.                                                                                                                                                           | `packages/identity-access/src/oidc/token-verifier.ts`, `.../session.ts`                                          | `tests/auth.test.ts`: _an IMPERSONATED bearer token authenticates nobody, whatever carries the claim_; _C1: an IMPERSONATED refresh reply revokes instead of being adopted_. `tests/identity-boundary.test.ts`: _an impersonated refresh is rejected and revokes the session_; _impersonation carried by the TOKEN also revokes, and the email never escapes_                                                                                                                                                |
| **9**  | **Server-derived reauthentication binding, with the STORED OIDC nonce actually consumed.** Starting facts come from the live local session; a caller belief that disagrees refuses; a missing verified value is a failure, not a skipped comparison; a `started` transaction that cannot name its nonce digest is forbidden by CHECK. | migration 057 §4; `packages/identity-access/src/reauthentication.ts`                                             | `tests/reauthentication.test.ts`: _a completion whose STORED oidc nonce does not match mints nothing_; _a MISSING verified value is a failure, never a skipped comparison_; _the START derives its binding; a caller belief that DISAGREES refuses_; _a step-up cannot start from — or complete without — a live local session_                                                                                                                                                                              |
| **10** | **Policy evidence carries the GENERATED request context and a computed assurance about the credential THIS request presented** — never a client-supplied id, never the actor's freshest other session.                                                                                                                                | `packages/identity-access/src/policy.ts`                                                                         | `tests/identity-boundary.test.ts`: _a decision records the GENERATED ids and REAL, computed assurance_. `tests/auth-surface.test.ts`: _a hostile x-request-id neither 500s the request nor reaches the evidence row_. `tests/policy.test.ts`: _evidence is append-only and PII-free_                                                                                                                                                                                                                         |
| **11** | **Versioned mutation services with transactional audit.** Every identity mutation advances the applicable `authorization_version`, names the true acting link, and writes exactly one `audit_events` row in the same transaction. A platform role name cannot be granted at a tenant scope.                                           | `packages/identity-access/src/mutations.ts`                                                                      | `tests/identity-boundary.test.ts`: _every mutation advances its version, names the TRUE actor, audits once_. `tests/policy.test.ts`: _a platform role at TENANT scope reaches no platform.\* action, and cannot be granted_                                                                                                                                                                                                                                                                                  |
| **12** | **`GET /auth/session` is a bounded contract** — eight facts, no email, no provider profile, no tokens — and the roles it reports are the ones the engine would match.                                                                                                                                                                 | `packages/identity-access/src/session-view.ts`, `apps/api/src/routes/auth.ts`                                    | `tests/auth.test.ts`: _GET /auth/session is bounded: eight facts, no email, no provider profile, no tokens_. `tests/identity-boundary.test.ts`: _the session view reports NO role and NO scope for a windowed-out binding_                                                                                                                                                                                                                                                                                   |
| **13** | **Bootstrap, runbooks and this report.** The audited bootstrap command refuses ambiguity and is idempotent; the operator and tenant-bootstrap runbooks describe the shipped behaviour; the delivery report is measured, not carried forward.                                                                                          | `scripts/bootstrap-identity.ts`, `docs/runbooks/*`, this file                                                    | `tests/identity-core.test.ts`: _bootstrap: dry-run writes NOTHING; apply is idempotent; ambiguity refuses_. `tests/docs.test.ts`: the four documentation-agreement tests, including _every migration on disk is listed in the appendix_                                                                                                                                                                                                                                                                      |
| **14** | **Test proofs above the R2 count of 230.** Delivered: **315**, i.e. **+85**, all green with zero skips.                                                                                                                                                                                                                               | `tests/`                                                                                                         | §7                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

## 5. The defect ledger — seventeen defects, five adversarial waves

Severity uses the review's own scale: **Critical** = a live authorization or
availability hole; **High** = a security property that could be defeated or a
false security claim in shipped material; **Medium** = a correctness or
diagnostic defect with a bounded blast radius.

### 5.1 The five defects THIS IMPLEMENTATION INTRODUCED

These were not inherited from R0/R1/R2. Each was written during FBL-020-R3, by
this implementation, and found by later review of this implementation's own
work. They are stated first and without softening, because disclosure is the
point of this section.

| ID     | Sev          | What it was — introduced by this order                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | How it was closed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Test that pins it                                                                                                                                                                                                                                            |
| ------ | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **A1** | **Critical** | **The support-authority SCOPE GAP.** The support-access authority gate matched any `tenant_admin` binding of the tenant and never read `scope_level` or `scope_id`. A `tenant_admin` bound to ONE ROOFTOP therefore held tenant-WIDE authority to approve, deny and revoke platform support access into that tenant's data — while the policy engine, asked the same question about the same actor, answered `deny NO_MATCHING_BINDING`. Two authority paths existed and one of them was wrong. Every pre-existing test passed, because every one of them granted `tenant_admin` at `scopeLevel: 'tenant'` — the single shape the broken gate happened to get right. | There is now ONE authority path. `mayActTenantWide` (`packages/identity-access/src/mutations.ts:1007`) derives its allowed roles from the published action catalog and applies the policy engine's OWN effectiveness SQL and OWN scope predicate to the very columns the engine reads.                                                                                                                                                                                                                  | `tests/identity-boundary.test.ts` — _a ROOFTOP-scoped tenant_admin holds NO tenant-wide support authority_                                                                                                                                                   |
| **C1** | **High**     | **The UNREACHABLE PROVIDER REFRESH.** `/auth/callback` sealed a provider refresh credential onto every session, `refreshProviderSession` implemented a full exchange — and nothing in `apps/`, `packages/` or `scripts/` ever called it. The platform took custody of a long-lived provider credential per session that no running code could spend, so the provider's continued assent was never re-checked and an identity disabled at the IdP kept its local session for the full local TTL. Custody with no spender is blast radius with no benefit.                                                                                                             | The refresh is now driven from request authentication through a single shared provider port (`apps/api/src/identity/provider.ts`), due-gated on the locked row, and the whole path — rotation, non-extension of local life, transient survival, revoking outcomes — is exercised over real HTTP.                                                                                                                                                                                                        | `tests/auth.test.ts` — _C1: a session whose provider token is near expiry IS refreshed on the live request path_ (and the six sibling `C1:` tests)                                                                                                           |
| **D1** | **Critical** | **TRANSACTION ACROSS A NETWORK CALL → POOL STARVATION.** The first reachable refresh held the session row's `FOR UPDATE` lock — and therefore a pooled connection inside an open transaction — across the provider HTTP call. A provider that HUNG rather than errored pinned one of ten shared connections for as long as it hung; ten due sessions exhausted the pool and took the whole API down for every tenant.                                                                                                                                                                                                                                                | The exchange happens outside any transaction, claimed by a short-lived **refresh LEASE** written in its own transaction and reclaimable when it expires; the adapter call is hard-bounded and aborts its socket; every pooled connection is born with a server-side `statement_timeout` and `idle_in_transaction_session_timeout`.                                                                                                                                                                      | `tests/identity-boundary.test.ts` — _D1: a provider that NEVER ANSWERS does not starve the shared connection pool_; _D1: every pooled connection is born with server-side bounds_; _D1: parallel maintenance spends once and NOBODY waits_                   |
| **G1** | **Critical** | **The idle-in-transaction FATAL that KILLED THE PROCESS.** Enforcing D1's own bound was worse than the exhaustion it bounded. PostgreSQL answers the idle bound with a FATAL (25P03) and closes the connection; pg-pool removes its own `'error'` listener for the duration of a checkout, so that FATAL arrived on an EventEmitter with no listener — an uncaught exception no `try`/`catch` around the transaction could see, and with no process-level handler anywhere in this repository it **terminated the API**. Exhaustion degrades and recovers; this dropped every in-flight request for every tenant.                                                    | `withTransaction` now owns the checked-out client's `'error'` listener for exactly the checkout, types the FATAL, fails that one request with a retryable 503, destroys the client on release, and removes its listener again. The migration runner uses the same hardened checkout with a `SET LOCAL` exemption that reverts at COMMIT.                                                                                                                                                                | `tests/identity-boundary.test.ts` — _G1: an idle-in-transaction FATAL is one caught, typed, retryable failure_ (asserted by CHILD PROCESS EXIT CODE, with the child reporting zero process-level handlers so survival cannot be attributed to one)           |
| **H1** | **High**     | **The ESCAPABLE DRIFT GUARD.** Three defects of this order (A3, E1, E2) were one shape: a second, hand-written copy of the role-bindings effectiveness rule that had dropped the effective window. The guard this order then wrote to stop the recurrence (**E3**) was itself a set of text-shape heuristics with holes in **both** directions — SQL that never spelled the table in one literal slipped past, and prose containing the word `update` was reported. A guard that can be walked around, shipped with a header implying it cannot, is a false claim in shipped material and the same failure mode as the rest of this ledger.                          | Hardened into a small static evaluator over the module's own constants and template literals, with a declared and validated opt-out mechanism, and a corpus of **24 adversarial fixtures + 4 controls + 6 must-accept fixtures**. Six further bypasses were closed during closeout (cluster L); the residue it still cannot see is enumerated in its own header **and** in `docs/identity/KNOWN-LIMITATIONS.md`, and the guard is now stated to be a build-time drift guard, **not** a runtime control. | `tests/architecture.test.ts` — _every adversarial fixture is REJECTED, with exactly the rules it exists to prove_; _correct code is ACCEPTED however the shared predicate is spelled_; _the role-bindings effectiveness rule has exactly one implementation_ |

### 5.2 The remaining twelve

| ID     | Sev          | What it was                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | How it was closed                                                                                                                                                                                                                                                                                                          | Test that pins it                                                                                                                                                                                                                     |
| ------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A2** | High         | One reauthentication grant could authorize more than one support approval if a future code path reintroduced its own grant predicate: single-use was enforced only in application SQL.                                                                                                                                                                                                                                                                                                                                    | A unique index in migration 057 makes one grant approve at most one request, installed **after** its own reconciliation so a database that had ever recorded two would not abort the migration.                                                                                                                            | `tests/identity-boundary.test.ts` — _a support-approval grant is bound to its action, its request and ONE use_                                                                                                                        |
| **A3** | **Critical** | The platform-support authority predicate checked `rb.status = 'active'` and the user LINK's window but omitted the BINDING's window. A `platform_support` binding whose `effective_to` was a day in the past still filed support requests the engine returned zero rows for.                                                                                                                                                                                                                                              | The predicate now interpolates the engine's own `EFFECTIVE_ROLE_BINDING_SQL`; there is no second window to forget.                                                                                                                                                                                                         | `tests/identity-boundary.test.ts` — _a windowed-out platform_support binding cannot file a support request_                                                                                                                           |
| **B1** | **Critical** | The insecure-HTTP override permitted plain HTTP and non-`Secure` cookies on ANY host, and the `Secure` decision rested on `NODE_ENV` alone — so a real deployment with all-remote identity URLs running `NODE_ENV=development` issued session, transaction **and clearing** cookies without `Secure`.                                                                                                                                                                                                                     | The override is removed. Dropping `Secure` requires `NODE_ENV` in {development, test} **AND** every identity URL on a loopback host. Clearing preserves `Secure`, path, `SameSite`, `HttpOnly`.                                                                                                                            | `tests/identity-config.test.ts` — _a REMOTE deployment keeps Secure cookies even at NODE_ENV=development_; _ONLY development\|test with EVERY identity URL on loopback drops Secure_                                                  |
| **B2** | High         | Assurance in the policy evidence row was computed from the actor's freshest session (`ORDER BY auth_time DESC LIMIT 1`), not the credential the request presented. With R3 minting local sessions for both credential kinds, a request on a six-hour-old cookie was recorded as `fresh`.                                                                                                                                                                                                                                  | Assurance is computed about the PRESENTED session id — the same id the evidence row records and an operator can revoke — in one statement, with `not_applicable` when nothing live was presented.                                                                                                                          | `tests/identity-boundary.test.ts` — _a decision records the GENERATED ids and REAL, computed assurance_                                                                                                                               |
| **B3** | High         | A `platform.*` control-plane role name could be granted at a tenant scope, and control-plane actions were reachable from scopes that should not carry them.                                                                                                                                                                                                                                                                                                                                                               | Platform roles are DERIVED from the published catalog; the misgrant is refused at the write rather than recorded, and the engine reaches a control-plane action only from a platform-scope binding.                                                                                                                        | `tests/policy.test.ts` — _a platform role at TENANT scope reaches no platform.\* action, and cannot be granted_                                                                                                                       |
| **C2** | High         | Login observation wrote its `audit_events` row on the deactivated and pending branches and **nothing** on the activated branch — the only branch that goes on to mint a session — while the module header claimed every observation wrote one. The trail recorded precisely the logins that did not get in.                                                                                                                                                                                                               | The successful login is audited too, recording which fields changed rather than their values, and carrying no email and no display name.                                                                                                                                                                                   | `tests/identity-core.test.ts` — _R3: an ACTIVATED login writes its audit event, carrying no email and no display name_                                                                                                                |
| **E1** | High         | `getSessionView` restated the effectiveness rule as `rb.status = 'active'`, so a binding left active with `effective_to` in the past was reported to the user as a held role with an effective scope, while the engine denied every action it named.                                                                                                                                                                                                                                                                      | The view interpolates `EFFECTIVE_ROLE_BINDING_SQL`; the page cannot claim authority the engine refuses.                                                                                                                                                                                                                    | `tests/identity-boundary.test.ts` — _the session view reports NO role and NO scope for a windowed-out binding_                                                                                                                        |
| **E2** | **Critical** | `rolesForUserLink` restated the same rule, and the API middleware writes that list into `req.tenantContext.roles`, which the Fixed Ops cockpit reads through `hasAnyRole` to decide SUPERVISOR reach. A technician whose `service_advisor` binding had aged out kept supervisor reach, so ownership guards stopped applying and another technician's MPI session and work ticket became reachable.                                                                                                                        | Both queries interpolate the shared predicate.                                                                                                                                                                                                                                                                             | `tests/integration.test.ts` — _a windowed-out supervisor binding stops widening technician reach_; _another technician MPI session and work ticket become unreachable_                                                                |
| **E3** | High         | **No build-time guard existed against the drift class at all.** Wave 2 answered A3/E1/E2 by exporting the predicate once as `EFFECTIVE_ROLE_BINDING_SQL` — and then shipped two more readers that restated it anyway. Review demonstrably does not hold this line.                                                                                                                                                                                                                                                        | `scripts/check-role-binding-effectiveness.ts` was added to `npm run architecture:check`, so a second hand-written copy, a neutralised copy, or SQL the guard cannot read fails the build. On this tree: 17 statements inspected, 6 declared opt-outs, one shared predicate. (Its own escapability is defect **H1**, §5.1.) | `tests/architecture.test.ts` — _the real tree passes, and every exception declares a recognised reason code_; _the role-bindings effectiveness rule has exactly one implementation_                                                   |
| **F1** | **Critical** | The platform-support authority check was wired into the FILING gate only. Approval mints a fresh 60-minute window into tenant data and starting a session does the same — so revoking a platform actor's binding, the natural offboarding action, left a pending request that could still be turned into live access.                                                                                                                                                                                                     | The requester's platform authority must still be current at approval and at session start; losing the binding is offboarding.                                                                                                                                                                                              | `tests/identity-boundary.test.ts` — _a REVOKED requester binding blocks approval, keeps the request pending and spends no grant_; _startSupportSession refuses an approved request whose requester was offboarded after the approval_ |
| **F2** | Medium       | An `approver_assurance` column presented itself as the approval bar — with a CHECK enumerating the vocabulary — and nothing read it. The bar is stated in code. Schema that looks authoritative and is not is a trap.                                                                                                                                                                                                                                                                                                     | The column was **deleted** rather than wired up, because honouring it would have added a per-request downgrade knob on the one gate that lets a platform person into tenant data.                                                                                                                                          | `tests/identity-boundary.test.ts` — _no support-request column presents an approval assurance bar that nothing reads_                                                                                                                 |
| **I1** | High         | A lost connection was classified from WHICH RACER WON, not from the error. When a FATAL landed on an IN-FLIGHT statement — a restart, a failover, `pg_terminate_backend`: the ordinary production shape — pg rejected the query before the socket `'error'` event, so the caller got `500 internal_error`, `retryable=false`, and nothing retried a purely retryable infrastructure failure. The same await ordering skipped the ROLLBACK suppression, so a second, misleading error was logged on top of the real cause. | Classification is made from the error itself; the rollback suppression is decided after the awaits it depends on.                                                                                                                                                                                                          | `tests/identity-boundary.test.ts` — _I1(a): a FATAL on an in-flight statement is a typed, retryable 503_; _I1(b): that path logs the real cause once and no misleading ROLLBACK failure_                                              |

### 5.3 Closeout corrections made after the seventeen (K, L, I2)

Closed in this final wave. Listed separately so the count above is not inflated.

| ID        | What it was                                                                                                                                                                                                                                                              | Resolution                                                                                                                                                                                                  | Test that pins it                                                                                                                              |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **I2**    | The G1/I1 fix changed a caller contract without saying so: `withTransaction` can now reject **while `fn` is still running**, so the body's continuation runs on after the caller was told the operation failed. Documented nowhere.                                      | **Narrowed the claim and wrote the contract down** on `withTransaction` and in KNOWN-LIMITATIONS, with the measured behaviour of an abandoned body.                                                         | `tests/identity-boundary.test.ts` — _I2(ii): an abandoned body runs on, cannot write, and is documented_ (fails if either write-up disappears) |
| **K1**    | `isLostConnection()` consulted a socket-errno allowlist, so an ordinary application error that happened to carry such an errno was reclassified as transient infrastructure — contradicting the class's own opening sentence, which every caller branches on.            | **Closed in code**: classification now rests only on self-identifying shapes (a session-ended SQLSTATE, the driver's verbatim severed-socket message) plus per-client evidence of a real connection error.  | `tests/identity-boundary.test.ts` — _K1: a socket errno from another socket is not a lost connection_                                          |
| **K2**    | `sqlStateOf` accepted any five alphanumerics off `err.code`, and `EPIPE` is five upper-case letters — so a broken pipe was reported as `pgCode: 'EPIPE'`, a value matching no SQLSTATE an operator can filter on, while the documentation said the field was a SQLSTATE. | **Closed in code**: a code is accepted only when its first two characters are a PostgreSQL-defined SQLSTATE class.                                                                                          | `tests/identity-boundary.test.ts` — _K2: a genuine severed socket is still 503, and carries no fake SQLSTATE_                                  |
| **K3**    | The class documentation's SQLSTATE statement was true only for some shapes.                                                                                                                                                                                              | **Narrowed the claim**: `pgCode` is documented as best-effort and the **class** is the contract to branch on; recorded in KNOWN-LIMITATIONS with the measured frequency.                                    | Same scenario file; the wording is pinned by the documentation assertions in `tests/identity-boundary.test.ts`                                 |
| **L1–L3** | The drift guard's shipped header enumerated rules it did not fully enforce: eleven spellings could get past it.                                                                                                                                                          | **Six closed in code** (De Morgan negation, predicate-level comparisons, line and block comments, predicate-in-projection, one-use-counted-twice), each with a fixture. **Five narrowed** and written down. | `tests/architecture.test.ts` — the fixture corpus, including `evasion-t/u/v/w` and `evasion-s`                                                 |

## 6. Canonical migration checksums

**ALL checksums in this repository — here, in `docs/identity/DATA-DICTIONARY.md`,
in tickets and in review — are canonical LF / git-blob values.** The table below
was computed from **the tree being submitted**, which at the time of writing is
the working tree and not yet a commit:

```bash
sed 's/\r$//' migrations/<file>.sql | sha256sum                  # canonical LF sha256
sed 's/\r$//' migrations/<file>.sql | git hash-object --stdin    # canonical blob OID
```

Once the code-bearing commit named in §12 exists, the same values are reproduced
from it directly:

```bash
git show <code-bearing-commit>:migrations/<file>.sql | sha256sum
```

Do **not** substitute `HEAD` in that command while reading this document: §3
states that `HEAD` is the second WIP checkpoint, two commits behind the tree
described here. Nine of the ten rows reproduce from `HEAD` anyway because those
blobs are frozen; `057` is the one row that has moved, and from `HEAD` it yields
`e68ca45afc6a238eb867041173c8cf5e628acf601f5655ebc2a884ee1a0badac`, which is a
superseded value and not the one published below.

The values are **NOT** Windows working-tree values. This working copy checks out
with `core.autocrlf=true` and **every one of these ten files contains CRLF on
disk** (measured: `000`=37 CR-terminated lines, `049`=414, `050`=166, `051`=74,
`052`=60, `053`=39, `054`=63, `055`=505, `056`=304, `057`=783), so a raw
`sha256sum` of any working file disagrees with CI and with every other machine —
not merely for `050` and `057`. **Earlier reporting in this order quoted
working-tree sha256 values for migration 050; those are superseded by the table
below.** For the record, I searched every committed revision of `docs/` and found
no CRLF value published there — the error was confined to correspondence, and
this is the correction.

| Migration                                    | git blob OID (canonical)                       | sha256 (canonical, LF)                                                 |
| -------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------- |
| `000_platform_core.sql`                      | `df137755674314f1557dbf5e77e03cad9ccb7a78`     | `a3e0f4ca4990a313cabdefa8b26ca762977e95d2c8cfafbedf64f3ecb4fda94d`     |
| `049_phase248_service_cockpit.sql`           | `6ead711b7362b5e49a20987e13af6c8f82695b78`     | `523ee2e236b427e55fdd06037f350ac4729865581b5772d8078cf473e5984242`     |
| `050_phase248_hardening.sql`                 | `52217a9c594176706a292b8d544a0affd7d9c3de`     | `009d464da812459168b341b112dd4972edb39c406b0e5ebf33fb11798d35a522`     |
| `051_phase248_metrics_support.sql`           | `99a8b733174ab74b6f0f6822354acf747437d7e9`     | `e79d9a9fd56b76134ab6823fd8f7c83a653a4caecb5a1f243d46a5a8d36427d4`     |
| `052_phase248_authorization_binding.sql`     | `a900bbf303be3883e541e2bc9aafeb3e63d40f49`     | `94179a31e1f96185af52ecc37bc93bb9a3bd58f55a8ea46ec642300f68b04d41`     |
| `053_phase248_estimate_line_association.sql` | `deec57d1e361e7de0964d6f0114e1464392ea11f`     | `a2e125e122ec455ee19d1c18ffd6f08af5cd9fc46100de0ba424d5630e3b783a`     |
| `054_phase248_waitlist.sql`                  | `0b5461c6c8c481f0f957a5f9d6df34eb1a2e47f5`     | `8382d8efda1769de0828fd0de74cb8f8303e8f5aca1decf9b07e22dcf8baea58`     |
| `055_identity_organization.sql`              | `e6a4b675fa354b89e93585e21c172360c2738946`     | `52a56f414725adc5751c88bc256c9fe5f00bbeaf4b5ad909a3ecc13c86120a5d`     |
| `056_identity_contract_completion.sql`       | `615e95991580a99f5e8109ab991093ecf0042010`     | `ff2d0307d374efba41b4ff79268ace9b03b32376d5e60ae678d840936448713d`     |
| **`057_identity_boundary_completion.sql`**   | **`c69e8d7cb129f41293d8f75c3f7c7b8f61e2aa89`** | **`a430d1f4f533b96b963bb6e96e711c0b768baf600c93e1b1896d08fa26c611c0`** |

**Byte-identity of the frozen chain, measured against `cac9b21`:** the blob OIDs
for `000` and `049`–`056` above are character-for-character the OIDs
`git ls-tree cac9b21 migrations/` reports. **Only `057` differs**
(`02c734b1dabd32b8aee980ae3ea35a029e08fe9f` → `c69e8d7cb129f41293d8f75c3f7c7b8f61e2aa89`,
+573 / −27 lines).

The R2 report pinned `057` at `af29b31f…`. That value was the canonical LF
checksum of `057` **at head `ff31370`/`cac9b21`** and is now stale, exactly as
`DATA-DICTIONARY.md` predicted when it declined to pin the file. `057` is still
not pinned in the data dictionary; the value above is pinned to the OID beside
it, so it can be re-derived rather than trusted.

## 7. Verification evidence — measured on this tree

### Test batteries — four full runs, all green

```
TEST_DATABASE_URL="postgresql://postgres@127.0.0.1:55434/dealership_test" \
  npx tsx --test --test-concurrency=1 --test-reporter=tap tests/*.test.ts
```

The authoritative pair is **runs 3 and 4**, taken back to back on the final tree.
Runs 1 and 2 were taken earlier in the closeout and are reported for
completeness; all four agree exactly.

| Metric      | Run 1     | Run 2     | **Run 3** | **Run 4** |
| ----------- | --------- | --------- | --------- | --------- |
| tests       | 315       | 315       | **315**   | **315**   |
| suites      | 29        | 29        | **29**    | **29**    |
| pass        | 315       | 315       | **315**   | **315**   |
| fail        | 0         | 0         | **0**     | **0**     |
| cancelled   | 0         | 0         | **0**     | **0**     |
| skipped     | 0         | 0         | **0**     | **0**     |
| todo        | 0         | 0         | **0**     | **0**     |
| duration_ms | 149,837.9 | 152,042.2 | 147,746.9 | 152,370.5 |
| `not ok`    | 0         | 0         | **0**     | **0**     |

**Stability:** each TAP log was reduced to its sorted assertion-name set — 344
names, being 315 tests plus 29 suite lines, every name unique — and the sets were
diffed. **All four sets are byte-identical.** Floor: ≥ 313 required, **315**
delivered. R2's count was 230, so **+85**.

**What "the final tree" means here, precisely.** Runs 3 and 4 executed against
the final state of every file the suite reads — code, tests, migrations,
configuration, and `docs/identity/KNOWN-LIMITATIONS.md`, which
`tests/identity-boundary.test.ts` `I2(ii)` asserts against. The only file edited
after run 3 began is **this report**, which no test reads; a report cannot be
inside the tree whose measurements it quotes.

### Build, architecture, ratchet

- `npm run build` → **0 TypeScript errors**, exit 0.
- `npm run architecture:check` → **5/5 OK**, exit 0: dependency check; app-SQL
  guard (no query primitives, no SQL literals in `apps/**`); architecture
  manifest (11 modules); env-access confinement; role-bindings effectiveness
  guard — _17 statements inspected, 6 declared opt-outs, one shared predicate_.
- `npx tsx scripts/quality-ratchet.ts check` → **exit 0**, run BEFORE any update
  and no update was needed.

| Ratchet    | `cac9b21` | This tree | Ceiling (ADR-005) | Direction |
| ---------- | --------- | --------- | ----------------- | --------- |
| tsc-strict | 53        | **53**    | 59                | unchanged |
| eslint     | 125       | **123**   | 136               | tightened |
| format     | 1         | **1**     | 29                | unchanged |

No baseline was raised — that is the property `quality-ratchet.ts check` actually
enforces, per-total and per-file, and it exited 0. The only movement is `eslint`
downward, from removing the two suppressions in `apps/api/src/routes/auth.ts`.

Two corrections to how earlier reporting in this order stated the ceilings:

- The ceilings are **59 / 136 / 29**, as declared in
  `docs/adr/ADR-005-technology-selections.md:19` — the sole definition site in the
  repository. Correspondence during this order repeatedly quoted the third value
  as **23**; that was wrong, and this table now matches the ADR. The delivery is
  compliant on either reading, since `format` debt is 1.
- **No tool enforces a ceiling.** `scripts/quality-ratchet.ts` contains no ceiling
  concept at all (`grep -c ceiling` → 0); it refuses growth against
  `quality-baselines.json` and nothing more. A claim that "no ceiling was raised"
  is therefore a statement about a document, not about a gate. Recorded in
  KNOWN-LIMITATIONS.

### Formatting

`npx prettier --check` over all **93** changed/new non-SQL files →
_All matched files use Prettier code style!_ (Prettier has no SQL parser;
`migrations/057_identity_boundary_completion.sql` is excluded for that reason,
which is also how the repository's own `format` ratchet selects files.)

### Raw-output sentinel scan

Both raw TAP logs were scanned for **every** sentinel literal declared anywhere
in `tests/` and `packages/*/src` (25 distinct values, including
`SENTINEL-DB-PASSWORD-hunter2`, `SENTINEL STEP UP TOKEN`,
`SENTINEL SET COOKIE VALUE`, `SENTINEL-CONNECTION-STRING-user:pass@host`) →
**0 matches in both runs**.

Additional shape scan over both raw logs: `eyJ` (JWT), `Bearer <token>`,
`set-cookie`, `refresh_token`, `client_secret`, `sk_live`/`sk_test`/`client_…`,
`wos_`, any 64-character hex run, any e-mail address, `password`,
`code_verifier` → **0 matches each**. `nonce` matches 16 times; every one is a
test NAME, no value.

## 8. Migration 057 on a POPULATED pre-057 database

Performed locally on PostgreSQL 16 at `127.0.0.1:55434`, using the real
`scripts/migrate.ts` runner, not `psql`.

**Setup.** A database was migrated to `056` only (`MIGRATIONS_DIR` restricted to
`000`+`049`–`056`), then seeded with one row for every branch `057` must
reconcile plus controls it must not touch: 2 tenants, 3 connections (one active
dealership, one **disabled** dealership so its tenant has zero active
connections, one platform), 5 user links, 4 identity sessions, 2 reauthentication
transactions, 2 support-access requests, 1 live support-access session.

**Result: `057` applied cleanly.** Row-by-row outcome:

| Fixture                                                   | Expected                                                   | Observed                                                                                                                                                            |
| --------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| link in a tenant with exactly one ACTIVE connection       | bound (connection, org, issuer)                            | bound to `org_t1` / `https://issuer.example/t1` ✔                                                                                                                   |
| link in a tenant with ZERO active connections             | deactivated and left unbound                               | `status=deactivated`, `connection_id` NULL, org NULL, issuer NULL ✔                                                                                                 |
| live session naming its connection and an agreeing issuer | subject + organization DERIVED, session stays LIVE         | `provider_subject=u_alice`, `provider_organization_id=org_t1`, not revoked ✔                                                                                        |
| live session with NULL connection                         | revoked `fbl_020_r2_unprovable_binding`                    | exactly that ✔                                                                                                                                                      |
| live session whose link 057 unbinds                       | revoked `fbl_020_r3_unprovable_subject_or_org`             | exactly that ✔                                                                                                                                                      |
| session already revoked before 057                        | untouched, original reason preserved                       | `operator_logout` intact ✔                                                                                                                                          |
| `started` reauthentication transaction, unbound           | `expired`                                                  | `expired` ✔                                                                                                                                                         |
| `failed` reauthentication transaction (control)           | untouched                                                  | `failed` ✔                                                                                                                                                          |
| `approved` support request with NO approving grant        | superseded: decider preserved, status `expired`, version+1 | `status=expired`, `superseded_reason=fbl_020_r3_no_approving_grant`, `superseded_decided_by…` set, `decided_by`/`decided_at` cleared, `authorization_version` 1→2 ✔ |
| its live support session                                  | ended, attributed to nobody                                | `revoked_at` set, `revoked_by_user_link_id` NULL ✔                                                                                                                  |
| `denied` support request (control)                        | untouched                                                  | `denied`, decider intact, version 1 ✔                                                                                                                               |
| audit                                                     | exactly one `identity.support.approval_superseded` row     | exactly one, carrying reason, previous status and previous decision instant ✔                                                                                       |

**Nothing was invented.** Row counts before → after are identical for every
table: tenants 2→2, connections 3→3, user_links 5→5, identity_sessions 4→4,
reauth_txns 2→2, reauth_grants 0→0, support_requests 2→2, support_sessions 1→1,
role_bindings 0→0, policy_decisions 0→0, login_transactions 0 (new table). The
single addition is `audit_events` 0→**1**, the documented supersede row.

### The proof that reconciliation is LOAD-BEARING

Two negative controls were run on byte-identical clones of the same populated
pre-057 database.

**NEG-A — both subject/organization reconciliation statements removed**
(`057` lines 228–246 deleted, everything else untouched, applied with
`--single-transaction`):

```
ERROR:  check constraint "is_live_session_fully_bound" of relation
        "identity_sessions" is violated by some row
```

The migration aborted and **nothing applied** — the clone still has no
`provider_subject` column and no `login_transactions` table. This is the exact
failure the migration's own header claims it was written to prevent, reproduced
on demand.

**NEG-B — only the DERIVE removed, the revoke-the-unprovable statement kept:**
the migration completed, but the one **provable** live session was revoked
`fbl_020_r3_unprovable_subject_or_org`. So the derive is not decoration either:
without it, a session that could be proven is destroyed rather than carried
forward.

## 9. Fresh chain and fingerprint convergence

- Fresh database, all ten migrations from empty: **succeeded**, 10/10 applied.
- Schema fingerprint, fresh chain: `d60eb830e07c47102c716b93fc85b9e9f21584d51915f3f2f74c2e09c157fe34`, 41 tables.
- Schema fingerprint, the **populated database upgraded through 057** above:
  `d60eb830e07c47102c716b93fc85b9e9f21584d51915f3f2f74c2e09c157fe34`, 41 tables.
- **`equal = true`.**

These are LOCAL values (PostgreSQL 16 on Windows). Catalog text differs across
PostgreSQL builds, so the authoritative comparison is the in-CI one, which does
not yet exist for this tree — see §12. The R2 report's in-CI fingerprint
`59107a0b…` described the R2 schema and does **not** describe this one, because
`057` changed.

## 10. Exact changed-file list

Base: **`cac9b21`**. **94 paths: 53 modified, 41 new.** Excluding this report,
whose own line delta cannot be quoted from inside itself without going stale on
the next edit: **52 files changed, +12,755 / −1,366** in the tracked diff, plus
**41 new files**.

> Reproduce:
> `git diff --shortstat cac9b21 -- . ':(exclude)docs/FBL-020-DELIVERY-REPORT.md'`
> and `git diff --numstat cac9b21 -- <path>` per row. Excluding only this file is
> what makes the table a fixed point: every other document it counts is one this
> report does not edit, so correcting a row here cannot invalidate another row.
> That property is not free — the R3 review found this table's
> `KNOWN-LIMITATIONS.md` row stale twice, once carried forward from an earlier
> revision and once because correcting §11 required editing that very file. Both
> are fixed; §11.11 records why nothing prevents a third.

### Modified (53)

| Path                                                      | +/−                                        |
| --------------------------------------------------------- | ------------------------------------------ |
| `apps/api/src/index.ts`                                   | +2 / −1                                    |
| `apps/api/src/middleware/auth.ts`                         | +146 / −35                                 |
| `apps/api/src/routes/auth.ts`                             | +289 / −100                                |
| `docs/DEVELOPMENT.md`                                     | +34 / −3                                   |
| `docs/FBL-020-DELIVERY-REPORT.md`                         | (this file — self-referential, not quoted) |
| `docs/PHASE-248-SERVICE-COCKPIT-V2.md`                    | +21 / −19                                  |
| `docs/adr/ADR-006-workos-authkit-identity.md`             | +68 / −0                                   |
| `docs/adr/ADR-007-organization-hierarchy-policy.md`       | +81 / −0                                   |
| `docs/adr/ADR-008-support-access.md`                      | +71 / −0                                   |
| `docs/architecture/THREAT-MODEL-DELTA-FBL-020.md`         | +87 / −32                                  |
| `docs/identity/AUTH-FLOWS.md`                             | +326 / −39                                 |
| `docs/identity/DATA-DICTIONARY.md`                        | +129 / −6                                  |
| `docs/identity/KNOWN-LIMITATIONS.md`                      | +313 / −23                                 |
| `docs/identity/ROLE-ACTION-SCOPE-MATRIX.md`               | +22 / −14                                  |
| `docs/runbooks/TENANT-BOOTSTRAP-RUNBOOK.md`               | +145 / −19                                 |
| `docs/runbooks/WORKOS-OPERATOR-RUNBOOK.md`                | +261 / −17                                 |
| `migrations/057_identity_boundary_completion.sql`         | +573 / −27                                 |
| `package.json`                                            | +1 / −1                                    |
| `packages/database/src/index.ts`                          | +8 / −1                                    |
| `packages/database/src/pool.ts`                           | +483 / −11                                 |
| `packages/identity-access/src/actions.ts`                 | +9 / −2                                    |
| `packages/identity-access/src/actor.ts`                   | +54 / −15                                  |
| `packages/identity-access/src/contracts.ts`               | +173 / −0                                  |
| `packages/identity-access/src/index.ts`                   | +2 / −0                                    |
| `packages/identity-access/src/login-transaction.ts`       | +114 / −21                                 |
| `packages/identity-access/src/oidc/token-verifier.ts`     | +87 / −5                                   |
| `packages/identity-access/src/policy.ts`                  | +303 / −39                                 |
| `packages/identity-access/src/provider/workos/adapter.ts` | +208 / −1                                  |
| `packages/identity-access/src/reauthentication.ts`        | +313 / −110                                |
| `packages/identity-access/src/sealed-cookie.ts`           | +30 / −3                                   |
| `packages/identity-access/src/session.ts`                 | +1284 / −33                                |
| `packages/identity-access/src/support-access.ts`          | +9 / −206                                  |
| `packages/identity-access/src/user-link.ts`               | +201 / −175                                |
| `packages/platform/src/config.ts`                         | +134 / −15                                 |
| `packages/platform/src/errors.ts`                         | +29 / −0                                   |
| `packages/platform/src/problem-details.ts`                | +1 / −0                                    |
| `packages/test-kit/src/db.ts`                             | +8 / −0                                    |
| `packages/test-kit/src/identity.ts`                       | +139 / −28                                 |
| `quality-baselines.json`                                  | +1 / −2                                    |
| `scripts/bootstrap-identity.ts`                           | +63 / −9                                   |
| `scripts/migrate.ts`                                      | +21 / −9                                   |
| `scripts/verify-upgrade-state.ts`                         | +7 / −0                                    |
| `tests/architecture.test.ts`                              | +452 / −0                                  |
| `tests/auth-surface.test.ts`                              | +43 / −6                                   |
| `tests/auth.test.ts`                                      | +844 / −17                                 |
| `tests/identity-boundary.test.ts`                         | +3895 / −132                               |
| `tests/identity-config.test.ts`                           | +239 / −7                                  |
| `tests/identity-core.test.ts`                             | +173 / −10                                 |
| `tests/identity-journey.test.ts`                          | +56 / −31                                  |
| `tests/integration.test.ts`                               | +149 / −0                                  |
| `tests/organization.test.ts`                              | +74 / −31                                  |
| `tests/policy.test.ts`                                    | +346 / −40                                 |
| `tests/reauthentication.test.ts`                          | +234 / −71                                 |

### New (41)

| Path                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Lines    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `apps/api/src/identity/provider.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 58       |
| `packages/identity-access/src/mutations.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 1385     |
| `packages/identity-access/src/session-view.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 230      |
| `scripts/check-role-binding-effectiveness.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 1967     |
| `tests/support/pool-fatal-child.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 414      |
| `architecture/fixtures/role-binding-correct/` — `README.md` (42), `aliased-import.ts` (33), `assembled-with-shared-predicate.ts` (56), `direct-import.ts` (26), `namespaced-import.ts` (29), `prose-is-not-sql.ts` (30), `raw-regex-is-not-sql.ts` (27)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 7 files  |
| `architecture/fixtures/role-binding-drift/` — `README.md` (84), `control-1-coalesce-hidden-filter.ts` (27), `control-2-no-filter-at-all.ts` (23), `control-3-uppercase-and-schema-qualified.ts` (34), `control-4-cte-rename-and-second-read.ts` (50), `evasion-a-interpolated-table-name.ts` (33), `evasion-b-assembled-fragments.ts` (50), `evasion-c-neutralised-predicate.ts` (62), `evasion-d-unvalidated-opt-out.ts` (29), `evasion-d2-opt-out-validation.ts` (59), `evasion-e-unresolvable-table.ts` (29), `evasion-f-shadowed-predicate.ts` (34), `evasion-g-lookup-map-table.ts` (41), `evasion-h-loop-over-table-list.ts` (36), `evasion-i-alternative-table.ts` (65), `evasion-j-array-join.ts` (63), `evasion-k-string-concat.ts` (41), `evasion-l-string-raw.ts` (51), `evasion-m-opaque-string-operations.ts` (50), `evasion-n-reduce-accumulation.ts` (34), `evasion-o-custom-template-tag.ts` (35), `evasion-p-array-transforms.ts` (71), `evasion-q-indexed-fragments.ts` (44), `evasion-r-accumulated-statement.ts` (46), `evasion-s-blind-full-table-read.ts` (48), `evasion-t-guarded-once-counted-twice.ts` (61), `evasion-u-comment-carried-weakening.ts` (50), `evasion-v-predicate-in-projection.ts` (37), `evasion-w-negated-without-an-adjacent-not.ts` (55) | 29 files |

**Working-tree hygiene:** no `.tmp-*`, `*.tmp`, `*.orig`, `*.rej`, `*.bak`,
scratch or probe files exist anywhere in the tree. The only untracked-and-ignored
paths are `node_modules/`, `artifacts/`, per-package `dist/` and
`tsconfig.tsbuildinfo` build outputs.

## 11. Residual risk — everything still open after five waves

Stated so the architect can make their own call. The full register, with
reproduction detail, is `docs/identity/KNOWN-LIMITATIONS.md`; this is the summary
of what a reviewer should weigh.

1. **No live WorkOS behaviour is exercised — Gate B is BLOCKED.** Real AuthKit
   redirect parameters, real token claim shapes, real `max_age=0` semantics, real
   organization membership and the **actual MFA-required organization policy** are
   untested. So is the SDK adapter itself: `createWorkosProvider` compiles and is
   architecture-tested for confinement, but no test invokes it. Every provider
   property is proven through the provider-neutral port against a fake. _Reproduce:
   there are no credentials; the substitution point is
   `useIdentityProviderForTests`._

2. **The drift guard cannot be walked around only by accident.** Five of the
   eleven enumerated bypasses remain open: a `CASE` arm that computes the
   predicate and discards the result; array assembly by `unshift`, `splice` or
   index assignment; and `Object.keys(FRAGMENTS).join('')`. Closing the first
   means parsing SQL; the other four are limits of the static evaluator, which
   models `push` and object VALUES. All five are declared in the guard's own
   "WHAT IT CANNOT SEE". _Reproduce: the shapes are spelled out in
   `docs/identity/KNOWN-LIMITATIONS.md` § "Sharp edges"; each requires writing SQL
   in a way no statement in this repository is written._ The guard is a
   **build-time drift guard, not a runtime control** — every runtime predicate it
   protects is independently pinned by mutation-killed tests.

3. **Rule 4 still cannot report a blind table position that carries no second
   structural mark** — `DELETE FROM ${table}` alone, or
   `INSERT INTO ${table} SELECT … FROM audit_events`. Requiring the second mark is
   what stops the rule reporting the word "update" in prose. Neither shape is a
   read, which is what the effectiveness rule governs.

4. **`withTransaction` ABANDONS its body when the connection is lost; it does not
   cancel it.** It can reject **while `fn` is still running**, and a Promise
   cannot be cancelled, so the body's continuation keeps executing after the
   caller was told the operation failed. Database work cannot leak — the client is
   destroyed on release — but **non-database side effects still complete**: an
   outbound HTTP call, a cache write, an enqueued job, running after the failure
   was reported and with nothing awaiting them. _Measured by the `abandoned-body`
   probe in `tests/support/pool-fatal-child.ts`, as recorded by the R3 review and
   not re-timed in this closeout: the caller was told at 463 ms,
   all three of the body's side effects ran at 2,054 ms, and the statement the
   body issued afterwards was refused._ The rule this puts on callers — do
   best-effort non-database work after the commit, never inside the body — is on
   `withTransaction` itself and in KNOWN-LIMITATIONS, and `I2(ii)` fails if either
   write-up disappears.

5. **The surviving pool caveat: a lost-connection log line does not always carry
   a SQLSTATE.** One broken connection can be visible twice — the Postgres FATAL
   and the socket reset are the same failure — and the first observation is
   reported. Under a concurrent burst that is sometimes the bare socket reset,
   which carries none (measured by the R3 review, not re-measured in this
   closeout: **2 of 20** requests at `PGPOOL_MAX=3`, 20
   concurrent transactions, 300 ms idle bound). A genuinely severed socket carries
   none either. Those requests are still typed, still 503, still retryable — the
   missing field is diagnostic only. `DatabaseConnectionLostError.pgCode` is
   documented as **best-effort**; the **class** is the contract to branch on.
   Guaranteeing the SQLSTATE would mean holding every rejection open waiting for a
   second observation that may never arrive, giving back the prompt failure the
   mechanism exists to provide.

6. **A due refresh costs one request a provider round trip, and a JWKS outage
   longer than the key cache now costs SESSIONS, not just logins.** Making the
   refresh reachable created this exposure and it is stated plainly: a refresh
   whose replacement token cannot be verified REVOKES the session, because the
   exchange has already spent the presented refresh token. Bounds: keys are cached
   ten minutes, a cached hit makes no network call, and in that state every bearer
   request and every login is already failing closed. Preferred mitigation is to
   move the exchange off the request path — **not** to accept an unverified
   replacement token.

7. **Migration-057 ordering is proven by drill and by the CI upgrade job, not by
   an in-suite test.** §8 is reproducible by hand and NEG-A is a genuine negative
   control, but nothing in `npm test` fails if a future edit reorders the file.

8. **No HTTP administration surface exists.** The `identity.*` / `org.unit.*`
   actions and the engine that decides them ship, but no route declares them.
   Administration is the owned mutation services or the audited bootstrap command;
   raw `INSERT`s into `role_bindings` bypass versioning, authority and audit.

9. **Durable audit delivery is not claimed** (audit rows are transactional;
   the outbox is FBL-040). **Row-level security is FBL-030.** **SAML/SCIM are
   interfaces only, unenableable by database CHECK.** **`step_up_token_uses`
   (migration 050) is dead weight** — no longer written or read; dropping it is a
   future migration.

10. **Local schema fingerprints are corroboration only.** ~~The authoritative
    fresh-vs-upgraded comparison is the in-CI one, and it has not run for this
    tree.~~ **DISCHARGED.** It has now run: §12 records
    `dcfffc97630b664feccacee70b0a1aebb28e50d69d00c7fdc741c6c0aa0bc15a` for both
    fresh and upgraded across 41 tables, `equal=true`, from
    `upgrade-evidence/fingerprint-equality.txt` of run `31223131820` on
    `f816642`. The original wording is struck through rather than deleted so the
    register shows what was open at code-freeze and what closed afterwards.

11. **No gate pins any figure in this report, and that risk has already
    materialised twice in this order.** Nothing in `tests/`, `scripts/` or
    `.github/` reads this document, so every count, diffstat, ratchet value and
    checksum here rests on manual diligence with no mechanical backstop. This is
    how the R2 report came to describe a head two commits and 94 working-tree
    paths in the past (§2), and the final review pass of this delivery caught a
    second instance: §10's row for `docs/identity/KNOWN-LIMITATIONS.md` had been
    carried forward as `+231 / −24` from a revision preceding a later edit.
    Correcting it was not a single fix: recording the correction in
    `KNOWN-LIMITATIONS.md` changed that file's own diff, three times, before the
    self-referential figure was removed from it and the row settled at the
    `+313 / −23` now shown above. Every one of those was caught by a reviewer
    recomputing the table; none by a gate. The general lesson is in §10's
    reproduce note — a document that states its own diff invalidates that
    statement whenever it is edited, and only this report's exclusion of itself
    makes the table converge at all.
    Migration checksums are the one part with a defence — they are published
    beside their git blob OIDs, so a stale value can be caught by re-deriving it.
    _Treat every other figure in this report as true-when-written, and re-measure
    before quoting it._ Recorded in `docs/identity/KNOWN-LIMITATIONS.md`.

## 12. CI evidence — measured

Filled in after the code-bearing commit was pushed and after the run whose
`head_sha` **equals that commit** reported a conclusion. No value here comes from
any other run; R2's run `30929301450` belongs to head `ff31370` and a different
migration 057, and was not used.

| Field                     | Value                                                                                  |
| ------------------------- | -------------------------------------------------------------------------------------- |
| Code-bearing commit SHA   | `f816642a92c8d8d1c3c86ad7670b24ef43c67b62`                                             |
| CI run id                 | `31223131820`                                                                          |
| Run URL                   | https://github.com/Alegnta19/Car-dealership-software/actions/runs/31223131820          |
| `head_sha` equals commit? | **YES** — API returned `f816642a92c8d8d1c3c86ad7670b24ef43c67b62`, compared explicitly |
| Event                     | `push`                                                                                 |
| Status / conclusion       | `completed` / **success**                                                              |

| Job                                              | Conclusion  |
| ------------------------------------------------ | ----------- |
| typecheck, lint ratchet, build, all tests, scans | **success** |
| upgrade from earliest retained schema fixture    | **success** |
| container build (digest-pinned base)             | **success** |
| secret scan (genuine full history)               | **success** |

| Artifact               | Size     | sha256 (of the downloaded zip)                                     |
| ---------------------- | -------- | ------------------------------------------------------------------ |
| `baseline-evidence`    | 57,804 B | `1acdcff5b31a4a2cde1b499c5f9cb35c1431bdaba48935868c1646e3f43291e6` |
| `upgrade-evidence`     | 32,005 B | `8e023ad2b3dd33222ca87eac5e9771d4117f6e4b0034bd095078851583adcd9c` |
| `secret-scan-evidence` | 8,109 B  | `19d2b3c168fd2ab92ed9194cc963ab29bc0a002c46aaca866e843f01b58b3cf9` |
| `container-evidence`   | 701 B    | `1914f166f8258400df4e3b2f5058048316d4b0aa62299ed86afcafb43f77ca5c` |

### Read from the run's own artifacts, not from a local run

`baseline-evidence/test-summary.json`:

```json
{
  "tests": 315,
  "suites": 29,
  "passed": 315,
  "failed": 0,
  "cancelled": 0,
  "skipped": 0,
  "todo": 0,
  "duration_ms": 96537.537887
}
```

**315 / 315, zero failed, cancelled, skipped or todo** — identical to the local
figure in §7, which is the point: the local run is corroboration and this is the
authority.

`upgrade-evidence/fingerprint-equality.txt` — this discharges §11.10, which
recorded that only the in-CI comparison is authoritative:

| In-CI schema fingerprint | Value                                                              |
| ------------------------ | ------------------------------------------------------------------ |
| fresh                    | `dcfffc97630b664feccacee70b0a1aebb28e50d69d00c7fdc741c6c0aa0bc15a` |
| upgraded                 | `dcfffc97630b664feccacee70b0a1aebb28e50d69d00c7fdc741c6c0aa0bc15a` |
| equal                    | **true**                                                           |
| tables                   | 41                                                                 |

`secret-scan-evidence/scan-evidence.txt` — gitleaks `v8.24.3`, image pinned by
digest, `--log-opts=--all` over the genuine full history: **51 commits scanned,
~3.21 MB, no leaks found**, 52 revisions and 10 remote branches in scope.

`container-evidence/image-digest.txt` —
`sha256:45955b9f2ca26bc296ff87f9ddf8002b119445f0398dfe46a817110b67888e41`.

`baseline-evidence/tool-versions.txt` — `node=v20.20.2`, `npm=10.8.2`,
`tsc=5.9.3`, `eslint=v10.8.0`, `prettier=3.9.6`,
`postgres:16-alpine@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777`.
The pinned toolchain and the digest-pinned database image are the ones the order
requires.

**The CI gate is DISCHARGED for the code-bearing commit.** This documentation
closeout commit is itself a second commit and runs its own build; its result does
not retroactively alter anything above, which describes `f816642` only.

## 13. Position

FBL-000 closed → FBL-010 closed → **FBL-020-R3 submitted for code-gate review**
→ live WorkOS certification **BLOCKED** (no credentials) → FBL-030 **not
started**.
