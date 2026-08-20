/**
 * Smoke tests pinning the `polaris clickhouse-rebuild` command-group
 * public surface (P7-005).
 *
 * Companion to `clickhouse-rebuild-runners.test.ts` which exercises
 * the runner behaviour. This file verifies:
 *
 *   - the five commands register with the expected `mutates` flags,
 *   - the command-id strings are stable,
 *   - the closed-set status / projection constants stay aligned with
 *     the migration,
 *   - the closed-set registry in persistence-clickhouse/rebuild matches
 *     the on-disk SQL files (each registered projection has a real
 *     DDL file).
 *
 * @see docs/implementation/tasks/P7-005-clickhouse-rebuild-workflows.md
 */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  REBUILDABLE_CLICKHOUSE_PROJECTION_NAMES,
  REBUILDABLE_CLICKHOUSE_PROJECTIONS,
} from "@polaris/persistence-clickhouse/rebuild";
import { describe, expect, it } from "vitest";

import {
  CLICKHOUSE_REBUILD_JOB_ID_PREFIX,
  generateClickhouseRebuildJobId,
} from "../src/commands/clickhouse-rebuild/id.js";
import {
  clickhouseRebuildAbortCommand,
  clickhouseRebuildCommand,
  clickhouseRebuildCreateCommand,
  clickhouseRebuildListCommand,
  clickhouseRebuildPlanCommand,
  clickhouseRebuildShowCommand,
} from "../src/commands/clickhouse-rebuild/index.js";
import {
  ABORTABLE_CLICKHOUSE_REBUILD_JOB_STATUSES,
  CLICKHOUSE_REBUILD_JOB_STATUSES,
  isAbortableClickhouseRebuildStatus,
  isTerminalClickhouseRebuildStatus,
  TERMINAL_CLICKHOUSE_REBUILD_JOB_STATUSES,
} from "../src/db/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");

describe("polaris clickhouse-rebuild command group", () => {
  it("registers under the expected command ids", () => {
    expect(clickhouseRebuildCommand.id).toBe("clickhouse-rebuild");
    expect(clickhouseRebuildListCommand.id).toBe("clickhouse-rebuild.list");
    expect(clickhouseRebuildShowCommand.id).toBe("clickhouse-rebuild.show");
    expect(clickhouseRebuildPlanCommand.id).toBe("clickhouse-rebuild.plan");
    expect(clickhouseRebuildCreateCommand.id).toBe("clickhouse-rebuild.create");
    expect(clickhouseRebuildAbortCommand.id).toBe("clickhouse-rebuild.abort");
  });

  it("flags every mutating command as mutates: true", () => {
    expect(clickhouseRebuildCreateCommand.mutates).toBe(true);
    expect(clickhouseRebuildAbortCommand.mutates).toBe(true);
  });

  it("flags every read-only command as mutates: false", () => {
    expect(clickhouseRebuildCommand.mutates).toBe(false);
    expect(clickhouseRebuildListCommand.mutates).toBe(false);
    expect(clickhouseRebuildShowCommand.mutates).toBe(false);
    expect(clickhouseRebuildPlanCommand.mutates).toBe(false);
  });
});

