/**
 * `@polaris/consumer-meta-capi-v1` — public module barrel.
 *
 * The binary entry point lives in `./main.ts`. This barrel exposes the
 * composable building blocks (`buildMetaCapiApp`,
 * `createMetaCapiDescriptor`, mappers, deliverer, config loader) so
 * tests, smoke harnesses, and the future replay executor (P7-003) can
 * drive the consumer without forking the process.
 *
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
  type BuildDelivererOptions,
  buildGraphUrl,
  buildMetaCapiDeliverer,
  classifyRetryableStatus,
  isRetryableStatus,
  parseResolvedSecret,
} from "./deliverer.js";
export {
  type CreateMetaCapiDescriptorOptions,
  createMetaCapiDescriptor,
} from "./descriptor.js";
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
export type {
  MetaActionSource,
  MetaCapiCustomData,
  MetaCapiPayload,
  MetaCapiUserData,
  ResolvedMetaCapiSecret,
} from "./types.js";
