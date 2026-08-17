# FBL-020 — Known Limitations

Stated plainly so the next order starts from facts.

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
waves found, and every gap the R3 closeout (clusters K, L and M) found, is
recorded below. A gap that no review has found yet would not be.

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
  and requires the intended refusal — ten controls, each declaring the stage it must
  fail at and the constraint or assertion the failure must name. R3's version of this
  was a local, prose-only exercise and was rejected as evidence; that rejection was
  correct.
  Two limits remain, and they are the reason this entry stays in this section.
  **`npm test` alone still does not fail if the file is reordered** — a mutated
  migration cannot change a database that has already been migrated, so the gate has
  to be the upgrade job. And **eight statements in `057` cannot be shown load-bearing
  by any pre-057 fixture**, because they operate on columns `057` itself creates; they
  are enumerated with their reasons in the `negative-controls.json` artifact rather
  than counted as proven.
- **Fresh chain and upgrade path converge on one schema.** Asserted by the CI
  `migration-upgrade` job comparing two fingerprints. Local runs corroborate only:
  catalog text differs across PostgreSQL builds, so a local value is not the
  authoritative one.
- **The delivery report's own numbers.** `docs/FBL-020-DELIVERY-REPORT.md`
  carries test counts, checksums, ratchet values and CI evidence. **No gate pins
  any of them**, which is how the R2 report came to describe a head two commits and
  a working-tree path count in the past.
  **This bullet deliberately quotes none of those figures**, and that is a
  correction, not a style choice: it previously restated §7's prettier count and
  §10's changed-path split, and both went stale the moment R4 rewrote those
  sections — a bullet whose entire warning is "re-measure before quoting" was
  quoting stale numbers. The populations live where they are measured: **§7** for
  the Prettier scan (which excludes the files Prettier has no parser for), **§10**
  for the changed-path list against the acceptance base, and **§2** for the count
  of paths R2's head is behind. They are three different populations, not three
  values for one fact, and each is reproducible from the command printed beside it.
  Migration checksums are the one part with a defence: they are published beside
  their git blob OIDs, so a stale value can be caught by re-deriving it. Treat
  every other figure in that report as true-when-written and re-measure before
  quoting it. The risk is live, not hypothetical: the final review pass of R3
  found §10's diffstat row for **this file** stale — carried forward from a
  revision preceding a later edit — and then recording that very finding here
  moved the same row again. Both were corrected before submission by a reviewer
  recomputing the table, not by a gate. This bullet deliberately quotes **no
  line counts**: a document that states its own diff invalidates that statement
  every time it is edited, and the two stale rows above were produced by exactly
  that loop. The authoritative figure lives only in §10 of the report, which
  excludes itself from its own table and is therefore a reachable fixed point.
  Re-derive it with `git diff --numstat <base> -- <path>`; do not copy it here.

- **The ratchet ceilings are a document, not a gate.** The ceilings are
  **59 / 136 / 23**, defined by the GOVERNING blueprint
  (`Car_Dealership_Management_and_Sales_Cloud_Master_Blueprint.docx`, sha256
  `556d4e10…`, §14.3, "R2 gate and stop rule": _"Quality ceilings remain tsc-strict
  <=59, eslint <=136 and format <=23."_).
  `docs/adr/ADR-005-technology-selections.md` RESTATES them and is not the
  definition site — it read 29 for the third value until R4, and R3 wrongly
  "corrected" the reporting to match the ADR on the grounds that it was the only
  place in the repository that stated them. Both are reconciled to the blueprint
  now; `docs/FBL-020-DELIVERY-REPORT.md` §7 carries the full history.
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
  `audit_supersession_is_recorded` rather than a `test(…)`. The audit-inventory
  gate verifies the file contains that string; the assertion itself runs in the
  CI upgrade job, not in `npm test`.

- **The refresh-lease conditional write is unpinned defence-in-depth.** The claim
  UPDATE in `packages/identity-access/src/session.ts` carries
  `AND (refresh_lease_id IS NULL OR refresh_lease_expires_at <= NOW())`, and the
  comment above it states that this is what makes the **database** rather than
  the process authoritative when clock skew makes the in-process dueness check
  disagree. That is true of the code as written, but **no test proves it**:
  replacing the predicate with `AND TRUE` leaves the whole identity-boundary
  suite green at 60/60. The property is real defence-in-depth — the `FOR UPDATE`
  read and the conditional UPDATE share one transaction, so the mutation-pinned
  in-process path covers every non-skew case — but a behavioural claim in a
  shipped comment with no test is exactly what this document exists to register.
  _Reproduce: make that substitution and run
  `tests/identity-boundary.test.ts`; contrast the D1 transaction-across-network
  mutation on the same file, which kills two named tests._

## Open at R4 submission — disclosed, not closed

These four were found by R4's own final gate and are being submitted **open**, at the
repository owner's explicit instruction, rather than held for a further correction pass.
None is a runtime authorization defect; all four are gaps in the R4 **guard scaffolding**
or in the precision of a header. They are listed here so the architect can weigh them
directly instead of discovering them.

- **Three declared residues have no fixture behind them.** The three "not enforced"
  sections name four residue classes for the audit-inventory gate. Two —
  root-and-family-both-assembled, and a name outside the namespace — are
  DEMONSTRATED by `architecture/fixtures/audit-inventory-residue/`, which the gate is
  asserted to ACCEPT. The other three (**a value crossing a function boundary with an
  unreadable root**, **array mutation other than `push`** — `parts[0]=`, `unshift`,
  `splice` — and **a name formed from object KEYS**, `Object.keys(FRAGMENTS).join('')`)
  are prose only. Each was reproduced by probe during review, so they are real and
  correctly described; what is missing is a fixture asserting the gate accepts them, which
  is the standard the other two meet. _Consequence: a future edit could close or widen one
  of those three and no test would notice._

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

Two things these four are **not**: none of them is a failed mandatory gate — every §0–§7
obligation is discharged and CI-proven — and none is a runtime access-control hole. A
developer must author the code in question, and the identity boundary itself (admission,
tuple constraints, evidence completeness, lifecycle audit, support expiry, owned
mutations) is pinned by tests proven to fail when the control is reverted.

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
