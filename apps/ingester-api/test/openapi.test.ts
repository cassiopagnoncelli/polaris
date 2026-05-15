import { describe, expect, it } from "vitest";
import { buildIngesterApp } from "../src/app.js";
import { InMemoryDedupeStore } from "../src/dedupe/index.js";
import {
  buildComponentSchemas,
  buildOpenApiDocument,
  buildPaths,
  OPERATIONS_COMPONENT_SCHEMAS,
  PUBLISHED_OPENAPI_INFO,
  PUBLISHED_OPENAPI_SERVERS,
} from "../src/openapi/index.js";
import {
  buildTestCatalog,
  InMemoryApiKeyRepository,
  RecordingProducer,
  testConfig,
} from "./fixtures.js";

/**
 * OpenAPI document tests.
 *
 * The document is generated from the canonical Zod sources plus the
 * route module's path declarations. We assert on the structural
 * properties the operator/client tooling cares about:
 *
 *   - top-level OpenAPI 3.0 fields (openapi, info, paths, components)
 *   - the `POST /v1/events` operation includes the documented Problem
 *     responses and the partial-acceptance example
 *   - the canonical envelope schema round-trips through the Zod->JSON
 *     Schema converter without losing required fields
 *
 * The CI drift test in `scripts/__tests__/openapi-generate.test.ts`
 * covers the published YAML/JSON snapshot itself.
 */

function repoWithKey(): InMemoryApiKeyRepository {
  const repo = new InMemoryApiKeyRepository();
  repo.set({
    apiKeyId: "test-key-id",
    projectId: "checkout",
    environment: "production",
    sourceId: "storefront-web",
    sourceType: "web",
    hash: "argon2id-hash-irrelevant-test-stub",
    hashAlgorithm: "argon2id",
    status: "active",
  });
  return repo;
}

async function buildTestApp() {
  return buildIngesterApp({
    config: testConfig,
    installShutdown: false,
    apiKeyRepository: repoWithKey(),
    catalog: buildTestCatalog(),
    producer: new RecordingProducer() as unknown as Parameters<
      typeof buildIngesterApp
    >[0]["producer"],
    dedupe: new InMemoryDedupeStore(),
  });
}

type ResponsesMap = Record<string, { description?: string; content?: Record<string, unknown> }>;

function getPostOperation(doc: ReturnType<typeof buildOpenApiDocument>): {
  readonly responses: ResponsesMap;
  readonly requestBody: Record<string, unknown>;
  readonly security: ReadonlyArray<Record<string, unknown>>;
  readonly summary: string;
  readonly operationId: string;
} {
  const paths = doc["paths"] as Record<string, Record<string, unknown>>;
  const events = paths["/v1/events"];
  expect(events).toBeDefined();
  const post = events?.["post"] as
    | {
        responses: ResponsesMap;
        requestBody: Record<string, unknown>;
        security: ReadonlyArray<Record<string, unknown>>;
        summary: string;
        operationId: string;
      }
    | undefined;
  expect(post).toBeDefined();
  // biome-ignore lint/style/noNonNullAssertion: defended by the expect above
  return post!;
}

