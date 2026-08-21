/**
 * Integration test for the `/metrics` route wired to the live IngestMetrics
 * registry (P10-002).
 *
 * Asserts that:
 *
 *   - `/metrics` returns 200 with `text/plain; version=0.0.4`
 *   - The body contains Prometheus text for the `polaris_ingest_*`
 *     counters that have been incremented
 *   - The body uses the Polaris naming convention (counter `_total`
 *     suffix → TYPE counter)
 *   - Empty registry → empty body (or just HELP/TYPE comments)
 *
 * Bypasses argon2 via the `verifyHash` plumb so the test doesn't pay the
 * hash cost.
 *
 * @see docs/implementation/tasks/P10-002-metrics-standardization.md
 */

import { describe, expect, it } from "vitest";

import { buildIngesterApp } from "../src/app.js";
import { InMemoryDedupeStore } from "../src/dedupe/index.js";
import { IngestMetrics } from "../src/metrics/registry.js";
import {
  buildEnvelopePayload,
  buildTestCatalog,
  InMemoryApiKeyRepository,
  RecordingProducer,
  testConfig,
} from "./fixtures.js";

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

async function buildAppWithMetrics(metrics: IngestMetrics) {
  return buildIngesterApp({
    config: testConfig,
    installShutdown: false,
    apiKeyRepository: repoWithKey(),
    catalog: buildTestCatalog(),
    producer: new RecordingProducer() as unknown as Parameters<
      typeof buildIngesterApp
    >[0]["producer"],
    dedupe: new InMemoryDedupeStore(),
    metrics,
    verifyHash: async () => true,
  });
}

describe("ingester /metrics endpoint (P10-002)", () => {
  it("serves the Prometheus content type", async () => {
    const metrics = new IngestMetrics();
    const { app } = await buildAppWithMetrics(metrics);
    try {
      const res = await app.inject({ method: "GET", url: "/metrics" });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toMatch(/text\/plain.*version=0\.0\.4/);
    } finally {
      await app.close();
    }
  });

  it("returns Prometheus text for incremented counters", async () => {
    const metrics = new IngestMetrics();
    metrics.incrementAccepted({ project_id: "checkout", environment: "production" });
    metrics.incrementAccepted({ project_id: "checkout", environment: "production" });
    metrics.incrementRejected({
      project_id: "checkout",
      environment: "production",
      reason: "forbidden_field_rejected",
    });
    const { app } = await buildAppWithMetrics(metrics);
    try {
      const res = await app.inject({ method: "GET", url: "/metrics" });
      expect(res.statusCode).toBe(200);
      const body = res.body;
      // HELP + TYPE blocks emitted once per metric name.
      expect(body).toContain("# HELP polaris_ingest_batch_accepted_total");
      expect(body).toContain("# TYPE polaris_ingest_batch_accepted_total counter");
      expect(body).toContain("# HELP polaris_ingest_batch_rejected_total");
      expect(body).toContain("# TYPE polaris_ingest_batch_rejected_total counter");
      // Counter value reflects two increments on the same label tuple.
      expect(body).toMatch(
        /polaris_ingest_batch_accepted_total\{environment="production",project_id="checkout"\} 2/,
      );
      expect(body).toMatch(
        /polaris_ingest_batch_rejected_total\{environment="production",project_id="checkout",reason="forbidden_field_rejected"\} 1/,
      );
      // Trailing newline per the spec.
      expect(body.endsWith("\n")).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("exposes the client-context counter after a real browser-key ingest (TDZJI)", async () => {
    // End-to-end through the app rather than the handler: the key is
    // resolved by the auth path, so `auth.source.type` is the CONTROL
    // PLANE's `web` — the value real traffic actually carries — and the
    // route reads the address off the request rather than a test fixture.
    const metrics = new IngestMetrics();
    const { app } = await buildAppWithMetrics(metrics);
    try {
      const base = buildEnvelopePayload();
      const ingest = await app.inject({
        method: "POST",
        url: "/v1/events",
        headers: {
          "x-polaris-api-key": "test-key-id.secret",
          "user-agent": "Mozilla/5.0 (MetricsRouteTest)",
        },
        remoteAddress: "203.0.113.10",
        payload: {
          events: [
            {
              ...base,
              context: { ...(base["context"] as Record<string, unknown>), ip: null, user_agent: null },
            },
          ],
        },
      });
      expect(ingest.statusCode).toBe(200);

      const res = await app.inject({ method: "GET", url: "/metrics" });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain("# TYPE polaris_ingest_client_context_total counter");
      // Both fields stamped, off the injected socket and the real header.
      expect(res.body).toMatch(
        /polaris_ingest_client_context_total\{environment="production",field="ip",outcome="stamped",project_id="checkout"\} 1/,
      );
      expect(res.body).toMatch(
        /polaris_ingest_client_context_total\{environment="production",field="user_agent",outcome="stamped",project_id="checkout"\} 1/,
      );
    } finally {
      await app.close();
    }
  });

  it("returns an empty body when no metrics have been recorded yet", async () => {
    const metrics = new IngestMetrics();
    const { app } = await buildAppWithMetrics(metrics);
    try {
      const res = await app.inject({ method: "GET", url: "/metrics" });
      expect(res.statusCode).toBe(200);
      // Empty registry → empty body (toPrometheusText returns "" on empty).
      expect(res.body).toBe("");
    } finally {
      await app.close();
    }
  });
});
