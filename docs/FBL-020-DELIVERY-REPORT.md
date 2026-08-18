# FBL-020 — Identity Boundary: Delivery Report (R5)

**Read §1 first.** It is the only place in this document that states what is true of this
tree, and everything else either supports it or is labelled HISTORICAL.

This report replaces the R4 report in full. R4 was **REJECTED** for two things: mandatory
runtime controls that were missing, and evidence claims the code did not support. §1–§8
describe what this tree is; §9 keeps the record of R2, R3 and R4 because a reviewer holding
an older document needs to be able to place it, and **nothing in §9 is a claim about this
tree**. §10 lists every claim this revision removed or narrowed.

---

## 0. What governs this delivery

### 0.1 The order

The active order is **FBL-020-R5**, and its text is **checked into this repository** at
[`docs/orders/FBL-020-R5.md`](orders/FBL-020-R5.md) — §3.2. Nothing in this delivery
depends on an order document a reviewer does not have.

**The repository holds the WHOLE order, verbatim** — Part 1 of that file is the disposition
and §0 through §5, and its Part 3 register marks all twenty-nine clauses as text held. The
map names that file's canonical-LF SHA-256,
`75aa7500f804d51019a6e950a91ab3ef5f30a1a37bb15c743c6d952a2e2bd783`, and
`scripts/check-requirement-map.ts` recomputes it, so a map built against a different
authority fails rather than passing quietly. Reproduce it with
`sed 's/\r$//' docs/orders/FBL-020-R5.md | sha256sum`.

**EVERY R5 CLAUSE IS UNVERIFIED UNTIL THE FINAL PACKAGE PROVES IT.** That is the order's
Appendix A, and it governs how every other statement in this report should be read: the
report records what the code and the tests do on this tree, and it closes nothing. "Seven of
nine blockers closed" is **withdrawn** as a governing status, here and everywhere else in this
repository; any surviving "closed" or "discharged" wording about an R5 clause is an
implementation note, not a claim about the gate.

An earlier revision of this paragraph said the opposite: that the text held was "the
standing preamble and §3" and that the wording of §0, §1, §2, §4 and §5 "was not supplied".
That was an artefact of the order having been routed to the implementation waves one section
at a time — the wave that checked the order in recorded the implementation prompt it had
been handed as the verbatim order — and it is **withdrawn**. It was not a harmless
mis-description: it was used in §3 of this report to explain why a worker correction had no
requirement-map row, while artifacts in this tree cited `FBL-020-R5 §4.8`, a section number
the order does not use — seven such citations survive, registered in
`docs/identity/KNOWN-LIMITATIONS.md`. `scripts/check-requirement-map.ts` holds the requirement
map's clause inventory to the order file's register in both directions, so the map can
neither invent a clause nor forget one the order declares.

### 0.2 The blueprint — and which one the reviewer is holding

The full record is [`docs/orders/BLUEPRINT-PROVENANCE.md`](orders/BLUEPRINT-PROVENANCE.md).
The three facts that matter here:

|                    | GOVERNING                                                                   | SUPERSEDED                                                                   |
| ------------------ | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| File               | `Car_Dealership_Management_and_Sales_Cloud_Master_Blueprint.docx`           | `Car_Dealership_SaaS_Architecture_Blueprint.docx`                            |
| Version line       | `Version 2.0  \|  August 4, 2026  \|  Governing management-first baseline`  | `Version 1.0  \|  July 30, 2026  \|  Architecture baseline`                  |
| Bytes / sha256     | 95,325 / `556d4e108c9db8b7dcfee284828f926157f7663d260d3d3e0d8774bb032feaaf` | 88,931 / `d38ad00ad2cd5a13ac087dbb96a34a4c133d0e5bfe8c81d9820a0b69f31e03f9`  |
| FBL-020 lives at   | §14.3 of Version 2.0 (`14.3 First active instruction — FBL-020-R2`)         | §14.5 of Version 1.0 (`14.5 Work Order FBL-020 — Identity and Organization`) |
| and §14.3 reads    | Version 2.0: FBL-020-R2                                                     | Version 1.0: **FBL-000** (`14.3 Work Order FBL-000 — Reproducible Baseline`) |
| In this repository | **No**                                                                      | **Yes** — `docs/orders/Car_Dealership_SaaS_Architecture_Blueprint.docx`      |

**The architect's project copies are both the Version 1.0 document.** That is why they read
§14.3 as FBL-000, and it is the reason a bare section number is not a citation: the same
"§14.3" names two different orders. Every citation in this repository now carries a version
label, the file name or the digest, and `tests/delivery-documentation.test.ts` fails on one
that does not.

**The Version 2.0 document is NOT in this repository and is not part of the project
record.** The operator is supplying it separately. Its facts above are labelled
`attested-not-in-repository` in `docs/FBL-020-R5-REQUIREMENT-MAP.json`, and they divide in
two: **its SHA-256 does resolve to a document in this repository** — the order text states
it, at Appendix A item 8 of `docs/orders/FBL-020-R5.md`, and `check-published-figures.ts`
reads it from there — while **its byte length, title lines, version line and §14 headings
appear nowhere in the order text or anywhere else here**
(_NOT GATE-CHECKED: attested, and not derivable in this repository_). Those rest on the
operator's own copy and are an attestation, not a measurement a reader of this repository
can reproduce. The Version 1.0 document IS checked in, and the documentation
battery reads its bytes — digest, byte length, title lines, version line and every §14
heading — so the recorded fact set cannot drift from the document. If the Version 2.0
document is later attached at its declared path, the same battery verifies it and fails if
it is the wrong file.

**One requirement a Version 1.0 reader cannot check at all**, stated so nobody is misled:
the quality ceilings `tsc-strict <=59`, `eslint <=136`, `format <=23`. That sentence occurs
once, in Version 2.0 §14.3; the word "ceiling" appears **nowhere** in the Version 1.0
document, which the battery asserts from its bytes. **A reviewer holding only Version 1.0
cannot verify those numbers from anything in this repository.** The checked-in order text
does not restate them — FBL-020-R5 sets no ceiling — so they rest on the Version 2.0
document alone, and they are recorded here as an attestation rather than as something a
reader of this project record can check. An earlier revision of this paragraph said the
numbers could be verified "from the checked-in order text"; that was false, and it is
withdrawn.

---

## 1. The state of this tree

**NOTHING IS COMMITTED AND NOTHING IS PUSHED.** The R5 work is a working tree on top of
`e08af42755fb1127d611249ba3175161b06e9682`; the cumulative acceptance base is `cac9b21`.

**NO CI RUN EXISTS FOR THIS TREE.** Every gate below was executed locally against a real
PostgreSQL 16 on `127.0.0.1:55434`, whose data directory is
`C:/Users/alegn/AppData/Local/Temp/fbl020r5-pg`. That is not a CI run and is not offered as
one.

**EVERY R5 CLAUSE IS UNVERIFIED UNTIL THE FINAL PACKAGE PROVES IT**, and **§3.1 is OPEN AND
EXTERNALLY BLOCKED**: both designated project copies are still the Version 1.0 blueprint.
Who must act, and exactly what they must verify on arrival, are in §8.4 and
`docs/orders/BLUEPRINT-PROVENANCE.md`.

| Question                           | This tree                                            |
| ---------------------------------- | ---------------------------------------------------- |
| Committed?                         | No — the order forbids it                            |
| CI run for this tree?              | No — nothing has been pushed, so no run can exist    |
| `npm run build`                    | 0 TypeScript errors                                  |
| Full suite                         | see §5 — zero failed, cancelled, skipped or todo     |
| `npm run architecture:check`       | green                                                |
| `scripts/quality-ratchet.ts check` | exit 0, no baseline raised                           |
| Migrations `000`, `049`–`056`      | canonical-LF byte-identical to `cac9b21` (§4.2)      |
| Live WorkOS certification          | **LIVE WORKOS CERTIFICATION IS NOT DISCHARGED** (§8) |
| The §0 census                      | **THE R5 §0 CENSUS IS REPORTED, NOT ACCEPTED** (§8)  |
| §3.1, the Version 2.0 blueprint    | **OPEN AND EXTERNALLY BLOCKED** (§8.4)               |

---

## 2. Delivery discipline

**ONE code-bearing commit**, plus an OPTIONAL **documentation-only closeout**. Any change to
a test, a script, a workflow, the requirement map or a source file belongs in the
code-bearing commit — a closeout that edits executable code is not documentation-only, and
R4's closeout did exactly that while being described as documentation-only.

**The evidence this report quotes is the FINAL HEAD's evidence.** R4's packet published
artifact digests belonging to an earlier commit (`2b75d8a`) rather than the tree that was
actually submitted. Nothing in this report may be filled in from a run that measured a
different tree: when a CI run for this tree exists, §1 and this section change together, the
run is identified by workflow path and by `head_sha` equal to the code-bearing commit, and
the per-job conclusions are read individually.

Two WIP commits exist on this branch from the R3 session (`cf9774b`, `bb79ef4`), made at the
repository owner's explicit instruction to preserve work across a session boundary. Both
carry a header saying they are not a delivery. They are disclosed here rather than hidden.

---

## 3. What R5 delivers, clause by clause

The machine-readable version is `docs/FBL-020-R5-REQUIREMENT-MAP.json`, checked by
`scripts/check-requirement-map.ts` and driven by `tests/ci-gates.test.ts`. Every requirement
names tests that must exist verbatim, code paths, CI steps and artifacts that must exist —
and, new in R5, **every clause in the inventory must be covered by a requirement**, every id
must be unique and well formed, and the inventory must agree with the checked-in order text.

| Clause | Requirement id                                   | What it establishes                                                                                                                                               | Where the proof is                                                                               |
| ------ | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| §0.1   | `R5-§0.1-census`                                 | The persistent-environment census, with the limits of every probe recorded                                                                                        | `tests/migration-census.test.ts`; `migration-census.json`                                        |
| §0.2   | `R5-§0.2-in-place-branch`                        | `057` is corrected in place and no `058` is added — the branch the census evidence supports                                                                       | `tests/migration-census.test.ts`, `tests/migration-ledger.test.ts`                               |
| §0.3   | `R5-§0.3-ledger-refuses`                         | An untrustworthy ledger row REFUSES the run instead of warning; four shapes, four `kind`s, no auto-repair                                                         | `tests/migration-ledger.test.ts`; `refusal-probes.json`                                          |
| §0.4   | `R5-§0.4-fixture-chain`                          | A non-canonical migrations directory is opt-in, allowlisted and digest-pinned, and weakens no refusal                                                             | `tests/migration-ledger.test.ts`                                                                 |
| §0.5   | `R5-§0.5-retained-fixture-pin`                   | The retained f76a27a fixture is COMPARED against committed digests, not re-recorded                                                                               | `tests/ci-gates.test.ts`; `fixture-checksums.json`                                               |
| §0.6   | `R5-§0.6-reconciliation-inventory`               | Every reconciliation in `057` is accounted for, and all THREE grantless-approval controls exist                                                                   | `tests/ci-gates.test.ts`; `reconciliation-inventory-057.json`                                    |
| §1.1   | `R5-§1.1-revocation-destroys-credential`         | Revocation destroys the provider refresh credential in the same statement that revokes                                                                            | `tests/identity-revocation.test.ts`                                                              |
| §1.2   | `R5-§1.2-logout-over-http`                       | The logout path proven over full HTTP on a session the real callback created                                                                                      | `tests/identity-revocation.test.ts`                                                              |
| §1.3   | `R5-§1.3-atomic-admission`                       | Admission and custody are ONE call; no route establishes a session of its own                                                                                     | `tests/login-admission.test.ts`, `tests/login-admission-concurrency.test.ts`                     |
| §1.4   | `R5-§1.4-admission-not-raceable`                 | Admission cannot be raced, proven deterministically, with a CONTROL leg that admits                                                                               | `tests/login-admission-concurrency.test.ts`                                                      |
| §1.5   | `R5-§1.5-callback-terminalization`               | Every callback with a valid sealed handle is claimed and terminalized: mismatch, replay, provider `error`, missing code, expiry mid-exchange                      | `tests/login-admission.test.ts`, `tests/identity-boundary.test.ts`, `tests/auth-surface.test.ts` |
| §1.6   | `R5-§1.6-worker-expiry-registration`             | All three sweeps registered, bounded, idempotent and concurrency-safe, driven through the compiled entry point on seeded expired rows                             | `tests/worker-jobs.test.ts`, `tests/worker-entrypoint.test.ts`                                   |
| §1.7   | `R5-§1.7-breach-revocation-atomic`               | Breach revocation and its audit are ONE transaction, measured under an injected audit failure                                                                     | `tests/identity-revocation.test.ts`, `tests/auth.test.ts`                                        |
| §1.8   | `R5-§1.8-refresh-boundary-verification`          | The unsafe rotation primitive is module-private and the exported refresh boundary REQUIRES verification                                                           | `tests/identity-boundary.test.ts`                                                                |
| §1.9   | `R5-§1.9-mfa-certification-tenant-effectiveness` | Certification requires an active AND effective tenant, under the engine's own interpolated predicate                                                              | `tests/identity-lifecycle-audit.test.ts`                                                         |
| §1.10  | `R5-§1.10-support-expiry-precedence`             | A lapsed window cannot be revoked in either ordering; the expiry owns the ending                                                                                  | `tests/worker-jobs.test.ts`                                                                      |
| §1.11  | `R5-§1.11-login-audit-attribution`               | `identity.login.succeeded` names the admitted tenant and user link                                                                                                | `tests/login-admission.test.ts`                                                                  |
| §2.1   | `R5-§2.1-policy-evidence-coherence`              | Version-2 evidence is relationally coherent — completeness, atomicity, the version floor AND the tuple, enforced by the database                                  | `tests/identity-evidence.test.ts`                                                                |
| §2.2   | `R5-§2.2-policy-evidence-rejections`             | Each rejection class refused BY POSTGRESQL: nonexistent ids, cross-tenant actors, broken tuples, bad authority, bad support evidence                              | `tests/identity-evidence.test.ts`                                                                |
| §2.3   | `R5-§2.3-array-evidence-normalization`           | The array is normalized into `policy_decision_matched_bindings` by trigger; two composite FKs and a version-reachability trigger enforce it                       | `tests/identity-evidence.test.ts`                                                                |
| §2.4   | `R5-§2.4-direct-sql-negatives`                   | Both adversary shapes — random nonexistent identifiers and cross-wired REAL rows — driven by direct SQL against `policy_decisions` itself                         | `tests/identity-evidence.test.ts`                                                                |
| §3.1   | `R5-§3.1-blueprint-provenance`                   | **OPEN AND EXTERNALLY BLOCKED.** Both blueprints stated by file, bytes, digest, title, version and §14 headings; the reviewer's copies are BOTH still Version 1.0 | `tests/delivery-documentation.test.ts`                                                           |
| §3.2   | `R5-§3.2-order-text-checked-in`                  | The whole order is in the repository, with a register marking all twenty-nine clauses as held                                                                     | `tests/delivery-documentation.test.ts`                                                           |
| §3.3   | `R5-§3.3-one-current-state`                      | One state for CI, for the commit and for the census; superseded run evidence labelled HISTORICAL                                                                  | `tests/delivery-documentation.test.ts`                                                           |
| §3.4   | `R5-§3.4-document-anchored-tests`                | The document tests read the supplied document's bytes instead of another file we wrote                                                                            | `tests/delivery-documentation.test.ts`, `scripts/docx-text.ts`                                   |
| §3.5   | `R5-§3.5-clause-inventory`                       | Clause inventory, unique well-formed ids, and a completeness check that FAILS on an omission                                                                      | `tests/ci-gates.test.ts` ; `requirement-map-check.txt`                                           |
| §3.6   | `R5-§3.6-document-reconciliation`                | The nine named documents exist, speak of this revision, and agree in one wording                                                                                  | `tests/delivery-documentation.test.ts`                                                           |
| §4     | `R5-§4-verification-gates`                       | Floors above all three of the order's figures, the six coverage kinds, a COMPLETE mutation run, and every standing gate                                           | `tests/ci-gates.test.ts`, `tests/architecture.test.ts`                                           |
| §5     | `R5-§5-commit-discipline`                        | The commit discipline above is recorded, and no commit or run is claimed for this tree                                                                            | `tests/delivery-documentation.test.ts`                                                           |

