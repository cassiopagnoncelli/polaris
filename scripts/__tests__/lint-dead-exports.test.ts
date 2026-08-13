import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findDeadExports } from "../lint-dead-exports.mjs";

/**
 * The check exists because this repository keeps shipping mechanisms that are
 * built, wired, validated, documented — and called by nothing. Seven so far
 * this session. None was a type error; none failed a test.
 *
 * These tests pin the two properties that decide whether it is useful or
 * noise: a symbol with a real production caller must NOT be reported, and a
 * symbol referenced only by its own tests MUST be.
 */
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "polaris-dead-export-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function seed(relPath: string, contents: string): void {
  const full = join(root, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, contents);
}

function names(): string[] {
  return findDeadExports(root).map((entry) => entry.name);
}

describe("findDeadExports", () => {
  it("reports an exported function nothing calls", () => {
    seed(
      "packages/shared-thing/src/helper.ts",
      "export function neverCalled(): number {\n  return 1;\n}\n",
    );
    expect(names()).toEqual(["neverCalled"]);
  });

  it("does not report a symbol a production file in another package uses", () => {
    seed(
      "packages/shared-thing/src/helper.ts",
      "export function isCalled(): number {\n  return 1;\n}\n",
    );
    seed(
      "apps/some-api/src/app.ts",
      'import { isCalled } from "@polaris/shared-thing";\nisCalled();\n',
    );
    expect(names()).toEqual([]);
  });

  it("counts a plain .mjs script as a caller", () => {
    // `scripts/rabbitmq-provision.mjs` is the only caller of
    // `declareSuperStream`, `deleteSuperStream`, `deleteComponentQueues` and
    // `DEFAULT_STREAM_MAX_BYTES` — it provisions every stream on the
    // platform. Scanning references as TypeScript-only reported all four as
    // dead, so the baseline carried eight symbols whose caller the check
    // simply could not see.
    seed(
      "packages/shared-thing/src/topology.ts",
      "export function declareSuperStream(): number {\n  return 1;\n}\n",
    );
    seed(
      "scripts/provision.mjs",
      'import { declareSuperStream } from "@polaris/shared-thing";\ndeclareSuperStream();\n',
    );
    expect(names()).toEqual([]);
  });

  it("still reports a symbol only its own tests use", () => {
    // The exact shape of every mechanism this check was written for: a unit
    // test proves the helper works, and no production code ever calls it.
    seed(
      "packages/shared-thing/src/helper.ts",
      "export function onlyTested(): number {\n  return 1;\n}\n",
    );
    seed(
      "packages/shared-thing/test/helper.test.ts",
      "import { onlyTested } from '../src/helper.js';\nonlyTested();\n",
    );
    expect(names()).toEqual(["onlyTested"]);
  });

  it("does not count a use inside the declaring package as a caller", () => {
    // A package calling itself proves nothing about whether the platform
    // needs the symbol — that is how a whole subsystem stays internally
    // consistent and externally dead.
    seed(
      "packages/shared-thing/src/helper.ts",
      "export function internalOnly(): number {\n  return 1;\n}\n",
    );
    seed(
      "packages/shared-thing/src/other.ts",
      'import { internalOnly } from "./helper.js";\ninternalOnly();\n',
    );
    expect(names()).toEqual(["internalOnly"]);
  });

  it("ignores barrel re-exports, which are plumbing rather than declarations", () => {
    seed("packages/shared-thing/src/index.ts", 'export { thing } from "./helper.js";\n');
    seed("packages/shared-thing/src/helper.ts", "export const thing = 1;\n");
    seed(
      "apps/some-api/src/app.ts",
      'import { thing } from "@polaris/shared-thing";\nconsole.log(thing);\n',
    );
    expect(names()).toEqual([]);
  });

  it("reports types nowhere — only values", () => {
    // A type with no external reference may simply describe an internal
    // shape. An exported FUNCTION nothing calls is missing wiring or dead
    // code, which is the thing worth failing a build over.
    seed(
      "packages/shared-thing/src/types.ts",
      "export interface UnusedShape {\n  readonly a: string;\n}\nexport type Alias = string;\n",
    );
    expect(names()).toEqual([]);
  });

  it("skips allow-listed packages such as the published SDKs", () => {
    seed(
      "packages/node-sdk/src/public.ts",
      "export function publicApi(): number {\n  return 1;\n}\n",
    );
    expect(names()).toEqual([]);
  });
});
