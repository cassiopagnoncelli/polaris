/**
 * A manifest may not promise a file nothing emits.
 *
 * `@polaris/bus` advertised `./stream-range-reader` for as long as that module
 * has been called `partition-stream-readers.ts`, and no test, type or lint
 * noticed: TypeScript never reads `exports`, and a subpath nobody has imported
 * yet cannot fail. It was found by accident, months later, by a worker doing
 * something else — which is the failure mode this repository keeps meeting and
 * the reason the check matters more than the instance.
 *
 * So the assertions below are about the check being worth trusting. Each rule
 * is shown REFUSING a real fault and LEAVING a correct package alone, because
 * a check that fails everything and a check that fails nothing both report a
 * clean tree. The two build-state cases carry the most weight: the verdict has
 * to be the same on a cold worktree and on a built one, and deciding by the
 * presence of `dist/` would get both of them wrong in opposite directions.
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  emitPlan,
  findUnemittedEntrypoints,
  packageDirs,
  patternDirectory,
  sourcesFor,
  stripJsonComments,
} from "../lint-declared-entrypoints.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("reading a tsconfig", () => {
  let root = "";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "polaris-entrypoint-cfg-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const config = (body: string): void => {
    writeFileSync(join(root, "tsconfig.json"), body, "utf8");
  };

  it("reads where the build writes and where it reads from", () => {
    config('{"compilerOptions":{"rootDir":"src","outDir":"dist"}}');
    expect(emitPlan(root)).toEqual({ outDir: "dist", sourceRoots: ["src"] });
  });

  it("spells `./src/` and `src` the same way", () => {
    config('{"compilerOptions":{"rootDir":"./src","outDir":"./dist"}}');
    expect(emitPlan(root)).toEqual({ outDir: "dist", sourceRoots: ["src"] });
  });

  it("takes the package root as a source root when the config says so", () => {
    // `definitions/*` compile from `.`, not from `src/`.
    config('{"compilerOptions":{"rootDir":".","outDir":"dist"}}');
    expect(emitPlan(root)).toEqual({ outDir: "dist", sourceRoots: ["."] });
  });

  it("guesses both roots when tsc would be inferring one", () => {
    // `rootDir` is optional and tsc derives it from the inputs. Accepting a
    // source that IS there is the direction a guess should err in.
    config('{"compilerOptions":{"outDir":"dist"}}');
    expect(emitPlan(root)).toEqual({ outDir: "dist", sourceRoots: ["src", "."] });
  });

  it("reports no outDir when there is no tsconfig to read", () => {
    expect(emitPlan(root)).toEqual({ outDir: null, sourceRoots: [] });
  });

  it("survives the comments tsconfig is allowed to carry", () => {
    config('// a note\n{"compilerOptions":{/* here */ "rootDir":"src","outDir":"dist"}}');
    expect(emitPlan(root).outDir).toBe("dist");
  });
});

describe("stripping JSONC", () => {
  it("leaves a glob that contains a comment terminator intact", () => {
    // `"src/**` + `/*.ts"` ends a block comment. A stripper that does not
    // track quoting cuts a tsconfig in half at its include glob, and the
    // check then reads every package as having no outDir.
    const source = '{"include": ["src/**/*.ts"]}';
    expect(JSON.parse(stripJsonComments(source))).toEqual({ include: ["src/**/*.ts"] });
  });

  it("keeps a comment marker that is part of a string", () => {
    const source = '{"note": "https://example.com // not a comment"}';
    expect(JSON.parse(stripJsonComments(source)).note).toContain("//");
  });
});

