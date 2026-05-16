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
  type CreateKafkaClientOptions,
  createKafkaClient,
  DEFAULT_RETRY_OPTIONS,
} from "./client.js";
export {
  type CreatePolarisConsumerOptions,
  createPolarisConsumer,
  type PolarisConsumer,
  type PolarisEachMessageHandler,
  type PolarisMessageContext,
} from "./consumer.js";
export {
  type RepublishInput,
  readRetryAttempts,
  republishToDlq,
  republishToRetry,
} from "./dlq.js";
export {
  buildEventHeaders,
  buildRetryHeaders,
  type MessageHeaders,
  mergeHeaders,
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
  POLARIS_HEADER_PRODUCER,
  POLARIS_HEADER_PRODUCER_VERSION,
  POLARIS_HEADER_PROJECT_ID,
  POLARIS_HEADER_RETRY_ATTEMPTS,
  POLARIS_HEADER_RETRY_REASON,
  POLARIS_HEADER_SCHEMA_VERSION,
  POLARIS_HEADER_SOURCE_ID,
  POLARIS_HEADER_SOURCE_OFFSET,
  POLARIS_HEADER_SOURCE_PARTITION,
  POLARIS_HEADER_SOURCE_TOPIC,
  POLARIS_HEADER_TOPIC_FAMILY,
  type PolarisHeaderInput,
  type RetryHeaderInput,
  readHeaderNumber,
  readHeaderString,
} from "./headers.js";
export {
  composeHooks,
  emitHook,
  type KafkaHookEvent,
  type KafkaHookHandler,
  type KafkaHookPayload,
  type KafkaHooks,
} from "./hooks.js";
export {
  type CreateKafkaJsConsumerDriverOptions,
  createKafkaJsConsumerDriver,
  OFFSET_RANGE_TERMINATION_REASONS,
  type OffsetRangeBatch,
  type OffsetRangeBatchMessage,
  type OffsetRangeConsumerDriver,
  type OffsetRangeEvent,
  type OffsetRangeTerminationReason,
  type ReadOffsetRangeInput,
  type ReadOffsetRangeResult,
  readOffsetRange,
} from "./offset-range-reader.js";
export {
  buildRawEventsPartitionKey,
  type PartitionKeyIdentity,
  type PartitionKeyIdentitySource,
  type PartitionKeyInput,
  resolveRawEventsPartitionKey,
} from "./partition-key.js";
export {
  type CreatePolarisProducerOptions,
  createPolarisProducer,
  type PolarisProducer,
  type PublishableEvent,
  type PublishEventInput,
} from "./producer.js";
export {
  decodeEvent,
  EventDeserializationError,
  encodeEvent,
} from "./serialization.js";
export {
  consumerTopicsForFamily,
  type IsolationLookup,
  resolveTopicName,
  resolveTopicNameScoped,
  resolveTopicNameSync,
  type ScopedTopicResolverLookup,
  type SyncIsolationLookup,
  sharedOnlyIsolationLookup,
  staticIsolationLookup,
} from "./topic-family.js";
export {
  InMemoryScopedIsolationLookup,
  type ScopedIsolationLookup,
  TopicIsolationCache,
  type TopicIsolationCacheOptions,
} from "./topic-isolation-cache.js";
export {
  CANONICAL_TOPIC_FAMILIES,
  type CanonicalTopicFamily,
  dedicatedTopicName,
  dlqTopicName,
  isCanonicalTopicFamily,
  retryTopicName,
  TOPIC_DIAGNOSTICS_EVENTS,
  TOPIC_FAMILY_ANALYTICS_EVENTS,
  TOPIC_FAMILY_ATTRIBUTION_EVENTS,
  TOPIC_FAMILY_ENRICHED_EVENTS,
  TOPIC_FAMILY_IDENTITY_EVENTS,
  TOPIC_FAMILY_RAW_EVENTS,
} from "./topics.js";
