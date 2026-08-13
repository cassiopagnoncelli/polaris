import { describe, expect, it } from "vitest";
import {
  assertNoMappingSemantics,
  FORBIDDEN_MAPPING_FLAG_TOKENS,
  isMappingToken,
  MappingSemanticsError,
  normaliseMappingToken,
} from "../src/mapping-tokens.js";

describe("normaliseMappingToken", () => {
  it("strips leading dashes and folds camelCase to hyphens", () => {
    expect(normaliseMappingToken("--field-map")).toBe("field-map");
    expect(normaliseMappingToken("fieldMap")).toBe("field-map");
    expect(normaliseMappingToken("FieldMap")).toBe("field-map");
  });

  it("leaves underscores alone", () => {
    // The token list carries both spellings; folding here would silently
    // change which inputs match.
    expect(normaliseMappingToken("field_map")).toBe("field_map");
  });
});

describe("isMappingToken", () => {
  it("catches every listed token in all three spellings", () => {
    for (const token of FORBIDDEN_MAPPING_FLAG_TOKENS) {
      const camel = token.replace(/[-_](.)/g, (_m, ch: string) => ch.toUpperCase());
      const snake = token.replace(/-/g, "_");
      for (const variant of new Set([token, camel, snake])) {
        expect(isMappingToken(variant), `variant "${variant}" of "${token}"`).toBe(true);
      }
    }
  });

  it("permits legitimate configuration keys", () => {
    for (const key of [
      "pixel_id",
      "graph_host",
      "request_timeout_ms",
      "access_token",
      "measurement_id",
      "config",
      "inactivity_seconds",
    ]) {
      expect(isMappingToken(key), key).toBe(false);
    }
  });
});

describe("assertNoMappingSemantics", () => {
  it("throws on the first offending key", () => {
    expect(() =>
      assertNoMappingSemantics(["pixel_id", "field_map"], "project configuration"),
    ).toThrow(MappingSemanticsError);
  });

  it("names the offending token and the surface in the message", () => {
    try {
      assertNoMappingSemantics(["event_map"], "project configuration");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(MappingSemanticsError);
      expect((err as MappingSemanticsError).token).toBe("event_map");
      expect((err as Error).message).toContain("project configuration");
      expect((err as Error).message).toContain("consumers/<vendor>/v<n>/mappers/");
    }
  });

  it("passes a clean key set", () => {
    expect(() => assertNoMappingSemantics(["pixel_id", "graph_host"], "x")).not.toThrow();
  });
});
