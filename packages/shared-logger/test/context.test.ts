import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";

import {
  createLogger,
  withConsumer,
  withMessage,
  withProcessor,
  withReplay,
  withRequest,
  withSource,
} from "../src/index.js";

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

describe("withRequest", () => {
  it("produces bindings with only the supplied optional fields", () => {
    const bindings = withRequest({
      request_id: "018f-req",
      project_id: "checkout",
      environment: "production",
    });
    expect(bindings).toEqual({
      request_id: "018f-req",
      project_id: "checkout",
      environment: "production",
    });
    expect("source_id" in bindings).toBe(false);
  });

  it("includes source_id when present", () => {
    const bindings = withRequest({
      request_id: "r-1",
      source_id: "payments-api",
    });
    expect(bindings.source_id).toBe("payments-api");
  });

  it("attaches to a child logger and appears on every line", () => {
    const { stream, lines } = captureStream();
    const log = createLogger({ service: "ingester-api", destination: stream });
    const child = log.child(withRequest({ request_id: "r-1", project_id: "checkout" }));
    child.info("first");
    child.warn("second");
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      const obj = JSON.parse(line) as Record<string, unknown>;
      expect(obj.request_id).toBe("r-1");
      expect(obj.project_id).toBe("checkout");
      expect(obj.service).toBe("ingester-api");
    }
  });
});

describe("withSource", () => {
  it("requires source_id and keeps other fields optional", () => {
    const bindings = withSource({ source_id: "web-checkout" });
    expect(bindings).toEqual({ source_id: "web-checkout" });
  });

  it("supports project and environment bindings", () => {
    const bindings = withSource({
      source_id: "web-checkout",
      project_id: "checkout",
      environment: "production",
    });
    expect(bindings.source_id).toBe("web-checkout");
    expect(bindings.project_id).toBe("checkout");
    expect(bindings.environment).toBe("production");
  });
});

describe("withProcessor", () => {
  it("attaches processor name/version to a child logger", () => {
    const { stream, lines } = captureStream();
    const log = createLogger({ service: "sessionizer", destination: stream });
    const child = log.child(
      withProcessor({
        processor_name: "sessionizer",
        processor_version: "v1",
        topic: "raw.events",
        partition: 7,
        processor_run_id: "018f-run",
      }),
    );
    child.info("processing");
    const obj = parseLast(lines);
    expect(obj.processor_name).toBe("sessionizer");
    expect(obj.processor_version).toBe("v1");
    expect(obj.topic).toBe("raw.events");
    expect(obj.partition).toBe(7);
    expect(obj.processor_run_id).toBe("018f-run");
  });

  it("omits optional fields when not supplied", () => {
    const bindings = withProcessor({
      processor_name: "geoip-enricher",
      processor_version: "v1",
    });
    expect(bindings).toEqual({
      processor_name: "geoip-enricher",
      processor_version: "v1",
    });
  });
});

describe("withConsumer", () => {
  it("captures vendor consumer scope including destination instance", () => {
    const bindings = withConsumer({
      consumer_name: "meta-capi",
      consumer_version: "v1",
      destination_id: "dest-018f",
      topic: "analytics.events",
      partition: 2,
    });
    expect(bindings.consumer_name).toBe("meta-capi");
    expect(bindings.consumer_version).toBe("v1");
    expect(bindings.destination_id).toBe("dest-018f");
    expect(bindings.topic).toBe("analytics.events");
    expect(bindings.partition).toBe(2);
  });

  it("supports minimum required fields only", () => {
    const bindings = withConsumer({
      consumer_name: "webhook-sink",
      consumer_version: "v1",
    });
    expect(bindings).toEqual({
      consumer_name: "webhook-sink",
      consumer_version: "v1",
    });
  });
});

describe("withReplay", () => {
  it("attaches replay_job_id and optional scope hints", () => {
    const bindings = withReplay({
      replay_job_id: "018f-replay",
      topic: "raw.events",
      partition: 1,
      processor_name: "sessionizer",
      processor_version: "v1",
    });
    expect(bindings.replay_job_id).toBe("018f-replay");
    expect(bindings.processor_name).toBe("sessionizer");
    expect(bindings.processor_version).toBe("v1");
  });
});

describe("withMessage", () => {
  it("attaches topic/partition/offset/event_id for per-message logs", () => {
    const bindings = withMessage({
      topic: "raw.events",
      partition: 3,
      offset: "12345",
      event_id: "018f-evt",
    });
    expect(bindings).toEqual({
      topic: "raw.events",
      partition: 3,
      offset: "12345",
      event_id: "018f-evt",
    });
  });

  it("works with only the topic supplied", () => {
    const bindings = withMessage({ topic: "raw.events" });
    expect(bindings).toEqual({ topic: "raw.events" });
  });
});

describe("nested child loggers compose context", () => {
  it("layers request → processor → message context on the same logger chain", () => {
    const { stream, lines } = captureStream();
    const log = createLogger({ service: "ingester-api", destination: stream });
    const req = log.child(withRequest({ request_id: "r-1", project_id: "checkout" }));
    const proc = req.child(
      withProcessor({ processor_name: "sessionizer", processor_version: "v1" }),
    );
    const msg = proc.child(
      withMessage({ topic: "raw.events", offset: "12345", event_id: "018f-evt" }),
    );
    msg.info("dispatched");
    const obj = parseLast(lines);
    expect(obj.request_id).toBe("r-1");
    expect(obj.project_id).toBe("checkout");
    expect(obj.processor_name).toBe("sessionizer");
    expect(obj.processor_version).toBe("v1");
    expect(obj.topic).toBe("raw.events");
    expect(obj.offset).toBe("12345");
    expect(obj.event_id).toBe("018f-evt");
  });
});
