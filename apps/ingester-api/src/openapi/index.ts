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
  buildOpenApiDocument,
  PUBLISHED_OPENAPI_INFO,
  PUBLISHED_OPENAPI_SERVERS,
  type BuildOpenApiDocumentOptions,
  type OpenApiDocument,
} from "./document.js";
export {
  DEFAULT_OPENAPI_ROUTE,
  openApiSetup,
  openApiSetupWith,
  registerOpenApiRoute,
  type OpenApiSetupOptions,
} from "./route.js";
export { buildComponentSchemas, EXAMPLE_CANONICAL_ENVELOPE } from "./schemas.js";
export { buildPaths, OPERATIONS_COMPONENT_SCHEMAS } from "./paths.js";
