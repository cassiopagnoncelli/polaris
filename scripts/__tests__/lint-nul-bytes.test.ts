import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findNulBytes, lintWorkspace } from "../lint-nul-bytes.mjs";

/**
 * The NUL is always built with `String.fromCharCode(0)` rather than written
 * as an escape: this file has to *contain* the byte in the fixtures it seeds
 * without containing it in its own source, or the check would flag its own
 * test — which is exactly the failure mode being guarded against.
 */
const NUL = String.fromCharCode(0);

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "polaris-nul-lint-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function seedFile(relPath: string, contents: string): void {
  const full = join(root, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, contents);
}

describe("findNulBytes", () => {
  it("returns nothing for clean text", () => {
    expect(findNulBytes(Buffer.from("const a = 1;\nconst b = 2;\n"))).toEqual([]);
  });

  it("reports the 1-based line of a NUL", () => {
    const hits = findNulBytes(Buffer.from(`line one\nline${NUL}two\nline three\n`));
    expect(hits).toHaveLength(1);
    expect(hits[0]?.line).toBe(2);
  });

  it("reports every occurrence, not just the first", () => {
    expect(findNulBytes(Buffer.from(`a${NUL}b${NUL}c`))).toHaveLength(2);
  });

  it("counts the byte offset, not the character index", () => {
    // 'é' is two bytes in UTF-8, so a character-indexed scan would report 2.
    const hits = findNulBytes(Buffer.from(`é${NUL}`));
    expect(hits[0]?.offset).toBe(2);
  });

  it("does not mistake an escape written as text for the byte", () => {
    const escaped = `const k = \`\${a}${String.fromCharCode(92)}u0000\${b}\`;`;
    expect(findNulBytes(Buffer.from(escaped))).toEqual([]);
  });
});

describe("lintWorkspace", () => {
  it("passes a clean tree", () => {
    seedFile("packages/shared-processor/src/gate.ts", "export const k = 1;\n");
    seedFile("docs/architecture/07-clickhouse.md", "# ClickHouse\n");
    expect(lintWorkspace(root)).toEqual([]);
  });

  it("flags the real-world shape: a NUL separator in a template literal", () => {
    seedFile(
      "apps/control-plane-api/src/admin/pages/processors.ts",
      `function key(row) {\n  return \`\${row.name}${NUL}\${row.version}\`;\n}\n`,
    );
    const violations = lintWorkspace(root);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.file).toContain("processors.ts");
    expect(violations[0]?.line).toBe(2);
  });

  it("scans docs and SQL, not just code", () => {
    seedFile("sql/clickhouse/01_x.sql", `SELECT 1;${NUL}\n`);
    seedFile("docs/architecture/02-control-plane.md", `prose${NUL}\n`);
    expect(
      lintWorkspace(root)
        .map((v) => v.file)
        .sort(),
    ).toEqual(["docs/architecture/02-control-plane.md", "sql/clickhouse/01_x.sql"]);
  });

  it("ignores build output, so a compiled artefact cannot fail the build", () => {
    seedFile("packages/shared-processor/dist/gate.js", `const k = "a${NUL}b";\n`);
    seedFile("packages/shared-processor/node_modules/dep/index.js", `const k = "${NUL}";\n`);
    expect(lintWorkspace(root)).toEqual([]);
  });

  it("ignores extensions that are legitimately binary", () => {
    seedFile("apps/control-plane-api/src/logo.png", `PNG${NUL}${NUL}data`);
    expect(lintWorkspace(root)).toEqual([]);
  });

  it("reports each NUL in a file with more than one", () => {
    seedFile("packages/p/src/a.ts", `const a = "${NUL}";\nconst b = "${NUL}";\n`);
    const violations = lintWorkspace(root);
    expect(violations).toHaveLength(2);
    expect(violations.map((v) => v.line)).toEqual([1, 2]);
  });
});
