# FBL-020 — Identity Boundary: Delivery Report (R4)

Governing document: see **§0**, which records what the documents in hand actually
say rather than citing a section from memory. R3's citation — "Master Blueprint
v2.0, §14.3", unqualified — was rejected, and correctly: two different blueprints
are in hand, their §14.3 are different orders, and neither contains the word R4.

This report supersedes the R3 report in full. **R3 was REJECTED for MISSING
MANDATORY CONTROLS**, not for a defect in what it built; the CI runs and artifacts
it produced were accepted as genuine. Sections 1–12 are retained where they remain
true of this tree and corrected where they are not. §13 records the CI position,
§14 is what R4 adds, and §15 lists the gates that are NOT DISCHARGED.

**The R4 CI gate is DISCHARGED.** Code-bearing commit
`2b75d8abbbf68f3e95c4542540ad90ade7da844f`; `ci.yml` run `32028562952`, `event=push`,
`head_sha` equal to that commit, all four jobs `success`, four evidence artifacts —
recorded with their digests in §13. Run ids quoted elsewhere in this document belong to
R2 or R3 and are labelled as such.

§13 was written as an explicit placeholder and shipped that way inside the code-bearing
commit, because no run for a commit can exist before the commit does; it was filled in
afterwards, from the run matched on `head_sha` and on workflow path. That ordering is the
point. Filling a CI section from a run that measured a different tree is the R2 defect
described in §2, and §13 records the attempt that nearly repeated it here: a poller that
took `runs[0]` for the SHA returned a **Dependabot** run, one job, no artifacts,
`conclusion: success`.

## 0. The governing document — what it actually says

Two blueprint families are on this machine, in `C:\Users\alegn\Downloads`, and
they are **different documents with different section numbering**. The wrong
citation came from treating them as one.

**THE GOVERNING DOCUMENT.** Title: _Dealership Management & Sales Cloud — Master
Architecture Blueprint and Forward-Only Roadmap_. Its version line, transcribed
character for character from the document's own cover block (the separators are
two spaces around each pipe):

```
Version 2.0  |  August 4, 2026  |  Governing management-first baseline
```

File `Car_Dealership_Management_and_Sales_Cloud_Master_Blueprint.docx`, two
byte-identical copies, sha256
`556d4e108c9db8b7dcfee284828f926157f7663d260d3d3e0d8774bb032feaaf`.

**THE SUPERSEDED DOCUMENT**, present on the same machine and the source of the
confusion. Title: _Car Dealership SaaS — Repository Assessment and Industrial
Platform Blueprint_. Its version line:

```
Version 1.0  |  July 30, 2026  |  Architecture baseline
```

File `Car_Dealership_SaaS_Architecture_Blueprint.docx`, three byte-identical
copies, sha256
`d38ad00ad2cd5a13ac087dbb96a34a4c133d0e5bfe8c81d9820a0b69f31e03f9`.

Their §14 headings, transcribed:

| §    | Superseded (Version 1.0)                              | **Governing (Version 2.0)**                                      |
| ---- | ----------------------------------------------------- | ---------------------------------------------------------------- |
| 14.3 | `14.3 Work Order FBL-000 — Reproducible Baseline`     | `14.3 First active instruction — FBL-020-R2`                     |
| 14.4 | `14.4 Work Order FBL-010 — Architecture Shell`        | `14.4 Accepted historical order FBL-000 — Reproducible Baseline` |
| 14.5 | `14.5 Work Order FBL-020 — Identity and Organization` | `14.5 Accepted historical order FBL-010 — Architecture Shell`    |
| 14.6 | `14.6 Definition of done for every later order`       | `14.6 Original FBL-020 scope — retained context only`            |

So **FBL-020 is governed by §14.3 of the Version 2.0 document**, whose heading is
`14.3 First active instruction — FBL-020-R2`. In the Version 1.0 document FBL-020
is §14.5 instead, and §14.3 there is FBL-000 — which is why an unqualified
"v2.0 §14.3" could not be checked by a reader and had to be corrected.

Three further facts, stated because they bound what the citation proves:

- The v2.0 document's own §14.6 marks the original FBL-020 scope as **"retained
  context only"** and says the §14.3 instruction "is the only active and governing
  implementation order".
- §14.3 names revision **R2**. **Neither document contains the word R4**: R3 and R4
  are architect-issued correction orders delivered as order text, not as sections
  of either DOCX. Their content is therefore not quotable from a file in this
  repository, and no claim in this report rests on quoting them.
- The v2.0 §14.3 quality ceilings — `tsc-strict <=59`, `eslint <=136`,
  `format <=23` — are the ceilings this delivery still respects; the ratchet
  baselines in §7 sit below them and were not raised. This paragraph and §7 now
  agree; they did not in R3, which is the subject of §7's ceiling note.

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
checkpoint commits, two revisions and **139 changed paths** past. Migration 057
itself has been edited (**+1278 / −33 lines against `cac9b21`**, 1,482 lines
total), so its checksum moved twice — once in R3 and again in R4. Nothing
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
| **14** | **Test proofs above the R2 count of 230.** Delivered at the R3 head: **315**, i.e. **+85**, all green with zero skips. On the R4 tree the count is **459 / 47 suites** (§7); this row records the R3 gate as it was discharged.                                                                                                       | `tests/`                                                                                                         | §7                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

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

| ID     | Sev          | What it was                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | How it was closed                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Test that pins it                                                                                                                                                                                                                     |
| ------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A2** | High         | One reauthentication grant could authorize more than one support approval if a future code path reintroduced its own grant predicate: single-use was enforced only in application SQL.                                                                                                                                                                                                                                                                                                                                    | A unique index in migration 057 makes one grant approve at most one request, installed **after** its own reconciliation so a database that had ever recorded two would not abort the migration.                                                                                                                                                                                                                                                                       | `tests/identity-boundary.test.ts` — _a support-approval grant is bound to its action, its request and ONE use_                                                                                                                        |
| **A3** | **Critical** | The platform-support authority predicate checked `rb.status = 'active'` and the user LINK's window but omitted the BINDING's window. A `platform_support` binding whose `effective_to` was a day in the past still filed support requests the engine returned zero rows for.                                                                                                                                                                                                                                              | The predicate now interpolates the engine's own `EFFECTIVE_ROLE_BINDING_SQL`; there is no second window to forget.                                                                                                                                                                                                                                                                                                                                                    | `tests/identity-boundary.test.ts` — _a windowed-out platform_support binding cannot file a support request_                                                                                                                           |
| **B1** | **Critical** | The insecure-HTTP override permitted plain HTTP and non-`Secure` cookies on ANY host, and the `Secure` decision rested on `NODE_ENV` alone — so a real deployment with all-remote identity URLs running `NODE_ENV=development` issued session, transaction **and clearing** cookies without `Secure`.                                                                                                                                                                                                                     | The override is removed. Dropping `Secure` requires `NODE_ENV` in {development, test} **AND** every identity URL on a loopback host. Clearing preserves `Secure`, path, `SameSite`, `HttpOnly`.                                                                                                                                                                                                                                                                       | `tests/identity-config.test.ts` — _a REMOTE deployment keeps Secure cookies even at NODE_ENV=development_; _ONLY development\|test with EVERY identity URL on loopback drops Secure_                                                  |
| **B2** | High         | Assurance in the policy evidence row was computed from the actor's freshest session (`ORDER BY auth_time DESC LIMIT 1`), not the credential the request presented. With R3 minting local sessions for both credential kinds, a request on a six-hour-old cookie was recorded as `fresh`.                                                                                                                                                                                                                                  | Assurance is computed about the PRESENTED session id — the same id the evidence row records and an operator can revoke — in one statement, with `not_applicable` when nothing live was presented.                                                                                                                                                                                                                                                                     | `tests/identity-boundary.test.ts` — _a decision records the GENERATED ids and REAL, computed assurance_                                                                                                                               |
| **B3** | High         | A `platform.*` control-plane role name could be granted at a tenant scope, and control-plane actions were reachable from scopes that should not carry them.                                                                                                                                                                                                                                                                                                                                                               | Platform roles are DERIVED from the published catalog; the misgrant is refused at the write rather than recorded, and the engine reaches a control-plane action only from a platform-scope binding.                                                                                                                                                                                                                                                                   | `tests/policy.test.ts` — _a platform role at TENANT scope reaches no platform.\* action, and cannot be granted_                                                                                                                       |
| **C2** | High         | Login observation wrote its `audit_events` row on the deactivated and pending branches and **nothing** on the activated branch — the only branch that goes on to mint a session — while the module header claimed every observation wrote one. The trail recorded precisely the logins that did not get in.                                                                                                                                                                                                               | The successful login is audited too, recording which fields changed rather than their values, and carrying no email and no display name.                                                                                                                                                                                                                                                                                                                              | `tests/identity-core.test.ts` — _R3: an ACTIVATED login writes its audit event, carrying no email and no display name_                                                                                                                |
| **E1** | High         | `getSessionView` restated the effectiveness rule as `rb.status = 'active'`, so a binding left active with `effective_to` in the past was reported to the user as a held role with an effective scope, while the engine denied every action it named.                                                                                                                                                                                                                                                                      | The view interpolates `EFFECTIVE_ROLE_BINDING_SQL`; the page cannot claim authority the engine refuses.                                                                                                                                                                                                                                                                                                                                                               | `tests/identity-boundary.test.ts` — _the session view reports NO role and NO scope for a windowed-out binding_                                                                                                                        |
| **E2** | **Critical** | `rolesForUserLink` restated the same rule, and the API middleware writes that list into `req.tenantContext.roles`, which the Fixed Ops cockpit reads through `hasAnyRole` to decide SUPERVISOR reach. A technician whose `service_advisor` binding had aged out kept supervisor reach, so ownership guards stopped applying and another technician's MPI session and work ticket became reachable.                                                                                                                        | Both queries interpolate the shared predicate.                                                                                                                                                                                                                                                                                                                                                                                                                        | `tests/integration.test.ts` — _a windowed-out supervisor binding stops widening technician reach_; _another technician MPI session and work ticket become unreachable_                                                                |
| **E3** | High         | **No build-time guard existed against the drift class at all.** Wave 2 answered A3/E1/E2 by exporting the predicate once as `EFFECTIVE_ROLE_BINDING_SQL` — and then shipped two more readers that restated it anyway. Review demonstrably does not hold this line.                                                                                                                                                                                                                                                        | `scripts/check-role-binding-effectiveness.ts` was added to `npm run architecture:check`, so a second hand-written copy, a neutralised copy, or SQL the guard cannot read fails the build. As R3 measured it: 17 statements inspected, 6 declared opt-outs. On the R4 tree the same guard reports 21 statements inspected and 9 declared opt-outs, and it is joined by a sixth check (the owned-mutation guard, R4 §5). (Its own escapability is defect **H1**, §5.1.) | `tests/architecture.test.ts` — _the real tree passes, and every exception declares a recognised reason code_; _the role-bindings effectiveness rule has exactly one implementation_                                                   |
| **F1** | **Critical** | The platform-support authority check was wired into the FILING gate only. Approval mints a fresh 60-minute window into tenant data and starting a session does the same — so revoking a platform actor's binding, the natural offboarding action, left a pending request that could still be turned into live access.                                                                                                                                                                                                     | The requester's platform authority must still be current at approval and at session start; losing the binding is offboarding.                                                                                                                                                                                                                                                                                                                                         | `tests/identity-boundary.test.ts` — _a REVOKED requester binding blocks approval, keeps the request pending and spends no grant_; _startSupportSession refuses an approved request whose requester was offboarded after the approval_ |
| **F2** | Medium       | An `approver_assurance` column presented itself as the approval bar — with a CHECK enumerating the vocabulary — and nothing read it. The bar is stated in code. Schema that looks authoritative and is not is a trap.                                                                                                                                                                                                                                                                                                     | The column was **deleted** rather than wired up, because honouring it would have added a per-request downgrade knob on the one gate that lets a platform person into tenant data.                                                                                                                                                                                                                                                                                     | `tests/identity-boundary.test.ts` — _no support-request column presents an approval assurance bar that nothing reads_                                                                                                                 |
| **I1** | High         | A lost connection was classified from WHICH RACER WON, not from the error. When a FATAL landed on an IN-FLIGHT statement — a restart, a failover, `pg_terminate_backend`: the ordinary production shape — pg rejected the query before the socket `'error'` event, so the caller got `500 internal_error`, `retryable=false`, and nothing retried a purely retryable infrastructure failure. The same await ordering skipped the ROLLBACK suppression, so a second, misleading error was logged on top of the real cause. | Classification is made from the error itself; the rollback suppression is decided after the awaits it depends on.                                                                                                                                                                                                                                                                                                                                                     | `tests/identity-boundary.test.ts` — _I1(a): a FATAL on an in-flight statement is a typed, retryable 503_; _I1(b): that path logs the real cause once and no misleading ROLLBACK failure_                                              |

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

