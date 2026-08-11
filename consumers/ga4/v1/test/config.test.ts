/**
 * Behavioral tests for the ga4 v1 config loader.
 *
 * @see consumers/ga4/v1/src/config.ts
 */

import { describe, expect, it } from "vitest";

import { CONSUMER_SERVICE_NAME, DEFAULT_GA4_API_HOST, ga4ConfigSchema } from "../src/config.js";

const BASE_ENV: Record<string, string> = {
  POLARIS_SERVICE_NAME: CONSUMER_SERVICE_NAME,
  POLARIS_SERVICE_VERSION: "v1",
  POLARIS_ENV: "production",
  POLARIS_LOG_LEVEL: "info",
  POLARIS_HTTP_HOST: "0.0.0.0",
  POLARIS_HTTP_PORT: "5002",
  POLARIS_HTTP_BODY_LIMIT_BYTES: "1048576",
  POLARIS_RABBITMQ_URL: "localhost:9092",
  POLARIS_RABBITMQ_CLIENT_ID: "ga4",
  POLARIS_RABBITMQ_TLS: "false",
  POLARIS_POSTGRES_HOST: "localhost",
  POLARIS_POSTGRES_DATABASE: "polaris",
  POLARIS_POSTGRES_USER: "polaris",
  POLARIS_POSTGRES_PASSWORD: "polaris",
};

describe("ga4ConfigSchema", () => {
  it("loads defaults for the consumer-scoped knobs", () => {
    const config = ga4ConfigSchema().parse(BASE_ENV);
    expect(config.ga4.consumerGroup).toBe("polaris-ga4-v1");
    expect(config.ga4.partitionsConsumedConcurrently).toBe(4);
    expect(config.ga4.requestTimeoutMs).toBe(5000);
    expect(config.ga4.allowReplay).toBe(false);
    expect(config.ga4.apiHost).toBe(DEFAULT_GA4_API_HOST);
  });

  it("honours overrides for every consumer-scoped knob", () => {
    const config = ga4ConfigSchema().parse({
      ...BASE_ENV,
      POLARIS_GA4_CONSUMER_GROUP: "polaris-ga4-canary",
      POLARIS_GA4_CONCURRENCY: "8",
      POLARIS_GA4_REQUEST_TIMEOUT_MS: "12000",
      POLARIS_GA4_ALLOW_REPLAY: "true",
      POLARIS_GA4_API_HOST: "www.google-analytics.test",
    });
    expect(config.ga4.consumerGroup).toBe("polaris-ga4-canary");
    expect(config.ga4.partitionsConsumedConcurrently).toBe(8);
    expect(config.ga4.requestTimeoutMs).toBe(12000);
    expect(config.ga4.allowReplay).toBe(true);
    expect(config.ga4.apiHost).toBe("www.google-analytics.test");
  });

  it("rejects non-positive concurrency / timeout", () => {
    expect(() => ga4ConfigSchema().parse({ ...BASE_ENV, POLARIS_GA4_CONCURRENCY: "0" })).toThrow();
    expect(() =>
      ga4ConfigSchema().parse({
        ...BASE_ENV,
        POLARIS_GA4_REQUEST_TIMEOUT_MS: "-1",
      }),
    ).toThrow();
  });
});
