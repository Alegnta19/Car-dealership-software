/**
 * FBL-020-R4 §1 — LOGIN ADMISSION: everything that must hold before a local
 * session exists or a provider credential is taken into custody.
 *
 * ── what R3 got wrong ──────────────────────────────────────────────────────
 *
 * R3's /auth/callback checked a real but INCOMPLETE set of facts, in the route,
 * one call at a time:
 *
 *   * `resolveActiveConnection` proved the connection was active and effective —
 *     and nothing proved its issuer was the CONFIGURED trusted issuer. The
 *     bearer path checked that (`connection.issuer !== settings.issuer`); the
 *     LOGIN path never did, so a connection row whose issuer had drifted away
 *     from configuration still minted sessions;
 *   * the TENANT behind the connection was never checked at all. A suspended,
 *     archived or windowed-out tenant's users kept logging in, and only the next
 *     request — a different code path — noticed;
 *   * the ORGANIZATION HIERARCHY (dealer group, legal entity) was never checked,
 *     so a tenant whose organization had been archived beneath it still admitted
 *     logins;
 *   * the UserLink was required to be `activated` but NOT to be inside its
 *     EFFECTIVE WINDOW. `observeUserLinkOnLogin` filters on status alone, so a
 *     link whose `effective_to` was yesterday — the shape an offboarding uses —
 *     logged in successfully. Request authentication then refused it, which is
 *     precisely the split-brain a session should never be able to reach;
 *   * the EXCHANGE RESPONSE and the VERIFIED TOKEN were never compared with each
 *     other. They are two separate carriers of the same claims, and R3 read the
 *     provider user id from the token, the email and display name from the
 *     exchange, the organization from the token and the provider session id from
 *     the token — while `createSession` was handed the exchange's refresh token.
 *     Nothing required the two to describe the same person, the same
 *     organization, the same provider session or the same impersonation state.
 *
 * ── what R4 left broken, and what this module is now (FBL-020-R5 §1.3) ─────
 *
 * R4 fixed the LIST of facts and left the SHAPE wrong. Its `admitLoginIdentity`
 * decided the whole chain, COMMITTED, and handed the answer back; the route then
 * called `createSession`, which opened a second transaction and inserted the
 * session — with the provider refresh credential sealed into it — unconditionally.
 * A tenant suspension, connection disablement, link deactivation, relink or
 * effective-window closure landing between those two commits still produced a
 * session and still took the credential into custody. And because the admission
 * held no lock, a change committed while it was still running was invisible to it
 * under READ COMMITTED.
 *
 * ONE function now, and it does BOTH. `admitLoginAndEstablishSession` reads every
 * fact under `FOR SHARE`, inserts the session and seals the credential in the SAME
 * transaction, and has no code path that admits without establishing. A route
 * cannot forget half of one call, and cannot hold an admission it has not acted on
 * yet — because it is never given one. All of the SQL lives here, in a package,
 * because `apps/**` may hold none.
 *
 * The refusal is a CLOSED internal vocabulary recorded on the login transaction
 * and in the audit trail. It is never rendered: every condition below produces
 * the same neutral 401 outward, so a caller cannot use the response to learn
 * whether a tenant is suspended, a link is pending, a window has closed or an
 * issuer has drifted.
 *
 * NOTHING AT REST ON A REFUSAL: no session, no cookie (the route's business, and
 * it has nothing to set) and — the part R3 left latest — no sealed provider
 * refresh credential. The only statement that could write one is inside the
 * transaction, after the last refusal point.
 */
import { setTenantContext, withTransaction, type Executor } from '@dealer/database';
import {
  IDENTITY_PROVIDER_WORKOS,
  type CodeExchangeResult,
  type IdentityProviderKind,
  type VerifiedAccessToken,
} from './contracts';
import {
  failLoginTransaction,
  succeedLoginTransactionWithin,
  type LoginSuccessRefusal,
} from './login-transaction';
import { createSessionWithin, type CreatedSession } from './session';
import { observeUserLinkOnLoginWithin } from './user-link';

interface Row {
  [key: string]: unknown;
}

/**
 * WHY a login was refused. Recorded, never rendered. Each value is a member of
 * `LoginTransactionFailureReason` or maps onto one, so the transaction row can
 * carry it without widening that vocabulary.
 */
