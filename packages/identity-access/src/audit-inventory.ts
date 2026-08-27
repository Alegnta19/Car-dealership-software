/**
 * FBL-020-R4 §3 — THE IDENTITY AUDIT INVENTORY, as data.
 *
 * The order requires that every identity lifecycle transition write a
 * transactional audit event, and that the mapping transition → event type →
 * proving test be MACHINE-READABLE rather than prose. This is that mapping.
 *
 * WHAT ENFORCES IT, EXACTLY — and nothing beyond these sentences is claimed:
 *
 *   1. `scripts/check-audit-inventory.ts` (wired into `npm run architecture:check`)
 *      reads every production source file with the TypeScript AST plus every
 *      migration as text, and resolves every string-valued expression through the
 *      SHARED static string resolver in `scripts/static-string-resolver.ts` — the
 *      same one `scripts/check-role-binding-effectiveness.ts` uses. Every name in
 *      the `identity.` namespace THAT THE RESOLVER CAN READ must be either an
 *      `eventType` below or a declared entry of
 *      `IDENTITY_NON_AUDIT_NAMESPACE_LITERALS`. "Can read" is not a synonym for
 *      "is spelled in one literal": concatenation, `+=` accumulation, `.join`,
 *      `.concat`, `String.raw`, indexed fragments, lookup maps, `?:`/`??`
 *      alternatives and cross-file imports are all resolved first, and
 *      `architecture/fixtures/audit-inventory-assembly/` is twelve spellings that
 *      must each be rejected.
 *
 *   2. Where the resolver CANNOT read a name, the run fails rather than passing
 *      over it. A readable root with an unreadable tail (`identity.support.${x}`)
 *      is `audit-event-type-assembled-at-run-time`; an unreadable root followed by
 *      a DECLARED FAMILY (`${ns}.support.quarantined`) is
 *      `audit-event-type-namespace-root-assembled-at-run-time`.
 *
 *   3. Every production file holding an `INSERT INTO audit_events` must be a
 *      DECLARED WRITER, which is what stops a new namespace from opening outside
 *      this file's reach.
 *
 *   4. The reverse direction: an entry whose event type no longer appears in
 *      production code, a declared non-audit literal that has gone, a declared
 *      writer that no longer writes, an entry whose family contradicts its own
 *      event type, and an entry whose `provenIn` file does not contain its
 *      `provenBy` string verbatim, are each failures.
 *
 *   5. `tests/identity-lifecycle-audit.test.ts` drives every login, session and
 *      reauthentication entry against the real production services in one
 *      database and asserts the named event type actually appears, so an entry
 *      that stops being true fails the suite.
 *
 *   6. `REQUIRED_IDENTITY_AUDIT_TRANSITIONS` is checked against the `transition`
 *      column, so a DELETED entry is a failure rather than a shorter list.
 *
 *   7. Every rule above has a test that dies when that rule alone is removed —
 *      the scanning rules through the fixture corpora in
 *      `architecture/fixtures/`, the rules that judge THIS FILE's data through
 *      `tests/audit-inventory-rules.test.ts`.
 *
 * WHAT IS NOT ENFORCED, stated so the claim above is exact, and DEMONSTRATED by
 * fixtures in `architecture/fixtures/audit-inventory-residue/` that the gate
 * accepts rather than by prose alone:
 *
 *   - A NAME WHERE NEITHER THE ROOT NOR A DECLARED FAMILY IS READABLE —
 *     `${root}.${family}.renamed`. Rule 2 needs one of the two; with neither,
 *     nothing marks the string as an event type. Such a write is still confined to
 *     a declared writer file by rule 3.
 *   - AN AUDIT EVENT WRITTEN UNDER A DIFFERENT NAMESPACE, caught only by the
 *     declared-writer rule (3), which is a rule about FILES, not about names.
 *   - EVERYTHING THE SHARED RESOLVER CANNOT SEE: values crossing a function
 *     boundary, array mutation other than `push`, object KEYS, strings produced at
 *     run time, and its depth and breadth limits.
 *
 * All three are recorded in `docs/identity/KNOWN-LIMITATIONS.md`, "the audit
 * inventory is complete over the `identity.` namespace, not over `audit_events`".
 *
 * HISTORY, because this file's header is the thing that was wrong before. R4's
 * first pass asserted that "a transition added to the platform without an entry
 * fails the completeness assertion" when no such assertion existed anywhere. The
 * list was in fact a SUBSET: 19 entries, missing `identity.support.expired` — the
 * event §4's OWN expiry processor writes, inside this file's OWN declared `support`
 * family. The enumeration is now complete (46 entries against 46 event types found
 * in production code) and the assertion exists. R4's SECOND pass then wrote a
 * header claiming the gate "REFUSED outright" any name assembled at run time,
 * when `'identity.support' + '.quarantined'` walked past it — which is why the
 * sentences above are scoped to what the shared resolver reads, and why the limits
 * have fixtures instead of adverbs.
 *
 * WHAT IS DELIBERATELY NOT HERE: the policy `policy_decisions` ledger. That is
 * the authorization evidence table and has its own completeness constraints in
 * migration 057; this inventory covers `audit_events`, which is what an operator
 * reads for "what happened to this identity".
 */

