/**
 * Public surface of the ingester auth module.
 *
 * The composition is:
 *
 *   parse header  -> repository.findById -> verify hash -> resolved context
 *      (api-key)        (repository / cache)    (hash)         (api-key)
 *
 * The Fastify glue lives in `plugin.ts`. Tests drive the service and the
 * repository directly through this barrel.
 *
 * @see docs/architecture/02-control-plane.md "API Keys"
 * @see docs/architecture/04-ingestion-and-sdks.md "Ingester Responsibilities"
 */

export {
  API_KEY_HEADER,
  type AuthenticatedRequestContext,
  type ParsedApiKey,
  parseApiKeyHeader,
} from "./api-key.js";
export { ApiKeyCache, type ApiKeyCacheOptions } from "./cache.js";
export { AUTH_PROBLEM_CODES, type AuthProblemCode } from "./errors.js";
export { verifyApiKeyHash } from "./hash.js";
export {
  type AuthenticateRequest,
  createAuthPreHandler,
  decorateAuthPreHandler,
  type RegisterAuthPreHandlerOptions,
} from "./plugin.js";
export {
  type ApiKeyRecord,
  type ApiKeyRepository,
  createPostgresApiKeyRepository,
} from "./repository.js";
export {
  type AuthRejection,
  type AuthRejectionReason,
  type AuthResult,
  type AuthServiceOptions,
  type AuthSuccess,
  createAuthService,
} from "./service.js";
