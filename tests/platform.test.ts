import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { createApp } from '@dealer/api';
import {
  AppError,
  ValidationError,
  NotFoundError,
  UntrustedClientTrace,
  generateRequestId,
  bindRequestActor,
  getRequestContext,
  isSafeId,
  loadConfig,
  logger,
  runWithRequestContext,
  toProblemDetails,
} from '@dealer/platform';

/**
 * FBL-010 platform conventions: configuration validation (fail-fast, secret-safe),
 * request context (bounded ids, no cross-request leakage), the internal Problem Details
 * model, and PII-safe structured logging proven with sentinel values. Portable — no
 * database required.
 */

const VALID_ENV = {
  DATABASE_URL: 'postgres://user@localhost:5432/db',
};

describe('configuration boundary', () => {
  test('a valid environment loads with documented defaults and is immutable', () => {
    const config = loadConfig(VALID_ENV);
    assert.equal(config.port, 3000);
    assert.equal(config.shutdownGraceMs, 30_000);
    assert.equal(config.metricsIntervalMs, 60_000);
    assert.equal(config.metricsWindowDays, 30);
    assert.equal(config.jsonBodyLimit, '1mb');
    assert.equal(config.logLevel, 'info');
    assert.equal(config.serviceDefaultTimezone, 'UTC');
    assert.equal(config.pgPoolMax, 10);
    assert.ok(Object.isFrozen(config));
  });

  test('missing required variables fail naming the variable', () => {
    assert.throws(
      () => loadConfig({ ...VALID_ENV, DATABASE_URL: undefined }),
      /DATABASE_URL is required/,
    );
  });

  test('a short secret fails WITHOUT the value appearing in the error', () => {
    const sentinel = 'sentinel-short-secret-value';
    for (const key of ['WORKOS_API_KEY', 'WORKOS_COOKIE_PASSWORD'] as const) {
      try {
        loadConfig({
          ...VALID_ENV,
          IDENTITY_PROVIDER: 'workos',
          WORKOS_CLIENT_ID: 'client_x',
          WORKOS_API_KEY: 'k'.repeat(40),
          WORKOS_ISSUER: 'https://issuer.example.com',
          WORKOS_JWKS_URI: 'https://issuer.example.com/jwks',
          WORKOS_REDIRECT_URI: 'https://app.example.com/auth/callback',
          WORKOS_REAUTH_REDIRECT_URI: 'https://app.example.com/auth/reauth/callback',
          WORKOS_LOGOUT_REDIRECT_URI: 'https://app.example.com/',
          WORKOS_COOKIE_PASSWORD: 'c'.repeat(40),
          OIDC_AUDIENCE: 'aud',
          [key]: sentinel,
        });
        assert.fail('should have thrown');
      } catch (err) {
        const message = (err as Error).message;
        assert.match(message, new RegExp(key));
        assert.ok(!message.includes(sentinel), 'the secret value must never appear in the error');
      }
    }
  });

  test('malformed and out-of-range values are refused; boundaries hold', () => {
    assert.throws(() => loadConfig({ ...VALID_ENV, PORT: '0' }), /PORT must be an integer/);
    assert.throws(() => loadConfig({ ...VALID_ENV, PORT: '65536' }), /PORT must be an integer/);
    assert.throws(() => loadConfig({ ...VALID_ENV, PORT: 'yes' }), /PORT must be an integer/);
    assert.equal(loadConfig({ ...VALID_ENV, PORT: '65535' }).port, 65535);
    assert.throws(
      () => loadConfig({ ...VALID_ENV, LOG_LEVEL: 'loud' }),
      /LOG_LEVEL must be one of/,
    );
    assert.throws(() => loadConfig({ ...VALID_ENV, JSON_BODY_LIMIT: 'huge' }), /JSON_BODY_LIMIT/);
    assert.throws(() => loadConfig({ ...VALID_ENV, SHUTDOWN_GRACE_MS: '50' }), /SHUTDOWN_GRACE_MS/);
    assert.throws(
      () => loadConfig({ ...VALID_ENV, METRICS_WINDOW_DAYS: '0' }),
      /METRICS_WINDOW_DAYS/,
    );
  });
});

