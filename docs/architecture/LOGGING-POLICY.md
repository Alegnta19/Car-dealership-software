# Logging Field Policy

Owner: platform-architecture · Enforced by `packages/platform/src/logger.ts` redaction
and the sentinel tests in `tests/platform.test.ts`.

## Every request-related log line carries

- `request_id` and `correlation_id` (from the request context; ids echoed to callers),
- `tenant_id` / `user_id` once authenticated (opaque UUIDs — correlation, not PII),
- `level`, `time` (ISO-8601), `msg`,
- `module`/component and a stable event or error `code` where the caller provides one.

## Never logged, in any field, at any nesting depth

- Authorization headers, cookies, or session identifiers.
- Access/refresh/JWT/step-up tokens; passwords; secrets; API keys.
- Payment credentials (PAN, CVV, card fields).
- Government identifiers: SSN, driver-license numbers.
- Customer PII: email, phone, street address, date of birth.
- Raw request/response bodies; unbounded database error payloads (errors are logged as
  name/message/stack only).

## Error objects are never serialized raw (FBL-010-R1)

Arbitrary `Error` content is untrusted: messages embed connection strings, driver
payloads echo row values, and `cause` chains carry anything. The logger therefore never
emits `Error.message`, `Error.stack`, `Error.cause`, or any enumerable driver property.
An error serializes to bounded fields only: a validated class `name`, a stable
`code` when it matches a safe-token format (lower_snake app codes, ECONNREFUSED-style
system codes, SQLSTATEs), a plausible `status`, and a `stack_fingerprint` — a SHA-256
hash over the message-free stack frames for incident grouping. The original stack is
never emitted alongside the fingerprint.

## Request paths exclude query strings

`req.originalUrl` carries the query string, which can carry credentials or PII; API
logs record the query-free path only, with a stable `component` and `event` code.

## Key matching is normalized, recursive, and bounded

Redaction keys are matched after lowercasing and stripping `-`/`_`, so
`api_key` / `apiKey` / `apikey`, `database_url` / `databaseUrl`,
`connection_string` / `connectionString`, `set-cookie` / `setCookie` and every similar
variant are equivalent. Redaction recurses to depth 6. New sensitive key names are added
to `REDACTED_KEYS`; sentinel tests prove representative values never survive
serialization — including values embedded in error messages, stack heads, causes,
driver payloads, and HTTP query strings. Redaction is defense-in-depth, not permission:
do not put listed data into log calls in the first place.

Config values are safe to log only as booleans/numbers/enum names — never secret
strings; configuration validation errors name variables, not values.
