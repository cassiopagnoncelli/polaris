/**
 * `@polaris/consumer-braze-v1` — public module barrel.
 *
 * The binary entry point lives in `./main.ts`. This barrel exposes the
 * composable building blocks (`buildBrazeApp`, `createBrazeDescriptor`,
 * mappers, deliverer, config loader) so tests, smoke harnesses, and
 * the replay executor can drive the consumer without forking the
 * process.
 *
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
  type BuildDelivererOptions,
  buildBrazeDeliverer,
  buildUsersTrackUrl,
  classifyRetryableStatus,
  isRetryableStatus,
  parseResolvedSecret,
} from "./deliverer.js";
export {
  type CreateBrazeDescriptorOptions,
  createBrazeDescriptor,
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
  BRAZE_EVENT_CHECKOUT_STARTED,
  CANONICAL_TO_BRAZE_FAMILY,
  checkoutStartedMapper,
  paymentApprovedMapper,
  resolveExternalId,
  userIdentifiedMapper,
} from "./mapper.js";
export type {
  BrazeAttributeObject,
  BrazeEventObject,
  BrazeEventProperties,
  BrazePayload,
  BrazePurchaseObject,
  ResolvedBrazeSecret,
} from "./types.js";
