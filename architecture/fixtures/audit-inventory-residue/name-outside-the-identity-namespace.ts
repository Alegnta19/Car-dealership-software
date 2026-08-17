/**
 * RESIDUE FIXTURE (FBL-020-R4 §3, correction F1b) — deliberately NOT CAUGHT by the
 * NAME rules. `scripts/check-audit-inventory.ts` must ACCEPT this file.
 *
 * The inventory is complete over the `identity.` namespace, not over `audit_events`.
 * A name in another namespace is not compared to anything here, and this file is the
 * proof of that limit rather than a sentence asserting it.
 *
 * What is NOT residue: the WRITE. Add an `INSERT INTO audit_events` to this file and
 * the declared-writer rule refuses it, which is exactly what
 * `../audit-inventory-gap/undeclared-writer.ts` demonstrates with this same
 * `tenant.provisioned` name. The residue is the NAME being unexamined, not the write
 * being unguarded.
 */
export const TENANT_PROVISIONED = 'tenant.provisioned';
export const SERVICE_ORDER_CLOSED = 'service.order_closed';
