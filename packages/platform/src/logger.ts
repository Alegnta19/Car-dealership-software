import { createHash } from 'crypto';
import { getConfig, LogLevel } from './config';
import { getRequestContext } from './request-context';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Keys whose values are redacted before a log line is written (FBL-010-R1 section C).
 * Keys are NORMALIZED before matching — lowercased with `-` and `_` stripped — so
 * api_key / apiKey / apikey, database_url / databaseUrl, set-cookie / setCookie and
 * every similar variant are equivalent. Entries below are the normalized tokens.
 *
 * The full field policy — what every request log must carry and what may never be
 * logged — is documented in docs/architecture/LOGGING-POLICY.md and enforced by the
 * sentinel tests in tests/platform.test.ts.
 */
const REDACTED_KEYS = new Set([
  // credentials, tokens, secrets, keys
  'password',
  'token',
  'stepuptoken',
  'authorization',
  'secret',
  'clientsecret',
  'apikey',
  'accesstoken',
  'refreshtoken',
  'jwt',
  'privatekey',
  'cookie',
  'cookies',
  'setcookie',
  // database and connection material
  'databaseurl',
  'connectionstring',
  'connectionuri',
  'dsn',
  // payment data
  'card',
  'cardnumber',
  'pan',
  'cvv',
  'cvc',
  'paymentcredential',
  // government identifiers
  'ssn',
  'socialsecuritynumber',
  'driverlicense',
  'driverslicense',
  'licensenumber',
  // customer PII
  'email',
  'emailaddress',
  'phone',
  'phonenumber',
  'street',
  'streetaddress',
  'address',
  'dob',
  'dateofbirth',
  'birthdate',
  // raw payloads
  'requestbody',
  'responsebody',
  'rawbody',
]);

function normalizeKey(key: string): string {
  return key.toLowerCase().split('-').join('').split('_').join('');
}

const SAFE_ERROR_CODE = /^[A-Za-z0-9_.-]{1,64}$/;
const SAFE_ERROR_NAME = /^[A-Za-z0-9_$]{1,64}$/;

/**
 * Incident-grouping fingerprint: SHA-256 over the stack FRAMES only — the
 * message-bearing first line is dropped, frames are trimmed and capped. Only the hash
 * is ever emitted, never the frames themselves.
 */
function stackFingerprint(stack: string | undefined): string | undefined {
  if (typeof stack !== 'string' || stack === '') return undefined;
  const frames = stack
    .split('\n')
    .slice(1, 11)
    .map((line) => line.trim().slice(0, 300))
    .join('\n');
  if (frames === '') return undefined;
  return createHash('sha256').update(frames).digest('hex').slice(0, 16);
}

/**
 * Safe error serialization (FBL-010-R1 section A). Arbitrary Error content is
 * untrusted: messages routinely embed connection strings, driver payloads echo row
 * values, and `cause` chains carry anything. Nothing free-form survives — only
 * bounded, validated fields:
 *   - `name`: the error class, when it matches a bounded identifier format;
 *   - `code`: a stable application/system code, when it matches a safe-token format
 *     (lower_snake app codes, ECONNREFUSED-style system codes, SQLSTATEs);
 *   - `status`: a plausible HTTP/application status number;
 *   - `stack_fingerprint`: a hash of the message-free stack frames for grouping.
 * Never emitted: message, stack, cause, or any enumerable driver property.
 */
function safeError(err: Error): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: SAFE_ERROR_NAME.test(err.name) ? err.name : 'Error',
  };
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' && SAFE_ERROR_CODE.test(code)) out.code = code;
  else if (typeof code === 'number' && Number.isInteger(code)) out.code = code;
  const status = (err as { statusCode?: unknown }).statusCode;
  if (typeof status === 'number' && status >= 100 && status <= 599) out.status = status;
  const fingerprint = stackFingerprint(err.stack);
  if (fingerprint !== undefined) out.stack_fingerprint = fingerprint;
  return out;
}

function redact(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (value instanceof Error) {
    return safeError(value);
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = REDACTED_KEYS.has(normalizeKey(k)) ? '[REDACTED]' : redact(v, depth + 1);
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
