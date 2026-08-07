# Positive fixtures — role-bindings effectiveness (FBL-020-R3 §H1, extended by J1 and L1)

Every file in this directory is CORRECT. `scripts/check-role-binding-effectiveness.ts`
must ACCEPT the whole directory with exit 0 and zero declared opt-outs, and
`tests/architecture.test.ts` additionally pins the number of statements INSPECTED — so a
file that quietly stopped being looked at fails the suite rather than passing by being
ignored.

Two of the first three shapes were REJECTED by the pre-H1 guard, which counted the
literal substring `${EFFECTIVE_ROLE_BINDING_SQL}`:

- `namespaced-import.ts` — `${policy.EFFECTIVE_ROLE_BINDING_SQL}`
- `aliased-import.ts` — `${EFFECTIVE}`, aliased at the import
- `direct-import.ts` — the plain spelling, which always passed

The last two are the false-positive controls for the J1 assembly work:

- `assembled-with-shared-predicate.ts` — the SAME fragments as
  `role-binding-drift/evasion-j-array-join.ts`, assembled by `.join`, by `.concat` and
  by a `String.raw` template, but resolving the shared predicate. The only difference
  between that file and this one is which predicate ends up in the WHERE clause, which
  is the only difference the guard is entitled to notice.
- `raw-regex-is-not-sql.ts` — `String.raw` templates that really do build regular
  expressions, quoting SQL keywords and naming the role-bindings table on purpose. The
  guard used to SKIP every raw template for their sake, which was also a one-token off
  switch for real SQL. It now resolves them and judges them, and they pass on their
  content rather than on their tag.

`prose-is-not-sql.ts` is the false-positive control for the L1 closeout. Rule 4 now
accepts a SELECT LIST as the second structural mark that makes a string a statement,
because an unguarded full-table read carries no clause keyword at all
(`role-binding-drift/evasion-s-blind-full-table-read.ts`). This file is where that
widening has to stop: "Select a vehicle from ${dealership}" has a verb, a `from` and an
unresolvable table position, and is a sentence. Its statements must NOT be inspected, so
the pinned inspection count does not move when they are added — which is what fails if
the projection pattern is ever loosened to something that matches English.

A guard that rejects correct code teaches authors to route around it, which is how the
drift it exists to prevent gets written in the first place.

None of these files is in any tsconfig, none is compiled, and none is imported by
anything that runs.
