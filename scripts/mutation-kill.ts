/**
 * FBL-020-R4 §7, extended by FBL-020-R5 §1 and §3 — TARGETED MUTATION-KILL CHECKS, IN AN
 * ISOLATED COPY OF THE TREE.
 *
 *   TEST_DATABASE_URL=… npx tsx scripts/mutation-kill.ts \
 *     --out artifacts/mutation-kill.json --log artifacts/mutation-kill.txt
 *
 * ── WHY ─────────────────────────────────────────────────────────────────────
 *
 * R3's review found a test that still PASSED with a security predicate deleted. A
 * green suite is therefore not, on its own, evidence that the suite is holding
 * anything: a test can assert around a control instead of asserting the control.
 *
 * This runner removes the doubt mechanically. For each named control it:
 *   1. copies the working tree into a temporary directory (node_modules is shared
 *      read-only via a link; `@dealer/*` resolves through tsconfig `paths`, so it
 *      resolves INTO the copy — asserted, not assumed);
 *   2. runs the declared test file UNMUTATED and requires it to PASS, so a battery
 *      that is already broken cannot "kill" anything;
 *   3. applies ONE exact source edit that removes or weakens the control;
 *   4. re-runs the same test file and requires it to FAIL, with the DECLARED test
 *      name among the failures;
 *   5. restores the file and moves on.
 *
 * A mutation that SURVIVES — the suite still green with the control gone — is a
 * FAILED check and this runner exits non-zero. The working tree is never modified:
 * every edit happens in the copy, and the original file's digest is re-checked after
 * each mutation.
 *
 * ── WHAT IS AND IS NOT COVERED HERE ────────────────────────────────────────
 *
 * These are controls in TypeScript sources — the application packages and the
 * migration RUNNER. Reconciliation inside a migration BODY is proved load-bearing by
 * `scripts/upgrade-negative-controls.ts` instead, because a mutated migration cannot
 * change a database that has already been migrated — removing a statement from 057 and
 * re-running the suite would prove nothing. The two runners are complementary and both
 * gate CI.
 */
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

export interface Mutation {
  id: string;
  /** The control the mutation removes, in one sentence. */
  control: string;
  /** Repository-relative path of the file to edit. */
  file: string;
  /** Exact text to replace; must occur EXACTLY ONCE in the file. */
  from: string;
  /** The weakened replacement. */
  to: string;
  /** The battery that must fail. */
  testFile: string;
  /** The test name that must be among the failures. */
  testName: string;
}

