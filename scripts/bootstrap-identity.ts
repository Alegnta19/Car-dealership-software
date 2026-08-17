/**
 * FBL-020 tenant identity bootstrap — the ONLY sanctioned way to mint the
 * first tenant administrator.
 *
 *   DATABASE_URL=... npx tsx scripts/bootstrap-identity.ts \
 *     --tenant-id <uuid> --tenant-name "Delta Motors Group" \
 *     --provider-org org_... --issuer https://<env>.authkit.app \
 *     --admin-user user_... [--admin-email a@b.c] [--apply]
 *
 * `--issuer` is REQUIRED. The issuer is the trust anchor every request is
 * checked against (R1 section C), so a connection this command cannot state an
 * issuer for is a connection that would authorize nothing — there is no
 * default and nothing is guessed.
 *
 * DRY-RUN BY DEFAULT: without --apply it prints the plan and writes nothing.
 * Idempotent: re-running against an already-bootstrapped tenant changes nothing
 * and says so. Ambiguity refuses loudly. Prints identifiers only — never a
 * credential, an API key or a cookie value.
 *
 * FBL-020-R4 §5 — THIS FILE NO LONGER WRITES ANYTHING, AND THAT IS THE POINT.
 *
 * It used to hold six raw writes — tenant, provider connection, user link, role
 * binding — none of which named an acting user on the row, advanced
 * `authorization_version`, or wrote a per-step audit event; and it decided what to
 * write from reads taken BEFORE its transaction, so two concurrent runs could each
 * see "nothing here yet". Every one of those writes now lives in
 * `bootstrapIdentityOrigin` in @dealer/identity-access, which is the module that
 * owns the identity tables and the attribution contract, and which does the reads,
 * the refusals and the writes inside ONE transaction.
 *
 * What is left here is what a script should be: argument parsing, one call, and
 * printing. `scripts/check-owned-mutations.ts` fails the build if a write to an
 * authorization-state table ever reappears in this file.
 */
import { closePool } from '@dealer/database';
import {
  BootstrapRefused,
  bootstrapIdentityOrigin,
  type BootstrapOptions,
  type BootstrapStep,
} from '@dealer/identity-access';

export { BootstrapRefused };
export type { BootstrapOptions, BootstrapStep };

/**
 * The name this command has always been called by, kept as the entry point so
 * operator runbooks and the identity suites do not have to learn a new one. The
 * implementation is the attributed service.
 */
export async function bootstrapIdentity(options: BootstrapOptions): Promise<BootstrapStep[]> {
  return bootstrapIdentityOrigin(options);
}

function parseArgs(argv: readonly string[]): BootstrapOptions {
  const get = (flag: string): string | undefined => {
    const idx = argv.indexOf(flag);
    return idx >= 0 && idx + 1 < argv.length ? argv[idx + 1] : undefined;
  };
  const tenantId = get('--tenant-id');
  const tenantName = get('--tenant-name');
  const providerOrganizationId = get('--provider-org');
  const adminProviderUserId = get('--admin-user');
  const issuer = get('--issuer');
  if (!tenantId || !tenantName || !providerOrganizationId || !adminProviderUserId || !issuer) {
    console.error(
      'usage: bootstrap-identity.ts --tenant-id <uuid> --tenant-name <name> --provider-org <org> --issuer <url> --admin-user <user> [--admin-email <email>] [--apply]',
    );
    process.exit(2);
  }
  return {
    tenantId,
    tenantName,
    providerOrganizationId,
    issuer,
    adminProviderUserId,
    adminEmail: get('--admin-email') ?? null,
    apply: argv.includes('--apply'),
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const steps = await bootstrapIdentity(options);
  const mode = options.apply ? 'APPLIED' : 'DRY-RUN (nothing written; pass --apply to execute)';
  console.log(`bootstrap ${mode}`);
  for (const step of steps) {
    console.log(`  ${step.step}: ${step.action} — ${step.detail}`);
  }
}

// Only run as a CLI, never on import (tests import bootstrapIdentity directly).
if (process.argv[1] !== undefined && /bootstrap-identity\.ts$/.test(process.argv[1])) {
  main()
    .catch((err) => {
      if (err instanceof BootstrapRefused) {
        console.error('REFUSED: ' + err.message);
      } else {
        console.error(err);
      }
      process.exitCode = 1;
    })
    .finally(() => closePool());
}
