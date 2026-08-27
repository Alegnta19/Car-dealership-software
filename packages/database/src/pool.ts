import { Pool, PoolClient, QueryResult } from 'pg';
import { getDatabaseConfig, logger, ServiceUnavailableError } from '@dealer/platform';

/**
 * Anything that can run a statement: the shared pool, or a client bound to an open
 * transaction. Service functions accept an `Executor` so the same helper works both
 * inside and outside a transaction.
 */
export interface Executor {
  query(sql: string, params?: unknown[]): Promise<QueryResult<any>>;
}

let pool: Pool | null = null;

/**
 * The connection this operation was using is gone, so the operation did not happen.
 *
 * TRANSIENT INFRASTRUCTURE, never an application or authorization outcome. The three
 * ways this fires — `idle_in_transaction_session_timeout` (SQLSTATE 25P03), an operator
 * or crash shutdown (57P01/57P02), a severed socket — all say the same thing: the
 * session this operation was using ended under it and the caller may retry. None of them
 * says anything about who the caller is, so this must never be turned into a revoked
 * session, a consumed step-up grant, or a denied policy decision.
 *
 * ALL THREE arrive as this class REGARDLESS OF HOW THE LOSS IS OBSERVED — as an
 * `'error'` event on the client when no statement was running, or as the REJECTION OF
 * THE IN-FLIGHT STATEMENT when one was. `withTransaction` classifies from the ERROR
 * ITSELF, not from which of the two happens to be seen first. Correction R3 I1(a):
 * previously only the event was classified, so the ordinary restart / failover /
 * `pg_terminate_backend` shape — where pg rejects the running query with the FATAL's
 * SQLSTATE before the socket error surfaces — reached callers as a raw driver error,
 * rendered as `500 internal_error`, and nothing downstream retried a perfectly retryable
 * failure. What makes that uniformity true is `isLostConnection` below, and its coverage
 * is an ENUMERATION rather than a general rule: the SQLSTATEs and driver shapes listed
 * there, deliberately closed, and anything outside it stays whatever it already was.
 *
 * THE FIRST SENTENCE OF THIS DOC IS A CLAIM ABOUT ORIGIN, AND IT IS ENFORCED (R3
 * correction K1). Being a lost connection is not a property an error has by carrying a
 * socket errno — every socket in the process reports `ECONNRESET` — it is a property of
 * THIS pooled client having died. Shapes only a Postgres backend or the pg driver can
 * produce are taken on their own evidence; a bare errno is taken only when the client it
 * is claimed about is demonstrably gone. An error the transaction body threw from an
 * unrelated socket therefore reaches its caller as itself, which is what stops a
 * transport hiccup in some other subsystem from being reported as retryable database
 * infrastructure while the real cause is discarded.
 *
 * TWO THINGS THIS CLASS DOES NOT PROMISE, stated rather than implied away:
 *
 *   * `pgCode` CARRIES A SQLSTATE ONLY WHEN THE OBSERVATION THAT REPORTED THE LOSS
 *     CARRIED ONE. A severed socket has none at all — that shape is a Node socket
 *     error, and there is no server left to send a code. And when one loss is visible
 *     both ways at once (the FATAL notice and the socket reset are the same failure),
 *     the first observation wins, which under a concurrent burst is sometimes the bare
 *     reset — 2 of 20 requests with `PGPOOL_MAX=3`, 20 concurrent transactions and a
 *     300ms idle bound, measured by the R3 review. Those requests are still typed,
 *     still 503, still retryable —
 *     only the SQLSTATE in their log line is absent. Making the promise unconditional
 *     would mean holding every lost-connection rejection open to wait for a second
 *     observation that may never come, trading the prompt failure this whole mechanism
 *     exists to give for a diagnostic nicety. `pgCode` is therefore best-effort
 *     diagnostics; the CLASS is the contract callers branch on.
 *   * WHETHER A COMMIT LANDED. For 25P03, and for any loss observed between statements,
 *     the transaction was rolled back server-side and a retry starts from the prior
 *     state. If the loss is observed while `COMMIT` is in flight, the driver cannot know
 *     whether the server had already flushed the commit record, and nothing here
 *     distinguishes that case — a caller that retries must be safe to repeat or must
 *     re-read state first.
 *
 * `message` is a fixed constant. It reaches the client through the 503 envelope, and
 * driver text can echo row values and connection material, so none of it is carried
 * here; the SQLSTATE, when there is one, is kept on `pgCode` for logs and diagnosis only.
 */