export type LoginAdmissionRefusal =
  /** The exchange response and the verified token disagree about the identity. */
  | 'exchange_token_mismatch'
  /** Either carrier says this authentication acts on somebody's behalf. */
  | 'impersonation_detected'
  /**
   * The connection, its issuer, its tenant or the tenant's organization
   * hierarchy did not admit this login. Deliberately ONE value: the four are
   * indistinguishable outward, and collapsing them here means no code path can
   * accidentally render the difference.
   */
  | 'identity_not_admitted'
  /**
   * FBL-020-R6 §2.3/§2.5 — the chain held and the session was built, and the login
   * transaction could NOT be moved to `succeeded`: it had expired in database time,
   * or it was no longer `consuming`, or the identity it was opened for disagreed
   * with the identity admitted. The whole transaction — session row, sealed provider
   * refresh credential, session-established audit — was ROLLED BACK, and the login
   * transaction has already been terminalized with its own reason by this call.
   */
  | 'login_not_completable';

/** The facts a session may be built from, every one of them database-derived. */
export interface AdmittedLogin {
  readonly tenantId: string | null;
  readonly actorScope: 'dealership' | 'platform';
  readonly connectionId: string;
  readonly issuer: string;
  readonly providerOrganizationId: string;
  readonly userLinkId: string;
  /** The provider subject, taken from the LINK row rather than from a token. */
  readonly providerSubject: string;
  /** The provider session id BOTH carriers agreed on. */
  readonly providerSessionId: string;
}

/*
 * R5 §1.3: there is deliberately NO `LoginAdmission` type here any more — no shape
 * that says "admitted" without also carrying the session that admission
 * established. R4 exported one, and a type a caller can hold is a decision a caller
 * can act on later; `LoginAdmissionWithSession` below is the only outcome.
 */

