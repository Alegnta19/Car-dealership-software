/**
 * @dealer/worker — buildable worker shell (FBL-010).
 *
 * Deliberately job-free: no queues, schedulers, or dealership workflows are authorized
 * until the durable-events order (FBL-040). The shell exists so the deployment topology,
 * dependency rules, and build pipeline are already proven when real jobs arrive.
 * Not part of the production deployment topology in this order.
 */
export function main(): void {
  // Smoke contract: constructing the process must succeed and exit cleanly.
  process.stdout.write(
    JSON.stringify({ level: 'info', msg: 'worker shell: no jobs registered (by design)' }) + '\n',
  );
}

if (require.main === module) {
  main();
}
