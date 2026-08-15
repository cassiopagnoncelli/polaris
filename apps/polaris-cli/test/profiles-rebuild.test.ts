/**
 * `polaris profiles rebuild`.
 *
 * The command exists because three of the four possible orderings of
 * pause/truncate/replay/resume are wrong, and two of them are wrong quietly.
 * These tests pin the ordering, the production gate, and the one thing a
 * failed rebuild must never do — leave the resolver paused over an empty
 * profile plane.
 */

import { describe, expect, it } from "vitest";

import type { CommandContext } from "../src/command.js";
import {
  buildProfilesRebuildRunner,
  type ProfilesRebuildDriver,
  type RebuildJob,
} from "../src/commands/profiles/rebuild.js";

function makeContext(source = "operator_token"): CommandContext {
  return {
    actor: { source, label: "tester" },
    config: { output: "json" },
    output: { writeOut: () => {}, writeErr: () => {} },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    env: {},
  } as unknown as CommandContext;
}

function recordingDriver(
  failAt?: string,
  depth: { depthBoundedBy: "raw_events_retention" | "archive"; earliestReplayed: string } = {
    depthBoundedBy: "raw_events_retention",
    earliestReplayed: "2026-05-17T00:00:00.000Z",
  },
) {
  const calls: string[] = [];
  const jobs: RebuildJob[] = [];
  const driver: ProfilesRebuildDriver = {
    pause: async () => {
      calls.push("pause");
      if (failAt === "pause") throw new Error("pause failed");
    },
    truncate: async () => {
      calls.push("truncate");
      if (failAt === "truncate") throw new Error("truncate failed");
    },
    replay: async () => {
      calls.push("replay");
      if (failAt === "replay") throw new Error("replay failed");
      return { retentionDays: 90, ...depth };
    },
    resume: async () => {
      calls.push("resume");
    },
    recordJob: async (job) => {
      jobs.push(job);
    },
  };
  return { driver, calls, jobs };
}

const BASE = { project: "storefront", env: "staging", reason: "over-merge", yes: true };

describe("profiles rebuild", () => {
  it("runs the four steps in the only correct order", async () => {
    // Pause must precede truncate or live traffic writes into the scope
    // being emptied; resume must follow replay or the same events arrive
    // twice and the resolver merges them.
    const { driver, calls } = recordingDriver();
    const runner = buildProfilesRebuildRunner({ driver: () => driver });
    await runner(BASE, makeContext());
    expect(calls).toEqual(["pause", "truncate", "replay", "resume"]);
  });

  it("resumes the resolver even when the replay fails", async () => {
    // The failure mode that matters. A rebuild that died after the truncate
    // has already emptied the profile plane; leaving the resolver paused on
    // top of that turns a failed repair into an outage.
    const { driver, calls } = recordingDriver("replay");
    const runner = buildProfilesRebuildRunner({ driver: () => driver });
    await expect(runner(BASE, makeContext())).rejects.toThrow(/replay failed/);
    expect(calls).toContain("resume");
  });

  it("records the steps that DID complete, so a crash is diagnosable", async () => {
    const { driver, jobs } = recordingDriver("replay");
    const runner = buildProfilesRebuildRunner({ driver: () => driver });
    await expect(runner(BASE, makeContext())).rejects.toThrow();
    expect(jobs[0]?.steps_completed).toEqual(["pause", "truncate", "resume"]);
  });

  it("reports the rebuild depth rather than hiding it", async () => {
    // An operator who rebuilds to fix an over-merge and silently loses five
    // years of lineage has been handed a worse problem than the one they
    // started with.
    const { driver, jobs } = recordingDriver();
    const runner = buildProfilesRebuildRunner({ driver: () => driver });
    await runner(BASE, makeContext());
    expect(jobs[0]?.depth_bounded_by).toBe("raw_events_retention");
    expect(jobs[0]?.retention_days).toBe(90);
    expect(jobs[0]?.earliest_replayed).toBe("2026-05-17T00:00:00.000Z");
  });

  it("reports the archive as the bound when the archive is what reached further", async () => {
    // The bound moved; the report has to move with it. Printing
    // "bounded by raw.events retention" after an archive-backed rebuild
    // would understate the repair by years, and an operator would go
    // looking for lineage they already have.
    const { driver, jobs } = recordingDriver(undefined, {
      depthBoundedBy: "archive",
      earliestReplayed: "2024-01-01T00:00:00.000Z",
    });
    const runner = buildProfilesRebuildRunner({ driver: () => driver });
    await runner(BASE, makeContext());
    expect(jobs[0]?.depth_bounded_by).toBe("archive");
    expect(jobs[0]?.earliest_replayed).toBe("2024-01-01T00:00:00.000Z");
  });

  it("records no depth when the replay never ran", async () => {
    // A rebuild that died at the truncate has an empty profile plane and
    // no replay depth to claim. Reporting a depth it did not reach would
    // be the worst possible lie at the worst possible moment.
    const { driver, jobs } = recordingDriver("replay");
    const runner = buildProfilesRebuildRunner({ driver: () => driver });
    await expect(runner(BASE, makeContext())).rejects.toThrow(/replay failed/);
    expect(jobs[0]?.earliest_replayed).toBeNull();
    expect(jobs[0]?.steps_completed).not.toContain("replay");
  });

  it("refuses production without an operator token", async () => {
    // `--project` is the whole blast radius, and a mistyped id in production
    // succeeds against the wrong project.
    const { driver, calls } = recordingDriver();
    const runner = buildProfilesRebuildRunner({ driver: () => driver });
    await expect(runner({ ...BASE, env: "production" }, makeContext("cli"))).rejects.toThrow(
      /operator token/,
    );
    expect(calls).toHaveLength(0);
  });

  it("allows production with an operator token", async () => {
    const { driver, calls } = recordingDriver();
    const runner = buildProfilesRebuildRunner({ driver: () => driver });
    await runner({ ...BASE, env: "production" }, makeContext("operator_token"));
    expect(calls).toEqual(["pause", "truncate", "replay", "resume"]);
  });

  it("refuses without --yes, and touches nothing", async () => {
    const { driver, calls } = recordingDriver();
    const runner = buildProfilesRebuildRunner({ driver: () => driver });
    await expect(runner({ ...BASE, yes: false }, makeContext())).rejects.toThrow(/--yes/);
    expect(calls).toHaveLength(0);
  });

  it("requires project, env and reason", async () => {
    const { driver } = recordingDriver();
    const runner = buildProfilesRebuildRunner({ driver: () => driver });
    await expect(runner({ ...BASE, project: "" }, makeContext())).rejects.toThrow(/--project/);
    await expect(runner({ ...BASE, env: "" }, makeContext())).rejects.toThrow(/--env/);
    await expect(runner({ ...BASE, reason: "" }, makeContext())).rejects.toThrow(/--reason/);
  });

  it("refuses rather than pretending, when no driver is configured", async () => {
    // Unreachable from the registered command, which always supplies one.
    // Kept because a programmatic caller that forgets would otherwise get a
    // rebuild that printed a plan and changed nothing — which reads as
    // success.
    const runner = buildProfilesRebuildRunner();
    await expect(runner(BASE, makeContext())).rejects.toThrow(/no driver configured/);
  });
});
