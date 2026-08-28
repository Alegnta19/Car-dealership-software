# FBL-020 — Known Limitations

**Current as of FBL-020-R6.** Stated plainly so the next order starts from facts. The R5
order text FBL-020-R6 succeeds is checked in at `docs/orders/FBL-020-R5.md`, canonical-LF SHA-256
`83b7bcd961bd36e1ba06ed79bebe524a8d1a6b40c65797ad2b4c37cc0ce47f44`
(`sed 's/\r$//' docs/orders/FBL-020-R5.md | sha256sum`); which blueprint governs, and what a bare
§14 citation resolves to in each, is `docs/orders/BLUEPRINT-PROVENANCE.md`.

**Every R5 clause is UNVERIFIED until the final package proves it** (that order's
Appendix A). Nothing in this document closes a clause, and any earlier statement anywhere in
this repository that an R5 blocker or clause was "closed" or "discharged" is withdrawn as a
governing status — such statements survive only as implementation notes.

**What this document is, exactly.** It is the hand-maintained register of
properties this identity boundary **implements but does not prove with a
deterministic test**, together with the known limits of the guards that do
prove things. The intent everywhere else in `docs/identity/` is that a claimed
property is enforced by code and pinned by a test; where that intent is not met,
the gap belongs here.

**What this document is not.** It is **not generated, and no gate proves it
complete.** Nothing in `npm test` compares the claims made across
`docs/identity/` against the assertions the suite actually makes, so "everything
unproven is listed here" is a promise about diligence, not a checked invariant.
What can be said precisely: every gap the five FBL-020-R3 adversarial review
waves found, every gap the R3 closeout (clusters K, L and M) found, every gap the R4
reviews left open, and the citation residue R5 §3.1 enumerated, is recorded below. A gap
that no review has found yet would not be.

Two parts of it _are_ pinned: `tests/identity-boundary.test.ts` `I2(ii)` fails
if the `withTransaction` abandonment write-up disappears from here or from
`packages/database/src/pool.ts`, and `tests/architecture.test.ts` fails if the
drift-guard fixture corpus stops biting.

## Not proven by deterministic CI

- **Live WorkOS behaviour — LIVE WORKOS CERTIFICATION IS NOT DISCHARGED.** Every
  verifier property — issuer/audience pinning, algorithm allowlist, JWKS caching
  and bounded refresh, rotation without restart, fail-closed outage, `auth_time`
  proof, nonce binding, impossible times — is proven against a deterministic local
  RSA issuer. WorkOS-specific behaviour (real AuthKit redirect parameters, real
  token claim shapes, real `max_age=0` semantics, real organization membership, and
  the **actual MFA-required organization policy**) is **not** exercised. This is a
  gate that has not been discharged, not a risk somebody may accept: it needs
  credentials and an operator.
- **The provider adapter, precisely.** FBL-020-R4 §7 correction: R3 stated here that
  "no test invokes the real SDK". **That was wrong, and the wrong version of the
  claim made the untested part sound larger than it is.** The adapter IS invoked, in
  process: `tests/identity-config.test.ts` builds the real adapter with
  `createWorkosProvider(...)` and calls `provider.refreshSession(...)` over a
  **mocked transport** — `globalThis.fetch` is substituted before construction,
  because the SDK captures its transport there — and asserts that the exchange is
  bounded, aborts its socket rather than merely abandoning it, and surfaces silence
  as `transient` instead of as a definitive refusal. No SDK type escapes the adapter.
  The **wiring** of the refresh is proven end to end as well: a request carrying a
  session cookie whose provider token is near expiry is driven over real HTTP through
  the real middleware, and the rotation, the non-extension of the local session, the
  transient-failure survival and the revoking outcomes are all asserted against the
  database (`tests/auth.test.ts`, the `C1:` tests). Only the port behind it is
  substituted, via `useIdentityProviderForTests`.
  What is therefore **not** proven is exactly this: that WorkOS's own endpoints
  return the shapes the adapter maps, and that a real WorkOS access token's `exp`
  produces a sensible refresh cadence in production. That is live behaviour, and
  **LIVE WORKOS CERTIFICATION IS NOT DISCHARGED.**
- **The reauthentication CALLBACK end-to-end.** The journey test drives
  `POST /auth/reauth/start` over real HTTP and then completes the exact
  transaction the route opened through the production completion service; the
  provider **code exchange** in the middle is the stubbed part.

## Proven by drill or by CI job, but NOT by `npm test`

These properties hold and have been demonstrated, but nothing in the in-process
suite fails if a future edit breaks them. Whoever edits the named artefact has to
re-run the drill.

- **Migration 057 reconciles BEFORE it constrains.** Every reconciling `UPDATE`
  in `migrations/057_identity_boundary_completion.sql` is written ahead of the
  CHECK, NOT NULL or unique index that depends on it, and several match zero rows
  on a database that migrates in order — they exist because the ORDERING is the
  property, not the row count.
  **FBL-020-R4 §6 turned this from a hand drill into a CI gate.** The
  `migration-upgrade` job now applies the retained schema through the last pre-057
  migration, seeds the committed populated fixture
  `tests/fixtures/legacy-identity-seed-pre-057.sql`, applies `057`, and asserts the
  exact reconciled state of every seeded row with nonzero, unchanged before/after
  counts (`scripts/verify-upgrade-state.ts`). `scripts/upgrade-negative-controls.ts`
  then removes each load-bearing reconciliation on an isolated copy of that database
  and requires the intended refusal — **twelve** controls, each declaring the stage it must
  fail at and the constraint or assertion the failure must name. R3's version of this
  was a local, prose-only exercise and was rejected as evidence; that rejection was
  correct.
  **The count was published here as "ten" until this revision, and that was stale**: ten is
  what R4 shipped, and R5 §0.6 added the two independent grantless-approval controls
  (`sas_grantless_approval_session_revoked`, `aud_grantless_approval_supersession_recorded`)
  beside the existing `sar_approval_without_grant_superseded`. The authority is the runner's
  own `CONTROLS` array — `grep -c "^    id: '" scripts/upgrade-negative-controls.ts` — and
  `scripts/reconciliation-inventory.ts` prints the same figure as
  `negative_controls_declared`.
  Two limits remain, and they are the reason this entry stays in this section.
  **`npm test` alone still does not fail if the file is reordered** — a mutated
  migration cannot change a database that has already been migrated, so the gate has
  to be the upgrade job. And **twenty-four statements in `057` cannot be shown load-bearing
  by any pre-057 fixture**, because they operate on columns `057` itself creates; they
  are enumerated with their reasons in the `negative-controls.json` artifact and counted by
  `scripts/reconciliation-inventory.ts` as `reconciliations_declared_not_load_bearing`,
  rather than counted as proven. (That figure read "eight" here until this revision, from a
  much earlier body of `057`; re-derive it with the inventory script rather than quoting
  this sentence.)
