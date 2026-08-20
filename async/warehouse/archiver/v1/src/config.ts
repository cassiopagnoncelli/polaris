/**
 * archiver v1 configuration.
 *
 * The bucket coordinates are configuration; the layout inside it is not
 * (see `@polaris/archive-writer`'s `layout.ts`). An operator picks where
 * the archive lives and how large its objects get. Nobody picks what an
 * object is CALLED, because the replay source derives keys from the same
 * module the writer does, and a per-deployment layout would mean an
 * archive only its own deployment could read.
 *
 * ## Endpoint is a knob because MinIO is the local story
 *
 * `POLARIS_ARCHIVE_S3_ENDPOINT` + `POLARIS_ARCHIVE_S3_FORCE_PATH_STYLE`
 * point the client at MinIO in docker-compose. Unset, the SDK resolves
 * real S3 from the region. Credentials come from the SDK's own chain in
 * production — instance role, web identity, whatever the deployment uses —
 * and only the local compose file sets static keys.
 */

import {
  booleanFromStringSchema,
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
} from "@polaris/runtime-config";
import { z } from "zod";

export const PROCESSOR_SERVICE_NAME = "archiver" as const;

/**
 * Batch bounds and bucket coordinates.
 *
 *   POLARIS_ARCHIVE_BUCKET                  (required)
 *   POLARIS_ARCHIVE_PREFIX                  ("polaris")
 *   POLARIS_ARCHIVE_S3_REGION               ("us-east-1")
 *   POLARIS_ARCHIVE_S3_ENDPOINT             (unset -> real S3)
 *   POLARIS_ARCHIVE_S3_FORCE_PATH_STYLE     ("false"; MinIO needs true)
 *   POLARIS_ARCHIVE_MAX_BYTES               (8 MiB)
 *   POLARIS_ARCHIVE_MAX_RECORDS             (10000)
 *   POLARIS_ARCHIVE_MAX_AGE_MS              (60000)
 *   POLARIS_ARCHIVE_FLUSH_INTERVAL_MS       (5000)
 *   POLARIS_ARCHIVE_CONSUMER_GROUP          ("polaris-archiver-v1")
 *
 * The three batch bounds are genuine operational tuning — object size
 * against request count against how long a low-traffic project's
 * checkpoint may lag. None of them changes what an object CONTAINS, which
 * is the test for whether something belongs in an env var at all.
 *
 * `MAX_AGE_MS` has a floor of one second and `FLUSH_INTERVAL_MS` a floor
 * of 250ms: a flush loop that ran faster than that would spend a
 * deployment's request budget on empty passes.
 */
const archiverEnvSchema = z
  .object({
    POLARIS_ARCHIVE_BUCKET: nonEmptyStringSchema,
    POLARIS_ARCHIVE_PREFIX: nonEmptyStringSchema.default("polaris"),
    POLARIS_ARCHIVE_S3_REGION: nonEmptyStringSchema.default("us-east-1"),
    POLARIS_ARCHIVE_S3_ENDPOINT: nonEmptyStringSchema.optional(),
    POLARIS_ARCHIVE_S3_FORCE_PATH_STYLE: booleanFromStringSchema.default(false),
    POLARIS_ARCHIVE_MAX_BYTES: positiveIntSchema.default(8 * 1024 * 1024),
    POLARIS_ARCHIVE_MAX_RECORDS: positiveIntSchema.default(10_000),
    POLARIS_ARCHIVE_MAX_AGE_MS: durationMsSchema.pipe(z.number().min(1_000)).default(60_000),
    POLARIS_ARCHIVE_FLUSH_INTERVAL_MS: durationMsSchema.pipe(z.number().min(250)).default(5_000),
    POLARIS_ARCHIVE_CONSUMER_GROUP: nonEmptyStringSchema.default("polaris-archiver-v1"),
  })
  .transform(
    (parsed): ArchiverConfig => ({
      bucket: parsed["POLARIS_ARCHIVE_BUCKET"],
      prefix: parsed["POLARIS_ARCHIVE_PREFIX"],
      region: parsed["POLARIS_ARCHIVE_S3_REGION"],
      ...(parsed["POLARIS_ARCHIVE_S3_ENDPOINT"] !== undefined
        ? { endpoint: parsed["POLARIS_ARCHIVE_S3_ENDPOINT"] }
        : {}),
      forcePathStyle: parsed["POLARIS_ARCHIVE_S3_FORCE_PATH_STYLE"],
      maxBytes: parsed["POLARIS_ARCHIVE_MAX_BYTES"],
      maxRecords: parsed["POLARIS_ARCHIVE_MAX_RECORDS"],
      maxAgeMs: parsed["POLARIS_ARCHIVE_MAX_AGE_MS"],
      flushIntervalMs: parsed["POLARIS_ARCHIVE_FLUSH_INTERVAL_MS"],
      consumerGroup: parsed["POLARIS_ARCHIVE_CONSUMER_GROUP"],
    }),
  );

export interface ArchiverConfig {
  readonly bucket: string;
  readonly prefix: string;
  readonly region: string;
  readonly endpoint?: string;
  readonly forcePathStyle: boolean;
  readonly maxBytes: number;
  readonly maxRecords: number;
  readonly maxAgeMs: number;
  readonly flushIntervalMs: number;
  readonly consumerGroup: string;
}

export interface ArchiverRuntimeConfig {
  readonly service: ServiceConfig;
  readonly http: HttpConfig;
  readonly rabbitmq: RabbitmqConfig;
  /** Checkpoints. The clamp wraps this store, it does not replace it. */
  readonly postgres: PostgresConfig;
  readonly archiver: ArchiverConfig;
}

export function archiverConfigSchema() {
  return composeConfigSchema({
    service: serviceEnvSchema,
    http: httpEnvSchema,
    rabbitmq: rabbitmqEnvSchema,
    postgres: postgresEnvSchema,
    archiver: archiverEnvSchema,
  });
}

export function loadArchiverConfig(): ArchiverRuntimeConfig {
  return loadConfigWithDefaults({
    serviceName: PROCESSOR_SERVICE_NAME,
    schema: archiverConfigSchema(),
  });
}