/**
 * FBL-020-R4 §1 — the CHAIN a login must satisfy, expressed once.
 * FBL-020-R5 §1.3 — and HELD for the rest of the transaction, not merely read.
 *
 * Every fact is read from the database, inside its EFFECTIVE WINDOW, and
 * compared against the others rather than merely being present:
 *
 *   1. connection  — active, effective, of this provider, for this external
 *                    organization, and its issuer EQUAL to the configured
 *                    trusted issuer ($3);
 *   2. tenant      — active and effective (a platform-scope connection has none,
 *                    and `NULL` is admitted only because the CHECK on
 *                    `connection_scope` makes it mean exactly that);
 *   3. hierarchy   — for a dealership connection, at least one active, effective
 *                    LEGAL ENTITY of the tenant, joined to an active, effective
 *                    DEALER GROUP of that same tenant. An organization archived
 *                    out from under a tenant is not a home a session can be
 *                    issued into.
 *
 * ONE HIERARCHY CLAUSE, NOT TWO (FBL-020-R4 correction F5). This SQL carried a
 * separate `EXISTS` for "an active, effective dealer group of this tenant", and
 * the header presented the hierarchy as two load-bearing facts. It was not two:
 * clause 3 finds a legal entity of the tenant joined to a dealer group of the SAME
 * tenant with the same three conditions, so any state satisfying clause 3
 * satisfies the dealer-group clause by construction — `g2` IS such a group. The
 * dealer-group `EXISTS` could therefore never be the sole failing clause, and no
 * database state exists in which removing it changes the outcome; there is no
 * scenario that could be written to pin it. It is gone, and this paragraph is why.
 * What remains is exercised in both directions by `tests/login-admission.test.ts`:
 * archiving the legal entities refuses (_an ARCHIVED organization hierarchy
 * beneath an active tenant_), and archiving the DEALER GROUPS while leaving the
 * legal entities active still refuses (_an ARCHIVED DEALER GROUP…_), through the
 * `g2` join inside clause 3 — which is the subsumption, demonstrated rather than
 * asserted.
 *
 * ── WHY THESE ARE THREE LOCKED STATEMENTS AND NOT ONE UNLOCKED ONE (R5 §1.3) ──
 *
 * R4 asked all three questions in a single unlocked `SELECT`, with clauses 2 and 3
 * as `EXISTS` subqueries. Under READ COMMITTED that reads a snapshot and holds
 * NOTHING: an administrator suspending the tenant a microsecond later commits
 * freely, and the login — which had already decided — went on to insert a session
 * and seal a provider refresh credential for a tenant that no longer admits
 * logins. Merging the session INSERT into the same transaction does not fix that
 * on its own, because a snapshot read is not a claim on the row.
 *
 * `FOR SHARE` is the claim. Each fact the admission depends on is locked in the
 * statement that reads it, and the locks are held to COMMIT — which now happens
 * only after the session row exists. The two orderings are then the only two:
 *
 *   * the administrator's write commits FIRST — our lock request waits, is granted
 *     against the NEW row version, the predicates are re-evaluated against it, and
 *     the row does not qualify. No session, no custody.
 *   * OUR transaction commits first — the administrator waits for us, and their
 *     change lands on a system where the session already exists and is subject to
 *     the ordinary revalidation and revocation paths.
 *
 * ── EXACTLY WHAT EACH HALF OF THAT IS PROVEN BY (R5 Appendix A item 4) ───────
 *
 * WHICH LOCK MODE, AND WHY THE OBVIOUS MUTATION PROVED NOTHING. `FOR SHARE` is
 * deliberately not `FOR UPDATE`: share locks do not conflict with each other, so a
 * second login through the same connection is not queued behind the first. A gate
 * pass once tried to pin that by substituting `FOR UPDATE` at all three sites and
 * reported the whole concurrency battery still green — and it was RIGHT to stay
 * green. `FOR UPDATE` is STRICTLY STRONGER than `FOR SHARE`: it excludes everything
 * `FOR SHARE` excludes and more, so it cannot enable a race, and a test suite that
 * still passed under it had not failed to notice anything. A stronger-lock
 * substitution is not a security mutation at all, and no test should be written to
 * kill one for its own sake.
 *
 * The two claims are therefore pinned separately, and each by a mutation that
 * genuinely removes what it names:
 *
 *   * THE SECURITY CLAIM — the row is HELD — is pinned by REMOVING the lock.
 *     `scripts/mutation-kill.ts` deletes `FOR SHARE` from each statement in turn:
 *     `admission_holds_no_locks` kills CONNECTION DISABLEMENT,
 *     `tenant_admission_holds_no_lock` kills TENANT SUSPENSION and TENANT
 *     EFFECTIVE-WINDOW CLOSURE, `hierarchy_admission_holds_no_lock` kills
 *     ORGANIZATION HIERARCHY ARCHIVAL. Removed all three at once, the login stops
 *     queueing altogether, reads a stale snapshot, and RETURNS 302 WITH A SESSION
 *     AND SEALED CUSTODY for a tenant an administrator has just suspended — those
 *     four scenarios in `tests/login-admission-concurrency.test.ts` die and the
 *     other seven tests still pass. Measured, not expected.
 *   * THE MODE CLAIM — the hold is SHARED, not exclusive — is pinned by the
 *     opposite barrier: a second connection holds its own `FOR SHARE` on the
 *     connection row and the login must still finish (_the admission claims its
 *     rows in a SHARED mode…_). Substituting `FOR UPDATE` makes that login queue,
 *     PostgreSQL reports the ungranted request, and that one test — and only it —
 *     dies (`admission_takes_an_exclusive_lock`).
 *
 * WHAT THE LOCKS DO **NOT** CARRY. The three LINK scenarios of §1.4 — deactivation,
 * effective-window closure and relinking — SURVIVE removing all three locks. They
 * are not enforced here at all; `admitUserLink` below re-reads the link and is the
 * sole enforcement, which is measured rather than argued: see its own header.
 *
 * WHAT THIS DOES NOT PROMISE. The statements below lock in a fixed order —
 * connection, tenant, hierarchy, link — so two concurrent LOGINS cannot deadlock
 * against each other. An administrative transaction that writes these same tables
 * in the opposite order can still deadlock against a login; PostgreSQL detects it
 * and aborts one side, and a login aborted that way fails closed (no session, no
 * custody) and surfaces as an error rather than as an admission. That is a
 * disclosed cost of holding real locks, not a gap in the guarantee above.
 */
