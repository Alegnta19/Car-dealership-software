# Platform Context — Where This Repository Came From, and What Surrounds It

This repository is a deliberate extraction. The service cockpit was originally Phase 248 of a
much larger generated dealership platform ("Delta Transport", phases 200–265: ~64 modules,
67 migrations, ~800 endpoints) covering sales, finance, EVTR/registration, accounting,
identity, billing, portals and platform infrastructure. Phase 248 was cut out, seeded into
this repository, and then hardened across five review rounds
([REMEDIATION.md](REMEDIATION.md)); the surrounding platform was not.

In July 2026 the full platform bundle was reviewed end-to-end to decide what else belonged
here. This document records the outcome: the map of adjacent systems, the seams this
repository deliberately maintains toward them, what was taken, what was refused, and the
hazards anyone attempting a future re-integration must know about. It exists so that the
next "should we bring over X?" conversation starts from evidence rather than from the
module list.

---

## 1. Adjacent systems (as designed in the origin platform)

Only the phases that share a boundary with fixed ops. Statuses reflect the reviewed bundle,
not aspirations.

| Phase | System | Relationship to this repo | Bundle condition |
|---|---|---|---|
| 209/239/259 | Customer & vehicle master (three parallel generations) | Owns the identities behind `mdm_customer_id` / `mdm_vehicle_id` | 239 has the right shape but never ran end-to-end; 259 is a regression (see §4) |
| 228/244/245 | Sales / deals | `first_service_offers.deal_id` — the sales→service retention handoff; appointment `source='sales_handoff'` | Generated CRUD, unexercised |
| 229 | Service workflow v1 | Predecessor of this entire repo — **superseded** | Its `service_appointments` collides by name with ours (§5) |
| 249/224/264 | Accounting / AR (three parallel GL stacks) | Would consume RO money records (`ro_authorizations.approved_snapshot`) downstream | Non-functional: wrong PK names, simulated GL posting |
| 255 | Frontline mobility | Mobile capture; its `capture_sessions` has an `mpi_supplement` context aimed at our MPI flow | Unrunnable; soft seam only, no FK, no code joins it |
| 257/258 | Deal-to-delivery / post-sale lifecycle | `handoff_type='service_intro'` and we-owe items are the natural feeders of `first_service_offers` and future ROs | Concepts sound, code unrunnable |
| 211/231/263 | Customer portals | Would surface `service_portal_tasks`; the platform's portal exposed **public estimate approve/decline endpoints** | Touches this repo's most protected invariant (§5) |
| 204 | Notifications | Appointment reminders would ride on `preferred_contact_channel` | Not reviewed in depth; likeliest first future import |

## 2. Seams this repository maintains on purpose

- **`mdm_customer_id` / `mdm_vehicle_id` are opaque.** UUID-validated, never FK-linked,
  never resolved here. VIN resolution belongs to an MDM domain this service does not own
  (`quickStartIntake` says so explicitly). Nothing in this repo assumes it can read a
  customer or vehicle record.
- **`first_service_offers.deal_id` is opaque** the same way: it names a sales-domain deal
  this repo cannot see. The offer row is the attribution bridge, nothing more.
- **`service_portal_tasks` is owned here.** The origin platform wrote service tasks into the
  sales domain's `deal_portal_tasks` with an RO id in the `deal_id` column; this repo severed
  that on import. A future portal integration projects our tasks out — it does not resurrect
  the shared table.
- **Users and roles arrive in the JWT.** No user table, no identity module; the `tid`/`sub`
  claims are the entire identity contract.

## 3. What was taken from the platform bundle (July 2026)

| Item | From | What survived |
|---|---|---|
| Deployment packaging (`Dockerfile`, `docker-compose.yml`) | `docker/` | The two-stage/non-root/healthcheck *shape*. Every fail-open default was inverted: no baked secrets (`${VAR:?}` refuses to start), a one-shot migrate service, postgres unpublished. The bundle's own artifacts had never been built (no lockfile; broken compose build context). |
| Node default process metrics + bounded shutdown | `shared/middleware/metrics.ts`, `server.ts` | Two lines of concept. The bundle's request-metrics middleware was refused (raw `req.path` as a label value = unbounded cardinality on an unauthenticated endpoint). |
| Bilingual 18-item MPI checklist content | migration 030 seed | The data only, reshaped to this repo's vocabulary (`pass/attention/fail` rubric keys, explicit `default_severity`), delivered as a per-tenant seed script — `mpi_templates.tenant_id` is NOT NULL, so a global seed migration was the wrong shape. |
| Waitlist concept | migration 030 `service_waitlist_entries` | The concept and table name. The implementation is new: the sketch had no tenant scoping, no closed transitions, no uniqueness backstop and no conversion path. |
| This document's context map | `PHASES_242_265_SUMMARY.md`, transcripts journal | Curated. The summary file itself was stale against its own bundle (wrong table counts, wrong migration count) and describes platform architecture this repo deliberately does not have. |

## 4. What was reviewed and refused

