/**
 * OUTCOME 6 — THE CLOCK: EXPIRY, RECORDED BY THE SYSTEM LANE.
 *
 * A ceremony that nobody finished before `expires_at` is expired; the package
 * it was signing is expired with it; its signers who had not signed are
 * expired too. Nothing decides this but the clock, so nothing but the worker
 * records it — through the SYSTEM lane, with no acting user, because there
 * was no acting user. The event ledger says so in as many words.
 *
 * WHAT EXPIRY DOES NOT DO. It does not touch a signature already given, a
 * document already rendered, or a jacket: the jacket stays open with an expired
 * package on it, which is the board's "rejected or expired signatures" queue
 * and somebody's job to re-assemble and re-send.
 *
 * The pass is per tenant under the tenant's own context, exactly as Release
 * Train 3's sweeps run, and idempotent by construction: a ceremony is moved
 * from `sent`/`in_progress` to `expired` once, and a second pass finds
 * nothing to move.
 */
import { query, withTenantTransaction } from '@dealer/database';
import { enqueueAdminOutboxEvent } from '@dealer/identity-access';

import { recordCeremonyEventWithin } from './ceremony';

interface Row {
  [key: string]: unknown;
}

async function activeTenantIds(limit: number): Promise<string[]> {
  const found = await query(
    `SELECT tenant_id::text AS tenant_id FROM tenants WHERE status = 'active' ORDER BY tenant_id LIMIT $1`,
    [limit],
  );
  return found.rows.map((r) => String((r as Row).tenant_id));
}

export interface ExpiryPass {
  readonly tenantsVisited: number;
  readonly ceremoniesExpired: number;
}

export async function expireDueCeremoniesForTenant(
  tenantId: string,
  now: string = new Date().toISOString(),
  limit = 100,
): Promise<number> {
  return withTenantTransaction(tenantId, async (tx) => {
    const due = await tx.query(
      `SELECT ceremony_id, package_id, jacket_id FROM signing_ceremonies
        WHERE tenant_id = $1 AND state IN ('sent', 'in_progress') AND expires_at <= $2::timestamptz
        ORDER BY expires_at
        LIMIT $3
        FOR UPDATE SKIP LOCKED`,
      [tenantId, now, limit],
    );
    for (const row of due.rows) {
      const r = row as Row;
      const ceremonyId = String(r.ceremony_id);
      await tx.query(
        `UPDATE signing_ceremonies
            SET state = 'expired', updated_at = NOW(), authorization_version = authorization_version + 1
          WHERE tenant_id = $1 AND ceremony_id = $2`,
        [tenantId, ceremonyId],
      );
      await tx.query(
        `UPDATE ceremony_signers
            SET state = 'expired', updated_at = NOW(), authorization_version = authorization_version + 1
          WHERE tenant_id = $1 AND ceremony_id = $2 AND state NOT IN ('signed', 'declined', 'expired')`,
        [tenantId, ceremonyId],
      );
      await tx.query(
        `UPDATE jacket_packages
            SET state = 'expired', state_reason = 'the signing ceremony expired', updated_at = NOW(),
                authorization_version = authorization_version + 1
          WHERE tenant_id = $1 AND package_id = $2 AND state IN ('sent', 'partially_signed')`,
        [tenantId, String(r.package_id)],
      );
      await recordCeremonyEventWithin(tx, {
        tenantId,
        ceremonyId,
        signerId: null,
        eventType: 'ceremony.expired',
        lane: 'system',
        actorUserLinkId: null,
        payload: { expired_at: now, reason: 'expires_at passed before every signer signed' },
      });
      await enqueueAdminOutboxEvent(tx, {
        tenantId,
        eventType: 'jacket.ceremony.expired',
        payload: {
          jacket_id: String(r.jacket_id),
          package_id: String(r.package_id),
          ceremony_id: ceremonyId,
        },
      });
    }
    return due.rows.length;
  });
}

/** One pass over every active tenant. */
export async function runCeremonyExpiryPass(options?: {
  now?: string;
  tenantLimit?: number;
  perTenantLimit?: number;
}): Promise<ExpiryPass> {
  const tenants = await activeTenantIds(options?.tenantLimit ?? 200);
  let expired = 0;
  for (const tenantId of tenants) {
    expired += await expireDueCeremoniesForTenant(
      tenantId,
      options?.now ?? new Date().toISOString(),
      options?.perTenantLimit ?? 100,
    );
  }
  return { tenantsVisited: tenants.length, ceremoniesExpired: expired };
}
