/**
 * `@polaris/consumer-ga4-v1` — public module barrel.
 *
 * The binary entry point lives in `./main.ts`. This package is an engine
 * SHELL: it boots the shared destination runtime against the GA4
 * connector (`@polaris/destination-ga4-v1`) and owns nothing about
 * GA4 itself. Mappers, deliverer, payload types and the
 * project-config contract all live in the connector; what is left here is
 * the deployment — broker, database, HTTP port, environment.
 *
 * The vendor half is re-exported below so a smoke harness or the replay
 * executor can still reach the descriptor through the thing it boots,
 * rather than having to know which connector this shell was built against.
 *
 * @see connectors/destinations/ga4/v1 — the vendor half
 * @see docs/architecture/06-destinations.md "Destination Consumer"
 */

export {
  type BuildAppOptions,
  type BuiltGa4App,
  buildGa4App,
} from "./app.js";
export {
  CONSUMER_SERVICE_NAME,
  DEFAULT_GA4_API_HOST,
  type Ga4Config,
  type Ga4RuntimeConfig,
  ga4ConfigSchema,
  ga4EnvKeys,
  ga4EnvSchema,
  loadGa4Config,
} from "./config.js";
export {
  type CreateGa4DescriptorOptions,
  createGa4Descriptor,
  ga4Connector,
} from "@polaris/destination-ga4-v1";
