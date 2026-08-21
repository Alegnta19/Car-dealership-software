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
import { withTransaction, type Executor } from '@dealer/database';

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

/**
 * `audit_events.tenant_id` is NOT NULL. A LOGIN does not know its tenant until
 * the identity has been admitted, so the transitions before that point are
 * recorded under the nil tenant — still transactionally, still naming the
 * transaction they belong to.
 */
const NIL_TENANT = '00000000-0000-0000-0000-000000000000';

/**
 * FBL-020-R4 section 1 — the ONE audit writer for login transitions.
 *
 * R3 recorded a login's fate on the `login_transactions` row alone. That row is
 * the state machine, not the audit trail: `audit_events` is what an operator
 * reads for "what happened to this identity", and login start, claim, success,
 * failure, replay and expiry appeared in it nowhere. Every one of them now
 * writes exactly one row, on the CALLER'S EXECUTOR, so the event commits with
 * the transition it describes or neither happens.
 *
 * Details carry identifiers and closed-vocabulary reasons only: never the state,
 * the nonce, the PKCE verifier, the authorization code, a token or any profile.
 */
async function auditLogin(
  executor: Executor,
  input: {
    loginTxnId: string;
    tenantId: string | null;
    userLinkId: string | null;
    eventType: string;
    details: Record<string, unknown>;
  },
): Promise<void> {
  await executor.query(
    `INSERT INTO audit_events
       (tenant_id, event_type, entity_type, entity_id, actor_user_id, details)
     VALUES ($1, $2, 'login_transaction', $3, $4, $5)`,
    [
      input.tenantId ?? NIL_TENANT,
      input.eventType,
      input.loginTxnId,
      input.userLinkId,
      JSON.stringify(input.details),
    ],
  );
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
  /**
   * FBL-020-R4 section 1 — the exchange response and the verified token did not
   * describe the same provider user, organization, provider session or
   * impersonation state. Two carriers of one claim that disagree are refused,
   * and the disagreement is recorded distinctly because it is a different fact
   * from "this identity is not admitted here".
   */
  | 'exchange_token_mismatch'
  | 'identity_not_admitted'
  | 'session_establishment_failed'
  /**
   * FBL-020-R5 §1.5 — THE PROVIDER SENT US TO THE CALLBACK WITH AN ERROR.
   *
   * An OAuth authorization server that refuses (`access_denied`, `login_required`,
   * a misconfigured client) redirects to the registered callback carrying `error`
   * and the original `state`, and NO `code`. That is a real transaction reaching a
   * real end, and it now says so.
   *
   * The provider's own `error` / `error_description` strings are deliberately NOT
   * recorded: `failure_reason` is a closed server vocabulary, and a provider
   * message is caller-influenced text that must never reach the table or a log.
   */
  | 'provider_error_callback'
  /**
   * FBL-020-R5 §1.5 — a callback that presented a valid sealed handle and the
   * matching state, and no authorization code at all. Distinct from the line above
   * because "the provider refused" and "the callback arrived malformed or
   * truncated" are different operational facts.
   */
  | 'authorization_code_missing'
  /**
   * ── FBL-020-R6 §2.1/§2.2 — THE FIVE CALLBACK-BINDING REFUSALS ─────────────
   *
   * R5 refused a missing or disagreeing `state` IN THE ROUTE, before the
   * authoritative claim, and recorded a disagreeing PKCE verifier, nonce, purpose
   * or redirect as `identity.login.replayed` while LEAVING THE ROW `pending`. Both
   * are the same defect wearing two hats: a callback that named a real server
   * transaction was judged somewhere other than by that transaction, and the
   * transaction was left claimable — so the state it was supposed to burn survived,
   * and the only record of the attempt said "replay", which it was not.
   *
   * Each of the five is now its own terminal reason, because they are five
   * different operational facts and an operator reading `failure_reason` must not
   * have to guess which one happened. NONE of them carries a presented value: the
   * comparison is between digests, and the vocabulary is the server's own.
   */
  | 'callback_purpose_mismatch'
  | 'callback_state_mismatch'
  | 'callback_nonce_mismatch'
  | 'callback_pkce_mismatch'
  | 'callback_redirect_mismatch'
  /**
   * FBL-020-R6 §2.3/§2.5 — the transaction could not reach `succeeded` because it
   * was no longer `consuming` (another leg or a sweep terminalized it underneath
   * this one), or because the identity the caller admitted disagreed with the
   * identity the transaction was opened for. Distinct from `expired`, which is the
   * third way the success transition can lose and the only one with a clock in it.
   */
  | 'login_transaction_not_consuming'
  | 'login_identity_disagreement'
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
  return withTransaction(async (executor) => {
    const result = await executor.query(
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
    const loginTxnId = String(row.login_txn_id);
    await auditLogin(executor, {
      loginTxnId,
      tenantId: input.tenantId ?? null,
      userLinkId: input.userLinkId ?? null,
      eventType: 'identity.login.started',
      details: { purpose: input.purpose },
    });
    return {
      loginTxnId,
      state,
      nonce,
      codeVerifier,
      expiresAt: row.expires_at instanceof Date ? row.expires_at : new Date(String(row.expires_at)),
    };
  });
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
export interface LoginTransactionClaim {
  /**
   * FBL-020-R4 section 1 — the OPAQUE TRANSACTION HANDLE, and it is required.
   *
   * R3 claimed by `state_hash` alone (plus purpose, nonce and PKCE). The handle
   * was in the sealed cookie and was simply not part of the predicate, so the
   * claim never proved that the callback naming this state was the callback that
   * had been handed this transaction.
   *
   * FBL-020-R6 §2.1 — it is now the ONLY thing a route may decide for itself. A
   * callback that presents a valid sealed handle is routed HERE whatever else it
   * carries, and everything else below is `null`-able because "the callback did not
   * present this at all" is a fact this service must classify rather than a reason
   * for a route to refuse before the transaction has been consulted.
   */
  readonly loginTxnId: string;
  /** The `state` the PROVIDER returned. `null` — none returned — is a mismatch. */
  readonly state: string | null;
  /** The purpose of the ROUTE LEG. The row's own purpose must equal it. */
  readonly purpose: 'login' | 'reauth';
  /**
   * FBL-020-R6 §2.1 — the purpose the SEALED COOKIE carried, when it differs from
   * the leg's. Omitted, the cookie is taken to have agreed with the leg, which is
   * what every caller that has nothing else to say means. It is compared, never
   * trusted: the row's purpose is the authority and both must equal it.
   */
  readonly presentedPurpose?: string | null;
  readonly nonce: string | null;
  readonly codeVerifier: string | null;
  /**
   * The EXACT callback/redirect this leg was opened for. Compared against the
   * value the START stored, so a transaction opened for one registered redirect
   * cannot be completed at another.
   */
  readonly redirectUri: string;
}

/**
 * The shape of a login-transaction handle. Checked before the handle reaches a
 * `uuid` parameter: a sealed cookie can only have been written by this server, but
 * a value that cannot be a `uuid` would make the lookup RAISE rather than refuse,
 * and a lifecycle service whose refusal path can throw is not fail-closed.
 */
const LOGIN_TXN_HANDLE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export async function claimLoginTransaction(
  executor: Executor,
  input: LoginTransactionClaim,
): Promise<LoginTransactionRecord | null> {
  if (input.state === null || input.nonce === null || input.codeVerifier === null) return null;
  const result = await executor.query(
    `UPDATE login_transactions
        SET claimed_at = NOW(), status = 'consuming'
      WHERE login_txn_id = $5::uuid
        AND state_hash = $1
        AND purpose = $2
        AND nonce_hash = $3
        AND code_verifier_hash = $4
        AND redirect_uri = $6
        AND status = 'pending'
        AND expires_at > NOW()
      RETURNING *`,
    [
      sha256hex(input.state),
      input.purpose,
      sha256hex(input.nonce),
      sha256hex(input.codeVerifier),
      input.loginTxnId,
      input.redirectUri,
    ],
  );
  return result.rows.length > 0 ? mapRecord(result.rows[0] as Row) : null;
}

/**
 * THE SERVER-AUTHORITATIVE CALLBACK LIFECYCLE — FBL-020-R6 §2.1 and §2.2.
 *
 * The application-facing claim: it owns its own transaction so no app file ever
 * imports a database primitive (the app-SQL guard forbids it), and it is now the
 * ONLY place a callback carrying a valid sealed handle is judged.
 *
 * ── what §2.1 moved into here, and why the route could not keep it ──────────
 *
 * `apps/api/src/routes/auth.ts` used to refuse a missing or disagreeing `state`
 * BEFORE this call, even when the sealed handle was valid and named a live
 * `pending` row. That refusal was a 401 and nothing else: the transaction stayed
 * claimable, its state was NOT burned, and the only record of the attempt was the
 * absence of one. A route cannot fix that by comparing more carefully, because the
 * comparison belongs to the row — the digests are here, the lock is here, and the
 * terminal transition is here. So the route now decides exactly one thing (is there
 * a sealed handle at all?) and everything else arrives as a nullable presented
 * value for this function to classify.
 *
 * ── what §2.2 changed about the answer ─────────────────────────────────────
 *
 * R5 recorded EVERY predicate disagreement as `identity.login.replayed` with
 * `observed_status = 'claim_predicate_unsatisfied'` and LEFT THE ROW `pending`. A
 * PKCE or redirect mismatch is not a replay — it is a callback that cannot be the
 * one this transaction was handed — and leaving it pending meant the state it was
 * supposed to spend survived for the next attempt. Each disagreement is now its own
 * TERMINAL state with its own reason and EXACTLY ONE terminal audit event, and a
 * later correct callback therefore LOSES: it finds a non-`pending` row and takes
 * the replay branch, which changes nothing.
 *
 * The replay branch remains what it always was, and it is deliberately NOT a
 * terminal transition: a row that is `consuming` may belong to a leg still
 * legitimately in flight, and the FIRST terminal fact must win.
 *
 * ── the clock ──────────────────────────────────────────────────────────────
 *
 * Expiry is decided by DATABASE TIME (`expires_at <= NOW()` evaluated in the same
 * statement that locks the row), never by comparing a returned timestamp against
 * this process's `Date.now()`. `NOW()` is the transaction timestamp, so every
 * expiry question asked inside this transaction gets the same answer.
 */
export async function claimLoginTransactionAtomically(
  input: LoginTransactionClaim,
): Promise<LoginTransactionRecord | null> {
  // A handle that cannot be a `uuid` names no row. Refused here rather than at the
  // parameter, so the refusal path cannot raise.
  if (!LOGIN_TXN_HANDLE.test(input.loginTxnId)) return null;
  return withTransaction(async (executor) => {
    // The handle names the row, so the OUTCOME of a refusal is classifiable —
    // and every classification is RECORDED. R3 returned an undifferentiated null
    // and wrote nothing, so a replayed callback and a stale one were invisible.
    // The row is locked first so the classification and the claim cannot
    // straddle another leg's transition.
    const found = await executor.query(
      `SELECT login_txn_id, tenant_id, user_link_id, purpose, status, redirect_uri,
              state_hash, nonce_hash, code_verifier_hash,
              (expires_at <= NOW()) AS is_expired
         FROM login_transactions WHERE login_txn_id = $1::uuid FOR UPDATE`,
      [input.loginTxnId],
    );
    if (found.rows.length === 0) {
      // No row: there is nothing to attribute an event to, and inventing an
      // entity id to audit against would be fabricating evidence.
      return null;
    }
    const existing = found.rows[0] as Row;
    const loginTxnId = String(existing.login_txn_id);
    const tenantId = existing.tenant_id === null ? null : String(existing.tenant_id);
    const userLinkId = existing.user_link_id === null ? null : String(existing.user_link_id);

    if (String(existing.status) !== 'pending') {
      // A REPLAY. The row is deliberately left exactly as it is: it may be
      // `consuming` for a leg that is still legitimately in flight, and the
      // first terminal fact must win. The attempt is still recorded.
      await auditLogin(executor, {
        loginTxnId,
        tenantId,
        userLinkId,
        eventType: 'identity.login.replayed',
        details: { purpose: String(existing.purpose), observed_status: String(existing.status) },
      });
      return null;
    }
    if (existing.is_expired === true) {
      await failLoginTransactionWithin(executor, loginTxnId, 'expired');
      return null;
    }

    /*
     * THE FIVE BINDING COMPARISONS, each with its own terminal reason (§2.2).
     *
     * `presentedPurpose` defaults to the leg's own purpose: a caller with nothing
     * else to say is saying "the cookie agreed with me". Both it and the leg must
     * equal the ROW's purpose — the row is the authority and neither side of the
     * comparison is allowed to be the only one consulted.
     *
     * A `null` presented value is a MISMATCH, never a skipped comparison: "the
     * callback did not present this" cannot satisfy "the transaction requires it".
     */
    const presentedPurpose = input.presentedPurpose ?? input.purpose;
    const rowPurpose = String(existing.purpose);
    const terminal = async (reason: LoginTransactionFailureReason): Promise<null> => {
      await failLoginTransactionWithin(executor, loginTxnId, reason);
      return null;
    };
    if (rowPurpose !== input.purpose || presentedPurpose !== rowPurpose) {
      return terminal('callback_purpose_mismatch');
    }
    if (input.state === null || sha256hex(input.state) !== String(existing.state_hash)) {
      return terminal('callback_state_mismatch');
    }
    if (input.nonce === null || sha256hex(input.nonce) !== String(existing.nonce_hash)) {
      return terminal('callback_nonce_mismatch');
    }
    if (
      input.codeVerifier === null ||
      sha256hex(input.codeVerifier) !== String(existing.code_verifier_hash)
    ) {
      return terminal('callback_pkce_mismatch');
    }
    if (String(existing.redirect_uri) !== input.redirectUri) {
      return terminal('callback_redirect_mismatch');
    }

    const claimed = await claimLoginTransaction(executor, input);
    if (claimed === null) {
      /*
       * UNREACHABLE BY CONSTRUCTION, AND STILL HANDLED. Every clause of the
       * conditional claim has just been evaluated against this very row while this
       * transaction holds it under `FOR UPDATE`, and `NOW()` is the transaction
       * timestamp, so `expires_at > NOW()` cannot have changed its mind. It is kept
       * as a database-side backstop rather than deleted, because a predicate that
       * exists only in TypeScript is a predicate a future edit can drop silently —
       * and a backstop that fires must still leave a terminal row rather than a
       * pending one.
       */
      return terminal('login_transaction_not_consuming');
    }
    await auditLogin(executor, {
      loginTxnId,
      tenantId: claimed.tenantId,
      userLinkId: claimed.userLinkId,
      eventType: 'identity.login.claimed',
      details: { purpose: claimed.purpose },
    });
    return claimed;
  });
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
export interface AdmittedLoginIdentity {
  readonly loginTxnId: string;
  /**
   * FBL-020-R5 §1.11 — THE TENANT AND USER THE LOGIN WAS ADMITTED AS.
   *
   * A browser login knows neither when it opens: `GET /auth/login` has a purpose,
   * a redirect, a return location and a TTL, and nothing else, so the row's
   * `tenant_id` and `user_link_id` were NULL for the whole round trip. The success
   * transition RETURNed those NULLs and handed them straight to the audit writer,
   * which meant every successful browser login in `audit_events` was recorded
   * against the NIL tenant with `actor_user_id = NULL` — the one event in the
   * lifecycle that names WHO GOT IN named nobody, and could not be found by
   * filtering a tenant's own trail.
   *
   * They are inputs now because the caller is the only party that knows them: it
   * is the step that has just admitted the identity AND established the local
   * session, so it holds the admitted tenant and link as facts rather than hopes.
   * `tenantId` is nullable because a PLATFORM-scope actor genuinely has no tenant;
   * `userLinkId` is not, because a login that admitted nobody is not a success.
   */
  readonly tenantId: string | null;
  readonly userLinkId: string;
  /** The connection the identity was admitted through, when the caller knows it. */
  readonly connectionId?: string | null;
}

/**
 * WHY a success transition did not happen. Every value is a
 * `LoginTransactionFailureReason`, so the caller can terminalize with it directly.
 */
export type LoginSuccessRefusal =
  'expired' | 'login_transaction_not_consuming' | 'login_identity_disagreement';

export type LoginSuccessOutcome =
  { readonly recorded: true } | { readonly recorded: false; readonly refusal: LoginSuccessRefusal };

/**
 * The success transition ON THE CALLER'S EXECUTOR — FBL-020-R6 §2.3 and §2.5.
 *
 * ── §2.3: THE EXPIRY IS DECIDED BY DATABASE TIME, AT COMPLETION ─────────────
 *
 * R5's UPDATE required `status = 'consuming'` and nothing else. A callback claimed
 * one millisecond before `expires_at` could therefore finish MINUTES later — after a
 * slow provider exchange, a slow JWKS fetch, a slow admission — and be recorded as a
 * success, with a session cookie handed out, having spent a transaction that had
 * expired in the meantime. Nothing swept it, so nothing contradicted it: the sweep
 * only ages rows nobody is holding, and this one was `consuming`.
 *
 * `expires_at > NOW()` is now part of the predicate. `NOW()` is PostgreSQL's
 * transaction timestamp — the database's clock, not this process's, and not a
 * timestamp that travelled through JavaScript — so the answer cannot drift with a
 * host clock and cannot be argued with by a caller.
 *
 * ── §2.5: WHY THIS TAKES AN EXECUTOR ───────────────────────────────────────
 *
 * The caller is `admitLoginAndEstablishSession`, and it calls this INSIDE the
 * transaction that inserted the session and sealed the provider refresh credential.
 * The three writes — custody, success, and both of their audit rows — therefore
 * commit together or not at all. R5 had them in two transactions with the route in
 * between, so a success transition (or its audit INSERT) that failed left a live,
 * refreshable session behind that no login owned.
 *
 * The refusal is CLASSIFIED rather than boolean, because "the transaction expired"
 * and "somebody else terminalized it" are different facts and each has to be
 * recordable as its own terminal reason.
 */
export async function succeedLoginTransactionWithin(
  executor: Executor,
  input: AdmittedLoginIdentity,
): Promise<LoginSuccessOutcome> {
  const { loginTxnId } = input;
  const result = await executor.query(
    `UPDATE login_transactions
        SET status = 'succeeded', consumed_at = NOW(), consumed_outcome = 'succeeded',
            tenant_id = $2::uuid,
            user_link_id = $3::uuid,
            connection_id = COALESCE($4::uuid, connection_id)
      WHERE login_txn_id = $1 AND status = 'consuming'
        -- FBL-020-R6 §2.3: LOGIN EXPIRY, ENFORCED AT COMPLETION, IN DATABASE TIME.
        AND expires_at > NOW()
        -- A transaction that was OPENED against a known identity — the reauth
        -- purpose is — may only succeed as THAT identity. A disagreement is a
        -- refusal, never an overwrite: this statement records who was admitted,
        -- it does not get to rewrite who the transaction was for.
        AND (tenant_id IS NULL OR tenant_id IS NOT DISTINCT FROM $2::uuid)
        AND (user_link_id IS NULL OR user_link_id = $3::uuid)
      RETURNING tenant_id, user_link_id, purpose`,
    [loginTxnId, input.tenantId, input.userLinkId, input.connectionId ?? null],
  );
  if (result.rows.length === 0) {
    // WHICH clause refused, read back from the row itself so the reason recorded is
    // the true one rather than the first guess. The row is not locked here because
    // the caller's transaction has already written to it (the claim) or is about to
    // terminalize it; a wrong classification would be a mislabelled audit row, and
    // this read is what stops that.
    const observed = await executor.query(
      `SELECT status, (expires_at <= NOW()) AS is_expired,
              (tenant_id IS NULL OR tenant_id IS NOT DISTINCT FROM $2::uuid) AS tenant_ok,
              (user_link_id IS NULL OR user_link_id = $3::uuid) AS link_ok
         FROM login_transactions WHERE login_txn_id = $1`,
      [loginTxnId, input.tenantId, input.userLinkId],
    );
    if (observed.rows.length === 0) {
      return { recorded: false, refusal: 'login_transaction_not_consuming' };
    }
    const row = observed.rows[0] as Row;
    if (String(row.status) === 'consuming' && row.is_expired === true) {
      return { recorded: false, refusal: 'expired' };
    }
    if (String(row.status) === 'consuming' && (row.tenant_ok !== true || row.link_ok !== true)) {
      return { recorded: false, refusal: 'login_identity_disagreement' };
    }
    return { recorded: false, refusal: 'login_transaction_not_consuming' };
  }
  const row = result.rows[0] as Row;
  await auditLogin(executor, {
    loginTxnId,
    // Read back from the row the UPDATE just wrote, not from the input: the
    // evidence names what the database holds.
    tenantId: row.tenant_id === null ? null : String(row.tenant_id),
    userLinkId: row.user_link_id === null ? null : String(row.user_link_id),
    eventType: 'identity.login.succeeded',
    details: { purpose: String(row.purpose) },
  });
  return { recorded: true };
}

/**
 * The same transition in a transaction of its own, for callers that have no local
 * session to keep it company. The LOGIN path does not use this — §2.5 requires its
 * success to share the custody commit — and it is retained because the state machine
 * is exercised directly by the boundary and lifecycle batteries.
 */
export async function succeedLoginTransaction(input: AdmittedLoginIdentity): Promise<boolean> {
  return withTransaction(
    async (executor) => (await succeedLoginTransactionWithin(executor, input)).recorded,
  );
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
  return withTransaction((executor) => failLoginTransactionWithin(executor, loginTxnId, reason));
}

/** The same terminal move on a caller's executor, so the audit row shares it. */
async function failLoginTransactionWithin(
  executor: Executor,
  loginTxnId: string,
  reason: LoginTransactionFailureReason,
): Promise<boolean> {
  const result = await executor.query(
    `UPDATE login_transactions
        SET status = 'failed', consumed_at = NOW(), consumed_outcome = 'failed',
            failure_reason = $2
      WHERE login_txn_id = $1 AND status IN ('pending', 'consuming')
      RETURNING tenant_id, user_link_id, purpose`,
    [loginTxnId, reason],
  );
  if (result.rows.length === 0) return false;
  const row = result.rows[0] as Row;
  await auditLogin(executor, {
    loginTxnId,
    tenantId: row.tenant_id === null ? null : String(row.tenant_id),
    userLinkId: row.user_link_id === null ? null : String(row.user_link_id),
    // Expiry is its own transition in the inventory: an operator reading "this
    // login ran out of time" must not have to infer it from a generic failure.
    eventType: reason === 'expired' ? 'identity.login.expired' : 'identity.login.failed',
    details: { purpose: String(row.purpose), reason },
  });
  return true;
}

/** How many stale login transactions ONE pass will age. Bounded on purpose. */
export const LOGIN_TRANSACTION_EXPIRY_DEFAULT_BATCH = 200;
const LOGIN_TRANSACTION_EXPIRY_MAX_BATCH = 1000;

/**
 * FBL-020-R5 §1.6 — THE LOGIN-TRANSACTION EXPIRY SWEEP: BOUNDED, IDEMPOTENT AND
 * CONCURRENCY-SAFE, in that order.
 *
 * ── what this replaces ──────────────────────────────────────────────────────
 *
 * One unbounded `UPDATE … WHERE status IN ('pending','consuming') AND expires_at <
 * NOW()`, with the audit rows written in a loop inside the same transaction. It was
 * idempotent — the second pass matched nothing — and it was neither of the other
 * two things §1.6 names:
 *
 *   - NOT BOUNDED. A backlog (an outage, a first deployment against an old
 *     database, a burst of abandoned logins) meant ONE statement locking every
 *     matching row and one transaction holding one pool connection for as long as
 *     it took, plus an audit INSERT per row before anything committed. The size of
 *     the work decided the size of the transaction, which is the shape that turns a
 *     backlog into an outage.
 *   - NOT CONCURRENCY-SAFE in the sense the clause means. Two workers were SAFE
 *     (the second found nothing to do) but they were not INDEPENDENT: the loser
 *     blocked on the winner's row locks for the whole pass rather than taking other
 *     work or finishing.
 *
 * ── the shape, and where the correctness actually lives ─────────────────────
 *
 * One row is claimed and transitioned per transaction, at most `limit` times.
 *
 *   - BOUNDED: `limit` is validated (1..1000, default 200) and each iteration is
 *     its own short transaction, so the pass gives its connection back between
 *     rows and a backlog is drained across passes instead of held in one.
 *   - IDEMPOTENT: `status IN ('pending','consuming')` is both the predicate that
 *     selects the work and the predicate the write invalidates. A second pass finds
 *     the row `failed` and matches nothing, so it writes no second audit row.
 *   - CONCURRENCY-SAFE for the SAME reason, not a different one: the loser of a
 *     race re-evaluates that predicate against the row as the winner left it and
 *     matches zero rows. `FOR UPDATE SKIP LOCKED` sits on top of that as a LIVENESS
 *     choice — it stops N workers convoying behind one row — and it is stated as
 *     such rather than as the guarantee, exactly as the support sweep documents.
 *
 * The audit row is written in the SAME transaction as the transition, so an aged
 * transaction with no trail — or a trail for a transition that rolled back — is not
 * a reachable state.
 */
export async function expireStaleLoginTransactions(options?: { limit?: number }): Promise<number> {
  const requested = options?.limit ?? LOGIN_TRANSACTION_EXPIRY_DEFAULT_BATCH;
  if (
    !Number.isInteger(requested) ||
    requested < 1 ||
    requested > LOGIN_TRANSACTION_EXPIRY_MAX_BATCH
  ) {
    throw new RangeError(
      `login transaction expiry batch limit must be an integer in 1..${LOGIN_TRANSACTION_EXPIRY_MAX_BATCH}`,
    );
  }
  let recorded = 0;
  for (let i = 0; i < requested; i += 1) {
    const aged = await withTransaction<boolean>(async (executor) => {
      const claimed = await executor.query(
        `UPDATE login_transactions
            SET status = 'failed', consumed_at = NOW(), consumed_outcome = 'failed',
                failure_reason = 'expired'
          WHERE login_txn_id = (
            SELECT lt.login_txn_id
              FROM login_transactions lt
             WHERE lt.status IN ('pending', 'consuming')
               AND lt.expires_at < NOW()
             ORDER BY lt.expires_at
             FOR UPDATE SKIP LOCKED
             LIMIT 1
          )
          RETURNING login_txn_id, tenant_id, user_link_id, purpose`,
      );
      if (claimed.rows.length === 0) return false;
      const raw = claimed.rows[0] as Row;
      await auditLogin(executor, {
        loginTxnId: String(raw.login_txn_id),
        tenantId: raw.tenant_id === null ? null : String(raw.tenant_id),
        userLinkId: raw.user_link_id === null ? null : String(raw.user_link_id),
        eventType: 'identity.login.expired',
        details: { purpose: String(raw.purpose), reason: 'expired' },
      });
      return true;
    });
    if (!aged) break;
    recorded += 1;
  }
  return recorded;
}
