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

export { buildIngesterApp, type BuildIngesterAppOptions } from "./app.js";
export {
  INGESTER_SERVICE_NAME,
  authCacheEnvKeys,
  authCacheEnvSchema,
  ingestEnvKeys,
  ingestEnvSchema,
  ingesterConfigSchema,
  loadIngesterConfig,
  type AuthCacheConfig,
  type IngestConfig,
  type IngesterConfig,
} from "./config.js";
export {
  API_KEY_HEADER,
  ApiKeyCache,
  AUTH_PROBLEM_CODES,
  createAuthPreHandler,
  createAuthService,
  createPostgresApiKeyRepository,
  parseApiKeyHeader,
  verifyApiKeyHash,
  type ApiKeyCacheOptions,
  type ApiKeyRecord,
  type ApiKeyRepository,
  type AuthenticateRequest,
  type AuthenticatedRequestContext,
  type AuthProblemCode,
  type AuthRejection,
  type AuthRejectionReason,
  type AuthResult,
  type AuthServiceOptions,
  type AuthSuccess,
  type ParsedApiKey,
} from "./auth/index.js";
export {
  NOT_IMPLEMENTED_AFTER_AUTH_CODE,
  NOT_IMPLEMENTED_CODE,
  registerEventsRoutes,
  type RegisterEventsRoutesOptions,
} from "./routes/events.js";
export {
  createIngestHandler,
  type IngestHandler,
  type IngestHandlerDeps,
  type InvalidRequestBody,
} from "./ingest/handler.js";
export {
  batchRequestSchema,
  type BatchRequest,
  type IngestRequestContext,
} from "./ingest/types.js";
export {
  DisabledDedupeStore,
  InMemoryDedupeStore,
  createRedisDedupeStore,
  type DedupeClaimInput,
  type DedupeClaimOutcome,
  type DedupeStore,
} from "./dedupe/index.js";
export {
  IngestMetrics,
  METRIC_INGEST_BATCH_ACCEPTED_TOTAL,
  METRIC_INGEST_BATCH_REJECTED_TOTAL,
  METRIC_INGEST_DEDUPE_HIT_TOTAL,
  METRIC_INGEST_DEDUPE_SKIPPED_TOTAL,
  METRIC_INGEST_DEPRECATED_SCHEMA_VERSION_TOTAL,
  METRIC_INGEST_REDACTED_PATTERN_TOTAL,
  type MetricSample,
} from "./metrics/registry.js";
export {
  loadRuntimeCatalog,
  resolveDefaultCatalogRoot,
} from "./catalog/runtime.js";
export { createPolicyResolver, type PolicyResolver } from "./policy/loader.js";
