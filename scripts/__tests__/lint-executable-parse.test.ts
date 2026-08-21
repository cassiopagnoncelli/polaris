/**
 * The executable-parse check is the floor under files nothing else opens.
 *
 * `bin/dev` was a SyntaxError for days while lint, typecheck and the test
 * suite were all green, because none of the three reads it: biome does not
 * process an extensionless path, nothing imports it, no test runs it. The
 * first reader was a person typing `make dev`.
 *
 * These assertions are about the check being worth trusting rather than about
 * it existing. Each case is shown REFUSING a real fault and LEAVING a correct
 * file alone, because a check that fails everything and one that fails nothing
 * both report a clean tree. The sharpest of them are the two ways this gate
 * could have passed while blind: `node --check` given a path silently returns
 * success on the exact `bin/dev` fault when the nearest manifest declares no
 * `type`, and a discovery step that finds no files satisfies every assertion
 * downstream of it.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  EXECUTABLE_MODE,
  findParseProblems,
  nearestPackageType,
  nodeParseFormats,
  parseProblem,
  shebangInterpreter,
  trackedExecutables,
} from "../lint-executable-parse.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * The fault itself, spelled the way `bin/dev` spelled it.
 *
 * Assembled from fragments rather than written literally, because a literal
 * here would have to sit inside a template string forever: the moment anybody
 * moves it into a doc comment above, this test file becomes the bug it tests
 * for. Assembling makes that impossible instead of merely inadvisable.
 */
const COMMENT_ENDING_GLOB = `libs/${"*"}/${"*"}`;

/**
 * `bin/dev` as it was: the imports, then a doc comment that closes itself.
 *
 * The order is load-bearing rather than incidental. `node --check` given a
 * path stops looking once it has seen the first `import` — see "the trap,
 * pinned open" below — so a fault ABOVE the imports is caught by the naive
 * command and a fault below it is not. The real file imported at line 43 and
 * broke at line 97, which is the half nothing sees.
 */
const BROKEN_ESM = [
  "#!/usr/bin/env node",
  'import { readFileSync } from "node:fs";',
  "/**",
  ` * The library roots are ${COMMENT_ENDING_GLOB} and nothing else.`,
  " */",
  "void readFileSync;",
].join("\n");

const GOOD_ESM = [
  "#!/usr/bin/env node",
  'import { readFileSync } from "node:fs";',
  "void readFileSync;",
].join("\n");

const GOOD_CJS = [
  "#!/usr/bin/env node",
  'const { readFileSync } = require("node:fs");',
  "void readFileSync;",
].join("\n");

const BROKEN_BASH = ["#!/usr/bin/env bash", 'if [ -z "$1" ]; then', "  echo hello"].join("\n");

const GOOD_BASH = ["#!/usr/bin/env bash", "set -euo pipefail", "echo hello"].join("\n");

describe("reading a shebang", () => {
  it("names the interpreter behind env", () => {
    expect(shebangInterpreter("#!/usr/bin/env node\n")).toBe("node");
  });

  it("names an interpreter given by absolute path", () => {
    expect(shebangInterpreter("#!/bin/bash\nset -e\n")).toBe("bash");
  });

  it("steps over env's own options", () => {
    // `env -S` is how a shebang passes flags on Linux. No tracked file uses
    // it today, and reading the flag as the interpreter would report a file
    // this check "cannot ask for a verdict" when it plainly can.
    expect(shebangInterpreter("#!/usr/bin/env -S node --enable-source-maps\n")).toBe("node");
  });

  it("steps over variables env is setting", () => {
    expect(shebangInterpreter("#!/usr/bin/env NODE_OPTIONS=--no-warnings node\n")).toBe("node");
  });

  it("has nothing to say about a file with no shebang", () => {
    expect(shebangInterpreter("const a = 1;\n")).toBeNull();
    expect(shebangInterpreter("")).toBeNull();
  });
});

