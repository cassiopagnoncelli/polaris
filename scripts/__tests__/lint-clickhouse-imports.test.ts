import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findClickhouseImport, lintWorkspace } from "../lint-clickhouse-imports.mjs";

/**
 * The import-restriction script is exercised against a temporary tree
 * shaped like the Polaris workspace. We seed both allowed and
 * disallowed callers, then assert on the violation set.
 *
 * `findClickhouseImport` is unit-tested separately so we cover comment-
 * and string-literal handling without needing real files for every
 * shape.
 */

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "polaris-clickhouse-lint-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function seedFile(relPath: string, contents: string): void {
  const full = join(root, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, contents);
}

describe("findClickhouseImport", () => {
  it("flags a static named import", () => {
    const result = findClickhouseImport(
      `import { createClient } from "@clickhouse/client";\n\nconsole.log("ok");\n`,
    );
    expect(result.found).toBe(true);
    expect(result.line).toBe(1);
  });

  it("flags a side-effect import", () => {
    const result = findClickhouseImport(`import "@clickhouse/client";\n`);
    expect(result.found).toBe(true);
    expect(result.line).toBe(1);
  });

  it("flags a dynamic import()", () => {
    const result = findClickhouseImport(
      `async function load() {\n  const ch = await import("@clickhouse/client");\n  return ch;\n}\n`,
    );
    expect(result.found).toBe(true);
    expect(result.line).toBe(2);
  });

  it("flags require()", () => {
    const result = findClickhouseImport(`const ch = require("@clickhouse/client");\n`);
    expect(result.found).toBe(true);
    expect(result.line).toBe(1);
  });

  it("flags single-quoted specifiers", () => {
    const result = findClickhouseImport(`import { createClient } from '@clickhouse/client';\n`);
    expect(result.found).toBe(true);
  });

  it("flags re-export forms", () => {
    const result = findClickhouseImport(`export { createClient } from "@clickhouse/client";\n`);
    expect(result.found).toBe(true);
  });

  it("ignores occurrences inside line comments", () => {
    const result = findClickhouseImport(
      `// Services do not import @clickhouse/client directly.\nexport const x = 1;\n`,
    );
    expect(result.found).toBe(false);
  });

  it("ignores occurrences inside block comments", () => {
    const result = findClickhouseImport(
      `/**\n * Wraps @clickhouse/client so callers do not need to.\n */\nexport const x = 1;\n`,
    );
    expect(result.found).toBe(false);
  });

  it("ignores occurrences inside string literals", () => {
    const result = findClickhouseImport(`const note = "we wrap @clickhouse/client elsewhere";\n`);
    expect(result.found).toBe(false);
  });

  it("ignores occurrences inside template literals", () => {
    const result = findClickhouseImport(
      "const note = `the @clickhouse/client package is wrapped`;\n",
    );
    expect(result.found).toBe(false);
  });

  it("returns not-found on unrelated code", () => {
    const result = findClickhouseImport(`import { z } from "zod";\nexport const x = 1;\n`);
    expect(result.found).toBe(false);
  });
});

describe("lintWorkspace", () => {
  it("returns no violations when only shared-clickhouse imports the client", () => {
    seedFile(
      "packages/shared-clickhouse/src/client.ts",
      `import { createClient } from "@clickhouse/client";\nexport const make = createClient;\n`,
    );
    seedFile(
      "packages/shared-config/src/schemas/clickhouse.ts",
      `// Comment naming @clickhouse/client.\nexport const x = 1;\n`,
    );
    seedFile(
      "apps/ingester-api/src/clickhouse.ts",
      `import { something } from "@polaris/shared-clickhouse";\nexport const y = something;\n`,
    );

    const violations = lintWorkspace(root);
    expect(violations).toEqual([]);
  });

  it("flags a disallowed import from apps/", () => {
    seedFile(
      "packages/shared-clickhouse/src/client.ts",
      `import { createClient } from "@clickhouse/client";\n`,
    );
    seedFile(
      "apps/ingester-api/src/bad.ts",
      `import { createClient } from "@clickhouse/client";\nexport const c = createClient;\n`,
    );

    const violations = lintWorkspace(root);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.file).toContain("ingester-api");
    expect(violations[0]?.line).toBe(1);
  });

  it("flags a disallowed import from a processor", () => {
    seedFile(
      "processors/sessionizer/v1/src/bad.ts",
      `const ch = require("@clickhouse/client");\nexport const c = ch;\n`,
    );

    const violations = lintWorkspace(root);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.file).toContain("sessionizer");
  });

  it("flags a disallowed import from another packages/* package", () => {
    seedFile(
      "packages/shared-policy/src/sneaky.ts",
      `import "@clickhouse/client";\nexport const x = 1;\n`,
    );

    const violations = lintWorkspace(root);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.file).toContain("shared-policy");
  });

  it("does not flag comments that name the specifier inside an unauthorized package", () => {
    seedFile(
      "apps/control-plane-api/src/notes.ts",
      `/**\n * We go through @polaris/shared-clickhouse, never @clickhouse/client.\n */\nexport const ok = true;\n`,
    );

    const violations = lintWorkspace(root);
    expect(violations).toEqual([]);
  });

  it("ignores fixture trees inside an unauthorized package", () => {
    // Fixtures named `__fixtures__` are skipped on purpose so test
    // suites can author negative examples without breaking CI.
    seedFile("apps/control-plane-api/__fixtures__/example.ts", `import "@clickhouse/client";\n`);

    const violations = lintWorkspace(root);
    expect(violations).toEqual([]);
  });

  it("skips node_modules even under an unauthorized package", () => {
    seedFile("apps/ingester-api/node_modules/some-pkg/index.js", `import "@clickhouse/client";\n`);

    const violations = lintWorkspace(root);
    expect(violations).toEqual([]);
  });
});