Do **not** substitute `HEAD` in that command while reading this document. `HEAD` is
`9cba262`, the R3 documentation closeout; R4 is an uncommitted working tree on top
of it. Nine of the ten rows reproduce from `HEAD` anyway because those blobs are
frozen; `057` is the one row that has moved, and from `HEAD` it yields
`a430d1f4f533b96b963bb6e96e711c0b768baf600c93e1b1896d08fa26c611c0` — the value R3
published — which is superseded by the one in the table below.

**R4 IS NOT A NEW MIGRATION.** The architect's §0 census established that no
persistent environment has ever applied `057`, so it is corrected IN PLACE and no
`058` exists. The runner now records a canonical-LF checksum per applied migration
(§14, R4 §0), so an environment that HAD applied an earlier `057` would refuse the
run and name both digests rather than silently skipping the changed body.

The values are **NOT** Windows working-tree values. This working copy checks out
with `core.autocrlf=true`, so a raw `sha256sum` of a working file can disagree with
CI and with every other machine. **R4 correction to R3's wording here:** R3 stated
that all ten files carry CRLF on disk. Re-measured on this tree that is no longer
true — the editing tooling writes LF — and the honest measurement is: `050` carries
166 CRLF lines, and the other **nine files carry none**. Which is exactly why the
digests published below, and the ones the migration ledger now records, are
**canonical-LF**: normalizing first makes the value identical on Windows and in CI
whichever way any individual file happens to sit on disk, and identical to the file
as committed. **Earlier reporting in this order quoted working-tree sha256 values
for migration 050; those are superseded by the table below.**

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
| **`057_identity_boundary_completion.sql`**   | **`9805ddf99aebd0c14acead2f25f69b73df743e41`** | **`add07aaf9178c9677fe30cb969f3fd1b8ce51c379da26cd7e47be8400ab189a3`** |

**Byte-identity of the frozen chain, measured against `cac9b21`:** the blob OIDs
for `000` and `049`–`056` above are character-for-character the OIDs
`git ls-tree cac9b21 migrations/` reports, and `git diff --name-only cac9b21 --
migrations/` names `057` and nothing else. **Only `057` differs**
(`02c734b1dabd32b8aee980ae3ea35a029e08fe9f` → `9805ddf99aebd0c14acead2f25f69b73df743e41`,
+1304 / −35 lines, 1,506 lines total).

THREE superseded values, recorded so a reader holding an older document can tell
which is which: the R2 report pinned `057` at `af29b31f…` (its state at
`ff31370`/`cac9b21`), the R3 report pinned it at `a430d1f4…` (its state at
`9cba262`), and the R4 pass before the F4 correction pinned it at `8be8fd0f…`.
All three are stale, and the reason there is a third is F4 itself: line 2 of the
file read `FBL-020-R2` while the file carried five R4 sections and the R3
corrections, so the header was rewritten to describe its actual content and
revision history — a comment-only edit that still moves the digest, which is why
the file's own header now says so. `057` is still not pinned in
`docs/identity/DATA-DICTIONARY.md`; the value above is published beside its blob
OID so it can be re-derived rather than trusted, and the migration ledger records
the same canonical-LF digest at apply time (§14, R4 §0).

## 7. Verification evidence — measured on this tree

### Test batteries — the R4 pair, taken back to back on the final tree

```
TEST_DATABASE_URL="postgresql://postgres@127.0.0.1:55434/dealership_test" \
  npx tsx --test --test-concurrency=1 --test-reporter=tap tests/*.test.ts
```

**These figures replace the ones this section carried in R3.** R3's §7 reported
**315 tests / 29 suites** and described them as the final tree; that was true of
the R3 head and is _not_ true of this one, because R4 adds ten batteries. A
number correct for a superseded tree, left in a section headed "measured on this
tree", is the exact defect this report was rejected for elsewhere, so it is
corrected here rather than carried forward.

Each run recreates the database first
(`dropdb --if-exists dealership_test && createdb dealership_test && migrate`), so
the pair also demonstrates that the suite does not depend on residue from an
earlier run.

| Metric               | Run A   | Run B   |
| -------------------- | ------- | ------- |
| tests                | **459** | **459** |
| suites               | **47**  | **47**  |
| pass                 | **459** | **459** |
| fail                 | **0**   | **0**   |
| cancelled            | **0**   | **0**   |
| skipped              | **0**   | **0**   |
| todo                 | **0**   | **0**   |
| `not ok`             | **0**   | **0**   |
| SKIP/TODO directives | **0**   | **0**   |

`duration_ms` is recorded in the raw TAP logs and is deliberately not pinned
here: it is wall-clock on one machine, it moves by tens of seconds between
identical runs, and pinning it would turn a measurement into a claim nobody can
reproduce. Both runs took roughly four minutes.

**Stability:** each TAP log was reduced to its sorted assertion-name set — **506
names**, being 459 test lines plus 47 suite lines, every name unique — and the
sets were diffed. **Identical as multisets and as sets.** Floors: the order fixed
≥ 315 tests and ≥ 29 suites; `scripts/parse-test-summary.ts` declares the R4
floors at **459 / 47** (`MINIMUM_TESTS` / `MINIMUM_SUITES`), so the delivered
counts are exactly at the declared floor and any future shrink fails the gate.
R3's count was 315, so **+144 tests and +18 suites**.

The R4-R4 closeout added **5 tests and 1 suite** to the figures the R4 submission
carried (425 / 41): four in the new `audit inventory completeness (FBL-020-R4 §3)`
suite in `tests/architecture.test.ts`, and one — _a REFUSED login is audited, in
both branches that refuse one_ — in `tests/identity-core.test.ts`.

The **R4-R4-R4 closeout** (F1a–F5) then added **29 tests and 5 suites** on top of
that 430 / 42: **25 tests in 5 suites** in the new
`tests/audit-inventory-rules.test.ts`, which drives the audit-inventory gate's own
rules one at a time; **3** in `tests/architecture.test.ts` (the assembly corpus,
the residue corpus, and the one-resolver structural check); and **1** in
`tests/login-admission.test.ts` (the archived-dealer-group scenario that makes F5's
subsumption a tested property). The floors were advanced with them, which is the
discipline `scripts/parse-test-summary.ts` states in its own header: the floors are
what the revision delivers, not the order's old minimum. The floor raise is not
optional bookkeeping — `tests/ci-gates.test.ts` refuses a floor BELOW the
declaration count, and 444 declarations now exist.

**What "the final tree" means here, precisely.** The pair executed against the
final state of every file the suite reads — code, tests, migrations,
configuration, and the documents `tests/delivery-documentation.test.ts` and
`tests/identity-boundary.test.ts` read, **this report among them**. Unlike R3,
this report is _inside_ the tree the pair measured: it was finalized before run A
started and not edited afterwards, which is why the documentation battery's
verdict on it counts.

### F2 — the per-rule mapping, and the deletion demonstration

Every rule in `scripts/check-audit-inventory.ts` and where it dies if removed. The
first four are pinned by fixture corpora; the rest judge the DECLARATION rather than
a scanned file, which no fixture can reach, so they are driven directly from
`tests/audit-inventory-rules.test.ts`.

| Rule                                                        | Test that dies when the rule alone is removed                                                                                                                       |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `audit-event-type-missing-from-inventory`                   | fixtures `audit-inventory-gap/undeclared-support-event.ts`, all twelve `audit-inventory-assembly/` spellings; unit: _rule: audit-event-type-missing-from-inventory_ |
| `audit-event-type-assembled-at-run-time`                    | fixtures `audit-inventory-gap/assembled-event-type.ts`, `audit-inventory-assembly/evasion-k-opaque-rewrites.ts` (five shapes)                                       |
| `audit-event-type-namespace-root-assembled-at-run-time`     | fixture `audit-inventory-assembly/evasion-l-assembled-namespace-root.ts`                                                                                            |
| `audit-write-outside-declared-writer`                       | fixture `audit-inventory-gap/undeclared-writer.ts`; unit: _rule: audit-write-outside-declared-writer_                                                               |
| `duplicate-inventory-transition`                            | _rule: duplicate-inventory-transition_                                                                                                                              |
| `duplicate-inventory-event-type`                            | _rule: duplicate-inventory-event-type_                                                                                                                              |
| `inventory-event-type-outside-the-namespace`                | _rule: inventory-event-type-outside-the-namespace_ (both halves: wrong root, too few segments)                                                                      |
| `inventory-entry-family-undeclared`                         | _rule: inventory-entry-family-undeclared_                                                                                                                           |
| `inventory-entry-family-mismatch`                           | _rule: inventory-entry-family-mismatch_                                                                                                                             |
| `inventory-proof-citation-is-not-verifiable` (missing file) | _rule: inventory-proof-citation-is-not-verifiable — the FILE must exist_                                                                                            |
| `inventory-proof-citation-is-not-verifiable` (missing name) | _rule: inventory-proof-citation-is-not-verifiable — the NAME must be in that file_                                                                                  |
| `inventory-entry-incomplete`                                | _rule: inventory-entry-incomplete_ (writer and entity type, separately)                                                                                             |
| `required-transition-missing-from-inventory`                | _rule: required-transition-missing-from-inventory_                                                                                                                  |
| `declared-writer-does-not-exist`                            | _rule: declared-writer-does-not-exist_                                                                                                                              |
| `declared-writer-has-no-reason`                             | _rule: declared-writer-has-no-reason_                                                                                                                               |
| `non-enumerable-writer-inside-the-inventoried-namespace`    | _rule: non-enumerable-writer-inside-the-inventoried-namespace_                                                                                                      |
| `literal-declared-both-audit-and-non-audit`                 | _rule: literal-declared-both-audit-and-non-audit_                                                                                                                   |
| `non-audit-literal-has-no-reason`                           | _rule: non-audit-literal-has-no-reason_ (role and reason, separately)                                                                                               |
| `inventory-entry-has-no-production-writer`                  | _rule: inventory-entry-has-no-production-writer_                                                                                                                    |
| `non-audit-literal-declaration-is-stale`                    | _rule: non-audit-literal-declaration-is-stale_                                                                                                                      |
| `audit-writer-declaration-is-stale`                         | _rule: audit-writer-declaration-is-stale_                                                                                                                           |
| `migration-audit-write-has-no-static-event-type`            | _rule: migration-audit-write-has-no-static-event-type_                                                                                                              |

**The demonstration, run on this tree.** `checkInventoryShape()` was deleted
wholesale — the function and its call site — exactly as the finding did it, and the
three batteries it could possibly touch were run:

```
tests/audit-inventory-rules.test.ts tests/architecture.test.ts tests/ci-gates.test.ts
→ # tests 55  # pass 39  # fail 16
```

The sixteen are named, not aggregate: _the BASELINE declaration is clean…_, _the REAL
declaration is clean…_, and the fourteen `rule: …` tests. **Before F2 the same
deletion left `tests/architecture.test.ts` 13/13 and `tests/ci-gates.test.ts` 14/14
green** — those two batteries are still green under the deletion, which is precisely
the point: they never reached those rules, and the new battery does. The file was then
restored and the same three batteries returned to green.

**And one rule at a time.** Deleting only the `duplicate-inventory-transition` rule —
three lines — and running the rules battery gives `# tests 25  # pass 24  # fail 1`,
the one failure being _rule: duplicate-inventory-transition_. A rule cannot be removed
without its own test naming it.

### Build, architecture, ratchet

