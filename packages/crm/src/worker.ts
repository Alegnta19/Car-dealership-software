/**
 * RELEASE TRAIN 3 — THE BACKGROUND PASSES, ACROSS TENANTS.
 *
 * The services in this package are TENANT-BOUND by design: every one of them
 * runs inside `withTenantTransaction`, because migration 063's tables are
 * row-secured and a query without a tenant context sees nothing. The worker is
 * the one caller that legitimately spans tenants, so the fan-out lives here and
 * nowhere else.
 *
 * THE FAN-OUT IS DRIVEN FROM `tenants`, which carries no row security and which
 * the runtime may read. Driving it from the work itself is not possible and
 * that is the point: if a pass could see due work across tenants without a
 * context, so could anything else holding the same login.
 *
 * A NOTE ON SCALE, STATED RATHER THAN GLOSSED. This visits every active tenant
 * on every pass. At a few hundred dealerships that is a few hundred cheap
 * queries and entirely fine; at ten thousand it is not, and the answer then is a
 * due-work index outside row security rather than a bigger loop. It is written
 * plainly here so the next person does not discover the shape by profiling it.
 */
import { query } from '@dealer/database';
import { dispatchDueSends, drainMarketingOutbox, type DispatchResult } from './sends';
import { runEscalationSweep } from './routing';
import type { MessageProvider } from './providers';

interface Row {
  [key: string]: unknown;
}

/** The tenants a background pass should visit. */
async function activeTenantIds(limit: number): Promise<string[]> {
  const found = await query(
    `SELECT tenant_id::text AS tenant_id FROM tenants
      WHERE status = 'active' ORDER BY tenant_id LIMIT $1`,
    [limit],
  );
  return (found.rows as Row[]).map((r) => String(r.tenant_id));
}

export interface CampaignDispatchPass {
  readonly tenantsVisited: number;
  readonly outboxDelivered: number;
  readonly outboxReplayed: number;
  readonly sent: number;
  readonly deferred: number;
  readonly suppressed: number;
  readonly retrying: number;
  readonly failed: number;
}

/**
 * ONE PASS of the campaign dispatcher, over every active tenant.
 *
 * Two things happen per tenant and their order matters: the marketing outbox is
 * drained first, so a launch that has just committed is acknowledged exactly
 * once through the delivery ledger; then due sends are dispatched, which is
 * where suppression and quiet hours are re-checked immediately before anything
 * reaches a provider.
 */
export async function runCampaignDispatchPass(options?: {
  provider?: MessageProvider | undefined;
  perTenantLimit?: number | undefined;
  tenantLimit?: number | undefined;
}): Promise<CampaignDispatchPass> {
  const tenants = await activeTenantIds(options?.tenantLimit ?? 200);
  let outboxDelivered = 0;
  let outboxReplayed = 0;
  const totals: DispatchResult[] = [];

  for (const tenantId of tenants) {
    const drained = await drainMarketingOutbox({ tenantId });
    outboxDelivered += drained.delivered;
    outboxReplayed += drained.replayed;
    totals.push(
      await dispatchDueSends({
        tenantId,
        ...(options?.provider === undefined ? {} : { provider: options.provider }),
        limit: options?.perTenantLimit ?? 25,
      }),
    );
  }

  return {
    tenantsVisited: tenants.length,
    outboxDelivered,
    outboxReplayed,
    sent: totals.reduce((n, r) => n + r.sent, 0),
    deferred: totals.reduce((n, r) => n + r.deferred, 0),
    suppressed: totals.reduce((n, r) => n + r.suppressed, 0),
    retrying: totals.reduce((n, r) => n + r.retrying, 0),
    failed: totals.reduce((n, r) => n + r.failed, 0),
  };
}

export interface SlaSweepPass {
  readonly tenantsVisited: number;
  readonly examined: number;
  readonly escalated: number;
  readonly alreadyEscalated: number;
}

/**
 * ONE PASS of the first-response sweep, over every active tenant. Idempotent by
 * construction — see `runEscalationSweep` — so running it twice, or twice at
 * once, raises each alarm exactly once.
 */
export async function runSlaSweepPass(options?: {
  perTenantLimit?: number | undefined;
  tenantLimit?: number | undefined;
}): Promise<SlaSweepPass> {
  const tenants = await activeTenantIds(options?.tenantLimit ?? 200);
  let examined = 0;
  let escalated = 0;
  let already = 0;
  for (const tenantId of tenants) {
    const result = await runEscalationSweep({
      tenantId,
      limit: options?.perTenantLimit ?? 100,
    });
    examined += result.examined;
    escalated += result.escalated;
    already += result.alreadyEscalated;
  }
  return {
    tenantsVisited: tenants.length,
    examined,
    escalated,
    alreadyEscalated: already,
  };
}
