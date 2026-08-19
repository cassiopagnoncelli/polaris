/**
 * `@polaris/shared-transport` — Polaris's event transport port and its
 * RabbitMQ driver.
 *
 * Polaris services talk to the broker exclusively through this package.
 * Unlike its predecessor (`@polaris/shared-kafka`, which re-exported
 * KafkaJS types and handed out `.raw`), **no driver type crosses this
 * boundary**. A service handles a `TransportMessagePayload`; it never sees
 * an amqplib `ConsumeMessage`. That is what makes the transport a
 * replaceable component rather than a structural commitment.
 *
 * What it standardizes:
 *
 *   - connection supervision and reconnect
 *   - topology declaration (super streams, retry tiers, DLQs)
 *   - producer/consumer creation
 *   - partition keys and partition assignment
 *   - message headers and event serialization
 *   - consumer checkpoints
 *   - metrics/logging hooks
 *   - stream-family constants and isolation resolution
 *   - retry/DLQ publishing helpers
 *   - the replay range reader
 *
 * Typical service wiring:
 *
 * ```ts
 * import { loadConfig, rabbitmqEnvSchema, composeConfigSchema } from "@polaris/shared-config";
 * import { createLogger } from "@polaris/shared-logger";
 * import {
 *   createTransportConnection,
 *   createPolarisProducer,
 *   STREAM_FAMILY_RAW_EVENTS,
 *   staticIsolationLookup,
 * } from "@polaris/shared-transport";
 *
 * const config = loadConfig({
 *   serviceName: "ingester-api",
 *   schema: composeConfigSchema({ rabbitmq: rabbitmqEnvSchema }),
 * });
 * const logger = createLogger({ service: "ingester-api" });
 * const connection = createTransportConnection({ rabbitmq: config.rabbitmq, logger });
 *
 * const producer = createPolarisProducer({
 *   connection,
 *   logger,
 *   producerName: "ingester-api",
 * });
 *
 * await producer.connect();
 *
 * await producer.publishEvent({
 *   family: STREAM_FAMILY_RAW_EVENTS,
 *   event: envelope,
 *   isolation: staticIsolationLookup([]),
 * });
 * ```
 *
 * @see docs/architecture/03-rabbitmq-streams.md
 * @see docs/architecture/09-engineering-standards.md "Transport Client Usage"
 */

