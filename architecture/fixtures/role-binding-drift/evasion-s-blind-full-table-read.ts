/**
 * NEGATIVE FIXTURE — A BLIND TABLE POSITION WITH NO CLAUSE AFTER IT.
 *
 * The header's account of what crossing a function boundary costs ended with a
 * consolation: the helper's own body is in scope, so a parameter interpolated
 * into a table position is a blind table position and rule 4 reports it there.
 * That was true only of statements that ALSO carried a clause keyword. Rule 4
 * asks for two structural marks before it will call a string a statement —
 * otherwise `update ${label}` in prose is a violation — and the second mark used
 * to be a clause and nothing else.
 *
 * So the most dangerous shape there is, an UNGUARDED FULL-TABLE READ, was the one
 * shape that carried no clause: `readEverything` below was reported nowhere,
 * while `readEverythingCapped` — the same read with a `LIMIT` on it — was
 * reported. A SELECT LIST standing immediately before the blind `FROM` is now
 * the second mark too, so both are reported and neither can reach the table
 * without a reviewer seeing it.
 *
 * Both statements raise rule 4 and only rule 4: the guard cannot say which table
 * either one reads, which is the whole point of reporting them.
 */
interface FixtureExecutor {
  query(sql: string, params: readonly unknown[]): Promise<{ rows: Array<{ role: string }> }>;
}

/** The demonstrated hole: no WHERE, no ORDER BY, no LIMIT — and every row. */
export async function readEverything(
  executor: FixtureExecutor,
  table: string,
): Promise<readonly { role: string }[]> {
  const result = await executor.query(
    `SELECT role_binding_id, role, user_link_id, tenant_id FROM ${table}`,
    [],
  );
  return result.rows;
}

/** The control: the SAME read, reported before this correction and after it. */
export async function readEverythingCapped(
  executor: FixtureExecutor,
  table: string,
): Promise<readonly { role: string }[]> {
  const result = await executor.query(
    `SELECT role_binding_id, role, user_link_id, tenant_id FROM ${table} LIMIT 500`,
    [],
  );
  return result.rows;
}
