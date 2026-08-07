/**
 * NEGATIVE FIXTURE — EVASION (i): the table name is ONE OF TWO ALTERNATIVES.
 *
 * Three spellings of the same trick — a conditional, a `??` fallback and a `||`
 * fallback — each with an innocent name in the position a reader's eye lands on
 * first and `role_bindings` in the other. The reads underneath are the original
 * defect shape: `status` filtered, the effective window dropped, the shared
 * predicate absent.
 *
 * The guard resolves an alternative to BOTH branches and judges the statement in
 * each, so neither branch can shelter behind the other. This file is what fails
 * if that is ever narrowed to the first branch — the three statements would then
 * read `audit_events` only, and the role-bindings reads would go unexamined.
 *
 * Sibling of (g) and (h): the same "many possible strings" property, reached
 * through the third of the three shapes that produce it.
 */
interface FixtureExecutor {
  query(sql: string, params: readonly unknown[]): Promise<{ rows: Array<{ n: string }> }>;
}

const AUDIT_TABLE = 'audit_events';
const BINDINGS_TABLE = 'role_bindings';
/** Set when an operator has pinned the census to the audit log. */
const PINNED_TABLE = 'audit_events';

export async function driftingConditionalCount(
  executor: FixtureExecutor,
  auditOnly: boolean,
  tenantId: string,
): Promise<string> {
  const table = auditOnly ? AUDIT_TABLE : BINDINGS_TABLE;
  const result = await executor.query(
    `SELECT COUNT(*)::text AS n FROM ${table} rb
      WHERE rb.tenant_id = $1 AND rb.status = 'active'`,
    [tenantId],
  );
  return result.rows[0]?.n ?? '0';
}

export async function driftingNullishCount(
  executor: FixtureExecutor,
  tenantId: string,
): Promise<string> {
  const table = PINNED_TABLE ?? BINDINGS_TABLE;
  const result = await executor.query(
    `SELECT COUNT(*)::text AS n FROM ${table} rb
      WHERE rb.tenant_id = $1 AND rb.status = 'active'`,
    [tenantId],
  );
  return result.rows[0]?.n ?? '0';
}

export async function driftingOrElseCount(
  executor: FixtureExecutor,
  tenantId: string,
): Promise<string> {
  const table = PINNED_TABLE || BINDINGS_TABLE;
  const result = await executor.query(
    `SELECT COUNT(*)::text AS n FROM ${table} rb
      WHERE rb.tenant_id = $1 AND rb.status = 'active'`,
    [tenantId],
  );
  return result.rows[0]?.n ?? '0';
}
