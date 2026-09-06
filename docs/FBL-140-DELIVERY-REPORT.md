# FBL-140 — Deal Jacket, Documents and E-Sign Evidence

**The order.** The architect's FBL-140 order, issued under Standing Architect Order SO-001 of
Master Blueprint **Version 3.1** and committed VERBATIM at
[`docs/orders/FBL-140-ORDER.md`](orders/FBL-140-ORDER.md). Its eight locked outcomes were quoted
out of that file's own bytes into
[`docs/FBL-140-ACCEPTANCE-ROWS.json`](FBL-140-ACCEPTANCE-ROWS.json) **before migration `066`
existed** (commit `9f651d9`, which holds the order, the rows at LOCKED and the gate, and nothing
else), and `scripts/check-fbl140-rows.ts` refuses a row that reaches PROVEN without naming a test
this repository declares — or whose quotation is not the order's own words.

**What this phase is.** The deal jacket opened FROM exactly one manager-approved FBL-120 desking
version, the checklist resolved from versioned and effective-dated configuration, the package
assembled from canonical records with every figure the approved version's own integer cents, the
documents rendered deterministically into content-addressed immutable artifacts, the signing
ceremony that binds signers, consent, intent and signatures to exactly one package hash, and the
five distinct lanes — salesperson, manager, customer signer, administrator, provider callback —
that keep them from acting as one another. It ends at a signed, certified, supersedable package
that is READY for the later limited F&I and funding workflow. It is not that workflow.

**What this phase is not, structurally rather than by convention.** There is still no `sales`,
`deals`, `deliveries`, `sold_inventory`, `fundings`, `payments`, `credit_applications` or
`title_registrations` table — `tests/jacket-authority.test.ts` asserts their absence. Migration
063's `ck_attribution_pre_sale_revenue` is **still in force**: a signed package is evidence that
people signed documents, which is a fact about documents; no money has moved, no car has moved,
and no revenue exists to attribute. Whoever builds the funding phase relaxes it, when funds
actually move.

**What this phase does not pretend.** The e-sign provider is a deterministic simulator and every
ceremony names it as `deterministic_simulator`; no DocuSign, Adobe Sign or notary service is
integrated, and the callback lane, event ledger and replay refusal are real while the provider
behind them is not. The sample templates are `unapproved_sample` by default, say so in their
`source`, say so on every page they render, and can be called `approved` only by an accountable
manager with an approval reference — `ck_template_approval_is_attributed` refuses the alternative
at the table. No legal form was invented and none is claimed to be jurisdictionally approved.

## The seam back to FBL-120

`packages/desking/src/jacket-seam.ts` is the whole of what this phase reaches into the desk for:
`getApprovedDeskingVersionWithin` reads the approved version with the trade at its current
evidence version, the approval that froze it and the exact `(rule id, version)` list it was priced
under; `currentApprovedFingerprintWithin` answers whether the desk still stands behind what the
jacket bound; `approvedDeskingCasesWithin` is the discovery list. Nothing in `@dealer/desking`
changed — no scenario, no appraisal, no rule, no decision — which is the same shape as the one
seam FBL-120 added to `@dealer/sales` and Release Train 4 added to `@dealer/crm`.

## Money is still an integer, and now it is copied rather than computed

FBL-120 was the phase where figures arrived. This is the phase where they are COPIED: every
financial field on a package is the approved scenario's own `BIGINT` cents with its own currency,
read through the seam at assembly time and written to `package_fields` with the source table, row
and version it came from. `tests/jacket-assembly.test.ts` compares each one to the desk's own row,
cent for cent, and checks that the stored integer is the desk's integer. The renderer receives a
bigint and writes `$45,500.00 USD`; it never receives a float and never writes one.

## The eight outcomes

**Outcome 1 — Canonical intake and identity.** A jacket is opened FROM the desk's approved version
through the seam, and it copies the rooftop, legal entity, opportunity, party, stock item, trade
evidence version, approved scenario version, its `output_fingerprint` and the approval that froze
it. `jacket_source_bindings` then names EVERY canonical row and the version it carried at that
instant — party, vehicle, stock item, legal entity, rooftop, appraisal version, scenario, approval,
and each rule — so "what was this built from" is answered with versions rather than with a join to
whatever those rows say today. Two keys make it exactly once: unique per approved version, and one
active jacket per desk file by partial unique index. Convergence is built three times over — an
advisory lock with a pre-check, `ON CONFLICT DO NOTHING`, and a raced re-select — and
`tests/jacket-intake.test.ts` runs two genuinely concurrent intakes rather than reasoning about the
SQL. A file at a rooftop the caller does not work answers `not_found` before it is opened and after,
in the same words a file that never existed gets. When the desk approves a NEWER version, the
jacket is stale: the board says so, assembly refuses with `stale_source` naming the current
version, and a manager voids the jacket so a new one can bind the successor — on the record.

