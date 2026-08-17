/**
 * Loader tests: the production channel for the denylist and the narrowed
 * semantic parameters. The properties that matter:
 *
 *   - a declared `identity:` block reaches the policy map;
 *   - a project without one is absent (manifest defaults downstream);
 *   - a missing catalog directory degrades to defaults with a warning,
 *     because local runs boot from directories that carry no catalog;
 *   - a typo'd block fails the boot instead of silently not installing a
 *     safeguard.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { loadProjectIdentityOverrides } from "../src/overrides.js";
import { silentLogger } from "./fakes.js";

const HERE = dirname(fileURLToPath(import.meta.url));

describe("identity override loader", () => {
  it("loads the identity block of every project that declares one", () => {
    const overrides = loadProjectIdentityOverrides({
      root: join(HERE, "fixtures", "catalog-root"),
      logger: silentLogger,
    });

    expect(overrides.size).toBe(1);
    const storefront = overrides.get("storefront");
    expect(storefront?.max_merges_per_window).toBe(20);
    expect(storefront?.denylist?.customer_id).toEqual(["guest"]);
    expect(storefront?.denylist?.anonymous_id).toEqual(["kiosk-shared"]);
    // `bare` declared nothing, so it must not appear: absence is what
    // routes it to manifest defaults.
    expect(overrides.has("bare")).toBe(false);
  });

  it("returns an empty map when the catalog directory does not exist", () => {
    const overrides = loadProjectIdentityOverrides({
      root: join(HERE, "fixtures", "no-such-root"),
      logger: silentLogger,
    });
    expect(overrides.size).toBe(0);
  });

  it("refuses a typo'd identity block instead of silently skipping the safeguard", () => {
    expect(() =>
      loadProjectIdentityOverrides({
        root: join(HERE, "fixtures", "catalog-root-bad"),
        logger: silentLogger,
      }),
    ).toThrow(/invalid identity block/);
  });
});