describe('configuration boundary — database slice', () => {
  test('the migration path needs only DATABASE_URL — never auth secrets', async () => {
    const { loadDatabaseConfig } = await import('@dealer/platform');
    const db = loadDatabaseConfig({ DATABASE_URL: 'postgres://user@localhost:5432/db' });
    assert.equal(db.databaseUrl, 'postgres://user@localhost:5432/db');
    assert.equal(db.pgPoolMax, 10);
    assert.throws(() => loadDatabaseConfig({}), /DATABASE_URL is required/);
  });
});

describe('request context', () => {
  /**
   * FBL-020-R4 section 2.3 - the authoritative id is GENERATED, and a caller-supplied
   * trace value cannot become one. `acceptOrGenerateId` used to return a well-formed
   * `x-request-id` unchanged, which made it the id of the request everywhere: logs, the
   * response header, and `policy_decisions.request_id`, which is append-only.
   */
  test('the authoritative request id is always generated, never adopted from a caller', () => {
    const ids = new Set([generateRequestId(), generateRequestId(), generateRequestId()]);
    assert.equal(ids.size, 3, 'each call mints a distinct id');
    for (const id of ids) assert.match(id, /^[0-9a-f-]{36}$/);

    // The bounded format still exists - it is what keeps a hostile header out of the
    // untrusted box below - but it no longer promotes anything to authoritative.
    assert.equal(isSafeId('a'.repeat(128)), true);
    assert.equal(isSafeId('a'.repeat(129)), false, 'over-length ids are refused');
    assert.equal(isSafeId('short'), false, 'under-length ids are refused');
    assert.equal(isSafeId('bad id with spaces'), false);
    assert.equal(isSafeId('log\ninjection-attempt'), false);
  });

  test('caller trace headers are retained ONLY as untrusted metadata, unreadable as an id', () => {
    const trace = new UntrustedClientTrace('edge-gateway-0042', 'bad id with spaces');
    assert.equal(trace.present(), true);
    assert.deepEqual(trace.describe(), {
      client_request_id_untrusted: 'edge-gateway-0042',
      client_correlation_id_untrusted: null,
    });

    // THE SEPARATION IS STRUCTURAL. The box has no string form at all, so it cannot be
    // interpolated into, assigned to, or mistaken for an id anywhere: the only way at
    // the value is through a field whose name states that it is untrusted.
    assert.equal(`${trace}`, '[object Object]', 'no string form leaks the caller value');
    assert.equal(String(trace), '[object Object]');
    assert.equal(JSON.stringify(trace), '{}', 'and it does not serialize into a payload');
    const asRecord = trace as unknown as Record<string, unknown>;
    for (const key of ['requestId', 'correlationId', 'id', 'value']) {
      assert.equal(asRecord[key], undefined, `nothing is exposed as ${key}`);
    }

    const empty = new UntrustedClientTrace(undefined, undefined);
    assert.equal(empty.present(), false);
    assert.deepEqual(empty.describe(), {
      client_request_id_untrusted: null,
      client_correlation_id_untrusted: null,
    });
  });

  test('concurrent contexts do not leak into each other across await points', async () => {
    const seen: Record<string, string[]> = { a: [], b: [] };
    const tick = () => new Promise((r) => setImmediate(r));

    const run = (name: string) =>
      runWithRequestContext(
        {
          requestId: `req-${name}-12345678`,
          correlationId: `cor-${name}-12345678`,
          startTime: Date.now(),
        },
        async () => {
          for (let i = 0; i < 5; i++) {
            await tick();
            seen[name]!.push(getRequestContext()!.requestId);
          }
        },
      );

    await Promise.all([run('a'), run('b')]);
    assert.deepEqual(seen.a, Array(5).fill('req-a-12345678'));
    assert.deepEqual(seen.b, Array(5).fill('req-b-12345678'));
  });

  test('binding the actor is a no-op outside a request and scoped inside one', () => {
    bindRequestActor({ tenantId: 't', userId: 'u', roles: ['service_advisor'] }); // no store: must not throw
    assert.equal(getRequestContext(), undefined);

    runWithRequestContext(
      {
        requestId: 'req-scoped-12345678',
        correlationId: 'req-scoped-12345678',
        startTime: Date.now(),
      },
      () => {
        bindRequestActor({ tenantId: 'tenant-1', userId: 'user-1', roles: ['service_advisor'] });
        assert.equal(getRequestContext()!.tenantId, 'tenant-1');
      },
    );
    assert.equal(getRequestContext(), undefined, 'context ends with its request');
  });
});

