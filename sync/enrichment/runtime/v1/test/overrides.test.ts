/**
 * Loader tests: the production channel for the snapshot guard.
 *
 * Same properties the identity stage's loader holds — a declared block
 * reaches the policy map, an absent one leaves the project on manifest
 * defaults, a missing `definitions/` degrades with a warning, and a typo'd key
 * fails the boot rather than silently applying no limit.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { loadProjectEnrichmentOverrides } from "../src/overrides.js";
import { silentLogger } from "./fakes.js";

const HERE = dirname(fileURLToPath(import.meta.url));

describe("enrichment override loader", () => {
  it("loads the enrichment block of every project that declares one", () => {
    const overrides = loadProjectEnrichmentOverrides({
      root: join(HERE, "fixtures", "catalog-root"),
      logger: silentLogger,
    });

    expect(overrides.size).toBe(1);
    expect(overrides.get("storefront")?.max_traits_bytes).toBe(8192);
    // `bare` declared nothing: absence is what routes it to defaults.
    expect(overrides.has("bare")).toBe(false);
  });

  it("returns an empty map when the definitions directory does not exist", () => {
    const overrides = loadProjectEnrichmentOverrides({
      root: join(HERE, "fixtures", "no-such-root"),
      logger: silentLogger,
    });
    expect(overrides.size).toBe(0);
  });

  it("refuses a typo'd enrichment block instead of silently skipping the limit", () => {
    expect(() =>
      loadProjectEnrichmentOverrides({
        root: join(HERE, "fixtures", "catalog-root-bad"),
        logger: silentLogger,
      }),
    ).toThrow(/invalid enrichment block/);
  });
});
