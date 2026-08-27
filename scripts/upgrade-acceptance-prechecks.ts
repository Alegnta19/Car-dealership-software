/**
 * FBL-020-R7-C1 §8 — THE 060 FULL-SCOPE PRECHECKS, PROVEN TO REFUSE, ON COPIES.
 *
 *   DATABASE_URL=postgres://…/<the drill database, at 059 + post-059 activity> \
 *     npx tsx scripts/upgrade-acceptance-prechecks.ts --out artifacts/acceptance-prechecks.json \
 *       [--log artifacts/acceptance-prechecks.txt]
 *
 * ── WHAT THIS PROVES ───────────────────────────────────────────────────────
 *
 * 059's §0 prechecks were scoped to LIVE delegations, and its tuple key was
 * installed NOT VALID, so a revoked or expired incoherent row could be RETAINED
 * across the 059 upgrade. FBL-020-R7-C1 §8 requires migration 060 to inspect
 * EVERY retained row and to refuse before landing when one is incoherent, with a
 * bounded, actionable message, leaving history untouched.
 *
 * Each probe here copies the used-059 drill database, plants ONE such RETAINED
 * row, runs the real migration runner (which applies 060), and requires 060's
 * own bounded refusal with the ledger clean and the planted row untouched.
 *
 * ── WHY THE PLANT LIFTS A 059 GUARD ────────────────────────────────────────
 *
 * The rows 060 §8 exists to catch are ones that PREDATE 059's stricter rules:
 * on a used-059 database 059's NOT VALID tuple key and its approval trigger
 * refuse to let such a row be written FRESH. So each plant momentarily lifts the
 * ONE 059 guard the target row would trip, writes the legacy-shaped row, and
 * restores the guard exactly as 059 left it (the FK re-added NOT VALID; the
 * trigger re-enabled). The copy then holds precisely the state a real database
 * migrated through 059 BEFORE the incoherence arose would carry into 060 — which
 * is the state 060 §8 is responsible for refusing.
 */
import { spawnSync } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { Client } from 'pg';

const IS_WINDOWS = process.platform === 'win32';

/**
 * A real platform actor pair on the copy, so a planted session can name an actor
 * distinct from its request's requester and both be genuine platform links.
 */
const ENSURE_TWO_PLATFORM_LINKS = `
INSERT INTO identity_provider_connections
  (connection_scope, tenant_id, provider, provider_organization_id, status, issuer)
SELECT 'platform', NULL, 'workos', 'org_platform_acc_probe', 'active',
       (SELECT issuer FROM identity_provider_connections WHERE status = 'active' LIMIT 1)
 WHERE NOT EXISTS (
   SELECT 1 FROM identity_provider_connections WHERE tenant_id IS NULL AND status = 'active'
 );
INSERT INTO user_links
  (actor_scope, tenant_id, provider, provider_user_id, status, activated_at,
   connection_id, issuer, provider_organization_id)
SELECT 'platform', NULL, 'workos', v.pid, 'activated', NOW(),
       c.connection_id, c.issuer, c.provider_organization_id
  FROM (VALUES ('user_acc_probe_a'), ('user_acc_probe_b')) AS v(pid)
  JOIN identity_provider_connections c ON c.tenant_id IS NULL AND c.status = 'active'
 WHERE NOT EXISTS (SELECT 1 FROM user_links ul WHERE ul.provider_user_id = v.pid);

-- Mints a real, consumed identity.support.approve grant for a request, backed by
-- a real reauthentication transaction, so a plant can APPROVE a support request
-- the way the production path does. Dropped at the end of each plant; it exists
-- only to make the coherent backing grant these retained-row plants need.
CREATE OR REPLACE FUNCTION plant_support_grant(p_tenant uuid, p_decider uuid, p_request uuid)
RETURNS uuid AS $plant$
DECLARE txn uuid; g uuid;
BEGIN
  -- A COMPLETED transaction: state<>'started' so the started-binding CHECKs do
  -- not apply, and the completed/terminal fields are set for the state CHECKs.
  INSERT INTO reauthentication_transactions
    (tenant_id, user_link_id, action, nonce_hash, expires_at, required_assurance, state,
     completed_at, terminal_at, terminal_reason)
    VALUES (p_tenant, p_decider, 'identity.support.approve', repeat('c', 64),
            NOW() + INTERVAL '5 minutes', 'fresh_and_mfa_policy', 'completed',
            NOW(), NOW(), 'completed')
    RETURNING reauth_txn_id INTO txn;
  INSERT INTO reauthentication_grants
    (reauth_txn_id, tenant_id, user_link_id, action, resource_type, resource_id,
     grant_hash, expires_at, assurance_level, mfa_policy_certified_at_issue, consumed_at)
    VALUES (txn, p_tenant, p_decider, 'identity.support.approve', 'support_access_request',
            p_request, encode(gen_random_bytes(32), 'hex'), NOW() + INTERVAL '5 minutes',
            'fresh_and_mfa_policy', TRUE, NOW())
    RETURNING grant_id INTO g;
  RETURN g;
END;
$plant$ LANGUAGE plpgsql;
`;

