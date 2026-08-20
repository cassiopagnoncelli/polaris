/**
 * Tests for processor run registration.
 *
 * Exercises the `InMemoryProcessorRunRepository` adapter:
 *
 *   - registerRun stamps a UUIDv7 run id and persists initial counters,
 *   - updateRun increments counters without changing the status,
 *   - completeRun / failRun / cancelRun set the terminal status and
 *     finished_at,
 *   - terminal statuses are immutable (InvalidRunTransitionError),
 *   - run id can be pre-allocated by the caller (replay tooling needs this).
 */
import { describe, expect, it } from "vitest";

import { InMemoryProcessorRunRepository, InvalidRunTransitionError } from "../src/runs.js";

const FIXED_NOW = new Date("2026-05-12T12:00:00.000Z");
const fixedNow = (): Date => FIXED_NOW;

function newRepo(): InMemoryProcessorRunRepository {
  return new InMemoryProcessorRunRepository({ now: fixedNow });
}

describe("InMemoryProcessorRunRepository.registerRun", () => {
  it("creates a row with the running status, zero counters, and an allocated run id", async () => {
    const repo = newRepo();
    const record = await repo.registerRun({
      processor_name: "analytics-projector",
      processor_version: "v1",
      host: "pod-1",
    });
    expect(record.status).toBe("running");
    expect(record.run_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(record.events_consumed).toBe(0);
    expect(record.events_emitted).toBe(0);
    expect(record.events_failed).toBe(0);
    expect(record.last_offset).toBeNull();
    expect(record.finished_at).toBeNull();
    expect(record.error_summary).toBeNull();
    expect(record.host).toBe("pod-1");
    expect(record.started_at.getTime()).toBe(FIXED_NOW.getTime());
  });

  it("accepts an explicit run id (escape hatch for replay tooling)", async () => {
    const repo = newRepo();
    const explicit = "018f1b9e-7b50-7b12-9a2e-0e2f88d8f552";
    const record = await repo.registerRun({
      processor_name: "analytics-projector",
      processor_version: "v1",
      run_id: explicit,
    });
    expect(record.run_id).toBe(explicit);
  });

  it("scopes by (project_id, environment) when provided", async () => {
    const repo = newRepo();
    const record = await repo.registerRun({
      processor_name: "geoip-enricher",
      processor_version: "v1",
      project_id: "checkout",
      environment: "production",
    });
    expect(record.project_id).toBe("checkout");
    expect(record.environment).toBe("production");
  });

  it("leaves scope columns null when unscoped (cross-project processors)", async () => {
    const repo = newRepo();
    const record = await repo.registerRun({
      processor_name: "analytics-projector",
      processor_version: "v1",
    });
    expect(record.project_id).toBeNull();
    expect(record.environment).toBeNull();
  });
});

describe("InMemoryProcessorRunRepository.updateRun", () => {
  it("increments counters without changing the status", async () => {
    const repo = newRepo();
    const initial = await repo.registerRun({
      processor_name: "analytics-projector",
      processor_version: "v1",
    });
    const updated = await repo.updateRun({
      run_id: initial.run_id,
      events_consumed: 100,
      events_emitted: 99,
      events_failed: 1,
      last_offset: 4200n,
    });
    expect(updated.status).toBe("running");
    expect(updated.events_consumed).toBe(100);
    expect(updated.events_emitted).toBe(99);
    expect(updated.events_failed).toBe(1);
    expect(updated.last_offset).toBe(4200n);
  });

  it("normalises last_offset from number, bigint, and string", async () => {
    const repo = newRepo();
    const initial = await repo.registerRun({
      processor_name: "analytics-projector",
      processor_version: "v1",
    });
    const a = await repo.updateRun({ run_id: initial.run_id, last_offset: 100 });
    expect(a.last_offset).toBe(100n);
    const b = await repo.updateRun({ run_id: initial.run_id, last_offset: 200n });
    expect(b.last_offset).toBe(200n);
    const c = await repo.updateRun({ run_id: initial.run_id, last_offset: "9223372036854775000" });
    expect(c.last_offset).toBe(9223372036854775000n);
  });

  it("throws when run id is unknown", async () => {
    const repo = newRepo();
    await expect(repo.updateRun({ run_id: "unknown" })).rejects.toThrow(/unknown processor run id/);
  });
});

describe("InMemoryProcessorRunRepository terminal transitions", () => {
  it("completeRun stamps finished_at and the completed status", async () => {
    const repo = newRepo();
    const initial = await repo.registerRun({
      processor_name: "analytics-projector",
      processor_version: "v1",
    });
    const completed = await repo.completeRun({
      run_id: initial.run_id,
      events_consumed: 10,
      events_emitted: 10,
    });
    expect(completed.status).toBe("completed");
    expect(completed.finished_at?.getTime()).toBe(FIXED_NOW.getTime());
    expect(completed.events_consumed).toBe(10);
    expect(completed.events_emitted).toBe(10);
    expect(completed.error_summary).toBeNull();
  });

  it("failRun records the error summary and the failed status", async () => {
    const repo = newRepo();
    const initial = await repo.registerRun({
      processor_name: "analytics-projector",
      processor_version: "v1",
    });
    const failed = await repo.failRun({
      run_id: initial.run_id,
      error_summary: "broker unreachable",
      events_failed: 5,
    });
    expect(failed.status).toBe("failed");
    expect(failed.error_summary).toBe("broker unreachable");
    expect(failed.events_failed).toBe(5);
    expect(failed.finished_at?.getTime()).toBe(FIXED_NOW.getTime());
  });

  it("cancelRun records an optional reason and the cancelled status", async () => {
    const repo = newRepo();
    const initial = await repo.registerRun({
      processor_name: "analytics-projector",
      processor_version: "v1",
    });
    const cancelled = await repo.cancelRun({
      run_id: initial.run_id,
      reason: "operator stopped via CLI",
    });
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.error_summary).toBe("operator stopped via CLI");
    expect(cancelled.finished_at?.getTime()).toBe(FIXED_NOW.getTime());
  });

  it("rejects a second transition out of a terminal status", async () => {
    const repo = newRepo();
    const initial = await repo.registerRun({
      processor_name: "analytics-projector",
      processor_version: "v1",
    });
    await repo.completeRun({ run_id: initial.run_id });
    await expect(
      repo.failRun({ run_id: initial.run_id, error_summary: "too late" }),
    ).rejects.toBeInstanceOf(InvalidRunTransitionError);
  });
});

describe("InMemoryProcessorRunRepository.findRun", () => {
  it("returns null for unknown ids", async () => {
    const repo = newRepo();
    expect(await repo.findRun("unknown")).toBeNull();
  });

  it("returns the latest snapshot of the record", async () => {
    const repo = newRepo();
    const created = await repo.registerRun({
      processor_name: "analytics-projector",
      processor_version: "v1",
    });
    await repo.updateRun({ run_id: created.run_id, events_consumed: 1 });
    const found = await repo.findRun(created.run_id);
    expect(found?.events_consumed).toBe(1);
  });
});