describe("mapping a target back to its source", () => {
  const plan = { outDir: "dist", sourceRoots: ["src"] };

  it("maps an emitted module to the module that emits it", () => {
    expect(sourcesFor("./dist/streams.js", plan)).toContain(join("src", "streams.ts"));
  });

  it("maps a declaration file to the same source", () => {
    // `types` and `import` are two promises about one module; both have to
    // land on `src/streams.ts` or one of them goes unchecked.
    expect(sourcesFor("./dist/streams.d.ts", plan)).toContain(join("src", "streams.ts"));
  });

  it("keeps a nested path nested", () => {
    expect(sourcesFor("./dist/bin/polaris.js", plan)).toContain(join("src", "bin", "polaris.ts"));
  });

  it("accepts any extension a source may carry", () => {
    // Deliberately looser than tsc's own mapping: this can only MISS a fault,
    // where an exact `.js -> .ts` rule invents one the first time a package
    // emits through a shape the mapping does not know about.
    const wanted = sourcesFor("./dist/client.js", plan);
    expect(wanted).toContain(join("src", "client.mts"));
    expect(wanted).toContain(join("src", "client.tsx"));
  });

  it("says nothing compiles a target outside the outDir", () => {
    expect(sourcesFor("./polaris.css", plan)).toBeNull();
  });

  it("says nothing compiles anything when there is no outDir", () => {
    expect(sourcesFor("./dist/index.js", { outDir: null, sourceRoots: [] })).toBeNull();
  });

  it("reads a pattern down to the directory its matches come from", () => {
    expect(patternDirectory("./dist/features/*.js")).toBe("dist/features");
    expect(patternDirectory("./dist/*.js")).toBe("dist");
  });
});