const LOGIN_CONNECTION_ADMISSION_SQL = `
        c.provider = $1
    AND c.provider_organization_id = $2
    AND c.status = 'active'
    AND c.effective_from <= NOW()
    AND (c.effective_to IS NULL OR c.effective_to > NOW())
    AND c.issuer = $3`;

/** Clause 2, as its own LOCKED statement. `$1` is the connection's tenant. */
const LOGIN_TENANT_ADMISSION_SQL = `
  SELECT t.tenant_id FROM tenants t
   WHERE t.tenant_id = $1::uuid
     AND t.status = 'active'
     AND t.effective_from <= NOW()
     AND (t.effective_to IS NULL OR t.effective_to > NOW())
     FOR SHARE`;

/**
 * Clause 3, as its own LOCKED statement. Every qualifying pair is locked, not just
 * one: locking a single row would leave an administrator free to archive the
 * others concurrently, and "at least one active legal entity" is a fact about the
 * SET rather than about whichever row a plan happened to return first.
 */
const LOGIN_HIERARCHY_ADMISSION_SQL = `
  SELECT le.legal_entity_id
    FROM legal_entities le
    JOIN dealer_groups g2
      ON g2.tenant_id = le.tenant_id AND g2.dealer_group_id = le.dealer_group_id
   WHERE le.tenant_id = $1::uuid
     AND le.status = 'active'
     AND le.effective_from <= NOW()
     AND (le.effective_to IS NULL OR le.effective_to > NOW())
     AND g2.status = 'active'
     AND g2.effective_from <= NOW()
     AND (g2.effective_to IS NULL OR g2.effective_to > NOW())
     FOR SHARE`;

/**
 * The UserLink admission, on the CALLER'S executor so it runs in the same
 * transaction as the observation that may have just created it.
 *
 * `activated` is not enough and never was: the EFFECTIVE WINDOW is what an
 * offboarding sets, and R3's login read status alone.
 *
 * NO EXPLICIT LOCK HERE, AND THE REASON IS NOT AN OVERSIGHT (R5 §1.3). The link row
 * is ALREADY held exclusively by this transaction: every branch of
 * `observeUserLinkOnLoginWithin` that returns a link either INSERTed it or UPDATEd
 * it a moment ago, and an `UPDATE` takes a stronger row lock than `FOR SHARE`
 * would. So a concurrent deactivation, window closure or RELINK is serialised
 * against this login by the observation, and this statement then re-reads under a
 * fresh statement snapshot and refuses what changed. Adding `FOR SHARE` here would
 * be a control no test could prove load-bearing, which is worse than none —
 * `tests/login-admission-concurrency.test.ts` proves the BEHAVIOUR instead.
 *
 * ── AND THIS RE-READ IS THE WHOLE ENFORCEMENT, MEASURED (R5 Appendix A item 4) ──
 *
 * The serialisation above only makes the login WAIT. What REFUSES is the predicate
 * list below, and nothing else — not the admission's `FOR SHARE` locks, and not the
 * observation, whose own branch decision is taken from a snapshot read that still
 * shows the pre-change row. Each predicate was removed in turn and the concurrency
 * battery re-run; each removal admits the login it is supposed to refuse, killing
 * exactly one named scenario and no other:
 *
 *   * `ul.status = 'activated'` → _LINK DEACTIVATION cannot race admission…_ dies
 *     (`link_readmission_ignores_status`). The observation does NOT catch this: it
 *     reads the link as still activated, takes the activated branch, and its own
 *     `UPDATE` then lands on the deactivated row and returns it.
 *   * the EFFECTIVE WINDOW pair → _LINK EFFECTIVE-WINDOW CLOSURE…_ dies
 *     (`link_readmission_ignores_the_effective_window`). The observation filters on
 *     no window at all.
 *   * the BINDING triple (`connection_id`, `issuer`, `provider_organization_id`) →
 *     _LINK RELINKING ONTO ANOTHER CONNECTION…_ dies
 *     (`link_readmission_ignores_the_binding`). The observation's own lookup IS
 *     binding-scoped, and it still does not carry this: it runs on the snapshot in
 *     which the link is bound HERE, so it takes the activated branch and hands back
 *     the row the relink has since moved. Only this re-read sees where it went.
 *
 * So §1.4 is carried by two mechanisms, not one: the `FOR SHARE` claims above are
 * the guarantee for the CONNECTION, TENANT and HIERARCHY facts — remove them and a
 * suspended tenant admits a login — and this re-read is the guarantee for the LINK,
 * which those locks do not touch. Both are separately pinned, and neither is
 * described here as covering the other.
 */
