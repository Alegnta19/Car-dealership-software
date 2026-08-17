/**
 * NEGATIVE FIXTURE (FBL-020-R4 §5) — deliberately WRONG.
 *
 * The evasion that hides the table behind an interpolation, which is precisely the
 * shape the deleted `setUnitStatus` had. The guard must reject it as
 * `owned-mutation-target-not-statically-resolvable` even though no owned table name
 * appears in the literal at all.
 */
import { query } from '@dealer/database';

const TABLES: Record<string, string> = { rooftop: 'rooftops', department: 'departments' };

export async function setStatus(level: string, id: string, status: string): Promise<void> {
  const table = TABLES[level] ?? 'rooftops';
  await query(`UPDATE ${table} SET status = $2 WHERE tenant_id = $1`, [id, status]);
}