- `npm run build` → **0 TypeScript errors**, exit 0.
- `npm run architecture:check` → **7/7 OK**, exit 0: dependency check; app-SQL
  guard (no query primitives, no SQL literals in `apps/**`); architecture
  manifest (11 modules); env-access confinement; role-bindings effectiveness
  guard — _21 statements inspected, 9 declared opt-outs, one shared predicate_;
  the R4 **owned-mutation guard** — _11 authorization-state tables derived
  from the migrations; every write in a declared owner or a reasoned fixture
  bypass_; and the R4 **audit-inventory gate** — _46 entries over 9 declared
  families; **73** production TypeScript files and 10 migrations scanned; 54 distinct
  `identity.*` literals, every one accounted for_ (73, not the 72 an earlier revision
  published — the F1a resolver extraction added `scripts/static-string-resolver.ts` to
  the scanned `scripts/` root, and the scan's reach is the thing that makes this gate
  mean anything). R3's §7 said 5/6 of these, at
  17/6 statements; the sixth check and the wider statement census are R4's, and the
  seventh is the R4 closeout's (§3 below).
- `npx tsx scripts/quality-ratchet.ts check` → **exit 0**, run BEFORE any update
  and no update was needed.

| Ratchet    | `cac9b21` | This tree | Ceiling (blueprint §14.3) | Direction |
| ---------- | --------- | --------- | ------------------------- | --------- |
| tsc-strict | 53        | **53**    | 59                        | unchanged |
| eslint     | 125       | **123**   | 136                       | tightened |
| format     | 1         | **1**     | 23                        | unchanged |

No baseline was raised — that is the property `quality-ratchet.ts check` actually
enforces, per-total and per-file, and it exited 0. The only movement is `eslint`
downward, from removing the two suppressions in `apps/api/src/routes/auth.ts`.

#### The ceilings: the source, the value, and how this report got it wrong twice

The ceilings are **59 / 136 / 23**, and the source is the GOVERNING blueprint, not an
ADR. Verbatim, from
`Car_Dealership_Management_and_Sales_Cloud_Master_Blueprint.docx` (sha256
`556d4e108c9db8b7dcfee284828f926157f7663d260d3d3e0d8774bb032feaaf`), §14.3 "First active
instruction — FBL-020-R2", under the heading "R2 gate and stop rule":

> Quality ceilings remain tsc-strict <=59, eslint <=136 and format <=23. Do not raise them
> or weaken architecture, SQL, migration, container, SBOM, dependency or secret-scan gates.

That sentence occurs **exactly once** in the document, and the string `29` appears nowhere
in it in connection with a ceiling. The history, recorded because a corrected claim whose
history is deleted is not much better than the claim:

1. Correspondence during this order repeatedly quoted the third ceiling as **23**, which
   was right.
2. R3 "corrected" it to **29** on the grounds that
   `docs/adr/ADR-005-technology-selections.md:19` was "the sole definition site in the
   repository". That correction was itself wrong, and wrong in a way worth naming: it
   treated an ADR — a repository document that RESTATES a requirement — as authoritative
   over the governing blueprint that ISSUES it. "The only place in the repository that
   says it" is not the same as "the place that decides it".
3. R4 reconciles both to the blueprint. ADR-005 now reads 23, quotes the blueprint
   sentence, and says explicitly that it restates rather than defines. `quality-baselines.json`
   was NOT touched and nothing was raised.

The delivery is compliant on either reading, since `format` debt is **1** against a ceiling
of 23 or 29 alike — so this is a truthfulness fix, not a behaviour one.

- **No tool enforces a ceiling.** `scripts/quality-ratchet.ts` contains no ceiling
  concept at all (`grep -c ceiling` → 0); it refuses growth against
  `quality-baselines.json` and nothing more. A claim that "no ceiling was raised"
  is therefore a statement about a document, not about a gate. Recorded in
  KNOWN-LIMITATIONS.

### Formatting

`npx prettier --check` over **143** of the **146** files changed or added against
`cac9b21` → _All matched files use Prettier code style!_ The three it does not
cover are the three Prettier has no parser for: `Dockerfile`,
`migrations/057_identity_boundary_completion.sql` and
`tests/fixtures/legacy-identity-seed-pre-057.sql`. That is also how the
repository's own `format` ratchet selects files, and the ratchet's one remaining
debt file — `eslint.config.mjs`, which nothing in R4 touches — is unchanged at 1.

### Raw-output sentinel scan

Both raw TAP logs were scanned for **every** literal containing the token
`SENTINEL` declared anywhere in `tests/`, `packages/`, `apps/` and `scripts/` —
**39 literals**, of which **28 are concrete secret/PII values**
(`SENTINEL-DB-PASSWORD-hunter2`, `SENTINEL STEP UP TOKEN`,
`SENTINEL SET COOKIE VALUE`, `SENTINEL-CONNECTION-STRING-user:pass@host`,
`SENTINEL 4111 1111 1111 1111`, `Server=x;Password=SENTINEL CONN PW;` and
twenty-two more), eight are template fragments (`${sentinel}`) that hold no value
of their own, and three are prose. **Zero of the 28 values appears in either
log.** The only literal that matches at all is a test NAME — _sentinel secrets and
PII never appear in serialized output, however nested or cased_ — once per log,
which is the battery announcing itself.

Additional shape scan over both raw logs, as the order specifies —
`eyJ[A-Za-z0-9]` (JWT), `Bearer [A-Za-z0-9]{25}`, `sk_test`, `github_pat` →
**0 matches in each log**. The only `# skip`/`# todo` text in either log is the
summary's own `# skipped 0` / `# todo 0`; there are **no per-test SKIP or TODO
directives** (`^\s*ok .* # (SKIP|TODO)` → 0 matches).

## 8. Migration 057 on a POPULATED pre-057 database — now a CI GATE

**R3's version of this section was a LOCAL, PROSE-ONLY exercise, and it was
rejected as evidence. That rejection was right.** Nothing in the repository seeded
identity data before `057`, and `scripts/verify-upgrade-state.ts` REQUIRED all nine
identity tables to be EMPTY — so the CI upgrade job was structurally incapable of
exercising a single reconciliation in a file whose entire subject is reconciling
retained identity rows before it constrains them. A drill nobody can re-run from
the repository is a claim, not a control.

R4 replaces it with a gate. The fixture, the verifier, the negative-control runner
and the workflow steps are all committed, and the job FAILS if any of them refuses.

### The drill, as CI runs it

| #   | Step (`ci.yml`, job `migration-upgrade`)                                     | What it establishes                                                                                                                                                                    |
| --- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | _Apply the earliest retained schema (f76a27a; migrations 000 + 049)_         | the retained schema, from `tests/fixtures/schema-f76a27a`, checksummed into `fixture-checksums.json`                                                                                   |
| 2   | _Seed legacy Fixed Ops data that schema allowed_                             | the RETAINED Fixed Ops fixture is kept, not replaced                                                                                                                                   |
| 3   | _Stage the pre-057 chain_                                                    | a 9-file `MIGRATIONS_DIR` with `057` withheld; the count is asserted, so a future `058` fails this step instead of being seeded against the wrong schema. Listing: `pre-057-chain.txt` |
| 4   | _Migrate through the last PRE-057 migration (050..056)_                      | the schema a retained database would really have had                                                                                                                                   |
| 5   | _Verify the organization backfill invented no identities (`phase=backfill`)_ | R3's empty-table assertion, KEPT — at the one point where it is a true statement about 055/056. Artifact: `upgrade-backfill.json`                                                      |
| 6   | _Seed NONEMPTY legacy identity data (pre-057 schema)_                        | `tests/fixtures/legacy-identity-seed-pre-057.sql`                                                                                                                                      |
| 7   | _Verify the identity fixture is present and NONEMPTY (`phase=pre-057`)_      | **fails if any census table is empty**; records the exact census in `identity-pre-057.json`                                                                                            |
| 8   | _Reconciliation negative controls (isolated copies of the pre-057 database)_ | `negative-controls.json`, `negative-controls.txt` — see below                                                                                                                          |
| 9   | _Apply 057 on top of the populated legacy data_                              | the migration under review, through the real runner                                                                                                                                    |
| 10  | _Verify the reconciled state and before/after counts (`phase=post-057`)_     | exact row states + nonzero, UNCHANGED counts. `identity-post-057.json`, `constraint-state.txt`                                                                                         |

### What the fixture contains, and why each row is there

Every row is the input to a named reconciliation. Two tenants: **A** has exactly one
ACTIVE connection, so its activated link is unambiguous; **B** has only a DISABLED
connection, so its activated link is ambiguous. (`uq_ipc_active` makes "two active
connections in one tenant" unrepresentable, so zero active connections is the only
reachable ambiguity — the fixture models the shape that can actually occur.)

Census, asserted exactly at `phase=pre-057`: connections 3, user links 4, identity
sessions 3, role bindings 4, policy decisions 2, reauthentication transactions 3,
grants 1, support requests 2, support sessions 1. Shapes: 3 activated links, 1
ambiguous, 3 live sessions, 1 with no provable provenance, 1 started step-up, 2
terminal step-ups, 1 EFFECTIVE role binding and 3 INEFFECTIVE (future-dated, aged
out, revoked), 1 incomplete historical ALLOW, 1 pending support request, 1 approved
support request with no grant, 1 unbounded MFA certification.

### The reconciled state after 057 — asserted, not described

Seventeen exact-state assertions run at `phase=post-057`; a count-only check would
pass where these fail. The two revocation branches are the clearest case: both
revoke a session, and only the recorded REASON says which statement acted.

| Assertion id                                                  | Outcome required                                                |
| ------------------------------------------------------------- | --------------------------------------------------------------- |
| `ul_a1_bound_to_its_only_active_connection`                   | activated, bound to connection A, version still 1               |
| `ul_a2_pending_link_stays_pending`                            | pending, BOUND — binding is provenance, activation is authority |
| `ul_b1_ambiguous_link_deactivated_and_unbound`                | deactivated, binding cleared, version 1→2                       |
| `is_s1_provable_session_survives_with_derived_identity`       | LIVE, subject and organization DERIVED                          |
| `is_s2_unprovable_provenance_revoked`                         | revoked `fbl_020_r2_unprovable_binding`                         |
| `is_s3_unprovable_identity_revoked`                           | revoked `fbl_020_r3_unprovable_subject_or_org`                  |
| `rat_t1_started_transaction_expired_and_explained`            | `expired`, terminal reason `expired`, dated                     |
| `rat_t2_completed_transaction_explained_from_its_own_instant` | reason `granted`, `terminal_at = completed_at`                  |
| `rat_t3_failed_transaction_classified_honestly`               | reason `fbl_020_r4_unclassified` — no cause invented            |
| `rag_grant_connection_derived_from_its_transaction`           | NULL, because its transaction's is NULL                         |
| `sar_r2_approval_without_a_grant_superseded`                  | `expired`, decision preserved in `superseded_*`, version 1→2    |
| `sas_session_of_superseded_approval_ended`                    | revoked, attributed to nobody, expiry not back-dated            |
| `sar_r1_pending_request_untouched`                            | still `pending`, version 1                                      |
| `ipc_unbounded_mfa_certification_withdrawn`                   | certification FALSE, no invented deadline, version 1→2          |
| `pd_incomplete_history_preserved_at_version_1`                | unchanged, readable, version 1                                  |
| `rb_all_four_windows_survive_unchanged`                       | 4 bindings, all at version 1, 1 effective / 3 ineffective       |
| `audit_supersession_is_recorded`                              | exactly one `identity.support.approval_superseded`              |

Plus: **nothing was deleted.** Before/after counts are compared table by table and
must be equal and nonzero — `057` reconciles by changing state, and a migration that
closed a problem by deleting the evidence of it would satisfy every constraint in the
file. And the policy-evidence version floor is PROBED: a new row at
`evidence_version 1` must be refused (the probe runs in a transaction that is always
rolled back).

### The proof that reconciliation is LOAD-BEARING — ten controls, in CI

`scripts/upgrade-negative-controls.ts` copies the pre-057 database
(`CREATE DATABASE … TEMPLATE`), deletes ONE reconciliation from `057`, runs the real
migration runner, and — if the migration survives — runs the real post-057 verifier.
Each control DECLARES where it must fail and what the failure must mention, so a
change in `057` that shifts the failure mode is a review event and not a silent
downgrade. Locally, on the fixture above: **10 controls, 10 satisfied, 0 failed**
(`negative-controls.json`, keyed to `057` digest `add07aaf…`; the run that
produced that file was keyed to the pre-F4 digest `8be8fd0f…`, whose only
difference from this one is the comment header F4 corrected).