export class DatabaseConnectionLostError extends ServiceUnavailableError {
  /** The Postgres SQLSTATE when the observed failure carried one (e.g. `25P03`). */
  public readonly pgCode: string | undefined;

  constructor(pgCode?: string) {
    super('The database connection was lost before this operation completed', {
      code: 'database_connection_lost',
    });
    this.pgCode = pgCode;
  }
}

/**
 * The CLASS half of a SQLSTATE — its first two characters — enumerated as PostgreSQL
 * itself defines them (server `errcodes.txt`, rendered as Appendix A "PostgreSQL Error
 * Codes"). Needed because the CHARACTER GRAMMAR alone cannot tell a SQLSTATE from a Node
 * errno, and the shape test used to be the only test (R3 correction K2).
 *
 * The grammar is `<class><subclass>`, five characters drawn from digits and UPPER-CASE
 * Latin letters (SQL:2016 `<SQLSTATE char>`); the subclass is unconstrained beyond that.
 * `EPIPE` is five upper-case Latin letters, so it SATISFIES that grammar completely — no
 * honest tightening of the character rule rejects it, and a rule invented to reject it
 * would reject real codes too. What rejects it is that `EP` is not a class PostgreSQL
 * defines. That is the only precise discriminator available, so it is the one used.
 *
 * A class the server adds in a future release would be read as "no SQLSTATE" until it is
 * listed here. That is the safe direction: `pgCode` is documented as best-effort
 * diagnostics, classification does not consult it, and the alternative — accepting
 * anything five characters wide — is what put a Node errno in a SQLSTATE-labelled field.
 */
const SQLSTATE_CLASSES: ReadonlySet<string> = new Set(
  (
    '00 01 02 03 08 09 0A 0B 0F 0L 0P 0Z ' +
    '20 21 22 23 24 25 26 27 28 2B 2D 2F ' +
    '34 38 39 3B 3D 3F 40 42 44 ' +
    '53 54 55 57 58 72 F0 HV P0 XX'
  ).split(' '),
);

/**
 * Reads the SQLSTATE off a driver error without trusting its shape.
 *
 * Accepts a code only when it is five characters of `[0-9A-Z]` AND its first two are a
 * class PostgreSQL defines. Lower case is rejected because SQLSTATE has none. The class
 * test is what keeps Node errnos out: `ECONNRESET` and `ETIMEDOUT` are the wrong LENGTH,
 * but `EPIPE` is not — it is exactly five upper-case letters, and before this it was
 * reported as `pgCode: 'EPIPE'`, a non-value to any operator filtering logs by SQLSTATE.
 */
function sqlStateOf(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code !== 'string' || !/^[0-9A-Z]{5}$/.test(code)) return undefined;
  return SQLSTATE_CLASSES.has(code.slice(0, 2)) ? code : undefined;
}

/**
 * SQLSTATEs that mean THE SERVER ENDED THIS SESSION. A CLOSED enumeration: everything
 * outside it keeps whatever it already was, because the cost of guessing wrong runs both
 * ways — a missed shape is a retryable failure nobody retries, and an extra shape is an
 * application error dressed up as retryable infrastructure, which invites a client to
 * repeat a request that will never succeed.
 *
 *   * `25P03` idle_in_transaction_session_timeout — the D1 idle bound firing. FATAL;
 *     the server closes the connection and rolls the transaction back.
 *   * `57P01` admin_shutdown — an operator shutdown or restart, a failover, or a
 *     `pg_terminate_backend` on this backend. This is the shape that lands on an
 *     IN-FLIGHT statement, and the one correction I1(a) exists for.
 *   * `57P02` crash_shutdown — a sibling backend crashed and the server is recycling
 *     every session. Same server-side meaning as 57P01, reported by the same path.
 *
 * DELIBERATELY NOT MEMBERS:
 *   * `57014` query_canceled — `statement_timeout` (or an explicit cancel). The bound
 *     working as designed on a connection that stays open and reusable; it is an
 *     ordinary catchable query error and calling it a lost connection would be a lie.
 *   * `25P02` in_failed_sql_transaction — an aborted transaction on a LIVE connection.
 *   * `57P03` cannot_connect_now — the answer to an attempt to OPEN a session (the
 *     server is starting up or shutting down). It surfaces from `getPool().connect()`,
 *     above the checkout this classifier covers, and nothing was lost because nothing
 *     was established.
 *   * class `08` connection-exception codes — not observed from this driver on an
 *     established session; node-postgres reports a broken socket through the driver
 *     shapes below instead of a SQLSTATE. The enumeration lists the shapes this stack
 *     actually produces rather than everything the standard names.
 */
