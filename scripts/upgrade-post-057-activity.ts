/**
 * FBL-020-R6-R6 §D1b — REALISTIC POST-057 ACTIVITY, GENERATED THROUGH THE
 * PRODUCTION CODE PATHS, SO THE UPGRADE DRILL CAN REACH THE COLUMNS 058
 * CONSTRAINS.
 *
 *   DATABASE_URL=... npx tsx scripts/upgrade-post-057-activity.ts \
 *     --out artifacts/post-057-activity.json [--log artifacts/post-057-activity.txt]
 *
 * WHY THIS FILE EXISTS, STATED AS THE DEFECT IT CLOSES. The populated upgrade
 * drill seeds `tests/fixtures/legacy-identity-seed-pre-057.sql` and then applies
 * the rest of the chain. That fixture is PRE-057 BY CONSTRUCTION: it predates
 * `policy_decisions.session_id` and `policy_decisions.auth_time`, so it cannot
 * express a decision that NAMES a session, and therefore cannot express any of
 * the states migration 058 §3.1 has an opinion about. The drill was green on a
 * database on which the rule under test was unreachable — the same "green for
 * nothing" shape as the gate's finding C1, one column over.
 *
 * A DRILL THAT CANNOT REACH THE COLUMNS 058 CONSTRAINS IS NOT EVIDENCE FOR 058.
 * So the drill now has a stage between 057 and 058, and this is it: a database
 * carrying 057 is USED — the way a real deployment between the two releases would
 * have used it — and only then is 058 applied.
 *
 * EVERYTHING HERE IS A PRODUCTION CODE PATH, and that is a hard requirement
 * rather than a preference. Activity assembled by hand-written INSERTs would
 * prove that 058 tolerates what THIS FILE chose to write; activity written by
 * `bootstrapIdentityOrigin`, `createSession`, `grantRole`, `revokeRole`,
 * `createPolicyEngine().decide()` and `refreshProviderSession` proves that 058
 * tolerates what the SHIPPED SYSTEM writes. Two further consequences:
 *
 *   * `scripts/**` is PRODUCTION code to `scripts/check-owned-mutations.ts`, so
 *     this file may not write an authorization-state row directly and does not:
 *     every write below goes through an attributed, versioned, audited service,
 *     and every statement in this file is a SELECT. It also may not import
 *     `@dealer/test-kit` (rule 5 of that guard), and does not.
 *   * The provider leg is the ONE thing that cannot be real here: there is no
 *     WorkOS to call. `refreshProviderSession` takes the provider port and the
 *     access-token verifier as REQUIRED INPUTS — "a fake port is a first-class
 *     caller" is its own documented contract — so the code path exercised is the
 *     shipped one, with the network replaced at the seam the shipped signature
 *     already exposes. Nothing else is stubbed.
 *
 * THE FOUR SHAPES R6-R6 §D1b NAMES, and why each one matters to 058:
 *
 *   1. VERSION-2 ALLOW DECISIONS NAMING LIVE SESSIONS — the rows 058 §3.1's
 *      pre-check counts. Without one, that pre-check is a query over zero rows.
 *   2. A PROVIDER RE-AUTHENTICATION THAT ADVANCES `auth_time` — the event that
 *      makes a stored decision's recorded authentication instant differ from its
 *      session's CURRENT one. `packages/identity-access/src/session.ts` advances
 *      `identity_sessions.auth_time` by design on re-authentication (the UPDATE's
 *      SET list, and the forward-only rule above it); this stage performs it.
 *   3. STORED EVIDENCE NAMING A SUPERSEDED BINDING VERSION — an ALLOW recorded
 *      against a binding, and THEN that binding revoked. `revokeRole` advances
 *      `authorization_version`, so the stored authority row now names a version
 *      BELOW the binding's current one. That is 058 §3.3's "not from the past"
 *      case, which is a rule about new writes and must NOT be a rule about
 *      history — and 058 has to apply cleanly over exactly this shape.
 *   4. A RE-GRANTED BINDING — the same actor, role and scope granted again after
 *      revocation. It is a SECOND row rather than a resurrection, which is what
 *      makes "the binding the old evidence names" and "the binding in force now"
 *      genuinely different rows.
 *
 * SHAPE 3 IS PRODUCED HERE, NOT MERELY DESCRIBED, AND THAT IS A CORRECTION. An
 * earlier revision of this file granted a binding, revoked it and re-granted it
 * WITHOUT ANY DECISION EVER NAMING IT: the revoked row was the `service_advisor`
 * grant of step 5, while the only stored evidence named the tenant_admin binding
 * the bootstrap left, whose version nothing advanced. So no stored authority row
 * named a superseded version, §3.3's history-tolerance case went unexercised, and
 * this comment claimed a shape the code did not write — the same
 * "documented but unreachable" defect §D1b was raised about, one table over.
 * Step 5 now records an ordinary version-2 ALLOW against the binding it is about
 * to revoke, and the census below ASSERTS the resulting shape exists.
 *
 * WHAT THIS FILE ASSERTS BEFORE IT EXITS 0. Producing the activity is not the
 * point; producing the STATE is. So the census below is checked, not merely
 * printed, and two assertions are load-bearing:
 * `auth_time_disagreeing_with_session` >= 1 — if the re-authentication did not
 * actually move `auth_time`, or the ALLOW did not actually name that session,
 * this stage FAILS instead of handing the next step a database that looks used
 * and is not; and `evidence_naming_a_superseded_binding_version` >= 1, which is
 * shape 3 measured in the table rather than asserted in a comment. Those are the
 * assertions whose absence made the old drill unfalsifiable.
 *
 * NOTHING SECRET IS PRINTED. Session tokens, refresh tokens and sealed state are
 * produced by the services this file calls and are never read back or logged;
 * the census is counts, ids and evidence versions.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { closePool, query } from '@dealer/database';
import { resolveServiceResourceScope } from '@dealer/fixed-ops';
import {
  bootstrapIdentityOrigin,
  createActionCatalog,
  createPolicyEngine,
  createSession,
  grantRole,
  refreshProviderSession,
  revokeRole,
  type ProviderRefreshResult,
  type VerifiedAccessToken,
} from '@dealer/identity-access';

/** The impersonation shape a non-impersonated provider reply carries. */
const NOT_IMPERSONATED = { impersonated: false, impersonatorEmailPresent: false } as const;