export const MUTATIONS: Mutation[] = [
  {
    id: 'role_binding_effectiveness_ignored',
    control:
      'a role binding authorizes only inside its effective window; status alone is not authority',
    file: 'packages/identity-access/src/policy.ts',
    from:
      "export const EFFECTIVE_ROLE_BINDING_SQL = `rb.status = 'active'\n" +
      '        AND rb.effective_from <= NOW()\n' +
      '        AND (rb.effective_to IS NULL OR rb.effective_to > NOW())`;',
    to: "export const EFFECTIVE_ROLE_BINDING_SQL = `rb.status = 'active'`;",
    testFile: 'tests/policy.test.ts',
    testName:
      'a LIVE support session stops authorizing when the actor binding ages out of its window',
  },
  {
    id: 'mfa_certification_never_expires',
    control: 'an MFA-policy certification counts only while it is inside its validity deadline',
    file: 'packages/identity-access/src/contracts.ts',
    from:
      '   AND c.mfa_policy_certification_expires_at IS NOT NULL\n' +
      '   AND c.mfa_policy_certification_expires_at > NOW()\n' +
      '  )`;',
    to: '  )`;',
    testFile: 'tests/identity-lifecycle-audit.test.ts',
    testName: 'MFA certification fails CLOSED when false, missing, expired or revoked',
  },
  {
    id: 'pending_link_admitted',
    control: 'only an ACTIVATED user link may be admitted at login',
    file: 'packages/identity-access/src/login-admission.ts',
    from: "        AND ul.status = 'activated'",
    to: "        AND ul.status IN ('activated', 'pending')",
    testFile: 'tests/login-admission.test.ts',
    // NOT the pre-existing 'refuses a PENDING link' test: that one's pending link is
    // created UNBOUND by the observation, so the binding clause refuses it whatever its
    // status, and this mutation SURVIVED against it. The test named here was added in
    // R4 §7 for exactly that reason — a bound pending link, the shape migration 057 §1
    // produces — and it is the one that dies.
    testName: 'a BOUND but PENDING link is refused — binding is provenance, not authority',
  },
  {
    id: 'client_request_id_adopted',
    control: 'the request id in policy evidence is server-generated; a caller can never name it',
    file: 'apps/api/src/middleware/request-context.ts',
    from: '  const requestId = generateRequestId();',
    to:
      "  const claimed = req.headers['x-request-id'];\n" +
      '  const requestId =\n' +
      "    typeof claimed === 'string' && /^[A-Za-z0-9._-]{8,128}$/.test(claimed)\n" +
      '      ? claimed\n' +
      '      : generateRequestId();',
    testFile: 'tests/platform.test.ts',
    testName: 'a caller-supplied x-request-id NEVER becomes the request id, well-formed or not',
  },
  {
    id: 'support_header_omits_expiry',
    control: 'the support-access indicator always declares the window it is bounded by',
    file: 'packages/identity-access/src/support-access.ts',
    from:
      '        `active; support_session=${g.supportSessionId}; support_request=${g.supportRequestId}; ` +\n' +
      '        `expires_at=${g.expiresAt.toISOString()}`,',
    to: '        `active; support_session=${g.supportSessionId}; support_request=${g.supportRequestId}`,',
    testFile: 'tests/support-context.test.ts',
    testName: 'the header format has ONE writer, and it cannot omit the expiry',
  },
  {
    id: 'assurance_floor_removed',
    control: 'a fresh_only grant can never satisfy an operation that requires fresh_and_mfa_policy',
    file: 'packages/identity-access/src/reauthentication.ts',
    from:
      '        AND (\n' +
      "          $7 = 'fresh_only'\n" +
      "          OR (assurance_level = 'fresh_and_mfa_policy' AND mfa_policy_certified_at_issue = TRUE)\n" +
      '        )',
    to: '        AND $7 IS NOT NULL',
    testFile: 'tests/identity-boundary.test.ts',
    testName: 'a fresh_only grant can NEVER satisfy a fresh_and_mfa_policy operation',
  },
  {
    /*
     * The §0 blocker. The pre-R4 runner matched on FILENAME ALONE, so a migration whose
     * body changed after it had been applied was skipped forever and the database and
     * the repository could disagree about the schema in force with nothing able to tell
     * them apart. This mutation restores exactly that defect — the comparison is still
     * made, its result is simply not acted on — and requires the battery to notice.
     */
    id: 'ledger_drift_ignored',
    control:
      'a previously applied migration whose body has changed REFUSES the run; the ledger ' +
      'records what was applied, not merely that something was',
    file: 'scripts/migrate.ts',
    from: "    if (computed !== row.checksum_sha256)\n      refusals.push({\n        kind: 'checksum-drift',",
    to: "    if (false && computed !== row.checksum_sha256)\n      refusals.push({\n        kind: 'checksum-drift',",
    testFile: 'tests/migration-ledger.test.ts',
    testName:
      'a CHANGED body of an applied migration REFUSES the run, names the file and both digests',
  },

  /*
   * ── FBL-020-R5 §0.3 / §0.4 / §0.5 / §0.6 ────────────────────────────────────
   *
   * Each of the mutations below restores, exactly, a behaviour this order was written to
   * remove. Two of them are the R4 code verbatim: `ledger_null_checksum_tolerated` and
   * `ledger_missing_body_tolerated` reinstate the `continue` that turned an unverifiable
   * ledger into a warning, and if the batteries survive either one then the refusals are
   * decoration and the order is not discharged.
   */
  {
    id: 'ledger_null_checksum_tolerated',
    control:
      'a ledger row with NO recorded checksum REFUSES the run — R4 warned and carried on, ' +
      'so further migrations were applied on top of a schema nobody could describe',
    file: 'scripts/migrate.ts',
    from: "    if (row.checksum_sha256 === null) {\n      refusals.push({\n        kind: 'unverifiable-checksum',",
    to: "    if (row.checksum_sha256 === null) {\n      continue;\n    }\n    if (row.checksum_sha256 === null) {\n      refusals.push({\n        kind: 'unverifiable-checksum',",
    testFile: 'tests/migration-ledger.test.ts',
    testName: 'a row with NO recorded checksum REFUSES the run, and no checksum is invented for it',
  },
  {
    id: 'ledger_missing_body_tolerated',
    control:
      'a ledger row naming a migration no tree in scope holds REFUSES the run — R4 treated ' +
      'it as unremarkable because a fixture directory is legitimately restricted',
    file: 'scripts/migrate.ts',
    from: "    if (body === undefined) {\n      refusals.push({\n        kind: 'missing-body',",
    to: "    if (body === undefined) {\n      continue;\n    }\n    if (body === undefined) {\n      refusals.push({\n        kind: 'missing-body',",
    testFile: 'tests/migration-ledger.test.ts',
    testName: 'a ledger row whose migration BODY is nowhere available REFUSES the run',
  },
  {
    id: 'fixture_mode_needs_no_opt_in',
    control:
      'a migrations directory that is not the canonical one must be opted into BY NAME; ' +
      'before this order MIGRATIONS_DIR was read straight from the environment, unguarded',
    file: 'scripts/migration-fixture-chains.ts',
    from: "  if (!named)\n    return {\n      mode: 'fixture',\n      chain: undefined,\n      problems: [",
    to: "  if (!named) return { mode: 'fixture', chain: undefined, problems: [] };\n  if (!named)\n    return {\n      mode: 'fixture',\n      chain: undefined,\n      problems: [",
    testFile: 'tests/migration-ledger.test.ts',
    testName: 'a non-canonical directory with no chain named is REFUSED',
  },
  {
    id: 'fixture_chain_digests_not_compared',
    control:
      "a declared chain's files must match a DECLARED CANONICAL DIGEST; a chain that " +
      'accepted any body would be an allowlist of names, not of contents (FBL-020-R6 §1.4)',
    file: 'scripts/migration-fixture-chains.ts',
    from: '    if (!entry.variants.some((v) => v.sha256 === found.sha256))',
    to: '    if (false && !entry.variants.some((v) => v.sha256 === found.sha256))',
    testFile: 'tests/migration-ledger.test.ts',
    testName: 'a fixture admitted only by its FILENAME is REFUSED',
  },
  {
    id: 'fixture_chain_admits_undeclared_files',
    control:
      'a file the chain does not declare is refused — this is the one gap through which an ' +
      'unreviewed migration could ride along inside an otherwise admitted fixture',
    file: 'scripts/migration-fixture-chains.ts',
    from: '    if (entry === undefined) {\n      problems.push(',
    to: '    if (false && entry === undefined) {\n      problems.push(',
    testFile: 'tests/migration-ledger.test.ts',
    testName: 'every declared chain matches its committed digests exactly, today',
  },
  {
    id: 'fixture_chain_admits_by_filename_only',
    control:
      'FBL-020-R6 §1.4 WITHDREW filename-only admission. The allowlist refuses a chain that ' +
      'declares a filename with no digest, so the withdrawn rule cannot return as data',
    file: 'scripts/migration-fixture-chains.ts',
    from: '      if (!Array.isArray(variants) || variants.length === 0) {',
    to: '      if (!Array.isArray(variants)) {',
    testFile: 'tests/migration-ledger.test.ts',
    testName: 'the allowlist REFUSES a chain that declares a filename with no checksum',
  },
  {
    id: 'retained_fixture_digests_not_compared',
    control:
      'the retained f76a27a fixture is COMPARED against committed digests; R4 recorded ' +
      'whatever it found under a step named "must stay byte-identical"',
    file: 'scripts/migration-manifest.ts',
    from: '    else if (actual !== expected)',
    to: '    else if (false && actual !== expected)',
    testFile: 'tests/ci-gates.test.ts',
    testName: 'a CHANGED, EXTRA or MISSING fixture file is refused, not re-recorded',
  },
  {
    id: 'reconciliation_inventory_tolerates_unaccounted',
    control:
      'a reconciliation in 057 with neither a negative control nor a written reason FAILS ' +
      'the inventory; without this, "the controls cover the reconciliations" is unfalsifiable',
    file: 'scripts/reconciliation-inventory.ts',
    from: '        `statement ${s.ordinal} (line ${s.line}) is a reconciliation that nothing accounts ` +',
    to: '        `statement ${s.ordinal} (line ${s.line}) is accounted for after all ` +',
    testFile: 'tests/ci-gates.test.ts',
    testName: 'a reconciliation with NO control and NO declaration is REPORTED, not tolerated',
  },

  /*
   * ── FBL-020-R5 §1.1 / §1.3 ──────────────────────────────────────────────────
   *
   * `cookie_logout_forgets_refresh_state` reproduces the R4 defect exactly — the COOKIE
   * path stops clearing the refresh state while the other three keep clearing it, which
   * is the shape that made it invisible for a whole revision — and
   * `route_establishes_its_own_session` restores the route owning the session insert. If
   * either battery survives its mutation then the corresponding §1 correction is
   * decoration and the order is not discharged.
   *
   * NOT MUTATED HERE, and disclosed rather than quietly omitted: the structural test
   * `the revocation statement is written ONCE…`. Expressing that mutation means putting
   * a second `identity_sessions` revocation statement in THIS file, and
   * `scripts/check-owned-mutations.ts` refuses an authorization-state write in a
   * non-owner production file — correctly. Its revert-proof was performed by hand
   * against the restored R4 source and is recorded in the delivery evidence.
   */
  {
    id: 'revocation_keeps_refresh_state',
    control:
      'a revocation destroys the provider refresh credential in the SAME statement that ' +
      'sets revoked_at; a revoked session that kept its sealed state could still be refreshed',
    file: 'packages/identity-access/src/session.ts',
    from:
      '            refresh_token_hash = NULL,\n' +
      '            refresh_state_sealed = NULL,\n' +
      '            refresh_state_key_version = NULL,\n' +
      '            refresh_lease_id = NULL,\n' +
      '            refresh_lease_expires_at = NULL\n',
    to: '',
    testFile: 'tests/identity-revocation.test.ts',
    testName:
      'cookie LOGOUT of a callback-created REFRESHABLE session revokes it and destroys every ' +
      'trace of the provider credential',
  },
  {
    /*
     * THE R4 DEFECT, REPRODUCED. The COOKIE target — and only it — stops clearing the
     * refresh state, so a callback-created refreshable session hits migration 057's
     * is_revoked_holds_no_refresh_state, the transaction rolls back, and the logout
     * leaves the session LIVE. The other three targets keep clearing, which is exactly
     * what made this survive a whole revision: three of four copies were right.
     */
    id: 'cookie_logout_forgets_refresh_state',
    control:
      'the CLEARING of refresh state cannot be made conditional on which revocation ' +
      'path is running; the cookie logout destroys the credential like every other path',
    file: 'packages/identity-access/src/session.ts',
    from:
      '            refresh_token_hash = NULL,\n' +
      '            refresh_state_sealed = NULL,\n' +
      '            refresh_state_key_version = NULL,\n' +
      '            refresh_lease_id = NULL,\n' +
      '            refresh_lease_expires_at = NULL\n' +
      '      WHERE',
    to:
      "            ${target.by === 'session_token_hash' ? 'updated_at = NOW()' : `refresh_token_hash = NULL,\n" +
      '            refresh_state_sealed = NULL,\n' +
      '            refresh_state_key_version = NULL,\n' +
      '            refresh_lease_id = NULL,\n' +
      '            refresh_lease_expires_at = NULL`}\n' +
      '      WHERE',
    testFile: 'tests/identity-revocation.test.ts',
    testName:
      'cookie LOGOUT of a callback-created REFRESHABLE session revokes it and destroys ' +
      'every trace of the provider credential',
  },
  {
    id: 'admission_holds_no_locks',
    control:
      'login admission HOLDS the connection, tenant and hierarchy rows it decided on ' +
      '(FOR SHARE) until the session exists; an unlocked snapshot read lets a concurrent ' +
      'suspension commit and still produces a session with the provider credential sealed in',
    file: 'packages/identity-access/src/login-admission.ts',
    from: '      WHERE ${LOGIN_CONNECTION_ADMISSION_SQL}\n        FOR SHARE`,',
    to: '      WHERE ${LOGIN_CONNECTION_ADMISSION_SQL}`,',
    testFile: 'tests/login-admission-concurrency.test.ts',
    testName:
      'CONNECTION DISABLEMENT cannot race admission into a session or into credential custody',
  },
  {
    id: 'tenant_admission_holds_no_lock',
    control:
      'the TENANT the login is being admitted into is held (FOR SHARE) until the session ' +
      'exists; read without a lock, a concurrent suspension is simply invisible',
    file: 'packages/identity-access/src/login-admission.ts',
    from: '     AND (t.effective_to IS NULL OR t.effective_to > NOW())\n     FOR SHARE`;',
    to: '     AND (t.effective_to IS NULL OR t.effective_to > NOW())`;',
    testFile: 'tests/login-admission-concurrency.test.ts',
    testName: 'TENANT SUSPENSION cannot race admission into a session or into credential custody',
  },
  {
    id: 'hierarchy_admission_holds_no_lock',
    control:
      "the tenant's organization hierarchy is held (FOR SHARE) until the session exists, so " +
      'a concurrent archival cannot land between the decision and the custody',
    file: 'packages/identity-access/src/login-admission.ts',
    from: '     AND (g2.effective_to IS NULL OR g2.effective_to > NOW())\n     FOR SHARE`;',
    to: '     AND (g2.effective_to IS NULL OR g2.effective_to > NOW())`;',
    testFile: 'tests/login-admission-concurrency.test.ts',
    testName:
      'ORGANIZATION HIERARCHY ARCHIVAL cannot race admission into a session or into credential custody',
  },
  /*
   * ── FBL-020-R5 Appendix A item 4 — THE LOCK MUTATION, RESOLVED SEMANTICALLY ──
   *
   * The three mutations above REMOVE the lock, which is the mutation that can enable the
   * race; a gate pass had additionally substituted `FOR UPDATE` at the same three sites,
   * watched the battery stay green, and read that as a control that was not pinned. It is
   * not: `FOR UPDATE` is STRICTLY STRONGER than `FOR SHARE`, so it excludes strictly more
   * and cannot admit an interleaving `FOR SHARE` refuses. A green suite under a
   * strengthening edit has noticed nothing because there is nothing to notice.
   *
   * What the substitution DOES change is availability — the module chooses `FOR SHARE` so
   * one login is not queued behind another — and that claim was genuinely unpinned. It is
   * pinned now, by its own barrier rather than by any of the race scenarios: a second
   * connection holds a share lock on the connection row, and the login must finish anyway.
   * The mutation below is therefore not a security mutation and is not offered as one; it
   * is the control for the stated design reason, and it fails ONE test.
   */
  {
    id: 'admission_takes_an_exclusive_lock',
    control:
      'the admission CLAIMS its rows in a shared mode, so a login is not serialised behind ' +
      'another login; FOR UPDATE would be safe but would queue every concurrent login',
    file: 'packages/identity-access/src/login-admission.ts',
    from: '      WHERE ${LOGIN_CONNECTION_ADMISSION_SQL}\n        FOR SHARE`,',
    to: '      WHERE ${LOGIN_CONNECTION_ADMISSION_SQL}\n        FOR UPDATE`,',
    testFile: 'tests/login-admission-concurrency.test.ts',
    testName:
      'the admission claims its rows in a SHARED mode: a login is not queued behind another share lock on its connection',
  },
  /*
   * ── AND WHAT THE LOCKS DO NOT CARRY ─────────────────────────────────────────
   *
   * The three LINK scenarios of §1.4 survive removing every lock above, so something else
   * refuses them. Measurement says it is `admitUserLink`'s re-read and nothing else: the
   * observation that precedes it decides its branch from a snapshot that still shows the
   * pre-change row, so it hands the changed link back rather than refusing it. Each of the
   * three predicate groups below is therefore the SOLE enforcement of one scenario, and
   * each is mutated separately — one mutation covering all three would not show that.
   *
   * The binding mutation neutralises rather than deletes its predicates, and the casts are
   * load-bearing: deleting them leaves `$3`-`$5` unreferenced and PostgreSQL then refuses
   * to infer their types, which breaks the statement instead of weakening the control — a
   * mutation that makes the CONTROL leg fail proves nothing about the scenario.
   */
  {
    id: 'link_readmission_ignores_status',
    control:
      'the link is RE-READ as activated after the observation, so a deactivation that ' +
      'committed while the login waited is refused rather than admitted',
    file: 'packages/identity-access/src/login-admission.ts',
    from: "        AND ul.status = 'activated'\n",
    to: '',
    testFile: 'tests/login-admission-concurrency.test.ts',
    testName: 'LINK DEACTIVATION cannot race admission into a session or into credential custody',
  },
  {
    id: 'link_readmission_ignores_the_effective_window',
    control:
      "the link's EFFECTIVE WINDOW is re-read after the observation — which filters on no " +
      'window at all — so an offboarding that closed the window cannot admit a login',
    file: 'packages/identity-access/src/login-admission.ts',
    from:
      '        AND ul.effective_from <= NOW()\n' +
      '        AND (ul.effective_to IS NULL OR ul.effective_to > NOW())\n' +
      '        AND ul.tenant_id IS NOT DISTINCT FROM $2::uuid',
    to: '        AND ul.tenant_id IS NOT DISTINCT FROM $2::uuid',
    testFile: 'tests/login-admission-concurrency.test.ts',
    testName:
      'LINK EFFECTIVE-WINDOW CLOSURE cannot race admission into a session or into credential custody',
  },
  {
    id: 'link_readmission_ignores_the_binding',
    control:
      'the link is re-read BOUND to the connection, issuer and organization this login was ' +
      'admitted through, so a relink onto another connection cannot ride the old decision',
    file: 'packages/identity-access/src/login-admission.ts',
    from:
      '        AND ul.connection_id = $3::uuid\n' +
      '        AND ul.issuer = $4\n' +
      '        AND ul.provider_organization_id = $5\n',
    to: '        AND ($3::uuid IS NOT NULL AND $4::text IS NOT NULL AND $5::text IS NOT NULL)\n',
    testFile: 'tests/login-admission-concurrency.test.ts',
    testName:
      'LINK RELINKING ONTO ANOTHER CONNECTION cannot race admission into a session or into credential custody',
  },
  {
    /*
     * The R4 SHAPE, restored: the ROUTE establishes the session itself, in a
     * transaction of its own, after the admission has already committed. That is the
     * interval §1.3 exists to remove, and the structural guard is what refuses it.
     */
    id: 'route_establishes_its_own_session',
    control:
      'no app may establish a session on its own — admission and credential custody are ' +
      'ONE call, so a route cannot hold a decision and act on it a transaction later',
    file: 'apps/api/src/routes/auth.ts',
    from: '    const created = admission.created;',
    to:
      "    const created = await (await import('@dealer/identity-access')).createSession({\n" +
      '      tenantId: admission.identity.tenantId,\n' +
      '      userLinkId: admission.identity.userLinkId,\n' +
      '      providerSessionId: admission.identity.providerSessionId,\n' +
      '      authTime: verified.authTime,\n' +
      '      ttlSeconds: SESSION_TTL_SECONDS,\n' +
      '      connectionId: admission.identity.connectionId,\n' +
      '      issuer: admission.identity.issuer,\n' +
      '      providerSubject: admission.identity.providerSubject,\n' +
      '      providerOrganizationId: admission.identity.providerOrganizationId,\n' +
      '      refreshToken: exchanged.refreshToken,\n' +
      '      cookiePassword: s.cookiePassword,\n' +
      '      providerAccessTokenExpiresAt: verified.expiresAt,\n' +
      '    });',
    testFile: 'tests/login-admission-concurrency.test.ts',
    testName: 'no route may establish a session on its own — admission and custody are ONE call',
  },

  /*
   * ── FBL-020-R5 §3.4 / §3.5 ──────────────────────────────────────────────────
   *
   * The documentation controls are controls, and the same rule applies to them: a check
   * that has never been shown to fail is not known to be a check. R4's requirement map
   * validated the rows it happened to contain, so a clause with NO row at all was
   * invisible — the failure mode is silence, which no passing test can distinguish from
   * success.
   *
   * The last mutation edits the requirement map rather than a source file, because the
   * §3.4 control is precisely "the recorded fact is compared against the DOCUMENT". A
   * one-character change to the recorded digest must be caught by reading the document,
   * and if it is not, the anchor is decorative.
   */
  {
    id: 'requirement_map_ignores_uncovered_clause',
    control:
      'a clause in the inventory with no requirement FAILS the check; without it the map ' +
      'validates only the rows it happens to contain and an omission is silent',
    file: 'scripts/check-requirement-map.ts',
    from:
      '      problems.push(\n' +
      '        `clause ${clause} is declared in the inventory but NO ${MAP_ORDER} requirement covers it`,\n' +
      '      );\n',
    to: '',
    testFile: 'tests/ci-gates.test.ts',
    testName: 'an OMITTED requirement fails the clause-coverage check',
  },
  {
    id: 'requirement_map_tolerates_duplicate_ids',
    control:
      'two requirements cannot share an id; a duplicate lets one row silently stand in ' +
      'for another when a reviewer looks the id up',
    file: 'scripts/check-requirement-map.ts',
    from: '    if (seenIds.has(req.id)) problems.push(`${req.id}: duplicate requirement id`);\n',
    to: '',
    testFile: 'tests/ci-gates.test.ts',
    testName: 'a duplicate id, a malformed id and an undeclared clause are each REPORTED',
  },
  {
    id: 'inventory_not_anchored_to_the_order_text',
    control:
      'the clause inventory is held to the checked-in order text, so the map cannot ' +
      'invent a clause the order never issued',
    file: 'scripts/check-requirement-map.ts',
    from: "      problems.push(`clause ${clause} is in the inventory but not in the order text's register`);\n",
    to: '',
    testFile: 'tests/ci-gates.test.ts',
    testName: 'the inventory cannot invent a clause the order text does not declare',
  },
  /*
   * THE OTHER DIRECTION OF THE SAME ANCHOR, and it is the one §3.5 was rejected over.
   * Refusing an invented clause stops the map claiming MORE than the order says; refusing
   * a clause the register carries that the inventory forgot is what stops it claiming
   * LESS — which is the shape §§1.5–1.11, §§2.1–2.4 and §4 went missing in. Both pushes
   * must therefore be separately load-bearing, and one mutation cannot show that.
   */
  {
    id: 'inventory_may_omit_an_order_clause',
    control:
      'a clause the checked-in order text registers that the inventory does not declare ' +
      'FAILS the check; without it the map can silently drop a clause of the order',
    file: 'scripts/check-requirement-map.ts',
    from: "      problems.push(`clause ${clause} is in the order text's register but not in the inventory`);\n",
    to: '',
    testFile: 'tests/ci-gates.test.ts',
    testName: 'the inventory cannot invent a clause the order text does not declare',
  },
  {
    id: 'requirement_map_ignores_order_text_digest',
    control:
      'the map names the canonical-LF digest of the order text it was built against and ' +
      'the checker recomputes it, so the authority cannot move under the map unnoticed',
    file: 'docs/FBL-020-R5-REQUIREMENT-MAP.json',
    from: '83b7bcd961bd36e1ba06ed79bebe524a8d1a6b40c65797ad2b4c37cc0ce47f44',
    to: '75aa7500f804d51019a6e950a91ab3ef5f30a1a37bb15c743c6d952a2e2bd780',
    testFile: 'tests/ci-gates.test.ts',
    testName: 'every requirement names tests that exist, and every mapped battery is claimed',
  },
  {
    id: 'blueprint_digest_recorded_wrong',
    control:
      'the recorded facts about the supplied blueprint are compared against the ' +
      'DOCUMENT ITSELF; a recorded digest that no longer describes the file must fail',
    file: 'docs/FBL-020-R5-REQUIREMENT-MAP.json',
    from: 'd38ad00ad2cd5a13ac087dbb96a34a4c133d0e5bfe8c81d9820a0b69f31e03f9',
    to: 'd38ad00ad2cd5a13ac087dbb96a34a4c133d0e5bfe8c81d9820a0b69f31e03f0',
    testFile: 'tests/delivery-documentation.test.ts',
    testName: 'the SUPPLIED blueprint in this repository is the document the record describes',
  },
  /*
   * FBL-020-R5 §4.8 — THE TWO SWEEPS THE WORKER DID NOT RUN.
   *
   * Registration is the control here. Both transitions were already written, audited and
   * covered by tests that CALLED THE FUNCTION DIRECTLY — which is exactly why the gap
   * survived four revisions: every existing test passed with the worker running neither.
   * Deleting a registry entry must therefore kill a test that drives the WORKER'S pass,
   * and the two below are named for that reason rather than for the sweep's own battery.
   */
  {
    id: 'worker_forgets_login_transaction_expiry',
    control:
      'the worker runs the login-transaction expiry sweep, so an abandoned login is aged ' +
      'and audited in production rather than only when a test calls the function',
    file: 'apps/worker/src/main.ts',
    from: '  { name: LOGIN_TRANSACTION_EXPIRY_JOB, run: () => runLoginTransactionExpiryOnce() },\n',
    to: '',
    testFile: 'tests/worker-jobs.test.ts',
    testName: 'the worker pass ages a stale LOGIN transaction, exactly once',
  },
  {
    id: 'worker_forgets_reauthentication_expiry',
    control:
      'the worker runs the reauthentication expiry sweep, so an uncompleted step-up reaches ' +
      'its terminal state and writes its audit row in production',
    file: 'apps/worker/src/main.ts',
    from: '  { name: REAUTHENTICATION_EXPIRY_JOB, run: () => runReauthenticationExpiryOnce() },\n',
    to: '',
    testFile: 'tests/worker-jobs.test.ts',
    testName: 'the worker pass ages a stale STEP-UP, exactly once',
  },
  {
    id: 'worker_forgets_support_access_expiry',
    control:
      'the worker runs the support-access expiry sweep — the registration FBL-020-R4 added, ' +
      'kept under the same mutation as the two beside it so a future edit cannot drop it',
    file: 'apps/worker/src/main.ts',
    from: '  { name: SUPPORT_ACCESS_EXPIRY_JOB, run: () => runSupportAccessExpiryOnce() },\n',
    to: '',
    testFile: 'tests/worker-jobs.test.ts',
    testName: 'the worker pass closes an expired SUPPORT window, exactly once',
  },

  /*
   * ── FBL-020-R5 §1.5 – §1.11: the runtime controls this revision added ────────
   *
   * One entry per newly mandatory predicate or transition, each naming the ONE test
   * that must die when the control is reverted. Anchors are exact source text, so a
   * refactor that moves a control breaks the harness loudly instead of quietly
   * reporting a mutation as killed.
   */
  {
    id: 'provider_error_callback_left_in_flight',
    control:
      'a provider `error` callback is claimed and terminalized with its own reason, ' +
      'instead of being refused before the claim and left pending for the expiry sweep',
    file: 'apps/api/src/routes/auth.ts',
    from:
      '    // outward is the same neutral 401 as every other refusal on this leg.\n' +
      "    if (typeof req.query.error === 'string' && req.query.error.length > 0) {\n" +
      "      throw await refusal('provider_error_callback');\n" +
      '    }\n',
    to: '    // outward is the same neutral 401 as every other refusal on this leg.\n',
    testFile: 'tests/login-admission.test.ts',
    testName:
      'a provider ERROR callback reaches its own terminal state, and the provider message never lands',
  },
  {
    id: 'missing_authorization_code_not_terminal',
    control:
      'a callback presenting a valid sealed handle and no authorization code reaches a ' +
      'terminal state of its own rather than falling into the provider exchange',
    file: 'apps/api/src/routes/auth.ts',
    from:
      '    // outward is the same neutral 401 as every other refusal on this leg.\n' +
      "    if (typeof req.query.error === 'string' && req.query.error.length > 0) {\n" +
      "      throw await refusal('provider_error_callback');\n" +
      '    }\n' +
      "    if (typeof code !== 'string' || code.length === 0) {\n" +
      "      throw await refusal('authorization_code_missing');\n" +
      '    }\n',
    to:
      '    // outward is the same neutral 401 as every other refusal on this leg.\n' +
      "    if (typeof req.query.error === 'string' && req.query.error.length > 0) {\n" +
      "      throw await refusal('provider_error_callback');\n" +
      '    }\n',
    testFile: 'tests/login-admission.test.ts',
    testName:
      'a callback carrying NO authorization code is terminal, and distinct from a provider error',
  },
  {
    id: 'login_expiry_sweep_unbounded',
    control:
      'one pass of the login-transaction expiry sweep ages at most `limit` rows, so a ' +
      'backlog is drained across passes instead of held in a single transaction',
    file: 'packages/identity-access/src/login-transaction.ts',
    from: '  for (let i = 0; i < requested; i += 1) {\n    const aged = await withTransaction',
    to:
      '  for (let i = 0; i < LOGIN_TRANSACTION_EXPIRY_MAX_BATCH; i += 1) {\n' +
      '    const aged = await withTransaction',
    testFile: 'tests/worker-jobs.test.ts',
    testName:
      'the login-transaction sweep is BOUNDED by its limit, and refuses one outside its range',
  },
  {
    id: 'login_expiry_claim_predicate_dropped',
    control:
      'the login-transaction sweep claims only rows that are still pending or consuming, ' +
      'which is what makes a repeated pass and a concurrent pass no-ops for the same reason',
    file: 'packages/identity-access/src/login-transaction.ts',
    from: "             WHERE lt.status IN ('pending', 'consuming')",
    to: "             WHERE lt.status IN ('pending', 'consuming', 'failed')",
    testFile: 'tests/worker-jobs.test.ts',
    testName: 'CONCURRENT login-transaction sweeps age each stale transaction exactly once',
  },
  {
    id: 'reauth_expiry_claim_predicate_dropped',
    control: 'the step-up expiry sweep claims only rows still in `started`, for the same reason',
    file: 'packages/identity-access/src/reauthentication.ts',
    from: "             WHERE rt.state = 'started'",
    to: "             WHERE rt.state IN ('started', 'expired')",
    testFile: 'tests/worker-jobs.test.ts',
    testName: 'CONCURRENT step-up sweeps expire each transaction exactly once',
  },
  {
    id: 'revocation_and_audit_are_two_transactions',
    control:
      'a session revocation and the audit row it owes commit together — the R4 shape ran ' +
      'them as independent operations, so a failure between them destroyed a session silently',
    file: 'packages/identity-access/src/session.ts',
    from: '  await auditRevocations(executor, rows, reason, actor);\n  return rows;',
    to:
      '  try {\n' +
      '    await withTransaction((tx) => auditRevocations(tx, rows, reason, actor));\n' +
      '  } catch {\n    /* the R4 shape: the revocation stands whether or not the trail does */\n  }\n' +
      '  return rows;',
    testFile: 'tests/identity-revocation.test.ts',
    testName: 'a failing audit insert takes the revocation down with it — they are ONE transaction',
  },
  {
    id: 'refresh_boundary_verification_optional',
    control:
      'access-token verification is REQUIRED at the exported refresh boundary; making it ' +
      'optional restores a surface that takes a new provider credential into custody unproven',
    file: 'packages/identity-access/src/session.ts',
    from:
      '   * required property is.\n' +
      '   */\n' +
      '  readonly verifyAccessToken: (accessToken: string) => Promise<VerifiedAccessToken>;',
    to:
      '   * required property is.\n' +
      '   */\n' +
      '  readonly verifyAccessToken?: (accessToken: string) => Promise<VerifiedAccessToken>;',
    testFile: 'tests/identity-boundary.test.ts',
    testName: 'the exported refresh surface cannot be driven without access-token verification',
  },
  {
    id: 'mfa_certification_ignores_tenant_effectiveness',
    control:
      'tenant-scoped MFA certification requires a currently active AND effective tenant, ' +
      'under the same rule the policy engine applies to every non-platform decision',
    file: 'packages/identity-access/src/mutations.ts',
    from:
      '  if (tenantId !== null) {\n' +
      '    const tenant = await executor.query(\n' +
      '      `SELECT 1 FROM tenants t WHERE t.tenant_id = $1 AND ${ACTIVE_EFFECTIVE_TENANT_SQL}\n' +
      '        FOR SHARE`,\n' +
      '      [tenantId],\n' +
      '    );\n' +
      '    if (tenant.rows.length === 0) {\n' +
      '      throw new MutationAuthorityError(\n' +
      "        'certifying an organization MFA policy requires a currently active and effective tenant',\n" +
      '      );\n' +
      '    }\n' +
      '  }\n',
    to: '',
    testFile: 'tests/identity-lifecycle-audit.test.ts',
    testName: 'tenant-scoped MFA certification requires a currently ACTIVE and EFFECTIVE tenant',
  },
  {
    id: 'late_revocation_steals_the_expiry',
    control:
      'a support window whose expiry instant has passed cannot be revoked — the expiry ' +
      'transition owns that ending and a human may not relabel it',
    file: 'packages/identity-access/src/mutations.ts',
    from:
      'const SUPPORT_SESSION_STILL_RUNNING_SQL = `revoked_at IS NULL\n' +
      '          AND expired_at IS NULL AND expires_at > NOW()`;',
    to: 'const SUPPORT_SESSION_STILL_RUNNING_SQL = `revoked_at IS NULL`;',
    testFile: 'tests/worker-jobs.test.ts',
    testName: 'ORDERING A — a window that has LAPSED but not yet been swept cannot be revoked',
  },
  {
    id: 'login_success_audit_unattributed',
    control:
      'the successful-login transition records the ADMITTED tenant and user, so the one ' +
      'event that says who got in is not written against the nil tenant naming nobody',
    file: 'packages/identity-access/src/login-transaction.ts',
    from: '            tenant_id = $2::uuid,\n            user_link_id = $3::uuid,',
    to: '            tenant_id = NULL,\n            user_link_id = NULL,',
    testFile: 'tests/login-admission.test.ts',
    testName: 'the successful-login audit event names the ADMITTED tenant and user',
  },

  // ── FBL-020-R6 §2 — RUNTIME LIFECYCLE CLOSURE ────────────────────────────
  //
  // Ten controls, each removed by ONE exact edit that restores the R5 behaviour the
  // order names. The batteries that carry them drive the REAL HTTP routes, so each of
  // these is a claim about what a browser can actually make happen.
  {
    id: 'login_route_judges_state_before_the_claim',
    control:
      'a callback carrying a valid sealed handle reaches the server-authoritative ' +
      'lifecycle service even when its state is missing or wrong; the route does not ' +
      'refuse it first and leave the transaction claimable',
    file: 'apps/api/src/routes/auth.ts',
    from:
      "    clearCookie(res, AUTH_TXN_COOKIE, '/auth');\n" +
      "    if (txn === null) throw new UnauthorizedError('Authentication failed');\n",
    to:
      "    clearCookie(res, AUTH_TXN_COOKIE, '/auth');\n" +
      '    if (\n' +
      '      txn === null ||\n' +
      "      txn.purpose !== 'login' ||\n" +
      "      typeof req.query.state !== 'string' ||\n" +
      '      req.query.state !== txn.state\n' +
      '    ) {\n' +
      "      throw new UnauthorizedError('Authentication failed');\n" +
      '    }\n',
    testFile: 'tests/login-admission.test.ts',
    testName:
      'a callback with NO state reaches the lifecycle service and ends its transaction (R6 §2.1)',
  },
  {
    id: 'login_callback_mismatch_left_pending',
    control:
      'a callback that names a real transaction and disagrees with it reaches ONE ' +
      'explained terminal state, not a replay record on a row left pending',
    file: 'packages/identity-access/src/login-transaction.ts',
    from:
      '    const terminal = async (reason: LoginTransactionFailureReason): Promise<null> => {\n' +
      '      await failLoginTransactionWithin(executor, loginTxnId, reason);\n' +
      '      return null;\n' +
      '    };',
    to:
      '    const terminal = async (reason: LoginTransactionFailureReason): Promise<null> => {\n' +
      '      await auditLogin(executor, {\n' +
      '        loginTxnId,\n' +
      '        tenantId,\n' +
      '        userLinkId,\n' +
      "        eventType: 'identity.login.replayed',\n" +
      '        details: { purpose: rowPurpose, observed_status: String(reason) },\n' +
      '      });\n' +
      '      return null;\n' +
      '    };',
    testFile: 'tests/login-admission.test.ts',
    testName:
      'a callback whose state DISAGREES ends its transaction, and the correct one afterwards loses (R6 §2.2)',
  },
  {
    id: 'login_success_ignores_expiry',
    control:
      'the login success transition requires the transaction to be unexpired in ' +
      'DATABASE TIME at the moment of completion',
    file: 'packages/identity-access/src/login-transaction.ts',
    from:
      '        -- FBL-020-R6 §2.3: LOGIN EXPIRY, ENFORCED AT COMPLETION, IN DATABASE TIME.\n' +
      '        AND expires_at > NOW()\n',
    to: '',
    testFile: 'tests/login-admission.test.ts',
    testName: 'a login claimed before expiry and completed after it is refused WITHOUT any sweep',
  },
  {
    id: 'login_custody_survives_a_refused_success',
    control:
      'a login-success transition that is refused ROLLS BACK the session row and the ' +
      'sealed provider credential rather than committing them anyway',
    file: 'packages/identity-access/src/login-admission.ts',
    from: '        if (!recorded.recorded) throw new LoginSuccessNotRecorded(recorded.refusal);',
    to: '        if (!recorded.recorded) return { identity, created };',
    testFile: 'tests/login-admission.test.ts',
    testName: 'a login claimed before expiry and completed after it is refused WITHOUT any sweep',
  },
  {
    id: 'login_success_is_a_second_commit',
    control:
      'session custody, the login success transition and their audits are ONE local ' +
      'commit; a failing success audit cannot leave a refreshable session behind',
    file: 'packages/identity-access/src/login-admission.ts',
    from:
      '        const recorded = await succeedLoginTransactionWithin(executor, {\n' +
      '          loginTxnId: input.loginTxnId,\n' +
      '          tenantId: created.session.tenantId,\n' +
      '          userLinkId: created.session.userLinkId,\n' +
      '          connectionId: created.session.connectionId,\n' +
      '        });\n' +
      '        if (!recorded.recorded) throw new LoginSuccessNotRecorded(recorded.refusal);\n' +
      '        return { identity, created };',
    to: '        return { identity, created };',
    testFile: 'tests/login-admission.test.ts',
    testName: 'a failing login-success AUDIT write leaves NO custody behind (R6 §2.5)',
  },
  {
    id: 'stepup_route_judges_state_before_the_claim',
    control:
      'the step-up callback leg routes a valid sealed handle to the claim even when ' +
      'its state is missing or wrong, so the transaction ends instead of staying claimable',
    file: 'apps/api/src/routes/auth.ts',
    from:
      "    clearCookie(res, REAUTH_TXN_COOKIE, '/auth');\n" +
      "    if (txn === null) throw new UnauthorizedError('Reauthentication failed');\n",
    to:
      "    clearCookie(res, REAUTH_TXN_COOKIE, '/auth');\n" +
      '    if (\n' +
      '      txn === null ||\n' +
      "      txn.purpose !== 'reauth' ||\n" +
      "      typeof req.query.state !== 'string' ||\n" +
      '      req.query.state !== txn.state\n' +
      '    ) {\n' +
      "      throw new UnauthorizedError('Reauthentication failed');\n" +
      '    }\n',
    testFile: 'tests/reauth-callback-lifecycle.test.ts',
    testName:
      'a step-up callback with NO state ends its transaction rather than leaving it claimable',
  },
  {
    id: 'stepup_completion_filters_by_subject',
    control:
      'the step-up completion finds and LOCKS by the server handle first and then ' +
      'classifies wrong subject, expiry and the missing claim — rather than filtering ' +
      'them out of the lookup and returning a silent null',
    file: 'packages/identity-access/src/reauthentication.ts',
    from:
      '      `SELECT *, (expires_at <= NOW()) AS is_expired FROM reauthentication_transactions\n' +
      '        WHERE nonce_hash = $1\n' +
      '        FOR UPDATE`,\n' +
      '      [sha256hex(input.nonce)],',
    to:
      '      `SELECT *, (expires_at <= NOW()) AS is_expired FROM reauthentication_transactions\n' +
      "        WHERE nonce_hash = $1 AND user_link_id = $2 AND state = 'started'\n" +
      '          AND claimed_at IS NOT NULL AND expires_at > NOW()\n' +
      '        FOR UPDATE`,\n' +
      '      [sha256hex(input.nonce), input.userLinkId],',
    testFile: 'tests/reauth-callback-lifecycle.test.ts',
    testName:
      'a step-up completed by the WRONG ACTIVE USER is terminal, audited, and mints nothing',
  },
  {
    id: 'stepup_expiry_not_classified_at_completion',
    control:
      'a step-up that expired while the provider was answering is terminalized as an ' +
      'EXPIRY by the completion itself, with no sweep involved',
    file: 'packages/identity-access/src/reauthentication.ts',
    from: "    if (startRow.is_expired === true) return fail('expired');",
    to: '',
    testFile: 'tests/reauth-callback-lifecycle.test.ts',
    testName:
      'a step-up that EXPIRES during the exchange is terminal and audited WITHOUT any sweep',
  },
  {
    id: 'mfa_certification_tenant_not_held',
    control:
      'the MFA-certification tenant check HOLDS the tenant row through the ' +
      'certification, so a concurrent suspension cannot be raced into a certified connection',
    file: 'packages/identity-access/src/mutations.ts',
    from:
      '      `SELECT 1 FROM tenants t WHERE t.tenant_id = $1 AND ${ACTIVE_EFFECTIVE_TENANT_SQL}\n' +
      '        FOR SHARE`,',
    to: '      `SELECT 1 FROM tenants t WHERE t.tenant_id = $1 AND ${ACTIVE_EFFECTIVE_TENANT_SQL}`,',
    testFile: 'tests/mfa-certification-concurrency.test.ts',
    testName:
      'TENANT SUSPENSION cannot race MFA certification into a certified connection (R6 §2.6)',
  },
  {
    id: 'session_establishment_failure_left_pending',
    // FBL-020-R6 §4.2. This exit was EXPRESSLY UNTESTED: the route wrote the reason and
    // no assertion anywhere read it, so deleting this line changed nothing any gate
    // could see. It is registered here so the coverage cannot quietly disappear again.
    control:
      'a login whose LOCAL SESSION could not be established TERMINALIZES its transaction ' +
      'with session_establishment_failed instead of leaving it at `consuming`',
    file: 'apps/api/src/routes/auth.ts',
    from:
      "      await failLoginTransaction(claimed.loginTxnId, 'session_establishment_failed');\n" +
      '      throw err;',
    to: '      throw err;',
    testFile: 'tests/login-admission.test.ts',
    testName: 'a login whose LOCAL SESSION cannot be established is terminal, with ONE audit event',
  },
  {
    id: 'worker_once_swallows_a_failed_sweep',
    control:
      'a worker pass reports which registered sweeps failed, and --once refuses to ' +
      'report success when any did',
    file: 'apps/worker/src/main.ts',
    // The END-TO-END proof is the EXIT STATUS of `apps/worker/dist/main.js`, in
    // `tests/worker-entrypoint.test.ts`. That battery cannot run here — the isolated
    // copy carries no `dist/` — so the control is killed at the level this runner can
    // reach: the same `main(['--once'])` the compiled entry point calls must REJECT.
    from: '      failed.push(job.name);',
    to: '      void job.name;',
    testFile: 'tests/worker-jobs.test.ts',
    testName:
      'a pass in which a registered sweep FAILS reports it, and --once refuses to report success',
  },
];