### What is still OPEN, and what this table used to say

**EVERY CLAUSE ABOVE IS UNVERIFIED UNTIL THE FINAL PACKAGE PROVES IT.** That is the order's
Appendix A, which also withdraws "seven of nine blockers closed" as a governing status. The
table states what each clause's code and tests do on this tree; it does not assert closure,
and no earlier claim of closure in this repository survives as a governing status.

**One clause is OPEN on its face, and it is open for a reason no work in this repository can
close:**

- **§3.1 — the project copies. OPEN AND EXTERNALLY BLOCKED.** The Version 2.0 blueprint
  (95,325 bytes, sha256 `556d4e10…`) **has not reached the reviewed project record**, and
  **both designated project copies are still the Version 1.0 file** (88,931 bytes, sha256
  `d38ad00a…`). The operator has supplied the Version 2.0 bytes to the reviewer **twice**,
  separately from this repository. **A repository cannot write into another party's record,
  and this one does not claim to.** Checking the R5 order text in discharges §3.2 and does
  **not** close §3.1.

  **Who must act, and what they must verify on arrival.** The **reviewer** must replace both
  designated project copies with the Version 2.0 file and confirm, on the copy that lands in
  the project record:

  | What to verify    | Expected                                                                   |
  | ----------------- | -------------------------------------------------------------------------- |
  | Title, line 1     | `Dealership Management & Sales Cloud`                                      |
  | Title, line 2     | `Master Architecture Blueprint and Forward-Only Roadmap`                   |
  | Version line      | `Version 2.0  \|  August 4, 2026  \|  Governing management-first baseline` |
  | Governing section | §14.3, reading `14.3 First active instruction — FBL-020-R2`                |
  | Byte size         | 95,325                                                                     |
  | sha256            | `556d4e108c9db8b7dcfee284828f926157f7663d260d3d3e0d8774bb032feaaf`         |

  Until then §3.1 stays open. **Nothing in this delivery softens that, and nothing here
  claims it closed.** If the file is also attached at
  `docs/orders/Car_Dealership_Management_and_Sales_Cloud_Master_Blueprint.docx`, the
  documentation battery verifies those same facts against its bytes and fails on the wrong
  file — but a green suite here would still say nothing about the reviewer's copies. The
  full statement is `docs/orders/BLUEPRINT-PROVENANCE.md`, "The status of §3.1".

**What this section used to say, and why it changed.** It recorded **§2.3** as a schema
change that was not made and **§2.1, §2.2 and §2.4** as PARTIAL. Those verdicts were written
before the §2 pass and were stale by the time this report was last edited: migration `057`
now creates `policy_decision_matched_bindings`, the trigger
`trg_policy_decisions_normalize_matches` derives its rows from the array inside the caller's
transaction, and `tests/identity-evidence.test.ts` drives each rejection class by direct SQL
against `policy_decisions` itself. The requirement map's own verdicts for those four rows
were already `PROVEN` while this table still read `PARTIAL`/`NOT DONE` — two of the nine
reconciled documents disagreeing about the same fact, which is exactly what §3.6 forbids.
The table above is the corrected one.

The four runtime clauses this section previously recorded as live defects — **§1.8**
(`rotateSessionRefresh` exported with no verifier at all, and `refreshProviderSession`
exported with an OPTIONAL one), **§1.9** (the certification authority gate never read the
`tenants` row that `packages/identity-access/src/policy.ts` denies `TENANT_INACTIVE` on),
**§1.10** (a support session revocable on `revoked_at IS NULL` alone, so a revocation landing
after the expiry instant but before the sweep relabelled the ending) and **§1.11**
(`succeedLoginTransaction` reading a tenant and user that `GET /auth/login` never wrote) — and
the three PARTIAL runtime rows §1.5, §1.6 and §1.7 each now carry a named test and a
registered mutation in `scripts/mutation-kill.ts`. The descriptions above are retained as the
statement of what was wrong, not of what is. None of this is a request to narrow R5, and none
of it is a claim that a clause is closed; it is the current state of the tree.

The retained FBL-020-R4 requirements — the identity tuple, policy evidence, reauthentication
authority, the audit inventory, support context and expiry, owned mutations, the populated
upgrade drill, the negative controls, fingerprint parity, the test-summary gate, the
mutation-kill runner and the documentation battery — are carried in the same map under
`R4-…` ids with `"revision": "FBL-020-R4"`, and their batteries still run:
`tests/architecture.test.ts`, `tests/audit-inventory-rules.test.ts`,
`tests/identity-core.test.ts`, `tests/identity-evidence.test.ts`,
`tests/identity-lifecycle-audit.test.ts`, `tests/owned-mutations.test.ts`,
`tests/support-context.test.ts` and `tests/support-expiry.test.ts`.

### §1.6 in detail: the worker ran one sweep of three

The R5 verification gate asks for the worker's registered job list, and for a seeded expired
row of each kind to be processed exactly once. That measurement found a defect, and this
delivery fixes it.

`expireStaleLoginTransactions` and `expireStaleReauthenticationTransactions` were written in
R4, are covered by the audit inventory, and were called by NOTHING that ships:
`apps/worker/src/main.ts` registered `identity.support_access.expiry` and nothing else. On a
deployed system a login transaction abandoned at the provider stayed `pending` and a step-up
nobody completed stayed `started`, with no `identity.login.expired` or
`identity.reauthentication.expired` row for either. Both functions' own comments call them
housekeeping "for the scheduled aggregator"; the aggregator scheduled neither. Every
existing test passed throughout, because each called the function directly — which is why
the gap survived four revisions. It is the shape FBL-020-R3 was rejected for: an
implemented flow nothing in production reaches.

What changed is REGISTRATION, not behaviour. The SQL, the transitions and the audit rows are
untouched and still live in `@dealer/identity-access`. The worker now holds ONE registry in
which a job's name and the pass that runs it are the same entry, so the list `--list-jobs`
advertises and the work `--once` performs cannot drift apart; `WORKER_JOBS` is derived from
that registry rather than restated beside it. Two documents were stale on this point
independently of the fix and are corrected: `README.md` said the worker had "no jobs until
FBL-040" (false since R4), and ADR-001 implied it was not yet deployed.