| Control (statement removed)             | Required failure                                                   |
| --------------------------------------- | ------------------------------------------------------------------ |
| `ul_deterministic_binding`              | verifier — `ul_a1_bound_to_its_only_active_connection`             |
| `ul_ambiguous_deactivation`             | migration — `ul_activated_is_bound`                                |
| `is_unprovable_provenance_revoked`      | verifier — `is_s2_unprovable_provenance_revoked`                   |
| `is_subject_and_org_derived`            | verifier — `is_s1_provable_session_survives_with_derived_identity` |
| `is_unprovable_identity_revoked`        | migration — `is_live_session_fully_bound`                          |
| `rat_started_expired`                   | migration — `rat_started_is_bound`                                 |
| `sar_approval_without_grant_superseded` | migration — `sar_approval_is_high_assurance`                       |
| `ipc_unbounded_certification_withdrawn` | migration — `ipc_mfa_certification_is_bounded`                     |
| `rat_terminal_explained`                | migration — `rat_terminal_is_explained`                            |
| `pd_evidence_version_floor`             | verifier — a new row accepted at `evidence_version 1`              |

Two of those deserve naming, because they are the ones a weaker gate would miss:

- **`is_unprovable_provenance_revoked` does not break the migration.** Remove the
  first of §2's two revocations and the second one still catches the same row — with
  a DIFFERENT recorded reason. Only an exact-state assertion sees it, which is why the
  verifier asserts revocation reasons rather than revocation counts.
- **`ul_deterministic_binding` breaks nothing at all.** Remove the derivation that
  BINDS an unambiguous link and no constraint objects: the link is quietly deactivated
  instead, so every member of staff in a correctly configured tenant loses access on
  upgrade, silently. That is a DATA failure with no error message anywhere.

**Reconciliations that CANNOT be shown load-bearing by this fixture are enumerated,
not omitted.** Eight statements in `057` operate on columns `057` itself creates, so
on any pre-057 database they match zero rows by construction — the `§3`
`login_transactions` reconciliation, the `§5` duplicate-grant supersession, the
`§7a/b/c` tuple reconciliations, `§9`'s started-callback expiry (which `§4` has
already emptied), and others. They are listed with their reason in
`negative-controls.json` under `not_load_bearing_on_a_pre_057_fixture`, and they stay
in `057` because the ORDERING is the property under review. Claiming them as proven
would be the same kind of false claim this section exists to remove.

## 9. Fresh chain and fingerprint convergence

Measured locally on PostgreSQL 16 at `127.0.0.1:55434`, on the databases §8's drill
produced:

- Fresh database, all ten migrations from empty: **succeeded**, 10/10 applied.
- Schema fingerprint, fresh chain:
  `271c892662937a33c2972b83a30c4f02f441a5d058ac076e07d4248dd5d29d9f`.
- Schema fingerprint, the **populated database upgraded through 057**:
  `271c892662937a33c2972b83a30c4f02f441a5d058ac076e07d4248dd5d29d9f`.
- **`equal = true`.**

