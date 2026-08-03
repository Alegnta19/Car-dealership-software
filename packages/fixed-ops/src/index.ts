/**
 * @dealer/fixed-ops — sole owner of the service-cockpit domain and application behavior.
 *
 * `legacy/service-cockpit-service.ts` is explicitly a legacy mixed
 * application/persistence component: FBL-060 owns its use-case decomposition. Until
 * then it moves as one unit, unsplit and behavior-identical.
 */
export * from './domain/authorization';
export * from './domain/state-machine';
export * from './domain/standard-mpi-template';
export * from './security/sensitive-action';
export * from './legacy/service-cockpit-service';
export { refreshAggregatedMetrics, startMetricsAggregation } from './legacy/metrics-aggregator';
export * from './domain/action-catalog';
export * from './security/scope-resolver';