/**
 * A refresh credential and a sealing key that exist only inside this process.
 * They are never printed: the sealed state is a column the service writes, and
 * this stage reads counts back, never custody.
 */
const FIRST_REFRESH_TOKEN = 'post057-refresh-' + randomUUID();
const NEXT_REFRESH_TOKEN = 'post057-refresh-' + randomUUID();
const COOKIE_PASSWORD = randomUUID() + randomUUID();

interface Census {
  readonly decisions_total: number;
  readonly decisions_by_evidence_version: Record<string, number>;
  readonly decisions_naming_a_session: number;
  readonly normalized_binding_rows: number;
  readonly auth_time_disagreeing_with_session: number;
  readonly evidence_naming_a_superseded_binding_version: number;
  readonly bindings_total: number;
  readonly bindings_revoked: number;
}

/** Accepts both `--flag value` and `--flag=value`, so neither form silently no-ops. */
function arg(flag: string): string | undefined {
  const argv = process.argv;
  const i = argv.indexOf(flag);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  const joined = argv.find((a) => a.startsWith(flag + '='));
  return joined === undefined ? undefined : joined.slice(flag.length + 1);
}

async function scalar(sql: string, params: readonly unknown[] = []): Promise<number> {
  const r = await query(sql, params as unknown[]);
  return Number((r.rows[0] as { n: unknown }).n);
}

/**
 * THE PRECONDITION, CHECKED RATHER THAN ASSUMED. This stage is only meaningful
 * on a database that carries 057 and does NOT yet carry 058: its whole purpose is
 * to put rows in front of 058's pre-checks. Run after 058 it would silently
 * exercise the constraints instead of the history they must tolerate, and report
 * success for the wrong thing.
 */
async function assertBetween057And058(): Promise<void> {
  const hasSessionColumn = await scalar(
    `SELECT COUNT(*)::int AS n FROM information_schema.columns
      WHERE table_name = 'policy_decisions' AND column_name = 'session_id'`,
  );
  if (hasSessionColumn !== 1) {
    throw new Error(
      'post-057 activity refused: policy_decisions.session_id is absent, so migration 057 has ' +
        'not been applied and there is no post-057 database to exercise',
    );
  }
  const has058Trigger = await scalar(
    `SELECT COUNT(*)::int AS n FROM pg_trigger
      WHERE NOT tgisinternal AND tgname = 'trg_policy_decisions_auth_time'`,
  );
  if (has058Trigger !== 0) {
    throw new Error(
      'post-057 activity refused: trg_policy_decisions_auth_time already exists, so migration ' +
        '058 has ALREADY been applied. This stage must run BETWEEN 057 and 058 — running it ' +
        'afterwards would exercise the new constraints instead of the history they must tolerate',
    );
  }
}

async function census(): Promise<Census> {
  const versions = await query(
    `SELECT evidence_version::int AS v, COUNT(*)::int AS n
       FROM policy_decisions GROUP BY evidence_version ORDER BY evidence_version`,
  );
  const byVersion: Record<string, number> = {};
  for (const row of versions.rows as Array<{ v: number; n: number }>) {
    byVersion[String(row.v)] = Number(row.n);
  }
  return {
    decisions_total: await scalar(`SELECT COUNT(*)::int AS n FROM policy_decisions`),
    decisions_by_evidence_version: byVersion,
    decisions_naming_a_session: await scalar(
      `SELECT COUNT(*)::int AS n FROM policy_decisions WHERE session_id IS NOT NULL`,
    ),
    normalized_binding_rows: await scalar(
      `SELECT COUNT(*)::int AS n FROM policy_decision_matched_bindings`,
    ),
    // THE FIGURE THIS WHOLE STAGE EXISTS TO PRODUCE. It is exactly migration
    // 058 §3.1's original pre-check predicate, run here so the drill can state
    // the number the migration must tolerate rather than discovering it as an
    // abort.
    auth_time_disagreeing_with_session: await scalar(
      `SELECT COUNT(*)::int AS n
         FROM policy_decisions d
        WHERE d.session_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM identity_sessions s WHERE s.session_id = d.session_id)
          AND NOT EXISTS (SELECT 1 FROM identity_sessions s
                           WHERE s.session_id = d.session_id AND s.auth_time = d.auth_time)`,
    ),
    // SHAPE 3, MEASURED IN THE TABLE. Normalized authority rows whose recorded version is
    // BELOW the binding's current one — evidence taken before a revocation or a re-grant
    // advanced it. 058 §3.3 refuses this shape on a NEW write and must tolerate it as
    // history, so the drill has to carry it before 058 is applied.
    // role-binding-effectiveness-opt-out(all-bindings-including-ineffective): the join is
    // to the binding row by PRIMARY KEY to read the version it now carries — the revoked
    // ones are precisely the interesting half, and the shared effectiveness predicate
    // would hide them. It counts rows and decides nothing about what any binding
    // authorizes.
    evidence_naming_a_superseded_binding_version: await scalar(
      `SELECT COUNT(*)::int AS n
         FROM policy_decision_matched_bindings m
         JOIN role_bindings rb ON rb.role_binding_id = m.role_binding_id
        WHERE m.authorization_version < rb.authorization_version`,
    ),
    // role-binding-effectiveness-opt-out(all-bindings-including-ineffective): this CENSUS
    // counts rows and classifies them; it decides nothing about what any binding authorizes.
    // Resolving the shared predicate would return the effective bindings alone, and the
    // figure this stage exists to assert is precisely how many are REVOKED — which the
    // effectiveness filter would hide.
    bindings_total: await scalar(`SELECT COUNT(*)::int AS n FROM role_bindings`),
    // role-binding-effectiveness-opt-out(all-bindings-including-ineffective): the figure
    // this stage exists to assert is precisely how many bindings are REVOKED, which the
    // shared effectiveness predicate would hide by returning the effective ones alone. It
    // counts rows and decides nothing about what any binding authorizes.
    bindings_revoked: await scalar(
      `SELECT COUNT(*)::int AS n FROM role_bindings WHERE status = 'revoked'`,
    ),
  };
}

