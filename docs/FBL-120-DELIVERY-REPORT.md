# FBL-120 — Appraisal, Trade, Pricing and Desking

**The order.** Master Blueprint **Version 3.1** §14.3 Part B, committed in this repository at
[`docs/orders/Car_Dealership_Management_and_Sales_Cloud_Master_Blueprint_v3.1.docx`](orders/Car_Dealership_Management_and_Sales_Cloud_Master_Blueprint_v3.1.docx),
107,070 bytes, sha256 `c57894f4c0018e7d36afc3e7255eeb17d80b2b3899d5ba44ebd1956a1ee93979`. Its
seven acceptance rows were quoted out of those bytes into
[`docs/FBL-120-ACCEPTANCE-ROWS.json`](FBL-120-ACCEPTANCE-ROWS.json) **before migration `065`
existed**, and `scripts/check-fbl120-rows.ts` refuses a row that reaches PROVEN without naming
a test this repository declares.

**What this phase is.** The desk file opened from Release Train 4's one handed-on fact, the
trade unit and the versioned evidence about it, the rule book every figure is computed under,
the deterministic priced versions themselves, and the attributable manager decision that
freezes exactly one of them. It ends at an immutable approved version that is READY for the
deal jacket.

**What this phase is not, structurally rather than by convention.** There is no `sales`,
`deals`, `deliveries`, `deal_jackets` or `sold_inventory` table in this schema —
`tests/desking-authority.test.ts` asserts their absence rather than trusting the code not to
write them. Migration 063's `ck_attribution_pre_sale_revenue` is **still in force**: migration
064's header predicted that FBL-120 would relax it, and that prediction was wrong. An approved
scenario is a priced proposal a manager signed off; no money has moved and no contract exists,
so attribution revenue taken from one would be a forecast wearing an accounting record's
clothes. Whoever builds FBL-160 relaxes it, when funds actually move.

## Money is an integer, everywhere

Release Train 4 carried no money column at all and said so. This is the phase where the
figures arrive, and every one of them is an integer in minor units:

- **Amounts** are `*_cents BIGINT`, exactly as migration 062's `stock_prices` stores them.
- **Rates** are `*_ppm BIGINT` — parts per million, so 6.5% is `65000`.
- **Rounding** is half away from zero, applied once per line item and never to an
  intermediate, because rounding twice is how two correct calculators disagree by a cent.
- **Nothing is a `number`.** `packages/desking/src/money.ts` is the only arithmetic in the
  phase, `packages/desking/src/calculator.ts` is a pure function over it, and
  `tests/desking-calculator.test.ts` runs the same inputs twice and demands the same digest.

The monthly figure is the annuity formula written out in fixed-point integers rather than
called from a library, because every floating implementation of `(1 + r)^n` returns something
a hair different on a different machine. Its value is checked against a fifty-digit decimal
evaluation, not against whatever this implementation happened to return.

**Money crosses HTTP as a decimal string of cents.** `"4550000"` is $45,500.00. JSON has no
bigint and a float loses the cent a customer notices, so `centsField` is the only place that
parses one and `serialise` the only place that writes one — and `serialise` runs INSIDE the
idempotent work, because the idempotency layer persists the body it is handed.

## The seven rows

**Row 1 — Canonical intake.** A desk file is opened FROM the `desking_handoffs` row Release
Train 4 wrote, and the rooftop, customer and selected car are copied from that fact rather than
joined from the opportunity as it stands now — the desk has to answer "what was handed over",
not "what does the pipeline say today". Two unique keys make it exactly once: unique per
opportunity, and unique per fact. Convergence is built three times over — an advisory lock with
a pre-check, `ON CONFLICT DO NOTHING`, and a raced re-select — and
`tests/desking-intake.test.ts` runs two genuinely concurrent intakes rather than reasoning
about the SQL. A fact at a rooftop the caller does not work answers `not_found` in the same
words a fact that never existed gets.

**Row 2 — Appraisal evidence.** Identity is one row; evidence is many versions. Ownership,
relationship, odometer and its status, condition grade, provenance, damage, equipment,
observations, attachments and outside quotations all hang off a version with a recorder and an
instant. `appraisal_versions` carries no UPDATE grant and a trigger that refuses one anyway, so
a probe that steps round the service still cannot rewrite a walk-around. A quotation says a
number or says `NOT_YET_AVAILABLE` — `ck_quotation_value_iff_quoted` makes both-at-once
unrepresentable — and a `certified_provider` is refused outright, because none is integrated
and a simulator wearing that label is exactly the fabrication the row forbids.

**Row 3 — Deterministic scenarios.** The order of operations is fixed and written down: trade
equity, then the taxable base (whether a trade reduces it is a `policy` rule, not arithmetic),
then taxes and fees against the price or the base, then the subtotal, then everything written
against the total, then the amount financed, then the monthly figure. Negative equity ADDS to
the balance, which is most customers. `input_fingerprint` covers the inputs AND the exact
`(rule id, version)` list applied; `output_fingerprint` covers the figures.

