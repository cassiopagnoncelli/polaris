/**
 * Behavioral tests for the webhook-sink v1 config loader.
 *
 * The schema is small but each default matters: it controls the consumer
 * group identity (must NOT collide with v2 / vendor), the per-attempt
 * timeout (must match the manifest), and the replay opt-in (must be
 * `false` unless the deployment template explicitly flips it).
 *
 * @see sync/destinations/webhook-sink/v1/src/config.ts
 */

import { ConfigValidationError } from "@polaris/shared-config";
import { describe, expect, it } from "vitest";

import { CONSUMER_SERVICE_NAME, webhookSinkConfigSchema } from "../src/config.js";

const BASE_ENV: Record<string, string> = {
  POLARIS_SERVICE_NAME: CONSUMER_SERVICE_NAME,
  POLARIS_SERVICE_VERSION: "v1",
  POLARIS_ENV: "production",
  POLARIS_LOG_LEVEL: "info",
  POLARIS_HTTP_HOST: "0.0.0.0",
  POLARIS_HTTP_PORT: "4002",
  POLARIS_HTTP_BODY_LIMIT_BYTES: "1048576",
  POLARIS_RABBITMQ_URL: "amqp://polaris:polaris@localhost:5672",
  POLARIS_RABBITMQ_CLIENT_ID: "webhook-sink",
  POLARIS_RABBITMQ_TLS: "false",
  POLARIS_POSTGRES_HOST: "localhost",
  POLARIS_POSTGRES_DATABASE: "polaris",
  POLARIS_POSTGRES_USER: "polaris",
  POLARIS_POSTGRES_PASSWORD: "polaris",
};

describe("webhookSinkConfigSchema", () => {
  it("loads defaults for the consumer-scoped knobs", () => {
    const config = webhookSinkConfigSchema().parse(BASE_ENV);
    expect(config.sink.consumerGroup).toBe("polaris-webhook-sink-v1");
    expect(config.sink.requestTimeoutMs).toBe(5000);
    expect(config.sink.allowReplay).toBe(false);
  });

  it("honours overrides for every consumer-scoped knob", () => {
    const config = webhookSinkConfigSchema().parse({
      ...BASE_ENV,
      POLARIS_WEBHOOK_SINK_CONSUMER_GROUP: "polaris-webhook-sink-canary",
      POLARIS_WEBHOOK_SINK_REQUEST_TIMEOUT_MS: "12000",
      POLARIS_WEBHOOK_SINK_ALLOW_REPLAY: "true",
    });
    expect(config.sink.consumerGroup).toBe("polaris-webhook-sink-canary");
    expect(config.sink.requestTimeoutMs).toBe(12000);
    expect(config.sink.allowReplay).toBe(true);
  });

  it("rejects non-positive timeout values", () => {
    const schema = webhookSinkConfigSchema();
    expect(() =>
      schema.parse({ ...BASE_ENV, POLARIS_WEBHOOK_SINK_REQUEST_TIMEOUT_MS: "0" }),
    ).toThrow();
  });

  it("composes service + http + rabbitmq + postgres + sink blocks", () => {
    const config = webhookSinkConfigSchema().parse(BASE_ENV);
    expect(config.service.serviceName).toBe(CONSUMER_SERVICE_NAME);
    expect(config.http.host).toBe("0.0.0.0");
    expect(config.http.port).toBe(4002);
    expect(config.rabbitmq.url).toBe("amqp://polaris:polaris@localhost:5672");
    expect(config.postgres.host).toBe("localhost");
    expect(config.postgres.database).toBe("polaris");
    expect(config.sink.consumerGroup).toBe("polaris-webhook-sink-v1");
  });

  it("ConfigValidationError name is wired up so callers can match", () => {
    expect(ConfigValidationError.name).toBe("ConfigValidationError");
  });
});
