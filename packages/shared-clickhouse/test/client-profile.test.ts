import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the underlying @clickhouse/client `createClient`. Every test gets a
// fresh mock client so we can assert on what the package called.

const queryMock = vi.fn();
const closeMock = vi.fn();

vi.mock("@clickhouse/client", async () => {
  return {
    createClient: () => ({
      query: queryMock,
      close: closeMock,
    }),
    // The package imports `ClickHouseClient` (a re-export of
    // `NodeClickHouseClient`) for typing. Provide a class stub so the
    // value import in `client.ts` resolves at module-evaluation time.
    ClickHouseClient: class {},
  };
});

import {
  ClickHouseConfigError,
  ClickHouseEscapeHatchUnauthorizedError,
  createClickHouseClient,
  ESCAPE_HATCH_METRIC,
} from "../src/index.js";

function setQueryRows(rows: Array<Record<string, unknown>>): void {
  queryMock.mockResolvedValue({
    json: vi.fn().mockResolvedValue(rows),
  });
}

beforeEach(() => {
  queryMock.mockReset();
  closeMock.mockReset();
});

describe("createClickHouseClient: role guard", () => {
  it("constructs a service client", () => {
    const client = createClickHouseClient({
      url: "http://localhost:8123",
      role: "service",
      credential: { username: "polaris_service", password: "p" },
    });
    expect(client.role).toBe("service");
    expect(client.projections).toBeDefined();
    expect(client.ingestLog).toBeDefined();
    expect(client.health).toBeDefined();
  });

  it("constructs an operator client", () => {
    const client = createClickHouseClient({
      url: "http://localhost:8123",
      role: "operator",
      credential: { username: "polaris_operator", password: "p" },
    });
    expect(client.role).toBe("operator");
    expect(client.replay).toBeDefined();
    expect(client.raw).toBeDefined();
    expect(client.probes).toBeDefined();
  });

  it("refuses to construct without a declared role", () => {
    expect(() =>
      createClickHouseClient({
        url: "http://localhost:8123",
        // biome-ignore lint/suspicious/noExplicitAny: deliberately type-erased to test the runtime guard.
        role: undefined as any,
        credential: { username: "polaris_service", password: "p" },
      }),
    ).toThrow(ClickHouseConfigError);
  });

  it("refuses to construct with an unknown role", () => {
    expect(() =>
      createClickHouseClient({
        url: "http://localhost:8123",
        // biome-ignore lint/suspicious/noExplicitAny: testing the guard.
        role: "admin" as any,
        credential: { username: "polaris_service", password: "p" },
      }),
    ).toThrow(ClickHouseConfigError);
  });
});

describe("service profile: no analytics_raw surface", () => {
  it("does not expose `replay`, `raw`, or `probes` namespaces", () => {
    const client = createClickHouseClient({
      url: "http://localhost:8123",
      role: "service",
      credential: { username: "polaris_service", password: "p" },
    });
    expect((client as unknown as Record<string, unknown>).replay).toBeUndefined();
    expect((client as unknown as Record<string, unknown>).raw).toBeUndefined();
    expect((client as unknown as Record<string, unknown>).probes).toBeUndefined();
  });

  it("never queries analytics_raw across all service-profile readers", async () => {
    setQueryRows([]);

    const client = createClickHouseClient({
      url: "http://localhost:8123",
      role: "service",
      credential: { username: "polaris_service", password: "p" },
    });

    await client.health.check();
    await client.ingestLog.inspect({ projectId: "p" });
    await client.projections.eventDailyCounts.read({
      projectId: "p",
      fromDate: "2026-05-01",
    });

    // Inspect every SQL string passed to the underlying client; none should
    // mention analytics_raw on the service profile.
    for (const call of queryMock.mock.calls) {
      const sql = String(call[0].query);
      expect(sql).not.toMatch(/analytics_raw/);
      expect(sql).not.toMatch(/\bFINAL\b/i);
    }
  });
});

