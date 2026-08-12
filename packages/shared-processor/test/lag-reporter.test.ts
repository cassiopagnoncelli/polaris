/**
 * Tests for timer-driven lag reporting.
 *
 * The property that matters: lag must keep climbing when messages STOP. A
 * gauge written on the message path cannot do that — it freezes at its last
 * value — and a frozen gauge makes a stalled partition indistinguishable from
 * a healthy idle one, which is the condition the alerts exist for.
 */
import { describe, expect, it } from "vitest";

import { createLagReporter } from "../src/lag-reporter.js";
import { METRIC_PROCESSOR_LAG_MS_LAST, ProcessorMetrics } from "../src/metrics.js";

const IDENTITY = { name: "sessionizer", version: "v1" } as const;

function manualScheduler() {
  const ticks: Array<() => void> = [];
  return {
    scheduler: {
      schedule: (cb: () => void) => {
        ticks.push(cb);
        return () => {};
      },
    },
    tick: () => {
      for (const fire of ticks) fire();
    },
  };
}

function lagValues(metrics: ProcessorMetrics): number[] {
  return metrics
    .getSamples()
    .filter((sample) => sample.name === METRIC_PROCESSOR_LAG_MS_LAST)
    .map((sample) => sample.value);
}

describe("createLagReporter", () => {
  it("keeps climbing while no new messages arrive", () => {
    // The whole reason this is a timer. One message at t=0, then silence.
    let clock = 10_000;
    const metrics = new ProcessorMetrics();
    const clockable = manualScheduler();
    const reporter = createLagReporter({
      metrics,
      identity: IDENTITY,
      scheduler: clockable.scheduler,
      now: () => clock,
    });

    reporter.observe({
      family: "raw.events",
      partition: 0,
      project_id: "storefront",
      environment: "development",
      ingestedAt: new Date(10_000).toISOString(),
    });

    clock = 15_000;
    clockable.tick();
    expect(lagValues(metrics)).toEqual([5_000]);

    // No further messages. A message-path gauge would still read 5000.
    clock = 45_000;
    clockable.tick();
    expect(lagValues(metrics)).toEqual([35_000]);
  });

  it("reports nothing for a partition that has never delivered a message", () => {
    // Zero would read as "perfectly current" on a panel, which is the
    // opposite of the truth for a partition nobody is consuming.
    const metrics = new ProcessorMetrics();
    const clockable = manualScheduler();
    createLagReporter({ metrics, identity: IDENTITY, scheduler: clockable.scheduler });
    clockable.tick();
    expect(lagValues(metrics)).toEqual([]);
  });

  it("tracks partitions independently", () => {
    const clock = 20_000;
    const metrics = new ProcessorMetrics();
    const clockable = manualScheduler();
    const reporter = createLagReporter({
      metrics,
      identity: IDENTITY,
      scheduler: clockable.scheduler,
      now: () => clock,
    });
    const base = {
      family: "raw.events",
      project_id: "storefront",
      environment: "development",
    };
    reporter.observe({ ...base, partition: 0, ingestedAt: new Date(19_000).toISOString() });
    reporter.observe({ ...base, partition: 1, ingestedAt: new Date(10_000).toISOString() });
    clockable.tick();
    expect(lagValues(metrics).sort((a, b) => a - b)).toEqual([1_000, 10_000]);
  });

  it("ignores an unparseable ingested_at rather than publishing NaN", () => {
    const metrics = new ProcessorMetrics();
    const clockable = manualScheduler();
    const reporter = createLagReporter({
      metrics,
      identity: IDENTITY,
      scheduler: clockable.scheduler,
    });
    reporter.observe({
      family: "raw.events",
      partition: 0,
      project_id: "storefront",
      environment: "development",
      ingestedAt: "not-a-timestamp",
    });
    clockable.tick();
    expect(lagValues(metrics)).toEqual([]);
  });

  it("never reports negative lag when a producer clock runs ahead", () => {
    const clock = 1_000;
    const metrics = new ProcessorMetrics();
    const clockable = manualScheduler();
    const reporter = createLagReporter({
      metrics,
      identity: IDENTITY,
      scheduler: clockable.scheduler,
      now: () => clock,
    });
    reporter.observe({
      family: "raw.events",
      partition: 0,
      project_id: "storefront",
      environment: "development",
      ingestedAt: new Date(9_000).toISOString(),
    });
    clockable.tick();
    expect(lagValues(metrics)).toEqual([0]);
  });
});
