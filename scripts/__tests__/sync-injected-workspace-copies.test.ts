/**
 * A fresh worktree could not build, and the obvious remedy said it had fixed
 * it.
 *
 * ADR-0008's injection makes part of the workspace graph a hard-linked COPY
 * under `node_modules/.pnpm/<pkg>@file+<path>/` rather than a symlink to the
 * source. `pnpm install` takes that copy before anything is built, so it has
 * no `dist/`; the build then builds the SOURCE and never touches the copy;
 * and `tsc`, following the copy's own `"types": "./dist/index.d.ts"`, reports
 * `TS2307: Cannot find module '@polaris/<x>'` from a package the change never
 * touched. `pnpm install --force` replies "Already up to date", truthfully,
 * because the lockfile is current and freshness was never the problem.
 *
 * What is tested here is the discrimination, because that is the part that
 * was got wrong twice while writing it. Every absent file looks identical
 * from inside the copy; only the SOURCE says which kind it is:
 *
 *   - the source has it        -> stale, and re-injection is the repair;
 *   - the source has no `dist` -> unbuilt, and building must come FIRST or
 *                                 re-injection snapshots the same emptiness;
 *   - the source has a `dist`
 *     but not this file        -> the package declares an export nothing
 *                                 emits, which no re-injection can fix.
 *
 * Collapsing the last two is what made an earlier draft report "all in sync"
 * on a cold tree and do no work at all — the same false green as the
 * `--force` that started this.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  VIRTUAL_STORE,
  WORKSPACE_STATE_FILE,
  classifyEntrypoints,
  declaredEntrypoints,
  findInjectedCopies,
  findProblems,
  parseVirtualStoreDirName,
} from "../sync-injected-workspace-copies.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("decoding a virtual-store directory name", () => {
  it("reads the package name and its source path", () => {
    expect(parseVirtualStoreDirName("@polaris+bus@file+libs+bus")).toEqual({
      name: "@polaris/bus",
      sourcePath: "libs/bus",
    });
  });

  it("reads a nested source path", () => {
    expect(
      parseVirtualStoreDirName("@polaris+delivery-destinations@file+libs+delivery+destinations"),
    ).toEqual({
      name: "@polaris/delivery-destinations",
      sourcePath: "libs/delivery/destinations",
    });
  });

  it("drops a parenthesised peer suffix", () => {
    expect(parseVirtualStoreDirName("@polaris+bus@file+libs+bus(@types+node@22.19.19)")).toEqual({
      name: "@polaris/bus",
      sourcePath: "libs/bus",
    });
  });

  it("ignores a registry dependency", () => {
    // Most of the store is these. A registry entry has no `@file+` marker,
    // and reading one as an injected copy would send the script looking for a
    // source directory named after a version.
    expect(parseVirtualStoreDirName("typescript@6.0.3")).toBeNull();
    expect(parseVirtualStoreDirName("@types+node@22.19.19")).toBeNull();
  });
});

describe("the entrypoints a package.json declares", () => {
  it("collects main, types and every exports leaf", () => {
    expect(
      declaredEntrypoints({
        main: "./dist/index.js",
        types: "./dist/index.d.ts",
        exports: {
          ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
          "./runtime": { types: "./dist/runtime.d.ts", import: "./dist/runtime.js" },
        },
      }),
    ).toEqual(["./dist/index.js", "./dist/index.d.ts", "./dist/runtime.d.ts", "./dist/runtime.js"]);
  });

  it("collects bin targets, which are files a dependent runs", () => {
    expect(declaredEntrypoints({ bin: { polaris: "./dist/cli.js" } })).toEqual(["./dist/cli.js"]);
  });

  it("drops a bare specifier", () => {
    // An `exports` value that is not relative names another package rather
    // than a file in this tree, so its absence here means nothing.
    expect(declaredEntrypoints({ exports: { ".": "@polaris/somewhere-else" } })).toEqual([]);
  });

  it("says nothing about a manifest that declares nothing", () => {
    expect(declaredEntrypoints({})).toEqual([]);
    expect(declaredEntrypoints(null)).toEqual([]);
  });
});

describe("telling the three kinds of missing file apart", () => {
  let dir = "";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "polaris-injected-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const manifest = {
    types: "./dist/index.d.ts",
    exports: { "./extra": "./dist/extra.js" },
  };

  const write = (path: string) => {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, "");
  };

  it("calls it stale when the source has the file and the copy does not", () => {
    write("source/dist/index.d.ts");
    write("source/dist/extra.js");
    write("copy/package.json");

    expect(classifyEntrypoints(join(dir, "copy"), join(dir, "source"), manifest)).toEqual({
      stale: ["./dist/index.d.ts", "./dist/extra.js"],
      unbuilt: [],
      neverProduced: [],
    });
  });

  it("calls it unbuilt when the source has no dist at all", () => {
    // The cold-worktree state. Re-injecting here would snapshot the same
    // emptiness, so the repair has to build before it re-injects and the
    // check has to call this a failure rather than parity.
    write("source/package.json");
    write("copy/package.json");

    expect(classifyEntrypoints(join(dir, "copy"), join(dir, "source"), manifest)).toEqual({
      stale: [],
      unbuilt: ["./dist/index.d.ts", "./dist/extra.js"],
      neverProduced: [],
    });
  });

  it("calls it never-produced when the source built everything except this", () => {
    // `@polaris/bus` really did declare `./stream-range-reader`, and no
    // source file emitted it — this is the case that found it. 3OLBM dropped
    // the declaration and put the general check behind
    // `pnpm lint:declared-entrypoints`, so the bucket now describes a fault
    // that fails a gate rather than one nobody was watching. It stays: this
    // script cannot assume the gate ran, and re-injection cannot fix a file
    // nothing emits, so reporting it as an injection failure would make the
    // script unable to report success on a tree it had just correctly
    // repaired.
    write("source/dist/index.d.ts");
    write("copy/dist/index.d.ts");

    expect(classifyEntrypoints(join(dir, "copy"), join(dir, "source"), manifest)).toEqual({
      stale: [],
      unbuilt: [],
      neverProduced: ["./dist/extra.js"],
    });
  });

  it("reports nothing when the copy has everything", () => {
    write("source/dist/index.d.ts");
    write("source/dist/extra.js");
    write("copy/dist/index.d.ts");
    write("copy/dist/extra.js");

    expect(classifyEntrypoints(join(dir, "copy"), join(dir, "source"), manifest)).toEqual({
      stale: [],
      unbuilt: [],
      neverProduced: [],
    });
  });
});

describe("reading a tree", () => {
  let dir = "";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "polaris-injected-tree-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const plant = (relPath: string, contents: string) => {
    const full = join(dir, relPath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  };

  it("finds nothing when there is no virtual store", () => {
    // Nothing installed, or injection off. Neither is this script's business
    // to complain about, and throwing here would make the hook that runs it
    // fail on a worktree that has not installed yet.
    expect(findInjectedCopies(dir)).toEqual([]);
  });

  it("pairs each copy with the source the store names", () => {
    const manifest = JSON.stringify({ name: "@polaris/bus", types: "./dist/index.d.ts" });
    plant(
      join(VIRTUAL_STORE, "@polaris+bus@file+libs+bus/node_modules/@polaris/bus/package.json"),
      manifest,
    );
    plant("libs/bus/package.json", manifest);
    plant(join(VIRTUAL_STORE, "typescript@6.0.3/node_modules/typescript/package.json"), "{}");

    const copies = findInjectedCopies(dir);
    expect(copies).toHaveLength(1);
    expect(copies[0]?.name).toBe("@polaris/bus");
    expect(copies[0]?.sourcePath).toBe("libs/bus");
    expect(copies[0]?.sourceName).toBe("@polaris/bus");
  });

  it("reports a copy whose decoded source is not that package as unresolved", () => {
    // The directory-name encoding is the one assumption this script makes
    // about pnpm's internals. If it stops holding, every conclusion drawn
    // from it is worthless, so it is reported rather than skipped quietly.
    plant(
      join(VIRTUAL_STORE, "@polaris+bus@file+libs+bus/node_modules/@polaris/bus/package.json"),
      JSON.stringify({ name: "@polaris/bus", types: "./dist/index.d.ts" }),
    );
    plant("libs/bus/package.json", JSON.stringify({ name: "@polaris/something-else" }));

    const problems = findProblems(dir);
    expect(problems.unresolved).toHaveLength(1);
    expect(problems.stale).toEqual([]);
  });
});

describe("this repository", () => {
  it("names the file whose removal is what forces re-injection", () => {
    // The one command in the docs is only as good as this path. pnpm reads it
    // to decide the workspace is unchanged, which is why `pnpm install` and
    // `pnpm install --force` both decline to repair the tree.
    expect(WORKSPACE_STATE_FILE).toBe("node_modules/.pnpm-workspace-state-v1.json");
  });

  it("has no stale or unbuilt injected copy", () => {
    // Honest about its own reach: `pnpm test` runs `pnpm build` first, so a
    // tree that reaches this assertion has already built, and a stale copy
    // would have failed the build rather than this test. It earns its place
    // for the run that is not the gate — `pnpm test:scripts` on its own, or a
    // worktree being diagnosed — where it names the cause instead of leaving
    // a TS2307 pointing at an innocent package.
    const { unresolved, stale, unbuilt } = findProblems(ROOT);
    expect({
      unresolved: unresolved.map((copy) => copy.name),
      stale: stale.map((copy) => copy.name),
      unbuilt: unbuilt.map((copy) => copy.name),
    }).toEqual({ unresolved: [], stale: [], unbuilt: [] });
  });
});
