# FBL-020 — Identity Boundary: Delivery Report (R2)

Governing document: **Master Blueprint v2.0, §14.3**. This report supersedes
every earlier version; prior evidence is discarded, not amended.

**Status: FBL-020 CODE COMPLETE — LIVE CERTIFICATION PENDING.**
Gate B is not attempted: no live WorkOS credentials exist in this
environment. **FBL-030 has not been started.**

## 1. Heads and exact CI runs

|                      |                                                                                                                                                                   |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Base head (R2 order) | `359de3020056e09700e4d8a4668c4a7010adcac4`                                                                                                                        |
| Code-bearing head    | `ff313702f645ce69c858f581d8bc456024ded4ad`                                                                                                                        |
| Code-bearing run     | [30929301450](https://github.com/Alegnta19/Car-dealership-software/actions/runs/30929301450) — `head_sha` equals the commit, event `push`, conclusion **success** |
| Documentation head   | see §9                                                                                                                                                            |

| Job (code-bearing run)                           | Conclusion |
| ------------------------------------------------ | ---------- |
| typecheck, lint ratchet, build, all tests, scans | success    |
| upgrade from earliest retained schema fixture    | success    |
| container build (digest-pinned base)             | success    |
| secret scan (genuine full history)               | success    |

| Artifact               | Size     | sha256 (first 32, as downloaded)   |
| ---------------------- | -------- | ---------------------------------- |
| `baseline-evidence`    | 50,020 B | `44390a71554d6cee1fb2a50d77a10d5e` |
| `upgrade-evidence`     | 30,454 B | `49bc98af5906025c688362e34b18d3c2` |
| `secret-scan-evidence` | 8,108 B  | `476a8b9615c1df801ca83033378537e1` |
| `container-evidence`   | 700 B    | `26978a9940204ec9fb034f641c00dd71` |

## 2. Migrations

`git diff 359de30..HEAD -- migrations/` shows **no change** to 000 or
049–056: byte-identical. Migration 057 is additive — one table created
(`login_transactions`), no rows deleted.

`057_identity_boundary_completion.sql` sha256
`af29b31f4bb58b0d7956b3f5132fef0eb83c6dacfd774fe201387e1b02b20315`.

**Authoritative in-CI fingerprint:** fresh == upgraded ==
`59107a0b2ab52009aab9fd69ed3675b05ca869002f6dac0d080af2a251d25b7d`,
`equal=true`. (Local runs produced `8a8e215f…` for the same schema; catalog
text differs across PostgreSQL builds, so local values corroborate only.)

Upgrade reconciliation: `Upgrade-state verification OK` — legacy rows
survived, and no identity, session, grant or support row was invented.

## 3. What R2 changed

**Unprovable is closed, not grandfathered.** Migration 057 revoked every
session that could not name its connection and issuer, and disabled every
link that could not be bound to exactly one active connection. Nothing was
guessed.

**Exact binding.** UserLink, local session and reauthentication transaction
each carry provider, configured issuer, provider organization, provider
subject, tenant and connection. An activated link and a live session must be
fully bound — enforced by CHECK, so the unbound state is unrepresentable.

**The nullable-connection bypass is gone.** R1 wrote
`if (session.connectionId !== null)`, so a null connection skipped
validation. R2 refuses such a session in the middleware _and_ forbids it in
the schema.

**Server-side login.** `login_transactions` owns state, nonce, PKCE and
redirect as digests, expires on its own clock, and is claimed by an atomic
conditional UPDATE. The sealed cookie is a pointer. A replay loses a database
race; a failed exchange burns the state.

**The assurance floor.** R1 stored `assurance_level` and never read it, so a
`fresh_only` grant could authorize a money-affecting operation. The floor is
enforced inside the same UPDATE that spends the grant, and a refused
high-assurance consumption leaves the grant **unspent**.

**Refresh rotation.** Keyed on the current digest, so a replayed refresh
token changes nothing; identity mismatch, refresh failure or impersonation
revokes the local session immediately.

**Evidence.** Every decision records auth_time, connection, session, actor
provider subject, matched bindings with versions, freshness and MFA
classification, and a correlation id distinct from the request id.

**Support approval** requires the approver's own consumed, high-assurance
grant — separation of duty alone no longer suffices.

**Transport.** HTTPS and Secure cookies everywhere except explicitly declared
local development. `NODE_ENV` alone is not the switch, because staging
commonly runs `NODE_ENV=production` and a shared host running
`NODE_ENV=development` must not silently downgrade.

## 4. Tests

**230/230 in CI** — 0 failed, 0 skipped, 0 cancelled, 0 todo, 25 suites
(floor 221, base 221).

New `tests/identity-boundary.test.ts` carries nine R2 proofs: login replay,
expired transaction, unbound-session impossibility, refresh rotation and
replay, the assurance floor (with the grant left unspent), high-assurance
certification, reauthentication identity mismatch, and support approval
without a grant.

Fixtures that encoded pre-R2 behavior were **updated to the new contract, not
weakened** — including the HTTPS test, which previously asserted the very
loophole §14.3 closes.

## 5. Defects introduced by this wave and caught before submission

1. `withTransaction` used inside an app file — the app-SQL guard rejected it;
   the claim moved into a package wrapper.
2. Test kit and bootstrap created _activated_ links without the binding the
   new schema requires.
3. `ensureActiveConnection(tenantId)` inserted into a function whose
   parameter is named `tenant`.
4. Two single-line imports broken by a naive inserter.
5. The journey activated the platform support identity _before_ its platform
   connection existed — an ordering that was invisible while activation
   asserted no binding.

## 6. Quality and scope

tsc-strict **53**, eslint **123**, format **1** — ceilings **59 / 136 / 23**
not raised. Architecture checks 4/4. Raw-output sentinel scan: **0 matches**.

No vehicle, inventory, CRM, BDC, marketing, sales, UI or repair functionality
was added. Fixed Ops behavior is unchanged except the narrowly authorized
assurance correction (money-affecting operations now demand
`fresh_and_mfa_policy`).

## 7. What this still does NOT prove

- **No live WorkOS behaviour is exercised.** Real AuthKit parameters, real
  claim shapes, real `max_age=0` semantics, real organization membership and
  the **actual MFA-required organization policy** are untested — Gate B.
- The SDK adapter compiles and is confinement-tested; no test invokes it.
- Audit rows are transactional; durable delivery is **not** claimed (FBL-040).
- RLS remains FBL-030.

## 8. Position

FBL-000 closed → FBL-010 closed → **FBL-020-R2 submitted for code-gate
review** → live certification blocked → FBL-030 **not started**.

## 9. Documentation head

Recorded after the documentation push, from the run whose `head_sha` equals
that commit. The code evidence above belongs to run 30929301450 and is not
altered by a documentation-only change.
