/**
 * Behavioral tests for the tiktok v1 config loader.
 *
 * @see consumers/tiktok/v1/src/config.ts
 */

import { describe, expect, it } from "vitest";

import {
  CONSUMER_SERVICE_NAME,
  DEFAULT_TIKTOK_API_HOST,
  tiktokConfigSchema,
} from "../src/config.js";

const BASE_ENV: Record<string, string> = {
  POLARIS_SERVICE_NAME: CONSUMER_SERVICE_NAME,
  POLARIS_SERVICE_VERSION: "v1",
  POLARIS_ENV: "production",
  POLARIS_LOG_LEVEL: "info",
  POLARIS_HTTP_HOST: "0.0.0.0",
  POLARIS_HTTP_PORT: "5003",
  POLARIS_HTTP_BODY_LIMIT_BYTES: "1048576",
  POLARIS_RABBITMQ_URL: "localhost:9092",
  POLARIS_RABBITMQ_CLIENT_ID: "tiktok",
  POLARIS_RABBITMQ_TLS: "false",
  POLARIS_POSTGRES_HOST: "localhost",
  POLARIS_POSTGRES_DATABASE: "polaris",
  POLARIS_POSTGRES_USER: "polaris",
  POLARIS_POSTGRES_PASSWORD: "polaris",
};

describe("tiktokConfigSchema", () => {
  it("loads defaults for the consumer-scoped knobs", () => {
    const config = tiktokConfigSchema().parse(BASE_ENV);
    expect(config.tiktok.consumerGroup).toBe("polaris-tiktok-v1");
    expect(config.tiktok.partitionsConsumedConcurrently).toBe(4);
    expect(config.tiktok.requestTimeoutMs).toBe(5000);
    expect(config.tiktok.allowReplay).toBe(false);
    expect(config.tiktok.apiHost).toBe(DEFAULT_TIKTOK_API_HOST);
  });

  it("honours overrides for every consumer-scoped knob", () => {
    const config = tiktokConfigSchema().parse({
      ...BASE_ENV,
      POLARIS_TIKTOK_CONSUMER_GROUP: "polaris-tiktok-canary",
      POLARIS_TIKTOK_CONCURRENCY: "8",
      POLARIS_TIKTOK_REQUEST_TIMEOUT_MS: "12000",
      POLARIS_TIKTOK_ALLOW_REPLAY: "true",
      POLARIS_TIKTOK_API_HOST: "business-api.tiktok.test",
    });
    expect(config.tiktok.consumerGroup).toBe("polaris-tiktok-canary");
    expect(config.tiktok.partitionsConsumedConcurrently).toBe(8);
    expect(config.tiktok.requestTimeoutMs).toBe(12000);
    expect(config.tiktok.allowReplay).toBe(true);
    expect(config.tiktok.apiHost).toBe("business-api.tiktok.test");
  });

  it("rejects non-positive concurrency / timeout", () => {
    expect(() =>
      tiktokConfigSchema().parse({ ...BASE_ENV, POLARIS_TIKTOK_CONCURRENCY: "0" }),
    ).toThrow();
    expect(() =>
      tiktokConfigSchema().parse({
        ...BASE_ENV,
        POLARIS_TIKTOK_REQUEST_TIMEOUT_MS: "-1",
      }),
    ).toThrow();
  });
});
