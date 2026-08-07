/**
 * FBL-020-R3 correction G1 — CHILD PROCESS probe for the server-side pool bounds.
 *
 * Why a child process and not an in-process test: the defect being closed is that a
 * Postgres FATAL delivered to a CHECKED-OUT client used to arrive as an unhandled
 * `'error'` event and TERMINATE THE NODE PROCESS. An in-process test cannot assert
 * "the process survived" — if the process dies the test run dies with it, and if
 * anything anywhere installs an `uncaughtException` handler an in-process test would
 * pass on a swallow rather than on a fix. Running the scenario in a fresh child and
 * asserting the child's EXIT CODE makes survival a real, falsifiable observation.
 *
 * It also gives each scenario its own pool built from its own environment, so the
 * bounds can be tightened to test-sized values without touching the suite's pool.
 *
 * Contract with the parent: emit exactly one `RESULT <json>` line on stdout and exit
 * naturally. No process-level `uncaughtException` / `unhandledRejection` handler is
 * installed here, and the count of them is reported so the parent can prove that.
 */
import { DatabaseConnectionLostError, closePool, query, withTransaction } from '@dealer/database';
import { ConflictError } from '@dealer/platform';

type Json = Record<string, unknown>;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * How long the offending transaction body stalls. Deliberately many times the
 * idle-in-transaction bound the parent configures, so the gap between "surfaced when the
 * FATAL arrived" and "surfaced when the body next touched the connection" is unmistakable
 * rather than a matter of milliseconds.
 */
const IDLE_STALL_MS = 4_000;

/** Bounded, non-echoing description of a failure: shape and codes, never driver text. */
function describeError(err: unknown): Json {
  const e = err as { name?: unknown; code?: unknown; message?: unknown; statusCode?: unknown };
  const message = typeof e.message === 'string' ? e.message : '';
  return {
    name: typeof e.name === 'string' ? e.name : 'unknown',
    sqlState: typeof e.code === 'string' ? e.code : null,
    statusCode: typeof e.statusCode === 'number' ? e.statusCode : null,
    isConnectionLost: err instanceof DatabaseConnectionLostError,
    retryable: (err as { retryable?: unknown }).retryable === true,
    pgCode: err instanceof DatabaseConnectionLostError ? (err.pgCode ?? null) : null,
    mentionsStatementTimeout: message.includes('statement timeout'),
  };
}

async function capture(fn: () => Promise<unknown>): Promise<Json> {
  try {
    await fn();
    return { threw: false };
  } catch (err) {
    return { threw: true, ...describeError(err) };
  }
}

/**
 * The shipped defect shape: a transaction that goes idle past
 * `idle_in_transaction_session_timeout`. The bound comes from the POOL (the production
 * mechanism — a connection startup parameter), not from a `SET` inside the body.
 */
async function idleFatal(): Promise<Json> {
  const startedAt = Date.now();
  const caught = await capture(() =>
    withTransaction(async (tx) => {
      await tx.query('SELECT 1');
      // Far longer than PG_IDLE_IN_TRANSACTION_TIMEOUT_MS: this is the "future caller
      // who forgets" and awaits non-database work while holding a transaction open.
      await sleep(IDLE_STALL_MS);
      return tx.query('SELECT 2');
    }),
  );
  // How long the caller waited to be TOLD. The FATAL has to surface when it arrives, not
  // whenever the body next happens to touch the connection: a request that is waiting on
  // something slow (or on nothing at all) would otherwise hang long after its
  // transaction is already dead, which is the pile-up this bound exists to prevent.
  const elapsedMs = Date.now() - startedAt;

  // The pool must have survived too: the dead connection is discarded and a fresh one
  // opened. Run with PGPOOL_MAX=1 so this can only pass if the slot was truly released.
  const plain = (await query('SELECT 42 AS v')).rows[0].v;
  const inTransaction = await withTransaction(
    async (tx) => (await tx.query('SELECT 43 AS v')).rows[0].v,
  );

  return {
    caught,
    elapsedMs,
    idleStallMs: IDLE_STALL_MS,
    poolUsableAfter: Number(plain),
    transactionUsableAfter: Number(inTransaction),
  };
}

/**
 * The control, and the reason the two bounds need different treatment: `statement_timeout`
 * is an ordinary CATCHABLE error (SQLSTATE 57014) on the in-flight query. It must stay
 * exactly that — not reclassified as a lost connection — and the connection stays live.
 */