const SESSION_ENDED_SQLSTATES: ReadonlySet<string> = new Set(['25P03', '57P01', '57P02']);

/**
 * The severed-socket shapes: the same loss with NO SQLSTATE, because there is no server
 * left to send one. node-postgres reports these as plain `Error`s, so the message is the
 * only discriminator available. They are EXACT strings taken from the driver's own source
 * (`node_modules/pg/lib/client.js`, pg 8.22.0 as installed) rather than a pattern that
 * could drift into matching application text — and because a dependency's wording is not
 * this repo's to control, a test asserts that the installed driver still contains both,
 * so a pg upgrade that reworded them fails loudly instead of silently narrowing this
 * allowlist.
 *
 *   * `Connection terminated unexpectedly` — the socket closed with a statement pending.
 *   * `Client has encountered a connection error and is not queryable` — a statement
 *     issued on a client that has already taken a connection error.
 *
 * NOT allowlisted, and the distinction matters: `Client was closed and is not queryable`
 * and `Connection terminated` are what pg says when THIS PROCESS ended the connection
 * (`closePool`, or a released client used after the fact). The first of those is the
 * classic use-after-release symptom, and turning a programming error into a retryable
 * 503 would hide the bug instead of reporting it.
 */
const SEVERED_SOCKET_MESSAGES: ReadonlySet<string> = new Set([
  'Connection terminated unexpectedly',
  'Client has encountered a connection error and is not queryable',
]);

/**
 * Socket-level failures reported by Node rather than by pg: the peer reset the
 * connection, the pipe is gone, or the socket timed out. All three describe an
 * ESTABLISHED connection that has died. Connect-time codes (`ECONNREFUSED`,
 * `ENOTFOUND`, `EAI_AGAIN`) are excluded — nothing was lost, nothing was checked out.
 *
 * THESE ARE NOT SELF-IDENTIFYING, and that is why they are matched conditionally (R3
 * correction K1). A bare Node errno says A SOCKET DIED; it does not say WHICH ONE. The
 * SQLSTATEs above could only have come from a Postgres server and the message shapes
 * below are the pg driver's own wording, but `ECONNRESET` is what every socket in the
 * process reports — an outbound HTTP client, a cache client, a message broker. Matching
 * it on sight meant any such error merely PASSING THROUGH `withTransaction`'s catch was
 * relabelled as a lost database connection: the real error was discarded, the ROLLBACK
 * was skipped, and a healthy pooled connection was destroyed. `isSeveredSocketErrno`
 * recognises only the SHAPE; `clientHasTakenConnectionError` is the evidence that
 * promotes it, and `withTransaction` is the only place the two are put together.
 */
const SEVERED_SOCKET_CODES: ReadonlySet<string> = new Set(['ECONNRESET', 'EPIPE', 'ETIMEDOUT']);

/**
 * Does this error, ON ITS OWN EVIDENCE, say the connection this checkout was using is
 * gone? Only shapes that could not have come from anywhere else are members:
 *
 *   * a SESSION-ENDED SQLSTATE — only a Postgres backend emits one; and
 *   * a SEVERED-SOCKET MESSAGE — verbatim pg driver text, asserted against the installed
 *     driver by test, so it is this connection's driver speaking.
 *
 * Answered from the ERROR, so it holds wherever such an error came from: a rejected
 * statement, a rejected `ROLLBACK`, or a client `'error'` event. A
 * `DatabaseConnectionLostError` itself is NOT a member — its `code` is an application
 * code and its message is the fixed constant — so a lost connection reported by some
 * OTHER client (a nested transaction) is never mistaken for evidence about this one.
 *
 * Bare socket errnos are deliberately NOT decided here: they need a second fact about
 * THIS client, which only the checkout scope has. See `isLostOnThisClient` in
 * `withTransaction`.
 */
function isLostConnection(err: unknown): boolean {
  const shape = err as { code?: unknown; message?: unknown } | null;
  const code = typeof shape?.code === 'string' ? shape.code : undefined;
  if (code !== undefined && SESSION_ENDED_SQLSTATES.has(code)) return true;
  return typeof shape?.message === 'string' && SEVERED_SOCKET_MESSAGES.has(shape.message);
}

