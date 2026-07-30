# ADR-003 — API and Event Compatibility Policy

Status: Accepted (FBL-010) · Owner: architect · Date: 2026-07-30

## Context

The 44-endpoint /api/service surface has paying-quality behavior and characterized
envelopes. Public contract work (OpenAPI v1, idempotency, Problem Details on the wire,
event contracts, outbox) is FBL-040's; FBL-010 must keep today's clients whole while
giving errors a typed internal spine.

## Decision

The mounted HTTP surface is contract-characterized: method, path, authentication and
role gates live in a checked-in snapshot (tests/fixtures/http-contract-snapshot.json)
that fails CI on any drift until deliberately regenerated and reviewed. The public
envelopes — `{ success: true, data }` and `{ success: false, error: { code, message,
details? } }` — and every stable error code are frozen for existing endpoints. RFC 9457
Problem Details is the CANONICAL INTERNAL error model (@dealer/contracts +
@dealer/platform mapper); the API renderer derives status/code from it and emits the
compatibility envelope. No content-type switch, no new API version, no event contracts
in this order. Breaking public changes require a versioned surface (FBL-040+) — never an
in-place mutation.

## Consequences

Clients see zero change. Error semantics gain one typed source of truth. Route drift is
a failing test, not a survey finding.

## Rejected alternatives

Switching to application/problem+json now (breaks characterized clients); OpenAPI now
(would freeze a surface FBL-060 is expected to reshape behind a version).

## Migration effect

None on the wire.

## Rollback implications

Revert restores the previous renderer; envelopes are identical either way.
