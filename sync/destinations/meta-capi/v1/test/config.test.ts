/**
 * Behavioral tests for the meta-capi v1 config loader.
 *
 * @see sync/destinations/meta-capi/v1/src/config.ts
 */

import { describe, expect, it } from "vitest";

import { CONSUMER_SERVICE_NAME, DEFAULT_GRAPH_HOST, metaCapiConfigSchema } from "../src/config.js";

const BASE_ENV: Record<string, string> = {
  POLARIS_SERVICE_NAME: CONSUMER_SERVICE_NAME,
  POLARIS_SERVICE_VERSION: "v1",
  POLARIS_ENV: "production",
  POLARIS_LOG_LEVEL: "info",
  POLARIS_HTTP_HOST: "0.0.0.0",
  POLARIS_HTTP_PORT: "4003",
  POLARIS_HTTP_BODY_LIMIT_BYTES: "1048576",
  POLARIS_RABBITMQ_URL: "amqp://polaris:polaris@localhost:5672",
  POLARIS_RABBITMQ_CLIENT_ID: "meta-capi",
  POLARIS_RABBITMQ_TLS: "false",
  POLARIS_POSTGRES_HOST: "localhost",
  // Required since the destination runtime gained Redis-backed dedupe and a
  // global RPS budget: both are per-process without it, which is the
  // multi-replica double-send this configuration exists to prevent.
  POLARIS_REDIS_HOST: "localhost",
  POLARIS_POSTGRES_DATABASE: "polaris",
  POLARIS_POSTGRES_USER: "polaris",
  POLARIS_POSTGRES_PASSWORD: "polaris",
};

describe("metaCapiConfigSchema", () => {
  it("loads defaults for the consumer-scoped knobs", () => {
    const config = metaCapiConfigSchema().parse(BASE_ENV);
    expect(config.meta.consumerGroup).toBe("polaris-meta-capi-v1");
    expect(config.meta.requestTimeoutMs).toBe(5000);
    expect(config.meta.allowReplay).toBe(false);
    expect(config.meta.graphHost).toBe(DEFAULT_GRAPH_HOST);
  });

  it("honours overrides for every consumer-scoped knob", () => {
    const config = metaCapiConfigSchema().parse({
      ...BASE_ENV,
      POLARIS_META_CAPI_CONSUMER_GROUP: "polaris-meta-capi-canary",
      POLARIS_META_CAPI_REQUEST_TIMEOUT_MS: "12000",
      POLARIS_META_CAPI_ALLOW_REPLAY: "true",
      POLARIS_META_CAPI_GRAPH_HOST: "graph.facebook.test",
    });
    expect(config.meta.consumerGroup).toBe("polaris-meta-capi-canary");
    expect(config.meta.requestTimeoutMs).toBe(12000);
    expect(config.meta.allowReplay).toBe(true);
    expect(config.meta.graphHost).toBe("graph.facebook.test");
  });

  it("rejects non-positive concurrency / timeout", () => {
    expect(() =>
      metaCapiConfigSchema().parse({
        ...BASE_ENV,
        POLARIS_META_CAPI_REQUEST_TIMEOUT_MS: "-1",
      }),
    ).toThrow();
  });
});