async function admitUserLink(
  executor: Executor,
  input: {
    userLinkId: string;
    tenantId: string | null;
    connectionId: string;
    issuer: string;
    providerOrganizationId: string;
    providerSubject: string;
  },
): Promise<{ providerSubject: string } | null> {
  const found = await executor.query(
    `SELECT ul.provider_user_id
       FROM user_links ul
      WHERE ul.user_link_id = $1
        AND ul.status = 'activated'
        AND ul.effective_from <= NOW()
        AND (ul.effective_to IS NULL OR ul.effective_to > NOW())
        AND ul.tenant_id IS NOT DISTINCT FROM $2::uuid
        AND ul.connection_id = $3::uuid
        AND ul.issuer = $4
        AND ul.provider_organization_id = $5
        AND ul.provider_user_id = $6`,
    [
      input.userLinkId,
      input.tenantId,
      input.connectionId,
      input.issuer,
      input.providerOrganizationId,
      input.providerSubject,
    ],
  );
  if (found.rows.length === 0) return null;
  return { providerSubject: String((found.rows[0] as Row).provider_user_id) };
}

/**
 * FBL-020-R4 §1 — the EXCHANGE RESPONSE bound EXACTLY to the VERIFIED TOKEN.
 *
 * A pure comparison, deliberately: it involves no database and no I/O, so it can
 * be exercised directly and cannot be satisfied by anything but agreement.
 *
 * Four facts, and a `null` on either side is a DISAGREEMENT rather than a skipped
 * comparison — "the exchange did not say" cannot corroborate "the token said":
 *
 *   * provider user      — the same person;
 *   * organization       — the same external organization;
 *   * provider session   — the same provider session (`sid`). This is the fact
 *                          logout and refresh are keyed on, so a session built
 *                          from two different provider sessions could be logged
 *                          out of neither;
 *   * impersonation      — both carriers must say NOT impersonated. One carrier
 *                          admitting it while the other stays silent is exactly
 *                          the shape a refusal must catch.
 */
export function exchangeMatchesVerifiedToken(
  exchanged: Pick<
    CodeExchangeResult,
    'providerUserId' | 'providerSessionId' | 'organizationId' | 'impersonation'
  >,
  verified: Pick<
    VerifiedAccessToken,
    'providerUserId' | 'providerSessionId' | 'organizationId' | 'impersonation'
  >,
): boolean {
  if (exchanged.providerUserId !== verified.providerUserId) return false;
  if (exchanged.organizationId === null || exchanged.organizationId !== verified.organizationId) {
    return false;
  }
  if (
    exchanged.providerSessionId === null ||
    exchanged.providerSessionId !== verified.providerSessionId
  ) {
    return false;
  }
  if (exchanged.impersonation.impersonated !== verified.impersonation.impersonated) return false;
  if (
    exchanged.impersonation.impersonatorEmailPresent !==
    verified.impersonation.impersonatorEmailPresent
  ) {
    return false;
  }
  return true;
}

/** True when EITHER carrier asserts an impersonation, however it asserts it. */
function eitherIsImpersonated(
  exchanged: Pick<CodeExchangeResult, 'impersonation'>,
  verified: Pick<VerifiedAccessToken, 'impersonation'>,
): boolean {
  return (
    exchanged.impersonation.impersonated ||
    exchanged.impersonation.impersonatorEmailPresent ||
    verified.impersonation.impersonated ||
    verified.impersonation.impersonatorEmailPresent
  );
}

/**
 * The whole admission chain, on the caller's executor, with every fact it depends
 * on LOCKED for the rest of that transaction. Returns the admitted identity, or
 * `null` for the one indistinguishable `identity_not_admitted` refusal.
 *
 * The lock order is fixed and is the order below — connection, tenant, hierarchy,
 * link — so concurrent logins can never deadlock against one another.
 */