**Outcome 2 — Versioned checklist and document requirements.** Templates, requirements and
retention policies share one shape: a code versioned by a new ROW, scoped by jurisdiction and
optionally by legal entity and rooftop, bounded by an effective interval, and refused by a GiST
exclusion constraint when two versions would be in force over one instant —
`tests/jacket-checklist.test.ts` proves it with the service stepped round. Specificity is decided
once: a rooftop's row beats its legal entity's, which beats the tenant's; an exact transaction type
beats `any`. A jacket's checklist copies each requirement's code, version and source at the instant
it opens. Missing required items block `review_ready` by name. A waiver is four things or it is
nothing — actor, reason, policy version, evidence — only an eligible manager makes one, and
`ck_checklist_waiver_complete` refuses three of the four, or a waiver on a requirement not
configured as waivable, at the table. A configured version is ended, never edited: recording the
next version may close the one in force at its own start (`closesPredecessor`), the one column the
runtime may move on a configuration row.

**Outcome 3 — Deterministic package assembly.** Every field is read from the row that owns it —
scenario, appraisal version, party, vehicle, stock item, legal entity, rooftop, rules — sorted by
code and digested in canonical form into `fields_sha256`, so the same inputs produce the same
digest on any machine and a second assembly that changes nothing writes no version
(`already_current`). Nobody types a figure; the only things a person types in the whole phase are
an evidence URI and its digest, template text, and a hold reason.

**Outcome 4 — Immutable rendering and artifacts.** Rendering is a pure function: the template body
with each `{{field.code}}` replaced by the field's escaped words, wrapped in the smallest HTML that
reads as a document, with no timestamp, no request id and no random anything — the same bytes twice,
and `tests/jacket-assembly.test.ts` demands the same digest. `document_blobs` is keyed by the
sha256 of its own bytes and a trigger recomputes the digest on insert, so a row whose key lies about
its content cannot exist. Each `package_documents` row binds the package version, the template
version and its digest, the content hash, MIME type, byte size, classification, malware-scan
result (`not_scanned`, honestly — no scanner is integrated), retention policy code and version, and
legal-hold state; migration 066's triggers refuse every edit but a scan completing or a hold moving.
A changed input writes the NEXT version carrying `supersedes_package_id`; the earlier version keeps
every field, every rendered byte and every signature, and moves to `superseded` — the one column on
it that moves at all. A placeholder nobody filled is a render failure recorded where the board can
see it, not a blank on a contract.

**Outcome 5 — E-sign ceremony and evidence.** Sending is a manager's act. It creates ONE ceremony
per package version, bound to the package hash, and seats the signers in their lanes: the customer
through a random token stored only as its digest and delivered to the PROVIDER — not to the staff
response, not to the outbox, not to a log — and the dealer's representative through the staff
session of the manager who sent it. A signature is four instants in order — viewed, consented to
a versioned consent text, intent confirmed, signed — and `ck_signer_signature_complete` refuses
fewer. The signing page sends back the hash it displayed; the service compares it to the bound
hash and `trg_ceremony_signers_bind_signature` compares the package's digest and state again, so a
superseded or voided package takes no signature however the service is stepped round. Signing
order is enforced: the customer first, the dealer last, and only the signer row that names the
acting user link can be signed through the staff lane. Completion renders the certificate — every
signer, instant and digest, in canonical form — into a content-addressed blob whose digest is
written onto the ceremony; anyone with the bytes can re-hash them. Provider callbacks are verified
by HMAC-SHA256 over the raw body under a configured secret, refused before they are read when the
signature fails or no secret is configured, recorded once by the provider's own event reference
(`UNIQUE (tenant_id, provider_event_ref)`; the second delivery converges and answers
`replayed`), bound to the envelope the ceremony recorded, and reconciled against our own ledger —
a claim our evidence contradicts is recorded as a disagreement and changes no state.