/**
 * The transition families, which are exactly the SECOND SEGMENT of an event type
 * (`identity.<family>.<name>`). The first four are the families the order
 * enumerates by name; the rest are the identity mutations §14.3 requires to
 * "persist the true actor and transactional audit event", enumerated here so the
 * inventory covers the whole `identity.` namespace rather than a chosen slice of
 * it.
 */
export type IdentityAuditFamily =
  | 'login'
  | 'session'
  | 'reauthentication'
  | 'support'
  | 'user_link'
  | 'organization'
  | 'organization_unit'
  | 'provider_connection'
  | 'role_binding';

/** The namespace root this inventory is complete over. */
export const IDENTITY_AUDIT_NAMESPACE = 'identity.';

/** Every declared family, in one place the checker can read. */
export const IDENTITY_AUDIT_FAMILIES: readonly IdentityAuditFamily[] = [
  'login',
  'session',
  'reauthentication',
  'support',
  'user_link',
  'organization',
  'organization_unit',
  'provider_connection',
  'role_binding',
];

export interface IdentityAuditInventoryEntry {
  /** The lifecycle transition, in the order's own vocabulary. */
  readonly transition: string;
  readonly family: IdentityAuditFamily;
  /** The `audit_events.event_type` the transition writes. Exactly one. */
  readonly eventType: string;
  /** The `audit_events.entity_type` the row is filed under. */
  readonly entityType: string;
  /** The exported service whose transaction writes it. */
  readonly writtenBy: string;
  /**
   * The FILE the proof lives in, repository-relative. Checked to exist and to
   * contain `provenBy` verbatim, so a renamed or deleted proof fails the
   * architecture check instead of leaving a citation pointing at nothing.
   */
  readonly provenIn: string;
  /**
   * The proving test's name, verbatim as `test('…')` declares it — or, for the
   * one transition a MIGRATION performs, the verbatim id of the CI gate check
   * that asserts it. R3's values here were prose that matched no test name in
   * any file; rule (1) above is why they cannot be prose again.
   */
  readonly provenBy: string;
}

/** The one battery that drives a transition end to end against live services. */
const LIFECYCLE = 'tests/identity-lifecycle-audit.test.ts';
const LIFECYCLE_TEST =
  'the audit inventory is complete, and every transition in it writes its event';

/** The mutation-envelope battery: version advanced, true actor named, audited once. */
const BOUNDARY = 'tests/identity-boundary.test.ts';
const BOUNDARY_TEST = 'every mutation advances its version, names the TRUE actor, audits once';

