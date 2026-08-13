/**
 * The direct-environment-read check.
 *
 * The two properties worth pinning are the ones that decide whether this lint
 * survives contact with the repo: it must catch a real read in service code,
 * and it must NOT flag prose about `process.env` — several modules' doc
 * comments say "this package never reads process.env", and a check that
 * flags those is a check somebody disables within the week.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findDirectEnvReads, stripComments } from "../lint-process-env.mjs";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "polaris-env-lint-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function seed(relPath: string, contents: string): void {
  const full = join(root, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, contents);
}

describe("stripComments", () => {
  it("removes line comments", () => {
    expect(stripComments('const a = 1; // process.env["X"]')).not.toContain("process.env");
  });

  it("removes block comments, including multi-line", () => {
    const source = ["/**", " * Never reads process.env directly.", " */", "const a = 1;"].join(
      "\n",
    );
    expect(stripComments(source)).not.toContain("process.env");
  });

  it("keeps real code", () => {
    expect(stripComments('const a = process.env["X"]; // trailing')).toContain("process.env");
  });

  it("preserves line numbering so reported lines are accurate", () => {
    const source = ["// one", "/* two", "   three */", 'const a = process.env["X"];'].join("\n");
    expect(stripComments(source).split("\n")).toHaveLength(4);
  });
});

describe("findDirectEnvReads", () => {
  it("reports a read in service code, with its line", () => {
    seed(
      "consumers/thing/v1/src/app.ts",
      ["export function go(): string {", '  return process.env["SECRET"] ?? "";', "}"].join("\n"),
    );
    const violations = findDirectEnvReads(root);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.file).toBe("consumers/thing/v1/src/app.ts");
    expect(violations[0]?.line).toBe(2);
  });

  it("does NOT flag a doc comment that merely mentions process.env", () => {
    // This is the case that decides whether the lint is kept or deleted.
    seed(
      "packages/thing/src/index.ts",
      [
        "/**",
        " * This package never reads `process.env` directly — callers pass a",
        " * frozen snapshot.",
        " */",
        "export const value = 1;",
      ].join("\n"),
    );
    expect(findDirectEnvReads(root)).toEqual([]);
  });

  it("ignores tests, dist and node_modules", () => {
    const read = 'export const a = process.env["X"];';
    seed("packages/thing/test/helper.ts", read);
    seed("packages/thing/src/thing.test.ts", read);
    seed("packages/thing/dist/index.ts", read);
    seed("packages/thing/node_modules/dep/src/index.ts", read);
    expect(findDirectEnvReads(root)).toEqual([]);
  });

  it("ignores directories outside the service tree", () => {
    seed("scripts/tool.ts", 'export const a = process.env["X"];');
    seed("blueprints/demo/src/index.ts", 'export const a = process.env["X"];');
    expect(findDirectEnvReads(root)).toEqual([]);
  });

  it("respects the ALLOW list by exact repo-relative path", () => {
    // shared-config/src/env.ts is loadEnv itself — the one sanctioned reader.
    seed("packages/shared-config/src/env.ts", 'export const a = process.env["X"];');
    // A sibling in the same package is not covered by that entry.
    seed("packages/shared-config/src/other.ts", 'export const b = process.env["Y"];');
    const violations = findDirectEnvReads(root);
    expect(violations.map((violation) => violation.file)).toEqual([
      "packages/shared-config/src/other.ts",
    ]);
  });

  it("reports every read in a file, not just the first", () => {
    seed(
      "processors/thing/v1/src/app.ts",
      ['const a = process.env["A"];', 'const b = process.env["B"];'].join("\n"),
    );
    expect(findDirectEnvReads(root)).toHaveLength(2);
  });
});
