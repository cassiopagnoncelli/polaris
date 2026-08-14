/**
 * `@polaris/consumer-tiktok-v1` — public module barrel.
 *
 * The binary entry point lives in `./main.ts`. This barrel exposes the
 * composable building blocks (`buildTikTokApp`,
 * `createTikTokDescriptor`, mappers, deliverer, config loader) so
 * tests, smoke harnesses, and the future replay executor (P7-003) can
 * drive the consumer without forking the process.
 *
 * @see docs/architecture/06-destinations.md "Destination Consumer"
 */

export {
  type BuildAppOptions,
  type BuiltTikTokApp,
  buildTikTokApp,
} from "./app.js";
export {
  CONSUMER_SERVICE_NAME,
  DEFAULT_TIKTOK_API_HOST,
  loadTikTokConfig,
  type TikTokConfig,
  type TikTokRuntimeConfig,
  tiktokConfigSchema,
  tiktokEnvKeys,
  tiktokEnvSchema,
} from "./config.js";
export {
  type BuildDelivererOptions,
  buildEventsApiUrl,
  buildTikTokDeliverer,
  classifyRetryableStatus,
  isRetryableStatus,
  parseResolvedSecret,
} from "./deliverer.js";
export {
  type CreateTikTokDescriptorOptions,
  createTikTokDescriptor,
} from "./descriptor.js";
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
export type {
  ResolvedTikTokSecret,
  TikTokEventContent,
  TikTokEventPayload,
  TikTokEventProperties,
  TikTokEventSource,
  TikTokPageContext,
  TikTokUserData,
} from "./types.js";
