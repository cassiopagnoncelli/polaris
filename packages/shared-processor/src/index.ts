/**
 * `@polaris/shared-processor` — processor runtime helpers.
 *
 * Polaris processors are independent, versioned TypeScript services per
 * `docs/architecture/05-processors-and-replay.md`. This package
 * standardises the small set of glue every processor needs without
 * hiding the underlying KafkaJS / PolarisConsumer / PolarisProducer
 * surface — that's a hard architectural rule from
 * `docs/architecture/09-engineering-standards.md` "RabbitMQ Client Usage":
 *
 *   > Do not build a full stream-processing framework in v1. Keep wrappers
 *   > thin and preserve escape hatches for advanced KafkaJS behavior.
 *
 * The helpers in this package WRAP that glue:
 *
 *   - processor identity types and structured log context (`./identity`)
 *   - dual-shape metadata stamping (`./metadata`)
 *   - PostgreSQL processor-run registration (`./runs`)
 *   - per-message activation gating (`./activation-gate`)
 *   - deterministic derived event ids (`./derived-id`)
 *   - boot-to-shutdown run lifecycle policy on top of it (`./run-lifecycle`)
 *   - retry/DLQ error classification (`./classify`)
 *   - DLQ publish helper on top of `@polaris/shared-transport` (`./dlq`)
 *   - in-memory metrics counters (`./metrics`)
 *   - manifest loader (`./manifest`)
 *
 * What this package does NOT do:
 *
 *   - own the consumer/producer lifecycle (that stays in `app.ts`
 *     bootstrap code per processor),
 *   - hide `kafka.consume(...)` or `transform(...)` behind a single
 *     `Polaris.run(...)` entry point,
 *   - decide between retry-vs-DLQ for the caller (the classifier names
 *     the decision; the runtime branches),
 *   - expose a Prometheus exposition format (P10-002 swaps the
 *     `ProcessorMetrics` backend without touching the call sites).
 *
 * @see processors/analytics-projector/v1/src/ — first consumer of the helpers
 */

export {
  type ActivationStateReader,
  ALWAYS_ENABLED_GATE,
  type CreateProcessorActivationGateInput,
  createProcessorActivationGate,
  DEFAULT_ACTIVATION_TTL_MS,
  type ProcessorActivationGate,
  type ProcessorActivationScope,
} from "./activation-gate.js";
export {
  classifyError,
  PROCESSOR_RETRY_REASONS,
  type ProcessorRetryClassification,
  type ProcessorRetryReason,
} from "./classify.js";
export {
  createKyselyProcessorDlqRecordRepository,
  InMemoryProcessorDlqRecordRepository,
  type InMemoryProcessorDlqRecordRepositoryOptions,
  type KyselyProcessorDlqRecordRepositoryOptions,
  LIST_PROCESSOR_DLQ_RECORDS_HARD_LIMIT,
  type ListProcessorDlqRecordsFilter,
  type MarkResolvedOutcome,
  PROCESSOR_DLQ_RECORD_ID_PREFIX,
  type ProcessorDlqRecord,
  type ProcessorDlqRecordRepository,
  type ProcessorDlqRecordsTable,
  type RecordProcessorDlqInput,
} from "./db/processor-dlq-records.js";
export {
  type DeriveEventIdInput,
  deriveEventId,
  POLARIS_DERIVED_EVENT_NAMESPACE,
} from "./derived-id.js";
export {
  type ProcessorDlqEnvelopeMetadata,
  type PublishToDlqInput,
  publishToDlq,
} from "./dlq.js";
export {
  type ProcessorIdentity,
  type ProcessorLogContextInput,
  processorLogContext,
} from "./identity.js";
export {
  type LoadedProcessorManifest,
  type LoadProcessorManifestOptions,
  loadProcessorManifest,
  PROCESSOR_MODES,
  PROCESSOR_RELEASE_STATUSES,
  type ProcessorDefaults,
  type ProcessorFixture,
  type ProcessorFixtureIssue,
  type ProcessorFixtureValidation,
  type ProcessorManifest,
  ProcessorManifestError,
  type ProcessorMode,
  type ProcessorReleaseStatus,
  type ProcessorReplay,
  type ProcessorTopicSpec,
  processorDefaultsSchema,
  processorFixtureSchema,
  processorManifestSchema,
  processorModeSchema,
  processorNameSchema,
  processorReleaseStatusSchema,
  processorReplaySchema,
  processorTopicSpecSchema,
  processorVersionSchema,
  tryLoadProcessorManifest,
  type ValidateProcessorFixturesOptions,
  validateProcessorFixtures,
} from "./manifest.js";
export {
  type CanonicalEnvelopeInput,
  type ProcessorStamp,
  type StampedEnvelope,
  type StampProcessorMetadataOptions,
  stampProcessorMetadata,
} from "./metadata.js";
export {
  METRIC_PROCESSOR_EVENTS_CONSUMED_TOTAL,
  METRIC_PROCESSOR_EVENTS_DLQ_TOTAL,
  METRIC_PROCESSOR_EVENTS_EMITTED_TOTAL,
  METRIC_PROCESSOR_EVENTS_FAILED_TOTAL,
  METRIC_PROCESSOR_EVENTS_RETRY_TOTAL,
  METRIC_PROCESSOR_EVENTS_SKIPPED_TOTAL,
  METRIC_PROCESSOR_HANDLER_DURATION_MS_LAST,
  METRIC_PROCESSOR_LAG_MS_LAST,
  type MetricSample,
  type ProcessorFailureLabels,
  type ProcessorMetricLabels,
  ProcessorMetrics,
} from "./metrics.js";
export {
  DEFAULT_HEARTBEAT_MS,
  type OpenProcessorRunInput,
  openProcessorRun,
  type ProcessorRunHandle,
  type ProcessorRunScheduler,
  readCounters,
  type StartProcessorRunInput,
  startProcessorRun,
} from "./run-lifecycle.js";
export {
  type CancelRunInput,
  type CompleteRunInput,
  createKyselyProcessorRunRepository,
  type FailRunInput,
  InMemoryProcessorRunRepository,
  type InMemoryProcessorRunRepositoryOptions,
  InvalidRunTransitionError,
  type KyselyProcessorRunRepositoryOptions,
  PROCESSOR_RUN_STATUSES,
  type ProcessorRunCounters,
  type ProcessorRunRecord,
  type ProcessorRunRepository,
  type ProcessorRunStatus,
  type RegisterRunInput,
  type UpdateRunInput,
} from "./runs.js";
