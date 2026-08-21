/**
 * `@polaris/destination-ga4-v1` — the GA4 destination connector.
 *
 * One vendor, behind `destination.port`: `ga4Connector` is the
 * registry entry, `createGa4Descriptor` binds it to the shared
 * destination runtime, and the mappers, deliverer and payload types below
 * are the vendor knowledge the two are made of. The deployment that runs
 * this is `sync/destinations/ga4/v1`, and nothing here knows it exists.
 *
 * @see connectors/README.md — the registry rule and the add-a-vendor path
 * @see docs/architecture/06-destinations.md "Destination Consumer"
 */

export {
  type CreateGa4DescriptorOptions,
  createGa4Descriptor,
  ga4Connector,
} from "./connector.js";
export {
  type BuildDelivererOptions,
  buildGa4Deliverer,
  buildMeasurementProtocolUrl,
  buildRequestBody,
  classifyRetryableStatus,
  isRetryableStatus,
  parseResolvedSecret,
} from "./deliverer.js";
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
export {
  PROJECT_CONFIG_NAMESPACE,
  projectConfigSchema,
} from "./project-config.js";
export type {
  Ga4EventItem,
  Ga4EventParams,
  Ga4EventPayload,
  Ga4RequestBody,
  ResolvedGa4Secret,
} from "./types.js";
