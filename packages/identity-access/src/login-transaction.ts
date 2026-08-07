/**
 * Authoritative server-side login/reauthentication transactions
 * (FBL-020-R2, Blueprint §14.3; state machine added in R3).
 *
 * R1 trusted a sealed cookie for state, nonce, PKCE and redirect. A client
 * that kept a copy could present it again; nothing on the server said "this
 * one is spent". R2 makes the SERVER the authority:
 *
 *   - state, nonce and the PKCE verifier are stored only as SHA-256 digests;
 *   - the row expires on its own clock;
 *   - consumption is an atomic conditional UPDATE, so a replayed callback
 *     loses the race and is refused by the database, not by trust.
 *
 * R3 adds the part R2 got wrong. R2 wrote `consumed_outcome = 'succeeded'` at
 * CLAIM time — before the code had been exchanged, before the token had been
 * verified, before the identity had been admitted and before any local session
 * existed. Every login that fell over later was recorded as a success, which
 * makes the table useless as evidence and hides exactly the failures an
 * operator needs to see. The transaction now walks an explicit, terminal state
 * machine:
 *
 *     pending ──claim──▶ consuming ──▶ succeeded
 *        │                   │
 *        └───────────────────┴──────▶ failed   (always with a reason)
 *
 * `succeeded` is reachable only from `consuming`, and the caller reaches it
 * only after identity validation AND local-session establishment have both
 * finished. Both terminal states are absorbing, and the claim is conditional
 * on `pending`, so a replay at any stage loses.
 *
 * The sealed cookie remains, reduced to what it should always have been: an
 * opaque pointer plus the plaintext the server must compare against. The
 * RETURN LOCATION is not in it — that is a server fact, read back from this
 * row at the end of the round trip.
 */
import { createHash, randomBytes } from 'node:crypto';
import { query, withTransaction, type Executor } from '@dealer/database';

function sha256hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * The correlation shape the evidence tables already enforce. Anything else is
 * DROPPED rather than truncated: a value trimmed into shape would correlate a
 * flow to the wrong request, and a hostile header must never reach a CHECK.
 */
const SAFE_CORRELATION = /^[A-Za-z0-9._-]{8,128}$/;

function safeCorrelation(value: string | null | undefined): string | null {
  return typeof value === 'string' && SAFE_CORRELATION.test(value) ? value : null;
}

/** The four states. Both terminal states absorb; neither can be left. */
export type LoginTransactionStatus = 'pending' | 'consuming' | 'succeeded' | 'failed';

/**
 * Why a login transaction failed. A CLOSED vocabulary written by the server:
 * never a provider message, never a token, nonce or authorization code, never
 * anything a caller supplied.
 */
export type LoginTransactionFailureReason =
  | 'provider_exchange_failed'
  | 'impersonation_detected'
  | 'token_verification_failed'
  | 'identity_not_admitted'
  | 'session_establishment_failed'
  | 'expired';

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
  readonly status: LoginTransactionStatus;
  readonly redirectUri: string;
  /** The allowlisted same-origin path this login must return to. */
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
    status: String(r.status) as LoginTransactionStatus,
    redirectUri: String(r.redirect_uri),
    returnTo: r.return_to === null ? null : String(r.return_to),
    tenantId: r.tenant_id === null ? null : String(r.tenant_id),
    connectionId: r.connection_id === null ? null : String(r.connection_id),
    userLinkId: r.user_link_id === null ? null : String(r.user_link_id),
    reauthTxnId: r.reauth_txn_id === null ? null : String(r.reauth_txn_id),
  };
}

/**
 * Opens a transaction in `pending` and returns the three secrets ONCE. Only
 * digests are persisted; the caller seals the plaintext into the transaction
 * cookie. The return location is persisted HERE and nowhere else.
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
  /** Screened here, so no caller can put an unscreened value in the table. */
  requestId?: string | null;
  correlationId?: string | null;
}): Promise<StartedLoginTransaction> {
  const state = randomBytes(32).toString('base64url');
  const nonce = randomBytes(32).toString('base64url');
  const codeVerifier = randomBytes(32).toString('base64url');
  const result = await query(
    `INSERT INTO login_transactions
       (purpose, state_hash, nonce_hash, code_verifier_hash, redirect_uri, return_to,
        tenant_id, connection_id, user_link_id, reauth_txn_id,
        status, request_id, correlation_id, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
             'pending',$11,$12, NOW() + make_interval(secs => $13))
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
      safeCorrelation(input.requestId),
      safeCorrelation(input.correlationId),
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
 * Atomically claims the transaction named by `state`, moving it
 * `pending -> consuming`. Exactly one caller can win; a replay at ANY stage
 * (consuming, succeeded or failed), an expired row and an unknown state are
 * indistinguishable failures (null). Nothing is revealed about which it was.
 *
 * The claim does NOT declare an outcome. It says only "this state is spent and
 * someone is working on it" — the transaction stays non-terminal until the
 * caller decides, which is the whole point of the state machine.
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
        SET claimed_at = NOW(), status = 'consuming'
      WHERE state_hash = $1
        AND purpose = $2
        AND nonce_hash = $3
        AND code_verifier_hash = $4
        AND status = 'pending'
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

/**
 * The ONLY route to `succeeded`, and it is reachable only from `consuming`.
 *
 * The caller must not reach here until identity validation AND local-session
 * establishment have both finished — a login that produced no session did not
 * succeed, whatever the provider said. Returns false when the transaction was
 * already terminal (expired underneath us, or failed by another path), and the
 * caller must then fail closed rather than serve the session it just made.
 */
export async function succeedLoginTransaction(loginTxnId: string): Promise<boolean> {
  const result = await query(
    `UPDATE login_transactions
        SET status = 'succeeded', consumed_at = NOW(), consumed_outcome = 'succeeded'
      WHERE login_txn_id = $1 AND status = 'consuming'`,
    [loginTxnId],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Marks a transaction failed — terminally, with a reason. Reachable from
 * `pending` (an unclaimed transaction can expire) and from `consuming` (every
 * step after the claim). A transaction that is already terminal is left
 * exactly as it is: the FIRST terminal fact wins and nothing overwrites it.
 */
export async function failLoginTransaction(
  loginTxnId: string,
  reason: LoginTransactionFailureReason,
): Promise<boolean> {
  const result = await query(
    `UPDATE login_transactions
        SET status = 'failed', consumed_at = NOW(), consumed_outcome = 'failed',
            failure_reason = $2
      WHERE login_txn_id = $1 AND status IN ('pending', 'consuming')`,
    [loginTxnId, reason],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Housekeeping for the scheduled aggregator; expiry is decided at read time. */
export async function expireStaleLoginTransactions(): Promise<number> {
  return withTransaction(async (executor) => {
    const result = await executor.query(
      `UPDATE login_transactions
          SET status = 'failed', consumed_at = NOW(), consumed_outcome = 'failed',
              failure_reason = 'expired'
        WHERE status IN ('pending', 'consuming') AND expires_at < NOW()`,
    );
    return result.rowCount ?? 0;
  });
}
