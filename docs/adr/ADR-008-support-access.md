# ADR-008 — Delegated Support Access, No Silent Impersonation

Status: Accepted (FBL-020) · Owner: architect · Date: 2026-07-31

## Context

Platform staff sometimes need to enter a dealership tenant to help. Impersonation —
acting as a dealership user — destroys evidence (the wrong actor appears everywhere)
and invites silent scope creep. WorkOS offers impersonation; it is deliberately not
used.

## Decision

Support access is delegated, bounded, and visible. A platform-support identity files an
explicit request (tenant, role/action set, scope, expiry, non-empty bounded reason); a
DIFFERENT authorized administrator — normally an active tenant administrator of the
target tenant — approves; duration is capped at 60 minutes; no automatic renewal;
revocation ends access immediately. The true support actor remains the actor in request
context, structured logs, PolicyDecision evidence, audit events, /auth/session, and a
response header exposing active support access and expiry (the executable indicator
until a web surface exists — future UIs must render it and may not hide it). A platform
role alone grants no dealership data; support access grants only the approved
action/scope set. Reason text lives in the support record only, never in ordinary logs.

## Consequences

Every support action is attributable to the real person, bounded in time and scope,
and visible to the tenant. Emergencies without an available approver stall — an
accepted cost; no silent break-glass exists by design.

## Rejected alternatives

WorkOS impersonation (actor substitution); standing platform access to tenant data
(the origin platform's defect class); self-approval (requester/approver separation is
the control).

## Migration effect

055 adds support_access_requests/sessions; no runtime behavior until used.

## Rollback implications

Additive; rollback ignores the tables.
