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
  type BuildMetadata,
  buildMetadataLogBindings,
  type GetBuildMetadataOptions,
  getBuildMetadata,
} from "./build-metadata.js";
export {
  createProblemErrorHandler,
  createProblemNotFoundHandler,
  type ProblemErrorHandlerOptions,
} from "./error-handler.js";
export {
  type HealthPluginOptions,
  type ReadinessProbe,
  type ReadinessProbeResult,
  registerHealthRoutes,
  type ServiceInfo,
} from "./health.js";
export {
  type MetricsPluginOptions,
  type MetricsProducer,
  PROMETHEUS_CONTENT_TYPE,
  registerMetricsRoute,
} from "./metrics.js";
export { NOOP_OPENAPI_SETUP, type OpenApiMetadata, type OpenApiSetup } from "./openapi.js";
export {
  newRequestId,
  normalizeIncomingRequestId,
  POLARIS_REQUEST_ID_HEADER,
  REQUEST_ID_HEADER,
  resolveRequestId,
} from "./request-id.js";
export {
  genReqId,
  installRequestIdHook,
  RESPONSE_REQUEST_ID_HEADER,
} from "./request-id-hook.js";
export {
  type BootstrappedService,
  type BootstrapServiceOptions,
  bootstrapService,
  DEFAULT_SHUTDOWN_SIGNALS,
} from "./service.js";
export {
  type GracefulShutdownOptions,
  installGracefulShutdown,
  type ShutdownTask,
} from "./shutdown.js";
