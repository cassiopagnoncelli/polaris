/**
 * The Variables panel's decision logic.
 *
 * The panel is server-rendered HTML with no client behaviour, so the things
 * worth testing are the three judgements it makes: what the effective view
 * contains, when the typed-confirmation ritual applies, and how a form value
 * becomes a stored one. Rendering is exercised through the existing admin-ui
 * suite; asserting on markup here would pin the stylesheet, not the contract.
 */

import type { ProjectConfigRow } from "@polaris/shared-control-plane-db";
import { describe, expect, it } from "vitest";
import {
  buildEffectiveView,
  declaredKeyFacts,
  needsConfirmation,
  parseConfigEnvironment,
  parseConfigFormValue,
  parseWriteEnvironment,
} from "../src/admin/pages/project-config.js";

function row(overrides: Partial<ProjectConfigRow> = {}): ProjectConfigRow {
  return {
    project_id: "storefront",
    environment: "production",
    namespace: "ingest",
    config_key: "dedupe_window_sec",
    value: 3600,
    is_secret: false,
    updated_at: "2026-08-13T12:00:00.000Z",
    updated_by: "cassio@example.com",
    ...overrides,
  };
}

describe("buildEffectiveView", () => {
  it("shows a declared key with no stored value, so the page answers the real question", () => {
    // An operator asking "what is this project's dedupe window?" needs the
    // component default when nothing is stored — a table of stored rows only
    // would leave the question unanswered.
    const entries = buildEffectiveView([]);
    const dedupe = entries.find((entry) => entry.key === "dedupe_window_sec");
    expect(dedupe).toBeDefined();
    expect(dedupe?.stored).toBeUndefined();
    expect(dedupe?.declared?.type).toBe("integer");
  });

  it("pairs a stored value with its declaration", () => {
    const entries = buildEffectiveView([row()]);
    const dedupe = entries.find((entry) => entry.key === "dedupe_window_sec");
    expect(dedupe?.stored?.value).toBe(3600);
    expect(dedupe?.declared).toBeDefined();
  });

  it("keeps a key no component schema declares, flagged rather than dropped", () => {
    // Free-form keys are the requirement's Vercel-style declaration and the
    // hook for client-owned consumers; hiding them would make a stored value
    // invisible to the operator who stored it.
    const entries = buildEffectiveView([
      row({ namespace: "future-client", config_key: "some_key", value: "x" }),
    ]);
    const freeForm = entries.find((entry) => entry.key === "some_key");
    expect(freeForm).toBeDefined();
    expect(freeForm?.declared).toBeUndefined();
    expect(freeForm?.stored?.value).toBe("x");
  });

  it("does not duplicate a declared key that also has a stored value", () => {
    const entries = buildEffectiveView([row()]);
    expect(entries.filter((entry) => entry.key === "dedupe_window_sec")).toHaveLength(1);
  });
});

describe("needsConfirmation", () => {
  it("demands the ritual for unsetting a required key", () => {
    expect(
      needsConfirmation({
        action: "unset",
        environment: "production",
        secret: false,
        required: true,
      }),
    ).toBe(true);
  });

  it("demands the ritual for a production secret reference", () => {
    expect(
      needsConfirmation({
        action: "set",
        environment: "production",
        secret: true,
        required: false,
      }),
    ).toBe(true);
  });

  it("does NOT demand it for an ordinary value edit", () => {
    // The point of the asymmetry: a ritual on every edit is a ritual
    // operators learn to type past, which costs it its meaning on the two
    // changes that actually need it.
    expect(
      needsConfirmation({
        action: "set",
        environment: "production",
        secret: false,
        required: true,
      }),
    ).toBe(false);
    expect(
      needsConfirmation({
        action: "unset",
        environment: "production",
        secret: false,
        required: false,
      }),
    ).toBe(false);
  });

  it("does not demand it for a secret outside production", () => {
    expect(
      needsConfirmation({ action: "set", environment: "staging", secret: true, required: false }),
    ).toBe(false);
  });
});

describe("parseConfigEnvironment", () => {
  it("accepts each row environment", () => {
    for (const env of ["development", "staging", "production"]) {
      expect(parseConfigEnvironment(env)).toBe(env);
    }
  });

  it("falls back to development rather than erroring", () => {
    // The tab is a display affordance; an unknown value should land the
    // operator somewhere safe. A write to a bogus environment is refused by
    // the CHECK constraint regardless.
    for (const bad of [undefined, "", "prod", "local", "test", "  "]) {
      expect(parseConfigEnvironment(bad)).toBe("development");
    }
  });
});

describe("parseWriteEnvironment", () => {
  it("accepts each row environment", () => {
    for (const env of ["development", "staging", "production"]) {
      expect(parseWriteEnvironment(env)).toBe(env);
    }
  });

  it("returns null for anything else — a typoed WRITE must fail, never fall back", () => {
    // The lenient parse exists for the GET tab, where an unknown value should
    // land the operator somewhere safe. A POST that "fell back" would write
    // to a different environment than the operator addressed.
    for (const bad of ["", "prodution", "local", "test", "PRODUCTION"]) {
      expect(parseWriteEnvironment(bad)).toBeNull();
    }
  });
});

describe("declaredKeyFacts", () => {
  it("reports a declared, non-secret, optional key", () => {
    expect(declaredKeyFacts("ingest", "rate_limit_rps")).toEqual({
      declared: true,
      secret: false,
      required: false,
    });
  });

  it("reports an undeclared key as such", () => {
    expect(declaredKeyFacts("ingest", "nope")).toEqual({
      declared: false,
      secret: false,
      required: false,
    });
    expect(declaredKeyFacts("unknown-namespace", "anything")).toEqual({
      declared: false,
      secret: false,
      required: false,
    });
  });
});

describe("parseConfigFormValue", () => {
  it("parses JSON when it parses", () => {
    expect(parseConfigFormValue("5000", false)).toBe(5000);
    expect(parseConfigFormValue("true", false)).toBe(true);
    expect(parseConfigFormValue('["a","b"]', false)).toEqual(["a", "b"]);
  });

  it("keeps a non-JSON string a string", () => {
    expect(parseConfigFormValue("graph.facebook.com", false)).toBe("graph.facebook.com");
  });

  it("reads an empty box as null, which is a value and not an absence", () => {
    // `null` and unset are different answers: unset deletes the row and the
    // component falls back to its own default, while null is a stored
    // decision that nothing is configured. The field used to be `required`,
    // so an operator could not express the second at all.
    expect(parseConfigFormValue("", false)).toBeNull();
  });

  it("keeps a typed `null` and an empty box the same value", () => {
    expect(parseConfigFormValue("null", false)).toBeNull();
  });

  it("never coerces a secret reference", () => {
    // A ref that happens to look numeric is still a ref; coercing it would
    // produce a value the secret-ref CHECK rejects, with a confusing message.
    expect(parseConfigFormValue("vault:polaris/prod/x", true)).toBe("vault:polaris/prod/x");
    expect(parseConfigFormValue("12345", true)).toBe("12345");
  });
});
