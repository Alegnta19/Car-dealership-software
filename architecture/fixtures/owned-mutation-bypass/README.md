# Owned-mutation bypass fixtures (FBL-020-R4 §5)

Every file in this directory is deliberately WRONG. Each reintroduces one of the bypasses
the §5 boundary exists to prevent, and `scripts/check-owned-mutations.ts` must REJECT each
one by name. `tests/owned-mutations.test.ts` runs the guard against this directory and
fails if any fixture is accepted — so the proof that the guard bites is executable rather
than asserted in a report.

The sibling directory `../owned-mutation-correct/` holds the mirror image: files that use
the sanctioned paths and must PASS. A guard that rejected everything would be equally
useless, and that directory is what stops this one from being satisfied by a checker that
simply always fails.

| fixture                            | rule it must trip                                 |
| ---------------------------------- | ------------------------------------------------- |
| `unattributed-repository-write.ts` | `owned-mutation-write-outside-owner`              |
| `bootstrap-script-raw-write.ts`    | `owned-mutation-write-outside-owner`              |
| `interpolated-table-write.ts`      | `owned-mutation-target-not-statically-resolvable` |
| `assembled-statement-write.ts`     | `owned-mutation-write-outside-owner`              |
| `production-imports-test-kit.ts`   | `test-kit-must-not-be-imported-by-production`     |

Nothing here is compiled: the fixtures are excluded from every tsconfig, imported by
nothing, and exist purely as input to the guard.
