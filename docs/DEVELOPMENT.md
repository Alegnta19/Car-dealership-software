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
cp .env.example .env   # set JWT_SECRET, STEP_UP_SECRET, POSTGRES_PASSWORD
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

Without `TEST_DATABASE_URL`, the 72 database-backed tests skip and the 43 portable
tests run — that is the local-without-database mode. To run everything:

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
change *reduces* debt, run `npm run ratchet:update` and commit the lower baseline.
Never raise the baseline to admit new findings. New files must be clean in all three
dimensions — `npm run format` formats what you're working on.

```bash
npm run schema:fingerprint
```

Prints a deterministic SHA-256 of the public schema shape (used by CI to compare the
fresh migration chain against the upgrade-from-fixture path).

## The safety model

- `npm test` reads **`TEST_DATABASE_URL` only** — it never falls back to
  `DATABASE_URL`, so an exported production URL cannot be truncated by a test run.
- The test database's **name must look disposable** (`test`, `tmp`, `temp`, `scratch`,
  `ci`); anything else is refused. `ALLOW_DESTRUCTIVE_TESTS=1` is the deliberate
  override.
- Database-backed suites run **serially** (`--test-concurrency=1`); two truncating
  suites sharing a database in parallel would clobber each other.
- The migration runner applies each migration in its own transaction and records it in
  `schema_migrations`; re-running is always a no-op (`applied: 0`).
