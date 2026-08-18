/**
 * Behavioural tests for the ClickHouse probe metric registry and the
 * probe poller. Tests use synthetic probe responses to exercise the
 * label-tuple bookkeeping and the failure-handling path without
 * touching a real ClickHouse cluster.
 */
import type {
  ClickHouseHealthProbes,
  MaterializedViewStateRow,
  PartsHealthRow,
} from "@polaris/shared-clickhouse";
import { createLogger } from "@polaris/shared-logger";
import { describe, expect, it, vi } from "vitest";

import {
  ClickHouseProbeMetrics,
  METRIC_CLICKHOUSE_MV_STATE,
} from "../src/clickhouse-probe-metrics.js";
import { createClickHouseProbePoller } from "../src/clickhouse-probe-poller.js";

const SILENT_LOGGER = createLogger({
  service: "analytics-projector-test",
  version: "0.0.0",
  env: "test",
});

function makeProbes(input: {
  readonly mv?: ReadonlyArray<MaterializedViewStateRow>;
  readonly parts?: ReadonlyArray<PartsHealthRow>;
  readonly mvThrows?: Error;
}): ClickHouseHealthProbes {
  return {
    async materializedViewStates() {
      if (input.mvThrows) throw input.mvThrows;
      return [...(input.mv ?? [])];
    },
    async partsSummary() {
      return [...(input.parts ?? [])];
    },
  };
}

describe("ClickHouseProbeMetrics", () => {
  it("records MV-state samples and clears stale tuples", () => {
    const metrics = new ClickHouseProbeMetrics();
    metrics.observeMaterializedViewState(
      { database: "polaris", view: "mv_sessions", state: "running" },
      1,
    );
    expect(metrics.getSamples()).toHaveLength(1);

    metrics.clear(METRIC_CLICKHOUSE_MV_STATE);
    expect(metrics.getSamples()).toHaveLength(0);
  });

  it("upserts the same label tuple in place", () => {
    const metrics = new ClickHouseProbeMetrics();
    const labels = { database: "polaris", view: "mv_sessions", state: "running" };
    metrics.observeMaterializedViewState(labels, 0);
    metrics.observeMaterializedViewState(labels, 1);
    const samples = metrics.getSamples();
    expect(samples).toHaveLength(1);
    expect(samples[0]?.value).toBe(1);
  });
});

describe("createClickHouseProbePoller", () => {
  it("translates probe rows into Polaris gauges on each tick", async () => {
    const metrics = new ClickHouseProbeMetrics();
    const probes = makeProbes({
      mv: [
        {
          database: "polaris",
          view: "mv_sessions",
          state: "running",
          last_exception: "",
        },
        {
          database: "polaris",
          view: "mv_attribution",
          state: "failed",
          last_exception: "table not found",
        },
      ],
    });
    const poller = createClickHouseProbePoller({
      probes,
      metrics,
      logger: SILENT_LOGGER,
    });
    await poller.tick();

    const samples = metrics.getSamples();
    const mvs = samples.filter((s) => s.name === METRIC_CLICKHOUSE_MV_STATE);
    expect(mvs).toHaveLength(2);
    expect(mvs.find((s) => s.labels["state"] === "failed")).toBeDefined();
  });

  it("clears stale tuples between ticks (vanished views disappear)", async () => {
    const metrics = new ClickHouseProbeMetrics();
    let mv: ReadonlyArray<MaterializedViewStateRow> = [
      { database: "polaris", view: "mv_old", state: "running", last_exception: "" },
    ];
    const probes: ClickHouseHealthProbes = {
      async materializedViewStates() {
        return [...mv];
      },
      async partsSummary() {
        return [];
      },
    };
    const poller = createClickHouseProbePoller({ probes, metrics, logger: SILENT_LOGGER });
    await poller.tick();
    expect(metrics.getSamples()).toHaveLength(1);

    // Next tick: mv_old has been dropped; mv_new appears.
    mv = [{ database: "polaris", view: "mv_new", state: "running", last_exception: "" }];
    await poller.tick();
    const samples = metrics.getSamples();
    expect(samples).toHaveLength(1);
    expect(samples[0]?.labels["view"]).toBe("mv_new");
  });

  it("logs a warn on first failure and an error after sustained failure", async () => {
    const warn = vi.fn();
    const error = vi.fn();
    const logger = {
      ...SILENT_LOGGER,
      warn,
      error,
      child: () => SILENT_LOGGER,
    } as unknown as Parameters<typeof createClickHouseProbePoller>[0]["logger"];
    const metrics = new ClickHouseProbeMetrics();
    const probes = makeProbes({ mvThrows: new Error("boom") });
    const poller = createClickHouseProbePoller({ probes, metrics, logger });

    await poller.tick();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(0);

    await poller.tick();
    await poller.tick();
    expect(error).toHaveBeenCalled();
  });
});
