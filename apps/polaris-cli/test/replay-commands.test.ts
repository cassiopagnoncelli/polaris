/**
 * Smoke tests pinning the `polaris replay` command-group public surface.
 *
 * P7-001 ships the JOB model + CLI for the operator-facing
 * create/list/show/cancel/pause/resume surface. The planner (P7-002) and
 * executor (P7-003) tasks own the dry_run/running/completed transitions
 * and the per-event counters — those land with their own test surfaces.
 *
 * These smoke tests verify:
 *
 *   - the six commands all register with the expected `mutates` flags,
 *   - the command-id strings are stable,
 *   - the migration's column set carries no planner-semantic fields,
 *   - the validation gate refuses planner-shaped flag tokens before any
 *     downstream code can see them.
 *
 * @see docs/implementation/tasks/P7-001-replay-job-model-cli.md
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  REPLAY_JOB_MODES,
  REPLAY_JOB_STATUSES,
  REPLAY_JOB_TARGETS,
} from "../src/db/replay-jobs.js";
import {
  replayCancelCommand,
  replayCommand,
  replayCreateCommand,
  replayListCommand,
  replayPauseCommand,
  replayResumeCommand,
  replayShowCommand,
} from "../src/commands/replay/index.js";
import {
  FORBIDDEN_REPLAY_PLAN_FLAG_TOKENS,
  rejectReplayPlanArguments,
} from "../src/commands/replay/validation.js";
import { UsageError } from "../src/errors.js";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION_PATH = resolve(
  here,
  "../../../db/migrations/20260512000011_create_replay_jobs.sql",
);

describe("polaris replay command group", () => {
  it("registers under the expected command ids", () => {
    expect(replayCommand.id).toBe("replay");
    expect(replayCreateCommand.id).toBe("replay.create");
    expect(replayListCommand.id).toBe("replay.list");
    expect(replayShowCommand.id).toBe("replay.show");
    expect(replayCancelCommand.id).toBe("replay.cancel");
    expect(replayPauseCommand.id).toBe("replay.pause");
    expect(replayResumeCommand.id).toBe("replay.resume");
  });

  it("flags every mutating command as mutates: true", () => {
    expect(replayCreateCommand.mutates).toBe(true);
    expect(replayCancelCommand.mutates).toBe(true);
    expect(replayPauseCommand.mutates).toBe(true);
    expect(replayResumeCommand.mutates).toBe(true);
  });

  it("flags every read-only command as mutates: false", () => {
    expect(replayCommand.mutates).toBe(false);
    expect(replayListCommand.mutates).toBe(false);
    expect(replayShowCommand.mutates).toBe(false);
  });

  it("exposes the closed-set constants the validators use", () => {
    expect(REPLAY_JOB_STATUSES).toContain("pending");
    expect(REPLAY_JOB_STATUSES).toContain("cancelled");
    expect(REPLAY_JOB_STATUSES).toContain("completed");
    expect(REPLAY_JOB_STATUSES).toContain("paused");
    expect(REPLAY_JOB_TARGETS).toEqual(["analytics_raw", "destinations", "processor"]);
    expect(REPLAY_JOB_MODES).toEqual(["dry_run", "live"]);
  });
});

describe("rejectReplayPlanArguments", () => {
  it("passes when no planner-shaped flag is present", () => {
    expect(() =>
      rejectReplayPlanArguments({
        project: "proj-1",
        env: "development",
        target: "analytics_raw",
        from: "2026-04-12T00:00:00.000Z",
        to: "2026-04-13T00:00:00.000Z",
        reason: "audit retest",
      }),
    ).not.toThrow();
  });

  it("rejects when a planner-shaped flag sneaks through", () => {
    // Pick a representative subset of the rejection list. The full surface is
    // tested by walking FORBIDDEN_REPLAY_PLAN_FLAG_TOKENS below.
    expect(() =>
      rejectReplayPlanArguments({
        project: "proj-1",
        env: "development",
        transformOverride: "rewrite_all",
      }),
    ).toThrow(UsageError);
  });

  it("rejects every token in FORBIDDEN_REPLAY_PLAN_FLAG_TOKENS", () => {
    for (const token of FORBIDDEN_REPLAY_PLAN_FLAG_TOKENS) {
      const camel = token.replace(/[-_]([a-z])/g, (_, c: string) => c.toUpperCase());
      const args: Record<string, unknown> = { project: "p" };
      args[camel] = "anything";
      expect(() => rejectReplayPlanArguments(args), `token: ${token}`).toThrow(UsageError);
    }
  });
});

describe("replay_jobs migration schema invariant", () => {
  const sql = readFileSync(MIGRATION_PATH, "utf8");

  it("creates the replay_jobs table", () => {
    expect(sql).toMatch(/CREATE TABLE replay_jobs/);
  });

  it("encodes the polaris_rpj_ prefix CHECK", () => {
    expect(sql).toMatch(/replay_jobs_replay_job_id_format/);
    expect(sql).toMatch(/polaris_rpj_/);
  });

  it("encodes the target closed set CHECK", () => {
    expect(sql).toMatch(/replay_jobs_target_allowed/);
    expect(sql).toMatch(/analytics_raw/);
    expect(sql).toMatch(/destinations/);
    expect(sql).toMatch(/processor/);
  });

  it("encodes the mode closed set CHECK", () => {
    expect(sql).toMatch(/replay_jobs_mode_allowed/);
    expect(sql).toMatch(/dry_run/);
    expect(sql).toMatch(/live/);
  });

  it("encodes the status closed set CHECK", () => {
    expect(sql).toMatch(/replay_jobs_status_allowed/);
    for (const status of REPLAY_JOB_STATUSES) {
      expect(sql).toContain(status);
    }
  });

  it("creates the two backing indexes", () => {
    expect(sql).toMatch(/replay_jobs_status_created_idx/);
    expect(sql).toMatch(/replay_jobs_project_env_created_idx/);
  });

  it("has NO planner-semantic columns", () => {
    // The schema-level guard against future regression. We check only the
    // executable SQL (strip line comments) so the docstring's "there is NO
    // partition_strategy" note doesn't false-positive.
    const executable = sql
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");
    const forbidden = [
      "partition_strategy",
      "chunking_rules",
      "chunk_strategy",
      "transform_override",
      "transform_rules",
      "field_map",
      "event_map",
      "routing",
      "input_topic",
      "output_topic",
      "schema_override",
    ];
    for (const column of forbidden) {
      expect(executable, `forbidden column found: ${column}`).not.toMatch(
        new RegExp(`\\b${column}\\b`),
      );
    }
  });

  it("has migrate:up and migrate:down sections", () => {
    expect(sql).toMatch(/-- migrate:up/);
    expect(sql).toMatch(/-- migrate:down/);
  });
});
