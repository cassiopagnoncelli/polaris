import type { FastifyInstance } from "fastify";

/**
 * Minimum OpenAPI document metadata exposed by every Polaris HTTP service.
 *
 * The bootstrap does not own the concrete OpenAPI generation pipeline —
 * that responsibility belongs to the ingester / control-plane / future
 * dashboard API where Zod route schemas live. This module provides the
 * integration hook so services can install whatever OpenAPI plugin they
 * choose (`@fastify/swagger` + `fastify-type-provider-zod`, ...) without
 * each service re-declaring the metadata layout.
 *
 * @see docs/architecture/09-engineering-standards.md "OpenAPI"
 */
export interface OpenApiMetadata {
  /** Document title (e.g. "Polaris Ingester API"). */
  readonly title: string;
  /** Document version (typically service version). */
  readonly version: string;
  /** Optional short description. */
  readonly description?: string;
}

/**
 * OpenAPI setup function shape. Services that want OpenAPI generation
 * pass a setup function to `bootstrapService`; the bootstrap invokes it
 * after wiring config / logger / routes so the plugin can introspect the
 * Fastify instance.
 *
 * The function is intentionally async because most OpenAPI plugins are
 * registered through `fastify.register(...)`, which returns a Promise.
 */
export type OpenApiSetup = (app: FastifyInstance, metadata: OpenApiMetadata) => Promise<void>;

/**
 * Default no-op setup used when a service has not configured OpenAPI yet.
 * Exposed so callers can spot the absence in tests without scanning
 * application code.
 */
export const NOOP_OPENAPI_SETUP: OpenApiSetup = async (_app, _metadata) => {
  // intentionally empty — OpenAPI is opt-in until the service has Zod
  // route schemas in place.
};
