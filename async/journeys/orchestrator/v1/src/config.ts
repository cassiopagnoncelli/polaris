/**
 * Runtime configuration for journey-orchestrator v1.
 *
 * The shared blocks (service, http, rabbitmq, postgres) plus one knob. The
 * orchestrator needs PostgreSQL for participants and traits, and RabbitMQ
 * for both directions — it consumes `resolved.events` + `profile.events`
 * and publishes `journey.*` back onto the profile plane.
 *
 * It needs no ClickHouse and no vendor credentials, and that absence is
 * the design: an orchestrator that could reach a vendor would be a second
 * delivery path beside the destination consumers.
 *
 *   POLARIS_JOURNEY_ORCHESTRATOR_CONSUMER_GROUP  ("polaris-journey-orchestrator-v1")
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

export const PROCESSOR_SERVICE_NAME = "journey-orchestrator" as const;
/** Owns `journey-orchestrator.retry.*` / `.redeliver` / `.dlq`. */
export const PROCESSOR_COMPONENT = "journey-orchestrator" as const;

export const journeyOrchestratorEnvSchema = z
  .object({
    POLARIS_JOURNEY_ORCHESTRATOR_CONSUMER_GROUP: nonEmptyStringSchema.default(
      "polaris-journey-orchestrator-v1",
    ),
  })
  .transform((env) => ({
    consumerGroup: env.POLARIS_JOURNEY_ORCHESTRATOR_CONSUMER_GROUP,
  }));

export const journeyOrchestratorEnvKeys = ["POLARIS_JOURNEY_ORCHESTRATOR_CONSUMER_GROUP"] as const;

export function journeyOrchestratorConfigSchema() {
  return composeConfigSchema({
    service: serviceEnvSchema,
    http: httpEnvSchema,
    rabbitmq: rabbitmqEnvSchema,
    postgres: postgresEnvSchema,
    orchestrator: journeyOrchestratorEnvSchema,
  });
}

export interface JourneyOrchestratorRuntimeConfig {
  readonly service: ServiceConfig;
  readonly http: HttpConfig;
  readonly rabbitmq: RabbitmqConfig;
  readonly postgres: PostgresConfig;
  readonly orchestrator: { readonly consumerGroup: string };
}

export function loadJourneyOrchestratorConfig(): JourneyOrchestratorRuntimeConfig {
  return loadConfigWithDefaults({
    serviceName: PROCESSOR_SERVICE_NAME,
    schema: journeyOrchestratorConfigSchema(),
  });
}
