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

The logger redacts by key (see `REDACTED_KEYS`) recursively to depth 6; new sensitive
key names are added to that set, and a sentinel test proves representative values never
survive serialization. Redaction is defense-in-depth, not permission: do not put listed
data into log calls in the first place.

Config values are safe to log only as booleans/numbers/enum names — never secret
strings; configuration validation errors name variables, not values.
