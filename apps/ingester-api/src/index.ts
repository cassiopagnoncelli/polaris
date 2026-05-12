/**
 * `@polaris/ingester-api` — public module barrel.
 *
 * The binary entry point lives in `./server.ts`. This barrel exposes the
 * composable building blocks (`buildIngesterApp`, config loader, route
 * registrars, auth primitives) so tests, smoke harnesses, and future
 * control-plane tooling can spin up an in-process Fastify instance without
 * forking the process.
 *
 * @see docs/architecture/04-ingestion-and-sdks.md "Ingester Purpose"
 * @see docs/architecture/09-engineering-standards.md "Fastify Service Structure"
 */

export { buildIngesterApp, type BuildIngesterAppOptions } from "./app.js";
export {
  INGESTER_SERVICE_NAME,
  authCacheEnvKeys,
  authCacheEnvSchema,
  ingesterConfigSchema,
  loadIngesterConfig,
  type AuthCacheConfig,
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