**These are LOCAL values and they are corroboration, not the gate.** Catalog text
differs across PostgreSQL builds, so the authoritative comparison is the in-CI one:
the workflow step _Fingerprints must be identical (fresh chain vs upgrade path)_,
which reads `fresh-schema-fingerprint.json` and
`upgraded-schema-fingerprint.json`, writes `fingerprint-equality.txt`, and fails the
job on inequality. It has **not** run for this tree — see §13 — and the values above
must not be quoted as in-CI values. Both earlier in-CI fingerprints (the R2 report's
`59107a0b…`, the R3 report's `dcfffc97…`) describe schemas that `057` has since
changed and are superseded.

## 10. Exact changed-file list

Base: **`cac9b21`** (the cumulative acceptance base). **163 paths: 71 modified,
92 new.** Against the R4 implementation parent `9cba262` the working tree changes
**104 paths: 53 modified, 51 new** — that second list is §10.1.

**R3's figure here was 94 paths (53 modified, 41 new) and it is superseded, not
corrected downward:** R4 adds ten batteries, seven scripts, three packages
modules, six fixture directories and a requirement map, and re-touches most of the
identity package. Excluding this report, whose own line delta cannot be quoted
from inside itself without going stale on the next edit: **111 files changed,
+24,101 / −2,377** in the tracked diff, plus the 51 paths that are still untracked.

**The insertion count went DOWN from the 24,832 this section published before the
F1a correction, and that is not an error.** F1a moved roughly a thousand lines of
static evaluator OUT of `scripts/check-role-binding-effectiveness.ts` — a path git
counts in this tracked diff — and INTO
`scripts/static-string-resolver.ts`, which is still untracked and therefore counted
in the 51 rather than in the shortstat. The two tables below are regenerated from
`git diff --numstat` on this tree, not carried forward, which is the only way a
figure like that stays honest across a refactor.

> Reproduce:
> `git diff --shortstat cac9b21 -- . ':(exclude)docs/FBL-020-DELIVERY-REPORT.md'`,
> `git diff --numstat cac9b21` per row, and
> `git status --porcelain --untracked-files=all` for the new paths git does not yet
> track. Excluding only this file is what makes the table a fixed point: every
> other document it counts is one this report does not edit, so correcting a row
> here cannot invalidate another row. That property is not free — the R3 review
> found this table's `KNOWN-LIMITATIONS.md` row stale twice, once carried forward
> from an earlier revision and once because correcting §11 required editing that
> very file. Both are fixed; §11.11 records why nothing prevents a third.

### Modified (71)

| Path                                                      | +/−                                        |
| --------------------------------------------------------- | ------------------------------------------ |
| `.github/workflows/ci.yml`                                | +132 / −11                                 |
| `Dockerfile`                                              | +12 / −2                                   |
| `README.md`                                               | +42 / −24                                  |
| `apps/api/src/index.ts`                                   | +2 / −1                                    |
| `apps/api/src/middleware/auth.ts`                         | +187 / −43                                 |
| `apps/api/src/middleware/error-handler.ts`                | +26 / −2                                   |
| `apps/api/src/middleware/request-context.ts`              | +33 / −11                                  |
| `apps/api/src/routes/auth.ts`                             | +420 / −128                                |
| `apps/worker/src/index.ts`                                | +16 / −1                                   |
| `apps/worker/src/main.ts`                                 | +175 / −10                                 |
| `architecture/modules.json`                               | +8 / −3                                    |
| `docker-compose.yml`                                      | +26 / −0                                   |
| `docs/DEVELOPMENT.md`                                     | +34 / −3                                   |
| `docs/FBL-020-DELIVERY-REPORT.md`                         | (this file — self-referential, not quoted) |
| `docs/PHASE-248-SERVICE-COCKPIT-V2.md`                    | +21 / −19                                  |
| `docs/adr/ADR-005-technology-selections.md`               | +10 / −1                                   |
| `docs/adr/ADR-006-workos-authkit-identity.md`             | +68 / −0                                   |
| `docs/adr/ADR-007-organization-hierarchy-policy.md`       | +81 / −0                                   |
| `docs/adr/ADR-008-support-access.md`                      | +71 / −0                                   |
| `docs/architecture/MODULE-OWNERSHIP.md`                   | +34 / −11                                  |
| `docs/architecture/THREAT-MODEL-DELTA-FBL-020.md`         | +87 / −32                                  |
| `docs/identity/AUTH-FLOWS.md`                             | +326 / −39                                 |
| `docs/identity/DATA-DICTIONARY.md`                        | +129 / −6                                  |
| `docs/identity/KNOWN-LIMITATIONS.md`                      | +420 / −26                                 |
| `docs/identity/ROLE-ACTION-SCOPE-MATRIX.md`               | +22 / −14                                  |
| `docs/runbooks/TENANT-BOOTSTRAP-RUNBOOK.md`               | +196 / −19                                 |
| `docs/runbooks/WORKOS-OPERATOR-RUNBOOK.md`                | +337 / −17                                 |
| `migrations/057_identity_boundary_completion.sql`         | +1304 / −35                                |
| `package.json`                                            | +1 / −1                                    |
| `packages/database/src/index.ts`                          | +8 / −1                                    |
| `packages/database/src/pool.ts`                           | +483 / −11                                 |
| `packages/identity-access/src/actions.ts`                 | +23 / −2                                   |
| `packages/identity-access/src/actor.ts`                   | +80 / −25                                  |
| `packages/identity-access/src/contracts.ts`               | +213 / −0                                  |
| `packages/identity-access/src/index.ts`                   | +5 / −0                                    |
| `packages/identity-access/src/login-transaction.ts`       | +342 / −55                                 |
| `packages/identity-access/src/oidc/token-verifier.ts`     | +87 / −5                                   |
| `packages/identity-access/src/policy.ts`                  | +559 / −96                                 |
| `packages/identity-access/src/provider/workos/adapter.ts` | +208 / −1                                  |
| `packages/identity-access/src/reauthentication.ts`        | +746 / −154                                |
| `packages/identity-access/src/sealed-cookie.ts`           | +30 / −3                                   |
| `packages/identity-access/src/session.ts`                 | +1538 / −57                                |
| `packages/identity-access/src/support-access.ts`          | +113 / −196                                |
| `packages/identity-access/src/user-link.ts`               | +227 / −175                                |
| `packages/organization/src/repository.ts`                 | +73 / −106                                 |
| `packages/platform/src/config.ts`                         | +145 / −15                                 |
| `packages/platform/src/errors.ts`                         | +29 / −0                                   |
| `packages/platform/src/logger.ts`                         | +18 / −1                                   |
| `packages/platform/src/problem-details.ts`                | +1 / −0                                    |
| `packages/platform/src/request-context.ts`                | +203 / −10                                 |
| `packages/test-kit/src/db.ts`                             | +8 / −0                                    |
| `packages/test-kit/src/identity.ts`                       | +516 / −76                                 |
| `packages/test-kit/src/index.ts`                          | +1 / −0                                    |
| `quality-baselines.json`                                  | +1 / −2                                    |
| `scripts/bootstrap-identity.ts`                           | +39 / −275                                 |
| `scripts/migrate.ts`                                      | +208 / −16                                 |
| `scripts/parse-test-summary.ts`                           | +141 / −32                                 |
| `scripts/verify-upgrade-state.ts`                         | +750 / −97                                 |
| `tests/architecture.test.ts`                              | +755 / −0                                  |
| `tests/auth-surface.test.ts`                              | +43 / −6                                   |
| `tests/auth.test.ts`                                      | +1032 / −30                                |
| `tests/federation.test.ts`                                | +6 / −4                                    |
| `tests/identity-boundary.test.ts`                         | +4061 / −119                               |
| `tests/identity-config.test.ts`                           | +239 / −7                                  |
| `tests/identity-core.test.ts`                             | +455 / −25                                 |
| `tests/identity-journey.test.ts`                          | +141 / −50                                 |
| `tests/integration.test.ts`                               | +151 / −0                                  |
| `tests/organization.test.ts`                              | +179 / −86                                 |
| `tests/platform.test.ts`                                  | +72 / −20                                  |
| `tests/policy.test.ts`                                    | +451 / −83                                 |
| `tests/reauthentication.test.ts`                          | +270 / −77                                 |

### New (92)

| Path                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Lines    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `apps/api/src/identity/provider.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 58       |
| `architecture/negative-control-anchors-057.json`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 42       |
| `docs/FBL-020-R4-REQUIREMENT-MAP.json`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 678      |
| `packages/identity-access/src/audit-inventory.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 780      |
| `packages/identity-access/src/bootstrap.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 528      |
| `packages/identity-access/src/login-admission.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 368      |
| `packages/identity-access/src/mutations.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 1970     |
| `packages/identity-access/src/session-view.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 267      |
| `packages/test-kit/src/fixture-primitives.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 112      |
| `scripts/check-audit-inventory.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 708      |
| `scripts/check-owned-mutations.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 473      |
| `scripts/check-requirement-map.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 174      |
| `scripts/check-role-binding-effectiveness.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 937      |
| `scripts/mutation-kill.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 423      |
| `scripts/static-string-resolver.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 1151     |
| `scripts/upgrade-negative-controls.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 570      |
| `tests/audit-inventory-rules.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 401      |
| `tests/ci-gates.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 472      |
| `tests/delivery-documentation.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 272      |
| `tests/fixtures/legacy-identity-seed-pre-057.sql`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 281      |
| `tests/identity-evidence.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 745      |
| `tests/identity-lifecycle-audit.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 890      |
| `tests/login-admission.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 850      |
| `tests/migration-ledger.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 305      |
| `tests/owned-mutations.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 419      |
| `tests/support-context.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 636      |
| `tests/support-expiry.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 384      |
| `tests/support/pool-fatal-child.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 414      |
| `architecture/fixtures/audit-inventory-assembly/` — `cross-file-fragments.ts` (7), `evasion-a-string-concat.ts` (22), `evasion-b-interpolated-head.ts` (14), `evasion-c-array-join.ts` (12), `evasion-d-concat-call.ts` (14), `evasion-e-accumulated.ts` (17), `evasion-f-indexed-fragments.ts` (14), `evasion-g-string-raw.ts` (13), `evasion-h-lookup-map.ts` (19), `evasion-i-alternative-fragment.ts` (20), `evasion-j-cross-file-fragment.ts` (13), `evasion-k-opaque-rewrites.ts` (27), `evasion-l-assembled-namespace-root.ts` (17)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 13 files |
| `architecture/fixtures/audit-inventory-declared/` — `declared-event-type.ts` (17)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 1 file   |
| `architecture/fixtures/audit-inventory-gap/` — `README.md` (25), `assembled-event-type.ts` (19), `undeclared-support-event.ts` (21), `undeclared-writer.ts` (19)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 4 files  |
| `architecture/fixtures/audit-inventory-residue/` — `name-outside-the-identity-namespace.ts` (16), `root-and-family-both-assembled.ts` (29)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 2 files  |
| `architecture/fixtures/owned-mutation-bypass/` — `README.md` (23), `assembled-statement-write.ts` (13), `bootstrap-script-raw-write.ts` (15), `interpolated-table-write.ts` (16), `production-imports-test-kit.ts` (16), `unattributed-repository-write.ts` (17)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 6 files  |
| `architecture/fixtures/owned-mutation-correct/` — `attributed-service-caller.ts` (23), `reads-are-not-writes.ts` (19)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 2 files  |
| `architecture/fixtures/role-binding-correct/` — `README.md` (42), `aliased-import.ts` (33), `assembled-with-shared-predicate.ts` (56), `direct-import.ts` (26), `namespaced-import.ts` (29), `prose-is-not-sql.ts` (30), `raw-regex-is-not-sql.ts` (27)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 7 files  |
| `architecture/fixtures/role-binding-drift/` — `README.md` (84), `control-1-coalesce-hidden-filter.ts` (27), `control-2-no-filter-at-all.ts` (23), `control-3-uppercase-and-schema-qualified.ts` (34), `control-4-cte-rename-and-second-read.ts` (50), `evasion-a-interpolated-table-name.ts` (33), `evasion-b-assembled-fragments.ts` (50), `evasion-c-neutralised-predicate.ts` (62), `evasion-d-unvalidated-opt-out.ts` (29), `evasion-d2-opt-out-validation.ts` (59), `evasion-e-unresolvable-table.ts` (29), `evasion-f-shadowed-predicate.ts` (34), `evasion-g-lookup-map-table.ts` (41), `evasion-h-loop-over-table-list.ts` (36), `evasion-i-alternative-table.ts` (65), `evasion-j-array-join.ts` (63), `evasion-k-string-concat.ts` (41), `evasion-l-string-raw.ts` (51), `evasion-m-opaque-string-operations.ts` (50), `evasion-n-reduce-accumulation.ts` (34), `evasion-o-custom-template-tag.ts` (35), `evasion-p-array-transforms.ts` (71), `evasion-q-indexed-fragments.ts` (44), `evasion-r-accumulated-statement.ts` (46), `evasion-s-blind-full-table-read.ts` (48), `evasion-t-guarded-once-counted-twice.ts` (61), `evasion-u-comment-carried-weakening.ts` (50), `evasion-v-predicate-in-projection.ts` (37), `evasion-w-negated-without-an-adjacent-not.ts` (55) | 29 files |

**Working-tree hygiene:** no `.tmp-*`, `*.tmp`, `*.orig`, `*.rej`, `*.bak`,
scratch or probe files exist anywhere in the tree. The only untracked-and-ignored
paths are `node_modules/`, `artifacts/`, per-package `dist/` and
`tsconfig.tsbuildinfo` build outputs.

### 10.1 Against the R4 implementation parent `9cba262`

The list above is against the cumulative acceptance base. This one is the
working-tree delta a reviewer sees on top of the commit R4 started from — **104
paths: 53 modified, 51 new** — and it is the list to read when checking what R4
itself changed as distinct from what R2 and R3 changed before it.

**Modified against `9cba262` (53).** `git diff --numstat HEAD`:

| Path                                                | +/−                                        |
| --------------------------------------------------- | ------------------------------------------ |
| `.github/workflows/ci.yml`                          | +132 / −11                                 |
| `Dockerfile`                                        | +12 / −2                                   |
| `README.md`                                         | +42 / −24                                  |
| `apps/api/src/middleware/auth.ts`                   | +41 / −8                                   |
| `apps/api/src/middleware/error-handler.ts`          | +26 / −2                                   |
| `apps/api/src/middleware/request-context.ts`        | +33 / −11                                  |
| `apps/api/src/routes/auth.ts`                       | +163 / −60                                 |
| `apps/worker/src/index.ts`                          | +16 / −1                                   |
| `apps/worker/src/main.ts`                           | +175 / −10                                 |
| `architecture/modules.json`                         | +8 / −3                                    |
| `docker-compose.yml`                                | +26 / −0                                   |
| `docs/FBL-020-DELIVERY-REPORT.md`                   | (this file — self-referential, not quoted) |
| `docs/adr/ADR-005-technology-selections.md`         | +10 / −1                                   |
| `docs/architecture/MODULE-OWNERSHIP.md`             | +34 / −11                                  |
| `docs/identity/KNOWN-LIMITATIONS.md`                | +145 / −41                                 |
| `docs/runbooks/TENANT-BOOTSTRAP-RUNBOOK.md`         | +51 / −0                                   |
| `docs/runbooks/WORKOS-OPERATOR-RUNBOOK.md`          | +76 / −0                                   |
| `migrations/057_identity_boundary_completion.sql`   | +731 / −8                                  |
| `package.json`                                      | +1 / −1                                    |
| `packages/identity-access/src/actions.ts`           | +14 / −0                                   |
| `packages/identity-access/src/actor.ts`             | +26 / −10                                  |
| `packages/identity-access/src/contracts.ts`         | +40 / −0                                   |
| `packages/identity-access/src/index.ts`             | +3 / −0                                    |
| `packages/identity-access/src/login-transaction.ts` | +242 / −48                                 |
| `packages/identity-access/src/mutations.ts`         | +590 / −5                                  |
| `packages/identity-access/src/policy.ts`            | +272 / −73                                 |
| `packages/identity-access/src/reauthentication.ts`  | +466 / −77                                 |
| `packages/identity-access/src/session-view.ts`      | +52 / −15                                  |
| `packages/identity-access/src/session.ts`           | +287 / −57                                 |
| `packages/identity-access/src/support-access.ts`    | +122 / −8                                  |
| `packages/identity-access/src/user-link.ts`         | +27 / −1                                   |
| `packages/organization/src/repository.ts`           | +73 / −106                                 |
| `packages/platform/src/config.ts`                   | +11 / −0                                   |
| `packages/platform/src/logger.ts`                   | +18 / −1                                   |
| `packages/platform/src/request-context.ts`          | +203 / −10                                 |
| `packages/test-kit/src/identity.ts`                 | +378 / −49                                 |
| `packages/test-kit/src/index.ts`                    | +1 / −0                                    |
| `scripts/bootstrap-identity.ts`                     | +32 / −322                                 |
| `scripts/check-role-binding-effectiveness.ts`       | +54 / −1084                                |
| `scripts/migrate.ts`                                | +188 / −8                                  |
| `scripts/parse-test-summary.ts`                     | +141 / −32                                 |
| `scripts/verify-upgrade-state.ts`                   | +750 / −104                                |
| `tests/architecture.test.ts`                        | +303 / −0                                  |
| `tests/auth.test.ts`                                | +228 / −53                                 |
| `tests/federation.test.ts`                          | +6 / −4                                    |
| `tests/identity-boundary.test.ts`                   | +249 / −70                                 |
| `tests/identity-core.test.ts`                       | +282 / −15                                 |
| `tests/identity-journey.test.ts`                    | +86 / −20                                  |
| `tests/integration.test.ts`                         | +3 / −1                                    |
| `tests/organization.test.ts`                        | +108 / −58                                 |
| `tests/platform.test.ts`                            | +72 / −20                                  |
| `tests/policy.test.ts`                              | +126 / −64                                 |
| `tests/reauthentication.test.ts`                    | +38 / −8                                   |

**New since `9cba262` (51)** — every one of these is untracked, so
`git diff` alone does not show them:

- `architecture/fixtures/audit-inventory-assembly/cross-file-fragments.ts`
- `architecture/fixtures/audit-inventory-assembly/evasion-a-string-concat.ts`
- `architecture/fixtures/audit-inventory-assembly/evasion-b-interpolated-head.ts`
- `architecture/fixtures/audit-inventory-assembly/evasion-c-array-join.ts`
- `architecture/fixtures/audit-inventory-assembly/evasion-d-concat-call.ts`
- `architecture/fixtures/audit-inventory-assembly/evasion-e-accumulated.ts`
- `architecture/fixtures/audit-inventory-assembly/evasion-f-indexed-fragments.ts`
- `architecture/fixtures/audit-inventory-assembly/evasion-g-string-raw.ts`
- `architecture/fixtures/audit-inventory-assembly/evasion-h-lookup-map.ts`
- `architecture/fixtures/audit-inventory-assembly/evasion-i-alternative-fragment.ts`
- `architecture/fixtures/audit-inventory-assembly/evasion-j-cross-file-fragment.ts`
- `architecture/fixtures/audit-inventory-assembly/evasion-k-opaque-rewrites.ts`
- `architecture/fixtures/audit-inventory-assembly/evasion-l-assembled-namespace-root.ts`
- `architecture/fixtures/audit-inventory-declared/declared-event-type.ts`
- `architecture/fixtures/audit-inventory-gap/README.md`
- `architecture/fixtures/audit-inventory-gap/assembled-event-type.ts`
- `architecture/fixtures/audit-inventory-gap/undeclared-support-event.ts`
- `architecture/fixtures/audit-inventory-gap/undeclared-writer.ts`
- `architecture/fixtures/audit-inventory-residue/name-outside-the-identity-namespace.ts`
- `architecture/fixtures/audit-inventory-residue/root-and-family-both-assembled.ts`
- `architecture/fixtures/owned-mutation-bypass/README.md`
- `architecture/fixtures/owned-mutation-bypass/assembled-statement-write.ts`
- `architecture/fixtures/owned-mutation-bypass/bootstrap-script-raw-write.ts`
- `architecture/fixtures/owned-mutation-bypass/interpolated-table-write.ts`
- `architecture/fixtures/owned-mutation-bypass/production-imports-test-kit.ts`
- `architecture/fixtures/owned-mutation-bypass/unattributed-repository-write.ts`
- `architecture/fixtures/owned-mutation-correct/attributed-service-caller.ts`
- `architecture/fixtures/owned-mutation-correct/reads-are-not-writes.ts`
- `architecture/negative-control-anchors-057.json`
- `docs/FBL-020-R4-REQUIREMENT-MAP.json`
- `packages/identity-access/src/audit-inventory.ts`
- `packages/identity-access/src/bootstrap.ts`
- `packages/identity-access/src/login-admission.ts`
- `packages/test-kit/src/fixture-primitives.ts`
- `scripts/check-audit-inventory.ts`
- `scripts/check-owned-mutations.ts`
- `scripts/check-requirement-map.ts`
- `scripts/mutation-kill.ts`
- `scripts/static-string-resolver.ts`
- `scripts/upgrade-negative-controls.ts`
- `tests/audit-inventory-rules.test.ts`
- `tests/ci-gates.test.ts`
- `tests/delivery-documentation.test.ts`
- `tests/fixtures/legacy-identity-seed-pre-057.sql`
- `tests/identity-evidence.test.ts`
- `tests/identity-lifecycle-audit.test.ts`
- `tests/login-admission.test.ts`
- `tests/migration-ledger.test.ts`
- `tests/owned-mutations.test.ts`
- `tests/support-context.test.ts`
- `tests/support-expiry.test.ts`

## 11. Residual risk — accepted, with reasons

**What this section is, and what it is NOT.** It holds risks a reviewer may weigh
and accept. It does **not** hold mandatory gates that are undischarged: R3 filed the
undischarged live-certification gate here, and was rejected for exactly that. Gates
that are not discharged are §15, and they are not risks — they are work that has not
been done. The full register with reproduction detail is
`docs/identity/KNOWN-LIMITATIONS.md`.

**Submitted with four items OPEN, at the repository owner's instruction.** R4's own
final gate returned `do_not_submit` four times in succession, and each time the finding
was in the R4 **guard scaffolding** rather than in the identity boundary. Four such items
remain open and are itemised under "Open at R4 submission" in
`docs/identity/KNOWN-LIMITATIONS.md`: three declared residues of the audit-inventory gate
that are described accurately but have no fixture; one audit-inventory rule (the
variant-overflow branch) with no test, under a header that says every rule has one; the
same untested-rule shape in the sibling owned-mutation gate
(`owned-mutation-owner-declaration-is-stale`); and a shared-resolver header that lists
`.reduce` and template tags as "resolved" where the code treats them as opaque and
fail-loud.

Two things the architect should hold this delivery to. **These four are disclosed, not
disguised** — they are named, located, and reproducible, and none is filed as a
discharged obligation. And **none of them is a mandatory gate**: every §0–§7 obligation
of the R4 order is discharged and CI-proven, and none of the four is a runtime
authorization hole — each requires a developer to author the code in question. Separately,
four items the same gate raised were **not** disclosed but CORRECTED before submission,
because they were false statements rather than gaps: the unscoped "assembled at run time
fails the build" absolute in `docs/architecture/MODULE-OWNERSHIP.md` and in the
requirement map (§14), a scan figure published as 72 where the gate reports 73 (§7), a
double-encoded requirement id, and a count of pre-F1a misses published as eleven in two
documents and ten in two tests — that number is withdrawn, not adjudicated, because
nobody re-measured it. A gap can be disclosed; a falsehood cannot.

1. **The drift guard cannot be walked around only by accident.** Five of the
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

2. **Rule 4 still cannot report a blind table position that carries no second
   structural mark** — `DELETE FROM ${table}` alone, or
   `INSERT INTO ${table} SELECT … FROM audit_events`. Requiring the second mark is
   what stops the rule reporting the word "update" in prose. Neither shape is a
   read, which is what the effectiveness rule governs.

3. **`withTransaction` ABANDONS its body when the connection is lost; it does not
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

4. **The surviving pool caveat: a lost-connection log line does not always carry
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

5. **A due refresh costs one request a provider round trip, and a JWKS outage
   longer than the key cache now costs SESSIONS, not just logins.** Making the
   refresh reachable created this exposure and it is stated plainly: a refresh
   whose replacement token cannot be verified REVOKES the session, because the
   exchange has already spent the presented refresh token. Bounds: keys are cached
   ten minutes, a cached hit makes no network call, and in that state every bearer
   request and every login is already failing closed. Preferred mitigation is to
   move the exchange off the request path — **not** to accept an unverified
   replacement token.

6. **Migration-057 ordering is proven by the CI upgrade job, not by an in-suite
   test — and it is now a real gate rather than a drill.** R4 replaced R3's local
   exercise with the committed fixture, verifier and ten-control runner of §8, all of
   which run in `ci.yml` and fail the job. What remains true is the shape of the
   proof: `npm test` alone still cannot fail if a future edit reorders `057`, because
   a mutated migration cannot change a database that has already been migrated. The
   `migration-upgrade` job is the gate, and `tests/ci-gates.test.ts` is what stops its
   controls from silently ceasing to bite — it asserts every negative-control anchor
   still resolves to exactly one statement in `057`.

7. **No HTTP administration surface exists.** The `identity.*` / `org.unit.*`
   actions and the engine that decides them ship, but no route declares them.
   Administration is the owned mutation services or the audited bootstrap command;
   raw `INSERT`s into `role_bindings` bypass versioning, authority and audit.

8. **Durable audit delivery is not claimed** (audit rows are transactional;
   the outbox is FBL-040). **Row-level security is FBL-030.** **SAML/SCIM are
   interfaces only, unenableable by database CHECK.** **`step_up_token_uses`
   (migration 050) is dead weight** — no longer written or read; dropping it is a
   future migration.

9. **Local schema fingerprints are corroboration only, and the authoritative in-CI
   comparison has NOT run for this tree.** It ran for **R3**: §12 records
   `dcfffc97630b664feccacee70b0a1aebb28e50d69d00c7fdc741c6c0aa0bc15a` for both fresh
   and upgraded across 41 tables, `equal=true`, from
   `upgrade-evidence/fingerprint-equality.txt` of the R3 run `31223131820` on
   `f816642`. That value describes the R3 schema and `057` has changed since, so it
   does **not** describe this tree; §9's local `271c8926…` does, and §13 says why no
   in-CI value can exist yet. The reason this is a risk rather than an undischarged
   gate is that the gate itself is present, wired and passing locally — it simply has
   no run to have executed in.

10. **No gate pins any figure in this report, and that risk has already
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

    **R4 narrows this substantially, and the narrowing is itself a gate.**
    `tests/delivery-documentation.test.ts` now reads THIS document and fails if: the
    governing-document citation drifts from the fact set in
    `docs/FBL-020-R4-REQUIREMENT-MAP.json`; any migration on disk is unnamed here;
    any battery the requirement map claims is unnamed here; any artifact filename
    cited here is not one `ci.yml` actually produces; a workflow run id appears
    without saying which revision it measured; an undischarged gate appears in this
    section; or the adapter claim reverts to its false form. Migration checksums keep
    their older defence — published beside their git blob OIDs, so a stale value can
    be caught by re-deriving it.
    **What is still unpinned: the diffstats in §10, and prose counts.** No gate
    recomputes those. _Treat every figure without a named artifact or a checkable
    identifier as true-when-written, and re-measure before quoting it._ Recorded in
    `docs/identity/KNOWN-LIMITATIONS.md`.

## 12. CI evidence for R3 — retained, and SUPERSEDED for R4

**Everything in this section measured R3, at commit `f816642`. It is retained
because the architect accepted those runs and artifacts as genuine, and because a
reader needs to be able to tell R3's numbers from R4's. NONE of it describes this
tree** — `057` has changed, the workflow has changed, and the suite has grown. §13 is
the R4 position.

Filled in after the R3 code-bearing commit was pushed and after the run whose
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

**315 / 315, zero failed, cancelled, skipped or todo.** This matched the local
figure the R3 report published, which was the point at the time: the local run was
corroboration and the in-CI run was the authority. It does **not** match §7's
figure any more, and must not be read as if it did — §7 now reports **459 / 47**
on the R4 tree, and this block is the R3 head's CI evidence, retained because a
reader holding the R3 report needs to be able to place it. The corresponding R4
number has no in-CI counterpart at all; see §13.

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

## 13. CI evidence for R4 — MEASURED

Filled in after the code-bearing commit was pushed and after the **`ci.yml`** run
whose `head_sha` equals that commit reported a conclusion.

**A near-miss worth recording, because this order is about evidence discipline.** The
first poller queried `/actions/runs?head_sha=…` and took `runs[0]`. Two workflows fire
on one SHA here, and it returned run `32028686605` —
`path=dynamic/dependabot/dependabot-updates`, `event=dynamic`, a single job named
"Dependabot", **zero artifacts** — `conclusion: success`. That is not the CI gate, and
reporting it as one would have been a false green of exactly the kind FBL-000 was
rejected for; the repository's own lesson from that rejection is to query
`/actions/workflows/ci.yml/runs` and read PER-JOB conclusions, and it was not followed
at the first attempt. It was caught because a real run on this repository has four jobs
and four evidence artifacts, and this had one job and none. Every value below comes from
the `ci.yml` run, identified by workflow path, with all four job conclusions read
individually rather than trusting a top-level field.

| Field                     | Value                                                                         |
| ------------------------- | ----------------------------------------------------------------------------- |
| Code-bearing commit SHA   | `2b75d8abbbf68f3e95c4542540ad90ade7da844f`                                    |
| Workflow                  | `.github/workflows/ci.yml` (**not** the Dependabot workflow on the same SHA)  |
| CI run id                 | `32028562952`                                                                 |
| Run URL                   | https://github.com/Alegnta19/Car-dealership-software/actions/runs/32028562952 |
| `head_sha` equals commit? | **YES** — compared explicitly                                                 |
| Event                     | `push`                                                                        |
| Status / conclusion       | `completed` / **success**                                                     |
| Jobs / non-success        | **4 / 0**                                                                     |

| Job                                                        | Conclusion  |
| ---------------------------------------------------------- | ----------- |
| typecheck, lint ratchet, build, all tests, scans           | **success** |
| populated upgrade drill + reconciliation negative controls | **success** |
| container build (digest-pinned base)                       | **success** |
| secret scan (genuine full history)                         | **success** |

| Artifact               | Size     | sha256 (downloaded zip)                                            |
| ---------------------- | -------- | ------------------------------------------------------------------ |
| `baseline-evidence`    | 73,422 B | `537665d3a26e6a58808bf2c3f4189fbb37bd0facae9f8febe8deb937e71e0521` |
| `upgrade-evidence`     | 42,931 B | `315ce719f29908aed59e53afdd33042c4c653490c3b1a7d91a5b33ffb65fdf56` |
| `secret-scan-evidence` | 8,109 B  | `b2134e70db8f2abaad67056fbdfd932fc322f4612b44fb6c5084eb798b1be1eb` |
| `container-evidence`   | 701 B    | `41b0ebae7a0279888e03b8f417158ee7a5bda2df900a4f9e74438cf03aa82b9c` |

### Read from the run's own artifacts

`baseline-evidence/test-summary.json` — **459 tests / 47 suites, 459 passed, 0 failed,
0 cancelled, 0 skipped, 0 todo**, and the enforced floors travel with it
(`floor_tests: 459`, `floor_suites: 47`), so a future revision cannot quietly shrink
the suite. Identical to the local figure; local corroborates, this is the authority.

`upgrade-evidence/identity-pre-057.json` — the §6 gate that R3 did not have. The legacy
identity seed is **nonempty**: 3 provider connections, 4 user links, 3 identity
sessions, 4 role bindings, 2 policy decisions, 3 reauthentication transactions, 1
grant, 2 support requests, 1 support session. `identity-post-057.json` reports the same
counts before and after with `failures: []` — 057 reconciled the rows and invented or
destroyed none.

`upgrade-evidence/negative-controls.json` / `.txt` — each load-bearing reconciliation
removed on an isolated copy, every control **CONTROL SATISFIED** with
`signature_matched=true`, and the failures land where declared: `ul_activated_is_bound`
raises SQLSTATE 23514 at the MIGRATION stage, while the derivation controls fail at the
VERIFIER stage with the exact row-level diff. The reconciliation is load-bearing, proven
in CI rather than by a hand drill.

`baseline-evidence/mutation-kill.json` / `.txt` — **7 mutations, 7 killed, 0 survived**,
each with `baseline_green=true`, `working_tree_intact=true` and the named dead tests, run
in an isolated copy of the tree. Reverting the effective-window rule, the MFA validity
deadline, activated-link-only admission, the server-generated request id, the support
header expiry, the assurance floor, or the ledger drift refusal each kills specifically
named tests.

`baseline-evidence/requirement-map-check.txt` — _requirement map OK: every requirement
resolves to tests, code, steps and artifacts that exist_.

`baseline-evidence/worker-expiry-pass.txt` — the support-expiry job runs as a real
worker pass: `{"jobs":["identity.support_access.expiry"],"mode":"once"}`. §4's processor
is reachable in the shipped worker, not merely implemented.

`upgrade-evidence/fingerprint-equality.txt` — fresh == upgraded ==
`271c892662937a33c2972b83a30c4f02f441a5d058ac076e07d4248dd5d29d9f`, `equal=true`.

`container-evidence/image-digest.txt` —
`sha256:63d2e67be36d20b0ffbb47c040ceecbd2c8976def1a0c535feb6f92ba1b3060e`.

`baseline-evidence/tool-versions.txt` — `node=v20.20.2`, `npm=10.8.2`, `tsc=5.9.3`,
`eslint=v10.8.0`, `prettier=3.9.6`,
`postgres:16-alpine@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777`.

**The R4 CI gate is DISCHARGED for `2b75d8a`.** This documentation closeout is a second
commit and runs its own build; its result does not retroactively alter anything above,
which describes `2b75d8a` only.

Implementation parent `9cba262749469178e47f4a4540b1500da25207fa`; cumulative
acceptance base `cac9b21`.

The evidence inventory below was written while this section was still an explicit
placeholder, and it is retained because it is what makes the section auditable: the
artifact names were declared BEFORE the run existed, and every one of them is asserted
to appear in `ci.yml` by `tests/delivery-documentation.test.ts`. Comparing this list
against the four artifacts actually produced is how a reviewer confirms nothing was
quietly dropped. Job
`typecheck, lint ratchet, build, all tests, scans` uploads `baseline-evidence`
containing `tool-versions.txt`, `migrate-second-run.log`, `migration-manifest.json`,
`healthz.json`, `worker-smoke.txt`, `worker-expiry-pass.txt`, `test-output.log`,
`test-summary.json`, `schema-fingerprint.json`, `schema-fingerprint.txt`,
`requirement-map-check.txt`, `mutation-kill.json`, `mutation-kill.txt`,
`npm-audit.json` and `sbom.cdx.json`. Job
`populated upgrade drill + reconciliation negative controls` uploads
`upgrade-evidence` containing `fixture-checksums.json`, `upgrade-log.txt`,
`pre-057-chain.txt`, `upgrade-backfill.txt`, `upgrade-backfill.json`,
`identity-pre-057.txt`, `identity-pre-057.json`, `identity-post-057.json`,
`negative-controls.txt`, `negative-controls.json`, `constraint-state.txt`,
`upgraded-schema-fingerprint.json`, `fresh-schema-fingerprint.json`,
`fingerprint-equality.txt` and `upgraded-healthz.json`. The `container` and
`secret-scan` jobs upload `container-evidence` (`image-digest.txt`,
`container-config.txt`) and `secret-scan-evidence` (`gitleaks.sarif`,
`scan-evidence.txt`, `suppressions.txt`). Each of those names is asserted to exist in
`ci.yml` by `tests/delivery-documentation.test.ts`, so this list cannot drift from
the workflow.

## 14. FBL-020-R4 — what this revision adds, and how each part is proved

The machine-readable version of this section is
`docs/FBL-020-R4-REQUIREMENT-MAP.json`, checked by
`scripts/check-requirement-map.ts` and by `tests/ci-gates.test.ts`: every
requirement there names tests that must EXIST verbatim, code paths that must exist,
CI steps that must be in `ci.yml`, and artifacts that `ci.yml` must produce. A
renamed test breaks the map, and the map breaking fails the suite.

| R4 § | What it adds                                                                                                                                                                                                                                                                      | Proved by                                                                                                                                                                                                    |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| §0   | The architect's census: **no persistent environment has ever applied `057`**, so it is corrected IN PLACE and there is no `058`.                                                                                                                                                  | Architect finding; §6 records the resulting checksum move                                                                                                                                                    |
| §0   | The migration ledger records **what** was applied — `checksum_sha256` + `checksum_algorithm`, canonical-LF, written in the same transaction as the DDL. A changed body of an applied migration now REFUSES the run and names both digests instead of being silently skipped.      | `tests/migration-ledger.test.ts`                                                                                                                                                                             |
| §1   | Login admission in one call at the wire: opaque-handle claim, exact redirect, indistinguishable refusals, absence never agreement, no privilege from a pending link.                                                                                                              | `tests/login-admission.test.ts`                                                                                                                                                                              |
| §2   | The identity tuple enforced by composite FOREIGN KEYS; `policy_decisions.evidence_version` 2 with conditional completeness constraints and an INSERT-time version floor; server-generated request/correlation ids; assurance read from the presented session and the exact grant. | `tests/identity-evidence.test.ts`, `tests/auth.test.ts`, `tests/identity-boundary.test.ts`, `tests/identity-journey.test.ts`, `tests/organization.test.ts`, `tests/policy.test.ts`, `tests/platform.test.ts` |
| §3   | The reauthentication row is authoritative for its own callback; every provider-side failure reaches exactly one explained terminal state with one audit event; MFA certification is bounded, revocable and fails CLOSED.                                                          | `tests/identity-lifecycle-audit.test.ts`, `tests/reauthentication.test.ts`                                                                                                                                   |
| §4   | Non-suppressible support context end to end, and a support window's expiry as a recorded, once-only, idempotent transition the production worker performs.                                                                                                                        | `tests/support-context.test.ts`, `tests/support-expiry.test.ts`                                                                                                                                              |
| §5   | Organization units become owned mutations — attributed, versioned, audited — and the boundary is enforced by a checker that rejects each reintroduced bypass.                                                                                                                     | `tests/owned-mutations.test.ts`, `npm run architecture:check`                                                                                                                                                |
| §6   | The populated upgrade drill and the ten reconciliation negative controls.                                                                                                                                                                                                         | §8; `tests/ci-gates.test.ts`                                                                                                                                                                                 |
| §7   | The test-summary floors, the requirement map, the mutation-kill checks, and documentation tests that read the delivery documents.                                                                                                                                                 | `tests/ci-gates.test.ts`, `tests/delivery-documentation.test.ts`                                                                                                                                             |

### The §7 gates, and the defect the mutation-kill run found

`scripts/mutation-kill.ts` copies the tree into a temporary directory, requires the
named battery to be GREEN, removes ONE control, and requires the battery to FAIL with
the named test among the dead. Locally: **7 mutations, 7 killed, 0 survived** — but
only after a fix, and the fix is the point.

The seventh mutation covers the §0 blocker itself. `ledger_drift_ignored` restores the
pre-R4 defect in `scripts/migrate.ts` — the drift comparison is still computed, its
result is simply not acted on — and requires `tests/migration-ledger.test.ts` → _a
CHANGED body of an applied migration REFUSES the run, names the file and both digests_
to die. It does. Because that mutation edits `scripts/` rather than `packages/`, the
`assertIsolation` step is derived from the mutation set instead of hard-coded to one
module: every file any mutation edits must be present in the copy and byte-identical to
the original, so a mutation added later against a tree the copy filter excluded aborts
the run rather than being reported as a surviving control for a reason that has nothing
to do with the control.

**`pending_link_admitted` SURVIVED on first run.** Widening
`AND ul.status = 'activated'` to admit `'pending'` in
`packages/identity-access/src/login-admission.ts` broke no test, because the
pre-existing test's pending link is created UNBOUND by the observation and the binding
clause refuses it whatever its status. A BOUND pending link is not hypothetical:
migration `057` §1 binds a link from its tenant's single active connection **without
regard to status**, so after any upgrade a pending link carries a complete tuple —
`§8`'s own fixture asserts that shape. An identity no administrator had ever activated
could therefore have logged in, and the suite would not have noticed. R4 adds
`tests/login-admission.test.ts` → _a BOUND but PENDING link is refused — binding is
provenance, not authority_, which kills the mutation.

The other five mutations and the tests they kill: role-binding effectiveness →
`tests/policy.test.ts`; MFA certification expiry → `tests/identity-lifecycle-audit.test.ts`;
client-supplied request id → `tests/platform.test.ts`; support-header expiry →
`tests/support-context.test.ts`; assurance floor → `tests/identity-boundary.test.ts`.

### Test-summary floors

`scripts/parse-test-summary.ts` now REQUIRES all eight summary fields — `tests`,
`suites`, `pass`, `fail`, `cancelled`, `skipped`, `todo` and `duration_ms` — and
enforces floors. R3 read `todo` but did not require it, so a reporter that stopped
emitting it would have removed `todo` from both the consistency equation and the
zero-check; and nothing enforced a size floor at all, so a suite that shrank to one
test was a pass. The order fixed a minimum of **315 tests / 29 suites**; R4's additions
raise the real counts, and the declared floors are set to them: **459 tests, 47 suites**,
measured locally at zero failed, cancelled, skipped and todo. R3's accepted in-CI figure
was 315 / 29 (§12), so this is **+115 tests and +13 suites** on the same gate. The
authoritative copy of the measurement will be `test-summary.json`, which now also records
the floors it was judged against.

`tests/ci-gates.test.ts` asserts that the floors never fall below the order's minimum,
that the source literals agree with the exported constants, and that the **suite** floor
never rises above the `describe(` declarations on disk — Node reports one suite per
declaration and this tree's anchored count matches the reported total exactly (42 and 42),
so a floor above it would make CI permanently red.

The **test** floor is **not** upper-bounded from source, and the battery states that
rather than implying otherwise. A `test(` inside a loop yields several tests from one
site, so the declaration count — 444 — is a _lower_ bound on the 459 that run, and it
cannot confirm that a floor pinned to the measured total is reachable. Only a measured run
can, which is why the floor is pinned to `test-summary.json`. The direction source _can_
decide is checked: a floor below the declaration count is certainly too low.

**A defect in this section's own first draft, disclosed.** The earlier draft asserted the
test floor against a naive `/\btest\(/` count and claimed that count was a lower bound on
what runs. Both halves were wrong. The count included every occurrence in comments and
message strings, which made it an inflated _upper_ bound — 437 against the 425 that run,
as this battery then stood — and made the bound self-fulfilling, because prose describing
the check raised the number the check was measured against. A deliberately over-raised
suite floor of 44 SURVIVED that check for exactly this reason: the new explanatory comment
had lifted the naive `describe(` count from 43 to 45. Anchoring both counts to statement
position fixed it. Those two demonstrations were re-run on THIS tree rather than carried
forward, because the counts moved when the R4-R4-R4 closeout added its batteries: a suite
floor of 48 dies on `the suite floor is 48 but only 47 suite declarations exist`, and a test
floor of 400 dies on `444 test declarations exist but the floor is only 400`. The floors
this tree declares are 459 / 47, and the second of those two messages is also what forced
the raise — a floor below the declaration count is refused, and this closeout took the
declarations to 444.

### The documentation gate

`tests/delivery-documentation.test.ts` reads this report, `KNOWN-LIMITATIONS.md`, both
runbooks and the `README`. It fails if the governing-document citation drifts from the
requirement map's fact set, if a migration or a mapped battery is unnamed here, if a
cited artifact is not one `ci.yml` produces, if a run id appears without saying which
revision it measured, if an undischarged gate is filed under residual risk, or if the
adapter claim reverts to its false form. R3's `tests/docs.test.ts` checks the
PHASE-248 architecture reference — worth having, kept, and **not** a check on the
delivery documents, which was the gap.

### The R4-R4 closeout — three findings, and what each one now enforces

The R4 review returned three findings. All three were the same species of defect in
different sizes: a document asserting a strength the code did not deliver.

**F1 (MEDIUM) — the audit inventory documented a subset while claiming to be complete.**
`packages/identity-access/src/audit-inventory.ts` said in its own header that "a transition
added to the platform without an entry fails the completeness assertion". No such assertion
existed anywhere in the repository. The inventory listed **19** entries, and the missing ones
included `identity.support.expired` — inside the inventory's OWN declared `support` family,
written by §4's own expiry processor. The suite stayed green throughout, because nothing
compared the list to the code. This is the R3 failure mode repeating, and it is why the
closeout treats it as disqualifying rather than cosmetic.

Two counts, kept apart because only one of them is this delivery's measurement. The review
reported **33 production audit events outside the inventory, four of them inside the support
family**; the exact scope of that scan is not restated here, though it reconciles with a scan
of `packages/**` alone, which holds **52** distinct `identity.`-namespaced literals against
the 19 that were listed. What this delivery measures, over `packages/`, `apps/`, `scripts/`
AND `migrations/`, is **54** distinct literals: **46** audit event types, all now
inventoried, and **8** that are not audit event types and are now declared as such. No
attempt is made to reproduce the review's figure exactly — the finding is accepted on its
substance, which is that the list was a subset and the header said otherwise.

Three things changed, in this order:

1. **The enumeration is now complete**, and it was derived by scanning the audit-write call
   sites and every `identity.`-namespaced literal across `packages/`, `apps/`, `scripts/`
   and `migrations/` — not from a hand list. The inventory carries **46 entries over 9
   declared families**: the four the order enumerates by name (`login`, `session`,
   `reauthentication`, `support`) plus the identity mutations §14.3 requires to persist an
   audit event (`user_link`, `organization`, `organization_unit`, `provider_connection`,
   `role_binding`). Each entry names its transition, its event type, its entity type, its
   writer, and — new — the FILE and the verbatim TEST NAME that prove it. R3's `provenBy`
   values were prose matching no test in any file. Eight literals in the namespace are
   **not** audit event types and are declared as such with their role and reason: seven
   policy action keys (two of them, `identity.support.approve` and
   `identity.support.revoke`, inside the declared support family by name) and one worker job
   name (`identity.support_access.expiry`).
2. **The assertion the header described now exists**: `scripts/check-audit-inventory.ts`,
   wired into `npm run architecture:check`. It reads production TypeScript with the
   TypeScript AST and the migrations as comment-stripped text, and fails when a NAME in
   the `identity.` namespace is neither an inventory entry nor a declared non-audit literal;
   when a name can only be PARTLY read; when an `INSERT INTO audit_events` appears
   in a file that is not a declared writer; and in the reverse direction, when an inventory
   entry names an event nothing writes, a declared literal has gone, a declared writer no
   longer writes, an entry's family contradicts its own event type, or an entry's proof
   citation names a file or string that does not exist.
   The FIRST version of this gate read names with one regular expression plus one look at a
   template's head, and **the F1a finding below is that both were walked past**; the
   sentence above is scoped to what the SHARED resolver reads because of it.
3. **The header describes that and no more**, and the limits it does not enforce are
   recorded in `docs/identity/KNOWN-LIMITATIONS.md` and DEMONSTRATED by fixtures the gate
   accepts, rather than implied away. F1b below is the correction that made that true of
   every one of the six places the claim appeared.

The gate is proved in both directions by `tests/architecture.test.ts`: the real tree passes,
and `architecture/fixtures/audit-inventory-gap/` reintroduces each evasion and must be
rejected by its own rule, while `architecture/fixtures/audit-inventory-declared/` must be
accepted so the gate cannot be satisfied by a checker that always fails. Closing F1 also
surfaced one production audit event that no test asserted at all —
`identity.user_link.login_refused`, written from both the deactivated and the
foreign-connection branches of `observeUserLinkOnLogin` — so
`tests/identity-core.test.ts` gained _a REFUSED login is audited, in both branches that
refuse one_, which asserts one row per branch, the distinct reasons, and that the
foreign-claim refusal names NOBODY as actor.

**F2 (LOW) — the ceiling reconciliation.** See §7: the governing blueprint says `format
<=23`, ADR-005 said 29, and R3 had "corrected" the reporting to the ADR on the grounds that
it was the only definition site in the repository. Both documents now read 23 and say which
one defines it.

**F3 (LOW) — the indistinguishability test sampled six of fifteen refusals.**
`tests/login-admission.test.ts` drove `refusals.slice(0, 6)` and compared parsed JSON. It
now drives **every** scenario — inactive tenant, closed tenant window, archived hierarchy,
both UserLink windows, all three connection states, issuer drift, all four exchange↔token
mismatches and both impersonation branches — and compares the RAW BYTES plus status,
content type, content length, `Set-Cookie` and `Location`. Per scenario it also asserts no
session row, no session cookie and no stored provider credential, and that the true reason
still reaches the transaction row. The order's own enumeration is held against the scenario
table by label, so deleting a scenario fails the test rather than shortening the loop. The
three internal reasons the callback can reach that are NOT admission refusals —
`provider_exchange_failed`, `token_verification_failed`, `session_establishment_failed` —
are provider faults and a local write failure, and each is driven to its single terminal
state and single audit event by `tests/identity-lifecycle-audit.test.ts`.

### The FBL-020-R4-R4 closeout — six findings, and the rule each one now buys

The fourth review returned six findings. F1a is the one that matters, and it is the same
species as every previous rejection: **a document asserting a strength the code does not
deliver** — this time in the very module sent to fix that, and re-committed by the wave sent
to fix it. Both compounding mistakes are recorded here, because the fix is structural rather
than textual.

**F1a (HIGH) — the audit-inventory gate was defeated by string concatenation, and by a
template whose head is the interpolation.** The namespace pattern required two dots after
the root, so neither fragment of `'identity.support' + '.quarantined'` matched, and the
template rule inspected `node.head.text`, which is EMPTY in `` `${NS}.quarantined` ``. Twelve
lines produced a brand-new audit event type in a DECLARED family, from a DECLARED writer,
with a real audit row — and `exit 0`.

The cause was not a missing pattern. It was that the previous wave wrote **a third
hand-written string analysis from scratch** when `scripts/check-role-binding-effectiveness.ts`
already owned a static evaluator resolving concatenation, `.join`, `.concat`, `+=`
accumulation, indexed fragments, `String.raw` and template tags — and already shipped
`architecture/fixtures/role-binding-drift/evasion-k-string-concat.ts` for this exact evasion.
Three of R3's seventeen defects were duplicate hand-written predicates drifting from a shared
one; this was the fourth in the making.

So the evaluator was EXTRACTED, not patched. `scripts/static-string-resolver.ts` is the ONE
implementation and BOTH gates import it. The role-bindings guard keeps its behaviour by
PINNING its shared predicate through the resolver's single hook — its full fixture corpus is
unchanged and still green, at the same per-file violation counts. The audit gate resolves
every candidate name through the resolver and FAILS LOUD where a resolution is indeterminate:
a readable root with an unreadable tail is `audit-event-type-assembled-at-run-time`, and an
unreadable root followed by a declared family is the new
`audit-event-type-namespace-root-assembled-at-run-time`.
`architecture/fixtures/audit-inventory-assembly/` holds twelve spellings — concatenation,
interpolated head, `.join`, both `.concat` spellings, `+=` accumulation, `[i]` and `.at(i)`,
`String.raw`, a lookup map under an unresolvable key, `?:`/`??`, cross-file plain and aliased
imports, and five unmodelled rewrites. **All twelve are rejected now**, with their resolved
names pinned by _EVERY assembly spelling the shared resolver reads is REJECTED, and none
passes silently_.

This paragraph previously also stated how many of the twelve the **pre-F1a** gate had
missed. That figure is withdrawn, not corrected: two sites published it as eleven
(here and `KNOWN-LIMITATIONS.md`) and two as ten (`tests/architecture.test.ts`), so at
most one was right and nobody re-ran the measurement before publishing. Reconstructing a
gate that no longer exists in order to score its failure is not evidence this delivery
needs — what matters is that all twelve are rejected by the gate that ships, which is
asserted by a test and reproducible today. Withdrawing an unverified number is the honest
move; picking whichever of the two readings sounded better would have been the same defect
this order was rejected for, at a smaller scale. That a FOURTH copy cannot be written is itself a test:
_both gates import ONE static string resolver, and neither keeps a private copy_.

**F1b (HIGH) — six sites asserted an absolute the gate does not enforce.** Three of them were
the "here is what is NOT enforced" sections whose whole purpose is to be exhaustive, and they
omitted this limit. Every claim in `packages/identity-access/src/audit-inventory.ts`,
`scripts/check-audit-inventory.ts`, `docs/identity/KNOWN-LIMITATIONS.md` and this report is
re-derived from what the code now does and scoped to **what the shared resolver can read**
rather than to "a string literal". The residue that remains — a name where NEITHER the root
NOR a declared family is readable — is named in all three "not enforced" sections and is
DEMONSTRATED by `architecture/fixtures/audit-inventory-residue/`, which the gate must ACCEPT.
No absolute is written anywhere without a fixture behind it, and closing a residue later
turns _the residue the gate cannot see is ACCEPTED, and named in the documents_ red, forcing
the documents to change with the code.

**F2 (MEDIUM) — about ten of the gate's rules could be deleted with no test dying.** Measured,
not argued: `checkInventoryShape()` was deleted wholesale and `tests/architecture.test.ts`
stayed 13/13 while `tests/ci-gates.test.ts` stayed 14/14. A fixture cannot reach those rules
— they judge the DECLARATION, not a scanned file — so the rule functions are exported and
driven directly by `tests/audit-inventory-rules.test.ts`: one test per rule, against a
baseline proved clean first, asserting the WHOLE rule set so a neighbouring rule cannot stand
in for a deleted one. Twenty-two rules, twenty-two tests — fourteen shape rules, the forward
accounting rule, the writer rule, the three staleness rules, the migration rule, plus the two
fail-loud rules F1a added. The per-rule mapping and the deletion demonstration are in §7.

**F3 (LOW) — a cross-reference to figures §7 no longer contains.** `KNOWN-LIMITATIONS.md`
restated §7's Prettier count and §10's changed-path split, and both went stale when R4 rewrote
those sections — in the one bullet whose entire warning is "re-measure before quoting". The
copied figures are REMOVED rather than restated; the bullet now names the sections that
measure each population and the command that reproduces each one.

**F4 (LOW) — migration 057's header said `FBL-020-R2`** while the file carried five R4
sections and the R3 corrections. The §14.3 citation is correct for the file's ORIGIN and is
kept; the header now describes the file's actual content and revision history, and states
that the checksum has moved with every revision. That comment-only edit moved the digest
again, which §6 records with the superseded value beside it.

**F5 (LOW) — a redundant `EXISTS` presented as a load-bearing fact.** In
`LOGIN_CONNECTION_ADMISSION_SQL`, the legal-entity clause joins the entity to a dealer group
of the SAME tenant under the same three conditions, so it SUBSUMES the separate dealer-group
clause: no database state can fail only on the removed one, so no scenario could be written
to pin it — which is why the first option the finding offers does not exist. **The clause is
removed** and the module header states the subsumption and why the alternative was
impossible. The property is now tested in both directions by
`tests/login-admission.test.ts`: a login is refused when the legal entities are archived, and
refused when the DEALER GROUPS are archived and the legal entities are left ACTIVE, through
the join inside the surviving clause.

### One stale claim, corrected precisely

R3's report and `KNOWN-LIMITATIONS.md` both said the WorkOS adapter was compiled and
confinement-tested but that **"no test invokes it"**. That is **wrong**.
`tests/identity-config.test.ts` constructs the real adapter with
`createWorkosProvider(...)` and calls `provider.refreshSession(...)` over a MOCKED
transport (`globalThis.fetch` substituted before construction), asserting that the
exchange is bounded, aborts its socket, and surfaces silence as `transient` rather
than as a definitive refusal. So the adapter IS invoked, in process, against a mocked
transport. What is untested is **LIVE WORKOS CERTIFICATION IS NOT DISCHARGED** —
real AuthKit redirect parameters, real token claim shapes, real `max_age=0` semantics,
real organization membership, the actual MFA-required organization policy, and whether
WorkOS's own endpoints return the shapes the adapter maps. §15.

## 15. Gates NOT DISCHARGED

Not risks. Not residual. **Work that is not done**, listed separately because R3 filed
the first of these under "residual risk" and was rejected for it.

1. **LIVE WORKOS CERTIFICATION IS NOT DISCHARGED.** No live WorkOS credentials exist
   in this environment. Every provider property is proven against a deterministic
   local RSA issuer and a provider-neutral fake, and the adapter itself is invoked
   only over a mocked transport (§14). Real AuthKit redirect parameters, real token
   claim shapes, real `max_age=0` semantics, real organization membership and the
   actual MFA-required organization policy are **untested**. There is no way to
   discharge this from here: it needs credentials and an operator. The substitution
   point is `useIdentityProviderForTests`.

2. ~~**The R4 CI run is NOT DISCHARGED.**~~ **NOW DISCHARGED.** All four jobs —
   including the populated upgrade drill, the reconciliation negative controls, the
   mutation-kill checks and the requirement-map check — executed in CI for this tree
   and reported `success` on `ci.yml` run `32028562952`, whose `head_sha` equals the
   code-bearing commit `2b75d8a`. §13 carries the per-job conclusions, the four
   artifact digests, and the figures read from the artifacts themselves. The original
   wording is struck through rather than deleted so this list still shows what was
   undischarged at code-freeze and what closed afterwards.

**So exactly one gate remains undischarged: live WorkOS certification.** Everything
else the R4 order requires is done and CI-proven. Four items are open but they are
**not gates** — they are gaps in guard scaffolding, itemised in §11 and in
`docs/identity/KNOWN-LIMITATIONS.md` under "Open at R4 submission", disclosed at the
repository owner's instruction rather than held for another correction pass.

## 16. Position

FBL-000 closed → FBL-010 closed → **FBL-020-R4 submitted for code-gate review, R3
REJECTED for missing mandatory controls** → live WorkOS certification **NOT
DISCHARGED** (no credentials, §15.1) → R4 CI run **NOT DISCHARGED** (nothing pushed,
§15.2) → FBL-030 **not started**, and nothing in this revision touches it.