/** Does this error carry one of the severed-socket errnos? SHAPE ONLY — see below. */
function isSeveredSocketErrno(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && SEVERED_SOCKET_CODES.has(code);
}

/**
 * Has THIS POOLED CLIENT itself taken a connection error (R3 correction K1)? The evidence
 * a bare errno needs before it may be read as a lost database connection.
 *
 * pg sets `_queryable` to `false` in `_handleErrorEvent`, and does so BEFORE it rejects
 * the in-flight statement or emits `'error'` on the client (pg 8.22.0 `lib/client.js`).
 * That handler is also the only path that can deliver an ERRNO-CARRYING error to a
 * checked-out client: the other caller of `_errorAllQueries`, the connection's `'end'`
 * handler, raises a plain `Connection terminated unexpectedly` with no `code` at all —
 * which is why that shape is matched on its message instead. So on a genuine severed
 * socket this reads false however the loss is first seen, and on an error the BODY threw
 * from an unrelated socket it reads true and the error stays the caller's.
 *
 * A pg that renamed the flag would read "not gone", and the errno would reach the caller
 * unchanged rather than be reclassified on a guess — the safe direction, and a loud one:
 * the `severed-socket` scenario tears down a real socket through the installed driver and
 * asserts this flag flips, so the rename fails a test instead of quietly changing
 * behaviour.
 */
function clientHasTakenConnectionError(client: PoolClient): boolean {
  return (client as unknown as { _queryable?: unknown })._queryable === false;
}

/**
 * FBL-020-R3 correction D1 — SERVER-SIDE bounds, set as connection startup
 * parameters so every pooled connection is born with them.
 *
 * Two different failures, two different bounds:
 *
 *   * `statement_timeout` caps any ONE statement, including the time it spends
 *     waiting for a row lock. A caller that queues behind a lock somebody else is
 *     holding indefinitely now fails instead of joining the pile-up.
 *   * `idle_in_transaction_session_timeout` caps an OPEN TRANSACTION that is
 *     running nothing at all. That is precisely the shape of the defect this
 *     correction closes: a `BEGIN`, a `SELECT ... FOR UPDATE`, and then an untimed
 *     provider HTTP call, during which the transaction is idle and its pool
 *     connection — one of ten the whole API shares — is unavailable to every other
 *     tenant. Postgres now ends such a session rather than trusting application
 *     code never to do it.
 *
 * These are the SECOND line. The first is architectural (no transaction is held
 * across a network call at all); a timeout only decides how bad it is when a
 * future caller forgets.
 *
 * WHAT THE FUTURE CALLER WHO FORGETS ACTUALLY GETS — the two bounds fail in
 * fundamentally different ways, and only one of them was survivable as shipped:
 *   * `statement_timeout` is a normal, CATCHABLE query error (SQLSTATE 57014). It is
 *     delivered on the in-flight query, the connection stays open and reusable, and
 *     ordinary `try`/`catch` sees it. Nothing more is needed.
 *   * `idle_in_transaction_session_timeout` is a FATAL (25P03). Postgres closes the
 *     connection, and by definition there is no in-flight query to attach the error
 *     to — being idle is the whole trigger — so the driver raises it as an `'error'`
 *     EVENT on the client, not as a rejected query promise. `withTransaction` below
 *     owns that event for the duration of the checkout so it becomes ONE failed
 *     request; see the comment there for why it has to.
 * With that in place this bound is safe to keep, and it is the only bound that
 * covers the idle-transaction shape at all: `statement_timeout` cannot fire when no
 * statement is running, and the pool's `connectionTimeoutMillis` only bounds how long
 * OTHER callers wait — it never frees the connection being held.
 *
 * SCOPING — why these values cannot break legitimate work:
 *   * they are set as `options` at CONNECTION START, so they are per-connection
 *     settings a session may lower or raise for itself;
 *   * the MIGRATION RUNNER does exactly that: `scripts/migrate.ts` issues
 *     `SET LOCAL statement_timeout = 0` and
 *     `SET LOCAL idle_in_transaction_session_timeout = 0` inside each migration's
 *     own transaction, so an index build or a long backfill is never interrupted,
 *     and the exemption expires with that transaction;
 *   * 30s for a single statement is an order of magnitude above anything this
 *     codebase issues (the heaviest is a 30-day metrics aggregate);
 *   * 15s of an OPEN transaction doing NOTHING is not something correct code
 *     does — every `withTransaction` body here runs statements back to back;
 *   * both are configurable, and 0 removes the bound entirely.
 */
