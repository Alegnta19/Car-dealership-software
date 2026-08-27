/**
 * @dealer/worker — the background process's public surface.
 *
 * `main` is the entry point the deployment runs; the job registry and the single-pass
 * entry points are exported so a test can drive EXACTLY what production drives instead
 * of re-implementing a pass of its own (FBL-020-R4 §4: the flow has to be reachable, and
 * a test that reached a copy of it would prove nothing about the copy that ships).
 */
export {
  ADMIN_OUTBOX_DISPATCH_JOB,
  LOGIN_TRANSACTION_EXPIRY_JOB,
  REAUTHENTICATION_EXPIRY_JOB,
  SUPPORT_ACCESS_EXPIRY_JOB,
  WORKER_JOBS,
  main,
  runAdminOutboxDispatchOnce,
  runAllJobsOnce,
  runLoginTransactionExpiryOnce,
  runReauthenticationExpiryOnce,
  runSupportAccessExpiryOnce,
  startWorker,
} from './main';
