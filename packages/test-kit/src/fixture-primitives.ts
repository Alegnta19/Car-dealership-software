/**
 * FBL-020-R4 §5 — THE FIXTURE-ONLY AUTHORIZATION-STATE PRIMITIVE.
 *
 * WHY THIS EXISTS. Removing the unattributed writes from the production packages
 * closes half the boundary. The other half is that the SUITE wrote authorization
 * state directly — user links, role bindings, tenants, connections, sessions,
 * support rows — in about a hundred places, with raw SQL, no actor, no version and
 * no audit row. Two different problems live in that pile, and they need opposite
 * treatments:
 *
 *   1. FIXTURES THAT ESTABLISH AUTHORIZATION. These are the dangerous ones: a
 *      fixture that grants a role by INSERT proves that the ENGINE honours a row,
 *      while proving nothing about the service that is supposed to be the only way
 *      such a row can appear. R3's review found exactly this shape — a test that
 *      still passed with a security predicate deleted. Wherever an attributed
 *      service exists, the fixtures now call it (`grantRole`,
 *      `createOrganizationUnit`, `createOrganization`, `activateUserLink`, …).
 *
 *   2. FIXTURES THAT DEGRADE OR CORRUPT STATE ON PURPOSE. A suite has to be able to
 *      produce an expired window, a revoked binding, a link whose effective_to is in
 *      the past, a session that outlived its connection — precisely the states the
 *      production services REFUSE to create. There is no attributed service for
 *      them and there must not be, because a service that could write them would be
 *      a hole. They stay raw, and they go through this one function.
 *
 * WHAT THIS FUNCTION BUYS, as opposed to calling `query` directly:
 *
 *   - ONE NAME TO GREP. Every remaining bypass in the repository is a call to
 *     `fixtureAuthorizationStateWrite`, so counting them is `grep -c`, and
 *     `scripts/check-owned-mutations.ts` FAILS the build on any authorization-state
 *     write in `tests/**` or `packages/test-kit/**` that is not one.
 *   - A TYPED REASON. The reason is a closed union rather than prose, so it is
 *     checked by the compiler at every site and can be counted per class.
 *   - IT CANNOT BE REACHED FROM PRODUCTION CODE. Three independent reasons: this
 *     module lives in `@dealer/test-kit`, which the architecture manifest forbids
 *     every production package and app from depending on; the module refuses to load
 *     unless a disposable `TEST_DATABASE_URL` is configured; and every call re-checks
 *     that at run time, so an import smuggled in some other way still writes nothing.
 *
 * It is deliberately NOT a convenience. If a fixture can be written through an
 * attributed service, it must be.
 */
import { query } from '@dealer/database';
import { INTEGRATION_DATABASE_URL } from './db';

/**
 * WHY a fixture is writing authorization state raw. Closed on purpose: a new reason
 * is a decision somebody makes in this file, not a sentence typed at a call site.
 */
export type FixtureWriteReason =
  /** Building a starting state for which no attributed service exists yet. */
  | 'seed-authorization-state'
  /** Producing a state the production services REFUSE to write — the point of the test. */
  | 'simulate-authorization-drift'
  /** Standing in for an attacker or a buggy caller, to prove the platform refuses. */
  | 'adversarial-bypass-attempt';

interface FixtureWriteCounters {
  readonly total: number;
  readonly byReason: Readonly<Record<FixtureWriteReason, number>>;
}

const counters: Record<FixtureWriteReason, number> = {
  'seed-authorization-state': 0,
  'simulate-authorization-drift': 0,
  'adversarial-bypass-attempt': 0,
};

/**
 * How many fixture bypasses this process has performed, by reason.
 *
 * Exposed so a test can assert about the suite's own discipline — the count of
 * bypasses is a number somebody can watch, rather than a habit nobody measures.
 */
export function fixtureWriteCounters(): FixtureWriteCounters {
  return {
    total: Object.values(counters).reduce((a, b) => a + b, 0),
    byReason: { ...counters },
  };
}

function assertFixtureEnvironment(): void {
  if (INTEGRATION_DATABASE_URL === undefined || INTEGRATION_DATABASE_URL.length === 0) {
    throw new Error(
      'fixtureAuthorizationStateWrite is fixture-only: it refuses to run without a ' +
        'disposable TEST_DATABASE_URL. Production code must use the attributed mutation ' +
        'services in @dealer/identity-access.',
    );
  }
}

// Refuses at MODULE LOAD as well as per call. A production process that somehow
// imported this file fails immediately and visibly, rather than at the first write.
assertFixtureEnvironment();

/**
 * Executes ONE raw authorization-state statement on behalf of a fixture.
 *
 * The SQL is the caller's, unchanged — wrapping it would hide what the test is
 * actually doing, and a test that lies about the state it built is worse than no
 * test. What this adds is the name, the typed reason, the counter and the
 * environment refusal.
 */
export async function fixtureAuthorizationStateWrite(
  reason: FixtureWriteReason,
  sql: string,
  params?: readonly unknown[],
): ReturnType<typeof query> {
  assertFixtureEnvironment();
  counters[reason] += 1;
  return query(sql, params === undefined ? undefined : [...params]);
}
