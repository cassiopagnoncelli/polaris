/**
 * Processor DLQ publish helper.
 *
 * Thin wrapper around `@polaris/shared-kafka`'s `republishToDlq`. Adds the
 * defaults that every processor needs:
 *
 *   - the `component` field is derived from the processor identity
 *     (`<processor_name>` — the DLQ topic resolver in `shared-kafka`
 *     suffixes `.dlq` automatically),
 *   - `failedAt` defaults to `now()` when the caller does not pin a
 *     timestamp,
 *   - the underlying retry classification is folded in so the failure
 *     reason on the DLQ headers matches the processor's own classification.
 *
 * The wrapper does NOT decide retry vs DLQ. Processors call this helper
 * only when they have already decided the message is going to the DLQ —
 * the helper is the LAST step. Retry routing uses `republishToRetry` from
 * `@polaris/shared-kafka` directly; the classifier in `./classify.ts`
 * names that decision.
 *
 * @see packages/shared-kafka/src/dlq.ts
 * @see docs/architecture/03-redpanda-topics.md "Retry and DLQ Topics"
 */

import { type MessageHeaders, type PolarisProducer, republishToDlq } from "@polaris/shared-kafka";
import type { EachMessagePayload, RecordMetadata } from "kafkajs";
import { classifyError, type ProcessorRetryClassification } from "./classify.js";
import type { ProcessorDlqRecordRepository } from "./db/processor-dlq-records.js";
import type { ProcessorIdentity } from "./identity.js";

/**
 * Input accepted by `publishToDlq`. The caller passes the producer (so the
 * processor can keep a single connection), the originating message payload
 * (so the wire bytes round-trip byte-identically), the offending error, and
 * the processor identity for the DLQ topic name.
 */
export interface PublishToDlqInput {
  /** Connected PolarisProducer. The helper does not own the lifecycle. */
  readonly producer: PolarisProducer;
  /** Processor identity. The DLQ topic name is `<name>.dlq`. */
  readonly identity: ProcessorIdentity;
  /** Original KafkaJS payload — used to copy bytes, headers, key, offset. */
  readonly payload: EachMessagePayload;
  /** The error that triggered the DLQ. */
  readonly error: unknown;
  /**
   * Optional classifier override. Defaults to `classifyError(error)`.
   * Tests pass a fixed verdict; advanced runtimes pin a processor-specific
   * reason code without re-running the classifier.
   */
  readonly classification?: ProcessorRetryClassification | undefined;
  /** ISO-8601 UTC failure timestamp. Defaults to `now()`. */
  readonly failedAt?: string | undefined;
  /**
   * Explicit `polaris-retry-attempts` override. The shared-kafka helper
   * defaults to reading the existing header and incrementing by 1.
   */
  readonly attempts?: number | undefined;
  /**
   * Optional `processor_dlq_records` repository (3L2HKMND). When
   * supplied, the helper writes a Postgres row alongside the Kafka
   * publish so the `polaris processors dlq` commands can triage from a
   * single PostgreSQL connection. The Kafka publish ALWAYS happens
   * (dual-write); a row-write failure logs a warning via the optional
   * `onRowFailure` hook but never blocks the Kafka publish.
   *
   * When omitted, the helper preserves the v1 Kafka-only behavior
   * (back-compat for callers that have not been wired to the new
   * surface yet).
   */
  readonly dlqRecords?: ProcessorDlqRecordRepository;
  /**
   * Polaris canonical envelope fields needed by the
   * `processor_dlq_records` row. Required when `dlqRecords` is set;
   * ignored otherwise. The runtime extracts these from the headers /
   * decoded envelope before deciding to DLQ-route, so the call site
   * already has them on hand.
   */
  readonly envelope?: ProcessorDlqEnvelopeMetadata;
  /**
   * Optional callback fired when the `dlq_records` row-write fails.
   * The Kafka publish has already succeeded; this hook lets the host
   * surface a warning without crashing the message handler.
   */
  readonly onRowFailure?: (err: unknown) => void;
}

