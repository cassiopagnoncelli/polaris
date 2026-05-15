/**
 * Polaris consumer wrapper.
 *
 * Thin convenience layer around KafkaJS `Consumer`. The wrapper exposes:
 *
 *   - factory + lifecycle helpers (`connect`, `disconnect`, `subscribe`),
 *   - a single `runEach` helper that wires the standard
 *     `eachMessage` -> hook emit -> error-class extraction pattern,
 *   - the raw KafkaJS consumer via `.raw` so advanced services can call
 *     `run` with `eachBatch`, manual commits, partition assignment, etc.
 *
 * The wrapper does not own retry/DLQ orchestration. The DLQ helpers in
 * `./dlq` provide the republish surface; the consumer's owner decides when
 * to retry vs send to DLQ — that policy is processor/consumer-specific.
 */

import type { Logger } from "@polaris/shared-logger";
import type {
  Consumer,
  ConsumerConfig,
  ConsumerRunConfig,
  ConsumerSubscribeTopics,
  EachMessagePayload,
  Kafka,
} from "kafkajs";
import {
  POLARIS_HEADER_ENVIRONMENT,
  POLARIS_HEADER_EVENT_ID,
  POLARIS_HEADER_PROJECT_ID,
  POLARIS_HEADER_TOPIC_FAMILY,
  readHeaderString,
} from "./headers.js";
import { emitHook, type KafkaHookPayload, type KafkaHooks } from "./hooks.js";

function baseHookPayload(
  payload: EachMessagePayload,
  context: PolarisMessageContext,
  groupId: string,
): KafkaHookPayload {
  const out: Mutable<KafkaHookPayload> = {
    topic: payload.topic,
    partition: payload.partition,
    offset: payload.message.offset,
    group_id: groupId,
  };
  if (context.event_id !== undefined) out.event_id = context.event_id;
  if (context.project_id !== undefined) out.project_id = context.project_id;
  if (context.environment !== undefined) out.environment = context.environment;
  if (context.topic_family !== undefined) out.topic_family = context.topic_family;
  if (payload.message.value !== null) out.bytes = payload.message.value.length;
  return out;
}

type Mutable<T> = { -readonly [P in keyof T]: T[P] };

/**
 * Options accepted by `createPolarisConsumer`.
 */
export interface CreatePolarisConsumerOptions {
  /** Configured KafkaJS client from `createKafkaClient`. */
  readonly kafka: Kafka;
  /** KafkaJS consumer config. `groupId` is required by KafkaJS. */
  readonly consumerConfig: ConsumerConfig;
  /** Optional metrics/logging hooks. */
  readonly hooks?: KafkaHooks;
  /** Optional logger for wrapper-level info/warn lines. */
  readonly logger?: Logger;
  /** Consumer identity stamped on log lines (e.g. `meta-capi`). */
  readonly consumerName?: string;
  /** Consumer version (e.g. `v1`). */
  readonly consumerVersion?: string;
}

/**
 * Handler signature passed to `runEach`. The first argument is the original
 * KafkaJS `EachMessagePayload`; the second is the Polaris header context
 * extracted by the wrapper so the handler does not have to re-parse headers.
 */
export type PolarisEachMessageHandler = (
  payload: EachMessagePayload,
  context: PolarisMessageContext,
) => Promise<void>;

/**
 * Extracted Polaris header context. Fields are best-effort and may be
 * undefined when the wrapper is consuming non-Polaris topics or messages
 * produced without the standard header bag.
 */
export interface PolarisMessageContext {
  readonly event_id?: string;
  readonly project_id?: string;
  readonly environment?: string;
  readonly topic_family?: string;
}

