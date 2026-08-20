import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createLogger,
  DEFAULT_REDACTION_PATHS,
  REDACTION_CENSOR,
  resolveRedactionPaths,
} from "../src/index.js";

/**
 * Capture stream that buffers log lines so tests can assert on serialised JSON.
 * Pino writes one newline-delimited JSON object per `.info()` / `.warn()` call.
 */
function captureStream() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      const text = chunk.toString();
      for (const raw of text.split("\n")) {
        const trimmed = raw.trim();
        if (trimmed.length > 0) lines.push(trimmed);
      }
      callback();
    },
  });
  return { stream, lines };
}

function parseLast(lines: string[]): Record<string, unknown> {
  const last = lines.at(-1);
  if (!last) throw new Error("no log lines captured");
  return JSON.parse(last) as Record<string, unknown>;
}

describe("DEFAULT_REDACTION_PATHS", () => {
  it("is frozen so the platform list cannot be mutated by callers", () => {
    expect(Object.isFrozen(DEFAULT_REDACTION_PATHS)).toBe(true);
  });

  it.each([
    "password",
    "passwd",
    "pwd",
    "authorization",
    "Authorization",
    "cookie",
    "set-cookie",
    "session_cookie",
    "token",
    "access_token",
    "refresh_token",
    "id_token",
    "bearer_token",
    "secret",
    "client_secret",
    "api_key",
    "apiKey",
    "private_key",
    "privateKey",
    "cvv",
    "cvc",
    "card_security_code",
    "card_number",
    "card_number_full",
    "pan",
  ])("includes %s on the top-level redaction list", (path) => {
    expect(DEFAULT_REDACTION_PATHS).toContain(path);
  });

  it.each([
    "req.headers.authorization",
    'req.headers["set-cookie"]',
    'req.headers["x-api-key"]',
    'req.headers["x-polaris-api-key"]',
    'headers["set-cookie"]',
    "headers.authorization",
  ])("covers nested header path %s", (path) => {
    expect(DEFAULT_REDACTION_PATHS).toContain(path);
  });

  it.each([
    "event.properties",
    "events[*].properties",
    "raw.properties",
    "envelope.properties",
  ])("redacts raw event payload at %s", (path) => {
    expect(DEFAULT_REDACTION_PATHS).toContain(path);
  });
});

describe("resolveRedactionPaths", () => {
  it("returns the defaults unchanged when no extras supplied", () => {
    const resolved = resolveRedactionPaths();
    expect(resolved).toEqual([...DEFAULT_REDACTION_PATHS]);
  });

  it("appends caller-supplied paths to the default list", () => {
    const resolved = resolveRedactionPaths(["custom.secret", "context.session_token"]);
    expect(resolved).toContain("custom.secret");
    expect(resolved).toContain("context.session_token");
    // Defaults remain present.
    expect(resolved).toContain("password");
    expect(resolved).toContain("authorization");
  });

  it("deduplicates paths so the censor lookup stays compact", () => {
    const resolved = resolveRedactionPaths(["password", "password", "custom.thing"]);
    const occurrences = resolved.filter((p) => p === "password").length;
    expect(occurrences).toBe(1);
    expect(resolved.filter((p) => p === "custom.thing").length).toBe(1);
  });

  it("does not mutate the frozen default list", () => {
    const before = [...DEFAULT_REDACTION_PATHS];
    resolveRedactionPaths(["another.secret"]);
    expect([...DEFAULT_REDACTION_PATHS]).toEqual(before);
  });
});