describe('problem details (internal model)', () => {
  test('application errors map with their stable code, status and details', () => {
    const pd = toProblemDetails(
      new ValidationError('concerns must be an array', { details: { field: 'concerns' } }),
      { instance: '/api/service/appointments' },
    );
    assert.equal(pd.status, 400);
    assert.equal(pd.code, 'validation_error');
    assert.equal(pd.type, 'urn:dealer:error:validation_error');
    assert.equal(pd.title, 'Bad Request');
    assert.equal(pd.detail, 'concerns must be an array');
    assert.equal(pd.instance, '/api/service/appointments');
    assert.deepEqual(pd.errors, { field: 'concerns' });

    const nf = toProblemDetails(
      new NotFoundError('Waitlist entry not found', { code: 'waitlist_not_found' }),
    );
    assert.equal(nf.status, 404);
    assert.equal(nf.code, 'waitlist_not_found');
  });

  test('unknown errors map to internal_error and leak nothing', () => {
    const sentinel = 'SENTINEL-CONNECTION-STRING-user:pass@host';
    const pd = toProblemDetails(new Error(`ECONNREFUSED ${sentinel}`));
    assert.equal(pd.status, 500);
    assert.equal(pd.code, 'internal_error');
    assert.ok(
      !JSON.stringify(pd).includes(sentinel),
      'client-facing fields must not carry internals',
    );
  });

  test('the request id rides on the model when inside a request', () => {
    runWithRequestContext(
      { requestId: 'req-pd-12345678', correlationId: 'req-pd-12345678', startTime: Date.now() },
      () => {
        const pd = toProblemDetails(new AppError(400, 'validation_error', 'nope'));
        assert.equal(pd.requestId, 'req-pd-12345678');
      },
    );
  });
});