export const IDENTITY_AUDIT_INVENTORY: readonly IdentityAuditInventoryEntry[] = [
  // ── login ────────────────────────────────────────────────────────────────
  {
    transition: 'login.start',
    family: 'login',
    eventType: 'identity.login.started',
    entityType: 'login_transaction',
    writtenBy: 'startLoginTransaction',
    provenIn: LIFECYCLE,
    provenBy: LIFECYCLE_TEST,
  },
  {
    transition: 'login.claim',
    family: 'login',
    eventType: 'identity.login.claimed',
    entityType: 'login_transaction',
    writtenBy: 'claimLoginTransactionAtomically',
    provenIn: LIFECYCLE,
    provenBy: LIFECYCLE_TEST,
  },
  {
    transition: 'login.success',
    family: 'login',
    eventType: 'identity.login.succeeded',
    entityType: 'login_transaction',
    writtenBy: 'succeedLoginTransaction',
    provenIn: LIFECYCLE,
    provenBy: LIFECYCLE_TEST,
  },
  {
    transition: 'login.failure',
    family: 'login',
    eventType: 'identity.login.failed',
    entityType: 'login_transaction',
    writtenBy: 'failLoginTransaction',
    provenIn: LIFECYCLE,
    provenBy: LIFECYCLE_TEST,
  },
  {
    transition: 'login.replay',
    family: 'login',
    eventType: 'identity.login.replayed',
    entityType: 'login_transaction',
    writtenBy: 'claimLoginTransactionAtomically',
    provenIn: LIFECYCLE,
    provenBy: LIFECYCLE_TEST,
  },
  {
    transition: 'login.expiry',
    family: 'login',
    eventType: 'identity.login.expired',
    entityType: 'login_transaction',
    writtenBy: 'expireStaleLoginTransactions / failLoginTransaction(expired)',
    provenIn: LIFECYCLE,
    provenBy: LIFECYCLE_TEST,
  },

  // ── session lifecycle ────────────────────────────────────────────────────
  {
    transition: 'session.establishment',
    family: 'session',
    eventType: 'identity.session.established',
    entityType: 'identity_session',
    writtenBy: 'createSession / resolveOrEstablishBearerSession',
    provenIn: LIFECYCLE,
    provenBy: LIFECYCLE_TEST,
  },
  {
    transition: 'session.refresh',
    family: 'session',
    eventType: 'identity.session.refreshed',
    entityType: 'identity_session',
    writtenBy: 'refreshProviderSession',
    provenIn: LIFECYCLE,
    provenBy: LIFECYCLE_TEST,
  },
  {
    transition: 'session.rotation',
    family: 'session',
    eventType: 'identity.session.refresh_state_rotated',
    entityType: 'identity_session',
    writtenBy: 'refreshProviderSession (via the module-private rotateRefreshStateRow)',
    provenIn: LIFECYCLE,
    provenBy: LIFECYCLE_TEST,
  },
  {
    transition: 'session.logout',
    family: 'session',
    eventType: 'identity.session.logged_out',
    entityType: 'identity_session',
    writtenBy: 'revokeSessionByToken(logout) / revokeSessionById(logout)',
    provenIn: LIFECYCLE,
    provenBy: LIFECYCLE_TEST,
  },
  {
    transition: 'session.revocation',
    family: 'session',
    eventType: 'identity.session.revoked',
    entityType: 'identity_session',
    writtenBy: 'revokeSessionById / revokeSessionsForUserLink / revokeForIdentityBreach',
    provenIn: LIFECYCLE,
    provenBy: LIFECYCLE_TEST,
  },

  // ── reauthentication ─────────────────────────────────────────────────────
  {
    transition: 'reauth.start',
    family: 'reauthentication',
    eventType: 'identity.reauthentication.started',
    entityType: 'reauth_transaction',
    writtenBy: 'startReauthentication',
    provenIn: LIFECYCLE,
    provenBy: LIFECYCLE_TEST,
  },
  {
    transition: 'reauth.claim',
    family: 'reauthentication',
    eventType: 'identity.reauthentication.claimed',
    entityType: 'reauth_transaction',
    writtenBy: 'claimReauthentication',
    provenIn: LIFECYCLE,
    provenBy: LIFECYCLE_TEST,
  },
  {
    transition: 'reauth.success',
    family: 'reauthentication',
    eventType: 'identity.reauthentication.granted',
    entityType: 'reauth_transaction',
    writtenBy: 'completeReauthentication',
    provenIn: LIFECYCLE,
    provenBy: LIFECYCLE_TEST,
  },
  {
    transition: 'reauth.failure',
    family: 'reauthentication',
    eventType: 'identity.reauthentication.failed',
    entityType: 'reauth_transaction',
    writtenBy: 'completeReauthentication / failReauthentication',
    provenIn: LIFECYCLE,
    provenBy: LIFECYCLE_TEST,
  },
  {
    transition: 'reauth.replay',
    family: 'reauthentication',
    eventType: 'identity.reauthentication.replayed',
    entityType: 'reauth_transaction',
    writtenBy: 'claimReauthentication',
    provenIn: LIFECYCLE,
    provenBy: LIFECYCLE_TEST,
  },
  {
    transition: 'reauth.expiry',
    family: 'reauthentication',
    eventType: 'identity.reauthentication.expired',
    entityType: 'reauth_transaction',
    writtenBy: 'expireStaleReauthenticationTransactions',
    provenIn: LIFECYCLE,
    provenBy: LIFECYCLE_TEST,
  },
  {
    transition: 'reauth.grant_consumption',
    family: 'reauthentication',
    eventType: 'identity.reauthentication.grant_consumed',
    entityType: 'reauth_grant',
    writtenBy: 'consumeReauthenticationGrant(ReturningId)',
    provenIn: LIFECYCLE,
    provenBy: LIFECYCLE_TEST,
  },

  // ── delegated support access ─────────────────────────────────────────────
  //
  // R4's first pass listed ONLY `support.use` here and claimed the family was
  // complete. These seven were the four-plus-three that were missing.
  {
    transition: 'support.request',
    family: 'support',
    eventType: 'identity.support.requested',
    entityType: 'support_access_request',
    writtenBy: 'requestSupportAccess',
    provenIn: BOUNDARY,
    provenBy: BOUNDARY_TEST,
  },
  {
    transition: 'support.approval',
    family: 'support',
    eventType: 'identity.support.approved',
    entityType: 'support_access_request',
    writtenBy: 'decideSupportAccess(approve: true)',
    provenIn: BOUNDARY,
    provenBy: BOUNDARY_TEST,
  },
  {
    transition: 'support.denial',
    family: 'support',
    eventType: 'identity.support.denied',
    entityType: 'support_access_request',
    writtenBy: 'decideSupportAccess(approve: false)',
    provenIn: BOUNDARY,
    provenBy: BOUNDARY_TEST,
  },
  {
    transition: 'support.session_start',
    family: 'support',
    eventType: 'identity.support.session_started',
    entityType: 'support_access_session',
    writtenBy: 'startSupportSessionWithin, via decideSupportAccess / startSupportSession',
    provenIn: BOUNDARY,
    provenBy: BOUNDARY_TEST,
  },
  {
    transition: 'support.use',
    family: 'support',
    eventType: 'identity.support.used',
    entityType: 'support_access_session',
    writtenBy: 'policy engine (ALLOW_SUPPORT_SESSION)',
    provenIn: 'tests/policy.test.ts',
    provenBy:
      'support access: live approved session grants EXACTLY its action set, in scope, ' +
      'while unexpired and unrevoked',
  },
  {
    transition: 'support.revocation',
    family: 'support',
    eventType: 'identity.support.revoked',
    entityType: 'support_access_session',
    writtenBy: 'revokeSupportSession',
    provenIn: BOUNDARY,
    provenBy: BOUNDARY_TEST,
  },
  {
    /*
     * THE ONE THE FINDING NAMED. §4's expiry processor writes it, on a
     * transition NOBODY performs — so it is the one support event with a NULL
     * actor, and `recordMutation` is deliberately not reused for it.
     */
    transition: 'support.expiry',
    family: 'support',
    eventType: 'identity.support.expired',
    entityType: 'support_access_session',
    writtenBy: 'expireDueSupportSessions (SUPPORT_SESSION_EXPIRED_EVENT), run by apps/worker',
    provenIn: 'tests/support-expiry.test.ts',
    provenBy: 'a lapsed window is transitioned ONCE, with its version and one audit row',
  },
  {
    /*
     * Written by MIGRATION 057, not by a service: §5 and §A2 convert an approval
     * that names no high-assurance grant — or a second approval against one
     * single-use grant — to the same terminal state, preserving the prior
     * decision in the `superseded_*` columns. A one-time reconciliation is still
     * a production audit write, so it is inventoried like any other; its proof is
     * the CI upgrade gate rather than a suite test, because it can only happen
     * once, on a database that predates the migration.
     */
    transition: 'support.approval_supersession',
    family: 'support',
    eventType: 'identity.support.approval_superseded',
    entityType: 'support_access_request',
    writtenBy: 'migrations/057_identity_boundary_completion.sql §5 and §A2 reconciliation',
    provenIn: 'scripts/verify-upgrade-state.ts',
    provenBy: 'audit_grantless_supersession_is_recorded_with_its_reason',
  },

  // ── user links ───────────────────────────────────────────────────────────
  {
    transition: 'user_link.provision',
    family: 'user_link',
    eventType: 'identity.user_link.provisioned',
    entityType: 'user_link',
    writtenBy: 'provisionUserLink (and the bootstrap origin of trust)',
    provenIn: BOUNDARY,
    provenBy: BOUNDARY_TEST,
  },
  {
    transition: 'user_link.activation',
    family: 'user_link',
    eventType: 'identity.user_link.activated',
    entityType: 'user_link',
    writtenBy: 'activateUserLink (and the bootstrap origin of trust)',
    provenIn: BOUNDARY,
    provenBy: BOUNDARY_TEST,
  },
  {
    transition: 'user_link.deactivation',
    family: 'user_link',
    eventType: 'identity.user_link.deactivated',
    entityType: 'user_link',
    writtenBy: 'deactivateUserLink',
    provenIn: BOUNDARY,
    provenBy: BOUNDARY_TEST,
  },
  {
    transition: 'user_link.relink',
    family: 'user_link',
    eventType: 'identity.user_link.relinked',
    entityType: 'user_link',
    writtenBy: 'relinkUserLink',
    provenIn: BOUNDARY,
    provenBy: BOUNDARY_TEST,
  },
  {
    transition: 'user_link.first_login_observation',
    family: 'user_link',
    eventType: 'identity.user_link.pending_created',
    entityType: 'user_link',
    writtenBy: 'observeUserLinkOnLogin (unknown provider identity)',
    provenIn: 'tests/identity-core.test.ts',
    provenBy: 'first login creates a PENDING link, grants NOTHING, and never activates',
  },
  {
    transition: 'user_link.login_observation',
    family: 'user_link',
    eventType: 'identity.user_link.login_observed',
    entityType: 'user_link',
    writtenBy: 'observeUserLinkOnLogin (activated branch)',
    provenIn: 'tests/identity-core.test.ts',
    provenBy:
      'R3: an ACTIVATED login writes its audit event, carrying no email and no display name',
  },
  {
    transition: 'user_link.login_refusal',
    family: 'user_link',
    eventType: 'identity.user_link.login_refused',
    entityType: 'user_link',
    writtenBy: 'observeUserLinkOnLogin (deactivated, and foreign-connection claim, branches)',
    provenIn: 'tests/identity-core.test.ts',
    provenBy: 'a REFUSED login is audited, in both branches that refuse one',
  },
  {
    transition: 'user_link.pending_login_refusal',
    family: 'user_link',
    eventType: 'identity.user_link.pending_login_refused',
    entityType: 'user_link',
    writtenBy: 'observeUserLinkOnLogin (pending branch)',
    provenIn: 'tests/identity-core.test.ts',
    provenBy: 'first login creates a PENDING link, grants NOTHING, and never activates',
  },

  // ── the organization root ────────────────────────────────────────────────
  {
    transition: 'organization.creation',
    family: 'organization',
    eventType: 'identity.organization.created',
    entityType: 'tenant',
    writtenBy: 'createOrganization (and the bootstrap origin of trust)',
    provenIn: BOUNDARY,
    provenBy: BOUNDARY_TEST,
  },
  {
    transition: 'organization.status_change',
    family: 'organization',
    eventType: 'identity.organization.status_changed',
    entityType: 'tenant',
    writtenBy: 'changeOrganizationStatus (and the bootstrap origin of trust)',
    provenIn: BOUNDARY,
    provenBy: BOUNDARY_TEST,
  },

  // ── the organization hierarchy beneath it ────────────────────────────────
  {
    transition: 'organization_unit.creation',
    family: 'organization_unit',
    eventType: 'identity.organization_unit.created',
    entityType: 'the unit LEVEL: dealer_group | legal_entity | rooftop | department',
    writtenBy: 'createOrganizationUnit',
    provenIn: 'tests/owned-mutations.test.ts',
    provenBy: 'creating a unit is attributed, versioned and audited',
  },
  {
    transition: 'organization_unit.status_change',
    family: 'organization_unit',
    eventType: 'identity.organization_unit.status_changed',
    entityType: 'the unit LEVEL: dealer_group | legal_entity | rooftop | department',
    writtenBy: 'changeOrganizationUnitStatus',
    provenIn: 'tests/owned-mutations.test.ts',
    provenBy: 'archiving a rooftop is a versioned, audited MASS REVOCATION — and it revokes',
  },

  // ── provider connections ─────────────────────────────────────────────────
  {
    transition: 'provider_connection.creation',
    family: 'provider_connection',
    eventType: 'identity.provider_connection.created',
    entityType: 'identity_provider_connection',
    writtenBy: 'createProviderMapping (and the bootstrap origin of trust)',
    provenIn: BOUNDARY,
    provenBy: BOUNDARY_TEST,
  },
  {
    transition: 'provider_connection.remap',
    family: 'provider_connection',
    eventType: 'identity.provider_connection.remapped',
    entityType: 'identity_provider_connection',
    writtenBy: 'remapProviderConnection',
    provenIn: BOUNDARY,
    provenBy: BOUNDARY_TEST,
  },
  {
    transition: 'provider_connection.issuer_change',
    family: 'provider_connection',
    eventType: 'identity.provider_connection.issuer_changed',
    entityType: 'identity_provider_connection',
    writtenBy: 'changeProviderIssuer',
    provenIn: BOUNDARY,
    provenBy: BOUNDARY_TEST,
  },
  {
    transition: 'provider_connection.mfa_policy_certification',
    family: 'provider_connection',
    eventType: 'identity.provider_connection.mfa_policy_certified',
    entityType: 'identity_provider_connection',
    writtenBy: 'certifyProviderMfaPolicy',
    provenIn: BOUNDARY,
    provenBy: BOUNDARY_TEST,
  },
  {
    transition: 'provider_connection.mfa_policy_certification_revocation',
    family: 'provider_connection',
    eventType: 'identity.provider_connection.mfa_policy_certification_revoked',
    entityType: 'identity_provider_connection',
    writtenBy: 'revokeProviderMfaPolicyCertification',
    provenIn: LIFECYCLE,
    provenBy: 'MFA certification fails CLOSED when false, missing, expired or revoked',
  },

  // ── role bindings ────────────────────────────────────────────────────────
  {
    transition: 'role_binding.grant',
    family: 'role_binding',
    eventType: 'identity.role_binding.granted',
    entityType: 'role_binding',
    writtenBy: 'grantRole / grantRoleWithin (and the bootstrap origin of trust)',
    provenIn: BOUNDARY,
    provenBy: BOUNDARY_TEST,
  },
  {
    transition: 'role_binding.change',
    family: 'role_binding',
    eventType: 'identity.role_binding.changed',
    entityType: 'role_binding',
    writtenBy: 'changeRole',
    provenIn: BOUNDARY,
    provenBy: BOUNDARY_TEST,
  },
  {
    transition: 'role_binding.revocation',
    family: 'role_binding',
    eventType: 'identity.role_binding.revoked',
    entityType: 'role_binding',
    writtenBy: 'revokeRole / revokeRolesForUserLink / revokeRoleWithin',
    provenIn: BOUNDARY,
    provenBy: BOUNDARY_TEST,
  },
];