describe("operator profile: replay reader executes argMax SQL", () => {
  it("argMaxByEventKey runs SQL that contains argMax and GROUP BY and no FINAL", async () => {
    setQueryRows([
      {
        project_id: "storefront",
        environment: "production",
        event: "checkout.completed",
        event_id: "abc",
      },
    ]);

    const client = createClickHouseClient({
      url: "http://localhost:8123",
      role: "operator",
      credential: { username: "polaris_operator", password: "p" },
    });

    await client.replay.argMaxByEventKey({
      projectId: "storefront",
      environment: "production",
      event: "checkout.completed",
      eventIds: ["abc"],
    });

    expect(queryMock).toHaveBeenCalledTimes(1);
    const sql = String(queryMock.mock.calls[0]?.[0].query);
    expect(sql).toMatch(/argMax\(\w+,\s*_version\)/);
    expect(sql).toMatch(/GROUP BY \(project_id,\s*environment,\s*event,\s*event_id\)/);
    expect(sql).not.toMatch(/\bFINAL\b/i);
    expect(sql).toMatch(/FROM\s+polaris\.analytics_raw/);
  });

  it("countDistinctEvents runs SQL that uses count(DISTINCT event_id) and no FINAL", async () => {
    setQueryRows([{ distinct: "42" }]);

    const client = createClickHouseClient({
      url: "http://localhost:8123",
      role: "operator",
      credential: { username: "polaris_operator", password: "p" },
    });

    const count = await client.replay.countDistinctEvents({
      projectId: "storefront",
      environment: "production",
      occurredFrom: "2026-05-01T00:00:00Z",
      occurredTo: "2026-05-02T00:00:00Z",
    });

    expect(count).toBe(42);
    const sql = String(queryMock.mock.calls[0]?.[0].query);
    expect(sql).toMatch(/count\(DISTINCT\s+event_id\)/i);
    expect(sql).not.toMatch(/\bFINAL\b/i);
  });
});

describe("operator profile: escape hatch is observable", () => {
  it("emits the escape-hatch metric on every call", async () => {
    setQueryRows([]);

    const metrics = { incrementCounter: vi.fn() };
    const logger = makeMockLogger();

    const client = createClickHouseClient({
      url: "http://localhost:8123",
      role: "operator",
      credential: { username: "polaris_operator", password: "p" },
      metrics,
      logger,
    });

    await client.raw.query(
      "SELECT count() FROM polaris.analytics_raw",
      {},
      {
        caller: "polaris-cli:replay-inspect",
        reason: "Incident #1234: count by partition",
      },
    );

    expect(metrics.incrementCounter).toHaveBeenCalledTimes(1);
    expect(metrics.incrementCounter).toHaveBeenCalledWith(ESCAPE_HATCH_METRIC, {
      caller: "polaris-cli:replay-inspect",
    });
  });

  it("emits a structured log line on every call", async () => {
    setQueryRows([{ count: "0" }]);

    const logger = makeMockLogger();

    const client = createClickHouseClient({
      url: "http://localhost:8123",
      role: "operator",
      credential: { username: "polaris_operator", password: "p" },
      logger,
    });

    await client.raw.query(
      "SELECT 1",
      {},
      {
        caller: "polaris-cli:smoke",
        reason: "smoke test",
        ticket: "TICKET-42",
      },
    );

    // The escape-hatch invocation always emits at least one `info` line with
    // event `clickhouse.operator.raw.query`.
    const invocation = logger.info.mock.calls.find(
      ([obj]) =>
        typeof obj === "object" &&
        obj !== null &&
        (obj as Record<string, unknown>).event === "clickhouse.operator.raw.query",
    );
    expect(invocation).toBeDefined();
    const payload = invocation?.[0] as Record<string, unknown>;
    expect(payload.caller).toBe("polaris-cli:smoke");
    expect(payload.reason).toBe("smoke test");
    expect(payload.ticket).toBe("TICKET-42");
    expect(typeof payload.queryDigest).toBe("string");
  });

  it("emits a metric even when the query fails", async () => {
    queryMock.mockRejectedValueOnce(new Error("boom"));

    const metrics = { incrementCounter: vi.fn() };
    const logger = makeMockLogger();

    const client = createClickHouseClient({
      url: "http://localhost:8123",
      role: "operator",
      credential: { username: "polaris_operator", password: "p" },
      metrics,
      logger,
    });

    await expect(
      client.raw.query(
        "SELECT 1",
        {},
        {
          caller: "polaris-cli:smoke",
          reason: "failure-path test",
        },
      ),
    ).rejects.toThrow();

    expect(metrics.incrementCounter).toHaveBeenCalledTimes(1);
  });

  it("refuses to run without `caller`", async () => {
    const client = createClickHouseClient({
      url: "http://localhost:8123",
      role: "operator",
      credential: { username: "polaris_operator", password: "p" },
    });

    await expect(
      client.raw.query(
        "SELECT 1",
        {},
        {
          caller: "",
          reason: "missing caller",
        },
      ),
    ).rejects.toBeInstanceOf(ClickHouseEscapeHatchUnauthorizedError);
  });

  it("refuses to run without `reason`", async () => {
    const client = createClickHouseClient({
      url: "http://localhost:8123",
      role: "operator",
      credential: { username: "polaris_operator", password: "p" },
    });

    await expect(
      client.raw.query(
        "SELECT 1",
        {},
        {
          caller: "polaris-cli",
          reason: "",
        },
      ),
    ).rejects.toBeInstanceOf(ClickHouseEscapeHatchUnauthorizedError);
  });
});

