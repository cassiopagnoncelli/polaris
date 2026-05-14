/**
 * Destination consumer DLQ publish helper.
 *
 * Per `docs/architecture/06-destinations.md` "Retry and DLQ Policy", each
 * consumer owns retry and DLQ topics named `<vendor>.retry` and
 * `<vendor>.dlq`. The architecture doc lists examples (`meta-capi.dlq`,
 * `ga4.dlq`); the topic-resolver in `@polaris/shared-kafka`'s
 * `dlqTopicName` builds the literal.
 *
 * For destination consumers, the "component" identifier in the DLQ topic
 * name is `<vendor>.<consumerVersion>` so a v2 migration does not collide
 * with v1 traffic on the same DLQ. Example: `meta-capi.v1.dlq` vs
 * `meta-capi.v2.dlq`.
 *
 * This helper wraps `@polaris/shared-kafka`'s `republishToDlq` with the
 * defaults a destination consumer always wants:
 *
 *   - the `component` is `<vendor>.<consumerVersion>` (so DLQ topic names
 *     carry the version),
 *   - extra stage-version headers are merged in so DLQ consumers can
 *     pivot on the exact `(normalize, mapper, deliverer)` versions that
 *     produced the failure,
 *   - the destination id and instance label are added as headers for
 *     operator triage.
 *
 * Secrets must NEVER appear in DLQ payloads. The helper does not accept
 * a resolved secret value; it only echoes the headers / value bytes from
 * the original message.
 *
 * @see packages/shared-kafka/src/dlq.ts
 * @see docs/architecture/06-destinations.md "Retry and DLQ Policy"
 */

import type { EachMessagePayload, RecordMetadata } from "kafkajs";
import { type MessageHeaders, type PolarisProducer, republishToDlq } from "@polaris/shared-kafka";

import type { DestinationInstance } from "./db/destination-instance.js";
import type { ConsumerIdentity } from "./types.js";

/**
 * Polaris-defined extra headers stamped on destination DLQ messages.
 * Mirrors the `polaris-*` convention from `@polaris/shared-kafka`.
 */
export const POLARIS_HEADER_DESTINATION_ID = "polaris-destination-id";
export const POLARIS_HEADER_DESTINATION_VENDOR = "polaris-destination-vendor";
export const POLARIS_HEADER_DESTINATION_INSTANCE_LABEL = "polaris-destination-instance-label";
export const POLARIS_HEADER_CONSUMER_VERSION = "polaris-consumer-version";
export const POLARIS_HEADER_NORMALIZE_VERSION = "polaris-normalize-version";
export const POLARIS_HEADER_MAPPER_VERSION = "polaris-mapper-version";
export const POLARIS_HEADER_DELIVERER_VERSION = "polaris-deliverer-version";
export const POLARIS_HEADER_DELIVERY_KEY = "polaris-delivery-key";

/**
 * Input accepted by `publishToDestinationDlq`. The caller passes the
 * producer (so one connection is shared across destinations), the
 * originating message payload (so bytes round-trip identically), the
 * descriptor identity, the destination instance, the offending error /
 * classification, and an optional delivery key.
 */
export interface PublishToDestinationDlqInput {
  /** Connected PolarisProducer. The helper does not own its lifecycle. */
  readonly producer: PolarisProducer;
  /** Static descriptor identity (vendor + per-stage versions). */
  readonly identity: ConsumerIdentity;
  /** Destination instance read at attempt time. */
  readonly instance: DestinationInstance;
  /** Original KafkaJS payload — used to copy bytes, headers, key, offset. */
  readonly payload: EachMessagePayload;
  /**
   * Classification reason. Mirrors the
   * `@polaris/shared-processor`'s classify-error reason set but allows
   * destination-specific reasons (`mapping`, `auth`, etc.) for header
   * clarity.
   */
  readonly reason: string;
  /** Optional underlying error for `errorClass` / `errorMessage` headers. */
  readonly error?: unknown;
  /** ISO-8601 UTC failure timestamp. Defaults to `now()`. */
  readonly failedAt?: string;
  /** Optional `attempts` override. */
  readonly attempts?: number;
  /** Stable delivery key. Stamped onto the DLQ message headers. */
  readonly delivery_key?: string;
}

/**
 * Publish the offending message to the consumer's DLQ topic
 * (`<vendor>.<consumerVersion>.dlq`).
 *
 * Returns the `RecordMetadata` array from the underlying KafkaJS send —
 * callers usually ignore it but tests assert delivery.
 */
export async function publishToDestinationDlq(
  input: PublishToDestinationDlqInput,
): Promise<RecordMetadata[]> {
  const failedAt = input.failedAt ?? new Date().toISOString();

  const errorClass = input.error instanceof Error ? input.error.name : undefined;
  const errorMessage =
    input.error instanceof Error
      ? input.error.message
      : typeof input.error === "string"
        ? input.error
        : undefined;

  // The DLQ component name carries the version so two consumer versions
  // can run side-by-side without colliding on the DLQ topic. Example:
  // `meta-capi.v1.dlq`.
  const component = `${input.identity.vendor}.${input.identity.consumerVersion}`;

  // Stamp stage-version + destination headers onto the existing platform
  // headers. `mergeHeaders` in `@polaris/shared-kafka` would also do this
  // but the producer's `republishToDlq` already merges retry headers; we
  // pass our extra headers in alongside the original headers so the
  // combined header bag survives.
  const extraHeaders: MessageHeaders = {
    [POLARIS_HEADER_DESTINATION_ID]: input.instance.destination_id,
    [POLARIS_HEADER_DESTINATION_VENDOR]: input.identity.vendor,
    [POLARIS_HEADER_DESTINATION_INSTANCE_LABEL]: input.instance.instance_label,
    [POLARIS_HEADER_CONSUMER_VERSION]: input.identity.consumerVersion,
    [POLARIS_HEADER_NORMALIZE_VERSION]: input.identity.normalizeVersion,
    [POLARIS_HEADER_MAPPER_VERSION]: input.identity.mapperVersion,
    [POLARIS_HEADER_DELIVERER_VERSION]: input.identity.delivererVersion,
  };
  if (input.delivery_key !== undefined) {
    extraHeaders[POLARIS_HEADER_DELIVERY_KEY] = input.delivery_key;
  }

  const originalHeaders = (input.payload.message.headers ?? {}) as MessageHeaders;
  const headers: MessageHeaders = { ...originalHeaders, ...extraHeaders };

  return republishToDlq(input.producer, {
    component,
    value: input.payload.message.value,
    ...(input.payload.message.key !== null && input.payload.message.key !== undefined
      ? { key: input.payload.message.key }
      : {}),
    headers,
    sourceTopic: input.payload.topic,
    sourcePartition: input.payload.partition,
    sourceOffset: input.payload.message.offset,
    reason: input.reason,
    ...(errorClass !== undefined ? { errorClass } : {}),
    ...(errorMessage !== undefined ? { errorMessage } : {}),
    failedAt,
    ...(input.attempts !== undefined ? { attempts: input.attempts } : {}),
  });
}