const ROOT = join(__dirname, '..');
const IS_WINDOWS = process.platform === 'win32';

/**
 * The workspace trees the mutations edit. Their presence INSIDE the copy is what makes
 * the copy isolated: `@dealer/*` resolves through the tsconfig `paths` map, whose
 * `baseUrl` is the config's own directory, so inside the copy those specifiers resolve
 * to the copy's own sources and never reach back into the working tree.
 */
const WORKSPACE_DIRS = ['apps', 'packages', 'scripts'];

function digest(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Every text in every mutation must anchor uniquely — checked before anything runs. */
export function anchorProblems(): string[] {
  const problems: string[] = [];
  for (const m of MUTATIONS) {
    const path = join(ROOT, m.file);
    if (!existsSync(path)) {
      problems.push(`${m.id}: ${m.file} does not exist`);
      continue;
    }
    const source = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
    const occurrences = source.split(m.from).length - 1;
    if (occurrences !== 1)
      problems.push(`${m.id}: the anchor occurs ${occurrences} time(s) in ${m.file}, expected 1`);
    if (m.from === m.to) problems.push(`${m.id}: the mutation changes nothing`);
    const testPath = join(ROOT, m.testFile);
    if (!existsSync(testPath)) {
      problems.push(`${m.id}: ${m.testFile} does not exist`);
    } else if (!readFileSync(testPath, 'utf8').includes(m.testName)) {
      problems.push(`${m.id}: ${m.testFile} declares no test named ${JSON.stringify(m.testName)}`);
    }
  }
  return problems;
}

/**
 * Copies the tree, excluding what must not be duplicated, and links node_modules.
 *
 * `@dealer/*` resolves through the tsconfig `paths` map, whose `baseUrl` is the
 * config's own directory — so inside the copy it resolves to the COPY's packages.
 * That is verified below rather than trusted: a copy whose imports reached back into
 * the original tree would report every mutation as surviving.
 */
function isolatedCopy(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fbl020-mut-'));
  const copy = join(dir, 'tree');
  cpSync(ROOT, copy, {
    recursive: true,
    filter: (src) => {
      const rel = src.slice(ROOT.length).replace(/\\/g, '/').replace(/^\//, '');
      if (rel === '') return true;
      const first = rel.split('/')[0] as string;
      /*
       * FBL-020-R5 — `artifacts/` IS EXCLUDED, AND THAT IS A CORRECTION, NOT A CONVENIENCE.
       *
       * It used to be copied in, which coupled every baseline in this runner to the very
       * artifact the runner produces. `tests/delivery-documentation.test.ts` compares the
       * delivery report's published mutation figures against `artifacts/mutation-kill.json`,
       * and that battery is the one mutation `blueprint_digest_recorded_wrong` runs. So a
       * single run that recorded anything other than what the report published left the NEXT
       * run's baseline red — and a red baseline is reported as a SURVIVOR, because the runner
       * (correctly) refuses to credit a kill to a battery that was already broken. One red
       * run therefore poisoned every subsequent run, and no source change could clear it.
       *
       * `artifacts/` is gitignored: it is evidence ABOUT a tree, not part of the tree under
       * test. Excluding it also makes this runner behave the way it already behaves in CI,
       * where `artifacts/mutation-kill.json` does not exist yet when this step runs — the
       * figure gate finds those figures unreadable and skips them, exactly as designed, and
       * the mutual-consistency limb still binds every publication of a figure to every other.
       */
      if (first === 'node_modules' || first === '.git' || first === 'artifacts') return false;
      if (rel.endsWith('.tsbuildinfo')) return false;
      return !/(^|\/)dist(\/|$)/.test(rel);
    },
  });
  // Shared, read-only: 85 MB of third-party packages are identical in both trees and
  // nothing here mutates them. A junction is used on Windows so no elevated privilege
  // is required.
  symlinkSync(
    join(ROOT, 'node_modules'),
    join(copy, 'node_modules'),
    IS_WINDOWS ? 'junction' : 'dir',
  );
  return copy;
}

function assertIsolation(copy: string): void {
  for (const tree of WORKSPACE_DIRS) {
    const probe = join(copy, tree);
    if (!existsSync(probe)) throw new Error(`isolated copy is missing ${tree}/`);
    if (!realpathSync(probe).startsWith(realpathSync(copy)))
      throw new Error(`isolated copy's ${tree}/ resolves outside the copy`);
  }
  /*
   * The decisive one, and it is derived from MUTATIONS rather than hard-coded: EVERY
   * file a mutation edits must be present in the copy and byte-identical to the
   * original. A hard-coded marker proves only that one module was copied, so a mutation
   * added later against a tree the filter happened to exclude — `scripts/`, say — would
   * be written into a file no battery reads, and the check would report the control as
   * surviving for a reason that has nothing to do with the control.
   */
  for (const relative of new Set(MUTATIONS.map((m) => m.file))) {
    const marker = join(copy, relative);
    if (!existsSync(marker)) throw new Error(`isolated copy is missing ${relative}`);
    if (digest(marker) !== digest(join(ROOT, relative)))
      throw new Error(`the copy of ${relative} does not match the original`);
  }
}

interface TestRun {
  status: number;
  failed: string[];
}

/** Runs one battery inside the copy and returns the names of the tests that failed. */
function runBattery(copy: string, testFile: string): TestRun {
  const result = spawnSync(
    'npx',
    ['tsx', '--test', '--test-concurrency=1', '--test-reporter=tap', testFile],
    {
      cwd: copy,
      encoding: 'utf8',
      env: process.env,
      shell: IS_WINDOWS,
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const failed: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const m = /^\s*not ok \d+ - (.*)$/.exec(line);
    if (m) failed.push((m[1] as string).trim());
  }
  return { status: result.status ?? 1, failed };
}

function parseArgs(): { out: string | undefined; log: string | undefined } {
  const argv = process.argv.slice(2);
  let out: string | undefined;
  let log: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') out = argv[(i += 1)];
    else if (argv[i] === '--log') log = argv[(i += 1)];
    else {
      console.error(`Unrecognized argument: ${argv[i]}`);
      process.exit(2);
    }
  }
  return { out, log };
}

function main(): void {
  const { out, log } = parseArgs();

  const problems = anchorProblems();
  if (problems.length > 0) {
    for (const p of problems) console.error(`FAIL: ${p}`);
    console.error('Refusing to run: a mutation whose anchor is wrong proves nothing.');
    process.exit(1);
  }

  const copy = isolatedCopy();
  const lines: string[] = [`isolated_copy=${copy}`, ''];
  const results: Array<Record<string, unknown>> = [];
  const baseline = new Map<string, TestRun>();
  let survivors = 0;

  try {
    assertIsolation(copy);

    for (const m of MUTATIONS) {
      const target = join(copy, m.file);
      const original = readFileSync(target, 'utf8');
      const originalDigest = digest(join(ROOT, m.file));

      // 2. The battery must be GREEN before the mutation, or its later failure says
      //    nothing about the control.
      /*
       * A FAILING BASELINE IS NOT CACHED, and its failures are RECORDED.
       *
       * Both halves of that were missing, and the cost was seven checks reported as
       * INCONCLUSIVE with nothing to say why: one battery's baseline run failed, the result
       * was cached, and every later mutation naming that battery inherited the verdict — so
       * a single transient failure looked exactly like seven broken controls, and the
       * artifact recorded no evidence a reader could use to tell the two apart.
       *
       * A GREEN baseline is still cached (it cannot go stale — the file is restored after
       * every mutation). A RED one is re-established per mutation, so a transient failure
       * costs one check instead of all of them, while a genuine breakage still shows up on
       * every check that depends on it.
       */
      let base = baseline.get(m.testFile);
      if (base === undefined) {
        base = runBattery(copy, m.testFile);
        if (base.status === 0 && base.failed.length === 0) baseline.set(m.testFile, base);
      }
      const baselineGreen = base.status === 0 && base.failed.length === 0;

      // 3. One exact edit. `split/join` rather than a regex: the anchor is literal text
      //    and a regex would give a `$` in the replacement a second meaning.
      const mutated = original.replace(/\r\n/g, '\n').split(m.from).join(m.to);
      writeFileSync(target, mutated, 'utf8');

      // 4. The same battery must now FAIL, and the declared test must be among the dead.
      const after = runBattery(copy, m.testFile);
      const killed = after.status !== 0 && after.failed.some((f) => f.includes(m.testName));

      writeFileSync(target, original, 'utf8');

      // The working tree is untouched — verified, not asserted in prose.
      const treeIntact = digest(join(ROOT, m.file)) === originalDigest;

      const ok = baselineGreen && killed && treeIntact;
      if (!ok) survivors += 1;

      const verdict = ok
        ? 'MUTATION KILLED'
        : !baselineGreen
          ? `INCONCLUSIVE — ${m.testFile} was not green before the mutation`
          : !treeIntact
            ? 'ABORTED — the working tree changed, which must never happen'
            : 'MUTATION SURVIVED — the control was removed and the suite stayed green';

      lines.push(
        `mutation=${m.id}`,
        `  control=${m.control}`,
        `  file=${m.file}`,
        `  battery=${m.testFile}`,
        `  expected_dead_test=${JSON.stringify(m.testName)}`,
        `  baseline_green=${baselineGreen}`,
        ...(baselineGreen
          ? []
          : [
              `  baseline_status=${base.status}`,
              `  baseline_failed_tests=${JSON.stringify(base.failed.slice(0, 8))}`,
            ]),
        `  after_status=${after.status} failed_tests=${after.failed.length}`,
        `  dead_tests=${JSON.stringify(after.failed.slice(0, 6))}`,
        `  working_tree_intact=${treeIntact}`,
        `  verdict=${verdict}`,
        '',
      );
      results.push({
        id: m.id,
        control: m.control,
        file: m.file,
        battery: m.testFile,
        baseline_status: base.status,
        baseline_failed_tests: baselineGreen ? [] : base.failed,
        expected_dead_test: m.testName,
        baseline_green: baselineGreen,
        after_status: after.status,
        dead_tests: after.failed,
        working_tree_intact: treeIntact,
        killed: ok,
      });
    }
  } finally {
    rmSync(join(copy, '..'), { recursive: true, force: true });
  }

  /*
   * FBL-020-R5 — THE ARTIFACT MUST SAY WHEN IT WAS TAKEN AND WHAT IT MEASURED.
   *
   * The delivered `artifacts/mutation-kill.json` was a genuine, complete, all-killed run,
   * and the delivery report described it as a fresh run at the current head. It was not:
   * it predated two commits and a source fix. Nothing in the artifact could contradict the
   * sentence, because the artifact recorded no time and no revision. These two fields are
   * the fix — a reader can now compare `head` with `git rev-parse HEAD` and see for
   * themselves. `tree_dirty` is recorded too, because a run taken over uncommitted work is
   * a run against a tree no SHA identifies.
   */
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout?.trim() ?? '';
  const dirty = spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).stdout ?? '';
  const summary = {
    generated_at: new Date().toISOString(),
    head: head === '' ? 'unknown' : head,
    tree_dirty: dirty.trim() !== '',
    mutations_total: MUTATIONS.length,
    mutations_killed: MUTATIONS.length - survivors,
    mutations_survived: survivors,
    mutations: results,
  };
  if (out !== undefined) writeFileSync(out, JSON.stringify(summary, null, 2) + '\n');

  lines.push(
    `mutations_total=${MUTATIONS.length} killed=${MUTATIONS.length - survivors} survived=${survivors}`,
  );
  const text = lines.join('\n') + '\n';
  process.stdout.write(text);
  if (log !== undefined) writeFileSync(log, text);

  if (survivors > 0) {
    console.error(
      `${survivors} mutation(s) SURVIVED: a control was removed and the suite did not notice.`,
    );
    process.exitCode = 1;
  }
}

if (require.main === module) main();
