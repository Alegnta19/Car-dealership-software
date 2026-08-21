# Car Dealership Software — Service Cockpit v2 (Phase 248)

Fixed-ops operations platform for automotive dealerships: appointments, repair orders, digital
inspections, estimates and customer authorizations, parts, sublets, technician dispatch and time,
warranty claims, comeback/quality cases, SLA work queues, and a post-sale first-service retention
bridge.

Node.js · TypeScript · Express · PostgreSQL · Prometheus — an npm-workspaces modular
monolith (FBL-010): enforced module boundaries, one root lockfile, ADR-governed
architecture. See [docs/architecture/MODULE-OWNERSHIP.md](docs/architecture/MODULE-OWNERSHIP.md).

---

## Quick start

```bash
npm install
```

```bash
cp .env.example .env
```

Fill in `DATABASE_URL`. That is the only variable local work needs: leave `IDENTITY_PROVIDER`
unset and the WorkOS block empty, and the process builds, migrates and tests without a
provider credential. To serve real logins, set `IDENTITY_PROVIDER=workos` and fill in every
`WORKOS_*` / `OIDC_*` variable in `.env.example`, including `WORKOS_API_KEY` and
`WORKOS_COOKIE_PASSWORD` (each at least 32 characters). **`JWT_SECRET` and `STEP_UP_SECRET`
no longer exist** — FBL-020 removed locally signed HS256 credentials entirely, and neither
name appears in `.env.example` or anywhere under `apps/`, `packages/` or `scripts/`. Then:

```bash
npm run migrate
```

```bash
npm run dev
```

Other scripts: `npm test` (unit tests, no database required), `npm run test:integration`
(set `TEST_DATABASE_URL`), `npm run typecheck`, `npm run build`, `npm start`.

### Docker

```bash
cp .env.example .env   # set POSTGRES_PASSWORD (the only variable compose REQUIRES)
```

```bash
docker compose up --build
```

Compose refuses to start with `POSTGRES_PASSWORD` missing (`${VAR:?}` — there are no baked
defaults); the `WORKOS_*` block is optional here and defaults to empty, which starts the
stack with identity disabled. It
runs migrations as a one-shot service, and only starts the API after they succeed. The
image is a two-stage non-root build with a `/healthz` healthcheck; `/metrics` and
`/healthz` stay unauthenticated by design, so gate them at the ingress in any deployment
where port 3000 is reachable from outside. To seed a tenant's standard MPI checklist:

```bash
docker compose exec api node scripts/dist/seed-mpi-template.js --tenant <tenant-uuid>
```

---

## Layout

```text
apps/
  api/                               @dealer/api — HTTP composition root (server, routes,
                                     middleware, envelopes); the deployable service
  worker/                            @dealer/worker — deployed background process; runs the
                                     three identity expiry sweeps (support windows, login
                                     transactions, step-ups). No queue or outbox: FBL-040
  web/                               @dealer/web — buildable shell; no product UI yet
packages/
  contracts/                         @dealer/contracts — roles, tenant context, envelopes,
                                     internal Problem Details model
  platform/                          @dealer/platform — config boundary, request context,
                                     logging, error primitives, JWT verification
  database/                          @dealer/database — pool, query, transactions
  fixed-ops/                         @dealer/fixed-ops — the service-cockpit domain +
                                     legacy service (unsplit until FBL-060)
  test-kit/                          @dealer/test-kit — test guards and builders (test-only)
  ui/                                @dealer/ui — UI primitives shell
architecture/
  modules.json                       machine-read ownership/dependency map (checker input)
docs/
  adr/                               ADR-001..008
  architecture/                      MODULE-OWNERSHIP.md, LOGGING-POLICY.md,
                                     THREAT-MODEL-DELTA-FBL-020.md
  identity/                          AUTH-FLOWS.md, DATA-DICTIONARY.md,
                                     KNOWN-LIMITATIONS.md
  orders/                            the active order text + blueprint provenance
Dockerfile / docker-compose.yml      container build + postgres/migrate/api stack
migrations/
  000_platform_core.sql              audit_events + pgcrypto guard (prerequisite)
  049_phase248_service_cockpit.sql   20 tables, 45 index statements
  050_phase248_hardening.sql         triggers, constraints, 2 more tables
  051_phase248_metrics_support.sql   received_at, SLA defaults, corrections
  052_phase248_authorization_binding.sql  approved-price snapshot + freeze
  053_phase248_estimate_line_association.sql  which lines an estimate asked about
  054_phase248_waitlist.sql          service waitlist + waitlist appointment source
  055_identity_organization.sql      FBL-020: 14 identity/organization tables + backfill
  056_identity_contract_completion.sql  forward-only contract completion (additive)
  057_identity_boundary_completion.sql  the identity boundary: login_transactions,
                                     policy_decision_matched_bindings, reconciliations
                                     and constraints (FROZEN by FBL-020-R6 §1.3; further
                                     schema changes go in a new 058)
scripts/                             migrate runner, quality ratchet, schema fingerprint,
                                     architecture checkers, MPI seed
tests/                              cross-package suites: unit, docs, HTTP contract,
                                     platform, architecture, integration, routes
```

