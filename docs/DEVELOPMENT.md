# Development — Setup, Test, Migrate, Seed, Teardown

Every command here is non-destructive by design: nothing in this document (or in the
scripts it names) can damage a database it was not explicitly pointed at, and the test
harness carries its own two guards on top (see "The safety model" below).

Supported versions (FBL-000 pins): **Node 20** (`.nvmrc` = 20.20.2 — the version CI and
the container run; Node 22/24 are known to work for local development) and
**PostgreSQL 16**. Container bases are pinned by digest; Dependabot proposes updates.

## One-command flows

### With Docker

```bash
cp .env.example .env   # set POSTGRES_PASSWORD (identity stays disabled for local work)
```

```bash
docker compose up --build
```

That is setup, migration, and start in one: postgres boots, the one-shot `migrate`
service applies `migrations/` in filename order, and the API starts only after
migrations succeed. Teardown, keeping data:

```bash
docker compose down
```

Teardown including data (destroys only the compose-managed `postgres_data` volume):

```bash
docker compose down -v
```

### Without Docker

Point `DATABASE_URL` at any PostgreSQL 16 you own (a scratch cluster, not a shared
one), then:

```bash
npm ci
```

```bash
npm run migrate
```

```bash
npm run dev
```

## Tests

```bash
npm test
```

Without `TEST_DATABASE_URL`, the database-backed tests skip and the portable ones run — that
is the local-without-database mode. **Counts are deliberately not stated here** (this
sentence read "the 72 database-backed tests … the 43 portable tests" long after both figures
had been overtaken): the authoritative numbers are the CI artifact `test-summary.json` and
the floors in `scripts/parse-test-summary.ts`. To run everything:

```bash
TEST_DATABASE_URL=postgres://user@host:port/anything_test npm test
```

In CI, `REQUIRE_DB_TESTS=1` turns that skip into a hard failure: the database-backed
suites are required there and can never be silently skipped.

## Seed

The standard bilingual MPI checklist, per tenant (idempotent — re-running reports the
existing template and writes nothing):

```bash
npm run seed:mpi -- --tenant <tenant-uuid>
```

## Quality gates (run what CI runs)

```bash
npm run typecheck
```

```bash
npm run ratchet:check
```

```bash
npm run format:check
```

The ratchet compares strict-mode (`tsconfig.strict.json`), ESLint, and Prettier
formatting findings against `quality-baselines.json` per file: existing debt is
recorded, new debt fails (`format:check` runs the formatting dimension alone). If your
change _reduces_ debt, run `npm run ratchet:update` and commit the lower baseline.
Never raise the baseline to admit new findings. New files must be clean in all three
dimensions — `npm run format` formats what you're working on.

```bash
npm run architecture:check
```

Seven checks, the same seven CI runs: dependency rules, the app-SQL guard (no query
primitives or SQL literals in `apps/`), the ownership manifest
(architecture/modules.json), `process.env` confinement, the role-bindings
effectiveness guard, the owned-mutation guard (one declared owner per
authorization-state table) and the audit-inventory gate (every `identity.`-namespaced
literal is an inventoried event type or a declared non-event). **The FIFTH — the
role-bindings effectiveness guard** (FBL-020-R3 §E3, hardened by §H1) — fails the build
when SQL reads `role_bindings` without resolving the single exported effectiveness
predicate `EFFECTIVE_ROLE_BINDING_SQL` into every read, hand-writes a filter on that
table's `status`, `effective_from` or `effective_to`, ORs or negates the resolved
predicate away, declares the predicate a second time, guts the predicate itself, or
builds role-bindings SQL the guard cannot resolve statically. That last one is
deliberate: "I could not tell" used to print as `0 statement(s) inspected, OK`, which
is exactly how a clean tree looks.

It is not a text grep. Interpolations are RESOLVED — through local constants, object
and array literals, destructuring, `for … of` bindings, `+` concatenation, and named,
aliased, namespaced and re-exported imports — so `${EFFECTIVE_ROLE_BINDING_SQL}`,
`${policy.EFFECTIVE_ROLE_BINDING_SQL}` and an alias bound at the import are one
predicate, and a table name or filter fragment kept in a constant is substituted
before the SQL is judged.

Genuine exceptions declare themselves beside the SQL as
`// role-binding-effectiveness-opt-out(<reason-code>): <justification>`. The code must
be one of a CLOSED set — `predicate-definition`, `migration-reconciliation`,
`all-bindings-including-ineffective`, `unresolvable-sql-hand-reviewed` — each of which
excuses only the rules that category can excuse and only in the files where it can
apply; prose alone is not an exception, and nothing excuses neutralising the
predicate. Every opt-out in force is printed with its category on each run.

tests/architecture.test.ts additionally proves each checker rejects a deliberately
broken fixture — a forbidden persistence deep-import, an app embedding SQL, and a
whole battery of role-bindings drift and evasion shapes under
`architecture/fixtures/role-binding-drift/`, each pinned to the exact rules it must
raise — so a checker that silently passed everything would fail the suite. The
sibling `architecture/fixtures/role-binding-correct/` pins the other direction: a
guard that rejects correct code teaches authors to route around it.

```bash
npm run schema:fingerprint
```

Prints a deterministic SHA-256 of the public schema shape (used by CI to compare the
fresh migration chain against the upgrade-from-fixture path).

```bash
npx tsx scripts/check-published-figures.ts          # the gate
npx tsx scripts/check-published-figures.ts --list   # the derivation table
npx tsx scripts/check-published-figures.ts --write  # regenerate the marked spans
```

**If you are editing a delivery document, do not retype a number.** Every figure the
delivery report, the requirement map, the provenance record, the known-limitations
register and the README publish that a run or a script produces — suite totals, floor
constants, mutation totals, the `057` inventory totals, requirement and clause counts,
battery sizes, digests — is read from the artifact or checked-in constant that produces
it, and this gate fails when a document says anything else. It catches a figure inside a
marked span AND a figure restated in ordinary prose, which is where every one of the
figures that shipped at two values had been written. Run `--write` after a measured run to
regenerate the spans, then correct whatever prose the gate still reports. A figure no
source in this repository can derive must carry a `NOT GATE-CHECKED: …` label where it
appears; the gate refuses it otherwise. In CI the step runs after the summary parser and
the mutation runner, because it reads their artifacts.

## The safety model

- `npm test` reads **`TEST_DATABASE_URL` only** — it never falls back to
  `DATABASE_URL`, so an exported production URL cannot be truncated by a test run.
- The test database's **name must look disposable** (`test`, `tmp`, `temp`, `scratch`,
  `ci`); anything else is refused. `ALLOW_DESTRUCTIVE_TESTS=1` is the deliberate
  override.
- Database-backed suites run **serially** (`--test-concurrency=1`); two truncating
  suites sharing a database in parallel would clobber each other.
- The migration runner applies each migration in its own transaction and records it in
  `schema_migrations` with a **canonical-LF** checksum. Re-running an UNCHANGED chain is a
  no-op (`applied: 0`). Re-running a chain whose body has changed under an already-applied
  row is **not**: since FBL-020-R4 §0 the runner REFUSES, naming the file and both digests,
  rather than skipping the changed body — and it refuses equally on a NULL checksum, an
  unsupported algorithm, or a ledger row whose migration body is no longer on disk. That is
  why an environment that applied an earlier `057` must be recreated rather than re-migrated.
