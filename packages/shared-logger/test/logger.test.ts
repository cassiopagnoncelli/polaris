import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";

import { createLogger } from "../src/index.js";

function captureStream() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      for (const raw of chunk.toString().split("\n")) {
        const t = raw.trim();
        if (t) lines.push(t);
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

describe("createLogger", () => {
  it("emits one JSON object per call (no pretty-printing)", () => {
    const { stream, lines } = captureStream();
    const log = createLogger({ service: "test", destination: stream });
    log.info("hello");
    log.warn("careful");
    expect(lines.length).toBe(2);
    for (const line of lines) {
      // Each line must parse as JSON.
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it("attaches the service binding to every line", () => {
    const { stream, lines } = captureStream();
    const log = createLogger({
      service: "ingester-api",
      version: "1.2.3",
      env: "production",
      region: "us-east-1",
      destination: stream,
    });
    log.info("boot");
    const obj = parseLast(lines);
    expect(obj.service).toBe("ingester-api");
    expect(obj.version).toBe("1.2.3");
    expect(obj.env).toBe("production");
    expect(obj.region).toBe("us-east-1");
    expect(typeof obj.hostname).toBe("string");
  });

  it("overrides hostname when explicitly supplied (useful in tests)", () => {
    const { stream, lines } = captureStream();
    const log = createLogger({
      service: "test",
      hostname: "pod-abc-1",
      destination: stream,
    });
    log.info("boot");
    const obj = parseLast(lines);
    expect(obj.hostname).toBe("pod-abc-1");
  });

  it("renders the log level as a textual label rather than a number", () => {
    const { stream, lines } = captureStream();
    const log = createLogger({ service: "test", level: "debug", destination: stream });
    log.info("info line");
    log.debug("debug line");
    log.warn("warn line");
    const levels = lines.map((line) => (JSON.parse(line) as { level: string }).level);
    expect(levels).toEqual(["info", "debug", "warn"]);
  });

  it("emits ISO-8601 UTC timestamps under `time`", () => {
    const { stream, lines } = captureStream();
    const log = createLogger({
      service: "test",
      destination: stream,
      timeFn: () => "2026-05-12T10:30:00.000Z",
    });
    log.info("now");
    const obj = parseLast(lines);
    expect(obj.time).toBe("2026-05-12T10:30:00.000Z");
  });

  it("respects the configured log level (info default suppresses debug)", () => {
    const { stream, lines } = captureStream();
    const log = createLogger({ service: "test", destination: stream });
    log.debug("hidden");
    log.info("visible");
    expect(lines.length).toBe(1);
    expect(parseLast(lines).message).toBe("visible");
  });

  it("supports child loggers that inherit redaction and merge bindings", () => {
    const { stream, lines } = captureStream();
    const log = createLogger({ service: "test", destination: stream });
    const child = log.child({ project_id: "checkout", request_id: "req-1" });
    child.info({ password: "leak" }, "with context");
    const obj = parseLast(lines);
    expect(obj.project_id).toBe("checkout");
    expect(obj.request_id).toBe("req-1");
    // Redaction is preserved on child loggers.
    expect(obj.password).toBe("[REDACTED]");
  });

  it("accepts caller-supplied stable bindings without overwriting the service identity", () => {
    const { stream, lines } = captureStream();
    const log = createLogger({
      service: "test",
      destination: stream,
      bindings: { cluster: "polaris-prod-1", service: "should-be-ignored" },
    });
    log.info("boot");
    const obj = parseLast(lines);
    // `service` is reserved — caller cannot overwrite it through `bindings`.
    expect(obj.service).toBe("test");
    expect(obj.cluster).toBe("polaris-prod-1");
  });
});