async function main(): Promise<void> {
  const outPath = arg('--out');
  const logPath = arg('--log');
  const lines: string[] = [];
  const say = (text: string): void => {
    lines.push(text);
    console.log(text);
  };

  await assertBetween057And058();
  say('post-057 activity: the database carries 057 and not 058 — proceeding');

  // ── 1. A REAL TENANT IDENTITY ORIGIN, through the sanctioned service ──────
  //
  // `bootstrapIdentityOrigin` is the ONLY sanctioned way to mint a first tenant
  // administrator, and it writes the tenant, the provider connection, the
  // activated administrator link and that link's tenant-scope grant inside ONE
  // attributed transaction. Using it here means the identity chain this stage
  // exercises 058 against is the chain an operator's own bootstrap produces.
  const tenantId = randomUUID();
  const issuer = 'https://post-057-drill.authkit.local';
  const providerOrganizationId = 'org_post057_' + randomUUID().replace(/-/g, '').slice(0, 16);
  const adminProviderUserId = 'user_post057_' + randomUUID().replace(/-/g, '').slice(0, 16);
  const steps = await bootstrapIdentityOrigin({
    tenantId,
    tenantName: 'Post-057 Drill Motors',
    providerOrganizationId,
    issuer,
    adminProviderUserId,
    adminEmail: null,
    apply: true,
  });
  say(`bootstrap: ${steps.map((s) => `${s.step}=${s.action}`).join(' ')}`);

  const origin = await query(
    `SELECT ul.user_link_id, ul.connection_id, ul.issuer, ul.provider_organization_id,
            ul.provider_user_id
       FROM user_links ul
      WHERE ul.tenant_id = $1 AND ul.provider_user_id = $2 AND ul.status = 'activated'`,
    [tenantId, adminProviderUserId],
  );
  if (origin.rows.length !== 1) {
    throw new Error('post-057 activity: the bootstrap did not leave exactly one activated link');
  }
  const admin = origin.rows[0] as Record<string, unknown>;
  const adminLinkId = String(admin.user_link_id);
  const connectionId = String(admin.connection_id);
  const providerSubject = String(admin.provider_user_id);

  // role-binding-effectiveness-opt-out(all-bindings-including-ineffective): an EXISTENCE
  // probe against the row `bootstrapIdentityOrigin` just wrote, not an authorization read.
  // It asks "did the bootstrap leave its grant", and `status = 'active'` here means "not
  // revoked". The effective WINDOW is deliberately not consulted: a grant whose window has
  // not opened is still the grant the bootstrap created, and this stage records its id so
  // the emulated 057-era ALLOW can name it.
  const bindingRow = await query(
    `SELECT rb.role_binding_id FROM role_bindings rb
      WHERE rb.tenant_id = $1 AND rb.user_link_id = $2 AND rb.scope_level = 'tenant'
        AND rb.status = 'active'`,
    [tenantId, adminLinkId],
  );
  if (bindingRow.rows.length !== 1) {
    throw new Error('post-057 activity: the bootstrap did not leave exactly one tenant grant');
  }
  const adminBindingId = String((bindingRow.rows[0] as Record<string, unknown>).role_binding_id);

  // ── 2. A REFRESHABLE SESSION, through the session service ─────────────────
  //
  // `refreshToken` + `cookiePassword` are what put a provider refresh credential
  // into custody, and custody is what makes step 4 reachable at all: a session
  // holding no sealed refresh state can never be re-authenticated.
  const providerSessionId = 'sid_post057_' + randomUUID().replace(/-/g, '').slice(0, 12);
  const establishedAuthTime = new Date(Date.now() - 3_600_000);
  const created = await createSession({
    tenantId,
    userLinkId: adminLinkId,
    connectionId,
    issuer,
    providerSubject,
    providerOrganizationId,
    providerSessionId,
    authTime: establishedAuthTime,
    ttlSeconds: 3600,
    refreshToken: FIRST_REFRESH_TOKEN,
    cookiePassword: COOKIE_PASSWORD,
  });
  const sessionId = created.session.sessionId;
  say(`session established: ${sessionId} (auth_time ${establishedAuthTime.toISOString()})`);

  // ── 3. VERSION-2 ALLOW DECISIONS NAMING THAT LIVE SESSION ─────────────────
  //
  // THE ONE PLACE THIS STAGE DOES NOT USE THE CURRENT WRITER, AND THE REASON IS
  // THE POINT OF THE STAGE. The rows 058 must tolerate are the rows a deployment
  // wrote BETWEEN the 057 and 058 releases, and such a deployment ran the code of
  // the 057 release, whose `CURRENT_EVIDENCE_VERSION` was 2. Today's `record()`
  // writes 3 — the version 058 introduces — and on a 057-only schema
  // `pd_evidence_version_known CHECK (evidence_version IN (1, 2))` REFUSES it. So
  // calling today's engine here would not simulate the history; it would fail, and
  // it would fail for a reason that has nothing to do with what is under test.
  // (That is not a rolling-upgrade defect: this system migrates and then starts, so
  // the version-3 writer never runs against a 057-only schema in production.)
  //
  // The statement below is therefore the 057-era writer, EMULATED, and it is the
  // same technique `tests/fixtures/legacy-identity-seed-pre-057.sql` uses for the
  // pre-057 era — the accepted way this repository expresses history whose writer
  // no longer exists. It mirrors `record()` exactly where it matters: `auth_time`
  // is READ OUT OF THE NAMED SESSION INSIDE THE INSERT rather than sent as a
  // parameter, so the row starts life agreeing with its session, which is what
  // makes step 4's advance the thing that breaks the agreement. `policy_decisions`
  // carries no `authorization_version`, so it is not an owned table and this write
  // is not a bypass of the owned-mutation boundary; the normalized child rows are
  // still derived by 057's own trigger, inside the database.
  //
  // Everything else in this file — and the ENGINE itself, in the `after-058` stage
  // — is the shipped writer.
  //
  // It is a FUNCTION rather than an inline statement because step 5 needs the same
  // 057-era row against a DIFFERENT binding — the one it is about to revoke — and two
  // copies of this INSERT would be two things to keep in agreement.
  const recordEmulated057Allow = async (action: string, bindingId: string): Promise<string> => {
    // role-binding-effectiveness-opt-out(all-bindings-including-ineffective): this reads the
    // binding's CURRENT version by PRIMARY KEY so the emulated 057-era row records the version
    // the decision observed. It is a lookup on a row this stage just created through the
    // sanctioned bootstrap or the sanctioned grant service, and it decides nothing: the
    // authority was decided there, not here.
    const written = await query(
      `INSERT INTO policy_decisions
         (tenant_id, actor_user_link_id, actor_type, action, decision, reason_code,
          policy_version, request_id, correlation_id, scope_level, scope_id, session_id,
          connection_id, actor_provider_subject, matched_role_binding_ids,
          matched_authorization_versions, freshness_classification,
          mfa_assurance_classification, auth_time, evidence_version)
       SELECT $1, $2, 'user', $3, 'allow', 'ALLOW_ROLE_BINDING', 'fbl-020.1', $4, $5,
              'tenant', $1, $6, $7, $8,
              ARRAY[rb.role_binding_id]::uuid[], ARRAY[rb.authorization_version]::bigint[],
              'stale', 'uncertified',
              (SELECT s.auth_time FROM identity_sessions s WHERE s.session_id = $6),
              2
         FROM role_bindings rb
        WHERE rb.role_binding_id = $9
       RETURNING decision_id`,
      [
        tenantId,
        adminLinkId,
        action,
        'req_' + randomUUID(),
        'corr_' + randomUUID(),
        sessionId,
        connectionId,
        providerSubject,
        bindingId,
      ],
    );
    if (written.rows.length !== 1) {
      throw new Error(`post-057 activity: the ${action} ALLOW was not recorded`);
    }
    return String((written.rows[0] as Record<string, unknown>).decision_id);
  };

  const allowed: string[] = [];
  for (const action of ['service.ro.view', 'service.appointment.view']) {
    allowed.push(await recordEmulated057Allow(action, adminBindingId));
  }
  say(`recorded ${allowed.length} version-2 ALLOW(s) naming session ${sessionId}`);

  // ── 4. A PROVIDER RE-AUTHENTICATION THAT ADVANCES auth_time ───────────────
  //
  // This is the event the old drill could not express and 058 was written as
  // though the repository could not perform. The verifier returns a GENUINELY
  // NEWER `auth_time`, which is the only thing the session service allows to move
  // the column forward; the port is the injected seam the shipped signature
  // already requires.
  const reauthenticatedAt = new Date(Date.now() + 1_000);
  const refreshOutcome = await refreshProviderSession({
    sessionId,
    provider: {
      refreshSession: (): Promise<ProviderRefreshResult> =>
        Promise.resolve({
          accessToken: 'post057.access.token',
          refreshToken: NEXT_REFRESH_TOKEN,
          providerUserId: providerSubject,
          providerSessionId,
          organizationId: providerOrganizationId,
          impersonation: NOT_IMPERSONATED,
        }),
    },
    cookiePassword: COOKIE_PASSWORD,
    expectedIssuer: issuer,
    ttlSeconds: 3600,
    verifyAccessToken: (): Promise<VerifiedAccessToken> =>
      Promise.resolve({
        providerUserId: providerSubject,
        providerSessionId,
        organizationId: providerOrganizationId,
        // STRICTLY LATER than the instant the session was established with, so
        // the forward-only rule advances the column instead of preserving it.
        authTime: reauthenticatedAt,
        issuedAt: new Date(),
        expiresAt: new Date(Date.now() + 300_000),
        roleHints: [],
        nonceDigest: null,
        impersonation: NOT_IMPERSONATED,
      }),
  });
  if (refreshOutcome.outcome !== 'refreshed') {
    throw new Error(
      `post-057 activity: the provider re-authentication came back '${refreshOutcome.outcome}' — ` +
        'the stage requires a session whose auth_time really advanced',
    );
  }
  // ADVANCED IS READ OFF THE ROTATED ROW, not inferred from the call returning.
  // The forward-only rule keeps the OLD instant whenever the verified one is not
  // strictly newer, so "the refresh succeeded" and "auth_time moved" are two
  // different facts and only the second one creates the state this stage is for.
  if (refreshOutcome.session.authTime.getTime() <= establishedAuthTime.getTime()) {
    throw new Error(
      'post-057 activity: the re-authentication did not advance auth_time, so the state this ' +
        'stage exists to create was not created',
    );
  }
  say(
    `provider re-authentication advanced auth_time to ` +
      `${refreshOutcome.session.authTime.toISOString()} ` +
      `(rotation ${String(refreshOutcome.rotationCount)})`,
  );

  // ── 5. EVIDENCE AGAINST A BINDING, THEN THAT BINDING REVOKED, THEN RE-GRANTED ──
  //
  // All three through the attributed mutation services, so each advances
  // `authorization_version` and leaves its own audit event.
  //
  // THE ORDER IS THE WHOLE POINT, and an earlier revision had it wrong. Revoking a
  // binding NO DECISION EVER NAMED advances a version nothing recorded, and leaves
  // every stored authority row still naming its binding's CURRENT version — so 058
  // §3.3's history-tolerance case was documented here and never produced. The ALLOW
  // below is recorded against `extra` BEFORE `extra` is revoked, so afterwards the
  // stored normalized row names a version the binding has been moved out of. That is
  // the shape 058 §3.3 refuses on a NEW write and must tolerate as history, and the
  // census at the end of this stage FAILS if it is not there.
  //
  // It is recorded AFTER the re-authentication of step 4 deliberately: `auth_time` is
  // read out of the session inside the INSERT, so this row agrees with its session
  // and the §3.1 exempt population stays exactly the two ALLOWs of step 3.
  const extra = await grantRole({
    actingUserLinkId: adminLinkId,
    tenantId,
    userLinkId: adminLinkId,
    role: 'service_advisor',
    scopeLevel: 'tenant',
    scopeId: tenantId,
    resourceType: null,
    resourceId: null,
  });
  const supersededEvidence = await recordEmulated057Allow(
    'service.estimate.view',
    extra.roleBindingId,
  );
  const revoked = await revokeRole({
    actingUserLinkId: adminLinkId,
    roleBindingId: extra.roleBindingId,
  });
  if (revoked === null) {
    throw new Error('post-057 activity: the binding this stage granted could not be revoked');
  }
  const regranted = await grantRole({
    actingUserLinkId: adminLinkId,
    tenantId,
    userLinkId: adminLinkId,
    role: 'service_advisor',
    scopeLevel: 'tenant',
    scopeId: tenantId,
    resourceType: null,
    resourceId: null,
  });
  if (regranted.roleBindingId === extra.roleBindingId) {
    throw new Error(
      'post-057 activity: the re-grant reused the revoked binding row, so "the binding the old ' +
        'evidence names" and "the binding in force now" are not distinct rows',
    );
  }
  say(
    `binding revoked (${extra.roleBindingId}) after decision ${supersededEvidence} recorded ` +
      `authority against it, and re-granted as a NEW row (${regranted.roleBindingId})`,
  );

  // ── 6. THE STATE, ASSERTED ────────────────────────────────────────────────
  const counts = await census();
  const failures: string[] = [];
  if (counts.decisions_naming_a_session < 2) {
    failures.push(
      `only ${counts.decisions_naming_a_session} decision(s) name a session; the stage must leave at least 2`,
    );
  }
  if ((counts.decisions_by_evidence_version['2'] ?? 0) < 2) {
    failures.push('fewer than 2 version-2 decisions were recorded');
  }
  if (counts.normalized_binding_rows < 2) {
    failures.push('the 057 normalizer left fewer than 2 normalized authority rows');
  }
  if (counts.auth_time_disagreeing_with_session < 1) {
    failures.push(
      'NO stored decision records an authentication time that differs from its session’s ' +
        'CURRENT one — this stage exists to create exactly that state, and without it the 058 ' +
        'application that follows proves nothing about §3.1',
    );
  }
  if (counts.bindings_revoked < 1) {
    failures.push('no revoked binding was left behind');
  }
  if (counts.evidence_naming_a_superseded_binding_version < 1) {
    failures.push(
      'NO stored authority row names a binding version BELOW the one that binding now ' +
        'carries — this stage claims to produce 058 §3.3’s history-tolerance shape, and a ' +
        'revocation nothing recorded evidence against does not produce it',
    );
  }
  const result = failures.length === 0 ? 'OK' : 'FAILED';
  for (const failure of failures) say('post-057 activity FAILURE: ' + failure);
  say(
    `post-057 activity census: ${counts.decisions_total} decision(s), ` +
      `${counts.decisions_naming_a_session} naming a session, ` +
      `${counts.normalized_binding_rows} normalized authority row(s), ` +
      `${counts.auth_time_disagreeing_with_session} whose recorded auth_time is no longer their ` +
      `session's, ${counts.evidence_naming_a_superseded_binding_version} naming a superseded ` +
      `binding version, ${counts.bindings_revoked} revoked binding(s)`,
  );
  say(`post-057 activity result: ${result}`);

  const report = {
    generator: 'scripts/upgrade-post-057-activity.ts',
    order: 'FBL-020-R6-R6 §D1b',
    stage: 'between (after migration 057, before 058)',
    tenant_id: tenantId,
    admin_user_link_id: adminLinkId,
    session_id: sessionId,
    session_auth_time_advanced_to: refreshOutcome.session.authTime.toISOString(),
    allow_decision_ids: allowed,
    superseded_version_decision_id: supersededEvidence,
    revoked_role_binding_id: extra.roleBindingId,
    regranted_role_binding_id: regranted.roleBindingId,
    census: counts,
    failures,
    result,
  };
  write(outPath, logPath, report, lines);
  if (result !== 'OK') process.exitCode = 1;
}