**This correction is §1.6, and it now has its row: `R5-§1.6-worker-expiry-registration`.** An
earlier revision of this paragraph said the correction had no clause to cite, on the premise
that the checked-in order text carried only a preamble and §3 and "no §4 register entry".
That premise was false in two ways and both are withdrawn here: the order carries §1.6
("Register login-transaction and reauthentication expiry processing in the deployed worker
alongside support expiry"), which is exactly this correction, and it carries §4 as well. The
premise was an artefact of the order having been routed to the implementation waves one
section at a time; `docs/orders/FBL-020-R5.md` now holds all of it, verbatim, and the map is
anchored to that file's canonical-LF digest. The batteries and mutations below are still the
proof — they are now cited from a map row rather than instead of one.

**`FBL-020-R5 §4.8` is still cited seven times, across five files, and it names nothing.**
The order's §4 has no numbered sub-clauses. The citations describe this correction correctly
and cite the wrong number; two of the seven are inside test NAMES that the requirement map
pins verbatim, so renaming them is a coordinated code-and-map change rather than a
documentation edit. The full register is in `docs/identity/KNOWN-LIMITATIONS.md` under
"Citations to a clause number the order does not define". Nothing in this repository asserts
that `§4.8` exists.

| What                                                                | Where                                                                                 |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| The registry, and the three sweeps it runs                          | `apps/worker/src/main.ts`                                                             |
| Each sweep transitions and audits a seeded expired row exactly once | `tests/worker-jobs.test.ts`                                                           |
| The COMPILED entry point advertises the same three names            | `tests/worker-entrypoint.test.ts`                                                     |
| CI greps all three names rather than the first                      | `.github/workflows/ci.yml`, "Worker job registry smoke test"                          |
| The three job names declared non-audit literals                     | `packages/identity-access/src/audit-inventory.ts`                                     |
| Removing any one registration kills a named test                    | mutations `worker_forgets_{login_transaction,reauthentication,support_access}_expiry` |

One property is stated but NOT tested: `runAllJobsOnce` catches each job separately, so a
throw in one sweep does not skip the rest. This revision ships no test that forces a sweep
to throw, so that is a reading of the code and is labelled as such where it is written.

### The documentation gate itself, and what §3 changed in it

R4's documentation battery compared the delivery report against a fact set held in the
requirement map. Both files are written by this implementation, so the check could only
prove that two of our own documents agreed — and they agreed on an ambiguous citation.
The anchor is now the document: `scripts/docx-text.ts` opens the checked-in Version 1.0
blueprint and the battery asserts its digest, byte length, title lines, version line and
every §14 heading against the record. The reader's limits are stated in that module's own
header: it reads the main document part only, and recognises a heading by its paragraph
style.

---

## 4. The migration chain

### 4.0 The §0.2 position, and the census that supports it

<!-- census-position:start -->

**EDIT_057_IN_PLACE.** `057` is corrected **in place** and there is no `058`.

That is the token `artifacts/migration-census.json` carries in `conclusion.position`, and
this is the sentence the artifact states in `conclusion.branch_sentence`, quoted verbatim:

> NO PERSISTENT ENVIRONMENT HAS APPLIED ANY FORM OF 057, on the evidence above. Every
> environment reachable from this machine was inspected and reported `no`, except the
> disposable and ephemeral ones listed separately. Under §0.2 that leaves migration 057
> editable in place and requires no 058.

`scripts/check-census-prose.ts` reads the artifact and refuses this report, and the
requirement map, if either asserts a position the artifact does not carry. It is run by
`tests/delivery-documentation.test.ts` and by the `census-prose` step of `ci.yml`. Nothing
in this section is a ratification: the artifact carries `"acceptance": "NOT_REVIEWED"`
(§8.2).

<!-- census-position:end -->

### 4.1 THE PREVIOUS CENSUS SAID THE OPPOSITE, AND IT WAS WRONG

This has to be recorded rather than quietly re-run, because the delivered R5 package
contained a **direct contradiction**: the census artifact concluded

> AT LEAST ONE PERSISTENT ENVIRONMENT HAS APPLIED A FORM OF 057. Under §0.2 that freezes
> 057 and sends every further schema correction to 058.

while this report and the requirement map both asserted the opposite branch, and `057` was
in fact edited in place with no `058` anywhere. Three documents, two incompatible positions,
and no gate that compared them.

**What the census got wrong.** `scripts/migration-census.ts` decided whether a cluster was
disposable with a single expression:

```ts
const underTemp = dir.toLowerCase().startsWith(tmpdir().toLowerCase());
otherClusterFinding(dir, markers, underTemp ? 'disposable' : 'persistent');
```

A wave of that same run created a scratch cluster at `C:/Users/alegn/pgdata-fbl020r5` —
under the user profile rather than under `%TEMP%`, because the cluster the drills normally
use was damaged (§5). Its path did not begin with the temporary directory, so the
expression above called this project's own throwaway cluster a **persistent environment**.
It carried `057`, and `conclusion.implementer_reading` therefore ordered `057` frozen — on
the strength of a string comparison against a directory name.

**A second defect in the same code, found while fixing the first, and not previously
reported.** The census located the local drill cluster by searching every data directory
for one whose `postmaster.opts` mentioned port 55434, taking the first in sorted order.
`postmaster.opts` is written at launch and left behind for ever, so the **stopped** cluster
`C:/Users/alegn/AppData/Local/Temp/fbl020r4-pg`, launched on that port during R4, matched
before the running one. Two things went wrong at once and both were silent: the live
cluster's findings were filed under the dead cluster's path, and the dead cluster was
**excluded from the sweep entirely** as already covered. It holds `057`. A census that
drops an environment carrying the migration is worse than no census.

**What was done.**

| Step | Action                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1    | The operator stopped and deleted `C:/Users/alegn/pgdata-fbl020r5`. It does not appear in the corrected artifact and cannot be re-inspected.                                                                                                                                                                                                                                                                                                                                                                                          |
| 2    | Disposability is now decided by **provenance and content**, in `assessDisposability` — service registration, the recorded launch, loopback reachability, this repository's own ledger markers in the cluster's heap, and the database inventory read from `global/1262` without connecting. The declared inputs are checked in at `architecture/disposable-cluster-policy.json`. It is FAIL-CLOSED: any input it cannot read yields `indeterminate`, and `summarize` counts an `indeterminate` cluster **with the persistent ones**. |
| 3    | The local cluster is now located by the `postmaster.pid` of a **running** postmaster, confirmed against the server's own `SHOW data_directory`. `fbl020r4-pg` is consequently censused, and is classified `disposable` on its own evidence — not machine-started, loopback only, this repository's ledger in its heap, and a recorded launch of `fsync=off`.                                                                                                                                                                         |
| 4    | One stray database, `tmpl0_probe`, was dropped from the drill cluster. It was 7,855 kB with one table, created by an ad-hoc probe in an earlier wave and by no checked-in code, so no declared pattern could attribute it. It is disclosed here rather than passed over. Nothing else was removed from any cluster.                                                                                                                                                                                                                  |
| 5    | `scripts/check-census-prose.ts` now compares the artifact's position against this report and the requirement map, so this class of contradiction cannot ship again.                                                                                                                                                                                                                                                                                                                                                                  |

**The corrected artifact, as it stands.** 142 environments; 3 persistent, 2 disposable, 1
ephemeral, **136 whose disposability could not be established and which are therefore
counted with the persistent ones**; 140 verdicts of `no`, 2 of `yes`, 0 `indeterminate`.
`persistent_environments_with_057` is empty. `persistent_environments_indeterminate` is
empty. The two clusters holding `057` are `.../Temp/fbl020r4-pg` and
`local-disposable-cluster-55434`, both classified `disposable` on the evidence above, and
both listed in `disposable_or_ephemeral_with_057`.

The 136 unclassifiable clusters are 135 embedded-PostgreSQL scratch directories another
project leaves under `%TEMP%`, plus `C:/Users/alegn/atlas-pg16-local`, which belongs to a
different project entirely. Every one of them fails the same condition, and the artifact
says so in each finding: _"this repository never wrote to this cluster, so it is not one
this project created for its own testing. It may well be somebody else's throwaway — but
this project cannot establish that, and an unestablished provenance is INDETERMINATE."_ The
path-prefix test called all 135 of the `%TEMP%` ones `disposable` on sight and
`atlas-pg16-local` `persistent` on sight, for the same reason in both cases: where the
directory sat. All 136 are now counted on the conservative side. Every one reports `no` on
a complete scan, which is why they do not block the branch — had any reported `yes` or
`indeterminate`, this section would read `FREEZE_057_AND_ADD_058` instead.

### 4.2 Checksums

All checksums in this repository are **canonical LF** values, because this working copy
checks out with `core.autocrlf=true` and a digest of the working bytes would differ between
a developer's machine and CI:

```bash
sed 's/\r$//' migrations/<file>.sql | sha256sum                  # canonical LF sha256
sed 's/\r$//' migrations/<file>.sql | git hash-object --stdin    # canonical blob OID
```

| Migration                                    | git blob OID (canonical)                   | sha256 (canonical, LF)                                             |
| -------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------ |
| `000_platform_core.sql`                      | `df137755674314f1557dbf5e77e03cad9ccb7a78` | `a3e0f4ca4990a313cabdefa8b26ca762977e95d2c8cfafbedf64f3ecb4fda94d` |
| `049_phase248_service_cockpit.sql`           | `6ead711b7362b5e49a20987e13af6c8f82695b78` | `523ee2e236b427e55fdd06037f350ac4729865581b5772d8078cf473e5984242` |
| `050_phase248_hardening.sql`                 | `52217a9c594176706a292b8d544a0affd7d9c3de` | `009d464da812459168b341b112dd4972edb39c406b0e5ebf33fb11798d35a522` |
| `051_phase248_metrics_support.sql`           | `99a8b733174ab74b6f0f6822354acf747437d7e9` | `e79d9a9fd56b76134ab6823fd8f7c83a653a4caecb5a1f243d46a5a8d36427d4` |
| `052_phase248_authorization_binding.sql`     | `a900bbf303be3883e541e2bc9aafeb3e63d40f49` | `94179a31e1f96185af52ecc37bc93bb9a3bd58f55a8ea46ec642300f68b04d41` |
| `053_phase248_estimate_line_association.sql` | `deec57d1e361e7de0964d6f0114e1464392ea11f` | `a2e125e122ec455ee19d1c18ffd6f08af5cd9fc46100de0ba424d5630e3b783a` |
| `054_phase248_waitlist.sql`                  | `0b5461c6c8c481f0f957a5f9d6df34eb1a2e47f5` | `8382d8efda1769de0828fd0de74cb8f8303e8f5aca1decf9b07e22dcf8baea58` |
| `055_identity_organization.sql`              | `e6a4b675fa354b89e93585e21c172360c2738946` | `52a56f414725adc5751c88bc256c9fe5f00bbeaf4b5ad909a3ecc13c86120a5d` |
| `056_identity_contract_completion.sql`       | `615e95991580a99f5e8109ab991093ecf0042010` | `ff2d0307d374efba41b4ff79268ace9b03b32376d5e60ae678d840936448713d` |

**`057_identity_boundary_completion.sql` is deliberately NOT pinned in this table.** It is
unaccepted and is still being **edited in place**, so any digest quoted for it goes stale the
next time a wave touches the file — which is exactly what happened: this row published
`8a2bf834…` / `41d8351c…` and described the file as **+1,315 / −35, 1,517 lines**, and the
`057` in this tree is none of those. `docs/identity/DATA-DICTIONARY.md` had already taken the
unpinned position for the same reason; the two documents now agree. Re-derive it, on the tree
in front of you, with the commands at the top of this section, and read the frozen chain
above for the values that are stable.

**Byte-identity of the frozen chain, measured on this tree.** The blob OIDs above for `000`
and `049`–`056` are character-for-character the OIDs `git ls-tree cac9b21 migrations/`
reports, and `git diff --name-only cac9b21 -- migrations/` names `057` and nothing else.
`057` has moved from `02c734b1dabd32b8aee980ae3ea35a029e08fe9f`; reproduce the current delta
with `git diff --numstat cac9b21 -- migrations/057_identity_boundary_completion.sql`.

**"Byte-identical" here means the TRACKED bytes, and on a Windows checkout that distinction
is load-bearing rather than pedantic.** `migrations/050_phase248_hardening.sql` is checked
out with CRLF line endings in this working tree, so a raw `sha256sum` of the file on disk
reads `ec3b02e2…` while the same file on an LF checkout reads `009d464d…`. Nothing about the
migration changed: the blob OID matches `cac9b21` exactly, `git diff` reports the file
unmodified, and the canonical-LF digest — `009d464d…`, the one the runner's ledger records
and compares — is identical to `cac9b21`'s. This is stated because a reviewer who checksums
the file on disk on Windows and on Linux gets two different numbers for an unchanged file,
and a report that said only "byte-identical" would look wrong to one of them. **The
authoritative comparison is the canonical-LF digest**, because that is the one
`scripts/migrate.ts` writes into the applied-migration ledger and refuses on; reproduce it
with `sed 's/\r$//' <file> | sha256sum`. All nine frozen migrations are canonical-LF
identical to `cac9b21` on this tree.

Digests published for `057` by earlier revisions — `af29b31f…` (R2), `a430d1f4…` (R3),
`8be8fd0f…` and `add07aaf…` (R4 passes), and `41d8351c…` earlier in R5 — are **superseded**
and describe bodies this tree no longer contains. The runner records a canonical-LF checksum
per applied migration, so an environment that applied an earlier `057` **refuses** the run
and names both digests rather than skipping the changed body. That refusal is not
hypothetical: it fired on the implementer's own disposable test database during this order,
and the database was recreated from the current chain.

---

## 5. Verification evidence — measured on this tree

Command, exactly as run:

```
TEST_DATABASE_URL="postgresql://postgres@127.0.0.1:55434/dealership_test" \
  npx tsx --test --test-concurrency=1 --test-reporter=tap tests/*.test.ts
```

| Gate                                       | Result                                                                                                                                                                               |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm run build`                            | **0 TypeScript errors**, exit 0                                                                                                                                                      |
| Full suite                                 | **573 tests, 59 suites**, 573 passed, 0 failed / cancelled / skipped / todo                                                                                                          |
| `scripts/parse-test-summary.ts`            | declared floors **573 / 59**, above every minimum below                                                                                                                              |
| `npm run architecture:check`               | green — dependency rules, app-SQL guard, module manifest, env confinement, role-binding effectiveness, owned mutations, audit inventory                                              |
| `scripts/quality-ratchet.ts check`         | **exit 0** — tsc-strict 53 / eslint 123 / format 1, **no baseline raised**                                                                                                           |
| `scripts/check-requirement-map.ts`         | OK — 44 requirements, 29 clauses, **278** mapped test names, every clause covered, 0 problems                                                                                        |
| `scripts/reconciliation-inventory.ts`      | **107** statements in `057`; **38** reconciliations = 11 control-covered + 24 declared not-load-bearing + **3** refusal guards; **0 unaccounted**; **12** negative controls declared |
| `scripts/mutation-kill.ts`                 | **44 declared / 44 killed / 0 survived** — a COMPLETE run of the whole registry at this head, every baseline green, the working tree intact after each                               |
| `scripts/check-published-figures.ts`       | every figure in this report and in the requirement map equals the artifact or constant it derives from (§5.4)                                                                        |
| Migrations `000`, `049`–`056` vs `cac9b21` | byte-identical (§4)                                                                                                                                                                  |

**NO FIGURE IN THIS TABLE IS TYPED BY HAND ANY MORE.** Every one of them is now read from
the run or the constant that produces it and compared against this document by
`scripts/check-published-figures.ts`, which fails the build when a published number and its
source disagree. §5.4 is the derivation table: figure, value, and the exact file the value
was read out of. That gate exists because retyping these numbers is the defect that sank
three revisions — the suite total shipped as 567 here and 554 in the requirement map, and
the mutation registry shipped as a complete 44-mutation run in the artifact and as an
incomplete 34-mutation run in the prose beside it.

**THE MUTATION REGISTRY HAS BEEN RUN COMPLETE, AND THE EARLIER STATEMENT THAT IT HAD NOT IS
WITHDRAWN.** This paragraph used to read "THE MUTATION FIGURE IS THE ONE THAT IS NOT FULLY
MEASURED", and said that the most recent complete run covered 34 of the registry's 44
mutations with ten never exercised in a batch. That was false when it was written:
`artifacts/mutation-kill.json` — the artifact this report cited in the same breath — recorded
a complete run of the whole registry, and a fresh complete run at this head records the same
thing. The runner registers every mutation, applies each to an ISOLATED COPY of the tree,
requires the mutation's own battery to be GREEN before the mutation is applied, and requires
the named test to die after it; it also asserts the working tree is intact afterwards.
**44 declared / 44 killed / 0 survived, 0 baselines red, 0 trees left dirty.** A report that
understates a mandatory §4 gate is as much an evidence defect as one that overstates it, and
the gate in §5.4 now reads the artifact so that neither direction can ship again.

**THE CLUSTER THESE FIGURES WERE MEASURED ON, AND WHAT BECAME OF THE ONE BEFORE IT.** The
R4 cluster `C:/Users/alegn/AppData/Local/Temp/fbl020r4-pg` was damaged by Windows
temp-cleanup, which deleted 50 relation files from each of `template0`, `template1` and
`postgres` — every one a relation that is EMPTY in a fresh database, and so a zero-byte
file on disk. (Verified by listing the system-catalog relfilenodes of a healthy database in
the same cluster and diffing against each damaged directory.) `CREATE DATABASE` fails there
with `could not open file "base/1/4171"`, which cancelled the eight tests in
`tests/migration-ledger.test.ts` that create a scratch database — a **local environment
fault, not a repository defect**, and not one CI can inherit, because the CI job starts a
fresh digest-pinned PostgreSQL container.

A wave of this revision therefore built a replacement with `initdb` at
`C:/Users/alegn/pgdata-fbl020r5` — **outside `%TEMP%`**, and that single fact is what the
census then misread as a persistent environment (§4.1). The operator has since stopped and
deleted it. The measurements in the table above were taken on
`C:/Users/alegn/AppData/Local/Temp/fbl020r5-pg`, a clean cluster under `%TEMP%` migrated
from this chain, with **0 cancelled**. `fbl020r4-pg` still exists, stopped, and appears in
the corrected census as `disposable` on its own evidence.

**The ratchet ceilings are a document, not a gate**, and this report will not imply
otherwise: `scripts/quality-ratchet.ts` contains no ceiling concept at all
(`grep -c ceiling` → 0). It refuses growth against `quality-baselines.json` and nothing
more, so "no ceiling was raised" is a statement about a document. The ceilings themselves —
59 / 136 / 23 — are readable **only in the Version 2.0 blueprint**
(_NOT GATE-CHECKED: readable only in the Version 2.0 blueprint_). An earlier version of
this sentence added "and in the checked-in order text"; that was **false and is withdrawn**,
and it contradicted §0.2 of this same report, which had already recorded the withdrawal:
`grep -i ceiling docs/orders/FBL-020-R5.md` returns nothing, because FBL-020-R5 sets no
ceiling and restates none. `docs/adr/ADR-005-technology-selections.md` restates them and says
which document defines them. **A reviewer holding only the Version 1.0 blueprint cannot
verify these three numbers from anything in this project record.**

**The test floors move with the delivery, and only upward.** `scripts/parse-test-summary.ts`
declares `MINIMUM_TESTS` and `MINIMUM_SUITES`; `tests/ci-gates.test.ts` refuses a suite floor
above the `describe(` declarations that exist and a test floor below the `test(`
declarations that exist.

**THREE FLOOR FIGURES ARE IN PLAY, THEY ARE NOT THE SAME NUMBER, AND THIS REPORT NAMES THE
ONE IT USES RATHER THAN CHOOSING SILENTLY.** They are:

| Where it is written             | The figure                                                                                        | What kind of statement it is                                                            |
| ------------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| FBL-020-R5 §4                   | <!--fig:order_text_floor_tests-->459<!--/fig--> / <!--fig:order_text_floor_suites-->47<!--/fig--> | the order's FLOOR clause — "the existing 459-test/47-suite floor may not shrink"        |
| FBL-020-R5 Appendix A item 9    | <!--fig:order_appendix_tests-->525<!--/fig--> / <!--fig:order_appendix_suites-->57<!--/fig-->     | a quality condition on a count the implementer had already reported, not a second floor |
| `scripts/parse-test-summary.ts` | <!--fig:floor_tests-->573<!--/fig--> / <!--fig:floor_suites-->59<!--/fig-->                       | the DECLARED floor, pinned to what this revision actually measured                      |

**This tree measures above all three, so there is no practical conflict to resolve** — the
declared floor clears §4's 459 / 47 and Appendix A's 525 / 57, and any of the three readings
is satisfied. What did need resolving is which number the constant NAMED "the order's own
floor" should carry. It carried 315 / 29 — FBL-020-R4 §7's figures — and earlier revisions
recorded that as a standing finding in the map's `R5-§4-verification-gates` verdict rather
than correcting it. **It is corrected here**: `ORDER_MINIMUM_TESTS = 459` and
`ORDER_MINIMUM_SUITES = 47`, R5 §4's own numbers, because §4 is the clause that fixes a floor;
Appendix A item 9's 525 / 57 describes a count that had been reported and is superseded by
the measurement above. The finding is closed rather than re-recorded, and
`scripts/check-published-figures.ts` now reads both constants out of the source, so a
document restating either at the wrong value fails the build.

**What is NOT pinned by any gate — a much shorter list than it used to be.** Every figure in
§5 is now read from its source and compared with this document (§5.4). Three remain
underivable and each is labelled where it appears: the Version 2.0 blueprint's byte length,
the three quality ceilings, and the changed-path counts of §5.3.

### 5.1 Every control this revision made mandatory, and the proof it fails without it

A check that has never been shown to fail is not known to be a check. Each control below was
removed and the named test observed to die, then restored and observed to pass. The first
seven are registered mutations in `scripts/mutation-kill.ts` and are recorded in
`mutation-kill.json`; the remaining eight cannot be expressed as a source mutation — they are
properties of documents and of a file's presence — so they were performed by hand and are
reproducible from the description.

**This is a SELECTION, not the registry.** `scripts/mutation-kill.ts` has 44 mutations
declared; the seven named here are the ones this section discusses. The registry's own count
and run status are in the gate table above: it was run COMPLETE at this head — 44 declared /
44 killed / 0 survived — and this section names a readable subset rather than reprinting the
run.

| Control removed                                                                                | Test that died                                                                                                                                                      | How                                                                                                                             |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| The clause-coverage failure in `scripts/check-requirement-map.ts`                              | _an OMITTED requirement fails the clause-coverage check_                                                                                                            | mutation `requirement_map_ignores_uncovered_clause`                                                                             |
| The duplicate-id report                                                                        | _a duplicate id, a malformed id and an undeclared clause are each REPORTED_                                                                                         | mutation `requirement_map_tolerates_duplicate_ids`                                                                              |
| The inventory↔order-text comparison                                                            | _the inventory cannot invent a clause the order text does not declare_                                                                                              | mutation `inventory_not_anchored_to_the_order_text`                                                                             |
| The recorded blueprint digest (one character)                                                  | _the SUPPLIED blueprint in this repository is the document the record describes_                                                                                    | mutation `blueprint_digest_recorded_wrong`                                                                                      |
| The login-transaction sweep's registration in the worker                                       | _the worker pass ages a stale LOGIN transaction, exactly once_                                                                                                      | mutation `worker_forgets_login_transaction_expiry`                                                                              |
| The step-up sweep's registration in the worker                                                 | _the worker pass ages a stale STEP-UP, exactly once_                                                                                                                | mutation `worker_forgets_reauthentication_expiry`                                                                               |
| The support sweep's registration in the worker                                                 | _the worker pass closes an expired SUPPORT window, exactly once_                                                                                                    | mutation `worker_forgets_support_access_expiry`                                                                                 |
| — (a WRONG file attached at the governing document's declared path)                            | _the GOVERNING blueprint is recorded as ABSENT, and is verified the moment it is attached_                                                                          | by hand: the Version 1.0 file copied to the Version 2.0 path; restored                                                          |
| — (the report claiming a discharged CI gate as well as no run)                                 | _the report declares ONE state for CI, for the commit, and for the census_                                                                                          | by hand: the discharge sentence appended; restored                                                                              |
| — (a bare `§14.3`, naming neither Version 1.0 nor Version 2.0, added to `MODULE-OWNERSHIP.md`) | _every blueprint citation in the delivery documents names its version, file or digest_                                                                              | by hand: line appended; restored                                                                                                |
| — (ADR-001 left describing FBL-020-R4)                                                         | _the nine documents §3.6 names exist and all speak of this revision_                                                                                                | by hand: the revision string rolled back; restored                                                                              |
| — (one of the order's verbatim phrases removed from the checked-in order text)                 | _the R5 order text is checked in, and the report and the map point at it_                                                                                           | by hand: `Stop at the gate.` rewritten to `Continue past the gate.` in `docs/orders/FBL-020-R5.md`; restored from a byte copy   |
| — (a clause dropped from this report)                                                          | _the report accounts for every clause the requirement map declares_                                                                                                 | by hand: `§1.2` renamed throughout; restored                                                                                    |
| — (one PUBLISHED FIGURE in this report edited to a value its source does not carry)            | _every published figure agrees with the artifact or constant that produces it_                                                                                      | by hand: the mutation row's three figures decremented by one; restored — the run is transcribed in §5.4                         |
| — (the `suite_tests` span moved one digit off the run that produced it)                        | _every published figure agrees with the artifact or constant that produces it_ AND _two documents cannot publish one figure at two values, artifact or no artifact_ | by hand: the `suite_tests` span retyped from 572 to 571; BOTH named tests died; restored byte-identically — transcribed in §5.4 |
| — (the "NOT GATE-CHECKED" label removed from an underivable figure)                            | _a published figure that disagrees with its source is REPORTED, in both directions_                                                                                 | in-test: `figureProblems` is driven with each label stripped, and each removal must be named                                    |

Each restoration returned `tests/delivery-documentation.test.ts` to **26 / 26** green.

**One row of this table used to describe a mutation that cannot be performed**, and it is
replaced above rather than left standing. It read "the ceilings rule deleted from the
checked-in order text … the sentence weakened; restored" — but the checked-in order text
contains no ceilings rule and never did (`grep -i ceiling docs/orders/FBL-020-R5.md` returns
nothing), so no such sentence could be weakened and the row cited an experiment nobody could
have run. The replacement was actually performed while writing this revision: the order
file's `Stop at the gate.` was rewritten, the battery went to ONE failure —
_the R5 order text is checked in, and the report and the map point at it_ — the file was
restored from a byte-for-byte copy, its canonical-LF SHA-256 was re-verified as
`75aa7500f804d51019a6e950a91ab3ef5f30a1a37bb15c743c6d952a2e2bd783`, and the battery returned
to green. **Counts of this battery's own size are not restated in prose any more**; the one
figure above is published once and read from the file by `scripts/check-published-figures.ts`
(`doc_battery_tests`), because "18 / 18" survived in this paragraph while the file declared
twenty tests — the same defect as every other stale figure, in the document that exists to
catch them.

### 5.2 The five findings from the completed-R5 gate

Five findings were raised against the completed R5 package. They are labelled **G1–G5** by
the gate that raised them; the `G1`–`G5` in the §9 HISTORICAL defect ledger are a different,
older set and are not these.

| #      | Severity | Finding                                                                                                                                                                                                                                                                                                  | Where it is answered                                                                                                                                                                                                                                                                                                                     |
| ------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **G1** | Critical | The census artifact said FREEZE 057 while the map and the report said the opposite, and 057 was edited in place with no 058. Root cause: `scripts/migration-census.ts` decided disposability by PATH PREFIX, so this project's own scratch cluster outside `%TEMP%` was called a persistent environment. | §4.0 (the corrected position, in the artifact's own words), §4.1 (what the census got wrong, the second defect found beside it, and what was done), §8.2. Code: `assessDisposability`, `runningDataDirectoryForPort`, `architecture/disposable-cluster-policy.json`. Tests: five in `tests/migration-census.test.ts`.                    |
| **G2** | High     | `scripts/parse-test-summary.ts` reported OK on a run that printed `not ok 38 - migration ledger…` while the counters read `fail 0`.                                                                                                                                                                      | `logGateFailures` reads the log's own `ok`/`not ok` lines and fails on any of them before consulting a counter; `counterContradictions` reports a counter that disagrees. Tests: three in `tests/ci-gates.test.ts`. Probes below.                                                                                                        |
| **G3** | High     | The `after` hook of `tests/migration-ledger.test.ts` failed intermittently, taking the full suite and `scripts/mutation-kill.ts` with it.                                                                                                                                                                | The hook withdraws `ALLOW_CONNECTIONS` before terminating, waits on the server's own report of zero attached backends, removes the `%TEMP%` directory with Node's documented Windows retry and asserts it is gone, does the database first, and collects every failure instead of reporting only the first. Five consecutive runs below. |
| **G4** | Medium   | §5.3 published a changed-path figure its own command did not reproduce.                                                                                                                                                                                                                                  | §5.3, rewritten: three commands, each with its literal output, and the sentence derived from them.                                                                                                                                                                                                                                       |
| **G5** | Medium   | Nothing compared the census artifact's verdict with the prose interpreting it, and CI could not reproduce the discrepancy.                                                                                                                                                                               | `scripts/check-census-prose.ts`, run by `tests/delivery-documentation.test.ts` and by the `Census position vs delivery prose` step of `ci.yml`. Both revert directions are proved in that test.                                                                                                                                          |

**G2 — the parser probes.** Four synthetic TAP logs, each fed to
`scripts/parse-test-summary.ts` at this tree's declared floors. The probes are generated at
whatever the floors are when they are run — the previous version of this table hard-coded
566 / 567 `ok` lines beside a floor figure that had since moved, which is the same defect
§5.4 exists to stop, so the table below records the SHAPE of each probe and the exit it
produced rather than a line count that goes stale on the next raise:

| Log                 | What it holds                                                                                                                                | Exit                                                                                                                                                                                      |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `probe-notok.tap`   | one fewer `ok` line than the floor, one `not ok 38 - migration ledger integrity (FBL-020-R4 §0)`, counters claiming a full pass and `fail 0` | **1** — "the log contains 1 FAILING assertion line(s), so the run failed whatever the counters say", and separately "the summary claims failed=0 but the log contains 1 'not ok' line(s)" |
| `probe-nested.tap`  | a full set of `ok` lines and one INDENTED `    not ok 1`, same zero counters                                                                 | **1** — the indentation does not hide it                                                                                                                                                  |
| `probe-phantom.tap` | a full set of `ok` lines, no `not ok`, counters claiming `fail 3`                                                                            | **1** — "a failure nobody printed is a summary nobody can check"                                                                                                                          |
| `probe-clean.tap`   | a full set of `ok` lines and counters that agree with them                                                                                   | **0** — "Test summary gate OK."                                                                                                                                                           |

The same parser on the real 573-test log of §5 prints
`observed_ok=632 observed_not_ok=0` and exits **0**. Note that the log contains the string
`not ok` inside two test NAMES; the observation regex is anchored to `^\s*not ok\s+[0-9]+`,
so it does not mistake a name for a result. Both observation counts are read from
`artifacts/test-summary.json` by the figure gate, so this sentence cannot drift from the run
it describes.

**G3 — five consecutive runs of the affected file**, `tests/migration-ledger.test.ts`, taken
back to back on the cluster of §5 while the full census was running against the same host:

| Run | Exit | tests | suites | pass | fail | cancelled | skipped | todo | `not ok` lines |
| --- | ---- | ----- | ------ | ---- | ---- | --------- | ------- | ---- | -------------- |
| 1   | 0    | 19    | 3      | 19   | 0    | 0         | 0       | 0    | 0              |
| 2   | 0    | 19    | 3      | 19   | 0    | 0         | 0       | 0    | 0              |
| 3   | 0    | 19    | 3      | 19   | 0    | 0         | 0       | 0    | 0              |
| 4   | 0    | 19    | 3      | 19   | 0    | 0         | 0       | 0    | 0              |
| 5   | 0    | 19    | 3      | 19   | 0    | 0         | 0       | 0    | 0              |

Identical in every column. **What this does not prove:** the failure was intermittent under
load, so five green runs are evidence of determinism and not a proof of it. The mechanisms
named above are closed by construction — no new backend can attach once connections are
withdrawn, and the drop is issued only after the server reports none attached — and the
remaining assurance is a green exact-SHA CI run, which §4 requires and which does not exist
while nothing is committed.

**G5 — the revert proof.** `scripts/check-census-prose.ts` exits 0 as shipped. Flip the
report's position token and it exits 1 naming both halves of the disagreement; flip the
`census_position` of a requirement-map row and it exits 1 naming that row; remove the
`census-position` block and it exits 1; paraphrase the quoted sentence instead of quoting it
and it exits 1. All four are driven by
_the delivery documents assert the census position the ARTIFACT carries, and no other_ in
`tests/delivery-documentation.test.ts`.

### 5.3 The changed-path summary

Against the cumulative acceptance base `cac9b21`, measured on this tree. **The commands are
printed with their literal output**, because the previous version of this paragraph published
`164 tracked files changed, +40,796 / −2,413` and `16 untracked paths` beside a command pair
that reproduced neither number — the diffstat had moved since it was written, and
`git status --porcelain --untracked-files=all` prints paths, not a count, so nothing in the
report could be checked against anything. That was completed-gate finding G4.

```bash
git diff --shortstat cac9b21 -- . ':(exclude)docs/FBL-020-DELIVERY-REPORT.md'
```

```
164 files changed, 42085 insertions(+), 2434 deletions(-)
```

```bash
git status --porcelain --untracked-files=all | grep -c '^??'
```

```
19
```

```bash
git status --porcelain --untracked-files=all | grep -vc '^??'
```

```
45
```

The two measurements answer different questions and are not summed. The first is the whole
delta from the cumulative acceptance base `cac9b21` to this working tree — **164 files changed, 42085 insertions(+), 2434 deletions(-)** —
excluding this report, which the pathspec removes so that editing the report cannot move the
figure. The second and third describe only what is UNCOMMITTED against `HEAD` (`e08af42`):
**19** untracked paths git does not yet know and **45** tracked paths it does, **64**
working-tree paths in total.

**These last two figures are pre-commit measurements and are 0 by construction afterwards.**
They describe an UNCOMMITTED tree, so the code-bearing commit sets both to zero; they are
recorded here because the order asks what this tree is before it is committed, not because
they survive it. The first figure — the cumulative delta from `cac9b21` — is unaffected by
committing, because committing moves no content. That asymmetry is why only the first is
gate-bound: `scripts/check-published-figures.ts` recomputes it, while the two working-tree
counts are labelled NOT GATE-CHECKED and were re-measured by hand for this revision after
the completed gate found the previous values stale — the second recurrence of that finding.

R4's report carried a per-file diffstat table of 163 rows; it is **removed rather than
carried forward**, because it was the single largest source of stale figures in this
document — a table that goes stale on every edit, that no gate checks, and whose rows were
found wrong twice by reviewers recomputing them. The three commands above reproduce
everything it held, on demand, from the tree in front of the reader.

**These five numbers are the ones §5.4's gate cannot bind**
(_NOT GATE-CHECKED: reproduce with the commands printed above_). They are git measurements
over a history the gate is not given, and they move with every edit to the working tree —
including the edit that publishes them. That is why each is printed under the command that
produces it instead of being asserted in a sentence.

### 5.4 Every figure in this report, and the artifact it derives from

**This section is the structural answer to the defect that sank three revisions.** Four
figures shipped at two values each, because the prose was hand-written while the runs that
produce those numbers were still moving. Correcting the four instances would have left the
class alive, so the figures now DERIVE: `scripts/check-published-figures.ts` holds a registry
naming, for each figure, the artifact or checked-in constant that produces it; it reads that
source; and it fails the build when any governed document states anything else. Five are
governed: this report, the requirement map, the provenance record, KNOWN-LIMITATIONS and the
README.
`scripts/check-census-prose.ts` already did exactly this for the census position — this is
that pattern generalised.

**Three mechanisms, because two were not enough.** Each value in the table below is published
in a marked span — an HTML comment naming the figure id, the value, then a closing comment,
all invisible in rendered Markdown — that the gate compares with its source and `--write`
regenerates. But the four figures that actually
shipped wrong were all published in PROSE, outside any marker — so the gate ALSO carries
restatement rules: sentence shapes these documents really use, every match of which, in any
governed document, must carry the authoritative value. A stale figure written into a
brand-new sentence still fails.

**THE THIRD MECHANISM EXISTS BECAUSE THE FIRST TWO HAD A HOLE THE SHAPE OF THE DEFECT THEY
WERE BUILT FOR, AND IT WAS FOUND BY THIS WAVE INSIDE ITS OWN GATE.** `artifacts/` is
gitignored, so on any tree where the battery has not just been run the five suite figures
read as `unreadable` — and both mechanisms above SKIP a figure whose source they cannot
read. While that was true, this gate printed _Every published figure agrees with its source_
over a report that published three figures at two values each:

| Figure         | §5 gate table said | §5.4 derivation table said | The run that arbitrated said |
| -------------- | ------------------ | -------------------------- | ---------------------------- |
| `suite_tests`  | 572                | 599                        | 572                          |
| `suite_passed` | 572                | 599                        | 572                          |
| `observed_ok`  | 631                | 655                        | 631                          |

**The fourth column is the run that settled the disagreement, and it is NOT the current
total** — the current total is in the derivation table below, published from
`artifacts/test-summary.json` and nowhere retyped. The battery measured 572 when this
contradiction was found; it measures more now, because closing this finding meant ADDING the
named test that proves the third mechanism, and that test counts. **That one-run lag is the
whole phenomenon this section exists to defeat**: every figure here moves when a run moves,
which is precisely why none of them may be typed by hand. The lag is not hidden by choosing
a convenient number — it is removed by making the number unwritable except from its source.

So agreement WITH the source and agreement AMONG the publications are now separate
requirements, and the second needs no artifact: whatever the true value later turns out to
be, two documents cannot be stating two different ones now. When the source IS readable the
first two mechanisms have already compared every occurrence against it — strictly stronger —
so the third only speaks when it has something new to say. It is driven by
_two documents cannot publish one figure at two values, artifact or no artifact_, which
stages the contradiction with every artifact-sourced value deleted and also asserts the limb
stays silent when the source can arbitrate. The three stale values above were corrected from
the run recorded in `artifacts/test-summary.json`; the corrections are listed in §10.

| Figure                       | Value                                                                                                     | Read from                                                                           |
| ---------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `suite_tests`                | <!--fig:suite_tests-->573<!--/fig-->                                                                      | `artifacts/test-summary.json` `tests`                                               |
| `suite_suites`               | <!--fig:suite_suites-->59<!--/fig-->                                                                      | `artifacts/test-summary.json` `suites`                                              |
| `suite_passed`               | <!--fig:suite_passed-->573<!--/fig-->                                                                     | `artifacts/test-summary.json` `passed`                                              |
| `observed_ok`                | <!--fig:observed_ok-->632<!--/fig-->                                                                      | `artifacts/test-summary.json` `observed_ok_lines`                                   |
| `observed_not_ok`            | <!--fig:observed_not_ok-->0<!--/fig-->                                                                    | `artifacts/test-summary.json` `observed_not_ok_lines`                               |
| `floor_tests`                | <!--fig:floor_tests-->573<!--/fig-->                                                                      | `scripts/parse-test-summary.ts` `MINIMUM_TESTS`                                     |
| `floor_suites`               | <!--fig:floor_suites-->59<!--/fig-->                                                                      | `scripts/parse-test-summary.ts` `MINIMUM_SUITES`                                    |
| `order_floor_tests`          | <!--fig:order_floor_tests-->459<!--/fig-->                                                                | `scripts/parse-test-summary.ts` `ORDER_MINIMUM_TESTS`                               |
| `order_floor_suites`         | <!--fig:order_floor_suites-->47<!--/fig-->                                                                | `scripts/parse-test-summary.ts` `ORDER_MINIMUM_SUITES`                              |
| `order_text_floor_tests`     | <!--fig:order_text_floor_tests-->459<!--/fig-->                                                           | `docs/orders/FBL-020-R5.md` §4, the floor clause itself                             |
| `order_text_floor_suites`    | <!--fig:order_text_floor_suites-->47<!--/fig-->                                                           | `docs/orders/FBL-020-R5.md` §4, the floor clause itself                             |
| `order_appendix_tests`       | <!--fig:order_appendix_tests-->525<!--/fig-->                                                             | `docs/orders/FBL-020-R5.md` Appendix A item 9                                       |
| `order_appendix_suites`      | <!--fig:order_appendix_suites-->57<!--/fig-->                                                             | `docs/orders/FBL-020-R5.md` Appendix A item 9                                       |
| `order_clauses`              | <!--fig:order_clauses-->29<!--/fig-->                                                                     | `docs/orders/FBL-020-R5.md`, clause headings in the Part 3 register                 |
| `order_sha256`               | <!--fig:order_sha256-->75aa7500f804d51019a6e950a91ab3ef5f30a1a37bb15c743c6d952a2e2bd783<!--/fig-->        | canonical-LF SHA-256 of `docs/orders/FBL-020-R5.md`                                 |
| `mutations_declared`         | <!--fig:mutations_declared-->44<!--/fig-->                                                                | `artifacts/mutation-kill.json` `mutations_total`                                    |
| `mutations_killed`           | <!--fig:mutations_killed-->44<!--/fig-->                                                                  | `artifacts/mutation-kill.json` `mutations_killed`                                   |
| `mutations_survived`         | <!--fig:mutations_survived-->0<!--/fig-->                                                                 | `artifacts/mutation-kill.json` `mutations_survived`                                 |
| `mutations_registered`       | <!--fig:mutations_registered-->44<!--/fig-->                                                              | `scripts/mutation-kill.ts`, `id:` declarations in the registry                      |
| `map_requirements`           | <!--fig:map_requirements-->44<!--/fig-->                                                                  | the requirement map's own `requirements` array                                      |
| `map_clauses`                | <!--fig:map_clauses-->29<!--/fig-->                                                                       | the requirement map's own `clause_inventory`                                        |
| `map_tests`                  | <!--fig:map_tests-->278<!--/fig-->                                                                        | the requirement map's test citations, counted as `check-requirement-map.ts` counts  |
| `map_residue`                | <!--fig:map_residue-->3<!--/fig-->                                                                        | `bareCitationFiles()` over the tree, not the map's declaration of it                |
| `inventory_statements`       | <!--fig:inventory_statements-->107<!--/fig-->                                                             | `artifacts/reconciliation-inventory-057.json` `totals`                              |
| `inventory_reconciliations`  | <!--fig:inventory_reconciliations-->38<!--/fig-->                                                         | `artifacts/reconciliation-inventory-057.json` `totals`                              |
| `inventory_controlled`       | <!--fig:inventory_controlled-->11<!--/fig-->                                                              | `artifacts/reconciliation-inventory-057.json` `totals`                              |
| `inventory_not_load_bearing` | <!--fig:inventory_not_load_bearing-->24<!--/fig-->                                                        | `artifacts/reconciliation-inventory-057.json` `totals`                              |
| `inventory_refusal_guards`   | <!--fig:inventory_refusal_guards-->3<!--/fig-->                                                           | `artifacts/reconciliation-inventory-057.json` `totals`                              |
| `inventory_unaccounted`      | <!--fig:inventory_unaccounted-->0<!--/fig-->                                                              | `artifacts/reconciliation-inventory-057.json` `totals`                              |
| `negative_controls`          | <!--fig:negative_controls-->12<!--/fig-->                                                                 | `architecture/negative-control-anchors-057.json`, one key per control               |
| `ratchet_tsc`                | <!--fig:ratchet_tsc-->53<!--/fig-->                                                                       | `quality-baselines.json` `tsc-strict.total`                                         |
| `ratchet_eslint`             | <!--fig:ratchet_eslint-->123<!--/fig-->                                                                   | `quality-baselines.json` `eslint.total`                                             |
| `ratchet_format`             | <!--fig:ratchet_format-->1<!--/fig-->                                                                     | `quality-baselines.json` `format.total`                                             |
| `doc_battery_tests`          | <!--fig:doc_battery_tests-->26<!--/fig-->                                                                 | `tests/delivery-documentation.test.ts`, `test(` declarations                        |
| `blueprint_v1_bytes`         | <!--fig:blueprint_v1_bytes-->88,931<!--/fig-->                                                            | the Version 1.0 `.docx` checked in here, its own byte length                        |
| `blueprint_v1_sha256`        | <!--fig:blueprint_v1_sha256-->d38ad00ad2cd5a13ac087dbb96a34a4c133d0e5bfe8c81d9820a0b69f31e03f9<!--/fig--> | the Version 1.0 `.docx` checked in here, its own digest                             |
| `blueprint_v2_sha256`        | <!--fig:blueprint_v2_sha256-->556d4e108c9db8b7dcfee284828f926157f7663d260d3d3e0d8774bb032feaaf<!--/fig--> | `docs/orders/FBL-020-R5.md` Appendix A item 8 — the order text's own claimed digest |

**Three figures this repository publishes have NO source a gate can read**, and each is
labelled where it appears rather than left to look derived:

| Figure                                                                                                        | Why no gate can check it                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the Version 2.0 blueprint's 95,325 bytes (_NOT GATE-CHECKED: attested, and not derivable in this repository_) | the file is not in this repository, and the order text states that document's SHA-256 but never its size. The size is the operator's attestation from a copy this project record does not contain |
| the quality ceilings 59 / 136 / 23                                                                            | that sentence occurs once, in Version 2.0 §14.3. FBL-020-R5 sets no ceiling and restates none, and no script in this tree has a ceiling concept                                                   |
| the changed-path totals of §5.3                                                                               | git measurements over a history the gate is not given, which move with every edit to the tree. Each is printed under the command that reproduces it                                               |

**The gate is proved by breaking it.** With the tree green, the mutation row's three figures
in §5 were decremented by one and the battery was re-run. It went red on exactly one named
test, _every published figure agrees with the artifact or constant that produces it_,
reporting<!--fig:quoted-->

```
docs/FBL-020-DELIVERY-REPORT.md: "43 declared / 43 killed / 0 survived" states
  mutations_declared as "43", but its source reads "44" (restatement rule mutations-run)
```

<!--/fig-->and on the two companion figures in the same match. The row was restored and the

battery returned to green. The reverse direction — the SOURCE moving while the prose stands still,
which is the R5 situation exactly — is driven inside
_a published figure that disagrees with its source is REPORTED, in both directions_, along
with a span carrying a wrong value, a span naming no registered figure, and each
"NOT GATE-CHECKED" label stripped in turn.

**The THIRD mechanism was proved by breaking it separately**, because it answers a different
question and a proof of one is not a proof of the other. With the tree green, the
`suite_tests` span was moved one digit — at that point it held `572`, and it was retyped to
`571`: one figure, one character — and the gate exited non-zero with

```
docs/FBL-020-DELIVERY-REPORT.md: [fig:suite_tests span] publishes "571",
  but suite_tests reads "572" from its source
```

(the marker is written `[fig:suite_tests span]` here instead of verbatim: the gate scans raw
bytes and does not respect code fences, so quoting a real span opener inside this report
would OPEN one, and the rest of the document would be read as its contents. That is not a
hypothetical — it happened twice while this paragraph was being written, and the gate caught
it both times.) TWO named tests went red, not one:
_every published figure agrees with the artifact or constant that produces it_ (the source
comparison) and _two documents cannot publish one figure at two values, artifact or no
artifact_ (the mutual-consistency limb, which sees the span disagreeing with the §5 gate
table's prose without consulting any artifact at all). The report was then restored from a
byte copy taken before the edit and `diff` confirmed the restoration byte-identical, the
gate returned exit 0, and the battery returned to **26 / 26**. **No digest of this file is
quoted here on purpose**: a checksum of the delivery report, published inside the delivery
report, is stale the instant the next sentence is written — which is the very class §5.4
exists to close.

**The two escape hatches are declared and counted.** Restatement scanning skips §9, whose
figures belong to R3's and R4's trees on purpose, and skips the inline `quoted` markers that
carry a superseded value in §10's "claim as it stood" column. Both are counted by the gate
and pinned by _the exemptions the gate allows are declared, bounded and named_, which
requires exactly one historical region, requires it to open at the §9 heading, and caps the
inline quotations. An escape hatch nobody counts is a hole.

---

## 6. Migration 057 on a POPULATED pre-057 database

The drill is a CI gate, not a prose exercise: the fixture, the verifier, the negative-control
runner and the workflow steps are all committed, and the `migration-upgrade` job fails if any
of them refuses. It applies the earliest retained schema, seeds legacy Fixed Ops data, stages
the pre-057 chain, migrates through `056`, asserts the organization backfill invented no
identities, seeds **nonempty** legacy identity data, runs the reconciliation negative controls
on isolated copies, applies `057`, and verifies the reconciled state and the before/after
counts. Its evidence is `fixture-checksums.json`, `pre-057-chain.txt`, `upgrade-backfill.json`,
`identity-pre-057.json`, `identity-post-057.json`, `negative-controls.json`,
`constraint-state.txt` and `fingerprint-equality.txt`.

**What the fixture contains.** Two tenants: **A** with exactly one ACTIVE connection, so its
activated link is unambiguous; **B** with only a DISABLED connection, so its activated link is
ambiguous. Census asserted exactly at `phase=pre-057`: 3 connections, 4 user links, 3 identity
sessions, 4 role bindings, 2 policy decisions, 3 reauthentication transactions, 1 grant, 2
support requests, 1 support session.

**Eighteen exact-state assertions** run at `phase=post-057` — the `RECONCILED_STATE` list in
`scripts/verify-upgrade-state.ts`, each named by id in `identity-post-057.json` — and a
count-only check would pass where they fail: the two revocation branches both revoke a session and only the recorded
REASON says which statement acted. Nothing is deleted — before/after counts are compared table
by table and must be equal and nonzero.

**The controls prove the reconciliation is load-bearing — there are TWELVE of them.** R4
shipped ten; R5 §0.6 added two more.

**§0.6 NAMES THREE GRANTLESS-APPROVAL CONTROLS AND THIS TREE CARRIES THREE, one per
statement of that reconciliation.** The clause asks for "independent negative controls for
the grantless-approval session revocation, supersession audit insertion, and request
supersession", and the grantless-approval reconciliation in `057` is exactly three
statements. R4 had a control for one of them; a single control cannot show the other two
load-bearing, because deleting either leaves the migration succeeding.

| §0.6 asks for                | The control                                    | What its deletion changes                                                                                        | Added in |
| ---------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------- |
| session revocation           | `sas_grantless_approval_session_revoked`       | the live support SESSION of a grantless approval survives the upgrade, and only an exact-state assertion sees it | R5 §0.6  |
| supersession audit insertion | `aud_grantless_approval_supersession_recorded` | the supersession happens with no audit row explaining it                                                         | R5 §0.6  |
| request supersession         | `sar_approval_without_grant_superseded`        | the REQUEST stays approved with no grant behind it                                                               | R4       |

All three are declared in `architecture/negative-control-anchors-057.json`, each anchored to
exactly one statement in `057` — `tests/ci-gates.test.ts` fails if an anchor stops resolving
to exactly one — and each is executed against a real copy of the populated pre-057 database
by `scripts/upgrade-negative-controls.ts`. **The reconciliation inventory of §0.6's first
limb is complete on the same evidence: 0 unaccounted.**
`scripts/reconciliation-inventory.ts` prints the same figure as `negative_controls_declared`,
so the count is derived rather than asserted. `scripts/upgrade-negative-controls.ts`
copies the pre-057 database, deletes ONE reconciliation from `057`, runs the real migration
runner and then the real verifier, and each control DECLARES where it must fail and what the
failure must mention. Two deserve naming because a weaker gate would miss them:
`is_unprovable_provenance_revoked` does not break the migration at all — the second revocation
catches the same row with a DIFFERENT reason, so only an exact-state assertion sees it — and
`ul_deterministic_binding` breaks nothing: every member of staff in a correctly configured
tenant silently loses access on upgrade, with no error anywhere.

**Reconciliations that CANNOT be shown load-bearing by this fixture are enumerated, not
omitted**, in `negative-controls.json` under `not_load_bearing_on_a_pre_057_fixture`: each
operates on a column `057` itself creates, so it matches zero rows on any pre-057 database.
The authority on coverage is `scripts/reconciliation-inventory.ts`, which parses `057` with a
scanner that respects dollar-quoting, string literals and comments, computes control coverage
from each control's anchors rather than accepting a declaration, and fails on an unaccounted
reconciliation or a declaration that matches no statement.

---

## 7. Residual risk — accepted, with reasons

Risks a reviewer may weigh and accept. Work that has **not been done** is §8, and the two are
not the same thing: R3 filed an undischarged gate here and was rejected for it. The full
register with reproduction detail is `docs/identity/KNOWN-LIMITATIONS.md`.

1. **The role-binding drift guard can be walked around deliberately.** Five enumerated
   spellings remain outside its static evaluator — a `CASE` arm that computes the predicate
   and discards it, array assembly by `unshift`/`splice`/index assignment, and
   `Object.keys(FRAGMENTS).join('')`. All five are declared in the guard's own "WHAT IT
   CANNOT SEE" and in KNOWN-LIMITATIONS. It is a **build-time drift guard, not a runtime
   control**; every runtime predicate it protects is independently pinned by mutation-killed
   tests.

2. **`withTransaction` ABANDONS its body when the connection is lost; it does not cancel
   it.** It can reject while `fn` is still running, and a Promise cannot be cancelled, so the
   body's continuation keeps executing after the caller was told the operation failed.
   Database work cannot leak — the client is destroyed on release — but non-database side
   effects still complete. The rule this puts on callers is written on `withTransaction`
   itself and in KNOWN-LIMITATIONS.

3. **A lost-connection log line does not always carry a SQLSTATE.** One broken connection can
   be visible twice and the first observation is reported; under a concurrent burst that is
   sometimes the bare socket reset, which carries none. Those requests are still typed, still
   503, still retryable — the missing field is diagnostic only. `DatabaseConnectionLostError.pgCode`
   is documented as best-effort; the **class** is the contract to branch on.

4. **A due refresh costs one request a provider round trip, and a JWKS outage longer than the
   key cache costs sessions, not just logins.** A refresh whose replacement token cannot be
   verified revokes the session, because the exchange has already spent the presented refresh
   token. Keys are cached ten minutes; in that state every bearer request and every login is
   already failing closed. The preferred mitigation is to move the exchange off the request
   path — **not** to accept an unverified replacement token.

5. **Migration-057 ordering is proven by the CI upgrade job, not by an in-suite test.**
   `npm test` alone cannot fail if a future edit reorders `057`, because a mutated migration
   cannot change a database that has already been migrated. `tests/ci-gates.test.ts` is what
   stops the controls from silently ceasing to bite: it asserts every negative-control anchor
   still resolves to exactly one statement in `057`.

6. **No HTTP administration surface exists.** The `identity.*` and `org.unit.*` actions and
   the engine that decides them ship, but no route declares them. Administration is the owned
   mutation services or the audited bootstrap command.

7. **Durable audit delivery is not claimed** (audit rows are transactional; the outbox is
   FBL-040). **Row-level security is FBL-030.** **SAML/SCIM are interfaces only**, unenableable
   by database CHECK. **`step_up_token_uses` (migration 050) is dead weight** — no longer
   written or read; dropping it is a future migration.

8. **FIVE disclosed gaps are open. Four are guard scaffolding carried from R4; the fifth is
   missing test coverage found by this revision's document-reconciliation pass.** The four
   carried ones: three declared residue shapes of the audit-inventory gate that are described
   accurately but have no fixture; one audit-inventory rule (the variant-overflow branch) with
   no test; the same untested-rule shape in the sibling owned-mutation gate; and a
   shared-resolver header that lists `.reduce` and template tags as "resolved" where the code
   treats them as opaque and fail-loud. **The fifth is new**: the login failure reason
   `session_establishment_failed` is written by `apps/api/src/routes/auth.ts` and asserted by
   no test, and a comment in `tests/login-admission.test.ts` had justified that gap by citing
   a test which covers REAUTHENTICATION transactions and does not list that reason at all.
   The comment is corrected; the gap is not, because closing it is a test addition this
   documentation revision does not make. All five are itemised in
   `docs/identity/KNOWN-LIMITATIONS.md`. None is a mandatory gate, and none is a runtime
   authorization hole reachable by an unauthorized caller.

9. **THREE source files still cite a blueprint section without naming the document.**
   `packages/identity-access/src/audit-inventory.ts`,
   `packages/identity-access/src/login-transaction.ts` and `tests/identity-boundary.test.ts`
   carry a bare `§14.3` that names neither Version 1.0 nor Version 2.0. They belong to clauses
   this wave does not own. All three are DECLARED in the requirement map under
   `bare_blueprint_citation_residue`, disclosed in KNOWN-LIMITATIONS, and
   `scripts/check-requirement-map.ts` fails in both directions if an undeclared one appears or
   a declared one stops citing a section; the checker prints `citation_residue=3`.
   `migrations/057_identity_boundary_completion.sql` cites the same section but **names the
   Version 2.0 document**, so it is unambiguous and is not part of the residue. This item was
   headed "Four source files still cite a blueprint section without naming the document" and
   then listed three that do and one that does not — the heading counted the unambiguous file
   as a defect, and it is corrected to three.

---

## 8. Gates NOT DISCHARGED

Not risks. Not residual. **Work that is not done.**

1. **LIVE WORKOS CERTIFICATION IS NOT DISCHARGED.** No live WorkOS credentials exist in this
   environment. Every provider property is proven against a deterministic local RSA issuer and
   a provider-neutral fake. The adapter itself IS invoked in process — `tests/identity-config.test.ts`
   constructs it with `createWorkosProvider(...)` and calls `provider.refreshSession(...)` over
   a MOCKED transport, asserting that the exchange is bounded, aborts its socket and surfaces
   silence as `transient`. What is untested is real AuthKit redirect parameters, real token
   claim shapes, real `max_age=0` semantics, real organization membership, the actual
   MFA-required organization policy, and whether WorkOS's own endpoints return the shapes the
   adapter maps. There is no way to discharge this from here: it needs credentials and an
   operator. The substitution point is `useIdentityProviderForTests`.

   R3's report and KNOWN-LIMITATIONS both said "no test invokes" the adapter. That was
   **wrong**, and the correction is the paragraph above.

2. **THE R5 §0 CENSUS IS REPORTED, NOT ACCEPTED.** `scripts/migration-census.ts` inspected
   142 environments reachable from the implementer's machine. `conclusion.position` is
   `EDIT_057_IN_PLACE`: `persistent_environments_with_057` is empty,
   `persistent_environments_indeterminate` is empty, and the two clusters that do hold
   `057` are this project's own drill clusters, listed under
   `disposable_or_ephemeral_with_057`. 136 clusters whose disposability could not be
   established are counted WITH the persistent ones and all report `no`. On that basis the
   implementer takes the branch that leaves `057` editable. **Nobody has reviewed that
   finding.** The artifact says so in its own body (`"acceptance": "NOT_REVIEWED"`), each
   probe's limits are recorded beside its verdict, and if a reviewer reads the evidence
   differently the correct consequence is an `058` and a frozen `057`. Nothing in this
   delivery presumes the outcome. **The PREVIOUS census concluded the opposite and was
   wrong**; what it got wrong, why, and what was done about it are recorded in §4.1 rather
   than quietly re-run away.

3. **THE R5 CI RUN IS NOT DISCHARGED**, because nothing has been committed or pushed (§1).
   Every gate in §5 was executed locally. A CI run is a different thing and is not claimed.

4. **§3.1 IS OPEN AND EXTERNALLY BLOCKED — THE VERSION 2.0 BLUEPRINT HAS NOT REACHED THE
   REVIEWED PROJECT RECORD.** This section previously listed three gates and omitted this
   one, which left the report's own canonical "what is not done" list understating an open
   clause that the §3 clause table and `docs/orders/BLUEPRINT-PROVENANCE.md` both already
   recorded as OPEN. It is listed here so the three places agree.

   **The facts, not softened.** Both designated project copies remain the Version 1.0 file —
   <!--fig:blueprint_v1_bytes-->88,931<!--/fig--> bytes, sha256
   <!--fig:blueprint_v1_sha256-->d38ad00ad2cd5a13ac087dbb96a34a4c133d0e5bfe8c81d9820a0b69f31e03f9<!--/fig-->.

   The governing Version 2.0 file — 95,325 bytes
   (_NOT GATE-CHECKED: attested, and not derivable in this repository_), sha256
   <!--fig:blueprint_v2_sha256-->556d4e108c9db8b7dcfee284828f926157f7663d260d3d3e0d8774bb032feaaf<!--/fig-->

   — has not. The operator has supplied those bytes to the reviewer **twice**.

   **This is not open because work was left undone here.** Every claim that the document is
   "in hand and verified" has been withdrawn throughout this repository, and
   `tests/delivery-documentation.test.ts` fails if any delivery document reintroduces the
   wording. The act that closes §3.1 happens in a record this repository cannot reach or
   observe, and **this repository does not claim otherwise**.

   **WHO MUST ACT: the reviewer**, by replacing BOTH designated project copies with the
   Version 2.0 file. **WHAT THEY MUST VERIFY ON ARRIVAL:** title line 1
   `Dealership Management & Sales Cloud`; title line 2
   `Master Architecture Blueprint and Forward-Only Roadmap`; version line
   `Version 2.0  |  August 4, 2026  |  Governing management-first baseline`; governing
   section §14.3, reading `14.3 First active instruction — FBL-020-R2`; byte size 95,325;
   and the sha256 above. The full comparison of the two documents, including why a bare
   `§14.3` names different orders in each, is in `docs/orders/BLUEPRINT-PROVENANCE.md`.

**So four gates remain undischarged: live WorkOS certification, acceptance of the §0 census,
a CI run for R5, and §3.1's supply of the Version 2.0 blueprint into the project record.**
Three of the four cannot be discharged from inside this repository at all.

---

<!--fig:historical:start-->

## 9. HISTORICAL RECORD — R2, R3 and R4

**Nothing in this section describes this tree.** It is retained because the architect accepted
the R3 and R4 runs and artifacts as genuine, and because a reader holding an older report
needs to be able to place its numbers. Every figure here belongs to the commit named beside
it.

### 9.1 The R3 defect ledger, compressed

Seventeen defects were found across five adversarial waves, plus the closeout clusters I2,
K and L. The rows below merge the ones that were a single mistake in several places
(E1/E2, E3/H1, I2/K1–K3), so the table has fewer rows than the ledger had entries; the full
narrative is in the R3 and R4 reports, which this document supersedes. Severity is the
review's own scale.

| ID           | Sev      | What it was                                                                                                                                                                         | The rule it bought                                                                                                           |
| ------------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **A1**       | Critical | The support-authority gate matched any `tenant_admin` of the tenant and never read `scope_level`, so a ROOFTOP-scoped admin held tenant-wide authority over platform support access | ONE authority path: `mayActTenantWide` applies the policy engine's own effectiveness SQL and scope predicate                 |
| **A2**       | High     | One reauthentication grant could authorize more than one support approval                                                                                                           | A unique index, installed after its own reconciliation                                                                       |
| **A3**       | Critical | The platform-support predicate omitted the BINDING's effective window                                                                                                               | The predicate interpolates the engine's own `EFFECTIVE_ROLE_BINDING_SQL`                                                     |
| **B1**       | Critical | The insecure-HTTP override permitted non-`Secure` cookies on any host at `NODE_ENV=development`                                                                                     | Dropping `Secure` requires development/test **and** every identity URL on loopback                                           |
| **B2**       | High     | Assurance was computed from the actor's freshest session, not the presented credential                                                                                              | Assurance is computed about the PRESENTED session id                                                                         |
| **B3**       | High     | A `platform.*` role name could be granted at a tenant scope                                                                                                                         | Platform roles are derived from the published catalog; the misgrant is refused at the write                                  |
| **C1**       | High     | `refreshProviderSession` existed and nothing called it: custody of a provider credential with no spender                                                                            | The refresh is driven from request authentication through one shared provider port                                           |
| **C2**       | High     | Login observation audited the refused branches and not the activated one                                                                                                            | The successful login is audited too, with no email and no display name                                                       |
| **D1**       | Critical | The first reachable refresh held a pooled connection inside an open transaction across the provider HTTP call                                                                       | The exchange happens outside any transaction, under a short-lived lease; every connection is born with server-side bounds    |
| **E1/E2**    | Critical | `getSessionView` and `rolesForUserLink` restated the effectiveness rule, so an aged-out binding kept supervisor reach in the Fixed Ops cockpit                                      | Both interpolate the shared predicate                                                                                        |
| **E3/H1**    | High     | No build-time guard against the drift class existed; the first guard was text-shape heuristics with holes in both directions                                                        | A static evaluator over the module's own constants, with a declared opt-out and an adversarial fixture corpus                |
| **F1**       | Critical | Platform authority was checked at FILING only, so a revoked platform actor's pending request could still become live access                                                         | Authority must be current at approval and at session start                                                                   |
| **F2**       | Medium   | An `approver_assurance` column presented an approval bar nothing read                                                                                                               | The column was deleted rather than wired up                                                                                  |
| **G1**       | Critical | The idle-in-transaction FATAL arrived on an EventEmitter with no listener and terminated the API                                                                                    | `withTransaction` owns the client's `'error'` listener for exactly the checkout                                              |
| **I1**       | High     | A lost connection was classified from which racer won, not from the error                                                                                                           | Classification is made from the error itself                                                                                 |
| **I2/K1–K3** | —        | A changed caller contract documented nowhere; an errno allowlist that reclassified ordinary errors; a fake SQLSTATE                                                                 | Contracts written down; classification rests on self-identifying shapes; a code is accepted only under a real SQLSTATE class |

R4 then closed its own review findings: the audit inventory was completed and given the
assertion its header claimed (F1); the gate was defeated by string concatenation and an
interpolated template head, so the static string resolver was EXTRACTED into
`scripts/static-string-resolver.ts` and both gates import the one implementation (F1a); six
sites asserting an absolute the gate does not enforce were re-scoped to what the resolver can
read (F1b); about ten rules that could be deleted with no test dying were given
`tests/audit-inventory-rules.test.ts`, one test per rule (F2); the indistinguishability test
that sampled six of fifteen refusals was made exhaustive (F3); `057`'s header was corrected to
describe its actual content (F4); and a redundant `EXISTS` presented as load-bearing was
removed with the subsumption stated (F5).

### 9.2 HISTORICAL CI evidence — R3, at commit `f816642`

Measured on R3. `057` has changed since, the workflow has changed, and the suite has grown.

| Field               | Value                                                                                              |
| ------------------- | -------------------------------------------------------------------------------------------------- |
| Code-bearing commit | `f816642a92c8d8d1c3c86ad7670b24ef43c67b62`                                                         |
| CI run id           | R3: run `31223131820`, `event=push`, `head_sha` equal to that commit                               |
| Jobs                | four, all `success`                                                                                |
| `test-summary.json` | 315 tests / 29 suites, 0 failed / cancelled / skipped / todo                                       |
| Fingerprints        | fresh == upgraded == `dcfffc97630b664feccacee70b0a1aebb28e50d69d00c7fdc741c6c0aa0bc15a`, 41 tables |
| Secret scan         | gitleaks `v8.24.3`, digest-pinned image, `--log-opts=--all`: 51 commits, no leaks                  |

Artifact zips, sha256 of the downloaded zip: `baseline-evidence` 57,804 B
`1acdcff5b31a4a2cde1b499c5f9cb35c1431bdaba48935868c1646e3f43291e6`; `upgrade-evidence`
32,005 B `8e023ad2b3dd33222ca87eac5e9771d4117f6e4b0034bd095078851583adcd9c`;
`secret-scan-evidence` 8,109 B `19d2b3c168fd2ab92ed9194cc963ab29bc0a002c46aaca866e843f01b58b3cf9`;
`container-evidence` 701 B `1914f166f8258400df4e3b2f5058048316d4b0aa62299ed86afcafb43f77ca5c`.

### 9.3 HISTORICAL CI evidence — R4, at commit `2b75d8a`

Measured on R4's code-bearing commit, **not** on R4's final closeout tree — which is one of
the things R4 was rejected for, and the reason §2 of this report states the final-head rule.

| Field               | Value                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------- |
| Code-bearing commit | `2b75d8abbbf68f3e95c4542540ad90ade7da844f`                                                  |
| Workflow            | `.github/workflows/ci.yml`                                                                  |
| CI run id           | R4: run `32028562952`, `event=push`, `head_sha` equal to that commit, 4 jobs, 0 non-success |
| `test-summary.json` | 459 tests / 47 suites, 0 failed / cancelled / skipped / todo, floors 459 / 47               |
| Fingerprints        | fresh == upgraded == `271c892662937a33c2972b83a30c4f02f441a5d058ac076e07d4248dd5d29d9f`     |

Artifact zips, sha256 of the downloaded zip: `baseline-evidence` 73,422 B
`537665d3a26e6a58808bf2c3f4189fbb37bd0facae9f8febe8deb937e71e0521`; `upgrade-evidence`
42,931 B `315ce719f29908aed59e53afdd33042c4c653490c3b1a7d91a5b33ffb65fdf56`;
`secret-scan-evidence` 8,109 B `b2134e70db8f2abaad67056fbdfd932fc322f4612b44fb6c5084eb798b1be1eb`;
`container-evidence` 701 B `41b0ebae7a0279888e03b8f417158ee7a5bda2df900a4f9e74438cf03aa82b9c`.

A near-miss worth keeping, because this order is about evidence discipline: the first poller
queried `/actions/runs?head_sha=…` and took `runs[0]`, which returned a **Dependabot** run —
one job, zero artifacts, `conclusion: success`. Reporting that as the CI gate would have been
a false green. The lesson is in §2: identify the run by workflow path and read per-job
conclusions.

<!--fig:historical:end-->

---

## 10. Claims this revision removed or narrowed

| Claim as it stood                                                                                             | What it is now                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| The governing document's status was recorded as verified-and-in-hand                                          | Recorded as `attested-not-in-repository`, with the Version 1.0 document checked in as the only verifiable anchor (§0.2)                      |
| The census finding was attributed to the architect                                                            | The census is the implementer's report and says so in its own body (§8.2)                                                                    |
| The R4 CI gate declared discharged in the opening paragraph and no run said to exist in §0.7                  | One state: nothing is committed, so no run exists (§1)                                                                                       |
| A struck-through "NOT DISCHARGED" entry re-labelled discharged in the same list                               | Deleted. Historical CI evidence lives in §9 under headings that say HISTORICAL                                                               |
| The R4 artifact digests presented as the delivery's evidence                                                  | Labelled as R4's, at `2b75d8a`, in §9.3, with the final-head rule stated in §2                                                               |
| `057` published at `add07aaf…` in one section and `41d8351c…` in another                                      | Not pinned at all. `057` is edited in place and unaccepted, so §4 prints the command instead of a digest                                     |
| `057` described as +1,278 / −33 in one section and +1,304 / −35 in another, then as +1,315 / −35, 1,517 lines | Withdrawn for the same reason: the current delta is reproduced by the command in §4, not quoted                                              |
| A 163-row per-file diffstat table                                                                             | Removed; the three commands that reproduce it, and the totals they print, are **§5.3** — this row cited §5.1, then §5.2, and both were wrong |
| "Every §0–§7 obligation of the R4 order is discharged and CI-proven"                                          | Not restated. This report claims only what §5 measured on this tree and what §8 leaves open                                                  |
| Suite figures of 315 / 29, 425 / 41, 430 / 42 and 459 / 47 in a section headed "measured on this tree"        | One measured figure (§5); the R3 and R4 in-CI figures are in §9                                                                              |
| "no test invokes" the WorkOS adapter                                                                          | Wrong, and corrected in §8.1 with the battery named                                                                                          |

**Claims this DOCUMENT-RECONCILIATION pass removed or narrowed (order §3.3/§3.6, Appendix A
item 7).** Each was verified against the tree before being changed.

| Claim as it stood                                                                                                                                                                   | What it is now                                                                                                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §2.1/§2.2/§2.4 recorded PARTIAL and §2.3 "NOT DONE — no foreign key is possible" in §3                                                                                              | Corrected: `057` creates `policy_decision_matched_bindings` with two composite FKs and a version-reachability trigger. The map already read PROVEN; the two documents now agree                         |
| KNOWN-LIMITATIONS: "ten controls"                                                                                                                                                   | **Twelve**, derived from the runner's own array and printed by the inventory script                                                                                                                     |
| KNOWN-LIMITATIONS: "eight statements in `057` cannot be shown load-bearing"                                                                                                         | **Twenty-four**, the inventory's `reconciliations_declared_not_load_bearing`                                                                                                                            |
| KNOWN-LIMITATIONS pointing at report §7 (Prettier), §10 (changed paths) and §2 (R2-head paths)                                                                                      | All three withdrawn: those sections hold other content now, and the report carries no Prettier scan and no R2-head count at all                                                                         |
| KNOWN-LIMITATIONS citing §10's per-file diffstat row                                                                                                                                | Withdrawn — that table was deleted by this revision                                                                                                                                                     |
| KNOWN-LIMITATIONS: "four residue classes … two … the other three"                                                                                                                   | Arithmetic corrected: four classes, two fixtured, one exercised by a rule test, one containing the three unfixtured shapes                                                                              |
| KNOWN-LIMITATIONS: the refresh-lease mutation "leaves the suite green at 60/60"                                                                                                     | The count is withdrawn; the claim is that no test goes red                                                                                                                                              |
| BLUEPRINT-PROVENANCE: the ceilings "can be verified from the checked-in R5 order text"                                                                                              | **False and withdrawn.** `grep -i ceiling docs/orders/FBL-020-R5.md` returns nothing. §5 of this report carried the same false sentence and it is withdrawn there too                                   |
| §5's mutation row: "34 mutations, 34 killed" without qualification                                                                                                                  | Superseded twice. It became "44 registered; the last complete run covered <!--fig:quoted-->34<!--/fig-->; the ten added since have not been run as a batch", which was itself FALSE — see the row below |
| §5.1's row "the ceilings rule deleted from the checked-in order text"                                                                                                               | Replaced by a mutation that was actually performed and restored — see §5.1                                                                                                                              |
| §7 item 9: "Four source files still cite a blueprint section without naming the document"                                                                                           | **Three.** The fourth names the Version 2.0 document and is not residue                                                                                                                                 |
| §7 item 8: "Four guard-scaffolding gaps"                                                                                                                                            | **Five** disclosed gaps: four carried from R4, one found by this pass (`session_establishment_failed` has no test)                                                                                      |
| `tests/login-admission.test.ts`: three failure reasons justified by a named test                                                                                                    | The named test covers reauthentication, not login, and omits one of the three; the comment now states what is actually covered                                                                          |
| AUTH-FLOWS: a six-reason failure vocabulary, and "Two flows changed under FBL-020-R5"                                                                                               | The vocabulary is nine, tabulated; the list of changed flows is the whole R5 change set                                                                                                                 |
| DATA-DICTIONARY: "057 creates one table", heading "FBL-020-R2/R3", `git diff 1b1a1bc..HEAD` "is empty"                                                                              | Two tables; heading spans R2 through R5; the frozen-chain check is scoped to the files it claims                                                                                                        |
| The threat model filing live-provider behaviour under "Accepted residual risks"                                                                                                     | Moved to its own NOT DISCHARGED section, in the wording the other four documents use                                                                                                                    |
| README: `JWT_SECRET`/`STEP_UP_SECRET` in Quick start and Docker, `src/shared/security/step-up.ts`, `services/metrics-aggregator.ts`, "ADR-001..005", "four gates" over five bullets | Each corrected against the tree; the secrets no longer exist, the two paths moved, there are eight ADRs and five gates                                                                                  |
| README: the order file has "its own register of the clauses this repository does NOT hold"                                                                                          | Withdrawn — the register marks all twenty-nine clauses held                                                                                                                                             |
| DEVELOPMENT.md: "the 72 database-backed tests skip and the 43 portable tests run"                                                                                                   | Withdrawn; counts are not restated there                                                                                                                                                                |
| ADR-001: the worker "deployed since FBL-020-R4 and running the identity expiry sweeps"                                                                                              | R4 registered one sweep; R5 registered the other two                                                                                                                                                    |

**Claims this STALE-FIGURE pass removed or narrowed (order §3.3/§3.6).** Four figures were
published at two values each. Correcting the four would have left the class alive, so each
correction below is accompanied by the derivation that makes it unrepeatable — see §5.4.
Every "old" value in this column is a figure this repository really did publish.

| Figure                                                                                  | Published as                                                                                                                                                                                                                    | Corrected to, and what now binds it                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The mutation-kill gate                                                                  | §5 and the map: "the last complete run covered <!--fig:quoted-->34<!--/fig-->, killed <!--fig:quoted-->34<!--/fig-->, 0 survived; the ten registered since have NOT been run as a batch", and §4 recorded PARTIAL on that basis | **44 declared / 44 killed / 0 survived**, a complete run of the whole registry — which is what `artifacts/mutation-kill.json` already said in the same packet. A report UNDERSTATING a mandatory §4 gate is an evidence defect. Bound to the artifact by `mutations_declared` / `mutations_killed` / `mutations_survived`                                                                               |
| `MINIMUM_TESTS`, the declared test floor                                                | The requirement map, three times: `MINIMUM_TESTS = <!--fig:quoted-->554<!--/fig-->`, "floors <!--fig:quoted-->554<!--/fig-->/58" and "the declared floor of <!--fig:quoted-->554<!--/fig-->/58"                                 | The value the constant actually holds. Bound to `scripts/parse-test-summary.ts` by `floor_tests`, with a restatement rule that fails on any document writing `MINIMUM_TESTS = ` and the wrong number                                                                                                                                                                                                    |
| The suite total                                                                         | §5 published one figure while the map published another                                                                                                                                                                         | One figure, read from `artifacts/test-summary.json`. Bound by `suite_tests` / `suite_suites` / `suite_passed`                                                                                                                                                                                                                                                                                           |
| The documentation battery's size                                                        | §5.1, twice: "returned `tests/delivery-documentation.test.ts` to <!--fig:quoted-->18<!--/fig--> / <!--fig:quoted-->18<!--/fig--> green", against a file that declared twenty                                                    | Read from the file. Bound by `doc_battery_tests`                                                                                                                                                                                                                                                                                                                                                        |
| `ORDER_MINIMUM_TESTS` / `ORDER_MINIMUM_SUITES`                                          | <!--fig:quoted-->315<!--/fig--> / <!--fig:quoted-->29<!--/fig-->, FBL-020-R4 §7's numbers, under the name "the order's own floor", recorded as a standing finding rather than corrected                                         | **459 / 47**, R5 §4's own floor clause. The finding is closed rather than re-recorded; §5 states why §4's figure and not Appendix A's                                                                                                                                                                                                                                                                   |
| BLUEPRINT-PROVENANCE: the Version 2.0 facts "transcribed from the R5 order text (§3.1)" | a citation that does not resolve — §3.1 of the order carries none of those facts                                                                                                                                                | Split honestly: the SHA-256 resolves, to Appendix A item 8; the byte length, title lines, version line and §14 headings resolve to nothing in this repository and are labelled as attested                                                                                                                                                                                                              |
| §10's own pointer to the changed-path commands                                          | §5.1, then §5.2                                                                                                                                                                                                                 | **§5.3**, which is where they are                                                                                                                                                                                                                                                                                                                                                                       |
| The battery total, AGAIN and inside the gate built to stop it                           | §5's gate table said 572 and §5.4's derivation table said 599 — in the same document, in the same revision                                                                                                                      | **572**, the count the arbitrating run recorded at that point — the current total is published from the artifact in §5.4 and is higher, because closing this finding added a test. The gate could not see it because `artifacts/` is gitignored and both mechanisms skipped a figure they could not read; the mutual-consistency limb added here needs no artifact and fails on the disagreement itself |
| The passing-test count                                                                  | §5 said 572, §5.4 said 599                                                                                                                                                                                                      | **572** at that point. Same source, same limb                                                                                                                                                                                                                                                                                                                                                           |
| The parser's observed anchored `ok` lines                                               | §5 said 631, §5.4 said 655                                                                                                                                                                                                      | **631** at that point, read from `observed_ok_lines` in the run's own summary                                                                                                                                                                                                                                                                                                                           |
| The documentation battery's size, a second time                                         | 25, correct until this wave added the mutual-consistency test to that very file                                                                                                                                                 | **26** — and the gate caught the staleness within seconds of the test being added, which is the derivation working rather than a proofread working                                                                                                                                                                                                                                                      |

---

## 11. Position

FBL-000 closed → FBL-010 closed → **FBL-020-R5 IN PROGRESS, as an uncommitted working tree,
with every clause UNVERIFIED until the final package proves it** → §3.1 **OPEN AND EXTERNALLY
BLOCKED** (both project copies are still Version 1.0; who must act and what they must verify
on arrival are in §8.4 and `docs/orders/BLUEPRINT-PROVENANCE.md`) → live WorkOS certification **NOT DISCHARGED**
(no credentials, §8.1) → the §0 census **REPORTED, NOT ACCEPTED** (§8.2) → an R5 CI run
**NOT DISCHARGED** (§8.3) → FBL-030 **not started**, and nothing in this revision touches it.

This report is not a claim that R5 is complete. It states what this tree contains and what it
does not, so that the reviewer weighs the gaps rather than discovering them.
