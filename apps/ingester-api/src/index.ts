/**
 * `@polaris/ingester-api` — public module barrel.
 *
 * The binary entry point lives in `./server.ts`. This barrel exposes the
 * composable building blocks (`buildIngesterApp`, config loader, route
 * registrars) so tests, smoke harnesses, and future control-plane tooling
 * can spin up an in-process Fastify instance without forking the process.
 *
 * @see docs/architecture/04-ingestion-and-sdks.md "Ingester Purpose"
 * @see docs/architecture/09-engineering-standards.md "Fastify Service Structure"
 */

export { buildIngesterApp, type BuildIngesterAppOptions } from "./app.js";
export {
  INGESTER_SERVICE_NAME,
  ingesterConfigSchema,
  loadIngesterConfig,
  type IngesterConfig,
} from "./config.js";
export { NOT_IMPLEMENTED_CODE, registerEventsRoutes } from "./routes/events.js";
