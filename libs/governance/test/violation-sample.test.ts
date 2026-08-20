/**
 * The quarantine's PII discipline.
 *
 * These are the acceptance criterion, not a nicety. The sample is the one
 * place in Polaris where a payload known to violate policy is deliberately
 * persisted, and the whole design rests on it being safe by construction
 * rather than by a caller remembering to be careful.
 */

import { describe, expect, it } from "vitest";

import { buildViolationSample, evaluate, serialiseViolationSample } from "../src/evaluator.js";

/** Matches the private marker in `evaluator.ts`. */
const SAMPLE_ELIDED = "[ELIDED]";

const PAN = "4111111111111111";

describe("the rejecting field never lands raw", () => {
  it("replaces a rejecting cvv with the sentinel, keeping the key", () => {
    // `cvv` is a REJECT rule (see policy.ts): its presence is why the
    // event was refused. The key IS the diagnostic — "your integration is
    // sending cvv" — and the value never is.
    const { sample, redactedPaths } = buildViolationSample({
      event: "purchase",
      properties: { cvv: "123", total: 12.5 },
    });

    const properties = sample["properties"] as Record<string, unknown>;
    expect(properties["cvv"]).toMatch(/^\[REDACTED:/);
    expect(redactedPaths).toContain("properties.cvv");
    expect(JSON.stringify(sample)).not.toContain('"123"');
  });

  it("redacts card_number too, which is a redact-named rule rather than a reject", () => {
    // Both classes of rule land in the sample as sentinels. The
    // distinction matters to the ingester's decision, not to what may be
    // persisted.
    const { sample } = buildViolationSample({
      event: "purchase",
      properties: { card_number: PAN, card_first6: "411111" },
    });

    const properties = sample["properties"] as Record<string, unknown>;
    expect(properties["card_number"]).toMatch(/^\[REDACTED:/);
    // The partials a producer is SUPPOSED to send survive.
    expect(properties["card_first6"]).toBe("411111");
    expect(JSON.stringify(sample)).not.toContain(PAN);
  });

  it("keeps redacting AFTER the rejecting field, which `evaluate` cannot", () => {
    // The load-bearing test. `evaluate` short-circuits on the first reject
    // and returns NO redactions, so a sample built from its list would
    // store everything else raw. Asserting both halves here is what keeps
    // that from passing by accident.
    const event = {
      event: "purchase",
      properties: { cvv: "123", card_number: PAN, password: "hunter2" },
    };

    const decision = evaluate(event);
    expect(decision.decision).toBe("reject");
    // Proof the shortcut is real: nothing else was collected.
    expect("redactions" in decision).toBe(false);

    const { sample } = buildViolationSample(event);
    const properties = sample["properties"] as Record<string, unknown>;
    expect(properties["cvv"]).toMatch(/^\[REDACTED:/);
    expect(properties["card_number"]).toMatch(/^\[REDACTED:/);
    expect(properties["password"]).toMatch(/^\[REDACTED:/);
    const encoded = JSON.stringify(sample);
    expect(encoded).not.toContain(PAN);
    expect(encoded).not.toContain("hunter2");
  });

  it("redacts a PAN hiding in a free-text field, not just in a named one", () => {
    // Pattern detectors run on VALUES, so a card number pasted into a
    // note is caught by the same rules — and would not be caught at all
    // by a sample that only looked at the rejecting path.
    const { sample, redactedPaths } = buildViolationSample({
      event: "purchase",
      properties: { cvv: "999", note: `charge ${PAN} please` },
    });

    expect(JSON.stringify(sample)).not.toContain(PAN);
    expect(redactedPaths).toContain("properties.note");
  });

  it("survives a rejecting field at the top level", () => {
    const { sample } = buildViolationSample({ event: "purchase", cvv: "123" });
    expect(sample["cvv"]).toMatch(/^\[REDACTED:/);
  });

  it("redacts inside arrays", () => {
    // A batch of line items is the obvious place for a producer to put a
    // payment field, and an array walk that skipped indices would miss it.
    const { sample, redactedPaths } = buildViolationSample({
      event: "purchase",
      properties: { items: [{ sku: "a", cvv: "123" }, { sku: "b" }] },
    });

    expect(JSON.stringify(sample)).not.toContain("123");
    expect(redactedPaths).toContain("properties.items.0.cvv");
  });
});

describe("what the sample keeps", () => {
  it("keeps types, because the shape is the diagnostic", () => {
    // "total came through as a string" is the single most common
    // integration bug, and it is invisible in a sample that stringifies
    // every leaf.
    const { sample } = buildViolationSample({
      event: "purchase",
      properties: { total: "12.50", quantity: 3, gift: false, coupon: null },
    });

    const properties = sample["properties"] as Record<string, unknown>;
    expect(properties["total"]).toBe("12.50");
    expect(properties["quantity"]).toBe(3);
    expect(properties["gift"]).toBe(false);
    expect(properties["coupon"]).toBeNull();
  });

  it("does not mutate the input", () => {
    const event = { event: "purchase", properties: { cvv: "123" } };
    buildViolationSample(event);
    expect(event.properties.cvv).toBe("123");
  });

  it("names an exotic value by type rather than serialising it", () => {
    // `toJSON` on an unknown object is arbitrary code's idea of what to
    // disclose.
    const { sample } = buildViolationSample({
      event: "purchase",
      when: new Date("2026-08-15T00:00:00.000Z"),
    });
    expect(sample["when"]).toBe("[object]");
  });
});

describe("bounds", () => {
  it("truncates a long string leaf", () => {
    // A free-text field cannot dump a paragraph into the quarantine.
    const { sample } = buildViolationSample(
      { event: "purchase", properties: { note: "x".repeat(500) } },
      { maxStringLength: 10 },
    );
    const properties = sample["properties"] as Record<string, unknown>;
    expect(properties["note"]).toBe(`${"x".repeat(10)}…(+490)`);
  });

  it("elides past the depth cap", () => {
    const deep = { a: { b: { c: { d: { e: "leaf" } } } } };
    const { sample } = buildViolationSample({ event: "x", deep }, { maxDepth: 3 });
    expect(JSON.stringify(sample)).toContain(SAMPLE_ELIDED);
    expect(JSON.stringify(sample)).not.toContain("leaf");
  });

  it("caps array length and says it did", () => {
    const { sample } = buildViolationSample(
      { event: "x", items: [1, 2, 3, 4, 5] },
      { maxArrayLength: 2 },
    );
    expect(sample["items"]).toEqual([1, 2, SAMPLE_ELIDED]);
  });

  it("caps key count and says how many it dropped", () => {
    const wide: Record<string, unknown> = { event: "x" };
    for (let index = 0; index < 10; index += 1) wide[`k${String(index)}`] = index;
    const { sample } = buildViolationSample(wide, { maxKeys: 3 });
    expect(sample[SAMPLE_ELIDED]).toBe("8 more key(s)");
  });
});

describe("serialiseViolationSample", () => {
  it("returns JSON under the cap unchanged", () => {
    const encoded = serialiseViolationSample({ event: "purchase" });
    expect(JSON.parse(encoded)).toEqual({ event: "purchase" });
  });

  it("replaces an oversized sample wholesale rather than truncating it", () => {
    // A truncated JSON document is not JSON, and every reader would have
    // to special-case it.
    const big = { event: "purchase", blob: "x".repeat(20_000) };
    const encoded = serialiseViolationSample(big, 1_000);
    const parsed = JSON.parse(encoded) as Record<string, unknown>;
    expect(parsed[SAMPLE_ELIDED]).toContain("exceeded 1000 bytes");
    expect(parsed["keys"]).toEqual(["event", "blob"]);
  });
});