async function statementTimeout(): Promise<Json> {
  const bare = await capture(() => query('SELECT pg_sleep(2)'));
  const inTransaction = await capture(() =>
    withTransaction((tx) => tx.query('SELECT pg_sleep(2)')),
  );
  const plain = (await query('SELECT 44 AS v')).rows[0].v;
  return { bare, inTransaction, poolUsableAfter: Number(plain) };
}

/**
 * The migration-runner exemption, against a deliberately tight ambient bound: the two
 * `SET LOCAL` statements `scripts/migrate.ts` issues must let a long statement finish,
 * and the bound must be back in force on that same connection after COMMIT.
 * PGPOOL_MAX=1 guarantees "that same connection" is what the later queries observe.
 */
async function migrationExemption(): Promise<Json> {
  const ambientBefore = await capture(() => query('SELECT pg_sleep(2)'));

  const exempted = await capture(() =>
    withTransaction(async (tx) => {
      await tx.query('SET LOCAL statement_timeout = 0');
      await tx.query('SET LOCAL idle_in_transaction_session_timeout = 0');
      await tx.query('SELECT pg_sleep(2)');
      return null;
    }),
  );

  const settings = await query(
    `SELECT current_setting('statement_timeout') AS stmt,
            current_setting('idle_in_transaction_session_timeout') AS idle`,
  );
  const ambientAfter = await capture(() => query('SELECT pg_sleep(2)'));

  return {
    ambientBefore,
    exempted,
    restoredAfterCommit: {
      statementTimeout: String(settings.rows[0].stmt),
      idleInTransactionTimeout: String(settings.rows[0].idle),
    },
    ambientAfter,
  };
}

/** Seconds the in-flight statement asks for; only the kill below ever ends it. */
const IN_FLIGHT_SECONDS = 3;

/**
 * FBL-020-R3 correction I1(a) — the SAME FATAL, arriving while a statement is
 * IN FLIGHT. This is the ordinary operator/failover shape (`pg_terminate_backend`,
 * a restart, a promoted replica) and it is NOT the shape `idle-fatal` covers: pg
 * rejects the running query with the FATAL's SQLSTATE before the socket `'error'`
 * event fires, so the race in `withTransaction` settles with the RAW driver error
 * rather than with the listener's typed one. Classification therefore has to come
 * from the error, not from which racer won.
 *
 * Both bounds are configured OFF for this scenario so the only thing that can end
 * the transaction is the kill — the SQLSTATE observed is unambiguously 57P01.
 *
 * `stateWhenKilled` is reported so the scenario proves its own premise: a backend
 * running `pg_sleep` is `active`, and if it were `idle in transaction` this would
 * silently be a duplicate of `idle-fatal` instead of the uncovered shape.
 */
