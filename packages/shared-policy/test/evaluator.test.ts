import { describe, expect, it } from "vitest";

import { applyRedactions, evaluate, redactionSentinel } from "../src/index.js";
import { buildEvent, syntheticLuhn } from "./fixtures.js";

describe("evaluate — named reject rules", () => {
  it("rejects an event carrying a top-level cvv", () => {
    const event = buildEvent({ properties: { cvv: "123", amount: 100 } });
    const decision = evaluate(event);
    expect(decision.decision).toBe("reject");
    if (decision.decision !== "reject") return;
    expect(decision.reason).toBe("pii_card");
    expect(decision.path).toEqual(["properties", "cvv"]);
  });

  it("rejects an event carrying a password nested under properties", () => {
    const event = buildEvent({
      properties: { user: { password: "anything", name: "alice" } },
    });
    const decision = evaluate(event);
    expect(decision.decision).toBe("reject");
    if (decision.decision !== "reject") return;
    expect(decision.reason).toBe("pii_secret");
    expect(decision.path).toEqual(["properties", "user", "password"]);
  });

  it("is case-insensitive on the field name", () => {
    const event = buildEvent({ properties: { CVV: "123" } });
    const decision = evaluate(event);
    expect(decision.decision).toBe("reject");
  });

  it("rejects when the field path is deep inside the envelope", () => {
    const event = buildEvent({
      properties: {
        payment: {
          card_security_code: "999",
        },
      },
    });
    const decision = evaluate(event);
    expect(decision.decision).toBe("reject");
    if (decision.decision !== "reject") return;
    expect(decision.reason).toBe("pii_card");
  });
});

describe("evaluate — named redact rules", () => {
  it("redacts the named card_number field and keeps the event", () => {
    const event = buildEvent({
      properties: {
        card_number: "4242 4242 4242 4242",
        first6: "424242",
        last4: "4242",
      },
    });
    const decision = evaluate(event);
    expect(decision.decision).toBe("accept");
    if (decision.decision !== "accept") return;
    expect(decision.redactions).toHaveLength(1);
    const action = decision.redactions[0];
    expect(action?.source).toBe("named");
    expect(action?.reason).toBe("pii_card");
    expect(action?.path).toEqual(["properties", "card_number"]);
    expect(action?.replacement).toBe(redactionSentinel("pii_card"));
  });

  it("does not descend into a redacted subtree (avoids double-counting)", () => {
    const event = buildEvent({
      properties: {
        card_number: { full: "4242424242424242", weird_nested_secret: "ghp_aaaaaaaaaaaa" },
      },
    });
    const decision = evaluate(event);
    expect(decision.decision).toBe("accept");
    if (decision.decision !== "accept") return;
    // The named redaction fires on `card_number`; the nested ghp_ token
    // inside the subtree never produces a separate pattern redaction.
    expect(decision.redactions).toHaveLength(1);
    expect(decision.redactions[0]?.source).toBe("named");
  });
});

describe("evaluate — no-match case", () => {
  it("accepts an unproblematic event with empty redactions", () => {
    const event = buildEvent({
      properties: {
        amount: 12990,
        currency: "BRL",
        notes: "merchant note",
      },
    });
    const decision = evaluate(event);
    expect(decision.decision).toBe("accept");
    if (decision.decision !== "accept") return;
    expect(decision.redactions).toEqual([]);
  });

  it("passes a raw email through unchanged under platform defaults", () => {
    // Per the architecture: raw email is intentionally NOT redacted by
    // platform defaults. Only project overrides add this rule.
    const event = buildEvent({
      properties: {
        email: "customer@example.com",
        phone: "+5511999990000",
      },
    });
    const decision = evaluate(event);
    expect(decision.decision).toBe("accept");
    if (decision.decision !== "accept") return;
    expect(decision.redactions).toEqual([]);
  });
});

