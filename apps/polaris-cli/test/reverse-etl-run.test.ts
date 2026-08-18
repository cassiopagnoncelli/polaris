import type { IngestBatchResult } from "@polaris/processor-reverse-etl-v1";
import type { ReverseEtlRow } from "@polaris/reverse-etl-catalog";
import { describe, expect, it } from "vitest";

import {
  buildReverseEtlRunRunner,
  type CommandContext,
  type OutputStreams,
  UsageError,
} from "../src/index.js";

function capture(): { streams: OutputStreams; stdout: string[] } {
  const stdout: string[] = [];
  return {
    streams: { writeOut: (t) => stdout.push(t), writeErr: () => {} },
    stdout,
  };
}

function makeContext(streams: OutputStreams, format: "human" | "json" = "json"): CommandContext {
  const noop = () => {};
  return {
    config: { profile: "default", output: format, logLevel: "warn" },
    logger: { fatal: noop, error: noop, warn: noop, info: noop, debug: noop, trace: noop },
    output: streams,
    env: {},
    actor: { source: "cli", label: "tester" },
  } as unknown as CommandContext;
}

const ARGS = { job: "ltv_writeback", project: "storefront", env: "production" };

function hooks(rows: readonly ReverseEtlRow[], ingestResult?: Partial<IngestBatchResult>) {
  const sent: Array<readonly Record<string, unknown>[]> = [];
  let closed = 0;
  return {
    sent,
    closedCount: () => closed,
    value: {
      query: () => ({
        run: async () => rows,
        close: async () => {
          closed += 1;
        },
      }),
      ingest: () => ({
        send: async (events: readonly Record<string, unknown>[]) => {
          sent.push([...events]);
          return {
            accepted: ingestResult?.accepted ?? events.length,
            rejected: ingestResult?.rejected ?? 0,
            rejectedReasons: ingestResult?.rejectedReasons ?? [],
          };
        },
      }),
      now: () => new Date("2026-08-17T03:00:00.000Z"),
      generateRunId: () => "polaris_rtl_1",
    },
  };
}

describe("polaris reverse-etl run", () => {
  it("maps rows to internal-sourced events and posts them", async () => {
    const h = hooks([{ customer_id: "cus_1", lifetime_orders: 4 }]);
    const cap = capture();

    await buildReverseEtlRunRunner(h.value)(ARGS, makeContext(cap.streams));

    expect(h.sent[0]).toHaveLength(1);
    const event = h.sent[0]?.[0] as Record<string, unknown>;
    expect(event["event"]).toBe("user.identified");
    expect(event["source"]).toEqual({ id: "reverse-etl/ltv_writeback", type: "internal" });
    expect(event["identity"]).toEqual({ customer_id: "cus_1" });
    expect(event["properties"]).toEqual({ lifetime_orders: 4 });
    expect(h.closedCount()).toBe(1);
  });

  it("derives a stable event id, so a rerun over unchanged rows is absorbed", async () => {
    // What makes an hourly cron over a slow-moving aggregate free.
    const rows = [{ customer_id: "cus_1", lifetime_orders: 4 }];
    const first = hooks(rows);
    await buildReverseEtlRunRunner(first.value)(ARGS, makeContext(capture().streams));
    const second = hooks(rows);
    await buildReverseEtlRunRunner(second.value)(ARGS, makeContext(capture().streams));

    expect(first.sent[0]?.[0]?.["event_id"]).toBe(second.sent[0]?.[0]?.["event_id"]);
  });

  it("does not let property ORDER change the id", async () => {
    // A mapping that built its object differently on two runs — a spread,
    // a conditional field — would otherwise defeat the dedupe entirely.
    const a = hooks([{ customer_id: "cus_1", lifetime_orders: 4 }]);
    await buildReverseEtlRunRunner(a.value)(ARGS, makeContext(capture().streams));
    const idA = a.sent[0]?.[0]?.["event_id"];

    const b = hooks([{ lifetime_orders: 4, customer_id: "cus_1" }]);
    await buildReverseEtlRunRunner(b.value)(ARGS, makeContext(capture().streams));

    expect(b.sent[0]?.[0]?.["event_id"]).toBe(idA);
  });

  it("exits non-zero when the ingester rejected anything", async () => {
    // A nightly writeback that exits 0 having had every event refused is
    // a trait that silently stopped updating.
    const h = hooks([{ customer_id: "cus_1", lifetime_orders: 4 }], {
      accepted: 0,
      rejected: 1,
      rejectedReasons: ["forbidden_field_rejected"],
    });

    await expect(
      buildReverseEtlRunRunner(h.value)(ARGS, makeContext(capture().streams)),
    ).rejects.toThrow(/forbidden_field_rejected/);
  });

  it("names the registry for an unknown job", async () => {
    // A typo and an unshipped job look identical otherwise.
    const h = hooks([]);
    await expect(
      buildReverseEtlRunRunner(h.value)(
        { ...ARGS, job: "ltv_writebck" },
        makeContext(capture().streams),
      ),
    ).rejects.toThrow(/Registered: ltv_writeback/);
  });

  it("refuses when no query or ingest client is configured", async () => {
    // The registration-with-no-hooks shape this repo has shipped twice.
    // Refusing beats a run that reads nothing, posts nothing and exits 0.
    await expect(buildReverseEtlRunRunner()(ARGS, makeContext(capture().streams))).rejects.toThrow(
      /no query or ingest client configured/,
    );
  });

  it("closes the query reader even when the run throws", async () => {
    let closed = 0;
    const runner = buildReverseEtlRunRunner({
      query: () => ({
        run: async () => {
          throw new Error("clickhouse unavailable");
        },
        close: async () => {
          closed += 1;
        },
      }),
      ingest: () => ({ send: async () => ({ accepted: 0, rejected: 0, rejectedReasons: [] }) }),
    });

    await expect(runner(ARGS, makeContext(capture().streams))).rejects.toThrow(/clickhouse/);
    expect(closed).toBe(1);
  });

  it("refuses a batch size outside the ingester's ceiling", async () => {
    const h = hooks([]);
    await expect(
      buildReverseEtlRunRunner(h.value)(
        { ...ARGS, batchSize: "5000" },
        makeContext(capture().streams),
      ),
    ).rejects.toThrow(/between 1 and 1000/);
  });

  it("requires the scope flags", async () => {
    const h = hooks([]);
    for (const args of [
      { job: "ltv_writeback", env: "production" },
      { job: "ltv_writeback", project: "s" },
    ]) {
      await expect(
        buildReverseEtlRunRunner(h.value)(args, makeContext(capture().streams)),
      ).rejects.toBeInstanceOf(UsageError);
    }
  });
});
