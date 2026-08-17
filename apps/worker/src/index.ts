/**
 * @dealer/worker — the background process's public surface.
 *
 * `main` is the entry point the deployment runs; the job registry and the single-pass
 * entry points are exported so a test can drive EXACTLY what production drives instead
 * of re-implementing a pass of its own (FBL-020-R4 §4: the flow has to be reachable, and
 * a test that reached a copy of it would prove nothing about the copy that ships).
 */
export {
  SUPPORT_ACCESS_EXPIRY_JOB,
  WORKER_JOBS,
  main,
  runAllJobsOnce,
  runSupportAccessExpiryOnce,
  startWorker,
} from './main';
