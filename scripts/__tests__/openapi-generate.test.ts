/**
 * CI drift test for the OpenAPI generator.
 *
 * The committed YAML at `docs/api/openapi.yaml` is the published doc the
 * platform team reviews. This test re-runs the generator in-process and
 * compares the result byte-for-byte. A mismatch means the Zod sources or
 * the path declarations changed but the published doc was not
 * regenerated — the fix is to run `pnpm openapi` and commit the result.
 *
 * The test is intentionally part of `pnpm test:scripts` so a CI run that
 * already executes the workspace test suite picks it up without a new
 * job. See `package.json` and `.github/workflows/ci.yml`.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// Vitest's TS config in `scripts/tsconfig.json` enables allowJs+checkJs
// off, so importing the .mjs script through a relative path is fine.
// We re-use the script's `serialize` helper rather than re-implementing
// serialization in this test — the goal is to detect drift in the *same*
// pipeline producers actually run.
import { loadDocument, serialize } from "../openapi-generate.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..", "..");

const YAML_PATH = resolve(REPO_ROOT, "docs", "api", "openapi.yaml");
const JSON_PATH = resolve(REPO_ROOT, "docs", "api", "openapi.json");

describe("openapi-generate", () => {
  it("regenerates byte-identical output to the committed openapi.yaml", async () => {
    const doc = await loadDocument();
    const { yaml } = serialize(doc);
    const committed = readFileSync(YAML_PATH, "utf8");
    if (committed !== yaml) {
      const message = [
        "docs/api/openapi.yaml is out of date.",
        "Re-run `pnpm openapi` and commit the result.",
        "",
        diffPreview(committed, yaml),
      ].join("\n");
      throw new Error(message);
    }
    expect(committed).toBe(yaml);
  });

  it("regenerates byte-identical output to the committed openapi.json", async () => {
    const doc = await loadDocument();
    const { json } = serialize(doc);
    const committed = readFileSync(JSON_PATH, "utf8");
    if (committed !== json) {
      const message = [
        "docs/api/openapi.json is out of date.",
        "Re-run `pnpm openapi` and commit the result.",
        "",
        diffPreview(committed, json),
      ].join("\n");
      throw new Error(message);
    }
    expect(committed).toBe(json);
  });

  it("emits a document the script's serialize() handles deterministically", async () => {
    // The CI drift check assumes the serializer is deterministic for a
    // given document. Run it twice and compare; this guards against
    // accidentally introducing date / random ordering inside the
    // generator code path.
    const doc = await loadDocument();
    const a = serialize(doc);
    const b = serialize(doc);
    expect(a.yaml).toBe(b.yaml);
    expect(a.json).toBe(b.json);
  });
});

/**
 * Show a small diff window around the first mismatched line. Avoids
 * importing a diff library — the script test surface is intentionally
 * dependency-light.
 */
function diffPreview(expected: string, actual: string): string {
  const expectedLines = expected.split("\n");
  const actualLines = actual.split("\n");
  const max = Math.max(expectedLines.length, actualLines.length);
  for (let i = 0; i < max; i += 1) {
    if (expectedLines[i] !== actualLines[i]) {
      const window = (lines: string[], header: string): string => {
        const start = Math.max(0, i - 2);
        const end = Math.min(lines.length, i + 3);
        const chunk = lines
          .slice(start, end)
          .map((line, idx) => `  ${start + idx + 1}: ${line}`)
          .join("\n");
        return `${header}\n${chunk}`;
      };
      return [
        window(expectedLines, "expected (committed):"),
        window(actualLines, "actual (regenerated):"),
      ].join("\n");
    }
  }
  return "(no textual diff; lengths differ?)";
}
