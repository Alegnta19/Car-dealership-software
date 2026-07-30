/**
 * @dealer/api — composition root for the service-cockpit HTTP API.
 * Also the public surface tests use to reach the transport layer.
 */
export { createApp } from './app';
export { default as serviceCockpitRouter } from './routes/service-cockpit';
export { authenticate, authorize, rejectTenantOverride, requireContext } from './middleware/auth';
export { errorHandler, notFoundHandler } from './middleware/error-handler';