// FBL-020-R7-C2 §1 — there is deliberately NO `-c role=` startup option here
// any more. R7 §3.7 had the pool assume the runtime role at connection startup
// when DATABASE_RUNTIME_ROLE was set; that made an OWNER login acceptable by
// dressing it in the runtime role, reversibly (`RESET ROLE` lands back on the
// owner), and only when the option happened to be present. The application now
// authenticates DIRECTLY as the non-owner runtime login (migration 060's
// dealership_app) in its DATABASE_URL, the configuration loader refuses
// DATABASE_RUNTIME_ROLE outright, and the posture gate asserts both
// session_user and current_user — so there is no switched identity left to
// conceal anything behind.
function serverSideTimeouts(
  statementTimeoutMs: number,
  idleInTransactionTimeoutMs: number,
): { options?: string } {
  const settings: string[] = [];
  if (statementTimeoutMs > 0) settings.push(`-c statement_timeout=${statementTimeoutMs}`);
  if (idleInTransactionTimeoutMs > 0) {
    settings.push(`-c idle_in_transaction_session_timeout=${idleInTransactionTimeoutMs}`);
  }
  return settings.length === 0 ? {} : { options: settings.join(' ') };
}

export function getPool(): Pool {
  if (pool) return pool;

  const config = getDatabaseConfig();
  const connectionString = config.databaseUrl;

  pool = new Pool({
    connectionString,
    max: config.pgPoolMax,
    idleTimeoutMillis: config.pgPoolIdleMs,
    connectionTimeoutMillis: config.pgPoolConnectMs,
    ...serverSideTimeouts(config.pgStatementTimeoutMs, config.pgIdleInTransactionTimeoutMs),
    ...(config.pgSslRequire ? { ssl: { rejectUnauthorized: false } } : {}),
  });

  // Covers IDLE clients only. pg-pool swaps this listener out for the duration of a
  // checkout (`_acquireClient` calls `client.removeListener('error', idleListener)`),
  // so it is NOT the safety net for a checked-out client — see `withTransaction`.
  pool.on('error', (err) => logger.error({ err }, 'Idle Postgres client error'));
  return pool;
}

/**
 * Runs a single statement on the shared pool (implicit one-statement transaction).
 *
 * Safe against a mid-flight FATAL without any help from here: `pool.query` checks a
 * client out, attaches its own `client.once('error', …)` for the call, and releases the
 * client WITH that error so the pool discards it (pg-pool `Pool.prototype.query`). The
 * gap this file has to close is the explicit-checkout path below.
 */
export async function query(sql: string, params?: unknown[]): Promise<QueryResult<any>> {
  return getPool().query(sql, params);
}

