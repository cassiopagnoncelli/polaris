/**
 * Polaris producer wrapper.
 *
 * Thin convenience layer around KafkaJS `Producer`. The wrapper:
 *
 *   - is constructed from a `Kafka` client + optional logging/metrics hooks,
 *   - exposes a single `publishEvent` helper that handles partition keys,
 *     headers, JSON serialization, and topic-family resolution,
 *   - re-exports the raw KafkaJS producer through `.raw` for advanced use,
 *   - leaves connection lifecycle (`connect`, `disconnect`) explicit so
 *     hosts can wire it into their startup/shutdown.
 *
 * The wrapper does **not** implement transactions, idempotency configuration,
 * batching policy, or schema validation. Hosts that need those compose with
 * `.raw` directly or layer their own helpers — keeping the wrapper thin is a
 * Polaris architectural rule.
 */

import type { Logger } from "@polaris/shared-logger";
import type { Kafka, Producer, ProducerConfig, ProducerRecord, RecordMetadata } from "kafkajs";
import {
  buildEventHeaders,
  type MessageHeaders,
  mergeHeaders,
  type PolarisHeaderInput,
} from "./headers.js";
import { emitHook, type KafkaHooks } from "./hooks.js";
import { buildRawEventsPartitionKey, type PartitionKeyIdentity } from "./partition-key.js";
import { encodeEvent } from "./serialization.js";
import { resolveTopicNameSync, type SyncIsolationLookup } from "./topic-family.js";
import type { CanonicalTopicFamily } from "./topics.js";

/**
 * Options accepted by `createPolarisProducer`. `kafka` is required; the rest
 * are optional and have safe defaults.
 */
export interface CreatePolarisProducerOptions {
  /** Configured KafkaJS client from `createKafkaClient`. */
  readonly kafka: Kafka;
  /** Optional KafkaJS producer-level config overrides. */
  readonly producerConfig?: ProducerConfig;
  /** Optional metrics/logging hooks. */
  readonly hooks?: KafkaHooks;
  /** Optional logger for wrapper-level info/warn lines. */
  readonly logger?: Logger;
  /** Producer identity stamped into headers. Required for traceability. */
  readonly producerName: string;
  /** Producer version stamped into headers (e.g. package version). */
  readonly producerVersion?: string;
}

/** Polaris producer surface. */
export interface PolarisProducer {
  /** Connect to the broker. Idempotent. */
  connect(): Promise<void>;
  /** Disconnect from the broker. Idempotent. */
  disconnect(): Promise<void>;
  /**
   * Publish a canonical event to a Polaris topic family.
   *
   * The wrapper:
   *   - resolves the family to a concrete topic via the sync
   *     `IsolationLookup` (the hot path expects a cached/memoized lookup),
   *   - computes the default partition key from the envelope,
   *   - serializes the envelope to JSON,
   *   - stamps Polaris headers,
   *   - calls `producer.send` with the resulting record.
   *
   * Hosts that need an async lookup should pre-resolve the topic via
   * `resolveTopicName` and call `.send` directly.
   *
   * Callers who need control over batching, custom partition keys, or
   * multi-message sends should use `.send` directly.
   */
  publishEvent(input: PublishEventInput): Promise<RecordMetadata[]>;
  /**
   * Raw KafkaJS `Producer.send`. Useful for batched or non-event payloads.
   * The wrapper still runs lifecycle hooks for `producer.message_sent` /
   * `producer.send_failed`.
   */
  send(record: ProducerRecord): Promise<RecordMetadata[]>;
  /** Escape hatch: the underlying KafkaJS producer. */
  readonly raw: Producer;
}

/**
 * Input accepted by `publishEvent`. The shape mirrors the canonical envelope
 * but only the fields needed for routing/keys/headers are required so this
 * helper stays usable from contexts that hold a partial event (e.g. a retry
 * republisher reading from headers alone).
 */
