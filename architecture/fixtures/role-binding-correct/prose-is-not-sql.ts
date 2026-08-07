/**
 * POSITIVE FIXTURE — FALSE POSITIVE (5): English that reads like SQL.
 *
 * Rule 4 reports a table position it cannot resolve, and it now accepts a SELECT
 * LIST as the second structural mark that makes a string a statement — because
 * an unguarded full-table read (`role-binding-drift/evasion-s-…`) carries no
 * clause keyword at all and was reported nowhere.
 *
 * That widening has to stop where English begins. "Select a vehicle from
 * ${dealership}" has a verb, a `from` and an unresolvable table position; the
 * only thing separating it from a statement is that "a vehicle" is two words
 * where a projection list would be one item. A projection item is a name,
 * optionally called, cast and aliased — never two words with a space between
 * them — so these strings are NOT statements, are NOT inspected, and the
 * inspected count this directory is pinned to does not move.
 *
 * A guard that reported these would be reported constantly, which is how a guard
 * gets switched off.
 */
export function chooseVehiclePrompt(dealership: string): string {
  return `Select a vehicle from ${dealership}`;
}

export function updateNotice(label: string): string {
  return `Update ${label} before the next scheduled inspection`;
}

export function transferNotice(count: number, source: string): string {
  return `Select ${count} open repair orders from ${source} and reassign them`;
}