describe("buildOpenApiDocument", () => {
  const doc = buildOpenApiDocument({
    info: PUBLISHED_OPENAPI_INFO,
    servers: PUBLISHED_OPENAPI_SERVERS,
  });

  it("emits an OpenAPI 3.0 document with required top-level fields", () => {
    expect(doc["openapi"]).toBe("3.0.3");
    expect(doc["info"]).toEqual(
      expect.objectContaining({
        title: PUBLISHED_OPENAPI_INFO.title,
        version: PUBLISHED_OPENAPI_INFO.version,
      }),
    );
    expect(Array.isArray(doc["tags"])).toBe(true);
    expect(doc["paths"]).toBeDefined();
    expect(doc["components"]).toBeDefined();
  });

  it("registers the four ingester paths", () => {
    const paths = doc["paths"] as Record<string, unknown>;
    expect(Object.keys(paths).sort()).toEqual(
      ["/health", "/metrics", "/ready", "/v1/events"].sort(),
    );
  });

  it("declares an apiKey security scheme on the components", () => {
    const components = doc["components"] as Record<string, Record<string, unknown>>;
    const security = components["securitySchemes"] as Record<string, Record<string, unknown>>;
    expect(security["apiKey"]).toEqual(expect.objectContaining({ type: "apiKey", in: "header" }));
    const apiKey = security["apiKey"];
    expect(typeof apiKey?.["name"]).toBe("string");
  });

  it("includes the Zod-derived envelope and batch schemas as components", () => {
    const components = doc["components"] as Record<string, Record<string, unknown>>;
    const schemas = components["schemas"] as Record<string, Record<string, unknown>>;
    for (const name of [
      "Envelope",
      "ProducerEnvelope",
      "BatchRequest",
      "BatchResponse",
      "BatchAcceptedResult",
      "BatchRejectedResult",
      "BatchReasonCode",
      "SchemaReasonCode",
      "ProblemBody",
    ]) {
      expect(schemas[name], `expected component schema "${name}"`).toBeDefined();
    }
  });

  it("emits the Envelope schema with required platform fields", () => {
    const components = doc["components"] as Record<string, Record<string, unknown>>;
    const schemas = components["schemas"] as Record<string, Record<string, unknown>>;
    const envelope = schemas["Envelope"] as Record<string, unknown>;
    expect(envelope?.["type"]).toBe("object");
    const required = envelope?.["required"] as readonly string[];
    expect(required).toEqual(
      expect.arrayContaining([
        "event_id",
        "event",
        "schema_version",
        "project_id",
        "environment",
        "occurred_at",
        "ingested_at",
        "source",
        "identity",
        "context",
        "properties",
      ]),
    );
    // Strict envelope -> additionalProperties === false on the post-stamp shape.
    expect(envelope?.["additionalProperties"]).toBe(false);
  });

  describe("POST /v1/events", () => {
    const post = getPostOperation(doc);

    it("requires the apiKey security scheme", () => {
      expect(post.security).toEqual([{ apiKey: [] }]);
    });

    it("declares 200 with both full-accept and partial-accept examples", () => {
      const ok = post.responses["200"];
      expect(ok).toBeDefined();
      const content = ok?.content as Record<string, Record<string, unknown>>;
      const json = content?.["application/json"];
      expect(json?.["schema"]).toEqual({ $ref: "#/components/schemas/BatchResponse" });
      const examples = json?.["examples"] as Record<string, unknown>;
      expect(Object.keys(examples)).toEqual(
        expect.arrayContaining(["fullAccept", "partialAccept", "malformedBatch"]),
      );
    });

    it("documents every documented Problem response", () => {
      for (const status of ["400", "401", "413", "415", "500", "503"]) {
        const r = post.responses[status];
        expect(r, `expected Problem response ${status}`).toBeDefined();
        const content = r?.content as Record<string, Record<string, unknown>>;
        expect(content?.["application/problem+json"]).toBeDefined();
      }
    });

    it("provides at least one example per Problem response", () => {
      for (const status of ["400", "401", "413", "415", "500", "503"]) {
        const content = post.responses[status]?.content as Record<string, Record<string, unknown>>;
        const problem = content?.["application/problem+json"];
        const examples = problem?.["examples"] as Record<string, unknown>;
        expect(Object.keys(examples).length, `examples for ${status}`).toBeGreaterThan(0);
      }
    });
  });

  it("emits health / ready / metrics operations under the operations tag", () => {
    const paths = doc["paths"] as Record<string, Record<string, unknown>>;
    for (const path of ["/health", "/ready", "/metrics"]) {
      const get = paths[path]?.["get"] as Record<string, unknown>;
      expect(get?.["tags"]).toEqual(["operations"]);
    }
  });

  it("is deterministic for a given input", () => {
    const a = buildOpenApiDocument({
      info: PUBLISHED_OPENAPI_INFO,
      servers: PUBLISHED_OPENAPI_SERVERS,
    });
    const b = buildOpenApiDocument({
      info: PUBLISHED_OPENAPI_INFO,
      servers: PUBLISHED_OPENAPI_SERVERS,
    });
    // Identical when re-built from the same Zod sources; the CI drift
    // check depends on this property.
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("buildComponentSchemas and buildPaths", () => {
  it("returns disjoint component schema names from the operations supplement", () => {
    const zodNames = Object.keys(buildComponentSchemas());
    const opsNames = Object.keys(OPERATIONS_COMPONENT_SCHEMAS);
    const overlap = zodNames.filter((n) => opsNames.includes(n));
    expect(overlap).toEqual([]);
  });

  it("declares each ingester path once", () => {
    expect(Object.keys(buildPaths()).sort()).toEqual(
      ["/health", "/metrics", "/ready", "/v1/events"].sort(),
    );
  });
});

describe("GET /openapi.json (live route)", () => {
  it("serves the generated OpenAPI document with cache-control: no-store", async () => {
    const { app } = await buildTestApp();
    try {
      const res = await app.inject({ method: "GET", url: "/openapi.json" });
      expect(res.statusCode).toBe(200);
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(String(res.headers["content-type"])).toContain("application/json");
      const body = res.json() as Record<string, unknown>;
      expect(body["openapi"]).toBe("3.0.3");
      const info = body["info"] as { title: string };
      expect(info?.title).toBe("Polaris Ingester API");
      const paths = body["paths"] as Record<string, unknown>;
      expect(paths["/v1/events"]).toBeDefined();
    } finally {
      await app.close();
    }
  });

  it("does not register the route when openApiSetup is overridden", async () => {
    const { NOOP_OPENAPI_SETUP } = await import("@polaris/shared-service-bootstrap");
    const { app } = await buildIngesterApp({
      config: testConfig,
      installShutdown: false,
      apiKeyRepository: repoWithKey(),
      catalog: buildTestCatalog(),
      producer: new RecordingProducer() as unknown as Parameters<
        typeof buildIngesterApp
      >[0]["producer"],
      dedupe: new InMemoryDedupeStore(),
      openApiSetup: NOOP_OPENAPI_SETUP,
    });
    try {
      const res = await app.inject({ method: "GET", url: "/openapi.json" });
      // The error handler returns Problem Details with status 404 for an
      // unknown route — the route is absent rather than serving an empty
      // body.
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