describe("createLogger redaction integration", () => {
  let capture: ReturnType<typeof captureStream>;

  beforeEach(() => {
    capture = captureStream();
  });

  afterEach(() => {
    capture.lines.length = 0;
  });

  it("redacts a password field on a plain object", () => {
    const log = createLogger({ service: "test", destination: capture.stream });
    log.info({ password: "hunter2" }, "test");
    const last = parseLast(capture.lines);
    expect(last.password).toBe(REDACTION_CENSOR);
  });

  it("redacts authorization headers on a Fastify-shaped request", () => {
    const log = createLogger({ service: "test", destination: capture.stream });
    log.info(
      {
        req: {
          method: "POST",
          url: "/v1/events",
          headers: {
            authorization: "Bearer eyJraWQ...",
            cookie: "session=abc123",
            "x-api-key": "pk_live_AAAA",
            "set-cookie": "polaris_sid=xyz; HttpOnly",
            "user-agent": "polaris-node-sdk/1.0.0",
          },
        },
      },
      "incoming request",
    );
    const last = parseLast(capture.lines);
    const req = last.req as { headers: Record<string, unknown> };
    expect(req.headers.authorization).toBe(REDACTION_CENSOR);
    expect(req.headers.cookie).toBe(REDACTION_CENSOR);
    expect(req.headers["x-api-key"]).toBe(REDACTION_CENSOR);
    expect(req.headers["set-cookie"]).toBe(REDACTION_CENSOR);
    // Non-secret headers must remain visible for triage.
    expect(req.headers["user-agent"]).toBe("polaris-node-sdk/1.0.0");
  });

  it("redacts raw event payload `properties` by default", () => {
    const log = createLogger({ service: "test", destination: capture.stream });
    log.info(
      {
        event: {
          event_id: "018f-...",
          event: "payment.approved",
          properties: { amount: 12990, payment_method: "credit_card" },
        },
      },
      "publishing event",
    );
    const last = parseLast(capture.lines);
    const event = last.event as { event_id: string; event: string; properties: unknown };
    // Architectural rule: raw `properties` must not appear in log output by default.
    expect(event.properties).toBe(REDACTION_CENSOR);
    // Event metadata remains visible — that is the recommended logging shape.
    expect(event.event_id).toBe("018f-...");
    expect(event.event).toBe("payment.approved");
  });

  it("redacts card data, both top-level and nested under properties", () => {
    const log = createLogger({ service: "test", destination: capture.stream });
    log.info(
      {
        cvv: "123",
        card_number: "4111111111111111",
        properties: {
          cvv: "456",
          cardNumber: "5500000000000004",
          card_security_code: "789",
          card_number_full: "4111111111111111",
          pan: "4111111111111111",
        },
      },
      "card field guard",
    );
    const last = parseLast(capture.lines);
    expect(last.cvv).toBe(REDACTION_CENSOR);
    expect(last.card_number).toBe(REDACTION_CENSOR);
    const props = last.properties as Record<string, unknown>;
    expect(props.cvv).toBe(REDACTION_CENSOR);
    expect(props.cardNumber).toBe(REDACTION_CENSOR);
    expect(props.card_security_code).toBe(REDACTION_CENSOR);
    expect(props.card_number_full).toBe(REDACTION_CENSOR);
    expect(props.pan).toBe(REDACTION_CENSOR);
  });

  it("redacts tokens and secrets in nested config-style objects", () => {
    const log = createLogger({ service: "test", destination: capture.stream });
    log.info(
      {
        config: {
          secret: "shh",
          api_key: "key-123",
          private_key: "-----BEGIN PRIVATE KEY-----...",
        },
        bearer_token: "abc.def.ghi",
        access_token: "xyz",
        refresh_token: "rrr",
        id_token: "iii",
      },
      "token guard",
    );
    const last = parseLast(capture.lines);
    const config = last.config as Record<string, unknown>;
    expect(config.secret).toBe(REDACTION_CENSOR);
    expect(config.api_key).toBe(REDACTION_CENSOR);
    expect(config.private_key).toBe(REDACTION_CENSOR);
    expect(last.bearer_token).toBe(REDACTION_CENSOR);
    expect(last.access_token).toBe(REDACTION_CENSOR);
    expect(last.refresh_token).toBe(REDACTION_CENSOR);
    expect(last.id_token).toBe(REDACTION_CENSOR);
  });

  it("respects caller-supplied additional redaction paths", () => {
    const log = createLogger({
      service: "test",
      destination: capture.stream,
      additionalRedactionPaths: ["context.session_token", "custom.deep.path"],
    });
    log.info(
      {
        context: { session_token: "stoken-1" },
        custom: { deep: { path: "secret-value" } },
      },
      "extra redaction",
    );
    const last = parseLast(capture.lines);
    const ctx = last.context as Record<string, unknown>;
    expect(ctx.session_token).toBe(REDACTION_CENSOR);
    const custom = last.custom as { deep: Record<string, unknown> };
    expect(custom.deep.path).toBe(REDACTION_CENSOR);
  });

  it("never leaks redacted values into the message or any other field", () => {
    const log = createLogger({ service: "test", destination: capture.stream });
    const SECRET = "this-must-not-appear-anywhere";
    log.info({ password: SECRET }, "redaction smoke test");
    const serialised = capture.lines.join("\n");
    expect(serialised).not.toContain(SECRET);
    expect(serialised).toContain(REDACTION_CENSOR);
  });
});
