/**
 * The blueprint package-manager check keeps a copy honest.
 *
 * The root `packageManager` is the one place this repository writes its pnpm
 * version, and every other reader of it — Dockerfiles, CI workflows — is
 * forbidden a second copy for exactly that reason. A blueprint is the one
 * place that cannot read it: `pnpm install --ignore-workspace` never looks
 * upward, which is the property that makes the tier prove anything about the
 * SDKs. So the copy is required, and this check is what holds it equal.
 *
 * These assertions are about the check being worth trusting. Each case is
 * shown REFUSING a real drift and LEAVING a correct pin alone, because a
 * check that fails everything and one that fails nothing both report a clean
 * tree. Two of them are about the ways this gate could pass while blind: a
 * root with no pin to compare against, and a tier with no blueprint in it.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { blueprintPaths } from "../lint-blueprint-links.mjs";
import {
  driftReason,
  findPinDrift,
  parsePin,
  PIN_FIELD,
  rootPin,
} from "../lint-blueprint-pnpm.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("the law, stated as a function", () => {
  it("says nothing when the pin is the root's", () => {
    expect(driftReason("pnpm@11.21.0", "pnpm@11.21.0")).toBeNull();
  });

  it("names the value to add when there is no pin at all", () => {
    // The state `01-storefront` was actually in. The message carries the
    // whole fix, because the reader is being told about a field they have
    // never had a reason to think about.
    const reason = driftReason(undefined, "pnpm@11.21.0");
    expect(reason).toContain(PIN_FIELD);
    expect(reason).toContain("pnpm@11.21.0");
    expect(reason).toContain("--ignore-workspace");
  });

  it("names both versions when they differ", () => {
    const reason = driftReason("pnpm@10.30.0", "pnpm@11.21.0");
    expect(reason).toContain("pnpm@10.30.0");
    expect(reason).toContain("pnpm@11.21.0");
  });

  it("calls a different package manager what it is", () => {
    // A different fix from a stale version, so a different sentence. "These
    // two strings are not equal" would make the reader work it out.
    expect(driftReason("yarn@4.9.1", "pnpm@11.21.0")).toContain("different package manager");
  });

  it("refuses an integrity suffix on one side only", () => {
    // corepack reads the whole string, so these are two different pins
    // however alike the numbers look.
    expect(driftReason("pnpm@11.21.0", "pnpm@11.21.0+sha512.abc")).not.toBeNull();
  });

  it("refuses a pin that is not a string", () => {
    expect(driftReason(11.21, "pnpm@11.21.0")).toContain("number");
  });
});

describe("splitting a pin", () => {
  it("separates the manager from the version", () => {
    expect(parsePin("pnpm@11.21.0")).toEqual({ manager: "pnpm", version: "11.21.0" });
  });

  it("keeps an integrity suffix with the version", () => {
    expect(parsePin("pnpm@11.21.0+sha512.abc")?.version).toBe("11.21.0+sha512.abc");
  });

  it("has nothing to say about a value that is not one", () => {
    expect(parsePin("")).toBeNull();
    expect(parsePin(undefined)).toBeNull();
  });
});

describe("scanning a tree", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "polaris-blueprint-pnpm-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function write(rel: string, content: string): void {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, "utf8");
  }

  function manifest(dir: string, body: Record<string, unknown>): void {
    write(join(dir, "package.json"), `${JSON.stringify(body, null, 2)}\n`);
  }

  /**
   * "Write no pin at all", which `undefined` cannot say.
   *
   * Passing `undefined` to a parameter with a default TAKES the default, so
   * `repoRoot(undefined)` wrote a correctly pinned root and the two tests
   * below asserted their case against a fixture that was not in it. Both
   * passed as soon as the sentinel replaced it.
   */
  const NO_PIN = Symbol("no pin");
  type Pin = string | typeof NO_PIN;

  /** A root that pins pnpm, which is the precondition for any other case. */
  function repoRoot(pin: Pin = "pnpm@11.21.0"): void {
    manifest(".", pin === NO_PIN ? { name: "polaris" } : { name: "polaris", [PIN_FIELD]: pin });
  }

  function storefront(pin: Pin = "pnpm@11.21.0"): void {
    manifest(
      "blueprints/01-storefront",
      pin === NO_PIN
        ? { name: "polaris-blueprint-storefront" }
        : { name: "polaris-blueprint-storefront", [PIN_FIELD]: pin },
    );
  }

  function scan(): ReturnType<typeof findPinDrift> {
    return findPinDrift(root);
  }

  it("leaves a blueprint pinned to the root's pnpm alone", () => {
    repoRoot();
    storefront();
    expect(scan()).toEqual([]);
  });

  it("reports a blueprint with no pin", () => {
    repoRoot();
    storefront(NO_PIN);
    expect(scan()[0]?.where).toBe("blueprints/01-storefront");
    expect(scan()[0]?.reason).toContain(PIN_FIELD);
  });

  it("reports a blueprint a major version behind", () => {
    // The drift as it actually was: the tier installed under 10.30.0 while
    // the root said 11.21.0, and neither side complained.
    repoRoot("pnpm@11.21.0");
    storefront("pnpm@10.30.0");
    expect(scan()[0]?.reason).toContain("pnpm@10.30.0");
  });

  it("reports every blueprint that has drifted, not just the first", () => {
    repoRoot();
    storefront("pnpm@10.30.0");
    manifest("blueprints/02-warehouse", { name: "polaris-blueprint-warehouse" });
    expect(scan().map((p) => p.where)).toEqual([
      "blueprints/01-storefront",
      "blueprints/02-warehouse",
    ]);
  });

  it("fails rather than passing vacuously when the ROOT has no pin", () => {
    // The failure mode this gate could most easily have: with nothing to
    // compare against, every blueprint below is trivially in agreement with
    // it, and the check reports a clean tree because it asked nothing.
    repoRoot(NO_PIN);
    storefront("pnpm@10.30.0");
    const [problem] = scan();
    expect(problem?.where).toBe("package.json");
    expect(problem?.reason).toContain("declares no");
    expect(rootPin(root).pin).toBeNull();
  });

  it("reports a manifest it cannot parse", () => {
    // `lint-blueprint-links` reports this too, and both saying so is right:
    // each gate is run on its own, and a gate that went quiet on the one file
    // it could not open would be reporting a pin it never read.
    repoRoot();
    write("blueprints/01-storefront/package.json", "{ not json");
    const [problem] = scan();
    expect(problem?.where).toBe("blueprints/01-storefront");
    expect(problem?.reason).toContain("could not be read");
  });

  it("says nothing about a tree with no blueprints", () => {
    repoRoot();
    expect(scan()).toEqual([]);
  });
});

describe("the repository itself", () => {
  it("has no blueprint that floats off the root's pnpm", () => {
    // The standing claim. `pnpm lint` runs the same check; asserting it here
    // means a bumped root pin fails the suite too, rather than waiting for
    // whoever runs lint next.
    expect(findPinDrift(REPO_ROOT)).toEqual([]);
  });

  it("still has a blueprint for the check to look at", () => {
    // The other half of trusting it. Every assertion above would pass over an
    // empty tier, and the gate would report a clean tree having opened
    // nothing.
    expect(blueprintPaths(REPO_ROOT).length).toBeGreaterThan(0);
    expect(rootPin(REPO_ROOT).pin).toMatch(/^pnpm@/);
  });
});
