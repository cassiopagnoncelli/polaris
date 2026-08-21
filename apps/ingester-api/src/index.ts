/**
 * `@polaris/ingester-api` — public module barrel.
 *
 * The binary entry point lives in `./server.ts`. This barrel exposes the
 * composable building blocks (`buildIngesterApp`, config loader, route
 * registrars, auth primitives, ingest handler) so tests, smoke harnesses,
 * and future control-plane tooling can spin up an in-process Fastify
 * instance without forking the process.
 *
 * @see docs/architecture/04-ingestion-and-sdks.md "Ingester Purpose"
 * @see docs/architecture/09-engineering-standards.md "Fastify Service Structure"
 */

export { type BuildIngesterAppOptions, buildIngesterApp } from "./app.js";
export {
  API_KEY_HEADER,
  ApiKeyCache,
  type ApiKeyCacheOptions,
  type ApiKeyRecord,
  type ApiKeyRepository,
  AUTH_PROBLEM_CODES,
  type AuthenticatedRequestContext,
  type AuthenticateRequest,
  type AuthProblemCode,
  type AuthRejection,
  type AuthRejectionReason,
  type AuthResult,
  type AuthServiceOptions,
  type AuthSuccess,
  createAuthPreHandler,
  createAuthService,
  createPostgresApiKeyRepository,
  type ParsedApiKey,
  parseApiKeyHeader,
  verifyApiKeyHash,
} from "./auth/index.js";
export {
  loadRuntimeCatalog,
  resolveDefaultCatalogRoot,
} from "./catalog/runtime.js";
export {
  type AuthCacheConfig,
  authCacheEnvKeys,
  authCacheEnvSchema,
  INGESTER_SERVICE_NAME,
  type IngestConfig,
  type IngesterConfig,
  ingestEnvKeys,
  ingestEnvSchema,
  ingesterConfigSchema,
  loadIngesterConfig,
} from "./config.js";
export {
  createRedisDedupeStore,
  type DedupeClaimInput,
  type DedupeClaimOutcome,
  type DedupeStore,
  DisabledDedupeStore,
  InMemoryDedupeStore,
} from "./dedupe/index.js";
export {
  createIngestHandler,
  type IngestHandler,
  type IngestHandlerDeps,
  type InvalidRequestBody,
} from "./ingest/handler.js";
export {
  applyClientContext,
  CLIENT_CONTEXT_OPT_OUT_IP,
  type ClientConnection,
  type ClientContextConfig,
  type ClientContextField,
  type ClientContextFieldOutcome,
  type ClientContextOutcome,
  type ClientContextResult,
  selectClientAddress,
} from "./ingest/client-context.js";
export {
  type BatchRequest,
  batchRequestSchema,
  type IngestRequestContext,
  NO_CLIENT_CONNECTION,
} from "./ingest/types.js";
export {
  type ClientContextLabels,
  IngestMetrics,
  METRIC_INGEST_BATCH_ACCEPTED_TOTAL,
  METRIC_INGEST_BATCH_REJECTED_TOTAL,
  METRIC_INGEST_DEDUPE_HIT_TOTAL,
  METRIC_INGEST_DEDUPE_SKIPPED_TOTAL,
  METRIC_INGEST_CLIENT_CONTEXT_TOTAL,
  METRIC_INGEST_DEPRECATED_SCHEMA_VERSION_TOTAL,
  METRIC_INGEST_REDACTED_PATTERN_TOTAL,
  type MetricSample,
} from "./metrics/registry.js";
export {
  type BuildOpenApiDocumentOptions,
  buildComponentSchemas,
  buildOpenApiDocument,
  buildPaths,
  DEFAULT_OPENAPI_ROUTE,
  EXAMPLE_CANONICAL_ENVELOPE,
  OPERATIONS_COMPONENT_SCHEMAS,
  type OpenApiDocument,
  type OpenApiSetupOptions,
  openApiSetup,
  openApiSetupWith,
  PUBLISHED_OPENAPI_INFO,
  PUBLISHED_OPENAPI_SERVERS,
  registerOpenApiRoute,
} from "./openapi/index.js";
export { createPolicyResolver, type PolicyResolver } from "./policy/loader.js";
export {
  NOT_IMPLEMENTED_AFTER_AUTH_CODE,
  NOT_IMPLEMENTED_CODE,
  type RegisterEventsRoutesOptions,
  registerEventsRoutes,
} from "./routes/events.js";
