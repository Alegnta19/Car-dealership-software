/**
 * NEGATIVE FIXTURE (FBL-020-R4 §3) — deliberately WRONG.
 *
 * The evasion that would defeat a literal scan: the event type is ASSEMBLED at run time,
 * so no complete name exists in the source for the inventory to be compared against. One
 * such call site would make every completeness claim in the inventory unprovable, which is
 * why the construction is refused rather than tolerated.
 *
 * The checker must reject it as `audit-event-type-assembled-at-run-time`.
 */
import { query } from '@dealer/database';

export async function auditSessionOutcome(sessionId: string, outcome: string): Promise<void> {
  await query(
    `INSERT INTO audit_events (tenant_id, event_type, entity_type, entity_id, details)
     VALUES ($1, $2, 'identity_session', $3, '{}'::jsonb)`,
    ['00000000-0000-0000-0000-000000000000', `identity.session.${outcome}`, sessionId],
  );
}
