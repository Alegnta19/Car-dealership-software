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

Fill in `DATABASE_URL`, `JWT_SECRET` and `STEP_UP_SECRET` (each secret at least 32 characters), then:

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
cp .env.example .env   # set JWT_SECRET, STEP_UP_SECRET, POSTGRES_PASSWORD
```

```bash
docker compose up --build
```

Compose refuses to start with missing secrets (`${VAR:?}` — there are no baked defaults),
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
  worker/                            @dealer/worker — buildable shell; no jobs until FBL-040
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
  adr/                               ADR-001..005
  architecture/                      MODULE-OWNERSHIP.md, LOGGING-POLICY.md
Dockerfile / docker-compose.yml      container build + postgres/migrate/api stack
migrations/
  000_platform_core.sql              audit_events + pgcrypto guard (prerequisite)
  049_phase248_service_cockpit.sql   20 tables, 45 index statements
  050_phase248_hardening.sql         triggers, constraints, 2 more tables
  051_phase248_metrics_support.sql   received_at, SLA defaults, corrections
  052_phase248_authorization_binding.sql  approved-price snapshot + freeze
  053_phase248_estimate_line_association.sql  which lines an estimate asked about
  054_phase248_waitlist.sql          service waitlist + waitlist appointment source
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
action and resource. See `src/shared/security/step-up.ts`.

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

**Step-up tokens work once.** `consumeStepUpToken` records the token's `jti` in the same transaction
as the privileged write, so it is spent exactly when the operation commits and a rolled-back
operation releases it. A replay is refused even inside the token's lifetime.

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
`services/metrics-aggregator.ts`, which runs on an interval (`METRICS_INTERVAL_MS`, default 60s)
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

**39 unit tests** cover the repair-order state machine, authorization and estimate-status
derivation, step-up token binding and expiry, JWT verification (algorithm confusion, missing or
non-numeric expiry, non-object payloads), tenant-override rejection, and role enforcement. They run
without a database.

**4 documentation tests** compare `docs/PHASE-248-SERVICE-COCKPIT-V2.md` against the code: every
error code the API can return must be listed in the appendix and every listed code must still be
thrown, each metric's documented labels must match its declaration, and every migration on disk must
appear. Three review rounds turned up the same drift, so it is now a failing test rather than
something a reader has to catch by hand. They need no database either.

**72 database-backed tests** need a real PostgreSQL instance. 46 exercise the service layer for
what a mock cannot express — cross-tenant reads and writes, check-in idempotency and its
unique-index backstop, transaction rollback, the authorization gate, step-up consumption and
release, queue lifecycle, waitlist transitions and the atomic waitlist→appointment conversion,
the seeded MPI checklist, clock sequencing, and the populations behind the metrics and the
estimate status. The other 26 go through the real HTTP stack via `createApp()`, which is where
role boundaries actually live: that a technician cannot rewrite `price_ref` or `sold_hours`,
cannot assign themselves work, cannot put customers on the waitlist, and cannot touch a line they
were not dispatched to; that an approved price is frozen; that a vehicle with a chargeable
undecided line cannot be handed back.

Point `TEST_DATABASE_URL` at a throwaway database and run:

```bash
npm run test:integration
```

CI (`.github/workflows/ci.yml`) runs the whole suite against a real, digest-pinned
PostgreSQL 16 with `REQUIRE_DB_TESTS=1`, so the database-backed suites can never be
silently skipped there, plus a migration-upgrade job from the earliest retained schema
fixture, a container build, and a full-history secret scan. Quality debt is ratcheted:
`npm run ratchet:check` fails on any new strict-mode or lint finding beyond
`quality-baselines.json`. See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

The database-backed suites TRUNCATE every table, so two guards stand in front of them:
`TEST_DATABASE_URL` is read on its own and never falls back to `DATABASE_URL`, and the database
name must look disposable (containing `test`, `tmp`, `temp`, `scratch` or `ci`). Both suites run
serially — sharing one database in parallel would let them clobber each other. Without
`TEST_DATABASE_URL` they skip, so `npm test` still works on a machine with no database.