async function inFlightFatal(): Promise<Json> {
  let stateWhenKilled = 'not observed';
  // Assigned inside the body, awaited after it: a floating promise could otherwise
  // still be settling (or rejecting) when the process exits.
  let kill: Promise<void> = Promise.resolve();

  const startedAt = Date.now();
  const caught = await capture(() =>
    withTransaction(async (tx) => {
      const pid = Number((await tx.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      // A SECOND pooled connection does the killing (PGPOOL_MAX=2), which is what an
      // operator command or a failover looks like from this transaction's side.
      kill = (async () => {
        // Long enough that the statement below is unambiguously running.
        await sleep(300);
        const activity = await query('SELECT state FROM pg_stat_activity WHERE pid = $1', [pid]);
        stateWhenKilled = String(activity.rows[0]?.state ?? 'gone');
        await query('SELECT pg_terminate_backend($1)', [pid]);
      })().catch(() => undefined);
      return tx.query('SELECT pg_sleep($1)', [IN_FLIGHT_SECONDS]);
    }),
  );
  const elapsedMs = Date.now() - startedAt;
  await kill;

  const plain = (await query('SELECT 45 AS v')).rows[0].v;
  const inTransaction = await withTransaction(
    async (tx) => (await tx.query('SELECT 46 AS v')).rows[0].v,
  );

  return {
    caught,
    stateWhenKilled,
    elapsedMs,
    inFlightMs: IN_FLIGHT_SECONDS * 1_000,
    poolUsableAfter: Number(plain),
    transactionUsableAfter: Number(inTransaction),
  };
}

/**
 * The over-widening control for I1(a): an ordinary application refusal thrown by the
 * body. Reclassifying it would turn a 409 the caller must not retry into a retryable
 * 503, so the error must come out exactly as it went in — and this path must keep the
 * behaviour the connection-lost path deliberately skips:
 *   * the transaction is ROLLED BACK, proved by `transactionAgeMsAfter`. `now()` is
 *     fixed at transaction start, so if the connection were still inside the abandoned
 *     transaction the next statement would see an age of at least the body's stall;
 *   * the connection is POOLED, not destroyed, proved by the pid being the same one
 *     (PGPOOL_MAX=1, so there is exactly one to reuse).
 */
async function applicationError(): Promise<Json> {
  const pidBefore = Number((await query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
  const caught = await capture(() =>
    withTransaction(async (tx) => {
      // Makes the transaction measurably older than the probe that follows it.
      await tx.query('SELECT pg_sleep(0.7)');
      throw new ConflictError('probe: an ordinary domain refusal');
    }),
  );
  const after = await query(
    `SELECT pg_backend_pid() AS pid,
            (extract(epoch FROM (statement_timestamp() - now())) * 1000)::bigint AS tx_age_ms`,
  );
  return {
    caught,
    pidBefore,
    pidAfter: Number(after.rows[0].pid),
    transactionAgeMsAfter: Number(after.rows[0].tx_age_ms),
  };
}

/**
 * FBL-020-R3 correction K1 — the OTHER over-widening control, and the one that was
 * missing: an error the body threw that carries a SOCKET ERRNO from a socket that is not
 * this database connection. An outbound HTTP client, a cache client and a message broker
 * all report `ECONNRESET`, so matching the errno on sight reclassified an unrelated
 * transport failure as a lost database connection — discarding the real error behind a
 * fixed 503 message, skipping the ROLLBACK, and destroying a healthy pooled connection.
 *
 * Same two observations as `application-error`, because the required behaviour is the
 * same: the object comes out as it went in, the transaction is rolled back, and the
 * connection goes back to the pool. `sameObject` is reported separately because identity
 * is the point here — a reclassification would still produce an error, just not this one.
 */
const FOREIGN_SOCKET_ERROR: Error = Object.assign(
  new Error('probe: an outbound call from inside the body failed'),
  { code: 'ECONNRESET', syscall: 'read' },
);

async function foreignSocketError(): Promise<Json> {
  const pidBefore = Number((await query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
  let sameObject = false;
  const caught = await capture(async () => {
    try {
      await withTransaction(async (tx) => {
        // Makes the transaction measurably older than the probe that follows it.
        await tx.query('SELECT pg_sleep(0.7)');
        throw FOREIGN_SOCKET_ERROR;
      });
    } catch (err) {
      sameObject = err === FOREIGN_SOCKET_ERROR;
      throw err;
    }
  });
  const after = await query(
    `SELECT pg_backend_pid() AS pid,
            (extract(epoch FROM (statement_timestamp() - now())) * 1000)::bigint AS tx_age_ms`,
  );
  return {
    caught,
    sameObject,
    pidBefore,
    pidAfter: Number(after.rows[0].pid),
    transactionAgeMsAfter: Number(after.rows[0].tx_age_ms),
  };
}

/**
 * FBL-020-R3 corrections K1/K2 — a GENUINE severed socket, so the narrowing above is
 * shown to have kept the shape it exists to keep.
 *
 * The socket under this checked-out client is torn down with an `EPIPE`, which is what
 * Node reports when a write meets a closed pipe. Everything after that is the real
 * driver: pg's stream `'error'` handler, `_handleErrorEvent`, the in-flight statement
 * rejected, the client `'error'` event `withTransaction` owns. Killing the backend from
 * outside would produce a SQLSTATE instead (that is `in-flight-fatal`), and no test can
 * ask the network for a broken pipe on demand.
 *
 * Two things are reported that nothing else observes:
 *   * `pgCode` — `EPIPE` is exactly five upper-case letters, so the old five-character
 *     shape test admitted it and the field read `EPIPE`, a value no operator filtering
 *     by SQLSTATE can use. It must be absent.
 *   * `queryableBefore` / `queryableAfter` — the pg internal the attribution rule leans
 *     on. pg sets `_queryable` false in `_handleErrorEvent` before it rejects anything,
 *     which is what makes "is this errno attributable to THIS client" answerable at all.
 *     Read here so a pg release that renames or reorders it fails loudly.
 */
async function severedSocket(): Promise<Json> {
  const pidBefore = Number((await query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
  type Internals = {
    _queryable?: unknown;
    connection?: { stream?: { destroy(err?: Error): void } };
  };
  let internals: Internals | undefined;
  let queryableBefore: unknown;

  const caught = await capture(() =>
    withTransaction(async (tx) => {
      await tx.query('SELECT 1');
      internals = tx as unknown as Internals;
      queryableBefore = internals._queryable;
      const inFlight = tx.query('SELECT pg_sleep(2)');
      // Long enough that the statement above is unambiguously running.
      await sleep(150);
      internals.connection?.stream?.destroy(
        Object.assign(new Error('write EPIPE'), { code: 'EPIPE', syscall: 'write' }),
      );
      return inFlight;
    }),
  );
  const queryableAfter = internals?._queryable;
  // Lets the abandoned body's own rejection settle before the process reports.
  await sleep(150);

  const plain = (await query('SELECT 48 AS v')).rows[0].v;
  const inTransaction = await withTransaction(
    async (tx) => (await tx.query('SELECT 49 AS v')).rows[0].v,
  );

  return {
    caught,
    queryableBefore,
    queryableAfter,
    pidBefore,
    poolUsableAfter: Number(plain),
    transactionUsableAfter: Number(inTransaction),
  };
}

/** How long the abandoned body keeps running after the caller has been told. */
const ABANDONED_STALL_MS = 2_000;

/**
 * FBL-020-R3 I2(ii) — the CONTRACT CHANGE that racing the loss against the body
 * created, made observable so the documentation of it cannot quietly stop being true.
 *
 * `withTransaction` rejects while `fn` may still be running, and a Promise cannot be
 * cancelled, so the body's continuation keeps going after the caller has been told the
 * operation failed. This scenario reports both halves of that: WHEN the caller was told,
 * WHEN each of the body's non-database side effects ran, and what happened when the
 * abandoned body then tried to touch the database again.
 */
async function abandonedBody(): Promise<Json> {
  const startedAt = Date.now();
  const since = (): number => Date.now() - startedAt;
  const sideEffects: Json[] = [];
  let databaseAfterAbandonment: Json = { attempted: false };

  const caught = await capture(() =>
    withTransaction(async (tx) => {
      await tx.query('SELECT 1');
      // The idle bound ends the session during this stall, and the caller learns about
      // it immediately — while this body is still here, waiting.
      await sleep(ABANDONED_STALL_MS);
      // Ordinary non-database work: exactly what a body must NOT be doing, done at
      // exactly the moment the documentation says it still happens.
      for (const what of ['cache_write', 'in_memory_mutation', 'queued_job']) {
        sideEffects.push({ what, at: since() });
      }
      databaseAfterAbandonment = {
        attempted: true,
        ...(await capture(() => tx.query('SELECT 2'))),
      };
      return null;
    }),
  );
  const toldAt = since();
  // Waits for the abandoned continuation so the report OBSERVES it rather than assuming
  // it: without this the process could exit before the body ever got there.
  await sleep(ABANDONED_STALL_MS);

  return { caught, toldAt, stallMs: ABANDONED_STALL_MS, sideEffects, databaseAfterAbandonment };
}

const SCENARIOS: Record<string, () => Promise<Json>> = {
  'idle-fatal': idleFatal,
  'in-flight-fatal': inFlightFatal,
  'abandoned-body': abandonedBody,
  'application-error': applicationError,
  'foreign-socket-error': foreignSocketError,
  'severed-socket': severedSocket,
  'statement-timeout': statementTimeout,
  'migration-exemption': migrationExemption,
};

async function main(): Promise<void> {
  const name = process.argv[2] ?? '';
  const scenario = SCENARIOS[name];
  if (scenario === undefined) throw new Error(`unknown scenario: ${name}`);

  const handlers = {
    uncaughtException: process.listenerCount('uncaughtException'),
    unhandledRejection: process.listenerCount('unhandledRejection'),
  };
  const outcome = await scenario();
  process.stdout.write(`RESULT ${JSON.stringify({ scenario: name, handlers, ...outcome })}\n`);
  await closePool();
}

void main();