/** Polaris consumer surface. */
export interface PolarisConsumer {
  /** Connect to the broker. Idempotent. */
  connect(): Promise<void>;
  /** Disconnect from the broker. Idempotent. */
  disconnect(): Promise<void>;
  /** Subscribe to topics. Thin pass-through to KafkaJS. */
  subscribe(subscription: ConsumerSubscribeTopics): Promise<void>;
  /**
   * Run the consumer with a per-message handler. The wrapper:
   *   - emits `consumer.message_received` before the handler runs,
   *   - emits `consumer.message_handled` on success with `duration_ms`,
   *   - emits `consumer.handler_failed` on throw (after extracting
   *     `error_class` / `error_message`), then re-throws so KafkaJS applies
   *     its own retry semantics.
   *
   * `runConfig` lets callers tune concurrency (`partitionsConsumedConcurrently`),
   * commit behavior, and other KafkaJS knobs.
   */
  runEach(
    handler: PolarisEachMessageHandler,
    runConfig?: Omit<ConsumerRunConfig, "eachMessage" | "eachBatch">,
  ): Promise<void>;
  /**
   * Raw KafkaJS `consumer.run`. Use when you need `eachBatch`, manual
   * commits, or other escape hatches.
   */
  run(runConfig: ConsumerRunConfig): Promise<void>;
  /** Escape hatch: the underlying KafkaJS consumer. */
  readonly raw: Consumer;
}

/**
 * Build a Polaris consumer.
 */
export function createPolarisConsumer(options: CreatePolarisConsumerOptions): PolarisConsumer {
  const { kafka, consumerConfig, hooks, logger, consumerName, consumerVersion } = options;
  const raw: Consumer = kafka.consumer(consumerConfig);
  let connected = false;

  async function connect(): Promise<void> {
    if (connected) return;
    await raw.connect();
    connected = true;
    emitHook(hooks, "consumer.connected", { group_id: consumerConfig.groupId });
    logger?.info(
      {
        consumer: consumerName,
        consumer_version: consumerVersion,
        group_id: consumerConfig.groupId,
      },
      "polaris consumer connected",
    );
  }

  async function disconnect(): Promise<void> {
    if (!connected) return;
    await raw.disconnect();
    connected = false;
    emitHook(hooks, "consumer.disconnected", { group_id: consumerConfig.groupId });
    logger?.info({ consumer: consumerName }, "polaris consumer disconnected");
  }

  async function subscribe(subscription: ConsumerSubscribeTopics): Promise<void> {
    await raw.subscribe(subscription);
  }

  async function run(runConfig: ConsumerRunConfig): Promise<void> {
    await raw.run(runConfig);
  }

  async function runEach(
    handler: PolarisEachMessageHandler,
    runConfig?: Omit<ConsumerRunConfig, "eachMessage" | "eachBatch">,
  ): Promise<void> {
    const inner: ConsumerRunConfig = {
      ...(runConfig ?? {}),
      eachMessage: async (payload: EachMessagePayload) => {
        const context = extractContext(payload);
        const start = Date.now();
        const base = baseHookPayload(payload, context, consumerConfig.groupId);
        emitHook(hooks, "consumer.message_received", base);
        try {
          await handler(payload, context);
          emitHook(hooks, "consumer.message_handled", {
            ...base,
            duration_ms: Date.now() - start,
          });
        } catch (err) {
          const error = err as Error;
          emitHook(hooks, "consumer.handler_failed", {
            ...base,
            duration_ms: Date.now() - start,
            error_class: error.name,
            error_message: error.message,
          });
          throw err;
        }
      },
    };
    await raw.run(inner);
  }

  return {
    connect,
    disconnect,
    subscribe,
    runEach,
    run,
    raw,
  };
}

function extractContext(payload: EachMessagePayload): PolarisMessageContext {
  const headers = payload.message.headers;
  const context: PolarisMessageContext = {};
  const eventId = readHeaderString(headers, POLARIS_HEADER_EVENT_ID);
  if (eventId !== undefined) (context as { event_id?: string }).event_id = eventId;
  const projectId = readHeaderString(headers, POLARIS_HEADER_PROJECT_ID);
  if (projectId !== undefined) (context as { project_id?: string }).project_id = projectId;
  const environment = readHeaderString(headers, POLARIS_HEADER_ENVIRONMENT);
  if (environment !== undefined) (context as { environment?: string }).environment = environment;
  const topicFamily = readHeaderString(headers, POLARIS_HEADER_TOPIC_FAMILY);
  if (topicFamily !== undefined) (context as { topic_family?: string }).topic_family = topicFamily;
  return context;
}
