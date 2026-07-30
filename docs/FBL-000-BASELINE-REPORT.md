# FBL-000 Baseline Report

Deliverable required by Work Order FBL-000 ("Fable returns a baseline report of
warnings, flaky tests, typing debt, package findings, and unresolved environment
assumptions"). State as of 2026-07-30, repo head after the FBL-000 change set.

## What FBL-000 delivered

- **CI** (`.github/workflows/ci.yml`), four jobs, all pinned (actions by commit SHA,
  images by digest): (1) *verify* — locked install, typecheck, quality ratchet, build,
  migrations from an empty database plus an idempotency re-run, compiled-app boot with
  `/healthz` readiness, all 115 tests against real PostgreSQL 16 with **zero skips
  permitted** (`REQUIRE_DB_TESTS=1` turns the local skip into a failure, and the job
  greps `skipped 0` from the runner summary), schema fingerprint, `npm audit` gated at
  high, CycloneDX SBOM; (2) *migration-upgrade* — earliest retained schema fixture
  (migrations 000+049 exactly as committed at `f76a27a`) + legacy free-text seed, then
  the current chain on top, fingerprint, app boot; (3) *container* — image build with
  digest artifact; (4) *secret-scan* — gitleaks over full history.
- **Artifacts** per run: test counts and duration, migration logs, schema fingerprints
  (fresh and upgraded), `npm audit` JSON, SBOM, image digest, tool versions.
- **Pins**: Node 20 (`.nvmrc` 20.20.2, `engines >=20 <25`), PostgreSQL 16,
  `node:20-alpine` and `postgres:16-alpine` by digest. `.github/dependabot.yml` (npm,
  docker, github-actions, weekly) is the approved update mechanism.
- **Strictness**: `noImplicitAny` is now ON in the main tsconfig — the codebase already
  had zero violations, so this is a free, proven tightening. The remaining strict flags
  are ratcheted (below).
- **Local flows**: `docs/DEVELOPMENT.md` — one-command setup/test/migrate/seed/teardown,
  all non-destructive.

Verified locally before push: fresh-chain and upgrade-path schema fingerprints are
**identical** (`28c60b89…`), the upgrade succeeds *with* legacy free-text rows present
(both 050 CHECK constraints correctly land `NOT VALID`, `convalidated = f`), and the
full suite passes 115/115 with 0 skipped under `REQUIRE_DB_TESTS=1`.

## Warnings

- Node prints `DEP0190` (shell:true child spawn) when `quality-ratchet.ts` runs on
  Windows; the shell fallback exists for `npx` resolution on win32 only and does not
  fire on Linux CI. Cosmetic; revisit if Node makes it an error.
- On Windows checkouts with `core.autocrlf=true`, git reports LF→CRLF conversion for
  most files; repository content is LF. No functional effect.
- The test suites must run serially (`--test-concurrency=1`); this is a documented
  harness constraint, not an incidental slowness.

## Flaky tests

None currently known. 115/115 across repeated local runs and the CI-simulation run.
One historical flake is on record and fixed: the `updated_at` trigger test originally
compared two `NOW()` readings truncated to JavaScript milliseconds (its back-dating
setup was undone by the trigger under test); it now proves both directions inside
PostgreSQL at full precision. If flakes appear in CI they will be visible as
non-reproducible `fail`/`pass` transitions in the archived test output artifact.

## Typing debt (ratcheted, not fixed — per the work order)

`noImplicitAny`: **0** (now enforced in the main tsconfig).

`tsconfig.strict.json` (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
`noImplicitOverride`): **59 errors**, concentrated where row objects and Express params
meet untyped boundaries:

| File | Errors |
|---|---|
| `src/modules/service-cockpit/routes/index.ts` | 33 |
| `src/modules/service-cockpit/services/service-cockpit-service.ts` | 9 |
| `tests/docs.test.ts` | 4 |
| `src/shared/middleware/auth.ts` / `security/step-up.ts` | 3 + 3 |
| others | 7 |

ESLint (`typescript-eslint` recommended): **136 findings** — 2 errors
(`preserve-caught-error`, `no-useless-assignment`) and 134 warnings, of which 133 are
`@typescript-eslint/no-explicit-any` (the service layer's row-shape `any`s; 66 in the
service, 42 in the integration tests).

Policy: `scripts/quality-ratchet.ts` blocks any growth per file and in total.
Pay-down belongs to the FBL-010+ module moves (typed rows arrive with the architecture
shell), not to a mass edit here. FBL-000's own new scripts were held to zero debt.

## Package findings

- `npm audit`: **0 vulnerabilities** (all severities) at 2026-07-30 — consistent with
  the blueprint's assessment. CI re-checks every run and gates at high.
- Runtime dependency surface is small: `express`, `pg`, `prom-client` (78 components
  in the CycloneDX SBOM including transitives).
- Added this order (dev-only, required by the order's own scope): `eslint`,
  `@eslint/js`, `typescript-eslint`.
- `package-lock.json` was already present and is now load-bearing in CI (`npm ci`) and
  the container build (the lockfile glob that masked its absence in the origin
  platform's Dockerfile was already removed in the packaging wave).

## Unresolved environment assumptions

1. **Container build is CI-verified only.** Docker Desktop on the development machine
   is down (known afunix driver issue; OS reboot required). The image was validated
   locally via a faithful layout simulation (compiled `dist/` + `migrations/` +
   runtime deps, runner executed from two working directories), and the CI `container`
   job builds the real image — but no image has been run end-to-end on the dev machine.
2. **Node skew.** Development machine runs Node 24.18.0; supported/CI/container is
   Node 20 (20.20.2). The full suite passes on both, but 24 is not a pinned target;
   `engines` allows `>=20 <25`.
3. **Local PostgreSQL service is off-limits.** A PostgreSQL 16 Windows service exists
   on the dev machine with unknown credentials; all local database work uses disposable
   scratch clusters (`initdb`/`pg_ctl`, trust auth, ephemeral port) or compose. Nothing
   in the repo references that service.
4. **`/metrics` and `/healthz` are unauthenticated by design** and must be gated at the
   ingress in any reachable deployment (documented in README and compose comments).
5. **`node:test` reporter surface on Node 20** lacks the `junit` reporter (added in
   Node 21), so CI archives the spec output and extracted counts instead of JUnit XML.
6. **gitleaks-action** relies on the Actions-provided `GITHUB_TOKEN` and is free for
   personal repositories; if the repo moves into an organization it will require a
   license key.
7. **Blueprint reference frame.** The blueprint's §2.2 measured the pre-integration
   state (43 portable tests, 39 endpoints, 3,279-line service). Since then the
   integration wave (`364ce69`…`7c832b8`) added the waitlist, MPI seed, packaging and
   platform-context docs: 115 tests, 44 endpoints, migrations 000/049–054. The §4
   findings (F-01…F-12) were re-checked against head and remain valid — none were
   addressed by that wave, and none are addressed by FBL-000 (out of scope).

## Acceptance gate status (self-assessment)

| Gate condition | Status |
|---|---|
| CI passes from a clean clone with zero skipped required tests | **CONFIRMED** — the first run on `de0f47f` completed `success` on GitHub-hosted runners (clean clones by construction), all four jobs |
| All migrations apply to an empty database; app starts and readiness succeeds | Proven locally and encoded as CI steps (empty-DB apply + idempotent re-run + compiled-app `/healthz`) |
| Second CI job exercises an upgrade from the earliest retained schema fixture | `migration-upgrade` job; fixture = `f76a27a` migrations byte-for-byte + legacy free-text seed; fingerprint equality with the fresh chain proven locally |
| Artifacts include test results, SBOM, container digest, migration/schema fingerprints | `baseline-evidence`, `upgrade-evidence`, `container-evidence` artifact bundles |
| Baseline report returned | This document |

**Stopping here per the execution contract.** FBL-010 (Architecture Shell) is not
started; no ADRs, no module moves, no boundary tooling. Awaiting architecture review.
