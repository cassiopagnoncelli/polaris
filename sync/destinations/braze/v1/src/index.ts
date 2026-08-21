/**
 * `@polaris/consumer-braze-v1` — public module barrel.
 *
 * The binary entry point lives in `./main.ts`. This package is an engine
 * SHELL: it boots the shared destination runtime against the Braze
 * connector (`@polaris/destination-braze-v1`) and owns nothing about
 * Braze itself. Mappers, deliverer, payload types and the
 * project-config contract all live in the connector; what is left here is
 * the deployment — broker, database, HTTP port, environment.
 *
 * The vendor half is re-exported below so a smoke harness or the replay
 * executor can still reach the descriptor through the thing it boots,
 * rather than having to know which connector this shell was built against.
 *
 * @see connectors/destinations/braze/v1 — the vendor half
 * @see docs/architecture/06-destinations.md "Destination Consumer"
 */

export {
  type BuildAppOptions,
  type BuiltBrazeApp,
  buildBrazeApp,
} from "./app.js";
export {
  type BrazeConfig,
  type BrazeRuntimeConfig,
  brazeConfigSchema,
  brazeEnvKeys,
  brazeEnvSchema,
  CONSUMER_SERVICE_NAME,
  DEFAULT_BRAZE_API_HOST,
  loadBrazeConfig,
} from "./config.js";
export {
  type CreateBrazeDescriptorOptions,
  createBrazeDescriptor,
  brazeConnector,
} from "@polaris/destination-braze-v1";