- **Fresh chain and upgrade path converge on one schema.** Asserted by the CI
  `migration-upgrade` job comparing two fingerprints. Local runs corroborate only:
  catalog text differs across PostgreSQL builds, so a local value is not the
  authoritative one.
  **FBL-020-R6 §3 found the comparison itself to be unsound and fixed it.**
  `scripts/schema-fingerprint.ts` sorted functions by name alone, and `pgcrypto` installs
  overloads that tie on the name — so two databases carrying the SAME schema could return
  the tied rows in different physical orders and the job would compare a set against a
  permutation of itself. It did exactly that on this order's drill: everything but the
  function list matched, and the fingerprints differed. The sort is now `proname` plus
  `pg_get_function_identity_arguments`, which is unique, and the two paths converge on one
  value. Every fingerprint taken before that change is a value from a nondeterministic
  ordering and should not be quoted.
- **FBL-020-R6 §3's database controls are proved by dropping them, not by `npm test`.**
  The §3 rules live in migration `058` as CHECKs, an index and triggers, so the ordinary
  mutation runner cannot reach them: it edits TypeScript, and the suite runs against a
  database where `058` has already been applied. `scripts/database-control-mutations.ts`
  is the counterpart — it copies the migrated database, DROPS one control (or removes one
  anchored clause from one trigger function, read out of `058` itself), requires a
  SPECIFICALLY NAMED test to die, restores the control and requires the same test to pass
  again. Twenty-five checks, zero survivors, gated in CI — the count is
  `grep -c "^    id: '" scripts/database-control-mutations.ts`, and it moved because R6-R6
  added the two the D1 and D4 findings needed. What `npm test` alone still does not
  catch is a later migration that quietly drops one of these controls: the battery would
  go red, but only because the named tests would start failing — there is no separate
  assertion that the controls exist.
- **The delivery report's own numbers.** `docs/FBL-020-DELIVERY-REPORT.md`
  carries test counts, checksums, ratchet values and CI evidence. **No gate pins
  any of them**, which is how the R2 report came to describe a head two commits and
  a working-tree path count in the past.
  **This bullet deliberately quotes none of those figures, and it no longer names the
  sections that hold them either.** Both halves of that are corrections rather than style
  choices, and the second one is new in this revision.
  It previously restated a Prettier count and a changed-path split, and both went stale the
  moment a later revision rewrote those sections — a bullet whose entire warning is
  "re-measure before quoting" was quoting stale numbers. So the numbers came out.
  It then pointed at **§7** for the Prettier scan, **§10** for the changed-path list and
  **§2** for the count of paths R2's head is behind, and **all three of those pointers were
  themselves stale at R5**: the report's §7 is now "Residual risk", its §10 is "Claims this
  revision removed or narrowed", its §2 is "Delivery discipline", the changed-path summary
  moved to **§5.3** (an earlier revision of this bullet said §5.2, which was the same defect
  one section over), and the report carries **no Prettier scan and no R2-head path count at
  all** — `grep -i prettier docs/FBL-020-DELIVERY-REPORT.md` returns nothing. A pointer to a
  section number is exactly as perishable as the number it points at, which is the lesson
  this bullet exists to teach and had not yet applied to itself.
  **The reference by section number is therefore withdrawn.** The changed-path totals live
  under the report's own heading "The changed-path summary", beside the two commands that
  reproduce them; find it by that heading, not by a number.
  Migration checksums are the one part with a defence: the frozen chain is published beside
  git blob OIDs, so a stale value can be caught by re-deriving it — and `057` was
  deliberately left unpinned in both this repository's data dictionary and the report while
  it was still being edited in place. **FBL-020-R6 §1.3 FROZE `057`**, so that reason has
  lapsed; the pin is a matter for the revision that next publishes the chain, and until
  then the digest is re-derivable from `scripts/migration-manifest.ts`. THAT ADVICE IS NOW NARROWER THAN IT WAS, and the change is a
  gate rather than a promise: every run-produced or script-produced figure in that report
  and in the requirement map is read from its own artifact or constant by
  `scripts/check-published-figures.ts`, which fails the build when a published number and
  its source disagree — by marked span or by restated prose. THREE figures used to sit
  outside it, each labelled where it appeared. NONE DO NOW: the Version 2.0 blueprint's byte
  length and the quality ceilings below are derived from that document's own bytes since
  FBL-020-R6 committed it, and the changed-path counts are no longer published at all
  because a working-tree diffstat cannot stay true long enough to be worth labelling.
  The risk is live, not hypothetical. R4's report carried a 163-row per-file diffstat table;
  the final review pass of R3 found its row for **this file** stale, and recording that very
  finding here moved the same row again. **That table was deleted in this revision rather
  than carried forward**, so the sentence that used to say "the authoritative figure lives
  only in §10 of the report" now points at nothing and is withdrawn too. Re-derive what you
  need with `git diff --numstat <base> -- <path>`; do not copy it here, and do not expect a
  table in the report to hold it.

