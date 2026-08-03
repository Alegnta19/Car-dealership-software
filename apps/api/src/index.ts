/**
 * @dealer/api — composition root for the service-cockpit HTTP API.
 * Also the public surface tests use to reach the transport layer.
 */
export { createApp } from './app';
export { default as serviceCockpitRouter } from './routes/service-cockpit';
export { default as authRouter } from './routes/auth';
export { resetAuthRoutesForTests } from './routes/auth';
export {
  authenticate,
  requireAction,
  rejectTenantOverride,
  requireContext,
  resetIdentityCompositionForTests,
} from './middleware/auth';
export { errorHandler, notFoundHandler } from './middleware/error-handler';