describe("deciding which parser a node script wants", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "polaris-executable-parse-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function manifest(body: Record<string, unknown>): void {
    writeFileSync(join(root, "package.json"), `${JSON.stringify(body, null, 2)}\n`, "utf8");
  }

  it("takes the extension over the manifest when there is one", () => {
    manifest({ name: "fixture", type: "commonjs" });
    expect(nodeParseFormats(root, "bin/tool.mjs")).toEqual(["module"]);
    expect(nodeParseFormats(root, "bin/tool.cjs")).toEqual(["commonjs"]);
  });

  it("reads the nearest manifest for a file with no extension", () => {
    manifest({ name: "fixture", type: "module" });
    expect(nearestPackageType(root, "bin/tool")).toBe("module");
    expect(nodeParseFormats(root, "bin/tool")).toEqual(["module"]);
  });

  it("tries both when nothing in the tree settles it", () => {
    // Node's own runtime behaviour, written down: parse as CommonJS, fall
    // back to module when module syntax turns up. A file either parser
    // accepts is a file node will run, so accepting either is not laxity.
    manifest({ name: "fixture" });
    expect(nearestPackageType(root, "bin/tool")).toBeNull();
    expect(nodeParseFormats(root, "bin/tool")).toEqual(["commonjs", "module"]);
  });
});

describe("judging one file", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "polaris-executable-parse-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function write(rel: string, content: string): string {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, "utf8");
    return rel;
  }

  function manifest(body: Record<string, unknown>): void {
    write("package.json", `${JSON.stringify(body, null, 2)}\n`);
  }

  it("leaves a node script that parses alone", () => {
    manifest({ name: "fixture", type: "module" });
    expect(parseProblem(root, write("bin/dev", GOOD_ESM))).toBeNull();
  });

  it("refuses the comment that ended itself", () => {
    // The fault as it actually was. The message has to carry the line, since
    // the reader's next move is to open the file at it.
    manifest({ name: "fixture", type: "module" });
    const reason = parseProblem(root, write("bin/dev", BROKEN_ESM));
    expect(reason).toContain("node could not parse it");
    expect(reason).toContain("SyntaxError");
    expect(reason).toContain("bin/dev:4");
  });

  it("names the file rather than stdin", () => {
    // The source is handed to node on stdin, so node calls it `[stdin]`. A
    // failure list of paths with `[stdin]:3` in it is a list nobody can act
    // on.
    manifest({ name: "fixture", type: "module" });
    const reason = parseProblem(root, write("bin/dev", BROKEN_ESM));
    expect(reason).not.toContain("[stdin]");
  });

  it("drops node's own stack frames", () => {
    // Six frames of node internals and a version banner say nothing about
    // the script, and they sit between the reader and the next filename.
    manifest({ name: "fixture", type: "module" });
    const reason = parseProblem(root, write("bin/dev", BROKEN_ESM));
    expect(reason).not.toContain("check_syntax");
    expect(reason).not.toMatch(/^Node\.js v/m);
  });

  it("catches it in a tree whose manifest declares no type", () => {
    // The trap this check is shaped around, and the reason it does not just
    // shell out to `node --check <path>`: see the test below.
    manifest({ name: "fixture" });
    expect(parseProblem(root, write("bin/dev", BROKEN_ESM))).toContain("SyntaxError");
  });

  it("leaves a CommonJS script in that same tree alone", () => {
    // The other half of the two-parser fallback. Trying module first, or
    // only, would reject `require` in a tree that has every right to it —
    // and a check that fails correct files gets turned off.
    manifest({ name: "fixture" });
    expect(parseProblem(root, write("bin/tool", GOOD_CJS))).toBeNull();
  });

  it("refuses a shell script that does not parse", () => {
    expect(parseProblem(root, write("bin/backup.sh", BROKEN_BASH))).toContain("could not parse");
  });

  it("leaves a shell script that parses alone", () => {
    expect(parseProblem(root, write("bin/backup.sh", GOOD_BASH))).toBeNull();
  });

  it("refuses an executable with no shebang, and says both ways out", () => {
    // Either the file is a script and needs an interpreter, or the bit is
    // wrong. The message carries the command for the second, because that is
    // the case the reader will not have thought about.
    const reason = parseProblem(root, write("bin/data", "plain text\n"));
    expect(reason).toContain("no `#!` line");
    expect(reason).toContain("--chmod=-x");
  });

  it("refuses an interpreter it cannot check rather than skipping it", () => {
    // An enumeration that ignores what it does not recognise turns itself
    // off for everything written after it. A python executable is not this
    // check's to verify yet, and saying so out loud is the difference
    // between a hole and a silence.
    const reason = parseProblem(root, write("bin/report", "#!/usr/bin/env python3\nprint(1)\n"));
    expect(reason).toContain("python3");
    expect(reason).toContain("rather than skipped");
  });

  it("reports a file it cannot open", () => {
    expect(parseProblem(root, "bin/absent")).toContain("could not be read");
  });

  it("reports every bad file, not just the first", () => {
    manifest({ name: "fixture", type: "module" });
    write("bin/dev", BROKEN_ESM);
    write("bin/setup", GOOD_ESM);
    write("bin/backup.sh", BROKEN_BASH);
    expect(
      findParseProblems(root, ["bin/backup.sh", "bin/dev", "bin/setup"]).map((p) => p.where),
    ).toEqual(["bin/backup.sh", "bin/dev"]);
  });
});