**Row 4 — Rule and source truth.** Every rule names a source, a jurisdiction, an optional
rooftop scope, an effective interval and a version. Overlap is refused by the DATABASE:
`uq_desking_rules_no_overlap` is a GiST exclusion constraint, so a rule book that could answer
twice cannot be written in the first place, and `tests/desking-rules.test.ts` proves it with
the service stepped round. **Missing and expired are different answers** — a jurisdiction
nobody configured and one whose schedule ran out need different things done about them — and
pricing refuses on either rather than quietly pricing a deal at zero tax. What a version was
priced under is COPIED beside it at application time, so a rule superseded tomorrow cannot
change what a manager approved today.

**Row 5 — Manager approval and freeze.** A decision names an eligible manager, the exact
version reviewed, an immutable decision time, and a reason when it is a refusal. The caller
passes back the `output_fingerprint` they were looking at; the service compares it and
`trg_scenario_approvals_bind_reviewed_version` compares it again, so approving a screen that
has since been rebuilt is refused by the database rather than accepted by the UI.
`trg_desking_scenarios_freeze` refuses an edit to any figure on any version and allows an
approved one to move only to `superseded`.

**Row 6 — Lifecycle and oversight.** draft → submitted → approved / rejected / expired, and
approved → superseded. `uq_scenario_one_approved_per_case` is a partial unique index, so ONE
current approved version per opportunity is the database's rule; approving a successor
supersedes its predecessor in the same transaction, and supersession changes the predecessor's
STATE and nothing else — its figures, its fingerprints and its own decision row are exactly as
they were. The manager's board is one read in one transaction carrying versions, pending
approvals, appraisal variance, source freshness and the exceptions somebody must act on, across
exactly the rooftops that person works. Gross, revenue, commission, close rate, ROI, the deal
record, sold inventory and delivery all answer `NOT_YET_AVAILABLE`, and the board says so in
as many words rather than leaving a blank column to be read as a zero.

**Row 7 — Integrity, UI journey, and delivery proof.** Tenant and rooftop isolation is proved
one layer below HTTP, through a genuine `dealership_app` connection with the attacking
statements written WITHOUT tenant predicates, across all fourteen tables migration 065 adds.
Exact-parent binding is proved per route, and every 404 probe is paired with the SAME request
through the RIGHT parent so that a refusal cannot be a mistyped URL. A role denial on a
resource-typed action answers 404 rather than 403, in the words a record the caller cannot see
would get.

## What the registries carry, and what they deliberately do not

`scripts/mutation-kill.ts` gains sixteen FBL-120 entries and
`scripts/database-control-mutations.ts` gains nine, each naming the test that dies when the
control is removed.

**One control is deliberately NOT declared as a runtime mutation, and the registry says why in
place of an entry.** `openDeskingCaseWithin` converges through three independent guards, and
each one alone produces the correct answer — so no honest single-line mutation of it can die.
A mutation that can never kill reads as coverage while proving nothing. Convergence is proven
instead by the race in `tests/desking-intake.test.ts`, which runs it for real, and by the
database key declared in the control registry.

**Four database controls are backstops the services check first** — the desk file per fact and
per opportunity, the appraisal per file, one approved version per file, one decision per
version. Rather than delete the controls or weaken the services, one probe steps round every
service and proves all four refuse duplicates by name.

## The seam back to Release Train 4

`packages/sales/src/desking-seam.ts` is the whole of what this phase reaches into the sales
train for: read the fact, and say the desk now holds it. Migration 064 shipped
`desking_handoffs.desking_status` pinned to `NOT_YET_AVAILABLE` by `ck_desking_pre_fbl120`
because the desk did not exist and pretending otherwise would have been a lie told to every
reader of the table. Migration 065 takes the pin off and grants UPDATE on that one column.
Nothing else in Release Train 4 changed — no opportunity, no visit, no demonstration, no
rotation — which is the same shape as the single additive seam RT4 added to `@dealer/crm`.

## Closure

**FBL-120 is CLOSED.** PR #17 was merged into `main` at
`cdefde8b2e151420d71af7bfa339f48b9d13bedd` (parents `eae4454` and `49e261a`) as a true merge
commit: `git diff 49e261a cdefde8` is empty and both name the tree object
`2d9adfce77b7f54235c8d7bbea150975d969effa`. The exact tested head `49e261a` carried CI run
33970083369 (#93), green 4/4 — after `f8669d0`'s own run 33969448701 (#92) failed the quality
ratchet (four JSON files written by scripts rather than prettier) and the full-history secret
scan (the isolation battery's throwaway test password), both corrected in `49e261a` and both
disclosed in the final-state record rather than tidied away.

**Migration `065` is FROZEN** at canonical-LF sha256
`e20987f966a9e6a6e6a0356caba13f1f0d6d4a87d8b64c4f5d84157a354a9b60`, pinned in
`architecture/migration-fixture-chains.json` and enforced by the migration ledger's checksum
refusal. Migrations `000–064` are byte-for-byte as Release Train 4 left them: `git diff
eae4454 cdefde8 -- migrations/` reports exactly one line, the addition of `065`.

The next phase is FBL-140 — Deal Jacket, Documents and E-Sign Evidence — and its schema begins
at migration `066`.
