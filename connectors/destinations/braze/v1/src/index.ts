/**
 * `@polaris/destination-braze-v1` — the Braze destination connector.
 *
 * One vendor, behind `destination.port`: `brazeConnector` is the
 * registry entry, `createBrazeDescriptor` binds it to the shared
 * destination runtime, and the mappers, deliverer and payload types below
 * are the vendor knowledge the two are made of. The deployment that runs
 * this is `sync/destinations/braze/v1`, and nothing here knows it exists.
 *
 * @see connectors/README.md — the registry rule and the add-a-vendor path
 * @see docs/architecture/06-destinations.md "Destination Consumer"
 */

export {
  type CreateBrazeDescriptorOptions,
  createBrazeDescriptor,
  brazeConnector,
} from "./connector.js";
export {
  type BuildDelivererOptions,
  buildBrazeDeliverer,
  buildUsersTrackUrl,
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
  BRAZE_EVENT_CHECKOUT_STARTED,
  CANONICAL_TO_BRAZE_FAMILY,
  checkoutStartedMapper,
  paymentApprovedMapper,
  resolveExternalId,
  userIdentifiedMapper,
} from "./mapper.js";
export {
  PROJECT_CONFIG_NAMESPACE,
  projectConfigSchema,
} from "./project-config.js";
export type {
  BrazeAttributeObject,
  BrazeEventObject,
  BrazeEventProperties,
  BrazePayload,
  BrazePurchaseObject,
  ResolvedBrazeSecret,
} from "./types.js";
