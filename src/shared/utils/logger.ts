type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN_LEVEL: Level = (process.env.LOG_LEVEL as Level) || 'info';

/**
 * Keys whose values are redacted before a log line is written. Service code passes
 * error objects and request-shaped payloads straight through, so anything that could
 * carry a credential is masked here rather than at every call site.
 */
const REDACTED_KEYS = new Set([
  'password', 'token', 'step_up_token', 'authorization', 'secret',
  'api_key', 'apikey', 'access_token', 'refresh_token', 'jwt',
]);

function redact(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = REDACTED_KEYS.has(k.toLowerCase()) ? '[REDACTED]' : redact(v, depth + 1);
  }
  return out;
}

function emit(level: Level, a?: unknown, b?: string): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[MIN_LEVEL]) return;

  const hasContext = typeof a === 'object' && a !== null;
  const context = hasContext ? (redact(a) as Record<string, unknown>) : {};
  const msg = hasContext ? b : (a as string | undefined);

  const line = JSON.stringify({ level, time: new Date().toISOString(), msg, ...context });
  if (level === 'error') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

export const logger = {
  debug: (a?: unknown, b?: string) => emit('debug', a, b),
  info: (a?: unknown, b?: string) => emit('info', a, b),
  warn: (a?: unknown, b?: string) => emit('warn', a, b),
  error: (a?: unknown, b?: string) => emit('error', a, b),
};
