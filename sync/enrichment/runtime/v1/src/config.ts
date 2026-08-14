/**
 * Runtime configuration for the enrichment stage.
 *
 * Everything here is OPERATIONAL — a consumer group, two filesystem
 * paths. The one semantic parameter this stage has (`max_traits_bytes`,
 * the ceiling on a stamped snapshot) is deliberately absent: it changes
 * emitted events, so it lives in `processor.manifest.yaml` with bounds
 * and is narrowed per project in `catalog/projects/<id>.yaml`, never in
 * env and never in `project_config`. See
 * `docs/architecture/05-processors-and-replay.md`
 * § "Per-Project Semantic Parameters".
 *
 * Both paths here are paths, which is the reason they may live in env at
 * all: they say WHERE to find an input, not what the input means.
 */

import {
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

/** Default service name surfaced when `POLARIS_SERVICE_NAME` is omitted. */
export const STAGE_SERVICE_NAME = "sync-enrichment" as const;

/**
 * Stage-specific knobs — operational only. Env vars:
 *
 *   POLARIS_SYNC_ENRICHMENT_CONSUMER_GROUP  ("polaris-sync-enrichment-v1")
 *   POLARIS_SYNC_ENRICHMENT_CATALOG_ROOT    (".")
 *   POLARIS_SYNC_ENRICHMENT_GEOIP_DB_PATH   (unset)
 *
 * `GEOIP_DB_PATH` unset means no geo database is wired, and the stage
 * runs fail-open with `geo.source: "no_lookup"`. That is a supported
 * production posture, not a misconfiguration: the MaxMind file is
 * license-restricted and lives outside the image, so a deployment that
 * has not provisioned it yet still runs.
 */
export const syncEnrichmentEnvSchema = z
  .object({
    POLARIS_SYNC_ENRICHMENT_CONSUMER_GROUP: nonEmptyStringSchema.default(
      "polaris-sync-enrichment-v1",
    ),
    POLARIS_SYNC_ENRICHMENT_CATALOG_ROOT: nonEmptyStringSchema.default("."),
    POLARIS_SYNC_ENRICHMENT_GEOIP_DB_PATH: nonEmptyStringSchema.optional(),
  })
  .transform(
    (parsed): SyncEnrichmentConfig => ({
      consumerGroup: parsed["POLARIS_SYNC_ENRICHMENT_CONSUMER_GROUP"],
      catalogRoot: parsed["POLARIS_SYNC_ENRICHMENT_CATALOG_ROOT"],
      ...(parsed["POLARIS_SYNC_ENRICHMENT_GEOIP_DB_PATH"] !== undefined
        ? { geoipDbPath: parsed["POLARIS_SYNC_ENRICHMENT_GEOIP_DB_PATH"] }
        : {}),
    }),
  );

export interface SyncEnrichmentConfig {
  readonly consumerGroup: string;
  /** Directory containing `catalog/projects/`, for per-project narrowing. */
  readonly catalogRoot: string;
  /** MaxMind mmdb path. Absent means fail-open with no geo backend. */
  readonly geoipDbPath?: string;
}

export const syncEnrichmentEnvKeys = [
  "POLARIS_SYNC_ENRICHMENT_CONSUMER_GROUP",
  "POLARIS_SYNC_ENRICHMENT_CATALOG_ROOT",
  "POLARIS_SYNC_ENRICHMENT_GEOIP_DB_PATH",
] as const;

/** Full runtime config: service / http / rabbitmq / postgres / stage. */
export interface SyncEnrichmentRuntimeConfig {
  readonly service: ServiceConfig;
  readonly http: HttpConfig;
  readonly rabbitmq: RabbitmqConfig;
  readonly postgres: PostgresConfig;
  readonly stage: SyncEnrichmentConfig;
}

export function syncEnrichmentConfigSchema() {
  return composeConfigSchema({
    service: serviceEnvSchema,
    http: httpEnvSchema,
    rabbitmq: rabbitmqEnvSchema,
    postgres: postgresEnvSchema,
    stage: syncEnrichmentEnvSchema,
  });
}

export function loadSyncEnrichmentConfig(): SyncEnrichmentRuntimeConfig {
  return loadConfigWithDefaults({
    serviceName: STAGE_SERVICE_NAME,
    schema: syncEnrichmentConfigSchema(),
  });
}