describe("scanning a tree", () => {
  let root = "";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "polaris-entrypoint-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const plant = (rel: string, contents = ""): void => {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents, "utf8");
  };

  const pkg = (
    rel: string,
    exports: unknown,
    options?: { readonly noTsconfig?: boolean },
  ): void => {
    plant(`${rel}/package.json`, `${JSON.stringify({ name: rel, exports }, null, 2)}\n`);
    if (options?.noTsconfig === true) return;
    plant(
      `${rel}/tsconfig.json`,
      `${JSON.stringify({ compilerOptions: { rootDir: "src", outDir: "dist" } })}\n`,
    );
  };

  const scan = (): ReturnType<typeof findUnemittedEntrypoints> => findUnemittedEntrypoints(root);

  it("refuses a subpath no source emits", () => {
    // The founding fault, in the shape it actually had: a module renamed and
    // a manifest that kept the old name.
    pkg("libs/bus", {
      ".": { import: "./dist/index.js" },
      "./stream-range-reader": { import: "./dist/stream-range-reader.js" },
    });
    plant("libs/bus/src/index.ts");
    plant("libs/bus/src/partition-stream-readers.ts");

    const problems = scan();
    expect(problems.map((problem) => problem.target)).toEqual(["./dist/stream-range-reader.js"]);
    expect(problems[0]?.path).toBe("libs/bus");
    expect(problems[0]?.wanted).toContain(join("src", "stream-range-reader.ts"));
  });

  it("leaves a subpath its source emits alone", () => {
    pkg("libs/bus", { "./streams": { types: "./dist/streams.d.ts", import: "./dist/streams.js" } });
    plant("libs/bus/src/streams.ts");
    expect(scan()).toEqual([]);
  });

  it("checks every field that points a consumer at a file", () => {
    // `main`, `types` and `bin` make the same promise `exports` does, and a
    // check that read only `exports` would leave a CLI whose `bin` points at
    // nothing reported clean.
    plant(
      "apps/cli/package.json",
      `${JSON.stringify({
        name: "cli",
        main: "./dist/index.js",
        types: "./dist/index.d.ts",
        bin: { polaris: "./dist/bin/polaris.js" },
      })}\n`,
    );
    plant(
      "apps/cli/tsconfig.json",
      `${JSON.stringify({ compilerOptions: { rootDir: "src", outDir: "dist" } })}\n`,
    );
    plant("apps/cli/src/index.ts");

    expect(scan().map((problem) => problem.target)).toEqual(["./dist/bin/polaris.js"]);
  });

  it("still refuses it when a stale dist/ says otherwise", () => {
    // The property that decides the whole design. `pnpm build` does not
    // clean, so the output of a module deleted last week is still on disk —
    // and a check that asked `existsSync("dist/...")` would report the
    // repository healthy on every developer's machine and red in CI.
    pkg("libs/bus", { "./gone": { import: "./dist/gone.js" } });
    plant("libs/bus/src/index.ts");
    plant("libs/bus/dist/gone.js", "// left over from a module that was deleted\n");

    expect(scan().map((problem) => problem.target)).toEqual(["./dist/gone.js"]);
  });

  it("passes on a cold worktree that has never been built", () => {
    // The mirror. A fresh `git worktree add` has no `dist/` anywhere, and a
    // check that read the build output would fail every package in the
    // repository at once — which is a check nobody can run before a build,
    // and so a check that gets skipped.
    pkg("libs/bus", { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } });
    plant("libs/bus/src/index.ts");
    expect(scan()).toEqual([]);
  });

  it("checks an uncompiled target by whether it is simply there", () => {
    pkg("libs/theme", { "./styles.css": "./styles.css" });
    plant("libs/theme/src/index.ts");
    expect(scan().map((problem) => problem.target)).toEqual(["./styles.css"]);

    plant("libs/theme/styles.css", "body {}\n");
    expect(scan()).toEqual([]);
  });

  it("says so when a package declares a dist nothing builds", () => {
    // No tsconfig, so no `tsc -p` will ever produce the file. Reporting it as
    // "nothing emits it" would send the reader looking for a source file; the
    // repair is a build.
    pkg("libs/orphan", { ".": { import: "./dist/index.js" } }, { noTsconfig: true });
    plant("libs/orphan/src/index.ts");
    expect(scan()[0]?.reason).toContain("no tsconfig");
  });

  it("checks a pattern down to the directory and no further", () => {
    // The target names a family rather than a file, so the question the check
    // can answer is whether the family's directory is there at all — which is
    // how a pattern goes stale: the directory moves.
    pkg("libs/plugins", { "./features/*": "./dist/features/*.js" });
    plant("libs/plugins/src/index.ts");
    expect(scan().map((problem) => problem.target)).toEqual(["./dist/features/*.js"]);

    plant("libs/plugins/src/features/one.ts");
    expect(scan()).toEqual([]);
  });

  it("compiles from the package root when the config says so", () => {
    plant(
      "definitions/traits/package.json",
      `${JSON.stringify({ name: "traits", exports: { ".": { import: "./dist/index.js" } } })}\n`,
    );
    plant(
      "definitions/traits/tsconfig.json",
      `${JSON.stringify({ compilerOptions: { rootDir: ".", outDir: "dist" } })}\n`,
    );
    plant("definitions/traits/index.ts");
    expect(scan()).toEqual([]);
  });

  it("ignores a bare specifier, which is a package and not a file", () => {
    pkg("libs/re-export", { "./zod": "zod" });
    plant("libs/re-export/src/index.ts");
    expect(scan()).toEqual([]);
  });

  it("does not scan installed dependencies", () => {
    pkg("libs/bus", { ".": { import: "./dist/index.js" } });
    plant("libs/bus/src/index.ts");
    plant(
      "libs/bus/node_modules/left-pad/package.json",
      `${JSON.stringify({ name: "left-pad", main: "./dist/index.js" })}\n`,
    );
    expect(scan()).toEqual([]);
  });

  it("does not follow a symlink out of the tree", () => {
    // A pm worktree plants an `agents` symlink back to the main checkout.
    // Walking it would scan another tree's packages and judge them against
    // this tree's sources, which is a report about neither.
    const elsewhere = mkdtempSync(join(tmpdir(), "polaris-entrypoint-other-"));
    try {
      mkdirSync(join(elsewhere, "thing"), { recursive: true });
      writeFileSync(
        join(elsewhere, "thing", "package.json"),
        `${JSON.stringify({ name: "thing", main: "./dist/index.js" })}\n`,
        "utf8",
      );
      symlinkSync(elsewhere, join(root, "agents"), "dir");
      expect(scan()).toEqual([]);
      expect(packageDirs(root)).toEqual([]);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("finds packages at every depth the tree uses", () => {
    pkg("libs/bus", {});
    pkg("libs/persistence/postgres", {});
    pkg("connectors/destinations/braze/v1", {});
    expect(packageDirs(root)).toEqual([
      "connectors/destinations/braze/v1",
      "libs/bus",
      "libs/persistence/postgres",
    ]);
  });
});

describe("the repository itself", () => {
  it("advertises nothing it does not emit", () => {
    // The standing claim, and the one the card was written for. `pnpm lint`
    // runs the same check; asserting it here means a rename that leaves a
    // manifest behind fails the suite too, rather than waiting for whoever
    // runs lint next.
    expect(findUnemittedEntrypoints(REPO_ROOT)).toEqual([]);
  });

  it("scans more than a handful of packages", () => {
    // A walk that found nothing would satisfy the assertion above and mean
    // nothing. The six-kind tree holds sixty-odd packages.
    expect(packageDirs(REPO_ROOT).length).toBeGreaterThan(50);
  });
});
