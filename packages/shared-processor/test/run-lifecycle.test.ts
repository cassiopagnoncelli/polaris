/**
 * Tests for the processor run lifecycle wrapper.
 *
 * The policy under test is what every processor's `app.ts` relies on:
 *
 *   - the run id exists before the row does, so derived events can be
 *     stamped from the first message,
 *   - a control-plane database outage degrades the run record, never the
 *     data path,
 *   - a run that failed to register retries once at termination,
 *   - terminal calls are idempotent, so a shutdown error on top of a fatal
 *     error does not throw `InvalidRunTransitionError`,
 *   - final counters come from the metrics registry, summed across labels.
 */
import { describe, expect, it, vi } from "vitest";

import { ProcessorMetrics } from "../src/metrics.js";
import { readCounters, startProcessorRun } from "../src/run-lifecycle.js";
import {
  InMemoryProcessorRunRepository,
  type ProcessorRunRecord,
  type ProcessorRunRepository,
} from "../src/runs.js";

const IDENTITY = { name: "analytics-projector", version: "v1" } as const;
const FIXED_NOW = new Date("2026-05-12T12:00:00.000Z");

function fakeLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(),
  };
}

/** Repository whose every call rejects — stands in for an unreachable database. */
function brokenRepository(): ProcessorRunRepository {
  const boom = () => Promise.reject(new Error("ECONNREFUSED 127.0.0.1:5432"));
  return {
    registerRun: boom,
    updateRun: boom,
    completeRun: boom,
    failRun: boom,
    cancelRun: boom,
    findRun: boom,
  } as unknown as ProcessorRunRepository;
}

function start(overrides: Partial<Parameters<typeof startProcessorRun>[0]> = {}) {
  const repository = overrides.repository ?? new InMemoryProcessorRunRepository();
  const logger = fakeLogger();
  return {
    repository,
    logger,
    handle: startProcessorRun({
      repository,
      identity: IDENTITY,
      logger: logger as never,
      now: () => FIXED_NOW,
      ...overrides,
    }),
  };
}