describe('PII-safe structured logging', () => {
  function captureLogs(fn: () => void): string {
    const chunks: string[] = [];
    const origOut = process.stdout.write.bind(process.stdout);
    const origErr = process.stderr.write.bind(process.stderr);
    (process.stdout as unknown as { write: (c: string) => boolean }).write = (c: string) => {
      chunks.push(String(c));
      return true;
    };
    (process.stderr as unknown as { write: (c: string) => boolean }).write = (c: string) => {
      chunks.push(String(c));
      return true;
    };
    try {
      fn();
    } finally {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
    }
    return chunks.join('');
  }

  test('sentinel secrets and PII never appear in serialized output, however nested or cased', () => {
    const sentinels: Record<string, string> = {
      authorization: 'Bearer SENTINEL AUTH HEADER',
      step_up_token: 'SENTINEL STEP UP TOKEN',
      password: 'SENTINEL PASSWORD hunter2',
      api_key: 'SENTINEL API KEY VALUE with spaces',
      ssn: 'SENTINEL 123 45 6789',
      driver_license: 'SENTINEL DL 99887766',
      dob: 'SENTINEL 1990 01 31',
      email: 'SENTINEL person at example dot com',
      phone: 'SENTINEL 555 0100',
      street_address: 'SENTINEL 742 Evergreen Terrace',
      card_number: 'SENTINEL 4111 1111 1111 1111',
      cvv: 'SENTINEL 987',
      cookie: 'SENTINEL session cookie',
    };
    // Same fields in camelCase / other variants must redact identically (normalized
    // key matching): api_key == apiKey == apikey, database_url == databaseUrl, etc.
    const variants: Record<string, string> = {
      apiKey: 'SENTINEL CAMEL API KEY',
      clientSecret: 'SENTINEL CLIENT SECRET',
      databaseUrl: 'postgres://sentinel:SENTINEL-DB-URL-PW@host/db',
      connection_string: 'Server=x;Password=SENTINEL CONN PW;',
      accessToken: 'SENTINEL ACCESS TOKEN CAMEL',
      requestBody: 'SENTINEL RAW REQUEST BODY',
      'set-cookie': 'SENTINEL SET COOKIE VALUE',
    };

    const output = captureLogs(() => {
      logger.info({ customer: { profile: { contact: sentinels } } }, 'deeply nested');
      logger.error({ ...sentinels }, 'top level');
      logger.warn({ request: { headers: { ...variants } } }, 'variant keys');
    });

    for (const [key, value] of Object.entries({ ...sentinels, ...variants })) {
      assert.ok(!output.includes(value), `sentinel for "${key}" leaked into log output`);
    }
    assert.ok(output.includes('[REDACTED]'), 'redaction marker present');
  });

  test('request ids are attached to every line inside a request context', () => {
    const output = captureLogs(() => {
      runWithRequestContext(
        { requestId: 'req-log-12345678', correlationId: 'cor-log-12345678', startTime: Date.now() },
        () => logger.info({ step: 'inside' }, 'correlated line'),
      );
      logger.info({ step: 'outside' }, 'uncorrelated line');
    });
    const lines = output
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    assert.equal(lines[0].request_id, 'req-log-12345678');
    assert.equal(lines[0].correlation_id, 'cor-log-12345678');
    assert.equal(lines[1].request_id, undefined);
  });

  test('Error message, stack head, cause, and driver payloads never reach serialized logs', () => {
    const sentinel = 'SENTINEL-ERR-SECRET-abc123';

    // message + stack first line
    const err = new Error(`connect failed: ${sentinel}`);
    // cause chain
    const withCause = new Error('outer wrapper', { cause: new Error(`inner ${sentinel}`) });
    // database-driver-style error: enumerable payload properties
    const driverErr = Object.assign(new Error(`db says ${sentinel}`), {
      code: '28P01',
      detail: `password ${sentinel} rejected`,
      internalQuery: `SELECT secret FROM vault WHERE k = '${sentinel}'`,
      where: `at row containing ${sentinel}`,
    });

    const output = captureLogs(() => {
      logger.error({ err }, 'plain failure');
      logger.error({ err: withCause }, 'cause chain');
      logger.error({ err: driverErr }, 'driver payload');
    });

    assert.ok(!output.includes(sentinel), 'error-borne sentinel leaked into serialized logs');
    const lines = output
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    // Bounded safe fields are present and useful for triage.
    assert.equal(lines[0].err.name, 'Error');
    assert.match(lines[0].err.stack_fingerprint ?? '', /^[0-9a-f]{16}$/);
    assert.equal(lines[2].err.code, '28P01', 'a bounded SQLSTATE code survives');
    assert.equal(lines[2].err.detail, undefined, 'driver payload fields do not survive');
    assert.equal(lines[1].err.cause, undefined, 'cause chains do not survive');
    assert.equal(
      JSON.stringify(lines).includes('connect failed'),
      false,
      'messages do not survive',
    );
  });

  test('a sensitive object beyond the recursion depth cannot escape redaction', () => {
    const sentinel = 'SENTINEL DEEP OVERDEPTH PASSWORD';
    const rawMarker = 'SENTINEL DEEP RAW OBJECT VALUE';
    // Eight object levels: l1..l7 are benign keys; the payload sits below the
    // depth-6 traversal boundary, where the pre-R2 logger returned the ORIGINAL
    // object and JSON.stringify serialized it raw.
    const deep = {
      l1: { l2: { l3: { l4: { l5: { l6: { l7: { password: sentinel, note: rawMarker } } } } } } },
    };

    let output = '';
    assert.doesNotThrow(() => {
      output = captureLogs(() => logger.info({ payload: deep }, 'over-depth structure'));
    });
    assert.ok(!output.includes(sentinel), 'over-depth sensitive value escaped redaction');
    assert.ok(!output.includes(rawMarker), 'the original over-depth object was serialized raw');
    assert.ok(
      output.includes('[TRUNCATED]'),
      'the fixed truncation marker replaces over-depth content',
    );
  });

  test('identical failures share a stack fingerprint for incident grouping', () => {
    function boom(): Error {
      return new Error('SENTINEL-GROUPING-VALUE');
    }
    // Created from the SAME call site (one line, twice), so the stack frames — and
    // therefore the fingerprint — are identical; the messages never matter.
    const [a, b] = [0, 1].map(() => boom());
    const output = captureLogs(() => {
      logger.error({ err: a }, 'first');
      logger.error({ err: b }, 'second');
    });
    const lines = output
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    assert.equal(lines[0].err.stack_fingerprint, lines[1].err.stack_fingerprint);
    assert.ok(!output.includes('SENTINEL-GROUPING-VALUE'));
  });
});