/**
 * The `identity.`-namespaced names in production code that are NOT audit event
 * types — the "deliberately out of the declared families" half of the
 * enumeration, each with its role and the reason it is out.
 *
 * This list exists because the completeness check is deliberately BLUNT: it
 * accounts for every readable name in the namespace rather than trying to infer
 * which ones reach `audit_events.event_type`. Inference would be the hole. A
 * declared exception is visible in the diff of this file; an inferred one is not
 * visible anywhere. The field is still called `literal` because that is what these
 * are in the code — each one is spelled out at its site.
 */
export interface IdentityNonAuditNamespaceLiteral {
  readonly literal: string;
  /** What it actually is. */
  readonly role: string;
  /** Why it is not an audit event type. */
  readonly because: string;
}

export const IDENTITY_NON_AUDIT_NAMESPACE_LITERALS: readonly IdentityNonAuditNamespaceLiteral[] = [
  {
    literal: 'identity.user.provision',
    role: 'policy ACTION key (packages/identity-access/src/actions.ts)',
    because:
      'an action is the thing a policy decision is ABOUT; the audit row a provisioning ' +
      'writes is identity.user_link.provisioned, which is inventoried above',
  },
  {
    literal: 'identity.user.deactivate',
    role: 'policy ACTION key (packages/identity-access/src/actions.ts)',
    because: 'as above — the audited transition is identity.user_link.deactivated',
  },
  {
    literal: 'identity.role.grant',
    role: 'policy ACTION key (packages/identity-access/src/actions.ts)',
    because: 'as above — the audited transition is identity.role_binding.granted',
  },
  {
    literal: 'identity.role.revoke',
    role: 'policy ACTION key (packages/identity-access/src/actions.ts)',
    because: 'as above — the audited transition is identity.role_binding.revoked',
  },
  {
    literal: 'identity.connection.certify_mfa_policy',
    role: 'policy ACTION key (packages/identity-access/src/actions.ts, mutations.ts gate)',
    because:
      'as above — the audited transitions are identity.provider_connection.mfa_policy_' +
      'certified and …_certification_revoked',
  },
  {
    literal: 'identity.support.approve',
    role: 'policy ACTION key, and the step-up grant action the approval spends',
    because:
      'INSIDE the declared support family by name and still not an event type: the ' +
      'approval writes identity.support.approved (or .denied), inventoried above',
  },
  {
    literal: 'identity.support.revoke',
    role: 'policy ACTION key (packages/identity-access/src/actions.ts, mutations.ts gate)',
    because: 'as above — the audited transition is identity.support.revoked',
  },
  {
    literal: 'identity.support_access.expiry',
    role: 'the WORKER JOB name (apps/worker/src/main.ts, SUPPORT_ACCESS_EXPIRY_JOB)',
    because:
      'a scheduled job identifier, not a row in audit_events; the job RUNS the transition ' +
      'whose event type is identity.support.expired. Note the namespace is support_access, ' +
      'not support, so it is not in the support family either way',
  },
  {
    literal: 'identity.login_transaction.expiry',
    role: 'the WORKER JOB name (apps/worker/src/main.ts, LOGIN_TRANSACTION_EXPIRY_JOB)',
    because:
      'a scheduled job identifier, not a row in audit_events; the job RUNS ' +
      'expireStaleLoginTransactions, whose event type is identity.login.expired. The ' +
      'namespace is login_transaction, not login, so it is not in the login family either way',
  },
  {
    literal: 'identity.reauthentication_transaction.expiry',
    role: 'the WORKER JOB name (apps/worker/src/main.ts, REAUTHENTICATION_EXPIRY_JOB)',
    because:
      'a scheduled job identifier, not a row in audit_events; the job RUNS ' +
      'expireStaleReauthenticationTransactions, whose event type is ' +
      'identity.reauthentication.expired. The namespace is reauthentication_transaction, not ' +
      'reauthentication, so it is not in the reauthentication family either way',
  },
];

