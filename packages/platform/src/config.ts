/**
 * @dealer/platform — the single typed configuration boundary (FBL-010 section F).
 *
 * Composition roots call `initConfig(loadConfig(process.env))` before accepting
 * traffic, so invalid configuration fails the process at startup. Everything else
 * calls `getConfig()` — business and domain code never reads `process.env`
 * (the architecture checker enforces that this file is one of the few allowed
 * `process.env` readers).
 *
 * Validation errors name the VARIABLE, never its value: a secret must not appear in a
 * thrown message or a log line even when it is invalid.
 *
 * `getConfig()` falls back to loading from `process.env` lazily when no explicit init
 * happened. That keeps unit tests and scripts working without ceremony while the env
 * read itself stays inside this approved file; production processes always init
 * explicitly at the composition root.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface AppConfig {
  readonly databaseUrl: string;
  readonly jwtSecret: string;
  readonly stepUpSecret: string;
  readonly port: number;
  readonly shutdownGraceMs: number;
  readonly metricsIntervalMs: number;
  readonly metricsWindowDays: number;
  readonly jsonBodyLimit: string;
  readonly logLevel: LogLevel;
  readonly serviceDefaultTimezone: string;
  readonly pgPoolMax: number;
  readonly pgPoolIdleMs: number;
  readonly pgPoolConnectMs: number;
  readonly pgSslRequire: boolean;
}

const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];
const MIN_SECRET_LENGTH = 32;

class ConfigError extends Error {}

function requireVar(env: Record<string, string | undefined>, name: string): string {
  const value = env[name];
  if (value === undefined || value === '') {
    throw new ConfigError(`${name} is required`);
  }
  return value;
}

function secret(env: Record<string, string | undefined>, name: string): string {
  const value = requireVar(env, name);
  if (value.length < MIN_SECRET_LENGTH) {
    // The length is stated; the value never is.
    throw new ConfigError(`${name} must be at least ${MIN_SECRET_LENGTH} characters`);
  }
  return value;
}

function integer(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
  { min, max }: { min: number; max: number },
): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  const logLevelRaw = env.LOG_LEVEL ?? 'info';
  if (!LOG_LEVELS.includes(logLevelRaw as LogLevel)) {
    throw new ConfigError(`LOG_LEVEL must be one of: ${LOG_LEVELS.join(', ')}`);
  }

  const jsonBodyLimit = env.JSON_BODY_LIMIT ?? '1mb';
  if (!/^[0-9]{1,6}(b|kb|mb)$/i.test(jsonBodyLimit)) {
    throw new ConfigError('JSON_BODY_LIMIT must look like a size, e.g. 100kb or 1mb');
  }

  const config: AppConfig = {
    databaseUrl: requireVar(env, 'DATABASE_URL'),
    jwtSecret: secret(env, 'JWT_SECRET'),
    stepUpSecret: secret(env, 'STEP_UP_SECRET'),
    port: integer(env, 'PORT', 3000, { min: 1, max: 65535 }),
    shutdownGraceMs: integer(env, 'SHUTDOWN_GRACE_MS', 30_000, { min: 1_000, max: 600_000 }),
    metricsIntervalMs: integer(env, 'METRICS_INTERVAL_MS', 60_000, { min: 1_000, max: 3_600_000 }),
    metricsWindowDays: integer(env, 'METRICS_WINDOW_DAYS', 30, { min: 1, max: 365 }),
    jsonBodyLimit,
    logLevel: logLevelRaw as LogLevel,
    serviceDefaultTimezone: env.SERVICE_DEFAULT_TIMEZONE ?? 'UTC',
    pgPoolMax: integer(env, 'PGPOOL_MAX', 10, { min: 1, max: 100 }),
    pgPoolIdleMs: integer(env, 'PGPOOL_IDLE_MS', 30_000, { min: 0, max: 600_000 }),
    pgPoolConnectMs: integer(env, 'PGPOOL_CONNECT_MS', 5_000, { min: 100, max: 60_000 }),
    pgSslRequire: env.PGSSL === 'require',
  };
  return Object.freeze(config);
}

let current: AppConfig | undefined;

/** Composition roots call this exactly once, before accepting traffic. */
export function initConfig(config: AppConfig): void {
  current = config;
}

export function getConfig(): AppConfig {
  if (current === undefined) {
    current = loadConfig(process.env);
  }
  return current;
}

/**
 * Test-only: clears the cached configuration so a test can exercise loading with a
 * different environment. Production code has no reason to call this.
 */
export function resetConfigForTests(): void {
  current = undefined;
}