/**
 * Runs `fn` inside a single BEGIN/COMMIT on one dedicated client, rolling back on any
 * throw. Every multi-statement business operation goes through this — without it a
 * mid-sequence failure leaves half-written aggregates behind (e.g. a repair order with
 * no queue entry, or approved line items with no authorization row).
 *
 * Note: a statement that errors aborts the whole Postgres transaction, so nothing
 * inside `fn` may swallow a query error and continue. Best-effort work that is allowed
 * to fail independently (platform audit rows, metrics) is done after the commit.
 *
 * WHY THIS FUNCTION OWNS AN `'error'` LISTENER (FBL-020-R3 correction G1)
 *
 * A checked-out client has NO error listener. pg-pool removes the pool's idle listener
 * when it hands the client over and attaches nothing in its place, and re-attaches it
 * only on release. So an asynchronous FATAL that arrives BETWEEN this transaction's
 * statements — `idle_in_transaction_session_timeout` (25P03), an operator shutdown, a
 * killed backend, a dropped socket — lands on a Node EventEmitter with zero `'error'`
 * listeners. Node's rule for that is to throw it as an uncaught exception from the
 * event loop, which:
 *   * the `try`/`catch` below structurally CANNOT intercept — the throw does not
 *     originate inside the awaited expression, it originates in the socket read that
 *     delivered the message; and
 *   * with no process-level handler installed anywhere in this repo, terminates the
 *     process, dropping every in-flight request for every tenant.
 * A bound whose enforcement kills the API is worse than the pool exhaustion it exists
 * to prevent: exhaustion degrades and recovers, this does not.
 *
 * Owning the listener for exactly the checkout window fixes that at the source:
 *   * the FATAL is captured, so it is never an unhandled `'error'` event;
 *   * it is raced against the body, so the request fails PROMPTLY as a rejected
 *     promise this function's own `catch` handles, instead of stalling until the body
 *     happens to issue its next statement;
 *   * the listener is removed on the way out, so it can neither leak onto a pooled
 *     client nor double-handle a later failure; and
 *   * the client is released WITH the error, which makes pg-pool destroy it instead of
 *     returning a dead connection to the pool. The pool itself stays usable and simply
 *     opens a fresh connection for the next caller.
 *
 * NO PROCESS-LEVEL `uncaughtException` HANDLER IS ADDED, deliberately. A handler that
 * swallowed this would leave the process running in an unknown state, and one that
 * logged and exited non-zero would be Node's existing default with extra moving parts —
 * neither repairs the request, because only this scope knows which transaction died and
 * which promise to reject. It would also destroy the evidence: with a global net in
 * place, a surviving process would no longer prove that this listener works. The fix
 * belongs where the client is checked out, and that is here.
 *
 * TWO PLACES A LOST CONNECTION IS OBSERVED, ONE LATCH (R3 correction I1(a))
 *
 * The listener above is only HALF the coverage, and the half that fires when nothing is
 * running. When the FATAL lands on an IN-FLIGHT statement — what a restart, a failover or
 * a `pg_terminate_backend` does to a request that is mid-query — pg rejects that statement
 * with the FATAL's SQLSTATE BEFORE the socket `'error'` event is delivered, so the race
 * below settles with the raw driver error and the listener has not run yet.
 *
 * Both observations therefore end at `recordConnectionLost`, which latches the first one
 * and logs it exactly once, so one broken connection is one failed request and one log
 * line whichever way it was seen. They reach it differently, and deliberately: a client
 * `'error'` EVENT needs no classification, because pg raises events only for
 * connection-level failures and delivers statement errors as rejected promises; a REJECTED
 * STATEMENT is classified first, by `isLostConnection`, because most of them are ordinary
 * query errors that must pass through untouched.
 *
 * ROLLBACK SUPPRESSION IS DECIDED AFTER THE AWAITS IT DEPENDS ON (R3 correction I1(b))
 *
 * A lost connection has already ended the transaction server-side and there is no session
 * left to speak to; a ROLLBACK into it can only fail, and logging that failure over the
 * real cause reports a rollback bug that is not there. Testing the latch at CATCH ENTRY
 * did not achieve that: on the in-flight path the `'error'` event has not been delivered
 * yet at that point, so the guard read `undefined`, the ROLLBACK went out, and the event
 * arrived DURING the await — the run logged the real cause and then `ROLLBACK failed`
 * four milliseconds later, exactly the sequence the guard exists to prevent. Both
 * decisions below are now taken from state that is current at the point of use: the
 * caught error is classified directly, and the latch is re-read after the ROLLBACK await
 * rather than before it.
 *
 * WHAT HAPPENS TO `fn` WHEN THE CONNECTION IS LOST — ABANDONED, NOT CANCELLED
 *
 * Racing the loss against the body means this function REJECTS WHILE `fn` MAY STILL BE
 * RUNNING. There is no way to cancel a Promise, so the body's continuation keeps going
 * after the caller has been told the operation failed:
 *   * its DATABASE work cannot leak — the client is destroyed on release, so every
 *     further statement on `tx` fails and nothing it had written was committed;
 *   * its NON-DATABASE side effects DO still complete — an outbound HTTP call, a cache
 *     write, an in-memory mutation, a queued job. They run AFTER the caller has seen the
 *     failure, and nothing awaits or reports them.
 * That is deliberate, and it is strictly better than the alternative it replaced (hanging
 * until the body finishes, holding a pooled connection nobody else can use). The rule it
 * puts on callers: DO BEST-EFFORT NON-DATABASE WORK AFTER THE COMMIT, not inside the
 * body — which is what the note above about post-commit work already requires for
 * independent-failure reasons. The abandoned body raises no unhandled rejection: `fn`'s
 * promise is a racer, so its later rejection is observed.
 * Written up for callers in docs/identity/KNOWN-LIMITATIONS.md.
 */
