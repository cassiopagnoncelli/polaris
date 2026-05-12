/**
 * Build the Polaris ingester OpenAPI 3.0 document.
 *
 * The document is *derived* from:
 *   - Zod schemas in `@polaris/shared-schemas` (envelope, batch req/res,
 *     reason codes) via `z.toJSONSchema(..., { target: "openapi-3.0" })`
 *   - Fastify routes registered on the ingester (`POST /v1/events`,
 *     `/health`, `/ready`, `/metrics`)
 *   - Stable Problem codes from `@polaris/shared-service-bootstrap` and
 *     the ingester's own auth module
 *
 * Avoid hand-writing parallel shapes here — if the Zod schema changes, the
 * OpenAPI doc changes the next time `pnpm openapi` runs. The committed
 * `docs/api/openapi.yaml` is the gate that catches accidental drift.
 *
 * @see docs/architecture/09-engineering-standards.md "OpenAPI"
 */

import { API_KEY_HEADER } from "../auth/api-key.js";

import { buildPaths, OPERATIONS_COMPONENT_SCHEMAS } from "./paths.js";
import { buildComponentSchemas } from "./schemas.js";

/**
 * Inputs that vary per build of the document. The `info.version` is
 * normally the ingester's package version; tests pin a deterministic
 * version so snapshot tests stay stable.
 */
export interface BuildOpenApiDocumentOptions {
  readonly info: {
    readonly title: string;
    readonly version: string;
    readonly description?: string;
  };
  /**
   * Optional list of server entries shown under `servers`. The committed
   * doc lists the canonical production URL and a placeholder local URL;
   * tests omit this to keep the snapshot stable.
   */
  readonly servers?: ReadonlyArray<{ readonly url: string; readonly description?: string }>;
}

/**
 * Generic OpenAPI document object. We use `Record<string, unknown>` rather
 * than a precise OpenAPI 3.0 type so the small amount of dynamic assembly
 * we do (merging Zod-derived component schemas with hand-authored ones)
 * stays straightforward.
 */
export type OpenApiDocument = Record<string, unknown>;

/**
 * Build the OpenAPI 3.0 document for the ingester service.
 *
 * The function is deterministic for a given `options` value: same input
 * Zod schemas + same options yield byte-identical output. The CI drift
 * check relies on that determinism.
 */
export function buildOpenApiDocument(options: BuildOpenApiDocumentOptions): OpenApiDocument {
  const zodDerivedSchemas = buildComponentSchemas();
  const components = {
    securitySchemes: {
      apiKey: {
        type: "apiKey",
        in: "header",
        name: API_KEY_HEADER,
        description:
          "Polaris API key. The ingester resolves the `(project_id, environment, source_id, source_type)` tuple from the key and stamps the canonical envelope from it — producers never send these fields directly. Keys are issued by the polaris CLI; see [Control Plane](https://github.com/polaris/polaris/blob/main/docs/architecture/02-control-plane.md).",
      },
    },
    schemas: {
      ...zodDerivedSchemas,
      ...OPERATIONS_COMPONENT_SCHEMAS,
    },
  };

  const doc: OpenApiDocument = {
    openapi: "3.0.3",
    info: {
      title: options.info.title,
      version: options.info.version,
      ...(options.info.description !== undefined ? { description: options.info.description } : {}),
      contact: {
        name: "Polaris Platform",
        url: "https://github.com/polaris/polaris",
      },
      license: { name: "UNLICENSED" },
    },
    ...(options.servers !== undefined && options.servers.length > 0
      ? { servers: [...options.servers] }
      : {}),
    tags: [
      {
        name: "ingest",
        description: "Event ingestion endpoints. The only path that publishes to Redpanda.",
      },
      {
        name: "operations",
        description: "Operator endpoints (liveness, readiness, Prometheus metrics).",
      },
    ],
    paths: buildPaths(),
    components,
  };

  return doc;
}

/**
 * Document metadata baked into the committed `docs/api/openapi.yaml`. Kept
 * here so the runtime `/openapi.json` route, the generator script, and
 * the snapshot tests all agree on the same values.
 */
export const PUBLISHED_OPENAPI_INFO = {
  title: "Polaris Ingester API",
  version: "0.0.1",
  description:
    "Polaris event ingestion API. Authenticates API keys, validates events against the canonical envelope and event catalog, applies the forbidden-field policy, performs short-window dedupe, and publishes accepted events to Redpanda `raw.events`.\n\nThis document is *generated* from Zod sources in the Polaris monorepo. Do not edit by hand — run `pnpm openapi` after changing a Zod schema or a Fastify route.",
} as const;

/**
 * Server entries listed in the committed document. Kept short — operators
 * can override per-deployment when rendering with Redocly / Swagger UI.
 */
export const PUBLISHED_OPENAPI_SERVERS: ReadonlyArray<{
  readonly url: string;
  readonly description?: string;
}> = [
  {
    url: "https://ingest.polaris.internal",
    description: "Canonical internal ingest endpoint (replace with deployment URL)",
  },
  {
    url: "http://localhost:8080",
    description: "Local docker-compose stack",
  },
];
