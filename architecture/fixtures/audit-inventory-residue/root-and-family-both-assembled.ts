/**
 * RESIDUE FIXTURE (FBL-020-R4 §3, correction F1b) — deliberately WRONG, and
 * deliberately NOT CAUGHT. `scripts/check-audit-inventory.ts` must ACCEPT this file.
 *
 * This is what "an accurate narrower claim beats an inaccurate absolute" looks like as
 * a test. The gate refuses a name whose ROOT is readable and whose tail is not
 * (`identity.support.${x}`), and a name whose root is unreadable but whose next
 * segment is a DECLARED FAMILY (`${root}.support.quarantined`). With NEITHER readable,
 * nothing in the string identifies it as an event type in the inventoried namespace,
 * and reporting every unresolvable string in the repository would make the gate
 * unusable.
 *
 * So the limit is stated in three places rather than implied away — this file, the
 * gate's own header, and `docs/identity/KNOWN-LIMITATIONS.md` — and this file is the
 * proof that the limit is REAL and not a hypothetical hedge. What still holds such a
 * write down is step 3: the `INSERT INTO audit_events` may only live in a file listed
 * in `AUDIT_EVENT_WRITERS`, which `../audit-inventory-gap/undeclared-writer.ts` proves.
 *
 * If a later revision closes this residue, THIS FILE MUST MOVE to
 * `../audit-inventory-assembly/` and the limitation must come out of the documents.
 */
export function renamedEvent(root: string, family: string): string {
  return `${root}.${family}.renamed`;
}

/** The same residue in its concatenated spelling. */
export function renamedEventTwo(root: string, family: string): string {
  return root + '.' + family + '.renamed_two';
}
