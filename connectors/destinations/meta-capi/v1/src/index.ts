/**
 * `@polaris/destination-meta-capi-v1` — the Meta CAPI destination connector.
 *
 * One vendor, behind `destination.port`: `metaCapiConnector` is the
 * registry entry, `createMetaCapiDescriptor` binds it to the shared
 * destination runtime, and the mappers, deliverer and payload types below
 * are the vendor knowledge the two are made of. The deployment that runs
 * this is `sync/destinations/meta-capi/v1`, and nothing here knows it exists.
 *
 * @see connectors/README.md — the registry rule and the add-a-vendor path
 * @see docs/architecture/06-destinations.md "Destination Consumer"
 */

export {
  type CreateMetaCapiDescriptorOptions,
  createMetaCapiDescriptor,
  metaCapiConnector,
} from "./connector.js";
export {
  type BuildDelivererOptions,
  buildGraphUrl,
  buildMetaCapiDeliverer,
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
  META_GRAPH_API_VERSION,
  NORMALIZE_VERSION,
} from "./descriptor-identity.js";
export {
  buildUserData,
  CANONICAL_TO_META_EVENT,
  checkoutStartedMapper,
  inferActionSource,
  META_EVENT_INITIATE_CHECKOUT,
  META_EVENT_LEAD,
  META_EVENT_PURCHASE,
  paymentApprovedMapper,
  userIdentifiedMapper,
} from "./mapper.js";
export {
  PROJECT_CONFIG_NAMESPACE,
  projectConfigSchema,
} from "./project-config.js";
export type {
  MetaActionSource,
  MetaCapiCustomData,
  MetaCapiPayload,
  MetaCapiUserData,
  ResolvedMetaCapiSecret,
} from "./types.js";
