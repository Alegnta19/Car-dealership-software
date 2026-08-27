/**
 * FBL-020-R7-C2 §4 — THE 057 TENANT-MISMATCH PRECHECK, PROVEN TO REFUSE, ON A COPY.
 *
 *   DATABASE_URL=postgres://…/<the drill database at 056 + seeded legacy identity> \
 *     MIGRATIONS_DIR=<the staged pre-058 chain> MIGRATION_FIXTURE_CHAIN=pre-058 \
 *     npx tsx scripts/upgrade-precheck-refusals-057.ts \
 *       --out artifacts/precheck-refusals-057.json [--log artifacts/precheck-refusals-057.txt]
 *
 * C2 §4 names five representative retained-data fixtures; four are the 060
 * acceptance-precheck probes, and this is the fifth — the EXISTING migration-057
 * tenant-mismatch refusal, exercised rather than assumed. 057's own precheck
 * DO-block refuses a retained support session that names a DIFFERENT tenant
 * than the request it was granted under; the 055/056 schema admits that row
 * (no composite key relates the two yet — the hole 057's `sas_request_same_tenant`
 * closes, installed WITHOUT `NOT VALID`), so a damaged legacy database could
 * really carry it into the upgrade.
 *
 * The probe copies the pre-057 drill database, plants exactly one such session
 * through plain SQL, runs the REAL migration runner over the staged pre-058
 * chain, and requires:
 *
 *   1. a non-zero exit whose output carries 057's own message;
 *   2. the ledger clean — 057 not recorded on the refused copy, so the refusal
 *      was transactional and left no partial schema or data mutation behind;
 *   3. the planted rows still present, exactly as written.
 *
 * The environment (MIGRATIONS_DIR / MIGRATION_FIXTURE_CHAIN) is passed through
 * UNCHANGED, unlike the 059/060 probe runners which reset it: this probe runs
 * at the drill's pre-057 stage, where the canonical directory would not even
 * declare the fixture chain in use.
 */
import { spawnSync } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { Client } from 'pg';

const IS_WINDOWS = process.platform === 'win32';

const INJECT = `
DO $$
DECLARE t1 uuid; t2 uuid; requester uuid; reqid uuid;
BEGIN
  SELECT tenant_id INTO t1 FROM tenants ORDER BY tenant_id LIMIT 1;
  SELECT tenant_id INTO t2 FROM tenants WHERE tenant_id <> t1 ORDER BY tenant_id LIMIT 1;
  IF t2 IS NULL THEN
    INSERT INTO tenants (name, status) VALUES ('Probe 057 Second Tenant', 'active')
      RETURNING tenant_id INTO t2;
  END IF;
  SELECT user_link_id INTO requester FROM user_links ORDER BY user_link_id LIMIT 1;
  IF requester IS NULL THEN
    RAISE EXCEPTION 'probe 057: the pre-057 fixture holds no user_links to name';
  END IF;
  INSERT INTO support_access_requests
    (tenant_id, requester_user_link_id, requested_actions, reason,
     requested_duration_minutes, scope_level, scope_id, status,
     decided_at, decided_by_user_link_id)
    VALUES (t1, requester, ARRAY['service.ro.view'],
            'probe 057: tenant mismatch', 30, 'tenant', NULL, 'approved', NOW(),
            (SELECT user_link_id FROM user_links WHERE user_link_id <> requester
              ORDER BY user_link_id LIMIT 1))
    RETURNING request_id INTO reqid;
  -- THE MISMATCH: the session is granted in the OTHER tenant. Nothing in the
  -- 055/056 schema relates the two tenants — exactly the retained shape 057's
  -- precheck exists to refuse.
  INSERT INTO support_access_sessions
    (request_id, tenant_id, actor_user_link_id, granted_at, expires_at)
    VALUES (reqid, t2, requester, NOW(), NOW() + INTERVAL '30 minutes');
END $$;
`;

const EXPECT = [
  'FBL-020-R4 refused:',
  'support session(s) name a different tenant than',
] as const;