describe("evaluate — pattern redactions", () => {
  it("redacts a Luhn-valid PAN in an unexpected field with reason=pii_card", () => {
    const pan = syntheticLuhn(16);
    const event = buildEvent({
      properties: { notes: `customer mentioned ${pan} on the call` },
    });
    const decision = evaluate(event);
    expect(decision.decision).toBe("accept");
    if (decision.decision !== "accept") return;
    expect(decision.redactions).toHaveLength(1);
    const action = decision.redactions[0];
    expect(action?.source).toBe("pattern");
    expect(action?.reason).toBe("pii_card");
    expect(action?.pattern).toBe("luhn_pan");
    expect(action?.path).toEqual(["properties", "notes"]);
  });

  it("redacts an AWS access key in a config field with reason=pii_secret", () => {
    const event = buildEvent({
      properties: { config: "AWS_ACCESS_KEY=AKIAABCDEFGHIJKLMNOP" },
    });
    const decision = evaluate(event);
    expect(decision.decision).toBe("accept");
    if (decision.decision !== "accept") return;
    const action = decision.redactions.find((r) => r.pattern === "aws_access_key");
    expect(action).toBeDefined();
    expect(action?.reason).toBe("pii_secret");
  });

  it("redacts a GitHub token in a config field", () => {
    const event = buildEvent({
      properties: { config: `ghp_${"x".repeat(36)}` },
    });
    const decision = evaluate(event);
    expect(decision.decision).toBe("accept");
    if (decision.decision !== "accept") return;
    const action = decision.redactions.find((r) => r.pattern === "github_token");
    expect(action).toBeDefined();
    expect(action?.reason).toBe("pii_secret");
  });

  it("redacts a JWT shape outside identity.* but leaves identity.id_token alone", () => {
    const jwt = `${"a".repeat(20)}.${"b".repeat(40)}.${"c".repeat(40)}`;
    const event = buildEvent({
      identity: {
        anonymous_id: null,
        session_id: null,
        customer_id: jwt, // mock; producer wouldn't really put a JWT here
        device_id: null,
      },
      properties: { auth: jwt },
    });
    const decision = evaluate(event);
    expect(decision.decision).toBe("accept");
    if (decision.decision !== "accept") return;
    const patternRedactions = decision.redactions.filter((r) => r.source === "pattern");
    // Only the properties.auth redaction should fire — identity.* is exempted.
    expect(patternRedactions.length).toBeGreaterThanOrEqual(1);
    for (const r of patternRedactions) {
      expect(r.path[0]).not.toBe("identity");
    }
  });

  it("redacts a generic high-entropy secret in a config field", () => {
    const event = buildEvent({
      properties: {
        config: `key=ZmFrZS1zZWNyZXQtZm9yLXRlc3QtMTIzNDU2Nzg5MGFiY2RlZi8r`,
      },
    });
    const decision = evaluate(event);
    expect(decision.decision).toBe("accept");
    if (decision.decision !== "accept") return;
    const action = decision.redactions.find((r) => r.pattern === "high_entropy_secret");
    expect(action).toBeDefined();
    expect(action?.reason).toBe("pii_secret");
  });
});

describe("evaluate — determinism", () => {
  it("does not mutate the input event", () => {
    const event = buildEvent({
      properties: { card_number: "4242 4242 4242 4242" },
    });
    const before = JSON.parse(JSON.stringify(event)) as unknown;
    evaluate(event);
    expect(JSON.parse(JSON.stringify(event))).toEqual(before);
  });

  it("returns redactions in deterministic order across runs", () => {
    const pan = syntheticLuhn(16);
    const event = buildEvent({
      properties: {
        b_aws: "AKIAABCDEFGHIJKLMNOP",
        a_pan: pan,
      },
    });
    const first = evaluate(event);
    const second = evaluate(event);
    expect(first).toEqual(second);
    expect(first.decision).toBe("accept");
    if (first.decision !== "accept") return;
    const paths = first.redactions.map((r) => r.path.join("."));
    expect(paths).toEqual([...paths].sort());
  });
});

describe("applyRedactions", () => {
  it("returns a cloned event with redactions applied", () => {
    const pan = syntheticLuhn(16);
    const event = buildEvent({
      properties: { card_number: pan, currency: "USD" },
    });
    const decision = evaluate(event);
    if (decision.decision !== "accept") throw new Error("expected accept");
    const sanitised = applyRedactions(event, decision.redactions) as Record<
      string,
      Record<string, unknown>
    >;
    expect(sanitised.properties?.card_number).toBe("[REDACTED:pii_card]");
    expect(sanitised.properties?.currency).toBe("USD");
    // original untouched
    expect((event as Record<string, Record<string, unknown>>).properties?.card_number).toBe(pan);
  });

  it("tolerates missing intermediate keys", () => {
    const event = buildEvent({ properties: {} });
    const result = applyRedactions(event, [
      {
        path: ["properties", "deeply", "missing", "value"],
        reason: "pii_secret",
        source: "named",
        replacement: "[REDACTED:pii_secret]",
      },
    ]);
    expect(result).toBeDefined();
  });
});