**Outcome 6 — Lifecycle and operational exceptions.** draft → review_ready → sent →
partially_signed → signed_complete, with voided, expired and superseded final; a signed package
goes nowhere but `superseded`, and `trg_jacket_packages_freeze` holds that for every role. Expiry
is the worker's act through the SYSTEM lane with no user (`jacket.ceremony.expiry`, driven in
`tests/jacket-lifecycle.test.ts` through `runAllJobsOnce`, the exact function `--once` calls, and
run twice to show the second pass finds nothing). The board carries the five queues the order
names — missing documents, render failure, rejected or expired signatures, provider failure, stale
approved-desking inputs — as counts and as per-row exceptions, and says `NOT_YET_AVAILABLE` for
sale, funding, delivery, sold inventory, accounting posting, gross, commission, revenue, credit
application, title and registration, and document disposal rather than leaving a blank to be read
as a zero.

**Outcome 7 — Authorization, isolation, and privacy.** Fifteen tables are row-secured and
`tests/jacket-isolation.test.ts` proves it through a genuine `dealership_app` connection with the
attacking statements written WITHOUT tenant predicates — including the content-addressed blob store,
which has no tenant column and is reachable only through a tenant-secured document row. The three
new resource types are registered in both resolvers with migration 062's privilege split intact.
Every child is authorized through its parent (`jacketId`, `packageId`, `ceremonyId`), and
`tests/jacket-authority.test.ts` pairs every 404 with the same request through the right parent.
Role denials on resource-typed actions answer 404, not 403. Idempotency keys replay; stale
`expected_version` conflicts. Bytes leave only through a fifteen-minute grant whose token the
database holds as a digest, counted on use, and refused after its clock (`ck_grant_short_lived`
caps any grant at twenty-four hours). The ceremony ledger, the outbox and the audit trail carry ids
and digests and never a name, an address or a link — asserted over every row the journey wrote — and
the raw signer token exists nowhere in the database. Retention is computed from the policy version
each document names; a legal hold is placed and lifted as append-only history by the dealership
administrator and flagged onto every document, including documents rendered later under the hold;
disposal is `NOT_YET_AVAILABLE` and said so. The five lanes are five different doors: the
salesperson holds no waive, review, send, void or dealer-signature; the manager holds no retention,
hold or export; the customer holds no dealership identity at all; the administrator's lane refuses
managers; the provider's lane refuses everything but a body signed under the secret.

**Outcome 8 — Real persisted user journey.** `docs/evidence/FBL-140-OWNER-JOURNEY.json` records
twenty-nine stages walked in the shipped console and the shipped signing page by FOUR different
identities — a salesperson, a sales manager, a dealership administrator and a customer who holds no
dealership identity and arrived by the link the simulated provider delivered. The salesperson opened
the jacket from the approved list and assembled it; the missing items were visible and were met;
the manager reviewed and sent; the customer read the agreement, consented and signed the exact
package hash; the salesperson's attempts to review, send and sign for the dealership were each
refused with 404; the manager countersigned and opened the certificate; the administrator placed a
hold and exported the file; the manager recorded a revised template ending the one in force; and
the salesperson re-assembled — version 2 draft, version 1 superseded with its documents, figures,
completed ceremony, both signatures and certificate exactly as they were. No internal identifier
was typed. `tests/jacket-delivery.test.ts` reads the record and requires every bullet of the
outcome to have a stage that shows it.

## What the registries carry, and what they deliberately do not

`scripts/mutation-kill.ts` gains twenty-six FBL-140 entries and
`scripts/database-control-mutations.ts` gains thirteen, each naming the test that dies when the
control is removed. Every FBL-140 anchor is ONE line, so the registry reads the same on a CRLF
working tree as on the LF tree CI checks out — the lesson of FBL-120's local-only false negative.

**One control is deliberately NOT declared as a runtime mutation, and the registry says why in
place of an entry.** `openJacketWithin` converges through the same three independent guards the
desk's intake does, and each one alone produces the correct answer, so no honest single-line
mutation of the convergence can die. It is proven by the race in `tests/jacket-intake.test.ts` and
by the two database keys declared in the control registry.

**One finding came from the control registry itself, and it was a defect in the probe, not in
the schema.** The first local run reported `two_jackets_on_one_approved_version` as FAILED CHECK:
the declared test died with the key dropped, as it should, but it kept dying after the key was
restored. The probe inserted an OPEN duplicate of an open jacket, which violates BOTH backstop keys
at once, and Postgres names whichever violated index it checks first — the older one. On a fresh
chain the unique key is older than the partial index, so the probe's regex matched; once the
registry dropped and re-added the key it became the newer index, and the error named
`uq_deal_jackets_one_active_per_case` instead. The probe row is now VOIDED, so exactly one key
can refuse it and the answer no longer depends on catalog order. The schema was never wrong; a
probe that passes only in one creation order was.