/**
 * STAGE `after-058` — THE SHIPPED POLICY ENGINE, AGAINST THE UPGRADED DATABASE.
 *
 * The `between` stage above has to emulate the 057-era writer for its ALLOW rows,
 * because today's writer emits `evidence_version` 3 and a 057-only schema forbids
 * it. That is correct for producing HISTORY and it would be a hole if it were the
 * only thing the drill did, because nothing would then have exercised the CURRENT
 * writer against the CURRENT schema on the upgrade path.
 *
 * So this stage runs after 058 and drives `createPolicyEngine().decide()` for real,
 * against the same tenant, actor and SESSION the `between` stage left behind — the
 * session whose `auth_time` has since advanced. It asserts three things:
 *
 *   1. the decision is an ALLOW (the engine still authorizes normally after the
 *      upgrade — a migration that broke authorization would otherwise look fine);
 *   2. the row it wrote is at `evidence_version` 3, so the floor 058 raised is the
 *      version production actually writes and not just a number in a CHECK;
 *   3. its recorded `auth_time` EQUALS the named session's CURRENT value — i.e. the
 *      §3.1 binding is satisfied by the shipped writer, on a session that has
 *      re-authenticated since the exempt history beside it was written.
 *
 * Nothing here is rolled back: this is real post-upgrade activity, and the row it
 * leaves is part of what the fingerprint comparison and the health check then run
 * against.
 */
