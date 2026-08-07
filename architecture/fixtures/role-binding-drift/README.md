# Negative fixtures — role-bindings effectiveness (FBL-020-R3 §E3, hardened by H1/J1, closed out by L1–L3)

Every file in this directory is deliberately WRONG, and
`scripts/check-role-binding-effectiveness.ts` must REJECT it.
`tests/architecture.test.ts` runs the guard once over the whole directory and asserts,
by deep equality in both directions, the exact set of rules each file raises AND how many
violations it raises — so a fixture that stopped biting fails the suite instead of
quietly becoming decorative, and so does a fixture rejected for a reason it was not
written to prove. The count matters because most of these files hold several drifting
statements reached by different mechanisms: without it, one of them could stop being
caught while a sibling in the same file went on raising the same rule names.

The set is in five groups.

**The EVASIONS** (`evasion-a` … `evasion-f`) each passed the pre-H1 guard with exit 0.
They are the reason the guard was rewritten: the old one matched text shapes, so SQL
that never spelled `role_bindings` in a single literal, or that interpolated the shared
predicate and then neutralised it, or that carried twenty characters of unvalidated
prose as an "opt-out", was reported as `0 statement(s) inspected, OK`.

**The MANY-POSSIBILITY trio** (`evasion-g`, `evasion-h`, `evasion-i`) pins a property of
the rebuilt guard rather than a hole in the old one: an interpolation that could be
several strings is judged in EVERY one of them, not in a sample. They cover the three
shapes that produce several — an object literal under an unresolvable key, a `for … of`
over an array, and a `?:`/`??`/`||` alternative. Each file leads with an innocent
possibility (`audit_events`) and hides the role-bindings read behind it, so a resolver
that returned one value per expression would clear all three.

**The ASSEMBLY set** (`evasion-j` … `evasion-r`) is the J1 correction. The H1 guard
resolved `${…}` interpolation and `+` and nothing else, so the fragments of
`evasion-b` — one piece that names the table, one that says SELECT, one that carries the
dropped window — combined by any OTHER spelling were invisible again. Every file here
is the same drift shape reached through a different assembly:

| file                                    | spelling                                                      | what the guard does with it                  |
| --------------------------------------- | ------------------------------------------------------------- | -------------------------------------------- |
| `evasion-j-array-join.ts`               | `[…].join('')`, spread, `push`                                | resolves it exactly                          |
| `evasion-k-string-concat.ts`            | `.concat(…)`, and a chain of them                             | resolves it exactly                          |
| `evasion-l-string-raw.ts`               | `String.raw`                                                  | resolves the RAW text                        |
| `evasion-m-opaque-string-operations.ts` | `.replace`, `.slice`, `.toLowerCase` on a COMPLIANT statement | keeps the receiver, reports the rewrite      |
| `evasion-n-reduce-accumulation.ts`      | `.reduce`                                                     | resolves the elements, reports the fold      |
| `evasion-o-custom-template-tag.ts`      | a tag that is not `String.raw`                                | resolves the template, reports the tag       |
| `evasion-p-array-transforms.ts`         | `.slice`, `.map`, `.flat`, `Object.values`, array `.concat`   | exact for three, reported for `.map`/`.flat` |
| `evasion-q-indexed-fragments.ts`        | `PARTS[0]`, `PARTS.at(0)`                                     | resolves the index                           |
| `evasion-r-accumulated-statement.ts`    | `+=` and `n = n + …`                                          | reads the accumulator at its last append     |

`evasion-l` is the one worth reading twice. `String.raw` was not merely unresolved — it
was SKIPPED, on the reasoning that raw templates build regular expressions here. That
made it an undeclared, unvalidated, one-token exception needing no reason code and no
justification, which is the opposite of everything `evasion-d` and `evasion-d2` pin.

**The CLOSEOUT set** (`evasion-s` … `evasion-w`) is the L1–L3 correction, and it is a
different kind of fixture from everything above it. The J1 guard REJECTED none of these:
each one is a place where the header claimed more than the code delivered, which is the
same failure as drifting SQL one level up — a sentence a reader believes and a checker
does not keep.

| file                                           | what it exercises                                      | what the header used to claim             |
| ---------------------------------------------- | ------------------------------------------------------ | ----------------------------------------- |
| `evasion-s-blind-full-table-read.ts`           | `SELECT … FROM ${table}` with no clause after it       | any blind table position is reported      |
| `evasion-t-guarded-once-counted-twice.ts`      | the predicate interpolated TWICE into one read         | the predicate resolves into EVERY read    |
| `evasion-u-comment-carried-weakening.ts`       | `-- …` and `/* … */` between the predicate and an `OR` | an OR beside the predicate is a violation |
| `evasion-v-predicate-in-projection.ts`         | the predicate in the SELECT list, filtering nothing    | the predicate must be CONJOINED           |
| `evasion-w-negated-without-an-adjacent-not.ts` | De Morgan `NOT (x AND ${…})`, and `(${…}) IS NOT TRUE` | a NOT in front of the predicate is caught |

`evasion-t` is the one worth reading twice: rule 1 counted uses GLOBALLY, so a second
copy of the predicate inside one read bought a second, entirely unguarded read — which
is the exact shape `control-4-cte-rename-and-second-read.ts` was written to refuse. The
control was one edit away from being defeated by the drift it exists to catch.

What these fixtures do NOT contain is as deliberate: a rewrite that keeps the predicate
conjoined-LOOKING while discarding its result (`CASE WHEN ${…} THEN TRUE ELSE TRUE END`)
is still not caught, and is recorded in `docs/identity/KNOWN-LIMITATIONS.md` rather than
implied away by a fixture that does not exist.

**The controls** (`control-*`) were caught before and must still be caught: they are how
the rebuilt guard is shown not to have lost ground while gaining reach.

The sibling directory `architecture/fixtures/role-binding-correct/` is the other half of
the proof: correct code, including correct code assembled by the very mechanisms above,
which must pass cleanly.

None of these files is in any tsconfig, none is compiled, and none is imported by
anything that runs.
