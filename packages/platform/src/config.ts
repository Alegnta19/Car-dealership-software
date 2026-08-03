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

/**
 * Identity provider configuration (FBL-020). Two shapes only:
 *   - disabled: no provider configured. The /auth surface refuses to serve and
 *     nothing else changes — CI and local development need NO WorkOS credential.
 *   - workos: every field is required and validated at startup, so a
 *     misconfigured production process dies before accepting a single login.
 * URLs must be HTTPS in production; plain http is tolerated outside production
 * so the deterministic local issuer harness can stand in for the provider.
 */
export interface WorkosIdentitySettings {
  readonly clientId: string;
  readonly apiKey: string;
  readonly issuer: string;
  readonly jwksUri: string;
  readonly redirectUri: string;
  readonly reauthRedirectUri: string;
  readonly logoutRedirectUri: string;
  readonly cookiePassword: string;
  readonly oidcAudience: string;
  readonly oidcClockSkewSeconds: number;
}

export type IdentityConfig =
  | { readonly provider: 'disabled' }
  | { readonly provider: 'workos'; readonly workos: WorkosIdentitySettings };

export interface AppConfig {
  readonly databaseUrl: string;
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
  readonly identity: IdentityConfig;
  /**
   * True when NODE_ENV=production. The one place the environment's
   * deployment posture is read; consumers (e.g. cookie `Secure`) ask the
   * configuration, never process.env.
   */
  readonly isProduction: boolean;
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

function url(
  env: Record<string, string | undefined>,
  name: string,
  { httpsRequired }: { httpsRequired: boolean },
): string {
  const raw = requireVar(env, name);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    // The variable is named; its value is not echoed back.
    throw new ConfigError(`${name} must be an absolute URL`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new ConfigError(`${name} must use http or https`);
  }
  if (httpsRequired && parsed.protocol !== 'https:') {
    throw new ConfigError(`${name} must use https in production`);
  }
  return raw;
}

function loadIdentityConfig(env: Record<string, string | undefined>): IdentityConfig {
  // '' is treated as absent, exactly as every other variable in this file
  // treats it — docker compose's `${VAR:-}` always SETS the variable, so a
  // nullish-only check would crash-loop the documented quick start.
  const provider =
    env.IDENTITY_PROVIDER === undefined || env.IDENTITY_PROVIDER === ''
      ? 'disabled'
      : env.IDENTITY_PROVIDER;
  if (provider === 'disabled') return Object.freeze({ provider: 'disabled' as const });
  if (provider !== 'workos') {
    throw new ConfigError(`IDENTITY_PROVIDER must be "workos" or "disabled"`);
  }
  const httpsRequired = env.NODE_ENV === 'production';
  return Object.freeze({
    provider: 'workos' as const,
    workos: Object.freeze({
      clientId: requireVar(env, 'WORKOS_CLIENT_ID'),
      apiKey: secret(env, 'WORKOS_API_KEY'),
      issuer: url(env, 'WORKOS_ISSUER', { httpsRequired }),
      jwksUri: url(env, 'WORKOS_JWKS_URI', { httpsRequired }),
      redirectUri: url(env, 'WORKOS_REDIRECT_URI', { httpsRequired }),
      reauthRedirectUri: url(env, 'WORKOS_REAUTH_REDIRECT_URI', { httpsRequired }),
      logoutRedirectUri: url(env, 'WORKOS_LOGOUT_REDIRECT_URI', { httpsRequired }),
      cookiePassword: secret(env, 'WORKOS_COOKIE_PASSWORD'),
      oidcAudience: requireVar(env, 'OIDC_AUDIENCE'),
      oidcClockSkewSeconds: integer(env, 'OIDC_CLOCK_SKEW_SECONDS', 60, { min: 0, max: 300 }),
    }),
  });
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
    identity: loadIdentityConfig(env),
    isProduction: env.NODE_ENV === 'production',
  };
  return Object.freeze(config);
}

/**
 * The database slice of the configuration — everything @dealer/database needs and
 * nothing more. The migration runner and the compose one-shot migrate service run with
 * ONLY these variables; requiring the full application config there (JWT/step-up
 * secrets) would make a schema migration depend on credentials it never uses.
 */
export interface DatabaseConfig {
  readonly databaseUrl: string;
  readonly pgPoolMax: number;
  readonly pgPoolIdleMs: number;
  readonly pgPoolConnectMs: number;
  readonly pgSslRequire: boolean;
}

export function loadDatabaseConfig(env: Record<string, string | undefined>): DatabaseConfig {
  return Object.freeze({
    databaseUrl: requireVar(env, 'DATABASE_URL'),
    pgPoolMax: integer(env, 'PGPOOL_MAX', 10, { min: 1, max: 100 }),
    pgPoolIdleMs: integer(env, 'PGPOOL_IDLE_MS', 30_000, { min: 0, max: 600_000 }),
    pgPoolConnectMs: integer(env, 'PGPOOL_CONNECT_MS', 5_000, { min: 100, max: 60_000 }),
    pgSslRequire: env.PGSSL === 'require',
  });
}

let current: AppConfig | undefined;
let currentDatabase: DatabaseConfig | undefined;

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
 * The database configuration: the full application config when one is initialized
 * (single runtime source of truth), otherwise a lazy database-only load — so the
 * migration runner works with nothing but DATABASE_URL.
 */
export function getDatabaseConfig(): DatabaseConfig {
  if (current !== undefined) return current;
  if (currentDatabase === undefined) {
    currentDatabase = loadDatabaseConfig(process.env);
  }
  return currentDatabase;
}

/**
 * Test-only: clears the cached configuration so a test can exercise loading with a
 * different environment. Production code has no reason to call this.
 */
export function resetConfigForTests(): void {
  current = undefined;
  currentDatabase = undefined;
}
