/**
 * `@polaris/consumer-ga4-v1` — public module barrel.
 *
 * The binary entry point lives in `./main.ts`. This barrel exposes the
 * composable building blocks (`buildGa4App`, `createGa4Descriptor`,
 * mappers, deliverer, config loader) so tests, smoke harnesses, and
 * the replay executor (P7-003) can drive the consumer without forking
 * the process.
 *
 * @see docs/architecture/06-destinations.md "Destination Consumer"
 */

export {
  buildGa4App,
  type BuildAppOptions,
  type BuiltGa4App,
} from "./app.js";
export {
  CONSUMER_SERVICE_NAME,
  DEFAULT_GA4_API_HOST,
  loadGa4Config,
  ga4ConfigSchema,
  ga4EnvKeys,
  ga4EnvSchema,
  type Ga4Config,
  type Ga4RuntimeConfig,
} from "./config.js";
export {
  buildGa4Deliverer,
  buildMeasurementProtocolUrl,
  buildRequestBody,
  classifyRetryableStatus,
  isRetryableStatus,
  parseResolvedSecret,
  type BuildDelivererOptions,
} from "./deliverer.js";
export {
  createGa4Descriptor,
  type CreateGa4DescriptorOptions,
} from "./descriptor.js";
export {
  CONSUMER_IDENTITY,
  CONSUMER_VENDOR,
  CONSUMER_VERSION,
  DELIVERER_VERSION,
  MAPPER_VERSION,
  NORMALIZE_VERSION,
} from "./descriptor-identity.js";
export {
  CANONICAL_TO_GA4_EVENT,
  checkoutStartedMapper,
  GA4_EVENT_BEGIN_CHECKOUT,
  GA4_EVENT_LOGIN,
  GA4_EVENT_PURCHASE,
  GA4_LOGIN_METHOD_POLARIS,
  paymentApprovedMapper,
  userIdentifiedMapper,
} from "./mapper.js";
export type {
  Ga4EventItem,
  Ga4EventParams,
  Ga4EventPayload,
  Ga4RequestBody,
  ResolvedGa4Secret,
} from "./types.js";
