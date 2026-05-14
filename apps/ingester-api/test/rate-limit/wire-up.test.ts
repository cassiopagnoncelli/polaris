/**
 * End-to-end test for the rate-limit guard's wire-up.
 *
 * Builds `buildIngesterApp` with a synthetic limiter + producer +
 * api-key fixture and drives `POST /v1/events` through Fastify's
 * `inject`. Pins:
 *
 *   - 429 + Retry-After when the limiter refuses
 *   - rate_limited Problem code carries through Fastify error handler
 *   - polaris_ingest_rate_limit_rejected_total increments on refusal
 *   - Limiter-supplied `allowed: true` lets the request through; a
 *     limiter that internally records a `skipped` counter (fail-open
 *     posture) bumps polaris_ingest_rate_limit_skipped_total
 *
 * @see apps/ingester-api/src/rate-limit/guard.ts
 * @see apps/ingester-api/src/routes/events.ts
 */

import { describe, expect, it } from "vitest";

import { buildIngesterApp } from "../../src/app.js";
import { InMemoryDedupeStore } from "../../src/dedupe/index.js";
import {
  IngestMetrics,
  METRIC_INGEST_RATE_LIMIT_REJECTED_TOTAL,
  METRIC_INGEST_RATE_LIMIT_SKIPPED_TOTAL,
} from "../../src/metrics/registry.js";
import type { RateLimitDecision, RateLimiter } from "../../src/rate-limit/index.js";

import {
  buildEnvelopePayload,
  buildTestCatalog,
  InMemoryApiKeyRepository,
  RecordingProducer,
  testConfig,
} from "../fixtures.ts";

const API_KEY_ID = "polaris_key_rl_test";
const PROJECT_ID = "checkout";
const SOURCE_ID = "storefront-web";
const ENVIRONMENT = "production";

function repoWithKey(): InMemoryApiKeyRepository {
  const repo = new InMemoryApiKeyRepository();
  repo.set({
    apiKeyId: API_KEY_ID,
    projectId: PROJECT_ID,
    environment: ENVIRONMENT,
    sourceId: SOURCE_ID,
    sourceType: "web",
    hash: "argon2id-hash-irrelevant-test-stub",
    hashAlgorithm: "argon2id",
    status: "active",
  });
  return repo;
}

const VALID_API_KEY_HEADER = `${API_KEY_ID}.test-secret-tail-irrelevant-for-stub`;

function stubLimiter(decision: RateLimitDecision): RateLimiter {
  return { acquire: async () => decision };
}

async function buildAppWith(opts: { limiter: RateLimiter; metrics?: IngestMetrics }) {
  const metrics = opts.metrics ?? new IngestMetrics();
  return buildIngesterApp({
    config: testConfig,
    installShutdown: false,
    apiKeyRepository: repoWithKey(),
    catalog: buildTestCatalog(),
    producer: new RecordingProducer() as unknown as Parameters<
      typeof buildIngesterApp
    >[0]["producer"],
    dedupe: new InMemoryDedupeStore(),
    verifyHash: async () => true,
    rateLimiter: opts.limiter,
    metrics,
    disableOriginGuard: true,
  });
}

describe("rate-limit wire-up (P11-006c)", () => {
  it("returns 429 rate_limited with Retry-After when the limiter refuses", async () => {
    const metrics = new IngestMetrics();
    const { app } = await buildAppWith({
      limiter: stubLimiter({ allowed: false, retry_after_seconds: 7 }),
      metrics,
    });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/v1/events",
        headers: {
          "x-polaris-api-key": VALID_API_KEY_HEADER,
          "content-type": "application/json",
        },
        payload: { events: [buildEnvelopePayload()] },
      });
      expect(res.statusCode).toBe(429);
      expect(res.headers["retry-after"]).toBe("7");
      const body = res.json() as { code: string };
      expect(body.code).toBe("rate_limited");
      expect(
        metrics.getCounter(METRIC_INGEST_RATE_LIMIT_REJECTED_TOTAL, {
          project_id: PROJECT_ID,
          environment: ENVIRONMENT,
        }),
      ).toBe(1);
    } finally {
      await app.close();
    }
  });

  it("lets the request through when the limiter allows", async () => {
    const { app } = await buildAppWith({ limiter: stubLimiter({ allowed: true }) });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/v1/events",
        headers: {
          "x-polaris-api-key": VALID_API_KEY_HEADER,
          "content-type": "application/json",
        },
        payload: { events: [buildEnvelopePayload()] },
      });
      // The rate-limit guard didn't fire — anything except 429 confirms
      // the chain proceeded past the limiter. The handler decides the
      // final status from the batch result.
      expect(res.statusCode).not.toBe(429);
    } finally {
      await app.close();
    }
  });

  it("fail-open path: limiter returns allowed:true on Redis outage; the rate_limit_skipped metric increments", async () => {
    const metrics = new IngestMetrics();
    // A limiter that internally emits the skipped counter and returns
    // allowed:true models the contract the Redis adapter honours in
    // its catch branch (see redis.test.ts for the unit-level proof).
    const limiter: RateLimiter = {
      acquire: async () => {
        metrics.incrementRateLimitSkipped({
          project_id: PROJECT_ID,
          environment: ENVIRONMENT,
        });
        return { allowed: true };
      },
    };
    const { app } = await buildAppWith({ limiter, metrics });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/v1/events",
        headers: {
          "x-polaris-api-key": VALID_API_KEY_HEADER,
          "content-type": "application/json",
        },
        payload: { events: [buildEnvelopePayload()] },
      });
      expect(res.statusCode).not.toBe(429);
      expect(
        metrics.getCounter(METRIC_INGEST_RATE_LIMIT_SKIPPED_TOTAL, {
          project_id: PROJECT_ID,
          environment: ENVIRONMENT,
        }),
      ).toBe(1);
    } finally {
      await app.close();
    }
  });
});
