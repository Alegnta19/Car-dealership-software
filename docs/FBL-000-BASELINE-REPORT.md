# FBL-000 Baseline Report (as corrected by FBL-000-R1)

Deliverable required by Work Order FBL-000 ("Fable returns a baseline report of
warnings, flaky tests, typing debt, package findings, and unresolved environment
assumptions"), corrected under order FBL-000-R1. State as of 2026-07-30 at the
FBL-000-R1 correction head.

## CI run history — the corrected record

The first version of this report **falsely recorded the FBL-000 CI as green**. The
truth:

| Run | Head | Conclusion | Cause |
|---|---|---|---|
| [30569703792](https://github.com/Alegnta19/Car-dealership-software/actions/runs/30569703792) | `de0f47f` | **failure** | *verify*: the workflow grepped for the spec reporter's `ℹ` glyph, but Node 20.20.2 on a non-TTY chose the TAP reporter, whose summary lines use `#`; `test-counts.txt` came out empty and the job exited 1 — even though all 115 tests passed with 0 failed and 0 skipped. Because the job stopped there, the fresh schema fingerprint, `npm audit`, and SBOM steps never ran. *secret-scan*: gitleaks found the three synthetic JWT-secret literals committed inside the workflow file itself. *migration-upgrade* and *container* succeeded. |
| [30569865886](https://github.com/Alegnta19/Car-dealership-software/actions/runs/30569865886) | `59515e4` | **failure** | Same two causes (the docs-only commit changed neither). Its secret-scan job "passing" proved nothing: the action ran `--log-opts=-1`, scanning only the latest commit, not history. |

**How the false claim happened.** Completion was "verified" with a poller that queried
`GET /actions/runs?head_sha=…` and took the first result **across all workflows**. That
result was a Dependabot setup run (three of them existed, all `success`), not the `ci`
workflow. The report then recorded `de0f47f` as confirmed green. Verification now
queries the specific workflow (`GET /actions/workflows/ci.yml/runs?head_sha=…`) and
reads per-job conclusions; and the report never claims a run is green before that
run's own conclusion says so.

## What FBL-000-R1 corrected

1. **Deterministic test-summary enforcement** — `scripts/parse-test-summary.ts`
   replaces the glyph-dependent grep. The test step pins `--test-reporter=tap`; the
   parser accepts both `#` and `ℹ` summary prefixes, takes the final summary, writes a
   normalized `test-summary.json` (tests, suites, passed, failed, cancelled, skipped,
   todo, duration_ms), and fails on an empty/unparseable summary, an internally
   inconsistent one, or anything but failed=0, skipped=0, cancelled=0. Proven against
   the real 115-test TAP output, an empty log, and a doctored skipped count.
2. **No secret literals in tracked workflow text** — CI generates test-only values per
   run (`openssl rand -hex 32`, masked via `::add-mask::`). No repository secrets are
   required for ordinary CI. History is immutable and was not rewritten; the three
   historical findings at `de0f47f` are suppressed in `.gitleaksignore` by their exact
   finding fingerprints (commit:file:rule:line) — no path, rule, entropy, or pattern
   exemptions.
3. **Genuine full-history secret scan** — the gitleaks-action (which scanned
   `--log-opts=-1`) is replaced by the pinned `zricethezav/gitleaks:v8.24.3` image (by
   digest) running `gitleaks git --log-opts=--all` over a `fetch-depth: 0` checkout.
   The evidence artifact records scanner version, the exact command, the scanned
   revision count (`git rev-list --all --count`), the SARIF report, and the
   suppressions file.
4. **Formatting gate** — Prettier is configured (`.prettierrc`, `.prettierignore` —
   which excludes the byte-identical f76a27a fixtures) and `npm run format:check` runs
   in CI as a third ratchet dimension: **31 files** are recorded formatting debt; any
   growth fails. The application was not mass-formatted; only FBL-000-R1's own new
   files were formatted before recording the baseline.
5. **Fingerprint equality enforced in CI, not asserted locally** — the
   migration-upgrade job now builds the current schema twice (fresh chain in a second
   database; fixture + legacy seed + upgrade in the first), fingerprints both with the
   same script, and **fails on any difference**, publishing `fingerprint-equality.txt`.
   `scripts/verify-upgrade-state.ts` additionally proves the legacy seed survived and
   that both 050 CHECK constraints remain `NOT VALID` (`pg_constraint.convalidated =
   false`).
6. **Migration manifest** — `scripts/migration-manifest.ts` publishes SHA-256 checksums
   for the current chain (baseline-evidence) and for the retained fixtures
   (upgrade-evidence), so fixture drift is visible in every run.
7. **Evidence completeness is itself gated** — each job ends by asserting every
   required artifact exists and is non-empty; `pipefail` is set in every step that
   pipes a gating command through `tee`, so no failure can be swallowed by the pipe.
8. **This report corrected** — the false acceptance claim is replaced by the record
   above. This correction does not claim its own CI run is green; the completion
   response carries the authoritative run URL after the run finishes.

## Warnings

- The v4-generation pinned actions (checkout, setup-node, upload-artifact) execute on
  the Actions node20 runtime, which GitHub has deprecated in favor of node24; runs may
  carry deprecation annotations until Dependabot's major-version PRs are taken. The
  gitleaks-action (also node20) is no longer used.
- Node prints `DEP0190` (shell:true child spawn) when `quality-ratchet.ts` runs on
  Windows; the shell fallback exists for `npx` resolution on win32 only and does not
  fire on Linux CI.
- On Windows checkouts with `core.autocrlf=true`, git reports LF→CRLF conversion;
  repository content is LF. No functional effect.
- The test suites must run serially (`--test-concurrency=1`); a documented harness
  constraint.

## Flaky tests

None currently known: 115 passed / 0 failed / 0 skipped locally under
`REQUIRE_DB_TESTS=1`, and the same result inside the failed `de0f47f` run — the CI
failure was the harness's parser, not any test. One historical flake is on record and
fixed (the `updated_at` trigger test, which once compared millisecond-truncated clock
readings; it now proves both directions inside PostgreSQL).

## Typing and lint debt (ratcheted, not fixed — per the work order)

`noImplicitAny`: **0** (enforced in the main tsconfig).

`tsconfig.strict.json` (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
`noImplicitOverride`): **59 errors** — routes 33, service 9, docs-test 4, auth 3,
step-up 3, others 7.

ESLint (typescript-eslint recommended): **136 findings** — 2 errors
(`preserve-caught-error`, `no-useless-assignment`) and 134 warnings, of which 133 are
`@typescript-eslint/no-explicit-any`.

Formatting (Prettier): **31 files** not formatter-clean.

All three dimensions are recorded per file in `quality-baselines.json`;
`scripts/quality-ratchet.ts` fails CI on any growth. FBL-000/R1's own new scripts carry
zero debt in all three dimensions. Pay-down belongs to the FBL-010+ module moves.

## Package findings

- `npm audit`: **0 vulnerabilities** (all severities) at 2026-07-30; CI re-checks every
  run and gates at high.
- Runtime dependencies: `express`, `pg`, `prom-client` (78 SBOM components including
  transitives).
- Dev-only additions across FBL-000/R1: `eslint`, `@eslint/js`, `typescript-eslint`,
  `prettier`.
- `package-lock.json` is load-bearing in CI (`npm ci`) and the container build.

## Unresolved environment assumptions

1. **Container build is CI-verified only.** Docker Desktop on the development machine
   is down (known afunix driver issue; OS reboot required). The image is validated by
   layout simulation locally and built for real only in the CI `container` job.
2. **Node skew.** Development machine runs Node 24.18.0; supported/CI/container is
   Node 20 (20.20.2). With the TAP reporter pinned, the reporter-selection skew that
   broke the first run cannot recur; `engines` allows `>=20 <25`.
3. **Local PostgreSQL service is off-limits** (unknown credentials); all local database
   work uses disposable scratch clusters or compose.
4. **`/metrics` and `/healthz` are unauthenticated by design**; gate at the ingress.
5. **`node:test` on Node 20 has no `junit` reporter**; the normalized
   `test-summary.json` is the machine-readable artifact instead.
6. **Blueprint reference frame.** The blueprint's §2.2 measured the pre-integration
   state (43 portable tests, 39 endpoints). Head now: 115 tests, 44 endpoints,
   migrations 000/049–054. Findings F-01…F-12 remain valid and deliberately
   unaddressed here (FBL-060 owns F-01/02/03).

## Acceptance gate status

Assessed by the architect against the actual `ci` workflow run for the FBL-000-R1
correction head — per-job conclusions, artifact inventory, and the normalized test
summary. This report makes no claim about that run's outcome; the completion response
carries the run URL and evidence after the run concludes.