// Re-exported so provisioning tooling parses partition widths with the
// exact function the running services use. Width is a wire contract:
// publisher and broker disagreeing about it breaks per-identity ordering
// silently. Owned by shared-config (which defines the env schema); surfaced
// here because transport consumers are who care about it.
export { parsePartitionOverrides } from "@polaris/shared-config";
export {
  type Checkpoint,
  type CheckpointStore,
  DeferredCheckpointStore,
  InMemoryCheckpointStore,
  PostgresCheckpointStore,
} from "./checkpoints.js";
export {
  type CreateTransportConnectionOptions,
  createTransportConnection,
  DEFAULT_RECONNECT_OPTIONS,
  type ReconnectListener,
  type ReconnectOptions,
  type TransportConnection,
} from "./connection.js";
export {
  type CreatePolarisConsumerOptions,
  createPolarisConsumer,
  offsetSpec,
  type PoisonHandle,
  type PoisonRecord,
  type PolarisConsumer,
  QUEUE_PARTITION,
  type StreamStartPosition,
  type SubscribeInput,
} from "./consumer.js";
export {
  type RepublishInput,
  readRetryAttempts,
  republishToDlq,
  republishToRetry,
} from "./dlq.js";
export {
  type AmqpHeaders,
  buildEventHeaders,
  buildRetryHeaders,
  fromAmqpHeaders,
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
  toAmqpHeaders,
} from "./headers.js";
export {
  composeHooks,
  emitHook,
  type TransportHookEvent,
  type TransportHookHandler,
  type TransportHookPayload,
  type TransportHooks,
} from "./hooks.js";
export {
  InMemoryScopedIsolationLookup,
  type ScopedIsolationLookup,
  StreamIsolationCache,
  type StreamIsolationCacheOptions,
} from "./isolation-cache.js";
export {
  type ActiveIsolation,
  createIsolationSnapshot,
  type CreateIsolationSnapshotOptions,
  createKyselyIsolationSnapshotReader,
  type IsolationSnapshot,
  type IsolationSnapshotReader,
  startIsolationSnapshot,
} from "./isolation-snapshot.js";
export {
  type CreateTransportLogHooksInput,
  createTransportLogHooks,
} from "./log-hooks.js";
export {
  buildProfilePartitionKey,
  buildRawEventsPartitionKey,
  type PartitionKeyIdentity,
  type PartitionKeyIdentitySource,
  type PartitionKeyInput,
  partitionForKey,
  resolveProfilePartitionKey,
  resolveRawEventsPartitionKey,
} from "./partition-key.js";
export {
  createAmqpStreamRangeDriver,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_SLACK_MS,
  type FollowStreamInput,
  type FollowStreamResult,
  followStream,
  type ReadStreamRangeInput,
  type ReadStreamRangeResult,
  rangeOffsetSpec,
  readStreamRange,
  STREAM_RANGE_TERMINATION_REASONS,
  type StreamRangeDelivery,
  type StreamRangeDriver,
  type StreamRangeEvent,
  type StreamRangeTerminationReason,
  type StreamTailTerminationReason,
} from "./partition-stream-readers.js";
export {
  type CreatePolarisProducerOptions,
  createPolarisProducer,
  type PolarisProducer,
  type PublishableEvent,
  type PublishEventInput,
  type PublishInput,
  type PublishToQueueInput,
} from "./producer.js";
export {
  decodeEvent,
  EventDeserializationError,
  encodeEvent,
} from "./serialization.js";
export {
  consumerFamiliesFor,
  type IsolationLookup,
  resolveStreamFamily,
  resolveStreamFamilyScoped,
  resolveStreamFamilySync,
  type ScopedStreamResolverLookup,
  type SyncIsolationLookup,
  sharedOnlyIsolationLookup,
  staticIsolationLookup,
} from "./stream-family.js";
export {
  CANONICAL_STREAM_FAMILIES,
  type CanonicalStreamFamily,
  dedicatedStreamFamily,
  dlqQueueName,
  isCanonicalStreamFamily,
  parsePartitionStreamName,
  partitionStreamName,
  partitionStreamNames,
  RETRY_BACKOFF_TIERS_MS,
  redeliverQueueName,
  retryExchangeName,
  retryQueueName,
  retryQueueNames,
  retryTierForAttempt,
  STREAM_DIAGNOSTICS_EVENTS,
  STREAM_FAMILY_ATTRIBUTION_EVENTS,
  STREAM_FAMILY_IDENTIFIED_EVENTS,
  STREAM_FAMILY_IDENTITY_EVENTS,
  STREAM_FAMILY_PROFILE_EVENTS,
  STREAM_FAMILY_RAW_EVENTS,
  STREAM_FAMILY_REJECTED_EVENTS,
  STREAM_FAMILY_RESOLVED_EVENTS,
  STREAM_FAMILY_SESSION_EVENTS,
  streamExchangeName,
} from "./streams.js";
export {
  type ComponentQueueSpec,
  DEFAULT_STREAM_MAX_BYTES,
  type DeclareTopologyInput,
  DIAGNOSTICS_RETENTION_DAYS,
  declareComponentQueues,
  declareSuperStream,
  declareTopology,
  declareTopologyOnChannel,
  defaultSuperStreams,
  deleteComponentQueues,
  deleteSuperStream,
  diagnosticsSuperStream,
  IDENTIFIED_EVENTS_RETENTION_DAYS,
  POLARIS_COMPONENTS,
  type SuperStreamSpec,
} from "./topology.js";
export type {
  PublishResult,
  TransportMessage,
  TransportMessageContext,
  TransportMessageHandler,
  TransportMessagePayload,
} from "./types.js";
