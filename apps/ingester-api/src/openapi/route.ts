/**
 * Fastify glue for the ingester's OpenAPI document.
 *
 * Exposes two things:
 *
 *   - `GET /openapi.json` — the live OpenAPI document the ingester serves
 *     at runtime. Operators can curl this in any environment to confirm
 *     the running ingester matches the published doc.
 *   - `openApiSetup` — an implementation of the `OpenApiSetup` hook
 *     accepted by `bootstrapService`. Registering it wires the route into
 *     any Polaris service that calls `bootstrapService({ openapi })`.
 *
 * The route is intentionally trivial: it returns the pre-built document
 * with `Cache-Control: no-store` because the document is small and we
 * want operators to see schema updates the moment a new build deploys.
 */

import type { FastifyInstance } from "fastify";

import type { OpenApiSetup } from "@polaris/shared-service-bootstrap";

import {
  buildOpenApiDocument,
  PUBLISHED_OPENAPI_SERVERS,
  type OpenApiDocument,
} from "./document.js";

/**
 * Default route path for the served OpenAPI document. Mirrors common
 * convention (`/openapi.json`). Operators that want a different mount
 * point can override via `openApiSetupWith({ path })`.
 */
export const DEFAULT_OPENAPI_ROUTE = "/openapi.json" as const;

export interface OpenApiSetupOptions {
  /** Path the document is served from. Defaults to `/openapi.json`. */
  readonly path?: string;
  /**
   * Override the document's `servers` block. The committed doc lists the
   * canonical internal + local URLs; production deployments may override
   * to point at the public hostname.
   */
  readonly servers?: ReadonlyArray<{ readonly url: string; readonly description?: string }>;
}

/**
 * Build an `OpenApiSetup` hook that registers `/openapi.json` on the
 * service's Fastify instance.
 *
 * The `bootstrapService` integration passes `metadata` (title, version,
 * description) when invoking the hook. We reuse those values for the
 * served document so the `/openapi.json` payload matches the service's
 * own `info.version`. This is what makes the ingester's runtime doc
 * reflect the running binary even when a hotfix changes the published
 * YAML.
 */
export function openApiSetupWith(options: OpenApiSetupOptions = {}): OpenApiSetup {
  const path = options.path ?? DEFAULT_OPENAPI_ROUTE;
  const servers = options.servers ?? PUBLISHED_OPENAPI_SERVERS;
  return async (app, metadata) => {
    const doc: OpenApiDocument = buildOpenApiDocument({
      info: {
        title: metadata.title,
        version: metadata.version,
        ...(metadata.description !== undefined ? { description: metadata.description } : {}),
      },
      servers,
    });
    registerOpenApiRoute(app, path, doc);
  };
}

/**
 * Default setup function: serves `/openapi.json` with the committed server
 * list. Most services should import this rather than `openApiSetupWith`.
 */
export const openApiSetup: OpenApiSetup = openApiSetupWith();

/**
 * Register a GET handler that returns the pre-built OpenAPI document.
 *
 * Exposed separately so tests can install a fixed document on a Fastify
 * instance without re-running the generator.
 */
export function registerOpenApiRoute(
  app: FastifyInstance,
  path: string,
  document: OpenApiDocument,
): void {
  app.get(path, async (_request, reply) => {
    reply.header("cache-control", "no-store");
    reply.header("content-type", "application/json; charset=utf-8");
    return document;
  });
}