interface Probe {
  id: string;
  precheck: string;
  what: string;
  inject: string;
  expect: readonly string[];
  survivorSql: string;
  survivors: number;
}

export const PROBES: readonly Probe[] = [
  {
    id: 'retained_revoked_actor_mismatch',
    precheck: '§8 (1 of 2) — full-scope actor tuple',
    what: 'a REVOKED retained session whose actor is not its request’s requester',
    inject:
      ENSURE_TWO_PLATFORM_LINKS +
      `
-- Lift the NOT VALID tuple key, plant a legacy revoked actor-mismatch session
-- under an APPROVED request (059's session-bounded trigger requires the request
-- to be approved+decided before a session may exist), then restore the key
-- NOT VALID exactly as 059 left it.
ALTER TABLE support_access_sessions DROP CONSTRAINT sas_actor_is_the_approved_requester;
DO $$
DECLARE t uuid; a uuid; b uuid; decider uuid; reqid uuid; g uuid;
BEGIN
  -- pick a tenant that HAS an activated dealership link, and that link as the
  -- decider, so the reauth transaction's (tenant, user_link) FK resolves.
  SELECT ul.tenant_id, ul.user_link_id INTO t, decider FROM user_links ul
    WHERE ul.actor_scope = 'dealership' AND ul.status = 'activated' AND ul.tenant_id IS NOT NULL
    ORDER BY ul.user_link_id LIMIT 1;
  SELECT user_link_id INTO a FROM user_links WHERE provider_user_id = 'user_acc_probe_a';
  SELECT user_link_id INTO b FROM user_links WHERE provider_user_id = 'user_acc_probe_b';
  INSERT INTO support_access_requests
    (tenant_id, requester_user_link_id, requested_actions, scope_level, scope_id, reason,
     requested_duration_minutes)
    VALUES (t, a, ARRAY['service.ro.view'], 'tenant', NULL,
            'acceptance probe: revoked actor mismatch', 30)
    RETURNING request_id INTO reqid;
  g := plant_support_grant(t, decider, reqid);
  UPDATE support_access_requests
     SET status = 'approved', decided_at = NOW(), decided_by_user_link_id = decider,
         approval_grant_id = g
   WHERE request_id = reqid;
  -- the retained session: a DIFFERENT platform actor, and revoked.
  INSERT INTO support_access_sessions
    (request_id, tenant_id, actor_user_link_id, granted_at, expires_at,
     revoked_at, revoked_by_user_link_id)
    VALUES (reqid, t, b, NOW(), NOW() + INTERVAL '30 minutes', NOW(), a);
END $$;
ALTER TABLE support_access_sessions
  ADD CONSTRAINT sas_actor_is_the_approved_requester
  FOREIGN KEY (request_id, tenant_id, actor_user_link_id)
  REFERENCES support_access_requests (request_id, tenant_id, requester_user_link_id) NOT VALID;
`,
    expect: [
      'migration 060 refused:',
      'retained support session(s) name an actor who is not the approved requester',
      'hard stop',
      'explicitly approved historical-remediation decision',
      'leaves the rows and the migration ledger exactly as they are',
    ],
    survivorSql: `
SELECT COUNT(*)::int AS n FROM support_access_sessions s
  JOIN support_access_requests r ON r.request_id = s.request_id
 WHERE r.reason = 'acceptance probe: revoked actor mismatch'
   AND s.actor_user_link_id IS DISTINCT FROM r.requester_user_link_id`,
    survivors: 1,
  },
  {
    id: 'retained_nonplatform_requester',
    precheck: '§8 — full-scope platform-scope tuple (requester arm)',
    what: 'a retained request whose requester is a dealership link',
    inject: `
-- Lift 059's requester-scope trigger, plant a legacy request filed by a
-- DEALERSHIP link (representable before 059; that is the hole), restore the
-- trigger exactly as 059 declared it.
DROP TRIGGER trg_sar_requester_is_platform ON support_access_requests;
DO $$
DECLARE t uuid; dealer uuid;
BEGIN
  SELECT ul.tenant_id, ul.user_link_id INTO t, dealer FROM user_links ul
    WHERE ul.actor_scope = 'dealership' AND ul.status = 'activated' AND ul.tenant_id IS NOT NULL
    ORDER BY ul.user_link_id LIMIT 1;
  INSERT INTO support_access_requests
    (tenant_id, requester_user_link_id, requested_actions, scope_level, scope_id, reason,
     requested_duration_minutes)
    VALUES (t, dealer, ARRAY['service.ro.view'], 'tenant', NULL,
            'acceptance probe: non-platform requester', 30);
END $$;
CREATE TRIGGER trg_sar_requester_is_platform
  BEFORE INSERT OR UPDATE ON support_access_requests
  FOR EACH ROW EXECUTE FUNCTION support_request_requester_is_platform();
`,
    expect: [
      'migration 060 refused:',
      'name a requester or actor whose user_link is not actor_scope=platform',
      'hard stop',
      'explicitly approved historical-remediation decision',
      'leaves the rows and the migration ledger exactly as they are',
    ],
    survivorSql: `
SELECT COUNT(*)::int AS n FROM support_access_requests r
  JOIN user_links ul ON ul.user_link_id = r.requester_user_link_id
 WHERE r.reason = 'acceptance probe: non-platform requester'
   AND ul.actor_scope <> 'platform'`,
    survivors: 1,
  },
  {
    id: 'retained_nonplatform_session_actor',
    precheck: '§8 — full-scope platform-scope tuple (session-actor arm)',
    what: 'a retained session whose actor is a dealership link',
    inject:
      ENSURE_TWO_PLATFORM_LINKS +
      `
-- The session actor EQUALS its request's requester (so the §8 actor-tuple
-- check, which runs first, stays satisfied and the refusal is attributable to
-- the platform-scope judgment) — and both are a DEALERSHIP link, the legacy
-- shape 059's scope triggers made unrepresentable going forward. Both scope
-- triggers are lifted for the plant and restored exactly as 059 declared
-- them; the tuple key needs no lifting because actor == requester. The
-- approval names no decider (055 admits that) so the in-tenant grant can be
-- held by the requester without tripping the separation CHECK.
DROP TRIGGER trg_sar_requester_is_platform ON support_access_requests;
DROP TRIGGER trg_sas_actor_is_platform ON support_access_sessions;
DO $$
DECLARE t uuid; dealer uuid; reqid uuid; g uuid;
BEGIN
  SELECT ul.tenant_id, ul.user_link_id INTO t, dealer FROM user_links ul
    WHERE ul.actor_scope = 'dealership' AND ul.status = 'activated' AND ul.tenant_id IS NOT NULL
    ORDER BY ul.user_link_id LIMIT 1;
  INSERT INTO support_access_requests
    (tenant_id, requester_user_link_id, requested_actions, scope_level, scope_id, reason,
     requested_duration_minutes)
    VALUES (t, dealer, ARRAY['service.ro.view'], 'tenant', NULL,
            'acceptance probe: non-platform session actor', 30)
    RETURNING request_id INTO reqid;
  g := plant_support_grant(t, dealer, reqid);
  UPDATE support_access_requests
     SET status = 'approved', decided_at = NOW(), decided_by_user_link_id = NULL,
         approval_grant_id = g
   WHERE request_id = reqid;
  INSERT INTO support_access_sessions
    (request_id, tenant_id, actor_user_link_id, granted_at, expires_at,
     revoked_at)
    VALUES (reqid, t, dealer, NOW(), NOW() + INTERVAL '30 minutes', NOW());
END $$;
CREATE TRIGGER trg_sar_requester_is_platform
  BEFORE INSERT OR UPDATE ON support_access_requests
  FOR EACH ROW EXECUTE FUNCTION support_request_requester_is_platform();
CREATE TRIGGER trg_sas_actor_is_platform
  BEFORE INSERT OR UPDATE ON support_access_sessions
  FOR EACH ROW EXECUTE FUNCTION support_session_actor_is_platform();
`,
    expect: [
      'migration 060 refused:',
      'name a requester or actor whose user_link is not actor_scope=platform',
      'session ',
      'hard stop',
      'explicitly approved historical-remediation decision',
    ],
    survivorSql: `
SELECT COUNT(*)::int AS n FROM support_access_sessions s
  JOIN support_access_requests r ON r.request_id = s.request_id
  JOIN user_links ul ON ul.user_link_id = s.actor_user_link_id
 WHERE r.reason = 'acceptance probe: non-platform session actor'
   AND ul.actor_scope <> 'platform'`,
    survivors: 1,
  },
  {
    id: 'standing_approved_defective_scope',
    precheck: '§8 (2 of 2) — standing approved scope',
    what: 'a standing approved request whose scope has since become ineffective',
    inject:
      ENSURE_TWO_PLATFORM_LINKS +
      `
-- Plant a rooftop, approve a request for it, then ARCHIVE the rooftop so the
-- standing approval now names a scope that no longer effectively exists. 059's
-- grant trigger checks the scope AT APPROVAL, so the approval is written while
-- the rooftop is active and only then drifts — no trigger re-fires. This is the
-- retained shape 060 §8 must catch; the approval trigger is disabled only to
-- mint the backing grant coherently, then re-enabled.
DO $$
DECLARE t uuid; grp uuid; ent uuid; rt uuid; requester uuid; decider uuid; g uuid; reqid uuid;
BEGIN
  SELECT ul.tenant_id, ul.user_link_id INTO t, decider FROM user_links ul
    WHERE ul.actor_scope = 'dealership' AND ul.status = 'activated' AND ul.tenant_id IS NOT NULL
    ORDER BY ul.user_link_id LIMIT 1;
  SELECT user_link_id INTO requester FROM user_links WHERE provider_user_id = 'user_acc_probe_a';
  INSERT INTO dealer_groups (dealer_group_id, tenant_id, name, status, created_by_user_link_id,
                             updated_by_user_link_id, authorization_version)
    VALUES (gen_random_uuid(), t, 'Acc Probe Group', 'active', decider, decider, 1)
    RETURNING dealer_group_id INTO grp;
  INSERT INTO legal_entities (legal_entity_id, tenant_id, dealer_group_id, name, status,
                              created_by_user_link_id, updated_by_user_link_id, authorization_version)
    VALUES (gen_random_uuid(), t, grp, 'Acc Probe Entity', 'active', decider, decider, 1)
    RETURNING legal_entity_id INTO ent;
  INSERT INTO rooftops (rooftop_id, tenant_id, legal_entity_id, name, status,
                        created_by_user_link_id, updated_by_user_link_id, authorization_version)
    VALUES (gen_random_uuid(), t, ent, 'Acc Probe Rooftop', 'active', decider, decider, 1)
    RETURNING rooftop_id INTO rt;
  -- 1. the request, pending, at the rooftop scope
  INSERT INTO support_access_requests
    (tenant_id, requester_user_link_id, requested_actions, scope_level, scope_id, reason,
     requested_duration_minutes)
    VALUES (t, requester, ARRAY['service.ro.view'], 'rooftop', rt,
            'acceptance probe: standing defective scope', 30)
    RETURNING request_id INTO reqid;
  -- 2. a real high-assurance grant naming that exact request
  g := plant_support_grant(t, decider, reqid);
  -- 3. approve it while the rooftop is still effective (059's trigger is happy)
  UPDATE support_access_requests
     SET status = 'approved', decided_at = NOW(), decided_by_user_link_id = decider,
         approval_grant_id = g
   WHERE request_id = reqid;
  -- 4. the rooftop drifts out of effectiveness AFTER the approval stands
  UPDATE rooftops SET status = 'archived' WHERE rooftop_id = rt;
END $$;
`,
    expect: [
      'migration 060 refused:',
      'standing approved support request(s) delegate a scope that',
      'hard stop',
      'explicitly approved remediation decision',
      'leaves the rows and the migration ledger exactly as they are',
    ],
    survivorSql: `
SELECT COUNT(*)::int AS n FROM support_access_requests
 WHERE reason = 'acceptance probe: standing defective scope' AND status = 'approved'`,
    survivors: 1,
  },
];

