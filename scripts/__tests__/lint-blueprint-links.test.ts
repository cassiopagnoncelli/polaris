/**
 * The blueprint link check is what makes the tier visible to a restructure.
 *
 * `blueprints/` sits outside the workspace globs, outside
 * `tsconfig.tests.json`, and — until this check — outside every `SCAN_DIRS`
 * list in `scripts/`. ADR-0007 moved the two SDKs to `sdks/` and
 * every gate stayed green while the storefront pointed at a directory that no
 * longer existed; the breakage was found by running the app.
 *
 * So these assertions are about the check being worth trusting. Each rule is
 * shown REFUSING a real mismatch and LEAVING a correct link alone, because a
 * check that fails everything and a check that fails nothing both report a
 * clean tree. The last block guards the other half of that: it asserts the
 * repository still declares links at all, so converting the blueprint to
 * `workspace:*` cannot quietly turn this gate into a no-op.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { allLinks, blueprintPaths, findBrokenLinks, linksIn } from "../lint-blueprint-links.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("the law, stated as a function", () => {
  it("picks out a link: specifier", () => {
    const links = linksIn({ dependencies: { "@polaris/node-sdk": "link:../../sdks/node" } });
    expect(links).toEqual([
      {
        name: "@polaris/node-sdk",
        field: "dependencies",
        specifier: "link:../../sdks/node",
        target: "../../sdks/node",
      },
    ]);
  });

  it("picks out a file: specifier too", () => {
    // Not the form the tier uses, and listed anyway: it breaks identically on
    // a move, so a gate blind to it is a gate somebody can walk around.
    expect(linksIn({ dependencies: { a: "file:../a" } }).map((l) => l.target)).toEqual(["../a"]);
  });

  it("ignores anything resolved from a registry or the workspace", () => {
    const links = linksIn({
      dependencies: { next: "16.3.0", react: "^19.0.0", "@polaris/spec": "workspace:*" },
    });
    expect(links).toEqual([]);
  });

  it("reads every field a dependency can be declared in", () => {
    const links = linksIn({
      dependencies: { a: "link:../a" },
      devDependencies: { b: "link:../b" },
      optionalDependencies: { c: "link:../c" },
      peerDependencies: { d: "link:../d" },
    });
    expect(links.map((l) => l.name)).toEqual(["a", "b", "c", "d"]);
  });

  it("survives a manifest with no dependencies at all", () => {
    expect(linksIn({ name: "x" })).toEqual([]);
    expect(linksIn({ dependencies: null })).toEqual([]);
  });
});

describe("scanning a tree", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "polaris-blueprint-links-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function write(rel: string, body: string): void {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body, "utf8");
  }

  function manifest(rel: string, contents: object): void {
    write(`${rel}/package.json`, `${JSON.stringify(contents, null, 2)}\n`);
  }

  /** The storefront as it actually is, against the SDK as it actually sits. */
  function storefront(specifier = "link:../../sdks/node"): void {
    manifest("blueprints/01-storefront", {
      name: "polaris-blueprint-storefront",
      dependencies: { "@polaris/node-sdk": specifier },
    });
    manifest("sdks/node", { name: "@polaris/node-sdk" });
  }

  function scan(): ReturnType<typeof findBrokenLinks> {
    return findBrokenLinks(root);
  }

  it("refuses a target the move deleted", () => {
    // The exact fault I1AD5 was filed for: ADR-0007 emptied `packages/`, and
    // the specifier still named it.
    storefront("link:../../packages/node-sdk");
    const [problem] = scan();
    expect(problem?.blueprint).toBe("blueprints/01-storefront");
    expect(problem?.name).toBe("@polaris/node-sdk");
    expect(problem?.reason).toContain("does not exist");
  });

  it("reports the resolved path, not just the specifier", () => {
    // The two differ by the blueprint's own depth, and a reader chasing the
    // failure has to know which `../..` landed where.
    storefront("link:../../packages/node-sdk");
    expect(scan()[0]?.reason).toContain("packages/node-sdk");
  });

  it("refuses a target that exists but is a different package", () => {
    // The subtle one, and the reason this is more than a stat(): the link
    // resolves, the app builds, and it imports the wrong code.
    manifest("blueprints/01-storefront", {
      name: "polaris-blueprint-storefront",
      dependencies: { "@polaris/node-sdk": "link:../../sdks/node" },
    });
    manifest("sdks/node", { name: "@polaris/node-runtime" });
    const [problem] = scan();
    expect(problem?.reason).toContain("@polaris/node-runtime");
    expect(problem?.reason).toContain("@polaris/node-sdk");
  });

  it("refuses a target that holds no package.json", () => {
    manifest("blueprints/01-storefront", {
      name: "polaris-blueprint-storefront",
      dependencies: { "@polaris/node-sdk": "link:../../sdks/node" },
    });
    mkdirSync(join(root, "sdks/node"), { recursive: true });
    expect(scan()[0]?.reason).toContain("not a package");
  });

  it("refuses a target that is a file rather than a directory", () => {
    manifest("blueprints/01-storefront", {
      name: "polaris-blueprint-storefront",
      dependencies: { "@polaris/node-sdk": "file:../../sdks/node.tgz" },
    });
    write("sdks/node.tgz", "not really a tarball");
    expect(scan()[0]?.reason).toContain("not a directory");
  });

  it("leaves a link that resolves to the package it names alone", () => {
    storefront();
    expect(scan()).toEqual([]);
  });

  it("reports a manifest it cannot parse", () => {
    write("blueprints/01-storefront/package.json", "{ not json");
    const [problem] = scan();
    expect(problem?.blueprint).toBe("blueprints/01-storefront");
    expect(problem?.reason).toContain("could not be read");
  });

  it("walks past a directory that is not a blueprint", () => {
    // `blueprints/README.md` is a file and some future `blueprints/shared/`
    // may hold no manifest. Neither is a blueprint, so neither is reported.
    storefront();
    write("blueprints/README.md", "# Polaris Blueprints\n");
    mkdirSync(join(root, "blueprints/notes"), { recursive: true });
    expect(blueprintPaths(root)).toEqual(["blueprints/01-storefront"]);
    expect(scan()).toEqual([]);
  });

  it("does not scan installed dependencies", () => {
    storefront();
    manifest("blueprints/node_modules/left-pad", { name: "left-pad" });
    expect(blueprintPaths(root)).toEqual(["blueprints/01-storefront"]);
  });

  it("says nothing about a tree with no blueprints", () => {
    expect(blueprintPaths(root)).toEqual([]);
    expect(scan()).toEqual([]);
  });
});

describe("the repository itself", () => {
  it("has no blueprint link that fails to resolve", () => {
    // The standing claim. `pnpm lint` runs the same check; asserting it here
    // means a move that strands a blueprint fails the suite too, rather than
    // waiting for whoever runs lint next.
    expect(findBrokenLinks(REPO_ROOT)).toEqual([]);
  });

  it("still has links for the check to verify", () => {
    // The other half of trusting it. If the blueprint were ever converted to
    // `workspace:*`, every assertion above would still pass over an empty
    // set, and the gate would report a clean tree because it found nothing.
    const { links } = allLinks(REPO_ROOT);
    expect(links.length).toBeGreaterThan(0);
    expect(links.map((link) => link.name).sort()).toContain("@polaris/node-sdk");
  });
});