- **The ratchet ceilings are a document, not a gate.** The ceilings are
  **59 / 136 / 23**, defined by the GOVERNING blueprint
  (`Car_Dealership_Management_and_Sales_Cloud_Master_Blueprint.docx`, sha256
  `556d4e10…`, §14.3, "R2 gate and stop rule": _"Quality ceilings remain tsc-strict
  <=59, eslint <=136 and format <=23."_).
  `docs/adr/ADR-005-technology-selections.md` RESTATES them and is not the
  definition site — it read 29 for the third value until R4, and R3 wrongly
  "corrected" the reporting to match the ADR on the grounds that it was the only
  place in the repository that stated them. Both are reconciled to the blueprint
  now; `docs/FBL-020-DELIVERY-REPORT.md` carries the full history under its
  "Verification evidence" heading. **These three numbers ARE verifiable from this
  repository**, because FBL-020-R6 committed the Version 2.0 document into it:
  `scripts/check-published-figures.ts` derives each of them from that file's paragraph text,
  and `tests/delivery-documentation.test.ts` asserts the sentence occurs EXACTLY ONCE there
  and that the word "ceiling" appears nowhere in the Version 1.0 document. What remains true
  is the narrower statement: a reader holding only the Version 1.0 **document** cannot find
  them, and neither can the checked-in R5 order text
  (`grep -i ceiling docs/orders/FBL-020-R5.md` → nothing). Two earlier claims are withdrawn
  in `docs/orders/BLUEPRINT-PROVENANCE.md`: that the order text restated them, and that they
  could not be checked from this project record at all.
  Independently of which number is right: `scripts/quality-ratchet.ts` implements
  no ceiling concept whatsoever (`grep -c ceiling` → 0); `check` refuses growth
  against `quality-baselines.json` per-total and per-file, and nothing more. Any
  claim that "no ceiling was raised" is an assertion about a document, not a
  verified property, and NOTHING IN CI WOULD FAIL IF A CEILING WERE EXCEEDED.

- **The audit inventory is complete over the `identity.` names the shared resolver
  can READ, not over `audit_events`.** `scripts/check-audit-inventory.ts` (in
  `npm run architecture:check`) accounts for every `identity.`-namespaced name it
  can resolve in production code against
  `packages/identity-access/src/audit-inventory.ts`, refuses a name it can only
  partly read, and refuses an `INSERT INTO audit_events` in any file that is not a
  declared writer.
  **The scope of "can read" is the whole of the claim**, and it is not a synonym
  for "spelled in one string literal". Names are resolved through the ONE shared
  static string resolver, `scripts/static-string-resolver.ts`, which
  `scripts/check-role-binding-effectiveness.ts` also uses: concatenation, `+=`
  accumulation, `.join`, `String.prototype.concat`, `String.raw`, `String(x)`,
  indexed fragments and `.at(i)`, array literals/spreads/`push`/`Array.from`/
  `Object.values`, lookup maps under an unresolvable key, `?:`/`??`/`||`
  alternatives, `for … of` element bindings, and named, aliased, namespaced and
  re-exported imports across files.
  `architecture/fixtures/audit-inventory-assembly/` is twelve of those spellings,
  **every one of which the current gate rejects** — asserted by _EVERY assembly
  spelling the shared resolver reads is REJECTED, and none passes silently_, and
  reproducible today. The R4 first-pass gate read one regular expression over
  `node.text` plus `node.head.text` and missed most of them, which is why this entry
  no longer says "refuses an event type assembled at run time" as an absolute.
  **How many it missed is deliberately not stated here.** Two documents published
  that count as eleven and two tests as ten; at most one was right, and none was
  re-measured before publishing. The figure is withdrawn rather than adjudicated —
  it is not evidence this delivery needs, and choosing between two unverified
  readings would repeat, in miniature, the defect this order exists to correct.
  Four limits follow from the shape, and each of the first two is DEMONSTRATED by a
  fixture in `architecture/fixtures/audit-inventory-residue/` that the gate ACCEPTS
  — pinned by _the residue the gate cannot see is ACCEPTED, and named in the
  documents_ in `tests/architecture.test.ts`, so closing a residue turns that test
  red and forces this entry to change with it:

  - A name where **neither the root nor a declared family** can be read —
    `${root}.${family}.renamed`, `${a}${b}.renamed`. The gate refuses a readable
    root with an unreadable tail (`identity.support.${x}` →
    `audit-event-type-assembled-at-run-time`) and an unreadable root followed by a
    declared family (`${ns}.support.quarantined` →
    `audit-event-type-namespace-root-assembled-at-run-time`); with NEITHER
    readable, nothing marks the string as an event type, and reporting every
    unresolvable string in the repository would make the gate unusable. Such a
    write is still confined to a declared writer file.
  - An audit event type OUTSIDE the `identity.` namespace is reached only by the
    declared-writer rule, which is a rule about FILES rather than names. One
    writer is declared non-enumerable —
    `packages/fixed-ops/src/legacy/service-cockpit-service.ts`, pre-existing
    Phase-248 code that assembles `service.${action}` at run time — so its event
    types are not enumerated anywhere. FBL-020 does not touch that file, and the
    gate would refuse a NEW file writing a new namespace, but the existing
    `service.*` set is uninventoried.
  - A migration that assembled an event type in PL/pgSQL `format()` is caught only
    by the "this `INSERT INTO audit_events` carries no static event-type literal"
    rule, which is position-free and therefore coarse: it proves a literal is
    present in the statement, not that the literal occupies the `event_type`
    column. No migration in this repository does this — 057's two audit writes
    both name their event type as a literal in the SELECT list. The coarseness is
    exercised, not just described, by _rule:
    migration-audit-write-has-no-static-event-type_ in
    `tests/audit-inventory-rules.test.ts`, which feeds the rule a statement whose
    literal sits in `details` rather than `event_type` and records that it passes.
  - Everything the shared resolver states it cannot see: values crossing a function
    boundary, array mutation other than `push`, object KEYS, strings produced at
    run time (`JSON.parse`, a database read), and its depth and breadth limits.
    Operations that REWRITE rather than assemble — `.replace`, `.slice`, a case
    fold, `.reduce`, a template tag other than `String.raw` — are not a residue:
    their input is rendered and the operation is refused
    (`architecture/fixtures/audit-inventory-assembly/evasion-k-opaque-rewrites.ts`).

- **One inventory citation is a CI gate, not a suite test.**
  `identity.support.approval_superseded` is written by migration 057's §5 / §A2
  reconciliation, which can only happen once, on a database that predates the
  migration. Its `provenIn` / `provenBy` therefore name
  `scripts/verify-upgrade-state.ts` and its check id
  `audit_grantless_supersession_is_recorded_with_its_reason` rather than a
  `test(…)`. The audit-inventory gate verifies the file contains that string; the
  assertion itself runs in the CI upgrade job, not in `npm test`.
  **FBL-020-R6-R6 §D9 corrected the id printed here.** This paragraph used to name
  `audit_supersession_is_recorded`, which is not the inventory's `provenBy` value
  and is not a string in `scripts/verify-upgrade-state.ts` — an id that resolves
  nowhere, cited as though a reader could look it up. The audit-inventory gate
  compared the inventory against the script and was satisfied; NOTHING compared
  this document's restatement of the id against either, which is exactly the space
  the R5 and R6 gates kept finding defects in.

- **The refresh-lease conditional write is unpinned defence-in-depth.** The claim
  UPDATE in `packages/identity-access/src/session.ts` carries
  `AND (refresh_lease_id IS NULL OR refresh_lease_expires_at <= NOW())`, and the
  comment above it states that this is what makes the **database** rather than
  the process authoritative when clock skew makes the in-process dueness check
  disagree. That is true of the code as written, but **no test proves it**:
  replacing the predicate with `AND TRUE` leaves the whole identity-boundary
  battery green. (The pass/total figure that used to be quoted here — `60/60` — is
  withdrawn rather than updated: `tests/identity-boundary.test.ts` has grown since it was
  measured, so the number was stale, and a count is not what the claim rests on. What the
  claim rests on is that NO test goes red, which is reproducible at any suite size.)
  The property is real defence-in-depth — the `FOR UPDATE`
  read and the conditional UPDATE share one transaction, so the mutation-pinned
  in-process path covers every non-skew case — but a behavioural claim in a
  shipped comment with no test is exactly what this document exists to register.
  _Reproduce: make that substitution and run
  `tests/identity-boundary.test.ts`; contrast the D1 transaction-across-network
  mutation on the same file, which kills two named tests._

## Open at FBL-020-R5 submission — disclosed, not closed

**FIVE** items are open here — the count read FOUR while five bullets stood beneath it, which
is the same off-by-one this document exists to refuse — all of them found by R4's own final
gate and still open at
submission, at the repository owner's explicit instruction, rather than held for a further
correction pass; neither R5 nor R6 closed them and neither claims to.

**A FIFTH ITEM STOOD HERE AND IS NOW CLOSED — the untested `session_establishment_failed`
login exit.** FBL-020-R6 §4.2 covered it with a route-level test,
_a login whose LOCAL SESSION cannot be established is terminal, with ONE audit event_ in
`tests/login-admission.test.ts`, which drives a real `GET /auth/callback` against a valid
provider exchange while a `BEFORE INSERT` trigger makes the local session write impossible,
and then asserts the terminal state (`failed` / `session_establishment_failed`), the single
terminal audit event (`identity.login.started`, `identity.login.claimed`,
`identity.login.failed` and nothing else) and that no session, credential or success event
survives. The control is registered in `scripts/mutation-kill.ts` as
`session_establishment_failure_left_pending`, so CI kills it rather than a reader trusting
this paragraph: deleting the route's `failLoginTransaction(…, 'session_establishment_failed')`
call takes that named test from pass to fail. `docs/identity/AUTH-FLOWS.md` no longer says
one of the nine reasons reaches no test, because none does.

None of the five is a runtime authorization defect. All are gaps in the **guard
scaffolding** or in the precision of a header. They are listed here so the architect can
weigh them directly instead of discovering them.

- **Three declared residue SHAPES have no fixture behind them.** The bulleted list above
  names **four residue CLASSES** for the audit-inventory gate, and the arithmetic is worth
  stating because an earlier revision of this bullet said "four classes … two … the other
  three", which does not add up and made the gap look like a different size than it is.
  The four classes divide like this:
  1. **root-and-family-both-assembled** — DEMONSTRATED by a fixture in
     `architecture/fixtures/audit-inventory-residue/` the gate is asserted to ACCEPT;
  2. **a name outside the `identity.` namespace** — DEMONSTRATED by the second fixture
     there, likewise;
  3. **a migration assembling an event type in PL/pgSQL `format()`** — not a fixture, but
     EXERCISED by _rule: migration-audit-write-has-no-static-event-type_ in
     `tests/audit-inventory-rules.test.ts`, which feeds the rule a statement whose literal
     sits in `details` and records that it passes;
  4. **everything the shared resolver states it cannot see** — which is where the three
     unfixtured shapes live: **a value crossing a function boundary with an unreadable
     root**, **array mutation other than `push`** (`parts[0]=`, `unshift`, `splice`) and
     **a name formed from object KEYS** (`Object.keys(FRAGMENTS).join('')`).
     Those three shapes are prose only. Each was reproduced by probe during review, so they are
     real and correctly described; what is missing is a fixture asserting the gate accepts them,
     which is the standard classes 1 and 2 meet. _Consequence: a future edit could close or
     widen one of those three and no test would notice._

- **`058` §0's ABSENT-BINDING residue shape has no committed control.** §0 reconciles the
  normalized authority rows `057` never backfilled, and a decision it cannot reconcile is
  left whole in a RESIDUE at `evidence_version` 1. The residue has three shapes: an array
  naming a binding that no longer exists or was never the decision actor's; a recorded
  version the binding has never reached or that is below 1; and the same binding named
  twice. **The retained pre-057 fixture carries only the VERSION shape**, and that one is
  asserted exactly — which decisions were normalized, at which ordinality, from which
  binding at which version, and that the unreconciled rows survived byte-for-byte — by
  `scripts/verify-upgrade-state.ts --phase=post-057` on every drill run. The absent-binding
  shape reaches the same branch by construction (one LEFT JOIN and one `rb.role_binding_id
IS NULL` test — there is no second code path), but **no fixture and no control drives it**.
  <!--final-state:withdrawn-->

  An earlier revision of `migrations/058_policy_evidence_reconstructable.sql` and of
  `docs/FBL-020-DELIVERY-REPORT.md` closed this gap with the words "MEASURED, NOT ARGUED",
  citing a one-off experiment on a drill database — deleting the binding a named retained
  decision points at, and observing three residue decisions instead of two. **Nothing in
  this repository re-runs it.** That is a cited control that does not exist in the tree, and
  both citations are **withdrawn** rather than restated. This bullet is what replaced them.
  <!--/final-state-->

  _Consequence: if the LEFT JOIN were replaced by an INNER JOIN, the absent-binding decision
  would silently vanish from the reconciliation instead of landing in the residue, and the
  drill would stay green. Closing this needs a control that copies the post-057 drill
  database, deletes one named binding, applies `058` and asserts the residue classification._

- **One audit-inventory rule has no test, under a header saying every rule does.**
  `scripts/check-audit-inventory.ts` states "EVERY RULE IN THIS FILE IS TESTED". The
  variant-overflow branch — a third, independently-conditioned raise of
  `audit-event-type-assembled-at-run-time` when the resolver's variant cap is exceeded —
  is not reached by any fixture or rule test. Twenty-one of the twenty-two rules are
  pinned; this is the twenty-second. The header sentence is therefore **still slightly
  broader than the code**, and that is disclosed here rather than silently left.

- **The sibling owned-mutation gate has an untested rule of the same shape.**
  `owned-mutation-owner-declaration-is-stale` in `scripts/check-owned-mutations.ts` fires
  only on a whole-tree run, so the fixture-driven test in `tests/owned-mutations.test.ts`
  cannot reach it. The remedy applied to the audit gate — export the rule functions and
  drive them directly — was not applied here. _Consequence: an owner declaration that
  stops matching a real writer can sit unnoticed._

- **The shared resolver's header is marginally broader than its code.**
  `scripts/static-string-resolver.ts` paragraph 1 lists `.reduce` accumulation and
  template tags among what it "resolves"; the code treats a `.reduce` fold and a
  non-`String.raw` tag as OPAQUE (it names the unreadable piece rather than rendering it,
  which is fail-loud and safe, but it is not resolution). Its "WHAT IT CANNOT SEE" list
  also omits `.padStart`/`.padEnd`/`.repeat`/`.normalize`/`.substring`/`.substr`. The
  behaviour is correct and fail-closed in every case; the prose overstates the reading
  power.

Two things these items are **not**: none of them is a mandatory gate — the undischarged gates
are listed in `docs/FBL-020-DELIVERY-REPORT.md` under its "Gates NOT DISCHARGED" heading,
and these are not among them — and none is a runtime access-control hole that an
unauthenticated or unauthorized caller can reach. For the four guard-scaffolding items a
developer must author the code in question. The identity boundary itself (admission, tuple
constraints, evidence completeness, lifecycle audit, support expiry, owned mutations,
revocation) is pinned by tests proven to fail when the control is reverted.

### The CI state, stated once and exactly (FBL-020-R6 §4.4)

**THE LAST CI-MEASURED COMMIT IS `ee5eb6b00ef91542f3129fa9957fc22d3ce51f0f` AND ITS
EXACT-SHA `.github/workflows/ci.yml` RUN 32493409959 COMPLETED WITH 4 OF 4 JOBS
SUCCESSFUL.** That is the R6 final head — the FBL-020-R7 baseline — not the R7 commits,
whose own run is bound to them by the external return packet (FBL-020-R7-A1 §7). Per-job
conclusions and the property table are in §1 of the delivery report;
the single committed record both documents read is
`docs/evidence/FBL-020-FINAL-STATE.json`.

**THE FBL-020-R7 WORK IS COMMITTED, AND THE EXACT-SHA RUN NAMED ABOVE MEASURED AN EARLIER
COMMIT AND NOT IT.** The R7 commits are listed in the final-state record with `run: null`
until their own exact-SHA runs exist. Beneath them the R6 history stands as recorded: R6
§1–§4 were committed after the operator authorised a transfer path that required it. It did not land on the first attempt: `0fe4ae7` and `242e24a` **both FAILED
their exact-SHA runs** (32450787623 and 32452596992). The commit the run above measured is the
evidence commit named in the same sentence, and delivery report §1.1 lists every commit in the
range with its own run and conclusion. A green third attempt does not un-fail the first two, and both stay in the record.
The delivery report's "Verification evidence" section records the local runs as well, and a
local run is not a CI run.

**THE ONE-COMMIT BUDGET WAS REMOVED FOR R7 BY FBL-020-R7-A1 §4: 11 CODE-BEARING COMMITS
EXIST ACROSS R5, R6 AND R7, 4 OF THEM FAILED THEIR OWN EXACT-SHA RUN, AND EVERY ONE IS
DISCLOSED IN THE FINAL-STATE RECORD.** The R5/R6 one-commit budgets were ruled VIOLATED and
disclosure does not cure those violations; the rulings stand unedited. Under FBL-020-R5 the
failures were `52e1567` (run 32162114699) and `0e99ecd` (run 32168154239), 2 of 4 jobs red
each time, with `174c789` the green one for that order. Under FBL-020-R6 they are `0fe4ae7`
and `242e24a`, 1 of 4 jobs red each time; the code-bearing commits after them were green.
Delivery report §1.1 lists every commit in the range with its own run and conclusion. Delivery report
§1.1 carries the table and names what broke in each.

<!--final-state:withdrawn-->

This section used to end: "the report's Verification evidence section records local runs on
this tree, and **no CI run exists for it**. Two earlier code-bearing commits were pushed and
both FAILED their exact-SHA `ci.yml` run." Both halves were false by the time they were
read — a green run existed for the final commit, and three code-bearing commits existed, not
two. **That count is a statement about the moment of THAT correction, not a current figure:**
the live number is published above from
`docs/evidence/FBL-020-FINAL-STATE.json`, never from this paragraph. `scripts/check-final-state.ts` refuses both sentences outside this block.

<!--/final-state-->

## The R6 order text is only PARTLY checked in (FBL-020-R6 gate finding C3)

`docs/orders/FBL-020-R6.md` now exists, and it is what finding C3 required: without it, R6
§4.3 was both unaddressed and undisclosed, so a reviewer could not learn what had been
skipped. **What that file can hold verbatim, it holds verbatim:** §4.3, quoted in full by the
gate, and the gate's own correction order.

**What it cannot hold is the verbatim text of §1, §2, §3 and §4.1–§4.2, §4.4–§4.6.** That
text was routed to the implementation waves section by section and is not in this
repository's hands. The clause register in Part 2 of that file therefore records those
clauses by identifier and by the subject **this repository's own artifacts cite them under**,
and marks every such row _(derived)_. No paraphrase is presented as an order's words.

This is an **OPEN** item, not a closed one. It is the same defect the R5 order file carried —
that file recorded some clauses as "text not held" and was corrected when the text arrived —
and it closes the same way: by the text arriving.

## Blueprint citations that do not say which document (FBL-020-R5 §3.1)

`§14.3` names FBL-000 in the superseded Version 1.0 blueprint and FBL-020-R2 in the
governing Version 2.0 document, both of which are committed here. Every markdown document in this repository is held to
naming the version, the file or the digest — `tests/delivery-documentation.test.ts` fails
otherwise. **Three source files are not, and they are declared rather than quietly
tolerated:**

- `packages/identity-access/src/audit-inventory.ts`
- `packages/identity-access/src/login-transaction.ts`
- `tests/identity-boundary.test.ts`

Each carries a bare `§14.3` in a comment, naming neither Version 1.0 nor Version 2.0. They are listed in
`docs/FBL-020-R5-REQUIREMENT-MAP.json` under `bare_blueprint_citation_residue`, and
`scripts/check-requirement-map.ts` fails in **both** directions: an undeclared file that
starts citing a section, or a declared file that stops. They were not edited because they
belong to clauses this revision does not own. `migrations/057_identity_boundary_completion.sql`
cites the same section but names the Version 2.0 document, so it is unambiguous and is not
in the residue; its comment is also the one edit that would move a digest pinned in several
places.

## Citations to a clause number the order does not define (`§4.8`)

Seven comments and test names across five files cite **`FBL-020-R5 §4.8`**. The order has a
`§4`, and **`§4` has no numbered sub-clauses at all**, so `§4.8` names nothing. The
citations are otherwise accurate about what they describe — the worker's registration of all
three expiry sweeps, which is the order's **§1.6** — they simply cite a section number that
does not exist.

| File                              | Occurrences |
| --------------------------------- | ----------- |
| `.github/workflows/ci.yml`        | 1           |
| `apps/worker/src/main.ts`         | 1           |
| `scripts/mutation-kill.ts`        | 1           |
| `tests/worker-entrypoint.test.ts` | 2           |
| `tests/worker-jobs.test.ts`       | 2           |

(`apps/worker/dist/main.d.ts` carries an eighth, generated from `main.ts`.)

**Why they are disclosed rather than corrected here.** Two of the seven are inside test
NAMES — `the worker job registry, through the compiled entry point (FBL-020-R5 §4.8)` and
`every registered worker job performs its transition exactly once (FBL-020-R5 §4.8)` — and
those names are pinned verbatim by `docs/FBL-020-R5-REQUIREMENT-MAP.json` and checked by
`scripts/check-requirement-map.ts`. Renaming them is a coordinated code-and-map change, which
is not what a document-reconciliation pass may make. **No PROSE in this repository claims
`§4.8` exists**, and the narrowing is the point: the seven citations counted above DO claim
it, because a citation is a claim, which is why they are registered as a defect rather than
waved through. The delivery report names `§4.8` as a citation the order does not use, and
this entry is the register of every place it survives.

## The census reads a host, and one probe still depends on a daemon

**`scripts/migration-census.ts` classifies the docker-compose volume as `persistent`, and
when the Docker daemon is unreachable that probe's verdict falls to `indeterminate`.** An
indeterminate persistent environment blocks the in-place branch by design — that is the
fail-closed rule working — but it means the POSITION depends on whether a daemon happens to
be running on the host taking the census, and the CI `verify` job does not otherwise use
Docker or declare it. It is recorded here rather than fixed because making it unconditional
would mean either trusting an uninspected environment — the exact error the rule exists to
prevent — or declaring Docker a census dependency, which is a change to what the order asks
for. A reviewer should know the position has a host dependency.

**As of FBL-020-R6 §1.3 this dependency cannot change the branch, and that is worth stating
plainly.** The committed operator census reports `FREEZE_057_AND_ADD_058`: one cluster
counted with the persistent ones holds a form of `057`, and many more on the host cannot be
classified at all, so the negative §1.3 requires is unproven and `057` is frozen. A daemon
that went away would turn one more probe indeterminate, which lands on the same branch. Only a census in which
EVERY environment is classified AND every probe answers `no` permits editing `057` in
place, and this host is not that.

Twice now the same defect class has been found in this file: an environment that CANNOT be
inspected and an environment that IS NOT THERE were scored alike. Both are fixed (the port
branch and the vanished-directory branch, each with a test driving both directions). This
entry is the residue of the same shape and is stated rather than implied.

## The runtime identity is a real login, and startup role switching is refused (FBL-020-R7-C2 §1)

Migration `059` separates `dealership_runtime` (no direct DML on
`policy_decision_matched_bindings`, not a member of the evidence owner) from
`dealership_evidence_owner` (owns the `SECURITY DEFINER` normalizer), and migration `060`
gives the application its CONNECTION IDENTITY: `dealership_app`, a genuine non-owner LOGIN
role that is a member of `dealership_runtime` and of nothing else. The API and worker
authenticate as it directly in `DATABASE_URL`. The R7-era `-c role=` startup switch is
REMOVED: `DATABASE_RUNTIME_ROLE` now refuses at configuration load (an owner URL plus that
variable fails startup rather than dressing the owner in the runtime role), and the boot
posture gate reads **both** `session_user` and `current_user` — superuser, membership in
any enumerated actual owner, every ledger write verb, and direct child-evidence INSERT are
each judged about both identities, so a switched role cannot conceal the login behind it.
A deployment that connects as a superuser still bypasses the separation in non-production
modes (the posture gate is production fail-closed; local smoke legitimately connects as
the owner to build fixtures), and the migration runner keeps owner authority by design:
applying migrations creates roles and grants. What the schema guarantees regardless of
deployment: the GUC writer guard is gone, so there is no caller-settable marker left to
forge, and the composite keys, triggers and CHECKs of `059`/`060` bind every writer,
superuser included, except where PostgreSQL itself exempts superusers from privilege
checks — which is the standing "the database owner can do anything" boundary already
recorded under accepted operational consequences.

## Deliberately out of scope (named owners)

| Gap                                                                                                             | Owner                       |
| --------------------------------------------------------------------------------------------------------------- | --------------------------- |
| Durable audit outbox and tamper-evident envelope — audit rows are transactional, delivery is not guaranteed     | FBL-040                     |
| Row-level security; the new tables ship tenant-qualified constraints, legacy tables keep query-layer discipline | FBL-030                     |
| SAML SSO and SCIM — interfaces only, unenableable (database CHECK)                                              | future order                |
| Provider webhooks (organization/user lifecycle push)                                                            | future order                |
| Break-glass access without an approver                                                                          | refused by design (ADR-008) |
| OpenAPI v1 surface for /auth                                                                                    | FBL-030+                    |
| Splitting the 3,300-line legacy service                                                                         | FBL-060                     |

### No HTTP administration surface

FBL-020 ships the `identity.*` / `org.unit.*` actions and the engine that
decides them, but **no route declares them**. Administration is performed by
calling the owned mutation services in `@dealer/identity-access`
(`provisionUserLink`, `activateUserLink`, `grantRole`, `changeRole`,
`revokeRole`, `certifyProviderMfaPolicy`, `changeProviderIssuer`,
`decideSupportAccess`, …) or by the audited bootstrap command. Those services
are the _only_ sanctioned path: each one requires an existing acting user link,
advances the applicable `authorization_version`, and writes its `audit_events`
row in the same transaction. Raw `INSERT`s into `role_bindings` bypass all
three and must not be used.

## Accepted operational consequences

- **Provider outage blocks login and reauthentication.** Existing sessions keep
  working until they expire; a transient refresh failure changes nothing. There
  is no local fallback authenticator by design.
- **A due refresh costs the request a provider round trip.** Roughly once per
  provider access-token lifetime, one cookie request per session pays for the
  exchange while holding that session's row lock; parallel requests for the same
  session queue behind it and then find nothing to do. The benefit bought with it
  is that the provider's continued assent is re-checked on that cadence instead of
  never — an identity disabled at the IdP loses its local session within minutes
  rather than at the end of the local TTL. If the latency ever matters, the fix is
  to move the exchange off the request path (a job that refreshes due sessions),
  **not** to stop refreshing: an unspendable credential in custody was the defect.
- **A cookie session's absolute bound is unchanged by refreshing.** The rotation
  is given the session's remaining life, so eight hours after login the person
  authenticates with the provider again however many refreshes happened in
  between.
- **A JWKS outage longer than the key cache now costs sessions, not just
  logins.** Stated plainly because making the refresh reachable is what created
  the exposure. When a refresh is due, the replacement access token is verified,
  and the verifier fails closed — including when it cannot fetch the key set. A
  refresh whose replacement cannot be verified REVOKES the session, because the
  exchange has already spent the presented refresh token and a session that
  keeps an unverified replacement would be trusting a token nobody checked.
  Bounds on the exposure: keys are cached for ten minutes and a cached hit makes
  no network call, so only an outage that outlives the cache reaches this; and in
  that state every bearer request and every login is already failing closed, so
  the platform is not otherwise healthy. Consequence when it happens: affected
  people log in again once the provider returns. The mitigations, in order of
  preference, are to move the exchange off the request path so a failure retries
  instead of landing on a user, and to lengthen `jwksCacheMaxAgeMs`; **not** to
  accept an unverified replacement token.
- **Support access stalls without an available approver.** Requester ≠ approver
  is a structural CHECK, the approver must be a current tenant administrator of
  the target tenant, and an approval additionally requires that approver's own
  high-assurance grant. There is no self-approval and no break-glass path.
- **Rotating `WORKOS_COOKIE_PASSWORD` logs everyone out**, invalidates
  outstanding OAuth transactions, and makes existing sealed refresh state
  unreadable — a session in that state reports `unavailable`
  (`key_version_mismatch` / `sealed_state_unreadable`) rather than being
  destroyed.
- **`step_up_token_uses` (migration 050) is dead weight.** It is no longer
  written or read; dropping it is a future migration, not this one.
- **`platform_admin` no longer implies dealership access.** Any operational
  procedure that relied on that must go through support access.
- **A step-up requires a live local session.** `POST /auth/reauth/start`
  refuses when the request has no live local session to step up from, and a
  session revoked between start and callback mints nothing.

## Lessons carried forward (R0–R3)

The first pass of FBL-020 shipped CI-green and was then put through three
rounds of adversarial review. These are the shapes worth remembering:

- **Scope was ignored for actions that name no resource.** Roughly a quarter of
  the catalog acts without naming a row, and the engine treated "no node named"
  as "any binding covers it". A rooftop-scoped advisor had tenant-wide reach.
  The rule now: a named location is resolved and must be covered; with no
  location the action is tenant-wide and needs a tenant-scope binding. **Any
  new resource-less action inherits this — supply `location_id` when the action
  lands somewhere specific.**
- **A flow can be perfectly implemented at both ends and still be unreachable
  in the middle.** Reauthentication had a correct start route, correct callback
  and correct grant service, but the authorization URL carried the login
  redirect, so the callback had no caller. Registered redirect URIs are
  per-flow. **The same shape came back in R3** and is worth the repetition:
  `/auth/callback` sealed a provider refresh credential on every login,
  `refreshProviderSession` implemented a full exchange, and nothing in `apps/`,
  `packages/` or `scripts/` ever called it — so the platform held a long-lived
  provider credential per session that no running code could spend. Custody
  without a spender is blast radius with no benefit. When a credential is stored,
  name the code path that uses it and test THAT path.
- **An audit trail that records only refusals is not an audit trail.** Login
  observation wrote its `audit_events` row on the deactivated and pending
  branches and nothing on the activated one — the only branch that goes on to
  mint a session — while the module header claimed every observation wrote one. A
  false claim in a header is worse than no claim. Audit the success path, and
  record which fields changed rather than their values.
- **Status columns that nothing reads are decoration.** `isEffectiveAt()`
  existed, was unit-tested, and had zero production callers; archiving a
  rooftop revoked nothing. If a lifecycle column is meant to gate access, the
  gate must be in the query the authorization path actually runs.
- **A stored digest that nothing compares is decoration too.** R1 added
  `oidc_nonce_hash` to `reauthentication_transactions` and R2 kept writing it;
  neither ever read it, so the only nonce check that ran was against the value
  the client's own cookie carried. R3 makes the stored digest participate, and
  a `started` transaction that cannot name one is now forbidden by CHECK.
- **An optional comparison is not a comparison.** R2 compared verified identity
  facts only `if (supplied !== undefined)`, so a caller that supplied nothing
  passed every check. Absence and disagreement must be the same answer.
- **A caller that can choose both sides of an equality proves nothing by
  satisfying it.** R2 let the reauthentication START accept the connection,
  issuer, organization and subject it would later be compared against. Starting
  facts are now derived server-side from the live local session; a caller may
  state a belief, and a disagreement refuses.

## Sharp edges for the next implementer

- **The role-bindings effectiveness guard is a BUILD-TIME DRIFT GUARD, and these
  spellings still get past it.**
  `scripts/check-role-binding-effectiveness.ts` exists to stop a second,
  hand-written copy of the three effectiveness conditions from being written —
  the shape of three R3 defects — and that class it catches. It is **not** a
  runtime control and it is not adversary-proof. Every runtime predicate it
  protects is independently pinned by mutation-killed tests; the guard's job is
  to make accidental drift fail the build, not to make deliberate evasion
  impossible. Its own header states what it can and cannot read; this is the
  residue that survives, so that no one takes the header for a security
  boundary.

  The R3 closeout (L1–L3) enumerated eleven bypasses of the rules as shipped.
  **Six are closed**, each with a fixture in
  `architecture/fixtures/role-binding-drift/` that fails the suite if it stops
  biting:

  | bypass                                                              | status                                                           |
  | ------------------------------------------------------------------- | ---------------------------------------------------------------- |
  | De Morgan negation — `NOT (x AND ${…})`                             | **closed** — every enclosing group is examined (`evasion-w`)     |
  | `(${…}) IS NOT TRUE`, `IS FALSE`, `IS NULL`, `IS DISTINCT FROM`     | **closed** — a comparison applied to the predicate (`evasion-w`) |
  | a SQL line comment between the predicate and an `OR`                | **closed** — comments are stripped before judging (`evasion-u`)  |
  | a SQL block comment doing the same                                  | **closed** — same (`evasion-u`)                                  |
  | the predicate placed in the SELECT list, filtering nothing          | **closed** — counted as no use, named under rule 3 (`evasion-v`) |
  | the predicate interpolated twice into ONE read, paying for a second | **closed** — a use is bound to the read it follows (`evasion-t`) |
  | a CASE arm — `CASE WHEN ${…} THEN TRUE ELSE TRUE END`               | **open**                                                         |
  | array assembly by `unshift`                                         | **open**                                                         |
  | array assembly by `splice`                                          | **open**                                                         |
  | array assembly by index assignment — `parts[0] = …`                 | **open**                                                         |
  | `Object.keys(FRAGMENTS).join('')`                                   | **open**                                                         |

  **The five that remain, and why they were not closed.** The CASE arm is
  arbitrary boolean rewriting: rule 3 reads the text around the resolved
  predicate and does not evaluate SQL, so a predicate whose result is computed
  and then discarded reads exactly like one that filters. Closing it means
  parsing SQL, which is a larger change than this closeout is allowed to make
  and a poor trade for a guard whose class of concern is accidental drift. The
  four assembly spellings are the same limitation in the static evaluator, which
  models `push` and not the mutating array operations, and object VALUES and not
  object KEYS; they are already declared in the guard's own "WHAT IT CANNOT SEE".
  All five are visible in review: each requires writing the SQL in a way no
  statement in this repository is written.

  **One further residue, from L1.** Rule 4 reports a table position it cannot
  resolve only when the statement carries a second structural mark — a clause
  keyword, or a SELECT list immediately before the blind `FROM` — because one
  mark alone would report `update ${label}` in prose. The SELECT-list form was
  added here: an unguarded full-table read (`SELECT id, role FROM ${table}`)
  carries no clause at all and used to be reported nowhere, while the same read
  with a `LIMIT` was reported. A blind table position with **neither** mark —
  `DELETE FROM ${table}` alone, or `INSERT INTO ${table} SELECT … FROM
audit_events` — is still not reported. Neither is a read, which is what the
  effectiveness rule governs.

- The policy engine writes an evidence row for **every** decision. High-volume
  read endpoints therefore write one row per request; if that becomes a load
  problem, the fix is batching or sampling _denials-plus-sensitive-allows_,
  never dropping evidence silently.
- `rooftop_id = location_id` is load-bearing. Renaming or regenerating rooftop
  ids breaks scope resolution for every historical row.
- Resource-scoped denials must keep rendering the not-found envelope. A
  well-meaning "clearer" 403 would reintroduce resource enumeration.
- `GET /auth/session` is a **bounded** contract with a test that asserts its
  exact key set. Adding a field is a deliberate act, not a convenience.
- Migration checksums are canonical **git-blob** values. See
  [DATA-DICTIONARY.md](DATA-DICTIONARY.md#migration-checksums-canonical-values).
- **`withTransaction` ABANDONS its body when the connection is lost — it does not
  cancel it.** R3 made a Postgres FATAL on a checked-out client fail its request
  promptly by racing the loss against the body, and that changed a caller
  contract in a way worth stating outright: `withTransaction` can reject **while
  `fn` is still running**, and a Promise cannot be cancelled, so the body's
  continuation keeps executing after the caller has been told the operation
  failed. What that can and cannot cost:
  - **Database work cannot leak.** The client is destroyed on release, so every
    later statement on `tx` fails and nothing the body had written is committed.
  - **Non-database side effects still complete** — an outbound HTTP call, a cache
    write, an in-memory mutation, an enqueued job. They run _after_ the failure
    was reported, and nothing awaits them or reports their outcome. Measured by
    the `abandoned-body` probe (`tests/support/pool-fatal-child.ts`): the caller
    was told at 463 ms, all three of the body's side effects ran at 2,054 ms, and
    the statement the body issued afterwards was refused. No unhandled rejection
    occurs — the body's promise is still one of the racers, so its later
    settlement is observed.

  The rule this puts on callers is the one post-commit work already followed for
  independent-failure reasons: **do best-effort non-database work after the
  commit, not inside the body.** Work that must not happen when the operation
  failed — an outbound notification, a payment call — does not belong in a
  transaction body at all.

  Recorded here rather than in a runbook because no operator action attaches to
  it: an operator sees the retryable 503 and the `connection_lost_in_transaction`
  log line, and both behave as documented. The audience is whoever writes the
  next transaction body, and this is the document they are told to read first.
  The contract is also stated on `withTransaction` itself, and
  `tests/identity-boundary.test.ts` (`I2(ii)`) fails if either write-up
  disappears.

- **A lost-connection log line does not always carry a SQLSTATE.** One broken
  connection can be visible twice — the Postgres FATAL and the socket reset are
  the same failure — and the first observation is the one reported. Under a
  concurrent burst that is sometimes the bare socket reset, which carries no
  SQLSTATE (measured by the R3 review: 2 of 20 requests with `PGPOOL_MAX=3`, 20 concurrent transactions and a
  300 ms idle bound). A genuinely severed socket carries none at all either.
  Those requests are still typed, still 503, still retryable — the missing field
  is diagnostic only, so `DatabaseConnectionLostError.pgCode` is documented as
  best-effort and the **class** is the contract to branch on. Guaranteeing the
  SQLSTATE would mean holding every lost-connection rejection open to wait for a
  second observation that may never arrive, giving back the prompt failure the
  mechanism exists to provide.

  **The field is empty in that case rather than merely undocumented** (R3
  correction K2). It used to be neither: `sqlStateOf` accepted any five
  alphanumerics off `err.code`, and `EPIPE` is exactly five upper-case letters,
  so a broken pipe was reported as `pgCode: 'EPIPE'` — a value that matches no
  SQLSTATE an operator can filter on. The sentence above was false for that
  shape as shipped. `sqlStateOf` now accepts a code only when it is five
  characters of `[0-9A-Z]` whose first two are a class PostgreSQL defines:
  `ECONNRESET` and `ETIMEDOUT` fail on length, and `EPIPE` fails because `EP` is
  not a SQLSTATE class. The `severed-socket` scenario in
  `tests/support/pool-fatal-child.ts` tears down a real socket under a
  checked-out client and asserts the field is absent, so the sentence is checked
  rather than asserted.