describe('request-context middleware over HTTP', () => {
  // createApp() resolves config lazily; give the portable test a valid environment
  // (values are test-only and never asserted on).
  process.env.DATABASE_URL ??= 'postgres://user@localhost:5432/db';

  async function withServer(fn: (base: string) => Promise<void>): Promise<void> {
    const server = createApp().listen(0);
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      await fn(base);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  test('a caller-supplied x-request-id NEVER becomes the request id, well-formed or not', async () => {
    await withServer(async (base) => {
      // A PERFECTLY well-formed value: this is the case that used to be adopted, and it
      // is the whole defect. The response must come back under OUR id.
      const wellFormed = await fetch(`${base}/healthz`, {
        headers: { 'x-request-id': 'edge-gateway-0042' },
      });
      const echoed = wellFormed.headers.get('x-request-id') ?? '';
      assert.notEqual(echoed, 'edge-gateway-0042', 'the caller does not name the request');
      assert.match(echoed, /^[0-9a-f-]{36}$/, 'a generated id is echoed instead');

      // Note: a literal \n in a header value would be rejected by fetch itself, so the
      // malformed case here uses spaces - same branch, transportable value.
      const malformed = await fetch(`${base}/healthz`, {
        headers: { 'x-request-id': 'bad id with spaces' },
      });
      const second = malformed.headers.get('x-request-id') ?? '';
      assert.notEqual(second, 'bad id with spaces');
      assert.match(second, /^[0-9a-f-]{36}$/);

      // And a correlation header cannot name the correlation id either.
      const correlated = await fetch(`${base}/healthz`, {
        headers: { 'x-correlation-id': 'edge-gateway-c001' },
      });
      assert.notEqual(correlated.headers.get('x-request-id'), 'edge-gateway-c001');

      const absent = await fetch(`${base}/healthz`);
      assert.match(absent.headers.get('x-request-id') ?? '', /^[0-9a-f-]{36}$/);
    });
  });

  test('concurrent requests each get their own GENERATED id, and no two share one', async () => {
    await withServer(async (base) => {
      // Every request presents the SAME caller id. Before the correction all three
      // responses came back under it, so three requests were one in the audit trail.
      const responses = await Promise.all(
        [1, 2, 3].map(() =>
          fetch(`${base}/healthz`, { headers: { 'x-request-id': 'collide-req-0001' } }),
        ),
      );
      const echoed = responses.map((r) => r.headers.get('x-request-id') ?? '');
      for (const id of echoed) {
        assert.notEqual(id, 'collide-req-0001');
        assert.match(id, /^[0-9a-f-]{36}$/);
      }
      assert.equal(new Set(echoed).size, 3, 'three requests, three distinct server ids');
    });
  });
});
