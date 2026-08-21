/**
 * `@polaris/consumer-meta-capi-v1` — public module barrel.
 *
 * The binary entry point lives in `./main.ts`. This package is an engine
 * SHELL: it boots the shared destination runtime against the Meta CAPI
 * connector (`@polaris/destination-meta-capi-v1`) and owns nothing about
 * Meta CAPI itself. Mappers, deliverer, payload types and the
 * project-config contract all live in the connector; what is left here is
 * the deployment — broker, database, HTTP port, environment.
 *
 * The vendor half is re-exported below so a smoke harness or the replay
 * executor can still reach the descriptor through the thing it boots,
 * rather than having to know which connector this shell was built against.
 *
 * @see connectors/destinations/meta-capi/v1 — the vendor half
 * @see docs/architecture/06-destinations.md "Destination Consumer"
 */

export {
  type BuildAppOptions,
  type BuiltMetaCapiApp,
  buildMetaCapiApp,
} from "./app.js";
export {
  CONSUMER_SERVICE_NAME,
  DEFAULT_GRAPH_HOST,
  loadMetaCapiConfig,
  type MetaCapiConfig,
  type MetaCapiRuntimeConfig,
  metaCapiConfigSchema,
  metaCapiEnvKeys,
  metaCapiEnvSchema,
} from "./config.js";
export {
  type CreateMetaCapiDescriptorOptions,
  createMetaCapiDescriptor,
  metaCapiConnector,
} from "@polaris/destination-meta-capi-v1";
