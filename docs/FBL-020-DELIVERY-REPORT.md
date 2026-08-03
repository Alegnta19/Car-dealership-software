# FBL-020 — Identity and Organization v1: Delivery Report (R1)

This report supersedes every earlier version. The previous one was rejected as
non-authoritative: it cited an older CI run, reported 204 tests, and referenced
a section that did not exist. Its evidence is discarded, not amended.

**Status: FBL-020 CODE COMPLETE — LIVE CERTIFICATION PENDING.**
Gate A (code + deterministic CI) is presented for review at the final-head run
recorded in §9. Gate B (live WorkOS certification) is **not** attempted: no
live WorkOS credentials exist in this environment. **FBL-030 has not been
started.**

## 1. Final head and exact CI run

|                               |                                               |
| ----------------------------- | --------------------------------------------- |
| Base head (R1 order)          | `1b1a1bcbcefdd7302e452159af54faaa7f68753f`    |
| Final commit                  | see §9                                        |
| `HEAD` == `origin/main`       | see §9                                        |
| Exact final-head `ci.yml` run | see §9 (id, URL, event, head SHA, conclusion) |

Runs `30823396770` and `30827939487` are **not** the R1 run and are not reused
as evidence.

## 2. Migrations

| File                                             | sha256 (first 32)                  |
| ------------------------------------------------ | ---------------------------------- |
| `000_platform_core.sql`                          | `a3e0f4ca4990a313cabdefa8b26ca762` |
| `049_phase248_service_cockpit.sql`               | `523ee2e236b427e55fdd06037f350ac4` |
| `050_phase248_hardening.sql`                     | `ec3b02e23f10a1be2236579118ee1cc4` |
| `051_phase248_metrics_support.sql`               | `e79d9a9fd56b76134ab6823fd8f7c83a` |
| `052_phase248_authorization_binding.sql`         | `94179a31e1f96185af52ecc37bc93bb9` |
| `053_phase248_estimate_line_association.sql`     | `a2e125e122ec455ee19d1c18ffd6f08a` |
| `054_phase248_waitlist.sql`                      | `8382d8efda1769de0828fd0de74cb8f8` |
| `055_identity_organization.sql`                  | `52a56f414725adc5751c88bc256c9fe5` |
| **`056_identity_contract_completion.sql`** (new) | `ff2d0307d374efba41b4ff79268ace9b` |

**Byte-identity proof:** `git diff 1b1a1bc..HEAD -- migrations/` produces no
output for 000 and 049–055. Migration 056 is purely additive: it creates no
table, deletes no row, and every security assertion it adds defaults to the
CLOSED value.

**Fingerprint (authoritative, measured in CI):** fresh and upgraded schemas
converge on
`2f2baa245172ab217ef12d68f0ff4619b846623fbbef83916416f85aa06e3789`,
`equal=true`. This supersedes `c43ff9bf…`, which described the pre-056 schema.

The local Windows/WSL run produced `f7f7ca99…` for the same schema — catalog
text differs across PostgreSQL builds, so local values corroborate the
migration but are **never** presented as authoritative.

## 3. What R1 changed, by order section

### B — UserLink lifecycle

Login no longer activates anything.

| Situation                      | Result                                                     |
| ------------------------------ | ---------------------------------------------------------- |
| Unknown provider identity      | ONE idempotent **pending** link created; no session        |
| Pending link, subsequent login | bounded identifier refresh only; still pending; no session |
| Deactivated link               | refused; no session; audited                               |
| Activated link                 | session issued                                             |

Activation is `activateUserLink`: explicit, attributable
(`activated_by_user_link_id`), version-incrementing, and it creates **no**
RoleBinding. Bootstrap remains dry-run-by-default, refuses ambiguous mappings,
and prints no credentials. Pending, deactivated and unknown are externally
indistinguishable.

### C — Provider and session revocation

Every bearer **and** cookie request re-checks: tenant, provider connection,
**issuer agreement**, user link, local session — all active and effective.
Sessions record the connection they were established through. Five independent
kill switches deny the very next request with the same otherwise-valid
credential, with no restart and no expiry wait:

| Disable                                 | Result |
| --------------------------------------- | ------ |
| provider connection `status='disabled'` | 401    |
| provider connection window expired      | 401    |
| tenant suspended                        | 401    |
| user link window expired                | 401    |
| connection issuer ≠ configured issuer   | 401    |

### D — OIDC claim completion

A cryptographically random nonce is minted for login **and** reauthentication,
sealed in the transaction cookie, sent on the authorization request, required
back, and compared against that same single-use transaction. It is distinct
from `state`, the PKCE verifier and every internal grant identifier, and it is
never logged. Missing, mismatched, near-miss and replayed all fail closed.

`org_id` is now required **inside the verifier** — bounded, non-empty — so the
rejection cannot be forgotten by a later caller. The former positive test is
reversed into three negatives (absent, empty, over-long).

### E — MFA and high assurance

| Assurance              | Requires                                                                 |
| ---------------------- | ------------------------------------------------------------------------ |
| `fresh_only`           | fresh provider authentication (`max_age=0` + `auth_time`)                |
| `fresh_and_mfa_policy` | that **and** an active connection certifying the organization MFA policy |

Uncertified, false, expired or inactive certification **fails closed** and
mints nothing. No AMR value is fabricated and no authentication method is
claimed. Classification is recorded on the grant and in policy evidence.

### F — Exact typed-resource RoleBindings

