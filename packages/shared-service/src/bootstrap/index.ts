/**
 * Fastify service bootstrap building blocks.
 *
 * Most services should call `bootstrapService` from
 * `@polaris/shared-service-bootstrap` directly. The individual helpers
 * exported here exist so services that need to compose a non-standard
 * Fastify instance can still reuse Polaris's request-ID generation, error
 * handler, and route plugins.
 */

export {
  createProblemErrorHandler,
  createProblemNotFoundHandler,
  type ProblemErrorHandlerOptions,
} from "./error-handler.js";
export {
  registerHealthRoutes,
  type HealthPluginOptions,
  type ReadinessProbe,
  type ReadinessProbeResult,
  type ServiceInfo,
} from "./health.js";
export {
  PROMETHEUS_CONTENT_TYPE,
  registerMetricsRoute,
  type MetricsPluginOptions,
  type MetricsProducer,
} from "./metrics.js";
export { NOOP_OPENAPI_SETUP, type OpenApiMetadata, type OpenApiSetup } from "./openapi.js";
export {
  genReqId,
  installRequestIdHook,
  RESPONSE_REQUEST_ID_HEADER,
} from "./request-id-hook.js";
export {
  newRequestId,
  normalizeIncomingRequestId,
  POLARIS_REQUEST_ID_HEADER,
  REQUEST_ID_HEADER,
  resolveRequestId,
} from "./request-id.js";
export {
  bootstrapService,
  DEFAULT_SHUTDOWN_SIGNALS,
  type BootstrappedService,
  type BootstrapServiceOptions,
} from "./service.js";
export {
  installGracefulShutdown,
  type GracefulShutdownOptions,
  type ShutdownTask,
} from "./shutdown.js";
