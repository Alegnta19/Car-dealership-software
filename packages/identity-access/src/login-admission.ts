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
 * ── what this module is ────────────────────────────────────────────────────
 *
 * ONE function. The route calls `admitLoginIdentity` and gets back either an
 * admitted identity or a refusal; there is no partial result and no second
 * question for a route to forget to ask. All of the SQL lives here, in a package,
 * because `apps/**` may hold none.
 *
 * The refusal is a CLOSED internal vocabulary recorded on the login transaction
 * and in the audit trail. It is never rendered: every condition below produces
 * the same neutral 401 outward, so a caller cannot use the response to learn
 * whether a tenant is suspended, a link is pending, a window has closed or an
 * issuer has drifted.
 *
 * ORDER MATTERS, and it is the point of the section: admission completes BEFORE
 * `createSession` is called, so a refusal has no session, no cookie and — the
 * part R3 left latest — no sealed provider refresh credential at rest.
 */
import { withTransaction, type Executor } from '@dealer/database';
import {
  IDENTITY_PROVIDER_WORKOS,
  type CodeExchangeResult,
  type IdentityProviderKind,
  type VerifiedAccessToken,
} from './contracts';
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
  | 'identity_not_admitted';

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

export type LoginAdmission =
  | { readonly admitted: true; readonly identity: AdmittedLogin }
  | { readonly admitted: false; readonly refusal: LoginAdmissionRefusal };

/**
 * FBL-020-R4 §1 — the CHAIN a login must satisfy, expressed once.
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
 * `c` is the connection alias. It is a single statement so a login cannot see a
 * half-updated picture of its own admissibility.
 */
const LOGIN_CONNECTION_ADMISSION_SQL = `
        c.provider = $1
    AND c.provider_organization_id = $2
    AND c.status = 'active'
    AND c.effective_from <= NOW()
    AND (c.effective_to IS NULL OR c.effective_to > NOW())
    AND c.issuer = $3
    AND (
      c.tenant_id IS NULL
      OR (
        EXISTS (
          SELECT 1 FROM tenants t
           WHERE t.tenant_id = c.tenant_id
             AND t.status = 'active'
             AND t.effective_from <= NOW()
             AND (t.effective_to IS NULL OR t.effective_to > NOW())
        )
        AND EXISTS (
          SELECT 1 FROM legal_entities le
            JOIN dealer_groups g2
              ON g2.tenant_id = le.tenant_id AND g2.dealer_group_id = le.dealer_group_id
           WHERE le.tenant_id = c.tenant_id
             AND le.status = 'active'
             AND le.effective_from <= NOW()
             AND (le.effective_to IS NULL OR le.effective_to > NOW())
             AND g2.status = 'active'
             AND g2.effective_from <= NOW()
             AND (g2.effective_to IS NULL OR g2.effective_to > NOW())
        )
      )
    )`;

/**
 * The UserLink admission, on the CALLER'S executor so it runs in the same
 * transaction as the observation that may have just created it.
 *
 * `activated` is not enough and never was: the EFFECTIVE WINDOW is what an
 * offboarding sets, and R3's login read status alone.
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
 * THE ONE FUNCTION. Admits a login, or refuses it.
 *
 * On refusal NOTHING is created that could serve as a credential: no session, no
 * cookie (the route's business, and it has nothing to set), and above all no
 * sealed provider refresh state — the refresh token stays in this call's
 * arguments and reaches the database only through the caller's `createSession`,
 * which the caller reaches only when `admitted` is true.
 *
 * The connection admission, the observation (which may create or refresh a
 * PENDING link, and grants nothing) and the link admission share ONE database
 * transaction, so a link cannot be observed into existence and then judged
 * against a different picture. NO PROVIDER HTTP CALL happens inside it — both
 * carriers were obtained before this function was entered, which is the R3
 * three-phase structure this section preserves rather than reopens.
 */
export async function admitLoginIdentity(input: {
  /** The CONFIGURED trusted issuer. A connection whose issuer differs is refused. */
  trustedIssuer: string;
  exchanged: CodeExchangeResult;
  verified: VerifiedAccessToken;
  provider?: IdentityProviderKind;
}): Promise<LoginAdmission> {
  const provider = input.provider ?? IDENTITY_PROVIDER_WORKOS;
  const { exchanged, verified } = input;

  // Impersonation first: it is refused on every credential path, and the two
  // carriers are checked TOGETHER so neither can be the only one consulted.
  if (eitherIsImpersonated(exchanged, verified)) {
    return { admitted: false, refusal: 'impersonation_detected' };
  }
  if (!exchangeMatchesVerifiedToken(exchanged, verified)) {
    return { admitted: false, refusal: 'exchange_token_mismatch' };
  }

  // Connection admission, the observation, and the link admission share ONE
  // transaction. Split across three, a link could be observed into existence
  // against one picture of the chain and admitted against another — and the
  // window between them is exactly when an administrator's suspension lands.
  const admitted = await withTransaction(async (executor): Promise<AdmittedLogin | null> => {
    const resolved = await executor.query(
      `SELECT c.connection_id, c.connection_scope, c.tenant_id, c.issuer,
              c.provider_organization_id
         FROM identity_provider_connections c
        WHERE ${LOGIN_CONNECTION_ADMISSION_SQL}`,
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

    // The OBSERVATION grants nothing: it may create or refresh a PENDING claim so
    // an administrator has something to activate, and it never activates one.
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
  });
  if (admitted === null) return { admitted: false, refusal: 'identity_not_admitted' };
  return { admitted: true, identity: admitted };
}