async function admitWithin(
  executor: Executor,
  provider: IdentityProviderKind,
  input: {
    trustedIssuer: string;
    exchanged: CodeExchangeResult;
    verified: VerifiedAccessToken;
  },
): Promise<AdmittedLogin | null> {
  const { exchanged, verified } = input;
  // 1. THE CONNECTION, locked. `FOR SHARE` here is what makes a concurrent
  //    disablement, window change or issuer drift either precede this read (and
  //    refuse it) or wait for this transaction to finish.
  const resolved = await executor.query(
    `SELECT c.connection_id, c.connection_scope, c.tenant_id, c.issuer,
            c.provider_organization_id
       FROM identity_provider_connections c
      WHERE ${LOGIN_CONNECTION_ADMISSION_SQL}
        FOR SHARE`,
    [provider, verified.organizationId, input.trustedIssuer],
  );
  if (resolved.rows.length === 0) return null;
  const row = resolved.rows[0] as Row;
  const connection = {
    connectionId: String(row.connection_id),
    actorScope: String(row.connection_scope) as 'dealership' | 'platform',
    tenantId: row.tenant_id === null ? null : String(row.tenant_id),
    issuer: String(row.issuer),
    providerOrganizationId: String(row.provider_organization_id),
  };

  // 2 and 3. THE TENANT AND ITS ORGANIZATION HIERARCHY, locked. A platform-scope
  //    connection has no tenant, and the schema's `connection_scope` CHECK is what
  //    makes `NULL` mean exactly that rather than "not known".
  if (connection.tenantId !== null) {
    const tenant = await executor.query(LOGIN_TENANT_ADMISSION_SQL, [connection.tenantId]);
    if (tenant.rows.length === 0) return null;
    // RT1: the hierarchy admission reads the row-secured legal_entities table,
    // so this transaction carries the tenant context — derived from the
    // CONNECTION the token verified against, never from the caller.
    await setTenantContext(executor, connection.tenantId);
    const hierarchy = await executor.query(LOGIN_HIERARCHY_ADMISSION_SQL, [connection.tenantId]);
    if (hierarchy.rows.length === 0) return null;
  }

  // 4. The OBSERVATION grants nothing: it may create or refresh a PENDING claim so
  //    an administrator has something to activate, and it never activates one.
  const observed = await observeUserLinkOnLoginWithin(executor, {
    tenantId: connection.tenantId,
    provider,
    providerUserId: verified.providerUserId,
    email: exchanged.email,
    displayName: exchanged.displayName,
    connectionId: connection.connectionId,
    issuer: connection.issuer,
    providerOrganizationId: connection.providerOrganizationId,
  });
  if (observed === null) return null;

  const link = await admitUserLink(executor, {
    userLinkId: observed.userLinkId,
    tenantId: connection.tenantId,
    connectionId: connection.connectionId,
    issuer: connection.issuer,
    providerOrganizationId: connection.providerOrganizationId,
    providerSubject: verified.providerUserId,
  });
  if (link === null) return null;

  return {
    tenantId: connection.tenantId,
    actorScope: connection.actorScope,
    connectionId: connection.connectionId,
    issuer: connection.issuer,
    providerOrganizationId: connection.providerOrganizationId,
    userLinkId: observed.userLinkId,
    providerSubject: link.providerSubject,
    providerSessionId: verified.providerSessionId,
  };
}

/** What the login leg needs from its configuration to establish the session. */
export interface LoginSessionCustody {
  readonly ttlSeconds: number;
  /**
   * SEALS the provider refresh token so a later refresh can present it. Omitted,
   * the session is simply not refreshable — never a silent half-state.
   */
  readonly cookiePassword?: string;
  readonly refreshStateKeyVersion?: number;
}

export type LoginAdmissionWithSession =
  | {
      readonly admitted: true;
      readonly identity: AdmittedLogin;
      /** The established session and its ONE-TIME cookie value. */
      readonly created: CreatedSession;
    }
  | { readonly admitted: false; readonly refusal: LoginAdmissionRefusal };

/**
 * THE SHAPE IS THE CONTROL. `session` is REQUIRED, and an admitted result ALWAYS
 * carries a `created` session, so there is no way to ask this module "may this
 * login in?" and act on the answer later. R4's separate `admitLoginIdentity` was
 * exactly such a question, and the interval between its answer and the caller's
 * `createSession` was the defect §1.3 names.
 */
