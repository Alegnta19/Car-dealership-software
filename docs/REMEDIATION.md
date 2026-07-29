# Phase 248 — Security & Correctness Remediation

This repository was created from the `phase-248-service-cockpit-v2` bundle: one migration, one
service module, one Express router (1,523 lines). A static audit of that bundle found six
High-severity defects. This document records what each one was, how it is closed, and what remains.

**Scope:** all six High findings are fixed. Fixes that were inseparable from them are listed under
[Incidental fixes](#incidental-fixes). Everything still outstanding is listed under
[Outstanding work](#outstanding-work) — nothing has been silently dropped.

---

## H1 — Tenant isolation was not enforced

**Was.** Three compounding holes let one tenant reach another's data:

1. Primary-key reads and updates carried no `tenant_id` predicate. `getRO`, `transitionRO`,
   `updateAppointment`, `confirmAppointment`, `updateLineItem`, `updatePartLine`, `updateSubletJob`,
   `updateTicketStatus`, `submitMPISession`, `sendEstimate` and all queue operations selected purely
   by id, so any authenticated caller holding a UUID could read or mutate it.
2. The route helper resolved tenant identity as
   `req.body.tenant_id || req.tenantContext?.tenantId` — a **client-supplied value took precedence
   over the authenticated one**. Every INSERT path could therefore stamp rows with an arbitrary
   tenant.
3. Child-row inserts took `:roId` straight from the URL. `addLineItem`, `requestPart`,
   `createSubletJob`, `startMPISession`, `generateEstimate`, `sendRecommendationsToCustomer` and
   `createWarrantyClaim` never checked the repair order was the caller's — so a guessed id let
   someone attach work to, and advance the status of, another tenant's RO.

**Now.**

- `authenticate` (`src/shared/middleware/auth.ts`) derives `tenantId` and `userId` from the verified
  bearer token and nothing else. `tid()`/`uid()` are gone; handlers call `requireContext(req)`.
- `rejectTenantOverride` runs on every request: a body or query `tenant_id` that disagrees with the
  token is a 403 `tenant_mismatch`. Echoing the matching value is allowed.
- Every service function takes `ctx: AuthContext` as its first argument and carries `tenant_id` in
  every `WHERE` clause.
- `assertRO`, `assertLineItem` and `assertLineItemsOnRO` are the ownership proofs every `:id`-scoped
  write runs first, inside the same transaction. Cross-tenant misses raise `NotFoundError`, not
  `ForbiddenError`, so the API never confirms that another tenant's row exists.

**Covered by tests:** `tests/auth.test.ts` — tenant comes from the token; mismatched body and query
`tenant_id` are refused; a matching echo is accepted.

---

## H2 — No authorization layer

**Was.** `authorize` was imported and applied to zero of the routes. Any authenticated principal —
technician, viewer, anyone — could record customer authorizations, transition repair orders, escalate
queues, or file warranty claims.

**Now.** Every route is `authenticate` + `authorize(...roles)`. `platform_admin` implicitly passes
all checks; a principal with no roles passes nothing.

| Capability | Roles |
|---|---|
| Read dashboards, ROs, queues, templates | all service roles incl. `service_viewer` |
| Appointments, ROs, estimates, authorizations, comebacks, retention | `service_advisor`, `service_manager` |
| MPI, line-item progress, work tickets, time, queue assignment | `service_technician`, `service_advisor`, `service_manager` |
| Parts and sublet | `parts_clerk`, `service_advisor`, `service_manager` |
| Warranty claims | `warranty_admin`, `service_advisor`, `service_manager` |
| Queue escalation | `service_manager` |

Work tickets add a second check beyond the role: `assertOwnTicket` lets a technician act only on
tickets assigned to them, while advisors and managers may act on any.

**Covered by tests:** `tests/auth.test.ts` — permitted role passes, wrong role gets 403, roleless
principal gets 403, admin passes everything, `authorize` without `authenticate` gets 401.

---

## H3 — `step_up_token` was accepted but never validated

**Was.** The transition endpoint destructured `step_up_token` and passed it to the service, whose
signature declared it — and whose body never referenced it. Sensitive transitions had no step-up in
practice.

**Now.** `src/shared/security/step-up.ts` mints and verifies HMAC-SHA256 tokens bound to **tenant,
user, action and resource**, with a short expiry (default two minutes) and constant-time signature
comparison. A token minted for one repair order cannot be replayed against another, and one minted
for one user cannot be used by another. Verification failure is a hard 403 `step_up_required`. The
medium/low round additionally made tokens single-use via a consumption ledger.

Required for: `ro.transition:authorized`, `ro.transition:canceled`, and
`authorization.record:staff_attestation`.

**Covered by tests:** `tests/step-up.test.ts` — eight cases covering each binding field, expiry,
payload tampering, and malformed input.

---

## H4 — No database transactions

**Was.** Every statement ran independently on the pool. `checkIn` performed five writes, `recordAuthorization`
up to four, `submitMPISession` N+2, `createComebackCase` three. A mid-sequence failure left the
aggregate half-written, with no rollback.

**Now.** `withTransaction` (`src/shared/database/pool.ts`) runs a unit of work on one dedicated client
inside `BEGIN`/`COMMIT`, rolling back on any throw. Every multi-write operation uses it.

Two rules follow from Postgres semantics and are load-bearing:

- **Domain events commit with their change.** `recordROEvent` and `recordAppointmentEvent` run on the
  transaction executor and are *not* wrapped in try/catch. An RO cannot move without its event.
- **Best-effort work happens after the commit.** `emitAudit` and all metric updates run on the pool
  once the transaction has committed. A failed statement aborts the whole Postgres transaction, so a
  swallowed error inside one would have poisoned the very commit it was meant to describe.

---

## H5 — `checkIn` was unguarded and non-idempotent

**Was.** It loaded the appointment without checking its status, so canceled, completed or
already-converted appointments could be checked in. It never looked for an existing repair order, so
calling it twice produced **two repair orders and two queue items** for one visit.

**Now.** `checkIn` runs in a transaction that:

1. locks the appointment row (`SELECT … FOR UPDATE`) scoped to the tenant;
2. returns the existing repair order — flagged `idempotent_replay: true` — if the appointment already
   produced one;
3. otherwise requires the appointment to be `requested`, `scheduled` or `confirmed`, and raises 409
   `invalid_appointment_status` if not;
4. creates the RO, converts the appointment, writes both events and the queue item as one unit.

Migration 049 makes `idx_ro_appointment` a **UNIQUE** partial index, so two concurrent check-ins on
separate connections cannot both create an RO for the same appointment.

The redundant intermediate write (setting the appointment to `checked_in` and immediately overwriting
it with `converted_to_ro`) is gone; the `checked_in` fact is recorded as an appointment event.

---

## H6 — Customer authorizations were forgeable, and the state-machine gate was vacuous

**Was.** The most serious finding. `recordAuthorization` inserted every record with a hardcoded
`status='approved'` — even when `approved_items` was empty and the customer declined everything — and
its line-item updates ran `WHERE line_item_id = ANY($1)` with **no `ro_id` and no `tenant_id`
filter**, so caller-supplied UUIDs flipped authorization status on line items belonging to any repair
order in any tenant. Because `transitionRO`'s gate only checked that *some* approved authorization
row existed, any authenticated caller could manufacture the approval that unlocks paid work, and the
unvalidated `step_up_token` (H3) provided no backstop.

**Now.** `recordAuthorization` is defensive end to end:

- the estimate must belong to **this** repair order and must be in `sent` status;
- `approved_items` and `declined_items` must be UUIDs, must not overlap, and must cover at least one
  line; **every id is verified to belong to this RO** and unknown ids are rejected with the offending
  list, never skipped;
- the record's status is **derived** by `deriveAuthorizationStatus` — approved only if the customer
  approved at least one line, so an all-declined decision is stored as `declined`;
- line-item updates are scoped `AND ro_id = … AND tenant_id = …`;
- the parent estimate is moved to `approved`, `partially_approved` or `declined` to match;
- `staff_attestation` — staff asserting approval with no customer-produced artifact — requires a
  step-up token.

`transitionRO`'s gate now requires an authorization that is `status='approved'`, has a non-empty
`approved_items` array, **and references the latest estimate version** for that RO. An approval of
estimate v1 no longer authorizes the work priced in v3.

**Covered by tests:** `tests/authorization.test.ts` — including the explicit regression that an
all-declined decision derives `declined`.

---

## Incidental fixes

Changes the six fixes could not be made without, or that were one line inside code being rewritten.

| Fix | Why it came along |
|---|---|
| **Index-name collision.** `idx_roe_ro` was declared on both `ro_events` and `ro_estimates`; under `CREATE INDEX IF NOT EXISTS` the second was a silent no-op, leaving `ro_estimates` with no secondary index. Renamed to `idx_roest_ro`. | The migration had to be correct for the repo to run. |
| **`transitionRO` race.** Read-validate-write with no lock and no status guard in the UPDATE. Now runs under `FOR UPDATE` with the source status re-asserted in the `WHERE`; a lost update surfaces as 409 `concurrent_modification`. | Same transaction work as H4; leaving the race after adding the lock would be perverse. |
| **Estimate version race.** `MAX(version)+1` with no constraint. Now serialized by the RO row lock, with `UNIQUE (ro_id, version)` as the backstop. | Same. |
| **`sendEstimate` ownership.** It matched on `estimate_id` alone, so a mismatched pair marked estimate X sent while advancing unrelated RO Y. Now scoped by `ro_id`. | One clause in the tenant-scoping sweep. |
| **Queue items with empty `location_id`.** `sendEstimate` passed `location_id: ''` into a `UUID NOT NULL` column. Now carries the RO's real location. | The statement was being rewritten regardless, and `''` is not a valid UUID. |
| **Portal task identity.** `sendRecommendationsToCustomer` wrote into the sales domain's `deal_portal_tasks`, putting the repair-order id in the `deal_id` column. Now writes `service_portal_tasks`, owned by this domain and keyed on `ro_id`. | The external table does not exist in this repository; something had to be chosen. |
| **Blind overwrites.** Any status change nulled `pause_reason` / `block_reason_codes`. They are now written only when supplied, or cleared when the row leaves the state they describe. | Both statements were being rewritten for tenant scoping. |
| **Comeback-case guards.** Now requires the original RO to be `closed`, rejects `original_ro_id == new_ro_id` (also a DB `CHECK`), and writes an event on both repair orders. | The function was being wrapped in a transaction. |
| **Honest failures instead of false success.** `escalateServiceQueueItem` returned `runbook_created: true` without creating one, and `queryServiceCockpitView` silently ignored `overrides`. Both now reject the unsupported input. | Reporting work that did not happen is worse than an error. |
| **Metric truthfulness.** `service_comeback_rate` was set to the constant `1` and `service_retention_first_service_capture_rate` to the constant `0`; queue depth was set to a `LIMIT 200`-capped row count. The two false constants are removed and queue depth is now a real `COUNT`. | A wrong metric misleads an operator more than a missing one. |
| **Input validation.** UUID and enum validation on ids, statuses, methods, severities and timestamps; `occurred_at` on time entries may back-date but not post-date. | Needed so scoping predicates cannot be fed non-UUID or unexpected values. |
| **Schema integrity.** FK added on `service_recommendations.ro_id` (the only unconstrained `ro_id`); indexes added for six previously unindexed FK columns; range `CHECK`s on `quantity` and hours; `customer_language_used` constrained. | Free while the migration was open, and all pure additions. |

---

## Post-review corrections

The remediation above was then put through a 48-agent adversarial review (four lenses — tenancy,
authorization, atomicity, regressions — each finding independently confirmed or refuted by two
further agents). Twenty-one findings survived. The substantive ones are fixed here; each is listed
because a fix that introduces its own holes is not a fix.

**Two of the findings were holes in the H6 fix itself:**

- **`addLineItem` accepted a caller-supplied `authorization_status`.** `updateLineItem` was hardened
  to refuse that field, but the create path still wrote it verbatim — so a caller could simply
  create a line already stamped `approved`. Both paths now refuse `authorization_status` and
  `authorization_ref` with 403; a new line always starts `not_required`.
- **A technician could reopen a declined line.** `status` remained freely writable on the shop-floor
  PATCH, so work the customer declined could be set back to `proposed` and swept into the next
  estimate. A line whose `authorization_status` is `declined` now rejects any status change.

**Authorization and identity:**

- **`exp` is now mandatory on bearer tokens.** It was honoured only when present and numeric, so a
  token minted without one was a permanent credential.
- **Malformed token payloads no longer reach property access.** `JSON.parse("null")` returns `null`
  without throwing, and the `alg` check sat outside the parse guard — an unauthenticated caller
  could force a 500. Header and payload must now both be objects.
- **Step-up is no longer avoidable by naming a different method.** Step-up applied only to
  `staff_attestation`, so sending `method: 'portal'` skipped it and nothing required proof the
  portal was involved. Methods that claim a customer-produced artifact must now carry non-empty
  `evidence_refs`; `staff_attestation` still requires step-up. Verifying the artifact itself is out
  of scope for this service.
- **Step-up token lifetime cut to two minutes**, and (in the medium/low round) made single-use: see
  the fourth-round note below.

**Correctness:**

- **Estimate status was derived from the wrong denominator.** It used a whole-repair-order pending
  count, so an estimate could be stored `approved` while lines it covered were still undecided. The
  count is now taken *after* the decision is applied, and `deriveEstimateStatus` takes
  "lines still undecided" explicitly. Decided lines must also be `pending` when the decision arrives.
- **Three conditional status writes could silently no-op.** `generateEstimate`, `sendEstimate` and
  `startMPISession` guarded their `UPDATE` with a source-status predicate but never checked whether
  it matched, returning success either way. Each now asserts the repair order's state up front and
  fails with a 409.
- **`createRO` on an already-converted appointment returned 500.** The new unique index raised a raw
  `23505`. It is now a 409 `appointment_already_converted` naming the existing repair order.
- **`assignServiceQueueItem` was a blind overwrite.** It could resurrect a `done` item and silently
  take one already assigned to someone else. It now locks the row, refuses closed items, and reports
  409 `queue_item_taken` rather than leaving two people believing they own the work.
- **`createComebackCase` locked only one of the two repair orders**, so a crossed pair opened
  concurrently could deadlock. Both are locked, in sorted id order.
- **`sendRecommendationsToCustomer` stacked a new portal task on every send.** It now reuses an open
  one.
- **PATCH paths skipped the validation their POST counterparts performed**, turning bad input into
  500s from CHECK constraints. Appointment timestamps, language, contact channel and concerns, and
  line-item `sold_hours`, are validated on update too.
- **An unknown `view_id` could bypass the guard** via inherited keys such as `constructor`. The
  lookup uses `Object.hasOwn`.
- **`queue_type` was unvalidated and reached a Prometheus label**, giving unbounded cardinality. It
  is validated against a closed set.
- **Queue depth is no longer published from request traffic.** The gauge carries no tenant label, so
  one tenant's count overwrote another's on an endpoint scraped without a credential — and adding a
  tenant label would publish a tenant roster instead. It moved to the scheduled aggregation
  described below.

**Documentation:** the README claimed seven wired metrics; the code wired five.

Findings that were *not* acted on: the review flagged that migration 049 differs from the version in
the source bundle, which would matter to an environment that had already applied the bundle's copy.
This repository's 049 has a single revision and has never been applied anywhere, so it stands as the
authoritative schema for a fresh install — but see the note under Outstanding work.

---

## Medium and low findings

A third pass closed everything that had been carried as known-outstanding. Schema support
lives in `050_phase248_hardening.sql`, kept separate from 049 because that file is published and
may already have been applied somewhere.

**Queue items now follow the repair order.** They were created by check-in and estimate-send and
never closed by anything, so every cockpit count drifted upward forever. `syncQueueForRO` closes
items for work the RO has moved past and opens one for where it now sits; a terminal RO leaves no
open queue work. It runs inside the transaction that changed the status, and every status-changing
path calls it — so re-sending an estimate no longer stacks a second `waiting_authorization` item.

**Duplicate inspection results are gone.** `UNIQUE (mpi_session_id, item_key)` plus an upsert, so a
technician correcting a reading replaces it instead of adding a row that becomes a duplicate
customer recommendation on submit.

**Inspection severity must be stated for a finding.** It defaulted to `info`, which quietly turned a
failed safety item into a `p2` suggestion — the priority mapping and the intake path disagreed about
the taxonomy. `pass` may omit it; `attention` and `fail` may not.

**`updated_at` is maintained by the database.** A trigger on all 18 mutable tables, rather than
application discipline that any forgotten statement silently broke.

**Step-up tokens are single-use.** `consumeStepUpToken` records the `jti` in `step_up_token_uses`
inside the same transaction as the privileged write, so the token is spent exactly when the
operation commits and a rolled-back operation releases it. The primary key rejects concurrent
replays.

**Technician time is a coherent sequence.** Clock events are validated against the previous entry —
the first must be a `start`, a `stop` cannot follow a `stop`. Hours computed from the log are now
meaningful, which is what makes the technician metrics possible.

**`tech_profiles` is in use.** Work can only be dispatched to a technician with an active profile at
the repair order's location, and `scheduled_hours_per_week` gives utilization its denominator.

**All fifteen metrics are populated.** `services/metrics-aggregator.ts` computes the eleven rates,
ratios and depths on an interval over a rolling window: parts backorder rate and wait time, QC
failure rate (derived from `qc → in_repair` transitions in the event log), technician
utilization / efficiency / proficiency, SLA breach rate, recommendation conversion, comeback rate,
first-service capture, and queue depth. Series are labelled by `location_id`, never tenant, and a
ratio with no denominator publishes nothing rather than a misleading zero.

**Retention is measurable.** `first_service_offers` records the deal → appointment link that
previously lived only in a JSON blob; `checkIn` marks it converted, giving capture rate both a
numerator and a denominator.

**A quality gate exists.** `qc → ready_for_pickup` now requires every line item to be completed,
declined or canceled, so a vehicle with open work cannot be handed back.

**Declined work stays declined.** A line the customer declined refuses further status changes.

**Pagination.** `limit`/`offset` on the queue list and view query, `event_limit` on the repair-order
read, each validated and capped. The previous fixed limits made anything past the first page
unreachable.

**Estimates carry money when the lines do.** `totals_ref` sums `price_ref.amount_cents` where
present and reports `priced_line_count` / `unpriced_line_count` so a caller can always tell whether
a total is complete. Mixed currencies are rejected rather than added together. This is a reporting
convention, not a pricing engine — rates, tax and markup remain out of scope.

**Closed vocabularies.** `queue_type` and `comeback_cases.root_cause_category` were free text while
being used as grouping keys; both are now constrained in the database and validated in code.

**Quick intake does something real.** Given an `mdm_vehicle_id` it returns the vehicle's service
history from this tenant — recent repair orders, any open one, and previously declined
recommendations. It still persists nothing, and says so. VIN resolution stays with MDM.

**CSPP2 has an API.** `GET /ros/:roId/portal-tasks` and `PATCH /portal-tasks/:id`.

**Integration tests exist.** 28 tests against a real PostgreSQL instance covering what a mock cannot:
cross-tenant reads and writes, check-in idempotency and its unique-index backstop, rollback leaving
no partial state, the authorization gate against all-declined and superseded-estimate approvals,
step-up single-use replay, queue lifecycle, inspection upsert, clock sequencing, the quality gate,
the retention bridge and its rollback, the metrics aggregator's arithmetic, and trigger-maintained
`updated_at`. They skip cleanly when no database is configured, so `npm test` still works without
one.

---

## Post-review corrections, round two

A second 48-agent review (three lenses: SQL/schema, behaviour, documentation) ran over the round
above. The substantive findings are fixed here; the rest were documentation drift, corrected across
this file, the README and the architecture reference. Schema support is in `051_phase248_metrics_support.sql`.

**Two were real metric bugs of my own making:**

- **The comeback-rate denominator excluded its own numerator.** It counted repair orders *currently*
  `closed`, but opening a comeback flips the original out of `closed` — so the denominator dropped
  exactly the orders the numerator counted, reporting `k/(N−k)` and vanishing entirely when every
  closed order came back. It now counts orders that *closed in the window* from the event log, which
  a later status change cannot alter.
- **Parts wait time re-measured the same part on every status change.** It measured to `updated_at`,
  which the new trigger bumps on each progression from received to picked to installed. A dedicated
  `received_at` (set once, on first receipt) is the fixed point now, and the high-water mark advances
  to the largest `received_at` actually read rather than the wall clock, closing a skip window.

**Other corrections:**

- **Aggregated gauges are reset each pass.** A drained queue or a quiet location kept publishing its
  last non-zero reading; gauges are level readings, so every one is cleared before recomputation.
- **The technician join no longer fans out.** A technician with profiles at more than one location
  had their hours counted once per profile; capacity is now summed separately and looked up by map.
- **`createFirstServiceOffer` is atomic.** The appointment and the offer are inserted in one
  transaction, so a rejected duplicate offer no longer strands an appointment.
- **The SLA breach metric has a population.** `sla_due_at` was never written; queue items now take a
  due time from the tenant's `service_sla_defaults` (migration 051), or an explicit value.
- **`summariseMoney` is strict.** `amount_cents` of `null`, `true` or `[]` counted as a priced line
  worth zero (`Number()` makes them finite); only a real `number` is now accepted.
- **Time entries are serialised.** `recordTimeEntry` takes `FOR UPDATE` on the ticket, so two racing
  entries cannot both read the same "last" event, and an entry cannot back-date before the previous
  one.
- **Migrations 050 and 051 are idempotent.** Two `CREATE TRIGGER`s lacked a `DROP` guard and failed
  on re-run; the `mpi_results` de-dup now breaks `created_at` ties with `ctid`; and the two CHECK
  constraints are added `NOT VALID` so they do not fail against pre-existing free-text data.
- **`pruneConsumedStepUpTokens` is wired.** The step-up ledger is pruned each aggregation pass, so it
  no longer grows without bound.
- **`syncQueueForRO` covers `authorized` and `sublet_in_progress`.** Those non-terminal states had no
  queue mapping, so a repair order briefly vanished from every cockpit view while sitting in them.

---

## Outstanding work

Known and deliberately not addressed. None of it is a defect in what ships.

**Migration 049 differs from the source bundle's copy.** It gains the renamed `idx_roest_ro` index,
the unique indexes on `repair_orders(appointment_id)` and `ro_estimates(ro_id, version)`, the
`service_portal_tasks` table, an FK on `service_recommendations.ro_id`, six FK indexes and several
CHECK constraints. The migration runner keys on filename, so an environment that already applied the
bundle's 049 will not receive any of it and needs a separate forward migration rather than a re-run.
This repository's 049 has never been applied anywhere. Everything since is in 050 and 051, which are
additive.

**No QC checklist.** `qc -> ready_for_pickup` now requires all work to be closed out, but there is no
item-by-item quality checklist and no record of who signed off. The QC failure metric infers failures
from `qc -> in_repair` transitions rather than from recorded defects.

**Estimates are not priced.** Totals sum `price_ref.amount_cents` where a caller has supplied it.
There is no labour rate table, no parts markup, no tax and no discounting, so an estimate total is
only as complete as what the caller wrote onto each line.

**Concurrency is verified by construction, not by test.** The integration suite exercises rollback,
idempotent replay and the unique-index backstops, but not genuinely simultaneous writers. The row
locks and guarded updates are reviewed, not load-tested.

**`_p95` metric names.** Kept as the Phase-248 spec wrote them, though a histogram yields quantiles
at query time and the suffix is misleading.

**No `ON DELETE` behaviour.** All foreign keys remain `NO ACTION`, so deleting a parent with children
errors. This suits the append-only posture but is undocumented in the schema itself.

**No cursor pagination.** `limit`/`offset` is enough for the cockpit's page sizes but will drift on
a busy queue; a keyset cursor would be stable.

---

## Contract changes for API clients

1. **Tenant identity is taken from the token.** Sending a different `tenant_id` is now a 403 instead
   of silently switching tenants.
2. **All errors use the central envelope.** `POST /ros/:roId/transition` previously returned an
   in-band `{ success: false, error: 'invalid_transition' }`. Errors are now
   `{ success: false, error: { code, message, details } }`; `invalid_transition` and
   `authorization_required` are 422, `ro_not_found` is 404, `concurrent_modification` is 409.
3. **`location_id` is required and must be a UUID** when creating appointments, repair orders, quick
   intake sessions and retention offers. The original code substituted `''`, which a `UUID NOT NULL`
   column rejects at runtime.
4. **`PATCH /appointments/:id` no longer accepts `status`.** Use the confirm and check-in endpoints.
5. **Neither creating nor updating a line item accepts `authorization_status` or
   `authorization_ref`.** They are written only by `generateEstimate` and `recordAuthorization`. A
   line the customer declined also refuses further status changes.
5a. **`recordAuthorization` requires `evidence_refs`** for `portal`, `signature` and
   `recorded_call_ref`, and every decided line must currently be awaiting a decision.
5b. **Bearer tokens must carry `exp`.** A token without one is now rejected.
6. **`POST /ros/:roId/transition` to `authorized` or `canceled` requires `step_up_token`**, as does
   recording a `staff_attestation` authorization.
7. **Check-in is idempotent.** A repeat call returns the existing repair order with
   `idempotent_replay: true` instead of creating a second one.
8. **Unsupported inputs are rejected**: `overrides` on the view query, `create_runbook: true` on
   queue escalation, and a `queue_type` outside the known set.
9. **New 409 conflicts** where the operation previously succeeded silently or failed as a 500:
   `appointment_already_converted`, `queue_item_taken`, `queue_item_closed`, `ro_not_inspectable`,
   `ro_not_estimable`, `ro_not_estimate_pending`, `line_items_not_pending`, `line_item_declined`,
   `invalid_time_sequence`, `offer_already_exists`.
10. **A step-up token works once.** A replay is refused even inside its lifetime.
11. **`severity` is required** on an inspection result whose status is `attention` or `fail`.
12. **`root_cause_category` and `queue_type` are closed sets**; arbitrary strings are rejected.
13. **Dispatch requires an active technician profile** at the repair order's location
    (`tech_not_available`), so `tech_profiles` must be populated before work can be assigned.
14. **`qc → ready_for_pickup` requires all work closed out** (`work_incomplete`), and a
    customer-declined line refuses further status changes.
15. **Clock events must form a sequence** — the first entry on a ticket is a `start`, and a `stop`
    cannot follow a `stop`.
16. **List endpoints accept `limit`/`offset`** (`event_limit` on the repair-order read), validated
    and capped; `POST /query/view` returns `count`, `limit` and `offset` alongside `items`.
17. **Two new endpoints**: `GET /ros/:roId/portal-tasks` and `PATCH /portal-tasks/:portalTaskId`.
18. **`POST /intake/quick-start` accepts `mdm_vehicle_id`** and returns real service history for it.
19. **`POST /retention/first-service` returns an `offer_id`** and refuses a second offer for the same
    deal.
20. **`POST /ros/:roId/estimates/:estimateId/send` no longer returns `queue_item_id`** — queue
    membership is now derived from the repair order's status.
