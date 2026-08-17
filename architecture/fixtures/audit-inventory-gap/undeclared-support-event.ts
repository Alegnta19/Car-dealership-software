/**
 * NEGATIVE FIXTURE (FBL-020-R4 §3) — deliberately WRONG.
 *
 * A new transition inside the inventory's OWN declared `support` family, writing an
 * event type the inventory does not list. This is the exact shape of the finding the
 * gate closes: `identity.support.expired` was in this position in the real tree — written
 * by §4's expiry processor, absent from the inventory, and invisible to a green suite.
 *
 * The checker must reject it as `audit-event-type-missing-from-inventory`.
 */
import { query } from '@dealer/database';

export async function endSupportWindowQuietly(supportSessionId: string): Promise<void> {
  await query(
    `INSERT INTO audit_events (tenant_id, event_type, entity_type, entity_id, details)
     SELECT tenant_id, 'identity.support.quietly_ended', 'support_access_session',
            support_session_id, '{}'::jsonb
       FROM support_access_sessions WHERE support_session_id = $1`,
    [supportSessionId],
  );
}
