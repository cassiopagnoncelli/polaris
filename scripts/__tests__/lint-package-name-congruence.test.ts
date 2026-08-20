/**
 * The congruence check is what makes ADR-0007's first law permanent.
 *
 * IJ4NN renamed twenty-two packages out of a `shared-` prefix that ADR-0007
 * describes as meaning "not yet categorised". That prefix accreted one
 * package at a time, and a rename alone would let it accrete again: the
 * twenty-third package lands next month named whatever its author reached
 * for, and nothing objects until somebody reads the tree years later.
 *
 * So these assertions are about the check being worth trusting. Each rule is
 * shown REFUSING a real mismatch and LEAVING a correct package alone, because
 * a check that fails everything and a check that fails nothing both report a
 * clean tree. The allowlist cases matter most: an exception that cannot go
 * stale is an exemption, and an exemption is how a law stops being one.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ALLOW,
  expectedName,
  findIncongruentNames,
  staleAllowlist,
} from "../lint-package-name-congruence.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("the law, stated as a function", () => {
  it("derives a single-level library name from its path", () => {
    expect(expectedName("libs/spec")).toBe("@polaris/spec");
    expect(expectedName("libs/bus")).toBe("@polaris/bus");
  });

  it("joins a domain and a name with a hyphen", () => {
    expect(expectedName("libs/persistence/postgres")).toBe("@polaris/persistence-postgres");
    expect(expectedName("libs/observability/logger")).toBe("@polaris/observability-logger");
  });

  it("drops the root, which is a kind and not part of the name", () => {
    // `sdks/web` is `@polaris/web`, not `@polaris/sdks-web`. The root says
    // what KIND of object this is; the name says which one.
    expect(expectedName("sdks/web")).toBe("@polaris/web");
  });
});

describe("the allowlist", () => {
  it("gives every exception a reason", () => {
    // An entry is a claim that an incongruent name is worth more than the
    // law. Without the reason it is just an exemption.
    for (const [path, entry] of ALLOW) {
      expect(entry.reason, `${path} has no reason`).toBeTruthy();
      expect(entry.reason.length).toBeGreaterThan(20);
    }
  });

  it("pins each exception to one specific divergence", () => {
    // `expected` and `name` both recorded, and different from each other:
    // that is what makes the entry a carve-out for ONE name rather than a
    // blank cheque for whatever the package ends up called.
    for (const [path, entry] of ALLOW) {
      expect(entry.expected, `${path}`).toBe(expectedName(path));
      expect(entry.name, `${path}`).not.toBe(entry.expected);
    }
  });

  it("stays short enough that somebody reads it", () => {
    expect(ALLOW.size).toBeLessThanOrEqual(5);
  });
});

describe("scanning a tree", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "polaris-congruence-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function pkg(rel: string, name: string): void {
    const full = join(root, rel, "package.json");
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, `${JSON.stringify({ name, version: "0.1.0" }, null, 2)}\n`, "utf8");
  }

  function scan(): ReturnType<typeof findIncongruentNames> {
    return findIncongruentNames(root);
  }

  it("refuses the prefix ADR-0007 retired", () => {
    // The deliberately mismatched fixture. This is the exact shape of the
    // twenty-two names IJ4NN renamed, and the reason the check exists.
    pkg("libs/persistence/postgres", "@polaris/shared-db");
    const [problem] = scan();
    expect(problem?.path).toBe("libs/persistence/postgres");
    expect(problem?.name).toBe("@polaris/shared-db");
    expect(problem?.expected).toBe("@polaris/persistence-postgres");
  });

  it("refuses a name that is plausible but not the path", () => {
    // The subtler failure, and the one a sweep misses: `destination-host` is
    // a reasonable name for what the package does. It is not what its path
    // says, which is the whole of the law.
    pkg("libs/delivery/host", "@polaris/destination-host");
    expect(scan().map((p) => p.path)).toEqual(["libs/delivery/host"]);
  });

  it("refuses a package that carries its root into its name", () => {
    pkg("libs/spec", "@polaris/libs-spec");
    expect(scan()).toHaveLength(1);
  });

  it("names both halves and the two legal repairs", () => {
    // A failure here has two correct fixes — move the directory or rename
    // the package — and the check cannot know which. It must not pretend to.
    pkg("libs/governance", "@polaris/shared-policy");
    const [problem] = scan();
    expect(problem?.reason).toContain("@polaris/governance");
    expect(problem?.reason).toContain("move the directory");
    expect(problem?.reason).toContain("rename the package");
  });

  it("leaves congruent packages alone at either depth", () => {
    pkg("libs/spec", "@polaris/spec");
    pkg("libs/persistence/postgres", "@polaris/persistence-postgres");
    pkg("libs/runtime/service-bootstrap", "@polaris/runtime-service-bootstrap");
    expect(scan()).toEqual([]);
  });

  it("walks past a grouping directory instead of reporting it", () => {
    // `libs/persistence` holds three packages and is not one. A check that
    // demanded a `@polaris/persistence` would be demanding a package that
    // should not exist.
    pkg("libs/persistence/postgres", "@polaris/persistence-postgres");
    pkg("libs/persistence/clickhouse", "@polaris/persistence-clickhouse");
    expect(scan()).toEqual([]);
  });

  it("reports a package.json with no name", () => {
    mkdirSync(join(root, "libs/spec"), { recursive: true });
    writeFileSync(join(root, "libs/spec/package.json"), '{"version":"0.1.0"}\n', "utf8");
    expect(scan()[0]?.reason).toContain("no `name`");
  });

  it("does not scan installed dependencies", () => {
    pkg("libs/spec", "@polaris/spec");
    pkg("libs/spec/node_modules/left-pad", "left-pad");
    expect(scan()).toEqual([]);
  });

  it("honours an allowlisted exception", () => {
    pkg("sdks/web", "@polaris/web-sdk");
    expect(scan()).toEqual([]);
  });

  it("still refuses an allowlisted package that drifts to a third name", () => {
    // The difference between an exception and an exemption. `sdks/web` is
    // allowed to be `@polaris/web-sdk` — not allowed to be anything.
    pkg("sdks/web", "@polaris/browser-sdk");
    const [problem] = scan();
    expect(problem?.path).toBe("sdks/web");
    expect(problem?.expected).toBe("@polaris/web-sdk");
  });

  it("reports an allowlist entry whose package became congruent", () => {
    // An exception outlives its reason silently. Somebody renames `sdks/web`
    // to `@polaris/web` and the entry becomes a carve-out from a law nobody
    // is breaking — which is how the list grows past being read.
    pkg("sdks/web", "@polaris/web");
    pkg("sdks/node", "@polaris/node-sdk");
    expect(staleAllowlist(root).map((e) => e.path)).toEqual(["sdks/web"]);
  });

  it("reports an allowlist entry whose package is gone", () => {
    pkg("sdks/node", "@polaris/node-sdk");
    expect(staleAllowlist(root).map((e) => e.path)).toEqual(["sdks/web"]);
  });
});

describe("the repository itself", () => {
  it("has no incongruent package under libs/ or sdks/", () => {
    // The standing claim. `pnpm lint` runs the same check; asserting it here
    // means a rename that breaks the law fails the suite too, rather than
    // waiting for whoever runs lint next.
    expect(findIncongruentNames(REPO_ROOT)).toEqual([]);
  });

  it("carries no stale allowlist entry", () => {
    expect(staleAllowlist(REPO_ROOT)).toEqual([]);
  });
});
