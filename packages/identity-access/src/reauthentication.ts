/**
 * Provider-backed reauthentication (FBL-020, ADR-006) — the replacement for
 * every locally signed step-up trust path.
 *
 * Flow: a sensitive action STARTS a transaction (bound to tenant, user,
 * action and resource); the person re-authenticates at the provider with
 * max_age=0; the callback proves auth_time happened AFTER the transaction
 * started (bounded skew) and mints ONE single-use grant. Opaque values are
 * returned exactly once and stored only as SHA-256 digests. Consumption is
 * an atomic conditional UPDATE executed INSIDE the business transaction:
 * a replay fails closed, and a rolled-back business action leaves the grant
 * unconsumed because the action it paid for never happened.
 */
import { createHash, randomBytes } from 'node:crypto';
import { query, withTransaction, type Executor } from '@dealer/database';

function sha256hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export interface ReauthenticationTransaction {
  readonly reauthTxnId: string;
  readonly tenantId: string;
  readonly userLinkId: string;
  readonly action: string;
  readonly resourceType: string | null;
  readonly resourceId: string | null;
  readonly startedAt: Date;
  readonly expiresAt: Date;
  readonly state: 'started' | 'completed' | 'failed' | 'expired';
}

interface Row {
  [key: string]: unknown;
}

function ts(v: unknown): Date {
  return v instanceof Date ? v : new Date(String(v));
}

function mapTxn(r: Row): ReauthenticationTransaction {
  return {
    reauthTxnId: String(r.reauth_txn_id),
    tenantId: String(r.tenant_id),
    userLinkId: String(r.user_link_id),
    action: String(r.action),
    resourceType: r.resource_type === null ? null : String(r.resource_type),
    resourceId: r.resource_id === null ? null : String(r.resource_id),
    startedAt: ts(r.started_at),
    expiresAt: ts(r.expires_at),
    state: String(r.state) as ReauthenticationTransaction['state'],
  };
}

export interface StartedReauthentication {
  readonly transaction: ReauthenticationTransaction;
  /** Opaque nonce for the provider round trip. Returned ONCE, stored hashed. */
  readonly nonce: string;
}

export async function startReauthentication(input: {
  tenantId: string;
  userLinkId: string;
  action: string;
  resourceType?: string | null;
  resourceId?: string | null;
  ttlSeconds?: number;
}): Promise<StartedReauthentication> {
  const nonce = randomBytes(32).toString('base64url');
  const result = await query(
    `INSERT INTO reauthentication_transactions
       (tenant_id, user_link_id, action, resource_type, resource_id, nonce_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW() + make_interval(secs => $7))
     RETURNING *`,
    [
      input.tenantId,
      input.userLinkId,
      input.action,
      input.resourceType ?? null,
      input.resourceId ?? null,
      sha256hex(nonce),
      input.ttlSeconds ?? 300,
    ],
  );
  return { transaction: mapTxn(result.rows[0] as Row), nonce };
}

export interface CompletedReauthentication {
  readonly transaction: ReauthenticationTransaction;
  /** The single-use grant. Returned ONCE, stored hashed. */
  readonly grant: string;
  readonly grantExpiresAt: Date;
}

/**
 * Completes a transaction after the provider round trip. The CALLER has
 * already verified the fresh access token cryptographically (issuer,
 * audience, algorithm, JWKS) — this function enforces the transaction-side
 * proofs: the nonce matches a live started transaction for THIS user, and
 * the token's auth_time is at or after the transaction start minus the
 * bounded skew. Fail-closed: any miss marks nothing and mints nothing.
 */
export async function completeReauthentication(input: {
  nonce: string;
  userLinkId: string;
  verifiedAuthTime: Date;
  clockSkewSeconds?: number;
  grantTtlSeconds?: number;
}): Promise<CompletedReauthentication | null> {
  const skewMs = (input.clockSkewSeconds ?? 60) * 1000;
  return withTransaction(async (executor) => {
    const found = await executor.query(
      `SELECT * FROM reauthentication_transactions
        WHERE nonce_hash = $1 AND user_link_id = $2 AND state = 'started' AND expires_at > NOW()
        FOR UPDATE`,
      [sha256hex(input.nonce), input.userLinkId],
    );
    if (found.rows.length === 0) return null;
    const txn = mapTxn(found.rows[0] as Row);

    if (input.verifiedAuthTime.getTime() < txn.startedAt.getTime() - skewMs) {
      // stale authentication — the person did NOT freshly re-authenticate
      await executor.query(
        `UPDATE reauthentication_transactions SET state = 'failed' WHERE reauth_txn_id = $1`,
        [txn.reauthTxnId],
      );
      return null;
    }

    const grant = randomBytes(32).toString('base64url');
    const grantResult = await executor.query(
      `INSERT INTO reauthentication_grants
         (reauth_txn_id, tenant_id, user_link_id, action, resource_type, resource_id, grant_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW() + make_interval(secs => $8))
       RETURNING expires_at`,
      [
        txn.reauthTxnId,
        txn.tenantId,
        txn.userLinkId,
        txn.action,
        txn.resourceType,
        txn.resourceId,
        sha256hex(grant),
        input.grantTtlSeconds ?? 120,
      ],
    );
    await executor.query(
      `UPDATE reauthentication_transactions
          SET state = 'completed', completed_at = NOW() WHERE reauth_txn_id = $1`,
      [txn.reauthTxnId],
    );
    await executor.query(
      `INSERT INTO audit_events (tenant_id, event_type, entity_type, entity_id, actor_user_id, details)
       VALUES ($1, 'identity.reauthentication.granted', 'reauth_transaction', $2, $3, $4)`,
      [
        txn.tenantId,
        txn.reauthTxnId,
        txn.userLinkId,
        JSON.stringify({ action: txn.action, resource_type: txn.resourceType }),
      ],
    );
    return {
      transaction: { ...txn, state: 'completed' },
      grant,
      grantExpiresAt: ts((grantResult.rows[0] as Row).expires_at),
    };
  });
}

/**
 * Atomic single consumption, executed on the CALLER's executor so the spend
 * commits (or rolls back) with the business action it authorizes. The grant
 * must match tenant, user, action AND resource — a grant minted for one
 * thing can never pay for another. Returns false (fail closed) on any miss,
 * replay included.
 */
export async function consumeReauthenticationGrant(
  executor: Executor,
  input: {
    grant: string;
    tenantId: string;
    userLinkId: string;
    action: string;
    resourceType?: string | null;
    resourceId?: string | null;
  },
): Promise<boolean> {
  if (typeof input.grant !== 'string' || input.grant.length === 0) return false;
  const result = await executor.query(
    `UPDATE reauthentication_grants
        SET consumed_at = NOW()
      WHERE grant_hash = $1
        AND tenant_id = $2
        AND user_link_id = $3
        AND action = $4
        AND resource_type IS NOT DISTINCT FROM $5
        AND resource_id IS NOT DISTINCT FROM $6
        AND consumed_at IS NULL
        AND expires_at > NOW()`,
    [
      sha256hex(input.grant),
      input.tenantId,
      input.userLinkId,
      input.action,
      input.resourceType ?? null,
      input.resourceId ?? null,
    ],
  );
  return (result.rowCount ?? 0) === 1;
}