---

## The domain in one paragraph

The central aggregate is the **repair order (RO)**. An appointment is booked (directly, or by converting a
waitlist entry when a slot opens), confirmed, and checked in — which creates the RO. A technician runs a multi-point inspection (MPI); failed and attention
items automatically become bilingual customer recommendations. An advisor generates a versioned
estimate and sends it; the customer approves or declines individual lines; that decision is recorded
as an **authorization**, which is the evidence the RO state machine requires before work may start.
Parts and sublet jobs hang off individual line items, technicians clock time against work tickets,
and every stage surfaces in SLA-tracked work queues on the cockpit dashboard. Quality problems after
closure open a **comeback case** linking the original and the new RO.

Full subdomain map, data model, state machine and endpoint catalog:
[docs/PHASE-248-SERVICE-COCKPIT-V2.md](docs/PHASE-248-SERVICE-COCKPIT-V2.md).

---

## Security model

Read [docs/REMEDIATION.md](docs/REMEDIATION.md) before changing anything in this list — each of these
rules exists because its absence was an exploitable defect.

**Tenant identity comes from the token, never the request.** `authenticate` sets `req.tenantContext`
from the verified bearer token. Handlers call `requireContext(req)`; they never read `tenant_id` from
a body or query string. A request that supplies a _different_ `tenant_id` is rejected with 403 rather
than silently ignored.

**Every statement is tenant-scoped.** Every read and write against a tenant-owned table carries
`tenant_id` in its `WHERE` clause. Operations addressed by a child id (`:lineItemId`, `:estimateId`,
`:ticketId`) additionally prove the parent belongs to the caller. Cross-tenant misses return 404, not
403, so the API never confirms another tenant's rows exist.

**Every route is role-gated.** `authenticate` then `authorize(...roles)`. Roles: `platform_admin`
(passes everything), `service_manager`, `service_advisor`, `service_technician`, `parts_clerk`,
`warranty_admin`, `service_viewer`.

