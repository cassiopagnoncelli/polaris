import {
  type ClickHouseConfig,
  clickhouseEnvSchema,
  composeConfigSchema,
  type HttpConfig,
  httpEnvSchema,
  loadConfigWithDefaults,
  nonEmptyStringSchema,
  type PostgresConfig,
  postgresEnvSchema,
  type RabbitmqConfig,
  rabbitmqEnvSchema,
  type ServiceConfig,
  serviceEnvSchema,
} from "@polaris/shared-config";
import { z } from "zod";

/**
 * Service name reported through `/health`. Deployments are expected to set
 * `POLARIS_SERVICE_NAME`; this is what they should set it to.
 */
export const PROCESSOR_SERVICE_NAME = "merge-worker" as const;

/**
 * Worker-specific knobs.
 *
 *   POLARIS_MERGE_WORKER_CONSUMER_GROUP  ("polaris-merge-worker-v1")
 *
 * Deliberately one knob. Everything this worker CONCLUDES — which events it
 * acts on, how chains collapse, what version a row carries — is semantic and
 * lives in the manifest and the code, per
 * `docs/architecture/05-processors-and-replay.md`. A tuning variable that
 * could change the map's contents would be a semantic change wearing an env
 * var's clothes, and would need a new processor version rather than a
 * restart.
 */
const mergeWorkerEnvSchema = z
  .object({
    POLARIS_MERGE_WORKER_CONSUMER_GROUP: nonEmptyStringSchema.default("polaris-merge-worker-v1"),
  })
  .transform(
    (parsed): MergeWorkerConfig => ({
      consumerGroup: parsed["POLARIS_MERGE_WORKER_CONSUMER_GROUP"],
    }),
  );

export interface MergeWorkerConfig {
  readonly consumerGroup: string;
}

export interface MergeWorkerRuntimeConfig {
  readonly service: ServiceConfig;
  readonly http: HttpConfig;
  readonly rabbitmq: RabbitmqConfig;
  readonly postgres: PostgresConfig;
  /**
   * The map lives in ClickHouse, so this is not optional the way it is for a
   * processor that only reads and emits events: without it the worker has
   * nowhere to write and every merge would be silently unrecorded.
   */
  readonly clickhouse: ClickHouseConfig;
  readonly mergeWorker: MergeWorkerConfig;
}

export function mergeWorkerConfigSchema() {
  return composeConfigSchema({
    service: serviceEnvSchema,
    http: httpEnvSchema,
    rabbitmq: rabbitmqEnvSchema,
    // Checkpoints. RabbitMQ streams consumed over AMQP have no server-side
    // offset store, so the consumer's position lives in PostgreSQL like
    // every other Polaris consumer's.
    postgres: postgresEnvSchema,
    clickhouse: clickhouseEnvSchema,
    mergeWorker: mergeWorkerEnvSchema,
  });
}

export function loadMergeWorkerConfig(): MergeWorkerRuntimeConfig {
  return loadConfigWithDefaults({
    serviceName: PROCESSOR_SERVICE_NAME,
    schema: mergeWorkerConfigSchema(),
  });
}
