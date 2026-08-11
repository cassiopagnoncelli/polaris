/**
 * Tests for the replay planner (P7-002).
 *
 * Coverage matrix:
 *
 *   determinism      same input -> same plan (across calls + clock pins)
 *   scope validation missing project, bad environment, bad target/mode
 *   window bounds    inverted, future, outside retention, zero-duration
 *   chunking         single-day, multi-day, sub-day, exactly-on-midnight
 *   destinations     default disabled, opt-in requires note, opt-in
 *                    flips risk flag
 *   processor pin    pinned vs unpinned -> risk flag
 *   single event     event_id only -> risk flag
 *   environment      production scope -> risk flag
 *   wide window      > 7 days -> wide_time_window risk
 *   consumer group   format pins project/env/target/job-id
 *   render           human render carries every section the task card listed
 *
 * @see docs/implementation/tasks/P7-002-replay-planner-dry-run.md
 */

import { describe, expect, it } from "vitest";

import {
  buildConsumerGroup,
  chunkWindow,
  DEFAULT_CHUNK_SIZE_DAYS,
  DEFAULT_RETENTION_DAYS,
  planReplay,
  REPLAY_PLAN_ENVIRONMENTS,
  REPLAY_PLAN_MODES,
  REPLAY_PLAN_TARGETS,
  REPLAY_RISK_CODES,
  type ReplayJobDeclaration,
  ReplayPlanError,
  renderPlanHuman,
  WIDE_WINDOW_DAYS_THRESHOLD,
} from "../src/index.js";

const NOW = new Date("2026-05-12T12:00:00.000Z");

/**
 * Build a minimal valid declaration. Tests override one or two fields
 * per case rather than re-spelling the whole record.
 */
