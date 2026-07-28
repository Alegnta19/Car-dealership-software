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

**Was.** `authorize` was imported and applied to zero of the 36 routes. Any authenticated principal —
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
user, action and resource**, with an expiry (default 5 minutes) and constant-time signature
comparison. A token minted for one repair order cannot be replayed against another, and one minted
for one user cannot be used by another. Verification failure is a hard 403 `step_up_required`.

Required for: `ro.transition:authorized`, `ro.transition:canceled`, and
`authorization.record:staff_attestation`.

**Covered by tests:** `tests/step-up.test.ts` — nine cases covering each binding field, expiry,
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
- **Step-up token lifetime cut to two minutes.** There is no consumption ledger, so a token stays
  valid for repeat use until it expires. The binding limits that to the same user repeating the same
  action on the same resource; a single-use `jti` ledger remains outstanding work.

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
  tenant label would publish a tenant roster instead. It moved to `unwiredMetrics`, leaving four
  wired metrics rather than five.

**Documentation:** the README claimed seven wired metrics; the code wired five, and now four.

Findings that were *not* acted on: the review flagged that migration 049 differs from the version in
the source bundle, which would matter to an environment that had already applied the bundle's copy.
This repository's 049 has a single revision and has never been applied anywhere, so it stands as the
authoritative schema for a fresh install — but see the note under Outstanding work.

---

## Outstanding work

Known and deliberately not addressed here. None of it is High severity.

**Integration tests.** The 39 unit tests cover pure logic and middleware. Transaction rollback,
check-in idempotency under concurrency, and tenant scoping are verified by review only — they need
tests against a real PostgreSQL instance.

**Metric wiring.** Eleven of the fifteen metrics have no source of truth yet: parts backorder rate
and wait time, QC fail rate, technician utilization / efficiency / proficiency, SLA breach rate, MPI
conversion rate, comeback rate and first-service capture rate (whose false constants were removed),
and queue depth (which cannot be driven from per-request reads on a tenant-agnostic gauge). They need
a periodic aggregation job; all eleven are exported as `unwiredMetrics` so that job has a single
import site. The `_p95` suffix on the histogram names is kept as specified, though histograms yield
quantiles at query time and the suffix is misleading.

**Single-use step-up tokens.** Tokens carry a `jti` that nothing consumes, so one is replayable
within its two-minute lifetime by the same user for the same action on the same resource. A
consumption ledger would close the window entirely.

**Migration 049 differs from the source bundle's copy.** It gains the renamed `idx_roest_ro` index,
the unique indexes on `repair_orders(appointment_id)` and `ro_estimates(ro_id, version)`, the
`service_portal_tasks` table, an FK on `service_recommendations.ro_id`, six FK indexes, and several
CHECK constraints. Because the migration runner keys on filename alone, an environment that already
applied the bundle's 049 will not receive any of it. This repository's 049 has never been applied
anywhere, so it stands as the authoritative schema for a fresh install; if the bundle's version is
live somewhere, that environment needs a separate forward migration rather than a re-run.

**Queue-item lifecycle.** Queue items are created by `checkIn` and `sendEstimate` but no flow closes
them; `transitionRO` should mark the related items `done`. Until then the cockpit accumulates stale
entries unless clients close items explicitly.

**`tech_profiles` is unused.** The table and its indexes exist; no code reads or writes it. It is the
missing input for the three technician metrics.

**CSPP2 has no API of its own.** Portal tasks are created as a side effect of sending
recommendations. A packager endpoint is not implemented.

**Retention attribution is partial.** `createFirstServiceOffer` now persists `deal_id` inside the
appointment's `concerns` payload, which is queryable but not a first-class bridge table.

**`quickStartIntake` persists nothing.** It returns a scratch-pad preview; the response now says so
explicitly (`persisted: false`).

**Duplicate MPI results.** No uniqueness on `(mpi_session_id, item_key)`, so re-recording an item
duplicates it and produces a duplicate customer recommendation on submit.

**No pagination.** List endpoints use fixed limits (20 / 30 / 100 / 200) with no cursor or offset.

**No `updated_at` trigger.** Maintained by application code, as in the original schema.

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
   `ro_not_estimable`, `ro_not_estimate_pending`, `line_items_not_pending`, `line_item_declined`.