async function afterMigration058(outPath: string | undefined, logPath: string | undefined) {
  const lines: string[] = [];
  const say = (text: string): void => {
    lines.push(text);
    console.log(text);
  };

  const has058Trigger = await scalar(
    `SELECT COUNT(*)::int AS n FROM pg_trigger
      WHERE NOT tgisinternal AND tgname = 'trg_policy_decisions_auth_time'`,
  );
  if (has058Trigger !== 1) {
    throw new Error(
      'after-058 activity refused: trg_policy_decisions_auth_time is absent, so migration 058 has ' +
        'not been applied and there is nothing for this stage to exercise',
    );
  }

  // The identity the `between` stage established, found by the marks it left. Read
  // back from the database rather than passed in, so this stage fails loudly if the
  // earlier one did not actually run.
  const actor = (
    await query(
      `SELECT ul.user_link_id, ul.tenant_id, s.session_id
       FROM user_links ul
       JOIN identity_sessions s ON s.user_link_id = ul.user_link_id
      WHERE ul.provider_user_id LIKE 'user_post057_%' AND ul.status = 'activated'
        AND s.revoked_at IS NULL AND s.expires_at > NOW()
      ORDER BY s.issued_at DESC LIMIT 1`,
    )
  ).rows as Array<Record<string, unknown>>;
  if (actor.length !== 1) {
    throw new Error(
      'after-058 activity refused: the `between` stage left no live session for its administrator, ' +
        'so the post-057 activity stage did not run against this database',
    );
  }
  const userLinkId = String((actor[0] as Record<string, unknown>).user_link_id);
  const tenantId = String((actor[0] as Record<string, unknown>).tenant_id);
  const sessionId = String((actor[0] as Record<string, unknown>).session_id);

  const engine = createPolicyEngine({
    catalog: createActionCatalog([
      {
        action: 'service.ro.view',
        description: 'read a repair order',
        resourceType: null,
        allowedRoles: ['tenant_admin'],
      },
    ]),
    // The action names no resource, so the resolver is never consulted.
    resolveResourceScope: () => Promise.resolve(null),
  });
  const outcome = await engine.decide({
    actor: { userLinkId, actorScope: 'dealership', tenantId },
    action: 'service.ro.view',
    sessionId,
  });

  const failures: string[] = [];
  if (outcome.decision !== 'allow') {
    failures.push(
      `the engine returned ${outcome.decision} (${outcome.reasonCode}) after the upgrade — a ` +
        'migration that broke ordinary authorization must not pass this drill',
    );
  }
  const written = (
    await query(
      `SELECT d.evidence_version::int AS evidence_version,
            (d.auth_time = s.auth_time) AS binds_its_session,
            (d.session_id = $2) AS names_the_session
       FROM policy_decisions d JOIN identity_sessions s ON s.session_id = d.session_id
      WHERE d.decision_id = $1`,
      [outcome.decisionId, sessionId],
    )
  ).rows as Array<Record<string, unknown>>;
  if (written.length !== 1) {
    failures.push('the decision the engine reported is not readable beside its session');
  } else {
    const row = written[0] as Record<string, unknown>;
    if (Number(row.evidence_version) !== 3) {
      failures.push(
        `the engine wrote evidence_version ${String(row.evidence_version)}; after 058 the shipped ` +
          'writer must write 3, which is the version whose requirements it now meets',
      );
    }
    if (row.names_the_session !== true) {
      failures.push('the engine did not record the session the request presented');
    }
    if (row.binds_its_session !== true) {
      failures.push(
        'the engine recorded an authentication time that is NOT its named session’s current one, ' +
          'on a session that has re-authenticated — §3.1 is satisfied by construction or not at all',
      );
    }
  }

  const result = failures.length === 0 ? 'OK' : 'FAILED';
  for (const failure of failures) say('after-058 activity FAILURE: ' + failure);
  const counts = await census();
  say(
    `after-058 activity: the shipped engine wrote decision ${outcome.decisionId} ` +
      `(${outcome.decision}/${outcome.reasonCode}); versions now ` +
      `${JSON.stringify(counts.decisions_by_evidence_version)}`,
  );
  say(`after-058 activity result: ${result}`);

  write(
    outPath,
    logPath,
    {
      generator: 'scripts/upgrade-post-057-activity.ts',
      order: 'FBL-020-R6-R6 §D1b',
      stage: 'after-058 (the shipped engine against the upgraded database)',
      tenant_id: tenantId,
      session_id: sessionId,
      decision_id: outcome.decisionId,
      decision: outcome.decision,
      reason_code: outcome.reasonCode,
      census: counts,
      failures,
      result,
    },
    lines,
  );
  if (result !== 'OK') process.exitCode = 1;
}

