/**
 * NEGATIVE FIXTURE (FBL-010-R1 section F) — this file is deliberately WRONG.
 *
 * It does what an app must never do: imports a database query primitive and embeds a
 * SQL statement in application code. The app-SQL guard (scripts/check-app-sql.ts) must
 * REJECT it; the architecture test passes only because this file produces a nonzero
 * result. Excluded from every tsconfig and never compiled into anything.
 */
import { query } from '@dealer/database';

export async function forbiddenBusinessQuery(tenantId: string): Promise<unknown> {
  return query(`SELECT * FROM repair_orders WHERE tenant_id = $1`, [tenantId]);
}
