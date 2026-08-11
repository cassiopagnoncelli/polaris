/**
 * Runtime configuration for the clickhouse-sink v1 service.
 *
 * Composed from the shared schema fragments (service + http + rabbitmq +
 * postgres + clickhouse) plus a small sink-specific block.
 *
 * Env vars owned by this service:
 *
 *   POLARIS_CLICKHOUSE_SINK_CONSUMER_GROUP  ("polaris-clickhouse-sink-v1")
 *   POLARIS_CLICKHOUSE_SINK_BATCH_MAX_ROWS  (1000)
 *   POLARIS_CLICKHOUSE_SINK_BATCH_MAX_MS    (2000)
 *   POLARIS_CLICKHOUSE_SINK_USER            ("polaris_sink")
 *   POLARIS_CLICKHOUSE_SINK_PASSWORD        (required)
 *
 * The sink authenticates as its own ClickHouse role rather than reusing
 * `POLARIS_CLICKHOUSE_SERVICE_*`: `polaris_sink` holds INSERT on the
 * ingestion interface table and nothing else, so a compromised sink
 * cannot read a single row of customer data.
 *
 * @see docs/architecture/07-clickhouse.md
 * @see sql/clickhouse/roles/01_grants.sql
 */

import {
  type ClickHouseConfig,
  clickhouseEnvSchema,
  composeConfigSchema,
  durationMsSchema,
  type HttpConfig,
  httpEnvSchema,
  loadConfigWithDefaults,
  nonEmptyStringSchema,
  type PostgresConfig,
  positiveIntSchema,
  postgresEnvSchema,
  type RabbitmqConfig,
  rabbitmqEnvSchema,
  type ServiceConfig,
  serviceEnvSchema,
} from "@polaris/shared-config";
import { z } from "zod";

/** Service name surfaced in logs, metrics, and the connection name. */
export const SINK_SERVICE_NAME = "clickhouse-sink" as const;

/** Component identifier — owns `clickhouse-sink.retry.*` / `.dlq`. */
export const SINK_COMPONENT = "clickhouse-sink" as const;

export const clickhouseSinkEnvSchema = z
  .object({
    POLARIS_CLICKHOUSE_SINK_CONSUMER_GROUP: nonEmptyStringSchema.default(
      "polaris-clickhouse-sink-v1",
    ),
    /**
     * Rows per INSERT. ClickHouse strongly prefers few large inserts over
     * many small ones — each INSERT creates a part, and too many parts is
     * the classic way to wedge a MergeTree table.
     */
    POLARIS_CLICKHOUSE_SINK_BATCH_MAX_ROWS: positiveIntSchema.default(1000),
    /**
     * Maximum time a partial batch waits before being flushed. Bounds
     * end-to-end ingestion latency when traffic is light.
     */
    POLARIS_CLICKHOUSE_SINK_BATCH_MAX_MS: durationMsSchema.default(2000),
    POLARIS_CLICKHOUSE_SINK_USER: nonEmptyStringSchema.default("polaris_sink"),
    POLARIS_CLICKHOUSE_SINK_PASSWORD: nonEmptyStringSchema,
  })
  .transform(
    (parsed): ClickhouseSinkConfig => ({
      consumerGroup: parsed["POLARIS_CLICKHOUSE_SINK_CONSUMER_GROUP"],
      batchMaxRows: parsed["POLARIS_CLICKHOUSE_SINK_BATCH_MAX_ROWS"],
      batchMaxMs: parsed["POLARIS_CLICKHOUSE_SINK_BATCH_MAX_MS"],
      user: parsed["POLARIS_CLICKHOUSE_SINK_USER"],
      password: parsed["POLARIS_CLICKHOUSE_SINK_PASSWORD"],
    }),
  );

export interface ClickhouseSinkConfig {
  /**
   * Polaris consumer-group identifier: the namespace this sink's stream
   * checkpoints live under in `transport_checkpoints`. Changing it
   * rewinds the sink, which re-inserts rows — safe (ReplacingMergeTree
   * collapses them) but expensive.
   */
  readonly consumerGroup: string;
  readonly batchMaxRows: number;
  readonly batchMaxMs: number;
  readonly user: string;
  readonly password: string;
}

export const clickhouseSinkEnvKeys = [
  "POLARIS_CLICKHOUSE_SINK_CONSUMER_GROUP",
  "POLARIS_CLICKHOUSE_SINK_BATCH_MAX_ROWS",
  "POLARIS_CLICKHOUSE_SINK_BATCH_MAX_MS",
  "POLARIS_CLICKHOUSE_SINK_USER",
  "POLARIS_CLICKHOUSE_SINK_PASSWORD",
] as const;

export interface ClickhouseSinkRuntimeConfig {
  readonly service: ServiceConfig;
  readonly http: HttpConfig;
  readonly rabbitmq: RabbitmqConfig;
  /** Checkpoints. The sink's resume point is Postgres-owned. */
  readonly postgres: PostgresConfig;
  readonly clickhouse: ClickHouseConfig;
  readonly sink: ClickhouseSinkConfig;
}

export function clickhouseSinkConfigSchema() {
  return composeConfigSchema({
    service: serviceEnvSchema,
    http: httpEnvSchema,
    rabbitmq: rabbitmqEnvSchema,
    postgres: postgresEnvSchema,
    clickhouse: clickhouseEnvSchema,
    sink: clickhouseSinkEnvSchema,
  });
}

export function loadClickhouseSinkConfig(
  processEnv: NodeJS.ProcessEnv = process.env,
): ClickhouseSinkRuntimeConfig {
  return loadConfigWithDefaults({
    serviceName: SINK_SERVICE_NAME,
    schema: clickhouseSinkConfigSchema(),
    processEnv,
  }) as ClickhouseSinkRuntimeConfig;
}