export interface LoginAdmissionRequest {
  /** The CONFIGURED trusted issuer. A connection whose issuer differs is refused. */
  readonly trustedIssuer: string;
  readonly exchanged: CodeExchangeResult;
  readonly verified: VerifiedAccessToken;
  readonly provider?: IdentityProviderKind;
  readonly session: LoginSessionCustody;
  /**
   * FBL-020-R6 §2.5 — THE CLAIMED LOGIN TRANSACTION THIS ADMISSION COMPLETES, and
   * it is REQUIRED for the same reason `session` is: a caller that could omit it
   * would be back to establishing custody in one commit and recording the login in
   * another, which is the defect §2.5 names. The success transition happens inside
   * this call's transaction, so there is no interval a caller could act in.
   */
  readonly loginTxnId: string;
}

/**
 * Thrown INSIDE the admission transaction when the login transaction cannot reach
 * `succeeded`, purely to force a ROLLBACK. `withTransaction` commits whatever a
 * successful callback returns, so a refusal expressed as a return value would leave
 * the session row and the sealed provider credential committed — which is precisely
 * the orphan §2.5 exists to make unreachable. It never escapes this module.
 */
class LoginSuccessNotRecorded extends Error {
  constructor(readonly refusal: LoginSuccessRefusal) {
    super('the login transaction could not be recorded as succeeded');
    this.name = 'LoginSuccessNotRecorded';
  }
}

/**
 * THE ONE FUNCTION. Admits a login, takes custody of what it admits, AND records
 * the login transaction as succeeded — or refuses, leaving nothing at rest. There
 * is no third answer and no intermediate state.
 *
 * ── what R5 still got wrong (FBL-020-R6 §2.3/§2.5) ─────────────────────────
 *
 * R5 closed the admission↔custody gap (below) and left a SECOND one exactly like
 * it: the ROUTE recorded the login as succeeded, in its own transaction, after this
 * one had committed. A success transition that refused — R6 §2.3's expiry, or
 * another leg terminalizing the row — or an `identity.login.succeeded` audit INSERT
 * that failed, or a process that stopped in between, each left a committed, live,
 * REFRESHABLE session belonging to no completed login. The route's compensation was
 * to revoke the session it had just been handed: a second best-effort write with the
 * same failure modes, one step later. The success transition is now INSIDE this
 * transaction, so custody, the login's success and both of their audit rows are one
 * local commit and a refusal rolls all of them back together.
 *
 * ── what R4 got wrong (FBL-020-R5 §1.3) ────────────────────────────────────
 *
 * R4 split this in two. `admitLoginIdentity` opened a transaction, decided the
 * whole chain, and COMMITTED; the route then called `createSession`, which opened
 * a second transaction and inserted the session unconditionally. Between those two
 * commits a tenant suspension, a connection disablement, a link deactivation, a
 * relink or an effective-window closure could land — and the session was created
 * anyway, WITH the provider refresh credential sealed into it. The admission was a
 * decision about a moment that had already passed.
 *
 * The route could not fix that by checking again, because checking again is the
 * same defect one step later. What closes it is that there is now only ONE call: a
 * single transaction in which the chain is read under `FOR SHARE` locks, the
 * session row is inserted, and the provider credential is sealed — committed
 * together or not at all. A caller cannot get an admission WITHOUT a session,
 * because this function does not offer one.
 *
 * ── what stays outside ─────────────────────────────────────────────────────
 *
 * NO PROVIDER HTTP CALL happens inside the transaction. Both carriers — the
 * exchange response and the verified access token — were obtained before this
 * function was entered and are passed in as values. That is the R3 three-phase
 * structure, and reopening it (a network call under an open transaction) was a
 * prior rejection; this section preserves it.
 *
 * ── on refusal ─────────────────────────────────────────────────────────────
 *
 * NOTHING is created that could serve as a credential: no session row, no cookie
 * (the route's business, and it has nothing to set), and no sealed provider
 * refresh state. The refresh token stays in this call's arguments; the only
 * statement that could write it is inside the transaction, after the last refusal
 * point, and a refusal returns before reaching it.
 */
