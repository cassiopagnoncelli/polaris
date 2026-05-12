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

import type { EachMessagePayload, RecordMetadata } from "kafkajs";
import { type MessageHeaders, type PolarisProducer, republishToDlq } from "@polaris/shared-kafka";

import type { ProcessorIdentity } from "./identity.js";
import { classifyError, type ProcessorRetryClassification } from "./classify.js";

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

  return republishToDlq(input.producer, {
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
}
