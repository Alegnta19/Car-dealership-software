/**
 * Delegated support access (FBL-020, ADR-008). Never impersonation: the
 * platform-support person stays the actor everywhere. Requests carry an
 * explicit action set, scope, bounded reason and duration; approval must
 * come from a DIFFERENT user (schema-enforced); sessions are structurally
 * capped at 60 minutes and revocable at any instant. The reason text lives
 * in the request row ONLY — it is never copied into ordinary logs.
 *
 * FBL-020-R3: the WRITES live in ./mutations.ts, with every other mutation that
 * can change what an actor may do — one true actor, one advancing
 * authorization_version, one audit row in the same transaction. This module
 * keeps the contracts and the non-suppressible READ.
 *
 * FBL-020-R4 §4: the read now returns the WHOLE approved grant rather than the
 * bare session row, and this module owns the ONE formatter every support
 * response header is built by. Both changes exist for the same reason: a support
 * indicator that names a session id and nothing else tells a tenant that
 * something is happening without telling them what, how far it reaches, or when
 * it stops.
 */
import { query } from '@dealer/database';
import type { SupportAccessFacts } from '@dealer/platform';

interface Row {
  [key: string]: unknown;
}

function ts(v: unknown): Date {
  return v instanceof Date ? v : new Date(String(v));
}

/**
 * FBL-020-R4 §4 — ONE LIVE DELEGATED GRANT, WITH EVERYTHING THAT BOUNDS IT.
 *
 * It is deliberately the SAME seven facts `SupportAccessFacts` carries through the
 * request context, the logs and the response header, so a tenant reading their own
 * support indicator and an operator reading the logs are looking at one set of
 * facts under one set of names.
 *
 * `reason` is absent, as everywhere: the text a platform person wrote about the
 * customer's situation stays in `support_access_requests.reason`, read by nothing.
 */
export interface LiveSupportGrant extends SupportAccessFacts {
  readonly grantedAt: Date;
}

/**
 * The columns and the JOIN every read below shares. Written once because the two
 * readers must agree on what "live" means — unrevoked, unexpired, and backed by a
 * request that is still `approved`. A grant whose approval was superseded (R3
 * section 5 converts those) authorizes nothing and must not be reported as live.
 */
const LIVE_GRANT_SELECT = `
    SELECT s.support_session_id, s.request_id, s.tenant_id, s.actor_user_link_id,
           s.granted_at, s.expires_at,
           r.requested_actions, r.scope_level, r.scope_id
      FROM support_access_sessions s
      JOIN support_access_requests r ON r.request_id = s.request_id
     WHERE s.revoked_at IS NULL
       AND s.expires_at > NOW()
       AND r.status = 'approved'`;

function mapLiveGrant(r: Row): LiveSupportGrant {
  return {
    supportSessionId: String(r.support_session_id),
    supportRequestId: String(r.request_id),
    supportActorUserLinkId: String(r.actor_user_link_id),
    targetTenantId: String(r.tenant_id),
    approvedScopeLevel: String(r.scope_level),
    approvedScopeId: r.scope_id === null || r.scope_id === undefined ? null : String(r.scope_id),
    approvedActions: ((r.requested_actions as string[] | null) ?? []).map((a) => String(a)),
    grantedAt: ts(r.granted_at),
    expiresAt: ts(r.expires_at),
  };
}

/**
 * The NON-SUPPRESSIBLE indicator source: every live grant against a tenant.
 * /auth/session, the response header and the logs all read this — a web
 * surface must render it and may not hide it.
 */
export async function listActiveSupportSessions(tenantId: string): Promise<LiveSupportGrant[]> {
  const result = await query(
    `${LIVE_GRANT_SELECT} AND s.tenant_id = $1 ORDER BY s.granted_at DESC`,
    [tenantId],
  );
  return (result.rows as Row[]).map(mapLiveGrant);
}

/**
 * FBL-020-R4 §4 — THE PLATFORM ACTOR'S OWN LIVE GRANTS, WHICH NOTHING REPORTED.
 *
 * `listActiveSupportSessions` is keyed by TENANT, and a platform actor has no
 * tenant: `describeAuthenticatedSession` passed `tenantId === null` and got an
 * empty list, so the one person who most needs to know which customer tenants
 * they are currently able to reach into — and until when — was told nothing at
 * all. That is not a disclosure question (these are their own grants) but a
 * safety one: a platform person who cannot see their live access cannot notice
 * that they still hold access they thought had ended, and cannot revoke it.
 *
 * Keyed by the ACTOR and therefore crossing tenants by design. One row per live
 * grant, so a person holding two concurrent windows sees both.
 */
export async function listActiveSupportGrantsForActor(
  actorUserLinkId: string,
): Promise<LiveSupportGrant[]> {
  const result = await query(
    `${LIVE_GRANT_SELECT} AND s.actor_user_link_id = $1 ORDER BY s.granted_at DESC`,
    [actorUserLinkId],
  );
  return (result.rows as Row[]).map(mapLiveGrant);
}

/** The response header every support-served response carries. */
export const SUPPORT_ACCESS_HEADER = 'x-support-access';

/**
 * FBL-020-R4 §4 — THE ONLY PLACE A SUPPORT HEADER VALUE IS BUILT.
 *
 * R3 had two call sites formatting this header by hand, and BOTH emitted
 * `active; support_session=<id>` — the session id and nothing else. A tenant
 * receiving it learned that delegated access was in force and could not learn
 * when it ends, which is the one fact that tells them whether to wait or to
 * revoke. Worse, two hand-written formats can drift apart, and the header is a
 * contract a customer's own tooling may parse.
 *
 * The input type is the whole fact set, so a caller CANNOT build a value without
 * an expiry: omitting it is not a discipline anybody has to remember, it is a
 * compile error. Every entry carries the session, the approving request and the
 * expiry.
 *
 * Returns null when there is nothing to declare, so a caller sets no header at
 * all rather than an empty or `none` value that a parser would have to interpret.
 */
export function supportAccessHeaderValue(
  grants: readonly Pick<
    SupportAccessFacts,
    'supportSessionId' | 'supportRequestId' | 'expiresAt'
  >[],
): string | null {
  if (grants.length === 0) return null;
  return grants
    .map(
      (g) =>
        `active; support_session=${g.supportSessionId}; support_request=${g.supportRequestId}; ` +
        `expires_at=${g.expiresAt.toISOString()}`,
    )
    .join(', ');
}
