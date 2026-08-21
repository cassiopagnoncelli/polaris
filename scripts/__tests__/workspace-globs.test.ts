/**
 * The six-kind tree must be reachable before anything moves into it.
 *
 * ADR-0007 restructured roughly two dozen packages into `libs/`, `sdks/`,
 * `connectors/` and `definitions/`. The moves were split across six cards in
 * one group, and every one of them was a `git mv`. If a move had also had to
 * edit `pnpm-workspace.yaml`, all six would have edited the same three lines
 * of the same file and collided on the group branch — the conflict would be
 * in build configuration rather than in code, which is the worst place to
 * resolve one under time pressure.
 *
 * So the destinations were declared once, ahead of the moves, and this test is
 * the standing claim that they still are. It asserts three things:
 *
 *   1. Every package.json on disk is claimed by a glob. This is what held the
 *      dual-glob transition open, and what made closing it safe: dropping the
 *      old root before the last package had left would have failed here
 *      rather than at the next `pnpm install`, where the symptom is an
 *      unresolvable `workspace:*` dependency several layers from the cause.
 *   2. Every destination path the T0 move cards name is claimed. The list
 *      below is the migration plan, restated as an assertion — the point is
 *      not that the glob file contains certain strings, it is that these
 *      specific paths resolve. IJ4NN kept it after the transition closed,
 *      because it is now the only place in the repository that records where
 *      each of the twenty-four packages went.
 *   3. The root tsconfig excludes each new root, matching how it already
 *      treats `apps`, `sync` and `async`.
 *
 * `catalog` was absent from that exclude list and was left that way: the root
 * config's `include` is a single file, so the list is documentary rather than
 * load-bearing, and 0DIPB has since retired the directory outright.
 * `definitions` is listed because that is where its contents went.
 *
 * What this does NOT check is whether the rest of the tooling follows. It did
 * not, twice, and both are closed now: `lint-dead-exports.mjs` scanned a
 * hard-coded root until IJ4NN settled it on `libs` and `sdks`, and the root
 * `vitest.config.ts` enumerated test roots and stopped at `catalog` until
 * LP5OT — `vitest-collection.test.ts` is the standing check that it stays
 * closed.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const SKIP_DIRS = new Set(["node_modules", "dist", "build", "coverage", ".git"]);

/**
 * Blueprints are standalone reference apps, deliberately outside the
 * workspace: `blueprints/01-storefront` depends on the published SDK the way
 * a customer would, not on `workspace:*`. Making it a member would let it
 * resolve internals no real consumer can see, which is the one thing a
 * blueprint exists to prove it does not need.
 */
const NON_MEMBER_DIRS = new Set(["blueprints"]);

interface WorkspaceFile {
  readonly packages?: readonly string[];
}

const workspaceFile = parseYaml(
  readFileSync(join(ROOT, "pnpm-workspace.yaml"), "utf8"),
) as WorkspaceFile;
const workspaceGlobs: readonly string[] = workspaceFile.packages ?? [];

/**
 * pnpm's `*` matches one path segment. Every pattern in this workspace uses
 * only that form, which makes a segment-wise comparison exact rather than an
 * approximation — and the `**` guard below is what keeps it exact if someone
 * later reaches for a recursive pattern.
 */
function matchesGlob(pattern: string, path: string): boolean {
  const patternSegments = pattern.split("/");
  const pathSegments = path.split("/");
  if (patternSegments.length !== pathSegments.length) return false;
  return patternSegments.every((seg, i) => seg === "*" || seg === pathSegments[i]);
}

function claimedByAGlob(path: string): boolean {
  return workspaceGlobs.some((pattern) => matchesGlob(pattern, path));
}

/** Directories holding a package.json, relative to the repo root, POSIX-style. */
function packageDirs(): readonly string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    if (entries.includes("package.json") && dir !== ROOT) {
      found.push(relative(ROOT, dir).split(sep).join("/"));
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry) || NON_MEMBER_DIRS.has(entry) || entry.startsWith(".")) continue;
      const full = join(dir, entry);
      try {
        if (statSync(full).isDirectory()) walk(full);
      } catch {
        /* raced with another session's write */
      }
    }
  };
  walk(ROOT);
  return found.sort();
}