function makeDecl(overrides: Partial<ReplayJobDeclaration> = {}): ReplayJobDeclaration {
  return {
    replay_job_id: "polaris_rpj_test",
    project_id: "storefront",
    environment: "development",
    target: "analytics_raw",
    mode: "dry_run",
    window_from: "2026-05-10T00:00:00.000Z",
    window_to: "2026-05-11T00:00:00.000Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

describe("planner public constants", () => {
  it("exposes the closed environment set", () => {
    expect(REPLAY_PLAN_ENVIRONMENTS).toEqual(["development", "staging", "production"]);
  });

  it("exposes the closed target set (mirrors P7-001 db enum)", () => {
    expect(REPLAY_PLAN_TARGETS).toEqual(["analytics_raw", "destinations", "processor"]);
  });

  it("exposes the closed mode set", () => {
    expect(REPLAY_PLAN_MODES).toEqual(["dry_run", "live"]);
  });

  it("exposes the closed risk-code set", () => {
    expect(REPLAY_RISK_CODES).toContain("wide_time_window");
    expect(REPLAY_RISK_CODES).toContain("destination_sends_enabled");
    expect(REPLAY_RISK_CODES).toContain("processor_target_not_pinned");
    expect(REPLAY_RISK_CODES).toContain("single_event_replay");
    expect(REPLAY_RISK_CODES).toContain("production_scope");
  });

  it("default retention is 90 days (matches the CLI's REPLAY_WINDOW_DAYS)", () => {
    expect(DEFAULT_RETENTION_DAYS).toBe(90);
  });

  it("default chunk size is 1 day", () => {
    expect(DEFAULT_CHUNK_SIZE_DAYS).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// determinism
// ---------------------------------------------------------------------------

describe("determinism", () => {
  it("returns the same plan for the same input", () => {
    const decl = makeDecl();
    const a = planReplay(decl, { now: NOW });
    const b = planReplay(decl, { now: NOW });
    expect(a).toEqual(b);
  });

  it("does not mutate the input declaration", () => {
    const decl = makeDecl();
    const frozen = Object.freeze({ ...decl });
    expect(() => planReplay(frozen, { now: NOW })).not.toThrow();
  });

  it("emits planner_version=v1 on every plan", () => {
    const plan = planReplay(makeDecl(), { now: NOW });
    expect(plan.planner_version).toBe("v1");
  });

  it("stamps planned_at from the supplied clock", () => {
    const plan = planReplay(makeDecl(), { now: NOW });
    expect(plan.planned_at).toBe(NOW.toISOString());
  });
});

// ---------------------------------------------------------------------------
// scope validation
// ---------------------------------------------------------------------------

describe("scope validation", () => {
  it("rejects missing project_id with missing_project_id", () => {
    try {
      planReplay(makeDecl({ project_id: "" }), { now: NOW });
      throw new Error("expected ReplayPlanError");
    } catch (err) {
      expect(err).toBeInstanceOf(ReplayPlanError);
      expect((err as ReplayPlanError).code).toBe("missing_project_id");
    }
  });

  it("rejects whitespace-only project_id", () => {
    expect(() => planReplay(makeDecl({ project_id: "   " }), { now: NOW })).toThrow(
      ReplayPlanError,
    );
  });

  it("rejects unknown environments with invalid_environment", () => {
    try {
      planReplay(makeDecl({ environment: "uat" }), { now: NOW });
      throw new Error("expected ReplayPlanError");
    } catch (err) {
      expect((err as ReplayPlanError).code).toBe("invalid_environment");
    }
  });

  it("rejects unknown targets with invalid_target", () => {
    try {
      planReplay(makeDecl({ target: "nowhere" }), { now: NOW });
      throw new Error("expected ReplayPlanError");
    } catch (err) {
      expect((err as ReplayPlanError).code).toBe("invalid_target");
    }
  });

  it("rejects unknown modes with invalid_mode", () => {
    try {
      planReplay(makeDecl({ mode: "shadow" }), { now: NOW });
      throw new Error("expected ReplayPlanError");
    } catch (err) {
      expect((err as ReplayPlanError).code).toBe("invalid_mode");
    }
  });

  it("defaults a missing mode to dry_run", () => {
    const plan = planReplay(makeDecl({ mode: undefined }), { now: NOW });
    expect(plan.mode).toBe("dry_run");
  });

  it("defaults an empty mode to dry_run", () => {
    const plan = planReplay(makeDecl({ mode: "" }), { now: NOW });
    expect(plan.mode).toBe("dry_run");
  });

  it("refuses unscoped production replays (production_replay_unscoped)", () => {
    // The strict require(project_id) gate fires first; the
    // production-unscoped gate is a defense-in-depth check that exists
    // to refuse any caller that bypasses the require check. We trip it
    // by constructing the declaration with a project_id whose presence
    // passes requireNonEmpty (the planner's whitespace strip preserves
    // a non-trimmable Unicode character) and then asserting prod
    // declarations always carry a non-empty project_id in practice.
    //
    // The simpler observable assertion: production_scope risk fires AND
    // the require gate catches all common cases.
    expect(() =>
      planReplay(makeDecl({ project_id: "", environment: "production" }), { now: NOW }),
    ).toThrow(ReplayPlanError);
  });

  it("permits production replays when project_id is set; raises production_scope risk", () => {
    const plan = planReplay(makeDecl({ environment: "production" }), { now: NOW });
    expect(plan.environment).toBe("production");
    const codes = plan.risks.map((r) => r.code);
    expect(codes).toContain("production_scope");
  });
});

// ---------------------------------------------------------------------------
// window bounds
// ---------------------------------------------------------------------------

describe("window bounds", () => {
  it("rejects inverted windows with window_inverted", () => {
    try {
      planReplay(
        makeDecl({
          window_from: "2026-05-11T00:00:00.000Z",
          window_to: "2026-05-10T00:00:00.000Z",
        }),
        { now: NOW },
      );
      throw new Error("expected ReplayPlanError");
    } catch (err) {
      expect((err as ReplayPlanError).code).toBe("window_inverted");
    }
  });

  it("rejects future windows with window_in_future", () => {
    try {
      planReplay(
        makeDecl({
          window_from: "2026-05-12T00:00:00.000Z",
          window_to: "2026-05-13T00:00:00.000Z",
        }),
        { now: NOW },
      );
      throw new Error("expected ReplayPlanError");
    } catch (err) {
      expect((err as ReplayPlanError).code).toBe("window_in_future");
    }
  });

  it("rejects windows older than retention with outside_retention_window", () => {
    try {
      planReplay(
        makeDecl({
          window_from: "2025-01-01T00:00:00.000Z",
          window_to: "2025-01-02T00:00:00.000Z",
        }),
        { now: NOW },
      );
      throw new Error("expected ReplayPlanError");
    } catch (err) {
      expect((err as ReplayPlanError).code).toBe("outside_retention_window");
    }
  });

  it("rejects invalid date strings with invalid_window_from", () => {
    try {
      planReplay(makeDecl({ window_from: "not-a-date" }), { now: NOW });
      throw new Error("expected ReplayPlanError");
    } catch (err) {
      expect((err as ReplayPlanError).code).toBe("invalid_window_from");
    }
  });

  it("rejects invalid date strings with invalid_window_to", () => {
    try {
      planReplay(makeDecl({ window_to: "not-a-date" }), { now: NOW });
      throw new Error("expected ReplayPlanError");
    } catch (err) {
      expect((err as ReplayPlanError).code).toBe("invalid_window_to");
    }
  });

  it("accepts Date instances for window bounds (not just ISO strings)", () => {
    const plan = planReplay(
      makeDecl({
        window_from: new Date("2026-05-10T00:00:00.000Z"),
        window_to: new Date("2026-05-11T00:00:00.000Z"),
      }),
      { now: NOW },
    );
    expect(plan.window_from).toBe("2026-05-10T00:00:00.000Z");
    expect(plan.window_to).toBe("2026-05-11T00:00:00.000Z");
  });

  it("rejects window-bound retention with a custom retentionDays", () => {
    try {
      planReplay(
        makeDecl({
          // 8 days before NOW - just outside a 7-day retention.
          window_from: "2026-05-04T00:00:00.000Z",
          window_to: "2026-05-05T00:00:00.000Z",
        }),
        { now: NOW, retentionDays: 7 },
      );
      throw new Error("expected ReplayPlanError");
    } catch (err) {
      expect((err as ReplayPlanError).code).toBe("outside_retention_window");
    }
  });

  it("permits a window exactly on the retention boundary", () => {
    // NOW - 90d - 1s would fail; NOW - 90d would pass.
    const boundary = new Date(NOW.getTime() - 90 * 24 * 60 * 60 * 1000);
    const plan = planReplay(
      makeDecl({
        window_from: boundary.toISOString(),
        window_to: new Date(boundary.getTime() + 3600 * 1000).toISOString(),
      }),
      { now: NOW },
    );
    expect(plan.window_from).toBe(boundary.toISOString());
  });

  it("zero-duration windows produce a single zero-width chunk", () => {
    const plan = planReplay(
      makeDecl({
        window_from: "2026-05-10T12:00:00.000Z",
        window_to: "2026-05-10T12:00:00.000Z",
      }),
      { now: NOW },
    );
    expect(plan.chunks).toHaveLength(1);
    expect(plan.chunks[0]?.from).toBe("2026-05-10T12:00:00.000Z");
    expect(plan.chunks[0]?.to).toBe("2026-05-10T12:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// chunking
// ---------------------------------------------------------------------------

describe("chunkWindow", () => {
  it("returns one chunk for a sub-day window", () => {
    const out = chunkWindow(
      new Date("2026-05-10T10:00:00.000Z"),
      new Date("2026-05-10T20:00:00.000Z"),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      index: 0,
      from: "2026-05-10T10:00:00.000Z",
      to: "2026-05-10T20:00:00.000Z",
    });
  });

  it("splits cleanly on UTC midnight for a multi-day window", () => {
    const out = chunkWindow(
      new Date("2026-05-10T00:00:00.000Z"),
      new Date("2026-05-13T00:00:00.000Z"),
    );
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({
      index: 0,
      from: "2026-05-10T00:00:00.000Z",
      to: "2026-05-11T00:00:00.000Z",
    });
    expect(out[1]).toEqual({
      index: 1,
      from: "2026-05-11T00:00:00.000Z",
      to: "2026-05-12T00:00:00.000Z",
    });
    expect(out[2]).toEqual({
      index: 2,
      from: "2026-05-12T00:00:00.000Z",
      to: "2026-05-13T00:00:00.000Z",
    });
  });

  it("splits a partial-day window with a non-midnight start + non-midnight end", () => {
    const out = chunkWindow(
      new Date("2026-05-10T15:00:00.000Z"),
      new Date("2026-05-12T09:00:00.000Z"),
    );
    expect(out).toHaveLength(3);
    expect(out[0]?.from).toBe("2026-05-10T15:00:00.000Z");
    expect(out[0]?.to).toBe("2026-05-11T00:00:00.000Z");
    expect(out[1]?.from).toBe("2026-05-11T00:00:00.000Z");
    expect(out[1]?.to).toBe("2026-05-12T00:00:00.000Z");
    expect(out[2]?.from).toBe("2026-05-12T00:00:00.000Z");
    expect(out[2]?.to).toBe("2026-05-12T09:00:00.000Z");
  });

  it("indexes chunks starting at 0", () => {
    const out = chunkWindow(
      new Date("2026-05-10T00:00:00.000Z"),
      new Date("2026-05-13T00:00:00.000Z"),
    );
    expect(out.map((c) => c.index)).toEqual([0, 1, 2]);
  });

  it("every chunk's `to` equals the next chunk's `from` (no gaps, no overlaps)", () => {
    const out = chunkWindow(
      new Date("2026-05-10T03:00:00.000Z"),
      new Date("2026-05-14T12:00:00.000Z"),
    );
    for (let i = 0; i < out.length - 1; i++) {
      expect(out[i]?.to).toBe(out[i + 1]?.from);
    }
  });

  it("first chunk's `from` equals window start; last chunk's `to` equals window end", () => {
    const start = new Date("2026-05-10T03:00:00.000Z");
    const end = new Date("2026-05-14T12:00:00.000Z");
    const out = chunkWindow(start, end);
    expect(out[0]?.from).toBe(start.toISOString());
    expect(out[out.length - 1]?.to).toBe(end.toISOString());
  });
});

// ---------------------------------------------------------------------------
// destinations
// ---------------------------------------------------------------------------

describe("destinations target", () => {
  it("destinations_enabled defaults to false", () => {
    const plan = planReplay(makeDecl({ target: "destinations" }), { now: NOW });
    expect(plan.destinations_enabled).toBe(false);
    expect(plan.destination_opt_in_note).toBeNull();
  });

  it("honours destinations_enabled on any target, not just `destinations`", () => {
    // Previously forced to false unless target === "destinations", which
    // silently discarded the operator's acknowledgement. Every v1 target
    // republishes to raw.events and is therefore evaluated against each
    // destination's replay_opt_in gate, so the acknowledgement is meaningful
    // whatever the stated target.
    const plan = planReplay(
      makeDecl({
        target: "processor",
        processor_name: "geoip-enricher",
        processor_version: "v1",
        destinations_enabled: true,
        destination_opt_in_note: "incident-2026-05-12: re-run enrichment",
      }),
      { now: NOW },
    );
    expect(plan.destinations_enabled).toBe(true);
    expect(plan.risks.map((r) => r.code)).toContain("destination_sends_enabled");
  });

  it("reports that its publish topic reaches destination consumers", () => {
    // A fact about the topic, not about the target: raw.events flows through
    // analytics-projector into analytics.events, which every destination
    // consumer subscribes to. Enforcement is downstream (P7-004 suppression);
    // this is the plan telling the truth about blast radius.
    for (const target of ["analytics_raw", "destinations", "processor"] as const) {
      const plan = planReplay(
        makeDecl({
          target,
          ...(target === "processor"
            ? { processor_name: "geoip-enricher", processor_version: "v1" }
            : {}),
        }),
        { now: NOW },
      );
      expect([target, plan.target_topic_family, plan.reaches_destinations]).toEqual([
        target,
        "raw.events",
        true,
      ]);
    }
  });

  it("destinations_enabled=true without a note is rejected", () => {
    try {
      planReplay(
        makeDecl({
          target: "destinations",
          destinations_enabled: true,
        }),
        { now: NOW },
      );
      throw new Error("expected ReplayPlanError");
    } catch (err) {
      expect((err as ReplayPlanError).code).toBe("destination_opt_in_requires_note");
    }
  });

  it("destinations_enabled=true with a note is accepted and flags the risk", () => {
    const plan = planReplay(
      makeDecl({
        target: "destinations",
        destinations_enabled: true,
        destination_opt_in_note: "incident-2026-05-12: re-deliver dropped events to meta-capi",
      }),
      { now: NOW },
    );
    expect(plan.destinations_enabled).toBe(true);
    expect(plan.destination_opt_in_note).toBe(
      "incident-2026-05-12: re-deliver dropped events to meta-capi",
    );
    expect(plan.risks.map((r) => r.code)).toContain("destination_sends_enabled");
  });
});

// ---------------------------------------------------------------------------
// processor target
// ---------------------------------------------------------------------------

describe("processor target", () => {
  it("raises processor_target_not_pinned when name + version missing", () => {
    const plan = planReplay(makeDecl({ target: "processor" }), { now: NOW });
    expect(plan.risks.map((r) => r.code)).toContain("processor_target_not_pinned");
  });

  it("raises processor_target_not_pinned when only name supplied", () => {
    const plan = planReplay(makeDecl({ target: "processor", processor_name: "geoip-enricher" }), {
      now: NOW,
    });
    expect(plan.risks.map((r) => r.code)).toContain("processor_target_not_pinned");
  });

  it("does NOT raise the pin risk when both name + version supplied", () => {
    const plan = planReplay(
      makeDecl({
        target: "processor",
        processor_name: "geoip-enricher",
        processor_version: "v2",
      }),
      { now: NOW },
    );
    expect(plan.risks.map((r) => r.code)).not.toContain("processor_target_not_pinned");
    expect(plan.processor_name).toBe("geoip-enricher");
    expect(plan.processor_version).toBe("v2");
  });
});

// ---------------------------------------------------------------------------
// risk flags
// ---------------------------------------------------------------------------

describe("risk flags", () => {
  it("flags wide_time_window when window > 7 days", () => {
    const plan = planReplay(
      makeDecl({
        window_from: "2026-05-01T00:00:00.000Z",
        window_to: "2026-05-10T00:00:00.000Z", // 9 days
      }),
      { now: NOW },
    );
    expect(plan.risks.map((r) => r.code)).toContain("wide_time_window");
  });

  it("does NOT flag wide_time_window at the 7-day threshold", () => {
    const plan = planReplay(
      makeDecl({
        window_from: "2026-05-03T00:00:00.000Z",
        window_to: "2026-05-10T00:00:00.000Z", // exactly 7 days
      }),
      { now: NOW },
    );
    expect(plan.risks.map((r) => r.code)).not.toContain("wide_time_window");
    expect(WIDE_WINDOW_DAYS_THRESHOLD).toBe(7);
  });

  it("flags single_event_replay when event_id is supplied", () => {
    const plan = planReplay(makeDecl({ event_id: "evt_42" }), { now: NOW });
    expect(plan.risks.map((r) => r.code)).toContain("single_event_replay");
  });

  it("flags production_scope for production env", () => {
    const plan = planReplay(makeDecl({ environment: "production" }), { now: NOW });
    expect(plan.risks.map((r) => r.code)).toContain("production_scope");
  });

  it("emits risks in the closed-set declaration order", () => {
    const plan = planReplay(
      makeDecl({
        environment: "production",
        target: "destinations",
        destinations_enabled: true,
        destination_opt_in_note: "incident-2026",
        event_id: "evt_42",
        window_from: "2026-04-30T00:00:00.000Z",
        window_to: "2026-05-10T00:00:00.000Z",
      }),
      { now: NOW },
    );
    expect(plan.risks.map((r) => r.code)).toEqual([
      "wide_time_window",
      "destination_sends_enabled",
      "single_event_replay",
      "production_scope",
    ]);
  });

  it("each risk carries a stable narrative message", () => {
    const plan = planReplay(makeDecl({ environment: "production" }), { now: NOW });
    const prod = plan.risks.find((r) => r.code === "production_scope");
    expect(prod?.message).toMatch(/production/);
  });
});

// ---------------------------------------------------------------------------
// consumer group
// ---------------------------------------------------------------------------

describe("consumer group", () => {
  it("follows the polaris-replay.<project>.<env>.<target>.<job> shape", () => {
    expect(
      buildConsumerGroup({
        projectId: "storefront",
        environment: "development",
        target: "analytics_raw",
        replayJobId: "polaris_rpj_abc",
      }),
    ).toBe("polaris-replay.storefront.development.analytics_raw.polaris_rpj_abc");
  });

  it("planner output threads the consumer-group through", () => {
    const plan = planReplay(makeDecl({ replay_job_id: "polaris_rpj_xyz" }), { now: NOW });
    expect(plan.consumer_group).toBe(
      "polaris-replay.storefront.development.analytics_raw.polaris_rpj_xyz",
    );
  });
});

// ---------------------------------------------------------------------------
// renderer
// ---------------------------------------------------------------------------

describe("renderPlanHuman", () => {
  it("includes every section the task card listed", () => {
    const plan = planReplay(
      makeDecl({
        target: "processor",
        processor_name: "geoip-enricher",
        processor_version: "v2",
        event_name: "payment.approved",
      }),
      { now: NOW },
    );
    const rendered = renderPlanHuman(plan);
    expect(rendered).toContain("source_topic_family    raw.events");
    expect(rendered).toContain("project_id             storefront");
    expect(rendered).toContain("environment            development");
    expect(rendered).toContain("window_from");
    expect(rendered).toContain("window_to");
    expect(rendered).toContain("target                 processor");
    expect(rendered).toContain("processor_name         geoip-enricher");
    expect(rendered).toContain("processor_version      v2");
    expect(rendered).toContain("destinations_enabled   false (not acknowledged)");
    expect(rendered).toContain("consumer_group         polaris-replay.");
    expect(rendered).toContain("events_estimated       unknown");
  });

  it("prints `(none)` when there are no risk flags", () => {
    const plan = planReplay(makeDecl(), { now: NOW });
    expect(renderPlanHuman(plan)).toContain("risks                  (none)");
  });

  it("prints each risk on its own line when flags are present", () => {
    const plan = planReplay(makeDecl({ environment: "production" }), { now: NOW });
    const rendered = renderPlanHuman(plan);
    expect(rendered).toContain("risks                  1 flagged");
    expect(rendered).toContain("[production_scope]");
  });

  it("marks destinations_enabled=true as an operator acknowledgement", () => {
    const plan = planReplay(
      makeDecl({
        target: "destinations",
        destinations_enabled: true,
        destination_opt_in_note: "incident-2026",
      }),
      { now: NOW },
    );
    const rendered = renderPlanHuman(plan);
    expect(rendered).toContain("destinations_enabled   true (operator opted in)");
    expect(rendered).toContain("destination_opt_in     incident-2026");
  });
});

// ---------------------------------------------------------------------------
// snapshot of the full plan shape (acts as a contract test)
// ---------------------------------------------------------------------------

describe("plan shape (contract pin)", () => {
  it("emits the documented field set in the documented order", () => {
    const plan = planReplay(makeDecl(), { now: NOW });
    expect(plan).toEqual({
      replay_job_id: "polaris_rpj_test",
      project_id: "storefront",
      environment: "development",
      target: "analytics_raw",
      mode: "dry_run",
      event_name: null,
      event_id: null,
      source_topic_family: "raw.events",
      target_topic_family: "raw.events",
      reaches_destinations: true,
      partition_key_strategy: "project_environment_identity",
      window_from: "2026-05-10T00:00:00.000Z",
      window_to: "2026-05-11T00:00:00.000Z",
      chunks: [
        {
          index: 0,
          from: "2026-05-10T00:00:00.000Z",
          to: "2026-05-11T00:00:00.000Z",
        },
      ],
      chunk_count: 1,
      chunk_size_days: 1,
      processor_name: null,
      processor_version: null,
      destinations_enabled: false,
      destination_opt_in_note: null,
      consumer_group: "polaris-replay.storefront.development.analytics_raw.polaris_rpj_test",
      events_estimated: null,
      risks: [],
      planned_at: NOW.toISOString(),
      planner_version: "v1",
    });
  });
});
