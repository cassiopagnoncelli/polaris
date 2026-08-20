import { createLogger } from "@polaris/observability-logger";
import { describe, expect, it, vi } from "vitest";

import {
  buildDedupeKey,
  createRedisDedupeStore,
  DisabledDedupeStore,
  InMemoryDedupeStore,
  type RedisClientLike,
} from "../../src/dedupe/index.js";

const SILENT = createLogger({ service: "ingester-api-test", version: "0.0.0", env: "test" });

describe("InMemoryDedupeStore", () => {
  it("returns claimed first, then in_progress while the lease is unresolved", async () => {
    const store = new InMemoryDedupeStore();
    const input = {
      projectId: "checkout",
      environment: "production",
      eventId: "evt-1",
      ttlSec: 60,
    };
    expect((await store.claim(input)).status).toBe("claimed");
    // The first caller is still publishing. The platform does not have the
    // event yet, so a competing request must be told to retry — not that the
    // event is safely stored.
    expect((await store.claim(input)).status).toBe("in_progress");
  });

  it("returns duplicate once the claim is confirmed", async () => {
    const store = new InMemoryDedupeStore();
    const input = {
      projectId: "checkout",
      environment: "production",
      eventId: "evt-1",
      ttlSec: 60,
    };
    await store.claim(input);
    await store.confirm({ ...input, ttlSec: 900 });
    expect((await store.claim(input)).status).toBe("duplicate");
  });

  it("frees the key for a fresh claim after release", async () => {
    const store = new InMemoryDedupeStore();
    const input = {
      projectId: "checkout",
      environment: "production",
      eventId: "evt-1",
      ttlSec: 60,
    };
    await store.claim(input);
    await store.release(input);
    expect((await store.claim(input)).status).toBe("claimed");
  });

  it("expires entries when the TTL elapses", async () => {
    let now = 1_000_000;
    const store = new InMemoryDedupeStore({
      now: () => now,
      sweepIntervalMs: 0,
    });
    const input = {
      projectId: "checkout",
      environment: "production",
      eventId: "evt-1",
      ttlSec: 5,
    };
    expect((await store.claim(input)).status).toBe("claimed");
    // Push past the TTL.
    now += 6_000;
    expect((await store.claim(input)).status).toBe("claimed");
  });

  it("namespaces by project_id and environment so cross-env event_ids never collide", async () => {
    const store = new InMemoryDedupeStore();
    expect(
      (await store.claim({ projectId: "a", environment: "prod", eventId: "x", ttlSec: 60 })).status,
    ).toBe("claimed");
    expect(
      (await store.claim({ projectId: "b", environment: "prod", eventId: "x", ttlSec: 60 })).status,
    ).toBe("claimed");
    expect(
      (await store.claim({ projectId: "a", environment: "stage", eventId: "x", ttlSec: 60 }))
        .status,
    ).toBe("claimed");
    expect(
      (await store.claim({ projectId: "a", environment: "prod", eventId: "x", ttlSec: 60 })).status,
    ).toBe("in_progress");
  });
});

describe("DisabledDedupeStore", () => {
  it("always returns skipped so the handler keeps going", async () => {
    const store = new DisabledDedupeStore();
    expect(
      (await store.claim({ projectId: "x", environment: "y", eventId: "z", ttlSec: 1 })).status,
    ).toBe("skipped");
  });
});

describe("buildDedupeKey", () => {
  it("composes <prefix>:<project>:<env>:<event_id>", () => {
    expect(
      buildDedupeKey("polaris:ingest:dedupe", {
        projectId: "checkout",
        environment: "production",
        eventId: "evt-1",
        ttlSec: 60,
      }),
    ).toBe("polaris:ingest:dedupe:checkout:production:evt-1");
  });
});

describe("createRedisDedupeStore", () => {
  function makeClient(
    behavior: "ok" | "duplicate" | "error" | "timeout",
    held: string | null = "confirmed",
  ): RedisClientLike {
    let setCalls = 0;
    return {
      set: vi.fn(async () => {
        setCalls++;
        if (behavior === "ok") return "OK";
        if (behavior === "duplicate") return null;
        if (behavior === "timeout") return await new Promise(() => undefined);
        throw new Error(`redis test failure #${setCalls}`);
      }),
      // A null SET NX means an entry exists; its VALUE decides whether the
      // caller may say `duplicate` or must say `in_progress`.
      get: vi.fn(async () => held),
      del: vi.fn(async () => 1),
      quit: vi.fn(async () => undefined),
      on: vi.fn(),
    };
  }

  it("returns claimed on `OK`", async () => {
    const store = createRedisDedupeStore({
      client: makeClient("ok"),
      keyPrefix: "p",
      opTimeoutMs: 100,
      logger: SILENT,
    });
    expect(
      (await store.claim({ projectId: "x", environment: "y", eventId: "z", ttlSec: 60 })).status,
    ).toBe("claimed");
  });

  it("returns duplicate when SET NX returns null over a confirmed entry", async () => {
    const store = createRedisDedupeStore({
      client: makeClient("duplicate", "confirmed"),
      keyPrefix: "p",
      opTimeoutMs: 100,
      logger: SILENT,
    });
    expect(
      (await store.claim({ projectId: "x", environment: "y", eventId: "z", ttlSec: 60 })).status,
    ).toBe("duplicate");
  });

  it("returns in_progress when SET NX returns null over a pending lease", async () => {
    const store = createRedisDedupeStore({
      client: makeClient("duplicate", "pending"),
      keyPrefix: "p",
      opTimeoutMs: 100,
      logger: SILENT,
    });
    expect(
      (await store.claim({ projectId: "x", environment: "y", eventId: "z", ttlSec: 60 })).status,
    ).toBe("in_progress");
  });

  it("returns skipped (never throws) on backend error", async () => {
    const store = createRedisDedupeStore({
      client: makeClient("error"),
      keyPrefix: "p",
      opTimeoutMs: 100,
      logger: SILENT,
    });
    const outcome = await store.claim({
      projectId: "x",
      environment: "y",
      eventId: "z",
      ttlSec: 60,
    });
    expect(outcome.status).toBe("skipped");
  });

  it("returns skipped on op-timeout when Redis stalls", async () => {
    const store = createRedisDedupeStore({
      client: makeClient("timeout"),
      keyPrefix: "p",
      opTimeoutMs: 5,
      logger: SILENT,
    });
    const outcome = await store.claim({
      projectId: "x",
      environment: "y",
      eventId: "z",
      ttlSec: 60,
    });
    expect(outcome.status).toBe("skipped");
  });
});
