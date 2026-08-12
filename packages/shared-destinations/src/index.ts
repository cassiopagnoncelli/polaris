/**
 * `@polaris/shared-destinations` — the destination consumer runtime.
 *
 * Polaris destinations follow a five-stage pipeline per
 * `docs/architecture/06-destinations.md`:
 *
 *   analytics.events -> subscribe -> NORMALIZE -> MAP -> DELIVER -> RECORD
 *
 * The runtime in this package is destination-AGNOSTIC. Vendor-specific
 * mapping and delivery code live under `consumers/<vendor>/v<N>/` and
 * compose with this runtime by supplying `Mapper` + `Deliverer`
 * implementations that match the typed contracts in `./types.ts`.
 *
 * NORMALIZE is delegated to `@polaris/shared-destination-normalize`
 * (P9-000). This runtime owns subscribe + mapper invocation + delivery
 * + delivery_records persistence + DLQ routing + rate limiting +
 * idempotency + replay suppression.
 *
 * @see docs/architecture/06-destinations.md
 * @see docs/implementation/tasks/P9-001-destination-consumer-runtime.md
 */

export {
  createKyselyDeliveryRecordRepository,
  DELIVERY_RECORD_ERROR_CLASSES,
  DELIVERY_RECORD_STATUSES,
  type DeliveryRecord,
  type DeliveryRecordErrorClass,
  type DeliveryRecordRepository,
  type DeliveryRecordStatus,
  type DeliveryRecordsTable,
  InMemoryDeliveryRecordRepository,
  type InMemoryDeliveryRecordRepositoryOptions,
  isDeliveryRecordErrorClass,
  isDeliveryRecordStatus,
  type KyselyDeliveryRecordRepositoryOptions,
  LIST_DELIVERY_RECORDS_HARD_LIMIT,
  type ListDeliveryRecordsFilter,
  type RecordDeliveryInput,
  truncateSummary,
  VENDOR_RESPONSE_SUMMARY_MAX_LENGTH,
} from "./db/delivery-records.js";
export {
  createKyselyDestinationInstanceReader,
  type DestinationInstance,
  DestinationInstanceCache,
  type DestinationInstanceCacheOptions,
  type DestinationInstanceReader,
  InMemoryDestinationInstanceReader,
  type KyselyDestinationInstanceReaderOptions,
} from "./db/destination-instance.js";
export {
  createKyselyDlqRecordRepository,
  DLQ_RECORD_ID_PREFIX,
  DLQ_RESOLUTION_NOTE_MAX_LENGTH,
  type DlqRecord,
  type DlqRecordRepository,
  type DlqRecordsTable,
  InMemoryDlqRecordRepository,
  type InMemoryDlqRecordRepositoryOptions,
  type KyselyDlqRecordRepositoryOptions,
  LIST_DLQ_RECORDS_HARD_LIMIT,
  type ListDlqRecordsFilter,
  type MarkResolvedOutcome,
  type RecordDlqInput,
} from "./db/dlq-records.js";
export {
  type DestinationDedupe,
  InMemoryDestinationDedupe,
  type InMemoryDestinationDedupeOptions,
} from "./dedupe.js";
export {
  POLARIS_HEADER_CONSUMER_VERSION,
  POLARIS_HEADER_DELIVERER_VERSION,
  POLARIS_HEADER_DELIVERY_KEY,
  POLARIS_HEADER_DESTINATION_ID,
  POLARIS_HEADER_DESTINATION_INSTANCE_LABEL,
  POLARIS_HEADER_DESTINATION_VENDOR,
  POLARIS_HEADER_MAPPER_VERSION,
  POLARIS_HEADER_NORMALIZE_VERSION,
  type PublishToDestinationDlqInput,
  publishToDestinationDlq,
} from "./dlq.js";
export {
  buildDeliveryKey,
  DELIVERY_KEY_PREFIX,
  type DeliveryKeyInput,
} from "./idempotency.js";
export {
  type DestinationMetricLabels,
  DestinationMetrics,
  type DestinationOutcomeLabels,
  METRIC_DESTINATION_DELIVERY_DURATION_MS_LAST,
  METRIC_DESTINATION_EVENTS_CONSUMED_TOTAL,
  METRIC_DESTINATION_EVENTS_DEDUPED_TOTAL,
  METRIC_DESTINATION_EVENTS_DELIVERED_TOTAL,
  METRIC_DESTINATION_EVENTS_DLQ_TOTAL,
  METRIC_DESTINATION_EVENTS_DROPPED_TOTAL,
  METRIC_DESTINATION_EVENTS_FAILED_TOTAL,
  METRIC_DESTINATION_EVENTS_RETRY_TOTAL,
  METRIC_DESTINATION_EVENTS_SKIPPED_TOTAL,
  METRIC_DESTINATION_RATE_LIMIT_WAIT_MS_LAST,
  METRIC_DESTINATION_REPLAY_SUPPRESSED_TOTAL,
  type MetricSample,
} from "./metrics.js";
export {
  DestinationRateLimiter,
  type DestinationRateLimiterOptions,
  type RateLease,
} from "./rate-limiter.js";
export {
  type ApplyReplayPolicyInput,
  applyReplayPolicy,
  POLARIS_HEADER_REPLAY,
  POLARIS_HEADER_REPLAY_JOB_ID,
  type ReplayContext,
  type ReplayPolicyDecision,
  type ReplaySuppressionReason,
  readReplayContext,
} from "./replay-suppression.js";
export {
  createDestinationConsumer,
  type DestinationConsumer,
  type DestinationConsumerOptions,
  type HandleEventFn,
  type HandleEventInput,
} from "./runtime.js";
export {
  type CreateDestinationTransportHooksInput,
  createDestinationTransportHooks,
} from "./transport-hooks.js";
export type {
  ConsumerIdentity,
  Deliverer,
  DelivererContext,
  DelivererResult,
  DestinationDescriptor,
  Mapper,
  MapperContext,
  MapperMap,
  MapperResult,
  RuntimeDropReason,
} from "./types.js";