/**
 * Every production file permitted to hold an `INSERT INTO audit_events`, with the
 * namespace it writes.
 *
 * This is the rule that makes the enumeration above CLOSED rather than merely
 * long: a new audit event type has to be written somewhere, and it can only be
 * written from one of these files. `enumerable: true` means every event type the
 * file writes is a name in the `identity.` namespace that the shared static string
 * resolver can read, so the name scan sees it. `enumerable: false` is a declared,
 * reasoned residue.
 */
export interface IdentityAuditWriter {
  readonly file: string;
  readonly namespace: string;
  readonly enumerable: boolean;
  readonly because: string;
}

export const AUDIT_EVENT_WRITERS: readonly IdentityAuditWriter[] = [
  {
    file: 'packages/identity-access/src/mutations.ts',
    namespace: 'identity.',
    enumerable: true,
    because: 'the owned mutation services, plus the support-expiry processor',
  },
  // RELEASE TRAIN 1's administration services (admin-settings.ts) audit under
  // the `admin.` namespace THROUGH mutations.ts's recordMutation envelope —
  // they hold no INSERT INTO audit_events of their own, so they are not
  // writers here: the writer rule is about files with the literal insert.
  // Their event names live outside the identity. namespace this inventory
  // pins, exactly like the Phase-248 `service.${action}` cockpit audit.
  {
    file: 'packages/identity-access/src/login-transaction.ts',
    namespace: 'identity.login.',
    enumerable: true,
    because: 'the one audit writer for login transitions',
  },
  {
    file: 'packages/identity-access/src/session.ts',
    namespace: 'identity.session.',
    enumerable: true,
    because: 'the session lifecycle owner',
  },
  {
    file: 'packages/identity-access/src/reauthentication.ts',
    namespace: 'identity.reauthentication.',
    enumerable: true,
    because: 'the reauthentication transitions and grant consumption',
  },
  {
    file: 'packages/identity-access/src/user-link.ts',
    namespace: 'identity.user_link.',
    enumerable: true,
    because: 'the login observation path',
  },
  {
    file: 'packages/identity-access/src/policy.ts',
    namespace: 'identity.support.',
    enumerable: true,
    because: 'the engine writes the support-use row in the decision transaction',
  },
  {
    file: 'packages/identity-access/src/bootstrap.ts',
    namespace: 'identity.',
    enumerable: true,
    because: 'the origin of trust: one row per applied bootstrap step',
  },
  {
    file: 'packages/fixed-ops/src/legacy/service-cockpit-service.ts',
    namespace: 'service.',
    enumerable: false,
    because:
      'PRE-EXISTING Phase-248 code, outside the identity boundary and outside this ' +
      'inventory: it assembles `service.${action}` at run time, so its event types cannot ' +
      'be read statically. FBL-020 does not touch it. This is the residue recorded in ' +
      'docs/identity/KNOWN-LIMITATIONS.md',
  },
];

/**
 * The transitions the order enumerates, verbatim. The inventory must cover
 * exactly these (plus `reauth.claim`, which the R4 claim step adds) — stated
 * separately so a DELETED entry is a failure rather than a shorter list.
 */
export const REQUIRED_IDENTITY_AUDIT_TRANSITIONS: readonly string[] = [
  'login.start',
  'login.claim',
  'login.success',
  'login.failure',
  'login.replay',
  'login.expiry',
  'session.establishment',
  'session.refresh',
  'session.rotation',
  'session.logout',
  'session.revocation',
  'reauth.start',
  'reauth.success',
  'reauth.failure',
  'reauth.replay',
  'reauth.expiry',
  'reauth.grant_consumption',
  'support.use',
];
