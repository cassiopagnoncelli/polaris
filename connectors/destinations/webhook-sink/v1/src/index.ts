/**
 * `@polaris/destination-webhook-sink-v1` — the webhook-sink destination connector.
 *
 * One vendor, behind `destination.port`: `webhookSinkConnector` is the
 * registry entry, `createWebhookSinkDescriptor` binds it to the shared
 * destination runtime, and the mappers, deliverer and payload types below
 * are the vendor knowledge the two are made of. The deployment that runs
 * this is `sync/destinations/webhook-sink/v1`, and nothing here knows it exists.
 *
 * @see connectors/README.md — the registry rule and the add-a-vendor path
 * @see docs/architecture/06-destinations.md "Destination Consumer"
 */

export {
  type CreateWebhookSinkDescriptorOptions,
  createWebhookSinkDescriptor,
  webhookSinkConnector,
} from "./connector.js";
export {
  type BuildDelivererOptions,
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
} from "./deliverer.js";
export {
  CONSUMER_IDENTITY,
  CONSUMER_VENDOR,
  CONSUMER_VERSION,
  DELIVERER_VERSION,
  MAPPER_VERSION,
  NORMALIZE_VERSION,
} from "./descriptor-identity.js";
export { stampDelivery, webhookPassthroughMapper } from "./mapper.js";
export {
  PROJECT_CONFIG_NAMESPACE,
  projectConfigSchema,
} from "./project-config.js";
export type { ResolvedWebhookConfig, WebhookPayload } from "./types.js";