describe("operator profile: ClickHouse health probes", () => {
  it("partsSummary issues a system.parts query and decodes rows", async () => {
    setQueryRows([
      { database: "polaris", table: "analytics_raw", parts: 142, bytes_on_disk: "987654321" },
      { database: "polaris", table: "event_daily_counts", parts: 7, bytes_on_disk: "1234" },
    ]);

    const client = createClickHouseClient({
      url: "http://localhost:8123",
      role: "operator",
      credential: { username: "polaris_operator", password: "p" },
    });

    const rows = await client.probes.partsSummary();
    expect(queryMock).toHaveBeenCalledTimes(1);
    const sql = String(queryMock.mock.calls[0]?.[0].query);
    expect(sql).toMatch(/FROM\s+system\.parts/);
    expect(rows).toEqual([
      { database: "polaris", table: "analytics_raw", parts: 142, bytes_on_disk: "987654321" },
      { database: "polaris", table: "event_daily_counts", parts: 7, bytes_on_disk: "1234" },
    ]);
  });

  it("materializedViewStates issues a system.view_refreshes query and decodes rows", async () => {
    setQueryRows([
      {
        database: "polaris",
        view: "mv_raw_to_event_daily_counts",
        state: "Running",
        last_exception: "",
      },
      { database: "polaris", view: "mv_broken", state: "failed", last_exception: "Cannot insert" },
    ]);

    const client = createClickHouseClient({
      url: "http://localhost:8123",
      role: "operator",
      credential: { username: "polaris_operator", password: "p" },
    });

    const rows = await client.probes.materializedViewStates();
    const sql = String(queryMock.mock.calls[0]?.[0].query);
    expect(sql).toMatch(/FROM\s+system\.view_refreshes/);
    expect(rows).toEqual([
      {
        database: "polaris",
        view: "mv_raw_to_event_daily_counts",
        state: "Running",
        last_exception: "",
      },
      {
        database: "polaris",
        view: "mv_broken",
        state: "failed",
        last_exception: "Cannot insert",
      },
    ]);
  });

  it("rejects an out-of-range limit", async () => {
    const client = createClickHouseClient({
      url: "http://localhost:8123",
      role: "operator",
      credential: { username: "polaris_operator", password: "p" },
    });
    await expect(client.probes.partsSummary({ limit: 0 })).rejects.toThrow(
      /limit must be an integer/,
    );
    await expect(client.probes.partsSummary({ limit: 10_001 })).rejects.toThrow(
      /limit must be an integer/,
    );
  });
});

describe("client.close()", () => {
  it("calls the underlying close exactly once", async () => {
    const client = createClickHouseClient({
      url: "http://localhost:8123",
      role: "service",
      credential: { username: "polaris_service", password: "p" },
    });

    await client.close();
    await client.close();
    expect(closeMock).toHaveBeenCalledTimes(1);
  });
});

function makeMockLogger() {
  const logger = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  };
  logger.child.mockReturnValue(logger);
  return logger;
}
