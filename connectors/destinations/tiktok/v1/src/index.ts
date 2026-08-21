/**
 * `@polaris/destination-tiktok-v1` — the TikTok destination connector.
 *
 * One vendor, behind `destination.port`: `tiktokConnector` is the
 * registry entry, `createTikTokDescriptor` binds it to the shared
 * destination runtime, and the mappers, deliverer and payload types below
 * are the vendor knowledge the two are made of. The deployment that runs
 * this is `sync/destinations/tiktok/v1`, and nothing here knows it exists.
 *
 * @see connectors/README.md — the registry rule and the add-a-vendor path
 * @see docs/architecture/06-destinations.md "Destination Consumer"
 */

export {
  type CreateTikTokDescriptorOptions,
  createTikTokDescriptor,
  tiktokConnector,
} from "./connector.js";
export {
  type BuildDelivererOptions,
  buildEventsApiUrl,
  buildTikTokDeliverer,
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
  TIKTOK_EVENTS_API_VERSION,
} from "./descriptor-identity.js";
export {
  buildUserData,
  CANONICAL_TO_TIKTOK_EVENT,
  checkoutStartedMapper,
  inferEventSource,
  paymentApprovedMapper,
  TIKTOK_EVENT_COMPLETE_REGISTRATION,
  TIKTOK_EVENT_INITIATE_CHECKOUT,
  TIKTOK_EVENT_PURCHASE,
  userIdentifiedMapper,
} from "./mapper.js";
export {
  PROJECT_CONFIG_NAMESPACE,
  projectConfigSchema,
} from "./project-config.js";
export type {
  ResolvedTikTokSecret,
  TikTokEventContent,
  TikTokEventPayload,
  TikTokEventProperties,
  TikTokEventSource,
  TikTokPageContext,
  TikTokUserData,
} from "./types.js";