/**
 * STAGE `after-059` — THE SHIPPED ENGINE, AS THE RUNTIME ROLE, AGAINST 059.
 *
 * FBL-020-R7 §4.4's half of the drill: after 059 is applied on the used database,
 * the CURRENT writer must still be the thing that satisfies the new rules — not a
 * probe. This stage therefore drives `createPolicyEngine().decide()` on a REAL
 * Fixed Ops resource, with THE REAL resolver (`resolveServiceResourceScope`, which
 * now reads migration 059's `resource_org_leaf` registry), and it does so AS THE
 * RUNTIME ROLE: the process must be started with
 * `DATABASE_RUNTIME_ROLE=dealership_runtime`, so every statement in it runs under
 * the role production runs under — the one that CANNOT write the normalized child
 * table itself (§3.7). It asserts:
 *
 *   1. the connection really is the runtime role (`current_user`), so the stage
 *      cannot silently prove superuser behavior;
 *   2. the decision is an ALLOW at `evidence_version` 4 — the DEFAULT the schema
 *      now owns, on an INSERT that deliberately omits the column;
 *   3. the persisted `resource_rooftop_id` equals the database's OWN resolution of
 *      the resource — the §3.4 snapshot, written by the trigger, not the caller;
 *   4. its recorded `auth_time` still EQUALS the named session's current value;
 *   5. the matched-binding array was NORMALIZED into child rows even though the
 *      writing role holds no INSERT on that table — §3.7's database-owned
 *      SECURITY DEFINER path, exercised by the production writer on the upgraded
 *      database.
 */
