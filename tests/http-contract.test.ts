import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { authRouter, serviceCockpitRouter } from '@dealer/api';
import { createApp } from '@dealer/api';
import { errorHandler, notFoundHandler } from '@dealer/api';
import { ValidationError } from '@dealer/platform';

/**
 * HTTP behavior characterization (FBL-010 order, section A).
 *
 * The mounted route surface is executable inventory, not documentation: this suite walks
 * the real Express router and compares method, path, authentication requirement, and
 * authorized roles against the checked-in snapshot. A route added, removed, re-pathed,
 * or re-gated fails here until the snapshot is deliberately regenerated
 * (UPDATE_HTTP_CONTRACT=1) and the diff reviewed. Portable — no database required.
 */

// createApp() resolves configuration lazily; a portable test presents a complete
// dummy environment (never asserted on). Identity stays DISABLED — walking the
// router requires no provider configuration at all.
process.env.DATABASE_URL ??= 'postgres://user@localhost:5432/db';

const SNAPSHOT_PATH = join(__dirname, 'fixtures', 'http-contract-snapshot.json');

interface RouteEntry {
  method: string;
  path: string;
  authenticated: boolean;
  /** FBL-020: routes declare ONE catalog action; the policy engine owns roles. */
  action: string | null;
}

/** The slice of Express router internals this characterization reads. */
interface RouteHandle {
  name?: string;
  requiredAction?: unknown;
}
interface RouteStackLayer {
  handle?: RouteHandle;
}
interface RouterLayer {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: RouteStackLayer[];
  };
}
interface WalkableRouter {
  stack: RouterLayer[];
}