describe("startProcessorRun", () => {
  it("registers the row under the run id it allocated", async () => {
    const repo = new InMemoryProcessorRunRepository();
    const handle = await startProcessorRun({
      repository: repo,
      identity: IDENTITY,
      environment: "development",
      host: "pod-7",
      logger: fakeLogger() as never,
      now: () => FIXED_NOW,
    });

    expect(handle.run_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(handle.registered).toBe(true);

    const row = await repo.findRun(handle.run_id);
    expect(row).not.toBeNull();
    expect(row?.status).toBe("running");
    expect(row?.processor_name).toBe("analytics-projector");
    expect(row?.environment).toBe("development");
    expect(row?.host).toBe("pod-7");
    expect(row?.started_at).toEqual(FIXED_NOW);
  });

  it.each([
    "local",
    "test",
  ])("records the run unscoped, and quietly, for the %s deployment label", async (label) => {
    // `processor_runs.environment` is CHECK-constrained to the control
    // plane's three environments. A bare-metal dev stack runs with
    // POLARIS_ENV=local; passing that through fails the INSERT, and since
    // registration is non-fatal the only symptom is a silently missing row.
    const repo = new InMemoryProcessorRunRepository();
    const logger = fakeLogger();
    const handle = await startProcessorRun({
      repository: repo,
      identity: IDENTITY,
      environment: label,
      logger: logger as never,
    });

    const row = await repo.findRun(handle.run_id);
    expect(row?.environment).toBeNull();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("warns when the deployment label is not an environment it recognises", async () => {
    const repo = new InMemoryProcessorRunRepository();
    const logger = fakeLogger();
    const handle = await startProcessorRun({
      repository: repo,
      identity: IDENTITY,
      environment: "prodution", // the typo this warning exists for
      logger: logger as never,
    });

    const row = await repo.findRun(handle.run_id);
    expect(row?.environment).toBeNull();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it.each(["development", "staging", "production"])("keeps the %s scope", async (env) => {
    const repo = new InMemoryProcessorRunRepository();
    const handle = await startProcessorRun({
      repository: repo,
      identity: IDENTITY,
      environment: env,
      logger: fakeLogger() as never,
    });
    const row = await repo.findRun(handle.run_id);
    expect(row?.environment).toBe(env);
  });

  it("still yields a stampable run id when the database is unreachable", async () => {
    const logger = fakeLogger();
    const handle = await startProcessorRun({
      repository: brokenRepository(),
      identity: IDENTITY,
      logger: logger as never,
    });

    // The data path must not care that the control plane is down.
    expect(handle.run_id.length).toBeGreaterThan(0);
    expect(handle.registered).toBe(false);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    // Never `synthetic:` — the id is a real UUIDv7 that a row can adopt later.
    expect(handle.run_id).not.toContain("synthetic");
  });

  it("yields a run id with no repository at all", async () => {
    const handle = await startProcessorRun({
      repository: undefined,
      identity: IDENTITY,
      logger: fakeLogger() as never,
    });
    expect(handle.registered).toBe(false);
    await expect(handle.complete()).resolves.toBeUndefined();
  });

  it("completes the run with counters summed across label tuples", async () => {
    const metrics = new ProcessorMetrics();
    const labels = { processor_name: IDENTITY.name, processor_version: IDENTITY.version };
    metrics.incrementConsumed({ ...labels, topic: "raw.events" });
    metrics.incrementConsumed({ ...labels, topic: "raw.events.storefront" });
    metrics.incrementEmitted({ ...labels, topic: "analytics.events" });

    const { repository, handle } = start({ metrics });
    const resolved = await handle;
    await resolved.complete();

    const row = (await (repository as InMemoryProcessorRunRepository).findRun(
      resolved.run_id,
    )) as ProcessorRunRecord;
    expect(row.status).toBe("completed");
    expect(row.finished_at).toEqual(FIXED_NOW);
    expect(row.events_consumed).toBe(2);
    expect(row.events_emitted).toBe(1);
    expect(row.events_failed).toBe(0);
  });

  it("fails the run with a truncated single-line error summary", async () => {
    const { repository, handle } = start();
    const resolved = await handle;
    await resolved.fail(new Error("consumer died\n  at frame one\n  at frame two"));

    const row = (await (repository as InMemoryProcessorRunRepository).findRun(
      resolved.run_id,
    )) as ProcessorRunRecord;
    expect(row.status).toBe("failed");
    expect(row.error_summary).toBe("Error: consumer died at frame one at frame two");
  });

  it("is idempotent across terminal calls", async () => {
    const { repository, handle } = start();
    const resolved = await handle;
    await resolved.fail(new Error("first cause"));
    // A shutdown task erroring after a fatal error must not throw
    // InvalidRunTransitionError on top of the original.
    await expect(resolved.complete()).resolves.toBeUndefined();

    const row = (await (repository as InMemoryProcessorRunRepository).findRun(
      resolved.run_id,
    )) as ProcessorRunRecord;
    expect(row.status).toBe("failed");
    expect(row.error_summary).toBe("Error: first cause");
  });

  it("retries registration at termination when boot-time registration failed", async () => {
    const inner = new InMemoryProcessorRunRepository();
    let allowRegister = false;
    const flaky: ProcessorRunRepository = {
      ...inner,
      registerRun: (input) =>
        allowRegister
          ? inner.registerRun(input)
          : Promise.reject(new Error("ECONNREFUSED 127.0.0.1:5432")),
      completeRun: (input) => inner.completeRun(input),
      failRun: (input) => inner.failRun(input),
      cancelRun: (input) => inner.cancelRun(input),
      updateRun: (input) => inner.updateRun(input),
      findRun: (id) => inner.findRun(id),
    };

    const handle = await startProcessorRun({
      repository: flaky,
      identity: IDENTITY,
      logger: fakeLogger() as never,
      now: () => FIXED_NOW,
    });
    expect(handle.registered).toBe(false);

    // Database comes back before shutdown.
    allowRegister = true;
    await handle.complete();

    const row = await inner.findRun(handle.run_id);
    expect(row?.status).toBe("completed");
    expect(row?.run_id).toBe(handle.run_id);
  });

  it("logs rather than throws when the row cannot be closed out", async () => {
    const inner = new InMemoryProcessorRunRepository();
    const logger = fakeLogger();
    const repository: ProcessorRunRepository = {
      ...inner,
      registerRun: (input) => inner.registerRun(input),
      completeRun: () => Promise.reject(new Error("connection terminated")),
      failRun: (input) => inner.failRun(input),
      cancelRun: (input) => inner.cancelRun(input),
      updateRun: (input) => inner.updateRun(input),
      findRun: (id) => inner.findRun(id),
    };

    const handle = await startProcessorRun({
      repository,
      identity: IDENTITY,
      logger: logger as never,
    });
    await expect(handle.complete()).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);

    // The row stays `running` — an operator seeing a stale run is the
    // documented outcome, not a crash on the shutdown path.
    const row = await inner.findRun(handle.run_id);
    expect(row?.status).toBe("running");
  });
});

describe("readCounters", () => {
  it("returns an empty object when no metrics registry is supplied", () => {
    expect(readCounters(undefined)).toEqual({});
  });

  it("reports zeroes for counters that never incremented", () => {
    expect(readCounters(new ProcessorMetrics())).toEqual({
      events_consumed: 0,
      events_emitted: 0,
      events_failed: 0,
    });
  });

  it("ignores metrics that are not the three run counters", () => {
    const metrics = new ProcessorMetrics();
    const labels = { processor_name: IDENTITY.name, processor_version: IDENTITY.version };
    metrics.incrementDlq({ ...labels, topic: "raw.events", reason: "invalid_payload" });
    metrics.incrementRetry({ ...labels, topic: "raw.events", reason: "broker_unavailable" });
    expect(readCounters(metrics)).toEqual({
      events_consumed: 0,
      events_emitted: 0,
      events_failed: 0,
    });
  });
});