async function afterMigration059(outPath: string | undefined, logPath: string | undefined) {
  const lines: string[] = [];
  const say = (text: string): void => {
    lines.push(text);
    console.log(text);
  };

  const has059Trigger = await scalar(
    `SELECT COUNT(*)::int AS n FROM pg_trigger
      WHERE NOT tgisinternal AND tgname = 'trg_policy_decisions_v4_structure'`,
  );
  if (has059Trigger !== 1) {
    throw new Error(
      'after-059 activity refused: trg_policy_decisions_v4_structure is absent, so migration ' +
        '059 has not been applied and there is nothing for this stage to exercise',
    );
  }

  const connectedAs = ((await query(`SELECT current_user AS u`)).rows[0] as { u: unknown }).u;
  if (String(connectedAs) !== 'dealership_runtime') {
    throw new Error(
      `after-059 activity refused: connected as ${String(connectedAs)} — this stage exists to ` +
        'prove the PRODUCTION role writes v4 evidence, so it must run with ' +
        'DATABASE_RUNTIME_ROLE=dealership_runtime (the pool then assumes the runtime role at ' +
        'connection startup, exactly as production does)',
    );
  }
  say('after-059 activity: connected as dealership_runtime');

  const actor = (
    await query(
      `SELECT ul.user_link_id, ul.tenant_id, s.session_id
       FROM user_links ul
       JOIN identity_sessions s ON s.user_link_id = ul.user_link_id
      WHERE ul.provider_user_id LIKE 'user_post057_%' AND ul.status = 'activated'
        AND s.revoked_at IS NULL AND s.expires_at > NOW()
      ORDER BY s.issued_at DESC LIMIT 1`,
    )
  ).rows as Array<Record<string, unknown>>;
  if (actor.length !== 1) {
    throw new Error(
      'after-059 activity refused: the `between` stage left no live session for its ' +
        'administrator, so the earlier drill stages did not run against this database',
    );
  }
  const userLinkId = String((actor[0] as Record<string, unknown>).user_link_id);
  const tenantId = String((actor[0] as Record<string, unknown>).tenant_id);
  const sessionId = String((actor[0] as Record<string, unknown>).session_id);

  // A REAL Fixed Ops resource of this tenant, and the rooftop the DATABASE says it
  // lives under — read through the same one registry the trigger uses.
  const ro = (
    await query(
      `SELECT ro_id, location_id FROM repair_orders WHERE tenant_id = $1
        ORDER BY ro_id LIMIT 1`,
      [tenantId],
    )
  ).rows as Array<Record<string, unknown>>;
  if (ro.length !== 1) {
    throw new Error(
      'after-059 activity refused: the drill database holds no repair order for the drill ' +
        'tenant, so the §3.4 resource path cannot be exercised against a real resource',
    );
  }
  const roId = String((ro[0] as Record<string, unknown>).ro_id);
  const roRooftop = String((ro[0] as Record<string, unknown>).location_id);

  const engine = createPolicyEngine({
    catalog: createActionCatalog([
      {
        action: 'service.ro.view',
        description: 'read a repair order',
        resourceType: 'repair_order',
        allowedRoles: ['tenant_admin'],
      },
    ]),
    // THE REAL RESOLVER — the one production wires in — which now resolves
    // through migration 059's `resource_org_leaf`, the same authority the
    // evidence trigger validates the snapshot against.
    resolveResourceScope: resolveServiceResourceScope,
  });
  const outcome = await engine.decide({
    actor: { userLinkId, actorScope: 'dealership', tenantId },
    action: 'service.ro.view',
    sessionId,
    resource: { type: 'repair_order', id: roId },
  });

  const failures: string[] = [];
  if (outcome.decision !== 'allow') {
    failures.push(
      `the engine returned ${outcome.decision} (${outcome.reasonCode}) after 059 — a ` +
        'migration that broke ordinary authorization must not pass this drill',
    );
  }
  const written = (
    await query(
      `SELECT d.evidence_version::int AS evidence_version,
              d.resource_rooftop_id::text AS resource_rooftop_id,
              (d.auth_time = s.auth_time) AS binds_its_session,
              (d.session_id = $2) AS names_the_session,
              cardinality(d.matched_role_binding_ids)::int AS array_len,
              (SELECT COUNT(*)::int FROM policy_decision_matched_bindings c
                WHERE c.decision_id = d.decision_id) AS normalized_rows
       FROM policy_decisions d JOIN identity_sessions s ON s.session_id = d.session_id
      WHERE d.decision_id = $1`,
      [outcome.decisionId, sessionId],
    )
  ).rows as Array<Record<string, unknown>>;
  if (written.length !== 1) {
    failures.push('the decision the engine reported is not readable beside its session');
  } else {
    const row = written[0] as Record<string, unknown>;
    if (Number(row.evidence_version) !== 4) {
      failures.push(
        `the engine wrote evidence_version ${String(row.evidence_version)}; after 059 the ` +
          'schema DEFAULT is 4 and the writer omits the column, so anything else means the ' +
          'writer and the schema disagree about what current evidence is',
      );
    }
    if (String(row.resource_rooftop_id) !== roRooftop) {
      failures.push(
        `the decision's resource_rooftop_id is ${String(row.resource_rooftop_id)}, and the ` +
          `database's own resolution of the resource is ${roRooftop} — the §3.4 snapshot must ` +
          'be the validated leaf',
      );
    }
    if (row.names_the_session !== true) {
      failures.push('the engine did not record the session the request presented');
    }
    if (row.binds_its_session !== true) {
      failures.push(
        'the engine recorded an authentication time that is NOT its named session’s current ' +
          'one — §3.1 must hold for the v4 writer exactly as it did for v3',
      );
    }
    if (Number(row.array_len) < 1) {
      failures.push('the ALLOW claims no matched binding, so §3.7’s path was not exercised');
    } else if (Number(row.normalized_rows) !== Number(row.array_len)) {
      failures.push(
        `the array names ${String(row.array_len)} binding(s) but ${String(row.normalized_rows)} ` +
          'normalized child row(s) exist — the SECURITY DEFINER normalization did not run for ' +
          'the runtime role, so §3.7’s database-owned write path is broken',
      );
    }
  }

  const result = failures.length === 0 ? 'OK' : 'FAILED';
  for (const failure of failures) say('after-059 activity FAILURE: ' + failure);
  const counts = await census();
  say(
    `after-059 activity: the shipped engine wrote decision ${outcome.decisionId} ` +
      `(${outcome.decision}/${outcome.reasonCode}) as dealership_runtime; versions now ` +
      `${JSON.stringify(counts.decisions_by_evidence_version)}`,
  );
  say(`after-059 activity result: ${result}`);

  write(
    outPath,
    logPath,
    {
      generator: 'scripts/upgrade-post-057-activity.ts',
      order: 'FBL-020-R7 §4.4',
      stage: 'after-059 (the shipped engine, as the runtime role, against 059)',
      tenant_id: tenantId,
      session_id: sessionId,
      decision_id: outcome.decisionId,
      decision: outcome.decision,
      reason_code: outcome.reasonCode,
      resource_id: roId,
      resource_rooftop_id: roRooftop,
      census: counts,
      failures,
      result,
    },
    lines,
  );
  if (result !== 'OK') process.exitCode = 1;
}

function write(
  outPath: string | undefined,
  logPath: string | undefined,
  report: unknown,
  lines: readonly string[],
): void {
  if (outPath !== undefined) {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');
  }
  if (logPath !== undefined) {
    mkdirSync(dirname(logPath), { recursive: true });
    writeFileSync(logPath, lines.join('\n') + '\n');
  }
}

/**
 * FAIL CLOSED ON THE STAGE. A default would let a mis-typed flag run the wrong half
 * of the drill and report a pass — the same failure shape `verify-upgrade-state.ts`
 * refuses for `--phase`.
 */
const stage = arg('--stage') ?? 'between';
if (stage !== 'between' && stage !== 'after-058' && stage !== 'after-059') {
  console.error(
    'usage: upgrade-post-057-activity.ts [--stage=between|after-058|after-059] [--out f] [--log f]',
  );
  process.exit(2);
}

(stage === 'between'
  ? main()
  : stage === 'after-058'
    ? afterMigration058(arg('--out'), arg('--log'))
    : afterMigration059(arg('--out'), arg('--log'))
)
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