/**
 * The T0 destinations, card by card. Restated here rather than referenced
 * because the board lives outside this repository: when a move lands, this
 * list is the only place a reader can see what the workspace file was opened
 * FOR, and a destination missing from it is a move nobody scaffolded.
 */
const PLANNED_DESTINATIONS: ReadonlyArray<{ card: string; paths: readonly string[] }> = [
  {
    card: "HBXPO — platform libraries",
    paths: [
      "libs/bus",
      "libs/pipeline",
      "libs/persistence/postgres",
      "libs/persistence/clickhouse",
      "libs/persistence/control-plane",
      "libs/observability/logger",
      "libs/observability/metrics",
      "libs/runtime/service-bootstrap",
      "libs/runtime/config",
      "libs/runtime/environments",
      "libs/runtime/secrets",
    ],
  },
  {
    card: "BCYQ6 — domain libraries",
    paths: [
      "libs/spec",
      "libs/governance",
      "libs/auth",
      "libs/tenancy/project-config",
      "libs/tenancy/config-schemas",
      "libs/tenancy/control-plane",
      "libs/delivery/host",
      "libs/delivery/destinations",
      "libs/delivery/normalize",
      "libs/archive/writer",
      "libs/archive/replay",
    ],
  },
  { card: "ZXBDY — SDK promotion", paths: ["sdks/web", "sdks/node"] },
  {
    card: "0DIPB — catalog to definitions",
    paths: [
      "definitions/traits",
      "definitions/policy",
      "definitions/audiences",
      "definitions/journeys",
      "definitions/reverse-etl",
    ],
  },
  {
    // Wave T1 (P9J7X). The destinations landed; `sources/` and `warehouses/`
    // stay listed as the `○` homes they are, because this list is the ledger
    // of what the glob was opened FOR and not of what is on disk today.
    card: "P9J7X — connector registry",
    paths: [
      "connectors/destinations/braze/v1",
      "connectors/sources/segment/v1",
      "connectors/warehouses/clickhouse/v1",
    ],
  },
];

/** Roots ADR-0007 adds, which the root tsconfig must skip like the others. */
const NEW_ROOTS = ["libs", "sdks", "connectors", "definitions"] as const;

describe("pnpm workspace globs", () => {
  it("uses only single-segment wildcards", () => {
    // The matcher above is exact for `*` and wrong for `**`. Rather than
    // implement a glob engine for patterns this repo does not use, assert the
    // patterns stay in the subset the matcher covers.
    expect(workspaceGlobs.filter((pattern) => pattern.includes("**"))).toEqual([]);
  });

  it("finds the workspace", () => {
    // Guards the guard: an empty glob list or an empty package list would
    // pass every assertion below by vacuum. The floor was 10 while the old
    // flat root was still globbed; IJ4NN closed the transition and there are
    // 9. A floor is not a count — it moves only when a glob legitimately goes.
    expect(workspaceGlobs.length).toBeGreaterThanOrEqual(9);
    expect(packageDirs().length).toBeGreaterThanOrEqual(40);
  });

  it("claims every package on disk", () => {
    const orphans = packageDirs().filter((dir) => !claimedByAGlob(dir));
    expect(orphans).toEqual([]);
  });

  it("claims every T0 destination", () => {
    const unreachable: string[] = [];
    for (const { card, paths } of PLANNED_DESTINATIONS) {
      for (const path of paths) {
        if (!claimedByAGlob(path)) unreachable.push(`${path}  (${card})`);
      }
    }
    expect(unreachable).toEqual([]);
  });

  it("does not claim paths outside the workspace", () => {
    // The complement of the check above: a matcher that returns true for
    // everything would satisfy both assertions and mean nothing.
    expect(claimedByAGlob("blueprints/01-storefront")).toBe(false);
    expect(claimedByAGlob("libs")).toBe(false);
    expect(claimedByAGlob("libs/persistence/postgres/src")).toBe(false);
  });
});

describe("root tsconfig", () => {
  const tsconfig = JSON.parse(readFileSync(join(ROOT, "tsconfig.json"), "utf8")) as {
    exclude?: readonly string[];
  };

  it("excludes each six-kind root", () => {
    const exclude = tsconfig.exclude ?? [];
    expect(NEW_ROOTS.filter((root) => !exclude.includes(root))).toEqual([]);
  });
});
