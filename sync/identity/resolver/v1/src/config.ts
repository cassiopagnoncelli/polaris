/**
 * Runtime configuration for the identity stage.
 *
 * Follows the established processor pattern: a small Zod schema composing
 * shared-config blocks with a per-service block.
 *
 * What is NOT here is as deliberate as what is. The merge safeguards
 * (identifier denylist, per-kind cap, merge-rate breaker, trait size
 * guard) change EMITTED EVENTS, which makes them semantic parameters:
 * they live in `processor.manifest.yaml` with per-project overrides in
 * `catalog/projects/<id>.yaml`, never in env or `project_config`. An
 * operator must not be able to change identity semantics from a web form
 * — see docs/architecture/05-processors-and-replay.md
 * § "Per-Project Semantic Parameters".
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
export const STAGE_SERVICE_NAME = "sync-identity" as const;

/**
 * Stage-specific tuning knobs — operational only. Env vars:
 *
 *   POLARIS_SYNC_IDENTITY_CONSUMER_GROUP   ("polaris-sync-identity-v1")
 */
export const syncIdentityEnvSchema = z
  .object({
    POLARIS_SYNC_IDENTITY_CONSUMER_GROUP: nonEmptyStringSchema.default("polaris-sync-identity-v1"),
  })
  .transform(
    (parsed): SyncIdentityConfig => ({
      consumerGroup: parsed["POLARIS_SYNC_IDENTITY_CONSUMER_GROUP"],
    }),
  );

export interface SyncIdentityConfig {
  readonly consumerGroup: string;
}

export const syncIdentityEnvKeys = ["POLARIS_SYNC_IDENTITY_CONSUMER_GROUP"] as const;

/** Full runtime config: service / http / rabbitmq / postgres / stage. */
export interface SyncIdentityRuntimeConfig {
  readonly service: ServiceConfig;
  readonly http: HttpConfig;
  readonly rabbitmq: RabbitmqConfig;
  readonly postgres: PostgresConfig;
  readonly stage: SyncIdentityConfig;
}

export function syncIdentityConfigSchema() {
  return composeConfigSchema({
    service: serviceEnvSchema,
    http: httpEnvSchema,
    rabbitmq: rabbitmqEnvSchema,
    postgres: postgresEnvSchema,
    stage: syncIdentityEnvSchema,
  });
}

export function loadSyncIdentityConfig(): SyncIdentityRuntimeConfig {
  return loadConfigWithDefaults({
    serviceName: STAGE_SERVICE_NAME,
    schema: syncIdentityConfigSchema(),
  });
}
