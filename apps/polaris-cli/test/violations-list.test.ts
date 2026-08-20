import type { ListViolationsFilter, ViolationRow } from "@polaris/persistence-clickhouse";
import { describe, expect, it } from "vitest";

import {
  buildViolationsListRunner,
  type CommandContext,
  type OutputStreams,
  UsageError,
} from "../src/index.js";

function capture(): { streams: OutputStreams; stdout: string[] } {
  const stdout: string[] = [];
  return {
    streams: {
      writeOut: (text) => {
        stdout.push(text);
      },
      writeErr: () => {},
    },
    stdout,
  };
}

function makeContext(streams: OutputStreams, format: "human" | "json" = "json"): CommandContext {
  const noop = () => {};
  return {
    config: {
      profile: "default",
      apiUrl: "https://polaris.example.internal",
      token: "polaris_ot_test",
      tokenEnvName: "POLARIS_TOKEN",
      output: format,
      logLevel: "warn",
      configFilePath: undefined,
    },
    logger: {
      fatal: noop,
      error: noop,
      warn: noop,
      info: noop,
      debug: noop,
      trace: noop,
    } as unknown as CommandContext["logger"],
    output: streams,
    env: {},
    actor: { source: "cli", label: "tester" },
  } as unknown as CommandContext;
}

function row(overrides: Partial<ViolationRow> = {}): ViolationRow {
  return {
    violation_id: "polaris_vio_1",
    project_id: "storefront",
    environment: "production",
    event: "purchase",
    event_id: "018f1b9e-7b50-7b12-9a2e-0e2f88d8f551",
    reason: "forbidden_field_rejected",
    paths: ["properties.cvv"],
    redacted_sample: '{"properties":{"cvv":"[REDACTED:pii_card]"}}',
    received_at: "2026-08-15T12:00:00.000Z",
    ...overrides,
  };
}

function storeReturning(rows: readonly ViolationRow[]) {
  const filters: ListViolationsFilter[] = [];
  let closed = 0;
  return {
    filters,
    closedCount: () => closed,
    open: () => ({
      list: async (filter: ListViolationsFilter) => {
        filters.push(filter);
        return rows;
      },
      summarise: async (filter: ListViolationsFilter) => {
        filters.push(filter);
        return [{ reason: "forbidden_field_rejected", event: "purchase", violations: 12 }];
      },
      close: async () => {
        closed += 1;
      },
    }),
  };
}

describe("polaris violations list", () => {
  it("lists a project's quarantined rejections", async () => {
    const store = storeReturning([row()]);
    const cap = capture();
    const runner = buildViolationsListRunner({ openStore: store.open });

    await runner({ project: "storefront" }, makeContext(cap.streams));

    const parsed = JSON.parse(cap.stdout.join("")) as { count: number; violations: ViolationRow[] };
    expect(parsed.count).toBe(1);
    expect(parsed.violations[0]?.reason).toBe("forbidden_field_rejected");
    expect(store.closedCount()).toBe(1);
  });

  it("passes every filter through to the reader", async () => {
    const store = storeReturning([]);
    const cap = capture();
    const runner = buildViolationsListRunner({ openStore: store.open });

    await runner(
      {
        project: "storefront",
        env: "production",
        since: "2026-08-01T00:00:00Z",
        until: "2026-08-15T00:00:00Z",
        reason: "unknown_event",
        event: "purchase",
        limit: "50",
      },
      makeContext(cap.streams),
    );

    expect(store.filters[0]).toEqual({
      projectId: "storefront",
      environment: "production",
      since: new Date("2026-08-01T00:00:00Z"),
      until: new Date("2026-08-15T00:00:00Z"),
      reason: "unknown_event",
      event: "purchase",
      limit: 50,
    });
  });

  it("summarises instead of listing when asked", async () => {
    const store = storeReturning([row()]);
    const cap = capture();
    const runner = buildViolationsListRunner({ openStore: store.open });

    await runner({ project: "storefront", summary: true }, makeContext(cap.streams));

    const parsed = JSON.parse(cap.stdout.join("")) as { total: number };
    expect(parsed.total).toBe(12);
  });

  it("refuses a missing project", async () => {
    const runner = buildViolationsListRunner({ openStore: storeReturning([]).open });
    await expect(runner({}, makeContext(capture().streams))).rejects.toBeInstanceOf(UsageError);
  });

  it("refuses a limit above the cap, and says what to do instead", async () => {
    // An unbounded read of a quarantine under a broken deployment is how
    // an operator diagnosing an incident causes a second one.
    const runner = buildViolationsListRunner({ openStore: storeReturning([]).open });
    await expect(
      runner({ project: "storefront", limit: "5000" }, makeContext(capture().streams)),
    ).rejects.toThrow(/--summary/);
  });

  it("refuses an inverted window", async () => {
    const runner = buildViolationsListRunner({ openStore: storeReturning([]).open });
    await expect(
      runner(
        { project: "storefront", since: "2026-08-15T00:00:00Z", until: "2026-08-01T00:00:00Z" },
        makeContext(capture().streams),
      ),
    ).rejects.toThrow(/must be at or after/);
  });

  it("refuses an unparseable timestamp", async () => {
    const runner = buildViolationsListRunner({ openStore: storeReturning([]).open });
    await expect(
      runner({ project: "storefront", since: "last tuesday" }, makeContext(capture().streams)),
    ).rejects.toThrow(/ISO-8601/);
  });

  it("closes the store even when the read throws", async () => {
    // A leaked ClickHouse client per failed invocation is how a cron that
    // runs every minute exhausts a connection pool overnight.
    let closed = 0;
    const runner = buildViolationsListRunner({
      openStore: () => ({
        list: async () => {
          throw new Error("clickhouse unavailable");
        },
        summarise: async () => [],
        close: async () => {
          closed += 1;
        },
      }),
    });

    await expect(runner({ project: "storefront" }, makeContext(capture().streams))).rejects.toThrow(
      /clickhouse unavailable/,
    );
    expect(closed).toBe(1);
  });

  it("says so plainly when a project has no violations", async () => {
    const cap = capture();
    const runner = buildViolationsListRunner({ openStore: storeReturning([]).open });

    await runner({ project: "storefront" }, makeContext(cap.streams, "human"));

    expect(cap.stdout.join("")).toContain("no quarantined violations for storefront");
  });
});
