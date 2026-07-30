import { getConfig, LogLevel } from './config';
import { getRequestContext } from './request-context';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Keys whose values are redacted before a log line is written. Service code passes
 * error objects and request-shaped payloads straight through, so anything that could
 * carry a credential or personal data is masked here rather than at every call site.
 *
 * The full field policy — what every request log must carry and what may never be
 * logged — is documented in docs/architecture/LOGGING-POLICY.md and enforced by the
 * sentinel tests in tests/logging.test.ts.
 */
const REDACTED_KEYS = new Set([
  // credentials and tokens
  'password', 'token', 'step_up_token', 'authorization', 'secret',
  'api_key', 'apikey', 'access_token', 'refresh_token', 'jwt',
  'cookie', 'cookies', 'set-cookie', 'set_cookie',
  // payment data
  'card', 'card_number', 'pan', 'cvv', 'cvc', 'payment_credential',
  // government identifiers
  'ssn', 'social_security_number', 'driver_license', 'drivers_license', 'license_number',
  // customer PII
  'email', 'email_address', 'phone', 'phone_number', 'street', 'street_address', 'address',
  'dob', 'date_of_birth', 'birth_date',
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

function minLevel(): LogLevel {
  try {
    return getConfig().logLevel;
  } catch {
    // Config invalid or unavailable (e.g. during startup failure reporting): log
    // everything rather than lose the failure.
    return 'debug';
  }
}

function emit(level: LogLevel, a?: unknown, b?: string): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel()]) return;

  const hasContext = typeof a === 'object' && a !== null;
  const context = hasContext ? (redact(a) as Record<string, unknown>) : {};
  const msg = hasContext ? b : (a as string | undefined);

  // Request correlation rides on every line automatically; ids only, never bodies.
  const rc = getRequestContext();
  const correlation = rc
    ? {
        request_id: rc.requestId,
        correlation_id: rc.correlationId,
        ...(rc.tenantId !== undefined ? { tenant_id: rc.tenantId } : {}),
        ...(rc.userId !== undefined ? { user_id: rc.userId } : {}),
      }
    : {};

  const line = JSON.stringify({
    level,
    time: new Date().toISOString(),
    msg,
    ...correlation,
    ...context,
  });
  if (level === 'error') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

export const logger = {
  debug: (a?: unknown, b?: string) => emit('debug', a, b),
  info: (a?: unknown, b?: string) => emit('info', a, b),
  warn: (a?: unknown, b?: string) => emit('warn', a, b),
  error: (a?: unknown, b?: string) => emit('error', a, b),
};