export async function admitLoginAndEstablishSession(
  input: LoginAdmissionRequest,
): Promise<LoginAdmissionWithSession> {
  const provider = input.provider ?? IDENTITY_PROVIDER_WORKOS;
  const { exchanged, verified, session: custody } = input;

  // Impersonation first: it is refused on every credential path, and the two
  // carriers are checked TOGETHER so neither can be the only one consulted.
  if (eitherIsImpersonated(exchanged, verified)) {
    return { admitted: false, refusal: 'impersonation_detected' };
  }
  if (!exchangeMatchesVerifiedToken(exchanged, verified)) {
    return { admitted: false, refusal: 'exchange_token_mismatch' };
  }

  let outcome: { identity: AdmittedLogin; created: CreatedSession } | null;
  try {
    outcome = await withTransaction(
      async (executor): Promise<{ identity: AdmittedLogin; created: CreatedSession } | null> => {
        const identity = await admitWithin(executor, provider, input);
        if (identity === null) return null;

        // THE CUSTODY, in the same transaction and under the same locks. Sealing the
        // provider refresh credential IS this INSERT — the sealed state and its
        // replay digest are columns of the row — so an admission that is rolled back
        // takes the credential with it.
        const created = await createSessionWithin(executor, {
          tenantId: identity.tenantId,
          userLinkId: identity.userLinkId,
          providerSessionId: identity.providerSessionId,
          authTime: verified.authTime,
          ttlSeconds: custody.ttlSeconds,
          connectionId: identity.connectionId,
          issuer: identity.issuer,
          providerSubject: identity.providerSubject,
          providerOrganizationId: identity.providerOrganizationId,
          refreshToken: exchanged.refreshToken,
          cookiePassword: custody.cookiePassword,
          refreshStateKeyVersion: custody.refreshStateKeyVersion,
          // R3 correction C1: WHEN the provider credential expires, taken from the
          // token this login already verified. Without it the sealed state would be
          // a credential in custody that nothing could ever spend.
          providerAccessTokenExpiresAt: verified.expiresAt,
        });

        /*
         * ── FBL-020-R6 §2.5: THE SUCCESS TRANSITION, IN THIS SAME COMMIT ────────
         *
         * R5 recorded it from the ROUTE, in a transaction of its own, AFTER this one
         * had committed. Three things could then land between the two commits and
         * each of them left a live, refreshable session that no login owned: the
         * success UPDATE could refuse (§2.3's expiry, or another leg terminalizing
         * the row), its `identity.login.succeeded` audit INSERT could fail, or the
         * process could stop. The route's compensation — revoke the session it had
         * just been handed — was a second best-effort write with the same three
         * failure modes, one step later.
         *
         * There is no interval now. The session row, the sealed provider credential,
         * the session-established audit, the success transition and the
         * `identity.login.succeeded` audit are ONE local commit, and a refusal
         * THROWS so that `withTransaction` rolls all five back together. NOTHING
         * about that reaches the provider: both carriers were obtained before this
         * function was entered, and no statement below opens a network call.
         */
        const recorded = await succeedLoginTransactionWithin(executor, {
          loginTxnId: input.loginTxnId,
          tenantId: created.session.tenantId,
          userLinkId: created.session.userLinkId,
          connectionId: created.session.connectionId,
        });
        if (!recorded.recorded) throw new LoginSuccessNotRecorded(recorded.refusal);
        return { identity, created };
      },
    );
  } catch (err) {
    if (err instanceof LoginSuccessNotRecorded) {
      /*
       * The rollback has already happened: no session row, no sealed credential, no
       * audit row for either. The TERMINAL FACT is recorded here, in a transaction
       * of its own, because the one that would have carried it no longer exists —
       * and it is conditional on the row being non-terminal, so a transaction some
       * other path has already closed keeps its first reason.
       */
      await failLoginTransaction(input.loginTxnId, err.refusal);
      return { admitted: false, refusal: 'login_not_completable' };
    }
    throw err;
  }
  if (outcome === null) return { admitted: false, refusal: 'identity_not_admitted' };
  return { admitted: true, identity: outcome.identity, created: outcome.created };
}
