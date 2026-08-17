/**
 * Every emission carries the per-event scope.
 *
 * This suite exists because of a defect that was invisible to every
 * other kind of check. The stage emitted its counters with only
 * `(processor_name, processor_version)`, which typechecks, runs, and
 * produces perfectly good series — that no dashboard can select. A
 * Prometheus matcher like `environment="production"` does not match a
 * series carrying no `environment` label at all, so every panel on the
 * spine dashboard read empty while the stage was healthy.
 *
 * An empty panel is the most misleading state a dashboard has: it reads
 * as "nothing is happening" when it means "I cannot see anything". So
 * the labels are asserted here rather than left to be noticed in an
 * incident.
 */

import { sharedOnlyIsolationLookup } from "@polaris/shared-transport";
import { describe, expect, it } from "vitest";

import { handleEvent, type StageMetricScope } from "../src/runtime.js";
import { InMemoryProfileRepository, RecordingProducer, silentLogger } from "./fakes.js";

const POLICY = {
  denylist: {},
  maxIdentifiersPerKind: 100,
  maxMergesPerWindow: 50,
  mergeWindowSeconds: 3600,
  maxTraitsBytes: 32_768,
};

/** Records the scope every callback was handed. */
function recordingMetrics() {
  const seen: Array<{ call: string; scope: StageMetricScope; detail?: string }> = [];
  return {
    seen,
    metrics: {
      onConsumed: (scope: StageMetricScope) => seen.push({ call: "consumed", scope }),
      onEmitted: (scope: StageMetricScope) => seen.push({ call: "emitted", scope }),
      onSkipped: (scope: StageMetricScope, reason: string) =>
        seen.push({ call: "skipped", scope, detail: reason }),
      onFailed: (scope: StageMetricScope, reason: string) =>
        seen.push({ call: "failed", scope, detail: reason }),
      onOutcome: (scope: StageMetricScope, outcome: string) =>
        seen.push({ call: "outcome", scope, detail: outcome }),
    },
  };
}

function deps(metrics: ReturnType<typeof recordingMetrics>["metrics"]) {
  return {
    repository: new InMemoryProfileRepository(),
    producer: new RecordingProducer(),
    isolation: sharedOnlyIsolationLookup,
    logger: silentLogger,
    metrics,
    policyFor: () => POLICY,
    runId: () => "run_1",
    now: () => new Date("2026-08-14T00:00:00.000Z"),
  };
}

function event(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_id: "019ffe00-0000-7000-8000-000000000001",
    event: "page.viewed",
    schema_version: 1,
    project_id: "storefront",
    environment: "development",
    occurred_at: "2026-08-14T00:00:00.000Z",
    ingested_at: "2026-08-14T00:00:01.000Z",
    source: { type: "browser", id: "storefront-web" },
    identity: { anonymous_id: "anon_1", session_id: null, customer_id: null, device_id: null },
    context: { ip: null, user_agent: null, locale: null, page: null, campaign: null },
    properties: {},
    ...overrides,
  };
}

describe("metric labels", () => {
  it("stamps project and environment on every emission", async () => {
    const { seen, metrics } = recordingMetrics();
    await handleEvent(deps(metrics), event());

    expect(seen.length).toBeGreaterThan(0);
    for (const entry of seen) {
      expect(entry.scope.project_id, entry.call).toBe("storefront");
      expect(entry.scope.environment, entry.call).toBe("development");
    }
  });

  it("takes the scope from the EVENT, not from a service-wide default", async () => {
    // One deployment can see more than one project, and the activation
    // gate is consulted per event with the event's own scope. A counter
    // labelled from the service config would disagree with the gate that
    // decided whether the event was processed at all.
    const { seen, metrics } = recordingMetrics();
    await handleEvent(
      deps(metrics),
      event({ project_id: "other-project", environment: "staging" }),
    );

    for (const entry of seen) {
      expect(entry.scope.project_id, entry.call).toBe("other-project");
      expect(entry.scope.environment, entry.call).toBe("staging");
    }
  });

  it("labels the safeguard skips the alert and dashboard select on", async () => {
    // `merge_suspended` is what `PolarisIdentityMergeBreakerTripped`
    // fires on, and the alert groups by environment. Unlabelled, the
    // alert still fires but names an empty environment in its summary —
    // which is the one thing an on-call needs from it at 3am.
    const { seen, metrics } = recordingMetrics();
    const d = deps(metrics);
    const denyPolicy = { ...POLICY, maxMergesPerWindow: 1 };
    const withPolicy = { ...d, policyFor: () => denyPolicy };

    await handleEvent(withPolicy, event({ identity: identity({ anonymous_id: "a1" }) }));
    await handleEvent(withPolicy, event({ identity: identity({ customer_id: "c1" }) }));
    await handleEvent(
      withPolicy,
      event({ identity: identity({ anonymous_id: "a1", customer_id: "c1" }) }),
    );
    await handleEvent(withPolicy, event({ identity: identity({ anonymous_id: "a2" }) }));
    await handleEvent(
      withPolicy,
      event({ identity: identity({ anonymous_id: "a2", customer_id: "c1" }) }),
    );

    const suspended = seen.filter((e) => e.detail === "merge_suspended");
    expect(suspended.length).toBeGreaterThan(0);
    for (const entry of suspended) {
      expect(entry.scope.environment).toBe("development");
      expect(entry.scope.project_id).toBe("storefront");
    }
  });

  it("records the decision, not just that an event was emitted", async () => {
    // A merge and an ordinary bind both emit exactly one spine event, so
    // `emitted` cannot tell them apart — which is why the outcome
    // counter exists and why the merge-rate panel reads it.
    const { seen, metrics } = recordingMetrics();
    const d = deps(metrics);
    await handleEvent(d, event({ identity: identity({ anonymous_id: "a1" }) }));
    await handleEvent(d, event({ identity: identity({ customer_id: "c1" }) }));
    await handleEvent(d, event({ identity: identity({ anonymous_id: "a1", customer_id: "c1" }) }));

    const outcomes = seen.filter((e) => e.call === "outcome").map((e) => e.detail);
    expect(outcomes).toContain("merged");
    expect(outcomes).toContain("created");
  });
});

function identity(over: Record<string, string | null>): Record<string, unknown> {
  return { anonymous_id: null, session_id: null, customer_id: null, device_id: null, ...over };
}