**Privileged actions require step-up.** Moving an RO to `authorized` or `canceled`, and recording a
`staff_attestation` authorization, require a short-lived token bound to the exact tenant, user,
action and resource. Since FBL-020 the step-up credential is a provider-backed
reauthentication grant, not a locally signed token: see
`packages/fixed-ops/src/security/sensitive-action.ts` and
[docs/identity/AUTH-FLOWS.md](docs/identity/AUTH-FLOWS.md) §5. (`src/shared/security/step-up.ts`
was this file's pre-FBL-010 path and no longer exists.)

**Customer authorizations are derived, not asserted.** `recordAuthorization` validates that the
estimate belongs to the RO, was actually sent, and is still the version in front of the customer,
rejects any line-item id that is not on that RO or is not awaiting a decision, snapshots the approved
terms before anything can move, and derives the record's status from the decision — an all-declined
outcome is stored as `declined` and does not satisfy the state machine's authorization gate, which
additionally requires the approval to reference the _current_ estimate version. Methods that claim a
customer-produced artifact must carry `evidence_refs`; the one that does not (`staff_attestation`)
requires step-up instead, so neither path is a way around the other.

**Authorization status is never caller-supplied.** Neither creating nor updating a line item accepts
`authorization_status` or `authorization_ref` — both are refused with 403. They are written only by
`generateEstimate` (to `pending`) and `recordAuthorization` (to `approved`/`declined`), and a line
the customer declined cannot be reopened through the work-progress endpoint.

**Multi-write operations are atomic.** Everything that writes more than one row runs inside
`withTransaction`. Domain events (`ro_events`, `service_appointment_events`) commit with the change
they describe. Best-effort platform audit rows and metrics are emitted only after the commit — a
swallowed error inside an open Postgres transaction would poison the commit.

**Step-up grants work once.** `consumeSensitiveActionGrant`
(`packages/fixed-ops/src/security/sensitive-action.ts`) spends the reauthentication grant in
the same transaction as the privileged write, so it is spent exactly when the operation
commits and a rolled-back operation releases it. A replay, a wrong action, a wrong resource,
a wrong user or a wrong tenant is refused, and a `fresh_only` grant can never pay for a
`fresh_and_mfa_policy` operation. The pre-FBL-020 mechanism this replaced — a locally signed
token whose `jti` was recorded in `step_up_token_uses` — is gone: `consumeStepUpToken` no
longer exists in any source file, and the `step_up_token_uses` table (migration 050) is
neither written nor read (see `docs/identity/KNOWN-LIMITATIONS.md`).

---

## API

All endpoints are mounted under `/api/service` and require `Authorization: Bearer <jwt>`.

Success responses are `{ "success": true, "data": ... }`. Errors are:

```json
{ "success": false, "error": { "code": "invalid_transition", "message": "...", "details": {} } }
```

`code` is the stable discriminator to branch on. Common codes: `validation_error` (400),
`unauthorized` (401), `forbidden` / `tenant_mismatch` / `step_up_required` (403), `not_found` /
`ro_not_found` / `estimate_not_found` (404), `conflict` / `concurrent_modification` (409),
`invalid_transition` / `authorization_required` / `work_incomplete` (422). The full list is in the
architecture reference appendix.

Authentication is **WorkOS AuthKit** (FBL-020). A request presents EXACTLY ONE credential:

- `Authorization: Bearer <WorkOS access token>` — verified against the CONFIGURED issuer, audience
  and JWKS with an allowlisted asymmetric algorithm. Locally signed HS256 tokens are no longer
  accepted anywhere; `JWT_SECRET` and `STEP_UP_SECRET` are gone.
- the HttpOnly session cookie minted by `GET /auth/callback` — validated server-side, with the
  session's CSRF token required in `x-csrf-token` on every non-safe method.

Presenting both is ambiguous and refused. Roles in a provider token are display hints only:
authorization is decided from database RoleBindings by the central policy engine, so revoking a
binding denies the very next request. See [docs/identity/AUTH-FLOWS.md](docs/identity/AUTH-FLOWS.md).

Endpoint catalog: [docs/PHASE-248-SERVICE-COCKPIT-V2.md](docs/PHASE-248-SERVICE-COCKPIT-V2.md#7-api-surface--39-endpoints).

---

## Observability

`GET /metrics` exposes the Prometheus registry; `GET /healthz` is a liveness probe. Neither is
authenticated — bind them to an internal interface or gate them at the ingress.

All fifteen Phase-248 metrics are populated. Four are per-request events (appointments, repair
orders, cycle time, approval time). The other eleven are rates, ratios and depths computed by
`packages/fixed-ops/src/legacy/metrics-aggregator.ts`, which runs on an interval (`METRICS_INTERVAL_MS`, default 60s)
over a rolling window (`METRICS_WINDOW_DAYS`, default 30) and covers parts backorder rate and wait
time, QC failure rate, technician utilization / efficiency / proficiency, SLA breach rate,
recommendation conversion, comeback rate, first-service capture, and queue depth.

`/metrics` is a shared, unauthenticated surface, so no series carries a tenant label and none is
driven from a per-request read — a gauge fed by request traffic is last-writer-wins across tenants.
Series are labelled by `location_id`, which is already tenant-unique. A ratio with no denominator
publishes nothing rather than a misleading zero, and a label value read from a database column is
bounded against its known set before it is published — the CHECK constraints behind `queue_type` and
`root_cause_category` are `NOT VALID`, so history may still hold free text, and a Prometheus label is
a new time series per distinct value.

---

## Testing

```bash
npm test
```

The suite spans **unit tests with no database** (the repair-order state machine, authorization and
estimate-status derivation, JWT verification against algorithm confusion and malformed expiry,
tenant-override rejection, role enforcement, and the CI gates themselves) and **database-backed
tests** that need a real PostgreSQL instance — the service layer for what a mock cannot express
(cross-tenant reads and writes, check-in idempotency and its unique-index backstop, transaction
rollback, step-up consumption and release, queue and waitlist lifecycles, the seeded MPI
checklist), plus the identity boundary and the real HTTP stack via `createApp()`, which is where
role boundaries actually live.

**Counts are not repeated here on purpose.** They go stale, and a stale count in a README is how
a reader learns to distrust the document. The authoritative figure is the CI artifact
`test-summary.json`, and `scripts/parse-test-summary.ts` enforces a FLOOR on it: all eight summary
fields must be present (`todo` included), `failed`/`cancelled`/`skipped`/`todo` must be zero, and
the run must be at least as large as the declared floor — so a suite that SHRANK fails the build
instead of passing quietly.

Point `TEST_DATABASE_URL` at a throwaway database and run:

```bash
npm run test:integration
```

CI (`.github/workflows/ci.yml`) runs the whole suite against a real, digest-pinned
PostgreSQL 16 with `REQUIRE_DB_TESTS=1`, so the database-backed suites can never be
silently skipped there, plus a container build and a full-history secret scan. Quality debt is
ratcheted: `npm run ratchet:check` fails on any new strict-mode or lint finding beyond
`quality-baselines.json`. See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

### The gates that check the checks

A green suite is not by itself evidence that the suite is holding anything, so **seven** gates
exist to make the evidence mechanical rather than trusted. (This sentence read "four" while
listing five bullets until FBL-020-R5; the count is the list, and the list has since grown
twice.)

- **The populated upgrade drill.** `tests/fixtures/legacy-identity-seed-pre-057.sql` seeds NONEMPTY
  legacy identity data against the schema as it stood before migration `057`, and
  `scripts/verify-upgrade-state.ts` (`--phase=backfill|pre-057|post-057`) asserts the exact
  reconciled state of every seeded row afterwards, with nonzero and unchanged before/after counts.
  Before R4 the drill ran on empty tables, which could not exercise a single reconciliation.
- **Reconciliation negative controls.** `scripts/upgrade-negative-controls.ts` copies that database,
  deletes ONE reconciliation from `057`, and requires the intended refusal — a named Postgres
  constraint or a named verifier assertion. A control whose removal changes nothing fails the build.
- **Mutation-kill checks.** `scripts/mutation-kill.ts` copies the tree, removes one security control,
  and requires the named test to die. It has already found a real gap: a status predicate whose
  removal broke no test.
- **The requirement map.** `docs/FBL-020-R5-REQUIREMENT-MAP.json` maps every attested clause of the
  active order to its named tests, CI steps and artifacts; `scripts/check-requirement-map.ts` fails
  if any named test, path, step or artifact does not exist, if a requirement id is duplicated or
  malformed, or if a declared clause has no requirement at all — so the map can neither rot nor go
  quietly incomplete.
- **Published figures vs their artifacts.** `scripts/check-published-figures.ts` reads every
  figure the delivery report and the requirement map publish — suite totals, floor constants,
  mutation totals, inventory totals, battery sizes, digests — out of the run or the constant
  that produces it, and fails when a document states anything else, whether the figure sits
  in a marked span or in a sentence. Four figures had shipped at two values each before it
  existed. A figure no source can derive must carry a `NOT GATE-CHECKED` label where it
  appears.
- **The order and the blueprint it comes from.** The active order text is checked in at
  `docs/orders/FBL-020-R5.md`, verbatim and in full, canonical-LF SHA-256
  `83b7bcd961bd36e1ba06ed79bebe524a8d1a6b40c65797ad2b4c37cc0ce47f44`
  (`sed 's/\r$//' docs/orders/FBL-020-R5.md | sha256sum`), with a clause register that marks
  **all twenty-nine clauses as held verbatim**. An earlier revision of this bullet described
  that register as listing "the clauses this repository does NOT hold"; that was an artefact
  of the order having been routed to the implementation waves one section at a time, and it
  is **withdrawn** — no clause is registered as unheld, and
  `tests/delivery-documentation.test.ts` fails if one ever is again. **The R6 corrective order
  is checked in beside it at `docs/orders/FBL-020-R6.md`** — the R6 gate's finding C3 — with
  §4.3 and the gate's correction order held verbatim, a clause register for the rest, and a
  plain statement that the verbatim text of §1, §2, §3 and §4.1–§4.2, §4.4–§4.6 is NOT in this
  repository's hands and is therefore marked _(derived)_ rather than paraphrased into quotes.
  Which blueprint governs, and what a bare §14 citation resolves to in each — the two number
  their sections differently — is `docs/orders/BLUEPRINT-PROVENANCE.md`. **BOTH** blueprints
  are committed beside it, and `tests/delivery-documentation.test.ts` reads the bytes of each,
  so the recorded facts cannot drift from the documents. What the two project copies outside
  this repository hold is UNKNOWN HERE, and no gate here asserts it in either direction.
- **The final state, including its prose.** `docs/evidence/FBL-020-FINAL-STATE.json` is the
  one record of which commits exist, which exact-SHA `ci.yml` run measured which of them
  with what per-job conclusions, whether the commit budget was kept and whether the revision
  may be submitted; `scripts/check-final-state.ts` checks that record against **git** — the
  commits exist, their subjects match, and the recorded list is exactly the commits in the
  recorded range — against the run data, and then sentence by sentence against this README,
  the delivery report, the requirement map, KNOWN-LIMITATIONS and the provenance record. It
  exists because the figure gate above compares NUMBERS: FBL-020-R5 shipped a delivery
  report naming a red `HEAD` that was no longer `HEAD`, a KNOWN-LIMITATIONS repeating that
  no CI run existed, and a requirement map still awaiting a run that had already happened —
  and every figure gate stayed green throughout, because not one of those sentences is a
  number.

**Every R5 clause is UNVERIFIED until the final package proves it** (the order's Appendix A).
Nothing in this README closes one, and no "closed"/"discharged" claim about an R5 clause
stands anywhere in this repository as a governing status.

**THE FINAL CODE-BEARING COMMIT IS `b628e0a9f4bb95970c7a7c6e9a657edcd43e4e37` AND ITS
EXACT-SHA `.github/workflows/ci.yml` RUN 32465933403 COMPLETED WITH 4 OF 4 JOBS SUCCESSFUL.**
That commit IS the FBL-020-R6 work, measured by its own run at the third attempt; the first
two, `0fe4ae7` and `242e24a`, **both FAILED their runs** and are recorded rather than dropped.
A green run is evidence for the controls it exercised and is not acceptance. The one-commit
budget was violated under both orders: eight code-bearing commits where each allowed one, four
of them red. §1 and §1.1 of `docs/FBL-020-DELIVERY-REPORT.md` carry the tables, and
**FBL-020-R6 IS NOT SUBMITTABLE AS COMPLETE WHILE §3.1 IS OPEN** — §3.1 requires the governing
Version 2.0 blueprint in both designated project copies; the document itself is committed here
at `docs/orders/Car_Dealership_Management_and_Sales_Cloud_Master_Blueprint.docx`, and whether
those two copies hold it is not observable from this repository, which can neither write to
nor read that record. An earlier version of this sentence said the blueprint "has not reached
the reviewed project record"; that is a claim about a record nothing here can see, and it is
**withdrawn**.

**LIVE WORKOS CERTIFICATION IS NOT DISCHARGED.** Every provider property is proven against a
deterministic local issuer and a provider-neutral fake, and the WorkOS adapter itself is invoked
only over a mocked transport. See `docs/identity/KNOWN-LIMITATIONS.md` and the "Gates NOT
DISCHARGED" section of `docs/FBL-020-DELIVERY-REPORT.md`.

The database-backed suites TRUNCATE every table, so two guards stand in front of them:
`TEST_DATABASE_URL` is read on its own and never falls back to `DATABASE_URL`, and the database
name must look disposable (containing `test`, `tmp`, `temp`, `scratch` or `ci`). Both suites run
serially — sharing one database in parallel would let them clobber each other. Without
`TEST_DATABASE_URL` they skip, so `npm test` still works on a machine with no database.