describe("clickhouse-rebuild status closed-set helpers", () => {
  it("CLICKHOUSE_REBUILD_JOB_STATUSES holds exactly the seven documented states", () => {
    expect(CLICKHOUSE_REBUILD_JOB_STATUSES).toEqual([
      "pending",
      "planning",
      "dry_run",
      "running",
      "completed",
      "failed",
      "aborted",
    ]);
  });

  it("TERMINAL_CLICKHOUSE_REBUILD_JOB_STATUSES = completed | failed | aborted", () => {
    expect(TERMINAL_CLICKHOUSE_REBUILD_JOB_STATUSES).toEqual(["completed", "failed", "aborted"]);
  });

  it("isTerminalClickhouseRebuildStatus returns true for terminal states only", () => {
    expect(isTerminalClickhouseRebuildStatus("completed")).toBe(true);
    expect(isTerminalClickhouseRebuildStatus("failed")).toBe(true);
    expect(isTerminalClickhouseRebuildStatus("aborted")).toBe(true);
    expect(isTerminalClickhouseRebuildStatus("pending")).toBe(false);
    expect(isTerminalClickhouseRebuildStatus("planning")).toBe(false);
    expect(isTerminalClickhouseRebuildStatus("dry_run")).toBe(false);
    expect(isTerminalClickhouseRebuildStatus("running")).toBe(false);
  });

  it("ABORTABLE_CLICKHOUSE_REBUILD_JOB_STATUSES covers pending | planning | dry_run", () => {
    expect(ABORTABLE_CLICKHOUSE_REBUILD_JOB_STATUSES).toEqual(["pending", "planning", "dry_run"]);
    expect(isAbortableClickhouseRebuildStatus("pending")).toBe(true);
    expect(isAbortableClickhouseRebuildStatus("planning")).toBe(true);
    expect(isAbortableClickhouseRebuildStatus("dry_run")).toBe(true);
    expect(isAbortableClickhouseRebuildStatus("running")).toBe(false);
    expect(isAbortableClickhouseRebuildStatus("completed")).toBe(false);
  });
});

describe("clickhouse-rebuild id helper", () => {
  it("emits ids with the polaris_chr_ prefix", () => {
    expect(CLICKHOUSE_REBUILD_JOB_ID_PREFIX).toBe("polaris_chr_");
    const id = generateClickhouseRebuildJobId();
    expect(id.startsWith("polaris_chr_")).toBe(true);
    expect(id.length).toBeGreaterThan(CLICKHOUSE_REBUILD_JOB_ID_PREFIX.length);
  });

  it("emits distinct ids on successive calls", () => {
    const a = generateClickhouseRebuildJobId();
    const b = generateClickhouseRebuildJobId();
    expect(a).not.toBe(b);
  });
});

describe("rebuildable projection registry matches the on-disk SQL", () => {
  it("at least one projection registered", () => {
    expect(REBUILDABLE_CLICKHOUSE_PROJECTION_NAMES.length).toBeGreaterThanOrEqual(1);
  });

  it("every registered projection has a real sqlFile under db/clickhouse/projections/", () => {
    for (const descriptor of REBUILDABLE_CLICKHOUSE_PROJECTIONS) {
      const absPath = resolve(REPO_ROOT, descriptor.sqlFile);
      expect(
        existsSync(absPath),
        `missing DDL for projection ${descriptor.name}: ${descriptor.sqlFile}`,
      ).toBe(true);
    }
  });

  it("every registered projection has a real feeder MV file", () => {
    for (const descriptor of REBUILDABLE_CLICKHOUSE_PROJECTIONS) {
      const absPath = resolve(REPO_ROOT, descriptor.feederMvFile);
      expect(
        existsSync(absPath),
        `missing MV for projection ${descriptor.name}: ${descriptor.feederMvFile}`,
      ).toBe(true);
    }
  });

  it("every registered projection has a real rebuildSelectFile that mentions {partition:String}", async () => {
    const { readFile } = await import("node:fs/promises");
    for (const descriptor of REBUILDABLE_CLICKHOUSE_PROJECTIONS) {
      const absPath = resolve(REPO_ROOT, descriptor.rebuildSelectFile);
      expect(
        existsSync(absPath),
        `missing rebuild SELECT for projection ${descriptor.name}: ${descriptor.rebuildSelectFile}`,
      ).toBe(true);
      const body = await readFile(absPath, "utf8");
      // The rebuild driver binds the partition via the ClickHouse
      // query-params mechanism, so the SELECT must reference it as
      // a parameter placeholder, not interpolate the partition label
      // into the SQL.
      expect(body).toContain("{partition:String}");
    }
  });

  it("every registered projection has qualifiedTable shape polaris.<table>", () => {
    for (const descriptor of REBUILDABLE_CLICKHOUSE_PROJECTIONS) {
      expect(descriptor.qualifiedTable).toMatch(/^polaris\.[a-z][a-z0-9_]*$/);
    }
  });
});