describe("the trap, pinned open", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "polaris-executable-parse-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("shows `node --check <path>` passing on the fault this check catches", () => {
    // Not a test of our code. It is the load-bearing reason our code does
    // something more elaborate than the one-liner a reader would reach for,
    // and it belongs where somebody about to simplify it will run it.
    //
    // `node --check` picks a parser from the path: extension first, then the
    // nearest package.json `type`. Extensionless, with no `type` declared, it
    // detects the format from the source instead: compiles as CommonJS,
    // reaches the first `import`, concludes "module", and returns — without
    // ever parsing it as one. Every syntax error below that first import is
    // invisible, which is precisely where `bin/dev` broke.
    //
    // If this ever fails, node has fixed it. Delete this test and the
    // two-parser fallback with it, and simplify the header comment that
    // explains why the fallback is there.
    writeFileSync(join(root, "package.json"), '{ "name": "fixture" }\n', "utf8");
    mkdirSync(join(root, "bin"), { recursive: true });
    const file = join(root, "bin", "dev");
    writeFileSync(file, BROKEN_ESM, "utf8");

    let exitCode = 0;
    try {
      execFileSync(process.execPath, ["--check", file], { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      exitCode = 1;
    }

    expect(exitCode).toBe(0);
    expect(parseProblem(root, "bin/dev")).toContain("SyntaxError");
  });
});

describe("the repository itself", () => {
  it("has no tracked executable that fails to parse", () => {
    // The standing claim. `pnpm lint` runs the same check; asserting it here
    // means a broken shebang fails the suite too, rather than waiting for
    // whoever runs lint next.
    expect(findParseProblems(REPO_ROOT)).toEqual([]);
  });

  it("still finds the files it was written for", () => {
    // The other half of trusting it. Every assertion above would pass over an
    // empty file set, and the check would report a clean tree having opened
    // nothing — which is exactly what the three gates that missed `bin/dev`
    // did. These three are the ones the card names: the two `bin/` scripts
    // and the root CLI entrypoint, all extensionless, all invisible to biome.
    const files = trackedExecutables(REPO_ROOT);
    expect(files).toContain("bin/dev");
    expect(files).toContain("bin/setup");
    expect(files).toContain("polaris");
  });

  it("finds the shell scripts too, not only the extensionless ones", () => {
    // The class is wider than the instance: a `.sh` carries an extension and
    // is still read by nothing — biome has no shell parser, and these are
    // invoked by operators and cron, never imported.
    const files = trackedExecutables(REPO_ROOT);
    expect(files.some((file) => file.endsWith(".sh"))).toBe(true);
  });

  it("reads the mode out of the index, not off the disk", () => {
    // A local `chmod +x` that was never staged is not this check's business,
    // and a file staged executable is, whatever the working tree says. The
    // index is what a fresh checkout and CI get.
    expect(EXECUTABLE_MODE).toBe("100755");
    const listing = execFileSync("git", ["ls-files", "-s", "--", "bin/dev"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    expect(listing.startsWith(`${EXECUTABLE_MODE} `)).toBe(true);
  });
});
