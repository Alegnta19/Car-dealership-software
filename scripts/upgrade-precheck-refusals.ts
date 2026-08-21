/**
 * FBL-020-R7 §4.5 — THE 059 PRECHECKS, PROVEN TO REFUSE, ON COPIES OF THE REAL DRILL.
 *
 *   DATABASE_URL=postgres://…/<the drill database, at 058 + post-058 activity> \
 *     npx tsx scripts/upgrade-precheck-refusals.ts --out artifacts/precheck-refusals.json \
 *       [--log artifacts/precheck-refusals.txt]
 *
 * ── WHAT THIS PROVES THAT NOTHING ELSE DOES ────────────────────────────────
 *
 * Migration 059 §0 carries five prechecks over RETAINED support rows. On the drill
 * database they all pass — its rows are honest — which means the drill alone shows
 * the prechecks not firing, never that they fire, are bounded, name the offending
 * rows, and tell the operator a truthful lifecycle action (revoke or supersede,
 * never "edit the evidence"). The negative-control precedent (R6 §D2) applies: a
 * refusal that has never been observed refusing is a comment, not a control.
 *
 * So each probe here:
 *
 *   1. copies the drill database (`CREATE DATABASE … TEMPLATE`) — the drill itself
 *      is never written to and the probes cannot contaminate each other;
 *   2. injects ONE invalid-but-058-legal retained shape into the COPY, through
 *      plain SQL, exactly as a damaged production database would already hold it;
 *   3. runs the REAL migration runner over the canonical chain and requires a
 *      non-zero exit whose output carries the precheck's own bounded message —
 *      the count, the listed ids, and the documented action;
 *   4. requires the copy to be left EXACTLY as refused: 059 not recorded in the
 *      ledger, and the injected rows still present, byte-for-byte unmodified —
 *      "the sessions and their requests stay exactly as written";
 *   5. drops the copy.
 *
 * A probe whose injection does NOT stop 059 is a FAILED probe and this script
 * exits non-zero.
 *
 * ── WHY THE INJECTIONS ARE RAW SQL ─────────────────────────────────────────
 *
 * The point of a precheck is a row the RUNTIME would never write — the shapes
 * below are exactly the ones 059's triggers make unrepresentable afterwards. At
 * 058 they are representable, which is the hole; SQL is how such a row would
 * really exist, and anything higher-level would refuse to produce it.
 */
import { spawnSync } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { Client } from 'pg';

const IS_WINDOWS = process.platform === 'win32';

/**
 * The shared preamble for probes that need a PLATFORM actor: at 058 nothing binds
 * support rows to platform scope (that is finding §3.1), but prechecks 3–5 fire on
 * rows that get PAST prechecks 1–2, so their fixtures need a link that really is
 * platform-scope. Idempotent against a drill that already has one.
 */
const ENSURE_PLATFORM_LINK = `
INSERT INTO identity_provider_connections
  (connection_scope, tenant_id, provider, provider_organization_id, status, issuer)
SELECT 'platform', NULL, 'workos', 'org_platform_precheck_probe', 'active',
       (SELECT issuer FROM identity_provider_connections WHERE status = 'active' LIMIT 1)
 WHERE NOT EXISTS (
   SELECT 1 FROM identity_provider_connections WHERE tenant_id IS NULL AND status = 'active'
 );
INSERT INTO user_links
  (actor_scope, tenant_id, provider, provider_user_id, status, activated_at,
   connection_id, issuer, provider_organization_id)
SELECT 'platform', NULL, 'workos', 'user_precheck_probe_platform', 'activated', NOW(),
       c.connection_id, c.issuer, c.provider_organization_id
  FROM identity_provider_connections c
 WHERE c.tenant_id IS NULL AND c.status = 'active'
 LIMIT 1;
`;

interface Probe {
  id: string;
  /** Which 059 §0 precheck this fires, in the order the migration asks them. */
  precheck: string;
  what: string;
  /** SQL run against the COPY before the migration runner is invoked. */
  inject: string;
  /** Every one of these substrings must appear in the runner's output. */
  expect: readonly string[];
  /** SELECT returning `n`; must equal `survivors` AFTER the refused migration. */
  survivorSql: string;
  survivors: number;
}

/**
 * Reason strings double as row markers: each probe's survivor query finds its own
 * rows by the reason it wrote, so "left exactly as written" is checked per probe.
 */
