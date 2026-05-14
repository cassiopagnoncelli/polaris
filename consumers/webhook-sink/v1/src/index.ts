/**
 * `@polaris/consumer-webhook-sink-v1` — public module barrel.
 *
 * The binary entry point lives in `./main.ts`. This barrel exposes the
 * composable building blocks (`buildWebhookSinkApp`,
 * `createWebhookSinkDescriptor`, mapper, deliverer, config loader) so
 * tests, smoke harnesses, and the future replay executor (P7-003) can
 * drive the consumer without forking the process.
 *
 * @see docs/architecture/06-destinations.md "Destination Consumer"
 */

export {
  buildWebhookSinkApp,
  type BuildAppOptions,
  type BuiltWebhookSinkApp,
} from "./app.js";
export {
  CONSUMER_SERVICE_NAME,
  loadWebhookSinkConfig,
  webhookSinkConfigSchema,
  webhookSinkEnvKeys,
  webhookSinkEnvSchema,
  type WebhookSinkConfig,
  type WebhookSinkRuntimeConfig,
} from "./config.js";
export {
  buildWebhookDeliverer,
  classifyRetryableStatus,
  enforceTransportPolicy,
  HEADER_DELIVERY_ATTEMPT,
  HEADER_DELIVERY_CONSUMER_VERSION,
  HEADER_DELIVERY_KEY,
  HEADER_DELIVERY_VENDOR,
  HEADER_SIGNATURE,
  isRetryableStatus,
  parseResolvedSecret,
  signBody,
  verifySignature,
  type BuildDelivererOptions,
} from "./deliverer.js";
export {
  createWebhookSinkDescriptor,
  type CreateWebhookSinkDescriptorOptions,
} from "./descriptor.js";
export {
  CONSUMER_IDENTITY,
  CONSUMER_VENDOR,
  CONSUMER_VERSION,
  DELIVERER_VERSION,
  MAPPER_VERSION,
  NORMALIZE_VERSION,
} from "./descriptor-identity.js";
export { stampDelivery, webhookPassthroughMapper } from "./mapper.js";
export type { ResolvedWebhookConfig, WebhookPayload } from "./types.js";