function maintenanceUrl(databaseUrl: string): { admin: string; database: string } {
  const url = new URL(databaseUrl);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  url.pathname = '/postgres';
  return { admin: url.toString(), database };
}

function copyUrl(databaseUrl: string, copyName: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${copyName}`;
  return url.toString();
}

function parseArgs(): { out: string | undefined; log: string | undefined } {
  const argv = process.argv.slice(2);
  let out: string | undefined;
  let log: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === '--out') out = argv[(i += 1)];
    else if (arg === '--log') log = argv[(i += 1)];
    else if (arg.startsWith('--out=')) out = arg.slice('--out='.length);
    else if (arg.startsWith('--log=')) log = arg.slice('--log='.length);
    else {
      console.error(`Unrecognized argument: ${arg}`);
      process.exit(2);
    }
  }
  return { out, log };
}

async function main(): Promise<void> {
  const { out, log } = parseArgs();
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl === '') {
    console.error(
      'DATABASE_URL must name the drill database at 059 + post-059 activity. Copies of it ' +
        'are made, damaged and dropped; the drill database itself is never written to.',
    );
    process.exit(2);
  }
  const { admin, database: template } = maintenanceUrl(databaseUrl);

  // The template must be at EXACTLY 059: 060 not yet applied, so there is a
  // precheck left to fire, and 059 present, so the guards to lift exist.
  {
    const probe = new Client({ connectionString: databaseUrl });
    await probe.connect();
    try {
      const rows = (
        await probe.query<{ filename: string }>(
          `SELECT filename FROM schema_migrations
            WHERE filename LIKE '059%' OR filename LIKE '060%'`,
        )
      ).rows.map((r) => r.filename);
      if (!rows.some((f) => f.startsWith('059')) || rows.some((f) => f.startsWith('060'))) {
        console.error(
          `The drill database '${template}' must hold 059 and NOT 060 (found: ` +
            `${JSON.stringify(rows)}). This script runs BETWEEN the post-059 stages and ` +
            'the application of 060.',
        );
        process.exitCode = 2;
        return;
      }
    } finally {
      await probe.end();
    }
  }

  const lines: string[] = [];
  const results: Array<Record<string, unknown>> = [];
  let failed = 0;
  const client = new Client({ connectionString: admin });
  await client.connect();

  try {
    for (const [index, probe] of PROBES.entries()) {
      const copy = `${template}_acc${index}`.slice(0, 63);
      lines.push(`── ${probe.id} (${probe.precheck})`);
      await client.query(`DROP DATABASE IF EXISTS "${copy}"`);
      await client.query(`CREATE DATABASE "${copy}" TEMPLATE "${template}"`);
      const copied = copyUrl(databaseUrl, copy);
      const problems: string[] = [];

      try {
        const injector = new Client({ connectionString: copied });
        await injector.connect();
        try {
          await injector.query(probe.inject);
          const seeded = (await injector.query<{ n: number }>(probe.survivorSql)).rows[0];
          if (Number(seeded?.n) !== probe.survivors) {
            problems.push(
              `the plant left ${String(seeded?.n)} probe row(s), expected ` +
                `${probe.survivors} — the retained shape was never in front of the precheck`,
            );
          }
        } finally {
          await injector.end();
        }

        if (problems.length === 0) {
          const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: copied };
          delete env.MIGRATIONS_DIR;
          delete env.MIGRATION_FIXTURE_CHAIN;
          const run = spawnSync('npx', ['tsx', join(__dirname, 'migrate.ts')], {
            encoding: 'utf8',
            env,
            shell: IS_WINDOWS,
            maxBuffer: 64 * 1024 * 1024,
            timeout: 300_000,
          });
          const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
          const status = run.status ?? 1;
          if (status === 0) {
            problems.push('migration 060 APPLIED over the retained incoherent row — no refusal');
          }
          for (const fragment of probe.expect) {
            if (!output.includes(fragment)) {
              problems.push(`the refusal does not carry ${JSON.stringify(fragment)}`);
            }
          }

          const after = new Client({ connectionString: copied });
          await after.connect();
          try {
            const ledger = (
              await after.query<{ n: number }>(
                `SELECT COUNT(*)::int AS n FROM schema_migrations WHERE filename LIKE '060%'`,
              )
            ).rows[0];
            if (Number(ledger?.n) !== 0) {
              problems.push('the ledger records 060 on a database whose precheck refused it');
            }
            const survivors = (await after.query<{ n: number }>(probe.survivorSql)).rows[0];
            if (Number(survivors?.n) !== probe.survivors) {
              problems.push(
                `${String(survivors?.n)} probe row(s) remain after the refusal, expected ` +
                  `${probe.survivors} — the precheck must leave history exactly as written`,
              );
            }
          } finally {
            await after.end();
          }
        }
      } finally {
        await client.query(`DROP DATABASE IF EXISTS "${copy}"`);
      }

      const ok = problems.length === 0;
      if (!ok) failed += 1;
      for (const p of problems) lines.push(`   ${p}`);
      lines.push(`   ${ok ? 'PROBE SATISFIED' : 'PROBE FAILED'}: ${probe.what}`);
      results.push({
        id: probe.id,
        precheck: probe.precheck,
        what: probe.what,
        expect_output_contains: probe.expect,
        result: ok ? 'refused-as-declared' : 'failed',
        problems,
      });
    }
  } finally {
    await client.end();
  }

  const summary = {
    tool: 'scripts/upgrade-acceptance-prechecks.ts',
    order: 'FBL-020-R7-C1 §8 + FBL-020-R7-C2 §4',
    taken_at: new Date().toISOString(),
    probes_declared: PROBES.length,
    probes_run: results.length,
    probes_failed: failed,
    probes: results,
  };
  const text = lines.join('\n') + '\n';
  if (out !== undefined) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(summary, null, 2) + '\n', 'utf8');
  }
  if (log !== undefined) {
    mkdirSync(dirname(log), { recursive: true });
    writeFileSync(log, text, 'utf8');
  }
  process.stdout.write(text);
  process.stdout.write(
    `acceptance prechecks: ${results.length - failed} refused-as-declared, ${failed} failed, ` +
      `${results.length}/${PROBES.length} run\n`,
  );
  if (failed > 0) process.exitCode = 1;
}

if (require.main === module) {
  void main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
