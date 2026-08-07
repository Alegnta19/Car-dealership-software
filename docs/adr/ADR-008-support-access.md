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

---

## R3 amendment (FBL-020-R3) — authority, not just separation

R2 enforced "a DIFFERENT user approves". That is a separation-of-duty control,
not an authority control: any second identity satisfied it. R3 states who may
act, and checks it first.

**Filing** requires a CURRENT active platform-scope `platform_support` (or
`platform_admin`) actor whose user link is activated and effective. A
deactivated or unbound identity cannot file, and neither can a dealership actor.

**Deciding** — approving _or denying_ — requires a current, effective
`tenant_admin` **of the target tenant**, checked BEFORE any grant is considered
and required for a denial too, so an outsider cannot dispose of a tenant's
pending request either. Requester ≠ approver still holds, and is still a table
CHECK.

**Approving** additionally requires the approver's OWN reauthentication grant,
consumed, minted at `fresh_and_mfa_policy` against a connection that certified
the organization's MFA policy at issue time. The approved request records that
grant (`approval_grant_id`). Separation of duty alone no longer approves.

**Revoking** requires a tenant administrator of that session's tenant, or the
support actor ending their own session early. Revocation is attributable and
denies on the next policy decision.

**Requester authority is CURRENT, not remembered (R3 correction F1).** The
requester's platform-support binding is re-judged at every step that extends
their reach — filing, approval, and session start — and the policy engine
re-judges it on **every decision** made through a live session, denying
`SUPPORT_ACTOR_UNAUTHORIZED`. Before this, the engine's support branch consulted
the session and the approved request and no role binding at all, so revoking a
platform actor's binding neither blocked an approval that was still pending nor
ended a session already live: access ran until expiry, or until somebody
remembered to call `revokeSupportSession`. Revoking the binding is now sufficient
offboarding on its own. An approval refused for this reason does **not** spend the
approver's single-use grant and leaves the request `pending`; a **denial** is
deliberately not gated this way, because disposing of a stale request extends
nobody's reach.

**The approval assurance bar is code, not data (R3 correction F2).**
`fresh_and_mfa_policy` is demanded for every approval, stated once in
`decideSupportAccess`. R3 deleted a `support_access_requests.approver_assurance`
column that no reader consulted; honouring it instead would have created a
per-request downgrade of exactly the gate this ADR exists to keep strict. The
`superseded_decided_by_user_link_id` / `superseded_decided_at` /
`superseded_reason` columns stay, and are HISTORY rather than authority: nothing
reads them to decide anything.

**Impersonation is refused, not merely declined.** This ADR rejected WorkOS
impersonation as a design choice; R3 stops depending on the dashboard to honour
it. An authentication that says it is being wielded on behalf of one of our
users is refused on every credential path — bearer, login callback,
reauthentication callback — and a refresh that returns one revokes the local
session immediately. Three carriers are recognised: the RFC 8693 `act` claim, a
provider `impersonator` object, and `authentication_method = 'Impersonation'`.
The impersonator's email is classified and then dropped, so it never reaches a
log, a response or the database.

**Visibility survived the bounded session response.** `GET /auth/session` was
reduced to eight identity facts, and the live support state with its expiry is
one of them — alongside the non-suppressible `x-support-access` response header
on every response served under support access. A future UI must render it and
may not hide it.

**Historical support evidence is preserved.** Migration 057 required an approval
to name its backing grant. Live approvals that could not were ended and their
decisions copied into `superseded_*` columns with an audit row — no approval was
invented, and no record was erased.