export async function withTransaction<T>(fn: (tx: Executor) => Promise<T>): Promise<T> {
  const client: PoolClient = await getPool().connect();

  let connectionLost: DatabaseConnectionLostError | undefined;
  let signalLost: (err: DatabaseConnectionLostError) => void = () => undefined;

  // Settles only on failure, and is always one of the racers below, so `Promise.race`
  // observes its rejection and it can never surface as an unhandled rejection. The
  // executor runs synchronously, so `signalLost` is armed before any I/O can happen.
  const lost = new Promise<never>((_resolve, reject) => {
    signalLost = reject;
  });

  /**
   * One checkout fails once. A broken connection is visible several times over — the
   * FATAL notice, the socket closing, the rejection of whatever statement was in flight,
   * the rejection of anything issued afterwards — and they are all the same failure, so
   * the first observation is latched, logged, and returned to every later caller.
   */
  const recordConnectionLost = (err: unknown): DatabaseConnectionLostError => {
    if (connectionLost !== undefined) return connectionLost;
    connectionLost = new DatabaseConnectionLostError(sqlStateOf(err));
    logger.error(
      { component: 'database.pool', event: 'connection_lost_in_transaction', err },
      'Postgres connection lost while a transaction was checked out',
    );
    return connectionLost;
  };

  // Any `'error'` event on a CHECKED-OUT client is a connection-level failure — pg
  // delivers statement errors as rejected query promises and never as events — so the
  // event needs no classification. Re-signalling an already rejected `lost` is a no-op,
  // which is what makes the latch above safe to hit twice.
  const onClientError = (err: Error): void => {
    signalLost(recordConnectionLost(err));
  };
  client.on('error', onClientError);

  /**
   * The full rule, and the only classifier the catch below uses: a self-identifying
   * lost-connection shape, OR a bare socket errno that THIS CLIENT is answerable for —
   * because it arrived on the client's own `'error'` event (already latched) or because
   * the client is no longer queryable. An `ECONNRESET` from an outbound HTTP call inside
   * the body satisfies neither and is not a database error.
   */
  const isLostOnThisClient = (err: unknown): boolean =>
    isLostConnection(err) ||
    (isSeveredSocketErrno(err) &&
      (connectionLost !== undefined || clientHasTakenConnectionError(client)));

  try {
    await Promise.race([client.query('BEGIN'), lost]);
    const result = await Promise.race([fn(client), lost]);
    await Promise.race([client.query('COMMIT'), lost]);
    return result;
  } catch (err) {
    // CLASSIFY FROM THE ERROR, not from which racer won: when the FATAL landed on an
    // in-flight statement, `err` is the first — and until the socket catches up, the
    // only — evidence that the session is gone. But an error only PASSING THROUGH here
    // is not evidence about this connection at all, so a bare errno also has to be
    // attributable to this client (K1); anything else leaves as itself, with the
    // ROLLBACK below attempted and the connection released healthy.
    const lostConnection = isLostOnThisClient(err) ? recordConnectionLost(err) : connectionLost;

    if (lostConnection === undefined) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        // Re-read `connectionLost` HERE, after the await: the `'error'` event for a
        // connection that died mid-transaction arrives in exactly this window, and a
        // decision taken before the await is the bug I1(b) describes. Either way the
        // original `err` is still what the caller is told; this only decides whether a
        // failed recovery attempt is worth a log line of its own.
        if (isLostOnThisClient(rollbackErr)) recordConnectionLost(rollbackErr);
        else if (connectionLost === undefined) {
          logger.error({ err: rollbackErr }, 'ROLLBACK failed');
        }
      }
    }
    throw lostConnection ?? err;
  } finally {
    client.removeListener('error', onClientError);
    // A truthy argument makes pg-pool destroy the client instead of pooling it, so a
    // connection that has taken a FATAL is never handed to the next caller. pg-pool
    // also drops any client whose `_queryable` flag has gone false, which covers the
    // same case from the other side; passing the error states the intent here rather
    // than relying on a private flag, and covers a failure that left the socket
    // nominally usable. The observable guarantee either way — the pool serves the next
    // caller — is asserted with a single-slot pool in the G1 tests.
    client.release(connectionLost);
  }
}

export async function closePool(): Promise<void> {
  if (!pool) return;
  await pool.end();
  pool = null;
}
