/**
 * Public OpenAPI surface for the Polaris ingester.
 *
 * The generator script (`scripts/openapi-generate.mjs`) and the runtime
 * Fastify wiring (`app.ts`) both consume this barrel. Keeping the surface
 * intentionally small here makes the source-of-truth boundary obvious.
 *
 * @see docs/architecture/09-engineering-standards.md "OpenAPI"
 */

export {
  type BuildOpenApiDocumentOptions,
  buildOpenApiDocument,
  type OpenApiDocument,
  PUBLISHED_OPENAPI_INFO,
  PUBLISHED_OPENAPI_SERVERS,
} from "./document.js";
export { buildPaths, OPERATIONS_COMPONENT_SCHEMAS } from "./paths.js";
export {
  DEFAULT_OPENAPI_ROUTE,
  type OpenApiSetupOptions,
  openApiSetup,
  openApiSetupWith,
  registerOpenApiRoute,
} from "./route.js";
export { buildComponentSchemas, EXAMPLE_CANONICAL_ENVELOPE } from "./schemas.js";
