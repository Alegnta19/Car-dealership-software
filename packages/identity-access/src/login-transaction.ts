/**
 * Authoritative server-side login/reauthentication transactions
 * (FBL-020-R2, Blueprint §14.3).
 *
 * R1 trusted a sealed cookie for state, nonce, PKCE and redirect. A client
 * that kept a copy could present it again; nothing on the server said "this
 * one is spent". R2 makes the SERVER the authority:
 *
 *   - state, nonce and the PKCE verifier are stored only as SHA-256 digests;
 *   - the row expires on its own clock;
 *   - consumption is an atomic conditional UPDATE, so a replayed callback
 *     loses the race and is refused by the database, not by trust;
 *   - the outcome (succeeded/failed) is recorded, so a failed exchange
 *     cannot be retried with the same state either.
 *
 * The sealed cookie remains, reduced to what it should always have been: an
 * opaque pointer plus the plaintext the server must compare against.
 */
import { createHash, randomBytes } from 'node:crypto';
import { query, withTransaction, type Executor } from '@dealer/database';

function sha256hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export interface StartedLoginTransaction {
  readonly loginTxnId: string;
  readonly state: string;
  readonly nonce: string;
  readonly codeVerifier: string;
  readonly expiresAt: Date;
}

export interface LoginTransactionRecord {
  readonly loginTxnId: string;
  readonly purpose: 'login' | 'reauth';
  readonly redirectUri: string;
  readonly returnTo: string | null;
  readonly tenantId: string | null;
  readonly connectionId: string | null;
  readonly userLinkId: string | null;
  readonly reauthTxnId: string | null;
}

interface Row {
  [key: string]: unknown;
}

function mapRecord(r: Row): LoginTransactionRecord {
  return {
    loginTxnId: String(r.login_txn_id),
    purpose: String(r.purpose) as 'login' | 'reauth',
    redirectUri: String(r.redirect_uri),
    returnTo: r.return_to === null ? null : String(r.return_to),
    tenantId: r.tenant_id === null ? null : String(r.tenant_id),
    connectionId: r.connection_id === null ? null : String(r.connection_id),
    userLinkId: r.user_link_id === null ? null : String(r.user_link_id),
    reauthTxnId: r.reauth_txn_id === null ? null : String(r.reauth_txn_id),
  };
}

/**
 * Opens a transaction and returns the three secrets ONCE. Only digests are
 * persisted; the caller seals the plaintext into the transaction cookie.
 */
export async function startLoginTransaction(input: {
  purpose: 'login' | 'reauth';
  redirectUri: string;
  returnTo?: string | null;
  tenantId?: string | null;
  connectionId?: string | null;
  userLinkId?: string | null;
  reauthTxnId?: string | null;
  ttlSeconds?: number;
}): Promise<StartedLoginTransaction> {
  const state = randomBytes(32).toString('base64url');
  const nonce = randomBytes(32).toString('base64url');
  const codeVerifier = randomBytes(32).toString('base64url');
  const result = await query(
    `INSERT INTO login_transactions
       (purpose, state_hash, nonce_hash, code_verifier_hash, redirect_uri, return_to,
        tenant_id, connection_id, user_link_id, reauth_txn_id,
        expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, NOW() + make_interval(secs => $11))
     RETURNING login_txn_id, expires_at`,
    [
      input.purpose,
      sha256hex(state),
      sha256hex(nonce),
      sha256hex(codeVerifier),
      input.redirectUri,
      input.returnTo ?? null,
      input.tenantId ?? null,
      input.connectionId ?? null,
      input.userLinkId ?? null,
      input.reauthTxnId ?? null,
      input.ttlSeconds ?? 600,
    ],
  );
  const row = result.rows[0] as Row;
  return {
    loginTxnId: String(row.login_txn_id),
    state,
    nonce,
    codeVerifier,
    expiresAt: row.expires_at instanceof Date ? row.expires_at : new Date(String(row.expires_at)),
  };
}

/**
 * Atomically claims the transaction named by `state`. Exactly one caller can
 * win; a replay, an expired row and an unknown state are indistinguishable
 * failures (null). Nothing is revealed about which it was.
 *
 * The claim is made INSIDE the caller's transaction when one is supplied, so
 * a failed code exchange can roll the claim back only if the caller chooses
 * to — by default the claim stands and the state is burned.
 */
export async function claimLoginTransaction(
  executor: Executor,
  input: { state: string; purpose: 'login' | 'reauth'; nonce: string; codeVerifier: string },
): Promise<LoginTransactionRecord | null> {
  const result = await executor.query(
    `UPDATE login_transactions
        SET consumed_at = NOW(), consumed_outcome = 'succeeded'
      WHERE state_hash = $1
        AND purpose = $2
        AND nonce_hash = $3
        AND code_verifier_hash = $4
        AND consumed_at IS NULL
        AND expires_at > NOW()
      RETURNING *`,
    [sha256hex(input.state), input.purpose, sha256hex(input.nonce), sha256hex(input.codeVerifier)],
  );
  return result.rows.length > 0 ? mapRecord(result.rows[0] as Row) : null;
}

/**
 * The application-facing claim: owns its own transaction so no app file ever
 * imports a database primitive (the app-SQL guard forbids it).
 */
export async function claimLoginTransactionAtomically(input: {
  state: string;
  purpose: 'login' | 'reauth';
  nonce: string;
  codeVerifier: string;
}): Promise<LoginTransactionRecord | null> {
  return withTransaction((executor) => claimLoginTransaction(executor, input));
}

/** Marks a claimed transaction as failed, so its state can never be reused. */
export async function failLoginTransaction(loginTxnId: string): Promise<void> {
  await query(`UPDATE login_transactions SET consumed_outcome = 'failed' WHERE login_txn_id = $1`, [
    loginTxnId,
  ]);
}

/** Housekeeping for the scheduled aggregator; expiry is decided at read time. */
export async function expireStaleLoginTransactions(): Promise<number> {
  return withTransaction(async (executor) => {
    const result = await executor.query(
      `UPDATE login_transactions SET consumed_at = NOW(), consumed_outcome = 'failed'
        WHERE consumed_at IS NULL AND expires_at < NOW()`,
    );
    return result.rowCount ?? 0;
  });
}
