import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { batchRejectedResultSchema } from "@polaris/shared-schemas";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HttpsTransport, TransportError } from "../src/transport/https.js";
import type { QueuedEvent } from "../src/types.js";

function makeEvent(id: string): QueuedEvent {
  return {
    event_id: id,
    event: "test.event",
    schema_version: 1,
    occurred_at: "2026-05-12T12:00:00.000Z",
    source: { type: "backend", id: "test", sdk: "node", sdk_version: "0.0.0" },
    identity: { anonymous_id: null, session_id: null, customer_id: null, device_id: null },
    context: { ip: null, user_agent: null, locale: null, page: null, campaign: null },
    properties: {},
  };
}

interface Recorded {
  method?: string;
  url?: string;
  body: string;
  headers: Readonly<Record<string, string | undefined>>;
}

interface ResponseScript {
  status: number;
  body?: string | undefined;
  delayMs?: number | undefined;
}

interface TestServer {
  url: string;
  close: () => Promise<void>;
  recorded: Recorded[];
}

async function startServer(script: ResponseScript): Promise<TestServer> {
  const recorded: Recorded[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const headers: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        headers[k] = Array.isArray(v) ? v.join(",") : v;
      }
      const entry: Recorded = {
        body: Buffer.concat(chunks).toString("utf8"),
        headers,
      };
      if (req.method !== undefined) entry.method = req.method;
      if (req.url !== undefined) entry.url = req.url;
      recorded.push(entry);
      const respond = (): void => {
        res.statusCode = script.status;
        res.setHeader("Content-Type", "application/json");
        if (script.body !== undefined) {
          res.end(script.body);
        } else {
          res.end();
        }
      };
      if (script.delayMs !== undefined && script.delayMs > 0) {
        setTimeout(respond, script.delayMs);
      } else {
        respond();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/events`,
    recorded,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

describe("HttpsTransport", () => {
  let server: TestServer | undefined;

  beforeEach(() => {
    server = undefined;
  });

  afterEach(async () => {
    if (server !== undefined) await server.close();
  });

  it("validates the endpoint scheme", () => {
    expect(
      () =>
        new HttpsTransport({
          endpoint: "ftp://example.invalid/events",
          apiKey: "k",
          userAgent: "ua",
          requestTimeoutMs: 1000,
        }),
    ).toThrowError(/http/);
  });

  it("POSTs the payload and treats 2xx with parsed body as per-event results", async () => {
    server = await startServer({
      status: 200,
      body: JSON.stringify({
        accepted: [{ event_id: "a", status: "accepted" }],
        rejected: [{ event_id: "b", status: "rejected", reason: "schema_validation_failed" }],
      }),
    });
    const transport = new HttpsTransport({
      endpoint: server.url,
      apiKey: "test-key",
      userAgent: "test-ua",
      requestTimeoutMs: 5_000,
    });
    const result = await transport.send([makeEvent("a"), makeEvent("b")]);
    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.retryable).toBe(false);

    const recorded = server.recorded[0];
    expect(recorded?.method).toBe("POST");
    // The ingester reads only `x-polaris-api-key`; Bearer must not appear
    // on the wire because the ingester ignores `Authorization`.
    expect(recorded?.headers["x-polaris-api-key"]).toBe("test-key");
    expect(recorded?.headers["authorization"]).toBeUndefined();
    expect(recorded?.headers["user-agent"]).toBe("test-ua");
    expect(JSON.parse(recorded?.body ?? "{}")).toEqual({
      events: [
        expect.objectContaining({ event_id: "a" }),
        expect.objectContaining({ event_id: "b" }),
      ],
    });

    transport.close();
  });

  it("falls back to all-accepted when 2xx body is empty or unparseable", async () => {
    server = await startServer({ status: 204, body: "" });
    const transport = new HttpsTransport({
      endpoint: server.url,
      apiKey: "k",
      userAgent: "ua",
      requestTimeoutMs: 5_000,
    });
    const result = await transport.send([makeEvent("a"), makeEvent("b")]);
    expect(result.accepted).toHaveLength(2);
    expect(result.rejected).toHaveLength(0);
    transport.close();
  });

  it("treats 5xx as retryable TransportError", async () => {
    server = await startServer({ status: 503, body: "" });
    const transport = new HttpsTransport({
      endpoint: server.url,
      apiKey: "k",
      userAgent: "ua",
      requestTimeoutMs: 5_000,
    });
    await expect(transport.send([makeEvent("a")])).rejects.toMatchObject({
      name: "TransportError",
      retryable: true,
      status: 503,
    });
    transport.close();
  });

  it("treats 4xx (except 408/429) as permanent TransportError", async () => {
    server = await startServer({ status: 401, body: "" });
    const transport = new HttpsTransport({
      endpoint: server.url,
      apiKey: "k",
      userAgent: "ua",
      requestTimeoutMs: 5_000,
    });
    await expect(transport.send([makeEvent("a")])).rejects.toMatchObject({
      name: "TransportError",
      retryable: false,
      status: 401,
    });
    transport.close();
  });

  it("treats 429 as retryable", async () => {
    server = await startServer({ status: 429, body: "" });
    const transport = new HttpsTransport({
      endpoint: server.url,
      apiKey: "k",
      userAgent: "ua",
      requestTimeoutMs: 5_000,
    });
    await expect(transport.send([makeEvent("a")])).rejects.toMatchObject({
      name: "TransportError",
      retryable: true,
      status: 429,
    });
    transport.close();
  });

  it("returns events not echoed back as accepted", async () => {
    server = await startServer({
      status: 200,
      body: JSON.stringify({
        accepted: [{ event_id: "a", status: "accepted" }],
        rejected: [],
      }),
    });
    const transport = new HttpsTransport({
      endpoint: server.url,
      apiKey: "k",
      userAgent: "ua",
      requestTimeoutMs: 5_000,
    });
    const result = await transport.send([makeEvent("a"), makeEvent("missing")]);
    expect(result.accepted).toHaveLength(2);
    expect(result.rejected).toHaveLength(0);
    transport.close();
  });

  it("times out and surfaces a retryable TransportError", async () => {
    server = await startServer({ status: 200, body: "{}", delayMs: 500 });
    const transport = new HttpsTransport({
      endpoint: server.url,
      apiKey: "k",
      userAgent: "ua",
      requestTimeoutMs: 50,
    });
    await expect(transport.send([makeEvent("a")])).rejects.toMatchObject({
      name: "TransportError",
      retryable: true,
    });
    transport.close();
  });

  it("TransportError preserves retryable flag", () => {
    const err = new TransportError("x", { retryable: true, status: 500 });
    expect(err.retryable).toBe(true);
    expect(err.status).toBe(500);
  });
});

describe("HttpsTransport — rejection classification against the real wire shape", () => {
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  /** Exactly what the ingester emits, validated against the ingester's schema. */
  function serverRejection(code: string, retryable: boolean) {
    const entry = {
      event_id: "018f1b9e-7b50-7b12-9a2e-0e2f88d8f551",
      status: "rejected" as const,
      code,
      retryable,
      detail: { event: "page.viewed", message: "…" },
    };
    // The crossing. If the server's contract changes shape, this throws here
    // rather than silently producing an SDK that misreads every rejection —
    // which is precisely what happened: this SDK parsed `entry.reason`, a
    // field the ingester has never sent, so every rejection came back
    // `retryable: false` and the SDK dropped events it was asked to retry.
    batchRejectedResultSchema.parse(entry);
    return entry;
  }

  async function classify(entry: Record<string, unknown>) {
    server = await startServer({
      status: 200,
      body: JSON.stringify({ accepted: [], rejected: [entry] }),
    });
    const transport = new HttpsTransport({
      endpoint: server.url,
      apiKey: "k",
      userAgent: "ua",
      requestTimeoutMs: 5_000,
    });
    const result = await transport.send([makeEvent(String(entry["event_id"]))]);
    return result.rejected[0];
  }

  it("retries publish_failed — the transient case the ingester tells clients to resend", async () => {
    const entry = await classify(serverRejection("publish_failed", true));
    expect(entry?.retryable).toBe(true);
    expect(entry?.reason).toBe("publish_failed");
  });

  it("retries in_progress — another request holds the dedupe lease", async () => {
    const entry = await classify(serverRejection("in_progress", true));
    expect(entry?.retryable).toBe(true);
  });

  it("does not retry a duplicate — the platform already has the event", async () => {
    const entry = await classify(serverRejection("duplicate", false));
    expect(entry?.retryable).toBe(false);
  });

  it("does not retry a validation failure", async () => {
    const entry = await classify(serverRejection("invalid_properties", false));
    expect(entry?.retryable).toBe(false);
  });

  it("falls back to the local set for an ingester that sends no `retryable`", async () => {
    const entry = await classify({
      event_id: "018f1b9e-7b50-7b12-9a2e-0e2f88d8f551",
      status: "rejected",
      code: "publish_failed",
    });
    expect(entry?.retryable).toBe(true);
  });
});
