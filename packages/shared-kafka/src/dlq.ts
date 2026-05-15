/**
 * Retry and DLQ helpers.
 *
 * Per `docs/architecture/03-redpanda-topics.md`:
 *
 *   Processors and consumers own their retry and DLQ topics.
 *   Retries and DLQs must include enough metadata to diagnose source event,
 *   processor/consumer version, error class, attempts, and timestamps.
 *
 * This module exposes two thin helpers:
 *
 *   - `republishToRetry` — publish a message to the component's retry topic
 *     with bumped `polaris-retry-attempts` and failure metadata,
 *   - `republishToDlq` — publish a message to the component's DLQ topic with
 *     the same failure metadata.
 *
 * Retry vs DLQ policy (max attempts, error classes that bypass retry, retry
 * delay) is **not** owned by this package. Processors and consumers decide
 * whether the next attempt goes to retry or DLQ based on their own rules
 * and call the corresponding helper.
 *
 * The helpers leave message ordering, batching, and partition keys to the
 * caller. The default behavior copies the source partition key so retried
 * messages preserve per-identity ordering when they re-enter the pipeline.
 */

import type { Message, ProducerRecord, RecordMetadata } from "kafkajs";
import {
  buildRetryHeaders,
  type MessageHeaders,
  mergeHeaders,
  POLARIS_HEADER_RETRY_ATTEMPTS,
  type RetryHeaderInput,
  readHeaderNumber,
} from "./headers.js";
import type { PolarisProducer } from "./producer.js";
import { dlqTopicName, retryTopicName } from "./topics.js";

/**
 * Per-message republish input. Callers pass the original message bytes,
 * headers, key, partition, and offset alongside failure context.
 *
 * The helpers reach into the message only to copy the key/value/headers —
 * they do not re-serialize the canonical envelope. This keeps the wire
 * payload byte-identical to the original so replay tooling can rely on
 * `event_id` equality across topics.
 */
export interface RepublishInput {
  /** Component identifier (matches the processor/consumer directory name). */
  readonly component: string;
  /** Original message bytes from KafkaJS `EachMessagePayload.message.value`. */
  readonly value: Buffer | string | null;
  /** Original message key. KafkaJS preserves it through retry/DLQ topics. */
  readonly key?: Buffer | string | null;
  /** Original message headers. Platform headers are preserved verbatim. */
  readonly headers?: MessageHeaders;
  /** Source topic the message was originally consumed from. */
  readonly sourceTopic: string;
  /** Source partition (for diagnostics). */
  readonly sourcePartition?: number;
  /** Source offset (for diagnostics). */
  readonly sourceOffset?: string;
  /** Failure reason string (matches the component's error classification). */
  readonly reason: string;
  /** Underlying error class name (e.g. `ValidationError`). */
  readonly errorClass?: string;
  /** Underlying error message (truncated by the caller as needed). */
  readonly errorMessage?: string;
  /** Wall-clock timestamp the failure was observed (ISO-8601 UTC). */
  readonly failedAt: string;
  /**
   * Explicit attempt counter override. When undefined the helper reads
   * `polaris-retry-attempts` from headers and increments it.
   */
  readonly attempts?: number;
}

/**
 * Republish a message to the component's retry topic
 * (`<component>.retry`). Increments the attempt counter and merges failure
 * metadata into the headers.
 */
export async function republishToRetry(
  producer: PolarisProducer,
  input: RepublishInput,
): Promise<RecordMetadata[]> {
  const topic = retryTopicName(input.component);
  return publishRepublish(producer, topic, input);
}

/**
 * Republish a message to the component's DLQ topic (`<component>.dlq`).
 * Increments the attempt counter and merges failure metadata into the
 * headers.
 */
export async function republishToDlq(
  producer: PolarisProducer,
  input: RepublishInput,
): Promise<RecordMetadata[]> {
  const topic = dlqTopicName(input.component);
  return publishRepublish(producer, topic, input);
}

/** Read the current attempt count from headers (defaults to 0 if missing). */
export function readRetryAttempts(headers: MessageHeaders | undefined): number {
  return readHeaderNumber(headers, POLARIS_HEADER_RETRY_ATTEMPTS) ?? 0;
}

async function publishRepublish(
  producer: PolarisProducer,
  topic: string,
  input: RepublishInput,
): Promise<RecordMetadata[]> {
  const nextAttempts = input.attempts ?? readRetryAttempts(input.headers) + 1;
  const retryHeaderInput: RetryHeaderInput = {
    attempts: nextAttempts,
    reason: input.reason,
    error_class: input.errorClass,
    error_message: input.errorMessage,
    failed_at: input.failedAt,
    source_topic: input.sourceTopic,
    source_partition: input.sourcePartition,
    source_offset: input.sourceOffset,
  };
  const mergedHeaders = mergeHeaders(input.headers, buildRetryHeaders(retryHeaderInput));
  const message: Message = {
    value: input.value,
    headers: mergedHeaders,
  };
  if (input.key !== undefined && input.key !== null) {
    message.key = input.key;
  }
  const record: ProducerRecord = {
    topic,
    messages: [message],
  };
  return producer.send(record);
}
