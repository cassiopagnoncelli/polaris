/**
 * Retry and DLQ helpers.
 *
 * Per `docs/architecture/03-rabbitmq-streams.md`:
 *
 *   Processors and consumers own their retry and DLQ queues.
 *   Retries and DLQs must include enough metadata to diagnose source
 *   event, processor/consumer version, error class, attempts, and
 *   timestamps.
 *
 * Two thin helpers:
 *
 *   - `republishToRetry` — publish to the retry tier matching the attempt
 *     count, with bumped `polaris-retry-attempts` and failure metadata.
 *     The broker holds the message for the tier's TTL and then routes it
 *     to `<component>.redeliver`, which the component consumes alongside
 *     its streams. **The delay is the broker's job now** — under Kafka the
 *     consumer slept, which burned a consumer slot and made backoff
 *     invisible to operators.
 *
 *   - `republishToDlq` — publish to the component's terminal DLQ with the
 *     same failure metadata.
 *
 * Retry vs DLQ policy (max attempts, error classes that bypass retry) is
 * **not** owned by this package. Processors and consumers decide which
 * helper to call based on their own rules.
 *
 * The helpers copy the original bytes verbatim — they do not re-serialize
 * the envelope — so replay tooling can rely on `event_id` equality across
 * hops.
 */

import {
  buildRetryHeaders,
  type MessageHeaders,
  mergeHeaders,
  POLARIS_HEADER_RETRY_ATTEMPTS,
  type RetryHeaderInput,
  readHeaderNumber,
} from "./headers.js";
import type { PolarisProducer } from "./producer.js";
import { dlqQueueName, retryQueueName, retryTierForAttempt } from "./streams.js";

/**
 * Per-message republish input. Callers pass the original message bytes,
 * headers, and key alongside failure context.
 */
export interface RepublishInput {
  /** Component identifier (matches the processor/consumer directory name). */
  readonly component: string;
  /** Original message bytes from `payload.message.value`. */
  readonly value: Buffer | string | null;
  /** Original partition key. Preserved so ordering survives the retry hop. */
  readonly key?: string | null;
  /** Original message headers. Platform headers are preserved verbatim. */
  readonly headers?: MessageHeaders;
  /** Source stream the message was originally consumed from. */
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
 * Republish a message to the retry tier for its attempt count. Returns the
 * tier (in ms) the message was parked in, so callers can log the delay
 * they actually bought.
 */
export async function republishToRetry(
  producer: PolarisProducer,
  input: RepublishInput,
): Promise<number> {
  const attempts = nextAttempts(input);
  const tier = retryTierForAttempt(attempts);
  await publishRepublish(producer, retryQueueName(input.component, tier), input, attempts);
  return tier;
}

/**
 * Republish a message to the component's DLQ queue (`<component>.dlq`).
 */
export async function republishToDlq(
  producer: PolarisProducer,
  input: RepublishInput,
): Promise<void> {
  const attempts = nextAttempts(input);
  await publishRepublish(producer, dlqQueueName(input.component), input, attempts);
}

/** Read the current attempt count from headers (defaults to 0 if missing). */
export function readRetryAttempts(headers: MessageHeaders | undefined): number {
  return readHeaderNumber(headers, POLARIS_HEADER_RETRY_ATTEMPTS) ?? 0;
}

function nextAttempts(input: RepublishInput): number {
  return input.attempts ?? readRetryAttempts(input.headers) + 1;
}

async function publishRepublish(
  producer: PolarisProducer,
  queue: string,
  input: RepublishInput,
  attempts: number,
): Promise<void> {
  const retryHeaderInput: RetryHeaderInput = {
    attempts,
    reason: input.reason,
    error_class: input.errorClass,
    error_message: input.errorMessage,
    failed_at: input.failedAt,
    source_topic: input.sourceTopic,
    source_partition: input.sourcePartition,
    source_offset: input.sourceOffset,
  };
  const headers = mergeHeaders(input.headers, buildRetryHeaders(retryHeaderInput));
  const value =
    input.value === null
      ? Buffer.alloc(0)
      : Buffer.isBuffer(input.value)
        ? input.value
        : Buffer.from(input.value, "utf8");
  await producer.publishToQueue({
    queue,
    value,
    headers,
    ...(input.key !== undefined ? { partitionKey: input.key } : {}),
  });
}