const SURVIVOR_SQL = `
SELECT COUNT(*)::int AS n FROM support_access_sessions s
  JOIN support_access_requests r ON r.request_id = s.request_id
 WHERE r.tenant_id <> s.tenant_id`;

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
      'DATABASE_URL must name the drill database at 056 + the seeded legacy identity ' +
        'fixture. A copy of it is made, damaged and dropped; the drill database itself ' +
        'is never written to.',
    );
    process.exit(2);
  }
  const { admin, database: template } = maintenanceUrl(databaseUrl);

  // The template must be at EXACTLY 056: 057 not yet applied, so the precheck
  // is still ahead, and 055/056 present, so the tables being planted exist.
  {
    const probe = new Client({ connectionString: databaseUrl });
    await probe.connect();
    try {
      const rows = (
        await probe.query<{ filename: string }>(
          `SELECT filename FROM schema_migrations
            WHERE filename LIKE '056%' OR filename LIKE '057%'`,
        )
      ).rows.map((r) => r.filename);
      if (!rows.some((f) => f.startsWith('056')) || rows.some((f) => f.startsWith('057'))) {
        console.error(
          `The drill database '${template}' must hold 056 and NOT 057 (found: ` +
            `${JSON.stringify(rows)}). This script runs at the drill's pre-057 stage.`,
        );
        process.exitCode = 2;
        return;
      }
    } finally {
      await probe.end();
    }
  }

  const lines: string[] = [];
  const problems: string[] = [];
  const copy = `${template}_p057`.slice(0, 63);
  const client = new Client({ connectionString: admin });
  await client.connect();
  lines.push('── retained_cross_tenant_session (057 precheck — R4 tenant coherence)');

  try {
    await client.query(`DROP DATABASE IF EXISTS "${copy}"`);
    await client.query(`CREATE DATABASE "${copy}" TEMPLATE "${template}"`);
    const copied = copyUrl(databaseUrl, copy);

    try {
      const injector = new Client({ connectionString: copied });
      await injector.connect();
      try {
        await injector.query(INJECT);
        const seeded = (await injector.query<{ n: number }>(SURVIVOR_SQL)).rows[0];
        if (Number(seeded?.n) !== 1) {
          problems.push(
            `the plant left ${String(seeded?.n)} probe row(s), expected 1 — the retained ` +
              'shape was never in front of the precheck',
          );
        }
      } finally {
        await injector.end();
      }

      if (problems.length === 0) {
        const run = spawnSync('npx', ['tsx', join(__dirname, 'migrate.ts')], {
          encoding: 'utf8',
          env: { ...process.env, DATABASE_URL: copied },
          shell: IS_WINDOWS,
          maxBuffer: 64 * 1024 * 1024,
          timeout: 300_000,
        });
        const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
        const status = run.status ?? 1;
        if (status === 0) {
          problems.push('migration 057 APPLIED over the retained cross-tenant session — no refusal');
        }
        for (const fragment of EXPECT) {
          if (!output.includes(fragment)) {
            problems.push(`the refusal does not carry ${JSON.stringify(fragment)}`);
          }
        }

        const after = new Client({ connectionString: copied });
        await after.connect();
        try {
          const ledger = (
            await after.query<{ n: number }>(
              `SELECT COUNT(*)::int AS n FROM schema_migrations WHERE filename LIKE '057%'`,
            )
          ).rows[0];
          if (Number(ledger?.n) !== 0) {
            problems.push('the ledger records 057 on a database whose precheck refused it');
          }
          const survivors = (await after.query<{ n: number }>(SURVIVOR_SQL)).rows[0];
          if (Number(survivors?.n) !== 1) {
            problems.push(
              `${String(survivors?.n)} probe row(s) remain after the refusal, expected 1 — ` +
                'the precheck must be transactional and leave history exactly as written',
            );
          }
        } finally {
          await after.end();
        }
      }
    } finally {
      await client.query(`DROP DATABASE IF EXISTS "${copy}"`);
    }
  } finally {
    await client.end();
  }

  const ok = problems.length === 0;
  for (const p of problems) lines.push(`   ${p}`);
  lines.push(
    `   ${ok ? 'PROBE SATISFIED' : 'PROBE FAILED'}: a retained session naming a different ` +
      'tenant than its request',
  );
  const summary = {
    tool: 'scripts/upgrade-precheck-refusals-057.ts',
    order: 'FBL-020-R7-C2 §4',
    taken_at: new Date().toISOString(),
    probes_declared: 1,
    probes_run: 1,
    probes_failed: ok ? 0 : 1,
    probes: [
      {
        id: 'retained_cross_tenant_session',
        precheck: '057 — R4 tenant coherence',
        what: 'a retained session naming a different tenant than its request',
        expect_output_contains: EXPECT,
        result: ok ? 'refused-as-declared' : 'failed',
        problems,
      },
    ],
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
    `057 precheck refusal: ${ok ? '1 refused-as-declared, 0 failed' : '0 refused-as-declared, 1 failed'}, 1/1 run\n`,
  );
  if (!ok) process.exitCode = 1;
}

if (require.main === module) {
  void main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
