/**
 * Planning a window the stream no longer holds.
 *
 * Before the archive, `window_from` older than retention was a hard
 * rejection, and that rejection was the reason `polaris profiles rebuild`
 * had to print "depth: bounded by raw.events retention" and mean it. The
 * archive moves the boundary; it does not remove it, so a window nothing
 * covers is still refused.
 */

import { describe, expect, it } from "vitest";

import { planReplay } from "../src/planner.js";
import { ReplayPlanError } from "../src/types.js";

const NOW = new Date("2026-08-15T00:00:00.000Z");

function declaration(from: string, to: string) {
  return {
    replay_job_id: "polaris_rpj_1",
    project_id: "storefront",
    environment: "production",
    target: "processor",
    mode: "dry_run",
    window_from: from,
    window_to: to,
    reason: "undo a bad merge",
  };
}

describe("windows inside retention", () => {
  it("reads from the stream and flags nothing about the archive", () => {
    const plan = planReplay(declaration("2026-08-10T00:00:00Z", "2026-08-11T00:00:00Z"), {
      now: NOW,
      archiveEarliestDate: "2024-01-01",
    });

    expect(plan.source_kind).toBe("stream");
    expect(plan.risks.map((risk) => risk.code)).not.toContain("archive_backed_window");
  });
});

describe("windows the stream no longer holds", () => {
  it("is still rejected when no archive is configured", () => {
    expect(() =>
      planReplay(declaration("2024-01-01T00:00:00Z", "2024-01-02T00:00:00Z"), { now: NOW }),
    ).toThrow(ReplayPlanError);
  });

  it("says which bound it failed, so the operator knows what would fix it", () => {
    try {
      planReplay(declaration("2024-01-01T00:00:00Z", "2024-01-02T00:00:00Z"), { now: NOW });
      expect.unreachable("expected a rejection");
    } catch (err) {
      expect((err as ReplayPlanError).code).toBe("outside_retention_window");
      expect((err as Error).message).toContain("no archive is configured");
    }
  });

  it("is accepted when the archive reaches back far enough", () => {
    const plan = planReplay(declaration("2024-06-01T00:00:00Z", "2024-06-02T00:00:00Z"), {
      now: NOW,
      archiveEarliestDate: "2024-01-01",
    });

    expect(plan.source_kind).toBe("archive");
    expect(plan.risks.map((risk) => risk.code)).toContain("archive_backed_window");
  });

  it("covers the whole of the archive's earliest day, not just its end", () => {
    // The bucket demonstrably holds 02:00 on its first day. Rounding to
    // the end of that day would reject a replay for events that are there.
    const plan = planReplay(declaration("2024-01-01T02:00:00Z", "2024-01-01T03:00:00Z"), {
      now: NOW,
      archiveEarliestDate: "2024-01-01",
    });

    expect(plan.source_kind).toBe("archive");
  });

  it("is rejected when the window predates the archive too", () => {
    try {
      planReplay(declaration("2023-01-01T00:00:00Z", "2023-01-02T00:00:00Z"), {
        now: NOW,
        archiveEarliestDate: "2024-01-01",
      });
      expect.unreachable("expected a rejection");
    } catch (err) {
      expect((err as ReplayPlanError).code).toBe("outside_retention_window");
      expect((err as Error).message).toContain("archive's first day");
    }
  });

  it("ignores an unparseable archive date rather than trusting it", () => {
    // A malformed coverage answer must not widen what the planner
    // accepts. Failing closed here costs a rejected replay; failing open
    // costs a job that runs and finds nothing.
    expect(() =>
      planReplay(declaration("2024-06-01T00:00:00Z", "2024-06-02T00:00:00Z"), {
        now: NOW,
        archiveEarliestDate: "june",
      }),
    ).toThrow(ReplayPlanError);
  });
});

describe("windows crossing the retention boundary", () => {
  it("is mixed, and carries both flags", () => {
    // 90 days before 2026-08-15 is 2026-05-17. A window from May 1st to
    // August 1st starts in the archive and ends in the stream.
    const plan = planReplay(declaration("2026-05-01T00:00:00Z", "2026-08-01T00:00:00Z"), {
      now: NOW,
      archiveEarliestDate: "2024-01-01",
    });

    expect(plan.source_kind).toBe("mixed");
    const codes = plan.risks.map((risk) => risk.code);
    // Both: an operator scanning for "is this an archive read?" should
    // find it whether the window is wholly or partly archived.
    expect(codes).toContain("archive_backed_window");
    expect(codes).toContain("mixed_source_window");
  });

  it("warns about the seam in words an operator can act on", () => {
    const plan = planReplay(declaration("2026-05-01T00:00:00Z", "2026-08-01T00:00:00Z"), {
      now: NOW,
      archiveEarliestDate: "2024-01-01",
    });

    const mixed = plan.risks.find((risk) => risk.code === "mixed_source_window");
    expect(mixed?.message).toContain("gap");
  });
});
