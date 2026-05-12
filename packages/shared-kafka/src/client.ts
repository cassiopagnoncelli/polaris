/**
 * Kafka client construction.
 *
 * Thin factory that builds a KafkaJS `Kafka` instance from the typed
 * `RedpandaConfig` produced by `@polaris/shared-config`. The factory exists
 * so producer/consumer wrappers share the same client wiring (SASL, TLS,
 * timeouts, retry defaults) without each service re-deriving it from env
 * vars.
 *
 * Advanced services may still construct a `Kafka` instance directly — the
 * factory does not hide any KafkaJS option that would block escape-hatch
 * use.
 */

import { Kafka, type KafkaConfig, type RetryOptions, type SASLOptions, logLevel } from "kafkajs";
import type { RedpandaConfig } from "@polaris/shared-config";

/**
 * Default KafkaJS retry options applied to producers and consumers that do
 * not override them. The values mirror KafkaJS defaults but are declared
 * here so per-service tuning rides a stable baseline.
 *
 * KafkaJS retry semantics (initialRetryTime, retries, factor, maxRetryTime)
 * apply to broker connection and metadata calls; per-call retries (producer
 * `send`, consumer fetch) are governed separately by KafkaJS internals.
 */
export const DEFAULT_RETRY_OPTIONS: Readonly<RetryOptions> = Object.freeze({
  initialRetryTime: 300,
  retries: 8,
  factor: 0.2,
  multiplier: 2,
  maxRetryTime: 30_000,
});

/**
 * Options accepted by `createKafkaClient`. The intent is "give me a
 * KafkaJS client backed by Polaris config" — extra KafkaJS fields can be
 * passed through via `kafkaConfig` for escape-hatch wiring (custom
 * `socketFactory`, `logCreator`, etc.).
 */
export interface CreateKafkaClientOptions {
  /** Required: typed Redpanda config (brokers, clientId, SSL, SASL, timeouts). */
  readonly redpanda: RedpandaConfig;
  /**
   * Optional KafkaJS retry overrides. Merged on top of `DEFAULT_RETRY_OPTIONS`.
   */
  readonly retry?: Partial<RetryOptions>;
  /**
   * Optional raw KafkaJS config overrides. Useful for advanced settings that
   * the typed config does not expose (custom log creator, socket factory).
   * Fields here override anything derived from `redpanda` and `retry`.
   */
  readonly kafkaConfig?: Partial<KafkaConfig>;
}

/**
 * Build a KafkaJS `Kafka` client.
 *
 * - `brokers` and `clientId` come from `RedpandaConfig`.
 * - SSL is set to `true` when `ssl` is enabled; advanced TLS options go
 *   through `kafkaConfig.ssl`.
 * - SASL is wired when the config carries credentials.
 * - Connection / request timeouts come from `RedpandaConfig`.
 * - `logLevel` defaults to `ERROR` because KafkaJS chatter is noisy and
 *   Polaris services rely on structured logs through `@polaris/shared-logger`.
 *   Hosts may override via `kafkaConfig.logLevel`.
 */
export function createKafkaClient(options: CreateKafkaClientOptions): Kafka {
  const { redpanda, retry, kafkaConfig } = options;
  const sasl: SASLOptions | undefined =
    redpanda.sasl !== undefined
      ? ({
          mechanism: redpanda.sasl.mechanism,
          username: redpanda.sasl.username,
          password: redpanda.sasl.password,
        } as SASLOptions)
      : undefined;

  const baseConfig: KafkaConfig = {
    clientId: redpanda.clientId,
    brokers: [...redpanda.brokers],
    ssl: redpanda.ssl,
    connectionTimeout: redpanda.connectionTimeoutMs,
    requestTimeout: redpanda.requestTimeoutMs,
    logLevel: logLevel.ERROR,
    retry: { ...DEFAULT_RETRY_OPTIONS, ...(retry ?? {}) },
  };
  if (sasl !== undefined) {
    baseConfig.sasl = sasl;
  }
  return new Kafka({ ...baseConfig, ...(kafkaConfig ?? {}) });
}
