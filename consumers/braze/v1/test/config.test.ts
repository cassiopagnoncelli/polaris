/**
 * Behavioral tests for the braze v1 config loader.
 *
 * @see consumers/braze/v1/src/config.ts
 */

import { describe, expect, it } from "vitest";

import { brazeConfigSchema, CONSUMER_SERVICE_NAME, DEFAULT_BRAZE_API_HOST } from "../src/config.js";

const BASE_ENV: Record<string, string> = {
  POLARIS_SERVICE_NAME: CONSUMER_SERVICE_NAME,
  POLARIS_SERVICE_VERSION: "v1",
  POLARIS_ENV: "production",
  POLARIS_LOG_LEVEL: "info",
  POLARIS_HTTP_HOST: "0.0.0.0",
  POLARIS_HTTP_PORT: "5004",
  POLARIS_HTTP_BODY_LIMIT_BYTES: "1048576",
  POLARIS_RABBITMQ_URL: "amqp://polaris:polaris@localhost:5672",
  POLARIS_RABBITMQ_CLIENT_ID: "braze",
  POLARIS_RABBITMQ_TLS: "false",
  POLARIS_POSTGRES_HOST: "localhost",
  POLARIS_POSTGRES_DATABASE: "polaris",
  POLARIS_POSTGRES_USER: "polaris",
  POLARIS_POSTGRES_PASSWORD: "polaris",
};

describe("brazeConfigSchema", () => {
  it("loads defaults for the consumer-scoped knobs", () => {
    const config = brazeConfigSchema().parse(BASE_ENV);
    expect(config.braze.consumerGroup).toBe("polaris-braze-v1");
    expect(config.braze.requestTimeoutMs).toBe(5000);
    expect(config.braze.allowReplay).toBe(false);
    expect(config.braze.apiHost).toBe(DEFAULT_BRAZE_API_HOST);
  });

  it("honours overrides for every consumer-scoped knob", () => {
    const config = brazeConfigSchema().parse({
      ...BASE_ENV,
      POLARIS_BRAZE_CONSUMER_GROUP: "polaris-braze-canary",
      POLARIS_BRAZE_REQUEST_TIMEOUT_MS: "12000",
      POLARIS_BRAZE_ALLOW_REPLAY: "true",
      POLARIS_BRAZE_API_HOST: "rest.{instance}.braze.test",
    });
    expect(config.braze.consumerGroup).toBe("polaris-braze-canary");
    expect(config.braze.requestTimeoutMs).toBe(12000);
    expect(config.braze.allowReplay).toBe(true);
    expect(config.braze.apiHost).toBe("rest.{instance}.braze.test");
  });

  it("rejects non-positive concurrency / timeout", () => {
    expect(() =>
      brazeConfigSchema().parse({
        ...BASE_ENV,
        POLARIS_BRAZE_REQUEST_TIMEOUT_MS: "-1",
      }),
    ).toThrow();
  });
});
