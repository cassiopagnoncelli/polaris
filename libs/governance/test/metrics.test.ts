import { describe, expect, it, vi } from "vitest";

import {
  emitAllRedactionMetrics,
  emitRedactionMetric,
  evaluate,
  type PatternRedactionMetricIncrement,
  POLARIS_INGEST_REDACTED_PATTERN_TOTAL,
  type RedactionAction,
} from "../src/index.js";
import { buildEvent, syntheticLuhn } from "./fixtures.js";

describe("emitRedactionMetric", () => {
  const context = { project_id: "checkout", environment: "production" } as const;

  it("emits the canonical metric name and labels for a pattern redaction", () => {
    const action: RedactionAction = {
      path: ["properties", "notes"],
      reason: "pii_card",
      source: "pattern",
      pattern: "luhn_pan",
      replacement: "[REDACTED:pii_card]",
    };
    const incrementCounter = vi.fn();
    const increment = emitRedactionMetric(action, context, { incrementCounter });
    expect(increment).toBeDefined();
    expect(increment?.name).toBe(POLARIS_INGEST_REDACTED_PATTERN_TOTAL);
    expect(increment?.labels).toEqual({
      project_id: "checkout",
      environment: "production",
      reason: "pii_card",
      pattern: "luhn_pan",
    });
    expect(incrementCounter).toHaveBeenCalledWith(increment);
  });

  it("does not emit a metric for a named-field redaction", () => {
    const action: RedactionAction = {
      path: ["properties", "card_number"],
      reason: "pii_card",
      source: "named",
      replacement: "[REDACTED:pii_card]",
    };
    const incrementCounter = vi.fn();
    const increment = emitRedactionMetric(action, context, { incrementCounter });
    expect(increment).toBeUndefined();
    expect(incrementCounter).not.toHaveBeenCalled();
  });

  it("emits a debug log line without the raw value", () => {
    const action: RedactionAction = {
      path: ["properties", "notes"],
      reason: "pii_card",
      source: "pattern",
      pattern: "luhn_pan",
      replacement: "[REDACTED:pii_card]",
    };
    const debug = vi.fn();
    emitRedactionMetric(action, context, { logger: { debug } });
    expect(debug).toHaveBeenCalledTimes(1);
    const [arg] = debug.mock.calls[0] as [Record<string, unknown>, string];
    // The log line carries metric / labels / path — but no raw value.
    expect(arg).toHaveProperty("metric", POLARIS_INGEST_REDACTED_PATTERN_TOTAL);
    expect(arg).toHaveProperty("path", ["properties", "notes"]);
    expect(JSON.stringify(arg)).not.toContain("REDACTED");
    // Defensive: the structured log carries no leak of the original value
    // because the action only ever held the replacement sentinel anyway.
    expect(arg).not.toHaveProperty("value");
  });

  it("labels for a Luhn PAN match in an unexpected field include reason=pii_card", () => {
    const pan = syntheticLuhn(16);
    const event = buildEvent({ properties: { notes: pan } });
    const decision = evaluate(event);
    expect(decision.decision).toBe("accept");
    if (decision.decision !== "accept") return;
    const incs: PatternRedactionMetricIncrement[] = [];
    emitAllRedactionMetrics(decision.redactions, context, {
      incrementCounter: (inc) => incs.push(inc),
    });
    expect(incs).toHaveLength(1);
    expect(incs[0]?.labels.reason).toBe("pii_card");
    expect(incs[0]?.labels.pattern).toBe("luhn_pan");
    // The PAN value never appears anywhere in the metric labels.
    expect(JSON.stringify(incs[0]?.labels)).not.toContain(pan.slice(0, 6));
  });
});

describe("emitAllRedactionMetrics", () => {
  const context = { project_id: "checkout", environment: "production" } as const;

  it("only emits metrics for pattern-source actions", () => {
    const actions: RedactionAction[] = [
      {
        path: ["properties", "card_number"],
        reason: "pii_card",
        source: "named",
        replacement: "[REDACTED:pii_card]",
      },
      {
        path: ["properties", "notes"],
        reason: "pii_card",
        source: "pattern",
        pattern: "luhn_pan",
        replacement: "[REDACTED:pii_card]",
      },
    ];
    const incs = emitAllRedactionMetrics(actions, context);
    expect(incs).toHaveLength(1);
    expect(incs[0]?.labels.pattern).toBe("luhn_pan");
  });
});