export interface PublishEventInput {
  /** Canonical topic family — one of `TOPIC_FAMILY_*` constants. */
  readonly family: CanonicalTopicFamily;
  /** Pre-stamped canonical envelope (or compatible payload). */
  readonly event: PublishableEvent;
  /**
   * Sync isolation lookup. Hot paths should pass a cache-backed handle.
   * Use `resolveTopicName` + `.send` for the rare async-lookup case.
   */
  readonly isolation: SyncIsolationLookup;
  /** Optional extra headers merged after Polaris defaults. */
  readonly extraHeaders?: MessageHeaders;
  /**
   * Override the partition key. Defaults to the canonical project/env/identity
   * key from `buildRawEventsPartitionKey`.
   */
  readonly partitionKey?: string;
}

/** Minimum event shape required to publish. */
export interface PublishableEvent {
  readonly event_id: string;
  readonly event: string;
  readonly schema_version: number;
  readonly project_id: string;
  readonly environment: string;
  readonly occurred_at: string;
  readonly ingested_at?: string;
  readonly source?: { readonly id?: string | undefined } | undefined;
  readonly identity: PartitionKeyIdentity;
  // The full envelope contains more fields; they pass through serialization
  // untouched. Producers should hand `publishEvent` the complete envelope.
  readonly [extra: string]: unknown;
}

/**
 * Build a Polaris producer.
 */
export function createPolarisProducer(options: CreatePolarisProducerOptions): PolarisProducer {
  const { kafka, producerConfig, hooks, logger, producerName, producerVersion } = options;
  const raw: Producer =
    producerConfig !== undefined ? kafka.producer(producerConfig) : kafka.producer();
  let connected = false;

  async function connect(): Promise<void> {
    if (connected) return;
    await raw.connect();
    connected = true;
    emitHook(hooks, "producer.connected", {});
    logger?.info({ producer: producerName }, "polaris producer connected");
  }

  async function disconnect(): Promise<void> {
    if (!connected) return;
    await raw.disconnect();
    connected = false;
    emitHook(hooks, "producer.disconnected", {});
    logger?.info({ producer: producerName }, "polaris producer disconnected");
  }

  async function send(record: ProducerRecord): Promise<RecordMetadata[]> {
    const start = Date.now();
    try {
      const result = await raw.send(record);
      emitHook(hooks, "producer.message_sent", {
        topic: record.topic,
        duration_ms: Date.now() - start,
      });
      return result;
    } catch (err) {
      const error = err as Error;
      emitHook(hooks, "producer.send_failed", {
        topic: record.topic,
        duration_ms: Date.now() - start,
        error_class: error.name,
        error_message: error.message,
      });
      throw err;
    }
  }

  async function publishEvent(input: PublishEventInput): Promise<RecordMetadata[]> {
    const topic = resolveTopicNameSync(input.family, input.event.project_id, input.isolation);
    const partitionKey =
      input.partitionKey ??
      buildRawEventsPartitionKey({
        project_id: input.event.project_id,
        environment: input.event.environment,
        event_id: input.event.event_id,
        identity: input.event.identity,
      });

    const headerInput: PolarisHeaderInput = {
      event_id: input.event.event_id,
      event_name: input.event.event,
      schema_version: input.event.schema_version,
      project_id: input.event.project_id,
      environment: input.event.environment,
      occurred_at: input.event.occurred_at,
      ingested_at: input.event.ingested_at,
      source_id: input.event.source?.id,
      producer: producerName,
      producer_version: producerVersion,
      topic_family: input.family,
    };
    const headers = mergeHeaders(buildEventHeaders(headerInput), input.extraHeaders);

    const record: ProducerRecord = {
      topic,
      messages: [
        {
          key: partitionKey,
          value: encodeEvent(input.event),
          headers,
        },
      ],
    };

    return send(record);
  }

  return {
    connect,
    disconnect,
    publishEvent,
    send,
    raw,
  };
}