**Two findings came from CI, and neither is in this phase's code.** Run 33996033506 (#96) failed
the full-history secret scan on two WRONG-KEY probes in the callback batteries (words joined to a
26-character counting string beside the word `key` — the shape gitleaks exists to catch; the probes
are now plain words and the two historical lines are suppressed by exact fingerprint, as every
earlier suppression is) and reported one mutation INCONCLUSIVE because a Release Train 4 battery
was red before its mutation, with no detail recorded. The runner now keeps a red baseline's failing
assertion. Run 33998624901 (#97) then lost the same test in the complete battery, and the log
said why: the manager's board counts a no-show against the calendar day it was booked for, in the
database session's own day (`starts_at::date = NOW()::date`, which is UTC in CI), and the test
booked the missed appointment one hour ahead — tomorrow, in the last hour of the day. Both runs
happened to land in that hour. The test now asks the database for an instant it will call today.
**The board's choice of day — the database's rather than the rooftop's — is a Release Train 4
matter and is left exactly as it was, for the architect to weigh; this phase changed no product
code for it.**

## Verification evidence

- Complete local battery: 961 tests across 100 suites, 0 failed, 0 cancelled, 0 skipped, 0 todo
  (`scripts/parse-test-summary.ts` floors raised to 961 / 100).
- Runtime mutations: 121 declared, 121 killed, 0 survived, under green baselines.
- Database controls: 98 declared (60 whole controls + 38 predicate mutations), 98 killed, 0
  survived, unfiltered.
- Migrations `000`–`065` byte-for-byte as FBL-120 left them; `066_deal_jacket_documents_esign.sql`
  is the only addition, pinned in `architecture/migration-fixture-chains.json` at canonical-LF
  sha256 `bc4c5a3d9bec905a054b7ae8db44ce3a09eafb638e21534c3de084ca41b68494`, applied fresh and over
  the migrated chain.
- Artifact hash and signature replay proof: `tests/jacket-assembly.test.ts` (blob digests recomputed
  from bytes; a lying key refused), `tests/jacket-signing.test.ts` (certificate bytes re-hashed to
  the recorded digest; a superseded package refused a signature at the table; a provider callback
  replayed onto one row).
- Persisted multi-identity journey: `docs/evidence/FBL-140-OWNER-JOURNEY.json`, 29 stages, four
  identities, three refusals.

## Closure

**FBL-140 is CLOSED.** PR #18 was merged into `main` at
`72019f186619e49898e66f25ab33ab28133bab13` (parents `6172ba8` and `92427f8`) as a true merge
commit: `git diff 92427f8 72019f1` is empty and both name the tree object
`7ba91f2c447fe6da690772a972db21c8a9ef0caa`. The exact tested head `92427f8` carried CI run
33999774082 (#98), green 4/4 — after `8a3dd6f`'s own run 33996033506 (#96) failed the full-history
secret scan (two wrong-key probes in the callback batteries, shaped like a key) and the
mutation-kill step (one Release Train 4 battery red before its mutation in the runner's copy,
with no detail recorded), and after `b4c11b0`'s run 33998624901 (#97) lost that same Release
Train 4 test in the complete battery to the hour of the day. Both corrections are bounded to
what those runs refused and both failures are disclosed in the final-state record rather than
tidied away. The runner now keeps a red baseline's failing assertion, so a repeat will explain
itself. The merge has no run of its own; main's run on it, 34005532222 (#99),
concluded failure: failed ONLY the three final-state tests inside the complete battery ('3 recorded commit(s) are not on top of the evidence commit: 9f651d9…, 8a3dd6f…, b4c11b0…'), exactly as this gate is built to do when a true merge moves branch commits off the line it walks, with the upgrade drill, the container build and the secret scan green and the other 958 tests passing; this closeout is the correction.

**Migration `066` is FROZEN** at canonical-LF sha256
`bc4c5a3d9bec905a054b7ae8db44ce3a09eafb638e21534c3de084ca41b68494`, pinned in
`architecture/migration-fixture-chains.json` and enforced by the migration ledger's checksum
refusal. Migrations `000–065` are byte-for-byte as FBL-120 left them: `git diff 6172ba8 72019f1
-- migrations/` reports exactly one line, the addition of `066`.

The next phase, FBL-150, waits for the next architect order.
