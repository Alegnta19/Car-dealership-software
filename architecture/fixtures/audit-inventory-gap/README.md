# Audit-inventory gap fixtures (FBL-020-R4 §3)

Every file in this directory is deliberately WRONG. Each one is a way an identity audit
event could come into existence without appearing in
`packages/identity-access/src/audit-inventory.ts`, and
`scripts/check-audit-inventory.ts` must REJECT each one by name.

The sibling directory `../audit-inventory-declared/` holds the mirror image: a file that
names an event type the inventory already carries, which must PASS. A checker that
rejected any extra file it was pointed at would prove nothing, and that directory is what
stops this one from being satisfied by a checker that simply always fails.

| fixture                       | rule it must trip                         |
| ----------------------------- | ----------------------------------------- |
| `undeclared-support-event.ts` | `audit-event-type-missing-from-inventory` |
| `assembled-event-type.ts`     | `audit-event-type-assembled-at-run-time`  |
| `undeclared-writer.ts`        | `audit-write-outside-declared-writer`     |

`undeclared-support-event.ts` is the exact shape of the finding this gate closes: an event
type inside the inventory's own declared `support` family that the inventory does not
list. `identity.support.expired` was that shape in the real tree, and the suite stayed
green.

Nothing here is compiled: the fixtures are excluded from every tsconfig, imported by
nothing, and exist purely as input to the checker.