/**
 * Canonical-envelope fields stamped onto the `processor_dlq_records`
 * row (3L2HKMND). The processor runtime already has these on hand by
 * the time it has decided to DLQ-route — passing them explicitly keeps
 * this helper from re-decoding the payload bytes.
 */
export interface ProcessorDlqEnvelopeMetadata {
  readonly event_id: string;
  readonly event_name: string;
  readonly project_id: string;
  readonly environment: string;
}

/**
 * Publish the offending message to the processor's DLQ topic.
 *
 * Returns the `RecordMetadata` array from the underlying KafkaJS send —
 * callers usually ignore it but tests may assert delivery.
 */
export async function publishToDlq(input: PublishToDlqInput): Promise<RecordMetadata[]> {
  const classification = input.classification ?? classifyError(input.error);
  const failedAt = input.failedAt ?? new Date().toISOString();

  const errorClass = input.error instanceof Error ? input.error.name : undefined;
  const errorMessage =
    input.error instanceof Error
      ? input.error.message
      : typeof input.error === "string"
        ? input.error
        : undefined;

  const result = await republishToDlq(input.producer, {
    component: input.identity.name,
    value: input.payload.message.value,
    ...(input.payload.message.key !== null && input.payload.message.key !== undefined
      ? { key: input.payload.message.key }
      : {}),
    ...(input.payload.message.headers !== undefined
      ? { headers: input.payload.message.headers as MessageHeaders }
      : {}),
    sourceTopic: input.payload.topic,
    sourcePartition: input.payload.partition,
    sourceOffset: input.payload.message.offset,
    reason: classification.reason,
    ...(errorClass !== undefined ? { errorClass } : {}),
    ...(errorMessage !== undefined ? { errorMessage } : {}),
    failedAt,
    ...(input.attempts !== undefined ? { attempts: input.attempts } : {}),
  });

  // 3L2HKMND: Postgres dual-write. The Kafka publish above is the
  // source of truth for backward compatibility (existing dashboards
  // and runbooks consume the topic); the row makes the queue
  // queryable from `polaris processors dlq`. A row-write failure
  // does NOT block: the Kafka publish has already succeeded.
  if (input.dlqRecords !== undefined && input.envelope !== undefined) {
    try {
      await input.dlqRecords.recordDlq({
        processor_name: input.identity.name,
        processor_version: input.identity.version,
        event_id: input.envelope.event_id,
        event_name: input.envelope.event_name,
        project_id: input.envelope.project_id,
        environment: input.envelope.environment,
        attempts: input.attempts ?? 0,
        reason: classification.reason,
        ...(errorClass !== undefined ? { error_class: errorClass } : {}),
        ...(errorMessage !== undefined ? { error_message: errorMessage } : {}),
        source_topic: input.payload.topic,
        source_partition: input.payload.partition,
        source_offset: input.payload.message.offset,
        ...(input.payload.message.headers !== undefined
          ? { headers: stringifyHeaders(input.payload.message.headers as MessageHeaders) }
          : {}),
        ...(input.payload.message.value !== null && input.payload.message.value !== undefined
          ? { payload: input.payload.message.value }
          : {}),
      });
    } catch (err) {
      if (input.onRowFailure !== undefined) {
        input.onRowFailure(err);
      }
    }
  }

  return result;
}

/**
 * Coerce a KafkaJS `IHeaders` map into the `Record<string, string>`
 * shape `processor_dlq_records.headers` stores. Buffer values are
 * decoded as UTF-8; non-string, non-Buffer values become an empty
 * string (defensive — the producers do not emit them).
 */
function stringifyHeaders(headers: MessageHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") {
      out[key] = value;
    } else if (
      value !== undefined &&
      value !== null &&
      typeof (value as Buffer).toString === "function"
    ) {
      out[key] = (value as Buffer).toString("utf8");
    } else {
      out[key] = "";
    }
  }
  return out;
}
