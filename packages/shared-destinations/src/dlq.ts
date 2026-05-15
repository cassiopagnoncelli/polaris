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

import { type MessageHeaders, type PolarisProducer, republishToDlq } from "@polaris/shared-kafka";
import type { EachMessagePayload, RecordMetadata } from "kafkajs";

import {
  type DeliveryRecordErrorClass,
  isDeliveryRecordErrorClass,
} from "./db/delivery-records.js";
import type { DestinationInstance } from "./db/destination-instance.js";
import type { DlqRecord, DlqRecordRepository } from "./db/dlq-records.js";
import type { ConsumerIdentity, NormalizableEnvelope } from "./types.js";

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
  /**
   * Optional decoded canonical envelope. When supplied, the helper
   * persists a `dlq_records` row alongside the Kafka publish (requires
   * `dlqRecords`). When omitted, the helper falls back to extracting
   * event metadata from the Kafka headers — this matches the runtime's
   * early-stage failure paths (decode error, missing destination-id)
   * where no envelope was successfully decoded.
   */
  readonly envelope?: NormalizableEnvelope;
  /**
   * Optional DLQ records repository. When supplied, the helper persists
   * a row to `dlq_records` after the Kafka publish succeeds. The CLI
   * (`polaris dlq list/show/retry/mark-resolved`) reads from this
   * table.
   */
  readonly dlqRecords?: DlqRecordRepository;
  /** Optional vendor response code, persisted on the `dlq_records` row. */
  readonly vendor_response_code?: string;
  /** Optional vendor response summary, persisted on the `dlq_records` row. */
  readonly vendor_response_summary?: string;
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

  const result = await republishToDlq(input.producer, {
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

  // Persist the DLQ row when the caller supplied both an envelope and a
  // repository. Both are optional: the early-stage paths (decode error,
  // missing destination-id header) don't have an envelope, and tests
  // sometimes only assert the Kafka publish. The runtime always passes
  // both in production.
  if (input.dlqRecords !== undefined && input.envelope !== undefined) {
    const errorClassForRow = pickErrorClassFromReason(input.reason);
    await input.dlqRecords.recordDlq({
      destination_id: input.instance.destination_id,
      event_id: input.envelope.event_id,
      event_name: input.envelope.event,
      project_id: input.envelope.project_id,
      environment: input.envelope.environment,
      vendor: input.identity.vendor,
      consumer_version: input.identity.consumerVersion,
      normalize_version: input.identity.normalizeVersion,
      mapper_version: input.identity.mapperVersion,
      deliverer_version: input.identity.delivererVersion,
      attempts: input.attempts ?? 0,
      reason: input.reason,
      error_class: errorClassForRow,
      ...(input.vendor_response_code !== undefined
        ? { vendor_response_code: input.vendor_response_code }
        : {}),
      ...(input.vendor_response_summary !== undefined
        ? { vendor_response_summary: input.vendor_response_summary }
        : {}),
      ...(input.delivery_key !== undefined ? { delivery_key: input.delivery_key } : {}),
      source_topic: input.payload.topic,
      source_partition: input.payload.partition,
      source_offset: input.payload.message.offset,
      headers: headersToStringMap(headers),
      payload:
        input.payload.message.value === null ? null : Buffer.from(input.payload.message.value),
      published_at: new Date(failedAt),
    });
  }

  return result;
}

/**
 * Map the free-form `reason` (e.g. `decode_failed`, `auth`, `permanent`)
 * to a closed-set `error_class` value for the `dlq_records.error_class`
 * column. Returns `null` when the reason doesn't map to a recognised
 * class — the column accepts NULL for early-stage failures (decode,
 * missing-id) that pre-date instance resolution.
 */
function pickErrorClassFromReason(reason: string): DeliveryRecordErrorClass | null {
  if (isDeliveryRecordErrorClass(reason)) return reason;
  return null;
}

/**
 * Coerce KafkaJS-shaped headers (Buffer | string | array | undefined) into
 * a string-only map that JSON-serializes cleanly into the
 * `dlq_records.headers` JSONB column. Buffers are decoded as UTF-8.
 */
function headersToStringMap(headers: MessageHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = headerValueToString(v);
  }
  return out;
}

function headerValueToString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Buffer) return value.toString("utf8");
  if (Array.isArray(value)) {
    const first = value[0];
    if (first === undefined) return "";
    return headerValueToString(first);
  }
  if (value === null || value === undefined) return "";
  return String(value);
}

/** Re-export of `DlqRecord` for callers that want the runtime return shape. */
export type { DlqRecord };