`scope_level='resource'` matches on tenant + resource type + resource id, and
nothing else — no descendants, no siblings, never a tenant-wide action. Four
database CHECKs refuse ambiguous or incomplete scope.

### G — Complete policy evidence

Every stored decision carries matched binding ids with their authorization
versions, freshness and MFA classification, a correlation id distinct from the
request id, and the support request/session when applicable. A **deny may
never claim a matched binding** — enforced by CHECK, not convention. Evidence
remains append-only and free of names, emails, tokens, bodies and support
reasons.

### H — Data-dictionary reconciliation

All 14 tables were audited against the field rules. The five organization
tables gained the missing `created_by` / `updated_by` / `authorization_version`.
Six records legitimately omit some fields, and each omission is **documented
with its reason** in `docs/identity/DATA-DICTIONARY.md` §5 — for example,
`policy_decisions` is append-only immutable evidence, so it has no status to
change, no window to expire, no updater and no version. No hard deletion of
organization, identity, role, session, reauthentication, policy or
support-access history exists anywhere.

## 4. Defects introduced by this wave and caught before submission

Stated because they are useful signal, not because they were required:

1. `deactivateUserLink` did not stamp `deactivated_at`, which its own new
   CHECK requires.
2. The bootstrap command did not record an issuer, which section C makes
   mandatory.
3. An empty-string issuer placeholder in the test kit broke 50 unrelated
   tests — a fixture asserting a value the schema forbids.
4. `policy_decisions.scope_level` was not widened alongside `role_bindings`,
   so evidence could not name the level it matched.
5. My own revocation test wrote an invalid effective window
   (`effective_to` before `effective_from`).

## 5. Verification

| Gate                | Windows      | Linux / Node 20.20.2 | CI     |
| ------------------- | ------------ | -------------------- | ------ |
| Full battery        | 221 / 221    | see §9               | see §9 |
| Build               | 0            | see §9               | see §9 |
| Architecture checks | 4 / 4        | see §9               | see §9 |
| Quality ratchet     | 53 / 125 / 1 | see §9               | see §9 |

Zero failures, skips, cancellations or todos. Ceilings remain **59 / 136 / 23**
and were not raised; the recorded baselines are tighter.

**Raw-output sentinel scan:** 0 matches for token, nonce, cookie,
authorization-code, credential and PAT patterns across the full raw test log.

## 6. Change surface

Confined to the authorized areas. `git diff 1b1a1bc..HEAD` touches **nothing**
in `packages/fixed-ops`, `apps/api/src/routes/service-cockpit.ts`,
`quality-baselines.json` or `.github/` — Fixed Ops business behavior, the
44-route surface, the quality ceilings and CI are untouched.

## 7. What this delivery still does NOT prove

- **No live WorkOS behaviour is exercised.** Every verifier property is proven
  against a deterministic local RSA issuer. Real AuthKit parameters, real claim
  shapes, real `max_age=0` semantics, real organization membership and the
  **actual MFA-required organization policy** are untested. That is Gate B.
- The WorkOS SDK adapter compiles and is confinement-tested; no test invokes
  the real SDK.
- Audit rows are transactional; durable delivery is **not** claimed (FBL-040).
- RLS remains FBL-030. `step_up_token_uses` (migration 050) is dead weight;
  dropping it is a future migration.

## 8. Position

FBL-000 closed → FBL-010 closed → **FBL-020-R1 submitted for code-gate
review** → live WorkOS certification blocked → FBL-030 **not started**.

## 9. Final-head evidence

### Code-gate run — every code, migration and test artifact

|                                |                                                                                              |
| ------------------------------ | -------------------------------------------------------------------------------------------- |
| Commit                         | `e3844bd6c923470e79bf8d941505f9ea27f78e86`                                                   |
| Run                            | [30838463840](https://github.com/Alegnta19/Car-dealership-software/actions/runs/30838463840) |
| `head_sha` reported by the run | `e3844bd6c923470e79bf8d941505f9ea27f78e86` (equals the commit)                               |
| Event                          | `push`                                                                                       |
| Conclusion                     | **success**                                                                                  |

| Job                                              | Conclusion |
| ------------------------------------------------ | ---------- |
| typecheck, lint ratchet, build, all tests, scans | success    |
| upgrade from earliest retained schema fixture    | success    |
| container build (digest-pinned base)             | success    |
| secret scan (genuine full history)               | success    |

| Artifact               | Size     | sha256 (first 32, as downloaded)   |
| ---------------------- | -------- | ---------------------------------- |
| `baseline-evidence`    | 48,686 B | `419fa8fc6bd90191970ce7a21597cd16` |
| `upgrade-evidence`     | 28,700 B | `be5494f817e2282272b42aab8218edb5` |
| `secret-scan-evidence` | 8,107 B  | `9040ccc5b90bd84d7a152958a334727f` |
| `container-evidence`   | 700 B    | `5fb43e0d0b4ccc1d7238ccf34260bcbf` |

**From the run's own artifacts:** 221 tests, 221 passed, 0 failed, 0 skipped,
0 cancelled, 0 todo across 24 suites; fresh == upgraded fingerprint
`2f2baa24…` with `equal=true`.

### Final head

This section is the only change after the code-gate run. A documentation-only
commit cannot alter code, migration or test evidence, and its own `ci.yml` run
is reported in the return packet alongside the final commit — so the final
head carries a green run of its own, at the same 221/221.

Runs `30823396770` and `30827939487` are **not** reused as R1 evidence.