- **All three MDM generations.** Phase 259 (newest) lets the caller choose `tenant_id` on
  every insert, interpolates request keys into SQL, and has no matching or merge logic —
  radioactive, including as scaffolding. Phase 239 has the right relational shape (its PKs
  are literally `mdm_customer_id`/`mdm_vehicle_id`) but provably never ran (its
  `mdm_match_candidates` was a silent no-op against phase 209's incompatible table) and most
  by-id statements are tenant-unscoped. Phase 209 has genuinely sound match/merge governance
  machinery on the wrong substrate, plus an unsound unmerge (restores the N most recent
  records rather than the loser's records). **Bringing a customer/vehicle master in-repo
  would also reverse the §2 opacity stance — that is an architecture decision for the owner,
  not an integration detail.** If it is ever made, phase 239's schema subset + phase 209's
  match/merge design are the reference material, rebuilt fresh, with merge propagation into
  `service_appointments`/`repair_orders` that no bundle generation ever had.
- **Accounting / AR / GL (224, 249, 264).** Three parallel, mutually colliding GL stacks;
  posting simulated (`EXT-BATCH-${Date.now()}` as an external ref, hardcoded reconciliation
  success); phase 249's code targets PK names its own DDL does not define. The one durable
  idea — an RO-close financial event of record with a tenant-scoped idempotency key, typed
  amounts, inserted inside the close transaction — is recorded here as backlog, unbuilt.
- **Phase 229 service module.** Fully superseded by this repo. Its migration must never run
  against our database (§5).
- **Frontline mobility, deal-delivery, delivery-lifecycle (255, 257, 258).** Every generated
  endpoint references a PK column its own migration does not define — the code has never
  executed. Two concepts noted as backlog: `we_owe_items` (promised post-delivery work →
  natural RO feeder) and `handoff_type='service_intro'` (the moment a first-service offer
  should be created).
- **Capacity calendars / scheduling slots.** Half-built even in the bundle (no writers, no
  reservation); a real implementation must make slot reservation transactional against
  double-booking. Design fresh if wanted.
- **All bundle `shared/` code.** The repo's hardened equivalents win on every axis the
  remediation history cares about (alg-pinned JWT with mandatory `exp` vs neither; fail-fast
  env vs `change-me-in-production` fallback; tenant-labeled metrics refused; `_migrations`
  vs our `schema_migrations` bookkeeping).
- **Docs/transcripts (~18 MB).** Raw AI session exports. Secret-scanned clean, but they are
  process artifacts, not documentation, and they contain no phase-248 design decision this
  repo's docs lack (the 248 rebuild session is absent from the set). Never commit them.

## 5. Hazards for any future re-integration

1. **Migration filename collision.** The bundle's `049_phase248_service_cockpit.sql` and this
   repo's are different files with the same name; both runners key on filename. A file copy
   silently swaps the hardened schema for the unhardened one (which, among other downgrades,
   turns the UNIQUE check-in idempotency backstop into a plain index).
2. **`service_appointments` name collision.** Bundle migration 030 (phase 229) creates a
   table by this name with an incompatible column set. Under `CREATE TABLE IF NOT EXISTS`,
   whichever migration runs first silently disables the other module — this is live in the
   bundle itself, where 030 neutered phase 248's own table.
3. **`IF NOT EXISTS` no-ops are systemic in the bundle.** At least six table names are defined
   two or three times with incompatible shapes (`mdm_match_candidates`, `financial_events`,
   `journal_entries`, `journal_entry_lines`, `accounting_periods`, `capture_sessions`), plus
   two migrations sharing the number 046. Verification of any import must compare column-level
   shapes, never object existence.
4. **Migration bookkeeping split.** The bundle runner records into `_migrations`; this repo
   uses `schema_migrations`. Pointing either runner at the other's database re-applies
   everything, with `IF NOT EXISTS` masking the damage.
5. **The bundle's caller-tenant pattern.** `tenant_id: req.body.tenant_id || req.tenantContext?.tenantId`
   appears across every generated module — the exact defect class five review rounds
   eliminated here. Bundle route code is reference material only, never a patch source.
6. **Cross-module reads of our tables exist in the bundle.** The cockpits module's drilldown
   gateway runs `SELECT * FROM repair_orders` (and `ro_estimates`, `ro_parts_lines`,
   `comeback_cases`) with no tenant predicate; the portal module exposes public
   estimate-approval endpoints. Any future import of those modules lands directly on this
   repo's tenancy and customer-authorization invariants.

## 6. Backlog candidates recorded from this review

Unbuilt, unowned, listed so scope decisions are explicit when they come up:

- RO-close **financial event of record** (outbox emitted inside the close transaction; typed
  amounts; tenant-scoped unique idempotency key) as the seam a real accounting system consumes.
  Note: the money of record lives in `ro_authorizations.approved_snapshot`, not on the RO row.
- **Service invoicing / AR** — a deliberate product decision about whether fixed-ops owns it;
  phase 264's `invoice_type='service'` shape is the closest reference.
- **We-owe items** and **service-intro handoff** as feeders of ROs and `first_service_offers`.
- **Capacity-aware scheduling** (transactional slot reservation) behind the waitlist.
- **Appointment reminders** over `preferred_contact_channel` (notifications integration).
- **Customer service-history timeline** (customer-360-style read model, service-scoped).
