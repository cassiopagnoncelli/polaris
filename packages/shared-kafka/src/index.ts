/**
 * `@polaris/shared-kafka` — thin KafkaJS wrapper for Polaris.
 *
 * Polaris services talk to Redpanda exclusively through this package. The
 * goal per `09-engineering-standards.md` is to standardize the few things
 * that should be uniform across services:
 *
 *   - producer/consumer creation
 *   - message headers
 *   - event serialization
 *   - partition key generation
 *   - retry defaults
 *   - metrics hooks
 *   - logging hooks
 *   - topic constants
 *   - DLQ publishing helpers
 *   - topic-family resolution
 *
 * Beyond that, the wrapper stays transparent: the underlying KafkaJS
 * `Producer` and `Consumer` are exposed through `.raw` so advanced services
 * can call directly into KafkaJS when needed. Polaris does not build a
 * stream-processing framework in v1.
 *
 * Typical service wiring:
 *
 * ```ts
 * import { loadConfig, redpandaEnvSchema, composeConfigSchema } from "@polaris/shared-config";
 * import { createLogger } from "@polaris/shared-logger";
 * import {
 *   createKafkaClient,
 *   createPolarisProducer,
 *   TOPIC_FAMILY_RAW_EVENTS,
 *   staticIsolationLookup,
 * } from "@polaris/shared-kafka";
 *
 * const config = loadConfig({
 *   serviceName: "ingester-api",
 *   schema: composeConfigSchema({ redpanda: redpandaEnvSchema }),
 * });
 * const logger = createLogger({ service: "ingester-api" });
 * const kafka = createKafkaClient({ redpanda: config.redpanda });
 *
 * const producer = createPolarisProducer({
 *   kafka,
 *   logger,
 *   producerName: "ingester-api",
 * });
 *
 * await producer.connect();
 *
 * await producer.publishEvent({
 *   family: TOPIC_FAMILY_RAW_EVENTS,
 *   event: envelope,
 *   isolation: staticIsolationLookup([]),
 * });
 * ```
 *
 * @see docs/architecture/03-redpanda-topics.md
 * @see docs/architecture/09-engineering-standards.md "Redpanda Client Usage"
 */

export {
  type CanonicalTopicFamily,
  CANONICAL_TOPIC_FAMILIES,
  TOPIC_DIAGNOSTICS_EVENTS,
  TOPIC_FAMILY_ANALYTICS_EVENTS,
  TOPIC_FAMILY_ATTRIBUTION_EVENTS,
  TOPIC_FAMILY_ENRICHED_EVENTS,
  TOPIC_FAMILY_IDENTITY_EVENTS,
  TOPIC_FAMILY_RAW_EVENTS,
  dedicatedTopicName,
  dlqTopicName,
  isCanonicalTopicFamily,
  retryTopicName,
} from "./topics.js";

export {
  type IsolationLookup,
  type SyncIsolationLookup,
  consumerTopicsForFamily,
  resolveTopicName,
  resolveTopicNameSync,
  sharedOnlyIsolationLookup,
  staticIsolationLookup,
} from "./topic-family.js";

export {
  type PartitionKeyIdentity,
  type PartitionKeyIdentitySource,
  type PartitionKeyInput,
  buildRawEventsPartitionKey,
  resolveRawEventsPartitionKey,
} from "./partition-key.js";

export {
  type MessageHeaders,
  type PolarisHeaderInput,
  type RetryHeaderInput,
  POLARIS_CONTENT_TYPE_JSON,
  POLARIS_HEADER_CONTENT_TYPE,
  POLARIS_HEADER_ENVIRONMENT,
  POLARIS_HEADER_ERROR_CLASS,
  POLARIS_HEADER_ERROR_MESSAGE,
  POLARIS_HEADER_EVENT_ID,
  POLARIS_HEADER_EVENT_NAME,
  POLARIS_HEADER_FAILED_AT,
  POLARIS_HEADER_INGESTED_AT,
  POLARIS_HEADER_OCCURRED_AT,
  POLARIS_HEADER_PROJECT_ID,
  POLARIS_HEADER_PRODUCER,
  POLARIS_HEADER_PRODUCER_VERSION,
  POLARIS_HEADER_RETRY_ATTEMPTS,
  POLARIS_HEADER_RETRY_REASON,
  POLARIS_HEADER_SCHEMA_VERSION,
  POLARIS_HEADER_SOURCE_ID,
  POLARIS_HEADER_SOURCE_OFFSET,
  POLARIS_HEADER_SOURCE_PARTITION,
  POLARIS_HEADER_SOURCE_TOPIC,
  POLARIS_HEADER_TOPIC_FAMILY,
  buildEventHeaders,
  buildRetryHeaders,
  mergeHeaders,
  readHeaderNumber,
  readHeaderString,
} from "./headers.js";

export {
  EventDeserializationError,
  decodeEvent,
  encodeEvent,
} from "./serialization.js";

export {
  type KafkaHookEvent,
  type KafkaHookHandler,
  type KafkaHookPayload,
  type KafkaHooks,
  composeHooks,
  emitHook,
} from "./hooks.js";

export {
  type CreateKafkaClientOptions,
  DEFAULT_RETRY_OPTIONS,
  createKafkaClient,
} from "./client.js";

export {
  type CreatePolarisProducerOptions,
  type PolarisProducer,
  type PublishEventInput,
  type PublishableEvent,
  createPolarisProducer,
} from "./producer.js";

export {
  type CreatePolarisConsumerOptions,
  type PolarisConsumer,
  type PolarisEachMessageHandler,
  type PolarisMessageContext,
  createPolarisConsumer,
} from "./consumer.js";

export {
  type RepublishInput,
  readRetryAttempts,
  republishToDlq,
  republishToRetry,
} from "./dlq.js";