export const PROBES: readonly Probe[] = [
  {
    id: 'session_actor_substituted',
    precheck: '§3.1 (1 of 5)',
    what: 'a retained session whose actor is not its request’s approved requester',
    inject: `
WITH requester AS (
  SELECT user_link_id, tenant_id FROM user_links
   WHERE actor_scope = 'dealership' AND status = 'activated' AND tenant_id IS NOT NULL
   ORDER BY user_link_id LIMIT 1
), actor AS (
  SELECT user_link_id FROM user_links
   WHERE tenant_id = (SELECT tenant_id FROM requester) AND status = 'activated'
     AND user_link_id <> (SELECT user_link_id FROM requester)
   ORDER BY user_link_id LIMIT 1
), req AS (
  INSERT INTO support_access_requests
    (tenant_id, requester_user_link_id, requested_actions, scope_level, scope_id,
     reason, requested_duration_minutes)
  SELECT tenant_id, user_link_id, ARRAY['service.ro.view'], 'tenant', NULL,
         'precheck probe: substituted actor', 30
    FROM requester
  RETURNING request_id, tenant_id
)
INSERT INTO support_access_sessions (request_id, tenant_id, actor_user_link_id, expires_at)
SELECT req.request_id, req.tenant_id, (SELECT user_link_id FROM actor),
       NOW() + INTERVAL '30 minutes'
  FROM req;
`,
    expect: [
      'migration 059 refused: 1 LIVE support session(s) name an actor who is not the',
      'approved requester of their own request (first ids:',
      'REVOKE each listed session through the support-access',
    ],
    survivorSql: `
SELECT COUNT(*)::int AS n
  FROM support_access_sessions s
  JOIN support_access_requests r ON r.request_id = s.request_id
 WHERE r.reason = 'precheck probe: substituted actor'
   AND s.actor_user_link_id IS DISTINCT FROM r.requester_user_link_id`,
    survivors: 1,
  },
  {
    id: 'dealership_link_as_requester',
    precheck: '§3.1 (2 of 5)',
    what: 'a retained request whose requester is a dealership-scope link',
    inject: `
INSERT INTO support_access_requests
  (tenant_id, requester_user_link_id, requested_actions, scope_level, scope_id,
   reason, requested_duration_minutes)
SELECT tenant_id, user_link_id, ARRAY['service.ro.view'], 'tenant', NULL,
       'precheck probe: dealership requester', 30
  FROM user_links
 WHERE actor_scope = 'dealership' AND status = 'activated' AND tenant_id IS NOT NULL
 ORDER BY user_link_id LIMIT 1;
`,
    expect: [
      'migration 059 refused: 1 LIVE support request(s)/session(s) name a requester or',
      'actor whose user_link is not actor_scope=platform (first: request',
      'Revoke each listed',
    ],
    survivorSql: `
SELECT COUNT(*)::int AS n FROM support_access_requests
 WHERE reason = 'precheck probe: dealership requester'`,
    survivors: 1,
  },
  {
    id: 'session_under_an_undecided_request',
    precheck: '§3.2 (3 of 5)',
    what: 'a retained session granted against a request nobody decided',
    inject:
      ENSURE_PLATFORM_LINK +
      `
WITH p AS (
  SELECT user_link_id FROM user_links
   WHERE actor_scope = 'platform' AND status = 'activated'
   ORDER BY user_link_id LIMIT 1
), req AS (
  INSERT INTO support_access_requests
    (tenant_id, requester_user_link_id, requested_actions, scope_level, scope_id,
     reason, requested_duration_minutes)
  SELECT t.tenant_id, p.user_link_id, ARRAY['service.ro.view'], 'tenant', NULL,
         'precheck probe: undecided request', 30
    FROM (SELECT tenant_id FROM tenants ORDER BY tenant_id LIMIT 1) t, p
  RETURNING request_id, tenant_id
)
INSERT INTO support_access_sessions (request_id, tenant_id, actor_user_link_id, expires_at)
SELECT req.request_id, req.tenant_id, (SELECT user_link_id FROM p),
       NOW() + INTERVAL '30 minutes'
  FROM req;
`,
    expect: [
      'migration 059 refused: 1 LIVE support session(s) were granted before their request',
      'was decided, or against an undecided request (first ids:',
      'REVOKE each listed session',
    ],
    survivorSql: `
SELECT COUNT(*)::int AS n
  FROM support_access_sessions s
  JOIN support_access_requests r ON r.request_id = s.request_id
 WHERE r.reason = 'precheck probe: undecided request'`,
    survivors: 1,
  },
  {
    id: 'session_outlives_the_requested_duration',
    precheck: '§3.2 (4 of 5)',
    what: 'a retained session expiring later than its request’s own duration',
    inject:
      ENSURE_PLATFORM_LINK +
      `
WITH p AS (
  SELECT user_link_id FROM user_links
   WHERE actor_scope = 'platform' AND status = 'activated'
   ORDER BY user_link_id LIMIT 1
), decider AS (
  SELECT user_link_id, tenant_id FROM user_links
   WHERE actor_scope = 'dealership' AND status = 'activated' AND tenant_id IS NOT NULL
   ORDER BY user_link_id LIMIT 1
), req AS (
  INSERT INTO support_access_requests
    (tenant_id, requester_user_link_id, requested_actions, scope_level, scope_id,
     reason, requested_duration_minutes, status, decided_at, decided_by_user_link_id)
  SELECT d.tenant_id, p.user_link_id, ARRAY['service.ro.view'], 'tenant', NULL,
         'precheck probe: overlong session', 30, 'denied',
         NOW() - INTERVAL '1 hour', d.user_link_id
    FROM decider d, p
  RETURNING request_id, tenant_id
)
INSERT INTO support_access_sessions
  (request_id, tenant_id, actor_user_link_id, granted_at, expires_at)
SELECT req.request_id, req.tenant_id, (SELECT user_link_id FROM p),
       NOW() - INTERVAL '30 minutes', NOW() + INTERVAL '15 minutes'
  FROM req;
`,
    expect: [
      'migration 059 refused: 1 LIVE support session(s) expire later than the duration',
      'their own request asked for (first ids:',
      'An approval of N minutes cannot produce a',
    ],
    survivorSql: `
SELECT COUNT(*)::int AS n
  FROM support_access_sessions s
  JOIN support_access_requests r ON r.request_id = s.request_id
 WHERE r.reason = 'precheck probe: overlong session'
   AND s.expires_at > s.granted_at + make_interval(mins => r.requested_duration_minutes)`,
    survivors: 1,
  },
  {
    id: 'approval_cites_a_foreign_purpose_grant',
    precheck: '§3.2 (5 of 5)',
    what: 'a retained approval citing a REAL grant that approves something else entirely',
    inject:
      ENSURE_PLATFORM_LINK +
      `
WITH g AS (
  SELECT grant_id, user_link_id, tenant_id FROM reauthentication_grants
   WHERE action <> 'identity.support.approve' AND tenant_id IS NOT NULL
   ORDER BY created_at LIMIT 1
), p AS (
  SELECT user_link_id FROM user_links
   WHERE actor_scope = 'platform' AND status = 'activated'
   ORDER BY user_link_id LIMIT 1
)
INSERT INTO support_access_requests
  (tenant_id, requester_user_link_id, requested_actions, scope_level, scope_id,
   reason, requested_duration_minutes, status, decided_at, decided_by_user_link_id,
   approval_grant_id)
SELECT g.tenant_id, p.user_link_id, ARRAY['service.ro.view'], 'tenant', NULL,
       'precheck probe: wrong grant', 30, 'approved', NOW(), g.user_link_id, g.grant_id
  FROM g, p;
`,
    expect: [
      'migration 059 refused: 1 STANDING support approval(s) cite a reauthentication grant',
      'that is not an identity.support.approve grant for that exact request at',
      'SUPERSEDE each listed',
    ],
    survivorSql: `
SELECT COUNT(*)::int AS n FROM support_access_requests
 WHERE reason = 'precheck probe: wrong grant' AND status = 'approved'
   AND approval_grant_id IS NOT NULL`,
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

interface Args {
  out: string | undefined;
  log: string | undefined;
}

function parseArgs(): Args {
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
      'DATABASE_URL must name the drill database at 058 + post-058 activity. Copies of it ' +
        'are made, damaged and dropped; the drill database itself is never written to.',
    );
    process.exit(2);
  }
  const { admin, database: template } = maintenanceUrl(databaseUrl);

  // The template must be at EXACTLY 058: with 059 already applied there is no
  // precheck left to fire, and every probe would report a false failure.
  {
    const probe = new Client({ connectionString: databaseUrl });
    await probe.connect();
    try {
      const rows = (
        await probe.query<{ filename: string }>(
          `SELECT filename FROM schema_migrations
            WHERE filename LIKE '058%' OR filename LIKE '059%'`,
        )
      ).rows.map((r) => r.filename);
      if (!rows.some((f) => f.startsWith('058')) || rows.some((f) => f.startsWith('059'))) {
        console.error(
          `The drill database '${template}' must hold 058 and NOT 059 (found: ` +
            `${JSON.stringify(rows)}). This script runs BETWEEN the post-058 stages and ` +
            'the application of 059.',
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
      const copy = `${template}_pc${index}`.slice(0, 63);
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
              `the injection left ${String(seeded?.n)} probe row(s), expected ` +
                `${probe.survivors} — the invalid shape was never in front of the precheck`,
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
            problems.push('migration 059 APPLIED over the invalid retained row — no refusal');
          }
          for (const fragment of probe.expect) {
            if (!output.includes(fragment)) {
              problems.push(`the refusal does not carry ${JSON.stringify(fragment)}`);
            }
          }

          // Refused means REFUSED: 059 absent from the ledger, the rows untouched.
          const after = new Client({ connectionString: copied });
          await after.connect();
          try {
            const ledger = (
              await after.query<{ n: number }>(
                `SELECT COUNT(*)::int AS n FROM schema_migrations WHERE filename LIKE '059%'`,
              )
            ).rows[0];
            if (Number(ledger?.n) !== 0) {
              problems.push('the ledger records 059 on a database whose precheck refused it');
            }
            const survivors = (await after.query<{ n: number }>(probe.survivorSql)).rows[0];
            if (Number(survivors?.n) !== probe.survivors) {
              problems.push(
                `${String(survivors?.n)} probe row(s) remain after the refusal, expected ` +
                  `${probe.survivors} — the precheck must leave the rows exactly as written`,
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
    tool: 'scripts/upgrade-precheck-refusals.ts',
    order: 'FBL-020-R7 §4.5',
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
    `precheck refusals: ${results.length - failed} refused-as-declared, ${failed} failed, ` +
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