function walkRouter(router: WalkableRouter): RouteEntry[] {
  const entries: RouteEntry[] = [];
  for (const layer of router.stack) {
    if (!layer.route) continue; // app-level middleware, not a mounted route
    const { path, methods, stack } = layer.route;
    const authenticated = stack.some((l) => l.handle?.name === 'authenticate');
    const actions = stack.flatMap((l) =>
      typeof l.handle?.requiredAction === 'string' ? [l.handle.requiredAction] : [],
    );
    for (const method of Object.keys(methods).filter((m) => m !== '_all')) {
      entries.push({
        method: method.toUpperCase(),
        path,
        authenticated,
        action: actions[0] ?? null,
      });
    }
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

describe('HTTP contract characterization', () => {
  const serviceRoutes = walkRouter(serviceCockpitRouter as unknown as WalkableRouter);
  const authSurface = walkRouter(authRouter as unknown as WalkableRouter);

  test('the mounted /api/service surface is exactly 44 endpoints', () => {
    assert.equal(
      serviceRoutes.length,
      44,
      `expected 44 mounted service endpoints, found ${serviceRoutes.length} — a change in the ` +
        'route surface must be deliberate and reviewed, not incidental',
    );
  });

  test('every /api/service endpoint requires authentication and declares its action gate', () => {
    for (const r of serviceRoutes) {
      assert.ok(r.authenticated, `${r.method} ${r.path} is mounted without authenticate`);
      assert.ok(
        typeof r.action === 'string' && r.action.length > 0,
        `${r.method} ${r.path} has no requireAction(...) gate`,
      );
    }
  });

  test('the /auth surface is exactly the six FBL-020 routes', () => {
    const listed = authSurface.map((r) => `${r.method} ${r.path}`).sort();
    assert.deepEqual(listed, [
      'GET /callback',
      'GET /login',
      'GET /reauth/callback',
      'GET /session',
      'POST /logout',
      'POST /reauth/start',
    ]);
    // browser-redirect legs authenticate via sealed transaction cookies, not middleware
    for (const r of authSurface) {
      const needsMiddlewareAuth = ['GET /session', 'POST /logout', 'POST /reauth/start'];
      assert.equal(
        r.authenticated,
        needsMiddlewareAuth.includes(`${r.method} ${r.path}`),
        `${r.method} ${r.path} authentication posture drifted`,
      );
    }
  });

  test('method, path, auth and action match the checked-in contract snapshot', () => {
    const current = JSON.stringify({ service: serviceRoutes, auth: authSurface }, null, 2) + '\n';
    if (process.env.UPDATE_HTTP_CONTRACT === '1') {
      writeFileSync(SNAPSHOT_PATH, current);
    }
    let recorded: string;
    try {
      recorded = readFileSync(SNAPSHOT_PATH, 'utf8');
    } catch {
      assert.fail(
        'http-contract-snapshot.json is missing — run with UPDATE_HTTP_CONTRACT=1 and review the result',
      );
      return;
    }
    assert.equal(
      current,
      recorded,
      'the mounted HTTP surface differs from the recorded contract snapshot — if the change is ' +
        'deliberate, regenerate with UPDATE_HTTP_CONTRACT=1 and review the diff',
    );
  });

  test('the app exposes /healthz and /metrics without authentication, and nothing else at the top level', () => {
    const app = createApp() as unknown as { _router?: WalkableRouter; router?: WalkableRouter };
    const appRoutes = walkRouter((app._router ?? app.router)!);
    const paths = appRoutes.map((r) => `${r.method} ${r.path}`).sort();
    assert.deepEqual(paths, ['GET /healthz', 'GET /metrics']);
    for (const r of appRoutes) {
      assert.equal(
        r.authenticated,
        false,
        `${r.path} must stay unauthenticated (gate at the ingress)`,
      );
    }
  });

  // ── Error envelope characterization, at the handler level ──

  interface RenderedEnvelope {
    success: boolean;
    error: { code: string; message: string; details?: unknown };
  }

  function renderThrough(handler: 'error' | 'notFound', err?: unknown, url?: string) {
    let statusCode = 0;
    let body: RenderedEnvelope | null = null;
    const res = {
      status(code: number) {
        statusCode = code;
        return this;
      },
      json(payload: unknown) {
        body = payload as RenderedEnvelope;
        return this;
      },
    };
    const req = {
      method: 'GET',
      path: '/api/service/whatever',
      originalUrl: url ?? '/api/service/whatever',
      headers: {},
    };
    type ErrorHandlerFn = (e: unknown, rq: unknown, rs: unknown, nx: () => void) => void;
    type NotFoundFn = (rq: unknown, rs: unknown) => void;
    if (handler === 'error')
      (errorHandler as unknown as ErrorHandlerFn)(err, req, res, () => undefined);
    else (notFoundHandler as unknown as NotFoundFn)(req, res);
    return { statusCode, body: body! };
  }

  function captureStreams(fn: () => void): string {
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

  test('an unexpected error leaks nothing from the error — in the response OR the logs', () => {
    const sentinel = 'SENTINEL-DB-PASSWORD-hunter2';
    let rendered: { statusCode: number; body: RenderedEnvelope } | undefined;
    const logged = captureStreams(() => {
      rendered = renderThrough('error', new Error(`connect failed: ${sentinel}`));
    });
    assert.equal(rendered!.statusCode, 500);
    assert.equal(rendered!.body.success, false);
    assert.equal(rendered!.body.error.code, 'internal_error');
    assert.ok(
      !JSON.stringify(rendered!.body).includes(sentinel),
      'internal error details must never reach the response body',
    );
    assert.ok(
      !logged.includes(sentinel),
      'internal error details must never reach serialized logs either',
    );
  });

  test('logged request paths never include the query string', () => {
    const sentinel = 'SENTINEL-QS-TOKEN-xyz789';
    const logged = captureStreams(() => {
      renderThrough(
        'error',
        new ValidationError('nope'),
        `/api/service/appointments?token=${sentinel}`,
      );
    });
    assert.ok(logged.includes('/api/service/appointments'), 'the query-free path is logged');
    assert.ok(!logged.includes(sentinel), 'query-string content must never reach logs');
  });

  test('typed application errors render the stable public envelope', () => {
    const { statusCode, body } = renderThrough(
      'error',
      new ValidationError('concerns must be an array', { details: { field: 'concerns' } }),
    );
    assert.equal(statusCode, 400);
    assert.equal(body.success, false);
    assert.equal(body.error.code, 'validation_error');
    assert.equal(body.error.message, 'concerns must be an array');
  });

  test('unknown routes render the stable 404 envelope', () => {
    const { statusCode, body } = renderThrough('notFound');
    assert.equal(statusCode, 404);
    assert.equal(body.success, false);
    assert.equal(body.error.code, 'route_not_found');
  });
});
