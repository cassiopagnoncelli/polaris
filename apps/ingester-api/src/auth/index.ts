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
  parseApiKeyHeader,
  type AuthenticatedRequestContext,
  type ParsedApiKey,
} from "./api-key.js";
export { ApiKeyCache, type ApiKeyCacheOptions } from "./cache.js";
export { AUTH_PROBLEM_CODES, type AuthProblemCode } from "./errors.js";
export { verifyApiKeyHash } from "./hash.js";
export {
  createAuthPreHandler,
  decorateAuthPreHandler,
  type AuthenticateRequest,
  type RegisterAuthPreHandlerOptions,
} from "./plugin.js";
export {
  createPostgresApiKeyRepository,
  type ApiKeyRecord,
  type ApiKeyRepository,
} from "./repository.js";
export {
  createAuthService,
  type AuthRejection,
  type AuthRejectionReason,
  type AuthResult,
  type AuthServiceOptions,
  type AuthSuccess,
} from "./service.js";
